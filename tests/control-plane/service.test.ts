import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context";
import type * as ActivationAuthorityInternal from "../../src/logistics_mcp/control-plane/activation-authority-internal";
import { canonicalControlHash } from "../../src/logistics_mcp/control-plane/canonical-control-hash";
import type {
  ApprovalRequest,
  ControlEnvelope,
  DeepFrozen,
  DeploymentPreviewRequest,
  PublishRequest,
  ReconcileRequest,
  RegisterPackageRequest,
} from "../../src/logistics_mcp/control-plane/contracts";
import { CONTROL_STATE_MAX_MODULES } from "../../src/logistics_mcp/control-plane/contracts";
import { createModuleInventory } from "../../src/logistics_mcp/control-plane/inventory";
import type {
  ModuleControlRepository,
  ModuleControlIdempotencyRecord,
  ModuleControlState,
  ModulePreviewRecord,
  ModuleReadbackRecord,
  ModuleReleaseRecord,
} from "../../src/logistics_mcp/control-plane/repository";
import { ModuleControlRepositoryError } from "../../src/logistics_mcp/control-plane/repository";
import {
  ADMIN_CONTROL_SCHEMA_VERSION,
  type ModuleActivationSnapshot,
} from "../../src/logistics_mcp/control-plane/types";
import {
  createModuleControlRuntimeAssembly,
  type WriteMeta,
} from "../../src/logistics_mcp/control-plane/service";
import { RuntimeMutationFatalError } from "../../src/logistics_mcp/control-plane/runtime-mutation-coordinator";
import {
  FakeModuleControlRepository,
  type FakeModuleControlRepositoryRecords,
} from "./fake-control-repository";

const activationGateTestState = vi.hoisted(() => ({
  snapshotOverride: null as ModuleActivationSnapshot | null,
  snapshotCalls: 0,
}));

vi.mock(
  "../../src/logistics_mcp/control-plane/activation-authority-internal",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof ActivationAuthorityInternal
      >();
    return {
      ...original,
      createActivationGate(
        inventory: Parameters<typeof original.createActivationGate>[0],
      ) {
        const gate = original.createActivationGate(inventory);
        const snapshotOverride = activationGateTestState.snapshotOverride;
        if (snapshotOverride === null) return gate;

        const readFacade = Object.freeze({
          snapshot: () => {
            activationGateTestState.snapshotCalls += 1;
            return (
              activationGateTestState.snapshotOverride ??
              gate.readFacade.snapshot()
            );
          },
          isActive: (
            ref: ModuleActivationSnapshot["activeModules"][number],
          ) => {
            const current =
              activationGateTestState.snapshotOverride ??
              gate.readFacade.snapshot();
            return current.activeModules.some(
              (active) =>
                active.moduleId === ref.moduleId &&
                active.version === ref.version &&
                active.descriptorDigest === ref.descriptorDigest,
            );
          },
        });
        return Object.freeze({
          readFacade,
          privateDriver: gate.privateDriver,
          recoveryDriver: gate.recoveryDriver,
        });
      },
    };
  },
);

afterEach(() => {
  activationGateTestState.snapshotOverride = null;
  activationGateTestState.snapshotCalls = 0;
});

const MANAGEMENT_TENANT_ID = "tenant_demo";

const inventory = createModuleInventory({
  mountedModules: [
    {
      moduleId: "cargo",
      version: "1.0.0",
      riskLevel: "T0",
      lifecycle: "static",
      requiredCapabilities: [],
      optionalCapabilities: [],
      standardRefs: ["standard"],
    },
  ],
  catalog: [
    {
      owner: "cargo",
      name: "cargo.calculate",
      permission: "quote:calculate",
      kind: "read",
      riskLevel: "T0",
      inputSchemaId: "cargo.input",
      outputSchemaId: "cargo.output",
      standardRefs: ["standard"],
    },
  ],
  localEvidence: [
    {
      moduleId: "cargo",
      version: "1.0.0",
      evidenceRefs: {
        sourceShaRef: null,
        artifactDigestRef: null,
        signatureRef: null,
        sbomRef: null,
        attestationRef: null,
      },
    },
  ],
});

function emptyState(): ModuleControlState {
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
  };
}

function repositoryFor(
  getControlState: () => Promise<ModuleControlState>,
): ModuleControlRepository {
  return {
    getControlState: vi.fn(getControlState),
  } as unknown as ModuleControlRepository;
}

function adminContext(
  overrides: Partial<{
    tenantId: string;
    actorId: string;
    actorRole: "admin" | "sales";
    roles: readonly ["admin"] | readonly ["sales", "admin"];
    scopes: readonly string[];
  }> = {},
): ExecutionContext {
  const role = overrides.actorRole ?? "admin";
  const roles = overrides.roles ?? (["admin"] as const);
  return parseExecutionContext({
    tenant_id: overrides.tenantId ?? MANAGEMENT_TENANT_ID,
    actor_id: overrides.actorId ?? "actor_admin",
    actor_role: role,
    roles,
    scopes: overrides.scopes ?? ["platform:admin"],
    client_id: "client_admin",
    session_id: "session_admin",
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
}

function registerRequest(
  overrides: Partial<RegisterPackageRequest> = {},
): RegisterPackageRequest {
  return {
    schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
    module_id: inventory[0]!.moduleId,
    version: inventory[0]!.version,
    descriptor_digest: inventory[0]!.descriptorDigest,
    ...overrides,
  };
}

function registerMeta(
  request: RegisterPackageRequest,
  overrides: Partial<WriteMeta> = {},
  actorRef = "actor_admin",
): WriteMeta {
  const requestHash = canonicalControlHash({
    domain: "request",
    schemaVersion: request.schema_version,
    payload: {
      action: "packages.register",
      management_tenant_id: MANAGEMENT_TENANT_ID,
      actor_ref: actorRef,
      request: {
        ...request,
        descriptor_digest: request.descriptor_digest as `sha256:${string}`,
      },
    },
  }).hash;
  return {
    idempotencyKey: "idem_register_service_001",
    requestHash,
    requestId: "request_register_service_001",
    traceId: "trace_register_service_001",
    auditId: "audit_register_service_001",
    ...overrides,
  } as WriteMeta;
}

type ChangePreviewRequest = Extract<
  DeploymentPreviewRequest,
  { intent: "change" }
>;

type RollbackPreviewRequest = Extract<
  DeploymentPreviewRequest,
  { intent: "rollback" }
>;

function changePreviewRequest(
  overrides: Partial<ChangePreviewRequest> = {},
): ChangePreviewRequest {
  return {
    schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
    intent: "change",
    desired_modules: [
      {
        module_id: inventory[0]!.moduleId,
        version: inventory[0]!.version,
        descriptor_digest: inventory[0]!.descriptorDigest,
      },
    ],
    ...overrides,
  };
}

function rollbackPreviewRequest(
  targetReleaseId = "R0",
): RollbackPreviewRequest {
  return {
    schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
    intent: "rollback",
    target_release_id: targetReleaseId,
  };
}

function previewMeta(
  request: DeploymentPreviewRequest,
  overrides: Partial<WriteMeta> = {},
  actorRef = "actor_admin",
): WriteMeta {
  const requestPayload =
    request.intent === "change"
      ? {
          schema_version: request.schema_version,
          intent: "change" as const,
          desired_modules: request.desired_modules.map((module) => ({
            module_id: module.module_id,
            version: module.version,
            descriptor_digest: module.descriptor_digest as `sha256:${string}`,
          })),
        }
      : {
          schema_version: request.schema_version,
          intent: "rollback" as const,
          target_release_id: request.target_release_id,
        };
  const requestHash = canonicalControlHash({
    domain: "request",
    schemaVersion: request.schema_version,
    payload: {
      action: "deployments.preview",
      management_tenant_id: MANAGEMENT_TENANT_ID,
      actor_ref: actorRef,
      request: requestPayload,
    },
  }).hash;
  return {
    idempotencyKey: "idem_preview_service_001",
    requestHash,
    requestId: "request_preview_service_001",
    traceId: "trace_preview_service_001",
    auditId: "audit_preview_service_001",
    ...overrides,
  } as WriteMeta;
}

function fakeAssembly(options: {
  readonly repository?: FakeModuleControlRepository;
  readonly clock?: () => string;
  readonly idGenerator?: () => string;
  readonly ownerBootId?: string;
} = {}) {
  const repository = options.repository ?? new FakeModuleControlRepository({
    managementTenantId: MANAGEMENT_TENANT_ID,
    ...(options.ownerBootId === undefined
      ? {}
      : { ownerBootId: options.ownerBootId }),
  });
  const clock = options.clock ?? vi.fn(() => "2026-08-25T01:00:00Z");
  const idGenerator = options.idGenerator ?? vi.fn(() => "unused_generated_id");
  return {
    assembly: createModuleControlRuntimeAssembly({
      inventory,
      repository,
      managementTenantId: MANAGEMENT_TENANT_ID,
      previewTtlSeconds: 900,
      clock,
      idGenerator,
      ...(options.ownerBootId === undefined
        ? {}
        : { ownerBootId: options.ownerBootId }),
    }),
    clock,
    idGenerator,
    repository,
  };
}

function approvalMeta(
  request: ApprovalRequest,
  overrides: Partial<WriteMeta> = {},
  actorRef = "actor_approver",
): WriteMeta {
  const requestHash = canonicalControlHash({
    domain: "request",
    schemaVersion: request.schema_version,
    payload: {
      action: "approvals.decide",
      management_tenant_id: MANAGEMENT_TENANT_ID,
      actor_ref: actorRef,
      request,
    },
  }).hash as WriteMeta["requestHash"];
  return {
    idempotencyKey: "idem_approval_service_001",
    requestHash,
    requestId: "request_approval_service_001",
    traceId: "trace_approval_service_001",
    auditId: "audit_approval_service_001",
    ...overrides,
  };
}

function publishMeta(
  request: PublishRequest,
  overrides: Partial<WriteMeta> = {},
  actorRef = "actor_publisher",
): WriteMeta {
  const requestHash = canonicalControlHash({
    domain: "request",
    schemaVersion: request.schema_version,
    payload: {
      action: "deployments.publish",
      management_tenant_id: MANAGEMENT_TENANT_ID,
      actor_ref: actorRef,
      request,
    },
  }).hash as WriteMeta["requestHash"];
  return {
    idempotencyKey: "idem_publish_service_001",
    requestHash,
    requestId: "request_publish_service_001",
    traceId: "trace_publish_service_001",
    auditId: "audit_publish_service_001",
    ...overrides,
  };
}

function publishRequest(
  previewRef: string,
  approvalId: string,
  overrides: Partial<PublishRequest> = {},
): PublishRequest {
  return {
    schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
    preview_ref: previewRef,
    approval_id: approvalId,
    ...overrides,
  };
}

function approvalRequest(
  previewRef: string,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
    preview_ref: previewRef,
    decision: "approve",
    reason_code: "approved",
    ...overrides,
  };
}

function rehashPreviewRecord(preview: ModulePreviewRecord): ModulePreviewRecord {
  const basePayload = {
    action: "deployments.preview" as const,
    management_tenant_id: preview.managementTenantId,
    creator_actor_ref: preview.creatorActorRef,
    base_release_revision: preview.baseRevision,
    inventory_refs: preview.inventoryRefs.map((ref) => ({
      module_id: ref.moduleId,
      version: ref.version,
      descriptor_digest: ref.descriptorDigest,
    })),
    desired_modules: preview.desiredModules.map((ref) => ({
      module_id: ref.moduleId,
      version: ref.version,
      descriptor_digest: ref.descriptorDigest,
    })),
    policy_version: "writable-module-control-plane-v1" as const,
    schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
    validation: {
      base_matches: preview.validation.baseMatches,
      desired_modules_valid: preview.validation.desiredModulesValid,
      inventory_matches: preview.validation.inventoryMatches,
      minimum_active_modules: preview.validation.minimumActiveModules,
      reason_codes: preview.validation.reasonCodes,
    },
    preview_ttl_seconds: 900,
  };
  const payload = preview.intent === "rollback"
    ? {
        ...basePayload,
        intent: "rollback" as const,
        target_release_id: preview.targetReleaseId,
      }
    : {
        ...basePayload,
        intent: "change" as const,
      };
  return {
    ...preview,
    canonicalHash: canonicalControlHash({
      domain: "preview",
      schemaVersion: ADMIN_CONTROL_SCHEMA_VERSION,
      payload,
    }).hash as ModulePreviewRecord["canonicalHash"],
  };
}

async function changeApprovalFixture() {
  const idGenerator = vi
    .fn<() => string>()
    .mockReturnValueOnce("preview_for_approval_fixture")
    .mockReturnValueOnce("approval_for_fixture_001")
    .mockReturnValueOnce("approval_for_fixture_002");
  const clock = vi.fn(() => "2026-08-25T01:00:00Z");
  const { assembly, repository } = fakeAssembly({ clock, idGenerator });
  const registrationRequest = registerRequest();
  await assembly.service.registerPackage(
    adminContext(),
    registrationRequest,
    registerMeta(registrationRequest),
  );
  const previewRequest = changePreviewRequest();
  const preview = await assembly.service.createDeploymentPreview(
    adminContext(),
    previewRequest,
    previewMeta(previewRequest),
  );
  if (preview.data?.kind !== "preview") {
    throw new Error("Expected an approval fixture preview.");
  }
  const previewRef = preview.data.preview_ref;
  if (typeof previewRef !== "string") {
    throw new Error("Expected an approval fixture preview reference.");
  }
  const previewWrite = repository.calls.find(
    (call) => call.method === "createPreview",
  );
  if (previewWrite?.method !== "createPreview") {
    throw new Error("Expected an approval fixture preview write.");
  }
  return {
    assembly,
    clock,
    idGenerator,
    preview,
    previewRef,
    previewRecord: previewWrite.request.record,
    repository,
  };
}

async function firstActivationPublishFixture() {
  const ownerBootId = "boot_publish_service_001";
  const clock = vi.fn(() => "2026-08-25T01:00:00Z");
  const idGenerator = vi
    .fn<() => string>()
    .mockReturnValueOnce("preview_publish_change_001")
    .mockReturnValueOnce("approval_publish_change_001")
    .mockReturnValueOnce("release_publish_change_001")
    .mockReturnValueOnce("attempt_publish_change_001")
    .mockReturnValueOnce("readback_publish_change_001");
  const repository = new FakeModuleControlRepository({
    managementTenantId: MANAGEMENT_TENANT_ID,
    ownerBootId,
    clock,
  });
  const runtime = fakeAssembly({
    repository,
    clock,
    idGenerator,
    ownerBootId,
  });
  const registrationRequest = registerRequest();
  await runtime.assembly.service.registerPackage(
    adminContext(),
    registrationRequest,
    registerMeta(registrationRequest),
  );
  const previewRequest = changePreviewRequest();
  const preview = await runtime.assembly.service.createDeploymentPreview(
    adminContext(),
    previewRequest,
    previewMeta(previewRequest),
  );
  if (
    preview.data?.kind !== "preview" ||
    typeof preview.data.preview_ref !== "string"
  ) {
    throw new Error("Expected a publish fixture preview.");
  }
  const approvalRequestValue = approvalRequest(preview.data.preview_ref);
  const approval = await runtime.assembly.service.decideApproval(
    adminContext({ actorId: "actor_approver" }),
    approvalRequestValue,
    approvalMeta(approvalRequestValue),
  );
  if (
    approval.data?.kind !== "approval" ||
    typeof approval.data.approval_id !== "string"
  ) {
    throw new Error("Expected a publish fixture approval.");
  }
  const request = publishRequest(
    preview.data.preview_ref,
    approval.data.approval_id,
  );
  return {
    ...runtime,
    approval,
    ownerBootId,
    preview,
    request,
  };
}

async function registeredPublishRuntime(
  generatedIds: readonly string[],
  ownerBootId = "boot_publish_chain_001",
) {
  let clockTick = 0;
  const clock = vi.fn(() => {
    const value = new Date(Date.UTC(2026, 7, 25, 1, clockTick, 0)).toISOString();
    clockTick += 1;
    return value;
  });
  const idGenerator = vi.fn<() => string>();
  for (const id of generatedIds) idGenerator.mockReturnValueOnce(id);
  const repository = new FakeModuleControlRepository({
    managementTenantId: MANAGEMENT_TENANT_ID,
    ownerBootId,
    clock,
  });
  const runtime = fakeAssembly({
    repository,
    clock,
    idGenerator,
    ownerBootId,
  });
  const registration = registerRequest();
  await runtime.assembly.service.registerPackage(
    adminContext(),
    registration,
    registerMeta(registration),
  );
  return runtime;
}

async function createApprovedPublish(
  runtime: ReturnType<typeof fakeAssembly>,
  request: DeploymentPreviewRequest,
  suffix: string,
) {
  const creatorActorRef = `actor_creator_${suffix}`;
  const approverActorRef = `actor_approver_${suffix}`;
  const publisherActorRef = `actor_publisher_${suffix}`;
  const preview = await runtime.assembly.service.createDeploymentPreview(
    adminContext({ actorId: creatorActorRef }),
    request,
    previewMeta(
      request,
      {
        idempotencyKey: `idem_preview_${suffix}`,
        requestId: `request_preview_${suffix}`,
        traceId: `trace_preview_${suffix}`,
        auditId: `audit_preview_${suffix}`,
      },
      creatorActorRef,
    ),
  );
  if (
    preview.data?.kind !== "preview" ||
    typeof preview.data.preview_ref !== "string"
  ) {
    throw new Error("Expected an approved-publish preview.");
  }
  const decision = approvalRequest(preview.data.preview_ref);
  const approval = await runtime.assembly.service.decideApproval(
    adminContext({ actorId: approverActorRef }),
    decision,
    approvalMeta(
      decision,
      {
        idempotencyKey: `idem_approval_${suffix}`,
        requestId: `request_approval_${suffix}`,
        traceId: `trace_approval_${suffix}`,
        auditId: `audit_approval_${suffix}`,
      },
      approverActorRef,
    ),
  );
  if (
    approval.data?.kind !== "approval" ||
    typeof approval.data.approval_id !== "string"
  ) {
    throw new Error("Expected an approved-publish approval.");
  }
  const publish = publishRequest(
    preview.data.preview_ref,
    approval.data.approval_id,
  );
  const meta = publishMeta(
    publish,
    {
      idempotencyKey: `idem_publish_${suffix}`,
      requestId: `request_publish_${suffix}`,
      traceId: `trace_publish_${suffix}`,
      auditId: `audit_publish_${suffix}`,
    },
    publisherActorRef,
  );
  return {
    approval,
    approverActorRef,
    creatorActorRef,
    meta,
    preview,
    publish,
    publisherActorRef,
  };
}

async function publishApprovedPreview(
  runtime: ReturnType<typeof fakeAssembly>,
  request: DeploymentPreviewRequest,
  suffix: string,
) {
  const prepared = await createApprovedPublish(runtime, request, suffix);
  const result = await runtime.assembly.service.publish(
    adminContext({ actorId: prepared.publisherActorRef }),
    prepared.publish,
    prepared.meta,
  );
  return { ...prepared, result };
}

async function legacyPublishedRecords(
  runtime: ReturnType<typeof fakeAssembly>,
  cycles: readonly { readonly suffix: string; readonly releaseId: string }[],
): Promise<FakeModuleControlRepositoryRecords> {
  const state = await runtime.repository.getControlState();
  const releases = state.releaseHistory.map(
    (entry) => entry.release,
  ) as unknown as readonly ModuleReleaseRecord[];
  if (
    releases.length !== cycles.length ||
    cycles.some(
      (cycle) =>
        !releases.some((release) => release.releaseId === cycle.releaseId),
    )
  ) {
    throw new Error("Expected every publish cycle in the legacy seed.");
  }
  const previews = await Promise.all(
    releases.map((release) =>
      runtime.repository.getPreview({
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewRef: release.previewRef,
      }),
    ),
  );
  const approvals = await Promise.all(
    releases.map((release) =>
      runtime.repository.getApproval({
        managementTenantId: MANAGEMENT_TENANT_ID,
        approvalId: release.approvalId,
      }),
    ),
  );
  const readbacks = await Promise.all(
    releases.map((release) =>
      runtime.repository.getReadback({
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: release.releaseId,
      }),
    ),
  );
  const idempotency = await Promise.all([
    runtime.repository.getIdempotency({
      managementTenantId: MANAGEMENT_TENANT_ID,
      action: "packages.register",
      idempotencyKey: "idem_register_service_001",
    }),
    ...cycles.flatMap((cycle) => [
      runtime.repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: "deployments.preview" as const,
        idempotencyKey: `idem_preview_${cycle.suffix}`,
      }),
      runtime.repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: "approvals.decide" as const,
        idempotencyKey: `idem_approval_${cycle.suffix}`,
      }),
      runtime.repository.getIdempotency({
        managementTenantId: MANAGEMENT_TENANT_ID,
        action: "deployments.publish" as const,
        idempotencyKey: `idem_publish_${cycle.suffix}`,
      }),
    ]),
  ]);
  if (
    previews.some((record) => record === null) ||
    approvals.some((record) => record === null) ||
    readbacks.some((record) => record === null) ||
    idempotency.some((record) => record === null)
  ) {
    throw new Error("Expected a complete legacy publish seed.");
  }
  const legacyReadbacks = readbacks.map((record) => {
    const legacy = { ...record! };
    Reflect.deleteProperty(legacy, "attemptId");
    return legacy;
  }) as unknown as readonly ModuleReadbackRecord[];
  const legacyIdempotency = idempotency.map((record) =>
    record!.action === "deployments.publish"
      ? { ...record!, status: "domain_committed" as const, finalResult: null }
      : record!,
  ) as unknown as readonly ModuleControlIdempotencyRecord[];
  const events = state.events
    .filter(
      (event) =>
        !(
          event.action === "deployments.publish" &&
          event.kind === "idempotency"
        ),
    )
    .map((event, index) => ({ ...event, sequence: index + 1 }));
  return {
    registrations: state.registrations,
    previews: previews as readonly ModulePreviewRecord[],
    approvals: approvals as NonNullable<(typeof approvals)[number]>[],
    releases,
    readbacks: legacyReadbacks,
    idempotency: legacyIdempotency,
    events,
  };
}

