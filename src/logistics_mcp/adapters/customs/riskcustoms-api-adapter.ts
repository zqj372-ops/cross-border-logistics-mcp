import { z } from "zod";

import type { ExecutionContext } from "../../platform/context";
import type { SourceRef } from "../../platform/envelope";
import { hashPayload } from "../../platform/idempotency";
import {
  createFetchJsonClient,
  HttpAdapterError,
  type FetchJsonAllowedStatusResponse,
  type FetchImplementation,
  type FetchJsonClient,
} from "../http-client";
import type { AdapterResult, CustomsAdapter } from "../ports";
import {
  customsSearchResultSchema,
  dataStatusSchema,
  sourceRefSchema,
} from "../contracts";

const API_VERSION = "riskcustoms-m2m.v1";
const CONTRACT_VERSION = "riskcustoms-query.v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const HEX_HASH = /^[a-f0-9]{64}$/u;

const identitySchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    serviceVersion: z.string().min(1),
    publishedAt: z.string().datetime().nullable(),
    supportedOperations: z.tuple([z.literal("status"), z.literal("query")]),
    releaseIds: z.array(z.string().min(1)),
    snapshotHash: z.string().regex(HEX_HASH).nullable(),
    releaseHash: z.string().regex(HEX_HASH).nullable(),
  })
  .strict();

const statusResponseBaseSchema = identitySchema
  .extend({
    evaluatedAt: z.string().datetime().nullable(),
    lastSourceCheckAt: z.string().datetime().nullable(),
    ready: z.boolean(),
    testData: z.boolean(),
    reasons: z.array(z.string()),
  })
  .strict();

function readyStatusIsComplete(value: {
  readonly ready: boolean;
  readonly publishedAt: string | null;
  readonly releaseIds: readonly string[];
  readonly snapshotHash: string | null;
  readonly releaseHash: string | null;
  readonly reasons: readonly string[];
}): boolean {
  return !value.ready || (
    value.publishedAt !== null &&
    value.releaseIds.length > 0 &&
    value.snapshotHash !== null &&
    value.releaseHash !== null &&
    value.reasons.length === 0
  );
}

const statusResponseSchema = statusResponseBaseSchema.refine(
  readyStatusIsComplete,
  { message: "A ready publication must include complete release and snapshot identity" },
);

const dataNotReadyErrorSchema = z
  .object({
    code: z.literal("data_not_ready"),
    message: z.string().min(1),
  })
  .strict();

const statusResponseWithErrorSchema = statusResponseBaseSchema
  .extend({ error: dataNotReadyErrorSchema })
  .strict()
  .refine(
    readyStatusIsComplete,
    { message: "A ready publication must include complete release and snapshot identity" },
  );

const legalNameSchema = z
  .object({
    language: z.string().min(2),
    text: z.string().min(1),
    sourceId: z.string().min(1),
  })
  .strict();

