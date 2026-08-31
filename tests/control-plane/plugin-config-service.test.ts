import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";
import type {
  PluginConfigApplyObservation,
  PluginConfigApplyPort,
} from "../../src/logistics_mcp/control-plane/plugin-config-apply";
import {
  FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
  PLUGIN_CONFIG_SCHEMA_VERSION,
  type PluginConfigOperationResponse,
  type PluginConfigTypedValue,
} from "../../src/logistics_mcp/control-plane/plugin-config-contracts";
import {
  PluginConfigService,
  PluginConfigServiceFatalError,
} from "../../src/logistics_mcp/control-plane/plugin-config-service";
import {
  initializeSqlitePluginConfigState,
  SqlitePluginConfigStore,
} from "../../src/logistics_mcp/control-plane/plugin-config-store";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function context(actorId: string, tenantId = "tenant_fixture"): ExecutionContext {
  return {
    tenantId,
    actorId,
    role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin"],
    clientId: `client_${actorId}`,
    sessionId: `session_${actorId}`,
    expiresAt: 2_000_000_000,
  };
}

function changedValues(timeout = 18_000): readonly PluginConfigTypedValue[] {
  return FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES.map((value): PluginConfigTypedValue =>
    value.field_id === "request_timeout_ms" && value.kind === "integer"
      ? { ...value, value: timeout }
      : value,
  );
}

interface Harness {
  readonly store: SqlitePluginConfigStore;
  readonly service: PluginConfigService;
  readonly apply: ReturnType<typeof vi.fn<PluginConfigApplyPort["apply"]>>;
  readonly setReadback: (value: PluginConfigApplyObservation) => void;
  readonly setNow: (value: string) => void;
  readonly close: () => Promise<void>;
}

