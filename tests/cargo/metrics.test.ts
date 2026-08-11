import { describe, expect, it } from "vitest";

import { calculateCargoMetrics } from "../../src/logistics_mcp/domains/cargo/metrics";

function line(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "cargo-line@1",
    line_id: "line_1",
    description: "carton",
    quantity: 2,
    quantity_unit: "carton",
    package_type: "carton",
    stackable: true,
    fragile: false,
    sensitive: false,
    source_ref_ids: ["src_input_1"],
    unit_weight: { value: "12.5", unit: "kg" },
    dimensions: [
      {
        length: { value: "60", unit: "cm" },
        width: { value: "50", unit: "cm" },
        height: { value: "40", unit: "cm" },
        quantity: 2,
      },
    ],
    ...overrides,
  };
}

function expectMetrics(input: unknown[]) {
  const result = calculateCargoMetrics(input);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.diagnostic.message);
  }
  return result.metrics;
}

describe("cargo metrics", () => {
  it("calculates CBM from dimensions with exact decimal output", () => {
    const metrics = expectMetrics([line()]);

    expect(metrics.total_volume).toEqual({ value: "0.240000", unit: "cbm" });
    expect(metrics.actual_weight).toEqual({ value: "25.0", unit: "kg" });
    expect(metrics.weight_evidence).toBe("unit_weight");
  });

  it("multiplies a unit weight by quantity without binary float arithmetic", () => {
    const metrics = expectMetrics([
      line({
        quantity: 4,
        line_id: "line_unit_weight",
        dimensions: [
          {
            length: { value: "1", unit: "m" },
            width: { value: "1", unit: "m" },
            height: { value: "1", unit: "m" },
            quantity: 4,
          },
        ],
      }),
    ]);

    expect(metrics.actual_weight).toEqual({ value: "50.0", unit: "kg" });
  });

  it("keeps a line-total weight as a total instead of multiplying it by quantity", () => {
    const metrics = expectMetrics([
      line({
        line_id: "line_total_weight",
        line_total_weight: { value: "1800", unit: "kg" },
        unit_weight: undefined,
      }),
    ]);

    expect(metrics.actual_weight).toEqual({ value: "1800", unit: "kg" });
    expect(metrics.weight_evidence).toBe("line_total_weight");
  });

  it("converts millimetres and grams to canonical units", () => {
    const metrics = expectMetrics([
      line({
        line_id: "line_metric_units",
        unit_weight: { value: "1000", unit: "g" },
        dimensions: [
          {
            length: { value: "600", unit: "mm" },
            width: { value: "500", unit: "mm" },
            height: { value: "400", unit: "mm" },
            quantity: 2,
          },
        ],
      }),
    ]);

    expect(metrics.total_volume).toEqual({ value: "0.240000", unit: "cbm" });
    expect(metrics.actual_weight).toEqual({ value: "2.000000", unit: "kg" });
  });

  it("converts pounds deterministically to kilograms", () => {
    const metrics = expectMetrics([
      line({
        line_id: "line_lb",
        quantity: 1,
        unit_weight: { value: "2.20462262185", unit: "lb" },
        dimensions: [
          {
            length: { value: "1", unit: "cm" },
            width: { value: "1", unit: "cm" },
            height: { value: "1", unit: "cm" },
            quantity: 1,
          },
        ],
      }),
    ]);

    expect(metrics.actual_weight).toEqual({ value: "1.0000000000005552845", unit: "kg" });
  });

  it("does not silently truncate high-precision decimal measurements", () => {
    const metrics = expectMetrics([
      line({
        line_id: "line_high_precision",
        quantity: 1,
        unit_weight: { value: "0.123456789012345678901", unit: "kg" },
        dimensions: [
          {
            length: { value: "0.123456789", unit: "m" },
            width: { value: "1", unit: "cm" },
            height: { value: "1", unit: "cm" },
            quantity: 1,
          },
        ],
      }),
    ]);

    expect(metrics.actual_weight).toEqual({
      value: "0.123456789012345678901",
      unit: "kg",
    });
    expect(metrics.total_volume).toEqual({
      value: "0.0000123456789",
      unit: "cbm",
    });
  });

  it("fails closed when the aggregate quantity exceeds the output integer boundary", () => {
    const result = calculateCargoMetrics([
      line({
        line_id: "line_quantity_a",
        quantity: Number.MAX_SAFE_INTEGER,
        volume: { value: "0", unit: "cbm" },
        dimensions: undefined,
      }),
      line({
        line_id: "line_quantity_b",
        quantity: 1,
        volume: { value: "0", unit: "cbm" },
        dimensions: undefined,
      }),
    ]);

    expect(result).toMatchObject({
      ok: false,
      code: "cargo.total_quantity_invalid",
      status: "manual_review",
    });
  });

  it("rejects a conflict between direct volume and dimension-derived volume", () => {
    const result = calculateCargoMetrics([
      line({ volume: { value: "0.3", unit: "cbm" } }),
    ]);

    expect(result).toMatchObject({
      ok: false,
      code: "cargo.volume_conflict",
      status: "manual_review",
    });
  });

  it("returns needs_input when a line has no weight evidence", () => {
    const result = calculateCargoMetrics([
      line({ unit_weight: undefined }),
    ]);

    expect(result).toMatchObject({
      ok: false,
      code: "cargo.weight_evidence_missing",
      status: "needs_input",
    });
  });

  it("aggregates multiple lines and preserves every line source in the trace", () => {
    const metricsResult = calculateCargoMetrics([
      line({ line_id: "line_1", source_ref_ids: ["src_input_1"] }),
      line({ line_id: "line_2", source_ref_ids: ["src_input_2"] }),
    ]);

    expect(metricsResult.ok).toBe(true);
    if (!metricsResult.ok) {
      throw new Error(metricsResult.diagnostic.message);
    }
    expect(metricsResult.metrics.total_volume).toEqual({ value: "0.480000", unit: "cbm" });
    expect(metricsResult.metrics.actual_weight).toEqual({ value: "50.0", unit: "kg" });
    expect(metricsResult.metrics.line_count).toBe(2);
    expect(metricsResult.metrics.total_quantity).toBe(4);
    expect(metricsResult.calculation_trace.length).toBeGreaterThan(0);
    expect(
      metricsResult.calculation_trace.some((step) => step.source_ref_ids.includes("src_input_1")),
    ).toBe(true);
    expect(
      metricsResult.calculation_trace.some((step) => step.source_ref_ids.includes("src_input_2")),
    ).toBe(true);
  });
});
