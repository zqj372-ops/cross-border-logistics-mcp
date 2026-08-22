import { isDeepStrictEqual, types as nodeUtilTypes } from "node:util";

import { controlEnvelopeSchema } from "./contracts";
import type { ControlEnvelope } from "./contracts";
import {
  DESCRIPTOR_DIGEST_PATTERN,
  IDENTIFIER_PATTERN,
  VERSION_PATTERN,
} from "./lexical-contracts";
import {
  ADMIN_CONTROL_RFC3339_PATTERN,
  compareRfc3339Instants,
} from "./rfc3339-instant";
import type { DescriptorDigest } from "./types";

export type { ControlEnvelope } from "./contracts";

export const CONTROL_IDEMPOTENCY_STATUSES = Object.freeze([
  "reserved",
  "domain_committed",
  "completed",
] as const);
export type ControlIdempotencyStatus =
  (typeof CONTROL_IDEMPOTENCY_STATUSES)[number];

export const MODULE_RELEASE_STATUSES = Object.freeze([
  "published_pending_readback",
  "manual_review",
  "active_verified",
  "superseded",
] as const);
export type ModuleReleaseStatus = (typeof MODULE_RELEASE_STATUSES)[number];

export const MODULE_READBACK_STATUSES = Object.freeze([
  "pending",
  "verified",
  "mismatch",
  "unknown",
] as const);
export type ModuleReadbackStatus = (typeof MODULE_READBACK_STATUSES)[number];

export const MODULE_CONTROL_ACTIONS = Object.freeze([
  "packages.register",
  "deployments.preview",
  "approvals.decide",
  "deployments.publish",
  "deployments.reconcile",
] as const);
export type ModuleControlAction = (typeof MODULE_CONTROL_ACTIONS)[number];

export type CanonicalRequestHash =
  `mcp-control-hash/v1/request/sha256:${string}`;
export type CanonicalPreviewHash =
  `mcp-control-hash/v1/preview/sha256:${string}`;

const REQUEST_HASH_PATTERN =
  /^mcp-control-hash\/v1\/request\/sha256:[a-f0-9]{64}$/;
const PREVIEW_HASH_PATTERN =
  /^mcp-control-hash\/v1\/preview\/sha256:[a-f0-9]{64}$/;

export type ModuleControlRepositoryErrorCode =
  | "closed"
  | "conflict"
  | "invalid_state"
  | "not_found"
  | "tenant_mismatch";

const ERROR_MESSAGES: Readonly<
  Record<ModuleControlRepositoryErrorCode, string>
> = {
  closed: "The module control repository is closed.",
  conflict: "The module control repository detected a conflict.",
  invalid_state: "The module control record is invalid.",
  not_found: "The module control record was not found.",
  tenant_mismatch: "The management tenant does not match.",
};

export class ModuleControlRepositoryError extends Error {
  readonly code!: ModuleControlRepositoryErrorCode;

  constructor(code: ModuleControlRepositoryErrorCode) {
    const safeCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? code
      : "invalid_state";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "ModuleControlRepositoryError";
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      value: safeCode,
      writable: false,
    });
  }
}

function invalidState(): never {
  throw new ModuleControlRepositoryError("invalid_state");
}

export function isRequestHash(value: unknown): value is CanonicalRequestHash {
  return typeof value === "string" && REQUEST_HASH_PATTERN.test(value);
}

export function isPreviewHash(value: unknown): value is CanonicalPreviewHash {
  return typeof value === "string" && PREVIEW_HASH_PATTERN.test(value);
}

function isModuleControlAction(value: unknown): value is ModuleControlAction {
  return (
    typeof value === "string" &&
    MODULE_CONTROL_ACTIONS.includes(value as ModuleControlAction)
  );
}

export function assertRequestHash(
  value: unknown,
): asserts value is CanonicalRequestHash {
  if (!isRequestHash(value)) invalidState();
}

export function assertPreviewHash(
  value: unknown,
): asserts value is CanonicalPreviewHash {
  if (!isPreviewHash(value)) invalidState();
}

export interface ModuleControlRef {
  readonly moduleId: string;
  readonly version: string;
  readonly descriptorDigest: DescriptorDigest;
}

export interface ModuleControlEvidenceRefs {
  readonly sourceShaRef: string | null;
  readonly artifactDigestRef: string | null;
  readonly signatureRef: string | null;
  readonly sbomRef: string | null;
  readonly attestationRef: string | null;
}

export interface ModuleRegistrationRecord {
  readonly managementTenantId: string;
  readonly moduleId: string;
  readonly version: string;
  readonly descriptorDigest: DescriptorDigest;
  readonly evidenceLevel: "local_build";
  readonly productionEligible: false;
  readonly evidenceRefs: ModuleControlEvidenceRefs;
  readonly registeredByActorRef: string;
  readonly registeredAt: string;
}

export interface ModulePreviewValidation {
  readonly baseMatches: boolean;
  readonly desiredModulesValid: boolean;
  readonly inventoryMatches: boolean;
  readonly minimumActiveModules: boolean;
  readonly reasonCodes: readonly string[];
}

export interface ModulePreviewDiff {
  readonly added: readonly ModuleControlRef[];
  readonly removed: readonly ModuleControlRef[];
  readonly retained: readonly ModuleControlRef[];
}

interface ModulePreviewRecordBase {
  readonly managementTenantId: string;
  readonly previewRef: string;
  readonly canonicalHash: CanonicalPreviewHash;
  readonly baseReleaseId: string | null;
  readonly baseRevision: number;
  readonly inventoryRefs: readonly ModuleControlRef[];
  readonly desiredModules: readonly ModuleControlRef[];
  readonly diff: ModulePreviewDiff;
  readonly validation: ModulePreviewValidation;
  readonly creatorActorRef: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumed: boolean;
}

export interface ModuleChangePreviewRecord extends ModulePreviewRecordBase {
  readonly intent: "change";
  readonly targetReleaseId?: never;
}

export interface ModuleRollbackPreviewRecord extends ModulePreviewRecordBase {
  readonly intent: "rollback";
  readonly targetReleaseId: string;
}

export type ModulePreviewRecord =
  | ModuleChangePreviewRecord
  | ModuleRollbackPreviewRecord;

export type ModuleApprovalDecision = "approve" | "reject";

export interface ModuleApprovalRecord {
  readonly managementTenantId: string;
  readonly approvalId: string;
  readonly previewRef: string;
  readonly decision: ModuleApprovalDecision;
  readonly previewCanonicalHash: CanonicalPreviewHash;
  readonly baseReleaseId: string | null;
  readonly baseRevision: number;
  readonly inventoryDigestSet: readonly DescriptorDigest[];
  readonly expiresAt: string;
  readonly reasonCode: string;
  readonly approverActorRef: string;
  readonly decidedAt: string;
  readonly consumed: boolean;
}

interface ModuleReleaseRecordBase {
  readonly managementTenantId: string;
  readonly releaseId: string;
  readonly revision: number;
  readonly desiredModules: readonly ModuleControlRef[];
  readonly previousReleaseId: string | null;
  readonly previewRef: string;
  readonly approvalId: string;
  readonly publisherActorRef: string;
  readonly createdAt: string;
  readonly publishedAt: string | null;
}

export interface ModulePendingReleaseRecord extends ModuleReleaseRecordBase {
  readonly status: "published_pending_readback";
  readonly readbackRef: null;
  readonly reasonCodes: readonly [];
  readonly supersededByReleaseId: null;
}

export interface ModuleManualReviewReleaseRecord
  extends ModuleReleaseRecordBase {
  readonly status: "manual_review";
  readonly readbackRef: string;
  readonly reasonCodes: readonly [string, ...string[]];
  readonly supersededByReleaseId: null;
}

export interface ModuleActiveVerifiedReleaseRecord
  extends ModuleReleaseRecordBase {
  readonly status: "active_verified";
  readonly readbackRef: string;
  readonly reasonCodes: readonly [];
  readonly supersededByReleaseId: null;
}

export interface ModuleSupersededReleaseRecord extends ModuleReleaseRecordBase {
  readonly status: "superseded";
  readonly readbackRef: string;
  readonly reasonCodes: readonly [];
  readonly supersededByReleaseId: string;
}

