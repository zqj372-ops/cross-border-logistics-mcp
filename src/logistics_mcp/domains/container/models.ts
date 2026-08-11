import { Decimal } from "decimal.js";
import { z } from "zod";

export const CONTAINER_PLAN_VERSION = "container-plan@2026-08-11.v1" as const;

export const containerTypeSchema = z.enum([
  "20GP",
  "40GP",
  "40HQ",
  "45HQ",
  "other",
]);

export const versionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/);

export const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);

export const decimalStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);

export const volumeMeasurementSchema = z
  .object({
    value: decimalStringSchema,
    unit: z.enum(["l", "cbm", "m3"]),
  })
  .strict();

export const weightMeasurementSchema = z
  .object({
    value: decimalStringSchema,
    unit: z.enum(["g", "kg", "lb"]),
  })
  .strict();

export const containerProfileSchema = z
  .object({
    version: versionSchema,
    container_type: containerTypeSchema,
    physical_capacity: volumeMeasurementSchema,
    operational_target: volumeMeasurementSchema,
    max_payload: weightMeasurementSchema,
    source_ref_ids: z.array(identifierSchema).min(1),
  })
  .strict();

export type VolumeMeasurement = z.infer<typeof volumeMeasurementSchema>;
export type WeightMeasurement = z.infer<typeof weightMeasurementSchema>;
export type ContainerType = z.infer<typeof containerTypeSchema>;
export type ContainerProfile = z.infer<typeof containerProfileSchema>;

export const cargoMetricsSchema = z
  .object({
    version: versionSchema,
    line_count: z.number().int().min(0),
    total_quantity: z.number().int().min(0),
    total_volume: volumeMeasurementSchema,
    actual_weight: weightMeasurementSchema,
    volumetric_weight: weightMeasurementSchema,
    weight_evidence: z.enum([
      "unit_weight",
      "piece_weights",
      "line_total_weight",
      "missing",
      "conflicting",
    ]),
    derived_from_line_ids: z.array(identifierSchema),
  })
  .strict();

export type CargoMetrics = z.infer<typeof cargoMetricsSchema>;

export interface ValidationIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly issues: readonly ValidationIssue[];
    };

function failure(
  code: string,
  field: string,
  message: string,
): ValidationResult<never> {
  return {
    ok: false,
    code,
    issues: [{ field, code, message }],
  };
}

function zodFailure<T>(
  error: z.ZodError,
  fallbackCode: string,
): ValidationResult<T> {
  const first = error.issues[0];
  if (first === undefined) {
    return failure(fallbackCode, "<root>", "Input does not satisfy the contract.");
  }

  const code =
    first.code === "unrecognized_keys"
      ? "container.unknown_field"
      : fallbackCode;
  return {
    ok: false,
    code,
    issues: error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "<root>",
      code: issue.code,
      message: issue.message,
    })),
  };
}

function requirePositive(
  measurement: { readonly value: string },
  field: string,
  code: string,
): ValidationResult<true> {
  const value = new Decimal(measurement.value);
  if (value.isZero()) {
    return failure(code, field, "The measurement must be greater than zero.");
  }
  if (value.isNegative()) {
    return failure(code, field, "The measurement cannot be negative.");
  }
  return { ok: true, value: true };
}

function requireNonNegative(
  measurement: { readonly value: string },
  field: string,
  code: string,
): ValidationResult<true> {
  const value = new Decimal(measurement.value);
  if (value.isNegative()) {
    return failure(code, field, "The measurement cannot be negative.");
  }
  return { ok: true, value: true };
}

export function validateContainerProfile(
  input: unknown,
): ValidationResult<ContainerProfile> {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "physical_capacity" in input &&
    typeof input.physical_capacity === "object" &&
    input.physical_capacity !== null &&
    "unit" in input.physical_capacity &&
    input.physical_capacity.unit !== "cbm"
  ) {
    return failure(
      "container.capacity_unit_invalid",
      "physical_capacity.unit",
      "Physical capacity must use cbm.",
    );
  }

  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "operational_target" in input &&
    typeof input.operational_target === "object" &&
    input.operational_target !== null &&
    "unit" in input.operational_target &&
    input.operational_target.unit !== "cbm"
  ) {
    return failure(
      "container.operational_target_unit_invalid",
      "operational_target.unit",
      "Operational target must use cbm.",
    );
  }

  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "max_payload" in input &&
    typeof input.max_payload === "object" &&
    input.max_payload !== null &&
    "unit" in input.max_payload &&
    input.max_payload.unit !== "kg"
  ) {
    return failure(
      "container.payload_unit_invalid",
      "max_payload.unit",
      "Maximum payload must use kg.",
    );
  }

  const parsed = containerProfileSchema.safeParse(input);
  if (!parsed.success) {
    return zodFailure(parsed.error, "container.profile_invalid");
  }

  const profile = parsed.data;
  for (const [field, measurement, code] of [
    ["physical_capacity", profile.physical_capacity, "container.capacity_invalid"],
    [
      "operational_target",
      profile.operational_target,
      "container.operational_target_invalid",
    ],
    ["max_payload", profile.max_payload, "container.payload_invalid"],
  ] as const) {
    const positive = requirePositive(measurement, field, code);
    if (!positive.ok) {
      return positive;
    }
  }

  if (new Set(profile.source_ref_ids).size !== profile.source_ref_ids.length) {
    return failure(
      "container.source_ref_ids_duplicate",
      "source_ref_ids",
      "Source reference IDs must be unique.",
    );
  }

  return { ok: true, value: profile };
}

export function validateCargoMetrics(
  input: unknown,
): ValidationResult<CargoMetrics> {
  const parsed = cargoMetricsSchema.safeParse(input);
  if (!parsed.success) {
    return zodFailure(parsed.error, "container.cargo_metrics_invalid");
  }

  const metrics = parsed.data;
  for (const [field, measurement] of [
    ["total_volume", metrics.total_volume],
    ["actual_weight", metrics.actual_weight],
    ["volumetric_weight", metrics.volumetric_weight],
  ] as const) {
    const nonNegative = requireNonNegative(
      measurement,
      field,
      "container.cargo_measurement_negative",
    );
    if (!nonNegative.ok) {
      return nonNegative;
    }
  }

  if (new Set(metrics.derived_from_line_ids).size !== metrics.derived_from_line_ids.length) {
    return failure(
      "container.cargo_line_ids_duplicate",
      "derived_from_line_ids",
      "Derived line IDs must be unique.",
    );
  }

  return { ok: true, value: metrics };
}
