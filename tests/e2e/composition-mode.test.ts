import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client";
import { RiskCustomsApiAdapter } from "../../src/logistics_mcp/adapters/customs/riskcustoms-api-adapter";
import { QuoteApiAdapter } from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import { cargoToolHandler } from "../../src/logistics_mcp/domains/cargo/tool";
import { containerPlanSummaryHandler } from "../../src/logistics_mcp/domains/container/service";
import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import {
  createFixtureComposition,
  createProductionApiAdapterSource,
  createProductionComposition,
  type ProductionAdapterSource,
} from "../../src/logistics_mcp/server/composition";
import {
  createFixtureAuthenticatorFromEnvironment,
  initializeSqliteControlState,
  initializeSqlitePluginConfigState,
  startRuntime,
} from "../../src/logistics_mcp/server/start";
import { openSqliteControlStore } from "../../src/logistics_mcp/control-plane/sqlite-control-store";
import {
  cargoInput,
  containerInput,
  quoteInput,
} from "./fixtures/tenant-fixtures";
import { securityClaims } from "./fixtures/security-fixtures";
import { createAgentAccessRuntime } from "../../src/logistics_mcp/agent-context/runtime";
import { readFixedAgentStandardPack } from "../../src/logistics_mcp/agent-context/pack";

const API_DATE = "2026-08-12";
const API_TIME = `${API_DATE}T00:00:00.000Z`;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_INITIALIZER = resolve(
  REPOSITORY_ROOT,
  "deploy/scripts/init-control-fixture.mjs",
);
type FixtureInitializerModule = {
  readonly applicationRoot: () => string;
};
type ControlIdentityMarkerForTest = {
  readonly control_db_id: string;
  readonly control_db_path: string;
  readonly instance_id: string;
  readonly management_tenant_id: string;
  readonly marker_format: string;
  readonly schema_version: number;
};
type StartupMutationResult = {
  readonly startupRoot?: string;
  readonly cleanup?: () => void | Promise<void>;
};

const CONTROL_RUNTIME_ENV_NAMES = [
  "MCP_DATA_MODE",
  "MCP_ADMIN_CONTROL_ENABLED",
  "MCP_INSTANCE_ID",
  "MCP_ADMIN_TENANT_ID",
  "MCP_FIXTURE_TOKEN",
  "MCP_FIXTURE_APPROVER_TOKEN",
  "MCP_APPLICATION_ROOT",
  "MCP_RUNTIME_DIR",
  "MCP_STATE_DIR",
  "MCP_STATE_DB_PATH",
  "MCP_CONTROL_DB_PATH",
  "MCP_CONTROL_MARKER_PATH",
  "MCP_CONTROL_STATE_PATH",
] as const;

function fixedControlPaths(applicationRoot: string): {
  readonly runtimeDir: string;
  readonly stateDir: string;
  readonly controlDbPath: string;
  readonly markerPath: string;
} {
  const runtimeDir = resolve(applicationRoot, ".runtime");
  const stateDir = resolve(runtimeDir, "mcp-instance-state");
  return {
    runtimeDir,
    stateDir,
    controlDbPath: resolve(stateDir, "control.sqlite"),
    markerPath: resolve(stateDir, "control-identity.json"),
  };
}

function rewriteControlMarker(
  markerPath: string,
  patch: Partial<ControlIdentityMarkerForTest>,
): void {
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as ControlIdentityMarkerForTest;
  const replacement = { ...marker, ...patch };
  chmodSync(markerPath, 0o600);
  try {
    writeFileSync(markerPath, `${JSON.stringify(replacement)}\n`);
  } finally {
    chmodSync(markerPath, 0o400);
  }
}
const RISK_CUSTOMS_IDENTITY = {
  contractVersion: "riskcustoms-query.v1",
  serviceVersion: "riskcustoms-service.fixture-1",
  publishedAt: "2026-08-11T00:00:00.000Z",
  supportedOperations: ["status", "query"],
  ruleDate: API_DATE,
  releaseIds: ["release-ca-1"],
  snapshotHash: "a".repeat(64),
  releaseHash: "b".repeat(64),
};

const apiQuoteInput = quoteInput({
  effective_at: API_DATE,
  cargo: {
    ...(quoteInput().cargo as Record<string, unknown>),
    total_volume: { value: "1.25", unit: "cbm" },
  },
});

const customsSearchInput = {
  rule_date: API_DATE,
  query_kind: "name_search",
  query: "synthetic widget",
  product_attributes: { material: "synthetic", origin_country: "CN" },
  selected_hs6: null,
};

const freightcomInput = {
  schema_version: "2026-08-11.v1",
  version: "freightcom-ltl-rate-request@2026-08-26.v1",
  display_policy: "usd_numeric_relabel_test_only",
  details: {
    origin: {
      name: "Origin",
      address: {
        address_line_1: "1 Test Way",
        city: "Markham",
        region: "ON",
        country: "CA",
        postal_code: "L3R 8N4",
      },
    },
    destination: {
      name: "Destination",
      address: {
        address_line_1: "2 Test Way",
        city: "Montreal",
        region: "QC",
        country: "CA",
        postal_code: "H1H 1H1",
      },
      ready_at: { hour: 9, minute: 0 },
      ready_until: { hour: 17, minute: 0 },
      signature_requirement: "not-required",
    },
    expected_ship_date: { year: 2026, month: 8, day: 26 },
    packaging_type: "pallet",
    packaging_properties: {
      pallet_type: "ltl",
      pallets: [{
        measurements: {
          weight: { unit: "lb", value: "100" },
          cuboid: { unit: "in", l: "48", w: "40", h: "48" },
        },
        description: "Synthetic test freight",
        freight_class: "70",
        num_pieces: 1,
      }],
    },
  },
};

