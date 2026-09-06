import { createHash } from "node:crypto";
import { z } from "zod";

import type { SourceRef } from "../../../../src/logistics_mcp/platform/envelope.js";
import type { QuotePortalActor, QuotePortalZoneInput } from "./quote-client.js";

export const QUOTE_RECORD_PORTAL_SCHEMA_VERSION = "portal-quote-record@2026-09-05.v1" as const;
export const QUOTE_RECORD_PREPARE_SCHEMA_VERSION = "quote-record-prepare@2026-09-05.v1" as const;
export const QUOTE_RECORD_WRITE_SCHEMA_VERSION = "quote-record-write@2026-09-05.v1" as const;
export const QUOTE_REVIEW_SCHEMA_VERSION = "quote-review-resolution@2026-09-05.v2" as const;
export const QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION = "quote-document-create@2026-09-05.v2" as const;
export const QUOTE_DOCUMENT_SCHEMA_VERSION = "quote-document@2026-09-05.v2" as const;
export type QuoteRecordDelegationScope = "quote.zone_preview" | "quote.record_save" | "quote.record_read" | "quote.review_read" | "quote.review_manage" | "quote.document_generate" | "quote.document_read";

const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{8,128}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/u;
const MONEY = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const RECORD_REF = /^record_[A-Za-z0-9_-]{12,64}$/u;
const TASK_REF = /^task_[A-Za-z0-9_-]{12,64}$/u;
const DOCUMENT_REF = /^document_[A-Za-z0-9_-]{12,64}$/u;
const STATUS = z.enum(["success", "needs_input", "manual_review", "blocked", "unavailable"]);

const actorSchema = z.object({ type: z.enum(["user", "service"]), id: z.string().regex(ID) }).strict();
const zoneInputSchema = z.object({
  address_line: z.string().trim().min(1).max(500).nullable().optional(),
  postal_code: z.string().trim().regex(/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/u),
  city: z.string().trim().min(1).max(120).nullable().optional(), province: z.string().trim().min(2).max(32).nullable().optional(),
  cbm: z.string().regex(DECIMAL), weight_kg: z.string().regex(DECIMAL), piece_count: z.number().int().min(1),
  packaging_type: z.string().trim().min(1).max(80), longest_side_cm: z.string().regex(DECIMAL).nullable().optional(),
  address_type: z.enum(["commercial", "residential", "private", "rural_residential"]), requires_liftgate: z.boolean(),
  requires_pallet_jack: z.boolean(), requires_appointment: z.boolean(), explicit_pallet_count: z.number().int().min(1).nullable(),
  is_stackable: z.boolean().nullable(), detention_minutes: z.number().int().min(0),
}).strict();
const sourceRefSchema = z.object({
  source_id: z.string().regex(ID), source_type: z.enum(["internal_system", "official_source", "tenant_record", "user_input", "opaque_reference", "fixture"]),
  system: z.string().min(1).max(120), locator: z.string().min(1).max(500), version: z.string().min(1).max(128),
  retrieved_at: z.string().datetime({ offset: true }), authority: z.enum(["authoritative", "supporting", "user_provided", "opaque"]),
  content_hash: z.string().regex(HASH),
}).strict();
const decimalNullable = z.string().regex(DECIMAL).nullable();
const zoneDataSchema = z.object({
  currency: z.literal("USD"), source_type: z.enum(["zone_matrix", "llm_auxiliary_advice", "hermes_agent_correction", "learned_manual_quote", "manual_required"]),
  confidence: z.number().int().min(0).max(100), postal_code: z.string().nullable(), postal_prefix: z.string().nullable(),
  preferred_city: z.string().nullable(), city: z.string().nullable(), province: z.string().nullable(), origin: z.string().nullable(),
  zone: z.number().int().nullable(), billing_pallets: z.number().int().min(1).nullable(), pallet_breakdown: z.record(z.string(), z.number().int().min(0)),
  base_price: decimalNullable, fuel: decimalNullable, accessorials: z.record(z.string(), z.string().regex(DECIMAL)), total_price: decimalNullable,
  risk_tags: z.array(z.string()).max(100), manual_review_required: z.boolean(), matched_rule: z.string(), matched_by: z.string().nullable(),
  candidate_count: z.number().int().min(0), match_trace: z.record(z.string(), z.unknown()), sales_note: z.string().nullable(),
}).strict();
const reviewEvidenceSchema = z.object({ evidence_ref: z.string().regex(ID), evidence_version: z.string().min(1).max(128), effective_at: z.string().datetime({ offset: true }), valid_until: z.string().datetime({ offset: true }) }).strict();
const chargeLineSchema = z.object({ code: z.string().regex(ID), label: z.string().min(1).max(120), amount_usd: z.string().regex(MONEY) }).strict();
const serviceConditionsSchema = zoneInputSchema;
const resolutionSchema = z.object({
  decision: z.literal("approve_manual_price"), total_price_usd: z.string().regex(DECIMAL), currency: z.literal("USD"),
  review_evidence: reviewEvidenceSchema, charge_lines: z.array(chargeLineSchema).min(1).max(40), customer_terms: z.string().min(2).max(4000),
  service_conditions: serviceConditionsSchema, source_snapshot_hash: z.string().regex(HASH), note: z.string().min(2).max(1000), reviewer_actor_id: z.string().regex(ID),
  resolved_at: z.string().datetime({ offset: true }), recalculation: z.object({ schema_version: z.string().min(1).max(128), preview: zoneDataSchema, source_refs: z.array(sourceRefSchema).max(50) }).strict(),
}).strict();
const savedRecordSchema = z.object({
  operation_ref: z.string().regex(/^op_[A-Za-z0-9_-]{12,64}$/u).optional(), record_ref: z.string().regex(RECORD_REF),
  record_version: z.number().int().min(1), record_status: z.enum(["draft", "manual_required", "quoted"]),
  review_task_ref: z.string().regex(TASK_REF).nullable(), currency: z.literal("USD"),
  saved: z.literal(true), sendable: z.literal(false), readback_verified: z.literal(true), created_at: z.string().datetime({ offset: true }),
  quote_ready: z.boolean().optional(), pdf_available: z.boolean().optional(), bookable: z.literal(false).optional(),
  total_price_usd: decimalNullable.optional(), review_evidence: reviewEvidenceSchema.nullable().optional(), charge_lines: z.array(chargeLineSchema).min(1).max(40).nullable().optional(),
  customer_terms: z.string().min(2).max(4000).nullable().optional(), service_conditions: serviceConditionsSchema.nullable().optional(), source_snapshot_hash: z.string().regex(HASH).nullable().optional(), resolution: resolutionSchema.nullable().optional(),
  request: zoneInputSchema, preview: zoneDataSchema, source_refs: z.array(sourceRefSchema).max(50),
}).strict();
const pendingRecordSchema = z.object({ operation_ref: z.string().regex(/^op_[A-Za-z0-9_-]{12,64}$/u), record_ref: z.string().regex(RECORD_REF),
  saved: z.literal(true), sendable: z.literal(false), readback_verified: z.literal(false) }).strict();
