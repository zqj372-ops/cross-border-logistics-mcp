import { readFileSync } from "node:fs";

import type { FetchImplementation } from "../http-client";
import { RiskCustomsApiAdapter } from "./riskcustoms-api-adapter";

export interface RiskCustomsRuntimeDependencies {
  readonly fetchImpl?: FetchImplementation;
  readonly readSecretFile?: (path: string) => string;
  readonly clock?: () => Date;
}

export interface RiskCustomsRuntimeConfig {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly allowedHosts: readonly string[];
  readonly authSecretFile?: string;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

function splitSetting(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(normalizeHost)
    .filter((item) => item.length > 0);
}

function readRuntimeSecret(path: string): string {
  return readFileSync(path, "utf8");
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
    authorizationProvider: () => {
      const token = readSecretFile(authSecretFile).trim();
      if (token.length === 0 || /\s/u.test(token)) {
        throw new Error("RiskCustoms authorization secret is invalid.");
      }
      return token;
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
    ...(env.MCP_RISK_CUSTOMS_BASE_URL === undefined ? {} : { baseUrl: env.MCP_RISK_CUSTOMS_BASE_URL }),
    ...(env.MCP_RISK_CUSTOMS_AUTH_SECRET_FILE === undefined
      ? {}
      : { authSecretFile: env.MCP_RISK_CUSTOMS_AUTH_SECRET_FILE }),
  };

  return createRiskCustomsApiAdapter(config, dependencies);
}
