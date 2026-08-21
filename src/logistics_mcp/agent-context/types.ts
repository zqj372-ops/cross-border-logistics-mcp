export const AGENT_AUDIENCES = [
  "developer",
  "reviewer",
  "operator",
  "caller",
] as const;

export type AgentAudience = (typeof AGENT_AUDIENCES)[number];

export const AGENT_CONTEXT_SCOPES = [
  "bootstrap",
  "standards",
  "module_catalog",
  "workstreams",
  "release",
] as const;

export type AgentContextScope = (typeof AGENT_CONTEXT_SCOPES)[number];

export interface AgentStandardRef {
  readonly standard_id: string;
  readonly version: string;
  readonly path: string;
  readonly priority: number;
  readonly audiences: readonly AgentAudience[];
  readonly rule_ids: readonly string[];
  readonly summary: string;
}

export interface AgentProfileRef {
  readonly profile_id: string;
  readonly path: string;
}

export interface AgentModuleRef {
  readonly module_id: string;
  readonly version: string;
  readonly risk_level: "T0" | "T1" | "T2" | "T3";
  readonly standard_ids: readonly string[];
  readonly tool_names: readonly string[];
}

export interface AgentResourceRef {
  readonly resource_id: string;
  readonly uri: string;
  readonly standard_ids: readonly string[];
}

export interface AgentRegistry {
  readonly $schema: string;
  readonly schema_version: "2026-08-21.v1";
  readonly registry_id: string;
  readonly standards: readonly AgentStandardRef[];
  readonly profiles: readonly AgentProfileRef[];
  readonly modules: readonly AgentModuleRef[];
  readonly resources: readonly AgentResourceRef[];
}

export interface AgentProfile {
  readonly $schema: string;
  readonly profile_id: string;
  readonly version: string;
  readonly audience: AgentAudience;
  readonly standard_ids: readonly string[];
  readonly allowed_rule_ids: readonly string[];
  readonly context_scopes: readonly AgentContextScope[];
  readonly allowed_module_ids: readonly string[];
  readonly content_mode: "summary" | "full";
}

export interface StandardFrontMatter {
  readonly standard_id: string;
  readonly version: string;
  readonly priority: number;
  readonly audiences: readonly AgentAudience[];
  readonly rule_ids: readonly string[];
}

export interface RegisteredStandard extends AgentStandardRef {
  readonly content: string;
  readonly front_matter: StandardFrontMatter;
}

export interface AgentWorkstream {
  readonly workstream_id: string;
  readonly owner: string;
  readonly writable_paths: readonly string[];
  readonly primary_delivery: string;
}

export interface AgentWorkstreamProjection {
  readonly schema_version: "2026-08-21.v1";
  readonly workstreams: readonly AgentWorkstream[];
  readonly escalation: string;
}

export interface AgentPackStandard {
  readonly standard_id: string;
  readonly version: string;
  readonly priority: number;
  readonly audiences: readonly AgentAudience[];
  readonly rule_ids: readonly string[];
  readonly summary: string;
  readonly sha256: string;
  readonly source_ref: string;
  readonly content: string;
}

export interface AgentStandardPack {
  readonly pack_schema_version: "2026-08-21.v1";
  readonly registry_id: string;
  readonly standards: readonly AgentPackStandard[];
  readonly profiles: readonly AgentProfile[];
  readonly modules: readonly AgentModuleRef[];
  readonly resources: readonly AgentResourceRef[];
  readonly workstreams: AgentWorkstreamProjection;
}
