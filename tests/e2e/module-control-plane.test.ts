import { createServer } from "node:http";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CONTROL_SCHEMA_VERSION = "2026-08-22.v1";
const MANAGEMENT_TENANT_ID = "e2e-tenant";
const INSTANCE_ID = "e2e-instance-001";
const APPLICANT_TOKEN = "e2e-applicant-token";
const APPROVER_TOKEN = "e2e-approver-token";

const MANAGED_ENVIRONMENT = {
  MCP_DATA_MODE: "fixtures",
  MCP_ADMIN_CONTROL_ENABLED: "true",
  MCP_INSTANCE_ID: INSTANCE_ID,
  MCP_ADMIN_TENANT_ID: MANAGEMENT_TENANT_ID,
  MCP_FIXTURE_TOKEN: APPLICANT_TOKEN,
  MCP_FIXTURE_APPROVER_TOKEN: APPROVER_TOKEN,
} as const;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture port was not allocated");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

type JsonRecord = Record<string, unknown>;

async function requestJson(
  baseUrl: string,
  path: string,
  token: string,
  options: {
    readonly method?: "GET" | "POST";
    readonly body?: JsonRecord;
    readonly idempotencyKey?: string;
  } = {},
): Promise<{ readonly response: Response; readonly body: JsonRecord }> {
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
  return {
    response,
    body: (await response.json()) as JsonRecord,
  };
}

function restoreEnvironment(
  previous: ReadonlyMap<string, string | undefined>,
): void {
  for (const [name, value] of previous) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function makeApplicationRoot(): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "logistics-mcp-control-"));
  const applicationRoot = realpathSync(temporaryRoot);
  const rootEntry = lstatSync(applicationRoot);
  expect(rootEntry.isDirectory()).toBe(true);
  expect(rootEntry.isSymbolicLink()).toBe(false);
  expect(realpathSync(applicationRoot)).toBe(applicationRoot);
  expect(rootEntry.mode & 0o777).toBe(0o700);
  return applicationRoot;
}

