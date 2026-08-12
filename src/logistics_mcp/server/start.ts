import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthenticationError, type AuthClaims } from "../platform/context";
import { SqliteProductionStore } from "../platform/sqlite-production-store";
import {
  createFixtureComposition,
  createProductionApiAdapterSource,
  createProductionComposition,
  type GatewayComposition,
} from "./composition";
import type { ShortLivedTokenValidationOptions } from "../platform/security";
import {
  createAdminStaticHandler,
  type AdminStaticHandler,
} from "./admin-static";
import { createProductionTokenVerifier } from "./production-token-verifier";

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
  const required = dataMode === "production"
    ? [
        "MCP_JWT_ISSUER",
        "MCP_JWT_AUDIENCE",
        "MCP_JWKS_URL",
        "MCP_STATE_DB_PATH",
        "MCP_INSTANCE_ID",
        "MCP_ALLOWED_ORIGINS",
        "MCP_ALLOWED_HOSTS",
        "MCP_ALLOWED_OUTBOUND_HOSTS",
        "MCP_TRUSTED_PROXY_ADDRESSES",
        "MCP_DATA_MODE",
      ]
    : ["MCP_DATA_MODE"];
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
  trustedProxy: (address: string | undefined) => boolean = () => false,
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
  const forwardedProto = loopbackFixture ||
    (headers.get("x-forwarded-proto") === "https" && trustedProxy(request.socket.remoteAddress))
    ? "https"
    : "http";
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
  trustedProxy: (address: string | undefined) => boolean,
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
        await composition.handler(
          await toRequest(request, composition.mode === "fixtures", trustedProxy),
        ),
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
  readonly trustedProxyAddresses?: readonly string[];
}

function trustedProxyChecker(entries: readonly string[]): (address: string | undefined) => boolean {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefixText, ...extra] = entry.split("/");
    const family = address === undefined ? 0 : isIP(address);
    if (address === undefined || family === 0 || extra.length > 0) {
      throw new Error("Trusted proxy entries must be IP addresses or CIDR subnets.");
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefixText === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(prefixText);
    if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error("Trusted proxy CIDR prefix is invalid.");
    }
    list.addSubnet(address, prefix, type);
  }
  return (address) => {
    if (address === undefined) return false;
    const family = isIP(address);
    if (family !== 0 && list.check(address, family === 4 ? "ipv4" : "ipv6")) return true;
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    return mapped !== undefined && list.check(mapped, "ipv4");
  };
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
  const trustedProxy = trustedProxyChecker(
    options.trustedProxyAddresses ?? splitSetting("MCP_TRUSTED_PROXY_ADDRESSES", ""),
  );
  return createServer(
    {
      headersTimeout: RUNTIME_HEADERS_TIMEOUT_MS,
      requestTimeout: RUNTIME_REQUEST_TIMEOUT_MS,
    },
    (request, response) => {
    void handleRuntimeRequest(request, response, composition, adminUi, trustedProxy);
    },
  );
}

export async function closeRuntimeServer(
  server: ReturnType<typeof createServer>,
  composition: GatewayComposition,
): Promise<void> {
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  let failed = false;
  try {
    await composition.close();
  } catch {
    failed = true;
  }
  server.closeAllConnections();
  try {
    await serverClosed;
  } catch {
    failed = true;
  }
  if (failed) {
    throw new Error("The runtime could not close every resource cleanly.");
  }
}

function makeComposition(): GatewayComposition {
  const mode = process.env.MCP_DATA_MODE;
  const common = {
    allowedOrigins: splitSetting(
      "MCP_ALLOWED_ORIGINS",
      mode === "fixtures" ? `http://127.0.0.1:${PORT}` : "",
    ),
    allowedHosts: splitSetting(
      "MCP_ALLOWED_HOSTS",
      mode === "fixtures" ? `127.0.0.1:${PORT}` : "",
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
  const databasePath = process.env.MCP_STATE_DB_PATH?.trim();
  const instanceId = process.env.MCP_INSTANCE_ID?.trim();
  const jwksUrl = process.env.MCP_JWKS_URL?.trim();
  const outboundHosts = splitSetting("MCP_ALLOWED_OUTBOUND_HOSTS", "");
  const store =
    databasePath === undefined || databasePath.length === 0
      ? undefined
      : new SqliteProductionStore(databasePath);
  const tokenVerifier =
    tokenPolicy === undefined ||
    jwksUrl === undefined ||
    jwksUrl.length === 0 ||
    outboundHosts.length === 0
      ? undefined
      : createProductionTokenVerifier({
          jwksUrl,
          allowedHosts: outboundHosts,
        });
  return createProductionComposition({
    dataMode: "production",
    ...common,
    adapterSource: createProductionApiAdapterSource(),
    ...(store === undefined
      ? {}
      : {
          auditRepository: store,
          idempotencyRepository: store,
          sessionBindingStore: store,
        }),
    ...(instanceId === undefined || instanceId.length === 0
      ? {}
      : { sessionOwnerId: instanceId }),
    ...(tokenVerifier === undefined ? {} : { tokenVerifier }),
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
  const shutdown = () => void closeRuntimeServer(server, composition).then(
    () => process.exit(0),
    () => process.exit(1),
  );
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
