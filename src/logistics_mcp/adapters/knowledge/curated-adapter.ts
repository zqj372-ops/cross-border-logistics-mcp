import type { SourceRef } from "../../platform/envelope";
import type { AdapterResult, KnowledgeAdapter } from "../ports";

export type CuratedKnowledgeStatus = "active" | "archived";

export interface CuratedKnowledgeRecord {
  readonly result_id: string;
  readonly title: string;
  readonly summary: string;
  readonly status: CuratedKnowledgeStatus;
  readonly source_ref: SourceRef;
}

export interface CuratedKnowledgeSource {
  search(input: Record<string, unknown>): Promise<readonly CuratedKnowledgeRecord[] | null>;
}

export interface CuratedKnowledgeAdapterOptions {
  readonly source?: CuratedKnowledgeSource;
}

const ALLOWED_DOCUMENTS = new Set([
  "SOP_QUICK.md",
  "RULES.yaml",
  "QUOTE_TEMPLATE.md",
  "EDGE_CASES.md",
]);

function notice(
  code: string,
  message: string,
  severity: "info" | "warning" | "error" = "error",
  field: string | null = null,
) {
  return { code, message, severity, field } as const;
}

function uniqueSourceRefs(refs: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.source_id)) return false;
    seen.add(ref.source_id);
    return true;
  });
}

export class CuratedKnowledgeAdapter implements KnowledgeAdapter {
  private readonly source: CuratedKnowledgeSource | undefined;

  constructor(options: CuratedKnowledgeAdapterOptions = {}) {
    this.source = options.source;
  }

  async searchCurated(input: Record<string, unknown>): Promise<AdapterResult> {
    if (input.include_archived !== false) {
      return {
        status: "blocked",
        data: null,
        sourceRefs: [],
        blockers: [
          notice(
            "knowledge.archived_forbidden",
            "Only current curated documents may be searched.",
            "error",
            "include_archived",
          ),
        ],
      };
    }
    if (this.source === undefined) {
      return {
        status: "unavailable",
        data: null,
        sourceRefs: [],
        blockers: [
          notice(
            "knowledge.adapter_disabled",
            "The curated knowledge index is disabled until its source and version contract are verified.",
          ),
        ],
        reviewStatus: "manual_review",
      };
    }
    const records = await this.source.search(input);
    if (records === null) {
      return {
        status: "unavailable",
        data: null,
        sourceRefs: [],
        blockers: [
          notice(
            "knowledge.index_unavailable",
            "The curated knowledge index could not be verified.",
          ),
        ],
        reviewStatus: "manual_review",
      };
    }

    const filtered = records.filter(
      (record) =>
        record.status === "active" && ALLOWED_DOCUMENTS.has(record.title),
    );
    const sourceRefs = uniqueSourceRefs(filtered.map((record) => record.source_ref));
    const firstSourceRef = sourceRefs[0];
    if (firstSourceRef === undefined) {
      return {
        status: "unavailable",
        data: null,
        sourceRefs: [],
        blockers: [
          notice(
            "knowledge.version_missing",
            "No current curated record with a verified version was returned.",
          ),
        ],
        reviewStatus: "manual_review",
      };
    }
    const version = firstSourceRef.version;
    const query = typeof input.query === "string" ? input.query : "unknown";
    const data: Record<string, unknown> = {
      version,
      query,
      curated_only: true,
      archived_excluded: true,
      results: filtered.map((record) => ({
        result_id: record.result_id,
        title: record.title,
        summary: record.summary,
        source_ref: record.source_ref,
      })),
    };
    return {
      status: "success",
      data,
      sourceRefs,
      warnings:
        filtered.length === 0
          ? [
              notice(
                "knowledge.no_match",
                "No current curated document matched the request.",
                "info",
              ),
            ]
          : [
              notice(
                "knowledge.not_calculation_authority",
                "Curated documents do not override executable Zone, price, tariff, or permission data.",
                "info",
              ),
            ],
    };
  }
}
