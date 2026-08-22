import type {
  ActiveModuleRef,
  ModuleActivationSnapshot,
  ModuleInventoryEntry,
} from "./types";

import {
  DESCRIPTOR_DIGEST_PATTERN,
  IDENTIFIER_PATTERN,
  VERSION_PATTERN,
  hasExactOwnKeys,
  isPlainRecord,
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
const ACTIVE_REF_KEYS = ["moduleId", "version", "descriptorDigest"] as const;

export class ModuleActivationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModuleActivationError";
    this.code = code;
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (!hasExactOwnKeys(value, expected)) {
    throw new ModuleActivationError("snapshot_invalid", `${label} has unsupported fields.`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new ModuleActivationError("snapshot_invalid", `${label} is malformed.`);
  }
}

function assertVersion(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new ModuleActivationError("snapshot_invalid", `${label} is malformed.`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is `sha256:${string}` {
  if (typeof value !== "string" || !DESCRIPTOR_DIGEST_PATTERN.test(value)) {
    throw new ModuleActivationError("descriptor_digest_invalid", `${label} is malformed.`);
  }
}

function moduleKey(moduleId: string, version: string): string {
  return `${moduleId}\u0000${version}`;
}

function cloneRef(ref: ActiveModuleRef): ActiveModuleRef {
  return Object.freeze({
    moduleId: ref.moduleId,
    version: ref.version,
    descriptorDigest: ref.descriptorDigest,
  });
}

function freezeSnapshot(snapshot: ModuleActivationSnapshot): ModuleActivationSnapshot {
  const activeModules = Object.freeze(snapshot.activeModules.map(cloneRef));
  return Object.freeze({
    releaseId: snapshot.releaseId,
    revision: snapshot.revision,
    activeModules,
  });
}

function inventoryRef(entry: ModuleInventoryEntry): ActiveModuleRef {
  if (!isPlainRecord(entry) || !hasExactOwnKeys(entry, INVENTORY_ENTRY_KEYS)) {
    throw new ModuleActivationError(
      "inventory_invalid",
      "Inventory entries must be exact own-key records.",
    );
  }
  assertIdentifier(entry.moduleId, "inventory.moduleId");
  assertVersion(entry.version, "inventory.version");
  assertDigest(entry.descriptorDigest, "inventory.descriptorDigest");
  if (entry.evidenceLevel !== "local_build" || entry.productionEligible !== false) {
    throw new ModuleActivationError("inventory_invalid", "Only local-build inventory entries are supported.");
  }
  return cloneRef({
    moduleId: entry.moduleId,
    version: entry.version,
    descriptorDigest: entry.descriptorDigest,
  });
}

export class ModuleActivationRegistry {
  private readonly inventoryByKey = new Map<string, ActiveModuleRef>();
  private currentSnapshot: ModuleActivationSnapshot;

  constructor(inventory: readonly ModuleInventoryEntry[]) {
    if (!Array.isArray(inventory)) {
      throw new ModuleActivationError("inventory_invalid", "Inventory must be an array.");
    }

    for (const entry of inventory as readonly ModuleInventoryEntry[]) {
      const ref = inventoryRef(entry);
      if (this.inventoryByKey.has(moduleKey(ref.moduleId, ref.version))) {
        throw new ModuleActivationError("inventory_duplicate", `Inventory ref is duplicated: ${ref.moduleId}.`);
      }
      if ([...this.inventoryByKey.values()].some((existing) => existing.moduleId === ref.moduleId)) {
        throw new ModuleActivationError("inventory_duplicate", `Module ID is duplicated: ${ref.moduleId}.`);
      }
      this.inventoryByKey.set(moduleKey(ref.moduleId, ref.version), ref);
    }

    this.currentSnapshot = freezeSnapshot({
      releaseId: null,
      revision: 0,
      activeModules: [],
    });
  }

  replace(next: ModuleActivationSnapshot): void {
    if (!isPlainRecord(next)) {
      throw new ModuleActivationError("snapshot_invalid", "Activation snapshot must be an object.");
    }
    assertExactKeys(next, ["releaseId", "revision", "activeModules"], "Activation snapshot");
    if (next.releaseId !== null) {
      assertIdentifier(next.releaseId, "snapshot.releaseId");
    }
    if (typeof next.revision !== "number" || !Number.isSafeInteger(next.revision) || next.revision < 0) {
      throw new ModuleActivationError("revision_invalid", "Activation revision must be a nonnegative safe integer.");
    }
    if (next.revision <= this.currentSnapshot.revision) {
      throw new ModuleActivationError("revision_stale", "Activation revision must increase monotonically.");
    }
    if (!Array.isArray(next.activeModules)) {
      throw new ModuleActivationError("snapshot_invalid", "activeModules must be an array.");
    }

    const seen = new Set<string>();
    const refs: ActiveModuleRef[] = [];
    for (const [index, rawRef] of next.activeModules.entries()) {
      if (!isPlainRecord(rawRef)) {
        throw new ModuleActivationError("snapshot_invalid", `activeModules[${index}] must be an object.`);
      }
      assertExactKeys(rawRef, ACTIVE_REF_KEYS, `activeModules[${index}]`);
      assertIdentifier(rawRef.moduleId, `activeModules[${index}].moduleId`);
      assertVersion(rawRef.version, `activeModules[${index}].version`);
      assertDigest(rawRef.descriptorDigest, `activeModules[${index}].descriptorDigest`);
      const key = moduleKey(rawRef.moduleId, rawRef.version);
      if (seen.has(key)) {
        throw new ModuleActivationError("snapshot_duplicate", `Active module ref is duplicated: ${rawRef.moduleId}.`);
      }
      seen.add(key);
      const expected = this.inventoryByKey.get(key);
      if (expected === undefined) {
        throw new ModuleActivationError("snapshot_unknown", `Active module ref is not in inventory: ${rawRef.moduleId}.`);
      }
      if (expected.descriptorDigest !== rawRef.descriptorDigest) {
        throw new ModuleActivationError("descriptor_mismatch", `Descriptor digest does not match inventory for ${rawRef.moduleId}.`);
      }
      refs.push({
        moduleId: rawRef.moduleId,
        version: rawRef.version,
        descriptorDigest: rawRef.descriptorDigest,
      });
    }

    this.currentSnapshot = freezeSnapshot({
      releaseId: next.releaseId,
      revision: next.revision,
      activeModules: refs,
    });
  }

  snapshot(): ModuleActivationSnapshot {
    return this.currentSnapshot;
  }

  isActive(moduleId: string, version: string): boolean {
    return this.currentSnapshot.activeModules.some(
      (ref) => ref.moduleId === moduleId && ref.version === version,
    );
  }
}