const changedPreviewSchema = z.object({ saved: z.literal(false), sendable: z.literal(false), preview_changed: z.literal(true), preview: zoneDataSchema,
  preview_handle: z.string().min(32).max(4096), expires_at: z.string().datetime({ offset: true }) }).strict();
const prepareDataSchema = z.object({ preview: zoneDataSchema.nullable(), preview_handle: z.string().min(32).max(4096).nullable(),
  expires_at: z.string().datetime({ offset: true }).nullable() }).strict();
const writeDataSchema = z.union([savedRecordSchema, pendingRecordSchema, changedPreviewSchema]);
const historyDataSchema = z.object({ records: z.array(savedRecordSchema).max(100), next_cursor: z.string().regex(RECORD_REF).nullable() }).strict();
const reviewTaskSchema = z.object({ task_ref: z.string().regex(TASK_REF), record_ref: z.string().regex(RECORD_REF),
  status: z.string().min(1).max(32), task_version: z.number().int().min(1), reason: z.string().min(1).max(500), risk_tags: z.array(z.string()).max(100),
  resolved_price_usd: decimalNullable, created_at: z.string().datetime({ offset: true }).nullable(), updated_at: z.string().datetime({ offset: true }).nullable() }).strict();
const reviewDataSchema = z.object({ tasks: z.array(reviewTaskSchema).max(100) }).strict();
const reviewQueueTaskSchema = z.object({ task_ref: z.string().regex(TASK_REF), task_version: z.number().int().min(1), record_ref: z.string().regex(RECORD_REF),
  record_version: z.number().int().min(1), status: z.literal("pending"), reason: z.string().min(1).max(500), risk_tags: z.array(z.string()).max(100),
  created_by_actor_id: z.string().regex(ID), created_at: z.string().datetime({ offset: true }).nullable(), updated_at: z.string().datetime({ offset: true }).nullable() }).strict();
const reviewQueueDataSchema = z.object({ tasks: z.array(reviewQueueTaskSchema).max(100) }).strict();
const reviewPrepareReadySchema = z.object({ record_ref: z.string().regex(RECORD_REF), record_version: z.number().int().min(1), task_ref: z.string().regex(TASK_REF),
  task_version: z.number().int().min(1), preview: zoneDataSchema, resolution_handle: z.string().min(32).max(4096), expires_at: z.string().datetime({ offset: true }) }).strict();
const reviewPrepareDataSchema = z.union([reviewPrepareReadySchema, z.object({ record_ref: z.string().regex(RECORD_REF), task_ref: z.string().regex(TASK_REF),
  preview: zoneDataSchema.nullable(), resolution_handle: z.null() }).strict()]);
const reviewResolutionSuccessSchema = z.object({ operation_ref: z.string().regex(/^op_[A-Za-z0-9_-]{12,64}$/u), record_ref: z.string().regex(RECORD_REF),
  record_version: z.number().int().min(1), record_status: z.enum(["manual_required", "quoted"]), task_ref: z.string().regex(TASK_REF), task_version: z.number().int().min(1),
  task_status: z.enum(["pending", "resolved"]), total_price_usd: decimalNullable, currency: z.literal("USD"), review_evidence: reviewEvidenceSchema.nullable(),
  charge_lines: z.array(chargeLineSchema).min(1).max(40).nullable(), customer_terms: z.string().min(2).max(4000).nullable(), service_conditions: serviceConditionsSchema.nullable(), source_snapshot_hash: z.string().regex(HASH).nullable(),
  source_refs: z.array(sourceRefSchema).max(50), quote_ready: z.boolean(), saved: z.literal(true), sendable: z.literal(false), pdf_available: z.literal(false),
  bookable: z.literal(false), readback_verified: z.literal(true) }).strict();
const reviewResolutionPendingSchema = z.object({ operation_ref: z.string().regex(/^op_[A-Za-z0-9_-]{12,64}$/u), record_ref: z.string().regex(RECORD_REF), task_ref: z.string().regex(TASK_REF),
  saved: z.literal(true), quote_ready: z.literal(false), sendable: z.literal(false), pdf_available: z.literal(false), bookable: z.literal(false), readback_verified: z.literal(false) }).strict();
