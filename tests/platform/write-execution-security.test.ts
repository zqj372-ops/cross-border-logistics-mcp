import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  MemoryIdempotencyRepository,
  type IdempotencyRepository,
} from "../../src/logistics_mcp/platform/idempotency";
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
      preview_ref: "preview_security_001",
      readback_evidence:
        operationStatus === "previewed"
          ? null
          : { verified: true },
      idempotency_key: key,
      operation: tool,
    },
  };
}

const noApproval = {
  required: false,
  status: "not_required" as const,
  approval_id: null,
};

function previewInput(key: string) {
  return writeInput("quote.save_draft", "preview", noApproval, key);
}

type RegisteredTool = Parameters<typeof executeRegisteredToolWithResult>[0];

function run(
  tool: RegisteredTool,
  input: unknown,
  repository: IdempotencyRepository,
  label: string,
  signal?: AbortSignal,
) {
  return executeRegisteredToolWithResult(tool, input, writeContext, {
    requestId: `req_${label}`,
    auditId: `audit_${label}`,
    idempotencyRepository: repository,
    ...(signal === undefined ? {} : { signal }),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it.each(["needs_input", "manual_review", "blocked", "unavailable"] as const)(
    "releases a %s result so the same key can retry",
    async (status) => {
      const key = `idem_release_${status}_001`;
      const handler = vi.fn(() => ({
        status,
        data: null,
        blockers: [{
          code: `fixture.${status}`,
          message: "fixture result",
          severity: "error" as const,
        }],
      }));
      const tool = definition("quote.save_draft", handler);
      const input = previewInput(key);
      const repository = new MemoryIdempotencyRepository();

      const first = await run(tool, input, repository, `release_${status}_first`);
      const second = await run(tool, input, repository, `release_${status}_second`);

      expect(first.envelope.status).toBe(status);
      expect(second.envelope.status).toBe(status);
      expect(handler).toHaveBeenCalledTimes(2);
    },
  );

  it("releases after a handler throw so the same key can retry", async () => {
    const key = "idem_release_throw_001";
    let attempts = 0;
    const failure = new Error("handler failed");
    const handler = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) throw failure;
      return writeOutcome("quote.save_draft", key, "previewed");
    });
    const tool = definition("quote.save_draft", handler);
    const input = previewInput(key);
    const repository = new MemoryIdempotencyRepository();

    await expect(run(tool, input, repository, "release_throw_first")).rejects.toBe(failure);
    await expect(run(tool, input, repository, "release_throw_second"))
      .resolves.toMatchObject({ envelope: { status: "success" } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("releases after an aborted handler settles so the same key can retry", async () => {
    const key = "idem_release_abort_001";
    const controller = new AbortController();
    const entered = deferred();
    const continued = deferred();
    let attempts = 0;
    const handler = vi.fn(async (...args: Parameters<DomainToolHandler>) => {
      const signal = args[2];
      attempts += 1;
      if (attempts === 1) {
        entered.resolve();
        await continued.promise;
        signal?.throwIfAborted();
      }
      return writeOutcome("quote.save_draft", key, "previewed");
    });
    const tool = definition("quote.save_draft", handler);
    const input = previewInput(key);
    const repository = new MemoryIdempotencyRepository();

    const first = run(tool, input, repository, "release_abort_first", controller.signal);
    await entered.promise;
    controller.abort();
    continued.resolve();
    await expect(first).rejects.toThrow();

    await expect(run(tool, input, repository, "release_abort_second"))
      .resolves.toMatchObject({ envelope: { status: "success" } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("commits a success returned after the signal aborts during external recovery", async () => {
    const key = "idem_abort_recovered_success_001";
    const controller = new AbortController();
    const entered = deferred();
    const continued = deferred();
    const handler = vi.fn(async () => {
      entered.resolve();
      await continued.promise;
      return writeOutcome("quote.save_draft", key, "previewed");
    });
    const tool = definition("quote.save_draft", handler);
    const input = previewInput(key);
    const repository = new MemoryIdempotencyRepository();

    const first = run(tool, input, repository, "abort_recovered_first", controller.signal);
    await entered.promise;
    controller.abort();
    continued.resolve();

    await expect(first).resolves.toMatchObject({ envelope: { status: "success" } });
    await expect(run(tool, input, repository, "abort_recovered_replay"))
      .resolves.toMatchObject({ idempotencyOutcome: "replayed" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("releases after output validation fails so the same key can retry", async () => {
    const key = "idem_release_validation_001";
    let validationAttempts = 0;
    const handler = vi.fn(() => writeOutcome("quote.save_draft", key, "previewed"));
    const tool = definition("quote.save_draft", handler, () => {
      validationAttempts += 1;
      if (validationAttempts === 1) throw new Error("invalid output");
    });
    const input = previewInput(key);
    const repository = new MemoryIdempotencyRepository();

    await expect(run(tool, input, repository, "release_validation_first"))
      .rejects.toMatchObject({ code: "tool_contract_invalid" });
    await expect(run(tool, input, repository, "release_validation_second"))
      .resolves.toMatchObject({ envelope: { status: "success" } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("releases after commit fails so the same key can retry", async () => {
    const key = "idem_release_commit_001";
    const repository = new MemoryIdempotencyRepository();
    vi.spyOn(repository, "commit").mockRejectedValueOnce(new Error("commit failed"));
    const handler = vi.fn(() => writeOutcome("quote.save_draft", key, "previewed"));
    const tool = definition("quote.save_draft", handler);
    const input = previewInput(key);

    await expect(run(tool, input, repository, "release_commit_first"))
      .rejects.toThrow("commit failed");
    await expect(run(tool, input, repository, "release_commit_second"))
      .resolves.toMatchObject({ envelope: { status: "success" } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not report success when release itself fails", async () => {
    const key = "idem_release_failure_001";
    const repository = new MemoryIdempotencyRepository();
    const releaseFailure = new Error("release failed");
    vi.spyOn(repository, "release").mockRejectedValueOnce(releaseFailure);
    const tool = definition("quote.save_draft", () => ({
      status: "unavailable" as const,
      data: null,
      blockers: [{
        code: "fixture.unavailable",
        message: "fixture result",
        severity: "error" as const,
      }],
    }));
    const input = previewInput(key);

    await expect(run(tool, input, repository, "release_failure"))
      .rejects.toBe(releaseFailure);
  });

  it("runs only one handler for concurrent identical writes and does not replay a null reservation", async () => {
    const key = "idem_execution_concurrent_001";
    const released = deferred();
    const firstEntered = deferred();
    const handler = vi.fn(async () => {
      firstEntered.resolve();
      await released.promise;
      return writeOutcome("quote.save_draft", key, "previewed");
    });
    const tool = definition("quote.save_draft", handler);
    const input = previewInput(key);
    const repository = new MemoryIdempotencyRepository();

    const first = run(tool, input, repository, "execution_first");
    await firstEntered.promise;
    const second = run(tool, input, repository, "execution_second");
    released.resolve();

    await expect(second).rejects.toMatchObject({
      code: "idempotency.in_progress",
    });
    await expect(first).resolves.toMatchObject({ envelope: { status: "success" } });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
