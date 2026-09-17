import { CollectorRuntimeError } from "../errors";
import type {
  CarrierHttpPort,
  CarrierHttpRequest,
  CarrierHttpResponse,
} from "../ports";
import {
  resolveApprovedTarget,
  type ApprovedHttpMethod,
  type ApprovedTarget,
  type TransportPolicy,
  validateTransportPolicy,
} from "./config";

export interface TrustedConnectorRequest {
  readonly url: string;
  readonly method: ApprovedHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
  readonly signal: AbortSignal;
}

export interface TrustedConnectorResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface TrustedConnector {
  connect(input: TrustedConnectorRequest): Promise<TrustedConnectorResponse>;
}

export interface ControlledHttpTransportOptions {
  readonly policy: TransportPolicy;
  readonly connector: TrustedConnector | null;
}

const ALLOWED_REQUEST_HEADERS = new Set(["accept", "content-type"]);
const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "content-length",
]);

function assertSafeHeaders(
  target: ApprovedTarget,
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed =
    target.allowedRequestHeaders === undefined
      ? ALLOWED_REQUEST_HEADERS
      : new Set([...ALLOWED_REQUEST_HEADERS, ...target.allowedRequestHeaders]);
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalized = name.toLowerCase();
    if (
      !allowed.has(normalized) ||
      /[\r\n]/u.test(value)
    ) {
      throw new CollectorRuntimeError(
        "validation_error",
        "blocked",
        "collector_request_header_rejected",
      );
    }
    const expectedValue = target.allowedRequestHeaderValues?.[normalized];
    if (expectedValue !== undefined && expectedValue !== value) {
      throw new CollectorRuntimeError(
        "validation_error",
        "blocked",
        "collector_request_header_value_rejected",
      );
    }
    result[normalized] = value;
  }
  return result;
}

function sanitizeResponseHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase()),
    ),
  );
}

function cookiePairs(
  value: string | undefined,
): readonly { readonly name: string; readonly value: string }[] {
  if (value === undefined) return [];
  return value.split(/,\s*(?=[^;,\s]+=)/u).flatMap((entry) => {
    const pair = entry.split(";", 1)[0]?.trim() ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) return [];
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) return [];
    return [{ name, value: cookieValue }];
  });
}

function contentType(headers: Readonly<Record<string, string>>): string | null {
  const match = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "content-type",
  );
  return match?.[1]?.split(";")[0]?.trim().toLowerCase() ?? null;
}

function assertResponse(
  target: ApprovedTarget,
  response: TrustedConnectorResponse,
  maximumBytes: number,
): void {
  const url = new URL(response.url);
  const effectivePort = url.port === "" ? "443" : url.port;
  if (
    url.protocol !== "https:" ||
    url.hostname !== target.host ||
    effectivePort !== "443" ||
    url.pathname !== target.path
  ) {
    throw new CollectorRuntimeError(
      "access_restricted",
      "blocked",
      "collector_response_target_mismatch",
    );
  }
  if (response.body.byteLength > maximumBytes) {
    throw new CollectorRuntimeError(
      "incomplete_results",
      "unavailable",
      "collector_response_too_large",
    );
  }
}

function abortError(): CollectorRuntimeError {
  return new CollectorRuntimeError("timeout", "unavailable", "collector_timeout");
}

