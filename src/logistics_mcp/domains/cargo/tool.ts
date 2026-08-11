import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { z } from "zod";

import type { EnvelopeData } from "../../platform/envelope";
import type {
  DomainToolHandler,
  ToolContract,
} from "../../server/tool-registry";
import { calculateCargo } from "./service";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const RATIO_PATTERN = /^(0|0\.[0-9]+|1(?:\.0+)?)$/;

const identifierSchema = z.string().regex(IDENTIFIER_PATTERN);
const versionSchema = z.string().regex(VERSION_PATTERN);
const decimalSchema = z.string().regex(DECIMAL_PATTERN);
const nonNegativeDecimalSchema = z.string().regex(NON_NEGATIVE_DECIMAL_PATTERN);
const ratioSchema = z.string().regex(RATIO_PATTERN);
const uniqueIdentifiersSchema = z.array(identifierSchema).min(1).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", message: "Identifiers must be unique." });
  }
});

const weightMeasurementSchema = z
  .object({
    value: nonNegativeDecimalSchema,
    unit: z.enum(["g", "kg", "lb"]),
  })
  .strict();
const lengthMeasurementSchema = z
  .object({
    value: nonNegativeDecimalSchema,
    unit: z.enum(["mm", "cm", "m"]),
  })
  .strict();
const volumeMeasurementSchema = z
  .object({
    value: nonNegativeDecimalSchema,
    unit: z.enum(["l", "cbm", "m3"]),
  })
  .strict();
const dimensionSetSchema = z
  .object({
    length: lengthMeasurementSchema,
    width: lengthMeasurementSchema,
    height: lengthMeasurementSchema,
    quantity: z.number().int().safe().min(1),
  })
  .strict();
const moneySchema = z
  .object({
    amount: decimalSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
const opaqueInputRefSchema = z
  .object({
    ref_id: identifierSchema,
    kind: z.enum([
      "raw_input",
      "document",
      "credential",
      "record",
      "attachment",
      "external_response",
    ]),
    purpose: z.string().min(1).max(200),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const cargoLineSchema = z
  .object({
    version: versionSchema,
    line_id: identifierSchema,
    description: z.string().min(1).max(500),
    quantity: z.number().int().safe().min(1),
    quantity_unit: z.enum([
      "piece",
      "carton",
      "crate",
      "bag",
      "pallet",
      "drum",
      "container",
    ]),
    package_type: z.enum([
      "carton",
      "wooden_crate",
      "pallet",
      "bag",
      "drum",
      "other",
    ]),
    unit_weight: weightMeasurementSchema.optional(),
    piece_weights: z.array(weightMeasurementSchema).min(1).optional(),
    line_total_weight: weightMeasurementSchema.optional(),
    dimensions: z.array(dimensionSetSchema).min(1).optional(),
    volume: volumeMeasurementSchema.optional(),
    stackable: z.boolean(),
    fragile: z.boolean(),
    sensitive: z.boolean(),
    declared_value: moneySchema.optional(),
    opaque_input_ref: opaqueInputRefSchema.optional(),
    source_ref_ids: uniqueIdentifiersSchema,
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
    retrieved_at: z.string().datetime({ offset: true }),
    authority: z.enum(["authoritative", "supporting", "user_provided", "opaque"]),
    content_hash: z.string().regex(/^(sha256:)?[A-Za-z0-9._:-]{8,128}$/).nullable().optional(),
  })
  .strict();
const uniqueSourceRefsSchema = z.array(sourceRefSchema).min(1).superRefine((values, ctx) => {
  const sourceIds = values.map((value) => value.source_id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    ctx.addIssue({ code: "custom", message: "source_refs source_id values must be unique." });
  }
});

const dimensionalBasisSchema = z
  .object({
    value: nonNegativeDecimalSchema,
    unit: z.enum(["kg_per_cbm", "cbm_per_kg"]),
  })
  .strict();
const roundingSchema = z
  .object({
    mode: z.enum(["none", "up", "down", "half_up"]),
    decimals: z.number().int().min(0).max(18),
  })
  .strict();
const supplierRuleSchema = z
  .object({
    method: z.enum(["actual", "volumetric", "max", "bubble_share"]),
    ratio: ratioSchema.nullable().optional(),
  })
  .strict();
const bubbleRuleSchema = z
  .object({
    channel: z.string().min(1).max(120),
    mode: z.enum(["none", "full", "half", "ratio", "fixed_density"]),
    ratio: ratioSchema.nullable(),
    rule_version: versionSchema,
    source_ref_ids: uniqueIdentifiersSchema,
    divisor: dimensionalBasisSchema.optional(),
    density: dimensionalBasisSchema.optional(),
    unit: z.literal("kg"),
    rounding: roundingSchema,
    supplier: supplierRuleSchema.optional(),
  })
  .strict();
const dimensionalDivisorSchema = z
  .object({
    value: nonNegativeDecimalSchema,
    unit: z.enum(["kg_per_cbm", "cbm_per_kg"]),
  })
  .strict()
  .nullable();

export const cargoInputSchema = z
  .object({
    schema_version: z.literal("2026-08-11.v1"),
    version: versionSchema,
    cargo_lines: z.array(cargoLineSchema).min(1),
    dimensional_divisor: dimensionalDivisorSchema,
    bubble_rule: bubbleRuleSchema,
    channel_code: z.string().min(1).max(120),
    source_refs: uniqueSourceRefsSchema,
  })
  .strict();

const schemaDir = fileURLToPath(
  new URL("../../../../docs/contracts/schemas/", import.meta.url),
);

function readSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${schemaDir}/${file}`, "utf8")) as Record<string, unknown>;
}

function createCargoOutputValidator(): (data: EnvelopeData) => void {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  for (const file of [
    "common.schema.json",
    "cargo-line.schema.json",
    "cargo-metrics.schema.json",
    "chargeable-weight.schema.json",
    "cargo-result.schema.json",
  ]) {
    ajv.addSchema(readSchema(file));
  }
  const validator = ajv.getSchema(
    "https://schemas.example.invalid/logistics-mcp/2026-08-11/cargo-result.schema.json",
  );
  if (validator === undefined) {
    throw new Error("Cargo result schema could not be loaded.");
  }
  return (data: EnvelopeData): void => {
    if (data === null || !validator(data)) {
      throw new Error(`Invalid cargo-result output: ${ajv.errorsText(validator.errors)}`);
    }
  };
}

export const validateCargoOutput = createCargoOutputValidator();

export const cargoToolHandler: DomainToolHandler = (input, context) =>
  calculateCargo(input, context);

export const cargoToolContract: ToolContract = {
  inputSchema: cargoInputSchema,
  validateOutput: validateCargoOutput,
};

export const cargoTool = {
  handler: cargoToolHandler,
  contract: cargoToolContract,
} as const;
