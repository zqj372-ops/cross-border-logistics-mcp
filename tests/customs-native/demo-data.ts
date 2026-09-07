import type {
  NomenclatureRow,
  PublicationSnapshotRow,
  RequirementRow,
  SourceRow,
  TariffRuleRow,
  TradeMeasureRow,
} from "../../services/customs-native/upstream/worker/repositories/customs";

const RELEASE_URLS = {
  CN: "https://example.invalid/riskcustoms-fixture/cn",
  US: "https://example.invalid/riskcustoms-fixture/us",
  CA: "https://example.invalid/riskcustoms-fixture/ca",
} as const;

const RELEASE_IDS = { CN: "fixture-cn-2026-08-03", US: "fixture-us-2026-08-03", CA: "fixture-ca-2026-08-03" } as const;

function releaseFields(country: "CN" | "US" | "CA"): Omit<NomenclatureRow, "id" | "release_id" | "artifact_id" | "country" | "code" | "display_code" | "code_digits" | "level" | "parent_code" | "is_declarable" | "description_original" | "language" | "statistical_unit_json" | "effective_from" | "effective_to" | "source_locator" | "raw_row_hash"> {
  return {
    release_status: "published",
    release_authority: "RiskCustoms local fixture",
    release_dataset: "demo customs rows (not live tariff data)",
    release_edition: "fixture-2026",
    release_revision: "fixture-2026-08-03",
    release_languages_json: country === "CA" ? '["en","fr","zh"]' : country === "CN" ? '["zh"]' : '["en","zh"]',
    release_official_url: RELEASE_URLS[country],
    release_published_at: "2026-08-03T00:00:00Z",
    release_effective_from: "2026-01-01",
    release_effective_to: null,
    release_retrieved_at: "2026-08-03T00:00:00Z",
    release_manifest_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    release_parser_name: "riskcustoms-demo-fixture",
    release_parser_version: "0.1.0",
    release_supersedes_id: null,
  };
}

function nomenclature(
  id: number,
  country: "CN" | "US" | "CA",
  code: string,
  displayCode: string,
  description: string,
  conceptCode: string,
  language: string,
  sourceLocator: string,
): NomenclatureRow {
  return {
    id,
    release_id: RELEASE_IDS[country],
    artifact_id: `${RELEASE_IDS[country]}-nomenclature`,
    country,
    code,
    display_code: displayCode,
    code_digits: code.length,
    level: code.length,
    parent_code: null,
    is_declarable: 1,
    description_original: description,
    language,
    statistical_unit_json: "[]",
    effective_from: "2026-01-01",
    effective_to: null,
    source_locator: sourceLocator,
    raw_row_hash: `fixture-row-${id}`,
    concept_id: `hs-${conceptCode}`,
    concept_code: conceptCode,
    hs_edition: "HS-2022-fixture",
    mapping_status: "reviewed",
    ...releaseFields(country),
  };
}

function tariff(
  id: string,
  country: "CN" | "US" | "CA",
  code: string,
  measureType: string,
  treatment: string,
  category: string,
  percent: string,
): TariffRuleRow {
  return {
    id,
    release_id: RELEASE_IDS[country],
    artifact_id: `${RELEASE_IDS[country]}-tariff`,
    country,
    code,
    code_match_type: "exact",
    measure_type: measureType,
    treatment,
    origin_country: country === "CN" ? null : "CN",
    rate_expression_raw: `${percent}% (fixture only)`,
    rate_components_json: JSON.stringify([
      {
        kind: percent === "0" ? "free" : "ad_valorem",
        ...(percent === "0" ? {} : { percent }),
        valueBasis: "customs_value",
        rateExpressionRaw: `${percent}% (fixture only)`,
      },
    ]),
    parse_status: "confirmed",
    condition_text_raw: "Fixture demonstration row; verify against current official schedule.",
    conditions_json: "[]",
    interaction_json: JSON.stringify({ reviewed: true, additive: true, stackingGroup: `${country}-base-fixture` }),
    effective_from: "2026-01-01",
    effective_to: null,
    priority: 1,
    source_locator: `fixture://${country}/tariff/${id}`,
    raw_row_hash: `fixture-rule-${id}`,
    ...releaseFields(country),
  };
}

function requirement(
  id: string,
  country: "CN" | "US" | "CA",
  side: RequirementRow["side"],
  label: string,
  documentStatus: RequirementRow["document_status"],
): RequirementRow {
  return {
    id,
    release_id: RELEASE_IDS[country],
    artifact_id: `${RELEASE_IDS[country]}-requirements`,
    country,
    side,
    label,
    document_status: documentStatus,
    conditions_json: "[]",
    reason: "Fixture demonstration only; confirm the current authority requirement before filing.",
    effective_from: "2026-01-01",
    effective_to: null,
    source_locator: `fixture://${country}/requirements/${id}`,
    raw_row_hash: `fixture-document-${id}`,
    ...releaseFields(country),
  };
}

export const DEMO_SOURCES: readonly SourceRow[] = (Object.keys(RELEASE_IDS) as Array<"CN" | "US" | "CA">).map((country) => ({
  id: RELEASE_IDS[country],
  country,
  authority: "RiskCustoms local fixture",
  dataset: "demo customs rows (not live tariff data)",
  edition: "fixture-2026",
  revision: "fixture-2026-08-03",
  languages_json: country === "CA" ? '["en","fr","zh"]' : country === "CN" ? '["zh"]' : '["en","zh"]',
  official_url: RELEASE_URLS[country],
  published_at: "2026-08-03",
  effective_from: "2026-01-01",
  effective_to: null,
  retrieved_at: "2026-08-03T00:00:00Z",
  manifest_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  parser_name: "riskcustoms-demo-fixture",
  parser_version: "0.1.0",
  supersedes_id: null,
  status: "published",
}));

