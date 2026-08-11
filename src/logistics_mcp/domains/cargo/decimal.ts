import Decimal from "decimal.js";

Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

export function decimalFromString(value: string): Decimal {
  return new Decimal(value);
}

export function decimalFromInteger(value: number): Decimal {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Cargo integer operands must be safe integers.");
  }
  return new Decimal(value.toString());
}

export function decimalPlaces(value: string): number {
  const separator = value.indexOf(".");
  return separator === -1 ? 0 : value.length - separator - 1;
}

export function formatFixed(value: Decimal, scale: number): string {
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new RangeError("Decimal scale must be a non-negative safe integer.");
  }
  return value.toFixed(scale);
}

export function formatWeight(value: Decimal, scaleHint = 0): string {
  return formatFixed(value, Math.max(0, Math.min(12, scaleHint)));
}

export function formatVolume(value: Decimal): string {
  return formatFixed(value, 6);
}

export type DecimalValue = Decimal;
