import Decimal from "decimal.js";

import type {
  AdapterResult,
  QuoteAdapter,
} from "../ports";
import { hashPayload } from "../../platform/idempotency";
import type { SourceRef } from "../../platform/envelope";

export type QuoteLookupStatus =
  | "matched"
  | "zone_conflict"
  | "zone_missing"
  | "price_missing";

export interface QuoteMoney {
  readonly amount: string;
  readonly currency: string;
}

export interface QuoteLookupRecord {
  readonly status: QuoteLookupStatus;
  readonly quote_id: string;
  readonly currency?: string;
  readonly zone: number | null;
  readonly base_price: QuoteMoney | null;
  readonly fuel_percent: string | null;
  readonly accessorials: Readonly<Record<string, QuoteMoney>>;
  readonly rule_version: string;
  readonly data_version: string;
  readonly valid_from: string;
  readonly valid_to: string;
  readonly matched_by: string;
  readonly source_ref: SourceRef;
}

export interface QuoteDraftWriteRecord {
  readonly record_id: string;
  readonly tenant_id: string;
  readonly quote_id: string;
  readonly revision: string;
  readonly source_ref: SourceRef;
}

export interface QuoteDraftReadbackRecord {
  readonly record_id: string;
  readonly tenant_id: string;
  readonly quote_id: string;
  readonly revision: string;
  readonly status: "draft";
  readonly source_ref: SourceRef;
}

export interface QuoteUpstreamSource {
  lookup(input: Record<string, unknown>): Promise<QuoteLookupRecord>;
  saveDraft(input: Record<string, unknown>): Promise<QuoteDraftWriteRecord>;
  readDraft(
    recordId: string,
    tenantId: string,
  ): Promise<QuoteDraftReadbackRecord | null>;
}

export interface ExistingQuoteAdapterOptions {
  readonly source?: QuoteUpstreamSource;
  readonly clock?: () => Date;
  readonly fallback?: unknown;
}

interface PreviewState {
  readonly requestHash: string;
  readonly tenantId: string;
  readonly quoteId: string;
  readonly previewRef: string;
}

interface CommittedState {
  readonly requestHash: string;
  readonly result: AdapterResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value[key]) ? value[key] : null;
}

function notice(
  code: string,
  message: string,
  severity: "info" | "warning" | "error" = "error",
  field: string | null = null,
) {
  return { code, message, severity, field } as const;
}

function money(amount: Decimal, currency: string): QuoteMoney {
  return { amount: amount.toDecimalPlaces(2).toFixed(2), currency };
}

function quoteSourceRef(quoteResult: Record<string, unknown>): SourceRef {
  const quoteId = stringValue(quoteResult.quote_id) ?? "unknown";
  const version = stringValue(quoteResult.version) ?? "quote-result@unknown";
  return {
    source_id: `src:quote:preview:${quoteId}`,
    source_type: "opaque_reference",
    system: "existing-quote-system",
    locator: `opaque://quote-result/${quoteId}`,
    version,
    retrieved_at: "2026-08-11T00:00:00Z",
    authority: "opaque",
    content_hash: null,
  };
}

function isoStart(value: string): string {
  return value.includes("T") ? value : `${value}T00:00:00Z`;
}

function isoEnd(value: string): string {
  return value.includes("T") ? value : `${value}T23:59:59Z`;
}

function dateIsWithin(
  requested: string,
  validFrom: string,
  validTo: string,
): boolean {
  const day = requested.slice(0, 10);
  return day >= validFrom.slice(0, 10) && day <= validTo.slice(0, 10);
}

function sourceStatusBlocker(status: QuoteLookupStatus): string {
  switch (status) {
    case "zone_conflict":
      return "quote.zone_conflict";
    case "zone_missing":
      return "quote.zone_missing";
    case "price_missing":
      return "quote.price_missing";
    case "matched":
      return "quote.source_not_calculable";
  }
}

