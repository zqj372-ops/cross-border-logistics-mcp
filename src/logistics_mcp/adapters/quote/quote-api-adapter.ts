import Decimal from "decimal.js";
import { z } from "zod";

import type { ExecutionContext } from "../../platform/context";
import type { CalculationStep, SourceRef } from "../../platform/envelope";
import { hashPayload } from "../../platform/idempotency";
import {
  lengthToCentimeters,
  volumeToCbm,
  weightToKilograms,
} from "../../domains/cargo/units";
import type {
  LengthUnit,
  VolumeUnit,
  WeightUnit,
} from "../../domains/cargo/models";
import {
  createFetchJsonClient,
  HttpAdapterError,
  type FetchImplementation,
  type FetchJsonAllowedStatusResponse,
  type FetchJsonClient,
} from "../http-client";
import type { AdapterResult, FixtureInput } from "../ports";
import { ExistingQuoteAdapter } from "./existing-quote-adapter";

const QUOTE_PATH = "/quotes/zone-preview";
const REQUEST_VERSION = "quote-request@2026-08-13.v2" as const;
const AVAILABLE_VERSION = "quote-result@2026-08-13.v2" as const;
const UNAVAILABLE_VERSION = "quote-preview-unavailable@2026-08-13" as const;
const CONTRACT_VERSION = "quote-zone.v2" as const;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const HASH_RE = /^sha256:[a-f0-9]{64}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const POSITIVE_DECIMAL_RE = /^(?:0\.(?:[0-9]*[1-9][0-9]*)|[1-9][0-9]*(?:\.[0-9]+)?)$/u;
const MAX_DECIMAL_DIGITS = 12;
const MAX_DECIMAL_LENGTH = 24;

const identifierSchema = z.string().regex(IDENTIFIER_RE);
const versionSchema = z.string().regex(VERSION_RE);
const dateSchema = z.string().regex(DATE_RE).refine(isValidDate);
const dateTimeSchema = z.string().datetime({ offset: true });
const feeSchema = z
  .object({
    amount: z.string().regex(/^\d+\.\d{2}$/u),
    currency: z.literal("USD"),
  })
  .strict();
const lineItemSchema = z
  .object({
    line_id: identifierSchema,
    label: z.string().min(1).max(200),
    amount: feeSchema,
    pricing_basis: z.string().min(1).max(500),
    source_ref_ids: z.array(identifierSchema).min(1),
  })
  .strict();

const availableBaseSchema = z
  .object({
    version: z.literal(AVAILABLE_VERSION),
    quote_id: identifierSchema,
    quote_version: versionSchema,
    status: z.enum(["quoted", "manual_required"]),
    source_type: identifierSchema,
    origin: identifierSchema,
    zone: z.number().int().min(0).nullable(),
    billing_pallets: z.number().int().min(1).nullable(),
    fees: z.record(z.string().min(1), feeSchema),
    test_data: z.literal(false),
    manual_review_required: z.boolean(),
    matched_by: z.string().nullable(),
    rule_version: versionSchema,
    data_version: versionSchema,
    valid_from: dateSchema,
    valid_to: dateSchema,
    source_ref: identifierSchema.nullable(),
    service_version: versionSchema,
    contract_version: z.literal(CONTRACT_VERSION),
    release_id: identifierSchema,
    release_hash: z.string().regex(/^sha256:[A-Fa-f0-9]{64}$/u),
    snapshot_hash: z.string().regex(/^sha256:[A-Fa-f0-9]{64}$/u),
    published_at: dateTimeSchema,
    reasons: z.array(z.string().min(1)),
    currency: z.literal("USD"),
    source_ref_ids: z.array(identifierSchema).min(1),
    sendable: z.literal(false),
    tenant: identifierSchema,
    effective_date: dateSchema,
    ready: z.literal(true),
  })
  .strict();

const calculatedResponseSchema = availableBaseSchema
  .extend({
    status: z.literal("quoted"),
    manual_review_required: z.literal(false),
    quote_status: z.literal("calculated"),
    total: feeSchema,
    line_items: z.array(lineItemSchema).min(1),
    billing_pallets: z.number().int().min(1),
  })
  .strict();

