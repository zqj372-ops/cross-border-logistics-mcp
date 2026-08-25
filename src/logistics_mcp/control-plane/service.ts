import { types as nodeTypes } from "node:util";

import type { ExecutionContext } from "../platform/context";
import { isTrustedExecutionContext } from "../platform/context";
import { canonicalControlHash } from "./canonical-control-hash";
import {
  assertControlProducerEnvelope,
  controlEnvelopeSchema,
  registerPackageRequestSchema,
  type ApprovalRequest,
  type ControlEnvelope,
  type ControlProducerAction,
  type DeepFrozen,
  type DeploymentPreviewRequest,
  type PublishRequest,
  type ReconcileRequest,
  type RegisterPackageRequest,
} from "./contracts";
import {
  createActivationGate,
  type ActivationAuthorityDriver,
  type ActivationRecoveryDriver,
} from "./activation-authority-internal";
import {
  createRuntimeMutationCoordinator,
  RuntimeMutationFatalError,
  type RuntimeMutationCoordinator,
} from "./runtime-mutation-coordinator";
import {
  isRequestHash,
  ModuleControlRepositoryError,
  type CanonicalRequestHash,
  type ControlFinalResult,
  type ModuleControlRepository,
  type ModuleRegistrationRecord,
  type RegisterModuleRequestMetadata,
} from "./repository";
import type { ModuleControlState } from "./repository";
import { IDENTIFIER_PATTERN } from "./lexical-contracts";
import { mapControlStateToDto } from "./control-state-mapper";
import type {
  ActiveModuleRef,
  ModuleActivationSnapshot,
  TrustedModuleInventory,
} from "./types";
import { ModuleControlServiceError, type ModuleControlServiceErrorCode } from "./errors";

const AUTH_FAILURE_REQUEST_ID = "control_auth_denied";
const AUTH_FAILURE_TRACE_ID = "control_auth_denied";
const AUTH_FAILURE_AUDIT_ID = "control_auth_denied";

