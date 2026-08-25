import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context";
import { canonicalControlHash } from "../../src/logistics_mcp/control-plane/canonical-control-hash";
import type {
  ApprovalRequest,
  ControlEnvelope,
  DeploymentPreviewRequest,
  PublishRequest,
  ReconcileRequest,
  RegisterPackageRequest,
} from "../../src/logistics_mcp/control-plane/contracts";
import { createModuleInventory } from "../../src/logistics_mcp/control-plane/inventory";
import type {
  ModuleControlRepository,
  ModuleControlState,
} from "../../src/logistics_mcp/control-plane/repository";
import { ModuleControlRepositoryError } from "../../src/logistics_mcp/control-plane/repository";
import { ADMIN_CONTROL_SCHEMA_VERSION } from "../../src/logistics_mcp/control-plane/types";
import {
  createModuleControlRuntimeAssembly,
  type WriteMeta,
} from "../../src/logistics_mcp/control-plane/service";
import { RuntimeMutationFatalError } from "../../src/logistics_mcp/control-plane/runtime-mutation-coordinator";
import { FakeModuleControlRepository } from "./fake-control-repository";

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

    it("returns action-specific producer-validated unavailable envelopes for four unimplemented methods", async () => {
      const getControlState = vi.fn(() => Promise.resolve(emptyState()));
      const repository = repositoryStub({ getControlState });
      const clock = vi.fn(() => "2026-08-25T01:00:00Z");
      const idGenerator = vi.fn(() => "unused_generated_id");
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        clock,
        idGenerator,
      });
      const context = adminContext();
      const meta = placeholderMeta();
      const previewRequest: DeploymentPreviewRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        intent: "change",
        desired_modules: [{
          module_id: inventory[0]!.moduleId,
          version: inventory[0]!.version,
          descriptor_digest: inventory[0]!.descriptorDigest,
        }],
      };
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
        await assembly.service.createDeploymentPreview(
          context,
          previewRequest,
          meta,
        ),
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
