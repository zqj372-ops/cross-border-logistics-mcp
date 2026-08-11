import type { CalculationStep, TraceValue } from "../../platform/envelope";
import {
  decimalFromString,
  formatFixed,
  type DecimalValue,
} from "./decimal";
import {
  cargoDiagnostic,
  type CargoValidationFailure,
} from "./diagnostics";
import {
  volumeToCbm,
} from "./units";
import type {
  BubbleMethod,
  ChargeableWeight,
  DimensionalBasis,
  DimensionalRule,
  RoundingRule,
  SupplierChargeableRule,
  VolumeMeasurement,
} from "./models";

export interface ChargeableWeightInput {
  readonly actual: string;
  readonly volumetric: string;
  readonly method: BubbleMethod;
  readonly ratio?: string | null;
  readonly ruleVersion: string;
  readonly sourceRefIds: readonly string[];
  readonly supplierRule?: SupplierChargeableRule;
}

export interface ChargeableWeightSuccess extends ChargeableWeight {
  readonly ok: true;
  readonly calculation_trace: readonly CalculationStep[];
}

export type ChargeableWeightResult =
  | ChargeableWeightSuccess
  | CargoValidationFailure;

export interface VolumetricWeightInput {
  readonly volume: VolumeMeasurement;
  readonly rule: DimensionalRule;
}

export interface VolumetricWeightSuccess {
  readonly ok: true;
  readonly volumetric_weight: { readonly value: string; readonly unit: "kg" };
  readonly calculation_trace: readonly CalculationStep[];
  readonly source_ref_ids: readonly string[];
}

export type VolumetricWeightResult =
  | VolumetricWeightSuccess
  | CargoValidationFailure;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const RATIO_PATTERN = /^(0|0\.[0-9]+|1(?:\.0+)?)$/;
const CHARGEABLE_FIELDS = new Set([
  "actual",
  "volumetric",
  "method",
  "ratio",
  "ruleVersion",
  "sourceRefIds",
  "supplierRule",
]);
const RULE_FIELDS = new Set([
  "channel",
  "rule_version",
  "source_ref_ids",
  "divisor",
  "density",
  "unit",
  "rounding",
  "method",
  "ratio",
  "supplier",
]);
const BASIS_FIELDS = new Set(["value", "unit"]);
const ROUNDING_FIELDS = new Set(["mode", "decimals"]);
const SUPPLIER_FIELDS = new Set(["method", "ratio"]);
const BUBBLE_METHODS = new Set<BubbleMethod>([
  "none",
  "full",
  "half",
  "ratio",
  "fixed_density",
]);
const ROUNDING_MODES = new Set<RoundingRule["mode"]>([
  "none",
  "up",
  "down",
  "half_up",
]);
const SUPPLIER_METHODS = new Set<SupplierChargeableRule["method"]>([
  "actual",
  "volumetric",
  "max",
  "bubble_share",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailure(value: unknown): value is CargoValidationFailure {
  return isRecord(value) && value.ok === false;
}

function unknownField(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(value).find((field) => !allowed.has(field));
}

function validIdentifierArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (candidate): candidate is string =>
        typeof candidate === "string" && IDENTIFIER_PATTERN.test(candidate),
    )
  );
}

function validDecimal(
  value: unknown,
  field: string,
): string | CargoValidationFailure {
  if (typeof value !== "string") {
    return cargoDiagnostic(
      "cargo.decimal_string_required",
      "needs_input",
      `${field} must be a non-negative decimal string.`,
      field,
    );
  }
  if (!NON_NEGATIVE_DECIMAL_PATTERN.test(value)) {
    return cargoDiagnostic(
      value.startsWith("-") ? "cargo.negative_value" : "cargo.decimal_invalid",
      "needs_input",
      `${field} must be a non-negative decimal string.`,
      field,
    );
  }
  return value;
}

