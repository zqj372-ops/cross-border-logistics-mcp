import { describe, expect, it } from "vitest";

import {
  CONTROL_IDEMPOTENCY_STATUSES,
  MODULE_READBACK_STATUSES,
  MODULE_RELEASE_STATUSES,
  ModuleControlRepositoryError,
  assertControlRequestBinding,
  assertPreviewHash,
  assertRequestHash,
  deepFreezeControlRecord,
  isPreviewHash,
  isRequestHash,
} from "../../src/logistics_mcp/control-plane/repository";
import type {
  CompletedModuleControlIdempotencyRecord,
  CompleteIdempotencyRequestMetadata,
  ControlEnvelope,
  ControlEventRecord,
  ControlFinalResult,
  ControlRequestMetadata,
  ModuleChangePreviewRecord,
  ModuleActiveVerifiedReleaseRecord,
  ModuleControlRepository,
  ModuleControlRepositoryErrorCode,
  ModuleControlState,
  ModuleMismatchReadbackRecord,
  ModulePendingReadbackRecord,
  ModulePendingReleaseRecord,
  ModuleRegistrationRecord,
  ModuleVerifiedReadbackRecord,
  PublishReadbackRequestMetadata,
  RegisterModuleRequestMetadata,
  ReservedModuleControlIdempotencyRecord,
} from "../../src/logistics_mcp/control-plane/repository";

const useCaseMethodNames = [
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
] as const satisfies readonly (keyof ModuleControlRepository)[];

const lifecycleMethodNames = ["close"] as const satisfies readonly (keyof ModuleControlRepository)[];

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
      recordReadback: unimplemented,
      completeIdempotency: unimplemented,
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

    expect(useCaseMethodNames).toHaveLength(16);
    expect(lifecycleMethodNames).toEqual(["close"]);
    expect(Object.keys(repositoryContract)).toEqual([
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
    expect(useCaseMethodNames).not.toContain("put" as never);
    expect(useCaseMethodNames).not.toContain("get" as never);
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
      status: "completed",
      domainRecordRef: registrationRecordRef,
      finalResult: {
        domainRecordRef: registrationRecordRef,
        envelope,
      },
      createdAt: "2026-08-22T00:00:00Z",
      expiresAt: "2026-08-23T00:00:00Z",
    };
    const completionMetadata: CompleteIdempotencyRequestMetadata = {
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

  const assertCompletedResultReadonly = (
    result: Awaited<
      ReturnType<ModuleControlRepository["completeIdempotency"]>
    >,
  ): void => {
    if (result.status === "completed") {
      // @ts-expect-error completed replay envelopes are deeply readonly
      result.finalResult.envelope.status = "blocked";
      // @ts-expect-error nested readback evidence is deeply readonly
      result.finalResult.envelope.readback.status = "pending";
    }
  };

  void [
    _invalidAction,
    _invalidChange,
    _invalidVerified,
    assertCompletedResultReadonly,
    compileContractChecks,
  ];
};

void compileContractChecks;
