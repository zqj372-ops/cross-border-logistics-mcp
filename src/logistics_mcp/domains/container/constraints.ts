import { Decimal } from "decimal.js";
import { z } from "zod";

import {
  identifierSchema,
  type ValidationResult,
  versionSchema,
  volumeMeasurementSchema,
  weightMeasurementSchema,
} from "./models";

export const loadingConstraintsSchema = z
  .object({
    sensitive_at_head: z.boolean(),
    declaration_at_tail: z.boolean(),
    fifo_for_other: z.boolean(),
    customer_priority: z.number().int().min(1).nullable(),
  })
  .strict();

export const loadingLineSchema = z
  .object({
    version: versionSchema.optional(),
    line_id: identifierSchema,
    sensitive: z.boolean(),
    customer_priority: z.number().int().min(1).nullable(),
    declaration_required: z.boolean(),
    inspection_required: z.boolean().optional(),
    volume: volumeMeasurementSchema.optional(),
    weight: weightMeasurementSchema.optional(),
    fifo_sequence: z.number().int().min(0).optional(),
    priority_note: z.string().min(1).max(200).optional(),
  })
  .strict();

export type LoadingConstraints = z.infer<typeof loadingConstraintsSchema>;
export type LoadingLine = z.infer<typeof loadingLineSchema>;

function validationFailure<T>(
  code: string,
  field: string,
  message: string,
): ValidationResult<T> {
  return {
    ok: false,
    code,
    issues: [{ field, code, message }],
  };
}

export function validateLoadingConstraints(
  input: unknown,
): ValidationResult<LoadingConstraints> {
  const parsed = loadingConstraintsSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return validationFailure(
      first?.code === "unrecognized_keys"
        ? "container.loading.unknown_field"
        : "container.loading.constraints_invalid",
      first?.path.join(".") || "loading_constraints",
      first?.message ?? "Loading constraints are invalid.",
    );
  }
  return { ok: true, value: parsed.data };
}

export function validateLoadingLines(
  input: unknown,
): ValidationResult<readonly LoadingLine[]> {
  const parsed = z.array(loadingLineSchema).safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return validationFailure(
      first?.code === "unrecognized_keys"
        ? "container.loading.line_unknown_field"
        : "container.loading.lines_invalid",
      first?.path.join(".") || "loading_lines",
      first?.message ?? "Loading line metadata is invalid.",
    );
  }

  const ids = parsed.data.map((line) => line.line_id);
  if (new Set(ids).size !== ids.length) {
    return validationFailure(
      "container.loading.line_ids_duplicate",
      "loading_lines",
      "Loading line IDs must be unique.",
    );
  }

  for (const [index, line] of parsed.data.entries()) {
    for (const [field, measurement] of [
      ["volume", line.volume],
      ["weight", line.weight],
    ] as const) {
      if (measurement === undefined) {
        continue;
      }
      if (new Decimal(measurement.value).isNegative()) {
        return validationFailure(
          "container.loading.measurement_negative",
          `loading_lines.${index}.${field}`,
          "Loading measurements cannot be negative.",
        );
      }
    }
  }

  return { ok: true, value: parsed.data };
}
