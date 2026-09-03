import { z } from "zod";

import {
  freightcomRateRequestSchema,
  type FreightcomRateData,
  type FreightcomRatePollResponse,
} from "../../adapters/quote/freightcom-rate-adapter";
import type { FreightcomRatePort } from "../../adapters/ports";
import {
  ENVELOPE_SCHEMA_VERSION,
  envelopeSchema,
  type CalculationStep,
} from "../../platform/envelope";
import type { ModuleToolHandler, ModuleToolOutcome } from "../../module-runtime";

export const FREIGHTCOM_LTL_INPUT_VERSION =
  "freightcom-ltl-rate-request@2026-08-26.v1" as const;
export const FREIGHTCOM_LTL_RESULT_VERSION =
  "freightcom-ltl-rate-result@2026-08-26.v1" as const;
export const FREIGHTCOM_USD_DISPLAY_POLICY =
  "usd_numeric_relabel_test_only" as const;

const SERVER_OWNED_INPUT_KEYS = new Set([
  "actor",
  "actorid",
  "authorization",
  "baseurl",
  "endpoint",
  "environment",
  "tenant",
  "tenantid",
  "token",
  "url",
]);

function containsServerOwnedInput(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsServerOwnedInput(item, seen));
  }
  return Object.entries(value).some(([key, nested]) => {
    const normalizedKey = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    return SERVER_OWNED_INPUT_KEYS.has(normalizedKey) || containsServerOwnedInput(nested, seen);
  });
}

export function preflightFreightcomLtlInput(
  input: unknown,
): ModuleToolOutcome | undefined {
  if (!containsServerOwnedInput(input)) return undefined;
  return {
    status: "blocked",
    data: null,
    sourceRefs: [],
    blockers: [{
      code: "freightcom.server_owned_field_forbidden",
      message: "Freightcom endpoint, credential, environment, tenant, and actor fields are server-owned.",
      severity: "error",
      field: "input",
    }],
  };
}

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/u);
const moneySchema = z
  .object({
    amount: decimalSchema,
    currency: z.string().regex(/^[A-Z]{3}$/u),
    provider_value: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    provider_scale: z.literal(2),
  })
  .strict();
const displayMoneySchema = z
  .object({
    amount: decimalSchema,
    currency: z.literal("USD"),
    conversion_method: z.literal("none_numeric_relabel"),
  })
  .strict();

const chargeSchema = z
  .object({
    type: z.string().min(1),
    amount: moneySchema,
  })
  .strict();

const normalizedRateSchema = z
  .object({
    rate_ref: identifierSchema,
    carrier_name: z.string().nullable(),
    service_name: z.string().nullable(),
    service_id: z.string().nullable(),
    valid_until: dateSchema.nullable(),
    total: moneySchema.nullable(),
    display_total: displayMoneySchema.nullable(),
    base: moneySchema.nullable(),
    surcharges: z.array(chargeSchema),
    taxes: z.array(chargeSchema),
    transit_time: z
      .object({
        days: z.number().int().min(0).nullable(),
        hours: z.number().int().min(0).nullable(),
        not_available: z.boolean(),
      })
      .strict(),
    paperless: z.boolean().nullable(),
    source_ref_ids: z.array(identifierSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.total === null) !== (value.display_total === null)) {
      context.addIssue({
        code: "custom",
        message: "display_total must exist exactly when a source total exists",
        path: ["display_total"],
      });
    }
    if (
      value.total !== null &&
      value.display_total !== null &&
      value.total.amount !== value.display_total.amount
    ) {
      context.addIssue({
        code: "custom",
        message: "test-only USD display must preserve the source numeric amount",
        path: ["display_total", "amount"],
      });
    }
  });

export const freightcomLtlInputSchema = freightcomRateRequestSchema
  .extend({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    version: z.literal(FREIGHTCOM_LTL_INPUT_VERSION),
    display_policy: z.literal(FREIGHTCOM_USD_DISPLAY_POLICY),
  })
  .strict();

export const freightcomLtlResultSchema = z
  .object({
    version: z.literal(FREIGHTCOM_LTL_RESULT_VERSION),
    provider: z.literal("freightcom"),
    api_version: z.literal("2.10.0"),
    environment: z.enum(["fixture", "test"]),
    provider_request_ref: identifierSchema,
    poll_status: z
      .object({
        done: z.literal(true),
        total: z.number().int().min(0),
        complete: z.number().int().min(0),
      })
      .strict(),
    rates: z.array(normalizedRateSchema),
    sendable: z.literal(false),
    bookable: z.literal(false),
    authoritative: z.literal(false),
    currency_display_policy: z
      .object({
        policy: z.literal(FREIGHTCOM_USD_DISPLAY_POLICY),
        conversion_applied: z.literal(false),
      })
      .strict(),
    source_ref_ids: z.array(identifierSchema).min(1),
  })
  .strict();

