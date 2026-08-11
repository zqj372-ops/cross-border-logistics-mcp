import type { SourceRef } from "../platform/envelope";
import type { FixtureAdapters } from "./ports";
import {
  ExistingQuoteAdapter,
  type QuoteDraftReadbackRecord,
  type QuoteDraftWriteRecord,
  type QuoteLookupRecord,
  type QuoteUpstreamSource,
} from "./quote/existing-quote-adapter";
import {
  RiskCustomsAdapter,
  type RiskCustomsEstimateRecord,
  type RiskCustomsSearchRecord,
  type RiskCustomsStatusRecord,
  type RiskCustomsUpstreamSource,
} from "./customs/riskcustoms-adapter";
import {
  CuratedKnowledgeAdapter,
  type CuratedKnowledgeRecord,
  type CuratedKnowledgeSource,
} from "./knowledge/curated-adapter";
import {
  SystemStatusAdapter,
  type SystemStatusRecord,
  type SystemStatusSource,
} from "./status/system-status-adapter";
import {
  ManualTaskAdapter,
  type ManualTaskReadbackRecord,
  type ManualTaskSource,
} from "./review/manual-task-adapter";

const NOW = "2026-08-11T00:00:00Z";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceRef(
  sourceId: string,
  system: string,
  locator: string,
  version: string,
  authority: SourceRef["authority"] = "authoritative",
): SourceRef {
  return {
    source_id: sourceId,
    source_type: "fixture",
    system,
    locator,
    version,
    retrieved_at: NOW,
    authority,
    content_hash: `sha256:${sourceId.replace(/[^A-Za-z0-9]/g, "-")}`,
  };
}

function quoteLookupRecord(status: QuoteLookupRecord["status"] = "matched"): QuoteLookupRecord {
  return {
    status,
    quote_id: "quote-demo-001",
    currency: "USD",
    zone: status === "matched" ? 2 : null,
    base_price: status === "matched" ? { amount: "123.45", currency: "USD" } : null,
    fuel_percent: status === "matched" ? "10" : null,
    accessorials: {
      residential_fee: { amount: "25.00", currency: "USD" },
      appointment_fee: { amount: "8.00", currency: "USD" },
      liftgate_fee: { amount: "15.00", currency: "USD" },
      limited_access_fee: { amount: "20.00", currency: "USD" },
      remote_area_fee: { amount: "30.00", currency: "USD" },
    },
    rule_version: "zone-rule-fixture@1",
    data_version: "zone-price-fixture@1",
    valid_from: "2026-08-01",
    valid_to: "2026-08-31",
    matched_by: "postal_fsa_exact",
    source_ref: sourceRef(
      "src:quote:fixture:1",
      "existing-quote-system",
      "fixture://existing-quote/quote-demo-001",
      "quote-fixture@1",
    ),
  };
}

function quoteSource(): QuoteUpstreamSource {
  const drafts = new Map<string, QuoteDraftReadbackRecord>();
  return {
    async lookup(input) {
      await Promise.resolve();
      const fixture = input.fixture;
      if (fixture === "quote-zone-missing") return quoteLookupRecord("zone_missing");
      if (fixture === "quote-zone-conflict") return quoteLookupRecord("zone_conflict");
      if (fixture === "quote-price-missing") return quoteLookupRecord("price_missing");
      return quoteLookupRecord();
    },
    async saveDraft(input): Promise<QuoteDraftWriteRecord> {
      await Promise.resolve();
      const tenantId = typeof input.tenant_id === "string" ? input.tenant_id : "tenant_demo";
      const quoteResult = isRecord(input.quote_result) ? input.quote_result : {};
      const quoteId =
        typeof quoteResult.quote_id === "string" ? quoteResult.quote_id : "quote-demo-001";
      const recordId = "sales-quote-demo-001";
      const revision = "sales-quote-record@1";
      const writeRef = sourceRef(
        "src:quote:write:fixture",
        "existing-quote-system",
        "fixture://existing-quote/sales-quote-demo-001",
        "quote-draft-write@1",
      );
      const readbackRef = sourceRef(
        "src:quote:readback:fixture",
        "existing-quote-system",
        "fixture://existing-quote/sales-quote-demo-001",
        revision,
      );
      drafts.set(`${tenantId}\u0000${recordId}`, {
        record_id: recordId,
        tenant_id: tenantId,
        quote_id: quoteId,
        revision,
        status: "draft",
        source_ref: readbackRef,
      });
      return {
        record_id: recordId,
        tenant_id: tenantId,
        quote_id: quoteId,
        revision,
        source_ref: writeRef,
      };
    },
    async readDraft(recordId, tenantId) {
      await Promise.resolve();
      return drafts.get(`${tenantId}\u0000${recordId}`) ?? null;
    },
  };
}

