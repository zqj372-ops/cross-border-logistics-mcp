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
  type DomainToolHandler,
  type ToolContractMap,
  type ToolDefinition,
  type ToolHandlerMap,
} from "./tool-registry";
import type {
  CustomsAdapter,
  FixtureAdapters,
  QuoteAdapter,
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
  quoteCreatePdfInputSchema,
  quoteCreatePdfWriteResultSchema,
  type QuotePdfPort,
} from "../domains/quote/create-pdf";

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
}

export interface FixtureCompositionOptions extends GatewayCompositionOptions {
  readonly dataMode: "fixtures";
  readonly customsFixture?: FixtureAdapterOptions["customsFixture"];
  readonly quote?: QuoteAdapter;
  readonly quotePdf?: QuotePdfPort;
}

export interface ProductionCompositionOptions
  extends Omit<GatewayCompositionOptions, "auditRepository" | "idempotencyRepository"> {
  readonly dataMode: "production";
  readonly auditRepository?: DurableAuditRepository;
  readonly idempotencyRepository?: DurableIdempotencyRepository;
  readonly tokenVerifier?: ProductionTokenVerifier;
  readonly adapterSource?: ProductionAdapterSource;
  readonly quotePdfEnabled?: boolean;
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
  readonly handler: McpHttpHandler;
  readonly readiness: () => Promise<PlatformReadiness>;
  readonly close: () => Promise<void>;
}

function failClosedAuthenticator(): AuthClaims {
  throw new AuthenticationError(
    "No production token verifier has been configured for this composition.",
  );
}

function hasQuotePdfPort(value: unknown): value is QuotePdfPort {
  return typeof value === "object" && value !== null &&
    typeof (value as { post?: unknown }).post === "function" &&
    typeof (value as { get?: unknown }).get === "function";
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
}

