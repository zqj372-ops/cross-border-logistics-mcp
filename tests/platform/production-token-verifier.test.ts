import {
  CompactSign,
  SignJWT,
  UnsecuredJWT,
  exportJWK,
  generateKeyPair,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createProductionTokenVerifier,
  type ProductionTokenVerifierOptions,
} from "../../src/logistics_mcp/server/production-token-verifier";

const JWKS_URL = "https://identity.example.invalid/.well-known/jwks.json";
const ISSUER = "https://identity.example.invalid/";
const AUDIENCE = "logistics-mcp";
const KEY_ID = "signing-key-1";
type TestFetch = NonNullable<ProductionTokenVerifierOptions["fetchImpl"]>;

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

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function jwksFetch() {
  return vi.fn<TestFetch>(() =>
    Promise.resolve(jsonResponse({ keys: [publicJwk] })),
  );
}

function verifierOptions(
  overrides: Partial<ProductionTokenVerifierOptions> = {},
): ProductionTokenVerifierOptions {
  return {
    jwksUrl: JWKS_URL,
    allowedHosts: ["identity.example.invalid"],
    fetchImpl: jwksFetch(),
    ...overrides,
  };
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "sales-1",
    tenant_id: "tenant-a",
    actor_id: "sales-1",
    actor_role: "sales",
    roles: ["sales"],
    scopes: ["quote:read"],
    client_id: "codex",
    session_id: "session-1",
    expires_at: now + 300,
    iat: now,
    exp: now + 300,
    custom_claim: { retained: true },
    ...overrides,
  };
}

async function sign(
  payload: Record<string, unknown> = claims(),
  key: CryptoKey = privateKey,
  algorithm = "RS256",
  keyId = KEY_ID,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: algorithm, kid: keyId })
    .sign(key);
}

describe("production OIDC token verifier", () => {
  it("verifies RS256 signatures and returns the complete original payload", async () => {
    const fetchImpl = jwksFetch();
    const verifier = createProductionTokenVerifier(verifierOptions({ fetchImpl }));
    const payload = claims();

    await expect(verifier.verify(await sign(payload))).resolves.toEqual(payload);
    await expect(verifier.health()).resolves.toEqual({ ready: true });
    await expect(verifier.health()).resolves.toEqual({ ready: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(JWKS_URL);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });
  });

  it("rejects tampered, unsecured, and non-RS256 tokens", async () => {
    const verifier = createProductionTokenVerifier(verifierOptions());
    const signed = await sign();
    const segments = signed.split(".");
    segments[2] = `${segments[2]?.startsWith("A") ? "B" : "A"}${segments[2]?.slice(1)}`;

    await expect(verifier.verify(segments.join("."))).rejects.toThrow();
    await expect(
      verifier.verify(new UnsecuredJWT(claims()).encode()),
    ).rejects.toThrow();

    const rs384 = await generateKeyPair("RS384", { extractable: true });
    const wrongAlgorithmToken = await sign(
      claims(),
      rs384.privateKey,
      "RS384",
      "rs384-key",
    );
    await expect(verifier.verify(wrongAlgorithmToken)).rejects.toThrow();
  });

  it("leaves issuer, audience, issued-at, and expiration policy to the gateway", async () => {
    const verifier = createProductionTokenVerifier(verifierOptions());
    const payload = claims({
      iss: "https://wrong-issuer.example.invalid/",
      aud: "wrong-audience",
      iat: 9_999_999_999,
      exp: 1,
    });

    await expect(verifier.verify(await sign(payload))).resolves.toEqual(payload);
  });

  it("rejects malformed payloads and oversized tokens before trusting claims", async () => {
    const fetchImpl = jwksFetch();
    const verifier = createProductionTokenVerifier(
      verifierOptions({ fetchImpl, maxTokenBytes: 128 }),
    );

    await expect(verifier.verify("not-a-jwt")).rejects.toThrow();
    await expect(verifier.verify("x".repeat(129))).rejects.toThrow(/size|large/i);
    expect(fetchImpl).not.toHaveBeenCalled();

    const signedNonJson = await new CompactSign(
      new TextEncoder().encode("not-json"),
    )
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .sign(privateKey);
    const normalVerifier = createProductionTokenVerifier(verifierOptions());
    await expect(normalVerifier.verify(signedNonJson)).rejects.toThrow();
  });

  it("fails health and verification closed when JWKS is unavailable or redirects", async () => {
    for (const response of [
      new Response("unavailable", { status: 503 }),
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.invalid/jwks" },
      }),
    ]) {
      const fetchImpl = vi.fn<TestFetch>(() => Promise.resolve(response.clone()));
      const verifier = createProductionTokenVerifier(verifierOptions({ fetchImpl }));

      await expect(verifier.health()).resolves.toEqual({ ready: false });
      await expect(verifier.health()).resolves.toEqual({ ready: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await expect(verifier.verify(await sign())).rejects.toThrow();
      await expect(verifier.verify(await sign())).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    }
  });

  it("bounds JWKS responses and requires a usable RS256 public key", async () => {
    const oversized = createProductionTokenVerifier(verifierOptions({
      maxJwksResponseBytes: 64,
      fetchImpl: vi.fn<TestFetch>(() => Promise.resolve(new Response(
        JSON.stringify({ keys: [publicJwk] }),
        { headers: { "content-length": "999" } },
      ))),
    }));
    await expect(oversized.health()).resolves.toEqual({ ready: false });

    const unusable = createProductionTokenVerifier(verifierOptions({
      fetchImpl: vi.fn<TestFetch>(() =>
        Promise.resolve(jsonResponse({
          keys: [{
            kty: "RSA",
            n: "",
            e: "AQAB",
            alg: "RS256",
            use: "sig",
          }],
        })),
      ),
    }));
    await expect(unusable.health()).resolves.toEqual({ ready: false });
  });

  it("rejects non-HTTPS and non-allowlisted JWKS endpoints before fetching", () => {
    expect(() => createProductionTokenVerifier(verifierOptions({
      jwksUrl: "http://identity.example.invalid/jwks",
    }))).toThrow(/HTTPS|scheme/i);
    expect(() => createProductionTokenVerifier(verifierOptions({
      jwksUrl: "https://evil.example.invalid/jwks",
    }))).toThrow(/allowlist|host/i);
  });
});