function customsStatus(ready: boolean): RiskCustomsStatusRecord {
  const releaseHash = "sha256:customs-snapshot-1";
  return {
    version: "data-status@fixture-1",
    system: "riskcustoms",
    ready,
    test_data: false,
    evaluated_at: NOW,
    last_source_check_at: ready ? NOW : null,
    reasons: ready ? [] : ["published_snapshot_not_ready"],
    release_ids: ready ? ["ca-release-demo-1"] : [],
    snapshot_hash: ready ? releaseHash : null,
    release_hash: ready ? releaseHash : null,
    source_ref: sourceRef(
      "src:customs:status:fixture",
      "RiskCustoms",
      ready
        ? "fixture://riskcustoms/ca-release-demo-1/status"
        : "fixture://riskcustoms/not-ready/status",
      "data-status@fixture-1",
    ),
  };
}

function customsSource(defaultFixture: "customs-ready" | "customs-not-ready"): RiskCustomsUpstreamSource {
  const releaseRef = sourceRef(
    "src:customs:release:fixture",
    "RiskCustoms",
    "fixture://riskcustoms/ca-release-demo-1",
    "ca-release-demo-1",
  );
  return {
    async getStatus(input) {
      await Promise.resolve();
      const fixture = input.fixture === "customs-not-ready" || input.fixture === "customs-ready"
        ? input.fixture
        : defaultFixture;
      return customsStatus(fixture === "customs-ready");
    },
    async search(input): Promise<RiskCustomsSearchRecord> {
      await Promise.resolve();
      const queryKind =
        input.query_kind === "exact_code" ||
        input.query_kind === "candidate_selection" ||
        input.query_kind === "name_search"
          ? input.query_kind
          : "name_search";
      return {
        query_id: "query-demo-customs-001",
        query_kind: queryKind,
        candidates: [
          {
            hs_code: "1234.56.78",
            classification_status: "candidate",
            confidence: "0.72",
            reason_summary: "Synthetic fixture candidate; broker confirmation is required.",
            source_ref_ids: [releaseRef.source_id],
          },
        ],
        next_questions: ["Confirm material and use."],
        source_refs: [releaseRef],
      };
    },
    async estimate(input): Promise<RiskCustomsEstimateRecord> {
      await Promise.resolve();
      const classification = isRecord(input.classification) ? input.classification : {};
      const confirmed = classification.status === "confirmed";
      return {
        assessment_id: "assessment-demo-customs-001",
        rates: [
          {
            rate_id: "rate:fixture:duty",
            label: "Synthetic duty",
            rate_expression_raw: "7.5%",
            amount: null,
            confirmed,
            source_ref_ids: [releaseRef.source_id],
          },
        ],
        valuation: { amount: "200.00", currency: "CAD" },
        total_estimated_import_tax: null,
        source_refs: [releaseRef],
      };
    },
  };
}

