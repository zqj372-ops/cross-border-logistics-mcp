import { describe, expect, it, vi } from "vitest";

import {
  ManualTaskAdapter,
  type ManualTaskReadbackRecord,
  type ManualTaskSource,
} from "../../src/logistics_mcp/adapters/review/manual-task-adapter";

const opaqueRef = {
  ref_id: "opaque-review-demo-001",
  kind: "raw_input" as const,
  purpose: "synthetic review context",
  expires_at: null,
};

function taskInput(
  mode: "preview" | "commit",
  previewRef: string | null = null,
  key = "idem_demo_review_12345678",
) {
  return {
    schema_version: "2026-08-11.v1",
    version: "review-request@fixture-1",
    task_type: "quote",
    priority: "high",
    reason_codes: ["quote.zone_conflict"],
    opaque_context_refs: [opaqueRef],
    write_context: {
      tenant_context: {
        tenant_id: "tenant_demo",
        actor_id: "actor_sales",
        actor_role: "sales",
        client_id: "client_demo",
        session_id: "session_demo",
      },
      idempotency_key: key,
      operation_mode: mode,
      preview_ref: previewRef,
      approval: { required: false, status: "not_required", approval_id: null },
    },
  };
}

function readback(): ManualTaskReadbackRecord {
  return {
    task_id: "review-task-demo-001",
    tenant_id: "tenant_demo",
    version: "manual-quote-task@1",
    status: "pending",
    source_ref: {
      source_id: "src:review:readback:fixture",
      source_type: "fixture",
      system: "existing-quote-system",
      locator: "fixture://existing-quote/manual-quote-tasks/review-task-demo-001",
      version: "manual-quote-task@1",
      retrieved_at: "2026-08-11T00:00:00Z",
      authority: "authoritative",
      content_hash: "sha256:review-readback-1",
    },
  };
}

function createSource() {
  let captured: Record<string, unknown> | null = null;
  const createTask = vi.fn((input: Record<string, unknown>) => {
    captured = input;
    return Promise.resolve(readback());
  });
  const readTask = vi.fn((): Promise<ManualTaskReadbackRecord | null> => Promise.resolve(readback()));
  const source: ManualTaskSource = { createTask, readTask };
  return { source, createTask, readTask, captured: () => captured };
}

describe("manual review task adapter", () => {
  it("keeps the production review boundary disabled without an injected source", async () => {
    const result = await new ManualTaskAdapter().previewTask(taskInput("preview"));

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map((item) => item.code)).toContain("review.adapter_disabled");
  });

  it("previews without creating an external task", async () => {
    const { source, createTask, readTask } = createSource();
    const adapter = new ManualTaskAdapter({ source });

    const result = await adapter.previewTask(taskInput("preview"));

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      operation: "review.create_task",
      operation_status: "previewed",
      record_id: null,
      readback_evidence: null,
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(readTask).not.toHaveBeenCalled();
  });

  it("commits once, reads back the pending task, and replays the same ID", async () => {
    const { source, createTask, readTask } = createSource();
    const adapter = new ManualTaskAdapter({ source });
    const preview = await adapter.previewTask(taskInput("preview"));
    const previewRef = String(preview.data && preview.data.preview_ref);

    const first = await adapter.commitTask(taskInput("commit", previewRef));
    const replay = await adapter.commitTask(taskInput("commit", previewRef));

    expect(first.status).toBe("success");
    expect(first.data).toMatchObject({
      operation_status: "committed",
      record_id: "review-task-demo-001",
      readback_evidence: { verified: true },
    });
    expect(replay.data).toMatchObject({
      operation_status: "already_committed",
      record_id: "review-task-demo-001",
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: "idem_demo_review_12345678" }),
      expect.any(AbortSignal),
    );
    expect(readTask).toHaveBeenCalledTimes(1);
  });

  it("rejects a different request hash for a reused idempotency key", async () => {
    const { source, createTask } = createSource();
    const adapter = new ManualTaskAdapter({ source });
    const preview = await adapter.previewTask(taskInput("preview"));
    const previewRef = String(preview.data && preview.data.preview_ref);
    await adapter.commitTask(taskInput("commit", previewRef));

    const conflict = await adapter.commitTask({
      ...taskInput("commit", previewRef),
      reason_codes: ["customs.source_unavailable"],
    });

    expect(conflict.status).toBe("manual_review");
    expect(conflict.blockers?.map((item) => item.code)).toContain("review.preview_hash_mismatch");
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("requires approval before creating a review task", async () => {
    const { source, createTask } = createSource();
    const adapter = new ManualTaskAdapter({ source });
    const preview = await adapter.previewTask(taskInput("preview"));
    const result = await adapter.commitTask({
      ...taskInput("commit", String(preview.data && preview.data.preview_ref)),
      write_context: {
        ...taskInput("commit", String(preview.data && preview.data.preview_ref)).write_context,
        approval: { required: true, status: "pending", approval_id: null },
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.blockers?.map((item) => item.code)).toContain("review.approval_required");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("does not cross the upstream task boundary after cancellation", async () => {
    const { source, createTask } = createSource();
    const adapter = new ManualTaskAdapter({ source });
    const preview = await adapter.previewTask(taskInput("preview"));
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.commitTask(
      taskInput("commit", String(preview.data && preview.data.preview_ref)),
      controller.signal,
    )).rejects.toThrow();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("does not report success when task readback is missing", async () => {
    const { source, readTask } = createSource();
    readTask.mockResolvedValueOnce(null);
    const adapter = new ManualTaskAdapter({ source });
    const preview = await adapter.previewTask(taskInput("preview"));

    const result = await adapter.commitTask(
      taskInput("commit", String(preview.data && preview.data.preview_ref)),
    );

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({ operation_status: "rejected", readback_evidence: null });
    expect(result.blockers?.map((item) => item.code)).toContain("review.readback_missing");
  });

  it("accepts opaque context refs but never forwards raw address or credential fields", async () => {
    const { source, createTask, captured } = createSource();
    const adapter = new ManualTaskAdapter({ source });
    const preview = await adapter.previewTask(taskInput("preview"));

    const result = await adapter.commitTask({
      ...taskInput("commit", String(preview.data && preview.data.preview_ref)),
      full_address: "fixture-address-input",
      password: "fixture-password-input",
    });

    expect(result.status).toBe("blocked");
    expect(createTask).not.toHaveBeenCalled();
    expect(captured()).toBeNull();
    expect(JSON.stringify(result)).not.toContain("fixture-address-input");
    expect(JSON.stringify(result)).not.toContain("fixture-password-input");
  });
});
