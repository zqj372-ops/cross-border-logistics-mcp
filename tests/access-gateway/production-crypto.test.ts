import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalJWKSet, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileJwtSigningProvider,
  FileSecretPepperProvider,
} from "../../services/access-gateway/production-crypto";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "logistics-mcp-gateway-crypto-"));
  roots.push(root);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPath = join(root, "jwt-signing.pem");
  const pepperPath = join(root, "credential-pepper");
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o400,
  });
  writeFileSync(pepperPath, Buffer.alloc(48, 0x5a), { mode: 0o400 });
  return { privateKeyPath, pepperPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production gateway cryptographic providers", () => {
  it("derives credential hashes with a mounted pepper and verifies in constant-shape paths", async () => {
    const { pepperPath } = fixture();
    const provider = new FileSecretPepperProvider({
      pepperPath,
      pepperVersion: "pepper-2026-08-v1",
    });
    const salt = new Uint8Array(16).fill(7);
    const expectedHash = await provider.hashCredentialSecret({
      secret: "A".repeat(43),
      salt,
      pepperVersion: "pepper-2026-08-v1",
    });

    await expect(provider.verifyCredentialSecret({
      secret: "A".repeat(43),
      material: { salt, expectedHash, pepperVersion: "pepper-2026-08-v1" },
    })).resolves.toBe(true);
    await expect(provider.verifyCredentialSecret({
      secret: "B".repeat(43),
      material: { salt, expectedHash, pepperVersion: "pepper-2026-08-v1" },
    })).resolves.toBe(false);
    await expect(provider.verifyCredentialSecret({
      secret: "B".repeat(43),
      material: null,
    })).resolves.toBe(false);
  });

  it("signs exact RS256 claims and publishes only the matching public key", async () => {
    const { privateKeyPath } = fixture();
    const provider = new FileJwtSigningProvider({ privateKeyPath });
    const claims = {
      iss: "https://www.freightclaw.net/",
      aud: "logistics-mcp-t0",
      sub: "key_00000001",
      iat: 1_800_000_000,
      exp: 1_800_000_300,
      jti: "jwt_00000001",
      tenant_id: "tenant_demo",
      actor_id: "key_00000001",
      actor_role: "service" as const,
      roles: ["service"] as const,
      scopes: ["tool:cargo.calculate"] as const,
      client_id: "codex_ops",
      session_id: "auth_00000001",
    };

    const signed = await provider.sign(claims);
    const jwks = await provider.getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ alg: "RS256", kid: signed.kid, use: "sig" });
    const verified = await jwtVerify(signed.token, createLocalJWKSet({
      keys: jwks.keys.map((key) => ({ ...key })),
    }), {
      algorithms: ["RS256"],
      issuer: claims.iss,
      audience: claims.aud,
      currentDate: new Date((claims.iat + 1) * 1_000),
    });
    expect(verified.payload).toMatchObject(claims);
  });

  it("rejects secret material that is group/world readable", () => {
    const { privateKeyPath, pepperPath } = fixture();
    chmodSync(privateKeyPath, 0o644);
    chmodSync(pepperPath, 0o644);
    expect(() => new FileJwtSigningProvider({ privateKeyPath })).toThrow(/permission/u);
    expect(() => new FileSecretPepperProvider({
      pepperPath,
      pepperVersion: "pepper-2026-08-v1",
    })).toThrow(/permission/u);
  });
});
