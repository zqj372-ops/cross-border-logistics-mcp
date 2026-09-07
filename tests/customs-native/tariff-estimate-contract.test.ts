import { describe, expect, it } from "vitest";

import {
  TariffEstimateBatchRequestSchema,
  TariffEstimateBatchResponseSchema,
  TariffEstimateRequestSchema,
  TariffEstimateResponseSchema,
} from "../../services/customs-native/upstream/shared/contracts/tariff-estimate";

const item = {
  lineId: "line-1",
  description: "Stainless steel vacuum flask",
  hsCode: "9617000000",
  destinationCountry: "CA",
  declaredValue: "1000.00",
  currency: "USD",
  attributes: { originCountry: "CN" },
} as const;

describe("tariff estimate wire contract", () => {
  it("accepts decimal-string single and bounded batch requests", () => {
    expect(TariffEstimateRequestSchema.parse({ ruleDate: "2026-09-05", ...item })).toEqual({ ruleDate: "2026-09-05", ...item });
    expect(TariffEstimateBatchRequestSchema.parse({ ruleDate: "2026-09-05", items: [item] }).items).toHaveLength(1);
  });

  it("rejects caller authority fields, numeric money, duplicate line IDs and an oversized batch", () => {
    expect(TariffEstimateRequestSchema.safeParse({ ruleDate: "2026-09-05", ...item, declaredValue: 1000 }).success).toBe(false);
    expect(TariffEstimateRequestSchema.safeParse({ ruleDate: "2026-09-05", ...item, tariffRate: "7" }).success).toBe(false);
    expect(TariffEstimateRequestSchema.safeParse({ ruleDate: "2026-09-05", ...item, exchangeRate: "1.4" }).success).toBe(false);
    expect(TariffEstimateBatchRequestSchema.safeParse({ ruleDate: "2026-09-05", items: [item, item] }).success).toBe(false);
    expect(TariffEstimateBatchRequestSchema.safeParse({ ruleDate: "2026-09-05", items: Array.from({ length: 21 }, (_, index) => ({ ...item, lineId: `line-${index}` })) }).success).toBe(false);
  });

  it("does not allow a partial batch or incomplete row to claim success", () => {
    const publication = {
      ruleDate: "2026-09-05",
      serviceVersion: "test-build-1",
      publishedAt: "2026-09-05T00:00:00.000Z",
      releaseIds: ["release-ca-1"],
      snapshotHash: "a".repeat(64),
      releaseHash: "b".repeat(64),
      evaluatedAt: "2026-09-05T00:00:00.000Z",
      lastSourceCheckAt: null,
      testData: false,
    } as const;
    const delegatedActor = { type: "user", ref: "usr_opaque_01", applicationId: "app-customs" } as const;
    const source = {
      id: "source:release-ca-1:tariff:9617",
      releaseId: "release-ca-1",
      artifactId: "tariff",
      authority: "CBSA",
      dataset: "customs_tariff",
      edition: "2026",
      revision: "r1",
      officialUrl: "https://www.cbsa-asfc.gc.ca/trade-commerce/tariff-tarif/",
      publishedAt: "2026-01-01",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      retrievedAt: "2026-09-05T00:00:00.000Z",
      sourceLocator: "tariff#9617",
    } as const;
    const line = {
      id: "duty:0",
      label: "MFN",
      category: "base_duty",
      rateExpressionRaw: "7.25%",
      ratePercent: "7.25",
      amount: "72.50",
      base: "1000.00",
      status: "included",
      effectiveFrom: "2026-01-01",
      sourceId: source.id,
      note: "",
    } as const;
    const result = {
      lineId: "line-1",
      status: "success",
      input: { ...item, currency: "CAD" },
      publication,
      exchangeRate: null,
      valueForDuty: { amount: "1000.00", currency: "CAD" },
      valueForTax: { amount: "1072.50", currency: "CAD" },
      confirmedSubtotal: { amount: "126.13", currency: "CAD" },
      customsPayable: { amount: "126.13", currency: "CAD" },
      lines: [line],
      sources: [source],
      reasonCodes: [],
    } as const;
    const reviewResult = {
      ...result,
      lineId: "line-2",
      status: "manual_review",
      input: { ...item, lineId: "line-2", currency: "CAD" },
      customsPayable: null,
      reasonCodes: ["tariff_manual_review"],
    } as const;
    const response = {
      contractVersion: "riskcustoms-tariff-estimate.v1",
      requestId: "req_tariff_estimate_0001",
      status: "manual_review",
      partialFailure: true,
      delegatedActor,
      counts: { total: 2, success: 1, needsInput: 0, manualReview: 1, unavailable: 0 },
      results: [result, reviewResult],
    };
    expect(TariffEstimateBatchResponseSchema.safeParse(response).success).toBe(true);
    expect(TariffEstimateBatchResponseSchema.safeParse({ ...response, status: "success" }).success).toBe(false);
    expect(TariffEstimateResponseSchema.safeParse({
      contractVersion: response.contractVersion,
      requestId: response.requestId,
      status: "success",
      delegatedActor,
      result: reviewResult,
    }).success).toBe(false);
  });
});
