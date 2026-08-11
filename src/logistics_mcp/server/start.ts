import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthenticationError } from "../platform/context";
import {
  createFixtureComposition,
  createProductionComposition,
  type GatewayComposition,
} from "./composition";
import type { ShortLivedTokenValidationOptions } from "../platform/security";

const PORT = Number.parseInt(process.env.MCP_PORT ?? "8080", 10);

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

function readiness(): { readonly ready: boolean; readonly reasons: readonly string[] } {
  const dataMode = process.env.MCP_DATA_MODE ?? "production";
  const required = [
    "MCP_JWT_ISSUER",
    "MCP_JWT_AUDIENCE",
    "MCP_ALLOWED_ORIGINS",
    "MCP_ALLOWED_OUTBOUND_HOSTS",
    "MCP_DATA_MODE",
  ];
  const missing = required.filter((name) => (process.env[name] ?? "").trim() === "");
  const reasons = [...missing.map((name) => `missing_${name.toLowerCase()}`)];
  if (dataMode !== "production") reasons.push("fixture_mode_not_production_ready");
  reasons.push("production_adapters_disabled_until_endpoint_tenant_auth_and_readiness_contracts_are_verified");
  return { ready: false, reasons };
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

async function toRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (typeof value === "string") {
      chunks.push(new TextEncoder().encode(value));
    } else if (value instanceof Uint8Array) {
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
  const forwardedProto = headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  const host = headers.get("host") ?? "mcp.example.invalid";
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
): Promise<void> {
    const path = (request.url ?? "/").split("?", 1)[0];
    if (request.method === "GET" && path === "/healthz") {
      json(response, 200, { status: "ok", service: "cross-border-logistics-mcp" });
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      const state = readiness();
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
      await forward(await composition.handler(await toRequest(request)), response);
    } catch {
      json(response, 503, { status: "unavailable", reason: "gateway_unavailable" });
    }
}

export function createRuntimeServer(
  composition: GatewayComposition,
): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    void handleRuntimeRequest(request, response, composition);
  });
}

function makeComposition(): GatewayComposition {
  const mode = process.env.MCP_DATA_MODE;
  const common = {
    allowedOrigins: splitSetting("MCP_ALLOWED_ORIGINS", "https://client.example.invalid"),
    allowedHosts: splitSetting("MCP_ALLOWED_HOSTS", "mcp.example.invalid"),
    authenticate: () => {
      throw new AuthenticationError("A production token verifier must be configured by the gateway.");
    },
  };
  if (mode === "fixtures") {
    return createFixtureComposition({ dataMode: "fixtures", ...common });
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
  server.listen(PORT, "0.0.0.0");
  const close = async () => {
    await composition.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  };
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
}
