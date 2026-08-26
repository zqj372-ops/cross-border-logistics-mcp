export const FREIGHT_CLASS_RULE_VERSION = "nmfta-fcdc-full-density-scale@2025-07-19";

const WEIGHT_TO_LB = Object.freeze({
  lb: [1n, 1n],
  kg: [220462262185n, 100000000000n],
  g: [220462262185n, 100000000000000n],
  oz: [1n, 16n],
});

const LENGTH_TO_IN = Object.freeze({
  in: [1n, 1n],
  cm: [100n, 254n],
  mm: [10n, 254n],
  m: [100000n, 254n],
  ft: [12n, 1n],
});

const DENSITY_CLASSES = Object.freeze([
  ["1", "400"],
  ["2", "300"],
  ["4", "250"],
  ["6", "175"],
  ["8", "125"],
  ["10", "100"],
  ["12", "92.5"],
  ["15", "85"],
  ["22.5", "70"],
  ["30", "65"],
  ["35", "60"],
  ["50", "55"],
]);

function decimalFraction(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  if (numerator <= 0n) return null;
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

function convertedFraction(value, factors) {
  const parsed = decimalFraction(value);
  if (parsed === null || factors === undefined) return null;
  return {
    numerator: parsed.numerator * factors[0],
    denominator: parsed.denominator * factors[1],
  };
}

function isLessThan(value, threshold) {
  const parsedThreshold = decimalFraction(threshold);
  if (parsedThreshold === null) return false;
  return value.numerator * parsedThreshold.denominator
    < parsedThreshold.numerator * value.denominator;
}

function formatFraction(value, places) {
  const scale = 10n ** BigInt(places);
  const rounded = (value.numerator * scale * 2n + value.denominator)
    / (value.denominator * 2n);
  const whole = rounded / scale;
  const fraction = String(rounded % scale).padStart(places, "0");
  return places === 0 ? String(whole) : `${whole}.${fraction}`;
}

function classForDensity(density) {
  for (const [upperBound, freightClass] of DENSITY_CLASSES) {
    if (isLessThan(density, upperBound)) return freightClass;
  }
  return "50";
}

export function suggestFreightClass(values) {
  const weight = convertedFraction(values?.weightValue, WEIGHT_TO_LB[values?.weightUnit]);
  const length = convertedFraction(values?.length, LENGTH_TO_IN[values?.dimensionUnit]);
  const width = convertedFraction(values?.width, LENGTH_TO_IN[values?.dimensionUnit]);
  const height = convertedFraction(values?.height, LENGTH_TO_IN[values?.dimensionUnit]);
  if (weight === null || length === null || width === null || height === null) return null;

  const density = {
    numerator: weight.numerator * 1728n
      * length.denominator * width.denominator * height.denominator,
    denominator: weight.denominator
      * length.numerator * width.numerator * height.numerator,
  };
  return {
    densityPcf: formatFraction(density, 2),
    suggestedClass: classForDensity(density),
    ruleVersion: FREIGHT_CLASS_RULE_VERSION,
  };
}
