import { createHash } from "node:crypto";

import { z } from "zod";

import {
  normalizeCapabilityRequirement,
  type CapabilityRequirementInput,
} from "./capabilities";
import { ModuleRuntimeError } from "./errors";
import type { ModuleCatalogEntry, ModuleManifest, ModuleRiskLevel } from "./types";

export const T0_PRODUCTION_PROFILES = Object.freeze([
  "t0-staging",
  "t0-v1",
] as const);

export type T0ProductionProfile = (typeof T0_PRODUCTION_PROFILES)[number];

export const READ_PREVIEW_STAGING_PROFILE = "read-preview-staging" as const;
export type ReadPreviewProductionProfile = typeof READ_PREVIEW_STAGING_PROFILE;
export type ProductionRuntimeProfile =
  | T0ProductionProfile
  | ReadPreviewProductionProfile;

export const T0_PRODUCTION_MODULE_IDS = Object.freeze([
  "cargo",
  "container",
  "agent-access",
] as const);

export const T0_PRODUCTION_TOOL_NAMES = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
] as const);

export const T0_PRODUCTION_RESOURCE_URIS = Object.freeze([
  "logistics://agent/bootstrap",
  "logistics://standards/index",
  "logistics://contracts/envelope/current",
  "logistics://modules/catalog",
  "logistics://agent/profiles",
] as const);

export const READ_PREVIEW_MODULE_IDS = Object.freeze([
  "cargo",
  "container",
  "canada-final-mile-quote",
  "riskcustoms-ca",
  "freightcom-ltl",
  "agent-access",
] as const);

export const READ_PREVIEW_TOOL_NAMES = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "quote.canada_final_mile.calculate",
  "customs.ca.search",
  "customs.ca.estimate",
  "quote.freightcom_ltl.preview",
  "system.agent_context.get",
] as const);

export const READ_PREVIEW_RESOURCE_URIS = Object.freeze([
  ...T0_PRODUCTION_RESOURCE_URIS,
] as const);

export interface ModuleDescriptor {
  readonly module_id: string;
  readonly version: string;
  readonly risk_level: ModuleRiskLevel;
  readonly tool_names: readonly string[];
  readonly tool_contracts: readonly ReviewedToolContractDescriptor[];
  readonly required_capabilities: readonly CapabilityRequirementInput[];
  readonly optional_capabilities: readonly CapabilityRequirementInput[];
  readonly artifact_digest: `sha256:${string}`;
  readonly manifest_digest: `sha256:${string}`;
}