function normalized(value: DecimalValue): string {
  const scale = Math.max(0, Math.min(18, value.decimalPlaces()));
  const fixed = formatFixed(value, scale);
  if (!fixed.includes(".")) {
    return fixed;
  }
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

function sourceRefs(value: unknown):
  | readonly string[]
  | CargoValidationFailure {
  if (!validIdentifierArray(value)) {
    return cargoDiagnostic(
      "cargo.source_ref_ids_invalid",
      "needs_input",
      "source_ref_ids must contain at least one valid identifier.",
      "source_ref_ids",
    );
  }
  if (new Set(value).size !== value.length) {
    return cargoDiagnostic(
      "cargo.source_ref_ids_duplicate",
      "needs_input",
      "source_ref_ids must be unique.",
      "source_ref_ids",
    );
  }
  return value;
}

function ratioValue(
  value: unknown,
  field: string,
): string | CargoValidationFailure {
  if (typeof value !== "string" || !RATIO_PATTERN.test(value)) {
    return cargoDiagnostic(
      "cargo.ratio_out_of_range",
      "needs_input",
      `${field} must be a decimal string in the closed interval [0, 1].`,
      field,
    );
  }
  return value;
}

function validateRounding(
  value: unknown,
): RoundingRule | CargoValidationFailure {
  if (!isRecord(value)) {
    return cargoDiagnostic(
      "cargo.rounding_required",
      "needs_input",
      "An explicit rounding rule is required.",
      "rounding",
    );
  }
  const extra = unknownField(value, ROUNDING_FIELDS);
  if (extra !== undefined) {
    return cargoDiagnostic(
      "cargo.unknown_field",
      "needs_input",
      `${extra} is not an allowed rounding field.`,
      `rounding.${extra}`,
    );
  }
  if (typeof value.mode !== "string" || !ROUNDING_MODES.has(value.mode as RoundingRule["mode"])) {
    return cargoDiagnostic(
      "cargo.rounding_mode_invalid",
      "needs_input",
      "rounding.mode is invalid.",
      "rounding.mode",
    );
  }
  if (typeof value.decimals !== "number" || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 18) {
    return cargoDiagnostic(
      "cargo.rounding_decimals_invalid",
      "needs_input",
      "rounding.decimals must be an integer from 0 through 18.",
      "rounding.decimals",
    );
  }
  return {
    mode: value.mode as RoundingRule["mode"],
    decimals: value.decimals,
  };
}

function validateBasis(
  value: unknown,
  field: "density" | "divisor",
  expectedUnit: DimensionalBasis["unit"],
): DimensionalBasis | CargoValidationFailure {
  if (!isRecord(value)) {
    return cargoDiagnostic(
      "cargo.dimensional_basis_required",
      "needs_input",
      `${field} must be a value/unit object.`,
      field,
    );
  }
  const extra = unknownField(value, BASIS_FIELDS);
  if (extra !== undefined) {
    return cargoDiagnostic(
      "cargo.unknown_field",
      "needs_input",
      `${field}.${extra} is not an allowed dimensional basis field.`,
      `${field}.${extra}`,
    );
  }
  const decimal = validDecimal(value.value, `${field}.value`);
  if (isFailure(decimal)) {
    return decimal;
  }
  if (typeof value.unit !== "string" || value.unit !== expectedUnit) {
    return cargoDiagnostic(
      "cargo.dimensional_unit_invalid",
      "needs_input",
      `${field}.unit must be ${expectedUnit}.`,
      `${field}.unit`,
    );
  }
  if (decimalFromString(decimal).lte(0)) {
    return cargoDiagnostic(
      "cargo.dimensional_basis_zero",
      "needs_input",
      `${field}.value must be greater than zero.`,
      `${field}.value`,
    );
  }
  return { value: decimal, unit: expectedUnit };
}

function validateDimensionalRule(
  value: unknown,
): DimensionalRule | CargoValidationFailure {
  if (!isRecord(value)) {
    return cargoDiagnostic(
      "cargo.dimensional_rule_required",
      "needs_input",
      "A versioned dimensional rule is required.",
      "rule",
    );
  }
  const extra = unknownField(value, RULE_FIELDS);
  if (extra !== undefined) {
    return cargoDiagnostic(
      "cargo.unknown_field",
      "needs_input",
      `${extra} is not an allowed dimensional rule field.`,
      `rule.${extra}`,
    );
  }
  if (typeof value.channel !== "string" || value.channel.length === 0 || value.channel.length > 120) {
    return cargoDiagnostic(
      "cargo.channel_required",
      "needs_input",
      "rule.channel is required.",
      "rule.channel",
    );
  }
  if (typeof value.rule_version !== "string" || !VERSION_PATTERN.test(value.rule_version)) {
    return cargoDiagnostic(
      "cargo.rule_version_missing",
      "needs_input",
      "rule.rule_version must be a versioned identifier.",
      "rule.rule_version",
    );
  }
  const refs = sourceRefs(value.source_ref_ids);
  if (isFailure(refs)) {
    return refs;
  }
  if (value.unit !== "kg") {
    return cargoDiagnostic(
      "cargo.dimensional_output_unit_invalid",
      "needs_input",
      "A dimensional rule must produce kilograms.",
      "rule.unit",
    );
  }
  const rounding = validateRounding(value.rounding);
  if (isFailure(rounding)) {
    return rounding;
  }
  if (typeof value.method !== "string" || !BUBBLE_METHODS.has(value.method as BubbleMethod)) {
    return cargoDiagnostic(
      "cargo.bubble_method_invalid",
      "needs_input",
      "rule.method is invalid.",
      "rule.method",
    );
  }
  const hasDensity = value.density !== undefined;
  const hasDivisor = value.divisor !== undefined;
  if (!hasDensity && !hasDivisor) {
    return cargoDiagnostic(
      "cargo.dimensional_basis_missing",
      "needs_input",
      "Provide an explicit density or divisor; no default is allowed.",
      "rule.density",
    );
  }
  if (hasDensity && hasDivisor) {
    return cargoDiagnostic(
      "cargo.dimensional_basis_conflict",
      "manual_review",
      "Provide exactly one of density or divisor.",
      "rule",
    );
  }
  const density = hasDensity
    ? validateBasis(value.density, "density", "kg_per_cbm")
    : undefined;
  if (density !== undefined && isFailure(density)) {
    return density;
  }
  const divisor = hasDivisor
    ? validateBasis(value.divisor, "divisor", "cbm_per_kg")
    : undefined;
  if (divisor !== undefined && isFailure(divisor)) {
    return divisor;
  }
  let ratio: string | undefined;
  if (value.method === "ratio") {
    if (value.ratio === undefined || value.ratio === null) {
      return cargoDiagnostic(
        "cargo.ratio_required",
        "needs_input",
        "ratio is required when rule.method is ratio.",
        "rule.ratio",
      );
    }
    const parsedRatio = ratioValue(value.ratio, "rule.ratio");
    if (isFailure(parsedRatio)) {
      return parsedRatio;
    }
    ratio = parsedRatio;
  } else if (value.ratio !== undefined && value.ratio !== null) {
    const parsedRatio = ratioValue(value.ratio, "rule.ratio");
    if (isFailure(parsedRatio)) {
      return parsedRatio;
    }
    ratio = parsedRatio;
  }
  let supplier: SupplierChargeableRule | undefined;
  if (value.supplier !== undefined) {
    if (!isRecord(value.supplier)) {
      return cargoDiagnostic(
        "cargo.supplier_rule_invalid",
        "needs_input",
        "rule.supplier must be an object.",
        "rule.supplier",
      );
    }
    const supplierExtra = unknownField(value.supplier, SUPPLIER_FIELDS);
    if (supplierExtra !== undefined) {
      return cargoDiagnostic(
        "cargo.unknown_field",
        "needs_input",
        `${supplierExtra} is not an allowed supplier rule field.`,
        `rule.supplier.${supplierExtra}`,
      );
    }
    if (typeof value.supplier.method !== "string" || !SUPPLIER_METHODS.has(value.supplier.method as SupplierChargeableRule["method"])) {
      return cargoDiagnostic(
        "cargo.supplier_method_invalid",
        "needs_input",
        "rule.supplier.method is invalid.",
        "rule.supplier.method",
      );
    }
    let supplierRatio: string | undefined;
    if (value.supplier.method === "bubble_share") {
      if (value.supplier.ratio === undefined || value.supplier.ratio === null) {
        return cargoDiagnostic(
          "cargo.supplier_ratio_required",
          "needs_input",
          "A supplier bubble_share rule requires a ratio.",
          "rule.supplier.ratio",
        );
      }
      const parsedSupplierRatio = ratioValue(value.supplier.ratio, "rule.supplier.ratio");
      if (isFailure(parsedSupplierRatio)) {
        return parsedSupplierRatio;
      }
      supplierRatio = parsedSupplierRatio;
    } else if (value.supplier.ratio !== undefined && value.supplier.ratio !== null) {
      const parsedSupplierRatio = ratioValue(value.supplier.ratio, "rule.supplier.ratio");
      if (isFailure(parsedSupplierRatio)) {
        return parsedSupplierRatio;
      }
      supplierRatio = parsedSupplierRatio;
    }
    supplier = {
      method: value.supplier.method as SupplierChargeableRule["method"],
      ...(supplierRatio === undefined ? {} : { ratio: supplierRatio }),
    };
  }
  return {
    channel: value.channel,
    rule_version: value.rule_version,
    source_ref_ids: refs,
    ...(density === undefined ? {} : { density }),
    ...(divisor === undefined ? {} : { divisor }),
    unit: "kg",
    rounding,
    method: value.method as BubbleMethod,
    ...(ratio === undefined ? {} : { ratio }),
    ...(supplier === undefined ? {} : { supplier }),
  };
}

function applyRounding(value: DecimalValue, rounding: RoundingRule): DecimalValue {
  if (rounding.mode === "none") {
    return value;
  }
  const mode = rounding.mode === "up"
    ? 2
    : rounding.mode === "down"
      ? 3
      : 4;
  return value.toDecimalPlaces(rounding.decimals, mode);
}

function measurement(value: string, unit: string): TraceValue {
  return { value, unit };
}

function traceStep(
  stepId: string,
  operation: string,
  inputs: readonly { name: string; value: TraceValue }[],
  result: TraceValue,
  sourceRefIds: readonly string[],
  rounding?: string,
): CalculationStep {
  return {
    step_id: stepId,
    operation,
    inputs,
    result,
    source_ref_ids: [...new Set(sourceRefIds)],
    ...(rounding === undefined ? {} : { rounding }),
  };
}

function validateChargeableInput(
  input: unknown,
):
  | {
      readonly actual: string;
      readonly volumetric: string;
      readonly method: BubbleMethod;
      readonly ratio?: string;
      readonly ruleVersion: string;
      readonly sourceRefIds: readonly string[];
      readonly supplierRule?: SupplierChargeableRule;
    }
  | CargoValidationFailure {
  if (!isRecord(input)) {
    return cargoDiagnostic(
      "cargo.chargeable_input_required",
      "needs_input",
      "Chargeable weight inputs are required.",
      "chargeable",
    );
  }
  const extra = unknownField(input, CHARGEABLE_FIELDS);
  if (extra !== undefined) {
    return cargoDiagnostic(
      "cargo.unknown_field",
      "needs_input",
      `${extra} is not an allowed chargeable input field.`,
      extra,
    );
  }
  const actual = validDecimal(input.actual, "actual");
  if (isFailure(actual)) {
    return actual;
  }
  const volumetric = validDecimal(input.volumetric, "volumetric");
  if (isFailure(volumetric)) {
    return volumetric;
  }
  if (typeof input.method !== "string" || !BUBBLE_METHODS.has(input.method as BubbleMethod)) {
    return cargoDiagnostic(
      "cargo.bubble_method_invalid",
      "needs_input",
      "method is invalid.",
      "method",
    );
  }
  if (typeof input.ruleVersion !== "string" || !VERSION_PATTERN.test(input.ruleVersion)) {
    return cargoDiagnostic(
      "cargo.rule_version_missing",
      "needs_input",
      "ruleVersion must be a versioned identifier.",
      "ruleVersion",
    );
  }
  const refs = sourceRefs(input.sourceRefIds);
  if (isFailure(refs)) {
    return refs;
  }
  let ratio: string | undefined;
  if (input.method === "ratio") {
    if (input.ratio === undefined || input.ratio === null) {
      return cargoDiagnostic(
        "cargo.ratio_required",
        "needs_input",
        "ratio is required when method is ratio.",
        "ratio",
      );
    }
    const parsedRatio = ratioValue(input.ratio, "ratio");
    if (isFailure(parsedRatio)) {
      return parsedRatio;
    }
    ratio = parsedRatio;
  } else if (input.ratio !== undefined && input.ratio !== null) {
    const parsedRatio = ratioValue(input.ratio, "ratio");
    if (isFailure(parsedRatio)) {
      return parsedRatio;
    }
    ratio = parsedRatio;
  }
  let supplierRule: SupplierChargeableRule | undefined;
  if (input.supplierRule !== undefined) {
    if (!isRecord(input.supplierRule)) {
      return cargoDiagnostic(
        "cargo.supplier_rule_invalid",
        "needs_input",
        "supplierRule must be an object.",
        "supplierRule",
      );
    }
    const extraSupplier = unknownField(input.supplierRule, SUPPLIER_FIELDS);
    if (extraSupplier !== undefined) {
      return cargoDiagnostic(
        "cargo.unknown_field",
        "needs_input",
        `${extraSupplier} is not an allowed supplier rule field.`,
        `supplierRule.${extraSupplier}`,
      );
    }
    if (typeof input.supplierRule.method !== "string" || !SUPPLIER_METHODS.has(input.supplierRule.method as SupplierChargeableRule["method"])) {
      return cargoDiagnostic(
        "cargo.supplier_method_invalid",
        "needs_input",
        "supplierRule.method is invalid.",
        "supplierRule.method",
      );
    }
    let supplierRatio: string | undefined;
    if (input.supplierRule.method === "bubble_share") {
      if (input.supplierRule.ratio === undefined || input.supplierRule.ratio === null) {
        return cargoDiagnostic(
          "cargo.supplier_ratio_required",
          "needs_input",
          "supplierRule.ratio is required for bubble_share.",
          "supplierRule.ratio",
        );
      }
      const parsedSupplierRatio = ratioValue(input.supplierRule.ratio, "supplierRule.ratio");
      if (isFailure(parsedSupplierRatio)) {
        return parsedSupplierRatio;
      }
      supplierRatio = parsedSupplierRatio;
    } else if (input.supplierRule.ratio !== undefined && input.supplierRule.ratio !== null) {
      const parsedSupplierRatio = ratioValue(input.supplierRule.ratio, "supplierRule.ratio");
      if (isFailure(parsedSupplierRatio)) {
        return parsedSupplierRatio;
      }
      supplierRatio = parsedSupplierRatio;
    }
    supplierRule = {
      method: input.supplierRule.method as SupplierChargeableRule["method"],
      ...(supplierRatio === undefined ? {} : { ratio: supplierRatio }),
    };
  }
  return {
    actual,
    volumetric,
    method: input.method as BubbleMethod,
    ...(ratio === undefined ? {} : { ratio }),
    ruleVersion: input.ruleVersion,
    sourceRefIds: refs,
    ...(supplierRule === undefined ? {} : { supplierRule }),
  };
}

export function calculateVolumetricWeight(
  input: unknown,
): VolumetricWeightResult {
  if (!isRecord(input) || !isRecord(input.volume)) {
    return cargoDiagnostic(
      "cargo.volume_required",
      "needs_input",
      "A volume measurement is required.",
      "volume",
    );
  }
  const volumeValue = validDecimal(input.volume.value, "volume.value");
  if (isFailure(volumeValue)) {
    return volumeValue;
  }
  if (typeof input.volume.unit !== "string" || !new Set(["l", "cbm", "m3"]).has(input.volume.unit)) {
    return cargoDiagnostic(
      "cargo.unit_invalid",
      "needs_input",
      "volume.unit must be l, cbm, or m3.",
      "volume.unit",
    );
  }
  const rule = validateDimensionalRule(input.rule);
  if (isFailure(rule)) {
    return rule;
  }
  const canonicalVolume = volumeToCbm(volumeValue, input.volume.unit as VolumeMeasurement["unit"]);
  const basis = rule.density ?? rule.divisor;
  if (basis === undefined) {
    return cargoDiagnostic(
      "cargo.dimensional_basis_missing",
      "needs_input",
      "An explicit density or divisor is required.",
      "rule",
    );
  }
  const unrounded = rule.density !== undefined
    ? canonicalVolume.mul(decimalFromString(basis.value))
    : canonicalVolume.div(decimalFromString(basis.value));
  const rounded = applyRounding(unrounded, rule.rounding);
  const volumeText = normalized(canonicalVolume);
  const basisText = normalized(decimalFromString(basis.value));
  const resultText = normalized(rounded);
  const calculationTrace: CalculationStep[] = [
    traceStep(
      "cargo:volumetric:volume",
      "convert volume to CBM",
      [{ name: "volume", value: measurement(volumeValue, input.volume.unit) }],
      measurement(volumeText, "cbm"),
      rule.source_ref_ids,
    ),
    traceStep(
      "cargo:volumetric:basis",
      rule.density === undefined
        ? "divide CBM by explicit dimensional divisor"
        : "multiply CBM by explicit dimensional density",
      [
        { name: "volume", value: measurement(volumeText, "cbm") },
        { name: rule.density === undefined ? "divisor" : "density", value: measurement(basisText, basis.unit) },
      ],
      measurement(normalized(unrounded), "kg"),
      rule.source_ref_ids,
    ),
  ];
  if (rule.rounding.mode !== "none") {
    calculationTrace.push(
      traceStep(
        "cargo:volumetric:round",
        "apply explicit dimensional rounding",
        [{ name: "unrounded", value: measurement(normalized(unrounded), "kg") }],
        measurement(resultText, "kg"),
        rule.source_ref_ids,
        `${rule.rounding.mode}:${rule.rounding.decimals}`,
      ),
    );
  }
  return {
    ok: true,
    volumetric_weight: { value: resultText, unit: "kg" },
    calculation_trace: calculationTrace,
    source_ref_ids: [...rule.source_ref_ids],
  };
}

function supplierWeight(
  supplierRule: SupplierChargeableRule | undefined,
  actual: DecimalValue,
  volumetric: DecimalValue,
  bubble: DecimalValue,
  customerRatio: DecimalValue,
): DecimalValue {
  const maximum = actual.gte(volumetric) ? actual : volumetric;
  if (supplierRule === undefined || supplierRule.method === "max") {
    return maximum;
  }
  if (supplierRule.method === "actual") {
    return actual;
  }
  if (supplierRule.method === "volumetric") {
    return volumetric;
  }
  const ratio = supplierRule.ratio === undefined
    ? customerRatio
    : decimalFromString(supplierRule.ratio);
  return actual.add(bubble.mul(ratio));
}

export function calculateChargeableWeight(
  input: unknown,
): ChargeableWeightResult {
  const validated = validateChargeableInput(input);
  if (isFailure(validated)) {
    return validated;
  }
  const actual = decimalFromString(validated.actual);
  const volumetric = decimalFromString(validated.volumetric);
  const bubble = volumetric.gt(actual)
    ? volumetric.sub(actual)
    : decimalFromString("0");
  const maximum = actual.gte(volumetric) ? actual : volumetric;
  let customerRatio: DecimalValue;
  let customer: DecimalValue;
  switch (validated.method) {
    case "none":
      customerRatio = decimalFromString("0");
      customer = maximum;
      break;
    case "full":
    case "fixed_density":
      customerRatio = decimalFromString("1");
      customer = maximum;
      break;
    case "half":
      customerRatio = decimalFromString("0.5");
      customer = actual.add(bubble.mul(customerRatio));
      break;
    case "ratio":
      customerRatio = decimalFromString(validated.ratio!);
      customer = actual.add(bubble.mul(customerRatio));
      break;
  }
  const supplier = supplierWeight(
    validated.supplierRule,
    actual,
    volumetric,
    bubble,
    customerRatio,
  );
  const sourceRefIds = [...validated.sourceRefIds];
  const actualText = normalized(actual);
  const volumetricText = normalized(volumetric);
  const bubbleText = normalized(bubble);
  const customerText = normalized(customer);
  const supplierText = normalized(supplier);
  const ratioText = normalized(customerRatio);
  const calculationTrace: CalculationStep[] = [
    traceStep(
      "cargo:chargeable:bubble",
      "max volumetric weight minus actual weight and zero",
      [
        { name: "volumetric_weight", value: measurement(volumetricText, "kg") },
        { name: "actual_weight", value: measurement(actualText, "kg") },
      ],
      measurement(bubbleText, "kg"),
      sourceRefIds,
    ),
    traceStep(
      "cargo:chargeable:customer",
      `apply ${validated.method} bubble-share method`,
      [
        { name: "actual_weight", value: measurement(actualText, "kg") },
        { name: "bubble_weight", value: measurement(bubbleText, "kg") },
        { name: "bubble_share_ratio", value: ratioText },
      ],
      measurement(customerText, "kg"),
      sourceRefIds,
    ),
    traceStep(
      "cargo:chargeable:supplier",
      "apply supplier chargeable rule",
      [
        { name: "actual_weight", value: measurement(actualText, "kg") },
        { name: "volumetric_weight", value: measurement(volumetricText, "kg") },
      ],
      measurement(supplierText, "kg"),
      sourceRefIds,
    ),
  ];
  return {
    ok: true,
    version: "chargeable-weight@2026-08-11.v1",
    actual_weight: { value: actualText, unit: "kg" },
    volumetric_weight: { value: volumetricText, unit: "kg" },
    bubble_weight: { value: bubbleText, unit: "kg" },
    customer_chargeable_weight: { value: customerText, unit: "kg" },
    supplier_chargeable_weight: { value: supplierText, unit: "kg" },
    bubble_share_ratio: ratioText,
    method: validated.method,
    rule_version: validated.ruleVersion,
    source_ref_ids: sourceRefIds,
    calculation_trace: calculationTrace,
  };
}

export { validateDimensionalRule };
