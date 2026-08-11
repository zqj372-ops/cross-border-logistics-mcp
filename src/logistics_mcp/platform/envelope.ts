import { z } from "zod";

import { ContractValidationError } from "./contract-errors";

export const ENVELOPE_SCHEMA_VERSION = "2026-08-11.v1" as const;

export const ENVELOPE_STATUSES = [
  "success",
  "needs_input",
  "manual_review",
  "blocked",
  "unavailable",
] as const;

export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export const REVIEW_STATUSES = [
  "not_required",
  "pending",
  "approved",
  "rejected",
  "manual_review",
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface Notice {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "warning" | "error";
  readonly field?: string | null;
}

export interface SourceRef {
  readonly source_id: string;
  readonly source_type:
    | "internal_system"
    | "official_source"
    | "tenant_record"
    | "user_input"
    | "opaque_reference"
    | "fixture";
  readonly system: string;
  readonly locator: string;
  readonly version: string;
  readonly retrieved_at: string;
  readonly authority:
    | "authoritative"
    | "supporting"
    | "user_provided"
    | "opaque";
  readonly content_hash?: string | null;
}

export type TraceValue =
  | string
  | number
  | boolean
  | null
  | { readonly amount: string; readonly currency: string }
  | { readonly value: string; readonly unit: string };

export interface CalculationOperand {
  readonly name: string;
  readonly value: TraceValue;
}

export interface CalculationStep {
  readonly step_id: string;
  readonly operation: string;
  readonly inputs: readonly CalculationOperand[];
  readonly result: TraceValue;
  readonly source_ref_ids: readonly string[];
  readonly rounding?: string | null;
}

export type EnvelopeData = Record<string, unknown> | null;

export interface ResponseEnvelope<TData extends EnvelopeData = EnvelopeData> {
  readonly schema_version: typeof ENVELOPE_SCHEMA_VERSION;
  readonly request_id: string;
  readonly status: EnvelopeStatus;
  readonly data: TData;
  readonly source_refs: readonly SourceRef[];
  readonly assumptions: readonly Notice[];
  readonly warnings: readonly Notice[];
  readonly blockers: readonly Notice[];
  readonly calculation_trace: readonly CalculationStep[];
  readonly review_status: ReviewStatus;
  readonly audit_id: string;
}

export interface CreateEnvelopeInput<TData extends EnvelopeData = EnvelopeData> {
  readonly requestId: string;
  readonly status: EnvelopeStatus;
  readonly data: TData;
  readonly auditId: string;
  readonly sourceRefs?: readonly SourceRef[];
  readonly assumptions?: readonly Notice[];
  readonly warnings?: readonly Notice[];
  readonly blockers?: readonly Notice[];
  readonly calculationTrace?: readonly CalculationStep[];
  readonly reviewStatus?: ReviewStatus;
}

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const versionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/);
const dateTimeSchema = z.string().datetime({ offset: true });
const moneySchema = z
  .object({
    amount: z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
const measurementSchema = z
  .object({
    value: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    unit: z.enum([
      "g",
      "kg",
      "lb",
      "mm",
      "cm",
      "m",
      "l",
      "cbm",
      "m3",
      "piece",
      "pallet",
      "container",
      "hours",
      "days",
    ]),
  })
  .strict();
const noticeSchema = z
  .object({
    code: identifierSchema,
    message: z.string().min(1).max(1000),
    severity: z.enum(["info", "warning", "error"]),
    field: z.string().min(1).nullable().optional(),
  })
  .strict();
const sourceRefSchema = z
  .object({
    source_id: identifierSchema,
    source_type: z.enum([
      "internal_system",
      "official_source",
      "tenant_record",
      "user_input",
      "opaque_reference",
      "fixture",
    ]),
    system: z.string().min(1).max(120),
    locator: z.string().min(1).max(500),
    version: versionSchema,
    retrieved_at: dateTimeSchema,
    authority: z.enum([
      "authoritative",
      "supporting",
      "user_provided",
      "opaque",
    ]),
    content_hash: z.string().regex(/^(sha256:)?[A-Za-z0-9._:-]{8,128}$/).nullable().optional(),
  })
  .strict();
const traceValueSchema = z.union([
  z.string(),
  z.number().int(),
  z.boolean(),
  z.null(),
  moneySchema,
  measurementSchema,
]);
const calculationStepSchema = z
  .object({
    step_id: identifierSchema,
    operation: z.string().min(1).max(160),
    inputs: z.array(
      z
        .object({
          name: z.string().min(1).max(120),
          value: traceValueSchema,
        })
        .strict(),
    ),
    result: traceValueSchema,
    source_ref_ids: z.array(identifierSchema).superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: "custom", message: "source_ref_ids must be unique" });
      }
    }),
    rounding: z.string().max(120).nullable().optional(),
  })
  .strict();
const sourceRefsSchema = z
  .array(sourceRefSchema)
  .superRefine((values, ctx) => {
    const serialized = values.map((value) => JSON.stringify(value));
    if (new Set(serialized).size !== serialized.length) {
      ctx.addIssue({
        code: "custom",
        message: "source_refs must be unique",
      });
    }
  });

export const envelopeSchema = z
  .object({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    request_id: identifierSchema,
    status: z.enum(ENVELOPE_STATUSES),
    data: z.record(z.string(), z.unknown()).nullable(),
    source_refs: sourceRefsSchema,
    assumptions: z.array(noticeSchema),
    warnings: z.array(noticeSchema),
    blockers: z.array(noticeSchema),
    calculation_trace: z.array(calculationStepSchema),
    review_status: z.enum(REVIEW_STATUSES),
    audit_id: identifierSchema,
  })
  .strict();

function assertStatusInvariant(envelope: ResponseEnvelope): void {
  if (envelope.status === "success" && envelope.blockers.length > 0) {
    throw new ContractValidationError(
      "A success response cannot contain blockers.",
      [{ path: "blockers", code: "success_with_blockers" }],
    );
  }

  if (envelope.status !== "success" && envelope.blockers.length === 0) {
    throw new ContractValidationError(
      "A non-success response must contain at least one blocker.",
      [{ path: "blockers", code: "missing_blocker" }],
    );
  }
}

export function validateEnvelope<TData extends EnvelopeData = EnvelopeData>(
  input: unknown,
): ResponseEnvelope<TData> {
  const parsed = envelopeSchema.safeParse(input);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "<root>",
      code: issue.code,
    }));
    const fields = parsed.error.issues
      .map((issue, index) => {
        const path = issues[index]?.path;
        return path === "<root>" ? issue.message : path;
      })
      .join(", ");
    throw new ContractValidationError(
      `Invalid response envelope fields: ${fields}`,
      issues,
    );
  }

  const envelope = parsed.data as ResponseEnvelope;
  assertStatusInvariant(envelope);
  return envelope as ResponseEnvelope<TData>;
}

export function createEnvelope<TData extends EnvelopeData>(
  input: CreateEnvelopeInput<TData>,
): ResponseEnvelope<TData> {
  const envelope = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    request_id: input.requestId,
    status: input.status,
    data: input.data,
    source_refs: [...(input.sourceRefs ?? [])],
    assumptions: [...(input.assumptions ?? [])],
    warnings: [...(input.warnings ?? [])],
    blockers: [...(input.blockers ?? [])],
    calculation_trace: [...(input.calculationTrace ?? [])],
    review_status: input.reviewStatus ?? "not_required",
    audit_id: input.auditId,
  } satisfies ResponseEnvelope<TData>;

  return validateEnvelope(envelope);
}
