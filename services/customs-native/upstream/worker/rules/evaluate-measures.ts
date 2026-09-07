import { normalizeCode } from "../../shared/domain/code";
import type { z } from "zod";
import type { TradeMeasureSchema } from "../../shared/contracts/query";
import type { TradeMeasureRow } from "../repositories/customs";

export interface EvaluateMeasuresOptions {
  readonly code: string;
  readonly originCountry?: string;
  readonly exporterOrProducer?: string;
  readonly sourceIdForRow?: (row: TradeMeasureRow) => string;
}

type TradeMeasure = z.infer<typeof TradeMeasureSchema>;
type MeasureStatus = TradeMeasure["matchStatus"];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceIdForRow(row: TradeMeasureRow): string {
  return `source:${row.release_id}:${row.artifact_id}:${row.source_locator}`;
}

function parseExceptions(value: unknown): { values: string[]; valid: boolean } {
  if (value === undefined || value === null || value === "") return { values: [], valid: true };
  if (Array.isArray(value)) {
    const values = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return { values, valid: values.length === value.length };
  }
  if (typeof value !== "string") return { values: [], valid: false };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return { values: [], valid: false };
    const values = parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return { values, valid: values.length === parsed.length };
  } catch {
    return { values: [], valid: false };
  }
}

function originMatches(row: TradeMeasureRow, originCountry: string | undefined): boolean {
  if (!originCountry) return true;
  const rowOrigin = text(row.origin_country).toUpperCase();
  return rowOrigin.length === 0 || rowOrigin === originCountry.trim().toUpperCase() || rowOrigin === "ALL" || rowOrigin === "*";
}

function identityMatches(row: TradeMeasureRow, identity: string | undefined): boolean {
  const required = text(row.exporter_or_producer);
  if (!required) return true;
  return Boolean(identity && identity.trim().toLocaleLowerCase("en-US") === required.toLocaleLowerCase("en-US"));
}

function statusValue(value: unknown): MeasureStatus {
  return value === "not_indicated" || value === "possible" || value === "confirmed_by_rule" || value === "manual_review"
    ? value
    : "manual_review";
}

/**
 * Evaluate already-reviewed trade-measure rows.  A code hint and origin are
 * only matching evidence; an HTS/SIMA hint never upgrades a row to confirmed
 * on its own.  Exporter/producer scope is confirmed only after an exact
 * identity match.
 */
export function evaluateMeasures(
  rows: readonly TradeMeasureRow[],
  options: EvaluateMeasuresOptions,
): TradeMeasure[] {
  const code = normalizeCode(options.code);
  return rows.map((row) => {
    let matchStatus: MeasureStatus = statusValue(row.match_status);
    const codeHint = text(row.code_hint) || null;
    if (codeHint) {
      let normalizedHint: string | null = null;
      try {
        normalizedHint = normalizeCode(codeHint);
      } catch {
        matchStatus = "manual_review";
      }
      if (normalizedHint && normalizedHint !== code) matchStatus = "not_indicated";
    }

    if (matchStatus !== "not_indicated" && !originMatches(row, options.originCountry)) {
      matchStatus = "not_indicated";
    }

    const parsedExceptions = parseExceptions(row.exceptions_json);
    if (!parsedExceptions.valid) matchStatus = "manual_review";

    if (text(row.exporter_or_producer) && !identityMatches(row, options.exporterOrProducer)) {
      matchStatus = "manual_review";
    }

    const measureType = text(row.measure_type).toLocaleLowerCase("en-US");
    const sensitiveHintOnly = ["section_301", "section_232", "additional_tariff", "add_cvd", "sima"].includes(measureType);
    if (sensitiveHintOnly && text(row.code_hint) && matchStatus === "confirmed_by_rule" && !text(row.case_number) && !text(row.exporter_or_producer)) {
      // A code hit is discovery evidence.  It cannot become a confirmed
      // Section 301/232, ADD-CVD, or SIMA result without controlling scope or
      // exporter/case evidence.
      matchStatus = measureType === "sima" ? "manual_review" : "possible";
    }
    if (measureType === "sima" && (!text(row.legal_scope) || !text(row.exporter_or_producer))) {
      matchStatus = "manual_review";
    }

    // Every indication must identify the reviewed legal scope. Keep an empty
    // scope visible, but never let it look like a controlling rule.
    if (matchStatus !== "not_indicated" && text(row.legal_scope).length === 0) {
      matchStatus = "manual_review";
    }

    return {
      id: row.id,
      label: text(row.measure_type) || "Trade measure",
      measureType: text(row.measure_type) || "unspecified",
      originCountry: text(row.origin_country) || "unknown",
      codeHint,
      matchStatus,
      legalScope: text(row.legal_scope) || "Scope is not stated in the reviewed rule.",
      exceptions: parsedExceptions.values,
      caseNumber: text(row.case_number) || null,
      exporterOrProducer: text(row.exporter_or_producer) || null,
      rateExpressionRaw: text(row.rate_expression_raw) || null,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      sourceId: options.sourceIdForRow?.(row) ?? sourceIdForRow(row),
    } satisfies TradeMeasure;
  });
}

/** Only these rows are eligible to be interpreted as numeric duty lines. */
export function numericConfirmedMeasureLines(measures: readonly TradeMeasure[]): TradeMeasure[] {
  return measures.filter((measure) => {
    if (measure.matchStatus !== "confirmed_by_rule" || measure.rateExpressionRaw === null) return false;
    const kind = measure.measureType.trim().toLocaleLowerCase("en-US");
    return !["fee", "tax", "mpf", "hmf", "gst"].includes(kind);
  });
}
