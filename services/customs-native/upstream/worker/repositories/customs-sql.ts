// Source: riskcustoms-hs 50aa174; read-only SQL repository, local database port.
export interface NativeSqlStatement {bind(...values:unknown[]):NativeSqlStatement;all<T>():Promise<{results:T[]}>;first<T>():Promise<T|null>}
export interface NativeSqlDatabase {prepare(sql:string):NativeSqlStatement}
import { normalizeCode } from "../../shared/domain/code";
import { distinctCanadianTariffs } from '../../../tariff-matching';

export type Country = "CN" | "US" | "CA";
export type TradeCountry = "US" | "CA";

export interface ReleaseFields {
  release_status: "staged" | "reviewed" | "published" | "superseded";
  release_authority: string;
  release_dataset: string;
  release_edition: string;
  release_revision: string;
  release_languages_json: string;
  release_official_url: string;
  release_published_at: string;
  release_effective_from: string;
  release_effective_to: string | null;
  release_retrieved_at: string;
  release_manifest_sha256: string;
  release_parser_name: string;
  release_parser_version: string;
  release_supersedes_id: string | null;
}

export interface NomenclatureRow extends ReleaseFields {
  id: number;
  release_id: string;
  artifact_id: string;
  country: Country;
  code: string;
  display_code: string;
  code_digits: number;
  level: number;
  parent_code: string | null;
  is_declarable: number;
  description_original: string;
  language: string;
  statistical_unit_json: string;
  effective_from: string;
  effective_to: string | null;
  source_locator: string;
  raw_row_hash: string;
  concept_id?: string;
  concept_code?: string;
  hs_edition?: string;
  mapping_status?: "exact_prefix" | "reviewed";
}

export interface TariffRuleRow extends ReleaseFields {
  id: string;
  release_id: string;
  artifact_id: string;
  country: Country;
  code: string;
  code_match_type: "exact" | "prefix" | "chapter99_link";
  measure_type: string;
  treatment: string;
  origin_country: string | null;
  rate_expression_raw: string;
  rate_components_json: string;
  parse_status: "confirmed" | "review";
  condition_text_raw: string;
  conditions_json: string;
  interaction_json: string;
  effective_from: string;
  effective_to: string | null;
  priority: number;
  source_locator: string;
  raw_row_hash: string;
}

export interface TradeMeasureRow extends ReleaseFields {
  id: string;
  release_id: string;
  artifact_id: string;
  country: TradeCountry;
  measure_type: string;
  origin_country: string;
  code_hint: string | null;
  legal_scope: string;
  case_number: string | null;
  exporter_or_producer: string | null;
  rate_expression_raw: string | null;
  exceptions_json: string;
  match_status: "possible" | "confirmed_by_rule" | "manual_review";
  effective_from: string;
  effective_to: string | null;
  source_locator: string;
  raw_row_hash: string;
}

export interface RequirementRow extends ReleaseFields {
  id: string;
  release_id: string;
  artifact_id: string;
  country: Country;
  side: "cn_export" | "us_import" | "ca_import";
  label: string;
  document_status: "prepare_retain" | "required_now" | "conditional" | "on_request" | "not_applicable" | "manual_review";
  conditions_json: string;
  reason: string;
  effective_from: string;
  effective_to: string | null;
  source_locator: string;
  raw_row_hash: string;
}

export interface SourceRow {
  id: string;
  country: Country;
  authority: string;
  dataset: string;
  edition: string;
  revision: string;
  languages_json: string;
  official_url: string;
  published_at: string;
  effective_from: string;
  effective_to: string | null;
  retrieved_at: string;
  manifest_sha256: string;
  parser_name: string;
  parser_version: string;
  supersedes_id: string | null;
  status: "staged" | "reviewed" | "published" | "superseded";
}

export interface PublicationSnapshotRow {
  id: string;
  evaluated_at: string;
  rule_date: string;
  ready: number;
  release_ids_json: string;
  approval_ids_json: string;
  reasons_json: string;
  gate_report_sha256: string;
  last_source_check_at: string | null;
  /** Nullable for legacy rows; NULL is intentionally treated as test data. */
  test_data?: number | null;
}

const RELEASE_COLUMNS = `
  sr.status AS release_status,
  sr.authority AS release_authority,
  sr.dataset AS release_dataset,
  sr.edition AS release_edition,
  sr.revision AS release_revision,
  sr.languages_json AS release_languages_json,
  sr.official_url AS release_official_url,
  sr.published_at AS release_published_at,
  sr.effective_from AS release_effective_from,
  sr.effective_to AS release_effective_to,
  sr.retrieved_at AS release_retrieved_at,
  sr.manifest_sha256 AS release_manifest_sha256,
  sr.parser_name AS release_parser_name,
  sr.parser_version AS release_parser_version,
  sr.supersedes_id AS release_supersedes_id`;

