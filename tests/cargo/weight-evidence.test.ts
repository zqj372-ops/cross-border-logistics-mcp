import { describe, expect, it } from "vitest";

import { validateCargoLine } from "../../src/logistics_mcp/domains/cargo/models";

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
    unit_weight: { value: "10", unit: "kg" },
    ...overrides,
  };
}

describe("CargoLine weight evidence", () => {
  it.each([
    ["unit_weight", { unit_weight: { value: "10", unit: "kg" } }],
    [
      "piece_weights",
      {
        piece_weights: [
          { value: "4", unit: "kg" },
          { value: "6", unit: "kg" },
        ],
      },
    ],
    ["line_total_weight", { line_total_weight: { value: "20", unit: "kg" } }],
  ])("accepts exactly one %s evidence mode", (_mode, evidence) => {
    const result = validateCargoLine(
      line({
        unit_weight: undefined,
        ...evidence,
      }),
    );

    expect(result).toMatchObject({ ok: true });
  });

  it("allows a line with no weight evidence so the service can return needs_input", () => {
    const result = validateCargoLine(line({ unit_weight: undefined }));

    expect(result).toMatchObject({ ok: true });
  });

  it("fails closed when any two weight evidence modes are mixed", () => {
    const result = validateCargoLine(
      line({
        line_total_weight: { value: "20", unit: "kg" },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "cargo.weight_evidence_mixed",
      status: "manual_review",
    });
  });

  it("rejects piece weights whose length does not equal the line quantity", () => {
    const result = validateCargoLine(
      line({
        unit_weight: undefined,
        piece_weights: [{ value: "10", unit: "kg" }],
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "cargo.piece_weights_quantity_mismatch",
      status: "manual_review",
    });
  });

  it("rejects unknown fields instead of silently carrying them forward", () => {
    const result = validateCargoLine(line({ customer_total_weight: "20" }));

    expect(result).toMatchObject({
      ok: false,
      code: "cargo.unknown_field",
      status: "needs_input",
    });
  });

  it("rejects numeric decimal values and negative measurements", () => {
    expect(validateCargoLine(line({ unit_weight: { value: 10, unit: "kg" } }))).toMatchObject({
      ok: false,
      code: "cargo.decimal_string_required",
    });
    expect(
      validateCargoLine(line({ unit_weight: { value: "-1", unit: "kg" } })),
    ).toMatchObject({
      ok: false,
      code: "cargo.negative_value",
    });
  });

  it("rejects duplicate source references and unsupported measurement units", () => {
    expect(
      validateCargoLine(line({ source_ref_ids: ["src_input_1", "src_input_1"] })),
    ).toMatchObject({
      ok: false,
      code: "cargo.source_ref_ids_duplicate",
    });
    expect(
      validateCargoLine(line({ unit_weight: { value: "10", unit: "ton" } })),
    ).toMatchObject({
      ok: false,
      code: "cargo.unit_invalid",
    });
  });
});
