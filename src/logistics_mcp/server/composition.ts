import { z } from "zod";

import { AuthenticationError, type AuthClaims } from "../platform/context";
import {
  createFixturePlatformDependencies,
  createProductionPlatformAssembly,
  type DurableAuditRepository,
  type DurableIdempotencyRepository,
  type DurableSessionBindingStore,
  type PlatformReadiness,
} from "../platform/dependencies";
import type {
  AuditRepository,
  IdempotencyRepository,
} from "../platform/repositories";
import type {
  SessionRuntimeHandle,
  SessionRuntimeRegistry,
  SessionRuntimeRegistryOptions,
} from "../platform/session-runtime";
import {
  createUnavailableMcpHttpHandler,
  createMcpHttpHandler,
  type McpHttpHandler,
  type McpHttpOptions,
} from "./http";
import {
  registerPhaseOneTools,
  registerModuleToolDefinitions,
  wrapModuleToolDefinitions,
  type ToolContractMap,
  type ToolDefinition,
  type ToolHandlerMap,
  type RuntimeActivationFacades,
} from "./tool-registry";
import {
  isPairedRuntimeActivationFacades,
  type ActivationReadFacade,
  type ControlledDispatchFacade,
} from "../control-plane/service";
import {
  CapabilityRegistry,
  ModuleHost,
} from "../module-runtime";
import {
  cargoModule,
  containerModule,
  createAgentAccessModule,
  createFreightcomLtlModule,
  FREIGHTCOM_RATE_CAPABILITY,
  FREIGHTCOM_RATE_CAPABILITY_VERSION,
} from "../modules";
import { createAgentAccessRuntime, type AgentAccessRuntime } from "../agent-context/runtime";
import type {
  CustomsAdapter,
  FixtureAdapters,
  FreightcomRatePort,
} from "../adapters/ports";
import {
  createFixtureAdapters,
  type FixtureAdapterOptions,
} from "../adapters/fixture-client";
import {
  createPhase1Bundle,
  type Phase1Bundle,
} from "../adapters/phase1-bundle";
import {
  ExistingQuoteAdapter,
} from "../adapters/quote/existing-quote-adapter";
import { RiskCustomsAdapter } from "../adapters/customs/riskcustoms-adapter";
import { CuratedKnowledgeAdapter } from "../adapters/knowledge/curated-adapter";
import { SystemStatusAdapter } from "../adapters/status/system-status-adapter";
import { ManualTaskAdapter } from "../adapters/review/manual-task-adapter";
import {
  cargoToolContract,
  cargoToolHandler,
} from "../domains/cargo/tool";
import {
  containerPlanSummaryHandler,
  containerPlanSummaryToolContract,
} from "../domains/container/service";
import {
  quoteV2InputSchema,
  quoteV2ResultSchema,
} from "../adapters/quote/quote-api-adapter";
import { envelopeSchema } from "../platform/envelope";
import {
  createFreightcomDisabledRateAdapter,
} from "../adapters/quote/freightcom-rate-adapter";

/*
 * The import grouping above deliberately keeps all platform ownership at this
 * composition boundary. Production adapters and verifiers are ports here;
 * this module does not create network clients or durable providers.
 */

export interface ManagedProductionDependency {
  health(): Promise<{ readonly ready: boolean }>;
  close(): Promise<void>;
}

