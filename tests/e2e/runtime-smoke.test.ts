import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  cargoInput,
  containerInput,
  legacyQuoteDraftResult,
  quoteInput,
  quotePdfInput,
} from "./fixtures/tenant-fixtures";

const root = resolve(import.meta.dirname, "../..");

type ToolEnvelope = {
  readonly request_id?: string;
  readonly status?: string;
  readonly data?: Record<string, unknown> | null;
  readonly blockers?: readonly { readonly code?: string }[];
  readonly source_refs?: readonly unknown[];
  readonly calculation_trace?: readonly unknown[];
};

function structured(result: Awaited<ReturnType<Client["callTool"]>>): ToolEnvelope {
  return result.structuredContent ?? {};
}

function customsSearchInput(): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "customs-request@fixture-1",
    rule_date: "2026-08-11",
    query_kind: "name_search",
    query_code: null,
    product_description_ref: {
      ref_id: "opaque-product-runtime-001",
      kind: "raw_input",
      purpose: "synthetic runtime fixture",
      expires_at: null,
    },
    product_attributes: {
      material: "synthetic",
      use: "runtime fixture",
      origin_country: "CN",
      contains_steel_aluminum: false,
    },
    selected_hs6: null,
  };
}

function customsEstimateInput(): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
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

function runtimeWriteContext(
  operationMode: "preview" | "commit",
  previewRef: string | null,
  idempotencyKey: string,
  approval: Record<string, unknown> = {
    required: false,
    status: "not_required",
    approval_id: null,
  },
  tenantId = "tenant_fixture",
): Record<string, unknown> {
  return {
    tenant_context: {
      tenant_id: tenantId,
      actor_id: "local_operator",
      actor_role: "admin",
      client_id: "local_fixture_client",
      session_id: "local_fixture_auth",
    },
    idempotency_key: idempotencyKey,
    operation_mode: operationMode,
    preview_ref: previewRef,
    approval,
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("A local runtime smoke port was not allocated.");
  }
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
  return port;
}

