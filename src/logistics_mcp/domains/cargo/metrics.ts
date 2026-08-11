import type { CalculationStep, TraceValue } from "../../platform/envelope";
import {
  decimalFromInteger,
  decimalFromString,
  formatVolume,
  formatWeight,
} from "./decimal";
import {
  cargoDiagnostic,
  type CargoValidationFailure,
} from "./diagnostics";
import {
  validateCargoLine,
  type CargoLine,
  type CargoMetrics,
  type CargoLineValidation,
  type DimensionSet,
  type WeightMeasurement,
} from "./models";
import {
  lengthToCentimeters,
  volumeToCbm,
  weightToKilograms,
} from "./units";

export type CargoMetricsDraft = Omit<CargoMetrics, "volumetric_weight">;

export interface CargoMetricsSuccess {
  readonly ok: true;
  readonly metrics: CargoMetricsDraft;
  readonly calculation_trace: readonly CalculationStep[];
  readonly source_ref_ids: readonly string[];
}

export type CargoMetricsResult = CargoMetricsSuccess | CargoValidationFailure;

const METRICS_VERSION = "cargo-metrics@2026-08-11.v1";
const CM3_PER_CBM = "1000000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailure(value: unknown): value is CargoValidationFailure {
  return isRecord(value) && value.ok === false;
}

function measurement(value: string, unit: string): TraceValue {
  return { value, unit };
}

function step(
  stepId: string,
  operation: string,
  inputs: readonly { name: string; value: TraceValue }[],
  result: TraceValue,
  sourceRefIds: readonly string[],
): CalculationStep {
  return {
    step_id: stepId,
    operation,
    inputs,
    result,
    source_ref_ids: [...new Set(sourceRefIds)],
  };
}

function lineFailure(
  failure: CargoValidationFailure,
  lineIndex: number,
): CargoValidationFailure {
  const field = failure.diagnostic.field;
  return cargoDiagnostic(
    failure.code,
    failure.status,
    failure.diagnostic.message,
    field === undefined ? `cargo_lines[${lineIndex}]` : `cargo_lines[${lineIndex}].${field}`,
  );
}

function canonicalLineWeight(
  line: CargoLine,
  lineIndex: number,
):
  | {
      readonly mode: "unit_weight" | "piece_weights" | "line_total_weight";
      readonly value: ReturnType<typeof decimalFromString>;
      readonly scaleHint: number;
      readonly trace: readonly CalculationStep[];
    }
  | CargoValidationFailure {
  const sourceRefIds = line.source_ref_ids;
  if (line.unit_weight !== undefined) {
    const converted = weightToKilograms(line.unit_weight.value, line.unit_weight.unit);
    const convertedValue = formatWeight(converted.value, converted.scaleHint);
    const conversionStep = step(
      `cargo:line:${lineIndex}:weight:convert`,
      "convert unit weight to kilograms",
      [{ name: "source_weight", value: measurement(line.unit_weight.value, line.unit_weight.unit) }],
      measurement(convertedValue, "kg"),
      sourceRefIds,
    );
    const total = converted.value.mul(decimalFromInteger(line.quantity));
    const totalScale = Math.max(converted.scaleHint, 0);
    const totalStep = step(
      `cargo:line:${lineIndex}:weight:total`,
      "multiply unit weight by quantity",
      [
        { name: "unit_weight", value: measurement(convertedValue, "kg") },
        { name: "quantity", value: line.quantity },
      ],
      measurement(formatWeight(total, totalScale), "kg"),
      sourceRefIds,
    );
    return {
      mode: "unit_weight",
      value: total,
      scaleHint: totalScale,
      trace: [conversionStep, totalStep],
    };
  }

  if (line.piece_weights !== undefined) {
    let total = decimalFromString("0");
    let scaleHint = 0;
    const trace: CalculationStep[] = [];
    for (const [pieceIndex, pieceWeight] of line.piece_weights.entries()) {
      const converted = weightToKilograms(pieceWeight.value, pieceWeight.unit);
      total = total.add(converted.value);
      scaleHint = Math.max(scaleHint, converted.scaleHint);
      trace.push(
        step(
          `cargo:line:${lineIndex}:piece:${pieceIndex}:weight:convert`,
          "convert piece weight to kilograms",
          [{ name: "source_weight", value: measurement(pieceWeight.value, pieceWeight.unit) }],
          measurement(formatWeight(converted.value, converted.scaleHint), "kg"),
          sourceRefIds,
        ),
      );
    }
    trace.push(
      step(
        `cargo:line:${lineIndex}:weight:pieces-total`,
        "sum piece weights",
        [{ name: "piece_count", value: line.piece_weights.length }],
        measurement(formatWeight(total, scaleHint), "kg"),
        sourceRefIds,
      ),
    );
    return {
      mode: "piece_weights",
      value: total,
      scaleHint,
      trace,
    };
  }

  if (line.line_total_weight !== undefined) {
    const converted = weightToKilograms(
      line.line_total_weight.value,
      line.line_total_weight.unit,
    );
    const convertedValue = formatWeight(converted.value, converted.scaleHint);
    return {
      mode: "line_total_weight",
      value: converted.value,
      scaleHint: converted.scaleHint,
      trace: [
        step(
          `cargo:line:${lineIndex}:weight:line-total`,
          "convert line total weight to kilograms",
          [{ name: "source_weight", value: measurement(line.line_total_weight.value, line.line_total_weight.unit) }],
          measurement(convertedValue, "kg"),
          sourceRefIds,
        ),
      ],
    };
  }

  return cargoDiagnostic(
    "cargo.weight_evidence_missing",
    "needs_input",
    "Provide exactly one weight evidence mode for this CargoLine.",
    `cargo_lines[${lineIndex}].weight`,
  );
}

