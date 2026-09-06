import { readBoundedResponse, ResponseSizeError } from "../../../../src/logistics_mcp/platform/bounded-response";
import { z } from "zod";

import type { SourceRef } from "../../../../src/logistics_mcp/platform/envelope.js";

export const QUOTE_PORTAL_SCHEMA_VERSION = "portal-quote@2026-09-05.v1" as const;
export const QUOTE_SOURCE_SCHEMA_VERSION = "quote-preview@2026-09-05.v2" as const;
export type QuoteDelegationScope = "quote.zone_preview" | "quote.ai_extract_preview";

const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{8,128}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;

const actorSchema = z.object({ type: z.enum(["user", "service"]), id: z.string().regex(ID) }).strict();
export const zoneInputSchema = z.object({
  address_line: z.string().trim().min(1).max(500).nullable().optional(),
  postal_code: z.string().trim().regex(/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/u),
  city: z.string().trim().min(1).max(120).nullable().optional(),
  province: z.string().trim().min(2).max(32).nullable().optional(),
  cbm: z.string().regex(DECIMAL), weight_kg: z.string().regex(DECIMAL),
  piece_count: z.number().int().min(1), packaging_type: z.string().trim().min(1).max(80),
  longest_side_cm: z.string().regex(DECIMAL).nullable().optional(),
  address_type: z.enum(["commercial", "residential", "private", "rural_residential"]),
  requires_liftgate: z.boolean(), requires_pallet_jack: z.boolean(), requires_appointment: z.boolean(),
  explicit_pallet_count: z.number().int().min(1).nullable(), is_stackable: z.boolean().nullable(),
  detention_minutes: z.number().int().min(0),
}).strict();
export const extractInputSchema = z.object({ customer_message: z.string().trim().min(1).max(20_000) }).strict();
const requestBaseSchema = z.object({ actor: actorSchema, requestId: z.string().regex(REQUEST_ID) });
const previewRequestSchema = requestBaseSchema.extend({ input: zoneInputSchema }).strict();
const extractRequestSchema = requestBaseSchema.extend({ input: extractInputSchema }).strict();

export const sourceRefSchema = z.object({
  source_id: z.string().regex(ID),
  source_type: z.enum(["internal_system", "official_source", "tenant_record", "user_input", "opaque_reference", "fixture"]),
  system: z.string().min(1).max(120), locator: z.string().min(1).max(500),
  version: z.string().min(1).max(128), retrieved_at: z.string().datetime({ offset: true }),
  authority: z.enum(["authoritative", "supporting", "user_provided", "opaque"]),
  content_hash: z.string().regex(HASH),
}).strict();
const statusSchema = z.enum(["success", "needs_input", "manual_review", "blocked", "unavailable"]);
const sourceEnvelopeSchema = z.object({
  schema_version: z.literal(QUOTE_SOURCE_SCHEMA_VERSION), status: statusSchema, data: z.unknown().nullable(),
  reason_codes: z.array(z.string().regex(ID)).max(50), source_refs: z.array(sourceRefSchema).max(50),
  request_id: z.string().regex(REQUEST_ID),
}).strict();

const decimalNullable = z.string().regex(DECIMAL).nullable();
export const zoneDataSchema = z.object({
  currency: z.literal("USD"), source_type: z.enum(["zone_matrix", "llm_auxiliary_advice", "hermes_agent_correction", "learned_manual_quote", "manual_required"]),
  confidence: z.number().int().min(0).max(100), postal_code: z.string().nullable(), postal_prefix: z.string().nullable(),
  preferred_city: z.string().nullable(), city: z.string().nullable(), province: z.string().nullable(), origin: z.string().nullable(),
  zone: z.number().int().nullable(), billing_pallets: z.number().int().min(1).nullable(),
  pallet_breakdown: z.record(z.string(), z.number().int().min(0)), base_price: decimalNullable, fuel: decimalNullable,
  accessorials: z.record(z.string(), z.string().regex(DECIMAL)), total_price: decimalNullable,
  risk_tags: z.array(z.string()).max(100), manual_review_required: z.boolean(), matched_rule: z.string(),
  matched_by: z.string().nullable(), candidate_count: z.number().int().min(0), match_trace: z.record(z.string(), z.unknown()),
  sales_note: z.string().nullable(),
}).strict();
const cargoItemSchema = z.object({ quantity: z.number().int().min(1), length_cm: decimalNullable, width_cm: decimalNullable,
  height_cm: decimalNullable, weight_kg: decimalNullable, cbm: decimalNullable, total_weight_kg: decimalNullable,
  total_cbm: decimalNullable, source_span: z.string().nullable() }).strict();