async function harness(
  initialObservation?: PluginConfigApplyObservation,
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "mcp-plugin-config-service-"));
  roots.push(root);
  const storeOptions = {
    applicationRoot: root,
    instanceId: "instance_fixture_001",
    managementTenantId: "tenant_fixture",
    clock: () => "2026-08-31T00:00:00.000Z",
  } as const;
  await initializeSqlitePluginConfigState(storeOptions);
  const store = new SqlitePluginConfigStore(storeOptions);
  let now = "2026-08-31T00:00:00.000Z";
  let counter = 0;
  let observed = initialObservation ?? {
    status: "readback_verified",
    release_id: null,
    revision: null,
    config_digest: null,
    module_generation: null,
    values: null,
    reason_code: null,
  };
  const apply = vi.fn<PluginConfigApplyPort["apply"]>((input) => Promise.resolve({
    ...observed,
    release_id: observed.release_id ?? input.release_id,
    revision: observed.revision ?? input.revision,
    config_digest: observed.config_digest ?? input.config_digest,
    module_generation: observed.module_generation ?? `generation_${input.revision}`,
    values: observed.values ?? input.values,
  }));
  const readback = vi.fn<NonNullable<PluginConfigApplyPort["readback"]>>((input) => Promise.resolve({
    ...observed,
    release_id: observed.release_id ?? input.release_id,
    revision: observed.revision ?? input.revision,
    config_digest: observed.config_digest ?? input.config_digest,
    module_generation: observed.module_generation ?? `generation_${input.revision}`,
    values: observed.values,
  }));
  const service = new PluginConfigService({
    store,
    applyPort: { apply, readback },
    managementTenantId: "tenant_fixture",
    ownerBootId: "boot_service_test",
    clock: () => now,
    idGenerator: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`,
  });
  return {
    store,
    service,
    apply,
    setReadback(value) {
      observed = value;
      now = "2026-08-31T00:05:00.000Z";
    },
    setNow(value) {
      now = value;
    },
    close: () => store.close(),
  };
}

function meta(id: string) {
  return {
    idempotency_key: `idempotency_${id}_0001`,
    request_id: `request_${id}_0001`,
    trace_id: `trace_${id}_0001`,
    audit_id: `audit_${id}_0001`,
  } as const;
}

function operationData<K extends NonNullable<PluginConfigOperationResponse["data"]>["kind"]>(
  response: PluginConfigOperationResponse,
  kind: K,
): Extract<NonNullable<PluginConfigOperationResponse["data"]>, { kind: K }> {
  expect(response.data).toMatchObject({ kind });
  return response.data as Extract<
    NonNullable<PluginConfigOperationResponse["data"]>,
    { kind: K }
  >;
}

async function approvedPreview(
  service: PluginConfigService,
  values = changedValues(),
): Promise<{ readonly previewRef: string; readonly approvalId: string }> {
  const applicant = context("actor_applicant");
  const approver = context("actor_approver");
  const validation = await service.validateDraft(applicant, {
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "freightcom-ltl",
    base_revision: 0,
    values,
  }, meta("validate"));
  expect(validation.status).toBe("success");
  const preview = await service.createPreview(applicant, {
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "freightcom-ltl",
    intent: "change",
    base_revision: 0,
    values,
  }, meta("preview"));
  const previewData = operationData(preview, "preview");
  const sameActor = await service.decideApproval(applicant, {
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "freightcom-ltl",
    preview_ref: previewData.preview_ref,
    decision: "approve",
    reason_code: "operator_approved",
  }, meta("same_actor"));
  expect(sameActor).toMatchObject({ status: "blocked", reason_codes: ["four_eyes_required"] });
  const approval = await service.decideApproval(approver, {
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "freightcom-ltl",
    preview_ref: previewData.preview_ref,
    decision: "approve",
    reason_code: "operator_approved",
  }, meta("approval"));
  const approvalData = operationData(approval, "approval");
  const duplicateApproval = await service.decideApproval(context("actor_backup_approver"), {
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "freightcom-ltl",
    preview_ref: previewData.preview_ref,
    decision: "approve",
    reason_code: "operator_approved",
  }, meta("duplicate_approval"));
  expect(duplicateApproval).toMatchObject({
    status: "blocked",
    reason_codes: ["approval_already_recorded"],
  });
  return { previewRef: previewData.preview_ref, approvalId: approvalData.approval_id };
}

describe("plugin configuration service", () => {
  it("serves a closed registry state and no-spec states without inventing fields", async () => {
    const runtime = await harness();
    try {
      const state = await runtime.service.getState(context("actor_applicant"));
      expect(state).toMatchObject({
        module_id: "freightcom-ltl",
        status: "success",
        current_revision: 0,
        current_values: FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
        allowed_actions: ["validate_draft", "create_preview"],
      });
      expect(state.config_spec).toMatchObject({
        production_eligible: false,
        manual_review: true,
      });
      const cargo = await runtime.service.getState(context("actor_applicant"), "cargo");
      expect(cargo).toEqual({
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        module_id: "cargo",
        status: "success",
        config_spec: null,
        current_revision: 0,
        current_config_digest: null,
        current_module_generation: null,
        current_values: [],
        current_readback: null,
        latest_validation: null,
        latest_preview: null,
        latest_approval: null,
        latest_release: null,
        allowed_actions: [],
        reason_codes: ["plugin_config_not_supported"],
        events: [],
        events_truncated: false,
      });
      await expect(runtime.service.getState(context("actor_applicant", "tenant_other")))
        .rejects.toThrow(/authorization/u);
    } finally {
      await runtime.close();
    }
  });

  it("enforces four-eyes, applies once, and advances only on exact readback", async () => {
    const runtime = await harness();
    try {
      const workflow = await approvedPreview(runtime.service);
      const publishInput = {
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        module_id: "freightcom-ltl",
        preview_ref: workflow.previewRef,
        approval_id: workflow.approvalId,
      } as const;
      const publishMeta = meta("publish");
      const published = await runtime.service.publish(
        context("actor_applicant"),
        publishInput,
        publishMeta,
      );
      expect(published.status).toBe("success");
      const release = operationData(published, "release");
      expect(release).toMatchObject({ revision: 1, release_state: "readback_verified" });
      expect(runtime.apply).toHaveBeenCalledTimes(1);
      expect(runtime.store.getCurrent()).toMatchObject({
        revision: 1,
        configDigest: release.config_digest,
        moduleGeneration: "generation_1",
      });
      expect(runtime.store.listUnfinishedAttempts()).toEqual([]);

      const replayed = await runtime.service.publish(
        context("actor_applicant"),
        publishInput,
        publishMeta,
      );
      expect(replayed).toMatchObject({ status: "success", replayed: true });
      expect(runtime.apply).toHaveBeenCalledTimes(1);

      const conflicting = await runtime.service.publish(
        context("actor_applicant"),
        { ...publishInput, approval_id: "approval_different" },
        publishMeta,
      );
      expect(conflicting).toMatchObject({
        status: "blocked",
        reason_codes: ["idempotency_conflict"],
      });
      expect(runtime.apply).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });

  it("withdraws publish from allowed actions when an approved preview expires", async () => {
    const runtime = await harness();
    try {
      const workflow = await approvedPreview(runtime.service);
      expect(await runtime.service.getState(context("actor_applicant"))).toMatchObject({
        allowed_actions: ["validate_draft", "create_preview", "publish"],
      });

      runtime.setNow("2026-08-31T00:15:00.000Z");
      expect(await runtime.service.getState(context("actor_applicant"))).toMatchObject({
        allowed_actions: ["validate_draft", "create_preview"],
      });
      expect(await runtime.service.publish(context("actor_applicant"), {
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        module_id: "freightcom-ltl",
        preview_ref: workflow.previewRef,
        approval_id: workflow.approvalId,
      }, meta("publish_expired"))).toMatchObject({
        status: "blocked",
        reason_codes: ["preview_expired"],
      });
      expect(runtime.apply).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("keeps mismatched apply in manual review and reconcile uses readback without reapply", async () => {
    const runtime = await harness({
      status: "mismatch",
      release_id: "wrong_release",
      revision: 99,
      config_digest: "mcp-plugin-config-hash/v1/config/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      module_generation: "wrong_generation",
      values: changedValues(19_000),
      reason_code: "readback_mismatch",
    });
    try {
      const workflow = await approvedPreview(runtime.service);
      const published = await runtime.service.publish(context("actor_applicant"), {
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        module_id: "freightcom-ltl",
        preview_ref: workflow.previewRef,
        approval_id: workflow.approvalId,
      }, meta("publish_mismatch"));
      expect(published).toMatchObject({
        status: "manual_review",
        reason_codes: ["readback_mismatch"],
      });
      const release = operationData(published, "release");
      expect(runtime.store.getCurrent().revision).toBe(0);
      expect(runtime.apply).toHaveBeenCalledTimes(1);

      const releaseRecord = runtime.store.getRelease(release.release_id);
      runtime.setReadback({
        status: "readback_verified",
        release_id: release.release_id,
        revision: release.revision,
        config_digest: release.config_digest,
        module_generation: "generation_reconciled_1",
        values: releaseRecord.values,
        reason_code: null,
      });
      const reconciled = await runtime.service.reconcile(context("actor_applicant"), {
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        module_id: "freightcom-ltl",
        release_id: release.release_id,
      }, meta("reconcile"));
      expect(reconciled.status).toBe("success");
      expect(runtime.store.getCurrent()).toMatchObject({
        revision: 1,
        moduleGeneration: "generation_reconciled_1",
      });
      expect(runtime.apply).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });

  it("trips fatal when runtime mutation succeeds but durable finalization fails", async () => {
    const runtime = await harness();
    try {
      const workflow = await approvedPreview(runtime.service);
      vi.spyOn(runtime.store, "finalizePublish").mockImplementation(() => {
        throw new Error("simulated durable failure");
      });
      await expect(runtime.service.publish(context("actor_applicant"), {
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        module_id: "freightcom-ltl",
        preview_ref: workflow.previewRef,
        approval_id: workflow.approvalId,
      }, meta("publish_fatal"))).rejects.toBeInstanceOf(PluginConfigServiceFatalError);
      expect(runtime.apply).toHaveBeenCalledTimes(1);
      expect(runtime.service.isFatal()).toBe(true);
      await expect(runtime.service.getState(context("actor_applicant")))
        .rejects.toBeInstanceOf(PluginConfigServiceFatalError);
    } finally {
      await runtime.close();
    }
  });
});
