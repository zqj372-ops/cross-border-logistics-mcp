import {
  assertAllowedOutboundUrl,
  SecurityPolicyError,
} from "../platform/security";

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchJsonClientOptions {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: FetchImplementation;
}
export interface FetchJsonAllowedStatusResponse {
  readonly status: number;
  readonly body: unknown;
}
export interface FetchJsonClient {
  get(
    path: string,
    headers?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    allowedStatuses?: readonly number[],
  ): Promise<unknown>;
  post(
    path: string,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    allowedStatuses?: readonly number[],
  ): Promise<unknown>;
}

export type HttpAdapterErrorCode =
  | "upstream_disabled"
  | "upstream_scheme_not_allowed"
  | "upstream_host_not_allowed"
  | "upstream_redirect_rejected"
  | "upstream_timeout"
  | "upstream_aborted"
  | "upstream_response_too_large"
  | "upstream_invalid_json"
  | "upstream_http_error"
  | "upstream_request_invalid";

export class HttpAdapterError extends Error {
  constructor(
    readonly code: HttpAdapterErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HttpAdapterError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

function isCredentialHeader(name: string): boolean {
  return /authorization|api[-_]?key|token|cookie|password|secret/i.test(name);
}

export function redactCredentialHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      isCredentialHeader(name) ? "[redacted]" : value,
    ]),
  );
}

function validatePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HttpAdapterError(
      "upstream_request_invalid",
      `${field} must be a positive integer.`,
    );
  }
  return value;
}

function parseBaseUrl(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch {
    throw new HttpAdapterError(
      "upstream_request_invalid",
      "The upstream base URL is invalid.",
    );
  }
}

type OutboundUrlTarget = "base" | "request";

