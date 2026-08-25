import { types as nodeUtilTypes } from "node:util";

import {
  assertControlStateProducerSemantics,
  ControlContractError,
} from "./contracts";
import type { ControlStateData, DeepFrozen } from "./contracts";
import { isTrustedModuleInventory } from "./inventory";
import {
  CONTROL_IDEMPOTENCY_STATUSES,
  MODULE_CONTROL_ACTIONS,
  MODULE_READBACK_STATUSES,
  MODULE_RELEASE_STATUSES,
} from "./repository";
import type {
  ControlEventRecord,
  ModuleApprovalRecord,
  ModuleControlRef,
  ModuleControlState,
  ModulePreviewRecord,
  ModuleReadbackRecord,
  ModuleReleaseHistoryEntry,
  ModuleRegistrationRecord,
} from "./repository";
import {
  DESCRIPTOR_DIGEST_PATTERN,
  IDENTIFIER_PATTERN,
  VERSION_PATTERN,
} from "./lexical-contracts";
import type {
  ModuleInventoryEntry,
  TrustedModuleInventory,
} from "./types";

export type ControlStateMapperErrorCode =
  | "mapper_input_invalid"
  | "mapper_invalid"
  | "inventory_untrusted"
  | "management_tenant_mismatch"
  | "pending_latest_readback_not_producible";

export class ControlStateMapperError extends Error {
  public readonly code: ControlStateMapperErrorCode;

  public constructor(code: ControlStateMapperErrorCode) {
    super(code);
    this.name = "ControlStateMapperError";
    this.code = code;
  }
}

function failMapper(code: ControlStateMapperErrorCode): never {
  throw new ControlStateMapperError(code);
}

const MAX_MAPPER_INPUT_DEPTH = 64;
const MAX_MAPPER_INPUT_NODES = 100_000;
const MAX_MAPPER_INPUT_ARRAY_LENGTH = 10_000;

const REGISTRATION_EVIDENCE_REF_KEYS = [
  "sourceShaRef",
  "artifactDigestRef",
  "signatureRef",
  "sbomRef",
  "attestationRef",
] as const;

const EVENT_DETAIL_KEYS = {
  registration: [
    "kind",
    "recordRef",
    "moduleId",
    "version",
    "descriptorDigest",
    "status",
  ],
  preview: ["kind", "previewRef", "baseRevision", "status"],
  approval: ["kind", "approvalId", "previewRef", "status"],
  release: ["kind", "releaseId", "revision", "status"],
  reconciliation: [
    "kind",
    "releaseId",
    "revision",
    "readbackRef",
    "status",
  ],
  idempotency: ["kind", "recordRef", "domainRecordRef", "status"],
} as const;

interface MapperSnapshotBudget {
  nodes: number;
}

function isDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && "value" in descriptor;
}

function snapshotPlainMapperInput(input: unknown): unknown {
  const ancestors = new WeakSet<object>();
  const budget: MapperSnapshotBudget = { nodes: 0 };

  const snapshot = (value: unknown, depth = 0): unknown => {
    budget.nodes += 1;
    if (
      budget.nodes > MAX_MAPPER_INPUT_NODES ||
      depth > MAX_MAPPER_INPUT_DEPTH
    ) {
      throw new TypeError("mapper_input_budget_exceeded");
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value !== "object") {
      throw new TypeError("unsupported_mapper_input");
    }

    // This must precede every observable reflection. node:util's check does
    // not invoke a Proxy's traps or any getter on its target.
    if (nodeUtilTypes.isProxy(value)) {
      throw new TypeError("proxy_mapper_input");
    }
    if (ancestors.has(value)) {
      throw new TypeError("cyclic_mapper_input");
    }

    const prototype = Reflect.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype) {
          throw new TypeError("non_plain_mapper_array");
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (
          !isDataDescriptor(lengthDescriptor) ||
          typeof lengthDescriptor.value !== "number" ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          throw new TypeError("invalid_mapper_array_length");
        }
        const length = lengthDescriptor.value;
        if (length > MAX_MAPPER_INPUT_ARRAY_LENGTH) {
          throw new TypeError("mapper_input_array_budget_exceeded");
        }
        for (const key of keys) {
          if (key === "length") continue;
          if (
            typeof key !== "string" ||
            !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= length
          ) {
            throw new TypeError("non_json_mapper_array_property");
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
            throw new TypeError("sparse_or_accessor_mapper_array");
          }
        }

        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
            throw new TypeError("sparse_or_accessor_mapper_array");
          }
          result.push(snapshot(descriptor.value, depth + 1));
        }
        return result;
      }

      if (prototype !== Object.prototype) {
        throw new TypeError("non_plain_mapper_object");
      }
      const result = Object.create(null) as object;
      for (const key of keys) {
        if (typeof key !== "string") {
          throw new TypeError("symbol_mapper_property");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
          throw new TypeError("accessor_or_hidden_mapper_property");
        }
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: snapshot(descriptor.value, depth + 1),
          writable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };

  return snapshot(input);
}

