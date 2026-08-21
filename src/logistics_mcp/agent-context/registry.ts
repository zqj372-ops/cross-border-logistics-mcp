import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type {
  AgentAudience,
  AgentProfile,
  AgentProfileRef,
  AgentRegistry,
  AgentStandardRef,
  AgentWorkstreamProjection,
  RegisteredStandard,
  StandardFrontMatter,
} from "./types";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const rulePattern = /^[A-Z][A-Z0-9-]{2,63}$/;

const idSchema = z.string().regex(identifierPattern);
const pathSchema = z.string().regex(pathPattern);
const standardSchema = z
  .object({
    standard_id: idSchema,
    version: z.string().regex(versionPattern),
    path: pathSchema,
    priority: z.number().int().min(0).max(100),
    audiences: z.array(z.enum(["developer", "reviewer", "operator", "caller"])).min(1),
    rule_ids: z.array(z.string().regex(rulePattern)).min(1),
    summary: z.string().min(1).max(300),
  })
  .strict();
const profileRefSchema = z
  .object({ profile_id: idSchema, path: pathSchema })
  .strict();
const moduleSchema = z
  .object({
    module_id: idSchema,
    version: z.string().regex(versionPattern),
    risk_level: z.enum(["T0", "T1", "T2", "T3"]),
    standard_ids: z.array(idSchema),
    tool_names: z.array(idSchema),
  })
  .strict();
const resourceSchema = z
  .object({
    resource_id: idSchema,
    uri: z.string().regex(/^logistics:\/\/[A-Za-z0-9._/-]+$/),
    standard_ids: z.array(idSchema).min(1),
  })
  .strict();
const registrySchema = z
  .object({
    $schema: z.string().min(1),
    schema_version: z.literal("2026-08-21.v1"),
    registry_id: idSchema,
    standards: z.array(standardSchema).min(1),
    profiles: z.array(profileRefSchema).min(1),
    modules: z.array(moduleSchema),
    resources: z.array(resourceSchema),
  })
  .strict();
const profileSchema = z
  .object({
    $schema: z.string().min(1),
    profile_id: idSchema,
    version: z.string().regex(versionPattern),
    audience: z.enum(["developer", "reviewer", "operator", "caller"]),
    standard_ids: z.array(idSchema).min(1),
    allowed_rule_ids: z.array(z.string().regex(rulePattern)).min(1),
    context_scopes: z.array(
      z.enum(["bootstrap", "standards", "module_catalog", "workstreams", "release"]),
    ).min(1),
    allowed_module_ids: z.array(idSchema),
    content_mode: z.enum(["summary", "full"]),
  })
  .strict();
const workstreamSchema = z
  .object({
    workstream_id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    owner: z.string().min(1).max(80),
    writable_paths: z.array(z.string().min(1).max(300)).min(1),
    primary_delivery: z.string().min(1).max(300),
  })
  .strict();
const workstreamsSchema = z
  .object({
    $schema: z.string().min(1),
    schema_version: z.literal("2026-08-21.v1"),
    workstreams: z.array(workstreamSchema).min(1),
    escalation: z.string().min(1).max(500),
  })
  .strict();

