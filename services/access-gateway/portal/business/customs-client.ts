import { z } from "zod";

export const CUSTOMS_PORTAL_SCHEMA_VERSION = "portal-customs@2026-09-05.v1" as const;
const SOURCE_QUERY_VERSION = "riskcustoms-query.v2" as const;
const SOURCE_STATUS_VERSION = "riskcustoms-query.v1" as const;
const DELEGATION_SCOPE = "customs.query" as const;
const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const dateTime = z.string().datetime({ offset: true });

const identityFields = {
  serviceVersion: z.string().min(1), publishedAt: dateTime,
  supportedOperations: z.tuple([z.literal("status"), z.literal("query")]),
  ruleDate: z.string().date(), releaseIds: z.array(z.string().min(1)).min(1),
  snapshotHash: z.string().regex(HASH), releaseHash: z.string().regex(HASH),
};
const statusSchema = z.object({
  contractVersion: z.literal(SOURCE_STATUS_VERSION), ...identityFields,
  evaluatedAt: dateTime.nullable(), lastSourceCheckAt: dateTime.nullable(),
  ready: z.literal(true), testData: z.literal(false), reasons: z.tuple([]),
}).strict();
const legalName = z.object({ language: z.string().min(2), text: z.string().min(1), sourceId: z.string().min(1) }).strict();
const explanation = z.object({
  translationId: z.string().min(1), text: z.string().min(1),
  status: z.enum(["machine", "human_reviewed", "not_needed"]),
  basedOnSourceIds: z.array(z.string().min(1)).min(1),
}).strict();
const hierarchy = z.object({
  code: z.string().regex(/^\d{4,10}$/u), displayCode: z.string().min(1),
  codeDigits: z.number().int().min(4).max(10), legalNames: z.array(legalName).min(1),
}).strict();
const candidate = z.object({
  candidateId: z.string().min(1), country: z.enum(["CN", "US", "CA"]),
  code: z.string().regex(/^\d{4,10}$/u), displayCode: z.string().min(1),
  codeDigits: z.number().int().min(4).max(10), parentCode: z.string().regex(/^\d{4,10}$/u).nullable(),
  hierarchy: z.array(hierarchy).min(1).max(7), legalNames: z.array(legalName).min(1),
  chineseExplanation: explanation, classificationReason: z.string().min(1),
  classificationSourceIds: z.array(z.string().min(1)).min(1),
  status: z.enum(["confirmed", "candidate", "possible", "manual_review"]),
  hs6: z.string().regex(/^\d{6}$/u).nullable(),
}).strict();
const rate = z.object({
  id: z.string().min(1), label: z.string().min(1), treatment: z.string().min(1),
  category: z.enum(["export_duty", "provisional_export_duty", "base_duty", "additional_duty", "trade_remedy", "excise_duty", "excise_tax", "gst", "official_fee", "tax", "fee"]),
  kind: z.enum(["free", "ad_valorem", "specific", "compound", "text"]),
  rateExpressionRaw: z.string().min(1), displayValue: z.string().min(1), confirmed: z.boolean(),
  includedInConfirmedTotal: z.boolean(), effectiveFrom: z.string().date(), effectiveTo: z.string().date().nullable(),
  conditionText: z.string(), interactionNote: z.string(), sourceId: z.string().min(1),
}).strict();
const documentItem = z.object({
  id: z.string().min(1), label: z.string().min(1), side: z.enum(["cn_export", "us_import", "ca_import"]),
  status: z.enum(["prepare_retain", "required_now", "conditional", "on_request", "not_applicable", "manual_review"]),
  conditions: z.array(z.string()), reason: z.string().min(1), effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().nullable(), sourceId: z.string().min(1),
}).strict();
const measure = z.object({
  id: z.string().min(1), label: z.string().min(1), measureType: z.string().min(1), originCountry: z.string().min(2),
  codeHint: z.string().nullable(), matchStatus: z.enum(["not_indicated", "possible", "confirmed_by_rule", "manual_review"]),
  legalScope: z.string().min(1), exceptions: z.array(z.string()), caseNumber: z.string().nullable(),
  exporterOrProducer: z.string().nullable(), rateExpressionRaw: z.string().nullable(), effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().nullable(), sourceId: z.string().min(1),
}).strict();
const result = candidate.extend({ rates: z.array(rate), confirmedTotalPercent: z.string().nullable(), documents: z.array(documentItem), measures: z.array(measure), warnings: z.array(z.string()) }).strict();
const source = z.object({
  id: z.string().min(1), releaseId: z.string().min(1), artifactId: z.string().min(1), authority: z.string().min(1),
  dataset: z.string().min(1), edition: z.string().min(1), revision: z.string().min(1),
  officialUrl: z.string().url().refine((value) => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }),
  publishedAt: z.union([z.string().date(), dateTime]), effectiveFrom: z.string().date(), effectiveTo: z.string().date().nullable(),
  retrievedAt: dateTime, sourceLocator: z.string().min(1),
}).strict();
const readyDataStatus = z.object({ contractVersion: z.literal(SOURCE_QUERY_VERSION), ...identityFields,
  evaluatedAt: dateTime.nullable(), lastSourceCheckAt: dateTime.nullable(), ready: z.literal(true), testData: z.literal(false), reasons: z.tuple([]),
}).strict();
const actorSchema = z.object({ type: z.enum(["user", "service"]), ref: z.string().min(1), applicationId: z.string().min(1) }).strict();
export const queryResponseSchema = z.object({
  contractVersion: z.literal(SOURCE_QUERY_VERSION), ...identityFields,
  requestId: z.string().min(1), delegatedActor: actorSchema,
  queryId: z.string().min(1), mode: z.enum(["exact_code", "name_search", "degraded_search"]),
  selectedHs6: z.string().regex(/^\d{6}$/u).nullable(),
  nextQuestion: z.object({ id: z.string().min(1), label: z.string().min(1), attribute: z.string().min(1), options: z.array(z.string().min(1)).min(1).max(3) }).strict().nullable(),
  candidates: z.array(candidate).max(9), results: z.array(result), sources: z.array(source), dataStatus: readyDataStatus, testData: z.literal(false),
}).strict().superRefine((value, ctx) => {
  const sourceIds = new Set(value.sources.map((item) => item.id));
  if (sourceIds.size !== value.sources.length) ctx.addIssue({ code: "custom", path: ["sources"], message: "duplicate source id" });
  const countries = new Set<string>();
  for (const item of [...value.candidates, ...value.results]) {
    if (item.codeDigits !== item.code.length || item.hs6 !== null && !item.code.startsWith(item.hs6) || !item.hierarchy.some((node) => node.code === item.code)) {
      ctx.addIssue({ code: "custom", path: ["candidates"], message: "invalid classification hierarchy" });
    }
    const referenced = [...item.legalNames.map((name) => name.sourceId), ...item.hierarchy.flatMap((node) => node.legalNames.map((name) => name.sourceId)), ...item.classificationSourceIds, ...item.chineseExplanation.basedOnSourceIds];
    if (referenced.some((id) => !sourceIds.has(id))) ctx.addIssue({ code: "custom", path: ["sources"], message: "unknown source reference" });
  }
  for (const item of value.results) {
    if (countries.has(item.country)) ctx.addIssue({ code: "custom", path: ["results"], message: "duplicate result country" });
    countries.add(item.country);
    const side = { CN: "cn_export", US: "us_import", CA: "ca_import" }[item.country];
    if (item.documents.some((entry) => entry.side !== side)) ctx.addIssue({ code: "custom", path: ["results"], message: "document side does not match country" });
    if ([...item.rates.map((line) => line.sourceId), ...item.documents.map((line) => line.sourceId), ...item.measures.map((line) => line.sourceId)].some((id) => !sourceIds.has(id))) {
      ctx.addIssue({ code: "custom", path: ["sources"], message: "unknown result source reference" });
    }
  }
});

