import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  AgentStandardPack,
  StandardFrontMatter,
} from "./types";
import {
  AgentArtifactSafetyError,
  assertSafeAgentDataGraph,
  findAgentArtifactSafetyIssues,
} from "./safety";
import { CANONICAL_AGENT_RESOURCES } from "./resources";
import { isSafeRepositoryRelativeWorkstreamPath } from "./workstream-path";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/);
const ruleIdSchema = z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const audienceSchema = z.enum(["developer", "reviewer", "operator", "caller"]);
const contextScopeSchema = z.enum([
  "bootstrap",
  "standards",
  "module_catalog",
  "workstreams",
  "release",
]);

const packStandardSchema = z
  .object({
    standard_id: identifierSchema,
    version: versionSchema,
    priority: z.number().int().min(0).max(100),
    audiences: z.array(audienceSchema).min(1),
    rule_ids: z.array(ruleIdSchema).min(1),
    summary: z.string().min(1).max(300),
    sha256: sha256Schema,
    source_ref: z.string().min(1).max(400),
    content: z.string().min(1),
  })
  .strict();

const profileSchema = z
  .object({
    $schema: z.string().min(1),
    profile_id: identifierSchema,
    version: versionSchema,
    audience: audienceSchema,
    standard_ids: z.array(identifierSchema).min(1),
    allowed_rule_ids: z.array(ruleIdSchema).min(1),
    context_scopes: z.array(contextScopeSchema).min(1),
    allowed_module_ids: z.array(identifierSchema),
    content_mode: z.enum(["summary", "full"]),
  })
  .strict();

const moduleSchema = z
  .object({
    module_id: identifierSchema,
    version: versionSchema,
    risk_level: z.enum(["T0", "T1", "T2", "T3"]),
    standard_ids: z.array(identifierSchema),
    tool_names: z.array(identifierSchema),
  })
  .strict();

