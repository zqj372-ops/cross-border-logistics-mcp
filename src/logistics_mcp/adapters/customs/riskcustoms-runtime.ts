import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

import type { FetchImplementation } from "../http-client";
import { RiskCustomsApiAdapter } from "./riskcustoms-api-adapter";

export interface RiskCustomsRuntimeDependencies {
  readonly fetchImpl?: FetchImplementation;
  readonly readSecretFile?: (path: string) => string | Promise<string>;
  readonly clock?: () => Date;
}

export interface RiskCustomsRuntimeConfig {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly allowedHosts: readonly string[];
  readonly allowedTenants: readonly string[];
  readonly authSecretFile?: string;
}

export const RISK_CUSTOMS_SECRET_MAX_BYTES = 8192;

const TENANT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

function splitSetting(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(normalizeHost)
    .filter((item) => item.length > 0);
}

function splitTenantSetting(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(",").map((item) => item.trim());
}

function normalizeAllowedTenants(value: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const tenants: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const tenant = item.trim();
    if (tenant.length === 0 || tenant === "*" || !TENANT_IDENTIFIER.test(tenant)) return null;
    if (!tenants.includes(tenant)) tenants.push(tenant);
  }
  return tenants.length === 0 ? null : tenants;
}

async function readRuntimeSecret(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > RISK_CUSTOMS_SECRET_MAX_BYTES) {
      throw new Error("RiskCustoms authorization secret is unavailable.");
    }

    const buffer = Buffer.alloc(RISK_CUSTOMS_SECRET_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > RISK_CUSTOMS_SECRET_MAX_BYTES) {
      throw new Error("RiskCustoms authorization secret is unavailable.");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function authorizationUnavailable(): Error {
  return new Error("RiskCustoms authorization is unavailable.");
}

/**
 * Builds the production-only adapter from server-owned configuration. The
 * token is deliberately represented by a file reference and is read only at
 * request time; it never belongs in a client request or repository config.
 */
export function createRiskCustomsApiAdapter(
  config: RiskCustomsRuntimeConfig,
  dependencies: RiskCustomsRuntimeDependencies = {},
): RiskCustomsApiAdapter | undefined {
  if (!config.enabled) return undefined;

  const baseUrl = config.baseUrl?.trim();
  const authSecretFile = config.authSecretFile?.trim();
  if (baseUrl === undefined || baseUrl.length === 0 || authSecretFile === undefined || authSecretFile.length === 0) {
    return undefined;
  }

  const allowedTenants = normalizeAllowedTenants(config.allowedTenants);
  if (allowedTenants === null) return undefined;

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (parsedBaseUrl.protocol !== "https:" || parsedBaseUrl.username !== "" || parsedBaseUrl.password !== "") {
    return undefined;
  }

  const allowedHosts = [...new Set(config.allowedHosts.map(normalizeHost).filter((host) => host.length > 0))];
  const baseHost = normalizeHost(parsedBaseUrl.hostname);
  if (!allowedHosts.includes(baseHost)) return undefined;

  const readSecretFile = dependencies.readSecretFile ?? readRuntimeSecret;
  return new RiskCustomsApiAdapter({
    baseUrl,
    allowedHosts,
    enabled: true,
    productionConnector: true,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    authorizationProvider: async (context) => {
      if (!allowedTenants.includes(context.tenantId)) {
        throw authorizationUnavailable();
      }
      try {
        const secret = await readSecretFile(authSecretFile);
        if (
          typeof secret !== "string" ||
          Buffer.byteLength(secret, "utf8") > RISK_CUSTOMS_SECRET_MAX_BYTES
        ) {
          throw authorizationUnavailable();
        }
        const token = secret.trim();
        if (token.length === 0 || /\s/u.test(token)) {
          throw authorizationUnavailable();
        }
        return token;
      } catch {
        throw authorizationUnavailable();
      }
    },
  });
}

export function createRiskCustomsApiAdapterFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RiskCustomsRuntimeDependencies = {},
): RiskCustomsApiAdapter | undefined {
  const riskCustomsHosts = splitSetting(env.MCP_RISK_CUSTOMS_ALLOWED_HOSTS);
  const outboundHosts = new Set(splitSetting(env.MCP_ALLOWED_OUTBOUND_HOSTS));
  const effectiveHosts = riskCustomsHosts.filter((host) => outboundHosts.has(host));
  const config: RiskCustomsRuntimeConfig = {
    enabled: env.MCP_RISK_CUSTOMS_ENABLED?.trim().toLowerCase() === "true",
    allowedHosts: effectiveHosts,
    allowedTenants: splitTenantSetting(env.MCP_RISK_CUSTOMS_ALLOWED_TENANTS),
    ...(env.MCP_RISK_CUSTOMS_BASE_URL === undefined ? {} : { baseUrl: env.MCP_RISK_CUSTOMS_BASE_URL }),
    ...(env.MCP_RISK_CUSTOMS_AUTH_SECRET_FILE === undefined
      ? {}
      : { authSecretFile: env.MCP_RISK_CUSTOMS_AUTH_SECRET_FILE }),
  };

  return createRiskCustomsApiAdapter(config, dependencies);
}