const manualResponseSchema = availableBaseSchema
  .extend({
    status: z.literal("manual_required"),
    manual_review_required: z.literal(true),
    quote_status: z.enum(["manual_review", "not_calculable"]),
    total: z.null(),
    line_items: z.array(lineItemSchema).max(0),
    billing_pallets: z.number().int().min(1).nullable(),
  })
  .strict();

const availableResponseSchema = z.discriminatedUnion("quote_status", [
  calculatedResponseSchema,
  manualResponseSchema,
]);

const unavailableResponseSchema = z
  .object({
    version: z.literal(UNAVAILABLE_VERSION),
    quote_id: z.null(),
    quote_version: z.null(),
    status: z.literal("unavailable"),
    source_type: z.literal("manual_required"),
    origin: identifierSchema,
    zone: z.null(),
    billing_pallets: z.null(),
    fees: z.record(z.string().min(1), feeSchema).refine((value) => Object.keys(value).length === 0),
    test_data: z.boolean(),
    manual_review_required: z.literal(true),
    matched_by: z.null(),
    rule_version: versionSchema.nullable(),
    data_version: versionSchema.nullable(),
    valid_from: dateSchema.nullable(),
    valid_to: dateSchema.nullable(),
    source_ref: z.null(),
    service_version: versionSchema.nullable(),
    contract_version: z.literal(CONTRACT_VERSION),
    release_id: identifierSchema.nullable(),
    release_hash: z.string().regex(/^sha256:[A-Fa-f0-9]{64}$/u).nullable(),
    snapshot_hash: z.string().regex(/^sha256:[A-Fa-f0-9]{64}$/u).nullable(),
    published_at: dateTimeSchema.nullable(),
    reasons: z.array(z.string().min(1)).min(1),
    quote_status: z.literal("not_calculable"),
    total: z.null(),
    line_items: z.array(lineItemSchema).max(0),
    source_ref_ids: z.array(identifierSchema).max(0),
    sendable: z.literal(false),
    tenant: identifierSchema,
    effective_date: dateSchema,
    ready: z.literal(false),
  })
  .strict();

const opaqueReferenceSchema = z
  .object({
    ref_id: identifierSchema,
    kind: z.enum(["raw_input", "document", "credential", "record", "attachment", "external_response"]),
    purpose: z.string().min(1).max(200),
    expires_at: dateTimeSchema.nullable().optional(),
  })
  .strict();
const positiveMeasurement = <Unit extends readonly [string, ...string[]]>(units: Unit) =>
  z
    .object({
      value: z.string().regex(POSITIVE_DECIMAL_RE),
      unit: z.enum(units),
    })
    .strict();
const quoteInputSchema = z
  .object({
    schema_version: z.literal("2026-08-11.v1"),
    version: z.literal(REQUEST_VERSION),
    origin: z
      .object({
        warehouse_code: identifierSchema,
        province: z.string().min(1).max(80),
      })
      .strict(),
    destination: z
      .object({
        country: z.literal("CA"),
        province: z.string().min(1).max(80).nullable(),
        city: z.string().min(1).max(120).nullable(),
        postal_code: z.string().min(1).max(20).nullable(),
        address_type: z.enum(["commercial", "residential", "unknown"]),
        full_address_ref: opaqueReferenceSchema.nullable(),
      })
      .strict(),
    cargo: z
      .object({
        cargo_result_ref: identifierSchema.nullable(),
        explicit_pallet_count: z.number().int().min(1).max(10000).nullable(),
        longest_side: positiveMeasurement(["mm", "cm", "m"]),
        is_stackable: z.boolean(),
        weight_kg: positiveMeasurement(["g", "kg", "lb"]),
        pieces: z.number().int().min(1).max(100000),
        package_types: z.array(z.string().min(1).max(100)).min(1).max(1),
        total_volume: positiveMeasurement(["l", "cbm", "m3"]),
      })
      .strict(),
    services: z
      .object({
        appointment: z.boolean(),
        liftgate: z.boolean(),
        pallet_jack: z.boolean(),
        detention_minutes: z.number().int().min(0).max(10080),
        limited_access: z.boolean(),
        remote_area: z.boolean(),
      })
      .strict(),
    effective_at: dateSchema,
  })
  .strict();

