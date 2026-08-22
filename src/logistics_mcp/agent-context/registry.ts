import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

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
import { isSafeRepositoryRelativeWorkstreamPath } from "./workstream-path";

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

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new AgentRegistryError(
      "registry.json_invalid",
      "Registered JSON source is invalid.",
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new AgentRegistryError(`registry.${label}_duplicate`, `${label} values must be unique.`);
  }
}

interface InspectedRegisteredPath {
  readonly root: string;
  readonly target: string;
  readonly realTarget: string;
  readonly device: number;
  readonly inode: number;
  readonly pathIdentities: readonly PathIdentity[];
}

interface PathIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return (
    remainder !== "" &&
    remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

function trustedRootRealPath(rootDir: string): string {
  const rootEntry = resolve(rootDir);
  try {
    const rootName = parse(rootEntry).root;
    const components = rootEntry.slice(rootName.length).split(/[\\/]/u).filter(Boolean);
    let cursor = rootName;
    for (const [index, component] of components.entries()) {
      cursor = resolve(cursor, component);
      const status = lstatSync(cursor);
      if (status.isSymbolicLink()) {
        throw new AgentRegistryError(
          "registry.root_symlink",
          "Trusted repository root must not be a symbolic link.",
        );
      }
      if (index < components.length - 1 && !status.isDirectory()) {
        throw new AgentRegistryError(
          "registry.root_invalid",
          "Trusted repository root is not a directory.",
        );
      }
    }
    const entryStatus = lstatSync(rootEntry);
    if (entryStatus.isSymbolicLink()) {
      throw new AgentRegistryError(
        "registry.root_symlink",
        "Trusted repository root must not be a symbolic link.",
      );
    }
    if (!entryStatus.isDirectory()) {
      throw new AgentRegistryError(
        "registry.root_invalid",
        "Trusted repository root is not a directory.",
      );
    }
    const realRoot = realpathSync(rootEntry);
    if (realRoot !== rootEntry || !lstatSync(realRoot).isDirectory()) {
      throw new AgentRegistryError(
        "registry.root_symlink",
        "Trusted repository root must not be a symbolic link.",
      );
    }
    return realRoot;
  } catch (error: unknown) {
    if (error instanceof AgentRegistryError) throw error;
    throw new AgentRegistryError(
      "registry.root_unavailable",
      "Trusted repository root is unavailable.",
    );
  }
}

function inspectRegisteredPath(
  rootDir: string,
  registeredPath: string,
): InspectedRegisteredPath {
  if (isAbsolute(registeredPath) || !pathPattern.test(registeredPath)) {
    throw new AgentRegistryError("registry.path_invalid", "Registered path is invalid.");
  }

  const root = trustedRootRealPath(rootDir);
  const target = resolve(root, registeredPath);
  if (!isStrictlyInside(root, target)) {
    throw new AgentRegistryError(
      "registry.path_escape",
      "Registered source resolves outside the trusted repository root.",
    );
  }

  const components = registeredPath.split("/");
  let cursor = root;
  let finalDevice = 0;
  let finalInode = 0;
  const pathIdentities: PathIdentity[] = [];
  const rootStatus = lstatSync(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new AgentRegistryError(
      "registry.root_symlink",
      "Trusted repository root must not be a symbolic link.",
    );
  }
  pathIdentities.push({ path: root, device: rootStatus.dev, inode: rootStatus.ino });
  for (const [index, component] of components.entries()) {
    cursor = resolve(cursor, component);
    let status;
    try {
      status = lstatSync(cursor);
    } catch {
      throw new AgentRegistryError("registry.path_missing", "Registered source is missing.");
    }
    if (status.isSymbolicLink()) {
      throw new AgentRegistryError(
        "registry.path_symlink",
        "Registered source path contains a symbolic link.",
      );
    }
    if (index < components.length - 1 && !status.isDirectory()) {
      throw new AgentRegistryError(
        "registry.path_component_invalid",
        "Registered source path contains a non-directory ancestor.",
      );
    }
    if (index === components.length - 1 && !status.isFile()) {
      throw new AgentRegistryError("registry.path_not_file", "Registered source is not a regular file.");
    }
    if (index === components.length - 1) {
      finalDevice = status.dev;
      finalInode = status.ino;
    }
    pathIdentities.push({ path: cursor, device: status.dev, inode: status.ino });
  }

  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    throw new AgentRegistryError("registry.path_unavailable", "Registered source is unavailable.");
  }
  if (!isStrictlyInside(root, realTarget)) {
    throw new AgentRegistryError(
      "registry.path_escape",
      "Registered source resolves outside the trusted repository root.",
    );
  }
  try {
    const realStatus = lstatSync(realTarget);
    if (!realStatus.isFile()) {
      throw new AgentRegistryError("registry.path_not_file", "Registered source is not a regular file.");
    }
    if (realStatus.dev !== finalDevice || realStatus.ino !== finalInode) {
      throw new AgentRegistryError(
        "registry.path_changed",
        "Registered source changed during verification.",
      );
    }
  } catch (error: unknown) {
    if (error instanceof AgentRegistryError) throw error;
    throw new AgentRegistryError("registry.path_unavailable", "Registered source is unavailable.");
  }
  return {
    root,
    target,
    realTarget,
    device: finalDevice,
    inode: finalInode,
    pathIdentities,
  };
}

