import { z } from "zod";

import type { SourceRef } from "../../platform/envelope";
import { hashPayload } from "../../platform/idempotency";
import {
  createFetchJsonClient,
  type FetchImplementation,
  type FetchJsonClient,
} from "../http-client";
import type { AdapterResult, CustomsAdapter } from "../ports";
import {
  customsSearchResultSchema,
  dataStatusSchema,
  sourceRefSchema,
} from "../contracts";

const API_VERSION = "riskcustoms-api.v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRODUCT_ATTRIBUTE_KEYS = [
  "material",
  "use",
  "origin_country",
  "contains_steel_aluminum",
] as const;

const sourceSchema = z
  .object({
    id: z.string().min(1),
    releaseId: z.string().min(1),
    artifactId: z.string().min(1),
    authority: z.string().min(1),
    dataset: z.string().min(1),
    edition: z.string().min(1),
    revision: z.string().min(1),
    officialUrl: z.string().url(),
    publishedAt: z.union([z.string().date(), z.string().datetime()]),
    effectiveFrom: z.string().date(),
    effectiveTo: z.string().date().nullable(),
    retrievedAt: z.string().datetime(),
    sourceLocator: z.string().min(1),
  })
  .strict();

const statusResponseSchema = z
  .object({
    evaluatedAt: z.string().datetime(),
    lastSourceCheckAt: z.string().datetime().nullable(),
    ready: z.boolean(),
    reasons: z.array(z.string()),
  })
  .strict();

const sourceUseSchema = z.object({ sourceId: z.string().min(1) }).passthrough();
const hierarchySchema = z
  .object({
    code: z.string().regex(/^\d{4,10}$/),
    legalNames: z.array(sourceUseSchema).min(1),
  })
  .passthrough();
const candidateSchema = z
  .object({
    country: z.enum(["CN", "US", "CA"]),
    code: z.string().regex(/^\d{4,10}$/),
    codeDigits: z.number().int().min(4).max(10),
    hierarchy: z.array(hierarchySchema).min(1),
    legalNames: z.array(sourceUseSchema).min(1),
    chineseExplanation: z
      .object({ basedOnSourceIds: z.array(z.string().min(1)).min(1) })
      .passthrough(),
    classificationReason: z.string().min(1),
    classificationSourceIds: z.array(z.string().min(1)).min(1),
    status: z.enum(["confirmed", "candidate", "possible", "manual_review"]),
  })
  .passthrough();
const resultSchema = candidateSchema
  .extend({
    rates: z.array(sourceUseSchema),
    documents: z.array(sourceUseSchema),
    measures: z.array(sourceUseSchema),
  })
  .passthrough();
const queryResponseSchema = z
  .object({
    queryId: z.string().min(1),
    mode: z.enum(["exact_code", "name_search", "degraded_search", "online_search"]),
    ruleDate: z.string().date(),
    selectedHs6: z.string().regex(/^\d{6}$/).nullable(),
    nextQuestion: z.object({ label: z.string().min(1) }).passthrough().nullable(),
    candidates: z.array(candidateSchema),
    results: z.array(resultSchema),
    sources: z.array(sourceSchema),
    dataStatus: statusResponseSchema,
    testData: z.boolean(),
  })
  .strict();

type QueryResponse = z.infer<typeof queryResponseSchema>;
type Candidate = QueryResponse["candidates"][number];
type Result = QueryResponse["results"][number];
type Source = QueryResponse["sources"][number];

export interface RiskCustomsApiAdapterOptions {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly enabled?: boolean;
  readonly fetchImpl?: FetchImplementation;
  readonly headerProvider?: () => Readonly<Record<string, string>>;
  readonly clock?: () => Date;
  readonly productionConnector?: boolean;
}

type FailureStatus = "needs_input" | "blocked" | "manual_review" | "unavailable";

function notice(
  code: string,
  message: string,
  severity: "info" | "warning" | "error" = "error",
  field: string | null = null,
) {
  return { code, message, severity, field } as const;
}

