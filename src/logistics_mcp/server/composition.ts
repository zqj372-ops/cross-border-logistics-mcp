import {
  AuthenticationError,
  parseExecutionContext,
  type AuthClaims,
} from "../platform/context";
import {
  isExactReadPreviewServiceIdentity,
  isExactT0ServiceIdentity,
} from "../platform/rbac";
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
import type { McpTransportMode } from "../platform/transport-mode";
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
  createReadPreviewCatalogGeneration,
  createT0CatalogGeneration,
  ModuleHost,
  assertExactStringSet,
  READ_PREVIEW_MODULE_DESCRIPTORS,
  READ_PREVIEW_MODULE_IDS,
  READ_PREVIEW_STAGING_PROFILE,
  READ_PREVIEW_TOOL_NAMES,
  T0_MODULE_DESCRIPTORS,
  T0_PRODUCTION_MODULE_IDS,
  T0_PRODUCTION_RESOURCE_URIS,
  T0_PRODUCTION_TOOL_NAMES,
  parseProductionRuntimeProfile,
  type CatalogGenerationReceipt,
  type ProductionRuntimeProfile,
  type T0ProductionProfile,
} from "../module-runtime";
import {
  cargoModule,
  containerModule,
  createAgentAccessModule,
  createCanadaFinalMileQuoteModule,
  createFreightcomLtlModule,
  createRiskCustomsCaModule,
  CANADA_FINAL_MILE_QUOTE_CAPABILITY,
  CANADA_FINAL_MILE_QUOTE_CAPABILITY_VERSION,
  FREIGHTCOM_RATE_CAPABILITY,
  FREIGHTCOM_RATE_CAPABILITY_VERSION,
  RISK_CUSTOMS_CA_CAPABILITY,
  RISK_CUSTOMS_CA_CAPABILITY_VERSION,
} from "../modules";
import { createAgentAccessRuntime, type AgentAccessRuntime } from "../agent-context/runtime";
import { CANONICAL_AGENT_RESOURCES } from "../agent-context/resources";
import type {
  AdapterResult,
  CustomsAdapter,
  FixtureAdapters,
  FreightcomRatePort,
  QuoteAdapter,
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
import { quoteV2EnvelopeSchema } from "../domains/quote/v2-envelope";
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

export interface T1ReadWorker extends ManagedProductionDependency {
  readonly kind: "t1_read_worker";
  readonly adapters: Readonly<{
    readonly quote: QuoteAdapter;
    readonly customs: CustomsAdapter;
    readonly freightcom: FreightcomRatePort;
  }>;
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
  readonly transportMode?: McpTransportMode;
  readonly auditRepository?: DurableAuditRepository;
  readonly idempotencyRepository?: DurableIdempotencyRepository;
  readonly tokenVerifier?: ProductionTokenVerifier;
  readonly adapterSource?: ProductionAdapterSource;
  readonly t1Worker?: T1ReadWorker;
  readonly sessionBindingStore?: DurableSessionBindingStore;
  readonly sessionOwnerId?: string;
}

export interface GatewayComposition {
  readonly mode: CompositionMode;
  readonly dataMode: CompositionMode;
  readonly profile?: ProductionRuntimeProfile;
  readonly catalogGeneration?: CatalogGenerationReceipt;
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
  readonly catalogGeneration?: CatalogGenerationReceipt;
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

function unavailableT1Result(code: string, message: string): AdapterResult {
  return {
    status: "unavailable",
    data: null,
    sourceRefs: [],
    calculationTrace: [],
    blockers: [{ code, message, severity: "error", field: null }],
    reviewStatus: "manual_review",
  };
}

const unavailableT1Adapters = Object.freeze({
  quote: Object.freeze({
    calculate: () => Promise.resolve(unavailableT1Result(
      "quote.t1_worker_unavailable",
      "The isolated quote worker is unavailable.",
    )),
    previewDraft: () => Promise.resolve(unavailableT1Result(
      "write.profile_forbidden",
      "Write operations are not available in the read-preview profile.",
    )),
    commitDraft: () => Promise.resolve(unavailableT1Result(
      "write.profile_forbidden",
      "Write operations are not available in the read-preview profile.",
    )),
    readDraft: () => Promise.resolve(unavailableT1Result(
      "write.profile_forbidden",
      "Write operations are not available in the read-preview profile.",
    )),
  } satisfies QuoteAdapter),
  customs: Object.freeze({
    getStatus: () => Promise.resolve(unavailableT1Result(
      "customs.t1_worker_unavailable",
      "The isolated customs worker is unavailable.",
    )),
    search: () => Promise.resolve(unavailableT1Result(
      "customs.t1_worker_unavailable",
      "The isolated customs worker is unavailable.",
    )),
    estimate: () => Promise.resolve(unavailableT1Result(
      "customs.estimate_unavailable",
      "The verified customs estimate contract is not available.",
    )),
  } satisfies CustomsAdapter),
  freightcom: Object.freeze({
    requestRate: () => Promise.resolve(unavailableT1Result(
      "freightcom.t1_worker_unavailable",
      "The isolated Freightcom test worker is unavailable.",
    )),
  } satisfies FreightcomRatePort),
});

function t0CompositionTools(
  profile: T0ProductionProfile,
  configuredAgentAccessRuntime?: AgentAccessRuntime,
  runtimeActivation?: RuntimeActivationFacades,
): CompositionTools {
  const catalogGeneration = createT0CatalogGeneration(profile);
  const agentAccessRuntime = configuredAgentAccessRuntime ?? createAgentAccessRuntime({
    catalogIdentity: {
      schema_version: catalogGeneration.schema_version,
      profile: catalogGeneration.profile,
      catalog_generation: catalogGeneration.catalog_generation,
      catalog_digest: catalogGeneration.catalog_digest,
    },
  });
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
    catalogGeneration,
  };
}

function readPreviewCompositionTools(
  worker: T1ReadWorker | undefined,
  configuredAgentAccessRuntime?: AgentAccessRuntime,
  runtimeActivation?: RuntimeActivationFacades,
): CompositionTools {
  const catalogGeneration = createReadPreviewCatalogGeneration();
  const agentAccessRuntime = configuredAgentAccessRuntime ?? createAgentAccessRuntime({
    runtimeProfileId: "read-preview-caller",
    catalogIdentity: {
      schema_version: catalogGeneration.schema_version,
      profile: catalogGeneration.profile,
      catalog_generation: catalogGeneration.catalog_generation,
      catalog_digest: catalogGeneration.catalog_digest,
    },
  });
  const adapters = worker?.adapters ?? unavailableT1Adapters;
  const capabilities = new CapabilityRegistry();
  capabilities.provide(
    CANADA_FINAL_MILE_QUOTE_CAPABILITY,
    adapters.quote,
    CANADA_FINAL_MILE_QUOTE_CAPABILITY_VERSION,
  );
  capabilities.provide(
    RISK_CUSTOMS_CA_CAPABILITY,
    adapters.customs,
    RISK_CUSTOMS_CA_CAPABILITY_VERSION,
  );
  capabilities.provide(
    FREIGHTCOM_RATE_CAPABILITY,
    adapters.freightcom,
    FREIGHTCOM_RATE_CAPABILITY_VERSION,
  );
  const moduleHost = new ModuleHost({
    capabilities,
    modules: [
      cargoModule,
      containerModule,
      createCanadaFinalMileQuoteModule(),
      createRiskCustomsCaModule(),
      createFreightcomLtlModule(),
      createAgentAccessModule(agentAccessRuntime),
    ],
    trustedDescriptors: READ_PREVIEW_MODULE_DESCRIPTORS,
  });
  moduleHost.mountSync();

  const moduleEntries = moduleHost.catalog.list();
  assertExactStringSet(
    moduleHost.snapshot().modules.map((module) => module.module_id),
    READ_PREVIEW_MODULE_IDS,
    "read_preview_module_set_invalid",
  );
  assertExactStringSet(
    moduleEntries.map((entry) => entry.name),
    READ_PREVIEW_TOOL_NAMES,
    "read_preview_tool_set_invalid",
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
    definitions: runtimeActivation === undefined
      ? definitions
      : wrapModuleToolDefinitions(definitions, runtimeActivation),
    moduleHost,
    agentAccessRuntime,
    catalogGeneration,
  };
}

interface T0ModuleSnapshot {
  readonly module_id: string;
  readonly version: string;
  readonly risk_level: string;
  readonly tool_names: readonly string[];
}

const moduleStandardIds: Readonly<Record<string, readonly string[]>> = {
  cargo: ["module-runtime.v0", "platform.contracts"],
  container: ["module-runtime.v0", "platform.contracts"],
  "canada-final-mile-quote": ["module-runtime.v0", "platform.contracts"],
  "riskcustoms-ca": ["module-runtime.v0", "platform.contracts"],
  "freightcom-ltl": ["module-runtime.v0", "platform.contracts"],
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

function assertProductionAgentResourceSet(
  runtime: AgentAccessRuntime,
  expectedModules: readonly T0ModuleSnapshot[],
  expectedGeneration: CatalogGenerationReceipt,
  expectedProfileId: "runtime-caller" | "read-preview-caller",
  errorPrefix: "t0" | "read_preview",
): readonly string[] {
  assertExactStringSet(
    CANONICAL_AGENT_RESOURCES.map((resource) => resource.uri),
    T0_PRODUCTION_RESOURCE_URIS,
    `${errorPrefix}_resource_set_invalid`,
  );
  if (!runtime.available) return [`${errorPrefix}_agent_pack_unavailable`];

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
    if (
      modulePayload.schema_version !== expectedGeneration.schema_version ||
      modulePayload.profile !== expectedGeneration.profile ||
      modulePayload.catalog_generation !== expectedGeneration.catalog_generation ||
      modulePayload.catalog_digest !== expectedGeneration.catalog_digest
    ) {
      return [`${errorPrefix}_catalog_generation_mismatch`];
    }
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
      `${errorPrefix}_agent_module_set_invalid`,
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
        `${errorPrefix}_agent_module_tool_set_invalid`,
      );
      if (actual.tool_names.some((name) => typeof name !== "string")) {
        throw new Error("The Agent module catalog tool projection is invalid.");
      }
      const standardIds = moduleStandardIds[expected.module_id];
      if (standardIds === undefined) throw new Error("The module standard set is not reviewed.");
      assertExactStringSet(
        actual.standard_ids.filter((standardId): standardId is string => typeof standardId === "string"),
        standardIds,
        `${errorPrefix}_agent_module_standard_set_invalid`,
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
        isRecord(profile) && profile.profile_id === expectedProfileId,
    );
    if (
      runtimeProfile === undefined ||
      runtimeProfile.audience !== "caller" ||
      runtimeProfile.content_mode !== "summary" ||
      !Array.isArray(runtimeProfile.allowed_module_ids)
    ) {
      throw new Error("The runtime Agent profile is not reviewed for this catalog.");
    }
    const allowedModuleIds = runtimeProfile.allowed_module_ids.filter(
      (moduleId): moduleId is string => typeof moduleId === "string",
    );
    assertExactStringSet(
      allowedModuleIds,
      expectedModules.map((module) => module.module_id),
      `${errorPrefix}_agent_profile_module_set_invalid`,
    );
    if (runtimeProfile.allowed_module_ids.some((moduleId) => typeof moduleId !== "string")) {
      throw new Error("The runtime-caller Agent profile module projection is invalid.");
    }
    return [];
  } catch {
    return [`${errorPrefix}_agent_pack_mismatch`];
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
  profile?: ProductionRuntimeProfile,
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
    ...(tools.catalogGeneration === undefined
      ? {}
      : { catalogGeneration: tools.catalogGeneration }),
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
  const profile = parseProductionRuntimeProfile(
    Object.hasOwn(options, "profile") ? options.profile : "t0-v1",
  );
  const readPreview = profile === READ_PREVIEW_STAGING_PROFILE;
  const transportMode = options.transportMode ?? "stateless";
  const runtimeActivation = runtimeActivationFacades(options);

  const productionPlatformOptions = {
    transportMode,
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
  const workerStatus = productionDependencyStatus(
    "production_t1_read_worker",
    "t1_read_worker",
    options.t1Worker,
  );
  const tools = readPreview
    ? readPreviewCompositionTools(
        workerStatus.valid ? options.t1Worker : undefined,
        options.agentAccessRuntime,
        runtimeActivation,
      )
    : t0CompositionTools(
        profile,
        options.agentAccessRuntime,
        runtimeActivation,
      );
  const mountedModules = tools.moduleHost.snapshot().modules.map((module) => ({
    module_id: module.module_id,
    version: module.version,
    risk_level: module.risk_level,
    tool_names: module.tool_names,
  }));
  const agentResourceReasons = assertProductionAgentResourceSet(
    tools.agentAccessRuntime,
    mountedModules,
    tools.catalogGeneration!,
    readPreview ? "read-preview-caller" : "runtime-caller",
    readPreview ? "read_preview" : "t0",
  );
  const allowedOrigins = options.allowedOrigins ?? [];
  const allowedHosts = options.allowedHosts ?? [];
  const validSessionOwner = transportMode === "stateless" || (
    options.sessionOwnerId !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.sessionOwnerId)
  );
  const statelessSessionConfiguration = transportMode === "stateless" && (
    options.sessionBindingStore !== undefined ||
    options.sessionRegistry !== undefined ||
    options.sessionRegistryOptions !== undefined ||
    options.sessionOwnerId !== undefined
  );
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
    ...(statelessSessionConfiguration
      ? ["production_stateless_session_configuration_invalid"]
      : []),
    ...(verifierStatus.valid ? [] : [verifierStatus.reason]),
    ...(options.adapterSource === undefined
      ? []
      : ["production_non_t0_adapter_configured"]),
    ...(readPreview
      ? (workerStatus.valid ? [] : [workerStatus.reason])
      : (options.t1Worker === undefined
          ? []
          : ["production_t1_worker_configured_for_t0"])),
    ...agentResourceReasons,
  ];

  const readiness = async (): Promise<PlatformReadiness> => {
    const platformState = await platform.readiness();
    const reasons = [...platformState.reasons, ...structuralReasons];
    const liveChecks = [
      verifierStatus.valid ? checkProductionHealth(options.tokenVerifier!, verifierStatus.unhealthyReason) : null,
      readPreview && workerStatus.valid
        ? checkProductionHealth(options.t1Worker!, workerStatus.unhealthyReason)
        : null,
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
          transportMode,
          allowedOrigins,
          allowedHosts,
          authenticate: async (token) => {
            if (!isCompactJwt(token)) throw new AuthenticationError();
            const claims = await options.tokenVerifier!.verify(token);
            const identityAllowed = readPreview
              ? isExactReadPreviewServiceIdentity({
                  role: claims.actor_role,
                  roles: claims.roles,
                  scopes: claims.scopes,
                })
              : isExactT0ServiceIdentity({
                  role: claims.actor_role,
                  roles: claims.roles,
                  scopes: claims.scopes,
                });
            if (!identityAllowed) {
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
          ...(platform.dependencies.sessionRegistry === undefined
            ? {}
            : { sessionRegistry: platform.dependencies.sessionRegistry }),
          ...(platform.dependencies.sessionBindingStore === undefined
            ? {}
            : { sessionBindingStore: platform.dependencies.sessionBindingStore }),
          ...(transportMode === "stateless"
            ? {}
            : { sessionOwnerId: options.sessionOwnerId! }),
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
        ...(!readPreview || !workerStatus.valid
          ? []
          : [options.t1Worker!.close()]),
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
  dependencyName:
    | "production_token_verifier"
    | "production_adapter_source"
    | "production_t1_read_worker",
  expectedKind: "token_verifier" | "adapter_source" | "t1_read_worker",
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
    ((expectedKind === "adapter_source" || expectedKind === "t1_read_worker") &&
      !Object.hasOwn(record, "adapters"))
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