export type ModuleReleaseRecord =
  | ModulePendingReleaseRecord
  | ModuleManualReviewReleaseRecord
  | ModuleActiveVerifiedReleaseRecord
  | ModuleSupersededReleaseRecord;

export interface ModuleChangeReleaseHistoryEntry {
  readonly release: ModuleReleaseRecord;
  readonly intent: "change";
  readonly rollbackTargetReleaseId: null;
}

export interface ModuleRollbackReleaseHistoryEntry {
  readonly release: ModuleReleaseRecord;
  readonly intent: "rollback";
  readonly rollbackTargetReleaseId: string;
}

export type ModuleReleaseHistoryEntry =
  | ModuleChangeReleaseHistoryEntry
  | ModuleRollbackReleaseHistoryEntry;

interface ModuleReadbackRecordBase {
  readonly managementTenantId: string;
  readonly readbackRef: string;
  readonly releaseId: string;
  readonly revision: number;
  readonly appliedModules: readonly ModuleControlRef[];
  readonly checkedAt: string;
}

export interface ModulePendingReadbackRecord extends ModuleReadbackRecordBase {
  readonly status: "pending";
  readonly appliedReleaseId: null;
  readonly appliedRevision: null;
  readonly reasonCodes: readonly [];
}

export interface ModuleVerifiedReadbackRecord extends ModuleReadbackRecordBase {
  readonly status: "verified";
  readonly appliedReleaseId: string;
  readonly appliedRevision: number;
  readonly reasonCodes: readonly [];
}

export interface ModuleMismatchReadbackRecord extends ModuleReadbackRecordBase {
  readonly status: "mismatch";
  readonly appliedReleaseId: string | null;
  readonly appliedRevision: number | null;
  readonly reasonCodes: readonly [string, ...string[]];
}

export interface ModuleUnknownReadbackRecord extends ModuleReadbackRecordBase {
  readonly status: "unknown";
  readonly appliedReleaseId: string | null;
  readonly appliedRevision: number | null;
  readonly reasonCodes: readonly [string, ...string[]];
}

export type ModuleReadbackRecord =
  | ModulePendingReadbackRecord
  | ModuleVerifiedReadbackRecord
  | ModuleMismatchReadbackRecord
  | ModuleUnknownReadbackRecord;

export interface ControlFinalResult {
  readonly domainRecordRef: string;
  readonly envelope: ControlEnvelope;
}