function dimensionsQuantity(dimensions: readonly DimensionSet[]): ReturnType<typeof decimalFromString> {
  let total = decimalFromString("0");
  for (const dimension of dimensions) {
    total = total.add(decimalFromInteger(dimension.quantity));
  }
  return total;
}

function dimensionVolume(
  line: CargoLine,
  lineIndex: number,
):
  | {
      readonly value: ReturnType<typeof decimalFromString>;
      readonly trace: readonly CalculationStep[];
    }
  | CargoValidationFailure {
  if (line.dimensions === undefined) {
    return cargoDiagnostic(
      "cargo.volume_missing",
      "needs_input",
      "Provide volume or dimensions for this CargoLine.",
      `cargo_lines[${lineIndex}].volume`,
    );
  }
  if (!dimensionsQuantity(line.dimensions).eq(decimalFromInteger(line.quantity))) {
    return cargoDiagnostic(
      "cargo.dimension_quantity_mismatch",
      "manual_review",
      "Dimension quantities must equal the CargoLine quantity.",
      `cargo_lines[${lineIndex}].dimensions`,
    );
  }

  let total = decimalFromString("0");
  const trace: CalculationStep[] = [];
  for (const [dimensionIndex, dimension] of line.dimensions.entries()) {
    const length = lengthToCentimeters(dimension.length.value, dimension.length.unit);
    const width = lengthToCentimeters(dimension.width.value, dimension.width.unit);
    const height = lengthToCentimeters(dimension.height.value, dimension.height.unit);
    trace.push(
      step(
        `cargo:line:${lineIndex}:dimension:${dimensionIndex}:convert`,
        "convert dimensions to centimeters",
        [
          { name: "length", value: measurement(dimension.length.value, dimension.length.unit) },
          { name: "width", value: measurement(dimension.width.value, dimension.width.unit) },
          { name: "height", value: measurement(dimension.height.value, dimension.height.unit) },
        ],
        `${length.toString()}x${width.toString()}x${height.toString()} cm`,
        line.source_ref_ids,
      ),
    );
    const groupVolume = length
      .mul(width)
      .mul(height)
      .mul(decimalFromInteger(dimension.quantity))
      .div(decimalFromString(CM3_PER_CBM));
    total = total.add(groupVolume);
    trace.push(
      step(
        `cargo:line:${lineIndex}:dimension:${dimensionIndex}:volume`,
        "multiply length width height and quantity to CBM",
        [
          { name: "length", value: measurement(length.toString(), "cm") },
          { name: "width", value: measurement(width.toString(), "cm") },
          { name: "height", value: measurement(height.toString(), "cm") },
          { name: "quantity", value: dimension.quantity },
        ],
        measurement(formatVolume(groupVolume), "cbm"),
        line.source_ref_ids,
      ),
    );
  }
  return { value: total, trace };
}

function lineVolume(
  line: CargoLine,
  lineIndex: number,
):
  | { readonly value: ReturnType<typeof decimalFromString>; readonly trace: readonly CalculationStep[] }
  | CargoValidationFailure {
  const derived = line.dimensions === undefined
    ? null
    : dimensionVolume(line, lineIndex);
  if (derived !== null && isFailure(derived)) {
    return derived;
  }
  const direct = line.volume === undefined
    ? null
    : volumeToCbm(line.volume.value, line.volume.unit);
  if (direct !== null && derived !== null && direct.eq(derived.value)) {
    return {
      value: direct,
      trace: [
        ...derived.trace,
        step(
          `cargo:line:${lineIndex}:volume:direct`,
          "convert direct volume to CBM",
          [{ name: "source_volume", value: measurement(line.volume!.value, line.volume!.unit) }],
          measurement(formatVolume(direct), "cbm"),
          line.source_ref_ids,
        ),
      ],
    };
  }
  if (direct !== null && derived !== null && !direct.eq(derived.value)) {
    return cargoDiagnostic(
      "cargo.volume_conflict",
      "manual_review",
      "Direct volume conflicts with dimension-derived volume.",
      `cargo_lines[${lineIndex}].volume`,
    );
  }
  if (direct !== null) {
    return {
      value: direct,
      trace: [
        step(
          `cargo:line:${lineIndex}:volume:direct`,
          "convert direct volume to CBM",
          [{ name: "source_volume", value: measurement(line.volume!.value, line.volume!.unit) }],
          measurement(formatVolume(direct), "cbm"),
          line.source_ref_ids,
        ),
      ],
    };
  }
  if (derived !== null) {
    return derived;
  }
  return cargoDiagnostic(
    "cargo.volume_missing",
    "needs_input",
    "Provide volume or dimensions for this CargoLine.",
    `cargo_lines[${lineIndex}].volume`,
  );
}

