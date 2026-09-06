import { readBoundedResponse } from "../../../../src/logistics_mcp/platform/bounded-response";
import { z } from "zod";

import type { PortalBusinessClientResult } from "./service";

export const TAX_PORTAL_SCHEMA_VERSION = "portal-tax@2026-09-05.v1" as const;
const SOURCE_VERSION = "riskcustoms-tariff-estimate.v1" as const;
const SOURCE_STATUS_VERSION = "riskcustoms-query.v1" as const;
const DELEGATION_SCOPE = "customs.tax.estimate" as const;
const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SOURCE_REQUEST_ID = /^req_[A-Za-z0-9_-]{8,128}$/u;
const dateTime = z.string().datetime({ offset: true });
const date = z.string().date();
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/u);
const moneyAmount = z.string().regex(/^(?:0|[1-9]\d{0,31})\.\d{2}$/u);
const currency = z.enum(["USD", "CAD", "CNY"]);

const identityFields = {
  serviceVersion: z.string().min(1), publishedAt: dateTime,
  supportedOperations: z.tuple([z.literal("status"), z.literal("query")]),
  ruleDate: date, releaseIds: z.array(z.string().regex(SOURCE_ID)).min(1),
  snapshotHash: z.string().regex(HASH), releaseHash: z.string().regex(HASH),
};
const statusSchema = z.object({
  contractVersion: z.literal(SOURCE_STATUS_VERSION), ...identityFields,
  evaluatedAt: dateTime, lastSourceCheckAt: dateTime.nullable(), ready: z.literal(true), testData: z.literal(false), reasons: z.tuple([]),
}).strict();

