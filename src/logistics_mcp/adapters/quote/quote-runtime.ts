import { z } from "zod";

import type { FetchImplementation } from "../http-client";
import type { QuoteAdapter } from "../ports";
import { readBoundedRegularFile } from "../runtime-file";
import { QuoteApiAdapter } from "./quote-api-adapter";

const SECRET_MAX_BYTES = 8 * 1024;
const ORIGIN_MAP_MAX_BYTES = 64 * 1024;
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const originMapSchema = z.object({
  schema_version: z.literal("2026-09-02.v1"),
  tenants: z.record(
    identifierSchema,
    z.record(identifierSchema, z.enum(["toronto", "calgary"])),
  ),
}).strict().refine((value) => Object.keys(value.tenants).length > 0);

export interface QuotePreviewRuntimeDependencies {
  readonly fetchImpl?: FetchImplementation;
  readonly readSecretFile?: (path: string) => string | Promise<string>;
  readonly readConfigFile?: (path: string) => string | Promise<string>;
  readonly clock?: () => Date;
}

function splitHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.$/u, ""))
    .filter((host) => host.length > 0);
}

function enabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "false") return false;
  if (normalized !== "true") {
    throw new Error("MCP_QUOTE_PREVIEW_ENABLED must be true or false.");
  }
  return true;
}

function safeUrl(value: string | undefined): URL | null {
  if (value === undefined || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) return null;
    return url;
  } catch {
    return null;
  }
}

export async function createQuotePreviewAdapterFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: QuotePreviewRuntimeDependencies = {},
): Promise<QuoteAdapter | undefined> {
  if (!enabled(env.MCP_QUOTE_PREVIEW_ENABLED)) return undefined;
  const url = safeUrl(env.MCP_QUOTE_PREVIEW_BASE_URL);
  const secretPath = env.MCP_QUOTE_PREVIEW_API_KEY_SECRET_FILE?.trim();
  const mapPath = env.MCP_QUOTE_PREVIEW_ORIGIN_MAP_FILE?.trim();
  if (
    url === null ||
    secretPath === undefined || secretPath.length === 0 ||
    mapPath === undefined || mapPath.length === 0
  ) return undefined;

  const quoteHosts = new Set(splitHosts(env.MCP_QUOTE_PREVIEW_ALLOWED_HOSTS));
  const outboundHosts = new Set(splitHosts(env.MCP_ALLOWED_OUTBOUND_HOSTS));
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!quoteHosts.has(host) || !outboundHosts.has(host)) return undefined;

  const readConfig = dependencies.readConfigFile ?? (
    (path: string) => readBoundedRegularFile(path, ORIGIN_MAP_MAX_BYTES)
  );
  let parsedMap: z.infer<typeof originMapSchema>;
  try {
    const rawMap = await readConfig(mapPath);
    if (
      typeof rawMap !== "string" ||
      Buffer.byteLength(rawMap, "utf8") > ORIGIN_MAP_MAX_BYTES
    ) return undefined;
    const parsedJson = JSON.parse(rawMap) as unknown;
    const result = originMapSchema.safeParse(parsedJson);
    if (!result.success) return undefined;
    parsedMap = result.data;
  } catch {
    return undefined;
  }

  const readSecret = dependencies.readSecretFile ?? (
    (path: string) => readBoundedRegularFile(path, SECRET_MAX_BYTES)
  );
  return new QuoteApiAdapter({
    baseUrl: url.toString(),
    allowedHosts: [host],
    enabled: true,
    originByTenantWarehouse: parsedMap.tenants,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    headerProvider: async () => {
      try {
        const value = await readSecret(secretPath);
        if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > SECRET_MAX_BYTES) {
          throw new Error("invalid secret");
        }
        const token = value.trim();
        if (token.length === 0 || /\s/u.test(token)) throw new Error("invalid secret");
        return { "X-API-Key": token };
      } catch {
        throw new Error("Quote authorization is unavailable.");
      }
    },
  });
}
