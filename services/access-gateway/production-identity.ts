import { randomBytes, randomUUID } from "node:crypto";

import {
  createProductionTokenVerifier,
  type ProductionTokenVerifierOptions,
} from "../../src/logistics_mcp/server/production-token-verifier";
import type { AdminPrincipal } from "./contracts";
import type {
  AdminIdentityProvider,
  GatewayClock,
  GatewayRandomSource,
} from "./ports";

export class SystemGatewayClock implements GatewayClock {
  readonly kind = "production" as const;

  nowSeconds(): number {
    return Math.floor(Date.now() / 1_000);
  }
}

export class SystemGatewayRandomSource implements GatewayRandomSource {
  readonly kind = "production" as const;

  opaque(prefix: "req" | "auth" | "jwt" | "audit" | "tenant" | "client" | "key"): string {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 1 || length > 1024) {
      throw new RangeError("Random byte length is invalid.");
    }
    return new Uint8Array(randomBytes(length));
  }
}

export class UnavailableAdminIdentityProvider implements AdminIdentityProvider {
  readonly kind = "production" as const;

  authenticateAdmin(): Promise<never> {
    return Promise.reject(new Error("Enterprise administrator identity is unavailable."));
  }

  health(): Promise<{ readonly ready: false }> {
    return Promise.resolve(Object.freeze({ ready: false as const }));
  }
}

export interface RemoteJwksAdminIdentityProviderOptions {
  readonly jwksUrl: string;
  readonly allowedHosts: readonly string[];
  readonly issuer: string;
  readonly audience: string;
  readonly managementTenantId: string;
  readonly maxTokenAgeSeconds?: number;
  readonly claimMode?: "embedded-admin-claims" | "cloudflare-access";
  readonly allowedEmails?: readonly string[];
  readonly allowedSubjects?: readonly string[];
  readonly fetchImpl?: ProductionTokenVerifierOptions["fetchImpl"];
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function audienceMatches(value: unknown, expected: string): boolean {
  return value === expected ||
    (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string") &&
      value.includes(expected));
}

function exactAllowlist(
  values: readonly string[] | undefined,
  label: string,
  normalize: (value: string) => string,
  required: boolean,
): ReadonlySet<string> | null {
  if (values === undefined) {
    if (required) throw new TypeError(`${label} allowlist is required.`);
    return null;
  }
  if (values.length === 0 || values.length > 128) {
    throw new TypeError(`${label} allowlist must contain from 1 through 128 entries.`);
  }
  const normalized = new Set<string>();
  for (const value of values) {
    if (value.length === 0 || value.length > 512 || value.trim() !== value) {
      throw new TypeError(`${label} allowlist contains an invalid entry.`);
    }
    const entry = normalize(value);
    if (normalized.has(entry)) {
      throw new TypeError(`${label} allowlist contains duplicate entries.`);
    }
    normalized.add(entry);
  }
  return normalized;
}

export class RemoteJwksAdminIdentityProvider implements AdminIdentityProvider {
  readonly kind = "production" as const;
  readonly #verifier: ReturnType<typeof createProductionTokenVerifier>;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #managementTenantId: string;
  readonly #maxTokenAgeSeconds: number;
  readonly #claimMode: "embedded-admin-claims" | "cloudflare-access";
  readonly #allowedEmails: ReadonlySet<string> | null;
  readonly #allowedSubjects: ReadonlySet<string> | null;

  constructor(options: RemoteJwksAdminIdentityProviderOptions) {
    if (
      !options.issuer.startsWith("https://") ||
      options.audience.length === 0 ||
      options.managementTenantId.length === 0
    ) {
      throw new TypeError("Administrator identity policy is invalid.");
    }
    const maxAge = options.maxTokenAgeSeconds ?? 900;
    if (!Number.isSafeInteger(maxAge) || maxAge < 60 || maxAge > 3_600) {
      throw new TypeError("Administrator token age must be from 60 through 3600 seconds.");
    }
    const claimMode = options.claimMode ?? "embedded-admin-claims";
    if (claimMode !== "embedded-admin-claims" && claimMode !== "cloudflare-access") {
      throw new TypeError("Administrator identity claim mode is invalid.");
    }
    if (
      claimMode === "embedded-admin-claims" &&
      (options.allowedEmails !== undefined || options.allowedSubjects !== undefined)
    ) {
      throw new TypeError("Administrator allowlists require Cloudflare Access claim mode.");
    }
    const allowedEmails = exactAllowlist(
      options.allowedEmails,
      "Administrator email",
      (value) => value.toLowerCase(),
      claimMode === "cloudflare-access",
    );
    if (
      allowedEmails !== null &&
      [...allowedEmails].some((value) => !/^[^@\s]+@[^@\s]+$/u.test(value) || value.length > 320)
    ) {
      throw new TypeError("Administrator email allowlist contains an invalid email.");
    }
    const allowedSubjects = exactAllowlist(
      options.allowedSubjects,
      "Administrator subject",
      (value) => value,
      false,
    );
    this.#verifier = createProductionTokenVerifier({
      jwksUrl: options.jwksUrl,
      allowedHosts: options.allowedHosts,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#managementTenantId = options.managementTenantId;
    this.#maxTokenAgeSeconds = maxAge;
    this.#claimMode = claimMode;
    this.#allowedEmails = allowedEmails;
    this.#allowedSubjects = allowedSubjects;
  }

  async authenticateAdmin(token: string): Promise<AdminPrincipal> {
    const claims = await this.#verifier.verify(token);
    const now = Math.floor(Date.now() / 1_000);
    const roles = stringArray(claims.roles);
    const scopes = stringArray(claims.scopes);
    const subject = typeof claims.sub === "string" ? claims.sub : "";
    const issuedAt = claims.iat;
    const expiresAt = claims.exp;
    const notBefore = claims.nbf;
    if (
      claims.iss !== this.#issuer ||
      !audienceMatches(claims.aud, this.#audience) ||
      subject.length === 0 ||
      subject.length > 512 ||
      subject.trim() !== subject ||
      typeof issuedAt !== "number" ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt > now + 30 ||
      now - issuedAt > this.#maxTokenAgeSeconds ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > this.#maxTokenAgeSeconds ||
      (notBefore !== undefined && (
        typeof notBefore !== "number" ||
        !Number.isSafeInteger(notBefore) ||
        notBefore > now + 30
      ))
    ) {
      throw new Error("Administrator token claims are invalid.");
    }
    if (this.#claimMode === "embedded-admin-claims") {
      if (
        claims.tenant_id !== this.#managementTenantId ||
        claims.actor_role !== "admin" ||
        roles === null ||
        !roles.includes("admin") ||
        scopes === null ||
        !scopes.includes("platform:admin") ||
        !scopes.includes("tenant:admin")
      ) {
        throw new Error("Administrator token claims are invalid.");
      }
    } else {
      const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
      if (
        claims.type !== "app" ||
        this.#allowedEmails === null ||
        !this.#allowedEmails.has(email) ||
        (this.#allowedSubjects !== null && !this.#allowedSubjects.has(subject))
      ) {
        throw new Error("Administrator token claims are invalid.");
      }
    }
    return Object.freeze({
      tenantId: this.#managementTenantId,
      actorId: subject,
      role: "admin",
      roles: Object.freeze(["admin"] as const),
      scopes: Object.freeze(["platform:admin", "tenant:admin"] as const),
    });
  }

  health(): Promise<{ readonly ready: boolean }> {
    return this.#verifier.health();
  }

  close(): Promise<void> {
    return this.#verifier.close();
  }
}
