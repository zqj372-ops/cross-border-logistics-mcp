import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { MemoryIdempotencyRepository } from "../../src/logistics_mcp/platform/idempotency";
import {
  executeRegisteredTool,
  executeRegisteredToolWithResult,
  registerPhaseOneTools,
  type DomainToolHandler,
} from "../../src/logistics_mcp/server/tool-registry";

const readContext = parseExecutionContext({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["system:read"],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

const writeContext = parseExecutionContext({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:draft_write", "review:create_task"],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

function definition(
  name: "system.get_data_status" | "quote.save_draft" | "review.create_task",
  handler: DomainToolHandler = () => ({
    status: "success",
    data: {},
  }),
  validateOutput: (data: unknown) => void = () => undefined,
) {
  const result = registerPhaseOneTools(
    { [name]: handler },
    {
      [name]: {
        inputSchema: z.record(z.string(), z.unknown()),
        validateOutput,
      },
    },
  ).find((candidate) => candidate.name === name);
  if (result === undefined) throw new Error(`missing tool ${name}`);
  return result;
}

function writeInput(
  tool: "quote.save_draft" | "review.create_task",
  operationMode: "preview" | "commit",
  approval: {
    required: boolean;
    status: "not_required" | "pending" | "approved" | "rejected";
    approval_id: string | null;
  },
  key: string,
) {
  return {
    tool,
    write_context: {
      tenant_context: {
        tenant_id: "tenant_demo",
        actor_id: "actor_sales",
        actor_role: "sales",
        client_id: "client_demo",
        session_id: "session_demo",
      },
      idempotency_key: key,
      operation_mode: operationMode,
      preview_ref: operationMode === "preview" ? null : "preview_security_001",
      approval,
    },
  };
}

function writeOutcome(
  tool: "quote.save_draft" | "review.create_task",
  key: string,
  operationStatus: "previewed" | "committed",
) {
  return {
    status: "success" as const,
    data: {
      operation_status: operationStatus,
      preview_ref:
        operationStatus === "previewed"
          ? "preview_security_001"
          : "preview_security_001",
      readback_evidence:
        operationStatus === "previewed"
          ? null
          : { verified: true },
      idempotency_key: key,
      operation: tool,
    },
  };
}

describe("write execution security regressions", () => {
  it("rejects a successful null data result even when the validator is permissive", async () => {
    const tool = definition("system.get_data_status", () => ({
      status: "success",
      data: null,
    }));

    await expect(
      executeRegisteredTool(tool, {}, readContext, {
        requestId: "req_output_success_null",
        auditId: "audit_output_success_null",
      }),
    ).rejects.toMatchObject({ code: "tool_contract_invalid" });
  });

  it.each(["needs_input", "manual_review", "blocked", "unavailable"] as const)(
    "rejects malformed non-null data for %s instead of relying on the envelope record type",
    async (status) => {
      const tool = definition(
        "system.get_data_status",
        () => ({
          status,
          data: { malformed: true },
          blockers: [{ code: "fixture.blocked", message: "fixture", severity: "error" as const }],
        }),
        () => {
          throw new Error("tool output schema mismatch");
        },
      );

      await expect(
        executeRegisteredTool(tool, {}, readContext, {
          requestId: `req_output_${status}`,
          auditId: `audit_output_${status}`,
        }),
      ).rejects.toMatchObject({ code: "tool_contract_invalid" });
    },
  );

  it.each(["quote.save_draft", "review.create_task"] as const)(
    "does not let required=false bypass the server approval policy for %s",
    async (name) => {
      const key = `idem_approval_bypass_${name.replace(/\W/g, "_")}`;
      const handler = vi.fn(() => writeOutcome(name, key, "committed"));
      const tool = definition(name, handler);
      const input = writeInput(
        name,
        "commit",
        { required: false, status: "pending", approval_id: null },
        key,
      );

      await expect(
        executeRegisteredTool(tool, input, writeContext, {
          requestId: `req_approval_bypass_${name}`,
          auditId: `audit_approval_bypass_${name}`,
          idempotencyRepository: new MemoryIdempotencyRepository(),
        }),
      ).rejects.toMatchObject({
        code: "approval.not_approved",
        status: "blocked",
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(["quote.save_draft", "review.create_task"] as const)(
    "accepts an approved %s commit even when the compatibility required flag is false",
    async (name) => {
      const key = `idem_approval_success_${name.replace(/\W/g, "_")}`;
      const handler = vi.fn(() => writeOutcome(name, key, "committed"));
      const tool = definition(name, handler);
      const input = writeInput(
        name,
        "commit",
        { required: false, status: "approved", approval_id: "approval_security_001" },
        key,
      );

      const result = await executeRegisteredTool(tool, input, writeContext, {
        requestId: `req_approval_success_${name}`,
        auditId: `audit_approval_success_${name}`,
        idempotencyRepository: new MemoryIdempotencyRepository(),
      });

      expect(result.status).toBe("success");
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );

  it("allows preview without an approval", async () => {
    const key = "idem_approval_preview_001";
    const tool = definition(
      "quote.save_draft",
      () => writeOutcome("quote.save_draft", key, "previewed"),
    );

    const result = await executeRegisteredTool(
      tool,
      writeInput(
        "quote.save_draft",
        "preview",
        { required: false, status: "not_required", approval_id: null },
        key,
      ),
      writeContext,
      {
        requestId: "req_approval_preview",
        auditId: "audit_approval_preview",
        idempotencyRepository: new MemoryIdempotencyRepository(),
      },
    );

    expect(result.status).toBe("success");
  });

  it("runs only one handler for concurrent identical writes and does not replay a null reservation", async () => {
    const key = "idem_execution_concurrent_001";
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const handler = vi.fn(async () => {
      entered();
      await released;
      return writeOutcome("quote.save_draft", key, "previewed");
    });
    const tool = definition("quote.save_draft", handler);
    const input = writeInput(
      "quote.save_draft",
      "preview",
      { required: false, status: "not_required", approval_id: null },
      key,
    );
    const repository = new MemoryIdempotencyRepository();

    const first = executeRegisteredToolWithResult(tool, input, writeContext, {
      requestId: "req_execution_first",
      auditId: "audit_execution_first",
      idempotencyRepository: repository,
    });
    await firstEntered;
    const second = executeRegisteredToolWithResult(tool, input, writeContext, {
      requestId: "req_execution_second",
      auditId: "audit_execution_second",
      idempotencyRepository: repository,
    });
    release();

    await expect(second).rejects.toMatchObject({
      code: "idempotency.in_progress",
    });
    await expect(first).resolves.toMatchObject({ envelope: { status: "success" } });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
