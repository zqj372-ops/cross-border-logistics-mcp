import { describe, expect, it } from "vitest";

import {
  ModuleControlRepositoryError,
} from "../../src/logistics_mcp/control-plane/repository";
import type { ApprovalControlEventInput } from "../../src/logistics_mcp/control-plane/repository";
import type {
  CompleteControlIdempotencyRequest,
  ControlEnvelope,
  ControlEventRecord,
  ControlFinalResult,
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
  ModuleControlRef,
  ModuleManualReviewReleaseRecord,
  ModulePendingReadbackRecord,
  ModulePendingReleaseRecord,
  ModuleRegistrationRecord,
  ReservedModuleControlIdempotencyRecord,
  ModuleUnknownReadbackRecord,
  ModuleVerifiedReadbackRecord,
  PublishReadbackRequestMetadata,
  PublishReleaseRecordRequest,
  ReconcileRequestMetadata,
  RecordReadbackRequest,
  RegisterModuleRecordRequest,
  RegisterModuleRequestMetadata,
} from "../../src/logistics_mcp/control-plane/repository";
import {
  FAKE_CONTROL_REPOSITORY_METHOD_NAMES,
  FakeModuleControlRepository,
} from "./fake-control-repository";
import type { FakeModuleControlRepositoryRecords } from "./fake-control-repository";

const MANAGEMENT_TENANT_ID = "tenant_demo";
const OTHER_TENANT_ID = "tenant_other";
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
  revision: 2,
  desiredModules: [moduleRef, secondModuleRef],
  previousReleaseId: activeRelease.releaseId,
  previewRef: "preview_pending_002",
  approvalId: "approval_pending_002",
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
  releaseId: "release_manual_003",
  revision: 3,
  desiredModules: [secondModuleRef],
  previousReleaseId: pendingRelease.releaseId,
  previewRef: "preview_manual_003",
  approvalId: "approval_manual_003",
  publisherActorRef: "actor_publisher",
  createdAt: "2026-08-22T00:10:00Z",
  publishedAt: "2026-08-22T00:11:00Z",
  status: "manual_review",
  readbackRef: "readback_manual_003",
  reasonCodes: ["readback.unknown"],
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
      data: { kind: "preview", preview_ref: changePreview.previewRef },
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
      data: { kind: "approval", approval_id: approvalRecord.approvalId },
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
} as const satisfies RecordReadbackRequest;

const sameKeyReadbackRequest = {
  ...readbackRequest,
  metadata: {
    ...readbackRequest.metadata,
    idempotencyKey: publishRequest.metadata.idempotencyKey,
  },
} as const satisfies RecordReadbackRequest;

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
} as const satisfies RecordReadbackRequest;

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
    actorRef: "actor_reconciler",
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
} as const satisfies CompleteControlIdempotencyRequest;

const completedIdempotencyRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  action: "packages.register",
  idempotencyKey: registerRequest.metadata.idempotencyKey,
  requestHash: registerRequest.metadata.requestHash,
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
  status: "reserved",
  domainRecordRef: null,
  finalResult: null,
  createdAt: registrationRecord.registeredAt,
  expiresAt: "2026-08-23T00:00:00Z",
} as const satisfies ReservedModuleControlIdempotencyRecord;

const idempotencyEventInput = {
  action: "packages.register",
  objectRef: `idempotency:packages.register:${completedIdempotencyRecord.idempotencyKey}`,
  kind: "idempotency",
  status: "completed",
  reasonCodes: [],
  detail: {
    kind: "idempotency",
    recordRef: `idempotency:packages.register:${completedIdempotencyRecord.idempotencyKey}`,
    domainRecordRef: registrationRef,
    status: "completed",
  },
} as const;

const completedIdempotencyRequest = {
  metadata: {
    managementTenantId: MANAGEMENT_TENANT_ID,
    actorRef: "actor_operator",
    action: "packages.register",
    idempotencyKey: completedIdempotencyRecord.idempotencyKey,
    requestHash: completedIdempotencyRecord.requestHash,
    event: idempotencyEventInput,
  },
  record: completedIdempotencyRecord,
} as const satisfies CompleteControlIdempotencyRequest;