function quoteManualData(
  record: QuoteLookupRecord,
  blockerCode: string,
): Record<string, unknown> {
  return {
    version: `quote-result@${record.data_version}`,
    quote_id: record.quote_id,
    quote_status: "manual_review",
    currency: record.currency ?? record.base_price?.currency ?? "XXX",
    total: null,
    line_items: [
      {
        line_id: "line:quote:base",
        label: "Canada final-mile base price",
        amount: null,
        pricing_basis: blockerCode,
        source_ref_ids: [record.source_ref.source_id],
      },
    ],
    rule_version: record.rule_version,
    data_version: record.data_version,
    sendable: false,
    valid_from: null,
    valid_to: null,
    source_ref_ids: [record.source_ref.source_id],
  };
}

function writeContext(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  return nestedRecord(input, "write_context");
}

function tenantId(input: Record<string, unknown>): string | null {
  return stringValue(nestedRecord(writeContext(input), "tenant_context")?.tenant_id);
}

function idempotencyKey(input: Record<string, unknown>): string | null {
  return stringValue(writeContext(input)?.idempotency_key);
}

function approval(input: Record<string, unknown>): Record<string, unknown> {
  return nestedRecord(writeContext(input), "approval") ?? {
    required: false,
    status: "not_required",
    approval_id: null,
  };
}

function quoteResultInput(input: Record<string, unknown>): Record<string, unknown> | null {
  return nestedRecord(input, "quote_result");
}

function targetIsDraft(input: Record<string, unknown>): boolean {
  const target = nestedRecord(input, "target");
  return target?.system === "existing_quote_system" && target.record_kind === "draft";
}

function writeResult(
  status: "previewed" | "committed" | "already_committed" | "rejected",
  input: Record<string, unknown>,
  previewRef: string,
  recordId: string | null,
  readback: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    version: "write-result@2026-08-11.v1",
    operation: "quote.save_draft",
    operation_status: status,
    record_id: recordId,
    preview_ref: previewRef,
    readback_evidence: readback,
    idempotency_key: idempotencyKey(input) ?? "invalid-idempotency-key",
    approval: approval(input),
  };
}

export class ExistingQuoteAdapter implements QuoteAdapter {
  private readonly previews = new Map<string, PreviewState>();
  private readonly commits = new Map<string, CommittedState>();
  private readonly clock: () => Date;
  private readonly source: QuoteUpstreamSource | undefined;

  constructor(options: ExistingQuoteAdapterOptions = {}) {
    this.clock = options.clock ?? (() => new Date("2026-08-11T00:00:00Z"));
    this.source = options.source;
  }

