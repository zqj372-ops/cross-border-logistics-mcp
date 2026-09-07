import type { z } from "zod";
import {
  QueryResponseSchema,
  type SourceRefSchema,
  type CandidateSchema,
  type CountryResult,
  type QueryRequest,
  type QueryResponse,
  type RateLine,
} from "../../shared/contracts/query";
import { detectQueryKind, normalizeCode } from "../../shared/domain/code";
import { toSearchTerms } from "../../shared/domain/search-terms";
import type { RateInput } from "../../shared/domain/rates";
import type { CandidateAssistant } from "../ai/adapter";
import type {
  Country,
  NomenclatureRow,
  PublicationSnapshotRow,
  RequirementRow,
  SourceRow,
  TariffRuleRow,
  TradeCountry,
  TradeMeasureRow,
} from "../repositories/customs";
import { evaluateDocuments } from "../rules/evaluate-documents";
import { evaluateMeasures } from "../rules/evaluate-measures";
import { evaluateRates } from "../rules/evaluate-rates";
import {
  APPROVED_QUESTION_IDS,
  getApprovedQuestion,
  isApprovedAttribute,
} from "./question-policy";
import { normalizeIsoDateTime } from "./publication-identity";

type SourceRef = z.infer<typeof SourceRefSchema>;
type Candidate = z.infer<typeof CandidateSchema>;
interface SourceEvidence {
  readonly id: string;
  readonly releaseId: string;
  readonly artifactId: string;
  readonly sourceLocator: string;
}

type SourceBearingRow = { readonly release_id: string; readonly artifact_id: string; readonly source_locator: string };

export interface CustomsRepositoryLike {
  findExactCode(country: Country, code: string, ruleDate: string): Promise<NomenclatureRow[]>;
  searchNames(searchTerms: string, ruleDate: string, limit: number): Promise<NomenclatureRow[]>;
  findByHs6(hs6: string, country: Country, ruleDate: string): Promise<NomenclatureRow[]>;
  findHierarchy(nomenclatureId: number, ruleDate: string): Promise<NomenclatureRow[]>;
  findTariffRules(country: Country, code: string, ruleDate: string): Promise<TariffRuleRow[]>;
  findTradeMeasures(country: TradeCountry, code: string, ruleDate: string): Promise<TradeMeasureRow[]>;
  findRequirements(country: Country, ruleDate: string): Promise<RequirementRow[]>;
  findSources(releaseIds: string[]): Promise<SourceRow[]>;
  findPublicationSnapshot(ruleDate: string): Promise<PublicationSnapshotRow | null>;
  readonly testData?: boolean;
}

export class QueryServiceError extends Error {
  public constructor(public readonly code: "INVALID_CANDIDATE" | "CODE_COUNTRY_NOT_FOUND", message: string) {
    super(message);
    this.name = "QueryServiceError";
  }
}

const COUNTRIES: readonly Country[] = ["CN", "US", "CA"];
const RESULT_SIDE: Record<Country, RequirementRow["side"]> = {
  CN: "cn_export",
  US: "us_import",
  CA: "ca_import",
};

function rowHs6(row: NomenclatureRow): string | null {
  if (row.concept_code && /^\d{6}$/u.test(row.concept_code)) return row.concept_code;
  return /^\d{6,10}$/u.test(row.code) ? row.code.slice(0, 6) : null;
}

function uniqueRows(rows: readonly NomenclatureRow[]): NomenclatureRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.country}:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObjectOrRaw(value: string | null | undefined): Record<string, unknown> | string | undefined {
  if (!value) return undefined;
  const parsed = parseJsonObject(value);
  return parsed ?? value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Only reviewed question attributes may cross the optional model boundary.
 * The full request attributes remain available to deterministic document and
 * trade-measure evaluation, but arbitrary caller keys (for example costs,
 * rates, source URLs, or credentials) must never be serialized to an
 * external AI provider.
 */
function assistantAttributes(attributes: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key, value]) => isApprovedAttribute(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")),
  );
}

