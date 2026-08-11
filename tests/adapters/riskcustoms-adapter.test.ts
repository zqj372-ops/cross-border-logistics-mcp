import { describe, expect, it, vi } from "vitest";

import {
  RiskCustomsAdapter,
  type RiskCustomsCandidate,
  type RiskCustomsEstimateRecord,
  type RiskCustomsStatusRecord,
  type RiskCustomsSearchRecord,
  type RiskCustomsUpstreamSource,
} from "../../src/logistics_mcp/adapters/customs/riskcustoms-adapter";

const sourceRef = {
  source_id: "src:customs:fixture:1",
  source_type: "fixture" as const,
  system: "RiskCustoms",
  locator: "fixture://riskcustoms/ca-release-demo-1",
  version: "ca-release-demo-1",
  retrieved_at: "2026-08-11T00:00:00Z",
  authority: "authoritative" as const,
  content_hash: "sha256:customs-release-1",
};

function readyStatus(
  overrides: Partial<RiskCustomsStatusRecord> = {},
): RiskCustomsStatusRecord {
  return {
    version: "data-status@fixture-1",
    system: "riskcustoms",
    ready: true,
    test_data: false,
    evaluated_at: "2026-08-11T00:00:00Z",
    last_source_check_at: "2026-08-11T00:00:00Z",
    reasons: [],
    release_ids: ["ca-release-demo-1"],
    snapshot_hash: "sha256:customs-snapshot-1",
    release_hash: "sha256:customs-snapshot-1",
    source_ref: sourceRef,
    ...overrides,
  };
}

const candidate: RiskCustomsCandidate = {
  hs_code: "1234.56.78",
  classification_status: "candidate",
  confidence: "0.72",
  reason_summary: "Synthetic candidate only; broker confirmation is required.",
  source_ref_ids: [sourceRef.source_id],
};

function searchRecord(): RiskCustomsSearchRecord {
  return {
    query_id: "query-demo-customs-001",
    query_kind: "name_search",
    candidates: [candidate],
    next_questions: ["Confirm material and use."],
    source_refs: [sourceRef],
  };
}

function estimateRecord(): RiskCustomsEstimateRecord {
  return {
    assessment_id: "assessment-demo-customs-001",
    rates: [
      {
        rate_id: "rate:fixture:duty",
        label: "Synthetic duty",
        rate_expression_raw: "7.5%",
        amount: null,
        confirmed: false,
        source_ref_ids: [sourceRef.source_id],
      },
    ],
    valuation: { amount: "200.00", currency: "CAD" },
    total_estimated_import_tax: null,
    source_refs: [sourceRef],
  };
}

function sourceFor(
  status: RiskCustomsStatusRecord,
): {
  source: RiskCustomsUpstreamSource;
  getStatus: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  estimate: ReturnType<typeof vi.fn>;
} {
  const getStatus = vi.fn(() => Promise.resolve(status));
  const search = vi.fn(() => Promise.resolve(searchRecord()));
  const estimate = vi.fn(() => Promise.resolve(estimateRecord()));
  return {
    source: { getStatus, search, estimate },
    getStatus,
    search,
    estimate,
  };
}

const searchInput = {
  schema_version: "2026-08-11.v1",
  version: "customs-request@fixture-1",
  rule_date: "2026-08-11",
  query_kind: "name_search",
  query_code: null,
  product_description_ref: {
    ref_id: "opaque-product-demo-001",
    kind: "raw_input",
    purpose: "synthetic fixture",
    expires_at: null,
  },
  product_attributes: {
    material: "synthetic",
    use: "fixture",
    origin_country: "CN",
    contains_steel_aluminum: false,
  },
  selected_hs6: null,
};

const estimateInput = {
  schema_version: "2026-08-11.v1",
  version: "customs-estimate@fixture-1",
  rule_date: "2026-08-11",
  classification: {
    hs_code: "1234.56.78",
    status: "candidate",
    source_ref_ids: [sourceRef.source_id],
  },
  origin_country: "CN",
  value_for_duty: { amount: "200.00", currency: "CAD" },
  import_date: "2026-08-11",
  trade_treatment: null,
};

describe("RiskCustoms adapter", () => {
  it("keeps the production customs boundary disabled without an injected source", async () => {
    const result = await new RiskCustomsAdapter().search(searchInput);

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map((item) => item.code)).toContain("customs.adapter_disabled");
  });

  it("calls status first and maps ready=false to unavailable without querying", async () => {
    const { source, getStatus, search, estimate } = sourceFor(
      readyStatus({
        ready: false,
        last_source_check_at: null,
        reasons: ["published_snapshot_not_ready"],
        release_ids: [],
        snapshot_hash: null,
        release_hash: null,
      }),
    );
    const adapter = new RiskCustomsAdapter({ source });

    const result = await adapter.search(searchInput);

    expect(result.status).toBe("unavailable");
    expect(result.data).toMatchObject({ data_status: { ready: false } });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    expect(estimate).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("aiCandidate");
  });

  it("maps a ready release to a candidate-only search result", async () => {
    const { source, getStatus, search } = sourceFor(readyStatus());
    const adapter = new RiskCustomsAdapter({ source });

    const result = await adapter.search(searchInput);

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      jurisdiction: "CA",
      query_kind: "name_search",
      candidates: [{ classification_status: "candidate" }],
      data_status: { ready: true, release_ids: ["ca-release-demo-1"] },
    });
    expect(getStatus.mock.invocationCallOrder[0]).toBeLessThan(
      search.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(result.sourceRefs).toContainEqual(sourceRef);
  });

  it("fails closed on a snapshot/release hash mismatch", async () => {
    const { source, search } = sourceFor(
      readyStatus({ release_hash: "sha256:different-release" }),
    );
    const adapter = new RiskCustomsAdapter({ source });

    const result = await adapter.search(searchInput);

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({ data_status: { ready: true } });
    expect(result.blockers?.map((item) => item.code)).toContain(
      "customs.release_hash_mismatch",
    );
    expect(search).not.toHaveBeenCalled();
  });

  it("gates estimates when the published release is not ready", async () => {
    const { source, getStatus, estimate } = sourceFor(
      readyStatus({
        ready: false,
        last_source_check_at: null,
        reasons: ["published_snapshot_not_ready"],
        release_ids: [],
        snapshot_hash: null,
        release_hash: null,
      }),
    );
    const adapter = new RiskCustomsAdapter({ source });

    const result = await adapter.estimate(estimateInput);

    expect(result.status).toBe("unavailable");
    expect(result.data).toMatchObject({
      assessment_status: "unavailable",
      data_status: "not_ready",
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(estimate).not.toHaveBeenCalled();
  });

  it("maps estimate rates without turning a candidate into confirmed classification", async () => {
    const { source, estimate } = sourceFor(readyStatus());
    const adapter = new RiskCustomsAdapter({ source });

    const result = await adapter.estimate(estimateInput);

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({
      assessment_status: "manual_review",
      hs_candidates: [{ classification_status: "candidate" }],
      rates: [{ rate_expression_raw: "7.5%", confirmed: false }],
      requires_broker_confirmation: true,
      total_estimated_import_tax: null,
    });
    expect(estimate).toHaveBeenCalledTimes(1);
  });

  it("does not treat test data as production-ready", async () => {
    const { source, search } = sourceFor(readyStatus({ test_data: true }));
    const adapter = new RiskCustomsAdapter({ source });

    const result = await adapter.search(searchInput);

    expect(result.status).toBe("unavailable");
    expect(result.data).toMatchObject({ data_status: { test_data: true } });
    expect(search).not.toHaveBeenCalled();
  });
});
