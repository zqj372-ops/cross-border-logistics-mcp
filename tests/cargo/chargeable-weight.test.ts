import { describe, expect, it } from "vitest";

import {
  calculateChargeableWeight,
  calculateVolumetricWeight,
} from "../../src/logistics_mcp/domains/cargo/chargeable";

const ruleBase = {
  channel: "CAQ-HP",
  rule_version: "CAQ-HP@2026-01-01",
  source_ref_ids: ["src_rule_1"],
  unit: "kg" as const,
  rounding: { mode: "none" as const, decimals: 6 },
  method: "full" as const,
};

describe("chargeable weight", () => {
  it.each([
    ["none", "1000", "1500", "1500", "0"],
    ["full", "1000", "1500", "1500", "1"],
    ["half", "1000", "1500", "1250", "0.5"],
    ["ratio", "1000", "1500", "1200", "0.4"],
  ])("calculates %s without float arithmetic", (method, actual, volumetric, expected, ratio) => {
    const result = calculateChargeableWeight({
      actual,
      volumetric,
      method: method as "none" | "full" | "half" | "ratio",
      ratio,
      ruleVersion: "CAQ-HP@2026-01-01",
      sourceRefIds: ["src_rule_1"],
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok !== true) {
      throw new Error(result.diagnostic.message);
    }
    expect(result.customer_chargeable_weight.value).toBe(expected);
    expect(result.bubble_share_ratio).toBe(ratio);
  });

  it.each([
    ["none", "0"],
    ["full", "1"],
    ["half", "0.5"],
    ["ratio", "0"],
    ["ratio", "1"],
  ])("keeps actual weight when volumetric weight is lower (%s, %s)", (method, ratio) => {
    const result = calculateChargeableWeight({
      actual: "1500.25",
      volumetric: "1000.125",
      method: method as "none" | "full" | "half" | "ratio",
      ratio,
      ruleVersion: "CAQ-HP@2026-01-01",
      sourceRefIds: ["src_rule_1"],
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok !== true) {
      throw new Error(result.diagnostic.message);
    }
    expect(result.bubble_weight).toEqual({ value: "0", unit: "kg" });
    expect(result.customer_chargeable_weight).toEqual({ value: "1500.25", unit: "kg" });
  });

  it("requires a ratio for ratio mode and rejects ratios outside [0, 1]", () => {
    expect(
      calculateChargeableWeight({
        actual: "1000",
        volumetric: "1500",
        method: "ratio",
        ruleVersion: "CAQ-HP@2026-01-01",
        sourceRefIds: ["src_rule_1"],
      }),
    ).toMatchObject({ ok: false, code: "cargo.ratio_required", status: "needs_input" });
    expect(
      calculateChargeableWeight({
        actual: "1000",
        volumetric: "1500",
        method: "ratio",
        ratio: "1.01",
        ruleVersion: "CAQ-HP@2026-01-01",
        sourceRefIds: ["src_rule_1"],
      }),
    ).toMatchObject({ ok: false, code: "cargo.ratio_out_of_range", status: "needs_input" });
  });

  it("requires a version and unique source references", () => {
    expect(
      calculateChargeableWeight({
        actual: "1000",
        volumetric: "1500",
        method: "full",
        ruleVersion: "",
        sourceRefIds: ["src_rule_1"],
      }),
    ).toMatchObject({ ok: false, code: "cargo.rule_version_missing" });
    expect(
      calculateChargeableWeight({
        actual: "1000",
        volumetric: "1500",
        method: "full",
        ruleVersion: "CAQ-HP@2026-01-01",
        sourceRefIds: ["src_rule_1", "src_rule_1"],
      }),
    ).toMatchObject({ ok: false, code: "cargo.source_ref_ids_duplicate" });
    expect(
      calculateChargeableWeight({
        actual: "1000",
        volumetric: "1500",
        method: "full",
        ruleVersion: "CAQ-HP@2026-01-01",
        sourceRefIds: [],
      }),
    ).toMatchObject({ ok: false, code: "cargo.source_ref_ids_invalid" });
  });

  it("calculates volumetric weight only from an explicit density", () => {
    const result = calculateVolumetricWeight({
      volume: { value: "2.5", unit: "cbm" },
      rule: {
        ...ruleBase,
        density: { value: "400", unit: "kg_per_cbm" },
      },
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok !== true) {
      throw new Error(result.diagnostic.message);
    }
    expect(result.volumetric_weight).toEqual({ value: "1000", unit: "kg" });
    expect(result.calculation_trace.some((step) => step.source_ref_ids.includes("src_rule_1"))).toBe(true);
  });

  it("calculates volumetric weight only from an explicit divisor", () => {
    const result = calculateVolumetricWeight({
      volume: { value: "2.5", unit: "cbm" },
      rule: {
        ...ruleBase,
        divisor: { value: "0.0025", unit: "cbm_per_kg" },
      },
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok !== true) {
      throw new Error(result.diagnostic.message);
    }
    expect(result.volumetric_weight).toEqual({ value: "1000", unit: "kg" });
  });

  it("fails closed when dimensional density/divisor is absent or ambiguous", () => {
    expect(
      calculateVolumetricWeight({ volume: { value: "2.5", unit: "cbm" }, rule: ruleBase }),
    ).toMatchObject({ ok: false, code: "cargo.dimensional_basis_missing" });
    expect(
      calculateVolumetricWeight({
        volume: { value: "2.5", unit: "cbm" },
        rule: {
          ...ruleBase,
          density: { value: "400", unit: "kg_per_cbm" },
          divisor: { value: "0.0025", unit: "cbm_per_kg" },
        },
      }),
    ).toMatchObject({ ok: false, code: "cargo.dimensional_basis_conflict" });
  });

  it("applies explicit rounding rules with Decimal arithmetic", () => {
    const rounded = calculateVolumetricWeight({
      volume: { value: "1.234", unit: "cbm" },
      rule: {
        ...ruleBase,
        density: { value: "10", unit: "kg_per_cbm" },
        rounding: { mode: "half_up", decimals: 1 },
      },
    });

    expect(rounded).toMatchObject({ ok: true });
    if (rounded.ok !== true) {
      throw new Error(rounded.diagnostic.message);
    }
    expect(rounded.volumetric_weight.value).toBe("12.3");
  });

  it("does not expose currency fields in a weight-only result", () => {
    const result = calculateChargeableWeight({
      actual: "1000",
      volumetric: "1500",
      method: "half",
      ratio: "0.5",
      ruleVersion: "CAQ-HP@2026-01-01",
      sourceRefIds: ["src_rule_1"],
    });

    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toMatch(/currency|CAD|USD/);
  });
});