function compositionTools(
  adapters: FixtureAdapters,
  quotePdfEnabled = false,
  quotePdfReady: () => boolean = () => true,
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
  const quotePdfPreviewDataSchema = quoteCreatePdfWriteResultSchema.and(
    z.object({ operation_status: z.literal("previewed") }),
  );
  const quotePdfCommittedDataSchema = quoteCreatePdfWriteResultSchema.and(
    z.object({
      operation_status: z.enum(["committed", "already_committed"]),
    }),
  );
  const quotePdfEnvelopeBranches = z.union([
    envelopeSchema.extend({
      status: z.literal("success"),
      data: quotePdfPreviewDataSchema,
      source_refs: envelopeSchema.shape.source_refs.min(1),
      calculation_trace: envelopeSchema.shape.calculation_trace.min(1),
      blockers: envelopeSchema.shape.blockers.max(0),
    }),
    envelopeSchema.extend({
      status: z.literal("success"),
      data: quotePdfCommittedDataSchema,
      source_refs: envelopeSchema.shape.source_refs.min(1),
      calculation_trace: envelopeSchema.shape.calculation_trace.min(1),
      blockers: envelopeSchema.shape.blockers.max(0),
    }),
    envelopeSchema.extend({
      status: z.enum(["needs_input", "manual_review", "blocked", "unavailable"]),
      data: z.null(),
      blockers: envelopeSchema.shape.blockers.min(1),
    }),
  ]);
  const quotePdfEnvelopeSchema = envelopeSchema
    .extend({ data: quoteCreatePdfWriteResultSchema.nullable() })
    .superRefine((envelope, refinement) => {
      if (!quotePdfEnvelopeBranches.safeParse(envelope).success) {
        refinement.addIssue({
          code: "custom",
          message: "quote PDF success must contain a valid preview or commit result",
        });
      }
      if (envelope.status !== "success") return;
      const sourceIds = envelope.source_refs.map((source) => source.source_id);
      const data = envelope.data as Record<string, unknown>;
      const readback = data.readback_evidence;
      const rawDataIds = data.source_ref_ids;
      const dataIds = Array.isArray(rawDataIds)
        ? rawDataIds.filter((value: unknown): value is string => typeof value === "string")
        : [];
      const rawReadbackIds = typeof readback === "object" && readback !== null && !Array.isArray(readback)
        ? (readback as Record<string, unknown>).source_ref_ids
        : null;
      const readbackIds = Array.isArray(rawReadbackIds)
        ? rawReadbackIds.filter((value: unknown): value is string => typeof value === "string")
        : [];
      const referencedIds = [
        ...dataIds,
        ...readbackIds,
        ...envelope.calculation_trace.flatMap((step) => step.source_ref_ids),
      ];
      const referencedSet = new Set(referencedIds);
      const sourceIdsClosed = new Set(sourceIds).size === sourceIds.length &&
        referencedSet.size === sourceIds.length &&
        [...referencedSet].every((sourceId) => sourceIds.includes(sourceId));
      if (!sourceIdsClosed) {
        refinement.addIssue({
          code: "custom",
          message: "quote PDF source IDs must match the outer source refs exactly",
        });
      }
    })
    .meta({
      anyOf: z.toJSONSchema(quotePdfEnvelopeBranches, {
        target: "draft-2020-12",
      }).anyOf,
    });
  const quotePdfUnavailableHandler: DomainToolHandler = () => ({
    status: "unavailable",
    data: null,
    blockers: [{
      code: "quote.create_pdf.handler_unavailable",
      message: "The quote PDF handler is not configured; no PDF request was sent.",
      severity: "error",
      field: null,
    }],
    reviewStatus: "manual_review",
  });
  const quotePdfHandler: DomainToolHandler =
    quotePdfEnabled && hasQuotePdfPort(adapters.quotePdf)
      ? (input, context, signal) => quotePdfReady()
        ? bundle.handlers["quote.create_pdf"](input, context, signal)
        : quotePdfUnavailableHandler(input, context, signal)
      : quotePdfUnavailableHandler;
  const handlers: ToolHandlerMap = {
    ...bundle.handlers,
    "cargo.calculate": cargoToolHandler,
    "container.plan_summary": containerPlanSummaryHandler,
    "quote.create_pdf": quotePdfHandler,
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
    "quote.create_pdf": {
      inputSchema: quoteCreatePdfInputSchema,
      validateOutput: (data) => {
        if (data !== null) quoteCreatePdfWriteResultSchema.parse(data);
      },
      outputSchema: quotePdfEnvelopeSchema,
    },
  };
  return { bundle, handlers, contracts };
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

  const definitions = registerPhaseOneTools(tools.handlers, tools.contracts);
  return {
    mode,
    dataMode: mode,
    adapters,
    bundle: tools.bundle,
    handlers: tools.handlers,
    contracts: tools.contracts,
    definitions,
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
  const fixtureAdapters = createFixtureAdapters(
    {
      ...(options.customsFixture === undefined
        ? {}
        : { customsFixture: options.customsFixture }),
      ...(options.quotePdf === undefined ? {} : { quotePdf: options.quotePdf }),
    },
  );
  const fixtureQuote = fixtureAdapters.quote;
  const disabledQuote = new ExistingQuoteAdapter();
  const adapters: FixtureAdapters = {
    ...fixtureAdapters,
    quote: {
      calculate: async (input, context, signal) => {
        if (options.quote !== undefined) {
          return options.quote.calculate(input, context, signal);
        }
        const parsed = quoteV2InputSchema.safeParse(input);
        const reviewField =
          parsed.success && parsed.data.services.limited_access
            ? "services.limited_access"
            : parsed.success && parsed.data.services.remote_area
              ? "services.remote_area"
              : null;
        if (reviewField !== null) {
          return {
            status: "manual_review",
            data: null,
            sourceRefs: [],
            warnings: [{
              code: "quote.zero_upstream_call",
              message: "limited_access 或 remote_area 门禁不发起上游报价调用。",
              severity: "warning" as const,
              field: reviewField,
            }],
            blockers: [{
              code: "quote.manual_review_required",
              message: "该服务门禁需要人工复核，不能伪造报价、发布或来源证据。",
              severity: "error" as const,
              field: reviewField,
            }],
            calculationTrace: [],
            reviewStatus: "manual_review",
          };
        }
        return disabledQuote.calculate(input, context, signal);
      },
      previewDraft: (input) => fixtureQuote.previewDraft(input),
      commitDraft: (input, signal) => fixtureQuote.commitDraft(input, signal),
      readDraft: (input) => fixtureQuote.readDraft(input),
    },
  };
  const tools = compositionTools(
    adapters,
    options.quote !== undefined && options.quotePdf !== undefined,
  );
  const handler = createMcpHttpHandler({
    allowedOrigins: options.allowedOrigins ?? ["https://client.example.invalid"],
    allowedHosts: options.allowedHosts ?? ["mcp.example.invalid"],
    authenticate: options.authenticate ?? failClosedAuthenticator,
    ...(options.tokenPolicy === undefined ? {} : { tokenPolicy: options.tokenPolicy }),
    handlers: tools.handlers,
    contracts: tools.contracts,
    auditRepository: platform.auditRepository,
    idempotencyRepository: platform.idempotencyRepository,
    sessionRegistry: platform.sessionRegistry,
    maxBodyBytes: options.maxBodyBytes ?? 32 * 1024,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
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
  let productionQuotePdfReady = false;
  const quotePdfConfigured = options.quotePdfEnabled === true &&
    hasQuotePdfPort(providedAdapters.quotePdf) &&
    structuralReasons.length === 0;
  const tools = compositionTools(
    adapters,
    quotePdfConfigured,
    () => productionQuotePdfReady,
  );

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
    productionQuotePdfReady = quotePdfConfigured && uniqueReasons.length === 0;
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
          auditRepository: platform.dependencies.auditRepository,
          idempotencyRepository: platform.dependencies.idempotencyRepository,
          sessionRegistry: platform.dependencies.sessionRegistry,
          sessionBindingStore: platform.dependencies.sessionBindingStore,
          sessionOwnerId: options.sessionOwnerId!,
          maxBodyBytes: options.maxBodyBytes ?? 32 * 1024,
          requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
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
        options.tokenVerifier === null ||
        typeof options.tokenVerifier.close !== "function"
          ? []
          : [options.tokenVerifier.close()]),
        ...(options.adapterSource === undefined ||
        options.adapterSource === null ||
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
  if (typeof value !== "object" || value === null) {
    return { valid: false, reason: invalidReason, unhealthyReason };
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