const chineseExplanationSchema = z
  .object({
    translationId: z.string().min(1),
    text: z.string().min(1),
    status: z.enum(["machine", "human_reviewed", "not_needed"]),
    basedOnSourceIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const hierarchySchema = z
  .object({
    code: z.string().regex(/^\d{4,10}$/u),
    displayCode: z.string().min(1),
    codeDigits: z.number().int().min(4).max(10),
    legalNames: z.array(legalNameSchema).min(1),
  })
  .strict();

const candidateSchema = z
  .object({
    candidateId: z.string().min(1),
    country: z.enum(["CN", "US", "CA"]),
    code: z.string().regex(/^\d{4,10}$/u),
    displayCode: z.string().min(1),
    codeDigits: z.number().int().min(4).max(10),
    parentCode: z.string().regex(/^\d{4,10}$/u).nullable(),
    hierarchy: z.array(hierarchySchema).min(1).max(7),
    legalNames: z.array(legalNameSchema).min(1),
    chineseExplanation: chineseExplanationSchema,
    classificationReason: z.string().min(1),
    classificationSourceIds: z.array(z.string().min(1)).min(1),
    status: z.enum(["confirmed", "candidate", "possible", "manual_review"]),
    hs6: z.string().regex(/^\d{6}$/u).nullable(),
  })
  .strict();

const rateLineSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    treatment: z.string().min(1),
    category: z.enum(["export_duty", "provisional_export_duty", "base_duty", "additional_duty", "trade_remedy", "tax", "fee"]),
    kind: z.enum(["free", "ad_valorem", "specific", "compound", "text"]),
    rateExpressionRaw: z.string().min(1),
    displayValue: z.string().min(1),
    confirmed: z.boolean(),
    includedInConfirmedTotal: z.boolean(),
    effectiveFrom: z.string().date(),
    effectiveTo: z.string().date().nullable(),
    conditionText: z.string(),
    interactionNote: z.string(),
    sourceId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must not be before effectiveFrom" });
    }
    if (value.includedInConfirmedTotal && !value.confirmed) {
      ctx.addIssue({ code: "custom", path: ["includedInConfirmedTotal"], message: "A confirmed total cannot include an unconfirmed rate" });
    }
    if (value.includedInConfirmedTotal && (value.category === "tax" || value.category === "fee")) {
      ctx.addIssue({ code: "custom", path: ["includedInConfirmedTotal"], message: "Tax and fee rates cannot be included in the confirmed total" });
    }
  });

const documentSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    side: z.enum(["cn_export", "us_import", "ca_import"]),
    status: z.enum(["prepare_retain", "required_now", "conditional", "on_request", "not_applicable", "manual_review"]),
    conditions: z.array(z.string()),
    reason: z.string().min(1),
    effectiveFrom: z.string().date(),
    effectiveTo: z.string().date().nullable(),
    sourceId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must not be before effectiveFrom" });
    }
  });

const measureSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    measureType: z.string().min(1),
    originCountry: z.string().min(2),
    codeHint: z.string().nullable(),
    matchStatus: z.enum(["not_indicated", "possible", "confirmed_by_rule", "manual_review"]),
    legalScope: z.string().min(1),
    exceptions: z.array(z.string()),
    caseNumber: z.string().nullable(),
    exporterOrProducer: z.string().nullable(),
    rateExpressionRaw: z.string().nullable(),
    effectiveFrom: z.string().date(),
    effectiveTo: z.string().date().nullable(),
    sourceId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must not be before effectiveFrom" });
    }
  });

const resultSchema = candidateSchema
  .extend({
    rates: z.array(rateLineSchema),
    confirmedTotalPercent: z.string().nullable(),
    documents: z.array(documentSchema),
    measures: z.array(measureSchema),
    warnings: z.array(z.string()),
  })
  .strict();

const nextQuestionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    attribute: z.string().min(1),
    options: z.array(z.string().min(1)).min(1).max(3),
  })
  .strict();

function isSafeOfficialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

const sourceSchema = z
  .object({
    id: z.string().min(1),
    releaseId: z.string().min(1),
    artifactId: z.string().min(1),
    authority: z.string().min(1),
    dataset: z.string().min(1),
    edition: z.string().min(1),
    revision: z.string().min(1),
    officialUrl: z.string().url().refine(isSafeOfficialUrl, "officialUrl must be HTTPS without URL credentials"),
    publishedAt: z
      .union([z.string().date(), z.string().datetime()])
      .transform((value) => value.slice(0, 10)),
    effectiveFrom: z.string().date(),
    effectiveTo: z.string().date().nullable(),
    retrievedAt: z.string().datetime(),
    sourceLocator: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({
        code: "custom",
        path: ["effectiveTo"],
        message: "effectiveTo must not be before effectiveFrom",
      });
    }
  });

