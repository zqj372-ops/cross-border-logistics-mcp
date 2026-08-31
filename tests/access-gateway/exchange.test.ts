import { describe, expect, it } from "vitest";

import {
  T0_TOOL_NAMES,
  createAccessGateway,
  createSyntheticAccessGatewayFixture,
} from "../../services/access-gateway/index";
import type { JwtSigningProvider } from "../../services/access-gateway/ports";

const request = (requestedToolNames: readonly string[] = ["cargo.calculate"]) => ({
  schema_version: "2026-08-27.v1",
  requested_tool_names: requestedToolNames,
});

describe("exact T0 token exchange", () => {
  it("issues an RS256 JWT with only server-owned exact claims and scopes", async () => {
    const fixture = createSyntheticAccessGatewayFixture({ nowSeconds: 1_787_760_000 });
    const seeded = await fixture.seedAcknowledgedCredential({
      toolNames: ["cargo.calculate", "container.plan_summary"],
    });

    const result = await fixture.gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: request(["container.plan_summary", "cargo.calculate"]),
      clientIp: "198.51.100.20",
      requestId: "req_exchange_00000001",
    });

    expect(result).toMatchObject({
      schema_version: "2026-08-27.v1",
      status: "success",
      warnings: [],
      blockers: [],
      data: {
        token_type: "Bearer",
        expires_in: 300,
        tool_names: ["cargo.calculate", "container.plan_summary"],
        request_id: "req_exchange_00000001",
      },
    });
    expect(result.data.session_ref).toMatch(/^auth_/u);
    const token = result.data.access_token;
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    expect(encodedHeader).toBeTruthy();
    expect(encodedPayload).toBeTruthy();
    expect(encodedSignature).toMatch(/^[A-Za-z0-9_-]+$/u);
    const header = JSON.parse(Buffer.from(encodedHeader ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(payload).toMatchObject({
      iss: "https://access-gateway.example.invalid/",
      aud: "logistics-mcp",
      sub: seeded.credentialId,
      tenant_id: seeded.tenantId,
      actor_id: seeded.credentialId,
      actor_role: "service",
      roles: ["service"],
      scopes: ["tool:cargo.calculate", "tool:container.plan_summary"],
      client_id: seeded.clientId,
      session_id: result.data.session_ref,
      iat: 1_787_760_000,
      exp: 1_787_760_300,
    });
    expect(payload.jti).toEqual(expect.stringMatching(/^jwt_/u));
    expect(Object.keys(payload).sort()).toEqual([
      "actor_id", "actor_role", "aud", "client_id", "exp", "iat", "iss", "jti",
      "roles", "scopes", "session_id", "sub", "tenant_id",
    ]);
    expect(fixture.audit.events).toHaveLength(1);
    expect(JSON.stringify(fixture.audit.events)).not.toContain(seeded.apiKey);
  });

  it("uses the default TTL and enforces the 900-second hard ceiling", async () => {
    const defaultFixture = createSyntheticAccessGatewayFixture({ nowSeconds: 1_787_760_000 });
    const defaultSeed = await defaultFixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    const defaultResult = await defaultFixture.gateway.exchangeToken({
      apiKey: defaultSeed.apiKey,
      body: request(),
      clientIp: "198.51.100.21",
    });
    expect(defaultResult.data.expires_in).toBe(300);

    const cappedFixture = createSyntheticAccessGatewayFixture({ nowSeconds: 1_787_760_000, defaultTtlSeconds: 900 });
    const cappedSeed = await cappedFixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    const cappedResult = await cappedFixture.gateway.exchangeToken({
      apiKey: cappedSeed.apiKey,
      body: request(),
      clientIp: "198.51.100.22",
    });
    expect(cappedResult.data.expires_in).toBe(900);
    expect(() => createSyntheticAccessGatewayFixture({ defaultTtlSeconds: 901 })).toThrow(/900/);
  });

  it("rejects unknown fields, unknown tools, and entitlement expansion", async () => {
    const fixture = createSyntheticAccessGatewayFixture();
    const seeded = await fixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    await expect(fixture.gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: { ...request(), tenant_id: "attacker" },
      clientIp: "198.51.100.23",
    })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(fixture.gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: request(["system.get_data_status"]),
      clientIp: "198.51.100.23",
    })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(fixture.gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: request(["container.plan_summary"]),
      clientIp: "198.51.100.23",
    })).rejects.toMatchObject({ code: "tool_entitlement_denied" });
  });

  it("keeps authentication failures indistinguishable and does not sign", async () => {
    const fixture = createSyntheticAccessGatewayFixture();
    const pending = await fixture.seedCredential({ toolNames: ["cargo.calculate"], acknowledged: false });
    const cases = [
      "lmcpk_key_unknown_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "not-a-key",
      pending.apiKey,
      `${pending.apiKey.slice(0, -1)}B`,
    ];
    for (const apiKey of cases) {
      await expect(fixture.gateway.exchangeToken({ apiKey, body: request(), clientIp: "198.51.100.24" }))
        .rejects.toMatchObject({ code: "authentication_failed" });
    }
    expect(fixture.pepper.verificationCount).toBe(3);
    expect(fixture.audit.events).toHaveLength(4);
    expect(fixture.audit.events.map(({ reasonCode }) => reasonCode)).toEqual([
      "authentication_failed",
      "authentication_failed",
      "authentication_failed",
      "authentication_failed",
    ]);
    expect(fixture.audit.events[0]).toMatchObject({
      tenantId: null,
      clientId: null,
      credentialId: null,
    });
    expect(JSON.stringify(fixture.audit.events)).not.toContain(pending.apiKey);
  });

  it("fails closed on rate limit and revocation", async () => {
    const fixture = createSyntheticAccessGatewayFixture();
    const seeded = await fixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    fixture.rateLimit.denyNext();
    await expect(fixture.gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: request(),
      clientIp: "198.51.100.25",
    })).rejects.toMatchObject({ code: "rate_limited" });

    fixture.revocation.revokeCredential(seeded.credentialId);
    await expect(fixture.gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: request(),
      clientIp: "198.51.100.25",
    })).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("drops a signed token when audit persistence fails", async () => {
    const fixture = createSyntheticAccessGatewayFixture();
    const seeded = await fixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    fixture.audit.failNext();
    await expect(fixture.gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: request(),
      clientIp: "198.51.100.26",
    })).rejects.toMatchObject({ code: "access_gateway_unavailable" });
    expect(fixture.audit.events).toEqual([
      expect.objectContaining({
        action: "token.exchange",
        status: "unavailable",
        reasonCode: "access_gateway_unavailable",
      }),
    ]);
    expect(fixture.signer.signCount).toBe(1);
  });

  it("rejects a signer response whose protected header drifts from RS256", async () => {
    const fixture = createSyntheticAccessGatewayFixture();
    const seeded = await fixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    const driftedSigner: JwtSigningProvider = {
      kind: "synthetic",
      getJwks: () => fixture.signer.getJwks(),
      sign: async (claims) => {
        const signed = await fixture.signer.sign(claims);
        const [encodedHeader = "", payload = "", signature = ""] = signed.token.split(".");
        const header = JSON.parse(
          Buffer.from(encodedHeader, "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        const changedHeader = Buffer.from(JSON.stringify({
          ...header,
          alg: "HS256",
        }), "utf8").toString("base64url");
        return { token: `${changedHeader}.${payload}.${signature}`, kid: signed.kid };
      },
    };
    const gateway = createAccessGateway({
      ...fixture.providers,
      jwtSigningProvider: driftedSigner,
    });

    await expect(gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: request(),
      clientIp: "198.51.100.28",
    })).rejects.toMatchObject({ code: "access_gateway_unavailable" });
    expect(fixture.audit.events).toEqual([
      expect.objectContaining({
        status: "unavailable",
        reasonCode: "access_gateway_unavailable",
      }),
    ]);
  });

  it("never expands the exact T0 allowlist", () => {
    expect(T0_TOOL_NAMES).toEqual([
      "cargo.calculate",
      "container.plan_summary",
      "system.agent_context.get",
    ]);
  });
});