const reviewContextChangedSchema = z.object({ record_ref: z.string().regex(RECORD_REF), record_version: z.number().int().min(1), task_ref: z.string().regex(TASK_REF), task_version: z.number().int().min(1),
  preview: zoneDataSchema.nullable().optional(), quote_ready: z.literal(false), sendable: z.literal(false) }).strict();
const reviewResolutionDataSchema = z.union([reviewResolutionSuccessSchema, reviewResolutionPendingSchema, reviewContextChangedSchema]);
const documentSourceRefSchema = z.object({ source_type: z.literal("source_system_quote_record"), authority: z.literal("record_snapshot"), record_ref: z.string().regex(RECORD_REF),
  record_version: z.number().int().min(1), formal: z.boolean(), valid_until: z.string().datetime({ offset: true }).nullable(), source_snapshot_hash: z.string().regex(HASH).nullable(), content_hash: z.string().regex(HASH) }).strict();
const documentDataSchema = z.object({ document_ref: z.string().regex(DOCUMENT_REF), record_ref: z.string().regex(RECORD_REF), record_version: z.number().int().min(1),
  document_kind: z.enum(["formal_quote_pdf", "draft_quote_pdf"]), formal: z.boolean(), valid_now: z.boolean(), historical_snapshot: z.boolean(), watermark: z.string().min(1).max(100).nullable(), media_type: z.literal("application/pdf"),
  content_sha256: z.string().regex(HASH), content_length: z.number().int().min(1).max(10_485_760), schema_version: z.literal(QUOTE_DOCUMENT_SCHEMA_VERSION),
  download_path: z.string().regex(/^\/api\/v1\/m2m\/quote\/documents\/document_[A-Za-z0-9_-]{12,64}\/content$/u), issued_at: z.string().datetime({ offset: true }), valid_until: z.string().datetime({ offset: true }).nullable(),
  source_snapshot_hash: z.string().regex(HASH).nullable(), terms_hash: z.string().regex(HASH).nullable(), created_at: z.string().datetime({ offset: true }), readback_verified: z.literal(true) }).strict();
const documentPendingSchema = z.object({ operation_ref: z.string().regex(/^op_[A-Za-z0-9_-]{12,64}$/u), record_ref: z.string().regex(RECORD_REF), document_ref: z.string().regex(DOCUMENT_REF).nullable(), saved: z.literal(true), readback_verified: z.literal(false) }).strict();
const documentNotReadySchema = z.object({ record_ref: z.string().regex(RECORD_REF), quote_ready: z.literal(false), pdf_available: z.boolean() }).strict();
const documentResultSchema = z.union([documentDataSchema, documentPendingSchema, documentNotReadySchema]);
type CallKind = "prepare" | "save" | "get" | "list" | "review" | "review_queue" | "review_prepare" | "review_resolve" | "document";

export interface QuoteRecordDelegationSignInput { readonly subject: string; readonly actorType: "user" | "service"; readonly tenantId: string; readonly serviceCallerId: string; readonly applicationId: string; readonly requestId: string; readonly scope: QuoteRecordDelegationScope }
export interface QuoteRecordDelegationClaims { readonly iss: string; readonly aud: string; readonly sub: string; readonly actor_type: "user" | "service"; readonly tenant_id: string; readonly service_caller_id: string; readonly application_id: string; readonly request_id: string; readonly scope: QuoteRecordDelegationScope; readonly iat: number; readonly nbf: number; readonly exp: number; readonly jti: string }
export interface QuoteRecordDelegationSignedToken { readonly token: string; readonly claims: QuoteRecordDelegationClaims }
export type QuoteRecordDelegationSigner = (input: QuoteRecordDelegationSignInput) => Promise<QuoteRecordDelegationSignedToken>;
type QuoteSourceSchemaVersion = typeof QUOTE_RECORD_PREPARE_SCHEMA_VERSION | typeof QUOTE_RECORD_WRITE_SCHEMA_VERSION | typeof QUOTE_REVIEW_SCHEMA_VERSION | typeof QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION;
export type QuoteRecordPortalResult<T> = Readonly<{ schema_version: typeof QUOTE_RECORD_PORTAL_SCHEMA_VERSION; source_schema_version: QuoteSourceSchemaVersion; status: z.infer<typeof STATUS>; data: T | null; reason_codes: readonly string[]; source_refs: readonly (SourceRef | QuoteDocumentSourceRef)[]; request_id: string }>;
export type QuoteSavedRecord = z.infer<typeof savedRecordSchema>;
export type QuoteReviewTask = z.infer<typeof reviewTaskSchema>;
export type QuoteRecordPrepareData = z.infer<typeof prepareDataSchema>;
export type QuoteRecordWriteData = z.infer<typeof writeDataSchema>;
export type QuoteRecordHistoryData = z.infer<typeof historyDataSchema>;
export type QuoteRecordReviewData = z.infer<typeof reviewDataSchema>;
export type QuoteReviewQueueData = z.infer<typeof reviewQueueDataSchema>;
export type QuoteReviewPrepareData = z.infer<typeof reviewPrepareDataSchema>;
export type QuoteReviewResolutionData = z.infer<typeof reviewResolutionDataSchema>;
export type QuoteDocumentData = z.infer<typeof documentDataSchema>;
export type QuoteDocumentSourceRef = z.infer<typeof documentSourceRefSchema>;
export type QuoteDocumentResultData = z.infer<typeof documentResultSchema>;
export type QuoteDocumentDownload = Readonly<{ metadata: QuoteDocumentData; bytes: Uint8Array }>;