describe("module control plane over the fixture HTTP runtime", () => {
  it("registers, previews, approves, publishes and persists an active verified module", async () => {
    const applicationRoot = makeApplicationRoot();
    const port = await freePort();
    const allowedOrigin = `http://127.0.0.1:${port}`;
    const managedEnvironment = {
      ...MANAGED_ENVIRONMENT,
      MCP_PORT: String(port),
      MCP_ALLOWED_ORIGINS: allowedOrigin,
      MCP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    } as const;
    const previousEnvironment = new Map<string, string | undefined>(
      Object.keys(managedEnvironment).map((name) => [name, process.env[name]]),
    );
    const managedPathNames = [
      "MCP_APPLICATION_ROOT",
      "MCP_RUNTIME_DIR",
      "MCP_STATE_DIR",
      "MCP_STATE_DB_PATH",
      "MCP_CONTROL_DB_PATH",
      "MCP_CONTROL_MARKER_PATH",
      "MCP_CONTROL_STATE_PATH",
    ];
    for (const name of managedPathNames) {
      previousEnvironment.set(name, process.env[name]);
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(managedEnvironment)) {
      process.env[name] = value;
    }

    let runtime: { readonly close: () => Promise<void> } | undefined;
    try {
      const startModule = await import("../../src/logistics_mcp/server/start");
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
      runtime = await startModule.startRuntime({ applicationRoot });

      const baseUrl = allowedOrigin;
      const initialState = await requestJson(
        baseUrl,
        "/admin/api/v1/control/state",
        APPLICANT_TOKEN,
      );
      expect(initialState.response.status).toBe(200);
      expect(initialState.body.status).toBe("success");
      const initialData = initialState.body.data as JsonRecord;
      expect(initialData.kind).toBe("control_state");
      expect(initialData.activation).toEqual({
        state: "inactive",
        release_id: null,
        revision: 0,
        active_modules: [],
      });
      const inventoryModules = initialData.inventory_modules as JsonRecord[];
      const cargo = inventoryModules.find((module) => module.module_id === "cargo");
      expect(cargo).toMatchObject({
        module_id: "cargo",
        version: "2026-08-21.v0",
        evidence_level: "local_build",
        production_eligible: false,
      });
      const descriptorDigest = cargo?.descriptor_digest;
      expect(descriptorDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

      const registration = await requestJson(
        baseUrl,
        "/admin/api/v1/control/packages/register",
        APPLICANT_TOKEN,
        {
          method: "POST",
          idempotencyKey: "e2e-register-cargo-001",
          body: {
            schema_version: CONTROL_SCHEMA_VERSION,
            module_id: "cargo",
            version: "2026-08-21.v0",
            descriptor_digest: descriptorDigest,
          },
        },
      );
      expect(registration.response.status).toBe(201);
      expect(registration.body.status).toBe("success");
      expect(registration.body.data).toMatchObject({
        kind: "registration",
        module_id: "cargo",
        version: "2026-08-21.v0",
        descriptor_digest: descriptorDigest,
        evidence_level: "local_build",
        production_eligible: false,
      });

      const preview = await requestJson(
        baseUrl,
        "/admin/api/v1/control/deployments/preview",
        APPLICANT_TOKEN,
        {
          method: "POST",
          idempotencyKey: "e2e-preview-cargo-001",
          body: {
            schema_version: CONTROL_SCHEMA_VERSION,
            intent: "change",
            desired_modules: [
              {
                module_id: "cargo",
                version: "2026-08-21.v0",
                descriptor_digest: descriptorDigest,
              },
            ],
          },
        },
      );
      expect(preview.response.status).toBe(200);
      expect(preview.body.status).toBe("success");
      expect(preview.body.data).toMatchObject({
        kind: "preview",
        intent: "change",
        base_release_id: null,
        base_revision: 0,
        desired_modules: [
          {
            module_id: "cargo",
            version: "2026-08-21.v0",
            descriptor_digest: descriptorDigest,
          },
        ],
        validation: {
          base_matches: true,
          desired_modules_valid: true,
          inventory_matches: true,
          minimum_active_modules: true,
          reason_codes: [],
        },
        consumed: false,
      });
      const previewData = preview.body.data as JsonRecord;
      const previewRef = previewData.preview_ref;
      expect(previewRef).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

      const approval = await requestJson(
        baseUrl,
        "/admin/api/v1/control/approvals",
        APPROVER_TOKEN,
        {
          method: "POST",
          idempotencyKey: "e2e-approval-cargo-001",
          body: {
            schema_version: CONTROL_SCHEMA_VERSION,
            preview_ref: previewRef,
            decision: "approve",
            reason_code: "e2e-approved",
          },
        },
      );
      expect(approval.response.status).toBe(200);
      expect(approval.body.status).toBe("success");
      expect(approval.body.data).toMatchObject({
        kind: "approval",
        preview_ref: previewRef,
        decision: "approve",
      });
      const approvalData = approval.body.data as JsonRecord;
      const approvalId = approvalData.approval_id;
      expect(approvalId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

      const published = await requestJson(
        baseUrl,
        "/admin/api/v1/control/deployments/publish",
        APPLICANT_TOKEN,
        {
          method: "POST",
          idempotencyKey: "e2e-publish-cargo-001",
          body: {
            schema_version: CONTROL_SCHEMA_VERSION,
            preview_ref: previewRef,
            approval_id: approvalId,
          },
        },
      );
      expect(published.response.status).toBe(201);
      expect(published.body.status).toBe("success");
      expect(published.body.readback).toMatchObject({
        status: "verified",
      });
      expect(published.body.data).toMatchObject({
        kind: "release",
        revision: 1,
        active_modules: [
          {
            module_id: "cargo",
            version: "2026-08-21.v0",
            descriptor_digest: descriptorDigest,
          },
        ],
      });
      const publishedData = published.body.data as JsonRecord;
      const releaseId = publishedData.release_id;
      expect(releaseId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
      expect(published.body.readback).toMatchObject({
        release_id: releaseId,
        revision: 1,
      });

      const persistedState = await requestJson(
        baseUrl,
        "/admin/api/v1/control/state",
        APPLICANT_TOKEN,
      );
      expect(persistedState.response.status).toBe(200);
      expect(persistedState.body.status).toBe("success");
      expect(persistedState.body.data).toMatchObject({
        kind: "control_state",
        activation: {
          state: "active",
          release_id: releaseId,
          revision: 1,
          active_modules: [
            {
              module_id: "cargo",
              version: "2026-08-21.v0",
              descriptor_digest: descriptorDigest,
            },
          ],
        },
        latest_preview: {
          preview_ref: previewRef,
          intent: "change",
          consumed: true,
        },
        latest_approval: {
          approval_id: approvalId,
          preview_ref: previewRef,
          decision: "approve",
          consumed: true,
        },
        latest_readback: {
          status: "verified",
          release_id: releaseId,
          revision: 1,
        },
        release_history: [
          {
            release_id: releaseId,
            revision: 1,
            status: "active_verified",
            intent: "change",
          },
        ],
      });
      const persistedData = persistedState.body.data as JsonRecord;
      const persistedInventory = persistedData.inventory_modules as JsonRecord[];
      expect(
        persistedInventory.find((module) => module.module_id === "cargo"),
      ).toMatchObject({
        module_id: "cargo",
        registration: {
          registered_by_actor_ref: "local_operator",
        },
      });
    } finally {
      await runtime?.close();
      restoreEnvironment(previousEnvironment);
      rmSync(applicationRoot, { recursive: true, force: true });
    }
  });

});
