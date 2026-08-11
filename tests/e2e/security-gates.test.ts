import { describe, expect, it } from "vitest";

import {
  assertAllowedOutboundUrl,
  assertTenantScope,
  redactSecurityError,
  validateShortLivedToken,
} from "../../src/logistics_mcp/platform/security";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { MemoryAuditRepository } from "../../src/logistics_mcp/platform/audit";
import { createMcpHttpHandler } from "../../src/logistics_mcp/server/http";
import { securityClaims, fakeJwtClaims } from "./fixtures/security-fixtures";

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

  it("redacts bearer, API key, customer address, quote amount and tax material from errors", () => {
    const redacted = redactSecurityError(new Error(
      "Bearer real-token api_key=real-key address=123 Main Street quote_amount=999.99 tax_document=secret.pdf",
    ));
    expect(redacted).not.toMatch(/real-token|real-key|123 Main Street|999\.99|secret\.pdf/);
  });

  it("uses a 32 KiB default request cap and fails closed when audit persistence fails", async () => {
    const handle = createMcpHttpHandler({
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => securityClaims,
      auditRepository: new MemoryAuditRepository(),
    });
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

    const failClosed = createMcpHttpHandler({
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => securityClaims,
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
