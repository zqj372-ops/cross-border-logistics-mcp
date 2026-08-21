import { z } from "zod";

import { ENVELOPE_SCHEMA_VERSION } from "../platform/envelope";
import { quoteV2ResultSchema } from "./quote/quote-v2-contract";

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const versionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dateTimeSchema = z.string().datetime({ offset: true });
const decimalSchema = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const ratioSchema = z.string().regex(/^(0|0\.[0-9]+|1(?:\.0+)?)$/);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);

export const opaqueReferenceSchema = z
  .object({
    ref_id: identifierSchema,
    kind: z.enum(["raw_input", "document", "credential", "record", "attachment", "external_response"]),
    purpose: z.string().min(1).max(200),
    expires_at: dateTimeSchema.nullable().optional(),
  })
  .strict();

export const sourceRefSchema = z
  .object({
    source_id: identifierSchema,
    source_type: z.enum(["internal_system", "official_source", "tenant_record", "user_input", "opaque_reference", "fixture"]),
    system: z.string().min(1).max(120),
    locator: z.string().min(1).max(500),
    version: versionSchema,
    retrieved_at: dateTimeSchema,
    authority: z.enum(["authoritative", "supporting", "user_provided", "opaque"]),
    content_hash: z.string().regex(/^(sha256:)?[A-Za-z0-9._:-]{8,128}$/).nullable().optional(),
  })
  .strict();

export const moneySchema = z
  .object({ amount: decimalSchema, currency: currencySchema })
  .strict();

export const measurementSchema = z
  .object({
    value: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    unit: z.enum(["g", "kg", "lb", "mm", "cm", "m", "l", "cbm", "m3", "piece", "pallet", "container", "hours", "days"]),
  })
  .strict();

const volumeMeasurementSchema = measurementSchema.extend({
  unit: z.enum(["cbm", "m3"]),
});

const tenantContextSchema = z
  .object({
    tenant_id: identifierSchema,
    actor_id: identifierSchema,
    actor_role: z.enum(["admin", "sales", "operator", "customs_reviewer", "finance", "viewer", "service"]),
    client_id: identifierSchema,
    session_id: identifierSchema,
  })
  .strict();

