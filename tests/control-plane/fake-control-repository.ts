import { isDeepStrictEqual, types as nodeUtilTypes } from "node:util";

import { controlEnvelopeSchema } from "../../src/logistics_mcp/control-plane/contracts";
import { IDENTIFIER_PATTERN } from "../../src/logistics_mcp/control-plane/lexical-contracts";
import {
  assertControlEventInstantOrder,
  assertControlEventLifecycleCardinality,
  assertControlRequestBinding,
  assertModulePreviewAuthoritySemantics,
  createControlEventLifecycleCounts,
  deepFreezeControlRecord,
  ModuleControlRepositoryError,
  MODULE_CONTROL_ACTIONS,
  resolveMonotonicControlEventOccurredAt,
} from "../../src/logistics_mcp/control-plane/repository";
import {
  addRfc3339Milliseconds,
  compareRfc3339Instants,
} from "../../src/logistics_mcp/control-plane/rfc3339-instant";
import type {
  ApprovalWriteResult,
  CanonicalRequestHash,
  CompleteControlIdempotencyRequest,
  ControlEventLifecycleCounts,
  ControlEventRecord,
  ControlFinalResult,
  ControlRecord,
  ControlRequestMetadata,
  CreatePreviewRecordRequest,
  DeepReadonly,
  DecideApprovalRecordRequest,
  GetControlIdempotencyQuery,
  GetModuleApprovalQuery,
  GetModulePreviewQuery,
  GetModuleReadbackQuery,
  GetModuleReleaseQuery,
  ModuleApprovalRecord,
  ModuleControlAction,
  ModuleControlIdempotencyRecord,
  ModuleControlRef,
  ModuleControlRepository,
  ModuleControlRepositoryErrorCode,
  ModuleControlState,
  ModulePreviewRecord,
  ModuleReleaseHistoryEntry,
  ModuleReadbackRecord,
  ModuleRegistrationRecord,
  ModuleReleaseRecord,
  PreviewWriteResult,
  PublishReleaseRecordRequest,
  ReadbackWriteResult,
  RecordReadbackRequest,
  RegisterModuleRecordRequest,
  RegistrationWriteResult,
  ReleaseWriteResult,
} from "../../src/logistics_mcp/control-plane/repository";

export const FAKE_CONTROL_REPOSITORY_METHOD_NAMES = Object.freeze([
  "health",
  "close",
  "registerModule",
  "createPreview",
  "decideApproval",
  "publishRelease",
  "recordReadback",
  "completeIdempotency",
  "getControlState",
  "getActiveRelease",
  "getPendingRelease",
  "getNewestUnresolvedRelease",
  "getPreview",
  "getApproval",
  "getRelease",
  "getReadback",
  "getIdempotency",
] as const);

export const FAKE_CONTROL_REPOSITORY_FAILURE_PHASES = Object.freeze([
  "method_entry",
  "after_domain_write",
  "after_event",
  "after_idempotency",
  "after_release_status_change",
] as const);

export type FakeControlRepositoryMethodName =
  (typeof FAKE_CONTROL_REPOSITORY_METHOD_NAMES)[number];
export type FakeControlRepositoryFailurePhase =
  (typeof FAKE_CONTROL_REPOSITORY_FAILURE_PHASES)[number];

const FAILURE_PHASE_ALLOWLIST: Readonly<
  Record<FakeControlRepositoryMethodName, readonly FakeControlRepositoryFailurePhase[]>
> = Object.freeze({
  health: ["method_entry"],
  close: ["method_entry"],
  registerModule: [
    "method_entry",
    "after_domain_write",
    "after_event",
    "after_idempotency",
  ],
  createPreview: [
    "method_entry",
    "after_domain_write",
    "after_event",
    "after_idempotency",
  ],
  decideApproval: [
    "method_entry",
    "after_domain_write",
    "after_event",
    "after_idempotency",
  ],
  publishRelease: [
    "method_entry",
    "after_idempotency",
    "after_release_status_change",
    "after_domain_write",
    "after_event",
  ],
  recordReadback: [
    "method_entry",
    "after_idempotency",
    "after_release_status_change",
    "after_domain_write",
    "after_event",
  ],
  completeIdempotency: [
    "method_entry",
    "after_domain_write",
    "after_idempotency",
    "after_event",
  ],
  getControlState: ["method_entry"],
  getActiveRelease: ["method_entry"],
  getPendingRelease: ["method_entry"],
  getNewestUnresolvedRelease: ["method_entry"],
  getPreview: ["method_entry"],
  getApproval: ["method_entry"],
  getRelease: ["method_entry"],
  getReadback: ["method_entry"],
  getIdempotency: ["method_entry"],
});

type FakeControlRepositoryRequestByMethod = {
  readonly health: null;
  readonly close: null;
  readonly registerModule: RegisterModuleRecordRequest;
  readonly createPreview: CreatePreviewRecordRequest;
  readonly decideApproval: DecideApprovalRecordRequest;
  readonly publishRelease: PublishReleaseRecordRequest;
  readonly recordReadback: RecordReadbackRequest;
  readonly completeIdempotency: CompleteControlIdempotencyRequest;
  readonly getControlState: null;
  readonly getActiveRelease: null;
  readonly getPendingRelease: null;
  readonly getNewestUnresolvedRelease: null;
  readonly getPreview: GetModulePreviewQuery;
  readonly getApproval: GetModuleApprovalQuery;
  readonly getRelease: GetModuleReleaseQuery;
  readonly getReadback: GetModuleReadbackQuery;
  readonly getIdempotency: GetControlIdempotencyQuery;
};

export type FakeControlRepositoryCall = {
  [Method in FakeControlRepositoryMethodName]: {
    readonly method: Method;
    readonly request: DeepReadonly<FakeControlRepositoryRequestByMethod[Method]>;
  };
}[FakeControlRepositoryMethodName];

export interface FakeModuleControlRepositoryRecords {
  readonly registrations?: readonly ModuleRegistrationRecord[];
  readonly previews?: readonly ModulePreviewRecord[];
  readonly approvals?: readonly ModuleApprovalRecord[];
  readonly releases?: readonly ModuleReleaseRecord[];
  readonly readbacks?: readonly ModuleReadbackRecord[];
  readonly idempotency?: readonly ModuleControlIdempotencyRecord[];
  readonly events?: readonly ControlEventRecord[];
  readonly eventAuthorities?: readonly FakeModuleControlRepositoryEventAuthority[];
}

export interface FakeModuleControlRepositoryEventAuthority {
  readonly eventId: string;
  readonly action: ModuleControlAction;
  readonly idempotencyKey: string;
  readonly requestHash: CanonicalRequestHash;
}

export interface FakeModuleControlRepositoryOptions {
  readonly managementTenantId: string;
  readonly records?: FakeModuleControlRepositoryRecords;
}

interface CloneBudget {
  nodes: number;
}

interface PersistentSnapshot {
  readonly registrations: readonly (readonly [string, ModuleRegistrationRecord])[];
  readonly previews: readonly (readonly [string, ModulePreviewRecord])[];
  readonly approvals: readonly (readonly [string, ModuleApprovalRecord])[];
  readonly releases: readonly (readonly [string, ModuleReleaseRecord])[];
  readonly readbacks: readonly (readonly [string, ModuleReadbackRecord])[];
  readonly idempotency: readonly (readonly [string, ModuleControlIdempotencyRecord])[];
  readonly events: readonly ControlEventRecord[];
  readonly eventAuthorities: readonly (readonly [string, string])[];
  readonly nextEventSequence: number;
}

const OBJECT_PROTOTYPE = Object.prototype;
const MAX_CONTROL_RECORD_DEPTH = 64;
const MAX_CONTROL_RECORD_NODES = 100_000;
const MAX_CONTROL_ARRAY_LENGTH = 10_000;
const CONTROL_STATE_RELEASE_HISTORY_WINDOW = 128;
const CONTROL_STATE_EVENT_WINDOW = 256;
const IDEMPOTENCY_TTL_MILLISECONDS = 86_400_000n;

function repositoryError(code: ModuleControlRepositoryErrorCode): never {
  throw new ModuleControlRepositoryError(code);
}

function invalidState(): never {
  repositoryError("invalid_state");
}

function assertRepositoryIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    invalidState();
  }
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    invalidState();
  }
  if (nodeUtilTypes.isProxy(value) || Array.isArray(value)) invalidState();
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== OBJECT_PROTOTYPE) invalidState();
}

function assertWellFormedString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalidState();
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalidState();
    }
  }
}

function cloneSnapshotValue(
  value: unknown,
  stack: WeakSet<object>,
  budget: CloneBudget,
  depth: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_CONTROL_RECORD_NODES || depth > MAX_CONTROL_RECORD_DEPTH) {
    invalidState();
  }
  if (value === null || typeof value === "boolean" || typeof value === "undefined") {
    return value;
  }
  if (typeof value === "string") {
    assertWellFormedString(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidState();
    return value;
  }
  if (typeof value !== "object") invalidState();
  if (nodeUtilTypes.isProxy(value)) invalidState();
  if (stack.has(value)) invalidState();

  if (Array.isArray(value)) {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) invalidState();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors["length"] as PropertyDescriptor | undefined;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      lengthDescriptor.value > MAX_CONTROL_ARRAY_LENGTH ||
      Reflect.ownKeys(descriptors).length !== lengthDescriptor.value + 1
    ) {
      invalidState();
    }
    stack.add(value);
    const clone: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalidState();
      }
      clone.push(cloneSnapshotValue(descriptor.value, stack, budget, depth + 1));
    }
    stack.delete(value);
    return clone;
  }

  assertPlainObject(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const clone = {} as Record<string, unknown>;
  stack.add(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") invalidState();
    assertWellFormedString(key);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      invalidState();
    }
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneSnapshotValue(descriptor.value, stack, budget, depth + 1),
      writable: true,
    });
  }
  stack.delete(value);
  return clone;
}

function freezeRecursively(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      freezeRecursively(descriptor.value, seen);
    }
  }
  Object.freeze(value);
}

function freezeSnapshot<T>(value: T): DeepReadonly<T> {
  const clone = cloneSnapshotValue(
    value,
    new WeakSet<object>(),
    { nodes: 0 },
    0,
  ) as T;
  freezeRecursively(clone, new WeakSet<object>());
  return clone as DeepReadonly<T>;
}

function recordTimestamp(record: ControlRecord): string {
  if ("registeredAt" in record) return record.registeredAt;
  if ("createdAt" in record) return record.createdAt;
  if ("decidedAt" in record) return record.decidedAt;
  if ("checkedAt" in record) return record.checkedAt;
  if ("occurredAt" in record) return record.occurredAt;
  invalidState();
}

function recordKey(tenant: string, ...parts: readonly string[]): string {
  return [tenant, ...parts].join("\0");
}

function idempotencyKey(
  tenant: string,
  action: ModuleControlAction,
  key: string,
): string {
  return recordKey(tenant, action, key);
}

function registrationRef(record: ModuleRegistrationRecord): string {
  return `registration:${record.moduleId}:${record.version}:${record.descriptorDigest}`;
}

