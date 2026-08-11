import {
  cargoDiagnostic,
  type CargoDiagnostic,
  type CargoDiagnosticStatus,
  type CargoValidationFailure,
} from "./diagnostics";

export type WeightUnit = "g" | "kg" | "lb";
export type LengthUnit = "mm" | "cm" | "m";
export type VolumeUnit = "l" | "cbm" | "m3";

export type QuantityUnit =
  | "piece"
  | "carton"
  | "crate"
  | "bag"
  | "pallet"
  | "drum"
  | "container";

export type PackageType =
  | "carton"
  | "wooden_crate"
  | "pallet"
  | "bag"
  | "drum"
  | "other";

export interface WeightMeasurement {
  readonly value: string;
  readonly unit: WeightUnit;
}

export interface LengthMeasurement {
  readonly value: string;
  readonly unit: LengthUnit;
}

export interface VolumeMeasurement {
  readonly value: string;
  readonly unit: VolumeUnit;
}

export interface DimensionSet {
  readonly length: LengthMeasurement;
  readonly width: LengthMeasurement;
  readonly height: LengthMeasurement;
  readonly quantity: number;
}

export interface Money {
  readonly amount: string;
  readonly currency: string;
}

export interface OpaqueInputReference {
  readonly ref_id: string;
  readonly kind:
    | "raw_input"
    | "document"
    | "credential"
    | "record"
    | "attachment"
    | "external_response";
  readonly purpose: string;
  readonly expires_at?: string | null;
}

export interface CargoLine {
  readonly version: string;
  readonly line_id: string;
  readonly description: string;
  readonly quantity: number;
  readonly quantity_unit: QuantityUnit;
  readonly package_type: PackageType;
  readonly unit_weight?: WeightMeasurement;
  readonly piece_weights?: readonly WeightMeasurement[];
  readonly line_total_weight?: WeightMeasurement;
  readonly dimensions?: readonly DimensionSet[];
  readonly volume?: VolumeMeasurement;
  readonly stackable: boolean;
  readonly fragile: boolean;
  readonly sensitive: boolean;
  readonly declared_value?: Money;
  readonly opaque_input_ref?: OpaqueInputReference;
  readonly source_ref_ids: readonly string[];
}

export interface CargoLineValidationSuccess {
  readonly ok: true;
  readonly value: CargoLine;
}

export type CargoLineValidation =
  | CargoLineValidationSuccess
  | CargoValidationFailure;

export interface CargoMetrics {
  readonly version: string;
  readonly line_count: number;
  readonly total_quantity: number;
  readonly total_volume: VolumeMeasurement;
  readonly actual_weight: WeightMeasurement;
  readonly volumetric_weight: WeightMeasurement;
  readonly weight_evidence:
    | "unit_weight"
    | "piece_weights"
    | "line_total_weight"
    | "missing"
    | "conflicting";
  readonly derived_from_line_ids: readonly string[];
}

export type BubbleMethod = "none" | "full" | "half" | "ratio" | "fixed_density";

export interface DimensionalRule {
  readonly channel: string;
  readonly rule_version: string;
  readonly source_ref_ids: readonly string[];
  readonly divisor?: WeightMeasurement;
  readonly density?: WeightMeasurement;
  readonly unit: "kg";
  readonly rounding: RoundingRule;
  readonly method: BubbleMethod;
  readonly ratio?: string;
  readonly supplier?: SupplierChargeableRule;
}

export interface RoundingRule {
  readonly mode: "none" | "up" | "down" | "half_up";
  readonly decimals: number;
}

export interface SupplierChargeableRule {
  readonly method: "actual" | "volumetric" | "max" | "bubble_share";
  readonly ratio?: string;
}

export interface ChargeableWeight {
  readonly version: string;
  readonly actual_weight: WeightMeasurement;
  readonly volumetric_weight: WeightMeasurement;
  readonly bubble_weight: WeightMeasurement;
  readonly customer_chargeable_weight: WeightMeasurement;
  readonly supplier_chargeable_weight: WeightMeasurement;
  readonly bubble_share_ratio: string;
  readonly method: BubbleMethod;
  readonly rule_version: string;
  readonly source_ref_ids: readonly string[];
}