export interface ReviewedToolContractDescriptor {
  readonly name: string;
  readonly input_schema_id: string;
  readonly output_schema_id: string;
  readonly permission: string;
  readonly kind: "read" | "write";
  readonly risk_level: ModuleRiskLevel;
  readonly standard_refs: readonly string[];
  readonly contract_digest: `sha256:${string}`;
}

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);
const capabilityNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const capabilityVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);
const capabilitySchema = z.union([
  z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:@[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127})?$/u,
  ),
  z.object({
    name: capabilityNameSchema,
    version: capabilityVersionSchema.optional(),
  }).strict(),
]);
const toolContractDescriptorSchema = z.object({
  name: identifierSchema,
  input_schema_id: versionSchema,
  output_schema_id: versionSchema,
  permission: identifierSchema,
  kind: z.enum(["read", "write"]),
  risk_level: z.enum(["T0", "T1", "T2", "T3"]),
  standard_refs: z.array(identifierSchema).min(1),
  contract_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();
const moduleDescriptorSchema = z.object({
  module_id: identifierSchema,
  version: versionSchema,
  risk_level: z.enum(["T0", "T1", "T2", "T3"]),
  tool_names: z.array(identifierSchema).min(1),
  tool_contracts: z.array(toolContractDescriptorSchema).min(1),
  required_capabilities: z.array(capabilitySchema),
  optional_capabilities: z.array(capabilitySchema),
  artifact_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  manifest_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();

function descriptorError(code: string, message: string): ModuleRuntimeError {
  return new ModuleRuntimeError(code, message);
}

function normalizedCapabilities(
  requirements: readonly CapabilityRequirementInput[],
): readonly { readonly name: string; readonly version?: string }[] {
  return requirements
    .map((requirement) => normalizeCapabilityRequirement(requirement))
    .sort((left, right) => {
      const leftKey = `${left.name}\u0000${left.version ?? ""}`;
      const rightKey = `${right.name}\u0000${right.version ?? ""}`;
      return leftKey.localeCompare(rightKey);
    })
    .map((requirement) => requirement.version === undefined
      ? { name: requirement.name }
      : { name: requirement.name, version: requirement.version });
}

function capabilityNames(
  requirements: readonly CapabilityRequirementInput[],
): readonly string[] {
  return requirements.map((requirement) => normalizeCapabilityRequirement(requirement).name);
}

function canonicalToolContractPayload(
  descriptor: Omit<ReviewedToolContractDescriptor, "contract_digest">,
): Record<string, unknown> {
  return {
    name: descriptor.name,
    input_schema_id: descriptor.input_schema_id,
    output_schema_id: descriptor.output_schema_id,
    permission: descriptor.permission,
    kind: descriptor.kind,
    risk_level: descriptor.risk_level,
    standard_refs: [...descriptor.standard_refs].sort(),
  };
}

export function toolContractDigest(
  descriptor: Omit<ReviewedToolContractDescriptor, "contract_digest">,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalToolContractPayload(descriptor)), "utf8")
    .digest("hex")}`;
}

function canonicalToolContracts(
  descriptors: readonly ReviewedToolContractDescriptor[],
): readonly Record<string, unknown>[] {
  return [...descriptors]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((descriptor) => ({
      ...canonicalToolContractPayload(descriptor),
      contract_digest: descriptor.contract_digest,
    }));
}

function canonicalManifestPayload(
  descriptor: Pick<ModuleDescriptor, "module_id" | "version" | "risk_level" | "tool_names" | "tool_contracts" | "required_capabilities" | "optional_capabilities" | "artifact_digest">,
): Record<string, unknown> {
  return {
    module_id: descriptor.module_id,
    version: descriptor.version,
    risk_level: descriptor.risk_level,
    tool_names: [...descriptor.tool_names].sort(),
    tool_contracts: canonicalToolContracts(descriptor.tool_contracts),
    required_capabilities: normalizedCapabilities(descriptor.required_capabilities),
    optional_capabilities: normalizedCapabilities(descriptor.optional_capabilities),
    artifact_digest: descriptor.artifact_digest,
  };
}

export function moduleManifestDigest(
  descriptor: Pick<ModuleDescriptor, "module_id" | "version" | "risk_level" | "tool_names" | "tool_contracts" | "required_capabilities" | "optional_capabilities" | "artifact_digest">,
): `sha256:${string}` {
  const serialized = JSON.stringify(canonicalManifestPayload(descriptor));
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

function assertUnique(values: readonly string[], code: string, label: string): void {
  if (new Set(values).size !== values.length) {
    throw descriptorError(code, `${label} must be unique.`);
  }
}

export function validateModuleDescriptor(input: unknown): ModuleDescriptor {
  const parsed = moduleDescriptorSchema.safeParse(input);
  if (!parsed.success) {
    throw descriptorError("module_descriptor_invalid", "The static module descriptor is invalid.");
  }
  const descriptor = parsed.data as ModuleDescriptor;
  const requiredNames = capabilityNames(descriptor.required_capabilities);
  const optionalNames = capabilityNames(descriptor.optional_capabilities);
  assertUnique(descriptor.tool_names, "module_descriptor_tool_duplicate", "Module descriptor tool names");
  assertUnique(
    descriptor.tool_contracts.map((contract) => contract.name),
    "module_descriptor_tool_duplicate",
    "Module descriptor tool contracts",
  );
  assertExactStringSet(
    descriptor.tool_contracts.map((contract) => contract.name),
    descriptor.tool_names,
    "module_descriptor_tool_contract_set_mismatch",
  );
  for (const contract of descriptor.tool_contracts) {
    assertUnique(
      contract.standard_refs,
      "module_descriptor_standard_ref_duplicate",
      "Module descriptor standard references",
    );
    if (
      contract.risk_level !== descriptor.risk_level ||
      toolContractDigest(contract) !== contract.contract_digest
    ) {
      throw descriptorError(
        "module_descriptor_tool_contract_digest_mismatch",
        "A reviewed tool contract does not match its digest or module risk level.",
      );
    }
  }
  assertUnique(requiredNames, "module_descriptor_capability_duplicate", "Required capabilities");
  assertUnique(optionalNames, "module_descriptor_capability_duplicate", "Optional capabilities");
  if (optionalNames.some((name) => requiredNames.includes(name))) {
    throw descriptorError(
      "module_descriptor_capability_overlap",
      "Required and optional capabilities must be disjoint.",
    );
  }
  const actualManifestDigest = moduleManifestDigest(descriptor);
  if (actualManifestDigest !== descriptor.manifest_digest) {
    throw descriptorError(
      "module_descriptor_digest_mismatch",
      `The static module descriptor digest does not match its normalized manifest for ${descriptor.module_id}: expected ${descriptor.manifest_digest}, received ${actualManifestDigest}.`,
    );
  }
  return descriptor;
}

export function assertModuleDescriptorMatchesManifest(
  descriptor: ModuleDescriptor,
  manifest: ModuleManifest,
): void {
  const descriptorPayload = canonicalManifestPayload(descriptor);
  const manifestPayload = canonicalManifestPayload({
    module_id: manifest.module_id,
    version: manifest.version,
    risk_level: manifest.risk_level,
    tool_names: descriptor.tool_names,
    tool_contracts: descriptor.tool_contracts,
    required_capabilities: manifest.required_capabilities,
    optional_capabilities: manifest.optional_capabilities,
    artifact_digest: descriptor.artifact_digest,
  });
  if (
    descriptorPayload.module_id !== manifestPayload.module_id ||
    descriptorPayload.version !== manifestPayload.version ||
    descriptorPayload.risk_level !== manifestPayload.risk_level ||
    JSON.stringify(descriptorPayload.required_capabilities) !== JSON.stringify(manifestPayload.required_capabilities) ||
    JSON.stringify(descriptorPayload.optional_capabilities) !== JSON.stringify(manifestPayload.optional_capabilities)
  ) {
    throw descriptorError(
      "module_descriptor_manifest_mismatch",
      `The static descriptor does not match module ${manifest.module_id}.`,
    );
  }
}

export function assertReviewedToolContractMatchesCatalogEntry(
  descriptor: ReviewedToolContractDescriptor,
  entry: Pick<
    ModuleCatalogEntry,
    | "name"
    | "inputSchemaId"
    | "outputSchemaId"
    | "permission"
    | "kind"
    | "riskLevel"
    | "standardRefs"
  >,
): void {
  const actual = {
    name: entry.name,
    input_schema_id: entry.inputSchemaId,
    output_schema_id: entry.outputSchemaId,
    permission: entry.permission,
    kind: entry.kind,
    risk_level: entry.riskLevel,
    standard_refs: entry.standardRefs,
  } as const;
  if (toolContractDigest(actual) !== descriptor.contract_digest) {
    throw descriptorError(
      "module_descriptor_tool_contract_mismatch",
      `The mounted tool contract does not match the reviewed descriptor for ${descriptor.name}.`,
    );
  }
}

export function assertExactStringSet(
  actual: readonly string[],
  expected: readonly string[],
  code: string,
): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    new Set(actual).size !== actual.length ||
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    throw descriptorError(code, "The runtime catalog does not match the reviewed exact set.");
  }
}

export function parseT0ProductionProfile(input: unknown): T0ProductionProfile {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim() !== input ||
    !(T0_PRODUCTION_PROFILES as readonly string[]).includes(input)
  ) {
    throw descriptorError(
      "production_profile_invalid",
      "The production runtime profile is not an allowed T0 profile.",
    );
  }
  return input as T0ProductionProfile;
}

export function parseProductionRuntimeProfile(input: unknown): ProductionRuntimeProfile {
  if (input === READ_PREVIEW_STAGING_PROFILE) return READ_PREVIEW_STAGING_PROFILE;
  return parseT0ProductionProfile(input);
}

export const T0_MODULE_DESCRIPTORS: readonly ModuleDescriptor[] = Object.freeze([
  Object.freeze({
    module_id: "cargo",
    version: "2026-08-21.v0",
    risk_level: "T0",
    tool_names: Object.freeze(["cargo.calculate"]),
    tool_contracts: Object.freeze([Object.freeze({
      name: "cargo.calculate",
      input_schema_id: "urn:logistics-mcp:cargo.calculate:2026-08-11.v1",
      output_schema_id: "cargo-result.schema.json",
      permission: "quote:calculate",
      kind: "read",
      risk_level: "T0",
      standard_refs: Object.freeze(["module-runtime.v0", "platform.contracts"]),
      contract_digest: "sha256:3169902268ad04b83a31a23a639f8f32067158f0c551fd094b775e156b5338b4",
    })]),
    required_capabilities: Object.freeze([]),
    optional_capabilities: Object.freeze([]),
    artifact_digest: "sha256:f49982fdd8567627f6de5fd7e43fd98f9a43ee48401ebba2f9b273f4a1691b14",
    manifest_digest: "sha256:8f1ae992488fe6283a84fd4478297e4772999f8224057c6e6838449ef186b91a",
  }),
  Object.freeze({
    module_id: "container",
    version: "2026-08-21.v0",
    risk_level: "T0",
    tool_names: Object.freeze(["container.plan_summary"]),
    tool_contracts: Object.freeze([Object.freeze({
      name: "container.plan_summary",
      input_schema_id: "urn:logistics-mcp:container.plan_summary:2026-08-11.v1",
      output_schema_id: "container-plan.schema.json",
      permission: "container:calculate",
      kind: "read",
      risk_level: "T0",
      standard_refs: Object.freeze(["module-runtime.v0", "platform.contracts"]),
      contract_digest: "sha256:60dded2ebe50e87bd46d7a2faff08adeb1cfad8e4553af56d5d78def73860932",
    })]),
    required_capabilities: Object.freeze([]),
    optional_capabilities: Object.freeze([]),
    artifact_digest: "sha256:3c50abba8b0f4b0f51f4dd6b12f664359df401fa9e63786bcf7edb0fc26bcd07",
    manifest_digest: "sha256:72ab2ce602d646f2471d0a062b409f24c8f6e5c13c9b5ebc65f79334bda7d849",
  }),
  Object.freeze({
    module_id: "agent-access",
    version: "2026-08-21.v0",
    risk_level: "T0",
    tool_names: Object.freeze(["system.agent_context.get"]),
    tool_contracts: Object.freeze([Object.freeze({
      name: "system.agent_context.get",
      input_schema_id: "urn:logistics-mcp:system.agent_context.get:2026-08-21.v1",
      output_schema_id: "agent-context-envelope.schema.json",
      permission: "system:agent_context",
      kind: "read",
      risk_level: "T0",
      standard_refs: Object.freeze(["module-runtime.v0", "platform.contracts", "agent-access.v0"]),
      contract_digest: "sha256:b627534045ba567e4897e1b3708da2e33c1c648dcccfbc32dc079259c4dc22cd",
    })]),
    required_capabilities: Object.freeze([]),
    optional_capabilities: Object.freeze([]),
    artifact_digest: "sha256:490a40f175d6df1fe9469c15e75ed13ebdc3603249d66098e788365ed4a19c64",
    manifest_digest: "sha256:a011e20c6f97c6026834bd0ff087c3c67d3ede7f9499beaf3da88f681d422b6b",
  }),
]);

const READ_PREVIEW_T1_MODULE_DESCRIPTORS: readonly ModuleDescriptor[] = Object.freeze([
  Object.freeze({
    module_id: "canada-final-mile-quote",
    version: "2026-09-02.v1",
    risk_level: "T1",
    tool_names: Object.freeze(["quote.canada_final_mile.calculate"]),
    tool_contracts: Object.freeze([Object.freeze({
      name: "quote.canada_final_mile.calculate",
      input_schema_id: "urn:logistics-mcp:quote.canada_final_mile.calculate:2026-08-13.v2",
      output_schema_id: "quote-envelope-v2.schema.json",
      permission: "quote:calculate",
      kind: "read",
      risk_level: "T1",
      standard_refs: Object.freeze(["module-runtime.v0", "platform.contracts"]),
      contract_digest: "sha256:f0e66bd0e4f637ec13e09c49c4f6c68b9de4f0e18f478a7b79c3df55915e0fab",
    })]),
    required_capabilities: Object.freeze([Object.freeze({
      name: "quote.canada_final_mile.adapter",
      version: "quote-adapter-port@2026-09-02.v1",
    })]),
    optional_capabilities: Object.freeze([]),
    artifact_digest: "sha256:e15b0478e6d409c0b555113f6086585ab9519473e8f2ed50bcb1fb3abaec4813",
    manifest_digest: "sha256:62e16bfacf53cc0f58a683c69d7dca0fd91ae724220fe125184b85275b5264c5",
  }),
  Object.freeze({
    module_id: "riskcustoms-ca",
    version: "2026-09-02.v1",
    risk_level: "T1",
    tool_names: Object.freeze(["customs.ca.search", "customs.ca.estimate"]),
    tool_contracts: Object.freeze([
      Object.freeze({
        name: "customs.ca.search",
        input_schema_id: "urn:logistics-mcp:customs.ca.search:2026-08-11.v1",
        output_schema_id: "customs-search-result.schema.json",
        permission: "tariff:read",
        kind: "read",
        risk_level: "T1",
        standard_refs: Object.freeze(["module-runtime.v0", "platform.contracts"]),
        contract_digest: "sha256:10812b793c2e8be88d2b86c3b3be0638359be30a88bf54412dfabb86d60b99db",
      }),
      Object.freeze({
        name: "customs.ca.estimate",
        input_schema_id: "urn:logistics-mcp:customs.ca.estimate:2026-08-11.v1",
        output_schema_id: "customs-assessment.schema.json",
        permission: "tariff:estimate",
        kind: "read",
        risk_level: "T1",
        standard_refs: Object.freeze(["module-runtime.v0", "platform.contracts"]),
        contract_digest: "sha256:3633fa8060e3f855cfd42394ee89f41be83be1fad1763c0cc2d76946a0d1bd94",
      }),
    ]),
    required_capabilities: Object.freeze([Object.freeze({
      name: "customs.ca.adapter",
      version: "customs-adapter-port@2026-09-02.v1",
    })]),
    optional_capabilities: Object.freeze([]),
    artifact_digest: "sha256:2312643b0ea98837971f0f01d1fef326979f1a6f51f45e315a3fc9a152bec791",
    manifest_digest: "sha256:30803f06a8697843e3cc6532c66ac68f700e82c8eaabc41e904166bb77a9d121",
  }),
  Object.freeze({
    module_id: "freightcom-ltl",
    version: "2026-08-26.v1",
    risk_level: "T1",
    tool_names: Object.freeze(["quote.freightcom_ltl.preview"]),
    tool_contracts: Object.freeze([Object.freeze({
      name: "quote.freightcom_ltl.preview",
      input_schema_id: "urn:logistics-mcp:quote.freightcom_ltl.preview:2026-08-26.v1",
      output_schema_id: "urn:logistics-mcp:quote.freightcom_ltl.preview:result:2026-08-26.v1",
      permission: "quote:calculate",
      kind: "read",
      risk_level: "T1",
      standard_refs: Object.freeze(["module-runtime.v0", "platform.contracts"]),
      contract_digest: "sha256:44171988e40abef43c8b98134212a30d5174110daca8a64b40542b90621d0728",
    })]),
    required_capabilities: Object.freeze([Object.freeze({
      name: "quote.freightcom_ltl.rate_adapter",
      version: "freightcom-rate-port@2026-08-26.v1",
    })]),
    optional_capabilities: Object.freeze([]),
    artifact_digest: "sha256:45baf8321c7154b3d5db850835445cd16c1d576f19ec31889229eb53708ae17d",
    manifest_digest: "sha256:ec98a326201c034d4a73a86c6993de7d8e82793eff87d4edd0ddcda5a6d67cf6",
  }),
]);

export const READ_PREVIEW_MODULE_DESCRIPTORS: readonly ModuleDescriptor[] =
  Object.freeze([
    T0_MODULE_DESCRIPTORS[0]!,
    T0_MODULE_DESCRIPTORS[1]!,
    ...READ_PREVIEW_T1_MODULE_DESCRIPTORS,
    T0_MODULE_DESCRIPTORS[2]!,
  ]);

for (const descriptor of T0_MODULE_DESCRIPTORS) {
  validateModuleDescriptor(descriptor);
}

for (const descriptor of READ_PREVIEW_MODULE_DESCRIPTORS) {
  validateModuleDescriptor(descriptor);
}
