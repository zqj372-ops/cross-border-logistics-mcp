import { describe, expect, it } from "vitest";

import {
  validateContractSchemas,
} from "../../src/logistics_mcp/platform/validate-contracts";
import {
  containerPlanOutputSchema,
  planContainerSummary,
} from "../../src/logistics_mcp/domains/container/service";

function successInput() {
  return {
    schema_version: "2026-08-11.v1",
    version: "container-config@1",
    plan_id: "plan:contract:001",
    container_type: "40HQ",
    physical_capacity: { value: "76", unit: "cbm" },
    operational_target: { value: "75", unit: "cbm" },
    max_payload: { value: "26000", unit: "kg" },
    source_ref_ids: ["src:container:config"],
    cargo_metrics: {
      version: "cargo-metrics@1",
      line_count: 1,
      total_quantity: 1,
      total_volume: { value: "60", unit: "cbm" },
      actual_weight: { value: "18000", unit: "kg" },
      volumetric_weight: { value: "60", unit: "kg" },
      weight_evidence: "line_total_weight",
      derived_from_line_ids: ["line:contract:001"],
    },
    loading_constraints: {
      sensitive_at_head: true,
      declaration_at_tail: true,
      fifo_for_other: true,
      customer_priority: null,
    },
    loading_lines: [
      {
        line_id: "line:contract:001",
        sensitive: false,
        customer_priority: null,
        declaration_required: false,
      },
    ],
  };
}

describe("container contract and language guard", () => {
  it("validates the shared schemas and baseline examples through the platform validator", () => {
    const report = validateContractSchemas();

    expect(report.failures).toEqual([]);
  });

  it("keeps physical/operational measurements, theory marker, source context, and safe wording", () => {
    const result = planContainerSummary(successInput(), {
      request_id: "req:container:contract",
      audit_id: "audit:container:contract",
    });
    expect(result.status).toBe("success");
    const data = containerPlanOutputSchema.parse(result.data);
    expect(data).toMatchObject({
      theoretical_only: true,
      physical_capacity: { value: "76", unit: "cbm" },
      operational_target: { value: "75", unit: "cbm" },
    });

    const sourceIds = new Set(data?.source_ref_ids);
    expect(sourceIds.size).toBeGreaterThan(0);
    expect(
      data?.special_warnings.every(
        (warning) => warning.field !== undefined && warning.field !== null,
      ),
    ).toBe(true);
    expect(
      result.calculation_trace.every((step) =>
        step.source_ref_ids.some((sourceId) => sourceIds.has(sourceId)),
      ),
    ).toBe(true);

    const serialized = JSON.stringify(result);
    for (const phrase of [
      "guaranteed load",
      "field confirmed",
      "坐标保证",
      "3D",
      "coordinate",
      "center of mass",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  it("rejects spatial layout keys in the domain input contract", () => {
    const input = {
      ...successInput(),
      [["center", "of", "mass"].join("_")]: { value: "not accepted" },
    };

    expect(
      planContainerSummary(input, {
        request_id: "req:container:blocked",
        audit_id: "audit:container:blocked",
      }),
    ).toMatchObject({ status: "blocked", data: null });
  });
});
