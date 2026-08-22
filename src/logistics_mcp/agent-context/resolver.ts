import { buildAgentStandardPack } from "./pack";
import { validateAndFreezeAgentStandardPack } from "./pack-validation";
import { assertSafeAgentDataGraph } from "./safety";
import type {
  AgentContextScope,
  AgentModuleRef,
  AgentPackStandard,
  AgentProfile,
  AgentStandardPack,
} from "./types";

export type { AgentStandardPack } from "./types";

export interface AgentContextSourceRef {
  readonly source_id: string;
  readonly version: string;
  readonly content_hash: string;
  readonly locator: string;
}

export interface AgentContextStandardProjection {
  readonly standard_id: string;
  readonly version: string;
  readonly priority: number;
  readonly rule_ids: readonly string[];
  readonly summary: string;
  readonly sha256: string;
  readonly content?: string;
}

export interface AgentContextRuleProjection {
  readonly rule_id: string;
  readonly standard_id: string;
  readonly priority: number;
  readonly source_sha256: string;
}

export type AgentContextModuleProjection = AgentModuleRef;

export interface AgentContextProjection extends Record<string, unknown> {
  readonly status: "success";
  readonly schema_version: "2026-08-21.v1";
  readonly profile_id: string;
  readonly profile_version: string;
  readonly scopes: readonly AgentContextScope[];
  readonly selected_module_id: string | null;
  readonly standards: readonly AgentContextStandardProjection[];
  readonly rules: readonly AgentContextRuleProjection[];
  readonly modules: readonly AgentContextModuleProjection[];
  readonly workstreams: readonly {
    readonly workstream_id: string;
    readonly owner: string;
    readonly writable_paths: readonly string[];
    readonly primary_delivery: string;
  }[];
  readonly source_refs: readonly AgentContextSourceRef[];
}

export interface ResolveAgentContextOptions {
  readonly profileId: string;
  readonly moduleId?: string;
}

export class AgentContextResolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentContextResolutionError";
    this.code = code;
  }
}

function requireValidatedPack(pack: AgentStandardPack): AgentStandardPack {
  try {
    return validateAndFreezeAgentStandardPack(pack);
  } catch {
    throw new AgentContextResolutionError(
      "pack_invalid",
      "The Agent Standard Pack is invalid.",
    );
  }
}

function requireSafeResolveOptions<T extends ResolveAgentContextOptions>(
  options: unknown,
): T {
  try {
    assertSafeAgentDataGraph(options);
  } catch {
    throw new AgentContextResolutionError(
      "input_invalid",
      "The Agent context request is invalid.",
    );
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new AgentContextResolutionError(
      "input_invalid",
      "The Agent context request is invalid.",
    );
  }
  return options as T;
}

function profileFor(pack: AgentStandardPack, profileId: string): AgentProfile {
  const profile = pack.profiles.find((candidate) => candidate.profile_id === profileId);
  if (profile === undefined) {
    throw new AgentContextResolutionError(
      "profile_unknown",
      "The requested Agent profile is not registered.",
    );
  }
  return profile;
}

function moduleFor(pack: AgentStandardPack, profile: AgentProfile, moduleId: string | undefined): AgentModuleRef | null {
  if (moduleId === undefined) return null;
  if (!profile.allowed_module_ids.includes(moduleId)) {
    throw new AgentContextResolutionError(
      "module_not_allowed",
      "The requested module is not allowed for this Agent profile.",
    );
  }
  const module = pack.modules.find((candidate) => candidate.module_id === moduleId);
  if (module === undefined) {
    throw new AgentContextResolutionError(
      "module_unknown",
      "The requested module is not registered.",
    );
  }
  return module;
}

