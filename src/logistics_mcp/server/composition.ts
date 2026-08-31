import { z } from "zod";

import {
  AuthenticationError,
  parseExecutionContext,
  type AuthClaims,
} from "../platform/context";
import { isExactT0ServiceIdentity } from "../platform/rbac";
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
  type ToolContract,
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
  assertExactStringSet,
  T0_MODULE_DESCRIPTORS,
  T0_PRODUCTION_MODULE_IDS,
  T0_PRODUCTION_RESOURCE_URIS,
  T0_PRODUCTION_TOOL_NAMES,
  parseT0ProductionProfile,
  type T0ProductionProfile,
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
import { CANONICAL_AGENT_RESOURCES } from "../agent-context/resources";
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
  type Phase1Bundle,
} from "../adapters/phase1-bundle";
import {
  quoteSaveDraftInputSchema,
  writeResultSchema,
} from "../adapters/contracts";
import {
  canadaFinalMileInputSchema,
  canadaFinalMileOutputValidator,
  calculateCanadaFinalMile,
} from "../domains/quote/canada-final-mile";
import {
  customsEstimateInputSchema,
  customsEstimateOutputValidator,
  estimateCanadaCustoms,
} from "../domains/customs/ca-estimate";
import {
  customsSearchInputSchema,
  customsSearchOutputValidator,
  searchCanadaCustoms,
} from "../domains/customs/ca-search";
import {
  knowledgeSearchInputSchema,
  knowledgeSearchOutputValidator,
  searchCuratedKnowledge,
} from "../domains/knowledge/search-curated";
import {
  dataStatusInputSchema,
  dataStatusOutputValidator,
  getSystemDataStatus,
} from "../domains/status/data-status";
import {
  reviewCreateTaskInputSchema,
  reviewCreateTaskOutputValidator,
  createReviewTask,
} from "../domains/review/create-task";
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
  readonly profile?: string;
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
  readonly profile?: T0ProductionProfile;
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

function isCompactJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token);
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

function fixtureInputRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("The tool input must be an object after contract validation.");
  }
  return input as Record<string, unknown>;
}

function fixtureContract(
  inputSchema: ToolContract["inputSchema"],
  validateOutput: ToolContract["validateOutput"],
): ToolContract {
  return { inputSchema, validateOutput };
}

/**
 * Keep the fixture bundle local to the fixture composition. Importing the
 * legacy phase1-bundle module constructs a default fixture adapter bundle at
 * module evaluation time, which would violate the production T0 boundary.
 */
function createFixturePhase1Bundle(adapters: FixtureAdapters): Phase1Bundle {
  const handlers: Phase1Bundle["handlers"] = {
    "knowledge.search_curated": (input) =>
      searchCuratedKnowledge(adapters.knowledge, fixtureInputRecord(input)),
    "system.get_data_status": (input) =>
      getSystemDataStatus(adapters.status, fixtureInputRecord(input)),
    "quote.canada_final_mile.calculate": (input, context, signal) =>
      calculateCanadaFinalMile(adapters.quote, fixtureInputRecord(input), context, signal),
    "customs.ca.search": (input, context, signal) =>
      searchCanadaCustoms(adapters.customs, fixtureInputRecord(input), context, signal),
    "customs.ca.estimate": (input, context, signal) =>
      estimateCanadaCustoms(adapters.customs, fixtureInputRecord(input), context, signal),
    "quote.save_draft": (input, _context, signal) => {
      const value = fixtureInputRecord(input);
      const writeContext = value.write_context;
      const writeContextRecord =
        typeof writeContext === "object" &&
        writeContext !== null &&
        !Array.isArray(writeContext)
          ? writeContext as Record<string, unknown>
          : null;
      const mode = writeContextRecord?.operation_mode === "preview"
        ? "preview"
        : "commit";
      return mode === "preview"
        ? adapters.quote.previewDraft(value)
        : adapters.quote.commitDraft(value, signal);
    },
    "review.create_task": (input, _context, signal) =>
      createReviewTask(adapters.review, fixtureInputRecord(input), signal),
  };

  const contracts: Phase1Bundle["contracts"] = {
    "knowledge.search_curated": fixtureContract(
      knowledgeSearchInputSchema,
      knowledgeSearchOutputValidator,
    ),
    "system.get_data_status": fixtureContract(
      dataStatusInputSchema,
      dataStatusOutputValidator,
    ),
    "quote.canada_final_mile.calculate": fixtureContract(
      canadaFinalMileInputSchema,
      canadaFinalMileOutputValidator,
    ),
    "customs.ca.search": fixtureContract(
      customsSearchInputSchema,
      customsSearchOutputValidator,
    ),
    "customs.ca.estimate": fixtureContract(
      customsEstimateInputSchema,
      customsEstimateOutputValidator,
    ),
    "quote.save_draft": fixtureContract(
      quoteSaveDraftInputSchema,
      (data) => writeResultSchema.parse(data),
    ),
    "review.create_task": fixtureContract(
      reviewCreateTaskInputSchema,
      reviewCreateTaskOutputValidator,
    ),
  };

  return { handlers, contracts };
}