export interface QuoteRecordPortalClientOptions {
  readonly baseUrl?: string; readonly tenantId?: string; readonly serviceCallerId?: string; readonly applicationId?: string;
  readonly connectionSecret?: string; readonly delegationSigner?: QuoteRecordDelegationSigner; readonly fetchImpl?: typeof fetch;
  readonly allowLoopbackFixtures?: boolean; readonly timeoutMs?: number; readonly maxBodyBytes?: number; readonly clock?: () => Date;
}

function localResult<T>(sourceSchema: QuoteSourceSchemaVersion,
  status: "needs_input" | "blocked" | "unavailable", requestId: string, code: string): QuoteRecordPortalResult<T> {
  return { schema_version: QUOTE_RECORD_PORTAL_SCHEMA_VERSION, source_schema_version: sourceSchema, status, data: null,
    reason_codes: [code], source_refs: [], request_id: REQUEST_ID.test(requestId) ? requestId : "req_unavailable" };
}

function configuredBaseUrl(raw: string | undefined, allowLoopback: boolean): URL | null {
  if (!raw || [...raw].some((char) => char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(raw); const canonical = raw.endsWith("/") ? raw : `${raw}/`;
    if (url.href !== canonical || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol === "https:") return url;
    return allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? url : null;
  } catch { return null; }
}

function validSignedToken(value: QuoteRecordDelegationSignedToken, expected: QuoteRecordDelegationSignInput, now: number): boolean {
  const claims = value.claims;
  return typeof value.token === "string" && value.token.length > 0 && Object.keys(claims).sort().join(",") === "actor_type,application_id,aud,exp,iat,iss,jti,nbf,request_id,scope,service_caller_id,sub,tenant_id" &&
    claims.sub === expected.subject && claims.actor_type === expected.actorType && claims.tenant_id === expected.tenantId &&
    claims.service_caller_id === expected.serviceCallerId && claims.application_id === expected.applicationId && claims.request_id === expected.requestId &&
    claims.scope === expected.scope && typeof claims.iss === "string" && claims.iss.length > 0 && typeof claims.aud === "string" && claims.aud.length > 0 &&
    ID.test(claims.jti) && Number.isInteger(claims.iat) && Number.isInteger(claims.nbf) && Number.isInteger(claims.exp) &&
    claims.iat <= claims.nbf && claims.exp > claims.nbf && claims.exp - claims.iat <= 300 && claims.iat <= now + 30 && claims.nbf <= now + 30 && claims.exp > now;
}

function refsEqual(left: readonly z.infer<typeof sourceRefSchema>[], right: readonly z.infer<typeof sourceRefSchema>[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.source_id === other.source_id && item.source_type === other.source_type && item.system === other.system &&
      item.locator === other.locator && item.version === other.version && item.retrieved_at === other.retrieved_at &&
      item.authority === other.authority && item.content_hash === other.content_hash;
  });
}

function authoritative(refs: readonly z.infer<typeof sourceRefSchema>[]): boolean {
  return refs.length > 0 && refs.every((ref) => ref.authority === "authoritative" && ref.source_type !== "fixture");
}

function httpMatchesStatus(httpStatus: number, status: z.infer<typeof STATUS>): boolean {
  if (httpStatus >= 200 && httpStatus < 300) return true;
  if (httpStatus === 400 || httpStatus === 422) return status === "needs_input" || status === "blocked";
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) return status === "blocked";
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return status === "unavailable";
  return false;
}