const registrationEvent = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  eventId: "event_registration_001",
  sequence: 1,
  actorRef: "actor_operator",
  ...registrationEventInput,
  occurredAt: registrationRecord.registeredAt,
} as const satisfies ControlEventRecord;

const secondRegistrationRecord = {
  ...registrationRecord,
  moduleId: secondModuleRef.moduleId,
  version: secondModuleRef.version,
  descriptorDigest: secondModuleRef.descriptorDigest,
} as const satisfies ModuleRegistrationRecord;

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

const tiedReadback = {
  ...unknownReadback,
  readbackRef: "readback_tied_999",
  releaseId: "release_tied_999",
} as const satisfies ModuleUnknownReadbackRecord;

const secondEvent = {
  ...registrationEvent,
  eventId: "event_registration_002",
  sequence: 2,
  occurredAt: "2026-08-22T00:00:02Z",
} as const satisfies ControlEventRecord;

const thirdEvent = {
  ...registrationEvent,
  eventId: "event_registration_003",
  sequence: 3,
  occurredAt: "2026-08-22T00:00:03Z",
} as const satisfies ControlEventRecord;

const seedRecords = {
  registrations: [registrationRecord],
  previews: [changePreview],
  approvals: [approvalRecord],
  releases: [activeRelease, pendingRelease, manualReviewRelease],
  readbacks: [verifiedReadback, pendingReadback, unknownReadback],
  idempotency: [completedIdempotencyRecord],
  events: [registrationEvent],
} as const;

const orderingRecords = {
  registrations: [secondRegistrationRecord, registrationRecord],
  previews: [tiedPreview, changePreview],
  approvals: [tiedApproval, approvalRecord],
  releases: [activeRelease, pendingRelease, manualReviewRelease],
  readbacks: [tiedReadback, unknownReadback, verifiedReadback],
  idempotency: [completedIdempotencyRecord],
  events: [thirdEvent, registrationEvent, secondEvent],
} as const satisfies FakeModuleControlRepositoryRecords;

