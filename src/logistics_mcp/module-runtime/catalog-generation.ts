import { createHash } from "node:crypto";

import { ModuleRuntimeError } from "./errors";
import {
  assertExactStringSet,
  READ_PREVIEW_MODULE_DESCRIPTORS,
  READ_PREVIEW_MODULE_IDS,
  READ_PREVIEW_RESOURCE_URIS,
  READ_PREVIEW_STAGING_PROFILE,
  READ_PREVIEW_TOOL_NAMES,
  parseT0ProductionProfile,
  T0_MODULE_DESCRIPTORS,
  T0_PRODUCTION_MODULE_IDS,
  T0_PRODUCTION_RESOURCE_URIS,
  T0_PRODUCTION_TOOL_NAMES,
  validateModuleDescriptor,
  type ModuleDescriptor,
  type ProductionRuntimeProfile,
  type ReadPreviewProductionProfile,
  type T0ProductionProfile,
} from "./production";
import type { ModuleRiskLevel } from "./types";

export const T0_CATALOG_SCHEMA_VERSION = "2026-09-02.v1" as const;

export interface T0CatalogToolReceipt {
  readonly name: string;
  readonly input_schema_id: string;
  readonly output_schema_id: string;
  readonly permission: string;
  readonly kind: "read" | "write";
  readonly risk_level: ModuleRiskLevel;
  readonly standard_refs: readonly string[];
  readonly contract_digest: `sha256:${string}`;
}

export interface T0CatalogModuleReceipt {
  readonly module_id: string;
  readonly version: string;
  readonly risk_level: ModuleRiskLevel;
  readonly artifact_digest: `sha256:${string}`;
  readonly manifest_digest: `sha256:${string}`;
  readonly tools: readonly T0CatalogToolReceipt[];
}

export interface T0CatalogGenerationReceipt {
  readonly schema_version: typeof T0_CATALOG_SCHEMA_VERSION;
  readonly profile: T0ProductionProfile;
  readonly catalog_generation: `catalog_${string}`;
  readonly catalog_digest: `sha256:${string}`;
  readonly modules: readonly T0CatalogModuleReceipt[];
  readonly resource_uris: readonly string[];
  readonly prompt_names: readonly [];
}

export interface ReadPreviewCatalogGenerationReceipt
  extends Omit<T0CatalogGenerationReceipt, "profile"> {
  readonly profile: ReadPreviewProductionProfile;
}

export type CatalogGenerationReceipt =
  | T0CatalogGenerationReceipt
  | ReadPreviewCatalogGenerationReceipt;

function catalogError(code: string, message: string): ModuleRuntimeError {
  return new ModuleRuntimeError(code, message);
}

function normalizedToolReceipt(
  contract: ModuleDescriptor["tool_contracts"][number],
): T0CatalogToolReceipt {
  return Object.freeze({
    name: contract.name,
    input_schema_id: contract.input_schema_id,
    output_schema_id: contract.output_schema_id,
    permission: contract.permission,
    kind: contract.kind,
    risk_level: contract.risk_level,
    standard_refs: Object.freeze([...contract.standard_refs].sort()),
    contract_digest: contract.contract_digest,
  });
}

