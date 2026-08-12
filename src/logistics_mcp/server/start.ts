import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthenticationError, type AuthClaims } from "../platform/context";
import {
  createFixtureComposition,
  createProductionComposition,
  type GatewayComposition,
} from "./composition";
import type { ShortLivedTokenValidationOptions } from "../platform/security";
import {
  createAdminStaticHandler,
  type AdminStaticHandler,
} from "./admin-static";

const PORT = Number.parseInt(process.env.MCP_PORT ?? "8080", 10);
const RUNTIME_MAX_BODY_BYTES = 32 * 1024;
const RUNTIME_REQUEST_TIMEOUT_MS = 15_000;
const RUNTIME_HEADERS_TIMEOUT_MS = 10_000;

class RuntimeBodyTooLargeError extends Error {}
class RuntimeRequestError extends Error {}

function splitSetting(name: string, fallback: string): string[] {
  const value = process.env[name] ?? fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(serialized);
}

async function readiness(
  composition: GatewayComposition,
): Promise<{ readonly ready: boolean; readonly reasons: readonly string[] }> {
  const dataMode = process.env.MCP_DATA_MODE ?? "production";
  const required = [
    "MCP_JWT_ISSUER",
    "MCP_JWT_AUDIENCE",
    "MCP_ALLOWED_ORIGINS",
    "MCP_ALLOWED_HOSTS",
    "MCP_ALLOWED_OUTBOUND_HOSTS",
    "MCP_DATA_MODE",
  ];
  const missing = required.filter((name) => (process.env[name] ?? "").trim() === "");
  const reasons = [...missing.map((name) => `missing_${name.toLowerCase()}`)];
  if (dataMode !== "production") reasons.push("fixture_mode_not_production_ready");
  const compositionState = await composition.readiness();
  reasons.push(...compositionState.reasons);
  const uniqueReasons = [...new Set(reasons)];
  return { ready: uniqueReasons.length === 0, reasons: uniqueReasons };
}

function tokenPolicyFromEnvironment(): ShortLivedTokenValidationOptions | undefined {
  const issuer = process.env.MCP_JWT_ISSUER?.trim();
  const audience = process.env.MCP_JWT_AUDIENCE?.trim();
  if (
    issuer === undefined ||
    issuer.length === 0 ||
    audience === undefined ||
    audience.length === 0
  ) {
    return undefined;
  }
  return { issuer, audience };
}

function fixtureAuthenticatorFromEnvironment(): (token: string) => AuthClaims {
  const expectedToken = process.env.MCP_FIXTURE_TOKEN?.trim();
  if (expectedToken === undefined || expectedToken.length === 0) {
    throw new Error("MCP_FIXTURE_TOKEN must be explicitly set in fixtures mode.");
  }
  return (token) => {
    if (token !== expectedToken) throw new AuthenticationError();
    return {
      tenant_id: "tenant_fixture",
      actor_id: "local_operator",
      actor_role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin"],
      client_id: "local_fixture_client",
      session_id: "local_fixture_auth",
      expires_at: Math.floor(Date.now() / 1000) + 15 * 60,
    };
  };
}

