import { describe, expect, it } from "vitest";

import { registerPhaseOneTools } from "../../src/logistics_mcp/server/tool-registry";
import {
  containerPlanSummaryHandler,
  containerPlanSummaryToolContract,
  planContainerSummary,
} from "../../src/logistics_mcp/domains/container/service";

function cargoMetrics(overrides: Record<string, unknown> = {}) {
  return {
    version: "cargo-metrics@1",
    line_count: 4,
    total_quantity: 4,
    total_volume: { value: "60", unit: "cbm" },
    actual_weight: { value: "18000", unit: "kg" },
    volumetric_weight: { value: "60", unit: "kg" },
    weight_evidence: "line_total_weight",
    derived_from_line_ids: [
      "line:sensitive",
      "line:priority",
      "line:ordinary",
      "line:declaration",
    ],
    ...overrides,
  };
}

function completeInput(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "2026-08-11.v1",
    version: "container-config@1",
    plan_id: "plan:container:001",
    container_type: "40HQ",
    physical_capacity: { value: "76", unit: "cbm" },
    operational_target: { value: "75", unit: "cbm" },
    max_payload: { value: "26000", unit: "kg" },
    source_ref_ids: ["src:container:config"],
    cargo_metrics: cargoMetrics(),
    loading_constraints: {
      sensitive_at_head: true,
      declaration_at_tail: true,
      fifo_for_other: true,
      customer_priority: null,
    },
    loading_lines: [
      {
        line_id: "line:sensitive",
        sensitive: true,
        customer_priority: 3,
        declaration_required: false,
      },
      {
        line_id: "line:priority",
        sensitive: false,
        customer_priority: 1,
        declaration_required: false,
      },
      {
        line_id: "line:ordinary",
        sensitive: false,
        customer_priority: null,
        declaration_required: false,
      },
      {
        line_id: "line:declaration",
        sensitive: false,
        customer_priority: 2,
        declaration_required: true,
      },
    ],
    ...overrides,
  };
}

describe("container.plan_summary service outcomes", () => {
  it("returns success with versions, sources, trace, and a server-controlled theory marker", () => {
    const result = planContainerSummary(completeInput());

    expect(result.status).toBe("success");
    if (result.data === null) {
      throw new Error("Expected a successful container plan.");
    }
    expect(result.data).toMatchObject({
      version: "container-plan@container-config@1/cargo@cargo-metrics@1",
      physical_capacity: { value: "76", unit: "cbm" },
      operational_target: { value: "75", unit: "cbm" },
      theoretical_only: true,
    });
    expect(result.data.source_ref_ids).toContain("src:container:config");
    expect(result.calculation_trace.length).toBeGreaterThanOrEqual(4);
    expect(result.blockers).toEqual([]);
    expect(
      result.data.theoretical_only,
    ).toBe(true);
    expect(() =>
      containerPlanSummaryToolContract.validateOutput(result.data),
    ).not.toThrow();
  });

  it("returns needs_input when the operational target is missing", () => {
    const input = completeInput({ operational_target: undefined });

    const result = planContainerSummary(input);

    expect(result.status).toBe("needs_input");
    expect(result.data).toBeNull();
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("returns needs_input when weight evidence is missing", () => {
    const result = planContainerSummary(
      completeInput({
        cargo_metrics: cargoMetrics({ weight_evidence: "missing" }),
      }),
    );

    expect(result.status).toBe("needs_input");
    expect(result.data).toBeNull();
    expect(result.blockers[0]?.code).toBe(
      "container.cargo.weight-evidence-required",
    );
  });

  it("returns manual_review with the non-final summary for capacity or payload violations", () => {
    const result = planContainerSummary(
      completeInput({
        cargo_metrics: cargoMetrics({
          total_volume: { value: "77", unit: "cbm" },
          actual_weight: { value: "26001", unit: "kg" },
        }),
      }),
    );

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({
      over_capacity: true,
      overweight: true,
      theoretical_only: true,
    });
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "container.capacity.manual-review",
        "container.payload.manual-review",
      ]),
    );
  });

  it("returns manual_review for incompatible loading constraints", () => {
    const result = planContainerSummary(
      completeInput({
        cargo_metrics: cargoMetrics({
          derived_from_line_ids: ["line:conflict"],
          line_count: 1,
          total_quantity: 1,
        }),
        loading_lines: [
          {
            line_id: "line:conflict",
            sensitive: true,
            customer_priority: null,
            declaration_required: true,
          },
        ],
      }),
    );

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({ theoretical_only: true });
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      "container.loading.manual-review",
    );
  });

  it("blocks spatial-layout requests before calculating any summary", () => {
    const result = planContainerSummary(
      completeInput({ spatial_layout_requested: true }),
    );

    expect(result.status).toBe("blocked");
    expect(result.data).toBeNull();
    expect(result.calculation_trace).toEqual([]);
  });

  it("does not allow a caller to set or override the theory marker", () => {
    const result = planContainerSummary(
      completeInput({ theoretical_only: false }),
    );

    expect(result.status).toBe("needs_input");
    expect(result.data).toBeNull();
  });

  it("exports a strict contract that can be injected into the platform registry", () => {
    expect(
      containerPlanSummaryToolContract.inputSchema.safeParse(completeInput())
        .success,
    ).toBe(true);
    expect(
      containerPlanSummaryToolContract.inputSchema.safeParse(
        completeInput({ unexpected: true }),
      ).success,
    ).toBe(false);

    const definition = registerPhaseOneTools(
      { "container.plan_summary": containerPlanSummaryHandler },
      { "container.plan_summary": containerPlanSummaryToolContract },
    ).find((tool) => tool.name === "container.plan_summary");

    expect(definition?.handler).toBe(containerPlanSummaryHandler);
    expect(definition?.inputSchema).toBe(
      containerPlanSummaryToolContract.inputSchema,
    );
    expect(definition?.validateOutput).toBe(
      containerPlanSummaryToolContract.validateOutput,
    );
  });
});