function idempotencyExpiresAt(createdAt: string): string {
  const expiresAt = addRfc3339Milliseconds(
    createdAt,
    IDEMPOTENCY_TTL_MILLISECONDS,
  );
  if (expiresAt === null) invalidState();
  return expiresAt;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareTuple(left: readonly string[], right: readonly string[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareStrings(left[index] ?? "", right[index] ?? "");
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function isExpiredAt(expiresAt: string, operationAt: string): boolean {
  const comparison = compareRfc3339Instants(expiresAt, operationAt);
  if (comparison === null) invalidState();
  return comparison <= 0;
}

function moduleRefKey(ref: ModuleControlRef): string {
  return `${ref.moduleId}\0${ref.version}\0${ref.descriptorDigest}`;
}

function moduleRefSetKeys(refs: readonly ModuleControlRef[]): readonly string[] | null {
  const keys = refs.map((ref) => moduleRefKey(ref));
  if (new Set(keys).size !== keys.length) return null;
  return [...keys].sort(compareStrings);
}

function sameModuleRefs(
  left: readonly ModuleControlRef[],
  right: readonly ModuleControlRef[],
): boolean {
  const leftKeys = moduleRefSetKeys(left);
  const rightKeys = moduleRefSetKeys(right);
  return (
    leftKeys !== null &&
    rightKeys !== null &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function projectReleaseHistory(
  managementTenantId: string,
  releases: Iterable<ModuleReleaseRecord>,
  previews: ReadonlyMap<string, ModulePreviewRecord>,
): readonly ModuleReleaseHistoryEntry[] {
  const orderedReleases = [...releases].sort(
    (left, right) =>
      right.revision - left.revision || compareStrings(right.releaseId, left.releaseId),
  );
  return orderedReleases
    .slice(0, CONTROL_STATE_RELEASE_HISTORY_WINDOW)
    .map((release) => {
      if (release.managementTenantId !== managementTenantId) invalidState();
      const preview = previews.get(
        recordKey(managementTenantId, release.previewRef),
      );
      if (
        preview === undefined ||
        preview.managementTenantId !== managementTenantId ||
        preview.previewRef !== release.previewRef
      ) {
        invalidState();
      }
      if (preview.intent === "change") {
        if (Object.prototype.hasOwnProperty.call(preview, "targetReleaseId")) {
          invalidState();
        }
        return {
          release,
          intent: "change",
          rollbackTargetReleaseId: null,
        } satisfies ModuleReleaseHistoryEntry;
      }
      if (preview.intent === "rollback") {
        assertRepositoryIdentifier(preview.targetReleaseId);
        return {
          release,
          intent: "rollback",
          rollbackTargetReleaseId: preview.targetReleaseId,
        } satisfies ModuleReleaseHistoryEntry;
      }
      invalidState();
    });
}

function sameStringMultiset(left: readonly string[], right: readonly string[]): boolean {
  const leftValues = [...left].sort(compareStrings);
  const rightValues = [...right].sort(compareStrings);
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

function envelopeModuleRefs(value: unknown): readonly ModuleControlRef[] {
  if (!Array.isArray(value)) repositoryError("conflict");
  const refs = value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof Reflect.get(item, "module_id") !== "string" ||
      typeof Reflect.get(item, "version") !== "string" ||
      typeof Reflect.get(item, "descriptor_digest") !== "string"
    ) {
      repositoryError("conflict");
    }
    return {
      moduleId: Reflect.get(item, "module_id") as string,
      version: Reflect.get(item, "version") as string,
      descriptorDigest: Reflect.get(item, "descriptor_digest") as ModuleControlRef["descriptorDigest"],
    };
  });
  if (moduleRefSetKeys(refs) === null) repositoryError("conflict");
  return refs;
}

function validateFinalResult(
  value: ControlFinalResult,
  action: ModuleControlAction,
  expectedDomainRecordRef: string,
  expectedRevision?: number,
): ControlFinalResult {
  assertPlainObject(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("domainRecordRef") ||
    !keys.includes("envelope")
  ) {
    invalidState();
  }
  if (value.domainRecordRef !== expectedDomainRecordRef) repositoryError("conflict");
  const parsed = controlEnvelopeSchema.safeParse(value.envelope);
  if (!parsed.success) invalidState();
  const data = parsed.data.data;
  switch (action) {
    case "packages.register": {
      if (
        data?.kind !== "registration" ||
        data.module_id === undefined ||
        data.version === undefined ||
        data.descriptor_digest === undefined ||
        `registration:${data.module_id}:${data.version}:${data.descriptor_digest}` !==
          expectedDomainRecordRef
      ) {
        repositoryError("conflict");
      }
      break;
    }
    case "deployments.preview":
      if (data?.kind !== "preview" || data.preview_ref !== expectedDomainRecordRef) {
        repositoryError("conflict");
      }
      break;
    case "approvals.decide":
      if (data?.kind !== "approval" || data.approval_id !== expectedDomainRecordRef) {
        repositoryError("conflict");
      }
      break;
    case "deployments.publish":
      if (
        data?.kind !== "release" ||
        data.release_id !== expectedDomainRecordRef ||
        data.revision === undefined ||
        (expectedRevision !== undefined && data.revision !== expectedRevision)
      ) {
        repositoryError("conflict");
      }
      break;
    case "deployments.reconcile":
      if (
        data?.kind !== "reconciliation" ||
        data.release_id !== expectedDomainRecordRef ||
        data.revision === undefined ||
        data.status === undefined ||
        (expectedRevision !== undefined && data.revision !== expectedRevision)
      ) {
        repositoryError("conflict");
      }
      break;
  }
  if (action === "deployments.publish" || action === "deployments.reconcile") {
    if (
      data === null ||
      !("revision" in data) ||
      data.revision === undefined ||
      parsed.data.readback.release_id !== expectedDomainRecordRef ||
      parsed.data.readback.revision !== data.revision ||
      (parsed.data.status === "success" && parsed.data.readback.status !== "verified") ||
      (parsed.data.status === "manual_review" &&
        parsed.data.readback.status !== "mismatch" &&
        parsed.data.readback.status !== "unknown") ||
      (parsed.data.status !== "success" && parsed.data.status !== "manual_review")
    ) {
      repositoryError("conflict");
    }
    if (
      action === "deployments.reconcile" &&
      data.kind === "reconciliation" &&
      data.status !== parsed.data.readback.status
    ) {
      repositoryError("conflict");
    }
  }
  return freezeSnapshot({
    domainRecordRef: value.domainRecordRef,
    envelope: parsed.data,
  }) as ControlFinalResult;
}

export class FakeModuleControlRepository implements ModuleControlRepository {
  private readonly managementTenantId: string;
  private readonly registrationRecords = new Map<string, ModuleRegistrationRecord>();
  private readonly previewRecords = new Map<string, ModulePreviewRecord>();
  private readonly approvalRecords = new Map<string, ModuleApprovalRecord>();
  private readonly releaseRecords = new Map<string, ModuleReleaseRecord>();
  private readonly readbackRecords = new Map<string, ModuleReadbackRecord>();
  private readonly idempotencyRecords = new Map<string, ModuleControlIdempotencyRecord>();
  private readonly eventRecords: ControlEventRecord[] = [];
  private readonly eventAuthorityKeys = new Map<string, string>();
  private readonly failureQueues = new Map<string, ModuleControlRepositoryError[]>();
  private readonly callLog: FakeControlRepositoryCall[] = [];
  private nextEventSequence = 1;
  private closed = false;

  constructor(options: FakeModuleControlRepositoryOptions) {
    assertRepositoryIdentifier(options.managementTenantId);
    assertWellFormedString(options.managementTenantId);
    this.managementTenantId = options.managementTenantId;
    try {
      this.seed(options.records);
    } catch (error: unknown) {
      if (error instanceof ModuleControlRepositoryError) throw error;
      invalidState();
    }
  }

  get calls(): readonly FakeControlRepositoryCall[] {
    return Object.freeze([...this.callLog]);
  }

  queueFailure(
    method: FakeControlRepositoryMethodName,
    failure: ModuleControlRepositoryErrorCode | ModuleControlRepositoryError,
    phase: FakeControlRepositoryFailurePhase = "method_entry",
  ): void {
    if (!FAKE_CONTROL_REPOSITORY_METHOD_NAMES.includes(method)) invalidState();
    if (!FAKE_CONTROL_REPOSITORY_FAILURE_PHASES.includes(phase)) invalidState();
    if (!FAILURE_PHASE_ALLOWLIST[method].includes(phase)) invalidState();
    const typedFailure =
      failure instanceof ModuleControlRepositoryError
        ? new ModuleControlRepositoryError(failure.code)
        : new ModuleControlRepositoryError(failure);
    const key = this.failureKey(method, phase);
    const queue = this.failureQueues.get(key);
    if (queue === undefined) this.failureQueues.set(key, [typedFailure]);
    else queue.push(typedFailure);
  }

  async health(): Promise<{ readonly ready: boolean }> {
    this.recordCall("health", null);
    await Promise.resolve();
    if (this.closed) return Object.freeze({ ready: false });
    this.consumeFailure("health", "method_entry");
    return Object.freeze({ ready: true });
  }

  async close(): Promise<void> {
    this.recordCall("close", null);
    await Promise.resolve();
    if (this.closed) return;
    this.consumeFailure("close", "method_entry");
    this.closed = true;
  }

  async registerModule(
    request: RegisterModuleRecordRequest,
  ): Promise<RegistrationWriteResult> {
    const safeRequest = this.begin("registerModule", request);
    await Promise.resolve();
    const bound = this.bindRequest<ModuleRegistrationRecord>(
      safeRequest,
    );
    const metadata = bound.metadata;
    const record = bound.record;
    const existing = this.findRequestIdempotency(metadata);
    if (existing !== null) {
      this.assertExistingIdempotency(existing, metadata);
      return this.replaySimple<ModuleRegistrationRecord>(
        metadata,
        existing,
        "registration",
      ) as RegistrationWriteResult;
    }
    const completed = this.completedIdempotencyCandidate(
      metadata,
      registrationRef(record),
      safeRequest.finalResult as unknown as ControlFinalResult,
      record.registeredAt,
    );
    const domainKey = recordKey(
      this.managementTenantId,
      record.moduleId,
      record.version,
      record.descriptorDigest,
    );
    if (this.registrationRecords.has(domainKey)) repositoryError("conflict");

    return this.withAtomicWrite("registerModule", () => {
      const stored = this.snapshotRecord(record);
      this.registrationRecords.set(domainKey, stored);
      this.consumeFailure("registerModule", "after_domain_write");
      const event = this.appendEvent(metadata, stored);
      this.consumeFailure("registerModule", "after_event");
      this.insertIdempotency(completed);
      this.consumeFailure("registerModule", "after_idempotency");
      return this.writeResult(stored, event, false);
    });
  }

  async createPreview(request: CreatePreviewRecordRequest): Promise<PreviewWriteResult> {
    const safeRequest = this.begin("createPreview", request);
    await Promise.resolve();
    const bound = this.bindRequest<ModulePreviewRecord>(
      safeRequest,
    );
    const metadata = bound.metadata;
    const record = bound.record;
    const existing = this.findRequestIdempotency(metadata);
    if (existing !== null) {
      this.assertExistingIdempotency(existing, metadata);
      return this.replaySimple<ModulePreviewRecord>(
        metadata,
        existing,
        "preview",
      ) as PreviewWriteResult;
    }
    const completed = this.completedIdempotencyCandidate(
      metadata,
      record.previewRef,
      safeRequest.finalResult as unknown as ControlFinalResult,
      record.createdAt,
    );
    const domainKey = recordKey(this.managementTenantId, record.previewRef);
    if (this.previewRecords.has(domainKey)) repositoryError("conflict");

    return this.withAtomicWrite("createPreview", () => {
      const stored = this.snapshotRecord(record);
      this.previewRecords.set(domainKey, stored);
      this.consumeFailure("createPreview", "after_domain_write");
      const event = this.appendEvent(metadata, stored);
      this.consumeFailure("createPreview", "after_event");
      this.insertIdempotency(completed);
      this.consumeFailure("createPreview", "after_idempotency");
      return this.writeResult(stored, event, false);
    });
  }

  async decideApproval(
    request: DecideApprovalRecordRequest,
  ): Promise<ApprovalWriteResult> {
    const safeRequest = this.begin("decideApproval", request);
    await Promise.resolve();
    const bound = this.bindRequest<ModuleApprovalRecord>(
      safeRequest,
    );
    const metadata = bound.metadata;
    const record = bound.record;
    const existing = this.findRequestIdempotency(metadata);
    if (existing !== null) {
      this.assertExistingIdempotency(existing, metadata);
      return this.replaySimple<ModuleApprovalRecord>(
        metadata,
        existing,
        "approval",
      ) as ApprovalWriteResult;
    }
    const completed = this.completedIdempotencyCandidate(
      metadata,
      record.approvalId,
      safeRequest.finalResult as unknown as ControlFinalResult,
      record.decidedAt,
    );
    this.validateNewApproval(record);

    return this.withAtomicWrite("decideApproval", () => {
      const stored = this.snapshotRecord(record);
      this.approvalRecords.set(
        recordKey(this.managementTenantId, stored.approvalId),
        stored,
      );
      this.consumeFailure("decideApproval", "after_domain_write");
      const event = this.appendEvent(metadata, stored);
      this.consumeFailure("decideApproval", "after_event");
      this.insertIdempotency(completed);
      this.consumeFailure("decideApproval", "after_idempotency");
      return this.writeResult(stored, event, false);
    });
  }

  async publishRelease(
    request: PublishReleaseRecordRequest,
  ): Promise<ReleaseWriteResult> {
    const safeRequest = this.begin("publishRelease", request);
    await Promise.resolve();
    const bound = this.bindRequest<ModuleReleaseRecord>(
      safeRequest as unknown as PublishReleaseRecordRequest,
    );
    const metadata = bound.metadata;
    const record = bound.record as ModuleReleaseRecord;
    const existing = this.findRequestIdempotency(metadata);
    if (existing !== null) {
      this.assertExistingIdempotency(existing, metadata);
      return this.replayPublish(metadata, existing);
    }
    const { preview, approval } = this.validateNewRelease(record);
    const committed = this.domainCommittedIdempotencyCandidate(
      metadata,
      record.releaseId,
      record.createdAt,
    );

    return this.withAtomicWrite("publishRelease", () => {
      this.insertIdempotency(committed);
      this.consumeFailure("publishRelease", "after_idempotency");
      this.previewRecords.set(
        recordKey(this.managementTenantId, preview.previewRef),
        this.snapshotRecord({ ...preview, consumed: true }),
      );
      this.approvalRecords.set(
        recordKey(this.managementTenantId, approval.approvalId),
        this.snapshotRecord({ ...approval, consumed: true }),
      );
      this.consumeFailure("publishRelease", "after_release_status_change");
      const stored = this.snapshotRecord(record);
      this.releaseRecords.set(
        recordKey(this.managementTenantId, stored.releaseId),
        stored,
      );
      this.consumeFailure("publishRelease", "after_domain_write");
      const event = this.appendEvent(metadata, stored);
      this.consumeFailure("publishRelease", "after_event");
      return this.writeResult(stored, event, false);
    });
  }

  async recordReadback(request: RecordReadbackRequest): Promise<ReadbackWriteResult> {
    const safeRequest = this.begin("recordReadback", request);
    await Promise.resolve();
    const bound = this.bindRequest<ModuleReadbackRecord>(
      safeRequest as unknown as RecordReadbackRequest,
    );
    const metadata = bound.metadata;
    const record = bound.record as ModuleReadbackRecord;
    const existingIdempotency = this.findRequestIdempotency(metadata);
    if (existingIdempotency !== null) {
      this.assertExistingIdempotency(existingIdempotency, metadata);
      if (existingIdempotency.status === "reserved") repositoryError("invalid_state");
      if (existingIdempotency.domainRecordRef !== record.releaseId) {
        repositoryError("conflict");
      }
      const replay = this.tryReplayReadback(metadata, record);
      if (replay !== null) return replay;
    }
    if (metadata.action === "deployments.publish") {
      if (existingIdempotency === null) repositoryError("not_found");
      if (
        existingIdempotency.status !== "domain_committed" &&
        existingIdempotency.status !== "completed"
      ) {
        repositoryError("invalid_state");
      }
    }

    const release = this.releaseRecords.get(
      recordKey(this.managementTenantId, record.releaseId),
    );
    if (release === undefined) repositoryError("not_found");
    if (release.revision !== record.revision) repositoryError("conflict");
    if (metadata.action === "deployments.reconcile") {
      const newest = this.findReleaseByStatusRecord(
        "published_pending_readback",
        "manual_review",
      );
      if (
        newest === null ||
        newest.releaseId !== release.releaseId ||
        newest.revision !== release.revision
      ) {
        repositoryError("conflict");
      }
    }

    const readbackKey = recordKey(this.managementTenantId, record.releaseId);
    const existingReadback = this.readbackRecords.get(readbackKey) ?? null;
    const exactExisting =
      existingReadback !== null && isDeepStrictEqual(existingReadback, record);
    if (existingReadback !== null && existingIdempotency !== null) {
      if (!exactExisting) repositoryError("conflict");
      const replay = this.tryReplayReadback(metadata, record);
      if (replay !== null) return replay;
      invalidState();
    }
    if (
      metadata.action === "deployments.publish" &&
      release.status !== "published_pending_readback"
    ) {
      repositoryError("conflict");
    }
    if (existingIdempotency?.status === "completed") repositoryError("conflict");
    if (
      existingReadback !== null &&
      (existingReadback.status === "verified" ||
        release.status === "active_verified" ||
        release.status === "superseded")
    ) {
      repositoryError("conflict");
    }
    if (
      record.status === "verified" &&
      (record.appliedReleaseId !== release.releaseId ||
        record.appliedRevision !== release.revision ||
        !sameModuleRefs(record.appliedModules, release.desiredModules))
    ) {
      repositoryError("conflict");
    }
    if (
      record.status === "pending" &&
      release.status !== "published_pending_readback"
    ) {
      repositoryError("conflict");
    }
    for (const candidate of this.readbackRecords.values()) {
      if (
        candidate.readbackRef === record.readbackRef &&
        candidate.releaseId !== record.releaseId
      ) {
        repositoryError("conflict");
      }
    }
    const committed =
      metadata.action === "deployments.reconcile" && existingIdempotency === null
        ? this.domainCommittedIdempotencyCandidate(
            metadata,
            record.releaseId,
            record.checkedAt,
          )
        : null;

    return this.withAtomicWrite("recordReadback", () => {
      if (committed !== null) {
        this.insertIdempotency(committed);
        this.consumeFailure("recordReadback", "after_idempotency");
      }
      if (!exactExisting) {
        this.readbackRecords.set(readbackKey, this.snapshotRecord(record));
      }
      this.consumeFailure("recordReadback", "after_domain_write");

      let changedReleaseStatus = false;
      if (!exactExisting && record.status === "verified") {
        const previousActive = this.findReleaseByStatusRecord("active_verified");
        if (
          previousActive !== null &&
          previousActive.releaseId !== release.releaseId
        ) {
          this.releaseRecords.set(
            recordKey(this.managementTenantId, previousActive.releaseId),
            this.snapshotRecord({
              ...previousActive,
              status: "superseded",
              supersededByReleaseId: release.releaseId,
            } as ModuleReleaseRecord),
          );
        }
        this.releaseRecords.set(
          recordKey(this.managementTenantId, release.releaseId),
          this.snapshotRecord({
            ...release,
            publishedAt: release.publishedAt ?? release.createdAt,
            status: "active_verified",
            readbackRef: record.readbackRef,
            reasonCodes: [],
            supersededByReleaseId: null,
          }),
        );
        changedReleaseStatus = true;
      } else if (
        !exactExisting &&
        (record.status === "mismatch" || record.status === "unknown")
      ) {
        this.releaseRecords.set(
          recordKey(this.managementTenantId, release.releaseId),
          this.snapshotRecord({
            ...release,
            publishedAt: release.publishedAt ?? release.createdAt,
            status: "manual_review",
            readbackRef: record.readbackRef,
            reasonCodes: [...record.reasonCodes],
            supersededByReleaseId: null,
          }),
        );
        changedReleaseStatus = true;
      }
      if (changedReleaseStatus) {
        this.consumeFailure("recordReadback", "after_release_status_change");
      }
      const event = this.appendEvent(metadata, record);
      this.consumeFailure("recordReadback", "after_event");
      const persisted = this.readbackRecords.get(readbackKey);
      if (persisted === undefined) invalidState();
      return this.writeResult(persisted, event, false);
    });
  }

  async completeIdempotency(
    request: CompleteControlIdempotencyRequest,
  ): Promise<DeepReadonly<ModuleControlIdempotencyRecord>> {
    const safeRequest = this.begin("completeIdempotency", request);
    await Promise.resolve();
    const bound = this.bindRequest<ModuleControlIdempotencyRecord>(
      safeRequest as unknown as CompleteControlIdempotencyRequest,
    );
    const metadata = bound.metadata;
    const requested = bound.record as ModuleControlIdempotencyRecord;
    if (requested.status !== "completed" || requested.finalResult === null) {
      repositoryError("invalid_state");
    }
    const existing = this.findRequestIdempotency(metadata);
    if (existing === null) repositoryError("not_found");
    this.assertExistingIdempotency(existing, metadata);
    if (
      existing.createdAt !== requested.createdAt ||
      existing.expiresAt !== requested.expiresAt
    ) {
      repositoryError("conflict");
    }
    if (existing.status === "completed") {
      if (!isDeepStrictEqual(existing, requested)) repositoryError("conflict");
      return this.snapshotRecord(existing);
    }
    if (existing.status === "reserved") repositoryError("conflict");
    if (existing.status !== "domain_committed") repositoryError("invalid_state");
    if (existing.domainRecordRef !== requested.domainRecordRef) {
      repositoryError("conflict");
    }

    let revision: number | undefined;
    if (
      metadata.action === "deployments.publish" ||
      metadata.action === "deployments.reconcile"
    ) {
      const release = this.releaseRecords.get(
        recordKey(this.managementTenantId, requested.domainRecordRef),
      );
      if (release === undefined) repositoryError("not_found");
      revision = release.revision;
    }
    const finalResult = validateFinalResult(
      requested.finalResult,
      metadata.action,
      requested.domainRecordRef,
      revision,
    );
    const completed = this.snapshotRecord({
      ...requested,
      finalResult,
    });
    if (
      metadata.action === "deployments.publish" ||
      metadata.action === "deployments.reconcile"
    ) {
      this.validatePersistedReleaseCompletion(
        metadata.action,
        finalResult,
        "conflict",
      );
    }

    return this.withAtomicWrite("completeIdempotency", () => {
      this.idempotencyRecords.set(
        idempotencyKey(
          this.managementTenantId,
          metadata.action,
          metadata.idempotencyKey,
        ),
        completed,
      );
      this.consumeFailure("completeIdempotency", "after_domain_write");
      this.consumeFailure("completeIdempotency", "after_idempotency");
      this.appendEvent(metadata, completed);
      this.consumeFailure("completeIdempotency", "after_event");
      return this.snapshotRecord(completed);
    });
  }

  async getControlState(): Promise<DeepReadonly<ModuleControlState>> {
    this.begin("getControlState", null);
    await Promise.resolve();
    this.validateSeedGraph();
    const activeRelease = this.findReleaseByStatusRecord("active_verified");
    const orderedEvents = [...this.eventRecords]
      .sort(
        (left, right) =>
          left.sequence - right.sequence || compareStrings(left.eventId, right.eventId),
      )
    const eventsTruncated = this.eventRecords.length > CONTROL_STATE_EVENT_WINDOW;
    const events = orderedEvents.slice(-CONTROL_STATE_EVENT_WINDOW);
    return deepFreezeControlRecord({
      managementTenantId: this.managementTenantId,
      activeRelease,
      activeRevision: activeRelease?.revision ?? 0,
      activeModules: activeRelease?.desiredModules ?? [],
      registrations: [...this.registrationRecords.values()].sort((left, right) =>
        compareTuple(
          [left.moduleId, left.version, left.descriptorDigest],
          [right.moduleId, right.version, right.descriptorDigest],
        ),
      ),
      latestPreview: this.latestBy(
        this.previewRecords.values(),
        (record) => record.createdAt,
        (record) => record.previewRef,
      ),
      latestApproval: this.latestBy(
        this.approvalRecords.values(),
        (record) => record.decidedAt,
        (record) => record.approvalId,
      ),
      latestReadback: this.latestBy(
        this.readbackRecords.values(),
        (record) => record.checkedAt,
        (record) => record.releaseId,
      ),
      releaseHistory: projectReleaseHistory(
        this.managementTenantId,
        this.releaseRecords.values(),
        this.previewRecords,
      ),
      events,
      eventsTruncated,
    });
  }

  async getActiveRelease(): Promise<DeepReadonly<ModuleReleaseRecord> | null> {
    this.begin("getActiveRelease", null);
    await Promise.resolve();
    return this.snapshotNullable(this.findReleaseByStatusRecord("active_verified"));
  }

  async getPendingRelease(): Promise<DeepReadonly<ModuleReleaseRecord> | null> {
    this.begin("getPendingRelease", null);
    await Promise.resolve();
    return this.snapshotNullable(
      this.findReleaseByStatusRecord("published_pending_readback"),
    );
  }

  async getNewestUnresolvedRelease(): Promise<DeepReadonly<ModuleReleaseRecord> | null> {
    this.begin("getNewestUnresolvedRelease", null);
    await Promise.resolve();
    return this.snapshotNullable(
      this.findReleaseByStatusRecord("published_pending_readback", "manual_review"),
    );
  }

  async getPreview(
    query: GetModulePreviewQuery,
  ): Promise<DeepReadonly<ModulePreviewRecord> | null> {
    const safeQuery = this.begin("getPreview", query);
    await Promise.resolve();
    this.assertExactQuery(safeQuery, ["managementTenantId", "previewRef"]);
    this.assertTenant(safeQuery.managementTenantId);
    return this.snapshotNullable(
      this.previewRecords.get(
        recordKey(this.managementTenantId, safeQuery.previewRef),
      ) ?? null,
    );
  }

  async getApproval(
    query: GetModuleApprovalQuery,
  ): Promise<DeepReadonly<ModuleApprovalRecord> | null> {
    const safeQuery = this.begin("getApproval", query);
    await Promise.resolve();
    this.assertExactQuery(safeQuery, ["managementTenantId", "approvalId"]);
    this.assertTenant(safeQuery.managementTenantId);
    return this.snapshotNullable(
      this.approvalRecords.get(
        recordKey(this.managementTenantId, safeQuery.approvalId),
      ) ?? null,
    );
  }

  async getRelease(
    query: GetModuleReleaseQuery,
  ): Promise<DeepReadonly<ModuleReleaseRecord> | null> {
    const safeQuery = this.begin("getRelease", query);
    await Promise.resolve();
    this.assertExactQuery(safeQuery, ["managementTenantId", "releaseId"]);
    this.assertTenant(safeQuery.managementTenantId);
    return this.snapshotNullable(
      this.releaseRecords.get(
        recordKey(this.managementTenantId, safeQuery.releaseId),
      ) ?? null,
    );
  }

  async getReadback(
    query: GetModuleReadbackQuery,
  ): Promise<DeepReadonly<ModuleReadbackRecord> | null> {
    const safeQuery = this.begin("getReadback", query);
    await Promise.resolve();
    this.assertExactQuery(safeQuery, ["managementTenantId", "releaseId"]);
    this.assertTenant(safeQuery.managementTenantId);
    return this.snapshotNullable(
      this.readbackRecords.get(
        recordKey(this.managementTenantId, safeQuery.releaseId),
      ) ?? null,
    );
  }

  async getIdempotency(
    query: GetControlIdempotencyQuery,
  ): Promise<DeepReadonly<ModuleControlIdempotencyRecord> | null> {
    const safeQuery = this.begin("getIdempotency", query);
    await Promise.resolve();
    this.assertExactQuery(safeQuery, [
      "managementTenantId",
      "action",
      "idempotencyKey",
    ]);
    this.assertTenant(safeQuery.managementTenantId);
    if (!MODULE_CONTROL_ACTIONS.includes(safeQuery.action)) invalidState();
    return this.snapshotNullable(
      this.idempotencyRecords.get(
        idempotencyKey(
          this.managementTenantId,
          safeQuery.action,
          safeQuery.idempotencyKey,
        ),
      ) ?? null,
    );
  }

  private begin<M extends FakeControlRepositoryMethodName>(
    method: M,
    request: FakeControlRepositoryRequestByMethod[M],
  ): DeepReadonly<FakeControlRepositoryRequestByMethod[M]> {
    if (this.closed) repositoryError("closed");
    const snapshot = this.recordCall(method, request);
    this.consumeFailure(method, "method_entry");
    return snapshot;
  }

  private recordCall<M extends FakeControlRepositoryMethodName>(
    method: M,
    request: FakeControlRepositoryRequestByMethod[M],
  ): DeepReadonly<FakeControlRepositoryRequestByMethod[M]> {
    let snapshot: DeepReadonly<FakeControlRepositoryRequestByMethod[M]>;
    try {
      snapshot = freezeSnapshot(request);
    } catch (error: unknown) {
      if (error instanceof ModuleControlRepositoryError) throw error;
      invalidState();
    }
    const call = Object.freeze({ method, request: snapshot });
    this.callLog.push(call as FakeControlRepositoryCall);
    return snapshot;
  }

  private failureKey(
    method: FakeControlRepositoryMethodName,
    phase: FakeControlRepositoryFailurePhase,
  ): string {
    return `${method}\0${phase}`;
  }

  private consumeFailure(
    method: FakeControlRepositoryMethodName,
    phase: FakeControlRepositoryFailurePhase,
  ): void {
    const queue = this.failureQueues.get(this.failureKey(method, phase));
    const failure = queue?.shift();
    if (failure !== undefined) throw failure;
  }

  private bindRequest<T extends ControlRecord>(request: {
    readonly metadata: ControlRequestMetadata;
    readonly record: T;
  }): {
    readonly metadata: DeepReadonly<ControlRequestMetadata>;
    readonly record: DeepReadonly<T>;
  } {
    try {
      const bound = assertControlRequestBinding({
        metadata: request.metadata,
        record: request.record,
      });
      this.assertTenant(bound.metadata.managementTenantId);
      return bound as {
        readonly metadata: DeepReadonly<ControlRequestMetadata>;
        readonly record: DeepReadonly<T>;
      };
    } catch (error: unknown) {
      if (error instanceof ModuleControlRepositoryError) throw error;
      invalidState();
    }
  }

  private assertTenant(tenant: string): void {
    if (tenant !== this.managementTenantId) repositoryError("tenant_mismatch");
  }

  private assertExactQuery(
    query: unknown,
    expectedKeys: readonly string[],
  ): asserts query is Record<string, string> {
    assertPlainObject(query);
    const actualKeys = Reflect.ownKeys(query);
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some(
        (key) => typeof key !== "string" || !expectedKeys.includes(key),
      )
    ) {
      invalidState();
    }
    for (const key of expectedKeys) {
      if (!Object.prototype.hasOwnProperty.call(query, key)) invalidState();
      assertRepositoryIdentifier(query[key]);
    }
  }

  private completedIdempotencyCandidate(
    metadata: DeepReadonly<ControlRequestMetadata>,
    domainRecordRef: string,
    finalResult: ControlFinalResult,
    createdAt: string,
  ): ModuleControlIdempotencyRecord {
    const validatedFinal = validateFinalResult(
      finalResult,
      metadata.action,
      domainRecordRef,
    );
    const candidate = {
      managementTenantId: this.managementTenantId,
      action: metadata.action,
      idempotencyKey: metadata.idempotencyKey,
      requestHash: metadata.requestHash,
      actorRef: metadata.actorRef,
      status: "completed",
      domainRecordRef,
      finalResult: validatedFinal,
      createdAt,
      expiresAt: idempotencyExpiresAt(createdAt),
    } as const satisfies ModuleControlIdempotencyRecord;
    const objectRef = `idempotency:${metadata.action}:${metadata.idempotencyKey}`;
    const completionMetadata = {
      managementTenantId: metadata.managementTenantId,
      actorRef: metadata.actorRef,
      action: metadata.action,
      idempotencyKey: metadata.idempotencyKey,
      requestHash: metadata.requestHash,
      event: {
        action: metadata.action,
        objectRef,
        kind: "idempotency",
        status: "completed",
        reasonCodes: [],
        detail: {
          kind: "idempotency",
          recordRef: objectRef,
          domainRecordRef,
          status: "completed",
        },
      },
    } as ControlRequestMetadata;
    const bound = assertControlRequestBinding({
      metadata: completionMetadata,
      record: candidate,
    });
    return bound.record as ModuleControlIdempotencyRecord;
  }

  private domainCommittedIdempotencyCandidate(
    metadata: DeepReadonly<ControlRequestMetadata>,
    domainRecordRef: string,
    createdAt: string,
  ): ModuleControlIdempotencyRecord {
    return this.snapshotRecord({
      managementTenantId: this.managementTenantId,
      action: metadata.action,
      idempotencyKey: metadata.idempotencyKey,
      requestHash: metadata.requestHash,
      actorRef: metadata.actorRef,
      status: "domain_committed",
      domainRecordRef,
      finalResult: null,
      createdAt,
      expiresAt: idempotencyExpiresAt(createdAt),
    });
  }

  private findRequestIdempotency(
    metadata: DeepReadonly<ControlRequestMetadata>,
  ): ModuleControlIdempotencyRecord | null {
    return (
      this.idempotencyRecords.get(
        idempotencyKey(
          this.managementTenantId,
          metadata.action,
          metadata.idempotencyKey,
        ),
      ) ?? null
    );
  }

  private assertExistingIdempotency(
    existing: ModuleControlIdempotencyRecord,
    metadata: DeepReadonly<ControlRequestMetadata>,
  ): void {
    if (existing.managementTenantId !== metadata.managementTenantId) {
      repositoryError("tenant_mismatch");
    }
    if (
      existing.action !== metadata.action ||
      existing.idempotencyKey !== metadata.idempotencyKey ||
      existing.requestHash !== metadata.requestHash ||
      existing.actorRef !== metadata.actorRef
    ) {
      repositoryError("conflict");
    }
  }

  private insertIdempotency(record: ModuleControlIdempotencyRecord): void {
    const key = idempotencyKey(
      this.managementTenantId,
      record.action,
      record.idempotencyKey,
    );
    if (this.idempotencyRecords.has(key)) repositoryError("conflict");
    this.idempotencyRecords.set(key, this.snapshotRecord(record));
  }

  private replaySimple<T extends
    | ModuleRegistrationRecord
    | ModulePreviewRecord
    | ModuleApprovalRecord>(
    metadata: DeepReadonly<ControlRequestMetadata>,
    existing: ModuleControlIdempotencyRecord,
    kind: "registration" | "preview" | "approval",
  ): RegistrationWriteResult | PreviewWriteResult | ApprovalWriteResult {
    if (
      existing.status !== "completed" ||
      existing.domainRecordRef === null ||
      existing.finalResult === null
    ) {
      repositoryError("invalid_state");
    }
    let record: T | undefined;
    if (kind === "registration") {
      record = [...this.registrationRecords.values()].find(
        (candidate) => registrationRef(candidate) === existing.domainRecordRef,
      ) as T | undefined;
    } else if (kind === "preview") {
      record = this.previewRecords.get(
        recordKey(this.managementTenantId, existing.domainRecordRef),
      ) as T | undefined;
    } else {
      record = this.approvalRecords.get(
        recordKey(this.managementTenantId, existing.domainRecordRef),
      ) as T | undefined;
    }
    if (record === undefined) repositoryError("not_found");
    const event = this.findEvent(
      (candidate) =>
        candidate.managementTenantId === this.managementTenantId &&
        candidate.action === metadata.action &&
        candidate.kind === kind &&
        candidate.objectRef === existing.domainRecordRef,
    );
    if (event === null) repositoryError("invalid_state");
    return this.writeResult(record, event, true) as
      | RegistrationWriteResult
      | PreviewWriteResult
      | ApprovalWriteResult;
  }

  private replayPublish(
    metadata: DeepReadonly<ControlRequestMetadata>,
    existing: ModuleControlIdempotencyRecord,
  ): ReleaseWriteResult {
    if (existing.status === "reserved" || existing.domainRecordRef === null) {
      repositoryError("invalid_state");
    }
    const release = this.releaseRecords.get(
      recordKey(this.managementTenantId, existing.domainRecordRef),
    );
    if (release === undefined) repositoryError("not_found");
    if (existing.status === "domain_committed" && release.status === "manual_review") {
      repositoryError("invalid_state");
    }
    if (existing.status === "completed") {
      if (existing.finalResult === null) repositoryError("invalid_state");
      this.validatePersistedReleaseCompletion(
        "deployments.publish",
        existing.finalResult,
        "invalid_state",
      );
    }
    const event = this.findEvent(
      (candidate) =>
        candidate.managementTenantId === this.managementTenantId &&
        candidate.action === metadata.action &&
        candidate.kind === "release" &&
        candidate.objectRef === release.releaseId &&
        candidate.detail.kind === "release" &&
        candidate.detail.revision === release.revision,
    );
    if (event === null) repositoryError("invalid_state");
    return this.writeResult(release, event, true);
  }

  private tryReplayReadback(
    metadata: DeepReadonly<ControlRequestMetadata>,
    record: ModuleReadbackRecord,
  ): ReadbackWriteResult | null {
    const persisted = this.readbackRecords.get(
      recordKey(this.managementTenantId, record.releaseId),
    );
    if (persisted === undefined || !isDeepStrictEqual(persisted, record)) return null;
    const event = this.findEvent(
      (candidate) =>
        candidate.managementTenantId === this.managementTenantId &&
        candidate.action === metadata.action &&
        candidate.kind === "reconciliation" &&
        candidate.objectRef === record.releaseId &&
        candidate.status === record.status &&
        candidate.detail.kind === "reconciliation" &&
        candidate.detail.revision === record.revision &&
        candidate.detail.readbackRef === record.readbackRef,
    );
    if (event === null) return null;
    return this.writeResult(persisted, event, true);
  }

  private validateNewApproval(record: ModuleApprovalRecord): void {
    if (
      this.approvalRecords.has(
        recordKey(this.managementTenantId, record.approvalId),
      )
    ) {
      repositoryError("conflict");
    }
    for (const approval of this.approvalRecords.values()) {
      if (approval.previewRef === record.previewRef) repositoryError("conflict");
    }
    const preview = this.previewRecords.get(
      recordKey(this.managementTenantId, record.previewRef),
    );
    if (preview === undefined) repositoryError("not_found");
    if (
      preview.canonicalHash !== record.previewCanonicalHash ||
      preview.baseReleaseId !== record.baseReleaseId ||
      preview.baseRevision !== record.baseRevision ||
      preview.expiresAt !== record.expiresAt ||
      !sameStringMultiset(
        preview.inventoryRefs.map((ref) => ref.descriptorDigest),
        record.inventoryDigestSet,
      ) ||
      preview.consumed ||
      isExpiredAt(preview.expiresAt, record.decidedAt)
    ) {
      repositoryError("conflict");
    }
  }

  private validateNewRelease(record: ModuleReleaseRecord): {
    readonly preview: ModulePreviewRecord;
    readonly approval: ModuleApprovalRecord;
  } {
    if (record.status !== "published_pending_readback") invalidState();
    const releaseGateAt = record.publishedAt ?? record.createdAt;
    if (
      this.findReleaseByStatusRecord(
        "published_pending_readback",
        "manual_review",
      ) !== null
    ) {
      repositoryError("conflict");
    }
    if (
      this.releaseRecords.has(recordKey(this.managementTenantId, record.releaseId)) ||
      [...this.releaseRecords.values()].some(
        (candidate) => candidate.revision === record.revision,
      )
    ) {
      repositoryError("conflict");
    }
    const active = this.findReleaseByStatusRecord("active_verified");
    const expectedBaseRevision = active?.revision ?? 0;
    const expectedBaseReleaseId = active?.releaseId ?? null;
    if (
      record.revision !== expectedBaseRevision + 1 ||
      record.previousReleaseId !== expectedBaseReleaseId
    ) {
      repositoryError("conflict");
    }
    const preview = this.previewRecords.get(
      recordKey(this.managementTenantId, record.previewRef),
    );
    if (preview === undefined) repositoryError("not_found");
    if (
      preview.consumed ||
      isExpiredAt(preview.expiresAt, releaseGateAt) ||
      preview.baseRevision !== expectedBaseRevision ||
      preview.baseReleaseId !== expectedBaseReleaseId ||
      preview.baseRevision !== record.revision - 1 ||
      !sameModuleRefs(preview.desiredModules, record.desiredModules)
    ) {
      repositoryError("conflict");
    }
    const approval = this.approvalRecords.get(
      recordKey(this.managementTenantId, record.approvalId),
    );
    if (approval === undefined) repositoryError("not_found");
    if (
      approval.decision !== "approve" ||
      approval.consumed ||
      isExpiredAt(approval.expiresAt, releaseGateAt) ||
      approval.previewRef !== preview.previewRef ||
      approval.previewCanonicalHash !== preview.canonicalHash ||
      approval.baseReleaseId !== preview.baseReleaseId ||
      approval.baseRevision !== preview.baseRevision ||
      approval.expiresAt !== preview.expiresAt ||
      !sameStringMultiset(
        approval.inventoryDigestSet,
        preview.inventoryRefs.map((ref) => ref.descriptorDigest),
      )
    ) {
      repositoryError("conflict");
    }
    return { preview, approval };
  }

  private validatePersistedReleaseCompletion(
    action: "deployments.publish" | "deployments.reconcile",
    finalResult: ControlFinalResult,
    failureCode: "conflict" | "invalid_state",
  ): void {
    const parsed = controlEnvelopeSchema.safeParse(finalResult.envelope);
    if (!parsed.success) repositoryError(failureCode);
    const release = this.releaseRecords.get(
      recordKey(this.managementTenantId, finalResult.domainRecordRef),
    );
    const readback = this.readbackRecords.get(
      recordKey(this.managementTenantId, finalResult.domainRecordRef),
    );
    if (release === undefined || readback === undefined) {
      repositoryError(failureCode);
    }
    const envelope = parsed.data;
    const data = envelope.data;
    if (
      release.releaseId !== readback.releaseId ||
      release.revision !== readback.revision ||
      release.readbackRef !== readback.readbackRef ||
      envelope.readback.release_id !== release.releaseId ||
      envelope.readback.revision !== release.revision
    ) {
      repositoryError(failureCode);
    }
    if (action === "deployments.publish") {
      if (
        data?.kind !== "release" ||
        data.release_id !== release.releaseId ||
        data.revision !== release.revision ||
        !sameModuleRefs(
          envelopeModuleRefs(data.active_modules),
          release.desiredModules,
        )
      ) {
        repositoryError(failureCode);
      }
    } else if (
      data?.kind !== "reconciliation" ||
      data.release_id !== release.releaseId ||
      data.revision !== release.revision ||
      data.status !== readback.status
    ) {
      repositoryError(failureCode);
    }

    if (envelope.status === "success") {
      if (
        release.status !== "active_verified" ||
        readback.status !== "verified" ||
        envelope.readback.status !== "verified" ||
        readback.appliedReleaseId !== release.releaseId ||
        readback.appliedRevision !== release.revision ||
        !sameModuleRefs(readback.appliedModules, release.desiredModules) ||
        envelope.reason_codes.length !== 0 ||
        readback.reasonCodes.length !== 0 ||
        release.reasonCodes.length !== 0
      ) {
        repositoryError(failureCode);
      }
      return;
    }
    if (
      envelope.status !== "manual_review" ||
      release.status !== "manual_review" ||
      (readback.status !== "mismatch" && readback.status !== "unknown") ||
      envelope.readback.status !== readback.status ||
      !isDeepStrictEqual(envelope.reason_codes, readback.reasonCodes) ||
      !isDeepStrictEqual(release.reasonCodes, readback.reasonCodes)
    ) {
      repositoryError(failureCode);
    }
  }

  private appendEvent(
    metadata: DeepReadonly<ControlRequestMetadata>,
    record: ControlRecord,
  ): ControlEventRecord {
    let eventId = `fake_event_${this.nextEventSequence}`;
    const usedIds = new Set(this.eventRecords.map((event) => event.eventId));
    while (usedIds.has(eventId)) {
      this.nextEventSequence += 1;
      eventId = `fake_event_${this.nextEventSequence}`;
    }
    const previousEvent = this.eventRecords.reduce<ControlEventRecord | null>(
      (latest, candidate) =>
        latest === null || candidate.sequence > latest.sequence ? candidate : latest,
      null,
    );
    const authorityAt = recordTimestamp(record);
    const occurredAt =
      "idempotencyKey" in record && record.status === "completed"
        ? resolveMonotonicControlEventOccurredAt(authorityAt, previousEvent)
        : authorityAt;
    const event = this.snapshotRecord({
      managementTenantId: metadata.managementTenantId,
      eventId,
      sequence: this.nextEventSequence,
      actorRef: metadata.actorRef,
      action: metadata.event.action,
      objectRef: metadata.event.objectRef,
      kind: metadata.event.kind,
      status: metadata.event.status,
      reasonCodes: metadata.event.reasonCodes,
      detail: metadata.event.detail,
      occurredAt,
    } as ControlEventRecord);
    this.nextEventSequence += 1;
    this.eventRecords.push(event);
    this.eventAuthorityKeys.set(
      event.eventId,
      idempotencyKey(
        this.managementTenantId,
        metadata.action,
        metadata.idempotencyKey,
      ),
    );
    return event;
  }

  private findEvent(
    predicate: (event: ControlEventRecord) => boolean,
  ): ControlEventRecord | null {
    let result: ControlEventRecord | null = null;
    for (const event of this.eventRecords) {
      if (!predicate(event)) continue;
      if (
        result === null ||
        event.sequence > result.sequence ||
        (event.sequence === result.sequence && event.eventId > result.eventId)
      ) {
        result = event;
      }
    }
    return result;
  }

  private writeResult<T extends ControlRecord>(
    record: T,
    event: ControlEventRecord,
    replayed: boolean,
  ): Readonly<{
    record: DeepReadonly<T>;
    event: DeepReadonly<ControlEventRecord>;
    replayed: boolean;
  }> {
    return Object.freeze({
      record: this.snapshotRecord(record),
      event: this.snapshotRecord(event),
      replayed,
    }) as unknown as Readonly<{
      record: DeepReadonly<T>;
      event: DeepReadonly<ControlEventRecord>;
      replayed: boolean;
    }>;
  }

  private snapshotRecord<T extends ControlRecord>(record: T): T {
    return deepFreezeControlRecord(record) as T;
  }

  private snapshotNullable<T extends ControlRecord>(
    record: T | null,
  ): DeepReadonly<T> | null {
    return record === null
      ? null
      : (this.snapshotRecord(record) as DeepReadonly<T>);
  }

  private latestBy<T>(
    records: Iterable<T>,
    timestamp: (record: T) => string,
    tieBreak: (record: T) => string,
  ): T | null {
    let result: T | null = null;
    for (const record of records) {
      if (result === null) {
        result = record;
        continue;
      }
      const timestampComparison = compareRfc3339Instants(
        timestamp(record),
        timestamp(result),
      );
      if (timestampComparison === null) invalidState();
      if (
        timestampComparison > 0 ||
        (timestampComparison === 0 &&
          tieBreak(record) > tieBreak(result))
      ) {
        result = record;
      }
    }
    return result;
  }

  private findReleaseByStatusRecord(
    ...statuses: readonly ModuleReleaseRecord["status"][]
  ): ModuleReleaseRecord | null {
    let result: ModuleReleaseRecord | null = null;
    for (const record of this.releaseRecords.values()) {
      if (!statuses.includes(record.status)) continue;
      if (
        result === null ||
        record.revision > result.revision ||
        (record.revision === result.revision && record.releaseId > result.releaseId)
      ) {
        result = record;
      }
    }
    return result;
  }

  private persistentSnapshot(): PersistentSnapshot {
    return {
      registrations: [...this.registrationRecords.entries()],
      previews: [...this.previewRecords.entries()],
      approvals: [...this.approvalRecords.entries()],
      releases: [...this.releaseRecords.entries()],
      readbacks: [...this.readbackRecords.entries()],
      idempotency: [...this.idempotencyRecords.entries()],
      events: [...this.eventRecords],
      eventAuthorities: [...this.eventAuthorityKeys.entries()],
      nextEventSequence: this.nextEventSequence,
    };
  }

  private restoreMap<K, V>(target: Map<K, V>, entries: readonly (readonly [K, V])[]): void {
    target.clear();
    for (const [key, value] of entries) target.set(key, value);
  }

  private restorePersistentSnapshot(snapshot: PersistentSnapshot): void {
    this.restoreMap(this.registrationRecords, snapshot.registrations);
    this.restoreMap(this.previewRecords, snapshot.previews);
    this.restoreMap(this.approvalRecords, snapshot.approvals);
    this.restoreMap(this.releaseRecords, snapshot.releases);
    this.restoreMap(this.readbackRecords, snapshot.readbacks);
    this.restoreMap(this.idempotencyRecords, snapshot.idempotency);
    this.eventRecords.splice(0, this.eventRecords.length, ...snapshot.events);
    this.restoreMap(this.eventAuthorityKeys, snapshot.eventAuthorities);
    this.nextEventSequence = snapshot.nextEventSequence;
  }

  private withAtomicWrite<T>(
    _method: FakeControlRepositoryMethodName,
    operation: () => T,
  ): T {
    const snapshot = this.persistentSnapshot();
    try {
      return operation();
    } catch (error: unknown) {
      this.restorePersistentSnapshot(snapshot);
      throw error;
    }
  }

  private seed(records: FakeModuleControlRepositoryRecords | undefined): void {
    if (records === undefined) return;
    const safeRecords = freezeSnapshot(records) as FakeModuleControlRepositoryRecords;
    const eventSequences = new Set<number>();
    const eventIds = new Set<string>();
    const approvalPreviews = new Set<string>();
    const releaseRevisions = new Set<number>();
    const readbackRefs = new Set<string>();

    for (const record of safeRecords.registrations ?? []) {
      const frozen = this.seedRecord(record);
      const key = recordKey(
        this.managementTenantId,
        frozen.moduleId,
        frozen.version,
        frozen.descriptorDigest,
      );
      if (this.registrationRecords.has(key)) invalidState();
      this.registrationRecords.set(key, frozen);
    }
    for (const record of safeRecords.previews ?? []) {
      const frozen = this.seedRecord(record);
      const key = recordKey(this.managementTenantId, frozen.previewRef);
      if (this.previewRecords.has(key)) invalidState();
      this.previewRecords.set(key, frozen);
    }
    for (const record of safeRecords.approvals ?? []) {
      const frozen = this.seedRecord(record);
      const key = recordKey(this.managementTenantId, frozen.approvalId);
      if (
        this.approvalRecords.has(key) ||
        approvalPreviews.has(frozen.previewRef)
      ) {
        invalidState();
      }
      approvalPreviews.add(frozen.previewRef);
      this.approvalRecords.set(key, frozen);
    }
    for (const record of safeRecords.releases ?? []) {
      const frozen = this.seedRecord(record);
      const key = recordKey(this.managementTenantId, frozen.releaseId);
      if (
        this.releaseRecords.has(key) ||
        releaseRevisions.has(frozen.revision)
      ) {
        invalidState();
      }
      releaseRevisions.add(frozen.revision);
      this.releaseRecords.set(key, frozen);
    }
    for (const record of safeRecords.readbacks ?? []) {
      const frozen = this.seedRecord(record);
      const key = recordKey(this.managementTenantId, frozen.releaseId);
      if (
        this.readbackRecords.has(key) ||
        readbackRefs.has(frozen.readbackRef)
      ) {
        invalidState();
      }
      readbackRefs.add(frozen.readbackRef);
      this.readbackRecords.set(key, frozen);
    }
    for (const record of safeRecords.idempotency ?? []) {
      const frozen = this.seedRecord(record);
      const key = idempotencyKey(
        this.managementTenantId,
        frozen.action,
        frozen.idempotencyKey,
      );
      if (this.idempotencyRecords.has(key)) invalidState();
      this.idempotencyRecords.set(key, frozen);
    }
    for (const event of safeRecords.events ?? []) {
      const frozen = this.seedRecord(event);
      if (
        eventSequences.has(frozen.sequence) ||
        eventIds.has(frozen.eventId)
      ) {
        invalidState();
      }
      eventSequences.add(frozen.sequence);
      eventIds.add(frozen.eventId);
      this.eventRecords.push(frozen);
      this.nextEventSequence = Math.max(
        this.nextEventSequence,
        frozen.sequence + 1,
      );
    }
    const eventAuthorityIds = new Set<string>();
    for (const binding of safeRecords.eventAuthorities ?? []) {
      assertRepositoryIdentifier(binding.eventId);
      assertRepositoryIdentifier(binding.idempotencyKey);
      if (
        eventAuthorityIds.has(binding.eventId) ||
        !MODULE_CONTROL_ACTIONS.includes(binding.action)
      ) {
        invalidState();
      }
      const event = this.eventRecords.find(
        (candidate) => candidate.eventId === binding.eventId,
      );
      const authority = this.idempotencyRecords.get(
        idempotencyKey(
          this.managementTenantId,
          binding.action,
          binding.idempotencyKey,
        ),
      );
      if (
        event === undefined ||
        event.action !== binding.action ||
        authority === undefined ||
        authority.status === "reserved" ||
        authority.requestHash !== binding.requestHash
      ) {
        invalidState();
      }
      eventAuthorityIds.add(binding.eventId);
      this.eventAuthorityKeys.set(
        binding.eventId,
        idempotencyKey(
          this.managementTenantId,
          binding.action,
          binding.idempotencyKey,
        ),
      );
    }
    this.validateSeedGraph();
  }

  private seedRecord<T extends ControlRecord>(record: T): T {
    const frozen = deepFreezeControlRecord(record);
    this.assertTenant(frozen.managementTenantId);
    return frozen as T;
  }

  private validateSeedGraph(): void {
    const releaseHistory = projectReleaseHistory(
      this.managementTenantId,
      this.releaseRecords.values(),
      this.previewRecords,
    );
    const releases = [...this.releaseRecords.values()];
    const active = releases.filter(
      (release) => release.status === "active_verified",
    );
    const unresolved = releases.filter(
      (release) =>
        release.status === "published_pending_readback" ||
        release.status === "manual_review",
    );
    if (active.length > 1 || unresolved.length > 1) invalidState();

    for (const preview of this.previewRecords.values()) {
      const baseRelease = preview.baseReleaseId === null
        ? null
        : this.releaseRecords.get(
          recordKey(this.managementTenantId, preview.baseReleaseId),
        ) ?? null;
      const rollbackTargetRelease = preview.intent === "rollback"
        ? releaseHistory.find(
          (entry) => entry.release.releaseId === preview.targetReleaseId,
        )?.release ?? null
        : null;
      assertModulePreviewAuthoritySemantics(
        preview,
        baseRelease,
        rollbackTargetRelease,
        releaseHistory,
      );
    }

    const orderedEvents = [...this.eventRecords].sort(
      (left, right) => left.sequence - right.sequence,
    );
    let previousEvent: ControlEventRecord | null = null;
    let expectedSequence = 1;
    for (const event of orderedEvents) {
      if (event.sequence !== expectedSequence) invalidState();
      assertControlEventInstantOrder(previousEvent, event);
      previousEvent = event;
      expectedSequence += 1;
    }

    for (const approval of this.approvalRecords.values()) {
      const preview = this.previewRecords.get(
        recordKey(this.managementTenantId, approval.previewRef),
      );
      if (
        preview === undefined ||
        preview.canonicalHash !== approval.previewCanonicalHash ||
        preview.baseReleaseId !== approval.baseReleaseId ||
        preview.baseRevision !== approval.baseRevision ||
        preview.expiresAt !== approval.expiresAt ||
        !sameStringMultiset(
          preview.inventoryRefs.map((ref) => ref.descriptorDigest),
          approval.inventoryDigestSet,
        ) ||
        isExpiredAt(preview.expiresAt, approval.decidedAt)
      ) {
        invalidState();
      }
    }

    for (const preview of this.previewRecords.values()) {
      if (
        preview.consumed &&
        ![...this.releaseRecords.values()].some(
          (release) => release.previewRef === preview.previewRef,
        )
      ) {
        invalidState();
      }
    }
    for (const approval of this.approvalRecords.values()) {
      if (
        approval.consumed &&
        ![...this.releaseRecords.values()].some(
          (release) => release.approvalId === approval.approvalId,
        )
      ) {
        invalidState();
      }
    }

    for (const release of this.releaseRecords.values()) {
      if (release.publishedAt !== null) {
        const publicationComparison = compareRfc3339Instants(
          release.createdAt,
          release.publishedAt,
        );
        if (publicationComparison === null || publicationComparison === 1) {
          invalidState();
        }
      }
      const preview = this.previewRecords.get(
        recordKey(this.managementTenantId, release.previewRef),
      );
      const approval = this.approvalRecords.get(
        recordKey(this.managementTenantId, release.approvalId),
      );
      if (
        preview === undefined ||
        approval === undefined ||
        approval.previewRef !== preview.previewRef ||
        approval.decision !== "approve" ||
        !preview.consumed ||
        !approval.consumed ||
        release.revision !== preview.baseRevision + 1 ||
        release.previousReleaseId !== preview.baseReleaseId ||
        !sameModuleRefs(release.desiredModules, preview.desiredModules) ||
        isExpiredAt(preview.expiresAt, release.publishedAt ?? release.createdAt)
      ) {
        invalidState();
      }
      if (
        release.previousReleaseId !== null &&
        !this.releaseRecords.has(
          recordKey(this.managementTenantId, release.previousReleaseId),
        )
      ) {
        invalidState();
      }
      if (preview.baseReleaseId === null) {
        if (preview.baseRevision !== 0) invalidState();
      } else {
        const baseRelease = this.releaseRecords.get(
          recordKey(this.managementTenantId, preview.baseReleaseId),
        );
        if (
          baseRelease === undefined ||
          baseRelease.revision !== preview.baseRevision
        ) {
          invalidState();
        }
      }
      const readback = this.readbackRecords.get(
        recordKey(this.managementTenantId, release.releaseId),
      );
      const publishEvent = this.findEvent(
        (event) =>
          event.action === "deployments.publish" &&
          event.kind === "release" &&
          event.objectRef === release.releaseId &&
          event.detail.kind === "release" &&
          event.detail.releaseId === release.releaseId &&
          event.detail.revision === release.revision &&
          event.occurredAt === release.createdAt,
      );
      const publishAuthority = [...this.idempotencyRecords.values()].find(
        (record) =>
          record.action === "deployments.publish" &&
          record.domainRecordRef === release.releaseId &&
          record.createdAt === release.createdAt &&
          (record.status === "domain_committed" || record.status === "completed"),
      );
      if (publishEvent === null || publishAuthority === undefined) invalidState();
      if (
        release.status !== "published_pending_readback" &&
        release.publishedAt === null
      ) {
        invalidState();
      }
      if (
        release.status === "published_pending_readback" &&
        (release.readbackRef !== null ||
          release.reasonCodes.length !== 0 ||
          release.supersededByReleaseId !== null ||
          (readback !== undefined &&
            (readback.status !== "pending" ||
              readback.releaseId !== release.releaseId ||
              readback.revision !== release.revision ||
              readback.appliedReleaseId !== null ||
              readback.appliedRevision !== null ||
              readback.reasonCodes.length !== 0)))
      ) {
        invalidState();
      }
      if (
        release.status === "manual_review" &&
        (release.readbackRef === null ||
          release.reasonCodes.length === 0 ||
          release.supersededByReleaseId !== null)
      ) {
        invalidState();
      }
      if (
        release.status === "active_verified" &&
        (release.readbackRef === null ||
          release.reasonCodes.length !== 0 ||
          release.supersededByReleaseId !== null)
      ) {
        invalidState();
      }
      if (
        release.status === "superseded" &&
        (release.readbackRef === null ||
          release.reasonCodes.length !== 0 ||
          release.supersededByReleaseId === null ||
          release.supersededByReleaseId === release.releaseId)
      ) {
        invalidState();
      }
      if (release.status === "published_pending_readback") {
        if (readback !== undefined) {
          const pendingReadbackEvent = this.findEvent(
            (event) =>
              event.kind === "reconciliation" &&
              (event.action === "deployments.publish" ||
                event.action === "deployments.reconcile") &&
              event.objectRef === release.releaseId &&
              event.detail.kind === "reconciliation" &&
              event.detail.releaseId === release.releaseId &&
              event.detail.revision === release.revision &&
              event.detail.readbackRef === readback.readbackRef &&
              event.status === "pending" &&
              event.detail.status === "pending" &&
              event.occurredAt === readback.checkedAt,
          );
          if (pendingReadbackEvent === null) invalidState();
        }
        continue;
      } else if (release.status === "manual_review") {
        if (
          readback === undefined ||
          (readback.status !== "mismatch" && readback.status !== "unknown") ||
          readback.readbackRef !== release.readbackRef ||
          !isDeepStrictEqual(readback.reasonCodes, release.reasonCodes)
        ) {
          invalidState();
        }
      } else {
        if (
          readback === undefined ||
          readback.status !== "verified" ||
          readback.readbackRef !== release.readbackRef ||
          readback.appliedReleaseId !== release.releaseId ||
          readback.appliedRevision !== release.revision ||
          !sameModuleRefs(readback.appliedModules, release.desiredModules)
        ) {
          invalidState();
        }
      }
      if (readback !== undefined) {
        const readbackEvent = this.findEvent(
          (event) =>
            event.kind === "reconciliation" &&
            (event.action === "deployments.publish" ||
              event.action === "deployments.reconcile") &&
            event.objectRef === release.releaseId &&
            event.detail.kind === "reconciliation" &&
            event.detail.releaseId === release.releaseId &&
            event.detail.revision === release.revision &&
            event.detail.readbackRef === readback.readbackRef &&
            event.status === readback.status &&
            event.detail.status === readback.status &&
            event.occurredAt === readback.checkedAt,
        );
        if (readbackEvent === null) invalidState();
      }
      if (release.status === "superseded") {
        const superseding = this.releaseRecords.get(
          recordKey(this.managementTenantId, release.supersededByReleaseId),
        );
        if (
          superseding === undefined ||
          superseding.revision <= release.revision ||
          superseding.previousReleaseId !== release.releaseId
        ) {
          invalidState();
        }
      } else if (release.supersededByReleaseId !== null) {
        invalidState();
      }
      if (release.previousReleaseId !== null) {
        const previous = this.releaseRecords.get(
          recordKey(this.managementTenantId, release.previousReleaseId),
        );
        if (previous === undefined || previous.revision >= release.revision) {
          invalidState();
        }
        if (
          (release.status === "active_verified" || release.status === "superseded") &&
          (previous.status !== "superseded" ||
            previous.supersededByReleaseId !== release.releaseId)
        ) {
          invalidState();
        }
      }
    }

    for (const readback of this.readbackRecords.values()) {
      const release = this.releaseRecords.get(
        recordKey(this.managementTenantId, readback.releaseId),
      );
      if (
        release === undefined ||
        release.revision !== readback.revision
      ) {
        invalidState();
      }
    }

    const lifecycleCounts = new Map<string, ControlEventLifecycleCounts>();
    for (const key of this.idempotencyRecords.keys()) {
      lifecycleCounts.set(key, createControlEventLifecycleCounts());
    }
    this.rebuildSeedEventAuthorities(orderedEvents);
    for (const event of orderedEvents) {
      const authority = this.findSeedEventAuthority(event);
      if (authority === null || authority.action !== event.action) invalidState();
      const counts = lifecycleCounts.get(
        idempotencyKey(
          this.managementTenantId,
          authority.action,
          authority.idempotencyKey,
        ),
      );
      if (counts === undefined) invalidState();
      this.validateSeedEvent(event, authority);
      switch (event.kind) {
        case "registration":
          counts.registration += 1;
          break;
        case "preview":
          counts.preview += 1;
          break;
        case "approval":
          counts.approval += 1;
          break;
        case "release":
          counts.release += 1;
          break;
        case "reconciliation":
          counts.reconciliation += 1;
          break;
        case "idempotency":
          counts.completion += 1;
          break;
      }
    }
    for (const [key, record] of this.idempotencyRecords) {
      this.validateSeedIdempotency(record);
      const counts = lifecycleCounts.get(key);
      if (counts === undefined) invalidState();
      assertControlEventLifecycleCardinality(record, counts);
    }
  }

  private validateSeedEvent(
    event: ControlEventRecord,
    authority: ModuleControlIdempotencyRecord,
  ): void {
    if (event.kind === "registration") {
      const record = [...this.registrationRecords.values()].find(
        (candidate) => registrationRef(candidate) === event.objectRef,
      );
      const expectedRef = record === undefined ? null : registrationRef(record);
      if (
        record === undefined ||
        event.action !== "packages.register" ||
        event.detail.kind !== "registration" ||
        event.objectRef !== expectedRef ||
        event.detail.recordRef !== expectedRef ||
        event.detail.moduleId !== record.moduleId ||
        event.detail.version !== record.version ||
        event.detail.descriptorDigest !== record.descriptorDigest ||
        event.status !== "registered" ||
        event.detail.status !== "registered" ||
        event.actorRef !== record.registeredByActorRef ||
        event.actorRef !== authority.actorRef ||
        !isDeepStrictEqual(
          event.reasonCodes,
          authority.finalResult?.envelope.reason_codes ?? [],
        ) ||
        event.occurredAt !== record.registeredAt
      ) {
        invalidState();
      }
      return;
    }
    if (event.kind === "preview") {
      const record = this.previewRecords.get(
        recordKey(this.managementTenantId, event.objectRef),
      );
      if (
        record === undefined ||
        event.action !== "deployments.preview" ||
        event.detail.kind !== "preview" ||
        event.detail.previewRef !== record.previewRef ||
        event.detail.baseRevision !== record.baseRevision ||
        event.status !== "previewed" ||
        event.detail.status !== "previewed" ||
        event.actorRef !== record.creatorActorRef ||
        event.actorRef !== authority.actorRef ||
        !isDeepStrictEqual(
          event.reasonCodes,
          authority.finalResult?.envelope.reason_codes ?? [],
        ) ||
        event.occurredAt !== record.createdAt
      ) {
        invalidState();
      }
      return;
    }
    if (event.kind === "approval") {
      const record = this.approvalRecords.get(
        recordKey(this.managementTenantId, event.objectRef),
      );
      if (
        record === undefined ||
        event.action !== "approvals.decide" ||
        event.detail.kind !== "approval" ||
        event.detail.approvalId !== record.approvalId ||
        event.detail.previewRef !== record.previewRef ||
        event.status !== (record.decision === "approve" ? "approved" : "rejected") ||
        event.detail.status !== event.status ||
        event.actorRef !== record.approverActorRef ||
        event.actorRef !== authority.actorRef ||
        !isDeepStrictEqual(
          event.reasonCodes,
          authority.finalResult?.envelope.reason_codes ?? [],
        ) ||
        event.occurredAt !== record.decidedAt
      ) {
        invalidState();
      }
      return;
    }
    if (event.kind === "release") {
      const record = this.releaseRecords.get(
        recordKey(this.managementTenantId, event.objectRef),
      );
      if (
        record === undefined ||
        event.action !== "deployments.publish" ||
        event.detail.kind !== "release" ||
        event.detail.releaseId !== record.releaseId ||
        event.detail.revision !== record.revision ||
        event.status !== "published_pending_readback" ||
        event.detail.status !== "published_pending_readback" ||
        event.actorRef !== record.publisherActorRef ||
        event.actorRef !== authority.actorRef ||
        event.reasonCodes.length !== 0 ||
        event.occurredAt !== record.createdAt
      ) {
        invalidState();
      }
      return;
    }
    if (event.kind === "reconciliation") {
      const release = this.releaseRecords.get(
        recordKey(this.managementTenantId, event.objectRef),
      );
      const readback = this.readbackRecords.get(
        recordKey(this.managementTenantId, event.objectRef),
      );
      const eventAfterRelease = release === undefined
        ? null
        : compareRfc3339Instants(event.occurredAt, release.createdAt);
      const currentObservationMatches =
        readback !== undefined &&
        readback.readbackRef === event.detail.readbackRef;
      if (
        release === undefined ||
        readback === undefined ||
        (event.action !== "deployments.publish" &&
          event.action !== "deployments.reconcile") ||
        event.detail.kind !== "reconciliation" ||
        event.detail.releaseId !== release.releaseId ||
        event.detail.revision !== release.revision ||
        event.detail.status !== event.status ||
        ((event.status === "pending" || event.status === "verified") &&
          event.reasonCodes.length !== 0) ||
        ((event.status === "mismatch" || event.status === "unknown") &&
          event.reasonCodes.length === 0) ||
        (currentObservationMatches &&
          readback !== undefined &&
          (event.status !== readback.status ||
            !isDeepStrictEqual(event.reasonCodes, readback.reasonCodes) ||
            event.occurredAt !== readback.checkedAt)) ||
        event.actorRef !== authority.actorRef ||
        eventAfterRelease === null ||
        eventAfterRelease < 0 ||
        event.occurredAt !== readback.checkedAt
      ) {
        invalidState();
      }
      return;
    }
    if (event.kind === "idempotency") {
      if (event.detail.kind !== "idempotency") invalidState();
      const record = authority;
      const expectedRef =
        `idempotency:${record.action}:${record.idempotencyKey}`;
      const expectedOccurredAt = resolveMonotonicControlEventOccurredAt(
        record.createdAt,
        this.previousSeedEvent(event),
      );
      if (
        event.objectRef !== expectedRef ||
        event.detail.recordRef !== expectedRef ||
        event.detail.domainRecordRef !== record.domainRecordRef ||
        event.status !== "completed" ||
        event.detail.status !== "completed" ||
        record.status !== "completed" ||
        event.actorRef !== record.actorRef ||
        event.reasonCodes.length !== 0 ||
        event.occurredAt !== expectedOccurredAt
      ) {
        invalidState();
      }
    }
  }

  private rebuildSeedEventAuthorities(
    orderedEvents: readonly ControlEventRecord[],
  ): void {
    const eventIds = new Set(orderedEvents.map((event) => event.eventId));
    for (const eventId of this.eventAuthorityKeys.keys()) {
      if (!eventIds.has(eventId)) invalidState();
    }
    for (const event of orderedEvents) {
      if (this.eventAuthorityKeys.has(event.eventId)) continue;
      const candidates = [...this.idempotencyRecords.values()].filter((record) => {
        if (
          record.status === "reserved" ||
          record.action !== event.action ||
          record.actorRef !== event.actorRef
        ) {
          return false;
        }
        if (event.kind === "idempotency") {
          return (
            `idempotency:${record.action}:${record.idempotencyKey}` ===
            event.objectRef
          );
        }
        if (record.domainRecordRef !== event.objectRef) return false;
        return (
          event.kind === "reconciliation" &&
          event.action === "deployments.publish"
        ) || record.createdAt === event.occurredAt;
      });
      if (candidates.length !== 1) invalidState();
      const [authority] = candidates;
      if (authority === undefined) invalidState();
      this.eventAuthorityKeys.set(
        event.eventId,
        idempotencyKey(
          this.managementTenantId,
          authority.action,
          authority.idempotencyKey,
        ),
      );
    }
  }

  private findSeedEventAuthority(
    event: ControlEventRecord,
  ): ModuleControlIdempotencyRecord | null {
    const persistedAuthorityKey = this.eventAuthorityKeys.get(event.eventId);
    return persistedAuthorityKey === undefined
      ? null
      : this.idempotencyRecords.get(persistedAuthorityKey) ?? null;
  }

  private previousSeedEvent(event: ControlEventRecord): ControlEventRecord | null {
    return this.eventRecords.reduce<ControlEventRecord | null>(
      (previous, candidate) =>
        candidate.sequence < event.sequence &&
        (previous === null || candidate.sequence > previous.sequence)
          ? candidate
          : previous,
      null,
    );
  }

  private validateSeedIdempotency(record: ModuleControlIdempotencyRecord): void {
    if (record.expiresAt !== idempotencyExpiresAt(record.createdAt)) invalidState();
    if (record.status === "reserved") return;
    const domainRef = record.domainRecordRef;
    if (record.action === "packages.register") {
      const domain = [...this.registrationRecords.values()].find(
        (candidate) => registrationRef(candidate) === domainRef,
      );
      const event = this.findEvent(
        (candidate) =>
          candidate.action === record.action &&
          candidate.kind === "registration" &&
          candidate.objectRef === domainRef &&
          candidate.occurredAt === record.createdAt,
      );
      if (
        domain === undefined ||
        domain.registeredAt !== record.createdAt ||
        event === null ||
        record.status !== "completed"
      ) {
        invalidState();
      }
    } else if (record.action === "deployments.preview") {
      const domain = this.previewRecords.get(
        recordKey(this.managementTenantId, domainRef),
      );
      const event = this.findEvent(
        (candidate) =>
          candidate.action === record.action &&
          candidate.kind === "preview" &&
          candidate.objectRef === domainRef &&
          candidate.occurredAt === record.createdAt,
      );
      if (
        domain === undefined ||
        domain.createdAt !== record.createdAt ||
        event === null ||
        record.status !== "completed"
      ) {
        invalidState();
      }
    } else if (record.action === "approvals.decide") {
      const domain = this.approvalRecords.get(
        recordKey(this.managementTenantId, domainRef),
      );
      const event = this.findEvent(
        (candidate) =>
          candidate.action === record.action &&
          candidate.kind === "approval" &&
          candidate.objectRef === domainRef &&
          candidate.occurredAt === record.createdAt,
      );
      if (
        domain === undefined ||
        domain.decidedAt !== record.createdAt ||
        event === null ||
        record.status !== "completed"
      ) {
        invalidState();
      }
    } else if (record.action === "deployments.publish") {
      const release = this.releaseRecords.get(
        recordKey(this.managementTenantId, domainRef),
      );
      const event = this.findEvent(
        (candidate) =>
          candidate.action === record.action &&
          candidate.kind === "release" &&
          candidate.objectRef === domainRef &&
          candidate.occurredAt === record.createdAt,
      );
      if (
        release === undefined ||
        release.createdAt !== record.createdAt ||
        event === null ||
        (record.status !== "domain_committed" && record.status !== "completed") ||
        (record.status === "domain_committed" && record.finalResult !== null)
      ) {
        invalidState();
      }
    } else {
      const release = this.releaseRecords.get(
        recordKey(this.managementTenantId, domainRef),
      );
      const readback = this.readbackRecords.get(
        recordKey(this.managementTenantId, domainRef),
      );
      const event = this.findEvent(
        (candidate) =>
          candidate.action === record.action &&
          candidate.kind === "reconciliation" &&
          candidate.objectRef === domainRef &&
          candidate.occurredAt === record.createdAt,
      );
      if (
        release === undefined ||
        readback === undefined ||
        release.revision !== readback.revision ||
        readback.checkedAt !== record.createdAt ||
        event === null ||
        (record.status !== "domain_committed" && record.status !== "completed") ||
        (record.status === "domain_committed" && record.finalResult !== null)
      ) {
        invalidState();
      }
    }
    if (record.status === "completed") {
      if (record.finalResult === null) invalidState();
      if (
        record.action === "deployments.publish" ||
        record.action === "deployments.reconcile"
      ) {
        const completionEvent = this.findEvent(
          (candidate) =>
            candidate.action === record.action &&
            candidate.kind === "idempotency" &&
            candidate.objectRef ===
              `idempotency:${record.action}:${record.idempotencyKey}` &&
            candidate.status === "completed" &&
            candidate.detail.kind === "idempotency" &&
            candidate.detail.domainRecordRef === domainRef &&
            candidate.occurredAt ===
              resolveMonotonicControlEventOccurredAt(
                record.createdAt,
                this.previousSeedEvent(candidate),
              ),
        );
        if (completionEvent === null) invalidState();
      }
      try {
        validateFinalResult(record.finalResult, record.action, domainRef);
        if (
          record.action === "deployments.publish" ||
          record.action === "deployments.reconcile"
        ) {
          this.validatePersistedReleaseCompletion(
            record.action,
            record.finalResult,
            "invalid_state",
          );
        }
      } catch {
        invalidState();
      }
    }
  }
}
