import { describe, expect, it } from "vitest";

import {
  summarizeContainer,
  type ContainerSummaryOptions,
} from "../../src/logistics_mcp/domains/container/summary";
import type {
  CargoMetrics,
  ContainerProfile,
} from "../../src/logistics_mcp/domains/container/models";

const profile: ContainerProfile = {
  version: "container-config@1",
  container_type: "40HQ",
  physical_capacity: { value: "76", unit: "cbm" },
  operational_target: { value: "75", unit: "cbm" },
  max_payload: { value: "26000", unit: "kg" },
  source_ref_ids: ["src:container:config"],
};

function metrics(
  volume: string,
  weight: string,
  lineIds: readonly string[] = ["line:001"],
): CargoMetrics {
  return {
    version: "cargo-metrics@1",
    line_count: lineIds.length,
    total_quantity: lineIds.length,
    total_volume: { value: volume, unit: "cbm" },
    actual_weight: { value: weight, unit: "kg" },
    volumetric_weight: { value: volume, unit: "kg" },
    weight_evidence: "line_total_weight",
    derived_from_line_ids: [...lineIds],
  };
}

function options(overrides: Partial<ContainerSummaryOptions> = {}) {
  return {
    plan_id: "plan:container:001",
    loading_order: ["line:001"],
    overflow_line_ids: [],
    ...overrides,
  } satisfies ContainerSummaryOptions;
}

describe("container utilization summary", () => {
  it("calculates the 40HQ example with exact decimal strings", () => {
    const result = summarizeContainer(profile, metrics("60", "18000"), options());

    expect(result.utilization_ratio).toBe("0.8000");
    expect(result.remaining_volume).toEqual({ value: "15", unit: "cbm" });
    expect(result.total_volume).toEqual({ value: "60", unit: "cbm" });
    expect(result.total_weight).toEqual({ value: "18000", unit: "kg" });
    expect(result.over_capacity).toBe(false);
    expect(result.overweight).toBe(false);
    expect(result.theoretical_only).toBe(true);
  });

  it("keeps an operational overage visible even when physical capacity is not exceeded", () => {
    const result = summarizeContainer(profile, metrics("75.5", "18000"), options());

    expect(result.over_capacity).toBe(true);
    expect(result.remaining_volume).toEqual({ value: "0", unit: "cbm" });
    expect(result.special_warnings.map((warning) => warning.code)).toContain(
      "container.capacity.operational-exceeded",
    );
    expect(
      result.special_warnings.some((warning) => warning.message.includes("1.0067")),
    ).toBe(true);
  });

  it("reports physical overflow separately from the operational target", () => {
    const result = summarizeContainer(profile, metrics("77", "18000"), options());

    expect(result.over_capacity).toBe(true);
    expect(result.special_warnings.map((warning) => warning.code)).toContain(
      "container.capacity.physical-exceeded",
    );
    expect(
      result.special_warnings.some((warning) => warning.message.includes("1 cbm")),
    ).toBe(true);
  });

  it("reports payload overflow and remaining payload in the diagnostic summary", () => {
    const result = summarizeContainer(profile, metrics("60", "26001"), options());

    expect(result.overweight).toBe(true);
    expect(result.special_warnings.map((warning) => warning.code)).toContain(
      "container.payload.exceeded",
    );
    expect(
      result.special_warnings.some((warning) => warning.message.includes("1 kg")),
    ).toBe(true);
  });

  it("handles zero cargo without NaN, infinity, or negative remainder", () => {
    const result = summarizeContainer(
      profile,
      metrics("0", "0", []),
      options({ loading_order: [] }),
    );

    expect(result.utilization_ratio).toBe("0.0000");
    expect(result.remaining_volume).toEqual({ value: "75", unit: "cbm" });
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity|-[0-9]/);
  });

  it("derives the bottleneck and minimum container count in auditable warnings", () => {
    const result = summarizeContainer(
      profile,
      metrics("151", "52001", ["line:001", "line:002"]),
      options({ loading_order: ["line:001", "line:002"] }),
    );

    expect(result.special_warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "container.capacity.bottleneck",
        "container.plan.minimum-containers",
        "container.overflow.summary",
      ]),
    );
    expect(
      result.special_warnings.some((warning) => warning.message.includes("3 个柜")),
    ).toBe(true);
  });
});
