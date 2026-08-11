import {
  decimalFromString,
  decimalPlaces,
  formatWeight,
  type DecimalValue,
} from "./decimal";
import type {
  LengthUnit,
  VolumeUnit,
  WeightUnit,
} from "./models";

export class UnsupportedCargoUnitError extends Error {
  readonly code = "cargo.unit_invalid";

  constructor(unit: string) {
    super(`Unsupported cargo unit: ${unit}.`);
    this.name = "UnsupportedCargoUnitError";
  }
}

const LENGTH_TO_CM: Record<LengthUnit, string> = {
  mm: "0.1",
  cm: "1",
  m: "100",
};

const WEIGHT_TO_KG: Record<WeightUnit, string> = {
  g: "0.001",
  kg: "1",
  lb: "0.45359237",
};

const VOLUME_TO_CBM: Record<VolumeUnit, string> = {
  l: "0.001",
  cbm: "1",
  m3: "1",
};

function factor<Unit extends string>(
  factors: Readonly<Record<Unit, string>>,
  unit: Unit,
): DecimalValue {
  const value = factors[unit];
  if (value === undefined) {
    throw new UnsupportedCargoUnitError(unit);
  }
  return decimalFromString(value);
}

export function lengthToCentimeters(
  value: string,
  unit: LengthUnit,
): DecimalValue {
  return decimalFromString(value).mul(factor(LENGTH_TO_CM, unit));
}

export interface CanonicalWeight {
  readonly value: DecimalValue;
  readonly scaleHint: number;
}

export function weightToKilograms(
  value: string,
  unit: WeightUnit,
): CanonicalWeight {
  const converted = decimalFromString(value).mul(factor(WEIGHT_TO_KG, unit));
  return {
    value: converted,
    scaleHint: unit === "kg" ? decimalPlaces(value) : 6,
  };
}

export function volumeToCbm(value: string, unit: VolumeUnit): DecimalValue {
  return decimalFromString(value).mul(factor(VOLUME_TO_CBM, unit));
}

export function formatCanonicalWeight(
  value: CanonicalWeight,
): string {
  return formatWeight(value.value, value.scaleHint);
}