export interface ProductionTokenVerifier extends ManagedProductionDependency {
  readonly kind: "token_verifier";
  verify(token: string): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface ProductionAdapterSource extends ManagedProductionDependency {
  readonly kind: "adapter_source";
  readonly adapters: FixtureAdapters;
}

export interface ProductionApiAdapterSourceOptions {
  readonly customs?: CustomsAdapter;
}

export type CompositionMode = "fixtures" | "production";

export interface GatewayCompositionOptions {
  readonly dataMode: CompositionMode;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly authenticate?: McpHttpOptions["authenticate"];
  readonly tokenPolicy?: McpHttpOptions["tokenPolicy"];
  readonly auditRepository?: AuditRepository;
  readonly idempotencyRepository?: IdempotencyRepository;
  readonly sessionRegistry?: SessionRuntimeRegistry<SessionRuntimeHandle>;
  readonly sessionRegistryOptions?: SessionRuntimeRegistryOptions;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly agentAccessRuntime?: AgentAccessRuntime;
  readonly activation?: ActivationReadFacade;
  readonly dispatch?: ControlledDispatchFacade;
}

export interface FixtureCompositionOptions extends GatewayCompositionOptions {
  readonly dataMode: "fixtures";
  readonly customsFixture?: FixtureAdapterOptions["customsFixture"];
  readonly freightcomRateAdapter?: FreightcomRatePort;
}

export interface ProductionCompositionOptions
  extends Omit<GatewayCompositionOptions, "auditRepository" | "idempotencyRepository"> {
  readonly dataMode: "production";
  readonly auditRepository?: DurableAuditRepository;
  readonly idempotencyRepository?: DurableIdempotencyRepository;
  readonly tokenVerifier?: ProductionTokenVerifier;
  readonly adapterSource?: ProductionAdapterSource;
  readonly sessionBindingStore?: DurableSessionBindingStore;
  readonly sessionOwnerId?: string;
}

export interface GatewayComposition {
  readonly mode: CompositionMode;
  readonly dataMode: CompositionMode;
  readonly adapters: FixtureAdapters;
  readonly bundle: Phase1Bundle;
  readonly handlers: ToolHandlerMap;
  readonly contracts: ToolContractMap;
  readonly definitions: readonly ToolDefinition[];
  readonly moduleHost: ModuleHost;
  readonly agentAccessRuntime: AgentAccessRuntime;
  readonly handler: McpHttpHandler;
  readonly readiness: () => Promise<PlatformReadiness>;
  readonly close: () => Promise<void>;
}

function failClosedAuthenticator(): AuthClaims {
  throw new AuthenticationError(
    "No production token verifier has been configured for this composition.",
  );
}

function productionAdapters(
  options: ProductionApiAdapterSourceOptions = {},
): FixtureAdapters {
  return {
    quote: new ExistingQuoteAdapter(),
    customs: options.customs ?? new RiskCustomsAdapter(),
    knowledge: new CuratedKnowledgeAdapter(),
    status: new SystemStatusAdapter(),
    review: new ManualTaskAdapter(),
  };
}

// Health is lifecycle-only; upstream API failures stay scoped to their tools.
export function createProductionApiAdapterSource(
  options: ProductionApiAdapterSourceOptions = {},
): ProductionAdapterSource {
  return {
    kind: "adapter_source",
    adapters: productionAdapters(options),
    health: () => Promise.resolve({ ready: true }),
    close: () => Promise.resolve(),
  };
}

interface CompositionTools {
  readonly bundle: Phase1Bundle;
  readonly handlers: ToolHandlerMap;
  readonly contracts: ToolContractMap;
  readonly definitions: readonly ToolDefinition[];
  readonly moduleHost: ModuleHost;
  readonly agentAccessRuntime: AgentAccessRuntime;
}

function compositionTools(
  adapters: FixtureAdapters,
  freightcomRateAdapter: FreightcomRatePort,
  configuredAgentAccessRuntime?: AgentAccessRuntime,
  runtimeActivation?: RuntimeActivationFacades,
): CompositionTools {
  const bundle = createPhase1Bundle(adapters);
  const calculatedQuoteDataSchema = quoteV2ResultSchema.options[0];
  const manualQuoteDataSchema = quoteV2ResultSchema.options[1];
  const quoteV2EnvelopeBranches = z.union([
    envelopeSchema.extend({
      status: z.literal("success"),
      data: calculatedQuoteDataSchema,
      source_refs: envelopeSchema.shape.source_refs.min(1),
      calculation_trace: envelopeSchema.shape.calculation_trace.min(1),
    }),
    envelopeSchema.extend({
      status: z.literal("manual_review"),
      data: z.null(),
      source_refs: envelopeSchema.shape.source_refs.max(0),
      calculation_trace: envelopeSchema.shape.calculation_trace.max(0),
    }),
    envelopeSchema.extend({
      status: z.literal("manual_review"),
      data: manualQuoteDataSchema,
      source_refs: envelopeSchema.shape.source_refs.min(1),
    }),
    envelopeSchema.extend({
      status: z.enum(["needs_input", "blocked", "unavailable"]),
      data: z.null(),
      source_refs: envelopeSchema.shape.source_refs.max(0),
      calculation_trace: envelopeSchema.shape.calculation_trace.max(0),
    }),
  ]);
  const quoteV2EnvelopeSchema = envelopeSchema
    .extend({ data: quoteV2ResultSchema.nullable() })
    .superRefine((envelope, refinement) => {
      if (!quoteV2EnvelopeBranches.safeParse(envelope).success) {
        refinement.addIssue({
          code: "custom",
          message: "quote status and data do not match an allowed v2 envelope branch",
        });
      }
      const sourceIds = envelope.source_refs.map((source) => source.source_id);
      const traceIds = envelope.calculation_trace.flatMap(
        (step) => step.source_ref_ids,
      );
      const data = envelope.data;
      const dataSourceIds = data?.source_ref_ids ?? [];
      const lineSourceIds = data?.line_items.flatMap(
        (line) => line.source_ref_ids,
      ) ?? [];
      const union = [
        ...new Set([...dataSourceIds, ...lineSourceIds, ...traceIds]),
      ];
      const sameSourceSet =
        new Set(sourceIds).size === sourceIds.length &&
        union.length === sourceIds.length &&
        union.every((sourceId) => sourceIds.includes(sourceId));

      if (
        (data !== null || sourceIds.length > 0 || traceIds.length > 0) &&
        !sameSourceSet
      ) {
        refinement.addIssue({
          code: "custom",
          message: "quote source IDs must match the outer source refs exactly",
        });
      }
    })
    .meta({
      anyOf: z.toJSONSchema(quoteV2EnvelopeBranches, {
        target: "draft-2020-12",
      }).anyOf,
    });
  const handlers: ToolHandlerMap = {
    ...bundle.handlers,
    "cargo.calculate": cargoToolHandler,
    "container.plan_summary": containerPlanSummaryHandler,
  };
  const contracts: ToolContractMap = {
    ...bundle.contracts,
    "quote.canada_final_mile.calculate": {
      inputSchema: quoteV2InputSchema,
      validateOutput: (data) => {
        if (data !== null) quoteV2ResultSchema.parse(data);
      },
      outputSchema: quoteV2EnvelopeSchema,
    },
    "cargo.calculate": cargoToolContract,
    "container.plan_summary": containerPlanSummaryToolContract,
  };
  const agentAccessRuntime = configuredAgentAccessRuntime ?? createAgentAccessRuntime();
  const capabilities = new CapabilityRegistry();
  capabilities.provide(
    FREIGHTCOM_RATE_CAPABILITY,
    freightcomRateAdapter,
    FREIGHTCOM_RATE_CAPABILITY_VERSION,
  );
  const moduleHost = new ModuleHost({
    capabilities,
    modules: [
      cargoModule,
      containerModule,
      createFreightcomLtlModule(),
      createAgentAccessModule(agentAccessRuntime),
    ],
  });
  moduleHost.mountSync();
  const moduleToolNames = new Set(moduleHost.catalog.list().map((tool) => tool.name));
  const definitions = [
    ...registerPhaseOneTools(handlers, contracts).filter(
      (definition) => !moduleToolNames.has(definition.name),
    ),
    ...registerModuleToolDefinitions(moduleHost.catalog.list()),
  ];
  return {
    bundle,
    handlers,
    contracts,
    definitions:
      runtimeActivation === undefined
        ? definitions
        : wrapModuleToolDefinitions(definitions, runtimeActivation),
    moduleHost,
    agentAccessRuntime,
  };
}

function runtimeActivationFacades(
  options: GatewayCompositionOptions,
): RuntimeActivationFacades | undefined {
  if (options.activation === undefined && options.dispatch === undefined) {
    return undefined;
  }
  if (options.activation === undefined || options.dispatch === undefined) {
    throw new Error(
      "Runtime activation requires both activation and dispatch facades.",
    );
  }
  if (!isPairedRuntimeActivationFacades(options.activation, options.dispatch)) {
    throw new Error(
      "Runtime activation facades must come from the same control-plane assembly.",
    );
  }
  return {
    activation: options.activation,
    dispatch: options.dispatch,
  };
}

function buildComposition(
  mode: CompositionMode,
  options: GatewayCompositionOptions,
  adapters: FixtureAdapters,
  tools: CompositionTools,
  handler: McpHttpHandler,
  readiness: () => Promise<PlatformReadiness>,
  closeExtra: () => Promise<void> = () => Promise.resolve(),
): GatewayComposition {
  if (options.dataMode !== mode) {
    throw new Error(
      `The ${mode} composition requires DATA_MODE=${mode}; received ${options.dataMode}.`,
    );
  }

  const definitions = tools.definitions;
  return {
    mode,
    dataMode: mode,
    adapters,
    bundle: tools.bundle,
    handlers: tools.handlers,
    contracts: tools.contracts,
    definitions,
    moduleHost: tools.moduleHost,
    agentAccessRuntime: tools.agentAccessRuntime,
    handler,
    readiness,
    close: async () => {
      let failed = false;
      try {
        await handler.close();
      } catch {
        failed = true;
      }
      try {
        await closeExtra();
      } catch {
        failed = true;
      }
      try {
        await tools.moduleHost.close();
      } catch {
        failed = true;
      }
      if (failed) {
        throw new Error("A gateway composition dependency could not be closed.");
      }
    },
  };
}

export function createFixtureComposition(
  options: FixtureCompositionOptions,
): GatewayComposition {
  if (options.dataMode !== "fixtures") {
    throw new Error("Fixture adapters require DATA_MODE=fixtures.");
  }
  const runtimeActivation = runtimeActivationFacades(options);
  const platformOptions = {
    ...(options.auditRepository === undefined
      ? {}
      : { auditRepository: options.auditRepository }),
    ...(options.idempotencyRepository === undefined
      ? {}
      : { idempotencyRepository: options.idempotencyRepository }),
    ...(options.sessionRegistry === undefined
      ? {}
      : { sessionRegistry: options.sessionRegistry }),
    ...(options.sessionRegistryOptions === undefined
      ? {}
      : { sessionRegistryOptions: options.sessionRegistryOptions }),
  };
  const platform = createFixturePlatformDependencies(platformOptions);
  const adapters = createFixtureAdapters(
    options.customsFixture === undefined
      ? {}
      : { customsFixture: options.customsFixture },
  );
  const tools = compositionTools(
    adapters,
    options.freightcomRateAdapter ?? createFreightcomDisabledRateAdapter(),
    options.agentAccessRuntime,
    runtimeActivation,
  );
  const handler = createMcpHttpHandler({
    allowedOrigins: options.allowedOrigins ?? ["https://client.example.invalid"],
    allowedHosts: options.allowedHosts ?? ["mcp.example.invalid"],
    authenticate: options.authenticate ?? failClosedAuthenticator,
    ...(options.tokenPolicy === undefined ? {} : { tokenPolicy: options.tokenPolicy }),
    handlers: tools.handlers,
    contracts: tools.contracts,
    definitions: tools.definitions,
    agentAccessRuntime: tools.agentAccessRuntime,
    auditRepository: platform.auditRepository,
    idempotencyRepository: platform.idempotencyRepository,
    sessionRegistry: platform.sessionRegistry,
    maxBodyBytes: options.maxBodyBytes ?? 32 * 1024,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    requireHttps: true,
  });
  return buildComposition(
    "fixtures",
    options,
    adapters,
    tools,
    handler,
    () => Promise.resolve({ ready: true, reasons: [] }),
  );
}

export function createProductionComposition(
  options: ProductionCompositionOptions,
): GatewayComposition {
  if (options.dataMode !== "production") {
    throw new Error("Production adapters require DATA_MODE=production.");
  }
  const runtimeActivation = runtimeActivationFacades(options);

  const productionPlatformOptions = {
    ...(options.auditRepository === undefined
      ? {}
      : { auditRepository: options.auditRepository }),
    ...(options.idempotencyRepository === undefined
      ? {}
      : { idempotencyRepository: options.idempotencyRepository }),
    ...(options.sessionBindingStore === undefined
      ? {}
      : { sessionBindingStore: options.sessionBindingStore }),
    ...(options.sessionRegistry === undefined
      ? {}
      : { sessionRegistry: options.sessionRegistry }),
    ...(options.sessionRegistryOptions === undefined
      ? {}
      : { sessionRegistryOptions: options.sessionRegistryOptions }),
  };
  const platform = createProductionPlatformAssembly(productionPlatformOptions);

  const verifierStatus = productionDependencyStatus(
    "production_token_verifier",
    "token_verifier",
    options.tokenVerifier,
  );
  const adapterStatus = productionDependencyStatus(
    "production_adapter_source",
    "adapter_source",
    options.adapterSource,
  );
  const providedAdapters = options.adapterSource?.adapters ?? productionAdapters();
  const disabledQuote = new ExistingQuoteAdapter();
  const providedQuote = providedAdapters.quote;
  const adapters: FixtureAdapters = {
    ...providedAdapters,
    quote: providedQuote === undefined
      ? disabledQuote
      : {
          calculate: (input, context, signal) =>
            providedQuote.calculate(input, context, signal),
          previewDraft: (input) => disabledQuote.previewDraft(input),
          commitDraft: (input, signal) => disabledQuote.commitDraft(input, signal),
          readDraft: (input) => disabledQuote.readDraft(input),
        },
    review: new ManualTaskAdapter(),
  };
  const tools = compositionTools(
    adapters,
    createFreightcomDisabledRateAdapter(),
    options.agentAccessRuntime,
    runtimeActivation,
  );
  const allowedOrigins = options.allowedOrigins ?? [];
  const allowedHosts = options.allowedHosts ?? [];
  const validSessionOwner =
    options.sessionOwnerId !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.sessionOwnerId);
  const structuralReasons = [
    ...platform.reasonCodes,
    ...(allowedOrigins.length === 0 ? ["production_allowed_origins_missing"] : []),
    ...(allowedHosts.length === 0 ? ["production_allowed_hosts_missing"] : []),
    ...(options.tokenPolicy === undefined
      ? ["production_token_policy_missing"]
      : []),
    ...(!validSessionOwner
      ? ["platform_session_owner_missing"]
      : []),
    ...(verifierStatus.valid ? [] : [verifierStatus.reason]),
    ...(adapterStatus.valid ? [] : [adapterStatus.reason]),
  ];