interface ModuleControlIdempotencyRecordBase {
  readonly managementTenantId: string;
  readonly action: ModuleControlAction;
  readonly idempotencyKey: string;
  readonly requestHash: CanonicalRequestHash;
  readonly actorRef: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ReservedModuleControlIdempotencyRecord
  extends ModuleControlIdempotencyRecordBase {
  readonly status: "reserved";
  readonly domainRecordRef: null;
  readonly finalResult: null;
}

export interface DomainCommittedModuleControlIdempotencyRecord
  extends ModuleControlIdempotencyRecordBase {
  readonly status: "domain_committed";
  readonly domainRecordRef: string;
  readonly finalResult: null;
}

export interface CompletedModuleControlIdempotencyRecord
  extends ModuleControlIdempotencyRecordBase {
  readonly status: "completed";
  readonly domainRecordRef: string;
  readonly finalResult: ControlFinalResult;
}

export type ModuleControlIdempotencyRecord =
  | ReservedModuleControlIdempotencyRecord
  | DomainCommittedModuleControlIdempotencyRecord
  | CompletedModuleControlIdempotencyRecord;
export type ControlIdempotencyRecord = ModuleControlIdempotencyRecord;

type RegistrationEventStatus = "registered";
type PreviewEventStatus = "previewed";
type ApprovalEventStatus = "approved" | "rejected";
type ReleaseEventStatus = ModuleReleaseStatus;
type ReconciliationEventStatus = ModuleReadbackStatus;

export interface RegistrationEventDetail {
  readonly kind: "registration";
  readonly recordRef: string;
  readonly moduleId: string;
  readonly version: string;
  readonly descriptorDigest: DescriptorDigest;
  readonly status: RegistrationEventStatus;
  readonly previewRef?: never;
  readonly approvalId?: never;
  readonly releaseId?: never;
  readonly revision?: never;
  readonly readbackRef?: never;
  readonly domainRecordRef?: never;
}

export interface PreviewEventDetail {
  readonly kind: "preview";
  readonly previewRef: string;
  readonly baseRevision: number;
  readonly status: PreviewEventStatus;
  moduleId?: never;
  version?: never;
  descriptorDigest?: never;
  approvalId?: never;
  releaseId?: never;
  revision?: never;
  readbackRef?: never;
  domainRecordRef?: never;
}

export interface ApprovalEventDetail {
  readonly kind: "approval";
  readonly approvalId: string;
  readonly previewRef: string;
  readonly status: ApprovalEventStatus;
  moduleId?: never;
  version?: never;
  descriptorDigest?: never;
  releaseId?: never;
  revision?: never;
  readbackRef?: never;
  domainRecordRef?: never;
}

export interface ReleaseEventDetail {
  readonly kind: "release";
  readonly releaseId: string;
  readonly revision: number;
  readonly status: ReleaseEventStatus;
  moduleId?: never;
  version?: never;
  descriptorDigest?: never;
  previewRef?: never;
  approvalId?: never;
  readbackRef?: never;
  domainRecordRef?: never;
}

export interface ReconciliationEventDetail {
  readonly kind: "reconciliation";
  readonly releaseId: string;
  readonly revision: number;
  readonly readbackRef: string;
  readonly status: ReconciliationEventStatus;
  moduleId?: never;
  version?: never;
  descriptorDigest?: never;
  previewRef?: never;
  approvalId?: never;
  domainRecordRef?: never;
}

export interface IdempotencyEventDetail {
  readonly kind: "idempotency";
  readonly recordRef: string;
  readonly domainRecordRef: string | null;
  readonly status: ControlIdempotencyStatus;
  moduleId?: never;
  version?: never;
  descriptorDigest?: never;
  previewRef?: never;
  approvalId?: never;
  releaseId?: never;
  revision?: never;
  readbackRef?: never;
}

interface ControlEventInputBase {
  readonly objectRef: string;
  readonly reasonCodes: readonly string[];
}

export interface RegistrationControlEventInput extends ControlEventInputBase {
  readonly action: "packages.register";
  readonly kind: "registration";
  readonly status: RegistrationEventStatus;
  readonly detail: RegistrationEventDetail;
}

export interface PreviewControlEventInput extends ControlEventInputBase {
  readonly action: "deployments.preview";
  readonly kind: "preview";
  readonly status: PreviewEventStatus;
  readonly detail: PreviewEventDetail;
}

export interface ApprovalControlEventInput extends ControlEventInputBase {
  readonly action: "approvals.decide";
  readonly kind: "approval";
  readonly status: ApprovalEventStatus;
  readonly detail: ApprovalEventDetail;
}

export interface ReleaseControlEventInput extends ControlEventInputBase {
  readonly action: "deployments.publish";
  readonly kind: "release";
  readonly status: ReleaseEventStatus;
  readonly detail: ReleaseEventDetail;
}

export interface ReconciliationControlEventInput
  extends ControlEventInputBase {
  readonly action: "deployments.reconcile";
  readonly kind: "reconciliation";
  readonly status: ReconciliationEventStatus;
  readonly detail: ReconciliationEventDetail;
}

export interface PublishReadbackControlEventInput
  extends ControlEventInputBase {
  readonly action: "deployments.publish";
  readonly kind: "reconciliation";
  readonly status: ReconciliationEventStatus;
  readonly detail: ReconciliationEventDetail;
}

export interface IdempotencyControlEventInput extends ControlEventInputBase {
  readonly action: ModuleControlAction;
  readonly kind: "idempotency";
  readonly status: ControlIdempotencyStatus;
  readonly detail: IdempotencyEventDetail;
}

export type ControlEventInput =
  | RegistrationControlEventInput
  | PreviewControlEventInput
  | ApprovalControlEventInput
  | ReleaseControlEventInput
  | PublishReadbackControlEventInput
  | ReconciliationControlEventInput
  | IdempotencyControlEventInput;

interface ControlEventRecordFields {
  readonly managementTenantId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly actorRef: string;
  readonly occurredAt: string;
}

export type ControlEventRecord = ControlEventInput & ControlEventRecordFields;

export interface ControlEventLifecycleCounts {
  approval: number;
  completion: number;
  preview: number;
  reconciliation: number;
  registration: number;
  release: number;
}

interface ControlRequestMetadataBase<
  Action extends ModuleControlAction,
  Event extends ControlEventInput & { action: Action },
> {
  readonly managementTenantId: string;
  readonly actorRef: string;
  readonly action: Action;
  readonly idempotencyKey: string;
  readonly requestHash: CanonicalRequestHash;
  readonly event: Event;
}

export type RegisterModuleRequestMetadata = ControlRequestMetadataBase<
  "packages.register",
  RegistrationControlEventInput
>;
export type CreatePreviewRequestMetadata = ControlRequestMetadataBase<
  "deployments.preview",
  PreviewControlEventInput
>;
export type DecideApprovalRequestMetadata = ControlRequestMetadataBase<
  "approvals.decide",
  ApprovalControlEventInput
>;
export type PublishReleaseRequestMetadata = ControlRequestMetadataBase<
  "deployments.publish",
  ReleaseControlEventInput
>;
export type ReconcileRequestMetadata = ControlRequestMetadataBase<
  "deployments.reconcile",
  ReconciliationControlEventInput
>;
export type PublishReadbackRequestMetadata = ControlRequestMetadataBase<
  "deployments.publish",
  PublishReadbackControlEventInput
>;
export type CompleteIdempotencyRequestMetadata = {
  [Action in ModuleControlAction]: ControlRequestMetadataBase<
    Action,
    IdempotencyControlEventInput & { action: Action }
  >;
}[ModuleControlAction];

export type ControlRequestMetadata =
  | RegisterModuleRequestMetadata
  | CreatePreviewRequestMetadata
  | DecideApprovalRequestMetadata
  | PublishReleaseRequestMetadata
  | PublishReadbackRequestMetadata
  | ReconcileRequestMetadata
  | CompleteIdempotencyRequestMetadata;

export interface ModuleControlState {
  readonly managementTenantId: string;
  readonly activeRelease: ModuleReleaseRecord | null;
  readonly activeRevision: number;
  readonly activeModules: readonly ModuleControlRef[];
  readonly registrations: readonly ModuleRegistrationRecord[];
  readonly latestPreview: ModulePreviewRecord | null;
  readonly latestApproval: ModuleApprovalRecord | null;
  readonly latestReadback: ModuleReadbackRecord | null;
  readonly releaseHistory: readonly ModuleReleaseHistoryEntry[];
  readonly events: readonly ControlEventRecord[];
  readonly eventsTruncated: boolean;
}

export type ControlRecord =
  | ModuleRegistrationRecord
  | ModulePreviewRecord
  | ModuleApprovalRecord
  | ModuleReleaseRecord
  | ModuleReadbackRecord
  | ModuleControlIdempotencyRecord
  | ControlEventRecord
  | ModuleControlState;

export interface RegisterModuleRecordRequest {
  readonly metadata: RegisterModuleRequestMetadata;
  readonly record: ModuleRegistrationRecord;
  readonly finalResult: ControlFinalResult;
}
export interface CreatePreviewRecordRequest {
  readonly metadata: CreatePreviewRequestMetadata;
  readonly record: ModulePreviewRecord;
  readonly finalResult: ControlFinalResult;
}
export interface DecideApprovalRecordRequest {
  readonly metadata: DecideApprovalRequestMetadata;
  readonly record: ModuleApprovalRecord;
  readonly finalResult: ControlFinalResult;
}
export interface PublishReleaseRecordRequest {
  readonly metadata: PublishReleaseRequestMetadata;
  readonly record: ModuleReleaseRecord;
}
export interface RecordReadbackRequest {
  readonly metadata: ReconcileRequestMetadata | PublishReadbackRequestMetadata;
  readonly record: ModuleReadbackRecord;
}
export interface CompleteControlIdempotencyRequest {
  readonly metadata: CompleteIdempotencyRequestMetadata;
  readonly record: ModuleControlIdempotencyRecord;
}

interface ManagementTenantQuery {
  readonly managementTenantId: string;
}

export interface GetModulePreviewQuery extends ManagementTenantQuery {
  readonly previewRef: string;
}

export interface GetModuleApprovalQuery extends ManagementTenantQuery {
  readonly approvalId: string;
}

export interface GetModuleReleaseQuery extends ManagementTenantQuery {
  readonly releaseId: string;
}

export interface GetModuleReadbackQuery extends ManagementTenantQuery {
  readonly releaseId: string;
}

export interface GetControlIdempotencyQuery extends ManagementTenantQuery {
  readonly action: ModuleControlAction;
  readonly idempotencyKey: string;
}

export interface RegistrationWriteResult {
  readonly record: DeepReadonly<ModuleRegistrationRecord>;
  readonly event: DeepReadonly<ControlEventRecord>;
  readonly replayed: boolean;
}
export interface PreviewWriteResult {
  readonly record: DeepReadonly<ModulePreviewRecord>;
  readonly event: DeepReadonly<ControlEventRecord>;
  readonly replayed: boolean;
}
export interface ApprovalWriteResult {
  readonly record: DeepReadonly<ModuleApprovalRecord>;
  readonly event: DeepReadonly<ControlEventRecord>;
  readonly replayed: boolean;
}
export interface ReleaseWriteResult {
  readonly record: DeepReadonly<ModuleReleaseRecord>;
  readonly event: DeepReadonly<ControlEventRecord>;
  readonly replayed: boolean;
}
export interface ReadbackWriteResult {
  readonly record: DeepReadonly<ModuleReadbackRecord>;
  readonly event: DeepReadonly<ControlEventRecord>;
  readonly replayed: boolean;
}

export interface ModuleControlRepository {
  health(): Promise<{ ready: boolean }>;
  close(): Promise<void>;
  registerModule(
    request: RegisterModuleRecordRequest,
  ): Promise<RegistrationWriteResult>;
  createPreview(request: CreatePreviewRecordRequest): Promise<PreviewWriteResult>;
  decideApproval(
    request: DecideApprovalRecordRequest,
  ): Promise<ApprovalWriteResult>;
  publishRelease(
    request: PublishReleaseRecordRequest,
  ): Promise<ReleaseWriteResult>;
  recordReadback(request: RecordReadbackRequest): Promise<ReadbackWriteResult>;
  completeIdempotency(
    request: CompleteControlIdempotencyRequest,
  ): Promise<DeepReadonly<ControlIdempotencyRecord>>;
  getControlState(): Promise<DeepReadonly<ModuleControlState>>;
  getActiveRelease(): Promise<DeepReadonly<ModuleReleaseRecord> | null>;
  getPendingRelease(): Promise<DeepReadonly<ModuleReleaseRecord> | null>;
  getNewestUnresolvedRelease(): Promise<DeepReadonly<ModuleReleaseRecord> | null>;
  getPreview(
    query: GetModulePreviewQuery,
  ): Promise<DeepReadonly<ModulePreviewRecord> | null>;
  getApproval(
    query: GetModuleApprovalQuery,
  ): Promise<DeepReadonly<ModuleApprovalRecord> | null>;
  getRelease(
    query: GetModuleReleaseQuery,
  ): Promise<DeepReadonly<ModuleReleaseRecord> | null>;
  getReadback(
    query: GetModuleReadbackQuery,
  ): Promise<DeepReadonly<ModuleReadbackRecord> | null>;
  getIdempotency(
    query: GetControlIdempotencyQuery,
  ): Promise<DeepReadonly<ModuleControlIdempotencyRecord> | null>;
}

export function assertControlRequestBinding(input: {
  metadata: ControlRequestMetadata;
  record: ControlRecord;
}): {
  readonly metadata: DeepReadonly<ControlRequestMetadata>;
  readonly record: DeepReadonly<ControlRecord>;
} {
  let metadata: ControlRequestMetadata;
  let record: ControlRecord;
  try {
    metadata = cloneControlValue(
      input.metadata,
      new WeakSet<object>(),
      { nodes: 0 },
      0,
    ) as ControlRequestMetadata;
    record = cloneControlValue(
      input.record,
      new WeakSet<object>(),
      { nodes: 0 },
      0,
    ) as ControlRecord;
    assertMetadata(metadata);
    assertControlRecord(record);
  } catch (error: unknown) {
    if (error instanceof ModuleControlRepositoryError) throw error;
    invalidState();
  }

  if (metadata.action !== metadata.event.action) {
    throw new ModuleControlRepositoryError("conflict");
  }
  if (metadata.managementTenantId !== record.managementTenantId) {
    throw new ModuleControlRepositoryError("tenant_mismatch");
  }

  const event = metadata.event;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
  const finish = (): {
    readonly metadata: DeepReadonly<ControlRequestMetadata>;
    readonly record: DeepReadonly<ControlRecord>;
  } => {
    freezeRecursively(metadata);
    freezeRecursively(record);
    return { metadata, record };
  };

  if (event.kind === "idempotency") {
    if (
      !has("idempotencyKey") ||
      !has("finalResult") ||
      (record as ModuleControlIdempotencyRecord).action !== metadata.action ||
      (record as ModuleControlIdempotencyRecord).idempotencyKey !== metadata.idempotencyKey ||
      (record as ModuleControlIdempotencyRecord).requestHash !== metadata.requestHash ||
      (record as ModuleControlIdempotencyRecord).actorRef !== metadata.actorRef ||
      event.detail.recordRef !== event.objectRef ||
      event.detail.domainRecordRef !==
        (record as ModuleControlIdempotencyRecord).domainRecordRef ||
      event.status !== (record as ModuleControlIdempotencyRecord).status
    ) {
      throw new ModuleControlRepositoryError("conflict");
    }
    return finish();
  }

  if (has("readbackRef") && has("appliedModules")) {
    const readback = record as ModuleReadbackRecord;
    if (
      event.kind !== "reconciliation" ||
      (metadata.action !== "deployments.publish" &&
        metadata.action !== "deployments.reconcile") ||
      event.detail.releaseId !== readback.releaseId ||
      event.detail.revision !== readback.revision ||
      event.detail.readbackRef !== readback.readbackRef ||
      event.objectRef !== readback.releaseId ||
      event.status !== readback.status
    ) {
      throw new ModuleControlRepositoryError("conflict");
    }
    return finish();
  }

  switch (metadata.action) {
    case "packages.register": {
      if (
        !has("registeredByActorRef") ||
        (record as ModuleRegistrationRecord).registeredByActorRef !== metadata.actorRef ||
        event.kind !== "registration" ||
        event.detail.recordRef !== event.objectRef ||
        event.detail.moduleId !== (record as ModuleRegistrationRecord).moduleId ||
        event.detail.version !== (record as ModuleRegistrationRecord).version ||
        event.detail.descriptorDigest !==
          (record as ModuleRegistrationRecord).descriptorDigest
      ) {
        throw new ModuleControlRepositoryError("conflict");
      }
      return finish();
    }
    case "deployments.preview": {
      if (
        !has("previewRef") ||
        !has("creatorActorRef") ||
        (record as ModulePreviewRecord).creatorActorRef !== metadata.actorRef ||
        event.kind !== "preview" ||
        event.detail.previewRef !== (record as ModulePreviewRecord).previewRef ||
        event.detail.previewRef !== event.objectRef ||
        event.detail.baseRevision !== (record as ModulePreviewRecord).baseRevision
      ) {
        throw new ModuleControlRepositoryError("conflict");
      }
      return finish();
    }
    case "approvals.decide": {
      if (
        !has("approvalId") ||
        !has("approverActorRef") ||
        (record as ModuleApprovalRecord).approverActorRef !== metadata.actorRef ||
        event.kind !== "approval" ||
        event.detail.approvalId !== (record as ModuleApprovalRecord).approvalId ||
        event.detail.previewRef !== (record as ModuleApprovalRecord).previewRef ||
        event.objectRef !== (record as ModuleApprovalRecord).approvalId ||
        event.status !==
          ((record as ModuleApprovalRecord).decision === "approve" ? "approved" : "rejected")
      ) {
        throw new ModuleControlRepositoryError("conflict");
      }
      return finish();
    }
    case "deployments.publish": {
      if (
        !has("publisherActorRef") ||
        (record as ModuleReleaseRecord).publisherActorRef !== metadata.actorRef ||
        event.kind !== "release" ||
        event.detail.releaseId !== (record as ModuleReleaseRecord).releaseId ||
        event.detail.revision !== (record as ModuleReleaseRecord).revision ||
        event.objectRef !== (record as ModuleReleaseRecord).releaseId ||
        event.status !== (record as ModuleReleaseRecord).status
      ) {
        throw new ModuleControlRepositoryError("conflict");
      }
      return finish();
    }
    case "deployments.reconcile": {
      throw new ModuleControlRepositoryError("conflict");
    }
    default:
      throw new ModuleControlRepositoryError("conflict");
  }
}

export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

const MAX_CONTROL_RECORD_DEPTH = 64;
const MAX_CONTROL_RECORD_NODES = 100_000;
const MAX_CONTROL_ARRAY_LENGTH = 10_000;
const MAX_CONTROL_STATE_RELEASE_HISTORY = 128;
const MAX_CONTROL_STATE_EVENTS = 256;

interface CloneBudget {
  nodes: number;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function cloneControlValue(
  value: unknown,
  stack: WeakSet<object>,
  budget: CloneBudget,
  depth: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_CONTROL_RECORD_NODES || depth > MAX_CONTROL_RECORD_DEPTH) {
    invalidState();
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!hasWellFormedUnicode(value)) invalidState();
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
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const lengthDescriptor = descriptors["length"];
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
      clone.push(cloneControlValue(descriptor.value, stack, budget, depth + 1));
    }
    stack.delete(value);
    return clone;
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype) invalidState();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const clone = {} as Record<string, unknown>;
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
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneControlValue(descriptor.value, stack, budget, depth + 1),
      writable: true,
    });
  }
  stack.delete(value);
  return clone;
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    invalidState();
  }
  if (nodeUtilTypes.isProxy(value) || Array.isArray(value)) invalidState();
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype) invalidState();
  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some((key) => typeof key !== "string")) invalidState();
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidState();
  }
  return record;
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) invalidState();
}

function assertVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) invalidState();
}

function assertDescriptorDigest(value: unknown): asserts value is DescriptorDigest {
  if (typeof value !== "string" || !DESCRIPTOR_DIGEST_PATTERN.test(value)) invalidState();
}

function assertBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") invalidState();
}

function assertNonnegativeInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidState();
}

function assertPositiveInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidState();
}

function assertTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ADMIN_CONTROL_RFC3339_PATTERN.test(value)) {
    invalidState();
  }
}

function assertNullableIdentifier(value: unknown): void {
  if (value !== null) assertIdentifier(value);
}

function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) {
    invalidState();
  }
  for (const item of value) assertIdentifier(item);
}

function assertModuleRef(value: unknown): void {
  const record = exactKeys(value, ["moduleId", "version", "descriptorDigest"]);
  assertIdentifier(record.moduleId);
  assertVersion(record.version);
  assertDescriptorDigest(record.descriptorDigest);
}

function assertModuleRefArray(value: unknown): asserts value is ModuleControlRef[] {
  if (!Array.isArray(value)) invalidState();
  const seen = new Set<string>();
  for (const item of value) {
    assertModuleRef(item);
    const ref = item as ModuleControlRef;
    const key = `${ref.moduleId}\0${ref.version}\0${ref.descriptorDigest}`;
    if (seen.has(key)) invalidState();
    seen.add(key);
  }
}

function moduleRefArraysEqual(
  left: readonly ModuleControlRef[],
  right: readonly ModuleControlRef[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ref, index) =>
        ref.moduleId === right[index]?.moduleId &&
        ref.version === right[index]?.version &&
        ref.descriptorDigest === right[index]?.descriptorDigest,
    )
  );
}

