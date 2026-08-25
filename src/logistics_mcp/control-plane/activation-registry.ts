import { types as nodeTypes } from "node:util";

import type {
  ActiveModuleRef,
  ModuleActivationSnapshot,
  ModuleInventoryEntry,
  TrustedModuleInventory,
} from "./types";

import { isTrustedModuleInventory } from "./inventory";
import {
  readActivationRegistrySnapshot,
  registerActivationRegistryState,
} from "./activation-authority-internal";

import {
  DESCRIPTOR_DIGEST_PATTERN,
  IDENTIFIER_PATTERN,
  VERSION_PATTERN,
} from "./lexical-contracts";

const INVENTORY_ENTRY_KEYS = [
  "moduleId",
  "version",
  "riskLevel",
  "toolNames",
  "standardRefs",
  "descriptorDigest",
  "evidenceLevel",
  "productionEligible",
  "evidenceRefs",
] as const;
const EVIDENCE_REF_KEYS = [
  "sourceShaRef",
  "artifactDigestRef",
  "signatureRef",
  "sbomRef",
  "attestationRef",
] as const;
const ACTIVE_REF_KEYS = ["moduleId", "version", "descriptorDigest"] as const;
const MODULE_RISK_LEVELS = ["T0", "T1", "T2", "T3"] as const;
const LOCAL_REFERENCE_PATTERN = /^(?:local|fixture):[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type ModuleActivationErrorCode =
  | "inventory_invalid"
  | "inventory_duplicate"
  | "snapshot_invalid"
  | "descriptor_digest_invalid"
  | "registry_invalid";

type ClosedDataErrorCode =
  | "inventory_invalid"
  | "snapshot_invalid";

export class ModuleActivationError extends Error {
  readonly code: ModuleActivationErrorCode;

  constructor(code: ModuleActivationErrorCode, message: string) {
    super(message);
    this.name = "ModuleActivationError";
    this.code = code;
  }
}

function closedDataFailure(
  code: ClosedDataErrorCode,
  message: string,
): never {
  throw new ModuleActivationError(code, message);
}

function materializeClosedRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: ClosedDataErrorCode,
  label: string,
): readonly unknown[] {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return closedDataFailure(code, `${label} must be a non-Proxy ordinary object.`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length) {
    return closedDataFailure(code, `${label} has an unsupported or incomplete field set.`);
  }
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== "string" || !expectedKeys.includes(key)) {
      return closedDataFailure(code, `${label} has an unsupported or incomplete field set.`);
    }
  }

  const values: unknown[] = [];
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]!;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return closedDataFailure(
        code,
        `${label}.${key} must be an own enumerable data property.`,
      );
    }
    values.push(descriptor.value);
  }
  return values;
}

function materializeClosedArray(
  value: unknown,
  code: ClosedDataErrorCode,
  label: string,
): readonly unknown[] {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return closedDataFailure(code, `${label} must be a non-Proxy standard array.`);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return closedDataFailure(code, `${label}.length must be the standard data property.`);
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) {
    return closedDataFailure(code, `${label} must contain only continuous array indexes.`);
  }
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      return closedDataFailure(code, `${label} must not contain symbol keys.`);
    }
    const numericIndex = Number(key);
    if (
      !Number.isSafeInteger(numericIndex) ||
      numericIndex < 0 ||
      numericIndex >= length ||
      String(numericIndex) !== key
    ) {
      return closedDataFailure(code, `${label} contains a non-index own property.`);
    }
  }

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return closedDataFailure(
        code,
        `${label}[${index}] must be an own enumerable data property.`,
      );
    }
    values.push(descriptor.value);
  }
  return values;
}

function assertIdentifier(
  value: unknown,
  code: ClosedDataErrorCode,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new ModuleActivationError(code, `${label} is malformed.`);
  }
}

function assertVersion(
  value: unknown,
  code: ClosedDataErrorCode,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new ModuleActivationError(code, `${label} is malformed.`);
  }
}

function assertDigest(
  value: unknown,
  code: "inventory_invalid" | "descriptor_digest_invalid",
  label: string,
): asserts value is `sha256:${string}` {
  if (typeof value !== "string" || !DESCRIPTOR_DIGEST_PATTERN.test(value)) {
    throw new ModuleActivationError(code, `${label} is malformed.`);
  }
}

function assertRiskLevel(
  value: unknown,
  label: string,
): asserts value is ModuleInventoryEntry["riskLevel"] {
  if (
    typeof value !== "string" ||
    !MODULE_RISK_LEVELS.includes(value as (typeof MODULE_RISK_LEVELS)[number])
  ) {
    throw new ModuleActivationError("inventory_invalid", `${label} is malformed.`);
  }
}