export interface ModuleControlService {
  getState(context: ExecutionContext): Promise<DeepFrozen<ControlEnvelope>>;
  registerPackage(
    context: ExecutionContext,
    request: RegisterPackageRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
  createDeploymentPreview(
    context: ExecutionContext,
    request: DeploymentPreviewRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
  decideApproval(
    context: ExecutionContext,
    request: ApprovalRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
  publish(
    context: ExecutionContext,
    request: PublishRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
  reconcile(
    context: ExecutionContext,
    request: ReconcileRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>>;
}

export interface WriteMeta {
  readonly idempotencyKey: string;
  readonly requestHash: CanonicalRequestHash;
  readonly requestId: string;
  readonly traceId: string;
  readonly auditId: string;
}

export interface ModuleControlRuntimeAssemblyOptions {
  readonly inventory: TrustedModuleInventory;
  readonly repository: ModuleControlRepository;
  readonly managementTenantId: string;
  readonly clock: () => string;
  readonly idGenerator: () => string;
}

export interface ActivationReadFacade {
  readonly snapshot: () => ModuleActivationSnapshot;
}

export interface ControlledDispatchFacade {
  readonly dispatch: <T>(
    ref: ActiveModuleRef,
    handler: () => Promise<T> | T,
  ) => Promise<T>;
}

export interface ModuleControlRuntimeAssembly {
  readonly service: ModuleControlService;
  readonly activation: ActivationReadFacade;
  readonly dispatch: ControlledDispatchFacade;
}

interface PrivateRuntimeCapabilities {
  readonly coordinator: RuntimeMutationCoordinator;
  readonly privateDriver: ActivationAuthorityDriver;
  readonly recoveryDriver: ActivationRecoveryDriver;
}

interface ActivationDispatchGate extends ActivationReadFacade {
  readonly isActive: (ref: ActiveModuleRef) => boolean;
}

const WRITE_META_KEYS = [
  "idempotencyKey",
  "requestHash",
  "requestId",
  "traceId",
  "auditId",
] as const;
const REGISTER_REQUEST_KEYS = [
  "schema_version",
  "module_id",
  "version",
  "descriptor_digest",
] as const;

function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function parseWriteMeta(value: unknown): WriteMeta {
  const snapshot = snapshotExactRecord(value, WRITE_META_KEYS);
  if (
    snapshot === null ||
    typeof snapshot.idempotencyKey !== "string" ||
    !IDENTIFIER_PATTERN.test(snapshot.idempotencyKey) ||
    !isRequestHash(snapshot.requestHash) ||
    typeof snapshot.requestId !== "string" ||
    !IDENTIFIER_PATTERN.test(snapshot.requestId) ||
    typeof snapshot.traceId !== "string" ||
    !IDENTIFIER_PATTERN.test(snapshot.traceId) ||
    typeof snapshot.auditId !== "string" ||
    !IDENTIFIER_PATTERN.test(snapshot.auditId)
  ) {
    throw new ModuleControlServiceError("write_meta_invalid");
  }
  return Object.freeze({
    idempotencyKey: snapshot.idempotencyKey,
    requestHash: snapshot.requestHash,
    requestId: snapshot.requestId,
    traceId: snapshot.traceId,
    auditId: snapshot.auditId,
  });
}

function parseRegisterRequest(value: unknown): RegisterPackageRequest | null {
  const snapshot = snapshotExactRecord(value, REGISTER_REQUEST_KEYS);
  if (snapshot === null) return null;
  const parsed = registerPackageRequestSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : null;
}

function writeEnvelopeInput(
  meta: WriteMeta,
  status: "blocked" | "unavailable",
  reasonCode: string,
) {
  return {
    schema_version: "2026-08-22.v1",
    request_id: meta.requestId,
    trace_id: meta.traceId,
    audit_id: meta.auditId,
    status,
    data: null,
    reason_codes: [reasonCode],
    readback: {
      status: "not_applicable" as const,
      release_id: null,
      revision: null,
    },
  };
}

function registrationRecordRef(record: {
  readonly moduleId: string;
  readonly version: string;
  readonly descriptorDigest: string;
}): string {
  return `registration:${record.moduleId}:${record.version}:${record.descriptorDigest}`;
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    freezeDeep(child, seen);
  }
  return Object.freeze(value);
}

function closeEnvelope(envelope: unknown): DeepFrozen<ControlEnvelope> {
  try {
    return freezeDeep(controlEnvelopeSchema.parse(envelope));
  } catch {
    throw new ModuleControlServiceError("state_output_invalid");
  }
}

function blockedEnvelope(
  code: ModuleControlServiceErrorCode,
): DeepFrozen<ControlEnvelope> {
  return closeEnvelope({
    schema_version: "2026-08-22.v1",
    request_id: AUTH_FAILURE_REQUEST_ID,
    trace_id: AUTH_FAILURE_TRACE_ID,
    audit_id: AUTH_FAILURE_AUDIT_ID,
    status: "blocked",
    data: null,
    reason_codes: [code],
    readback: {
      status: "not_applicable",
      release_id: null,
      revision: null,
    },
  });
}

function authorizationFailure(
  context: unknown,
  managementTenantId: string,
): ModuleControlServiceErrorCode | null {
  if (!isTrustedExecutionContext(context)) {
    return "execution_context_untrusted";
  }
  if (context.role !== "admin") {
    return "admin_role_required";
  }
  if (!context.roles.includes("admin")) {
    return "admin_role_missing";
  }
  if (!context.scopes.includes("platform:admin")) {
    return "platform_admin_scope_required";
  }
  if (context.tenantId !== managementTenantId) {
    return "management_tenant_mismatch";
  }
  return null;
}

class ModuleControlServiceImplementation implements ModuleControlService {
  readonly #repository: ModuleControlRepository;
  readonly #inventory: TrustedModuleInventory;
  readonly #managementTenantId: string;
  readonly #clock: () => string;
  readonly #idGenerator: () => string;
  readonly #runtime: PrivateRuntimeCapabilities;

  constructor(
    options: ModuleControlRuntimeAssemblyOptions,
    runtime: PrivateRuntimeCapabilities,
  ) {
    this.#repository = options.repository;
    this.#inventory = options.inventory;
    this.#managementTenantId = options.managementTenantId;
    this.#clock = options.clock;
    this.#idGenerator = options.idGenerator;
    this.#runtime = runtime;
  }

  #assertWriteEnvelope(
    action: ControlProducerAction,
    envelope: unknown,
  ): DeepFrozen<ControlEnvelope> {
    try {
      return assertControlProducerEnvelope(action, envelope);
    } catch (error: unknown) {
      return this.#runtime.coordinator.tripFatal(error);
    }
  }

  #assertRuntimeHealthy(): void {
    if (this.#runtime.coordinator.isFatal()) {
      this.#runtime.coordinator.tripFatal(
        new ModuleControlServiceError("runtime_fatal"),
      );
    }
  }

  #terminalRegisterEnvelope(
    meta: WriteMeta,
    status: "blocked" | "unavailable",
    reasonCode: string,
  ): DeepFrozen<ControlEnvelope> {
    return this.#assertWriteEnvelope(
      "packages.register",
      writeEnvelopeInput(meta, status, reasonCode),
    );
  }

  #terminalWriteEnvelope(
    action: ControlProducerAction,
    meta: WriteMeta,
    status: "blocked" | "unavailable",
    reasonCode: string,
  ): DeepFrozen<ControlEnvelope> {
    return this.#assertWriteEnvelope(
      action,
      writeEnvelopeInput(meta, status, reasonCode),
    );
  }

  #repositoryFailure(
    error: unknown,
    meta: WriteMeta,
  ): DeepFrozen<ControlEnvelope> {
    if (error instanceof RuntimeMutationFatalError) {
      throw error;
    }
    if (error instanceof ModuleControlRepositoryError) {
      if (error.code === "conflict") {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "registration_conflict",
        );
      }
      if (error.code === "invalid_state" || error.code === "tenant_mismatch") {
        return this.#runtime.coordinator.tripFatal(error);
      }
    }
    return this.#terminalRegisterEnvelope(
      meta,
      "unavailable",
      "repository_unavailable",
    );
  }

  async registerPackage(
    context: ExecutionContext,
    requestInput: RegisterPackageRequest,
    metaInput: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    const meta = parseWriteMeta(metaInput);
    const failure = authorizationFailure(context, this.#managementTenantId);
    if (failure !== null) {
      return this.#terminalRegisterEnvelope(meta, "blocked", failure);
    }

    return this.#runtime.coordinator.withMutation(async () => {
      const request = parseRegisterRequest(requestInput);
      if (request === null) {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "register_request_invalid",
        );
      }

      let expectedHash: string;
      try {
        expectedHash = canonicalControlHash({
          domain: "request",
          schemaVersion: request.schema_version,
          payload: {
            action: "packages.register",
            management_tenant_id: this.#managementTenantId,
            actor_ref: context.actorId,
            request: {
              ...request,
              descriptor_digest:
                request.descriptor_digest as `sha256:${string}`,
            },
          },
        }).hash;
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (expectedHash !== meta.requestHash) {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "request_hash_mismatch",
        );
      }

      const logicalInventoryEntry = this.#inventory.find(
        (entry) =>
          entry.moduleId === request.module_id &&
          entry.version === request.version,
      );
      if (logicalInventoryEntry === undefined) {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "inventory_module_not_found",
        );
      }
      if (logicalInventoryEntry.descriptorDigest !== request.descriptor_digest) {
        return this.#terminalRegisterEnvelope(
          meta,
          "blocked",
          "inventory_descriptor_mismatch",
        );
      }

      let registeredAt: string;
      try {
        registeredAt = this.#clock();
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      const record: ModuleRegistrationRecord = {
        managementTenantId: this.#managementTenantId,
        moduleId: logicalInventoryEntry.moduleId,
        version: logicalInventoryEntry.version,
        descriptorDigest: logicalInventoryEntry.descriptorDigest,
        evidenceLevel: logicalInventoryEntry.evidenceLevel,
        productionEligible: logicalInventoryEntry.productionEligible,
        evidenceRefs: {
          sourceShaRef: logicalInventoryEntry.evidenceRefs.sourceShaRef,
          artifactDigestRef:
            logicalInventoryEntry.evidenceRefs.artifactDigestRef,
          signatureRef: logicalInventoryEntry.evidenceRefs.signatureRef,
          sbomRef: logicalInventoryEntry.evidenceRefs.sbomRef,
          attestationRef: logicalInventoryEntry.evidenceRefs.attestationRef,
        },
        registeredByActorRef: context.actorId,
        registeredAt,
      };
      const domainRecordRef = registrationRecordRef(record);
      const successEnvelope = this.#assertWriteEnvelope("packages.register", {
        schema_version: request.schema_version,
        request_id: meta.requestId,
        trace_id: meta.traceId,
        audit_id: meta.auditId,
        status: "success",
        data: {
          kind: "registration",
          module_id: record.moduleId,
          version: record.version,
          descriptor_digest: record.descriptorDigest,
          evidence_level: record.evidenceLevel,
          production_eligible: record.productionEligible,
        },
        reason_codes: [],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      });
      const event: RegisterModuleRequestMetadata["event"] = {
        action: "packages.register",
        objectRef: domainRecordRef,
        kind: "registration",
        status: "registered",
        reasonCodes: [],
        detail: {
          kind: "registration",
          recordRef: domainRecordRef,
          moduleId: record.moduleId,
          version: record.version,
          descriptorDigest: record.descriptorDigest,
          status: "registered",
        },
      };
      const finalResult: ControlFinalResult = {
        domainRecordRef,
        envelope: successEnvelope as unknown as ControlEnvelope,
      };

      try {
        await this.#repository.registerModule({
          metadata: {
            managementTenantId: this.#managementTenantId,
            actorRef: context.actorId,
            action: "packages.register",
            idempotencyKey: meta.idempotencyKey,
            requestHash: meta.requestHash,
            event,
          },
          record,
          finalResult,
        });
      } catch (error: unknown) {
        return this.#repositoryFailure(error, meta);
      }

      let persisted;
      try {
        persisted = await this.#repository.getIdempotency({
          managementTenantId: this.#managementTenantId,
          action: "packages.register",
          idempotencyKey: meta.idempotencyKey,
        });
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }
      if (
        persisted === null ||
        persisted.status !== "completed" ||
        persisted.managementTenantId !== this.#managementTenantId ||
        persisted.action !== "packages.register" ||
        persisted.idempotencyKey !== meta.idempotencyKey ||
        persisted.requestHash !== meta.requestHash ||
        persisted.actorRef !== context.actorId ||
        persisted.domainRecordRef !== domainRecordRef ||
        persisted.finalResult === null ||
        persisted.finalResult.domainRecordRef !== domainRecordRef
      ) {
        return this.#runtime.coordinator.tripFatal(
          new ModuleControlServiceError("state_output_invalid"),
        );
      }
      return this.#assertWriteEnvelope(
        "packages.register",
        persisted.finalResult.envelope,
      );
    });
  }

  async #unimplementedWrite(
    action: ControlProducerAction,
    context: ExecutionContext,
    metaInput: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    const meta = parseWriteMeta(metaInput);
    const failure = authorizationFailure(context, this.#managementTenantId);
    if (failure !== null) {
      return this.#terminalWriteEnvelope(action, meta, "blocked", failure);
    }
    return this.#runtime.coordinator.withMutation(() =>
      Promise.resolve(this.#terminalWriteEnvelope(
        action,
        meta,
        "unavailable",
        "service_phase_not_implemented",
      )),
    );
  }

  async createDeploymentPreview(
    context: ExecutionContext,
    request: DeploymentPreviewRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    void request;
    return this.#unimplementedWrite("deployments.preview", context, meta);
  }

  async decideApproval(
    context: ExecutionContext,
    request: ApprovalRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    void request;
    return this.#unimplementedWrite("approvals.decide", context, meta);
  }

  async publish(
    context: ExecutionContext,
    request: PublishRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    void request;
    return this.#unimplementedWrite("deployments.publish", context, meta);
  }

  async reconcile(
    context: ExecutionContext,
    request: ReconcileRequest,
    meta: WriteMeta,
  ): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    void request;
    return this.#unimplementedWrite("deployments.reconcile", context, meta);
  }

  async getState(context: ExecutionContext): Promise<DeepFrozen<ControlEnvelope>> {
    this.#assertRuntimeHealthy();
    const failure = authorizationFailure(context, this.#managementTenantId);
    if (failure !== null) {
      return blockedEnvelope(failure);
    }

    return this.#runtime.coordinator.withControlledDispatch(async () => {
      let requestId: string;
      let traceId: string;
      let auditId: string;
      try {
        requestId = this.#idGenerator();
        traceId = this.#idGenerator();
        auditId = this.#idGenerator();
      } catch (error: unknown) {
        return this.#runtime.coordinator.tripFatal(error);
      }

      let state;
      try {
        state = await this.#repository.getControlState();
      } catch (error: unknown) {
        if (error instanceof RuntimeMutationFatalError) {
          throw error;
        }
        if (
          error instanceof ModuleControlRepositoryError &&
          (error.code === "invalid_state" || error.code === "tenant_mismatch")
        ) {
          return this.#runtime.coordinator.tripFatal(error);
        }
        try {
          return closeEnvelope({
            schema_version: "2026-08-22.v1",
            request_id: requestId,
            trace_id: traceId,
            audit_id: auditId,
            status: "unavailable",
            data: null,
            reason_codes: ["state_unavailable"],
            readback: {
              status: "not_applicable",
              release_id: null,
              revision: null,
            },
          });
        } catch (contractError: unknown) {
          return this.#runtime.coordinator.tripFatal(contractError);
        }
      }
      try {
        return closeEnvelope({
          schema_version: "2026-08-22.v1",
          request_id: requestId,
          trace_id: traceId,
          audit_id: auditId,
          status: "success",
          data: mapControlStateToDto(
            state as unknown as ModuleControlState,
            this.#inventory,
            this.#managementTenantId,
          ),
          reason_codes: [],
          readback: {
            status: "not_applicable",
            release_id: null,
            revision: null,
          },
        });
      } catch (contractError: unknown) {
        return this.#runtime.coordinator.tripFatal(contractError);
      }
    });
  }
}

