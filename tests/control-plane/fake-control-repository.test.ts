import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ModuleControlRepositoryError,
} from "../../src/logistics_mcp/control-plane/repository";
import {
  initializeSqliteControlState,
  openSqliteControlStore,
} from "../../src/logistics_mcp/control-plane/sqlite-control-store";
import { addRfc3339Milliseconds } from "../../src/logistics_mcp/control-plane/rfc3339-instant";
import type { ApprovalControlEventInput } from "../../src/logistics_mcp/control-plane/repository";
import type {
  ClaimReadbackAttemptRequest,
  ControlEnvelope,
  ControlEventRecord,
  ControlFinalResult,
  ControlIdempotencyEventMetadata,
  CreatePreviewRecordRequest,
  DecideApprovalRecordRequest,
  DomainCommittedModuleControlIdempotencyRecord,
  GetControlIdempotencyQuery,
  GetModuleApprovalQuery,
  GetModulePreviewQuery,
  GetModuleReadbackQuery,
  GetModuleReleaseQuery,
  ModuleActiveVerifiedReleaseRecord,
  ModuleApprovalRecord,
  ModuleChangePreviewRecord,
  ModuleControlIdempotencyRecord,
  ModuleControlRepository,
  FinalizeReadbackAndCompleteRequest,
  ModuleControlRef,
  ModuleControlReadbackAttemptRepository,
  ModuleManualReviewReleaseRecord,
  ModulePendingReadbackRecord,
  ModulePendingReleaseRecord,
  ModuleReadbackRecord,
  ModuleRegistrationRecord,
  ModuleReleaseRecord,
  ModuleRollbackPreviewRecord,
  ReservedModuleControlIdempotencyRecord,
  ModuleUnknownReadbackRecord,
  ModuleVerifiedReadbackRecord,
  ReadbackAttemptObservation,
  ReadbackAttemptOwnerCapability,
  PublishReadbackRequestMetadata,
  PublishReleaseRecordRequest,
  ReconcileRequestMetadata,
  RegisterModuleRecordRequest,
  RegisterModuleRequestMetadata,
} from "../../src/logistics_mcp/control-plane/repository";
import {
  FAKE_CONTROL_REPOSITORY_FAILURE_PHASES,
  FAKE_CONTROL_REPOSITORY_METHOD_NAMES,
  FAKE_READBACK_ATTEMPT_FAILURE_PHASES,
  createFakeModuleControlRepositoryWithRecovery,
  FakeModuleControlRepository,
} from "./fake-control-repository";
import type { FakeModuleControlRepositoryRecords } from "./fake-control-repository";

type ReadbackFixtureRequest = {
  readonly metadata: ReconcileRequestMetadata | PublishReadbackRequestMetadata;
  readonly record: ModuleReadbackRecord;
};

type IdempotencyEventFixture = {
  readonly metadata: ControlIdempotencyEventMetadata;
  readonly record: ModuleControlIdempotencyRecord;
};

const MANAGEMENT_TENANT_ID = "tenant_demo";
const OTHER_TENANT_ID = "tenant_other";
const RECOVERY_ACTOR_REF = "system_startup_recovery";
const DESCRIPTOR_DIGEST = `sha256:${"b".repeat(64)}` as const;
const SECOND_DESCRIPTOR_DIGEST = `sha256:${"c".repeat(64)}` as const;
const REQUEST_HASH =
  `mcp-control-hash/v1/request/sha256:${"a".repeat(64)}` as const;
const PREVIEW_HASH =
  `mcp-control-hash/v1/preview/sha256:${"d".repeat(64)}` as const;

const moduleRef = {
  moduleId: "cargo",
  version: "1.0.0",
  descriptorDigest: DESCRIPTOR_DIGEST,
} as const satisfies ModuleControlRef;

const secondModuleRef = {
  moduleId: "container",
  version: "1.0.0",
  descriptorDigest: SECOND_DESCRIPTOR_DIGEST,
} as const satisfies ModuleControlRef;

const registrationRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  moduleId: moduleRef.moduleId,
  version: moduleRef.version,
  descriptorDigest: moduleRef.descriptorDigest,
  evidenceLevel: "local_build",
  productionEligible: false,
  evidenceRefs: {
    sourceShaRef: null,
    artifactDigestRef: null,
    signatureRef: null,
    sbomRef: null,
    attestationRef: null,
  },
  registeredByActorRef: "actor_operator",
  registeredAt: "2026-08-22T00:00:00Z",
} as const satisfies ModuleRegistrationRecord;

const changePreview = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  previewRef: "preview_change_001",
  canonicalHash: PREVIEW_HASH,
  baseReleaseId: null,
  baseRevision: 0,
  inventoryRefs: [moduleRef],
  desiredModules: [moduleRef],
  diff: { added: [moduleRef], removed: [], retained: [] },
  validation: {
    baseMatches: true,
    desiredModulesValid: true,
    inventoryMatches: true,
    minimumActiveModules: true,
    reasonCodes: [],
  },
  creatorActorRef: "actor_operator",
  createdAt: "2026-08-22T00:00:00Z",
  expiresAt: "2026-08-22T01:00:00Z",
  consumed: false,
  intent: "change",
} as const satisfies ModuleChangePreviewRecord;

const approvalRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  approvalId: "approval_001",
  previewRef: changePreview.previewRef,
  decision: "approve",
  previewCanonicalHash: changePreview.canonicalHash,
  baseReleaseId: null,
  baseRevision: 0,
  inventoryDigestSet: [DESCRIPTOR_DIGEST],
  expiresAt: changePreview.expiresAt,
  reasonCode: "approved",
  approverActorRef: "actor_approver",
  decidedAt: "2026-08-22T00:05:00Z",
  consumed: false,
} as const satisfies ModuleApprovalRecord;

const activeRelease = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  releaseId: "release_active_001",
  revision: 1,
  desiredModules: [moduleRef],
  previousReleaseId: null,
  previewRef: changePreview.previewRef,
  approvalId: approvalRecord.approvalId,
  publisherActorRef: "actor_publisher",
  createdAt: "2026-08-22T00:06:00Z",
  publishedAt: "2026-08-22T00:07:00Z",
  status: "active_verified",
  readbackRef: "readback_active_001",
  reasonCodes: [],
  supersededByReleaseId: null,
} as const satisfies ModuleActiveVerifiedReleaseRecord;

const pendingRelease = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  releaseId: "release_pending_002",
  revision: 1,
  desiredModules: [moduleRef],
  previousReleaseId: null,
  previewRef: changePreview.previewRef,
  approvalId: approvalRecord.approvalId,
  publisherActorRef: "actor_publisher",
  createdAt: "2026-08-22T00:08:00Z",
  publishedAt: "2026-08-22T00:09:00Z",
  status: "published_pending_readback",
  readbackRef: null,
  reasonCodes: [],
  supersededByReleaseId: null,
} as const satisfies ModulePendingReleaseRecord;

const manualReviewRelease = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  releaseId: pendingRelease.releaseId,
  revision: pendingRelease.revision,
  desiredModules: pendingRelease.desiredModules,
  previousReleaseId: pendingRelease.previousReleaseId,
  previewRef: pendingRelease.previewRef,
  approvalId: pendingRelease.approvalId,
  publisherActorRef: "actor_publisher",
  createdAt: "2026-08-22T00:10:00Z",
  publishedAt: "2026-08-22T00:11:00Z",
  status: "manual_review",
  readbackRef: "readback_manual_003",
  reasonCodes: ["runtime.unavailable"],
  supersededByReleaseId: null,
} as const satisfies ModuleManualReviewReleaseRecord;

const verifiedReadback = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  readbackRef: activeRelease.readbackRef,
  releaseId: activeRelease.releaseId,
  revision: activeRelease.revision,
  appliedReleaseId: activeRelease.releaseId,
  appliedRevision: activeRelease.revision,
  appliedModules: [moduleRef],
  status: "verified",
  reasonCodes: [],
  checkedAt: "2026-08-22T00:07:30Z",
} as const satisfies ModuleVerifiedReadbackRecord;

const pendingReadback = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  readbackRef: "readback_pending_002",
  releaseId: pendingRelease.releaseId,
  revision: pendingRelease.revision,
  appliedReleaseId: null,
  appliedRevision: null,
  appliedModules: [],
  status: "pending",
  reasonCodes: [],
  checkedAt: "2026-08-22T00:09:30Z",
} as const satisfies ModulePendingReadbackRecord;

const unknownReadback = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  readbackRef: manualReviewRelease.readbackRef,
  releaseId: manualReviewRelease.releaseId,
  revision: manualReviewRelease.revision,
  appliedReleaseId: null,
  appliedRevision: null,
  appliedModules: [],
  status: "unknown",
  reasonCodes: ["runtime.unavailable"],
  checkedAt: "2026-08-22T00:11:30Z",
} as const satisfies ModuleUnknownReadbackRecord;

const registrationRef =
  `registration:${registrationRecord.moduleId}:${registrationRecord.version}:${registrationRecord.descriptorDigest}`;

const registrationEnvelope = {
  schema_version: "2026-08-22.v1",
  request_id: "request_registration_001",
  trace_id: "trace_registration_001",
  audit_id: "audit_registration_001",
  status: "success",
  data: {
    kind: "registration",
    module_id: registrationRecord.moduleId,
    version: registrationRecord.version,
    descriptor_digest: registrationRecord.descriptorDigest,
  },
  reason_codes: [],
  readback: { status: "not_applicable", release_id: null, revision: null },
} as const satisfies ControlEnvelope;

const registrationFinalResult = {
  domainRecordRef: registrationRef,
  envelope: registrationEnvelope,
} as const satisfies ControlFinalResult;

const registrationEventInput = {
  action: "packages.register",
  objectRef: registrationRef,
  kind: "registration",
  status: "registered",
  reasonCodes: [],
  detail: {
    kind: "registration",
    recordRef: registrationRef,
    moduleId: registrationRecord.moduleId,
    version: registrationRecord.version,
    descriptorDigest: registrationRecord.descriptorDigest,
    status: "registered",
  },
} as const satisfies RegisterModuleRequestMetadata["event"];

const registerRequest = {
  metadata: {
    managementTenantId: MANAGEMENT_TENANT_ID,
    actorRef: "actor_operator",
    action: "packages.register",
    idempotencyKey: "idem_register_001",
    requestHash: REQUEST_HASH,
    event: registrationEventInput,
  },
  record: registrationRecord,
  finalResult: registrationFinalResult,
} as const satisfies RegisterModuleRecordRequest;

const previewEventInput = {
  action: "deployments.preview",
  objectRef: changePreview.previewRef,
  kind: "preview",
  status: "previewed",
  reasonCodes: [],
  detail: {
    kind: "preview",
    previewRef: changePreview.previewRef,
    baseRevision: changePreview.baseRevision,
    status: "previewed",
  },
} as const;

const previewRequest = {
  metadata: {
    managementTenantId: MANAGEMENT_TENANT_ID,
    actorRef: "actor_operator",
    action: "deployments.preview",
    idempotencyKey: "idem_preview_001",
    requestHash: REQUEST_HASH,
    event: previewEventInput,
  },
  record: changePreview,
  finalResult: {
    domainRecordRef: changePreview.previewRef,
    envelope: {
      schema_version: "2026-08-22.v1",
      request_id: "request_preview_001",
      trace_id: "trace_preview_001",
      audit_id: "audit_preview_001",
      status: "success",
      data: {
        kind: "preview",
        preview_ref: changePreview.previewRef,
        intent: changePreview.intent,
        base_release_id: changePreview.baseReleaseId,
        base_revision: changePreview.baseRevision,
        desired_modules: changePreview.desiredModules.map((ref) => ({
          module_id: ref.moduleId,
          version: ref.version,
          descriptor_digest: ref.descriptorDigest,
        })),
        target_release_id: null,
        expires_at: changePreview.expiresAt,
      },
      reason_codes: [],
      readback: { status: "not_applicable", release_id: null, revision: null },
    } satisfies ControlEnvelope,
  },
} as const satisfies CreatePreviewRecordRequest;

const approvalEventInput = {
  action: "approvals.decide",
  objectRef: approvalRecord.approvalId,
  kind: "approval",
  status: "approved",
  reasonCodes: [],
  detail: {
    kind: "approval",
    approvalId: approvalRecord.approvalId,
    previewRef: approvalRecord.previewRef,
    status: "approved",
  },
} as const satisfies ApprovalControlEventInput;

const approvalRequest = {
  metadata: {
    managementTenantId: MANAGEMENT_TENANT_ID,
    actorRef: approvalRecord.approverActorRef,
    action: "approvals.decide",
    idempotencyKey: "idem_approval_001",
    requestHash: REQUEST_HASH,
    event: approvalEventInput,
  },
  record: approvalRecord,
  finalResult: {
    domainRecordRef: approvalRecord.approvalId,
    envelope: {
      schema_version: "2026-08-22.v1",
      request_id: "request_approval_001",
      trace_id: "trace_approval_001",
      audit_id: "audit_approval_001",
      status: "success",
      data: {
        kind: "approval",
        approval_id: approvalRecord.approvalId,
        preview_ref: approvalRecord.previewRef,
        decision: approvalRecord.decision,
      },
      reason_codes: [],
      readback: { status: "not_applicable", release_id: null, revision: null },
    } satisfies ControlEnvelope,
  },
} as const satisfies DecideApprovalRecordRequest;

const publishEventInput = {
  action: "deployments.publish",
  objectRef: pendingRelease.releaseId,
  kind: "release",
  status: "published_pending_readback",
  reasonCodes: [],
  detail: {
    kind: "release",
    releaseId: pendingRelease.releaseId,
    revision: pendingRelease.revision,
    status: pendingRelease.status,
  },
} as const;

const publishRequest = {
  metadata: {
    managementTenantId: MANAGEMENT_TENANT_ID,
    actorRef: pendingRelease.publisherActorRef,
    action: "deployments.publish",
    idempotencyKey: "idem_publish_001",
    requestHash: REQUEST_HASH,
    event: publishEventInput,
  },
  record: pendingRelease,
} as const satisfies PublishReleaseRecordRequest;

const readbackEventInput = {
  action: "deployments.publish",
  objectRef: pendingRelease.releaseId,
  kind: "reconciliation",
  status: "verified",
  reasonCodes: [],
  detail: {
    kind: "reconciliation",
    releaseId: pendingRelease.releaseId,
    revision: pendingRelease.revision,
    readbackRef: "readback_pending_verified_002",
    status: "verified",
  },
} as const satisfies PublishReadbackRequestMetadata["event"];

const readbackForPublishedRelease = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  readbackRef: "readback_pending_verified_002",
  releaseId: pendingRelease.releaseId,
  revision: pendingRelease.revision,
  appliedReleaseId: pendingRelease.releaseId,
  appliedRevision: pendingRelease.revision,
  appliedModules: pendingRelease.desiredModules,
  status: "verified",
  reasonCodes: [],
  checkedAt: "2026-08-22T00:12:00Z",
} as const satisfies ModuleVerifiedReadbackRecord;

const readbackRequest = {
  metadata: {
    managementTenantId: MANAGEMENT_TENANT_ID,
    actorRef: "actor_publisher",
    action: "deployments.publish",
    idempotencyKey: "idem_readback_001",
    requestHash: REQUEST_HASH,
    event: readbackEventInput,
  },
  record: readbackForPublishedRelease,
} as const satisfies ReadbackFixtureRequest;

const sameKeyReadbackRequest = {
  ...readbackRequest,
  metadata: {
    ...readbackRequest.metadata,
    idempotencyKey: publishRequest.metadata.idempotencyKey,
  },
} as const satisfies ReadbackFixtureRequest;

const reconcileReadbackEventInput = {
  action: "deployments.reconcile",
  objectRef: pendingRelease.releaseId,
  kind: "reconciliation",
  status: "verified",
  reasonCodes: [],
  detail: {
    kind: "reconciliation",
    releaseId: pendingRelease.releaseId,
    revision: pendingRelease.revision,
    readbackRef: readbackForPublishedRelease.readbackRef,
    status: "verified",
  },
} as const satisfies ReconcileRequestMetadata["event"];

const reconcileReadbackRequest = {
  metadata: {
    managementTenantId: MANAGEMENT_TENANT_ID,
    actorRef: "actor_reconciler",
    action: "deployments.reconcile",
    idempotencyKey: "idem_reconcile_001",
    requestHash: REQUEST_HASH,
    event: reconcileReadbackEventInput,
  },
  record: readbackForPublishedRelease,
} as const satisfies ReadbackFixtureRequest;

const publishFinalResult = {
  domainRecordRef: pendingRelease.releaseId,
  envelope: {
    schema_version: "2026-08-22.v1",
    request_id: "request_publish_001",
    trace_id: "trace_publish_001",
    audit_id: "audit_publish_001",
    status: "success",
    data: {
      kind: "release",
      release_id: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      active_modules: pendingRelease.desiredModules.map((ref) => ({
        module_id: ref.moduleId,
        version: ref.version,
        descriptor_digest: ref.descriptorDigest,
      })),
    },
    reason_codes: [],
    readback: {
      status: "verified",
      release_id: pendingRelease.releaseId,
      revision: pendingRelease.revision,
    },
  } satisfies ControlEnvelope,
} as const satisfies ControlFinalResult;

const publishDomainCommittedIdempotencyRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  action: publishRequest.metadata.action,
  idempotencyKey: publishRequest.metadata.idempotencyKey,
  requestHash: publishRequest.metadata.requestHash,
  actorRef: pendingRelease.publisherActorRef,
  status: "domain_committed",
  domainRecordRef: pendingRelease.releaseId,
  finalResult: null,
  createdAt: pendingRelease.createdAt,
  expiresAt: "2026-08-23T00:08:00Z",
} as const satisfies DomainCommittedModuleControlIdempotencyRecord;

const publishCompletionEventInput = {
  action: "deployments.publish",
  objectRef: `idempotency:${publishRequest.metadata.action}:${publishRequest.metadata.idempotencyKey}`,
  kind: "idempotency",
  status: "completed",
  reasonCodes: [],
  detail: {
    kind: "idempotency",
    recordRef: `idempotency:${publishRequest.metadata.action}:${publishRequest.metadata.idempotencyKey}`,
    domainRecordRef: pendingRelease.releaseId,
    status: "completed",
  },
} as const;

const publishCompletionRequest = {
  metadata: {
    managementTenantId: MANAGEMENT_TENANT_ID,
    actorRef: pendingRelease.publisherActorRef,
    action: "deployments.publish",
    idempotencyKey: publishRequest.metadata.idempotencyKey,
    requestHash: publishRequest.metadata.requestHash,
    event: publishCompletionEventInput,
  },
  record: {
    ...publishDomainCommittedIdempotencyRecord,
    status: "completed",
    finalResult: publishFinalResult,
  },
} as const satisfies IdempotencyEventFixture;

const completedIdempotencyRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  action: "packages.register",
  idempotencyKey: registerRequest.metadata.idempotencyKey,
  requestHash: registerRequest.metadata.requestHash,
  actorRef: registrationRecord.registeredByActorRef,
  status: "completed",
  domainRecordRef: registrationRef,
  finalResult: registrationFinalResult,
  createdAt: "2026-08-22T00:00:00Z",
  expiresAt: "2026-08-23T00:00:00Z",
} as const satisfies ModuleControlIdempotencyRecord;

const reservedIdempotencyRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  action: registerRequest.metadata.action,
  idempotencyKey: registerRequest.metadata.idempotencyKey,
  requestHash: registerRequest.metadata.requestHash,
  actorRef: registrationRecord.registeredByActorRef,
  status: "reserved",
  domainRecordRef: null,
  finalResult: null,
  createdAt: registrationRecord.registeredAt,
  expiresAt: "2026-08-23T00:00:00Z",
} as const satisfies ReservedModuleControlIdempotencyRecord;

const registrationEvent = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  eventId: "event_registration_001",
  sequence: 1,
  actorRef: "actor_operator",
  ...registrationEventInput,
  occurredAt: registrationRecord.registeredAt,
} as const satisfies ControlEventRecord;

const previewSeedIdempotency = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  action: "deployments.preview",
  idempotencyKey: previewRequest.metadata.idempotencyKey,
  requestHash: previewRequest.metadata.requestHash,
  actorRef: changePreview.creatorActorRef,
  status: "completed",
  domainRecordRef: changePreview.previewRef,
  finalResult: previewRequest.finalResult,
  createdAt: changePreview.createdAt,
  expiresAt: "2026-08-23T00:00:00Z",
} as const satisfies ModuleControlIdempotencyRecord;

const previewSeedEvent = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  eventId: "event_preview_seed_001",
  sequence: 1,
  actorRef: changePreview.creatorActorRef,
  ...previewEventInput,
  occurredAt: changePreview.createdAt,
} as const satisfies ControlEventRecord;

const approvalSeedIdempotency = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  action: "approvals.decide",
  idempotencyKey: approvalRequest.metadata.idempotencyKey,
  requestHash: approvalRequest.metadata.requestHash,
  actorRef: approvalRecord.approverActorRef,
  status: "completed",
  domainRecordRef: approvalRecord.approvalId,
  finalResult: approvalRequest.finalResult,
  createdAt: approvalRecord.decidedAt,
  expiresAt: "2026-08-23T00:05:00Z",
} as const satisfies ModuleControlIdempotencyRecord;

const approvalSeedEvent = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  eventId: "event_approval_seed_002",
  sequence: 2,
  actorRef: approvalRecord.approverActorRef,
  ...approvalEventInput,
  occurredAt: approvalRecord.decidedAt,
} as const satisfies ControlEventRecord;

const activePublishIdempotency = {
  ...publishDomainCommittedIdempotencyRecord,
  actorRef: activeRelease.publisherActorRef,
  idempotencyKey: "idem_publish_active_001",
  domainRecordRef: activeRelease.releaseId,
  createdAt: activeRelease.createdAt,
  expiresAt: "2026-08-23T00:06:00Z",
} as const satisfies DomainCommittedModuleControlIdempotencyRecord;

const activePublishEvent = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  eventId: "event_active_publish_001",
  sequence: 2,
  actorRef: activeRelease.publisherActorRef,
  ...publishEventInput,
  objectRef: activeRelease.releaseId,
  detail: {
    ...publishEventInput.detail,
    releaseId: activeRelease.releaseId,
    revision: activeRelease.revision,
  },
  occurredAt: activeRelease.createdAt,
} as const satisfies ControlEventRecord;