export class AgentRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentRegistryError";
    this.code = code;
  }
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new AgentRegistryError(
      "registry.json_invalid",
      `${path}: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new AgentRegistryError(`registry.${label}_duplicate`, `${label} values must be unique.`);
  }
}

export function resolveRegisteredPath(rootDir: string, registeredPath: string): string {
  if (isAbsolute(registeredPath) || !pathPattern.test(registeredPath)) {
    throw new AgentRegistryError("registry.path_invalid", `Registered path is not safe: ${registeredPath}`);
  }
  const root = resolve(rootDir);
  const target = resolve(root, registeredPath);
  const remainder = relative(root, target);
  if (remainder === "" || remainder === ".." || remainder.startsWith(`..` + "/") || isAbsolute(remainder)) {
    throw new AgentRegistryError("registry.path_escape", `Registered path escapes the repository: ${registeredPath}`);
  }
  return target;
}

export function loadAgentRegistry(rootDir: string): AgentRegistry {
  const indexPath = resolveRegisteredPath(rootDir, "docs/agent/index.json");
  const parsed = registrySchema.safeParse(parseJson(indexPath));
  if (!parsed.success) {
    throw new AgentRegistryError("registry.schema_invalid", parsed.error.message);
  }
  const registry = parsed.data as AgentRegistry;
  assertUnique(registry.standards.map((standard) => standard.standard_id), "standard_id");
  assertUnique(registry.profiles.map((profile) => profile.profile_id), "profile_id");
  assertUnique(registry.modules.map((module) => module.module_id), "module_id");
  assertUnique(registry.resources.map((resource) => resource.resource_id), "resource_id");
  assertUnique(registry.resources.map((resource) => resource.uri), "resource_uri");
  for (const standard of registry.standards) {
    resolveRegisteredPath(rootDir, standard.path);
  }
  for (const profile of registry.profiles) {
    resolveRegisteredPath(rootDir, profile.path);
  }
  const standardIds = new Set(registry.standards.map((standard) => standard.standard_id));
  for (const module of registry.modules) {
    if (module.standard_ids.some((standardId) => !standardIds.has(standardId))) {
      throw new AgentRegistryError("registry.module_standard_unknown", `Module ${module.module_id} references an unknown standard.`);
    }
  }
  for (const resource of registry.resources) {
    if (resource.standard_ids.some((standardId) => !standardIds.has(standardId))) {
      throw new AgentRegistryError("registry.resource_standard_unknown", `Resource ${resource.resource_id} references an unknown standard.`);
    }
  }
  return registry;
}

function findStandard(registry: AgentRegistry, standardId: string): AgentStandardRef {
  const standard = registry.standards.find((candidate) => candidate.standard_id === standardId);
  if (standard === undefined) {
    throw new AgentRegistryError("registry.standard_unknown", `Unknown standard: ${standardId}`);
  }
  return standard;
}

function findProfileRef(registry: AgentRegistry, profileId: string): AgentProfileRef {
  const profile = registry.profiles.find((candidate) => candidate.profile_id === profileId);
  if (profile === undefined) {
    throw new AgentRegistryError("registry.profile_unknown", `Unknown Agent profile: ${profileId}`);
  }
  return profile;
}

function parseList(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseFrontMatter(content: string, sourcePath: string): StandardFrontMatter {
  if (!content.startsWith("---\n")) {
    throw new AgentRegistryError("standard.front_matter_missing", `${sourcePath} must start with stable front matter.`);
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new AgentRegistryError("standard.front_matter_invalid", `${sourcePath} has no closing front matter delimiter.`);
  }
  const fields = new Map<string, string>();
  for (const line of content.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const standardId = fields.get("standard_id");
  const version = fields.get("version");
  const priority = Number(fields.get("priority"));
  const audienceValue = fields.get("audience");
  const ruleValue = fields.get("rule_ids");
  if (
    standardId === undefined ||
    version === undefined ||
    !Number.isInteger(priority) ||
    audienceValue === undefined ||
    ruleValue === undefined
  ) {
    throw new AgentRegistryError("standard.front_matter_incomplete", `${sourcePath} front matter is incomplete.`);
  }
  const audiences = parseList(audienceValue) as AgentAudience[];
  const ruleIds = parseList(ruleValue);
  if (
    !identifierPattern.test(standardId) ||
    !versionPattern.test(version) ||
    priority < 0 ||
    priority > 100 ||
    audiences.length === 0 ||
    audiences.some((audience) => !["developer", "reviewer", "operator", "caller"].includes(audience)) ||
    ruleIds.length === 0 ||
    ruleIds.some((ruleId) => !rulePattern.test(ruleId))
  ) {
    throw new AgentRegistryError("standard.front_matter_invalid", `${sourcePath} front matter contains invalid values.`);
  }
  return {
    standard_id: standardId,
    version,
    priority,
    audiences,
    rule_ids: ruleIds,
  };
}

export function readRegisteredStandard(
  rootDir: string,
  registry: AgentRegistry,
  standardId: string,
): RegisteredStandard {
  const ref = findStandard(registry, standardId);
  const sourcePath = resolveRegisteredPath(rootDir, ref.path);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new AgentRegistryError("standard.source_missing", `Registered standard source is missing: ${ref.path}`);
  }
  const content = readFileSync(sourcePath, "utf8");
  const frontMatter = parseFrontMatter(content, ref.path);
  if (
    frontMatter.standard_id !== ref.standard_id ||
    frontMatter.version !== ref.version ||
    frontMatter.priority !== ref.priority ||
    [...frontMatter.audiences].sort().join(",") !== [...ref.audiences].sort().join(",") ||
    [...frontMatter.rule_ids].sort().join(",") !== [...ref.rule_ids].sort().join(",")
  ) {
    throw new AgentRegistryError("standard.registry_mismatch", `Front matter does not match registry for ${standardId}.`);
  }
  return { ...ref, content, front_matter: frontMatter };
}

export function loadAgentProfile(
  rootDir: string,
  registry: AgentRegistry,
  profileId: string,
): AgentProfile {
  const ref = findProfileRef(registry, profileId);
  const profilePath = resolveRegisteredPath(rootDir, ref.path);
  if (!existsSync(profilePath) || !statSync(profilePath).isFile()) {
    throw new AgentRegistryError("profile.source_missing", `Registered profile source is missing: ${ref.path}`);
  }
  const parsed = profileSchema.safeParse(parseJson(profilePath));
  if (!parsed.success) {
    throw new AgentRegistryError("profile.schema_invalid", parsed.error.message);
  }
  const profile = parsed.data as AgentProfile;
  if (profile.profile_id !== ref.profile_id) {
    throw new AgentRegistryError("profile.registry_mismatch", `Profile source does not match ${profileId}.`);
  }
  const standardIds = new Set(registry.standards.map((standard) => standard.standard_id));
  if (profile.standard_ids.some((standardId) => !standardIds.has(standardId))) {
    throw new AgentRegistryError("profile.standard_unknown", `Profile ${profileId} references an unknown standard.`);
  }
  const moduleIds = new Set(registry.modules.map((module) => module.module_id));
  if (profile.allowed_module_ids.some((moduleId) => !moduleIds.has(moduleId))) {
    throw new AgentRegistryError("profile.module_unknown", `Profile ${profileId} references an unknown module.`);
  }
  const knownRules = new Set(registry.standards.flatMap((standard) => standard.rule_ids));
  if (profile.allowed_rule_ids.some((ruleId) => !knownRules.has(ruleId))) {
    throw new AgentRegistryError("profile.rule_unknown", `Profile ${profileId} references an unknown rule.`);
  }
  return profile;
}

export function loadWorkstreamProjection(rootDir: string): AgentWorkstreamProjection {
  const path = resolveRegisteredPath(rootDir, "docs/agent/workstreams/current.json");
  const parsed = workstreamsSchema.safeParse(parseJson(path));
  if (!parsed.success) {
    throw new AgentRegistryError("workstreams.schema_invalid", parsed.error.message);
  }
  return parsed.data;
}