const attributesSchema = z.object({
  originCountry: z.literal("CN"), material: z.string().trim().min(1).max(200).optional(),
  use: z.string().trim().min(1).max(200).optional(), contains_steel_aluminum: z.boolean().optional(),
}).strict();
const itemInputSchema = z.object({
  lineId: z.string().regex(SOURCE_ID), description: z.string().trim().min(1).max(200).optional(),
  hsCode: z.string().regex(/^\d{6,10}$/u).optional(), destinationCountry: z.enum(["US", "CA"]).optional(),
  declaredValue: decimal.optional(), currency: currency.optional(), attributes: attributesSchema.optional(),
}).strict();
export const singleInputSchema = itemInputSchema.extend({ ruleDate: date }).strict();
export const batchInputSchema = z.object({ ruleDate: date, items: z.array(itemInputSchema).min(1).max(20) }).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    if (seen.has(item.lineId)) ctx.addIssue({ code: "custom", path: ["items", index, "lineId"], message: "duplicate lineId" });
    seen.add(item.lineId);
  });
});
const businessStatus = z.enum(["success", "needs_input", "manual_review", "unavailable"]);
const money = z.object({ amount: moneyAmount, currency: z.enum(["USD", "CAD"]) }).strict();
const publication = z.object({
  ruleDate: date, serviceVersion: z.string().min(1), publishedAt: dateTime,
  releaseIds: z.array(z.string().regex(SOURCE_ID)).min(1), snapshotHash: z.string().regex(HASH), releaseHash: z.string().regex(HASH),
  evaluatedAt: dateTime, lastSourceCheckAt: dateTime.nullable(), testData: z.literal(false),
}).strict();
const exchange = z.object({
  sourceAuthorities: z.array(z.enum(["CBSA", "BoC"])).min(1).max(2),
  sourceUrl: z.string().url().refine((value) => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }),
  effectiveDate: date, fetchedAt: dateTime, selection: z.enum(["same_day", "latest_business_day", "cached"]),
  fromCurrency: currency, toCurrency: z.enum(["USD", "CAD"]), rate: z.string().regex(/^\d+(?:\.\d+)?$/u),
}).strict();
const taxLine = z.object({
  id: z.string().regex(SOURCE_ID), label: z.string().min(1),
  category: z.enum(["base_duty", "additional_duty", "trade_remedy", "excise_duty", "excise_tax", "gst", "official_fee", "tax", "fee"]),
  rateExpressionRaw: z.string(), ratePercent: z.string().regex(/^\d+(?:\.\d+)?$/u).nullable(), amount: moneyAmount.nullable(), base: moneyAmount,
  status: z.enum(["included", "manual_review", "excluded", "not_applicable"]), effectiveFrom: date, sourceId: z.string().min(1), note: z.string(),
}).strict();
const sourceRef = z.object({
  id: z.string().min(1), releaseId: z.string().min(1), artifactId: z.string().min(1), authority: z.string().min(1),
  dataset: z.string().min(1), edition: z.string().min(1), revision: z.string().min(1),
  officialUrl: z.string().url().refine((value) => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }),
  publishedAt: z.union([date, z.string().datetime()]), effectiveFrom: date, effectiveTo: date.nullable(), retrievedAt: z.string().datetime(), sourceLocator: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "invalid effective range" });
});
const resultSchema = z.object({
  lineId: z.string().regex(SOURCE_ID), status: businessStatus, input: itemInputSchema, publication: publication.nullable(), exchangeRate: exchange.nullable(),
  valueForDuty: money.nullable(), valueForTax: money.nullable(), confirmedSubtotal: money.nullable(), customsPayable: money.nullable(),
  lines: z.array(taxLine), sources: z.array(sourceRef), reasonCodes: z.array(z.string().regex(SOURCE_ID)),
}).strict().superRefine((value, ctx) => {
  const complete = value.input.hsCode !== undefined && value.input.destinationCountry !== undefined && value.input.declaredValue !== undefined && value.input.currency !== undefined && value.input.attributes !== undefined;
  if (value.status === "success" && (!complete || value.publication === null || value.valueForDuty === null || value.confirmedSubtotal === null || value.customsPayable === null || value.lines.length === 0 || value.sources.length === 0)) {
    ctx.addIssue({ code: "custom", message: "incomplete successful estimate" });
  }
  if (value.status !== "success" && value.customsPayable !== null) ctx.addIssue({ code: "custom", path: ["customsPayable"], message: "non-success payable" });
  if (value.status === "unavailable" && (value.valueForDuty !== null || value.valueForTax !== null || value.confirmedSubtotal !== null || value.lines.length > 0)) ctx.addIssue({ code: "custom", message: "stale unavailable amounts" });
  const ids = new Set(value.sources.map((source) => source.id));
  if (ids.size !== value.sources.length || value.lines.some((line) => !ids.has(line.sourceId))) ctx.addIssue({ code: "custom", path: ["sources"], message: "invalid source references" });
  if (value.publication !== null && value.sources.some((source) => !value.publication!.releaseIds.includes(source.releaseId))) ctx.addIssue({ code: "custom", path: ["sources"], message: "source outside publication" });
  const target = value.input.destinationCountry === "US" ? "USD" : value.input.destinationCountry === "CA" ? "CAD" : null;
  if ([value.valueForDuty, value.valueForTax, value.confirmedSubtotal, value.customsPayable].some((entry) => entry !== null && entry.currency !== target)) ctx.addIssue({ code: "custom", path: ["currency"], message: "wrong result currency" });
  const converted = target !== null && value.input.currency !== undefined && value.input.currency !== target;
  if (value.status === "success" && converted && (value.exchangeRate === null || value.exchangeRate.fromCurrency !== value.input.currency || value.exchangeRate.toCurrency !== target)) ctx.addIssue({ code: "custom", path: ["exchangeRate"], message: "missing exchange evidence" });
});
const actorSchema = z.object({ type: z.enum(["user", "service"]), ref: z.string().min(1).max(128), applicationId: z.string().min(1).max(64) }).strict();
export const singleResponseSchema = z.object({
  contractVersion: z.literal(SOURCE_VERSION), requestId: z.string().regex(SOURCE_REQUEST_ID), status: businessStatus, delegatedActor: actorSchema, result: resultSchema,
}).strict().superRefine((value, ctx) => { if (value.status !== value.result.status) ctx.addIssue({ code: "custom", path: ["status"], message: "status mismatch" }); });
const countsSchema = z.object({ total: z.number().int().min(1).max(20), success: z.number().int().nonnegative(), needsInput: z.number().int().nonnegative(), manualReview: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative() }).strict();
export const batchResponseSchema = z.object({
  contractVersion: z.literal(SOURCE_VERSION), requestId: z.string().regex(SOURCE_REQUEST_ID), status: businessStatus,
  partialFailure: z.boolean(), delegatedActor: actorSchema, counts: countsSchema, results: z.array(resultSchema).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const counts = { success: 0, needsInput: 0, manualReview: 0, unavailable: 0 };
  for (const result of value.results) {
    if (result.status === "needs_input") counts.needsInput += 1;
    else if (result.status === "manual_review") counts.manualReview += 1;
    else counts[result.status] += 1;
  }
  if (value.counts.total !== value.results.length || Object.entries(counts).some(([key, count]) => value.counts[key as keyof typeof counts] !== count)) ctx.addIssue({ code: "custom", path: ["counts"], message: "counts mismatch" });
  const partial = new Set(value.results.map((result) => result.status)).size > 1;
  const expectedStatus = counts.success === value.results.length ? "success" : partial || counts.manualReview > 0 ? "manual_review" : counts.needsInput === value.results.length ? "needs_input" : "unavailable";
  if (value.partialFailure !== partial || value.status !== expectedStatus) ctx.addIssue({ code: "custom", path: ["status"], message: "batch status mismatch" });
});