export interface CargoResult {
  readonly version: string;
  readonly metrics: CargoMetrics;
  readonly chargeable_weight: ChargeableWeight;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

const WEIGHT_UNITS = new Set<WeightUnit>(["g", "kg", "lb"]);
const LENGTH_UNITS = new Set<LengthUnit>(["mm", "cm", "m"]);
const VOLUME_UNITS = new Set<VolumeUnit>(["l", "cbm", "m3"]);
const QUANTITY_UNITS = new Set<QuantityUnit>([
  "piece",
  "carton",
  "crate",
  "bag",
  "pallet",
  "drum",
  "container",
]);
const PACKAGE_TYPES = new Set<PackageType>([
  "carton",
  "wooden_crate",
  "pallet",
  "bag",
  "drum",
  "other",
]);
const OPAQUE_KINDS = new Set<OpaqueInputReference["kind"]>([
  "raw_input",
  "document",
  "credential",
  "record",
  "attachment",
  "external_response",
]);

const LINE_FIELDS = new Set([
  "version",
  "line_id",
  "description",
  "quantity",
  "quantity_unit",
  "package_type",
  "unit_weight",
  "piece_weights",
  "line_total_weight",
  "dimensions",
  "volume",
  "stackable",
  "fragile",
  "sensitive",
  "declared_value",
  "opaque_input_ref",
  "source_ref_ids",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifierArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (candidate): candidate is string =>
        typeof candidate === "string" && IDENTIFIER_PATTERN.test(candidate),
    )
  );
}

function hasOnlyFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
): string | undefined {
  return Object.keys(value).find((field) => !fields.has(field));
}

function failure(
  code: string,
  status: CargoDiagnosticStatus,
  message: string,
  field?: string,
): CargoValidationFailure {
  return cargoDiagnostic(code, status, message, field);
}

function requiredString(
  value: unknown,
  field: string,
  pattern: RegExp,
): string | CargoValidationFailure {
  if (typeof value !== "string") {
    return failure(
      "cargo.field_required",
      "needs_input",
      `${field} must be a string.`,
      field,
    );
  }
  if (!pattern.test(value)) {
    return failure(
      "cargo.identifier_invalid",
      "needs_input",
      `${field} has an invalid identifier or version.`,
      field,
    );
  }
  return value;
}

function validateDecimal(
  value: unknown,
  field: string,
  nonNegative = true,
): string | CargoValidationFailure {
  if (typeof value !== "string") {
    return failure(
      "cargo.decimal_string_required",
      "needs_input",
      `${field} must be a decimal string.`,
      field,
    );
  }
  const matches = (nonNegative ? NON_NEGATIVE_DECIMAL_PATTERN : DECIMAL_PATTERN).test(
    value,
  );
  if (!matches) {
    return failure(
      value.startsWith("-") ? "cargo.negative_value" : "cargo.decimal_invalid",
      "needs_input",
      `${field} must be a valid non-negative decimal string.`,
      field,
    );
  }
  return value;
}

function validateMeasurement<Unit extends WeightUnit | LengthUnit | VolumeUnit>(
  value: unknown,
  field: string,
  units: ReadonlySet<Unit>,
): { readonly value: string; readonly unit: Unit } | CargoValidationFailure {
  if (!isRecord(value)) {
    return failure(
      "cargo.measurement_required",
      "needs_input",
      `${field} must be a measurement object.`,
      field,
    );
  }
  const unknownField = hasOnlyFields(value, new Set(["value", "unit"]));
  if (unknownField !== undefined) {
    return failure(
      "cargo.unknown_field",
      "needs_input",
      `${field}.${unknownField} is not an allowed measurement field.`,
      `${field}.${unknownField}`,
    );
  }
  const decimal = validateDecimal(value.value, `${field}.value`);
  if (typeof decimal !== "string") {
    return decimal;
  }
  if (typeof value.unit !== "string" || !units.has(value.unit as Unit)) {
    return failure(
      "cargo.unit_invalid",
      "needs_input",
      `${field}.unit is not supported for this measurement.`,
      `${field}.unit`,
    );
  }
  return { value: decimal, unit: value.unit as Unit };
}

