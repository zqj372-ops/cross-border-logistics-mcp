import { spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { readFileSync, realpathSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
  PLUGIN_CONFIG_SCHEMA_VERSION,
} from "../../src/logistics_mcp/control-plane/plugin-config-contracts";
import {
  initializeSqlitePluginConfigState,
  SqlitePluginConfigStore,
} from "../../src/logistics_mcp/control-plane/plugin-config-store";
import {
  initializeSqliteControlState,
  startRuntime,
} from "../../src/logistics_mcp/server/start";

const ROOT = resolve(import.meta.dirname, "../..");
const INITIALIZER = resolve(ROOT, "deploy/scripts/init-plugin-config-fixture.mjs");
const roots: string[] = [];

const ENVIRONMENT_NAMES = [
  "MCP_DATA_MODE",
  "MCP_ADMIN_UI_ENABLED",
  "MCP_ADMIN_CONTROL_ENABLED",
  "MCP_INSTANCE_ID",
  "MCP_ADMIN_TENANT_ID",
  "MCP_FIXTURE_TOKEN",
  "MCP_FIXTURE_APPROVER_TOKEN",
  "MCP_ALLOWED_ORIGINS",
  "MCP_ALLOWED_HOSTS",
  "MCP_ALLOWED_OUTBOUND_HOSTS",
  "MCP_FREIGHTCOM_TEST_ENABLED",
  "MCP_APPLICATION_ROOT",
  "MCP_RUNTIME_DIR",
  "MCP_STATE_DIR",
  "MCP_STATE_DB_PATH",
  "MCP_CONTROL_DB_PATH",
  "MCP_CONTROL_MARKER_PATH",
  "MCP_CONTROL_STATE_PATH",
  "MCP_PLUGIN_CONFIG_DB_PATH",
  "MCP_PLUGIN_CONFIG_MARKER_PATH",
  "MCP_PLUGIN_CONFIG_STATE_PATH",
] as const;

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test port.");
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error === undefined ? resolvePromise() : reject(error));
  });
  return address.port;
}

function changedValues() {
  return FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES.map((value) => (
    value.field_id === "request_timeout_ms" && value.kind === "integer"
      ? { ...value, value: 18_000 }
      : value
  ));
}