const resourceSchema = z
  .object({
    resource_id: identifierSchema,
    uri: z.string().regex(/^logistics:\/\/[A-Za-z0-9._/-]+$/),
    standard_ids: z.array(identifierSchema).min(1),
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

const workstreamProjectionSchema = z
  .object({
    $schema: z.string().min(1),
    schema_version: z.literal("2026-08-21.v1"),
    workstreams: z.array(workstreamSchema).min(1),
    escalation: z.string().min(1).max(500),
  })
  .strict();

const agentStandardPackSchema = z
  .object({
    pack_schema_version: z.literal("2026-08-21.v1"),
    registry_id: identifierSchema,
    standards: z.array(packStandardSchema).min(1),
    profiles: z.array(profileSchema).min(1),
    modules: z.array(moduleSchema),
    resources: z.array(resourceSchema),
    workstreams: workstreamProjectionSchema,
  })
  .strict();

const runtimeCallerModuleIds = ["agent-access", "cargo", "container"] as const;

const runtimeCallerEntitlements = Object.freeze({
  standardIds: Object.freeze([
    "agent.bootstrap",
    "mcp-server-architecture-v1",
    "platform.contracts",
    "agent-access.v0",
    "release-agent-adapters",
    "t0-production-profile-v1",
    "credential-exchange-v1",
  ]),
  ruleIds: Object.freeze([
    "AGENT-BOOT-001",
    "SEC-BOUNDARY-001",
    "MCP-SERVER-BOUNDARY-001",
    "MCP-TRANSPORT-001",
    "MCP-CREDENTIAL-001",
    "MCP-MODULE-001",
    "MCP-ADMIN-BOUNDARY-001",
    "CONTRACT-SCHEMA-001",
    "STATUS-ENVELOPE-001",
    "AGENT-PROFILE-001",
    "AGENT-CONTEXT-001",
    "AGENT-RESOURCE-001",
    "RELEASE-ADAPTER-001",
    "RELEASE-ADAPTER-002",
    "T0-PROFILE-001",
    "T0-CATALOG-001",
    "T0-READINESS-001",
    "T0-AUTH-001",
    "ACCESS-EXCHANGE-001",
    "ACCESS-JWT-001",
    "ACCESS-REVOKE-001",
    "ACCESS-AUDIT-001",
  ]),
  contextScopes: Object.freeze([
    "bootstrap",
    "standards",
    "module_catalog",
    "release",
  ]),
  moduleIds: runtimeCallerModuleIds,
});

const runtimeCallerModuleEntitlements = Object.freeze({
  cargo: Object.freeze({
    riskLevel: "T0",
    standardIds: Object.freeze(["module-runtime.v0", "platform.contracts"]),
    toolNames: Object.freeze(["cargo.calculate"]),
  }),
  container: Object.freeze({
    riskLevel: "T0",
    standardIds: Object.freeze(["module-runtime.v0", "platform.contracts"]),
    toolNames: Object.freeze(["container.plan_summary"]),
  }),
  "agent-access": Object.freeze({
    riskLevel: "T0",
    standardIds: Object.freeze(["module-runtime.v0", "platform.contracts", "agent-access.v0"]),
    toolNames: Object.freeze(["system.agent_context.get"]),
  }),
});

export class AgentPackValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentPackValidationError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new AgentPackValidationError(
    code,
    "Agent Standard Pack failed closed validation.",
  );
}

function assertPlainDataGraph(value: unknown, seen = new WeakSet<object>()): void {
  // Keep this local wrapper so pack validation retains its stable error-code
  // namespace while the public scanner owns the trap-free graph walk.
  try {
    assertSafeAgentDataGraph(value, seen);
  } catch (error: unknown) {
    if (error instanceof AgentArtifactSafetyError) {
      fail(`pack.${error.reason}`);
    }
    fail("pack.graph_invalid");
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

function parseList(value: string | undefined): readonly string[] {
  return value === undefined
    ? []
    : value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseFrontMatter(content: string): StandardFrontMatter {
  if (!content.startsWith("---\n")) fail("pack.front_matter_invalid");
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) fail("pack.front_matter_invalid");
  const fields = new Map<string, string>();
  for (const line of content.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) fail("pack.front_matter_invalid");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (fields.has(key)) fail("pack.front_matter_invalid");
    fields.set(key, value);
  }
  const requiredKeys = [
    "standard_id",
    "version",
    "priority",
    "audience",
    "rule_ids",
  ];
  const allowedKeys = new Set([...requiredKeys, "status"]);
  if (
    requiredKeys.some((key) => !fields.has(key)) ||
    [...fields.keys()].some((key) => !allowedKeys.has(key))
  ) {
    fail("pack.front_matter_invalid");
  }
  const status = fields.get("status");
  if (status !== undefined && status !== "accepted") {
    fail("pack.front_matter_invalid");
  }
  const priority = Number(fields.get("priority"));
  if (!Number.isInteger(priority)) fail("pack.front_matter_invalid");
  return {
    standard_id: fields.get("standard_id") ?? "",
    version: fields.get("version") ?? "",
    priority,
    audiences: parseList(fields.get("audience")) as StandardFrontMatter["audiences"],
    rule_ids: parseList(fields.get("rule_ids")),
  };
}

function assertSafeRelativeWorkstreamPath(path: string): void {
  if (!isSafeRepositoryRelativeWorkstreamPath(path)) {
    fail("pack.workstream_path_invalid");
  }
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function contentSha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function assertPackSemantics(pack: AgentStandardPack): void {
  assertUnique(pack.standards.map((standard) => standard.standard_id), "pack.standard_id_duplicate");
  assertUnique(pack.profiles.map((profile) => profile.profile_id), "pack.profile_id_duplicate");
  assertUnique(pack.modules.map((module) => module.module_id), "pack.module_id_duplicate");
  assertUnique(pack.resources.map((resource) => resource.resource_id), "pack.resource_id_duplicate");
  assertUnique(pack.resources.map((resource) => resource.uri), "pack.resource_uri_duplicate");
  assertUnique(pack.workstreams.workstreams.map((workstream) => workstream.workstream_id), "pack.workstream_id_duplicate");
  assertUnique(pack.modules.flatMap((module) => module.tool_names), "pack.tool_name_duplicate");

  for (const standard of pack.standards) {
    assertUnique(standard.audiences, "pack.standard_audience_duplicate");
    assertUnique(standard.rule_ids, "pack.standard_rule_duplicate");
    if (standard.sha256 !== contentSha256(standard.content)) {
      fail("pack.standard_digest_mismatch");
    }
    if (standard.source_ref !== `standard:${standard.standard_id}:${standard.version}`) {
      fail("pack.standard_source_ref_mismatch");
    }
    const frontMatter = parseFrontMatter(standard.content);
    assertUnique(frontMatter.audiences, "pack.front_matter_audience_duplicate");
    assertUnique(frontMatter.rule_ids, "pack.front_matter_rule_duplicate");
    if (
      frontMatter.standard_id !== standard.standard_id ||
      frontMatter.version !== standard.version ||
      frontMatter.priority !== standard.priority ||
      !sameSet(frontMatter.audiences, standard.audiences) ||
      !sameSet(frontMatter.rule_ids, standard.rule_ids)
    ) {
      fail("pack.standard_front_matter_mismatch");
    }
  }

  const standardsById = new Map(
    pack.standards.map((standard) => [standard.standard_id, standard]),
  );
  const moduleIds = new Set(pack.modules.map((module) => module.module_id));
  for (const module of pack.modules) {
    assertUnique(module.standard_ids, "pack.module_standard_duplicate");
    assertUnique(module.tool_names, "pack.module_tool_duplicate");
    if (module.standard_ids.some((standardId) => !standardsById.has(standardId))) {
      fail("pack.module_standard_unknown");
    }
  }
  for (const resource of pack.resources) {
    assertUnique(resource.standard_ids, "pack.resource_standard_duplicate");
    if (resource.standard_ids.some((standardId) => !standardsById.has(standardId))) {
      fail("pack.resource_standard_unknown");
    }
  }
  if (pack.resources.length !== CANONICAL_AGENT_RESOURCES.length) {
    fail("pack.resource_set_invalid");
  }
  for (const canonical of CANONICAL_AGENT_RESOURCES) {
    const resource = pack.resources.find((candidate) => candidate.resource_id === canonical.resource_id);
    if (
      resource === undefined ||
      resource.uri !== canonical.uri ||
      !sameSequence(resource.standard_ids, canonical.standard_ids)
    ) {
      fail("pack.resource_mapping_invalid");
    }
  }
  for (const workstream of pack.workstreams.workstreams) {
    assertUnique(workstream.writable_paths, "pack.workstream_path_duplicate");
    for (const path of workstream.writable_paths) {
      assertSafeRelativeWorkstreamPath(path);
    }
  }

  for (const profile of pack.profiles) {
    assertUnique(profile.standard_ids, "pack.profile_standard_duplicate");
    assertUnique(profile.allowed_rule_ids, "pack.profile_rule_duplicate");
    assertUnique(profile.context_scopes, "pack.profile_scope_duplicate");
    assertUnique(profile.allowed_module_ids, "pack.profile_module_duplicate");
    const selectedStandards = profile.standard_ids.map((standardId) => {
      const standard = standardsById.get(standardId);
      if (standard === undefined) fail("pack.profile_standard_unknown");
      return standard;
    });
    if (selectedStandards.some((standard) => !standard.audiences.includes(profile.audience))) {
      fail("pack.profile_audience_mismatch");
    }
    const selectedRuleIds = [...new Set(
      selectedStandards.flatMap((standard) => standard.rule_ids),
    )];
    if (!sameSet(profile.allowed_rule_ids, selectedRuleIds)) {
      fail("pack.profile_rule_set_mismatch");
    }
    if (profile.allowed_module_ids.some((moduleId) => !moduleIds.has(moduleId))) {
      fail("pack.profile_module_unknown");
    }
  }

  const runtimeCaller = pack.profiles.find(
    (profile) => profile.profile_id === "runtime-caller",
  );
  if (
    runtimeCaller === undefined ||
    runtimeCaller.audience !== "caller" ||
    runtimeCaller.content_mode !== "summary" ||
    !sameSet(runtimeCaller.standard_ids, runtimeCallerEntitlements.standardIds) ||
    !sameSet(runtimeCaller.allowed_rule_ids, runtimeCallerEntitlements.ruleIds) ||
    !sameSet(runtimeCaller.context_scopes, runtimeCallerEntitlements.contextScopes) ||
    !sameSet(runtimeCaller.allowed_module_ids, runtimeCallerEntitlements.moduleIds)
  ) {
    fail("pack.runtime_caller_entitlement_mismatch");
  }
  const runtimeStandards = runtimeCaller.standard_ids.map(
    (standardId) => standardsById.get(standardId),
  );
  if (
    runtimeCaller.allowed_rule_ids.some((ruleId) => ruleId.startsWith("CONTROL-")) ||
    runtimeStandards.some((standard) =>
      standard?.standard_id === "writable-module-control-plane-v1" ||
      standard?.rule_ids.some((ruleId) => ruleId.startsWith("CONTROL-")),
    )
  ) {
    fail("pack.runtime_caller_control_forbidden");
  }
  for (const moduleId of runtimeCallerModuleIds) {
    const module = pack.modules.find((candidate) => candidate.module_id === moduleId);
    const entitlement = runtimeCallerModuleEntitlements[moduleId];
    if (
      module === undefined ||
      module.risk_level !== entitlement.riskLevel ||
      !sameSet(module.standard_ids, entitlement.standardIds) ||
      !sameSet(module.tool_names, entitlement.toolNames)
    ) {
      fail("pack.runtime_caller_module_entitlement_mismatch");
    }
  }

  if (findAgentArtifactSafetyIssues(pack).length > 0) {
    fail("pack.safety_violation");
  }
}

export function validateAndFreezeAgentStandardPack(
  value: unknown,
): AgentStandardPack {
  assertPlainDataGraph(value);
  const parsed = agentStandardPackSchema.safeParse(value);
  if (!parsed.success) fail("pack.schema_invalid");
  const pack = parsed.data as AgentStandardPack;
  assertPlainDataGraph(pack);
  assertPackSemantics(pack);
  return deepFreeze(pack);
}