function outcomeInvariant(kind: CallKind, status: z.infer<typeof STATUS>, data: unknown,
  reasonCodes: readonly string[], rawOuterRefs: readonly unknown[]): { status: z.infer<typeof STATUS>; reasonCodes: string[] } | null {
  const outerRefs = rawOuterRefs as readonly z.infer<typeof sourceRefSchema>[];
  if (data === null) return ["needs_input", "blocked", "unavailable"].includes(status) ? { status, reasonCodes: [...reasonCodes] } : null;
  if (kind === "prepare") {
    const prepared = data as z.infer<typeof prepareDataSchema>;
    if (status === "success" || status === "manual_review") {
      if (prepared.preview === null || prepared.preview_handle === null || prepared.expires_at === null) return null;
      if (status === "success" && !authoritative(outerRefs)) return { status: "manual_review", reasonCodes: [...reasonCodes,
        outerRefs.length === 0 ? "quote_source_evidence_missing" : "quote_source_not_authoritative"] };
      return { status, reasonCodes: [...reasonCodes] };
    }
    return prepared.preview_handle === null && prepared.expires_at === null ? { status, reasonCodes: [...reasonCodes] } : null;
  }
  if (kind === "save") {
    const value = data as z.infer<typeof writeDataSchema>;
    if ("preview_changed" in value) return status === "manual_review" && reasonCodes.includes("preview_changed")
      ? { status, reasonCodes: [...reasonCodes] } : null;
    if (value.readback_verified === false) return status === "manual_review" && reasonCodes.includes("write_readback_pending")
      ? { status, reasonCodes: [...reasonCodes] } : null;
    if (!refsEqual(value.source_refs, outerRefs)) return null;
    if (value.record_status === "draft") return status === "success" && value.review_task_ref === null && authoritative(outerRefs)
      ? { status, reasonCodes: [...reasonCodes] } : null;
    return status === "manual_review" && value.review_task_ref !== null && reasonCodes.includes("quote_source_not_authoritative")
      ? { status, reasonCodes: [...reasonCodes] } : null;
  }
  if (kind === "get") {
    const value = data as z.infer<typeof savedRecordSchema>;
    if (!refsEqual(value.source_refs, outerRefs)) return null;
    if (value.record_status === "quoted") return ((status === "success" && value.quote_ready === true) || (status === "manual_review" && value.quote_ready === false && reasonCodes.includes("quote_validity_expired"))) && value.total_price_usd !== null && value.review_evidence != null && value.resolution != null
      ? { status, reasonCodes: [...reasonCodes] } : null;
    if (value.record_status === "draft") return status === "success" && value.review_task_ref === null && authoritative(outerRefs)
      ? { status, reasonCodes: [...reasonCodes] } : null;
    return status === "manual_review" && value.review_task_ref !== null && reasonCodes.includes("quote_source_not_authoritative")
      ? { status, reasonCodes: [...reasonCodes] } : null;
  }
  if (kind === "review_prepare") {
    const value = data as z.infer<typeof reviewPrepareDataSchema>;
    if (value.resolution_handle === null) return ["needs_input", "blocked", "unavailable"].includes(status) ? { status, reasonCodes: [...reasonCodes] } : null;
    return status === "manual_review" && reasonCodes.length > 0 ? { status, reasonCodes: [...reasonCodes] } : null;
  }
  if (kind === "review_resolve") {
    if ("readback_verified" in (data as object) && (data as { readback_verified?: boolean }).readback_verified === false) return status === "manual_review" && reasonCodes.includes("write_readback_pending") ? { status, reasonCodes: [...reasonCodes] } : null;
    if ("source_refs" in (data as object) && !refsEqual((data as { source_refs: z.infer<typeof sourceRefSchema>[] }).source_refs, outerRefs)) return null;
    if ((data as { quote_ready?: boolean }).quote_ready === true) return status === "success" && (data as { readback_verified?: boolean }).readback_verified === true ? { status, reasonCodes: [...reasonCodes] } : null;
    return status === "manual_review" ? { status, reasonCodes: [...reasonCodes] } : null;
  }
  if (kind === "document") {
    if ("readback_verified" in (data as object) && (data as { readback_verified?: boolean }).readback_verified === false) return status === "manual_review" && reasonCodes.includes("document_readback_pending") ? { status, reasonCodes: [...reasonCodes] } : null;
    if ("formal" in (data as object)) {
      const document = data as z.infer<typeof documentDataSchema>;
      const refs = rawOuterRefs as z.infer<typeof documentSourceRefSchema>[];
      if (document.download_path !== `/api/v1/m2m/quote/documents/${document.document_ref}/content`) return null;
      if (refs.length !== 1 || refs[0]?.record_ref !== document.record_ref || refs[0].record_version !== document.record_version || refs[0].formal !== document.formal || refs[0].content_hash !== document.content_sha256 || refs[0].valid_until !== document.valid_until || refs[0].source_snapshot_hash !== document.source_snapshot_hash) return null;
      const validFormal = document.formal && document.historical_snapshot && document.watermark === null && ((document.valid_now && status === "success") || (!document.valid_now && status === "manual_review" && reasonCodes.includes("quote_document_expired")));
      return document.formal === (document.document_kind === "formal_quote_pdf") && (document.formal ? validFormal : document.watermark === "DRAFT - NOT A FORMAL QUOTE" && !document.valid_now && !document.historical_snapshot && status === "manual_review") ? { status, reasonCodes: [...reasonCodes] } : null;
    }
    return status === "manual_review" && reasonCodes.includes("quote_not_ready_for_formal_pdf") ? { status, reasonCodes: [...reasonCodes] } : null;
  }
  return status === "success" ? { status, reasonCodes: [...reasonCodes] } : null;
}