export type TaxPortalEstimateInput = z.input<typeof singleInputSchema>;
export type TaxPortalEstimateBatchInput = z.input<typeof batchInputSchema>;
export type TaxSourceEstimateResponse = z.infer<typeof singleResponseSchema>;
export type TaxSourceEstimateBatchResponse = z.infer<typeof batchResponseSchema>;
export interface TaxPortalActor { readonly type: "user" | "service"; readonly id: string }
export interface TaxDelegationSignInput { readonly subject: string; readonly actorType: "user" | "service"; readonly tenantId: string; readonly serviceCallerId: string; readonly applicationId: string; readonly requestId: string; readonly scope: typeof DELEGATION_SCOPE }
export interface TaxDelegationClaims { readonly iss: string; readonly aud: string; readonly sub: string; readonly actor_type: "user" | "service"; readonly tenant_id: string; readonly service_caller_id: string; readonly application_id: string; readonly request_id: string; readonly scope: typeof DELEGATION_SCOPE; readonly iat: number; readonly nbf: number; readonly exp: number; readonly jti: string }
export interface TaxDelegationSignedToken { readonly token: string; readonly claims: TaxDelegationClaims }
export type TaxDelegationSigner = (input: TaxDelegationSignInput) => Promise<TaxDelegationSignedToken>;
export type TaxPortalResult = PortalBusinessClientResult & Readonly<{ schema_version: typeof TAX_PORTAL_SCHEMA_VERSION; data: TaxSourceEstimateResponse | TaxSourceEstimateBatchResponse | null; request_id: string }>;
export interface TaxPortalClientOptions {
  readonly baseUrl?: string; readonly tenantId?: string; readonly serviceCallerId?: string; readonly applicationId?: string;
  readonly connectionSecret?: string; readonly delegationSigner?: TaxDelegationSigner; readonly fetchImpl?: typeof fetch;
  readonly allowLoopbackFixtures?: boolean; readonly timeoutMs?: number; readonly maxBodyBytes?: number; readonly clock?: () => Date;
}

const response = (status: TaxPortalResult["status"], requestId: string, code?: string, data: TaxPortalResult["data"] = null): TaxPortalResult => ({
  schema_version: TAX_PORTAL_SCHEMA_VERSION, status, data, reason_codes: code ? [code] : [], request_id: requestId,
});

function containsUnsafeUrlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character === "\\" || character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

