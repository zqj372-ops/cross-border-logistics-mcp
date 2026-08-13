import { describe, expect, it } from "vitest";

import { quoteV2InputSchema } from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import { MemoryAuditRepository } from "../../src/logistics_mcp/platform/audit";
import { MemoryIdempotencyRepository } from "../../src/logistics_mcp/platform/idempotency";
import { parseExecutionContext, type AuthClaims } from "../../src/logistics_mcp/platform/context";
import type { DomainToolOutcome } from "../../src/logistics_mcp/server/tool-registry";
import { executeRegisteredTool } from "../../src/logistics_mcp/server/tool-registry";
import {
  createFixtureComposition,
  createProductionComposition,
} from "../../src/logistics_mcp/server/composition";
import { createMcpHttpHandler } from "../../src/logistics_mcp/server/http";
import { SessionRuntimeRegistry } from "../../src/logistics_mcp/platform/session-runtime";
import { RUNTIME_REQUEST_TIMEOUT_MS } from "../../src/logistics_mcp/server/start";
import {
  quoteCreatePdfInputSchema,
} from "../../src/logistics_mcp/domains/quote/create-pdf";

const claims = (): AuthClaims => ({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:pdf_write"],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

const context = parseExecutionContext(claims());

function quoteRequest(): Record<string, unknown> {
  return quoteV2InputSchema.parse({
    schema_version: "2026-08-11.v1",
    version: "quote-request@2026-08-13.v2",
    origin: { warehouse_code: "tenant-warehouse-01", province: "ON" },
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
      explicit_pallet_count: 1,
      longest_side: { value: "1", unit: "m" },
      is_stackable: false,
      weight_kg: { value: "10", unit: "kg" },
      pieces: 1,
      package_types: ["pallet"],
      total_volume: { value: "1", unit: "cbm" },
    },
    services: {
      appointment: false,
      liftgate: false,
      pallet_jack: false,
      detention_minutes: 0,
      limited_access: false,
      remote_area: false,
    },
    effective_at: "2026-08-13",
  });
}

function pdfInput(
  operationMode: "preview" | "commit" = "preview",
  idempotencyKey = "pdf_platform_key_001",
): Record<string, unknown> {
  return quoteCreatePdfInputSchema.parse({
    schema_version: "2026-08-11.v1",
    version: "quote-create-pdf-request@2026-08-14.v1",
    quote_request: quoteRequest(),
    presentation: { customer_display_name: "Platform Test" },
    write_context: {
      idempotency_key: idempotencyKey,
      operation_mode: operationMode,
      preview_ref: operationMode === "preview" ? null : "preview:quote.pdf:test",
      approval: operationMode === "preview"
        ? { required: false, status: "not_required", approval_id: null }
        : { required: true, status: "approved", approval_id: "approval:platform-test" },
    },
  });
}

function request(body: unknown, sessionId?: string): Request {
  return new Request("https://mcp.example.invalid/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      origin: "https://client.example.invalid",
      host: "mcp.example.invalid",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify(body),
  });
}

function livePdfOutcome(input: unknown, mode: "normal" | "mismatch" | "non_success_data" | "unknown_trace" | "unknown_data" | "extra_source" | "empty_trace" = "normal"): DomainToolOutcome {
  const value = input as {
    write_context: {
      idempotency_key: string;
      operation_mode: "preview" | "commit";
      preview_ref: string | null;
      approval: { approval_id: string | null };
    };
  };
  const writeContext = value.write_context;
  const sourceId = writeContext.operation_mode === "preview"
    ? "src:quote:platform-live"
    : "src:pdf:platform-live";
  const operationStatus = mode === "mismatch"
    ? "previewed"
    : writeContext.operation_mode === "preview"
      ? "previewed"
      : "committed";
  return {
    status: "success",
    data: operationStatus === "previewed"
      ? {
          version: "write-result@2026-08-13.v2",
          operation: "quote.create_pdf",
          operation_status: "previewed",
          record_id: null,
          preview_ref: "preview:quote.pdf:platform-live",
          readback_evidence: null,
          idempotency_key: writeContext.idempotency_key,
          approval: { required: false, status: "not_required", approval_id: null },
        }
      : {
          version: "write-result@2026-08-13.v2",
          operation: "quote.create_pdf",
          operation_status: "committed",
          record_id: "document:platform-live",
          preview_ref: writeContext.preview_ref,
          readback_evidence: {
            target_system: "quote-pdf-api",
            record_id: "document:platform-live",
            observed_version: "sha256:platform-live",
            observed_at: "2026-08-14T00:00:00Z",
            verified: true,
            source_ref_ids: [sourceId],
          },
          idempotency_key: writeContext.idempotency_key,
          approval: {
            required: true,
            status: "approved",
            approval_id: writeContext.approval.approval_id,
          },
        },
    sourceRefs: [{
      source_id: sourceId,
      source_type: "opaque_reference",
      system: "quote-pdf-api",
      locator: "opaque://platform-live",
      version: "quote-pdf@platform-live",
      retrieved_at: "2026-08-14T00:00:00Z",
      authority: "authoritative",
      content_hash: null,
    }, ...(mode === "extra_source" ? [{
      source_id: "src:extra:outer",
      source_type: "opaque_reference" as const,
      system: "quote-pdf-api",
      locator: "opaque://extra-outer",
      version: "quote-pdf@extra-outer",
      retrieved_at: "2026-08-14T00:00:00Z",
      authority: "authoritative" as const,
      content_hash: null,
    }] : [])],
    calculationTrace: [{
      step_id: "step:quote:platform-live",
      operation: "preserve PDF evidence",
      inputs: [],
      result: "verified",
      source_ref_ids: mode === "unknown_trace"
        ? [sourceId, "src:unknown:trace"]
        : mode === "empty_trace" ? [] : [sourceId],
      rounding: null,
    }],
  };
}

