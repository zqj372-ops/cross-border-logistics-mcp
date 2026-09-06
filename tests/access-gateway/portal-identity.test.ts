import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_PORTAL_IDENTITIES, FixturePortalIdentityProvider, OidcPortalIdentityProvider } from "../../services/access-gateway/portal/identity";

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("portal identity providers", () => {
  it("exposes synthetic identities only in loopback fixture mode", async () => {
    expect(() => new FixturePortalIdentityProvider({ mode: "production", loopback: true })).toThrow("fixture_identity_forbidden");
    expect(() => new FixturePortalIdentityProvider({ mode: "fixtures", loopback: false })).toThrow("fixture_identity_forbidden");
    const provider = new FixturePortalIdentityProvider({ mode: "fixtures", loopback: true });
    expect(provider.listFixtureIdentities().map((item) => item.userId)).toEqual(FIXTURE_PORTAL_IDENTITIES.map((item) => item.userId));
    await expect(provider.authenticateFixture("missing")).rejects.toThrow("fixture_identity_not_found");
    await expect(provider.authenticateFixture("fixture-owner")).resolves.toMatchObject({ userId: "fixture-owner", platformRole: null });
  });

  it("performs OIDC code+PKCE and verifies state, nonce, issuer, audience and JWKS", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
    let issuer = "";
    let nonce = "";
    const server = createServer((request, response) => { void (async () => {
      if (request.url === "/.well-known/openid-configuration") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"] }));
        return;
      }
      if (request.url === "/jwks") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (request.url === "/token" && request.method === "POST") {
        const token = await new SignJWT({ nonce, email: "owner@example.test", email_verified: true, name: "Owner", groups: ["platform-reviewers"] })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(issuer).setAudience("portal-client").setSubject("oidc-owner")
          .setIssuedAt().setExpirationTime("5m").sign(privateKey);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id_token: token, token_type: "Bearer" }));
        return;
      }
      response.statusCode = 404; response.end();
    })(); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address unavailable");
    issuer = `http://127.0.0.1:${address.port}`;
    const provider = new OidcPortalIdentityProvider({ issuer, clientId: "portal-client", callbackUrl: "https://console.example.test/console/auth/callback", roleClaimMap: { "platform-reviewers": "reviewer" }, allowInsecureLoopback: true });
    const transaction = await provider.begin(); nonce = transaction.nonce;
    expect(new URL(transaction.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
    await expect(provider.complete({ code: "code-1", state: "wrong", transaction })).rejects.toThrow("oidc_state_invalid");
    await expect(provider.complete({ code: "code-1", state: transaction.state, transaction })).resolves.toMatchObject({ userId: "oidc-owner", emailVerified: true, platformRole: "reviewer" });
  });
});
