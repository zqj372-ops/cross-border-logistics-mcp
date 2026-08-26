import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";

import type { ExecutionContext } from "../platform/context";
import { isTrustedExecutionContext } from "../platform/context";
import { canonicalControlHash } from "./canonical-control-hash";
import {
  assertControlProducerEnvelope,
  approvalRequestSchema,
  controlEnvelopeSchema,
  CONTROL_STATE_MAX_MODULES,
  deploymentPreviewRequestSchema,
  publishRequestSchema,
  reconcileRequestSchema,
  registerPackageRequestSchema,
  type ApprovalRequest,
  type ControlEnvelope,
  type ControlProducerAction,
  type DeepFrozen,
  type DeploymentPreviewRequest,
  type PublishRequest,
  type ReconcileRequest,
  type RegisterPackageRequest,
} from "./contracts";
import {
  createActivationGate,
  type ActivationAuthorityDriver,
  type ActivationRecoveryDriver,
} from "./activation-authority-internal";
import {
  createRuntimeMutationCoordinator,
  RuntimeMutationFatalError,
  type RuntimeMutationCoordinator,
} from "./runtime-mutation-coordinator";
import {
  isRequestHash,
  isPreviewHash,
  ModuleControlRepositoryError,
  type CanonicalRequestHash,
  type ControlFinalResult,
  type CreatePreviewRequestMetadata,
  type DecideApprovalRequestMetadata,
  type DeepReadonly,
  type DomainCommittedModuleControlIdempotencyRecord,
  type ModuleControlRepository,
  type ModuleControlReadbackAttemptRepository,
  type ModuleControlRef,
  type ModuleApprovalRecord,
  type ModulePreviewRecord,
  type ModuleReadbackRecord,
  type ModuleRegistrationRecord,
  type ModuleReleaseRecord,
  type PublishReleaseRequestMetadata,
  type ReadbackAttemptRecord,
  type ReadbackAttemptObservation,
  type ReadbackFinalizationResult,
  type RegisterModuleRequestMetadata,
} from "./repository";
import type { ModuleControlState } from "./repository";
import {
  addRfc3339Milliseconds,
  compareRfc3339Instants,
  parseRfc3339Instant,
} from "./rfc3339-instant";
import { IDENTIFIER_PATTERN } from "./lexical-contracts";
import { mapControlStateToDto } from "./control-state-mapper";
import {
  ADMIN_CONTROL_SCHEMA_VERSION,
  type ActiveModuleRef,
  type ModuleActivationSnapshot,
  type TrustedModuleInventory,
} from "./types";
import { ModuleControlServiceError, type ModuleControlServiceErrorCode } from "./errors";

const AUTH_FAILURE_REQUEST_ID = "control_auth_denied";
const AUTH_FAILURE_TRACE_ID = "control_auth_denied";
const AUTH_FAILURE_AUDIT_ID = "control_auth_denied";

export interface ModuleControlService {
  getState(context: ExecutionContext): Promise<DeepFrozen<ControlEnvelope>>;
  registerPackage(
    context: ExecutionContext,
    request: RegisterPackageRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
  createDeploymentPreview(
    context: ExecutionContext,
    request: DeploymentPreviewRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
  decideApproval(
    context: ExecutionContext,
    request: ApprovalRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
  publish(
    context: ExecutionContext,
    request: PublishRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
  reconcile(
    context: ExecutionContext,
    request: ReconcileRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
}

export interface WriteMeta {
  readonly idempotencyKey: string;
  readonly requestHash: CanonicalRequestHash;
  readonly requestId: string;
  readonly traceId: string;
  readonly auditId: string;
}

export interface ModuleControlRuntimeAssemblyOptions {
  readonly inventory: TrustedModuleInventory;
  readonly repository: ModuleControlRepository;
  readonly managementTenantId: string;
  readonly previewTtlSeconds: number;
  readonly clock: () => string;
  readonly idGenerator: () => string;
  readonly ownerBootId?: string;
  readonly activationRestoreEvidence?: unknown;
}

export interface ActivationReadFacade {
  readonly snapshot: () => ModuleActivationSnapshot;
}

export interface ControlledDispatchFacade {
  readonly dispatch: <T>(
    ref: ActiveModuleRef,
    handler: () => Promise<T> | T,
  ) => Promise<T>;
}

export interface ModuleControlRuntimeAssembly {
  readonly service: ModuleControlService;
  readonly activation: ActivationReadFacade;
  readonly dispatch: ControlledDispatchFacade;
}

interface PrivateRuntimeCapabilities {
  readonly coordinator: RuntimeMutationCoordinator;
  readonly privateDriver: ActivationAuthorityDriver;
  readonly recoveryDriver: ActivationRecoveryDriver;
  readonly activationSnapshot: () => ModuleActivationSnapshot;
  readonly ownerBootId: string;
}

interface ActivationDispatchGate extends ActivationReadFacade {
  readonly isActive: (ref: ActiveModuleRef) => boolean;
}

const WRITE_META_KEYS = [
  "idempotencyKey",
  "requestHash",
  "requestId",
  "traceId",
  "auditId",
] as const;
const REGISTER_REQUEST_KEYS = [
  "schema_version",
  "module_id",
  "version",
  "descriptor_digest",
] as const;
const APPROVAL_REQUEST_KEYS = [
  "schema_version",
  "preview_ref",
  "decision",
  "reason_code",
] as const;
const PUBLISH_REQUEST_KEYS = [
  "schema_version",
  "preview_ref",
  "approval_id",
] as const;
const RECONCILE_REQUEST_KEYS = ["schema_version", "release_id"] as const;

const PREVIEW_POLICY_VERSION = "writable-module-control-plane-v1" as const;
const PREVIEW_CHANGE_KEYS = [
  "schema_version",
  "intent",
  "desired_modules",
] as const;
const PREVIEW_ROLLBACK_KEYS = [
  "schema_version",
  "intent",
  "target_release_id",
] as const;
const PREVIEW_MODULE_KEYS = [
  "module_id",
  "version",
  "descriptor_digest",
] as const;
const PREVIEW_MAX_DESIRED_MODULES = CONTROL_STATE_MAX_MODULES;

type ChangeDeploymentPreviewRequest = Extract<
  DeploymentPreviewRequest,
  { intent: "change" }
>;

function assertPreviewTtlSeconds(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError("previewTtlSeconds must be a positive safe integer.");
  }
}

function snapshotPreviewRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }

  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotPreviewModule(value: unknown): Record<string, unknown> | null {
  const snapshot = snapshotPreviewRecord(value, PREVIEW_MODULE_KEYS);
  if (
    snapshot === null ||
    typeof snapshot.module_id !== "string" ||
    typeof snapshot.version !== "string" ||
    typeof snapshot.descriptor_digest !== "string"
  ) {
    return null;
  }
  return snapshot;
}

function snapshotPreviewDesiredModules(value: unknown): unknown[] | null {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return null;
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > PREVIEW_MAX_DESIRED_MODULES
  ) {
    return null;
  }

  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) {
    return null;
  }
  for (let index = 0; index < length; index += 1) {
    if (!ownKeys.includes(String(index))) return null;
  }

  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return null;
    }
    const module = snapshotPreviewModule(descriptor.value);
    if (module === null) return null;
    result.push(module);
  }
  return result;
}

function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function parseWriteMeta(value: unknown): WriteMeta {
  const snapshot = snapshotExactRecord(value, WRITE_META_KEYS);
  if (
    snapshot === null ||
    typeof snapshot.idempotencyKey !== "string" ||
    !IDENTIFIER_PATTERN.test(snapshot.idempotencyKey) ||
    !isRequestHash(snapshot.requestHash) ||
    typeof snapshot.requestId !== "string" ||
    !IDENTIFIER_PATTERN.test(snapshot.requestId) ||
    typeof snapshot.traceId !== "string" ||
    !IDENTIFIER_PATTERN.test(snapshot.traceId) ||
    typeof snapshot.auditId !== "string" ||
    !IDENTIFIER_PATTERN.test(snapshot.auditId)
  ) {
    throw new ModuleControlServiceError("write_meta_invalid");
  }
  return Object.freeze({
    idempotencyKey: snapshot.idempotencyKey,
    requestHash: snapshot.requestHash,
    requestId: snapshot.requestId,
    traceId: snapshot.traceId,
    auditId: snapshot.auditId,
  });
}

function parseRegisterRequest(value: unknown): RegisterPackageRequest | null {
  const snapshot = snapshotExactRecord(value, REGISTER_REQUEST_KEYS);
  if (snapshot === null) return null;
  const parsed = registerPackageRequestSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : null;
}

function parseApprovalRequest(value: unknown): ApprovalRequest | null {
  const snapshot = snapshotExactRecord(value, APPROVAL_REQUEST_KEYS);
  if (snapshot === null) return null;
  const parsed = approvalRequestSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : null;
}

function parsePublishRequest(value: unknown): PublishRequest | null {
  const snapshot = snapshotExactRecord(value, PUBLISH_REQUEST_KEYS);
  if (snapshot === null) return null;
  const parsed = publishRequestSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : null;
}

function parseReconcileRequest(value: unknown): ReconcileRequest | null {
  const snapshot = snapshotExactRecord(value, RECONCILE_REQUEST_KEYS);
  if (snapshot === null) return null;
  const parsed = reconcileRequestSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : null;
}

function parseDeploymentPreviewRequest(
  value: unknown,
): DeploymentPreviewRequest | null {
  const changeSnapshot = snapshotPreviewRecord(value, PREVIEW_CHANGE_KEYS);
  if (
    changeSnapshot !== null &&
    typeof changeSnapshot.schema_version === "string" &&
    changeSnapshot.intent === "change"
  ) {
    const desiredModules = snapshotPreviewDesiredModules(
      changeSnapshot.desired_modules,
    );
    if (desiredModules === null) return null;
    const parsed = deploymentPreviewRequestSchema.safeParse({
      schema_version: changeSnapshot.schema_version,
      intent: changeSnapshot.intent,
      desired_modules: desiredModules,
    });
    return parsed.success ? parsed.data : null;
  }

  const rollbackSnapshot = snapshotPreviewRecord(value, PREVIEW_ROLLBACK_KEYS);
  if (
    rollbackSnapshot !== null &&
    typeof rollbackSnapshot.schema_version === "string" &&
    rollbackSnapshot.intent === "rollback" &&
    typeof rollbackSnapshot.target_release_id === "string"
  ) {
    const parsed = deploymentPreviewRequestSchema.safeParse({
      schema_version: rollbackSnapshot.schema_version,
      intent: rollbackSnapshot.intent,
      target_release_id: rollbackSnapshot.target_release_id,
    });
    return parsed.success ? parsed.data : null;
  }
  return null;
}

function moduleRefKey(ref: ModuleControlRef): string {
  return `${ref.moduleId}\u0000${ref.version}\u0000${ref.descriptorDigest}`;
}

function moduleLogicalKey(ref: ModuleControlRef): string {
  return `${ref.moduleId}\u0000${ref.version}`;
}

