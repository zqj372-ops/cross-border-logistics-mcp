import { describe, expect, it } from "vitest";

import {
  assertAllowedOutboundUrl,
  assertTenantScope,
  redactSecurityError,
  validateShortLivedToken,
} from "../../src/logistics_mcp/platform/security";
import { createFetchJsonClient } from "../../src/logistics_mcp/adapters/http-client";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { MemoryAuditRepository } from "../../src/logistics_mcp/platform/audit";
import { MemoryIdempotencyRepository } from "../../src/logistics_mcp/platform/idempotency";
import { SessionRuntimeRegistry } from "../../src/logistics_mcp/platform/session-runtime";
import { createMcpHttpHandler } from "../../src/logistics_mcp/server/http";
import { securityClaims, fakeJwtClaims } from "./fixtures/security-fixtures";

function makeSecurityHandler(
  overrides: Partial<Parameters<typeof createMcpHttpHandler>[0]> = {},
) {
  return createMcpHttpHandler({
    allowedOrigins: ["https://client.example.invalid"],
    allowedHosts: ["mcp.example.invalid"],
    authenticate: () => securityClaims,
    auditRepository: new MemoryAuditRepository(),
    idempotencyRepository: new MemoryIdempotencyRepository(),
    sessionRegistry: new SessionRuntimeRegistry({
      idleTtlMs: 60_000,
      maxLifetimeMs: 60_000,
      maxTokenLifetimeMs: 60_000,
      maxSessions: 16,
    }),
    ...overrides,
  });
}

describe("integration security gates", () => {
  it("requires issuer, audience, subject, tenant, role, iat and exp for short-lived claims", () => {
    expect(validateShortLivedToken(fakeJwtClaims, {
      issuer: fakeJwtClaims.iss,
      audience: fakeJwtClaims.aud,
      nowSeconds: Math.floor(Date.now() / 1000),
    })).toMatchObject({ sub: "sales_demo", tenant_id: "tenant_demo_a" });
    expect(() => validateShortLivedToken({ ...fakeJwtClaims, iss: "https://evil.example.invalid/" }, {
      issuer: fakeJwtClaims.iss,
      audience: fakeJwtClaims.aud,
    })).toThrow(/issuer/i);
    expect(() => validateShortLivedToken({ ...fakeJwtClaims, exp: 1 }, {
      issuer: fakeJwtClaims.iss,
      audience: fakeJwtClaims.aud,
    })).toThrow(/expired/i);
  });

  it("denies cross-tenant target scope", () => {
    const context = parseExecutionContext(securityClaims);
    expect(() => assertTenantScope(context, "tenant_demo_b")).toThrow(/tenant/i);
  });

  it("rejects private, link-local, loopback, redirect-prone and non-allowlisted outbound URLs", () => {
    const allowed = ["riskcustoms.example.invalid"];
    expect(assertAllowedOutboundUrl("https://riskcustoms.example.invalid/api/status", allowed)).toBe(true);
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "https://127.0.0.1/internal",
      "https://[::1]/internal",
      "https://10.0.0.1/internal",
      "https://evil.example.invalid/redirect",
    ]) {
      expect(() => assertAllowedOutboundUrl(url, allowed)).toThrow();
    }
  });

  it("enforces the same outbound policy through the real fetch client path", async () => {
    let fetchCalls = 0;
    const client = createFetchJsonClient({
      baseUrl: "https://quote.example.invalid",
      allowedHosts: ["quote.example.invalid", "127.0.0.1", "[::1]"],
      enabled: true,
      fetchImpl: () => {
        fetchCalls += 1;
        return Promise.resolve(new Response("{}"));
      },
    });

    await expect(client.get("https://127.0.0.1/internal")).rejects.toMatchObject({
      code: "upstream_host_not_allowed",
    });
    expect(fetchCalls).toBe(0);
    expect(() =>
      createFetchJsonClient({
        baseUrl: "https://[::1]/",
        allowedHosts: ["[::1]"],
        enabled: true,
      }),
    ).toThrow(/host|private|loopback|link-local/i);
  });

  it("redacts bearer, API key, customer address, quote amount and tax material from errors", () => {
    const redacted = redactSecurityError(new Error(
      "Bearer real-token api_key=real-key address=123 Main Street quote_amount=999.99 tax_document=secret.pdf",
    ));
    expect(redacted).not.toMatch(/real-token|real-key|123 Main Street|999\.99|secret\.pdf/);
  });

  it("applies issuer and audience policy at the HTTP authentication boundary", async () => {
    const claims = { ...fakeJwtClaims, ...securityClaims };
    const handle = makeSecurityHandler({
      authenticate: () => claims,
      tokenPolicy: {
        issuer: fakeJwtClaims.iss,
        audience: fakeJwtClaims.aud,
        nowSeconds: Math.floor(Date.now() / 1000),
      },
    });
    try {
      const response = await handle(new Request("https://mcp.example.invalid/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer verified-fixture-token",
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
              clientInfo: { name: "security-fixture", version: "1.0.0" },
            },
        }),
      }));
      expect(response.status).toBe(200);

      const rejected = makeSecurityHandler({
        authenticate: () => ({ ...claims, iss: "https://evil.example.invalid/" }),
        tokenPolicy: {
          issuer: fakeJwtClaims.iss,
          audience: fakeJwtClaims.aud,
        },
      });
      try {
        const rejectedResponse = await rejected(new Request("https://mcp.example.invalid/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer verified-fixture-token",
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
              clientInfo: { name: "security-fixture", version: "1.0.0" },
            },
          }),
        }));
        expect(rejectedResponse.status).toBe(401);
      } finally {
        await rejected.close();
      }
    } finally {
      await handle.close();
    }
  });

  it("uses a 32 KiB default request cap and fails closed when audit persistence fails", async () => {
    const handle = makeSecurityHandler();
    const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const oversized = new Request("https://mcp.example.invalid/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-token",
        origin: "https://client.example.invalid",
        host: "mcp.example.invalid",
        "content-type": "application/json",
        "content-length": String(32 * 1024 + 1),
      },
      body: JSON.stringify(body),
    });
    expect((await handle(oversized)).status).toBe(413);

    const failClosed = makeSecurityHandler({
      auditRepository: {
        append: () => Promise.reject(new Error("audit unavailable")),
        list: () => Promise.resolve([]),
      },
    });
    const response = await failClosed(new Request("https://mcp.example.invalid/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-token",
        origin: "https://client.example.invalid",
        host: "mcp.example.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(503);
  });
});