const NOM_COLUMNS = `n.*, ${RELEASE_COLUMNS}`;
const EFFECTIVE_N = "n.effective_from <= ? AND (n.effective_to IS NULL OR n.effective_to >= ?)";
const EFFECTIVE_SR = "sr.effective_from <= ? AND (sr.effective_to IS NULL OR sr.effective_to >= ?)";

async function all<T>(statement: NativeSqlStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results;
}

export class CustomsRepository {
  public constructor(private readonly db: NativeSqlDatabase) {}

  /**
   * Two-stage dated lookup: when no row is active on the requested rule date,
   * select the newest published row whose effective_from is not after the
   * rule date (latest-prior policy). Rows from the future are never chosen.
   * The returned set is restricted to the selected release so nomenclature,
   * rates, and measures stay version-consistent.
   */
  private async latestPriorRows<T extends { readonly release_id: string }>(
    anchorSql: string,
    rowsSql: string,
    anchorBinds: readonly unknown[],
    rowsBinds: (releaseId: string) => readonly unknown[],
  ): Promise<T[]> {
    const anchor = await this.db.prepare(anchorSql).bind(...anchorBinds).first<T>();
    if (!anchor) return [];
    return all<T>(this.db.prepare(rowsSql).bind(...rowsBinds(anchor.release_id)));
  }

  public async findExactCode(country: Country, code: string, ruleDate: string): Promise<NomenclatureRow[]> {
    const normalizedCode = normalizeCode(code);
    const statement = this.db.prepare(`
      SELECT ${NOM_COLUMNS}
      FROM nomenclature AS n
      JOIN source_release AS sr ON sr.id = n.release_id
      WHERE n.country = ? AND n.code = ? AND sr.status = 'published'
        AND ${EFFECTIVE_N} AND ${EFFECTIVE_SR}
      ORDER BY n.level ASC, n.code ASC, n.id ASC
    `).bind(country, normalizedCode, ruleDate, ruleDate, ruleDate, ruleDate);
    const activeRows = await all<NomenclatureRow>(statement);
    if (activeRows.length > 0) return activeRows;
    return this.latestPriorRows<NomenclatureRow>(
      `
        SELECT ${NOM_COLUMNS}
        FROM nomenclature AS n
        JOIN source_release AS sr ON sr.id = n.release_id
        WHERE n.country = ? AND n.code = ? AND sr.status = 'published'
          AND n.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY n.effective_from DESC, sr.effective_from DESC, n.id DESC
        LIMIT 1
      `,
      `
        SELECT ${NOM_COLUMNS}
        FROM nomenclature AS n
        JOIN source_release AS sr ON sr.id = n.release_id
        WHERE n.country = ? AND n.code = ? AND sr.id = ? AND sr.status = 'published'
          AND n.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY n.level ASC, n.code ASC, n.id ASC
      `,
      [country, normalizedCode, ruleDate, ruleDate],
      (releaseId) => [country, normalizedCode, releaseId, ruleDate, ruleDate],
    );
  }