function snapshotMapperInput(input: unknown): unknown {
  try {
    return snapshotPlainMapperInput(input);
  } catch {
    failMapper("mapper_input_invalid");
  }
}

function assertTenant(
  record: { readonly managementTenantId: string },
  managementTenantId: string,
): void {
  if (record.managementTenantId !== managementTenantId) {
    failMapper("management_tenant_mismatch");
  }
}

function logicalModuleKey(moduleId: string, version: string): string {
  return `${moduleId}\u0000${version}`;
}

function mapModuleRef(ref: ModuleControlRef) {
  return {
    module_id: ref.moduleId,
    version: ref.version,
    descriptor_digest: ref.descriptorDigest,
  };
}

function mapRegistrationSummary(
  registration: ModuleRegistrationRecord | undefined,
) {
  if (registration === undefined) return null;
  return {
    registered_by_actor_ref: registration.registeredByActorRef,
    registered_at: registration.registeredAt,
  };
}

function assertRegistrationEvidenceRefs(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failMapper("mapper_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== REGISTRATION_EVIDENCE_REF_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !REGISTRATION_EVIDENCE_REF_KEYS.includes(
          key as (typeof REGISTRATION_EVIDENCE_REF_KEYS)[number],
        ),
    )
  ) {
    failMapper("mapper_invalid");
  }
  const refs = value as Record<string, unknown>;
  for (const key of REGISTRATION_EVIDENCE_REF_KEYS) {
    const ref = refs[key];
    if (ref !== null && (typeof ref !== "string" || !IDENTIFIER_PATTERN.test(ref))) {
      failMapper("mapper_invalid");
    }
  }
}

function assertRegistrationMatchesInventory(
  registration: ModuleRegistrationRecord,
  entry: ModuleInventoryEntry,
): void {
  if (
    registration.descriptorDigest !== entry.descriptorDigest ||
    registration.evidenceLevel !== "local_build" ||
    registration.productionEligible !== false
  ) {
    failMapper("mapper_invalid");
  }
  assertRegistrationEvidenceRefs(registration.evidenceRefs);
}

function mapInventory(
  currentInventory: readonly ModuleInventoryEntry[],
  registrations: readonly ModuleRegistrationRecord[],
  managementTenantId: string,
) {
  const registrationsByLogicalKey = new Map<string, ModuleRegistrationRecord>();
  for (const registration of registrations) {
    assertTenant(registration, managementTenantId);
    const key = logicalModuleKey(registration.moduleId, registration.version);
    if (registrationsByLogicalKey.has(key)) {
      failMapper("mapper_invalid");
    }
    registrationsByLogicalKey.set(key, registration);
  }

  return currentInventory.map((entry) => {
    const registration = registrationsByLogicalKey.get(
      logicalModuleKey(entry.moduleId, entry.version),
    );
    if (registration !== undefined) {
      assertRegistrationMatchesInventory(registration, entry);
    }
    return {
      module_id: entry.moduleId,
      version: entry.version,
      risk_level: entry.riskLevel,
      descriptor_digest: entry.descriptorDigest,
      evidence_level: entry.evidenceLevel,
      production_eligible: entry.productionEligible,
      tool_names: entry.toolNames.slice(),
      standard_ids: entry.standardRefs.slice(),
      registration: mapRegistrationSummary(registration),
    };
  });
}