export const inputSchema = z.object({
  query: z.string().trim().min(1).max(500), ruleDate: z.string().date(),
  codeCountry: z.enum(["CN", "US", "CA"]).optional(), selectedHs6: z.string().regex(/^\d{6}$/u).optional(),
  attributes: z.object({
    originCountry: z.literal("CN"), material: z.string().trim().min(1).max(200).optional(), use: z.string().trim().min(1).max(200).optional(),
    contains_steel_aluminum: z.enum(["yes", "no", "unknown"]).optional(),
    vacuumInsulated: z.enum(["yes", "no", "unknown"]).optional(),
  }).strict(),
}).strict();

export type CustomsPortalQueryInput = z.input<typeof inputSchema>;
export type CustomsSourceQueryResponse = z.infer<typeof queryResponseSchema>;
export interface CustomsPortalActor { readonly type: "user" | "service"; readonly id: string }
export interface CustomsDelegationSignInput { readonly subject: string; readonly actorType: "user" | "service"; readonly tenantId: string; readonly serviceCallerId: string; readonly applicationId: string; readonly requestId: string; readonly scope: typeof DELEGATION_SCOPE }
export interface CustomsDelegationClaims { readonly iss: string; readonly aud: string; readonly sub: string; readonly actor_type: "user" | "service"; readonly tenant_id: string; readonly service_caller_id: string; readonly application_id: string; readonly request_id: string; readonly scope: typeof DELEGATION_SCOPE; readonly iat: number; readonly nbf: number; readonly exp: number; readonly jti: string }
export interface CustomsDelegationSignedToken { readonly token: string; readonly claims: CustomsDelegationClaims }
export type CustomsDelegationSigner = (input: CustomsDelegationSignInput) => Promise<CustomsDelegationSignedToken>;
export type CustomsPortalQueryResult = Readonly<{
  schema_version: typeof CUSTOMS_PORTAL_SCHEMA_VERSION;
  status: "success" | "needs_input" | "manual_review" | "blocked" | "unavailable";
  data: CustomsSourceQueryResponse | null;
  reason_codes: readonly string[];
}>;

