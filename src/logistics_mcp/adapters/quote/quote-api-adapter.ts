import type { CalculationStep, SourceRef } from "../../platform/envelope";
import { hashPayload } from "../../platform/idempotency";
import { z } from "zod";
import {
  createFetchJsonClient,
  type FetchImplementation,
  type FetchJsonClient,
} from "../http-client";
import type { AdapterResult } from "../ports";
import { ExistingQuoteAdapter } from "./existing-quote-adapter";
import {
  formatCanonicalWeight,
  volumeToCbm,
  weightToKilograms,
} from "../../domains/cargo/units";
import { formatVolume } from "../../domains/cargo/decimal";
import type { VolumeUnit, WeightUnit } from "../../domains/cargo/models";

const QUOTE_PATH = "/quotes/zone-calculate";
const SOURCE_VERSION = "quote-zone-api.v1";
const RULE_VERSION = "upstream-rule-version:not-provided";
const NON_NEGATIVE_DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const nonNegativeDecimalSchema = z.string().regex(NON_NEGATIVE_DECIMAL_RE);
const quoteApiResponseSchema = z
  .object({
    quote_id: z.string().regex(IDENTIFIER_RE),
    source_type: z.enum([
      "zone_matrix",
      "llm_auxiliary_advice",
      "hermes_agent_correction",
      "learned_manual_quote",
      "manual_required",
    ]),
    confidence: z.number().int().min(0).max(100),
    postal_code: z.string().nullable(),
    preferred_city: z.string().nullable(),
    postal_prefix: z.string().nullable(),
    city: z.string().nullable(),
    province: z.string().nullable(),
    origin: z.string().nullable(),
    zone: z.number().int().min(0).nullable(),
    billing_pallets: z.number().int().min(1).nullable(),
    pallet_breakdown: z.record(z.string().min(1), z.number().int().min(0)),
    base_price_usd: nonNegativeDecimalSchema.nullable(),
    fuel_usd: nonNegativeDecimalSchema.nullable(),
    accessorials: z.record(z.string().min(1), nonNegativeDecimalSchema),
    total_price_usd: nonNegativeDecimalSchema.nullable(),
    risk_tags: z.array(z.string().min(1)),
    manual_review_required: z.boolean(),
    matched_rule: z.string().min(1),
    matched_by: z.string().nullable(),
    candidate_count: z.number().int().min(0),
    match_trace: z.record(z.string(), z.unknown()),
    sales_note: z.string().nullable(),
    internal_note: z.string().nullable(),
  })
  .strict();

export type QuoteApiHeaderProvider = () =>
  | Readonly<Record<string, string>>
  | Promise<Readonly<Record<string, string>>>;

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

interface ParsedQuoteResponse {
  readonly quoteId: string;
  readonly origin: string | null;
  readonly basePrice: string | null;
  readonly fuel: string | null;
  readonly accessorials: Readonly<Record<string, string>>;
  readonly total: string | null;
  readonly manualReviewRequired: boolean;
}

class QuoteApiContractError extends Error {
  constructor() {
    super("The upstream quote response did not satisfy the verified contract.");
    this.name = "QuoteApiContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isNonNegativeDecimalString(value: unknown): value is string {
  return typeof value === "string" && NON_NEGATIVE_DECIMAL_RE.test(value);
}

function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number | null = null,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (maximum === null || (value as number) <= maximum)
  );
}

function parseQuoteResponse(value: unknown): ParsedQuoteResponse {
  const parsed = quoteApiResponseSchema.safeParse(value);
  if (!parsed.success) throw new QuoteApiContractError();
  return {
    quoteId: parsed.data.quote_id,
    origin: parsed.data.origin,
    basePrice: parsed.data.base_price_usd,
    fuel: parsed.data.fuel_usd,
    accessorials: parsed.data.accessorials,
    total: parsed.data.total_price_usd,
    manualReviewRequired: parsed.data.manual_review_required,
  };
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
    blockers: [notice(code, message, field)],
    reviewStatus: "manual_review",
  };
}

function unavailable(code: string, message: string): AdapterResult {
  return {
    status: "unavailable",
    data: null,
    sourceRefs: [],
    blockers: [notice(code, message)],
    reviewStatus: "manual_review",
  };
}