function assertInventoryStringList(
  value: unknown,
  label: string,
  requireNonempty: boolean,
): void {
  const values = materializeClosedArray(value, "inventory_invalid", label);
  if (requireNonempty && values.length === 0) {
    throw new ModuleActivationError("inventory_invalid", `${label} must not be empty.`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    assertIdentifier(entry, "inventory_invalid", `${label}[${index}]`);
    if (seen.has(entry)) {
      throw new ModuleActivationError(
        "inventory_invalid",
        `${label} must not contain duplicates.`,
      );
    }
    seen.add(entry);
  }
}

function assertLocalReference(value: unknown, label: string): void {
  if (value === null) {
    return;
  }
  if (typeof value !== "string" || !LOCAL_REFERENCE_PATTERN.test(value)) {
    throw new ModuleActivationError(
      "inventory_invalid",
      `${label} must be null or a controlled local reference.`,
    );
  }
}

function moduleKey(moduleId: string, version: string): string {
  return `${moduleId}\u0000${version}`;
}

function freezeRef(
  moduleId: string,
  version: string,
  descriptorDigest: `sha256:${string}`,
): ActiveModuleRef {
  return Object.freeze({ moduleId, version, descriptorDigest });
}

function inventoryRef(value: unknown, index: number): ActiveModuleRef {
  const fields = materializeClosedRecord(
    value,
    INVENTORY_ENTRY_KEYS,
    "inventory_invalid",
    `inventory[${index}]`,
  );
  const moduleId = fields[0];
  const version = fields[1];
  const riskLevel = fields[2];
  const toolNames = fields[3];
  const standardRefs = fields[4];
  const descriptorDigest = fields[5];
  const evidenceLevel = fields[6];
  const productionEligible = fields[7];
  const evidenceRefs = fields[8];

  assertIdentifier(moduleId, "inventory_invalid", `inventory[${index}].moduleId`);
  assertVersion(version, "inventory_invalid", `inventory[${index}].version`);
  assertRiskLevel(riskLevel, `inventory[${index}].riskLevel`);
  assertInventoryStringList(toolNames, `inventory[${index}].toolNames`, false);
  assertInventoryStringList(standardRefs, `inventory[${index}].standardRefs`, true);
  assertDigest(
    descriptorDigest,
    "inventory_invalid",
    `inventory[${index}].descriptorDigest`,
  );
  if (evidenceLevel !== "local_build" || productionEligible !== false) {
    throw new ModuleActivationError(
      "inventory_invalid",
      `inventory[${index}] must carry local_build, non-production evidence.`,
    );
  }

  const evidenceValues = materializeClosedRecord(
    evidenceRefs,
    EVIDENCE_REF_KEYS,
    "inventory_invalid",
    `inventory[${index}].evidenceRefs`,
  );
  for (let evidenceIndex = 0; evidenceIndex < evidenceValues.length; evidenceIndex += 1) {
    assertLocalReference(
      evidenceValues[evidenceIndex],
      `inventory[${index}].evidenceRefs.${EVIDENCE_REF_KEYS[evidenceIndex]!}`,
    );
  }

  return freezeRef(moduleId, version, descriptorDigest);
}

export class ModuleActivationRegistry {
  constructor(inventory: TrustedModuleInventory) {
    if (!isTrustedModuleInventory(inventory)) {
      throw new ModuleActivationError(
        "inventory_invalid",
        "Inventory must be created by createModuleInventory.",
      );
    }
    const entries = materializeClosedArray(
      inventory,
      "inventory_invalid",
      "inventory",
    );
    const inventoryKeys = new Set<string>();
    const moduleIds = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const ref = inventoryRef(entries[index], index);
      const key = moduleKey(ref.moduleId, ref.version);
      if (inventoryKeys.has(key)) {
        throw new ModuleActivationError(
          "inventory_duplicate",
          `Inventory ref is duplicated: ${ref.moduleId}.`,
        );
      }
      if (moduleIds.has(ref.moduleId)) {
        throw new ModuleActivationError(
          "inventory_duplicate",
          `Module ID is duplicated: ${ref.moduleId}.`,
        );
      }
      inventoryKeys.add(key);
      moduleIds.add(ref.moduleId);
    }

    registerActivationRegistryState(this, inventory);
    Object.defineProperties(this, {
      snapshot: {
        configurable: false,
        enumerable: false,
        value: ModuleActivationRegistry.prototype.snapshot.bind(this),
        writable: false,
      },
      isActive: {
        configurable: false,
        enumerable: false,
        value: ModuleActivationRegistry.prototype.isActive.bind(this),
        writable: false,
      },
    });
    Object.freeze(this);
  }

  snapshot(): ModuleActivationSnapshot {
    const snapshot = readActivationRegistrySnapshot(this);
    if (snapshot === undefined) {
      throw new ModuleActivationError(
        "registry_invalid",
        "Activation snapshot is unavailable for this registry receiver.",
      );
    }
    return snapshot;
  }

  isActive(ref: ActiveModuleRef): boolean {
    const currentSnapshot = readActivationRegistrySnapshot(this);
    if (currentSnapshot === undefined) {
      return false;
    }

    let fields: readonly unknown[];
    try {
      fields = materializeClosedRecord(
        ref,
        ACTIVE_REF_KEYS,
        "snapshot_invalid",
        "module route identity",
      );
      assertIdentifier(fields[0], "snapshot_invalid", "module route identity.moduleId");
      assertVersion(fields[1], "snapshot_invalid", "module route identity.version");
      assertDigest(
        fields[2],
        "descriptor_digest_invalid",
        "module route identity.descriptorDigest",
      );
    } catch (error: unknown) {
      if (error instanceof ModuleActivationError) {
        return false;
      }
      return false;
    }
    const moduleId = fields[0];
    const version = fields[1];
    const descriptorDigest = fields[2];
    for (let index = 0; index < currentSnapshot.activeModules.length; index += 1) {
      const activeRef = currentSnapshot.activeModules[index]!;
      if (
        activeRef.moduleId === moduleId &&
        activeRef.version === version &&
        activeRef.descriptorDigest === descriptorDigest
      ) {
        return true;
      }
    }
    return false;
  }
}

Object.freeze(ModuleActivationRegistry.prototype);
