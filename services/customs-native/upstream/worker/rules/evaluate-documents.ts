import type { z } from "zod";
import type { DocumentItemSchema, DocumentStatusSchema } from "../../shared/contracts/query";
import type { RequirementRow } from "../repositories/customs";

export interface EvaluateDocumentsOptions {
  readonly side: RequirementRow["side"];
  readonly attributes: Record<string, string | number | boolean>;
  readonly sourceIdForRow?: (row: RequirementRow) => string;
}

type ConditionResult = "match" | "not_match" | "unknown";
type DocumentItem = z.infer<typeof DocumentItemSchema>;
type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceIdForRow(row: RequirementRow): string {
  return `source:${row.release_id}:${row.artifact_id}:${row.source_locator}`;
}

function displayCondition(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Unserializable condition";
  }
}

function parseConditions(value: unknown): { raw: unknown; display: string[]; valid: boolean } {
  if (value === undefined || value === null || value === "") return { raw: [], display: [], valid: true };
  if (Array.isArray(value)) {
    const valid = value.every((item) => typeof item === "string" || (typeof item === "object" && item !== null));
    return { raw: value, display: value.map(displayCondition), valid };
  }
  if (typeof value !== "string") return { raw: value, display: [displayCondition(value)], valid: false };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) && (typeof parsed !== "object" || parsed === null)) {
      return { raw: parsed, display: [displayCondition(parsed)], valid: false };
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const valid = list.every((item) => typeof item === "string" || (typeof item === "object" && item !== null));
    return { raw: parsed, display: list.map(displayCondition), valid };
  } catch {
    return { raw: value, display: [value], valid: false };
  }
}

function compare(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.trim().toLocaleLowerCase("en-US") === expected.trim().toLocaleLowerCase("en-US");
  }
  return actual === expected;
}

function evaluateOne(condition: unknown, attributes: Record<string, string | number | boolean>): ConditionResult {
  if (typeof condition === "string") return "unknown";
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) return "unknown";
  const record = condition as Record<string, unknown>;
  if (Array.isArray(record.all)) {
    const values = record.all.map((item) => evaluateOne(item, attributes));
    if (values.includes("unknown")) return "unknown";
    return values.every((value) => value === "match") ? "match" : "not_match";
  }
  if (Array.isArray(record.any)) {
    const values = record.any.map((item) => evaluateOne(item, attributes));
    if (values.includes("match")) return "match";
    return values.includes("unknown") ? "unknown" : "not_match";
  }
  const attribute = typeof record.attribute === "string" ? record.attribute : undefined;
  if (!attribute || !(attribute in attributes)) return "unknown";
  const actual = attributes[attribute];
  if ("equals" in record) return compare(actual, record.equals) ? "match" : "not_match";
  if ("in" in record && Array.isArray(record.in)) return record.in.some((item) => compare(actual, item)) ? "match" : "not_match";
  if ("notEquals" in record) return compare(actual, record.notEquals) ? "not_match" : "match";
  if (record.isTrue === true) return actual === true ? "match" : "not_match";
  if (record.isFalse === true) return actual === false ? "match" : "not_match";
  return "unknown";
}

function evaluateConditions(raw: unknown, attributes: Record<string, string | number | boolean>): ConditionResult {
  const parsed = parseConditions(raw);
  if (!parsed.valid) return "unknown";
  const conditions = Array.isArray(parsed.raw) ? parsed.raw : [parsed.raw];
  if (conditions.length === 0 || (conditions.length === 1 && conditions[0] === undefined)) return "match";
  const values = conditions.map((condition) => evaluateOne(condition, attributes));
  if (values.includes("unknown")) return "unknown";
  return values.every((value) => value === "match") ? "match" : "not_match";
}

function status(value: unknown): DocumentStatus {
  return value === "prepare_retain" || value === "required_now" || value === "conditional" || value === "on_request" || value === "not_applicable" || value === "manual_review"
    ? value
    : "manual_review";
}

/** Evaluate one side of the transaction; sides are never merged. */
export function evaluateDocuments(
  rows: readonly RequirementRow[],
  options: EvaluateDocumentsOptions,
): DocumentItem[] {
  return rows
    .filter((row) => row.side === options.side)
    .map((row) => {
      const parsed = parseConditions(row.conditions_json);
      const conditionResult = evaluateConditions(row.conditions_json, options.attributes);
      let documentStatus = status(row.document_status);
      let reason = text(row.reason) || "Review the applicable official requirement.";

      if (!parsed.valid || conditionResult === "unknown") {
        if (parsed.valid && documentStatus === "conditional") {
          // A reviewed conditional rule remains conditional while the caller
          // has not supplied the product attribute it names.  An unparseable
          // rule is a separate data-quality failure and must be manual review.
          reason = "Provide the required product attributes to evaluate this conditional document rule.";
        } else {
          documentStatus = "manual_review";
          reason = "Document conditions are not an explicit, evaluable JSON rule; manual review required.";
        }
      } else if (conditionResult === "not_match") {
        documentStatus = "not_applicable";
        reason = "The supplied product attributes do not match this document rule.";
      }

      return {
        id: row.id,
        label: text(row.label) || "Regulatory document",
        side: row.side,
        status: documentStatus,
        conditions: parsed.display,
        reason,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        sourceId: options.sourceIdForRow?.(row) ?? sourceIdForRow(row),
      } satisfies DocumentItem;
    });
}

export function groupDocumentsBySide(rows: readonly RequirementRow[], attributes: Record<string, string | number | boolean>): Record<RequirementRow["side"], DocumentItem[]> {
  return {
    cn_export: evaluateDocuments(rows, { side: "cn_export", attributes }),
    us_import: evaluateDocuments(rows, { side: "us_import", attributes }),
    ca_import: evaluateDocuments(rows, { side: "ca_import", attributes }),
  };
}
