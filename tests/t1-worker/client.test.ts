import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context.js";
import {
  createT1ReadWorkerClient,
} from "../../src/logistics_mcp/t1-worker/client.js";
import { buildT1WorkerEnvironment } from "../../src/logistics_mcp/t1-worker/environment.js";

const stub = resolve("test-fixtures/t1-worker-stub.mjs");
const context = parseExecutionContext({
  tenant_id: "tenant-a",
  actor_id: "service-a",
  actor_role: "service",
  roles: ["service"],
  scopes: ["tool:customs.ca.search"],
  client_id: "client-a",
  session_id: "session-a",
  expires_at: 1_900_000_000,
});

describe("T1 process worker client", () => {
  it("passes only reviewed configuration keys to the child process", () => {
    expect(buildT1WorkerEnvironment({
      PATH: "/untrusted/bin",
      DATABASE_URL: "postgres://secret",
      MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid",
      MCP_RISK_CUSTOMS_ENABLED: "true",
      MCP_RISK_CUSTOMS_AUTH_SECRET_FILE: "/run/secrets/riskcustoms",
    })).toStrictEqual({
      MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid",
      MCP_RISK_CUSTOMS_ENABLED: "true",
      MCP_RISK_CUSTOMS_AUTH_SECRET_FILE: "/run/secrets/riskcustoms",
    });
  });

  it("reads health and routes fixed adapter methods over bounded NDJSON", async () => {
    const client = createT1ReadWorkerClient({
      entryPoint: stub,
      environment: {},
      requestTimeoutMs: 2_000,
    });
    try {
      await expect(client.health()).resolves.toEqual({ ready: true });
      const result = await client.adapters.customs.search({}, context);
      expect(result.status).toBe("unavailable");
      expect(result.blockers?.map(({ code }) => code)).toContain(
        "stub.customs.ca.search",
      );
    } finally {
      await client.close();
    }
  });

  it("fails closed without an authenticated context", async () => {
    const client = createT1ReadWorkerClient({
      entryPoint: stub,
      environment: {},
      requestTimeoutMs: 2_000,
    });
    try {
      const result = await client.adapters.quote.calculate({});
      expect(result.status).toBe("blocked");
      expect(result.blockers?.map(({ code }) => code)).toContain(
        "t1_worker.execution_context_required",
      );
    } finally {
      await client.close();
    }
  });

  it("maps an exited child to unavailable without exposing process details", async () => {
    const client = createT1ReadWorkerClient({
      entryPoint: resolve("tests/fixtures/does-not-exist.mjs"),
      environment: {},
      requestTimeoutMs: 250,
    });
    try {
      await expect(client.health()).resolves.toEqual({ ready: false });
      const result = await client.adapters.customs.search({}, context);
      expect(result.status).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("does-not-exist");
    } finally {
      await client.close();
    }
  });

  it("kills an oversized response and maps it to unavailable", async () => {
    const client = createT1ReadWorkerClient({
      entryPoint: stub,
      environment: { T1_STUB_OVERSIZED: "true" },
      requestTimeoutMs: 2_000,
      maxResponseBytes: 512,
    });
    try {
      await expect(client.health()).resolves.toEqual({ ready: true });
      const result = await client.adapters.customs.search({}, context);
      expect(result.status).toBe("unavailable");
      expect(result.blockers?.map(({ code }) => code)).toContain(
        "t1_worker.unavailable",
      );
      await expect(client.health()).resolves.toEqual({ ready: false });
    } finally {
      await client.close();
    }
  });
});
