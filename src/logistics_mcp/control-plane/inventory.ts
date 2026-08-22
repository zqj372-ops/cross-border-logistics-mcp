import { createHash } from "node:crypto";

import { ForbiddenError, getToolPolicy } from "../platform/rbac";
import type {
  DescriptorDigest,
  ModuleInventoryEntry,
  ModuleInventoryInput,
  ModuleLocalEvidence,
  MountedModuleData,
  MountedToolContract,
} from "./types";

const MODULE_RISK_LEVELS = ["T0", "T1", "T2", "T3"] as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SCHEMA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const LOCAL_REFERENCE_PATTERN = /^(?:local|fixture):[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const MODULE_KEYS = [
  "moduleId",
  "version",
  "riskLevel",
  "lifecycle",
  "requiredCapabilities",
  "optionalCapabilities",
  "standardRefs",
] as const;
const TOOL_KEYS = [
  "owner",
  "name",
  "permission",
  "kind",
  "riskLevel",
  "inputSchemaId",
  "outputSchemaId",
  "standardRefs",
] as const;
const EVIDENCE_KEYS = ["moduleId", "version", "evidenceLevel", "productionEligible", "evidenceRefs"] as const;
const EVIDENCE_REF_KEYS = [
  "sourceShaRef",
  "artifactDigestRef",
  "signatureRef",
  "sbomRef",
  "attestationRef",
] as const;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class ModuleInventoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModuleInventoryError";
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, code: string, label: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) {
    throw new ModuleInventoryError(code, `${label} must be an object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new ModuleInventoryError(code, `${label} has an unsupported or incomplete field set.`);
  }
}

function assertString(value: unknown, pattern: RegExp, code: string, label: string): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ModuleInventoryError(code, `${label} is malformed.`);
  }
}

function assertArray(value: unknown, code: string, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ModuleInventoryError(code, `${label} must be an array.`);
  }
}

function assertUniqueStrings(values: readonly unknown[], code: string, label: string): asserts values is readonly string[] {
  for (const value of values) {
    assertString(value, IDENTIFIER_PATTERN, code, `${label} entry`);
  }
  if (new Set(values).size !== values.length) {
    throw new ModuleInventoryError(code, `${label} must not contain duplicates.`);
  }
}

function assertNonemptyUniqueStrings(
  values: readonly unknown[],
  code: string,
  label: string,
): asserts values is readonly string[] {
  if (values.length === 0) {
    throw new ModuleInventoryError(code, `${label} must not be empty.`);
  }
  assertUniqueStrings(values, code, label);
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function assertLocalReference(value: unknown, label: string): asserts value is string | null {
  if (value === null) return;
  if (typeof value !== "string" || !LOCAL_REFERENCE_PATTERN.test(value)) {
    throw new ModuleInventoryError("local_evidence_invalid", `${label} must be null or a controlled local reference.`);
  }
}

function copyEvidenceRefs(value: unknown): ModuleLocalEvidence["evidenceRefs"] {
  assertObject(value, "local_evidence_invalid", "evidenceRefs");
  assertExactKeys(value, EVIDENCE_REF_KEYS, "local_evidence_invalid", "evidenceRefs");
  for (const key of EVIDENCE_REF_KEYS) {
    assertLocalReference(value[key], `evidenceRefs.${key}`);
  }
  return {
    sourceShaRef: value.sourceShaRef as string | null,
    artifactDigestRef: value.artifactDigestRef as string | null,
    signatureRef: value.signatureRef as string | null,
    sbomRef: value.sbomRef as string | null,
    attestationRef: value.attestationRef as string | null,
  };
}

function validateModule(value: unknown, index: number): MountedModuleData {
  assertObject(value, "module_invalid", `mountedModules[${index}]`);
  assertExactKeys(value, MODULE_KEYS, "module_contract_incomplete", `mountedModules[${index}]`);
  assertString(value.moduleId, IDENTIFIER_PATTERN, "module_invalid", `mountedModules[${index}].moduleId`);
  assertString(value.version, VERSION_PATTERN, "module_invalid", `mountedModules[${index}].version`);
  if (!MODULE_RISK_LEVELS.includes(value.riskLevel as (typeof MODULE_RISK_LEVELS)[number])) {
    throw new ModuleInventoryError("module_invalid", `mountedModules[${index}].riskLevel is malformed.`);
  }
  if (value.lifecycle !== "static") {
    throw new ModuleInventoryError("module_lifecycle_invalid", `Module ${value.moduleId} is not static.`);
  }
  assertArray(value.requiredCapabilities, "module_contract_incomplete", `mountedModules[${index}].requiredCapabilities`);
  assertArray(value.optionalCapabilities, "module_contract_incomplete", `mountedModules[${index}].optionalCapabilities`);
  assertArray(value.standardRefs, "module_contract_incomplete", `mountedModules[${index}].standardRefs`);
  assertUniqueStrings(value.requiredCapabilities, "module_contract_invalid", `mountedModules[${index}].requiredCapabilities`);
  assertUniqueStrings(value.optionalCapabilities, "module_contract_invalid", `mountedModules[${index}].optionalCapabilities`);
  assertNonemptyUniqueStrings(value.standardRefs, "module_contract_incomplete", `mountedModules[${index}].standardRefs`);
  const required = new Set(value.requiredCapabilities);
  if (value.optionalCapabilities.some((capability) => required.has(capability))) {
    throw new ModuleInventoryError("module_capability_overlap", `Module ${value.moduleId} repeats a required capability as optional.`);
  }
  return {
    moduleId: value.moduleId,
    version: value.version,
    riskLevel: value.riskLevel as MountedModuleData["riskLevel"],
    lifecycle: "static",
    requiredCapabilities: [...value.requiredCapabilities],
    optionalCapabilities: [...value.optionalCapabilities],
    standardRefs: [...value.standardRefs],
  };
}

function validateTool(value: unknown, index: number): MountedToolContract {
  assertObject(value, "tool_invalid", `catalog[${index}]`);
  assertExactKeys(value, TOOL_KEYS, "tool_contract_incomplete", `catalog[${index}]`);
  assertString(value.owner, IDENTIFIER_PATTERN, "tool_invalid", `catalog[${index}].owner`);
  assertString(value.name, IDENTIFIER_PATTERN, "tool_invalid", `catalog[${index}].name`);
  assertString(value.permission, IDENTIFIER_PATTERN, "tool_invalid", `catalog[${index}].permission`);
  if (value.kind !== "read" && value.kind !== "write") {
    throw new ModuleInventoryError("tool_invalid", `catalog[${index}].kind is malformed.`);
  }
  if (!MODULE_RISK_LEVELS.includes(value.riskLevel as (typeof MODULE_RISK_LEVELS)[number])) {
    throw new ModuleInventoryError("tool_invalid", `catalog[${index}].riskLevel is malformed.`);
  }
  assertString(value.inputSchemaId, SCHEMA_ID_PATTERN, "tool_contract_incomplete", `catalog[${index}].inputSchemaId`);
  assertString(value.outputSchemaId, SCHEMA_ID_PATTERN, "tool_contract_incomplete", `catalog[${index}].outputSchemaId`);
  assertArray(value.standardRefs, "tool_contract_incomplete", `catalog[${index}].standardRefs`);
  assertNonemptyUniqueStrings(value.standardRefs, "tool_contract_incomplete", `catalog[${index}].standardRefs`);
  let policy: ReturnType<typeof getToolPolicy>;
  try {
    policy = getToolPolicy(value.name);
  } catch (error: unknown) {
    if (error instanceof ForbiddenError) {
      throw new ModuleInventoryError("tool_policy_unknown", "Tool policy is not defined.");
    }
    throw error;
  }
  if (value.permission !== policy.permission) {
    throw new ModuleInventoryError(
      "tool_permission_mismatch",
      `Tool permission does not match the fixed RBAC policy: ${value.name}`,
    );
  }
  if (value.kind !== policy.kind) {
    throw new ModuleInventoryError(
      "tool_kind_mismatch",
      `Tool kind does not match the fixed RBAC policy: ${value.name}`,
    );
  }
  return {
    owner: value.owner,
    name: value.name,
    permission: value.permission,
    kind: value.kind,
    riskLevel: value.riskLevel as MountedToolContract["riskLevel"],
    inputSchemaId: value.inputSchemaId,
    outputSchemaId: value.outputSchemaId,
    standardRefs: [...value.standardRefs],
  };
}

function validateLocalEvidence(value: unknown, index: number): ModuleLocalEvidence {
  assertObject(value, "local_evidence_invalid", `localEvidence[${index}]`);
  const actualKeys = Object.keys(value);
  const requiredKeys = ["moduleId", "version", "evidenceRefs"];
  const hasOnlyKnownKeys = actualKeys.every((key) => EVIDENCE_KEYS.includes(key as (typeof EVIDENCE_KEYS)[number]));
  if (!hasOnlyKnownKeys || requiredKeys.some((key) => !actualKeys.includes(key))) {
    throw new ModuleInventoryError("local_evidence_invalid", `localEvidence[${index}] has an unsupported or incomplete field set.`);
  }
  assertString(value.moduleId, IDENTIFIER_PATTERN, "local_evidence_invalid", `localEvidence[${index}].moduleId`);
  assertString(value.version, VERSION_PATTERN, "local_evidence_invalid", `localEvidence[${index}].version`);
  if (value.evidenceLevel !== undefined && value.evidenceLevel !== "local_build") {
    throw new ModuleInventoryError("local_evidence_invalid", `localEvidence[${index}].evidenceLevel is not local_build.`);
  }
  if (value.productionEligible !== undefined && value.productionEligible !== false) {
    throw new ModuleInventoryError("local_evidence_invalid", `localEvidence[${index}] cannot be production eligible.`);
  }
  return {
    moduleId: value.moduleId,
    version: value.version,
    evidenceRefs: copyEvidenceRefs(value.evidenceRefs),
  };
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function canonicalize(value: JsonValue): string {
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function descriptorDigest(value: JsonValue): DescriptorDigest {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

function freezeEntry(entry: ModuleInventoryEntry): ModuleInventoryEntry {
  Object.freeze(entry.toolNames);
  Object.freeze(entry.standardRefs);
  Object.freeze(entry.evidenceRefs);
  return Object.freeze(entry);
}

export function createModuleInventory(input: ModuleInventoryInput): readonly ModuleInventoryEntry[] {
  assertObject(input, "inventory_invalid", "inventory input");
  assertExactKeys(input, ["mountedModules", "catalog", "localEvidence"], "inventory_invalid", "inventory input");
  assertArray(input.mountedModules, "inventory_invalid", "mountedModules");
  assertArray(input.catalog, "inventory_invalid", "catalog");
  assertArray(input.localEvidence, "inventory_invalid", "localEvidence");

  const modules = input.mountedModules.map((module, index) => validateModule(module, index));
  const moduleIds = new Set<string>();
  for (const module of modules) {
    if (moduleIds.has(module.moduleId)) {
      throw new ModuleInventoryError("module_duplicate", `Module ID is duplicated: ${module.moduleId}`);
    }
    moduleIds.add(module.moduleId);
  }

  const tools = input.catalog.map((tool, index) => validateTool(tool, index));
  const toolOwners = new Set<string>();
  const toolNames = new Set<string>();
  for (const tool of tools) {
    if (!moduleIds.has(tool.owner)) {
      throw new ModuleInventoryError("tool_owner_unknown", `Tool owner is not a mounted module: ${tool.owner}`);
    }
    if (toolOwners.has(tool.owner)) {
      throw new ModuleInventoryError("tool_owner_duplicate", `Tool owner is duplicated: ${tool.owner}`);
    }
    toolOwners.add(tool.owner);
    if (toolNames.has(tool.name)) {
      throw new ModuleInventoryError("tool_duplicate", `Tool name is duplicated: ${tool.name}`);
    }
    toolNames.add(tool.name);
  }

  const evidenceByModule = new Map<string, ModuleLocalEvidence>();
  for (const [index, rawEvidence] of input.localEvidence.entries()) {
    const evidence = validateLocalEvidence(rawEvidence, index);
    const key = `${evidence.moduleId}\u0000${evidence.version}`;
    if (evidenceByModule.has(key)) {
      throw new ModuleInventoryError("local_evidence_duplicate", `Local evidence is duplicated for ${evidence.moduleId}.`);
    }
    evidenceByModule.set(key, evidence);
  }

  for (const evidence of evidenceByModule.values()) {
    if (!moduleIds.has(evidence.moduleId)) {
      throw new ModuleInventoryError("local_evidence_unknown", `Local evidence refers to an unknown module: ${evidence.moduleId}.`);
    }
    const module = modules.find((candidate) => candidate.moduleId === evidence.moduleId);
    if (module?.version !== evidence.version) {
      throw new ModuleInventoryError("local_evidence_unknown", `Local evidence version is not mounted: ${evidence.moduleId}.`);
    }
  }

  const entries = modules.map((module) => {
    const evidenceKey = `${module.moduleId}\u0000${module.version}`;
    const evidence = evidenceByModule.get(evidenceKey);
    if (evidence === undefined) {
      throw new ModuleInventoryError("local_evidence_missing", `Local evidence is missing for ${module.moduleId}.`);
    }
    const ownedTools = tools
      .filter((tool) => tool.owner === module.moduleId)
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const canonicalDescriptor = {
      moduleId: module.moduleId,
      version: module.version,
      riskLevel: module.riskLevel,
      lifecycle: module.lifecycle,
      requiredCapabilities: sortedStrings(module.requiredCapabilities),
      optionalCapabilities: sortedStrings(module.optionalCapabilities),
      standardRefs: sortedStrings(module.standardRefs),
      tools: ownedTools.map((tool) => ({
        owner: tool.owner,
        name: tool.name,
        permission: tool.permission,
        kind: tool.kind,
        riskLevel: tool.riskLevel,
        inputSchemaId: tool.inputSchemaId,
        outputSchemaId: tool.outputSchemaId,
        standardRefs: sortedStrings(tool.standardRefs),
      })),
      evidenceLevel: "local_build",
      productionEligible: false,
      evidenceRefs: evidence.evidenceRefs,
    } satisfies JsonValue;
    const entry: ModuleInventoryEntry = {
      moduleId: module.moduleId,
      version: module.version,
      riskLevel: module.riskLevel,
      toolNames: Object.freeze(ownedTools.map((tool) => tool.name)),
      standardRefs: Object.freeze(sortedStrings(module.standardRefs)),
      descriptorDigest: descriptorDigest(canonicalDescriptor),
      evidenceLevel: "local_build",
      productionEligible: false,
      evidenceRefs: Object.freeze({ ...evidence.evidenceRefs }),
    };
    return freezeEntry(entry);
  }).sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0);

  return Object.freeze(entries);
}