export const DEMO_NOMENCLATURE: readonly NomenclatureRow[] = [
  nomenclature(1, "CN", "9617009000", "9617.00.9000", "保温杯", "961700", "zh", "fixture://CN/9617009000"),
  nomenclature(2, "US", "9617001000", "9617.00.1000", "Vacuum flasks and vessels", "961700", "en", "fixture://US/9617001000"),
  nomenclature(3, "CA", "9617000000", "9617.00.0000", "Vacuum flasks and vessels", "961700", "en", "fixture://CA/9617000000"),
  nomenclature(4, "CN", "7323930000", "7323.93.0000", "不锈钢保温壶", "732393", "zh", "fixture://CN/7323930000"),
  nomenclature(5, "US", "7323930080", "7323.93.0080", "Other stainless steel household articles", "732393", "en", "fixture://US/7323930080"),
  nomenclature(6, "CA", "7323930090", "7323.93.0090", "Other stainless steel household articles", "732393", "en", "fixture://CA/7323930090"),
  nomenclature(7, "CN", "123456", "1234.56", "示例编码商品", "123456", "zh", "fixture://CN/123456"),
  nomenclature(8, "US", "123456", "1234.56", "Example coded product", "123456", "en", "fixture://US/123456"),
];

export const DEMO_TARIFF_RULES: readonly TariffRuleRow[] = [
  tariff("cn-961700-export", "CN", "9617009000", "export duty", "Export", "export_duty", "0"),
  tariff("us-961700-general", "US", "9617001000", "base duty", "General", "base_duty", "3.5"),
  tariff("ca-961700-mfn", "CA", "9617000000", "base duty", "MFN", "base_duty", "7"),
  tariff("cn-732393-export", "CN", "7323930000", "export duty", "Export", "export_duty", "0"),
  tariff("us-732393-general", "US", "7323930080", "base duty", "General", "base_duty", "2.5"),
  tariff("ca-732393-mfn", "CA", "7323930090", "base duty", "MFN", "base_duty", "6.5"),
  tariff("cn-123456-export", "CN", "123456", "export duty", "Export", "export_duty", "0"),
  tariff("us-123456-general", "US", "123456", "base duty", "General", "base_duty", "4"),
];

export const DEMO_MEASURES: readonly TradeMeasureRow[] = [
  {
    id: "us-301-possible",
    release_id: RELEASE_IDS.US,
    artifact_id: `${RELEASE_IDS.US}-measures`,
    country: "US",
    measure_type: "Section 301 discovery indication",
    origin_country: "CN",
    code_hint: "9617001000",
    legal_scope: "Fixture hint only; no live Section 301 determination.",
    case_number: null,
    exporter_or_producer: null,
    rate_expression_raw: null,
    exceptions_json: "[]",
    match_status: "possible",
    effective_from: "2026-01-01",
    effective_to: null,
    source_locator: "fixture://US/measures/us-301-possible",
    raw_row_hash: "fixture-measure-us-301",
    ...releaseFields("US"),
  },
];

export const DEMO_REQUIREMENTS: readonly RequirementRow[] = [
  requirement("cn-invoice", "CN", "cn_export", "出口商业发票", "prepare_retain"),
  requirement("cn-packing", "CN", "cn_export", "装箱单", "prepare_retain"),
  requirement("us-invoice", "US", "us_import", "Commercial invoice", "required_now"),
  requirement("us-packing", "US", "us_import", "Packing list", "prepare_retain"),
  requirement("ca-invoice", "CA", "ca_import", "Commercial invoice", "required_now"),
  requirement("ca-packing", "CA", "ca_import", "Packing list", "prepare_retain"),
];

export const DEMO_PUBLICATION_SNAPSHOT: PublicationSnapshotRow = {
  id: "fixture-snapshot-2026-08-03",
  evaluated_at: "2026-08-03T00:00:00Z",
  rule_date: "2026-08-03",
  ready: 0,
  release_ids_json: JSON.stringify(Object.values(RELEASE_IDS)),
  approval_ids_json: "[]",
  reasons_json: JSON.stringify(["Fixture rows are not a reviewed publication and must not be treated as live tariff data."]),
  gate_report_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  last_source_check_at: null,
  test_data: 1,
};

export interface DemoData {
  readonly sources: readonly SourceRow[];
  readonly nomenclature: readonly NomenclatureRow[];
  readonly tariffRules: readonly TariffRuleRow[];
  readonly tradeMeasures: readonly TradeMeasureRow[];
  readonly requirements: readonly RequirementRow[];
  readonly publicationSnapshot: PublicationSnapshotRow;
  readonly testData: true;
}

export const DEMO_DATA: DemoData = {
  sources: DEMO_SOURCES,
  nomenclature: DEMO_NOMENCLATURE,
  tariffRules: DEMO_TARIFF_RULES,
  tradeMeasures: DEMO_MEASURES,
  requirements: DEMO_REQUIREMENTS,
  publicationSnapshot: DEMO_PUBLICATION_SNAPSHOT,
  testData: true,
};