function mapPreview(preview: ModulePreviewRecord) {
  const base = {
    preview_ref: preview.previewRef,
    canonical_hash: preview.canonicalHash,
    base_release_id: preview.baseReleaseId,
    base_revision: preview.baseRevision,
    desired_modules: preview.desiredModules.map(mapModuleRef),
    diff: {
      added: preview.diff.added.map(mapModuleRef),
      removed: preview.diff.removed.map(mapModuleRef),
      retained: preview.diff.retained.map(mapModuleRef),
    },
    validation: {
      base_matches: preview.validation.baseMatches,
      desired_modules_valid: preview.validation.desiredModulesValid,
      inventory_matches: preview.validation.inventoryMatches,
      minimum_active_modules: preview.validation.minimumActiveModules,
      reason_codes: preview.validation.reasonCodes.slice(),
    },
    creator_actor_ref: preview.creatorActorRef,
    created_at: preview.createdAt,
    expires_at: preview.expiresAt,
    consumed: preview.consumed,
  };

  if (preview.intent === "change") {
    return { ...base, intent: "change" as const };
  }
  if (preview.intent === "rollback") {
    return {
      ...base,
      intent: "rollback" as const,
      target_release_id: preview.targetReleaseId,
    };
  }
  failMapper("mapper_invalid");
}

function mapApproval(approval: ModuleApprovalRecord) {
  return {
    approval_id: approval.approvalId,
    preview_ref: approval.previewRef,
    decision: approval.decision,
    reason_code: approval.reasonCode,
    approver_actor_ref: approval.approverActorRef,
    decided_at: approval.decidedAt,
    consumed: approval.consumed,
  };
}

function exactEventDetail(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failMapper("mapper_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  ) {
    failMapper("mapper_invalid");
  }
  return value as Record<string, unknown>;
}

function assertEventIdentifier(value: unknown): void {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    failMapper("mapper_invalid");
  }
}

function assertEventVersion(value: unknown): void {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    failMapper("mapper_invalid");
  }
}

function assertEventDescriptorDigest(value: unknown): void {
  if (
    typeof value !== "string" ||
    !DESCRIPTOR_DIGEST_PATTERN.test(value)
  ) {
    failMapper("mapper_invalid");
  }
}

function assertEventNonnegativeInteger(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    failMapper("mapper_invalid");
  }
}

function assertEventPositiveInteger(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    failMapper("mapper_invalid");
  }
}

function assertEventNullableIdentifier(value: unknown): void {
  if (value !== null) assertEventIdentifier(value);
}

