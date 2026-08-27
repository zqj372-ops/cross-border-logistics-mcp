import { z } from "zod";
import { isDeepStrictEqual } from "node:util";

import { canonicalJsonHash } from "./canonical-json";
import {
  ACCESS_GATEWAY_SCHEMA_VERSION,
  T0_TOOL_NAMES,
  type ErrorResponse,
  type ExactToolScope,
  type ExchangeInput,
  type ExchangeRequest,
  type ExchangeSuccessResponse,
  type GatewayOptions,
  type JwksResponse,
  type JwtClaims,
  type T0ToolName,
} from "./contracts";
import { AccessGatewayError, asUnavailableError } from "./errors";
import type { GatewayProviders } from "./ports";

const t0ToolNameSchema = z.enum(T0_TOOL_NAMES);
const exchangeRequestSchema = z.object({
  schema_version: z.literal(ACCESS_GATEWAY_SCHEMA_VERSION),
  requested_tool_names: z.array(t0ToolNameSchema).min(1).max(3).refine(
    (values) => new Set(values).size === values.length,
  ),
}).strict();
const apiKeyPattern = /^lmcpk_([A-Za-z0-9][A-Za-z0-9_-]{2,127})_([A-Za-z0-9_-]{43})$/u;
const requestIdPattern = /^req_[A-Za-z0-9_-]{8,128}$/u;
const publicJwkSchema = z.object({
  kty: z.literal("RSA"),
  kid: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  alg: z.literal("RS256"),
  use: z.literal("sig"),
  n: z.string().regex(/^[A-Za-z0-9_-]{128,1024}$/u),
  e: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/u),
}).strict();
const jwksSchema = z.object({
  keys: z.array(publicJwkSchema).min(1).max(2),
}).strict().refine(
  ({ keys }) => new Set(keys.map(({ kid }) => kid)).size === keys.length,
  { message: "JWKS key IDs must be unique." },
);
const jwtHeaderSchema = z.object({
  alg: z.literal("RS256"),
  kid: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  typ: z.literal("JWT"),
}).strict();
const exactToolScopeSchema = z.enum([
  "tool:cargo.calculate",
  "tool:container.plan_summary",
  "tool:system.agent_context.get",
]);
const jwtClaimsSchema = z.object({
  iss: z.string().url(),
  aud: z.string().min(1).max(256),
  sub: z.string().min(1).max(256),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1).max(256),
  tenant_id: z.string().min(1).max(256),
  actor_id: z.string().min(1).max(256),
  actor_role: z.literal("service"),
  roles: z.tuple([z.literal("service")]),
  scopes: z.array(exactToolScopeSchema).min(1).max(3),
  client_id: z.string().min(1).max(256),
  session_id: z.string().min(1).max(256),
}).strict();

function normalizedTools(values: readonly T0ToolName[]): readonly T0ToolName[] {
  const requested = new Set(values);
  return T0_TOOL_NAMES.filter((toolName) => requested.has(toolName));
}

function credentialIsStructurallyActive(input: Readonly<{
  tenantStatus: string;
  clientStatus: string;
  credentialStatus: string;
  deliveryStatus: string;
  expiresAt: number;
  nowSeconds: number;
}>): boolean {
  return input.tenantStatus === "active"
    && input.clientStatus === "active"
    && input.credentialStatus === "active"
    && input.deliveryStatus === "acknowledged"
    && input.expiresAt > input.nowSeconds;
}

function parseJwtObject(part: string): unknown {
  if (part.length === 0 || part.length > 8 * 1024) {
    throw new AccessGatewayError("access_gateway_unavailable");
  }
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new AccessGatewayError("access_gateway_unavailable");
  }
}

