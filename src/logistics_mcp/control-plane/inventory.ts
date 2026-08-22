import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { ForbiddenError, getToolPolicy } from "../platform/rbac";
import {
  IDENTIFIER_PATTERN,
  VERSION_PATTERN,
} from "./lexical-contracts";
import type {
  DescriptorDigest,
  ModuleInventoryEntry,
  ModuleInventoryInput,
  ModuleLocalEvidence,
  MountedModuleData,
  MountedToolContract,
  TrustedModuleInventory,
} from "./types";

const MODULE_RISK_LEVELS = ["T0", "T1", "T2", "T3"] as const;
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
const EVIDENCE_REQUIRED_KEYS = ["moduleId", "version", "evidenceRefs"] as const;
const EVIDENCE_OPTIONAL_KEYS = ["evidenceLevel", "productionEligible"] as const;
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

interface ClosedRecordFields {
  readonly values: readonly unknown[];
  readonly present: readonly boolean[];
}

const trustedInventories = new WeakSet<object>();

export class ModuleInventoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModuleInventoryError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ModuleInventoryError(code, message);
}

function stableUnexpectedFailure(): never {
  throw new ModuleInventoryError("inventory_invalid", "Inventory input is malformed.");
}

function materializeClosedRecord(
  value: unknown,
  requiredKeys: readonly string[],
  code: string,
  label: string,
  optionalKeys: readonly string[] = [],
): ClosedRecordFields {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(code, `${label} must be an ordinary object.`);
  }

  const expectedKeys = [...requiredKeys, ...optionalKeys];
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length < requiredKeys.length ||
    ownKeys.length > expectedKeys.length
  ) {
    return fail(code, `${label} has an unsupported or incomplete field set.`);
  }

  const values: unknown[] = new Array(expectedKeys.length);
  const present: boolean[] = new Array<boolean>(expectedKeys.length).fill(false);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== "string") {
      return fail(code, `${label} must not contain symbol keys.`);
    }
    const keyIndex = expectedKeys.indexOf(key);
    if (keyIndex < 0 || present[keyIndex]) {
      return fail(code, `${label} has an unsupported or incomplete field set.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail(code, `${label}.${key} must be an own enumerable data property.`);
    }
    values[keyIndex] = descriptor.value;
    present[keyIndex] = true;
  }

  for (let index = 0; index < requiredKeys.length; index += 1) {
    if (!present[index]) {
      return fail(code, `${label} has an unsupported or incomplete field set.`);
    }
  }
  return { values, present };
}

function materializeClosedArray(
  value: unknown,
  code: string,
  label: string,
): readonly unknown[] {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return fail(code, `${label} must be a standard dense array.`);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return fail(code, `${label}.length must be the standard data property.`);
  }

  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) {
    return fail(code, `${label} must contain only continuous array indexes.`);
  }

  let hasLength = false;
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (key === "length") {
      if (hasLength) {
        return fail(code, `${label} has an invalid length property.`);
      }
      hasLength = true;
      continue;
    }
    if (typeof key !== "string") {
      return fail(code, `${label} must not contain symbol keys.`);
    }
    const numericIndex = Number(key);
    if (
      !Number.isSafeInteger(numericIndex) ||
      numericIndex < 0 ||
      numericIndex >= length ||
      String(numericIndex) !== key
    ) {
      return fail(code, `${label} contains a non-index own property.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail(code, `${label}[${numericIndex}] must be an own enumerable data property.`);
    }
  }
  if (!hasLength) {
    return fail(code, `${label} must contain the standard length property.`);
  }

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail(code, `${label}[${index}] must be an own enumerable data property.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function assertString(
  value: unknown,
  pattern: RegExp,
  code: string,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ModuleInventoryError(code, `${label} is malformed.`);
  }
}

function validateStringArray(
  value: unknown,
  code: string,
  label: string,
  requireNonempty: boolean,
): string[] {
  const values = materializeClosedArray(value, code, label);
  if (requireNonempty && values.length === 0) {
    throw new ModuleInventoryError(code, `${label} must not be empty.`);
  }

  const strings: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    assertString(entry, IDENTIFIER_PATTERN, code, `${label}[${index}]`);
    if (seen.has(entry)) {
      throw new ModuleInventoryError(code, `${label} must not contain duplicates.`);
    }
    seen.add(entry);
    strings.push(entry);
  }
  return strings;
}

function sortedStrings(values: readonly string[]): readonly string[] {
  const copy = values.slice();
  copy.sort();
  return copy;
}

function assertLocalReference(value: unknown, label: string): asserts value is string | null {
  if (value === null) return;
  if (typeof value !== "string" || !LOCAL_REFERENCE_PATTERN.test(value)) {
    throw new ModuleInventoryError(
      "local_evidence_invalid",
      `${label} must be null or a controlled local reference.`,
    );
  }
}

function copyEvidenceRefs(value: unknown): ModuleLocalEvidence["evidenceRefs"] {
  const fields = materializeClosedRecord(
    value,
    EVIDENCE_REF_KEYS,
    "local_evidence_invalid",
    "evidenceRefs",
  );
  for (let index = 0; index < EVIDENCE_REF_KEYS.length; index += 1) {
    assertLocalReference(fields.values[index], `evidenceRefs.${EVIDENCE_REF_KEYS[index]!}`);
  }
  return {
    sourceShaRef: fields.values[0] as string | null,
    artifactDigestRef: fields.values[1] as string | null,
    signatureRef: fields.values[2] as string | null,
    sbomRef: fields.values[3] as string | null,
    attestationRef: fields.values[4] as string | null,
  };
}

function validateModule(value: unknown, index: number): MountedModuleData {
  const label = `mountedModules[${index}]`;
  const fields = materializeClosedRecord(value, MODULE_KEYS, "module_contract_incomplete", label);
  const moduleId = fields.values[0];
  const version = fields.values[1];
  const riskLevel = fields.values[2];
  const lifecycle = fields.values[3];
  const requiredCapabilities = validateStringArray(
    fields.values[4],
    "module_contract_incomplete",
    `${label}.requiredCapabilities`,
    false,
  );
  const optionalCapabilities = validateStringArray(
    fields.values[5],
    "module_contract_incomplete",
    `${label}.optionalCapabilities`,
    false,
  );
  const standardRefs = validateStringArray(
    fields.values[6],
    "module_contract_incomplete",
    `${label}.standardRefs`,
    true,
  );

  assertString(moduleId, IDENTIFIER_PATTERN, "module_invalid", `${label}.moduleId`);
  assertString(version, VERSION_PATTERN, "module_invalid", `${label}.version`);
  if (!MODULE_RISK_LEVELS.includes(riskLevel as (typeof MODULE_RISK_LEVELS)[number])) {
    throw new ModuleInventoryError("module_invalid", `${label}.riskLevel is malformed.`);
  }
  if (lifecycle !== "static") {
    throw new ModuleInventoryError("module_lifecycle_invalid", `Module ${moduleId} is not static.`);
  }

  const required = new Set(requiredCapabilities);
  for (let index = 0; index < optionalCapabilities.length; index += 1) {
    if (required.has(optionalCapabilities[index]!)) {
      throw new ModuleInventoryError(
        "module_capability_overlap",
        `Module ${moduleId} repeats a required capability as optional.`,
      );
    }
  }

  return {
    moduleId,
    version,
    riskLevel: riskLevel as MountedModuleData["riskLevel"],
    lifecycle: "static",
    requiredCapabilities: requiredCapabilities.slice(),
    optionalCapabilities: optionalCapabilities.slice(),
    standardRefs: standardRefs.slice(),
  };
}

function validateTool(value: unknown, index: number): MountedToolContract {
  const label = `catalog[${index}]`;
  const fields = materializeClosedRecord(value, TOOL_KEYS, "tool_contract_incomplete", label);
  const owner = fields.values[0];
  const name = fields.values[1];
  const permission = fields.values[2];
  const kind = fields.values[3];
  const riskLevel = fields.values[4];
  const inputSchemaId = fields.values[5];
  const outputSchemaId = fields.values[6];
  const standardRefs = validateStringArray(
    fields.values[7],
    "tool_contract_incomplete",
    `${label}.standardRefs`,
    true,
  );

  assertString(owner, IDENTIFIER_PATTERN, "tool_invalid", `${label}.owner`);
  assertString(name, IDENTIFIER_PATTERN, "tool_invalid", `${label}.name`);
  assertString(permission, IDENTIFIER_PATTERN, "tool_invalid", `${label}.permission`);
  if (kind !== "read" && kind !== "write") {
    throw new ModuleInventoryError("tool_invalid", `${label}.kind is malformed.`);
  }
  if (!MODULE_RISK_LEVELS.includes(riskLevel as (typeof MODULE_RISK_LEVELS)[number])) {
    throw new ModuleInventoryError("tool_invalid", `${label}.riskLevel is malformed.`);
  }
  assertString(inputSchemaId, SCHEMA_ID_PATTERN, "tool_contract_incomplete", `${label}.inputSchemaId`);
  assertString(outputSchemaId, SCHEMA_ID_PATTERN, "tool_contract_incomplete", `${label}.outputSchemaId`);

  let policy: ReturnType<typeof getToolPolicy>;
  try {
    policy = getToolPolicy(name);
  } catch (error: unknown) {
    if (error instanceof ForbiddenError) {
      throw new ModuleInventoryError("tool_policy_unknown", "Tool policy is not defined.");
    }
    return stableUnexpectedFailure();
  }
  if (permission !== policy.permission) {
    throw new ModuleInventoryError(
      "tool_permission_mismatch",
      `Tool permission does not match the fixed RBAC policy: ${name}`,
    );
  }
  if (kind !== policy.kind) {
    throw new ModuleInventoryError(
      "tool_kind_mismatch",
      `Tool kind does not match the fixed RBAC policy: ${name}`,
    );
  }
  return {
    owner,
    name,
    permission,
    kind,
    riskLevel: riskLevel as MountedToolContract["riskLevel"],
    inputSchemaId,
    outputSchemaId,
    standardRefs: standardRefs.slice(),
  };
}

function validateLocalEvidence(value: unknown, index: number): ModuleLocalEvidence {
  const label = `localEvidence[${index}]`;
  const fields = materializeClosedRecord(
    value,
    EVIDENCE_REQUIRED_KEYS,
    "local_evidence_invalid",
    label,
    EVIDENCE_OPTIONAL_KEYS,
  );
  const moduleId = fields.values[0];
  const version = fields.values[1];
  assertString(moduleId, IDENTIFIER_PATTERN, "local_evidence_invalid", `${label}.moduleId`);
  assertString(version, VERSION_PATTERN, "local_evidence_invalid", `${label}.version`);
  if (fields.present[3] && fields.values[3] !== "local_build") {
    throw new ModuleInventoryError("local_evidence_invalid", `${label}.evidenceLevel is not local_build.`);
  }
  if (fields.present[4] && fields.values[4] !== false) {
    throw new ModuleInventoryError("local_evidence_invalid", `${label} cannot be production eligible.`);
  }
  return {
    moduleId,
    version,
    evidenceRefs: copyEvidenceRefs(fields.values[2]),
  };
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: JsonValue): string {
  if (isJsonArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (item === undefined) {
        return stableUnexpectedFailure();
      }
      items.push(canonicalize(item));
    }
    return `[${items.join(",")}]`;
  }
  if (isJsonObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const child = value[key];
        if (child === undefined) {
          return stableUnexpectedFailure();
        }
        return `${JSON.stringify(key)}:${canonicalize(child)}`;
      });
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

function createInventory(input: ModuleInventoryInput): TrustedModuleInventory {
  const inputFields = materializeClosedRecord(
    input,
    ["mountedModules", "catalog", "localEvidence"],
    "inventory_invalid",
    "inventory input",
  );
  const rawModules = materializeClosedArray(inputFields.values[0], "inventory_invalid", "mountedModules");
  const rawTools = materializeClosedArray(inputFields.values[1], "inventory_invalid", "catalog");
  const rawEvidence = materializeClosedArray(inputFields.values[2], "inventory_invalid", "localEvidence");

  const modules: MountedModuleData[] = [];
  for (let index = 0; index < rawModules.length; index += 1) {
    modules.push(validateModule(rawModules[index], index));
  }
  const moduleIds = new Set<string>();
  const modulesById = new Map<string, MountedModuleData>();
  for (let index = 0; index < modules.length; index += 1) {
    const module = modules[index]!;
    if (moduleIds.has(module.moduleId)) {
      throw new ModuleInventoryError("module_duplicate", `Module ID is duplicated: ${module.moduleId}`);
    }
    moduleIds.add(module.moduleId);
    modulesById.set(module.moduleId, module);
  }

  const tools: MountedToolContract[] = [];
  for (let index = 0; index < rawTools.length; index += 1) {
    tools.push(validateTool(rawTools[index], index));
  }
  const toolNames = new Set<string>();
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index]!;
    const ownerModule = modulesById.get(tool.owner);
    if (ownerModule === undefined) {
      throw new ModuleInventoryError("tool_owner_unknown", `Tool owner is not a mounted module: ${tool.owner}`);
    }
    if (tool.riskLevel !== ownerModule.riskLevel) {
      throw new ModuleInventoryError(
        "tool_risk_mismatch",
        `Tool risk does not match its owner module: ${tool.name}`,
      );
    }
    const toolStandards = new Set(tool.standardRefs);
    for (let standardIndex = 0; standardIndex < ownerModule.standardRefs.length; standardIndex += 1) {
      if (!toolStandards.has(ownerModule.standardRefs[standardIndex]!)) {
        throw new ModuleInventoryError(
          "tool_standard_missing",
          `Tool does not declare every owner module standard: ${tool.name}`,
        );
      }
    }
    if (toolNames.has(tool.name)) {
      throw new ModuleInventoryError("tool_duplicate", `Tool name is duplicated: ${tool.name}`);
    }
    toolNames.add(tool.name);
  }

  const evidenceByModule = new Map<string, ModuleLocalEvidence>();
  for (let index = 0; index < rawEvidence.length; index += 1) {
    const evidence = validateLocalEvidence(rawEvidence[index], index);
    const key = `${evidence.moduleId}\u0000${evidence.version}`;
    if (evidenceByModule.has(key)) {
      throw new ModuleInventoryError("local_evidence_duplicate", `Local evidence is duplicated for ${evidence.moduleId}.`);
    }
    evidenceByModule.set(key, evidence);
  }

  for (const evidence of evidenceByModule.values()) {
    const module = modulesById.get(evidence.moduleId);
    if (module === undefined) {
      throw new ModuleInventoryError("local_evidence_unknown", `Local evidence refers to an unknown module: ${evidence.moduleId}.`);
    }
    if (module.version !== evidence.version) {
      throw new ModuleInventoryError("local_evidence_unknown", `Local evidence version is not mounted: ${evidence.moduleId}.`);
    }
  }

  const entries: ModuleInventoryEntry[] = [];
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const module = modules[moduleIndex]!;
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
    } satisfies JsonValue;

    const toolNamesForEntry = ownedTools.map((tool) => tool.name);
    const standardRefsForEntry = sortedStrings(module.standardRefs);
    const evidenceRefs = {
      sourceShaRef: evidence.evidenceRefs.sourceShaRef,
      artifactDigestRef: evidence.evidenceRefs.artifactDigestRef,
      signatureRef: evidence.evidenceRefs.signatureRef,
      sbomRef: evidence.evidenceRefs.sbomRef,
      attestationRef: evidence.evidenceRefs.attestationRef,
    };
    entries.push(freezeEntry({
      moduleId: module.moduleId,
      version: module.version,
      riskLevel: module.riskLevel,
      toolNames: Object.freeze(toolNamesForEntry),
      standardRefs: Object.freeze(standardRefsForEntry),
      descriptorDigest: descriptorDigest(canonicalDescriptor),
      evidenceLevel: "local_build",
      productionEligible: false,
      evidenceRefs: Object.freeze(evidenceRefs),
    }));
  }
  entries.sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0);
  const trusted = Object.freeze(entries) as TrustedModuleInventory;
  trustedInventories.add(trusted);
  return trusted;
}

export function isTrustedModuleInventory(value: unknown): value is TrustedModuleInventory {
  return typeof value === "object" && value !== null && trustedInventories.has(value);
}

export function assertTrustedModuleInventory(value: unknown): asserts value is TrustedModuleInventory {
  if (!isTrustedModuleInventory(value)) {
    throw new ModuleInventoryError("inventory_untrusted", "Inventory was not created by createModuleInventory.");
  }
}

export function createModuleInventory(input: ModuleInventoryInput): TrustedModuleInventory {
  try {
    return createInventory(input);
  } catch (error: unknown) {
    if (error instanceof ModuleInventoryError) {
      throw error;
    }
    return stableUnexpectedFailure();
  }
}