function assertEventDetail(event: ControlEventRecord): void {
  const expectedKeys = EVENT_DETAIL_KEYS[event.kind];
  if (expectedKeys === undefined) {
    failMapper("mapper_invalid");
  }
  const detail = exactEventDetail(event.detail, expectedKeys);
  if (detail.kind !== event.kind || detail.status !== event.status) {
    failMapper("mapper_invalid");
  }

  switch (event.kind) {
    case "registration":
      if (
        event.action !== "packages.register" ||
        event.status !== "registered" ||
        detail.recordRef !== event.objectRef
      ) {
        failMapper("mapper_invalid");
      }
      assertEventIdentifier(event.objectRef);
      assertEventIdentifier(detail.recordRef);
      assertEventIdentifier(detail.moduleId);
      assertEventVersion(detail.version);
      assertEventDescriptorDigest(detail.descriptorDigest);
      return;
    case "preview":
      if (
        event.action !== "deployments.preview" ||
        event.status !== "previewed" ||
        detail.previewRef !== event.objectRef
      ) {
        failMapper("mapper_invalid");
      }
      assertEventIdentifier(event.objectRef);
      assertEventIdentifier(detail.previewRef);
      assertEventNonnegativeInteger(detail.baseRevision);
      return;
    case "approval":
      if (
        event.action !== "approvals.decide" ||
        (event.status !== "approved" && event.status !== "rejected") ||
        detail.approvalId !== event.objectRef
      ) {
        failMapper("mapper_invalid");
      }
      assertEventIdentifier(event.objectRef);
      assertEventIdentifier(detail.approvalId);
      assertEventIdentifier(detail.previewRef);
      return;
    case "release":
      if (
        event.action !== "deployments.publish" ||
        !MODULE_RELEASE_STATUSES.includes(event.status) ||
        detail.releaseId !== event.objectRef
      ) {
        failMapper("mapper_invalid");
      }
      assertEventIdentifier(event.objectRef);
      assertEventIdentifier(detail.releaseId);
      assertEventPositiveInteger(detail.revision);
      return;
    case "reconciliation":
      if (
        (event.action !== "deployments.publish" &&
          event.action !== "deployments.reconcile") ||
        !MODULE_READBACK_STATUSES.includes(event.status) ||
        detail.releaseId !== event.objectRef
      ) {
        failMapper("mapper_invalid");
      }
      assertEventIdentifier(event.objectRef);
      assertEventIdentifier(detail.releaseId);
      assertEventPositiveInteger(detail.revision);
      assertEventIdentifier(detail.readbackRef);
      return;
    case "idempotency":
      if (
        !MODULE_CONTROL_ACTIONS.includes(event.action) ||
        !CONTROL_IDEMPOTENCY_STATUSES.includes(event.status) ||
        detail.recordRef !== event.objectRef
      ) {
        failMapper("mapper_invalid");
      }
      assertEventIdentifier(event.objectRef);
      assertEventIdentifier(detail.recordRef);
      assertEventNullableIdentifier(detail.domainRecordRef);
      return;
  }
}

function exactUnorderedSetEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function assertLatestApprovalMatchesPreview(
  approval: ModuleApprovalRecord,
  preview: ModulePreviewRecord | null,
): void {
  if (
    preview === null ||
    approval.previewRef !== preview.previewRef ||
    approval.previewCanonicalHash !== preview.canonicalHash ||
    approval.baseReleaseId !== preview.baseReleaseId ||
    approval.baseRevision !== preview.baseRevision ||
    approval.expiresAt !== preview.expiresAt ||
    !exactUnorderedSetEqual(
      approval.inventoryDigestSet,
      preview.inventoryRefs.map((ref) => ref.descriptorDigest),
    )
  ) {
    failMapper("mapper_invalid");
  }
}

function mapReadback(readback: ModuleReadbackRecord) {
  if (readback.status === "pending") {
    failMapper("pending_latest_readback_not_producible");
  }

  const base = {
    release_id: readback.releaseId,
    revision: readback.revision,
    readback_ref: readback.readbackRef,
    applied_modules: readback.appliedModules.map(mapModuleRef),
    checked_at: readback.checkedAt,
    reason_codes: readback.reasonCodes.slice(),
  };
  if (readback.status === "verified") {
    return { ...base, status: "verified" as const };
  }
  if (readback.status === "mismatch" || readback.status === "unknown") {
    return {
      ...base,
      status: readback.status,
      observed_activation: {
        release_id: readback.appliedReleaseId,
        revision: readback.appliedRevision,
      },
    };
  }
  failMapper("mapper_invalid");
}

function mapReleaseHistoryEntry(entry: ModuleReleaseHistoryEntry) {
  const release = entry.release;
  const base = {
    release_id: release.releaseId,
    revision: release.revision,
    desired_modules: release.desiredModules.map(mapModuleRef),
    previous_release_id: release.previousReleaseId,
    preview_ref: release.previewRef,
    approval_id: release.approvalId,
    publisher_actor_ref: release.publisherActorRef,
    created_at: release.createdAt,
    status: release.status,
    published_at: release.publishedAt,
    readback_ref: release.readbackRef,
    reason_codes: release.reasonCodes.slice(),
    superseded_by_release_id: release.supersededByReleaseId,
  };
  if (entry.intent === "change") {
    return { ...base, intent: "change" as const };
  }
  if (entry.intent === "rollback") {
    return {
      ...base,
      intent: "rollback" as const,
      rollback_target_release_id: entry.rollbackTargetReleaseId,
    };
  }
  failMapper("mapper_invalid");
}