function compareModuleRefs(
  left: ModuleControlRef,
  right: ModuleControlRef,
): number {
  const leftKey = moduleRefKey(left);
  const rightKey = moduleRefKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function sortedModuleRefs(
  refs: readonly ModuleControlRef[],
): readonly ModuleControlRef[] {
  return Object.freeze(
    refs
      .map((ref) =>
        Object.freeze({
          moduleId: ref.moduleId,
          version: ref.version,
          descriptorDigest: ref.descriptorDigest,
        }),
      )
      .sort(compareModuleRefs),
  );
}

function moduleRefSetsEqual(
  left: readonly ModuleControlRef[],
  right: readonly ModuleControlRef[],
): boolean {
  const leftKeys = left.map(moduleRefKey).sort();
  const rightKeys = right.map(moduleRefKey).sort();
  return (
    leftKeys.length === rightKeys.length &&
    new Set(leftKeys).size === leftKeys.length &&
    new Set(rightKeys).size === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function moduleRefsMatchEnvelope(
  records: readonly ModuleControlRef[],
  envelopeRefs: readonly {
    readonly module_id: string;
    readonly version: string;
    readonly descriptor_digest: string;
  }[],
): boolean {
  return (
    records.length === envelopeRefs.length &&
    records.every(
      (record, index) =>
        record.moduleId === envelopeRefs[index]?.module_id &&
        record.version === envelopeRefs[index]?.version &&
        record.descriptorDigest === envelopeRefs[index]?.descriptor_digest,
    )
  );
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function replayedPreviewMatchesEnvelope(
  preview: ModulePreviewRecord,
  envelope: DeepFrozen<ControlEnvelope>,
  managementTenantId: string,
  actorRef: string,
  previewRef: string,
): boolean {
  const data = envelope.data;
  if (envelope.status !== "success" || data?.kind !== "preview") return false;
  const recomputed = recomputePersistedPreviewHash(preview);
  const targetMatches =
    preview.intent === "change"
      ? data?.intent === "change" && data.target_release_id === null
      : data?.intent === "rollback" &&
        data.target_release_id === preview.targetReleaseId;
  return (
    recomputed !== null &&
    preview.canonicalHash === recomputed &&
    data.canonical_hash === recomputed &&
    data.preview_ref === previewRef &&
    preview.managementTenantId === managementTenantId &&
    preview.previewRef === previewRef &&
    targetMatches &&
    data.canonical_hash === preview.canonicalHash &&
    data.base_release_id === preview.baseReleaseId &&
    data.base_revision === preview.baseRevision &&
    data.creator_actor_ref === actorRef &&
    preview.creatorActorRef === actorRef &&
    data.created_at === preview.createdAt &&
    data.expires_at === preview.expiresAt &&
    data.consumed === preview.consumed &&
    data.desired_modules !== undefined &&
    moduleRefsMatchEnvelope(preview.desiredModules, data.desired_modules) &&
    data.diff !== undefined &&
    moduleRefsMatchEnvelope(preview.diff.added, data.diff.added) &&
    moduleRefsMatchEnvelope(preview.diff.removed, data.diff.removed) &&
    moduleRefsMatchEnvelope(preview.diff.retained, data.diff.retained) &&
    data.validation !== undefined &&
    data.validation.base_matches === preview.validation.baseMatches &&
    data.validation.desired_modules_valid ===
      preview.validation.desiredModulesValid &&
    data.validation.inventory_matches === preview.validation.inventoryMatches &&
    data.validation.minimum_active_modules ===
      preview.validation.minimumActiveModules &&
    stringArraysEqual(
      preview.validation.reasonCodes,
      data.validation.reason_codes,
    )
  );
}

function inventoryModuleRef(entry: TrustedModuleInventory[number]): ModuleControlRef {
  return {
    moduleId: entry.moduleId,
    version: entry.version,
    descriptorDigest: entry.descriptorDigest,
  };
}

function requestModuleRef(
  ref: ChangeDeploymentPreviewRequest["desired_modules"][number],
): ModuleControlRef {
  return {
    moduleId: ref.module_id,
    version: ref.version,
    descriptorDigest: ref.descriptor_digest as ModuleControlRef["descriptorDigest"],
  };
}

function hashModuleRef(ref: ModuleControlRef) {
  return {
    module_id: ref.moduleId,
    version: ref.version,
    descriptor_digest: ref.descriptorDigest,
  };
}

function recomputePersistedPreviewHash(
  preview: ModulePreviewRecord,
): string | null {
  try {
    const createdAt = parseRfc3339Instant(preview.createdAt);
    const expiresAt = parseRfc3339Instant(preview.expiresAt);
    if (createdAt === null || expiresAt === null) return null;

    const ttlNanoseconds = expiresAt - createdAt;
    const nanosecondsPerSecond = 1_000_000_000n;
    if (
      ttlNanoseconds <= 0n ||
      ttlNanoseconds % nanosecondsPerSecond !== 0n
    ) {
      return null;
    }
    const ttlSecondsBigInt = ttlNanoseconds / nanosecondsPerSecond;
    if (ttlSecondsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const previewTtlSeconds = Number(ttlSecondsBigInt);
    if (!Number.isSafeInteger(previewTtlSeconds) || previewTtlSeconds <= 0) {
      return null;
    }

    const basePayload = {
      action: "deployments.preview" as const,
      management_tenant_id: preview.managementTenantId,
      creator_actor_ref: preview.creatorActorRef,
      base_release_revision: preview.baseRevision,
      inventory_refs: preview.inventoryRefs.map(hashModuleRef),
      desired_modules: preview.desiredModules.map(hashModuleRef),
      policy_version: PREVIEW_POLICY_VERSION,
      schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
      validation: {
        base_matches: preview.validation.baseMatches,
        desired_modules_valid: preview.validation.desiredModulesValid,
        inventory_matches: preview.validation.inventoryMatches,
        minimum_active_modules: preview.validation.minimumActiveModules,
        reason_codes: preview.validation.reasonCodes,
      },
      preview_ttl_seconds: previewTtlSeconds,
    };
    const payload =
      preview.intent === "rollback"
        ? {
            ...basePayload,
            intent: "rollback" as const,
            target_release_id: preview.targetReleaseId,
          }
        : {
            ...basePayload,
            intent: "change" as const,
          };
    return canonicalControlHash({
      domain: "preview",
      schemaVersion: ADMIN_CONTROL_SCHEMA_VERSION,
      payload,
    }).hash;
  } catch {
    return null;
  }
}

function approvalInventoryDigestSet(
  refs: readonly ModuleControlRef[],
): readonly ModuleControlRef["descriptorDigest"][] {
  return Object.freeze(
    [...new Set(refs.map((ref) => ref.descriptorDigest))].sort(),
  );
}

function persistedPreviewIsStructurallyValidForApproval(
  preview: ModulePreviewRecord,
  managementTenantId: string,
  previewRef: string,
): boolean {
  const recomputed = recomputePersistedPreviewHash(preview);
  const baseIsClosed =
    (preview.baseReleaseId === null && preview.baseRevision === 0) ||
    (preview.baseReleaseId !== null && preview.baseRevision > 0);
  return (
    preview.managementTenantId === managementTenantId &&
    preview.previewRef === previewRef &&
    recomputed !== null &&
    isPreviewHash(preview.canonicalHash) &&
    preview.canonicalHash === recomputed &&
    baseIsClosed &&
    preview.inventoryRefs.length > 0 &&
    moduleRefSetsEqual(preview.inventoryRefs, preview.inventoryRefs) &&
    preview.desiredModules.length > 0 &&
    moduleRefSetsEqual(preview.desiredModules, preview.desiredModules) &&
    IDENTIFIER_PATTERN.test(preview.creatorActorRef)
  );
}

function replayedApprovalMatchesEnvelope(
  approval: ModuleApprovalRecord,
  envelope: DeepFrozen<ControlEnvelope>,
  request: ApprovalRequest,
  managementTenantId: string,
  actorRef: string,
  approvalId: string,
): boolean {
  const data = envelope.data;
  const baseIsClosed =
    (approval.baseReleaseId === null && approval.baseRevision === 0) ||
    (approval.baseReleaseId !== null && approval.baseRevision > 0);
  const normalizedInventoryDigestSet = [
    ...new Set(approval.inventoryDigestSet),
  ].sort();
  return (
    envelope.status === "success" &&
    data?.kind === "approval" &&
    data.approval_id === approvalId &&
    data.preview_ref === approval.previewRef &&
    data.decision === approval.decision &&
    approval.managementTenantId === managementTenantId &&
    approval.approvalId === approvalId &&
    approval.previewRef === request.preview_ref &&
    approval.decision === request.decision &&
    approval.reasonCode === request.reason_code &&
    approval.approverActorRef === actorRef &&
    isPreviewHash(approval.previewCanonicalHash) &&
    baseIsClosed &&
    approval.inventoryDigestSet.length > 0 &&
    stringArraysEqual(
      approval.inventoryDigestSet,
      normalizedInventoryDigestSet,
    ) &&
    IDENTIFIER_PATTERN.test(approval.reasonCode) &&
    compareRfc3339Instants(approval.decidedAt, approval.expiresAt) === -1 &&
    approval.consumed === false
  );
}

function hasReadbackAttemptRepository(
  repository: ModuleControlRepository,
): repository is ModuleControlRepository & ModuleControlReadbackAttemptRepository {
  const candidate = repository as Partial<ModuleControlReadbackAttemptRepository>;
  return (
    typeof candidate.claimReadbackAttempt === "function" &&
    typeof candidate.finalizeReadbackAndComplete === "function"
  );
}

function publishedReleaseMatchesEnvelope(
  release: DeepReadonly<ModuleReleaseRecord>,
  readback: DeepReadonly<ModuleReadbackRecord> | null,
  envelope: DeepFrozen<ControlEnvelope>,
  request: PublishRequest,
  managementTenantId: string,
  publisherActorRef: string,
): boolean {
  const data = envelope.data;
  if (
    release.managementTenantId !== managementTenantId ||
    release.previewRef !== request.preview_ref ||
    release.approvalId !== request.approval_id ||
    release.publisherActorRef !== publisherActorRef ||
    release.publishedAt === null ||
    readback === null ||
    readback.managementTenantId !== managementTenantId ||
    readback.readbackRef !== release.readbackRef ||
    readback.releaseId !== release.releaseId ||
    readback.revision !== release.revision ||
    data?.kind !== "release" ||
    data.release_id !== release.releaseId ||
    data.revision !== release.revision ||
    data.active_modules === undefined ||
    !moduleRefsMatchEnvelope(release.desiredModules, data.active_modules) ||
    envelope.readback.release_id !== release.releaseId ||
    envelope.readback.revision !== release.revision
  ) {
    return false;
  }

  if (release.status === "active_verified") {
    return (
      release.reasonCodes.length === 0 &&
      release.supersededByReleaseId === null &&
      readback.status === "verified" &&
      readback.appliedReleaseId === release.releaseId &&
      readback.appliedRevision === release.revision &&
      moduleRefSetsEqual(readback.appliedModules, release.desiredModules) &&
      readback.reasonCodes.length === 0 &&
      envelope.status === "success" &&
      envelope.reason_codes.length === 0 &&
      envelope.readback.status === "verified"
    );
  }
  if (release.status === "manual_review") {
    return (
      readback.status !== "verified" &&
      stringArraysEqual(readback.reasonCodes, release.reasonCodes) &&
      envelope.status === "manual_review" &&
      stringArraysEqual(envelope.reason_codes, release.reasonCodes) &&
      envelope.readback.status === readback.status
    );
  }
  return false;
}

function reconciledReleaseMatchesEnvelope(
  release: DeepReadonly<ModuleReleaseRecord>,
  readback: DeepReadonly<ModuleReadbackRecord> | null,
  envelope: DeepFrozen<ControlEnvelope>,
  request: ReconcileRequest,
  managementTenantId: string,
): boolean {
  const data = envelope.data;
  if (
    release.managementTenantId !== managementTenantId ||
    release.releaseId !== request.release_id ||
    release.publishedAt === null ||
    readback === null ||
    readback.managementTenantId !== managementTenantId ||
    readback.readbackRef !== release.readbackRef ||
    readback.releaseId !== release.releaseId ||
    readback.revision !== release.revision ||
    data?.kind !== "reconciliation" ||
    data.release_id !== release.releaseId ||
    data.revision !== release.revision ||
    data.status !== readback.status ||
    envelope.readback.status !== readback.status ||
    envelope.readback.release_id !== release.releaseId ||
    envelope.readback.revision !== release.revision
  ) {
    return false;
  }
  if (release.status === "active_verified") {
    return (
      readback.status === "verified" &&
      readback.appliedReleaseId === release.releaseId &&
      readback.appliedRevision === release.revision &&
      moduleRefSetsEqual(readback.appliedModules, release.desiredModules) &&
      readback.reasonCodes.length === 0 &&
      release.reasonCodes.length === 0 &&
      envelope.status === "success" &&
      envelope.reason_codes.length === 0
    );
  }
  if (release.status === "manual_review") {
    return (
      (readback.status === "mismatch" || readback.status === "unknown") &&
      stringArraysEqual(readback.reasonCodes, release.reasonCodes) &&
      envelope.status === "manual_review" &&
      stringArraysEqual(envelope.reason_codes, release.reasonCodes)
    );
  }
  return false;
}

function claimedAttemptMatches(
  attempt: DeepReadonly<ReadbackAttemptRecord>,
  input: {
    readonly action: "deployments.publish" | "deployments.reconcile";
    readonly managementTenantId: string;
    readonly attemptId: string;
    readonly idempotencyKey: string;
    readonly requestHash: CanonicalRequestHash;
    readonly actorRef: string;
    readonly requestId: string;
    readonly traceId: string;
    readonly auditId: string;
    readonly releaseId: string;
    readonly revision: number;
    readonly desiredModules: readonly ModuleControlRef[];
    readonly readbackRef: string;
    readonly claimedAt: string;
  },
): boolean {
  return (
    attempt.managementTenantId === input.managementTenantId &&
    attempt.attemptId === input.attemptId &&
    attempt.action === input.action &&
    attempt.idempotencyKey === input.idempotencyKey &&
    attempt.requestHash === input.requestHash &&
    attempt.actorRef === input.actorRef &&
    attempt.requestId === input.requestId &&
    attempt.traceId === input.traceId &&
    attempt.auditId === input.auditId &&
    attempt.releaseId === input.releaseId &&
    attempt.revision === input.revision &&
    moduleRefSetsEqual(attempt.desiredModules, input.desiredModules) &&
    attempt.readbackRef === input.readbackRef &&
    IDENTIFIER_PATTERN.test(attempt.ownerBootId) &&
    attempt.phase === "claimed" &&
    attempt.claimedAt === input.claimedAt &&
    attempt.finalizedAt === null &&
    attempt.terminalStatus === null &&
    attempt.appliedReleaseId === null &&
    attempt.appliedRevision === null &&
    attempt.appliedModules.length === 0 &&
    attempt.reasonCodes.length === 0 &&
    attempt.checkedAt === null &&
    attempt.finalizedByActorRef === null &&
    attempt.reconciliationEventSequence === null &&
    attempt.completionEventSequence === null
  );
}

function moduleRefDiff(
  base: readonly ModuleControlRef[],
  desired: readonly ModuleControlRef[],
) {
  const baseByKey = new Map(base.map((ref) => [moduleRefKey(ref), ref]));
  const desiredByKey = new Map(
    desired.map((ref) => [moduleRefKey(ref), ref]),
  );
  return {
    added: sortedModuleRefs(
      desired.filter((ref) => !baseByKey.has(moduleRefKey(ref))),
    ),
    removed: sortedModuleRefs(
      base.filter((ref) => !desiredByKey.has(moduleRefKey(ref))),
    ),
    retained: sortedModuleRefs(
      desired.filter((ref) => baseByKey.has(moduleRefKey(ref))),
    ),
  };
}

function previewBaseAgreesWithRuntime(
  state: DeepReadonly<ModuleControlState>,
  snapshot: ModuleActivationSnapshot,
  managementTenantId: string,
  exactActiveReadback: DeepReadonly<ModuleReadbackRecord> | null,
): boolean {
  if (state.managementTenantId !== managementTenantId) return false;
  if (
    snapshot.releaseId === null ||
    snapshot.revision === 0 ||
    snapshot.activeModules.length === 0
  ) {
    return (
      snapshot.releaseId === null &&
      snapshot.revision === 0 &&
      snapshot.activeModules.length === 0 &&
      state.activeRelease === null &&
      state.activeRevision === 0 &&
      state.activeModules.length === 0 &&
      state.latestReadback?.status !== "verified"
    );
  }

  const activeRelease = state.activeRelease;
  const readback = exactActiveReadback;
  return (
    activeRelease !== null &&
    activeRelease.managementTenantId === managementTenantId &&
    activeRelease.status === "active_verified" &&
    activeRelease.releaseId === snapshot.releaseId &&
    activeRelease.revision === snapshot.revision &&
    moduleRefSetsEqual(activeRelease.desiredModules, snapshot.activeModules) &&
    state.activeRevision === snapshot.revision &&
    moduleRefSetsEqual(state.activeModules, snapshot.activeModules) &&
    readback !== null &&
    readback.managementTenantId === managementTenantId &&
    readback.status === "verified" &&
    readback.releaseId === snapshot.releaseId &&
    readback.revision === snapshot.revision &&
    readback.appliedReleaseId === snapshot.releaseId &&
    readback.appliedRevision === snapshot.revision &&
    readback.reasonCodes.length === 0 &&
    moduleRefSetsEqual(readback.appliedModules, snapshot.activeModules) &&
    activeRelease.readbackRef === readback.readbackRef
  );
}

function rollbackTargetReadbackMatchesRelease(
  release: DeepReadonly<ModuleReleaseRecord>,
  readback: DeepReadonly<ModuleReadbackRecord> | null,
  managementTenantId: string,
): boolean {
  return (
    readback !== null &&
    readback.managementTenantId === managementTenantId &&
    readback.status === "verified" &&
    readback.readbackRef === release.readbackRef &&
    readback.releaseId === release.releaseId &&
    readback.revision === release.revision &&
    readback.appliedReleaseId === release.releaseId &&
    readback.appliedRevision === release.revision &&
    readback.reasonCodes.length === 0 &&
    moduleRefSetsEqual(readback.appliedModules, release.desiredModules)
  );
}

function writeEnvelopeInput(
  meta: WriteMeta,
  status: "blocked" | "unavailable",
  reasonCode: string,
) {
  return {
    schema_version: "2026-08-22.v1",
    request_id: meta.requestId,
    trace_id: meta.traceId,
    audit_id: meta.auditId,
    status,
    data: null,
    reason_codes: [reasonCode],
    readback: {
      status: "not_applicable" as const,
      release_id: null,
      revision: null,
    },
  };
}

function registrationRecordRef(record: {
  readonly moduleId: string;
  readonly version: string;
  readonly descriptorDigest: string;
}): string {
  return `registration:${record.moduleId}:${record.version}:${record.descriptorDigest}`;
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    freezeDeep(child, seen);
  }
  return Object.freeze(value);
}

function closeEnvelope(envelope: unknown): DeepFrozen<ControlEnvelope> {
  try {
    return freezeDeep(controlEnvelopeSchema.parse(envelope));
  } catch {
    throw new ModuleControlServiceError("state_output_invalid");
  }
}

function blockedEnvelope(
  code: ModuleControlServiceErrorCode,
): DeepFrozen<ControlEnvelope> {
  return closeEnvelope({
    schema_version: "2026-08-22.v1",
    request_id: AUTH_FAILURE_REQUEST_ID,
    trace_id: AUTH_FAILURE_TRACE_ID,
    audit_id: AUTH_FAILURE_AUDIT_ID,
    status: "blocked",
    data: null,
    reason_codes: [code],
    readback: {
      status: "not_applicable",
      release_id: null,
      revision: null,
    },
  });
}

function authorizationFailure(
  context: unknown,
  managementTenantId: string,
): ModuleControlServiceErrorCode | null {
  if (!isTrustedExecutionContext(context)) {
    return "execution_context_untrusted";
  }
  if (context.role !== "admin") {
    return "admin_role_required";
  }
  if (!context.roles.includes("admin")) {
    return "admin_role_missing";
  }
  if (!context.scopes.includes("platform:admin")) {
    return "platform_admin_scope_required";
  }
  if (context.tenantId !== managementTenantId) {
    return "management_tenant_mismatch";
  }
  return null;
}

function reconcileAuthorizationFailure(
  context: unknown,
  managementTenantId: string,
): ModuleControlServiceErrorCode | null {
  if (!isTrustedExecutionContext(context)) {
    return "execution_context_untrusted";
  }
  if (context.role !== "admin" && context.role !== "operator") {
    return "admin_role_required";
  }
  if (!context.roles.includes(context.role)) {
    return context.role === "admin"
      ? "admin_role_missing"
      : "admin_role_required";
  }
  if (!context.scopes.includes("platform:admin")) {
    return "platform_admin_scope_required";
  }
  if (context.tenantId !== managementTenantId) {
    return "management_tenant_mismatch";
  }
  return null;
}

class ModuleControlServiceImplementation implements ModuleControlService {
  readonly #repository: ModuleControlRepository;
  readonly #inventory: TrustedModuleInventory;
  readonly #managementTenantId: string;
  readonly #previewTtlSeconds: number;
  readonly #clock: () => string;
  readonly #idGenerator: () => string;
  readonly #runtime: PrivateRuntimeCapabilities;

  constructor(
    options: ModuleControlRuntimeAssemblyOptions,
    runtime: PrivateRuntimeCapabilities,
  ) {
    this.#repository = options.repository;
    this.#inventory = options.inventory;
    this.#managementTenantId = options.managementTenantId;
    this.#previewTtlSeconds = options.previewTtlSeconds;
    this.#clock = options.clock;
    this.#idGenerator = options.idGenerator;
    this.#runtime = runtime;
  }

  #assertWriteEnvelope(
    action: ControlProducerAction,
    envelope: unknown,
  ): DeepFrozen<ControlEnvelope> {
    try {
      return assertControlProducerEnvelope(action, envelope);
    } catch (error: unknown) {
      return this.#runtime.coordinator.tripFatal(error);
    }
  }

  #assertRuntimeHealthy(): void {
    if (this.#runtime.coordinator.isFatal()) {
      this.#runtime.coordinator.tripFatal(
        new ModuleControlServiceError("runtime_fatal"),
      );
    }
  }

  #terminalRegisterEnvelope(
    meta: WriteMeta,
    status: "blocked" | "unavailable",
    reasonCode: string,
  ): DeepFrozen<ControlEnvelope> {
    return this.#assertWriteEnvelope(
      "packages.register",
      writeEnvelopeInput(meta, status, reasonCode),
    );
  }

  #terminalWriteEnvelope(
    action: ControlProducerAction,
    meta: WriteMeta,
    status: "blocked" | "unavailable",
    reasonCode: string,
  ): DeepFrozen<ControlEnvelope> {
    return this.#assertWriteEnvelope(
      action,
      writeEnvelopeInput(meta, status, reasonCode),
    );
  }

  #repositoryFailure(
    error: unknown,
    meta: WriteMeta,
  ): DeepFrozen<ControlEnvelope> {
    if (error instanceof RuntimeMutationFatalError) {
      throw error;
    }
    if (error instanceof ModuleControlRepositoryError) {
      if (error.code === "conflict") {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "registration_conflict",
        );
      }
      if (error.code === "invalid_state" || error.code === "tenant_mismatch") {
        return this.#runtime.coordinator.tripFatal(error);
      }
    }
    return this.#terminalRegisterEnvelope(
      meta,
      "unavailable",
      "repository_unavailable",
    );
  }

  #previewRepositoryFailure(
    error: unknown,
    meta: WriteMeta,
  ): DeepFrozen<ControlEnvelope> {
    if (error instanceof RuntimeMutationFatalError) {
      throw error;
    }
    if (error instanceof ModuleControlRepositoryError) {
      if (error.code === "conflict") {
        return this.#terminalWriteEnvelope(
          "deployments.preview",
          meta,
          "blocked",
          "preview_conflict",
        );
      }
      if (error.code === "invalid_state" || error.code === "tenant_mismatch") {
        return this.#runtime.coordinator.tripFatal(error);
      }
    }
    return this.#terminalWriteEnvelope(
      "deployments.preview",
      meta,
      "unavailable",
      "repository_unavailable",
    );
  }

  #previewPreflightReadFailure(
    error: unknown,
    meta: WriteMeta,
  ): DeepFrozen<ControlEnvelope> {
    if (error instanceof RuntimeMutationFatalError) {
      throw error;
    }
    if (
      error instanceof ModuleControlRepositoryError &&
      error.code !== "closed"
    ) {
      return this.#runtime.coordinator.tripFatal(error);
    }
    return this.#terminalWriteEnvelope(
      "deployments.preview",
      meta,
      "unavailable",
      "repository_unavailable",
    );
  }

  #approvalPreflightReadFailure(
    error: unknown,
    meta: WriteMeta,
  ): DeepFrozen<ControlEnvelope> {
    if (error instanceof RuntimeMutationFatalError) throw error;
    if (
      error instanceof ModuleControlRepositoryError &&
      error.code !== "closed"
    ) {
      return this.#runtime.coordinator.tripFatal(error);
    }
    return this.#terminalWriteEnvelope(
      "approvals.decide",
      meta,
      "unavailable",
      "repository_unavailable",
    );
  }

  #approvalRepositoryFailure(
    error: unknown,
    meta: WriteMeta,
  ): DeepFrozen<ControlEnvelope> {
    if (error instanceof RuntimeMutationFatalError) throw error;
    if (
      error instanceof ModuleControlRepositoryError &&
      error.code === "conflict"
    ) {
      return this.#terminalWriteEnvelope(
        "approvals.decide",
        meta,
        "blocked",
        "approval_conflict",
      );
    }
    if (
      error instanceof ModuleControlRepositoryError &&
      error.code === "closed"
    ) {
      return this.#terminalWriteEnvelope(
        "approvals.decide",
        meta,
        "unavailable",
        "repository_unavailable",
      );
    }
    return this.#runtime.coordinator.tripFatal(error);
  }

  #publishPreflightReadFailure(
    error: unknown,
    meta: WriteMeta,
  ): DeepFrozen<ControlEnvelope> {
    if (error instanceof RuntimeMutationFatalError) throw error;
    if (
      error instanceof ModuleControlRepositoryError &&
      error.code !== "closed"
    ) {
      return this.#runtime.coordinator.tripFatal(error);
    }
    return this.#terminalWriteEnvelope(
      "deployments.publish",
      meta,
      "unavailable",
      "repository_unavailable",
    );
  }

  #publishRepositoryFailure(
    error: unknown,
    meta: WriteMeta,
  ): DeepFrozen<ControlEnvelope> {
    if (error instanceof RuntimeMutationFatalError) throw error;
    if (error instanceof ModuleControlRepositoryError) {
      if (error.code === "conflict" || error.code === "not_found") {
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "blocked",
          "publish_conflict",
        );
      }
      if (error.code === "invalid_state" || error.code === "tenant_mismatch") {
        return this.#runtime.coordinator.tripFatal(error);
      }
    }
    return this.#terminalWriteEnvelope(
      "deployments.publish",
      meta,
      "unavailable",
      "repository_unavailable",
    );
  }

  async registerPackage(
    context: ExecutionContext,
    requestInput: RegisterPackageRequest,
    metaInput: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    const meta = parseWriteMeta(metaInput);
    const failure = authorizationFailure(context, this.#managementTenantId);
    if (failure !== null) {
      return this.#terminalRegisterEnvelope(meta, "blocked", failure);
    }

    return this.#runtime.coordinator.withMutation(async () => {
      const request = parseRegisterRequest(requestInput);
      if (request === null) {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "register_request_invalid",
        );
      }

      let expectedHash: string;
      try {
        expectedHash = canonicalControlHash({
          domain: "request",
          schemaVersion: request.schema_version,
          payload: {
            action: "packages.register",
            management_tenant_id: this.#managementTenantId,
            actor_ref: context.actorId,
            request: {
              ...request,
              descriptor_digest:
                request.descriptor_digest as `sha256:${string}`,
            },
          },
        }).hash;
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (expectedHash !== meta.requestHash) {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "request_hash_mismatch",
        );
      }

      const logicalInventoryEntry = this.#inventory.find(
        (entry) =>
          entry.moduleId === request.module_id &&
          entry.version === request.version,
      );
      if (logicalInventoryEntry === undefined) {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "inventory_module_not_found",
        );
      }
      if (logicalInventoryEntry.descriptorDigest !== request.descriptor_digest) {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "inventory_descriptor_mismatch",
        );
      }

      let registeredAt: string;
      try {
        registeredAt = this.#clock();
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      const record: ModuleRegistrationRecord = {
        managementTenantId: this.#managementTenantId,
        moduleId: logicalInventoryEntry.moduleId,
        version: logicalInventoryEntry.version,
        descriptorDigest: logicalInventoryEntry.descriptorDigest,
        evidenceLevel: logicalInventoryEntry.evidenceLevel,
        productionEligible: logicalInventoryEntry.productionEligible,
        evidenceRefs: {
          sourceShaRef: logicalInventoryEntry.evidenceRefs.sourceShaRef,
          artifactDigestRef:
            logicalInventoryEntry.evidenceRefs.artifactDigestRef,
          signatureRef: logicalInventoryEntry.evidenceRefs.signatureRef,
          sbomRef: logicalInventoryEntry.evidenceRefs.sbomRef,
          attestationRef: logicalInventoryEntry.evidenceRefs.attestationRef,
        },
        registeredByActorRef: context.actorId,
        registeredAt,
      };
      const domainRecordRef = registrationRecordRef(record);
      const successEnvelope = this.#assertWriteEnvelope("packages.register", {
        schema_version: request.schema_version,
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "success",
        data: {
          kind: "registration",
          module_id: record.moduleId,
          version: record.version,
          descriptor_digest: record.descriptorDigest,
          evidence_level: record.evidenceLevel,
          production_eligible: record.productionEligible,
        },
        reason_codes: [],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });
      const event: RegisterModuleRequestMetadata["event"] = {
        action: "packages.register",
        objectRef: domainRecordRef,
        kind: "registration",
        status: "registered",
        reasonCodes: [],
        detail: {
          kind: "registration",
          recordRef: domainRecordRef,
          moduleId: record.moduleId,
          version: record.version,
          descriptorDigest: record.descriptorDigest,
          status: "registered",
        },
      };
      const finalResult: ControlFinalResult = {
        domainRecordRef,
        envelope: successEnvelope as unknown as ControlEnvelope,
      };

      try {
        await this.#repository.registerModule({
          metadata: {
            managementTenantId: this.#managementTenantId,
            actorRef: context.actorId,
            action: "packages.register",
            idempotencyKey: meta.idempotencyKey,
            requestHash: meta.requestHash,
            event,
          },
          record,
          finalResult,
        });
      } catch (error: unknown) {
        return this.#repositoryFailure(error, meta);
      }

      let persisted;
      try {
        persisted = await this.#repository.getIdempotency({
          managementTenantId: this.#managementTenantId,
          action: "packages.register",
          idempotencyKey: meta.idempotencyKey,
        });
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (
        persisted === null ||
        persisted.status !== "completed" ||
        persisted.managementTenantId !== this.#managementTenantId ||
        persisted.action !== "packages.register" ||
        persisted.idempotencyKey !== meta.idempotencyKey ||
        persisted.requestHash !== meta.requestHash ||
        persisted.actorRef !== context.actorId ||
        persisted.domainRecordRef !== domainRecordRef ||
        persisted.finalResult === null ||
        persisted.finalResult.domainRecordRef !== domainRecordRef
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }
      return this.#assertWriteEnvelope(
        "packages.register",
        persisted.finalResult.envelope,
      );
    });
  }

  async createDeploymentPreview(
    context: ExecutionContext,
    requestInput: DeploymentPreviewRequest,
    metaInput: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    const meta = parseWriteMeta(metaInput);
    const failure = authorizationFailure(context, this.#managementTenantId);
    if (failure !== null) {
      return this.#terminalWriteEnvelope("deployments.preview", meta, "blocked", failure);
    }

    return this.#runtime.coordinator.withMutation(async () => {
      const request = parseDeploymentPreviewRequest(requestInput);
      if (request === null) {
        return this.#terminalWriteEnvelope(
          "deployments.preview",
          meta,
          "blocked",
          "preview_request_invalid",
        );
      }
      let expectedRequestHash: string;
      try {
        const requestPayload =
          request.intent === "change"
            ? {
                schema_version: request.schema_version,
                intent: "change" as const,
                desired_modules: request.desired_modules.map((ref) => ({
                  module_id: ref.module_id,
                  version: ref.version,
                  descriptor_digest:
                    ref.descriptor_digest as `sha256:${string}`,
                })),
              }
            : {
                schema_version: request.schema_version,
                intent: "rollback" as const,
                target_release_id: request.target_release_id,
              };
        expectedRequestHash = canonicalControlHash({
          domain: "request",
          schemaVersion: request.schema_version,
          payload: {
            action: "deployments.preview",
            management_tenant_id: this.#managementTenantId,
            actor_ref: context.actorId,
            request: requestPayload,
          },
        }).hash;
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (expectedRequestHash !== meta.requestHash) {
        return this.#terminalWriteEnvelope(
          "deployments.preview",
          meta,
          "blocked",
          "request_hash_mismatch",
        );
      }

      let existingIdempotency;
      try {
        existingIdempotency = await this.#repository.getIdempotency({
          managementTenantId: this.#managementTenantId,
          action: "deployments.preview",
          idempotencyKey: meta.idempotencyKey,
        });
      } catch (error: unknown) {
        return this.#previewPreflightReadFailure(error, meta);
      }
      if (existingIdempotency !== null) {
        const persistedIdempotency = existingIdempotency;
        if (
          persistedIdempotency.managementTenantId !== this.#managementTenantId ||
          persistedIdempotency.action !== "deployments.preview" ||
          persistedIdempotency.idempotencyKey !== meta.idempotencyKey
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        if (persistedIdempotency.requestHash !== meta.requestHash) {
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "blocked",
            "preview_conflict",
          );
        }
        if (
          persistedIdempotency.status !== "completed" ||
          persistedIdempotency.actorRef !== context.actorId ||
          persistedIdempotency.domainRecordRef === null ||
          persistedIdempotency.finalResult === null ||
          persistedIdempotency.finalResult.domainRecordRef !==
            persistedIdempotency.domainRecordRef
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        let replayedPreview;
        try {
          replayedPreview = await this.#repository.getPreview({
            managementTenantId: this.#managementTenantId,
            previewRef: persistedIdempotency.domainRecordRef,
          });
        } catch (error: unknown) {
          return this.#previewPreflightReadFailure(error, meta);
        }
        if (replayedPreview === null) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        const persistedPreview = replayedPreview;
        const replayEnvelope = this.#assertWriteEnvelope(
          "deployments.preview",
          persistedIdempotency.finalResult.envelope,
        );
        if (
          !replayedPreviewMatchesEnvelope(
            persistedPreview,
            replayEnvelope,
            this.#managementTenantId,
            context.actorId,
            persistedIdempotency.domainRecordRef,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        return replayEnvelope;
      }

      let activationSnapshot: ModuleActivationSnapshot;
      try {
        activationSnapshot = this.#runtime.activationSnapshot();
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }

      let state: ModuleControlState;
      try {
        state = (await this.#repository.getControlState()) as ModuleControlState;
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        if (
          error instanceof ModuleControlRepositoryError &&
          (error.code === "invalid_state" || error.code === "tenant_mismatch")
        ) {
          return this.#runtime.coordinator.tripFatal(error);
        }
        return this.#terminalWriteEnvelope(
          "deployments.preview",
          meta,
          "unavailable",
          "repository_unavailable",
        );
      }

      let exactActiveReadback: DeepReadonly<ModuleReadbackRecord> | null = null;
      if (state.activeRelease !== null) {
        try {
          exactActiveReadback = await this.#repository.getReadback({
            managementTenantId: this.#managementTenantId,
            releaseId: state.activeRelease.releaseId,
          });
        } catch (error: unknown) {
          if (error instanceof RuntimeMutationFatalError) throw error;
          if (
            error instanceof ModuleControlRepositoryError &&
            (error.code === "invalid_state" || error.code === "tenant_mismatch")
          ) {
            return this.#runtime.coordinator.tripFatal(error);
          }
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "unavailable",
            "repository_unavailable",
          );
        }
      }

      try {
        if (
          !previewBaseAgreesWithRuntime(
            state,
            activationSnapshot,
            this.#managementTenantId,
            exactActiveReadback,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }

      let rollbackTargetRelease: DeepReadonly<ModuleReleaseRecord> | null = null;
      if (request.intent === "rollback") {
        if (
          activationSnapshot.releaseId === null ||
          activationSnapshot.revision === 0 ||
          state.activeRelease === null
        ) {
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "blocked",
            "rollback_base_inactive",
          );
        }

        const boundedTargets = state.releaseHistory.filter(
          (entry) => entry.release.releaseId === request.target_release_id,
        );
        if (boundedTargets.length === 0) {
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "blocked",
            "rollback_target_not_in_bounded_history",
          );
        }
        if (boundedTargets.length !== 1) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        const boundedTargetRelease = boundedTargets[0]!.release;
        if (boundedTargetRelease.managementTenantId !== this.#managementTenantId) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("management_tenant_state_mismatch"),
          );
        }
        if (boundedTargetRelease.revision >= activationSnapshot.revision) {
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "blocked",
            "rollback_target_not_older_than_base",
          );
        }
        if (
          boundedTargetRelease.status !== "active_verified" &&
          boundedTargetRelease.status !== "superseded"
        ) {
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "blocked",
            "rollback_target_status_not_eligible",
          );
        }
        if (boundedTargetRelease.desiredModules.length === 0) {
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "blocked",
            "rollback_target_modules_empty",
          );
        }

        let exactTargetRelease: DeepReadonly<ModuleReleaseRecord> | null;
        try {
          exactTargetRelease = await this.#repository.getRelease({
            managementTenantId: this.#managementTenantId,
            releaseId: request.target_release_id,
          });
        } catch (error: unknown) {
          return this.#previewPreflightReadFailure(error, meta);
        }
        if (
          exactTargetRelease === null ||
          !isDeepStrictEqual(exactTargetRelease, boundedTargetRelease)
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        let exactTargetReadback: DeepReadonly<ModuleReadbackRecord> | null;
        try {
          exactTargetReadback = await this.#repository.getReadback({
            managementTenantId: this.#managementTenantId,
            releaseId: request.target_release_id,
          });
        } catch (error: unknown) {
          return this.#previewPreflightReadFailure(error, meta);
        }
        if (
          !rollbackTargetReadbackMatchesRelease(
            exactTargetRelease,
            exactTargetReadback,
            this.#managementTenantId,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        rollbackTargetRelease = exactTargetRelease;
      }

      const inventoryRefs = sortedModuleRefs(
        this.#inventory.map(inventoryModuleRef),
      );
      const desiredRefs = sortedModuleRefs(
        request.intent === "change"
          ? request.desired_modules.map(requestModuleRef)
          : rollbackTargetRelease!.desiredModules,
      );
      try {
        for (const registration of state.registrations) {
          if (registration.managementTenantId !== this.#managementTenantId) {
            return this.#runtime.coordinator.tripFatal(
              new ModuleControlServiceError("management_tenant_state_mismatch"),
            );
          }
        }
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }

      const inventoryByLogicalKey = new Map(
        inventoryRefs.map((ref) => [moduleLogicalKey(ref), ref]),
      );
      for (const desired of desiredRefs) {
        const inventoryRef = inventoryByLogicalKey.get(moduleLogicalKey(desired));
        if (inventoryRef === undefined) {
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "blocked",
            "inventory_module_not_found",
          );
        }
        if (inventoryRef.descriptorDigest !== desired.descriptorDigest) {
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "blocked",
            "inventory_descriptor_mismatch",
          );
        }
        const registrations = state.registrations.filter(
          (registration) =>
            registration.moduleId === desired.moduleId &&
            registration.version === desired.version,
        );
        const exactRegistration = registrations.find(
          (registration) =>
            registration.descriptorDigest === desired.descriptorDigest,
        );
        if (exactRegistration === undefined) {
          return this.#terminalWriteEnvelope(
            "deployments.preview",
            meta,
            "blocked",
            registrations.length === 0
              ? "module_not_registered"
              : "registration_descriptor_mismatch",
          );
        }
      }

      const baseModules = sortedModuleRefs(
        activationSnapshot.activeModules.map((ref) => ({
          moduleId: ref.moduleId,
          version: ref.version,
          descriptorDigest: ref.descriptorDigest,
        })),
      );
      const diff = moduleRefDiff(baseModules, desiredRefs);
      const validation = {
        base_matches: true,
        desired_modules_valid: true,
        inventory_matches: true,
        minimum_active_modules: true,
        reason_codes: [] as readonly string[],
      };

      let previewHash: string;
      let previewRef: string;
      let createdAt: string;
      let expiresAt: string;
      try {
        const basePayload = {
          action: "deployments.preview" as const,
          management_tenant_id: this.#managementTenantId,
          creator_actor_ref: context.actorId,
          base_release_revision: activationSnapshot.revision,
          inventory_refs: inventoryRefs.map(hashModuleRef),
          desired_modules: desiredRefs.map(hashModuleRef),
          policy_version: PREVIEW_POLICY_VERSION,
          schema_version: request.schema_version,
          validation,
          preview_ttl_seconds: this.#previewTtlSeconds,
        };
        const payload =
          request.intent === "rollback"
            ? {
                ...basePayload,
                intent: "rollback" as const,
                target_release_id: request.target_release_id,
              }
            : {
                ...basePayload,
                intent: "change" as const,
              };
        previewHash = canonicalControlHash({
          domain: "preview",
          schemaVersion: request.schema_version,
          payload,
        }).hash;
        previewRef = this.#idGenerator();
        if (typeof previewRef !== "string" || !IDENTIFIER_PATTERN.test(previewRef)) {
          throw new TypeError("The preview ID generator returned an invalid identifier.");
        }
        createdAt = this.#clock();
        const calculatedExpiresAt = addRfc3339Milliseconds(
          createdAt,
          BigInt(this.#previewTtlSeconds) * 1_000n,
        );
        if (calculatedExpiresAt === null) {
          throw new RangeError("The preview expiry is not a valid RFC3339 instant.");
        }
        expiresAt = calculatedExpiresAt;
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }

      const desiredModules = desiredRefs.map(hashModuleRef);
      const diffForEnvelope = {
        added: diff.added.map(hashModuleRef),
        removed: diff.removed.map(hashModuleRef),
        retained: diff.retained.map(hashModuleRef),
      };
      const successEnvelope = this.#assertWriteEnvelope("deployments.preview", {
        schema_version: request.schema_version,
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "success",
        data: {
          kind: "preview",
          preview_ref: previewRef,
          intent: request.intent,
          base_release_id: activationSnapshot.releaseId,
          base_revision: activationSnapshot.revision,
          desired_modules: desiredModules,
          target_release_id:
            request.intent === "rollback" ? request.target_release_id : null,
          expires_at: expiresAt,
          canonical_hash: previewHash,
          diff: diffForEnvelope,
          validation,
          creator_actor_ref: context.actorId,
          created_at: createdAt,
          consumed: false,
        },
        reason_codes: [],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });
      const recordBase = {
        managementTenantId: this.#managementTenantId,
        previewRef,
        canonicalHash: previewHash as `mcp-control-hash/v1/preview/sha256:${string}`,
        baseReleaseId: activationSnapshot.releaseId,
        baseRevision: activationSnapshot.revision,
        inventoryRefs,
        desiredModules: desiredRefs,
        diff,
        validation: {
          baseMatches: true,
          desiredModulesValid: true,
          inventoryMatches: true,
          minimumActiveModules: true,
          reasonCodes: [],
        },
        creatorActorRef: context.actorId,
        createdAt,
        expiresAt,
        consumed: false,
      };
      const record: ModulePreviewRecord =
        request.intent === "rollback"
          ? {
              ...recordBase,
              intent: "rollback",
              targetReleaseId: request.target_release_id,
            }
          : {
              ...recordBase,
              intent: "change",
            };
      const event: CreatePreviewRequestMetadata["event"] = {
        action: "deployments.preview",
        objectRef: previewRef,
        kind: "preview",
        status: "previewed",
        reasonCodes: [],
        detail: {
          kind: "preview",
          previewRef,
          baseRevision: activationSnapshot.revision,
          status: "previewed",
        },
      };
      const finalResult: ControlFinalResult = {
        domainRecordRef: previewRef,
        envelope: successEnvelope as unknown as ControlEnvelope,
      };

      let writeResult;
      try {
        writeResult = await this.#repository.createPreview({
          metadata: {
            managementTenantId: this.#managementTenantId,
            actorRef: context.actorId,
            action: "deployments.preview",
            idempotencyKey: meta.idempotencyKey,
            requestHash: meta.requestHash,
            event,
          },
          record,
          finalResult,
        });
      } catch (error: unknown) {
        return this.#previewRepositoryFailure(error, meta);
      }

      let persisted;
      try {
        persisted = await this.#repository.getIdempotency({
          managementTenantId: this.#managementTenantId,
          action: "deployments.preview",
          idempotencyKey: meta.idempotencyKey,
        });
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }

      try {
        if (
          writeResult.replayed !== false ||
          !isDeepStrictEqual(writeResult.record, record) ||
          writeResult.event.managementTenantId !== this.#managementTenantId ||
          writeResult.event.actorRef !== context.actorId ||
          writeResult.event.action !== event.action ||
          writeResult.event.objectRef !== event.objectRef ||
          writeResult.event.kind !== event.kind ||
          writeResult.event.status !== event.status ||
          !isDeepStrictEqual(writeResult.event.reasonCodes, event.reasonCodes) ||
          !isDeepStrictEqual(writeResult.event.detail, event.detail) ||
          writeResult.event.occurredAt !== createdAt ||
          typeof writeResult.event.eventId !== "string" ||
          !IDENTIFIER_PATTERN.test(writeResult.event.eventId) ||
          !Number.isSafeInteger(writeResult.event.sequence) ||
          writeResult.event.sequence <= 0
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        if (
          persisted === null ||
          persisted.status !== "completed" ||
          persisted.managementTenantId !== this.#managementTenantId ||
          persisted.action !== "deployments.preview" ||
          persisted.idempotencyKey !== meta.idempotencyKey ||
          persisted.requestHash !== meta.requestHash ||
          persisted.actorRef !== context.actorId ||
          persisted.createdAt !== createdAt ||
          compareRfc3339Instants(persisted.createdAt, persisted.expiresAt) !== -1 ||
          persisted.domainRecordRef !== previewRef ||
          persisted.finalResult === null ||
          persisted.finalResult.domainRecordRef !== previewRef
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        const persistedEnvelope = this.#assertWriteEnvelope(
          "deployments.preview",
          persisted.finalResult.envelope,
        );
        if (
          !isDeepStrictEqual(persistedEnvelope, successEnvelope) ||
          !replayedPreviewMatchesEnvelope(
            record,
            persistedEnvelope,
            this.#managementTenantId,
            context.actorId,
            previewRef,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        return persistedEnvelope;
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }
    });
  }

  async decideApproval(
    context: ExecutionContext,
    requestInput: ApprovalRequest,
    metaInput: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    const meta = parseWriteMeta(metaInput);
    const failure = authorizationFailure(context, this.#managementTenantId);
    if (failure !== null) {
      return this.#terminalWriteEnvelope("approvals.decide", meta, "blocked", failure);
    }

    return this.#runtime.coordinator.withMutation(async () => {
      const request = parseApprovalRequest(requestInput);
      if (request === null) {
        return this.#terminalWriteEnvelope(
          "approvals.decide",
          meta,
          "blocked",
          "approval_request_invalid",
        );
      }

      let expectedRequestHash: string;
      try {
        expectedRequestHash = canonicalControlHash({
          domain: "request",
          schemaVersion: request.schema_version,
          payload: {
            action: "approvals.decide",
            management_tenant_id: this.#managementTenantId,
            actor_ref: context.actorId,
            request,
          },
        }).hash;
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (expectedRequestHash !== meta.requestHash) {
        return this.#terminalWriteEnvelope(
          "approvals.decide",
          meta,
          "blocked",
          "request_hash_mismatch",
        );
      }

      let existingIdempotency;
      try {
        existingIdempotency = await this.#repository.getIdempotency({
          managementTenantId: this.#managementTenantId,
          action: "approvals.decide",
          idempotencyKey: meta.idempotencyKey,
        });
      } catch (error: unknown) {
        return this.#approvalPreflightReadFailure(error, meta);
      }
      if (existingIdempotency !== null) {
        const persistedIdempotency = existingIdempotency;
        if (
          persistedIdempotency.managementTenantId !== this.#managementTenantId ||
          persistedIdempotency.action !== "approvals.decide" ||
          persistedIdempotency.idempotencyKey !== meta.idempotencyKey
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        if (persistedIdempotency.requestHash !== meta.requestHash) {
          return this.#terminalWriteEnvelope(
            "approvals.decide",
            meta,
            "blocked",
            "approval_conflict",
          );
        }
        if (
          persistedIdempotency.status !== "completed" ||
          persistedIdempotency.actorRef !== context.actorId ||
          persistedIdempotency.domainRecordRef === null ||
          persistedIdempotency.finalResult === null ||
          persistedIdempotency.finalResult.domainRecordRef !==
            persistedIdempotency.domainRecordRef
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        let replayedApproval;
        try {
          replayedApproval = await this.#repository.getApproval({
            managementTenantId: this.#managementTenantId,
            approvalId: persistedIdempotency.domainRecordRef,
          });
        } catch (error: unknown) {
          return this.#approvalPreflightReadFailure(error, meta);
        }
        if (replayedApproval === null) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        const replayEnvelope = this.#assertWriteEnvelope(
          "approvals.decide",
          persistedIdempotency.finalResult.envelope,
        );
        if (
          !replayedApprovalMatchesEnvelope(
            replayedApproval,
            replayEnvelope,
            request,
            this.#managementTenantId,
            context.actorId,
            persistedIdempotency.domainRecordRef,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        return replayEnvelope;
      }

      let preview;
      try {
        preview = await this.#repository.getPreview({
          managementTenantId: this.#managementTenantId,
          previewRef: request.preview_ref,
        });
      } catch (error: unknown) {
        return this.#approvalPreflightReadFailure(error, meta);
      }
      if (preview === null) {
        return this.#terminalWriteEnvelope(
          "approvals.decide",
          meta,
          "blocked",
          "preview_not_found",
        );
      }

      try {
        if (
          !persistedPreviewIsStructurallyValidForApproval(
            preview,
            this.#managementTenantId,
            request.preview_ref,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }

      if (preview.consumed) {
        return this.#terminalWriteEnvelope(
          "approvals.decide",
          meta,
          "blocked",
          "preview_consumed",
        );
      }
      if (preview.creatorActorRef === context.actorId) {
        return this.#terminalWriteEnvelope(
          "approvals.decide",
          meta,
          "blocked",
          "approval_self_approval_forbidden",
        );
      }
      if (
        !preview.validation.baseMatches ||
        !preview.validation.desiredModulesValid ||
        !preview.validation.inventoryMatches ||
        !preview.validation.minimumActiveModules ||
        preview.validation.reasonCodes.length !== 0
      ) {
        return this.#terminalWriteEnvelope(
          "approvals.decide",
          meta,
          "blocked",
          "preview_not_approvable",
        );
      }

      const currentInventoryRefs = sortedModuleRefs(
        this.#inventory.map(inventoryModuleRef),
      );
      if (!moduleRefSetsEqual(preview.inventoryRefs, currentInventoryRefs)) {
        return this.#terminalWriteEnvelope(
          "approvals.decide",
          meta,
          "blocked",
          "inventory_drift",
        );
      }

      let decidedAt: string;
      let approvalId: string;
      try {
        decidedAt = this.#clock();
        const expiryComparison = compareRfc3339Instants(
          preview.expiresAt,
          decidedAt,
        );
        if (expiryComparison === null) {
          throw new TypeError("Approval time is not a valid RFC3339 instant.");
        }
        if (expiryComparison <= 0) {
          return this.#terminalWriteEnvelope(
            "approvals.decide",
            meta,
            "blocked",
            "preview_expired",
          );
        }
        approvalId = this.#idGenerator();
        if (
          typeof approvalId !== "string" ||
          !IDENTIFIER_PATTERN.test(approvalId)
        ) {
          throw new TypeError("The approval ID generator returned an invalid identifier.");
        }
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }

      const record: ModuleApprovalRecord = {
        managementTenantId: this.#managementTenantId,
        approvalId,
        previewRef: preview.previewRef,
        decision: request.decision,
        previewCanonicalHash: preview.canonicalHash,
        baseReleaseId: preview.baseReleaseId,
        baseRevision: preview.baseRevision,
        inventoryDigestSet: approvalInventoryDigestSet(preview.inventoryRefs),
        expiresAt: preview.expiresAt,
        reasonCode: request.reason_code,
        approverActorRef: context.actorId,
        decidedAt,
        consumed: false,
      };
      const successEnvelope = this.#assertWriteEnvelope("approvals.decide", {
        schema_version: request.schema_version,
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "success",
        data: {
          kind: "approval",
          approval_id: approvalId,
          preview_ref: preview.previewRef,
          decision: request.decision,
        },
        reason_codes: [],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });
      const eventStatus = request.decision === "approve" ? "approved" : "rejected";
      const event: DecideApprovalRequestMetadata["event"] = {
        action: "approvals.decide",
        objectRef: approvalId,
        kind: "approval",
        status: eventStatus,
        reasonCodes: [],
        detail: {
          kind: "approval",
          approvalId,
          previewRef: preview.previewRef,
          status: eventStatus,
        },
      };
      const finalResult: ControlFinalResult = {
        domainRecordRef: approvalId,
        envelope: successEnvelope as unknown as ControlEnvelope,
      };

      let writeResult;
      try {
        writeResult = await this.#repository.decideApproval({
          metadata: {
            managementTenantId: this.#managementTenantId,
            actorRef: context.actorId,
            action: "approvals.decide",
            idempotencyKey: meta.idempotencyKey,
            requestHash: meta.requestHash,
            event,
          },
          record,
          finalResult,
        });
      } catch (error: unknown) {
        return this.#approvalRepositoryFailure(error, meta);
      }

      let persisted;
      try {
        persisted = await this.#repository.getIdempotency({
          managementTenantId: this.#managementTenantId,
          action: "approvals.decide",
          idempotencyKey: meta.idempotencyKey,
        });
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }

      try {
        if (
          writeResult.replayed !== false ||
          !isDeepStrictEqual(writeResult.record, record) ||
          writeResult.event.managementTenantId !== this.#managementTenantId ||
          writeResult.event.actorRef !== context.actorId ||
          writeResult.event.action !== event.action ||
          writeResult.event.objectRef !== event.objectRef ||
          writeResult.event.kind !== event.kind ||
          writeResult.event.status !== event.status ||
          !isDeepStrictEqual(writeResult.event.reasonCodes, event.reasonCodes) ||
          !isDeepStrictEqual(writeResult.event.detail, event.detail) ||
          writeResult.event.occurredAt !== decidedAt ||
          typeof writeResult.event.eventId !== "string" ||
          !IDENTIFIER_PATTERN.test(writeResult.event.eventId) ||
          !Number.isSafeInteger(writeResult.event.sequence) ||
          writeResult.event.sequence <= 0
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        if (
          persisted === null ||
          persisted.status !== "completed" ||
          persisted.managementTenantId !== this.#managementTenantId ||
          persisted.action !== "approvals.decide" ||
          persisted.idempotencyKey !== meta.idempotencyKey ||
          persisted.requestHash !== meta.requestHash ||
          persisted.actorRef !== context.actorId ||
          persisted.createdAt !== decidedAt ||
          compareRfc3339Instants(persisted.createdAt, persisted.expiresAt) !== -1 ||
          persisted.domainRecordRef !== approvalId ||
          persisted.finalResult === null ||
          persisted.finalResult.domainRecordRef !== approvalId
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        const persistedEnvelope = this.#assertWriteEnvelope(
          "approvals.decide",
          persisted.finalResult.envelope,
        );
        if (
          !isDeepStrictEqual(persistedEnvelope, successEnvelope) ||
          !replayedApprovalMatchesEnvelope(
            record,
            persistedEnvelope,
            request,
            this.#managementTenantId,
            context.actorId,
            approvalId,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        return persistedEnvelope;
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }
    });
  }

  async #resumeDomainCommittedPublish(
    context: ExecutionContext,
    request: PublishRequest,
    meta: WriteMeta,
    existing: DeepReadonly<DomainCommittedModuleControlIdempotencyRecord>,
    attemptRepository: ModuleControlRepository &
      ModuleControlReadbackAttemptRepository,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    let release;
    let preview;
    let approval;
    try {
      [release, preview, approval] = await Promise.all([
        this.#repository.getRelease({
          managementTenantId: this.#managementTenantId,
          releaseId: existing.domainRecordRef,
        }),
        this.#repository.getPreview({
          managementTenantId: this.#managementTenantId,
          previewRef: request.preview_ref,
        }),
        this.#repository.getApproval({
          managementTenantId: this.#managementTenantId,
          approvalId: request.approval_id,
        }),
      ]);
    } catch (error: unknown) {
      return this.#runtime.coordinator.tripFatal(error);
    }
    if (
      release === null ||
      preview === null ||
      approval === null ||
      release.managementTenantId !== this.#managementTenantId ||
      release.releaseId !== existing.domainRecordRef ||
      release.status !== "published_pending_readback" ||
      release.readbackRef !== null ||
      release.reasonCodes.length !== 0 ||
      release.supersededByReleaseId !== null ||
      release.previewRef !== request.preview_ref ||
      release.approvalId !== request.approval_id ||
      release.publisherActorRef !== context.actorId ||
      release.createdAt !== existing.createdAt ||
      release.publishedAt !== null ||
      release.revision !== preview.baseRevision + 1 ||
      release.previousReleaseId !== preview.baseReleaseId ||
      !moduleRefSetsEqual(release.desiredModules, preview.desiredModules) ||
      !persistedPreviewIsStructurallyValidForApproval(
        preview,
        this.#managementTenantId,
        request.preview_ref,
      ) ||
      preview.consumed !== true ||
      approval.managementTenantId !== this.#managementTenantId ||
      approval.approvalId !== request.approval_id ||
      approval.previewRef !== preview.previewRef ||
      approval.previewCanonicalHash !== preview.canonicalHash ||
      approval.baseReleaseId !== preview.baseReleaseId ||
      approval.baseRevision !== preview.baseRevision ||
      approval.expiresAt !== preview.expiresAt ||
      approval.decision !== "approve" ||
      approval.consumed !== true ||
      approval.approverActorRef === preview.creatorActorRef ||
      !stringArraysEqual(
        approval.inventoryDigestSet,
        approvalInventoryDigestSet(preview.inventoryRefs),
      )
    ) {
      return this.#runtime.coordinator.tripFatal(
        new ModuleControlServiceError("state_output_invalid"),
      );
    }

    let priorAttempts;
    try {
      priorAttempts = await attemptRepository.getReadbackAttemptHistory({
        managementTenantId: this.#managementTenantId,
        releaseId: release.releaseId,
        revision: release.revision,
      });
    } catch (error: unknown) {
      return this.#runtime.coordinator.tripFatal(error);
    }
    if (priorAttempts.length !== 0) {
      return this.#runtime.coordinator.tripFatal(
        new ModuleControlServiceError("state_output_invalid"),
      );
    }

    let checkedAt: string;
    let attemptId: string;
    let readbackRef: string;
    try {
      checkedAt = this.#clock();
      attemptId = this.#idGenerator();
      readbackRef = this.#idGenerator();
      if (
        parseRfc3339Instant(checkedAt) === null ||
        !IDENTIFIER_PATTERN.test(attemptId) ||
        !IDENTIFIER_PATTERN.test(readbackRef)
      ) {
        throw new TypeError("Invalid resumed publish clock or identifier.");
      }
    } catch (error: unknown) {
      return this.#runtime.coordinator.tripFatal(error);
    }

    const desiredModules = sortedModuleRefs(release.desiredModules);
    let stage: ReturnType<ActivationAuthorityDriver["stageCandidate"]> | null =
      null;
    try {
      stage = this.#runtime.privateDriver.stageCandidate({
        releaseId: release.releaseId,
        revision: release.revision,
        activeModules: desiredModules,
      });
      const claim = await attemptRepository.claimReadbackAttempt({
        metadata: {
          managementTenantId: this.#managementTenantId,
          actorRef: context.actorId,
          action: "deployments.publish",
          idempotencyKey: meta.idempotencyKey,
          requestHash: meta.requestHash,
          requestId: meta.requestId,
          traceId: meta.traceId,
          auditId: meta.auditId,
        },
        attemptId,
        readbackRef,
        releaseId: release.releaseId,
        revision: release.revision,
        desiredModules,
        ownerBootId: this.#runtime.ownerBootId,
        claimedAt: checkedAt,
      });
      if (
        claim.disposition !== "created" ||
        !claimedAttemptMatches(claim.attempt, {
          action: "deployments.publish",
          managementTenantId: this.#managementTenantId,
          attemptId,
          idempotencyKey: meta.idempotencyKey,
          requestHash: meta.requestHash,
          actorRef: context.actorId,
          requestId: meta.requestId,
          traceId: meta.traceId,
          auditId: meta.auditId,
          releaseId: release.releaseId,
          revision: release.revision,
          desiredModules,
          readbackRef,
          claimedAt: checkedAt,
        })
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }

      let observed: ModuleActivationSnapshot | null;
      try {
        observed = this.#runtime.privateDriver.candidateSnapshot(stage);
      } catch {
        observed = null;
      }
      let proof: ReturnType<ActivationAuthorityDriver["verifyCandidate"]> | null =
        null;
      let observation: ReadbackAttemptObservation;
      if (
        observed !== null &&
        observed.releaseId === release.releaseId &&
        observed.revision === release.revision &&
        moduleRefSetsEqual(observed.activeModules, desiredModules)
      ) {
        proof = this.#runtime.privateDriver.verifyCandidate(stage, {
          status: "verified",
          releaseId: observed.releaseId,
          revision: observed.revision,
          activeModules: observed.activeModules,
        });
        observation = {
          status: "verified",
          appliedReleaseId: release.releaseId,
          appliedRevision: release.revision,
          appliedModules: desiredModules,
          reasonCodes: [],
          checkedAt,
        };
      } else if (observed !== null) {
        observation = {
          status: "mismatch",
          appliedReleaseId: observed.releaseId,
          appliedRevision: observed.revision,
          appliedModules: observed.activeModules,
          reasonCodes: ["runtime_readback_mismatch"],
          checkedAt,
        };
      } else {
        observation = {
          status: "unknown",
          appliedReleaseId: null,
          appliedRevision: null,
          appliedModules: [],
          reasonCodes: ["runtime_readback_unknown"],
          checkedAt,
        };
      }
      const finalEnvelope = this.#assertWriteEnvelope(
        "deployments.publish",
        {
          schema_version: request.schema_version,
          request_id: meta.requestId,
          trace_id: meta.traceId,
          audit_id: meta.auditId,
          status:
            observation.status === "verified" ? "success" : "manual_review",
          data: {
            kind: "release",
            release_id: release.releaseId,
            revision: release.revision,
            active_modules: desiredModules.map(hashModuleRef),
          },
          reason_codes: observation.reasonCodes,
          readback: {
            status: observation.status,
            release_id: release.releaseId,
            revision: release.revision,
          },
        },
      );
      const finalResult: ControlFinalResult = {
        domainRecordRef: release.releaseId,
        envelope: finalEnvelope as unknown as ControlEnvelope,
      };
      const finalization = await attemptRepository.finalizeReadbackAndComplete({
        attemptId,
        ownerCapability: claim.ownerCapability,
        observation,
        finalResult,
        finalizedAt: checkedAt,
      });
      if (
        finalization.disposition !== "finalized" ||
        finalization.replayed !== false ||
        finalization.idempotency.managementTenantId !==
          this.#managementTenantId ||
        finalization.idempotency.action !== "deployments.publish" ||
        finalization.idempotency.idempotencyKey !== meta.idempotencyKey ||
        finalization.idempotency.requestHash !== meta.requestHash ||
        finalization.idempotency.actorRef !== context.actorId ||
        finalization.idempotency.status !== "completed" ||
        finalization.idempotency.domainRecordRef !== release.releaseId ||
        finalization.idempotency.createdAt !== existing.createdAt ||
        !isDeepStrictEqual(finalization.idempotency.finalResult, finalResult) ||
        !isDeepStrictEqual(finalization.finalResult, finalResult) ||
        finalization.attempt.action !== "deployments.publish" ||
        finalization.attempt.attemptId !== attemptId ||
        finalization.attempt.phase !== "finalized" ||
        finalization.attempt.terminalStatus !== observation.status ||
        finalization.reconciliationEvent.action !== "deployments.publish" ||
        finalization.reconciliationEvent.status !== observation.status ||
        finalization.completionEvent.action !== "deployments.publish" ||
        finalization.completionEvent.status !== "completed"
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }
      const persistedEnvelope = this.#assertWriteEnvelope(
        "deployments.publish",
        finalization.idempotency.finalResult.envelope,
      );
      if (
        !isDeepStrictEqual(persistedEnvelope, finalEnvelope) ||
        !publishedReleaseMatchesEnvelope(
          finalization.release,
          finalization.readback,
          persistedEnvelope,
          request,
          this.#managementTenantId,
          context.actorId,
        )
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }
      let persistedIdempotency;
      let persistedRelease;
      let persistedReadback;
      try {
        [persistedIdempotency, persistedRelease, persistedReadback] =
          await Promise.all([
            this.#repository.getIdempotency({
              managementTenantId: this.#managementTenantId,
              action: "deployments.publish",
              idempotencyKey: meta.idempotencyKey,
            }),
            this.#repository.getRelease({
              managementTenantId: this.#managementTenantId,
              releaseId: release.releaseId,
            }),
            this.#repository.getReadback({
              managementTenantId: this.#managementTenantId,
              releaseId: release.releaseId,
            }),
          ]);
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (
        !isDeepStrictEqual(persistedIdempotency, finalization.idempotency) ||
        !isDeepStrictEqual(persistedRelease, finalization.release) ||
        !isDeepStrictEqual(persistedReadback, finalization.readback)
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }
      if (proof === null) {
        this.#runtime.privateDriver.abortCandidate(stage);
      } else {
        this.#runtime.privateDriver.commitCandidate(proof);
      }
      stage = null;
      return persistedEnvelope;
    } catch (error: unknown) {
      if (stage !== null) {
        try {
          this.#runtime.privateDriver.abortCandidate(stage);
        } catch {
          // The fatal readiness fence below is authoritative if cleanup fails.
        }
      }
      if (error instanceof RuntimeMutationFatalError) throw error;
      return this.#runtime.coordinator.tripFatal(error);
    }
  }

  async publish(
    context: ExecutionContext,
    requestInput: PublishRequest,
    metaInput: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    const meta = parseWriteMeta(metaInput);
    const failure = authorizationFailure(context, this.#managementTenantId);
    if (failure !== null) {
      return this.#terminalWriteEnvelope(
        "deployments.publish",
        meta,
        "blocked",
        failure,
      );
    }

    return this.#runtime.coordinator.withMutation(async () => {
      const request = parsePublishRequest(requestInput);
      if (request === null) {
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "blocked",
          "publish_request_invalid",
        );
      }

      let expectedRequestHash: string;
      try {
        expectedRequestHash = canonicalControlHash({
          domain: "request",
          schemaVersion: request.schema_version,
          payload: {
            action: "deployments.publish",
            management_tenant_id: this.#managementTenantId,
            actor_ref: context.actorId,
            request,
          },
        }).hash;
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (expectedRequestHash !== meta.requestHash) {
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "blocked",
          "request_hash_mismatch",
        );
      }

      let existingIdempotency;
      try {
        existingIdempotency = await this.#repository.getIdempotency({
          managementTenantId: this.#managementTenantId,
          action: "deployments.publish",
          idempotencyKey: meta.idempotencyKey,
        });
      } catch (error: unknown) {
        return this.#publishPreflightReadFailure(error, meta);
      }

      if (existingIdempotency !== null) {
        if (
          existingIdempotency.managementTenantId !== this.#managementTenantId ||
          existingIdempotency.action !== "deployments.publish" ||
          existingIdempotency.idempotencyKey !== meta.idempotencyKey
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        if (existingIdempotency.requestHash !== meta.requestHash) {
          return this.#terminalWriteEnvelope(
            "deployments.publish",
            meta,
            "blocked",
            "idempotency_conflict",
          );
        }
        if (
          existingIdempotency.actorRef !== context.actorId ||
          existingIdempotency.domainRecordRef === null
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        if (existingIdempotency.status === "domain_committed") {
          if (
            existingIdempotency.finalResult !== null ||
            !hasReadbackAttemptRepository(this.#repository)
          ) {
            return this.#runtime.coordinator.tripFatal(
              new ModuleControlServiceError("state_output_invalid"),
            );
          }
          return this.#resumeDomainCommittedPublish(
            context,
            request,
            meta,
            existingIdempotency,
            this.#repository,
          );
        }
        if (
          existingIdempotency.status !== "completed" ||
          existingIdempotency.finalResult === null ||
          existingIdempotency.finalResult.domainRecordRef !==
            existingIdempotency.domainRecordRef
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        let release;
        let readback;
        try {
          [release, readback] = await Promise.all([
            this.#repository.getRelease({
              managementTenantId: this.#managementTenantId,
              releaseId: existingIdempotency.domainRecordRef,
            }),
            this.#repository.getReadback({
              managementTenantId: this.#managementTenantId,
              releaseId: existingIdempotency.domainRecordRef,
            }),
          ]);
        } catch (error: unknown) {
          return this.#publishPreflightReadFailure(error, meta);
        }
        if (release === null) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        const replayEnvelope = this.#assertWriteEnvelope(
          "deployments.publish",
          existingIdempotency.finalResult.envelope,
        );
        if (
          !publishedReleaseMatchesEnvelope(
            release,
            readback,
            replayEnvelope,
            request,
            this.#managementTenantId,
            context.actorId,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        return replayEnvelope;
      }

      if (!hasReadbackAttemptRepository(this.#repository)) {
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "unavailable",
          "repository_unavailable",
        );
      }
      const attemptRepository = this.#repository;

      let newestUnresolved;
      try {
        newestUnresolved = await this.#repository.getNewestUnresolvedRelease();
      } catch (error: unknown) {
        return this.#publishPreflightReadFailure(error, meta);
      }
      if (newestUnresolved !== null) {
        if (
          newestUnresolved.managementTenantId !== this.#managementTenantId ||
          (newestUnresolved.status !== "published_pending_readback" &&
            newestUnresolved.status !== "manual_review")
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "blocked",
          "unresolved_release_exists",
        );
      }

      let preview;
      let approval;
      let state;
      let exactActiveRelease;
      try {
        preview = await this.#repository.getPreview({
          managementTenantId: this.#managementTenantId,
          previewRef: request.preview_ref,
        });
        if (preview === null) {
          return this.#terminalWriteEnvelope(
            "deployments.publish",
            meta,
            "blocked",
            "preview_not_found",
          );
        }
        approval = await this.#repository.getApproval({
          managementTenantId: this.#managementTenantId,
          approvalId: request.approval_id,
        });
        if (approval === null) {
          return this.#terminalWriteEnvelope(
            "deployments.publish",
            meta,
            "blocked",
            "approval_not_found",
          );
        }
        state = await this.#repository.getControlState();
        exactActiveRelease = await this.#repository.getActiveRelease();
      } catch (error: unknown) {
        return this.#publishPreflightReadFailure(error, meta);
      }

      try {
        if (
          !persistedPreviewIsStructurallyValidForApproval(
            preview,
            this.#managementTenantId,
            request.preview_ref,
          ) ||
          approval.managementTenantId !== this.#managementTenantId ||
          approval.approvalId !== request.approval_id ||
          approval.previewRef !== preview.previewRef ||
          approval.previewCanonicalHash !== preview.canonicalHash ||
          approval.baseReleaseId !== preview.baseReleaseId ||
          approval.baseRevision !== preview.baseRevision ||
          approval.expiresAt !== preview.expiresAt ||
          !stringArraysEqual(
            approval.inventoryDigestSet,
            approvalInventoryDigestSet(preview.inventoryRefs),
          ) ||
          approval.approverActorRef === preview.creatorActorRef ||
          compareRfc3339Instants(approval.decidedAt, approval.expiresAt) !== -1
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }

      if (preview.consumed) {
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "blocked",
          "preview_consumed",
        );
      }
      if (approval.consumed) {
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "blocked",
          "approval_consumed",
        );
      }
      if (approval.decision !== "approve") {
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "blocked",
          "approval_not_approved",
        );
      }
      if (
        !preview.validation.baseMatches ||
        !preview.validation.desiredModulesValid ||
        !preview.validation.inventoryMatches ||
        !preview.validation.minimumActiveModules ||
        preview.validation.reasonCodes.length !== 0 ||
        preview.desiredModules.length === 0
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }

      const activationSnapshot = this.#runtime.activationSnapshot();
      let exactActiveReadback: DeepReadonly<ModuleReadbackRecord> | null = null;
      if (exactActiveRelease !== null) {
        try {
          exactActiveReadback = await this.#repository.getReadback({
            managementTenantId: this.#managementTenantId,
            releaseId: exactActiveRelease.releaseId,
          });
        } catch (error: unknown) {
          return this.#publishPreflightReadFailure(error, meta);
        }
      }

      try {
        if (
          !isDeepStrictEqual(exactActiveRelease, state.activeRelease) ||
          !previewBaseAgreesWithRuntime(
            state,
            activationSnapshot,
            this.#managementTenantId,
            exactActiveReadback,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }

      if (
        preview.baseReleaseId !== activationSnapshot.releaseId ||
        preview.baseRevision !== activationSnapshot.revision
      ) {
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "blocked",
          "preview_base_stale",
        );
      }

      const currentInventoryRefs = sortedModuleRefs(
        this.#inventory.map(inventoryModuleRef),
      );
      if (!moduleRefSetsEqual(preview.inventoryRefs, currentInventoryRefs)) {
        return this.#terminalWriteEnvelope(
          "deployments.publish",
          meta,
          "blocked",
          "inventory_drift",
        );
      }
      try {
        for (const registration of state.registrations) {
          if (registration.managementTenantId !== this.#managementTenantId) {
            return this.#runtime.coordinator.tripFatal(
              new ModuleControlServiceError("management_tenant_state_mismatch"),
            );
          }
        }
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }

      const inventoryByLogicalKey = new Map(
        currentInventoryRefs.map((ref) => [moduleLogicalKey(ref), ref]),
      );
      for (const desired of preview.desiredModules) {
        const inventoryRef = inventoryByLogicalKey.get(moduleLogicalKey(desired));
        if (inventoryRef === undefined) {
          return this.#terminalWriteEnvelope(
            "deployments.publish",
            meta,
            "blocked",
            "inventory_module_not_found",
          );
        }
        if (inventoryRef.descriptorDigest !== desired.descriptorDigest) {
          return this.#terminalWriteEnvelope(
            "deployments.publish",
            meta,
            "blocked",
            "inventory_descriptor_mismatch",
          );
        }
        const registrations = state.registrations.filter(
          (registration) =>
            registration.moduleId === desired.moduleId &&
            registration.version === desired.version,
        );
        if (
          !registrations.some(
            (registration) =>
              registration.descriptorDigest === desired.descriptorDigest,
          )
        ) {
          return this.#terminalWriteEnvelope(
            "deployments.publish",
            meta,
            "blocked",
            registrations.length === 0
              ? "module_not_registered"
              : "registration_descriptor_mismatch",
          );
        }
      }

      const expectedDiff = moduleRefDiff(
        sortedModuleRefs(activationSnapshot.activeModules),
        sortedModuleRefs(preview.desiredModules),
      );
      if (
        !moduleRefSetsEqual(preview.diff.added, expectedDiff.added) ||
        !moduleRefSetsEqual(preview.diff.removed, expectedDiff.removed) ||
        !moduleRefSetsEqual(preview.diff.retained, expectedDiff.retained)
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }

      let createdAt: string;
      let releaseId: string;
      let attemptId: string;
      let readbackRef: string;
      try {
        createdAt = this.#clock();
        const expiryComparison = compareRfc3339Instants(
          preview.expiresAt,
          createdAt,
        );
        if (expiryComparison === null) {
          throw new TypeError("Publish time is not a valid RFC3339 instant.");
        }
        if (expiryComparison <= 0) {
          return this.#terminalWriteEnvelope(
            "deployments.publish",
            meta,
            "blocked",
            "preview_expired",
          );
        }
        releaseId = this.#idGenerator();
        attemptId = this.#idGenerator();
        readbackRef = this.#idGenerator();
        if (
          !IDENTIFIER_PATTERN.test(releaseId) ||
          !IDENTIFIER_PATTERN.test(attemptId) ||
          !IDENTIFIER_PATTERN.test(readbackRef)
        ) {
          throw new TypeError("The publish ID generator returned an invalid identifier.");
        }
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }

      const desiredModules = sortedModuleRefs(preview.desiredModules);
      const revision = preview.baseRevision + 1;
      const record: ModuleReleaseRecord = {
        managementTenantId: this.#managementTenantId,
        releaseId,
        revision,
        desiredModules,
        previousReleaseId: preview.baseReleaseId,
        previewRef: preview.previewRef,
        approvalId: approval.approvalId,
        publisherActorRef: context.actorId,
        createdAt,
        publishedAt: null,
        status: "published_pending_readback",
        readbackRef: null,
        reasonCodes: [],
        supersededByReleaseId: null,
      };
      const event: PublishReleaseRequestMetadata["event"] = {
        action: "deployments.publish",
        objectRef: releaseId,
        kind: "release",
        status: "published_pending_readback",
        reasonCodes: [],
        detail: {
          kind: "release",
          releaseId,
          revision,
          status: "published_pending_readback",
        },
      };

      let writeResult;
      try {
        writeResult = await this.#repository.publishRelease({
          metadata: {
            managementTenantId: this.#managementTenantId,
            actorRef: context.actorId,
            action: "deployments.publish",
            idempotencyKey: meta.idempotencyKey,
            requestHash: meta.requestHash,
            event,
          },
          record,
        });
      } catch (error: unknown) {
        return this.#publishRepositoryFailure(error, meta);
      }

      let domainIdempotency;
      let persistedPendingRelease;
      let consumedPreview;
      let consumedApproval;
      try {
        [
          domainIdempotency,
          persistedPendingRelease,
          consumedPreview,
          consumedApproval,
        ] = await Promise.all([
          this.#repository.getIdempotency({
            managementTenantId: this.#managementTenantId,
            action: "deployments.publish",
            idempotencyKey: meta.idempotencyKey,
          }),
          this.#repository.getRelease({
            managementTenantId: this.#managementTenantId,
            releaseId,
          }),
          this.#repository.getPreview({
            managementTenantId: this.#managementTenantId,
            previewRef: preview.previewRef,
          }),
          this.#repository.getApproval({
            managementTenantId: this.#managementTenantId,
            approvalId: approval.approvalId,
          }),
        ]);
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (
        writeResult.replayed !== false ||
        !isDeepStrictEqual(writeResult.record, record) ||
        writeResult.event.managementTenantId !== this.#managementTenantId ||
        writeResult.event.actorRef !== context.actorId ||
        writeResult.event.action !== event.action ||
        writeResult.event.objectRef !== event.objectRef ||
        writeResult.event.kind !== event.kind ||
        writeResult.event.status !== event.status ||
        !isDeepStrictEqual(writeResult.event.reasonCodes, event.reasonCodes) ||
        !isDeepStrictEqual(writeResult.event.detail, event.detail) ||
        writeResult.event.occurredAt !== createdAt ||
        !IDENTIFIER_PATTERN.test(writeResult.event.eventId) ||
        !Number.isSafeInteger(writeResult.event.sequence) ||
        writeResult.event.sequence <= 0 ||
        domainIdempotency === null ||
        domainIdempotency.managementTenantId !== this.#managementTenantId ||
        domainIdempotency.action !== "deployments.publish" ||
        domainIdempotency.idempotencyKey !== meta.idempotencyKey ||
        domainIdempotency.requestHash !== meta.requestHash ||
        domainIdempotency.actorRef !== context.actorId ||
        domainIdempotency.status !== "domain_committed" ||
        domainIdempotency.domainRecordRef !== releaseId ||
        domainIdempotency.finalResult !== null ||
        domainIdempotency.createdAt !== createdAt ||
        compareRfc3339Instants(
          domainIdempotency.createdAt,
          domainIdempotency.expiresAt,
        ) !== -1 ||
        !isDeepStrictEqual(persistedPendingRelease, record) ||
        consumedPreview === null ||
        !isDeepStrictEqual(consumedPreview, { ...preview, consumed: true }) ||
        consumedApproval === null ||
        !isDeepStrictEqual(consumedApproval, { ...approval, consumed: true })
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }

      let stage: ReturnType<ActivationAuthorityDriver["stageCandidate"]> | null =
        null;
      try {
        stage = this.#runtime.privateDriver.stageCandidate({
          releaseId,
          revision,
          activeModules: desiredModules,
        });
        const claim = await attemptRepository.claimReadbackAttempt({
          metadata: {
            managementTenantId: this.#managementTenantId,
            actorRef: context.actorId,
            action: "deployments.publish",
            idempotencyKey: meta.idempotencyKey,
            requestHash: meta.requestHash,
            requestId: meta.requestId,
            traceId: meta.traceId,
            auditId: meta.auditId,
          },
          attemptId,
          readbackRef,
          releaseId,
          revision,
          desiredModules,
          ownerBootId: this.#runtime.ownerBootId,
          claimedAt: createdAt,
        });
        if (
          claim.disposition !== "created" ||
          !claimedAttemptMatches(claim.attempt, {
            action: "deployments.publish",
            managementTenantId: this.#managementTenantId,
            attemptId,
            idempotencyKey: meta.idempotencyKey,
            requestHash: meta.requestHash,
            actorRef: context.actorId,
            requestId: meta.requestId,
            traceId: meta.traceId,
            auditId: meta.auditId,
            releaseId,
            revision,
            desiredModules,
            readbackRef,
            claimedAt: createdAt,
          })
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        let observed: ModuleActivationSnapshot | null;
        try {
          observed = this.#runtime.privateDriver.candidateSnapshot(stage);
        } catch {
          observed = null;
        }
        let proof: ReturnType<
          ActivationAuthorityDriver["verifyCandidate"]
        > | null = null;
        let observation: ReadbackAttemptObservation;
        if (
          observed !== null &&
          observed.releaseId === releaseId &&
          observed.revision === revision &&
          moduleRefSetsEqual(observed.activeModules, desiredModules)
        ) {
          proof = this.#runtime.privateDriver.verifyCandidate(stage, {
            status: "verified",
            releaseId: observed.releaseId,
            revision: observed.revision,
            activeModules: observed.activeModules,
          });
          observation = {
            status: "verified",
            appliedReleaseId: releaseId,
            appliedRevision: revision,
            appliedModules: desiredModules,
            reasonCodes: [],
            checkedAt: createdAt,
          };
        } else if (observed !== null) {
          observation = {
            status: "mismatch",
            appliedReleaseId: observed.releaseId,
            appliedRevision: observed.revision,
            appliedModules: observed.activeModules,
            reasonCodes: ["runtime_readback_mismatch"],
            checkedAt: createdAt,
          };
        } else {
          observation = {
            status: "unknown",
            appliedReleaseId: null,
            appliedRevision: null,
            appliedModules: [],
            reasonCodes: ["runtime_readback_unknown"],
            checkedAt: createdAt,
          };
        }
        const finalEnvelope = this.#assertWriteEnvelope(
          "deployments.publish",
          {
            schema_version: request.schema_version,
            request_id: meta.requestId,
            trace_id: meta.traceId,
            audit_id: meta.auditId,
            status:
              observation.status === "verified" ? "success" : "manual_review",
            data: {
              kind: "release",
              release_id: releaseId,
              revision,
              active_modules: desiredModules.map(hashModuleRef),
            },
            reason_codes: observation.reasonCodes,
            readback: {
              status: observation.status,
              release_id: releaseId,
              revision,
            },
          },
        );
        const finalResult: ControlFinalResult = {
          domainRecordRef: releaseId,
          envelope: finalEnvelope as unknown as ControlEnvelope,
        };
        const finalization: ReadbackFinalizationResult =
          await attemptRepository.finalizeReadbackAndComplete({
            attemptId,
            ownerCapability: claim.ownerCapability,
            observation,
            finalResult,
            finalizedAt: createdAt,
          });

        const expectedReadback: ModuleReadbackRecord = {
          managementTenantId: this.#managementTenantId,
          readbackRef,
          releaseId,
          attemptId,
          revision,
          appliedReleaseId: observation.appliedReleaseId,
          appliedRevision: observation.appliedRevision,
          appliedModules: observation.appliedModules,
          status: observation.status,
          reasonCodes: observation.reasonCodes,
          checkedAt: createdAt,
        } as ModuleReadbackRecord;
        const expectedRelease: ModuleReleaseRecord =
          observation.status === "verified"
            ? {
                ...record,
                publishedAt: createdAt,
                status: "active_verified",
                readbackRef,
              }
            : {
                ...record,
                publishedAt: createdAt,
                status: "manual_review",
                readbackRef,
                reasonCodes: observation.reasonCodes as readonly [
                  string,
                  ...string[],
                ],
              };
        const finalizedAttempt = finalization.attempt;
        if (
          finalization.disposition !== "finalized" ||
          finalization.replayed !== false ||
          !isDeepStrictEqual(finalization.readback, expectedReadback) ||
          !isDeepStrictEqual(finalization.release, expectedRelease) ||
          finalization.idempotency.managementTenantId !==
            this.#managementTenantId ||
          finalization.idempotency.action !== "deployments.publish" ||
          finalization.idempotency.idempotencyKey !== meta.idempotencyKey ||
          finalization.idempotency.requestHash !== meta.requestHash ||
          finalization.idempotency.actorRef !== context.actorId ||
          finalization.idempotency.status !== "completed" ||
          finalization.idempotency.domainRecordRef !== releaseId ||
          finalization.idempotency.createdAt !== createdAt ||
          !isDeepStrictEqual(finalization.idempotency.finalResult, finalResult) ||
          !isDeepStrictEqual(finalization.finalResult, finalResult) ||
          finalizedAttempt.phase !== "finalized" ||
          finalizedAttempt.attemptId !== attemptId ||
          finalizedAttempt.releaseId !== releaseId ||
          finalizedAttempt.revision !== revision ||
          finalizedAttempt.readbackRef !== readbackRef ||
          finalizedAttempt.terminalStatus !== observation.status ||
          finalizedAttempt.appliedReleaseId !== observation.appliedReleaseId ||
          finalizedAttempt.appliedRevision !== observation.appliedRevision ||
          !moduleRefSetsEqual(
            finalizedAttempt.appliedModules,
            observation.appliedModules,
          ) ||
          !stringArraysEqual(
            finalizedAttempt.reasonCodes,
            observation.reasonCodes,
          ) ||
          finalizedAttempt.checkedAt !== createdAt ||
          finalizedAttempt.finalizedAt !== createdAt ||
          finalizedAttempt.finalizedByActorRef !== context.actorId ||
          finalizedAttempt.reconciliationEventSequence !==
            finalization.reconciliationEvent.sequence ||
          finalizedAttempt.completionEventSequence !==
            finalization.completionEvent.sequence ||
          finalization.reconciliationEvent.managementTenantId !==
            this.#managementTenantId ||
          finalization.reconciliationEvent.actorRef !== context.actorId ||
          finalization.reconciliationEvent.action !== "deployments.publish" ||
          finalization.reconciliationEvent.objectRef !== releaseId ||
          finalization.reconciliationEvent.kind !== "reconciliation" ||
          finalization.reconciliationEvent.status !== observation.status ||
          !stringArraysEqual(
            finalization.reconciliationEvent.reasonCodes,
            observation.reasonCodes,
          ) ||
          !isDeepStrictEqual(finalization.reconciliationEvent.detail, {
            kind: "reconciliation",
            releaseId,
            revision,
            readbackRef,
            status: observation.status,
          }) ||
          finalization.reconciliationEvent.occurredAt !== createdAt ||
          finalization.completionEvent.managementTenantId !==
            this.#managementTenantId ||
          finalization.completionEvent.actorRef !== context.actorId ||
          finalization.completionEvent.action !== "deployments.publish" ||
          finalization.completionEvent.objectRef !==
            `idempotency:deployments.publish:${meta.idempotencyKey}` ||
          finalization.completionEvent.kind !== "idempotency" ||
          finalization.completionEvent.status !== "completed" ||
          finalization.completionEvent.reasonCodes.length !== 0 ||
          !isDeepStrictEqual(finalization.completionEvent.detail, {
            kind: "idempotency",
            recordRef: `idempotency:deployments.publish:${meta.idempotencyKey}`,
            domainRecordRef: releaseId,
            status: "completed",
          }) ||
          finalization.completionEvent.occurredAt !== createdAt
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        let persistedFinalIdempotency;
        let persistedRelease;
        let persistedReadback;
        let persistedPreview;
        let persistedApproval;
        let persistedState;
        let persistedPreviousRelease: DeepReadonly<ModuleReleaseRecord> | null =
          null;
        try {
          [
            persistedFinalIdempotency,
            persistedRelease,
            persistedReadback,
            persistedPreview,
            persistedApproval,
            persistedState,
          ] = await Promise.all([
            this.#repository.getIdempotency({
              managementTenantId: this.#managementTenantId,
              action: "deployments.publish",
              idempotencyKey: meta.idempotencyKey,
            }),
            this.#repository.getRelease({
              managementTenantId: this.#managementTenantId,
              releaseId,
            }),
            this.#repository.getReadback({
              managementTenantId: this.#managementTenantId,
              releaseId,
            }),
            this.#repository.getPreview({
              managementTenantId: this.#managementTenantId,
              previewRef: preview.previewRef,
            }),
            this.#repository.getApproval({
              managementTenantId: this.#managementTenantId,
              approvalId: approval.approvalId,
            }),
            this.#repository.getControlState(),
          ]);
          if (record.previousReleaseId !== null) {
            persistedPreviousRelease = await this.#repository.getRelease({
              managementTenantId: this.#managementTenantId,
              releaseId: record.previousReleaseId,
            });
          }
        } catch (error: unknown) {
          return this.#runtime.coordinator.tripFatal(error);
        }
        const matchingHistory = persistedState.releaseHistory.filter(
          (entry) => entry.release.releaseId === releaseId,
        );
        const activeStateMatches =
          observation.status === "verified"
            ? isDeepStrictEqual(
                persistedState.activeRelease,
                finalization.release,
              ) &&
              persistedState.activeRevision === revision &&
              moduleRefSetsEqual(persistedState.activeModules, desiredModules)
            : isDeepStrictEqual(persistedState.activeRelease, state.activeRelease) &&
              persistedState.activeRevision === state.activeRevision &&
              moduleRefSetsEqual(
                persistedState.activeModules,
                state.activeModules,
              );
        const previousReleaseMatches =
          record.previousReleaseId === null
            ? persistedPreviousRelease === null
            : observation.status === "verified"
              ? persistedPreviousRelease !== null &&
                persistedPreviousRelease.status === "superseded" &&
                persistedPreviousRelease.supersededByReleaseId === releaseId
              : isDeepStrictEqual(
                  persistedPreviousRelease,
                  exactActiveRelease,
                );
        if (
          !isDeepStrictEqual(
            persistedFinalIdempotency,
            finalization.idempotency,
          ) ||
          !isDeepStrictEqual(persistedRelease, finalization.release) ||
          !isDeepStrictEqual(persistedReadback, finalization.readback) ||
          persistedPreview === null ||
          !isDeepStrictEqual(persistedPreview, { ...preview, consumed: true }) ||
          persistedApproval === null ||
          !isDeepStrictEqual(persistedApproval, {
            ...approval,
            consumed: true,
          }) ||
          persistedState.managementTenantId !== this.#managementTenantId ||
          !activeStateMatches ||
          !isDeepStrictEqual(persistedState.latestReadback, finalization.readback) ||
          matchingHistory.length !== 1 ||
          !isDeepStrictEqual(matchingHistory[0]!.release, finalization.release) ||
          matchingHistory[0]!.intent !== preview.intent ||
          matchingHistory[0]!.rollbackTargetReleaseId !==
            (preview.intent === "rollback" ? preview.targetReleaseId : null) ||
          !previousReleaseMatches
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        const persistedEnvelope = this.#assertWriteEnvelope(
          "deployments.publish",
          finalization.idempotency.finalResult.envelope,
        );
        if (
          !isDeepStrictEqual(persistedEnvelope, finalEnvelope) ||
          !publishedReleaseMatchesEnvelope(
            finalization.release,
            finalization.readback,
            persistedEnvelope,
            request,
            this.#managementTenantId,
            context.actorId,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        if (proof === null) {
          this.#runtime.privateDriver.abortCandidate(stage);
        } else {
          this.#runtime.privateDriver.commitCandidate(proof);
        }
        stage = null;
        return persistedEnvelope;
      } catch (error: unknown) {
        if (stage !== null) {
          try {
            this.#runtime.privateDriver.abortCandidate(stage);
          } catch {
            // The fatal readiness fence below is authoritative if cleanup fails.
          }
        }
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }
    });
  }

  async reconcile(
    context: ExecutionContext,
    requestInput: ReconcileRequest,
    metaInput: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    const meta = parseWriteMeta(metaInput);
    const failure = reconcileAuthorizationFailure(
      context,
      this.#managementTenantId,
    );
    if (failure !== null) {
      return this.#terminalWriteEnvelope(
        "deployments.reconcile",
        meta,
        "blocked",
        failure,
      );
    }

    return this.#runtime.coordinator.withMutation(async () => {
      const request = parseReconcileRequest(requestInput);
      if (request === null) {
        return this.#terminalWriteEnvelope(
          "deployments.reconcile",
          meta,
          "blocked",
          "reconcile_request_invalid",
        );
      }
      let expectedRequestHash: string;
      try {
        expectedRequestHash = canonicalControlHash({
          domain: "request",
          schemaVersion: request.schema_version,
          payload: {
            action: "deployments.reconcile",
            management_tenant_id: this.#managementTenantId,
            actor_ref: context.actorId,
            request,
          },
        }).hash;
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (expectedRequestHash !== meta.requestHash) {
        return this.#terminalWriteEnvelope(
          "deployments.reconcile",
          meta,
          "blocked",
          "request_hash_mismatch",
        );
      }

      let existingIdempotency;
      try {
        existingIdempotency = await this.#repository.getIdempotency({
          managementTenantId: this.#managementTenantId,
          action: "deployments.reconcile",
          idempotencyKey: meta.idempotencyKey,
        });
      } catch (error: unknown) {
        if (
          error instanceof ModuleControlRepositoryError &&
          error.code !== "closed"
        ) {
          return this.#runtime.coordinator.tripFatal(error);
        }
        return this.#terminalWriteEnvelope(
          "deployments.reconcile",
          meta,
          "unavailable",
          "repository_unavailable",
        );
      }

      if (existingIdempotency !== null) {
        if (
          existingIdempotency.managementTenantId !== this.#managementTenantId ||
          existingIdempotency.action !== "deployments.reconcile" ||
          existingIdempotency.idempotencyKey !== meta.idempotencyKey
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        if (existingIdempotency.requestHash !== meta.requestHash) {
          return this.#terminalWriteEnvelope(
            "deployments.reconcile",
            meta,
            "blocked",
            "idempotency_conflict",
          );
        }
        if (
          existingIdempotency.actorRef !== context.actorId ||
          existingIdempotency.status !== "completed" ||
          existingIdempotency.domainRecordRef !== request.release_id ||
          existingIdempotency.finalResult === null ||
          existingIdempotency.finalResult.domainRecordRef !== request.release_id
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        let release;
        let readback;
        try {
          [release, readback] = await Promise.all([
            this.#repository.getRelease({
              managementTenantId: this.#managementTenantId,
              releaseId: request.release_id,
            }),
            this.#repository.getReadback({
              managementTenantId: this.#managementTenantId,
              releaseId: request.release_id,
            }),
          ]);
        } catch (error: unknown) {
          return this.#runtime.coordinator.tripFatal(error);
        }
        if (release === null) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        const replayEnvelope = this.#assertWriteEnvelope(
          "deployments.reconcile",
          existingIdempotency.finalResult.envelope,
        );
        if (
          !reconciledReleaseMatchesEnvelope(
            release,
            readback,
            replayEnvelope,
            request,
            this.#managementTenantId,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        return replayEnvelope;
      }

      if (!hasReadbackAttemptRepository(this.#repository)) {
        return this.#terminalWriteEnvelope(
          "deployments.reconcile",
          meta,
          "unavailable",
          "repository_unavailable",
        );
      }
      const attemptRepository = this.#repository;
      let release;
      let newestUnresolved;
      let priorReadback;
      try {
        [release, newestUnresolved, priorReadback] = await Promise.all([
          this.#repository.getRelease({
            managementTenantId: this.#managementTenantId,
            releaseId: request.release_id,
          }),
          this.#repository.getNewestUnresolvedRelease(),
          this.#repository.getReadback({
            managementTenantId: this.#managementTenantId,
            releaseId: request.release_id,
          }),
        ]);
      } catch (error: unknown) {
        if (
          error instanceof ModuleControlRepositoryError &&
          error.code !== "closed"
        ) {
          return this.#runtime.coordinator.tripFatal(error);
        }
        return this.#terminalWriteEnvelope(
          "deployments.reconcile",
          meta,
          "unavailable",
          "repository_unavailable",
        );
      }
      if (release === null) {
        return this.#terminalWriteEnvelope(
          "deployments.reconcile",
          meta,
          "blocked",
          "reconcile_release_not_found",
        );
      }
      if (
        release.managementTenantId !== this.#managementTenantId ||
        newestUnresolved === null ||
        newestUnresolved.managementTenantId !== this.#managementTenantId
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }
      if (release.status !== "manual_review") {
        return this.#terminalWriteEnvelope(
          "deployments.reconcile",
          meta,
          "blocked",
          "reconcile_release_not_manual_review",
        );
      }
      if (
        newestUnresolved.releaseId !== release.releaseId ||
        newestUnresolved.revision !== release.revision
      ) {
        return this.#terminalWriteEnvelope(
          "deployments.reconcile",
          meta,
          "blocked",
          "reconcile_release_not_newest_unresolved",
        );
      }
      if (
        priorReadback === null ||
        (priorReadback.status !== "mismatch" &&
          priorReadback.status !== "unknown") ||
        priorReadback.managementTenantId !== this.#managementTenantId ||
        priorReadback.releaseId !== release.releaseId ||
        priorReadback.revision !== release.revision ||
        priorReadback.readbackRef !== release.readbackRef ||
        !stringArraysEqual(priorReadback.reasonCodes, release.reasonCodes) ||
        release.desiredModules.length === 0
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }

      let checkedAt: string;
      let attemptId: string;
      let readbackRef: string;
      try {
        checkedAt = this.#clock();
        attemptId = this.#idGenerator();
        readbackRef = this.#idGenerator();
        if (
          parseRfc3339Instant(checkedAt) === null ||
          !IDENTIFIER_PATTERN.test(attemptId) ||
          !IDENTIFIER_PATTERN.test(readbackRef)
        ) {
          throw new TypeError("Invalid reconciliation clock or identifier.");
        }
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }

      const desiredModules = sortedModuleRefs(release.desiredModules);
      let stage: ReturnType<ActivationAuthorityDriver["stageCandidate"]> | null =
        null;
      try {
        stage = this.#runtime.privateDriver.stageCandidate({
          releaseId: release.releaseId,
          revision: release.revision,
          activeModules: desiredModules,
        });
        const claim = await attemptRepository.claimReadbackAttempt({
          metadata: {
            managementTenantId: this.#managementTenantId,
            actorRef: context.actorId,
            action: "deployments.reconcile",
            idempotencyKey: meta.idempotencyKey,
            requestHash: meta.requestHash,
            requestId: meta.requestId,
            traceId: meta.traceId,
            auditId: meta.auditId,
          },
          attemptId,
          readbackRef,
          releaseId: release.releaseId,
          revision: release.revision,
          desiredModules,
          ownerBootId: this.#runtime.ownerBootId,
          claimedAt: checkedAt,
        });
        if (
          claim.disposition !== "created" ||
          !claimedAttemptMatches(claim.attempt, {
            action: "deployments.reconcile",
            managementTenantId: this.#managementTenantId,
            attemptId,
            idempotencyKey: meta.idempotencyKey,
            requestHash: meta.requestHash,
            actorRef: context.actorId,
            requestId: meta.requestId,
            traceId: meta.traceId,
            auditId: meta.auditId,
            releaseId: release.releaseId,
            revision: release.revision,
            desiredModules,
            readbackRef,
            claimedAt: checkedAt,
          })
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        let observed: ModuleActivationSnapshot | null;
        try {
          observed = this.#runtime.privateDriver.candidateSnapshot(stage);
        } catch {
          observed = null;
        }
        let proof: ReturnType<
          ActivationAuthorityDriver["verifyCandidate"]
        > | null = null;
        let observation: ReadbackAttemptObservation;
        if (
          observed !== null &&
          observed.releaseId === release.releaseId &&
          observed.revision === release.revision &&
          moduleRefSetsEqual(observed.activeModules, desiredModules)
        ) {
          proof = this.#runtime.privateDriver.verifyCandidate(stage, {
            status: "verified",
            releaseId: observed.releaseId,
            revision: observed.revision,
            activeModules: observed.activeModules,
          });
          observation = {
            status: "verified",
            appliedReleaseId: release.releaseId,
            appliedRevision: release.revision,
            appliedModules: desiredModules,
            reasonCodes: [],
            checkedAt,
          };
        } else if (observed !== null) {
          observation = {
            status: "mismatch",
            appliedReleaseId: observed.releaseId,
            appliedRevision: observed.revision,
            appliedModules: observed.activeModules,
            reasonCodes: ["runtime_readback_mismatch"],
            checkedAt,
          };
        } else {
          observation = {
            status: "unknown",
            appliedReleaseId: null,
            appliedRevision: null,
            appliedModules: [],
            reasonCodes: ["runtime_readback_unknown"],
            checkedAt,
          };
        }
        const finalEnvelope = this.#assertWriteEnvelope(
          "deployments.reconcile",
          {
            schema_version: request.schema_version,
            request_id: meta.requestId,
            trace_id: meta.traceId,
            audit_id: meta.auditId,
            status:
              observation.status === "verified" ? "success" : "manual_review",
            data: {
              kind: "reconciliation",
              release_id: release.releaseId,
              revision: release.revision,
              status: observation.status,
            },
            reason_codes: observation.reasonCodes,
            readback: {
              status: observation.status,
              release_id: release.releaseId,
              revision: release.revision,
            },
          },
        );
        const finalResult: ControlFinalResult = {
          domainRecordRef: release.releaseId,
          envelope: finalEnvelope as unknown as ControlEnvelope,
        };
        const finalization = await attemptRepository.finalizeReadbackAndComplete({
          attemptId,
          ownerCapability: claim.ownerCapability,
          observation,
          finalResult,
          finalizedAt: checkedAt,
        });
        const expectedReadback: ModuleReadbackRecord = {
          managementTenantId: this.#managementTenantId,
          readbackRef,
          releaseId: release.releaseId,
          attemptId,
          revision: release.revision,
          appliedReleaseId: observation.appliedReleaseId,
          appliedRevision: observation.appliedRevision,
          appliedModules: observation.appliedModules,
          status: observation.status,
          reasonCodes: observation.reasonCodes,
          checkedAt,
        } as ModuleReadbackRecord;
        const expectedRelease: ModuleReleaseRecord =
          observation.status === "verified"
            ? {
                ...release,
                status: "active_verified",
                readbackRef,
                reasonCodes: [],
                supersededByReleaseId: null,
              }
            : {
                ...release,
                status: "manual_review",
                readbackRef,
                reasonCodes: observation.reasonCodes as readonly [
                  string,
                  ...string[],
                ],
                supersededByReleaseId: null,
              };
        if (
          finalization.disposition !== "finalized" ||
          finalization.replayed !== false ||
          !isDeepStrictEqual(finalization.readback, expectedReadback) ||
          !isDeepStrictEqual(finalization.release, expectedRelease) ||
          finalization.idempotency.managementTenantId !==
            this.#managementTenantId ||
          finalization.idempotency.action !== "deployments.reconcile" ||
          finalization.idempotency.idempotencyKey !== meta.idempotencyKey ||
          finalization.idempotency.requestHash !== meta.requestHash ||
          finalization.idempotency.actorRef !== context.actorId ||
          finalization.idempotency.status !== "completed" ||
          finalization.idempotency.domainRecordRef !== release.releaseId ||
          !isDeepStrictEqual(finalization.idempotency.finalResult, finalResult) ||
          !isDeepStrictEqual(finalization.finalResult, finalResult) ||
          finalization.attempt.phase !== "finalized" ||
          finalization.attempt.action !== "deployments.reconcile" ||
          finalization.attempt.attemptId !== attemptId ||
          finalization.attempt.releaseId !== release.releaseId ||
          finalization.attempt.revision !== release.revision ||
          finalization.attempt.terminalStatus !== observation.status ||
          !isDeepStrictEqual(
            finalization.attempt.appliedModules,
            observation.appliedModules,
          ) ||
          !stringArraysEqual(
            finalization.attempt.reasonCodes,
            observation.reasonCodes,
          ) ||
          finalization.reconciliationEvent.action !== "deployments.reconcile" ||
          finalization.reconciliationEvent.objectRef !== release.releaseId ||
          finalization.reconciliationEvent.status !== observation.status ||
          finalization.completionEvent.action !== "deployments.reconcile" ||
          finalization.completionEvent.status !== "completed"
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }

        let persistedIdempotency;
        let persistedRelease;
        let persistedReadback;
        let persistedState;
        try {
          [
            persistedIdempotency,
            persistedRelease,
            persistedReadback,
            persistedState,
          ] = await Promise.all([
            this.#repository.getIdempotency({
              managementTenantId: this.#managementTenantId,
              action: "deployments.reconcile",
              idempotencyKey: meta.idempotencyKey,
            }),
            this.#repository.getRelease({
              managementTenantId: this.#managementTenantId,
              releaseId: release.releaseId,
            }),
            this.#repository.getReadback({
              managementTenantId: this.#managementTenantId,
              releaseId: release.releaseId,
            }),
            this.#repository.getControlState(),
          ]);
        } catch (error: unknown) {
          return this.#runtime.coordinator.tripFatal(error);
        }
        const matchingHistory = persistedState.releaseHistory.filter(
          (entry) => entry.release.releaseId === release.releaseId,
        );
        if (
          !isDeepStrictEqual(persistedIdempotency, finalization.idempotency) ||
          !isDeepStrictEqual(persistedRelease, finalization.release) ||
          !isDeepStrictEqual(persistedReadback, finalization.readback) ||
          !isDeepStrictEqual(persistedState.latestReadback, finalization.readback) ||
          matchingHistory.length !== 1 ||
          !isDeepStrictEqual(matchingHistory[0]!.release, finalization.release) ||
          (observation.status === "verified" &&
            (!isDeepStrictEqual(
              persistedState.activeRelease,
              finalization.release,
            ) ||
              persistedState.activeRevision !== release.revision ||
              !moduleRefSetsEqual(
                persistedState.activeModules,
                desiredModules,
              )))
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        const persistedEnvelope = this.#assertWriteEnvelope(
          "deployments.reconcile",
          finalization.idempotency.finalResult.envelope,
        );
        if (
          !isDeepStrictEqual(persistedEnvelope, finalEnvelope) ||
          !reconciledReleaseMatchesEnvelope(
            finalization.release,
            finalization.readback,
            persistedEnvelope,
            request,
            this.#managementTenantId,
          )
        ) {
          return this.#runtime.coordinator.tripFatal(
            new ModuleControlServiceError("state_output_invalid"),
          );
        }
        if (proof === null) {
          this.#runtime.privateDriver.abortCandidate(stage);
        } else {
          this.#runtime.privateDriver.commitCandidate(proof);
        }
        stage = null;
        return persistedEnvelope;
      } catch (error: unknown) {
        if (stage !== null) {
          try {
            this.#runtime.privateDriver.abortCandidate(stage);
          } catch {
            // The fatal readiness fence below is authoritative if cleanup fails.
          }
        }
        if (error instanceof RuntimeMutationFatalError) throw error;
        return this.#runtime.coordinator.tripFatal(error);
      }
    });
  }

  async getState(context: ExecutionContext): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    const failure = authorizationFailure(context, this.#managementTenantId);
    if (failure !== null) {
      return blockedEnvelope(failure);
    }

    return this.#runtime.coordinator.withControlledDispatch(async () => {
      let requestId: string;
      let traceId: string;
      let auditId: string;
      try {
        requestId = this.#idGenerator();
        traceId = this.#idGenerator();
        auditId = this.#idGenerator();
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }

      let state;
      try {
        state = await this.#repository.getControlState();
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) {
          throw error;
        }
        if (
          error instanceof ModuleControlRepositoryError &&
          (error.code === "invalid_state" || error.code === "tenant_mismatch")
        ) {
          return this.#runtime.coordinator.tripFatal(error);
        }
        try {
          return closeEnvelope({
            schema_version: "2026-08-22.v1",
            request_id: requestId,
            trace_id: traceId,
            audit_id: auditId,
            status: "unavailable",
            data: null,
            reason_codes: ["state_unavailable"],
            readback: {
              status: "not_applicable",
              release_id: null,
              revision: null,
            },
          });
        } catch (contractError: unknown) {
          return this.#runtime.coordinator.tripFatal(contractError);
        }
      }
      try {
        return closeEnvelope({
          schema_version: "2026-08-22.v1",
          request_id: requestId,
          trace_id: traceId,
          audit_id: auditId,
          status: "success",
          data: mapControlStateToDto(
            state as unknown as ModuleControlState,
            this.#inventory,
            this.#managementTenantId,
          ),
          reason_codes: [],
          readback: {
            status: "not_applicable",
            release_id: null,
            revision: null,
          },
        });
      } catch (contractError: unknown) {
        return this.#runtime.coordinator.tripFatal(contractError);
      }
    });
  }
}