function serverContext(): ExecutionContext {
  return parseExecutionContext({
    ...securityClaims,
    scopes: [...securityClaims.scopes, "tariff:read"],
  });
}

function riskCustomsStatus(
  ready: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...RISK_CUSTOMS_IDENTITY,
    evaluatedAt: API_TIME,
    lastSourceCheckAt: ready ? API_TIME : null,
    ready,
    testData: false,
    reasons: ready ? [] : ["fixture_not_ready"],
    ...overrides,
  };
}

function riskCustomsSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "source-ca-1",
    releaseId: "release-ca-1",
    artifactId: "artifact-ca-1",
    authority: "official",
    dataset: "ca-tariff",
    edition: "fixture-edition",
    revision: "fixture-revision",
    officialUrl: "https://official.example.invalid/ca-tariff/release-ca-1",
    publishedAt: "2026-01-01",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    retrievedAt: API_TIME,
    sourceLocator: "fixture://riskcustoms/source-ca-1",
    ...overrides,
  };
}

function riskCustomsCandidate(
  country: "CN" | "US" | "CA",
  sourceId: string,
  code: string,
): Record<string, unknown> {
  const legalName = { language: "en", text: "Synthetic fixture", sourceId };
  return {
    candidateId: `candidate-${country}-${code}`,
    country,
    code,
    displayCode: code,
    codeDigits: code.length,
    parentCode: null,
    hierarchy: [{
      code,
      displayCode: code,
      codeDigits: code.length,
      legalNames: [legalName],
    }],
    legalNames: [legalName],
    chineseExplanation: {
      translationId: `translation-${country}-${code}`,
      text: "Synthetic fixture explanation",
      status: "machine",
      basedOnSourceIds: [sourceId],
    },
    classificationReason: "Synthetic classification reason",
    classificationSourceIds: [sourceId],
    status: "candidate",
    hs6: code.length === 6 ? code : null,
  };
}

function riskCustomsResult(
  country: "CN" | "US" | "CA",
  sourceId: string,
  code: string,
): Record<string, unknown> {
  return {
    ...riskCustomsCandidate(country, sourceId, code),
    rates: [],
    confirmedTotalPercent: null,
    documents: [],
    measures: [],
    warnings: [],
  };
}

function riskCustomsQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...RISK_CUSTOMS_IDENTITY,
    queryId: "query-fixture-1",
    mode: "name_search",
    ruleDate: API_DATE,
    selectedHs6: null,
    nextQuestion: null,
    candidates: [riskCustomsCandidate("CA", "source-ca-1", "123456")],
    results: [],
    sources: [riskCustomsSource()],
    dataStatus: riskCustomsStatus(true),
    testData: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function quoteApi(fetchImpl: FetchImplementation): QuoteApiAdapter {
  return new QuoteApiAdapter({
    baseUrl: "https://quote.example.invalid",
    allowedHosts: ["quote.example.invalid"],
    enabled: true,
    fetchImpl,
    clock: () => new Date(API_TIME),
    originByTenantWarehouse: {
      tenant_demo_a: { "fixture-warehouse": "toronto" },
    },
  });
}

type AuthorizationProvider = (
  context: ExecutionContext,
  signal?: AbortSignal,
) => string | Promise<string>;

function customsApi(
  fetchImpl: FetchImplementation,
  authorizationProvider: AuthorizationProvider = () => "m2m-test-value",
): RiskCustomsApiAdapter {
  return new RiskCustomsApiAdapter({
    baseUrl: "https://riskcustoms.example.invalid",
    allowedHosts: ["riskcustoms.example.invalid"],
    enabled: true,
    productionConnector: true,
    fetchImpl,
    authorizationProvider,
    clock: () => new Date(API_TIME),
  });
}