  public async searchNames(searchTerms: string, ruleDate: string, limit: number): Promise<NomenclatureRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer between 1 and 100");
    }

    const terms = searchTerms.trim().split(/\s+/u).filter(Boolean);
    if (terms.length === 0) return [];
    // Quote each caller-provided token so FTS operators cannot change the
    // query semantics. The value still reaches SQLite only through binding.
    const matchExpression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    const statement = this.db.prepare(`
      SELECT ${NOM_COLUMNS}
      FROM nomenclature_fts AS fts
      JOIN nomenclature_search AS ns ON ns.row_id = fts.rowid
      JOIN nomenclature AS n ON n.id = ns.nomenclature_id
      JOIN source_release AS sr ON sr.id = n.release_id
      WHERE nomenclature_fts MATCH ? AND sr.status = 'published'
        AND ${EFFECTIVE_N} AND ${EFFECTIVE_SR}
      ORDER BY n.level ASC, n.code ASC, n.id ASC
      LIMIT ?
    `).bind(matchExpression, ruleDate, ruleDate, ruleDate, ruleDate, limit);
    const activeRows = await all<NomenclatureRow>(statement);
    if (activeRows.length > 0) return activeRows;
    return this.latestPriorRows<NomenclatureRow>(
      `
        SELECT ${NOM_COLUMNS}
        FROM nomenclature_fts AS fts
        JOIN nomenclature_search AS ns ON ns.row_id = fts.rowid
        JOIN nomenclature AS n ON n.id = ns.nomenclature_id
        JOIN source_release AS sr ON sr.id = n.release_id
        WHERE nomenclature_fts MATCH ? AND sr.status = 'published'
          AND n.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY n.effective_from DESC, sr.effective_from DESC, n.id DESC
        LIMIT 1
      `,
      `
        SELECT ${NOM_COLUMNS}
        FROM nomenclature_fts AS fts
        JOIN nomenclature_search AS ns ON ns.row_id = fts.rowid
        JOIN nomenclature AS n ON n.id = ns.nomenclature_id
        JOIN source_release AS sr ON sr.id = n.release_id
        WHERE nomenclature_fts MATCH ? AND sr.id = ? AND sr.status = 'published'
          AND n.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY n.level ASC, n.code ASC, n.id ASC
        LIMIT ?
      `,
      [matchExpression, ruleDate, ruleDate],
      (releaseId) => [matchExpression, releaseId, ruleDate, ruleDate, limit],
    );
  }

  public async findByHs6(hs6: string, country: Country, ruleDate: string): Promise<NomenclatureRow[]> {
    const normalizedHs6 = normalizeCode(hs6);
    if (normalizedHs6.length !== 6) {
      throw new Error("HS6 code must contain exactly 6 digits");
    }
    const statement = this.db.prepare(`
      SELECT ${NOM_COLUMNS}, nc.concept_id, hc.code AS concept_code,
             hc.hs_edition, nc.mapping_status
      FROM nomenclature AS n
      JOIN source_release AS sr ON sr.id = n.release_id
      JOIN nomenclature_concept AS nc ON nc.nomenclature_id = n.id
      JOIN hs_concept AS hc ON hc.id = nc.concept_id
      WHERE hc.code = ? AND hc.level = 6 AND n.country = ? AND sr.status = 'published'
        AND hc.effective_from <= ? AND (hc.effective_to IS NULL OR hc.effective_to >= ?)
        AND ${EFFECTIVE_N} AND ${EFFECTIVE_SR}
      ORDER BY n.level ASC, n.code ASC, n.id ASC
    `).bind(normalizedHs6, country, ruleDate, ruleDate, ruleDate, ruleDate, ruleDate, ruleDate);
    const activeRows = await all<NomenclatureRow>(statement);
    if (activeRows.length > 0) return activeRows;
    return this.latestPriorRows<NomenclatureRow>(
      `
        SELECT ${NOM_COLUMNS}, nc.concept_id, hc.code AS concept_code,
               hc.hs_edition, nc.mapping_status
        FROM nomenclature AS n
        JOIN source_release AS sr ON sr.id = n.release_id
        JOIN nomenclature_concept AS nc ON nc.nomenclature_id = n.id
        JOIN hs_concept AS hc ON hc.id = nc.concept_id
        WHERE hc.code = ? AND hc.level = 6 AND n.country = ? AND sr.status = 'published'
          AND hc.effective_from <= ? AND n.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY n.effective_from DESC, sr.effective_from DESC, n.id DESC
        LIMIT 1
      `,
      `
        SELECT ${NOM_COLUMNS}, nc.concept_id, hc.code AS concept_code,
               hc.hs_edition, nc.mapping_status
        FROM nomenclature AS n
        JOIN source_release AS sr ON sr.id = n.release_id
        JOIN nomenclature_concept AS nc ON nc.nomenclature_id = n.id
        JOIN hs_concept AS hc ON hc.id = nc.concept_id
        WHERE hc.code = ? AND hc.level = 6 AND n.country = ? AND sr.id = ? AND sr.status = 'published'
          AND hc.effective_from <= ? AND n.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY n.level ASC, n.code ASC, n.id ASC
      `,
      [normalizedHs6, country, ruleDate, ruleDate, ruleDate],
      (releaseId) => [normalizedHs6, country, releaseId, ruleDate, ruleDate, ruleDate],
    );
  }

  public async findHierarchy(nomenclatureId: number, ruleDate: string): Promise<NomenclatureRow[]> {
    if (!Number.isInteger(nomenclatureId) || nomenclatureId < 1) {
      throw new Error("nomenclatureId must be a positive integer");
    }
    const targetStatement = this.db.prepare(`
      SELECT ${NOM_COLUMNS}
      FROM nomenclature AS n
      JOIN source_release AS sr ON sr.id = n.release_id
      WHERE n.id = ? AND sr.status = 'published' AND ${EFFECTIVE_N} AND ${EFFECTIVE_SR}
    `).bind(nomenclatureId, ruleDate, ruleDate, ruleDate, ruleDate);
    const targetRows = await all<NomenclatureRow>(targetStatement);
    let target = targetRows[0];
    let targetIsActive = true;
    if (!target) {
      target = (await this.db.prepare(`
        SELECT ${NOM_COLUMNS}
        FROM nomenclature AS n
        JOIN source_release AS sr ON sr.id = n.release_id
        WHERE n.id = ? AND sr.status = 'published'
          AND n.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY n.effective_from DESC, sr.effective_from DESC, n.id DESC
        LIMIT 1
      `).bind(nomenclatureId, ruleDate, ruleDate).first<NomenclatureRow>()) ?? undefined;
      targetIsActive = false;
    }
    if (!target) return [];

    const siblingsStatement = targetIsActive
      ? this.db.prepare(`
          SELECT ${NOM_COLUMNS}
          FROM nomenclature AS n
          JOIN source_release AS sr ON sr.id = n.release_id
          WHERE n.release_id = ? AND n.country = ? AND sr.status = 'published'
            AND ${EFFECTIVE_N} AND ${EFFECTIVE_SR}
          ORDER BY n.level ASC, n.code ASC, n.id ASC
        `).bind(target.release_id, target.country, ruleDate, ruleDate, ruleDate, ruleDate)
      : this.db.prepare(`
          SELECT ${NOM_COLUMNS}
          FROM nomenclature AS n
          JOIN source_release AS sr ON sr.id = n.release_id
          WHERE n.release_id = ? AND n.country = ? AND sr.status = 'published'
            AND n.effective_from <= ? AND sr.effective_from <= ?
          ORDER BY n.level ASC, n.code ASC, n.id ASC
        `).bind(target.release_id, target.country, ruleDate, ruleDate);
    const candidates = await all<NomenclatureRow>(siblingsStatement);
    const byCode = new Map<string, NomenclatureRow>();
    for (const row of candidates) if (!byCode.has(row.code)) byCode.set(row.code, row);

    const path: NomenclatureRow[] = [];
    const seen = new Set<number>();
    let current: NomenclatureRow | undefined = target;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current);
      current = current.parent_code ? byCode.get(current.parent_code) : undefined;
    }
    return path;
  }

  public async findTariffRules(country: Country, code: string, ruleDate: string): Promise<TariffRuleRow[]> {
    const normalizedCode = normalizeCode(code);
    if (!normalizedCode) return [];
    // Enumerating a code's prefixes preserves the country/code index, instead
    // of scanning the complete tariff table with a per-row substring predicate.
    const prefixes = Array.from({length:normalizedCode.length},(_,i)=>normalizedCode.slice(0,i+1));
    const match = `tr.code IN (${prefixes.map(()=>'?').join(',')}) AND (tr.code = ? OR tr.code_match_type = 'prefix')`;
    const codeValues = [country,...prefixes,normalizedCode];
    const statement = this.db.prepare(`
      SELECT tr.*, ${RELEASE_COLUMNS}
      FROM tariff_rule AS tr
      JOIN source_release AS sr ON sr.id = tr.release_id
      WHERE tr.country = ? AND ${match} AND sr.status = 'published'
        AND tr.effective_from <= ? AND (tr.effective_to IS NULL OR tr.effective_to >= ?)
        AND ${EFFECTIVE_SR}
      ORDER BY tr.priority ASC, tr.id ASC
    `).bind(...codeValues, ruleDate, ruleDate, ruleDate, ruleDate);
    const activeRows = await all<TariffRuleRow>(statement);
    if (activeRows.length > 0) return distinctCanadianTariffs(activeRows,normalizedCode);
    const priorRows = await this.latestPriorRows<TariffRuleRow>(
      `
        SELECT tr.*, ${RELEASE_COLUMNS}
        FROM tariff_rule AS tr
        JOIN source_release AS sr ON sr.id = tr.release_id
        WHERE tr.country = ? AND ${match} AND sr.status = 'published'
          AND tr.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY tr.effective_from DESC, sr.effective_from DESC, tr.id DESC
        LIMIT 1
      `,
      `
        SELECT tr.*, ${RELEASE_COLUMNS}
        FROM tariff_rule AS tr
        JOIN source_release AS sr ON sr.id = tr.release_id
        WHERE tr.country = ? AND ${match} AND sr.id = ? AND sr.status = 'published'
          AND tr.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY tr.priority ASC, tr.id ASC
      `,
      [...codeValues, ruleDate, ruleDate],
      (releaseId) => [...codeValues, releaseId, ruleDate, ruleDate],
    );
    return distinctCanadianTariffs(priorRows,normalizedCode);
  }

  public async findTradeMeasures(country: TradeCountry, code: string, ruleDate: string): Promise<TradeMeasureRow[]> {
    const normalizedCode = normalizeCode(code);
    const statement = this.db.prepare(`
      SELECT tm.*, ${RELEASE_COLUMNS}
      FROM trade_measure AS tm
      JOIN source_release AS sr ON sr.id = tm.release_id
      WHERE tm.country = ? AND (tm.code_hint = ? OR tm.code_hint IS NULL) AND sr.status = 'published'
        AND tm.effective_from <= ? AND (tm.effective_to IS NULL OR tm.effective_to >= ?)
        AND ${EFFECTIVE_SR}
      ORDER BY tm.id ASC
    `).bind(country, normalizedCode, ruleDate, ruleDate, ruleDate, ruleDate);
    const activeRows = await all<TradeMeasureRow>(statement);
    if (activeRows.length > 0) return activeRows;
    return this.latestPriorRows<TradeMeasureRow>(
      `
        SELECT tm.*, ${RELEASE_COLUMNS}
        FROM trade_measure AS tm
        JOIN source_release AS sr ON sr.id = tm.release_id
        WHERE tm.country = ? AND (tm.code_hint = ? OR tm.code_hint IS NULL) AND sr.status = 'published'
          AND tm.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY tm.effective_from DESC, sr.effective_from DESC, tm.id DESC
        LIMIT 1
      `,
      `
        SELECT tm.*, ${RELEASE_COLUMNS}
        FROM trade_measure AS tm
        JOIN source_release AS sr ON sr.id = tm.release_id
        WHERE tm.country = ? AND (tm.code_hint = ? OR tm.code_hint IS NULL) AND sr.id = ? AND sr.status = 'published'
          AND tm.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY tm.id ASC
      `,
      [country, normalizedCode, ruleDate, ruleDate],
      (releaseId) => [country, normalizedCode, releaseId, ruleDate, ruleDate],
    );
  }

  public async findRequirements(country: Country, ruleDate: string): Promise<RequirementRow[]> {
    const statement = this.db.prepare(`
      SELECT rr.*, ${RELEASE_COLUMNS}
      FROM regulatory_requirement AS rr
      JOIN source_release AS sr ON sr.id = rr.release_id
      WHERE rr.country = ? AND sr.status = 'published'
        AND rr.effective_from <= ? AND (rr.effective_to IS NULL OR rr.effective_to >= ?)
        AND ${EFFECTIVE_SR}
      ORDER BY rr.side ASC, rr.label ASC, rr.id ASC
    `).bind(country, ruleDate, ruleDate, ruleDate, ruleDate);
    const activeRows = await all<RequirementRow>(statement);
    if (activeRows.length > 0) return activeRows;
    return this.latestPriorRows<RequirementRow>(
      `
        SELECT rr.*, ${RELEASE_COLUMNS}
        FROM regulatory_requirement AS rr
        JOIN source_release AS sr ON sr.id = rr.release_id
        WHERE rr.country = ? AND sr.status = 'published'
          AND rr.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY rr.effective_from DESC, sr.effective_from DESC, rr.id DESC
        LIMIT 1
      `,
      `
        SELECT rr.*, ${RELEASE_COLUMNS}
        FROM regulatory_requirement AS rr
        JOIN source_release AS sr ON sr.id = rr.release_id
        WHERE rr.country = ? AND sr.id = ? AND sr.status = 'published'
          AND rr.effective_from <= ? AND sr.effective_from <= ?
        ORDER BY rr.side ASC, rr.label ASC, rr.id ASC
      `,
      [country, ruleDate, ruleDate],
      (releaseId) => [country, releaseId, ruleDate, ruleDate],
    );
  }

  public async findSources(releaseIds: string[]): Promise<SourceRow[]> {
    if (releaseIds.length === 0) return [];
    const statement = this.db.prepare(`
      SELECT sr.*
      FROM source_release AS sr
      WHERE sr.id IN (SELECT value FROM json_each(?))
        AND sr.status = 'published'
      ORDER BY sr.id ASC
    `).bind(JSON.stringify(releaseIds));
    return all<SourceRow>(statement);
  }

  public async findPublicationSnapshot(ruleDate: string): Promise<PublicationSnapshotRow | null> {
    const statement = this.db.prepare(`
      SELECT *
      FROM publication_snapshot
      WHERE rule_date <= ?
      ORDER BY rule_date DESC, evaluated_at DESC, id DESC
      LIMIT 1
    `).bind(ruleDate);
    const rows = await all<PublicationSnapshotRow>(statement);
    return rows[0] ?? null;
  }
}