function newRepository(
  records: FakeModuleControlRepositoryRecords | undefined = undefined,
): FakeModuleControlRepository {
  return new FakeModuleControlRepository({
    managementTenantId: MANAGEMENT_TENANT_ID,
    ...(records === undefined ? {} : { records }),
  });
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

describe("FakeModuleControlRepository", () => {
  it("implements the complete narrow repository key set without generic put/get methods", () => {
    const repository: ModuleControlRepository = newRepository();

    expect(FAKE_CONTROL_REPOSITORY_METHOD_NAMES).toEqual([
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
    ]);
    for (const methodName of FAKE_CONTROL_REPOSITORY_METHOD_NAMES) {
      expect(methodName in repository).toBe(true);
    }
    expect("put" in repository).toBe(false);
    expect("get" in repository).toBe(false);
    expect("records" in repository).toBe(false);
  });

  it("records every method in order with frozen request snapshots and closed-record persistence", async () => {
    const repository = newRepository();

    await repository.health();
    await repository.registerModule(registerRequest);
    await repository.createPreview(previewRequest);
    await repository.decideApproval(approvalRequest);
    await repository.publishRelease(publishRequest);
    await repository.recordReadback(sameKeyReadbackRequest);
    await repository.completeIdempotency(completedIdempotencyRequest);
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
    const idempotencyResult = await repository.getIdempotency(exactIdempotencyQuery());

    expect(previewResult).toEqual(changePreview);
    expect(approvalResult).toEqual(approvalRecord);
    expect(releaseResult).toEqual({
      ...pendingRelease,
      status: "active_verified",
      readbackRef: readbackForPublishedRelease.readbackRef,
    });
    expect(readbackResult).toEqual(readbackForPublishedRelease);
    expect(idempotencyResult).toEqual(completedIdempotencyRecord);

    await repository.close();

    expect(repository.calls.map((call) => call.method)).toEqual([
      "health",
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

    expect(await repository.getActiveRelease()).toEqual(activeRelease);
    expect(await repository.getPendingRelease()).toEqual(pendingRelease);
    expect(await repository.getNewestUnresolvedRelease()).toEqual(manualReviewRelease);
    expect(await repository.getPreview(exactPreviewQuery())).toEqual(changePreview);
    expect(await repository.getApproval(exactApprovalQuery())).toEqual(approvalRecord);
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
    expect(state.latestPreview).toEqual(changePreview);
    expect(state.latestApproval).toEqual(approvalRecord);
    expect(state.latestReadback).toEqual(unknownReadback);
    expect(state.events).toEqual([registrationEvent]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.activeModules)).toBe(true);
    expect(Object.isFrozen(state.events)).toBe(true);
  });

  it("consumes typed failures once per method in queued order while still recording failed calls", async () => {
    const repository = newRepository(seedRecords);
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

  it("replays the persisted closed write result without creating a second event", async () => {
    const repository = newRepository();

    const firstWrite = await repository.registerModule(registerRequest);
    const replayedWrite = await repository.registerModule(registerRequest);

    expect(firstWrite.replayed).toBe(false);
    expect(replayedWrite.replayed).toBe(true);
    expect(replayedWrite.record).toEqual(firstWrite.record);
    expect(replayedWrite.event).toEqual(firstWrite.event);
    const eventCountAfterRegisterReplay = (await repository.getControlState()).events.length;

    const firstCompletion = await repository.completeIdempotency(completedIdempotencyRequest);
    const eventCountAfterFirstCompletion = (await repository.getControlState()).events.length;
    const replayedCompletion = await repository.completeIdempotency(completedIdempotencyRequest);
    expect(replayedCompletion).toEqual(firstCompletion);
    expect(eventCountAfterFirstCompletion).toBeGreaterThanOrEqual(eventCountAfterRegisterReplay);
    expect((await repository.getControlState()).events).toHaveLength(eventCountAfterFirstCompletion);
  });

  it("does not synthesize a completed idempotency row when the row is missing", async () => {
    const repository = newRepository();
    const eventsBefore = (await repository.getControlState()).events.length;

    await expect(repository.completeIdempotency(completedIdempotencyRequest)).rejects.toMatchObject({
      name: "ModuleControlRepositoryError",
      code: "not_found",
    });

    expect(await repository.getIdempotency(exactIdempotencyQuery())).toBeNull();
    expect((await repository.getControlState()).events).toHaveLength(eventsBefore);
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

  it("keeps publish and same-key readback replays method-scoped with one fixed release", async () => {
    const repository = newRepository();

    const firstPublish = await repository.publishRelease(publishRequest);
    const committed = await repository.getIdempotency({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: publishRequest.metadata.action,
      idempotencyKey: publishRequest.metadata.idempotencyKey,
    });
    expect(committed).toEqual(publishDomainCommittedIdempotencyRecord);

    await repository.recordReadback(sameKeyReadbackRequest);
    const stateAfterReadback = await repository.getControlState();
    const secondPublish = await repository.publishRelease(publishRequest);
    const stateAfterReplay = await repository.getControlState();

    expect(firstPublish.replayed).toBe(false);
    expect(secondPublish.replayed).toBe(true);
    expect(secondPublish.record.releaseId).toBe(firstPublish.record.releaseId);
    expect(secondPublish.event).toEqual(firstPublish.event);
    expect(stateAfterReplay.events).toEqual(stateAfterReadback.events);
    expect(stateAfterReplay.events).toHaveLength(stateAfterReadback.events.length);
    expect(await repository.getRelease(exactReleaseQuery(MANAGEMENT_TENANT_ID, pendingRelease.releaseId))).toEqual({
      ...pendingRelease,
      status: "active_verified",
      readbackRef: readbackForPublishedRelease.readbackRef,
    });
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
      status: "completed",
      domainRecordRef: approvalRecord.approvalId,
      finalResult: approvalRequest.finalResult,
      createdAt: approvalRecord.decidedAt,
      expiresAt: "2026-08-23T00:05:00Z",
    });
  });

  it("materializes reconcile readback as domain-committed for crash recovery", async () => {
    const repository = newRepository();

    await repository.recordReadback(reconcileReadbackRequest);

    await expect(
      repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: reconcileReadbackRequest.metadata.action,
        idempotencyKey: reconcileReadbackRequest.metadata.idempotencyKey,
      }),
    ).resolves.toEqual({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: reconcileReadbackRequest.metadata.action,
      idempotencyKey: reconcileReadbackRequest.metadata.idempotencyKey,
      requestHash: reconcileReadbackRequest.metadata.requestHash,
      status: "domain_committed",
      domainRecordRef: readbackForPublishedRelease.releaseId,
      finalResult: null,
      createdAt: readbackForPublishedRelease.checkedAt,
      expiresAt: "2026-08-23T00:12:00Z",
    });
  });

  it("requires an existing publish idempotency binding before recording readback", async () => {
    const repository = newRepository();
    const eventsBefore = (await repository.getControlState()).events.length;

    await expect(repository.recordReadback(readbackRequest)).rejects.toMatchObject({
      name: "ModuleControlRepositoryError",
      code: "not_found",
    });

    expect(await repository.getRelease(exactReleaseQuery(MANAGEMENT_TENANT_ID, pendingRelease.releaseId))).toBeNull();
    expect(
      await repository.getReadback(
        exactReadbackQuery(MANAGEMENT_TENANT_ID, pendingRelease.releaseId),
      ),
    ).toBeNull();
    expect(
      await repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: readbackRequest.metadata.action,
        idempotencyKey: readbackRequest.metadata.idempotencyKey,
      }),
    ).toBeNull();
    expect((await repository.getControlState()).events).toHaveLength(eventsBefore);
  });

  it("atomically completes domain-committed idempotency and replays completed without events", async () => {
    const repository = newRepository({
      ...seedRecords,
      idempotency: [publishDomainCommittedIdempotencyRecord],
    });

    const eventsBeforeCompletion = (await repository.getControlState()).events.length;
    const completed = await repository.completeIdempotency(publishCompletionRequest);
    const eventsAfterCompletion = (await repository.getControlState()).events.length;
    const replayed = await repository.completeIdempotency(publishCompletionRequest);

    expect(completed).toEqual(publishCompletionRequest.record);
    expect(replayed).toEqual(completed);
    expect(eventsAfterCompletion).toBe(eventsBeforeCompletion + 1);
    expect((await repository.getControlState()).events).toHaveLength(eventsAfterCompletion);

    const differentFinal = structuredClone(publishCompletionRequest) as CompleteControlIdempotencyRequest;
    const differentFinalResult = differentFinal.record.finalResult;
    if (differentFinalResult === null) throw new Error("test fixture must be completed");
    Reflect.set(differentFinalResult.envelope, "request_id", "request_publish_other");
    await expect(repository.completeIdempotency(differentFinal)).rejects.toMatchObject({
      code: "conflict",
    });

    const differentTimestamp = structuredClone(publishCompletionRequest) as CompleteControlIdempotencyRequest;
    Reflect.set(differentTimestamp.record, "expiresAt", "2026-08-24T00:08:00Z");
    await expect(repository.completeIdempotency(differentTimestamp)).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await repository.getControlState()).events).toHaveLength(eventsAfterCompletion);
  });

  it("rejects reserved idempotency completion without changing state or events", async () => {
    const repository = newRepository({
      ...seedRecords,
      idempotency: [reservedIdempotencyRecord],
    });
    const stateBefore = await repository.getControlState();

    await expect(repository.completeIdempotency(completedIdempotencyRequest)).rejects.toMatchObject({
      name: "ModuleControlRepositoryError",
      code: "conflict",
    });

    expect(await repository.getIdempotency(exactIdempotencyQuery())).toEqual(
      reservedIdempotencyRecord,
    );
    expect(await repository.getControlState()).toEqual(stateBefore);
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
    expect(state.latestReadback).toEqual(tiedReadback);
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
      repository.recordReadback(readbackRequest),
      repository.completeIdempotency(completedIdempotencyRequest),
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
    const seeded = newRepository(seedRecords);
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
});
