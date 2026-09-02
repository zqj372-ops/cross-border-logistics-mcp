import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";

import type { AgentAccessRuntime } from "../../src/logistics_mcp/agent-context/runtime";
import { SqliteProductionStore } from "../../src/logistics_mcp/platform/sqlite-production-store";
import {
  createProductionComposition,
} from "../../src/logistics_mcp/server/composition";
import {
  closeRuntimeServer,
  createRuntimeServer,
} from "../../src/logistics_mcp/server/start";
import { createProductionTokenVerifier } from "../../src/logistics_mcp/server/production-token-verifier";
import { cargoInput } from "./fixtures/tenant-fixtures";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port unavailable");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error)),
  );
  return address.port;
}

function t0AgentAccessRuntime(): AgentAccessRuntime {
  const modules = [
    {
      module_id: "cargo",
      version: "2026-08-21.v0",
      risk_level: "T0",
      standard_ids: ["module-runtime.v0", "platform.contracts"],
      tool_names: ["cargo.calculate"],
    },
    {
      module_id: "container",
      version: "2026-08-21.v0",
      risk_level: "T0",
      standard_ids: ["module-runtime.v0", "platform.contracts"],
      tool_names: ["container.plan_summary"],
    },
    {
      module_id: "agent-access",
      version: "2026-08-21.v0",
      risk_level: "T0",
      standard_ids: ["module-runtime.v0", "platform.contracts", "agent-access.v0"],
      tool_names: ["system.agent_context.get"],
    },
  ];
  return {
    available: true,
    getContext: () => ({ status: "unavailable", data: null }),
    readResource: (uri) => {
      if (uri === "logistics://modules/catalog") {
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ modules }),
        };
      }
      if (uri === "logistics://agent/profiles") {
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            profiles: [{
              profile_id: "runtime-caller",
              audience: "caller",
              content_mode: "summary",
              allowed_module_ids: ["cargo", "container", "agent-access"],
            }],
          }),
        };
      }
      return {
        uri,
        mimeType: uri === "logistics://contracts/envelope/current"
          ? "text/markdown"
          : "application/json",
        text: "{}",
      };
    },
  };
}