function normalizeOrigin(value: string | null): string | null {
  return value === null ? null : value.trim().toLowerCase();
}

function money(
  amount: string | null,
): { readonly amount: string; readonly currency: "USD" } | null {
  return amount === null ? null : { amount, currency: "USD" };
}

function lineItem(
  lineId: string,
  label: string,
  amount: string | null,
  pricingBasis: string,
  sourceId: string,
): Record<string, unknown> {
  return {
    line_id: lineId,
    label,
    amount: money(amount),
    pricing_basis: pricingBasis,
    source_ref_ids: [sourceId],
  };
}

function calculationTrace(
  sourceId: string,
  total: string | null,
): readonly CalculationStep[] {
  return [
    {
      step_id: "step:quote:api:total",
      operation: "use upstream total_price_usd",
      inputs: [{ name: "total_price_usd", value: money(total) }],
      result: money(total),
      source_ref_ids: [sourceId],
      rounding: null,
    },
  ];
}

export class QuoteApiAdapter extends ExistingQuoteAdapter {
  private readonly client: FetchJsonClient;
  private readonly enabled: boolean;
  private readonly headerProvider: QuoteApiHeaderProvider | undefined;
  private readonly responseClock: () => Date;
  private readonly originByWarehouse: Readonly<Record<string, string>>;

  constructor(options: QuoteApiAdapterOptions) {
    super(options.clock === undefined ? {} : { clock: options.clock });
    this.client = createFetchJsonClient({
      baseUrl: options.baseUrl,
      allowedHosts: options.allowedHosts,
      enabled: options.enabled === true,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
    });
    this.enabled = options.enabled === true;
    this.headerProvider = options.headerProvider;
    this.responseClock = options.clock ?? (() => new Date());
    this.originByWarehouse = options.originByWarehouse ?? {};
  }

  override async calculate(input: Record<string, unknown>): Promise<AdapterResult> {
    if (!this.enabled) {
      return unavailable(
        "quote.adapter_disabled",
        "The quote API adapter is disabled until its endpoint is explicitly enabled.",
      );
    }
    const prepared = this.prepareRequest(input);
    if ("result" in prepared) return prepared.result;

    let response: unknown;
    try {
      const headers =
        this.headerProvider === undefined ? undefined : await this.headerProvider();
      response = await this.client.post(QUOTE_PATH, prepared.body, headers);
    } catch {
      return unavailable(
        "quote.upstream_unavailable",
        "The quote API request could not be completed.",
      );
    }

    let parsed: ParsedQuoteResponse;
    try {
      parsed = parseQuoteResponse(response);
    } catch {
      return unavailable(
        "quote.upstream_contract_invalid",
        "The quote API response did not satisfy the verified response contract.",
      );
    }

    try {
      return this.projectResponse(parsed, prepared.expectedOrigin, response);
    } catch {
      return unavailable(
        "quote.upstream_contract_invalid",
        "The quote API response could not be safely projected to the MCP contract.",
      );
    }
  }

