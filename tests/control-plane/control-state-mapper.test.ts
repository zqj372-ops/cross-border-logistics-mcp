import { describe, expect, it } from "vitest";

import {
  ControlContractError,
} from "../../src/logistics_mcp/control-plane/contracts";
import { createModuleInventory } from "../../src/logistics_mcp/control-plane/inventory";
import {
  ControlStateMapperError,
  mapControlStateToDto,
} from "../../src/logistics_mcp/control-plane/control-state-mapper";
import type {
  ControlEventRecord,
  ModuleActiveVerifiedReleaseRecord,
  ModuleApprovalRecord,
  ModuleChangePreviewRecord,
  ModuleControlRef,
  ModuleControlState,
  ModuleManualReviewReleaseRecord,
  ModuleMismatchReadbackRecord,
  ModulePendingReadbackRecord,
  ModulePendingReleaseRecord,
  ModuleReleaseHistoryEntry,
  ModuleRegistrationRecord,
  ModuleSupersededReleaseRecord,
  ModuleUnknownReadbackRecord,
  ModuleVerifiedReadbackRecord,
} from "../../src/logistics_mcp/control-plane/repository";
import type {
  ModuleInventoryInput,
  TrustedModuleInventory,
} from "../../src/logistics_mcp/control-plane/types";

const MANAGEMENT_TENANT_ID = "tenant_admin";
const MODULE_VERSION = "2026-08-21.v0";
const LEGACY_MODULE_VERSION = "2026-08-20.v0";

const inventoryInput: ModuleInventoryInput = {
  mountedModules: [
    {
      moduleId: "cargo",
      version: MODULE_VERSION,
      riskLevel: "T0",
      lifecycle: "static",
      requiredCapabilities: ["audit", "tenant_context"],
      optionalCapabilities: [],
      standardRefs: ["platform.contracts", "module-runtime.v0"],
    },
    {
      moduleId: "container",
      version: MODULE_VERSION,
      riskLevel: "T0",
      lifecycle: "static",
      requiredCapabilities: ["audit", "tenant_context"],
      optionalCapabilities: [],
      standardRefs: ["platform.contracts", "module-runtime.v0"],
    },
  ],
  catalog: [
    {
      owner: "cargo",
      name: "cargo.calculate",
      permission: "quote:calculate",
      kind: "read",
      riskLevel: "T0",
      inputSchemaId: "urn:input:cargo",
      outputSchemaId: "urn:output:cargo",
      standardRefs: ["platform.contracts", "module-runtime.v0"],
    },
    {
      owner: "container",
      name: "container.plan_summary",
      permission: "container:calculate",
      kind: "read",
      riskLevel: "T0",
      inputSchemaId: "urn:input:container",
      outputSchemaId: "urn:output:container",
      standardRefs: ["platform.contracts", "module-runtime.v0"],
    },
  ],
  localEvidence: [
    {
      moduleId: "cargo",
      version: MODULE_VERSION,
      evidenceRefs: {
        sourceShaRef: "local:source:secret_source_sha",
        artifactDigestRef: "local:artifact:secret_artifact_digest",
        signatureRef: "local:signature:secret_signature",
        sbomRef: "local:sbom:secret_sbom",
        attestationRef: "local:attestation:secret_attestation",
      },
    },
    {
      moduleId: "container",
      version: MODULE_VERSION,
      evidenceRefs: {
        sourceShaRef: null,
        artifactDigestRef: null,
        signatureRef: null,
        sbomRef: null,
        attestationRef: null,
      },
    },
  ],
};

const inventory = createModuleInventory(inventoryInput);

function inventoryEntry(
  currentInventory: TrustedModuleInventory,
  moduleId: string,
) {
  const entry = currentInventory.find((candidate) => candidate.moduleId === moduleId);
  if (entry === undefined) throw new Error(`missing test inventory entry: ${moduleId}`);
  return entry;
}

function moduleRef(
  currentInventory: TrustedModuleInventory,
  moduleId: string,
): ModuleControlRef {
  const entry = inventoryEntry(currentInventory, moduleId);
  return {
    moduleId: entry.moduleId,
    version: entry.version,
    descriptorDigest: entry.descriptorDigest,
  };
}

const cargoRef = moduleRef(inventory, "cargo");
const containerRef = moduleRef(inventory, "container");
const legacyRef: ModuleControlRef = {
  moduleId: "legacy_module",
  version: LEGACY_MODULE_VERSION,
  descriptorDigest: `sha256:${"e".repeat(64)}`,
};

const releaseOne: ModuleSupersededReleaseRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  releaseId: "release_one",
  revision: 1,
  desiredModules: [legacyRef],
  previousReleaseId: null,
  previewRef: "preview_one",
  approvalId: "approval_one",
  publisherActorRef: "actor_publisher",
  createdAt: "2026-08-25T10:00:00Z",
  publishedAt: "2026-08-25T10:01:00Z",
  status: "superseded",
  readbackRef: "readback_one",
  reasonCodes: [],
  supersededByReleaseId: "release_two",
};

const releaseTwo: ModuleSupersededReleaseRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  releaseId: "release_two",
  revision: 2,
  desiredModules: [cargoRef],
  previousReleaseId: "release_one",
  previewRef: "preview_two",
  approvalId: "approval_two",
  publisherActorRef: "actor_publisher",
  createdAt: "2026-08-25T10:05:00Z",
  publishedAt: "2026-08-25T10:06:00Z",
  status: "superseded",
  readbackRef: "readback_two",
  reasonCodes: [],
  supersededByReleaseId: "release_three",
};

const releaseThree: ModuleActiveVerifiedReleaseRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  releaseId: "release_three",
  revision: 3,
  desiredModules: [cargoRef, containerRef],
  previousReleaseId: "release_two",
  previewRef: "preview_latest",
  approvalId: "approval_latest",
  publisherActorRef: "actor_publisher",
  createdAt: "2026-08-25T10:10:00Z",
  publishedAt: "2026-08-25T10:11:00Z",
  status: "active_verified",
  readbackRef: "readback_three",
  reasonCodes: [],
  supersededByReleaseId: null,
};

const releaseThreeHistoryEntry: ModuleReleaseHistoryEntry = {
  release: releaseThree,
  intent: "change",
  rollbackTargetReleaseId: null,
};

const releaseTwoHistoryEntry: ModuleReleaseHistoryEntry = {
  release: releaseTwo,
  intent: "rollback",
  rollbackTargetReleaseId: releaseOne.releaseId,
};

const releaseOneHistoryEntry: ModuleReleaseHistoryEntry = {
  release: releaseOne,
  intent: "change",
  rollbackTargetReleaseId: null,
};

const changePreview: ModuleChangePreviewRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  previewRef: "preview_latest",
  canonicalHash: `mcp-control-hash/v1/preview/sha256:${"c".repeat(64)}`,
  baseReleaseId: releaseThree.releaseId,
  baseRevision: releaseThree.revision,
  inventoryRefs: [cargoRef, containerRef],
  desiredModules: [cargoRef],
  diff: {
    added: [],
    removed: [containerRef],
    retained: [cargoRef],
  },
  validation: {
    baseMatches: true,
    desiredModulesValid: true,
    inventoryMatches: true,
    minimumActiveModules: true,
    reasonCodes: [],
  },
  creatorActorRef: "actor_preview_creator",
  createdAt: "2026-08-25T11:00:00Z",
  expiresAt: "2026-08-25T12:00:00Z",
  consumed: false,
  intent: "change",
};

const rollbackPreview: ModuleChangePreviewRecord = {
  ...changePreview,
  previewRef: "preview_rollback",
  canonicalHash: `mcp-control-hash/v1/preview/sha256:${"d".repeat(64)}`,
  intent: "change",
};

const rollbackPreviewRecord = {
  ...rollbackPreview,
  intent: "rollback" as const,
  targetReleaseId: releaseTwo.releaseId,
};

const approve: ModuleApprovalRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  approvalId: "approval_latest",
  previewRef: changePreview.previewRef,
  decision: "approve",
  previewCanonicalHash: changePreview.canonicalHash,
  baseReleaseId: changePreview.baseReleaseId,
  baseRevision: changePreview.baseRevision,
  inventoryDigestSet: [cargoRef.descriptorDigest, containerRef.descriptorDigest],
  expiresAt: changePreview.expiresAt,
  reasonCode: "release_reviewed",
  approverActorRef: "actor_approver",
  decidedAt: "2026-08-25T11:05:00Z",
  consumed: false,
};

const reject: ModuleApprovalRecord = {
  ...approve,
  approvalId: "approval_rejected",
  previewRef: rollbackPreviewRecord.previewRef,
  decision: "reject",
  previewCanonicalHash: rollbackPreviewRecord.canonicalHash,
  reasonCode: "operator_rejected",
};

const verifiedReadback: ModuleVerifiedReadbackRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  readbackRef: releaseThree.readbackRef,
  releaseId: releaseThree.releaseId,
  attemptId: "attempt_verified_secret",
  revision: releaseThree.revision,
  appliedReleaseId: releaseThree.releaseId,
  appliedRevision: releaseThree.revision,
  appliedModules: [cargoRef, containerRef],
  status: "verified",
  reasonCodes: [],
  checkedAt: "2026-08-25T10:12:00Z",
};

const manualRelease: ModuleManualReviewReleaseRecord = {
  managementTenantId: MANAGEMENT_TENANT_ID,
  releaseId: "release_manual",
  revision: 4,
  desiredModules: [cargoRef],
  previousReleaseId: releaseThree.releaseId,
  previewRef: "preview_manual",
  approvalId: "approval_manual",
  publisherActorRef: "actor_publisher",
  createdAt: "2026-08-25T10:15:00Z",
  publishedAt: "2026-08-25T10:16:00Z",
  status: "manual_review",
  readbackRef: "readback_manual",
  reasonCodes: ["runtime_readback_mismatch"],
  supersededByReleaseId: null,
};

const driftedCargoRef: ModuleControlRef = {
  ...cargoRef,
  descriptorDigest: `sha256:${"f".repeat(64)}`,
};

function event(
  sequence: number,
  action: ControlEventRecord["action"],
  kind: ControlEventRecord["kind"],
  status: string,
  detail: Record<string, unknown>,
): ControlEventRecord {
  return {
    managementTenantId: MANAGEMENT_TENANT_ID,
    eventId: `event_${sequence}`,
    sequence,
    actorRef: "actor_event",
    action,
    objectRef: `object_${sequence}`,
    kind,
    status,
    reasonCodes: [],
    detail,
    occurredAt: "2026-08-25T11:10:00Z",
  } as unknown as ControlEventRecord;
}