function moduleRefKey(ref: ModuleControlRef): string {
  return `${ref.moduleId}\0${ref.version}\0${ref.descriptorDigest}`;
}

function moduleRefSetsEqual(
  left: readonly ModuleControlRef[],
  right: readonly ModuleControlRef[],
): boolean {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(moduleRefKey));
  return rightKeys.size === right.length && left.every((ref) => rightKeys.has(moduleRefKey(ref)));
}

export function assertModulePreviewAuthoritySemantics(
  preview: ModulePreviewRecord,
  baseRelease: ModuleReleaseRecord | null,
  rollbackTargetRelease: ModuleReleaseRecord | null,
  releaseHistory: readonly ModuleReleaseHistoryEntry[],
): void {
  if (releaseHistory.length > MAX_CONTROL_STATE_RELEASE_HISTORY) invalidState();
  const historyReleaseIds = new Set<string>();
  const historyRevisions = new Set<number>();
  let previousHistoryRevision: number | null = null;
  for (const entry of releaseHistory) {
    const release = entry.release;
    if (
      release.managementTenantId !== preview.managementTenantId ||
      historyReleaseIds.has(release.releaseId) ||
      historyRevisions.has(release.revision) ||
      (previousHistoryRevision !== null && release.revision >= previousHistoryRevision)
    ) {
      invalidState();
    }
    historyReleaseIds.add(release.releaseId);
    historyRevisions.add(release.revision);
    previousHistoryRevision = release.revision;
  }

  let baseModules: readonly ModuleControlRef[];
  if (preview.baseReleaseId === null) {
    if (preview.baseRevision !== 0 || baseRelease !== null) invalidState();
    baseModules = [];
  } else {
    if (
      baseRelease === null ||
      baseRelease.managementTenantId !== preview.managementTenantId ||
      baseRelease.releaseId !== preview.baseReleaseId ||
      baseRelease.revision !== preview.baseRevision ||
      (baseRelease.status !== "active_verified" &&
        baseRelease.status !== "superseded")
    ) {
      invalidState();
    }
    baseModules = baseRelease.desiredModules;
  }

  const baseKeys = new Set(baseModules.map(moduleRefKey));
  const desiredKeys = new Set(preview.desiredModules.map(moduleRefKey));
  const inventoryKeys = new Set(preview.inventoryRefs.map(moduleRefKey));
  const expectedAdded = preview.desiredModules.filter(
    (ref) => !baseKeys.has(moduleRefKey(ref)),
  );
  const expectedRemoved = baseModules.filter(
    (ref) => !desiredKeys.has(moduleRefKey(ref)),
  );
  const expectedRetained = preview.desiredModules.filter(
    (ref) => baseKeys.has(moduleRefKey(ref)),
  );
  if (
    !moduleRefSetsEqual(preview.diff.added, expectedAdded) ||
    !moduleRefSetsEqual(preview.diff.removed, expectedRemoved) ||
    !moduleRefSetsEqual(preview.diff.retained, expectedRetained)
  ) {
    invalidState();
  }

  const inventoryMatches = preview.desiredModules.every((ref) =>
    inventoryKeys.has(moduleRefKey(ref)),
  );
  const minimumActiveModules = preview.desiredModules.length > 0;
  const validation = preview.validation;
  const allValid =
    validation.baseMatches &&
    validation.desiredModulesValid &&
    validation.inventoryMatches &&
    validation.minimumActiveModules;
  if (
    validation.baseMatches !== true ||
    validation.desiredModulesValid !== true ||
    validation.inventoryMatches !== inventoryMatches ||
    validation.minimumActiveModules !== minimumActiveModules ||
    (validation.reasonCodes.length === 0) !== allValid
  ) {
    invalidState();
  }

  if (preview.intent === "rollback") {
    const boundedTarget = releaseHistory.find(
      (entry) => entry.release.releaseId === preview.targetReleaseId,
    );
    if (
      boundedTarget === undefined ||
      rollbackTargetRelease === null ||
      !isDeepStrictEqual(boundedTarget.release, rollbackTargetRelease) ||
      rollbackTargetRelease.managementTenantId !== preview.managementTenantId ||
      rollbackTargetRelease.releaseId !== preview.targetReleaseId ||
      rollbackTargetRelease.revision >= preview.baseRevision ||
      (rollbackTargetRelease.status !== "active_verified" &&
        rollbackTargetRelease.status !== "superseded") ||
      !moduleRefSetsEqual(
        rollbackTargetRelease.desiredModules,
        preview.desiredModules,
      )
    ) {
      invalidState();
    }
  } else if (rollbackTargetRelease !== null) {
    invalidState();
  }
}

export function assertControlEventInstantOrder(
  previous: ControlEventRecord | null,
  current: ControlEventRecord,
): void {
  if (previous === null) return;
  const comparison = compareRfc3339Instants(
    previous.occurredAt,
    current.occurredAt,
  );
  if (comparison === null || comparison > 0) invalidState();
}

export function resolveMonotonicControlEventOccurredAt(
  authorityAt: string,
  previous: ControlEventRecord | null,
): string {
  assertTimestamp(authorityAt);
  if (previous === null) return authorityAt;
  const comparison = compareRfc3339Instants(
    authorityAt,
    previous.occurredAt,
  );
  if (comparison === null) invalidState();
  return comparison < 0 ? previous.occurredAt : authorityAt;
}

export function createControlEventLifecycleCounts(): ControlEventLifecycleCounts {
  return {
    approval: 0,
    completion: 0,
    preview: 0,
    reconciliation: 0,
    registration: 0,
    release: 0,
  };
}

export function assertControlEventLifecycleCardinality(
  record: ModuleControlIdempotencyRecord,
  counts: ControlEventLifecycleCounts,
): void {
  for (const count of [
    counts.approval,
    counts.completion,
    counts.preview,
    counts.reconciliation,
    counts.registration,
    counts.release,
  ]) {
    assertNonnegativeInteger(count);
  }
  if (record.status === "reserved") {
    if (
      counts.approval !== 0 ||
      counts.completion !== 0 ||
      counts.preview !== 0 ||
      counts.reconciliation !== 0 ||
      counts.registration !== 0 ||
      counts.release !== 0
    ) {
      invalidState();
    }
    return;
  }
  const completionExpected =
    (record.action === "deployments.publish" ||
      record.action === "deployments.reconcile") &&
    record.status === "completed";
  if (
    counts.completion > 1 ||
    (record.status !== "completed" && counts.completion !== 0) ||
    (completionExpected && counts.completion !== 1)
  ) {
    invalidState();
  }
  switch (record.action) {
    case "packages.register":
      if (
        counts.registration !== 1 ||
        counts.preview !== 0 ||
        counts.approval !== 0 ||
        counts.release !== 0 ||
        counts.reconciliation !== 0
      ) {
        invalidState();
      }
      return;
    case "deployments.preview":
      if (
        counts.preview !== 1 ||
        counts.registration !== 0 ||
        counts.approval !== 0 ||
        counts.release !== 0 ||
        counts.reconciliation !== 0
      ) {
        invalidState();
      }
      return;
    case "approvals.decide":
      if (
        counts.approval !== 1 ||
        counts.registration !== 0 ||
        counts.preview !== 0 ||
        counts.release !== 0 ||
        counts.reconciliation !== 0
      ) {
        invalidState();
      }
      return;
    case "deployments.publish":
      if (
        counts.release !== 1 ||
        counts.registration !== 0 ||
        counts.preview !== 0 ||
        counts.approval !== 0 ||
        counts.reconciliation > 1 ||
        (record.status === "completed" && counts.reconciliation !== 1)
      ) {
        invalidState();
      }
      return;
    case "deployments.reconcile":
      if (
        counts.reconciliation !== 1 ||
        counts.registration !== 0 ||
        counts.preview !== 0 ||
        counts.approval !== 0 ||
        counts.release !== 0
      ) {
        invalidState();
      }
      return;
    default:
      invalidState();
  }
}