async function waitForHealth(port: number, child: ChildProcess): Promise<Response> {
  let lastError = "runtime did not become healthy";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${lastError}; child exited with ${child.exitCode}`);
    }
    try {
      return await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error(lastError);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const onExit = () => {
      child.removeListener("exit", onExit);
      resolvePromise();
    };
    child.once("exit", onExit);
    if (child.exitCode !== null) {
      onExit();
    } else {
      child.kill("SIGTERM");
    }
  });
}

describe("built runtime smoke", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], {
      cwd: root,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        npm_config_update_notifier: "false",
      },
    });
  });

  it("starts the dist entry directly, loads cargo contracts and answers health", async () => {
    const layout = await mkdtemp(resolve(tmpdir(), "logistics-mcp-runtime-"));
    await cp(resolve(root, "dist"), resolve(layout, "dist"), { recursive: true });
    await cp(resolve(root, "docs/contracts"), resolve(layout, "docs/contracts"), { recursive: true });
    const entry = resolve(layout, "dist/src/logistics_mcp/server/start.mjs");
    expect(existsSync(resolve(layout, "package.json"))).toBe(false);
    const port = await freePort();
    const child = spawn(process.execPath, [entry], {
      cwd: layout,
      env: {
        PATH: process.env.PATH ?? "",
        MCP_PORT: String(port),
        MCP_DATA_MODE: "production",
        MCP_JWT_ISSUER: "https://issuer.example.invalid/",
        MCP_JWT_AUDIENCE: "logistics-mcp-demo",
        MCP_STATE_DB_PATH: resolve(layout, "platform.sqlite"),
        MCP_INSTANCE_ID: "runtime-smoke-worker",
        MCP_ALLOWED_ORIGINS: "https://client.example.invalid",
        MCP_ALLOWED_HOSTS: "mcp.example.invalid",
        MCP_ALLOWED_OUTBOUND_HOSTS: "riskcustoms.example.invalid",
        MCP_TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const health = await waitForHealth(port, child);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(readiness.status).toBe(503);
      const readinessBody = (await readiness.json()) as {
        status?: string;
        reasons?: string[];
      };
      expect(readinessBody).toMatchObject({ status: "not_ready" });
      expect(readinessBody.reasons).toEqual(
        expect.arrayContaining([
          "missing_mcp_jwks_url",
          "production_token_verifier_missing",
        ]),
      );
      const unavailable = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          origin: "https://client.example.invalid",
          host: "mcp.example.invalid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "runtime-smoke", version: "1.0.0" },
          },
        }),
      });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ status: "unavailable" });
      const oversized = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(32 * 1024 + 1),
          "x-forwarded-proto": "https",
          origin: "https://client.example.invalid",
          host: "mcp.example.invalid",
        },
        body: "x".repeat(32 * 1024 + 1),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ status: "blocked" });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`,
        { cause: error },
      );
    } finally {
      await stop(child);
      await rm(layout, { recursive: true, force: true });
    }
  }, 10_000);

  it("starts the dist fixture entry and serves admin plus all MCP tool calls", async () => {
    const layout = await mkdtemp(resolve(tmpdir(), "logistics-mcp-fixture-runtime-"));
    await cp(resolve(root, "dist"), resolve(layout, "dist"), { recursive: true });
    await cp(resolve(root, "docs/contracts"), resolve(layout, "docs/contracts"), { recursive: true });
    const entry = resolve(layout, "dist/src/logistics_mcp/server/start.mjs");
    const port = await freePort();
    const child = spawn(process.execPath, [entry], {
      cwd: layout,
      env: {
        PATH: process.env.PATH ?? "",
        MCP_PORT: String(port),
        MCP_DATA_MODE: "fixtures",
        MCP_ADMIN_UI_ENABLED: "true",
        MCP_FIXTURE_TOKEN: "local-fixture-token",
        MCP_JWT_ISSUER: "https://issuer.example.invalid/",
        MCP_JWT_AUDIENCE: "logistics-mcp-local",
        MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        MCP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        MCP_ALLOWED_OUTBOUND_HOSTS: "fixture.example.invalid",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let client: Client | undefined;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      expect((await waitForHealth(port, child)).status).toBe(200);
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(readiness.status).toBe(503);
      const readinessBody = (await readiness.json()) as {
        status?: string;
        reasons?: string[];
      };
      expect(readinessBody.status).toBe("not_ready");
      expect(readinessBody.reasons).toEqual(["fixture_mode_not_production_ready"]);
      const admin = await fetch(`http://127.0.0.1:${port}/admin/?fixture=1`);
      expect(admin.status).toBe(200);
      expect(await admin.text()).toContain("跨境物流控制台");
      const adminSnapshot = await fetch(`http://127.0.0.1:${port}/admin/api/v1/snapshot`);
      expect(adminSnapshot.status).toBe(200);
      expect(await adminSnapshot.json()).toMatchObject({
        environment: "演示环境",
        health: { readyz: { status: "blocked" } },
        clients: [],
        audit: [],
      });

      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const rejected = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { ...headers, authorization: "Bearer wrong-fixture-token" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "local-runtime-smoke", version: "1.0.0" },
          },
        }),
      });
      expect(rejected.status).toBe(401);

      const wrongOrigin = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...headers,
          authorization: "Bearer local-fixture-token",
          origin: "https://evil.example.invalid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "local-runtime-smoke", version: "1.0.0" },
          },
        }),
      });
      expect(wrongOrigin.status).toBe(403);

      client = new Client({ name: "local-runtime-smoke", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        {
          requestInit: {
            headers: {
              authorization: "Bearer local-fixture-token",
            },
          },
        },
      );
      await client.connect(transport as Transport);
      expect(transport.sessionId).toBeTruthy();
      expect(client.getInstructions()).toContain("写操作必须按预览→审批→提交→读回执行");

      const toolList = await client.listTools();
      expect(toolList.tools.map((tool) => tool.name).sort()).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "customs.ca.estimate",
        "customs.ca.search",
        "knowledge.search_curated",
        "quote.canada_final_mile.calculate",
        "quote.create_pdf",
        "quote.save_draft",
        "review.create_task",
        "system.get_data_status",
      ].sort());
      expect(toolList.tools.every((tool) =>
        tool.inputSchema.$schema === "https://json-schema.org/draft/2020-12/schema" &&
        tool.outputSchema?.$schema === "https://json-schema.org/draft/2020-12/schema" &&
        tool.outputSchema?.type === "object" &&
        tool.outputSchema?.additionalProperties === false
      )).toBe(true);
      expect(toolList.tools.find((tool) => tool.name === "quote.save_draft")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
      expect(toolList.tools.find((tool) => tool.name === "quote.create_pdf")).toMatchObject({
        title: "创建报价 PDF",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      });

      const cargo = structured(await client.callTool({
        name: "cargo.calculate",
        arguments: cargoInput(),
      }));
      expect(cargo.status).toBe("success");
      expect(cargo.data).toMatchObject({
        metrics: { actual_weight: { unit: "kg" } },
      });
      expect(cargo.calculation_trace?.length).toBeGreaterThan(0);

      const container = structured(await client.callTool({
        name: "container.plan_summary",
        arguments: containerInput(),
      }));
      expect(container.status).toBe("success");
      expect(container.data).toMatchObject({ theoretical_only: true });

      const quote = structured(await client.callTool({
        name: "quote.canada_final_mile.calculate",
        arguments: quoteInput(),
      }));
      expect(quote.status).toBe("unavailable");
      expect(quote.data).toBeNull();
      expect(quote.source_refs).toEqual([]);
      expect(quote.calculation_trace).toEqual([]);
      expect(quote.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "quote.adapter_disabled" }),
        ]),
      );

      const pdf = structured(await client.callTool({
        name: "quote.create_pdf",
        arguments: quotePdfInput("preview", "pdf_runtime_disabled_001"),
      }));
      expect(pdf).toMatchObject({ status: "unavailable", data: null });

      const customsSearch = structured(await client.callTool({
        name: "customs.ca.search",
        arguments: customsSearchInput(),
      }));
      expect(customsSearch.status).toBe("success");
      expect(customsSearch.data).toMatchObject({
        data_status: { ready: true },
      });
      expect(customsSearch.source_refs?.length).toBeGreaterThan(0);

      const customsEstimate = structured(await client.callTool({
        name: "customs.ca.estimate",
        arguments: customsEstimateInput(),
      }));
      expect(customsEstimate.status).toBe("success");
      expect(customsEstimate.data).toMatchObject({
        assessment_status: "estimated",
        requires_broker_confirmation: true,
      });

      const knowledge = structured(await client.callTool({
        name: "knowledge.search_curated",
        arguments: {
          schema_version: "2026-08-11.v1",
          query: "加拿大尾程规则",
          scope: "quote",
          include_archived: false,
        },
      }));
      expect(knowledge.status).toBe("success");
      expect(knowledge.source_refs?.length).toBeGreaterThan(0);

      const status = structured(await client.callTool({
        name: "system.get_data_status",
        arguments: {
          schema_version: "2026-08-11.v1",
          system: "all",
          rule_date: null,
        },
      }));
      expect(status.status).toBe("success");
      expect(status.data).toMatchObject({ ready: false, test_data: true });

      const quoteDraftBase = {
        schema_version: "2026-08-11.v1",
        version: "quote-save@fixture-1",
        quote_result: legacyQuoteDraftResult(),
        target: { system: "existing_quote_system", record_kind: "draft" },
      };
      const crossTenant = await client.callTool({
        name: "quote.save_draft",
        arguments: {
          ...quoteDraftBase,
          write_context: runtimeWriteContext(
            "preview",
            null,
            "idem_runtime_cross_tenant_001",
            undefined,
            "tenant_other",
          ),
        },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(crossTenant).toMatchObject({ code: 403 });
      expect(String(crossTenant)).toContain("security.cross_tenant_denied");
      const quotePreview = structured(await client.callTool({
        name: "quote.save_draft",
        arguments: {
          ...quoteDraftBase,
          write_context: runtimeWriteContext(
            "preview",
            null,
            "idem_runtime_quote_preview_001",
          ),
        },
      }));
      expect(quotePreview.status).toBe("success");
      expect(quotePreview.data).toMatchObject({
        operation_status: "previewed",
        readback_evidence: null,
      });
      const quotePreviewRef = quotePreview.data?.preview_ref;
      expect(quotePreviewRef).toEqual(expect.any(String));
      if (typeof quotePreviewRef !== "string") throw new Error("quote preview_ref missing");
      const quoteCommitBase = {
        ...quoteDraftBase,
        write_context: runtimeWriteContext(
          "commit",
          quotePreviewRef,
          "idem_runtime_quote_commit_001",
          { required: true, status: "pending", approval_id: null },
        ),
      };
      const blockedQuoteCommit = structured(await client.callTool({
        name: "quote.save_draft",
        arguments: quoteCommitBase,
      }));
      expect(blockedQuoteCommit.status).toBe("blocked");
      expect(blockedQuoteCommit.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "approval.not_approved" }),
        ]),
      );
      const approvedQuoteCommit = {
        ...quoteCommitBase,
        write_context: runtimeWriteContext(
          "commit",
          quotePreviewRef,
          "idem_runtime_quote_commit_001",
          {
            required: true,
            status: "approved",
            approval_id: "approval_runtime_quote_001",
          },
        ),
      };
      const committedQuote = structured(await client.callTool({
        name: "quote.save_draft",
        arguments: approvedQuoteCommit,
      }));
      expect(committedQuote.status).toBe("success");
      expect(committedQuote.data).toMatchObject({
        operation_status: "committed",
        readback_evidence: { verified: true },
      });
      const replayedQuote = structured(await client.callTool({
        name: "quote.save_draft",
        arguments: approvedQuoteCommit,
      }));
      expect(replayedQuote).toEqual(committedQuote);

      const reviewBase = {
        schema_version: "2026-08-11.v1",
        version: "review-task@fixture-1",
        task_type: "quote",
        priority: "normal",
        reason_codes: ["quote.zone_conflict"],
        opaque_context_refs: [
          {
            ref_id: "opaque-review-runtime-001",
            kind: "record",
            purpose: "synthetic runtime fixture",
            expires_at: null,
          },
        ],
      };
      const reviewPreview = structured(await client.callTool({
        name: "review.create_task",
        arguments: {
          ...reviewBase,
          write_context: runtimeWriteContext(
            "preview",
            null,
            "idem_runtime_review_preview_001",
          ),
        },
      }));
      expect(reviewPreview.status).toBe("success");
      expect(reviewPreview.data).toMatchObject({ operation_status: "previewed" });
      const reviewPreviewRef = reviewPreview.data?.preview_ref;
      expect(reviewPreviewRef).toEqual(expect.any(String));
      if (typeof reviewPreviewRef !== "string") throw new Error("review preview_ref missing");
      const blockedReview = structured(await client.callTool({
        name: "review.create_task",
        arguments: {
          ...reviewBase,
          write_context: runtimeWriteContext(
            "commit",
            reviewPreviewRef,
            "idem_runtime_review_commit_001",
            { required: true, status: "pending", approval_id: null },
          ),
        },
      }));
      expect(blockedReview.status).toBe("blocked");
      expect(blockedReview.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "approval.not_approved" }),
        ]),
      );
      const approvedReviewCommit = {
        ...reviewBase,
        write_context: runtimeWriteContext(
          "commit",
          reviewPreviewRef,
          "idem_runtime_review_commit_001",
          {
            required: true,
            status: "approved",
            approval_id: "approval_runtime_review_001",
          },
        ),
      };
      const committedReview = structured(await client.callTool({
        name: "review.create_task",
        arguments: approvedReviewCommit,
      }));
      expect(committedReview.status).toBe("success");
      expect(committedReview.data).toMatchObject({
        operation_status: "committed",
        readback_evidence: { verified: true },
      });
      const replayedReview = structured(await client.callTool({
        name: "review.create_task",
        arguments: approvedReviewCommit,
      }));
      expect(replayedReview).toEqual(committedReview);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`,
        { cause: error },
      );
    } finally {
      await client?.close().catch(() => undefined);
      await stop(child);
      await rm(layout, { recursive: true, force: true });
    }
  }, 10_000);
});