const allEventKinds: readonly ControlEventRecord[] = [
  event(1, "packages.register", "registration", "registered", {
    kind: "registration",
    recordRef: "object_1",
    moduleId: "cargo",
    version: MODULE_VERSION,
    descriptorDigest: cargoRef.descriptorDigest,
    status: "registered",
  }),
  event(2, "deployments.preview", "preview", "previewed", {
    kind: "preview",
    previewRef: "object_2",
    baseRevision: 3,
    status: "previewed",
  }),
  event(3, "approvals.decide", "approval", "approved", {
    kind: "approval",
    approvalId: "object_3",
    previewRef: "preview_latest",
    status: "approved",
  }),
  event(4, "deployments.publish", "release", "active_verified", {
    kind: "release",
    releaseId: "object_4",
    revision: 4,
    status: "active_verified",
  }),
  event(5, "deployments.publish", "reconciliation", "verified", {
    kind: "reconciliation",
    releaseId: "object_5",
    revision: 5,
    readbackRef: "opaque_readback_5",
    status: "verified",
  }),
  event(6, "deployments.reconcile", "reconciliation", "mismatch", {
    kind: "reconciliation",
    releaseId: "object_6",
    revision: 6,
    readbackRef: "opaque_readback_6",
    status: "mismatch",
  }),
  event(7, "deployments.publish", "idempotency", "completed", {
    kind: "idempotency",
    recordRef: "object_7",
    domainRecordRef: "opaque_release_7",
    status: "completed",
  }),
];

function registrationRecords(): ModuleRegistrationRecord[] {
  return [
    {
      managementTenantId: MANAGEMENT_TENANT_ID,
      moduleId: "cargo",
      version: cargoRef.version,
      descriptorDigest: cargoRef.descriptorDigest,
      evidenceLevel: "local_build" as const,
      productionEligible: false as const,
      evidenceRefs: {
        sourceShaRef: "local:source:registration_secret",
        artifactDigestRef: "local:artifact:registration_secret",
        signatureRef: "local:signature:registration_secret",
        sbomRef: "local:sbom:registration_secret",
        attestationRef: "local:attestation:registration_secret",
      },
      registeredByActorRef: "actor_registration",
      registeredAt: "2026-08-25T09:00:00Z",
    },
    {
      managementTenantId: MANAGEMENT_TENANT_ID,
      moduleId: "container",
      version: containerRef.version,
      descriptorDigest: containerRef.descriptorDigest,
      evidenceLevel: "local_build" as const,
      productionEligible: false as const,
      evidenceRefs: {
        sourceShaRef: null,
        artifactDigestRef: null,
        signatureRef: null,
        sbomRef: null,
        attestationRef: null,
      },
      registeredByActorRef: "actor_registration",
      registeredAt: "2026-08-25T09:01:00Z",
    },
  ];
}

function activeState(
  overrides: Partial<ModuleControlState> = {},
): ModuleControlState {
  return {
    managementTenantId: MANAGEMENT_TENANT_ID,
    activeRelease: releaseThree,
    activeRevision: releaseThree.revision,
    activeModules: [cargoRef, containerRef],
    registrations: registrationRecords(),
    latestPreview: changePreview,
    latestApproval: approve,
    latestReadback: verifiedReadback,
    releaseHistory: [
      releaseThreeHistoryEntry,
      releaseTwoHistoryEntry,
      releaseOneHistoryEntry,
    ],
    events: allEventKinds,
    eventsTruncated: false,
    ...overrides,
  };
}

function inactiveState(
  overrides: Partial<ModuleControlState> = {},
): ModuleControlState {
  return {
    managementTenantId: MANAGEMENT_TENANT_ID,
    activeRelease: null,
    activeRevision: 0,
    activeModules: [],
    registrations: [],
    latestPreview: null,
    latestApproval: null,
    latestReadback: null,
    releaseHistory: [],
    events: [],
    eventsTruncated: false,
    ...overrides,
  };
}

function manualReviewState(
  readback: ModuleMismatchReadbackRecord | ModuleUnknownReadbackRecord,
): ModuleControlState {
  const currentManualRelease: ModuleManualReviewReleaseRecord = {
    ...manualRelease,
    readbackRef: readback.readbackRef,
    reasonCodes: readback.reasonCodes,
  };
  return activeState({
    latestPreview: null,
    latestApproval: null,
    latestReadback: readback,
    releaseHistory: [
      {
        release: currentManualRelease,
        intent: "change",
        rollbackTargetReleaseId: null,
      },
      releaseThreeHistoryEntry,
      releaseTwoHistoryEntry,
      releaseOneHistoryEntry,
    ],
    events: [],
  });
}

