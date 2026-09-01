import {
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";

import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import type { JwtClaims } from "../../services/access-gateway/contracts";
import {
  createOciGatewayCryptoProviders,
  ociCryptoConfigurationFromEnvironment,
  type OciKmsCryptoClient,
  type OciKmsManagementClient,
  type OciSecretsClient,
} from "../../services/access-gateway/oci-crypto";

const KEY_ID = "ocid1.key.oc1.ap-tokyo-1.examplekey";
const CURRENT_VERSION_ID = "ocid1.keyversion.oc1.ap-tokyo-1.currentversion";
const PREVIOUS_VERSION_ID = "ocid1.keyversion.oc1.ap-tokyo-1.previousversion";
const SECRET_ID = "ocid1.vaultsecret.oc1.ap-tokyo-1.examplepepper";

function claims(): JwtClaims {
  return {
    iss: "https://www.freightclaw.net/",
    aud: "logistics-mcp-t0",
    sub: "key_example",
    iat: 1_800_000_000,
    exp: 1_800_000_300,
    jti: "jwt_example_0001",
    tenant_id: "tenant_example",
    actor_id: "key_example",
    actor_role: "service",
    roles: ["service"],
    scopes: ["tool:cargo.calculate"],
    client_id: "client_example",
    session_id: "auth_example_0001",
  };
}

function fixtures(overrides: Readonly<{
  signKeyId?: string;
  signKeyVersionId?: string;
  signingAlgorithm?: string;
  missingPepperVersion?: string;
}> = {}) {
  const current = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const previous = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeys = new Map([
    [CURRENT_VERSION_ID, createPublicKey(current.privateKey).export({ type: "spki", format: "pem" }).toString()],
    [PREVIOUS_VERSION_ID, createPublicKey(previous.privateKey).export({ type: "spki", format: "pem" }).toString()],
  ]);
  const peppers = new Map([
    ["pepper-2026-09-v2", Buffer.alloc(48, 0x21)],
    ["pepper-2026-08-v1", Buffer.alloc(48, 0x17)],
  ]);
  const managementClient: OciKmsManagementClient = {
    getKeyVersion(request) {
      const publicKey = publicKeys.get(request.keyVersionId);
      if (publicKey === undefined) throw new Error("unknown key version");
      return Promise.resolve({
        keyVersion: {
          id: request.keyVersionId,
          keyId: request.keyId,
          lifecycleState: "ENABLED",
          publicKey,
        },
      });
    },
  };
  const cryptoClient: OciKmsCryptoClient = {
    sign(request) {
      const message = Buffer.from(request.signDataDetails.message, "base64");
      return Promise.resolve({
        signedData: {
          keyId: overrides.signKeyId ?? request.signDataDetails.keyId,
          keyVersionId: overrides.signKeyVersionId ?? CURRENT_VERSION_ID,
          signingAlgorithm: overrides.signingAlgorithm ?? "SHA_256_RSA_PKCS1_V1_5",
          signature: signBytes("RSA-SHA256", message, current.privateKey).toString("base64"),
        },
      });
    },
  };
  const secretsClient: OciSecretsClient = {
    getSecretBundle(request) {
      if (request.secretVersionName === overrides.missingPepperVersion) {
        return Promise.resolve({
          secretBundle: {
            secretId: request.secretId,
            versionName: request.secretVersionName,
            secretBundleContent: { contentType: "BASE64" },
          },
        });
      }
      const pepper = peppers.get(request.secretVersionName);
      if (pepper === undefined) throw new Error("unknown secret version");
      return Promise.resolve({
        secretBundle: {
          secretId: request.secretId,
          versionName: request.secretVersionName,
          stages: request.secretVersionName === "pepper-2026-09-v2" ? ["CURRENT"] : ["PREVIOUS"],
          secretBundleContent: {
            contentType: "BASE64",
            content: pepper.toString("base64"),
          },
        },
      });
    },
  };
  return { cryptoClient, managementClient, secretsClient };
}

describe("OCI Vault and KMS production providers", () => {
  it("parses an exact instance-principal configuration and rejects partial OCI settings", () => {
    expect(ociCryptoConfigurationFromEnvironment({
      ACCESS_GATEWAY_CRYPTO_BACKEND: "oci-vault",
      ACCESS_GATEWAY_OCI_AUTH_MODE: "instance-principal",
      ACCESS_GATEWAY_OCI_REGION: "ap-tokyo-1",
      ACCESS_GATEWAY_OCI_KMS_KEY_ID: KEY_ID,
      ACCESS_GATEWAY_OCI_KMS_CURRENT_KEY_VERSION_ID: CURRENT_VERSION_ID,
      ACCESS_GATEWAY_OCI_KMS_PREVIOUS_KEY_VERSION_ID: PREVIOUS_VERSION_ID,
      ACCESS_GATEWAY_OCI_KMS_CRYPTO_ENDPOINT:
        "https://example-crypto.kms.ap-tokyo-1.oraclecloud.com",
      ACCESS_GATEWAY_OCI_KMS_MANAGEMENT_ENDPOINT:
        "https://example-management.kms.ap-tokyo-1.oraclecloud.com",
      ACCESS_GATEWAY_OCI_PEPPER_SECRET_ID: SECRET_ID,
    })).toEqual({
      backend: "oci-vault",
      authMode: "instance-principal",
      region: "ap-tokyo-1",
      keyId: KEY_ID,
      currentKeyVersionId: CURRENT_VERSION_ID,
      previousKeyVersionId: PREVIOUS_VERSION_ID,
      cryptoEndpoint: "https://example-crypto.kms.ap-tokyo-1.oraclecloud.com",
      managementEndpoint: "https://example-management.kms.ap-tokyo-1.oraclecloud.com",
      pepperSecretId: SECRET_ID,
    });

    expect(() => ociCryptoConfigurationFromEnvironment({
      ACCESS_GATEWAY_CRYPTO_BACKEND: "oci-vault",
      ACCESS_GATEWAY_OCI_REGION: "ap-tokyo-1",
    })).toThrow(/OCI crypto settings must be supplied together/u);
    expect(() => ociCryptoConfigurationFromEnvironment({
      ACCESS_GATEWAY_OCI_REGION: "ap-tokyo-1",
    })).toThrow(/require ACCESS_GATEWAY_CRYPTO_BACKEND=oci-vault/u);
  });

  it("signs RS256 JWTs with the non-exportable current KMS key and publishes two public versions", async () => {
    const clients = fixtures();
    const providers = await createOciGatewayCryptoProviders({
      ...clients,
      keyId: KEY_ID,
      currentKeyVersionId: CURRENT_VERSION_ID,
      previousKeyVersionId: PREVIOUS_VERSION_ID,
      pepperSecretId: SECRET_ID,
      activePepperVersion: "pepper-2026-09-v2",
      requiredPepperVersions: ["pepper-2026-09-v2", "pepper-2026-08-v1"],
    });
    const jwks = await providers.signer.getJwks();
    expect(jwks.keys).toHaveLength(2);
    expect(new Set(jwks.keys.map(({ kid }) => kid)).size).toBe(2);
    const signed = await providers.signer.sign(claims());
    const verified = await jwtVerify(signed.token, createLocalJWKSet({ keys: [...jwks.keys] }), {
      algorithms: ["RS256"],
      issuer: claims().iss,
      audience: claims().aud,
      currentDate: new Date(claims().iat * 1_000),
    });
    expect(verified.protectedHeader).toEqual({ alg: "RS256", kid: signed.kid, typ: "JWT" });
    expect(verified.payload).toMatchObject(claims());
    await providers.close();
  });

  it("uses named Vault secret versions for current and historical credential hashes", async () => {
    const providers = await createOciGatewayCryptoProviders({
      ...fixtures(),
      keyId: KEY_ID,
      currentKeyVersionId: CURRENT_VERSION_ID,
      pepperSecretId: SECRET_ID,
      activePepperVersion: "pepper-2026-09-v2",
      requiredPepperVersions: ["pepper-2026-09-v2", "pepper-2026-08-v1"],
    });
    const secret = "a".repeat(43);
    const salt = new Uint8Array(16).fill(0x33);
    const currentHash = await providers.pepper.hashCredentialSecret({
      secret,
      salt,
      pepperVersion: "pepper-2026-09-v2",
    });
    expect(await providers.pepper.verifyCredentialSecret({
      secret,
      material: {
        salt,
        expectedHash: currentHash,
        pepperVersion: "pepper-2026-09-v2",
      },
    })).toBe(true);
    expect(providers.pepper.supportsPepperVersion("pepper-2026-08-v1")).toBe(true);
    expect(providers.pepper.supportsPepperVersion("pepper-unknown")).toBe(false);
    await providers.close();
  });

  it.each([
    [{ signKeyId: "ocid1.key.oc1.ap-tokyo-1.wrong" }, /unexpected key/u],
    [{ signKeyVersionId: PREVIOUS_VERSION_ID }, /unexpected key version/u],
    [{ signingAlgorithm: "SHA_256_RSA_PKCS_PSS" }, /unexpected algorithm/u],
  ] as const)("fails closed when KMS returns drifted signing evidence", async (override, message) => {
    const providers = await createOciGatewayCryptoProviders({
      ...fixtures(override),
      keyId: KEY_ID,
      currentKeyVersionId: CURRENT_VERSION_ID,
      pepperSecretId: SECRET_ID,
      activePepperVersion: "pepper-2026-09-v2",
      requiredPepperVersions: ["pepper-2026-09-v2"],
      performSigningSelfTest: false,
    });
    await expect(providers.signer.sign(claims())).rejects.toThrow(message);
    await providers.close();
  });

  it("fails closed when a required Vault secret version has no decodable content", async () => {
    await expect(createOciGatewayCryptoProviders({
      ...fixtures({ missingPepperVersion: "pepper-2026-08-v1" }),
      keyId: KEY_ID,
      currentKeyVersionId: CURRENT_VERSION_ID,
      pepperSecretId: SECRET_ID,
      activePepperVersion: "pepper-2026-09-v2",
      requiredPepperVersions: ["pepper-2026-09-v2", "pepper-2026-08-v1"],
    })).rejects.toThrow(/Vault secret content is unavailable/u);
  });
});
