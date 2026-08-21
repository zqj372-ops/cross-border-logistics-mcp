import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";

import { createFixtureComposition } from "../../src/logistics_mcp/server/composition";
import {
  callTool,
  cargoInput,
  containerInput,
  createFixtureHarness,
  initialize,
  legacyQuoteDraftResult,
  quoteInput,
  quotePdfInput,
  createQuotePdfFixturePorts,
  writeContext,
} from "./fixtures/tenant-fixtures";

const schemaVersion = "2026-08-11.v1";

describe("Phase 1 integrated fixture gateway", () => {
  it("exposes exactly the ten public tools and no generic write tool", async () => {
    const harness = createFixtureHarness();
    try {
      const sessionId = await initialize(harness);
      const response = await harness.request(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        sessionId,
      );
      const body = (await response.json()) as {
        result?: {
          tools?: Array<{
            name: string;
            title?: string;
            description?: string;
            inputSchema?: { $schema?: string };
            outputSchema?: {
              $schema?: string;
              required?: string[];
              type?: string;
              additionalProperties?: boolean;
            };
            annotations?: {
              readOnlyHint?: boolean;
              destructiveHint?: boolean;
              idempotentHint?: boolean;
              openWorldHint?: boolean;
            };
          }>;
        };
      };
      expect(body.result?.tools?.map((tool) => tool.name).sort()).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "customs.ca.search",
        "customs.ca.estimate",
        "knowledge.search_curated",
        "quote.canada_final_mile.calculate",
        "quote.create_pdf",
        "quote.save_draft",
        "review.create_task",
        "system.get_data_status",
      ].sort());
      expect(body.result?.tools?.some((tool) => /commit|send|publish|booking/i.test(tool.name))).toBe(false);
      const tools = Object.fromEntries(
        (body.result?.tools ?? []).map((tool) => [tool.name, tool]),
      );
      expect(tools["cargo.calculate"]).toMatchObject({
        title: "货物与分泡计算",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
      expect(tools["customs.ca.search"]?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tools["quote.save_draft"]?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tools["quote.create_pdf"]).toMatchObject({
        title: "创建报价 PDF",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      });
      expect(tools["quote.create_pdf"]?.description).toContain("不可发送");
      expect(tools["quote.create_pdf"]?.outputSchema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
      expect(body.result?.tools?.every((tool) =>
        tool.title !== undefined &&
        tool.description !== undefined &&
        !tool.description.includes("Phase 1") &&
        tool.inputSchema?.$schema === "https://json-schema.org/draft/2020-12/schema" &&
        tool.outputSchema?.$schema === "https://json-schema.org/draft/2020-12/schema" &&
        tool.outputSchema.required?.includes("status") === true
      )).toBe(true);
      const unavailablePdf = await callTool(
        harness,
        sessionId,
        "quote.create_pdf",
        quotePdfInput("preview", "idem_fixture_pdf_unavailable_001"),
      );
      expect(unavailablePdf).toMatchObject({ status: "unavailable", data: null });
    } finally {
      await harness.close();
    }
  });

  it("runs an explicitly injected fixture PDF through the real MCP SDK", async () => {
    const ports = createQuotePdfFixturePorts();
    const composition = createFixtureComposition({
      dataMode: "fixtures",
      quote: ports.quote,
      quotePdf: ports.quotePdf,
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => ({
        tenant_id: "tenant_demo_a",
        actor_id: "sales_demo",
        actor_role: "sales",
        roles: ["sales"],
        scopes: ["quote:pdf_write"],
        client_id: "client_demo",
        session_id: "session_demo_a",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      }),
    });
    const fetchToComposition = async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", "https://client.example.invalid");
      headers.set("host", "mcp.example.invalid");
      return composition.handler(new Request(input, { ...init, headers }));
    };
    const client = new Client({ name: "quote-pdf-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://mcp.example.invalid/mcp"),
      {
        fetch: fetchToComposition,
        requestInit: { headers: { authorization: "Bearer fixture-pdf-token" } },
      },
    );
    try {
      await client.connect(transport as Transport);
      const preview = await client.callTool({
        name: "quote.create_pdf",
        arguments: quotePdfInput("preview", "pdf_e2e_preview_P"),
      });
      expect(preview.structuredContent).toMatchObject({
        status: "success",
        data: { operation_status: "previewed", readback_evidence: null },
      });
      const previewRef = (preview.structuredContent as { data: { preview_ref: string } }).data.preview_ref;
      const committed = await client.callTool({
        name: "quote.create_pdf",
        arguments: quotePdfInput("commit", "pdf_e2e_commit_C", previewRef),
      });
      expect(committed.structuredContent).toMatchObject({
        status: "success",
        data: {
          operation_status: "committed",
          readback_evidence: { verified: true },
        },
      });
      expect(ports.quoteCalls).toHaveLength(2);
      expect(ports.postCalls).toHaveLength(1);
      expect(ports.postCalls[0]?.key).toBe("pdf_e2e_commit_C");
      expect(ports.getCalls).toHaveLength(1);
      expect(ports.quoteCalls.every(({ context }) =>
        (context as { tenantId?: string }).tenantId === "tenant_demo_a"
      )).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await composition.close();
    }
  });

  it("runs cargo success and preserves needs_input without inventing weight", async () => {
    const harness = createFixtureHarness();
    try {
      const sessionId = await initialize(harness);
      const success = await callTool(harness, sessionId, "cargo.calculate", cargoInput());
      expect(success.status).toBe("success");
      expect((success.data as { metrics: { actual_weight: { unit: string } } }).metrics.actual_weight.unit).toBe("kg");

      const missingWeight = cargoInput({
        cargo_lines: [
          {
            ...(cargoInput().cargo_lines as Array<Record<string, unknown>>)[0],
            unit_weight: undefined,
          },
        ],
      });
      const needsInput = await callTool(harness, sessionId, "cargo.calculate", missingWeight);
      expect(needsInput.status).toBe("needs_input");
      expect(needsInput.data).toBeNull();
      expect(JSON.stringify(needsInput)).not.toMatch(/actual_weight|volumetric_weight|chargeable_weight/);
    } finally {
      await harness.close();
    }
  });

  it("keeps RiskCustoms ready=false unavailable and does not call a fallback", async () => {
    const harness = createFixtureHarness({ customsFixture: "customs-not-ready" });
    try {
      const sessionId = await initialize(harness);
      const result = await callTool(harness, sessionId, "customs.ca.search", {
        schema_version: schemaVersion,
        version: "customs-request@fixture-1",
        rule_date: "2026-08-11",
        query_kind: "name_search",
        query_code: null,
        product_description_ref: null,
        product_attributes: {
          material: "synthetic",
          use: "fixture",
          origin_country: "CN",
          contains_steel_aluminum: false,
        },
        selected_hs6: null,
      });
      expect(result.status).toBe("unavailable");
      expect((result.data as { data_status: { ready: boolean } }).data_status.ready).toBe(false);
      expect((result.data as { data_status: { release_ids: string[] } }).data_status.release_ids).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("keeps quote fail-closed and container theory-only boundaries explicit", async () => {
    const harness = createFixtureHarness();
    try {
      const sessionId = await initialize(harness);
      const unavailableQuote = await callTool(
        harness,
        sessionId,
        "quote.canada_final_mile.calculate",
        quoteInput(),
      );
      expect(unavailableQuote.status).toBe("unavailable");
      expect(unavailableQuote.data).toBeNull();
      expect(unavailableQuote.source_refs).toEqual([]);
      expect(unavailableQuote.calculation_trace).toEqual([]);
      expect(unavailableQuote.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "quote.adapter_disabled" }),
        ]),
      );

      for (const field of ["limited_access", "remote_area"] as const) {
        const services = quoteInput().services as Record<string, unknown>;
        const manualReview = await callTool(
          harness,
          sessionId,
          "quote.canada_final_mile.calculate",
          quoteInput({ services: { ...services, [field]: true } }),
        );
        expect(manualReview.status).toBe("manual_review");
        expect(manualReview.data).toBeNull();
        expect(manualReview.source_refs).toEqual([]);
        expect(manualReview.calculation_trace).toEqual([]);
        expect(manualReview.review_status).toBe("manual_review");
        expect(manualReview.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "quote.zero_upstream_call",
              field: `services.${field}`,
            }),
          ]),
        );
        expect(manualReview.blockers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "quote.manual_review_required",
              field: `services.${field}`,
            }),
          ]),
        );
      }

      const theoretical = await callTool(
        harness,
        sessionId,
        "container.plan_summary",
        containerInput(),
      );
      expect(theoretical.status).toBe("success");
      expect((theoretical.data as { theoretical_only: boolean }).theoretical_only).toBe(true);

      const manualReview = await callTool(
        harness,
        sessionId,
        "container.plan_summary",
        containerInput({
          cargo_metrics: {
            ...(containerInput().cargo_metrics as Record<string, unknown>),
            total_volume: { value: "80", unit: "cbm" },
          },
        }),
      );
      expect(manualReview.status).toBe("manual_review");
      expect((manualReview.data as { theoretical_only: boolean }).theoretical_only).toBe(true);

      const spatialRequest = await callTool(
        harness,
        sessionId,
        "container.plan_summary",
        containerInput({ spatial_layout_requested: true }),
      );
      expect(spatialRequest.status).toBe("blocked");
      expect(spatialRequest.data).toBeNull();
      expect(JSON.stringify(spatialRequest)).toContain("security.forbidden");
    } finally {
      await harness.close();
    }
  });

  it("returns a blocked response for a forbidden send attempt and rejects unknown tools", async () => {
    const harness = createFixtureHarness();
    try {
      const sessionId = await initialize(harness);
      const forbidden = await harness.request(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "quote.send", arguments: quoteInput() },
        },
        sessionId,
      );
      const forbiddenBody = (await forbidden.json()) as {
        result?: { isError?: boolean };
      };
      expect(forbiddenBody.result?.isError).toBe(true);

      const unknown = await harness.request(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "generic.commit_operation", arguments: {} },
        },
        sessionId,
      );
      const unknownBody = (await unknown.json()) as { result?: { isError?: boolean } };
      expect(unknownBody.result?.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("runs quote draft and review task through preview, approval, commit, readback and idempotency", async () => {
    const harness = createFixtureHarness();
    try {
      const sessionId = await initialize(harness);
      const previewKey = "idem_fixture_quote_preview_001";
      const commitKey = "idem_fixture_quote_commit_001";
      const previewInput = {
        schema_version: schemaVersion,
        version: "quote-save@fixture-1",
        quote_result: legacyQuoteDraftResult(),
        target: { system: "existing_quote_system", record_kind: "draft" },
        write_context: writeContext("tenant_demo_a", "preview", null, previewKey),
      };
      const preview = await callTool(harness, sessionId, "quote.save_draft", previewInput);
      expect(preview.status).toBe("success");
      const previewRef = (preview.data as { preview_ref: string }).preview_ref;
      const pendingApproval = await callTool(harness, sessionId, "quote.save_draft", {
        ...previewInput,
        write_context: writeContext(
          "tenant_demo_a",
          "commit",
          previewRef,
          "idem_fixture_quote_pending_001",
          { required: true, status: "pending", approval_id: null },
        ),
      });
      expect(pendingApproval.status).toBe("blocked");
      const commit = await callTool(harness, sessionId, "quote.save_draft", {
        ...previewInput,
        write_context: writeContext(
          "tenant_demo_a",
          "commit",
          previewRef,
          commitKey,
          { required: true, status: "approved", approval_id: "approval_quote_001" },
        ),
      });
      expect(commit.status).toBe("success");
      expect((commit.data as { readback_evidence: { verified: boolean } }).readback_evidence.verified).toBe(true);
      const replay = await callTool(harness, sessionId, "quote.save_draft", {
        ...previewInput,
        write_context: writeContext(
          "tenant_demo_a",
          "commit",
          previewRef,
          commitKey,
          { required: true, status: "approved", approval_id: "approval_quote_001" },
        ),
      });
      expect(replay).toEqual(commit);

      const taskPreviewKey = "idem_fixture_review_preview_001";
      const taskCommitKey = "idem_fixture_review_commit_001";
      const taskPreviewInput = {
        schema_version: schemaVersion,
        version: "review-task@fixture-1",
        task_type: "quote",
        priority: "normal",
        reason_codes: ["quote.zone_conflict"],
        opaque_context_refs: [
          { ref_id: "opaque_fixture_context_1", kind: "raw_input", purpose: "fixture context", expires_at: null },
        ],
        write_context: writeContext("tenant_demo_a", "preview", null, taskPreviewKey),
      };
      const taskPreview = await callTool(harness, sessionId, "review.create_task", taskPreviewInput);
      const taskPreviewRef = (taskPreview.data as { preview_ref: string }).preview_ref;
      const taskPendingApproval = await callTool(harness, sessionId, "review.create_task", {
        ...taskPreviewInput,
        write_context: writeContext(
          "tenant_demo_a",
          "commit",
          taskPreviewRef,
          "idem_fixture_review_pending_001",
          { required: true, status: "pending", approval_id: null },
        ),
      });
      expect(taskPendingApproval.status).toBe("blocked");
      const taskCommit = await callTool(harness, sessionId, "review.create_task", {
        ...taskPreviewInput,
        write_context: writeContext(
          "tenant_demo_a",
          "commit",
          taskPreviewRef,
          taskCommitKey,
          { required: true, status: "approved", approval_id: "approval_review_001" },
        ),
      });
      expect(taskCommit.status).toBe("success");
      expect((taskCommit.data as { readback_evidence: { verified: boolean } }).readback_evidence.verified).toBe(true);
      const taskReplay = await callTool(harness, sessionId, "review.create_task", {
        ...taskPreviewInput,
        write_context: writeContext(
          "tenant_demo_a",
          "commit",
          taskPreviewRef,
          taskCommitKey,
          { required: true, status: "approved", approval_id: "approval_review_001" },
        ),
      });
      expect(taskReplay).toEqual(taskCommit);
    } finally {
      await harness.close();
    }
  });

  it("blocks a cross-tenant request before the adapter is reached", async () => {
    const harness = createFixtureHarness({ tenantId: "tenant_demo_a" });
    try {
      const sessionId = await initialize(harness);
      const response = await harness.request(
        {
        schema_version: schemaVersion,
        version: "quote-save@fixture-1",
        quote_result: null,
        target: { system: "existing_quote_system", record_kind: "draft" },
        write_context: writeContext("tenant_demo_b", "preview", null, "idem_cross_tenant_001"),
        },
        sessionId,
      );
      expect(response.status).toBe(403);
    } finally {
      await harness.close();
    }
  });
});
