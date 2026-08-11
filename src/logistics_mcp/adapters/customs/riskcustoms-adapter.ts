import type { SourceRef } from "../../platform/envelope";
import type { AdapterResult, CustomsAdapter } from "../ports";

export interface RiskCustomsCandidate {
  readonly hs_code: string;
  readonly classification_status: "candidate" | "confirmed" | "manual_review";
  readonly confidence: string;
  readonly reason_summary: string;
  readonly source_ref_ids: readonly string[];
}
export interface RiskCustomsStatusRecord {
  readonly version: string;
  readonly system: "riskcustoms";
  readonly ready: boolean;
  readonly test_data: boolean;
  readonly evaluated_at: string;
  readonly last_source_check_at: string | null;
  readonly reasons: readonly string[];
  readonly release_ids: readonly string[];
  readonly snapshot_hash: string | null;
  readonly release_hash: string | null;
  readonly source_ref: SourceRef;
}

export interface RiskCustomsSearchRecord {
  readonly query_id: string;
  readonly query_kind: "exact_code" | "name_search" | "candidate_selection";
  readonly candidates: readonly RiskCustomsCandidate[];
  readonly next_questions: readonly string[];
  readonly source_refs: readonly SourceRef[];
}

export interface RiskCustomsRate {
  readonly rate_id: string;
  readonly label: string;
  readonly rate_expression_raw: string;
  readonly amount: { readonly amount: string; readonly currency: string } | null;
  readonly confirmed: boolean;
  readonly source_ref_ids: readonly string[];
}

export interface RiskCustomsEstimateRecord {
  readonly assessment_id: string;
  readonly rates: readonly RiskCustomsRate[];
  readonly valuation: { readonly amount: string; readonly currency: string } | null;
  readonly total_estimated_import_tax: { readonly amount: string; readonly currency: string } | null;
  readonly source_refs: readonly SourceRef[];
}

export interface RiskCustomsUpstreamSource {
  getStatus(input: Record<string, unknown>): Promise<RiskCustomsStatusRecord>;
  search(input: Record<string, unknown>): Promise<RiskCustomsSearchRecord>;
  estimate(input: Record<string, unknown>): Promise<RiskCustomsEstimateRecord>;
}

export interface RiskCustomsAdapterOptions {
  readonly source?: RiskCustomsUpstreamSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusData(status: RiskCustomsStatusRecord): Record<string, unknown> {
  return {
    version: status.version,
    system: status.system,
    ready: status.ready,
    test_data: status.test_data,
    evaluated_at: status.evaluated_at,
    last_source_check_at: status.last_source_check_at,
    reasons: [...status.reasons],
    release_ids: [...status.release_ids],
  };
}

function uniqueSourceRefs(refs: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.source_id)) return false;
    seen.add(ref.source_id);
    return true;
  });
}

function notice(
  code: string,
  message: string,
  severity: "info" | "warning" | "error" = "error",
  field: string | null = null,
) {
  return { code, message, severity, field } as const;
}

function searchData(
  status: RiskCustomsStatusRecord,
  queryId = "query:customs:unavailable",
  queryKind: RiskCustomsSearchRecord["query_kind"] = "name_search",
  candidates: readonly RiskCustomsCandidate[] = [],
  nextQuestions: readonly string[] = [],
): Record<string, unknown> {
  return {
    version: "customs-search@2026-08-11.v1",
    query_id: queryId,
    jurisdiction: "CA",
    query_kind: queryKind,
    candidates: [...candidates],
    next_questions: [...nextQuestions],
    data_status: statusData(status),
  };
}