const queryResponseSchema = identitySchema
  .extend({
    queryId: z.string().min(1),
    mode: z.enum(["exact_code", "name_search", "degraded_search", "online_search"]),
    ruleDate: z.string().date(),
    selectedHs6: z.string().regex(/^\d{6}$/u).nullable(),
    nextQuestion: nextQuestionSchema.nullable(),
    candidates: z.array(candidateSchema).max(9),
    results: z.array(resultSchema),
    sources: z.array(sourceSchema),
    dataStatus: statusResponseSchema,
    testData: z.boolean(),
  })
  .strict()
  .superRefine((response, ctx) => {
    const sourceIds = new Set(response.sources.map((source) => source.id));
    if (sourceIds.size !== response.sources.length) {
      ctx.addIssue({ code: "custom", path: ["sources"], message: "Duplicate source IDs" });
    }

    for (const candidate of [...response.candidates, ...response.results]) {
      if (candidate.codeDigits !== candidate.code.length) {
        ctx.addIssue({ code: "custom", path: ["candidates"], message: "Code digit count does not match code" });
      }
      if (candidate.hs6 !== null && !candidate.code.startsWith(candidate.hs6)) {
        ctx.addIssue({ code: "custom", path: ["candidates"], message: "HS6 must be a code prefix" });
      }
      if (candidate.parentCode !== null) {
        const isStrictPrefix = candidate.parentCode.length < candidate.code.length && candidate.code.startsWith(candidate.parentCode);
        if (!isStrictPrefix || !candidate.hierarchy.some((node) => node.code === candidate.parentCode)) {
          ctx.addIssue({ code: "custom", path: ["candidates"], message: "parentCode must be a hierarchy prefix" });
        }
      }
      for (const node of candidate.hierarchy) {
        if (node.codeDigits !== node.code.length || !candidate.code.startsWith(node.code)) {
          ctx.addIssue({ code: "custom", path: ["candidates"], message: "Hierarchy codes must be valid prefixes" });
        }
      }
      if (!candidate.hierarchy.some((node) => node.code === candidate.code)) {
        ctx.addIssue({ code: "custom", path: ["candidates"], message: "Hierarchy must include the candidate code" });
      }
      for (const sourceId of [
        ...candidate.legalNames.map((name) => name.sourceId),
        ...candidate.hierarchy.flatMap((node) => node.legalNames.map((name) => name.sourceId)),
        ...candidate.classificationSourceIds,
        ...candidate.chineseExplanation.basedOnSourceIds,
      ]) {
        if (!sourceIds.has(sourceId)) {
          ctx.addIssue({ code: "custom", path: ["sources"], message: `Unknown source ${sourceId}` });
        }
      }
      if ("rates" in candidate) {
        const result = candidate as Result;
        for (const sourceId of [
          ...result.rates.map((rate) => rate.sourceId),
          ...result.documents.map((document) => document.sourceId),
          ...result.measures.map((measure) => measure.sourceId),
        ]) {
          if (!sourceIds.has(sourceId)) {
            ctx.addIssue({ code: "custom", path: ["sources"], message: `Unknown source ${sourceId}` });
          }
        }
      }
    }

    const resultCountries = new Set<string>();
    for (const result of response.results) {
      if (resultCountries.has(result.country)) {
        ctx.addIssue({ code: "custom", path: ["results"], message: "Duplicate result country" });
      }
      resultCountries.add(result.country);
      const expectedSide = { CN: "cn_export", US: "us_import", CA: "ca_import" }[result.country];
      for (const document of result.documents) {
        if (document.side !== expectedSide) {
          ctx.addIssue({ code: "custom", path: ["results"], message: "Document side does not match result country" });
        }
      }
    }

    for (const field of ["serviceVersion", "contractVersion", "publishedAt", "supportedOperations", "releaseIds", "snapshotHash", "releaseHash"] as const) {
      if (JSON.stringify(response[field]) !== JSON.stringify(response.dataStatus[field])) {
        ctx.addIssue({ code: "custom", path: [field], message: `${field} must match dataStatus.${field}` });
      }
    }
    if (response.dataStatus.testData !== response.testData) {
      ctx.addIssue({ code: "custom", path: ["dataStatus", "testData"], message: "dataStatus.testData must match testData" });
    }
  });

type Identity = z.infer<typeof identitySchema>;
type StatusResponse = z.infer<typeof statusResponseSchema>;
type QueryResponse = z.infer<typeof queryResponseSchema>;
type Candidate = QueryResponse["candidates"][number];
type Result = QueryResponse["results"][number];
type Source = QueryResponse["sources"][number];

