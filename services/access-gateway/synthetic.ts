import {
  createHash,
  generateKeyPairSync,
  scryptSync,
  sign as signBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

import {
  ACCESS_GATEWAY_SCHEMA_VERSION,
  T0_TOOL_NAMES,
  type AccessState,
  type AdminPrincipal,
  type AuditEvent,
  type ClientRecord,
  type ExactToolScope,
  type GatewayOptions,
  type JwksResponse,
  type JwtClaims,
  type PublicJwk,
  type StoredCredentialRecord,
  type T0ToolName,
  type TenantRecord,
} from "./contracts";
import type {
  AdminIdentityProvider,
  CredentialExchangeRecord,
  CredentialRepository,
  GatewayAuditRepository,
  GatewayClock,
  GatewayProviders,
  GatewayRandomSource,
  JwtSigningProvider,
  RateLimitRepository,
  RevocationRepository,
  SecretPepperProvider,
} from "./ports";
import { createAccessGateway } from "./service";

class SyntheticClock implements GatewayClock {
  readonly kind = "synthetic" as const;
  constructor(private readonly seconds: number) {}
  nowSeconds(): number {
    return this.seconds;
  }
}

class SyntheticRandomSource implements GatewayRandomSource {
  readonly kind = "synthetic" as const;
  private counter = 0;

  opaque(prefix: "req" | "auth" | "jwt" | "audit" | "tenant" | "client" | "key"): string {
    this.counter += 1;
    const value = createHash("sha256")
      .update(`synthetic-local-only:${this.counter}`, "utf8")
      .digest("base64url")
      .slice(0, 24);
    return `${prefix}_${value}`;
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 1 || length > 64) {
      throw new RangeError("Synthetic random byte request is invalid.");
    }
    this.counter += 1;
    const digest = createHash("sha512")
      .update(`synthetic-local-only:${this.counter}`, "utf8")
      .digest();
    return new Uint8Array(digest.subarray(0, length));
  }
}

class SyntheticPepperProvider implements SecretPepperProvider {
  readonly kind = "synthetic" as const;
  readonly version = "synthetic-pepper-v1";
  readonly #pepper = Buffer.from("local-test-pepper-not-for-production", "utf8");
  readonly #dummySalt = createHash("sha256")
    .update("synthetic-access-gateway-dummy-salt", "utf8")
    .digest()
    .subarray(0, 16);
  readonly #dummyHash: Uint8Array;
  verificationCount = 0;

  constructor() {
    this.#dummyHash = this.#derive(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      this.#dummySalt,
    );
  }

  #derive(secret: string, saltBytes: Uint8Array): Uint8Array {
    const salt = Buffer.concat([Buffer.from(saltBytes), this.#pepper]);
    return new Uint8Array(scryptSync(secret, salt, 32, {
      N: 1 << 14,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }));
  }

  hashCredentialSecret(input: Readonly<{
    secret: string;
    salt: Uint8Array;
    pepperVersion: string;
  }>): Promise<Uint8Array> {
    if (input.pepperVersion !== this.version) return Promise.reject(new Error("Unknown pepper version."));
    return Promise.resolve(this.#derive(input.secret, input.salt));
  }

  async verifyCredentialSecret(input: Readonly<{
    secret: string;
    material: Readonly<{
      salt: Uint8Array;
      expectedHash: Uint8Array;
      pepperVersion: string;
    }> | null;
  }>): Promise<boolean> {
    this.verificationCount += 1;
    const material = input.material ?? {
      salt: this.#dummySalt,
      expectedHash: this.#dummyHash,
      pepperVersion: this.version,
    };
    const candidate = await this.hashCredentialSecret({
      secret: input.secret,
      salt: material.salt,
      pepperVersion: material.pepperVersion,
    });
    const hashMatches = candidate.byteLength === material.expectedHash.byteLength
      && timingSafeEqual(candidate, material.expectedHash);
    return input.material !== null && hashMatches;
  }
}

class SyntheticCredentialRepository implements CredentialRepository {
  readonly kind = "synthetic" as const;
  readonly tenants = new Map<string, TenantRecord>();
  readonly clients = new Map<string, ClientRecord>();
  readonly credentials = new Map<string, StoredCredentialRecord>();

  constructor(private readonly nowSeconds: number) {}

  findForExchange(credentialId: string): Promise<CredentialExchangeRecord | null> {
    const credential = this.credentials.get(credentialId);
    if (credential === undefined) return Promise.resolve(null);
    const tenant = this.tenants.get(credential.tenantId);
    const client = this.clients.get(credential.clientId);
    return Promise.resolve(
      tenant === undefined || client === undefined
        ? null
        : { tenant, client, credential },
    );
  }

  listState(): Promise<AccessState> {
    return Promise.resolve({
      tenants: [...this.tenants.values()],
      clients: [...this.clients.values()],
      credentials: [...this.credentials.values()].map((credential) => ({
        credentialId: credential.credentialId,
        tenantId: credential.tenantId,
        clientId: credential.clientId,
        label: credential.label,
        actorRole: credential.actorRole,
        roles: credential.roles,
        toolNames: credential.toolNames,
        scopes: credential.scopes,
        status: credential.status,
        deliveryStatus: credential.deliveryStatus,
        deliveryAcknowledgedAt: credential.deliveryAcknowledgedAt,
        effectiveStatus: credential.status === "revoked"
          ? "revoked"
          : credential.expiresAt <= this.nowSeconds
            ? "expired"
            : this.tenants.get(credential.tenantId)?.status === "suspended"
              ? "tenant_suspended"
              : this.clients.get(credential.clientId)?.status === "disabled"
                ? "client_disabled"
                : credential.deliveryStatus === "pending"
                  ? "pending_delivery"
                  : "active",
        keyPrefix: credential.keyPrefix,
        secretLastFour: credential.secretLastFour,
        pepperVersion: credential.pepperVersion,
        createdAt: credential.createdAt,
        expiresAt: credential.expiresAt,
        lastUsedAt: credential.lastUsedAt,
        revokedAt: credential.revokedAt,
        rotatedFromId: credential.rotatedFromId,
        version: credential.version,
      })),
      operations: [],
    });
  }

  markUsed(credentialId: string, usedAt: string, nowSeconds: number): Promise<boolean> {
    const credential = this.credentials.get(credentialId);
    if (
      credential === undefined ||
      credential.status !== "active" ||
      credential.deliveryStatus !== "acknowledged" ||
      credential.expiresAt <= nowSeconds
    ) {
      return Promise.resolve(false);
    }
    this.credentials.set(credentialId, Object.freeze({ ...credential, lastUsedAt: usedAt }));
    return Promise.resolve(true);
  }
}

interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: PublicJwk;
}

function makeSigningKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  if (exported.kty !== "RSA" || typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("Synthetic RSA public key export failed.");
  }
  return {
    kid,
    privateKey,
    publicJwk: {
      kty: "RSA",
      kid,
      alg: "RS256",
      use: "sig",
      n: exported.n,
      e: exported.e,
    },
  };
}

export class SyntheticJwtSigner implements JwtSigningProvider {
  readonly kind = "synthetic" as const;
  signCount = 0;
  private generation = 1;
  private current = makeSigningKey("synthetic-key-0001");
  private previous: SigningKey | null = null;

  sign(claims: JwtClaims): Promise<{ readonly token: string; readonly kid: string }> {
    this.signCount += 1;
    const header = Buffer.from(JSON.stringify({
      alg: "RS256",
      kid: this.current.kid,
      typ: "JWT",
    }), "utf8").toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = signBytes("RSA-SHA256", Buffer.from(signingInput, "ascii"), this.current.privateKey)
      .toString("base64url");
    return Promise.resolve({ token: `${signingInput}.${signature}`, kid: this.current.kid });
  }

  getJwks(): Promise<JwksResponse> {
    return Promise.resolve({
      keys: [this.current.publicJwk, ...(this.previous === null ? [] : [this.previous.publicJwk])],
    });
  }

  rotate(): Promise<PublicJwk> {
    this.generation += 1;
    this.previous = this.current;
    this.current = makeSigningKey(`synthetic-key-${String(this.generation).padStart(4, "0")}`);
    return Promise.resolve(this.current.publicJwk);
  }
}

export class SyntheticAuditRepository implements GatewayAuditRepository {
  readonly kind = "synthetic" as const;
  readonly events: AuditEvent[] = [];
  private fail = false;

  failNext(): void {
    this.fail = true;
  }

  append(event: AuditEvent): Promise<void> {
    if (this.fail) {
      this.fail = false;
      return Promise.reject(new Error("Synthetic audit failure."));
    }
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }
}

export class SyntheticRateLimitRepository implements RateLimitRepository {
  readonly kind = "synthetic" as const;
  private deny = false;

  denyNext(): void {
    this.deny = true;
  }

  reserve(): Promise<boolean> {
    if (this.deny) {
      this.deny = false;
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }
}

export class SyntheticRevocationRepository implements RevocationRepository {
  readonly kind = "synthetic" as const;
  private readonly credentialIds = new Set<string>();

  revokeCredential(credentialId: string): void {
    this.credentialIds.add(credentialId);
  }