function validateMoney(
  value: unknown,
  field: string,
): Money | CargoValidationFailure {
  if (!isRecord(value)) {
    return failure(
      "cargo.money_required",
      "needs_input",
      `${field} must be a money object.`,
      field,
    );
  }
  const unknownField = hasOnlyFields(value, new Set(["amount", "currency"]));
  if (unknownField !== undefined) {
    return failure(
      "cargo.unknown_field",
      "needs_input",
      `${field}.${unknownField} is not an allowed money field.`,
      `${field}.${unknownField}`,
    );
  }
  const amount = validateDecimal(value.amount, `${field}.amount`);
  if (typeof amount !== "string") {
    return amount;
  }
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) {
    return failure(
      "cargo.currency_invalid",
      "needs_input",
      `${field}.currency must be an ISO 4217 code.`,
      `${field}.currency`,
    );
  }
  return { amount, currency: value.currency };
}

function validateOpaqueReference(
  value: unknown,
  field: string,
): OpaqueInputReference | CargoValidationFailure {
  if (!isRecord(value)) {
    return failure(
      "cargo.opaque_reference_required",
      "needs_input",
      `${field} must be an opaque reference object.`,
      field,
    );
  }
  const unknownField = hasOnlyFields(
    value,
    new Set(["ref_id", "kind", "purpose", "expires_at"]),
  );
  if (unknownField !== undefined) {
    return failure(
      "cargo.unknown_field",
      "needs_input",
      `${field}.${unknownField} is not an allowed opaque reference field.`,
      `${field}.${unknownField}`,
    );
  }
  const refId = requiredString(value.ref_id, `${field}.ref_id`, IDENTIFIER_PATTERN);
  if (typeof refId !== "string") {
    return refId;
  }
  if (typeof value.kind !== "string" || !OPAQUE_KINDS.has(value.kind as OpaqueInputReference["kind"])) {
    return failure(
      "cargo.opaque_reference_kind_invalid",
      "needs_input",
      `${field}.kind is invalid.`,
      `${field}.kind`,
    );
  }
  if (typeof value.purpose !== "string" || value.purpose.length < 1 || value.purpose.length > 200) {
    return failure(
      "cargo.opaque_reference_purpose_invalid",
      "needs_input",
      `${field}.purpose must be between 1 and 200 characters.`,
      `${field}.purpose`,
    );
  }
  if (value.expires_at !== undefined && value.expires_at !== null && typeof value.expires_at !== "string") {
    return failure(
      "cargo.opaque_reference_expiry_invalid",
      "needs_input",
      `${field}.expires_at must be an ISO date-time or null.`,
      `${field}.expires_at`,
    );
  }
  return {
    ref_id: refId,
    kind: value.kind as OpaqueInputReference["kind"],
    purpose: value.purpose,
    ...(value.expires_at === undefined ? {} : { expires_at: value.expires_at }),
  };
}

