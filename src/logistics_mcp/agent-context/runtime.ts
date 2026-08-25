import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { z } from "zod";

import {
  envelopeSchema,
  type Notice,
} from "../platform/envelope";
import type { ModuleToolContract, ModuleToolOutcome } from "../module-runtime";
import {
  AgentContextResolutionError,
  resolveAgentContextFromPack,
} from "./resolver";
import { readAgentStandardPack } from "./pack";
import type { AgentStandardPack } from "./types";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

function withoutKey(value: object, keyToRemove: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== keyToRemove));
}

function withoutSchema(value: object): Record<string, unknown> {
  return withoutKey(value, "$schema");
}

function withoutContent(value: object): Record<string, unknown> {
  return withoutKey(value, "content");
}

export const agentContextInputSchema = z
  .object({
    profile_id: identifierSchema,
    module_id: identifierSchema.optional(),
  })
  .strict();

const sourceRefSchema = z
  .object({
    source_id: identifierSchema,
    version: z.string().min(1),
    content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    locator: identifierSchema,
  })
  .strict();
const standardProjectionSchema = z
  .object({
    standard_id: identifierSchema,
    version: z.string().min(1),
    priority: z.number().int().min(0).max(100),
    rule_ids: z.array(z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/)),
    summary: z.string().min(1),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    content: z.string().optional(),
  })
  .strict();
const ruleProjectionSchema = z
  .object({
    rule_id: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/),
    standard_id: identifierSchema,
    priority: z.number().int().min(0).max(100),
    source_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const moduleProjectionSchema = z
  .object({
    module_id: identifierSchema,
    version: z.string().min(1),
    risk_level: z.enum(["T0", "T1", "T2", "T3"]),
    standard_ids: z.array(identifierSchema),
    tool_names: z.array(identifierSchema),
  })
  .strict();
const workstreamProjectionSchema = z
  .object({
    workstream_id: z.string().min(1),
    owner: z.string().min(1),
    writable_paths: z.array(z.string().min(1)),
    primary_delivery: z.string().min(1),
  })
  .strict();

export const agentContextDataSchema = z
  .object({
    status: z.literal("success"),
    schema_version: z.literal("2026-08-21.v1"),
    profile_id: identifierSchema,
    profile_version: z.string().min(1),
    scopes: z.array(z.string().min(1)),
    selected_module_id: identifierSchema.nullable(),
    standards: z.array(standardProjectionSchema),
    rules: z.array(ruleProjectionSchema),
    modules: z.array(moduleProjectionSchema),
    workstreams: z.array(workstreamProjectionSchema),
    source_refs: z.array(sourceRefSchema),
  })
  .strict();

export const agentContextEnvelopeSchema = envelopeSchema
  .extend({ data: agentContextDataSchema.nullable() })
  .meta({
    $schema: "https://json-schema.org/draft/2020-12/schema",
  });

export const agentContextToolContract: ModuleToolContract = {
  inputSchema: agentContextInputSchema,
  validateOutput: (data) => {
    if (data !== null) agentContextDataSchema.parse(data);
  },
  outputSchema: agentContextEnvelopeSchema,
};

export class AgentAccessRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentAccessRuntimeError";
    this.code = code;
  }
}

export interface AgentResourceContent {
  readonly uri: string;
  readonly mimeType: "application/json" | "text/markdown";
  readonly text: string;
}

export interface AgentAccessRuntime {
  readonly available: boolean;
  readonly pack: AgentStandardPack | null;
  getContext(input: unknown): ModuleToolOutcome;
  readResource(uri: string): AgentResourceContent;
}

function unavailableNotice(code: string, message: string): Notice {
  return { code, message, severity: "error", field: null };
}

class DefaultAgentAccessRuntime implements AgentAccessRuntime {
  readonly available: boolean;
  readonly pack: AgentStandardPack | null;
  private readonly unavailableReason: string;