describe("gateway composition modes", () => {
  it("keeps Freightcom unavailable in a default fixture composition", async () => {
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    try {
      const definition = composition.definitions.find(
        (candidate) => candidate.name === "quote.freightcom_ltl.preview",
      );
      if (definition?.handler === undefined) throw new Error("Freightcom handler missing");

      const result = await definition.handler(freightcomInput, serverContext());

      expect(result.status).toBe("unavailable");
      expect(result.data).toBeNull();
      expect(result.blockers?.map((blocker) => blocker.code)).toContain(
        "freightcom.production_disabled",
      );
    } finally {
      await composition.close();
    }
  });

  it("keeps applicant and approver fixture claims distinct within one tenant", () => {
    const names = ["MCP_FIXTURE_TOKEN", "MCP_FIXTURE_APPROVER_TOKEN"] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.MCP_FIXTURE_TOKEN = "fixture-applicant-token";
      process.env.MCP_FIXTURE_APPROVER_TOKEN = "fixture-approver-token";
      const authenticate = createFixtureAuthenticatorFromEnvironment("tenant_fixture");
      const applicant = authenticate("fixture-applicant-token");
      const approver = authenticate("fixture-approver-token");

      expect(applicant).toMatchObject({
        tenant_id: "tenant_fixture",
        actor_id: "local_operator",
        actor_role: "admin",
        roles: ["admin"],
        scopes: ["platform:admin", "tenant:admin"],
        client_id: "local_fixture_applicant_client",
        session_id: "local_fixture_applicant_session",
      });
      expect(approver).toMatchObject({
        tenant_id: "tenant_fixture",
        actor_id: "local_approver",
        actor_role: "admin",
        roles: ["admin"],
        scopes: ["platform:admin", "tenant:admin"],
        client_id: "local_fixture_approver_client",
        session_id: "local_fixture_approver_session",
      });
      expect(new Set([applicant.actor_id, approver.actor_id]).size).toBe(2);
      expect(new Set([applicant.client_id, approver.client_id]).size).toBe(2);
      expect(new Set([applicant.session_id, approver.session_id]).size).toBe(2);
      expect(() => authenticate("unknown-fixture-token")).toThrow();
      process.env.MCP_FIXTURE_APPROVER_TOKEN = "fixture-applicant-token";
      expect(() => createFixtureAuthenticatorFromEnvironment("tenant_fixture")).toThrow();
      delete process.env.MCP_FIXTURE_APPROVER_TOKEN;
      expect(() => createFixtureAuthenticatorFromEnvironment("tenant_fixture")).toThrow();
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it.each([
    ["missing enabled gate", { MCP_ADMIN_CONTROL_ENABLED: undefined }],
    ["non-literal enabled gate", { MCP_ADMIN_CONTROL_ENABLED: "TRUE" }],
    ["missing instance id", {
      MCP_ADMIN_CONTROL_ENABLED: "true",
      MCP_INSTANCE_ID: undefined,
    }],
    ["missing management tenant id", {
      MCP_ADMIN_CONTROL_ENABLED: "true",
      MCP_ADMIN_TENANT_ID: undefined,
    }],
    ["caller path override", {
      MCP_ADMIN_CONTROL_ENABLED: "true",
      MCP_APPLICATION_ROOT: "/tmp/fixture-path-env-root",
    }],
    ["missing initialized state", { MCP_ADMIN_CONTROL_ENABLED: "true" }],
  ] as const)("does not call listen for %s", async (_label, overrides) => {
    const applicationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "logistics-mcp-startup-gate-")),
    );
    const previous = new Map(
      CONTROL_RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]]),
    );
    let listenCalls = 0;
    try {
      for (const name of CONTROL_RUNTIME_ENV_NAMES) delete process.env[name];
      process.env.MCP_DATA_MODE = "fixtures";
      process.env.MCP_INSTANCE_ID = "instance_fixture_001";
      process.env.MCP_ADMIN_TENANT_ID = "tenant_fixture";
      process.env.MCP_FIXTURE_TOKEN = "fixture-applicant-token";
      process.env.MCP_FIXTURE_APPROVER_TOKEN = "fixture-approver-token";
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }

      await expect(startRuntime({
        applicationRoot,
        listen: () => {
          listenCalls += 1;
          return Promise.resolve();
        },
      })).rejects.toThrow();
      expect(listenCalls).toBe(0);
      expect(existsSync(resolve(applicationRoot, ".runtime"))).toBe(false);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(applicationRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing transport mode", undefined, /MCP_TRANSPORT_MODE is required/],
    ["unknown transport mode", "auto", /must be stateless or stateful/],
  ] as const)("does not call listen for %s", async (_label, transportMode, expected) => {
    const applicationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "logistics-mcp-production-transport-gate-")),
    );
    const names = ["MCP_DATA_MODE", "MCP_TRANSPORT_MODE"] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    let listenCalls = 0;
    try {
      process.env.MCP_DATA_MODE = "production";
      if (transportMode === undefined) delete process.env.MCP_TRANSPORT_MODE;
      else process.env.MCP_TRANSPORT_MODE = transportMode;

      await expect(startRuntime({
        applicationRoot,
        listen: () => {
          listenCalls += 1;
          return Promise.resolve();
        },
      })).rejects.toThrow(expected);
      expect(listenCalls).toBe(0);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(applicationRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["state directory missing", (applicationRoot: string): StartupMutationResult | undefined => {
      rmSync(fixedControlPaths(applicationRoot).stateDir, { force: true, recursive: true });
      return undefined;
    }],
    ["marker missing", (applicationRoot: string): StartupMutationResult | undefined => {
      unlinkSync(fixedControlPaths(applicationRoot).markerPath);
      return undefined;
    }],
    ["database missing", (applicationRoot: string): StartupMutationResult | undefined => {
      unlinkSync(fixedControlPaths(applicationRoot).controlDbPath);
      return undefined;
    }],
    ["fresh database replacement", (applicationRoot: string): StartupMutationResult | undefined => {
      const { controlDbPath } = fixedControlPaths(applicationRoot);
      unlinkSync(controlDbPath);
      const replacement = new DatabaseSync(controlDbPath);
      replacement.close();
      chmodSync(controlDbPath, 0o600);
      return undefined;
    }],
    ["application root symlink", (applicationRoot: string): StartupMutationResult => {
      const symlinkPath = `${applicationRoot}-link`;
      symlinkSync(applicationRoot, symlinkPath, "dir");
      return {
        startupRoot: symlinkPath,
        cleanup: () => unlinkSync(symlinkPath),
      };
    }],
    ["state directory symlink", (applicationRoot: string): StartupMutationResult => {
      const { stateDir } = fixedControlPaths(applicationRoot);
      const symlinkTarget = mkdtempSync(join(tmpdir(), "logistics-mcp-state-target-"));
      rmSync(stateDir, { force: true, recursive: true });
      symlinkSync(symlinkTarget, stateDir, "dir");
      return {
        cleanup: () => {
          unlinkSync(stateDir);
          rmSync(symlinkTarget, { force: true, recursive: true });
        },
      };
    }],
    ["marker symlink", (applicationRoot: string): StartupMutationResult => {
      const { markerPath } = fixedControlPaths(applicationRoot);
      const symlinkTarget = `${markerPath}.target`;
      copyFileSync(markerPath, symlinkTarget);
      chmodSync(symlinkTarget, 0o400);
      unlinkSync(markerPath);
      symlinkSync(symlinkTarget, markerPath);
      return {
        cleanup: () => {
          unlinkSync(markerPath);
          unlinkSync(symlinkTarget);
        },
      };
    }],
    ["database symlink", (applicationRoot: string): StartupMutationResult => {
      const { controlDbPath } = fixedControlPaths(applicationRoot);
      const symlinkTarget = `${controlDbPath}.target`;
      copyFileSync(controlDbPath, symlinkTarget);
      chmodSync(symlinkTarget, 0o600);
      unlinkSync(controlDbPath);
      symlinkSync(symlinkTarget, controlDbPath);
      return {
        cleanup: () => {
          unlinkSync(controlDbPath);
          unlinkSync(symlinkTarget);
        },
      };
    }],
    ["control identity mismatch", (applicationRoot: string): StartupMutationResult | undefined => {
      rewriteControlMarker(
        fixedControlPaths(applicationRoot).markerPath,
        { control_db_id: `db_${"0".repeat(31)}1` },
      );
      return undefined;
    }],
    ["database identity mismatch", (applicationRoot: string): StartupMutationResult | undefined => {
      const { controlDbPath } = fixedControlPaths(applicationRoot);
      const database = new DatabaseSync(controlDbPath);
      try {
        database
          .prepare("UPDATE control_identity SET control_db_id = ?")
          .run(`db_${"0".repeat(31)}1`);
      } finally {
        database.close();
      }
      chmodSync(controlDbPath, 0o600);
      return undefined;
    }],
    ["instance mismatch", (applicationRoot: string): StartupMutationResult | undefined => {
      rewriteControlMarker(
        fixedControlPaths(applicationRoot).markerPath,
        { instance_id: "instance_other" },
      );
      return undefined;
    }],
    ["tenant mismatch", (applicationRoot: string): StartupMutationResult | undefined => {
      rewriteControlMarker(
        fixedControlPaths(applicationRoot).markerPath,
        { management_tenant_id: "tenant_other" },
      );
      return undefined;
    }],
    ["schema mismatch", (applicationRoot: string): StartupMutationResult | undefined => {
      const { controlDbPath } = fixedControlPaths(applicationRoot);
      const database = new DatabaseSync(controlDbPath);
      try {
        database.exec("PRAGMA user_version = 999");
      } finally {
        database.close();
      }
      chmodSync(controlDbPath, 0o600);
      return undefined;
    }],
    ["derived path mismatch", (applicationRoot: string): StartupMutationResult | undefined => {
      rewriteControlMarker(
        fixedControlPaths(applicationRoot).markerPath,
        { control_db_path: resolve(applicationRoot, ".runtime/other/control.sqlite") },
      );
      return undefined;
    }],
    ["exclusive lock conflict", (applicationRoot: string): StartupMutationResult => {
      const lockedStore = openSqliteControlStore({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: "tenant_fixture",
        adminControlEnabled: true,
      });
      return { cleanup: () => lockedStore.close() };
    }],
  ] as const)("fails closed before listen for %s", async (_label, mutate) => {
    const applicationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "logistics-mcp-startup-state-gate-")),
    );
    const previous = new Map(
      CONTROL_RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]]),
    );
    let mutationResult: StartupMutationResult | undefined;
    let listenCalls = 0;
    try {
      process.env.MCP_DATA_MODE = "fixtures";
      process.env.MCP_ADMIN_CONTROL_ENABLED = "true";
      process.env.MCP_INSTANCE_ID = "instance_fixture_001";
      process.env.MCP_ADMIN_TENANT_ID = "tenant_fixture";
      process.env.MCP_FIXTURE_TOKEN = "fixture-applicant-token";
      process.env.MCP_FIXTURE_APPROVER_TOKEN = "fixture-approver-token";
      for (const name of CONTROL_RUNTIME_ENV_NAMES) {
        if (name === "MCP_DATA_MODE" ||
            name === "MCP_ADMIN_CONTROL_ENABLED" ||
            name === "MCP_INSTANCE_ID" ||
            name === "MCP_ADMIN_TENANT_ID" ||
            name === "MCP_FIXTURE_TOKEN" ||
            name === "MCP_FIXTURE_APPROVER_TOKEN") {
          continue;
        }
        delete process.env[name];
      }
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: "tenant_fixture",
      });
      mutationResult = mutate(applicationRoot);

      await expect(startRuntime({
        applicationRoot: mutationResult?.startupRoot ?? applicationRoot,
        listen: () => {
          listenCalls += 1;
          return Promise.resolve();
        },
      })).rejects.toThrow();
      expect(listenCalls).toBe(0);
    } finally {
      await mutationResult?.cleanup?.();
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(applicationRoot, { force: true, recursive: true });
    }
  });

  it("does not treat an initialized sentinel as optional when managed identity env is removed", async () => {
    const applicationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "logistics-mcp-startup-identity-env-")),
    );
    const previous = new Map(
      CONTROL_RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]]),
    );
    let listenCalls = 0;
    try {
      for (const name of CONTROL_RUNTIME_ENV_NAMES) delete process.env[name];
      process.env.MCP_DATA_MODE = "fixtures";
      process.env.MCP_ADMIN_CONTROL_ENABLED = "true";
      process.env.MCP_INSTANCE_ID = "instance_fixture_001";
      process.env.MCP_ADMIN_TENANT_ID = "tenant_fixture";
      process.env.MCP_FIXTURE_TOKEN = "fixture-applicant-token";
      process.env.MCP_FIXTURE_APPROVER_TOKEN = "fixture-approver-token";
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: "tenant_fixture",
      });
      delete process.env.MCP_ADMIN_CONTROL_ENABLED;
      delete process.env.MCP_INSTANCE_ID;
      delete process.env.MCP_ADMIN_TENANT_ID;

      await expect(startRuntime({
        applicationRoot,
        listen: () => {
          listenCalls += 1;
          return Promise.resolve();
        },
      })).rejects.toThrow();
      expect(listenCalls).toBe(0);
      expect(existsSync(fixedControlPaths(applicationRoot).markerPath)).toBe(true);
      expect(existsSync(fixedControlPaths(applicationRoot).controlDbPath)).toBe(true);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(applicationRoot, { force: true, recursive: true });
    }
  });

  it("closes the initialized control store through one idempotent runtime close path", async () => {
    const applicationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "logistics-mcp-startup-close-")),
    );
    const names = [
      "MCP_DATA_MODE",
      "MCP_ADMIN_CONTROL_ENABLED",
      "MCP_INSTANCE_ID",
      "MCP_ADMIN_TENANT_ID",
      "MCP_FIXTURE_TOKEN",
      "MCP_FIXTURE_APPROVER_TOKEN",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    let reopened: ReturnType<typeof openSqliteControlStore> | undefined;
    try {
      process.env.MCP_DATA_MODE = "fixtures";
      process.env.MCP_ADMIN_CONTROL_ENABLED = "true";
      process.env.MCP_INSTANCE_ID = "instance_fixture_001";
      process.env.MCP_ADMIN_TENANT_ID = "tenant_fixture";
      process.env.MCP_FIXTURE_TOKEN = "fixture-applicant-token";
      process.env.MCP_FIXTURE_APPROVER_TOKEN = "fixture-approver-token";
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: "tenant_fixture",
      });
      await initializeSqlitePluginConfigState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: "tenant_fixture",
      });

      let listenCalls = 0;
      runtime = await startRuntime({
        applicationRoot,
        listen: async (server) => {
          listenCalls += 1;
          await new Promise<void>((resolvePromise, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolvePromise());
          });
        },
      });
      expect(listenCalls).toBe(1);
      await runtime.close();
      await runtime.close();

      reopened = openSqliteControlStore({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: "tenant_fixture",
        adminControlEnabled: true,
      });
      expect(await reopened.health()).toEqual({ ready: true });
    } finally {
      await reopened?.close().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(applicationRoot, { recursive: true, force: true });
    }
  });

  it("derives the fixture application root from the checked-in wrapper, independent of cwd or path env", async () => {
    const temporaryCwd = mkdtempSync(join(tmpdir(), "logistics-mcp-fixture-cwd-"));
    const pathEnvironment = {
      MCP_APPLICATION_ROOT: "/tmp/fixture-path-env-root",
      MCP_STATE_DIR: "/tmp/fixture-path-env-state",
      MCP_STATE_DB_PATH: "/tmp/fixture-path-env.sqlite",
      MCP_CONTROL_DB_PATH: "/tmp/fixture-path-env.sqlite",
      MCP_CONTROL_MARKER_PATH: "/tmp/fixture-path-env-marker.json",
    } as const;
    const previousCwd = process.cwd();
    const previousEnvironment = new Map(
      Object.keys(pathEnvironment).map((name) => [name, process.env[name]]),
    );

    try {
      process.chdir(temporaryCwd);
      for (const [name, value] of Object.entries(pathEnvironment)) {
        process.env[name] = value;
      }
      const initializer = (await import(
        pathToFileURL(FIXTURE_INITIALIZER).href,
      )) as FixtureInitializerModule;

      expect(initializer.applicationRoot()).toBe(REPOSITORY_ROOT);
    } finally {
      process.chdir(previousCwd);
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(temporaryCwd, { force: true, recursive: true });
    }
  });

  it("rejects every CLI argument so no caller-selected path can reach the initializer", () => {
    for (const args of [
      ["/tmp/fixture-path"],
      ["--root=/tmp/fixture-path"],
      ["--state-dir", "/tmp/fixture-path"],
      ["--db", "/tmp/fixture-path.sqlite"],
    ]) {
      const result = spawnSync(process.execPath, [FIXTURE_INITIALIZER, ...args], {
        cwd: "/tmp",
        env: {
          ...process.env,
          MCP_APPLICATION_ROOT: "/tmp/fixture-path-env-root",
          MCP_STATE_DIR: "/tmp/fixture-path-env-state",
          MCP_STATE_DB_PATH: "/tmp/fixture-path-env.sqlite",
          MCP_CONTROL_DB_PATH: "/tmp/fixture-path-env.sqlite",
          MCP_CONTROL_MARKER_PATH: "/tmp/fixture-path-env-marker.json",
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not accept command-line arguments");
    }
  });

  it("keeps fixture initialization and startup scripts explicit and path-free", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(REPOSITORY_ROOT, "package.json"), "utf8"),
    ) as {
      readonly scripts: Record<string, string>;
    };
    const gitignore = readFileSync(resolve(REPOSITORY_ROOT, ".gitignore"), "utf8");
    const initializerSource = readFileSync(FIXTURE_INITIALIZER, "utf8");
    const initScript = packageJson.scripts["init:control-fixture"];
    const startScript = packageJson.scripts["start:fixture"];

    expect(initScript).toBe(
      "npm run build && node deploy/scripts/init-control-fixture.mjs",
    );
    expect(startScript).toContain("MCP_ADMIN_CONTROL_ENABLED=true");
    expect(startScript).toContain("MCP_INSTANCE_ID=instance_fixture_001");
    expect(startScript).toContain("MCP_ADMIN_TENANT_ID=tenant_fixture");
    expect(startScript).toContain("MCP_FIXTURE_TOKEN=local-fixture-token");
    expect(startScript).not.toContain("init:control-fixture");
    expect(startScript).not.toMatch(
      /MCP_(?:APPLICATION_ROOT|RUNTIME_DIR|STATE_DIR|STATE_DB_PATH|CONTROL_DB_PATH|CONTROL_MARKER_PATH|CONTROL_STATE_PATH)=/,
    );
    expect(gitignore.split("\n")).toContain(".runtime/");
    expect(initializerSource).not.toContain("process.cwd");
    expect(initializerSource).not.toContain("process.env");
    expect(initializerSource).toContain("initializeSqliteControlState");
    expect(initializerSource).toContain("initializeSqliteTenantAccessState");
    expect(initializerSource).toContain("initializeSqlitePluginConfigState");
  });

  it("keeps source health local and omitted API adapters fail closed", async () => {
    const customsHealthFetch = vi.fn<FetchImplementation>();
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsHealthFetch),
    });

    await expect(source.health()).resolves.toEqual({ ready: true });
    expect(customsHealthFetch).not.toHaveBeenCalled();
    await source.close();

    const missing = createProductionApiAdapterSource();
    const context = serverContext();
    const [quote, customs] = await Promise.all([
      missing.adapters.quote.calculate(apiQuoteInput),
      missing.adapters.customs.search(customsSearchInput, context),
    ]);
    expect(quote.status).toBe("unavailable");
    expect(quote.blockers?.map(({ code }) => code)).toContain("quote.adapter_disabled");
    expect(customs.status).toBe("unavailable");
    expect(customs.blockers?.map(({ code }) => code)).toContain("customs.adapter_disabled");
    await missing.close();
  });

  it("keeps disabled quote local while local and customs handlers stay usable", async () => {
    const customsFetch = vi.fn<FetchImplementation>(() =>
      Promise.resolve(new Response(JSON.stringify(riskCustomsStatus(true)))),
    );
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsFetch),
    });
    const context = parseExecutionContext(securityClaims);
    const [quote, cargo, container, customs] = await Promise.all([
      source.adapters.quote.calculate(apiQuoteInput),
      cargoToolHandler(cargoInput(), context),
      containerPlanSummaryHandler(containerInput(), context),
      source.adapters.customs.getStatus({ rule_date: API_DATE }, context),
    ]);

    expect(quote.status).toBe("unavailable");
    expect(quote.blockers?.map(({ code }) => code)).toContain("quote.adapter_disabled");
    expect(cargo.status).toBe("success");
    expect(container.status).toBe("success");
    expect(customs.status).toBe("success");
    await source.close();
  });

  it("keeps RiskCustoms ready=false scoped while local handlers stay usable", async () => {
    const customsFetch = vi.fn<FetchImplementation>(() => Promise.resolve(jsonResponse({
      ...riskCustomsStatus(false),
      error: { code: "data_not_ready", message: "publication pending" },
    }, 503)));
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsFetch),
    });
    const context = parseExecutionContext(securityClaims);
    const [customs, quote, cargo, container] = await Promise.all([
      source.adapters.customs.search(customsSearchInput, context),
      source.adapters.quote.calculate(apiQuoteInput),
      cargoToolHandler(cargoInput(), context),
      containerPlanSummaryHandler(containerInput(), context),
    ]);

    expect(customs.status).toBe("unavailable");
    expect(customs.blockers?.map(({ code }) => code)).toContain("customs.ready_false");
    expect(customs.data).toMatchObject({
      data_status: {
        ready: false,
        test_data: false,
        release_ids: ["release-ca-1"],
      },
    });
    expect(customsFetch).toHaveBeenCalledTimes(1);
    expect(quote.status).toBe("unavailable");
    expect(quote.blockers?.map(({ code }) => code)).toContain("quote.adapter_disabled");
    expect(cargo.status).toBe("success");
    expect(container.status).toBe("success");
    await source.close();
  });

  it("constructs production as an exact T0 composition without Phase 1 adapters", async () => {
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "t0-v1",
    });

    try {
      expect(composition.definitions.map(({ name }) => name)).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "system.agent_context.get",
      ]);
      expect(composition.moduleHost.catalog.list().map(({ name }) => name)).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "system.agent_context.get",
      ]);
      expect(composition.moduleHost.snapshot().modules.map(({ module_id }) => module_id)).toEqual([
        "cargo",
        "container",
        "agent-access",
      ]);
      expect(composition.moduleHost.snapshot().modules.map(({ manifest_digest }) => manifest_digest)).toEqual([
        "sha256:8f1ae992488fe6283a84fd4478297e4772999f8224057c6e6838449ef186b91a",
        "sha256:72ab2ce602d646f2471d0a062b409f24c8f6e5c13c9b5ebc65f79334bda7d849",
        "sha256:a011e20c6f97c6026834bd0ff087c3c67d3ede7f9499beaf3da88f681d422b6b",
      ]);
      expect(composition.moduleHost.snapshot().modules.map(({ artifact_digest }) => artifact_digest)).toEqual([
        "sha256:f49982fdd8567627f6de5fd7e43fd98f9a43ee48401ebba2f9b273f4a1691b14",
        "sha256:3c50abba8b0f4b0f51f4dd6b12f664359df401fa9e63786bcf7edb0fc26bcd07",
        "sha256:490a40f175d6df1fe9469c15e75ed13ebdc3603249d66098e788365ed4a19c64",
      ]);
      const catalogGeneration = composition.catalogGeneration;
      if (catalogGeneration === undefined) throw new Error("catalog generation missing");
      expect(catalogGeneration.profile).toBe("t0-v1");
      expect(catalogGeneration.modules).toHaveLength(3);
      expect(catalogGeneration.resource_uris).toHaveLength(5);
      expect(catalogGeneration.prompt_names).toEqual([]);
      expect(Object.isFrozen(catalogGeneration)).toBe(true);
      const catalogResource = JSON.parse(composition.agentAccessRuntime.readResource(
        "logistics://modules/catalog",
        serverContext(),
      ).text) as Record<string, unknown>;
      expect(catalogResource).toMatchObject({
        schema_version: catalogGeneration.schema_version,
        profile: catalogGeneration.profile,
        catalog_generation: catalogGeneration.catalog_generation,
        catalog_digest: catalogGeneration.catalog_digest,
      });
      expect(Object.keys(composition.handlers).sort()).toEqual([
        "cargo.calculate",
        "container.plan_summary",
      ]);
      expect(Object.keys(composition.contracts).sort()).toEqual([
        "cargo.calculate",
        "container.plan_summary",
      ]);
      expect(Object.keys(composition.adapters)).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  it("fails readiness when Agent catalog readback does not match the mounted generation", async () => {
    const runtime = createAgentAccessRuntime({
      pack: readFixedAgentStandardPack(),
      catalogIdentity: {
        schema_version: "2026-09-02.v1",
        profile: "t0-v1",
        catalog_generation: `catalog_${"0".repeat(64)}`,
        catalog_digest: `sha256:${"0".repeat(64)}`,
      },
    });
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "t0-v1",
      agentAccessRuntime: runtime,
    });

    try {
      expect((await composition.readiness()).reasons).toContain(
        "t0_catalog_generation_mismatch",
      );
    } finally {
      await composition.close();
    }
  });

  it.each(["", "fixture-lab", "production", "unknown-profile"])(
    "fails closed for an invalid production profile %j",
    (profile) => {
      expect(() => createProductionComposition({
        dataMode: "production",
        profile,
      })).toThrow();
    },
  );

  it("passes server execution context to M2M and projects the CA result through the inclusive source date", async () => {
    const customsFetch = vi.fn<FetchImplementation>()
      .mockResolvedValueOnce(jsonResponse(riskCustomsStatus(true)))
      .mockResolvedValueOnce(jsonResponse(riskCustomsQuery({
        candidates: [
          riskCustomsCandidate("CN", "source-cn-1", "123456"),
          riskCustomsCandidate("US", "source-us-1", "234567"),
          riskCustomsCandidate("CA", "source-ca-candidate", "345678"),
        ],
        results: [{
          ...riskCustomsResult("CA", "source-ca-result", "345678"),
          status: "confirmed",
        }],
        sources: [
          riskCustomsSource({ id: "source-cn-1" }),
          riskCustomsSource({ id: "source-us-1" }),
          riskCustomsSource({ id: "source-ca-candidate" }),
          riskCustomsSource({ id: "source-ca-result", effectiveTo: API_DATE }),
        ],
      })));
    const authorizationProvider = vi.fn<AuthorizationProvider>(() => "m2m-test-value");
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsFetch, authorizationProvider),
    });
    const context = serverContext();

    const result = await source.adapters.customs.search(customsSearchInput, context);

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      jurisdiction: "CA",
      candidates: [{ hs_code: "345678", classification_status: "confirmed" }],
    });
    expect(result.sourceRefs).toHaveLength(3);
    expect(authorizationProvider).toHaveBeenCalledTimes(2);
    expect(authorizationProvider).toHaveBeenNthCalledWith(1, context, expect.any(AbortSignal));
    expect(authorizationProvider).toHaveBeenNthCalledWith(2, context, expect.any(AbortSignal));
    expect(customsFetch.mock.calls.map(([url, init]) => [init?.method, requestUrl(url)])).toEqual([
      ["GET", "https://riskcustoms.example.invalid/api/m2m/status?ruleDate=2026-08-12"],
      ["POST", "https://riskcustoms.example.invalid/api/m2m/query"],
    ]);
    for (const [, init] of customsFetch.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer m2m-test-value");
      expect(headers.get("x-tenant-id")).toBe(context.tenantId);
    }
    const queryBodyRaw = customsFetch.mock.calls[1]?.[1]?.body;
    if (typeof queryBodyRaw !== "string") throw new Error("M2M query body was not JSON text");
    const queryBody = JSON.parse(queryBodyRaw) as Record<string, unknown>;
    expect(queryBody).not.toHaveProperty("tenant_id");
    await source.close();
  });

  it("keeps a query 503 fail-closed after a ready status", async () => {
    const customsFetch = vi.fn<FetchImplementation>()
      .mockResolvedValueOnce(jsonResponse(riskCustomsStatus(true)))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: "data_not_ready", message: "query changed" },
      }, 503));
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsFetch),
    });

    const result = await source.adapters.customs.search(customsSearchInput, serverContext());

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map(({ code }) => code)).toContain("customs.query_unavailable");
    expect(JSON.stringify(result)).not.toContain("query changed");
    expect(customsFetch).toHaveBeenCalledTimes(2);
    await source.close();
  });

  it("keeps customs estimate unavailable without an HTTP call", async () => {
    const customsFetch = vi.fn<FetchImplementation>();
    const result = await customsApi(customsFetch).estimate({ rule_date: API_DATE }, serverContext());

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(customsFetch).not.toHaveBeenCalled();
  });

  it("does not expose or lifecycle-manage non-T0 adapters supplied to production", async () => {
    const quoteFetch = vi.fn<FetchImplementation>();
    const fixtureAdapters = createFixtureAdapters();
    let healthCalls = 0;
    let closeCalls = 0;
    const adapterSource: ProductionAdapterSource = {
      kind: "adapter_source",
      adapters: { ...fixtureAdapters, quote: quoteApi(quoteFetch) },
      health: () => {
        healthCalls += 1;
        return Promise.resolve({ ready: true });
      },
      close: () => {
        closeCalls += 1;
        return Promise.resolve();
      },
    };
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "t0-v1",
      adapterSource,
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => securityClaims,
    });

    try {
      expect(composition.definitions.map(({ name }) => name)).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "system.agent_context.get",
      ]);
      expect(Object.keys(composition.adapters)).toEqual([]);
      expect((await composition.readiness()).reasons).toContain(
        "production_non_t0_adapter_configured",
      );
      expect(healthCalls).toBe(0);
      expect(quoteFetch).not.toHaveBeenCalled();
    } finally {
      await composition.close();
    }
    expect(closeCalls).toBe(0);
  });

  it("keeps the production composition structurally limited to the reviewed T0 set", async () => {
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "t0-v1",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => securityClaims,
    });
    try {
      expect(composition.dataMode).toBe("production");
      expect(composition.definitions.map(({ name }) => name)).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "system.agent_context.get",
      ]);
      expect(composition.definitions.some(({ name }) => name.includes("quote"))).toBe(false);
      expect(composition.definitions.some(({ name }) => name.includes("customs"))).toBe(false);
      expect(composition.definitions.some(({ name }) => name.includes("review"))).toBe(false);
      expect(Object.keys(composition.adapters)).toEqual([]);
      expect(Object.keys(composition.handlers).sort()).toEqual([
        "cargo.calculate",
        "container.plan_summary",
      ]);
    } finally {
      await composition.close();
    }
  });

  it("does not allow fixture adapters under a production data mode", () => {
    expect(() =>
      createFixtureComposition({
        dataMode: "production",
      } as never),
    ).toThrow("Fixture adapters require DATA_MODE=fixtures.");
  });

  it("keeps the default production HTTP entrypoint fail-closed without a verifier", async () => {
    let authenticateCalls = 0;
    const composition = createProductionComposition({
      dataMode: "production",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => {
        authenticateCalls += 1;
        return securityClaims;
      },
    });
    try {
      const response = await composition.handler(
        new Request("https://mcp.example.invalid/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer fake-production-token",
            origin: "https://client.example.invalid",
          host: "mcp.example.invalid",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "fixture-client", version: "1.0.0" },
            },
          }),
        }),
      );
      expect(response.status).toBe(503);
      expect((await response.json()) as { status: string }).toMatchObject({ status: "unavailable" });
      expect(authenticateCalls).toBe(0);
    } finally {
      await composition.close();
    }
  });
});
