import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import type { JwksResponse, JwtClaims, PublicJwk, SignedJwt } from "./contracts";
import type { JwtSigningProvider, SecretPepperProvider } from "./ports";
import {
  deriveCredentialSecretHash,
  validCredentialPepperVersion,
} from "./production-crypto";

const OCI_SIGNING_ALGORITHM = "SHA_256_RSA_PKCS1_V1_5" as const;
const OCI_MESSAGE_TYPE = "RAW" as const;
const MAX_OCI_MESSAGE_BYTES = 4_096;
const MAX_OCI_IDENTIFIER_BYTES = 512;
const MAX_RETAINED_PEPPERS = 64;
const DERIVED_HASH_BYTES = 32;
const DUMMY_SALT = new Uint8Array(16).fill(0x5a);
const DUMMY_HASH = new Uint8Array(DERIVED_HASH_BYTES).fill(0xa5);

export interface OciKmsSignRequest {
  readonly signDataDetails: Readonly<{
    readonly message: string;
    readonly keyId: string;
    readonly keyVersionId: string;
    readonly messageType: typeof OCI_MESSAGE_TYPE;
    readonly signingAlgorithm: typeof OCI_SIGNING_ALGORITHM;
    readonly loggingContext: Readonly<Record<string, string>>;
  }>;
}

export interface OciKmsCryptoClient {
  sign(request: OciKmsSignRequest): Promise<Readonly<{
    readonly signedData: Readonly<{
      readonly keyId: string;
      readonly keyVersionId: string;
      readonly signingAlgorithm: string;
      readonly signature: string;
    }>;
  }>>;
  close?(): void | Promise<void>;
}

export interface OciKmsManagementClient {
  getKeyVersion(request: Readonly<{
    readonly keyId: string;
    readonly keyVersionId: string;
  }>): Promise<Readonly<{
    readonly keyVersion: Readonly<{
      readonly id: string;
      readonly keyId: string;
      readonly lifecycleState?: string;
      readonly publicKey?: string;
    }>;
  }>>;
  close?(): void | Promise<void>;
}

export interface OciSecretsClient {
  getSecretBundle(request: Readonly<{
    readonly secretId: string;
    readonly secretVersionName: string;
  }>): Promise<Readonly<{
    readonly secretBundle: Readonly<{
      readonly secretId: string;
      readonly versionName?: string;
      readonly stages?: readonly string[];
      readonly secretBundleContent?: Readonly<{
        readonly contentType: string;
        readonly content?: string;
      }>;
    }>;
  }>>;
  close?(): void | Promise<void>;
}

export interface OciCryptoConfiguration {
  readonly backend: "oci-vault";
  readonly authMode: "instance-principal";
  readonly region: string;
  readonly keyId: string;
  readonly currentKeyVersionId: string;
  readonly previousKeyVersionId?: string;
  readonly cryptoEndpoint: string;
  readonly managementEndpoint: string;
  readonly pepperSecretId: string;
}

export type CryptoEnvironmentConfiguration =
  | Readonly<{ readonly backend: "file" }>
  | OciCryptoConfiguration;

const OCI_SETTING_NAMES = Object.freeze([
  "ACCESS_GATEWAY_OCI_AUTH_MODE",
  "ACCESS_GATEWAY_OCI_REGION",
  "ACCESS_GATEWAY_OCI_KMS_KEY_ID",
  "ACCESS_GATEWAY_OCI_KMS_CURRENT_KEY_VERSION_ID",
  "ACCESS_GATEWAY_OCI_KMS_PREVIOUS_KEY_VERSION_ID",
  "ACCESS_GATEWAY_OCI_KMS_CRYPTO_ENDPOINT",
  "ACCESS_GATEWAY_OCI_KMS_MANAGEMENT_ENDPOINT",
  "ACCESS_GATEWAY_OCI_PEPPER_SECRET_ID",
] as const);

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function validOcid(value: string, resourceType: "key" | "keyversion" | "vaultsecret"): string {
  if (
    value.length > MAX_OCI_IDENTIFIER_BYTES ||
    !value.startsWith(`ocid1.${resourceType}.`) ||
    /\s/u.test(value)
  ) {
    throw new Error(`OCI ${resourceType} identifier is invalid.`);
  }
  return value;
}

function validRegion(value: string): string {
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/u.test(value) || value.length > 64) {
    throw new Error("OCI region is invalid.");
  }
  return value;
}