function validComponent(record: Record<string, unknown>, kind: string): boolean {
  if (kind === "free") return true;
  if (kind === "ad_valorem") return typeof record.percent === "string" && record.percent.trim().length > 0;
  if (kind === "specific") return typeof record.amount === "string" && record.amount.trim().length > 0;
  if (kind === "compound") return Array.isArray(record.components);
  if (kind === "text") return typeof record.text === "string" && record.text.trim().length > 0;
  return false;
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function categoryForRule(rule: TariffRuleRow): RateInput["category"] {
  const value = `${rule.measure_type} ${rule.id}`.toLocaleLowerCase("en-US");
  if (value.includes("provisional")) return "provisional_export_duty";
  if (value.includes("export")) return "export_duty";
  if (value.includes("trade remedy") || value.includes("remedy") || value.includes("sima") || value.includes("antidumping") || value.includes("anti-dumping") || value.includes("countervailing")) return "trade_remedy";
  if (value.includes("additional") || value.includes("301") || value.includes("232")) return "additional_duty";
  if (value.includes("excise duty") || value.includes("excise_duty")) return "excise_duty";
  if (value.includes("excise tax") || value.includes("excise_tax")) return "excise_tax";
  if (value.includes("gst")) return "gst";
  if (value.includes("official fee") || value.includes("official_fee")) return "official_fee";
  if (value.includes("tax")) return "tax";
  if (value.includes("fee")) return "fee";
  return "base_duty";
}

function rateDisplay(line: RateInput & { readonly rateExpressionRaw: string }): string {
  if (line.kind === "free") return "Free";
  if (line.kind === "ad_valorem") return typeof line.percent === "string" ? `${line.percent}%` : line.rateExpressionRaw;
  if (line.kind === "specific") return typeof line.amount === "string" ? `${line.amount} ${line.currency ?? ""}/${line.unit ?? ""}`.trim() : line.rateExpressionRaw;
  if (line.kind === "compound") return line.rateExpressionRaw;
  return typeof line.text === "string" && line.text.length > 0 ? line.text : line.rateExpressionRaw;
}

function sourceIdForRow(row: SourceBearingRow): string {
  return `source:${row.release_id}:${row.artifact_id}:${row.source_locator}`;
}

function addSourceEvidence(evidence: Map<string, SourceEvidence>, row: SourceBearingRow): string {
  const id = sourceIdForRow(row);
  evidence.set(id, { id, releaseId: row.release_id, artifactId: row.artifact_id, sourceLocator: row.source_locator });
  return id;
}

function sourceRef(source: SourceRow, evidence: SourceEvidence): SourceRef {
  return {
    id: evidence.id,
    releaseId: evidence.releaseId,
    artifactId: evidence.artifactId,
    authority: source.authority,
    dataset: source.dataset,
    edition: source.edition,
    revision: source.revision,
    officialUrl: source.official_url,
    publishedAt: source.published_at,
    effectiveFrom: source.effective_from,
    effectiveTo: source.effective_to,
    retrievedAt: source.retrieved_at,
    sourceLocator: evidence.sourceLocator,
  };
}

export async function publicationGateHash(
  releaseManifestHashes: readonly { readonly releaseId: string; readonly manifestSha256: string }[],
  approvalIds: readonly string[],
): Promise<string> {
  const canonical = [...releaseManifestHashes
    .map((entry) => `${entry.releaseId}:${entry.manifestSha256.toLocaleLowerCase("en-US")}`), ...approvalIds]
    .sort()
    .join("|");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function publicationStatus(snapshot: PublicationSnapshotRow | null, usedReleaseIds: readonly string[], releaseRows: readonly SourceRow[]): Promise<{
  readonly dataStatus: QueryResponse["dataStatus"];
  readonly testData: boolean;
}> {
  const parseStringArray = (value: string | null | undefined): string[] | null => {
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.length > 0) ? parsed : null;
    } catch {
      return null;
    }
  };
  const snapshotReleaseIds = parseStringArray(snapshot?.release_ids_json) ?? [];
  const snapshotApprovalIds = parseStringArray(snapshot?.approval_ids_json);
  const parsedReasons = (() => {
    if (typeof snapshot?.reasons_json !== "string") return { valid: false, values: [] as string[] };
    try {
      const value: unknown = JSON.parse(snapshot.reasons_json);
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? { valid: true, values: value }
        : { valid: false, values: [] as string[] };
    } catch {
      return { valid: false, values: [] as string[] };
    }
  })();
  const releaseSet = new Set(snapshotReleaseIds);
  const uniqueReleaseIds = releaseSet.size === snapshotReleaseIds.length;
  const uniqueApprovalIds = snapshotApprovalIds !== null && new Set(snapshotApprovalIds).size === snapshotApprovalIds.length;
  const allUsedReleasesCovered = usedReleaseIds.every((releaseId) => releaseSet.has(releaseId));
  const gateHashValid = typeof snapshot?.gate_report_sha256 === "string" && /^[a-f0-9]{64}$/iu.test(snapshot.gate_report_sha256);
  const snapshotGateHash = gateHashValid && typeof snapshot?.gate_report_sha256 === "string"
    ? snapshot.gate_report_sha256.toLocaleLowerCase("en-US")
    : null;
  const snapshotRows = new Map(releaseRows.map((row) => [row.id, row]));
  const releaseIdentity = snapshotReleaseIds.flatMap((releaseId) => {
    const row = snapshotRows.get(releaseId);
    return row && row.status === "published" && /^[a-f0-9]{64}$/iu.test(row.manifest_sha256) ? [{ releaseId, manifestSha256: row.manifest_sha256 }] : [];
  });
  const hasAllReleaseRows = snapshotReleaseIds.length > 0 && uniqueReleaseIds && releaseIdentity.length === snapshotReleaseIds.length;
  const approvalsCoverReleases = snapshotApprovalIds !== null && uniqueApprovalIds && snapshotApprovalIds.length === snapshotReleaseIds.length;
  const expectedGateHash = snapshotApprovalIds === null || !hasAllReleaseRows
    ? null
    : await publicationGateHash(releaseIdentity, snapshotApprovalIds);
  const evaluatedAt = normalizeIsoDateTime(snapshot?.evaluated_at);
  const lastSourceCheckAt = normalizeIsoDateTime(snapshot?.last_source_check_at);
  const evaluatedAtValid = evaluatedAt !== null;
  const lastSourceCheckAtValid = snapshot?.last_source_check_at == null || lastSourceCheckAt !== null;
  const testData = snapshot?.test_data === 0 ? false : true;
  const ready = snapshot?.ready === 1 && !testData && parsedReasons.valid && parsedReasons.values.length === 0 && evaluatedAtValid && lastSourceCheckAtValid && allUsedReleasesCovered && hasAllReleaseRows && approvalsCoverReleases && gateHashValid && expectedGateHash !== null && snapshotGateHash !== null && expectedGateHash === snapshotGateHash;
  const reasons = [...parsedReasons.values];
  if (snapshot?.ready === 1 && !parsedReasons.valid) reasons.push("Publication snapshot reasons are invalid.");
  if (snapshot?.ready === 1 && parsedReasons.valid && parsedReasons.values.length > 0) reasons.push("Publication snapshot contains readiness reasons.");
  if (snapshot?.ready === 1 && testData) reasons.push("Publication snapshot is marked as test data or lacks a production marker.");
  if (snapshot?.ready === 1 && !allUsedReleasesCovered) reasons.push("Publication snapshot does not cover every release used by this result.");
  if (snapshot?.ready === 1 && snapshotReleaseIds.length === 0) reasons.push("Publication snapshot release IDs are invalid.");
  if (snapshot?.ready === 1 && !uniqueReleaseIds) reasons.push("Publication snapshot contains duplicate release identities.");
  if (snapshot?.ready === 1 && snapshotApprovalIds === null) reasons.push("Publication snapshot approval IDs are invalid.");
  if (snapshot?.ready === 1 && snapshotApprovalIds !== null && !uniqueApprovalIds) reasons.push("Publication snapshot contains duplicate approval identities.");
  if (snapshot?.ready === 1 && snapshotApprovalIds !== null && !approvalsCoverReleases) reasons.push("Publication snapshot approval identities do not match the release count.");
  if (snapshot?.ready === 1 && !gateHashValid) reasons.push("Publication snapshot gate hash is invalid.");
  if (snapshot?.ready === 1 && !evaluatedAtValid) reasons.push("Publication snapshot evaluatedAt is invalid.");
  if (snapshot?.ready === 1 && !lastSourceCheckAtValid) reasons.push("Publication snapshot lastSourceCheckAt is invalid.");
  if (snapshot?.ready === 1 && hasAllReleaseRows && snapshotApprovalIds !== null && expectedGateHash !== null && snapshotGateHash !== null && expectedGateHash !== snapshotGateHash) reasons.push("Publication snapshot gate identity does not match release manifests and approvals.");
  return {
    dataStatus: {
      evaluatedAt: evaluatedAt ?? new Date().toISOString(),
      lastSourceCheckAt,
      ready,
      reasons: ready ? [] : (reasons.length > 0 ? reasons : ["No reviewed publication snapshot is available."]),
    },
    testData,
  };
}