type ControlEventSummary = ControlStateData["events"][number];

function mapEvent(event: ControlEventRecord): ControlEventSummary {
  assertEventDetail(event);

  // Keep the source discriminants intact so the existing DTO assertion, rather
  // than this mapper, rejects contradictory action/kind/status combinations.
  return {
    sequence: event.sequence,
    event_id: event.eventId,
    actor_ref: event.actorRef,
    action: event.action,
    object_ref: event.objectRef,
    kind: event.kind,
    status: event.status,
    reason_codes: event.reasonCodes.slice(),
    occurred_at: event.occurredAt,
  } as ControlEventSummary;
}

function mapActivation(state: ModuleControlState) {
  if (state.activeRelease === null) {
    return {
      state: "inactive" as const,
      release_id: null,
      revision: state.activeRevision,
      active_modules: state.activeModules.map(mapModuleRef),
    };
  }
  return {
    state: "active" as const,
    release_id: state.activeRelease.releaseId,
    revision: state.activeRevision,
    active_modules: state.activeModules.map(mapModuleRef),
  };
}

function buildControlStateDto(
  state: ModuleControlState,
  currentInventory: readonly ModuleInventoryEntry[],
  managementTenantId: string,
) {
  if (state.activeRelease !== null) {
    assertTenant(state.activeRelease, managementTenantId);
  }
  for (const registration of state.registrations) {
    assertTenant(registration, managementTenantId);
  }
  if (state.latestPreview !== null) {
    assertTenant(state.latestPreview, managementTenantId);
  }
  if (state.latestApproval !== null) {
    assertTenant(state.latestApproval, managementTenantId);
    assertLatestApprovalMatchesPreview(
      state.latestApproval,
      state.latestPreview,
    );
  }
  if (state.latestReadback !== null) {
    assertTenant(state.latestReadback, managementTenantId);
  }
  for (const entry of state.releaseHistory) {
    assertTenant(entry.release, managementTenantId);
  }
  for (const event of state.events) {
    assertTenant(event, managementTenantId);
  }

  return {
    kind: "control_state" as const,
    activation: mapActivation(state),
    inventory_modules: mapInventory(
      currentInventory,
      state.registrations,
      managementTenantId,
    ),
    latest_preview:
      state.latestPreview === null ? null : mapPreview(state.latestPreview),
    latest_approval:
      state.latestApproval === null ? null : mapApproval(state.latestApproval),
    latest_readback:
      state.latestReadback === null ? null : mapReadback(state.latestReadback),
    release_history: state.releaseHistory.map(mapReleaseHistoryEntry),
    events: state.events.map(mapEvent),
    events_truncated: state.eventsTruncated,
  };
}

export function mapControlStateToDto(
  state: ModuleControlState,
  inventory: TrustedModuleInventory,
  managementTenantId: string,
): DeepFrozen<ControlStateData> {
  const safeStateInput = snapshotMapperInput(state);
  if (
    safeStateInput === null ||
    typeof safeStateInput !== "object" ||
    Array.isArray(safeStateInput)
  ) {
    failMapper("mapper_input_invalid");
  }
  const safeState = safeStateInput as ModuleControlState;
  if (typeof managementTenantId !== "string") {
    failMapper("mapper_input_invalid");
  }
  if (safeState.managementTenantId !== managementTenantId) {
    failMapper("management_tenant_mismatch");
  }

  const safeInventory = snapshotMapperInput(inventory) as readonly ModuleInventoryEntry[];
  if (!isTrustedModuleInventory(inventory)) {
    failMapper("inventory_untrusted");
  }

  try {
    const dto = buildControlStateDto(
      safeState,
      safeInventory,
      managementTenantId,
    );
    return assertControlStateProducerSemantics(dto);
  } catch (error: unknown) {
    if (
      error instanceof ControlStateMapperError ||
      error instanceof ControlContractError
    ) {
      throw error;
    }
    failMapper("mapper_invalid");
  }
}