function isAllowedStatusResponse(value: unknown): value is FetchJsonAllowedStatusResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as { readonly status?: unknown }).status === "number" &&
    "body" in value;
}

function parseStatusResponse(raw: unknown): {
  readonly value: StatusResponse;
  readonly dataNotReady: boolean;
} | null {
  const httpResponse = isAllowedStatusResponse(raw)
    ? raw
    : { status: 200, body: raw };
  if (httpResponse.status === 503) {
    const parsed = statusResponseWithErrorSchema.safeParse(httpResponse.body);
    if (!parsed.success || parsed.data.ready) return null;
    const { error, ...value } = parsed.data;
    void error;
    return { value, dataNotReady: true };
  }
  const parsed = statusResponseSchema.safeParse(httpResponse.body);
  return parsed.success ? { value: parsed.data, dataNotReady: false } : null;
}

export interface RiskCustomsApiAdapterOptions {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly enabled?: boolean;
  readonly fetchImpl?: FetchImplementation;
  readonly authorizationProvider?: (
    context: ExecutionContext,
  ) => string | Promise<string>;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
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
  if (typeof value !== "string") return false;
  const parsed = z.string().date().safeParse(value);
  return parsed.success;
}

function validIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

function identityFields(value: Identity): readonly unknown[] {
  return [
    value.contractVersion,
    value.serviceVersion,
    value.publishedAt,
    value.supportedOperations,
    value.releaseIds,
    value.snapshotHash,
    value.releaseHash,
  ];
}

function identitiesEqual(left: Identity, right: Identity): boolean {
  return JSON.stringify(identityFields(left)) === JSON.stringify(identityFields(right));
}

function statusData(value: StatusResponse): Record<string, unknown> {
  return {
    version: `data-status@${API_VERSION}`,
    system: "riskcustoms",
    ready: value.ready,
    test_data: value.testData,
    evaluated_at: value.evaluatedAt,
    last_source_check_at: value.lastSourceCheckAt,
    reasons: [...value.reasons],
    release_ids: [...value.releaseIds],
  };
}

function sourceRefId(sourceId: string): string {
  return `src:customs:riskcustoms:${hashPayload(sourceId).slice(7)}`;
}

