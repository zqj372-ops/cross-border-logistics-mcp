import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ExecutionContext } from "../platform/context";
import type {
  PluginConfigApplyObservation,
  PluginConfigApplyPort,
} from "./plugin-config-apply";
import {
  configDigestForValues,
  freightcomLtlConfigSpec,
  freezePluginConfigOutput,
  PLUGIN_CONFIG_SCHEMA_VERSION,
  pluginConfigApprovalRequestSchema,
  pluginConfigCreatePreviewRequestSchema,
  pluginConfigOperationResponseSchema,
  pluginConfigPublishRequestSchema,
  pluginConfigReconcileRequestSchema,
  pluginConfigRequestHash,
  pluginConfigStateSchema,
  pluginConfigValidateDraftRequestSchema,
  pluginConfigWriteMetaSchema,
  snapshotPluginConfigInput,
  validatePluginConfigValues,
  type PluginConfigApprovalRequest,
  type PluginConfigCreatePreviewRequest,
  type PluginConfigModuleId,
  type PluginConfigOperationResponse,
  type PluginConfigPublishRequest,
  type PluginConfigReconcileRequest,
  type PluginConfigState,
  type PluginConfigTypedValue,
  type PluginConfigValidateDraftRequest,
  type PluginConfigWriteMeta,
} from "./plugin-config-contracts";
import {
  PluginConfigStoreError,
  storedPluginConfigValues,
  type PluginConfigAttemptRecord,
  type PluginConfigEventRecord,
  type PluginConfigFinalization,
  type PluginConfigIdempotencyRecord,
  type PluginConfigPreviewRecord,
  type PluginConfigReadbackRecord,
  type PluginConfigReleaseRecord,
  type PluginConfigWriteIdentity,
  type SqlitePluginConfigStore,
} from "./plugin-config-store";

export interface PluginConfigServiceOptions {
  readonly store: SqlitePluginConfigStore;
  readonly applyPort: PluginConfigApplyPort;
  readonly managementTenantId: string;
  readonly previewTtlSeconds?: number;
  readonly ownerBootId?: string;
  readonly clock?: () => string;
  readonly idGenerator?: (prefix: string) => string;
}

