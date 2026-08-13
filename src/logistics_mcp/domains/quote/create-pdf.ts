import { z } from "zod";

import {
  quoteV2InputSchema,
  quoteV2ResultSchema,
} from "../../adapters/quote/quote-api-adapter";
import type {
  QuotePdfFailure,
  QuotePdfGetResult,
  QuotePdfMetadata,
  QuotePdfPostResult,
} from "../../adapters/pdf/quote-pdf-api-adapter";
import type { QuoteAdapter, AdapterResult } from "../../adapters/ports";
import type { ExecutionContext } from "../../platform/context";
import type { CalculationStep, Notice, SourceRef } from "../../platform/envelope";
import { hashPayload } from "../../platform/idempotency";

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const SAFE_TEXT_REJECT = /^(?:(?:https?|file|data):|(?:https?:)?\/\/|(?:[A-Za-z]:[\\/]|\/{1,2}))/iu;
const HTML_REJECT = /<\s*\/?\s*[A-Za-z][^>]*>/u;
const PREVIEW_REF_RE = /^preview:quote\.pdf:([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})$/u;
const STRICT_DECIMAL_RE = /^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,6}))?$/u;

const identifierSchema = z.string().regex(IDENTIFIER_RE);
const versionSchema = z.string().regex(VERSION_RE);
const dateTimeSchema = z.string().datetime({ offset: true });
const safeText = (max: number) => z.string().min(1).max(max).refine((value) => {
  const trimmed = value.trim();
  return trimmed.length > 0 && !SAFE_TEXT_REJECT.test(trimmed) && !HTML_REJECT.test(value);
});

const approvalSchema = z
  .object({
    required: z.boolean(),
    status: z.enum(["not_required", "pending", "approved", "rejected"]),
    approval_id: identifierSchema.nullable(),
  })
  .strict();

const writeContextSchema = z
  .object({
    idempotency_key: z.string().min(16).max(200).refine((value) => value.trim().length > 0),
    operation_mode: z.enum(["preview", "commit"]),
    preview_ref: identifierSchema.nullable(),
    approval: approvalSchema,
  })
  .strict()
  .superRefine((value, refinement) => {
    if (value.operation_mode === "preview") {
      if (value.preview_ref !== null) {
        refinement.addIssue({ code: "custom", path: ["preview_ref"], message: "preview must not include a preview_ref" });
      }
      if (value.approval.required !== false || value.approval.status !== "not_required" || value.approval.approval_id !== null) {
        refinement.addIssue({ code: "custom", path: ["approval"], message: "preview approval is not required" });
      }
    }
    if (value.operation_mode === "commit") {
      if (value.preview_ref === null) {
        refinement.addIssue({ code: "custom", path: ["preview_ref"], message: "commit requires a preview_ref" });
      }
      if (value.approval.required !== true || value.approval.status !== "approved" || value.approval.approval_id === null) {
        refinement.addIssue({ code: "custom", path: ["approval"], message: "commit requires approved approval" });
      }
    }
  });

export const quoteCreatePdfInputSchema = z
  .object({
    schema_version: z.literal("2026-08-11.v1"),
    version: z.literal("quote-create-pdf-request@2026-08-14.v1"),
    quote_request: quoteV2InputSchema,
    presentation: z
      .object({ customer_display_name: safeText(200) })
      .strict(),
    write_context: writeContextSchema,
  })
  .strict();

const readbackEvidenceShape = {
  target_system: z.string().min(1).max(120),
  record_id: identifierSchema,
  observed_version: versionSchema,
  observed_at: dateTimeSchema,
  verified: z.boolean(),
  source_ref_ids: z.array(identifierSchema).min(1),
};

const readbackEvidenceSchema = z
  .object(readbackEvidenceShape)
  .strict()
  .superRefine((value, refinement) => {
    if (new Set(value.source_ref_ids).size !== value.source_ref_ids.length) {
      refinement.addIssue({ code: "custom", path: ["source_ref_ids"], message: "source_ref_ids must be unique" });
    }
  });

