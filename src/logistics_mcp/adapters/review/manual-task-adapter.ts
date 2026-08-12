import type { SourceRef } from "../../platform/envelope";
import { hashPayload } from "../../platform/idempotency";
import type { AdapterResult, ReviewAdapter } from "../ports";

export interface ManualTaskReadbackRecord {
  readonly task_id: string;
  readonly tenant_id: string;
  readonly version: string;
  readonly status: "pending" | "assigned" | "resolved" | "rejected";
  readonly source_ref: SourceRef;
}

export interface ManualTaskSource {
  createTask(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ManualTaskReadbackRecord>;
  readTask(
    taskId: string,
    tenantId: string,
    signal?: AbortSignal,
  ): Promise<ManualTaskReadbackRecord | null>;
}

export interface ManualTaskAdapterOptions {
  readonly source?: ManualTaskSource;
}

interface PreviewState {
  readonly requestHash: string;
  readonly tenantId: string;
  readonly previewRef: string;
}

interface CommitState {
  readonly requestHash: string;
  readonly result: AdapterResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value[key]) ? value[key] : null;
}

function notice(
  code: string,
  message: string,
  severity: "info" | "warning" | "error" = "error",
  field: string | null = null,
) {
  return { code, message, severity, field } as const;
}

function writeContext(input: Record<string, unknown>): Record<string, unknown> | null {
  return nestedRecord(input, "write_context");
}

function tenantId(input: Record<string, unknown>): string | null {
  return stringValue(nestedRecord(writeContext(input), "tenant_context")?.tenant_id);
}

function actorId(input: Record<string, unknown>): string | null {
  return stringValue(nestedRecord(writeContext(input), "tenant_context")?.actor_id);
}

function idempotencyKey(input: Record<string, unknown>): string | null {
  return stringValue(writeContext(input)?.idempotency_key);
}

function approval(input: Record<string, unknown>): Record<string, unknown> {
  return nestedRecord(writeContext(input), "approval") ?? {
    required: false,
    status: "not_required",
    approval_id: null,
  };
}

function writeResult(
  status: "previewed" | "committed" | "already_committed" | "rejected",
  input: Record<string, unknown>,
  previewRef: string,
  recordId: string | null,
  readback: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    version: "write-result@2026-08-11.v1",
    operation: "review.create_task",
    operation_status: status,
    record_id: recordId,
    preview_ref: previewRef,
    readback_evidence: readback,
    idempotency_key: idempotencyKey(input) ?? "invalid-idempotency-key",
    approval: approval(input),
  };
}

const ALLOWED_INPUT_KEYS = new Set([
  "schema_version",
  "version",
  "task_type",
  "priority",
  "reason_codes",
  "opaque_context_refs",
  "write_context",
]);

export class ManualTaskAdapter implements ReviewAdapter {
  private readonly source: ManualTaskSource | undefined;
  private readonly previews = new Map<string, PreviewState>();
  private readonly commits = new Map<string, CommitState>();

  constructor(options: ManualTaskAdapterOptions = {}) {
    this.source = options.source;
  }

  async previewTask(input: Record<string, unknown>): Promise<AdapterResult> {
    await Promise.resolve();
    const parsed = this.validateInput(input, "preview");
    if (parsed.error !== null) return parsed.error;
    if (this.source === undefined) return this.disabled(input);
    const requestHash = this.requestHash(input, parsed.tenant);
    const previewRef = `preview:review-task:${requestHash.slice(7, 23)}`;
    this.previews.set(previewRef, {
      requestHash,
      tenantId: parsed.tenant,
      previewRef,
    });
    return {
      status: "success",
      data: writeResult("previewed", input, previewRef, null, null),
      sourceRefs: [this.previewSourceRef(previewRef)],
      warnings: [
        notice(
          "review.preview_no_write",
          "Preview generated without creating an external review task.",
          "info",
        ),
      ],
    };
  }

  async commitTask(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AdapterResult> {
    const parsed = this.validateInput(input, "commit");
    if (parsed.error !== null) return parsed.error;
    if (this.source === undefined) return this.disabled(input);
    const previewRef = stringValue(parsed.context.preview_ref);
    if (previewRef === null) {
      return this.failure(input, "review.preview_required", "A preview reference is required before creating a task.");
    }
    const preview = this.previews.get(previewRef);
    if (preview === undefined || preview.tenantId !== parsed.tenant) {
      return this.failure(input, "review.preview_unknown", "The preview reference is not valid for this tenant.");
    }
    const requestHash = this.requestHash(input, parsed.tenant);
    if (requestHash !== preview.requestHash) {
      return this.failure(input, "review.preview_hash_mismatch", "The task payload does not match the preview.");
    }
    const approvalValue = approval(input);
    if (
      approvalValue.required === true &&
      (approvalValue.status !== "approved" || typeof approvalValue.approval_id !== "string")
    ) {
      return this.failure(input, "review.approval_required", "The review task commit is not approved.", "blocked");
    }
    const key = parsed.key;
    const mapKey = `${parsed.tenant}\u0000${key}`;
    const existing = this.commits.get(mapKey);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        return this.failure(input, "review.idempotency_conflict", "The idempotency key conflicts with another task request.");
      }
      const existingData = isRecord(existing.result.data)
        ? { ...existing.result.data, operation_status: "already_committed" }
        : existing.result.data;
      return { ...existing.result, data: existingData };
    }