export const writeContextSchema = z
  .object({
    tenant_context: tenantContextSchema,
    idempotency_key: z.string().min(16).max(200),
    operation_mode: z.enum(["preview", "commit"]),
    preview_ref: identifierSchema.nullable(),
    approval: z
      .object({
        required: z.boolean(),
        status: z.enum(["not_required", "pending", "approved", "rejected"]),
        approval_id: identifierSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const quoteResultSchema = z
  .object({
    version: versionSchema,
    quote_id: identifierSchema,
    quote_status: z.enum(["calculated", "not_calculable", "manual_review", "draft_saved"]),
    currency: currencySchema,
    total: moneySchema.nullable(),
    line_items: z
      .array(
        z
          .object({
            line_id: identifierSchema,
            label: z.string().min(1).max(200),
            amount: moneySchema.nullable(),
            pricing_basis: z.string().min(1).max(500),
            source_ref_ids: z.array(identifierSchema),
          })
          .strict(),
      ),
    rule_version: versionSchema,
    data_version: versionSchema,
    sendable: z.literal(false),
    valid_from: dateTimeSchema.nullable().optional(),
    valid_to: dateTimeSchema.nullable().optional(),
    source_ref_ids: z.array(identifierSchema).min(1),
  })
  .strict();

const customsCandidateSchema = z
  .object({
    hs_code: z.string().regex(/^[0-9.]{4,20}$/),
    classification_status: z.enum(["candidate", "confirmed", "manual_review"]),
    confidence: ratioSchema,
    reason_summary: z.string().min(1).max(1000),
    source_ref_ids: z.array(identifierSchema).min(1),
  })
  .strict();

const customsRateSchema = z
  .object({
    rate_id: identifierSchema,
    label: z.string().min(1).max(200),
    rate_expression_raw: z.string().min(1).max(300),
    amount: moneySchema.nullable(),
    confirmed: z.boolean(),
    source_ref_ids: z.array(identifierSchema).min(1),
  })
  .strict();

export const dataStatusSchema = z
  .object({
    version: versionSchema,
    system: z.string().min(1).max(120),
    ready: z.boolean(),
    test_data: z.boolean(),
    evaluated_at: dateTimeSchema,
    last_source_check_at: dateTimeSchema.nullable(),
    reasons: z.array(z.string().min(1)),
    release_ids: z.array(identifierSchema),
  })
  .strict();

export const customsSearchResultSchema = z
  .object({
    version: versionSchema,
    query_id: identifierSchema,
    jurisdiction: z.literal("CA"),
    query_kind: z.enum(["exact_code", "name_search", "candidate_selection"]),
    candidates: z.array(customsCandidateSchema),
    next_questions: z.array(z.string().min(1).max(500)),
    data_status: dataStatusSchema,
  })
  .strict();

export const customsAssessmentSchema = z
  .object({
    version: versionSchema,
    assessment_id: identifierSchema,
    jurisdiction: z.string().regex(/^[A-Z]{2}$/),
    assessment_status: z.enum(["candidate", "estimated", "manual_review", "unavailable"]),
    data_status: z.enum(["ready", "not_ready", "source_conflict", "source_missing"]),
    hs_candidates: z.array(customsCandidateSchema),
    valuation: moneySchema.nullable(),
    rates: z.array(customsRateSchema),
    total_estimated_import_tax: moneySchema.nullable(),
    tariff_release_version: versionSchema.nullable(),
    requires_broker_confirmation: z.boolean(),
    source_ref_ids: z.array(identifierSchema).min(1),
  })
  .strict();

export const knowledgeSearchResultSchema = z
  .object({
    version: versionSchema,
    query: z.string().min(1).max(200),
    curated_only: z.literal(true),
    archived_excluded: z.literal(true),
    results: z.array(
      z
        .object({
          result_id: identifierSchema,
          title: z.string().min(1).max(200),
          summary: z.string().min(1).max(1000),
          source_ref: sourceRefSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const writeResultSchema = z
  .object({
    version: versionSchema,
    operation: z.enum(["quote.save_draft", "review.create_task"]),
    operation_status: z.enum(["previewed", "committed", "already_committed", "rejected"]),
    record_id: identifierSchema.nullable(),
    preview_ref: identifierSchema,
    readback_evidence: z
      .object({
        target_system: z.string().min(1).max(120),
        record_id: identifierSchema,
        observed_version: versionSchema,
        observed_at: dateTimeSchema,
        verified: z.boolean(),
        source_ref_ids: z.array(identifierSchema).min(1),
      })
      .strict()
      .nullable(),
    idempotency_key: z.string().min(16).max(200),
    approval: z
      .object({
        required: z.boolean(),
        status: z.enum(["not_required", "pending", "approved", "rejected"]),
        approval_id: identifierSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const canadaFinalMileInputSchema = z
  .object({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    version: versionSchema,
    origin: z
      .object({ warehouse_code: identifierSchema, province: z.string().min(1).max(80) })
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
        billing_pallets: z.number().int().min(1).nullable(),
        weight_kg: measurementSchema.nullable(),
        pieces: z.number().int().min(1).nullable(),
        package_types: z.array(z.string().min(1).max(100)),
        total_volume: volumeMeasurementSchema.nullable().optional(),
      })
      .strict(),
    services: z
      .object({
        appointment: z.boolean(),
        liftgate: z.boolean(),
        limited_access: z.boolean(),
        remote_area: z.boolean(),
      })
      .strict(),
    effective_at: dateSchema,
  })
  .strict();

export const customsSearchInputSchema = z
  .object({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    version: versionSchema,
    rule_date: dateSchema,
    query_kind: z.enum(["exact_code", "name_search", "candidate_selection"]),
    query: z.string().trim().min(1).max(200).optional(),
    query_code: z.string().min(1).max(20).nullable().optional(),
    product_description_ref: opaqueReferenceSchema.nullable().optional(),
    product_attributes: z
      .object({
        material: z.string().min(1).max(500).nullable(),
        use: z.string().min(1).max(500).nullable(),
        origin_country: z.string().min(2).max(3).nullable(),
        contains_steel_aluminum: z.boolean().nullable(),
      })
      .strict(),
    selected_hs6: z.string().regex(/^\d{6}$/).nullable().optional(),
  })
  .strict();

export const customsEstimateInputSchema = z
  .object({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    version: versionSchema,
    rule_date: dateSchema,
    classification: z
      .object({
        hs_code: z.string().regex(/^[0-9.]{4,20}$/),
        status: z.enum(["candidate", "confirmed"]),
        source_ref_ids: z.array(identifierSchema).min(1),
      })
      .strict(),
    origin_country: z.string().min(2).max(3),
    value_for_duty: moneySchema,
    import_date: dateSchema,
    trade_treatment: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const knowledgeSearchInputSchema = z
  .object({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    query: z.string().min(1).max(200),
    scope: z.enum(["quote", "cargo", "container", "customs", "operations", "all"]),
    include_archived: z.literal(false),
    version_constraint: versionSchema.nullable().optional(),
    opaque_context_ref: opaqueReferenceSchema.nullable().optional(),
  })
  .strict();

export const dataStatusInputSchema = z
  .object({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    system: z.enum(["quote", "customs", "container", "knowledge", "all"]),
    rule_date: dateSchema.nullable().optional(),
  })
  .strict();

export const quoteSaveDraftInputSchema = z
  .object({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    version: versionSchema,
    quote_result: z.union([quoteResultSchema, quoteV2ResultSchema]),
    target: z
      .object({ system: z.literal("existing_quote_system"), record_kind: z.literal("draft") })
      .strict(),
    write_context: writeContextSchema,
  })
  .strict();

export const reviewCreateTaskInputSchema = z
  .object({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    version: versionSchema,
    task_type: z.enum(["quote", "customs", "container", "data_conflict", "source_unavailable"]),
    priority: z.enum(["low", "normal", "high", "critical"]),
    reason_codes: z.array(identifierSchema).min(1),
    opaque_context_refs: z.array(opaqueReferenceSchema).min(1),
    write_context: writeContextSchema,
  })
  .strict();

export type OutputValidator = (data: unknown) => void;

export function outputValidator(schema: z.ZodType): OutputValidator {
  return (data: unknown): void => {
    schema.parse(data);
  };
}
