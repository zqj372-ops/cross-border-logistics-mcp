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
  ModuleControlState,
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
import { FakeModuleControlRepository } from "./fake-control-repository";

const activationGateTestState = vi.hoisted(() => ({
  snapshotOverride: null as ModuleActivationSnapshot | null,
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
          snapshot: () => snapshotOverride,
          isActive: (
            ref: ModuleActivationSnapshot["activeModules"][number],
          ) =>
            snapshotOverride.activeModules.some(
              (active) =>
                active.moduleId === ref.moduleId &&
                active.version === ref.version &&
                active.descriptorDigest === ref.descriptorDigest,
            ),
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
} = {}) {
  const repository = options.repository ?? new FakeModuleControlRepository({
    managementTenantId: MANAGEMENT_TENANT_ID,
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
    }),
    clock,
    idGenerator,
    repository,
  };
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

    it("keeps rollback preview fail-closed with a producer-valid blocked reason", async () => {
      const repository = new FakeModuleControlRepository({
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      const clock = vi.fn(() => "2026-08-25T01:00:00Z");
      const idGenerator = vi.fn(() => "rollback_should_not_exist");
      const { assembly } = fakeAssembly({ repository, clock, idGenerator });
      const request: DeploymentPreviewRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        intent: "rollback",
        target_release_id: "release_previous_001",
      };

      const result = await assembly.service.createDeploymentPreview(
        adminContext(),
        request,
        previewMeta(request),
      );

      expect(result).toEqual({
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        request_id: "request_preview_service_001",
        trace_id: "trace_preview_service_001",
        audit_id: "audit_preview_service_001",
        status: "blocked",
        data: null,
        reason_codes: ["rollback_preview_not_implemented"],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });
      expect(repository.calls).toEqual([]);
      expect(clock).not.toHaveBeenCalled();
      expect(idGenerator).not.toHaveBeenCalled();
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

    it("returns action-specific producer-validated unavailable envelopes for three unimplemented methods", async () => {
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
      const approvalRequest: ApprovalRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        preview_ref: "preview_placeholder_001",
        decision: "approve",
        reason_code: "approved",
      };
      const publishRequest: PublishRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        preview_ref: "preview_placeholder_001",
        approval_id: "approval_placeholder_001",
      };
      const reconcileRequest: ReconcileRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        release_id: "release_placeholder_001",
      };

      const results = [
        await assembly.service.decideApproval(context, approvalRequest, meta),
        await assembly.service.publish(context, publishRequest, meta),
        await assembly.service.reconcile(context, reconcileRequest, meta),
      ];

      for (const result of results) {
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
      }
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