function validKmsEndpoint(
  value: string,
  region: string,
  plane: "crypto" | "management",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OCI KMS ${plane} endpoint is invalid.`);
  }
  const requiredSuffix = `-${plane}.kms.${region}.oraclecloud.com`;
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    !url.hostname.endsWith(requiredSuffix) ||
    url.hostname.length <= requiredSuffix.length
  ) {
    throw new Error(`OCI KMS ${plane} endpoint is invalid.`);
  }
  return url.origin;
}

export function ociCryptoConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): CryptoEnvironmentConfiguration {
  const backend = environment.ACCESS_GATEWAY_CRYPTO_BACKEND?.trim() || "file";
  const configuredOciSettings = OCI_SETTING_NAMES.filter((name) => {
    const value = environment[name]?.trim();
    return value !== undefined && value.length > 0;
  });
  if (backend === "file") {
    if (configuredOciSettings.length > 0) {
      throw new Error("OCI settings require ACCESS_GATEWAY_CRYPTO_BACKEND=oci-vault.");
    }
    return Object.freeze({ backend: "file" as const });
  }
  if (backend !== "oci-vault") {
    throw new Error("ACCESS_GATEWAY_CRYPTO_BACKEND must be file or oci-vault.");
  }
  const requiredNames = OCI_SETTING_NAMES.filter(
    (name) => name !== "ACCESS_GATEWAY_OCI_KMS_PREVIOUS_KEY_VERSION_ID",
  );
  if (requiredNames.some((name) => !configuredOciSettings.includes(name))) {
    throw new Error("OCI crypto settings must be supplied together.");
  }
  const authMode = environmentValue(environment, "ACCESS_GATEWAY_OCI_AUTH_MODE");
  if (authMode !== "instance-principal") {
    throw new Error("ACCESS_GATEWAY_OCI_AUTH_MODE must equal instance-principal.");
  }
  const region = validRegion(environmentValue(environment, "ACCESS_GATEWAY_OCI_REGION"));
  const keyId = validOcid(environmentValue(environment, "ACCESS_GATEWAY_OCI_KMS_KEY_ID"), "key");
  const currentKeyVersionId = validOcid(
    environmentValue(environment, "ACCESS_GATEWAY_OCI_KMS_CURRENT_KEY_VERSION_ID"),
    "keyversion",
  );
  const rawPreviousKeyVersionId =
    environment.ACCESS_GATEWAY_OCI_KMS_PREVIOUS_KEY_VERSION_ID?.trim();
  const previousKeyVersionId = rawPreviousKeyVersionId === undefined ||
    rawPreviousKeyVersionId.length === 0
    ? undefined
    : validOcid(rawPreviousKeyVersionId, "keyversion");
  if (previousKeyVersionId === currentKeyVersionId) {
    throw new Error("OCI current and previous KMS key versions must be different.");
  }
  return Object.freeze({
    backend: "oci-vault" as const,
    authMode,
    region,
    keyId,
    currentKeyVersionId,
    ...(previousKeyVersionId === undefined ? {} : { previousKeyVersionId }),
    cryptoEndpoint: validKmsEndpoint(
      environmentValue(environment, "ACCESS_GATEWAY_OCI_KMS_CRYPTO_ENDPOINT"),
      region,
      "crypto",
    ),
    managementEndpoint: validKmsEndpoint(
      environmentValue(environment, "ACCESS_GATEWAY_OCI_KMS_MANAGEMENT_ENDPOINT"),
      region,
      "management",
    ),
    pepperSecretId: validOcid(
      environmentValue(environment, "ACCESS_GATEWAY_OCI_PEPPER_SECRET_ID"),
      "vaultsecret",
    ),
  });
}

function publicJwkForPem(pem: string): Readonly<{ readonly jwk: PublicJwk; readonly key: KeyObject }> {
  const key = createPublicKey(pem);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048
  ) {
    throw new TypeError("OCI KMS JWT key must be RSA with at least 2048 bits.");
  }
  const exported = key.export({ format: "jwk" });
  if (exported.kty !== "RSA" || typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new TypeError("OCI KMS public key is invalid.");
  }
  const kid = createHash("sha256")
    .update(`logistics-mcp-rs256\u0000${exported.n}\u0000${exported.e}`, "utf8")
    .digest("base64url");
  return Object.freeze({
    key,
    jwk: Object.freeze({
      kty: "RSA",
      kid,
      alg: "RS256",
      use: "sig",
      n: exported.n,
      e: exported.e,
    }),
  });
}

async function loadKmsPublicKey(input: Readonly<{
  client: OciKmsManagementClient;
  keyId: string;
  keyVersionId: string;
}>): Promise<Readonly<{ readonly jwk: PublicJwk; readonly key: KeyObject }>> {
  const response = await input.client.getKeyVersion({
    keyId: input.keyId,
    keyVersionId: input.keyVersionId,
  });
  const version = response.keyVersion;
  if (version.keyId !== input.keyId || version.id !== input.keyVersionId) {
    throw new Error("OCI KMS returned unexpected public key identity.");
  }
  if (version.lifecycleState !== "ENABLED") {
    throw new Error("OCI KMS key version is not enabled.");
  }
  if (typeof version.publicKey !== "string" || version.publicKey.length > 16 * 1024) {
    throw new Error("OCI KMS public key is unavailable.");
  }
  return publicJwkForPem(version.publicKey);
}

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error(`${label} is invalid.`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`${label} is invalid.`);
  return new Uint8Array(decoded);
}

async function loadPepper(input: Readonly<{
  client: OciSecretsClient;
  secretId: string;
  version: string;
  active: boolean;
}>): Promise<Uint8Array> {
  const response = await input.client.getSecretBundle({
    secretId: input.secretId,
    secretVersionName: input.version,
  });
  const bundle = response.secretBundle;
  if (bundle.secretId !== input.secretId || bundle.versionName !== input.version) {
    throw new Error("OCI Vault returned unexpected secret identity.");
  }
  if (input.active && !bundle.stages?.includes("CURRENT")) {
    throw new Error("OCI Vault active pepper is not the CURRENT secret version.");
  }
  const content = bundle.secretBundleContent;
  if (
    content?.contentType !== "BASE64" ||
    typeof content.content !== "string" ||
    content.content.length > 1_024
  ) {
    throw new Error("OCI Vault secret content is unavailable.");
  }
  const pepper = decodeCanonicalBase64(content.content, "OCI Vault secret content");
  if (pepper.byteLength < 32 || pepper.byteLength > 256) {
    throw new Error("OCI Vault pepper size is invalid.");
  }
  return pepper;
}

export class OciVaultSecretPepperProvider implements SecretPepperProvider {
  readonly kind = "production" as const;
  readonly pepperVersion: string;
  readonly #peppers: ReadonlyMap<string, Uint8Array>;

  constructor(activePepperVersion: string, peppers: ReadonlyMap<string, Uint8Array>) {
    if (!validCredentialPepperVersion(activePepperVersion) || !peppers.has(activePepperVersion)) {
      throw new TypeError("OCI Vault active pepper version is invalid.");
    }
    this.pepperVersion = activePepperVersion;
    this.#peppers = new Map([...peppers].map(([version, pepper]) => [
      version,
      new Uint8Array(pepper),
    ]));
  }

  supportsPepperVersion(version: string): boolean {
    return this.#peppers.has(version);
  }

  hashCredentialSecret(input: Readonly<{
    secret: string;
    salt: Uint8Array;
    pepperVersion: string;
  }>): Promise<Uint8Array> {
    const pepper = this.#peppers.get(input.pepperVersion);
    if (
      input.pepperVersion !== this.pepperVersion ||
      pepper === undefined ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.secret) ||
      !(input.salt instanceof Uint8Array) ||
      input.salt.byteLength < 16 ||
      input.salt.byteLength > 64
    ) {
      return Promise.reject(new TypeError("Credential derivation input is invalid."));
    }
    return deriveCredentialSecretHash(input.secret, input.salt, pepper);
  }

  async verifyCredentialSecret(input: Readonly<{
    secret: string;
    material: Readonly<{
      salt: Uint8Array;
      expectedHash: Uint8Array;
      pepperVersion: string;
    }> | null;
  }>): Promise<boolean> {
    const material = input.material;
    const selectedPepper = material === null
      ? undefined
      : this.#peppers.get(material.pepperVersion);
    const activePepper = this.#peppers.get(this.pepperVersion)!;
    const structurallyValid = material !== null &&
      selectedPepper !== undefined &&
      material.salt instanceof Uint8Array &&
      material.salt.byteLength >= 16 &&
      material.salt.byteLength <= 64 &&
      material.expectedHash instanceof Uint8Array &&
      material.expectedHash.byteLength === DERIVED_HASH_BYTES &&
      /^[A-Za-z0-9_-]{43}$/u.test(input.secret);
    const candidate = await deriveCredentialSecretHash(
      /^[A-Za-z0-9_-]{43}$/u.test(input.secret) ? input.secret : "_".repeat(43),
      structurallyValid ? material.salt : DUMMY_SALT,
      structurallyValid && selectedPepper !== undefined ? selectedPepper : activePepper,
    );
    const expected = structurallyValid ? material.expectedHash : DUMMY_HASH;
    return structurallyValid && timingSafeEqual(candidate, expected);
  }
}

export class OciKmsJwtSigningProvider implements JwtSigningProvider {
  readonly kind = "production" as const;
  readonly #client: OciKmsCryptoClient;
  readonly #keyId: string;
  readonly #currentKeyVersionId: string;
  readonly #currentPublicKey: KeyObject;
  readonly #jwks: JwksResponse;

  constructor(input: Readonly<{
    client: OciKmsCryptoClient;
    keyId: string;
    currentKeyVersionId: string;
    current: Readonly<{ readonly jwk: PublicJwk; readonly key: KeyObject }>;
    previous?: Readonly<{ readonly jwk: PublicJwk; readonly key: KeyObject }>;
  }>) {
    if (input.previous?.jwk.kid === input.current.jwk.kid) {
      throw new TypeError("OCI KMS current and previous public keys must be different.");
    }
    this.#client = input.client;
    this.#keyId = input.keyId;
    this.#currentKeyVersionId = input.currentKeyVersionId;
    this.#currentPublicKey = input.current.key;
    this.#jwks = Object.freeze({
      keys: Object.freeze([
        input.current.jwk,
        ...(input.previous === undefined ? [] : [input.previous.jwk]),
      ]),
    });
  }

  async #signBytes(message: Uint8Array, operation: "jwt-sign" | "startup-self-test"): Promise<string> {
    if (message.byteLength < 1 || message.byteLength > MAX_OCI_MESSAGE_BYTES) {
      throw new Error("OCI KMS signing message size is invalid.");
    }
    const response = await this.#client.sign({
      signDataDetails: {
        message: Buffer.from(message).toString("base64"),
        keyId: this.#keyId,
        keyVersionId: this.#currentKeyVersionId,
        messageType: OCI_MESSAGE_TYPE,
        signingAlgorithm: OCI_SIGNING_ALGORITHM,
        loggingContext: Object.freeze({
          component: "logistics-mcp-access-gateway",
          operation,
        }),
      },
    });
    const signed = response.signedData;
    if (signed.keyId !== this.#keyId) throw new Error("OCI KMS returned an unexpected key.");
    if (signed.keyVersionId !== this.#currentKeyVersionId) {
      throw new Error("OCI KMS returned an unexpected key version.");
    }
    if (signed.signingAlgorithm !== OCI_SIGNING_ALGORITHM) {
      throw new Error("OCI KMS returned an unexpected algorithm.");
    }
    const signature = decodeCanonicalBase64(signed.signature, "OCI KMS signature");
    if (!verifySignature("RSA-SHA256", message, this.#currentPublicKey, signature)) {
      throw new Error("OCI KMS signature verification failed.");
    }
    return Buffer.from(signature).toString("base64url");
  }

  async selfTest(): Promise<void> {
    await this.#signBytes(
      Buffer.from("logistics-mcp-access-gateway/oci-kms-self-test/v1", "utf8"),
      "startup-self-test",
    );
  }

  async sign(claims: JwtClaims): Promise<SignedJwt> {
    const key = this.#jwks.keys[0];
    if (key === undefined) throw new Error("OCI KMS JWT public key is unavailable.");
    const encodedHeader = Buffer.from(JSON.stringify({
      alg: "RS256",
      kid: key.kid,
      typ: "JWT",
    }), "utf8").toString("base64url");
    const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
    const signature = await this.#signBytes(signingInput, "jwt-sign");
    return Object.freeze({
      token: `${encodedHeader}.${encodedPayload}.${signature}`,
      kid: key.kid,
    });
  }

  getJwks(): Promise<JwksResponse> {
    return Promise.resolve(this.#jwks);
  }
}

export interface CreateOciGatewayCryptoProvidersOptions {
  readonly cryptoClient: OciKmsCryptoClient;
  readonly managementClient: OciKmsManagementClient;
  readonly secretsClient: OciSecretsClient;
  readonly keyId: string;
  readonly currentKeyVersionId: string;
  readonly previousKeyVersionId?: string;
  readonly pepperSecretId: string;
  readonly activePepperVersion: string;
  readonly requiredPepperVersions: readonly string[];
  readonly performSigningSelfTest?: boolean;
  readonly closeClients?: () => void | Promise<void>;
}

export interface OciGatewayCryptoProviders {
  readonly signer: OciKmsJwtSigningProvider;
  readonly pepper: OciVaultSecretPepperProvider;
  close(): Promise<void>;
}

async function closeClients(options: CreateOciGatewayCryptoProvidersOptions): Promise<void> {
  if (options.closeClients !== undefined) {
    await options.closeClients();
    return;
  }
  const clients = new Set<Readonly<{ close?: () => void | Promise<void> }>>([
    options.cryptoClient,
    options.managementClient,
    options.secretsClient,
  ]);
  await Promise.all([...clients].map(async (client) => client.close?.()));
}

export async function createOciGatewayCryptoProviders(
  options: CreateOciGatewayCryptoProvidersOptions,
): Promise<OciGatewayCryptoProviders> {
  if (!validCredentialPepperVersion(options.activePepperVersion)) {
    throw new TypeError("OCI Vault active pepper version is invalid.");
  }
  const versions = [...new Set(options.requiredPepperVersions)];
  if (
    versions.length !== options.requiredPepperVersions.length ||
    versions.length < 1 ||
    versions.length > MAX_RETAINED_PEPPERS ||
    !versions.includes(options.activePepperVersion) ||
    versions.some((version) => !validCredentialPepperVersion(version))
  ) {
    throw new TypeError("OCI Vault required pepper versions are invalid.");
  }
  try {
    const current = await loadKmsPublicKey({
      client: options.managementClient,
      keyId: options.keyId,
      keyVersionId: options.currentKeyVersionId,
    });
    const previous = options.previousKeyVersionId === undefined
      ? undefined
      : await loadKmsPublicKey({
          client: options.managementClient,
          keyId: options.keyId,
          keyVersionId: options.previousKeyVersionId,
        });
    const pepperEntries = await Promise.all(versions.map(async (version) => [
      version,
      await loadPepper({
        client: options.secretsClient,
        secretId: options.pepperSecretId,
        version,
        active: version === options.activePepperVersion,
      }),
    ] as const));
    const pepper = new OciVaultSecretPepperProvider(
      options.activePepperVersion,
      new Map(pepperEntries),
    );
    const signer = new OciKmsJwtSigningProvider({
      client: options.cryptoClient,
      keyId: options.keyId,
      currentKeyVersionId: options.currentKeyVersionId,
      current,
      ...(previous === undefined ? {} : { previous }),
    });
    if (options.performSigningSelfTest !== false) await signer.selfTest();
    let closed = false;
    return Object.freeze({
      signer,
      pepper,
      close: async () => {
        if (closed) return;
        closed = true;
        await closeClients(options);
      },
    });
  } catch (error) {
    await closeClients(options).catch(() => undefined);
    throw error;
  }
}

export async function createOciSdkGatewayCryptoProviders(input: Readonly<{
  configuration: OciCryptoConfiguration;
  activePepperVersion: string;
  requiredPepperVersions: readonly string[];
}>): Promise<OciGatewayCryptoProviders> {
  const common = await import("oci-common");
  const keyManagement = await import("oci-keymanagement");
  const secrets = await import("oci-secrets");
  const authenticationDetailsProvider = await new common
    .InstancePrincipalsAuthenticationDetailsProviderBuilder()
    .build();
  const cryptoClient = new keyManagement.KmsCryptoClient({ authenticationDetailsProvider });
  const managementClient = new keyManagement.KmsManagementClient({ authenticationDetailsProvider });
  const secretsClient = new secrets.SecretsClient({ authenticationDetailsProvider });
  cryptoClient.endpoint = input.configuration.cryptoEndpoint;
  managementClient.endpoint = input.configuration.managementEndpoint;
  secretsClient.regionId = input.configuration.region;
  return createOciGatewayCryptoProviders({
    cryptoClient: {
      sign: async (request) => cryptoClient.sign(
        request as Parameters<typeof cryptoClient.sign>[0],
      ),
    },
    managementClient: {
      getKeyVersion: async (request) => managementClient.getKeyVersion(request),
    },
    secretsClient: {
      getSecretBundle: async (request) => secretsClient.getSecretBundle(request),
    },
    keyId: input.configuration.keyId,
    currentKeyVersionId: input.configuration.currentKeyVersionId,
    ...(input.configuration.previousKeyVersionId === undefined
      ? {}
      : { previousKeyVersionId: input.configuration.previousKeyVersionId }),
    pepperSecretId: input.configuration.pepperSecretId,
    activePepperVersion: input.activePepperVersion,
    requiredPepperVersions: input.requiredPepperVersions,
    closeClients: () => {
      cryptoClient.close();
      managementClient.close();
      secretsClient.close();
    },
  });
}