const extractionSchema = z.object({
  address_line: z.string().nullable(), postal_code: z.string().nullable(), city: z.string().nullable(), province: z.string().nullable(),
  cbm: decimalNullable, weight_kg: decimalNullable, piece_count: z.number().int().min(1).nullable(), packaging_type: z.string().nullable(),
  longest_side_cm: decimalNullable, explicit_pallet_count: z.number().int().min(1).nullable(), is_stackable: z.boolean().nullable(),
  address_type: z.string().nullable(), requires_liftgate: z.boolean(), requires_pallet_jack: z.boolean(), requires_appointment: z.boolean(),
  detention_minutes: z.number().int().min(0), missing_fields: z.array(z.string()).max(100), confidence: z.number().int().min(0).max(100),
  extraction_notes: z.string().nullable(), cargo_items: z.array(cargoItemSchema).max(100),
  cargo_agent: z.record(z.string(), z.unknown()).nullable(), address_agent: z.record(z.string(), z.unknown()).nullable(),
  validation_notes: z.array(z.string()).max(100),
}).strict();
export const extractDataSchema = z.object({ extraction: extractionSchema, extraction_mode: z.enum(["ai", "deterministic_recovery"]),
  missing_fields: z.array(z.string()).max(100), follow_up_question: z.string().nullable(), quote_result: z.null() }).strict();

export type QuotePortalZoneInput = z.input<typeof zoneInputSchema>;
export type QuotePortalExtractInput = z.input<typeof extractInputSchema>;
export type QuotePortalActor = z.infer<typeof actorSchema>;
export type QuoteZonePreviewData = z.infer<typeof zoneDataSchema>;
export type QuoteExtractPreviewData = z.infer<typeof extractDataSchema>;
export interface QuoteDelegationSignInput { readonly subject: string; readonly actorType: "user" | "service"; readonly tenantId: string; readonly serviceCallerId: string; readonly applicationId: string; readonly requestId: string; readonly scope: QuoteDelegationScope }
export interface QuoteDelegationClaims { readonly iss: string; readonly aud: string; readonly sub: string; readonly actor_type: "user" | "service"; readonly tenant_id: string; readonly service_caller_id: string; readonly application_id: string; readonly request_id: string; readonly scope: QuoteDelegationScope; readonly iat: number; readonly nbf: number; readonly exp: number; readonly jti: string }
export interface QuoteDelegationSignedToken { readonly token: string; readonly claims: QuoteDelegationClaims }
export type QuoteDelegationSigner = (input: QuoteDelegationSignInput) => Promise<QuoteDelegationSignedToken>;
export type QuotePortalResult<T> = Readonly<{ schema_version: typeof QUOTE_PORTAL_SCHEMA_VERSION; source_schema_version: typeof QUOTE_SOURCE_SCHEMA_VERSION; status: z.infer<typeof statusSchema>; data: T | null; reason_codes: readonly string[]; source_refs: readonly SourceRef[]; request_id: string; preview_only: true; saved: false; sendable: false }>;

export interface QuotePortalClientOptions {
  readonly baseUrl?: string; readonly tenantId?: string; readonly serviceCallerId?: string;
  readonly applicationId?: string; readonly connectionSecret?: string; readonly delegationSigner?: QuoteDelegationSigner;
  readonly fetchImpl?: typeof fetch; readonly allowLoopbackFixtures?: boolean; readonly timeoutMs?: number;
  readonly maxBodyBytes?: number; readonly clock?: () => Date;
}

function localResult<T>(status: "needs_input" | "blocked" | "unavailable", requestId: string, code: string): QuotePortalResult<T> {
  const safeRequestId = REQUEST_ID.test(requestId) ? requestId : "req_unavailable";
  return { schema_version: QUOTE_PORTAL_SCHEMA_VERSION, source_schema_version: QUOTE_SOURCE_SCHEMA_VERSION, status, data: null,
    reason_codes: [code], source_refs: [], request_id: safeRequestId, preview_only: true, saved: false, sendable: false };
}

