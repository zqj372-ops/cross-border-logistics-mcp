import { createServer } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";

import { cargoInput, containerInput } from "./fixtures/tenant-fixtures";

const INSTANCE_ID = "tenant-key-e2e-instance";
const MANAGEMENT_TENANT_ID = "tenant_management";
const ADMIN_TOKEN = "tenant-key-e2e-admin-token";
const APPROVER_TOKEN = "tenant-key-e2e-approver-token";
const TENANT_ID = "tenant_demo_a";
const SCHEMA_VERSION = "2026-08-27.v1";
const ENVELOPE_STATUSES = new Set<unknown>([
  "success",
  "needs_input",
  "manual_review",
  "blocked",
  "unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectEnvelopeStatus(value: unknown): void {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) throw new Error("missing structured envelope");
  expect(ENVELOPE_STATUSES.has(value.status)).toBe(true);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

function restoreEnvironment(values: ReadonlyMap<string, string | undefined>): void {
  for (const [name, value] of values) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function accessRequest(
  baseUrl: string,
  path: string,
  options: { readonly method?: "GET" | "POST"; readonly body?: unknown; readonly key?: string } = {},
): Promise<{ readonly response: Response; readonly payload: Record<string, unknown> }> {
  const method = options.method ?? "POST";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(method === "POST" ? {
        origin: baseUrl,
        "content-type": "application/json",
        "idempotency-key": options.key ?? "tenant-key-e2e-idempotency",
      } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  return {
    response,
    payload: await response.json() as Record<string, unknown>,
  };
}

describe("Tenant API key through the loopback fixture runtime", () => {
  it("issues once, authenticates MCP, redacts state, revokes, and then rejects the key", async () => {
    const applicationRoot = realpathSync(mkdtempSync(join(tmpdir(), "logistics-mcp-tenant-key-e2e-")));
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const environment = {
      MCP_DATA_MODE: "fixtures",
      MCP_PORT: String(port),
      MCP_ADMIN_UI_ENABLED: "true",
      MCP_ADMIN_CONTROL_ENABLED: "true",
      MCP_INSTANCE_ID: INSTANCE_ID,
      MCP_ADMIN_TENANT_ID: MANAGEMENT_TENANT_ID,
      MCP_FIXTURE_TOKEN: ADMIN_TOKEN,
      MCP_FIXTURE_APPROVER_TOKEN: APPROVER_TOKEN,
      MCP_ALLOWED_ORIGINS: baseUrl,
      MCP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      MCP_ALLOWED_OUTBOUND_HOSTS: "fixture.example.invalid",
      MCP_TRUSTED_PROXY_ADDRESSES: "",
      MCP_FREIGHTCOM_TEST_ENABLED: "false",
    } as const;
    const names = [
      ...Object.keys(environment),
      "MCP_APPLICATION_ROOT",
      "MCP_RUNTIME_DIR",
      "MCP_STATE_DIR",
      "MCP_STATE_DB_PATH",
      "MCP_CONTROL_DB_PATH",
      "MCP_CONTROL_MARKER_PATH",
      "MCP_CONTROL_STATE_PATH",
    ];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    let runtime: { readonly close: () => Promise<void> } | undefined;
    let client: Client | undefined;
    let pendingClient: Client | undefined;
    let rejectedClient: Client | undefined;
    try {
      for (const name of names) delete process.env[name];
      for (const [name, value] of Object.entries(environment)) process.env[name] = value;
      vi.resetModules();
      const start = await import("../../src/logistics_mcp/server/start");
      await start.initializeSqliteControlState({
        applicationRoot,
        instanceId: INSTANCE_ID,
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      await start.initializeSqliteTenantAccessState({
        applicationRoot,
        instanceId: INSTANCE_ID,
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      await start.initializeSqlitePluginConfigState({
        applicationRoot,
        instanceId: INSTANCE_ID,
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      runtime = await start.startRuntime({ applicationRoot });

      const created = await accessRequest(baseUrl, "/admin/api/v1/access/tenants", {
        key: "tenant-key-e2e-create-0001",
        body: {
          schema_version: SCHEMA_VERSION,
          tenant_id: TENANT_ID,
          display_name: "北美演示租户",
        },
      });
      expect(created.response.status).toBe(201);
      expect(created.payload).toMatchObject({ status: "success", data: { tenant: { tenant_id: TENANT_ID } } });

      const issued = await accessRequest(baseUrl, "/admin/api/v1/access/credentials", {
        key: "tenant-key-e2e-issue-0001",
        body: {
          schema_version: SCHEMA_VERSION,
          tenant_id: TENANT_ID,
          client_id: "codex_ops",
          label: "运营 Codex",
          tool_names: ["cargo.calculate"],
          expires_in_seconds: 86_400,
        },
      });
      expect(issued.response.status).toBe(201);
      const issueData = issued.payload.data as Record<string, unknown>;
      const apiKey = issueData.api_key;
      expect(apiKey).toMatch(/^lmcpk_[A-Za-z0-9._:-]+_[A-Za-z0-9_-]{43}$/u);
      if (typeof apiKey !== "string") throw new Error("missing one-time key");
      const issuedCredential = issueData.credential as Record<string, unknown>;
      const credentialId = issuedCredential.credential_id;
      if (typeof credentialId !== "string") throw new Error("missing credential id");
      expect(issuedCredential).toMatchObject({
        delivery_status: "pending",
        effective_status: "pending_delivery",
        allowed_actions: ["acknowledge_delivery", "revoke"],
      });

      pendingClient = new Client({ name: "tenant-key-pending", version: "1.0.0" });
      const pendingTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
      });
      await expect(pendingClient.connect(pendingTransport as Transport)).rejects.toThrow();
      await pendingClient.close().catch(() => undefined);
      pendingClient = undefined;

      const acknowledged = await accessRequest(
        baseUrl,
        `/admin/api/v1/access/credentials/${credentialId}/acknowledge-delivery`,
        {
          key: "tenant-key-e2e-ack-0001",
          body: {
            schema_version: SCHEMA_VERSION,
            reason_code: "operator_confirmed_secure_storage",
          },
        },
      );
      expect(acknowledged.response.status).toBe(200);
      expect(acknowledged.payload).toMatchObject({
        status: "success",
        data: {
          credential: {
            delivery_status: "acknowledged",
            effective_status: "active",
            allowed_actions: ["rotate", "revoke"],
          },
          operation: {
            action: "credential.delivery_acknowledge",
            from_status: "pending_delivery",
            to_status: "active",
            status: "success",
          },
        },
      });

      const replay = await accessRequest(baseUrl, "/admin/api/v1/access/credentials", {
        key: "tenant-key-e2e-issue-0001",
        body: {
          schema_version: SCHEMA_VERSION,
          tenant_id: TENANT_ID,
          client_id: "codex_ops",
          label: "运营 Codex",
          tool_names: ["cargo.calculate"],
          expires_in_seconds: 86_400,
        },
      });
      expect(replay.response.status).toBe(409);
      expect(replay.payload).toMatchObject({
        status: "manual_review",
        data: { api_key: null },
        secret_delivery: { status: "withheld", credential_id: credentialId },
      });

      const state = await accessRequest(baseUrl, "/admin/api/v1/access/state", { method: "GET" });
      expect(state.response.status).toBe(200);
      expect(JSON.stringify(state.payload)).not.toContain(apiKey);
      expect(JSON.stringify(state.payload)).not.toMatch(/secret_hash|secret_salt/u);
      expect(state.payload).toMatchObject({
        data: {
          credentials: [{ delivery_status: "acknowledged", effective_status: "active" }],
        },
      });
      const stateData = state.payload.data;
      expect(isRecord(stateData)).toBe(true);
      if (!isRecord(stateData) || !Array.isArray(stateData.operations)) throw new Error("missing operation readback");
      const operationActions = stateData.operations.map((value) => isRecord(value) ? value.action : null);
      expect(operationActions).toContain("credential.delivery_acknowledge");
      expect(operationActions).toContain("credential.issue");

      client = new Client({ name: "tenant-key-e2e", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
      });
      await client.connect(transport as Transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "cargo.calculate",
      ]);
      const cargo = await client.callTool({
        name: "cargo.calculate",
        arguments: cargoInput(),
      });
      expectEnvelopeStatus(cargo.structuredContent);
      await expect(client.callTool({
        name: "system.get_data_status",
        arguments: {},
      })).resolves.toMatchObject({ isError: true });
      await client.close();
      client = undefined;

      const rotated = await accessRequest(
        baseUrl,
        `/admin/api/v1/access/credentials/${credentialId}/rotate`,
        {
          key: "tenant-key-e2e-rotate-0001",
          body: {
            schema_version: SCHEMA_VERSION,
            tool_names: ["container.plan_summary"],
            expires_in_seconds: 86_400,
            reason_code: "operator_function_profile_changed",
          },
        },
      );
      expect(rotated.response.status).toBe(200);
      expect(rotated.payload).toMatchObject({
        status: "success",
        data: {
          credential: {
            tool_names: ["container.plan_summary"],
            effective_status: "pending_delivery",
          },
          operation: {
            action: "credential.rotate",
            from_status: "active",
            to_status: "pending_delivery",
          },
        },
      });
      const rotatedData = rotated.payload.data;
      if (!isRecord(rotatedData) || !isRecord(rotatedData.credential)) throw new Error("missing rotated credential");
      const rotatedApiKey = rotatedData.api_key;
      const rotatedCredentialId = rotatedData.credential.credential_id;
      if (typeof rotatedApiKey !== "string" || typeof rotatedCredentialId !== "string") {
        throw new Error("missing rotated secret metadata");
      }

      rejectedClient = new Client({ name: "tenant-key-rotated-old", version: "1.0.0" });
      let rejectedTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
      });
      await expect(rejectedClient.connect(rejectedTransport as Transport)).rejects.toThrow();
      await rejectedClient.close().catch(() => undefined);
      rejectedClient = undefined;

      pendingClient = new Client({ name: "tenant-key-rotated-pending", version: "1.0.0" });
      const rotatedPendingTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${rotatedApiKey}` } },
      });
      await expect(pendingClient.connect(rotatedPendingTransport as Transport)).rejects.toThrow();
      await pendingClient.close().catch(() => undefined);
      pendingClient = undefined;

      const rotatedAcknowledged = await accessRequest(
        baseUrl,
        `/admin/api/v1/access/credentials/${rotatedCredentialId}/acknowledge-delivery`,
        {
          key: "tenant-key-e2e-ack-0002",
          body: {
            schema_version: SCHEMA_VERSION,
            reason_code: "operator_confirmed_secure_storage",
          },
        },
      );
      expect(rotatedAcknowledged.response.status).toBe(200);

      client = new Client({ name: "tenant-key-rotated-active", version: "1.0.0" });
      const rotatedTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${rotatedApiKey}` } },
      });
      await client.connect(rotatedTransport as Transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "container.plan_summary",
      ]);
      const container = await client.callTool({
        name: "container.plan_summary",
        arguments: containerInput(),
      });
      expectEnvelopeStatus(container.structuredContent);
      await expect(client.callTool({
        name: "system.get_data_status",
        arguments: {},
      })).resolves.toMatchObject({ isError: true });
      await client.close();
      client = undefined;

      const rotatedState = await accessRequest(baseUrl, "/admin/api/v1/access/state", { method: "GET" });
      const rotatedStateData = rotatedState.payload.data;
      if (!isRecord(rotatedStateData) || !Array.isArray(rotatedStateData.credentials) || !Array.isArray(rotatedStateData.operations)) {
        throw new Error("missing rotated state readback");
      }
      expect(rotatedStateData.credentials).toEqual(expect.arrayContaining([
        expect.objectContaining({ credential_id: credentialId, effective_status: "revoked" }),
        expect.objectContaining({
          credential_id: rotatedCredentialId,
          tool_names: ["container.plan_summary"],
          effective_status: "active",
        }),
      ]));
      expect(rotatedStateData.operations).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "credential.rotate", credential_id: rotatedCredentialId }),
      ]));

      const revoked = await accessRequest(
        baseUrl,
        `/admin/api/v1/access/credentials/${rotatedCredentialId}/revoke`,
        {
          key: "tenant-key-e2e-revoke-0001",
          body: { schema_version: SCHEMA_VERSION, reason_code: "operator_revoked" },
        },
      );
      expect(revoked.response.status).toBe(200);
      expect(revoked.payload).toMatchObject({ status: "success", data: { credential: { status: "revoked" } } });

      rejectedClient = new Client({ name: "tenant-key-rejected", version: "1.0.0" });
      rejectedTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${rotatedApiKey}` } },
      });
      await expect(rejectedClient.connect(rejectedTransport as Transport)).rejects.toThrow();
    } finally {
      await client?.close().catch(() => undefined);
      await pendingClient?.close().catch(() => undefined);
      await rejectedClient?.close().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      restoreEnvironment(previous);
      rmSync(applicationRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