  private prepareRequest(
    input: Record<string, unknown>,
  ): { readonly body: Record<string, unknown>; readonly expectedOrigin: string } | { readonly result: AdapterResult } {
    const effectiveAt = input.effective_at;
    if (effectiveAt !== this.responseClock().toISOString().slice(0, 10)) {
      return {
        result: manualReview(
          "quote.effective_date_unsupported",
          "The quote API does not support historical or future effective dates; only today's date can be requested.",
          "effective_at",
        ),
      };
    }

    const destination = isRecord(input.destination) ? input.destination : null;
    const cargo = isRecord(input.cargo) ? input.cargo : null;
    const services = isRecord(input.services) ? input.services : null;
    const origin = isRecord(input.origin) ? input.origin : null;

    const addressType = nonEmptyString(destination?.address_type);
    if (addressType === null || !["commercial", "residential"].includes(addressType)) {
      return {
        result: needsInput(
          "quote.address_type_required",
          "A confirmed destination address type is required before calling the quote API.",
          "destination.address_type",
        ),
      };
    }

    const volume = cargo?.total_volume;
    if (!isRecord(volume) || !isNonNegativeDecimalString(volume.value) || !isVolumeUnit(volume.unit)) {
      return {
        result: needsInput(
          "quote.total_volume_required",
          "A canonical total volume is required before calling the quote API.",
          "cargo.total_volume",
        ),
      };
    }

    const postalCode = nonEmptyString(destination?.postal_code);
    if (postalCode === null) {
      return {
        result: needsInput(
          "quote.postal_code_required",
          "A destination postal code is required before calling the quote API.",
          "destination.postal_code",
        ),
      };
    }

    const weight = cargo?.weight_kg;
    if (
      !isRecord(weight) ||
      !isNonNegativeDecimalString(weight.value) ||
      !isWeightUnit(weight.unit)
    ) {
      return {
        result: needsInput(
          "quote.weight_required",
          "A canonical shipment weight is required before calling the quote API.",
          "cargo.weight_kg",
        ),
      };
    }

    if (!isSafeIntegerInRange(cargo?.pieces, 1)) {
      return {
        result: needsInput(
          "quote.pieces_required",
          "A positive shipment piece count is required before calling the quote API.",
          "cargo.pieces",
        ),
      };
    }

    const packageTypes = cargo?.package_types;
    if (!Array.isArray(packageTypes) || packageTypes.length === 0) {
      return {
        result: needsInput(
          "quote.package_types_required",
          "One shipment package type is required before calling the quote API.",
          "cargo.package_types",
        ),
      };
    }
    if (packageTypes.length !== 1) {
      return {
        result: manualReview(
          "quote.package_types_conflict",
          "Multiple package types cannot be represented by the quote API request.",
          "cargo.package_types",
        ),
      };
    }
    const packagingType = nonEmptyString(packageTypes[0]);
    if (packagingType === null) {
      return {
        result: needsInput(
          "quote.package_types_required",
          "One non-empty shipment package type is required before calling the quote API.",
          "cargo.package_types",
        ),
      };
    }

    if (
      services === null ||
      typeof services.appointment !== "boolean" ||
      typeof services.liftgate !== "boolean" ||
      typeof services.limited_access !== "boolean" ||
      typeof services.remote_area !== "boolean"
    ) {
      return {
        result: needsInput(
          "quote.services_required",
          "The supported quote service flags are required before calling the quote API.",
          "services",
        ),
      };
    }
    if (services.limited_access === true || services.remote_area === true) {
      return {
        result: manualReview(
          "quote.service_not_supported",
          "The requested service is not represented by the verified quote API contract.",
          "services",
        ),
      };
    }

    const warehouseCode = nonEmptyString(origin?.warehouse_code);
    if (warehouseCode === null) {
      return {
        result: needsInput(
          "quote.origin_mapping_required",
          "A warehouse code with an explicit quote API origin mapping is required.",
          "origin.warehouse_code",
        ),
      };
    }
    const configuredOrigin = this.originByWarehouse[warehouseCode] as unknown;
    if (typeof configuredOrigin !== "string" || configuredOrigin.trim().length === 0) {
      return {
        result: needsInput(
          "quote.origin_mapping_required",
          "A warehouse code with an explicit quote API origin mapping is required.",
          "origin.warehouse_code",
        ),
      };
    }

    let cbm: string;
    let weightKg: string;
    try {
      cbm = formatVolume(volumeToCbm(volume.value, volume.unit));
      weightKg = formatCanonicalWeight(weightToKilograms(weight.value, weight.unit));
    } catch {
      return {
        result: needsInput(
          "quote.cargo_units_invalid",
          "The cargo volume or weight unit could not be converted safely.",
          "cargo",
        ),
      };
    }

    const quote: Record<string, unknown> = {
      postal_code: postalCode,
      cbm,
      weight_kg: weightKg,
      piece_count: cargo.pieces,
      packaging_type: packagingType.toLowerCase(),
      address_type: addressType,
      requires_liftgate: services.liftgate,
      requires_appointment: services.appointment,
    };
    const city = nonEmptyString(destination?.city);
    if (city !== null) quote.city = city;
    const province = nonEmptyString(destination?.province);
    if (province !== null) quote.province = province;
    if (cargo.billing_pallets !== null && cargo.billing_pallets !== undefined) {
      if (!isSafeIntegerInRange(cargo.billing_pallets, 1)) {
        return {
          result: needsInput(
            "quote.billing_pallets_invalid",
            "The optional explicit pallet count must be a positive integer.",
            "cargo.billing_pallets",
          ),
        };
      }
      quote.explicit_pallet_count = cargo.billing_pallets;
    }
    return {
      body: { quote, notify_email: false, notify_wecom: false },
      expectedOrigin: normalizeOrigin(configuredOrigin) ?? configuredOrigin,
    };
  }

