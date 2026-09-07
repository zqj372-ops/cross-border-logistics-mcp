import { describe, expect, it } from "vitest";

import {
  convertValue,
  estimateTariffBreakdown,
} from "../../services/customs-native/upstream/shared/domain/tariff-estimate";
import { makeValidResponse } from "./fixtures";

function confirmedCanadaResult(kind: "ad_valorem" | "specific" = "ad_valorem") {
  const response = makeValidResponse();
  const result = response.results.find((item) => item.country === "CA")!;
  result.status = "confirmed";
  result.confirmedTotalPercent = kind === "ad_valorem" ? "7.25" : null;
  result.warnings = [];
  result.measures = [];
  result.rates = [{
    ...result.rates[0]!,
    id: "ca-duty",
    category: "base_duty",
    kind,
    rateExpressionRaw: kind === "ad_valorem" ? "7.25%" : "CAD 2.50 / kg",
    displayValue: kind === "ad_valorem" ? "7.25%" : "CAD 2.50 / kg",
    confirmed: true,
    includedInConfirmedTotal: kind === "ad_valorem",
  }];
  return result;
}

describe("shared tariff estimate Decimal domain", () => {
  it("calculates known confirmed ad-valorem input without binary-float drift", () => {
    const converted = convertValue({ name: "line", hsCode: "9617000000", quantity: null, declaredValue: "1000.10", currency: "CAD" }, "CA", {});
    const result = confirmedCanadaResult();
    result.rates.push({
      ...result.rates[0]!,
      id: "ca-gst",
      label: "GST",
      treatment: "GST",
      category: "gst",
      rateExpressionRaw: "5%",
      displayValue: "5%",
      includedInConfirmedTotal: false,
    });
    const estimate = estimateTariffBreakdown(result, converted, "CA", { ready: true, testData: false });
    expect(estimate).toMatchObject({
      status: "confirmed",
      valueForDuty: "1000.10",
      valueForTax: "1072.61",
      customsPayable: "126.14",
    });
    expect(estimate.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ca-duty", amount: "72.51" }),
      expect.objectContaining({ id: "ca-gst", amount: "53.63", base: "1072.61" }),
    ]));
  });

  it("keeps specific rates, missing exchange evidence and unready data out of a complete payable", () => {
    const direct = convertValue({ name: "line", hsCode: "9617000000", quantity: null, declaredValue: "1000.00", currency: "CAD" }, "CA", {});
    expect(estimateTariffBreakdown(confirmedCanadaResult("specific"), direct, "CA", { ready: true, testData: false }))
      .toMatchObject({ status: "manual_review", customsPayable: null });

    const missingFx = convertValue({ name: "line", hsCode: "9617000000", quantity: null, declaredValue: "1000.00", currency: "USD" }, "CA", {});
    expect(estimateTariffBreakdown(confirmedCanadaResult(), missingFx, "CA", { ready: true, testData: false }))
      .toMatchObject({ status: "needs_rate", customsPayable: null, valueForDuty: null });

    expect(estimateTariffBreakdown(confirmedCanadaResult(), direct, "CA", { ready: false, testData: false }))
      .toMatchObject({ status: "manual_review", customsPayable: null });
  });
});
