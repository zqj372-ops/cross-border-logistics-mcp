import { z } from "zod";
import { isProxy } from "node:util/types";

import {
  envelopeSchema,
  type Notice,
} from "../platform/envelope";
import type { ModuleToolContract, ModuleToolOutcome } from "../module-runtime";
import {
  AgentContextResolutionError,
  resolveAgentContextFromPack,
} from "./resolver";
import {
  isRuntimeTrustedAgentStandardPack,
  readFixedAgentStandardPack,
} from "./pack";
import { CANONICAL_AGENT_RESOURCES, canonicalAgentResource } from "./resources";
import {
  assertSafeAgentDataGraph,
} from "./safety";
import {
  isTrustedExecutionContext,
  type ExecutionContext,
} from "../platform/context";
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
  getContext(input: unknown, context: ExecutionContext): ModuleToolOutcome;
  readResource(uri: string, context: ExecutionContext): AgentResourceContent;
}

export interface AgentContextAuthorizationRequest {
  readonly context: ExecutionContext;
  readonly profileId: string;
  readonly moduleId: string | null;
}

export type AgentContextAuthorizationCallback = (
  request: AgentContextAuthorizationRequest,
) => boolean;

function unavailableNotice(code: string, message: string): Notice {
  return { code, message, severity: "error", field: null };
}

const INPUT_INVALID_NOTICE = unavailableNotice(
  "agent_context.input_invalid",
  "The Agent context request is invalid.",
);
const UNSAFE_INPUT_NOTICE = unavailableNotice(
  "agent_context.input_invalid",
  "The Agent context request is invalid.",
);
const PROFILE_NOT_AUTHORIZED_NOTICE = unavailableNotice(
  "agent_context.profile_not_authorized",
  "The requested Agent profile is not authorized for this caller.",
);
const RESOLUTION_FAILED_NOTICE = unavailableNotice(
  "agent_context.resolution_failed",
  "The requested Agent context could not be resolved.",
);
const RULE_CONFLICT_NOTICE = unavailableNotice(
  "agent_context.rule_conflict",
  "The requested Agent context contains conflicting standards.",
);

const RUNTIME_PROFILE_ID = "runtime-caller";

function isSafeServerExecutionContext(value: unknown): value is ExecutionContext {
  try {
    assertSafeAgentDataGraph(value);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.tenantId === "string" &&
    typeof candidate.actorId === "string" &&
    typeof candidate.role === "string" &&
    Array.isArray(candidate.roles) &&
    candidate.roles.every((role) => typeof role === "string") &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.every((scope) => typeof scope === "string") &&
    typeof candidate.clientId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.expiresAt === "number" &&
    isTrustedExecutionContext(value)
  );
}

class DefaultAgentAccessRuntime implements AgentAccessRuntime {
  readonly #pack: AgentStandardPack | null;
  private readonly unavailableReason: string;
  private readonly authorizationCallback: AgentContextAuthorizationCallback | null;

  constructor(
    pack: AgentStandardPack | null,
    unavailableReason = "",
    authorizationCallback: AgentContextAuthorizationCallback | null = null,
  ) {
    this.#pack = pack;
    this.unavailableReason = unavailableReason;
    this.authorizationCallback = authorizationCallback;
  }

  get available(): boolean {
    return this.#pack !== null && isRuntimeTrustedAgentStandardPack(this.#pack);
  }

  private runtimePack(): AgentStandardPack | null {
    if (this.#pack !== null && !isRuntimeTrustedAgentStandardPack(this.#pack)) {
      throw new AgentAccessRuntimeError(
        "pack_untrusted",
        "The Agent runtime pack is not trusted.",
      );
    }
    return this.#pack;
  }

