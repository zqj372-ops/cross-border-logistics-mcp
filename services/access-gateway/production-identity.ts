import { randomBytes, randomUUID } from "node:crypto";

import { createProductionTokenVerifier } from "../../src/logistics_mcp/server/production-token-verifier";
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

export class RemoteJwksAdminIdentityProvider implements AdminIdentityProvider {
  readonly kind = "production" as const;
  readonly #verifier: ReturnType<typeof createProductionTokenVerifier>;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #managementTenantId: string;
  readonly #maxTokenAgeSeconds: number;

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
    this.#verifier = createProductionTokenVerifier({
      jwksUrl: options.jwksUrl,
      allowedHosts: options.allowedHosts,
    });
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#managementTenantId = options.managementTenantId;
    this.#maxTokenAgeSeconds = maxAge;
  }

  async authenticateAdmin(token: string): Promise<AdminPrincipal> {
    const claims = await this.#verifier.verify(token);
    const now = Math.floor(Date.now() / 1_000);
    const roles = stringArray(claims.roles);
    const scopes = stringArray(claims.scopes);
    if (
      claims.iss !== this.#issuer ||
      !audienceMatches(claims.aud, this.#audience) ||
      claims.tenant_id !== this.#managementTenantId ||
      claims.actor_role !== "admin" ||
      typeof claims.sub !== "string" ||
      claims.sub.length === 0 ||
      typeof claims.iat !== "number" ||
      !Number.isSafeInteger(claims.iat) ||
      claims.iat > now + 30 ||
      now - claims.iat > this.#maxTokenAgeSeconds ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= now ||
      claims.exp - claims.iat > this.#maxTokenAgeSeconds ||
      roles === null ||
      !roles.includes("admin") ||
      scopes === null ||
      !scopes.includes("platform:admin") ||
      !scopes.includes("tenant:admin")
    ) {
      throw new Error("Administrator token claims are invalid.");
    }
    return Object.freeze({
      tenantId: this.#managementTenantId,
      actorId: claims.sub,
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