export function createQuoteRecordPortalClient(options: QuoteRecordPortalClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch; const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES; const base = configuredBaseUrl(options.baseUrl, options.allowLoopbackFixtures === true);
  const configured = base && options.tenantId && options.serviceCallerId && options.applicationId && options.connectionSecret && options.delegationSigner;

  async function call<T>(method: "GET" | "POST", path: string, body: object | null, actor: QuotePortalActor, requestId: string,
    scope: QuoteRecordDelegationScope, sourceSchema: QuoteSourceSchemaVersion,
    dataSchema: z.ZodType<T>, kind: CallKind, idempotencyKey?: string, refsSchema: z.ZodTypeAny = sourceRefSchema): Promise<QuoteRecordPortalResult<T>> {
    if (!configured) return localResult(sourceSchema, "unavailable", requestId, "quote_connection_unconfigured");
    if (actor.type === "service" && actor.id !== options.serviceCallerId || actor.type === "user" && actor.id === options.serviceCallerId) return localResult(sourceSchema, "blocked", requestId, "quote_actor_binding_invalid");
    const signInput: QuoteRecordDelegationSignInput = { subject: actor.id, actorType: actor.type, tenantId: options.tenantId,
      serviceCallerId: options.serviceCallerId, applicationId: options.applicationId, requestId, scope };
    try {
      const signed = await options.delegationSigner(signInput);
      if (!validSignedToken(signed, signInput, Math.floor((options.clock?.() ?? new Date()).getTime() / 1000))) return localResult(sourceSchema, "blocked", requestId, "quote_delegation_invalid");
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${options.connectionSecret}`, "x-freightclaw-delegation": signed.token, "x-request-id": requestId };
        if (body !== null) headers["content-type"] = "application/json";
        if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
        const init: RequestInit = { method, redirect: "manual", signal: controller.signal, headers };
        if (body !== null) init.body = JSON.stringify(body);
        const response = await fetchImpl(new URL(path, base), init);
        if (response.status >= 300 && response.status < 400) return localResult(sourceSchema, "unavailable", requestId, "quote_upstream_redirect_rejected");
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) return localResult(sourceSchema, "unavailable", requestId, "quote_upstream_response_too_large");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxBodyBytes) return localResult(sourceSchema, "unavailable", requestId, "quote_upstream_response_too_large");
        const envelopeSchema = z.object({ schema_version: z.literal(sourceSchema), status: STATUS, data: z.unknown().nullable(),
          reason_codes: z.array(z.string().regex(ID)).max(50), source_refs: z.array(refsSchema).max(50), request_id: z.string().regex(REQUEST_ID) }).strict();
        const parsedEnvelope = envelopeSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (!parsedEnvelope.success) return localResult(sourceSchema, "unavailable", requestId, "quote_upstream_contract_invalid");
        const source = parsedEnvelope.data;
        if (source.request_id !== requestId) return localResult(sourceSchema, "blocked", requestId, "quote_delegation_mismatch");
        if (!httpMatchesStatus(response.status, source.status)) return localResult(sourceSchema, "unavailable", requestId, "quote_upstream_contract_invalid");
        const parsedData = source.data === null ? null : dataSchema.safeParse(source.data);
        if (parsedData !== null && !parsedData.success) return localResult(sourceSchema, "unavailable", requestId, "quote_upstream_contract_invalid");
        const data = parsedData === null ? null : parsedData.data;
        const outcome = outcomeInvariant(kind, source.status, data, source.reason_codes, source.source_refs);
        if (outcome === null) return localResult(sourceSchema, "unavailable", requestId, "quote_upstream_contract_invalid");
        return { schema_version: QUOTE_RECORD_PORTAL_SCHEMA_VERSION, source_schema_version: sourceSchema, status: outcome.status,
          data, reason_codes: outcome.reasonCodes, source_refs: source.source_refs as readonly (SourceRef | QuoteDocumentSourceRef)[], request_id: requestId };
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return localResult(sourceSchema, "unavailable", requestId, "quote_upstream_timeout");
      return localResult(sourceSchema, "unavailable", requestId, "quote_upstream_unavailable");
    }
  }

  const baseRequest = z.object({ actor: actorSchema, requestId: z.string().regex(REQUEST_ID) });
  return Object.freeze({
    async prepare(request: { readonly input: QuotePortalZoneInput; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteRecordPrepareData>> {
      const parsed = baseRequest.extend({ input: zoneInputSchema }).strict().safeParse(request);
      if (!parsed.success) return localResult(QUOTE_RECORD_PREPARE_SCHEMA_VERSION, "needs_input", request.requestId, "quote_record_request_invalid");
      return call("POST", "/api/v1/m2m/quote/records/prepare", { schema_version: QUOTE_RECORD_PREPARE_SCHEMA_VERSION, request: parsed.data.input },
        parsed.data.actor, parsed.data.requestId, "quote.zone_preview", QUOTE_RECORD_PREPARE_SCHEMA_VERSION, prepareDataSchema, "prepare");
    },
    async save(request: { readonly input: QuotePortalZoneInput; readonly previewHandle: string; readonly idempotencyKey: string; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteRecordWriteData>> {
      const parsed = baseRequest.extend({ input: zoneInputSchema, previewHandle: z.string().min(32).max(4096), idempotencyKey: z.string().regex(IDEMPOTENCY_KEY) }).strict().safeParse(request);
      if (!parsed.success) return localResult(QUOTE_RECORD_WRITE_SCHEMA_VERSION, "needs_input", request.requestId, "quote_record_request_invalid");
      if (parsed.data.actor.type !== "user") return localResult(QUOTE_RECORD_WRITE_SCHEMA_VERSION, "blocked", parsed.data.requestId, "quote_record_user_required");
      return call("POST", "/api/v1/m2m/quote/records", { schema_version: QUOTE_RECORD_WRITE_SCHEMA_VERSION, preview_handle: parsed.data.previewHandle,
        request: parsed.data.input, intent: "save_draft" }, parsed.data.actor, parsed.data.requestId, "quote.record_save", QUOTE_RECORD_WRITE_SCHEMA_VERSION, writeDataSchema, "save", parsed.data.idempotencyKey);
    },
    async get(request: { readonly recordRef: string; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteSavedRecord>> {
      const parsed = baseRequest.extend({ recordRef: z.string().regex(RECORD_REF) }).strict().safeParse(request);
      if (!parsed.success) return localResult(QUOTE_RECORD_WRITE_SCHEMA_VERSION, "needs_input", request.requestId, "quote_record_request_invalid");
      return call("GET", `/api/v1/m2m/quote/records/${encodeURIComponent(parsed.data.recordRef)}`, null, parsed.data.actor, parsed.data.requestId,
        "quote.record_read", QUOTE_RECORD_WRITE_SCHEMA_VERSION, savedRecordSchema, "get");
    },
    async list(request: { readonly cursor?: string; readonly limit?: number; readonly status?: "draft" | "manual_required" | "quoted"; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteRecordHistoryData>> {
      const parsed = baseRequest.extend({ cursor: z.string().regex(RECORD_REF).optional(), limit: z.number().int().min(1).max(100).optional(), status: z.enum(["draft", "manual_required", "quoted"]).optional() }).strict().safeParse(request);
      if (!parsed.success) return localResult(QUOTE_RECORD_WRITE_SCHEMA_VERSION, "needs_input", request.requestId, "quote_record_request_invalid");
      const query = new URLSearchParams(); if (parsed.data.cursor) query.set("cursor", parsed.data.cursor); if (parsed.data.limit !== undefined) query.set("limit", String(parsed.data.limit)); if (parsed.data.status) query.set("status", parsed.data.status);
      const suffix = query.size ? `?${query.toString()}` : "";
      return call("GET", `/api/v1/m2m/quote/records${suffix}`, null, parsed.data.actor, parsed.data.requestId,
        "quote.record_read", QUOTE_RECORD_WRITE_SCHEMA_VERSION, historyDataSchema, "list");
    },
    async reviewTasks(request: { readonly recordRef?: string; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteRecordReviewData>> {
      const parsed = baseRequest.extend({ recordRef: z.string().regex(RECORD_REF).optional() }).strict().safeParse(request);
      if (!parsed.success) return localResult(QUOTE_RECORD_WRITE_SCHEMA_VERSION, "needs_input", request.requestId, "quote_record_request_invalid");
      const suffix = parsed.data.recordRef ? `?record_ref=${encodeURIComponent(parsed.data.recordRef)}` : "";
      return call("GET", `/api/v1/m2m/quote/review-tasks${suffix}`, null, parsed.data.actor, parsed.data.requestId,
        "quote.review_read", QUOTE_RECORD_WRITE_SCHEMA_VERSION, reviewDataSchema, "review");
    },
    async reviewQueue(request: { readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteReviewQueueData>> {
      const parsed = baseRequest.strict().safeParse(request);
      if (!parsed.success || parsed.data.actor.type !== "user") return localResult(QUOTE_REVIEW_SCHEMA_VERSION, "blocked", request.requestId, "quote_reviewer_required");
      return call("GET", "/api/v1/m2m/quote/review-queue", null, parsed.data.actor, parsed.data.requestId,
        "quote.review_manage", QUOTE_REVIEW_SCHEMA_VERSION, reviewQueueDataSchema, "review_queue");
    },
    async prepareReview(request: { readonly taskRef: string; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteReviewPrepareData>> {
      const parsed = baseRequest.extend({ taskRef: z.string().regex(TASK_REF) }).strict().safeParse(request);
      if (!parsed.success || parsed.data.actor.type !== "user") return localResult(QUOTE_REVIEW_SCHEMA_VERSION, "blocked", request.requestId, "quote_reviewer_required");
      return call("GET", `/api/v1/m2m/quote/review-tasks/${encodeURIComponent(parsed.data.taskRef)}/resolution-preview`, null, parsed.data.actor, parsed.data.requestId,
        "quote.review_manage", QUOTE_REVIEW_SCHEMA_VERSION, reviewPrepareDataSchema, "review_prepare");
    },
    async resolveReview(request: { readonly taskRef: string; readonly expectedTaskVersion: number; readonly resolutionHandle: string; readonly decision: "approve_manual_price" | "keep_manual_review";
      readonly totalPriceUsd?: string; readonly evidenceRef?: string; readonly evidenceVersion?: string; readonly effectiveAt?: string; readonly validUntil?: string;
      readonly chargeLines?: readonly { readonly code: string; readonly label: string; readonly amountUsd: string }[]; readonly customerTerms?: string; readonly note: string;
      readonly confirmed?: "human_verified_price_and_source"; readonly idempotencyKey: string; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteReviewResolutionData>> {
      const schema = baseRequest.extend({ taskRef: z.string().regex(TASK_REF), expectedTaskVersion: z.number().int().min(1), resolutionHandle: z.string().min(32).max(4096),
        decision: z.enum(["approve_manual_price", "keep_manual_review"]), totalPriceUsd: z.string().regex(MONEY).optional(), evidenceRef: z.string().regex(ID).optional(),
        evidenceVersion: z.string().min(1).max(128).optional(), effectiveAt: z.string().datetime({ offset: true }).optional(), validUntil: z.string().datetime({ offset: true }).optional(),
        chargeLines: z.array(z.object({ code: z.string().regex(ID), label: z.string().min(1).max(120), amountUsd: z.string().regex(MONEY) }).strict()).min(1).max(40).optional(), customerTerms: z.string().min(2).max(4000).optional(), note: z.string().trim().min(2).max(1000),
        confirmed: z.literal("human_verified_price_and_source").optional(), idempotencyKey: z.string().regex(IDEMPOTENCY_KEY) }).strict();
      const parsed = schema.safeParse(request);
      if (!parsed.success || parsed.data.actor.type !== "user") return localResult(QUOTE_REVIEW_SCHEMA_VERSION, "needs_input", request.requestId, "quote_review_resolution_invalid");
      const approval = parsed.data.decision === "approve_manual_price";
      const evidence = [parsed.data.totalPriceUsd, parsed.data.evidenceRef, parsed.data.evidenceVersion, parsed.data.effectiveAt, parsed.data.validUntil, parsed.data.chargeLines, parsed.data.customerTerms, parsed.data.confirmed];
      if (approval ? !evidence.every((value) => value !== undefined) : evidence.some((value) => value !== undefined)) {
        return localResult(QUOTE_REVIEW_SCHEMA_VERSION, "needs_input", parsed.data.requestId, "quote_review_resolution_invalid");
      }
      if (approval) {
        const moneyCents = (value: string): bigint => { const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")); };
        const effective = Date.parse(parsed.data.effectiveAt!); const validUntil = Date.parse(parsed.data.validUntil!);
        const sum = parsed.data.chargeLines!.reduce((total, line) => total + moneyCents(line.amountUsd), 0n);
        if (sum !== moneyCents(parsed.data.totalPriceUsd!) || validUntil <= effective || validUntil <= (options.clock?.() ?? new Date()).getTime() || validUntil - effective > 366 * 86_400_000) {
          return localResult(QUOTE_REVIEW_SCHEMA_VERSION, "needs_input", parsed.data.requestId, "quote_review_resolution_invalid");
        }
      }
      const body: Record<string, unknown> = { schema_version: QUOTE_REVIEW_SCHEMA_VERSION, expected_task_version: parsed.data.expectedTaskVersion,
        resolution_handle: parsed.data.resolutionHandle, decision: parsed.data.decision, currency: "USD", note: parsed.data.note };
      if (approval) Object.assign(body, { total_price_usd: parsed.data.totalPriceUsd, evidence_ref: parsed.data.evidenceRef,
        evidence_version: parsed.data.evidenceVersion, effective_at: parsed.data.effectiveAt, valid_until: parsed.data.validUntil,
        charge_lines: parsed.data.chargeLines?.map((line) => ({ code: line.code, label: line.label, amount_usd: line.amountUsd })), customer_terms: parsed.data.customerTerms, confirmed: parsed.data.confirmed });
      return call("POST", `/api/v1/m2m/quote/review-tasks/${encodeURIComponent(parsed.data.taskRef)}/resolve`, body, parsed.data.actor, parsed.data.requestId,
        "quote.review_manage", QUOTE_REVIEW_SCHEMA_VERSION, reviewResolutionDataSchema, "review_resolve", parsed.data.idempotencyKey);
    },
    async createDocument(request: { readonly recordRef: string; readonly documentKind: "formal_quote_pdf" | "draft_quote_pdf"; readonly idempotencyKey: string; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteDocumentResultData>> {
      const parsed = baseRequest.extend({ recordRef: z.string().regex(RECORD_REF), documentKind: z.enum(["formal_quote_pdf", "draft_quote_pdf"]), idempotencyKey: z.string().regex(IDEMPOTENCY_KEY) }).strict().safeParse(request);
      if (!parsed.success || parsed.data.actor.type !== "user") return localResult(QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, "needs_input", request.requestId, "quote_document_request_invalid");
      return call("POST", `/api/v1/m2m/quote/records/${encodeURIComponent(parsed.data.recordRef)}/documents`, { schema_version: QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, document_kind: parsed.data.documentKind },
        parsed.data.actor, parsed.data.requestId, "quote.document_generate", QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, documentResultSchema, "document", parsed.data.idempotencyKey, documentSourceRefSchema);
    },
    async getDocument(request: { readonly documentRef: string; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteDocumentData>> {
      const parsed = baseRequest.extend({ documentRef: z.string().regex(DOCUMENT_REF) }).strict().safeParse(request);
      if (!parsed.success || parsed.data.actor.type !== "user") return localResult(QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, "blocked", request.requestId, "quote_document_not_visible");
      return call("GET", `/api/v1/m2m/quote/documents/${encodeURIComponent(parsed.data.documentRef)}`, null, parsed.data.actor, parsed.data.requestId,
        "quote.document_read", QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, documentDataSchema, "document", undefined, documentSourceRefSchema);
    },
    async downloadDocument(request: { readonly documentRef: string; readonly actor: QuotePortalActor; readonly requestId: string }): Promise<QuoteRecordPortalResult<QuoteDocumentDownload>> {
      const parsed = baseRequest.extend({ documentRef: z.string().regex(DOCUMENT_REF) }).strict().safeParse(request);
      if (!parsed.success || parsed.data.actor.type !== "user" || !configured) return localResult(QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, "blocked", request.requestId, "quote_document_not_visible");
      const metadata = await this.getDocument(parsed.data);
      if (metadata.status !== "success" && metadata.status !== "manual_review" || !metadata.data) return metadata as QuoteRecordPortalResult<QuoteDocumentDownload>;
      const signInput: QuoteRecordDelegationSignInput = { subject: parsed.data.actor.id, actorType: "user", tenantId: options.tenantId, serviceCallerId: options.serviceCallerId, applicationId: options.applicationId, requestId: parsed.data.requestId, scope: "quote.document_read" };
      try {
        const signed = await options.delegationSigner(signInput);
        if (!validSignedToken(signed, signInput, Math.floor((options.clock?.() ?? new Date()).getTime() / 1000))) return localResult(QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, "blocked", parsed.data.requestId, "quote_delegation_invalid");
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(new URL(metadata.data.download_path, base), { method: "GET", redirect: "manual", signal: controller.signal,
            headers: { authorization: `Bearer ${options.connectionSecret}`, "x-freightclaw-delegation": signed.token, "x-request-id": parsed.data.requestId } });
          if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0] !== "application/pdf") return localResult(QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, "unavailable", parsed.data.requestId, "quote_document_download_invalid");
          const declared = response.headers.get("content-length"); if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) !== metadata.data.content_length)) return localResult(QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, "unavailable", parsed.data.requestId, "quote_document_download_invalid");
          const bytes = new Uint8Array(await response.arrayBuffer());
          const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          if (bytes.byteLength !== metadata.data.content_length || bytes.byteLength > 10_485_760 || hash !== metadata.data.content_sha256 || !bytes.subarray(0, 5).every((value, index) => value === [37, 80, 68, 70, 45][index])) return localResult(QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, "unavailable", parsed.data.requestId, "quote_document_download_invalid");
          const etag = response.headers.get("etag"); if (etag !== null && etag !== `"${hash.slice(7)}"`) return localResult(QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, "unavailable", parsed.data.requestId, "quote_document_download_invalid");
          return { ...metadata, data: Object.freeze({ metadata: metadata.data, bytes }) };
        } finally { clearTimeout(timer); }
      } catch (error) { return localResult(QUOTE_DOCUMENT_CREATE_SCHEMA_VERSION, "unavailable", parsed.data.requestId, error instanceof Error && error.name === "AbortError" ? "quote_upstream_timeout" : "quote_upstream_unavailable"); }
    },
  });
}