  async calculate(input: Record<string, unknown>): Promise<AdapterResult> {
    if (this.source === undefined) {
      return {
        status: "unavailable",
        data: null,
        sourceRefs: [],
        blockers: [
          notice(
            "quote.adapter_disabled",
            "The existing quote endpoint is disabled until its route, tenant scope, and readback contract are verified.",
          ),
        ],
        reviewStatus: "manual_review",
      };
    }
    const destination = nestedRecord(input, "destination");
    const addressType = stringValue(destination?.address_type);
    if (addressType === null || addressType === "unknown") {
      return {
        status: "needs_input",
        data: null,
        sourceRefs: [],
        blockers: [
          notice(
            "quote.address_type_required",
            "A confirmed destination address type is required before Zone pricing.",
            "error",
            "destination.address_type",
          ),
        ],
      };
    }
    const record = await this.source.lookup(input);
    const sourceRefs = [record.source_ref];
    if (record.status !== "matched") {
      const blockerCode = sourceStatusBlocker(record.status);
      return {
        status: "manual_review",
        data: quoteManualData(record, blockerCode),
        sourceRefs,
        blockers: [
          notice(
            blockerCode,
            "The authoritative Zone or price lookup did not produce a unique usable row.",
            "error",
            "destination.postal_code",
          ),
        ],
        warnings: [
          notice(
            "quote.not_sendable",
            "Phase 1 quote results cannot be sent or published.",
            "warning",
          ),
        ],
        reviewStatus: "manual_review",
      };
    }

    const effectiveAt = stringValue(input.effective_at);
    if (
      effectiveAt === null ||
      !dateIsWithin(effectiveAt, record.valid_from, record.valid_to)
    ) {
      return {
        status: "manual_review",
        data: quoteManualData(record, "quote.rule_expired"),
        sourceRefs,
        blockers: [
          notice(
            "quote.rule_expired",
            "The requested effective date is outside the authoritative rule validity window.",
            "error",
            "effective_at",
          ),
        ],
        reviewStatus: "manual_review",
      };
    }
    if (record.zone === null || record.base_price === null || record.fuel_percent === null) {
      return {
        status: "manual_review",
        data: quoteManualData(record, "quote.price_missing"),
        sourceRefs,
        blockers: [
          notice(
            "quote.price_missing",
            "The authoritative price row is incomplete; no total was calculated.",
          ),
        ],
        reviewStatus: "manual_review",
      };
    }

    const base = new Decimal(record.base_price.amount);
    const fuel = base.mul(new Decimal(record.fuel_percent)).div(100).toDecimalPlaces(2);
    const lineItems: Array<Record<string, unknown>> = [
      {
        line_id: "line:quote:base",
        label: "Canada final-mile base price",
        amount: money(base, record.base_price.currency),
        pricing_basis: `origin=${record.zone}; matched_by=${record.matched_by}`,
        source_ref_ids: [record.source_ref.source_id],
      },
      {
        line_id: "line:quote:fuel",
        label: "Fuel surcharge",
        amount: money(fuel, record.base_price.currency),
        pricing_basis: `fuel_percent=${record.fuel_percent}`,
        source_ref_ids: [record.source_ref.source_id],
      },
    ];
    let total = base.add(fuel);
    const services = nestedRecord(input, "services");
    const requestedFees: string[] = [];
    if (["residential", "private", "rural_residential"].includes(addressType)) {
      requestedFees.push("residential_fee");
    }
    if (services?.appointment === true) requestedFees.push("appointment_fee");
    if (services?.liftgate === true) requestedFees.push("liftgate_fee");
    if (services?.limited_access === true) requestedFees.push("limited_access_fee");
    if (services?.remote_area === true) requestedFees.push("remote_area_fee");
    for (const key of requestedFees) {
      const fee = record.accessorials[key];
      if (fee === undefined) {
        return {
          status: "manual_review",
          data: quoteManualData(record, "quote.accessorial_price_missing"),
          sourceRefs,
          blockers: [
            notice(
              "quote.accessorial_price_missing",
              "A requested accessorial has no versioned price row.",
              "error",
              `services.${key}`,
            ),
          ],
          reviewStatus: "manual_review",
        };
      }
      const amount = new Decimal(fee.amount);
      total = total.add(amount);
      lineItems.push({
        line_id: `line:quote:${key}`,
        label: key,
        amount: money(amount, fee.currency),
        pricing_basis: `versioned accessorial=${key}`,
        source_ref_ids: [record.source_ref.source_id],
      });
    }

    const resultData: Record<string, unknown> = {
      version: `quote-result@${record.data_version}`,
      quote_id: record.quote_id,
      quote_status: "calculated",
      currency: record.base_price.currency,
      total: money(total, record.base_price.currency),
      line_items: lineItems,
      rule_version: record.rule_version,
      data_version: record.data_version,
      sendable: false,
      valid_from: isoStart(record.valid_from),
      valid_to: isoEnd(record.valid_to),
      source_ref_ids: [record.source_ref.source_id],
    };
    return {
      status: "success",
      data: resultData,
      sourceRefs,
      warnings: [
        notice(
          "quote.not_sendable",
          "Phase 1 quote results cannot be sent or published.",
          "info",
        ),
      ],
      calculationTrace: [
        {
          step_id: "step:quote:fuel",
          operation: "calculate fuel",
          inputs: [
            { name: "base_price", value: money(base, record.base_price.currency) },
            { name: "fuel_percent", value: record.fuel_percent },
          ],
          result: money(fuel, record.base_price.currency),
          source_ref_ids: [record.source_ref.source_id],
          rounding: "2 decimal places",
        },
        {
          step_id: "step:quote:total",
          operation: "sum quote line items",
          inputs: lineItems.map((item) => ({
            name: String(item.line_id),
            value: item.amount as { amount: string; currency: string },
          })),
          result: money(total, record.base_price.currency),
          source_ref_ids: [record.source_ref.source_id],
          rounding: "2 decimal places",
        },
      ],
    };
  }

