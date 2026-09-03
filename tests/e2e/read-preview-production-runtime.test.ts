import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";

import type { AgentAccessRuntime } from "../../src/logistics_mcp/agent-context/runtime.js";
import { CANONICAL_AGENT_RESOURCES } from "../../src/logistics_mcp/agent-context/resources.js";
import type {
  AdapterResult,
  CustomsAdapter,
  FreightcomRatePort,
  QuoteAdapter,
} from "../../src/logistics_mcp/adapters/ports.js";
import {
  createReadPreviewCatalogGeneration,
  READ_PREVIEW_MODULE_DESCRIPTORS,
  READ_PREVIEW_MODULE_IDS,
  READ_PREVIEW_RESOURCE_URIS,
  READ_PREVIEW_TOOL_NAMES,
} from "../../src/logistics_mcp/module-runtime/index.js";
import { isTrustedExecutionContext } from "../../src/logistics_mcp/platform/context.js";
import { SqliteProductionStore } from "../../src/logistics_mcp/platform/sqlite-production-store.js";
import {
  createProductionComposition,
  type T1ReadWorker,
} from "../../src/logistics_mcp/server/composition.js";
import { createProductionTokenVerifier } from "../../src/logistics_mcp/server/production-token-verifier.js";
import {
  closeRuntimeServer,
  createRuntimeServer,
} from "../../src/logistics_mcp/server/start.js";
import { quoteInput } from "./fixtures/tenant-fixtures.js";

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

function unavailable(code: string): AdapterResult {
  return {
    status: "unavailable",
    data: null,
    sourceRefs: [],
    calculationTrace: [],
    blockers: [{ code, message: code, severity: "error", field: null }],
    reviewStatus: "manual_review",
  };
}

function readPreviewAgentAccessRuntime(): AgentAccessRuntime {
  const generation = createReadPreviewCatalogGeneration();
  const modules = READ_PREVIEW_MODULE_DESCRIPTORS.map((descriptor) => ({
    module_id: descriptor.module_id,
    version: descriptor.version,
    risk_level: descriptor.risk_level,
    standard_ids: descriptor.module_id === "agent-access"
      ? ["module-runtime.v0", "platform.contracts", "agent-access.v0"]
      : ["module-runtime.v0", "platform.contracts"],
    tool_names: descriptor.tool_names,
  }));
  return {
    available: true,
    getContext: () => unavailable("agent_context.not_called"),
    readResource: (uri) => {
      const resource = CANONICAL_AGENT_RESOURCES.find((candidate) => candidate.uri === uri);
      if (resource === undefined) throw new Error("unknown Agent resource");
      let text = "{}";
      if (uri === "logistics://modules/catalog") {
        text = JSON.stringify({
          schema_version: generation.schema_version,
          profile: generation.profile,
          catalog_generation: generation.catalog_generation,
          catalog_digest: generation.catalog_digest,
          modules,
        });
      } else if (uri === "logistics://agent/profiles") {
        text = JSON.stringify({
          profiles: [{
            profile_id: "read-preview-caller",
            audience: "caller",
            content_mode: "summary",
            allowed_module_ids: READ_PREVIEW_MODULE_IDS,
          }],
        });
      }
      return { uri, mimeType: resource.mimeType, text };
    },
  };
}

function t1Worker() {
  const quoteCalculate = vi.fn<QuoteAdapter["calculate"]>(
    () => Promise.resolve(unavailable("quote.preview_route_verified")),
  );
  const quote: QuoteAdapter = {
    calculate: quoteCalculate,
    previewDraft: () => Promise.resolve(unavailable("write.closed")),
    commitDraft: () => Promise.resolve(unavailable("write.closed")),
    readDraft: () => Promise.resolve(unavailable("write.closed")),
  };
  const customs: CustomsAdapter = {
    getStatus: () => Promise.resolve(unavailable("customs.not_called")),
    search: () => Promise.resolve(unavailable("customs.not_called")),
    estimate: () => Promise.resolve(unavailable("customs.estimate_unavailable")),
  };
  const freightcom: FreightcomRatePort = {
    requestRate: () => Promise.resolve(unavailable("freightcom.not_called")),
  };
  const worker: T1ReadWorker = {
    kind: "t1_read_worker",
    adapters: { quote, customs, freightcom },
    health: () => Promise.resolve({ ready: true }),
    close: () => Promise.resolve(),
  };
  return { worker, quoteCalculate };
}

describe("read-preview production runtime", () => {
  it("uses a short JWT to expose the exact catalog and route quote preview through T1", async () => {
    const directory = mkdtempSync(join(tmpdir(), "logistics-mcp-read-preview-"));
    const store = new SqliteProductionStore(join(directory, "platform.sqlite"));
    const keys = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = {
      ...await exportJWK(keys.publicKey),
      alg: "RS256",
      kid: "read-preview-test-key",
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
    const fixture = t1Worker();
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "read-preview-staging",
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
      t1Worker: fixture.worker,
      agentAccessRuntime: readPreviewAgentAccessRuntime(),
    });
    await expect(composition.readiness()).resolves.toEqual({ ready: true, reasons: [] });

    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      tenant_id: "tenant_read_preview",
      actor_id: "service_read_preview",
      actor_role: "service",
      roles: ["service"],
      scopes: READ_PREVIEW_TOOL_NAMES.map((name) => `tool:${name}`),
      client_id: "codex-read-preview-test",
      session_id: "auth-session-read-preview-test",
    })
      .setProtectedHeader({ alg: "RS256", kid: "read-preview-test-key" })
      .setIssuer("https://identity.example.invalid/")
      .setAudience("logistics-mcp")
      .setSubject("service_read_preview")
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
    const client = new Client({ name: "read-preview-runtime-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-proto": "https",
      } } },
    );

    try {
      await client.connect(transport as Transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        READ_PREVIEW_TOOL_NAMES,
      );
      expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual(
        READ_PREVIEW_RESOURCE_URIS,
      );

      const result = await client.callTool({
        name: "quote.canada_final_mile.calculate",
        arguments: quoteInput(),
      });
      expect(result.structuredContent).toMatchObject({
        status: "unavailable",
        blockers: [{ code: "quote.preview_route_verified" }],
      });
      expect(fixture.quoteCalculate).toHaveBeenCalledTimes(1);
      const calledContext = fixture.quoteCalculate.mock.calls[0]?.[1];
      expect(calledContext).toMatchObject({
        tenantId: "tenant_read_preview",
        actorId: "service_read_preview",
      });
      expect(isTrustedExecutionContext(calledContext)).toBe(true);
      expect((await store.list()).some(
        (event) => event.tool === "quote.canada_final_mile.calculate",
      )).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await closeRuntimeServer(server, composition);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