function validateDimensions(
  value: unknown,
  field: string,
): readonly DimensionSet[] | CargoValidationFailure {
  if (!Array.isArray(value) || value.length === 0) {
    return failure(
      "cargo.dimensions_required",
      "needs_input",
      `${field} must contain at least one dimension set.`,
      field,
    );
  }
  const dimensions: DimensionSet[] = [];
  for (const [index, candidate] of value.entries()) {
    const itemField = `${field}[${index}]`;
    if (!isRecord(candidate)) {
      return failure(
        "cargo.dimension_set_required",
        "needs_input",
        `${itemField} must be a dimension set.`,
        itemField,
      );
    }
    const unknownField = hasOnlyFields(
      candidate,
      new Set(["length", "width", "height", "quantity"]),
    );
    if (unknownField !== undefined) {
      return failure(
        "cargo.unknown_field",
        "needs_input",
        `${itemField}.${unknownField} is not an allowed dimension field.`,
        `${itemField}.${unknownField}`,
      );
    }
    const length = validateMeasurement(candidate.length, `${itemField}.length`, LENGTH_UNITS);
    if (isValidationFailure(length)) {
      return length;
    }
    const width = validateMeasurement(candidate.width, `${itemField}.width`, LENGTH_UNITS);
    if (isValidationFailure(width)) {
      return width;
    }
    const height = validateMeasurement(candidate.height, `${itemField}.height`, LENGTH_UNITS);
    if (isValidationFailure(height)) {
      return height;
    }
    const quantity = candidate.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
      return failure(
        "cargo.dimension_quantity_invalid",
        "needs_input",
        `${itemField}.quantity must be a positive integer.`,
        `${itemField}.quantity`,
      );
    }
    dimensions.push({
      length,
      width,
      height,
      quantity,
    });
  }
  return dimensions;
}

function isValidationFailure(value: unknown): value is CargoValidationFailure {
  return isRecord(value) && value.ok === false;
}

