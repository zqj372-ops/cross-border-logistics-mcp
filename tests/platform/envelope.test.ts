import { describe, expect, it } from "vitest";
import { createEnvelope } from "../../src/logistics_mcp/platform/envelope";

describe("v1 response envelope", () => {
  it("emits every required field with the baseline defaults", () => {
    const result = createEnvelope({
      requestId: "req_test_001",
      status: "success",
      data: { ok: true },
      auditId: "audit_test_001",
    });

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
});