  private isProfileAuthorized(
    pack: AgentStandardPack,
    profileId: string,
    moduleId: string | undefined,
    context: ExecutionContext,
  ): boolean {
    const profile = pack.profiles.find((candidate) => candidate.profile_id === profileId);
    if (profile === undefined) return false;
    if (this.authorizationCallback === null) {
      return profile.profile_id === RUNTIME_PROFILE_ID && profile.audience === "caller";
    }
    const request: AgentContextAuthorizationRequest = {
      context,
      profileId,
      moduleId: moduleId ?? null,
    };
    try {
      return this.authorizationCallback(request) === true;
    } catch {
      return false;
    }
  }

  getContext(input: unknown, context: ExecutionContext): ModuleToolOutcome {
    try {
      assertSafeAgentDataGraph(input);
      assertSafeAgentDataGraph(context);
    } catch {
      return {
        status: "blocked",
        data: null,
        blockers: [UNSAFE_INPUT_NOTICE],
        reviewStatus: "not_required",
      };
    }
    if (!isSafeServerExecutionContext(context)) {
      return {
        status: "blocked",
        data: null,
        blockers: [UNSAFE_INPUT_NOTICE],
        reviewStatus: "not_required",
      };
    }
    const pack = this.runtimePack();
    if (pack === null) {
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
        blockers: [INPUT_INVALID_NOTICE],
        reviewStatus: "not_required",
      };
    }
    if (!this.isProfileAuthorized(
      pack,
      parsed.data.profile_id,
      parsed.data.module_id,
      context,
    )) {
      return {
        status: "blocked",
        data: null,
        blockers: [PROFILE_NOT_AUTHORIZED_NOTICE],
        reviewStatus: "not_required",
      };
    }
    try {
      return {
        status: "success",
        data: resolveAgentContextFromPack(pack, {
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
        blockers: [code === "rule_conflict" ? RULE_CONFLICT_NOTICE : RESOLUTION_FAILED_NOTICE],
        reviewStatus: status === "manual_review" ? "manual_review" : "not_required",
      };
    }
  }

  readResource(uri: string, context: ExecutionContext): AgentResourceContent {
    if (typeof uri !== "string") {
      throw new AgentAccessRuntimeError(
        "resource_invalid",
        "The requested Agent resource is invalid.",
      );
    }
    if (context === undefined) {
      throw new AgentAccessRuntimeError(
        "resource_context_required",
        "The current server execution context is required for Agent resource access.",
      );
    }
    if (!isSafeServerExecutionContext(context)) {
      throw new AgentAccessRuntimeError(
        "resource_input_invalid",
        "The requested Agent resource request is invalid.",
      );
    }
    const knownUnavailableResources = new Map(
      CANONICAL_AGENT_RESOURCES.map((resource) => [resource.uri, resource]),
    );
    const pack = this.runtimePack();
    if (pack === null) {
      const unavailableResource = knownUnavailableResources.get(uri);
      if (unavailableResource === undefined) {
        throw new AgentAccessRuntimeError(
          "resource_unknown",
          "The requested Agent resource is not registered.",
        );
      }
      return {
        uri,
        mimeType: unavailableResource.mimeType,
        text: JSON.stringify({ status: "unavailable", code: "agent_pack.unavailable" }),
      };
    }
    if (!this.isProfileAuthorized(pack, RUNTIME_PROFILE_ID, undefined, context)) {
      throw new AgentAccessRuntimeError(
        "resource_not_authorized",
        "The requested Agent resource is not authorized for this caller.",
      );
    }
    const resource = pack.resources.find((candidate) => candidate.uri === uri);
    if (resource === undefined) {
      throw new AgentAccessRuntimeError(
        "resource_unknown",
        "The requested Agent resource is not registered.",
      );
    }
    const canonical = canonicalAgentResource(resource.resource_id);
    if (canonical === undefined) {
      throw new AgentAccessRuntimeError(
        "resource_invalid",
        "The requested Agent resource is not registered.",
      );
    }
    const standards = pack.standards.filter((standard) =>
      resource.standard_ids.includes(standard.standard_id)
    );
    if (resource.resource_id === "contracts.envelope.current") {
      return { uri, mimeType: canonical.mimeType, text: standards.map((standard) => standard.content).join("\n\n") };
    }
    if (resource.resource_id === "modules.catalog") {
      return {
        uri,
        mimeType: canonical.mimeType,
        text: JSON.stringify({ modules: pack.modules }, null, 2),
      };
    }
    if (resource.resource_id === "agent.profiles") {
      const runtimeCaller = pack.profiles.find(
        (profile) => profile.profile_id === RUNTIME_PROFILE_ID,
      );
      if (runtimeCaller === undefined || runtimeCaller.audience !== "caller") {
        throw new AgentAccessRuntimeError(
          "resource_invalid",
          "The requested Agent resource is not registered.",
        );
      }
      return {
        uri,
        mimeType: canonical.mimeType,
        text: JSON.stringify({ profiles: [withoutSchema(runtimeCaller)] }, null, 2),
      };
    }
    if (resource.resource_id === "standards.index") {
      const index = standards.map(withoutContent);
      return { uri, mimeType: canonical.mimeType, text: JSON.stringify({ standards: index }, null, 2) };
    }
    return {
      uri,
      mimeType: canonical.mimeType,
      text: JSON.stringify({
        pack_schema_version: pack.pack_schema_version,
        registry_id: pack.registry_id,
        standards: standards.map(withoutContent),
      }, null, 2),
    };
  }
}

export interface AgentAccessRuntimeOptions {
  readonly pack?: AgentStandardPack | null;
  readonly authorizeProfile?: AgentContextAuthorizationCallback;
}

function validateRuntimeOptions(value: unknown): AgentAccessRuntimeOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value)
  ) {
    throw new AgentAccessRuntimeError(
      "pack_option_invalid",
      "Agent runtime pack options are invalid.",
    );
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new AgentAccessRuntimeError(
        "pack_option_invalid",
        "Agent runtime pack options are invalid.",
      );
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new AgentAccessRuntimeError(
          "pack_option_invalid",
          "Agent runtime pack options are invalid.",
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new AgentAccessRuntimeError(
          "pack_option_invalid",
          "Agent runtime pack options are invalid.",
        );
      }
      if (!["pack", "authorizeProfile"].includes(key)) {
        throw new AgentAccessRuntimeError(
          "pack_option_invalid",
          "Agent runtime pack options are invalid.",
        );
      }
    }
  } catch (error: unknown) {
    if (error instanceof AgentAccessRuntimeError) throw error;
    throw new AgentAccessRuntimeError(
      "pack_option_invalid",
      "Agent runtime pack options are invalid.",
    );
  }
  return value;
}