function configuredBaseUrl(raw: string | undefined, allowLoopback: boolean): URL | null {
  if (!raw || containsUnsafeUrlCharacter(raw)) return null;
  try {
    const url = new URL(raw); const canonical = raw.endsWith("/") ? raw : `${raw}/`;
    if (url.href !== canonical || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol === "https:") return url;
    return allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? url : null;
  } catch { return null; }
}

function sameIdentity(a: z.infer<typeof statusSchema>, b: z.infer<typeof statusSchema>): boolean {
  return ["serviceVersion", "publishedAt", "ruleDate", "releaseIds", "snapshotHash", "releaseHash", "evaluatedAt", "lastSourceCheckAt"]
    .every((key) => JSON.stringify(a[key as keyof typeof a]) === JSON.stringify(b[key as keyof typeof b]));
}
function publicationMatches(status: z.infer<typeof statusSchema>, value: z.infer<typeof publication>): boolean {
  return value.testData === false && ["serviceVersion", "publishedAt", "ruleDate", "releaseIds", "snapshotHash", "releaseHash", "evaluatedAt", "lastSourceCheckAt"]
    .every((key) => JSON.stringify(status[key as keyof typeof status]) === JSON.stringify(value[key as keyof typeof value]));
}
async function readJson(responseValue: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const body = await readBoundedResponse(responseValue, limit, signal);
  if (body.byteLength > limit) throw new Error("response_too_large");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}
function validSignedToken(value: TaxDelegationSignedToken, expected: TaxDelegationSignInput, now: number): boolean {
  const claims = value.claims;
  return typeof value.token === "string" && value.token.length > 0 && Object.keys(claims).sort().join(",") === "actor_type,application_id,aud,exp,iat,iss,jti,nbf,request_id,scope,service_caller_id,sub,tenant_id" &&
    claims.sub === expected.subject && claims.actor_type === expected.actorType && claims.tenant_id === expected.tenantId && claims.service_caller_id === expected.serviceCallerId &&
    claims.application_id === expected.applicationId && claims.request_id === expected.requestId && claims.scope === DELEGATION_SCOPE && typeof claims.iss === "string" && claims.iss.length > 0 &&
    typeof claims.aud === "string" && claims.aud.length > 0 && ID.test(claims.jti) && Number.isInteger(claims.iat) && Number.isInteger(claims.nbf) && Number.isInteger(claims.exp) &&
    claims.exp > claims.nbf && claims.exp - claims.iat <= 300 && claims.iat <= now + 30 && claims.nbf <= now + 30 && claims.exp > now;
}
function actorMatches(value: { requestId: string; delegatedActor: z.infer<typeof actorSchema> }, requestId: string, actor: TaxPortalActor, applicationId: string): boolean {
  return value.requestId === requestId && value.delegatedActor.type === actor.type && value.delegatedActor.ref === actor.id && value.delegatedActor.applicationId === applicationId;
}
function reasonCodes(value: TaxSourceEstimateResponse | TaxSourceEstimateBatchResponse): string[] {
  const results = "result" in value ? [value.result] : value.results;
  return [...new Set(results.flatMap((result) => result.reasonCodes))];
}
function sourceMatchesInput(value: TaxSourceEstimateResponse | TaxSourceEstimateBatchResponse, inputValue: z.infer<typeof singleInputSchema> | z.infer<typeof batchInputSchema>): boolean {
  const results = "result" in value ? [value.result] : value.results;
  const items = "items" in inputValue ? inputValue.items : [(({ ruleDate, ...item }) => { void ruleDate; return item; })(inputValue)];
  return results.length === items.length && results.every((result, index) => result.lineId === items[index]!.lineId && JSON.stringify(result.input) === JSON.stringify(items[index]));
}

