import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  configDigestForValues,
  FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
  PLUGIN_CONFIG_SCHEMA_VERSION,
  type PluginConfigOperationResponse,
} from "../../src/logistics_mcp/control-plane/plugin-config-contracts";
import {
  initializeSqlitePluginConfigState,
  pluginConfigPaths,
  PluginConfigStoreError,
  SqlitePluginConfigStore,
  storedPluginConfigValues,
  type PluginConfigApprovalRecord,
  type PluginConfigAttemptRecord,
  type PluginConfigPreviewRecord,
  type PluginConfigReleaseRecord,
} from "../../src/logistics_mcp/control-plane/plugin-config-store";

const roots: string[] = [];
const APPROVAL_PREVIEW_UNIQUE_INDEX = "config_approvals_preview_ref_unique";
const options = (applicationRoot: string) => ({
  applicationRoot,
  instanceId: "instance_fixture_001",
  managementTenantId: "tenant_fixture",
  clock: () => "2026-08-31T00:00:00.000Z",
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-plugin-config-store-"));
  roots.push(root);
  return root;
}

function errorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof PluginConfigStoreError ? error.code : "unexpected";
  }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("SQLite plugin configuration store", () => {
  it("requires explicit initialization and binds strict identity and permissions", async () => {
    const root = temporaryRoot();
    expect(errorCode(() => new SqlitePluginConfigStore(options(root)))).toBe("state_missing");

    await initializeSqlitePluginConfigState(options(root));
    const paths = pluginConfigPaths(root);
    expect(lstatSync(paths.stateDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.databasePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(paths.markerPath).mode & 0o777).toBe(0o400);
    const marker = JSON.parse(readFileSync(paths.markerPath, "utf8")) as Record<string, unknown>;
    expect(marker).toMatchObject({
      marker_format: "mcp-plugin-config-identity/v1",
      schema_version: 1,
      instance_id: "instance_fixture_001",
      management_tenant_id: "tenant_fixture",
      database_path: paths.databasePath,
    });

    const store = new SqlitePluginConfigStore(options(root));
    const current = store.getCurrent();
    expect(current.revision).toBe(0);
    expect(current.values).toEqual(FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES);
    expect(current.configDigest).toBe(configDigestForValues(FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES));
    expect(store.health()).toEqual({ ready: true, reason_codes: [] });
    await store.close();

    expect(() => initializeSqlitePluginConfigState(options(root))).toThrowError(
      expect.objectContaining({ code: "state_exists" }),
    );
    expect(errorCode(() => new SqlitePluginConfigStore({
      ...options(root),
      managementTenantId: "tenant_other",
    }))).toBe("identity_mismatch");

    chmodSync(paths.markerPath, 0o600);
    expect(errorCode(() => new SqlitePluginConfigStore(options(root)))).toBe("permission_mismatch");
  });

  it("adds the approval preview index when opening an existing schema", async () => {
    const root = temporaryRoot();
    await initializeSqlitePluginConfigState(options(root));
    const paths = pluginConfigPaths(root);
    const legacy = new DatabaseSync(paths.databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    legacy.exec(`DROP INDEX ${APPROVAL_PREVIEW_UNIQUE_INDEX}`);
    legacy.close();

    const reopened = new SqlitePluginConfigStore(options(root));
    await reopened.close();

    const checked = new DatabaseSync(paths.databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    const index = checked.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?",
    ).get(APPROVAL_PREVIEW_UNIQUE_INDEX) as { readonly name?: unknown } | undefined;
    expect(index?.name).toBe(APPROVAL_PREVIEW_UNIQUE_INDEX);
    const unique = checked.prepare(
      "PRAGMA index_list('config_approvals')",
    ).all() as Array<{ readonly name?: unknown; readonly unique?: unknown }>;
    expect(unique).toContainEqual(expect.objectContaining({
      name: APPROVAL_PREVIEW_UNIQUE_INDEX,
      unique: 1,
    }));
    expect(unique.filter((entry) => (
      entry.unique === 1 && entry.name !== APPROVAL_PREVIEW_UNIQUE_INDEX
    )).map((entry) => entry.name)).toEqual(["sqlite_autoindex_config_approvals_1"]);
    checked.close();
  });

  it("fails closed and rolls back index creation when a legacy schema has duplicate approvals", async () => {
    const root = temporaryRoot();
    await initializeSqlitePluginConfigState(options(root));
    const paths = pluginConfigPaths(root);
    const digest = configDigestForValues(FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES);
    const legacy = new DatabaseSync(paths.databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    legacy.exec(`DROP INDEX ${APPROVAL_PREVIEW_UNIQUE_INDEX}`);
    legacy.prepare(`
      INSERT INTO config_previews (
        preview_ref, intent, base_revision, target_release_id, config_digest,
        request_timeout_ms, poll_interval_ms, max_poll_attempts,
        egress_profile_id, credential_slot_id, changed_field_ids_json,
        expires_at, creator_actor_id, consumed, created_at
      ) VALUES (?, 'change', 0, NULL, ?, 20000, 750, 12,
        'freightcom_test_fixed', 'freightcom_test_credential', '[]', ?, ?, 0, ?)
    `).run(
      "preview_legacy_duplicate",
      digest,
      "2026-08-31T00:15:00.000Z",
      "actor_applicant",
      "2026-08-31T00:00:00.000Z",
    );
    const insertApproval = legacy.prepare(`
      INSERT INTO config_approvals (
        approval_id, preview_ref, decision, approver_actor_id, decided_at, reason_code
      ) VALUES (?, ?, 'approve', ?, ?, 'operator_approved')
    `);
    insertApproval.run(
      "approval_legacy_duplicate_001",
      "preview_legacy_duplicate",
      "actor_approver",
      "2026-08-31T00:01:00.000Z",
    );
    insertApproval.run(
      "approval_legacy_duplicate_002",
      "preview_legacy_duplicate",
      "actor_backup_approver",
      "2026-08-31T00:02:00.000Z",
    );
    legacy.close();

    expect(errorCode(() => new SqlitePluginConfigStore(options(root)))).toBe("schema_mismatch");

    const checked = new DatabaseSync(paths.databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    expect(checked.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?",
    ).get(APPROVAL_PREVIEW_UNIQUE_INDEX)).toBeUndefined();
    expect(checked.prepare(
      "SELECT COUNT(*) AS count FROM config_approvals WHERE preview_ref = ?",
    ).get("preview_legacy_duplicate")).toMatchObject({ count: 2 });
    checked.close();
  });

  it("persists the closed preview, approval, release and unfinished attempt without applying", async () => {
    const root = temporaryRoot();
    await initializeSqlitePluginConfigState(options(root));
    const store = new SqlitePluginConfigStore(options(root));
    const values = storedPluginConfigValues(FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES);
    const digest = configDigestForValues(values.values);
    const preview: PluginConfigPreviewRecord = {
      ...values,
      previewRef: "preview_config_store_001",
      intent: "change",
      baseRevision: 0,
      targetReleaseId: null,
      configDigest: digest,
      changedFieldIds: [],
      expiresAt: "2026-08-31T00:15:00.000Z",
      creatorActorId: "actor_applicant",
      consumed: false,
      createdAt: "2026-08-31T00:00:00.000Z",
    };
    const previewResponse: PluginConfigOperationResponse = {
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      action: "create_preview",
      request_id: "request_preview_store_001",
      status: "success",
      data: {
        kind: "preview",
        preview_ref: preview.previewRef,
        module_id: "freightcom-ltl",
        intent: "change",
        base_revision: 0,
        config_digest: digest,
        changed_field_ids: [],
        expires_at: preview.expiresAt,
        restart_policy: "controlled_restart",
      },
      reason_codes: [],
      replayed: false,
    };
    store.recordPreview(
      preview,
      {
        action: "create_preview",
        idempotencyKey: "idem_preview_store_001",
        requestHash: "mcp-plugin-config-hash/v1/request/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        resultId: preview.previewRef,
        createdAt: preview.createdAt,
      },
      previewResponse,
      {
        eventId: "event_preview_store_001",
        actorId: preview.creatorActorId,
        action: "create_preview",
        objectRef: preview.previewRef,
        status: "success",
        reasonCode: "preview_created",
        occurredAt: preview.createdAt,
      },
    );

    const approval: PluginConfigApprovalRecord = {
      approvalId: "approval_config_store_001",
      previewRef: preview.previewRef,
      decision: "approve",
      approverActorId: "actor_approver",
      decidedAt: "2026-08-31T00:01:00.000Z",
      reasonCode: "operator_approved",
    };
    const approvalResponse: PluginConfigOperationResponse = {
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      action: "decide_approval",
      request_id: "request_approval_store_001",
      status: "success",
      data: {
        kind: "approval",
        approval_id: approval.approvalId,
        preview_ref: approval.previewRef,
        decision: "approve",
        approver_actor_id: approval.approverActorId,
        decided_at: approval.decidedAt,
      },
      reason_codes: [],
      replayed: false,
    };
    store.recordApproval(
      approval,
      {
        action: "decide_approval",
        idempotencyKey: "idem_approval_store_001",
        requestHash: "mcp-plugin-config-hash/v1/request/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        resultId: approval.approvalId,
        createdAt: approval.decidedAt,
      },
      approvalResponse,
      {
        eventId: "event_approval_store_001",
        actorId: approval.approverActorId,
        action: "decide_approval",
        objectRef: approval.approvalId,
        status: "success",
        reasonCode: "approval_recorded",
        occurredAt: approval.decidedAt,
      },
    );
    expect(() => store.recordApproval(
      {
        ...approval,
        approvalId: "approval_config_store_duplicate",
        approverActorId: "actor_backup_approver",
        decidedAt: "2026-08-31T00:01:30.000Z",
      },
      {
        action: "decide_approval",
        idempotencyKey: "idem_approval_store_duplicate",
        requestHash: "mcp-plugin-config-hash/v1/request/sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        resultId: "approval_config_store_duplicate",
        createdAt: "2026-08-31T00:01:30.000Z",
      },
      {
        ...approvalResponse,
        request_id: "request_approval_store_duplicate",
        data: {
          kind: "approval",
          approval_id: "approval_config_store_duplicate",
          preview_ref: approval.previewRef,
          decision: "approve",
          approver_actor_id: "actor_backup_approver",
          decided_at: "2026-08-31T00:01:30.000Z",
        },
      },
      {
        eventId: "event_approval_store_duplicate",
        actorId: "actor_backup_approver",
        action: "decide_approval",
        objectRef: "approval_config_store_duplicate",
        status: "success",
        reasonCode: "approval_recorded",
        occurredAt: "2026-08-31T00:01:30.000Z",
      },
    )).toThrow();

    const release: PluginConfigReleaseRecord = {
      ...values,
      releaseId: "release_config_store_001",
      previewRef: preview.previewRef,
      approvalId: approval.approvalId,
      revision: 1,
      intent: "change",
      configDigest: digest,
      state: "published_pending_apply",
      publishedAt: "2026-08-31T00:02:00.000Z",
    };
    const attempt: PluginConfigAttemptRecord = {
      attemptId: "attempt_config_store_001",
      releaseId: release.releaseId,
      revision: 1,
      configDigest: digest,
      phase: "claimed",
      terminalStatus: null,
      reasonCode: null,
      ownerBootId: "boot_store_001",
      createdAt: release.publishedAt,
      finalizedAt: null,
    };
    expect(store.beginPublish({
      release,
      attempt,
      identity: {
        action: "publish",
        idempotencyKey: "idem_publish_store_001",
        requestHash: "mcp-plugin-config-hash/v1/request/sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        resultId: release.releaseId,
        createdAt: release.publishedAt,
      },
      event: {
        eventId: "event_publish_store_001",
        actorId: "actor_applicant",
        action: "publish",
        objectRef: release.releaseId,
        status: "published_pending_apply",
        reasonCode: "attempt_recorded",
        occurredAt: release.publishedAt,
      },
    })).toBeNull();
    expect(store.listUnfinishedAttempts()).toEqual([attempt]);
    await store.close();

    const reopened = new SqlitePluginConfigStore(options(root));
    expect(reopened.getPreview(preview.previewRef).consumed).toBe(true);
    expect(reopened.getApproval(approval.approvalId)).toEqual(approval);
    expect(reopened.getRelease(release.releaseId)).toEqual(release);
    expect(reopened.listUnfinishedAttempts()).toEqual([attempt]);
    const replay = reopened.getIdempotency(
      "publish",
      "idem_publish_store_001",
      "mcp-plugin-config-hash/v1/request/sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    expect(replay).toMatchObject({ resultId: release.releaseId, response: null });
    expect(errorCode(() => reopened.getIdempotency(
      "publish",
      "idem_publish_store_001",
      "mcp-plugin-config-hash/v1/request/sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    ))).toBe("idempotency_conflict");
    await reopened.close();
  });

  it("finalizes prior-boot attempts as unknown without a second apply", async () => {
    const root = temporaryRoot();
    await initializeSqlitePluginConfigState(options(root));
    const store = new SqlitePluginConfigStore(options(root));
    const values = storedPluginConfigValues(FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES);
    const digest = configDigestForValues(values.values);
    const preview: PluginConfigPreviewRecord = {
      ...values,
      previewRef: "preview_recovery_001",
      intent: "change",
      baseRevision: 0,
      targetReleaseId: null,
      configDigest: digest,
      changedFieldIds: [],
      expiresAt: "2026-08-31T00:15:00.000Z",
      creatorActorId: "actor_applicant",
      consumed: false,
      createdAt: "2026-08-31T00:00:00.000Z",
    };
    const previewResponse: PluginConfigOperationResponse = {
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      action: "create_preview",
      request_id: "request_recovery_preview_001",
      status: "success",
      data: {
        kind: "preview",
        preview_ref: preview.previewRef,
        module_id: "freightcom-ltl",
        intent: "change",
        base_revision: 0,
        config_digest: digest,
        changed_field_ids: [],
        expires_at: preview.expiresAt,
        restart_policy: "controlled_restart",
      },
      reason_codes: [],
      replayed: false,
    };
    store.recordPreview(preview, {
      action: "create_preview",
      idempotencyKey: "idem_recovery_preview_001",
      requestHash: "mcp-plugin-config-hash/v1/request/sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      resultId: preview.previewRef,
      createdAt: preview.createdAt,
    }, previewResponse, {
      eventId: "event_recovery_preview_001",
      actorId: preview.creatorActorId,
      action: "create_preview",
      objectRef: preview.previewRef,
      status: "success",
      reasonCode: "preview_created",
      occurredAt: preview.createdAt,
    });
    const approval: PluginConfigApprovalRecord = {
      approvalId: "approval_recovery_001",
      previewRef: preview.previewRef,
      decision: "approve",
      approverActorId: "actor_approver",
      decidedAt: "2026-08-31T00:01:00.000Z",
      reasonCode: "operator_approved",
    };
    const approvalResponse: PluginConfigOperationResponse = {
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      action: "decide_approval",
      request_id: "request_recovery_approval_001",
      status: "success",
      data: {
        kind: "approval",
        approval_id: approval.approvalId,
        preview_ref: approval.previewRef,
        decision: "approve",
        approver_actor_id: approval.approverActorId,
        decided_at: approval.decidedAt,
      },
      reason_codes: [],
      replayed: false,
    };
    store.recordApproval(approval, {
      action: "decide_approval",
      idempotencyKey: "idem_recovery_approval_001",
      requestHash: "mcp-plugin-config-hash/v1/request/sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      resultId: approval.approvalId,
      createdAt: approval.decidedAt,
    }, approvalResponse, {
      eventId: "event_recovery_approval_001",
      actorId: approval.approverActorId,
      action: "decide_approval",
      objectRef: approval.approvalId,
      status: "success",
      reasonCode: "approval_recorded",
      occurredAt: approval.decidedAt,
    });
    const release: PluginConfigReleaseRecord = {
      ...values,
      releaseId: "release_recovery_001",
      previewRef: preview.previewRef,
      approvalId: approval.approvalId,
      revision: 1,
      intent: "change",
      configDigest: digest,
      state: "published_pending_apply",
      publishedAt: "2026-08-31T00:02:00.000Z",
    };
    store.beginPublish({
      release,
      attempt: {
        attemptId: "attempt_recovery_001",
        releaseId: release.releaseId,
        revision: 1,
        configDigest: digest,
        phase: "claimed",
        terminalStatus: null,
        reasonCode: null,
        ownerBootId: "boot_before_crash",
        createdAt: release.publishedAt,
        finalizedAt: null,
      },
      identity: {
        action: "publish",
        idempotencyKey: "idem_recovery_publish_001",
        requestHash: "mcp-plugin-config-hash/v1/request/sha256:1111111111111111111111111111111111111111111111111111111111111111",
        resultId: release.releaseId,
        createdAt: release.publishedAt,
      },
      event: {
        eventId: "event_recovery_publish_001",
        actorId: "actor_applicant",
        action: "publish",
        objectRef: release.releaseId,
        status: "published_pending_apply",
        reasonCode: "attempt_recorded",
        occurredAt: release.publishedAt,
      },
    });

    store.finalizeInterruptedAttempt(
      "attempt_recovery_001",
      "readback_recovery_001",
      "2026-08-31T00:03:00.000Z",
      {
        eventId: "event_recovery_finalized_001",
        actorId: "system_recovery",
        action: "recover_attempt",
        objectRef: "attempt_recovery_001",
        status: "manual_review",
        reasonCode: "readback_interrupted",
        occurredAt: "2026-08-31T00:03:00.000Z",
      },
    );
    expect(store.listUnfinishedAttempts()).toEqual([]);
    expect(store.getRelease(release.releaseId).state).toBe("manual_review");
    expect(store.getCurrent().revision).toBe(0);
    expect(store.getSnapshot().latestReadback).toMatchObject({
      releaseId: release.releaseId,
      status: "unknown",
      reasonCode: "readback_interrupted",
    });
    await store.close();
  });
});
