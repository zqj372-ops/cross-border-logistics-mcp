import { createServer } from "node:http";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const CONTROL_SCHEMA_VERSION = "2026-08-22.v1";
const MANAGEMENT_TENANT_ID = "boundary-tenant";
const INSTANCE_ID = "boundary-instance-001";
const APPLICANT_TOKEN = "boundary-applicant-token";
const APPROVER_TOKEN = "boundary-approver-token";

const RUNTIME_ENV_NAMES = [
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
  if (typeof value !== "string") throw new Error(`${label} was not a string.`);
  return value;
}

async function freePort(): Promise<number> {
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
    throw new Error("The boundary test port was not allocated.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "logistics-mcp-boundary-")));
  const entry = lstatSync(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("The boundary test application root is not a real directory.");
  }
  return root;
}

function snapshotEnvironment(): ReadonlyMap<string, string | undefined> {
  return new Map<string, string | undefined>(
    RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]]),
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

function setEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const name of RUNTIME_ENV_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(environment)) {
    process.env[name] = value;
  }
}

async function withRuntime<T>(
  mode: "fixtures" | "production",
  callback: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const applicationRoot = makeApplicationRoot();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const productionDatabasePath = join(applicationRoot, "platform.sqlite");
  const environment: Record<string, string> = {
    MCP_PORT: String(port),
    MCP_DATA_MODE: mode,
    MCP_ADMIN_UI_ENABLED: "true",
    MCP_ALLOWED_ORIGINS: baseUrl,
    MCP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
  };
  if (mode === "fixtures") {
    Object.assign(environment, {
      MCP_ADMIN_CONTROL_ENABLED: "true",
      MCP_INSTANCE_ID: INSTANCE_ID,
      MCP_ADMIN_TENANT_ID: MANAGEMENT_TENANT_ID,
      MCP_FIXTURE_TOKEN: APPLICANT_TOKEN,
      MCP_FIXTURE_APPROVER_TOKEN: APPROVER_TOKEN,
    });
  } else {
    Object.assign(environment, {
      MCP_ADMIN_CONTROL_ENABLED: "true",
      MCP_INSTANCE_ID: INSTANCE_ID,
      MCP_ADMIN_TENANT_ID: MANAGEMENT_TENANT_ID,
      MCP_FIXTURE_TOKEN: APPLICANT_TOKEN,
      MCP_FIXTURE_APPROVER_TOKEN: APPROVER_TOKEN,
      MCP_STATE_DB_PATH: productionDatabasePath,
      MCP_JWT_ISSUER: "https://issuer.example.invalid/",
      MCP_JWT_AUDIENCE: "logistics-mcp-boundary",
      MCP_JWKS_URL: "https://jwks.example.invalid/.well-known/jwks.json",
      MCP_ALLOWED_OUTBOUND_HOSTS: "jwks.example.invalid",
      MCP_TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
    });
  }

  const previousEnvironment = snapshotEnvironment();
  let runtime: { readonly close: () => Promise<void> } | undefined;
  setEnvironment(environment);
  try {
    vi.resetModules();
    const startModule = await import("../../src/logistics_mcp/server/start");
    if (mode === "fixtures") {
      await startModule.initializeSqliteControlState({
        applicationRoot,
        instanceId: INSTANCE_ID,
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      await startModule.initializeSqlitePluginConfigState({
        applicationRoot,
        instanceId: INSTANCE_ID,
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
    }
    runtime = await startModule.startRuntime({ applicationRoot });
    expect(existsSync(productionDatabasePath)).toBe(mode === "production");
    return await callback(baseUrl);
  } finally {
    try {
      await runtime?.close();
    } finally {
      restoreEnvironment(previousEnvironment);
      rmSync(applicationRoot, { recursive: true, force: true });
    }
  }
}

describe("real HTTP module control-plane security boundaries", () => {
  it("blocks an applicant from self-approving and from publishing with that failed approval", async () => {
    await withRuntime("fixtures", async (baseUrl) => {
      const initialState = await requestJson(
        baseUrl,
        "/admin/api/v1/control/state",
        APPLICANT_TOKEN,
      );
      expect(initialState.response.status).toBe(200);
      const stateData = requiredRecord(initialState.body.data, "control state data");
      const inventoryModules = requiredRecordArray(
        stateData.inventory_modules,
        "inventory_modules",
      );
      const cargo = inventoryModules.find((module) => module.module_id === "cargo");
      if (cargo === undefined) throw new Error("The cargo inventory module is missing.");
      const version = requiredString(cargo.version, "cargo version");
      const descriptorDigest = requiredString(
        cargo.descriptor_digest,
        "cargo descriptor digest",
      );

      const registration = await requestJson(
        baseUrl,
        "/admin/api/v1/control/packages/register",
        APPLICANT_TOKEN,
        {
          method: "POST",
          idempotencyKey: "e2e-boundary-register-001",
          body: {
            schema_version: CONTROL_SCHEMA_VERSION,
            module_id: "cargo",
            version,
            descriptor_digest: descriptorDigest,
          },
        },
      );
      expect(registration.response.status).toBe(201);
      expect(registration.body.status).toBe("success");

      const preview = await requestJson(
        baseUrl,
        "/admin/api/v1/control/deployments/preview",
        APPLICANT_TOKEN,
        {
          method: "POST",
          idempotencyKey: "e2e-boundary-preview-001",
          body: {
            schema_version: CONTROL_SCHEMA_VERSION,
            intent: "change",
            desired_modules: [{
              module_id: "cargo",
              version,
              descriptor_digest: descriptorDigest,
            }],
          },
        },
      );
      expect(preview.response.status).toBe(200);
      expect(preview.body.status).toBe("success");
      const previewData = requiredRecord(preview.body.data, "preview data");
      expect(previewData.creator_actor_ref).toBe("local_operator");
      const previewRef = requiredString(previewData.preview_ref, "preview reference");

      const selfApproval = await requestJson(
        baseUrl,
        "/admin/api/v1/control/approvals",
        APPLICANT_TOKEN,
        {
          method: "POST",
          idempotencyKey: "e2e-boundary-self-approval-001",
          body: {
            schema_version: CONTROL_SCHEMA_VERSION,
            preview_ref: previewRef,
            decision: "approve",
            reason_code: "self-approval-attempt",
          },
        },
      );
      expect(selfApproval.response.status).toBe(403);
      expect(selfApproval.body).toMatchObject({
        schema_version: CONTROL_SCHEMA_VERSION,
        status: "blocked",
        data: null,
        reason_codes: ["approval_self_approval_forbidden"],
      });

      const failedApprovalPublish = await requestJson(
        baseUrl,
        "/admin/api/v1/control/deployments/publish",
        APPLICANT_TOKEN,
        {
          method: "POST",
          idempotencyKey: "e2e-boundary-self-publish-001",
          body: {
            schema_version: CONTROL_SCHEMA_VERSION,
            preview_ref: previewRef,
            approval_id: "approval-self-attempt-001",
          },
        },
      );
      expect(failedApprovalPublish.response.status).toBe(403);
      expect(failedApprovalPublish.body).toMatchObject({
        schema_version: CONTROL_SCHEMA_VERSION,
        status: "blocked",
        data: null,
        reason_codes: ["approval_not_found"],
      });

      const finalState = await requestJson(
        baseUrl,
        "/admin/api/v1/control/state",
        APPLICANT_TOKEN,
      );
      expect(finalState.response.status).toBe(200);
      expect(finalState.body.data).toMatchObject({
        kind: "control_state",
        activation: {
          state: "inactive",
          release_id: null,
          revision: 0,
          active_modules: [],
        },
        latest_preview: {
          preview_ref: previewRef,
          consumed: false,
        },
        latest_approval: null,
      });
    });
  });

  it("keeps every production Admin POST blocked despite bearer, body, idempotency, and enabling env values", async () => {
    await withRuntime("production", async (baseUrl) => {
      const paths = [
        "/admin/api/v1/control/packages/register",
        "/admin/api/v1/control/deployments/preview",
        "/admin/api/v1/control/approvals",
        "/admin/api/v1/control/deployments/publish",
        "/admin/api/v1/control/deployments/reconcile",
      ] as const;
      const tokens = [
        "arbitrary-bearer",
        APPLICANT_TOKEN,
        APPROVER_TOKEN,
        "different-bearer",
        "another-bearer",
      ] as const;

      const results: JsonResponse[] = [];
      for (const [index, path] of paths.entries()) {
        results.push(await requestJson(baseUrl, path, tokens[index]!, {
          method: "POST",
          idempotencyKey: `e2e-boundary-production-${index + 1}-001`,
          body: { arbitrary: `body-${index + 1}` },
        }));
      }

      expect(results.map((result) => result.response.status)).toEqual(
        paths.map(() => 403),
      );
      for (const result of results) {
        expect(result.response.status).toBe(403);
        expect(result.body).toMatchObject({
          schema_version: CONTROL_SCHEMA_VERSION,
          status: "blocked",
          data: null,
          reason_codes: ["admin_control_production_disabled_v1"],
        });
      }
    });
  });
});