const activeReadbackEvent = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  eventId: "event_active_readback_002",
  sequence: 3,
  actorRef: activeRelease.publisherActorRef,
  ...readbackEventInput,
  objectRef: activeRelease.releaseId,
  detail: {
    ...readbackEventInput.detail,
    releaseId: activeRelease.releaseId,
    revision: activeRelease.revision,
    readbackRef: activeRelease.readbackRef,
  },
  occurredAt: verifiedReadback.checkedAt,
} as const satisfies ControlEventRecord;

const pendingReadbackEvent = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  eventId: "event_pending_readback_002",
  sequence: 2,
  actorRef: pendingRelease.publisherActorRef,
  ...readbackEventInput,
  status: "pending",
  detail: {
    ...readbackEventInput.detail,
    readbackRef: pendingReadback.readbackRef,
    status: "pending",
  },
  occurredAt: pendingReadback.checkedAt,
} as const satisfies ControlEventRecord;

const manualPublishIdempotency = {
  ...publishDomainCommittedIdempotencyRecord,
  actorRef: manualReviewRelease.publisherActorRef,
  idempotencyKey: "idem_publish_manual_003",
  domainRecordRef: manualReviewRelease.releaseId,
  createdAt: manualReviewRelease.createdAt,
  expiresAt: "2026-08-23T00:10:00Z",
} as const satisfies DomainCommittedModuleControlIdempotencyRecord;

const manualPublishEvent = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  eventId: "event_manual_publish_001",
  sequence: 1,
  actorRef: manualReviewRelease.publisherActorRef,
  ...publishEventInput,
  objectRef: manualReviewRelease.releaseId,
  detail: {
    ...publishEventInput.detail,
    releaseId: manualReviewRelease.releaseId,
    revision: manualReviewRelease.revision,
  },
  occurredAt: manualReviewRelease.createdAt,
} as const satisfies ControlEventRecord;

const manualReadbackEvent = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  eventId: "event_manual_readback_002",
  sequence: 2,
  actorRef: manualReviewRelease.publisherActorRef,
  ...readbackEventInput,
  status: "unknown",
  reasonCodes: unknownReadback.reasonCodes,
  objectRef: manualReviewRelease.releaseId,
  detail: {
    ...readbackEventInput.detail,
    releaseId: manualReviewRelease.releaseId,
    revision: manualReviewRelease.revision,
    readbackRef: unknownReadback.readbackRef,
    status: "unknown",
  },
  occurredAt: unknownReadback.checkedAt,
} as const satisfies ControlEventRecord;

const secondRegistrationRecord = {
  ...registrationRecord,
  moduleId: secondModuleRef.moduleId,
  version: secondModuleRef.version,
  descriptorDigest: secondModuleRef.descriptorDigest,
} as const satisfies ModuleRegistrationRecord;

const secondRegistrationRef =
  `registration:${secondRegistrationRecord.moduleId}:${secondRegistrationRecord.version}:${secondRegistrationRecord.descriptorDigest}`;

const secondCompletedIdempotencyRecord = {
  ...completedIdempotencyRecord,
  idempotencyKey: "idem_register_002",
  domainRecordRef: secondRegistrationRef,
  finalResult: {
    domainRecordRef: secondRegistrationRef,
    envelope: {
      ...registrationEnvelope,
      data: {
        ...registrationEnvelope.data,
        module_id: secondRegistrationRecord.moduleId,
        version: secondRegistrationRecord.version,
        descriptor_digest: secondRegistrationRecord.descriptorDigest,
      },
    },
  },
} as const satisfies ModuleControlIdempotencyRecord;

const tiedPreview = {
  ...changePreview,
  previewRef: "preview_change_999",
} as const satisfies ModuleChangePreviewRecord;

const tiedApproval = {
  ...approvalRecord,
  approvalId: "approval_999",
  previewRef: tiedPreview.previewRef,
  previewCanonicalHash: tiedPreview.canonicalHash,
} as const satisfies ModuleApprovalRecord;

const secondEvent = {
  ...registrationEvent,
  eventId: "event_registration_002",
  sequence: 2,
  objectRef: secondRegistrationRef,
  detail: {
    ...registrationEvent.detail,
    recordRef: secondRegistrationRef,
    moduleId: secondRegistrationRecord.moduleId,
    version: secondRegistrationRecord.version,
    descriptorDigest: secondRegistrationRecord.descriptorDigest,
  },
  occurredAt: registrationRecord.registeredAt,
} as const satisfies ControlEventRecord;

const thirdEvent = {
  ...registrationEvent,
  eventId: "event_registration_completion_003",
  sequence: 3,
  objectRef: `idempotency:packages.register:${completedIdempotencyRecord.idempotencyKey}`,
  kind: "idempotency",
  status: "completed",
  detail: {
    kind: "idempotency",
    recordRef: `idempotency:packages.register:${completedIdempotencyRecord.idempotencyKey}`,
    domainRecordRef: registrationRef,
    status: "completed",
  },
  occurredAt: registrationRecord.registeredAt,
} as const satisfies ControlEventRecord;

const seedRecords = {
  registrations: [registrationRecord],
  previews: [{ ...changePreview, consumed: true }],
  approvals: [{ ...approvalRecord, consumed: true }],
  releases: [activeRelease],
  readbacks: [verifiedReadback],
  idempotency: [completedIdempotencyRecord, activePublishIdempotency],
  events: [registrationEvent, activePublishEvent, activeReadbackEvent],
} as const;

const orderingRecords = {
  registrations: [secondRegistrationRecord, registrationRecord],
  previews: [tiedPreview, changePreview],
  approvals: [tiedApproval, approvalRecord],
  idempotency: [secondCompletedIdempotencyRecord, completedIdempotencyRecord],
  events: [thirdEvent, registrationEvent, secondEvent],
} as const satisfies FakeModuleControlRepositoryRecords;

function validReleaseChainRecords(): FakeModuleControlRepositoryRecords {
  const supersededRelease = {
    ...activeRelease,
    status: "superseded",
    supersededByReleaseId: "release_chain_002",
  } as const;
  const chainPreview = {
    ...changePreview,
    previewRef: "preview_chain_002",
    baseReleaseId: activeRelease.releaseId,
    baseRevision: activeRelease.revision,
    inventoryRefs: [moduleRef, secondModuleRef],
    desiredModules: [secondModuleRef],
    diff: {
      added: [secondModuleRef],
      removed: [moduleRef],
      retained: [],
    },
    creatorActorRef: "actor_operator_2",
    createdAt: "2026-08-22T00:08:00Z",
    expiresAt: "2026-08-22T02:00:00Z",
    consumed: true,
  } as const satisfies ModuleChangePreviewRecord;
  const chainApproval = {
    ...approvalRecord,
    approvalId: "approval_chain_002",
    previewRef: chainPreview.previewRef,
    previewCanonicalHash: chainPreview.canonicalHash,
    baseReleaseId: chainPreview.baseReleaseId,
    baseRevision: chainPreview.baseRevision,
    inventoryDigestSet: [DESCRIPTOR_DIGEST, SECOND_DESCRIPTOR_DIGEST],
    expiresAt: chainPreview.expiresAt,
    approverActorRef: "actor_approver_2",
    decidedAt: "2026-08-22T00:09:00Z",
    consumed: true,
  } as const satisfies ModuleApprovalRecord;
  const chainRelease = {
    ...pendingRelease,
    releaseId: "release_chain_002",
    revision: 2,
    desiredModules: [secondModuleRef],
    previousReleaseId: activeRelease.releaseId,
    previewRef: chainPreview.previewRef,
    approvalId: chainApproval.approvalId,
    publisherActorRef: "actor_publisher_2",
    createdAt: "2026-08-22T00:10:00Z",
    publishedAt: "2026-08-22T00:11:00Z",
    status: "active_verified",
    readbackRef: "readback_chain_002",
  } as const satisfies ModuleActiveVerifiedReleaseRecord;
  const chainReadback = {
    ...verifiedReadback,
    readbackRef: chainRelease.readbackRef,
    releaseId: chainRelease.releaseId,
    revision: chainRelease.revision,
    appliedReleaseId: chainRelease.releaseId,
    appliedRevision: chainRelease.revision,
    appliedModules: chainRelease.desiredModules,
    checkedAt: "2026-08-22T00:11:30Z",
  } as const satisfies ModuleVerifiedReadbackRecord;
  const firstPublishIdempotency = {
    ...publishDomainCommittedIdempotencyRecord,
    actorRef: activeRelease.publisherActorRef,
    idempotencyKey: "idem_publish_chain_001",
    domainRecordRef: activeRelease.releaseId,
    createdAt: activeRelease.createdAt,
    expiresAt: "2026-08-23T00:06:00Z",
  } as const satisfies DomainCommittedModuleControlIdempotencyRecord;
  const secondPublishIdempotency = {
    ...publishDomainCommittedIdempotencyRecord,
    actorRef: chainRelease.publisherActorRef,
    idempotencyKey: "idem_publish_chain_002",
    domainRecordRef: chainRelease.releaseId,
    createdAt: chainRelease.createdAt,
    expiresAt: "2026-08-23T00:10:00Z",
  } as const satisfies DomainCommittedModuleControlIdempotencyRecord;
  const firstPublishEvent = {
    managementTenantId: MANAGEMENT_TENANT_ID,
    eventId: "event_chain_publish_001",
    sequence: 1,
    actorRef: activeRelease.publisherActorRef,
    ...publishEventInput,
    objectRef: activeRelease.releaseId,
    detail: {
      ...publishEventInput.detail,
      releaseId: activeRelease.releaseId,
      revision: activeRelease.revision,
    },
    occurredAt: activeRelease.createdAt,
  } as const satisfies ControlEventRecord;
  const firstReadbackEvent = {
    managementTenantId: MANAGEMENT_TENANT_ID,
    eventId: "event_chain_readback_001",
    sequence: 2,
    actorRef: activeRelease.publisherActorRef,
    ...readbackEventInput,
    objectRef: activeRelease.releaseId,
    detail: {
      ...readbackEventInput.detail,
      releaseId: activeRelease.releaseId,
      revision: activeRelease.revision,
      readbackRef: activeRelease.readbackRef,
    },
    occurredAt: verifiedReadback.checkedAt,
  } as const satisfies ControlEventRecord;
  const secondPublishEvent = {
    ...firstPublishEvent,
    eventId: "event_chain_publish_002",
    sequence: 3,
    actorRef: chainRelease.publisherActorRef,
    objectRef: chainRelease.releaseId,
    detail: {
      ...firstPublishEvent.detail,
      releaseId: chainRelease.releaseId,
      revision: chainRelease.revision,
    },
    occurredAt: chainRelease.createdAt,
  } as const satisfies ControlEventRecord;
  const secondReadbackEvent = {
    ...firstReadbackEvent,
    eventId: "event_chain_readback_002",
    sequence: 4,
    actorRef: chainRelease.publisherActorRef,
    objectRef: chainRelease.releaseId,
    detail: {
      ...firstReadbackEvent.detail,
      releaseId: chainRelease.releaseId,
      revision: chainRelease.revision,
      readbackRef: chainRelease.readbackRef,
    },
    occurredAt: chainReadback.checkedAt,
  } as const satisfies ControlEventRecord;

  return {
    previews: [{ ...changePreview, consumed: true }, chainPreview],
    approvals: [{ ...approvalRecord, consumed: true }, chainApproval],
    releases: [supersededRelease, chainRelease],
    readbacks: [verifiedReadback, chainReadback],
    idempotency: [firstPublishIdempotency, secondPublishIdempotency],
    events: [firstPublishEvent, firstReadbackEvent, secondPublishEvent, secondReadbackEvent],
  };
}

function newRepository(
  records: FakeModuleControlRepositoryRecords | undefined = undefined,
): FakeModuleControlRepository {
  return new FakeModuleControlRepository({
    managementTenantId: MANAGEMENT_TENANT_ID,
    ...(records === undefined ? {} : { records }),
  });
}

function validPendingAuthorityGraph(
  release: ModulePendingReleaseRecord = pendingRelease,
): FakeModuleControlRepositoryRecords {
  const publishAuthority = {
    ...publishDomainCommittedIdempotencyRecord,
    actorRef: release.publisherActorRef,
    domainRecordRef: release.releaseId,
    createdAt: release.createdAt,
    expiresAt: "2026-08-23T00:08:00Z",
  } as const satisfies DomainCommittedModuleControlIdempotencyRecord;
  const publishEvent = {
    managementTenantId: MANAGEMENT_TENANT_ID,
    eventId: "event_publish_seed_003",
    sequence: 3,
    actorRef: release.publisherActorRef,
    ...publishEventInput,
    objectRef: release.releaseId,
    detail: {
      ...publishEventInput.detail,
      releaseId: release.releaseId,
      revision: release.revision,
    },
    occurredAt: release.createdAt,
  } as const satisfies ControlEventRecord;
  return {
    previews: [{ ...changePreview, consumed: true }],
    approvals: [{ ...approvalRecord, consumed: true }],
    releases: [release],
    idempotency: [previewSeedIdempotency, approvalSeedIdempotency, publishAuthority],
    events: [previewSeedEvent, approvalSeedEvent, publishEvent],
  };
}

function ambiguousReconcileSeedRecords(
  explicitBindings: boolean,
): FakeModuleControlRepositoryRecords {
  const reconcileRecords = ["001", "002"].map((suffix) => ({
    managementTenantId: MANAGEMENT_TENANT_ID,
    action: "deployments.reconcile",
    idempotencyKey: `idem_reconcile_seed_${suffix}`,
    requestHash: REQUEST_HASH,
    actorRef: "actor_reconciler",
    status: "completed",
    domainRecordRef: activeRelease.releaseId,
    finalResult: {
      domainRecordRef: activeRelease.releaseId,
      envelope: {
        ...publishFinalResult.envelope,
        request_id: `request_reconcile_seed_${suffix}`,
        trace_id: `trace_reconcile_seed_${suffix}`,
        audit_id: `audit_reconcile_seed_${suffix}`,
        data: {
          kind: "reconciliation",
          release_id: activeRelease.releaseId,
          revision: activeRelease.revision,
          status: "verified",
        },
        readback: {
          status: "verified",
          release_id: activeRelease.releaseId,
          revision: activeRelease.revision,
        },
      },
    },
    createdAt: verifiedReadback.checkedAt,
    expiresAt: "2026-08-23T00:07:30Z",
  } as const satisfies ModuleControlIdempotencyRecord));
  const reconcileEvents = reconcileRecords.flatMap((record, index) => {
    const sequence = index * 2 + 4;
    const reconciliationEvent = {
      ...activeReadbackEvent,
      eventId: `event_reconcile_seed_${index + 4}`,
      sequence,
      actorRef: record.actorRef,
      action: "deployments.reconcile",
      detail: {
        ...activeReadbackEvent.detail,
        readbackRef: verifiedReadback.readbackRef,
      },
    } as const satisfies ControlEventRecord;
    const completionEvent = {
      ...reconciliationEvent,
      eventId: `event_reconcile_completion_seed_${index + 5}`,
      sequence: sequence + 1,
      kind: "idempotency",
      objectRef: `idempotency:deployments.reconcile:${record.idempotencyKey}`,
      status: "completed",
      detail: {
        kind: "idempotency",
        recordRef: `idempotency:deployments.reconcile:${record.idempotencyKey}`,
        domainRecordRef: activeRelease.releaseId,
        status: "completed",
      },
      occurredAt: verifiedReadback.checkedAt,
    } as const satisfies ControlEventRecord;
    return [reconciliationEvent, completionEvent];
  });
  const records = {
    ...seedRecords,
    idempotency: [...seedRecords.idempotency, ...reconcileRecords],
    events: [...seedRecords.events, ...reconcileEvents],
  } as FakeModuleControlRepositoryRecords;
  if (explicitBindings) {
    Reflect.set(records, "eventAuthorities", reconcileEvents.map((event, index) => ({
      eventId: event.eventId,
      action: "deployments.reconcile",
      idempotencyKey: reconcileRecords[Math.floor(index / 2)]!.idempotencyKey,
      requestHash: REQUEST_HASH,
    })));
  }
  return records;
}

function registrationEventHistory(
  count: number,
): FakeModuleControlRepositoryRecords {
  const registrations: ModuleRegistrationRecord[] = [];
  const idempotency: ModuleControlIdempotencyRecord[] = [];
  const events: ControlEventRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const moduleId = `window_module_${index + 1}`;
    const record = {
      ...registrationRecord,
      moduleId,
    } as ModuleRegistrationRecord;
    const recordRef =
      `registration:${record.moduleId}:${record.version}:${record.descriptorDigest}`;
    registrations.push(record);
    idempotency.push({
      ...completedIdempotencyRecord,
      idempotencyKey: `idem_window_${index + 1}`,
      domainRecordRef: recordRef,
      finalResult: {
        domainRecordRef: recordRef,
        envelope: {
          ...registrationEnvelope,
          data: {
            ...registrationEnvelope.data,
            module_id: record.moduleId,
          },
        },
      },
    });
    events.push({
      ...registrationEvent,
      eventId: `event_window_${index + 1}`,
      sequence: index + 1,
      objectRef: recordRef,
      detail: {
        ...registrationEvent.detail,
        recordRef,
        moduleId: record.moduleId,
      },
    });
  }
  return { registrations, idempotency, events };
}

function boundaryHistoryRepository(
  releaseCount: number,
): FakeModuleControlRepository {
  const previews: ModuleChangePreviewRecord[] = [];
  const approvals: ModuleApprovalRecord[] = [];
  const releases: ModuleReleaseRecord[] = [];
  const readbacks: ModuleReadbackRecord[] = [];
  const idempotency: ModuleControlIdempotencyRecord[] = [];
  const events: ControlEventRecord[] = [];
  for (let revision = 1; revision <= releaseCount; revision += 1) {
    const releaseId = `release_boundary_${revision}`;
    const previousReleaseId = revision === 1
      ? null
      : `release_boundary_${revision - 1}`;
    const previewRef = `preview_boundary_${revision}`;
    const readbackRef = `readback_boundary_${revision}`;
    const createdAt = new Date(
      Date.UTC(2026, 7, 22, 0, 0, (revision - 1) * 3 + 1),
    ).toISOString();
    const publishedAt = new Date(
      Date.UTC(2026, 7, 22, 0, 0, (revision - 1) * 3 + 2),
    ).toISOString();
    const checkedAt = new Date(
      Date.UTC(2026, 7, 22, 0, 0, (revision - 1) * 3 + 3),
    ).toISOString();
    const release = {
      ...activeRelease,
      releaseId,
      revision,
      previousReleaseId,
      previewRef,
      approvalId: `approval_boundary_${revision}`,
      createdAt,
      publishedAt,
      status: revision === releaseCount ? "active_verified" : "superseded",
      readbackRef,
      supersededByReleaseId: revision === releaseCount
        ? null
        : `release_boundary_${revision + 1}`,
    } as ModuleReleaseRecord;
    const preview = {
      ...changePreview,
      previewRef,
      baseReleaseId: previousReleaseId,
      baseRevision: revision - 1,
      inventoryRefs: revision === 1
        ? [moduleRef]
        : [moduleRef, secondModuleRef],
      diff: revision === 1
        ? { added: [moduleRef], removed: [], retained: [] }
        : { added: [], removed: [], retained: [moduleRef] },
      createdAt,
      expiresAt: "2026-08-23T00:00:00Z",
      consumed: true,
    } as ModuleChangePreviewRecord;
    const approval = {
      ...approvalRecord,
      approvalId: `approval_boundary_${revision}`,
      previewRef,
      previewCanonicalHash: preview.canonicalHash,
      baseReleaseId: previousReleaseId,
      baseRevision: revision - 1,
      inventoryDigestSet: revision === 1
        ? [DESCRIPTOR_DIGEST]
        : [DESCRIPTOR_DIGEST, SECOND_DESCRIPTOR_DIGEST],
      expiresAt: preview.expiresAt,
      decidedAt: publishedAt,
      consumed: true,
    } as ModuleApprovalRecord;
    const readback = {
      ...verifiedReadback,
      readbackRef,
      releaseId,
      revision,
      appliedReleaseId: releaseId,
      appliedRevision: revision,
      checkedAt,
    } as ModuleReadbackRecord;
    const idempotencyExpiresAt = addRfc3339Milliseconds(
      release.createdAt,
      86_400_000n,
    );
    if (idempotencyExpiresAt === null) throw new Error("boundary expiry is invalid");
    const publishAuthority = {
      ...publishDomainCommittedIdempotencyRecord,
      idempotencyKey: `idem_boundary_publish_${revision}`,
      actorRef: release.publisherActorRef,
      domainRecordRef: release.releaseId,
      createdAt: release.createdAt,
      expiresAt: idempotencyExpiresAt,
    } as ModuleControlIdempotencyRecord;
    const publishEvent = {
      ...activePublishEvent,
      eventId: `event_boundary_publish_${revision}`,
      sequence: (revision - 1) * 2 + 1,
      actorRef: release.publisherActorRef,
      objectRef: release.releaseId,
      detail: {
        ...activePublishEvent.detail,
        releaseId: release.releaseId,
        revision: release.revision,
      },
      occurredAt: release.createdAt,
    } as ControlEventRecord;
    const readbackEvent = {
      ...activeReadbackEvent,
      eventId: `event_boundary_readback_${revision}`,
      sequence: (revision - 1) * 2 + 2,
      actorRef: release.publisherActorRef,
      objectRef: release.releaseId,
      detail: {
        ...activeReadbackEvent.detail,
        releaseId: release.releaseId,
        revision: release.revision,
        readbackRef: readback.readbackRef,
      },
      occurredAt: readback.checkedAt,
    } as ControlEventRecord;
    previews.push(preview);
    approvals.push(approval);
    releases.push(release);
    readbacks.push(readback);
    idempotency.push(publishAuthority);
    events.push(publishEvent, readbackEvent);
  }
  return newRepository({ previews, approvals, releases, readbacks, idempotency, events });
}

