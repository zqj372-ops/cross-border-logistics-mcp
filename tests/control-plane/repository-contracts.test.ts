import { describe, expect, it } from "vitest";

import {
  CONTROL_IDEMPOTENCY_STATUSES,
  MODULE_READBACK_STATUSES,
  MODULE_RELEASE_STATUSES,
  ModuleControlRepositoryError,
  assertControlEventLifecycleCardinality,
  assertControlRequestBinding,
  assertModulePreviewAuthoritySemantics,
  assertPreviewHash,
  assertRequestHash,
  createControlEventLifecycleCounts,
  deepFreezeControlRecord,
  isPreviewHash,
  isRequestHash,
} from "../../src/logistics_mcp/control-plane/repository";
import type {
  CompletedModuleControlIdempotencyRecord,
  ControlIdempotencyEventMetadata,
  ControlEnvelope,
  ControlEventLifecycleCounts,
  ControlEventRecord,
  ControlFinalResult,
  ControlRequestMetadata,
  ModuleChangePreviewRecord,
  ModuleActiveVerifiedReleaseRecord,
  ModuleManualReviewReleaseRecord,
  ModuleControlRepository,
  ModuleControlReadbackAttemptRepository,
  ModuleControlRepositoryErrorCode,
  ModuleControlIdempotencyRecord,
  ModuleControlState,
  ModuleMismatchReadbackRecord,
  ModulePendingReadbackRecord,
  ModulePendingReleaseRecord,
  ModuleReleaseHistoryEntry,
  ModuleReleaseRecord,
  ModuleRegistrationRecord,
  ModuleRollbackPreviewRecord,
  ModuleVerifiedReadbackRecord,
  PublishReadbackRequestMetadata,
  RegisterModuleRequestMetadata,
  ReservedModuleControlIdempotencyRecord,
} from "../../src/logistics_mcp/control-plane/repository";

// @ts-expect-error repository must not export the removed readback operation type
import type { RecordReadbackRequest as LegacyReadbackRequestType } from "../../src/logistics_mcp/control-plane/repository";
// @ts-expect-error repository must not export the removed idempotency operation type
import type { CompleteControlIdempotencyRequest as LegacyIdempotencyRequestType } from "../../src/logistics_mcp/control-plane/repository";
// @ts-expect-error repository must not export the removed readback result type
import type { ReadbackWriteResult as LegacyReadbackResultType } from "../../src/logistics_mcp/control-plane/repository";

const useCaseMethodNames = [
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
] as const satisfies readonly (keyof ModuleControlRepository)[];

const lifecycleMethodNames = ["close"] as const satisfies readonly (keyof ModuleControlRepository)[];

const attemptMethodNames = [
  "claimReadbackAttempt",
  "finalizeReadbackAndComplete",
  "getUnfinishedReadbackAttempt",
  "listUnfinishedReadbackAttempts",
  "getReadbackAttemptHistory",
] as const satisfies readonly (keyof ModuleControlReadbackAttemptRepository)[];

const descriptorDigest = `sha256:${"b".repeat(64)}` as const;
const secondDescriptorDigest = `sha256:${"c".repeat(64)}` as const;
const requestHash =
  `mcp-control-hash/v1/request/sha256:${"a".repeat(64)}` as const;
const previewHash =
  `mcp-control-hash/v1/preview/sha256:${"d".repeat(64)}` as const;
const registrationRecordRef =
  `registration:cargo:1.0.0:${descriptorDigest}` as const;

const moduleRef = {
  moduleId: "cargo",
  version: "1.0.0",
  descriptorDigest,
} as const;

type LegacyOperationTypeChecks = [
  LegacyReadbackRequestType,
  LegacyIdempotencyRequestType,
  LegacyReadbackResultType,
];

const envelope = {
  schema_version: "2026-08-22.v1",
  request_id: "request_repository_contract_001",
  trace_id: "trace_repository_contract_001",
  audit_id: "audit_repository_contract_001",
  status: "success",
  data: {
    kind: "registration",
    module_id: "cargo",
    version: "1.0.0",
    descriptor_digest: descriptorDigest,
  },
  reason_codes: [],
  readback: { status: "not_applicable", release_id: null, revision: null },
} as const satisfies ControlEnvelope;

const registrationRecord = {
  managementTenantId: "tenant_demo",
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
  registeredByActorRef: "actor_operator",
  registeredAt: "2026-08-22T00:00:00Z",
} as const satisfies ModuleRegistrationRecord;

const registerEvent = {
  managementTenantId: "tenant_demo",
  eventId: "event_registration_001",
  sequence: 1,
  actorRef: "actor_operator",
  action: "packages.register",
  objectRef: registrationRecordRef,
  kind: "registration",
  status: "registered",
  reasonCodes: [],
  detail: {
    kind: "registration",
    recordRef: registrationRecordRef,
    moduleId: "cargo",
    version: "1.0.0",
    descriptorDigest,
    status: "registered",
  },
  occurredAt: "2026-08-22T00:00:00Z",
} as const satisfies ControlEventRecord;

const registerMetadata = {
  managementTenantId: "tenant_demo",
  actorRef: "actor_operator",
  action: "packages.register",
  idempotencyKey: "idem_repository_contract_001",
  requestHash,
  event: {
    action: "packages.register",
    objectRef: registrationRecordRef,
    kind: "registration",
    status: "registered",
    reasonCodes: [],
    detail: {
      kind: "registration",
      recordRef: registrationRecordRef,
      moduleId: "cargo",
      version: "1.0.0",
      descriptorDigest,
      status: "registered",
    },
  },
} as const satisfies RegisterModuleRequestMetadata;

const changePreview = {
  managementTenantId: "tenant_demo",
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
  creatorActorRef: "actor_operator",
  createdAt: "2026-08-22T00:00:00Z",
  expiresAt: "2026-08-22T01:00:00Z",
  consumed: false,
  intent: "change",
} as const satisfies ModuleChangePreviewRecord;

const verifiedReadback = {
  managementTenantId: "tenant_demo",
  readbackRef: "readback_release_001",
  releaseId: "release_001",
  revision: 1,
  appliedReleaseId: "release_001",
  appliedRevision: 1,
  appliedModules: [moduleRef],
  status: "verified",
  reasonCodes: [],
  checkedAt: "2026-08-22T00:00:00Z",
} as const satisfies ModuleVerifiedReadbackRecord;