function normalizedModuleReceipt(descriptor: ModuleDescriptor): T0CatalogModuleReceipt {
  return Object.freeze({
    module_id: descriptor.module_id,
    version: descriptor.version,
    risk_level: descriptor.risk_level,
    artifact_digest: descriptor.artifact_digest,
    manifest_digest: descriptor.manifest_digest,
    tools: Object.freeze(
      descriptor.tool_contracts
        .map(normalizedToolReceipt)
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  });
}

/**
 * Creates the content-addressed receipt for the reviewed, process-start T0 catalog.
 * It is a catalog-content identity, not evidence that a deployment was published.
 */
export function createT0CatalogGeneration(
  profileInput: unknown,
  descriptorInputs: readonly ModuleDescriptor[] = T0_MODULE_DESCRIPTORS,
  resourceUriInputs: readonly string[] = T0_PRODUCTION_RESOURCE_URIS,
): T0CatalogGenerationReceipt {
  const profile = parseT0ProductionProfile(profileInput);
  return createCatalogGeneration({
    profile,
    descriptorInputs,
    resourceUriInputs,
    expectedModuleIds: T0_PRODUCTION_MODULE_IDS,
    expectedToolNames: T0_PRODUCTION_TOOL_NAMES,
    expectedResourceUris: T0_PRODUCTION_RESOURCE_URIS,
    errorPrefix: "t0",
  }) as T0CatalogGenerationReceipt;
}

interface CatalogGenerationInput {
  readonly profile: ProductionRuntimeProfile;
  readonly descriptorInputs: readonly ModuleDescriptor[];
  readonly resourceUriInputs: readonly string[];
  readonly expectedModuleIds: readonly string[];
  readonly expectedToolNames: readonly string[];
  readonly expectedResourceUris: readonly string[];
  readonly errorPrefix: "t0" | "read_preview";
}

function createCatalogGeneration(input: CatalogGenerationInput): CatalogGenerationReceipt {
  const {
    profile,
    descriptorInputs,
    resourceUriInputs,
    expectedModuleIds,
    expectedToolNames,
    expectedResourceUris,
    errorPrefix,
  } = input;
  const descriptors = descriptorInputs.map((descriptor) => validateModuleDescriptor(descriptor));
  assertExactStringSet(
    descriptors.map(({ module_id }) => module_id),
    expectedModuleIds,
    `${errorPrefix}_catalog_module_set_invalid`,
  );
  assertExactStringSet(
    descriptors.flatMap(({ tool_contracts }) =>
      tool_contracts.map(({ name }) => name)
    ),
    expectedToolNames,
    `${errorPrefix}_catalog_tool_set_invalid`,
  );
  if (resourceUriInputs.some((uri) => typeof uri !== "string")) {
    throw catalogError(
      `${errorPrefix}_catalog_resource_set_invalid`,
      "The runtime catalog resource set is invalid.",
    );
  }
  assertExactStringSet(
    resourceUriInputs,
    expectedResourceUris,
    `${errorPrefix}_catalog_resource_set_invalid`,
  );

  const modules = Object.freeze(
    descriptors
      .map(normalizedModuleReceipt)
      .sort((left, right) => left.module_id.localeCompare(right.module_id)),
  );
  const resourceUris = Object.freeze([...resourceUriInputs].sort());
  const promptNames: readonly [] = Object.freeze([]);
  const canonicalPayload = {
    schema_version: T0_CATALOG_SCHEMA_VERSION,
    profile,
    modules,
    resource_uris: resourceUris,
    prompt_names: promptNames,
  } as const;
  const digestHex = createHash("sha256")
    .update(JSON.stringify(canonicalPayload), "utf8")
    .digest("hex");

  return Object.freeze({
    ...canonicalPayload,
    catalog_generation: `catalog_${digestHex}`,
    catalog_digest: `sha256:${digestHex}`,
  });
}

export function createReadPreviewCatalogGeneration(
  descriptorInputs: readonly ModuleDescriptor[] = READ_PREVIEW_MODULE_DESCRIPTORS,
  resourceUriInputs: readonly string[] = READ_PREVIEW_RESOURCE_URIS,
): ReadPreviewCatalogGenerationReceipt {
  return createCatalogGeneration({
    profile: READ_PREVIEW_STAGING_PROFILE,
    descriptorInputs,
    resourceUriInputs,
    expectedModuleIds: READ_PREVIEW_MODULE_IDS,
    expectedToolNames: READ_PREVIEW_TOOL_NAMES,
    expectedResourceUris: READ_PREVIEW_RESOURCE_URIS,
    errorPrefix: "read_preview",
  }) as ReadPreviewCatalogGenerationReceipt;
}
