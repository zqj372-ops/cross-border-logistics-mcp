import type { CountryResult, QueryResponse } from "../../services/customs-native/upstream/shared/contracts/query";

const RULE_DATE = "2026-08-03" as const;
const RETRIEVED_AT = "2026-08-03T00:00:00.000Z" as const;
const RELEASE_ID = "fixture-release-2026-08-03" as const;

type FixtureCountry = "CN" | "US" | "CA";

const sourceArtifacts: Record<FixtureCountry, string> = {
  CN: "fixture-artifact-cn-732393",
  US: "fixture-artifact-us-732393",
  CA: "fixture-artifact-ca-732393",
};

const sourceLocators: Record<FixtureCountry, string> = {
  CN: "fixture://riskcustoms-hs/cn/732393",
  US: "fixture://riskcustoms-hs/us/732393",
  CA: "fixture://riskcustoms-hs/ca/732393",
};

function makeSourceId(country: FixtureCountry): string {
  return `fixture-source:${RELEASE_ID}:${sourceArtifacts[country]}:${sourceLocators[country]}`;
}

const sourceIds: Record<FixtureCountry, string> = {
  CN: makeSourceId("CN"),
  US: makeSourceId("US"),
  CA: makeSourceId("CA"),
};

function makeSource(country: FixtureCountry) {
  return {
    id: sourceIds[country],
    releaseId: RELEASE_ID,
    artifactId: sourceArtifacts[country],
    authority: "fixture-only authority",
    dataset: "riskcustoms-hs-test-fixture",
    edition: "fixture-edition-2026",
    revision: "fixture-revision-1",
    officialUrl: `https://example.com/riskcustoms-hs/fixtures/${country.toLowerCase()}`,
    publishedAt: RULE_DATE,
    effectiveFrom: RULE_DATE,
    effectiveTo: null,
    retrievedAt: RETRIEVED_AT,
    sourceLocator: sourceLocators[country],
  };
}

function makeCountryResult(
  country: FixtureCountry,
  code: string,
  displayCode: string,
  legalNames: Array<{ language: string; text: string; sourceId: string }>,
): CountryResult {
  const sourceId = sourceIds[country];
  const side = country === "CN" ? "cn_export" : country === "US" ? "us_import" : "ca_import";
  const rateCategory = country === "CN" ? "export_duty" : "base_duty";
  const hierarchyCode = code.slice(0, 4);
  const hierarchyName = legalNames[0]!;

  return {
    candidateId: `fixture-candidate-${country.toLowerCase()}-732393`,
    country,
    code,
    displayCode,
    codeDigits: code.length,
    parentCode: hierarchyCode,
    hierarchy: [
      {
        code: hierarchyCode,
        displayCode: `${hierarchyCode.slice(0, 2)}.${hierarchyCode.slice(2)}`,
        codeDigits: hierarchyCode.length,
        legalNames: [hierarchyName],
      },
      {
        code,
        displayCode,
        codeDigits: code.length,
        legalNames,
      },
    ],
    legalNames,
    chineseExplanation: {
      translationId: `fixture-translation-${country.toLowerCase()}-732393`,
      text: `测试用${country}商品描述；仅用于契约验证，不代表生产翻译。`,
      status: country === "CA" ? "human_reviewed" : "machine",
      basedOnSourceIds: [sourceId],
    },
    classificationReason: "测试候选：仅用于验证审计字段和来源引用。",
    classificationSourceIds: [sourceId],
    status: "candidate",
    hs6: code,
    rates: [
      {
        id: `fixture-rate-${country.toLowerCase()}-732393`,
        label: "Fixture rate",
        treatment: "Fixture treatment; verify against the applicable official rule.",
        category: rateCategory,
        kind: "ad_valorem",
        rateExpressionRaw: "0% (fixture)",
        displayValue: "Fixture only",
        confirmed: false,
        includedInConfirmedTotal: false,
        effectiveFrom: RULE_DATE,
        effectiveTo: null,
        conditionText: "Test fixture only",
        interactionNote: "No production duty conclusion; manual official-source review required.",
        sourceId,
      },
    ],
    confirmedTotalPercent: null,
    documents: [
      {
        id: `fixture-document-${country.toLowerCase()}-origin`,
        label: "Fixture origin and commercial documents",
        side,
        status: "manual_review",
        conditions: ["Confirm the real transaction and applicable customs rule."],
        reason: "Fixture value only; document requirements remain for manual review.",
        effectiveFrom: RULE_DATE,
        effectiveTo: null,
        sourceId,
      },
    ],
    measures: [
      {
        id: `fixture-measure-${country.toLowerCase()}-origin`,
        label: "Fixture trade-measure check",
        measureType: "fixture_check",
        originCountry: "CN",
        codeHint: null,
        matchStatus: "manual_review",
        legalScope: "Fixture value only; no production trade-remedy determination.",
        exceptions: [],
        caseNumber: null,
        exporterOrProducer: null,
        rateExpressionRaw: null,
        effectiveFrom: RULE_DATE,
        effectiveTo: null,
        sourceId,
      },
    ],
    warnings: ["Fixture data only; source freshness and legal applicability require review."],
  };
}

export function makeValidResponse(): QueryResponse {
  const cnNames = [
    { language: "zh", text: "测试不锈钢保温杯（中国出口）", sourceId: sourceIds.CN },
  ];
  const usNames = [
    { language: "en", text: "Fixture stainless steel vacuum flask (United States)", sourceId: sourceIds.US },
  ];
  const caNames = [
    { language: "en", text: "Fixture stainless steel vacuum flask", sourceId: sourceIds.CA },
    { language: "fr", text: "Bouteille isotherme en acier inoxydable de test", sourceId: sourceIds.CA },
  ];

  const results = [
    makeCountryResult("CN", "732393", "7323.93", cnNames),
    makeCountryResult("US", "732393", "7323.93", usNames),
    makeCountryResult("CA", "732393", "7323.93", caNames),
  ];

  return {
    queryId: "fixture-query-2026-08-03-732393",
    mode: "exact_code",
    ruleDate: RULE_DATE,
    selectedHs6: "732393",
    nextQuestion: null,
    candidates: results.map(({ rates: _rates, confirmedTotalPercent: _total, documents: _documents, measures: _measures, warnings: _warnings, ...candidate }) => { void [_rates,_total,_documents,_measures,_warnings]; return candidate; }),
    results,
    sources: [makeSource("CN"), makeSource("US"), makeSource("CA")],
    dataStatus: {
      evaluatedAt: RETRIEVED_AT,
      lastSourceCheckAt: null,
      ready: false,
      reasons: ["Fixture values are not an official source check.", "Production readiness requires current authoritative data."],
    },
    testData: true,
  };
}