export function validateCargoLine(input: unknown): CargoLineValidation {
  if (!isRecord(input)) {
    return failure(
      "cargo.line_required",
      "needs_input",
      "CargoLine must be an object.",
      "cargo_lines",
    );
  }
  const unknownField = hasOnlyFields(input, LINE_FIELDS);
  if (unknownField !== undefined) {
    return failure(
      "cargo.unknown_field",
      "needs_input",
      `${unknownField} is not an allowed CargoLine field.`,
      unknownField,
    );
  }

  const version = requiredString(input.version, "version", VERSION_PATTERN);
  if (typeof version !== "string") {
    return version;
  }
  const lineId = requiredString(input.line_id, "line_id", IDENTIFIER_PATTERN);
  if (typeof lineId !== "string") {
    return lineId;
  }
  if (typeof input.description !== "string" || input.description.length < 1 || input.description.length > 500) {
    return failure(
      "cargo.description_invalid",
      "needs_input",
      "description must be between 1 and 500 characters.",
      "description",
    );
  }
  const quantity = input.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
    return failure(
      "cargo.quantity_invalid",
      "needs_input",
      "quantity must be a positive integer.",
      "quantity",
    );
  }
  if (typeof input.quantity_unit !== "string" || !QUANTITY_UNITS.has(input.quantity_unit as QuantityUnit)) {
    return failure(
      "cargo.quantity_unit_invalid",
      "needs_input",
      "quantity_unit is not supported.",
      "quantity_unit",
    );
  }
  if (typeof input.package_type !== "string" || !PACKAGE_TYPES.has(input.package_type as PackageType)) {
    return failure(
      "cargo.package_type_invalid",
      "needs_input",
      "package_type is not supported.",
      "package_type",
    );
  }
  if (typeof input.stackable !== "boolean" || typeof input.fragile !== "boolean" || typeof input.sensitive !== "boolean") {
    return failure(
      "cargo.boolean_field_invalid",
      "needs_input",
      "stackable, fragile, and sensitive must be booleans.",
      "cargo_lines",
    );
  }
  const sourceRefIds = input.source_ref_ids;
  if (!isIdentifierArray(sourceRefIds)) {
    return failure(
      "cargo.source_ref_ids_invalid",
      "needs_input",
      "source_ref_ids must contain at least one valid identifier.",
      "source_ref_ids",
    );
  }
  if (new Set(sourceRefIds).size !== sourceRefIds.length) {
    return failure(
      "cargo.source_ref_ids_duplicate",
      "needs_input",
      "source_ref_ids must be unique.",
      "source_ref_ids",
    );
  }

  const evidenceFields = ["unit_weight", "piece_weights", "line_total_weight"] as const;
  const presentEvidence = evidenceFields.filter((field) => input[field] !== undefined);
  if (presentEvidence.length > 1) {
    return failure(
      "cargo.weight_evidence_mixed",
      "manual_review",
      "unit_weight, piece_weights, and line_total_weight are mutually exclusive.",
      "weight",
    );
  }

  let unitWeight: WeightMeasurement | undefined;
  if (input.unit_weight !== undefined) {
    const parsed = validateMeasurement(input.unit_weight, "unit_weight", WEIGHT_UNITS);
    if (isValidationFailure(parsed)) {
      return parsed;
    }
    unitWeight = parsed;
  }

  let pieceWeights: readonly WeightMeasurement[] | undefined;
  if (input.piece_weights !== undefined) {
    if (!Array.isArray(input.piece_weights) || input.piece_weights.length === 0) {
      return failure(
        "cargo.piece_weights_required",
        "needs_input",
        "piece_weights must contain at least one weight.",
        "piece_weights",
      );
    }
    if (input.piece_weights.length !== quantity) {
      return failure(
        "cargo.piece_weights_quantity_mismatch",
        "manual_review",
        "piece_weights must contain exactly one weight for every quantity unit.",
        "piece_weights",
      );
    }
    const parsedWeights: WeightMeasurement[] = [];
    for (const [index, candidate] of input.piece_weights.entries()) {
      const parsed = validateMeasurement(candidate, `piece_weights[${index}]`, WEIGHT_UNITS);
      if (isValidationFailure(parsed)) {
        return parsed;
      }
      parsedWeights.push(parsed);
    }
    pieceWeights = parsedWeights;
  }

  let lineTotalWeight: WeightMeasurement | undefined;
  if (input.line_total_weight !== undefined) {
    const parsed = validateMeasurement(input.line_total_weight, "line_total_weight", WEIGHT_UNITS);
    if (isValidationFailure(parsed)) {
      return parsed;
    }
    lineTotalWeight = parsed;
  }

  let dimensions: readonly DimensionSet[] | undefined;
  if (input.dimensions !== undefined) {
    const parsed = validateDimensions(input.dimensions, "dimensions");
    if (isValidationFailure(parsed)) {
      return parsed;
    }
    dimensions = parsed;
  }

  let volume: VolumeMeasurement | undefined;
  if (input.volume !== undefined) {
    const parsed = validateMeasurement(input.volume, "volume", VOLUME_UNITS);
    if (isValidationFailure(parsed)) {
      return parsed;
    }
    volume = parsed;
  }

  let declaredValue: Money | undefined;
  if (input.declared_value !== undefined) {
    const parsed = validateMoney(input.declared_value, "declared_value");
    if (isValidationFailure(parsed)) {
      return parsed;
    }
    declaredValue = parsed;
  }

  let opaqueInputRef: OpaqueInputReference | undefined;
  if (input.opaque_input_ref !== undefined) {
    const parsed = validateOpaqueReference(input.opaque_input_ref, "opaque_input_ref");
    if (isValidationFailure(parsed)) {
      return parsed;
    }
    opaqueInputRef = parsed;
  }

  const cargoLine = {
    version,
    line_id: lineId,
    description: input.description,
    quantity,
    quantity_unit: input.quantity_unit as QuantityUnit,
    package_type: input.package_type as PackageType,
    ...(unitWeight === undefined ? {} : { unit_weight: unitWeight }),
    ...(pieceWeights === undefined ? {} : { piece_weights: pieceWeights }),
    ...(lineTotalWeight === undefined ? {} : { line_total_weight: lineTotalWeight }),
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(volume === undefined ? {} : { volume }),
    stackable: input.stackable,
    fragile: input.fragile,
    sensitive: input.sensitive,
    ...(declaredValue === undefined ? {} : { declared_value: declaredValue }),
    ...(opaqueInputRef === undefined ? {} : { opaque_input_ref: opaqueInputRef }),
    source_ref_ids: [...sourceRefIds],
  } satisfies CargoLine;

  return { ok: true, value: cargoLine };
}

export type { CargoDiagnostic };