async function toRequest(
  request: IncomingMessage,
  allowLoopbackHttp = false,
): Promise<Request> {
  const contentLength = request.headers["content-length"];
  if (Array.isArray(contentLength)) {
    throw new RuntimeRequestError("Invalid content length.");
  }
  if (contentLength !== undefined) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new RuntimeRequestError("Invalid content length.");
    }
    if (declaredLength > RUNTIME_MAX_BODY_BYTES) {
      throw new RuntimeBodyTooLargeError();
    }
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (typeof value === "string") {
      const bytes = new TextEncoder().encode(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > RUNTIME_MAX_BODY_BYTES) throw new RuntimeBodyTooLargeError();
      chunks.push(bytes);
    } else if (value instanceof Uint8Array) {
      totalBytes += value.byteLength;
      if (totalBytes > RUNTIME_MAX_BODY_BYTES) throw new RuntimeBodyTooLargeError();
      chunks.push(value);
    } else {
      throw new TypeError("The request body chunk is not a byte sequence.");
    }
  }
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(name, value.join(","));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const localAddress = request.socket.localAddress;
  const loopbackFixture =
    allowLoopbackHttp &&
    (localAddress === "127.0.0.1" ||
      localAddress === "::1" ||
      localAddress === "::ffff:127.0.0.1");
  const host = headers.get("host") ?? "mcp.example.invalid";
  if (loopbackFixture && headers.get("origin") === null) {
    headers.set("origin", `http://${host}`);
  }
  const forwardedProto =
    loopbackFixture || headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  return new Request(`${forwardedProto}://${host}${request.url ?? "/mcp"}`, {
    method: request.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function forward(response: Response, nodeResponse: ServerResponse): Promise<void> {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, name) => nodeResponse.setHeader(name, value));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

async function handleRuntimeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  composition: GatewayComposition,
  adminUi: AdminStaticHandler,
): Promise<void> {
    if (adminUi.handle(request, response)) return;
    const path = (request.url ?? "/").split("?", 1)[0];
    if (request.method === "GET" && path === "/healthz") {
      json(response, 200, { status: "ok", service: "cross-border-logistics-mcp" });
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      const state = await readiness(composition);
      json(response, state.ready ? 200 : 503, {
        status: state.ready ? "ready" : "not_ready",
        reasons: state.reasons,
      });
      return;
    }
    if (path !== "/mcp") {
      json(response, 404, { status: "blocked", reason: "route_not_found" });
      return;
    }
    try {
      await forward(
        await composition.handler(await toRequest(request, composition.mode === "fixtures")),
        response,
      );
    } catch (error) {
      if (error instanceof RuntimeBodyTooLargeError) {
        json(response, 413, { status: "blocked", reason: "body_too_large" });
        return;
      }
      if (error instanceof RuntimeRequestError) {
        json(response, 400, { status: "blocked", reason: "invalid_request" });
        return;
      }
      json(response, 503, { status: "unavailable", reason: "gateway_unavailable" });
    }
}

export interface RuntimeServerOptions {
  readonly adminUi?: AdminStaticHandler;
}

export function createRuntimeServer(
  composition: GatewayComposition,
  options: RuntimeServerOptions = {},
): ReturnType<typeof createServer> {
  const enabledSetting = process.env.MCP_ADMIN_UI_ENABLED;
  const adminUi =
    options.adminUi ??
    createAdminStaticHandler({
      staticDir: resolve(process.cwd(), "dist/admin"),
      ...(enabledSetting === undefined ? {} : { enabledSetting }),
    });
  return createServer(
    {
      headersTimeout: RUNTIME_HEADERS_TIMEOUT_MS,
      requestTimeout: RUNTIME_REQUEST_TIMEOUT_MS,
    },
    (request, response) => {
    void handleRuntimeRequest(request, response, composition, adminUi);
    },
  );
}

function makeComposition(): GatewayComposition {
  const mode = process.env.MCP_DATA_MODE;
  const common = {
    allowedOrigins: splitSetting(
      "MCP_ALLOWED_ORIGINS",
      mode === "fixtures" ? `http://127.0.0.1:${PORT}` : "https://client.example.invalid",
    ),
    allowedHosts: splitSetting(
      "MCP_ALLOWED_HOSTS",
      mode === "fixtures" ? `127.0.0.1:${PORT}` : "mcp.example.invalid",
    ),
  };
  if (mode === "fixtures") {
    return createFixtureComposition({
      dataMode: "fixtures",
      ...common,
      authenticate: fixtureAuthenticatorFromEnvironment(),
    });
  }
  if (mode !== "production") {
    throw new Error("MCP_DATA_MODE must be explicitly set to production or fixtures.");
  }
  const tokenPolicy = tokenPolicyFromEnvironment();
  return createProductionComposition({
    dataMode: "production",
    ...common,
    ...(tokenPolicy === undefined ? {} : { tokenPolicy }),
  });
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isMainModule(): boolean {
  const argumentPath = process.argv[1];
  if (argumentPath === undefined) return false;
  return canonicalPath(argumentPath) === canonicalPath(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const composition = makeComposition();
  const server = createRuntimeServer(composition);
  server.listen(PORT, process.env.MCP_DATA_MODE === "fixtures" ? "127.0.0.1" : "0.0.0.0");
  const close = async () => {
    await composition.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  };
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
}