export function queryAuditMetadata(response: Pick<QueryResponse, "mode" | "sources" | "results" | "candidates">): {
  readonly releaseIds: string[];
  readonly ruleIds: string[];
  readonly resultStatus: string;
  readonly degraded: boolean;
} {
  const releaseIds = [...new Set(response.sources.map((source) => source.releaseId))].sort();
  const ruleIds = [...new Set(response.results.flatMap((result) => [
    ...result.rates.map((rate) => rate.id.split(":", 1)[0] ?? rate.id),
    ...result.documents.map((document) => document.id),
    ...result.measures.map((measure) => measure.id),
  ]))].sort();
  const statuses = response.results.map((result) => result.status);
  const resultStatus = statuses.includes("manual_review")
    ? "manual_review"
    : statuses.includes("candidate")
      ? "candidate"
      : statuses.includes("possible")
        ? "possible"
        : statuses.includes("confirmed")
          ? "confirmed"
          : response.candidates.length > 0 ? "candidate" : "not_found";
  return { releaseIds, ruleIds, resultStatus, degraded: response.mode === "degraded_search" };
}

interface CandidateGroup {
  readonly hs6: string;
  readonly rows: readonly NomenclatureRow[];
}

function chineseExplanationForRow(row: NomenclatureRow, sourceId: string): Candidate["chineseExplanation"] {
  if (row.language.toLocaleLowerCase("en-US").startsWith("zh")) {
    return {
      translationId: `translation:${sourceId}`,
      text: row.description_original,
      status: "not_needed",
      basedOnSourceIds: [sourceId],
    };
  }
  return {
    translationId: `translation:${sourceId}`,
    text: "暂无已审核中文翻译，请核对原文",
    status: "not_needed",
    basedOnSourceIds: [sourceId],
  };
}

