import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { T0_TOOL_NAMES, type T0ToolName } from "../contracts";
import { createTokenExchangeHandler } from "../http";
import { PortalError, PORTAL_SCHEMA_VERSION } from "./contracts";
import type { PortalAccessBridge } from "./access-bridge";
import { WriteContractError } from "../../../src/logistics_mcp/server/tool-registry";

const DEFAULT_MAX_BODY_BYTES = 32 * 1024;
const ROUTE_PREFIX = "/api/fixture/v1/tools/";
const ROUTES = new Map<T0ToolName, string>(
  T0_TOOL_NAMES.map((toolName) => [toolName, `${ROUTE_PREFIX}${toolName}`]),
);

export interface PortalMachineHttpOptions {
  readonly mode: "fixtures" | "production";
  readonly bridge: Pick<PortalAccessBridge, "exchangeToken" | "executeT0">;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly maxBodyBytes?: number;
}

export interface PortalMachineHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

function rawHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  securityHeaders(response);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function errorBody(
  requestId: string,
  status: "needs_input" | "blocked" | "unavailable",
  code: string,
) {
  return Object.freeze({
    schema_version: PORTAL_SCHEMA_VERSION,
    status,
    data: null,
    reason_codes: Object.freeze([code]),
    request_id: requestId,
  });
}

function bearerToken(request: IncomingMessage): string {
  if (rawHeaderCount(request, "authorization") !== 1) {
    throw new PortalError("machine_authentication_failed");
  }
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer ([^\s]{1,16384})$/u.exec(header) : null;
  if (match?.[1] === undefined) throw new PortalError("machine_authentication_failed");
  return match[1];
}

function assertBoundary(request: IncomingMessage, options: PortalMachineHttpOptions): void {
  const host = request.headers.host;
  if (
    rawHeaderCount(request, "host") !== 1 ||
    typeof host !== "string" ||
    !options.allowedHosts.includes(host) ||
    !isLoopback(request.socket.localAddress) ||
    !isLoopback(request.socket.remoteAddress) ||
    request.headers.cookie !== undefined
  ) {
    throw new PortalError("machine_request_denied");
  }
  const originCount = rawHeaderCount(request, "origin");
  if (originCount > 0) {
    const origin = request.headers.origin;
    if (
      originCount !== 1 ||
      typeof origin !== "string" ||
      !options.allowedOrigins.includes(origin)
    ) {
      throw new PortalError("machine_request_denied");
    }
  }
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    throw new PortalError("body_invalid");
  }
  const contentLength = request.headers["content-length"];
  if (Array.isArray(contentLength)) throw new PortalError("body_invalid");
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBodyBytes) {
      throw new PortalError("body_too_large");
    }
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBodyBytes) throw new PortalError("body_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PortalError("body_invalid");
  }
}

function originalInput(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("input" in value)
  ) {
    throw new PortalError("body_invalid");
  }
  return (value).input;
}

function safeError(error: unknown): Readonly<{
  statusCode: number;
  status: "needs_input" | "blocked" | "unavailable";
  code: string;
}> {
  if (error instanceof WriteContractError) {
    return {
      statusCode: error.status === "needs_input" ? 400 : 403,
      status: error.status === "needs_input" ? "needs_input" : "blocked",
      code: error.code,
    };
  }
  if (error instanceof PortalError) {
    if (error.code === "machine_authentication_failed") {
      return { statusCode: 401, status: "blocked", code: error.code };
    }
    if (error.code === "machine_authorization_denied") {
      return { statusCode: 403, status: "blocked", code: error.code };
    }
    if (error.code === "body_invalid" || error.code === "body_too_large") {
      return { statusCode: error.code === "body_too_large" ? 413 : 400, status: "needs_input", code: error.code };
    }
    if (error.code === "machine_request_denied") {
      return { statusCode: 403, status: "blocked", code: error.code };
    }
  }
  return { statusCode: 503, status: "unavailable", code: "machine_execution_unavailable" };
}

async function handleMachineTool(
  request: IncomingMessage,
  response: ServerResponse,
  options: PortalMachineHttpOptions,
  toolName: T0ToolName,
  maxBodyBytes: number,
): Promise<void> {
  const requestId = `req_${randomUUID().replaceAll("-", "")}`;
  try {
    assertBoundary(request, options);
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      throw new PortalError("method_not_allowed");
    }
    if (request.url !== ROUTES.get(toolName)) throw new PortalError("machine_request_denied");
    const accessToken = bearerToken(request);
    const input = originalInput(await readBody(request, maxBodyBytes));
    sendJson(response, 200, await options.bridge.executeT0({ accessToken, toolName, input }));
  } catch (error) {
    const safe = error instanceof PortalError && error.code === "method_not_allowed"
      ? { statusCode: 405, status: "blocked" as const, code: error.code }
      : safeError(error);
    sendJson(response, safe.statusCode, errorBody(requestId, safe.status, safe.code));
  }
}

export function createPortalMachineHttpHandler(
  options: PortalMachineHttpOptions,
): PortalMachineHttpHandler {
  if (options.mode !== "fixtures") throw new PortalError("fixture_machine_api_forbidden");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > DEFAULT_MAX_BODY_BYTES) {
    throw new PortalError("body_limit_invalid");
  }
  if (options.allowedHosts.length === 0) throw new PortalError("allowed_host_required");
  const exchange = createTokenExchangeHandler({
    gateway: { exchangeToken: (input) => options.bridge.exchangeToken(input) },
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
    allowLoopbackHttp: true,
    maxBodyBytes,
  });
  return {
    handle(request, response): boolean {
      if (exchange.handle(request, response)) return true;
      const path = (request.url ?? "").split("?", 1)[0];
      const toolName = T0_TOOL_NAMES.find((candidate) => ROUTES.get(candidate) === path);
      if (toolName === undefined) return false;
      void handleMachineTool(request, response, options, toolName, maxBodyBytes);
      return true;
    },
  };
}