  private projectResponse(
    response: ParsedQuoteResponse,
    expectedOrigin: string,
    rawResponse: unknown,
  ): AdapterResult {
    const responseHash = hashPayload(rawResponse);
    const sourceId = `src:quote:api:${responseHash.slice(7, 23)}`;
    const sourceRef: SourceRef = {
      source_id: sourceId,
      source_type: "internal_system",
      system: "ai-quote-zone-api",
      locator: `opaque://quote-zone-api/${responseHash.slice(7, 23)}`,
      version: SOURCE_VERSION,
      retrieved_at: this.responseClock().toISOString(),
      authority: "authoritative",
      content_hash: responseHash,
    };
    const originMatches = normalizeOrigin(response.origin) === expectedOrigin;
    const completePrice =
      response.basePrice !== null &&
      response.fuel !== null &&
      response.total !== null;
    const priceUsable = originMatches && completePrice;
    const sourceRefIds = [sourceId];
    const lineItems = [
      lineItem(
        "line:quote:base",
        "Canada final-mile base price",
        priceUsable ? response.basePrice : null,
        "upstream base_price_usd",
        sourceId,
      ),
      lineItem(
        "line:quote:fuel",
        "Fuel surcharge",
        priceUsable ? response.fuel : null,
        "upstream fuel_usd",
        sourceId,
      ),
      ...Object.entries(response.accessorials).map(([key, amount], index) =>
        lineItem(
          `line:quote:accessorial:${index}`,
          key,
          priceUsable ? amount : null,
          "upstream accessorials",
          sourceId,
        ),
      ),
    ];
    const blockers = [
      notice(
        "quote.business_version_missing",
        "The upstream response has no business rule version, data version, or validity window; the adapter sentinel is not an upstream business version.",
      ),
    ];
    if (!originMatches) {
      blockers.push(
        notice(
          "quote.origin_mismatch",
          "The upstream origin does not match the explicitly mapped warehouse origin; all price amounts were cleared.",
        ),
      );
    }
    if (!completePrice) {
      blockers.push(
        notice(
          "quote.price_missing",
          "The upstream response did not contain a complete base, fuel, and total price.",
        ),
      );
    }
    if (response.manualReviewRequired) {
      blockers.push(
        notice(
          "quote.upstream_manual_review",
          "The upstream response requires manual review and cannot be upgraded by the adapter.",
        ),
      );
    }
    const total = priceUsable ? response.total : null;
    return {
      status: "manual_review",
      data: {
        version: `quote-result@response-sha256:${responseHash.slice(7)}`,
        quote_id: response.quoteId,
        quote_status: "manual_review",
        currency: "USD",
        total: money(total),
        line_items: lineItems,
        rule_version: RULE_VERSION,
        data_version: `response-sha256:${responseHash.slice(7)}`,
        sendable: false,
        valid_from: null,
        valid_to: null,
        source_ref_ids: sourceRefIds,
      },
      sourceRefs: [sourceRef],
      warnings: [
        notice(
          "quote.upstream_side_effects",
          "The upstream quote endpoint may write QuoteAudit/diagnostic records and may create manual-review tasks or notifications even when notify_email=false and notify_wecom=false; this result is not read-only.",
          null,
          "warning",
        ),
        notice(
          "quote.not_sendable",
          "The quote result is not sendable or publishable until business version evidence is verified.",
          null,
          "warning",
        ),
      ],
      blockers,
      calculationTrace: calculationTrace(sourceId, total),
      reviewStatus: "manual_review",
    };
  }
}

function isVolumeUnit(value: unknown): value is VolumeUnit {
  return value === "cbm" || value === "m3";
}

function isWeightUnit(value: unknown): value is WeightUnit {
  return value === "g" || value === "kg" || value === "lb";
}