function assertRegistration(value: unknown): void {
  const record = exactKeys(value, [
    "managementTenantId",
    "moduleId",
    "version",
    "descriptorDigest",
    "evidenceLevel",
    "productionEligible",
    "evidenceRefs",
    "registeredByActorRef",
    "registeredAt",
  ]);
  assertIdentifier(record.managementTenantId);
  assertIdentifier(record.moduleId);
  assertVersion(record.version);
  assertDescriptorDigest(record.descriptorDigest);
  if (record.evidenceLevel !== "local_build" || record.productionEligible !== false) {
    invalidState();
  }
  const evidenceRefs = exactKeys(record.evidenceRefs, [
    "sourceShaRef",
    "artifactDigestRef",
    "signatureRef",
    "sbomRef",
    "attestationRef",
  ]);
  for (const evidence of Object.values(evidenceRefs)) {
    if (evidence !== null) assertIdentifier(evidence);
  }
  assertIdentifier(record.registeredByActorRef);
  assertTimestamp(record.registeredAt);
}

function assertPreview(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidState();
  const candidate = value as Record<string, unknown>;
  const keys = [
    "managementTenantId",
    "previewRef",
    "canonicalHash",
    "baseReleaseId",
    "baseRevision",
    "inventoryRefs",
    "desiredModules",
    "diff",
    "validation",
    "creatorActorRef",
    "createdAt",
    "expiresAt",
    "consumed",
    "intent",
  ];
  if (candidate.intent === "rollback") keys.push("targetReleaseId");
  const record = exactKeys(value, keys);
  assertIdentifier(record.managementTenantId);
  assertIdentifier(record.previewRef);
  assertPreviewHash(record.canonicalHash);
  assertNullableIdentifier(record.baseReleaseId);
  assertNonnegativeInteger(record.baseRevision);
  assertModuleRefArray(record.inventoryRefs);
  assertModuleRefArray(record.desiredModules);
  const diff = exactKeys(record.diff, ["added", "removed", "retained"]);
  assertModuleRefArray(diff.added);
  assertModuleRefArray(diff.removed);
  assertModuleRefArray(diff.retained);
  const validation = exactKeys(record.validation, [
    "baseMatches",
    "desiredModulesValid",
    "inventoryMatches",
    "minimumActiveModules",
    "reasonCodes",
  ]);
  assertBoolean(validation.baseMatches);
  assertBoolean(validation.desiredModulesValid);
  assertBoolean(validation.inventoryMatches);
  assertBoolean(validation.minimumActiveModules);
  assertStringArray(validation.reasonCodes);
  if (record.intent !== "change" && record.intent !== "rollback") invalidState();
  if (record.intent === "rollback") assertIdentifier(record.targetReleaseId);
  assertIdentifier(record.creatorActorRef);
  assertTimestamp(record.createdAt);
  assertTimestamp(record.expiresAt);
  if (compareRfc3339Instants(record.createdAt, record.expiresAt) !== -1) {
    invalidState();
  }
  assertBoolean(record.consumed);
}

function assertApproval(value: unknown): void {
  const record = exactKeys(value, [
    "managementTenantId",
    "approvalId",
    "previewRef",
    "decision",
    "previewCanonicalHash",
    "baseReleaseId",
    "baseRevision",
    "inventoryDigestSet",
    "expiresAt",
    "reasonCode",
    "approverActorRef",
    "decidedAt",
    "consumed",
  ]);
  assertIdentifier(record.managementTenantId);
  assertIdentifier(record.approvalId);
  assertIdentifier(record.previewRef);
  if (record.decision !== "approve" && record.decision !== "reject") invalidState();
  assertPreviewHash(record.previewCanonicalHash);
  assertNullableIdentifier(record.baseReleaseId);
  assertNonnegativeInteger(record.baseRevision);
  if (!Array.isArray(record.inventoryDigestSet)) invalidState();
  const digests = new Set<string>();
  for (const digest of record.inventoryDigestSet) {
    assertDescriptorDigest(digest);
    if (digests.has(digest)) invalidState();
    digests.add(digest);
  }
  assertTimestamp(record.expiresAt);
  assertIdentifier(record.reasonCode);
  assertIdentifier(record.approverActorRef);
  assertTimestamp(record.decidedAt);
  assertBoolean(record.consumed);
  if (record.decision === "reject" && record.consumed) invalidState();
}

function assertRelease(value: unknown): void {
  const record = exactKeys(value, [
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
  ]);
  assertIdentifier(record.managementTenantId);
  assertIdentifier(record.releaseId);
  assertPositiveInteger(record.revision);
  assertModuleRefArray(record.desiredModules);
  assertNullableIdentifier(record.previousReleaseId);
  assertIdentifier(record.previewRef);
  assertIdentifier(record.approvalId);
  assertIdentifier(record.publisherActorRef);
  assertTimestamp(record.createdAt);
  if (record.publishedAt !== null) assertTimestamp(record.publishedAt);
  if (record.publishedAt !== null) {
    const publicationComparison = compareRfc3339Instants(
      record.createdAt,
      record.publishedAt,
    );
    if (publicationComparison === null || publicationComparison === 1) {
      invalidState();
    }
  }
  assertStringArray(record.reasonCodes);
  if (
    record.status !== "published_pending_readback" &&
    record.publishedAt === null
  ) {
    invalidState();
  }
  switch (record.status) {
    case "published_pending_readback":
      if (
        record.readbackRef !== null ||
        record.reasonCodes.length !== 0 ||
        record.supersededByReleaseId !== null
      ) {
        invalidState();
      }
      break;
    case "manual_review":
      assertIdentifier(record.readbackRef);
      if (record.reasonCodes.length === 0 || record.supersededByReleaseId !== null) {
        invalidState();
      }
      break;
    case "active_verified":
      assertIdentifier(record.readbackRef);
      if (record.reasonCodes.length !== 0 || record.supersededByReleaseId !== null) {
        invalidState();
      }
      break;
    case "superseded":
      assertIdentifier(record.readbackRef);
      assertIdentifier(record.supersededByReleaseId);
      if (record.reasonCodes.length !== 0) invalidState();
      break;
    default:
      invalidState();
  }
}

function assertReleaseHistoryEntry(
  value: unknown,
): ModuleReleaseHistoryEntry {
  const record = exactKeys(value, [
    "release",
    "intent",
    "rollbackTargetReleaseId",
  ]);
  assertRelease(record.release);
  const release = record.release as ModuleReleaseRecord;
  if (record.intent === "change") {
    if (record.rollbackTargetReleaseId !== null) invalidState();
    return {
      release,
      intent: "change",
      rollbackTargetReleaseId: null,
    };
  }
  if (record.intent === "rollback") {
    assertIdentifier(record.rollbackTargetReleaseId);
    if (record.rollbackTargetReleaseId === release.releaseId) invalidState();
    return {
      release,
      intent: "rollback",
      rollbackTargetReleaseId: record.rollbackTargetReleaseId,
    };
  }
  invalidState();
}

function assertReadback(value: unknown): void {
  const record = exactKeys(value, [
    "managementTenantId",
    "readbackRef",
    "releaseId",
    "revision",
    "appliedReleaseId",
    "appliedRevision",
    "appliedModules",
    "status",
    "reasonCodes",
    "checkedAt",
  ]);
  assertIdentifier(record.managementTenantId);
  assertIdentifier(record.readbackRef);
  assertIdentifier(record.releaseId);
  assertPositiveInteger(record.revision);
  assertModuleRefArray(record.appliedModules);
  assertStringArray(record.reasonCodes);
  assertTimestamp(record.checkedAt);
  switch (record.status) {
    case "pending":
      if (
        record.appliedReleaseId !== null ||
        record.appliedRevision !== null ||
        record.reasonCodes.length !== 0
      ) {
        invalidState();
      }
      break;
    case "verified":
      assertIdentifier(record.appliedReleaseId);
      assertPositiveInteger(record.appliedRevision);
      if (
        record.appliedReleaseId !== record.releaseId ||
        record.appliedRevision !== record.revision ||
        record.reasonCodes.length !== 0
      ) {
        invalidState();
      }
      break;
    case "mismatch":
    case "unknown": {
      const bothNull = record.appliedReleaseId === null && record.appliedRevision === null;
      const bothPresent =
        typeof record.appliedReleaseId === "string" &&
        Number.isSafeInteger(record.appliedRevision) &&
        (record.appliedRevision as number) >= 0;
      if ((!bothNull && !bothPresent) || record.reasonCodes.length === 0) invalidState();
      if (bothPresent) assertIdentifier(record.appliedReleaseId);
      break;
    }
    default:
      invalidState();
  }
}