function createControlledDispatchFacade(
  coordinator: RuntimeMutationCoordinator,
  activation: ActivationDispatchGate,
): ControlledDispatchFacade {
  const dispatch = async <T>(
    ref: ActiveModuleRef,
    handler: () => Promise<T> | T,
  ): Promise<T> =>
    coordinator.withControlledDispatch(async () => {
      if (coordinator.isFatal()) {
        return coordinator.tripFatal(
          new ModuleControlServiceError("runtime_fatal"),
        );
      }
      activation.snapshot();
      if (!activation.isActive(ref)) {
        throw new ModuleControlServiceError("module_not_active");
      }
      return handler();
    });

  return Object.freeze({ dispatch });
}

export function createModuleControlRuntimeAssembly(
  options: ModuleControlRuntimeAssemblyOptions,
): ModuleControlRuntimeAssembly {
  assertPreviewTtlSeconds(options.previewTtlSeconds);
  const ownerBootId = options.ownerBootId ?? `boot_${randomUUID()}`;
  if (!IDENTIFIER_PATTERN.test(ownerBootId)) {
    throw new TypeError("ownerBootId must be a valid identifier.");
  }
  const coordinator = createRuntimeMutationCoordinator();
  const gate = createActivationGate(options.inventory);
  if (options.activationRestoreEvidence !== undefined) {
    const proof = gate.recoveryDriver.verifyRestoreEvidence(
      options.activationRestoreEvidence,
    );
    gate.recoveryDriver.restoreVerified(proof);
  }
  const runtime: PrivateRuntimeCapabilities = {
    coordinator,
    privateDriver: gate.privateDriver,
    recoveryDriver: gate.recoveryDriver,
    activationSnapshot: () => gate.readFacade.snapshot(),
    ownerBootId,
  };
  const service = new ModuleControlServiceImplementation(options, runtime);
  const activation = Object.freeze({
    snapshot: () => gate.readFacade.snapshot(),
  });
  const dispatch = createControlledDispatchFacade(
    coordinator,
    gate.readFacade,
  );

  return Object.freeze({ service, activation, dispatch });
}