async function repositoryResultCode(
  operation: () => Promise<unknown>,
): Promise<ModuleControlRepositoryError["code"] | "resolved"> {
  try {
    await operation();
    return "resolved";
  } catch (error: unknown) {
    if (error instanceof ModuleControlRepositoryError) return error.code;
    throw error;
  }
}

function exactPreviewQuery(
  tenantId: string = MANAGEMENT_TENANT_ID,
  previewRef: string = changePreview.previewRef,
): GetModulePreviewQuery {
  return { managementTenantId: tenantId, previewRef };
}

function exactApprovalQuery(
  tenantId: string = MANAGEMENT_TENANT_ID,
): GetModuleApprovalQuery {
  return { managementTenantId: tenantId, approvalId: approvalRecord.approvalId };
}

function exactReleaseQuery(
  tenantId: string = MANAGEMENT_TENANT_ID,
  releaseId: string = activeRelease.releaseId,
): GetModuleReleaseQuery {
  return { managementTenantId: tenantId, releaseId };
}

function exactReadbackQuery(
  tenantId: string = MANAGEMENT_TENANT_ID,
  releaseId: string = activeRelease.releaseId,
): GetModuleReadbackQuery {
  return { managementTenantId: tenantId, releaseId };
}

function exactIdempotencyQuery(
  tenantId: string = MANAGEMENT_TENANT_ID,
): GetControlIdempotencyQuery {
  return {
    managementTenantId: tenantId,
    action: completedIdempotencyRecord.action,
    idempotencyKey: completedIdempotencyRecord.idempotencyKey,
  };
}

function attemptClaimRequest(
  overrides: Partial<ClaimReadbackAttemptRequest> = {},
): ClaimReadbackAttemptRequest {
  return {
    metadata: {
      managementTenantId: MANAGEMENT_TENANT_ID,
      actorRef: pendingRelease.publisherActorRef,
      action: "deployments.publish",
      idempotencyKey: publishRequest.metadata.idempotencyKey,
      requestHash: REQUEST_HASH,
      requestId: "request_publish_001",
      traceId: "trace_publish_001",
      auditId: "audit_publish_001",
    },
    attemptId: "attempt_publish_001",
    readbackRef: "readback_attempt_publish_001",
    releaseId: pendingRelease.releaseId,
    revision: pendingRelease.revision,
    desiredModules: pendingRelease.desiredModules,
    ownerBootId: "boot_current",
    claimedAt: "2026-08-22T00:12:00.000000000Z",
    ...overrides,
  };
}

const verifiedAttemptObservation: ReadbackAttemptObservation = {
  status: "verified",
  appliedReleaseId: pendingRelease.releaseId,
  appliedRevision: pendingRelease.revision,
  appliedModules: pendingRelease.desiredModules,
  reasonCodes: [],
  checkedAt: "2026-08-22T00:12:00.000000000Z",
};

