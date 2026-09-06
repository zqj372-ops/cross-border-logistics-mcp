import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { OidcPortalIdentityProvider } from "../../services/access-gateway/portal/production-identity";

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("production portal OIDC identity", () => {
  it("preserves a trailing-slash issuer for token verification while using code, PKCE and nonce", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "portal-key", alg: "RS256", use: "sig" };
    let issuer = "";
    let nonce = "";
    let tokenAuthorization = "";
    let tokenBody = "";
    const server = createServer((request, response) => { void (async () => {
      if (request.url === "/.well-known/openid-configuration") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}token`,
          jwks_uri: `${issuer}jwks`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
        }));
        return;
      }
      if (request.url === "/jwks") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (request.url === "/token" && request.method === "POST") {
        tokenAuthorization = request.headers.authorization ?? "";
        request.setEncoding("utf8");
        await new Promise<void>((resolve) => { request.on("data", (chunk: string) => { tokenBody += chunk; }); request.on("end", resolve); });
        const token = await new SignJWT({ nonce, email: "Owner@Example.Test", email_verified: true, name: "Owner", groups: ["portal-reviewers"] })
          .setProtectedHeader({ alg: "RS256", kid: "portal-key" }).setIssuer(issuer).setAudience("portal-client").setSubject("authentik-user")
          .setIssuedAt().setExpirationTime("5m").sign(privateKey);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id_token: token, token_type: "Bearer" }));
        return;
      }
      response.statusCode = 404; response.end();
    })(); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address_unavailable");
    issuer = `http://127.0.0.1:${address.port}/`;

    const provider = new OidcPortalIdentityProvider({
      issuer,
      clientId: "portal-client",
      clientSecret: "portal secret",
      callbackUrl: "https://console.example.test/console/auth/callback",
      roleClaimMap: { "portal-reviewers": "reviewer" },
      allowInsecureLoopback: true,
    });
    const transaction = await provider.begin(); nonce = transaction.nonce;
    const authorization = new URL(transaction.authorizationUrl);
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("nonce")).toBe(transaction.nonce);
    expect(transaction.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/u);

    await expect(provider.complete({ code: "authorization-code", state: transaction.state, transaction })).resolves.toEqual({
      userId: "authentik-user", displayName: "Owner", email: "owner@example.test", emailVerified: true, platformRole: "reviewer",
    });
    expect(Buffer.from(tokenAuthorization.slice("Basic ".length), "base64").toString("utf8")).toBe("portal-client:portal+secret");
    expect(tokenBody).toContain("code_verifier=");
    expect(tokenBody).not.toContain("portal+secret");
    expect(tokenBody).not.toContain("client_secret");
  });

  it("rejects insecure production URLs and discovery metadata that changes origin or weakens the flow", async () => {
    expect(() => new OidcPortalIdentityProvider({ issuer: "http://id.example.test", clientId: "portal", callbackUrl: "https://console.example.test/console/auth/callback" })).toThrow("oidc_configuration_invalid");
    expect(() => new OidcPortalIdentityProvider({ issuer: "https://id.example.test\\evil", clientId: "portal", callbackUrl: "https://console.example.test/console/auth/callback" })).toThrow("oidc_configuration_invalid");
    expect(() => new OidcPortalIdentityProvider({ issuer: "https:////id.example.test", clientId: "portal", callbackUrl: "https://console.example.test/console/auth/callback" })).toThrow("oidc_configuration_invalid");
    expect(() => new OidcPortalIdentityProvider({ issuer: "https://id.example.test/application/../portal", clientId: "portal", callbackUrl: "https://console.example.test/console/auth/callback" })).toThrow("oidc_configuration_invalid");

    const provider = new OidcPortalIdentityProvider({
      issuer: "https://id.example.test/application/o/portal/",
      clientId: "portal",
      callbackUrl: "https://console.example.test/console/auth/callback",
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        issuer: "https://id.example.test/application/o/portal/",
        authorization_endpoint: "https://id.example.test/authorize",
        token_endpoint: "https://attacker.example/token",
        jwks_uri: "https://id.example.test/jwks",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["plain"],
        id_token_signing_alg_values_supported: ["HS256"],
        token_endpoint_auth_methods_supported: ["none"],
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });
    await expect(provider.begin()).rejects.toThrow("oidc_discovery_invalid");

    const issuerMismatch = new OidcPortalIdentityProvider({
      issuer: "https://id.example.test/application/o/portal/",
      clientId: "portal",
      callbackUrl: "https://console.example.test/console/auth/callback",
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        issuer: "https://ID.example.test/application/o/portal/",
        authorization_endpoint: "https://id.example.test/authorize",
        token_endpoint: "https://id.example.test/token",
        jwks_uri: "https://id.example.test/jwks",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["none"],
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });
    await expect(issuerMismatch.begin()).rejects.toThrow("oidc_issuer_invalid");
  });

  it("enforces response content type and size before parsing discovery", async () => {
    let redirectMode: RequestRedirect | undefined;
    const wrongType = new OidcPortalIdentityProvider({
      issuer: "https://id.example.test",
      clientId: "portal",
      callbackUrl: "https://console.example.test/console/auth/callback",
      fetch: (_input, init) => { redirectMode = init?.redirect; return Promise.resolve(new Response("not json", { status: 200, headers: { "content-type": "text/html" } })); },
    });
    await expect(wrongType.begin()).rejects.toThrow("oidc_discovery_invalid");
    expect(redirectMode).toBe("error");

    const oversized = new OidcPortalIdentityProvider({
      issuer: "https://id.example.test",
      clientId: "portal",
      callbackUrl: "https://console.example.test/console/auth/callback",
      maxDiscoveryBytes: 1024,
      fetch: () => Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "2048" } })),
    });
    await expect(oversized.begin()).rejects.toThrow("oidc_discovery_invalid");
  });

  it("fails closed on nonce, audience, algorithm, verified-email and ambiguous platform-role claims", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "claim-key", alg: "RS256", use: "sig" };
    let issuer = "";
    let nonce = "";
    let mode: "valid" | "nonce" | "audience" | "algorithm" | "email" | "roles" | "prototype" = "valid";
    const server = createServer((request, response) => { void (async () => {
      if (request.url === "/.well-known/openid-configuration") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"] }));
        return;
      }
      if (request.url === "/jwks") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ keys: [jwk] })); return; }
      if (request.url === "/token") {
        const idToken = mode === "algorithm"
          ? `${Buffer.from(JSON.stringify({ alg: "none", kid: "claim-key" })).toString("base64url")}.e30.`
          : await new SignJWT({ nonce: mode === "nonce" ? "wrong-nonce" : nonce, email: "user@example.test", email_verified: mode !== "email", groups: mode === "roles" ? ["reviewers", "operators"] : mode === "prototype" ? ["toString"] : [] })
            .setProtectedHeader({ alg: "RS256", kid: "claim-key" }).setIssuer(issuer).setAudience(mode === "audience" ? "other-client" : "portal-client").setSubject("portal-user")
            .setIssuedAt().setExpirationTime("5m").sign(privateKey);
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id_token: idToken })); return;
      }
      response.statusCode = 404; response.end();
    })(); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address_unavailable");
    issuer = `http://127.0.0.1:${address.port}`;
    const provider = new OidcPortalIdentityProvider({ issuer, clientId: "portal-client", callbackUrl: "https://console.example.test/console/auth/callback", allowInsecureLoopback: true, roleClaimMap: { reviewers: "reviewer", operators: "operator" } });
    const rejected = async (selected: typeof mode, error: string) => {
      mode = selected; const transaction = await provider.begin(); nonce = transaction.nonce;
      await expect(provider.complete({ code: "code", state: transaction.state, transaction })).rejects.toThrow(error);
    };
    await rejected("nonce", "oidc_nonce_invalid");
    await rejected("audience", "oidc_token_invalid");
    await rejected("algorithm", "oidc_token_invalid");
    await rejected("email", "oidc_email_unverified");
    await rejected("roles", "oidc_role_ambiguous");
    mode = "prototype"; const transaction = await provider.begin(); nonce = transaction.nonce;
    await expect(provider.complete({ code: "code", state: transaction.state, transaction })).resolves.toMatchObject({ platformRole: null });
  });

  it("aborts identity-provider requests at the configured timeout", async () => {
    const provider = new OidcPortalIdentityProvider({
      issuer: "https://id.example.test",
      clientId: "portal",
      callbackUrl: "https://console.example.test/console/auth/callback",
      timeoutMs: 100,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    await expect(provider.begin()).rejects.toThrow("oidc_discovery_invalid");
  });
});
