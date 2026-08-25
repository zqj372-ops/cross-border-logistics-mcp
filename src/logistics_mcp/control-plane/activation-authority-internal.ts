import { types as nodeTypes } from "node:util";

import {
  ModuleActivationError,
  ModuleActivationRegistry,
} from "./activation-registry";
import type {
  ActiveModuleRef,
  ModuleActivationSnapshot,
  TrustedModuleInventory,
} from "./types";
import type {
  FinalizedReadbackAttemptRecord,
  ModuleActiveVerifiedReleaseRecord,
  ModuleTerminalReadbackRecord,
} from "./repository";

import {
  DESCRIPTOR_DIGEST_PATTERN,
  IDENTIFIER_PATTERN,
  VERSION_PATTERN,
} from "./lexical-contracts";
import {
  ADMIN_CONTROL_RFC3339_PATTERN,
  compareRfc3339Instants,
} from "./rfc3339-instant";

const SNAPSHOT_KEYS = ["releaseId", "revision", "activeModules"] as const;
const ACTIVE_REF_KEYS = ["moduleId", "version", "descriptorDigest"] as const;
const VERIFIED_OBSERVATION_KEYS = [
  "status",
  "releaseId",
  "revision",
  "activeModules",
] as const;
const RELEASE_KEYS = [
  "managementTenantId",
  "releaseId",
  "revision",
  "desiredModules",
  "previousReleaseId",
  "previewRef",
  "approvalId",
  "publisherActorRef",
  "createdAt",
  "publishedAt",
  "status",
  "readbackRef",
  "reasonCodes",
  "supersededByReleaseId",
] as const;
const READBACK_KEYS = [
  "managementTenantId",
  "readbackRef",
  "releaseId",
  "attemptId",
  "revision",
  "appliedReleaseId",
  "appliedRevision",
  "appliedModules",
  "status",
  "reasonCodes",
  "checkedAt",
] as const;
const ATTEMPT_KEYS = [
  "managementTenantId",
  "attemptId",
  "action",
  "idempotencyKey",
  "requestHash",
  "actorRef",
  "requestId",
  "traceId",
  "auditId",
  "releaseId",
  "revision",
  "desiredModules",
  "readbackRef",
  "ownerBootId",
  "phase",
  "claimedAt",
  "finalizedAt",
  "terminalStatus",
  "appliedReleaseId",
  "appliedRevision",
  "appliedModules",
  "reasonCodes",
  "checkedAt",
  "finalizedByActorRef",
  "reconciliationEventSequence",
  "completionEventSequence",
] as const;
const RESTORE_KEYS = ["release", "readback", "attempt"] as const;
const RESTORE_REQUEST_HASH_PATTERN =
  /^mcp-control-hash\/v1\/request\/sha256:[a-f0-9]{64}$/u;

export type ActivationAuthorityErrorCode =
  | "driver_invalid"
  | "candidate_invalid"
  | "inventory_mismatch"
  | "revision_invalid"
  | "release_id_invalid"
  | "stage_in_progress"
  | "stage_invalid"
  | "readback_invalid"
  | "proof_invalid"
  | "restore_proof_invalid"
  | "restore_invalid";

export class ActivationAuthorityError extends Error {
  readonly code!: ActivationAuthorityErrorCode;

