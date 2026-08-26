import { isDeepStrictEqual, types as nodeTypes } from "node:util";

import type { ExecutionContext } from "../platform/context";
import { isTrustedExecutionContext } from "../platform/context";
import { canonicalControlHash } from "./canonical-control-hash";
import {
  assertControlProducerEnvelope,
  controlEnvelopeSchema,
  CONTROL_STATE_MAX_MODULES,
  deploymentPreviewRequestSchema,
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
  ModuleControlRepositoryError,
  type CanonicalRequestHash,
  type ControlFinalResult,
  type CreatePreviewRequestMetadata,
  type DeepReadonly,
  type ModuleControlRepository,
  type ModuleControlRef,
  type ModulePreviewRecord,
  type ModuleReadbackRecord,
  type ModuleRegistrationRecord,
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

function replayedChangePreviewMatchesEnvelope(
  preview: ModulePreviewRecord,
  envelope: DeepFrozen<ControlEnvelope>,
  managementTenantId: string,
  actorRef: string,
  previewRef: string,
): boolean {
  const data = envelope.data;
  const recomputed = recomputePersistedChangePreviewHash(preview);
  return (
    envelope.status === "success" &&
    data?.kind === "preview" &&
    recomputed !== null &&
    preview.canonicalHash === recomputed &&
    data.canonical_hash === recomputed &&
    data.preview_ref === previewRef &&
    preview.managementTenantId === managementTenantId &&
    preview.previewRef === previewRef &&
    preview.intent === "change" &&
    data.intent === "change" &&
    data.target_release_id === null &&
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

function recomputePersistedChangePreviewHash(
  preview: ModulePreviewRecord,
): string | null {
  try {
    if (preview.intent !== "change") return null;
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

    return canonicalControlHash({
      domain: "preview",
      schemaVersion: ADMIN_CONTROL_SCHEMA_VERSION,
      payload: {
        action: "deployments.preview",
        management_tenant_id: preview.managementTenantId,
        creator_actor_ref: preview.creatorActorRef,
        intent: preview.intent,
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
      },
    }).hash;
  } catch {
    return null;
  }
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
  state: ModuleControlState,
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

  async #unimplementedWrite(
    action: ControlProducerAction,
    context: ExecutionContext,
    metaInput: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    const meta = parseWriteMeta(metaInput);
    const failure = authorizationFailure(context, this.#managementTenantId);
    if (failure !== null) {
      return this.#terminalWriteEnvelope(action, meta, "blocked", failure);
    }
    return this.#runtime.coordinator.withMutation(() =>
      Promise.resolve(this.#terminalWriteEnvelope(
        action,
        meta,
        "unavailable",
        "service_phase_not_implemented",
      )),
    );
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
      if (request.intent === "rollback") {
        return this.#terminalWriteEnvelope(
          "deployments.preview",
          meta,
          "blocked",
          "rollback_preview_not_implemented",
        );
      }

      let expectedRequestHash: string;
      try {
        expectedRequestHash = canonicalControlHash({
          domain: "request",
          schemaVersion: request.schema_version,
          payload: {
            action: "deployments.preview",
            management_tenant_id: this.#managementTenantId,
            actor_ref: context.actorId,
            request: {
              schema_version: request.schema_version,
              intent: "change",
              desired_modules: request.desired_modules.map((ref) => ({
                module_id: ref.module_id,
                version: ref.version,
                descriptor_digest: ref.descriptor_digest as `sha256:${string}`,
              })),
            },
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
          !replayedChangePreviewMatchesEnvelope(
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

      const inventoryRefs = sortedModuleRefs(
        this.#inventory.map(inventoryModuleRef),
      );
      const desiredRefs = sortedModuleRefs(
        request.desired_modules.map(requestModuleRef),
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
        previewHash = canonicalControlHash({
          domain: "preview",
          schemaVersion: request.schema_version,
          payload: {
            action: "deployments.preview",
            management_tenant_id: this.#managementTenantId,
            creator_actor_ref: context.actorId,
            intent: "change",
            base_release_revision: activationSnapshot.revision,
            inventory_refs: inventoryRefs.map(hashModuleRef),
            desired_modules: desiredRefs.map(hashModuleRef),
            policy_version: PREVIEW_POLICY_VERSION,
            schema_version: request.schema_version,
            validation,
            preview_ttl_seconds: this.#previewTtlSeconds,
          },
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
          intent: "change",
          base_release_id: activationSnapshot.releaseId,
          base_revision: activationSnapshot.revision,
          desired_modules: desiredModules,
          target_release_id: null,
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
      const record = {
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
        intent: "change" as const,
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
          !replayedChangePreviewMatchesEnvelope(
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
    request: ApprovalRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    void request;
    return this.#unimplementedWrite("approvals.decide", context, meta);
  }

  async publish(
    context: ExecutionContext,
    request: PublishRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    void request;
    return this.#unimplementedWrite("deployments.publish", context, meta);
  }

  async reconcile(
    context: ExecutionContext,
    request: ReconcileRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    void request;
    return this.#unimplementedWrite("deployments.reconcile", context, meta);
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
  const coordinator = createRuntimeMutationCoordinator();
  const gate = createActivationGate(options.inventory);
  const runtime: PrivateRuntimeCapabilities = {
    coordinator,
    privateDriver: gate.privateDriver,
    recoveryDriver: gate.recoveryDriver,
    activationSnapshot: () => gate.readFacade.snapshot(),
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
