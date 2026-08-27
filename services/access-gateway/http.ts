import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

import type { AccessGateway } from "./service";
import { errorResponse } from "./service";
import { AccessGatewayError } from "./errors";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const EXCHANGE_PATH = "/access/v1/token/exchange";
const JWKS_PATH = "/.well-known/jwks.json";

export interface AccessGatewayHttpOptions {
  readonly gateway: AccessGateway;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly trustedProxyAddresses?: readonly string[];
  readonly allowLoopbackHttp?: boolean;
  readonly maxBodyBytes?: number;
}

export interface AccessGatewayHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

function requestId(request: IncomingMessage): string {
  const supplied = request.headers["x-request-id"];
  if (
    typeof supplied === "string" &&
    /^req_[A-Za-z0-9_-]{8,128}$/u.test(supplied)
  ) {
    return supplied;
  }
  return `req_${randomUUID().replaceAll("-", "")}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function countRawHeader(request: IncomingMessage, target: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === target) count += 1;
  }
  return count;
}

function assertBoundary(
  request: IncomingMessage,
  options: AccessGatewayHttpOptions,
  write: boolean,
): void {
  const host = request.headers.host;
  if (
    countRawHeader(request, "host") !== 1 ||
    host === undefined ||
    !options.allowedHosts.includes(host)
  ) {
    throw new AccessGatewayError("invalid_request");
  }
  const remoteAddress = request.socket.remoteAddress;
  const trustedProxy = remoteAddress !== undefined
    && (options.trustedProxyAddresses ?? []).includes(remoteAddress);
  const loopbackAllowed = options.allowLoopbackHttp === true
    && isLoopback(request.socket.localAddress)
    && isLoopback(remoteAddress);
  const forwardedHttps = trustedProxy
    && countRawHeader(request, "x-forwarded-proto") === 1
    && request.headers["x-forwarded-proto"] === "https";
  const directTls = (request.socket as typeof request.socket & { readonly encrypted?: boolean }).encrypted === true;
  if (!loopbackAllowed && !directTls && !forwardedHttps) {
    throw new AccessGatewayError("invalid_request");
  }
  if (write) {
    const origin = request.headers.origin;
    if (
      countRawHeader(request, "origin") !== 1 ||
      origin === undefined ||
      !options.allowedOrigins.includes(origin)
    ) {
      throw new AccessGatewayError("invalid_request");
    }
  }
  if (request.headers.cookie !== undefined) {
    throw new AccessGatewayError("invalid_request");
  }
}

function clientIp(request: IncomingMessage, options: AccessGatewayHttpOptions): string {
  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress === undefined) throw new AccessGatewayError("invalid_request");
  if (!(options.trustedProxyAddresses ?? []).includes(remoteAddress)) return remoteAddress;
  if (countRawHeader(request, "x-forwarded-for") !== 1) {
    throw new AccessGatewayError("invalid_request");
  }
  const forwardedFor = request.headers["x-forwarded-for"];
  if (
    typeof forwardedFor !== "string" ||
    forwardedFor.includes(",") ||
    isIP(forwardedFor.trim()) === 0
  ) {
    throw new AccessGatewayError("invalid_request");
  }
  return forwardedFor.trim();
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new AccessGatewayError("invalid_request");
  }
  const contentLength = request.headers["content-length"];
  if (Array.isArray(contentLength)) throw new AccessGatewayError("invalid_request");
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBodyBytes) {
      throw new AccessGatewayError("invalid_request");
    }
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBodyBytes) throw new AccessGatewayError("invalid_request");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AccessGatewayError("invalid_request");
  }
}

function apiKey(request: IncomingMessage): string {
  if (countRawHeader(request, "authorization") !== 1) {
    throw new AccessGatewayError("authentication_failed");
  }
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string" ? /^ApiKey ([^\s]+)$/u.exec(authorization) : null;
  if (match === null) throw new AccessGatewayError("authentication_failed");
  return match[1]!;
}

async function handleExchange(
  request: IncomingMessage,
  response: ServerResponse,
  options: AccessGatewayHttpOptions,
): Promise<void> {
  const currentRequestId = requestId(request);
  try {
    if (request.method !== "POST" || request.url !== EXCHANGE_PATH) {
      throw new AccessGatewayError("invalid_request");
    }
    assertBoundary(request, options, true);
    const key = apiKey(request);
    const body = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const result = await options.gateway.exchangeToken({
      apiKey: key,
      body,
      clientIp: clientIp(request, options),
      requestId: currentRequestId,
    });
    sendJson(response, 200, result);
  } catch (error: unknown) {
    const safe = error instanceof AccessGatewayError
      ? error
      : new AccessGatewayError("access_gateway_unavailable");
    sendJson(response, safe.httpStatus, errorResponse(safe, currentRequestId));
  }
}

async function handleJwks(
  request: IncomingMessage,
  response: ServerResponse,
  options: AccessGatewayHttpOptions,
): Promise<void> {
  const currentRequestId = requestId(request);
  try {
    if (request.method !== "GET" || request.url !== JWKS_PATH) {
      throw new AccessGatewayError("invalid_request");
    }
    assertBoundary(request, options, false);
    const jwks = await options.gateway.getJwks();
    response.setHeader("cache-control", "public, max-age=300, must-revalidate");
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("x-content-type-options", "nosniff");
    response.end(JSON.stringify(jwks));
  } catch (error: unknown) {
    const safe = error instanceof AccessGatewayError
      ? error
      : new AccessGatewayError("access_gateway_unavailable");
    sendJson(response, safe.httpStatus, errorResponse(safe, currentRequestId));
  }
}

export function createTokenExchangeHandler(
  options: AccessGatewayHttpOptions,
): AccessGatewayHttpHandler {
  return {
    handle(request, response): boolean {
      if ((request.url ?? "").split("?", 1)[0] !== EXCHANGE_PATH) return false;
      void handleExchange(request, response, options);
      return true;
    },
  };
}

export function createAccessGatewayHttpHandler(
  options: AccessGatewayHttpOptions,
): AccessGatewayHttpHandler {
  const exchange = createTokenExchangeHandler(options);
  return {
    handle(request, response): boolean {
      if (exchange.handle(request, response)) return true;
      if ((request.url ?? "").split("?", 1)[0] !== JWKS_PATH) return false;
      void handleJwks(request, response, options);
      return true;
    },
  };
}