function assertSignedJwtMatchesClaims(
  signed: Readonly<{ token: string; kid: string }>,
  claims: JwtClaims,
): void {
  if (
    signed.token.length > 16 * 1024 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(signed.token) ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(signed.kid)
  ) {
    throw new AccessGatewayError("access_gateway_unavailable");
  }
  const parts = signed.token.split(".");
  if (parts.length !== 3) throw new AccessGatewayError("access_gateway_unavailable");
  const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] = parts;
  if (encodedSignature.length < 32 || encodedSignature.length > 4 * 1024) {
    throw new AccessGatewayError("access_gateway_unavailable");
  }
  const header = jwtHeaderSchema.safeParse(parseJwtObject(encodedHeader));
  const payload = jwtClaimsSchema.safeParse(parseJwtObject(encodedPayload));
  if (
    !header.success ||
    header.data.kid !== signed.kid ||
    !payload.success ||
    !isDeepStrictEqual(payload.data, claims)
  ) {
    throw new AccessGatewayError("access_gateway_unavailable");
  }
}

export class AccessGateway {
  readonly #providers: GatewayProviders;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #ttlSeconds: number;

  constructor(providers: GatewayProviders, options: GatewayOptions = {}) {
    this.#providers = providers;
    this.#issuer = options.issuer ?? "https://access-gateway.example.invalid/";
    this.#audience = options.audience ?? "logistics-mcp";
    this.#ttlSeconds = options.defaultTtlSeconds ?? 300;
    if (this.#ttlSeconds < 60 || this.#ttlSeconds > 900 || !Number.isSafeInteger(this.#ttlSeconds)) {
      throw new RangeError("Access Gateway JWT TTL must be an integer from 60 through 900 seconds.");
    }
    if (!this.#issuer.startsWith("https://") || this.#audience.length === 0) {
      throw new TypeError("Access Gateway issuer and audience are invalid.");
    }
  }

