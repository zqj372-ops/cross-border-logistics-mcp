import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  validateEnvelope,
  type EnvelopeStatus,
} from "../../src/logistics_mcp/platform/envelope";

const validEnvelope = {
  schema_version: "2026-08-11.v1",
  request_id: "req_valid_001",
  status: "success",
  data: { ok: true },
  source_refs: [],
  assumptions: [],
  warnings: [],
  blockers: [],
  calculation_trace: [],
  review_status: "not_required",
  audit_id: "audit_valid_001",
} as const;

describe("validateEnvelope", () => {
  it("rejects a status outside the v1 enum", () => {
    expect(() =>
      validateEnvelope({ ...validEnvelope, status: "quoted" }),
    ).toThrow(/status/i);
  });

  it("rejects a missing audit id", () => {
    const { audit_id: _auditId, ...withoutAuditId } = validEnvelope;

    expect(() => validateEnvelope(withoutAuditId)).toThrow(/audit_id/i);
  });

  it("rejects unknown top-level fields", () => {
    expect(() =>
      validateEnvelope({
        ...validEnvelope,
        customer_address: "secret customer address",
      }),
    ).toThrow(/additional|customer_address/i);
  });

  it("rejects a schema version outside the baseline", () => {
    expect(() =>
      validateEnvelope({ ...validEnvelope, schema_version: "2026-08-11.v2" }),
    ).toThrow(/schema_version/i);
  });

  it("rejects success combined with blockers", () => {
    expect(() =>
      createEnvelope({
        requestId: "req_invalid_001",
        status: "success",
        data: { ok: true },
        auditId: "audit_invalid_001",
        blockers: [
          {
            code: "security.denied",
            message: "The action is not allowed.",
            severity: "error",
          },
        ],
      }),
    ).toThrow(/success.*blocker/i);
  });

  it("rejects a non-success outcome without a blocker", () => {
    expect(() =>
      createEnvelope({
        requestId: "req_invalid_002",
        status: "blocked" as EnvelopeStatus,
        data: null,
        auditId: "audit_invalid_002",
      }),
    ).toThrow(/blocker/i);
  });
});