type QuoteInput = z.infer<typeof quoteInputSchema>;
type AvailableResponse = z.infer<typeof availableResponseSchema>;

export type QuoteApiHeaderProvider = (
  context: ExecutionContext,
  signal: AbortSignal,
) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

export interface QuoteApiAdapterOptions {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly enabled?: boolean;
  readonly fetchImpl?: FetchImplementation;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly headerProvider?: QuoteApiHeaderProvider;
  readonly clock?: () => Date;
  readonly originByWarehouse?: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedStatusResponse(value: unknown): value is FetchJsonAllowedStatusResponse {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function isValidDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function notice(
  code: string,
  message: string,
  field: string | null = null,
  severity: "info" | "warning" | "error" = "error",
) {
  return { code, message, field, severity } as const;
}

function needsInput(code: string, message: string, field: string): AdapterResult {
  return {
    status: "needs_input",
    data: null,
    sourceRefs: [],
    blockers: [notice(code, message, field)],
  };
}

function manualReview(code: string, message: string, field: string | null = null): AdapterResult {
  return {
    status: "manual_review",
    data: null,
    sourceRefs: [],
    calculationTrace: [],
    blockers: [notice(code, message, field)],
    reviewStatus: "manual_review",
  };
}

function unavailable(code: string, message: string): AdapterResult {
  return {
    status: "unavailable",
    data: null,
    sourceRefs: [],
    calculationTrace: [],
    blockers: [notice(code, message)],
    reviewStatus: "manual_review",
  };
}

function money(value: { amount: string; currency: "USD" }): { readonly amount: string; readonly currency: string } {
  return { amount: value.amount, currency: value.currency };
}

function decimalString(value: Decimal, maxFractionDigits: number, maxValue: string): string | null {
  if (!value.isFinite() || value.lte(0) || value.gt(new Decimal(maxValue))) return null;
  const formatted = value.toFixed();
  const [whole, fraction = ""] = formatted.split(".");
  const significantDigits = `${whole}${fraction}`.replace(/^0+/u, "").length;
  if (
    !DECIMAL_RE.test(formatted) ||
    formatted.length > MAX_DECIMAL_LENGTH ||
    significantDigits === 0 ||
    significantDigits > MAX_DECIMAL_DIGITS ||
    fraction.length > maxFractionDigits
  ) {
    return null;
  }
  return formatted;
}

function responseSourceId(response: AvailableResponse): string | null {
  if (!HASH_RE.test(response.snapshot_hash) || response.release_hash !== response.snapshot_hash) return null;
  const digest = response.snapshot_hash.slice("sha256:".length);
  const expected = `src:quote:snapshot:${digest}`;
  return response.source_ref_ids.length === 1 && response.source_ref_ids[0] === expected ? expected : null;
}

function calculatedEvidenceMatches(response: AvailableResponse, sourceId: string): boolean {
  if (response.quote_status !== "calculated") return true;
  const lineIds = response.line_items.map((item) => item.line_id);
  if (new Set(lineIds).size !== lineIds.length) return false;
  const total = new Decimal(response.total.amount);
  const sum = response.line_items.reduce(
    (value, item) => value.add(new Decimal(item.amount.amount)),
    new Decimal(0),
  );
  return (
    response.line_items.every(
      (item) => item.source_ref_ids.length === 1 && item.source_ref_ids[0] === sourceId,
    ) && sum.eq(total)
  );
}

function datesMatch(response: AvailableResponse, expectedTenant: string, expectedOrigin: string, expectedDate: string): boolean {
  return (
    response.tenant === expectedTenant &&
    response.origin === expectedOrigin &&
    response.effective_date === expectedDate &&
    response.valid_from <= response.valid_to &&
    expectedDate >= response.valid_from &&
    expectedDate <= response.valid_to &&
    response.quote_version === `${response.release_id}:${response.rule_version}:${response.data_version}`
  );
}

function sourceRef(sourceId: string, quoteVersion: string, rawResponse: unknown, retrievedAt: string): SourceRef {
  return {
    source_id: sourceId,
    source_type: "internal_system",
    system: "ai-quote-zone-preview",
    locator: `opaque://quote-zone-preview/${sourceId}`,
    version: quoteVersion,
    retrieved_at: retrievedAt,
    authority: "authoritative",
    content_hash: hashPayload(rawResponse),
  };
}

function trace(response: AvailableResponse, sourceId: string): CalculationStep {
  return {
    step_id: "step:quote:preview:upstream",
    operation: "use upstream quote preview result",
    inputs: [
      { name: "quote_status", value: response.quote_status },
      { name: "quote_version", value: response.quote_version },
    ],
    result: response.total === null ? null : money(response.total),
    source_ref_ids: [sourceId],
    rounding: null,
  };
}

export class QuoteApiAdapter extends ExistingQuoteAdapter {
  private readonly client: FetchJsonClient;
  private readonly enabled: boolean;
  private readonly headerProvider: QuoteApiHeaderProvider | undefined;
  private readonly responseClock: () => Date;
  private readonly originByWarehouse: Readonly<Record<string, string>>;
  private readonly requestTimeoutMs: number;

  constructor(options: QuoteApiAdapterOptions) {
    super(options.clock === undefined ? {} : { clock: options.clock });
    this.client = createFetchJsonClient({
      baseUrl: options.baseUrl,
      allowedHosts: options.allowedHosts,
      enabled: options.enabled === true,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    });
    this.enabled = options.enabled === true;
    this.headerProvider = options.headerProvider;
    this.responseClock = options.clock ?? (() => new Date());
    this.originByWarehouse = options.originByWarehouse ?? {};
    this.requestTimeoutMs = options.timeoutMs ?? 10_000;
  }

  override async calculate(
    input: Record<string, unknown> | FixtureInput,
    context?: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<AdapterResult> {
    if (!this.enabled) {
      return unavailable(
        "quote.adapter_disabled",
        "The quote preview adapter is disabled until its endpoint is explicitly enabled.",
      );
    }
    if (context === undefined) {
      return {
        ...unavailable(
          "quote.execution_context_required",
          "Quote preview requires a server-authenticated execution context.",
        ),
        status: "blocked",
      };
    }
    if (signal?.aborted) return unavailable("quote.request_aborted", "The quote preview request was aborted.");
    if (!isRecord(input)) {
      return needsInput("quote.request_invalid", "The quote preview input must be an object.", "input");
    }

    const prepared = this.prepareRequest(input, context);
    if ("result" in prepared) return prepared.result;
    if (this.headerProvider === undefined) {
      return {
        ...unavailable(
          "quote.authorization_unconfigured",
          "The quote preview API-key provider is not configured.",
        ),
        status: "blocked",
      };
    }

    let response: unknown;
    try {
      response = await this.withRequestSignal(signal, async (requestSignal) => {
        const headers = await this.headerProvider!(context, requestSignal);
        if (requestSignal.aborted) {
          throw new HttpAdapterError("upstream_aborted", "The quote preview request was aborted.");
        }
        if (!hasApiKey(headers)) {
          throw new HttpAdapterError("upstream_request_invalid", "The quote preview API-key header is invalid.");
        }
        return this.client.post(QUOTE_PATH, prepared.body, headers, requestSignal, [503]);
      });
    } catch (error: unknown) {
      return this.mapHttpFailure(error);
    }

    if (isAllowedStatusResponse(response)) {
      if (response.status === 503) {
        unavailableResponseSchema.safeParse(response.body);
        return unavailable(
          "quote.upstream_unavailable",
          "The authoritative quote preview release is unavailable.",
        );
      }
      return unavailable("quote.upstream_contract_invalid", "The quote preview response status is invalid.");
    }

    const parsed = availableResponseSchema.safeParse(response);
    if (!parsed.success || !datesMatch(parsed.data, context.tenantId, prepared.expectedOrigin, prepared.effectiveDate)) {
      return unavailable(
        "quote.upstream_contract_invalid",
        "The quote preview response did not satisfy the verified v2 response contract.",
      );
    }
    const sourceId = responseSourceId(parsed.data);
    if (sourceId === null) {
      return unavailable(
        "quote.upstream_contract_invalid",
        "The quote preview response source identity could not be verified.",
      );
    }
    if (!calculatedEvidenceMatches(parsed.data, sourceId)) {
      return unavailable(
        "quote.upstream_contract_invalid",
        "The quote preview response price evidence could not be verified.",
      );
    }

    try {
      const retrievedAt = this.responseClock().toISOString();
      const source = sourceRef(sourceId, parsed.data.quote_version, response, retrievedAt);
      const data: Record<string, unknown> = {
        version: AVAILABLE_VERSION,
        quote_id: parsed.data.quote_id,
        quote_status: parsed.data.quote_status,
        currency: parsed.data.currency,
        total: parsed.data.total === null ? null : money(parsed.data.total),
        line_items: parsed.data.line_items,
        rule_version: parsed.data.rule_version,
        data_version: parsed.data.data_version,
        sendable: false,
        valid_from: parsed.data.valid_from,
        valid_to: parsed.data.valid_to,
        source_ref_ids: [sourceId],
        tenant: parsed.data.tenant,
        effective_date: parsed.data.effective_date,
        ready: true,
        test_data: false,
        origin: parsed.data.origin,
        billing_pallets: parsed.data.billing_pallets,
        snapshot_hash: parsed.data.snapshot_hash,
        service_version: parsed.data.service_version,
        contract_version: parsed.data.contract_version,
        release_id: parsed.data.release_id,
        release_hash: parsed.data.release_hash,
        published_at: parsed.data.published_at,
      };
      const step = trace(parsed.data, sourceId);
      if (parsed.data.quote_status === "calculated") {
        return {
          status: "success",
          data,
          sourceRefs: [source],
          warnings: [
            notice(
              "quote.not_sendable",
              "The quote preview result is not sendable or publishable.",
              null,
              "warning",
            ),
          ],
          calculationTrace: [step],
        };
      }
      return {
        status: "manual_review",
        data,
        sourceRefs: [source],
        blockers: [
          notice(
            "quote.upstream_manual_review",
            "The upstream quote preview requires manual review and cannot be upgraded by the adapter.",
          ),
        ],
        warnings: [
          notice(
            "quote.not_sendable",
            "The quote preview result is not sendable or publishable.",
            null,
            "warning",
          ),
        ],
        calculationTrace: [step],
        reviewStatus: "manual_review",
      };
    } catch {
      return unavailable(
        "quote.upstream_contract_invalid",
        "The quote preview response could not be safely projected to the MCP contract.",
      );
    }
  }

  override previewDraft(input: Record<string, unknown>): Promise<AdapterResult> {
    void input;
    return Promise.resolve(
      unavailable(
        "quote.adapter_disabled",
        "Quote draft writes remain disabled for the preview adapter.",
      ),
    );
  }

  override commitDraft(input: Record<string, unknown>, signal?: AbortSignal): Promise<AdapterResult> {
    void input;
    void signal;
    return Promise.resolve(
      unavailable(
        "quote.adapter_disabled",
        "Quote draft writes remain disabled for the preview adapter.",
      ),
    );
  }

  override readDraft(input: Record<string, unknown>): Promise<AdapterResult> {
    void input;
    return Promise.resolve(
      unavailable(
        "quote.adapter_disabled",
        "Quote draft reads remain disabled for the preview adapter.",
      ),
    );
  }

  private prepareRequest(
    input: Record<string, unknown>,
    context: ExecutionContext,
  ):
    | { readonly body: Record<string, unknown>; readonly expectedOrigin: string; readonly effectiveDate: string }
    | { readonly result: AdapterResult } {
    const parsed = quoteInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        result: needsInput(
          "quote.request_invalid",
          "The quote preview requires all explicit v2 shipment fields.",
          "input",
        ),
      };
    }
    if (!identifierSchema.safeParse(context.tenantId).success) {
      return {
        result: unavailable("quote.execution_context_invalid", "The server execution tenant is invalid."),
      };
    }

    const inputValue: QuoteInput = parsed.data;
    const configuredOrigin = Object.prototype.hasOwnProperty.call(
      this.originByWarehouse,
      inputValue.origin.warehouse_code,
    )
      ? this.originByWarehouse[inputValue.origin.warehouse_code]
      : undefined;
    const expectedOrigin = typeof configuredOrigin === "string"
      ? configuredOrigin.trim().toLowerCase()
      : undefined;
    if (expectedOrigin !== "toronto" && expectedOrigin !== "calgary") {
      return {
        result: needsInput(
          "quote.origin_mapping_required",
          "The warehouse requires an explicit toronto or calgary quote origin mapping.",
          "origin.warehouse_code",
        ),
      };
    }
    if (inputValue.destination.address_type === "unknown" || inputValue.destination.postal_code === null) {
      return {
        result: needsInput(
          "quote.destination_evidence_required",
          "A supported address type and postal code are required before quote preview.",
          "destination",
        ),
      };
    }
    if (inputValue.services.limited_access || inputValue.services.remote_area) {
      return {
        result: manualReview(
          "quote.service_not_supported",
          "Limited-access and remote-area services require manual review before quote preview.",
          "services",
        ),
      };
    }

    const cbm = decimalString(
      volumeToCbm(inputValue.cargo.total_volume.value, inputValue.cargo.total_volume.unit as VolumeUnit),
      3,
      "1000",
    );
    const weightKg = decimalString(
      weightToKilograms(inputValue.cargo.weight_kg.value, inputValue.cargo.weight_kg.unit as WeightUnit).value,
      3,
      "100000",
    );
    const longestSideCm = decimalString(
      lengthToCentimeters(inputValue.cargo.longest_side.value, inputValue.cargo.longest_side.unit as LengthUnit),
      2,
      "10000",
    );
    if (cbm === null || weightKg === null || longestSideCm === null) {
      return {
        result: needsInput(
          "quote.cargo_units_invalid",
          "Cargo measurements must be positive and exactly representable in the quote preview units.",
          "cargo",
        ),
      };
    }

    const quote: Record<string, unknown> = {
      postal_code: inputValue.destination.postal_code,
      cbm,
      weight_kg: weightKg,
      piece_count: inputValue.cargo.pieces,
      packaging_type: inputValue.cargo.package_types[0],
      longest_side_cm: longestSideCm,
      address_type: inputValue.destination.address_type,
      requires_liftgate: inputValue.services.liftgate,
      requires_pallet_jack: inputValue.services.pallet_jack,
      requires_appointment: inputValue.services.appointment,
      explicit_pallet_count: inputValue.cargo.explicit_pallet_count,
      is_stackable: inputValue.cargo.is_stackable,
      detention_minutes: inputValue.services.detention_minutes,
    };
    if (inputValue.destination.city !== null) quote.city = inputValue.destination.city;
    if (inputValue.destination.province !== null) quote.province = inputValue.destination.province;
    return {
      body: {
        tenant_id: context.tenantId,
        origin: expectedOrigin,
        effective_date: inputValue.effective_at,
        quote,
      },
      expectedOrigin,
      effectiveDate: inputValue.effective_at,
    };
  }

  private async withRequestSignal<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (callerSignal?.aborted) {
      throw new HttpAdapterError("upstream_aborted", "The quote preview request was aborted.");
    }
    const controller = new AbortController();
    let rejectCancellation: ((error: HttpAdapterError) => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const abort = (): void => {
      controller.abort(callerSignal?.reason);
      rejectCancellation?.(new HttpAdapterError("upstream_aborted", "The quote preview request was aborted."));
    };
    callerSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
      rejectCancellation?.(new HttpAdapterError("upstream_timeout", "The quote preview request exceeded its deadline."));
    }, this.requestTimeoutMs);
    try {
      return await Promise.race([operation(controller.signal), cancellation]);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abort);
    }
  }

  private mapHttpFailure(error: unknown): AdapterResult {
    if (error instanceof HttpAdapterError && (error.status === 401 || error.status === 403)) {
      return {
        ...unavailable(
          error.status === 401 ? "quote.upstream_unauthorized" : "quote.upstream_forbidden",
          "The quote preview API rejected the configured API key or tenant authorization.",
        ),
        status: "blocked",
      };
    }
    return unavailable(
      "quote.upstream_unavailable",
      "The quote preview request could not be completed safely.",
    );
  }
}

function hasApiKey(headers: Readonly<Record<string, string>>): boolean {
  const value = new Headers(headers).get("x-api-key");
  return value !== null && value.length > 0 && !/\s/u.test(value);
}