function validatedLines(input: unknown):
  | readonly CargoLine[]
  | CargoValidationFailure {
  if (!Array.isArray(input) || input.length === 0) {
    return cargoDiagnostic(
      "cargo.lines_required",
      "needs_input",
      "At least one CargoLine is required.",
      "cargo_lines",
    );
  }
  const lines: CargoLine[] = [];
  for (const [index, candidate] of input.entries()) {
    const result: CargoLineValidation = validateCargoLine(candidate);
    if (result.ok === false) {
      return lineFailure(result, index);
    }
    lines.push(result.value);
  }
  if (new Set(lines.map((line) => line.line_id)).size !== lines.length) {
    return cargoDiagnostic(
      "cargo.line_id_duplicate",
      "manual_review",
      "CargoLine line_id values must be unique.",
      "cargo_lines",
    );
  }
  return lines;
}

export function calculateCargoMetrics(input: unknown): CargoMetricsResult {
  const linesResult = validatedLines(input);
  if (isFailure(linesResult)) {
    return linesResult;
  }
  const lines = linesResult;
  let totalVolume = decimalFromString("0");
  let totalActualWeight = decimalFromString("0");
  let totalQuantity = decimalFromString("0");
  let weightScaleHint = 0;
  let evidenceMode: CargoMetricsDraft["weight_evidence"] | null = null;
  const calculationTrace: CalculationStep[] = [];
  const sourceRefIds = new Set<string>();

  for (const [lineIndex, line] of lines.entries()) {
    for (const sourceRefId of line.source_ref_ids) {
      sourceRefIds.add(sourceRefId);
    }
    const volumeResult = lineVolume(line, lineIndex);
    if (isFailure(volumeResult)) {
      return volumeResult;
    }
    totalVolume = totalVolume.add(volumeResult.value);
    calculationTrace.push(...volumeResult.trace);

    const weightResult = canonicalLineWeight(line, lineIndex);
    if (isFailure(weightResult)) {
      return weightResult;
    }
    if (evidenceMode === null) {
      evidenceMode = weightResult.mode;
    } else if (evidenceMode !== weightResult.mode) {
      return cargoDiagnostic(
        "cargo.weight_evidence_modes_mixed",
        "manual_review",
        "A multi-line calculation must use one consistent weight evidence mode.",
        "cargo_lines",
      );
    }
    totalActualWeight = totalActualWeight.add(weightResult.value);
    weightScaleHint = Math.max(weightScaleHint, weightResult.scaleHint);
    totalQuantity = totalQuantity.add(decimalFromInteger(line.quantity));
    calculationTrace.push(...weightResult.trace);
  }

  if (totalQuantity.gt(decimalFromInteger(Number.MAX_SAFE_INTEGER))) {
    return cargoDiagnostic(
      "cargo.total_quantity_invalid",
      "manual_review",
      "The aggregate quantity exceeds the safe integer boundary of the output contract.",
      "cargo_lines",
    );
  }

  calculationTrace.push(
    step(
      "cargo:metrics:volume-total",
      "sum line volumes",
      [{ name: "line_count", value: lines.length }],
      measurement(formatVolume(totalVolume), "cbm"),
      [...sourceRefIds],
    ),
    step(
      "cargo:metrics:actual-weight-total",
      "sum line actual weights",
      [{ name: "line_count", value: lines.length }],
      measurement(formatWeight(totalActualWeight, weightScaleHint), "kg"),
      [...sourceRefIds],
    ),
  );

  const metrics: CargoMetricsDraft = {
    version: METRICS_VERSION,
    line_count: lines.length,
    total_quantity: Number(totalQuantity.toString()),
    total_volume: { value: formatVolume(totalVolume), unit: "cbm" },
    actual_weight: {
      value: formatWeight(totalActualWeight, weightScaleHint),
      unit: "kg",
    },
    weight_evidence: evidenceMode ?? "missing",
    derived_from_line_ids: lines.map((line) => line.line_id),
  };

  return {
    ok: true,
    metrics,
    calculation_trace: calculationTrace,
    source_ref_ids: [...sourceRefIds],
  };
}

export type { WeightMeasurement };
