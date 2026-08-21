import { describe, expect, it } from "vitest";

import {
  ENVELOPE_STATUSES,
} from "../../src/logistics_mcp/platform/envelope";
import {
  phaseOneToolNames,
  registerPhaseOneTools,
} from "../../src/logistics_mcp/server/tool-registry";

describe("platform verification contract", () => {
  it("gives every allowlisted tool schema, permission, and status mapping", () => {
    const definitions = registerPhaseOneTools();

    expect(definitions).toHaveLength(10);
    expect(definitions.map((definition) => definition.name)).toEqual(
      phaseOneToolNames,
    );
    for (const definition of definitions) {
      expect(definition.permission).toMatch(/^[a-z]+:[a-z_]+$/);
      expect(definition.inputSchemaId).toContain(
        definition.name === "quote.canada_final_mile.calculate"
          ? "2026-08-13.v2"
          : definition.name === "quote.create_pdf"
            ? "2026-08-14.v1"
            : "2026-08-11.v1",
      );
      expect(definition.outputSchemaId).toMatch(/\.schema\.json$/);
      expect(definition.statusMapping).toEqual(ENVELOPE_STATUSES);
    }
  });

  it("has no generic commit, send, publish, booking, or rules write tool", () => {
    expect(
      phaseOneToolNames.some((name) =>
        /commit_operation|send|publish|booking\.submit|rules\.write/i.test(
          name,
        ),
      ),
    ).toBe(false);
  });
});