export function createAgentAccessRuntime(options: AgentAccessRuntimeOptions = {}): AgentAccessRuntime {
  const safeOptions = validateRuntimeOptions(options);
  const authorizationCallback = safeOptions.authorizeProfile ?? null;
  if (authorizationCallback !== null && typeof authorizationCallback !== "function") {
    throw new AgentAccessRuntimeError(
      "authorization_invalid",
      "Agent runtime authorization is invalid.",
    );
  }
  if (authorizationCallback !== null && isProxy(authorizationCallback)) {
    throw new AgentAccessRuntimeError(
      "authorization_invalid",
      "Agent runtime authorization is invalid.",
    );
  }
  if (Object.hasOwn(safeOptions, "pack")) {
    if (safeOptions.pack === null) {
      return new DefaultAgentAccessRuntime(
        null,
        "The immutable Standard Pack is intentionally unavailable.",
        authorizationCallback,
      );
    }
    if (!isRuntimeTrustedAgentStandardPack(safeOptions.pack)) {
      throw new AgentAccessRuntimeError(
        "pack_untrusted",
        "Agent runtime pack injection is not trusted.",
      );
    }
    return new DefaultAgentAccessRuntime(safeOptions.pack, "", authorizationCallback);
  }
  try {
    return new DefaultAgentAccessRuntime(readFixedAgentStandardPack(), "", authorizationCallback);
  } catch {
    return new DefaultAgentAccessRuntime(null, "The immutable Standard Pack is invalid.", authorizationCallback);
  }
}
