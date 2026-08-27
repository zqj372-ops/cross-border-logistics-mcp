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

export interface ModuleDescriptor {
  readonly module_id: string;
  readonly version: string;
  readonly risk_level: ModuleRiskLevel;
  readonly tool_names: readonly string[];
  readonly tool_contracts: readonly ReviewedToolContractDescriptor[];
  readonly required_capabilities: readonly CapabilityRequirementInput[];
  readonly optional_capabilities: readonly CapabilityRequirementInput[];
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
  descriptor: Pick<ModuleDescriptor, "module_id" | "version" | "risk_level" | "tool_names" | "tool_contracts" | "required_capabilities" | "optional_capabilities">,
): Record<string, unknown> {
  return {
    module_id: descriptor.module_id,
    version: descriptor.version,
    risk_level: descriptor.risk_level,
    tool_names: [...descriptor.tool_names].sort(),
    tool_contracts: canonicalToolContracts(descriptor.tool_contracts),
    required_capabilities: normalizedCapabilities(descriptor.required_capabilities),
    optional_capabilities: normalizedCapabilities(descriptor.optional_capabilities),
  };
}

export function moduleManifestDigest(
  descriptor: Pick<ModuleDescriptor, "module_id" | "version" | "risk_level" | "tool_names" | "tool_contracts" | "required_capabilities" | "optional_capabilities">,
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
  if (moduleManifestDigest(descriptor) !== descriptor.manifest_digest) {
    throw descriptorError(
      "module_descriptor_digest_mismatch",
      "The static module descriptor digest does not match its normalized manifest.",
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
    manifest_digest: "sha256:4a3125f1a305aa1d68b7a10616fcdcefe172e8e6aea310317a63cdb38eab6ef4",
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
    manifest_digest: "sha256:f06ef7053f07b264a214cc5022f77f51794fb730dfa6df99169df4a835472bc4",
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
    manifest_digest: "sha256:93c40b3def7a5ddf256267d11527f193e515460cbc197be83c5c5d7873bdfa8f",
  }),
]);

for (const descriptor of T0_MODULE_DESCRIPTORS) {
  validateModuleDescriptor(descriptor);
}