function runtimeFromLegacyRecords(
  records: FakeModuleControlRepositoryRecords,
  activation: ModuleActivationSnapshot,
  generatedIds: readonly string[],
  startMinute: number,
  ownerBootId: string,
) {
  activationGateTestState.snapshotOverride = activation;
  let clockTick = startMinute;
  const clock = vi.fn(() => {
    const value = new Date(Date.UTC(2026, 7, 25, 1, clockTick, 0)).toISOString();
    clockTick += 1;
    return value;
  });
  const idGenerator = vi.fn<() => string>();
  for (const id of generatedIds) idGenerator.mockReturnValueOnce(id);
  const repository = new FakeModuleControlRepository({
    managementTenantId: MANAGEMENT_TENANT_ID,
    ownerBootId,
    clock,
    records,
  });
  return fakeAssembly({ repository, clock, idGenerator, ownerBootId });
}

function repositoryStub(
  overrides: Partial<ModuleControlRepository> = {},
): ModuleControlRepository {
  return {
    getControlState: vi.fn(() => Promise.resolve(emptyState())),
    getIdempotency: vi.fn(() => Promise.resolve(null)),
    getPreview: vi.fn(() => Promise.resolve(null)),
    getReadback: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  } as unknown as ModuleControlRepository;
}

type ControlModuleRef = ModuleReleaseRecord["desiredModules"][number];
type RollbackTargetStatus = ModuleReleaseRecord["status"];

function controlModuleRef(
  overrides: Partial<ControlModuleRef> = {},
): ControlModuleRef {
  return {
    moduleId: inventory[0]!.moduleId,
    version: inventory[0]!.version,
    descriptorDigest: inventory[0]!.descriptorDigest,
    ...overrides,
  };
}

function controlRelease(options: {
  readonly releaseId: string;
  readonly revision: number;
  readonly status: RollbackTargetStatus;
  readonly desiredModules?: readonly ControlModuleRef[];
  readonly managementTenantId?: string;
  readonly previousReleaseId?: string | null;
  readonly readbackRef?: string;
  readonly supersededByReleaseId?: string;
}): ModuleReleaseRecord {
  const base = {
    managementTenantId:
      options.managementTenantId ?? MANAGEMENT_TENANT_ID,
    releaseId: options.releaseId,
    revision: options.revision,
    desiredModules: options.desiredModules ?? [controlModuleRef()],
    previousReleaseId: options.previousReleaseId ?? null,
    previewRef: `preview_${options.releaseId}`,
    approvalId: `approval_${options.releaseId}`,
    publisherActorRef: "actor_admin",
    createdAt: `2026-08-25T00:0${Math.min(options.revision, 9)}:00Z`,
    publishedAt: `2026-08-25T00:1${Math.min(options.revision, 9)}:00Z`,
  } as const;
  const readbackRef = options.readbackRef ?? `readback_${options.releaseId}`;
  switch (options.status) {
    case "published_pending_readback":
      return {
        ...base,
        status: "published_pending_readback",
        readbackRef: null,
        reasonCodes: [],
        supersededByReleaseId: null,
      };
    case "manual_review":
      return {
        ...base,
        status: "manual_review",
        readbackRef,
        reasonCodes: ["readback_unresolved"],
        supersededByReleaseId: null,
      };
    case "active_verified":
      return {
        ...base,
        status: "active_verified",
        readbackRef,
        reasonCodes: [],
        supersededByReleaseId: null,
      };
    case "superseded":
      return {
        ...base,
        status: "superseded",
        readbackRef,
        reasonCodes: [],
        supersededByReleaseId:
          options.supersededByReleaseId ?? "R1",
      };
  }
}

function verifiedReadback(
  release: ModuleReleaseRecord,
  overrides: Partial<{
    managementTenantId: string;
    readbackRef: string;
    releaseId: string;
    revision: number;
    appliedReleaseId: string | null;
    appliedRevision: number | null;
    appliedModules: readonly ControlModuleRef[];
    status: ModuleReadbackRecord["status"];
    reasonCodes: readonly string[];
    checkedAt: string;
  }> = {},
): ModuleReadbackRecord {
  return {
    managementTenantId: release.managementTenantId,
    readbackRef: release.readbackRef ?? `readback_${release.releaseId}`,
    releaseId: release.releaseId,
    revision: release.revision,
    appliedReleaseId: release.releaseId,
    appliedRevision: release.revision,
    appliedModules: release.desiredModules,
    status: "verified",
    reasonCodes: [],
    checkedAt: "2026-08-25T00:30:00Z",
    ...overrides,
  } as ModuleReadbackRecord;
}

function registrationFor(
  ref: ControlModuleRef,
): ModuleControlState["registrations"][number] {
  return {
    managementTenantId: MANAGEMENT_TENANT_ID,
    moduleId: ref.moduleId,
    version: ref.version,
    descriptorDigest: ref.descriptorDigest,
    evidenceLevel: inventory[0]!.evidenceLevel,
    productionEligible: inventory[0]!.productionEligible,
    evidenceRefs: inventory[0]!.evidenceRefs,
    registeredByActorRef: "actor_admin",
    registeredAt: "2026-08-25T00:00:00Z",
  };
}

interface RollbackFixtureOptions {
  readonly inactiveBase?: boolean;
  readonly targetReleaseId?: string;
  readonly targetRevision?: number;
  readonly targetStatus?: RollbackTargetStatus;
  readonly targetTenantId?: string;
  readonly targetModules?: readonly ControlModuleRef[];
  readonly omitTargetFromHistory?: boolean;
  readonly includeNewerUnresolved?: boolean;
  readonly registrationMode?: "exact" | "missing" | "digest_drift";
  readonly targetReleaseLookupError?: Error;
  readonly targetReleaseLookupTransform?: (
    release: ModuleReleaseRecord,
  ) => ModuleReleaseRecord | null;
  readonly targetReadbackError?: Error;
  readonly targetReadbackTransform?: (
    readback: ModuleReadbackRecord,
  ) => ModuleReadbackRecord | null;
}

function rollbackFixture(options: RollbackFixtureOptions = {}) {
  const activeRef = controlModuleRef();
  const targetModules = options.targetModules ?? [controlModuleRef()];
  const activeRelease = controlRelease({
    releaseId: "R1",
    revision: 2,
    status: "active_verified",
    desiredModules: [activeRef],
    previousReleaseId: "R0",
  });
  const targetRelease = controlRelease({
    releaseId: options.targetReleaseId ?? "R0",
    revision: options.targetRevision ?? 1,
    status: options.targetStatus ?? "superseded",
    desiredModules: targetModules,
    supersededByReleaseId: "R1",
    ...(options.targetTenantId === undefined
      ? {}
      : { managementTenantId: options.targetTenantId }),
  });
  const activeReadback = verifiedReadback(activeRelease);
  const validTargetReadback = verifiedReadback(targetRelease);
  const newerRelease = controlRelease({
    releaseId: "R2",
    revision: 3,
    status: "manual_review",
    desiredModules: [activeRef],
    previousReleaseId: "R1",
  });
  const newerLatestReadback = {
    managementTenantId: MANAGEMENT_TENANT_ID,
    readbackRef: "readback_R2",
    releaseId: "R2",
    revision: 3,
    appliedReleaseId: null,
    appliedRevision: null,
    appliedModules: [],
    status: "unknown",
    reasonCodes: ["newer_release_unavailable"],
    checkedAt: "2026-08-25T00:40:00Z",
  } satisfies ModuleReadbackRecord;
  const releaseHistory: ModuleControlState["releaseHistory"] = [
    ...(options.includeNewerUnresolved
      ? [{
          release: newerRelease,
          intent: "change" as const,
          rollbackTargetReleaseId: null,
        }]
      : []),
    {
      release: activeRelease,
      intent: "change",
      rollbackTargetReleaseId: null,
    },
    ...(options.omitTargetFromHistory
      ? []
      : [{
          release: targetRelease,
          intent: "change" as const,
          rollbackTargetReleaseId: null,
        }]),
  ];
  const registrations =
    options.registrationMode === "missing" || targetModules.length === 0
      ? []
      : options.registrationMode === "digest_drift"
        ? [
            registrationFor({
              ...targetModules[0]!,
              descriptorDigest: `sha256:${"e".repeat(64)}`,
            }),
          ]
        : [registrationFor(targetModules[0]!)];
  const state: ModuleControlState = options.inactiveBase
    ? {
        ...emptyState(),
        registrations,
        releaseHistory: releaseHistory.filter(
          (entry) => entry.release.releaseId === targetRelease.releaseId,
        ),
      }
    : {
        ...emptyState(),
        activeRelease,
        activeRevision: activeRelease.revision,
        activeModules: [activeRef],
        registrations,
        latestReadback: options.includeNewerUnresolved
          ? newerLatestReadback
          : activeReadback,
        releaseHistory,
      } satisfies ModuleControlState;

  let persistedIdempotency: Awaited<
    ReturnType<ModuleControlRepository["getIdempotency"]>
  > = null;
  let persistedPreview: Awaited<
    ReturnType<ModuleControlRepository["getPreview"]>
  > = null;

  const persistWrite = (
    writeRequest: Parameters<ModuleControlRepository["createPreview"]>[0],
  ) => {
    const event = {
      ...writeRequest.metadata.event,
      managementTenantId: writeRequest.metadata.managementTenantId,
      eventId: "event_rollback_preview",
      sequence: 1,
      actorRef: writeRequest.metadata.actorRef,
      occurredAt: writeRequest.record.createdAt,
    } as const;
    persistedPreview = writeRequest.record;
    persistedIdempotency = {
      managementTenantId: writeRequest.metadata.managementTenantId,
      action: writeRequest.metadata.action,
      idempotencyKey: writeRequest.metadata.idempotencyKey,
      requestHash: writeRequest.metadata.requestHash,
      actorRef: writeRequest.metadata.actorRef,
      createdAt: writeRequest.record.createdAt,
      expiresAt: "2026-08-26T01:00:00Z",
      status: "completed",
      domainRecordRef: writeRequest.record.previewRef,
      finalResult: writeRequest.finalResult,
    };
    return Promise.resolve({
      record: writeRequest.record,
      event,
      replayed: false as const,
    });
  };

  const getControlState = vi.fn(() => Promise.resolve(state));
  const getRelease = vi.fn<ModuleControlRepository["getRelease"]>(
    (query) => {
      if (options.targetReleaseLookupError !== undefined) {
        return Promise.reject(options.targetReleaseLookupError);
      }
      if (query.releaseId !== targetRelease.releaseId) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        options.targetReleaseLookupTransform === undefined
          ? targetRelease
          : options.targetReleaseLookupTransform(targetRelease),
      );
    },
  );
  const getReadback = vi.fn<ModuleControlRepository["getReadback"]>(
    (query) => {
      if (query.releaseId === activeRelease.releaseId) {
        return Promise.resolve(activeReadback);
      }
      if (query.releaseId !== targetRelease.releaseId) {
        return Promise.resolve(null);
      }
      if (options.targetReadbackError !== undefined) {
        return Promise.reject(options.targetReadbackError);
      }
      return Promise.resolve(
        options.targetReadbackTransform === undefined
          ? validTargetReadback
          : options.targetReadbackTransform(validTargetReadback),
      );
    },
  );
  const getIdempotency = vi.fn(() => Promise.resolve(persistedIdempotency));
  const getPreview = vi.fn(() => Promise.resolve(persistedPreview));
  const createPreview = vi.fn<ModuleControlRepository["createPreview"]>(persistWrite);
  const repository = repositoryStub({
    getControlState,
    getRelease,
    getReadback,
    getIdempotency,
    getPreview,
    createPreview,
  });
  const clock = vi.fn(() => "2026-08-25T01:00:00Z");
  const idGenerator = vi.fn(() => "preview_rollback_001");
  activationGateTestState.snapshotOverride = options.inactiveBase
    ? Object.freeze({
        releaseId: null,
        revision: 0,
        activeModules: Object.freeze([]),
      })
    : Object.freeze({
        releaseId: activeRelease.releaseId,
        revision: activeRelease.revision,
        activeModules: Object.freeze([activeRef]),
      });
  const assembly = createModuleControlRuntimeAssembly({
    inventory,
    repository,
    managementTenantId: MANAGEMENT_TENANT_ID,
    previewTtlSeconds: 900,
    clock,
    idGenerator,
  });
  const request = rollbackPreviewRequest(targetRelease.releaseId);

  return {
    activationSnapshotCalls: () => activationGateTestState.snapshotCalls,
    activeReadback,
    activeRelease,
    assembly,
    clock,
    createPreview,
    getControlState,
    getIdempotency,
    getPreview,
    getReadback,
    getRelease,
    idGenerator,
    persistWrite,
    persistedIdempotency: () => persistedIdempotency,
    persistedPreview: () => persistedPreview,
    repository,
    request,
    state,
    targetRelease,
    validTargetReadback,
  };
}

type RollbackFixture = ReturnType<typeof rollbackFixture>;
type RollbackPreviewRecord = Extract<
  ModulePreviewRecord,
  { readonly intent: "rollback" }
>;
type PreviewEnvelopeData = Extract<
  NonNullable<ControlEnvelope["data"]>,
  { readonly kind: "preview" }
>;

function persistedRollbackArtifacts(fixture: RollbackFixture) {
  const preview = fixture.persistedPreview();
  const idempotency = fixture.persistedIdempotency();
  if (
    preview === null ||
    preview.intent !== "rollback" ||
    idempotency === null ||
    idempotency.status !== "completed" ||
    idempotency.finalResult === null ||
    idempotency.finalResult.envelope.data?.kind !== "preview" ||
    idempotency.finalResult.envelope.data.intent !== "rollback"
  ) {
    throw new Error("Expected persisted rollback preview artifacts.");
  }
  return {
    preview,
    idempotency,
    finalResult: idempotency.finalResult,
    envelope: idempotency.finalResult.envelope,
    data: idempotency.finalResult.envelope.data,
  };
}

function mockRollbackReplayRecord(
  fixture: RollbackFixture,
  transform: (record: RollbackPreviewRecord) => RollbackPreviewRecord,
): void {
  const { preview } = persistedRollbackArtifacts(fixture);
  fixture.getPreview.mockImplementation(() =>
    Promise.resolve(transform(preview)),
  );
}

function mockRollbackReplayEnvelopeData(
  fixture: RollbackFixture,
  transform: (
    data: DeepFrozen<PreviewEnvelopeData>,
  ) => DeepFrozen<PreviewEnvelopeData>,
): void {
  const artifacts = persistedRollbackArtifacts(fixture);
  fixture.getIdempotency.mockImplementation(() =>
    Promise.resolve({
      ...artifacts.idempotency,
      finalResult: {
        ...artifacts.finalResult,
        envelope: {
          ...artifacts.envelope,
          data: transform(artifacts.data),
        },
      },
    }),
  );
}

function expectNoPreviewDependencies(fixture: RollbackFixture): void {
  expect(fixture.getIdempotency).not.toHaveBeenCalled();
  expect(fixture.getPreview).not.toHaveBeenCalled();
  expect(fixture.getControlState).not.toHaveBeenCalled();
  expect(fixture.getRelease).not.toHaveBeenCalled();
  expect(fixture.getReadback).not.toHaveBeenCalled();
  expect(fixture.activationSnapshotCalls()).toBe(0);
  expect(fixture.clock).not.toHaveBeenCalled();
  expect(fixture.idGenerator).not.toHaveBeenCalled();
  expect(fixture.createPreview).not.toHaveBeenCalled();
}