const freightcomEnvelopeBranches = z.union([
  envelopeSchema.extend({
    status: z.literal("manual_review"),
    data: freightcomLtlResultSchema,
    source_refs: envelopeSchema.shape.source_refs.min(1),
    blockers: envelopeSchema.shape.blockers.min(1),
    review_status: z.literal("manual_review"),
  }),
  envelopeSchema.extend({
    status: z.enum(["needs_input", "blocked", "unavailable"]),
    data: z.null(),
    source_refs: envelopeSchema.shape.source_refs.max(0),
    calculation_trace: envelopeSchema.shape.calculation_trace.max(0),
  }),
]);

export const freightcomLtlEnvelopeSchema = envelopeSchema
  .extend({ data: freightcomLtlResultSchema.nullable() })
  .superRefine((value, context) => {
    if (!freightcomEnvelopeBranches.safeParse(value).success) {
      context.addIssue({
        code: "custom",
        message: "Freightcom status and data do not match an allowed envelope branch.",
      });
    }
    if (value.data !== null) {
      const outerIds = value.source_refs.map((source) => source.source_id);
      const dataIds = value.data.source_ref_ids;
      if (
        new Set(outerIds).size !== outerIds.length ||
        outerIds.length !== dataIds.length ||
        !dataIds.every((id) => outerIds.includes(id))
      ) {
        context.addIssue({
          code: "custom",
          message: "Freightcom data source IDs must match the outer source refs exactly.",
        });
      }
    }
  })
  .meta({
    anyOf: z.toJSONSchema(freightcomEnvelopeBranches, { target: "draft-2020-12" }).anyOf,
  });

type ProviderMoney = { readonly currency: string; readonly value: string };
type ProviderRate = FreightcomRatePollResponse["rates"][number];

function normalizeMoney(value: ProviderMoney): z.infer<typeof moneySchema> {
  const padded = value.value.padStart(3, "0");
  return {
    amount: `${padded.slice(0, -2)}.${padded.slice(-2)}`,
    currency: value.currency,
    provider_value: value.value,
    provider_scale: 2,
  };
}

function displayMoney(value: ProviderMoney): z.infer<typeof displayMoneySchema> {
  const normalized = normalizeMoney(value);
  return {
    amount: normalized.amount,
    currency: "USD",
    conversion_method: "none_numeric_relabel",
  };
}

function date(value: ProviderRate["valid_until"]): string | null {
  if (value === undefined) return null;
  return [
    String(value.year).padStart(4, "0"),
    String(value.month).padStart(2, "0"),
    String(value.day).padStart(2, "0"),
  ].join("-");
}

function moneyTrace(
  rateRef: string,
  field: string,
  value: ProviderMoney,
  sourceId: string,
): CalculationStep {
  const result = normalizeMoney(value);
  return {
    step_id: `trace:${rateRef}:${field.replace(/[^A-Za-z0-9._:-]/gu, "_")}`,
    operation: "Interpret Freightcom integer money value with two decimal places; do not apply FX.",
    inputs: [
      { name: "provider_value", value: value.value },
      { name: "provider_currency", value: value.currency },
      { name: "provider_scale", value: 2 },
    ],
    result: { amount: result.amount, currency: result.currency },
    source_ref_ids: [sourceId],
    rounding: "none",
  };
}

