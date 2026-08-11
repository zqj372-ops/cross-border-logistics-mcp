import { describe, expect, it } from "vitest";

import { validateContractSchemas } from "../../src/logistics_mcp/platform/validate-contracts";

describe("contract schema validation", () => {
  it("validates every Draft 2020-12 schema and baseline example", () => {
    const report = validateContractSchemas();

    expect(report.schemaCount).toBeGreaterThan(0);
    expect(report.exampleCount).toBe(11);
    expect(report.failures).toEqual([]);
  });
});
