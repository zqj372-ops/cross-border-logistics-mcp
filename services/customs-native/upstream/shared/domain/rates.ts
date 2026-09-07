import Decimal from "decimal.js";

/** Values are kept as strings at the boundary so a tariff parser never has to
 * round a published decimal through a JavaScript number first. */
export type DecimalInput = string;

export type RateKind = "free" | "ad_valorem" | "specific" | "compound" | "text";

export type RateCategory =
  | "export_duty"
  | "provisional_export_duty"
  | "base_duty"
  | "additional_duty"
  | "trade_remedy"
  | "tax"
  | "fee"
  | (string & {});

export type CountryCode = "CN" | "US" | "CA";

/**
 * Interaction metadata is deliberately open-ended. Different official
 * schedules use different names for stacking, exclusion, and replacement;
 * the worker evaluator interprets the known fields and preserves the raw
 * object for audit/read-back.
 */
export interface RateInteractionMetadata {
  readonly [key: string]: unknown;
  readonly reviewed?: boolean;
  readonly additive?: boolean;
  readonly stackingGroup?: string;
  readonly stackWith?: readonly string[];
  readonly nonStacking?: boolean;
  readonly nonStackingWith?: readonly string[];
  readonly excludes?: readonly string[];
  readonly excludedBy?: readonly string[];
  readonly replaces?: readonly string[];
  readonly replaceGroup?: string;
}

export interface RateRuleFields {
  readonly id: string;
  readonly category: RateCategory;
  readonly confirmed: boolean;
  /** Raw expression from the source, never replaced by a calculated value. */
  readonly rateExpressionRaw: string;
  readonly treatment?: string;
  readonly country?: CountryCode;
  readonly originCountry?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly priority?: number;
  readonly interaction?: RateInteractionMetadata | string;
  readonly interactionNote?: string;
  readonly conditions?: readonly string[] | string;
  readonly conditionText?: string;
  readonly sourceId?: string;
  /** All percentage lines included in a total must explicitly share this basis. */
  readonly valueBasis?: string;
  /** D1/parser aliases retained for source read-back. */
  readonly rate_expression_raw?: string;
  readonly conditions_json?: string;
  readonly interaction_json?: string;
}

export interface FreeRateComponent {
  readonly kind: "free";
  readonly rateExpressionRaw: string;
}

export interface AdValoremRateComponent {
  readonly kind: "ad_valorem";
  readonly percent: DecimalInput;
  readonly rateExpressionRaw: string;
}

export interface SpecificRateComponent {
  readonly kind: "specific";
  readonly amount: DecimalInput;
  readonly currency?: string;
  readonly unit?: string;
  readonly rateExpressionRaw: string;
}

export interface CompoundRateComponent {
  readonly kind: "compound";
  readonly components: readonly RateComponent[];
  readonly rateExpressionRaw: string;
}

export interface TextRateComponent {
  readonly kind: "text";
  readonly text: string;
  readonly rateExpressionRaw: string;
}

export type RateComponent =
  | FreeRateComponent
  | AdValoremRateComponent
  | SpecificRateComponent
  | CompoundRateComponent
  | TextRateComponent;

export type FreeRateLine = RateRuleFields & FreeRateComponent;
export type AdValoremRateLine = RateRuleFields & AdValoremRateComponent;
export type SpecificRateLine = RateRuleFields & SpecificRateComponent;
export type CompoundRateLine = RateRuleFields & CompoundRateComponent;
export type TextRateLine = RateRuleFields & TextRateComponent;

export type RateLine = FreeRateLine | AdValoremRateLine | SpecificRateLine | CompoundRateLine | TextRateLine;

/**
 * Inbound records may omit rateExpressionRaw in small/UI-created examples.
 * Production records should always provide it; the evaluator derives a
 * display fallback only for diagnostics and never treats a missing percent as
 * zero.
 */
export type RateComponentInput =
  | (Omit<FreeRateComponent, "rateExpressionRaw"> & { readonly rateExpressionRaw?: string })
  | (Omit<AdValoremRateComponent, "rateExpressionRaw"> & { readonly rateExpressionRaw?: string })
  | (Omit<SpecificRateComponent, "rateExpressionRaw"> & { readonly rateExpressionRaw?: string })
  | (Omit<CompoundRateComponent, "rateExpressionRaw" | "components"> & {
      readonly rateExpressionRaw?: string;
      readonly components: readonly RateComponentInput[];
    })
  | (Omit<TextRateComponent, "rateExpressionRaw"> & { readonly rateExpressionRaw?: string });

export type RateLineInput =
  | (Omit<FreeRateLine, "rateExpressionRaw"> & { readonly rateExpressionRaw?: string })
  | (Omit<AdValoremRateLine, "rateExpressionRaw"> & { readonly rateExpressionRaw?: string })
  | (Omit<SpecificRateLine, "rateExpressionRaw"> & { readonly rateExpressionRaw?: string })
  | (Omit<CompoundRateLine, "rateExpressionRaw" | "components"> & {
      readonly rateExpressionRaw?: string;
      readonly components: readonly RateComponentInput[];
    })
  | (Omit<TextRateLine, "rateExpressionRaw"> & { readonly rateExpressionRaw?: string });

/** A permissive input shape for records read from JSON or a D1 row. */
export type RateInput = RateLineInput & Readonly<Record<string, unknown>>;

export type RateEvaluationStatus = "confirmed" | "manual_review";
export type RateLineStatus = "included" | "excluded" | "manual_review";

export type EvaluatedRateLine = Omit<RateLineInput, "rateExpressionRaw"> & {
  readonly rateExpressionRaw: string;
  readonly includedInConfirmedTotal: boolean;
  readonly selected: boolean;
  readonly status: RateLineStatus;
  readonly reason: string;
  readonly interactionNote: string;
};

export interface RateEvaluationResult {
  readonly status: RateEvaluationStatus;
  readonly conflict: boolean;
  readonly confirmedTotalPercent: string | null;
  readonly lines: readonly EvaluatedRateLine[];
  readonly reasons: readonly string[];
  readonly interactionNotes: readonly string[];
}

/**
 * Add decimal percentage strings without ever routing the arithmetic through
 * IEEE-754 floating point. Invalid values are rejected so callers can put the
 * result into manual review instead of displaying a fabricated total.
 */
export function sumConfirmedPercent(values: readonly DecimalInput[]): string {
  const exact = Decimal.clone({ precision: 100 });
  let total = new exact(0);

  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) {
      throw new Error(`Invalid percentage value: ${String(value)}`);
    }
    try {
      total = total.plus(new exact(value));
    } catch {
      throw new Error(`Invalid percentage value: ${String(value)}`);
    }
  }

  // Calling toFixed() with no decimal-place argument keeps the exact decimal
  // form and avoids Decimal.js switching to exponential notation for a small
  // percentage. Trim only presentation zeros; no source expression is changed.
  const fixed = total.toFixed();
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/(\.[0-9]*?)0+$/u, "$1").replace(/\.$/u, "");
}
