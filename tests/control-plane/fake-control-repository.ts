import { isDeepStrictEqual } from "node:util";

import {
  assertControlRequestBinding,
  deepFreezeControlRecord,
  ModuleControlRepositoryError,
  MODULE_CONTROL_ACTIONS,
} from "../../src/logistics_mcp/control-plane/repository";
import type {
  ApprovalWriteResult,
  CompleteControlIdempotencyRequest,
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
  ModuleControlRepository,
  ModuleControlState,
  ModulePreviewRecord,
  ModuleReadbackRecord,
  ModuleRegistrationRecord,
  ModuleReleaseRecord,
  PublishReleaseRecordRequest,
  ReadbackWriteResult,
  RecordReadbackRequest,
  RegisterModuleRecordRequest,
  RegistrationWriteResult,
  PreviewWriteResult,
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

export type FakeControlRepositoryMethodName =
  (typeof FAKE_CONTROL_REPOSITORY_METHOD_NAMES)[number];

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
}

export interface FakeModuleControlRepositoryOptions {
  readonly managementTenantId: string;
  readonly records?: FakeModuleControlRepositoryRecords;
}

type StoredWriteResult =
  | { readonly kind: "registration"; readonly result: RegistrationWriteResult }
  | { readonly kind: "preview"; readonly result: PreviewWriteResult }
  | { readonly kind: "approval"; readonly result: ApprovalWriteResult }
  | { readonly kind: "release"; readonly result: ReleaseWriteResult }
  | { readonly kind: "readback"; readonly result: ReadbackWriteResult };

const OBJECT_PROTOTYPE = Object.prototype;

function invalidState(): never {
  throw new ModuleControlRepositoryError("invalid_state");
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidState();
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) invalidState();
}

function cloneSnapshotValue(value: unknown, stack: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "undefined"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) invalidState();
    return value;
  }
  if (typeof value !== "object") invalidState();
  if (stack.has(value)) invalidState();

  if (Array.isArray(value)) {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) invalidState();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors["length"] as PropertyDescriptor | undefined;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
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
      clone.push(cloneSnapshotValue(descriptor.value, stack));
    }
    stack.delete(value);
    return clone;
  }

  assertPlainObject(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const clone = Object.create(null) as Record<string, unknown>;
  stack.add(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") invalidState();
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      invalidState();
    }
    clone[key] = cloneSnapshotValue(descriptor.value, stack);
  }
  stack.delete(value);
  return clone;
}

function freezeSnapshot<T>(value: T): DeepReadonly<T> {
  const clone = cloneSnapshotValue(value, new WeakSet<object>()) as T;
  const freeze = (candidate: unknown, seen: WeakSet<object>): void => {
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      freeze(Reflect.get(candidate, key), seen);
    }
    Object.freeze(candidate);
  };
  freeze(clone, new WeakSet<object>());
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

function replayKey(
  method: FakeControlRepositoryMethodName,
  tenant: string,
  action: ModuleControlAction,
  key: string,
): string {
  return recordKey(method, tenant, action, key);
}