function placeholderMeta(): WriteMeta {
  return {
    idempotencyKey: "idem_placeholder_001",
    requestHash: `mcp-control-hash/v1/request/sha256:${"a".repeat(64)}`,
    requestId: "request_placeholder_001",
    traceId: "trace_placeholder_001",
    auditId: "audit_placeholder_001",
  };
}

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function assemblyFor(
  getControlState: () => Promise<ModuleControlState>,
  spies: {
    readonly clock: () => string;
    readonly idGenerator: () => string;
  },
) {
  return createModuleControlRuntimeAssembly({
    inventory,
    repository: repositoryFor(getControlState),
    managementTenantId: MANAGEMENT_TENANT_ID,
    previewTtlSeconds: 900,
    clock: spies.clock,
    idGenerator: spies.idGenerator,
  });
}

describe("ModuleControlService slice A", () => {
  it("maps an empty repository state into a closed, frozen control envelope", async () => {
    const clock = vi.fn(() => "2026-08-25T00:00:00Z");
    const idGenerator = vi
      .fn<() => string>()
      .mockReturnValueOnce("req_state_001")
      .mockReturnValueOnce("trace_state_001")
      .mockReturnValueOnce("audit_state_001");
    const getControlState = vi.fn(() => Promise.resolve(emptyState()));
    const assembly = assemblyFor(getControlState, { clock, idGenerator });

    const result = await assembly.service.getState(adminContext());

    if (result.data === null || result.data.kind !== "control_state") {
      throw new Error("Expected a control_state response.");
    }

    expect(result).toEqual({
      schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
      request_id: "req_state_001",
      trace_id: "trace_state_001",
      audit_id: "audit_state_001",
      status: "success",
      data: {
        kind: "control_state",
        activation: {
          state: "inactive",
          release_id: null,
          revision: 0,
          active_modules: [],
        },
        inventory_modules: [
          {
            module_id: "cargo",
            version: "1.0.0",
            risk_level: "T0",
            descriptor_digest: inventory[0]!.descriptorDigest,
            evidence_level: "local_build",
            production_eligible: false,
            tool_names: ["cargo.calculate"],
            standard_ids: ["standard"],
            registration: null,
          },
        ],
        latest_preview: null,
        latest_approval: null,
        latest_readback: null,
        release_history: [],
        events: [],
        events_truncated: false,
      },
      reason_codes: [],
      readback: {
        status: "not_applicable",
        release_id: null,
        revision: null,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(result.data.inventory_modules)).toBe(true);
    expect(Object.isFrozen(result.data.inventory_modules[0])).toBe(true);
    expect(getControlState).toHaveBeenCalledTimes(1);
    expect(clock).not.toHaveBeenCalled();
  });

  it.each([
    ["untrusted context", {} as ExecutionContext],
    [
      "active role is not admin even when roles contains admin",
      adminContext({ actorRole: "sales", roles: ["sales", "admin"] }),
    ],
    ["admin scope is missing", adminContext({ scopes: [] })],
    [
      "management tenant does not match",
      adminContext({ tenantId: "tenant_other" }),
    ],
  ])("short-circuits getState before every dependency for %s", async (_label, context) => {
    const clock = vi.fn(() => "2026-08-25T00:00:00Z");
    const idGenerator = vi.fn(() => "unused_id");
    const getControlState = vi.fn(() => Promise.resolve(emptyState()));
    const assembly = assemblyFor(getControlState, { clock, idGenerator });

    const result = await assembly.service.getState(context);

    expect(result.status).toBe("blocked");
    expect(result.data).toBeNull();
    expect(result.reason_codes.length).toBeGreaterThan(0);
    expect(result.readback).toEqual({
      status: "not_applicable",
      release_id: null,
      revision: null,
    });
    expect(getControlState).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(idGenerator).not.toHaveBeenCalled();
  });

  describe("registerPackage", () => {
    it("persists an exact inventory-owned registration and returns the completed readback envelope", async () => {
      const request = registerRequest();
      const meta = registerMeta(request);
      const { assembly, clock, idGenerator, repository } = fakeAssembly();

      const result = await assembly.service.registerPackage(
        adminContext(),
        request,
        meta,
      );

      expect(result).toEqual({
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "success",
        data: {
          kind: "registration",
          module_id: inventory[0]!.moduleId,
          version: inventory[0]!.version,
          descriptor_digest: inventory[0]!.descriptorDigest,
          evidence_level: "local_build",
          production_eligible: false,
        },
        reason_codes: [],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.data)).toBe(true);
      expect(repository.calls.map((call) => call.method)).toEqual([
        "registerModule",
        "getIdempotency",
      ]);
      const registrationCall = repository.calls[0];
      expect(registrationCall?.method).toBe("registerModule");
      if (registrationCall?.method !== "registerModule") {
        throw new Error("Expected registerModule call.");
      }
      expect(registrationCall.request.record).toMatchObject({
        managementTenantId: MANAGEMENT_TENANT_ID,
        moduleId: inventory[0]!.moduleId,
        version: inventory[0]!.version,
        descriptorDigest: inventory[0]!.descriptorDigest,
        evidenceLevel: inventory[0]!.evidenceLevel,
        productionEligible: inventory[0]!.productionEligible,
        evidenceRefs: inventory[0]!.evidenceRefs,
        registeredByActorRef: "actor_admin",
        registeredAt: "2026-08-25T01:00:00Z",
      });
      expect(registrationCall.request.metadata.actorRef).toBe("actor_admin");
      expect(registrationCall.request.metadata.requestHash).toBe(meta.requestHash);
      expect(clock).toHaveBeenCalledTimes(1);
      expect(idGenerator).not.toHaveBeenCalled();
    });

    it("returns the byte-identical persisted final result on same-key replay", async () => {
      const request = registerRequest();
      const firstMeta = registerMeta(request);
      const replayMeta = registerMeta(request, {
        requestId: "request_register_replay_002",
        traceId: "trace_register_replay_002",
        auditId: "audit_register_replay_002",
      });
      const { assembly, repository } = fakeAssembly();

      const first = await assembly.service.registerPackage(
        adminContext(),
        request,
        firstMeta,
      );
      const replay = await assembly.service.registerPackage(
        adminContext(),
        request,
        replayMeta,
      );

      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
      expect(replay.request_id).toBe(firstMeta.requestId);
      expect(repository.calls.map((call) => call.method)).toEqual([
        "registerModule",
        "getIdempotency",
        "registerModule",
        "getIdempotency",
      ]);
    });

    it("blocks canonical hash mismatch, inventory drift, unknown modules, and record conflicts", async () => {
      const request = registerRequest();
      const hashMismatchRepository = new FakeModuleControlRepository({
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      const hashMismatchRuntime = fakeAssembly({
        repository: hashMismatchRepository,
      });
      const hashMismatch = await hashMismatchRuntime.assembly.service.registerPackage(
        adminContext(),
        request,
        registerMeta(request, {
          requestHash: `mcp-control-hash/v1/request/sha256:${"f".repeat(64)}`,
        }),
      );
      expect(hashMismatch).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["request_hash_mismatch"],
      });
      expect(hashMismatchRepository.calls).toEqual([]);
      expect(hashMismatchRuntime.clock).not.toHaveBeenCalled();

      for (const invalidRequest of [
        registerRequest({ descriptor_digest: `sha256:${"e".repeat(64)}` }),
        registerRequest({ module_id: "unknown_module" }),
      ]) {
        const runtime = fakeAssembly();
        const result = await runtime.assembly.service.registerPackage(
          adminContext(),
          invalidRequest,
          registerMeta(invalidRequest),
        );
        expect(result.status).toBe("blocked");
        expect(result.data).toBeNull();
        expect(result.reason_codes.length).toBeGreaterThan(0);
        expect(runtime.repository.calls).toEqual([]);
        expect(runtime.clock).not.toHaveBeenCalled();
      }

      const conflictRuntime = fakeAssembly();
      await conflictRuntime.assembly.service.registerPackage(
        adminContext(),
        request,
        registerMeta(request),
      );
      const conflict = await conflictRuntime.assembly.service.registerPackage(
        adminContext(),
        request,
        registerMeta(request, {
          idempotencyKey: "idem_register_service_conflict_002",
          requestId: "request_register_conflict_002",
          traceId: "trace_register_conflict_002",
          auditId: "audit_register_conflict_002",
        }),
      );
      expect(conflict).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["registration_conflict"],
      });
    });

    it("maps a closed repository call to an action-specific unavailable envelope", async () => {
      const repository = new FakeModuleControlRepository({
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      repository.queueFailure("registerModule", "closed");
      const request = registerRequest();
      const meta = registerMeta(request);
      const { assembly } = fakeAssembly({ repository });

      const result = await assembly.service.registerPackage(
        adminContext(),
        request,
        meta,
      );

      expect(result).toEqual({
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "unavailable",
        data: null,
        reason_codes: ["repository_unavailable"],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });
      expect(repository.calls.map((call) => call.method)).toEqual([
        "registerModule",
      ]);
    });

    it("authorizes before request, repository, clock, and id generation", async () => {
      let proxyTrapCalls = 0;
      const request = new Proxy(registerRequest(), {
        get() {
          proxyTrapCalls += 1;
          throw new Error("secret request trap");
        },
      });
      const validRequest = registerRequest();
      const meta = registerMeta(validRequest);
      const { assembly, clock, idGenerator, repository } = fakeAssembly();

      const result = await assembly.service.registerPackage(
        {} as ExecutionContext,
        request,
        meta,
      );

      expect(result).toMatchObject({
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "blocked",
        data: null,
        reason_codes: ["execution_context_untrusted"],
      });
      expect(proxyTrapCalls).toBe(0);
      expect(repository.calls).toEqual([]);
      expect(clock).not.toHaveBeenCalled();
      expect(idGenerator).not.toHaveBeenCalled();
    });

    it("rejects non-exact or trapped WriteMeta without touching dependencies", async () => {
      const request = registerRequest();
      const validMeta = registerMeta(request);
      let proxyTrapCalls = 0;
      const trappedMeta = new Proxy(validMeta, {
        get() {
          proxyTrapCalls += 1;
          throw new Error("secret meta trap");
        },
        ownKeys() {
          proxyTrapCalls += 1;
          throw new Error("secret meta ownKeys trap");
        },
      });

      for (const meta of [
        { ...validMeta, unexpected: "field" } as WriteMeta,
        trappedMeta,
      ]) {
        const { assembly, clock, idGenerator, repository } = fakeAssembly();
        await expect(
          assembly.service.registerPackage(adminContext(), request, meta),
        ).rejects.toMatchObject({
          name: "ModuleControlServiceError",
          code: "write_meta_invalid",
          message: "The server write metadata is invalid.",
        });
        expect(repository.calls).toEqual([]);
        expect(clock).not.toHaveBeenCalled();
        expect(idGenerator).not.toHaveBeenCalled();
      }
      expect(proxyTrapCalls).toBe(0);
    });

    it.each([
      [
        "Proxy",
        () => {
          let traps = 0;
          return {
            request: new Proxy(registerRequest(), {
              get() {
                traps += 1;
                throw new Error("secret proxy trap");
              },
            }),
            reads: () => traps,
          };
        },
      ],
      [
        "getter",
        () => {
          let reads = 0;
          const request = { ...registerRequest() } as Record<string, unknown>;
          Object.defineProperty(request, "module_id", {
            enumerable: true,
            get() {
              reads += 1;
              throw new Error("secret getter");
            },
          });
          return { request, reads: () => reads };
        },
      ],
      [
        "custom prototype",
        () => {
          const request = Object.create({ secret: "hidden" }) as Record<
            string,
            unknown
          >;
          Object.assign(request, registerRequest());
          return { request, reads: () => 0 };
        },
      ],
    ])("rejects a %s request without invoking traps or dependencies", async (_label, makeInput) => {
      const input = makeInput();
      const validRequest = registerRequest();
      const meta = registerMeta(validRequest);
      const { assembly, clock, idGenerator, repository } = fakeAssembly();

      const result = await assembly.service.registerPackage(
        adminContext(),
        input.request as RegisterPackageRequest,
        meta,
      );

      expect(result).toMatchObject({
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "blocked",
        data: null,
        reason_codes: ["register_request_invalid"],
      });
      expect(input.reads()).toBe(0);
      expect(repository.calls).toEqual([]);
      expect(clock).not.toHaveBeenCalled();
      expect(idGenerator).not.toHaveBeenCalled();
    });
  });

  describe("createDeploymentPreview change", () => {
    it.each([
      undefined,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])("requires a positive safe preview TTL at assembly construction: %s", (previewTtlSeconds) => {
      const options = {
        inventory,
        repository: repositoryStub(),
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds,
        clock: () => "2026-08-25T01:00:00Z",
        idGenerator: () => "preview_ttl_invalid",
      } as Parameters<typeof createModuleControlRuntimeAssembly>[0];

      expect(() => createModuleControlRuntimeAssembly(options)).toThrow(
        "previewTtlSeconds must be a positive safe integer.",
      );
    });

    it("creates a deterministic inactive-base change preview with exact TTL and diff", async () => {
      const clock = vi.fn(() => "2026-08-25T01:00:00Z");
      const idGenerator = vi.fn(() => "preview_change_001");
      const { assembly, repository } = fakeAssembly({ clock, idGenerator });
      const registrationRequest = registerRequest();
      await assembly.service.registerPackage(
        adminContext(),
        registrationRequest,
        registerMeta(registrationRequest),
      );

      const request = changePreviewRequest();
      const meta = previewMeta(request);
      const result = await assembly.service.createDeploymentPreview(
        adminContext(),
        request,
        meta,
      );

      const expectedPreviewHash = canonicalControlHash({
        domain: "preview",
        schemaVersion: ADMIN_CONTROL_SCHEMA_VERSION,
        payload: {
          action: "deployments.preview",
          management_tenant_id: MANAGEMENT_TENANT_ID,
          creator_actor_ref: "actor_admin",
          intent: "change",
          base_release_revision: 0,
          inventory_refs: [
            {
              module_id: inventory[0]!.moduleId,
              version: inventory[0]!.version,
              descriptor_digest: inventory[0]!.descriptorDigest,
            },
          ],
          desired_modules: [
            {
              module_id: inventory[0]!.moduleId,
              version: inventory[0]!.version,
              descriptor_digest: inventory[0]!.descriptorDigest,
            },
          ],
          policy_version: "writable-module-control-plane-v1",
          schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
          validation: {
            base_matches: true,
            desired_modules_valid: true,
            inventory_matches: true,
            minimum_active_modules: true,
            reason_codes: [],
          },
          preview_ttl_seconds: 900,
        },
      }).hash;

      expect(result).toEqual({
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "success",
        data: {
          kind: "preview",
          preview_ref: "preview_change_001",
          intent: "change",
          base_release_id: null,
          base_revision: 0,
          desired_modules: [
            {
              module_id: inventory[0]!.moduleId,
              version: inventory[0]!.version,
              descriptor_digest: inventory[0]!.descriptorDigest,
            },
          ],
          target_release_id: null,
          expires_at: "2026-08-25T01:15:00Z",
          canonical_hash: expectedPreviewHash,
          diff: {
            added: [
              {
                module_id: inventory[0]!.moduleId,
                version: inventory[0]!.version,
                descriptor_digest: inventory[0]!.descriptorDigest,
              },
            ],
            removed: [],
            retained: [],
          },
          validation: {
            base_matches: true,
            desired_modules_valid: true,
            inventory_matches: true,
            minimum_active_modules: true,
            reason_codes: [],
          },
          creator_actor_ref: "actor_admin",
          created_at: "2026-08-25T01:00:00Z",
          consumed: false,
        },
        reason_codes: [],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });

      const previewCall = repository.calls.find(
        (call) => call.method === "createPreview",
      );
      expect(previewCall?.method).toBe("createPreview");
      if (previewCall?.method !== "createPreview") {
        throw new Error("Expected createPreview call.");
      }
      expect(previewCall.request.record).toMatchObject({
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewRef: "preview_change_001",
        canonicalHash: expectedPreviewHash,
        baseReleaseId: null,
        baseRevision: 0,
        creatorActorRef: "actor_admin",
        createdAt: "2026-08-25T01:00:00Z",
        expiresAt: "2026-08-25T01:15:00Z",
        consumed: false,
        intent: "change",
      });
      expect(previewCall.request.metadata.requestHash).toBe(meta.requestHash);
      expect(previewCall.request.finalResult.envelope).toEqual(result);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.data)).toBe(true);
      expect(clock).toHaveBeenCalledTimes(2);
      expect(idGenerator).toHaveBeenCalledTimes(1);
    });

    it("blocks invalid, unknown, unregistered, drifted, duplicate, and hash-mismatched changes", async () => {
      const hashMismatchRuntime = fakeAssembly();
      const validRequest = changePreviewRequest();
      const hashMismatch = await hashMismatchRuntime.assembly.service.createDeploymentPreview(
        adminContext(),
        validRequest,
        previewMeta(validRequest, {
          requestHash: `mcp-control-hash/v1/request/sha256:${"f".repeat(64)}`,
        }),
      );
      expect(hashMismatch).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["request_hash_mismatch"],
      });
      expect(hashMismatchRuntime.repository.calls).toEqual([]);
      expect(hashMismatchRuntime.clock).not.toHaveBeenCalled();
      expect(hashMismatchRuntime.idGenerator).not.toHaveBeenCalled();

      const duplicateRequest = {
        ...validRequest,
        desired_modules: [
          ...validRequest.desired_modules,
          ...validRequest.desired_modules,
        ],
      } as DeploymentPreviewRequest;
      const duplicateRuntime = fakeAssembly();
      const duplicate = await duplicateRuntime.assembly.service.createDeploymentPreview(
        adminContext(),
        duplicateRequest,
        placeholderMeta(),
      );
      expect(duplicate).toMatchObject({ status: "blocked", data: null });
      expect(duplicate.status).not.toBe("needs_input");
      expect(duplicateRuntime.repository.calls).toEqual([]);

      const unknownRequest = changePreviewRequest({
        desired_modules: [
          {
            module_id: "unknown_module",
            version: "1.0.0",
            descriptor_digest: `sha256:${"1".repeat(64)}`,
          },
        ],
      });
      const unknownRuntime = fakeAssembly();
      const unknown = await unknownRuntime.assembly.service.createDeploymentPreview(
        adminContext(),
        unknownRequest,
        previewMeta(unknownRequest),
      );
      expect(unknown).toMatchObject({ status: "blocked", data: null });
      expect(unknown.status).not.toBe("needs_input");
      expect(unknownRuntime.repository.calls.map((call) => call.method)).toEqual([
        "getIdempotency",
        "getControlState",
      ]);

      const driftRequest = changePreviewRequest({
        desired_modules: [
          {
            module_id: inventory[0]!.moduleId,
            version: inventory[0]!.version,
            descriptor_digest: `sha256:${"e".repeat(64)}`,
          },
        ],
      });
      const driftRuntime = fakeAssembly();
      const drift = await driftRuntime.assembly.service.createDeploymentPreview(
        adminContext(),
        driftRequest,
        previewMeta(driftRequest),
      );
      expect(drift).toMatchObject({ status: "blocked", data: null });
      expect(drift.status).not.toBe("needs_input");
      expect(driftRuntime.repository.calls.map((call) => call.method)).toEqual([
        "getIdempotency",
        "getControlState",
      ]);

      const unregisteredRuntime = fakeAssembly();
      const unregistered = await unregisteredRuntime.assembly.service.createDeploymentPreview(
        adminContext(),
        validRequest,
        previewMeta(validRequest),
      );
      expect(unregistered).toMatchObject({ status: "blocked", data: null });
      expect(unregistered.status).not.toBe("needs_input");
      expect(unregisteredRuntime.repository.calls.map((call) => call.method)).toEqual([
        "getIdempotency",
        "getControlState",
      ]);
    });

    it("authenticates and safely rejects request Proxy/getter traps before dependencies", async () => {
      const validRequest = changePreviewRequest();
      const meta = previewMeta(validRequest);
      const unauthorizedRuntime = fakeAssembly();
      let unauthorizedTraps = 0;
      const unauthorizedRequest = new Proxy(validRequest, {
        get() {
          unauthorizedTraps += 1;
          throw new Error("request proxy trap");
        },
      });
      const unauthorized = await unauthorizedRuntime.assembly.service.createDeploymentPreview(
        {} as ExecutionContext,
        unauthorizedRequest,
        meta,
      );
      expect(unauthorized).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["execution_context_untrusted"],
      });
      expect(unauthorizedTraps).toBe(0);
      expect(unauthorizedRuntime.repository.calls).toEqual([]);
      expect(unauthorizedRuntime.clock).not.toHaveBeenCalled();
      expect(unauthorizedRuntime.idGenerator).not.toHaveBeenCalled();

      const trappedRuntime = fakeAssembly();
      let nestedTraps = 0;
      const trappedRequest = {
        ...validRequest,
        desired_modules: new Proxy(validRequest.desired_modules, {
          get() {
            nestedTraps += 1;
            throw new Error("nested desired module trap");
          },
          ownKeys() {
            nestedTraps += 1;
            throw new Error("nested desired module keys trap");
          },
        }),
      } as DeploymentPreviewRequest;
      const trapped = await trappedRuntime.assembly.service.createDeploymentPreview(
        adminContext(),
        trappedRequest,
        meta,
      );
      expect(trapped).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["preview_request_invalid"],
      });
      expect(nestedTraps).toBe(0);
      expect(trappedRuntime.repository.calls).toEqual([]);
      expect(trappedRuntime.clock).not.toHaveBeenCalled();
      expect(trappedRuntime.idGenerator).not.toHaveBeenCalled();

      const getterRuntime = fakeAssembly();
      let getterReads = 0;
      const getterRequest = { ...validRequest } as Record<string, unknown>;
      Object.defineProperty(getterRequest, "schema_version", {
        enumerable: true,
        get() {
          getterReads += 1;
          throw new Error("schema version getter");
        },
      });
      const getter = await getterRuntime.assembly.service.createDeploymentPreview(
        adminContext(),
        getterRequest as DeploymentPreviewRequest,
        meta,
      );
      expect(getter).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["preview_request_invalid"],
      });
      expect(getterReads).toBe(0);
      expect(getterRuntime.repository.calls).toEqual([]);
    });

    it("bounds invalid preview request inspection before reading unknown values", async () => {
      const validRequest = changePreviewRequest();
      const validMeta = previewMeta(validRequest);
      const cases: readonly [
        string,
        () => { request: unknown; trapCount: () => number },
      ][] = [
        [
          "dense desired_modules beyond the schema maximum",
          () => {
            let traps = 0;
            const trappedModule = new Proxy(
              { ...validRequest.desired_modules[0]! },
              {
                get() {
                  traps += 1;
                  throw new Error("dense module get trap");
                },
                getOwnPropertyDescriptor() {
                  traps += 1;
                  throw new Error("dense module descriptor trap");
                },
                getPrototypeOf() {
                  traps += 1;
                  throw new Error("dense module prototype trap");
                },
                ownKeys() {
                  traps += 1;
                  throw new Error("dense module keys trap");
                },
              },
            );
            const desiredModules = Array.from(
              { length: CONTROL_STATE_MAX_MODULES + 1 },
              (_, index) =>
                index === CONTROL_STATE_MAX_MODULES
                  ? trappedModule
                  : { ...validRequest.desired_modules[0]! },
            );
            return {
              request: {
                ...validRequest,
                desired_modules: desiredModules,
              },
              trapCount: () => traps,
            };
          },
        ],
        [
          "many unknown properties on an ordinary object",
          () => {
            let traps = 0;
            const request = { ...validRequest } as Record<string, unknown>;
            for (let index = 0; index < 96; index += 1) {
              const unknownValue = {
                nested: { index },
              } as Record<string, unknown>;
              if (index === 95) {
                Object.defineProperty(unknownValue, "getter_value", {
                  enumerable: true,
                  get() {
                    traps += 1;
                    throw new Error("unknown getter trap");
                  },
                });
              }
              request[`unknown_${index}`] = unknownValue;
            }
            return { request, trapCount: () => traps };
          },
        ],
        [
          "deep unknown object",
          () => {
            let traps = 0;
            const trappedLeaf = new Proxy(
              { value: "unread" },
              {
                get() {
                  traps += 1;
                  throw new Error("deep leaf get trap");
                },
                getOwnPropertyDescriptor() {
                  traps += 1;
                  throw new Error("deep leaf descriptor trap");
                },
                getPrototypeOf() {
                  traps += 1;
                  throw new Error("deep leaf prototype trap");
                },
                ownKeys() {
                  traps += 1;
                  throw new Error("deep leaf keys trap");
                },
              },
            );
            let deepUnknown: Record<string, unknown> = {
              proxy_leaf: trappedLeaf,
            };
            Object.defineProperty(deepUnknown, "getter_value", {
              enumerable: true,
              get() {
                traps += 1;
                throw new Error("deep getter trap");
              },
            });
            for (let depth = 0; depth < 96; depth += 1) {
              deepUnknown = { next: deepUnknown };
            }
            return {
              request: {
                ...validRequest,
                deep_unknown: deepUnknown,
              },
              trapCount: () => traps,
            };
          },
        ],
      ];

      for (const [label, makeCase] of cases) {
        const input = makeCase();
        const { assembly, clock, idGenerator, repository } = fakeAssembly();
        const descriptorSnapshots = vi.spyOn(Object, "getOwnPropertyDescriptors");
        let result: DeepFrozen<ControlEnvelope>;
        let descriptorSnapshotCount: number;
        try {
          result = await assembly.service.createDeploymentPreview(
            adminContext(),
            input.request as DeploymentPreviewRequest,
            validMeta,
          );
          descriptorSnapshotCount = descriptorSnapshots.mock.calls.length;
        } finally {
          descriptorSnapshotCount = descriptorSnapshots.mock.calls.length;
          descriptorSnapshots.mockRestore();
        }

        expect(result, label).toMatchObject({
          status: "blocked",
          data: null,
          reason_codes: ["preview_request_invalid"],
        });
        expect(input.trapCount(), label).toBe(0);
        expect(descriptorSnapshotCount, label).toBeLessThanOrEqual(8);
        expect(repository.calls, label).toEqual([]);
        expect(clock, label).not.toHaveBeenCalled();
        expect(idGenerator, label).not.toHaveBeenCalled();
      }
    });

    it("returns unavailable before preview write when the repository is closed", async () => {
      const repository = new FakeModuleControlRepository({
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      repository.queueFailure("getControlState", "closed");
      const clock = vi.fn(() => "2026-08-25T01:00:00Z");
      const idGenerator = vi.fn(() => "preview_closed_should_not_exist");
      const { assembly } = fakeAssembly({ repository, clock, idGenerator });
      const request = changePreviewRequest();

      const result = await assembly.service.createDeploymentPreview(
        adminContext(),
        request,
        previewMeta(request),
      );

      expect(result).toMatchObject({
        status: "unavailable",
        data: null,
        reason_codes: ["repository_unavailable"],
      });
      expect(repository.calls.map((call) => call.method)).toEqual([
        "getIdempotency",
        "getControlState",
      ]);
      expect(clock).not.toHaveBeenCalled();
      expect(idGenerator).not.toHaveBeenCalled();
    });

    it("reads the active release readback by R1 instead of the latest R2 readback", async () => {
      const activeRef = {
        moduleId: inventory[0]!.moduleId,
        version: inventory[0]!.version,
        descriptorDigest: inventory[0]!.descriptorDigest,
      } as const;
      const activeRelease = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: "R1",
        revision: 1,
        desiredModules: [activeRef],
        previousReleaseId: null,
        previewRef: "preview_R1",
        approvalId: "approval_R1",
        publisherActorRef: "actor_admin",
        createdAt: "2026-08-25T00:00:00Z",
        publishedAt: "2026-08-25T00:01:00Z",
        status: "active_verified",
        readbackRef: "readback_R1",
        reasonCodes: [],
        supersededByReleaseId: null,
      } satisfies ModuleReleaseRecord;
      const latestReadback = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        readbackRef: "readback_R2",
        releaseId: "R2",
        revision: 2,
        appliedReleaseId: "R2",
        appliedRevision: 2,
        appliedModules: [activeRef],
        status: "unknown",
        reasonCodes: ["newer_release_unavailable"],
        checkedAt: "2026-08-25T00:02:00Z",
      } satisfies ModuleReadbackRecord;
      const exactActiveReadback = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        readbackRef: "readback_R1",
        releaseId: "R1",
        revision: 1,
        appliedReleaseId: "R1",
        appliedRevision: 1,
        appliedModules: [activeRef],
        status: "verified",
        reasonCodes: [],
        checkedAt: "2026-08-25T00:03:00Z",
      } satisfies ModuleReadbackRecord;
      const getReadback = vi.fn(
        (query: { readonly releaseId: string }) =>
          Promise.resolve(query.releaseId === "R1" ? exactActiveReadback : null),
      );
      const repository = repositoryStub({
        getControlState: vi.fn(() =>
          Promise.resolve({
            ...emptyState(),
            activeRelease,
            activeRevision: 1,
            activeModules: [activeRef],
            latestReadback,
          }),
        ),
        getReadback,
      });
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock: () => "2026-08-25T01:00:00Z",
        idGenerator: () => "preview_should_not_exist",
      });
      const request = changePreviewRequest();

      await expect(
        assembly.service.createDeploymentPreview(
          adminContext(),
          request,
          previewMeta(request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);

      expect(getReadback.mock.calls.map(([query]) => query.releaseId)).toEqual([
        "R1",
      ]);
      expect(getReadback).not.toHaveBeenCalledWith(
        expect.objectContaining({ releaseId: "R2" }),
      );
    });

    it("creates a preview from exact R1 authority while newer R2 readback remains unresolved", async () => {
      const activeRef = Object.freeze({
        moduleId: inventory[0]!.moduleId,
        version: inventory[0]!.version,
        descriptorDigest: inventory[0]!.descriptorDigest,
      });
      const activeRelease = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: "R1",
        revision: 1,
        desiredModules: [activeRef],
        previousReleaseId: null,
        previewRef: "preview_R1",
        approvalId: "approval_R1",
        publisherActorRef: "actor_admin",
        createdAt: "2026-08-25T00:00:00Z",
        publishedAt: "2026-08-25T00:01:00Z",
        status: "active_verified",
        readbackRef: "readback_R1",
        reasonCodes: [],
        supersededByReleaseId: null,
      } satisfies ModuleReleaseRecord;
      const exactActiveReadback = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        readbackRef: "readback_R1",
        releaseId: "R1",
        revision: 1,
        appliedReleaseId: "R1",
        appliedRevision: 1,
        appliedModules: [activeRef],
        status: "verified",
        reasonCodes: [],
        checkedAt: "2026-08-25T00:02:00Z",
      } satisfies ModuleReadbackRecord;
      const newerRelease = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: "R2",
        revision: 2,
        desiredModules: [activeRef],
        previousReleaseId: "R1",
        previewRef: "preview_R2",
        approvalId: "approval_R2",
        publisherActorRef: "actor_admin",
        createdAt: "2026-08-25T00:10:00Z",
        publishedAt: "2026-08-25T00:11:00Z",
        status: "manual_review",
        readbackRef: "readback_R2",
        reasonCodes: ["newer_release_unavailable"],
        supersededByReleaseId: null,
      } satisfies ModuleReleaseRecord;
      const newerLatestReadback = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        readbackRef: "readback_R2",
        releaseId: "R2",
        revision: 2,
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        status: "unknown",
        reasonCodes: ["newer_release_unavailable"],
        checkedAt: "2026-08-25T00:12:00Z",
      } satisfies ModuleReadbackRecord;
      const registration = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        moduleId: inventory[0]!.moduleId,
        version: inventory[0]!.version,
        descriptorDigest: inventory[0]!.descriptorDigest,
        evidenceLevel: inventory[0]!.evidenceLevel,
        productionEligible: inventory[0]!.productionEligible,
        evidenceRefs: inventory[0]!.evidenceRefs,
        registeredByActorRef: "actor_admin",
        registeredAt: "2026-08-25T00:00:00Z",
      } satisfies ModuleControlState["registrations"][number];
      const state = {
        ...emptyState(),
        activeRelease,
        activeRevision: 1,
        activeModules: [activeRef],
        registrations: [registration],
        latestReadback: newerLatestReadback,
        releaseHistory: [
          {
            release: newerRelease,
            intent: "change",
            rollbackTargetReleaseId: null,
          },
          {
            release: activeRelease,
            intent: "change",
            rollbackTargetReleaseId: null,
          },
        ],
      } satisfies ModuleControlState;
      activationGateTestState.snapshotOverride = Object.freeze({
        releaseId: "R1",
        revision: 1,
        activeModules: Object.freeze([activeRef]),
      });

      let persisted: Awaited<
        ReturnType<ModuleControlRepository["getIdempotency"]>
      > = null;
      const getControlState = vi.fn(() => Promise.resolve(state));
      const getReadback = vi.fn(() => Promise.resolve(exactActiveReadback));
      const getIdempotency = vi.fn(() => Promise.resolve(persisted));
      const createPreview = vi.fn<
        ModuleControlRepository["createPreview"]
      >((writeRequest) => {
        const event = {
          ...writeRequest.metadata.event,
          managementTenantId: writeRequest.metadata.managementTenantId,
          eventId: "event_active_base_preview",
          sequence: 1,
          actorRef: writeRequest.metadata.actorRef,
          occurredAt: writeRequest.record.createdAt,
        };
        persisted = {
          managementTenantId: writeRequest.metadata.managementTenantId,
          action: writeRequest.metadata.action,
          idempotencyKey: writeRequest.metadata.idempotencyKey,
          requestHash: writeRequest.metadata.requestHash,
          actorRef: writeRequest.metadata.actorRef,
          createdAt: writeRequest.record.createdAt,
          expiresAt: "2026-08-26T01:00:00Z",
          status: "completed",
          domainRecordRef: writeRequest.record.previewRef,
          finalResult: writeRequest.finalResult,
        };
        return Promise.resolve({
          record: writeRequest.record,
          event,
          replayed: false,
        });
      });
      const repository = repositoryStub({
        getControlState,
        getReadback,
        getIdempotency,
        createPreview,
      });
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock: () => "2026-08-25T01:00:00Z",
        idGenerator: () => "preview_active_base",
      });
      const request = changePreviewRequest();

      const result = await assembly.service.createDeploymentPreview(
        adminContext(),
        request,
        previewMeta(request),
      );

      expect(result).toMatchObject({
        status: "success",
        data: {
          kind: "preview",
          base_release_id: "R1",
          base_revision: 1,
          diff: {
            added: [],
            removed: [],
            retained: [
              {
                module_id: activeRef.moduleId,
                version: activeRef.version,
                descriptor_digest: activeRef.descriptorDigest,
              },
            ],
          },
        },
      });
      expect(getReadback).toHaveBeenCalledExactlyOnceWith({
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: "R1",
      });
      expect(createPreview).toHaveBeenCalledTimes(1);
    });

    it("trips fatal when the exact R1 readback drifts from the active release", async () => {
      const activeRef = {
        moduleId: inventory[0]!.moduleId,
        version: inventory[0]!.version,
        descriptorDigest: inventory[0]!.descriptorDigest,
      } as const;
      const activeRelease = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: "R1",
        revision: 1,
        desiredModules: [activeRef],
        previousReleaseId: null,
        previewRef: "preview_R1",
        approvalId: "approval_R1",
        publisherActorRef: "actor_admin",
        createdAt: "2026-08-25T00:00:00Z",
        publishedAt: "2026-08-25T00:01:00Z",
        status: "active_verified",
        readbackRef: "readback_R1",
        reasonCodes: [],
        supersededByReleaseId: null,
      } satisfies ModuleReleaseRecord;
      const driftedExactReadback = {
        managementTenantId: MANAGEMENT_TENANT_ID,
        readbackRef: "readback_R1_drifted",
        releaseId: "R1",
        revision: 1,
        appliedReleaseId: "R1",
        appliedRevision: 1,
        appliedModules: [activeRef],
        status: "verified",
        reasonCodes: [],
        checkedAt: "2026-08-25T00:03:00Z",
      } satisfies ModuleReadbackRecord;
      const getReadback = vi.fn(() => Promise.resolve(driftedExactReadback));
      const repository = repositoryStub({
        getControlState: vi.fn(() =>
          Promise.resolve({
            ...emptyState(),
            activeRelease,
            activeRevision: 1,
            activeModules: [activeRef],
            latestReadback: null,
          }),
        ),
        getReadback,
      });
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock: () => "2026-08-25T01:00:00Z",
        idGenerator: () => "preview_should_not_exist",
      });
      const request = changePreviewRequest();

      await expect(
        assembly.service.createDeploymentPreview(
          adminContext(),
          request,
          previewMeta(request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      expect(getReadback).toHaveBeenCalledExactlyOnceWith({
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: "R1",
      });
    });

    it("trips fatal on a repository and activation-gate base contradiction", async () => {
      const ref = {
        moduleId: inventory[0]!.moduleId,
        version: inventory[0]!.version,
        descriptorDigest: inventory[0]!.descriptorDigest,
      };
      const contradictoryState = {
        ...emptyState(),
        activeRevision: 1,
        activeModules: [ref],
      };
      const getControlState = vi.fn(() => Promise.resolve(contradictoryState));
      const repository = repositoryStub({
        getControlState,
      });
      const clock = vi.fn(() => "2026-08-25T01:00:00Z");
      const idGenerator = vi.fn(() => "preview_contradiction_should_not_exist");
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock,
        idGenerator,
      });
      const request = changePreviewRequest();

      await expect(
        assembly.service.createDeploymentPreview(
          adminContext(),
          request,
          previewMeta(request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      expect(getControlState).toHaveBeenCalledTimes(1);
      expect(clock).not.toHaveBeenCalled();
      expect(idGenerator).not.toHaveBeenCalled();
    });

    it.each([
      "not-an-instant",
      "2026-08-25T01:00:00.1234567890Z",
      "9999-12-31T23:59:59.999999999Z",
    ])("trips fatal for invalid or overflowing clock instant %s", async (clockValue) => {
      const clock = vi
        .fn<() => string>()
        .mockReturnValueOnce("2026-08-25T01:00:00Z")
        .mockReturnValueOnce(clockValue);
      const { assembly, repository } = fakeAssembly({
        clock,
        idGenerator: vi.fn(() => "preview_invalid_time"),
      });
      const registrationRequest = registerRequest();
      await assembly.service.registerPackage(
        adminContext(),
        registrationRequest,
        registerMeta(registrationRequest),
      );
      const request = changePreviewRequest();

      await expect(
        assembly.service.createDeploymentPreview(
          adminContext(),
          request,
          previewMeta(request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      expect(
        repository.calls.filter((call) => call.method === "createPreview"),
      ).toHaveLength(0);
    });

    it("trips fatal when post-write idempotency readback fails", async () => {
      const repository = new FakeModuleControlRepository({
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      const { assembly } = fakeAssembly({ repository });
      const registrationRequest = registerRequest();
      await assembly.service.registerPackage(
        adminContext(),
        registrationRequest,
        registerMeta(registrationRequest),
      );
      const getIdempotency = vi
        .spyOn(repository, "getIdempotency")
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("post-write readback failed"));

      const request = changePreviewRequest();
      await expect(
        assembly.service.createDeploymentPreview(
          adminContext(),
          request,
          previewMeta(request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      expect(
        repository.calls.filter((call) => call.method === "createPreview"),
      ).toHaveLength(1);
      expect(getIdempotency).toHaveBeenCalledTimes(2);
    });

    it("trips fatal when createPreview returns a drifted record after persisting the canonical record", async () => {
      const repository = new FakeModuleControlRepository({
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      const { assembly } = fakeAssembly({ repository });
      const registrationRequest = registerRequest();
      await assembly.service.registerPackage(
        adminContext(),
        registrationRequest,
        registerMeta(registrationRequest),
      );
      const createPreview = repository.createPreview.bind(repository);
      const createPreviewSpy = vi
        .spyOn(repository, "createPreview")
        .mockImplementation(async (request) => {
          const result = await createPreview(request);
          return {
            ...result,
            record: {
              ...result.record,
              canonicalHash: `mcp-control-hash/v1/preview/sha256:${"f".repeat(64)}`,
            },
          };
        });
      const request = changePreviewRequest();

      await expect(
        assembly.service.createDeploymentPreview(
          adminContext(),
          request,
          previewMeta(request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      expect(createPreviewSpy).toHaveBeenCalledTimes(1);
    });

    it("trips fatal when createPreview returns an actor-drifted event after persisting the canonical event", async () => {
      const repository = new FakeModuleControlRepository({
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      const { assembly } = fakeAssembly({ repository });
      const registrationRequest = registerRequest();
      await assembly.service.registerPackage(
        adminContext(),
        registrationRequest,
        registerMeta(registrationRequest),
      );
      const createPreview = repository.createPreview.bind(repository);
      const createPreviewSpy = vi
        .spyOn(repository, "createPreview")
        .mockImplementation(async (request) => {
          const result = await createPreview(request);
          return {
            ...result,
            event: {
              ...result.event,
              actorRef: "actor_drifted",
            },
          };
        });
      const request = changePreviewRequest();

      await expect(
        assembly.service.createDeploymentPreview(
          adminContext(),
          request,
          previewMeta(request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      expect(createPreviewSpy).toHaveBeenCalledTimes(1);
    });

    it("replays the first persisted bytes without creating a second preview", async () => {
      const idGenerator = vi
        .fn<() => string>()
        .mockReturnValueOnce("preview_replay_first")
        .mockReturnValueOnce("preview_replay_second");
      const clock = vi.fn(() => "2026-08-25T01:00:00Z");
      const { assembly, repository } = fakeAssembly({ idGenerator, clock });
      const registrationRequest = registerRequest();
      await assembly.service.registerPackage(
        adminContext(),
        registrationRequest,
        registerMeta(registrationRequest),
      );
      const request = changePreviewRequest();
      const firstMeta = previewMeta(request);
      const secondMeta = previewMeta(request, {
        requestId: "request_preview_replay_002",
        traceId: "trace_preview_replay_002",
        auditId: "audit_preview_replay_002",
      });

      const first = await assembly.service.createDeploymentPreview(
        adminContext(),
        request,
        firstMeta,
      );
      const repositoryCallsAfterFirst = repository.calls.length;
      const clockCallsAfterFirst = clock.mock.calls.length;
      const idGeneratorCallsAfterFirst = idGenerator.mock.calls.length;
      const replay = await assembly.service.createDeploymentPreview(
        adminContext(),
        request,
        secondMeta,
      );

      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
      expect(replay.request_id).toBe(first.request_id);
      expect(
        repository.calls
          .slice(repositoryCallsAfterFirst)
          .map((call) => call.method),
      ).toEqual(["getIdempotency", "getPreview"]);
      expect(clock).toHaveBeenCalledTimes(clockCallsAfterFirst);
      expect(idGenerator).toHaveBeenCalledTimes(idGeneratorCallsAfterFirst);
    });

    it("trips fatal when replayed preview and final envelope share the same forged canonical hash", async () => {
      const { assembly, repository } = fakeAssembly({
        idGenerator: vi.fn(() => "preview_replay_forged_hash"),
      });
      const registrationRequest = registerRequest();
      await assembly.service.registerPackage(
        adminContext(),
        registrationRequest,
        registerMeta(registrationRequest),
      );
      const request = changePreviewRequest();
      const meta = previewMeta(request);
      await assembly.service.createDeploymentPreview(
        adminContext(),
        request,
        meta,
      );

      const originalGetIdempotency = repository.getIdempotency.bind(repository);
      const originalGetPreview = repository.getPreview.bind(repository);
      const forgedCanonicalHash =
        `mcp-control-hash/v1/preview/sha256:${"f".repeat(64)}` as const;
      vi.spyOn(repository, "getIdempotency").mockImplementation(
        async (query) => {
          const persisted = await originalGetIdempotency(query);
          if (
            persisted === null ||
            persisted.status !== "completed" ||
            persisted.finalResult.envelope.data?.kind !== "preview"
          ) {
            throw new Error("Expected completed preview idempotency record.");
          }
          return {
            ...persisted,
            finalResult: {
              ...persisted.finalResult,
              envelope: {
                ...persisted.finalResult.envelope,
                data: {
                  ...persisted.finalResult.envelope.data,
                  canonical_hash: forgedCanonicalHash,
                },
              },
            },
          };
        },
      );
      vi.spyOn(repository, "getPreview").mockImplementation(async (query) => {
        const persisted = await originalGetPreview(query);
        if (persisted === null) {
          throw new Error("Expected persisted preview record.");
        }
        return {
          ...persisted,
          canonicalHash: forgedCanonicalHash,
        };
      });

      await expect(
        assembly.service.createDeploymentPreview(
          adminContext(),
          request,
          meta,
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
    });

    it("blocks the same idempotency key with a different valid change request hash before state reads", async () => {
      const clock = vi.fn(() => "2026-08-25T01:00:00Z");
      const idGenerator = vi.fn(() => "preview_conflict_first");
      const { assembly, repository } = fakeAssembly({ clock, idGenerator });
      const registrationRequest = registerRequest();
      await assembly.service.registerPackage(
        adminContext(),
        registrationRequest,
        registerMeta(registrationRequest),
      );
      const firstRequest = changePreviewRequest();
      const firstMeta = previewMeta(firstRequest);
      await assembly.service.createDeploymentPreview(
        adminContext(),
        firstRequest,
        firstMeta,
      );

      const repositoryCallsAfterFirst = repository.calls.length;
      const getControlStateCallsAfterFirst = repository.calls.filter(
        (call) => call.method === "getControlState",
      ).length;
      const createPreviewCallsAfterFirst = repository.calls.filter(
        (call) => call.method === "createPreview",
      ).length;
      const clockCallsAfterFirst = clock.mock.calls.length;
      const idGeneratorCallsAfterFirst = idGenerator.mock.calls.length;
      const conflictingRequest = changePreviewRequest({
        desired_modules: [
          {
            module_id: inventory[0]!.moduleId,
            version: inventory[0]!.version,
            descriptor_digest: `sha256:${"e".repeat(64)}`,
          },
        ],
      });
      const conflictingMeta = previewMeta(conflictingRequest);
      expect(conflictingMeta.idempotencyKey).toBe(firstMeta.idempotencyKey);
      expect(conflictingMeta.requestHash).not.toBe(firstMeta.requestHash);

      const result = await assembly.service.createDeploymentPreview(
        adminContext(),
        conflictingRequest,
        conflictingMeta,
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["preview_conflict"],
      });
      expect(
        repository.calls
          .slice(repositoryCallsAfterFirst)
          .map((call) => call.method),
      ).toEqual(["getIdempotency"]);
      expect(
        repository.calls.filter((call) => call.method === "getControlState"),
      ).toHaveLength(getControlStateCallsAfterFirst);
      expect(
        repository.calls.filter((call) => call.method === "createPreview"),
      ).toHaveLength(createPreviewCallsAfterFirst);
      expect(clock).toHaveBeenCalledTimes(clockCallsAfterFirst);
      expect(idGenerator).toHaveBeenCalledTimes(idGeneratorCallsAfterFirst);
    });

    it("creates a rollback preview for a superseded target from exact active R1 authority", async () => {
      const fixture = rollbackFixture();

      const result = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        previewMeta(fixture.request),
      );

      expect(result).toMatchObject({
        status: "success",
        data: {
          kind: "preview",
          intent: "rollback",
          base_release_id: "R1",
          base_revision: 2,
          target_release_id: "R0",
          desired_modules: [
            {
              module_id: inventory[0]!.moduleId,
              version: inventory[0]!.version,
              descriptor_digest: inventory[0]!.descriptorDigest,
            },
          ],
          diff: {
            added: [],
            removed: [],
            retained: [
              {
                module_id: inventory[0]!.moduleId,
                version: inventory[0]!.version,
                descriptor_digest: inventory[0]!.descriptorDigest,
              },
            ],
          },
        },
      });
      expect(fixture.getRelease).toHaveBeenCalledExactlyOnceWith({
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: "R0",
      });
      expect(fixture.getReadback.mock.calls.map(([query]) => query.releaseId)).toEqual([
        "R1",
        "R0",
      ]);
      expect(fixture.createPreview).toHaveBeenCalledTimes(1);
    });

    it("creates a rollback preview for an older active_verified target", async () => {
      const fixture = rollbackFixture({ targetStatus: "active_verified" });

      const result = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        previewMeta(fixture.request),
      );

      expect(result).toMatchObject({
        status: "success",
        data: {
          kind: "preview",
          intent: "rollback",
          base_release_id: "R1",
          base_revision: 2,
          target_release_id: "R0",
        },
        reason_codes: [],
      });
      expect(fixture.createPreview).toHaveBeenCalledTimes(1);
    });

    it("blocks rollback from an inactive base before target reads or generated values", async () => {
      const fixture = rollbackFixture({ inactiveBase: true });

      const result = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        previewMeta(fixture.request),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["rollback_base_inactive"],
      });
      expect(fixture.getRelease).not.toHaveBeenCalled();
      expect(fixture.getReadback).not.toHaveBeenCalled();
      expect(fixture.clock).not.toHaveBeenCalled();
      expect(fixture.idGenerator).not.toHaveBeenCalled();
      expect(fixture.createPreview).not.toHaveBeenCalled();
    });

    it("blocks a repository-visible target outside bounded release history without target reads", async () => {
      const fixture = rollbackFixture({ omitTargetFromHistory: true });

      const result = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        previewMeta(fixture.request),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["rollback_target_not_in_bounded_history"],
      });
      expect(fixture.getRelease).not.toHaveBeenCalled();
      expect(fixture.getReadback.mock.calls.map(([query]) => query.releaseId)).toEqual([
        "R1",
      ]);
      expect(fixture.createPreview).not.toHaveBeenCalled();
    });

    it.each([
      ["same", 2],
      ["newer", 3],
    ] as const)(
      "blocks a %s-revision rollback target before target reads",
      async (_label, targetRevision) => {
        const fixture = rollbackFixture({ targetRevision });

        const result = await fixture.assembly.service.createDeploymentPreview(
          adminContext(),
          fixture.request,
          previewMeta(fixture.request),
        );

        expect(result).toMatchObject({
          status: "blocked",
          data: null,
          reason_codes: ["rollback_target_not_older_than_base"],
        });
        expect(fixture.getRelease).not.toHaveBeenCalled();
        expect(fixture.getReadback.mock.calls.map(([query]) => query.releaseId)).toEqual([
          "R1",
        ]);
        expect(fixture.createPreview).not.toHaveBeenCalled();
      },
    );

    it.each([
      "published_pending_readback",
      "manual_review",
    ] as const)(
      "blocks an older %s rollback target as status-ineligible",
      async (targetStatus) => {
        const fixture = rollbackFixture({
          targetRevision: 1,
          targetStatus,
        });

        const result = await fixture.assembly.service.createDeploymentPreview(
          adminContext(),
          fixture.request,
          previewMeta(fixture.request),
        );

        expect(result).toMatchObject({
          status: "blocked",
          data: null,
          reason_codes: ["rollback_target_status_not_eligible"],
        });
        expect(fixture.getRelease).not.toHaveBeenCalled();
        expect(fixture.getReadback.mock.calls.map(([query]) => query.releaseId)).toEqual([
          "R1",
        ]);
        expect(fixture.createPreview).not.toHaveBeenCalled();
      },
    );

    it("returns unavailable when the exact target readback dependency fails", async () => {
      const fixture = rollbackFixture({
        targetReadbackError: new Error("target readback unavailable"),
      });

      const result = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        previewMeta(fixture.request),
      );

      expect(result).toMatchObject({
        status: "unavailable",
        data: null,
        reason_codes: ["repository_unavailable"],
      });
      expect(fixture.getRelease).toHaveBeenCalledTimes(1);
      expect(fixture.getReadback.mock.calls.map(([query]) => query.releaseId)).toEqual([
        "R1",
        "R0",
      ]);
      expect(fixture.clock).not.toHaveBeenCalled();
      expect(fixture.idGenerator).not.toHaveBeenCalled();
      expect(fixture.createPreview).not.toHaveBeenCalled();
    });

    const targetReadbackContradictions: readonly [
      string,
      (readback: ModuleReadbackRecord) => ModuleReadbackRecord | null,
    ][] = [
      ["null", () => null],
      [
        "mismatch",
        (readback) => ({
          ...readback,
          status: "mismatch",
          reasonCodes: ["target_readback_mismatch"],
        }),
      ],
      [
        "unknown",
        (readback) => ({
          ...readback,
          status: "unknown",
          reasonCodes: ["target_readback_unknown"],
        }),
      ],
      [
        "wrong readback ref",
        (readback) => ({
          ...readback,
          readbackRef: "readback_wrong_target",
        }),
      ],
      [
        "wrong applied modules",
        (readback) => ({
          ...readback,
          appliedModules: [],
        }),
      ],
      [
        "wrong revision",
        (readback) => ({
          ...readback,
          revision: readback.revision + 1,
        }),
      ],
    ];

    it.each(targetReadbackContradictions)(
      "trips fatal for a persisted target with %s readback",
      async (_label, targetReadbackTransform) => {
        const fixture = rollbackFixture({ targetReadbackTransform });

        await expect(
          fixture.assembly.service.createDeploymentPreview(
            adminContext(),
            fixture.request,
            previewMeta(fixture.request),
          ),
        ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
        expect(fixture.createPreview).not.toHaveBeenCalled();
      },
    );

    const driftedDigest = `sha256:${"e".repeat(64)}` as const;
    const rollbackModuleFailures: readonly [
      string,
      RollbackFixtureOptions,
      string,
    ][] = [
      [
        "target module missing from inventory",
        {
          targetModules: [controlModuleRef({ moduleId: "quote" })],
        },
        "inventory_module_not_found",
      ],
      [
        "target module inventory digest drift",
        {
          targetModules: [controlModuleRef({ descriptorDigest: driftedDigest })],
        },
        "inventory_descriptor_mismatch",
      ],
      [
        "target registration missing",
        { registrationMode: "missing" },
        "module_not_registered",
      ],
      [
        "target registration digest drift",
        { registrationMode: "digest_drift" },
        "registration_descriptor_mismatch",
      ],
    ];

    it.each(rollbackModuleFailures)(
      "blocks rollback when %s",
      async (_label, fixtureOptions, reasonCode) => {
        const fixture = rollbackFixture(fixtureOptions);

        const result = await fixture.assembly.service.createDeploymentPreview(
          adminContext(),
          fixture.request,
          previewMeta(fixture.request),
        );

        expect(result).toMatchObject({
          status: "blocked",
          data: null,
          reason_codes: [reasonCode],
        });
        expect(fixture.createPreview).not.toHaveBeenCalled();
      },
    );

    it("keeps active R1 as rollback authority when newer R2 is unresolved", async () => {
      const fixture = rollbackFixture({ includeNewerUnresolved: true });

      const result = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        previewMeta(fixture.request),
      );

      expect(fixture.state.latestReadback).toMatchObject({
        releaseId: "R2",
        status: "unknown",
      });
      expect(result).toMatchObject({
        status: "success",
        data: {
          intent: "rollback",
          base_release_id: "R1",
          base_revision: 2,
          target_release_id: "R0",
        },
      });
      expect(fixture.getReadback.mock.calls.map(([query]) => query.releaseId)).toEqual([
        "R1",
        "R0",
      ]);
      expect(fixture.createPreview).toHaveBeenCalledTimes(1);
    });

    it("replays a same-key same-hash rollback byte-identically without authority side effects", async () => {
      const fixture = rollbackFixture();
      const firstMeta = previewMeta(fixture.request);
      const first = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        firstMeta,
      );
      const persisted = persistedRollbackArtifacts(fixture);
      const callsAfterFirst = {
        activation: fixture.activationSnapshotCalls(),
        controlState: fixture.getControlState.mock.calls.length,
        createPreview: fixture.createPreview.mock.calls.length,
        getIdempotency: fixture.getIdempotency.mock.calls.length,
        getPreview: fixture.getPreview.mock.calls.length,
        getReadback: fixture.getReadback.mock.calls.length,
        getRelease: fixture.getRelease.mock.calls.length,
        clock: fixture.clock.mock.calls.length,
        idGenerator: fixture.idGenerator.mock.calls.length,
      };
      const replayMeta = previewMeta(fixture.request, {
        requestId: "request_rollback_replay_002",
        traceId: "trace_rollback_replay_002",
        auditId: "audit_rollback_replay_002",
      });

      const replay = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        replayMeta,
      );

      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
      expect(JSON.stringify(replay)).toBe(
        JSON.stringify(persisted.finalResult.envelope),
      );
      expect(fixture.getIdempotency).toHaveBeenCalledTimes(
        callsAfterFirst.getIdempotency + 1,
      );
      expect(fixture.getPreview).toHaveBeenCalledTimes(callsAfterFirst.getPreview + 1);
      expect(fixture.activationSnapshotCalls()).toBe(callsAfterFirst.activation);
      expect(fixture.getControlState).toHaveBeenCalledTimes(callsAfterFirst.controlState);
      expect(fixture.getRelease).toHaveBeenCalledTimes(callsAfterFirst.getRelease);
      expect(fixture.getReadback).toHaveBeenCalledTimes(callsAfterFirst.getReadback);
      expect(fixture.clock).toHaveBeenCalledTimes(callsAfterFirst.clock);
      expect(fixture.idGenerator).toHaveBeenCalledTimes(callsAfterFirst.idGenerator);
      expect(fixture.createPreview).toHaveBeenCalledTimes(callsAfterFirst.createPreview);
    });

    it("blocks a same-key different-target rollback immediately after idempotency preflight", async () => {
      const fixture = rollbackFixture();
      const firstMeta = previewMeta(fixture.request);
      await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        firstMeta,
      );
      const callsAfterFirst = {
        activation: fixture.activationSnapshotCalls(),
        controlState: fixture.getControlState.mock.calls.length,
        createPreview: fixture.createPreview.mock.calls.length,
        getIdempotency: fixture.getIdempotency.mock.calls.length,
        getPreview: fixture.getPreview.mock.calls.length,
        getReadback: fixture.getReadback.mock.calls.length,
        getRelease: fixture.getRelease.mock.calls.length,
        clock: fixture.clock.mock.calls.length,
        idGenerator: fixture.idGenerator.mock.calls.length,
      };
      const conflictingRequest = rollbackPreviewRequest("R_other");
      const conflictingMeta = previewMeta(conflictingRequest);
      expect(conflictingMeta.idempotencyKey).toBe(firstMeta.idempotencyKey);
      expect(conflictingMeta.requestHash).not.toBe(firstMeta.requestHash);

      const result = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        conflictingRequest,
        conflictingMeta,
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["preview_conflict"],
      });
      expect(fixture.getIdempotency).toHaveBeenCalledTimes(
        callsAfterFirst.getIdempotency + 1,
      );
      expect(fixture.getPreview).toHaveBeenCalledTimes(callsAfterFirst.getPreview);
      expect(fixture.activationSnapshotCalls()).toBe(callsAfterFirst.activation);
      expect(fixture.getControlState).toHaveBeenCalledTimes(callsAfterFirst.controlState);
      expect(fixture.getRelease).toHaveBeenCalledTimes(callsAfterFirst.getRelease);
      expect(fixture.getReadback).toHaveBeenCalledTimes(callsAfterFirst.getReadback);
      expect(fixture.clock).toHaveBeenCalledTimes(callsAfterFirst.clock);
      expect(fixture.idGenerator).toHaveBeenCalledTimes(callsAfterFirst.idGenerator);
      expect(fixture.createPreview).toHaveBeenCalledTimes(callsAfterFirst.createPreview);
    });

    it("trips fatal when rollback record and final envelope share one forged canonical hash", async () => {
      const fixture = rollbackFixture();
      const meta = previewMeta(fixture.request);
      await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        meta,
      );
      const forgedCanonicalHash =
        `mcp-control-hash/v1/preview/sha256:${"f".repeat(64)}` as const;
      mockRollbackReplayRecord(fixture, (record) => ({
        ...record,
        canonicalHash: forgedCanonicalHash,
      }));
      mockRollbackReplayEnvelopeData(fixture, (data) => ({
        ...data,
        canonical_hash: forgedCanonicalHash,
      }));

      await expect(
        fixture.assembly.service.createDeploymentPreview(
          adminContext(),
          fixture.request,
          meta,
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
    });

    const replayTargetDrifts: readonly [
      string,
      (fixture: RollbackFixture) => void,
    ][] = [
      [
        "persisted record targetReleaseId",
        (fixture) => {
          mockRollbackReplayRecord(fixture, (record) => ({
            ...record,
            targetReleaseId: "R_drifted_record",
          }));
        },
      ],
      [
        "final envelope target_release_id",
        (fixture) => {
          mockRollbackReplayEnvelopeData(fixture, (data) => ({
            ...data,
            target_release_id: "R_drifted_envelope",
          }));
        },
      ],
    ];

    it.each(replayTargetDrifts)(
      "trips fatal and fences readiness when replay drifts %s",
      async (_label, applyDrift) => {
        const fixture = rollbackFixture();
        const meta = previewMeta(fixture.request);
        await fixture.assembly.service.createDeploymentPreview(
          adminContext(),
          fixture.request,
          meta,
        );
        applyDrift(fixture);

        await expect(
          fixture.assembly.service.createDeploymentPreview(
            adminContext(),
            fixture.request,
            meta,
          ),
        ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
        await expect(
          fixture.assembly.service.getState(adminContext()),
        ).rejects.toMatchObject({ code: "fatal" });
      },
    );

    it("trips fatal and fences readiness when createPreview returns a rollback record with target drift", async () => {
      const fixture = rollbackFixture();
      fixture.createPreview.mockImplementation(async (request) => {
        const result = await fixture.persistWrite(request);
        if (result.record.intent !== "rollback") {
          throw new Error("Expected a rollback preview record.");
        }
        return {
          ...result,
          record: {
            ...result.record,
            targetReleaseId: "R_postwrite_record_drift",
          },
        };
      });

      await expect(
        fixture.assembly.service.createDeploymentPreview(
          adminContext(),
          fixture.request,
          previewMeta(fixture.request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      await expect(
        fixture.assembly.service.getState(adminContext()),
      ).rejects.toMatchObject({ code: "fatal" });
    });

    it("trips fatal and fences readiness when postwrite final envelope target drifts", async () => {
      const fixture = rollbackFixture();
      fixture.getIdempotency.mockReset();
      fixture.getIdempotency
        .mockResolvedValueOnce(null)
        .mockImplementation(() => {
          const persisted = fixture.persistedIdempotency();
          if (
            persisted === null ||
            persisted.status !== "completed" ||
            persisted.finalResult === null ||
            persisted.finalResult.envelope.data?.kind !== "preview"
          ) {
            return Promise.reject(
              new Error("Expected postwrite rollback idempotency state."),
            );
          }
          return Promise.resolve({
            ...persisted,
            finalResult: {
              ...persisted.finalResult,
              envelope: {
                ...persisted.finalResult.envelope,
                data: {
                  ...persisted.finalResult.envelope.data,
                  target_release_id: "R_postwrite_envelope_drift",
                },
              },
            },
          });
        });

      await expect(
        fixture.assembly.service.createDeploymentPreview(
          adminContext(),
          fixture.request,
          previewMeta(fixture.request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      await expect(
        fixture.assembly.service.getState(adminContext()),
      ).rejects.toMatchObject({ code: "fatal" });
    });

    it("binds both rollback request and preview canonical hashes to target release ID", async () => {
      const firstRequest = rollbackPreviewRequest("R0");
      const secondRequest = rollbackPreviewRequest("R_older");
      expect(previewMeta(firstRequest).requestHash).not.toBe(
        previewMeta(secondRequest).requestHash,
      );

      const firstFixture = rollbackFixture({ targetReleaseId: "R0" });
      const secondFixture = rollbackFixture({ targetReleaseId: "R_older" });
      const first = await firstFixture.assembly.service.createDeploymentPreview(
        adminContext(),
        firstFixture.request,
        previewMeta(firstFixture.request),
      );
      const second = await secondFixture.assembly.service.createDeploymentPreview(
        adminContext(),
        secondFixture.request,
        previewMeta(secondFixture.request),
      );
      if (
        first.data?.kind !== "preview" ||
        second.data?.kind !== "preview"
      ) {
        throw new Error("Expected successful rollback preview envelopes.");
      }

      expect(first.data.base_release_id).toBe(second.data.base_release_id);
      expect(first.data.base_revision).toBe(second.data.base_revision);
      expect(first.data.desired_modules).toEqual(second.data.desired_modules);
      expect(first.data.validation).toEqual(second.data.validation);
      expect(first.data.created_at).toBe(second.data.created_at);
      expect(first.data.expires_at).toBe(second.data.expires_at);
      expect(first.data.target_release_id).not.toBe(second.data.target_release_id);
      expect(first.data.canonical_hash).not.toBe(second.data.canonical_hash);
    });

    it("does not mutate rollback target release, target readback, or release history", async () => {
      const fixture = rollbackFixture();
      const targetReleaseRef = fixture.targetRelease;
      const targetModulesRef = fixture.targetRelease.desiredModules;
      const targetReadbackRef = fixture.validTargetReadback;
      const appliedModulesRef = fixture.validTargetReadback.appliedModules;
      const releaseHistoryRef = fixture.state.releaseHistory;
      const before = JSON.stringify({
        targetRelease: fixture.targetRelease,
        targetReadback: fixture.validTargetReadback,
        releaseHistory: fixture.state.releaseHistory,
      });

      const result = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        previewMeta(fixture.request),
      );

      expect(result.status).toBe("success");
      expect(JSON.stringify({
        targetRelease: fixture.targetRelease,
        targetReadback: fixture.validTargetReadback,
        releaseHistory: fixture.state.releaseHistory,
      })).toBe(before);
      expect(fixture.targetRelease).toBe(targetReleaseRef);
      expect(fixture.targetRelease.desiredModules).toBe(targetModulesRef);
      expect(fixture.validTargetReadback).toBe(targetReadbackRef);
      expect(fixture.validTargetReadback.appliedModules).toBe(appliedModulesRef);
      expect(fixture.state.releaseHistory).toBe(releaseHistoryRef);
    });

    const strictRollbackParserCases: readonly [
      string,
      () => {
        readonly request: DeploymentPreviewRequest;
        readonly sideEffectCalls: () => number;
      },
    ][] = [
      [
        "extra field",
        () => {
          const request = {
            ...rollbackPreviewRequest(),
            extra: "rejected",
          };
          return { request, sideEffectCalls: () => 0 };
        },
      ],
      [
        "invalid target identifier",
        () => ({
          request: {
            schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
            intent: "rollback",
            target_release_id: "invalid target id",
          },
          sideEffectCalls: () => 0,
        }),
      ],
      [
        "accessor getter",
        () => {
          let getterCalls = 0;
          const request = {};
          Object.defineProperties(request, {
            schema_version: {
              enumerable: true,
              value: ADMIN_CONTROL_SCHEMA_VERSION,
            },
            intent: { enumerable: true, value: "rollback" },
            target_release_id: {
              enumerable: true,
              get() {
                getterCalls += 1;
                return "R0";
              },
            },
          });
          return {
            request: request as DeploymentPreviewRequest,
            sideEffectCalls: () => getterCalls,
          };
        },
      ],
      [
        "Proxy",
        () => {
          let trapCalls = 0;
          const request = new Proxy<DeploymentPreviewRequest>(
            rollbackPreviewRequest(),
            {
              get(target, property, receiver) {
                trapCalls += 1;
                if (property === "schema_version") return target.schema_version;
                if (property === "intent") return target.intent;
                if (
                  property === "target_release_id" &&
                  target.intent === "rollback"
                ) {
                  return target.target_release_id;
                }
                void receiver;
                return undefined;
              },
              ownKeys(target) {
                trapCalls += 1;
                return Reflect.ownKeys(target);
              },
            },
          );
          return { request, sideEffectCalls: () => trapCalls };
        },
      ],
    ];

    it.each(strictRollbackParserCases)(
      "strictly rejects rollback request with %s without touching dependencies",
      async (_label, createCase) => {
        const fixture = rollbackFixture();
        const { request, sideEffectCalls } = createCase();

        const result = await fixture.assembly.service.createDeploymentPreview(
          adminContext(),
          request,
          placeholderMeta(),
        );

        expect(result).toMatchObject({
          status: "blocked",
          data: null,
          reason_codes: ["preview_request_invalid"],
        });
        expect(sideEffectCalls()).toBe(0);
        expectNoPreviewDependencies(fixture);
      },
    );

    it("blocks rollback request hash mismatch before repository or activation reads", async () => {
      const fixture = rollbackFixture();
      const metaForAnotherTarget = previewMeta(
        rollbackPreviewRequest("R_other"),
      );

      const result = await fixture.assembly.service.createDeploymentPreview(
        adminContext(),
        fixture.request,
        metaForAnotherTarget,
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["request_hash_mismatch"],
      });
      expectNoPreviewDependencies(fixture);
    });

    it("accepts the shared RFC request and preview golden vectors", () => {
      const descriptorDigest = `sha256:${"1".repeat(64)}` as const;
      const requestHash = canonicalControlHash({
        domain: "request",
        schemaVersion: ADMIN_CONTROL_SCHEMA_VERSION,
        payload: {
          action: "packages.register",
          management_tenant_id: MANAGEMENT_TENANT_ID,
          actor_ref: "actor_operator",
          request: {
            schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
            module_id: "cargo",
            version: "1.0.0",
            descriptor_digest: descriptorDigest,
          },
        },
      }).hash;
      const previewHash = canonicalControlHash({
        domain: "preview",
        schemaVersion: ADMIN_CONTROL_SCHEMA_VERSION,
        payload: {
          action: "deployments.preview",
          management_tenant_id: MANAGEMENT_TENANT_ID,
          creator_actor_ref: "actor_operator",
          intent: "change",
          base_release_revision: 0,
          inventory_refs: [
            {
              module_id: "cargo",
              version: "1.0.0",
              descriptor_digest: descriptorDigest,
            },
          ],
          desired_modules: [
            {
              module_id: "cargo",
              version: "1.0.0",
              descriptor_digest: descriptorDigest,
            },
          ],
          policy_version: "writable-module-control-plane-v1",
          schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
          validation: {
            base_matches: true,
            desired_modules_valid: true,
            inventory_matches: true,
            minimum_active_modules: true,
            reason_codes: [],
          },
          preview_ttl_seconds: 900,
        },
      }).hash;

      expect(requestHash).toBe(
        "mcp-control-hash/v1/request/sha256:1dc6b77eedfc0639d6fb264c4e0557bdeb39a46bbabb968db13a6be7ee8c86da",
      );
      expect(previewHash).toBe(
        "mcp-control-hash/v1/preview/sha256:13348c6594c3d24cc30aeb62f839e6b6fd1fe133830a2fdad11b8d4b59b6e503",
      );
    });
  });

  describe("decideApproval", () => {
    it("creates an approve decision bound to a preview from a different admin", async () => {
      const idGenerator = vi
        .fn<() => string>()
        .mockReturnValueOnce("preview_for_approval_001")
        .mockReturnValueOnce("approval_approve_001");
      const clock = vi.fn(() => "2026-08-25T01:00:00Z");
      const { assembly, repository } = fakeAssembly({ clock, idGenerator });
      const registrationRequest = registerRequest();
      await assembly.service.registerPackage(
        adminContext(),
        registrationRequest,
        registerMeta(registrationRequest),
      );
      const previewRequest = changePreviewRequest();
      const preview = await assembly.service.createDeploymentPreview(
        adminContext(),
        previewRequest,
        previewMeta(previewRequest),
      );
      if (preview.data?.kind !== "preview") {
        throw new Error("Expected a persisted preview.");
      }
      const request: ApprovalRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        preview_ref: preview.data.preview_ref!,
        decision: "approve",
        reason_code: "approved",
      };

      const result = await assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toEqual({
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        request_id: "request_approval_service_001",
        trace_id: "trace_approval_service_001",
        audit_id: "audit_approval_service_001",
        status: "success",
        data: {
          kind: "approval",
          approval_id: "approval_approve_001",
          preview_ref: preview.data.preview_ref,
          decision: "approve",
        },
        reason_codes: [],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });
      const approvalWrite = repository.calls.find(
        (call) => call.method === "decideApproval",
      );
      if (approvalWrite?.method !== "decideApproval") {
        throw new Error("Expected decideApproval write.");
      }
      expect(approvalWrite.request).toMatchObject({
        metadata: {
          managementTenantId: MANAGEMENT_TENANT_ID,
          actorRef: "actor_approver",
          action: "approvals.decide",
          idempotencyKey: "idem_approval_service_001",
          requestHash: approvalMeta(request).requestHash,
          event: {
            action: "approvals.decide",
            objectRef: "approval_approve_001",
            kind: "approval",
            status: "approved",
            reasonCodes: [],
            detail: {
              kind: "approval",
              approvalId: "approval_approve_001",
              previewRef: preview.data.preview_ref,
              status: "approved",
            },
          },
        },
        record: {
          managementTenantId: MANAGEMENT_TENANT_ID,
          approvalId: "approval_approve_001",
          previewRef: preview.data.preview_ref,
          decision: "approve",
          previewCanonicalHash: preview.data.canonical_hash,
          baseReleaseId: preview.data.base_release_id,
          baseRevision: preview.data.base_revision,
          inventoryDigestSet: [inventory[0]!.descriptorDigest],
          expiresAt: preview.data.expires_at,
          reasonCode: "approved",
          approverActorRef: "actor_approver",
          decidedAt: "2026-08-25T01:00:00Z",
          consumed: false,
        },
        finalResult: {
          domainRecordRef: "approval_approve_001",
          envelope: result,
        },
      });
      const state = await repository.getControlState();
      expect(state.latestApproval).toEqual({
        managementTenantId: MANAGEMENT_TENANT_ID,
        approvalId: "approval_approve_001",
        previewRef: preview.data.preview_ref,
        decision: "approve",
        previewCanonicalHash: preview.data.canonical_hash,
        baseReleaseId: preview.data.base_release_id,
        baseRevision: preview.data.base_revision,
        inventoryDigestSet: [inventory[0]!.descriptorDigest],
        expiresAt: preview.data.expires_at,
        reasonCode: "approved",
        approverActorRef: "actor_approver",
        decidedAt: "2026-08-25T01:00:00Z",
        consumed: false,
      });
      expect(state.latestPreview?.consumed).toBe(false);
      expect(state.events.at(-1)).toMatchObject({
        managementTenantId: MANAGEMENT_TENANT_ID,
        actorRef: "actor_approver",
        action: "approvals.decide",
        objectRef: "approval_approve_001",
        kind: "approval",
        status: "approved",
        reasonCodes: [],
      });
    });

    it("creates a terminal reject decision without consuming the preview", async () => {
      const fixture = await changeApprovalFixture();
      const request = approvalRequest(fixture.previewRef, {
        decision: "reject",
        reason_code: "rejected_policy",
      });

      const result = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toMatchObject({
        status: "success",
        data: {
          kind: "approval",
          preview_ref: request.preview_ref,
          decision: "reject",
        },
        reason_codes: [],
      });
      const state = await fixture.repository.getControlState();
      expect(state.latestApproval).toMatchObject({
        previewRef: request.preview_ref,
        decision: "reject",
        reasonCode: "rejected_policy",
        approverActorRef: "actor_approver",
        consumed: false,
      });
      expect(state.latestPreview?.consumed).toBe(false);
      expect(state.events.at(-1)).toMatchObject({
        kind: "approval",
        status: "rejected",
        detail: { kind: "approval", status: "rejected" },
      });
    });

    const strictApprovalCases: readonly [
      string,
      () => {
        readonly request: unknown;
        readonly sideEffectCalls: () => number;
      },
    ][] = [
      [
        "extra field",
        () => ({
          request: {
            ...approvalRequest("preview_strict_approval"),
            unexpected: "field",
          },
          sideEffectCalls: () => 0,
        }),
      ],
      [
        "accessor getter",
        () => {
          let getterCalls = 0;
          const request = approvalRequest("preview_strict_approval") as Record<
            string,
            unknown
          >;
          Object.defineProperty(request, "decision", {
            enumerable: true,
            get() {
              getterCalls += 1;
              throw new Error("approval decision getter");
            },
          });
          return { request, sideEffectCalls: () => getterCalls };
        },
      ],
      [
        "Proxy",
        () => {
          let proxyCalls = 0;
          const request = new Proxy(approvalRequest("preview_strict_approval"), {
            get() {
              proxyCalls += 1;
              throw new Error("approval request proxy");
            },
            ownKeys() {
              proxyCalls += 1;
              throw new Error("approval request proxy keys");
            },
          });
          return { request, sideEffectCalls: () => proxyCalls };
        },
      ],
    ];

    it.each(strictApprovalCases)(
      "strictly rejects an approval request with %s before dependencies",
      async (_label, makeCase) => {
        const input = makeCase();
        const validRequest = approvalRequest("preview_strict_approval");
        const runtime = fakeAssembly();

        const result = await runtime.assembly.service.decideApproval(
          adminContext({ actorId: "actor_approver" }),
          input.request as ApprovalRequest,
          approvalMeta(validRequest),
        );

        expect(result).toMatchObject({
          status: "blocked",
          data: null,
          reason_codes: ["approval_request_invalid"],
        });
        expect(input.sideEffectCalls()).toBe(0);
        expect(runtime.repository.calls).toEqual([]);
        expect(runtime.clock).not.toHaveBeenCalled();
        expect(runtime.idGenerator).not.toHaveBeenCalled();
      },
    );

    it("binds the canonical approval request hash before repository or clock access", async () => {
      const request = approvalRequest("preview_hash_mismatch");
      const runtime = fakeAssembly();

      const result = await runtime.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request, {
          requestHash: `mcp-control-hash/v1/request/sha256:${"f".repeat(64)}`,
        }),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["request_hash_mismatch"],
      });
      expect(runtime.repository.calls).toEqual([]);
      expect(runtime.clock).not.toHaveBeenCalled();
      expect(runtime.idGenerator).not.toHaveBeenCalled();
    });

    it("blocks the preview creator from deciding their own approval", async () => {
      const fixture = await changeApprovalFixture();
      const request = approvalRequest(fixture.previewRef);
      const repositoryCalls = fixture.repository.calls.length;
      const clockCalls = fixture.clock.mock.calls.length;
      const idCalls = fixture.idGenerator.mock.calls.length;

      const result = await fixture.assembly.service.decideApproval(
        adminContext(),
        request,
        approvalMeta(request, {}, "actor_admin"),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["approval_self_approval_forbidden"],
      });
      expect(
        fixture.repository.calls
          .slice(repositoryCalls)
          .map((call) => call.method),
      ).toEqual(["getIdempotency", "getPreview"]);
      expect(fixture.clock).toHaveBeenCalledTimes(clockCalls);
      expect(fixture.idGenerator).toHaveBeenCalledTimes(idCalls);
    });

    it("blocks a missing preview without time, ID, or write side effects", async () => {
      const request = approvalRequest("preview_missing");
      const runtime = fakeAssembly();

      const result = await runtime.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["preview_not_found"],
      });
      expect(runtime.repository.calls.map((call) => call.method)).toEqual([
        "getIdempotency",
        "getPreview",
      ]);
      expect(runtime.clock).not.toHaveBeenCalled();
      expect(runtime.idGenerator).not.toHaveBeenCalled();
    });

    it.each([
      ["at the exact expiry instant", "2026-08-25T01:15:00Z"],
      ["after the expiry instant", "2026-08-25T01:15:00.000000001Z"],
    ])("blocks a preview %s", async (_label, decidedAt) => {
      const fixture = await changeApprovalFixture();
      fixture.clock.mockReturnValue(decidedAt);
      const request = approvalRequest(fixture.previewRef);
      const idCalls = fixture.idGenerator.mock.calls.length;

      const result = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["preview_expired"],
      });
      expect(fixture.idGenerator).toHaveBeenCalledTimes(idCalls);
      expect(
        fixture.repository.calls.filter(
          (call) => call.method === "decideApproval",
        ),
      ).toHaveLength(0);
    });

    it("blocks an already-consumed preview before time, ID, or write access", async () => {
      const fixture = await changeApprovalFixture();
      const originalGetPreview = fixture.repository.getPreview.bind(
        fixture.repository,
      );
      vi.spyOn(fixture.repository, "getPreview").mockImplementation(
        async (query) => {
          const preview = await originalGetPreview(query);
          return preview === null ? null : { ...preview, consumed: true };
        },
      );
      const request = approvalRequest(fixture.previewRef);
      const clockCalls = fixture.clock.mock.calls.length;
      const idCalls = fixture.idGenerator.mock.calls.length;

      const result = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["preview_consumed"],
      });
      expect(fixture.clock).toHaveBeenCalledTimes(clockCalls);
      expect(fixture.idGenerator).toHaveBeenCalledTimes(idCalls);
      expect(
        fixture.repository.calls.filter(
          (call) => call.method === "decideApproval",
        ),
      ).toHaveLength(0);
    });

    it("blocks a canonically valid preview whose validation is not approvable", async () => {
      const fixture = await changeApprovalFixture();
      const invalidPreview = rehashPreviewRecord({
        ...fixture.previewRecord,
        validation: {
          ...fixture.previewRecord.validation,
          inventoryMatches: false,
          reasonCodes: ["inventory_drift"],
        },
      });
      vi.spyOn(fixture.repository, "getPreview").mockResolvedValue(invalidPreview);
      const request = approvalRequest(fixture.previewRef);
      const clockCalls = fixture.clock.mock.calls.length;
      const idCalls = fixture.idGenerator.mock.calls.length;

      const result = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["preview_not_approvable"],
      });
      expect(fixture.clock).toHaveBeenCalledTimes(clockCalls);
      expect(fixture.idGenerator).toHaveBeenCalledTimes(idCalls);
      expect(
        fixture.repository.calls.filter(
          (call) => call.method === "decideApproval",
        ),
      ).toHaveLength(0);
    });

    it("blocks a canonically valid preview when its pinned inventory has drifted", async () => {
      const fixture = await changeApprovalFixture();
      const driftedPreview = rehashPreviewRecord({
        ...fixture.previewRecord,
        inventoryRefs: [
          {
            ...fixture.previewRecord.inventoryRefs[0]!,
            descriptorDigest: `sha256:${"e".repeat(64)}`,
          },
        ],
      });
      vi.spyOn(fixture.repository, "getPreview").mockResolvedValue(
        driftedPreview,
      );
      const request = approvalRequest(fixture.previewRef);
      const clockCalls = fixture.clock.mock.calls.length;
      const idCalls = fixture.idGenerator.mock.calls.length;

      const result = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["inventory_drift"],
      });
      expect(fixture.clock).toHaveBeenCalledTimes(clockCalls);
      expect(fixture.idGenerator).toHaveBeenCalledTimes(idCalls);
      expect(
        fixture.repository.calls.filter(
          (call) => call.method === "decideApproval",
        ),
      ).toHaveLength(0);
    });

    it("maps a closed preview read to unavailable without creating an approval", async () => {
      const fixture = await changeApprovalFixture();
      fixture.repository.queueFailure("getPreview", "closed");
      const request = approvalRequest(fixture.previewRef);
      const clockCalls = fixture.clock.mock.calls.length;
      const idCalls = fixture.idGenerator.mock.calls.length;

      const result = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toMatchObject({
        status: "unavailable",
        data: null,
        reason_codes: ["repository_unavailable"],
      });
      expect(fixture.clock).toHaveBeenCalledTimes(clockCalls);
      expect(fixture.idGenerator).toHaveBeenCalledTimes(idCalls);
      expect(
        fixture.repository.calls.filter(
          (call) => call.method === "decideApproval",
        ),
      ).toHaveLength(0);
    });

    it("maps a closed atomic approval write to unavailable with no persisted decision", async () => {
      const fixture = await changeApprovalFixture();
      fixture.repository.queueFailure("decideApproval", "closed");
      const request = approvalRequest(fixture.previewRef);

      const result = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toMatchObject({
        status: "unavailable",
        data: null,
        reason_codes: ["repository_unavailable"],
      });
      const state = await fixture.repository.getControlState();
      expect(state.latestApproval).toBeNull();
      expect(state.latestPreview?.consumed).toBe(false);
    });

    it("trips fatal and fences readiness on a persisted preview hash contradiction", async () => {
      const fixture = await changeApprovalFixture();
      vi.spyOn(fixture.repository, "getPreview").mockResolvedValue({
        ...fixture.previewRecord,
        canonicalHash: `mcp-control-hash/v1/preview/sha256:${"f".repeat(64)}`,
      });
      const request = approvalRequest(fixture.previewRef);

      await expect(
        fixture.assembly.service.decideApproval(
          adminContext({ actorId: "actor_approver" }),
          request,
          approvalMeta(request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      await expect(
        fixture.assembly.service.getState(adminContext()),
      ).rejects.toMatchObject({ code: "fatal" });
      expect(
        fixture.repository.calls.filter(
          (call) => call.method === "decideApproval",
        ),
      ).toHaveLength(0);
    });

    it("replays the byte-identical persisted approval using only idempotency and approval reads", async () => {
      const fixture = await changeApprovalFixture();
      const request = approvalRequest(fixture.previewRef);
      const firstMeta = approvalMeta(request);
      const replayMeta = approvalMeta(request, {
        requestId: "request_approval_replay_002",
        traceId: "trace_approval_replay_002",
        auditId: "audit_approval_replay_002",
      });
      const first = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        firstMeta,
      );
      const repositoryCalls = fixture.repository.calls.length;
      const clockCalls = fixture.clock.mock.calls.length;
      const idCalls = fixture.idGenerator.mock.calls.length;

      const replay = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        replayMeta,
      );

      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
      expect(replay.request_id).toBe(firstMeta.requestId);
      expect(
        fixture.repository.calls
          .slice(repositoryCalls)
          .map((call) => call.method),
      ).toEqual(["getIdempotency", "getApproval"]);
      expect(fixture.clock).toHaveBeenCalledTimes(clockCalls);
      expect(fixture.idGenerator).toHaveBeenCalledTimes(idCalls);
    });

    it("trips fatal when replayed approval and final envelope jointly contradict the canonical request", async () => {
      const fixture = await changeApprovalFixture();
      const request = approvalRequest(fixture.previewRef);
      const meta = approvalMeta(request);
      await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        meta,
      );
      const originalGetIdempotency = fixture.repository.getIdempotency.bind(
        fixture.repository,
      );
      const originalGetApproval = fixture.repository.getApproval.bind(
        fixture.repository,
      );
      vi.spyOn(fixture.repository, "getIdempotency").mockImplementation(
        async (query) => {
          const persisted = await originalGetIdempotency(query);
          if (
            persisted === null ||
            persisted.status !== "completed" ||
            persisted.finalResult.envelope.data?.kind !== "approval"
          ) {
            throw new Error("Expected a completed approval replay.");
          }
          return {
            ...persisted,
            finalResult: {
              ...persisted.finalResult,
              envelope: {
                ...persisted.finalResult.envelope,
                data: {
                  ...persisted.finalResult.envelope.data,
                  decision: "reject",
                },
              },
            },
          };
        },
      );
      vi.spyOn(fixture.repository, "getApproval").mockImplementation(
        async (query) => {
          const persisted = await originalGetApproval(query);
          return persisted === null
            ? null
            : {
                ...persisted,
                decision: "reject",
                reasonCode: "rejected_policy",
              };
        },
      );

      await expect(
        fixture.assembly.service.decideApproval(
          adminContext({ actorId: "actor_approver" }),
          request,
          meta,
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      await expect(
        fixture.assembly.service.getState(adminContext()),
      ).rejects.toMatchObject({ code: "fatal" });
    });

    it("blocks a same-key different approval hash at idempotency preflight", async () => {
      const fixture = await changeApprovalFixture();
      const firstRequest = approvalRequest(fixture.previewRef);
      await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        firstRequest,
        approvalMeta(firstRequest),
      );
      const conflictingRequest = approvalRequest(
        fixture.previewRef,
        { decision: "reject", reason_code: "rejected_policy" },
      );
      const conflictingMeta = approvalMeta(conflictingRequest);
      expect(conflictingMeta.requestHash).not.toBe(
        approvalMeta(firstRequest).requestHash,
      );
      const repositoryCalls = fixture.repository.calls.length;
      const clockCalls = fixture.clock.mock.calls.length;
      const idCalls = fixture.idGenerator.mock.calls.length;

      const result = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        conflictingRequest,
        conflictingMeta,
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["approval_conflict"],
      });
      expect(
        fixture.repository.calls
          .slice(repositoryCalls)
          .map((call) => call.method),
      ).toEqual(["getIdempotency"]);
      expect(fixture.clock).toHaveBeenCalledTimes(clockCalls);
      expect(fixture.idGenerator).toHaveBeenCalledTimes(idCalls);
    });

    it("approves a rollback preview through the same decision path", async () => {
      const rollback = rollbackFixture();
      await rollback.assembly.service.createDeploymentPreview(
        adminContext(),
        rollback.request,
        previewMeta(rollback.request),
      );
      const preview = persistedRollbackArtifacts(rollback).preview;
      let persistedApproval: Awaited<
        ReturnType<ModuleControlRepository["getApproval"]>
      > = null;
      let persistedIdempotency: Awaited<
        ReturnType<ModuleControlRepository["getIdempotency"]>
      > = null;
      const getIdempotency = vi.fn(() => Promise.resolve(persistedIdempotency));
      const getPreview = vi.fn(() => Promise.resolve(preview));
      const getApproval = vi.fn(() => Promise.resolve(persistedApproval));
      const decideApproval = vi.fn<ModuleControlRepository["decideApproval"]>(
        (write) => {
          persistedApproval = write.record;
          persistedIdempotency = {
            managementTenantId: write.metadata.managementTenantId,
            action: write.metadata.action,
            idempotencyKey: write.metadata.idempotencyKey,
            requestHash: write.metadata.requestHash,
            actorRef: write.metadata.actorRef,
            createdAt: write.record.decidedAt,
            expiresAt: "2026-08-26T01:05:00Z",
            status: "completed",
            domainRecordRef: write.record.approvalId,
            finalResult: write.finalResult,
          };
          return Promise.resolve({
            record: write.record,
            event: {
              ...write.metadata.event,
              managementTenantId: write.metadata.managementTenantId,
              eventId: "event_approval_rollback",
              sequence: 1,
              actorRef: write.metadata.actorRef,
              occurredAt: write.record.decidedAt,
            },
            replayed: false,
          });
        },
      );
      const repository = repositoryStub({
        getIdempotency,
        getPreview,
        getApproval,
        decideApproval,
      });
      const clock = vi.fn(() => "2026-08-25T01:05:00Z");
      const idGenerator = vi.fn(() => "approval_rollback_001");
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock,
        idGenerator,
      });
      const request = approvalRequest(preview.previewRef);

      const result = await assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        request,
        approvalMeta(request),
      );

      expect(result).toMatchObject({
        status: "success",
        data: {
          kind: "approval",
          approval_id: "approval_rollback_001",
          preview_ref: preview.previewRef,
          decision: "approve",
        },
      });
      expect(decideApproval).toHaveBeenCalledTimes(1);
      expect(decideApproval.mock.calls[0]![0].record).toMatchObject({
        previewRef: preview.previewRef,
        previewCanonicalHash: preview.canonicalHash,
        baseReleaseId: preview.baseReleaseId,
        baseRevision: preview.baseRevision,
        expiresAt: preview.expiresAt,
      });
    });

    it("trips fatal when the approval postwrite event drifts from the atomic write", async () => {
      const fixture = await changeApprovalFixture();
      const originalDecideApproval = fixture.repository.decideApproval.bind(
        fixture.repository,
      );
      vi.spyOn(fixture.repository, "decideApproval").mockImplementation(
        async (write) => {
          const result = await originalDecideApproval(write);
          return {
            ...result,
            event: { ...result.event, actorRef: "actor_drifted" },
          };
        },
      );
      const request = approvalRequest(fixture.previewRef);

      await expect(
        fixture.assembly.service.decideApproval(
          adminContext({ actorId: "actor_approver" }),
          request,
          approvalMeta(request),
        ),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      await expect(
        fixture.assembly.service.getState(adminContext()),
      ).rejects.toMatchObject({ code: "fatal" });
    });

    it("keeps reject terminal when a new key later attempts approve", async () => {
      const fixture = await changeApprovalFixture();
      const rejectRequest = approvalRequest(fixture.previewRef, {
        decision: "reject",
        reason_code: "rejected_policy",
      });
      await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        rejectRequest,
        approvalMeta(rejectRequest),
      );
      const approveRequest = approvalRequest(fixture.previewRef);

      const result = await fixture.assembly.service.decideApproval(
        adminContext({ actorId: "actor_approver" }),
        approveRequest,
        approvalMeta(approveRequest, {
          idempotencyKey: "idem_approval_terminal_002",
          requestId: "request_approval_terminal_002",
          traceId: "trace_approval_terminal_002",
          auditId: "audit_approval_terminal_002",
        }),
      );

      expect(result).toMatchObject({
        status: "blocked",
        data: null,
        reason_codes: ["approval_conflict"],
      });
      const state = await fixture.repository.getControlState();
      expect(state.latestApproval).toMatchObject({
        decision: "reject",
        reasonCode: "rejected_policy",
      });
      expect(state.latestPreview?.consumed).toBe(false);
    });
  });

  describe("publish", () => {
    it("publishes an approved change as the first active verified release", async () => {
      const fixture = await firstActivationPublishFixture();

      expect(fixture.assembly.activation.snapshot()).toEqual({
        releaseId: null,
        revision: 0,
        activeModules: [],
      });

      const result = await fixture.assembly.service.publish(
        adminContext({ actorId: "actor_publisher" }),
        fixture.request,
        publishMeta(fixture.request),
      );

      expect(result).toMatchObject({
        status: "success",
        data: {
          kind: "release",
          release_id: "release_publish_change_001",
          revision: 1,
          active_modules: [
            {
              module_id: inventory[0]!.moduleId,
              version: inventory[0]!.version,
              descriptor_digest: inventory[0]!.descriptorDigest,
            },
          ],
        },
        reason_codes: [],
        readback: {
          status: "verified",
          release_id: "release_publish_change_001",
          revision: 1,
        },
      });
      expect(fixture.assembly.activation.snapshot()).toEqual({
        releaseId: "release_publish_change_001",
        revision: 1,
        activeModules: [
          {
            moduleId: inventory[0]!.moduleId,
            version: inventory[0]!.version,
            descriptorDigest: inventory[0]!.descriptorDigest,
          },
        ],
      });

      const state = await fixture.repository.getControlState();
      expect(state.activeRelease).toMatchObject({
        releaseId: "release_publish_change_001",
        revision: 1,
        status: "active_verified",
        readbackRef: "readback_publish_change_001",
      });
      expect(state.latestPreview).toMatchObject({ consumed: true });
      expect(state.latestApproval).toMatchObject({ consumed: true });
      expect(state.latestReadback).toMatchObject({
        readbackRef: "readback_publish_change_001",
        releaseId: "release_publish_change_001",
        revision: 1,
        status: "verified",
        attemptId: "attempt_publish_change_001",
      });
    });

    it("publishes an exact R2 over active R1 and supersedes R1 before committing the R2 gate", async () => {
      const firstRuntime = await registeredPublishRuntime([
        "preview_chain_R1",
        "approval_chain_R1",
        "R1",
        "attempt_chain_R1",
        "readback_chain_R1",
      ]);
      const first = await publishApprovedPreview(
        firstRuntime,
        changePreviewRequest(),
        "chain_r1",
      );
      expect(first.result).toMatchObject({
        status: "success",
        data: { kind: "release", release_id: "R1", revision: 1 },
      });
      const records = await legacyPublishedRecords(firstRuntime, [
        { suffix: "chain_r1", releaseId: "R1" },
      ]);
      const runtime = runtimeFromLegacyRecords(
        records,
        {
          releaseId: "R1",
          revision: 1,
          activeModules: [controlModuleRef()],
        },
        [
        "preview_chain_R2",
        "approval_chain_R2",
        "R2",
        "attempt_chain_R2",
        "readback_chain_R2",
        ],
        10,
        "boot_publish_chain_R2",
      );

      const second = await publishApprovedPreview(
        runtime,
        changePreviewRequest(),
        "chain_r2",
      );
      activationGateTestState.snapshotOverride = null;

      expect(second.result).toMatchObject({
        status: "success",
        data: {
          kind: "release",
          release_id: "R2",
          revision: 2,
          active_modules: [
            {
              module_id: inventory[0]!.moduleId,
              version: inventory[0]!.version,
              descriptor_digest: inventory[0]!.descriptorDigest,
            },
          ],
        },
        reason_codes: [],
        readback: { status: "verified", release_id: "R2", revision: 2 },
      });
      expect(runtime.assembly.activation.snapshot()).toEqual({
        releaseId: "R2",
        revision: 2,
        activeModules: [controlModuleRef()],
      });
      await expect(
        runtime.repository.getRelease({
          managementTenantId: MANAGEMENT_TENANT_ID,
          releaseId: "R1",
        }),
      ).resolves.toMatchObject({
        releaseId: "R1",
        revision: 1,
        status: "superseded",
        supersededByReleaseId: "R2",
      });
      const state = await runtime.repository.getControlState();
      expect(state.activeRelease).toMatchObject({
        releaseId: "R2",
        revision: 2,
        status: "active_verified",
      });
    });

    it("publishes rollback as a new R3 lineage without mutating target R0 evidence or prior history snapshots", async () => {
      const firstRuntime = await registeredPublishRuntime([
        "preview_rollback_R0",
        "approval_rollback_R0",
        "R0",
        "attempt_rollback_R0",
        "readback_rollback_R0",
      ]);
      await publishApprovedPreview(
        firstRuntime,
        changePreviewRequest(),
        "rollback_r0",
      );
      const firstRecords = await legacyPublishedRecords(firstRuntime, [
        { suffix: "rollback_r0", releaseId: "R0" },
      ]);
      const secondRuntime = runtimeFromLegacyRecords(
        firstRecords,
        {
          releaseId: "R0",
          revision: 1,
          activeModules: [controlModuleRef()],
        },
        [
        "preview_rollback_R1",
        "approval_rollback_R1",
        "R2",
        "attempt_rollback_R1",
        "readback_rollback_R1",
        ],
        10,
        "boot_publish_rollback_R2",
      );
      await publishApprovedPreview(
        secondRuntime,
        changePreviewRequest(),
        "rollback_r1",
      );
      activationGateTestState.snapshotOverride = null;
      const secondRecords = await legacyPublishedRecords(secondRuntime, [
        { suffix: "rollback_r0", releaseId: "R0" },
        { suffix: "rollback_r1", releaseId: "R2" },
      ]);
      const runtime = runtimeFromLegacyRecords(
        secondRecords,
        {
          releaseId: "R2",
          revision: 2,
          activeModules: [controlModuleRef()],
        },
        [
        "preview_rollback_R3",
        "approval_rollback_R3",
        "R3",
        "attempt_rollback_R3",
        "readback_rollback_R3",
        ],
        20,
        "boot_publish_rollback_R3",
      );
      const prepared = await createApprovedPublish(
        runtime,
        rollbackPreviewRequest("R0"),
        "rollback_r3",
      );
      const targetReleaseBefore = await runtime.repository.getRelease({
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: "R0",
      });
      const targetReadbackBefore = await runtime.repository.getReadback({
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId: "R0",
      });
      const historyBefore = (await runtime.repository.getControlState())
        .releaseHistory;
      const historySnapshot = structuredClone(historyBefore);

      const result = await runtime.assembly.service.publish(
        adminContext({ actorId: prepared.publisherActorRef }),
        prepared.publish,
        prepared.meta,
      );
      activationGateTestState.snapshotOverride = null;

      expect(result).toMatchObject({
        status: "success",
        data: { kind: "release", release_id: "R3", revision: 3 },
        reason_codes: [],
        readback: { status: "verified", release_id: "R3", revision: 3 },
      });
      expect(runtime.assembly.activation.snapshot()).toEqual({
        releaseId: "R3",
        revision: 3,
        activeModules: [controlModuleRef()],
      });
      expect(historyBefore).toEqual(historySnapshot);
      await expect(
        runtime.repository.getRelease({
          managementTenantId: MANAGEMENT_TENANT_ID,
          releaseId: "R0",
        }),
      ).resolves.toEqual(targetReleaseBefore);
      await expect(
        runtime.repository.getReadback({
          managementTenantId: MANAGEMENT_TENANT_ID,
          releaseId: "R0",
        }),
      ).resolves.toEqual(targetReadbackBefore);
      const state = await runtime.repository.getControlState();
      expect(state.releaseHistory).toContainEqual({
        release: targetReleaseBefore,
        intent: "change",
        rollbackTargetReleaseId: null,
      });
      const rollbackEntry = state.releaseHistory.find(
        (entry) => entry.release.releaseId === "R3",
      );
      expect(rollbackEntry).toMatchObject({
        intent: "rollback",
        rollbackTargetReleaseId: "R0",
      });
      expect(rollbackEntry?.release).toMatchObject({
        releaseId: "R3",
        revision: 3,
      });
    });
  });

  describe("runtime assembly and fatal boundary", () => {
    it("exposes only the service, diagnostic snapshot, and frozen dispatch capability", () => {
      const { assembly } = fakeAssembly();

      expect(Reflect.ownKeys(assembly).sort()).toEqual([
        "activation",
        "dispatch",
        "service",
      ]);
      expect(Reflect.ownKeys(assembly.activation)).toEqual(["snapshot"]);
      expect(Reflect.ownKeys(assembly.dispatch)).toEqual(["dispatch"]);
      expect(Object.isFrozen(assembly)).toBe(true);
      expect(Object.isFrozen(assembly.activation)).toBe(true);
      expect(Object.isFrozen(assembly.dispatch)).toBe(true);

      const forbidden = [
        "isActive",
        "driver",
        "privateDriver",
        "recoveryDriver",
        "coordinator",
        "tripFatal",
        "withMutation",
      ];
      for (const surface of [
        assembly,
        assembly.activation,
        assembly.dispatch,
        assembly.service,
      ]) {
        for (const key of forbidden) {
          expect(key in surface).toBe(false);
          expect((surface as unknown as Record<string, unknown>)[key]).toBeUndefined();
        }
      }
    });

    it("passes an opaque route identity to the gate inside the reader lock", async () => {
      const { assembly } = fakeAssembly();
      const handler = vi.fn(() => Promise.resolve("should-not-run"));
      let proxyReads = 0;
      const routeRef = new Proxy(
        {
          moduleId: inventory[0]!.moduleId,
          version: inventory[0]!.version,
          descriptorDigest: inventory[0]!.descriptorDigest,
        },
        {
          get() {
            proxyReads += 1;
            throw new Error("secret route trap");
          },
        },
      );

      await expect(
        assembly.dispatch.dispatch(routeRef, handler),
      ).rejects.toMatchObject({
        name: "ModuleControlServiceError",
        code: "module_not_active",
      });
      expect(proxyReads).toBe(0);
      expect(handler).not.toHaveBeenCalled();

      await expect(
        assembly.dispatch.dispatch(
          {
            moduleId: inventory[0]!.moduleId,
            version: inventory[0]!.version,
            descriptorDigest: inventory[0]!.descriptorDigest,
          },
          handler,
        ),
      ).rejects.toMatchObject({ code: "module_not_active" });
      expect(handler).not.toHaveBeenCalled();
    });

    it("latches producer corruption as a stable fatal error across service and dispatch", async () => {
      const request = registerRequest();
      const meta = registerMeta(request);
      const domainRecordRef = `registration:${request.module_id}:${request.version}:${request.descriptor_digest}`;
      const getControlState = vi.fn(() => Promise.resolve(emptyState()));
      const repository = repositoryStub({
        registerModule: vi.fn(() => Promise.resolve({} as never)),
        getIdempotency: vi.fn(() => Promise.resolve({
          managementTenantId: MANAGEMENT_TENANT_ID,
          action: "packages.register",
          idempotencyKey: meta.idempotencyKey,
          requestHash: meta.requestHash,
          actorRef: "actor_admin",
          status: "completed",
          domainRecordRef,
          finalResult: {
            domainRecordRef,
            envelope: {
              schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
              request_id: meta.requestId,
              trace_id: meta.traceId,
              audit_id: meta.auditId,
              status: "success",
              data: null,
              reason_codes: [],
              readback: {
                status: "not_applicable",
                release_id: null,
                revision: null,
              },
            } as ControlEnvelope,
          },
          createdAt: "2026-08-25T01:00:00Z",
          expiresAt: "2026-08-26T01:00:00Z",
        } as never)),
        getControlState,
      });
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock: () => "2026-08-25T01:00:00Z",
        idGenerator: () => "should_not_be_returned",
      });

      await expect(
        assembly.service.registerPackage(adminContext(), request, meta),
      ).rejects.toMatchObject({
        name: "RuntimeMutationFatalError",
        code: "fatal",
        message: "The runtime mutation coordinator is in a fatal state.",
      });
      await expect(
        assembly.service.getState(adminContext()),
      ).rejects.toMatchObject({ code: "fatal" });
      await expect(
        assembly.service.createDeploymentPreview(
          adminContext(),
          {
            schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
            intent: "change",
            desired_modules: [
              {
                module_id: inventory[0]!.moduleId,
                version: inventory[0]!.version,
                descriptor_digest: inventory[0]!.descriptorDigest,
              },
            ],
          },
          placeholderMeta(),
        ),
      ).rejects.toMatchObject({ code: "fatal" });
      const handler = vi.fn(() => Promise.resolve("should-not-run"));
      await expect(
        assembly.dispatch.dispatch(
          {
            moduleId: inventory[0]!.moduleId,
            version: inventory[0]!.version,
            descriptorDigest: inventory[0]!.descriptorDigest,
          },
          handler,
        ),
      ).rejects.toMatchObject({ code: "fatal" });
      expect(handler).not.toHaveBeenCalled();
      expect(getControlState).not.toHaveBeenCalled();
    });

    it("maps only an actual repository read failure to state_unavailable", async () => {
      const getControlState = vi.fn(() =>
        Promise.reject(new ModuleControlRepositoryError("closed")),
      );
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository: repositoryStub({ getControlState }),
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock: () => "2026-08-25T01:00:00Z",
        idGenerator: vi
          .fn<() => string>()
          .mockReturnValueOnce("request_state_unavailable")
          .mockReturnValueOnce("trace_state_unavailable")
          .mockReturnValueOnce("audit_state_unavailable"),
      });

      await expect(assembly.service.getState(adminContext())).resolves.toMatchObject({
        status: "unavailable",
        data: null,
        reason_codes: ["state_unavailable"],
      });
      expect(getControlState).toHaveBeenCalledTimes(1);
    });

    it("treats a repository tenant contradiction as fatal rather than unavailable", async () => {
      const contradictory = {
        ...emptyState(),
        managementTenantId: "tenant_other",
      };
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository: repositoryStub({
          getControlState: vi.fn(() => Promise.resolve(contradictory)),
        }),
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock: () => "2026-08-25T01:00:00Z",
        idGenerator: () => "state_fatal_id",
      });

      await expect(
        assembly.service.getState(adminContext()),
      ).rejects.toMatchObject({
        name: "RuntimeMutationFatalError",
        code: "fatal",
      });
    });

    it("trips fatal when getIdempotency fails after registerModule resolves", async () => {
      const request = registerRequest();
      const meta = registerMeta(request);
      const registerModule = vi.fn(() => Promise.resolve({} as never));
      const getIdempotency = vi.fn(() =>
        Promise.reject(new Error("post-write readback failed")),
      );
      const repository = repositoryStub({
        registerModule,
        getIdempotency,
      });
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock: () => "2026-08-25T01:00:00Z",
        idGenerator: () => "unused_generated_id",
      });

      await expect(
        assembly.service.registerPackage(adminContext(), request, meta),
      ).rejects.toBeInstanceOf(RuntimeMutationFatalError);
      expect(registerModule).toHaveBeenCalledTimes(1);
      expect(getIdempotency).toHaveBeenCalledTimes(1);
    });

    it("lets the latched fatal error dominate every service entry without touching inputs", async () => {
      const request = registerRequest();
      const meta = registerMeta(request);
      const getControlState = vi.fn(() => Promise.resolve(emptyState()));
      const registerModule = vi.fn(() => Promise.resolve({} as never));
      const getIdempotency = vi.fn(() =>
        Promise.reject(new Error("post-write readback failed")),
      );
      const repository = repositoryStub({
        registerModule,
        getIdempotency,
        getControlState,
      });
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock: () => "2026-08-25T01:00:00Z",
        idGenerator: () => "unused_generated_id",
      });

      let fatal: unknown;
      try {
        await assembly.service.registerPackage(adminContext(), request, meta);
      } catch (error: unknown) {
        fatal = error;
      }
      expect(fatal).toBeInstanceOf(RuntimeMutationFatalError);

      let proxyTrapCalls = 0;
      const trapHandler: ProxyHandler<object> = {
        get() {
          proxyTrapCalls += 1;
          throw new Error("fatal test request/meta trap");
        },
        getOwnPropertyDescriptor() {
          proxyTrapCalls += 1;
          throw new Error("fatal test descriptor trap");
        },
        getPrototypeOf() {
          proxyTrapCalls += 1;
          throw new Error("fatal test prototype trap");
        },
        has() {
          proxyTrapCalls += 1;
          throw new Error("fatal test has trap");
        },
        ownKeys() {
          proxyTrapCalls += 1;
          throw new Error("fatal test keys trap");
        },
      };
      const invalidMetaProxy = new Proxy({}, trapHandler) as WriteMeta;
      const requestProxy = new Proxy({}, trapHandler);
      const unauthorizedContext = {} as ExecutionContext;

      const calls = [
        () => assembly.service.getState(unauthorizedContext),
        () =>
          assembly.service.registerPackage(
            unauthorizedContext,
            requestProxy as RegisterPackageRequest,
            invalidMetaProxy,
          ),
        () =>
          assembly.service.createDeploymentPreview(
            unauthorizedContext,
            requestProxy as DeploymentPreviewRequest,
            invalidMetaProxy,
          ),
        () =>
          assembly.service.decideApproval(
            unauthorizedContext,
            requestProxy as ApprovalRequest,
            invalidMetaProxy,
          ),
        () =>
          assembly.service.publish(
            unauthorizedContext,
            requestProxy as PublishRequest,
            invalidMetaProxy,
          ),
        () =>
          assembly.service.reconcile(
            unauthorizedContext,
            requestProxy as ReconcileRequest,
            invalidMetaProxy,
          ),
      ];

      for (const call of calls) {
        await expect(call()).rejects.toBe(fatal);
      }
      expect(proxyTrapCalls).toBe(0);
      expect(getControlState).not.toHaveBeenCalled();
      expect(registerModule).toHaveBeenCalledTimes(1);
      expect(getIdempotency).toHaveBeenCalledTimes(1);
    });
  });

  describe("six-method surface and fail-closed phase placeholders", () => {
    it("defines exactly the planned six public service methods", () => {
      const { assembly } = fakeAssembly();
      expect(
        Object.getOwnPropertyNames(Object.getPrototypeOf(assembly.service)).sort(),
      ).toEqual([
        "constructor",
        "createDeploymentPreview",
        "decideApproval",
        "getState",
        "publish",
        "reconcile",
        "registerPackage",
      ]);
    });

    it("returns a producer-validated unavailable envelope for reconcile while it remains unimplemented", async () => {
      const getControlState = vi.fn(() => Promise.resolve(emptyState()));
      const repository = repositoryStub({ getControlState });
      const clock = vi.fn(() => "2026-08-25T01:00:00Z");
      const idGenerator = vi.fn(() => "unused_generated_id");
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock,
        idGenerator,
      });
      const context = adminContext();
      const meta = placeholderMeta();
      const reconcileRequest: ReconcileRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        release_id: "release_placeholder_001",
      };

      const result = await assembly.service.reconcile(
        context,
        reconcileRequest,
        meta,
      );

      expect(result).toEqual({
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "unavailable",
        data: null,
        reason_codes: ["service_phase_not_implemented"],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(clock).not.toHaveBeenCalled();
      expect(idGenerator).not.toHaveBeenCalled();
      expect(getControlState).not.toHaveBeenCalled();
    });
  });

  it("keeps internal authority imports and raw factories out of production surfaces", () => {
    const sourceRoot = fileURLToPath(
      new URL("../../src/logistics_mcp/", import.meta.url),
    );
    const sourceFiles = productionTypeScriptFiles(sourceRoot);
    const importersOf = (specifier: string) =>
      sourceFiles
        .filter((path) => readFileSync(path, "utf8").includes(specifier))
        .map((path) => relative(sourceRoot, path))
        .sort();

    expect(importersOf("./activation-authority-internal")).toEqual([
      "control-plane/activation-registry.ts",
      "control-plane/service.ts",
    ]);
    expect(importersOf("./runtime-mutation-coordinator")).toEqual([
      "control-plane/service.ts",
    ]);

    const publicIndex = readFileSync(
      resolve(sourceRoot, "control-plane/index.ts"),
      "utf8",
    );
    for (const forbidden of [
      "activation-authority-internal",
      "runtime-mutation-coordinator",
      "createActivationGate",
      "createRuntimeMutationCoordinator",
      "ActivationAuthorityDriver",
      "ActivationRecoveryDriver",
      "RuntimeMutationCoordinator",
    ]) {
      expect(publicIndex).not.toContain(forbidden);
    }
  });
});