function configuredBaseUrl(raw: string | undefined, allowLoopback: boolean): URL | null {
  if (!raw || [...raw].some((char) => char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(raw); const canonical = raw.endsWith("/") ? raw : `${raw}/`;
    if (url.href !== canonical || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol === "https:") return url;
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return allowLoopback && url.protocol === "http:" && loopback ? url : null;
  } catch { return null; }
}

function validSignedToken(value: QuoteDelegationSignedToken, expected: QuoteDelegationSignInput, now: number): boolean {
  const claims = value.claims;
  return typeof value.token === "string" && value.token.length > 0 && Object.keys(claims).sort().join(",") === "actor_type,application_id,aud,exp,iat,iss,jti,nbf,request_id,scope,service_caller_id,sub,tenant_id" &&
    claims.sub === expected.subject && claims.actor_type === expected.actorType && claims.tenant_id === expected.tenantId &&
    claims.service_caller_id === expected.serviceCallerId && claims.application_id === expected.applicationId &&
    claims.request_id === expected.requestId && claims.scope === expected.scope && typeof claims.iss === "string" && claims.iss.length > 0 &&
    typeof claims.aud === "string" && claims.aud.length > 0 && ID.test(claims.jti) && Number.isInteger(claims.iat) &&
    Number.isInteger(claims.nbf) && Number.isInteger(claims.exp) && claims.iat <= claims.nbf && claims.exp > claims.nbf &&
    claims.exp - claims.iat <= 300 && claims.iat <= now + 30 && claims.nbf <= now + 30 && claims.exp > now;
}

export function createQuotePortalClient(options: QuotePortalClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch; const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES; const base = configuredBaseUrl(options.baseUrl, options.allowLoopbackFixtures === true);
  const configured = base && options.tenantId && options.serviceCallerId && options.applicationId && options.connectionSecret && options.delegationSigner;

  async function call<T>(path: string, body: object, actor: QuotePortalActor, requestId: string, scope: QuoteDelegationScope, dataSchema: z.ZodType<T>): Promise<QuotePortalResult<T>> {
    if (!configured) return localResult("unavailable", requestId, "quote_connection_unconfigured");
    if (actor.type === "service" && actor.id !== options.serviceCallerId || actor.type === "user" && actor.id === options.serviceCallerId) return localResult("blocked", requestId, "quote_actor_binding_invalid");
    const signInput: QuoteDelegationSignInput = { subject: actor.id, actorType: actor.type, tenantId: options.tenantId, serviceCallerId: options.serviceCallerId, applicationId: options.applicationId, requestId, scope };
    try {
      const signed = await options.delegationSigner(signInput);
      if (!validSignedToken(signed, signInput, Math.floor((options.clock?.() ?? new Date()).getTime() / 1000))) return localResult("blocked", requestId, "quote_delegation_invalid");
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(new URL(path, base), { method: "POST", redirect: "manual", signal: controller.signal,
          headers: { authorization: `Bearer ${options.connectionSecret}`, "content-type": "application/json", "x-freightclaw-delegation": signed.token, "x-request-id": requestId }, body: JSON.stringify(body) });
        if (response.status >= 300 && response.status < 400) return localResult("unavailable", requestId, "quote_upstream_redirect_rejected");
        const bytes = await readBoundedResponse(response, maxBodyBytes, controller.signal);
        const parsedEnvelope = sourceEnvelopeSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (!parsedEnvelope.success) return localResult("unavailable", requestId, "quote_upstream_contract_invalid");
        const source = parsedEnvelope.data;
        if (source.request_id !== requestId) return localResult("blocked", requestId, "quote_delegation_mismatch");
        const parsedData = source.data === null ? null : dataSchema.safeParse(source.data);
        if (parsedData !== null && !parsedData.success) return localResult("unavailable", requestId, "quote_upstream_contract_invalid");
        let status = source.status; let reasonCodes = [...source.reason_codes];
        if (scope === "quote.zone_preview" && status === "success") {
          const authoritative = source.source_refs.length > 0 && source.source_refs.every((ref) => ref.authority === "authoritative" && ref.source_type !== "fixture");
          if (!authoritative) { status = "manual_review"; reasonCodes = [...reasonCodes, source.source_refs.length ? "quote_source_not_authoritative" : "quote_source_evidence_missing"]; }
        }
        return { schema_version: QUOTE_PORTAL_SCHEMA_VERSION, source_schema_version: QUOTE_SOURCE_SCHEMA_VERSION, status,
          data: parsedData === null ? null : parsedData.data, reason_codes: reasonCodes, source_refs: source.source_refs,
          request_id: requestId, preview_only: true, saved: false, sendable: false };
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (error instanceof ResponseSizeError) return localResult("unavailable", requestId, "quote_upstream_response_too_large");
      if (error instanceof Error && error.name === "AbortError") return localResult("unavailable", requestId, "quote_upstream_timeout");
      return localResult("unavailable", requestId, "quote_upstream_unavailable");
    }
  }

  return Object.freeze({
    async preview(request: { readonly input: QuotePortalZoneInput; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuotePortalResult<QuoteZonePreviewData>> {
      const parsed = previewRequestSchema.safeParse(request);
      if (!parsed.success) return localResult("needs_input", request.requestId, "quote_request_invalid");
      return call("/api/v1/m2m/quote/zone-preview", { schema_version: QUOTE_SOURCE_SCHEMA_VERSION, request: parsed.data.input }, parsed.data.actor, parsed.data.requestId, "quote.zone_preview", zoneDataSchema);
    },
    async extract(request: { readonly input: QuotePortalExtractInput; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuotePortalResult<QuoteExtractPreviewData>> {
      const parsed = extractRequestSchema.safeParse(request);
      if (!parsed.success) return localResult("needs_input", request.requestId, "quote_request_invalid");
      return call("/api/v1/m2m/quote/ai-extract-preview", { schema_version: QUOTE_SOURCE_SCHEMA_VERSION, customer_message: parsed.data.input.customer_message }, parsed.data.actor, parsed.data.requestId, "quote.ai_extract_preview", extractDataSchema);
    },
  });
}