function buildTargetUrl(
  target: ApprovedTarget,
  query: Readonly<Record<string, string>>,
): string {
  const url = new URL(`https://${target.host}${target.path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function createControlledHttpTransport(
  options: ControlledHttpTransportOptions,
): CarrierHttpPort {
  const policy = validateTransportPolicy(options.policy);
  let requestsStarted = 0;
  const cookiesByHost = new Map<string, Map<string, string>>();

  return {
    async request(input: CarrierHttpRequest): Promise<CarrierHttpResponse> {
      const method = input.method;
      const query = input.query ?? {};
      const target = resolveApprovedTarget(
        policy,
        {
          carrier: input.carrier,
          method,
          path: input.path,
          query,
        },
        new Date(),
      );
      if (options.connector === null) {
        throw new CollectorRuntimeError(
          "live_not_approved",
          "blocked",
          "collector_trusted_connector_missing",
        );
      }
      if (input.signal?.aborted) throw abortError();
      const headers = assertSafeHeaders(target, input.headers);
      const cookieHost = target.sessionCookieHost;
      const cookies =
        cookieHost === undefined ? undefined : cookiesByHost.get(cookieHost);
      if (
        cookieHost !== undefined &&
        cookies !== undefined &&
        cookies.size > 0
      ) {
        headers.cookie = [...cookies.entries()]
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
      }
      const body =
        input.body === undefined || input.body === null
          ? null
          : new TextEncoder().encode(JSON.stringify(input.body));
      if (body !== null && method !== "POST") {
        throw new CollectorRuntimeError(
          "validation_error",
          "blocked",
          "collector_request_body_rejected",
        );
      }
      if (body !== null && target.allowedBodyKeys.length === 0) {
        throw new CollectorRuntimeError(
          "validation_error",
          "blocked",
          "collector_request_body_not_approved",
        );
      }
      if (body !== null && input.body !== null && typeof input.body === "object") {
        const bodyKeys = Object.keys(input.body);
        if (
          bodyKeys.some((key) => !target.allowedBodyKeys.includes(key)) ||
          target.allowedBodyKeys.some((key) => !bodyKeys.includes(key))
        ) {
          throw new CollectorRuntimeError(
            "validation_error",
            "blocked",
            "collector_request_body_key_rejected",
          );
        }
      }
      if (body !== null && body.byteLength > policy.maxRequestBodyBytes) {
        throw new CollectorRuntimeError(
          "validation_error",
          "blocked",
          "collector_request_body_too_large",
        );
      }
      const controller = new AbortController();
      const onAbort = (): void => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
      try {
        const response = await connectWithRetries(
          options.connector,
          policy,
          {
            url: buildTargetUrl(target, query),
            method,
            headers,
            body,
            signal: controller.signal,
          },
          () => {
            if (requestsStarted >= policy.maxRequestsPerRun) {
              throw new CollectorRuntimeError(
                "rate_limited",
                "manual_review",
                "collector_request_budget_exhausted",
              );
            }
            requestsStarted += 1;
          },
        );
        assertResponse(target, response, policy.maxResponseBytes);
        const updates = cookiePairs(
          response.headers["set-cookie"] ?? response.headers["Set-Cookie"],
        );
        if (target.sessionCookieHost !== undefined && updates.length > 0) {
          const jar =
            cookiesByHost.get(target.sessionCookieHost) ??
            new Map<string, string>();
          for (const update of updates) {
            jar.delete(update.name);
            jar.set(update.name, update.value);
            if (jar.size > 20) {
              const oldest = jar.keys().next().value;
              if (oldest !== undefined) jar.delete(oldest);
            }
          }
          cookiesByHost.set(target.sessionCookieHost, jar);
        }
        if (response.status >= 300 && response.status < 400) {
          throw new CollectorRuntimeError(
            "access_restricted",
            "blocked",
            "collector_redirect_rejected",
          );
        }
        if (response.status === 429) {
          const retryAfter = response.headers["retry-after"];
          const retryAfterSeconds =
            retryAfter === undefined ? null : Number(retryAfter);
          const retryAfterMs =
            retryAfterSeconds !== null &&
            Number.isFinite(retryAfterSeconds) &&
            retryAfterSeconds >= 0
              ? retryAfterSeconds * 1000
              : undefined;
          throw new CollectorRuntimeError(
            "rate_limited",
            "manual_review",
            "collector_rate_limited",
            retryAfterMs,
          );
        }
        return {
          status: response.status,
          url: response.url,
          contentType: contentType(response.headers),
          headers: sanitizeResponseHeaders(response.headers),
          body: Uint8Array.from(response.body),
        };
      } catch (error: unknown) {
        if (error instanceof CollectorRuntimeError) throw error;
        throw new CollectorRuntimeError(
          "timeout",
          "unavailable",
          "collector_transport_failed",
        );
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function connectWithRetries(
  connector: TrustedConnector,
  policy: TransportPolicy,
  input: TrustedConnectorRequest,
  beforeAttempt: () => void,
): Promise<TrustedConnectorResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    if (input.signal.aborted) throw abortError();
    beforeAttempt();
    try {
      const response = await abortable(connector.connect(input), input.signal);
      if (response.status >= 500 && attempt < policy.maxRetries) {
        await waitForRetry(attempt, input.signal);
        continue;
      }
      return response;
    } catch (error: unknown) {
      lastError = error;
      if (
        error instanceof CollectorRuntimeError ||
        attempt >= policy.maxRetries
      ) {
        throw error;
      }
      await waitForRetry(attempt, input.signal);
    }
  }
  throw lastError;
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(
          error instanceof Error ? error : new Error("collector_connector_failed"),
        );
      },
    );
  });
}

async function waitForRetry(
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw abortError();
  const delayMs = Math.min(250 * 2 ** attempt, 1_000);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
