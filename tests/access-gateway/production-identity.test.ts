import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  RemoteJwksAdminIdentityProvider,
  type RemoteJwksAdminIdentityProviderOptions,
} from "../../services/access-gateway/production-identity";

const JWKS_URL = "https://team.cloudflareaccess.com/cdn-cgi/access/certs";
const ISSUER = "https://team.cloudflareaccess.com";
const AUDIENCE = "access-app-audience";
const KEY_ID = "cloudflare-access-key-1";

let privateKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = {
    ...await exportJWK(pair.publicKey),
    alg: "RS256",
    kid: KEY_ID,
    use: "sig",
  };
});

function provider(
  overrides: Partial<RemoteJwksAdminIdentityProviderOptions> = {},
  includeAllowedEmails = true,
): RemoteJwksAdminIdentityProvider {
  return new RemoteJwksAdminIdentityProvider({
    jwksUrl: JWKS_URL,
    allowedHosts: ["team.cloudflareaccess.com"],
    issuer: ISSUER,
    audience: AUDIENCE,
    managementTenantId: "tenant_management",
    claimMode: "cloudflare-access",
    ...(includeAllowedEmails ? { allowedEmails: ["admin@example.com"] } : {}),
    fetchImpl: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))),
    ...overrides,
  });
}

function accessClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1_000);
  return {
    aud: [AUDIENCE],
    email: "Admin@Example.com",
    exp: now + 300,
    iat: now,
    nbf: now,
    iss: ISSUER,
    type: "app",
    sub: "cf-user-9c86",
    ...overrides,
  };
}

async function sign(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .sign(privateKey);
}

describe("remote administrator identity provider", () => {
  it("maps an explicitly allowlisted Cloudflare Access user to the fixed admin role", async () => {
    const identity = provider({ allowedSubjects: ["cf-user-9c86"] });

    await expect(identity.authenticateAdmin(await sign(accessClaims()))).resolves.toEqual({
      tenantId: "tenant_management",
      actorId: "cf-user-9c86",
      role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin", "tenant:admin"],
    });
  });

  it.each([
    ["email is not allowlisted", { email: "other@example.com" }],
    ["service token has no user", { email: undefined, sub: "" }],
    ["subject is not a stable identifier", { sub: "   " }],
    ["token is not an application token", { type: "org" }],
    ["not-before is in the future", { nbf: Math.floor(Date.now() / 1_000) + 120 }],
  ])("rejects a Cloudflare assertion when %s", async (_label, overrides) => {
    const identity = provider();
    await expect(identity.authenticateAdmin(await sign(accessClaims(overrides)))).rejects.toThrow(
      /invalid/u,
    );
  });

  it("requires an optional subject allowlist in addition to the email allowlist", async () => {
    const identity = provider({ allowedSubjects: ["different-subject"] });
    await expect(identity.authenticateAdmin(await sign(accessClaims()))).rejects.toThrow(/invalid/u);
  });

  it("rejects a Cloudflare claim mode without an explicit administrator email allowlist", () => {
    expect(() => provider({}, false)).toThrow(/email allowlist/iu);
  });

  it("preserves the provider-neutral embedded admin claims mode", async () => {
    const identity = provider({
      claimMode: "embedded-admin-claims",
    }, false);
    const now = Math.floor(Date.now() / 1_000);
    await expect(identity.authenticateAdmin(await sign({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "enterprise-admin-1",
      tenant_id: "tenant_management",
      actor_role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin", "tenant:admin"],
      iat: now,
      exp: now + 300,
    }))).resolves.toMatchObject({
      actorId: "enterprise-admin-1",
      role: "admin",
    });
  });
});
