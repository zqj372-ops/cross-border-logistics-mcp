import { describe, expect, it } from "vitest";
import { evaluateRates } from "../../services/customs-native/upstream/worker/rules/evaluate-rates";
import type { DecimalInput, RateInput } from "../../services/customs-native/upstream/shared/domain/rates";
import { sumConfirmedPercent } from "../../services/customs-native/upstream/shared/domain/rates";

describe("rate evaluation", () => {
  it("sums confirmed ad-valorem lines using decimal arithmetic", () => {
    const result = evaluateRates([
      { id: "general", category: "base_duty", percent: "7.2", confirmed: true, kind: "ad_valorem", priority: 1, valueBasis: "customs_value" },
      { id: "section301", category: "additional_duty", percent: "25", confirmed: true, kind: "ad_valorem", priority: 2, valueBasis: "customs_value" },
    ]);
    expect(result.confirmedTotalPercent).toBe("32.2");
  });

  it("adds decimal strings exactly without a JavaScript floating-point sum", () => {
    expect(sumConfirmedPercent(["0.1", "0.2"])).toBe("0.3");
  });

  it("rejects a numeric percentage at runtime instead of coercing it", () => {
    const numericLine = {
      id: "numeric",
      category: "base_duty",
      percent: 0.1,
      confirmed: true,
      kind: "ad_valorem",
      priority: 1,
      valueBasis: "customs_value",
    } as unknown as RateInput;
    const result = evaluateRates([numericLine]);
    expect(result.status).toBe("manual_review");
    expect(result.confirmedTotalPercent).toBeNull();
    expect(() => sumConfirmedPercent([0.1 as unknown as DecimalInput])).toThrow();
  });

  it("does not coerce a numeric specific-duty amount", () => {
    const numericSpecific = {
      id: "numeric-specific",
      category: "base_duty",
      amount: 0.012,
      currency: "CAD",
      unit: "kg",
      confirmed: true,
      kind: "specific",
      priority: 1,
      valueBasis: "customs_value",
    } as unknown as RateInput;
    const result = evaluateRates([numericSpecific]);
    expect(result.status).toBe("manual_review");
    expect(result.confirmedTotalPercent).toBeNull();
    expect(result.lines[0]?.reason).toContain("decimal string");
  });

  it("requires one explicit shared value basis for a confirmed percentage total", () => {
    const result = evaluateRates([
      { id: "general", category: "base_duty", percent: "7.2", confirmed: true, kind: "ad_valorem", priority: 1 },
      { id: "section301", category: "additional_duty", percent: "25", confirmed: true, kind: "ad_valorem", priority: 2 },
    ]);
    expect(result.status).toBe("manual_review");
    expect(result.confirmedTotalPercent).toBeNull();
  });

  it("excludes review items and suppresses a false all-in total for specific duty", () => {
    const result = evaluateRates([
      { id: "mfn", category: "base_duty", percent: "7", confirmed: true, kind: "ad_valorem", priority: 1, valueBasis: "customs_value" },
      { id: "sima", category: "trade_remedy", percent: "180", confirmed: false, kind: "ad_valorem", priority: 2, valueBasis: "customs_value" },
      {
        id: "specific",
        category: "additional_duty",
        amount: "0.012",
        currency: "CAD",
        unit: "kg",
        confirmed: true,
        kind: "specific",
        priority: 3,
      },
    ]);
    expect(result.confirmedTotalPercent).toBeNull();
    expect(result.lines.find((line) => line.id === "sima")?.includedInConfirmedTotal).toBe(false);
  });

  it("keeps GST and MPF/HMF fees outside a customs-duty percentage total", () => {
    const result = evaluateRates([
      { id: "general", category: "base_duty", percent: "5", confirmed: true, kind: "ad_valorem", priority: 1, valueBasis: "customs_value" },
      { id: "gst", category: "tax", percent: "5", confirmed: true, kind: "ad_valorem" },
      { id: "mpf", category: "fee", percent: "0.3464", confirmed: true, kind: "ad_valorem" },
    ]);
    expect(result.confirmedTotalPercent).toBe("5");
    expect(result.lines.filter((line) => line.includedInConfirmedTotal).map((line) => line.id)).toEqual(["general"]);
  });
});