describe("production platform runtime", () => {
  it("uses signed JWT, SQLite state and durable session binding through the official SDK", async () => {
    const directory = mkdtempSync(join(tmpdir(), "logistics-mcp-production-"));
    const store = new SqliteProductionStore(join(directory, "platform.sqlite"));
    const keys = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = {
      ...await exportJWK(keys.publicKey),
      alg: "RS256",
      kid: "production-test-key",
      use: "sig",
    };
    const verifier = createProductionTokenVerifier({
      jwksUrl: "https://identity.example.invalid/jwks",
      allowedHosts: ["identity.example.invalid"],
      fetchImpl: vi.fn(() => Promise.resolve(new Response(
        JSON.stringify({ keys: [publicJwk] }),
        { headers: { "content-type": "application/json" } },
      ))),
    });
    const port = await freePort();
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "t0-v1",
      transportMode: "stateful",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: [`127.0.0.1:${port}`],
      tokenPolicy: {
        issuer: "https://identity.example.invalid/",
        audience: "logistics-mcp",
      },
      tokenVerifier: verifier,
      auditRepository: store,
      idempotencyRepository: store,
      sessionBindingStore: store,
      sessionOwnerId: "production-test-worker",
      agentAccessRuntime: t0AgentAccessRuntime(),
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      tenant_id: "tenant_demo_a",
      actor_id: "service_demo",
      actor_role: "service",
      roles: ["service"],
      scopes: [
        "tool:cargo.calculate",
        "tool:container.plan_summary",
        "tool:system.agent_context.get",
      ],
      client_id: "codex-production-test",
      session_id: "auth-session-production-test",
    })
      .setProtectedHeader({ alg: "RS256", kid: "production-test-key" })
      .setIssuer("https://identity.example.invalid/")
      .setAudience("logistics-mcp")
      .setSubject("sales_demo")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    const broadAdminToken = await new SignJWT({
      tenant_id: "tenant_demo_a",
      actor_id: "admin_demo",
      actor_role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin"],
      client_id: "misconfigured-production-admin",
      session_id: "auth-session-broad-admin",
    })
      .setProtectedHeader({ alg: "RS256", kid: "production-test-key" })
      .setIssuer("https://identity.example.invalid/")
      .setAudience("logistics-mcp")
      .setSubject("admin_demo")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    const untrustedServer = createRuntimeServer(composition, {
      adminUi: { handle: () => false },
    });
    await new Promise<void>((resolve, reject) => {
      untrustedServer.once("error", reject);
      untrustedServer.listen(port, "127.0.0.1", resolve);
    });
    const direct = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "direct-spoof", version: "1.0.0" },
        },
      }),
    });
    expect(direct.status).toBe(400);
    await new Promise<void>((resolve, reject) =>
      untrustedServer.close((error) => error === undefined ? resolve() : reject(error)),
    );
    const server = createRuntimeServer(composition, {
      adminUi: { handle: () => false },
      trustedProxyAddresses: ["127.0.0.1"],
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const longKey = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer lmcpk_fixture_long_term_key",
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "long-key",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "long-key-spoof", version: "1.0.0" },
        },
      }),
    });
    expect(longKey.status).toBe(401);
    const broadAdmin = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${broadAdminToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "broad-admin",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "broad-admin", version: "1.0.0" },
        },
      }),
    });
    expect(broadAdmin.status).toBe(401);
    const client = new Client({ name: "production-runtime-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-proto": "https",
      } } },
    );

    try {
      await client.connect(transport as Transport);
      expect(transport.sessionId).toBeTruthy();
      expect(await store.get(transport.sessionId ?? "")).toMatchObject({
        tenantId: "tenant_demo_a",
        ownerId: "production-test-worker",
      });
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "system.agent_context.get",
      ]);
      const resources = (await client.listResources()).resources;
      expect(resources.map((resource) => resource.uri).sort()).toEqual([
        "logistics://agent/bootstrap",
        "logistics://agent/profiles",
        "logistics://contracts/envelope/current",
        "logistics://modules/catalog",
        "logistics://standards/index",
      ]);
      const result = await client.callTool({
        name: "cargo.calculate",
        arguments: cargoInput(),
      });
      expect(result.structuredContent).toMatchObject({ status: "success" });
      expect((await store.list()).some((event) => event.tool === "cargo.calculate")).toBe(true);
    } finally {
      await expect(Promise.race([
        closeRuntimeServer(server, composition).then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed_out"), 500)),
      ])).resolves.toBe("closed");
      await client.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses stateless Streamable HTTP without a session binding through the official SDK", async () => {
    const directory = mkdtempSync(join(tmpdir(), "logistics-mcp-stateless-production-"));
    const store = new SqliteProductionStore(join(directory, "platform.sqlite"));
    const keys = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = {
      ...await exportJWK(keys.publicKey),
      alg: "RS256",
      kid: "stateless-production-test-key",
      use: "sig",
    };
    const verifier = createProductionTokenVerifier({
      jwksUrl: "https://identity.example.invalid/jwks",
      allowedHosts: ["identity.example.invalid"],
      fetchImpl: vi.fn(() => Promise.resolve(new Response(
        JSON.stringify({ keys: [publicJwk] }),
        { headers: { "content-type": "application/json" } },
      ))),
    });
    const port = await freePort();
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "t0-v1",
      transportMode: "stateless",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: [`127.0.0.1:${port}`],
      tokenPolicy: {
        issuer: "https://identity.example.invalid/",
        audience: "logistics-mcp",
      },
      tokenVerifier: verifier,
      auditRepository: store,
      idempotencyRepository: store,
      agentAccessRuntime: t0AgentAccessRuntime(),
    });
    await expect(composition.readiness()).resolves.toEqual({ ready: true, reasons: [] });

    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      tenant_id: "tenant_demo_stateless",
      actor_id: "service_stateless",
      actor_role: "service",
      roles: ["service"],
      scopes: [
        "tool:cargo.calculate",
        "tool:container.plan_summary",
        "tool:system.agent_context.get",
      ],
      client_id: "codex-stateless-test",
      session_id: "auth-session-stateless-test",
    })
      .setProtectedHeader({ alg: "RS256", kid: "stateless-production-test-key" })
      .setIssuer("https://identity.example.invalid/")
      .setAudience("logistics-mcp")
      .setSubject("service_stateless")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    const server = createRuntimeServer(composition, {
      adminUi: { handle: () => false },
      trustedProxyAddresses: ["127.0.0.1"],
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const client = new Client({ name: "stateless-production-runtime-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-proto": "https",
      } } },
    );

    try {
      await client.connect(transport as Transport);
      expect(transport.sessionId).toBeUndefined();
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "system.agent_context.get",
      ]);
      expect((await client.listResources()).resources).toHaveLength(5);
      const result = await client.callTool({
        name: "cargo.calculate",
        arguments: cargoInput(),
      });
      expect(result.structuredContent).toMatchObject({ status: "success" });
      expect((await store.list()).some((event) => event.tool === "cargo.calculate")).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await closeRuntimeServer(server, composition);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
