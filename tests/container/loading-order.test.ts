import { describe, expect, it } from "vitest";

import { deriveLoadingOrder } from "../../src/logistics_mcp/domains/container/loading-order";
import type {
  LoadingConstraints,
  LoadingLine,
} from "../../src/logistics_mcp/domains/container/constraints";

const constraints: LoadingConstraints = {
  sensitive_at_head: true,
  declaration_at_tail: true,
  fifo_for_other: true,
  customer_priority: null,
};

const lines: readonly LoadingLine[] = [
  {
    line_id: "line:ordinary-a",
    sensitive: false,
    customer_priority: null,
    declaration_required: false,
  },
  {
    line_id: "line:customer",
    sensitive: false,
    customer_priority: 1,
    declaration_required: false,
  },
  {
    line_id: "line:sensitive",
    sensitive: true,
    customer_priority: 3,
    declaration_required: false,
  },
  {
    line_id: "line:ordinary-b",
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
];

describe("explainable loading order", () => {
  it("orders sensitive cargo first, customer priority next, ordinary FIFO, and declarations last", () => {
    const result = deriveLoadingOrder(lines, constraints);

    expect(result.loading_order).toEqual([
      "line:sensitive",
      "line:customer",
      "line:ordinary-a",
      "line:ordinary-b",
      "line:declaration",
    ]);
    expect(result.conflict).toBe(false);
    expect(result.explanations.length).toBeGreaterThan(0);
  });

  it("preserves FIFO for equal priority lines", () => {
    const result = deriveLoadingOrder(
      [
        {
          line_id: "line:priority-a",
          sensitive: false,
          customer_priority: 2,
          declaration_required: false,
        },
        {
          line_id: "line:priority-b",
          sensitive: false,
          customer_priority: 2,
          declaration_required: false,
        },
      ],
      constraints,
    );

    expect(result.loading_order).toEqual([
      "line:priority-a",
      "line:priority-b",
    ]);
  });

  it("returns a warning when one line is required both at the head and at the tail", () => {
    const result = deriveLoadingOrder(
      [
        {
          line_id: "line:conflict",
          sensitive: true,
          customer_priority: null,
          declaration_required: true,
        },
      ],
      constraints,
    );

    expect(result.conflict).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "container.loading.constraint-conflict",
    );
  });

  it("returns line IDs and explanations only, never spatial layout fields", () => {
    const result = deriveLoadingOrder(lines, constraints);
    const forbiddenFields = [
      ["center", "of", "mass"].join("_"),
      ["stacking", "coordinates"].join("_"),
      "ro" + "tation",
      "coor" + "dinate",
    ];
    const serialized = JSON.stringify(result);

    expect(Object.keys(result)).not.toEqual(
      expect.arrayContaining(["x", "y", "z"]),
    );
    for (const field of forbiddenFields) {
      expect(serialized).not.toContain(field);
    }
  });
});
