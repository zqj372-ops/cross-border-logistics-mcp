import { describe, expect, it, vi } from "vitest";

import {
  assertCandidateSyntheticWriteTarget,
} from "../../services/access-gateway/deployment-safety";

describe("synthetic deployment target guard", () => {
  it("accepts only an operational non-production candidate readiness response", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      status: "manual_review",
      data: {
        profile: "single-node-candidate",
        operational_ready: true,
        production_eligible: false,
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(assertCandidateSyntheticWriteTarget({
      baseUrl: new URL("https://candidate.example/"),
      fetchImpl,
    })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://candidate.example/access/v1/readyz"),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("rejects a target that reports production eligibility", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      status: "success",
      data: {
        profile: "single-node-candidate",
        operational_ready: true,
        production_eligible: true,
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(assertCandidateSyntheticWriteTarget({
      baseUrl: new URL("https://production.example/"),
      fetchImpl,
    })).rejects.toThrow("Synthetic deployment writes are forbidden for this target.");
  });
});