function estimateData(
  status: RiskCustomsStatusRecord,
  input: Record<string, unknown>,
  record: RiskCustomsEstimateRecord | null = null,
  assessmentStatus: "candidate" | "estimated" | "manual_review" | "unavailable" = "unavailable",
): Record<string, unknown> {
  const classification = isRecord(input.classification) ? input.classification : null;
  const hsCode = typeof classification?.hs_code === "string" ? classification.hs_code : "0000";
  const classificationStatus = classification?.status;
  const sourceRefIds = Array.isArray(classification?.source_ref_ids)
    ? classification.source_ref_ids.filter((value): value is string => typeof value === "string")
    : [];
  const candidate = {
    hs_code: hsCode,
    classification_status:
      classificationStatus === "confirmed" ? "confirmed" : "candidate",
    confidence: classificationStatus === "confirmed" ? "1" : "0",
    reason_summary:
      classificationStatus === "confirmed"
        ? "Classification was supplied as confirmed by the caller; broker confirmation remains required."
        : "Classification remains a candidate and is not a formal customs conclusion.",
    source_ref_ids: sourceRefIds.length > 0 ? sourceRefIds : ["src:customs:status:unavailable"],
  };
  return {
    version: "customs-assessment@2026-08-11.v1",
    assessment_id: record?.assessment_id ?? "assessment:customs:unavailable",
    jurisdiction: "CA",
    assessment_status: assessmentStatus,
    data_status: status.ready ? (status.release_ids.length > 0 ? "ready" : "source_missing") : "not_ready",
    hs_candidates: [candidate],
    valuation: record?.valuation ?? null,
    rates: record?.rates ? [...record.rates] : [],
    total_estimated_import_tax: record?.total_estimated_import_tax ?? null,
    tariff_release_version: status.release_ids[0] ?? null,
    requires_broker_confirmation: true,
    source_ref_ids: record?.source_refs.map((ref) => ref.source_id) ?? sourceRefIds,
  };
}

interface ReadinessGate {
  readonly status: RiskCustomsStatusRecord;
  readonly sourceRefs: readonly SourceRef[];
  readonly blocked: AdapterResult;
}

export class RiskCustomsAdapter implements CustomsAdapter {
  private readonly source: RiskCustomsUpstreamSource | undefined;

  constructor(options: RiskCustomsAdapterOptions = {}) {
    this.source = options.source;
  }

  async getStatus(input: Record<string, unknown>): Promise<AdapterResult> {
    if (this.source === undefined) return this.disabledResult();
    const status = await this.source.getStatus(input);
    return {
      status: "success",
      data: statusData(status),
      sourceRefs: [status.source_ref],
      warnings: status.ready
        ? []
        : [
            notice(
              "customs.ready_false",
              "RiskCustoms is not ready; dependent customs tools remain unavailable.",
              "warning",
              "ready",
            ),
          ],
    };
  }

  async search(input: Record<string, unknown>): Promise<AdapterResult> {
    const gate = await this.readiness(input, "search");
    if (gate.blocked.status !== "success") return gate.blocked;
    const record = await this.source!.search(input);
    const data = searchData(
      gate.status,
      record.query_id,
      record.query_kind,
      record.candidates,
      record.next_questions,
    );
    const sourceRefs = uniqueSourceRefs([gate.status.source_ref, ...record.source_refs]);
    return {
      status: "success",
      data,
      sourceRefs,
      assumptions: [
        notice(
          "customs.candidate_only",
          "HS candidates are not formal classification conclusions.",
          "info",
        ),
      ],
      reviewStatus: record.candidates.some((candidate) => candidate.classification_status !== "confirmed")
        ? "pending"
        : "not_required",
    };
  }

  async estimate(input: Record<string, unknown>): Promise<AdapterResult> {
    const gate = await this.readiness(input, "estimate");
    if (gate.blocked.status !== "success") {
      return {
        ...gate.blocked,
        data: estimateData(gate.status, input),
      };
    }
    const record = await this.source!.estimate(input);
    const classification = isRecord(input.classification) ? input.classification : null;
    const classificationConfirmed = classification?.status === "confirmed";
    const ratesConfirmed = record.rates.every((rate) => rate.confirmed);
    const assessmentStatus = classificationConfirmed && ratesConfirmed ? "estimated" : "manual_review";
    return {
      status: assessmentStatus === "estimated" ? "success" : "manual_review",
      data: estimateData(gate.status, input, record, assessmentStatus),
      sourceRefs: uniqueSourceRefs([gate.status.source_ref, ...record.source_refs]),
      assumptions: [
        notice(
          "customs.estimate_only",
          "This is an estimate and not a formal customs declaration conclusion.",
          "warning",
        ),
      ],
      warnings: [
        notice(
          "customs.broker_confirmation_required",
          "Classification, treatment scope, and rates require broker confirmation.",
          "warning",
        ),
      ],
      blockers:
        assessmentStatus === "manual_review"
          ? [
              notice(
                classificationConfirmed
                  ? "customs.rate_unconfirmed"
                  : "customs.classification_unconfirmed",
                "The estimate cannot be treated as confirmed until the classification and rates are reviewed.",
                "error",
              ),
            ]
          : [],
      reviewStatus: assessmentStatus === "manual_review" ? "manual_review" : "pending",
    };
  }

