import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  HandlerUnavailableError,
  ToolContractUnavailableError,
  ToolContractValidationError,
  WriteContractError,
  executeRegisteredTool,
} from "../../src/logistics_mcp/server/tool-registry";
import {
  phaseOneToolNames,
  registerPhaseOneTools,
} from "../../src/logistics_mcp/server/tool-registry";
import {
  MemoryIdempotencyRepository,
  IdempotencyConflictError,
} from "../../src/logistics_mcp/platform/idempotency";

const context = parseExecutionContext({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate"],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

const writeContext = parseExecutionContext({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate", "quote:draft_write"],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

describe("Phase 1 tool registry", () => {
  it("registers exactly the nine baseline tools", () => {
    expect(phaseOneToolNames).toEqual([
      "knowledge.search_curated",
      "system.get_data_status",
      "cargo.calculate",
      "container.plan_summary",
      "quote.canada_final_mile.calculate",
      "customs.ca.search",
      "customs.ca.estimate",
      "quote.save_draft",
      "review.create_task",
    ]);
    expect(registerPhaseOneTools().map((tool) => tool.name)).toEqual(
      phaseOneToolNames,
    );
  });

  it("describes an input/output schema and permission for every tool", () => {
    for (const tool of registerPhaseOneTools()) {
      expect(tool.inputSchemaId).toMatch(/2026-08-11\.v1/);
      expect(tool.outputSchemaId).toMatch(/schema\.json$/);
      expect(tool.permission).toMatch(/:/);
      expect(["read", "write"]).toContain(tool.kind);
    }
  });

  it("does not register generic or forbidden write capabilities", () => {
    const forbidden = [
      "commit_operation",
      "send_quote",
      "publish",
      "booking.submit",
      "rules.write",
    ];

    expect(
      registerPhaseOneTools().some((tool) =>
        forbidden.some((name) => tool.name.includes(name)),
      ),
    ).toBe(false);
  });

  it("fails closed when a domain handler has not been provided", async () => {
    const tool = registerPhaseOneTools().find(
      (candidate) => candidate.name === "cargo.calculate",
    );

    expect(tool).toBeDefined();
    await expect(
      executeRegisteredTool(tool!, {}, context, {
        requestId: "req_tool_001",
        auditId: "audit_tool_001",
      }),
    ).rejects.toThrow(HandlerUnavailableError);
  });

  it("does not run a configured handler without a bound input/output contract", async () => {
    const handler = vi.fn(() => ({
      status: "success" as const,
      data: { not_a_cargo_result: true },
    }));
    const tool = registerPhaseOneTools({ "cargo.calculate": handler }).find(
      (candidate) => candidate.name === "cargo.calculate",
    );

    await expect(
      executeRegisteredTool(tool!, {}, context, {
        requestId: "req_contract_001",
        auditId: "audit_contract_001",
      }),
    ).rejects.toThrow(ToolContractUnavailableError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when a bound output contract rejects handler data", async () => {
    const handler = vi.fn(() => ({
      status: "success" as const,
      data: { not_a_cargo_result: true },
    }));
    const tool = registerPhaseOneTools(
      { "cargo.calculate": handler },
      {
        "cargo.calculate": {
          inputSchema: z.record(z.string(), z.unknown()),
          validateOutput: () => {
            throw new Error("schema mismatch");
          },
        },
      },
    ).find((candidate) => candidate.name === "cargo.calculate");

    await expect(
      executeRegisteredTool(tool!, {}, context, {
        requestId: "req_contract_002",
        auditId: "audit_contract_002",
      }),
    ).rejects.toThrow(ToolContractValidationError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("enforces write preview/readback and replays an idempotent result", async () => {
    const key = "idem_registry_123456";
    const input = {
      schema_version: "2026-08-11.v1",
      write_context: {
        tenant_context: {
          tenant_id: "tenant_demo",
          actor_id: "actor_sales",
          actor_role: "sales",
          client_id: "client_demo",
          session_id: "session_demo",
        },
        idempotency_key: key,
        operation_mode: "preview",
        preview_ref: null,
        approval: {
          required: false,
          status: "not_required",
          approval_id: null,
        },
      },
    };
    const outcome = {
      status: "success" as const,
      data: {
        version: "quote.v1",
        operation: "quote.save_draft",
        operation_status: "previewed",
        record_id: null,
        preview_ref: "preview_registry_001",
        readback_evidence: null,
        idempotency_key: key,
        approval: {
          required: false,
          status: "not_required",
          approval_id: null,
        },
      },
    };
    const handler = vi.fn(() => outcome);
    const tool = registerPhaseOneTools(
      { "quote.save_draft": handler },
      {
        "quote.save_draft": {
          inputSchema: z.record(z.string(), z.unknown()),
          validateOutput: () => undefined,
        },
      },
    ).find((candidate) => candidate.name === "quote.save_draft");
    const idempotency = new MemoryIdempotencyRepository();

    const first = await executeRegisteredTool(tool!, input, writeContext, {
      requestId: "req_registry_001",
      auditId: "audit_registry_001",
      idempotencyRepository: idempotency,
    });
    const replay = await executeRegisteredTool(tool!, input, writeContext, {
      requestId: "req_registry_002",
      auditId: "audit_registry_002",
      idempotencyRepository: idempotency,
    });

    expect(replay).toEqual(first);
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(
      executeRegisteredTool(
        tool!,
        { ...input, changed: true },
        writeContext,
        {
          requestId: "req_registry_003",
          auditId: "audit_registry_003",
          idempotencyRepository: idempotency,
        },
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("rejects a committed write that lacks verified readback evidence", async () => {
    const key = "idem_registry_commit_123";
    const input = {
      write_context: {
        tenant_context: {
          tenant_id: "tenant_demo",
          actor_id: "actor_sales",
          actor_role: "sales",
          client_id: "client_demo",
          session_id: "session_demo",
        },
        idempotency_key: key,
        operation_mode: "commit",
        preview_ref: "preview_registry_002",
        approval: {
          required: true,
          status: "approved",
          approval_id: "approval_registry_001",
        },
      },
    };
    const tool = registerPhaseOneTools(
      {
        "quote.save_draft": () => ({
          status: "success" as const,
          data: {
            operation_status: "committed",
            preview_ref: "preview_registry_002",
            readback_evidence: null,
            idempotency_key: key,
          },
        }),
      },
      {
        "quote.save_draft": {
          inputSchema: z.record(z.string(), z.unknown()),
          validateOutput: () => undefined,
        },
      },
    ).find((candidate) => candidate.name === "quote.save_draft");

    await expect(
      executeRegisteredTool(tool!, input, writeContext, {
        requestId: "req_registry_004",
        auditId: "audit_registry_004",
        idempotencyRepository: new MemoryIdempotencyRepository(),
      }),
    ).rejects.toThrow(WriteContractError);
  });
});
