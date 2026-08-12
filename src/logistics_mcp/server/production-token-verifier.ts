import {
  compactVerify,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  importJWK,
  type JWK,
} from "jose";

import {
  createFetchJsonClient,
  type FetchImplementation,
} from "../adapters/http-client";

export interface ProductionTokenVerifierOptions {
  readonly jwksUrl: string;
  readonly allowedHosts: readonly string[];
  readonly fetchImpl?: FetchImplementation;
  readonly timeoutMs?: number;
  readonly maxJwksResponseBytes?: number;
  readonly maxTokenBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_JWKS_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_TOKEN_BYTES = 16 * 1024;
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1_000;
const JWKS_COOLDOWN_MS = 30 * 1_000;

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer.`);
  }
  return value;
}

function isUsableRs256PublicKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const key = value as Record<string, unknown>;
  const keyOperations = key.key_ops;
  return key.kty === "RSA"
    && typeof key.n === "string"
    && key.n.length > 0
    && typeof key.e === "string"
    && key.e.length > 0
    && key.d === undefined
    && (key.alg === undefined || key.alg === "RS256")
    && (key.use === undefined || key.use === "sig")
    && (keyOperations === undefined
      || (Array.isArray(keyOperations) && keyOperations.includes("verify")));
}

async function hasUsableRs256PublicKey(keys: readonly unknown[]): Promise<boolean> {
  for (const key of keys) {
    if (!isUsableRs256PublicKey(key)) continue;
    try {
      const imported = await importJWK(key as JWK, "RS256");
      if (!(imported instanceof Uint8Array) && imported.type === "public") {
        return true;
      }
    } catch {
      // Try the next bounded JWKS member.
    }
  }
  return false;
}

export function createProductionTokenVerifier(
  options: ProductionTokenVerifierOptions,
): {
  readonly kind: "token_verifier";
  verify(token: string): Promise<Record<string, unknown>>;
  health(): Promise<{ readonly ready: boolean }>;
  close(): Promise<void>;
} {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxJwksResponseBytes = positiveInteger(
    options.maxJwksResponseBytes ?? DEFAULT_MAX_JWKS_RESPONSE_BYTES,
    "maxJwksResponseBytes",
  );
  const maxTokenBytes = positiveInteger(
    options.maxTokenBytes ?? DEFAULT_MAX_TOKEN_BYTES,
    "maxTokenBytes",
  );
  const client = createFetchJsonClient({
    baseUrl: options.jwksUrl,
    allowedHosts: options.allowedHosts,
    enabled: true,
    timeoutMs,
    maxResponseBytes: maxJwksResponseBytes,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  let fetchRetryAfterMs = 0;
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl), {
    timeoutDuration: timeoutMs,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    [customFetch]: async (url) => {
      if (Date.now() < fetchRetryAfterMs) {
        throw new Error("The JWKS endpoint is in failure cooldown.");
      }
      try {
        const body = await client.get(url);
        const json = JSON.stringify(body);
        if (json === undefined) {
          throw new Error("The JWKS response was empty.");
        }
        fetchRetryAfterMs = 0;
        return new Response(json, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        fetchRetryAfterMs = Date.now() + JWKS_COOLDOWN_MS;
        throw error;
      }
    },
  });

  return {
    kind: "token_verifier",
    async verify(token: string): Promise<Record<string, unknown>> {
      if (
        typeof token !== "string"
        || token.length === 0
        || new TextEncoder().encode(token).byteLength > maxTokenBytes
      ) {
        throw new Error("Token size is invalid or exceeds the configured limit.");
      }
      await compactVerify(token, jwks, { algorithms: ["RS256"] });
      return decodeJwt(token);
    },
    async health(): Promise<{ readonly ready: boolean }> {
      try {
        if (!jwks.fresh) await jwks.reload();
        const snapshot = jwks.jwks();
        const ready = snapshot !== undefined
          && await hasUsableRs256PublicKey(snapshot.keys);
        return { ready };
      } catch {
        return { ready: false };
      }
    },
    close: () => Promise.resolve(),
  };
}