function compositionTools(
  adapters: FixtureAdapters,
  freightcomRateAdapter: FreightcomRatePort,
  configuredAgentAccessRuntime?: AgentAccessRuntime,
  runtimeActivation?: RuntimeActivationFacades,
): CompositionTools {
  const bundle = createFixturePhase1Bundle(adapters);
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

const emptyProductionAdapters = Object.freeze({}) as unknown as FixtureAdapters;

function t0CompositionTools(
  configuredAgentAccessRuntime?: AgentAccessRuntime,
  runtimeActivation?: RuntimeActivationFacades,
): CompositionTools {
  const agentAccessRuntime = configuredAgentAccessRuntime ?? createAgentAccessRuntime();
  const moduleHost = new ModuleHost({
    capabilities: new CapabilityRegistry(),
    modules: [
      cargoModule,
      containerModule,
      createAgentAccessModule(agentAccessRuntime),
    ],
    trustedDescriptors: T0_MODULE_DESCRIPTORS,
  });
  moduleHost.mountSync();

  const moduleEntries = moduleHost.catalog.list();
  assertExactStringSet(
    moduleHost.snapshot().modules.map((module) => module.module_id),
    T0_PRODUCTION_MODULE_IDS,
    "t0_module_set_invalid",
  );
  assertExactStringSet(
    moduleEntries.map((entry) => entry.name),
    T0_PRODUCTION_TOOL_NAMES,
    "t0_tool_set_invalid",
  );

  const handlers: ToolHandlerMap = {
    "cargo.calculate": cargoToolHandler,
    "container.plan_summary": containerPlanSummaryHandler,
  };
  const contracts: ToolContractMap = {
    "cargo.calculate": cargoToolContract,
    "container.plan_summary": containerPlanSummaryToolContract,
  };
  const definitions = registerModuleToolDefinitions(moduleEntries);
  const bundle = { handlers, contracts } as unknown as Phase1Bundle;
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

interface T0ModuleSnapshot {
  readonly module_id: string;
  readonly version: string;
  readonly risk_level: string;
  readonly tool_names: readonly string[];
}

const t0ModuleStandardIds: Readonly<Record<string, readonly string[]>> = {
  cargo: ["module-runtime.v0", "platform.contracts"],
  container: ["module-runtime.v0", "platform.contracts"],
  "agent-access": ["module-runtime.v0", "platform.contracts", "agent-access.v0"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResourceJson(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error("Agent resource JSON must be an object.");
  return parsed;
}

function assertT0AgentResourceSet(
  runtime: AgentAccessRuntime,
  expectedModules: readonly T0ModuleSnapshot[],
): readonly string[] {
  assertExactStringSet(
    CANONICAL_AGENT_RESOURCES.map((resource) => resource.uri),
    T0_PRODUCTION_RESOURCE_URIS,
    "t0_resource_set_invalid",
  );
  if (!runtime.available) return ["t0_agent_pack_unavailable"];

  try {
    const checkContext = parseExecutionContext({
      tenant_id: "runtime.t0.check",
      actor_id: "runtime.t0.check",
      actor_role: "service",
      roles: ["service"],
      scopes: ["system:agent_context"],
      client_id: "runtime.t0.check",
      session_id: "runtime.t0.check",
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const contents = new Map<string, string>();
    for (const resource of CANONICAL_AGENT_RESOURCES) {
      const content = runtime.readResource(resource.uri, checkContext);
      if (
        content.uri !== resource.uri ||
        content.mimeType !== resource.mimeType ||
        content.text.length === 0
      ) {
        throw new Error("Agent resource content does not match its canonical descriptor.");
      }
      contents.set(resource.uri, content.text);
    }

    const modulePayload = parseResourceJson(
      contents.get("logistics://modules/catalog") ?? "",
    );
    if (!Array.isArray(modulePayload.modules)) {
      throw new Error("The Agent module catalog is invalid.");
    }
    const actualModules = modulePayload.modules.filter(isRecord);
    if (actualModules.length !== modulePayload.modules.length) {
      throw new Error("The Agent module catalog contains an invalid module.");
    }
    assertExactStringSet(
      actualModules.map((module) => typeof module.module_id === "string" ? module.module_id : ""),
      expectedModules.map((module) => module.module_id),
      "t0_agent_module_set_invalid",
    );
    for (const expected of expectedModules) {
      const actual = actualModules.find((module) => module.module_id === expected.module_id);
      if (
        actual === undefined ||
        actual.version !== expected.version ||
        actual.risk_level !== expected.risk_level
      ) {
        throw new Error("The Agent module catalog identity does not match the mounted T0 module.");
      }
      if (!Array.isArray(actual.tool_names) || !Array.isArray(actual.standard_ids)) {
        throw new Error("The Agent module catalog projection is incomplete.");
      }
      assertExactStringSet(
        actual.tool_names.filter((name): name is string => typeof name === "string"),
        expected.tool_names,
        "t0_agent_module_tool_set_invalid",
      );
      if (actual.tool_names.some((name) => typeof name !== "string")) {
        throw new Error("The Agent module catalog tool projection is invalid.");
      }
      const standardIds = t0ModuleStandardIds[expected.module_id];
      if (standardIds === undefined) throw new Error("The T0 module standard set is not reviewed.");
      assertExactStringSet(
        actual.standard_ids.filter((standardId): standardId is string => typeof standardId === "string"),
        standardIds,
        "t0_agent_module_standard_set_invalid",
      );
      if (actual.standard_ids.some((standardId) => typeof standardId !== "string")) {
        throw new Error("The Agent module catalog standard projection is invalid.");
      }
    }

    const profilePayload = parseResourceJson(
      contents.get("logistics://agent/profiles") ?? "",
    );
    if (!Array.isArray(profilePayload.profiles)) {
      throw new Error("The Agent profile catalog is invalid.");
    }
    const runtimeProfile = profilePayload.profiles.find(
      (profile): profile is Record<string, unknown> =>
        isRecord(profile) && profile.profile_id === "runtime-caller",
    );
    if (
      runtimeProfile === undefined ||
      runtimeProfile.audience !== "caller" ||
      runtimeProfile.content_mode !== "summary" ||
      !Array.isArray(runtimeProfile.allowed_module_ids)
    ) {
      throw new Error("The runtime-caller Agent profile is not a reviewed T0 profile.");
    }
    const allowedModuleIds = runtimeProfile.allowed_module_ids.filter(
      (moduleId): moduleId is string => typeof moduleId === "string",
    );
    assertExactStringSet(
      allowedModuleIds,
      expectedModules.map((module) => module.module_id),
      "t0_agent_profile_module_set_invalid",
    );
    if (runtimeProfile.allowed_module_ids.some((moduleId) => typeof moduleId !== "string")) {
      throw new Error("The runtime-caller Agent profile module projection is invalid.");
    }
    return [];
  } catch {
    return ["t0_agent_pack_mismatch"];
  }
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
  profile?: T0ProductionProfile,
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
    ...(profile === undefined ? {} : { profile }),
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
  const profile = parseT0ProductionProfile(
    Object.hasOwn(options, "profile") ? options.profile : "t0-v1",
  );
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
  const tools = t0CompositionTools(options.agentAccessRuntime, runtimeActivation);
  const mountedModules = tools.moduleHost.snapshot().modules.map((module) => ({
    module_id: module.module_id,
    version: module.version,
    risk_level: module.risk_level,
    tool_names: module.tool_names,
  }));
  const agentResourceReasons = assertT0AgentResourceSet(
    tools.agentAccessRuntime,
    mountedModules,
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
    ...(options.adapterSource === undefined
      ? []
      : ["production_non_t0_adapter_configured"]),
    ...agentResourceReasons,
  ];

  const readiness = async (): Promise<PlatformReadiness> => {
    const platformState = await platform.readiness();
    const reasons = [...platformState.reasons, ...structuralReasons];
    const liveChecks = [
      verifierStatus.valid ? checkProductionHealth(options.tokenVerifier!, verifierStatus.unhealthyReason) : null,
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
          authenticate: async (token) => {
            if (!isCompactJwt(token)) throw new AuthenticationError();
            const claims = await options.tokenVerifier!.verify(token);
            if (!isExactT0ServiceIdentity({
              role: claims.actor_role,
              roles: claims.roles,
              scopes: claims.scopes,
            })) {
              throw new AuthenticationError();
            }
            return claims;
          },
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
    emptyProductionAdapters,
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
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("A production composition dependency could not be closed.");
      }
    },
    profile,
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