function pendingReleaseState(): ModuleControlState {
  const pendingRelease: ModulePendingReleaseRecord = {
    managementTenantId: MANAGEMENT_TENANT_ID,
    releaseId: "release_pending",
    revision: 4,
    desiredModules: [cargoRef],
    previousReleaseId: releaseThree.releaseId,
    previewRef: "preview_pending",
    approvalId: "approval_pending",
    publisherActorRef: "actor_publisher",
    createdAt: "2026-08-25T10:15:00Z",
    publishedAt: null,
    status: "published_pending_readback",
    readbackRef: null,
    reasonCodes: [],
    supersededByReleaseId: null,
  };
  return activeState({
    latestPreview: null,
    latestApproval: null,
    latestReadback: null,
    releaseHistory: [
      { release: pendingRelease, intent: "change", rollbackTargetReleaseId: null },
      releaseThreeHistoryEntry,
      releaseTwoHistoryEntry,
      releaseOneHistoryEntry,
    ],
    events: [],
  });
}

function errorFrom(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

function stateWithTamperedRegistration(
  tamper: (registration: Record<string, unknown>) => void,
): ModuleControlState {
  const registrations = registrationRecords();
  tamper(registrations[0] as unknown as Record<string, unknown>);
  return activeState({ registrations });
}

const registrationTamperCases: readonly [
  string,
  (registration: Record<string, unknown>) => void,
][] = [
  ["descriptorDigest", (registration) => {
    registration.descriptorDigest = `sha256:${"a".repeat(64)}`;
  }],
  ["evidenceLevel", (registration) => {
    registration.evidenceLevel = "tampered_evidence_level";
  }],
  ["productionEligible", (registration) => {
    registration.productionEligible = true;
  }],
  ["evidenceRefs.extraKey", (registration) => {
    (registration.evidenceRefs as Record<string, unknown>).extraKey =
      "opaque_hidden_evidence";
  }],
  ["evidenceRefs.missingKey", (registration) => {
    delete (registration.evidenceRefs as Record<string, unknown>).attestationRef;
  }],
  ["evidenceRefs.nonString", (registration) => {
    (registration.evidenceRefs as Record<string, unknown>).sourceShaRef = 7;
  }],
];

const approvalBindingTamperCases: readonly [
  string,
  (approval: ModuleApprovalRecord) => ModuleApprovalRecord,
][] = [
  ["previewRef", (approval) => ({ ...approval, previewRef: "preview_tampered" })],
  ["previewCanonicalHash", (approval) => ({
    ...approval,
    previewCanonicalHash: `mcp-control-hash/v1/preview/sha256:${"e".repeat(64)}`,
  })],
  ["baseReleaseId", (approval) => ({ ...approval, baseReleaseId: "release_tampered" })],
  ["baseRevision", (approval) => ({ ...approval, baseRevision: approval.baseRevision + 1 })],
  ["expiresAt", (approval) => ({ ...approval, expiresAt: "2026-08-25T13:00:00Z" })],
  ["inventoryDigestSet", (approval) => ({
    ...approval,
    inventoryDigestSet: [approval.inventoryDigestSet[0]!, `sha256:${"e".repeat(64)}`],
  })],
];

function repeatedEvents(length: number, firstSequence: number): ControlEventRecord[] {
  return Array.from({ length }, (_, index) => {
    const sequence = firstSequence + index;
    return event(
      sequence,
      "deployments.publish",
      "idempotency",
      "completed",
      {
        kind: "idempotency",
        recordRef: `object_${sequence}`,
        domainRecordRef: "opaque_release_window",
        status: "completed",
      },
    );
  });
}

function expectMapperCode(operation: () => unknown, code: ControlStateMapperError["code"]): void {
  const error = errorFrom(operation);
  expect(error).toBeInstanceOf(ControlStateMapperError);
  expect((error as ControlStateMapperError | undefined)?.code).toBe(code);
  expect((error as Error | undefined)?.message).toBe(code);
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      expectDeepFrozen(descriptor.value);
    }
  }
}

