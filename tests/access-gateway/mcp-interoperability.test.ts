import { describe, expect, it } from "vitest";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { validateShortLivedToken } from "../../src/logistics_mcp/platform/security";
import { createProductionTokenVerifier } from "../../src/logistics_mcp/server/production-token-verifier";
import { createSyntheticAccessGatewayFixture } from "../../services/access-gateway/index";

describe("Gateway JWT to MCP verifier interoperability", () => {
  it("verifies the Gateway RS256 token and builds the exact MCP execution context", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const fixture = createSyntheticAccessGatewayFixture({ nowSeconds });
    const seeded = await fixture.seedAcknowledgedCredential({
      toolNames: ["cargo.calculate", "system.agent_context.get"],
    });
    const issued = await fixture.gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: {
        schema_version: "2026-08-27.v1",
        requested_tool_names: ["system.agent_context.get", "cargo.calculate"],
      },
      clientIp: "198.51.100.40",
    });
    const verifier = createProductionTokenVerifier({
      jwksUrl: "https://access-gateway.example.invalid/.well-known/jwks.json",
      allowedHosts: ["access-gateway.example.invalid"],
      fetchImpl: () => fixture.gateway.getJwks().then((jwks) => new Response(
        JSON.stringify(jwks),
        { headers: { "content-type": "application/json" } },
      )),
    });

    try {
      const verifiedClaims = await verifier.verify(issued.data.access_token);
      const validated = validateShortLivedToken(verifiedClaims, {
        issuer: "https://access-gateway.example.invalid/",
        audience: "logistics-mcp",
        nowSeconds,
        maxLifetimeSeconds: 900,
      });
      const context = parseExecutionContext({
        tenant_id: validated.tenant_id,
        actor_id: validated.actor_id,
        actor_role: validated.actor_role,
        roles: validated.roles,
        scopes: validated.scopes,
        client_id: validated.client_id,
        session_id: validated.session_id,
        expires_at: validated.exp,
      });
      expect(context).toMatchObject({
        tenantId: seeded.tenantId,
        actorId: seeded.credentialId,
        role: "service",
        roles: ["service"],
        scopes: ["tool:cargo.calculate", "tool:system.agent_context.get"],
        clientId: seeded.clientId,
        sessionId: issued.data.session_ref,
        expiresAt: nowSeconds + 300,
      });
    } finally {
      await verifier.close();
    }
  });
});
