import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateEncrypt,
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
  const signRequests: Parameters<OciKmsCryptoClient["sign"]>[0][] = [];
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
      signRequests.push(request);
      const digest = Buffer.from(request.signDataDetails.message, "base64");
      const digestInfo = Buffer.concat([
        Buffer.from("3031300d060960864801650304020105000420", "hex"),
        digest,
      ]);
      return Promise.resolve({
        signedData: {
          keyId: overrides.signKeyId ?? request.signDataDetails.keyId,
          keyVersionId: overrides.signKeyVersionId ?? CURRENT_VERSION_ID,
          signingAlgorithm: overrides.signingAlgorithm ?? "SHA_256_RSA_PKCS1_V1_5",
          signature: privateEncrypt({
            key: current.privateKey,
            padding: constants.RSA_PKCS1_PADDING,
          }, digestInfo).toString("base64"),
        },
      });
    },
  };
  const secretsClient: OciSecretsClient = {
    getSecretBundle(request) {
      const versionName = request.secretVersionName;
      if (versionName === undefined) throw new Error("expected named secret version");
      if (versionName === overrides.missingPepperVersion) {
        return Promise.resolve({
          secretBundle: {
            secretId: request.secretId,
            versionName,
            secretBundleContent: { contentType: "BASE64" },
          },
        });
      }
      const pepper = peppers.get(versionName);
      if (pepper === undefined) throw new Error("unknown secret version");
      return Promise.resolve({
        secretBundle: {
          secretId: request.secretId,
          versionName,
          stages: versionName === "pepper-2026-09-v2" ? ["CURRENT"] : ["PREVIOUS"],
          secretBundleContent: {
            contentType: "BASE64",
            content: pepper.toString("base64"),
          },
        },
      });
    },
  };
  return { cryptoClient, managementClient, secretsClient, signRequests };
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
    expect(clients.signRequests).toHaveLength(2);
    const startupRequest = clients.signRequests[0];
    expect(startupRequest?.signDataDetails.loggingContext.operation).toBe("startup-self-test");
    expect(startupRequest?.signDataDetails.message).toBe(
      createHash("sha256")
        .update(Buffer.from(
          "logistics-mcp-access-gateway/oci-kms-self-test/v1/".repeat(8),
          "utf8",
        ))
        .digest("base64"),
    );
    for (const request of clients.signRequests) {
      expect(request.signDataDetails.messageType).toBe("DIGEST");
      expect(Buffer.from(request.signDataDetails.message, "base64")).toHaveLength(32);
    }
    await providers.close();
  });

  it("signs a full read-preview JWT whose raw compact input exceeds RSA PKCS1 limits", async () => {
    const clients = fixtures();
    const providers = await createOciGatewayCryptoProviders({
      ...clients,
      keyId: KEY_ID,
      currentKeyVersionId: CURRENT_VERSION_ID,
      pepperSecretId: SECRET_ID,
      activePepperVersion: "pepper-2026-09-v2",
      requiredPepperVersions: ["pepper-2026-09-v2"],
    });
    const readPreviewClaims = {
      ...claims(),
      scopes: [
        "tool:cargo.calculate",
        "tool:container.plan_summary",
        "tool:quote.canada_final_mile.calculate",
        "tool:customs.ca.search",
        "tool:customs.ca.estimate",
        "tool:quote.freightcom_ltl.preview",
        "tool:system.agent_context.get",
      ],
    } as unknown as JwtClaims;
    const signed = await providers.signer.sign(readPreviewClaims);
    const compactInput = signed.token.split(".").slice(0, 2).join(".");
    expect(Buffer.byteLength(compactInput, "ascii")).toBeGreaterThan(245);
    const verified = await jwtVerify(
      signed.token,
      createLocalJWKSet({ keys: [...(await providers.signer.getJwks()).keys] }),
      {
        algorithms: ["RS256"],
        issuer: readPreviewClaims.iss,
        audience: readPreviewClaims.aud,
        currentDate: new Date(readPreviewClaims.iat * 1_000),
      },
    );
    expect(verified.payload.scopes).toEqual(readPreviewClaims.scopes);
    expect(clients.signRequests.at(-1)?.signDataDetails.messageType).toBe("DIGEST");
    expect(Buffer.from(clients.signRequests.at(-1)!.signDataDetails.message, "base64")).toHaveLength(32);
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

  it("uses an explicit OCI version-number selector for auto-generated secret versions", async () => {
    let observedRequest: Parameters<OciSecretsClient["getSecretBundle"]>[0] | undefined;
    const clients = fixtures();
    const providers = await createOciGatewayCryptoProviders({
      ...clients,
      secretsClient: {
        getSecretBundle(request) {
          observedRequest = request;
          return Promise.resolve({
            secretBundle: {
              secretId: request.secretId,
              versionNumber: 1,
              stages: ["CURRENT", "LATEST"],
              secretBundleContent: {
                contentType: "BASE64",
                content: Buffer.alloc(32, 0x2a).toString("base64"),
              },
            },
          });
        },
      },
      keyId: KEY_ID,
      currentKeyVersionId: CURRENT_VERSION_ID,
      pepperSecretId: SECRET_ID,
      activePepperVersion: "oci-number-1",
      requiredPepperVersions: ["oci-number-1"],
    });
    expect(observedRequest).toEqual({ secretId: SECRET_ID, versionNumber: 1 });
    expect(providers.pepper.pepperVersion).toBe("oci-number-1");
    await providers.close();
  });

  it.each(["oci-number-0", "oci-number-01", "oci-number-not-a-number"])(
    "fails closed for an invalid reserved OCI version selector: %s",
    async (version) => {
      await expect(createOciGatewayCryptoProviders({
        ...fixtures(),
        keyId: KEY_ID,
        currentKeyVersionId: CURRENT_VERSION_ID,
        pepperSecretId: SECRET_ID,
        activePepperVersion: version,
        requiredPepperVersions: [version],
        performSigningSelfTest: false,
      })).rejects.toThrow(/secret version selector is invalid/u);
    },
  );

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