export class QueryService {
  public constructor(
    private readonly repository: CustomsRepositoryLike,
    private readonly assistant: CandidateAssistant,
  ) {}

  public async query(request: QueryRequest): Promise<QueryResponse> {
    const queryKind = detectQueryKind(request.query);
    if (queryKind === "code") return this.queryCode(request);
    return this.queryName(request);
  }

  private async queryCode(request: QueryRequest): Promise<QueryResponse> {
    const normalizedCode = normalizeCode(request.query);
    const matches = new Map<Country, NomenclatureRow[]>();
    for (const country of COUNTRIES) {
      const rows = await this.repository.findExactCode(country, normalizedCode, request.ruleDate);
      if (rows.length > 0) matches.set(country, rows);
    }

    const matchedCountries = [...matches.keys()];
    if (!request.codeCountry && matchedCountries.length > 1) {
      const sourceIds = new Set<string>();
      const sourceEvidence = new Map<string, SourceEvidence>();
      const ambiguousRows = this.capRowsByCountry(uniqueRows([...matches.values()].flat()));
      const candidates = await this.makeCandidates(ambiguousRows, "candidate", "精确编码命中；国家税则来源存在歧义", request.ruleDate, sourceIds, sourceEvidence);
      const candidateHs6 = new Set(candidates.flatMap((candidate) => candidate.hs6 ? [candidate.hs6] : []));
      if (request.selectedHs6 && !candidateHs6.has(request.selectedHs6)) {
        throw new QueryServiceError("INVALID_CANDIDATE", "selectedHs6 is not present in the current exact-code candidate set.");
      }
      return this.finalizeResponse({
        queryId: crypto.randomUUID(),
        mode: "exact_code",
        ruleDate: request.ruleDate,
        selectedHs6: request.selectedHs6 ?? null,
        nextQuestion: this.questionPayload("codeCountry"),
        candidates: request.selectedHs6 ? [] : candidates,
        results: [],
        sourceIds,
        sourceEvidence,
        dataSnapshot: await this.repository.findPublicationSnapshot(request.ruleDate),
      });
    }

    const anchorCountry = request.codeCountry ?? matchedCountries[0];
    if (!anchorCountry || !matches.has(anchorCountry)) {
      if (request.codeCountry) throw new QueryServiceError("CODE_COUNTRY_NOT_FOUND", `No exact ${request.codeCountry} schedule contains ${normalizedCode}.`);
      return this.finalizeResponse({
        queryId: crypto.randomUUID(),
        mode: "exact_code",
        ruleDate: request.ruleDate,
        selectedHs6: null,
        nextQuestion: null,
        candidates: [],
        results: [],
        sourceIds: new Set(),
        sourceEvidence: new Map(),
        dataSnapshot: await this.repository.findPublicationSnapshot(request.ruleDate),
      });
    }

    const anchorRow = matches.get(anchorCountry)![0]!;
    const selectedHs6 = rowHs6(anchorRow);
    const sourceIds = new Set<string>();
    const sourceEvidence = new Map<string, SourceEvidence>();
    const usedRows: NomenclatureRow[] = [];
    const resultRows = new Map<Country, { readonly row: NomenclatureRow; readonly exact: boolean }>();
    for (const country of COUNTRIES) {
      let rows = matches.get(country) ?? [];
      if (rows.length === 0 && selectedHs6) rows = await this.repository.findByHs6(selectedHs6, country, request.ruleDate);
      const row = rows.find((candidate) => candidate.code === normalizedCode) ?? rows[0];
      if (!row) continue;
      usedRows.push(row);
      resultRows.set(country, { row, exact: row.code === normalizedCode && country === anchorCountry });
    }

    const candidates = await this.makeCandidates(this.capRowsByCountry(uniqueRows(usedRows)), "candidate", "通过共同 HS6 关联；不表示国家编码一对一等同", request.ruleDate, sourceIds, sourceEvidence);
    const candidateHs6 = new Set(candidates.flatMap((candidate) => candidate.hs6 ? [candidate.hs6] : []));
    if (request.selectedHs6 && !candidateHs6.has(request.selectedHs6)) {
      throw new QueryServiceError("INVALID_CANDIDATE", "selectedHs6 is not present in the current exact-code candidate set.");
    }
    if (!request.selectedHs6) {
      return this.finalizeResponse({
        queryId: crypto.randomUUID(),
        mode: "exact_code",
        ruleDate: request.ruleDate,
        selectedHs6: null,
        nextQuestion: null,
        candidates,
        results: [],
        sourceIds,
        sourceEvidence,
        dataSnapshot: await this.repository.findPublicationSnapshot(request.ruleDate),
      });
    }
    const results: CountryResult[] = [];
    for (const country of COUNTRIES) {
      const item = resultRows.get(country);
      if (!item) continue;
      results.push(await this.buildCountryResult(item.row, item.exact ? "confirmed" : "candidate", item.exact ? "精确编码命中" : "通过共同 HS6 关联；不表示国家编码一对一等同", request, sourceIds, sourceEvidence));
    }

    return this.finalizeResponse({
      queryId: crypto.randomUUID(),
      mode: "exact_code",
      ruleDate: request.ruleDate,
      selectedHs6,
      nextQuestion: null,
      candidates,
      results,
      sourceIds,
      sourceEvidence,
      dataSnapshot: await this.repository.findPublicationSnapshot(request.ruleDate),
    });
  }

