import { createCustomsHistoryClient } from "./customs-history-client";
import type { CallRecorder } from "../call-log";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import type { PortalService } from "../service";
import { createCustomsPortalClient, type CustomsPortalQueryInput } from "./customs-client";
import { createRs256DelegationSigner } from "./delegation";
import { createFreightcomPortalClient, type FreightcomPortalRateInput } from "./freightcom-client";
import { createQuotePortalClient, type QuotePortalExtractInput, type QuotePortalZoneInput } from "./quote-client";
import { createQuoteRecordPortalClient } from "./quote-record-client";
import { PortalBusinessService, type PortalBusinessConnection, type PortalBusinessOperation } from "./service";
import { createTaxPortalClient, type TaxPortalEstimateBatchInput, type TaxPortalEstimateInput } from "./tax-client";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const operationSchema = z.enum(["customs.query", "customs.tax.estimate", "quote.zone_preview", "quote.ai_extract_preview", "quote.freightcom_ltl.preview"]);
const connectorSchema = z.object({
  baseUrl: z.string().min(1), serviceCallerId: z.string().min(1), applicationId: z.string().min(1),
  connectionSecretFile: z.string().min(1), issuer: z.string().min(1), audience: z.string().min(1),
  keyId: z.string().min(1), delegationPrivateKeyFile: z.string().min(1),
}).strict();
const freightcomConnectorSchema = z.object({
  connectionId: z.string().min(1), credentialFile: z.string().min(1), baseUrl: z.string().min(1).optional(),
}).strict();
const configSchema = z.object({
  connections: z.array(z.object({
    organizationId: z.string().min(1), tenantId: z.string().min(1),
    enabledOperations: z.array(operationSchema).min(1), customsHistoryEnabled:z.boolean().optional(), recordOperations: z.array(z.enum(["quote.record_save", "quote.record_read", "quote.review_read", "quote.review_manage", "quote.document_generate", "quote.document_read"])).optional(), customs: connectorSchema.optional(), quote: connectorSchema.optional(), freightcom: freightcomConnectorSchema.optional(),
  }).strict()).max(1_000),
}).strict();
type ConnectorConfiguration = z.infer<typeof connectorSchema>;

export interface LoadPortalBusinessServiceOptions {
  readonly callRecorder?: CallRecorder; readonly portalService: Pick<PortalService, "getState"> & Partial<Pick<PortalService, "requireBusinessApplication">>;
  readonly configPath?: string;
  readonly allowLoopbackFixtures?: boolean;
  readonly fetchImpl?: typeof fetch;
}

function regularFile(path: string, maximumBytes: number, privateFile: boolean): string {
  if (!isAbsolute(path)) throw new Error("portal_business_file_invalid");
  const resolved = resolve(path);
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(resolved); } catch { throw new Error("portal_business_file_invalid"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes || privateFile && (stat.mode & 0o077) !== 0) {
    throw new Error("portal_business_file_invalid");
  }
  return resolved;
}
const hasUnsafeCharacter = (value: string) => [...value].some((character) => {
  const point = character.codePointAt(0);
  return point !== undefined && (point <= 0x1f || point === 0x7f || character === "\\");
});

function readSecret(path: string, privateKey = false): string {
  let bytes: Buffer;
  try { bytes = readFileSync(regularFile(path, MAX_SECRET_BYTES, true)); }
  catch { throw new Error("portal_business_file_invalid"); }
  try {
    const value = bytes.toString("utf8");
    if (privateKey) {
      if (!/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n?$/u.test(value)) throw new Error("portal_business_secret_invalid");
      return value;
    }
    const secret = value.replace(/\r?\n$/u, "");
    if (secret.length < 8 || secret.length > 4_096 || secret.trim() !== secret || hasUnsafeCharacter(secret)) throw new Error("portal_business_secret_invalid");
    return secret;
  } finally { bytes.fill(0); }
}

function readConfiguration(path: string): z.infer<typeof configSchema> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(regularFile(path, MAX_CONFIG_BYTES, false), "utf8")); }
  catch { throw new Error("portal_business_config_invalid"); }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error("portal_business_config_invalid");
  const organizations = new Set<string>(); const tenants = new Set<string>();
  for (const item of parsed.data.connections) {
    if (organizations.has(item.organizationId) || tenants.has(item.tenantId) || new Set(item.enabledOperations).size !== item.enabledOperations.length) throw new Error("portal_business_config_invalid");
    organizations.add(item.organizationId); tenants.add(item.tenantId);
    if (item.recordOperations && (new Set(item.recordOperations).size !== item.recordOperations.length || !item.quote || !item.enabledOperations.includes("quote.zone_preview") ||
      item.recordOperations.includes("quote.record_save") && !item.recordOperations.includes("quote.record_read") ||
      item.recordOperations.includes("quote.document_generate") && (!item.recordOperations.includes("quote.document_read") || !item.recordOperations.includes("quote.record_read")))) throw new Error("portal_business_config_invalid");
    if(item.customsHistoryEnabled&&!item.customs)throw new Error("portal_business_config_invalid");
    const customsEnabled = item.enabledOperations.some((operation) => operation.startsWith("customs."));
    const quoteEnabled = item.enabledOperations.some((operation) => operation === "quote.zone_preview" || operation === "quote.ai_extract_preview") || (item.recordOperations?.length ?? 0) > 0;
    const freightcomEnabled = item.enabledOperations.includes("quote.freightcom_ltl.preview");
    if (customsEnabled !== (item.customs !== undefined) || quoteEnabled !== (item.quote !== undefined) || freightcomEnabled !== (item.freightcom !== undefined)) throw new Error("portal_business_config_invalid");
  }
  return parsed.data;
}