describe("pure Admin control-state mapper", () => {
  it("maps the empty state to the closed inactive DTO", () => {
    const result = mapControlStateToDto(inactiveState(), createModuleInventory({
      mountedModules: [],
      catalog: [],
      localEvidence: [],
    }), MANAGEMENT_TENANT_ID);

    expect(result).toEqual({
      kind: "control_state",
      activation: {
        state: "inactive",
        release_id: null,
        revision: 0,
        active_modules: [],
      },
      inventory_modules: [],
      latest_preview: null,
      latest_approval: null,
      latest_readback: null,
      release_history: [],
      events: [],
      events_truncated: false,
    });
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("data");
  });

  it("maps registration, change preview, approval, verified readback, history and every event summary explicitly", () => {
    const result = mapControlStateToDto(activeState(), inventory, MANAGEMENT_TENANT_ID);

    expect(result.activation).toEqual({
      state: "active",
      release_id: releaseThree.releaseId,
      revision: releaseThree.revision,
      active_modules: [cargoRef, containerRef].map((ref) => ({
        module_id: ref.moduleId,
        version: ref.version,
        descriptor_digest: ref.descriptorDigest,
      })),
    });
    expect(result.inventory_modules).toEqual([
      expect.objectContaining({
        module_id: "cargo",
        version: MODULE_VERSION,
        descriptor_digest: cargoRef.descriptorDigest,
        evidence_level: "local_build",
        production_eligible: false,
        tool_names: ["cargo.calculate"],
        standard_ids: ["module-runtime.v0", "platform.contracts"],
        registration: {
          registered_by_actor_ref: "actor_registration",
          registered_at: "2026-08-25T09:00:00Z",
        },
      }),
      expect.objectContaining({
        module_id: "container",
        registration: {
          registered_by_actor_ref: "actor_registration",
          registered_at: "2026-08-25T09:01:00Z",
        },
      }),
    ]);
    expect(result.latest_preview).toEqual({
      intent: "change",
      preview_ref: changePreview.previewRef,
      canonical_hash: changePreview.canonicalHash,
      base_release_id: changePreview.baseReleaseId,
      base_revision: changePreview.baseRevision,
      desired_modules: [cargoRef].map((ref) => ({
        module_id: ref.moduleId,
        version: ref.version,
        descriptor_digest: ref.descriptorDigest,
      })),
      diff: {
        added: [],
        removed: [containerRef].map((ref) => ({
          module_id: ref.moduleId,
          version: ref.version,
          descriptor_digest: ref.descriptorDigest,
        })),
        retained: [cargoRef].map((ref) => ({
          module_id: ref.moduleId,
          version: ref.version,
          descriptor_digest: ref.descriptorDigest,
        })),
      },
      validation: {
        base_matches: true,
        desired_modules_valid: true,
        inventory_matches: true,
        minimum_active_modules: true,
        reason_codes: [],
      },
      creator_actor_ref: changePreview.creatorActorRef,
      created_at: changePreview.createdAt,
      expires_at: changePreview.expiresAt,
      consumed: false,
    });
    expect(result.latest_approval).toEqual({
      approval_id: approve.approvalId,
      preview_ref: approve.previewRef,
      decision: "approve",
      reason_code: approve.reasonCode,
      approver_actor_ref: approve.approverActorRef,
      decided_at: approve.decidedAt,
      consumed: false,
    });
    expect(result.latest_readback).toEqual({
      release_id: releaseThree.releaseId,
      revision: releaseThree.revision,
      readback_ref: releaseThree.readbackRef,
      applied_modules: [cargoRef, containerRef].map((ref) => ({
        module_id: ref.moduleId,
        version: ref.version,
        descriptor_digest: ref.descriptorDigest,
      })),
      checked_at: verifiedReadback.checkedAt,
      status: "verified",
      reason_codes: [],
    });
    expect(result.release_history).toEqual([
      expect.objectContaining({
        release_id: releaseThree.releaseId,
        revision: 3,
        intent: "change",
        status: "active_verified",
      }),
      expect.objectContaining({
        release_id: releaseTwo.releaseId,
        revision: 2,
        intent: "rollback",
        rollback_target_release_id: releaseOne.releaseId,
        status: "superseded",
      }),
      expect.objectContaining({
        release_id: releaseOne.releaseId,
        revision: 1,
        intent: "change",
        status: "superseded",
      }),
    ]);
    expect(result.release_history[0]).not.toHaveProperty("rollback_target_release_id");
    expect(result.release_history[2]).not.toHaveProperty("rollback_target_release_id");
    expect(result.events).toHaveLength(allEventKinds.length);
    expect(result.events.map((item) => [item.action, item.kind, item.status])).toEqual([
      ["packages.register", "registration", "registered"],
      ["deployments.preview", "preview", "previewed"],
      ["approvals.decide", "approval", "approved"],
      ["deployments.publish", "release", "active_verified"],
      ["deployments.publish", "reconciliation", "verified"],
      ["deployments.reconcile", "reconciliation", "mismatch"],
      ["deployments.publish", "idempotency", "completed"],
    ]);
  });

  it("maps rollback preview and reject approval without cross-branch fields", () => {
    const result = mapControlStateToDto(activeState({
      latestPreview: rollbackPreviewRecord,
      latestApproval: reject,
    }), inventory, MANAGEMENT_TENANT_ID);

    expect(result.latest_preview).toMatchObject({
      intent: "rollback",
      preview_ref: rollbackPreviewRecord.previewRef,
      target_release_id: releaseTwo.releaseId,
      consumed: false,
    });
    expect(result.latest_preview).not.toHaveProperty("inventory_refs");
    expect(result.latest_approval).toMatchObject({
      decision: "reject",
      consumed: false,
      preview_ref: rollbackPreviewRecord.previewRef,
    });
  });

  it.each(registrationTamperCases)(
    "rejects matched registration tampering in %s before redaction",
    (_field, tamper) => {
      const error = errorFrom(() => mapControlStateToDto(
        stateWithTamperedRegistration(tamper),
        inventory,
        MANAGEMENT_TENANT_ID,
      ));
      expect(error).toBeInstanceOf(ControlStateMapperError);
      expect(error).toMatchObject({
        code: "mapper_invalid",
        message: "mapper_invalid",
      });
    },
  );

  it("accepts repository-valid registration evidence refs that differ from current inventory and redacts them", () => {
    const result = mapControlStateToDto(activeState(), inventory, MANAGEMENT_TENANT_ID);

    expect(result.inventory_modules[0]?.registration).toEqual({
      registered_by_actor_ref: "actor_registration",
      registered_at: "2026-08-25T09:00:00Z",
    });
    expect(result.inventory_modules[0]).not.toHaveProperty("evidenceRefs");
    expect(JSON.stringify(result)).not.toContain("registration_secret");
  });

  it.each(approvalBindingTamperCases)(
    "rejects latest approval binding tampering in %s before redaction",
    (_field, tamper) => {
      const error = errorFrom(() => mapControlStateToDto(
        activeState({ latestApproval: tamper(approve) }),
        inventory,
        MANAGEMENT_TENANT_ID,
      ));
      expect(error).toBeInstanceOf(ControlStateMapperError);
      expect(error).toMatchObject({
        code: "mapper_invalid",
        message: "mapper_invalid",
      });
    },
  );

  it("accepts an order-independent valid approval binding and redacts its binding fields", () => {
    const result = mapControlStateToDto(activeState({
      latestApproval: {
        ...approve,
        inventoryDigestSet: [...approve.inventoryDigestSet].reverse(),
      },
    }), inventory, MANAGEMENT_TENANT_ID);

    expect(result.latest_approval).toEqual({
      approval_id: approve.approvalId,
      preview_ref: approve.previewRef,
      decision: "approve",
      reason_code: approve.reasonCode,
      approver_actor_ref: approve.approverActorRef,
      decided_at: approve.decidedAt,
      consumed: false,
    });
    for (const hiddenField of [
      "preview_canonical_hash",
      "base_release_id",
      "base_revision",
      "expires_at",
      "inventory_digest_set",
    ]) {
      expect(result.latest_approval).not.toHaveProperty(hiddenField);
    }
  });

  it("rejects event detail binding drift and extra hidden detail before redaction", () => {
    const mismatchedRecordRef = {
      ...allEventKinds[0]!,
      detail: {
        ...allEventKinds[0]!.detail,
        recordRef: "opaque_other_record",
      },
    } as unknown as ControlEventRecord;
    expectMapperCode(
      () => mapControlStateToDto(
        activeState({ events: [mismatchedRecordRef] }),
        inventory,
        MANAGEMENT_TENANT_ID,
      ),
      "mapper_invalid",
    );

    const extraHiddenDetail = {
      ...allEventKinds[0]!,
      detail: {
        ...allEventKinds[0]!.detail,
        hidden: "opaque_hidden_detail",
      },
    } as unknown as ControlEventRecord;
    expectMapperCode(
      () => mapControlStateToDto(
        activeState({ events: [extraHiddenDetail] }),
        inventory,
        MANAGEMENT_TENANT_ID,
      ),
      "mapper_invalid",
    );
  });

  it.each([
    ["detail status", (source: ControlEventRecord) => ({
      ...source,
      detail: { ...source.detail, status: "approved" },
    })],
    ["top-level action", (source: ControlEventRecord) => ({
      ...source,
      action: "deployments.preview",
    })],
    ["top-level kind", (source: ControlEventRecord) => ({
      ...source,
      kind: "preview",
    })],
  ] as const)(
    "rejects event detail binding drift in %s before redaction",
    (_label, tamper) => {
      expectMapperCode(
        () => mapControlStateToDto(
          activeState({ events: [tamper(allEventKinds[0]!) as unknown as ControlEventRecord] }),
          inventory,
          MANAGEMENT_TENANT_ID,
        ),
        "mapper_invalid",
      );
    },
  );

  it("rejects an over-depth plain-object event detail with a stable mapper input error", () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 70; index += 1) {
      nested = { nested };
    }
    const overDepthDetail = {
      ...allEventKinds[0]!,
      detail: {
        ...allEventKinds[0]!.detail,
        hidden: nested,
      },
    } as unknown as ControlEventRecord;

    expectMapperCode(
      () => mapControlStateToDto(
        activeState({ events: [overDepthDetail] }),
        inventory,
        MANAGEMENT_TENANT_ID,
      ),
      "mapper_input_invalid",
    );
  });

  it("maps all four release statuses while preserving a superseded module absent from current inventory", () => {
    const manualReadback: ModuleMismatchReadbackRecord = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      readbackRef: manualRelease.readbackRef,
      releaseId: manualRelease.releaseId,
      attemptId: "attempt_mismatch",
      revision: manualRelease.revision,
      appliedReleaseId: releaseThree.releaseId,
      appliedRevision: releaseThree.revision,
      appliedModules: [cargoRef],
      status: "mismatch",
      reasonCodes: [...manualRelease.reasonCodes],
      checkedAt: "2026-08-25T10:17:00Z",
    };
    const result = mapControlStateToDto(manualReviewState(manualReadback), inventory, MANAGEMENT_TENANT_ID);

    expect(result.release_history.map((entry) => entry.status)).toEqual([
      "manual_review",
      "active_verified",
      "superseded",
      "superseded",
    ]);
    expect(result.release_history.at(-1)?.desired_modules).toEqual([
      {
        module_id: legacyRef.moduleId,
        version: legacyRef.version,
        descriptor_digest: legacyRef.descriptorDigest,
      },
    ]);
    const pendingResult = mapControlStateToDto(pendingReleaseState(), inventory, MANAGEMENT_TENANT_ID);
    expect(pendingResult.release_history[0]).toMatchObject({
      release_id: "release_pending",
      status: "published_pending_readback",
      published_at: null,
      readback_ref: null,
      reason_codes: [],
      superseded_by_release_id: null,
    });
  });

  it("maps mismatch and unknown observations from applied activation fields and preserves digest drift", () => {
    const mismatch: ModuleMismatchReadbackRecord = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      readbackRef: manualRelease.readbackRef,
      releaseId: manualRelease.releaseId,
      attemptId: "attempt_mismatch",
      revision: manualRelease.revision,
      appliedReleaseId: releaseThree.releaseId,
      appliedRevision: releaseThree.revision,
      appliedModules: [driftedCargoRef],
      status: "mismatch",
      reasonCodes: ["runtime_readback_mismatch"],
      checkedAt: "2026-08-25T10:17:00Z",
    };
    const mismatchResult = mapControlStateToDto(manualReviewState(mismatch), inventory, MANAGEMENT_TENANT_ID);
    expect(mismatchResult.latest_readback).toMatchObject({
      status: "mismatch",
      observed_activation: {
        release_id: releaseThree.releaseId,
        revision: releaseThree.revision,
      },
      applied_modules: [{
        module_id: driftedCargoRef.moduleId,
        version: driftedCargoRef.version,
        descriptor_digest: driftedCargoRef.descriptorDigest,
      }],
    });

    const unknown: ModuleUnknownReadbackRecord = {
      ...mismatch,
      readbackRef: "readback_unknown",
      status: "unknown",
      appliedReleaseId: null,
      appliedRevision: null,
      appliedModules: [],
      reasonCodes: ["runtime_readback_unknown"],
    };
    const unknownResult = mapControlStateToDto(manualReviewState(unknown), inventory, MANAGEMENT_TENANT_ID);
    expect(unknownResult.latest_readback).toMatchObject({
      status: "unknown",
      observed_activation: { release_id: null, revision: null },
      applied_modules: [],
    });
  });

  it("rejects pending latest readback as a mapper-produced state", () => {
    const pendingReadback: ModulePendingReadbackRecord = {
      managementTenantId: MANAGEMENT_TENANT_ID,
      readbackRef: "readback_pending_legacy",
      releaseId: releaseThree.releaseId,
      revision: releaseThree.revision,
      appliedReleaseId: null,
      appliedRevision: null,
      appliedModules: [],
      status: "pending",
      reasonCodes: [],
      checkedAt: "2026-08-25T10:12:00Z",
    };

    expectMapperCode(
      () => mapControlStateToDto(activeState({ latestReadback: pendingReadback }), inventory, MANAGEMENT_TENANT_ID),
      "pending_latest_readback_not_producible",
    );
  });

  it("uses the repository-owned history and eventsTruncated projections independently", () => {
    const withoutEvents = mapControlStateToDto(activeState({ events: [] }), inventory, MANAGEMENT_TENANT_ID);
    const withEvents = mapControlStateToDto(activeState(), inventory, MANAGEMENT_TENANT_ID);
    expect(withoutEvents.release_history).toEqual(withEvents.release_history);
    expect(withoutEvents.events).toEqual([]);
    expect(withEvents.events).toHaveLength(allEventKinds.length);

    const truncatedEvents = repeatedEvents(256, 2);
    const truncated = mapControlStateToDto(activeState({
      events: truncatedEvents,
      eventsTruncated: true,
    }), inventory, MANAGEMENT_TENANT_ID);
    expect(truncated.events_truncated).toBe(true);
    expect(truncated.events).toHaveLength(256);
    expect(truncated.events[0]?.sequence).toBe(2);

    const notTruncated = mapControlStateToDto(activeState({
      events: [allEventKinds[0]!],
      eventsTruncated: false,
    }), inventory, MANAGEMENT_TENANT_ID);
    expect(notTruncated.events_truncated).toBe(false);
  });

  it("rejects more than 256 events through the producer assertion instead of truncating", () => {
    const error = errorFrom(() => mapControlStateToDto(activeState({
      events: repeatedEvents(257, 1),
      eventsTruncated: false,
    }), inventory, MANAGEMENT_TENANT_ID));

    expect(error).toBeInstanceOf(ControlContractError);
    expect((error as ControlContractError).code).toBe("control_contract_invalid");
  });

  it.each([
    ["true without a truncated window", repeatedEvents(256, 1), true, "truncated_event_window_invalid"],
    ["false for a window that starts after sequence one", repeatedEvents(256, 2), false, "event_window_origin_invalid"],
  ] as const)(
    "rejects invalid eventsTruncated semantics (%s) through the producer assertion",
    (_label, events, eventsTruncated, code) => {
      const error = errorFrom(() => mapControlStateToDto(activeState({
        events,
        eventsTruncated,
      }), inventory, MANAGEMENT_TENANT_ID));

      expect(error).toBeInstanceOf(ControlContractError);
      expect((error as ControlContractError).code).toBe(code);
    },
  );

  it("returns the detached deep-frozen assertion snapshot and never leaks sensitive or event-detail fields", () => {
    const state = activeState();
    const result = mapControlStateToDto(state, inventory, MANAGEMENT_TENANT_ID);

    expectDeepFrozen(result);
    expect(result.inventory_modules[0]).not.toHaveProperty("evidenceRefs");
    expect(result.events[0]).not.toHaveProperty("detail");
    const serialized = JSON.stringify(result);
    for (const secret of [
      "secret_source_sha",
      "registration_secret",
      "event_detail_secret",
      "https://event-detail.example.invalid",
      "operator@example.invalid",
      "secret-token",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    const originalRegistration = state.registrations[0]! as { registeredByActorRef: string };
    originalRegistration.registeredByActorRef = "mutated_after_mapping";
    expect(result.inventory_modules[0]?.registration?.registered_by_actor_ref).toBe("actor_registration");
    expect(result).not.toBe(state);
  });

  it("fails closed on tenant mismatch with a stable redacted mapper error", () => {
    expectMapperCode(
      () => mapControlStateToDto(
        activeState({ managementTenantId: "tenant_other_secret" }),
        inventory,
        MANAGEMENT_TENANT_ID,
      ),
      "management_tenant_mismatch",
    );
    const error = errorFrom(() => mapControlStateToDto(
      activeState({ managementTenantId: "tenant_other_secret" }),
      inventory,
      MANAGEMENT_TENANT_ID,
    )) as Error;
    expect(error.message).not.toContain("tenant_other_secret");
    expect(error.message).not.toContain(MANAGEMENT_TENANT_ID);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string primitive", "tenant_admin_secret"],
    ["number primitive", 7],
    ["boolean primitive", true],
    ["array", []],
  ] as const)(
    "rejects an invalid state root (%s) as mapper_input_invalid",
    (_label, invalidState) => {
      const error = errorFrom(() => mapControlStateToDto(
        invalidState as unknown as ModuleControlState,
        inventory,
        MANAGEMENT_TENANT_ID,
      ));
      expect(error).toBeInstanceOf(ControlStateMapperError);
      expect(error).toMatchObject({
        code: "mapper_input_invalid",
        message: "mapper_input_invalid",
      });
    },
  );

  it("rejects root/nested proxies, accessors and custom prototypes before invoking traps or getters", () => {
    let rootGet = 0;
    let rootOwnKeys = 0;
    const rootProxy = new Proxy(inactiveState(), {
      get() {
        rootGet += 1;
        throw new Error("root getter must not run");
      },
      ownKeys() {
        rootOwnKeys += 1;
        throw new Error("root ownKeys must not run");
      },
    });
    expectMapperCode(
      () => mapControlStateToDto(rootProxy, inventory, MANAGEMENT_TENANT_ID),
      "mapper_input_invalid",
    );
    expect(rootGet).toBe(0);
    expect(rootOwnKeys).toBe(0);

    let nestedGet = 0;
    let nestedOwnKeys = 0;
    const nestedProxy = new Proxy({}, {
      get() {
        nestedGet += 1;
        throw new Error("nested getter must not run");
      },
      ownKeys() {
        nestedOwnKeys += 1;
        throw new Error("nested ownKeys must not run");
      },
    });
    expectMapperCode(
      () => mapControlStateToDto(
        activeState({ latestPreview: nestedProxy as unknown as ModuleChangePreviewRecord }),
        inventory,
        MANAGEMENT_TENANT_ID,
      ),
      "mapper_input_invalid",
    );
    expect(nestedGet).toBe(0);
    expect(nestedOwnKeys).toBe(0);

    let getterCalls = 0;
    const getterState = inactiveState();
    Object.defineProperty(getterState, "managementTenantId", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return MANAGEMENT_TENANT_ID;
      },
    });
    expectMapperCode(
      () => mapControlStateToDto(getterState, inventory, MANAGEMENT_TENANT_ID),
      "mapper_input_invalid",
    );
    expect(getterCalls).toBe(0);

    const customPrototypeState = Object.create({ inherited: "not_allowed" }) as ModuleControlState;
    Object.assign(customPrototypeState, inactiveState());
    expectMapperCode(
      () => mapControlStateToDto(customPrototypeState, inventory, MANAGEMENT_TENANT_ID),
      "mapper_input_invalid",
    );

    const inventoryProxy = new Proxy(inventory, {
      get() {
        throw new Error("inventory getter must not run");
      },
      ownKeys() {
        throw new Error("inventory ownKeys must not run");
      },
    });
    expectMapperCode(
      () => mapControlStateToDto(inactiveState(), inventoryProxy, MANAGEMENT_TENANT_ID),
      "mapper_input_invalid",
    );
  });

  it("lets the existing semantic assertion reject contradictory active, readback and event projections", () => {
    const activeContradiction = errorFrom(() => mapControlStateToDto(
      activeState({
        activeRevision: 2,
        latestPreview: null,
        latestApproval: null,
      }),
      inventory,
      MANAGEMENT_TENANT_ID,
    ));
    expect(activeContradiction).toBeInstanceOf(ControlContractError);
    expect((activeContradiction as ControlContractError).code).toBe("active_history_not_activation");

    const verifiedDrift: ModuleVerifiedReadbackRecord = {
      ...verifiedReadback,
      appliedModules: [driftedCargoRef, containerRef],
    };
    const readbackContradiction = errorFrom(() => mapControlStateToDto(
      activeState({ latestReadback: verifiedDrift }),
      inventory,
      MANAGEMENT_TENANT_ID,
    ));
    expect(readbackContradiction).toBeInstanceOf(ControlContractError);
    expect((readbackContradiction as ControlContractError).code).toBe("module_identity_digest_conflict");

    const eventContradiction = errorFrom(() => mapControlStateToDto(
      activeState({ events: [allEventKinds[0]!, { ...allEventKinds[1]!, sequence: 3 }] }),
      inventory,
      MANAGEMENT_TENANT_ID,
    ));
    expect(eventContradiction).toBeInstanceOf(ControlContractError);
    expect((eventContradiction as ControlContractError).code).toBe("event_sequence_gap");
  });
});
