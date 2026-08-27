import { createVerify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createSyntheticAccessGatewayFixture } from "../../services/access-gateway/index";

function verifyRs256(token: string, jwk: Record<string, unknown>): boolean {
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") return false;
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  const key = {
    kty: "RSA",
    n: jwk.n,
    e: jwk.e,
  } as const;
  return verifier.verify({ key, format: "jwk" }, Buffer.from(encodedSignature ?? "", "base64url"));
}

describe("JWKS and signer contract", () => {
  it("returns only public RS256 signing keys", async () => {
    const fixture = createSyntheticAccessGatewayFixture();
    const jwks = await fixture.gateway.getJwks();
    expect(jwks).toMatchObject({ keys: [{ kty: "RSA", alg: "RS256", use: "sig" }] });
    expect(jwks.keys.length).toBe(1);
    expect(JSON.stringify(jwks)).not.toMatch(/"d"|"p"|"q"|"dp"|"dq"|"qi"/u);
  });

  it("keeps the previous key through rotation so an unexpired token remains verifiable", async () => {
    const fixture = createSyntheticAccessGatewayFixture({ nowSeconds: 1_787_760_000 });
    const seeded = await fixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    const issued = await fixture.gateway.exchangeToken({
      apiKey: seeded.apiKey,
      body: { schema_version: "2026-08-27.v1", requested_tool_names: ["cargo.calculate"] },
      clientIp: "198.51.100.27",
    });
    const before = await fixture.gateway.getJwks();
    const rotated = await fixture.signer.rotate();
    const after = await fixture.gateway.getJwks();
    expect(rotated.kid).not.toBe(before.keys[0]?.kid);
    expect(after.keys.map((key) => key.kid)).toEqual(expect.arrayContaining([
      before.keys[0]?.kid,
      rotated.kid,
    ]));
    const previous = after.keys.find((key) => key.kid === before.keys[0]?.kid);
    expect(previous).toBeDefined();
    expect(verifyRs256(issued.data.access_token, previous as unknown as Record<string, unknown>)).toBe(true);
  });
});
