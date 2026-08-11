import { describe, expect, it } from "vitest";

import {
  validateCargoMetrics,
  validateContainerProfile,
} from "../../src/logistics_mcp/domains/container/models";
import {
  validateLoadingConstraints,
  validateLoadingLines,
} from "../../src/logistics_mcp/domains/container/constraints";

const profile = {
  version: "container-config@1",
  container_type: "40HQ",
  physical_capacity: { value: "76", unit: "cbm" },
  operational_target: { value: "75", unit: "cbm" },
  max_payload: { value: "26000", unit: "kg" },
  source_ref_ids: ["src:container:config"],
} as const;

const cargoMetrics = {
  version: "cargo-metrics@1",
  line_count: 1,
  total_quantity: 2,
  total_volume: { value: "1.25", unit: "cbm" },
  actual_weight: { value: "100", unit: "kg" },
  volumetric_weight: { value: "125", unit: "kg" },
  weight_evidence: "unit_weight",
  derived_from_line_ids: ["line:001"],
} as const;

describe("container profile and read-only cargo DTOs", () => {
  it("requires separate physical capacity, operational target, payload units, version, and source refs", () => {
    expect(validateContainerProfile(profile)).toMatchObject({ ok: true });
  });

  it("rejects a capacity expressed in kilograms", () => {
    const result = validateContainerProfile({
      ...profile,
      physical_capacity: { value: "76", unit: "kg" },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "container.capacity_unit_invalid",
    });
  });

  it("rejects missing versions, source refs, zero capacity, negative values, and unknown fields", () => {
    expect(
      validateContainerProfile({
        ...profile,
        version: undefined,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateContainerProfile({
        ...profile,
        source_ref_ids: [],
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateContainerProfile({
        ...profile,
        physical_capacity: { value: "0", unit: "cbm" },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateContainerProfile({
        ...profile,
        max_payload: { value: "-1", unit: "kg" },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateContainerProfile({ ...profile, unexpected: true }),
    ).toMatchObject({ ok: false });
  });

  it("accepts CargoMetrics-compatible read-only input and rejects conflicting shape", () => {
    expect(validateCargoMetrics(cargoMetrics)).toMatchObject({ ok: true });
    expect(
      validateCargoMetrics({ ...cargoMetrics, unknown_field: "nope" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCargoMetrics({
        ...cargoMetrics,
        actual_weight: { value: "-1", unit: "kg" },
      }),
    ).toMatchObject({ ok: false });
  });

  it("requires all loading constraint flags and validates line metadata", () => {
    expect(
      validateLoadingConstraints({
        sensitive_at_head: true,
        declaration_at_tail: true,
        fifo_for_other: true,
        customer_priority: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateLoadingConstraints({
        sensitive_at_head: true,
        declaration_at_tail: true,
        fifo_for_other: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateLoadingLines([
        {
          line_id: "line:001",
          sensitive: true,
          customer_priority: 1,
          declaration_required: false,
        },
      ]),
    ).toMatchObject({ ok: true });
  });
});