function knowledgeSource(): CuratedKnowledgeSource {
  const makeRef = (title: string, authority: SourceRef["authority"]) =>
    sourceRef(
      `src:knowledge:${title.replace(/[^A-Za-z0-9]/g, "-")}`,
      "curated-knowledge",
      `fixture://curated-knowledge/${title}`,
      "knowledge-fixture@1",
      authority,
    );
  const records: readonly CuratedKnowledgeRecord[] = [
    {
      result_id: "knowledge-sop-demo",
      title: "SOP_QUICK.md",
      summary: "Synthetic input and manual review boundary.",
      status: "active",
      source_ref: makeRef("SOP_QUICK.md", "supporting"),
    },
    {
      result_id: "knowledge-rules-demo",
      title: "RULES.yaml",
      summary: "Synthetic versioned rule explanation.",
      status: "active",
      source_ref: makeRef("RULES.yaml", "authoritative"),
    },
    {
      result_id: "knowledge-template-demo",
      title: "QUOTE_TEMPLATE.md",
      summary: "Synthetic draft template context.",
      status: "active",
      source_ref: makeRef("QUOTE_TEMPLATE.md", "supporting"),
    },
    {
      result_id: "knowledge-edge-demo",
      title: "EDGE_CASES.md",
      summary: "Synthetic exception handling context.",
      status: "active",
      source_ref: makeRef("EDGE_CASES.md", "supporting"),
    },
    {
      result_id: "knowledge-archived-demo",
      title: "ARCHIVED_FIXTURE.md",
      summary: "Archived synthetic document excluded from search.",
      status: "archived",
      source_ref: makeRef("ARCHIVED_FIXTURE.md", "supporting"),
    },
  ];
  return { search: () => Promise.resolve(records) };
}

function statusSource(): SystemStatusSource {
  return {
    async getStatus(input): Promise<SystemStatusRecord> {
      await Promise.resolve();
      const system = typeof input.system === "string" ? input.system : "all";
      return {
        version: "data-status@fixture-1",
        system,
        ready: false,
        test_data: true,
        evaluated_at: NOW,
        last_source_check_at: NOW,
        reasons: ["fixture_source_only"],
        release_ids: [],
        source_ref: sourceRef(
          "src:status:fixture",
          "system-status-fixture",
          `fixture://system-status/${system}`,
          "data-status@fixture-1",
        ),
      };
    },
  };
}

function reviewSource(): ManualTaskSource {
  const tasks = new Map<string, ManualTaskReadbackRecord>();
  return {
    async createTask(input): Promise<ManualTaskReadbackRecord> {
      await Promise.resolve();
      const tenantId = typeof input.tenant_id === "string" ? input.tenant_id : "tenant_demo";
      const taskId = "review-task-demo-001";
      const version = "manual-review-task@1";
      const createRef = sourceRef(
        "src:review:create:fixture",
        "existing-quote-system",
        "fixture://existing-quote/review-task-demo-001",
        "review-task-create@1",
      );
      const readbackRef = sourceRef(
        "src:review:readback:fixture",
        "existing-quote-system",
        "fixture://existing-quote/review-task-demo-001",
        version,
      );
      const record: ManualTaskReadbackRecord = {
        task_id: taskId,
        tenant_id: tenantId,
        version,
        status: "pending",
        source_ref: readbackRef,
      };
      tasks.set(`${tenantId}\u0000${taskId}`, record);
      return { ...record, source_ref: createRef };
    },
    async readTask(taskId, tenantId) {
      await Promise.resolve();
      return tasks.get(`${tenantId}\u0000${taskId}`) ?? null;
    },
  };
}

export interface FixtureAdapterOptions {
  readonly customsFixture?: "customs-ready" | "customs-not-ready";
}

export function createFixtureAdapters(options: FixtureAdapterOptions = {}): FixtureAdapters {
  return {
    quote: new ExistingQuoteAdapter({ source: quoteSource() }),
    customs: new RiskCustomsAdapter({
      source: customsSource(options.customsFixture ?? "customs-ready"),
    }),
    knowledge: new CuratedKnowledgeAdapter({ source: knowledgeSource() }),
    status: new SystemStatusAdapter({ source: statusSource() }),
    review: new ManualTaskAdapter({ source: reviewSource() }),
  };
}