export function readRegisteredBytes(rootDir: string, registeredPath: string): Buffer {
  const inspected = inspectRegisteredPath(rootDir, registeredPath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      inspected.target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedStatus = fstatSync(descriptor);
    if (!openedStatus.isFile()) {
      throw new AgentRegistryError(
        "registry.path_not_file",
        "Registered source is not a regular file.",
      );
    }

    let postOpenRealTarget: string;
    let postOpenStatus: ReturnType<typeof lstatSync>;
    try {
      postOpenRealTarget = realpathSync(inspected.target);
      postOpenStatus = lstatSync(inspected.target);
      for (const identity of inspected.pathIdentities) {
        const current = lstatSync(identity.path);
        if (
          current.isSymbolicLink() ||
          current.dev !== identity.device ||
          current.ino !== identity.inode
        ) {
          throw new AgentRegistryError(
            "registry.path_changed",
            "Registered source changed during verification.",
          );
        }
      }
    } catch {
      throw new AgentRegistryError(
        "registry.path_changed",
        "Registered source changed during verification.",
      );
    }
    if (
      postOpenStatus.isSymbolicLink() ||
      !postOpenStatus.isFile() ||
      !isStrictlyInside(inspected.root, postOpenRealTarget) ||
      postOpenRealTarget !== inspected.realTarget ||
      openedStatus.dev !== inspected.device ||
      openedStatus.ino !== inspected.inode ||
      postOpenStatus.dev !== openedStatus.dev ||
      postOpenStatus.ino !== openedStatus.ino
    ) {
      throw new AgentRegistryError(
        "registry.path_changed",
        "Registered source changed during verification.",
      );
    }
    return readFileSync(descriptor);
  } catch (error: unknown) {
    if (error instanceof AgentRegistryError) throw error;
    throw new AgentRegistryError(
      "registry.path_changed",
      "Registered source changed during verification.",
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor was opened only for this bounded read and must not escape.
      }
    }
  }
}

export function readRegisteredText(rootDir: string, registeredPath: string): string {
  return readRegisteredBytes(rootDir, registeredPath).toString("utf8");
}

export function readRegisteredJson(rootDir: string, registeredPath: string): unknown {
  return parseJson(readRegisteredText(rootDir, registeredPath));
}