export function createTaxPortalClient(options: TaxPortalClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const base = configuredBaseUrl(options.baseUrl, options.allowLoopbackFixtures === true);
  const configured = base && options.tenantId && options.serviceCallerId && options.applicationId && options.connectionSecret && options.delegationSigner;

  async function request(path: string, init: RequestInit, acceptedStatuses: readonly number[] = [200]): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(new URL(path, base!), { ...init, redirect: "manual", signal: controller.signal });
      if (upstream.status >= 300 && upstream.status < 400) throw new Error("redirect_rejected");
      if (!acceptedStatuses.includes(upstream.status)) throw new Error(`http_${upstream.status}`);
      return await readJson(upstream, maxBodyBytes, controller.signal);
    } finally { clearTimeout(timer); }
  }

  async function perform(kind: "single" | "batch", requestInput: { readonly input: unknown; readonly actor: TaxPortalActor; readonly requestId: string }): Promise<TaxPortalResult> {
    if (!configured) return response("unavailable", requestInput.requestId, "tax_connection_unconfigured");
    const parsed = (kind === "single" ? singleInputSchema : batchInputSchema).safeParse(requestInput.input);
    if (!parsed.success || !SOURCE_REQUEST_ID.test(requestInput.requestId) || !ID.test(requestInput.actor.id)) return response("needs_input", requestInput.requestId, "tax_request_invalid");
    const commonHeaders = { authorization: `Bearer ${options.connectionSecret}`, "x-tenant-id": options.tenantId };
    try {
      const before = statusSchema.parse(await request(`/api/m2m/status?ruleDate=${encodeURIComponent(parsed.data.ruleDate)}`, { method: "GET", headers: commonHeaders }));
      const signInput: TaxDelegationSignInput = { subject: requestInput.actor.id, actorType: requestInput.actor.type, tenantId: options.tenantId, serviceCallerId: options.serviceCallerId, applicationId: options.applicationId, requestId: requestInput.requestId, scope: DELEGATION_SCOPE };
      const signed = await options.delegationSigner(signInput);
      if (!validSignedToken(signed, signInput, Math.floor((options.clock?.() ?? new Date()).getTime() / 1000))) return response("blocked", requestInput.requestId, "tax_delegation_invalid");
      const path = kind === "single" ? "/api/m2m/v1/tariff-estimate" : "/api/m2m/v1/tariff-estimates/batch";
      const raw = await request(path, { method: "POST", headers: { ...commonHeaders, "content-type": "application/json", "x-freightclaw-delegation": signed.token }, body: JSON.stringify(parsed.data) }, [200, 503]);
      const source = (kind === "single" ? singleResponseSchema : batchResponseSchema).parse(raw);
      const after = statusSchema.parse(await request(`/api/m2m/status?ruleDate=${encodeURIComponent(parsed.data.ruleDate)}`, { method: "GET", headers: commonHeaders }));
      if (!actorMatches(source, requestInput.requestId, requestInput.actor, options.applicationId)) return response("blocked", requestInput.requestId, "tax_delegation_mismatch");
      if (!sourceMatchesInput(source, parsed.data)) return response("blocked", requestInput.requestId, "tax_response_request_mismatch");
      const results = "result" in source ? [source.result] : source.results;
      if (!sameIdentity(before, after) || results.some((result) => result.publication === null || !publicationMatches(before, result.publication))) return response("unavailable", requestInput.requestId, "tax_snapshot_changed");
      return { schema_version: TAX_PORTAL_SCHEMA_VERSION, status: source.status, data: source, reason_codes: reasonCodes(source), request_id: source.requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (error instanceof z.ZodError) return response("unavailable", requestInput.requestId, "tax_upstream_contract_invalid");
      if (message === "redirect_rejected") return response("unavailable", requestInput.requestId, "tax_upstream_redirect_rejected");
      if (message === "response_too_large") return response("unavailable", requestInput.requestId, "tax_upstream_response_too_large");
      return response("unavailable", requestInput.requestId, "tax_upstream_unavailable");
    }
  }

  return Object.freeze({
    estimate: (requestInput: { readonly input: TaxPortalEstimateInput; readonly actor: TaxPortalActor; readonly requestId: string }) => perform("single", requestInput),
    estimateBatch: (requestInput: { readonly input: TaxPortalEstimateBatchInput; readonly actor: TaxPortalActor; readonly requestId: string }) => perform("batch", requestInput),
  });
}
