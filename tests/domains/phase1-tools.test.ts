import { describe, expect, it } from "vitest";

import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import {
  createPhase1Bundle,
  phase1ToolContracts,
  phase1ToolHandlers,
  phase1ToolNames,
} from "../../src/logistics_mcp/adapters/phase1-bundle";
import {
  registerPhaseOneTools,
  executeRegisteredToolWithResult,
} from "../../src/logistics_mcp/server/tool-registry";
import { MemoryIdempotencyRepository } from "../../src/logistics_mcp/platform/idempotency";
import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";

const schemaVersion = "2026-08-11.v1";

const context: ExecutionContext = {
  tenantId: "tenant_demo",
  actorId: "actor_sales",
  role: "sales",
  roles: ["sales"],
  scopes: [
    "knowledge:read",
    "system:read",
    "quote:calculate",
    "tariff:read",
    "tariff:estimate",
    "quote:draft_write",
    "review:create_task",
  ],
  clientId: "client_demo",
  sessionId: "session_demo",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function quoteInput() {
  return {
    schema_version: schemaVersion,
    version: "quote-request@fixture-1",
    origin: { warehouse_code: "fixture-warehouse", province: "ON" },
    destination: {
      country: "CA",
      province: "ON",
      city: "Fixture City",
      postal_code: "A0A 0A0",
      address_type: "commercial",
      full_address_ref: null,
    },
    cargo: {
      cargo_result_ref: null,
      billing_pallets: 2,
      weight_kg: { value: "100", unit: "kg" },
      pieces: 2,
      package_types: ["pallet"],
    },
    services: {
      appointment: true,
      liftgate: false,
      limited_access: false,
      remote_area: false,
    },
    effective_at: "2026-08-11",
  };
}

function searchInput() {
  return {
    schema_version: schemaVersion,
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
}

function estimateInput() {
  return {
    schema_version: schemaVersion,
    version: "customs-estimate@fixture-1",
    rule_date: "2026-08-11",
    classification: {
      hs_code: "1234.56.78",
      status: "confirmed",
      source_ref_ids: ["src:customs:release:fixture"],
    },
    origin_country: "CN",
    value_for_duty: { amount: "200.00", currency: "CAD" },
    import_date: "2026-08-11",
    trade_treatment: null,
  };
}

function writeContext(
  operationMode: "preview" | "commit",
  previewRef: string | null,
  key: string,
  approval: Record<string, unknown> = {
    required: false,
    status: "not_required",
    approval_id: null,
  },
) {
  return {
    tenant_context: {
      tenant_id: "tenant_demo",
      actor_id: "actor_sales",
      actor_role: "sales",
      client_id: "client_demo",
      session_id: "session_demo",
    },
    idempotency_key: key,
    operation_mode: operationMode,
    preview_ref: previewRef,
    approval,
  };
}

function tool(name: string, handlers = phase1ToolHandlers, contracts = phase1ToolContracts) {
  const definition = registerPhaseOneTools(handlers, contracts).find(
    (candidate) => candidate.name === name,
  );
  if (definition === undefined) throw new Error(`missing tool ${name}`);
  return definition;
}

describe("Task 05 Phase 1 bundle", () => {
  it("contains exactly the eight assigned tools and binds every handler and contract", () => {
    const expected = [
      "knowledge.search_curated",
      "system.get_data_status",
      "quote.canada_final_mile.calculate",
      "customs.ca.search",
      "customs.ca.estimate",
      "quote.save_draft",
      "review.create_task",
      "quote.create_pdf",
    ].sort();
    expect([...phase1ToolNames].sort()).toEqual(expected);
    expect(Object.keys(phase1ToolHandlers).sort()).toEqual(expected);
    expect(Object.keys(phase1ToolContracts).sort()).toEqual(expected);
    const definitions = registerPhaseOneTools(phase1ToolHandlers, phase1ToolContracts);
    for (const name of expected) {
      const definition = definitions.find((candidate) => candidate.name === name);
      expect(definition?.handler).toBeTypeOf("function");
      expect(definition?.inputSchema).toBeDefined();
      expect(definition?.validateOutput).toBeTypeOf("function");
    }
    expect(definitions.find((candidate) => candidate.name === "cargo.calculate")?.handler).toBeUndefined();
    expect(definitions.find((candidate) => candidate.name === "container.plan_summary")?.handler).toBeUndefined();
  });

  it("rejects extra input fields and extra output fields with strict validators", () => {
    const bundle = createPhase1Bundle(createFixtureAdapters());
    const quoteContract = bundle.contracts["quote.canada_final_mile.calculate"];
    const knowledgeContract = bundle.contracts["knowledge.search_curated"];
    expect(quoteContract?.inputSchema.safeParse({ ...quoteInput(), extra: true }).success).toBe(false);
    expect(knowledgeContract?.inputSchema.safeParse({
      schema_version: schemaVersion,
      query: "fixture",
      scope: "all",
      include_archived: false,
      extra: true,
    }).success).toBe(false);
    expect(() => quoteContract?.validateOutput({
      version: "quote-result@fixture-1",
      quote_id: "quote-demo-001",
      quote_status: "calculated",
      currency: "USD",
      total: null,
      line_items: [],
      rule_version: "zone-rule-fixture@1",
      data_version: "zone-price-fixture@1",
      sendable: false,
      source_ref_ids: ["src:quote:fixture:1"],
      extra: true,
    })).toThrow();
  });

  it("accepts optional quote volume and trims customs query at its boundaries", () => {
    const bundle = createPhase1Bundle(createFixtureAdapters());
    const quoteContract = bundle.contracts["quote.canada_final_mile.calculate"];
    const customsContract = bundle.contracts["customs.ca.search"];

    expect(quoteContract?.inputSchema.safeParse(quoteInput()).success).toBe(true);
    expect(quoteContract?.inputSchema.safeParse({
      ...quoteInput(),
      cargo: { ...quoteInput().cargo, total_volume: { value: "1.25", unit: "cbm" } },
    }).success).toBe(true);
    expect(quoteContract?.inputSchema.safeParse({
      ...quoteInput(),
      cargo: { ...quoteInput().cargo, total_volume: { value: "1.25", unit: "m3" } },
    }).success).toBe(true);
    expect(quoteContract?.inputSchema.safeParse({
      ...quoteInput(),
      cargo: { ...quoteInput().cargo, total_volume: null },
    }).success).toBe(true);
    expect(quoteContract?.inputSchema.safeParse({
      ...quoteInput(),
      cargo: { ...quoteInput().cargo, total_volume: { value: "1.25", unit: "l" } },
    }).success).toBe(false);

    expect(customsContract?.inputSchema.safeParse(searchInput()).success).toBe(true);
    const parsedQuery = customsContract?.inputSchema.safeParse({
      ...searchInput(),
      query: `  ${"x".repeat(200)}  `,
    });
    expect(parsedQuery.success).toBe(true);
    expect((parsedQuery.data as { query?: string }).query).toBe("x".repeat(200));
    expect(customsContract?.inputSchema.safeParse({ ...searchInput(), query: " \t" }).success).toBe(false);
    expect(customsContract?.inputSchema.safeParse({ ...searchInput(), query: "x".repeat(201) }).success).toBe(false);
  });

  it("executes quote and customs read tools with versioned sources", async () => {
    const bundle = createPhase1Bundle(createFixtureAdapters());
    const quote = await executeRegisteredToolWithResult(
      tool("quote.canada_final_mile.calculate", bundle.handlers, bundle.contracts),
      quoteInput(),
      context,
      { requestId: "req:quote:fixture", auditId: "audit:quote:fixture" },
    );
    expect(quote.envelope.status).toBe("success");
    expect(quote.envelope.source_refs[0]?.version).toBe("quote-fixture@1");
    expect(quote.envelope.data).toMatchObject({ sendable: false });

    const customs = await executeRegisteredToolWithResult(
      tool("customs.ca.search", bundle.handlers, bundle.contracts),
      searchInput(),
      context,
      { requestId: "req:customs:fixture", auditId: "audit:customs:fixture" },
    );
    expect(customs.envelope.status).toBe("success");
    expect(customs.envelope.data).toMatchObject({
      data_status: { ready: true },
      candidates: [{ classification_status: "candidate" }],
    });
  });

  it("executes knowledge, status, and estimate with source/version evidence", async () => {
    const bundle = createPhase1Bundle(createFixtureAdapters());
    const knowledge = await executeRegisteredToolWithResult(
      tool("knowledge.search_curated", bundle.handlers, bundle.contracts),
      {
        schema_version: schemaVersion,
        query: "fixture",
        scope: "quote",
        include_archived: false,
      },
      context,
      { requestId: "req:knowledge:fixture", auditId: "audit:knowledge:fixture" },
    );
    expect(knowledge.envelope.status).toBe("success");
    expect(knowledge.envelope.source_refs.length).toBeGreaterThan(0);
    expect(knowledge.envelope.source_refs.every((ref) => ref.version.length > 0)).toBe(true);

    const status = await executeRegisteredToolWithResult(
      tool("system.get_data_status", bundle.handlers, bundle.contracts),
      { schema_version: schemaVersion, system: "customs" },
      context,
      { requestId: "req:status:fixture", auditId: "audit:status:fixture" },
    );
    expect(status.envelope.status).toBe("success");
    expect(status.envelope.data).toMatchObject({ ready: false, test_data: true });
    expect(status.envelope.source_refs[0]?.version).toBe("data-status@fixture-1");

    const estimate = await executeRegisteredToolWithResult(
      tool("customs.ca.estimate", bundle.handlers, bundle.contracts),
      estimateInput(),
      context,
      { requestId: "req:estimate:fixture", auditId: "audit:estimate:fixture" },
    );
    expect(estimate.envelope.status).toBe("success");
    expect(estimate.envelope.data).toMatchObject({
      assessment_status: "estimated",
      requires_broker_confirmation: true,
    });
    expect(estimate.envelope.source_refs.length).toBeGreaterThan(0);
  });

  it("keeps RiskCustoms not-ready unavailable and never upgrades it to success", async () => {
    const adapters = createFixtureAdapters({ customsFixture: "customs-not-ready" });
    const bundle = createPhase1Bundle(adapters);
    const result = await executeRegisteredToolWithResult(
      tool("customs.ca.search", bundle.handlers, bundle.contracts),
      searchInput(),
      context,
      { requestId: "req:customs:not-ready", auditId: "audit:customs:not-ready" },
    );
    expect(result.envelope.status).toBe("unavailable");
    expect(result.envelope.data).toMatchObject({ data_status: { ready: false } });
  });

  it("requires preview, approval metadata, and verified readback for writes", async () => {
    const bundle = createPhase1Bundle(createFixtureAdapters());
    const quoteResult = {
      version: "quote-result@fixture-1",
      quote_id: "quote-demo-001",
      quote_status: "calculated",
      currency: "USD",
      total: { amount: "143.80", currency: "USD" },
      line_items: [],
      rule_version: "zone-rule-fixture@1",
      data_version: "zone-price-fixture@1",
      sendable: false,
      valid_from: "2026-08-01T00:00:00Z",
      valid_to: "2026-08-31T23:59:59Z",
      source_ref_ids: ["src:quote:fixture:1"],
    };
    const repository = new MemoryIdempotencyRepository();
    const preview = await executeRegisteredToolWithResult(
      tool("quote.save_draft", bundle.handlers, bundle.contracts),
      {
        schema_version: schemaVersion,
        version: "quote-save@fixture-1",
        quote_result: quoteResult,
        target: { system: "existing_quote_system", record_kind: "draft" },
        write_context: writeContext("preview", null, "idem_demo_quote_12345678"),
      },
      context,
      {
        requestId: "req:quote:preview",
        auditId: "audit:quote:preview",
        idempotencyRepository: repository,
      },
    );
    expect(preview.envelope.status).toBe("success");
    const previewRef = String(preview.envelope.data && preview.envelope.data.preview_ref);
    expect(preview.envelope.data).toMatchObject({
      operation_status: "previewed",
      readback_evidence: null,
    });

    const committed = await executeRegisteredToolWithResult(
      tool("quote.save_draft", bundle.handlers, bundle.contracts),
      {
        schema_version: schemaVersion,
        version: "quote-save@fixture-1",
        quote_result: quoteResult,
        target: { system: "existing_quote_system", record_kind: "draft" },
        write_context: writeContext(
          "commit",
          previewRef,
          "idem_demo_quote_commit_1234",
          { required: true, status: "approved", approval_id: "approval_demo_quote_001" },
        ),
      },
      context,
      {
        requestId: "req:quote:commit",
        auditId: "audit:quote:commit",
        idempotencyRepository: repository,
      },
    );
    expect(committed.envelope.status).toBe("success");
    expect(committed.envelope.data).toMatchObject({
      operation_status: "committed",
      readback_evidence: { verified: true },
    });

    const task = await executeRegisteredToolWithResult(
      tool("review.create_task", bundle.handlers, bundle.contracts),
      {
        schema_version: schemaVersion,
        version: "review-task@fixture-1",
        task_type: "quote",
        priority: "normal",
        reason_codes: ["quote.zone_conflict"],
        opaque_context_refs: [
          {
            ref_id: "opaque-review-demo-001",
            kind: "raw_input",
            purpose: "synthetic fixture",
            expires_at: null,
          },
        ],
        write_context: writeContext("preview", null, "idem_demo_review_12345678"),
      },
      context,
      {
        requestId: "req:review:preview",
        auditId: "audit:review:preview",
        idempotencyRepository: new MemoryIdempotencyRepository(),
      },
    );
    expect(task.envelope.status).toBe("success");
    expect(task.envelope.data).toMatchObject({ operation_status: "previewed" });

    const taskPreviewRef = String(task.envelope.data && task.envelope.data.preview_ref);
    const committedTask = await executeRegisteredToolWithResult(
      tool("review.create_task", bundle.handlers, bundle.contracts),
      {
        schema_version: schemaVersion,
        version: "review-task@fixture-1",
        task_type: "quote",
        priority: "normal",
        reason_codes: ["quote.zone_conflict"],
        opaque_context_refs: [
          {
            ref_id: "opaque-review-demo-001",
            kind: "raw_input",
            purpose: "synthetic fixture",
            expires_at: null,
          },
        ],
        write_context: writeContext(
          "commit",
          taskPreviewRef,
          "idem_demo_review_commit_1234",
          { required: true, status: "approved", approval_id: "approval_demo_review_001" },
        ),
      },
      context,
      {
        requestId: "req:review:commit",
        auditId: "audit:review:commit",
        idempotencyRepository: new MemoryIdempotencyRepository(),
      },
    );
    expect(committedTask.envelope.status).toBe("success");
    expect(committedTask.envelope.data).toMatchObject({
      operation_status: "committed",
      readback_evidence: { verified: true },
    });
  });

  it("builds the assigned bundle without mutating the shared registry", () => {
    const bundle = createPhase1Bundle(createFixtureAdapters());
    expect(Object.keys(bundle.handlers)).toHaveLength(8);
    expect(Object.keys(bundle.contracts)).toHaveLength(8);
  });
});