  constructor(code: ActivationAuthorityErrorCode, message: string) {
    super(message);
    this.name = "ActivationAuthorityError";
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

declare const ACTIVATION_STAGE_HANDLE_BRAND: unique symbol;
declare const ACTIVATION_COMMIT_PROOF_BRAND: unique symbol;
declare const ACTIVATION_RESTORE_PROOF_BRAND: unique symbol;

export type ActivationStageHandle = Readonly<{
  readonly [ACTIVATION_STAGE_HANDLE_BRAND]: "activation-stage-handle";
}>;

export type ActivationCommitProof = Readonly<{
  readonly [ACTIVATION_COMMIT_PROOF_BRAND]: "activation-commit-proof";
}>;

export type ActivationRestoreProof = Readonly<{
  readonly [ACTIVATION_RESTORE_PROOF_BRAND]: "activation-restore-proof";
}>;

interface ActivationRestoreEvidence {
  readonly release: ModuleActiveVerifiedReleaseRecord;
  readonly readback: ModuleTerminalReadbackRecord;
  readonly attempt: FinalizedReadbackAttemptRecord;
}

/** @internal Runtime-assembly-only live activation capability. */
export interface ActivationAuthorityDriver {
  readonly stageCandidate: (
    candidate: unknown,
  ) => ActivationStageHandle;
  readonly candidateSnapshot: (
    handle: ActivationStageHandle,
  ) => ModuleActivationSnapshot;
  readonly verifyCandidate: (
    handle: ActivationStageHandle,
    observed: unknown,
  ) => ActivationCommitProof;
  readonly commitCandidate: (proof: ActivationCommitProof) => void;
  readonly abortCandidate: (handle: ActivationStageHandle) => void;
}

/** @internal Runtime-assembly-only startup recovery capability. */
export interface ActivationRecoveryDriver {
  readonly verifyRestoreEvidence: (
    evidence: unknown,
  ) => ActivationRestoreProof;
  readonly restoreVerified: (proof: ActivationRestoreProof) => void;
}

/**
 * @internal Capability bundle for immediate capture by the runtime service
 * assembly. TypeScript module visibility is not a same-process security
 * boundary; production modules must not import this internal module.
 */
export interface ActivationGateAssembly {
  readonly readFacade: ModuleActivationRegistry;
  readonly privateDriver: ActivationAuthorityDriver;
  readonly recoveryDriver: ActivationRecoveryDriver;
}

interface StageRecord {
  readonly owner: GateState;
  readonly handle: object;
  readonly candidate: ModuleActivationSnapshot;
  proof: object | null;
}

interface ProofRecord {
  readonly owner: GateState;
  readonly stage: StageRecord;
}

interface RestoreProofRecord {
  readonly owner: GateState;
  readonly candidate: ModuleActivationSnapshot;
}

interface GateState {
  readonly inventoryKeys: ReadonlySet<string>;
  snapshot: ModuleActivationSnapshot;
  stage: StageRecord | null;
  restoreProof: object | null;
}

const gateStates = new WeakMap<object, GateState>();
const driverStates = new WeakMap<object, GateState>();
const recoveryDriverStates = new WeakMap<object, GateState>();
const stageStates = new WeakMap<object, StageRecord>();
const proofStates = new WeakMap<object, ProofRecord>();
const restoreProofStates = new WeakMap<object, RestoreProofRecord>();

function fail(
  code: ActivationAuthorityErrorCode,
  message: string,
): never {
  throw new ActivationAuthorityError(code, message);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function closedRecordValues(
  value: unknown,
  expectedKeys: readonly string[],
  code: ActivationAuthorityErrorCode,
  label: string,
): readonly unknown[] {
  if (
    !isObject(value) ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(code, `${label} must be a non-Proxy ordinary object.`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  ) {
    return fail(code, `${label} has an unsupported or incomplete field set.`);
  }

  const values: unknown[] = [];
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail(code, `${label}.${key} must be an own enumerable data property.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function closedArrayValues(
  value: unknown,
  code: ActivationAuthorityErrorCode,
  label: string,
): readonly unknown[] {
  if (
    !isObject(value) ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return fail(code, `${label} must be a non-Proxy standard array.`);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return fail(code, `${label}.length must be a standard data property.`);
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) {
    return fail(code, `${label} must contain only continuous array indexes.`);
  }
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      return fail(code, `${label} must not contain symbol keys.`);
    }
    const index = Number(key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= length ||
      String(index) !== key
    ) {
      return fail(code, `${label} contains a non-index own property.`);
    }
  }

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail(code, `${label}[${index}] must be an own data property.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function assertIdentifier(
  value: unknown,
  code: ActivationAuthorityErrorCode,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    fail(code, `${label} is malformed.`);
  }
}

function assertVersion(
  value: unknown,
  code: ActivationAuthorityErrorCode,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    fail(code, `${label} is malformed.`);
  }
}

function assertDigest(
  value: unknown,
  code: ActivationAuthorityErrorCode,
  label: string,
): asserts value is `sha256:${string}` {
  if (typeof value !== "string" || !DESCRIPTOR_DIGEST_PATTERN.test(value)) {
    fail(code, `${label} is malformed.`);
  }
}

function assertRevision(
  value: unknown,
  code: ActivationAuthorityErrorCode,
  label: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(code, `${label} must be a nonnegative safe integer.`);
  }
}

function assertInstant(
  value: unknown,
  code: ActivationAuthorityErrorCode,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !ADMIN_CONTROL_RFC3339_PATTERN.test(value)) {
    fail(code, `${label} is not an RFC3339 instant.`);
  }
}

function refKey(ref: ActiveModuleRef): string {
  return `${ref.moduleId}\u0000${ref.version}\u0000${ref.descriptorDigest}`;
}

function compareRefs(left: ActiveModuleRef, right: ActiveModuleRef): number {
  const leftKey = refKey(left);
  const rightKey = refKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function freezeRef(value: ActiveModuleRef): ActiveModuleRef {
  return Object.freeze({
    moduleId: value.moduleId,
    version: value.version,
    descriptorDigest: value.descriptorDigest,
  });
}

function freezeSnapshot(
  releaseId: string | null,
  revision: number,
  refs: readonly ActiveModuleRef[],
): ModuleActivationSnapshot {
  const activeModules = Object.freeze(
    refs.slice().sort(compareRefs).map(freezeRef),
  );
  return Object.freeze({ releaseId, revision, activeModules });
}

function initialSnapshot(): ModuleActivationSnapshot {
  return freezeSnapshot(null, 0, []);
}

function parseRef(
  value: unknown,
  code: ActivationAuthorityErrorCode,
  label: string,
): ActiveModuleRef {
  const fields = closedRecordValues(value, ACTIVE_REF_KEYS, code, label);
  assertIdentifier(fields[0], code, `${label}.moduleId`);
  assertVersion(fields[1], code, `${label}.version`);
  assertDigest(fields[2], code, `${label}.descriptorDigest`);
  return {
    moduleId: fields[0],
    version: fields[1],
    descriptorDigest: fields[2],
  };
}

function parseRefs(
  value: unknown,
  code: ActivationAuthorityErrorCode,
  label: string,
  requireNonempty: boolean,
): readonly ActiveModuleRef[] {
  const values = closedArrayValues(value, code, label);
  if (requireNonempty && values.length === 0) {
    return fail(code, `${label} must not be empty.`);
  }
  const refs: ActiveModuleRef[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const ref = parseRef(values[index], code, `${label}[${index}]`);
    const key = refKey(ref);
    if (seen.has(key)) return fail(code, `${label} must not contain duplicates.`);
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function parseCandidate(value: unknown): ModuleActivationSnapshot {
  const fields = closedRecordValues(
    value,
    SNAPSHOT_KEYS,
    "candidate_invalid",
    "activation candidate",
  );
  const releaseId = fields[0];
  if (releaseId === null) {
    return fail("release_id_invalid", "activation candidate.releaseId is required.");
  }
  assertIdentifier(releaseId, "release_id_invalid", "activation candidate.releaseId");
  assertRevision(fields[1], "revision_invalid", "activation candidate.revision");
  if (fields[1] < 1) {
    return fail("revision_invalid", "activation candidate.revision must be positive.");
  }
  const refs = parseRefs(
    fields[2],
    "candidate_invalid",
    "activation candidate.activeModules",
    true,
  );
  return freezeSnapshot(releaseId, fields[1], refs);
}

function sameRefSet(
  left: readonly ActiveModuleRef[],
  right: readonly ActiveModuleRef[],
): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
  }
  return true;
}

function parseObserved(value: unknown): ModuleActivationSnapshot {
  if (
    isObject(value) &&
    !nodeTypes.isProxy(value) &&
    Reflect.ownKeys(value).includes("status")
  ) {
    const fields = closedRecordValues(
      value,
      VERIFIED_OBSERVATION_KEYS,
      "readback_invalid",
      "activation readback",
    );
    if (fields[0] !== "verified") {
      return fail("readback_invalid", "activation readback is not verified.");
    }
    const releaseId = fields[1];
    if (releaseId === null) {
      return fail("readback_invalid", "verified activation readback needs a release ID.");
    }
    assertIdentifier(releaseId, "readback_invalid", "activation readback.releaseId");
    assertRevision(fields[2], "readback_invalid", "activation readback.revision");
    if (fields[2] < 1) {
      return fail("readback_invalid", "activation readback.revision must be positive.");
    }
    return freezeSnapshot(
      releaseId,
      fields[2],
      parseRefs(fields[3], "readback_invalid", "activation readback.activeModules", true),
    );
  }
  return parseCandidate(value);
}

function inventoryRefs(inventory: TrustedModuleInventory): readonly ActiveModuleRef[] {
  return Object.freeze(
    inventory.map((entry) =>
      freezeRef({
        moduleId: entry.moduleId,
        version: entry.version,
        descriptorDigest: entry.descriptorDigest,
      }),
    ),
  );
}

function registerState(
  registry: ModuleActivationRegistry,
  inventory: TrustedModuleInventory,
): void {
  if (
    nodeTypes.isProxy(registry) ||
    !(registry instanceof ModuleActivationRegistry) ||
    gateStates.has(registry)
  ) {
    throw new ModuleActivationError(
      "registry_invalid",
      "Activation registry state cannot be registered.",
    );
  }
  const refs = inventoryRefs(inventory);
  const keys = new Set(refs.map(refKey));
  gateStates.set(registry, {
    inventoryKeys: keys,
    snapshot: initialSnapshot(),
    stage: null,
    restoreProof: null,
  });
}

export function registerActivationRegistryState(
  registry: ModuleActivationRegistry,
  inventory: TrustedModuleInventory,
): void {
  registerState(registry, inventory);
}

export function readActivationRegistrySnapshot(
  registry: object,
): ModuleActivationSnapshot | undefined {
  return gateStates.get(registry)?.snapshot;
}

function stateForDriver(receiver: unknown): GateState {
  if (!isObject(receiver) || nodeTypes.isProxy(receiver)) {
    return fail("driver_invalid", "Activation driver receiver is not trusted.");
  }
  const state = driverStates.get(receiver);
  if (state === undefined) {
    return fail("driver_invalid", "Activation driver receiver is not trusted.");
  }
  return state;
}

function stateForRecoveryDriver(receiver: unknown): GateState {
  if (!isObject(receiver) || nodeTypes.isProxy(receiver)) {
    return fail("driver_invalid", "Activation recovery driver receiver is not trusted.");
  }
  const state = recoveryDriverStates.get(receiver);
  if (state === undefined) {
    return fail("driver_invalid", "Activation recovery driver receiver is not trusted.");
  }
  return state;
}

function stageForHandle(
  state: GateState,
  handle: unknown,
): StageRecord {
  if (!isObject(handle) || nodeTypes.isProxy(handle)) {
    return fail("stage_invalid", "Activation stage handle is not trusted.");
  }
  const stage = stageStates.get(handle);
  if (stage === undefined || stage.owner !== state || state.stage !== stage) {
    return fail("stage_invalid", "Activation stage handle is not current.");
  }
  return stage;
}

function proofForState(
  state: GateState,
  proof: unknown,
): ProofRecord {
  if (!isObject(proof) || nodeTypes.isProxy(proof)) {
    return fail("proof_invalid", "Activation commit proof is not trusted.");
  }
  const record = proofStates.get(proof);
  if (
    record === undefined ||
    record.owner !== state ||
    state.stage !== record.stage ||
    record.stage.proof !== proof
  ) {
    return fail("proof_invalid", "Activation commit proof is not current.");
  }
  return record;
}

function restoreProofForState(
  state: GateState,
  proof: unknown,
): RestoreProofRecord {
  if (!isObject(proof) || nodeTypes.isProxy(proof)) {
    return fail(
      "restore_proof_invalid",
      "Activation restore proof is not trusted.",
    );
  }
  const record = restoreProofStates.get(proof);
  if (
    record === undefined ||
    record.owner !== state ||
    state.restoreProof !== proof
  ) {
    return fail(
      "restore_proof_invalid",
      "Activation restore proof is not current.",
    );
  }
  return record;
}

function invalidateRestoreProof(state: GateState): void {
  if (state.restoreProof === null) return;
  restoreProofStates.delete(state.restoreProof);
  state.restoreProof = null;
}

function stageCandidate(
  state: GateState,
  input: unknown,
): ActivationStageHandle {
  if (state.stage !== null) {
    return fail("stage_in_progress", "Another activation candidate is already staged.");
  }
  const candidate = parseCandidate(input);
  if (candidate.revision <= state.snapshot.revision) {
    return fail("revision_invalid", "Activation candidate revision is not monotonic.");
  }
  if (
    candidate.activeModules.some((ref) => !state.inventoryKeys.has(refKey(ref)))
  ) {
    return fail(
      "inventory_mismatch",
      "Activation candidate contains a ref outside the current inventory.",
    );
  }
  invalidateRestoreProof(state);
  const handle = Object.freeze({});
  const stage: StageRecord = {
    owner: state,
    handle,
    candidate,
    proof: null,
  };
  stageStates.set(handle, stage);
  state.stage = stage;
  return handle as ActivationStageHandle;
}

function candidateSnapshot(
  state: GateState,
  handle: unknown,
): ModuleActivationSnapshot {
  const stage = stageForHandle(state, handle);
  return freezeSnapshot(
    stage.candidate.releaseId,
    stage.candidate.revision,
    stage.candidate.activeModules,
  );
}

function verifyCandidate(
  state: GateState,
  handle: unknown,
  observed: unknown,
): ActivationCommitProof {
  const stage = stageForHandle(state, handle);
  if (stage.proof !== null) {
    return fail("proof_invalid", "Activation candidate already has a proof.");
  }
  const parsedObserved = parseObserved(observed);
  if (
    parsedObserved.releaseId !== stage.candidate.releaseId ||
    parsedObserved.revision !== stage.candidate.revision ||
    !sameRefSet(parsedObserved.activeModules, stage.candidate.activeModules)
  ) {
    return fail("readback_invalid", "Activation readback does not exactly match the candidate.");
  }
  const proof = Object.freeze({});
  stage.proof = proof;
  proofStates.set(proof, { owner: state, stage });
  return proof as ActivationCommitProof;
}

function commitCandidate(state: GateState, input: unknown): void {
  const proof = proofForState(state, input);
  const candidate = proof.stage.candidate;
  proofStates.delete(input as object);
  stageStates.delete(proof.stage.handle);
  state.stage = null;
  state.snapshot = freezeSnapshot(
    candidate.releaseId,
    candidate.revision,
    candidate.activeModules,
  );
}

function abortCandidate(state: GateState, input: unknown): void {
  const stage = stageForHandle(state, input);
  if (stage.proof !== null) {
    proofStates.delete(stage.proof);
  }
  stageStates.delete(stage.handle);
  state.stage = null;
}

function assertReasonCodesEmpty(
  value: unknown,
  label: string,
): void {
  const values = closedArrayValues(value, "restore_invalid", label);
  if (values.length !== 0) {
    fail("restore_invalid", `${label} must be empty for verified evidence.`);
  }
}

function parseRestoreEvidence(value: unknown): ActivationRestoreEvidence {
  const wrapper = closedRecordValues(
    value,
    RESTORE_KEYS,
    "restore_invalid",
    "activation restore evidence",
  );
  const releaseFields = closedRecordValues(
    wrapper[0],
    RELEASE_KEYS,
    "restore_invalid",
    "activation restore release",
  );
  const readbackFields = closedRecordValues(
    wrapper[1],
    READBACK_KEYS,
    "restore_invalid",
    "activation restore readback",
  );
  const attemptFields = closedRecordValues(
    wrapper[2],
    ATTEMPT_KEYS,
    "restore_invalid",
    "activation restore attempt",
  );

  assertIdentifier(releaseFields[0], "restore_invalid", "release.managementTenantId");
  assertIdentifier(releaseFields[1], "restore_invalid", "release.releaseId");
  assertRevision(releaseFields[2], "restore_invalid", "release.revision");
  if (releaseFields[2] < 1) {
    return fail("restore_invalid", "release.revision must be positive.");
  }
  const desiredModules = parseRefs(
    releaseFields[3],
    "restore_invalid",
    "release.desiredModules",
    true,
  );
  if (releaseFields[4] !== null) {
    assertIdentifier(releaseFields[4], "restore_invalid", "release.previousReleaseId");
  }
  assertIdentifier(releaseFields[5], "restore_invalid", "release.previewRef");
  assertIdentifier(releaseFields[6], "restore_invalid", "release.approvalId");
  assertIdentifier(releaseFields[7], "restore_invalid", "release.publisherActorRef");
  assertInstant(releaseFields[8], "restore_invalid", "release.createdAt");
  assertInstant(releaseFields[9], "restore_invalid", "release.publishedAt");
  if (compareRfc3339Instants(releaseFields[8], releaseFields[9]) === 1) {
    return fail("restore_invalid", "release.createdAt must not be after publishedAt.");
  }
  if (releaseFields[10] !== "active_verified") {
    return fail("restore_invalid", "restore requires an active_verified release.");
  }
  assertIdentifier(releaseFields[11], "restore_invalid", "release.readbackRef");
  assertReasonCodesEmpty(releaseFields[12], "release.reasonCodes");
  if (releaseFields[13] !== null) {
    return fail("restore_invalid", "active_verified release cannot be superseded.");
  }

  assertIdentifier(readbackFields[0], "restore_invalid", "readback.managementTenantId");
  assertIdentifier(readbackFields[1], "restore_invalid", "readback.readbackRef");
  assertIdentifier(readbackFields[2], "restore_invalid", "readback.releaseId");
  assertIdentifier(readbackFields[3], "restore_invalid", "readback.attemptId");
  assertRevision(readbackFields[4], "restore_invalid", "readback.revision");
  if (readbackFields[4] < 1) {
    return fail("restore_invalid", "readback.revision must be positive.");
  }
  assertIdentifier(readbackFields[5], "restore_invalid", "readback.appliedReleaseId");
  assertRevision(readbackFields[6], "restore_invalid", "readback.appliedRevision");
  const appliedModules = parseRefs(
    readbackFields[7],
    "restore_invalid",
    "readback.appliedModules",
    true,
  );
  if (readbackFields[8] !== "verified") {
    return fail("restore_invalid", "restore requires a verified terminal readback.");
  }
  assertReasonCodesEmpty(readbackFields[9], "readback.reasonCodes");
  assertInstant(readbackFields[10], "restore_invalid", "readback.checkedAt");

  assertIdentifier(attemptFields[0], "restore_invalid", "attempt.managementTenantId");
  assertIdentifier(attemptFields[1], "restore_invalid", "attempt.attemptId");
  if (
    attemptFields[2] !== "deployments.publish" &&
    attemptFields[2] !== "deployments.reconcile"
  ) {
    return fail("restore_invalid", "attempt.action is not a readback action.");
  }
  assertIdentifier(attemptFields[3], "restore_invalid", "attempt.idempotencyKey");
  if (
    typeof attemptFields[4] !== "string" ||
    !RESTORE_REQUEST_HASH_PATTERN.test(attemptFields[4])
  ) {
    return fail("restore_invalid", "attempt.requestHash is malformed.");
  }
  for (const [index, label] of [
    [5, "actorRef"],
    [6, "requestId"],
    [7, "traceId"],
    [8, "auditId"],
  ] as const) {
    assertIdentifier(attemptFields[index], "restore_invalid", `attempt.${label}`);
  }
  assertIdentifier(attemptFields[9], "restore_invalid", "attempt.releaseId");
  assertRevision(attemptFields[10], "restore_invalid", "attempt.revision");
  if (attemptFields[10] < 1) {
    return fail("restore_invalid", "attempt.revision must be positive.");
  }
  const attemptDesiredModules = parseRefs(
    attemptFields[11],
    "restore_invalid",
    "attempt.desiredModules",
    true,
  );
  assertIdentifier(attemptFields[12], "restore_invalid", "attempt.readbackRef");
  assertIdentifier(attemptFields[13], "restore_invalid", "attempt.ownerBootId");
  if (attemptFields[14] !== "finalized") {
    return fail("restore_invalid", "restore requires a finalized readback attempt.");
  }
  assertInstant(attemptFields[15], "restore_invalid", "attempt.claimedAt");
  assertInstant(attemptFields[16], "restore_invalid", "attempt.finalizedAt");
  if (compareRfc3339Instants(attemptFields[15], attemptFields[16]) === 1) {
    return fail("restore_invalid", "attempt.claimedAt must not be after finalizedAt.");
  }
  if (attemptFields[17] !== "verified") {
    return fail("restore_invalid", "restore requires a verified attempt.");
  }
  assertIdentifier(attemptFields[18], "restore_invalid", "attempt.appliedReleaseId");
  assertRevision(attemptFields[19], "restore_invalid", "attempt.appliedRevision");
  const attemptAppliedModules = parseRefs(
    attemptFields[20],
    "restore_invalid",
    "attempt.appliedModules",
    true,
  );
  assertReasonCodesEmpty(attemptFields[21], "attempt.reasonCodes");
  assertInstant(attemptFields[22], "restore_invalid", "attempt.checkedAt");
  if (
    compareRfc3339Instants(attemptFields[15], attemptFields[22]) === 1 ||
    compareRfc3339Instants(attemptFields[22], attemptFields[16]) === 1
  ) {
    return fail("restore_invalid", "attempt.checkedAt must be within the attempt interval.");
  }
  assertIdentifier(
    attemptFields[23],
    "restore_invalid",
    "attempt.finalizedByActorRef",
  );
  const reconciliationEventSequence = attemptFields[24];
  const completionEventSequence = attemptFields[25];
  assertRevision(
    reconciliationEventSequence,
    "restore_invalid",
    "attempt.reconciliationEventSequence",
  );
  assertRevision(
    completionEventSequence,
    "restore_invalid",
    "attempt.completionEventSequence",
  );
  if (reconciliationEventSequence < 1 || completionEventSequence < 1) {
    return fail("restore_invalid", "attempt event sequences must be positive.");
  }
  if (completionEventSequence !== reconciliationEventSequence + 1) {
    return fail(
      "restore_invalid",
      "attempt completionEventSequence must immediately follow reconciliationEventSequence.",
    );
  }

  if (
    compareRfc3339Instants(releaseFields[9], attemptFields[15]) === 1
  ) {
    return fail(
      "restore_invalid",
      "attempt.claimedAt must not be before release.publishedAt.",
    );
  }

  if (
    releaseFields[0] !== readbackFields[0] ||
    releaseFields[0] !== attemptFields[0] ||
    releaseFields[1] !== readbackFields[2] ||
    releaseFields[1] !== readbackFields[5] ||
    releaseFields[1] !== attemptFields[9] ||
    releaseFields[2] !== readbackFields[4] ||
    releaseFields[2] !== readbackFields[6] ||
    releaseFields[2] !== attemptFields[10] ||
    releaseFields[11] !== readbackFields[1] ||
    releaseFields[11] !== attemptFields[12] ||
    readbackFields[3] !== attemptFields[1] ||
    readbackFields[8] !== attemptFields[17] ||
    !sameRefSet(desiredModules, appliedModules) ||
    !sameRefSet(desiredModules, attemptDesiredModules) ||
    !sameRefSet(desiredModules, attemptAppliedModules) ||
    readbackFields[5] !== attemptFields[18] ||
    readbackFields[6] !== attemptFields[19] ||
    readbackFields[10] !== attemptFields[22]
  ) {
    return fail("restore_invalid", "restore evidence has inconsistent release/readback/attempt identity.");
  }

  return {
    release: wrapper[0] as ModuleActiveVerifiedReleaseRecord,
    readback: wrapper[1] as ModuleTerminalReadbackRecord,
    attempt: wrapper[2] as FinalizedReadbackAttemptRecord,
  };
}

function assertInitialEmptyGate(state: GateState): void {
  if (
    state.snapshot.releaseId !== null ||
    state.snapshot.revision !== 0 ||
    state.snapshot.activeModules.length !== 0 ||
    state.stage !== null
  ) {
    return fail("restore_invalid", "Activation restore requires the initial empty gate.");
  }
}

function validateRestoreEvidence(
  state: GateState,
  value: unknown,
): ModuleActivationSnapshot {
  const evidence = parseRestoreEvidence(value);
  const desiredModules = parseRefs(
    evidence.release.desiredModules,
    "restore_invalid",
    "release.desiredModules",
    true,
  );
  if (
    desiredModules.some((ref) => !state.inventoryKeys.has(refKey(ref)))
  ) {
    return fail(
      "inventory_mismatch",
      "Restored release contains a ref outside the current inventory identity.",
    );
  }
  return freezeSnapshot(
    evidence.release.releaseId,
    evidence.release.revision,
    desiredModules,
  );
}

function verifyRestoreEvidence(
  state: GateState,
  value: unknown,
): ActivationRestoreProof {
  assertInitialEmptyGate(state);
  if (state.restoreProof !== null) {
    return fail("restore_invalid", "An activation restore proof is already pending.");
  }
  const candidate = validateRestoreEvidence(state, value);
  const proof = Object.freeze({});
  state.restoreProof = proof;
  restoreProofStates.set(proof, { candidate, owner: state });
  return proof as ActivationRestoreProof;
}

function restoreVerified(state: GateState, value: unknown): void {
  const record = restoreProofForState(state, value);
  assertInitialEmptyGate(state);
  restoreProofStates.delete(value as object);
  state.restoreProof = null;
  state.snapshot = freezeSnapshot(
    record.candidate.releaseId,
    record.candidate.revision,
    record.candidate.activeModules,
  );
}

function makeDriver(state: GateState): ActivationAuthorityDriver {
  const driver = {} as ActivationAuthorityDriver;
  const methods = {
    stageCandidate(this: unknown, candidate: unknown): ActivationStageHandle {
      return stageCandidate(stateForDriver(this), candidate);
    },
    candidateSnapshot(this: unknown, handle: ActivationStageHandle): ModuleActivationSnapshot {
      return candidateSnapshot(stateForDriver(this), handle);
    },
    verifyCandidate(this: unknown, handle: ActivationStageHandle, observed: unknown): ActivationCommitProof {
      return verifyCandidate(stateForDriver(this), handle, observed);
    },
    commitCandidate(this: unknown, proof: ActivationCommitProof): void {
      commitCandidate(stateForDriver(this), proof);
    },
    abortCandidate(this: unknown, handle: ActivationStageHandle): void {
      abortCandidate(stateForDriver(this), handle);
    },
  };
  for (const key of Object.keys(methods) as readonly (keyof typeof methods)[]) {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the receiver is intentionally validated at every driver call.
    const method = methods[key];
    Object.freeze(method);
    Object.defineProperty(driver, key, {
      configurable: false,
      enumerable: false,
      value: method,
      writable: false,
    });
  }
  driverStates.set(driver, state);
  return Object.freeze(driver);
}

function makeRecoveryDriver(state: GateState): ActivationRecoveryDriver {
  const driver = {} as ActivationRecoveryDriver;
  const methods = {
    verifyRestoreEvidence(
      this: unknown,
      evidence: unknown,
    ): ActivationRestoreProof {
      return verifyRestoreEvidence(stateForRecoveryDriver(this), evidence);
    },
    restoreVerified(this: unknown, proof: ActivationRestoreProof): void {
      restoreVerified(stateForRecoveryDriver(this), proof);
    },
  };
  for (const key of Object.keys(methods) as readonly (keyof typeof methods)[]) {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the receiver is intentionally validated at every driver call.
    const method = methods[key];
    Object.freeze(method);
    Object.defineProperty(driver, key, {
      configurable: false,
      enumerable: false,
      value: method,
      writable: false,
    });
  }
  recoveryDriverStates.set(driver, state);
  return Object.freeze(driver);
}

/** @internal Runtime-assembly capability factory; never re-export publicly. */
export function createActivationGate(
  inventory: TrustedModuleInventory,
): ActivationGateAssembly {
  const readFacade = new ModuleActivationRegistry(inventory);
  const state = gateStates.get(readFacade);
  if (state === undefined) {
    throw new ModuleActivationError(
      "registry_invalid",
      "Activation registry state was not initialized.",
    );
  }
  const privateDriver = makeDriver(state);
  const recoveryDriver = makeRecoveryDriver(state);
  return Object.freeze({ readFacade, privateDriver, recoveryDriver });
}