function statusSourceRef(value: StatusResponse): SourceRef | null {
  if (value.evaluatedAt === null) return null;
  const sourceRef: SourceRef = {
    source_id: sourceRefId(`m2m-status:${JSON.stringify(identityFields(value))}`),
    source_type: "internal_system",
    system: "RiskCustoms",
    locator: "opaque://riskcustoms/m2m/status",
    version: value.contractVersion,
    retrieved_at: value.evaluatedAt,
    authority: "authoritative",
    content_hash: value.snapshotHash === null ? null : `sha256:${value.snapshotHash}`,
  };
  return sourceRefSchema.safeParse(sourceRef).success ? sourceRef : null;
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

function mappedStatus(value: StatusResponse): {
  readonly data: Record<string, unknown>;
  readonly sourceRef: SourceRef;
} | null {
  const sourceRef = statusSourceRef(value);
  const data = statusData(value);
  if (sourceRef === null || !dataStatusSchema.safeParse(data).success) return null;
  if (!value.releaseIds.every(validIdentifier)) return null;
  return { data, sourceRef };
}

function candidateSourceIds(value: Candidate): string[] {
  return [
    ...value.classificationSourceIds,
    ...value.chineseExplanation.basedOnSourceIds,
    ...value.legalNames.map((name) => name.sourceId),
    ...value.hierarchy.flatMap((node) => node.legalNames.map((name) => name.sourceId)),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

function mappedClassification(
  value: Candidate | Result,
  sourceIds: ReadonlySet<string>,
  refIds: ReadonlyMap<string, string>,
): { readonly value: Record<string, unknown>; readonly hasUnconfirmed: boolean } | null {
  if (value.country !== "CA") return null;
  if (value.codeDigits !== value.code.length || !value.hierarchy.some((node) => node.code === value.code)) return null;
  const ids = candidateSourceIds(value);
  if (ids.some((id) => !sourceIds.has(id))) return null;
  const mappedRefs = ids.map((id) => refIds.get(id));
  if (mappedRefs.some((id) => id === undefined)) return null;
  const classificationStatus = value.status === "confirmed"
    ? "confirmed"
    : value.status === "manual_review"
      ? "manual_review"
      : "candidate";
  return {
    value: {
      hs_code: value.code,
      classification_status: classificationStatus,
      confidence: classificationStatus === "confirmed" ? "1" : "0",
      reason_summary: value.classificationReason,
      source_ref_ids: [...new Set(mappedRefs as string[])],
    },
    hasUnconfirmed: classificationStatus !== "confirmed",
  };
}

function queryKind(value: unknown): "exact_code" | "name_search" | "candidate_selection" {
  return value === "exact_code" || value === "candidate_selection" || value === "name_search"
    ? value
    : "name_search";
}

export class RiskCustomsApiAdapter implements CustomsAdapter {
  private readonly client: FetchJsonClient | null;
  private readonly authorizationProvider: RiskCustomsApiAdapterOptions["authorizationProvider"];
  private readonly clock: () => Date;
  private readonly productionConnector: boolean;
  private readonly configurationBlocked: boolean;

  constructor(options?: RiskCustomsApiAdapterOptions) {
    this.authorizationProvider = options?.authorizationProvider;
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
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      this.configurationBlocked = false;
    } catch {
      this.client = null;
      this.configurationBlocked = true;
    }
  }

  async getStatus(
    input: Record<string, unknown>,
    context?: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<AdapterResult> {
    const contextResult = this.requireContext(context);
    if (contextResult !== null) return contextResult;
    if (!validDate(input.rule_date)) {
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
      const response = await this.fetchStatus(input.rule_date, context!, signal);
      const parsed = parseStatusResponse(response);
      if (parsed === null) {
        return failure("unavailable", "customs.status_contract_invalid", "RiskCustoms returned a status outside its verified M2M contract.");
      }
      const mapped = mappedStatus(parsed.value);
      if (mapped === null) {
        return failure("unavailable", "customs.status_mapping_invalid", "RiskCustoms status could not be mapped to the MCP contract.");
      }
      if (parsed.dataNotReady) {
        return {
          ...failure("unavailable", "customs.ready_false", "RiskCustoms is not ready; dependent customs search remains unavailable.", "ready"),
          data: mapped.data,
          sourceRefs: [mapped.sourceRef],
        };
      }
      return {
        status: "success",
        data: mapped.data,
        sourceRefs: [mapped.sourceRef],
        ...(parsed.value.ready && !parsed.value.testData
          ? {}
          : {
              warnings: [
                notice(
                  parsed.value.testData ? "customs.test_data_not_production" : "customs.ready_false",
                  parsed.value.testData
                    ? "RiskCustoms test data cannot be used as production data."
                    : "RiskCustoms is not ready; dependent customs search remains unavailable.",
                  "warning",
                  parsed.value.testData ? "testData" : "ready",
                ),
              ],
            }),
      };
    } catch (error: unknown) {
      return this.mapHttpFailure(error, "status");
    }
  }

  async search(
    input: Record<string, unknown>,
    context?: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<AdapterResult> {
    const contextResult = this.requireContext(context);
    if (contextResult !== null) return contextResult;
    if (signal?.aborted) return failure("unavailable", "customs.request_aborted", "The RiskCustoms request was aborted.");
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query.length === 0 || query.length > 200) {
      return failure("needs_input", "customs.query_required", "An explicit customs query is required.", "query");
    }
    const ruleDate = input.rule_date;
    if (!validDate(ruleDate)) {
      return failure("needs_input", "customs.rule_date_required", "A valid rule_date is required before searching RiskCustoms.", "rule_date");
    }
    const origin = this.originCountry(input.product_attributes);
    if (origin === null) {
      return failure("needs_input", "customs.origin_country_required", "The product origin country is required for the current RiskCustoms contract.", "product_attributes.origin_country");
    }
    if (origin !== "CN") {
      return failure("unavailable", "customs.origin_not_supported", "The current RiskCustoms contract supports China-origin goods only.", "product_attributes.origin_country");
    }
    const unavailable = this.available();
    if (unavailable !== null) return unavailable;

    try {
      const statusResponse = parseStatusResponse(await this.fetchStatus(ruleDate, context!, signal));
      if (statusResponse === null) {
        return failure("unavailable", "customs.status_contract_invalid", "RiskCustoms returned a status outside its verified M2M contract.");
      }
      const mapped = mappedStatus(statusResponse.value);
      if (mapped === null) {
        return failure("unavailable", "customs.status_mapping_invalid", "RiskCustoms status could not be mapped to the MCP contract.");
      }
      const gateFailure = this.readinessFailure(input, statusResponse.value, mapped.data, mapped.sourceRef);
      if (gateFailure !== null) return gateFailure;
      const body = this.queryBody(input, query, ruleDate);
      if (body === null) {
        return failure("needs_input", "customs.attributes_invalid", "Product attributes must contain only explicit scalar values.", "product_attributes");
      }
      const response = await this.fetchQuery(body, context!, signal);
      return this.mapResponse(input, ruleDate, response, statusResponse.value, mapped.sourceRef);
    } catch (error: unknown) {
      return this.mapHttpFailure(error, "query");
    }
  }

  estimate(
    input: Record<string, unknown>,
    context?: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<AdapterResult> {
    void input;
    void context;
    void signal;
    return Promise.resolve(failure("unavailable", "customs.estimate_unavailable", "当前 API 不提供正式税额估算。"));
  }

  private requireContext(context: ExecutionContext | undefined): AdapterResult | null {
    return context === undefined
      ? failure("blocked", "customs.execution_context_required", "RiskCustoms requires a server-authenticated execution context.")
      : null;
  }

  private available(): AdapterResult | null {
    if (this.configurationBlocked) return failure("blocked", "customs.endpoint_not_allowed", "The RiskCustoms endpoint is outside the configured security policy.");
    if (this.client === null || !this.productionConnector) return failure("unavailable", "customs.adapter_disabled", "The RiskCustoms M2M production connector is disabled until explicitly configured.");
    if (this.authorizationProvider === undefined) return failure("blocked", "customs.authorization_unconfigured", "RiskCustoms M2M authorization is not configured.");
    return null;
  }

  private async headers(context: ExecutionContext): Promise<Readonly<Record<string, string>>> {
    if (this.authorizationProvider === undefined) throw new Error("authorization unavailable");
    const token = await this.authorizationProvider(context);
    if (typeof token !== "string" || token.length === 0 || /\s/u.test(token)) throw new Error("authorization invalid");
    return {
      Authorization: `Bearer ${token}`,
      "X-Tenant-Id": context.tenantId,
    };
  }

  private async fetchStatus(ruleDate: string, context: ExecutionContext, signal?: AbortSignal): Promise<unknown> {
    return this.client!.get(
      `/api/m2m/status?ruleDate=${encodeURIComponent(ruleDate)}`,
      await this.headers(context),
      signal,
      [503],
    );
  }

  private async fetchQuery(body: Record<string, unknown>, context: ExecutionContext, signal?: AbortSignal): Promise<unknown> {
    return this.client!.post("/api/m2m/query", body, await this.headers(context), signal);
  }

  private mapHttpFailure(error: unknown, operation: "status" | "query"): AdapterResult {
    if (error instanceof HttpAdapterError) {
      if (error.status === 401) return failure("blocked", "customs.upstream_unauthorized", "RiskCustoms rejected the M2M credential.");
      if (error.status === 403) return failure("blocked", "customs.upstream_forbidden", "RiskCustoms rejected the M2M tenant authorization.");
      if (error.status === 429) return failure("unavailable", "customs.upstream_rate_limited", "RiskCustoms M2M rate limit is unavailable for this request.");
      if (error.status === 503 || error.code === "upstream_timeout" || error.code === "upstream_aborted") return failure("unavailable", `customs.${operation}_unavailable`, "RiskCustoms could not complete the bounded request.");
    }
    return failure("unavailable", `customs.${operation}_unavailable`, "RiskCustoms could not complete the request.");
  }

  private originCountry(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const origin = (value as Record<string, unknown>).origin_country;
    return origin === undefined || origin === null || origin === "" ? null : origin;
  }

  private readinessFailure(
    input: Record<string, unknown>,
    status: StatusResponse,
    data: Record<string, unknown>,
    sourceRef: SourceRef,
  ): AdapterResult | null {
    if (!status.ready) {
      return {
        ...failure("unavailable", "customs.ready_false", "RiskCustoms ready=false; no query was attempted.", "data_status.ready"),
        data: emptySearchData(input, data),
        sourceRefs: [sourceRef],
        warnings: [notice("customs.no_fallback", "No AI, stale, or non-authoritative fallback was used.", "warning")],
      };
    }
    if (status.testData) {
      return {
        ...failure("unavailable", "customs.test_data_not_production", "RiskCustoms test data cannot be used as production data.", "data_status.test_data"),
        data: emptySearchData(input, data),
        sourceRefs: [sourceRef],
      };
    }
    if (status.releaseIds.length === 0 || status.publishedAt === null || status.snapshotHash === null || status.releaseHash === null) {
      return {
        ...failure("unavailable", "customs.identity_incomplete", "RiskCustoms readiness identity is incomplete; no query was attempted."),
        data: emptySearchData(input, data),
        sourceRefs: [sourceRef],
      };
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
      if (typeof input.product_attributes !== "object" || Array.isArray(input.product_attributes)) return null;
      const value = input.product_attributes as Record<string, unknown>;
      for (const key of ["material", "use", "origin_country", "contains_steel_aluminum"] as const) {
        const item = value[key];
        if (item === undefined || item === null) continue;
        if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") return null;
        if (typeof item === "number" && !Number.isFinite(item)) return null;
        attributes[key === "origin_country" ? "originCountry" : key] = item;
      }
    }
    const selectedHs6 = input.selected_hs6;
    if (selectedHs6 !== undefined && selectedHs6 !== null && (typeof selectedHs6 !== "string" || !/^\d{6}$/u.test(selectedHs6))) return null;
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
    status: StatusResponse,
    statusRef: SourceRef,
  ): AdapterResult {
    const parsed = queryResponseSchema.safeParse(rawResponse);
    if (!parsed.success) return failure("unavailable", "customs.query_contract_invalid", "RiskCustoms returned a query response outside its verified M2M contract.");
    const response = parsed.data;
    if (!identitiesEqual(status, response) || !identitiesEqual(status, response.dataStatus)) {
      return failure("manual_review", "customs.identity_mismatch", "RiskCustoms status and query publication identities do not match.");
    }
    if (response.ruleDate !== ruleDate) return failure("unavailable", "customs.rule_date_mismatch", "RiskCustoms returned data for a different rule date.");
    if (!response.dataStatus.ready || response.testData || response.dataStatus.testData) {
      return failure("unavailable", "customs.query_not_ready", "RiskCustoms query data is not ready for M2M use.");
    }
    if (response.sources.length === 0) return failure("unavailable", "customs.sources_missing", "RiskCustoms returned no source references.");
    if (!validIdentifier(response.queryId)) return failure("unavailable", "customs.query_id_invalid", "RiskCustoms returned an invalid query identifier.");
    const modeMatches = input.query_kind === "exact_code"
      ? response.mode === "exact_code"
      : (input.query_kind === "name_search" || input.query_kind === "candidate_selection") && response.mode !== "exact_code";
    const requestedHs6 = input.selected_hs6;
    const selectedHs6Matches = input.query_kind === "candidate_selection"
      ? response.selectedHs6 === (requestedHs6 ?? null)
      : requestedHs6 === undefined || requestedHs6 === null || response.selectedHs6 === requestedHs6;
    if (!modeMatches || !selectedHs6Matches) return failure("manual_review", "customs.response_correlation_mismatch", "RiskCustoms response mode or selected HS6 does not match the request.");

    const responseValues = [...response.candidates, ...response.results];
    if (responseValues.some((value) => value.country !== "CA")) {
      return failure("manual_review", "customs.jurisdiction_mismatch", "RiskCustoms returned a classification outside the Canada query scope.");
    }
    const classificationSourceIds = new Set(responseValues.flatMap(candidateSourceIds));
    const sourceResult = this.mapSources(
      response.sources,
      response.releaseIds,
      classificationSourceIds,
      ruleDate,
    );
    if (sourceResult === null) return failure("unavailable", "customs.source_mapping_invalid", "RiskCustoms sources could not be mapped to the verified source contract.");
    const values = responseValues
      .map((value) => mappedClassification(value, classificationSourceIds, sourceResult.refIds));
    if (values.some((value) => value === null)) return failure("manual_review", "customs.source_reference_missing", "A RiskCustoms classification references an unavailable source.");
    const mappedValues = values.filter((value): value is NonNullable<typeof value> => value !== null);
    const byCode = new Map<string, Record<string, unknown>>();
    let hasUnconfirmed = false;
    for (const value of mappedValues) {
      const code = value.value.hs_code as string;
      const prior = byCode.get(code);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(value.value)) return failure("manual_review", "customs.classification_conflict", "RiskCustoms returned conflicting classifications for one HS code.");
      byCode.set(code, value.value);
      hasUnconfirmed ||= value.hasUnconfirmed;
    }
    const data = {
      version: `customs-search@${API_VERSION}`,
      query_id: response.queryId,
      jurisdiction: "CA" as const,
      query_kind: queryKind(input.query_kind),
      candidates: [...byCode.values()],
      next_questions: response.nextQuestion === null ? [] : [response.nextQuestion.label],
      data_status: statusData(response.dataStatus),
    };
    if (!dataStatusSchema.safeParse(data.data_status).success || !customsSearchResultSchema.safeParse(data).success) return failure("unavailable", "customs.result_mapping_invalid", "RiskCustoms query could not be mapped to the MCP contract.");
    return {
      status: "success",
      data,
      sourceRefs: [statusRef, ...sourceResult.refs],
      assumptions: hasUnconfirmed ? [notice("customs.candidate_only", "HS candidates are not formal classification conclusions.", "info")] : [],
      warnings: hasUnconfirmed ? [notice("customs.numeric_confidence_not_provided", "RiskCustoms does not provide numeric confidence; non-confirmed classifications remain at confidence 0.", "warning")] : [],
      reviewStatus: hasUnconfirmed ? "pending" : "not_required",
    };
  }

  private mapSources(
    sources: readonly Source[],
    releaseIds: readonly string[],
    usedSourceIds: ReadonlySet<string>,
    ruleDate: string,
  ): { readonly refs: readonly SourceRef[]; readonly refIds: ReadonlyMap<string, string> } | null {
    const refs: SourceRef[] = [];
    const refIds = new Map<string, string>();
    const seen = new Set<string>();
    for (const source of sources) {
      if (seen.has(source.id)) return null;
      seen.add(source.id);
      if (!usedSourceIds.has(source.id)) continue;
      if (
        !releaseIds.includes(source.releaseId) ||
        !validIdentifier(source.releaseId) ||
        source.effectiveFrom > ruleDate ||
        (source.effectiveTo !== null && ruleDate >= source.effectiveTo)
      ) return null;
      const sourceRef: SourceRef = {
        source_id: sourceRefId(source.id),
        source_type: "official_source",
        system: "RiskCustoms",
        locator: source.officialUrl,
        version: source.releaseId,
        retrieved_at: this.clock().toISOString(),
        authority: "authoritative",
        content_hash: hashPayload(source),
      };
      if (!sourceRefSchema.safeParse(sourceRef).success) return null;
      refs.push(sourceRef);
      refIds.set(source.id, sourceRef.source_id);
    }
    return refs.length === usedSourceIds.size ? { refs, refIds } : null;
  }
}