export class PluginConfigServiceFatalError extends Error {
  constructor(options: ErrorOptions = {}) {
    super("plugin_config_runtime_fatal", options);
    this.name = "PluginConfigServiceFatalError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type OperationAction =
  | "validate_draft"
  | "create_preview"
  | "decide_approval"
  | "publish"
  | "reconcile";

function actionResponse(
  action: OperationAction,
  requestId: string,
  status: PluginConfigOperationResponse["status"],
  data: PluginConfigOperationResponse["data"],
  reasonCodes: readonly string[],
  replayed = false,
): PluginConfigOperationResponse {
  return freezePluginConfigOutput(pluginConfigOperationResponseSchema.parse({
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    action,
    request_id: requestId,
    status,
    data,
    reason_codes: reasonCodes,
    replayed,
  }));
}

function unsupportedState(moduleId: Exclude<PluginConfigModuleId, "freightcom-ltl">): PluginConfigState {
  return freezePluginConfigOutput(pluginConfigStateSchema.parse({
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: moduleId,
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
  }));
}

function summaryReadback(record: PluginConfigReadbackRecord | null): unknown {
  if (record === null) return null;
  return {
    readback_id: record.readbackId,
    release_id: record.releaseId,
    revision: record.revision,
    config_digest: record.configDigest,
    module_generation: record.moduleGeneration,
    status: record.status,
    checked_at: record.checkedAt,
  };
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function changedFieldIds(
  current: readonly PluginConfigTypedValue[],
  desired: readonly PluginConfigTypedValue[],
): readonly string[] {
  const currentById = new Map(current.map((value) => [value.field_id, value]));
  return Object.freeze(desired
    .filter((value) => !isDeepStrictEqual(currentById.get(value.field_id), value))
    .map((value) => value.field_id)
    .sort());
}

function observationReason(observation: PluginConfigApplyObservation): string {
  return observation.reason_code ?? (
    observation.status === "readback_verified"
      ? "readback_verified"
      : observation.status === "mismatch"
        ? "readback_mismatch"
        : observation.status === "blocked"
          ? "apply_blocked"
          : observation.status === "unavailable"
            ? "apply_unavailable"
            : "readback_unknown"
  );
}

function exactObservation(
  release: PluginConfigReleaseRecord,
  observation: PluginConfigApplyObservation,
): boolean {
  return (
    observation.status === "readback_verified" &&
    observation.reason_code === null &&
    observation.release_id === release.releaseId &&
    observation.revision === release.revision &&
    observation.config_digest === release.configDigest &&
    typeof observation.module_generation === "string" &&
    observation.module_generation.length > 0 &&
    observation.values !== null &&
    isDeepStrictEqual(
      [...observation.values].sort((left, right) => left.field_id.localeCompare(right.field_id)),
      [...release.values].sort((left, right) => left.field_id.localeCompare(right.field_id)),
    )
  );
}

function readbackStatus(
  observation: PluginConfigApplyObservation,
): PluginConfigReadbackRecord["status"] {
  if (observation.status === "readback_verified") return "verified";
  if (observation.status === "mismatch") return "mismatch";
  return "unknown";
}

function responseStatus(
  observation: PluginConfigApplyObservation,
  exact: boolean,
): PluginConfigOperationResponse["status"] {
  if (exact) return "success";
  if (observation.status === "blocked") return "blocked";
  if (observation.status === "unavailable") return "unavailable";
  return "manual_review";
}

function releaseState(
  observation: PluginConfigApplyObservation,
  exact: boolean,
): PluginConfigReleaseRecord["state"] {
  if (exact) return "readback_verified";
  if (observation.status === "blocked") return "blocked";
  if (observation.status === "unavailable") return "unavailable";
  return "manual_review";
}

function validContext(context: ExecutionContext, managementTenantId: string): boolean {
  return (
    context.tenantId === managementTenantId &&
    context.role === "admin" &&
    context.roles.includes("admin") &&
    context.scopes.includes("platform:admin")
  );
}

export class PluginConfigService {
  readonly #store: SqlitePluginConfigStore;
  readonly #applyPort: PluginConfigApplyPort;
  readonly #managementTenantId: string;
  readonly #previewTtlSeconds: number;
  readonly #ownerBootId: string;
  readonly #clock: () => string;
  readonly #idGenerator: (prefix: string) => string;
  #tail: Promise<void> = Promise.resolve();
  #fatal = false;

  constructor(options: PluginConfigServiceOptions) {
    const previewTtlSeconds = options.previewTtlSeconds ?? 15 * 60;
    if (!Number.isSafeInteger(previewTtlSeconds) || previewTtlSeconds < 60 || previewTtlSeconds > 3600) {
      throw new TypeError("previewTtlSeconds must be between 60 and 3600 seconds.");
    }
    if (options.store.managementTenantId !== options.managementTenantId) {
      throw new TypeError("Plugin config store tenant does not match the service tenant.");
    }
    this.#store = options.store;
    this.#applyPort = options.applyPort;
    this.#managementTenantId = options.managementTenantId;
    this.#previewTtlSeconds = previewTtlSeconds;
    this.#ownerBootId = options.ownerBootId ?? id("boot_config");
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#idGenerator = options.idGenerator ?? id;
  }

  isFatal(): boolean {
    return this.#fatal;
  }

  async recoverInterruptedAttempts(): Promise<void> {
    return this.#exclusive(() => {
      for (const attempt of this.#store.listUnfinishedAttempts()) {
        const checkedAt = this.#now();
        this.#store.finalizeInterruptedAttempt(
          attempt.attemptId,
          this.#idGenerator("readback_recovery"),
          checkedAt,
          this.#event(
            "system_recovery",
            "recover_attempt",
            attempt.attemptId,
            "manual_review",
            "readback_interrupted",
            checkedAt,
          ),
        );
      }
      if (this.#store.listUnfinishedAttempts().length > 0) {
        throw new Error("Plugin config recovery left unfinished apply attempts.");
      }
    });
  }

  async getState(
    context: ExecutionContext,
    moduleId: PluginConfigModuleId = "freightcom-ltl",
  ): Promise<PluginConfigState> {
    await this.#tail;
    if (!validContext(context, this.#managementTenantId)) {
      throw new Error("plugin_config_authorization_failed");
    }
    if (moduleId !== "freightcom-ltl") return unsupportedState(moduleId);
    if (this.#fatal) throw new PluginConfigServiceFatalError();
    const snapshot = this.#store.getSnapshot();
    const latestRelease = snapshot.latestRelease;
    const latestReadback = snapshot.latestReadback;
    const releaseNeedsReview = latestRelease !== null && [
      "manual_review", "blocked", "unavailable", "published_pending_apply", "applying", "restarting",
    ].includes(latestRelease.state);
    const reasonCodes = releaseNeedsReview
      ? Object.freeze([latestReadback?.reasonCode ?? "release_not_verified"])
      : Object.freeze([] as string[]);
    const allowedActions = ["validate_draft", "create_preview"];
    const now = Date.parse(this.#now());
    if (
      snapshot.latestPreview !== null &&
      !snapshot.latestPreview.consumed &&
      Date.parse(snapshot.latestPreview.expiresAt) > now &&
      snapshot.latestPreview.creatorActorId !== context.actorId &&
      snapshot.latestApproval?.previewRef !== snapshot.latestPreview.previewRef
    ) allowedActions.push("approve");
    if (
      snapshot.latestPreview !== null &&
      snapshot.latestApproval?.previewRef === snapshot.latestPreview.previewRef &&
      snapshot.latestApproval.decision === "approve" &&
      !snapshot.latestPreview.consumed &&
      Date.parse(snapshot.latestPreview.expiresAt) > now &&
      snapshot.latestPreview.baseRevision === snapshot.current.revision
    ) allowedActions.push("publish");
    if (latestRelease !== null) allowedActions.push("reconcile");
    const currentReadback = latestReadback?.releaseId === snapshot.current.activeReleaseId
      ? latestReadback
      : null;
    const state = {
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      module_id: "freightcom-ltl",
      status: releaseNeedsReview ? "manual_review" : "success",
      config_spec: freightcomLtlConfigSpec,
      current_revision: snapshot.current.revision,
      current_config_digest: snapshot.current.configDigest,
      current_module_generation: snapshot.current.moduleGeneration,
      current_values: snapshot.current.values,
      current_readback: summaryReadback(currentReadback),
      latest_validation: snapshot.latestValidation === null
        ? null
        : {
            validation_id: snapshot.latestValidation.validationId,
            base_revision: snapshot.latestValidation.baseRevision,
            config_digest: snapshot.latestValidation.configDigest,
            validation_status: snapshot.latestValidation.validationStatus,
            created_at: snapshot.latestValidation.createdAt,
          },
      latest_preview: snapshot.latestPreview === null
        ? null
        : {
            preview_ref: snapshot.latestPreview.previewRef,
            intent: snapshot.latestPreview.intent,
            base_revision: snapshot.latestPreview.baseRevision,
            config_digest: snapshot.latestPreview.configDigest,
            changed_field_ids: snapshot.latestPreview.changedFieldIds,
            expires_at: snapshot.latestPreview.expiresAt,
            creator_actor_id: snapshot.latestPreview.creatorActorId,
            consumed: snapshot.latestPreview.consumed,
          },
      latest_approval: snapshot.latestApproval === null
        ? null
        : {
            approval_id: snapshot.latestApproval.approvalId,
            preview_ref: snapshot.latestApproval.previewRef,
            decision: snapshot.latestApproval.decision,
            approver_actor_id: snapshot.latestApproval.approverActorId,
            decided_at: snapshot.latestApproval.decidedAt,
            reason_code: snapshot.latestApproval.reasonCode,
          },
      latest_release: latestRelease === null
        ? null
        : {
            release_id: latestRelease.releaseId,
            revision: latestRelease.revision,
            intent: latestRelease.intent,
            config_digest: latestRelease.configDigest,
            state: latestRelease.state,
            published_at: latestRelease.publishedAt,
          },
      allowed_actions: Object.freeze(allowedActions),
      reason_codes: reasonCodes,
      events: snapshot.events.map((event) => ({
        sequence: event.sequence,
        event_id: event.eventId,
        action: event.action,
        object_ref: event.objectRef,
        status: event.status,
        occurred_at: event.occurredAt,
      })),
      events_truncated: snapshot.eventsTruncated,
    };
    return freezePluginConfigOutput(pluginConfigStateSchema.parse(state));
  }

  async validateDraft(
    context: ExecutionContext,
    input: PluginConfigValidateDraftRequest,
    meta: PluginConfigWriteMeta,
  ): Promise<PluginConfigOperationResponse> {
    return this.#exclusive(() => {
      const parsed = pluginConfigValidateDraftRequestSchema.parse(snapshotPluginConfigInput(input));
      const writeMeta = pluginConfigWriteMetaSchema.parse(snapshotPluginConfigInput(meta));
      const denied = this.#writeDenied("validate_draft", context, writeMeta.request_id);
      if (denied !== null) return denied;
      if (parsed.module_id !== "freightcom-ltl") {
        return actionResponse("validate_draft", writeMeta.request_id, "blocked", null, ["plugin_config_not_supported"]);
      }
      const requestHash = pluginConfigRequestHash("validate_draft", context.actorId, parsed);
      const replay = this.#replay("validate_draft", writeMeta, requestHash);
      if (replay !== null) return replay;
      const current = this.#store.getCurrent();
      if (parsed.base_revision !== current.revision) {
        return actionResponse("validate_draft", writeMeta.request_id, "blocked", null, ["base_revision_stale"]);
      }
      let values: readonly PluginConfigTypedValue[];
      try {
        values = validatePluginConfigValues(parsed.values);
      } catch {
        return actionResponse("validate_draft", writeMeta.request_id, "blocked", null, ["config_values_invalid"]);
      }
      const stored = storedPluginConfigValues(values);
      const configDigest = configDigestForValues(stored.values);
      const validationId = this.#idGenerator("validation_config");
      const now = this.#now();
      const response = actionResponse("validate_draft", writeMeta.request_id, "success", {
        kind: "validation",
        validation_id: validationId,
        module_id: "freightcom-ltl",
        base_revision: current.revision,
        config_digest: configDigest,
        values: stored.values,
        restart_policy: "controlled_restart",
        validation_status: "validated",
      }, []);
      this.#store.recordValidation({
        ...stored,
        validationId,
        actorId: context.actorId,
        baseRevision: current.revision,
        configDigest,
        validationStatus: "validated",
        createdAt: now,
      }, this.#identity("validate_draft", writeMeta, requestHash, validationId, now), response,
      this.#event(context.actorId, "validate_draft", validationId, "success", "config_validated", now));
      return response;
    });
  }

  async createPreview(
    context: ExecutionContext,
    input: PluginConfigCreatePreviewRequest,
    meta: PluginConfigWriteMeta,
  ): Promise<PluginConfigOperationResponse> {
    return this.#exclusive(() => {
      const parsed = pluginConfigCreatePreviewRequestSchema.parse(snapshotPluginConfigInput(input));
      const writeMeta = pluginConfigWriteMetaSchema.parse(snapshotPluginConfigInput(meta));
      const denied = this.#writeDenied("create_preview", context, writeMeta.request_id);
      if (denied !== null) return denied;
      if (parsed.module_id !== "freightcom-ltl") {
        return actionResponse("create_preview", writeMeta.request_id, "blocked", null, ["plugin_config_not_supported"]);
      }
      const requestHash = pluginConfigRequestHash("create_preview", context.actorId, parsed);
      const replay = this.#replay("create_preview", writeMeta, requestHash);
      if (replay !== null) return replay;
      const current = this.#store.getCurrent();
      let values: readonly PluginConfigTypedValue[];
      let baseRevision: number;
      let targetReleaseId: string | null;
      if (parsed.intent === "change") {
        if (parsed.base_revision !== current.revision) {
          return actionResponse("create_preview", writeMeta.request_id, "blocked", null, ["base_revision_stale"]);
        }
        try {
          values = validatePluginConfigValues(parsed.values);
        } catch {
          return actionResponse("create_preview", writeMeta.request_id, "blocked", null, ["config_values_invalid"]);
        }
        baseRevision = parsed.base_revision;
        targetReleaseId = null;
      } else {
        let target: PluginConfigReleaseRecord;
        try {
          target = this.#store.getRelease(parsed.target_release_id);
        } catch {
          return actionResponse("create_preview", writeMeta.request_id, "blocked", null, ["rollback_target_not_found"]);
        }
        if (target.state !== "readback_verified") {
          return actionResponse("create_preview", writeMeta.request_id, "blocked", null, ["rollback_target_not_verified"]);
        }
        values = target.values;
        baseRevision = current.revision;
        targetReleaseId = target.releaseId;
      }
      const stored = storedPluginConfigValues(values);
      const configDigest = configDigestForValues(stored.values);
      const previewRef = this.#idGenerator("preview_config");
      const now = this.#now();
      const expiresAt = new Date(Date.parse(now) + this.#previewTtlSeconds * 1000).toISOString();
      const changed = changedFieldIds(current.values, stored.values);
      const record: PluginConfigPreviewRecord = {
        ...stored,
        previewRef,
        intent: parsed.intent,
        baseRevision,
        targetReleaseId,
        configDigest,
        changedFieldIds: changed,
        expiresAt,
        creatorActorId: context.actorId,
        consumed: false,
        createdAt: now,
      };
      const response = actionResponse("create_preview", writeMeta.request_id, "success", {
        kind: "preview",
        preview_ref: previewRef,
        module_id: "freightcom-ltl",
        intent: parsed.intent,
        base_revision: baseRevision,
        config_digest: configDigest,
        changed_field_ids: changed,
        expires_at: expiresAt,
        restart_policy: "controlled_restart",
      }, []);
      this.#store.recordPreview(
        record,
        this.#identity("create_preview", writeMeta, requestHash, previewRef, now),
        response,
        this.#event(context.actorId, "create_preview", previewRef, "success", "preview_created", now),
      );
      return response;
    });
  }

  async decideApproval(
    context: ExecutionContext,
    input: PluginConfigApprovalRequest,
    meta: PluginConfigWriteMeta,
  ): Promise<PluginConfigOperationResponse> {
    return this.#exclusive(() => {
      const parsed = pluginConfigApprovalRequestSchema.parse(snapshotPluginConfigInput(input));
      const writeMeta = pluginConfigWriteMetaSchema.parse(snapshotPluginConfigInput(meta));
      const denied = this.#writeDenied("decide_approval", context, writeMeta.request_id);
      if (denied !== null) return denied;
      if (parsed.module_id !== "freightcom-ltl") {
        return actionResponse("decide_approval", writeMeta.request_id, "blocked", null, ["plugin_config_not_supported"]);
      }
      const requestHash = pluginConfigRequestHash("decide_approval", context.actorId, parsed);
      const replay = this.#replay("decide_approval", writeMeta, requestHash);
      if (replay !== null) return replay;
      let preview: PluginConfigPreviewRecord;
      try {
        preview = this.#store.getPreview(parsed.preview_ref);
      } catch {
        return actionResponse("decide_approval", writeMeta.request_id, "blocked", null, ["preview_not_found"]);
      }
      if (preview.consumed) {
        return actionResponse("decide_approval", writeMeta.request_id, "blocked", null, ["preview_consumed"]);
      }
      if (Date.parse(preview.expiresAt) <= Date.parse(this.#now())) {
        return actionResponse("decide_approval", writeMeta.request_id, "blocked", null, ["preview_expired"]);
      }
      if (preview.creatorActorId === context.actorId) {
        return actionResponse("decide_approval", writeMeta.request_id, "blocked", null, ["four_eyes_required"]);
      }
      if (preview.baseRevision !== this.#store.getCurrent().revision) {
        return actionResponse("decide_approval", writeMeta.request_id, "blocked", null, ["base_revision_stale"]);
      }
      if (this.#store.getSnapshot().latestApproval?.previewRef === preview.previewRef) {
        return actionResponse("decide_approval", writeMeta.request_id, "blocked", null, ["approval_already_recorded"]);
      }
      const approvalId = this.#idGenerator("approval_config");
      const now = this.#now();
      const response = actionResponse("decide_approval", writeMeta.request_id, "success", {
        kind: "approval",
        approval_id: approvalId,
        preview_ref: preview.previewRef,
        decision: parsed.decision,
        approver_actor_id: context.actorId,
        decided_at: now,
      }, []);
      this.#store.recordApproval({
        approvalId,
        previewRef: preview.previewRef,
        decision: parsed.decision,
        approverActorId: context.actorId,
        decidedAt: now,
        reasonCode: parsed.reason_code,
      }, this.#identity("decide_approval", writeMeta, requestHash, approvalId, now), response,
      this.#event(context.actorId, "decide_approval", approvalId, "success", "approval_recorded", now));
      return response;
    });
  }

  async publish(
    context: ExecutionContext,
    input: PluginConfigPublishRequest,
    meta: PluginConfigWriteMeta,
  ): Promise<PluginConfigOperationResponse> {
    return this.#exclusive(async () => {
      const parsed = pluginConfigPublishRequestSchema.parse(snapshotPluginConfigInput(input));
      const writeMeta = pluginConfigWriteMetaSchema.parse(snapshotPluginConfigInput(meta));
      const denied = this.#writeDenied("publish", context, writeMeta.request_id);
      if (denied !== null) return denied;
      if (parsed.module_id !== "freightcom-ltl") {
        return actionResponse("publish", writeMeta.request_id, "blocked", null, ["plugin_config_not_supported"]);
      }
      const requestHash = pluginConfigRequestHash("publish", context.actorId, parsed);
      const replay = this.#replay("publish", writeMeta, requestHash);
      if (replay !== null) return replay;
      let preview: PluginConfigPreviewRecord;
      try {
        preview = this.#store.getPreview(parsed.preview_ref);
      } catch {
        return actionResponse("publish", writeMeta.request_id, "blocked", null, ["preview_not_found"]);
      }
      if (preview.consumed || Date.parse(preview.expiresAt) <= Date.parse(this.#now())) {
        return actionResponse("publish", writeMeta.request_id, "blocked", null, [preview.consumed ? "preview_consumed" : "preview_expired"]);
      }
      let approval;
      try {
        approval = this.#store.getApproval(parsed.approval_id);
      } catch {
        return actionResponse("publish", writeMeta.request_id, "blocked", null, ["approval_not_found"]);
      }
      if (
        approval.previewRef !== preview.previewRef ||
        approval.decision !== "approve" ||
        approval.approverActorId === preview.creatorActorId
      ) {
        return actionResponse("publish", writeMeta.request_id, "blocked", null, ["approval_invalid"]);
      }
      const current = this.#store.getCurrent();
      if (preview.baseRevision !== current.revision) {
        return actionResponse("publish", writeMeta.request_id, "blocked", null, ["base_revision_stale"]);
      }
      const now = this.#now();
      const release: PluginConfigReleaseRecord = {
        ...storedPluginConfigValues(preview.values),
        releaseId: this.#idGenerator("release_config"),
        previewRef: preview.previewRef,
        approvalId: approval.approvalId,
        revision: current.revision + 1,
        intent: preview.intent,
        configDigest: preview.configDigest,
        state: "published_pending_apply",
        publishedAt: now,
      };
      const attempt: PluginConfigAttemptRecord = {
        attemptId: this.#idGenerator("attempt_config"),
        releaseId: release.releaseId,
        revision: release.revision,
        configDigest: release.configDigest,
        phase: "claimed",
        terminalStatus: null,
        reasonCode: null,
        ownerBootId: this.#ownerBootId,
        createdAt: now,
        finalizedAt: null,
      };
      const identity = this.#identity("publish", writeMeta, requestHash, release.releaseId, now);
      const existing = this.#store.beginPublish({
        release,
        attempt,
        identity,
        event: this.#event(context.actorId, "publish", release.releaseId, "published_pending_apply", "attempt_recorded", now),
      });
      if (existing !== null) return this.#pendingOrReplay(existing, writeMeta.request_id);

      let observation: PluginConfigApplyObservation;
      try {
        observation = await this.#applyPort.apply({
          module_id: "freightcom-ltl",
          release_id: release.releaseId,
          revision: release.revision,
          config_digest: release.configDigest,
          values: release.values,
          restart_policy: "controlled_restart",
        });
      } catch {
        observation = {
          status: "unavailable",
          release_id: null,
          revision: null,
          config_digest: null,
          module_generation: null,
          values: null,
          reason_code: "apply_unavailable",
        };
      }
      return this.#finalizeApply(context.actorId, release, attempt, writeMeta.request_id, observation);
    });
  }

  async reconcile(
    context: ExecutionContext,
    input: PluginConfigReconcileRequest,
    meta: PluginConfigWriteMeta,
  ): Promise<PluginConfigOperationResponse> {
    return this.#exclusive(async () => {
      const parsed = pluginConfigReconcileRequestSchema.parse(snapshotPluginConfigInput(input));
      const writeMeta = pluginConfigWriteMetaSchema.parse(snapshotPluginConfigInput(meta));
      const denied = this.#writeDenied("reconcile", context, writeMeta.request_id);
      if (denied !== null) return denied;
      if (parsed.module_id !== "freightcom-ltl") {
        return actionResponse("reconcile", writeMeta.request_id, "blocked", null, ["plugin_config_not_supported"]);
      }
      const requestHash = pluginConfigRequestHash("reconcile", context.actorId, parsed);
      const replay = this.#replay("reconcile", writeMeta, requestHash);
      if (replay !== null) return replay;
      let release: PluginConfigReleaseRecord;
      let attempt: PluginConfigAttemptRecord;
      try {
        release = this.#store.getRelease(parsed.release_id);
        attempt = this.#store.getLatestAttemptForRelease(parsed.release_id);
      } catch {
        return actionResponse("reconcile", writeMeta.request_id, "blocked", null, ["release_not_found"]);
      }
      let observation: PluginConfigApplyObservation;
      if (this.#applyPort.readback === undefined) {
        observation = {
          status: "unavailable",
          release_id: null,
          revision: null,
          config_digest: null,
          module_generation: null,
          values: null,
          reason_code: "readback_unavailable",
        };
      } else {
        try {
          observation = await this.#applyPort.readback({
            module_id: "freightcom-ltl",
            release_id: release.releaseId,
            revision: release.revision,
            config_digest: release.configDigest,
          });
        } catch {
          observation = {
            status: "unavailable",
            release_id: null,
            revision: null,
            config_digest: null,
            module_generation: null,
            values: null,
            reason_code: "readback_unavailable",
          };
        }
      }
      const exact = exactObservation(release, observation);
      const checkedAt = this.#now();
      const reason = observationReason(observation);
      const readback: PluginConfigReadbackRecord = {
        readbackId: this.#idGenerator("readback_config"),
        attemptId: attempt.attemptId,
        releaseId: release.releaseId,
        revision: release.revision,
        configDigest: release.configDigest,
        moduleGeneration: observation.module_generation,
        status: readbackStatus(observation),
        reasonCode: exact ? null : reason,
        checkedAt,
      };
      const response = actionResponse(
        "reconcile",
        writeMeta.request_id,
        responseStatus(observation, exact),
        {
          kind: "reconciliation",
          release_id: release.releaseId,
          revision: release.revision,
          status: exact ? "readback_verified" : observation.status,
          readback: summaryReadback(readback) as never,
        },
        exact ? [] : [reason],
      );
      this.#store.recordReconciliation(
        release,
        readback,
        this.#identity("reconcile", writeMeta, requestHash, readback.readbackId, checkedAt),
        response,
        exact,
        this.#event(context.actorId, "reconcile", release.releaseId, exact ? "success" : "manual_review", exact ? "readback_verified" : reason, checkedAt),
      );
      return response;
    });
  }

  #finalizeApply(
    actorId: string,
    release: PluginConfigReleaseRecord,
    attempt: PluginConfigAttemptRecord,
    requestId: string,
    observation: PluginConfigApplyObservation,
  ): PluginConfigOperationResponse {
    const exact = exactObservation(release, observation);
    const checkedAt = this.#now();
    const reason = observationReason(observation);
    const readback: PluginConfigReadbackRecord = {
      readbackId: this.#idGenerator("readback_config"),
      attemptId: attempt.attemptId,
      releaseId: release.releaseId,
      revision: release.revision,
      configDigest: release.configDigest,
      moduleGeneration: observation.module_generation,
      status: readbackStatus(observation),
      reasonCode: exact ? null : reason,
      checkedAt,
    };
    const response = actionResponse(
      "publish",
      requestId,
      responseStatus(observation, exact),
      {
        kind: "release",
        release_id: release.releaseId,
        revision: release.revision,
        config_digest: release.configDigest,
        release_state: releaseState(observation, exact),
        readback: summaryReadback(readback) as never,
      },
      exact ? [] : [reason],
    );
    const finalization: PluginConfigFinalization = {
      releaseId: release.releaseId,
      attemptId: attempt.attemptId,
      releaseState: releaseState(observation, exact),
      terminalStatus: exact ? "readback_verified" : observation.status,
      reasonCode: exact ? "readback_verified" : reason,
      finalizedAt: checkedAt,
      readback,
      activateCurrent: exact,
      response,
      event: this.#event(
        actorId,
        "finalize_publish",
        release.releaseId,
        exact ? "success" : response.status,
        exact ? "readback_verified" : reason,
        checkedAt,
      ),
    };
    try {
      this.#store.finalizePublish(finalization);
    } catch (error) {
      this.#fatal = true;
      throw new PluginConfigServiceFatalError({ cause: error });
    }
    return response;
  }

  #writeDenied(
    action: OperationAction,
    context: ExecutionContext,
    requestId: string,
  ): PluginConfigOperationResponse | null {
    if (this.#fatal) throw new PluginConfigServiceFatalError();
    return validContext(context, this.#managementTenantId)
      ? null
      : actionResponse(action, requestId, "blocked", null, ["plugin_config_authorization_failed"]);
  }

  #replay(
    action: OperationAction,
    meta: PluginConfigWriteMeta,
    requestHash: string,
  ): PluginConfigOperationResponse | null {
    let record: PluginConfigIdempotencyRecord | null;
    try {
      record = this.#store.getIdempotency(action, meta.idempotency_key, requestHash);
    } catch (error) {
      if (error instanceof PluginConfigStoreError && error.code === "idempotency_conflict") {
        return actionResponse(action, meta.request_id, "blocked", null, ["idempotency_conflict"]);
      }
      throw error;
    }
    if (record === null) return null;
    return this.#pendingOrReplay(record, meta.request_id);
  }

  #pendingOrReplay(
    record: PluginConfigIdempotencyRecord,
    requestId: string,
  ): PluginConfigOperationResponse {
    if (record.response !== null) {
      return freezePluginConfigOutput({ ...record.response, request_id: requestId, replayed: true });
    }
    let release: PluginConfigReleaseRecord | null = null;
    try {
      release = this.#store.getRelease(record.resultId);
    } catch {
      // Keep a fixed, non-sensitive response.
    }
    return actionResponse(
      "publish",
      requestId,
      "manual_review",
      release === null
        ? null
        : {
            kind: "release",
            release_id: release.releaseId,
            revision: release.revision,
            config_digest: release.configDigest,
            release_state: release.state,
            readback: null,
          },
      ["apply_attempt_pending"],
      true,
    );
  }

  #identity(
    action: OperationAction,
    meta: PluginConfigWriteMeta,
    requestHash: string,
    resultId: string,
    createdAt: string,
  ): PluginConfigWriteIdentity {
    return Object.freeze({
      action,
      idempotencyKey: meta.idempotency_key,
      requestHash,
      resultId,
      createdAt,
    });
  }

  #event(
    actorId: string,
    action: string,
    objectRef: string,
    status: string,
    reasonCode: string,
    occurredAt: string,
  ): Omit<PluginConfigEventRecord, "sequence"> {
    return Object.freeze({
      eventId: this.#idGenerator("event_config"),
      actorId,
      action,
      objectRef,
      status,
      reasonCode,
      occurredAt,
    });
  }

  #now(): string {
    const value = this.#clock();
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new Error("Plugin config clock returned an invalid timestamp.");
    return new Date(time).toISOString();
  }

  #exclusive<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const execute = async (): Promise<T> => await operation();
    const run = this.#tail.then(execute, execute);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