export function loadAgentRegistry(rootDir: string): AgentRegistry {
  const parsed = registrySchema.safeParse(
    readRegisteredJson(rootDir, "docs/agent/index.json"),
  );
  if (!parsed.success) {
    throw new AgentRegistryError(
      "registry.schema_invalid",
      "Registered Agent index does not match its closed schema.",
    );
  }
  const registry = parsed.data as AgentRegistry;
  assertUnique(registry.standards.map((standard) => standard.standard_id), "standard_id");
  assertUnique(registry.profiles.map((profile) => profile.profile_id), "profile_id");
  assertUnique(registry.modules.map((module) => module.module_id), "module_id");
  assertUnique(registry.resources.map((resource) => resource.resource_id), "resource_id");
  assertUnique(registry.resources.map((resource) => resource.uri), "resource_uri");
  for (const standard of registry.standards) {
    inspectRegisteredPath(rootDir, standard.path);
  }
  for (const profile of registry.profiles) {
    inspectRegisteredPath(rootDir, profile.path);
  }
  const standardIds = new Set(registry.standards.map((standard) => standard.standard_id));
  for (const module of registry.modules) {
    if (module.standard_ids.some((standardId) => !standardIds.has(standardId))) {
      throw new AgentRegistryError(
        "registry.module_standard_unknown",
        "A registered module references an unknown standard.",
      );
    }
  }
  for (const resource of registry.resources) {
    if (resource.standard_ids.some((standardId) => !standardIds.has(standardId))) {
      throw new AgentRegistryError(
        "registry.resource_standard_unknown",
        "A registered resource references an unknown standard.",
      );
    }
  }
  return registry;
}

function findStandard(registry: AgentRegistry, standardId: string): AgentStandardRef {
  const standard = registry.standards.find((candidate) => candidate.standard_id === standardId);
  if (standard === undefined) {
    throw new AgentRegistryError(
      "registry.standard_unknown",
      "The requested standard is not registered.",
    );
  }
  return standard;
}

function findProfileRef(registry: AgentRegistry, profileId: string): AgentProfileRef {
  const profile = registry.profiles.find((candidate) => candidate.profile_id === profileId);
  if (profile === undefined) {
    throw new AgentRegistryError(
      "registry.profile_unknown",
      "The requested Agent profile is not registered.",
    );
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
    if (separator <= 0) {
      throw new AgentRegistryError(
        "standard.front_matter_invalid",
        "Registered standard front matter is invalid.",
      );
    }
    const key = line.slice(0, separator).trim();
    if (fields.has(key)) {
      throw new AgentRegistryError(
        "standard.front_matter_invalid",
        "Registered standard front matter is invalid.",
      );
    }
    fields.set(key, line.slice(separator + 1).trim());
  }
  const requiredKeys = ["standard_id", "version", "priority", "audience", "rule_ids"];
  const allowedKeys = new Set([...requiredKeys, "status"]);
  if (
    requiredKeys.some((key) => !fields.has(key)) ||
    [...fields.keys()].some((key) => !allowedKeys.has(key)) ||
    (fields.get("status") !== undefined && fields.get("status") !== "accepted")
  ) {
    throw new AgentRegistryError(
      "standard.front_matter_invalid",
      "Registered standard front matter is invalid.",
    );
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
  const content = readRegisteredText(rootDir, ref.path);
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
  const parsed = profileSchema.safeParse(readRegisteredJson(rootDir, ref.path));
  if (!parsed.success) {
    throw new AgentRegistryError(
      "profile.schema_invalid",
      "Registered Agent profile does not match its closed schema.",
    );
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
  const parsed = workstreamsSchema.safeParse(
    readRegisteredJson(rootDir, "docs/agent/workstreams/current.json"),
  );
  if (!parsed.success) {
    throw new AgentRegistryError(
      "workstreams.schema_invalid",
      "Registered workstream projection does not match its closed schema.",
    );
  }
  if (
    parsed.data.workstreams.some((workstream) =>
      workstream.writable_paths.some(
        (path) => !isSafeRepositoryRelativeWorkstreamPath(path),
      ),
    )
  ) {
    throw new AgentRegistryError(
      "workstreams.path_invalid",
      "Registered workstream paths must be repository-relative.",
    );
  }
  return parsed.data;
}