export interface CustomsPortalClientOptions {
  readonly baseUrl?: string; readonly tenantId?: string; readonly serviceCallerId?: string;
  readonly applicationId?: string; readonly connectionSecret?: string;
  readonly delegationSigner?: CustomsDelegationSigner; readonly fetchImpl?: typeof fetch;
  readonly allowLoopbackFixtures?: boolean; readonly timeoutMs?: number; readonly maxBodyBytes?: number;
  readonly clock?: () => Date;
}

function unavailable(code: string): CustomsPortalQueryResult { return { schema_version: CUSTOMS_PORTAL_SCHEMA_VERSION, status: "unavailable", data: null, reason_codes: [code] }; }
function blocked(code: string): CustomsPortalQueryResult { return { schema_version: CUSTOMS_PORTAL_SCHEMA_VERSION, status: "blocked", data: null, reason_codes: [code] }; }
function needsInput(code: string): CustomsPortalQueryResult { return { schema_version: CUSTOMS_PORTAL_SCHEMA_VERSION, status: "needs_input", data: null, reason_codes: [code] }; }

function sourceTriState(value: "yes" | "no" | "unknown" | undefined): boolean | "unknown" | undefined {
  return value === "yes" ? true : value === "no" ? false : value;
}

function containsUnsafeUrlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character === "\\" || character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

function configuredBaseUrl(raw: string | undefined, allowLoopback: boolean): URL | null {
  if (!raw || containsUnsafeUrlCharacter(raw)) return null;
  try {
    const url = new URL(raw);
    const canonicalInput = raw.endsWith("/") ? raw : `${raw}/`;
    if (url.href !== canonicalInput || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol === "https:") return url;
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return allowLoopback && url.protocol === "http:" && loopback ? url : null;
  } catch { return null; }
}

function sameIdentity(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ["serviceVersion", "publishedAt", "supportedOperations", "ruleDate", "releaseIds", "snapshotHash", "releaseHash"]
    .every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > limit) throw new Error("response_too_large");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
}

function validSignedToken(value: CustomsDelegationSignedToken, expected: CustomsDelegationSignInput, now: number): boolean {
  const c = value.claims;
  const keys = Object.keys(c).sort().join(",");
  const expectedKeys = "actor_type,application_id,aud,exp,iat,iss,jti,nbf,request_id,scope,service_caller_id,sub,tenant_id";
  return typeof value.token === "string" && value.token.length > 0 && keys === expectedKeys &&
    c.sub === expected.subject && c.actor_type === expected.actorType && c.tenant_id === expected.tenantId &&
    c.service_caller_id === expected.serviceCallerId && c.application_id === expected.applicationId &&
    c.request_id === expected.requestId && c.scope === DELEGATION_SCOPE && typeof c.iss === "string" && c.iss.length > 0 &&
    typeof c.aud === "string" && c.aud.length > 0 && ID.test(c.jti) && Number.isInteger(c.iat) && Number.isInteger(c.nbf) &&
    Number.isInteger(c.exp) && c.exp > c.nbf && c.exp - c.iat <= 300 && c.iat <= now + 30 && c.nbf <= now + 30 && c.exp > now;
}

