import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const CONTROL_SCHEMA_VERSION = "2026-08-22.v1";
const MANAGEMENT_TENANT_ID = "restart-e2e-tenant";
const INSTANCE_ID = "restart-e2e-instance-001";
const APPLICANT_TOKEN = "restart-e2e-applicant-token";
const APPROVER_TOKEN = "restart-e2e-approver-token";

const RUNTIME_ENVIRONMENT_NAMES = [
  "MCP_PORT",
  "MCP_DATA_MODE",
  "MCP_ADMIN_UI_ENABLED",
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
  "MCP_ALLOWED_ORIGINS",
  "MCP_ALLOWED_HOSTS",
  "MCP_ALLOWED_OUTBOUND_HOSTS",
  "MCP_TRUSTED_PROXY_ADDRESSES",
  "MCP_JWT_ISSUER",
  "MCP_JWT_AUDIENCE",
  "MCP_JWKS_URL",
] as const;

type JsonRecord = Record<string, unknown>;

interface JsonResponse {
  readonly response: Response;
  readonly body: JsonRecord;
}

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: JsonRecord;
  readonly idempotencyKey?: string;
}

interface ModuleRef {
  readonly module_id: string;
  readonly version: string;
  readonly descriptor_digest: string;
}

interface PublishedRelease {
  readonly releaseId: string;
  readonly moduleRef: ModuleRef;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) throw new Error(`${label} was not a JSON object.`);
  return value;
}

function requiredRecordArray(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value) || !value.every(isJsonRecord)) {
    throw new Error(`${label} was not an array of JSON objects.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was not a non-empty string.`);
  }
  return value;
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    throw new Error("A loopback port was not allocated.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function newLoopbackPort(previousPort?: number): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await allocateLoopbackPort();
    if (port !== previousPort) return port;
  }
  throw new Error("A distinct restart port was not allocated.");
}

async function requestJson(
  baseUrl: string,
  path: string,
  token: string,
  options: RequestOptions = {},
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      origin: baseUrl,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { "idempotency-key": options.idempotencyKey }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const parsed: unknown = await response.json();
  return {
    response,
    body: requiredRecord(parsed, `${path} response`),
  };
}

function makeApplicationRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "logistics-mcp-control-restart-")),
  );
  const entry = lstatSync(root);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    realpathSync(root) !== root ||
    (entry.mode & 0o777) !== 0o700
  ) {
    throw new Error("The restart application root is not a canonical private directory.");
  }
  return root;
}

function snapshotEnvironment(): ReadonlyMap<string, string | undefined> {
  return new Map<string, string | undefined>(
    RUNTIME_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]),
  );
}

function restoreEnvironment(
  previous: ReadonlyMap<string, string | undefined>,
): void {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function configureFixtureRuntime(port: number): string {
  for (const name of RUNTIME_ENVIRONMENT_NAMES) delete process.env[name];
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    MCP_PORT: String(port),
    MCP_DATA_MODE: "fixtures",
    MCP_ADMIN_UI_ENABLED: "false",
    MCP_ADMIN_CONTROL_ENABLED: "true",
    MCP_INSTANCE_ID: INSTANCE_ID,
    MCP_ADMIN_TENANT_ID: MANAGEMENT_TENANT_ID,
    MCP_FIXTURE_TOKEN: APPLICANT_TOKEN,
    MCP_FIXTURE_APPROVER_TOKEN: APPROVER_TOKEN,
    MCP_ALLOWED_ORIGINS: baseUrl,
    MCP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    MCP_TRUSTED_PROXY_ADDRESSES: "",
  } as const;
  for (const [name, value] of Object.entries(environment)) {
    process.env[name] = value;
  }
  return baseUrl;
}

async function getControlState(baseUrl: string): Promise<JsonRecord> {
  const state = await requestJson(
    baseUrl,
    "/admin/api/v1/control/state",
    APPLICANT_TOKEN,
  );
  expect(state.response.status).toBe(200);
  expect(state.body.status).toBe("success");
  return requiredRecord(state.body.data, "control state data");
}