function postHeaders(origin: string, token: string, idempotencyKey: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    origin,
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function actorReference(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected an opaque actor reference.");
  return value;
}

describe("plugin configuration startup integration", () => {
  it("uses a fixed, argument-free initializer wrapper", () => {
    const source = readFileSync(INITIALIZER, "utf8");
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      readonly scripts: Record<string, string>;
    };
    expect(packageJson.scripts["init:plugin-config-fixture"]).toBe(
      "npm run build && node deploy/scripts/init-plugin-config-fixture.mjs",
    );
    expect(source).not.toContain("process.cwd");
    expect(source).not.toContain("process.env");
    expect(source).toContain("initializeSqlitePluginConfigState");

    const rejected = spawnSync(process.execPath, [INITIALIZER, "--root=/tmp/not-allowed"], {
      cwd: "/tmp",
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("does not accept command-line arguments");
  });

  it("starts with initialized plugin state and completes validate-preview-approve-publish-readback", async () => {
    const applicationRoot = realpathSync(mkdtempSync(join(tmpdir(), "mcp-plugin-config-startup-")));
    roots.push(applicationRoot);
    const previous = new Map(ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    let reopened: SqlitePluginConfigStore | undefined;
    try {
      for (const name of ENVIRONMENT_NAMES) delete process.env[name];
      process.env.MCP_DATA_MODE = "fixtures";
      process.env.MCP_ADMIN_UI_ENABLED = "false";
      process.env.MCP_ADMIN_CONTROL_ENABLED = "true";
      process.env.MCP_INSTANCE_ID = "instance_fixture_001";
      process.env.MCP_ADMIN_TENANT_ID = "tenant_fixture";
      process.env.MCP_FIXTURE_TOKEN = "fixture-applicant-token";
      process.env.MCP_FIXTURE_APPROVER_TOKEN = "fixture-approver-token";
      process.env.MCP_ALLOWED_ORIGINS = origin;
      process.env.MCP_ALLOWED_HOSTS = `127.0.0.1:${port}`;
      process.env.MCP_ALLOWED_OUTBOUND_HOSTS = "fixture.example.invalid";
      process.env.MCP_FREIGHTCOM_TEST_ENABLED = "false";

      const identity = {
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: "tenant_fixture",
      } as const;
      await initializeSqliteControlState(identity);
      await initializeSqlitePluginConfigState(identity);
      runtime = await startRuntime({
        applicationRoot,
        listen: (server) => new Promise<void>((resolvePromise, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolvePromise);
        }),
      });

      const stateResponse = await fetch(`${origin}/admin/api/v1/config/state`, {
        headers: { authorization: "Bearer fixture-applicant-token" },
      });
      expect(stateResponse.status).toBe(200);
      const initialState = await json(stateResponse);
      expect(initialState).toMatchObject({
        module_id: "freightcom-ltl",
        status: "active_verified",
        current: { revision: 0 },
      });
      expect(actorReference(initialState.actor_ref)).toMatch(/^actor_ref_[a-f0-9]{64}$/u);

      const draft = {
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        module_id: "freightcom-ltl",
        base_revision: 0,
        values: changedValues(),
      };
      const validationResponse = await fetch(`${origin}/admin/api/v1/config/drafts/validate`, {
        method: "POST",
        headers: postHeaders(origin, "fixture-applicant-token", "idempotency_start_validate_0001"),
        body: JSON.stringify(draft),
      });
      expect(validationResponse.status).toBe(200);
      expect(await json(validationResponse)).toMatchObject({
        status: "success",
        data: { kind: "config_validation", status: "validated" },
      });

      const previewResponse = await fetch(`${origin}/admin/api/v1/config/previews`, {
        method: "POST",
        headers: postHeaders(origin, "fixture-applicant-token", "idempotency_start_preview_0001"),
        body: JSON.stringify(draft),
      });
      expect(previewResponse.status).toBe(200);
      const preview = await json(previewResponse);
      expect(preview).toMatchObject({ status: "success", data: { kind: "config_preview" } });
      const previewRef = (preview.data as Record<string, unknown>).preview_ref;
      expect(typeof previewRef).toBe("string");

      const approverStateResponse = await fetch(`${origin}/admin/api/v1/config/state`, {
        headers: { authorization: "Bearer fixture-approver-token" },
      });
      expect(approverStateResponse.status).toBe(200);
      const approverState = await json(approverStateResponse);
      expect(approverState).toMatchObject({
        latest_preview: {
          preview_ref: previewRef,
        },
      });
      expect(approverState.allowed_actions).toContain("approve");
      const approverActorRef = actorReference(approverState.actor_ref);
      const creatorActorRef = actorReference(
        (approverState.latest_preview as Record<string, unknown>).creator_actor_ref,
      );
      expect(approverActorRef).toMatch(/^actor_ref_[a-f0-9]{64}$/u);
      expect(creatorActorRef).toMatch(/^actor_ref_[a-f0-9]{64}$/u);
      expect(approverActorRef).not.toBe(creatorActorRef);

      const approvalResponse = await fetch(`${origin}/admin/api/v1/config/approvals`, {
        method: "POST",
        headers: postHeaders(origin, "fixture-approver-token", "idempotency_start_approval_0001"),
        body: JSON.stringify({
          schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
          preview_ref: previewRef,
          decision: "approve",
          reason_code: "operator_approved",
        }),
      });
      expect(approvalResponse.status).toBe(200);
      const approval = await json(approvalResponse);
      expect(approval).toMatchObject({ status: "success", data: { kind: "config_approval" } });
      const approvalId = (approval.data as Record<string, unknown>).approval_id;
      expect(typeof approvalId).toBe("string");

      const publishResponse = await fetch(`${origin}/admin/api/v1/config/releases/publish`, {
        method: "POST",
        headers: postHeaders(origin, "fixture-applicant-token", "idempotency_start_publish_0001"),
        body: JSON.stringify({
          schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
          preview_ref: previewRef,
          approval_id: approvalId,
        }),
      });
      expect(publishResponse.status).toBe(201);
      expect(await json(publishResponse)).toMatchObject({
        status: "success",
        data: { kind: "config_release", revision: 1, status: "readback_verified" },
        readback: { status: "readback_verified", revision: 1 },
      });

      const updatedResponse = await fetch(`${origin}/admin/api/v1/config/state`, {
        headers: { authorization: "Bearer fixture-applicant-token" },
      });
      expect(updatedResponse.status).toBe(200);
      expect(await json(updatedResponse)).toMatchObject({
        status: "active_verified",
        current: { revision: 1 },
        latest_readback: { revision: 1, status: "readback_verified" },
      });

      const readiness = await fetch(`${origin}/readyz`);
      expect(readiness.status).toBe(503);
      const readinessBody = await json(readiness);
      expect(readinessBody).toMatchObject({ status: "not_ready" });
      expect(readinessBody.reasons).toContain("fixture_mode_not_production_ready");
      expect(readinessBody.reasons).not.toContain("plugin_config_store_unavailable");

      await runtime.close();
      runtime = undefined;
      reopened = new SqlitePluginConfigStore(identity);
      expect(reopened.health()).toEqual({ ready: true, reason_codes: [] });
    } finally {
      await reopened?.close().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