export function createCustomsPortalClient(options: CustomsPortalClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const base = configuredBaseUrl(options.baseUrl, options.allowLoopbackFixtures === true);
  const configured = base && options.tenantId && options.serviceCallerId && options.applicationId && options.connectionSecret && options.delegationSigner;

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, base!), { ...init, redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw new Error("redirect_rejected");
      if (!response.ok) throw new Error(`http_${response.status}`);
      return await readJson(response, maxBodyBytes);
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    async query(requestInput: { readonly input: CustomsPortalQueryInput; readonly actor: CustomsPortalActor; readonly requestId: string }): Promise<CustomsPortalQueryResult> {
      if (!configured) return unavailable("customs_connection_unconfigured");
      const parsedInput = inputSchema.safeParse(requestInput.input);
      if (!parsedInput.success || !ID.test(requestInput.requestId) || !ID.test(requestInput.actor.id)) return needsInput("customs_request_invalid");
      const commonHeaders = { authorization: `Bearer ${options.connectionSecret}`, "x-tenant-id": options.tenantId };
      try {
        const before = statusSchema.parse(await request(`/api/m2m/status?ruleDate=${encodeURIComponent(parsedInput.data.ruleDate)}`, { method: "GET", headers: commonHeaders }));
        const signInput: CustomsDelegationSignInput = { subject: requestInput.actor.id, actorType: requestInput.actor.type, tenantId: options.tenantId, serviceCallerId: options.serviceCallerId, applicationId: options.applicationId, requestId: requestInput.requestId, scope: DELEGATION_SCOPE };
        const signed = await options.delegationSigner(signInput);
        if (!validSignedToken(signed, signInput, Math.floor((options.clock?.() ?? new Date()).getTime() / 1000))) return blocked("customs_delegation_invalid");
        const sourceInput = {
          ...parsedInput.data,
          attributes: {
            ...parsedInput.data.attributes,
            contains_steel_aluminum: sourceTriState(parsedInput.data.attributes.contains_steel_aluminum),
            vacuumInsulated: sourceTriState(parsedInput.data.attributes.vacuumInsulated),
          },
        };
        const raw = await request("/api/m2m/v2/query", { method: "POST", headers: { ...commonHeaders, "content-type": "application/json", "x-freightclaw-delegation": signed.token }, body: JSON.stringify(sourceInput) });
        const query = queryResponseSchema.parse(raw);
        const after = statusSchema.parse(await request(`/api/m2m/status?ruleDate=${encodeURIComponent(parsedInput.data.ruleDate)}`, { method: "GET", headers: commonHeaders }));
        if (query.requestId !== requestInput.requestId || query.delegatedActor.type !== requestInput.actor.type || query.delegatedActor.ref !== requestInput.actor.id || query.delegatedActor.applicationId !== options.applicationId) return blocked("customs_delegation_mismatch");
        if (!sameIdentity(before, query) || !sameIdentity(query, query.dataStatus) || !sameIdentity(query, after)) return unavailable("customs_snapshot_changed");
        if (query.nextQuestion) return { schema_version: CUSTOMS_PORTAL_SCHEMA_VERSION, status: "needs_input", data: query, reason_codes: ["customs_clarification_required"] };
        if ([...query.candidates, ...query.results].some((item) => item.status === "manual_review")) {
          return { schema_version: CUSTOMS_PORTAL_SCHEMA_VERSION, status: "manual_review", data: query, reason_codes: ["customs_manual_review_required"] };
        }
        return { schema_version: CUSTOMS_PORTAL_SCHEMA_VERSION, status: "success", data: query, reason_codes: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "redirect_rejected") return unavailable("customs_upstream_redirect_rejected");
        if (message === "response_too_large") return unavailable("customs_upstream_response_too_large");
        return unavailable("customs_upstream_unavailable");
      }
    },
  });
}
