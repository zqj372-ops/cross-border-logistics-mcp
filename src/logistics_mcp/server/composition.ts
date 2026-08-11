import { AuthenticationError, type AuthClaims } from "../platform/context";
import {
  MemoryAuditRepository,
  type AuditRepository,
} from "../platform/audit";
import {
  MemoryIdempotencyRepository,
  type IdempotencyRepository,
} from "../platform/idempotency";
import {
  ExistingQuoteAdapter,
} from "../adapters/quote/existing-quote-adapter";
import { RiskCustomsAdapter } from "../adapters/customs/riskcustoms-adapter";
import { CuratedKnowledgeAdapter } from "../adapters/knowledge/curated-adapter";
import { SystemStatusAdapter } from "../adapters/status/system-status-adapter";
import { ManualTaskAdapter } from "../adapters/review/manual-task-adapter";
import {
  createFixtureAdapters,
  type FixtureAdapterOptions,
} from "../adapters/fixture-client";
import {
  createPhase1Bundle,
  type Phase1Bundle,
} from "../adapters/phase1-bundle";
import type { FixtureAdapters } from "../adapters/ports";
import {
  cargoToolContract,
  cargoToolHandler,
} from "../domains/cargo/tool";
import {
  containerPlanSummaryHandler,
  containerPlanSummaryToolContract,
} from "../domains/container/service";
import {
  createMcpHttpHandler,
  type McpHttpHandler,
  type McpHttpOptions,
} from "./http";
import {
  registerPhaseOneTools,
  type ToolContractMap,
  type ToolDefinition,
  type ToolHandlerMap,
} from "./tool-registry";

export type CompositionMode = "fixtures" | "production";

export interface GatewayCompositionOptions {
  readonly dataMode: CompositionMode;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly authenticate?: McpHttpOptions["authenticate"];
  readonly tokenPolicy?: McpHttpOptions["tokenPolicy"];
  readonly auditRepository?: AuditRepository;
  readonly idempotencyRepository?: IdempotencyRepository;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface FixtureCompositionOptions extends GatewayCompositionOptions {
  readonly dataMode: "fixtures";
  readonly customsFixture?: FixtureAdapterOptions["customsFixture"];
}

export interface ProductionCompositionOptions extends GatewayCompositionOptions {
  readonly dataMode: "production";
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
  readonly close: () => Promise<void>;
}

function failClosedAuthenticator(): AuthClaims {
  throw new AuthenticationError(
    "No production token verifier has been configured for this composition.",
  );
}

function productionAdapters(): FixtureAdapters {
  return {
    quote: new ExistingQuoteAdapter(),
    customs: new RiskCustomsAdapter(),
    knowledge: new CuratedKnowledgeAdapter(),
    status: new SystemStatusAdapter(),
    review: new ManualTaskAdapter(),
  };
}

function buildComposition(
  mode: CompositionMode,
  options: GatewayCompositionOptions,
  adapters: FixtureAdapters,
): GatewayComposition {
  if (options.dataMode !== mode) {
    throw new Error(
      `The ${mode} composition requires DATA_MODE=${mode}; received ${options.dataMode}.`,
    );
  }

  const bundle = createPhase1Bundle(adapters);
  const handlers: ToolHandlerMap = {
    ...bundle.handlers,
    "cargo.calculate": cargoToolHandler,
    "container.plan_summary": containerPlanSummaryHandler,
  };
  const contracts: ToolContractMap = {
    ...bundle.contracts,
    "cargo.calculate": cargoToolContract,
    "container.plan_summary": containerPlanSummaryToolContract,
  };
  const definitions = registerPhaseOneTools(handlers, contracts);
  const handler = createMcpHttpHandler({
    allowedOrigins: options.allowedOrigins ?? ["https://client.example.invalid"],
    allowedHosts: options.allowedHosts ?? ["mcp.example.invalid"],
    authenticate: options.authenticate ?? failClosedAuthenticator,
    ...(options.tokenPolicy === undefined ? {} : { tokenPolicy: options.tokenPolicy }),
    handlers,
    contracts,
    auditRepository: options.auditRepository ?? new MemoryAuditRepository(),
    idempotencyRepository:
      options.idempotencyRepository ?? new MemoryIdempotencyRepository(),
    maxBodyBytes: options.maxBodyBytes ?? 32 * 1024,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    requireHttps: true,
  });

  return {
    mode,
    dataMode: mode,
    adapters,
    bundle,
    handlers,
    contracts,
    definitions,
    handler,
    close: async () => {
      await handler.close();
    },
  };
}

export function createFixtureComposition(
  options: FixtureCompositionOptions,
): GatewayComposition {
  if (options.dataMode !== "fixtures") {
    throw new Error("Fixture adapters require DATA_MODE=fixtures.");
  }
  return buildComposition(
    "fixtures",
    options,
    createFixtureAdapters(
      options.customsFixture === undefined
        ? {}
        : { customsFixture: options.customsFixture },
    ),
  );
}

export function createProductionComposition(
  options: ProductionCompositionOptions,
): GatewayComposition {
  return buildComposition("production", options, productionAdapters());
}