  async exchangeToken(input: ExchangeInput): Promise<ExchangeSuccessResponse> {
    const parsedBody = exchangeRequestSchema.safeParse(input.body);
    if (!parsedBody.success || typeof input.clientIp !== "string" || input.clientIp.length === 0) {
      throw new AccessGatewayError("invalid_request");
    }
    const requestId = input.requestId ?? this.#providers.randomSource.opaque("req");
    if (!requestIdPattern.test(requestId)) throw new AccessGatewayError("invalid_request");
    const requestedTools = normalizedTools(parsedBody.data.requested_tool_names);
    const nowSeconds = this.#providers.clock.nowSeconds();
    const exchangeRequestHash = canonicalJsonHash(
      "access-gateway/exchange/v1",
      parsedBody.data,
    );
    let auditIdentity: Readonly<{
      tenantId: string;
      clientId: string;
      credentialId: string;
    }> | null = null;
    let signedJti: string | null = null;

    try {
      const parsedKey = apiKeyPattern.exec(input.apiKey);
      if (parsedKey === null) throw new AccessGatewayError("authentication_failed");
      const credentialId = parsedKey[1]!;
      const secret = parsedKey[2]!;
      const record = await this.#providers.credentialRepository.findForExchange(credentialId);
      const credentialVerified = await this.#providers.secretPepperProvider.verifyCredentialSecret({
        secret,
        material: record === null
          ? null
          : {
              salt: record.credential.secretSalt,
              expectedHash: record.credential.secretHash,
              pepperVersion: record.credential.pepperVersion,
            },
      });
      if (record === null || !credentialVerified) {
        throw new AccessGatewayError("authentication_failed");
      }
      auditIdentity = {
        tenantId: record.tenant.tenantId,
        clientId: record.client.clientId,
        credentialId: record.credential.credentialId,
      };
      const revoked = await this.#providers.revocationRepository.isRevoked({
        tenantId: record.tenant.tenantId,
        clientId: record.client.clientId,
        credentialId: record.credential.credentialId,
        jti: null,
      });
      if (
        revoked ||
        !credentialIsStructurallyActive({
          tenantStatus: record.tenant.status,
          clientStatus: record.client.status,
          credentialStatus: record.credential.status,
          deliveryStatus: record.credential.deliveryStatus,
          expiresAt: record.credential.expiresAt,
          nowSeconds,
        })
      ) {
        throw new AccessGatewayError("authentication_failed");
      }
      if (requestedTools.some((toolName) => !record.credential.toolNames.includes(toolName))) {
        throw new AccessGatewayError("tool_entitlement_denied");
      }
      const reserved = await this.#providers.rateLimitRepository.reserve({
        tenantId: record.tenant.tenantId,
        clientId: record.client.clientId,
        credentialId: record.credential.credentialId,
        clientIp: input.clientIp,
        nowSeconds,
      });
      if (!reserved) throw new AccessGatewayError("rate_limited");

      const sessionId = this.#providers.randomSource.opaque("auth");
      const jti = this.#providers.randomSource.opaque("jwt");
      signedJti = jti;
      const claims: JwtClaims = {
        iss: this.#issuer,
        aud: this.#audience,
        sub: record.credential.credentialId,
        iat: nowSeconds,
        exp: nowSeconds + this.#ttlSeconds,
        jti,
        tenant_id: record.tenant.tenantId,
        actor_id: record.credential.credentialId,
        actor_role: "service",
        roles: ["service"],
        scopes: requestedTools.map((toolName): ExactToolScope => `tool:${toolName}`),
        client_id: record.client.clientId,
        session_id: sessionId,
      };
      const signed = await this.#providers.jwtSigningProvider.sign(claims);
      assertSignedJwtMatchesClaims(signed, claims);
      const markedUsed = await this.#providers.credentialRepository.markUsed(
        record.credential.credentialId,
        new Date(nowSeconds * 1_000).toISOString(),
        nowSeconds,
      );
      if (!markedUsed) throw new AccessGatewayError("authentication_failed");
      await this.#providers.auditRepository.append({
        auditId: this.#providers.randomSource.opaque("audit"),
        action: "token.exchange",
        status: "success",
        requestId,
        tenantId: record.tenant.tenantId,
        clientId: record.client.clientId,
        credentialId: record.credential.credentialId,
        toolNames: requestedTools,
        requestHash: exchangeRequestHash,
        jti,
        reasonCode: null,
        createdAt: new Date(nowSeconds * 1_000).toISOString(),
      });
      return {
        schema_version: ACCESS_GATEWAY_SCHEMA_VERSION,
        status: "success",
        data: {
          access_token: signed.token,
          token_type: "Bearer",
          expires_in: this.#ttlSeconds,
          tool_names: requestedTools,
          session_ref: sessionId,
          request_id: requestId,
        },
        warnings: [],
        blockers: [],
      };
    } catch (error: unknown) {
      const safe = asUnavailableError(error);
      try {
        await this.#providers.auditRepository.append({
          auditId: this.#providers.randomSource.opaque("audit"),
          action: "token.exchange",
          status: safe.responseStatus,
          requestId,
          tenantId: auditIdentity?.tenantId ?? null,
          clientId: auditIdentity?.clientId ?? null,
          credentialId: auditIdentity?.credentialId ?? null,
          toolNames: requestedTools,
          requestHash: exchangeRequestHash,
          jti: signedJti,
          reasonCode: safe.code,
          createdAt: new Date(nowSeconds * 1_000).toISOString(),
        });
      } catch {
        throw new AccessGatewayError("access_gateway_unavailable");
      }
      throw safe;
    }
  }

  getJwks(): Promise<JwksResponse> {
    return this.#providers.jwtSigningProvider.getJwks()
      .then((value) => jwksSchema.parse(value))
      .catch(() => {
        throw new AccessGatewayError("access_gateway_unavailable");
      });
  }

  getState() {
    return this.#providers.credentialRepository.listState().catch(() => {
      throw new AccessGatewayError("access_gateway_unavailable");
    });
  }
}

export function errorResponse(error: AccessGatewayError, requestId: string): ErrorResponse {
  return {
    schema_version: ACCESS_GATEWAY_SCHEMA_VERSION,
    status: error.responseStatus,
    data: null,
    code: error.code,
    request_id: requestId,
  };
}

export function createAccessGateway(
  providers: GatewayProviders,
  options: GatewayOptions = {},
): AccessGateway {
  return new AccessGateway(providers, options);
}

export type ParsedExchangeRequest = ExchangeRequest;
