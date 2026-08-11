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
export interface FetchJsonClient {
  get(path: string, headers?: Readonly<Record<string, string>>): Promise<unknown>;
  post(
    path: string,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<unknown>;
}

export type HttpAdapterErrorCode =
  | "upstream_disabled"
  | "upstream_scheme_not_allowed"
  | "upstream_host_not_allowed"
  | "upstream_redirect_rejected"
  | "upstream_timeout"
  | "upstream_response_too_large"
  | "upstream_invalid_json"
  | "upstream_http_error"
  | "upstream_request_invalid";

export class HttpAdapterError extends Error {
  constructor(
    readonly code: HttpAdapterErrorCode,
    message: string,
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
  ): Promise<unknown> {
    if (options.enabled !== true) {
      throw new HttpAdapterError(
        "upstream_disabled",
        "The production upstream adapter is disabled until its endpoint contract is verified.",
      );
    }
    const url = resolveAllowedUrl(baseUrl, path, options.allowedHosts);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
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
      const response = await Promise.race([
        fetchImpl(url.toString(), requestInit),
        timeout,
      ]);
      if (response.status >= 300 && response.status < 400) {
        throw new HttpAdapterError(
          "upstream_redirect_rejected",
          "The upstream redirect was rejected by policy.",
        );
      }
      if (!response.ok) {
        throw new HttpAdapterError(
          "upstream_http_error",
          "The upstream service returned a non-success response.",
        );
      }
      const text = await readBoundedText(response, maxResponseBytes);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new HttpAdapterError(
          "upstream_invalid_json",
          "The upstream response was not valid JSON.",
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
    }
  }

  return {
    get: (path, headers) => request("GET", path, undefined, headers),
    post: (path, body, headers) => request("POST", path, body, headers),
  };
}
