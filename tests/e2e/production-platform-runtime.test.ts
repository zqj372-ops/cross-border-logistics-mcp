import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";

import { SqliteProductionStore } from "../../src/logistics_mcp/platform/sqlite-production-store";
import {
  createProductionApiAdapterSource,
  createProductionComposition,
} from "../../src/logistics_mcp/server/composition";
import {
  closeRuntimeServer,
  createRuntimeServer,
} from "../../src/logistics_mcp/server/start";
import { createProductionTokenVerifier } from "../../src/logistics_mcp/server/production-token-verifier";
import { cargoInput, quotePdfInput } from "./fixtures/tenant-fixtures";

const EXPECTED_TOOL_NAMES = [
  "cargo.calculate",
  "container.plan_summary",
  "customs.ca.estimate",
  "customs.ca.search",
  "knowledge.search_curated",
  "quote.canada_final_mile.calculate",
  "quote.create_pdf",
  "quote.save_draft",
  "review.create_task",
  "system.get_data_status",
].sort();

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
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: [`127.0.0.1:${port}`],
      tokenPolicy: {
        issuer: "https://identity.example.invalid/",
        audience: "logistics-mcp",
      },
      tokenVerifier: verifier,
      adapterSource: createProductionApiAdapterSource(),
      auditRepository: store,
      idempotencyRepository: store,
      sessionBindingStore: store,
      sessionOwnerId: "production-test-worker",
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      tenant_id: "tenant_demo_a",
      actor_id: "sales_demo",
      actor_role: "sales",
      roles: ["sales"],
      scopes: ["system:read", "quote:calculate", "quote:pdf_write"],
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
      expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual(EXPECTED_TOOL_NAMES);
      const unavailablePdf = await client.callTool({
        name: "quote.create_pdf",
        arguments: quotePdfInput("preview", "pdf_production_disabled_001"),
      });
      expect(unavailablePdf.structuredContent).toMatchObject({
        status: "unavailable",
        data: null,
      });
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
});
