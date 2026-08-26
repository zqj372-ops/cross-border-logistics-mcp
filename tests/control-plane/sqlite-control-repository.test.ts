import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CompletedModuleControlIdempotencyRecord,
  ControlEnvelope,
  CreatePreviewRecordRequest,
  CreatePreviewRequestMetadata,
  ControlFinalResult,
  DecideApprovalRequestMetadata,
  ModuleApprovalRecord,
  ModuleChangePreviewRecord,
  ModuleControlRef,
  ModulePendingReleaseRecord,
  ModulePendingReadbackRecord,
  ModuleReadbackRecord,
  ModuleRollbackPreviewRecord,
  ModuleVerifiedReadbackRecord,
  PublishReadbackRequestMetadata,
  PublishReleaseRecordRequest,
  PublishReleaseRequestMetadata,
  ReconcileRequestMetadata,
  ModuleRegistrationRecord,
  ModuleControlRepository,
  RegisterModuleRecordRequest,
  RegisterModuleRequestMetadata,
} from "../../src/logistics_mcp/control-plane/repository";
import {
  initializeSqliteControlState,
  openSqliteControlStore,
} from "../../src/logistics_mcp/control-plane/sqlite-control-store";

type ReadbackFixtureRequest = {
  readonly metadata: ReconcileRequestMetadata | PublishReadbackRequestMetadata;
  readonly record: ModuleReadbackRecord;
};

const descriptorDigest = `sha256:${"1".repeat(64)}` as const;
const secondDescriptorDigest = `sha256:${"2".repeat(64)}` as const;
const requestHash =
  `mcp-control-hash/v1/request/sha256:${"3".repeat(64)}` as const;
const previewRequestHash =
  `mcp-control-hash/v1/request/sha256:${"4".repeat(64)}` as const;
const approvalRequestHash =
  `mcp-control-hash/v1/request/sha256:${"5".repeat(64)}` as const;
const publishRequestHash =
  `mcp-control-hash/v1/request/sha256:${"6".repeat(64)}` as const;
const reconcileRequestHash =
  `mcp-control-hash/v1/request/sha256:${"7".repeat(64)}` as const;
const rollbackRequestHash =
  `mcp-control-hash/v1/request/sha256:${"9".repeat(64)}` as const;
const previewHash =
  `mcp-control-hash/v1/preview/sha256:${"8".repeat(64)}` as const;
const setPreviewHash =
  `mcp-control-hash/v1/preview/sha256:${"b".repeat(64)}` as const;
const tenant = "tenant_control";
const actor = "actor_operator";
const approver = "actor_approver";
const publisher = "actor_publisher";
const moduleRef = {
  moduleId: "cargo",
  version: "1.0.0",
  descriptorDigest,
} as const satisfies ModuleControlRef;
const secondModuleRef = {
  moduleId: "quote",
  version: "2.0.0",
  descriptorDigest: secondDescriptorDigest,
} as const satisfies ModuleControlRef;
const applicationRoots: string[] = [];

afterEach(() => {
  for (const applicationRoot of applicationRoots.splice(0)) {
    rmSync(applicationRoot, { force: true, recursive: true });
  }
});

function makeApplicationRoot(): string {
  const applicationRoot = realpathSync(mkdtempSync(join(tmpdir(), "mcp-repository-")));
  applicationRoots.push(applicationRoot);
  return applicationRoot;
}

function openStore(applicationRoot: string) {
  return openSqliteControlStore({
    applicationRoot,
    instanceId: "instance_fixture_001",
    managementTenantId: tenant,
    adminControlEnabled: true,
  });
}