  isRevoked(input: Readonly<{ credentialId: string }>): Promise<boolean> {
    return Promise.resolve(this.credentialIds.has(input.credentialId));
  }
}

class SyntheticAdminIdentityProvider implements AdminIdentityProvider {
  readonly kind = "synthetic" as const;
  authenticateAdmin(): Promise<AdminPrincipal> {
    return Promise.resolve({
      tenantId: "tenant_management_synthetic",
      actorId: "actor_admin_synthetic",
      role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin", "tenant:admin"],
    });
  }
}

export interface SyntheticFixtureOptions extends GatewayOptions {
  readonly nowSeconds?: number;
}

export interface SeedCredentialInput {
  readonly toolNames: readonly T0ToolName[];
  readonly acknowledged?: boolean;
}

export interface SeededCredential {
  readonly tenantId: string;
  readonly clientId: string;
  readonly credentialId: string;
  readonly apiKey: string;
}

export function createSyntheticAccessGatewayFixture(options: SyntheticFixtureOptions = {}) {
  const nowSeconds = options.nowSeconds ?? 1_787_760_000;
  const randomSource = new SyntheticRandomSource();
  const pepper = new SyntheticPepperProvider();
  const repository = new SyntheticCredentialRepository(nowSeconds);
  const signer = new SyntheticJwtSigner();
  const audit = new SyntheticAuditRepository();
  const rateLimit = new SyntheticRateLimitRepository();
  const revocation = new SyntheticRevocationRepository();
  const providers = {
    adminIdentityProvider: new SyntheticAdminIdentityProvider(),
    auditRepository: audit,
    clock: new SyntheticClock(nowSeconds),
    credentialRepository: repository,
    jwtSigningProvider: signer,
    randomSource,
    rateLimitRepository: rateLimit,
    revocationRepository: revocation,
    secretPepperProvider: pepper,
  } satisfies GatewayProviders;
  const gateway = createAccessGateway(providers, options);

  const seedCredential = async (input: SeedCredentialInput): Promise<SeededCredential> => {
    if (
      input.toolNames.length === 0 ||
      new Set(input.toolNames).size !== input.toolNames.length ||
      input.toolNames.some((toolName) => !T0_TOOL_NAMES.includes(toolName))
    ) {
      throw new TypeError("Synthetic credential tools must be an exact T0 subset.");
    }
    const tenantId = randomSource.opaque("tenant");
    const clientId = randomSource.opaque("client");
    const credentialId = randomSource.opaque("key");
    const createdAt = new Date(nowSeconds * 1_000).toISOString();
    const secretBytes = randomSource.bytes(32);
    let secret = Buffer.from(secretBytes).toString("base64url");
    if (secret.endsWith("B")) secret = `${secret.slice(0, -1)}A`;
    const salt = randomSource.bytes(16);
    const secretHash = await pepper.hashCredentialSecret({
      secret,
      salt,
      pepperVersion: pepper.version,
    });
    const acknowledged = input.acknowledged ?? false;
    repository.tenants.set(tenantId, {
      tenantId,
      displayName: "Synthetic tenant",
      status: "active",
      createdAt,
      updatedAt: createdAt,
      version: 1,
    });
    repository.clients.set(clientId, {
      clientId,
      tenantId,
      label: "Synthetic client",
      status: "active",
      createdAt,
      updatedAt: createdAt,
      version: 1,
    });
    const normalized = T0_TOOL_NAMES.filter((toolName) => input.toolNames.includes(toolName));
    repository.credentials.set(credentialId, {
      credentialId,
      tenantId,
      clientId,
      label: "Synthetic key",
      actorRole: "service",
      roles: ["service"],
      toolNames: normalized,
      scopes: normalized.map((toolName): ExactToolScope => `tool:${toolName}`),
      status: "active",
      deliveryStatus: acknowledged ? "acknowledged" : "pending",
      deliveryAcknowledgedAt: acknowledged ? createdAt : null,
      keyPrefix: `lmcpk_${credentialId}`,
      secretLastFour: secret.slice(-4),
      secretSalt: salt,
      secretHash,
      pepperVersion: pepper.version,
      createdAt,
      expiresAt: nowSeconds + 86_400,
      lastUsedAt: null,
      revokedAt: null,
      rotatedFromId: null,
      version: 1,
    });
    return {
      tenantId,
      clientId,
      credentialId,
      apiKey: `lmcpk_${credentialId}_${secret}`,
    };
  };

  return Object.freeze({
    profile: "synthetic-local-test" as const,
    schemaVersion: ACCESS_GATEWAY_SCHEMA_VERSION,
    providers,
    gateway,
    audit,
    rateLimit,
    revocation,
    signer,
    pepper,
    seedCredential,
    seedAcknowledgedCredential: (input: Omit<SeedCredentialInput, "acknowledged">) =>
      seedCredential({ ...input, acknowledged: true }),
  });
}