function createControlledDispatchFacade(
  coordinator: RuntimeMutationCoordinator,
  activation: ActivationDispatchGate,
): ControlledDispatchFacade {
  const dispatch = async <T>(
    ref: ActiveModuleRef,
    handler: () => Promise<T> | T,
  ): Promise<T> =>
    coordinator.withControlledDispatch(async () => {
      if (coordinator.isFatal()) {
        return coordinator.tripFatal(
          new ModuleControlServiceError("runtime_fatal"),
        );
      }
      activation.snapshot();
      if (!activation.isActive(ref)) {
        throw new ModuleControlServiceError("module_not_active");
      }
      return handler();
    });

  return Object.freeze({ dispatch });
}

export function createModuleControlRuntimeAssembly(
  options: ModuleControlRuntimeAssemblyOptions,
): ModuleControlRuntimeAssembly {
  const coordinator = createRuntimeMutationCoordinator();
  const gate = createActivationGate(options.inventory);
  const runtime: PrivateRuntimeCapabilities = {
    coordinator,
    privateDriver: gate.privateDriver,
    recoveryDriver: gate.recoveryDriver,
  };
  const service = new ModuleControlServiceImplementation(options, runtime);
  const activation = Object.freeze({
    snapshot: () => gate.readFacade.snapshot(),
  });
  const dispatch = createControlledDispatchFacade(
    coordinator,
    gate.readFacade,
  );

  return Object.freeze({ service, activation, dispatch });
}