function selectedStandards(pack: AgentStandardPack, profile: AgentProfile): readonly AgentPackStandard[] {
  const selected = profile.standard_ids.map((standardId) => {
    const standard = pack.standards.find((candidate) => candidate.standard_id === standardId);
    if (standard === undefined) {
      throw new AgentContextResolutionError(
        "standard_unknown",
        "An Agent profile references an unknown standard.",
      );
    }
    if (!standard.audiences.includes(profile.audience)) {
      throw new AgentContextResolutionError(
        "standard_audience_mismatch",
        "An Agent profile references a standard for another audience.",
      );
    }
    return standard;
  });
  return [...selected].sort((left, right) =>
    right.priority - left.priority || left.standard_id.localeCompare(right.standard_id),
  );
}
function resolveRules(
  standards: readonly AgentPackStandard[],
  profile: AgentProfile,
): readonly AgentContextRuleProjection[] {
  const allowed = new Set(profile.allowed_rule_ids);
  const byRule = new Map<string, AgentPackStandard[]>();
  for (const standard of standards) {
    for (const ruleId of standard.rule_ids) {
      if (!allowed.has(ruleId)) {
        throw new AgentContextResolutionError("rule_not_allowed", `Profile does not allow rule ${ruleId}.`);
      }
      const current = byRule.get(ruleId) ?? [];
      current.push(standard);
      byRule.set(ruleId, current);
    }
  }
  const rules: AgentContextRuleProjection[] = [];
  for (const [ruleId, candidates] of byRule.entries()) {
    const ordered = [...candidates].sort(
      (left, right) => right.priority - left.priority || left.standard_id.localeCompare(right.standard_id),
    );
    const highestPriority = ordered[0]?.priority;
    const highest = ordered.filter((candidate) => candidate.priority === highestPriority);
    if (new Set(highest.map((candidate) => candidate.sha256)).size > 1) {
      throw new AgentContextResolutionError(
        "rule_conflict",
        `Rule ${ruleId} has conflicting same-priority sources.`,
      );
    }
    const selected = ordered[0];
    if (selected === undefined) {
      throw new AgentContextResolutionError("rule_empty", `Rule ${ruleId} has no source.`);
    }
    rules.push({
      rule_id: ruleId,
      standard_id: selected.standard_id,
      priority: selected.priority,
      source_sha256: selected.sha256,
    });
  }
  return rules.sort((left, right) =>
    right.priority - left.priority || left.rule_id.localeCompare(right.rule_id),
  );
}

function projectStandard(
  standard: AgentPackStandard,
  contentMode: AgentProfile["content_mode"],
): AgentContextStandardProjection {
  return {
    standard_id: standard.standard_id,
    version: standard.version,
    priority: standard.priority,
    rule_ids: [...standard.rule_ids],
    summary: standard.summary,
    sha256: standard.sha256,
    ...(contentMode === "full" ? { content: standard.content } : {}),
  };
}

export function resolveAgentContextFromPack(
  pack: AgentStandardPack,
  options: ResolveAgentContextOptions,
): AgentContextProjection {
  const validatedPack = requireValidatedPack(pack);
  const safeOptions = requireSafeResolveOptions<ResolveAgentContextOptions>(options);
  const profile = profileFor(validatedPack, safeOptions.profileId);
  const selectedModule = moduleFor(validatedPack, profile, safeOptions.moduleId);
  const standards = selectedStandards(validatedPack, profile);
  const modules = profile.context_scopes.includes("module_catalog")
    ? validatedPack.modules.filter((module) => profile.allowed_module_ids.includes(module.module_id))
    : [];
  const scopedModules = selectedModule === null
    ? modules
    : modules.filter((module) => module.module_id === selectedModule.module_id);
  const workstreams = profile.context_scopes.includes("workstreams")
    ? validatedPack.workstreams.workstreams
    : [];
  return {
    status: "success",
    schema_version: "2026-08-21.v1",
    profile_id: profile.profile_id,
    profile_version: profile.version,
    scopes: [...profile.context_scopes],
    selected_module_id: selectedModule?.module_id ?? null,
    standards: standards.map((standard) => projectStandard(standard, profile.content_mode)),
    rules: resolveRules(standards, profile),
    modules: scopedModules,
    workstreams,
    source_refs: standards.map((standard) => ({
      source_id: standard.source_ref,
      version: standard.version,
      content_hash: standard.sha256,
      locator: standard.source_ref,
    })),
  };
}

export interface RepositoryAgentContextOptions extends ResolveAgentContextOptions {
  readonly rootDir: string;
}

export function resolveAgentContextFromRepository(
  options: RepositoryAgentContextOptions,
): AgentContextProjection {
  const safeOptions = requireSafeResolveOptions<RepositoryAgentContextOptions>(options);
  return resolveAgentContextFromPack(
    buildAgentStandardPack(safeOptions.rootDir),
    safeOptions,
  );
}