  private async queryName(request: QueryRequest): Promise<QueryResponse> {
    const terms = toSearchTerms(request.query);
    const searched = await this.repository.searchNames(terms, request.ruleDate, 30);
    const groups = this.groupRows(searched);
    const rankedGroups = await this.rankGroups(request.query, groups, assistantAttributes(request.attributes));
    const candidateGroups = rankedGroups.slice(0, 3);
    const currentHs6 = new Set(candidateGroups.map((group) => group.hs6));
    if (request.selectedHs6 && !currentHs6.has(request.selectedHs6)) {
      throw new QueryServiceError("INVALID_CANDIDATE", "selectedHs6 is not present in the current query/date candidate set.");
    }

    const sourceIds = new Set<string>();
    const sourceEvidence = new Map<string, SourceEvidence>();
    const candidateRows = this.capRowsByCountry(uniqueRows(candidateGroups.flatMap((group) => [...group.rows])));
    const candidates = await this.makeCandidates(candidateRows, "candidate", "匹配已审核名称或别名；需确认 HS6 候选", request.ruleDate, sourceIds, sourceEvidence);
    if (!request.selectedHs6) {
      const answered = Object.keys(request.attributes).filter(isApprovedAttribute);
      const preferredQuestion = request.query.includes("保温") ? "vacuumInsulated" : undefined;
      // A single unambiguous name does not need a follow-up. For materially
      // different groups, expose only the reviewed policy IDs; the assistant
      // may choose one of them, never invent a legal question.
      const approvedQuestionIds = preferredQuestion
        ? [preferredQuestion]
        : candidateGroups.length > 1
          ? [...APPROVED_QUESTION_IDS]
          : [];
      const questionId = candidateGroups.length === 0 ? null : await this.assistant.chooseQuestion({
        query: request.query,
        candidates: candidateGroups.map((group) => ({ id: group.hs6, legalNames: group.rows.map((row) => row.description_original) })),
        answeredAttributes: answered,
        attributes: assistantAttributes(request.attributes),
        approvedQuestionIds,
      });
      return this.finalizeResponse({
        queryId: crypto.randomUUID(),
        mode: "name_search",
        ruleDate: request.ruleDate,
        selectedHs6: null,
        nextQuestion: questionId ? this.questionPayload(questionId) : null,
        candidates,
        results: [],
        sourceIds,
        sourceEvidence,
        dataSnapshot: await this.repository.findPublicationSnapshot(request.ruleDate),
      });
    }

    const selectedGroup = candidateGroups.find((group) => group.hs6 === request.selectedHs6)!;
    const resultRows = new Map<Country, NomenclatureRow>();
    for (const country of COUNTRIES) {
      const direct = selectedGroup.rows.find((row) => row.country === country);
      const mapped = direct ? [direct] : await this.repository.findByHs6(selectedGroup.hs6, country, request.ruleDate);
      const row = mapped[0];
      if (row) resultRows.set(country, row);
    }
    const results: CountryResult[] = [];
    for (const country of COUNTRIES) {
      const row = resultRows.get(country);
      if (!row) continue;
      results.push(await this.buildCountryResult(row, "candidate", "匹配已审核名称或别名；通过用户选择的 HS6 候选", request, sourceIds, sourceEvidence));
    }
    return this.finalizeResponse({
      queryId: crypto.randomUUID(),
      mode: "name_search",
      ruleDate: request.ruleDate,
      selectedHs6: request.selectedHs6,
      nextQuestion: null,
      candidates,
      results,
      sourceIds,
      sourceEvidence,
      dataSnapshot: await this.repository.findPublicationSnapshot(request.ruleDate),
    });
  }