function assertAllowedUrl(
  url: URL,
  allowedHosts: readonly string[],
  target: OutboundUrlTarget,
): void {
  try {
    assertAllowedOutboundUrl(url, allowedHosts);
  } catch (error: unknown) {
    if (!(error instanceof SecurityPolicyError)) throw error;

    if (url.protocol !== "https:") {
      throw new HttpAdapterError(
        "upstream_scheme_not_allowed",
        target === "base"
          ? "The upstream base URL must use HTTPS."
          : "The upstream request must use HTTPS.",
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new HttpAdapterError(
        "upstream_request_invalid",
        target === "base"
          ? "Credentials in the upstream URL are not allowed."
          : "Credentials in the upstream request URL are not allowed.",
      );
    }
    throw new HttpAdapterError(
      "upstream_host_not_allowed",
      target === "base"
        ? "The upstream base URL host is not allowlisted."
        : "The upstream request host is not allowlisted.",
    );
  }
}

function resolveAllowedUrl(
  baseUrl: URL,
  path: string,
  hosts: readonly string[],
): URL {
  let resolved: URL;
  try {
    resolved = new URL(path, baseUrl);
  } catch {
    throw new HttpAdapterError(
      "upstream_request_invalid",
      "The upstream request path is invalid.",
    );
  }
  assertAllowedUrl(resolved, hosts, "request");
  return resolved;
}

async function readBoundedText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxResponseBytes) {
      throw new HttpAdapterError(
        "upstream_response_too_large",
        "The upstream response exceeds the configured size limit.",
      );
    }
  }

  if (response.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
      throw new HttpAdapterError(
        "upstream_response_too_large",
        "The upstream response exceeds the configured size limit.",
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new HttpAdapterError(
          "upstream_response_too_large",
          "The upstream response exceeds the configured size limit.",
        );
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function requestHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Headers {
  const result = new Headers(headers);
  if (!result.has("accept")) result.set("accept", "application/json");
  return result;
}

export function createFetchJsonClient(
  options: FetchJsonClientOptions,
): FetchJsonClient {
  const baseUrl = parseBaseUrl(options.baseUrl);
  assertAllowedUrl(baseUrl, options.allowedHosts, "base");
  const timeoutMs = validatePositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxResponseBytes = validatePositiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>> | undefined,
    signal: AbortSignal | undefined,
    allowedStatuses: readonly number[] | undefined,
  ): Promise<unknown> {
    if (options.enabled !== true) {
      throw new HttpAdapterError(
        "upstream_disabled",
        "The production upstream adapter is disabled until its endpoint contract is verified.",
      );
    }
    if (signal?.aborted) {
      throw new HttpAdapterError("upstream_aborted", "The upstream request was aborted.");
    }
    const url = resolveAllowedUrl(baseUrl, path, options.allowedHosts);
    const controller = new AbortController();
    let rejectCallerAbort: ((error: HttpAdapterError) => void) | undefined;
    const callerAbort = signal === undefined
      ? null
      : new Promise<never>((_, reject) => {
          rejectCallerAbort = reject;
        });
    const abort = (): void => {
      controller.abort(signal?.reason);
      rejectCallerAbort?.(
        new HttpAdapterError("upstream_aborted", "The upstream request was aborted."),
      );
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const requestHeadersValue = requestHeaders(headers);
    const requestInit: RequestInit = {
      method,
      headers: requestHeadersValue,
      redirect: "error",
      signal: controller.signal,
      ...(method === "POST"
        ? {
            body: JSON.stringify(body),
            headers: new Headers({
              ...Object.fromEntries(requestHeadersValue.entries()),
              "content-type": "application/json",
            }),
          }
        : {}),
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          new HttpAdapterError(
            "upstream_timeout",
            "The upstream request exceeded the configured timeout.",
          ),
        );
      }, timeoutMs);
    });
    try {
      const abortables = [timeout, ...(callerAbort === null ? [] : [callerAbort])];
      let fetchPromise: Promise<Response>;
      try {
        fetchPromise = fetchImpl(url.toString(), requestInit);
      } catch {
        throw new HttpAdapterError(
          "upstream_request_invalid",
          "The upstream request could not be started.",
        );
      }
      const response = await Promise.race([
        fetchPromise,
        ...abortables,
      ]);
      if (response.status >= 300 && response.status < 400) {
        throw new HttpAdapterError(
          "upstream_redirect_rejected",
          "The upstream redirect was rejected by policy.",
        );
      }
      if (!response.ok && !(allowedStatuses?.includes(response.status) ?? false)) {
        throw new HttpAdapterError(
          "upstream_http_error",
          "The upstream service returned a non-success response.",
          response.status,
        );
      }
      let text: string;
      try {
        text = await Promise.race([
          readBoundedText(response, maxResponseBytes),
          ...abortables,
        ]);
      } catch (error: unknown) {
        if (timedOut) {
          throw new HttpAdapterError(
            "upstream_timeout",
            "The upstream request exceeded the configured timeout.",
          );
        }
        if (signal?.aborted) {
          throw new HttpAdapterError("upstream_aborted", "The upstream request was aborted.");
        }
        if (response.status >= 400) {
          if (error instanceof HttpAdapterError) {
            throw new HttpAdapterError(error.code, error.message, response.status);
          }
          throw new HttpAdapterError(
            "upstream_http_error",
            "The upstream response could not be read.",
            response.status,
          );
        }
        throw error;
      }
      try {
        const body = JSON.parse(text) as unknown;
        return allowedStatuses?.includes(response.status) === true
          ? { status: response.status, body } satisfies FetchJsonAllowedStatusResponse
          : body;
      } catch (error: unknown) {
        if (error instanceof HttpAdapterError && response.status >= 400 && error.status === undefined) {
          throw new HttpAdapterError(error.code, error.message, response.status);
        }
        throw new HttpAdapterError(
          "upstream_invalid_json",
          "The upstream response was not valid JSON.",
          response.status >= 400 ? response.status : undefined,
        );
      }
    } catch (error: unknown) {
      if (error instanceof HttpAdapterError) throw error;
      throw new HttpAdapterError(
        "upstream_http_error",
        "The upstream request failed without exposing response details.",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    get: (path, headers, signal, allowedStatuses) =>
      request("GET", path, undefined, headers, signal, allowedStatuses),
    post: (path, body, headers, signal, allowedStatuses) =>
      request("POST", path, body, headers, signal, allowedStatuses),
  };
}