  async previewDraft(input: Record<string, unknown>): Promise<AdapterResult> {
    if (this.source === undefined) return this.disabledWriteResult(input);
    await Promise.resolve();
    const parsed = this.validateDraftInput(input, "preview");
    if (parsed.error !== null) return parsed.error;
    const quoteResult = parsed.quoteResult;
    const tenant = parsed.tenant;
    const requestHash = hashPayload({
      quote_result: quoteResult,
      target: input.target,
    });
    const quoteId = stringValue(quoteResult.quote_id) ?? "quote-unknown";
    const previewRef = `preview:quote-save:${requestHash.slice(7, 23)}`;
    this.previews.set(previewRef, {
      requestHash,
      tenantId: tenant,
      quoteId,
      previewRef,
    });
    const data = writeResult("previewed", input, previewRef, null, null);
    const sourceRef = quoteSourceRef(quoteResult);
    return {
      status: "success",
      data,
      sourceRefs: [sourceRef],
      warnings: [
        notice(
          "quote.preview_no_write",
          "Preview generated without writing an existing quote record.",
          "info",
        ),
      ],
    };
  }

  async commitDraft(input: Record<string, unknown>): Promise<AdapterResult> {
    const parsed = this.validateDraftInput(input, "commit");
    if (parsed.error !== null) return parsed.error;
    if (this.source === undefined) return this.disabledWriteResult(input);
    const previewRef = stringValue(parsed.writeContext.preview_ref);
    if (previewRef === null) {
      return this.writeFailure(input, "quote.preview_required", "A preview reference is required before commit.");
    }
    const preview = this.previews.get(previewRef);
    if (preview === undefined || preview.tenantId !== parsed.tenant) {
      return this.writeFailure(input, "quote.preview_unknown", "The preview reference is not valid for this tenant.");
    }
    const requestHash = hashPayload({ quote_result: parsed.quoteResult, target: input.target });
    if (requestHash !== preview.requestHash) {
      return this.writeFailure(input, "quote.preview_hash_mismatch", "The commit payload does not match the preview.");
    }
    const approvalValue = approval(input);
    if (
      approvalValue.required === true &&
      (approvalValue.status !== "approved" || typeof approvalValue.approval_id !== "string")
    ) {
      return this.writeFailure(input, "quote.approval_required", "The quote draft commit is not approved.", "blocked");
    }
    const key = parsed.key;
    const existing = this.commits.get(`${parsed.tenant}\u0000${key}`);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        return this.writeFailure(input, "quote.idempotency_conflict", "The idempotency key conflicts with another draft request.");
      }
      const existingData = isRecord(existing.result.data)
        ? { ...existing.result.data, operation_status: "already_committed" }
        : existing.result.data;
      return { ...existing.result, data: existingData };
    }

    const saved = await this.source.saveDraft({
      quote_result: parsed.quoteResult,
      target: input.target,
      tenant_id: parsed.tenant,
    });
    const readback = await this.source.readDraft(saved.record_id, parsed.tenant);
    if (
      readback === null ||
      readback.tenant_id !== parsed.tenant ||
      readback.quote_id !== preview.quoteId ||
      readback.record_id !== saved.record_id
    ) {
      return this.writeFailure(input, "quote.readback_missing", "The draft write could not be verified by readback.");
    }
    const readbackEvidence = {
      target_system: "existing-quote-system",
      record_id: readback.record_id,
      observed_version: readback.revision,
      observed_at: this.clock().toISOString(),
      verified: true,
      source_ref_ids: [readback.source_ref.source_id],
    };
    const result: AdapterResult = {
      status: "success",
      data: writeResult("committed", input, previewRef, readback.record_id, readbackEvidence),
      sourceRefs: [saved.source_ref, readback.source_ref],
      warnings: [
        notice(
          "quote.draft_only",
          "The existing quote system draft was saved; it was not published or sent.",
          "info",
        ),
      ],
    };
    this.commits.set(`${parsed.tenant}\u0000${key}`, {
      requestHash,
      result,
    });
    return result;
  }

  async readDraft(input: Record<string, unknown>): Promise<AdapterResult> {
    if (this.source === undefined) return this.disabledWriteResult(input);
    const recordId = stringValue(input.record_id);
    const tenant = stringValue(input.tenant_id);
    if (recordId === null || tenant === null) {
      return this.writeFailure(input, "quote.readback_input_required", "A tenant and draft record ID are required.");
    }
    const readback = await this.source.readDraft(recordId, tenant);
    if (readback === null) {
      return this.writeFailure(input, "quote.readback_missing", "The requested draft record was not found.");
    }
    return {
      status: "success",
      data: writeResult(
        "committed",
        {
          write_context: {
            idempotency_key: "idem_readback_demo_123456",
            approval: { required: false, status: "not_required", approval_id: null },
          },
        },
        `preview:quote-read:${recordId}`,
        readback.record_id,
        {
          target_system: "existing-quote-system",
          record_id: readback.record_id,
          observed_version: readback.revision,
          observed_at: this.clock().toISOString(),
          verified: true,
          source_ref_ids: [readback.source_ref.source_id],
        },
      ),
      sourceRefs: [readback.source_ref],
    };
  }

  private validateDraftInput(
    input: Record<string, unknown>,
    mode: "preview" | "commit",
  ):
    | {
        readonly error: AdapterResult;
        readonly quoteResult?: never;
        readonly tenant?: never;
        readonly key?: never;
        readonly writeContext?: never;
      }
    | {
        readonly error: null;
        readonly quoteResult: Record<string, unknown>;
        readonly tenant: string;
        readonly key: string;
        readonly writeContext: Record<string, unknown>;
      } {
    if (!targetIsDraft(input)) {
      return {
        error: this.writeFailure(input, "quote.target_invalid", "Only existing quote drafts are allowed."),
      };
    }
    const quoteResult = quoteResultInput(input);
    const context = writeContext(input);
    const tenant = tenantId(input);
    const key = idempotencyKey(input);
    if (quoteResult === null || context === null || tenant === null || key === null) {
      return {
        error: this.writeFailure(input, "quote.write_context_required", "A quote result, tenant context, and idempotency key are required."),
      };
    }
    if (quoteResult.sendable !== false) {
      return {
        error: this.writeFailure(input, "quote.sendable_forbidden", "Only non-sendable quote results may be saved as drafts.", "blocked"),
      };
    }
    if (context.operation_mode !== mode) {
      return {
        error: this.writeFailure(input, "quote.operation_mode_mismatch", "The write operation mode does not match the adapter method."),
      };
    }
    return { error: null, quoteResult, tenant, key, writeContext: context };
  }

  private disabledWriteResult(input: Record<string, unknown>): AdapterResult {
    return this.writeFailure(
      input,
      "quote.adapter_disabled",
      "The existing quote write endpoint is disabled until its route and readback contract are verified.",
      "unavailable",
    );
  }

  private writeFailure(
    input: Record<string, unknown>,
    code: string,
    message: string,
    status: "manual_review" | "blocked" | "unavailable" = "manual_review",
  ): AdapterResult {
    const previewRef = stringValue(writeContext(input)?.preview_ref) ?? `preview:quote-rejected:${hashPayload(input).slice(7, 23)}`;
    return {
      status,
      data: writeResult("rejected", input, previewRef, null, null),
      sourceRefs: [],
      blockers: [notice(code, message)],
      reviewStatus: status === "unavailable" ? "manual_review" : "manual_review",
    };
  }
}