function validBaseUrl(raw: string, allowLoopback: boolean): boolean {
  if (hasUnsafeCharacter(raw)) return false;
  try {
    const url = new URL(raw); const canonical = raw.endsWith("/") ? raw : `${raw}/`;
    if (url.href !== canonical || url.username || url.password || url.search || url.hash || url.pathname !== "/") return false;
    if (url.protocol === "https:") return true;
    return allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

async function signer(configuration: ConnectorConfiguration) {
  return createRs256DelegationSigner({ issuer: configuration.issuer, audience: configuration.audience,
    keyId: configuration.keyId, privateKey: readSecret(configuration.delegationPrivateKeyFile, true) });
}

export async function loadPortalBusinessService(options: LoadPortalBusinessServiceOptions): Promise<PortalBusinessService> {
  if (options.configPath === undefined) return new PortalBusinessService({ ...(options.callRecorder ? { callRecorder: options.callRecorder } : {}), portalService: options.portalService, connections: [] });
  const configuration = readConfiguration(options.configPath);
  const connections: PortalBusinessConnection[] = [];
  for (const item of configuration.connections) {
    if (item.customs && !validBaseUrl(item.customs.baseUrl, options.allowLoopbackFixtures === true) || item.quote && !validBaseUrl(item.quote.baseUrl, options.allowLoopbackFixtures === true)) {
      throw new Error("portal_business_config_invalid");
    }
    if (item.freightcom?.baseUrl !== undefined && !validBaseUrl(item.freightcom.baseUrl, options.allowLoopbackFixtures === true)) throw new Error("portal_business_config_invalid");
    const connection: { organizationId: string; tenantId: string; enabledOperations: readonly PortalBusinessOperation[]; serviceActors: {customs?: string; quote?: string}; recordOperations: readonly ("quote.record_save"|"quote.record_read"|"quote.review_read"|"quote.review_manage"|"quote.document_generate"|"quote.document_read")[]; quoteRecordClient?: ReturnType<typeof createQuoteRecordPortalClient>; customsHistoryClient?:ReturnType<typeof createCustomsHistoryClient>; customsClient?: PortalBusinessConnection["customsClient"]; taxClient?: PortalBusinessConnection["taxClient"]; quoteClient?: PortalBusinessConnection["quoteClient"]; freightcomClient?: PortalBusinessConnection["freightcomClient"] } = {
      organizationId: item.organizationId, tenantId: item.tenantId, serviceActors: { ...(item.customs ? {customs: item.customs.serviceCallerId} : {}), ...(item.quote ? {quote: item.quote.serviceCallerId} : {}) }, recordOperations: Object.freeze(item.recordOperations ?? []), enabledOperations: Object.freeze([...item.enabledOperations]),
    };
    if (item.customs) {
      const clientOptions = { baseUrl: item.customs.baseUrl, tenantId: item.tenantId,
      serviceCallerId: item.customs.serviceCallerId, applicationId: item.customs.applicationId,
      connectionSecret: readSecret(item.customs.connectionSecretFile), delegationSigner: await signer(item.customs),
      allowLoopbackFixtures: options.allowLoopbackFixtures === true, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
      const customs = createCustomsPortalClient(clientOptions);
      if(item.customsHistoryEnabled)connection.customsHistoryClient=createCustomsHistoryClient(clientOptions);
      const tax = createTaxPortalClient(clientOptions);
      connection.customsClient = { query: (request) => customs.query({ ...request, input: request.input as CustomsPortalQueryInput }) };
      connection.taxClient = {
        estimate: (request) => tax.estimate({ ...request, input: request.input as TaxPortalEstimateInput }),
        estimateBatch: (request) => tax.estimateBatch({ ...request, input: request.input as TaxPortalEstimateBatchInput }),
      };
    }
    if (item.quote) {
      const clientOptions = { baseUrl: item.quote.baseUrl, tenantId: item.tenantId,
      serviceCallerId: item.quote.serviceCallerId, applicationId: item.quote.applicationId,
      connectionSecret: readSecret(item.quote.connectionSecretFile), delegationSigner: await signer(item.quote),
      allowLoopbackFixtures: options.allowLoopbackFixtures === true, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
      const quote = createQuotePortalClient(clientOptions);
      if (item.recordOperations?.length) connection.quoteRecordClient = createQuoteRecordPortalClient(clientOptions);
      connection.quoteClient = {
        preview: (request) => quote.preview({ ...request, input: request.input as QuotePortalZoneInput }),
        extract: (request) => quote.extract({ ...request, input: request.input as QuotePortalExtractInput }),
      };
    }
    if (item.freightcom) {
      regularFile(item.freightcom.credentialFile, MAX_SECRET_BYTES, true);
      const freightcom = createFreightcomPortalClient({
        connectionId: item.freightcom.connectionId,
        credentialProvider: () => readSecret(item.freightcom!.credentialFile),
        ...(item.freightcom.baseUrl === undefined ? {} : { baseUrl: item.freightcom.baseUrl }),
        allowLoopbackFixtures: options.allowLoopbackFixtures === true,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      connection.freightcomClient = { preview: (request) => freightcom.preview({ input: request.input as FreightcomPortalRateInput, requestId: request.requestId }) };
    }
    connections.push(Object.freeze(connection) as PortalBusinessConnection);
  }
  return new PortalBusinessService({ ...(options.callRecorder ? { callRecorder: options.callRecorder } : {}), portalService: options.portalService, connections: Object.freeze(connections) });
}