function idempotencyExpiresAt(createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) invalidState();
  return new Date(timestamp + 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(".000Z", "Z");
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

export class FakeModuleControlRepository implements ModuleControlRepository {
  private readonly managementTenantId: string;
  private readonly registrationRecords = new Map<string, ModuleRegistrationRecord>();
  private readonly previewRecords = new Map<string, ModulePreviewRecord>();
  private readonly approvalRecords = new Map<string, ModuleApprovalRecord>();
  private readonly releaseRecords = new Map<string, ModuleReleaseRecord>();
  private readonly readbackRecords = new Map<string, ModuleReadbackRecord>();
  private readonly idempotencyRecords = new Map<string, ModuleControlIdempotencyRecord>();
  private readonly eventRecords: ControlEventRecord[] = [];
  private readonly failureQueues = new Map<
    FakeControlRepositoryMethodName,
    ModuleControlRepositoryError[]
  >();
  private readonly replayResults = new Map<string, StoredWriteResult>();
  private readonly callLog: FakeControlRepositoryCall[] = [];
  private nextEventSequence = 1;
  private closed = false;

  constructor(options: FakeModuleControlRepositoryOptions) {
    if (typeof options.managementTenantId !== "string" || options.managementTenantId.length === 0) {
      invalidState();
    }
    this.managementTenantId = options.managementTenantId;
    this.seed(options.records);
  }

  get calls(): readonly FakeControlRepositoryCall[] {
    return Object.freeze([...this.callLog]);
  }

  queueFailure(
    method: FakeControlRepositoryMethodName,
    failure: ModuleControlRepositoryError["code"] | ModuleControlRepositoryError,
  ): void {
    const typedFailure =
      failure instanceof ModuleControlRepositoryError
        ? new ModuleControlRepositoryError(failure.code)
        : new ModuleControlRepositoryError(failure);
    const queue = this.failureQueues.get(method);
    if (queue === undefined) {
      this.failureQueues.set(method, [typedFailure]);
    } else {
      queue.push(typedFailure);
    }
  }

  async health(): Promise<{ readonly ready: boolean }> {
    this.recordCall("health", null);
    if (this.closed) {
      await Promise.resolve();
      return freezeSnapshot({ ready: false });
    }
    this.consumeFailure("health");
    await Promise.resolve();
    return freezeSnapshot({ ready: true });
  }

  async close(): Promise<void> {
    this.recordCall("close", null);
    if (this.closed) return Promise.resolve();
    this.consumeFailure("close");
    this.closed = true;
    await Promise.resolve();
  }

  async registerModule(request: RegisterModuleRecordRequest): Promise<RegistrationWriteResult> {
    this.begin("registerModule", request);
    await Promise.resolve();
    const bound = this.bindRequest(request);
    const key = replayKey(
      "registerModule",
      this.managementTenantId,
      bound.metadata.action,
      bound.metadata.idempotencyKey,
    );
    // Replaying the closed result is the only idempotency behavior here;
    // request-hash conflicts and state-machine checks belong to the service.
    const replay = this.replayResults.get(key);
    if (replay?.kind === "registration") {
      return this.replayResult(replay.result);
    }

    const record = this.storeRegistration(bound.record);
    const event = this.appendEvent(bound.metadata, record);
    this.materializeCompletedIdempotency(bound.metadata, record, request.finalResult);
    const result = this.freezeWriteResult({ record, event, replayed: false });
    this.replayResults.set(key, { kind: "registration", result });
    return result;
  }

  async createPreview(request: CreatePreviewRecordRequest): Promise<PreviewWriteResult> {
    this.begin("createPreview", request);
    await Promise.resolve();
    const bound = this.bindRequest(request);
    const key = replayKey(
      "createPreview",
      this.managementTenantId,
      bound.metadata.action,
      bound.metadata.idempotencyKey,
    );
    const replay = this.replayResults.get(key);
    if (replay?.kind === "preview") {
      return this.replayResult(replay.result);
    }

    const record = this.storePreview(bound.record);
    const event = this.appendEvent(bound.metadata, record);
    this.materializeCompletedIdempotency(bound.metadata, record, request.finalResult);
    const result = this.freezeWriteResult({ record, event, replayed: false });
    this.replayResults.set(key, { kind: "preview", result });
    return result;
  }

  async decideApproval(request: DecideApprovalRecordRequest): Promise<ApprovalWriteResult> {
    this.begin("decideApproval", request);
    await Promise.resolve();
    const bound = this.bindRequest(request);
    const key = replayKey(
      "decideApproval",
      this.managementTenantId,
      bound.metadata.action,
      bound.metadata.idempotencyKey,
    );
    const replay = this.replayResults.get(key);
    if (replay?.kind === "approval") {
      return this.replayResult(replay.result);
    }

    const record = this.storeApproval(bound.record);
    const event = this.appendEvent(bound.metadata, record);
    this.materializeCompletedIdempotency(bound.metadata, record, request.finalResult);
    const result = this.freezeWriteResult({ record, event, replayed: false });
    this.replayResults.set(key, { kind: "approval", result });
    return result;
  }

  async publishRelease(request: PublishReleaseRecordRequest): Promise<ReleaseWriteResult> {
    this.begin("publishRelease", request);
    await Promise.resolve();
    const bound = this.bindRequest(request);
    const key = replayKey(
      "publishRelease",
      this.managementTenantId,
      bound.metadata.action,
      bound.metadata.idempotencyKey,
    );
    const replay = this.replayResults.get(key);
    if (replay?.kind === "release") {
      const current = this.releaseRecords.get(recordKey(this.managementTenantId, bound.record.releaseId));
      const replayResult: ReleaseWriteResult =
        current === undefined
          ? replay.result
          : this.freezeWriteResult({
              record: this.snapshotRecord(current),
              event: replay.result.event,
              replayed: true,
            });
      return replayResult;
    }

    const record = this.storeRelease(bound.record as ModuleReleaseRecord);
    const event = this.appendEvent(bound.metadata, record);
    this.materializeDomainCommittedIdempotency(
      bound.metadata,
      record.releaseId,
      record.createdAt,
    );
    const result = this.freezeWriteResult<ReleaseWriteResult>({ record, event, replayed: false });
    this.replayResults.set(key, { kind: "release", result });
    return result;
  }

  async recordReadback(request: RecordReadbackRequest): Promise<ReadbackWriteResult> {
    this.begin("recordReadback", request);
    await Promise.resolve();
    const bound = this.bindRequest(request);
    const idempotencyRecord = this.idempotencyRecords.get(
      idempotencyKey(
        this.managementTenantId,
        bound.metadata.action,
        bound.metadata.idempotencyKey,
      ),
    );
    if (bound.metadata.action === "deployments.publish") {
      if (idempotencyRecord === undefined) {
        throw new ModuleControlRepositoryError("not_found");
      }
      if (idempotencyRecord.requestHash !== bound.metadata.requestHash) {
        throw new ModuleControlRepositoryError("conflict");
      }
      if (idempotencyRecord.status === "reserved") {
        throw new ModuleControlRepositoryError("invalid_state");
      }
      if (
        (idempotencyRecord.status !== "domain_committed" &&
          idempotencyRecord.status !== "completed") ||
        idempotencyRecord.domainRecordRef !== bound.record.releaseId
      ) {
        throw new ModuleControlRepositoryError("conflict");
      }
    }
    const key = replayKey(
      "recordReadback",
      this.managementTenantId,
      bound.metadata.action,
      bound.metadata.idempotencyKey,
    );
    const replay = this.replayResults.get(key);
    if (replay?.kind === "readback") {
      return this.replayResult(replay.result);
    }

    const record = this.storeReadback(bound.record as ModuleReadbackRecord);
    const event = this.appendEvent(bound.metadata, record);
    if (bound.metadata.action === "deployments.reconcile") {
      this.materializeDomainCommittedIdempotency(
        bound.metadata,
        record.releaseId,
        record.checkedAt,
      );
    }
    const result = this.freezeWriteResult<ReadbackWriteResult>({ record, event, replayed: false });
    this.replayResults.set(key, { kind: "readback", result });
    return result;
  }

  async completeIdempotency(
    request: CompleteControlIdempotencyRequest,
  ): Promise<DeepReadonly<ModuleControlIdempotencyRecord>> {
    this.begin("completeIdempotency", request);
    await Promise.resolve();
    const bound = this.bindRequest(request);
    const key = idempotencyKey(
      this.managementTenantId,
      bound.metadata.action,
      bound.metadata.idempotencyKey,
    );
    const existing = this.idempotencyRecords.get(key);
    const requested = bound.record as ModuleControlIdempotencyRecord;
    if (requested.status !== "completed" || requested.finalResult === null) {
      throw new ModuleControlRepositoryError("invalid_state");
    }
    if (existing === undefined) {
      throw new ModuleControlRepositoryError("not_found");
    }
    this.assertIdempotencyContinuation(existing, bound.metadata, requested);
    if (existing.status === "completed") return this.snapshotRecord(existing);
    if (existing.status !== "domain_committed") {
      throw new ModuleControlRepositoryError("invalid_state");
    }
    const completed = this.storeIdempotency(requested);
    this.appendIdempotencyEvent(bound.metadata, completed);
    return this.snapshotRecord(completed);
  }

  async getControlState(): Promise<DeepReadonly<ModuleControlState>> {
    this.begin("getControlState", null);
    await Promise.resolve();
    const activeRelease = this.findReleaseByStatus("active_verified");
    const state = {
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
      events: [...this.eventRecords].sort(
        (left, right) =>
          left.sequence - right.sequence || compareStrings(left.eventId, right.eventId),
      ),
    } as ModuleControlState;
    return deepFreezeControlRecord(state);
  }

  async getActiveRelease(): Promise<DeepReadonly<ModuleReleaseRecord> | null> {
    this.begin("getActiveRelease", null);
    await Promise.resolve();
    return this.findReleaseByStatus("active_verified");
  }

  async getPendingRelease(): Promise<DeepReadonly<ModuleReleaseRecord> | null> {
    this.begin("getPendingRelease", null);
    await Promise.resolve();
    return this.findReleaseByStatus("published_pending_readback");
  }

  async getNewestUnresolvedRelease(): Promise<DeepReadonly<ModuleReleaseRecord> | null> {
    this.begin("getNewestUnresolvedRelease", null);
    await Promise.resolve();
    return this.findReleaseByStatus("published_pending_readback", "manual_review");
  }

  async getPreview(
    query: GetModulePreviewQuery,
  ): Promise<DeepReadonly<ModulePreviewRecord> | null> {
    this.begin("getPreview", query);
    await Promise.resolve();
    this.assertExactQuery(query, ["managementTenantId", "previewRef"]);
    this.assertTenant(query.managementTenantId);
    const record = this.previewRecords.get(recordKey(this.managementTenantId, query.previewRef));
    return record === undefined ? null : this.snapshotRecord(record);
  }

  async getApproval(
    query: GetModuleApprovalQuery,
  ): Promise<DeepReadonly<ModuleApprovalRecord> | null> {
    this.begin("getApproval", query);
    await Promise.resolve();
    this.assertExactQuery(query, ["managementTenantId", "approvalId"]);
    this.assertTenant(query.managementTenantId);
    const record = this.approvalRecords.get(recordKey(this.managementTenantId, query.approvalId));
    return record === undefined ? null : this.snapshotRecord(record);
  }

  async getRelease(
    query: GetModuleReleaseQuery,
  ): Promise<DeepReadonly<ModuleReleaseRecord> | null> {
    this.begin("getRelease", query);
    await Promise.resolve();
    this.assertExactQuery(query, ["managementTenantId", "releaseId"]);
    this.assertTenant(query.managementTenantId);
    const record = this.releaseRecords.get(recordKey(this.managementTenantId, query.releaseId));
    return record === undefined ? null : this.snapshotRecord(record);
  }

  async getReadback(
    query: GetModuleReadbackQuery,
  ): Promise<DeepReadonly<ModuleReadbackRecord> | null> {
    this.begin("getReadback", query);
    await Promise.resolve();
    this.assertExactQuery(query, ["managementTenantId", "releaseId"]);
    this.assertTenant(query.managementTenantId);
    const record = this.readbackRecords.get(recordKey(this.managementTenantId, query.releaseId));
    return record === undefined ? null : this.snapshotRecord(record);
  }

  async getIdempotency(
    query: GetControlIdempotencyQuery,
  ): Promise<DeepReadonly<ModuleControlIdempotencyRecord> | null> {
    this.begin("getIdempotency", query);
    await Promise.resolve();
    this.assertExactQuery(query, ["managementTenantId", "action", "idempotencyKey"]);
    this.assertTenant(query.managementTenantId);
    if (
      typeof query.action !== "string" ||
      !MODULE_CONTROL_ACTIONS.includes(query.action)
    ) {
      invalidState();
    }
    const record = this.idempotencyRecords.get(
      idempotencyKey(this.managementTenantId, query.action, query.idempotencyKey),
    );
    return record === undefined ? null : this.snapshotRecord(record);
  }

  private begin<M extends FakeControlRepositoryMethodName>(
    method: M,
    request: FakeControlRepositoryRequestByMethod[M],
  ): void {
    this.recordCall(method, request);
    if (this.closed) throw new ModuleControlRepositoryError("closed");
    this.consumeFailure(method);
  }

  private recordCall<M extends FakeControlRepositoryMethodName>(
    method: M,
    request: FakeControlRepositoryRequestByMethod[M],
  ): void {
    const snapshot = freezeSnapshot({ method, request });
    this.callLog.push(snapshot as FakeControlRepositoryCall);
  }

  private consumeFailure(method: FakeControlRepositoryMethodName): void {
    const queue = this.failureQueues.get(method);
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
    if (tenant !== this.managementTenantId) {
      throw new ModuleControlRepositoryError("tenant_mismatch");
    }
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
      if (typeof query[key] !== "string" || query[key].length === 0) invalidState();
    }
  }

  private seed(records: FakeModuleControlRepositoryRecords | undefined): void {
    for (const record of records?.registrations ?? []) {
      const frozen = this.seedRecord(record);
      this.registrationRecords.set(
        recordKey(this.managementTenantId, frozen.moduleId, frozen.version, frozen.descriptorDigest),
        frozen,
      );
    }
    for (const record of records?.previews ?? []) {
      const frozen = this.seedRecord(record);
      this.previewRecords.set(recordKey(this.managementTenantId, frozen.previewRef), frozen);
    }
    for (const record of records?.approvals ?? []) {
      const frozen = this.seedRecord(record);
      this.approvalRecords.set(recordKey(this.managementTenantId, frozen.approvalId), frozen);
    }
    for (const record of records?.releases ?? []) {
      const frozen = this.seedRecord(record);
      this.releaseRecords.set(recordKey(this.managementTenantId, frozen.releaseId), frozen);
    }
    for (const record of records?.readbacks ?? []) {
      const frozen = this.seedRecord(record);
      this.readbackRecords.set(recordKey(this.managementTenantId, frozen.releaseId), frozen);
    }
    for (const record of records?.idempotency ?? []) {
      const frozen = this.seedRecord(record);
      this.idempotencyRecords.set(
        idempotencyKey(this.managementTenantId, frozen.action, frozen.idempotencyKey),
        frozen,
      );
    }
    for (const event of records?.events ?? []) {
      const frozen = this.seedRecord(event);
      this.eventRecords.push(frozen);
      this.nextEventSequence = Math.max(this.nextEventSequence, frozen.sequence + 1);
    }
  }

  private seedRecord<T extends ControlRecord>(record: T): T {
    const frozen = deepFreezeControlRecord(record);
    this.assertTenant(frozen.managementTenantId);
    return frozen as T;
  }

  private storeRegistration(
    record: ModuleRegistrationRecord,
  ): ModuleRegistrationRecord {
    const frozen = deepFreezeControlRecord(record);
    this.registrationRecords.set(
      recordKey(this.managementTenantId, frozen.moduleId, frozen.version, frozen.descriptorDigest),
      frozen,
    );
    return frozen;
  }

  private storePreview(record: ModulePreviewRecord): ModulePreviewRecord {
    const frozen = deepFreezeControlRecord(record);
    this.previewRecords.set(
      recordKey(this.managementTenantId, frozen.previewRef),
      frozen,
    );
    return frozen;
  }

  private storeApproval(record: ModuleApprovalRecord): ModuleApprovalRecord {
    const frozen = deepFreezeControlRecord(record);
    this.approvalRecords.set(
      recordKey(this.managementTenantId, frozen.approvalId),
      frozen,
    );
    return frozen;
  }

  private storeRelease(record: ModuleReleaseRecord): ModuleReleaseRecord {
    const frozen = deepFreezeControlRecord(record);
    this.releaseRecords.set(
      recordKey(this.managementTenantId, frozen.releaseId),
      frozen as ModuleReleaseRecord,
    );
    return frozen as ModuleReleaseRecord;
  }

  private storeReadback(record: ModuleReadbackRecord): ModuleReadbackRecord {
    const frozen = deepFreezeControlRecord(record);
    this.readbackRecords.set(
      recordKey(this.managementTenantId, frozen.releaseId),
      frozen as ModuleReadbackRecord,
    );
    const releaseKey = recordKey(this.managementTenantId, frozen.releaseId);
    const release = this.releaseRecords.get(releaseKey);
    // Keep only the minimal readback materialization needed by service tests;
    // publish/approval/CAS policy remains outside this test double.
    if (release !== undefined && frozen.status !== "pending") {
      if (frozen.status === "verified") {
        const nextRelease = {
          ...release,
          status: "active_verified",
          readbackRef: frozen.readbackRef,
          reasonCodes: [],
          supersededByReleaseId: null,
        } as ModuleReleaseRecord;
        this.releaseRecords.set(
          releaseKey,
          deepFreezeControlRecord(nextRelease) as ModuleReleaseRecord,
        );
      } else {
        if (frozen.reasonCodes.length === 0) invalidState();
        const nextRelease = {
          ...release,
          status: "manual_review",
          readbackRef: frozen.readbackRef,
          reasonCodes: [frozen.reasonCodes[0]!, ...frozen.reasonCodes.slice(1)],
          supersededByReleaseId: null,
        } as ModuleReleaseRecord;
        this.releaseRecords.set(
          releaseKey,
          deepFreezeControlRecord(nextRelease) as ModuleReleaseRecord,
        );
      }
    }
    return frozen as ModuleReadbackRecord;
  }

  private storeIdempotency(
    record: ModuleControlIdempotencyRecord,
  ): ModuleControlIdempotencyRecord {
    const frozen = deepFreezeControlRecord(record);
    this.idempotencyRecords.set(
      idempotencyKey(this.managementTenantId, frozen.action, frozen.idempotencyKey),
      frozen as ModuleControlIdempotencyRecord,
    );
    return frozen as ModuleControlIdempotencyRecord;
  }

  private materializeCompletedIdempotency(
    metadata: DeepReadonly<ControlRequestMetadata>,
    domainRecord: ModuleRegistrationRecord | ModulePreviewRecord | ModuleApprovalRecord,
    finalResult: ControlFinalResult,
  ): void {
    const key = idempotencyKey(
      this.managementTenantId,
      metadata.action,
      metadata.idempotencyKey,
    );
    if (this.idempotencyRecords.has(key)) return;
    const createdAt = recordTimestamp(domainRecord);
    this.storeIdempotency({
      managementTenantId: this.managementTenantId,
      action: metadata.action,
      idempotencyKey: metadata.idempotencyKey,
      requestHash: metadata.requestHash,
      status: "completed",
      domainRecordRef:
        "moduleId" in domainRecord
          ? `registration:${domainRecord.moduleId}:${domainRecord.version}:${domainRecord.descriptorDigest}`
          : "previewRef" in domainRecord && "intent" in domainRecord
            ? domainRecord.previewRef
            : domainRecord.approvalId,
      finalResult: freezeSnapshot(finalResult) as ControlFinalResult,
      createdAt,
      expiresAt: idempotencyExpiresAt(createdAt),
    });
  }

  private materializeDomainCommittedIdempotency(
    metadata: DeepReadonly<ControlRequestMetadata>,
    domainRecordRef: string,
    createdAt: string,
  ): void {
    const key = idempotencyKey(
      this.managementTenantId,
      metadata.action,
      metadata.idempotencyKey,
    );
    if (this.idempotencyRecords.has(key)) return;
    this.storeIdempotency({
      managementTenantId: this.managementTenantId,
      action: metadata.action,
      idempotencyKey: metadata.idempotencyKey,
      requestHash: metadata.requestHash,
      status: "domain_committed",
      domainRecordRef,
      finalResult: null,
      createdAt,
      expiresAt: idempotencyExpiresAt(createdAt),
    });
  }

  private assertIdempotencyContinuation(
    existing: ModuleControlIdempotencyRecord,
    metadata: DeepReadonly<ControlRequestMetadata>,
    requested: ModuleControlIdempotencyRecord,
  ): void {
    if (existing.managementTenantId !== metadata.managementTenantId) {
      throw new ModuleControlRepositoryError("tenant_mismatch");
    }
    if (
      existing.action !== metadata.action ||
      existing.idempotencyKey !== metadata.idempotencyKey ||
      existing.requestHash !== metadata.requestHash ||
      existing.domainRecordRef !== requested.domainRecordRef ||
      existing.createdAt !== requested.createdAt ||
      existing.expiresAt !== requested.expiresAt
    ) {
      throw new ModuleControlRepositoryError("conflict");
    }
    if (existing.status === "completed" && !isDeepStrictEqual(existing, requested)) {
      throw new ModuleControlRepositoryError("conflict");
    }
  }

  private appendIdempotencyEvent(
    metadata: DeepReadonly<ControlRequestMetadata>,
    record: ModuleControlIdempotencyRecord,
  ): DeepReadonly<ControlEventRecord> {
    const objectRef = `idempotency:${metadata.action}:${metadata.idempotencyKey}`;
    const event = {
      managementTenantId: metadata.managementTenantId,
      eventId: `fake_event_${this.nextEventSequence}`,
      sequence: this.nextEventSequence,
      actorRef: metadata.actorRef,
      action: metadata.action,
      objectRef,
      kind: "idempotency",
      status: "completed",
      reasonCodes: [],
      detail: {
        kind: "idempotency",
        recordRef: objectRef,
        domainRecordRef: record.domainRecordRef,
        status: "completed",
      },
      occurredAt: record.createdAt,
    } as const satisfies ControlEventRecord;
    this.nextEventSequence += 1;
    const frozen = deepFreezeControlRecord(event);
    this.eventRecords.push(frozen);
    return frozen;
  }

  private appendEvent(
    metadata: DeepReadonly<ControlRequestMetadata>,
    record: ControlRecord,
  ): DeepReadonly<ControlEventRecord> {
    const event = {
      managementTenantId: metadata.managementTenantId,
      eventId: `fake_event_${this.nextEventSequence}`,
      sequence: this.nextEventSequence,
      actorRef: metadata.actorRef,
      action: metadata.event.action,
      objectRef: metadata.event.objectRef,
      kind: metadata.event.kind,
      status: metadata.event.status,
      reasonCodes: metadata.event.reasonCodes,
      detail: metadata.event.detail,
      occurredAt: recordTimestamp(record),
    } as ControlEventRecord;
    this.nextEventSequence += 1;
    const frozen = deepFreezeControlRecord(event);
    this.eventRecords.push(frozen);
    return frozen;
  }

  private snapshotRecord<T extends ControlRecord>(record: T): DeepReadonly<T> {
    return deepFreezeControlRecord(record);
  }

  private freezeWriteResult<T extends RegistrationWriteResult | PreviewWriteResult | ApprovalWriteResult | ReleaseWriteResult | ReadbackWriteResult>(
    result: T,
  ): T {
    return freezeSnapshot(result) as T;
  }

  private replayResult<T extends RegistrationWriteResult | PreviewWriteResult | ApprovalWriteResult | ReleaseWriteResult | ReadbackWriteResult>(
    result: T,
  ): T {
    return this.freezeWriteResult({ ...result, replayed: true });
  }

  private latestBy<T>(
    records: Iterable<T>,
    timestamp: (record: T) => string,
    tieBreak: (record: T) => string,
  ): T | null {
    let result: T | null = null;
    for (const record of records) {
      if (
        result === null ||
        timestamp(record) > timestamp(result) ||
        (timestamp(record) === timestamp(result) &&
          tieBreak(record) > tieBreak(result))
      ) {
        result = record;
      }
    }
    return result;
  }

  private findReleaseByStatus(
    ...statuses: readonly ModuleReleaseRecord["status"][]
  ): DeepReadonly<ModuleReleaseRecord> | null {
    let result: ModuleReleaseRecord | null = null;
    for (const record of this.releaseRecords.values()) {
      if (!statuses.includes(record.status)) continue;
      if (
        result === null ||
        record.revision > result.revision ||
        (record.revision === result.revision &&
          record.releaseId > result.releaseId)
      ) {
        result = record;
      }
    }
    return result === null ? null : this.snapshotRecord(result);
  }
}
