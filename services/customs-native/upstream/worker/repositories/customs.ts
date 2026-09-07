
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