function assertFinalResult(
  value: unknown,
  action?: ModuleControlAction,
  expectedDomainRecordRef?: string,
): void {
  const record = exactKeys(value, ["domainRecordRef", "envelope"]);
  assertIdentifier(record.domainRecordRef);
  const parsed = controlEnvelopeSchema.safeParse(record.envelope);
  if (!parsed.success) invalidState();
  if (
    expectedDomainRecordRef !== undefined &&
    record.domainRecordRef !== expectedDomainRecordRef
  ) {
    invalidState();
  }
  if (action === undefined) return;

  const data = parsed.data.data;
  switch (action) {
    case "packages.register":
      if (
        data?.kind !== "registration" ||
        data.module_id === undefined ||
        data.version === undefined ||
        data.descriptor_digest === undefined ||
        record.domainRecordRef !==
          `registration:${data.module_id}:${data.version}:${data.descriptor_digest}`
      ) {
        invalidState();
      }
      break;
    case "deployments.preview":
      if (data?.kind !== "preview" || data.preview_ref !== record.domainRecordRef) {
        invalidState();
      }
      break;
    case "approvals.decide":
      if (data?.kind !== "approval" || data.approval_id !== record.domainRecordRef) {
        invalidState();
      }
      break;
    case "deployments.publish":
      if (
        data?.kind !== "release" ||
        data.release_id !== record.domainRecordRef ||
        data.revision === undefined
      ) {
        invalidState();
      }
      break;
    case "deployments.reconcile":
      if (
        data?.kind !== "reconciliation" ||
        data.release_id !== record.domainRecordRef ||
        data.revision === undefined ||
        data.status === undefined
      ) {
        invalidState();
      }
      break;
  }

  if (action === "deployments.publish" || action === "deployments.reconcile") {
    if (
      data === null ||
      !("revision" in data) ||
      data.revision === undefined ||
      parsed.data.readback.release_id !== record.domainRecordRef ||
      parsed.data.readback.revision !== data.revision
    ) {
      invalidState();
    }
    if (
      (parsed.data.status === "success" && parsed.data.readback.status !== "verified") ||
      (parsed.data.status === "manual_review" &&
        parsed.data.readback.status !== "mismatch" &&
        parsed.data.readback.status !== "unknown") ||
      (parsed.data.status !== "success" && parsed.data.status !== "manual_review")
    ) {
      invalidState();
    }
    if (
      action === "deployments.reconcile" &&
      data.kind === "reconciliation" &&
      data.status !== parsed.data.readback.status
    ) {
      invalidState();
    }
  }
}

function assertIdempotency(value: unknown): void {
  const record = exactKeys(value, [
    "managementTenantId",
    "action",
    "idempotencyKey",
    "requestHash",
    "actorRef",
    "status",
    "domainRecordRef",
    "finalResult",
    "createdAt",
    "expiresAt",
  ]);
  assertIdentifier(record.managementTenantId);
  if (!isModuleControlAction(record.action)) invalidState();
  assertIdentifier(record.idempotencyKey);
  assertRequestHash(record.requestHash);
  assertIdentifier(record.actorRef);
  assertTimestamp(record.createdAt);
  assertTimestamp(record.expiresAt);
  if (compareRfc3339Instants(record.createdAt, record.expiresAt) !== -1) {
    invalidState();
  }
  if (record.status === "reserved") {
    if (record.domainRecordRef !== null || record.finalResult !== null) invalidState();
  } else if (record.status === "domain_committed") {
    assertIdentifier(record.domainRecordRef);
    if (record.finalResult !== null) invalidState();
  } else if (record.status === "completed") {
    assertIdentifier(record.domainRecordRef);
    assertFinalResult(record.finalResult, record.action, record.domainRecordRef);
  } else {
    invalidState();
  }
}

function assertControlEventFields(record: Record<string, unknown>): void {
  if (!isModuleControlAction(record.action)) invalidState();
  assertIdentifier(record.objectRef);
  assertStringArray(record.reasonCodes);
  const detailKeys: Readonly<Record<string, readonly string[]>> = {
    registration: [
      "kind",
      "recordRef",
      "moduleId",
      "version",
      "descriptorDigest",
      "status",
    ],
    preview: ["kind", "previewRef", "baseRevision", "status"],
    approval: ["kind", "approvalId", "previewRef", "status"],
    release: ["kind", "releaseId", "revision", "status"],
    reconciliation: [
      "kind",
      "releaseId",
      "revision",
      "readbackRef",
      "status",
    ],
    idempotency: [
      "kind",
      "recordRef",
      "domainRecordRef",
      "status",
    ],
  };
  if (typeof record.kind !== "string" || detailKeys[record.kind] === undefined) {
    invalidState();
  }
  const detail = exactKeys(record.detail, detailKeys[record.kind]!);
  if (detail.kind !== record.kind || detail.status !== record.status) invalidState();
  switch (record.kind) {
    case "registration":
      if (record.action !== "packages.register" || record.status !== "registered") {
        invalidState();
      }
      assertIdentifier(detail.recordRef);
      assertIdentifier(detail.moduleId);
      assertVersion(detail.version);
      assertDescriptorDigest(detail.descriptorDigest);
      break;
    case "preview":
      if (record.action !== "deployments.preview" || record.status !== "previewed") {
        invalidState();
      }
      assertIdentifier(detail.previewRef);
      assertNonnegativeInteger(detail.baseRevision);
      break;
    case "approval":
      if (
        record.action !== "approvals.decide" ||
        (record.status !== "approved" && record.status !== "rejected")
      ) {
        invalidState();
      }
      assertIdentifier(detail.approvalId);
      assertIdentifier(detail.previewRef);
      break;
    case "release":
      if (
        record.action !== "deployments.publish" ||
        !MODULE_RELEASE_STATUSES.includes(record.status as ModuleReleaseStatus)
      ) {
        invalidState();
      }
      assertIdentifier(detail.releaseId);
      assertPositiveInteger(detail.revision);
      break;
    case "reconciliation":
      if (
        (record.action !== "deployments.publish" &&
          record.action !== "deployments.reconcile") ||
        !MODULE_READBACK_STATUSES.includes(record.status as ModuleReadbackStatus)
      ) {
        invalidState();
      }
      assertIdentifier(detail.releaseId);
      assertPositiveInteger(detail.revision);
      assertIdentifier(detail.readbackRef);
      break;
    case "idempotency":
      if (!CONTROL_IDEMPOTENCY_STATUSES.includes(record.status as ControlIdempotencyStatus)) {
        invalidState();
      }
      assertIdentifier(detail.recordRef);
      assertNullableIdentifier(detail.domainRecordRef);
      break;
    default:
      invalidState();
  }
}

function assertEventInput(value: unknown): void {
  const record = exactKeys(value, [
    "action",
    "objectRef",
    "kind",
    "status",
    "reasonCodes",
    "detail",
  ]);
  assertControlEventFields(record);
}

function assertMetadata(value: unknown): void {
  const record = exactKeys(value, [
    "managementTenantId",
    "actorRef",
    "action",
    "idempotencyKey",
    "requestHash",
    "event",
  ]);
  assertIdentifier(record.managementTenantId);
  assertIdentifier(record.actorRef);
  if (!isModuleControlAction(record.action)) invalidState();
  assertIdentifier(record.idempotencyKey);
  assertRequestHash(record.requestHash);
  assertEventInput(record.event);
}

function assertEvent(value: unknown): void {
  const record = exactKeys(value, [
    "managementTenantId",
    "eventId",
    "sequence",
    "actorRef",
    "action",
    "objectRef",
    "kind",
    "status",
    "reasonCodes",
    "detail",
    "occurredAt",
  ]);
  assertIdentifier(record.managementTenantId);
  assertIdentifier(record.eventId);
  assertPositiveInteger(record.sequence);
  assertIdentifier(record.actorRef);
  assertTimestamp(record.occurredAt);
  assertControlEventFields(record);
}

