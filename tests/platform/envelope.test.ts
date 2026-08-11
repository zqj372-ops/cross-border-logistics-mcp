import { describe, expect, it } from "vitest";
import {
  ENVELOPE_SCHEMA_VERSION,
  createEnvelope,
  validateEnvelope,
} from "../../src/logistics_mcp/platform/envelope";

describe("v1 response envelope", () => {
  it("emits every required field with the baseline defaults", () => {
    const result = createEnvelope({
      requestId: "req_test_001",
      status: "success",
      data: { ok: true },
      auditId: "audit_test_001",
    });

    expect(validateEnvelope(result)).toEqual(result);
    expect(result.schema_version).toBe(ENVELOPE_SCHEMA_VERSION);

    expect(result).toMatchObject({
      schema_version: "2026-08-11.v1",
      request_id: "req_test_001",
      status: "success",
      data: { ok: true },
      source_refs: [],
      assumptions: [],
      warnings: [],
      blockers: [],
      calculation_trace: [],
      review_status: "not_required",
      audit_id: "audit_test_001",
    });
  });

  it("emits an explicit blocker for a non-success outcome", () => {
    const result = createEnvelope({
      requestId: "req_test_002",
      status: "needs_input",
      data: null,
      auditId: "audit_test_002",
      blockers: [
        {
          code: "input.missing",
          message: "A required field is missing.",
          severity: "error",
          field: "input.field",
        },
      ],
    });

    expect(result.status).toBe("needs_input");
    expect(result.blockers).toHaveLength(1);
  });
});