const committedReadbackEvidenceSchema = z
  .object({
    ...readbackEvidenceShape,
    verified: z.literal(true),
  })
  .strict()
  .superRefine((value, refinement) => {
    if (new Set(value.source_ref_ids).size !== value.source_ref_ids.length) {
      refinement.addIssue({ code: "custom", path: ["source_ref_ids"], message: "source_ref_ids must be unique" });
    }
  });

const writeResultBaseSchema = z.object({
  version: z.literal("write-result@2026-08-13.v2"),
  operation: z.literal("quote.create_pdf"),
  operation_status: z.enum(["previewed", "committed", "already_committed", "rejected"]),
  record_id: identifierSchema.nullable(),
  preview_ref: identifierSchema,
  readback_evidence: readbackEvidenceSchema.nullable(),
  idempotency_key: z.string().min(16).max(200),
  approval: approvalSchema,
}).strict();

const previewWriteResultSchema = writeResultBaseSchema.extend({
  operation_status: z.literal("previewed"),
  record_id: z.null(),
  readback_evidence: z.null(),
  approval: z.object({
    required: z.literal(false),
    status: z.literal("not_required"),
    approval_id: z.null(),
  }).strict(),
});

const committedWriteResultSchema = writeResultBaseSchema.extend({
  operation_status: z.enum(["committed", "already_committed"]),
  record_id: identifierSchema,
  readback_evidence: committedReadbackEvidenceSchema,
  approval: z.object({
    required: z.literal(true),
    status: z.literal("approved"),
    approval_id: identifierSchema,
  }).strict(),
});

const rejectedWriteResultSchema = writeResultBaseSchema.extend({
  operation_status: z.literal("rejected"),
});

export const quoteCreatePdfWriteResultSchema = z.discriminatedUnion("operation_status", [
  previewWriteResultSchema,
  committedWriteResultSchema,
  rejectedWriteResultSchema,
]);

export type QuoteCreatePdfInput = z.infer<typeof quoteCreatePdfInputSchema>;
export type QuoteCreatePdfWriteResult = z.infer<typeof quoteCreatePdfWriteResultSchema>;