function normalizeData(
  data: FreightcomRateData,
  sourceIds: readonly string[],
): {
  readonly data: z.infer<typeof freightcomLtlResultSchema>;
  readonly trace: readonly CalculationStep[];
} {
  const sourceId = sourceIds[0];
  if (sourceId === undefined) {
    throw new Error("A completed Freightcom response requires source evidence.");
  }
  const trace: CalculationStep[] = [];
  const rates = data.rates.map((rate, index) => {
    const rateRef = `freightcom-rate-${index + 1}`;
    if (rate.total !== undefined) trace.push(moneyTrace(rateRef, "total", rate.total, sourceId));
    if (rate.base !== undefined) trace.push(moneyTrace(rateRef, "base", rate.base, sourceId));
    for (const [chargeIndex, charge] of (rate.surcharges ?? []).entries()) {
      trace.push(moneyTrace(rateRef, `surcharge-${chargeIndex + 1}`, charge.amount, sourceId));
    }
    for (const [chargeIndex, charge] of (rate.taxes ?? []).entries()) {
      trace.push(moneyTrace(rateRef, `tax-${chargeIndex + 1}`, charge.amount, sourceId));
    }
    return {
      rate_ref: rateRef,
      carrier_name: rate.carrier_name ?? null,
      service_name: rate.service_name ?? null,
      service_id: rate.service_id ?? null,
      valid_until: date(rate.valid_until),
      total: rate.total === undefined ? null : normalizeMoney(rate.total),
      display_total: rate.total === undefined ? null : displayMoney(rate.total),
      base: rate.base === undefined ? null : normalizeMoney(rate.base),
      surcharges: (rate.surcharges ?? []).map((charge) => ({
        type: charge.type,
        amount: normalizeMoney(charge.amount),
      })),
      taxes: (rate.taxes ?? []).map((charge) => ({
        type: charge.type,
        amount: normalizeMoney(charge.amount),
      })),
      transit_time: {
        days: rate.transit_time_days ?? null,
        hours: rate.transit_time_hours ?? null,
        not_available: rate.transit_time_not_available ?? false,
      },
      paperless: rate.paperless ?? null,
      source_ref_ids: [...sourceIds],
    };
  });
  const normalized = {
    version: FREIGHTCOM_LTL_RESULT_VERSION,
    provider: "freightcom" as const,
    api_version: "2.10.0" as const,
    environment: data.environment,
    provider_request_ref: data.request_id,
    poll_status: {
      done: true as const,
      total: data.status.total,
      complete: data.status.complete,
    },
    rates,
    sendable: false as const,
    bookable: false as const,
    authoritative: false as const,
    currency_display_policy: {
      policy: FREIGHTCOM_USD_DISPLAY_POLICY,
      conversion_applied: false as const,
    },
    source_ref_ids: [...sourceIds],
  };
  return { data: freightcomLtlResultSchema.parse(normalized), trace };
}

function invalidAdapterData(): ModuleToolOutcome {
  return {
    status: "unavailable",
    data: null,
    sourceRefs: [],
    blockers: [{
      code: "freightcom.adapter_contract_invalid",
      message: "The Freightcom adapter returned data without the required source evidence.",
      severity: "error",
      field: null,
    }],
    calculationTrace: [],
    reviewStatus: "manual_review",
  };
}

export function createFreightcomLtlToolHandler(adapter: FreightcomRatePort): ModuleToolHandler {
  return async (input, context, signal) => {
    const preflightOutcome = preflightFreightcomLtlInput(input);
    if (preflightOutcome !== undefined) return preflightOutcome;
    const parsed = freightcomLtlInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: "needs_input",
        data: null,
        sourceRefs: [],
        blockers: [{
          code: "freightcom.request_invalid",
          message: "The Freightcom LTL pallet request is invalid.",
          severity: "error",
          field: "input",
        }],
      };
    }
    const providerInput = {
      ...(parsed.data.services === undefined ? {} : { services: parsed.data.services }),
      ...(parsed.data.excluded_services === undefined
        ? {}
        : { excluded_services: parsed.data.excluded_services }),
      details: parsed.data.details,
    };
    const result = await adapter.requestRate(providerInput, signal, context);
    if (result.data === null) return result;
    const providerData = result.data as FreightcomRateData;
    try {
      const sourceIds = result.sourceRefs.map((source) => source.source_id);
      const normalized = normalizeData(providerData, sourceIds);
      return {
        ...result,
        status: "manual_review",
        data: normalized.data,
        assumptions: [
          ...(result.assumptions ?? []),
          {
            code: "freightcom.money_scale_2",
            message: "Freightcom integer money values are interpreted with two decimal places; provider values are retained verbatim.",
            severity: "warning",
            field: "rates",
          },
          {
            code: "freightcom.usd_numeric_relabel_test_only",
            message: "The USD display keeps the source numeric amount and applies no exchange-rate conversion; source currency remains authoritative evidence.",
            severity: "warning",
            field: "rates.display_total",
          },
        ],
        calculationTrace: normalized.trace,
        reviewStatus: "manual_review",
      };
    } catch {
      return invalidAdapterData();
    }
  };
}

export function validateFreightcomLtlOutput(data: Record<string, unknown> | null): void {
  if (data !== null) freightcomLtlResultSchema.parse(data);
}