function assertControlState(value: unknown): void {
  const record = exactKeys(value, [
    "managementTenantId",
    "activeRelease",
    "activeRevision",
    "activeModules",
    "registrations",
    "latestPreview",
    "latestApproval",
    "latestReadback",
    "releaseHistory",
    "events",
    "eventsTruncated",
  ]);
  assertIdentifier(record.managementTenantId);
  assertNonnegativeInteger(record.activeRevision);
  assertModuleRefArray(record.activeModules);
  if (
    !Array.isArray(record.registrations) ||
    !Array.isArray(record.releaseHistory) ||
    !Array.isArray(record.events)
  ) {
    invalidState();
  }
  assertBoolean(record.eventsTruncated);
  for (const item of record.registrations) {
    assertRegistration(item);
    if ((item as ModuleRegistrationRecord).managementTenantId !== record.managementTenantId) {
      invalidState();
    }
  }

  if (record.releaseHistory.length > MAX_CONTROL_STATE_RELEASE_HISTORY) {
    invalidState();
  }
  const releaseHistory = record.releaseHistory.map((item) =>
    assertReleaseHistoryEntry(item),
  );
  const releaseIds = new Set<string>();
  const releaseRevisions = new Set<number>();
  for (const entry of releaseHistory) {
    const release = entry.release;
    if (
      release.managementTenantId !== record.managementTenantId ||
      releaseIds.has(release.releaseId) ||
      releaseRevisions.has(release.revision) ||
      release.previousReleaseId === release.releaseId
    ) {
      invalidState();
    }
    releaseIds.add(release.releaseId);
    releaseRevisions.add(release.revision);
  }
  if (releaseHistory[0]?.release.status === "superseded") invalidState();
  for (let index = 1; index < releaseHistory.length; index += 1) {
    const newer = releaseHistory[index - 1]!.release;
    const older = releaseHistory[index]!.release;
    if (
      newer.revision !== older.revision + 1 ||
      newer.previousReleaseId !== older.releaseId
    ) {
      invalidState();
    }
    if (
      index === 1 &&
      (newer.status === "published_pending_readback" ||
        newer.status === "manual_review")
    ) {
      if (
        older.status !== "active_verified" ||
        older.supersededByReleaseId !== null
      ) {
        invalidState();
      }
    } else if (
      older.status !== "superseded" ||
      older.supersededByReleaseId !== newer.releaseId
    ) {
      invalidState();
    }
  }
  const oldestRelease = releaseHistory.at(-1)?.release;
  if (oldestRelease !== undefined) {
    if (
      (oldestRelease.revision === 1 && oldestRelease.previousReleaseId !== null) ||
      (oldestRelease.revision > 1 && oldestRelease.previousReleaseId === null)
    ) {
      invalidState();
    }
  }
  const activeHistory = releaseHistory.filter(
    (entry) => entry.release.status === "active_verified",
  );
  const unresolvedHistory = releaseHistory.filter(
    (entry) =>
      entry.release.status === "published_pending_readback" ||
      entry.release.status === "manual_review",
  );
  if (activeHistory.length > 1 || unresolvedHistory.length > 1) invalidState();
  for (const entry of releaseHistory) {
    if (entry.intent !== "rollback") continue;
    const target = releaseHistory.find(
      (candidate) =>
        candidate.release.releaseId === entry.rollbackTargetReleaseId,
    );
    if (
      target !== undefined &&
      target.release.revision >= entry.release.revision
    ) {
      invalidState();
    }
  }

  if (!Array.isArray(record.events) || record.events.length > MAX_CONTROL_STATE_EVENTS) {
    invalidState();
  }
  const eventIds = new Set<string>();
  let previousSequence: number | null = null;
  let previousEvent: ControlEventRecord | null = null;
  for (const item of record.events) {
    assertEvent(item);
    const event = item as ControlEventRecord;
    if (
      event.managementTenantId !== record.managementTenantId ||
      eventIds.has(event.eventId) ||
      (previousSequence !== null && event.sequence !== previousSequence + 1)
    ) {
      invalidState();
    }
    assertControlEventInstantOrder(previousEvent, event);
    eventIds.add(event.eventId);
    previousSequence = event.sequence;
    previousEvent = event;
  }
  if (record.events.length === 0) {
    if (record.eventsTruncated) invalidState();
  } else if (record.eventsTruncated) {
    if (
      record.events.length !== MAX_CONTROL_STATE_EVENTS ||
      (record.events[0] as ControlEventRecord).sequence <= 1
    ) {
      invalidState();
    }
  } else if ((record.events[0] as ControlEventRecord).sequence !== 1) {
    invalidState();
  }
  if (record.activeRelease === null) {
    if (
      record.activeRevision !== 0 ||
      record.activeModules.length !== 0 ||
      activeHistory.length !== 0
    ) {
      invalidState();
    }
  } else {
    assertRelease(record.activeRelease);
    const activeRelease = record.activeRelease as ModuleReleaseRecord;
    if (
      activeRelease.managementTenantId !== record.managementTenantId ||
      activeRelease.status !== "active_verified" ||
      activeRelease.revision !== record.activeRevision ||
      !moduleRefArraysEqual(activeRelease.desiredModules, record.activeModules) ||
      activeHistory.length !== 1 ||
      !isDeepStrictEqual(activeHistory[0]!.release, activeRelease)
    ) {
      invalidState();
    }
  }
  if (record.latestPreview !== null) {
    assertPreview(record.latestPreview);
    if ((record.latestPreview as ModulePreviewRecord).managementTenantId !== record.managementTenantId) {
      invalidState();
    }
  }
  if (record.latestApproval !== null) {
    assertApproval(record.latestApproval);
    if ((record.latestApproval as ModuleApprovalRecord).managementTenantId !== record.managementTenantId) {
      invalidState();
    }
  }
  if (record.latestReadback !== null) {
    assertReadback(record.latestReadback);
    if ((record.latestReadback as ModuleReadbackRecord).managementTenantId !== record.managementTenantId) {
      invalidState();
    }
  }
  if (record.latestPreview !== null) {
    const latestPreview = record.latestPreview as ModulePreviewRecord;
    for (const entry of releaseHistory) {
      if (entry.release.previewRef !== latestPreview.previewRef) continue;
      const expectedTarget =
        latestPreview.intent === "rollback"
          ? latestPreview.targetReleaseId
          : null;
      if (
        entry.intent !== latestPreview.intent ||
        entry.rollbackTargetReleaseId !== expectedTarget
      ) {
        invalidState();
      }
    }
  }
}

function assertControlRecord(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidState();
  }
  const record = value as Record<string, unknown>;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
  if (has("activeModules") && has("registrations")) {
    assertControlState(record);
  } else if (has("eventId") && has("detail")) {
    assertEvent(record);
  } else if (has("idempotencyKey") && has("finalResult")) {
    assertIdempotency(record);
  } else if (has("readbackRef") && has("appliedModules")) {
    assertReadback(record);
  } else if (has("releaseId") && has("publisherActorRef")) {
    assertRelease(record);
  } else if (has("approvalId") && has("decision")) {
    assertApproval(record);
  } else if (has("previewRef") && has("intent")) {
    assertPreview(record);
  } else if (has("moduleId") && has("evidenceRefs")) {
    assertRegistration(record);
  } else {
    invalidState();
  }
}

function freezeRecursively(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const key of Reflect.ownKeys(value)) {
    freezeRecursively(Reflect.get(value, key));
  }
  Object.freeze(value);
}

export function deepFreezeControlRecord<T extends ControlRecord>(
  record: T,
): DeepReadonly<T> {
  let clone: unknown;
  try {
    clone = cloneControlValue(record, new WeakSet<object>(), { nodes: 0 }, 0);
    assertControlRecord(clone);
    freezeRecursively(clone);
  } catch (error: unknown) {
    if (error instanceof ModuleControlRepositoryError) throw error;
    invalidState();
  }
  return clone as DeepReadonly<T>;
}
