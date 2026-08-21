import Decimal from "decimal.js";
import { z } from "zod";

export const QUOTE_V2_REQUEST_VERSION = "quote-request@2026-08-13.v2" as const;
export const QUOTE_V2_RESULT_VERSION = "quote-result@2026-08-13.v2" as const;
export const QUOTE_V2_CONTRACT_VERSION = "quote-zone.v2" as const;

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
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

function isValidDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasAtMostDecimalDigits(value: string): boolean {
  const [integerPart, fractionalPart = ""] = value.split(".");
  return (integerPart ?? "").length + fractionalPart.length <= MAX_DECIMAL_DIGITS;
}

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
      value: z
        .string()
        .max(MAX_DECIMAL_LENGTH)
        .regex(POSITIVE_DECIMAL_RE)
        .refine(hasAtMostDecimalDigits),
      unit: z.enum(units),
    })
    .strict();

export const quoteV2InputSchema = z
  .object({
    schema_version: z.literal("2026-08-11.v1"),
    version: z.literal(QUOTE_V2_REQUEST_VERSION),
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

const quoteV2ResultBaseSchema = z
  .object({
    version: z.literal(QUOTE_V2_RESULT_VERSION),
    quote_id: identifierSchema,
    currency: z.literal("USD"),
    rule_version: versionSchema,
    data_version: versionSchema,
    sendable: z.literal(false),
    valid_from: dateSchema,
    valid_to: dateSchema,
    source_ref_ids: z.array(identifierSchema).min(1),
    tenant: identifierSchema,
    effective_date: dateSchema,
    ready: z.literal(true),
    test_data: z.literal(false),
    origin: identifierSchema,
    snapshot_hash: z.string().regex(/^sha256:[A-Fa-f0-9]{64}$/u),
    service_version: versionSchema,
    contract_version: z.literal(QUOTE_V2_CONTRACT_VERSION),
    release_id: identifierSchema,
    release_hash: z.string().regex(/^sha256:[A-Fa-f0-9]{64}$/u),
    published_at: dateTimeSchema,
  })
  .strict();

const quoteV2CalculatedResultSchema = quoteV2ResultBaseSchema
  .extend({
    quote_status: z.literal("calculated"),
    total: feeSchema,
    line_items: z.array(lineItemSchema).min(1),
    billing_pallets: z.number().int().min(1),
  })
  .strict();

const quoteV2ManualResultSchema = quoteV2ResultBaseSchema
  .extend({
    quote_status: z.enum(["manual_review", "not_calculable"]),
    total: z.null(),
    line_items: z.array(lineItemSchema).max(0),
    billing_pallets: z.number().int().min(1).nullable(),
  })
  .strict();

function uniqueStrings(value: readonly string[]): boolean {
  return new Set(value).size === value.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return uniqueStrings(left) && uniqueStrings(right) &&
    leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

export const quoteV2ResultSchema = z
  .discriminatedUnion("quote_status", [
    quoteV2CalculatedResultSchema,
    quoteV2ManualResultSchema,
  ])
  .superRefine((value, refinement) => {
    if (!uniqueStrings(value.source_ref_ids)) {
      refinement.addIssue({ code: "custom", message: "source_ref_ids must be unique", path: ["source_ref_ids"] });
    }
    const expectedSourceId = `src:quote:snapshot:${value.snapshot_hash.slice("sha256:".length)}`;
    if (value.source_ref_ids.length !== 1 || value.source_ref_ids[0] !== expectedSourceId) {
      refinement.addIssue({ code: "custom", message: "source_ref_ids must bind to snapshot_hash", path: ["source_ref_ids"] });
    }
    if (value.release_hash !== value.snapshot_hash) {
      refinement.addIssue({ code: "custom", message: "release_hash must equal snapshot_hash", path: ["release_hash"] });
    }
    if (value.valid_from > value.valid_to) {
      refinement.addIssue({ code: "custom", message: "valid_from must not be after valid_to", path: ["valid_from", "valid_to"] });
    }
    if (value.effective_date < value.valid_from || value.effective_date > value.valid_to) {
      refinement.addIssue({ code: "custom", message: "effective_date must be within the validity window", path: ["effective_date"] });
    }
    if (value.quote_status === "calculated") {
      if (value.total === null || value.line_items.length === 0 || value.billing_pallets < 1) {
        refinement.addIssue({ code: "custom", message: "calculated results require total, line_items, and billing_pallets", path: ["quote_status"] });
        return;
      }
      const lineIds = value.line_items.map((line) => line.line_id);
      if (!uniqueStrings(lineIds)) {
        refinement.addIssue({ code: "custom", message: "line_ids must be unique", path: ["line_items"] });
      }
      const lineSum = value.line_items.reduce(
        (sum, line) => sum.add(new Decimal(line.amount.amount)),
        new Decimal(0),
      );
      if (!lineSum.eq(new Decimal(value.total.amount))) {
        refinement.addIssue({ code: "custom", message: "line item amounts must sum to total", path: ["line_items"] });
      }
      for (const [index, line] of value.line_items.entries()) {
        if (!sameStringSet(line.source_ref_ids, value.source_ref_ids)) {
          refinement.addIssue({ code: "custom", message: "line source_ref_ids must equal top-level source_ref_ids", path: ["line_items", index, "source_ref_ids"] });
        }
      }
      return;
    }
    if (value.total !== null || value.line_items.length !== 0) {
      refinement.addIssue({ code: "custom", message: "non-calculated results require null total and empty line_items", path: ["quote_status"] });
    }
  });
