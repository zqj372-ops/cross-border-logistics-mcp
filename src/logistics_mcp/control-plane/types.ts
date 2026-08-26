import type { ModuleRiskLevel } from "../module-runtime/types";

export type { ModuleRiskLevel } from "../module-runtime/types";

export const ADMIN_CONTROL_SCHEMA_VERSION = "2026-08-22.v1" as const;

export type DescriptorDigest = `sha256:${string}`;

declare const TRUSTED_MODULE_INVENTORY_BRAND: unique symbol;

export interface ModuleInventoryEntry {
  readonly moduleId: string;
  readonly version: string;
  readonly riskLevel: ModuleRiskLevel;
  readonly toolNames: readonly string[];
  readonly standardRefs: readonly string[];
  readonly descriptorDigest: DescriptorDigest;
  readonly evidenceLevel: "local_build";
  readonly productionEligible: false;
  readonly evidenceRefs: Readonly<{
    sourceShaRef: string | null;
    artifactDigestRef: string | null;
    signatureRef: string | null;
    sbomRef: string | null;
    attestationRef: string | null;
  }>;
}

export type TrustedModuleInventory = readonly ModuleInventoryEntry[] & {
  readonly [TRUSTED_MODULE_INVENTORY_BRAND]: "trusted-module-inventory";
};

export interface ActiveModuleRef {
  readonly moduleId: string;
  readonly version: string;
  readonly descriptorDigest: DescriptorDigest;
}

export interface ModuleActivationSnapshot {
  readonly releaseId: string | null;
  readonly revision: number;
  readonly activeModules: readonly ActiveModuleRef[];
}

/**
 * The mounted module fields that are visible to the control-plane descriptor.
 * These are deliberately explicit instead of accepting a generic manifest map.
 */
export interface MountedModuleData {
  readonly moduleId: string;
  readonly version: string;
  readonly riskLevel: ModuleRiskLevel;
  readonly lifecycle: "static";
  readonly requiredCapabilities: readonly string[];
  readonly optionalCapabilities: readonly string[];
  readonly standardRefs: readonly string[];
}

/**
 * The visible, already-mounted tool contract. The owner is supplied by the
 * server-side catalog and is checked against the mounted module ID.
 */
export interface MountedToolContract {
  readonly owner: string;
  readonly name: string;
  readonly permission: string;
  readonly kind: "read" | "write";
  readonly riskLevel: ModuleRiskLevel;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly standardRefs: readonly string[];
}

/**
 * Local/fixture evidence is optional metadata from the build assembly. It is
 * not an Admin request field and cannot assert production release trust.
 */
export interface ModuleLocalEvidence {
  readonly moduleId: string;
  readonly version: string;
  readonly evidenceLevel?: "local_build";
  readonly productionEligible?: false;
  readonly evidenceRefs: Readonly<{
    sourceShaRef: string | null;
    artifactDigestRef: string | null;
    signatureRef: string | null;
    sbomRef: string | null;
    attestationRef: string | null;
  }>;
}

export interface ModuleInventoryInput {
  readonly mountedModules: readonly MountedModuleData[];
  readonly catalog: readonly MountedToolContract[];
  readonly localEvidence: readonly ModuleLocalEvidence[];
}

export type MountedModuleDescriptor = MountedModuleData;
export type MountedCatalogEntry = MountedToolContract;
