import { describe, expect, it } from "vitest";

import {
  callTool,
  cargoInput,
  containerInput,
  createFixtureHarness,
  initialize,
  quoteInput,
  writeContext,
} from "./fixtures/tenant-fixtures";

const schemaVersion = "2026-08-11.v1";

describe("Phase 1 integrated fixture gateway", () => {
  it("exposes exactly the nine public tools and no generic write tool", async () => {
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
            outputSchema?: { $schema?: string; required?: string[] };
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
      expect(body.result?.tools?.every((tool) =>
        tool.title !== undefined &&
        tool.description !== undefined &&
        !tool.description.includes("Phase 1") &&
        tool.inputSchema?.$schema === "https://json-schema.org/draft/2020-12/schema" &&
        tool.outputSchema?.$schema === "https://json-schema.org/draft/2020-12/schema" &&
        tool.outputSchema.required?.includes("status") === true
      )).toBe(true);
    } finally {
      await harness.close();
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

  it("keeps quote address type and container theory-only boundaries explicit", async () => {
    const harness = createFixtureHarness();
    try {
      const sessionId = await initialize(harness);
      const missingAddressType = await callTool(
        harness,
        sessionId,
        "quote.canada_final_mile.calculate",
        quoteInput({
          destination: {
            ...(quoteInput().destination as Record<string, unknown>),
            address_type: "unknown",
          },
        }),
      );
      expect(missingAddressType.status).toBe("needs_input");
      expect(missingAddressType.data).toBeNull();

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
      const quote = await callTool(harness, sessionId, "quote.canada_final_mile.calculate", quoteInput());
      expect(quote.status).toBe("success");
      const previewKey = "idem_fixture_quote_preview_001";
      const commitKey = "idem_fixture_quote_commit_001";
      const previewInput = {
        schema_version: schemaVersion,
        version: "quote-save@fixture-1",
        quote_result: quote.data,
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