async function publishVerifiedCargo(baseUrl: string): Promise<PublishedRelease> {
  const initialState = await getControlState(baseUrl);
  const inventory = requiredRecordArray(
    initialState.inventory_modules,
    "initial inventory_modules",
  );
  const cargo = inventory.find((module) => module.module_id === "cargo");
  if (cargo === undefined) throw new Error("The cargo inventory module is missing.");
  const moduleRef = {
    module_id: "cargo",
    version: requiredString(cargo.version, "cargo version"),
    descriptor_digest: requiredString(
      cargo.descriptor_digest,
      "cargo descriptor digest",
    ),
  } satisfies ModuleRef;
  expect(cargo).toMatchObject({
    ...moduleRef,
    evidence_level: "local_build",
    production_eligible: false,
  });

  const registration = await requestJson(
    baseUrl,
    "/admin/api/v1/control/packages/register",
    APPLICANT_TOKEN,
    {
      method: "POST",
      idempotencyKey: "restart-e2e-register-r1",
      body: {
        schema_version: CONTROL_SCHEMA_VERSION,
        ...moduleRef,
      },
    },
  );
  expect(registration.response.status).toBe(201);
  expect(registration.body.status).toBe("success");
  expect(registration.body.data).toMatchObject({
    kind: "registration",
    ...moduleRef,
    evidence_level: "local_build",
    production_eligible: false,
  });

  const preview = await requestJson(
    baseUrl,
    "/admin/api/v1/control/deployments/preview",
    APPLICANT_TOKEN,
    {
      method: "POST",
      idempotencyKey: "restart-e2e-preview-r1",
      body: {
        schema_version: CONTROL_SCHEMA_VERSION,
        intent: "change",
        desired_modules: [moduleRef],
      },
    },
  );
  expect(preview.response.status).toBe(200);
  expect(preview.body.status).toBe("success");
  const previewData = requiredRecord(preview.body.data, "preview data");
  const previewRef = requiredString(previewData.preview_ref, "preview_ref");

  const approval = await requestJson(
    baseUrl,
    "/admin/api/v1/control/approvals",
    APPROVER_TOKEN,
    {
      method: "POST",
      idempotencyKey: "restart-e2e-approval-r1",
      body: {
        schema_version: CONTROL_SCHEMA_VERSION,
        preview_ref: previewRef,
        decision: "approve",
        reason_code: "restart-e2e-approved",
      },
    },
  );
  expect(approval.response.status).toBe(200);
  expect(approval.body.status).toBe("success");
  const approvalData = requiredRecord(approval.body.data, "approval data");
  const approvalId = requiredString(approvalData.approval_id, "approval_id");

  const published = await requestJson(
    baseUrl,
    "/admin/api/v1/control/deployments/publish",
    APPLICANT_TOKEN,
    {
      method: "POST",
      idempotencyKey: "restart-e2e-publish-r1",
      body: {
        schema_version: CONTROL_SCHEMA_VERSION,
        preview_ref: previewRef,
        approval_id: approvalId,
      },
    },
  );
  expect(published.response.status).toBe(201);
  expect(published.body.status).toBe("success");
  const releaseData = requiredRecord(published.body.data, "published release data");
  const releaseId = requiredString(releaseData.release_id, "release_id");
  expect(releaseData).toMatchObject({
    kind: "release",
    release_id: releaseId,
    revision: 1,
    active_modules: [moduleRef],
  });
  expect(published.body.readback).toMatchObject({
    status: "verified",
    release_id: releaseId,
    revision: 1,
  });
  return { releaseId, moduleRef };
}

describe("module control-plane restart persistence over real HTTP", () => {
  it("restores a verified R1 on the same application root and a new port", async () => {
    const previousEnvironment = snapshotEnvironment();
    const applicationRoot = makeApplicationRoot();
    let runtime: { readonly close: () => Promise<void> } | undefined;
    try {
      const firstPort = await newLoopbackPort();
      const firstBaseUrl = configureFixtureRuntime(firstPort);
      vi.resetModules();
      const firstStartModule = await import("../../src/logistics_mcp/server/start");
      await firstStartModule.initializeSqliteControlState({
        applicationRoot,
        instanceId: INSTANCE_ID,
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      runtime = await firstStartModule.startRuntime({ applicationRoot });

      const published = await publishVerifiedCargo(firstBaseUrl);
      const stateBeforeClose = await getControlState(firstBaseUrl);
      const activationBeforeClose = structuredClone(
        requiredRecord(stateBeforeClose.activation, "activation before close"),
      );
      const readbackBeforeClose = structuredClone(
        requiredRecord(stateBeforeClose.latest_readback, "readback before close"),
      );
      const historyBeforeClose = structuredClone(
        requiredRecordArray(stateBeforeClose.release_history, "history before close"),
      );
      expect(activationBeforeClose).toEqual({
        state: "active",
        release_id: published.releaseId,
        revision: 1,
        active_modules: [published.moduleRef],
      });
      expect(readbackBeforeClose).toMatchObject({
        status: "verified",
        release_id: published.releaseId,
        revision: 1,
        applied_modules: [published.moduleRef],
        reason_codes: [],
      });
      expect(historyBeforeClose).toHaveLength(1);
      expect(historyBeforeClose[0]).toMatchObject({
        release_id: published.releaseId,
        revision: 1,
        desired_modules: [published.moduleRef],
        previous_release_id: null,
        status: "active_verified",
        intent: "change",
        reason_codes: [],
        superseded_by_release_id: null,
      });

      await runtime.close();
      runtime = undefined;

      const restartPort = await newLoopbackPort(firstPort);
      const restartBaseUrl = configureFixtureRuntime(restartPort);
      expect(restartPort).not.toBe(firstPort);
      vi.resetModules();
      const restartModule = await import("../../src/logistics_mcp/server/start");
      runtime = await restartModule.startRuntime({ applicationRoot });

      const restoredState = await getControlState(restartBaseUrl);
      expect(restoredState.activation).toEqual(activationBeforeClose);
      expect(restoredState.latest_readback).toEqual(readbackBeforeClose);
      expect(restoredState.release_history).toEqual(historyBeforeClose);

      const restoredInventory = requiredRecordArray(
        restoredState.inventory_modules,
        "restored inventory_modules",
      );
      expect(
        restoredInventory.find((module) => module.module_id === "cargo"),
      ).toMatchObject({
        ...published.moduleRef,
        evidence_level: "local_build",
        production_eligible: false,
      });
    } finally {
      try {
        await runtime?.close();
      } finally {
        restoreEnvironment(previousEnvironment);
        rmSync(applicationRoot, { recursive: true, force: true });
      }
    }
  });
});