  const readiness = async (): Promise<PlatformReadiness> => {
    const platformState = await platform.readiness();
    const reasons = [...platformState.reasons, ...structuralReasons];
    const liveChecks = [
      verifierStatus.valid ? checkProductionHealth(options.tokenVerifier!, verifierStatus.unhealthyReason) : null,
      adapterStatus.valid ? checkProductionHealth(options.adapterSource!, adapterStatus.unhealthyReason) : null,
    ].filter((check): check is Promise<string | null> => check !== null);
    const liveReasons = await Promise.all(liveChecks);
    reasons.push(...liveReasons.filter((reason): reason is string => reason !== null));
    const uniqueReasons = [...new Set(reasons)];
    return { ready: uniqueReasons.length === 0, reasons: uniqueReasons };
  };

  const handler =
    structuralReasons.length > 0 || platform.dependencies === undefined
      ? createUnavailableMcpHttpHandler(structuralReasons)
      : createMcpHttpHandler({
          allowedOrigins,
          allowedHosts,
          authenticate: (token) => options.tokenVerifier!.verify(token),
          ...(options.tokenPolicy === undefined ? {} : { tokenPolicy: options.tokenPolicy }),
          handlers: tools.handlers,
          contracts: tools.contracts,
          definitions: tools.definitions,
          agentAccessRuntime: tools.agentAccessRuntime,
          auditRepository: platform.dependencies.auditRepository,
          idempotencyRepository: platform.dependencies.idempotencyRepository,
          sessionRegistry: platform.dependencies.sessionRegistry,
          sessionBindingStore: platform.dependencies.sessionBindingStore,
          sessionOwnerId: options.sessionOwnerId!,
          maxBodyBytes: options.maxBodyBytes ?? 32 * 1024,
          requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
          requireHttps: true,
        });