  private groupRows(rows: readonly NomenclatureRow[]): CandidateGroup[] {
    const groups = new Map<string, NomenclatureRow[]>();
    for (const row of rows) {
      const hs6 = rowHs6(row);
      if (!hs6) continue;
      const list = groups.get(hs6) ?? [];
      list.push(row);
      groups.set(hs6, list);
    }
    return [...groups.entries()].map(([hs6, groupRows]) => ({ hs6, rows: uniqueRows(groupRows) }));
  }

  private capRowsByCountry(rows: readonly NomenclatureRow[]): NomenclatureRow[] {
    const seen = new Set<string>();
    const capped: NomenclatureRow[] = [];
    for (const row of rows) {
      const key = `${rowHs6(row) ?? "unknown"}:${row.country}`;
      if (seen.has(key)) continue;
      seen.add(key);
      capped.push(row);
    }
    return capped.slice(0, 3 * COUNTRIES.length);
  }

  private async rankGroups(query: string, groups: CandidateGroup[], attributes: Record<string, string | number | boolean>): Promise<CandidateGroup[]> {
    if (groups.length < 2) return groups;
    const rankedIds = await this.assistant.rankCandidateIds({
      query,
      candidates: groups.map((group) => ({ id: group.hs6, legalNames: group.rows.map((row) => row.description_original) })),
      attributes,
      approvedQuestionIds: [...APPROVED_QUESTION_IDS],
    });
    const byId = new Map(groups.map((group) => [group.hs6, group]));
    const ranked = rankedIds.flatMap((id) => {
      const group = byId.get(id);
      return group ? [group] : [];
    });
    return [...ranked, ...groups.filter((group) => !rankedIds.includes(group.hs6))];
  }

  private questionPayload(id: string): QueryResponse["nextQuestion"] {
    const question = getApprovedQuestion(id);
    if (!question) return null;
    return {
      id: question.id,
      label: question.label,
      attribute: question.attribute,
      options: [...question.options],
    };
  }