const activeRelease = {
  managementTenantId: "tenant_demo",
  releaseId: "release_001",
  revision: 1,
  desiredModules: [moduleRef],
  previousReleaseId: null,
  previewRef: "preview_change_001",
  approvalId: "approval_001",
  publisherActorRef: "actor_publisher",
  createdAt: "2026-08-22T00:00:00Z",
  publishedAt: "2026-08-22T00:01:00Z",
  status: "active_verified",
  readbackRef: "readback_release_001",
  reasonCodes: [],
  supersededByReleaseId: null,
} as const satisfies ModuleActiveVerifiedReleaseRecord;

const finalResult = {
  domainRecordRef: registrationRecordRef,
  envelope,
} as const satisfies ControlFinalResult;

function captureRepositoryError(operation: () => unknown): ModuleControlRepositoryError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ModuleControlRepositoryError);
    return error as ModuleControlRepositoryError;
  }
  throw new Error("Expected ModuleControlRepositoryError.");
}

function stateWithHistory(
  overrides: Partial<ModuleControlState> = {},
): ModuleControlState {
  return {
    managementTenantId: "tenant_demo",
    activeRelease,
    activeRevision: activeRelease.revision,
    activeModules: activeRelease.desiredModules,
    registrations: [registrationRecord],
    latestPreview: changePreview,
    latestApproval: null,
    latestReadback: verifiedReadback,
    releaseHistory: [
      {
        release: activeRelease,
        intent: "change",
        rollbackTargetReleaseId: null,
      },
    ],
    events: [registerEvent],
    eventsTruncated: false,
    ...overrides,
  };
}