  constructor(pack: AgentStandardPack | null, unavailableReason = "") {
    this.pack = pack;
    this.available = pack !== null;
    this.unavailableReason = unavailableReason;
  }

  getContext(input: unknown): ModuleToolOutcome {
    if (this.pack === null) {
      return {
        status: "unavailable",
        data: null,
        blockers: [unavailableNotice("agent_pack.unavailable", this.unavailableReason || "The Agent Standard Pack is not available.")],
        reviewStatus: "manual_review",
      };
    }
    const parsed = agentContextInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: "needs_input",
        data: null,
        blockers: [unavailableNotice("agent_context.input_invalid", "profile_id and module_id must use the registered identifier format.")],
        reviewStatus: "not_required",
      };
    }
    try {
      return {
        status: "success",
        data: resolveAgentContextFromPack(this.pack, {
          profileId: parsed.data.profile_id,
          ...(parsed.data.module_id === undefined ? {} : { moduleId: parsed.data.module_id }),
        }),
        reviewStatus: "not_required",
      };
    } catch (error: unknown) {
      const code = error instanceof AgentContextResolutionError ? error.code : "agent_context.failed";
      const status = code === "rule_conflict" ? "manual_review" : "blocked";
      return {
        status,
        data: null,
        blockers: [unavailableNotice(`agent_context.${code}`, error instanceof Error ? error.message : "Agent context could not be resolved.")],
        reviewStatus: status === "manual_review" ? "manual_review" : "not_required",
      };
    }
  }

  readResource(uri: string): AgentResourceContent {
    if (this.pack === null) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ status: "unavailable", code: "agent_pack.unavailable" }),
      };
    }
    const resource = this.pack.resources.find((candidate) => candidate.uri === uri);
    if (resource === undefined) {
      throw new AgentAccessRuntimeError("resource_unknown", `Unknown Agent resource: ${uri}`);
    }
    const standards = this.pack.standards.filter((standard) => resource.standard_ids.includes(standard.standard_id));
    if (resource.resource_id === "contracts.envelope.current") {
      return { uri, mimeType: "text/markdown", text: standards.map((standard) => standard.content).join("\n\n") };
    }
    if (resource.resource_id === "modules.catalog") {
      return { uri, mimeType: "application/json", text: JSON.stringify({ modules: this.pack.modules }, null, 2) };
    }
    if (resource.resource_id === "agent.profiles") {
      const profiles = this.pack.profiles.map(withoutSchema);
      return { uri, mimeType: "application/json", text: JSON.stringify({ profiles }, null, 2) };
    }
    if (resource.resource_id === "standards.index") {
      const index = standards.map(withoutContent);
      return { uri, mimeType: "application/json", text: JSON.stringify({ standards: index }, null, 2) };
    }
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({
        pack_schema_version: this.pack.pack_schema_version,
        registry_id: this.pack.registry_id,
        standards: standards.map(withoutContent),
      }, null, 2),
    };
  }
}

export function createAgentAccessRuntime(options: {
  readonly pack?: AgentStandardPack;
  readonly packPath?: string;
} = {}): AgentAccessRuntime {
  if (options.pack !== undefined) return new DefaultAgentAccessRuntime(options.pack);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const defaultPackPaths: readonly [string, string] = [
    resolve(root, "dist/standards/agent-standard-pack.json"),
    resolve(root, "standards/agent-standard-pack.json"),
  ];
  const packPath = options.packPath ?? defaultPackPaths.find((candidate) => existsSync(candidate)) ?? defaultPackPaths[0];
  if (!existsSync(packPath)) {
    return new DefaultAgentAccessRuntime(null, "The immutable Standard Pack has not been built.");
  }
  try {
    return new DefaultAgentAccessRuntime(readAgentStandardPack(packPath));
  } catch {
    return new DefaultAgentAccessRuntime(null, "The immutable Standard Pack is invalid.");
  }
}