describe("quote.create_pdf platform registration", () => {
  it.each(["fixtures", "production"] as const)(
    "uses task05 schemas and fails closed without a PDF handler in %s",
    async (mode) => {
      const composition = mode === "fixtures"
        ? createFixtureComposition({
            dataMode: "fixtures",
            allowedOrigins: ["https://client.example.invalid"],
            allowedHosts: ["mcp.example.invalid"],
            authenticate: () => claims(),
          })
        : createProductionComposition({ dataMode: "production" });
      try {
        const definition = composition.definitions.find(
          ({ name }) => name === "quote.create_pdf",
        );
        if (definition === undefined) throw new Error("quote PDF definition missing");

        expect(definition.inputSchema).toBe(quoteCreatePdfInputSchema);
        expect(composition.contracts["quote.create_pdf"]?.inputSchema).toBe(
          quoteCreatePdfInputSchema,
        );
        const envelope = await executeRegisteredTool(
          definition,
          pdfInput(),
          context,
          {
            requestId: "req_quote_pdf_platform_001",
            auditId: "audit_quote_pdf_platform_001",
            idempotencyRepository: new MemoryIdempotencyRepository(),
          },
        );

        expect(envelope).toMatchObject({
          status: "unavailable",
          data: null,
          source_refs: [],
          calculation_trace: [],
          blockers: [expect.objectContaining({ code: "quote.create_pdf.handler_unavailable" })],
        });
      } finally {
        await composition.close();
      }
    },
  );

  it("exposes a strict object output schema and unavailable SDK call", async () => {
    const composition = createFixtureComposition({
      dataMode: "fixtures",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => claims(),
    });
    try {
      const initialize = await composition.handler(request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "platform-test", version: "1.0.0" },
        },
      }));
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).not.toBeNull();

      const listed = await composition.handler(request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }, sessionId ?? undefined));
      const listedBody = await listed.json() as {
        result?: { tools?: Array<Record<string, unknown>> };
      };
      const tool = listedBody.result?.tools?.find(
        (candidate) => candidate.name === "quote.create_pdf",
      );
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool?.outputSchema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });

      const called = await composition.handler(request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "quote.create_pdf", arguments: pdfInput() },
      }, sessionId ?? undefined));
      const body = await called.json() as {
        result?: { structuredContent?: Record<string, unknown> };
      };
      expect(body.result?.structuredContent).toMatchObject({
        status: "unavailable",
        data: null,
      });
    } finally {
      await composition.close();
    }
  });

  it("passes legal preview and commit through the real SDK and rejects bad shapes", async () => {
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    const handler = createMcpHttpHandler({
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => claims(),
      handlers: {
        ...composition.handlers,
        "quote.create_pdf": (input) => {
          const key = (input as { write_context: { idempotency_key: string } })
            .write_context.idempotency_key;
          const mode = key === "pdf_sdk_mismatch_001"
            ? "mismatch"
            : key === "pdf_sdk_bad_data_001"
              ? "normal"
              : key === "pdf_sdk_approval_mismatch_001"
                ? "normal"
                : key === "pdf_sdk_non_success_data_001"
                  ? "non_success_data"
                  : key === "pdf_sdk_unknown_trace_001"
                    ? "unknown_trace"
                    : key === "pdf_sdk_unknown_data_001"
                      ? "unknown_data"
                    : key === "pdf_sdk_extra_source_001"
                        ? "extra_source"
                        : key === "pdf_sdk_empty_trace_001"
                          ? "empty_trace"
                        : "normal";
          const outcome = livePdfOutcome(input, mode);
          if (key === "pdf_sdk_bad_data_001" && outcome.data !== null) {
            return { ...outcome, data: { ...outcome.data, unexpected: true } };
          }
          if (key === "pdf_sdk_approval_mismatch_001" && outcome.data !== null) {
            return {
              ...outcome,
              data: {
                ...outcome.data,
                approval: { required: true, status: "approved", approval_id: "approval:other" },
              },
            };
          }
          if (key === "pdf_sdk_non_success_data_001") {
            return {
              ...outcome,
              status: "manual_review",
              blockers: [{ code: "fixture.manual_review", message: "manual review", severity: "error" as const }],
            };
          }
          if (key === "pdf_sdk_unknown_data_001" && outcome.data !== null && outcome.data.readback_evidence !== null) {
            return {
              ...outcome,
              data: {
                ...outcome.data,
                readback_evidence: { ...outcome.data.readback_evidence, source_ref_ids: ["src:unknown:data"] },
              },
            };
          }
          return outcome;
        },
      },
      contracts: composition.contracts,
      auditRepository: new MemoryAuditRepository(),
      idempotencyRepository: new MemoryIdempotencyRepository(),
      sessionRegistry: new SessionRuntimeRegistry({
        idleTtlMs: 60_000,
        maxLifetimeMs: 60_000,
        maxTokenLifetimeMs: 60_000,
        maxSessions: 8,
      }),
      requestTimeoutMs: 1_000,
    });
    try {
      const initialize = await handler(request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "quote-pdf-sdk-test", version: "1.0.0" },
        },
      }));
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).not.toBeNull();

      const call = (id: number, input: unknown) => handler(request({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "quote.create_pdf", arguments: input },
      }, sessionId ?? undefined));
      const preview = await call(2, pdfInput("preview", "pdf_sdk_preview_001"));
      const previewBody = await preview.json() as {
        result?: { structuredContent?: Record<string, unknown> };
      };
      expect(previewBody.result?.structuredContent).toMatchObject({
        status: "success",
        data: { operation_status: "previewed", readback_evidence: null },
      });

      const commit = await call(3, pdfInput("commit", "pdf_sdk_commit_001"));
      const commitBody = await commit.json() as {
        result?: { structuredContent?: Record<string, unknown> };
      };
      expect(commitBody.result?.structuredContent).toMatchObject({
        status: "success",
        data: {
          operation_status: "committed",
          readback_evidence: { verified: true },
        },
      });

      const emptyTraceCommit = await call(4, pdfInput("commit", "pdf_sdk_empty_trace_001"));
      const emptyTraceBody = await emptyTraceCommit.json() as {
        result?: { structuredContent?: Record<string, unknown> };
      };
      expect(emptyTraceBody.result?.structuredContent).toMatchObject({
        status: "success",
        data: { operation_status: "committed" },
      });

      const unknownRoot = await call(5, {
        ...pdfInput("preview", "pdf_sdk_unknown_001"),
        unexpected: true,
      });
      const unknownBody = await unknownRoot.json() as {
        error?: unknown;
        result?: { structuredContent?: { status?: string } };
      };
      expect(
        unknownBody.error !== undefined ||
          unknownBody.result?.structuredContent?.status !== "success",
      ).toBe(true);

      const badData = await call(6, pdfInput("preview", "pdf_sdk_bad_data_001"));
      const badDataBody = await badData.json() as {
        result?: { structuredContent?: Record<string, unknown> };
      };
      expect(badDataBody.result?.structuredContent).toMatchObject({
        status: "manual_review",
        data: null,
      });

      const mismatch = await call(7, pdfInput("commit", "pdf_sdk_mismatch_001"));
      const mismatchBody = await mismatch.json() as {
        result?: { structuredContent?: Record<string, unknown> };
      };
      expect(mismatchBody.result?.structuredContent).toMatchObject({
        status: "manual_review",
        data: null,
      });

      const approvalMismatch = await call(8, pdfInput("commit", "pdf_sdk_approval_mismatch_001"));
      const approvalMismatchBody = await approvalMismatch.json() as {
        result?: { structuredContent?: Record<string, unknown> };
      };
      expect(approvalMismatchBody.result?.structuredContent).toMatchObject({
        status: "manual_review",
        data: null,
      });

      const nonSuccessData = await call(9, pdfInput("preview", "pdf_sdk_non_success_data_001"));
      const nonSuccessDataBody = await nonSuccessData.json() as {
        result?: { structuredContent?: Record<string, unknown> };
      };
      expect(nonSuccessDataBody.result?.structuredContent).toMatchObject({
        status: "manual_review",
        data: null,
      });

      for (const [id, key] of [
        [10, "pdf_sdk_unknown_trace_001"],
        [11, "pdf_sdk_unknown_data_001"],
        [12, "pdf_sdk_extra_source_001"],
      ] as const) {
        const invalidEvidence = await call(id, pdfInput("commit", key));
        const invalidEvidenceBody = await invalidEvidence.json() as {
          result?: { structuredContent?: Record<string, unknown> };
        };
        expect(invalidEvidenceBody.result?.structuredContent).toMatchObject({
          status: "manual_review",
          data: null,
        });
      }
    } finally {
      await handler.close();
      await composition.close();
    }
  });

  it("keeps the runtime request deadline at one explicit 30 second budget", () => {
    expect(RUNTIME_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});
