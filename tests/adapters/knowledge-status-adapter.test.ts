import { describe, expect, it } from "vitest";

import {
  CuratedKnowledgeAdapter,
  type CuratedKnowledgeRecord,
  type CuratedKnowledgeSource,
} from "../../src/logistics_mcp/adapters/knowledge/curated-adapter";
import {
  SystemStatusAdapter,
  type SystemStatusRecord,
  type SystemStatusSource,
} from "../../src/logistics_mcp/adapters/status/system-status-adapter";

const sourceRef = (locator: string, authority: "supporting" | "authoritative") => ({
  source_id: `src:knowledge:${locator.replace(/[^A-Za-z0-9]+/g, "-")}`,
  source_type: "fixture" as const,
  system: "curated-knowledge",
  locator: `fixture://curated-knowledge/${locator}`,
  version: "knowledge-fixture@1",
  retrieved_at: "2026-08-11T00:00:00Z",
  authority,
  content_hash: "sha256:knowledge-fixture-1",
});

const records: CuratedKnowledgeRecord[] = [
  {
    result_id: "knowledge-sop-demo",
    title: "SOP_QUICK.md",
    summary: "Synthetic input and manual review boundary.",
    status: "active",
    source_ref: sourceRef("SOP_QUICK.md", "supporting"),
  },
  {
    result_id: "knowledge-rules-demo",
    title: "RULES.yaml",
    summary: "Synthetic versioned rule explanation.",
    status: "active",
    source_ref: sourceRef("RULES.yaml", "authoritative"),
  },
  {
    result_id: "knowledge-template-demo",
    title: "QUOTE_TEMPLATE.md",
    summary: "Synthetic draft template context.",
    status: "active",
    source_ref: sourceRef("QUOTE_TEMPLATE.md", "supporting"),
  },
  {
    result_id: "knowledge-edge-demo",
    title: "EDGE_CASES.md",
    summary: "Synthetic exception handling context.",
    status: "active",
    source_ref: sourceRef("EDGE_CASES.md", "supporting"),
  },
  {
    result_id: "knowledge-archived-demo",
    title: "物流报价SOP.md",
    summary: "Archived synthetic long SOP.",
    status: "archived",
    source_ref: sourceRef("物流报价SOP.md", "supporting"),
  },
];

describe("curated knowledge adapter", () => {
  it("returns only allowlisted active documents and preserves authority refs", async () => {
    const source: CuratedKnowledgeSource = {
      search: () => Promise.resolve(records),
    };
    const adapter = new CuratedKnowledgeAdapter({ source });

    const result = await adapter.searchCurated({
      query: "fixture",
      scope: "quote",
      include_archived: false,
    });

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      curated_only: true,
      archived_excluded: true,
      results: [
        { title: "SOP_QUICK.md" },
        { title: "RULES.yaml" },
        { title: "QUOTE_TEMPLATE.md" },
        { title: "EDGE_CASES.md" },
      ],
    });
    expect(result.data && JSON.stringify(result.data)).not.toContain("物流报价SOP.md");
    expect(result.sourceRefs).toHaveLength(4);
    expect(result.sourceRefs.map((ref) => ref.authority)).toContain("authoritative");
  });

  it("fails closed when the curated index is missing", async () => {
    const source: CuratedKnowledgeSource = {
      search: () => Promise.resolve(null),
    };
    const adapter = new CuratedKnowledgeAdapter({ source });

    const result = await adapter.searchCurated({
      query: "fixture",
      scope: "all",
      include_archived: false,
    });

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(result.blockers?.map((item) => item.code)).toContain("knowledge.index_unavailable");
  });

  it("blocks archived-inclusive requests and unversioned empty indexes", async () => {
    const source: CuratedKnowledgeSource = {
      search: () => Promise.resolve([]),
    };
    const adapter = new CuratedKnowledgeAdapter({ source });

    const archivedRequest = await adapter.searchCurated({
      query: "fixture",
      scope: "all",
      include_archived: true,
    });
    expect(archivedRequest.status).toBe("blocked");
    expect(archivedRequest.blockers?.map((item) => item.code)).toContain(
      "knowledge.archived_forbidden",
    );

    const emptyIndex = await adapter.searchCurated({
      query: "fixture",
      scope: "all",
      include_archived: false,
    });
    expect(emptyIndex.status).toBe("unavailable");
    expect(emptyIndex.blockers?.map((item) => item.code)).toContain(
      "knowledge.version_missing",
    );
  });

  it("does not use an unconfigured production source", async () => {
    const adapter = new CuratedKnowledgeAdapter();

    const result = await adapter.searchCurated({
      query: "fixture",
      scope: "all",
      include_archived: false,
    });

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map((item) => item.code)).toContain("knowledge.adapter_disabled");
  });
});

describe("system data status adapter", () => {
  it("keeps the production status boundary disabled without an injected source", async () => {
    const result = await new SystemStatusAdapter().getDataStatus({ system: "customs" });

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map((item) => item.code)).toContain("status.adapter_disabled");
  });

  it("preserves ready=false, reasons, and release identifiers", async () => {
    const source: SystemStatusSource = {
      getStatus: (): Promise<SystemStatusRecord> => Promise.resolve({
        version: "data-status@fixture-1",
        system: "riskcustoms",
        ready: false,
        test_data: false,
        evaluated_at: "2026-08-11T00:00:00Z",
        last_source_check_at: null,
        reasons: ["published_snapshot_not_ready", "release_gate_missing"],
        release_ids: ["ca-release-demo-1"],
        source_ref: {
          source_id: "src:status:customs:fixture",
          source_type: "fixture" as const,
          system: "RiskCustoms",
          locator: "fixture://riskcustoms/status",
          version: "data-status@fixture-1",
          retrieved_at: "2026-08-11T00:00:00Z",
          authority: "authoritative",
          content_hash: "sha256:status-fixture-1",
        },
      }),
    };
    const adapter = new SystemStatusAdapter({ source });

    const result = await adapter.getDataStatus({ system: "customs", rule_date: null });

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      system: "riskcustoms",
      ready: false,
      reasons: ["published_snapshot_not_ready", "release_gate_missing"],
      release_ids: ["ca-release-demo-1"],
    });
    expect(result.sourceRefs[0]?.version).toBe("data-status@fixture-1");
  });
});
