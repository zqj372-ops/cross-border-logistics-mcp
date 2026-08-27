import { describe, expect, it } from "vitest";

import {
  inspectToolOutcome,
  summarizeLatency,
} from "../../services/access-gateway/deployment-load";

describe("T0 deployment load metrics", () => {
  it("reports deterministic nearest-rank percentiles without mutating samples", () => {
    const samples = Array.from({ length: 100 }, (_, index) => 100 - index);
    expect(summarizeLatency(samples)).toEqual({
      count: 100,
      p50_ms: 50,
      p95_ms: 95,
      p99_ms: 99,
      max_ms: 100,
    });
    expect(samples[0]).toBe(100);
  });

  it("rejects an empty latency sample", () => {
    expect(() => summarizeLatency([])).toThrow("Latency samples are empty.");
  });

  it("counts an audit persistence blocker separately from transport failures", () => {
    expect(inspectToolOutcome({
      structuredContent: {
        status: "manual_review",
        blockers: [{
          code: "audit.persistence_failed",
          message: "Audit unavailable.",
          severity: "error",
          field: null,
        }],
      },
    })).toEqual({ status: "manual_review", auditFailed: true });
    expect(inspectToolOutcome({
      structuredContent: {
        status: "success",
        blockers: [],
      },
    })).toEqual({ status: "success", auditFailed: false });
  });
});