describe("FakeModuleControlRepository", () => {
  it("does not expose legacy readback or idempotency write entries after claim", async () => {
    const repository = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
      records: validPendingAuthorityGraph(),
    });
    const claim = await repository.claimReadbackAttempt(attemptClaimRequest());
    expect(claim.disposition).toBe("created");

    const legacyNames = ["recordReadback", "completeIdempotency"] as const;
    const reflectedKeys = new Set<PropertyKey>();
    let cursor: object | null = repository;
    while (cursor !== null) {
      for (const key of Reflect.ownKeys(cursor)) reflectedKeys.add(key);
      cursor = Reflect.getPrototypeOf(cursor);
    }
    const escaped = repository as unknown as Record<string, unknown>;
    for (const legacyName of legacyNames) {
      expect(legacyName in repository).toBe(false);
      expect(reflectedKeys.has(legacyName)).toBe(false);
      expect(escaped[legacyName]).toBeUndefined();
    }
  });

  it("claims and atomically finalizes a terminal attempt without a pending projection", async () => {
    const repository = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
      clock: () => "2026-08-22T00:12:00.000000000Z",
      records: validPendingAuthorityGraph(),
    });
    const claim = await repository.claimReadbackAttempt(attemptClaimRequest());
    expect(claim.disposition).toBe("created");
    if (claim.disposition !== "created") throw new Error("claim was not created");
    expect((await repository.getControlState()).latestReadback).toBeNull();
    expect(Object.isFrozen(claim.attempt)).toBe(true);
    expect(Object.getPrototypeOf(claim.ownerCapability)).toBeNull();
    expect(
      repository.calls.some(
        (call) => (call.method as string) === "claimReadbackAttempt",
      ),
    ).toBe(false);

    const replay = await repository.claimReadbackAttempt(attemptClaimRequest());
    expect(replay).toMatchObject({ disposition: "existing" });
    if (replay.disposition !== "existing") throw new Error("claim did not replay");
    expect(replay.attempt).toEqual(claim.attempt);
    await expect(
      repository.claimReadbackAttempt({
        ...attemptClaimRequest(),
        metadata: {
          ...attemptClaimRequest().metadata,
          requestHash: `mcp-control-hash/v1/request/sha256:${"c".repeat(64)}`,
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const finalizeRequest: FinalizeReadbackAndCompleteRequest = {
      attemptId: claim.attempt.attemptId,
      ownerCapability: claim.ownerCapability,
      observation: verifiedAttemptObservation,
      finalResult: publishFinalResult,
      finalizedAt: "2026-08-22T00:12:00.000000000Z",
    };
    const finalized = await repository.finalizeReadbackAndComplete(finalizeRequest);
    expect(finalized.disposition).toBe("finalized");
    expect(finalized.attempt.phase).toBe("finalized");
    expect(finalized.readback.status).toBe("verified");
    expect(finalized.readback.attemptId).toBe(claim.attempt.attemptId);
    expect(finalized.release.status).toBe("active_verified");
    expect(finalized.idempotency.status).toBe("completed");
    expect(finalized.idempotency.finalResult).toEqual(publishFinalResult);
    expect(finalized.reconciliationEvent.sequence + 1).toBe(
      finalized.completionEvent.sequence,
    );
    expect(finalized.reconciliationEvent.occurredAt).toBe(finalized.completionEvent.occurredAt);
    expect(finalized.reconciliationEvent.occurredAt).toBe(finalized.attempt.finalizedAt);
    expect((await repository.getControlState()).latestReadback?.status).toBe("verified");
    await expect(repository.finalizeReadbackAndComplete(finalizeRequest)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("rejects reserved recovery actor claims before durable writes", async () => {
    const repository = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
      records: validPendingAuthorityGraph(),
    });
    const request: ClaimReadbackAttemptRequest = {
      ...attemptClaimRequest({
        attemptId: "attempt_reserved_recovery_actor",
        readbackRef: "readback_reserved_recovery_actor",
      }),
      metadata: {
        ...attemptClaimRequest().metadata,
        action: "deployments.reconcile",
        idempotencyKey: "idem_reserved_recovery_actor",
        actorRef: RECOVERY_ACTOR_REF,
        requestId: "request_reserved_recovery_actor",
        traceId: "trace_reserved_recovery_actor",
        auditId: "audit_reserved_recovery_actor",
      },
    };
    const before = await repository.getControlState();
    await expect(repository.claimReadbackAttempt(request)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await repository.getUnfinishedReadbackAttempt({
        managementTenantId: MANAGEMENT_TENANT_ID,
        attemptId: request.attemptId,
      }),
    ).toBeNull();
    await expect(
      repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: request.metadata.action,
        idempotencyKey: request.metadata.idempotencyKey,
      }),
    ).resolves.toBeNull();
    expect((await repository.getControlState()).events).toEqual(before.events);
  });

  it("rejects cloned, proxied, borrowed, and reused owner capabilities", async () => {
    const first = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
      records: validPendingAuthorityGraph(),
    });
    const claim = await first.claimReadbackAttempt(attemptClaimRequest());
    if (claim.disposition !== "created") throw new Error("claim was not created");
    const base = {
      attemptId: claim.attempt.attemptId,
      observation: verifiedAttemptObservation,
      finalResult: publishFinalResult,
      finalizedAt: "2026-08-22T00:12:00.000000000Z",
    };
    expect(Reflect.ownKeys(first)).not.toContain("ownerCapabilities");
    expect(Reflect.ownKeys(first)).not.toContain("consumedOwnerCapabilities");
    const forgedCapability = Object.freeze(Object.create(null)) as ReadbackAttemptOwnerCapability;
    const forgedOwnerCapabilities = new WeakMap<object, { readonly attemptId: string }>();
    forgedOwnerCapabilities.set(forgedCapability, {
      attemptId: claim.attempt.attemptId,
    });
    Reflect.set(first, "ownerCapabilities", forgedOwnerCapabilities);
    Reflect.set(first, "consumedOwnerCapabilities", new WeakSet<object>());
    await expect(
      first.finalizeReadbackAndComplete({
        ...base,
        ownerCapability: forgedCapability,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const clone = structuredClone(claim.ownerCapability);
    const jsonCapability = JSON.parse(
      JSON.stringify(claim.ownerCapability),
    ) as ReadbackAttemptOwnerCapability;
    await expect(
      first.finalizeReadbackAndComplete({ ...base, ownerCapability: clone }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      first.finalizeReadbackAndComplete({
        ...base,
        ownerCapability: jsonCapability,
      }),
    ).rejects.toThrow();
    await expect(
      first.finalizeReadbackAndComplete({
        ...base,
        ownerCapability: { ...claim.ownerCapability },
      }),
    ).rejects.toThrow();
    await expect(
      first.finalizeReadbackAndComplete({
        ...base,
        ownerCapability: new Proxy(claim.ownerCapability, {}),
      }),
    ).rejects.toThrow();
    const second = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
      records: validPendingAuthorityGraph(),
    });
    await expect(
      second.finalizeReadbackAndComplete({
        ...base,
        ownerCapability: claim.ownerCapability,
      }),
    ).rejects.toThrow();
    const finalized = await first.finalizeReadbackAndComplete({
      ...base,
      ownerCapability: claim.ownerCapability,
    });
    expect(finalized.disposition).toBe("finalized");
    await expect(
      first.finalizeReadbackAndComplete({
        ...base,
        ownerCapability: claim.ownerCapability,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps multiple reconcile attempts immutable and projects the latest terminal attempt", async () => {
    const repository = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
      records: validPendingAuthorityGraph(),
    });
    const reconcileFinal = (
      status: "mismatch" | "unknown",
      reason: string,
      requestId: string,
      traceId: string,
      auditId: string,
    ): ControlFinalResult => ({
      domainRecordRef: pendingRelease.releaseId,
      envelope: {
        ...publishFinalResult.envelope,
        request_id: requestId,
        trace_id: traceId,
        audit_id: auditId,
        status: "manual_review",
        data: {
          kind: "reconciliation",
          release_id: pendingRelease.releaseId,
          revision: pendingRelease.revision,
          status,
        },
        reason_codes: [reason],
        readback: {
          status,
          release_id: pendingRelease.releaseId,
          revision: pendingRelease.revision,
        },
      },
    });
    const firstClaim = await repository.claimReadbackAttempt({
      ...attemptClaimRequest({
        attemptId: "attempt_reconcile_001",
        readbackRef: "readback_reconcile_001",
        claimedAt: "2026-08-22T00:12:00.000000001Z",
      }),
      metadata: {
        ...attemptClaimRequest().metadata,
        action: "deployments.reconcile",
        idempotencyKey: "idem_reconcile_001",
        actorRef: "actor_reconciler",
        requestId: "request_reconcile_001",
        traceId: "trace_reconcile_001",
        auditId: "audit_reconcile_001",
      },
    });
    if (firstClaim.disposition !== "created") throw new Error("first reconcile claim was not created");
    const first = await repository.finalizeReadbackAndComplete({
      attemptId: firstClaim.attempt.attemptId,
      ownerCapability: firstClaim.ownerCapability,
      observation: {
        status: "mismatch",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: ["runtime.mismatch"],
        checkedAt: "2026-08-22T00:12:00.000000002Z",
      },
      finalResult: reconcileFinal(
        "mismatch",
        "runtime.mismatch",
        "request_reconcile_001",
        "trace_reconcile_001",
        "audit_reconcile_001",
      ),
      finalizedAt: "2026-08-22T00:12:00.000000003Z",
    });
    const secondClaim = await repository.claimReadbackAttempt({
      ...attemptClaimRequest({
        attemptId: "attempt_reconcile_002",
        readbackRef: "readback_reconcile_002",
        claimedAt: "2026-08-22T00:12:00.000000004Z",
      }),
      metadata: {
        ...attemptClaimRequest().metadata,
        action: "deployments.reconcile",
        idempotencyKey: "idem_reconcile_002",
        actorRef: "actor_reconciler",
        requestId: "request_reconcile_002",
        traceId: "trace_reconcile_002",
        auditId: "audit_reconcile_002",
      },
    });
    if (secondClaim.disposition !== "created") throw new Error("second reconcile claim was not created");
    const second = await repository.finalizeReadbackAndComplete({
      attemptId: secondClaim.attempt.attemptId,
      ownerCapability: secondClaim.ownerCapability,
      observation: {
        status: "unknown",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: ["runtime.unknown"],
        checkedAt: "2026-08-22T00:12:00.000000005Z",
      },
      finalResult: reconcileFinal(
        "unknown",
        "runtime.unknown",
        "request_reconcile_002",
        "trace_reconcile_002",
        "audit_reconcile_002",
      ),
      finalizedAt: "2026-08-22T00:12:00.000000006Z",
    });
    expect(first.attempt.attemptId).not.toBe(second.attempt.attemptId);
    expect(second.release.status).toBe("manual_review");
    expect(second.readback.attemptId).toBe(second.attempt.attemptId);
    const history = await repository.getReadbackAttemptHistory({
      managementTenantId: MANAGEMENT_TENANT_ID,
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
    });
    expect(history.map((attempt) => attempt.attemptId)).toEqual([
      second.attempt.attemptId,
      first.attempt.attemptId,
    ]);
    expect(Object.isFrozen(history[0])).toBe(true);
    expect((await repository.getControlState()).latestReadback?.attemptId).toBe(
      second.attempt.attemptId,
    );
  });

  it("rolls back every finalize phase without a sequence gap", async () => {
    for (const phase of FAKE_READBACK_ATTEMPT_FAILURE_PHASES) {
      const repository = new FakeModuleControlRepository({
        managementTenantId: MANAGEMENT_TENANT_ID,
        ownerBootId: "boot_current",
        records: validPendingAuthorityGraph(),
      });
      const claim = await repository.claimReadbackAttempt(
        attemptClaimRequest({
          attemptId: `attempt_failure_${phase}`,
          readbackRef: `readback_failure_${phase}`,
        }),
      );
      if (claim.disposition !== "created") throw new Error("claim was not created");
      const before = await repository.getControlState();
      repository.queueReadbackAttemptFailure("finalizeReadbackAndComplete", phase);
      await expect(
        repository.finalizeReadbackAndComplete({
          attemptId: claim.attempt.attemptId,
          ownerCapability: claim.ownerCapability,
          observation: verifiedAttemptObservation,
          finalResult: publishFinalResult,
          finalizedAt: "2026-08-22T00:12:00.000000000Z",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      const after = await repository.getControlState();
      expect(after.events).toEqual(before.events);
      expect(after.latestReadback).toBeNull();
      const unfinished = await repository.getUnfinishedReadbackAttempt({
        managementTenantId: MANAGEMENT_TENANT_ID,
        attemptId: claim.attempt.attemptId,
      });
      expect(unfinished?.phase).toBe("claimed");

      const retried = await repository.finalizeReadbackAndComplete({
        attemptId: claim.attempt.attemptId,
        ownerCapability: claim.ownerCapability,
        observation: verifiedAttemptObservation,
        finalResult: publishFinalResult,
        finalizedAt: "2026-08-22T00:12:00.000000000Z",
      });
      expect(retried.disposition).toBe("finalized");
      expect(retried.reconciliationEvent.sequence).toBe(before.events.length + 1);
      expect(retried.completionEvent.sequence).toBe(before.events.length + 2);
      expect((await repository.getControlState()).events.map((event) => event.sequence)).toEqual([
        1,
        2,
        3,
        4,
        5,
      ]);
      await expect(
        repository.finalizeReadbackAndComplete({
          attemptId: claim.attempt.attemptId,
          ownerCapability: claim.ownerCapability,
          observation: verifiedAttemptObservation,
          finalResult: publishFinalResult,
          finalizedAt: "2026-08-22T00:12:00.000000000Z",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    }
  });

  it("rolls back every claim sub-write", async () => {
    for (const phase of [
      "method_entry",
      "after_idempotency",
      "after_attempt",
      "after_health",
    ] as const) {
      const repository = new FakeModuleControlRepository({
        managementTenantId: MANAGEMENT_TENANT_ID,
        ownerBootId: "boot_current",
        records: validPendingAuthorityGraph(),
      });
      const request = {
        ...attemptClaimRequest({
          attemptId: `attempt_claim_failure_${phase}`,
          readbackRef: `readback_claim_failure_${phase}`,
        }),
        metadata: {
          ...attemptClaimRequest().metadata,
          action: "deployments.reconcile" as const,
          idempotencyKey: `idem_claim_failure_${phase}`,
          actorRef: "actor_reconciler",
          requestId: `request_claim_failure_${phase}`,
          traceId: `trace_claim_failure_${phase}`,
          auditId: `audit_claim_failure_${phase}`,
        },
      } satisfies ClaimReadbackAttemptRequest;
      const before = await repository.getControlState();
      repository.queueReadbackAttemptFailure("claimReadbackAttempt", phase);
      await expect(repository.claimReadbackAttempt(request)).rejects.toThrow();
      const after = await repository.getControlState();
      expect(after.events).toEqual(before.events);
      expect(after.latestReadback).toBeNull();
      expect(
        await repository.getUnfinishedReadbackAttempt({
          managementTenantId: MANAGEMENT_TENANT_ID,
          attemptId: request.attemptId,
        }),
      ).toBeNull();
    }
  });

  it("uses an assembly-only recovery driver for prior-boot claims", async () => {
    const claimTime = "2026-08-22T00:12:00.000000000Z";
    const priorAttempt = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      attemptId: "attempt_prior_boot_001",
      action: "deployments.publish",
      idempotencyKey: publishRequest.metadata.idempotencyKey,
      requestHash: REQUEST_HASH,
      actorRef: pendingRelease.publisherActorRef,
      requestId: "request_publish_001",
      traceId: "trace_publish_001",
      auditId: "audit_publish_001",
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      desiredModules: pendingRelease.desiredModules,
      readbackRef: "readback_prior_boot_001",
      ownerBootId: "boot_prior",
      phase: "claimed",
      claimedAt: claimTime,
      finalizedAt: null,
      terminalStatus: null,
      appliedReleaseId: null,
      appliedRevision: null,
      appliedModules: [],
      reasonCodes: [],
      checkedAt: null,
      finalizedByActorRef: null,
      reconciliationEventSequence: null,
      completionEventSequence: null,
    } as const;
    const { repository, recoveryDriver } = createFakeModuleControlRepositoryWithRecovery({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
      records: {
        ...validPendingAuthorityGraph(),
        attempts: [priorAttempt],
      },
    });
    await expect(
      repository.finalizeReadbackAndComplete({
        attemptId: priorAttempt.attemptId,
        ownerCapability: Object.freeze(Object.create(null)) as never,
        observation: {
          status: "unknown",
          appliedReleaseId: null,
          appliedRevision: null,
          appliedModules: [],
          reasonCodes: ["readback.interrupted"],
          checkedAt: claimTime,
        },
        finalResult: {
          domainRecordRef: pendingRelease.releaseId,
          envelope: {
            ...publishFinalResult.envelope,
            status: "manual_review",
            data: {
              kind: "release",
              release_id: pendingRelease.releaseId,
              revision: pendingRelease.revision,
              active_modules: pendingRelease.desiredModules.map((ref) => ({
                module_id: ref.moduleId,
                version: ref.version,
                descriptor_digest: ref.descriptorDigest,
              })),
            },
            reason_codes: ["readback.interrupted"],
            readback: {
              status: "unknown",
              release_id: pendingRelease.releaseId,
              revision: pendingRelease.revision,
            },
          },
        },
        finalizedAt: "2026-08-22T00:12:00.000000000Z",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const recovered = await recoveryDriver.finalizePriorBootAttempt({
      attemptId: priorAttempt.attemptId,
      observation: {
        status: "unknown",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: ["readback.interrupted"],
        checkedAt: claimTime,
      },
      finalResult: {
        domainRecordRef: pendingRelease.releaseId,
        envelope: {
          ...publishFinalResult.envelope,
          status: "manual_review",
          data: {
            kind: "release",
            release_id: pendingRelease.releaseId,
            revision: pendingRelease.revision,
            active_modules: pendingRelease.desiredModules.map((ref) => ({
              module_id: ref.moduleId,
              version: ref.version,
              descriptor_digest: ref.descriptorDigest,
            })),
          },
          reason_codes: ["readback.interrupted"],
          readback: {
            status: "unknown",
            release_id: pendingRelease.releaseId,
            revision: pendingRelease.revision,
          },
        },
      },
      finalizedAt: "2026-08-22T00:12:00.000000000Z",
    });
    expect(recovered.attempt.actorRef).toBe(pendingRelease.publisherActorRef);
    expect(recovered.idempotency.actorRef).toBe(pendingRelease.publisherActorRef);
    expect(recovered.attempt.finalizedByActorRef).toBe(RECOVERY_ACTOR_REF);
    expect(recovered.reconciliationEvent.actorRef).toBe(RECOVERY_ACTOR_REF);
    expect(recovered.completionEvent.actorRef).toBe(RECOVERY_ACTOR_REF);
    expect(recovered.readback.status).toBe("unknown");
    expect(recovered.release.status).toBe("manual_review");

    const recoveryState = await repository.getControlState();
    const completedRecoveryIdempotency = {
      ...publishDomainCommittedIdempotencyRecord,
      status: "completed",
      finalResult: recovered.finalResult,
    } as const;
    const recoverySeedRecords = {
      ...validPendingAuthorityGraph(),
      releases: [recovered.release],
      readbacks: [recovered.readback],
      attempts: [recovered.attempt],
      idempotency: [
        previewSeedIdempotency,
        approvalSeedIdempotency,
        completedRecoveryIdempotency,
      ],
      events: recoveryState.events,
      attemptEventAuthorities: [
        {
          eventId: recovered.reconciliationEvent.eventId,
          attemptId: recovered.attempt.attemptId,
          role: "reconciliation",
        },
        {
          eventId: recovered.completionEvent.eventId,
          attemptId: recovered.attempt.attemptId,
          role: "completion",
        },
      ],
    } as const;
    const reopenedRecovery = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_recovery_reopened_different",
      records: recoverySeedRecords as never,
    });
    await expect(reopenedRecovery.health()).resolves.toEqual({ ready: true });
    const recoveryHistory = await reopenedRecovery.getReadbackAttemptHistory({
      managementTenantId: MANAGEMENT_TENANT_ID,
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
    });
    expect(recoveryHistory[0]?.ownerBootId).toBe("boot_prior");
    expect(recoveryHistory[0]?.finalizedByActorRef).toBe("system_startup_recovery");

    const illegalRecoveryReasonRecords = {
      ...recoverySeedRecords,
      attempts: [
        {
          ...recovered.attempt,
          reasonCodes: ["readback.invalid"],
        },
      ],
    } as never;
    expect(
      () =>
        new FakeModuleControlRepository({
          managementTenantId: MANAGEMENT_TENANT_ID,
          ownerBootId: "boot_recovery_reopened_different",
          records: illegalRecoveryReasonRecords,
        }),
    ).toThrowError(expect.objectContaining({ code: "invalid_state" }));

    const illegalRecoveryStatusRecords = {
      ...recoverySeedRecords,
      attempts: [
        {
          ...recovered.attempt,
          terminalStatus: "mismatch",
        },
      ],
    } as never;
    expect(
      () =>
        new FakeModuleControlRepository({
          managementTenantId: MANAGEMENT_TENANT_ID,
          ownerBootId: "boot_recovery_reopened_different",
          records: illegalRecoveryStatusRecords,
        }),
    ).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("rejects the reserved recovery actor in seeded attempts and idempotency", async () => {
    const source = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
      records: validPendingAuthorityGraph(),
    });
    const claim = await source.claimReadbackAttempt({
      ...attemptClaimRequest({
        attemptId: "attempt_seed_reserved_actor",
        readbackRef: "readback_seed_reserved_actor",
      }),
      metadata: {
        ...attemptClaimRequest().metadata,
        action: "deployments.reconcile",
        idempotencyKey: "idem_seed_reserved_actor",
        actorRef: "actor_reconciler",
        requestId: "request_seed_reserved_actor",
        traceId: "trace_seed_reserved_actor",
        auditId: "audit_seed_reserved_actor",
      },
    });
    if (claim.disposition !== "created") throw new Error("claim was not created");
    const idempotency = await source.getIdempotency({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: "deployments.reconcile",
      idempotencyKey: "idem_seed_reserved_actor",
    });
    if (idempotency === null) throw new Error("idempotency was not created");
    const state = await source.getControlState();
    const reservedAttemptGraph = {
      ...validPendingAuthorityGraph(),
      attempts: [
        {
          ...claim.attempt,
          actorRef: RECOVERY_ACTOR_REF,
        },
      ],
      idempotency: [
        previewSeedIdempotency,
        approvalSeedIdempotency,
        publishDomainCommittedIdempotencyRecord,
        {
          ...idempotency,
          actorRef: RECOVERY_ACTOR_REF,
        },
      ],
      events: state.events,
    } as never;
    expect(
      () =>
        new FakeModuleControlRepository({
          managementTenantId: MANAGEMENT_TENANT_ID,
          ownerBootId: "boot_reopened",
          records: reservedAttemptGraph,
        }),
    ).toThrowError(expect.objectContaining({ code: "invalid_state" }));

    const reservedIdempotencyGraph = {
      ...validPendingAuthorityGraph(),
      idempotency: [
        previewSeedIdempotency,
        approvalSeedIdempotency,
        publishDomainCommittedIdempotencyRecord,
        {
          ...reservedIdempotencyRecord,
          actorRef: RECOVERY_ACTOR_REF,
        },
      ],
    } as never;
    expect(
      () =>
        new FakeModuleControlRepository({
          managementTenantId: MANAGEMENT_TENANT_ID,
          ownerBootId: "boot_reopened",
          records: reservedIdempotencyGraph,
        }),
    ).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("requires explicit event authority when seeding a finalized attempt", async () => {
    const repository = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
      records: validPendingAuthorityGraph(),
    });
    const claim = await repository.claimReadbackAttempt(attemptClaimRequest());
    if (claim.disposition !== "created") throw new Error("claim was not created");
    const finalized = await repository.finalizeReadbackAndComplete({
      attemptId: claim.attempt.attemptId,
      ownerCapability: claim.ownerCapability,
      observation: verifiedAttemptObservation,
      finalResult: publishFinalResult,
      finalizedAt: "2026-08-22T00:12:00.000000000Z",
    });
    const state = await repository.getControlState();
    const completedPublish = {
      ...publishDomainCommittedIdempotencyRecord,
      status: "completed",
      finalResult: publishFinalResult,
    } as const;
    const seededRecords = {
      ...validPendingAuthorityGraph(),
      releases: [finalized.release],
      readbacks: [finalized.readback],
      attempts: [finalized.attempt],
      idempotency: [
        previewSeedIdempotency,
        approvalSeedIdempotency,
        completedPublish,
      ],
      events: state.events,
      attemptEventAuthorities: [
        {
          eventId: finalized.reconciliationEvent.eventId,
          attemptId: finalized.attempt.attemptId,
          role: "reconciliation",
        },
        {
          eventId: finalized.completionEvent.eventId,
          attemptId: finalized.attempt.attemptId,
          role: "completion",
        },
      ],
    } as const;
    expect(
      () =>
        new FakeModuleControlRepository({
          managementTenantId: MANAGEMENT_TENANT_ID,
          ownerBootId: "boot_current",
          records: seededRecords as never,
        }),
    ).not.toThrow();
    const reopened = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_reopened_different",
      records: seededRecords as never,
    });
    await expect(reopened.health()).resolves.toEqual({ ready: true });
    const reopenedHistory = await reopened.getReadbackAttemptHistory({
      managementTenantId: MANAGEMENT_TENANT_ID,
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
    });
    expect(reopenedHistory[0]?.ownerBootId).toBe("boot_current");
    expect(reopenedHistory[0]?.finalizedByActorRef).toBe(
      pendingRelease.publisherActorRef,
    );
    expect(
      (await reopened.getControlState()).events.slice(-2).map((event) => event.actorRef),
    ).toEqual([
      pendingRelease.publisherActorRef,
      pendingRelease.publisherActorRef,
    ]);
    const ambiguous = { ...seededRecords } as Record<string, unknown>;
    delete ambiguous.attemptEventAuthorities;
    expect(
      () =>
        new FakeModuleControlRepository({
          managementTenantId: MANAGEMENT_TENANT_ID,
          ownerBootId: "boot_current",
          records: ambiguous,
        }),
    ).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("implements the complete narrow repository key set without generic put/get methods", () => {
    const repository: ModuleControlRepository = newRepository();

    expect(FAKE_CONTROL_REPOSITORY_METHOD_NAMES).toEqual([
      "health",
      "close",
      "registerModule",
      "createPreview",
      "decideApproval",
      "publishRelease",
      "getControlState",
      "getActiveRelease",
      "getPendingRelease",
      "getNewestUnresolvedRelease",
      "getPreview",
      "getApproval",
      "getRelease",
      "getReadback",
      "getIdempotency",
    ]);
    for (const methodName of FAKE_CONTROL_REPOSITORY_METHOD_NAMES) {
      expect(methodName in repository).toBe(true);
    }
    expect("put" in repository).toBe(false);
    expect("get" in repository).toBe(false);
    expect("records" in repository).toBe(false);
  });

  it("records every method in order with frozen request snapshots and closed-record persistence", async () => {
    const repository = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
    });

    await repository.health();
    await repository.registerModule(registerRequest);
    await repository.createPreview(previewRequest);
    await repository.decideApproval(approvalRequest);
    await repository.publishRelease(publishRequest);
    const claim = await repository.claimReadbackAttempt(
      attemptClaimRequest({ readbackRef: readbackForPublishedRelease.readbackRef }),
    );
    if (claim.disposition !== "created") throw new Error("claim was not created");
    await repository.finalizeReadbackAndComplete({
      attemptId: claim.attempt.attemptId,
      ownerCapability: claim.ownerCapability,
      observation: verifiedAttemptObservation,
      finalResult: publishFinalResult,
      finalizedAt: verifiedAttemptObservation.checkedAt,
    });
    await repository.getControlState();
    await repository.getActiveRelease();
    await repository.getPendingRelease();
    await repository.getNewestUnresolvedRelease();
    const previewResult = await repository.getPreview(exactPreviewQuery());
    const approvalResult = await repository.getApproval(exactApprovalQuery());
    const releaseResult = await repository.getRelease(
      exactReleaseQuery("tenant_demo", pendingRelease.releaseId),
    );
    const readbackResult = await repository.getReadback(
      exactReadbackQuery("tenant_demo", pendingRelease.releaseId),
    );
    const idempotencyResult = await repository.getIdempotency({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: publishRequest.metadata.action,
      idempotencyKey: publishRequest.metadata.idempotencyKey,
    });

    expect(previewResult).toEqual({ ...changePreview, consumed: true });
    expect(approvalResult).toEqual({ ...approvalRecord, consumed: true });
    expect(releaseResult).toEqual({
      ...pendingRelease,
      status: "active_verified",
      readbackRef: readbackForPublishedRelease.readbackRef,
    });
    expect(readbackResult).toMatchObject({
      ...readbackForPublishedRelease,
      checkedAt: verifiedAttemptObservation.checkedAt,
    });
    expect(idempotencyResult).toMatchObject({
      status: "completed",
      finalResult: publishFinalResult,
    });

    await repository.close();

    expect(repository.calls.map((call) => call.method)).toEqual([
      "health",
      "registerModule",
      "createPreview",
      "decideApproval",
      "publishRelease",
      "getControlState",
      "getActiveRelease",
      "getPendingRelease",
      "getNewestUnresolvedRelease",
      "getPreview",
      "getApproval",
      "getRelease",
      "getReadback",
      "getIdempotency",
      "close",
    ]);

    const registrationCall = repository.calls.find(
      (call) => call.method === "registerModule",
    );
    expect(registrationCall?.request?.record).toEqual(registrationRecord);
    expect(Object.isFrozen(registrationCall)).toBe(true);
    expect(Object.isFrozen(registrationCall?.request)).toBe(true);
    expect(Object.isFrozen(registrationCall?.request?.record)).toBe(true);
    expect(Object.isFrozen(registrationCall?.request?.metadata.event.detail)).toBe(true);

  });

  it("preloads exact records and serves active, pending, unresolved, and five tenant-scoped lookups", async () => {
    const repository = newRepository(seedRecords);
    const pendingRepository = newRepository({
      previews: [{ ...changePreview, consumed: true }],
      approvals: [{ ...approvalRecord, consumed: true }],
      releases: [pendingRelease],
      readbacks: [],
      idempotency: [publishDomainCommittedIdempotencyRecord],
      events: [
        {
          ...publishEventInput,
          managementTenantId: MANAGEMENT_TENANT_ID,
          eventId: "event_pending_publish_001",
          sequence: 1,
          actorRef: pendingRelease.publisherActorRef,
          occurredAt: pendingRelease.createdAt,
        },
      ],
    });
    const manualRepository = newRepository({
      previews: [{ ...changePreview, consumed: true }],
      approvals: [{ ...approvalRecord, consumed: true }],
      releases: [manualReviewRelease],
      readbacks: [unknownReadback],
      idempotency: [manualPublishIdempotency],
      events: [manualPublishEvent, manualReadbackEvent],
    });

    expect(await repository.getActiveRelease()).toEqual(activeRelease);
    expect(await pendingRepository.getPendingRelease()).toEqual(pendingRelease);
    expect(await manualRepository.getNewestUnresolvedRelease()).toEqual(manualReviewRelease);
    expect(await repository.getPreview(exactPreviewQuery())).toEqual({
      ...changePreview,
      consumed: true,
    });
    expect(await repository.getApproval(exactApprovalQuery())).toEqual({
      ...approvalRecord,
      consumed: true,
    });
    expect(await repository.getRelease(exactReleaseQuery())).toEqual(activeRelease);
    expect(await repository.getReadback(exactReadbackQuery())).toEqual(verifiedReadback);
    expect(await repository.getIdempotency(exactIdempotencyQuery())).toEqual(
      completedIdempotencyRecord,
    );

    const state = await repository.getControlState();
    expect(state.managementTenantId).toBe(MANAGEMENT_TENANT_ID);
    expect(state.activeRelease).toEqual(activeRelease);
    expect(state.activeRevision).toBe(activeRelease.revision);
    expect(state.activeModules).toEqual(activeRelease.desiredModules);
    expect(state.registrations).toEqual([registrationRecord]);
    expect(state.latestPreview).toEqual({ ...changePreview, consumed: true });
    expect(state.latestApproval).toEqual({ ...approvalRecord, consumed: true });
    expect(state.latestReadback).toEqual(verifiedReadback);
    expect(state.releaseHistory).toEqual([
      {
        release: activeRelease,
        intent: "change",
        rollbackTargetReleaseId: null,
      },
    ]);
    expect(state.events).toEqual([registrationEvent, activePublishEvent, activeReadbackEvent]);
    expect(state.eventsTruncated).toBe(false);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.activeModules)).toBe(true);
    expect(Object.isFrozen(state.events)).toBe(true);
  });

  it("consumes typed failures once per method in queued order while still recording failed calls", async () => {
    const repository = newRepository({ previews: [changePreview] });
    repository.queueFailure("getPreview", "not_found");
    repository.queueFailure(
      "getPreview",
      new ModuleControlRepositoryError("conflict"),
    );

    await expect(repository.getPreview(exactPreviewQuery())).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(repository.getPreview(exactPreviewQuery())).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(repository.getPreview(exactPreviewQuery())).resolves.toEqual(
      changePreview,
    );
    expect(repository.calls.filter((call) => call.method === "getPreview")).toHaveLength(3);

    repository.queueFailure("registerModule", "invalid_state");
    await expect(repository.registerModule(registerRequest)).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(repository.calls.at(-1)?.method).toBe("registerModule");
  });

  it.each([128, 129])(
    "projects a bounded newest-first release history for %s persisted releases",
    async (releaseCount) => {
      const repository = boundaryHistoryRepository(releaseCount);
      const state = await repository.getControlState();

      expect(state.releaseHistory).toHaveLength(Math.min(releaseCount, 128));
      expect(state.releaseHistory.map((entry) => entry.release.revision)).toEqual(
        Array.from(
          { length: Math.min(releaseCount, 128) },
          (_, index) => releaseCount - index,
        ),
      );
      expect(state.releaseHistory.every((entry) => entry.intent === "change" && entry.rollbackTargetReleaseId === null)).toBe(true);
      expect(state.events).toHaveLength(Math.min(releaseCount * 2, 256));
      expect(state.events.map((event) => event.sequence)).toEqual(
        Array.from(
          { length: Math.min(releaseCount * 2, 256) },
          (_, index) => Math.max(1, releaseCount * 2 - 255) + index,
        ),
      );
      expect(state.eventsTruncated).toBe(releaseCount * 2 > 256);
    },
  );

  it("projects rollback intent and fails closed for missing or tenant-drifted previews", async () => {
    const repository = boundaryHistoryRepository(1);
    const internals = repository as unknown as {
      releaseRecords: Map<string, ModuleReleaseRecord>;
      previewRecords: Map<string, ModuleChangePreviewRecord | ModuleRollbackPreviewRecord>;
    };
    const release = [...internals.releaseRecords.values()][0];
    const preview = [...internals.previewRecords.values()][0];
    if (release === undefined || preview === undefined) {
      throw new Error("boundary fixture is incomplete");
    }
    const rollbackPreview = {
      ...preview,
      intent: "rollback",
      targetReleaseId: "release_opaque_target",
    } as ModuleRollbackPreviewRecord;
    internals.previewRecords.set(
      `${MANAGEMENT_TENANT_ID}\0${release.previewRef}`,
      rollbackPreview,
    );

    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });

    internals.previewRecords.delete(`${MANAGEMENT_TENANT_ID}\0${release.previewRef}`);
    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });

    internals.previewRecords.set(
      `${MANAGEMENT_TENANT_ID}\0${release.previewRef}`,
      { ...rollbackPreview, managementTenantId: OTHER_TENANT_ID },
    );
    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it.each([
    { label: "bounded older", targetRevision: 2, accepted: true },
    { label: "durable but outside bounded history", targetRevision: 1, accepted: false },
  ])("resolves rollback targets from the bounded Fake history only ($label)", async ({ targetRevision, accepted }) => {
    const repository = boundaryHistoryRepository(129);
    const internals = repository as unknown as {
      releaseRecords: Map<string, ModuleReleaseRecord>;
      previewRecords: Map<string, ModuleChangePreviewRecord | ModuleRollbackPreviewRecord>;
    };
    const baseRelease = internals.releaseRecords.get(
      `${MANAGEMENT_TENANT_ID}\0release_boundary_129`,
    );
    const targetRelease = internals.releaseRecords.get(
      `${MANAGEMENT_TENANT_ID}\0release_boundary_${targetRevision}`,
    );
    if (baseRelease === undefined || targetRelease === undefined) {
      throw new Error("rollback boundary fixture is incomplete");
    }
    internals.previewRecords.set(
      `${MANAGEMENT_TENANT_ID}\0preview_rollback_boundary_${targetRevision}`,
      {
        ...changePreview,
        previewRef: `preview_rollback_boundary_${targetRevision}`,
        baseReleaseId: baseRelease.releaseId,
        baseRevision: baseRelease.revision,
        inventoryRefs: [moduleRef],
        desiredModules: targetRelease.desiredModules,
        diff: { added: [], removed: [], retained: targetRelease.desiredModules },
        createdAt: "2026-08-23T00:00:00Z",
        expiresAt: "2026-08-24T00:00:00Z",
        consumed: false,
        intent: "rollback",
        targetReleaseId: targetRelease.releaseId,
      } satisfies ModuleRollbackPreviewRecord,
    );

    if (accepted) {
      await expect(repository.getControlState()).resolves.toBeDefined();
    } else {
      await expect(repository.getControlState()).rejects.toMatchObject({
        code: "invalid_state",
      });
    }
  });

  it.each([256, 257])(
    "sets eventsTruncated from complete eventRecords at the exact %s boundary",
    async (eventCount) => {
      const repository = newRepository(registrationEventHistory(eventCount));
      const state = await repository.getControlState();

      expect(state.events).toHaveLength(256);
      expect(state.eventsTruncated).toBe(eventCount > 256);
      expect(state.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 256 }, (_, index) => eventCount - 255 + index),
      );
    },
  );

  it("rejects failure phases a method cannot consume and preserves failed-call diagnostics across rollback", async () => {
    const repository = newRepository();
    const allowedPhases = new Map<
      (typeof FAKE_CONTROL_REPOSITORY_METHOD_NAMES)[number],
      readonly (typeof FAKE_CONTROL_REPOSITORY_FAILURE_PHASES)[number][]
    >([
      ["health", ["method_entry"]],
      ["close", ["method_entry"]],
      ["registerModule", ["method_entry", "after_domain_write", "after_event", "after_idempotency"]],
      ["createPreview", ["method_entry", "after_domain_write", "after_event", "after_idempotency"]],
      ["decideApproval", ["method_entry", "after_domain_write", "after_event", "after_idempotency"]],
      ["publishRelease", ["method_entry", "after_idempotency", "after_release_status_change", "after_domain_write", "after_event"]],
      ["getControlState", ["method_entry"]],
      ["getActiveRelease", ["method_entry"]],
      ["getPendingRelease", ["method_entry"]],
      ["getNewestUnresolvedRelease", ["method_entry"]],
      ["getPreview", ["method_entry"]],
      ["getApproval", ["method_entry"]],
      ["getRelease", ["method_entry"]],
      ["getReadback", ["method_entry"]],
      ["getIdempotency", ["method_entry"]],
    ]);

    for (const method of FAKE_CONTROL_REPOSITORY_METHOD_NAMES) {
      for (const phase of FAKE_CONTROL_REPOSITORY_FAILURE_PHASES) {
        if (allowedPhases.get(method)?.includes(phase)) continue;
        expect(() => repository.queueFailure(method, "not_found", phase)).toThrowError(
          expect.objectContaining({ code: "invalid_state" }),
        );
      }
    }

    const stateBeforeFailure = await repository.getControlState();
    const callsBeforeFailure = repository.calls.length;
    repository.queueFailure("registerModule", "not_found", "after_event");
    await expect(repository.registerModule(registerRequest)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(repository.calls).toHaveLength(callsBeforeFailure + 1);
    expect(repository.calls.at(-1)?.method).toBe("registerModule");
    expect(await repository.getControlState()).toEqual(stateBeforeFailure);

    await expect(repository.registerModule(registerRequest)).resolves.toMatchObject({
      replayed: false,
    });
  });

  it("replays the persisted closed write result without creating a second event", async () => {
    const repository = newRepository();

    const firstWrite = await repository.registerModule(registerRequest);
    const replayedWrite = await repository.registerModule(registerRequest);

    expect(firstWrite.replayed).toBe(false);
    expect(replayedWrite.replayed).toBe(true);
    expect(replayedWrite.record).toEqual(firstWrite.record);
    expect(replayedWrite.event).toEqual(firstWrite.event);
    const eventCountAfterRegisterReplay = (await repository.getControlState()).events.length;
    expect((await repository.getControlState()).events).toHaveLength(
      eventCountAfterRegisterReplay,
    );
  });

  it("matches simple-write transaction parity with one domain event and a completed idempotency row", async () => {
    const repository = newRepository();

    const registration = await repository.registerModule(registerRequest);
    const preview = await repository.createPreview(previewRequest);
    const approval = await repository.decideApproval(approvalRequest);
    const state = await repository.getControlState();

    expect(state.events).toHaveLength(3);
    expect(state.events).toEqual([registration.event, preview.event, approval.event]);
    await expect(
      repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: approvalRequest.metadata.action,
        idempotencyKey: approvalRequest.metadata.idempotencyKey,
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("matches SQLite pending-readback replay and new reconcile-key retry semantics", async () => {
    const applicationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "fake-control-pending-parity-")),
    );
    let sqlite: (ModuleControlRepository & ModuleControlReadbackAttemptRepository) | null = null;
    try {
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fake_pending_parity_001",
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      sqlite = openSqliteControlStore({
        applicationRoot,
        instanceId: "instance_fake_pending_parity_001",
        managementTenantId: MANAGEMENT_TENANT_ID,
        adminControlEnabled: true,
      });
      const repositories = [
        new FakeModuleControlRepository({
          managementTenantId: MANAGEMENT_TENANT_ID,
          ownerBootId: "boot_current",
        }),
        sqlite,
      ] as const;
      const pendingObservation = readbackVariant(sameKeyReadbackRequest, {
        readbackRef: pendingReadback.readbackRef,
        status: "pending",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: [],
      });
      const differentPublishObservation = readbackVariant(sameKeyReadbackRequest, {
        readbackRef: "readback_publish_different_002",
        status: "pending",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: [],
      });
      const operatorRetry = readbackVariant(reconcileReadbackRequest, {
        readbackRef: "readback_reconcile_retry_003",
        status: "unknown",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: ["runtime.unavailable"],
      });
      const manualPublishFinalResult = {
        domainRecordRef: pendingRelease.releaseId,
        envelope: {
          ...publishFinalResult.envelope,
          status: "manual_review",
          reason_codes: ["runtime.unavailable"],
          readback: {
            status: "unknown",
            release_id: pendingRelease.releaseId,
            revision: pendingRelease.revision,
          },
        },
      } as const satisfies ControlFinalResult;

      for (const repository of repositories) await preparePendingRelease(repository);
      const firstClaims = [] as Awaited<ReturnType<ModuleControlReadbackAttemptRepository["claimReadbackAttempt"]>>[];
      const replayClaims = [] as Awaited<ReturnType<ModuleControlReadbackAttemptRepository["claimReadbackAttempt"]>>[];
      const differentCodes: Array<ModuleControlRepositoryError["code"] | "resolved"> = [];
      const firstFinalizations = [] as Awaited<ReturnType<ModuleControlReadbackAttemptRepository["finalizeReadbackAndComplete"]>>[];
      const retryClaims = [] as Awaited<ReturnType<ModuleControlReadbackAttemptRepository["claimReadbackAttempt"]>>[];
      const retryFinalizations = [] as Awaited<ReturnType<ModuleControlReadbackAttemptRepository["finalizeReadbackAndComplete"]>>[];
      for (const repository of repositories) {
        const pendingClaimRequest = attemptClaimRequest({
          attemptId: "attempt_publish_pending_001",
          readbackRef: pendingObservation.record.readbackRef,
        });
        const firstClaim = await repository.claimReadbackAttempt(pendingClaimRequest);
        firstClaims.push(firstClaim);
        expect(firstClaim.disposition).toBe("created");
        if (firstClaim.disposition !== "created") throw new Error("claim was not created");
        await expect(repository.getReadback(
          exactReadbackQuery(MANAGEMENT_TENANT_ID, pendingRelease.releaseId),
        )).resolves.toBeNull();
        await expect(repository.getUnfinishedReadbackAttempt({
          managementTenantId: MANAGEMENT_TENANT_ID,
          attemptId: firstClaim.attempt.attemptId,
        })).resolves.toMatchObject({
          attemptId: firstClaim.attempt.attemptId,
          phase: "claimed",
          readbackRef: pendingObservation.record.readbackRef,
        });

        const replayClaim = await repository.claimReadbackAttempt(pendingClaimRequest);
        replayClaims.push(replayClaim);
        expect(replayClaim.disposition).toBe("existing");
        if (replayClaim.disposition !== "existing") throw new Error("claim did not replay");
        expect(replayClaim.attempt).toEqual(firstClaim.attempt);
        differentCodes.push(
          await repositoryResultCode(() => repository.claimReadbackAttempt({
            ...pendingClaimRequest,
            attemptId: "attempt_publish_different_002",
            readbackRef: differentPublishObservation.record.readbackRef,
          })),
        );

        firstFinalizations.push(await repository.finalizeReadbackAndComplete({
          attemptId: firstClaim.attempt.attemptId,
          ownerCapability: firstClaim.ownerCapability,
          observation: {
            status: "unknown",
            appliedReleaseId: null,
            appliedRevision: null,
            appliedModules: [],
            reasonCodes: ["runtime.unavailable"],
            checkedAt: operatorRetry.record.checkedAt,
          },
          finalResult: manualPublishFinalResult,
          finalizedAt: operatorRetry.record.checkedAt,
        }));

        const retryClaimRequest: ClaimReadbackAttemptRequest = {
          ...attemptClaimRequest({
            attemptId: "attempt_reconcile_retry_003",
            readbackRef: operatorRetry.record.readbackRef,
            claimedAt: "2026-08-22T00:11:59.000000000Z",
          }),
          metadata: {
            ...attemptClaimRequest().metadata,
            action: operatorRetry.metadata.action,
            idempotencyKey: operatorRetry.metadata.idempotencyKey,
            actorRef: operatorRetry.metadata.actorRef,
            requestId: "request_reconcile_retry_003",
            traceId: "trace_reconcile_retry_003",
            auditId: "audit_reconcile_retry_003",
          },
        };
        const retryClaim = await repository.claimReadbackAttempt(retryClaimRequest);
        retryClaims.push(retryClaim);
        expect(retryClaim.disposition).toBe("created");
        if (retryClaim.disposition !== "created") {
          throw new Error("reconcile retry claim was not created");
        }
        retryFinalizations.push(await repository.finalizeReadbackAndComplete({
          attemptId: retryClaim.attempt.attemptId,
          ownerCapability: retryClaim.ownerCapability,
          observation: {
            status: "unknown",
            appliedReleaseId: null,
            appliedRevision: null,
            appliedModules: [],
            reasonCodes: ["runtime.unavailable"],
            checkedAt: operatorRetry.record.checkedAt,
          },
          finalResult: {
            domainRecordRef: pendingRelease.releaseId,
            envelope: {
              ...publishFinalResult.envelope,
              request_id: "request_reconcile_retry_003",
              trace_id: "trace_reconcile_retry_003",
              audit_id: "audit_reconcile_retry_003",
              status: "manual_review",
              data: {
                kind: "reconciliation",
                release_id: pendingRelease.releaseId,
                revision: pendingRelease.revision,
                status: "unknown",
              },
              reason_codes: ["runtime.unavailable"],
              readback: {
                status: "unknown",
                release_id: pendingRelease.releaseId,
                revision: pendingRelease.revision,
              },
            },
          },
          finalizedAt: operatorRetry.record.checkedAt,
        }));
      }

      expect(firstClaims.map((result) => result.disposition)).toEqual(["created", "created"]);
      expect(replayClaims.map((result) => result.disposition)).toEqual(["existing", "existing"]);
      expect(differentCodes).toEqual(["conflict", "conflict"]);
      expect(retryClaims.map((result) => result.disposition)).toEqual(["created", "created"]);
      expect(retryFinalizations.map((result) => result.disposition)).toEqual([
        "finalized",
        "finalized",
      ]);
      const comparableAttempt = (attempt: typeof firstClaims[number]["attempt"]) => ({
        ...attempt,
        ownerBootId: "<store-owned>",
      });
      expect(comparableAttempt(firstClaims[0]!.attempt)).toEqual(
        comparableAttempt(firstClaims[1]!.attempt),
      );
      expect(comparableAttempt(replayClaims[0]!.attempt)).toEqual(
        comparableAttempt(replayClaims[1]!.attempt),
      );
      expect(firstFinalizations.map((result) => result.disposition)).toEqual([
        "finalized",
        "finalized",
      ]);
      expect(firstFinalizations[0]?.readback).toEqual(firstFinalizations[1]?.readback);
      expect(retryFinalizations[0]?.readback).toEqual(retryFinalizations[1]?.readback);
      for (const repository of repositories) {
        await expect(repository.getReadback(
          exactReadbackQuery(MANAGEMENT_TENANT_ID, pendingRelease.releaseId),
        )).resolves.toMatchObject({
          readbackRef: operatorRetry.record.readbackRef,
          status: "unknown",
        });
        await expect(repository.getRelease(
          exactReleaseQuery(MANAGEMENT_TENANT_ID, pendingRelease.releaseId),
        )).resolves.toMatchObject({ status: "manual_review" });
        await expect(repository.getUnfinishedReadbackAttempt({
          managementTenantId: MANAGEMENT_TENANT_ID,
          attemptId: "attempt_publish_pending_001",
        })).resolves.toBeNull();
        await expect(repository.getUnfinishedReadbackAttempt({
          managementTenantId: MANAGEMENT_TENANT_ID,
          attemptId: "attempt_reconcile_retry_003",
        })).resolves.toBeNull();
      }
      const projectedStates = await Promise.all(
        repositories.map((repository) => repository.getControlState()),
      );
      const projectionSummary = (state: (typeof projectedStates)[number]) => ({
        releaseHistory: state.releaseHistory.map((entry) => ({
          releaseId: entry.release.releaseId,
          revision: entry.release.revision,
          intent: entry.intent,
          rollbackTargetReleaseId: entry.rollbackTargetReleaseId,
        })),
        eventsTruncated: state.eventsTruncated,
      });
      expect(projectionSummary(projectedStates[0]!)).toEqual(
        projectionSummary(projectedStates[1]!),
      );
    } finally {
      await sqlite?.close();
      rmSync(applicationRoot, { force: true, recursive: true });
    }
  });

  it("materializes completed idempotency for register, preview, and approval writes", async () => {
    const repository = newRepository();

    await repository.registerModule(registerRequest);
    await repository.createPreview(previewRequest);
    await repository.decideApproval(approvalRequest);

    await expect(
      repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: registerRequest.metadata.action,
        idempotencyKey: registerRequest.metadata.idempotencyKey,
      }),
    ).resolves.toEqual({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: registerRequest.metadata.action,
      idempotencyKey: registerRequest.metadata.idempotencyKey,
      requestHash: registerRequest.metadata.requestHash,
      actorRef: registerRequest.metadata.actorRef,
      status: "completed",
      domainRecordRef: registrationFinalResult.domainRecordRef,
      finalResult: registrationFinalResult,
      createdAt: registrationRecord.registeredAt,
      expiresAt: "2026-08-23T00:00:00Z",
    });
    await expect(
      repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: previewRequest.metadata.action,
        idempotencyKey: previewRequest.metadata.idempotencyKey,
      }),
    ).resolves.toEqual({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: previewRequest.metadata.action,
      idempotencyKey: previewRequest.metadata.idempotencyKey,
      requestHash: previewRequest.metadata.requestHash,
      actorRef: previewRequest.metadata.actorRef,
      status: "completed",
      domainRecordRef: changePreview.previewRef,
      finalResult: previewRequest.finalResult,
      createdAt: changePreview.createdAt,
      expiresAt: "2026-08-23T00:00:00Z",
    });
    await expect(
      repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: approvalRequest.metadata.action,
        idempotencyKey: approvalRequest.metadata.idempotencyKey,
      }),
    ).resolves.toEqual({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: approvalRequest.metadata.action,
      idempotencyKey: approvalRequest.metadata.idempotencyKey,
      requestHash: approvalRequest.metadata.requestHash,
      actorRef: approvalRequest.metadata.actorRef,
      status: "completed",
      domainRecordRef: approvalRecord.approvalId,
      finalResult: approvalRequest.finalResult,
      createdAt: approvalRecord.decidedAt,
      expiresAt: "2026-08-23T00:05:00Z",
    });
  });

  it("orders state records by repository keys and timestamps instead of seed insertion order", async () => {
    const repository = newRepository(orderingRecords);

    const state = await repository.getControlState();

    expect(state.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(state.registrations.map((record) => record.moduleId)).toEqual([
      registrationRecord.moduleId,
      secondRegistrationRecord.moduleId,
    ]);
    expect(state.latestPreview).toEqual(tiedPreview);
    expect(state.latestApproval).toEqual(tiedApproval);
    expect(state.latestReadback).toBeNull();
  });

  it("makes health ready, closes idempotently, and returns typed closed after close", async () => {
    const repository = newRepository();

    const health = await repository.health();
    expect(health).toEqual({ ready: true });
    expect(Object.isFrozen(health)).toBe(true);

    await repository.close();
    await expect(repository.close()).resolves.toBeUndefined();
    await expect(repository.health()).resolves.toEqual({ ready: false });
    expect(repository.calls.map((call) => call.method)).toEqual([
      "health",
      "close",
      "close",
      "health",
    ]);
  });

  it("rejects every repository operation with the typed closed error after close", async () => {
    const repository = newRepository();
    await repository.close();

    const attempts: readonly Promise<unknown>[] = [
      repository.registerModule(registerRequest),
      repository.createPreview(previewRequest),
      repository.decideApproval(approvalRequest),
      repository.publishRelease(publishRequest),
      repository.getControlState(),
      repository.getActiveRelease(),
      repository.getPendingRelease(),
      repository.getNewestUnresolvedRelease(),
      repository.getPreview(exactPreviewQuery()),
      repository.getApproval(exactApprovalQuery()),
      repository.getRelease(exactReleaseQuery()),
      repository.getReadback(exactReadbackQuery()),
      repository.getIdempotency(exactIdempotencyQuery()),
    ];

    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        name: "ModuleControlRepositoryError",
        code: "closed",
      });
    }
  });

  it("returns mutation-resistant snapshots and never aliases caller-owned request data", async () => {
    const repository = newRepository();
    const mutableRequest = structuredClone(registerRequest) as RegisterModuleRecordRequest;

    const writeResult = await repository.registerModule(mutableRequest);
    Reflect.set(mutableRequest.record, "moduleId", "changed_by_caller");
    Reflect.set(mutableRequest.metadata.event.detail, "moduleId", "changed_by_caller");

    expect(writeResult.record.moduleId).toBe("cargo");
    const registrationCall = repository.calls.find(
      (call) => call.method === "registerModule",
    );
    expect(registrationCall?.request.record.moduleId).toBe("cargo");
    expect(registrationCall?.request.metadata.event.detail.moduleId).toBe("cargo");
    expect(Object.isFrozen(writeResult)).toBe(true);
    expect(Object.isFrozen(writeResult.record)).toBe(true);
    expect(Object.isFrozen(writeResult.event.detail)).toBe(true);
    expect(() => {
      (writeResult.record as { moduleId: string }).moduleId = "mutation";
    }).toThrow();

    const stored = await repository.getPreview(exactPreviewQuery());
    expect(stored).toBeNull();
    const seeded = newRepository({ previews: [changePreview] });
    const seededPreview = await seeded.getPreview(exactPreviewQuery());
    expect(seededPreview).not.toBeNull();
    expect(Object.isFrozen(seededPreview)).toBe(true);
    expect(Object.isFrozen(seededPreview?.desiredModules)).toBe(true);
    const desiredModules = seededPreview!.desiredModules as unknown as ModuleControlRef[];
    expect(() => desiredModules.push(moduleRef)).toThrow();
  });

  it("fails closed for a different tenant and returns null only for same-tenant exact misses", async () => {
    const repository = newRepository(seedRecords);

    await expect(repository.getPreview(exactPreviewQuery(OTHER_TENANT_ID))).rejects.toMatchObject({
      code: "tenant_mismatch",
    });
    await expect(repository.getApproval(exactApprovalQuery(OTHER_TENANT_ID))).rejects.toMatchObject({
      code: "tenant_mismatch",
    });
    await expect(repository.getRelease(exactReleaseQuery(OTHER_TENANT_ID))).rejects.toMatchObject({
      code: "tenant_mismatch",
    });
    await expect(repository.getReadback(exactReadbackQuery(OTHER_TENANT_ID))).rejects.toMatchObject({
      code: "tenant_mismatch",
    });
    await expect(
      repository.getIdempotency(exactIdempotencyQuery(OTHER_TENANT_ID)),
    ).rejects.toMatchObject({ code: "tenant_mismatch" });

    const missingPreview = await repository.getPreview(
      exactPreviewQuery(MANAGEMENT_TENANT_ID, "preview_missing_999"),
    );
    expect(missingPreview).toBeNull();

    const otherTenantRequest = structuredClone(registerRequest) as RegisterModuleRecordRequest;
    Reflect.set(otherTenantRequest.metadata, "managementTenantId", OTHER_TENANT_ID);
    Reflect.set(otherTenantRequest.record, "managementTenantId", OTHER_TENANT_ID);
    await expect(repository.registerModule(otherTenantRequest)).rejects.toMatchObject({
      code: "tenant_mismatch",
    });
  });

  it("rejects malformed exact-query identifiers with stable invalid_state instead of returning null", async () => {
    const repository = newRepository({ previews: [changePreview] });
    const stateBefore = await repository.getControlState();

    await expect(repository.getPreview({
      managementTenantId: MANAGEMENT_TENANT_ID,
      previewRef: "preview ref with spaces",
    })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.getApproval({
      managementTenantId: MANAGEMENT_TENANT_ID,
      approvalId: "approval/ref?bad",
    })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.getRelease({
      managementTenantId: MANAGEMENT_TENANT_ID,
      releaseId: "release ref with spaces",
    })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.getReadback({
      managementTenantId: MANAGEMENT_TENANT_ID,
      releaseId: "release/ref?bad",
    })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.getIdempotency({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: "packages.register",
      idempotencyKey: "idempotency key with spaces",
    })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.getPreview({
      managementTenantId: "tenant with spaces",
      previewRef: changePreview.previewRef,
    })).rejects.toMatchObject({ code: "invalid_state" });

    await expect(repository.getPreview({
      managementTenantId: MANAGEMENT_TENANT_ID,
      previewRef: "preview_missing_999",
    })).resolves.toBeNull();
    expect(await repository.getControlState()).toEqual(stateBefore);
  });

  it("maps proxy traps to invalid_state before recording a call or changing state", async () => {
    const repository = newRepository({ previews: [changePreview] });
    const stateBefore = await repository.getControlState();
    const callsBefore = repository.calls.length;
    const getterCalls = { count: 0 };

    const prototypeTrap = new Proxy({
      managementTenantId: MANAGEMENT_TENANT_ID,
      previewRef: changePreview.previewRef,
    }, {
      getPrototypeOf(): never {
        throw new Error("prototype trap leaked");
      },
      get(): never {
        getterCalls.count += 1;
        throw new Error("getter leaked");
      },
    }) as unknown as GetModulePreviewQuery;
    const ownKeysTrap = new Proxy({
      managementTenantId: MANAGEMENT_TENANT_ID,
      previewRef: changePreview.previewRef,
    }, {
      ownKeys(): never {
        throw new Error("ownKeys trap leaked");
      },
      get(): never {
        getterCalls.count += 1;
        throw new Error("getter leaked");
      },
    }) as unknown as GetModulePreviewQuery;

    for (const hostile of [prototypeTrap, ownKeysTrap]) {
      await expect(repository.getPreview(hostile)).rejects.toMatchObject({
        name: "ModuleControlRepositoryError",
        code: "invalid_state",
        message: "The module control record is invalid.",
      });
    }

    expect(getterCalls.count).toBe(0);
    expect(repository.calls).toHaveLength(callsBefore);
    expect(await repository.getControlState()).toEqual(stateBefore);
  });

  type FailurePhase =
    | "method_entry"
    | "after_domain_write"
    | "after_event"
    | "after_idempotency"
    | "after_release_status_change";

  function queueFailureAt(
    repository: FakeModuleControlRepository,
    method: Parameters<FakeModuleControlRepository["queueFailure"]>[0],
    phase: FailurePhase,
  ): void {
    repository.queueFailure(method, "not_found", phase);
  }

  async function preparePendingRelease(
    repository: ModuleControlRepository,
  ): Promise<void> {
    await repository.createPreview(previewRequest);
    await repository.decideApproval(approvalRequest);
    await repository.publishRelease(publishRequest);
  }

  function readbackVariant(
    source: ReadbackFixtureRequest,
    values: {
      readonly readbackRef: string;
      readonly status: "pending" | "verified" | "mismatch" | "unknown";
      readonly appliedReleaseId: string | null;
      readonly appliedRevision: number | null;
      readonly appliedModules: readonly ModuleControlRef[];
      readonly reasonCodes: readonly string[];
    },
  ): ReadbackFixtureRequest {
    const request = structuredClone(source);
    Reflect.set(request.record, "readbackRef", values.readbackRef);
    Reflect.set(request.record, "status", values.status);
    Reflect.set(request.record, "appliedReleaseId", values.appliedReleaseId);
    Reflect.set(request.record, "appliedRevision", values.appliedRevision);
    Reflect.set(request.record, "appliedModules", values.appliedModules);
    Reflect.set(request.record, "reasonCodes", values.reasonCodes);
    Reflect.set(request.metadata.event, "status", values.status);
    Reflect.set(request.metadata.event, "reasonCodes", values.reasonCodes);
    Reflect.set(request.metadata.event.detail, "readbackRef", values.readbackRef);
    Reflect.set(request.metadata.event.detail, "status", values.status);
    return request;
  }

  function invalidRegistrationFinalResult(): RegisterModuleRecordRequest {
    const request = structuredClone(registerRequest) as RegisterModuleRecordRequest;
    Reflect.set(request.finalResult, "domainRecordRef", "registration:wrong:1.0.0:sha256:deadbeef");
    return request;
  }

  it("validates a simple-write finalResult before any domain, event, or idempotency write", async () => {
    const repository = newRepository();

    await expect(
      repository.registerModule(invalidRegistrationFinalResult()),
    ).rejects.toMatchObject({ code: "conflict" });

    const state = await repository.getControlState();
    expect(state.registrations).toEqual([]);
    expect(state.events).toEqual([]);
    expect(await repository.getIdempotency(exactIdempotencyQuery())).toBeNull();
  });

  it("uses seeded idempotency as the sole restart replay authority and rejects hash drift", async () => {
    const records = {
      registrations: [registrationRecord],
      idempotency: [completedIdempotencyRecord],
      events: [registrationEvent],
    } as const satisfies FakeModuleControlRepositoryRecords;
    const replayRepository = newRepository(records);

    const replay = await replayRepository.registerModule(registerRequest);
    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(registrationRecord);
    expect(replay.event).toEqual(registrationEvent);
    expect((await replayRepository.getControlState()).events).toEqual([registrationEvent]);

    const conflictRepository = newRepository(records);
    const changedHash = structuredClone(registerRequest) as RegisterModuleRecordRequest;
    Reflect.set(
      changedHash.metadata,
      "requestHash",
      `mcp-control-hash/v1/request/sha256:${"e".repeat(64)}`,
    );
    await expect(conflictRepository.registerModule(changedHash)).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await conflictRepository.getControlState()).events).toEqual([registrationEvent]);
  });

  it("rebuilds publish replay solely from seeded persisted records and events", async () => {
    const activePublishedRelease = {
      ...pendingRelease,
      status: "active_verified",
      readbackRef: readbackForPublishedRelease.readbackRef,
    } as const satisfies ModuleActiveVerifiedReleaseRecord;
    const publishDomainEvent = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      eventId: "event_seed_publish_001",
      sequence: 1,
      actorRef: pendingRelease.publisherActorRef,
      ...publishEventInput,
      occurredAt: pendingRelease.createdAt,
    } as const satisfies ControlEventRecord;
    const publishReadbackEvent = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      eventId: "event_seed_readback_002",
      sequence: 2,
      actorRef: sameKeyReadbackRequest.metadata.actorRef,
      ...readbackEventInput,
      occurredAt: readbackForPublishedRelease.checkedAt,
    } as const satisfies ControlEventRecord;
    const repository = newRepository({
      previews: [{ ...changePreview, consumed: true }],
      approvals: [{ ...approvalRecord, consumed: true }],
      releases: [activePublishedRelease],
      readbacks: [readbackForPublishedRelease],
      idempotency: [publishDomainCommittedIdempotencyRecord],
      events: [publishDomainEvent, publishReadbackEvent],
    });

    const publishReplay = await repository.publishRelease(publishRequest);

    expect(publishReplay).toMatchObject({ replayed: true, event: publishDomainEvent });
    expect((await repository.getControlState()).events).toEqual([
      publishDomainEvent,
      publishReadbackEvent,
    ]);
  });

  it.each([
    "after_domain_write",
    "after_event",
    "after_idempotency",
  ] as const)(
    "rolls registerModule back at %s and preserves the queued phase across pre-validation failure",
    async (phase) => {
      const repository = newRepository();
      queueFailureAt(repository, "registerModule", phase);

      await expect(
        repository.registerModule(invalidRegistrationFinalResult()),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(repository.registerModule(registerRequest)).rejects.toMatchObject({
        code: "not_found",
      });

      expect((await repository.getControlState()).events).toEqual([]);
      expect((await repository.getControlState()).registrations).toEqual([]);
      expect(await repository.getIdempotency(exactIdempotencyQuery())).toBeNull();

      const success = await repository.registerModule(registerRequest);
      expect(success.event.sequence).toBe(1);
    },
  );

  it("rolls preview and approval writes back after their final persistence phases", async () => {
    const previewRepository = newRepository();
    queueFailureAt(previewRepository, "createPreview", "after_idempotency");
    await expect(previewRepository.createPreview(previewRequest)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await previewRepository.getPreview(exactPreviewQuery())).toBeNull();
    expect((await previewRepository.getControlState()).events).toEqual([]);

    const approvalRepository = newRepository({ previews: [changePreview] });
    queueFailureAt(approvalRepository, "decideApproval", "after_event");
    await expect(approvalRepository.decideApproval(approvalRequest)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await approvalRepository.getApproval(exactApprovalQuery())).toBeNull();
    expect((await approvalRepository.getControlState()).events).toEqual([]);
  });

  it("rolls every simple-write persistence phase back without consuming an event sequence", async () => {
    const phases = [
      "method_entry",
      "after_domain_write",
      "after_event",
      "after_idempotency",
    ] as const;
    const cases = [
      {
        method: "registerModule" as const,
        create: () => newRepository(),
        run: (repository: FakeModuleControlRepository) => repository.registerModule(registerRequest),
        lookup: (repository: FakeModuleControlRepository) => repository.getIdempotency(exactIdempotencyQuery()),
      },
      {
        method: "createPreview" as const,
        create: () => newRepository(),
        run: (repository: FakeModuleControlRepository) => repository.createPreview(previewRequest),
        lookup: (repository: FakeModuleControlRepository) => repository.getPreview(exactPreviewQuery()),
      },
      {
        method: "decideApproval" as const,
        create: () => newRepository({ previews: [changePreview] }),
        run: (repository: FakeModuleControlRepository) => repository.decideApproval(approvalRequest),
        lookup: (repository: FakeModuleControlRepository) => repository.getApproval(exactApprovalQuery()),
      },
    ];

    for (const testCase of cases) {
      for (const phase of phases) {
        const repository = testCase.create();
        const eventsBefore = (await repository.getControlState()).events;
        queueFailureAt(repository, testCase.method, phase);
        await expect(testCase.run(repository)).rejects.toMatchObject({ code: "not_found" });
        expect(await testCase.lookup(repository)).toBeNull();
        expect((await repository.getControlState()).events).toEqual(eventsBefore);
        const success = await testCase.run(repository);
        expect(success.event.sequence).toBe(1);
      }
    }
  });

  it("rolls publish consumption, release, idempotency, event, and sequence back together", async () => {
    const repository = newRepository();
    await repository.createPreview(previewRequest);
    await repository.decideApproval(approvalRequest);
    const eventsBefore = (await repository.getControlState()).events;
    queueFailureAt(repository, "publishRelease", "after_release_status_change");

    const invalidCas = structuredClone(publishRequest) as PublishReleaseRecordRequest;
    Reflect.set(invalidCas.record, "revision", 9);
    await expect(repository.publishRelease(invalidCas)).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.publishRelease(publishRequest)).rejects.toMatchObject({
      code: "not_found",
    });

    expect(await repository.getRelease(exactReleaseQuery(MANAGEMENT_TENANT_ID, pendingRelease.releaseId))).toBeNull();
    expect(await repository.getIdempotency({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: publishRequest.metadata.action,
      idempotencyKey: publishRequest.metadata.idempotencyKey,
    })).toBeNull();
    expect(await repository.getPreview(exactPreviewQuery())).toMatchObject({ consumed: false });
    expect(await repository.getApproval(exactApprovalQuery())).toMatchObject({ consumed: false });
    expect((await repository.getControlState()).events).toEqual(eventsBefore);

    const success = await repository.publishRelease(publishRequest);
    expect(success.event.sequence).toBe(eventsBefore.length + 1);
  });

  it("rolls every publish persistence phase back, including idempotency and consume updates", async () => {
    const phases = [
      "method_entry",
      "after_idempotency",
      "after_release_status_change",
      "after_domain_write",
      "after_event",
    ] as const;

    for (const phase of phases) {
      const repository = newRepository();
      await repository.createPreview(previewRequest);
      await repository.decideApproval(approvalRequest);
      const eventsBefore = (await repository.getControlState()).events;
      queueFailureAt(repository, "publishRelease", phase);

      await expect(repository.publishRelease(publishRequest)).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await repository.getPreview(exactPreviewQuery())).toMatchObject({ consumed: false });
      expect(await repository.getApproval(exactApprovalQuery())).toMatchObject({ consumed: false });
      expect(await repository.getRelease(exactReleaseQuery(MANAGEMENT_TENANT_ID, pendingRelease.releaseId))).toBeNull();
      expect(await repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: "deployments.publish",
        idempotencyKey: publishRequest.metadata.idempotencyKey,
      })).toBeNull();
      expect((await repository.getControlState()).events).toEqual(eventsBefore);

      const success = await repository.publishRelease(publishRequest);
      expect(success.event.sequence).toBe(eventsBefore.length + 1);
    }
  });

  it("enforces one terminal approval per tenant and preview with zero effects on the loser", async () => {
    const repository = newRepository();
    await repository.createPreview(previewRequest);
    await repository.decideApproval(approvalRequest);
    const stateBefore = await repository.getControlState();
    const second = structuredClone(approvalRequest) as DecideApprovalRecordRequest;
    Reflect.set(second.metadata, "idempotencyKey", "idem_approval_002");
    Reflect.set(second.record, "approvalId", "approval_002");
    Reflect.set(second.metadata.event, "objectRef", "approval_002");
    Reflect.set(second.metadata.event.detail, "approvalId", "approval_002");
    Reflect.set(second.finalResult, "domainRecordRef", "approval_002");
    const secondApprovalData = second.finalResult.envelope.data;
    if (secondApprovalData === null) throw new Error("approval result data is required");
    Reflect.set(secondApprovalData, "approval_id", "approval_002");

    await expect(repository.decideApproval(second)).rejects.toMatchObject({ code: "conflict" });
    expect(await repository.getApproval({
      managementTenantId: MANAGEMENT_TENANT_ID,
      approvalId: "approval_002",
    })).toBeNull();
    expect(await repository.getControlState()).toEqual(stateBefore);
  });

  it("enforces publish base CAS, unresolved gate, fixed release identity, and preview/approval consumption", async () => {
    const repository = newRepository();
    await repository.createPreview(previewRequest);
    await repository.decideApproval(approvalRequest);

    const badCas = structuredClone(publishRequest) as PublishReleaseRecordRequest;
    Reflect.set(badCas.record, "revision", 2);
    await expect(repository.publishRelease(badCas)).rejects.toMatchObject({ code: "conflict" });

    const first = await repository.publishRelease(publishRequest);
    expect(first.replayed).toBe(false);
    expect(await repository.getPreview(exactPreviewQuery())).toMatchObject({ consumed: true });
    expect(await repository.getApproval(exactApprovalQuery())).toMatchObject({ consumed: true });

    const competing = structuredClone(publishRequest) as PublishReleaseRecordRequest;
    Reflect.set(competing.metadata, "idempotencyKey", "idem_publish_competing");
    Reflect.set(competing.record, "releaseId", "release_competing_002");
    Reflect.set(competing.record, "revision", 2);
    Reflect.set(competing.record, "previousReleaseId", pendingRelease.releaseId);
    Reflect.set(competing.metadata.event, "objectRef", "release_competing_002");
    Reflect.set(competing.metadata.event.detail, "releaseId", "release_competing_002");
    Reflect.set(competing.metadata.event.detail, "revision", 2);
    await expect(repository.publishRelease(competing)).rejects.toMatchObject({ code: "conflict" });

    const replay = await repository.publishRelease(publishRequest);
    expect(replay.replayed).toBe(true);
    expect(replay.record.releaseId).toBe(pendingRelease.releaseId);
  });

  it("returns closed before snapshotting hostile parameters and never pollutes calls", async () => {
    const repository = newRepository();
    await repository.close();
    const callsBefore = repository.calls.length;
    const hostile = Object.create(null) as GetModulePreviewQuery;
    Object.defineProperty(hostile, "managementTenantId", {
      enumerable: true,
      get(): never {
        throw new Error("getter must not execute");
      },
    });

    await expect(repository.getPreview(hostile)).rejects.toMatchObject({ code: "closed" });
    expect(repository.calls).toHaveLength(callsBefore);
  });

  it("rejects deep, oversized-array, and oversized-node snapshots without recording a call", async () => {
    const cases: RegisterModuleRecordRequest[] = [];

    const deep = structuredClone(registerRequest) as RegisterModuleRecordRequest;
    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let depth = 0; depth < 70; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.next = child;
      nested = child;
    }
    Reflect.set(deep.finalResult.envelope, "too_deep", root);
    cases.push(deep);

    const hugeArray = structuredClone(registerRequest) as RegisterModuleRecordRequest;
    Reflect.set(hugeArray.metadata.event, "reasonCodes", Array.from({ length: 10_001 }, () => "x"));
    cases.push(hugeArray);

    const hugeNodes = structuredClone(registerRequest) as RegisterModuleRecordRequest;
    const nodes: Record<string, number> = {};
    for (let index = 0; index < 100_001; index += 1) nodes[`n${index}`] = index;
    Reflect.set(hugeNodes.finalResult.envelope, "too_many_nodes", nodes);
    cases.push(hugeNodes);

    for (const request of cases) {
      const repository = newRepository();
      await expect(repository.registerModule(request)).rejects.toMatchObject({ code: "invalid_state" });
      expect(repository.calls).toEqual([]);
      expect((await repository.getControlState()).events).toEqual([]);
    }
  });

  it("rejects accessor, cycle, and sparse snapshots without invoking getters or recording calls", async () => {
    let getterCalls = 0;
    const accessor = structuredClone(registerRequest);
    Object.defineProperty(accessor.finalResult.envelope, "hostile", {
      enumerable: true,
      get(): string {
        getterCalls += 1;
        return "forbidden";
      },
    });
    const cyclic = structuredClone(registerRequest);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    Reflect.set(cyclic.finalResult.envelope, "cycle", cycle);
    const sparse = structuredClone(registerRequest);
    Reflect.set(sparse.metadata.event, "reasonCodes", new Array<string>(1));

    for (const request of [accessor, cyclic, sparse]) {
      const repository = newRepository();
      await expect(repository.registerModule(request)).rejects.toMatchObject({ code: "invalid_state" });
      expect(repository.calls).toEqual([]);
    }
    expect(getterCalls).toBe(0);
  });

  it.each([
    {
      label: "registration",
      kind: "registration",
      prepare: async (repository: FakeModuleControlRepository): Promise<void> => {
        await repository.registerModule(registerRequest);
      },
    },
    {
      label: "preview",
      kind: "preview",
      prepare: async (repository: FakeModuleControlRepository): Promise<void> => {
        await repository.createPreview(previewRequest);
      },
    },
    {
      label: "approval",
      kind: "approval",
      prepare: async (repository: FakeModuleControlRepository): Promise<void> => {
        await repository.createPreview(previewRequest);
        await repository.decideApproval(approvalRequest);
      },
    },
    {
      label: "release",
      kind: "release",
      prepare: async (repository: FakeModuleControlRepository): Promise<void> => {
        await preparePendingRelease(repository);
      },
    },
  ] as const)(
    "rejects a duplicated authoritative $label lifecycle event on full-graph read",
    async ({ kind, prepare }) => {
      const repository = newRepository();
      await prepare(repository);
      await expect(repository.getControlState()).resolves.toBeDefined();

      const internals = repository as unknown as {
        eventAuthorityKeys: Map<string, string>;
        eventRecords: ControlEventRecord[];
      };
      const authoritativeEvent = internals.eventRecords.at(-1);
      if (authoritativeEvent === undefined || authoritativeEvent.kind !== kind) {
        throw new Error(`expected final ${kind} lifecycle event`);
      }
      const duplicate = {
        ...authoritativeEvent,
        eventId: `${authoritativeEvent.eventId}_duplicate`,
        sequence: authoritativeEvent.sequence + 1,
      } as ControlEventRecord;
      expect({
        ...duplicate,
        eventId: authoritativeEvent.eventId,
        sequence: authoritativeEvent.sequence,
      }).toEqual(authoritativeEvent);
      const authorityKey = internals.eventAuthorityKeys.get(
        authoritativeEvent.eventId,
      );
      if (authorityKey === undefined) {
        throw new Error("expected persisted idempotency authority relation");
      }
      internals.eventAuthorityKeys.set(duplicate.eventId, authorityKey);
      internals.eventRecords.push(duplicate);

      await expect(repository.getControlState()).rejects.toMatchObject({
        code: "invalid_state",
      });
    },
  );

  it("rejects a persisted readback event whose action drifts from its mapped authority", async () => {
    const repository = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
    });
    await preparePendingRelease(repository);
    const claim = await repository.claimReadbackAttempt(
      attemptClaimRequest({ readbackRef: readbackForPublishedRelease.readbackRef }),
    );
    if (claim.disposition !== "created") throw new Error("claim was not created");
    await repository.finalizeReadbackAndComplete({
      attemptId: claim.attempt.attemptId,
      ownerCapability: claim.ownerCapability,
      observation: verifiedAttemptObservation,
      finalResult: publishFinalResult,
      finalizedAt: verifiedAttemptObservation.checkedAt,
    });
    await expect(repository.getControlState()).resolves.toBeDefined();

    const internals = repository as unknown as {
      eventRecords: ControlEventRecord[];
    };
    const eventIndex = internals.eventRecords.findIndex(
      (event) => event.kind === "reconciliation",
    );
    const readbackEvent = internals.eventRecords[eventIndex];
    if (readbackEvent === undefined) {
      throw new Error("expected persisted readback lifecycle event");
    }
    internals.eventRecords[eventIndex] = {
      ...readbackEvent,
      action: "deployments.reconcile",
    } as ControlEventRecord;

    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it.each([
    {
      label: "historical preview diff",
      corrupt: (repository: FakeModuleControlRepository): void => {
        const internals = repository as unknown as {
          previewRecords: Map<string, ModuleChangePreviewRecord>;
        };
        const key = `${MANAGEMENT_TENANT_ID}\0${changePreview.previewRef}`;
        const preview = internals.previewRecords.get(key);
        if (preview === undefined) throw new Error("historical preview is missing");
        internals.previewRecords.set(key, {
          ...preview,
          diff: { added: [], removed: [], retained: [] },
        });
      },
    },
    {
      label: "historical preview validation",
      corrupt: (repository: FakeModuleControlRepository): void => {
        const internals = repository as unknown as {
          previewRecords: Map<string, ModuleChangePreviewRecord>;
        };
        const key = `${MANAGEMENT_TENANT_ID}\0${changePreview.previewRef}`;
        const preview = internals.previewRecords.get(key);
        if (preview === undefined) throw new Error("historical preview is missing");
        internals.previewRecords.set(key, {
          ...preview,
          validation: {
            ...preview.validation,
            inventoryMatches: false,
            reasonCodes: ["preview.invalid"],
          },
        });
      },
    },
  ])("rejects $label corruption before bounded projection", async ({ corrupt }) => {
    const repository = newRepository(validReleaseChainRecords());
    corrupt(repository);

    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("rejects a rollback target missing outside the returned release projection", async () => {
    const validChain = validReleaseChainRecords();
    const rollback = {
      ...changePreview,
      previewRef: "preview_read_rollback_003",
      baseReleaseId: "release_chain_002",
      baseRevision: 2,
      inventoryRefs: [moduleRef, secondModuleRef],
      desiredModules: [moduleRef],
      diff: {
        added: [moduleRef],
        removed: [secondModuleRef],
        retained: [],
      },
      createdAt: "2026-08-22T00:12:00Z",
      expiresAt: "2026-08-22T03:00:00Z",
      consumed: false,
      intent: "rollback",
      targetReleaseId: activeRelease.releaseId,
    } as const satisfies ModuleRollbackPreviewRecord;
    const repository = newRepository({
      ...validChain,
      previews: [...(validChain.previews ?? []), rollback],
    });
    const internals = repository as unknown as {
      previewRecords: Map<string, ModuleChangePreviewRecord | ModuleRollbackPreviewRecord>;
    };
    internals.previewRecords.set(
      `${MANAGEMENT_TENANT_ID}\0${rollback.previewRef}`,
      { ...rollback, targetReleaseId: "release_missing" },
    );

    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("rejects a full-graph sequence gap even when the missing sequence is outside the 256-event window", async () => {
    const repository = newRepository(registrationEventHistory(258));
    const internals = repository as unknown as {
      eventRecords: ControlEventRecord[];
    };
    const secondEvent = internals.eventRecords[1];
    if (secondEvent === undefined) throw new Error("event window fixture is incomplete");
    internals.eventRecords[1] = { ...secondEvent, sequence: 3 };

    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it.each([
    {
      label: "actor",
      corrupt: (event: ControlEventRecord) => ({ ...event, actorRef: "actor_forged" }),
    },
    {
      label: "status",
      corrupt: (event: ControlEventRecord) => ({ ...event, status: "completed" } as ControlEventRecord),
    },
    {
      label: "reason",
      corrupt: (event: ControlEventRecord) => ({ ...event, reasonCodes: ["forged.reason"] }),
    },
    {
      label: "detail",
      corrupt: (event: ControlEventRecord) => ({
        ...event,
        detail: { ...event.detail, status: "completed" },
      } as ControlEventRecord),
    },
    {
      label: "objectRef",
      corrupt: (event: ControlEventRecord) => ({ ...event, objectRef: "forged_object" }),
    },
  ])("rejects a forged $label in an event older than the returned window", async ({ corrupt }) => {
    const repository = newRepository(registrationEventHistory(258));
    const internals = repository as unknown as {
      eventRecords: ControlEventRecord[];
    };
    const firstEvent = internals.eventRecords[0];
    if (firstEvent === undefined) throw new Error("event window fixture is incomplete");
    internals.eventRecords[0] = corrupt(firstEvent);

    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("rejects a durable idempotency actorRef forged behind the returned event window", async () => {
    const repository = newRepository(registrationEventHistory(258));
    const internals = repository as unknown as {
      idempotencyRecords: Map<string, ModuleControlIdempotencyRecord>;
    };
    const [key, record] = [...internals.idempotencyRecords.entries()][0] ?? [];
    if (key === undefined || record === undefined) {
      throw new Error("idempotency fixture is incomplete");
    }
    internals.idempotencyRecords.set(key, {
      ...record,
      actorRef: "actor_forged",
    });

    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("rejects duplicate and cross-record-impossible seeds instead of overwriting them", () => {
    const impossibleSeeds: readonly FakeModuleControlRepositoryRecords[] = [
      { registrations: [registrationRecord, registrationRecord] },
      { events: [registrationEvent, { ...secondEvent, sequence: registrationEvent.sequence }] },
      { releases: [pendingRelease] },
      { readbacks: [pendingReadback] },
      { idempotency: [completedIdempotencyRecord] },
    ];

    for (const records of impossibleSeeds) {
      expect(() => newRepository(records)).toThrowError(
        expect.objectContaining({ code: "invalid_state" }),
      );
    }
  });

  it("rejects seeded preview diffs and every validation field that disagrees with authority", () => {
    const invalidPreviews: ModuleChangePreviewRecord[] = [];

    const wrongDiff = structuredClone(changePreview) as ModuleChangePreviewRecord;
    Reflect.set(wrongDiff, "diff", { added: [], removed: [], retained: [] });
    invalidPreviews.push(wrongDiff);

    for (const key of [
      "baseMatches",
      "desiredModulesValid",
      "inventoryMatches",
      "minimumActiveModules",
    ] as const) {
      const drift = structuredClone(changePreview) as ModuleChangePreviewRecord;
      Reflect.set(drift.validation, key, false);
      Reflect.set(drift.validation, "reasonCodes", ["preview.invalid"]);
      invalidPreviews.push(drift);
    }

    const wrongReasons = structuredClone(changePreview) as ModuleChangePreviewRecord;
    Reflect.set(wrongReasons.validation, "reasonCodes", ["preview.invalid"]);
    invalidPreviews.push(wrongReasons);

    for (const preview of invalidPreviews) {
      expect(() => newRepository({ previews: [preview] })).toThrowError(
        expect.objectContaining({ code: "invalid_state" }),
      );
    }
  });

  it("rejects missing, illegal-status, and module-mismatched rollback targets", () => {
    const validChain = validReleaseChainRecords();
    const rollback = {
      ...changePreview,
      previewRef: "preview_seed_rollback_003",
      baseReleaseId: "release_chain_002",
      baseRevision: 2,
      inventoryRefs: [moduleRef, secondModuleRef],
      desiredModules: [moduleRef],
      diff: {
        added: [moduleRef],
        removed: [secondModuleRef],
        retained: [],
      },
      createdAt: "2026-08-22T00:12:00Z",
      expiresAt: "2026-08-22T03:00:00Z",
      intent: "rollback",
      targetReleaseId: activeRelease.releaseId,
    } as const satisfies ModuleRollbackPreviewRecord;
    expect(() => newRepository({
      ...validChain,
      previews: [...(validChain.previews ?? []), rollback],
    })).not.toThrow();

    const missing = { ...rollback, targetReleaseId: "release_missing" };
    expect(() => newRepository({
      ...validChain,
      previews: [...(validChain.previews ?? []), missing],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));

    const mismatched = {
      ...rollback,
      desiredModules: [secondModuleRef],
      diff: { added: [], removed: [], retained: [secondModuleRef] },
    };
    expect(() => newRepository({
      ...validChain,
      previews: [...(validChain.previews ?? []), mismatched],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));

    const pendingGraph = validPendingAuthorityGraph();
    const illegalStatusTarget = {
      ...changePreview,
      previewRef: "preview_seed_rollback_pending_target",
      createdAt: "2026-08-22T00:10:00Z",
      expiresAt: "2026-08-22T02:00:00Z",
      intent: "rollback",
      targetReleaseId: pendingRelease.releaseId,
    } as const satisfies ModuleRollbackPreviewRecord;
    expect(() => newRepository({
      ...pendingGraph,
      previews: [...(pendingGraph.previews ?? []), illegalStatusTarget],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("rejects an event sequence gap even when the missing row is outside the 256-event projection", () => {
    const records = registrationEventHistory(257);
    const events = (records.events ?? []).map((event, index) => ({
      ...event,
      sequence: index === 0 ? 1 : index + 2,
    }));
    expect(events.at(-1)?.sequence).toBe(258);
    expect(() => newRepository({
      ...records,
      events,
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("orders the complete seeded event graph by RFC3339 instant", () => {
    const registrationGraph = (
      firstAt: string,
      secondAt: string,
    ): FakeModuleControlRepositoryRecords => {
      const firstRegistration = { ...registrationRecord, registeredAt: firstAt };
      const secondRegistration = { ...secondRegistrationRecord, registeredAt: secondAt };
      const secondRef =
        `registration:${secondRegistration.moduleId}:${secondRegistration.version}:${secondRegistration.descriptorDigest}`;
      const firstExpiresAt = firstAt.includes("000000002")
        ? "2026-08-23T00:00:00.000000002Z"
        : "2026-08-23T00:00:00.000000001Z";
      const secondExpiresAt = secondAt.includes("000000002")
        ? "2026-08-23T00:00:00.000000002Z"
        : "2026-08-23T00:00:00.000000001Z";
      const firstAuthority = {
        ...completedIdempotencyRecord,
        createdAt: firstAt,
        expiresAt: firstExpiresAt,
      } as ModuleControlIdempotencyRecord;
      const secondAuthority = {
        ...completedIdempotencyRecord,
        idempotencyKey: "idem_register_event_order_002",
        domainRecordRef: secondRef,
        finalResult: {
          domainRecordRef: secondRef,
          envelope: {
            ...registrationEnvelope,
            data: {
              ...registrationEnvelope.data,
              module_id: secondRegistration.moduleId,
              version: secondRegistration.version,
              descriptor_digest: secondRegistration.descriptorDigest,
            },
          },
        },
        createdAt: secondAt,
        expiresAt: secondExpiresAt,
      } as ModuleControlIdempotencyRecord;
      const firstEvent = {
        ...registrationEvent,
        occurredAt: firstAt,
      } as ControlEventRecord;
      const secondEvent = {
        ...registrationEvent,
        eventId: "event_registration_order_002",
        sequence: 2,
        objectRef: secondRef,
        detail: {
          ...registrationEvent.detail,
          recordRef: secondRef,
          moduleId: secondRegistration.moduleId,
          version: secondRegistration.version,
          descriptorDigest: secondRegistration.descriptorDigest,
        },
        occurredAt: secondAt,
      } as ControlEventRecord;
      return {
        registrations: [firstRegistration, secondRegistration],
        idempotency: [firstAuthority, secondAuthority],
        events: [firstEvent, secondEvent],
      };
    };

    expect(() => newRepository(registrationGraph(
      "2026-08-22T00:00:00.000000001Z",
      "2026-08-21T19:00:00.000000001-05:00",
    ))).not.toThrow();
    expect(() => newRepository(registrationGraph(
      "2026-08-22T00:00:00.000000002Z",
      "2026-08-22T00:00:00.000000001Z",
    ))).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("rejects seeded domain and idempotency audit events whose authority bindings drift", () => {
    const registrationGraph = {
      registrations: [registrationRecord],
      idempotency: [completedIdempotencyRecord],
      events: [registrationEvent],
    } as const satisfies FakeModuleControlRepositoryRecords;
    const previewGraph = {
      previews: [changePreview],
      idempotency: [previewSeedIdempotency],
      events: [previewSeedEvent],
    } as const satisfies FakeModuleControlRepositoryRecords;
    const approvalGraph = {
      previews: [changePreview],
      approvals: [approvalRecord],
      idempotency: [previewSeedIdempotency, approvalSeedIdempotency],
      events: [previewSeedEvent, approvalSeedEvent],
    } as const satisfies FakeModuleControlRepositoryRecords;

    const actorDrifts = [registrationGraph, previewGraph, approvalGraph].map((graph) => {
      const drift = structuredClone(graph) as FakeModuleControlRepositoryRecords;
      const last = drift.events?.at(-1);
      if (last === undefined) throw new Error("event fixture is incomplete");
      Reflect.set(last, "actorRef", "actor_wrong");
      return drift;
    });
    for (const drift of actorDrifts) {
      expect(() => newRepository(drift)).toThrowError(
        expect.objectContaining({ code: "invalid_state" }),
      );
    }

    const registrationReasons = structuredClone(registrationGraph) as FakeModuleControlRepositoryRecords;
    Reflect.set(registrationReasons.events?.[0] ?? {}, "reasonCodes", ["unexpected.reason"]);
    expect(() => newRepository(registrationReasons)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const registrationDetail = structuredClone(registrationGraph) as FakeModuleControlRepositoryRecords;
    Reflect.set(registrationDetail.events?.[0]?.detail ?? {}, "recordRef", "registration:wrong");
    expect(() => newRepository(registrationDetail)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const releaseStatus = structuredClone(validPendingAuthorityGraph());
    const releaseEvent = releaseStatus.events?.find((event) => event.kind === "release");
    if (releaseEvent === undefined) throw new Error("release event fixture is incomplete");
    Reflect.set(releaseEvent, "status", "active_verified");
    Reflect.set(releaseEvent.detail, "status", "active_verified");
    expect(() => newRepository(releaseStatus)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const readbackGraph = validPendingAuthorityGraph();
    const pendingReadbackEvent = {
      ...readbackEventInput,
      managementTenantId: MANAGEMENT_TENANT_ID,
      eventId: "event_pending_seed_004",
      sequence: 4,
      actorRef: pendingRelease.publisherActorRef,
      status: "pending",
      detail: {
        ...readbackEventInput.detail,
        readbackRef: pendingReadback.readbackRef,
        status: "pending",
      },
      occurredAt: pendingReadback.checkedAt,
    } as const satisfies ControlEventRecord;
    const readbackActor = {
      ...readbackGraph,
      readbacks: [pendingReadback],
      events: [...(readbackGraph.events ?? []), { ...pendingReadbackEvent, actorRef: "actor_wrong" }],
    } satisfies FakeModuleControlRepositoryRecords;
    expect(() => newRepository(readbackActor)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const completionEvent = {
      ...registrationEvent,
      eventId: "event_idempotency_seed_002",
      sequence: 2,
      kind: "idempotency",
      status: "completed",
      reasonCodes: [],
      detail: {
        kind: "idempotency",
        recordRef: `idempotency:packages.register:${completedIdempotencyRecord.idempotencyKey}`,
        domainRecordRef: registrationRef,
        status: "completed",
      },
    } as const satisfies ControlEventRecord;
    const completionActor = {
      ...registrationGraph,
      events: [registrationEvent, { ...completionEvent, actorRef: "actor_wrong" }],
    } satisfies FakeModuleControlRepositoryRecords;
    expect(() => newRepository(completionActor)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const completionDetail = structuredClone({
      ...registrationGraph,
      events: [registrationEvent, completionEvent],
    }) as FakeModuleControlRepositoryRecords;
    Reflect.set(completionDetail.events?.[1]?.detail ?? {}, "recordRef", "idempotency:wrong");
    expect(() => newRepository(completionDetail)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });

  it("rejects a seeded reconcile graph when both terminal event actors drift together", () => {
    const reconcileRecord = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: "deployments.reconcile",
      idempotencyKey: "idem_reconcile_seed_001",
      requestHash: REQUEST_HASH,
      actorRef: "actor_reconciler",
      status: "completed",
      domainRecordRef: activeRelease.releaseId,
      finalResult: {
        domainRecordRef: activeRelease.releaseId,
        envelope: {
          ...publishFinalResult.envelope,
          request_id: "request_reconcile_seed_001",
          trace_id: "trace_reconcile_seed_001",
          audit_id: "audit_reconcile_seed_001",
          data: {
            kind: "reconciliation",
            release_id: activeRelease.releaseId,
            revision: activeRelease.revision,
            status: "verified",
          },
          readback: {
            status: "verified",
            release_id: activeRelease.releaseId,
            revision: activeRelease.revision,
          },
        },
      },
      createdAt: verifiedReadback.checkedAt,
      expiresAt: "2026-08-23T00:07:30Z",
    } as const satisfies ModuleControlIdempotencyRecord;
    const reconciliationEvent = {
      ...activeReadbackEvent,
      eventId: "event_reconcile_seed_004",
      sequence: 4,
      actorRef: "actor_reconciler",
      action: "deployments.reconcile",
      detail: {
        ...activeReadbackEvent.detail,
        readbackRef: verifiedReadback.readbackRef,
      },
    } as const satisfies ControlEventRecord;
    const completionEvent = {
      ...reconciliationEvent,
      eventId: "event_reconcile_completion_seed_005",
      sequence: 5,
      kind: "idempotency",
      objectRef: `idempotency:deployments.reconcile:${reconcileRecord.idempotencyKey}`,
      status: "completed",
      detail: {
        kind: "idempotency",
        recordRef: `idempotency:deployments.reconcile:${reconcileRecord.idempotencyKey}`,
        domainRecordRef: activeRelease.releaseId,
        status: "completed",
      },
      occurredAt: verifiedReadback.checkedAt,
    } as const satisfies ControlEventRecord;
    const graph = {
      ...seedRecords,
      idempotency: [...seedRecords.idempotency, reconcileRecord],
      events: [...seedRecords.events, reconciliationEvent, completionEvent],
    } as const satisfies FakeModuleControlRepositoryRecords;

    expect(() => newRepository(graph)).not.toThrow();
    expect(reconcileRecord.actorRef).toBe("actor_reconciler");
    expect(reconciliationEvent.actorRef).toBe(reconcileRecord.actorRef);
    expect(completionEvent.actorRef).toBe(reconcileRecord.actorRef);

    const drifted = structuredClone(graph) as FakeModuleControlRepositoryRecords;
    const terminalEvents = drifted.events?.filter(
      (event) =>
        event.action === "deployments.reconcile" &&
        (event.kind === "reconciliation" || event.kind === "idempotency"),
    );
    if (terminalEvents === undefined || terminalEvents.length !== 2) {
      throw new Error("reconcile graph fixture is incomplete");
    }
    for (const event of terminalEvents) Reflect.set(event, "actorRef", "actor_wrong");

    expect(() => newRepository(drifted)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });

  it("accepts two legal seeded reconcile attempts when every event has an explicit authority binding", () => {
    expect(() => newRepository(ambiguousReconcileSeedRecords(true))).not.toThrow();
  });

  it("rejects ambiguous seeded reconcile attempts instead of choosing the first authority", () => {
    expect(() => newRepository(ambiguousReconcileSeedRecords(false))).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });

  it("accepts pending seed releases with no readback or one pending readback attempt", async () => {
    const publishDomainEvent = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      eventId: "event_seed_pending_publish_001",
      sequence: 1,
      actorRef: pendingRelease.publisherActorRef,
      ...publishEventInput,
      occurredAt: pendingRelease.createdAt,
    } as const satisfies ControlEventRecord;
    const validPendingGraph = {
      previews: [{ ...changePreview, consumed: true }],
      approvals: [{ ...approvalRecord, consumed: true }],
      releases: [pendingRelease],
      idempotency: [publishDomainCommittedIdempotencyRecord],
      events: [publishDomainEvent],
    } as const satisfies FakeModuleControlRepositoryRecords;

    expect(() => newRepository(validPendingGraph)).not.toThrow();
    expect(() => newRepository({
      ...validPendingGraph,
      idempotency: [],
      events: [],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));

    const pendingReadbackEvent = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      eventId: "event_seed_pending_readback_002",
      sequence: 2,
      actorRef: sameKeyReadbackRequest.metadata.actorRef,
      ...readbackEventInput,
      status: "pending",
      detail: {
        ...readbackEventInput.detail,
        readbackRef: pendingReadback.readbackRef,
        status: "pending",
      },
      occurredAt: pendingReadback.checkedAt,
    } as const satisfies ControlEventRecord;
    const pendingWithReadback = {
      ...validPendingGraph,
      readbacks: [pendingReadback],
      events: [publishDomainEvent, pendingReadbackEvent],
    } as const satisfies FakeModuleControlRepositoryRecords;
    const pendingRepository = newRepository(pendingWithReadback);
    await expect(pendingRepository.health()).resolves.toEqual({ ready: true });
    await pendingRepository.close();
    const reopenedRepository = newRepository(pendingWithReadback);
    await expect(reopenedRepository.health()).resolves.toEqual({ ready: true });

    const mismatch = structuredClone(pendingWithReadback) as FakeModuleControlRepositoryRecords;
    const mismatchReadback = mismatch.readbacks?.[0];
    const mismatchEvent = mismatch.events?.find(
      (event) => event.kind === "reconciliation",
    );
    if (mismatchReadback === undefined || mismatchEvent === undefined) {
      throw new Error("pending readback fixture is incomplete");
    }
    Reflect.set(mismatchReadback, "status", "mismatch");
    Reflect.set(mismatchReadback, "reasonCodes", ["runtime.unavailable"]);
    Reflect.set(mismatchEvent, "status", "mismatch");
    Reflect.set(mismatchEvent, "reasonCodes", ["runtime.unavailable"]);
    Reflect.set(mismatchEvent.detail, "status", "mismatch");
    expect(() => newRepository(mismatch)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    expect(() => newRepository({
      ...pendingWithReadback,
      readbacks: [pendingReadback, { ...pendingReadback, readbackRef: "readback_pending_003" }],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));
    expect(() => newRepository({
      ...pendingWithReadback,
      events: [publishDomainEvent],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("requires published release timestamps and a strictly forward superseded chain with reverse links", () => {
    const valid = validReleaseChainRecords();
    expect(() => newRepository(valid)).not.toThrow();

    const activeWithoutPublishedAt = structuredClone(valid);
    const activeReleaseRecord = activeWithoutPublishedAt.releases?.find(
      (release) => release.releaseId === "release_chain_002",
    );
    if (activeReleaseRecord === undefined) throw new Error("chain fixture missing active release");
    Reflect.set(activeReleaseRecord, "publishedAt", null);
    expect(() => newRepository(activeWithoutPublishedAt)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const manualWithoutPublishedAt = structuredClone(valid);
    const manualRelease = manualWithoutPublishedAt.releases?.find(
      (release) => release.releaseId === "release_chain_002",
    );
    const manualReadback = manualWithoutPublishedAt.readbacks?.find(
      (readback) => readback.releaseId === "release_chain_002",
    );
    const manualReadbackEvent = manualWithoutPublishedAt.events?.find(
      (event) => event.objectRef === "release_chain_002" && event.kind === "reconciliation",
    );
    if (manualRelease === undefined || manualReadback === undefined || manualReadbackEvent === undefined) {
      throw new Error("chain fixture missing manual-review records");
    }
    Reflect.set(manualRelease, "status", "manual_review");
    Reflect.set(manualRelease, "publishedAt", null);
    Reflect.set(manualRelease, "reasonCodes", ["runtime.unavailable"]);
    Reflect.set(manualReadback, "status", "unknown");
    Reflect.set(manualReadback, "reasonCodes", ["runtime.unavailable"]);
    Reflect.set(manualReadbackEvent, "status", "unknown");
    Reflect.set(manualReadbackEvent, "reasonCodes", ["runtime.unavailable"]);
    Reflect.set(manualReadbackEvent.detail, "status", "unknown");
    expect(() => newRepository(manualWithoutPublishedAt)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const selfSuperseded = structuredClone(valid);
    const firstRelease = selfSuperseded.releases?.find(
      (release) => release.releaseId === activeRelease.releaseId,
    );
    if (firstRelease === undefined) throw new Error("chain fixture missing superseded release");
    Reflect.set(firstRelease, "supersededByReleaseId", firstRelease.releaseId);
    expect(() => newRepository(selfSuperseded)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const backwardSuperseded = structuredClone(valid);
    const latestRelease = backwardSuperseded.releases?.find(
      (release) => release.releaseId === "release_chain_002",
    );
    if (latestRelease === undefined) throw new Error("chain fixture missing latest release");
    Reflect.set(latestRelease, "status", "superseded");
    Reflect.set(latestRelease, "supersededByReleaseId", activeRelease.releaseId);
    expect(() => newRepository(backwardSuperseded)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });

  it("requires release, readback, event, and idempotency bindings with domain timestamps", () => {
    const valid = validReleaseChainRecords();

    const missingReadbackEvent = structuredClone(valid);
    Reflect.set(
      missingReadbackEvent,
      "events",
      missingReadbackEvent.events?.filter(
        (event) => !(event.objectRef === "release_chain_002" && event.kind === "reconciliation"),
      ),
    );
    expect(() => newRepository(missingReadbackEvent)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const wrongReadbackTime = structuredClone(valid);
    const latestReadbackEvent = wrongReadbackTime.events?.find(
      (event) => event.objectRef === "release_chain_002" && event.kind === "reconciliation",
    );
    if (latestReadbackEvent === undefined) throw new Error("chain fixture missing readback event");
    Reflect.set(latestReadbackEvent, "occurredAt", "2026-08-22T00:10:00Z");
    expect(() => newRepository(wrongReadbackTime)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const missingPublishAuthority = structuredClone(valid);
    Reflect.set(
      missingPublishAuthority,
      "idempotency",
      missingPublishAuthority.idempotency?.filter(
        (record) => record.idempotencyKey !== "idem_publish_chain_002",
      ),
    );
    expect(() => newRepository(missingPublishAuthority)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });

  it("rejects two independent registration authorities sharing one lifecycle event", () => {
    const secondKey = {
      ...completedIdempotencyRecord,
      idempotencyKey: "idem_register_002",
    } as const satisfies ModuleControlIdempotencyRecord;
    expect(() => newRepository({
      registrations: [registrationRecord],
      idempotency: [completedIdempotencyRecord, secondKey],
      events: [registrationEvent],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("rejects consumed preview or approval seeds that have no referencing release", () => {
    const impossibleSeeds: readonly FakeModuleControlRepositoryRecords[] = [
      { previews: [{ ...changePreview, consumed: true }] },
      {
        previews: [changePreview],
        approvals: [{ ...approvalRecord, consumed: true }],
      },
      {
        previews: [{ ...changePreview, consumed: true }],
        approvals: [{ ...approvalRecord, consumed: true }],
      },
    ];

    for (const records of impossibleSeeds) {
      expect(() => newRepository(records)).toThrowError(
        expect.objectContaining({ code: "invalid_state" }),
      );
    }
  });

  it("rejects a seeded release whose base revision does not identify its previous release", () => {
    const chainPreview = {
      ...changePreview,
      previewRef: "preview_chain_invalid",
      baseReleaseId: activeRelease.releaseId,
      baseRevision: 7,
      createdAt: "2026-08-22T00:08:00Z",
      expiresAt: "2026-08-22T02:00:00Z",
      consumed: true,
    } as const satisfies ModuleChangePreviewRecord;
    const chainApproval = {
      ...approvalRecord,
      approvalId: "approval_chain_invalid",
      previewRef: chainPreview.previewRef,
      previewCanonicalHash: chainPreview.canonicalHash,
      baseReleaseId: chainPreview.baseReleaseId,
      baseRevision: chainPreview.baseRevision,
      expiresAt: chainPreview.expiresAt,
      decidedAt: "2026-08-22T00:09:00Z",
      consumed: true,
    } as const satisfies ModuleApprovalRecord;
    const chainRelease = {
      ...pendingRelease,
      releaseId: "release_chain_invalid",
      revision: 8,
      previousReleaseId: activeRelease.releaseId,
      previewRef: chainPreview.previewRef,
      approvalId: chainApproval.approvalId,
      createdAt: "2026-08-22T00:10:00Z",
      publishedAt: "2026-08-22T00:11:00Z",
    } as const satisfies ModulePendingReleaseRecord;

    expect(() => newRepository({
      previews: [{ ...changePreview, consumed: true }, chainPreview],
      approvals: [{ ...approvalRecord, consumed: true }, chainApproval],
      releases: [activeRelease, chainRelease],
      readbacks: [verifiedReadback],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("requires a seeded completed publish to include its atomic completion event", async () => {
    const activePublishedRelease = {
      ...pendingRelease,
      status: "active_verified",
      readbackRef: readbackForPublishedRelease.readbackRef,
    } as const satisfies ModuleActiveVerifiedReleaseRecord;
    const publishDomainEvent = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      eventId: "event_publish_domain_001",
      sequence: 1,
      actorRef: pendingRelease.publisherActorRef,
      ...publishEventInput,
      occurredAt: pendingRelease.createdAt,
    } as const satisfies ControlEventRecord;
    const publishReadbackEvent = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      eventId: "event_publish_readback_002",
      sequence: 2,
      actorRef: readbackRequest.metadata.actorRef,
      ...readbackEventInput,
      objectRef: activePublishedRelease.releaseId,
      detail: {
        ...readbackEventInput.detail,
        releaseId: activePublishedRelease.releaseId,
        revision: activePublishedRelease.revision,
        readbackRef: readbackForPublishedRelease.readbackRef,
      },
      occurredAt: readbackForPublishedRelease.checkedAt,
    } as const satisfies ControlEventRecord;
    const publishCompletionEvent = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      eventId: "event_publish_completion_002",
      sequence: 3,
      actorRef: publishCompletionRequest.metadata.actorRef,
      ...publishCompletionEventInput,
      occurredAt: readbackForPublishedRelease.checkedAt,
    } as const satisfies ControlEventRecord;
    const baseRecords = {
      previews: [{ ...changePreview, consumed: true }],
      approvals: [{ ...approvalRecord, consumed: true }],
      releases: [activePublishedRelease],
      readbacks: [readbackForPublishedRelease],
      idempotency: [publishCompletionRequest.record],
    } as const satisfies FakeModuleControlRepositoryRecords;

    expect(() => newRepository({
      ...baseRecords,
      events: [publishDomainEvent, publishReadbackEvent],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));

    const repository = newRepository({
      ...baseRecords,
      events: [publishDomainEvent, publishReadbackEvent, publishCompletionEvent],
    });
    await expect(repository.health()).resolves.toEqual({ ready: true });
    expect((await repository.getControlState()).events).toEqual([
      publishDomainEvent,
      publishReadbackEvent,
      publishCompletionEvent,
    ]);
  });

  it("accepts offset-equivalent and equal publication instants but rejects a reverse nanosecond on Fake writes", async () => {
    const cases = [
      {
        label: "offset-equivalent instant",
        createdAt: "2026-08-22T00:06:00.000000001Z",
        publishedAt: "2026-08-21T19:06:00.000000001-05:00",
        accepted: true,
      },
      {
        label: "equal instant",
        createdAt: "2026-08-22T00:06:00.000000001Z",
        publishedAt: "2026-08-22T00:06:00.000000001Z",
        accepted: true,
      },
      {
        label: "reverse one nanosecond",
        createdAt: "2026-08-22T00:06:00.000000002Z",
        publishedAt: "2026-08-22T00:06:00.000000001Z",
        accepted: false,
      },
    ] as const;

    for (const testCase of cases) {
      const repository = newRepository();
      await repository.createPreview(previewRequest);
      await repository.decideApproval(approvalRequest);
      const request = {
        metadata: publishRequest.metadata,
        record: {
          ...pendingRelease,
          createdAt: testCase.createdAt,
          publishedAt: testCase.publishedAt,
        },
      } as const satisfies PublishReleaseRecordRequest;
      if (testCase.accepted) {
        await expect(repository.publishRelease(request), testCase.label).resolves.toMatchObject({
          record: { createdAt: testCase.createdAt, publishedAt: testCase.publishedAt },
        });
      } else {
        await expect(repository.publishRelease(request), testCase.label).rejects.toMatchObject({
          code: "invalid_state",
        });
        await expect(repository.getPendingRelease()).resolves.toBeNull();
      }
    }
  });

  it("rejects a reverse publication instant in a release older than the bounded Fake projection", async () => {
    const repository = boundaryHistoryRepository(129);
    const internals = repository as unknown as {
      releaseRecords: Map<string, ModuleReleaseRecord>;
    };
    const releaseKey = `${MANAGEMENT_TENANT_ID}\0release_boundary_1`;
    const release = internals.releaseRecords.get(releaseKey);
    if (release === undefined) throw new Error("boundary release is missing");
    internals.releaseRecords.set(releaseKey, {
      ...release,
      publishedAt: "2026-08-22T00:00:00Z",
    });

    await expect(repository.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("rejects seeded idempotency timestamps that cannot come from the persisted domain write", () => {
    const impossibleIdempotency = {
      ...completedIdempotencyRecord,
      createdAt: "2026-08-22T00:00:01Z",
      expiresAt: "2026-08-23T00:00:01Z",
    } as const satisfies ModuleControlIdempotencyRecord;

    expect(() => newRepository({
      registrations: [registrationRecord],
      idempotency: [impossibleIdempotency],
      events: [registrationEvent],
    })).toThrowError(expect.objectContaining({ code: "invalid_state" }));
  });

  it("matches SQLite for pending publishedAt null and still gates expiry by createdAt", async () => {
    const makeSqlite = async (suffix: string) => {
      const applicationRoot = realpathSync(
        mkdtempSync(join(tmpdir(), `fake-control-null-published-${suffix}-`)),
      );
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: `instance_null_published_${suffix}`,
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      return {
        applicationRoot,
        repository: openSqliteControlStore({
          applicationRoot,
          instanceId: `instance_null_published_${suffix}`,
          managementTenantId: MANAGEMENT_TENANT_ID,
          adminControlEnabled: true,
        }),
      };
    };
    const acceptedSqlite = await makeSqlite("accepted");
    const expiredSqlite = await makeSqlite("expired");
    const acceptedFake = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
    });
    const expiredFake = new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
      ownerBootId: "boot_current",
    });
    try {
      const acceptedRepositories = [acceptedFake, acceptedSqlite.repository] as const;
      for (const repository of acceptedRepositories) {
        await repository.createPreview(previewRequest);
        await repository.decideApproval(approvalRequest);
        await expect(repository.publishRelease({
          metadata: publishRequest.metadata,
          record: { ...pendingRelease, publishedAt: null },
        })).resolves.toMatchObject({
          replayed: false,
          record: { publishedAt: null, status: "published_pending_readback" },
        });
      }
      const acceptedFinalizations = [] as Awaited<ReturnType<ModuleControlReadbackAttemptRepository["finalizeReadbackAndComplete"]>>[];
      for (const repository of acceptedRepositories) {
        const claim = await repository.claimReadbackAttempt(attemptClaimRequest({
          attemptId: "attempt_publish_null_published_001",
          readbackRef: sameKeyReadbackRequest.record.readbackRef,
        }));
        expect(claim.disposition).toBe("created");
        if (claim.disposition !== "created") throw new Error("claim was not created");
        await expect(repository.getReadback(
          exactReadbackQuery(MANAGEMENT_TENANT_ID, pendingRelease.releaseId),
        )).resolves.toBeNull();
        await expect(repository.getUnfinishedReadbackAttempt({
          managementTenantId: MANAGEMENT_TENANT_ID,
          attemptId: claim.attempt.attemptId,
        })).resolves.toMatchObject({ phase: "claimed" });
        acceptedFinalizations.push(await repository.finalizeReadbackAndComplete({
          attemptId: claim.attempt.attemptId,
          ownerCapability: claim.ownerCapability,
          observation: {
            status: "verified",
            appliedReleaseId: sameKeyReadbackRequest.record.appliedReleaseId,
            appliedRevision: sameKeyReadbackRequest.record.appliedRevision,
            appliedModules: sameKeyReadbackRequest.record.appliedModules,
            reasonCodes: sameKeyReadbackRequest.record.reasonCodes,
            checkedAt: sameKeyReadbackRequest.record.checkedAt,
          },
          finalResult: publishFinalResult,
          finalizedAt: sameKeyReadbackRequest.record.checkedAt,
        }));
        expect(acceptedFinalizations.at(-1)?.disposition).toBe("finalized");
        await expect(repository.getActiveRelease()).resolves.toMatchObject({
          releaseId: pendingRelease.releaseId,
          status: "active_verified",
          publishedAt: pendingRelease.createdAt,
        });
      }
      expect(acceptedFinalizations.map((result) => result.disposition)).toEqual([
        "finalized",
        "finalized",
      ]);
      expect(acceptedFinalizations[0]?.readback).toEqual(acceptedFinalizations[1]?.readback);

      for (const repository of [expiredFake, expiredSqlite.repository]) {
        await repository.createPreview(previewRequest);
        await repository.decideApproval(approvalRequest);
        await expect(repository.publishRelease({
          metadata: publishRequest.metadata,
          record: {
            ...pendingRelease,
            createdAt: changePreview.expiresAt,
            publishedAt: null,
          },
        })).rejects.toMatchObject({ code: "conflict" });
        await expect(repository.getPendingRelease()).resolves.toBeNull();
      }
    } finally {
      await Promise.all([
        acceptedFake.close(),
        expiredFake.close(),
        acceptedSqlite.repository.close(),
        expiredSqlite.repository.close(),
      ]);
      rmSync(acceptedSqlite.applicationRoot, { force: true, recursive: true });
      rmSync(expiredSqlite.applicationRoot, { force: true, recursive: true });
    }
  });

  it("matches SQLite when fixed idempotency TTL preserves offset nanoseconds", async () => {
    const preciseRegisteredAt = "2099-08-22T03:00:00.123456789+02:30";
    const preciseRequest = structuredClone(registerRequest) as RegisterModuleRecordRequest;
    Reflect.set(preciseRequest.record, "registeredAt", preciseRegisteredAt);
    Reflect.set(
      preciseRequest.metadata,
      "idempotencyKey",
      "idem_register_nanosecond_parity_001",
    );
    const query = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: preciseRequest.metadata.action,
      idempotencyKey: preciseRequest.metadata.idempotencyKey,
    } as const satisfies GetControlIdempotencyQuery;
    const expected = {
      createdAt: preciseRegisteredAt,
      expiresAt: "2099-08-23T00:30:00.123456789Z",
    } as const;

    const fake = newRepository();
    const applicationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "fake-control-nanosecond-ttl-parity-")),
    );
    let sqlite: ModuleControlRepository | null = null;
    try {
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fake_nanosecond_ttl_parity_001",
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      sqlite = openSqliteControlStore({
        applicationRoot,
        instanceId: "instance_fake_nanosecond_ttl_parity_001",
        managementTenantId: MANAGEMENT_TENANT_ID,
        adminControlEnabled: true,
      });

      await fake.registerModule(preciseRequest);
      await sqlite.registerModule(preciseRequest);
      await expect(fake.getIdempotency(query)).resolves.toMatchObject(expected);
      await expect(sqlite.getIdempotency(query)).resolves.toMatchObject(expected);
    } finally {
      await sqlite?.close();
      rmSync(applicationRoot, { force: true, recursive: true });
    }
  });

  it("maps malformed Fake timestamp input to stable invalid_state", async () => {
    const malformed = structuredClone(registerRequest) as RegisterModuleRecordRequest;
    Reflect.set(malformed.record, "registeredAt", "not-a-timestamp");

    await expect(newRepository().registerModule(malformed)).rejects.toMatchObject({
      name: "ModuleControlRepositoryError",
      code: "invalid_state",
      message: "The module control record is invalid.",
    });
  });

  it("matches SQLite for one-nanosecond-before and offset-equivalent expiry gates", async () => {
    const expiresAt = "2099-08-22T00:00:00.000000001Z";
    const precisePreviewRequest = structuredClone(
      previewRequest,
    ) as CreatePreviewRecordRequest;
    Reflect.set(
      precisePreviewRequest.record,
      "createdAt",
      "2099-08-21T00:00:00Z",
    );
    Reflect.set(precisePreviewRequest.record, "expiresAt", expiresAt);
    const previewData = precisePreviewRequest.finalResult.envelope.data;
    if (previewData?.kind !== "preview") {
      throw new Error("Preview fixture lost its discriminant.");
    }
    Reflect.set(previewData, "expires_at", expiresAt);

    const runScenario = async (
      decidedAt: string,
    ): Promise<readonly [string, string]> => {
      const approval = structuredClone(approvalRequest) as DecideApprovalRecordRequest;
      Reflect.set(approval.record, "decidedAt", decidedAt);
      Reflect.set(approval.record, "expiresAt", expiresAt);
      const fake = newRepository();
      const applicationRoot = realpathSync(
        mkdtempSync(join(tmpdir(), "fake-control-nanosecond-gate-parity-")),
      );
      let sqlite: ModuleControlRepository | null = null;
      try {
        await initializeSqliteControlState({
          applicationRoot,
          instanceId: "instance_fake_nanosecond_gate_parity_001",
          managementTenantId: MANAGEMENT_TENANT_ID,
        });
        const openedSqlite = openSqliteControlStore({
          applicationRoot,
          instanceId: "instance_fake_nanosecond_gate_parity_001",
          managementTenantId: MANAGEMENT_TENANT_ID,
          adminControlEnabled: true,
        });
        sqlite = openedSqlite;
        for (const repository of [fake, openedSqlite]) {
          await repository.registerModule(registerRequest);
          await repository.createPreview(precisePreviewRequest);
        }
        return [
          await repositoryResultCode(() => fake.decideApproval(approval)),
          await repositoryResultCode(() => openedSqlite.decideApproval(approval)),
        ];
      } finally {
        await sqlite?.close();
        rmSync(applicationRoot, { force: true, recursive: true });
      }
    };

    const beforeCodes = await runScenario("2099-08-22T00:00:00Z");
    expect(beforeCodes).toEqual(["resolved", "resolved"]);

    const equivalentCodes = await runScenario(
      "2099-08-21T19:00:00.000000001-05:00",
    );
    expect(equivalentCodes).toEqual(["conflict", "conflict"]);
  });

  it("orders latest state projections at one-nanosecond precision before tie-breaking", async () => {
    const earlierWithLargerRef = {
      ...changePreview,
      previewRef: "preview_z_nanosecond_earlier",
      createdAt: "2099-08-22T00:00:00.000000001Z",
      expiresAt: "2099-08-22T01:00:00.000000001Z",
    } as const satisfies ModuleChangePreviewRecord;
    const laterWithSmallerRef = {
      ...changePreview,
      previewRef: "preview_a_nanosecond_later",
      createdAt: "2099-08-22T00:00:00.000000002Z",
      expiresAt: "2099-08-22T01:00:00.000000002Z",
    } as const satisfies ModuleChangePreviewRecord;
    const repository = newRepository({
      previews: [laterWithSmallerRef, earlierWithLargerRef],
    });

    expect((await repository.getControlState()).latestPreview).toEqual(
      laterWithSmallerRef,
    );
  });

  it("orders legal RFC3339 offsets by instant and uses stable identifiers only as ties", async () => {
    const earlierLexicallyLarger = {
      ...changePreview,
      previewRef: "preview_offset_earlier",
      createdAt: "2026-08-22T01:00:00+02:00",
      expiresAt: "2026-08-22T02:00:00+02:00",
    } as const satisfies ModuleChangePreviewRecord;
    const laterLexicallySmaller = {
      ...changePreview,
      previewRef: "preview_offset_later",
      createdAt: "2026-08-22T00:30:00Z",
      expiresAt: "2026-08-22T01:30:00Z",
    } as const satisfies ModuleChangePreviewRecord;
    const repository = newRepository({
      previews: [laterLexicallySmaller, earlierLexicallyLarger],
    });

    expect((await repository.getControlState()).latestPreview).toEqual(laterLexicallySmaller);
  });

  it("orders latest readback instants across legal offsets instead of seed insertion or text order", async () => {
    const activePreview = { ...changePreview, consumed: true } as const;
    const activeApproval = { ...approvalRecord, consumed: true } as const;
    const offsetActiveReadback = {
      ...verifiedReadback,
      checkedAt: "2026-08-22T02:10:00+02:00",
    } as const satisfies ModuleVerifiedReadbackRecord;
    const nextPreview = {
      ...changePreview,
      previewRef: "preview_pending_offset_002",
      baseReleaseId: activeRelease.releaseId,
      baseRevision: activeRelease.revision,
      inventoryRefs: [moduleRef, secondModuleRef],
      desiredModules: [moduleRef, secondModuleRef],
      diff: {
        added: [secondModuleRef],
        removed: [],
        retained: [moduleRef],
      },
      createdAt: "2026-08-22T00:08:00Z",
      expiresAt: "2026-08-22T02:00:00Z",
      consumed: true,
    } as const satisfies ModuleChangePreviewRecord;
    const nextApproval = {
      ...approvalRecord,
      approvalId: "approval_pending_offset_002",
      previewRef: nextPreview.previewRef,
      previewCanonicalHash: nextPreview.canonicalHash,
      baseReleaseId: nextPreview.baseReleaseId,
      baseRevision: nextPreview.baseRevision,
      inventoryDigestSet: [DESCRIPTOR_DIGEST, SECOND_DESCRIPTOR_DIGEST],
      expiresAt: nextPreview.expiresAt,
      decidedAt: "2026-08-22T00:09:00Z",
      consumed: true,
    } as const satisfies ModuleApprovalRecord;
    const nextRelease = {
      ...pendingRelease,
      releaseId: "release_pending_offset_002",
      revision: 2,
      desiredModules: nextPreview.desiredModules,
      previousReleaseId: activeRelease.releaseId,
      previewRef: nextPreview.previewRef,
      approvalId: nextApproval.approvalId,
      createdAt: "2026-08-22T00:10:00Z",
      publishedAt: "2026-08-22T00:11:00Z",
    } as const satisfies ModulePendingReleaseRecord;
    const offsetPendingReadback = {
      ...pendingReadback,
      releaseId: nextRelease.releaseId,
      revision: nextRelease.revision,
      readbackRef: "readback_pending_offset_002",
      checkedAt: "2026-08-22T00:30:00Z",
    } as const satisfies ModulePendingReadbackRecord;
    const nextPublishIdempotency = {
      ...publishDomainCommittedIdempotencyRecord,
      actorRef: nextRelease.publisherActorRef,
      idempotencyKey: "idem_publish_pending_offset_002",
      domainRecordRef: nextRelease.releaseId,
      createdAt: nextRelease.createdAt,
      expiresAt: "2026-08-23T00:10:00Z",
    } as const satisfies DomainCommittedModuleControlIdempotencyRecord;
    const offsetActivePublishEvent = {
      ...activePublishEvent,
      eventId: "event_offset_active_publish_001",
      sequence: 1,
    } as const satisfies ControlEventRecord;
    const offsetActiveReadbackEvent = {
      ...activeReadbackEvent,
      eventId: "event_offset_active_readback_002",
      sequence: 2,
      occurredAt: offsetActiveReadback.checkedAt,
    } as const satisfies ControlEventRecord;
    const offsetPendingPublishEvent = {
      ...publishEventInput,
      managementTenantId: MANAGEMENT_TENANT_ID,
      eventId: "event_offset_pending_publish_003",
      sequence: 3,
      actorRef: nextRelease.publisherActorRef,
      objectRef: nextRelease.releaseId,
      detail: {
        ...publishEventInput.detail,
        releaseId: nextRelease.releaseId,
        revision: nextRelease.revision,
      },
      occurredAt: nextRelease.createdAt,
    } as const satisfies ControlEventRecord;
    const offsetPendingReadbackEvent = {
      ...pendingReadbackEvent,
      eventId: "event_offset_pending_readback_004",
      sequence: 4,
      objectRef: nextRelease.releaseId,
      detail: {
        ...pendingReadbackEvent.detail,
        releaseId: nextRelease.releaseId,
        revision: nextRelease.revision,
        readbackRef: offsetPendingReadback.readbackRef,
      },
      occurredAt: offsetPendingReadback.checkedAt,
    } as const satisfies ControlEventRecord;
    const repository = newRepository({
      previews: [nextPreview, activePreview],
      approvals: [nextApproval, activeApproval],
      releases: [nextRelease, activeRelease],
      readbacks: [offsetPendingReadback, offsetActiveReadback],
      idempotency: [activePublishIdempotency, nextPublishIdempotency],
      events: [
        offsetActivePublishEvent,
        offsetActiveReadbackEvent,
        offsetPendingPublishEvent,
        offsetPendingReadbackEvent,
      ],
    });

    expect((await repository.getControlState()).latestReadback).toEqual(offsetPendingReadback);
  });

  it.each([
    {
      name: "approval missing preview",
      run: (repository: ModuleControlRepository) => repository.decideApproval(approvalRequest),
      code: "not_found",
    },
    {
      name: "publish missing preview",
      run: (repository: ModuleControlRepository) => repository.publishRelease(publishRequest),
      code: "not_found",
    },
  ] as const)("matches SQLite parity matrix: $name", async ({ run, code }) => {
    const fake = newRepository();
    const applicationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "fake-control-parity-")),
    );
    let sqlite: ModuleControlRepository | null = null;
    try {
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fake_parity_001",
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      sqlite = openSqliteControlStore({
        applicationRoot,
        instanceId: "instance_fake_parity_001",
        managementTenantId: MANAGEMENT_TENANT_ID,
        adminControlEnabled: true,
      });

      const fakeCode = await repositoryResultCode(() => run(fake));
      const sqliteCode = await repositoryResultCode(() => run(sqlite!));
      expect(fakeCode).toBe(code);
      expect(sqliteCode).toBe(code);
      expect(fakeCode).toBe(sqliteCode);
      expect((await fake.getControlState()).events).toEqual([]);
      expect((await sqlite.getControlState()).events).toEqual([]);
    } finally {
      await sqlite?.close();
      rmSync(applicationRoot, { force: true, recursive: true });
    }
  });
});