  private async makeCandidates(
    rows: readonly NomenclatureRow[],
    status: Candidate["status"],
    reason: string,
    ruleDate: string,
    sourceIds: Set<string>,
    sourceEvidence: Map<string, SourceEvidence>,
  ): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const row of rows) {
      const hierarchyRows = await this.repository.findHierarchy(row.id, ruleDate);
      const hierarchy = hierarchyRows.length > 0 ? hierarchyRows : [row];
      for (const hierarchyRow of hierarchy) sourceIds.add(addSourceEvidence(sourceEvidence, hierarchyRow));
      const rowSourceId = addSourceEvidence(sourceEvidence, row);
      sourceIds.add(rowSourceId);
      const toLegalName = (item: NomenclatureRow) => ({ language: item.language, text: item.description_original, sourceId: addSourceEvidence(sourceEvidence, item) });
      candidates.push({
        candidateId: `${row.country}:${row.id}`,
        country: row.country,
        code: row.code,
        displayCode: row.display_code,
        codeDigits: row.code_digits,
        parentCode: row.parent_code,
        hierarchy: hierarchy.map((item) => ({ code: item.code, displayCode: item.display_code, codeDigits: item.code_digits, legalNames: [toLegalName(item)] })),
        legalNames: [toLegalName(row)],
        chineseExplanation: chineseExplanationForRow(row, rowSourceId),
        classificationReason: reason,
        classificationSourceIds: [rowSourceId],
        status,
        hs6: rowHs6(row),
      });
    }
    return candidates;
  }

  private async buildCountryResult(
    row: NomenclatureRow,
    status: Candidate["status"],
    classificationReason: string,
    request: QueryRequest,
    sourceIds: Set<string>,
    sourceEvidence: Map<string, SourceEvidence>,
  ): Promise<CountryResult> {
    const hierarchyRows = await this.repository.findHierarchy(row.id, request.ruleDate);
    const hierarchy = hierarchyRows.length > 0 ? hierarchyRows : [row];
    for (const item of hierarchy) sourceIds.add(addSourceEvidence(sourceEvidence, item));
    const rowSourceId = addSourceEvidence(sourceEvidence, row);
    sourceIds.add(rowSourceId);

    const tariffRows = await this.repository.findTariffRules(row.country, row.code, request.ruleDate);
    for (const tariffRow of tariffRows) sourceIds.add(addSourceEvidence(sourceEvidence, tariffRow));
    const rateInputs = tariffRows.flatMap((rule) => this.rateInputs(rule, sourceEvidence));
    const rateEvaluation = evaluateRates(rateInputs, {
      country: row.country,
      ...(row.country === "CN" ? {} : { originCountry: "CN" }),
      ruleDate: request.ruleDate,
    });
    const rates = rateEvaluation.lines.map((line) => this.toRateLine(line, tariffRows.find((rule) => line.id.startsWith(`${rule.id}:`)) ?? tariffRows[0], request.ruleDate));

    const requirementRows = await this.repository.findRequirements(row.country, request.ruleDate);
    for (const requirement of requirementRows) sourceIds.add(addSourceEvidence(sourceEvidence, requirement));
    const documents = evaluateDocuments(requirementRows, { side: RESULT_SIDE[row.country], attributes: request.attributes, sourceIdForRow: (requirement) => addSourceEvidence(sourceEvidence, requirement) });

    let measures: CountryResult["measures"] = [];
    if (row.country === "US" || row.country === "CA") {
      const measureRows = await this.repository.findTradeMeasures(row.country, row.code, request.ruleDate);
      for (const measure of measureRows) sourceIds.add(addSourceEvidence(sourceEvidence, measure));
      const identity = typeof request.attributes.exporterOrProducer === "string" ? request.attributes.exporterOrProducer : undefined;
      measures = evaluateMeasures(measureRows, { code: row.code, originCountry: "CN", ...(identity ? { exporterOrProducer: identity } : {}), sourceIdForRow: (measure) => addSourceEvidence(sourceEvidence, measure) });
    }

    const toLegalName = (item: NomenclatureRow) => ({ language: item.language, text: item.description_original, sourceId: addSourceEvidence(sourceEvidence, item) });
    const warnings = [...rateEvaluation.reasons];
    if (!row.language.toLocaleLowerCase("en-US").startsWith("zh")) warnings.push("暂无已审核中文翻译，请核对原文。");
    for (const document of documents) if (document.status === "manual_review") warnings.push(`${document.label}: ${document.reason}`);
    for (const measure of measures) if (measure.matchStatus === "manual_review") warnings.push(`${measure.label}: manual review required`);
    return {
      candidateId: `${row.country}:${row.id}`,
      country: row.country,
      code: row.code,
      displayCode: row.display_code,
      codeDigits: row.code_digits,
      parentCode: row.parent_code,
      hierarchy: hierarchy.map((item) => ({ code: item.code, displayCode: item.display_code, codeDigits: item.code_digits, legalNames: [toLegalName(item)] })),
      legalNames: [toLegalName(row)],
      chineseExplanation: chineseExplanationForRow(row, rowSourceId),
      classificationReason,
      classificationSourceIds: [rowSourceId],
      status,
      hs6: rowHs6(row),
      rates,
      confirmedTotalPercent: rateEvaluation.confirmedTotalPercent,
      documents,
      measures,
      warnings,
    };
  }

  private rateInputs(rule: TariffRuleRow, sourceEvidence: Map<string, SourceEvidence>): RateInput[] {
    const parsedComponents = parseJsonArray(rule.rate_components_json);
    const components = parsedComponents.length > 0 ? parsedComponents : [{ kind: "text", text: rule.rate_expression_raw }];
    const ruleSourceId = addSourceEvidence(sourceEvidence, rule);
    const ruleRecord = rule as unknown as Record<string, unknown>;
    return components.map((component, index) => {
      const record = typeof component === "object" && component !== null ? component as Record<string, unknown> : { kind: "text", text: String(component) };
      const rawKind = typeof record.kind === "string" ? record.kind : "unknown";
      const kind = rawKind === "free" || rawKind === "ad_valorem" || rawKind === "specific" || rawKind === "compound" || rawKind === "text" ? rawKind : "text";
      const componentIsValid = validComponent(record, rawKind);
      const valueBasis = nonEmptyString(record.valueBasis ?? record.value_basis ?? record.basis ?? ruleRecord.valueBasis ?? ruleRecord.value_basis ?? ruleRecord.basis);
      const interactionRaw = typeof rule.interaction_json === "string" ? parseJsonObjectOrRaw(rule.interaction_json) : undefined;
      const base: Record<string, unknown> = {
        ...record,
        id: `${rule.id}:${index}`,
        kind,
        category: categoryForRule(rule),
        confirmed: rule.parse_status === "confirmed" && componentIsValid,
        rateExpressionRaw: nonEmptyString(record.rateExpressionRaw ?? record.rate_expression_raw) ?? (rule.rate_expression_raw || "Unparseable rate component"),
        treatment: rule.treatment,
        country: rule.country,
        originCountry: rule.origin_country ?? undefined,
        effectiveFrom: rule.effective_from,
        effectiveTo: rule.effective_to,
        priority: rule.priority,
        interaction: interactionRaw,
        conditions: rule.conditions_json,
        conditionText: rule.condition_text_raw,
        sourceId: ruleSourceId,
      };
      if (valueBasis) base.valueBasis = valueBasis;
      return base as RateInput;
    });
  }

  private toRateLine(line: ReturnType<typeof evaluateRates>["lines"][number], rule: TariffRuleRow | undefined, ruleDate: string): RateLine {
    const input = line as RateInput & { readonly rateExpressionRaw: string };
    if (typeof input.sourceId !== "string" && !rule) {
      throw new Error("Rate line is missing its exact source row.");
    }
    const category = (input.category === "export_duty" || input.category === "provisional_export_duty" || input.category === "base_duty" || input.category === "additional_duty" || input.category === "trade_remedy" || input.category === "excise_duty" || input.category === "excise_tax" || input.category === "gst" || input.category === "official_fee" || input.category === "tax" || input.category === "fee" ? input.category : "base_duty") as RateLine["category"];
    const from = typeof input.effectiveFrom === "string" ? input.effectiveFrom : rule?.effective_from ?? ruleDate;
    const to = typeof input.effectiveTo === "string" || input.effectiveTo === null ? input.effectiveTo : rule?.effective_to ?? null;
    return {
      id: input.id,
      label: typeof input.treatment === "string" ? input.treatment : category,
      treatment: typeof input.treatment === "string" ? input.treatment : category,
      category,
      kind: input.kind,
      rateExpressionRaw: input.rateExpressionRaw,
      displayValue: rateDisplay(input),
      confirmed: input.confirmed && line.status !== "manual_review",
      includedInConfirmedTotal: line.includedInConfirmedTotal,
      effectiveFrom: from,
      effectiveTo: to,
      conditionText: typeof input.conditionText === "string" ? input.conditionText : rule?.condition_text_raw ?? "",
      interactionNote: line.interactionNote,
      sourceId: typeof input.sourceId === "string" ? input.sourceId : sourceIdForRow(rule!),
    };
  }

  private async finalizeResponse(input: {
    readonly queryId: string;
    readonly mode: QueryResponse["mode"];
    readonly ruleDate: string;
    readonly selectedHs6: string | null;
    readonly nextQuestion: QueryResponse["nextQuestion"];
    readonly candidates: Candidate[];
    readonly results: CountryResult[];
    readonly sourceIds: Set<string>;
    readonly sourceEvidence: Map<string, SourceEvidence>;
    readonly dataSnapshot: PublicationSnapshotRow | null;
  }): Promise<QueryResponse> {
    const releaseIds = [...new Set([...input.sourceEvidence.values()].map((evidence) => evidence.releaseId))];
    const releases = await this.repository.findSources(releaseIds);
    const releaseById = new Map(releases.map((source) => [source.id, source]));
    const sources = [...input.sourceEvidence.values()].flatMap((evidence) => {
      const release = releaseById.get(evidence.releaseId);
      return release ? [sourceRef(release, evidence)] : [];
    });
    if (sources.length !== input.sourceIds.size) {
      throw new Error("A public result references a source row that is not available in the selected release set.");
    }
    const snapshotReleaseIds = parseJsonArray(input.dataSnapshot?.release_ids_json).filter((value): value is string => typeof value === "string" && value.length > 0);
    const publicationReleases = snapshotReleaseIds.length > 0 && !snapshotReleaseIds.every((releaseId) => releaseIds.includes(releaseId))
      ? await this.repository.findSources([...new Set([...releaseIds, ...snapshotReleaseIds])])
      : releases;
    const publication = await publicationStatus(input.dataSnapshot, releaseIds, publicationReleases);
    const response = {
      queryId: input.queryId,
      mode: input.mode,
      ruleDate: input.ruleDate,
      selectedHs6: input.selectedHs6,
      nextQuestion: input.nextQuestion,
      candidates: input.candidates,
      results: input.results,
      sources,
      dataStatus: publication.dataStatus,
      // The publication snapshot is the sole readiness authority. A fixture
      // binding cannot override a ready release (and vice versa).
      testData: publication.testData,
    };
    // Validate before crossing the Worker/API boundary. This also prevents a
    // missed source row from becoming an apparently authoritative result.
    return QueryResponseSchema.parse(response);
  }
}