  private async readiness(
    input: Record<string, unknown>,
    operation: "search" | "estimate",
  ): Promise<ReadinessGate> {
    if (this.source === undefined) return this.disabledGate();
    const status = await this.source.getStatus(input);
    const sourceRefs = [status.source_ref];
    if (!status.ready) {
      return {
        status,
        sourceRefs,
        blocked: {
          status: "unavailable",
          data:
            operation === "search"
              ? searchData(status)
              : estimateData(status, input),
          sourceRefs,
          blockers: [
            notice(
              "customs.ready_false",
              "RiskCustoms ready=false; no query or estimate was attempted.",
              "error",
              "data_status.ready",
            ),
          ],
          warnings: [
            notice(
              "customs.no_fallback",
              "No AI, stale, or non-authoritative fallback was used.",
              "warning",
            ),
          ],
          reviewStatus: "manual_review",
        },
      };
    }
    if (status.test_data) {
      return {
        status,
        sourceRefs,
        blocked: {
          status: "unavailable",
          data: operation === "search" ? searchData(status) : estimateData(status, input),
          sourceRefs,
          blockers: [
            notice(
              "customs.test_data_not_production",
              "RiskCustoms test data cannot be used as production-ready data.",
              "error",
              "data_status.test_data",
            ),
          ],
          reviewStatus: "manual_review",
        },
      };
    }
    if (status.release_ids.length === 0) {
      return {
        status,
        sourceRefs,
        blocked: {
          status: "unavailable",
          data: operation === "search" ? searchData(status) : estimateData(status, input),
          sourceRefs,
          blockers: [
            notice(
              "customs.release_missing",
              "RiskCustoms returned no published release identifier.",
              "error",
              "data_status.release_ids",
            ),
          ],
          reviewStatus: "manual_review",
        },
      };
    }
    if (
      status.snapshot_hash === null ||
      status.release_hash === null ||
      status.snapshot_hash !== status.release_hash
    ) {
      return {
        status,
        sourceRefs,
        blocked: {
          status: "manual_review",
          data: operation === "search" ? searchData(status) : estimateData(status, input),
          sourceRefs,
          blockers: [
            notice(
              "customs.release_hash_mismatch",
              "The published snapshot hash does not match the release gate.",
              "error",
            ),
          ],
          reviewStatus: "manual_review",
        },
      };
    }
    return {
      status,
      sourceRefs,
      blocked: { status: "success", data: null, sourceRefs },
    };
  }

  private disabledResult(): AdapterResult {
    return {
      status: "unavailable",
      data: null,
      sourceRefs: [],
      blockers: [
        notice(
          "customs.adapter_disabled",
          "The RiskCustoms endpoint is disabled until its route, release, and auth contract are verified.",
        ),
      ],
      reviewStatus: "manual_review",
    };
  }

  private disabledGate(): ReadinessGate {
    return {
      status: {
        version: "data-status@unavailable",
        system: "riskcustoms",
        ready: false,
        test_data: false,
        evaluated_at: "2026-08-11T00:00:00Z",
        last_source_check_at: null,
        reasons: ["adapter_disabled"],
        release_ids: [],
        snapshot_hash: null,
        release_hash: null,
        source_ref: {
          source_id: "src:customs:status:disabled",
          source_type: "internal_system",
          system: "RiskCustoms",
          locator: "opaque://riskcustoms/status-disabled",
          version: "data-status@unavailable",
          retrieved_at: "2026-08-11T00:00:00Z",
          authority: "authoritative",
          content_hash: null,
        },
      },
      sourceRefs: [],
      blocked: this.disabledResult(),
    };
  }
}