export interface QuotePdfPort {
  post(
    body: Record<string, unknown>,
    idempotencyKey: string,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<QuotePdfPostResult>;
  get(
    documentRef: string,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<QuotePdfGetResult>;
}

type DomainResult = AdapterResult;
type ParsedQuote = z.infer<typeof quoteV2ResultSchema>;

function notice(code: string, message: string, field: string | null = null): Notice {
  return { code, message, field, severity: "error" };
}

function noData(
  status: DomainResult["status"],
  code: string,
  message: string,
  sourceRefs: readonly SourceRef[] = [],
  calculationTrace: readonly CalculationStep[] = [],
): DomainResult {
  return {
    status,
    data: null,
    sourceRefs,
    blockers: [notice(code, message)],
    calculationTrace,
    ...(status === "manual_review" || status === "unavailable" ? { reviewStatus: "manual_review" as const } : {}),
  };
}

function safeSourceRefs(sourceRefs: readonly SourceRef[]): SourceRef[] {
  return sourceRefs.map((source) => ({
    ...source,
    locator: "opaque://quote-authority",
  }));
}

function safeNotices(notices: readonly Notice[] | undefined): Notice[] | undefined {
  return notices?.map((item) => ({
    code: item.code,
    message: "Authoritative quote outcome was preserved without exposing quote details.",
    severity: item.severity,
    ...(item.field === undefined ? {} : { field: item.field }),
  }));
}

function safeEvidenceTrace(sourceRefs: readonly SourceRef[], status: string): CalculationStep[] {
  const sourceRefIds = sourceRefs.map((source) => source.source_id);
  return sourceRefIds.length === 0
    ? []
    : [{
        step_id: "step:quote:create-pdf:quote-evidence",
        operation: "preserve authoritative quote outcome",
        inputs: [{ name: "quote_status", value: status }],
        result: "preserved",
        source_ref_ids: sourceRefIds,
        rounding: null,
      }];
}

function propagateQuoteResult(result: AdapterResult): DomainResult {
  const sourceRefs = safeSourceRefs(result.sourceRefs);
  const assumptions = safeNotices(result.assumptions);
  const warnings = safeNotices(result.warnings);
  const blockers = result.blockers === undefined || result.blockers.length === 0
    ? [notice("quote.create_pdf.quote_outcome", "The authoritative quote did not produce a PDF candidate.")]
    : safeNotices(result.blockers)!;
  return {
    status: result.status,
    data: null,
    sourceRefs,
    ...(assumptions === undefined ? {} : { assumptions }),
    ...(warnings === undefined ? {} : { warnings }),
    blockers,
    calculationTrace: safeEvidenceTrace(sourceRefs, result.status),
    ...(result.reviewStatus === undefined ? {} : { reviewStatus: result.reviewStatus }),
  };
}

function candidatePayload(
  input: QuoteCreatePdfInput,
  context: ExecutionContext,
  quote: ParsedQuote,
  sourceRefs: readonly SourceRef[],
  calculationTrace: readonly CalculationStep[],
): Record<string, unknown> {
  return {
    tenant_id: context.tenantId,
    quote_request: input.quote_request,
    presentation: input.presentation,
    quote_data: quote,
    quote_source_refs: sourceRefs.map((source) => Object.fromEntries(
      Object.entries(source).filter(([key]) => key !== "retrieved_at"),
    )),
    quote_calculation_trace: calculationTrace,
  };
}

function previewRef(
  candidate: Record<string, unknown>,
  idempotencyKey: string,
): string {
  const candidateDigest = digestBase64Url(candidate);
  const keyDigest = digestBase64Url({ idempotency_key: idempotencyKey });
  return `preview:quote.pdf:${candidateDigest}:${keyDigest}`;
}

function parsePreviewRef(value: string): { candidateDigest: string; keyDigest: string } | null {
  const match = PREVIEW_REF_RE.exec(value);
  if (match === null || decodeDigest(match[1]!) === null || decodeDigest(match[2]!) === null) return null;
  return { candidateDigest: match[1]!, keyDigest: match[2]! };
}

function digestBase64Url(value: unknown): string {
  return Buffer.from(hashPayload(value).slice("sha256:".length), "hex").toString("base64url");
}

function decodeDigest(value: string): Buffer | null {
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value ? decoded : null;
}

function canonicalDecimal(value: unknown): string {
  if (typeof value !== "string") throw new Error("decimal must be a string");
  const match = STRICT_DECIMAL_RE.exec(value);
  if (match === null) throw new Error("decimal is not a supported non-negative string");
  const fraction = match[2]?.replace(/0+$/u, "") ?? "";
  return fraction.length === 0 ? match[1]! : `${match[1]}.${fraction}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalizeQuotePdfAuthorityBody(body: Record<string, unknown>): Record<string, unknown> {
  const data = body.data;
  if (!isRecord(data) || !isRecord(data.total) || !Array.isArray(data.line_items)) {
    throw new Error("quote PDF authority body shape is invalid");
  }
  const total = { ...data.total, amount: canonicalDecimal(data.total.amount) };
  const lineItems = data.line_items.map((item) => {
    if (!isRecord(item) || !isRecord(item.amount)) throw new Error("quote PDF line item shape is invalid");
    return { ...item, amount: { ...item.amount, amount: canonicalDecimal(item.amount.amount) } };
  });
  return { ...body, data: { ...data, total, line_items: lineItems } };
}

function isSafePdfText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && !SAFE_TEXT_REJECT.test(trimmed) && !HTML_REJECT.test(value);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length && rightSet.size === right.length &&
    leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function quoteVersion(quote: ParsedQuote): string {
  return `${quote.release_id}:${quote.rule_version}:${quote.data_version}`;
}

function closedQuoteEvidence(
  quote: ParsedQuote,
  sourceRefs: readonly SourceRef[],
  quoteTrace: readonly CalculationStep[],
): boolean {
  const sourceIds = sourceRefs.map((source) => source.source_id);
  return sourceIds.length > 0 && quoteTrace.length > 0 && sameStringSet(sourceIds, quote.source_ref_ids) &&
    quoteTrace.every((step) => step.source_ref_ids.length > 0 &&
      new Set(step.source_ref_ids).size === step.source_ref_ids.length &&
      step.source_ref_ids.every((sourceId) => sourceIds.includes(sourceId)));
}

function isContextAllowed(context: ExecutionContext): boolean {
  return IDENTIFIER_RE.test(context.tenantId) &&
    context.scopes.includes("quote:pdf_write") &&
    ["admin", "sales", "operator"].includes(context.role);
}

function isCalculatedQuote(quote: ParsedQuote, context: ExecutionContext): boolean {
  return quote.quote_status === "calculated" &&
    quote.tenant === context.tenantId &&
    quote.currency === "USD" &&
    quote.ready === true &&
    quote.test_data === false &&
    quote.sendable === false &&
    VERSION_RE.test(quoteVersion(quote)) &&
    /^sha256:[0-9a-f]{64}$/u.test(quote.snapshot_hash) &&
    /^sha256:[0-9a-f]{64}$/u.test(quote.release_hash) &&
    quote.snapshot_hash === quote.release_hash;
}

function projectPdfBody(quote: ParsedQuote, presentation: QuoteCreatePdfInput["presentation"]): Record<string, unknown> {
  if (quote.quote_status !== "calculated" || quote.total === null) {
    throw new Error("quote is not calculated");
  }
  if (!VERSION_RE.test(quoteVersion(quote)) || quote.line_items.length > 500 || quote.line_items.length < 1) {
    throw new Error("quote identity or line count is invalid");
  }
  const sourceIds = quote.source_ref_ids;
  if (!sameStringSet(sourceIds, quote.line_items.flatMap((line) => line.source_ref_ids))) {
    throw new Error("quote source references are not closed");
  }
  if (new Set(quote.line_items.map((line) => line.line_id)).size !== quote.line_items.length ||
      quote.line_items.some((line) => !isSafePdfText(line.label, 200) || !isSafePdfText(line.pricing_basis, 500))) {
    throw new Error("quote line projection is unsafe");
  }
  return canonicalizeQuotePdfAuthorityBody({
    version: 2,
    kind: "quote",
    sendable: false,
    quote_id: quote.quote_id,
    quote_version: quoteVersion(quote),
    release_id: quote.release_id,
    rule_version: quote.rule_version,
    data_version: quote.data_version,
    effective_date: quote.effective_date,
    snapshot_hash: quote.snapshot_hash,
    release_hash: quote.release_hash,
    data: {
      currency: "USD",
      total: quote.total,
      line_items: quote.line_items,
      presentation,
    },
  });
}

function metadataMatches(
  metadata: QuotePdfMetadata,
  body: Record<string, unknown>,
  inputSha256: string,
): boolean {
  const data = body.data as Record<string, unknown>;
  return metadata.input_sha256 === inputSha256 &&
    metadata.status === "ready" &&
    metadata.sendable === false &&
    metadata.quote_id === body.quote_id &&
    metadata.quote_version === body.quote_version &&
    metadata.release_id === body.release_id &&
    metadata.rule_version === body.rule_version &&
    metadata.data_version === body.data_version &&
    metadata.effective_date === body.effective_date &&
    metadata.snapshot_hash === body.snapshot_hash &&
    metadata.release_hash === body.release_hash &&
    metadata.sendable === body.sendable &&
    data.currency === "USD";
}

function pdfFailureResult(
  failure: QuotePdfFailure,
  sourceRefs: readonly SourceRef[],
  calculationTrace: readonly CalculationStep[],
): DomainResult {
  return noData(failure.kind, failure.code, "The PDF operation did not reach an exact verified readback.", sourceRefs, calculationTrace);
}

function readbackSource(metadata: QuotePdfMetadata, retrievedAt: string): SourceRef {
  return {
    source_id: `src:quote:pdf:readback:${metadata.sha256}`,
    source_type: "internal_system",
    system: "quote-pdf-api",
    locator: "opaque://quote-pdf/readback",
    version: `pdf-renderer:${digestBase64Url({ renderer_version: metadata.renderer_version, template_version: metadata.template_version })}`,
    retrieved_at: retrievedAt,
    authority: "authoritative",
    content_hash: `sha256:${metadata.sha256}`,
  };
}

function resultData(
  input: QuoteCreatePdfInput,
  operationStatus: "previewed" | "committed" | "already_committed",
  previewRefValue: string,
  recordId: string | null,
  readbackEvidence: z.infer<typeof readbackEvidenceSchema> | null,
): QuoteCreatePdfWriteResult {
  const value = {
    version: "write-result@2026-08-13.v2" as const,
    operation: "quote.create_pdf" as const,
    operation_status: operationStatus,
    record_id: recordId,
    preview_ref: previewRefValue,
    readback_evidence: readbackEvidence,
    idempotency_key: input.write_context.idempotency_key,
    approval: input.write_context.approval,
  };
  return quoteCreatePdfWriteResultSchema.parse(value);
}

export async function createQuotePdf(
  quoteAdapter: QuoteAdapter,
  pdfAdapter: QuotePdfPort,
  rawInput: unknown,
  context: ExecutionContext | undefined,
  signal?: AbortSignal,
): Promise<DomainResult> {
  const parsedInput = quoteCreatePdfInputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return noData("needs_input", "quote.create_pdf.input_invalid", "The quote PDF request is invalid.");
  }
  if (context === undefined || !isContextAllowed(context)) {
    return noData("blocked", "quote.create_pdf.execution_context_denied", "A permitted server execution context is required.");
  }
  if (signal?.aborted) {
    return noData("unavailable", "quote.create_pdf.request_aborted", "The quote PDF request was aborted before the quote call.");
  }

  const input = parsedInput.data;
  const commitPreview = input.write_context.operation_mode === "commit"
    ? parsePreviewRef(input.write_context.preview_ref!)
    : null;
  if (input.write_context.operation_mode === "commit" && commitPreview === null) {
    return noData("needs_input", "quote.create_pdf.preview_ref_invalid", "The commit preview_ref is not valid.");
  }
  if (commitPreview !== null) {
    const commitKeyDigest = digestBase64Url({ idempotency_key: input.write_context.idempotency_key });
    if (commitKeyDigest === commitPreview.keyDigest) {
      return noData("needs_input", "quote.create_pdf.preview_commit_key_reused", "Preview and commit require different idempotency keys.");
    }
  }
  let quoteResult: AdapterResult;
  try {
    quoteResult = await quoteAdapter.calculate(input.quote_request, context, signal);
  } catch {
    return noData("unavailable", "quote.create_pdf.quote_call_failed", "The authoritative quote call failed without a usable result.");
  }
  if (quoteResult.status !== "success") return propagateQuoteResult(quoteResult);
  const parsedQuote = quoteV2ResultSchema.safeParse(quoteResult.data);
  const quoteTrace = quoteResult.calculationTrace ?? [];
  if (!parsedQuote.success || !isCalculatedQuote(parsedQuote.data, context) || !closedQuoteEvidence(parsedQuote.data, quoteResult.sourceRefs, quoteTrace)) {
    return noData("unavailable", "quote.create_pdf.quote_result_invalid", "The authoritative quote did not satisfy the PDF projection contract.");
  }
  const sourceRefs = safeSourceRefs(quoteResult.sourceRefs);

  let projectedBody: Record<string, unknown>;
  try {
    projectedBody = projectPdfBody(parsedQuote.data, input.presentation);
  } catch {
    return noData("unavailable", "quote.create_pdf.projection_invalid", "The authoritative quote could not be projected to PDF input.", sourceRefs, safeEvidenceTrace(sourceRefs, "calculated"));
  }

  const candidate = candidatePayload(input, context, parsedQuote.data, quoteResult.sourceRefs, quoteTrace);
  const candidateDigest = digestBase64Url(candidate);
  if (input.write_context.operation_mode === "preview") {
    const assumptions = safeNotices(quoteResult.assumptions);
    const warnings = safeNotices(quoteResult.warnings);
    const generatedRef = previewRef(candidate, input.write_context.idempotency_key);
    const trace: CalculationStep[] = [{
      step_id: "step:quote:candidate",
      operation: "form opaque quote candidate",
      inputs: [
        { name: "quote_version", value: quoteVersion(parsedQuote.data) },
        { name: "candidate_digest", value: candidateDigest },
      ],
      result: "previewed",
      source_ref_ids: sourceRefs.map((source) => source.source_id),
      rounding: null,
    }];
    return {
      status: "success",
      data: resultData(input, "previewed", generatedRef, null, null),
      sourceRefs,
      ...(assumptions === undefined ? {} : { assumptions }),
      ...(warnings === undefined ? {} : { warnings }),
      blockers: [],
      calculationTrace: trace,
      reviewStatus: "not_required",
    };
  }

  if (commitPreview!.candidateDigest !== candidateDigest) {
    return noData("manual_review", "quote.create_pdf.candidate_drift", "The authoritative quote candidate changed before commit.", sourceRefs, safeEvidenceTrace(sourceRefs, "calculated"));
  }

  const body = projectedBody;
  const inputSha256 = hashPayload(body).slice("sha256:".length);
  let posted: QuotePdfPostResult;
  try {
    posted = await pdfAdapter.post(body, input.write_context.idempotency_key, context, signal);
  } catch {
    return noData("manual_review", "quote.create_pdf.post_unknown", "The PDF write result is unknown after dispatch.", sourceRefs, safeEvidenceTrace(sourceRefs, "calculated"));
  }
  if (!posted.ok) return pdfFailureResult(posted.failure, sourceRefs, safeEvidenceTrace(sourceRefs, "calculated"));
  if (!metadataMatches(posted.metadata, body, inputSha256)) {
    return noData("manual_review", "quote.create_pdf.post_identity_mismatch", "The PDF response did not match the projected quote identity.", sourceRefs, safeEvidenceTrace(sourceRefs, "calculated"));
  }

  let read: QuotePdfGetResult;
  try {
    read = await pdfAdapter.get(posted.metadata.document_ref, context, signal);
  } catch {
    return noData("manual_review", "quote.create_pdf.readback_unknown", "The PDF readback result is unknown after dispatch.", sourceRefs, safeEvidenceTrace(sourceRefs, "calculated"));
  }
  if (!read.ok) {
    if (signal?.aborted) {
      return noData("manual_review", "quote.create_pdf.readback_aborted", "The PDF readback was aborted after the write attempt.", sourceRefs, safeEvidenceTrace(sourceRefs, "calculated"));
    }
    return pdfFailureResult(read.failure, sourceRefs, safeEvidenceTrace(sourceRefs, "calculated"));
  }
  if (hashPayload(read.metadata) !== hashPayload(posted.metadata) || !metadataMatches(read.metadata, body, inputSha256)) {
    return noData("manual_review", "quote.create_pdf.readback_identity_mismatch", "The PDF metadata readback did not exactly match the committed projection.", sourceRefs, safeEvidenceTrace(sourceRefs, "calculated"));
  }

  const retrievedAt = new Date().toISOString();
  const pdfSource = readbackSource(read.metadata, retrievedAt);
  const allSourceRefs = [...sourceRefs, pdfSource];
  const readbackEvidence = {
    target_system: "quote-pdf-api",
    record_id: read.metadata.document_ref,
    observed_version: `sha256:${read.metadata.sha256}`,
    observed_at: retrievedAt,
    verified: true as const,
    source_ref_ids: [pdfSource.source_id],
  };
  const trace: CalculationStep[] = [
    {
      step_id: "step:quote:create-pdf:quote-authority",
      operation: "project authoritative quote identity",
      inputs: [{ name: "quote_version", value: body.quote_version as string }],
      result: "projected",
      source_ref_ids: sourceRefs.map((source) => source.source_id),
      rounding: null,
    },
    {
      step_id: "step:quote:create-pdf:readback",
      operation: "verify PDF metadata readback",
      inputs: [{ name: "document_ref", value: read.metadata.document_ref }],
      result: "verified",
      source_ref_ids: [pdfSource.source_id],
      rounding: null,
    },
  ];
  const assumptions = safeNotices(quoteResult.assumptions);
  const warnings = safeNotices(quoteResult.warnings);
  return {
    status: "success",
    data: resultData(input, posted.status === 201 ? "committed" : "already_committed", input.write_context.preview_ref!, read.metadata.document_ref, readbackEvidence),
    sourceRefs: allSourceRefs,
    ...(assumptions === undefined ? {} : { assumptions }),
    ...(warnings === undefined ? {} : { warnings }),
    blockers: [],
    calculationTrace: trace,
    reviewStatus: "approved",
  };
}