  return buildComposition(
    "production",
    options,
    adapters,
    tools,
    handler,
    readiness,
    async () => {
      const results = await Promise.allSettled([
        platform.close(),
        ...(options.tokenVerifier === undefined ||
        typeof options.tokenVerifier.close !== "function"
          ? []
          : [options.tokenVerifier.close()]),
        ...(options.adapterSource === undefined ||
        typeof options.adapterSource.close !== "function"
          ? []
          : [options.adapterSource.close()]),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("A production composition dependency could not be closed.");
      }
    },
  );
}

interface ProductionDependencyStatus {
  readonly valid: boolean;
  readonly reason: string;
  readonly unhealthyReason: string;
}

function productionDependencyStatus(
  dependencyName: "production_token_verifier" | "production_adapter_source",
  expectedKind: "token_verifier" | "adapter_source",
  value: ManagedProductionDependency | undefined,
): ProductionDependencyStatus {
  const missingReason = `${dependencyName}_missing`;
  const invalidReason = `${dependencyName}_invalid`;
  const unhealthyReason = `${dependencyName}_unhealthy`;
  if (value === undefined) {
    return { valid: false, reason: missingReason, unhealthyReason };
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    record.kind !== expectedKind ||
    typeof record.health !== "function" ||
    typeof record.close !== "function" ||
    (expectedKind === "token_verifier" && typeof record.verify !== "function") ||
    (expectedKind === "adapter_source" && !Object.hasOwn(record, "adapters"))
  ) {
    return { valid: false, reason: invalidReason, unhealthyReason };
  }
  return { valid: true, reason: invalidReason, unhealthyReason };
}

async function checkProductionHealth(
  dependency: ManagedProductionDependency,
  reason: string,
): Promise<string | null> {
  try {
    return (await dependency.health()).ready ? null : reason;
  } catch {
    return reason;
  }
}
