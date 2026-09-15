import {
  createFetchJsonClient,
  HttpAdapterError,
  type FetchImplementation,
  type FetchJsonClient,
} from "../../../src/logistics_mcp/adapters/http-client.js";
import { OutreachError } from "../types.js";

export interface ProviderHttpOptions {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly token: string;
  readonly fetchImpl?: FetchImplementation;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export function createProviderClient(options: ProviderHttpOptions): FetchJsonClient {
  if (options.token.trim().length < 16) throw new OutreachError("provider_token_missing");
  return createFetchJsonClient({
    baseUrl: options.baseUrl,
    allowedHosts: options.allowedHosts,
    enabled: true,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

export function providerHeaders(token: string, tenantId?: string): Readonly<Record<string, string>> {
  return Object.freeze({
    authorization: `Bearer ${token}`,
    ...(tenantId === undefined ? {} : { "x-freightclaw-tenant": tenantId }),
  });
}

export function providerError(error: unknown): OutreachError {
  if (error instanceof OutreachError) return error;
  if (error instanceof HttpAdapterError) {
    return new OutreachError(error.code === "upstream_timeout" ? "provider_timeout" : "provider_unavailable");
  }
  return new OutreachError("provider_unavailable");
}

export function providerInvalid(): OutreachError {
  return new OutreachError("provider_invalid");
}