describe("module control repository contract", () => {
  it("exposes only narrow use-case methods and lifecycle methods without a generic write surface", () => {
    const unimplemented = async (): Promise<never> =>
      Promise.reject(new Error("contract-only implementation"));
    const repositoryContract: ModuleControlRepository = {
      health: () => Promise.resolve({ ready: false }),
      close: () => Promise.resolve(),
      registerModule: unimplemented,
      createPreview: unimplemented,
      decideApproval: unimplemented,
      publishRelease: unimplemented,
      getControlState: unimplemented,
      getActiveRelease: unimplemented,
      getPendingRelease: unimplemented,
      getNewestUnresolvedRelease: unimplemented,
      getPreview: unimplemented,
      getApproval: unimplemented,
      getRelease: unimplemented,
      getReadback: unimplemented,
      getIdempotency: unimplemented,
    };

    expect(useCaseMethodNames).toHaveLength(14);
    expect(lifecycleMethodNames).toEqual(["close"]);
    expect(Object.keys(repositoryContract)).toEqual([
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
    expect(useCaseMethodNames).not.toContain("put" as never);
    expect(useCaseMethodNames).not.toContain("get" as never);
  });

  it("shares SQLite event lifecycle cardinality across every authority action and status", () => {
    const authority = (
      action: ModuleControlIdempotencyRecord["action"],
      status: ModuleControlIdempotencyRecord["status"],
    ): ModuleControlIdempotencyRecord => {
      const common = {
        managementTenantId: "tenant_demo",
        action,
        idempotencyKey: `idem_lifecycle_${action.replace(".", "_")}_${status}`,
        requestHash,
        actorRef: "actor_operator",
        createdAt: "2026-08-22T00:00:00Z",
        expiresAt: "2026-08-23T00:00:00Z",
      } as const;
      if (status === "reserved") {
        return { ...common, status, domainRecordRef: null, finalResult: null };
      }
      if (status === "domain_committed") {
        return {
          ...common,
          status,
          domainRecordRef: registrationRecordRef,
          finalResult: null,
        };
      }
      return {
        ...common,
        status,
        domainRecordRef: registrationRecordRef,
        finalResult,
      };
    };
    const counts = (
      overrides: Partial<ControlEventLifecycleCounts> = {},
    ): ControlEventLifecycleCounts => ({
      ...createControlEventLifecycleCounts(),
      ...overrides,
    });
    const accepted = [
      {
        label: "reserved authority has no events",
        record: authority("packages.register", "reserved"),
        counts: counts(),
      },
      {
        label: "registration has one domain event",
        record: authority("packages.register", "completed"),
        counts: counts({ registration: 1 }),
      },
      {
        label: "simple completed registration may retain one completion event",
        record: authority("packages.register", "completed"),
        counts: counts({ registration: 1, completion: 1 }),
      },
      {
        label: "preview has one domain event",
        record: authority("deployments.preview", "completed"),
        counts: counts({ preview: 1 }),
      },
      {
        label: "approval has one domain event",
        record: authority("approvals.decide", "completed"),
        counts: counts({ approval: 1 }),
      },
      {
        label: "publish may await readback",
        record: authority("deployments.publish", "domain_committed"),
        counts: counts({ release: 1 }),
      },
      {
        label: "publish may include one readback before completion",
        record: authority("deployments.publish", "domain_committed"),
        counts: counts({ release: 1, reconciliation: 1 }),
      },
      {
        label: "completed publish has release readback and completion",
        record: authority("deployments.publish", "completed"),
        counts: counts({ release: 1, reconciliation: 1, completion: 1 }),
      },
      {
        label: "reconcile has one readback observation",
        record: authority("deployments.reconcile", "domain_committed"),
        counts: counts({ reconciliation: 1 }),
      },
      {
        label: "completed reconcile has readback and completion",
        record: authority("deployments.reconcile", "completed"),
        counts: counts({ reconciliation: 1, completion: 1 }),
      },
    ] as const;
    const rejected = [
      {
        label: "reserved authority has a domain event",
        record: authority("packages.register", "reserved"),
        counts: counts({ registration: 1 }),
      },
      {
        label: "registration is duplicated",
        record: authority("packages.register", "completed"),
        counts: counts({ registration: 2 }),
      },
      {
        label: "registration has another role",
        record: authority("packages.register", "completed"),
        counts: counts({ registration: 1, preview: 1 }),
      },
      {
        label: "preview is duplicated",
        record: authority("deployments.preview", "completed"),
        counts: counts({ preview: 2 }),
      },
      {
        label: "approval is duplicated",
        record: authority("approvals.decide", "completed"),
        counts: counts({ approval: 2 }),
      },
      {
        label: "publish omits its release",
        record: authority("deployments.publish", "domain_committed"),
        counts: counts(),
      },
      {
        label: "publish duplicates its release",
        record: authority("deployments.publish", "domain_committed"),
        counts: counts({ release: 2 }),
      },
      {
        label: "publish duplicates readback",
        record: authority("deployments.publish", "domain_committed"),
        counts: counts({ release: 1, reconciliation: 2 }),
      },
      {
        label: "completed publish omits readback",
        record: authority("deployments.publish", "completed"),
        counts: counts({ release: 1, completion: 1 }),
      },
      {
        label: "completed publish omits completion",
        record: authority("deployments.publish", "completed"),
        counts: counts({ release: 1, reconciliation: 1 }),
      },
      {
        label: "reconcile duplicates readback",
        record: authority("deployments.reconcile", "domain_committed"),
        counts: counts({ reconciliation: 2 }),
      },
      {
        label: "reconcile carries a release event",
        record: authority("deployments.reconcile", "domain_committed"),
        counts: counts({ release: 1, reconciliation: 1 }),
      },
      {
        label: "completed reconcile omits completion",
        record: authority("deployments.reconcile", "completed"),
        counts: counts({ reconciliation: 1 }),
      },
      {
        label: "domain committed authority has completion",
        record: authority("deployments.publish", "domain_committed"),
        counts: counts({ release: 1, completion: 1 }),
      },
      {
        label: "completion is duplicated",
        record: authority("deployments.publish", "completed"),
        counts: counts({ release: 1, reconciliation: 1, completion: 2 }),
      },
    ] as const;

    for (const testCase of accepted) {
      expect(
        () => assertControlEventLifecycleCardinality(testCase.record, testCase.counts),
        testCase.label,
      ).not.toThrow();
    }
    for (const testCase of rejected) {
      expect(
        () => assertControlEventLifecycleCardinality(testCase.record, testCase.counts),
        testCase.label,
      ).toThrow(ModuleControlRepositoryError);
    }
  });

  it("binds action, tenant, actor, request hash, and preview refs at runtime", () => {
    expect(() =>
      assertControlRequestBinding({
        metadata: registerMetadata,
        record: registrationRecord,
      }),
    ).not.toThrow();

    expect(() =>
      assertControlRequestBinding({
        metadata: { ...registerMetadata, action: "deployments.preview" } as never,
        record: registrationRecord,
      }),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      assertControlRequestBinding({
        metadata: { ...registerMetadata, managementTenantId: "tenant_other" },
        record: registrationRecord,
      }),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      assertControlRequestBinding({
        metadata: registerMetadata,
        record: { ...registrationRecord, registeredByActorRef: "actor_other" },
      }),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      assertControlRequestBinding({
        metadata: {
          ...registerMetadata,
          requestHash: `mcp-control-hash/v1/preview/sha256:${"a".repeat(64)}`,
        } as never,
        record: registrationRecord,
      }),
    ).toThrow(ModuleControlRepositoryError);

    const previewMetadata: ControlRequestMetadata = {
      managementTenantId: "tenant_demo",
      actorRef: "actor_operator",
      action: "deployments.preview",
      idempotencyKey: "idem_preview_001",
      requestHash,
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
    };

    expect(() =>
      assertControlRequestBinding({ metadata: previewMetadata, record: changePreview }),
    ).not.toThrow();
    expect(() =>
      assertControlRequestBinding({
        metadata: {
          ...previewMetadata,
          event: {
            ...previewMetadata.event,
            detail: { ...previewMetadata.event.detail, previewRef: "preview_other" },
          },
        },
        record: changePreview,
      }),
    ).toThrow(ModuleControlRepositoryError);
  });

  it("uses only the locked repository state values", () => {
    expect(CONTROL_IDEMPOTENCY_STATUSES).toEqual([
      "reserved",
      "domain_committed",
      "completed",
    ]);
    expect(MODULE_RELEASE_STATUSES).toEqual([
      "published_pending_readback",
      "manual_review",
      "active_verified",
      "superseded",
    ]);
    expect(MODULE_READBACK_STATUSES).toEqual([
      "pending",
      "verified",
      "mismatch",
      "unknown",
    ]);
    expect(Object.isFrozen(CONTROL_IDEMPOTENCY_STATUSES)).toBe(true);
    expect(Object.isFrozen(MODULE_RELEASE_STATUSES)).toBe(true);
    expect(Object.isFrozen(MODULE_READBACK_STATUSES)).toBe(true);
  });

  it("validates request and preview hash domains with exactly 64 lowercase hex characters", () => {
    expect(isRequestHash(requestHash)).toBe(true);
    expect(isPreviewHash(previewHash)).toBe(true);
    expect(isRequestHash(previewHash)).toBe(false);
    expect(isPreviewHash(requestHash)).toBe(false);
    expect(isRequestHash(`mcp-control-hash/v1/request/sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isPreviewHash(`mcp-control-hash/v1/preview/sha256:${"a".repeat(63)}`)).toBe(false);
    expect(() => assertRequestHash(previewHash)).toThrow(ModuleControlRepositoryError);
    expect(() => assertPreviewHash(requestHash)).toThrow(ModuleControlRepositoryError);
  });

  it("keeps failures stable and does not accept caller-supplied messages", () => {
    const codes: readonly ModuleControlRepositoryErrorCode[] = [
      "closed",
      "conflict",
      "invalid_state",
      "not_found",
      "tenant_mismatch",
    ];

    for (const code of codes) {
      const error = new ModuleControlRepositoryError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ModuleControlRepositoryError);
      expect(error.name).toBe("ModuleControlRepositoryError");
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("secret");
    }

    const invalidCode = new ModuleControlRepositoryError("__proto__" as never);
    expect(invalidCode.code).toBe("invalid_state");
    expect(invalidCode.message).toBe(
      "The module control record is invalid.",
    );
    expect(() =>
      Reflect.set(invalidCode, "code", "conflict"),
    ).not.toThrow();
    expect(invalidCode.code).toBe("invalid_state");
  });

  it("deep-clones and recursively freezes a valid control record", () => {
    const source = {
      managementTenantId: "tenant_demo",
      activeRelease,
      activeRevision: 1,
      activeModules: [
        {
          moduleId: "cargo" as string,
          version: "1.0.0" as string,
          descriptorDigest,
        },
      ],
      registrations: [registrationRecord],
      latestPreview: changePreview,
      latestApproval: null,
      latestReadback: verifiedReadback,
      releaseHistory: [
        {
          release: activeRelease,
          intent: "change",
          rollbackTargetReleaseId: null,
        } satisfies ModuleReleaseHistoryEntry,
      ],
      events: [
        {
          ...registerEvent,
          reasonCodes: [...registerEvent.reasonCodes],
          detail: {
            ...registerEvent.detail,
            moduleId: "cargo" as string,
          },
        },
      ],
      eventsTruncated: false,
    };

    const frozen = deepFreezeControlRecord(source as ModuleControlState);
    const reorderedState = {
      ...source,
      activeModules: [
        {
          descriptorDigest,
          version: "1.0.0",
          moduleId: "cargo",
        },
      ],
    };
    expect(() =>
      deepFreezeControlRecord(reorderedState as ModuleControlState),
    ).not.toThrow();

    source.activeModules[0]!.moduleId = "changed";
    source.activeModules.push({
      moduleId: "container",
      version: "1.0.0",
      descriptorDigest: secondDescriptorDigest,
    });
    source.events[0]!.detail.moduleId = "changed";

    expect(frozen.activeModules).toHaveLength(1);
    expect(frozen.activeModules[0]!.moduleId).toBe("cargo");
    expect(frozen.events[0]!.detail.moduleId).toBe("cargo");
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.activeModules)).toBe(true);
    expect(Object.isFrozen(frozen.activeModules[0])).toBe(true);
    expect(Object.isFrozen(frozen.events)).toBe(true);
    expect(Object.isFrozen(frozen.events[0]!.detail)).toBe(true);
    expect(() =>
      (frozen.activeModules as unknown as Array<typeof frozen.activeModules[number]>).push(
        frozen.activeModules[0]!,
      ),
    ).toThrow();
  });

  it("rejects proxies and non-standard prototypes before reflecting input", () => {
    const proxy = new Proxy(registrationRecord, {});
    expect(() => deepFreezeControlRecord(proxy)).toThrow(
      ModuleControlRepositoryError,
    );

    const nullPrototype = Object.assign(
      Object.create(null) as Record<string, unknown>,
      registrationRecord,
    );
    expect(() => deepFreezeControlRecord(nullPrototype as never)).toThrow(
      ModuleControlRepositoryError,
    );

    const customPrototype = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      registrationRecord,
    );
    expect(() => deepFreezeControlRecord(customPrototype as never)).toThrow(
      ModuleControlRepositoryError,
    );
  });

  it("asserts bounded history identity, linkage, status cardinality, and rollback targets", () => {
    const valid = stateWithHistory();
    expect(() => deepFreezeControlRecord(valid)).not.toThrow();

    const duplicateId = structuredClone(valid);
    Reflect.set(duplicateId, "releaseHistory", [
      ...valid.releaseHistory,
      structuredClone(valid.releaseHistory[0]),
    ]);
    expect(() => deepFreezeControlRecord(duplicateId)).toThrow(
      ModuleControlRepositoryError,
    );

    const olderRelease = {
      ...activeRelease,
      releaseId: "release_000",
      revision: 1,
      status: "superseded",
      supersededByReleaseId: "release_002",
    } as const;
    const newerRelease = {
      ...activeRelease,
      releaseId: "release_002",
      revision: 2,
      previousReleaseId: olderRelease.releaseId,
      previewRef: "preview_change_002",
      readbackRef: "readback_release_002",
    } as const;
    const chain = stateWithHistory({
      activeRelease: newerRelease,
      activeRevision: newerRelease.revision,
      activeModules: newerRelease.desiredModules,
      latestReadback: {
        ...verifiedReadback,
        releaseId: newerRelease.releaseId,
        readbackRef: newerRelease.readbackRef,
        revision: newerRelease.revision,
        appliedReleaseId: newerRelease.releaseId,
        appliedRevision: newerRelease.revision,
      },
      releaseHistory: [
        {
          release: newerRelease,
          intent: "change",
          rollbackTargetReleaseId: null,
        },
        {
          release: olderRelease,
          intent: "change",
          rollbackTargetReleaseId: null,
        },
      ],
    });
    expect(() => deepFreezeControlRecord(chain)).not.toThrow();

    const gap = structuredClone(chain);
    const gapOlder = gap.releaseHistory[1]!.release;
    const gapNewer = { ...gap.releaseHistory[0]!.release, revision: 3 };
    Reflect.set(gap, "releaseHistory", [
      { ...gap.releaseHistory[0]!, release: gapNewer },
      { ...gap.releaseHistory[1]!, release: gapOlder },
    ]);
    Reflect.set(gap, "activeRelease", gapNewer);
    Reflect.set(gap, "activeRevision", gapNewer.revision);
    expect(() => deepFreezeControlRecord(gap)).toThrow(
      ModuleControlRepositoryError,
    );

    const brokenPrevious = structuredClone(chain);
    const brokenNewer = {
      ...brokenPrevious.releaseHistory[0]!.release,
      previousReleaseId: "release_missing_previous",
    };
    Reflect.set(brokenPrevious, "releaseHistory", [
      { ...brokenPrevious.releaseHistory[0]!, release: brokenNewer },
      brokenPrevious.releaseHistory[1]!,
    ]);
    Reflect.set(brokenPrevious, "activeRelease", brokenNewer);
    expect(() => deepFreezeControlRecord(brokenPrevious)).toThrow(
      ModuleControlRepositoryError,
    );

    const twoActive = structuredClone(chain);
    Reflect.set(twoActive, "releaseHistory", [
      twoActive.releaseHistory[0]!,
      { ...twoActive.releaseHistory[1]!, release: { ...olderRelease, status: "active_verified", supersededByReleaseId: null } },
    ]);
    expect(() => deepFreezeControlRecord(twoActive)).toThrow(
      ModuleControlRepositoryError,
    );

    const twoUnresolved = stateWithHistory({
      activeRelease: null,
      activeRevision: 0,
      activeModules: [],
      latestPreview: null,
      latestReadback: null,
      releaseHistory: [
        {
          release: {
            ...newerRelease,
            status: "published_pending_readback",
            readbackRef: null,
            reasonCodes: [],
            supersededByReleaseId: null,
          } satisfies ModulePendingReleaseRecord,
          intent: "change",
          rollbackTargetReleaseId: null,
        },
        {
          release: {
            ...olderRelease,
            status: "manual_review",
            readbackRef: "readback_release_000",
            reasonCodes: ["runtime.unknown"],
            supersededByReleaseId: null,
          } satisfies ModuleManualReviewReleaseRecord,
          intent: "change",
          rollbackTargetReleaseId: null,
        },
      ],
    });
    expect(() => deepFreezeControlRecord(twoUnresolved)).toThrow(
      ModuleControlRepositoryError,
    );

    const orderDrift = structuredClone(chain);
    Reflect.set(orderDrift, "releaseHistory", [
      orderDrift.releaseHistory[1]!,
      orderDrift.releaseHistory[0]!,
    ]);
    expect(() => deepFreezeControlRecord(orderDrift)).toThrow(
      ModuleControlRepositoryError,
    );

    const tenantDrift = stateWithHistory({
      releaseHistory: [{
        release: { ...activeRelease, managementTenantId: "tenant_other" },
        intent: "change",
        rollbackTargetReleaseId: null,
      }],
    });
    expect(() => deepFreezeControlRecord(tenantDrift)).toThrow(
      ModuleControlRepositoryError,
    );

    const rollbackInWindow = structuredClone(chain);
    Reflect.set(rollbackInWindow, "latestPreview", {
      ...changePreview,
      previewRef: newerRelease.previewRef,
      intent: "rollback",
      targetReleaseId: olderRelease.releaseId,
    } satisfies ModuleRollbackPreviewRecord);
    Reflect.set(rollbackInWindow, "releaseHistory", [
      {
        ...rollbackInWindow.releaseHistory[0]!,
        intent: "rollback",
        rollbackTargetReleaseId: olderRelease.releaseId,
      },
      rollbackInWindow.releaseHistory[1]!,
    ]);
    expect(() => deepFreezeControlRecord(rollbackInWindow)).not.toThrow();

    const rollbackOutsideWindow = structuredClone(rollbackInWindow);
    Reflect.set(rollbackOutsideWindow, "latestPreview", {
      ...rollbackOutsideWindow.latestPreview!,
      targetReleaseId: "release_opaque_outside_window",
    });
    Reflect.set(rollbackOutsideWindow.releaseHistory, 0, {
      ...rollbackOutsideWindow.releaseHistory[0]!,
      rollbackTargetReleaseId: "release_opaque_outside_window",
    });
    expect(() => deepFreezeControlRecord(rollbackOutsideWindow)).not.toThrow();

    const rollbackToNewer = structuredClone(chain);
    Reflect.set(rollbackToNewer.releaseHistory, 1, {
      ...rollbackToNewer.releaseHistory[1]!,
      intent: "rollback",
      rollbackTargetReleaseId: newerRelease.releaseId,
    });
    expect(() => deepFreezeControlRecord(rollbackToNewer)).toThrow(
      ModuleControlRepositoryError,
    );

    const intentDrift = structuredClone(valid);
    Reflect.set(intentDrift.releaseHistory, 0, {
      ...intentDrift.releaseHistory[0]!,
      intent: "rollback",
      rollbackTargetReleaseId: "release_opaque_target",
    });
    expect(() => deepFreezeControlRecord(intentDrift)).toThrow(
      ModuleControlRepositoryError,
    );
  });

  it.each([
    {
      label: "same revision",
      target: "release_002",
      targetRevision: 2,
      inHistory: true,
    },
    {
      label: "newer revision",
      target: "release_003",
      targetRevision: 3,
      inHistory: true,
    },
    {
      label: "existing target outside the bounded window",
      target: "release_000",
      targetRevision: 0,
      inHistory: false,
    },
  ])("rejects a rollback preview with a $label target", ({ target, targetRevision, inHistory }) => {
    const baseRelease = {
      ...activeRelease,
      releaseId: "release_002",
      revision: 2,
      previousReleaseId: "release_001",
      previewRef: "preview_change_002",
      approvalId: "approval_002",
    } as const satisfies ModuleActiveVerifiedReleaseRecord;
    const targetRelease = {
      ...baseRelease,
      releaseId: target,
      revision: targetRevision,
      status: "superseded",
      supersededByReleaseId: baseRelease.releaseId,
    } as const satisfies ModuleReleaseRecord;
    const preview = {
      ...changePreview,
      previewRef: "preview_rollback_authority",
      baseReleaseId: baseRelease.releaseId,
      baseRevision: baseRelease.revision,
      desiredModules: baseRelease.desiredModules,
      diff: { added: [], removed: [], retained: baseRelease.desiredModules },
      intent: "rollback",
      targetReleaseId: targetRelease.releaseId,
    } as const satisfies ModuleRollbackPreviewRecord;
    const history = [
      { release: baseRelease, intent: "change" as const, rollbackTargetReleaseId: null },
      ...(inHistory
        ? [{ release: targetRelease, intent: "change" as const, rollbackTargetReleaseId: null }]
        : []),
    ] as const satisfies readonly ModuleReleaseHistoryEntry[];

    expect(() => assertModulePreviewAuthoritySemantics(
      preview,
      baseRelease,
      targetRelease,
      history,
    )).toThrow(ModuleControlRepositoryError);
  });

  it("accepts a rollback preview only when its target is an older bounded release", () => {
    const baseRelease = {
      ...activeRelease,
      releaseId: "release_002",
      revision: 2,
      previousReleaseId: "release_001",
      previewRef: "preview_change_002",
      approvalId: "approval_002",
    } as const satisfies ModuleActiveVerifiedReleaseRecord;
    const targetRelease = {
      ...activeRelease,
      releaseId: "release_001",
      revision: 1,
      status: "superseded",
      supersededByReleaseId: baseRelease.releaseId,
    } as const satisfies ModuleReleaseRecord;
    const preview = {
      ...changePreview,
      previewRef: "preview_rollback_authority_valid",
      baseReleaseId: baseRelease.releaseId,
      baseRevision: baseRelease.revision,
      desiredModules: targetRelease.desiredModules,
      diff: { added: [], removed: [], retained: targetRelease.desiredModules },
      intent: "rollback",
      targetReleaseId: targetRelease.releaseId,
    } as const satisfies ModuleRollbackPreviewRecord;

    expect(() => assertModulePreviewAuthoritySemantics(
      preview,
      baseRelease,
      targetRelease,
      [
        { release: baseRelease, intent: "change", rollbackTargetReleaseId: null },
        { release: targetRelease, intent: "change", rollbackTargetReleaseId: null },
      ],
    )).not.toThrow();
  });

  it("requires a truthful bounded event window flag and continuous sequence", () => {
    const valid = stateWithHistory();
    const fullWindow = Array.from({ length: 256 }, (_, index) => ({
      ...registerEvent,
      eventId: `event_window_${index + 1}`,
      sequence: index + 1,
    }));
    expect(() => deepFreezeControlRecord({
      ...valid,
      events: fullWindow,
      eventsTruncated: false,
    })).not.toThrow();
    expect(() => deepFreezeControlRecord({
      ...valid,
      events: fullWindow,
      eventsTruncated: true,
    })).toThrow(ModuleControlRepositoryError);

    const truncatedWindow = fullWindow.map((event, index) => ({
      ...event,
      eventId: `event_truncated_${index + 1}`,
      sequence: index + 2,
    }));
    expect(() => deepFreezeControlRecord({
      ...valid,
      events: truncatedWindow,
      eventsTruncated: true,
    })).not.toThrow();
    expect(() => deepFreezeControlRecord({
      ...valid,
      events: [truncatedWindow[0]!, truncatedWindow[2]!],
      eventsTruncated: true,
    })).toThrow(ModuleControlRepositoryError);

    const offsetEquivalent = [
      {
        ...registerEvent,
        eventId: "event_offset_1",
        sequence: 1,
        occurredAt: "2026-08-22T00:00:00.000000001Z",
      },
      {
        ...registerEvent,
        eventId: "event_offset_2",
        sequence: 2,
        occurredAt: "2026-08-21T19:00:00.000000001-05:00",
      },
    ];
    expect(() => deepFreezeControlRecord({
      ...valid,
      events: offsetEquivalent,
      eventsTruncated: false,
    })).not.toThrow();

    expect(() => deepFreezeControlRecord({
      ...valid,
      events: [
        { ...offsetEquivalent[0]!, occurredAt: "2026-08-22T00:00:00.000000002Z" },
        { ...offsetEquivalent[1]!, occurredAt: "2026-08-22T00:00:00.000000001Z" },
      ],
      eventsTruncated: false,
    })).toThrow(ModuleControlRepositoryError);
  });

  it("rejects exotic values, sparse arrays, accessors, cycles, and non-finite primitives without invoking getters", () => {
    const rejected = [new Map(), new Set(), new Date(), new Uint8Array([1])];
    for (const value of rejected) {
      expect(() => deepFreezeControlRecord(value as never)).toThrow(ModuleControlRepositoryError);
    }

    const sparse = { ...registrationRecord, evidenceRefs: new Array(1) } as never;
    expect(() => deepFreezeControlRecord(sparse)).toThrow(ModuleControlRepositoryError);

    let getterCalls = 0;
    const accessorRecord = { ...registrationRecord } as Record<string, unknown>;
    Object.defineProperty(accessorRecord, "moduleId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "cargo";
      },
    });
    expect(() => deepFreezeControlRecord(accessorRecord as never)).toThrow(
      ModuleControlRepositoryError,
    );
    expect(getterCalls).toBe(0);

    const cyclic = { ...registrationRecord } as { self?: unknown } & typeof registrationRecord;
    cyclic.self = cyclic;
    expect(() => deepFreezeControlRecord(cyclic as never)).toThrow(ModuleControlRepositoryError);

    expect(() =>
      deepFreezeControlRecord({
        ...registrationRecord,
        moduleId: Number.POSITIVE_INFINITY,
      } as never),
    ).toThrow(ModuleControlRepositoryError);
  });

  it("uses closed final results and discriminated status records", () => {
    const completed: CompletedModuleControlIdempotencyRecord = {
      managementTenantId: "tenant_demo",
      action: "packages.register",
      idempotencyKey: "idem_repository_contract_001",
      requestHash,
      actorRef: "actor_operator",
      status: "completed",
      domainRecordRef: registrationRecordRef,
      finalResult,
      createdAt: "2026-08-22T00:00:00Z",
      expiresAt: "2026-08-23T00:00:00Z",
    };
    expect(completed.finalResult.envelope.status).toBe("success");

    const reserved: ReservedModuleControlIdempotencyRecord = {
      ...completed,
      status: "reserved",
      domainRecordRef: null,
      finalResult: null,
    };
    expect(reserved.finalResult).toBeNull();

    const mismatch: ModuleMismatchReadbackRecord = {
      ...verifiedReadback,
      status: "mismatch",
      appliedReleaseId: null,
      appliedRevision: null,
      appliedModules: [],
      reasonCodes: ["readback.release_mismatch"],
    };
    expect(mismatch.reasonCodes).toHaveLength(1);

    const malformed = {
      ...completed,
      finalResult: { ...finalResult, arbitrary: "must-not-be-stored" },
    } as never;
    expect(() => deepFreezeControlRecord(malformed)).toThrow(ModuleControlRepositoryError);
  });

  it("orders preview TTL timestamps at RFC3339 nanosecond precision", () => {
    const precisePreview: ModuleChangePreviewRecord = {
      ...changePreview,
      createdAt: "2026-08-22T00:00:00.000000001Z",
      expiresAt: "2026-08-22T00:00:00.000000002Z",
    };
    const frozen = deepFreezeControlRecord(precisePreview);
    expect(frozen.createdAt).toBe("2026-08-22T00:00:00.000000001Z");
    expect(frozen.expiresAt).toBe("2026-08-22T00:00:00.000000002Z");

    for (const expiresAt of [
      "2026-08-22T01:00:00.000000001+01:00",
      "2026-08-22T00:00:00Z",
    ]) {
      const error = captureRepositoryError(() =>
        deepFreezeControlRecord({ ...precisePreview, expiresAt }),
      );
      expect(error.code).toBe("invalid_state");
    }
  });

  it("orders idempotency TTL timestamps at RFC3339 nanosecond precision", () => {
    const preciseIdempotency: ReservedModuleControlIdempotencyRecord = {
      managementTenantId: "tenant_demo",
      action: "packages.register",
      idempotencyKey: "idem_repository_nanosecond_001",
      requestHash,
      actorRef: "actor_operator",
      status: "reserved",
      domainRecordRef: null,
      finalResult: null,
      createdAt: "2026-08-22T00:00:00.000000001Z",
      expiresAt: "2026-08-22T00:00:00.000000002Z",
    };
    const frozen = deepFreezeControlRecord(preciseIdempotency);
    expect(frozen.createdAt).toBe("2026-08-22T00:00:00.000000001Z");
    expect(frozen.expiresAt).toBe("2026-08-22T00:00:00.000000002Z");

    for (const expiresAt of [
      "2026-08-21T19:00:00.000000001-05:00",
      "2026-08-22T00:00:00Z",
      "invalid",
    ]) {
      const error = captureRepositoryError(() =>
        deepFreezeControlRecord({ ...preciseIdempotency, expiresAt } as never),
      );
      expect(error.code).toBe("invalid_state");
    }
  });

  it("fails closed for forged evidence, impossible release/readback states, and unknown actions", () => {
    expect(() =>
      deepFreezeControlRecord({
        ...registrationRecord,
        descriptorDigest: "not-a-digest",
        evidenceLevel: "verified_release",
        productionEligible: true,
      } as never),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      deepFreezeControlRecord({
        ...activeRelease,
        publishedAt: null,
      } as never),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      deepFreezeControlRecord({
        ...activeRelease,
        status: "manual_review",
        publishedAt: null,
        reasonCodes: ["runtime.unavailable"],
      } as never),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      deepFreezeControlRecord({
        ...activeRelease,
        status: "superseded",
        publishedAt: null,
        supersededByReleaseId: "release_002",
      } as never),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      deepFreezeControlRecord({
        ...activeRelease,
        status: "published_pending_readback",
        publishedAt: null,
        readbackRef: null,
      } as never),
    ).not.toThrow();

    expect(() =>
      deepFreezeControlRecord({
        managementTenantId: "tenant_demo",
        releaseId: "release_001",
        revision: -1,
        desiredModules: [moduleRef],
        previousReleaseId: null,
        previewRef: "preview_change_001",
        approvalId: "approval_001",
        publisherActorRef: "actor_publisher",
        createdAt: "2026-08-22T00:00:00Z",
        publishedAt: "2026-08-22T00:01:00Z",
        status: "active_verified",
        readbackRef: null,
        reasonCodes: ["forged"],
        supersededByReleaseId: "release_002",
      } as never),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      deepFreezeControlRecord({
        ...verifiedReadback,
        status: "pending",
        appliedReleaseId: "release_001",
        appliedRevision: 1,
      } as never),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      assertControlRequestBinding({
        metadata: {
          ...registerMetadata,
          action: "evil.action",
          event: { ...registerMetadata.event, action: "evil.action" },
        } as never,
        record: registrationRecord,
      }),
    ).toThrow(ModuleControlRepositoryError);
  });

  it("requires every published release instant to be at or after creation", () => {
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
      const operation = () => deepFreezeControlRecord({
        ...activeRelease,
        createdAt: testCase.createdAt,
        publishedAt: testCase.publishedAt,
      });
      if (testCase.accepted) {
        expect(operation(), testCase.label).toBeDefined();
      } else {
        expect(operation, testCase.label).toThrow(ModuleControlRepositoryError);
      }
    }

    expect(() => deepFreezeControlRecord({
      ...activeRelease,
      status: "published_pending_readback",
      publishedAt: null,
      readbackRef: null,
      reasonCodes: [],
      supersededByReleaseId: null,
    })).not.toThrow();
  });

  it("accepts the closed publish-readback and idempotency-completion bindings", () => {
    const pendingReadback: ModulePendingReadbackRecord = {
      managementTenantId: "tenant_demo",
      readbackRef: "readback_release_001",
      releaseId: "release_001",
      revision: 1,
      appliedReleaseId: null,
      appliedRevision: null,
      appliedModules: [],
      status: "pending",
      reasonCodes: [],
      checkedAt: "2026-08-22T00:02:00Z",
    };
    const publishReadbackMetadata: PublishReadbackRequestMetadata = {
      managementTenantId: "tenant_demo",
      actorRef: "actor_publisher",
      action: "deployments.publish",
      idempotencyKey: "idem_publish_001",
      requestHash,
      event: {
        action: "deployments.publish",
        objectRef: "release_001",
        kind: "reconciliation",
        status: "pending",
        reasonCodes: [],
        detail: {
          kind: "reconciliation",
          releaseId: "release_001",
          revision: 1,
          readbackRef: "readback_release_001",
          status: "pending",
        },
      },
    };
    expect(() =>
      assertControlRequestBinding({
        metadata: publishReadbackMetadata,
        record: pendingReadback,
      }),
    ).not.toThrow();

    const completedRegistration: CompletedModuleControlIdempotencyRecord = {
      managementTenantId: "tenant_demo",
      action: "packages.register",
      idempotencyKey: "idem_repository_contract_001",
      requestHash,
      actorRef: "actor_operator",
      status: "completed",
      domainRecordRef: registrationRecordRef,
      finalResult: {
        domainRecordRef: registrationRecordRef,
        envelope,
      },
      createdAt: "2026-08-22T00:00:00Z",
      expiresAt: "2026-08-23T00:00:00Z",
    };
    const completionMetadata: ControlIdempotencyEventMetadata = {
      managementTenantId: "tenant_demo",
      actorRef: "actor_operator",
      action: "packages.register",
      idempotencyKey: "idem_repository_contract_001",
      requestHash,
      event: {
        action: "packages.register",
        objectRef: "idempotency:packages.register:idem_repository_contract_001",
        kind: "idempotency",
        status: "completed",
        reasonCodes: [],
        detail: {
          kind: "idempotency",
          recordRef: "idempotency:packages.register:idem_repository_contract_001",
          domainRecordRef: registrationRecordRef,
          status: "completed",
        },
      },
    };
    expect(() =>
      assertControlRequestBinding({
        metadata: completionMetadata,
        record: completedRegistration,
      }),
    ).not.toThrow();

    const forgedRecord = structuredClone(completedRegistration);
    Reflect.set(forgedRecord, "actorRef", "actor_forged");
    expect(() =>
      assertControlRequestBinding({
        metadata: completionMetadata,
        record: forgedRecord,
      }),
    ).toThrow(ModuleControlRepositoryError);
  });

  it("rejects prototype pollution, accessor/TOCTOU binding inputs, and unbounded nesting", () => {
    const polluted = { ...registrationRecord } as Record<string, unknown>;
    Object.defineProperty(polluted, "__proto__", {
      enumerable: true,
      value: { inheritedControlField: "attacker-controlled" },
    });
    expect(() => deepFreezeControlRecord(polluted as never)).toThrow(
      ModuleControlRepositoryError,
    );

    let getterCalls = 0;
    const getterRecord = { ...registrationRecord } as Record<string, unknown>;
    Object.defineProperty(getterRecord, "managementTenantId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? "tenant_demo" : "tenant_other";
      },
    });
    expect(() =>
      assertControlRequestBinding({
        metadata: registerMetadata,
        record: getterRecord as never,
      }),
    ).toThrow(ModuleControlRepositoryError);
    expect(getterCalls).toBe(0);

    let nested: unknown = registrationRecord;
    for (let index = 0; index < 80; index += 1) nested = [nested];
    expect(() => deepFreezeControlRecord(nested as never)).toThrow(
      ModuleControlRepositoryError,
    );
  });

  it("binds audit status to the domain record and rejects mismatched completed results", () => {
    const pendingRelease: ModulePendingReleaseRecord = {
      managementTenantId: "tenant_demo",
      releaseId: "release_001",
      revision: 1,
      desiredModules: [moduleRef],
      previousReleaseId: null,
      previewRef: "preview_change_001",
      approvalId: "approval_001",
      publisherActorRef: "actor_publisher",
      createdAt: "2026-08-22T00:00:00Z",
      publishedAt: "2026-08-22T00:01:00Z",
      status: "published_pending_readback",
      readbackRef: null,
      reasonCodes: [],
      supersededByReleaseId: null,
    };
    expect(() =>
      assertControlRequestBinding({
        metadata: {
          managementTenantId: "tenant_demo",
          actorRef: "actor_publisher",
          action: "deployments.publish",
          idempotencyKey: "idem_publish_001",
          requestHash,
          event: {
            action: "deployments.publish",
            objectRef: "release_001",
            kind: "release",
            status: "active_verified",
            reasonCodes: [],
            detail: {
              kind: "release",
              releaseId: "release_001",
              revision: 1,
              status: "active_verified",
            },
          },
        },
        record: pendingRelease,
      }),
    ).toThrow(ModuleControlRepositoryError);

    expect(() =>
      deepFreezeControlRecord({
        managementTenantId: "tenant_demo",
        action: "deployments.publish",
        idempotencyKey: "idem_publish_001",
        requestHash,
        status: "completed",
        domainRecordRef: "release_001",
        finalResult: {
          domainRecordRef: "release_001",
          envelope: {
            ...envelope,
            data: { kind: "release", release_id: "release_other", revision: 99 },
            readback: { status: "verified", release_id: "release_other", revision: 99 },
          },
        },
        createdAt: "2026-08-22T00:00:00Z",
        expiresAt: "2026-08-23T00:00:00Z",
      } as never),
    ).toThrow(ModuleControlRepositoryError);

    for (const readback of [
      { status: "not_applicable", release_id: null, revision: null },
      { status: "pending", release_id: "release_001", revision: 1 },
    ] as const) {
      expect(() =>
        deepFreezeControlRecord({
          managementTenantId: "tenant_demo",
          action: "deployments.publish",
          idempotencyKey: "idem_publish_001",
          requestHash,
          status: "completed",
          domainRecordRef: "release_001",
          finalResult: {
            domainRecordRef: "release_001",
            envelope: {
              ...envelope,
              data: { kind: "release", release_id: "release_001", revision: 1 },
              readback,
            },
          },
          createdAt: "2026-08-22T00:00:00Z",
          expiresAt: "2026-08-23T00:00:00Z",
        } as never),
      ).toThrow(ModuleControlRepositoryError);
    }

    expect(() =>
      deepFreezeControlRecord({
        managementTenantId: "tenant_demo",
        action: "packages.register",
        idempotencyKey: "idem_repository_contract_001",
        requestHash,
        status: "completed",
        domainRecordRef: registrationRecordRef,
        finalResult: {
          domainRecordRef: registrationRecordRef,
          envelope: {
            ...envelope,
            data: {
              kind: "registration",
              module_id: "container",
              version: "9.9.9",
              descriptor_digest: secondDescriptorDigest,
            },
          },
        },
        createdAt: "2026-08-22T00:00:00Z",
        expiresAt: "2026-08-23T00:00:00Z",
      } as never),
    ).toThrow(ModuleControlRepositoryError);
  });
});

// Compile-contract checks: these assignments must remain rejected by the closed unions.
const compileContractChecks = (): void => {
  const invalidRegistrationMetadata = {
    ...registerMetadata,
    action: "deployments.preview",
  };
  // @ts-expect-error register metadata cannot carry another method's action
  const _invalidAction: RegisterModuleRequestMetadata = invalidRegistrationMetadata;

  const invalidChangePreview = {
    ...changePreview,
    targetReleaseId: null,
  };
  // @ts-expect-error change previews omit targetReleaseId rather than accepting null
  const _invalidChange: ModuleChangePreviewRecord = invalidChangePreview;

  const invalidVerifiedReadback = {
    ...verifiedReadback,
    appliedReleaseId: null,
  };
  // @ts-expect-error verified readback requires an applied release reference
  const _invalidVerified: ModuleVerifiedReadbackRecord = invalidVerifiedReadback;

  // @ts-expect-error arbitrary maps are not control records
  deepFreezeControlRecord({ arbitrary: true });

  const repositoryContract = {} as ModuleControlRepository;
  // @ts-expect-error legacy readback writes are not part of the repository contract
  void repositoryContract.recordReadback;
  // @ts-expect-error generic idempotency completion is not part of the repository contract
  void repositoryContract.completeIdempotency;

  void (undefined as unknown as LegacyOperationTypeChecks);

  void [
    attemptMethodNames,
    _invalidAction,
    _invalidChange,
    _invalidVerified,
    compileContractChecks,
  ];
};

void compileContractChecks;