function insertSyntheticPreviewEventHistory(
  database: DatabaseSync,
  eventCount: number,
  prefix: string,
): void {
  const createdAt = "2099-08-22T00:00:00Z";
  const expiresAt = "2099-08-23T00:00:00Z";
  const insertPreview = database.prepare(
    `INSERT INTO module_previews
      (management_tenant_id, preview_ref, canonical_hash, intent,
       base_release_id, base_revision, inventory_refs_json, desired_modules_json,
       diff_json, validation_json, creator_actor_ref, created_at, expires_at,
       consumed, target_release_id)
     VALUES (?, ?, ?, 'change', NULL, 0, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
  );
  const insertIdempotency = database.prepare(
    `INSERT INTO module_control_idempotency
      (management_tenant_id, action, idempotency_key, request_hash, actor_ref,
       status, domain_record_ref, final_result_json, created_at, expires_at)
     VALUES (?, 'deployments.preview', ?, ?, ?, 'domain_committed', ?, NULL, ?, ?)`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO module_control_events
      (sequence, management_tenant_id, event_id, actor_ref, action,
       idempotency_key, request_hash, object_ref, status, reason_codes_json,
       payload_json, occurred_at)
     VALUES (?, ?, ?, ?, 'deployments.preview', ?, ?, ?, 'previewed', '[]', ?, ?)`,
  );
  const refsJson = JSON.stringify([moduleRef]);
  const diffJson = JSON.stringify({ added: [moduleRef], removed: [], retained: [] });
  const validationJson = JSON.stringify({
    baseMatches: true,
    desiredModulesValid: true,
    inventoryMatches: true,
    minimumActiveModules: true,
    reasonCodes: [],
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 1; index <= eventCount; index += 1) {
      const previewRef = `preview_${prefix}_${index}`;
      const idempotencyKey = `idem_${prefix}_${index}`;
      insertPreview.run(
        tenant,
        previewRef,
        previewHash,
        refsJson,
        refsJson,
        diffJson,
        validationJson,
        actor,
        createdAt,
        expiresAt,
      );
      insertIdempotency.run(
        tenant,
        idempotencyKey,
        previewRequestHash,
        actor,
        previewRef,
        createdAt,
        expiresAt,
      );
      insertEvent.run(
        index,
        tenant,
        `event_${prefix}_${index}`,
        actor,
        idempotencyKey,
        previewRequestHash,
        previewRef,
        JSON.stringify({
          detail: {
            kind: "preview",
            previewRef,
            baseRevision: 0,
            status: "previewed",
          },
        }),
        createdAt,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the direct fixture failure.
    }
    throw error;
  }
}

const registrationRecord = {
  managementTenantId: tenant,
  moduleId: "cargo",
  version: "1.0.0",
  descriptorDigest,
  evidenceLevel: "local_build",
  productionEligible: false,
  evidenceRefs: {
    sourceShaRef: null,
    artifactDigestRef: null,
    signatureRef: null,
    sbomRef: null,
    attestationRef: null,
  },
  registeredByActorRef: actor,
  registeredAt: "2099-08-22T00:00:00Z",
} as const satisfies ModuleRegistrationRecord;

const registrationMetadata = {
  managementTenantId: tenant,
  actorRef: actor,
  action: "packages.register",
  idempotencyKey: "idem_register_001",
  requestHash,
  event: {
    action: "packages.register",
    objectRef: `registration:cargo:1.0.0:${descriptorDigest}`,
    kind: "registration",
    status: "registered",
    reasonCodes: [],
    detail: {
      kind: "registration",
      recordRef: `registration:cargo:1.0.0:${descriptorDigest}`,
      moduleId: "cargo",
      version: "1.0.0",
      descriptorDigest,
      status: "registered",
    },
  },
} as const satisfies RegisterModuleRequestMetadata;

const registrationEnvelope = {
  schema_version: "2026-08-22.v1",
  request_id: "request_register_001",
  trace_id: "trace_register_001",
  audit_id: "audit_register_001",
  status: "success",
  data: {
    kind: "registration",
    module_id: "cargo",
    version: "1.0.0",
    descriptor_digest: descriptorDigest,
    evidence_level: "local_build",
    production_eligible: false,
  },
  reason_codes: [],
  readback: { status: "not_applicable", release_id: null, revision: null },
} as const satisfies ControlEnvelope;

const registrationFinalResult = {
  domainRecordRef: `registration:cargo:1.0.0:${descriptorDigest}`,
  envelope: registrationEnvelope,
} as const satisfies ControlFinalResult;

const changePreview = {
  managementTenantId: tenant,
  previewRef: "preview_change_001",
  canonicalHash: previewHash,
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
  creatorActorRef: actor,
  createdAt: "2099-08-22T00:01:00Z",
  expiresAt: "2099-08-23T00:01:00Z",
  consumed: false,
  intent: "change",
} as const satisfies ModuleChangePreviewRecord;

const previewMetadata = {
  managementTenantId: tenant,
  actorRef: actor,
  action: "deployments.preview",
  idempotencyKey: "idem_preview_001",
  requestHash: previewRequestHash,
  event: {
    action: "deployments.preview",
    objectRef: "preview_change_001",
    kind: "preview",
    status: "previewed",
    reasonCodes: [],
    detail: {
      kind: "preview",
      previewRef: "preview_change_001",
      baseRevision: 0,
      status: "previewed",
    },
  },
} as const satisfies CreatePreviewRequestMetadata;

const previewEnvelope = {
  schema_version: "2026-08-22.v1",
  request_id: "request_preview_001",
  trace_id: "trace_preview_001",
  audit_id: "audit_preview_001",
  status: "success",
  data: {
    kind: "preview",
    preview_ref: changePreview.previewRef,
    intent: "change",
    base_release_id: null,
    base_revision: 0,
    desired_modules: [
      {
        module_id: "cargo",
        version: "1.0.0",
        descriptor_digest: descriptorDigest,
      },
    ],
    target_release_id: null,
    expires_at: changePreview.expiresAt,
  },
  reason_codes: [],
  readback: { status: "not_applicable", release_id: null, revision: null },
} as const satisfies ControlEnvelope;

const previewFinalResult = {
  domainRecordRef: changePreview.previewRef,
  envelope: previewEnvelope,
} as const satisfies ControlFinalResult;

const rollbackPreview = {
  managementTenantId: tenant,
  previewRef: "preview_rollback_001",
  canonicalHash: `mcp-control-hash/v1/preview/sha256:${"a".repeat(64)}` as const,
  baseReleaseId: "release_002",
  baseRevision: 2,
  inventoryRefs: [moduleRef, secondModuleRef],
  desiredModules: [moduleRef],
  diff: { added: [], removed: [secondModuleRef], retained: [moduleRef] },
  validation: {
    baseMatches: true,
    desiredModulesValid: true,
    inventoryMatches: true,
    minimumActiveModules: true,
    reasonCodes: [],
  },
  creatorActorRef: actor,
  createdAt: "2099-08-22T00:09:00Z",
  expiresAt: "2099-08-23T00:09:00Z",
  consumed: false,
  intent: "rollback",
  targetReleaseId: "release_001",
} as const satisfies ModuleRollbackPreviewRecord;

const rollbackPreviewMetadata = {
  managementTenantId: tenant,
  actorRef: actor,
  action: "deployments.preview",
  idempotencyKey: "idem_preview_rollback_001",
  requestHash: rollbackRequestHash,
  event: {
    action: "deployments.preview",
    objectRef: rollbackPreview.previewRef,
    kind: "preview",
    status: "previewed",
    reasonCodes: [],
    detail: {
      kind: "preview",
      previewRef: rollbackPreview.previewRef,
      baseRevision: rollbackPreview.baseRevision,
      status: "previewed",
    },
  },
} as const satisfies CreatePreviewRequestMetadata;

const rollbackPreviewEnvelope = {
  schema_version: "2026-08-22.v1",
  request_id: "request_preview_rollback_001",
  trace_id: "trace_preview_rollback_001",
  audit_id: "audit_preview_rollback_001",
  status: "success",
  data: {
    kind: "preview",
    preview_ref: rollbackPreview.previewRef,
    intent: "rollback",
    base_release_id: rollbackPreview.baseReleaseId,
    base_revision: rollbackPreview.baseRevision,
    desired_modules: [
      {
        module_id: "cargo",
        version: "1.0.0",
        descriptor_digest: descriptorDigest,
      },
    ],
    target_release_id: rollbackPreview.targetReleaseId,
    expires_at: rollbackPreview.expiresAt,
  },
  reason_codes: [],
  readback: { status: "not_applicable", release_id: null, revision: null },
} as const satisfies ControlEnvelope;

const rollbackPreviewFinalResult = {
  domainRecordRef: rollbackPreview.previewRef,
  envelope: rollbackPreviewEnvelope,
} as const satisfies ControlFinalResult;

const approval = {
  managementTenantId: tenant,
  approvalId: "approval_001",
  previewRef: changePreview.previewRef,
  decision: "approve",
  previewCanonicalHash: changePreview.canonicalHash,
  baseReleaseId: null,
  baseRevision: 0,
  inventoryDigestSet: [descriptorDigest],
  expiresAt: changePreview.expiresAt,
  reasonCode: "approved",
  approverActorRef: approver,
  decidedAt: "2099-08-22T00:02:00Z",
  consumed: false,
} as const satisfies ModuleApprovalRecord;

const approvalMetadata = {
  managementTenantId: tenant,
  actorRef: approver,
  action: "approvals.decide",
  idempotencyKey: "idem_approval_001",
  requestHash: approvalRequestHash,
  event: {
    action: "approvals.decide",
    objectRef: approval.approvalId,
    kind: "approval",
    status: "approved",
    reasonCodes: [],
    detail: {
      kind: "approval",
      approvalId: approval.approvalId,
      previewRef: approval.previewRef,
      status: "approved",
    },
  },
} as const satisfies DecideApprovalRequestMetadata;

const approvalEnvelope = {
  schema_version: "2026-08-22.v1",
  request_id: "request_approval_001",
  trace_id: "trace_approval_001",
  audit_id: "audit_approval_001",
  status: "success",
  data: {
    kind: "approval",
    approval_id: approval.approvalId,
    preview_ref: approval.previewRef,
    decision: "approve",
  },
  reason_codes: [],
  readback: { status: "not_applicable", release_id: null, revision: null },
} as const satisfies ControlEnvelope;

const approvalFinalResult = {
  domainRecordRef: approval.approvalId,
  envelope: approvalEnvelope,
} as const satisfies ControlFinalResult;

const pendingRelease = {
  managementTenantId: tenant,
  releaseId: "release_001",
  revision: 1,
  desiredModules: [moduleRef],
  previousReleaseId: null,
  previewRef: changePreview.previewRef,
  approvalId: approval.approvalId,
  publisherActorRef: publisher,
  createdAt: "2099-08-22T00:03:00Z",
  publishedAt: "2099-08-22T00:03:00Z",
  status: "published_pending_readback",
  readbackRef: null,
  reasonCodes: [],
  supersededByReleaseId: null,
} as const satisfies ModulePendingReleaseRecord;

const publishMetadata = {
  managementTenantId: tenant,
  actorRef: publisher,
  action: "deployments.publish",
  idempotencyKey: "idem_publish_001",
  requestHash: publishRequestHash,
  event: {
    action: "deployments.publish",
    objectRef: pendingRelease.releaseId,
    kind: "release",
    status: "published_pending_readback",
    reasonCodes: [],
    detail: {
      kind: "release",
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      status: "published_pending_readback",
    },
  },
} as const satisfies PublishReleaseRequestMetadata;

const verifiedReadback = {
  managementTenantId: tenant,
  readbackRef: "readback_release_001",
  releaseId: pendingRelease.releaseId,
  revision: pendingRelease.revision,
  appliedReleaseId: pendingRelease.releaseId,
  appliedRevision: pendingRelease.revision,
  appliedModules: [moduleRef],
  status: "verified",
  reasonCodes: [],
  checkedAt: "2099-08-22T00:05:00Z",
} as const satisfies ModuleVerifiedReadbackRecord;

const publishReadbackMetadata = {
  managementTenantId: tenant,
  actorRef: publisher,
  action: "deployments.publish",
  idempotencyKey: publishMetadata.idempotencyKey,
  requestHash: publishRequestHash,
  event: {
    action: "deployments.publish",
    objectRef: pendingRelease.releaseId,
    kind: "reconciliation",
    status: "verified",
    reasonCodes: [],
    detail: {
      kind: "reconciliation",
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      readbackRef: verifiedReadback.readbackRef,
      status: "verified",
    },
  },
} as const satisfies PublishReadbackRequestMetadata;

const mismatchReadbackMetadata = {
  ...publishReadbackMetadata,
  event: {
    ...publishReadbackMetadata.event,
    status: "mismatch",
    reasonCodes: ["readback.release_mismatch"],
    detail: {
      ...publishReadbackMetadata.event.detail,
      readbackRef: "readback_release_001_mismatch",
      status: "mismatch",
    },
  },
} as const satisfies PublishReadbackRequestMetadata;

const mismatchReadback = {
  managementTenantId: tenant,
  readbackRef: "readback_release_001_mismatch",
  releaseId: pendingRelease.releaseId,
  revision: pendingRelease.revision,
  appliedReleaseId: null,
  appliedRevision: null,
  appliedModules: [],
  status: "mismatch",
  reasonCodes: ["readback.release_mismatch"],
  checkedAt: "2099-08-22T00:04:30Z",
} as const satisfies ModuleReadbackRecord;

const pendingReadback = {
  managementTenantId: tenant,
  readbackRef: "readback_release_001_pending",
  releaseId: pendingRelease.releaseId,
  revision: pendingRelease.revision,
  appliedReleaseId: null,
  appliedRevision: null,
  appliedModules: [],
  status: "pending",
  reasonCodes: [],
  checkedAt: "2099-08-22T00:03:30Z",
} as const satisfies ModulePendingReadbackRecord;

const reconcileVerifiedMetadata = {
  managementTenantId: tenant,
  actorRef: publisher,
  action: "deployments.reconcile",
  idempotencyKey: "idem_reconcile_001",
  requestHash: reconcileRequestHash,
  event: {
    action: "deployments.reconcile",
    objectRef: pendingRelease.releaseId,
    kind: "reconciliation",
    status: "verified",
    reasonCodes: [],
    detail: {
      kind: "reconciliation",
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      readbackRef: verifiedReadback.readbackRef,
      status: "verified",
    },
  },
} as const satisfies ReconcileRequestMetadata;

const reconcileMismatchMetadata = {
  ...reconcileVerifiedMetadata,
  event: {
    ...reconcileVerifiedMetadata.event,
    status: "mismatch",
    reasonCodes: mismatchReadback.reasonCodes,
    detail: {
      ...reconcileVerifiedMetadata.event.detail,
      readbackRef: mismatchReadback.readbackRef,
      status: "mismatch",
    },
  },
} as const satisfies ReconcileRequestMetadata;

const reconcileVerifiedRetryMetadata = {
  ...reconcileVerifiedMetadata,
  idempotencyKey: "idem_reconcile_retry_002",
  requestHash: `mcp-control-hash/v1/request/sha256:${"8".repeat(64)}` as const,
} as const satisfies ReconcileRequestMetadata;

const publishEnvelope = {
  schema_version: "2026-08-22.v1",
  request_id: "request_publish_001",
  trace_id: "trace_publish_001",
  audit_id: "audit_publish_001",
  status: "success",
  data: {
    kind: "release",
    release_id: pendingRelease.releaseId,
    revision: pendingRelease.revision,
    active_modules: [
      {
        module_id: "cargo",
        version: "1.0.0",
        descriptor_digest: descriptorDigest,
      },
    ],
  },
  reason_codes: [],
  readback: {
    status: "verified",
    release_id: pendingRelease.releaseId,
    revision: pendingRelease.revision,
  },
} as const satisfies ControlEnvelope;

const completedPublish = {
  managementTenantId: tenant,
  action: "deployments.publish",
  idempotencyKey: publishMetadata.idempotencyKey,
  requestHash: publishRequestHash,
  actorRef: publisher,
  status: "completed",
  domainRecordRef: pendingRelease.releaseId,
  finalResult: {
    domainRecordRef: pendingRelease.releaseId,
    envelope: publishEnvelope,
  },
  createdAt: pendingRelease.createdAt,
  expiresAt: "2099-08-23T00:03:00Z",
} as const satisfies CompletedModuleControlIdempotencyRecord;

const reconcileSuccessEnvelope = {
  schema_version: "2026-08-22.v1",
  request_id: "request_reconcile_001",
  trace_id: "trace_reconcile_001",
  audit_id: "audit_reconcile_001",
  status: "success",
  data: {
    kind: "reconciliation",
    release_id: pendingRelease.releaseId,
    revision: pendingRelease.revision,
    status: "verified",
  },
  reason_codes: [],
  readback: {
    status: "verified",
    release_id: pendingRelease.releaseId,
    revision: pendingRelease.revision,
  },
} as const satisfies ControlEnvelope;

const completedReconcile = {
  managementTenantId: tenant,
  action: "deployments.reconcile",
  idempotencyKey: reconcileVerifiedMetadata.idempotencyKey,
  requestHash: reconcileRequestHash,
  actorRef: publisher,
  status: "completed",
  domainRecordRef: pendingRelease.releaseId,
  finalResult: {
    domainRecordRef: pendingRelease.releaseId,
    envelope: reconcileSuccessEnvelope,
  },
  createdAt: verifiedReadback.checkedAt,
  expiresAt: "2099-08-23T00:05:00Z",
} as const satisfies CompletedModuleControlIdempotencyRecord;

const manualPublishFinalResult = {
  domainRecordRef: pendingRelease.releaseId,
  envelope: {
    ...publishEnvelope,
    status: "manual_review",
    reason_codes: ["readback.release_mismatch"],
    readback: {
      status: "mismatch",
      release_id: pendingRelease.releaseId,
      revision: pendingRelease.revision,
    },
  },
} as const satisfies ControlFinalResult;

const setPreview = {
  ...changePreview,
  previewRef: "preview_set_001",
  canonicalHash: setPreviewHash,
  inventoryRefs: [moduleRef, secondModuleRef],
  desiredModules: [moduleRef, secondModuleRef],
  diff: { added: [moduleRef, secondModuleRef], removed: [], retained: [] },
} as const satisfies ModuleChangePreviewRecord;

const setPreviewMetadata = {
  ...previewMetadata,
  idempotencyKey: "idem_preview_set_001",
  requestHash: `mcp-control-hash/v1/request/sha256:${"a".repeat(64)}` as const,
  event: {
    ...previewMetadata.event,
    objectRef: setPreview.previewRef,
    detail: {
      ...previewMetadata.event.detail,
      previewRef: setPreview.previewRef,
    },
  },
} as const satisfies CreatePreviewRequestMetadata;

const setPreviewFinalResult = {
  domainRecordRef: setPreview.previewRef,
  envelope: {
    ...previewEnvelope,
    request_id: "request_preview_set_001",
    trace_id: "trace_preview_set_001",
    audit_id: "audit_preview_set_001",
    data: {
      ...previewEnvelope.data,
      preview_ref: setPreview.previewRef,
      desired_modules: [
        {
          module_id: moduleRef.moduleId,
          version: moduleRef.version,
          descriptor_digest: moduleRef.descriptorDigest,
        },
        {
          module_id: secondModuleRef.moduleId,
          version: secondModuleRef.version,
          descriptor_digest: secondModuleRef.descriptorDigest,
        },
      ],
    },
  },
} as const satisfies ControlFinalResult;

const setApproval = {
  ...approval,
  approvalId: "approval_set_001",
  previewRef: setPreview.previewRef,
  previewCanonicalHash: setPreview.canonicalHash,
  inventoryDigestSet: [descriptorDigest, secondDescriptorDigest],
} as const satisfies ModuleApprovalRecord;

const setApprovalMetadata = {
  ...approvalMetadata,
  idempotencyKey: "idem_approval_set_001",
  requestHash: `mcp-control-hash/v1/request/sha256:${"c".repeat(64)}` as const,
  event: {
    ...approvalMetadata.event,
    objectRef: setApproval.approvalId,
    detail: {
      ...approvalMetadata.event.detail,
      approvalId: setApproval.approvalId,
      previewRef: setApproval.previewRef,
    },
  },
} as const satisfies DecideApprovalRequestMetadata;

const setApprovalFinalResult = {
  domainRecordRef: setApproval.approvalId,
  envelope: {
    ...approvalEnvelope,
    request_id: "request_approval_set_001",
    trace_id: "trace_approval_set_001",
    audit_id: "audit_approval_set_001",
    data: {
      ...approvalEnvelope.data,
      approval_id: setApproval.approvalId,
      preview_ref: setApproval.previewRef,
    },
  },
} as const satisfies ControlFinalResult;

const setPendingRelease = {
  ...pendingRelease,
  releaseId: "release_set_001",
  previewRef: setPreview.previewRef,
  approvalId: setApproval.approvalId,
  desiredModules: [
    {
      descriptorDigest: secondModuleRef.descriptorDigest,
      version: secondModuleRef.version,
      moduleId: secondModuleRef.moduleId,
    },
    {
      descriptorDigest: moduleRef.descriptorDigest,
      version: moduleRef.version,
      moduleId: moduleRef.moduleId,
    },
  ],
} as const satisfies ModulePendingReleaseRecord;

const setPublishMetadata = {
  ...publishMetadata,
  idempotencyKey: "idem_publish_set_001",
  requestHash: `mcp-control-hash/v1/request/sha256:${"d".repeat(64)}` as const,
  event: {
    ...publishMetadata.event,
    objectRef: setPendingRelease.releaseId,
    detail: {
      ...publishMetadata.event.detail,
      releaseId: setPendingRelease.releaseId,
    },
  },
} as const satisfies PublishReleaseRequestMetadata;

const setVerifiedReadback = {
  ...verifiedReadback,
  readbackRef: "readback_release_set_001",
  releaseId: setPendingRelease.releaseId,
  appliedReleaseId: setPendingRelease.releaseId,
  appliedModules: setPendingRelease.desiredModules,
} as const satisfies ModuleVerifiedReadbackRecord;

const setPublishReadbackMetadata = {
  ...publishReadbackMetadata,
  idempotencyKey: setPublishMetadata.idempotencyKey,
  requestHash: setPublishMetadata.requestHash,
  event: {
    ...publishReadbackMetadata.event,
    objectRef: setPendingRelease.releaseId,
    detail: {
      ...publishReadbackMetadata.event.detail,
      releaseId: setPendingRelease.releaseId,
      readbackRef: setVerifiedReadback.readbackRef,
    },
  },
} as const satisfies PublishReadbackRequestMetadata;

const secondChangePreview = {
  ...setPreview,
  previewRef: "preview_change_002",
  canonicalHash: `mcp-control-hash/v1/preview/sha256:${"c".repeat(64)}` as const,
  baseReleaseId: pendingRelease.releaseId,
  baseRevision: pendingRelease.revision,
  diff: { added: [secondModuleRef], removed: [], retained: [moduleRef] },
  createdAt: "2099-08-22T00:05:00Z",
  expiresAt: "2099-08-23T00:05:00Z",
} as const satisfies ModuleChangePreviewRecord;

const secondPreviewMetadata = {
  ...previewMetadata,
  idempotencyKey: "idem_preview_002",
  requestHash: `mcp-control-hash/v1/request/sha256:${"e".repeat(64)}` as const,
  event: {
    ...previewMetadata.event,
    objectRef: secondChangePreview.previewRef,
    detail: {
      ...previewMetadata.event.detail,
      previewRef: secondChangePreview.previewRef,
      baseRevision: secondChangePreview.baseRevision,
    },
  },
} as const satisfies CreatePreviewRequestMetadata;

const secondPreviewFinalResult = {
  ...setPreviewFinalResult,
  domainRecordRef: secondChangePreview.previewRef,
  envelope: {
    ...setPreviewFinalResult.envelope,
    request_id: "request_preview_002",
    trace_id: "trace_preview_002",
    audit_id: "audit_preview_002",
    data: {
      ...setPreviewFinalResult.envelope.data,
      preview_ref: secondChangePreview.previewRef,
      base_release_id: secondChangePreview.baseReleaseId,
      base_revision: secondChangePreview.baseRevision,
      expires_at: secondChangePreview.expiresAt,
    },
  },
} as const satisfies ControlFinalResult;

const secondApproval = {
  ...setApproval,
  approvalId: "approval_002",
  previewRef: secondChangePreview.previewRef,
  previewCanonicalHash: secondChangePreview.canonicalHash,
  baseReleaseId: secondChangePreview.baseReleaseId,
  baseRevision: secondChangePreview.baseRevision,
  expiresAt: secondChangePreview.expiresAt,
  decidedAt: "2099-08-22T00:06:00Z",
} as const satisfies ModuleApprovalRecord;

const secondApprovalMetadata = {
  ...approvalMetadata,
  idempotencyKey: "idem_approval_002",
  requestHash: `mcp-control-hash/v1/request/sha256:${"f".repeat(64)}` as const,
  event: {
    ...approvalMetadata.event,
    objectRef: secondApproval.approvalId,
    detail: {
      ...approvalMetadata.event.detail,
      approvalId: secondApproval.approvalId,
      previewRef: secondApproval.previewRef,
    },
  },
} as const satisfies DecideApprovalRequestMetadata;

const secondApprovalFinalResult = {
  ...setApprovalFinalResult,
  domainRecordRef: secondApproval.approvalId,
  envelope: {
    ...setApprovalFinalResult.envelope,
    request_id: "request_approval_002",
    trace_id: "trace_approval_002",
    audit_id: "audit_approval_002",
    data: {
      ...setApprovalFinalResult.envelope.data,
      approval_id: secondApproval.approvalId,
      preview_ref: secondApproval.previewRef,
    },
  },
} as const satisfies ControlFinalResult;

const secondPendingRelease = {
  ...setPendingRelease,
  releaseId: "release_002",
  revision: 2,
  previousReleaseId: pendingRelease.releaseId,
  previewRef: secondChangePreview.previewRef,
  approvalId: secondApproval.approvalId,
  createdAt: "2099-08-22T00:07:00Z",
  publishedAt: "2099-08-22T00:07:00Z",
} as const satisfies ModulePendingReleaseRecord;

const secondPublishMetadata = {
  ...publishMetadata,
  idempotencyKey: "idem_publish_002",
  requestHash: `mcp-control-hash/v1/request/sha256:${"0".repeat(64)}` as const,
  event: {
    ...publishMetadata.event,
    objectRef: secondPendingRelease.releaseId,
    detail: {
      ...publishMetadata.event.detail,
      releaseId: secondPendingRelease.releaseId,
      revision: secondPendingRelease.revision,
    },
  },
} as const satisfies PublishReleaseRequestMetadata;

const secondVerifiedReadback = {
  ...setVerifiedReadback,
  readbackRef: "readback_release_002",
  releaseId: secondPendingRelease.releaseId,
  revision: secondPendingRelease.revision,
  appliedReleaseId: secondPendingRelease.releaseId,
  appliedRevision: secondPendingRelease.revision,
  appliedModules: secondPendingRelease.desiredModules,
  checkedAt: "2099-08-22T00:08:00Z",
} as const satisfies ModuleVerifiedReadbackRecord;

const secondPublishReadbackMetadata = {
  ...publishReadbackMetadata,
  idempotencyKey: secondPublishMetadata.idempotencyKey,
  requestHash: secondPublishMetadata.requestHash,
  event: {
    ...publishReadbackMetadata.event,
    objectRef: secondPendingRelease.releaseId,
    detail: {
      ...publishReadbackMetadata.event.detail,
      releaseId: secondPendingRelease.releaseId,
      revision: secondPendingRelease.revision,
      readbackRef: secondVerifiedReadback.readbackRef,
    },
  },
} as const satisfies PublishReadbackRequestMetadata;

const secondPublishEnvelope = {
  ...publishEnvelope,
  request_id: "request_publish_002",
  trace_id: "trace_publish_002",
  audit_id: "audit_publish_002",
  data: {
    ...publishEnvelope.data,
    release_id: secondPendingRelease.releaseId,
    revision: secondPendingRelease.revision,
    active_modules: [
      {
        module_id: moduleRef.moduleId,
        version: moduleRef.version,
        descriptor_digest: moduleRef.descriptorDigest,
      },
      {
        module_id: secondModuleRef.moduleId,
        version: secondModuleRef.version,
        descriptor_digest: secondModuleRef.descriptorDigest,
      },
    ],
  },
  readback: {
    status: "verified",
    release_id: secondPendingRelease.releaseId,
    revision: secondPendingRelease.revision,
  },
} as const satisfies ControlEnvelope;

const completedSecondPublish = {
  managementTenantId: tenant,
  action: "deployments.publish",
  idempotencyKey: secondPublishMetadata.idempotencyKey,
  requestHash: secondPublishMetadata.requestHash,
  actorRef: secondPendingRelease.publisherActorRef,
  status: "completed",
  domainRecordRef: secondPendingRelease.releaseId,
  finalResult: {
    domainRecordRef: secondPendingRelease.releaseId,
    envelope: secondPublishEnvelope,
  },
  createdAt: secondPendingRelease.createdAt,
  expiresAt: "2099-08-23T00:07:00Z",
} as const satisfies CompletedModuleControlIdempotencyRecord;

const e2eRollbackPreview = {
  managementTenantId: tenant,
  previewRef: "preview_rollback_003",
  canonicalHash: `mcp-control-hash/v1/preview/sha256:${"d".repeat(64)}` as const,
  baseReleaseId: secondPendingRelease.releaseId,
  baseRevision: secondPendingRelease.revision,
  inventoryRefs: [moduleRef, secondModuleRef],
  desiredModules: [moduleRef],
  diff: { added: [], removed: [secondModuleRef], retained: [moduleRef] },
  validation: {
    baseMatches: true,
    desiredModulesValid: true,
    inventoryMatches: true,
    minimumActiveModules: true,
    reasonCodes: [],
  },
  creatorActorRef: actor,
  createdAt: "2099-08-22T00:09:00Z",
  expiresAt: "2099-08-23T00:09:00Z",
  consumed: false,
  intent: "rollback",
  targetReleaseId: pendingRelease.releaseId,
} as const satisfies ModuleRollbackPreviewRecord;

const e2eRollbackPreviewMetadata = {
  ...rollbackPreviewMetadata,
  idempotencyKey: "idem_preview_rollback_003",
  requestHash: `mcp-control-hash/v1/request/sha256:${"1".repeat(64)}` as const,
  event: {
    ...rollbackPreviewMetadata.event,
    objectRef: e2eRollbackPreview.previewRef,
    detail: {
      ...rollbackPreviewMetadata.event.detail,
      previewRef: e2eRollbackPreview.previewRef,
      baseRevision: e2eRollbackPreview.baseRevision,
    },
  },
} as const satisfies CreatePreviewRequestMetadata;

const e2eRollbackPreviewFinalResult = {
  domainRecordRef: e2eRollbackPreview.previewRef,
  envelope: {
    ...rollbackPreviewEnvelope,
    request_id: "request_preview_rollback_003",
    trace_id: "trace_preview_rollback_003",
    audit_id: "audit_preview_rollback_003",
    data: {
      ...rollbackPreviewEnvelope.data,
      preview_ref: e2eRollbackPreview.previewRef,
      base_release_id: e2eRollbackPreview.baseReleaseId,
      base_revision: e2eRollbackPreview.baseRevision,
      desired_modules: [
        {
          module_id: moduleRef.moduleId,
          version: moduleRef.version,
          descriptor_digest: moduleRef.descriptorDigest,
        },
      ],
      target_release_id: e2eRollbackPreview.targetReleaseId,
      expires_at: e2eRollbackPreview.expiresAt,
    },
  },
} as const satisfies ControlFinalResult;

const e2eRollbackApproval = {
  ...approval,
  approvalId: "approval_rollback_003",
  previewRef: e2eRollbackPreview.previewRef,
  previewCanonicalHash: e2eRollbackPreview.canonicalHash,
  baseReleaseId: e2eRollbackPreview.baseReleaseId,
  baseRevision: e2eRollbackPreview.baseRevision,
  inventoryDigestSet: [descriptorDigest, secondDescriptorDigest],
  expiresAt: e2eRollbackPreview.expiresAt,
  decidedAt: "2099-08-22T00:10:00Z",
} as const satisfies ModuleApprovalRecord;

const e2eRollbackApprovalMetadata = {
  ...approvalMetadata,
  idempotencyKey: "idem_approval_rollback_003",
  requestHash: `mcp-control-hash/v1/request/sha256:${"2".repeat(64)}` as const,
  event: {
    ...approvalMetadata.event,
    objectRef: e2eRollbackApproval.approvalId,
    detail: {
      ...approvalMetadata.event.detail,
      approvalId: e2eRollbackApproval.approvalId,
      previewRef: e2eRollbackApproval.previewRef,
    },
  },
} as const satisfies DecideApprovalRequestMetadata;

const e2eRollbackApprovalFinalResult = {
  domainRecordRef: e2eRollbackApproval.approvalId,
  envelope: {
    ...approvalEnvelope,
    request_id: "request_approval_rollback_003",
    trace_id: "trace_approval_rollback_003",
    audit_id: "audit_approval_rollback_003",
    data: {
      ...approvalEnvelope.data,
      approval_id: e2eRollbackApproval.approvalId,
      preview_ref: e2eRollbackApproval.previewRef,
    },
  },
} as const satisfies ControlFinalResult;

const rollbackPendingRelease = {
  ...pendingRelease,
  releaseId: "release_003",
  revision: 3,
  desiredModules: [moduleRef],
  previousReleaseId: secondPendingRelease.releaseId,
  previewRef: e2eRollbackPreview.previewRef,
  approvalId: e2eRollbackApproval.approvalId,
  createdAt: "2099-08-22T00:11:00Z",
  publishedAt: "2099-08-22T00:11:00Z",
} as const satisfies ModulePendingReleaseRecord;

const rollbackPublishMetadata = {
  ...publishMetadata,
  idempotencyKey: "idem_publish_rollback_003",
  requestHash: `mcp-control-hash/v1/request/sha256:${"4".repeat(64)}` as const,
  event: {
    ...publishMetadata.event,
    objectRef: rollbackPendingRelease.releaseId,
    detail: {
      ...publishMetadata.event.detail,
      releaseId: rollbackPendingRelease.releaseId,
      revision: rollbackPendingRelease.revision,
    },
  },
} as const satisfies PublishReleaseRequestMetadata;

const rollbackVerifiedReadback = {
  ...verifiedReadback,
  readbackRef: "readback_release_003",
  releaseId: rollbackPendingRelease.releaseId,
  revision: rollbackPendingRelease.revision,
  appliedReleaseId: rollbackPendingRelease.releaseId,
  appliedRevision: rollbackPendingRelease.revision,
  appliedModules: [moduleRef],
  checkedAt: "2099-08-22T00:12:00Z",
} as const satisfies ModuleVerifiedReadbackRecord;

const rollbackReadbackMetadata = {
  ...publishReadbackMetadata,
  idempotencyKey: rollbackPublishMetadata.idempotencyKey,
  requestHash: rollbackPublishMetadata.requestHash,
  event: {
    ...publishReadbackMetadata.event,
    objectRef: rollbackPendingRelease.releaseId,
    detail: {
      ...publishReadbackMetadata.event.detail,
      releaseId: rollbackPendingRelease.releaseId,
      revision: rollbackPendingRelease.revision,
      readbackRef: rollbackVerifiedReadback.readbackRef,
    },
  },
} as const satisfies PublishReadbackRequestMetadata;

const rollbackPublishEnvelope = {
  ...publishEnvelope,
  request_id: "request_publish_rollback_003",
  trace_id: "trace_publish_rollback_003",
  audit_id: "audit_publish_rollback_003",
  data: {
    ...publishEnvelope.data,
    release_id: rollbackPendingRelease.releaseId,
    revision: rollbackPendingRelease.revision,
  },
  readback: {
    status: "verified",
    release_id: rollbackPendingRelease.releaseId,
    revision: rollbackPendingRelease.revision,
  },
} as const satisfies ControlEnvelope;

const completedRollbackPublish = {
  managementTenantId: tenant,
  action: "deployments.publish",
  idempotencyKey: rollbackPublishMetadata.idempotencyKey,
  requestHash: rollbackPublishMetadata.requestHash,
  actorRef: rollbackPendingRelease.publisherActorRef,
  status: "completed",
  domainRecordRef: rollbackPendingRelease.releaseId,
  finalResult: {
    domainRecordRef: rollbackPendingRelease.releaseId,
    envelope: rollbackPublishEnvelope,
  },
  createdAt: rollbackPendingRelease.createdAt,
  expiresAt: "2099-08-23T00:11:00Z",
} as const satisfies CompletedModuleControlIdempotencyRecord;

function registerRequest() {
  return {
    metadata: registrationMetadata,
    record: registrationRecord,
    finalResult: registrationFinalResult,
  } as const;
}

function previewRequest() {
  return {
    metadata: previewMetadata,
    record: changePreview,
    finalResult: previewFinalResult,
  } as const;
}

function approvalRequest() {
  return {
    metadata: approvalMetadata,
    record: approval,
    finalResult: approvalFinalResult,
  } as const;
}

function publishRequest() {
  return { metadata: publishMetadata, record: pendingRelease } as const;
}

function verifiedReadbackRequest(): ReadbackFixtureRequest {
  return {
    metadata: publishReadbackMetadata,
    record: verifiedReadback,
  };
}

function setPreviewRequest() {
  return {
    metadata: setPreviewMetadata,
    record: setPreview,
    finalResult: setPreviewFinalResult,
  } as const;
}

function setApprovalRequest() {
  return {
    metadata: setApprovalMetadata,
    record: setApproval,
    finalResult: setApprovalFinalResult,
  } as const;
}

function setPublishRequest(): PublishReleaseRecordRequest {
  return { metadata: setPublishMetadata, record: setPendingRelease };
}

function setVerifiedReadbackRequest(): ReadbackFixtureRequest {
  return {
    metadata: setPublishReadbackMetadata,
    record: setVerifiedReadback,
  };
}

function controlDatabasePath(applicationRoot: string): string {
  return join(applicationRoot, ".runtime/mcp-instance-state/control.sqlite");
}

async function seedPendingStore(applicationRoot: string) {
  const store = openStore(applicationRoot);
  await store.registerModule(registerRequest());
  await store.createPreview(previewRequest());
  await store.decideApproval(approvalRequest());
  const published = await store.publishRelease(publishRequest());
  return { store, published };
}

async function finalizeReadbackAttempt(
  store: ReturnType<typeof openStore>,
  request: ReadbackFixtureRequest,
  finalResult: ControlFinalResult,
  options: {
    readonly attemptId?: string;
    readonly claimedAt?: string;
    readonly finalizedAt?: string;
  } = {},
) {
  if (request.record.status === "pending") {
    throw new Error("pending readbacks must use an unfinished attempt claim");
  }
  const claim = await claimReadbackAttemptFixture(
    store,
    request,
    finalResult,
    options,
  );
  return store.finalizeReadbackAndComplete({
    attemptId: claim.attempt.attemptId,
    ownerCapability: claim.ownerCapability,
    observation: {
      status: request.record.status,
      appliedReleaseId: request.record.appliedReleaseId,
      appliedRevision: request.record.appliedRevision,
      appliedModules: request.record.appliedModules,
      reasonCodes: request.record.reasonCodes,
      checkedAt: request.record.checkedAt,
    },
    finalResult,
    finalizedAt: options.finalizedAt ?? request.record.checkedAt,
  });
}

async function claimReadbackAttemptFixture(
  store: ReturnType<typeof openStore>,
  request: ReadbackFixtureRequest,
  finalResult: ControlFinalResult,
  options: {
    readonly attemptId?: string;
    readonly claimedAt?: string;
    readonly finalizedAt?: string;
  } = {},
) {
  const release = await store.getRelease({
    managementTenantId: tenant,
    releaseId: request.record.releaseId,
  });
  if (release === null) throw new Error(`missing release ${request.record.releaseId}`);
  if (request.record.status === "pending") {
    throw new Error("pending readbacks must use an unfinished attempt claim");
  }
  const envelope = finalResult.envelope;
  const claim = await store.claimReadbackAttempt({
    metadata: {
      managementTenantId: request.metadata.managementTenantId,
      actorRef: request.metadata.actorRef,
      action: request.metadata.action,
      idempotencyKey: request.metadata.idempotencyKey,
      requestHash: request.metadata.requestHash,
      requestId: envelope.request_id,
      traceId: envelope.trace_id,
      auditId: envelope.audit_id,
    },
    attemptId:
      options.attemptId ?? `attempt_${request.metadata.idempotencyKey}`,
    readbackRef: request.record.readbackRef,
    releaseId: request.record.releaseId,
    revision: request.record.revision,
    desiredModules: release.desiredModules,
    ownerBootId: "boot_test_fixture",
    claimedAt: options.claimedAt ?? release.createdAt,
  });
  if (claim.disposition !== "created") {
    throw new Error(`expected a new attempt for ${request.metadata.idempotencyKey}`);
  }
  return claim;
}

async function seedTwoVerifiedReleases(applicationRoot: string) {
  const { store } = await seedPendingStore(applicationRoot);
  await finalizeReadbackAttempt(
    store,
    verifiedReadbackRequest(),
    completedPublish.finalResult,
  );
  await store.createPreview({
    metadata: secondPreviewMetadata,
    record: secondChangePreview,
    finalResult: secondPreviewFinalResult,
  });
  await store.decideApproval({
    metadata: secondApprovalMetadata,
    record: secondApproval,
    finalResult: secondApprovalFinalResult,
  });
  await store.publishRelease({
    metadata: secondPublishMetadata,
    record: secondPendingRelease,
  });
  await finalizeReadbackAttempt(
    store,
    {
      metadata: secondPublishReadbackMetadata,
      record: secondVerifiedReadback,
    },
    completedSecondPublish.finalResult,
  );
  return store;
}

function semanticProbeRegisterRequest() {
  const moduleId = "semantic_probe";
  const recordRef = `registration:${moduleId}:1.0.0:${secondDescriptorDigest}`;
  return {
    metadata: {
      ...registrationMetadata,
      idempotencyKey: "idem_semantic_probe_001",
      requestHash: `mcp-control-hash/v1/request/sha256:${"a".repeat(64)}` as const,
      event: {
        ...registrationMetadata.event,
        objectRef: recordRef,
        detail: {
          ...registrationMetadata.event.detail,
          recordRef,
          moduleId,
          descriptorDigest: secondDescriptorDigest,
        },
      },
    },
    record: {
      ...registrationRecord,
      moduleId,
      descriptorDigest: secondDescriptorDigest,
    },
    finalResult: {
      domainRecordRef: recordRef,
      envelope: {
        ...registrationEnvelope,
        request_id: "request_semantic_probe_001",
        trace_id: "trace_semantic_probe_001",
        audit_id: "audit_semantic_probe_001",
        data: {
          ...registrationEnvelope.data,
          module_id: moduleId,
          descriptor_digest: secondDescriptorDigest,
        },
      },
    },
  } as const;
}

function persistedRowCounts(applicationRoot: string) {
  const database = new DatabaseSync(controlDatabasePath(applicationRoot));
  try {
    const count = (table: string): number => Number(
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    );
    return {
      registrations: count("module_registrations"),
      previews: count("module_previews"),
      approvals: count("module_approvals"),
      releases: count("module_releases"),
      readbacks: count("module_readbacks"),
      idempotencies: count("module_control_idempotency"),
      events: count("module_control_events"),
    };
  } finally {
    database.close();
  }
}

async function expectSemanticCorruptionFailsClosed(
  store: ModuleControlRepository,
): Promise<void> {
  await expect(store.health()).resolves.toEqual({ ready: false });
  const operations: ReadonlyArray<() => Promise<unknown>> = [
    () => store.registerModule(semanticProbeRegisterRequest()),
    () => store.createPreview(previewRequest()),
    () => store.decideApproval(approvalRequest()),
    () => store.publishRelease(publishRequest()),
    () => store.getControlState(),
    () => store.getActiveRelease(),
    () => store.getPendingRelease(),
    () => store.getNewestUnresolvedRelease(),
    () => store.getPreview({ managementTenantId: tenant, previewRef: changePreview.previewRef }),
    () => store.getApproval({ managementTenantId: tenant, approvalId: approval.approvalId }),
    () => store.getRelease({ managementTenantId: tenant, releaseId: pendingRelease.releaseId }),
    () => store.getReadback({ managementTenantId: tenant, releaseId: pendingRelease.releaseId }),
    () => store.getIdempotency({
      managementTenantId: tenant,
      action: publishMetadata.action,
      idempotencyKey: publishMetadata.idempotencyKey,
    }),
  ];
  for (const operation of operations) {
    await expect(operation()).rejects.toMatchObject({ code: "invalid_state" });
  }
  await store.close();
}

describe("SQLite control repository", () => {
  it("persists, replays, and restores a registration through the repository contract", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });

    const first = openStore(applicationRoot);
    const repository: ModuleControlRepository = first;
    const created = await repository.registerModule({
      metadata: registrationMetadata,
      record: registrationRecord,
      finalResult: registrationFinalResult,
    });

    expect(created.replayed).toBe(false);
    expect(created.record).toEqual(registrationRecord);
    expect(created.event.kind).toBe("registration");
    await expect(repository.getControlState()).resolves.toMatchObject({
      managementTenantId: tenant,
      registrations: [registrationRecord],
      activeRelease: null,
      activeRevision: 0,
    });

    const replay = await repository.registerModule({
      metadata: registrationMetadata,
      record: registrationRecord,
      finalResult: registrationFinalResult,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(registrationRecord);
    expect(replay.event).toEqual(created.event);

    await repository.close();
    const reopened = openStore(applicationRoot);
    await expect(reopened.health()).resolves.toEqual({ ready: true });
    await expect(reopened.getControlState()).resolves.toMatchObject({
      registrations: [registrationRecord],
      events: [expect.objectContaining({ kind: "registration", sequence: 1 })],
    });
    await reopened.close();
  });

  it("uses bound operation timestamps for approval and publish expiry boundaries", async () => {
    const previewCreatedAt = "2099-08-22T00:00:00.100Z";
    const beforeExpiry = "2099-08-22T00:00:00.999Z";
    const expiresAt = "2099-08-22T00:00:01Z";
    const temporalPreview = {
      ...changePreview,
      createdAt: previewCreatedAt,
      expiresAt,
    } as const satisfies ModuleChangePreviewRecord;
    const temporalPreviewFinalResult = {
      ...previewFinalResult,
      envelope: {
        ...previewEnvelope,
        data: {
          ...previewEnvelope.data,
          expires_at: expiresAt,
        },
      },
    } as const satisfies ControlFinalResult;

    const setupTemporalGate = async (decidedAt: string) => {
      const applicationRoot = makeApplicationRoot();
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: tenant,
      });
      const store = openStore(applicationRoot);
      await store.registerModule(registerRequest());
      await store.createPreview({
        metadata: previewMetadata,
        record: temporalPreview,
        finalResult: temporalPreviewFinalResult,
      });
      const temporalApproval = {
        ...approval,
        expiresAt,
        decidedAt,
      } satisfies ModuleApprovalRecord;
      return { store, temporalApproval };
    };

    const beforeExpiryGate = await setupTemporalGate(beforeExpiry);
    await expect(
      beforeExpiryGate.store.decideApproval({
        metadata: approvalMetadata,
        record: beforeExpiryGate.temporalApproval,
        finalResult: approvalFinalResult,
      }),
    ).resolves.toMatchObject({ replayed: false });
    const beforeExpiryRelease = {
      ...pendingRelease,
      createdAt: beforeExpiry,
      publishedAt: beforeExpiry,
    } satisfies ModulePendingReleaseRecord;
    await expect(
      beforeExpiryGate.store.publishRelease({
        metadata: publishMetadata,
        record: beforeExpiryRelease,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      record: { releaseId: pendingRelease.releaseId },
    });
    await beforeExpiryGate.store.close();

    const approvalAtExpiryGate = await setupTemporalGate(expiresAt);
    await expect(
      approvalAtExpiryGate.store.decideApproval({
        metadata: approvalMetadata,
        record: approvalAtExpiryGate.temporalApproval,
        finalResult: approvalFinalResult,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      approvalAtExpiryGate.store.getApproval({
        managementTenantId: tenant,
        approvalId: approval.approvalId,
      }),
    ).resolves.toBeNull();
    await expect(
      approvalAtExpiryGate.store.getIdempotency({
        managementTenantId: tenant,
        action: approvalMetadata.action,
        idempotencyKey: approvalMetadata.idempotencyKey,
      }),
    ).resolves.toBeNull();
    await approvalAtExpiryGate.store.close();

    const publishAtExpiryGate = await setupTemporalGate(beforeExpiry);
    await publishAtExpiryGate.store.decideApproval({
      metadata: approvalMetadata,
      record: publishAtExpiryGate.temporalApproval,
      finalResult: approvalFinalResult,
    });
    const stateBeforeExpiredPublish = await publishAtExpiryGate.store.getControlState();
    const publishAtExpiryRelease = {
      ...pendingRelease,
      createdAt: expiresAt,
      publishedAt: expiresAt,
    } satisfies ModulePendingReleaseRecord;
    await expect(
      publishAtExpiryGate.store.publishRelease({
        metadata: publishMetadata,
        record: publishAtExpiryRelease,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(publishAtExpiryGate.store.getControlState()).resolves.toEqual(
      stateBeforeExpiredPublish,
    );
    await expect(publishAtExpiryGate.store.getPendingRelease()).resolves.toBeNull();
    await expect(
      publishAtExpiryGate.store.getIdempotency({
        managementTenantId: tenant,
        action: publishMetadata.action,
        idempotencyKey: publishMetadata.idempotencyKey,
      }),
    ).resolves.toBeNull();
    await publishAtExpiryGate.store.close();
  });

  it("accepts offset-equivalent and equal publication instants but rejects a reverse nanosecond on SQLite writes", async () => {
    const cases = [
      {
        label: "offset-equivalent instant",
        createdAt: "2099-08-22T00:03:00.000000001Z",
        publishedAt: "2099-08-21T19:03:00.000000001-05:00",
        accepted: true,
      },
      {
        label: "equal instant",
        createdAt: "2099-08-22T00:03:00.000000001Z",
        publishedAt: "2099-08-22T00:03:00.000000001Z",
        accepted: true,
      },
      {
        label: "reverse one nanosecond",
        createdAt: "2099-08-22T00:03:00.000000002Z",
        publishedAt: "2099-08-22T00:03:00.000000001Z",
        accepted: false,
      },
    ] as const;

    for (const testCase of cases) {
      const applicationRoot = makeApplicationRoot();
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: tenant,
      });
      const store = openStore(applicationRoot);
      await store.createPreview(previewRequest());
      await store.decideApproval(approvalRequest());
      const request = {
        metadata: publishMetadata,
        record: {
          ...pendingRelease,
          createdAt: testCase.createdAt,
          publishedAt: testCase.publishedAt,
        },
      } as const satisfies PublishReleaseRecordRequest;
      if (testCase.accepted) {
        await expect(store.publishRelease(request), testCase.label).resolves.toMatchObject({
          record: { createdAt: testCase.createdAt, publishedAt: testCase.publishedAt },
        });
        await expect(store.getRelease({
          managementTenantId: tenant,
          releaseId: pendingRelease.releaseId,
        })).resolves.toMatchObject({
          createdAt: testCase.createdAt,
          publishedAt: testCase.publishedAt,
        });
      } else {
        await expect(store.publishRelease(request), testCase.label).rejects.toMatchObject({
          code: "invalid_state",
        });
        await expect(store.getPendingRelease()).resolves.toBeNull();
      }
      await store.close();
    }
  });

  it("stores pending publishedAt null as SQL NULL and round-trips it after reopen", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await store.createPreview(previewRequest());
    await store.decideApproval(approvalRequest());
    const nullPublishedRelease = {
      ...pendingRelease,
      publishedAt: null,
    } as const satisfies ModulePendingReleaseRecord;
    await expect(store.publishRelease({
      metadata: publishMetadata,
      record: nullPublishedRelease,
    })).resolves.toMatchObject({
      replayed: false,
      record: nullPublishedRelease,
    });
    await expect(store.getRelease({
      managementTenantId: tenant,
      releaseId: nullPublishedRelease.releaseId,
    })).resolves.toEqual(nullPublishedRelease);
    await store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(database.prepare(
        "SELECT published_at, typeof(published_at) AS storage_type FROM module_releases",
      ).get()).toEqual({ published_at: null, storage_type: "null" });
    } finally {
      database.close();
    }

    const reopened = openStore(applicationRoot);
    await expect(reopened.health()).resolves.toEqual({ ready: true });
    await expect(reopened.getPendingRelease()).resolves.toEqual(nullPublishedRelease);
    await expect(reopened.getControlState()).resolves.toMatchObject({
      releaseHistory: [{ release: nullPublishedRelease }],
    });
    await reopened.close();
  });

  it("preserves nanoseconds in idempotency TTL and expiry comparisons", async () => {
    const preciseRegisteredAt = "2099-08-22T03:00:00.123456789+02:30";
    const registrationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot: registrationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const registrationStore = openStore(registrationRoot);
    await registrationStore.registerModule({
      ...registerRequest(),
      record: {
        ...registrationRecord,
        registeredAt: preciseRegisteredAt,
      },
    });
    await expect(registrationStore.getIdempotency({
      managementTenantId: tenant,
      action: registrationMetadata.action,
      idempotencyKey: registrationMetadata.idempotencyKey,
    })).resolves.toMatchObject({
      createdAt: preciseRegisteredAt,
      expiresAt: "2099-08-23T00:30:00.123456789Z",
    });
    await registrationStore.close();

    const expiresAt = "2099-08-22T00:00:00.000000001Z";
    const beforeExpiry = "2099-08-22T00:00:00Z";
    const setupPreciseGate = async (decidedAt: string) => {
      const applicationRoot = makeApplicationRoot();
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: tenant,
      });
      const store = openStore(applicationRoot);
      await store.registerModule(registerRequest());
      const precisePreview = {
        ...changePreview,
        createdAt: "2099-08-22T00:00:00Z",
        expiresAt,
      } as const satisfies ModuleChangePreviewRecord;
      await store.createPreview({
        metadata: previewMetadata,
        record: precisePreview,
        finalResult: {
          ...previewFinalResult,
          envelope: {
            ...previewFinalResult.envelope,
            data: {
              ...previewFinalResult.envelope.data,
              expires_at: expiresAt,
            },
          },
        },
      });
      return {
        store,
        approval: {
          ...approval,
          decidedAt,
          expiresAt,
        } as const satisfies ModuleApprovalRecord,
      };
    };

    const beforeGate = await setupPreciseGate(beforeExpiry);
    await expect(beforeGate.store.decideApproval({
      metadata: approvalMetadata,
      record: beforeGate.approval,
      finalResult: approvalFinalResult,
    })).resolves.toMatchObject({ replayed: false });
    await expect(beforeGate.store.publishRelease({
      metadata: publishMetadata,
      record: {
        ...pendingRelease,
        createdAt: beforeExpiry,
        publishedAt: beforeExpiry,
      },
    })).resolves.toMatchObject({ replayed: false });
    await beforeGate.store.close();

    const equalOffsetGate = await setupPreciseGate(
      "2099-08-21T19:00:00.000000001-05:00",
    );
    await expect(equalOffsetGate.store.decideApproval({
      metadata: approvalMetadata,
      record: equalOffsetGate.approval,
      finalResult: approvalFinalResult,
    })).rejects.toMatchObject({ code: "conflict" });
    await equalOffsetGate.store.close();

    const publishAtEqualOffsetGate = await setupPreciseGate(beforeExpiry);
    await publishAtEqualOffsetGate.store.decideApproval({
      metadata: approvalMetadata,
      record: publishAtEqualOffsetGate.approval,
      finalResult: approvalFinalResult,
    });
    await expect(publishAtEqualOffsetGate.store.publishRelease({
      metadata: publishMetadata,
      record: {
        ...pendingRelease,
        createdAt: "2099-08-21T19:00:00.000000001-05:00",
        publishedAt: "2099-08-21T19:00:00.000000001-05:00",
      },
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(publishAtEqualOffsetGate.store.getPendingRelease()).resolves.toBeNull();
    await publishAtEqualOffsetGate.store.close();
  });

  it("round-trips completed idempotency records in-process and after reopen for every action", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);

    await store.registerModule(registerRequest());
    await store.createPreview(previewRequest());
    await store.decideApproval(approvalRequest());
    await store.close();

    const storeAfterSimpleCompletion = openStore(applicationRoot);

    await storeAfterSimpleCompletion.publishRelease(publishRequest());
    await finalizeReadbackAttempt(
      storeAfterSimpleCompletion,
      { metadata: mismatchReadbackMetadata, record: mismatchReadback },
      manualPublishFinalResult,
    );
    await finalizeReadbackAttempt(
      storeAfterSimpleCompletion,
      { metadata: reconcileVerifiedMetadata, record: verifiedReadback },
      completedReconcile.finalResult,
    );

    const expectedIdempotencies = [
      { action: "packages.register", idempotencyKey: registrationMetadata.idempotencyKey },
      { action: "deployments.preview", idempotencyKey: previewMetadata.idempotencyKey },
      { action: "approvals.decide", idempotencyKey: approvalMetadata.idempotencyKey },
      { action: "deployments.publish", idempotencyKey: publishMetadata.idempotencyKey },
      { action: "deployments.reconcile", idempotencyKey: reconcileVerifiedMetadata.idempotencyKey },
    ] as const;
    const assertCompletedIdempotency = async (repository: ModuleControlRepository) => {
      for (const expected of expectedIdempotencies) {
        await expect(repository.getIdempotency({
          managementTenantId: tenant,
          action: expected.action,
          idempotencyKey: expected.idempotencyKey,
        })).resolves.toMatchObject({
          action: expected.action,
          idempotencyKey: expected.idempotencyKey,
          status: "completed",
        });
      }
    };
    await assertCompletedIdempotency(storeAfterSimpleCompletion);

    await storeAfterSimpleCompletion.close();
    const persistedIdempotency = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(
        persistedIdempotency
          .prepare(
            `SELECT action, status
             FROM module_control_idempotency
             ORDER BY action`,
          )
          .all(),
      ).toEqual([
        { action: "approvals.decide", status: "completed" },
        { action: "deployments.preview", status: "completed" },
        { action: "deployments.publish", status: "completed" },
        { action: "deployments.reconcile", status: "completed" },
        { action: "packages.register", status: "completed" },
      ]);
    } finally {
      persistedIdempotency.close();
    }
    const reopened = openStore(applicationRoot);
    await assertCompletedIdempotency(reopened);
    await reopened.close();
  });

  it("keeps domain event action/status CHECK fail-closed while allowing idempotency status values", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO module_control_events
              (sequence, management_tenant_id, event_id, actor_ref, action,
               idempotency_key, request_hash, object_ref, status,
               reason_codes_json, payload_json, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            1,
            tenant,
            "event_invalid_domain_status",
            actor,
            "packages.register",
            registrationMetadata.idempotencyKey,
            registrationMetadata.requestHash,
            registrationMetadata.event.objectRef,
            "completed",
            "[]",
            JSON.stringify({ detail: registrationMetadata.event.detail }),
            registrationRecord.registeredAt,
          ),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("requires the canonical registration final-result reference and all three envelope fields", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);

    await expect(
      store.registerModule({
        ...registerRequest(),
        finalResult: {
          ...registrationFinalResult,
          domainRecordRef: "registration:cargo:1.0.0",
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.registerModule({
        ...registerRequest(),
        finalResult: {
          ...registrationFinalResult,
          envelope: {
            ...registrationEnvelope,
            data: { kind: "registration" },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(store.getControlState()).resolves.toMatchObject({
      registrations: [],
      events: [],
    });
    await store.close();
  });

  it("round-trips preview, approval, release, and readback records with ordered redacted events", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });

    const { store, published } = await seedPendingStore(applicationRoot);
    expect(published.record).toEqual(pendingRelease);
    await expect(store.getPendingRelease()).resolves.toEqual(pendingRelease);
    await expect(store.getNewestUnresolvedRelease()).resolves.toEqual(pendingRelease);

    const beforeReadback = await store.getControlState();
    expect(beforeReadback.latestPreview).toEqual({
      ...changePreview,
      consumed: true,
    });
    expect(beforeReadback.latestApproval).toEqual({
      ...approval,
      consumed: true,
    });
    expect(beforeReadback.releaseHistory).toEqual([{
      release: pendingRelease,
      intent: "change",
      rollbackTargetReleaseId: null,
    }]);
    expect(beforeReadback.eventsTruncated).toBe(false);
    expect(beforeReadback.events.map((event) => [event.sequence, event.kind])).toEqual([
      [1, "registration"],
      [2, "preview"],
      [3, "approval"],
      [4, "release"],
    ]);

    const readback = await finalizeReadbackAttempt(
      store,
      verifiedReadbackRequest(),
      completedPublish.finalResult,
    );
    expect(readback.replayed).toBe(false);
    expect(readback.readback).toMatchObject(verifiedReadback);
    expect(readback.readback.attemptId).toBe(
      `attempt_${publishMetadata.idempotencyKey}`,
    );
    expect(readback.idempotency).toEqual(completedPublish);

    const afterReadback = await store.getControlState();
    expect(afterReadback.activeRevision).toBe(1);
    expect(afterReadback.activeModules).toEqual([moduleRef]);
    expect(afterReadback.activeRelease).toEqual({
      ...pendingRelease,
      status: "active_verified",
      readbackRef: verifiedReadback.readbackRef,
    });
    expect(afterReadback.latestReadback).toMatchObject(verifiedReadback);
    expect(afterReadback.latestReadback?.attemptId).toBe(
      `attempt_${publishMetadata.idempotencyKey}`,
    );
    expect(afterReadback.latestPreview?.consumed).toBe(true);
    expect(afterReadback.latestApproval?.consumed).toBe(true);
    expect(afterReadback.releaseHistory).toEqual([{
      release: {
        ...pendingRelease,
        status: "active_verified",
        readbackRef: verifiedReadback.readbackRef,
      },
      intent: "change",
      rollbackTargetReleaseId: null,
    }]);
    expect(afterReadback.eventsTruncated).toBe(false);
    expect(afterReadback.events.map((event) => [event.sequence, event.kind, event.status])).toEqual([
      [1, "registration", "registered"],
      [2, "preview", "previewed"],
      [3, "approval", "approved"],
      [4, "release", "published_pending_readback"],
      [5, "reconciliation", "verified"],
      [6, "idempotency", "completed"],
    ]);

    await expect(
      store.publishRelease({
        ...publishRequest(),
        metadata: {
          ...publishMetadata,
          idempotencyKey: "idem_publish_stale_cas_001",
          requestHash: requestHash.replace(/3/g, "9"),
        } as never,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await store.close();
    const database = new DatabaseSync(join(applicationRoot, ".runtime/mcp-instance-state/control.sqlite"));
    try {
      const eventRow = database
        .prepare("SELECT payload_json FROM module_control_events WHERE sequence = ?")
        .get(1) as { payload_json: string };
      expect(JSON.parse(eventRow.payload_json)).toEqual({
        detail: registrationMetadata.event.detail,
      });
      expect(eventRow.payload_json).not.toContain("token");
      expect(eventRow.payload_json).not.toContain("address");
    } finally {
      database.close();
    }

    const reopened = openStore(applicationRoot);
    await expect(reopened.getActiveRelease()).resolves.toEqual(afterReadback.activeRelease);
    await expect(reopened.getPendingRelease()).resolves.toBeNull();
    await expect(reopened.getNewestUnresolvedRelease()).resolves.toBeNull();
    await expect(reopened.getControlState()).resolves.toEqual(afterReadback);
    await expect(reopened.getIdempotency({
      managementTenantId: tenant,
      action: "deployments.publish",
      idempotencyKey: publishMetadata.idempotencyKey,
    })).resolves.toEqual(completedPublish);
    await reopened.close();
  });

  it("preserves an exact R1 to R2 activation chain and rolls back through a new R3", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = await seedTwoVerifiedReleases(applicationRoot);

    const targetReleaseBeforeRollback = await store.getRelease({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    });
    const targetReadbackBeforeRollback = await store.getReadback({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    });
    expect(targetReleaseBeforeRollback).toEqual({
      ...pendingRelease,
      status: "superseded",
      readbackRef: verifiedReadback.readbackRef,
      supersededByReleaseId: secondPendingRelease.releaseId,
    });
    await expect(store.getActiveRelease()).resolves.toEqual({
      ...secondPendingRelease,
      status: "active_verified",
      readbackRef: secondVerifiedReadback.readbackRef,
    });

    await store.createPreview({
      metadata: e2eRollbackPreviewMetadata,
      record: e2eRollbackPreview,
      finalResult: e2eRollbackPreviewFinalResult,
    });
    await store.decideApproval({
      metadata: e2eRollbackApprovalMetadata,
      record: e2eRollbackApproval,
      finalResult: e2eRollbackApprovalFinalResult,
    });
    await store.publishRelease({
      metadata: rollbackPublishMetadata,
      record: rollbackPendingRelease,
    });
    await finalizeReadbackAttempt(
      store,
      { metadata: rollbackReadbackMetadata, record: rollbackVerifiedReadback },
      completedRollbackPublish.finalResult,
    );

    await expect(store.getRelease({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toEqual(targetReleaseBeforeRollback);
    await expect(store.getReadback({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toEqual(targetReadbackBeforeRollback);
    await expect(store.getRelease({
      managementTenantId: tenant,
      releaseId: secondPendingRelease.releaseId,
    })).resolves.toEqual({
      ...secondPendingRelease,
      status: "superseded",
      readbackRef: secondVerifiedReadback.readbackRef,
      supersededByReleaseId: rollbackPendingRelease.releaseId,
    });
    await expect(store.getActiveRelease()).resolves.toEqual({
      ...rollbackPendingRelease,
      status: "active_verified",
      readbackRef: rollbackVerifiedReadback.readbackRef,
    });
    await expect(store.getPreview({
      managementTenantId: tenant,
      previewRef: e2eRollbackPreview.previewRef,
    })).resolves.toEqual({ ...e2eRollbackPreview, consumed: true });
    await expect(store.getApproval({
      managementTenantId: tenant,
      approvalId: e2eRollbackApproval.approvalId,
    })).resolves.toEqual({ ...e2eRollbackApproval, consumed: true });
    await expect(store.getReadback({
      managementTenantId: tenant,
      releaseId: rollbackPendingRelease.releaseId,
    })).resolves.toMatchObject(rollbackVerifiedReadback);

    for (const [idempotencyKey, releaseId, finalResult] of [
      [publishMetadata.idempotencyKey, pendingRelease.releaseId, completedPublish.finalResult],
      [secondPublishMetadata.idempotencyKey, secondPendingRelease.releaseId, completedSecondPublish.finalResult],
      [rollbackPublishMetadata.idempotencyKey, rollbackPendingRelease.releaseId, completedRollbackPublish.finalResult],
    ] as const) {
      await expect(store.getIdempotency({
        managementTenantId: tenant,
        action: "deployments.publish",
        idempotencyKey,
      })).resolves.toMatchObject({
        status: "completed",
        domainRecordRef: releaseId,
        finalResult,
      });
    }

    const state = await store.getControlState();
    expect(state.releaseHistory.map((entry) => ({
      releaseId: entry.release.releaseId,
      revision: entry.release.revision,
      intent: entry.intent,
      rollbackTargetReleaseId: entry.rollbackTargetReleaseId,
    }))).toEqual([
      {
        releaseId: rollbackPendingRelease.releaseId,
        revision: rollbackPendingRelease.revision,
        intent: "rollback",
        rollbackTargetReleaseId: e2eRollbackPreview.targetReleaseId,
      },
      {
        releaseId: secondPendingRelease.releaseId,
        revision: secondPendingRelease.revision,
        intent: "change",
        rollbackTargetReleaseId: null,
      },
      {
        releaseId: pendingRelease.releaseId,
        revision: pendingRelease.revision,
        intent: "change",
        rollbackTargetReleaseId: null,
      },
    ]);
    expect(state.eventsTruncated).toBe(false);
    expect(state.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    expect(state.events.filter((event) => event.kind === "release")).toHaveLength(3);
    expect(state.events.filter((event) => event.kind === "reconciliation")).toHaveLength(3);
    await store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_releases").get()).toEqual({ count: 3 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_readbacks").get()).toEqual({ count: 3 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM module_control_idempotency WHERE status = 'completed'")
          .get(),
      ).toEqual({ count: 10 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_control_events").get()).toEqual({ count: 16 });
    } finally {
      database.close();
    }

    const reopened = openStore(applicationRoot);
    await expect(reopened.health()).resolves.toEqual({ ready: true });
    await expect(reopened.getActiveRelease()).resolves.toMatchObject({
      releaseId: rollbackPendingRelease.releaseId,
      revision: rollbackPendingRelease.revision,
      desiredModules: pendingRelease.desiredModules,
    });
    await reopened.close();
  });

  it("orders latest previews by RFC3339 nanoseconds and stable reference on offset ties", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = await seedTwoVerifiedReleases(applicationRoot);
    const previewRequestAt = (
      previewRef: string,
      createdAt: string,
      hashCharacter: string,
    ): CreatePreviewRecordRequest => {
      const record = {
        ...secondChangePreview,
        previewRef,
        canonicalHash:
          `mcp-control-hash/v1/preview/sha256:${hashCharacter.repeat(64)}` as const,
        baseReleaseId: secondPendingRelease.releaseId,
        baseRevision: secondPendingRelease.revision,
        inventoryRefs: secondPendingRelease.desiredModules,
        desiredModules: secondPendingRelease.desiredModules,
        diff: {
          added: [],
          removed: [],
          retained: secondPendingRelease.desiredModules,
        },
        createdAt,
        expiresAt: "2099-08-23T00:10:00Z",
        consumed: false,
      } as const satisfies ModuleChangePreviewRecord;
      const metadata = {
        ...previewMetadata,
        idempotencyKey: `idem_${previewRef}`,
        requestHash:
          `mcp-control-hash/v1/request/sha256:${hashCharacter.repeat(64)}` as const,
        event: {
          ...previewMetadata.event,
          objectRef: previewRef,
          detail: {
            ...previewMetadata.event.detail,
            previewRef,
            baseRevision: record.baseRevision,
          },
        },
      } as const satisfies CreatePreviewRequestMetadata;
      return {
        metadata,
        record,
        finalResult: {
          ...secondPreviewFinalResult,
          domainRecordRef: previewRef,
          envelope: {
            ...secondPreviewFinalResult.envelope,
            data: {
              ...secondPreviewFinalResult.envelope.data,
              preview_ref: previewRef,
              base_release_id: record.baseReleaseId,
              base_revision: record.baseRevision,
              desired_modules: record.desiredModules.map((ref) => ({
                module_id: ref.moduleId,
                version: ref.version,
                descriptor_digest: ref.descriptorDigest,
              })),
              expires_at: record.expiresAt,
            },
          },
        },
      };
    };

    await store.createPreview(previewRequestAt(
      "preview_z_nanosecond_earlier",
      "2099-08-22T00:09:00.000000001Z",
      "a",
    ));
    await store.createPreview(previewRequestAt(
      "preview_a_nanosecond_later",
      "2099-08-22T00:09:00.000000002Z",
      "b",
    ));
    expect((await store.getControlState()).latestPreview?.previewRef).toBe(
      "preview_a_nanosecond_later",
    );

    await store.createPreview(previewRequestAt(
      "preview_a_offset_tie",
      "2099-08-22T00:10:00Z",
      "c",
    ));
    await store.createPreview(previewRequestAt(
      "preview_z_offset_tie",
      "2099-08-22T02:40:00+02:30",
      "d",
    ));
    const state = await store.getControlState();
    expect(state.latestPreview?.previewRef).toBe("preview_z_offset_tie");
    expect(state.latestApproval?.approvalId).toBe(secondApproval.approvalId);
    expect(state.latestReadback?.releaseId).toBe(secondPendingRelease.releaseId);
    await store.close();

    const reopened = openStore(applicationRoot);
    await expect(reopened.health()).resolves.toEqual({ ready: true });
    await expect(reopened.getControlState()).resolves.toMatchObject({
      latestPreview: { previewRef: "preview_z_offset_tie" },
      latestApproval: { approvalId: secondApproval.approvalId },
      latestReadback: { releaseId: secondPendingRelease.releaseId },
    });
    await reopened.close();
  });

  it("supports exact narrow queries for rollback targets and persisted replay results", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
  });
    const store = await seedTwoVerifiedReleases(applicationRoot);
    await store.createPreview({
      metadata: rollbackPreviewMetadata,
      record: rollbackPreview,
      finalResult: rollbackPreviewFinalResult,
    });

    const queriedPreview = await store.getPreview({
      managementTenantId: tenant,
      previewRef: rollbackPreview.previewRef,
    });
    expect(queriedPreview).toEqual(rollbackPreview);
    expect(queriedPreview?.intent).toBe("rollback");
    expect(queriedPreview?.targetReleaseId).toBe(rollbackPreview.targetReleaseId);
    expect(Object.isFrozen(queriedPreview)).toBe(true);
    expect(Object.isFrozen(queriedPreview?.inventoryRefs)).toBe(true);

    await expect(
      store.getApproval({
        managementTenantId: tenant,
        approvalId: approval.approvalId,
      }),
    ).resolves.toEqual({ ...approval, consumed: true });
    await expect(
      store.getRelease({
        managementTenantId: tenant,
        releaseId: pendingRelease.releaseId,
      }),
    ).resolves.toEqual({
      ...pendingRelease,
      status: "superseded",
      readbackRef: verifiedReadback.readbackRef,
      supersededByReleaseId: secondPendingRelease.releaseId,
    });
    await expect(
      store.getReadback({
        managementTenantId: tenant,
        releaseId: pendingRelease.releaseId,
      }),
    ).resolves.toMatchObject(verifiedReadback);

    const queriedIdempotency = await store.getIdempotency({
      managementTenantId: tenant,
      action: "deployments.publish",
      idempotencyKey: publishMetadata.idempotencyKey,
    });
    expect(queriedIdempotency?.status).toBe("completed");
    expect(queriedIdempotency?.domainRecordRef).toBe(pendingRelease.releaseId);
    expect(queriedIdempotency?.finalResult).toEqual(completedPublish.finalResult);
    expect(Object.isFrozen(queriedIdempotency)).toBe(true);
    expect(Object.isFrozen(queriedIdempotency?.finalResult)).toBe(true);

    await expect(
      store.getPreview({ managementTenantId: tenant, previewRef: "preview_missing" }),
    ).resolves.toBeNull();
    await expect(
      store.getApproval({ managementTenantId: tenant, approvalId: "approval_missing" }),
    ).resolves.toBeNull();
    await expect(
      store.getRelease({ managementTenantId: tenant, releaseId: "release_missing" }),
    ).resolves.toBeNull();
    await expect(
      store.getReadback({ managementTenantId: tenant, releaseId: "release_missing" }),
    ).resolves.toBeNull();
    await expect(
      store.getIdempotency({
        managementTenantId: tenant,
        action: "deployments.publish",
        idempotencyKey: "idem_missing",
      }),
    ).resolves.toBeNull();

    await expect(
      store.getPreview({
        managementTenantId: "tenant_other",
        previewRef: rollbackPreview.previewRef,
      }),
    ).rejects.toMatchObject({ code: "tenant_mismatch" });
    await expect(
      store.getApproval({
        managementTenantId: "tenant_other",
        approvalId: approval.approvalId,
      }),
    ).rejects.toMatchObject({ code: "tenant_mismatch" });
    await expect(
      store.getRelease({
        managementTenantId: "tenant_other",
        releaseId: pendingRelease.releaseId,
      }),
    ).rejects.toMatchObject({ code: "tenant_mismatch" });
    await expect(
      store.getReadback({
        managementTenantId: "tenant_other",
        releaseId: pendingRelease.releaseId,
      }),
    ).rejects.toMatchObject({ code: "tenant_mismatch" });
    await expect(
      store.getIdempotency({
        managementTenantId: "tenant_other",
        action: "deployments.publish",
        idempotencyKey: publishMetadata.idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "tenant_mismatch" });

    await store.close();
    const reopened = openStore(applicationRoot);
    await expect(
      reopened.getPreview({
        managementTenantId: tenant,
        previewRef: rollbackPreview.previewRef,
      }),
    ).resolves.toEqual(rollbackPreview);
    await expect(
      reopened.getIdempotency({
        managementTenantId: tenant,
        action: "deployments.publish",
        idempotencyKey: publishMetadata.idempotencyKey,
      }),
    ).resolves.toEqual(queriedIdempotency);
    await reopened.close();
  });

  it("fails closed when publish readback has no existing publish domain-committed idempotency row", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);
    await store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      database
        .prepare(
          `DELETE FROM module_control_idempotency
           WHERE management_tenant_id = ? AND action = ? AND idempotency_key = ?`,
        )
        .run(tenant, "deployments.publish", publishMetadata.idempotencyKey);
    } finally {
      database.close();
    }

    const reopened = openStore(applicationRoot);
    await expect(reopened.health()).resolves.toEqual({ ready: false });
    await expect(reopened.getReadback({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).rejects.toMatchObject({
      code: "invalid_state",
    });
    await expect(reopened.claimReadbackAttempt({
      metadata: {
        managementTenantId: tenant,
        actorRef: publisher,
        action: "deployments.publish",
        idempotencyKey: publishMetadata.idempotencyKey,
        requestHash: publishRequestHash,
        requestId: publishEnvelope.request_id,
        traceId: publishEnvelope.trace_id,
        auditId: publishEnvelope.audit_id,
      },
      attemptId: "attempt_missing_publish_idempotency_001",
      readbackRef: verifiedReadback.readbackRef,
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      desiredModules: pendingRelease.desiredModules,
      ownerBootId: "boot_test_fixture",
      claimedAt: pendingRelease.createdAt,
    })).rejects.toMatchObject({ code: "invalid_state" });
    await reopened.close();

    const persisted = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(
        persisted
          .prepare("SELECT status, readback_ref FROM module_releases WHERE release_id = ?")
          .get(pendingRelease.releaseId),
      ).toEqual({ status: "published_pending_readback", readback_ref: null });
      expect(persisted.prepare("SELECT COUNT(*) AS count FROM module_readbacks").get()).toEqual({
        count: 0,
      });
      expect(persisted.prepare("SELECT COUNT(*) AS count FROM module_readback_attempts").get()).toEqual({
        count: 0,
      });
    } finally {
      persisted.close();
    }
  });

  it("persists and reopens an unfinished readback attempt without a pending current row", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    let store = (await seedPendingStore(applicationRoot)).store;
    const claim = await store.claimReadbackAttempt({
      metadata: {
        managementTenantId: tenant,
        actorRef: publisher,
        action: "deployments.publish",
        idempotencyKey: publishMetadata.idempotencyKey,
        requestHash: publishRequestHash,
        requestId: publishEnvelope.request_id,
        traceId: publishEnvelope.trace_id,
        auditId: publishEnvelope.audit_id,
      },
      attemptId: "attempt_idem_publish_001",
      readbackRef: pendingReadback.readbackRef,
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      desiredModules: pendingRelease.desiredModules,
      ownerBootId: "boot_test_fixture",
      claimedAt: pendingRelease.createdAt,
    });
    expect(claim.disposition).toBe("created");
    if (claim.disposition !== "created") throw new Error("claim did not create an attempt");
    await expect(store.getUnfinishedReadbackAttempt({
      managementTenantId: tenant,
      attemptId: claim.attempt.attemptId,
    })).resolves.toEqual(claim.attempt);
    await expect(store.getReadback({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toBeNull();
    await expect(store.listUnfinishedReadbackAttempts()).resolves.toEqual([claim.attempt]);
    await expect(store.health()).resolves.toEqual({ ready: true });
    await store.close();

    store = openStore(applicationRoot);
    await expect(store.health()).resolves.toEqual({ ready: true });
    await expect(store.getRelease({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toMatchObject({
      status: "published_pending_readback",
      readbackRef: null,
    });
    await expect(store.getReadback({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toBeNull();
    await expect(store.getUnfinishedReadbackAttempt({
      managementTenantId: tenant,
      attemptId: claim.attempt.attemptId,
    })).resolves.toEqual(claim.attempt);
    await store.close();
  });

  it("never promotes manual review with a different observation under the same reconcile key", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);
    const reconcileMismatchFinalResult = {
      domainRecordRef: pendingRelease.releaseId,
      envelope: {
        ...reconcileSuccessEnvelope,
        status: "manual_review",
        data: { ...reconcileSuccessEnvelope.data, status: "mismatch" },
        reason_codes: [...mismatchReadback.reasonCodes],
        readback: {
          status: "mismatch",
          release_id: pendingRelease.releaseId,
          revision: pendingRelease.revision,
        },
      },
    } as const satisfies ControlFinalResult;
    await finalizeReadbackAttempt(
      store,
      { metadata: reconcileMismatchMetadata, record: mismatchReadback },
      reconcileMismatchFinalResult,
    );
    const manualState = await store.getControlState();

    await expect(store.claimReadbackAttempt({
      metadata: {
        managementTenantId: tenant,
        actorRef: publisher,
        action: "deployments.reconcile",
        idempotencyKey: reconcileVerifiedMetadata.idempotencyKey,
        requestHash: reconcileRequestHash,
        requestId: reconcileSuccessEnvelope.request_id,
        traceId: reconcileSuccessEnvelope.trace_id,
        auditId: reconcileSuccessEnvelope.audit_id,
      },
      attemptId: "attempt_idem_reconcile_001",
      readbackRef: verifiedReadback.readbackRef,
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      desiredModules: pendingRelease.desiredModules,
      ownerBootId: "boot_test_fixture",
      claimedAt: pendingRelease.createdAt,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(store.getControlState()).resolves.toEqual(manualState);
    await expect(store.getReadback({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toMatchObject(mismatchReadback);

    await finalizeReadbackAttempt(
      store,
      { metadata: reconcileVerifiedRetryMetadata, record: verifiedReadback },
      completedReconcile.finalResult,
    );
    await expect(store.getActiveRelease()).resolves.toMatchObject({
      releaseId: pendingRelease.releaseId,
      status: "active_verified",
    });
    await store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_readbacks").get()).toEqual({ count: 1 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM module_control_idempotency WHERE action = 'deployments.reconcile'")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("keeps a claimed publish attempt durable across reopen without exposing recovery authority", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    let store = openStore(applicationRoot);
    await store.registerModule(registerRequest());
    await store.createPreview(previewRequest());
    await store.decideApproval(approvalRequest());
    await store.publishRelease(publishRequest());
    const claim = await claimReadbackAttemptFixture(
      store,
      verifiedReadbackRequest(),
      completedPublish.finalResult,
    );
    await store.close();
    const beforeReopenRows = persistedRowCounts(applicationRoot);

    store = openStore(applicationRoot);
    expect("recoveryDriver" in store).toBe(false);
    await expect(store.getUnfinishedReadbackAttempt({
      managementTenantId: tenant,
      attemptId: claim.attempt.attemptId,
    })).resolves.toEqual(claim.attempt);
    await expect(store.getReadback({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toBeNull();
    await expect(store.getRelease({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toMatchObject({
      status: "published_pending_readback",
      readbackRef: null,
    });
    await expect(store.getIdempotency({
      managementTenantId: tenant,
      action: "deployments.publish",
      idempotencyKey: publishMetadata.idempotencyKey,
    })).resolves.toMatchObject({
      status: "domain_committed",
      domainRecordRef: pendingRelease.releaseId,
      finalResult: null,
    });
    await expect(store.publishRelease(publishRequest())).resolves.toMatchObject({
      replayed: true,
      record: { status: "published_pending_readback" },
    });
    await expect(store.claimReadbackAttempt({
      metadata: {
        managementTenantId: tenant,
        actorRef: publisher,
        action: "deployments.publish",
        idempotencyKey: publishMetadata.idempotencyKey,
        requestHash: publishMetadata.requestHash,
        requestId: publishEnvelope.request_id,
        traceId: publishEnvelope.trace_id,
        auditId: publishEnvelope.audit_id,
      },
      attemptId: claim.attempt.attemptId,
      readbackRef: claim.attempt.readbackRef,
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      desiredModules: pendingRelease.desiredModules,
      ownerBootId: "caller_supplied_boot_id",
      claimedAt: claim.attempt.claimedAt,
    })).resolves.toEqual({ disposition: "existing", attempt: claim.attempt });
    await expect(store.finalizeReadbackAndComplete({
      attemptId: claim.attempt.attemptId,
      ownerCapability: Object.freeze({}) as never,
      observation: {
        status: verifiedReadback.status,
        appliedReleaseId: verifiedReadback.appliedReleaseId,
        appliedRevision: verifiedReadback.appliedRevision,
        appliedModules: verifiedReadback.appliedModules,
        reasonCodes: verifiedReadback.reasonCodes,
        checkedAt: verifiedReadback.checkedAt,
      },
      finalResult: completedPublish.finalResult,
      finalizedAt: verifiedReadback.checkedAt,
    })).rejects.toMatchObject({ code: "conflict" });
    await store.close();
    expect(persistedRowCounts(applicationRoot)).toEqual(beforeReopenRows);
  });

  it("blocks a later revision while the active publish attempt is unfinished", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);
    try {
      const claim = await claimReadbackAttemptFixture(
        store,
        verifiedReadbackRequest(),
        completedPublish.finalResult,
      );
      const beforeBlockedPublish = await store.getControlState();
      await expect(store.publishRelease({
        metadata: secondPublishMetadata,
        record: secondPendingRelease,
      })).rejects.toMatchObject({ code: "conflict" });
      await expect(store.getControlState()).resolves.toEqual(beforeBlockedPublish);
      await expect(store.getRelease({
        managementTenantId: tenant,
        releaseId: secondPendingRelease.releaseId,
      })).resolves.toBeNull();
      await expect(store.getIdempotency({
        managementTenantId: tenant,
        action: secondPublishMetadata.action,
        idempotencyKey: secondPublishMetadata.idempotencyKey,
      })).resolves.toBeNull();
      await expect(store.getPreview({
        managementTenantId: tenant,
        previewRef: secondChangePreview.previewRef,
      })).resolves.toBeNull();
      await expect(store.getApproval({
        managementTenantId: tenant,
        approvalId: secondApproval.approvalId,
      })).resolves.toBeNull();

      await expect(store.publishRelease(publishRequest())).resolves.toMatchObject({
        replayed: true,
        record: { releaseId: pendingRelease.releaseId, status: "published_pending_readback" },
      });
      await expect(store.getUnfinishedReadbackAttempt({
        managementTenantId: tenant,
        attemptId: claim.attempt.attemptId,
      })).resolves.toEqual(claim.attempt);
      await expect(store.getControlState()).resolves.toEqual(beforeBlockedPublish);

      await store.finalizeReadbackAndComplete({
        attemptId: claim.attempt.attemptId,
        ownerCapability: claim.ownerCapability,
        observation: {
          status: verifiedReadback.status,
          appliedReleaseId: verifiedReadback.appliedReleaseId,
          appliedRevision: verifiedReadback.appliedRevision,
          appliedModules: verifiedReadback.appliedModules,
          reasonCodes: verifiedReadback.reasonCodes,
          checkedAt: verifiedReadback.checkedAt,
        },
        finalResult: completedPublish.finalResult,
        finalizedAt: verifiedReadback.checkedAt,
      });
      await store.createPreview({
        metadata: secondPreviewMetadata,
        record: secondChangePreview,
        finalResult: secondPreviewFinalResult,
      });
      await store.decideApproval({
        metadata: secondApprovalMetadata,
        record: secondApproval,
        finalResult: secondApprovalFinalResult,
      });
      await expect(store.publishRelease({
        metadata: secondPublishMetadata,
        record: secondPendingRelease,
      })).resolves.toMatchObject({
        replayed: false,
        record: { releaseId: secondPendingRelease.releaseId },
      });
    } finally {
      await store.close();
    }
  });

  it("rejects a completed publish result until persisted readback state proves the final envelope", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);

    await expect(
      store.getIdempotency({
        managementTenantId: tenant,
        action: "deployments.publish",
        idempotencyKey: publishMetadata.idempotencyKey,
      }),
    ).resolves.toMatchObject({ status: "domain_committed", finalResult: null });
    await expect(
      store.getRelease({
        managementTenantId: tenant,
        releaseId: pendingRelease.releaseId,
      }),
    ).resolves.toMatchObject({ status: "published_pending_readback", readbackRef: null });
    await expect(
      store.getReadback({
        managementTenantId: tenant,
        releaseId: pendingRelease.releaseId,
      }),
    ).resolves.toBeNull();

    const mismatchRequest = {
      metadata: mismatchReadbackMetadata,
      record: mismatchReadback,
    } satisfies ReadbackFixtureRequest;
    const claim = await claimReadbackAttemptFixture(
      store,
      mismatchRequest,
      manualPublishFinalResult,
    );
    const beforeInconsistentManualResult = await store.getControlState();
    const inconsistentManualResult = {
      ...manualPublishFinalResult,
      envelope: {
        ...manualPublishFinalResult.envelope,
        reason_codes: ["readback.unknown"],
      },
    } as const satisfies ControlFinalResult;
    await expect(
      store.finalizeReadbackAndComplete({
        attemptId: claim.attempt.attemptId,
        ownerCapability: claim.ownerCapability,
        observation: {
          status: mismatchReadback.status,
          appliedReleaseId: mismatchReadback.appliedReleaseId,
          appliedRevision: mismatchReadback.appliedRevision,
          appliedModules: mismatchReadback.appliedModules,
          reasonCodes: mismatchReadback.reasonCodes,
          checkedAt: mismatchReadback.checkedAt,
        },
        finalResult: inconsistentManualResult,
        finalizedAt: mismatchReadback.checkedAt,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.getControlState()).resolves.toEqual(beforeInconsistentManualResult);
    await expect(
      store.getIdempotency({
        managementTenantId: tenant,
        action: "deployments.publish",
        idempotencyKey: publishMetadata.idempotencyKey,
      }),
    ).resolves.toMatchObject({ status: "domain_committed", finalResult: null });
    await expect(store.finalizeReadbackAndComplete({
      attemptId: claim.attempt.attemptId,
      ownerCapability: claim.ownerCapability,
      observation: {
        status: mismatchReadback.status,
        appliedReleaseId: mismatchReadback.appliedReleaseId,
        appliedRevision: mismatchReadback.appliedRevision,
        appliedModules: mismatchReadback.appliedModules,
        reasonCodes: mismatchReadback.reasonCodes,
        checkedAt: mismatchReadback.checkedAt,
      },
      finalResult: manualPublishFinalResult,
      finalizedAt: mismatchReadback.checkedAt,
    })).resolves.toMatchObject({
      disposition: "finalized",
      readback: mismatchReadback,
      idempotency: { status: "completed", finalResult: manualPublishFinalResult },
    });
    await store.close();
  });

  it("rejects a verified completion whose persisted module evidence differs from the final envelope", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);
    const inconsistentModules = {
      ...completedPublish,
      finalResult: {
        ...completedPublish.finalResult,
        envelope: {
          ...publishEnvelope,
          data: {
            ...publishEnvelope.data,
            active_modules: [
              {
                module_id: secondModuleRef.moduleId,
                version: secondModuleRef.version,
                descriptor_digest: secondModuleRef.descriptorDigest,
              },
            ],
          },
        },
      },
    } as const satisfies CompletedModuleControlIdempotencyRecord;
    const claim = await claimReadbackAttemptFixture(
      store,
      verifiedReadbackRequest(),
      completedPublish.finalResult,
    );
    const before = await store.getControlState();

    await expect(
      store.finalizeReadbackAndComplete({
        attemptId: claim.attempt.attemptId,
        ownerCapability: claim.ownerCapability,
        observation: {
          status: verifiedReadback.status,
          appliedReleaseId: verifiedReadback.appliedReleaseId,
          appliedRevision: verifiedReadback.appliedRevision,
          appliedModules: verifiedReadback.appliedModules,
          reasonCodes: verifiedReadback.reasonCodes,
          checkedAt: verifiedReadback.checkedAt,
        },
        finalResult: inconsistentModules.finalResult,
        finalizedAt: verifiedReadback.checkedAt,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.getControlState()).resolves.toEqual(before);
    await expect(
      store.getIdempotency({
        managementTenantId: tenant,
        action: "deployments.publish",
        idempotencyKey: publishMetadata.idempotencyKey,
      }),
    ).resolves.toMatchObject({ status: "domain_committed", finalResult: null });
    await expect(store.finalizeReadbackAndComplete({
      attemptId: claim.attempt.attemptId,
      ownerCapability: claim.ownerCapability,
      observation: {
        status: verifiedReadback.status,
        appliedReleaseId: verifiedReadback.appliedReleaseId,
        appliedRevision: verifiedReadback.appliedRevision,
        appliedModules: verifiedReadback.appliedModules,
        reasonCodes: verifiedReadback.reasonCodes,
        checkedAt: verifiedReadback.checkedAt,
      },
      finalResult: completedPublish.finalResult,
      finalizedAt: verifiedReadback.checkedAt,
    })).resolves.toMatchObject({ disposition: "finalized" });
    await store.close();
  });

  it("preserves persisted idempotency timestamps through attempt finalization", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);

    await expect(store.getIdempotency({
      managementTenantId: tenant,
      action: "deployments.publish",
      idempotencyKey: publishMetadata.idempotencyKey,
    })).resolves.toMatchObject({
      status: "domain_committed",
      createdAt: pendingRelease.createdAt,
      expiresAt: "2099-08-23T00:03:00Z",
      finalResult: null,
    });
    const finalized = await finalizeReadbackAttempt(
      store,
      verifiedReadbackRequest(),
      completedPublish.finalResult,
    );
    expect(finalized.idempotency).toMatchObject({
      status: "completed",
      createdAt: pendingRelease.createdAt,
      expiresAt: "2099-08-23T00:03:00Z",
      finalResult: completedPublish.finalResult,
    });
    await store.close();
  });

  it("compares desired modules as a duplicate-free set across preview, publish, and readback", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await store.registerModule(registerRequest());
    await store.createPreview(setPreviewRequest());
    await store.decideApproval(setApprovalRequest());

    await expect(store.publishRelease({
      ...setPublishRequest(),
      record: {
        ...setPendingRelease,
        desiredModules: [...setPendingRelease.desiredModules, secondModuleRef],
      },
    })).rejects.toMatchObject({ code: "invalid_state" });

    await expect(store.publishRelease({
      ...setPublishRequest(),
      metadata: {
        ...setPublishMetadata,
        idempotencyKey: "idem_publish_set_different",
        requestHash: `mcp-control-hash/v1/request/sha256:${"e".repeat(64)}`,
      },
      record: {
        ...setPendingRelease,
        releaseId: "release_set_different",
        desiredModules: [moduleRef],
      },
    })).rejects.toMatchObject({ code: "conflict" });

    await expect(store.publishRelease(setPublishRequest())).resolves.toMatchObject({
      record: setPendingRelease,
      replayed: false,
    });
    const setPublishFinalResult = {
      domainRecordRef: setPendingRelease.releaseId,
      envelope: {
        ...publishEnvelope,
        request_id: "request_publish_set_001",
        trace_id: "trace_publish_set_001",
        audit_id: "audit_publish_set_001",
        data: {
          ...publishEnvelope.data,
          release_id: setPendingRelease.releaseId,
          active_modules: [
            {
              module_id: secondModuleRef.moduleId,
              version: secondModuleRef.version,
              descriptor_digest: secondModuleRef.descriptorDigest,
            },
            {
              module_id: moduleRef.moduleId,
              version: moduleRef.version,
              descriptor_digest: moduleRef.descriptorDigest,
            },
          ],
        },
        readback: {
          status: "verified",
          release_id: setPendingRelease.releaseId,
          revision: setPendingRelease.revision,
        },
      },
    } as const satisfies ControlFinalResult;
    await expect(finalizeReadbackAttempt(
      store,
      setVerifiedReadbackRequest(),
      setPublishFinalResult,
    )).resolves.toMatchObject({
      disposition: "finalized",
      readback: setVerifiedReadback,
    });
    await expect(store.getActiveRelease()).resolves.toMatchObject({
      releaseId: setPendingRelease.releaseId,
      status: "active_verified",
    });
    await store.close();
  });

  it("syncs a newly created runtime parent and preserves the durable initialization order", async () => {
    const source = readFileSync(
      join(process.cwd(), "src/logistics_mcp/control-plane/sqlite-control-store.ts"),
      "utf8",
    );
    expect(source).toContain("fsyncDirectory(applicationRoot)");

    const runtimeCreation = source.indexOf("mkdirSync(runtimeDir");
    const runtimeParentSync = source.indexOf("fsyncDirectory(applicationRoot)", runtimeCreation);
    const initializerLock = source.indexOf("acquireInitializerLock(paths.runtimeDir, runtimeEntry)");
    expect(runtimeCreation).toBeGreaterThanOrEqual(0);
    expect(runtimeParentSync).toBeGreaterThan(runtimeCreation);
    expect(runtimeParentSync).toBeLessThan(initializerLock);

    const durableOrder = [
      source.indexOf("initializeDatabase(\n        stagingDbPath"),
      source.indexOf("markerHandle = writeExclusiveFile(\n        stagingMarkerPath"),
      source.indexOf("fsyncVerifiedHandle(stagingHandle, stagingDir"),
      source.indexOf("renameSync(stagingDir"),
      source.indexOf("fsyncVerifiedHandle(runtimeHandle, paths.runtimeDir"),
    ];
    expect(durableOrder.every((index) => index >= 0)).toBe(true);
    expect(durableOrder).toEqual([...durableOrder].sort((left, right) => left - right));

    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await expect(store.health()).resolves.toEqual({ ready: true });
    await store.close();
  });

  it(
    "returns a fixed recent event window without deleting persisted history",
    async () => {
      const applicationRoot = makeApplicationRoot();
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: tenant,
      });
      const store = openStore(applicationRoot);
      await store.close();

      const eventCount = 6_000;
      const database = new DatabaseSync(controlDatabasePath(applicationRoot));
      try {
        insertSyntheticPreviewEventHistory(database, eventCount, "window");
        expect(database.prepare("SELECT COUNT(*) AS count FROM module_control_events").get()).toEqual({
          count: eventCount,
        });
      } finally {
        database.close();
      }

      const reopened = openStore(applicationRoot);
      const state = await reopened.getControlState();
      const eventWindow = 256;
      expect(state.events).toHaveLength(eventWindow);
      expect(state.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: eventWindow }, (_, index) => eventCount - eventWindow + 1 + index),
      );
      expect(state.events.every((event, index) =>
        index === 0 || event.sequence > state.events[index - 1]!.sequence,
      )).toBe(true);
      await reopened.close();

      const persistedDatabase = new DatabaseSync(controlDatabasePath(applicationRoot));
      try {
        expect(
          persistedDatabase.prepare("SELECT COUNT(*) AS count FROM module_control_events").get(),
        ).toEqual({ count: eventCount });
      } finally {
        persistedDatabase.close();
      }
    },
    15_000,
  );

  it.each([256, 257])(
    "reports eventsTruncated from the authoritative latest-257 query at %s events",
    async (eventCount) => {
      const applicationRoot = makeApplicationRoot();
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: tenant,
      });
      const initialized = openStore(applicationRoot);
      await initialized.close();

      const database = new DatabaseSync(controlDatabasePath(applicationRoot));
      try {
        insertSyntheticPreviewEventHistory(database, eventCount, `exact_${eventCount}`);
      } finally {
        database.close();
      }

      const reopened = openStore(applicationRoot);
      const state = await reopened.getControlState();
      expect(state.events).toHaveLength(256);
      expect(state.eventsTruncated).toBe(eventCount > 256);
      expect(state.events.map((event) => event.sequence)).toEqual(
        Array.from(
          { length: 256 },
          (_, index) => eventCount - 255 + index,
        ),
      );
      await reopened.close();
    },
  );

  it("rejects tenant mismatch and same-key hash conflict without leaking database values", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await store.registerModule(registerRequest());

    await expect(
      store.registerModule({
        ...registerRequest(),
        metadata: { ...registrationMetadata, requestHash: requestHash.replace(/3/g, "9") } as never,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      store.registerModule({
        ...registerRequest(),
        metadata: {
          ...registrationMetadata,
          managementTenantId: "tenant_other",
        },
      }),
    ).rejects.toMatchObject({ code: "tenant_mismatch" });

    try {
      await store.registerModule({
        ...registerRequest(),
        metadata: { ...registrationMetadata, requestHash: requestHash.replace(/3/g, "9") } as never,
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain("tenant_other");
      expect(String((error as Error).message)).not.toContain("requestHash");
      expect(String((error as Error).message)).not.toContain("3".repeat(64));
    }
    await store.close();
  });

  it("enforces approval preview bindings while leaving self-approval policy to the service", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await store.registerModule(registerRequest());
    await store.createPreview(previewRequest());

    const invalidApproval = {
      ...approval,
      approvalId: "approval_invalid_binding",
      previewCanonicalHash: `mcp-control-hash/v1/preview/sha256:${"9".repeat(64)}`,
    } as const;
    const invalidApprovalMetadata = {
      ...approvalMetadata,
      idempotencyKey: "idem_approval_invalid_binding",
      event: {
        ...approvalMetadata.event,
        objectRef: invalidApproval.approvalId,
        detail: {
          ...approvalMetadata.event.detail,
          approvalId: invalidApproval.approvalId,
        },
      },
    } as const;
    const invalidApprovalFinalResult = {
      ...approvalFinalResult,
      domainRecordRef: invalidApproval.approvalId,
      envelope: {
        ...approvalEnvelope,
        data: {
          ...approvalEnvelope.data,
          approval_id: invalidApproval.approvalId,
        },
      },
    } as const;
    await expect(
      store.decideApproval({
        metadata: invalidApprovalMetadata,
        record: invalidApproval,
        finalResult: invalidApprovalFinalResult,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const selfApproval = {
      ...approval,
      approvalId: "approval_self_001",
      approverActorRef: actor,
    } as const;
    const selfApprovalMetadata = {
      ...approvalMetadata,
      actorRef: actor,
      idempotencyKey: "idem_approval_self_001",
      event: {
        ...approvalMetadata.event,
        objectRef: selfApproval.approvalId,
        detail: {
          ...approvalMetadata.event.detail,
          approvalId: selfApproval.approvalId,
        },
      },
    } as const;
    const selfApprovalFinalResult = {
      ...approvalFinalResult,
      domainRecordRef: selfApproval.approvalId,
      envelope: {
        ...approvalEnvelope,
        data: {
          ...approvalEnvelope.data,
          approval_id: selfApproval.approvalId,
        },
      },
    } as const;
    await expect(
      store.decideApproval({
        metadata: selfApprovalMetadata,
        record: selfApproval,
        finalResult: selfApprovalFinalResult,
      }),
    ).resolves.toMatchObject({ record: selfApproval, replayed: false });
    await store.close();
  });

  it("rolls back an idempotency reservation when the domain write fails", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await store.registerModule(registerRequest());
    await store.createPreview(previewRequest());
    const before = await store.getControlState();

    await expect(
      store.createPreview({
        ...previewRequest(),
        metadata: {
          ...previewMetadata,
          idempotencyKey: "idem_preview_rollback_001",
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const after = await store.getControlState();
    expect(after.registrations).toEqual(before.registrations);
    expect(after.events).toEqual(before.events);
    await store.close();
    const database = new DatabaseSync(join(applicationRoot, ".runtime/mcp-instance-state/control.sqlite"));
    try {
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM module_control_idempotency")
          .get(),
      ).toEqual({ count: 2 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM module_previews").get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
    await store.close();
  });

  it("checks publish replay before the unresolved gate and never creates a second release", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);

    const replay = await store.publishRelease(publishRequest());
    expect(replay.replayed).toBe(true);
    expect(replay.record.releaseId).toBe(pendingRelease.releaseId);

    await expect(
      store.publishRelease({
        ...publishRequest(),
        metadata: {
          ...publishMetadata,
          idempotencyKey: "idem_publish_new_key_001",
          requestHash: requestHash.replace(/3/g, "9"),
        } as never,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await store.close();
    const database = new DatabaseSync(join(applicationRoot, ".runtime/mcp-instance-state/control.sqlite"));
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_releases").get()).toEqual({
        count: 1,
      });
      expect(database.prepare("SELECT consumed FROM module_previews").get()).toEqual({
        consumed: 1,
      });
      expect(database.prepare("SELECT consumed FROM module_approvals").get()).toEqual({
        consumed: 1,
      });
    } finally {
      database.close();
    }
    await store.close();
  });

  it("records mismatch as manual review, then reconciles the same release without a second readback row", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);

    const mismatch = await finalizeReadbackAttempt(
      store,
      { metadata: mismatchReadbackMetadata, record: mismatchReadback },
      manualPublishFinalResult,
    );
    expect(mismatch.replayed).toBe(false);
    expect(mismatch.readback).toMatchObject(mismatchReadback);
    await expect(store.getNewestUnresolvedRelease()).resolves.toMatchObject({
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      status: "manual_review",
    });

    await expect(store.publishRelease(publishRequest())).resolves.toMatchObject({
      replayed: true,
      record: { releaseId: pendingRelease.releaseId, status: "manual_review" },
    });

    const reconciled = await finalizeReadbackAttempt(
      store,
      { metadata: reconcileVerifiedMetadata, record: verifiedReadback },
      completedReconcile.finalResult,
    );
    expect(reconciled.readback).toMatchObject(verifiedReadback);
    await expect(store.getActiveRelease()).resolves.toMatchObject({
      releaseId: pendingRelease.releaseId,
      revision: pendingRelease.revision,
      status: "active_verified",
      readbackRef: verifiedReadback.readbackRef,
    });
    await expect(
      store.getIdempotency({
        managementTenantId: tenant,
        action: "deployments.reconcile",
        idempotencyKey: reconcileVerifiedMetadata.idempotencyKey,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      finalResult: completedReconcile.finalResult,
    });
    await expect(store.getNewestUnresolvedRelease()).resolves.toBeNull();

    await store.close();
    const database = new DatabaseSync(join(applicationRoot, ".runtime/mcp-instance-state/control.sqlite"));
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_releases").get()).toEqual({
        count: 1,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_readbacks").get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }
    await store.close();
  });

  it("rejects a seeded reconcile graph when both terminal event actors drift together", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);
    await finalizeReadbackAttempt(
      store,
      { metadata: mismatchReadbackMetadata, record: mismatchReadback },
      manualPublishFinalResult,
    );
    await finalizeReadbackAttempt(
      store,
      { metadata: reconcileVerifiedMetadata, record: verifiedReadback },
      completedReconcile.finalResult,
    );
    await expect(
      store.getIdempotency({
        managementTenantId: tenant,
        action: "deployments.reconcile",
        idempotencyKey: reconcileVerifiedMetadata.idempotencyKey,
      }),
    ).resolves.toMatchObject({ actorRef: publisher });
    const terminalEvents = (await store.getControlState()).events.filter(
      (event) => event.action === "deployments.reconcile",
    );
    expect(terminalEvents).toHaveLength(2);
    expect(terminalEvents.map((event) => event.actorRef)).toEqual([publisher, publisher]);
    await expect(store.health()).resolves.toEqual({ ready: true });
    await store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      database
        .prepare(
          `UPDATE module_control_events
           SET actor_ref = ?
           WHERE action = 'deployments.reconcile'
             AND json_extract(payload_json, '$.detail.kind') IN ('reconciliation', 'idempotency')`,
        )
        .run("actor_wrong");
    } finally {
      database.close();
    }

    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
  });

  it("persists a new reconcile attempt when the terminal observation repeats", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);
    await finalizeReadbackAttempt(
      store,
      { metadata: mismatchReadbackMetadata, record: mismatchReadback },
      manualPublishFinalResult,
    );

    const repeatedMismatchReadback = {
      ...mismatchReadback,
      readbackRef: "readback_release_001_mismatch_reconcile",
      checkedAt: "2099-08-22T00:04:45Z",
    } as const satisfies ModuleReadbackRecord;

    const replayReconcileMetadata = {
      managementTenantId: tenant,
      actorRef: publisher,
      action: "deployments.reconcile",
      idempotencyKey: "idem_reconcile_exact_replay_001",
      requestHash: reconcileRequestHash,
      event: {
        action: "deployments.reconcile",
        objectRef: pendingRelease.releaseId,
        kind: "reconciliation",
        status: "mismatch",
        reasonCodes: mismatchReadback.reasonCodes,
        detail: {
          kind: "reconciliation",
          releaseId: pendingRelease.releaseId,
          revision: pendingRelease.revision,
          readbackRef: repeatedMismatchReadback.readbackRef,
          status: "mismatch",
        },
      },
    } as const satisfies ReconcileRequestMetadata;

    const reconcileManualResult = {
      domainRecordRef: pendingRelease.releaseId,
      envelope: {
        ...reconcileSuccessEnvelope,
        status: "manual_review",
        data: {
          ...reconcileSuccessEnvelope.data,
          status: "mismatch",
        },
        reason_codes: [...mismatchReadback.reasonCodes],
        readback: {
          status: "mismatch",
          release_id: pendingRelease.releaseId,
          revision: pendingRelease.revision,
        },
      },
    } as const satisfies ControlFinalResult;
    const reconciled = await finalizeReadbackAttempt(
      store,
      { metadata: replayReconcileMetadata, record: repeatedMismatchReadback },
      reconcileManualResult,
    );
    expect(reconciled).toMatchObject({
      replayed: false,
      readback: repeatedMismatchReadback,
      idempotency: {
        status: "completed",
        finalResult: reconcileManualResult,
      },
    });
    await expect(store.getReadbackAttemptHistory({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toMatchObject([
      { action: "deployments.reconcile", terminalStatus: "mismatch" },
      { action: "deployments.publish", terminalStatus: "mismatch" },
    ]);

    await store.close();
    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_releases").get()).toEqual({
        count: 1,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_readbacks").get()).toEqual({
        count: 1,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_readback_attempts").get()).toEqual({
        count: 2,
      });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM module_control_events WHERE action = ?")
          .get("deployments.reconcile"),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("maps an unknown readback to manual review on the same release", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const { store } = await seedPendingStore(applicationRoot);
    const unknownReadbackMetadata = {
      ...mismatchReadbackMetadata,
      event: {
        ...mismatchReadbackMetadata.event,
        status: "unknown",
        reasonCodes: ["readback.unknown"],
        detail: {
          ...mismatchReadbackMetadata.event.detail,
          readbackRef: "readback_release_001_unknown",
          status: "unknown",
        },
      },
    } as const;
    const unknownReadback = {
      ...mismatchReadback,
      readbackRef: "readback_release_001_unknown",
      status: "unknown",
      reasonCodes: ["readback.unknown"],
      checkedAt: "2099-08-22T00:04:45Z",
    } as const satisfies ModuleReadbackRecord;
    const unknownFinalResult = {
      ...manualPublishFinalResult,
      envelope: {
        ...manualPublishFinalResult.envelope,
        reason_codes: ["readback.unknown"],
        readback: {
          status: "unknown",
          release_id: pendingRelease.releaseId,
          revision: pendingRelease.revision,
        },
      },
    } as const satisfies ControlFinalResult;

    await expect(
      finalizeReadbackAttempt(
        store,
        { metadata: unknownReadbackMetadata, record: unknownReadback },
        unknownFinalResult,
      ),
    ).resolves.toMatchObject({ readback: unknownReadback, replayed: false });
    await expect(store.getRelease({
      managementTenantId: tenant,
      releaseId: pendingRelease.releaseId,
    })).resolves.toMatchObject({
      status: "manual_review",
      readbackRef: unknownReadback.readbackRef,
      reasonCodes: unknownReadback.reasonCodes,
    });
    await store.close();
  });

  it("fails closed for reads and writes after the opened marker identity disappears", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    unlinkSync(join(applicationRoot, ".runtime/mcp-instance-state/control-identity.json"));

    await expect(store.health()).resolves.toEqual({ ready: false });
    for (const operation of [
      () => store.registerModule(registerRequest()),
      () => store.getControlState(),
      () => store.getActiveRelease(),
    ]) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "invalid_state" });
      expect(String((error as Error).message)).not.toMatch(
        /control-identity|sqlite_master|SELECT|INSERT|\/private\//i,
      );
    }
    await store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_registrations").get()).toEqual({
        count: 0,
      });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM module_control_idempotency").get(),
      ).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_control_events").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("fails closed when an opened marker is replaced by equal bytes on a new inode", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    const markerPath = join(
      applicationRoot,
      ".runtime/mcp-instance-state/control-identity.json",
    );
    const markerBytes = readFileSync(markerPath);
    renameSync(markerPath, `${markerPath}.replaced`);
    writeFileSync(markerPath, markerBytes, { flag: "wx", mode: 0o400 });
    chmodSync(markerPath, 0o400);

    await expect(store.health()).resolves.toEqual({ ready: false });
    await expect(store.registerModule(registerRequest())).rejects.toMatchObject({
      code: "invalid_state",
    });
    await store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_registrations").get()).toEqual({
        count: 0,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_control_events").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("fails closed before mutation when the opened database path changes inode", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    const databasePath = controlDatabasePath(applicationRoot);
    const originalBytes = readFileSync(databasePath);
    const movedDatabasePath = `${databasePath}.replaced`;
    renameSync(databasePath, movedDatabasePath);
    writeFileSync(databasePath, originalBytes, { flag: "wx", mode: 0o600 });
    chmodSync(databasePath, 0o600);

    await expect(store.health()).resolves.toEqual({ ready: false });
    await expect(store.registerModule(registerRequest())).rejects.toMatchObject({
      code: "invalid_state",
    });
    await store.close();

    for (const persistedPath of [movedDatabasePath, databasePath]) {
      const database = new DatabaseSync(persistedPath);
      try {
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM module_registrations").get(),
        ).toEqual({ count: 0 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM module_control_events").get()).toEqual({
          count: 0,
        });
      } finally {
        database.close();
      }
    }
  });

  it("rejects an orphan registration event with no authoritative record", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    const orphanRef = `registration:orphan:1.0.0:${secondDescriptorDigest}`;
    try {
      database
        .prepare(
          `INSERT INTO module_control_events
            (sequence, management_tenant_id, event_id, actor_ref, action, object_ref,
             idempotency_key, request_hash, status, reason_codes_json,
             payload_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          1,
          tenant,
          "event_orphan_registration_001",
          actor,
          "packages.register",
          orphanRef,
          "idem_orphan_registration_001",
          requestHash,
          "registered",
          "[]",
          JSON.stringify({
            detail: {
              kind: "registration",
              recordRef: orphanRef,
              moduleId: "orphan",
              version: "1.0.0",
              descriptorDigest: secondDescriptorDigest,
              status: "registered",
            },
          }),
          registrationRecord.registeredAt,
        );
    } finally {
      database.close();
    }

    const before = persistedRowCounts(applicationRoot);
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
    expect(persistedRowCounts(applicationRoot)).toEqual(before);
  });

  it("rejects a release whose required publish event was deleted", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const seeded = await seedPendingStore(applicationRoot);
    await seeded.store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      database
        .prepare(
          `DELETE FROM module_control_events
           WHERE management_tenant_id = ? AND object_ref = ?
             AND json_extract(payload_json, '$.detail.kind') = 'release'`,
        )
        .run(tenant, pendingRelease.releaseId);
    } finally {
      database.close();
    }

    const before = persistedRowCounts(applicationRoot);
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
    expect(persistedRowCounts(applicationRoot)).toEqual(before);
  });

  it.each([
    {
      name: "duplicate",
      corrupt: (database: DatabaseSync): void => {
        database.exec(
          `INSERT INTO module_control_events
             (sequence, management_tenant_id, event_id, actor_ref, action,
              idempotency_key, request_hash, object_ref, status,
              reason_codes_json, payload_json, occurred_at)
           SELECT 2, management_tenant_id, 'event_duplicate_registration_001', actor_ref,
                  action, idempotency_key, request_hash, object_ref, status,
                  reason_codes_json, payload_json, occurred_at
           FROM module_control_events WHERE sequence = 1`,
        );
      },
    },
    {
      name: "object",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare("UPDATE module_control_events SET object_ref = ? WHERE sequence = 1")
          .run(`registration:wrong:1.0.0:${descriptorDigest}`);
      },
    },
    {
      name: "detail",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare("UPDATE module_control_events SET payload_json = ? WHERE sequence = 1")
          .run(JSON.stringify({
            detail: {
              ...registrationMetadata.event.detail,
              moduleId: "wrong",
            },
          }));
      },
    },
    {
      name: "time",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare("UPDATE module_control_events SET occurred_at = ? WHERE sequence = 1")
          .run("2099-08-22T00:00:00.000000001Z");
      },
    },
    {
      name: "reasons",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare("UPDATE module_control_events SET reason_codes_json = ? WHERE sequence = 1")
          .run('["unexpected.reason"]');
      },
    },
    {
      name: "actor",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare("UPDATE module_control_events SET actor_ref = ? WHERE sequence = 1")
          .run("actor_wrong");
      },
    },
    {
      name: "idempotency key",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare("UPDATE module_control_events SET idempotency_key = ? WHERE sequence = 1")
          .run("idem_wrong");
      },
    },
    {
      name: "request hash",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare("UPDATE module_control_events SET request_hash = ? WHERE sequence = 1")
          .run(`mcp-control-hash/v1/request/sha256:${"9".repeat(64)}`);
      },
    },
    {
      name: "action-kind-status",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare(
            `UPDATE module_control_events
             SET action = 'approvals.decide', object_ref = 'approval_wrong',
                 status = 'approved', payload_json = ?
             WHERE sequence = 1`,
          )
          .run(JSON.stringify({
            detail: {
              kind: "approval",
              approvalId: "approval_wrong",
              previewRef: changePreview.previewRef,
              status: "approved",
            },
          }));
      },
    },
  ])("rejects a $name event binding that disagrees with its authority", async ({ corrupt }) => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await store.registerModule(registerRequest());
    await store.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      corrupt(database);
    } finally {
      database.close();
    }
    const before = persistedRowCounts(applicationRoot);
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
    expect(persistedRowCounts(applicationRoot)).toEqual(before);
  });

  it("requires event sequence to start at one", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await store.registerModule(registerRequest());
    await store.close();
    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      database.exec("UPDATE module_control_events SET sequence = 2 WHERE sequence = 1");
    } finally {
      database.close();
    }
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
  });

  it("rejects a gap created by deleting a middle event", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    await store.registerModule(registerRequest());
    await store.createPreview(previewRequest());
    await store.decideApproval(approvalRequest());
    await store.close();
    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      database.exec("DELETE FROM module_control_events WHERE sequence = 2");
    } finally {
      database.close();
    }
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
  });

  it("rejects the full-graph sequence set [1,3..258] outside the projection window", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const initialized = openStore(applicationRoot);
    await initialized.close();
    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      insertSyntheticPreviewEventHistory(database, 258, "sequence_gap_window");
      database.exec("DELETE FROM module_control_events WHERE sequence = 2");
      expect(database.prepare(
        "SELECT COUNT(*) AS count, MIN(sequence) AS first, MAX(sequence) AS last FROM module_control_events",
      ).get()).toEqual({ count: 257, first: 1, last: 258 });
    } finally {
      database.close();
    }
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
  });

  it("requires full-graph event instants to be nondecreasing while accepting offset equivalence", async () => {
    const registrationAt = (
      moduleId: string,
      digest: ModuleControlRef["descriptorDigest"],
      idempotencyKey: string,
      registeredAt: string,
    ): RegisterModuleRecordRequest => {
      const request = structuredClone(registerRequest()) as RegisterModuleRecordRequest;
      const recordRef = `registration:${moduleId}:1.0.0:${digest}`;
      Reflect.set(request.record, "moduleId", moduleId);
      Reflect.set(request.record, "descriptorDigest", digest);
      Reflect.set(request.record, "registeredAt", registeredAt);
      Reflect.set(request.metadata, "idempotencyKey", idempotencyKey);
      Reflect.set(request.metadata.event, "objectRef", recordRef);
      Reflect.set(request.metadata.event.detail, "recordRef", recordRef);
      Reflect.set(request.metadata.event.detail, "moduleId", moduleId);
      Reflect.set(request.metadata.event.detail, "descriptorDigest", digest);
      Reflect.set(request.finalResult, "domainRecordRef", recordRef);
      if (request.finalResult.envelope.data?.kind !== "registration") {
        throw new Error("registration fixture is incomplete");
      }
      Reflect.set(request.finalResult.envelope.data, "module_id", moduleId);
      Reflect.set(request.finalResult.envelope.data, "descriptor_digest", digest);
      return request;
    };
    const seedPair = async (
      suffix: string,
      firstAt: string,
      secondAt: string,
      rejectSecond = false,
    ): Promise<string> => {
      const applicationRoot = makeApplicationRoot();
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: tenant,
      });
      const store = openStore(applicationRoot);
      await store.registerModule(registrationAt(
        `cargo_${suffix}`,
        descriptorDigest,
        `idem_event_order_${suffix}_1`,
        firstAt,
      ));
      const second = store.registerModule(registrationAt(
          `quote_${suffix}`,
          secondDescriptorDigest,
          `idem_event_order_${suffix}_2`,
          secondAt,
        ));
      if (rejectSecond) {
        await expect(second).rejects.toMatchObject({ code: "invalid_state" });
      } else {
        await second;
      }
      await store.close();
      return applicationRoot;
    };

    const equivalentRoot = await seedPair(
      "equivalent",
      "2099-08-22T00:00:00.000000001Z",
      "2099-08-21T19:00:00.000000001-05:00",
    );
    const equivalent = openStore(equivalentRoot);
    await expect(equivalent.health()).resolves.toEqual({ ready: true });
    await equivalent.close();

    const reversedRoot = await seedPair(
      "reversed",
      "2099-08-22T00:00:00.000000002Z",
      "2099-08-22T00:00:00.000000001Z",
      true,
    );
    const reversed = openStore(reversedRoot);
    await expect(reversed.health()).resolves.toEqual({ ready: true });
    await expect(reversed.getControlState()).resolves.toMatchObject({
      events: [expect.objectContaining({ sequence: 1 })],
    });
    await reversed.close();
  });

  it("rejects a corrupted historical preview diff even when a newer preview is valid", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const seed = openStore(applicationRoot);
    await seed.createPreview(previewRequest());
    await seed.createPreview(setPreviewRequest());
    await seed.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      database
        .prepare(
          `UPDATE module_previews
           SET diff_json = ?
           WHERE management_tenant_id = ? AND preview_ref = ?`,
        )
        .run('{"added":[],"removed":[],"retained":[]}', tenant, changePreview.previewRef);
    } finally {
      database.close();
    }

    const before = persistedRowCounts(applicationRoot);
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
    expect(persistedRowCounts(applicationRoot)).toEqual(before);
  });

  it("rejects a superseded release whose publish idempotency is still domain committed", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const seeded = await seedTwoVerifiedReleases(applicationRoot);
    await seeded.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      database
        .prepare(
          `UPDATE module_control_idempotency
           SET status = 'domain_committed', final_result_json = NULL
           WHERE management_tenant_id = ? AND action = 'deployments.publish'
             AND idempotency_key = ?`,
        )
        .run(tenant, publishMetadata.idempotencyKey);
    } finally {
      database.close();
    }

    const before = persistedRowCounts(applicationRoot);
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
    expect(persistedRowCounts(applicationRoot)).toEqual(before);
  });

  it.each([
    {
      name: "release",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare(
            `UPDATE module_releases
             SET desired_modules_json = '[]'
             WHERE management_tenant_id = ? AND release_id = ?`,
          )
          .run(tenant, pendingRelease.releaseId);
      },
    },
    {
      name: "release publication order",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare(
            `UPDATE module_releases
             SET created_at = ?, published_at = ?
             WHERE management_tenant_id = ? AND release_id = ?`,
          )
          .run(
            "2099-08-22T00:03:00.000000002Z",
            "2099-08-22T00:03:00.000000001Z",
            tenant,
            pendingRelease.releaseId,
          );
      },
    },
    {
      name: "idempotency",
      corrupt: (database: DatabaseSync): void => {
        database
          .prepare(
            `UPDATE module_control_idempotency
             SET expires_at = created_at
             WHERE management_tenant_id = ? AND action = ? AND idempotency_key = ?`,
          )
          .run(tenant, publishMetadata.action, publishMetadata.idempotencyKey);
      },
    },
  ])("rejects corrupted historical $name rows hidden behind a valid active release", async ({ corrupt }) => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const seed = await seedTwoVerifiedReleases(applicationRoot);
    await seed.close();

    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      corrupt(database);
    } finally {
      database.close();
    }

    const before = persistedRowCounts(applicationRoot);
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
    expect(persistedRowCounts(applicationRoot)).toEqual(before);
  });

  it("rejects semantic corruption in an event older than the returned state window", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const initialized = openStore(applicationRoot);
    await initialized.close();

    const eventCount = 300;
    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      insertSyntheticPreviewEventHistory(database, eventCount, "historical");
      database
        .prepare("UPDATE module_control_events SET payload_json = ? WHERE sequence = 1")
        .run('{"detail":{"kind":"preview","status":"previewed"}}');
    } finally {
      database.close();
    }

    const before = persistedRowCounts(applicationRoot);
    expect(before.events).toBe(eventCount);
    await expectSemanticCorruptionFailsClosed(openStore(applicationRoot));
    expect(persistedRowCounts(applicationRoot)).toEqual(before);
  });

  it("reports unhealthy semantic event corruption and blocks mutations without adding rows", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const database = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      database
        .prepare(
          `INSERT INTO module_control_events
            (sequence, management_tenant_id, event_id, actor_ref, action,
             idempotency_key, request_hash, object_ref, status,
             reason_codes_json, payload_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          1,
          tenant,
          "event_semantically_invalid_001",
          actor,
          "packages.register",
          "corrupt_001",
          requestHash,
          "idempotency:packages.register:corrupt_001",
          "completed",
          "[]",
          '{"detail":{"kind":"idempotency","status":"completed"}}',
          "2099-08-22T00:00:00Z",
        );
    } finally {
      database.close();
    }

    const store = openStore(applicationRoot);
    await expect(store.health()).resolves.toEqual({ ready: false });
    await expect(store.getControlState()).rejects.toMatchObject({ code: "invalid_state" });
    await expect(store.registerModule(registerRequest())).rejects.toMatchObject({
      code: "invalid_state",
    });
    await store.close();

    const persisted = new DatabaseSync(controlDatabasePath(applicationRoot));
    try {
      expect(persisted.prepare("SELECT COUNT(*) AS count FROM module_registrations").get()).toEqual({
        count: 0,
      });
      expect(
        persisted.prepare("SELECT COUNT(*) AS count FROM module_control_idempotency").get(),
      ).toEqual({ count: 0 });
      expect(persisted.prepare("SELECT COUNT(*) AS count FROM module_control_events").get()).toEqual({
        count: 1,
      });
    } finally {
      persisted.close();
    }
  });

  it("keeps returned records deeply frozen and reports typed closed state for every method", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState({
      applicationRoot,
      instanceId: "instance_fixture_001",
      managementTenantId: tenant,
    });
    const store = openStore(applicationRoot);
    const result = await store.registerModule(registerRequest());
    const state = await store.getControlState();
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(result.event)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.registrations)).toBe(true);
    expect(() => {
      (result.record as { moduleId: string }).moduleId = "changed";
    }).toThrow();
    expect(() => {
      (state.registrations as Array<ModuleRegistrationRecord>).push(registrationRecord);
    }).toThrow();
    await expect(store.getControlState()).resolves.toMatchObject({
      registrations: [registrationRecord],
    });

    await store.close();
    await expect(store.health()).resolves.toEqual({ ready: false });
    await expect(store.registerModule(registerRequest())).rejects.toMatchObject({ code: "closed" });
    await expect(store.createPreview(previewRequest())).rejects.toMatchObject({ code: "closed" });
    await expect(store.decideApproval(approvalRequest())).rejects.toMatchObject({ code: "closed" });
    await expect(store.publishRelease(publishRequest())).rejects.toMatchObject({ code: "closed" });
    await expect(store.getControlState()).rejects.toMatchObject({ code: "closed" });
    await expect(store.getActiveRelease()).rejects.toMatchObject({ code: "closed" });
    await expect(store.getPendingRelease()).rejects.toMatchObject({ code: "closed" });
    await expect(store.getNewestUnresolvedRelease()).rejects.toMatchObject({ code: "closed" });
    await expect(
      store.getPreview({ managementTenantId: tenant, previewRef: changePreview.previewRef }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      store.getApproval({ managementTenantId: tenant, approvalId: approval.approvalId }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      store.getRelease({ managementTenantId: tenant, releaseId: pendingRelease.releaseId }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      store.getReadback({ managementTenantId: tenant, releaseId: pendingRelease.releaseId }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      store.getIdempotency({
        managementTenantId: tenant,
        action: "deployments.publish",
        idempotencyKey: publishMetadata.idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "closed" });
    await store.close();
  });
});