function failure(
  status: FailureStatus,
  code: string,
  message: string,
  field: string | null = null,
): AdapterResult {
  const result: AdapterResult = {
    status,
    data: null,
    sourceRefs: [],
    blockers: [notice(code, message, "error", field)],
  };
  return status === "needs_input"
    ? result
    : { ...result, reviewStatus: "manual_review" };
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

function statusData(value: z.infer<typeof statusResponseSchema>): Record<string, unknown> {
  return {
    version: `data-status@${API_VERSION}`,
    system: "riskcustoms",
    ready: value.ready,
    test_data: false,
    evaluated_at: value.evaluatedAt,
    last_source_check_at: value.lastSourceCheckAt,
    reasons: [...value.reasons],
    release_ids: [],
  };
}

function emptySearchData(
  input: Record<string, unknown>,
  dataStatus: Record<string, unknown>,
): Record<string, unknown> {
  const queryKind =
    input.query_kind === "exact_code" ||
    input.query_kind === "candidate_selection" ||
    input.query_kind === "name_search"
      ? input.query_kind
      : "name_search";
  return {
    version: `customs-search@${API_VERSION}`,
    query_id: "query:customs:unavailable",
    jurisdiction: "CA",
    query_kind: queryKind,
    candidates: [],
    next_questions: [],
    data_status: dataStatus,
  };
}

function sourceRefId(sourceId: string): string {
  return `src:customs:riskcustoms:${hashPayload(sourceId).slice(7)}`;
}

function candidateSourceIds(value: Candidate): string[] {
  return [
    ...value.classificationSourceIds,
    ...value.chineseExplanation.basedOnSourceIds,
    ...value.legalNames.map((name) => name.sourceId),
    ...value.hierarchy.flatMap((node) => node.legalNames.map((name) => name.sourceId)),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

function resultSourceIds(value: Result): string[] {
  return [
    ...candidateSourceIds(value),
    ...value.rates.map((rate) => rate.sourceId),
    ...value.documents.map((document) => document.sourceId),
    ...value.measures.map((measure) => measure.sourceId),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

function mappedStatus(
  value: Candidate["status"],
): "candidate" | "confirmed" | "manual_review" {
  if (value === "confirmed") return "confirmed";
  if (value === "manual_review") return "manual_review";
  return "candidate";
}

function queryKind(
  value: unknown,
): "exact_code" | "name_search" | "candidate_selection" {
  return value === "exact_code" ||
    value === "candidate_selection" ||
    value === "name_search"
    ? value
    : "name_search";
}

export class RiskCustomsApiAdapter implements CustomsAdapter {
  private readonly client: FetchJsonClient | null;
  private readonly headerProvider: () => Readonly<Record<string, string>>;
  private readonly clock: () => Date;
  private readonly productionConnector: boolean;
  private readonly configurationBlocked: boolean;

  constructor(options?: RiskCustomsApiAdapterOptions) {
    this.headerProvider = options?.headerProvider ?? (() => ({}));
    this.clock = options?.clock ?? (() => new Date());
    this.productionConnector = options?.productionConnector === true;
    if (options === undefined || options.enabled !== true || !this.productionConnector) {
      this.client = null;
      this.configurationBlocked = false;
      return;
    }
    try {
      this.client = createFetchJsonClient({
        baseUrl: options.baseUrl,
        allowedHosts: options.allowedHosts,
        enabled: true,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      this.configurationBlocked = false;
    } catch {
      this.client = null;
      this.configurationBlocked = true;
    }
  }

  async getStatus(input: Record<string, unknown>): Promise<AdapterResult> {
    const ruleDate = input.rule_date;
    if (!validDate(ruleDate)) {
      return failure(
        "needs_input",
        "customs.rule_date_required",
        "A valid rule_date is required before checking RiskCustoms status.",
        "rule_date",
      );
    }
    const unavailable = this.available();
    if (unavailable !== null) return unavailable;
    try {
      const response = await this.client!.get(
        `/api/status?ruleDate=${encodeURIComponent(ruleDate)}`,
        this.headerProvider(),
      );
      const parsed = statusResponseSchema.safeParse(response);
      if (!parsed.success) {
        return failure(
          "unavailable",
          "customs.status_contract_invalid",
          "RiskCustoms returned a status outside its verified contract.",
        );
      }
      const data = statusData(parsed.data);
      if (!dataStatusSchema.safeParse(data).success) {
        return failure(
          "unavailable",
          "customs.status_mapping_invalid",
          "RiskCustoms status could not be mapped to the MCP contract.",
        );
      }
      return {
        status: "success",
        data,
        sourceRefs: [],
        ...(parsed.data.ready
          ? {}
          : {
              warnings: [
                notice(
                  "customs.ready_false",
                  "RiskCustoms is not ready; dependent customs search remains unavailable.",
                  "warning",
                  "ready",
                ),
              ],
            }),
      };
    } catch {
      return failure(
        "unavailable",
        "customs.status_unavailable",
        "RiskCustoms status could not be read.",
      );
    }
  }

  async search(input: Record<string, unknown>): Promise<AdapterResult> {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query.length === 0 || query.length > 200) {
      return failure(
        "needs_input",
        "customs.query_required",
        "An explicit customs query is required.",
        "query",
      );
    }
    const ruleDate = input.rule_date;
    if (!validDate(ruleDate)) {
      return failure(
        "needs_input",
        "customs.rule_date_required",
        "A valid rule_date is required before searching RiskCustoms.",
        "rule_date",
      );
    }
    const unavailable = this.available();
    if (unavailable !== null) return unavailable;

    let status: z.infer<typeof statusResponseSchema>;
    try {
      const response = await this.client!.get(
        `/api/status?ruleDate=${encodeURIComponent(ruleDate)}`,
        this.headerProvider(),
      );
      const parsed = statusResponseSchema.safeParse(response);
      if (!parsed.success) {
        return failure(
          "unavailable",
          "customs.status_contract_invalid",
          "RiskCustoms returned a status outside its verified contract.",
        );
      }
      status = parsed.data;
    } catch {
      return failure(
        "unavailable",
        "customs.status_unavailable",
        "RiskCustoms status could not be read.",
      );
    }

    if (!status.ready) {
      return {
        ...failure(
          "unavailable",
          "customs.ready_false",
          "RiskCustoms ready=false; no query was attempted.",
          "data_status.ready",
        ),
        data: emptySearchData(input, statusData(status)),
        warnings: [
          notice(
            "customs.no_fallback",
            "No AI, stale, or non-authoritative fallback was used.",
            "warning",
          ),
        ],
      };
    }

    const body = this.queryBody(input, query, ruleDate);
    if (body === null) {
      return failure(
        "needs_input",
        "customs.attributes_invalid",
        "Product attributes must contain only explicit scalar values.",
        "product_attributes",
      );
    }
    try {
      const response = await this.client!.post(
        "/api/query",
        body,
        this.headerProvider(),
      );
      return this.mapResponse(input, ruleDate, response);
    } catch {
      return failure(
        "unavailable",
        "customs.query_unavailable",
        "RiskCustoms query could not be completed.",
      );
    }
  }

  estimate(input: Record<string, unknown>): Promise<AdapterResult> {
    void input;
    return Promise.resolve(failure(
      "unavailable",
      "customs.estimate_unavailable",
      "当前 API 不提供正式税额估算。",
    ));
  }

  private available(): AdapterResult | null {
    if (this.configurationBlocked) {
      return failure(
        "blocked",
        "customs.endpoint_not_allowed",
        "The RiskCustoms endpoint is outside the configured security policy.",
      );
    }
    if (this.client === null || !this.productionConnector) {
      return failure(
        "unavailable",
        "customs.adapter_disabled",
        "The RiskCustoms production connector is disabled until explicitly configured.",
      );
    }
    return null;
  }

  private queryBody(
    input: Record<string, unknown>,
    query: string,
    ruleDate: string,
  ): Record<string, unknown> | null {
    const attributes: Record<string, string | number | boolean> = {};
    if (input.product_attributes !== undefined && input.product_attributes !== null) {
      if (typeof input.product_attributes !== "object" || input.product_attributes === null || Array.isArray(input.product_attributes)) return null;
      for (const key of PRODUCT_ATTRIBUTE_KEYS) {
        const value = (input.product_attributes as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (value === null) continue;
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
        if (typeof value === "number" && !Number.isFinite(value)) return null;
        attributes[key] = value;
      }
    }
    const selectedHs6 = input.selected_hs6;
    if (selectedHs6 !== undefined && selectedHs6 !== null && (typeof selectedHs6 !== "string" || !/^\d{6}$/.test(selectedHs6))) return null;
    return {
      query,
      ruleDate,
      codeCountry: "CA",
      ...(selectedHs6 === undefined || selectedHs6 === null ? {} : { selectedHs6 }),
      attributes,
    };
  }

  private mapResponse(
    input: Record<string, unknown>,
    ruleDate: string,
    rawResponse: unknown,
  ): AdapterResult {
    const parsed = queryResponseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      return failure(
        "unavailable",
        "customs.query_contract_invalid",
        "RiskCustoms returned a query response outside its verified contract.",
      );
    }
    const response = parsed.data;
    if (response.ruleDate !== ruleDate) {
      return failure(
        "unavailable",
        "customs.rule_date_mismatch",
        "RiskCustoms returned data for a different rule date.",
      );
    }
    if (!response.dataStatus.ready) {
      return failure(
        "unavailable",
        "customs.query_not_ready",
        "RiskCustoms query data is not ready.",
      );
    }
    if (response.testData) {
      return failure(
        "unavailable",
        "customs.test_data_not_production",
        "RiskCustoms test data cannot be used as production data.",
      );
    }
    if (response.sources.length === 0) {
      return failure(
        "unavailable",
        "customs.sources_missing",
        "RiskCustoms returned no source references.",
      );
    }
    if (!validIdentifier(response.queryId)) {
      return failure(
        "unavailable",
        "customs.query_id_invalid",
        "RiskCustoms returned an invalid query identifier.",
      );
    }
    const modeMatches =
      input.query_kind === "exact_code"
        ? response.mode === "exact_code"
        : (input.query_kind === "name_search" || input.query_kind === "candidate_selection") &&
          response.mode !== "exact_code";
    const requestedHs6 = input.selected_hs6;
    const selectedHs6Matches =
      input.query_kind === "candidate_selection"
        ? response.selectedHs6 === (requestedHs6 ?? null)
        : requestedHs6 === undefined || requestedHs6 === null || response.selectedHs6 === requestedHs6;
    if (!modeMatches || !selectedHs6Matches) {
      return failure(
        "manual_review",
        "customs.response_correlation_mismatch",
        "RiskCustoms response mode or selected HS6 does not match the request.",
      );
    }

    try {
      const contentHash = hashPayload(rawResponse);
      const sourceResult = this.mapSources(response.sources, contentHash);
      if (sourceResult.error !== null) return failure(...sourceResult.error);
      const candidates = this.mapCandidates(
        response.candidates,
        response.results,
        new Set(response.sources.map((source) => source.id)),
        new Map(response.sources.map((source) => [source.id, sourceRefId(source.id)])),
      );
      if (candidates.error !== null) return failure(...candidates.error);

      const data = {
        version: `customs-search@${API_VERSION}`,
        query_id: response.queryId,
        jurisdiction: "CA" as const,
        query_kind: queryKind(input.query_kind),
        candidates: candidates.values,
        next_questions: response.nextQuestion === null ? [] : [response.nextQuestion.label],
        data_status: {
          ...statusData(response.dataStatus),
          release_ids: sourceResult.releaseIds,
        },
      };
      if (!dataStatusSchema.safeParse(data.data_status).success || !customsSearchResultSchema.safeParse(data).success) {
        return failure(
          "unavailable",
          "customs.result_mapping_invalid",
          "RiskCustoms query could not be mapped to the MCP contract.",
        );
      }
      const warning = candidates.hasUnconfirmed
        ? [
            notice(
              "customs.numeric_confidence_not_provided",
              "RiskCustoms does not provide numeric confidence; non-confirmed classifications remain at confidence 0.",
              "warning",
            ),
          ]
        : [];
      return {
        status: "success",
        data,
        sourceRefs: sourceResult.refs,
        assumptions: candidates.hasUnconfirmed
          ? [
              notice(
                "customs.candidate_only",
                "HS candidates are not formal classification conclusions.",
                "info",
              ),
            ]
          : [],
        warnings: warning,
        reviewStatus: candidates.hasUnconfirmed ? "pending" : "not_required",
      };
    } catch {
      return failure(
        "unavailable",
        "customs.result_mapping_invalid",
        "RiskCustoms query could not be mapped to the MCP contract.",
      );
    }
  }

  private mapSources(
    sources: readonly Source[],
    contentHash: string,
  ): {
    readonly refs: readonly SourceRef[];
    readonly releaseIds: readonly string[];
    readonly error: ["unavailable" | "manual_review", string, string] | null;
  } {
    const refs: SourceRef[] = [];
    const releaseIds: string[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      if (seen.has(source.id)) return { refs: [], releaseIds: [], error: ["manual_review", "customs.source_duplicate", "RiskCustoms returned duplicate source identifiers."] };
      seen.add(source.id);
      if (!validIdentifier(source.releaseId)) return { refs: [], releaseIds: [], error: ["unavailable", "customs.release_invalid", "RiskCustoms returned an invalid release identifier."] };
      let locator: URL;
      try {
        locator = new URL(source.officialUrl);
      } catch {
        return { refs: [], releaseIds: [], error: ["unavailable", "customs.source_locator_invalid", "RiskCustoms returned an invalid official source locator."] };
      }
      if (locator.protocol !== "https:" || locator.username !== "" || locator.password !== "" || source.officialUrl.length > 500) {
        return { refs: [], releaseIds: [], error: ["unavailable", "customs.source_locator_invalid", "RiskCustoms returned an unsafe official source locator."] };
      }
      refs.push({
        source_id: sourceRefId(source.id),
        source_type: "official_source",
        system: "RiskCustoms",
        locator: source.officialUrl,
        version: source.releaseId,
        retrieved_at: this.clock().toISOString(),
        authority: "authoritative",
        content_hash: contentHash,
      });
      if (!releaseIds.includes(source.releaseId)) releaseIds.push(source.releaseId);
    }
    return refs.every((ref) => sourceRefSchema.safeParse(ref).success)
      ? { refs, releaseIds, error: null }
      : { refs: [], releaseIds: [], error: ["unavailable", "customs.source_mapping_invalid", "RiskCustoms sources could not be mapped to the MCP source contract."] };
  }

  private mapCandidates(
    candidates: readonly Candidate[],
    results: readonly Result[],
    sourceIds: ReadonlySet<string>,
    refIds: ReadonlyMap<string, string>,
  ): {
    readonly values: readonly Record<string, unknown>[];
    readonly hasUnconfirmed: boolean;
    readonly error: ["manual_review" | "unavailable", string, string] | null;
  } {
    const values: Array<{ value: Candidate; sourceIds: string[] }> = [
      ...candidates.map((value) => ({ value, sourceIds: candidateSourceIds(value) })),
      ...results.map((value) => ({ value, sourceIds: resultSourceIds(value) })),
    ];
    const mapped: Record<string, unknown>[] = [];
    const byCode = new Map<string, string>();
    let hasUnconfirmed = false;
    for (const item of values) {
      if (item.value.country !== "CA") continue;
      if (item.value.codeDigits !== item.value.code.length || !item.value.hierarchy.some((node) => node.code === item.value.code)) {
        return { values: [], hasUnconfirmed: false, error: ["unavailable", "customs.candidate_contract_invalid", "RiskCustoms returned an invalid classification candidate."] };
      }
      if (item.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
        return { values: [], hasUnconfirmed: false, error: ["manual_review", "customs.source_reference_missing", "A RiskCustoms classification references a source that was not returned."] };
      }
      const mappedRefs = item.sourceIds.map((sourceId) => refIds.get(sourceId));
      if (mappedRefs.some((refId) => refId === undefined)) {
        return { values: [], hasUnconfirmed: false, error: ["manual_review", "customs.source_reference_missing", "A RiskCustoms classification source could not be mapped."] };
      }
      const status = mappedStatus(item.value.status);
      const previous = byCode.get(item.value.code);
      if (previous !== undefined && previous !== status) {
        return { values: [], hasUnconfirmed: false, error: ["manual_review", "customs.classification_conflict", "RiskCustoms returned conflicting classifications for one HS code."] };
      }
      if (previous !== undefined) continue;
      byCode.set(item.value.code, status);
      if (status !== "confirmed") hasUnconfirmed = true;
      mapped.push({
        hs_code: item.value.code,
        classification_status: status,
        confidence: status === "confirmed" ? "1" : "0",
        reason_summary: item.value.classificationReason,
        source_ref_ids: [...new Set(mappedRefs as string[])],
      });
    }
    return { values: mapped, hasUnconfirmed, error: null };
  }
}