    const activeSignal = signal ?? new AbortController().signal;
    activeSignal.throwIfAborted();
    const created = await this.source.createTask({
      task_type: input.task_type,
      priority: input.priority,
      reason_codes: input.reason_codes,
      opaque_context_refs: input.opaque_context_refs,
      tenant_id: parsed.tenant,
      actor_id: actorId(input),
      idempotency_key: parsed.key,
    }, activeSignal);
    const readback = await this.source.readTask(
      created.task_id,
      parsed.tenant,
      activeSignal,
    );
    if (
      readback === null ||
      readback.tenant_id !== parsed.tenant ||
      readback.task_id !== created.task_id ||
      readback.status !== "pending"
    ) {
      return this.failure(input, "review.readback_missing", "The review task write could not be verified by readback.");
    }
    const readbackEvidence = {
      target_system: "existing-quote-system",
      record_id: readback.task_id,
      observed_version: readback.version,
      observed_at: "2026-08-11T00:00:00Z",
      verified: true,
      source_ref_ids: [readback.source_ref.source_id],
    };
    const result: AdapterResult = {
      status: "success",
      data: writeResult("committed", input, previewRef, readback.task_id, readbackEvidence),
      sourceRefs: [created.source_ref, readback.source_ref],
      warnings: [
        notice(
          "review.pending",
          "The task is pending manual handling; no automatic resolution or rule promotion is performed.",
          "info",
        ),
      ],
      reviewStatus: "pending",
    };
    this.commits.set(mapKey, { requestHash, result });
    return result;
  }

  async readTask(input: Record<string, unknown>): Promise<AdapterResult> {
    if (this.source === undefined) return this.disabled(input);
    const taskId = stringValue(input.record_id);
    const tenant = stringValue(input.tenant_id);
    if (taskId === null || tenant === null) {
      return this.failure(input, "review.readback_input_required", "A tenant and task record ID are required.");
    }
    const readback = await this.source.readTask(taskId, tenant);
    if (readback === null) return this.failure(input, "review.readback_missing", "The review task was not found.");
    const syntheticInput = {
      write_context: {
        idempotency_key: "idem_readback_demo_123456",
        approval: { required: false, status: "not_required", approval_id: null },
      },
    };
    return {
      status: "success",
      data: writeResult(
        "committed",
        syntheticInput,
        `preview:review-read:${readback.task_id}`,
        readback.task_id,
        {
          target_system: "existing-quote-system",
          record_id: readback.task_id,
          observed_version: readback.version,
          observed_at: "2026-08-11T00:00:00Z",
          verified: readback.status === "pending",
          source_ref_ids: [readback.source_ref.source_id],
        },
      ),
      sourceRefs: [readback.source_ref],
    };
  }

  private validateInput(
    input: Record<string, unknown>,
    mode: "preview" | "commit",
  ):
    | {
        readonly error: AdapterResult;
        readonly tenant?: never;
        readonly key?: never;
        readonly context?: never;
      }
    | {
        readonly error: null;
        readonly tenant: string;
        readonly key: string;
        readonly context: Record<string, unknown>;
      } {
    const rawKeys = Object.keys(input).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
    if (rawKeys.length > 0) {
      return {
        error: this.failure(input, "review.raw_field_forbidden", "Raw customer or credential fields must be represented by opaque references.", "blocked"),
      };
    }
    const context = writeContext(input);
    const tenant = tenantId(input);
    const key = idempotencyKey(input);
    if (context === null || tenant === null || key === null) {
      return {
        error: this.failure(input, "review.write_context_required", "A write context and idempotency key are required."),
      };
    }
    if (context.operation_mode !== mode) {
      return {
        error: this.failure(input, "review.operation_mode_mismatch", "The write operation mode does not match the adapter method."),
      };
    }
    return { error: null, tenant, key, context };
  }

  private requestHash(input: Record<string, unknown>, tenant: string): string {
    return hashPayload({
      tenant_id: tenant,
      task_type: input.task_type,
      priority: input.priority,
      reason_codes: input.reason_codes,
      opaque_context_refs: input.opaque_context_refs,
    });
  }

  private previewSourceRef(previewRef: string): SourceRef {
    return {
      source_id: `src:review:preview:${previewRef.slice(-16)}`,
      source_type: "opaque_reference",
      system: "existing-quote-system",
      locator: `opaque://review-task/${previewRef.slice(-16)}`,
      version: "review-preview@2026-08-11.v1",
      retrieved_at: "2026-08-11T00:00:00Z",
      authority: "opaque",
      content_hash: null,
    };
  }

  private disabled(input: Record<string, unknown>): AdapterResult {
    return this.failure(
      input,
      "review.adapter_disabled",
      "The existing review-task endpoint is disabled until its route, tenant scope, and readback contract are verified.",
      "unavailable",
    );
  }

  private failure(
    input: Record<string, unknown>,
    code: string,
    message: string,
    status: "manual_review" | "blocked" | "unavailable" = "manual_review",
  ): AdapterResult {
    const previewRef = stringValue(writeContext(input)?.preview_ref) ?? `preview:review-rejected:${hashPayload(input).slice(7, 23)}`;
    return {
      status,
      data: writeResult("rejected", input, previewRef, null, null),
      sourceRefs: [],
      blockers: [notice(code, message)],
      reviewStatus: "manual_review",
    };
  }
}
