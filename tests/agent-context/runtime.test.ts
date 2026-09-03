import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  readAgentStandardPack,
  readFixedAgentStandardPack,
  serializeAgentStandardPack,
} from "../../src/logistics_mcp/agent-context/pack";
import {
  AgentAccessRuntimeError,
  agentContextDataSchema,
  createAgentAccessRuntime,
  type AgentContextAuthorizationRequest,
} from "../../src/logistics_mcp/agent-context/runtime";
import type { AgentStandardPack } from "../../src/logistics_mcp/agent-context/types";
import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context";
import { getToolPolicy } from "../../src/logistics_mcp/platform/rbac";
import { CANONICAL_AGENT_RESOURCES } from "../../src/logistics_mcp/agent-context/resources";

const physicalTmpDir = realpathSync(tmpdir());

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function mutableClone<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function captureRuntimeError(run: () => unknown): AgentAccessRuntimeError {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AgentAccessRuntimeError);
    return error as AgentAccessRuntimeError;
  }
  throw new Error("Expected AgentAccessRuntimeError.");
}

function executionContext(
  role: "sales" | "customs_reviewer" | "operator",
): ExecutionContext {
  return parseExecutionContext({
    tenant_id: "tenant_runtime_test",
    actor_id: `${role}_actor`,
    actor_role: role,
    roles: [role],
    scopes: ["system:agent_context"],
    client_id: "agent-context-test",
    session_id: `session_${role}`,
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
}

describe("Agent access runtime", () => {
  it("returns a schema-valid read-only context and fixed resource projections", () => {
    const runtime = createAgentAccessRuntime({ pack: readFixedAgentStandardPack() });
    const context = executionContext("sales");
    const outcome = runtime.getContext(
      { profile_id: "runtime-caller", module_id: "cargo" },
      context,
    );

    expect(runtime.available).toBe(true);
    expect(outcome.status).toBe("success");
    expect(() => agentContextDataSchema.parse(outcome.data)).not.toThrow();
    const catalog = JSON.parse(runtime.readResource("logistics://modules/catalog", context).text) as {
      readonly modules: readonly { readonly module_id: string; readonly risk_level: string }[];
    };
    expect(catalog.modules.map((module) => module.module_id).sort()).toEqual([
      "agent-access",
      "cargo",
      "container",
    ]);
    expect(catalog.modules.every((module) => module.risk_level === "T0")).toBe(true);
    expect(runtime.readResource("logistics://modules/catalog", context).text).not.toContain("freightcom-ltl");
    expect(runtime.readResource("logistics://agent/profiles", context).text).toContain("runtime-caller");
  });

  it("projects a validated catalog generation identity without changing the fixed module list", () => {
    const catalogIdentity = {
      schema_version: "2026-09-02.v1" as const,
      profile: "t0-v1" as const,
      catalog_generation: `catalog_${"a".repeat(64)}` as const,
      catalog_digest: `sha256:${"a".repeat(64)}` as const,
    };
    const runtime = createAgentAccessRuntime({
      pack: readFixedAgentStandardPack(),
      catalogIdentity,
    });
    const catalog = JSON.parse(runtime.readResource(
      "logistics://modules/catalog",
      executionContext("sales"),
    ).text) as Record<string, unknown>;

    expect(catalog).toMatchObject(catalogIdentity);
    expect((catalog.modules as readonly unknown[])).toHaveLength(3);
    expect(() => createAgentAccessRuntime({
      pack: readFixedAgentStandardPack(),
      catalogIdentity: {
        ...catalogIdentity,
        catalog_digest: "sha256:invalid",
      },
    })).toThrow(expect.objectContaining({ code: "catalog_identity_invalid" }));
    expect(() => createAgentAccessRuntime({
      pack: readFixedAgentStandardPack(),
      catalogIdentity: {
        ...catalogIdentity,
        unreviewed: true,
      },
    } as never)).toThrow(expect.objectContaining({ code: "catalog_identity_invalid" }));
  });

  it("projects only the reviewed read-preview caller catalog when explicitly selected", () => {
    const runtime = createAgentAccessRuntime({
      pack: readFixedAgentStandardPack(),
      runtimeProfileId: "read-preview-caller",
      catalogIdentity: {
        schema_version: "2026-09-02.v1",
        profile: "read-preview-staging",
        catalog_generation: `catalog_${"b".repeat(64)}`,
        catalog_digest: `sha256:${"b".repeat(64)}`,
      },
    });
    const context = executionContext("sales");
    const catalog = JSON.parse(runtime.readResource(
      "logistics://modules/catalog",
      context,
    ).text) as { readonly modules: readonly { readonly module_id: string }[] };
    expect(catalog.modules.map(({ module_id }) => module_id).sort()).toEqual([
      "agent-access",
      "canada-final-mile-quote",
      "cargo",
      "container",
      "freightcom-ltl",
      "riskcustoms-ca",
    ]);
    expect(runtime.getContext(
      { profile_id: "read-preview-caller", module_id: "riskcustoms-ca" },
      context,
    ).status).toBe("success");
    expect(runtime.getContext(
      { profile_id: "runtime-caller" },
      context,
    ).status).toBe("blocked");
  });

  it("publishes only the sanitized runtime-caller profile metadata", () => {
    const pack = readFixedAgentStandardPack();
    const runtime = createAgentAccessRuntime({ pack });
    const profileCatalog = runtime.readResource(
      "logistics://agent/profiles",
      executionContext("sales"),
    ).text;

    expect(profileCatalog).toContain('"profile_id": "runtime-caller"');
    expect(profileCatalog).not.toContain('"profile_id": "platform-developer"');
    for (const privateControlMarker of [
      "CONTROL-",
      "writable-module-control-plane-v1",
      "readback-attempt-finalization-v1",
      "admin-control",
      "platform:admin",
      "/admin/api/",
    ]) {
      expect(profileCatalog).not.toContain(privateControlMarker);
    }

    const outcome = runtime.getContext(
      { profile_id: "runtime-caller", module_id: "cargo" },
      executionContext("sales"),
    );
    expect(outcome.status).toBe("success");
    const context = agentContextDataSchema.parse(outcome.data);
    const controlStandards = context.standards.filter(
      (standard) => standard.standard_id === "writable-module-control-plane-v1",
    );
    const controlRules = context.rules.filter((rule) => rule.rule_id.startsWith("CONTROL-"));

    expect(controlStandards).toEqual([]);
    expect(controlRules).toEqual([]);
    expect(JSON.stringify(context)).not.toContain("platform:admin");
    expect(JSON.stringify(context)).not.toContain("/admin/api/");
    expect(getToolPolicy("system.agent_context.get")).toMatchObject({
      permission: "system:agent_context",
      kind: "read",
    });
  });

  it("does not treat unknown profiles or a missing pack as success", () => {
    const runtime = createAgentAccessRuntime({ pack: readFixedAgentStandardPack() });
    const unknownProfile = "unknown-profile-sensitive-value";
    const unknownOutcome = runtime.getContext(
      { profile_id: unknownProfile },
      executionContext("sales"),
    );
    expect(unknownOutcome.status).toBe("blocked");
    expect(JSON.stringify(unknownOutcome)).not.toContain(unknownProfile);

    const unknownUri = "logistics://sensitive/unknown-resource-value";
    const resourceError = captureRuntimeError(() =>
      runtime.readResource(unknownUri, executionContext("sales")),
    );
    expect(resourceError.message).not.toContain(unknownUri);

    const missing = createAgentAccessRuntime({ pack: null });
    expect(missing.available).toBe(false);
    expect(
      missing.getContext({ profile_id: "runtime-caller" }, executionContext("sales")).status,
    ).toBe("unavailable");
    expect(
      missing.readResource("logistics://agent/bootstrap", executionContext("sales")).text,
    ).toContain("unavailable");
    const unavailableResourceError = captureRuntimeError(() =>
      missing.readResource(unknownUri, executionContext("sales")),
    );
    expect(unavailableResourceError.message).not.toContain(unknownUri);
  });

  it("rejects cloned, proxied and forged direct pack injection", () => {
    const trusted = readFixedAgentStandardPack();
    const clone = structuredClone(trusted);
    const proxy = new Proxy(trusted, {});
    const broadened = mutableClone<AgentStandardPack>(trusted);
    const runtimeCaller = broadened.profiles.find(
      (profile) => profile.profile_id === "runtime-caller",
    );
    const controlStandard = broadened.standards.find(
      (standard) => standard.standard_id === "writable-module-control-plane-v1",
    );
    if (runtimeCaller === undefined || controlStandard === undefined) {
      throw new Error("Expected runtime-caller and control standard fixtures.");
    }
    runtimeCaller.standard_ids.push(controlStandard.standard_id);
    runtimeCaller.allowed_rule_ids.push(...controlStandard.rule_ids);

    expect(() => createAgentAccessRuntime({ pack: clone })).toThrow(
      AgentAccessRuntimeError,
    );
    expect(() => createAgentAccessRuntime({ pack: proxy })).toThrow(
      AgentAccessRuntimeError,
    );
    expect(() => createAgentAccessRuntime({ pack: broadened })).toThrow(
      AgentAccessRuntimeError,
    );
  });

  it("keeps its trusted pack in a private slot and revalidates it on every use", () => {
    const runtime = createAgentAccessRuntime({ pack: readFixedAgentStandardPack() });
    const context = executionContext("sales");

    expect(Object.hasOwn(runtime, "pack")).toBe(false);
    expect(Reflect.set(runtime as object, "pack", { profiles: [] })).toBe(true);
    expect(runtime.getContext({ profile_id: "runtime-caller", module_id: "cargo" }, context).status)
      .toBe("success");
    expect(runtime.readResource("logistics://modules/catalog", context).text).toContain("cargo");
  });

  it("does not accept public arbitrary reads or the legacy packPath as runtime trust", () => {
    const trusted = readFixedAgentStandardPack();
    const outputDir = mkdtempSync(resolve(physicalTmpDir, "agent-runtime-pack-source-"));
    const regularPath = resolve(outputDir, "agent-standard-pack.json");
    const symlinkPath = resolve(outputDir, "agent-standard-pack-link.json");
    try {
      writeFileSync(regularPath, serializeAgentStandardPack(trusted), "utf8");
      const arbitraryRead = readAgentStandardPack(regularPath);
      expect(() => createAgentAccessRuntime({ pack: arbitraryRead })).toThrow(
        AgentAccessRuntimeError,
      );

      symlinkSync(regularPath, symlinkPath);
      const legacyFactory = createAgentAccessRuntime as unknown as (
        options: { readonly packPath: string },
      ) => ReturnType<typeof createAgentAccessRuntime>;
      const error = captureRuntimeError(() => legacyFactory({ packPath: symlinkPath }));
      expect(error.message).not.toContain(symlinkPath);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe request and context graphs before schema access with a fixed notice", () => {
    const runtime = createAgentAccessRuntime({ pack: readFixedAgentStandardPack() });
    const context = executionContext("sales");
    let trapTriggered = false;
    const proxiedInput = new Proxy(
      { profile_id: "runtime-caller" },
      {
        get() {
          trapTriggered = true;
          throw new Error("input getter must not run");
        },
        ownKeys() {
          trapTriggered = true;
          throw new Error("input ownKeys trap must not run");
        },
      },
    );
    const accessorInput: Record<string, unknown> = {};
    Object.defineProperty(accessorInput, "profile_id", {
      configurable: true,
      get() {
        trapTriggered = true;
        throw new Error("input accessor must not run");
      },
    });
    const customPrototypeInput = Object.create({ profile_id: "runtime-caller" }) as Record<string, unknown>;
    const cyclicInput: Record<string, unknown> = { profile_id: "runtime-caller" };
    cyclicInput.self = cyclicInput;

    for (const input of [proxiedInput, accessorInput, customPrototypeInput, cyclicInput]) {
      expect(runtime.getContext(input, context)).toMatchObject({
        status: "blocked",
        data: null,
        blockers: [{
          code: "agent_context.input_invalid",
          message: "The Agent context request is invalid.",
        }],
      });
    }

    const proxiedContext = new Proxy(context, {
      get() {
        trapTriggered = true;
        throw new Error("context getter must not run");
      },
      ownKeys() {
        trapTriggered = true;
        throw new Error("context ownKeys trap must not run");
      },
    });
    expect(runtime.getContext({ profile_id: "runtime-caller" }, proxiedContext)).toMatchObject({
      status: "blocked",
      data: null,
      blockers: [{
        code: "agent_context.input_invalid",
        message: "The Agent context request is invalid.",
      }],
    });
    expect(trapTriggered).toBe(false);
  });

  it("rejects a shape-correct execution context without parser provenance", () => {
    const runtime = createAgentAccessRuntime({ pack: readFixedAgentStandardPack() });
    const parsedContext = executionContext("sales");
    const forgedContext = structuredClone(parsedContext);

    expect(runtime.getContext(
      { profile_id: "runtime-caller", module_id: "cargo" },
      forgedContext,
    )).toMatchObject({
      status: "blocked",
      data: null,
      blockers: [{
        code: "agent_context.input_invalid",
        message: "The Agent context request is invalid.",
      }],
    });

    const error = captureRuntimeError(() =>
      runtime.readResource("logistics://modules/catalog", forgedContext),
    );
    expect(error.code).toBe("resource_input_invalid");
  });

  it("requires the current execution context for request-scoped resource authorization", () => {
    const authorizationRequests: AgentContextAuthorizationRequest[] = [];
    const runtime = createAgentAccessRuntime({
      authorizeProfile: (request) => {
        authorizationRequests.push(request);
        return request.context.role === "customs_reviewer";
      },
    });
    const readResourceWithoutContext = runtime.readResource.bind(runtime) as (
      uri: string,
    ) => unknown;

    const missingContextError = captureRuntimeError(() =>
      readResourceWithoutContext("logistics://modules/catalog"),
    );
    expect(missingContextError.code).toBe("resource_context_required");
    expect(authorizationRequests).toEqual([]);

    const reviewer = executionContext("customs_reviewer");
    expect(runtime.readResource("logistics://modules/catalog", reviewer).text).toContain("cargo");
    expect(authorizationRequests).toHaveLength(1);
    expect(authorizationRequests[0]).toMatchObject({
      context: reviewer,
      profileId: "runtime-caller",
      moduleId: null,
    });
  });

  it("authorizes each fixed resource with its own stable context scope and rejects scope denials", () => {
    expect(CANONICAL_AGENT_RESOURCES.map((resource) => ({
      resource_id: resource.resource_id,
      context_scope: resource.context_scope,
    }))).toEqual([
      { resource_id: "agent.bootstrap", context_scope: "bootstrap" },
      { resource_id: "standards.index", context_scope: "standards" },
      { resource_id: "contracts.envelope.current", context_scope: "standards" },
      { resource_id: "modules.catalog", context_scope: "module_catalog" },
      { resource_id: "agent.profiles", context_scope: "release" },
    ]);
    const authorizationRequests: Array<{
      readonly resourceId?: string;
      readonly resourceUri?: string;
      readonly contextScope?: string;
    }> = [];
    const context = executionContext("sales");
    const runtime = createAgentAccessRuntime({
      authorizeProfile: (request) => {
        authorizationRequests.push(request);
        return request.contextScope !== "module_catalog";
      },
    });

    for (const resource of CANONICAL_AGENT_RESOURCES) {
      if (resource.context_scope === "module_catalog") {
        const error = captureRuntimeError(() => runtime.readResource(resource.uri, context));
        expect(error.code).toBe("resource_not_authorized");
      } else {
        expect(runtime.readResource(resource.uri, context).uri).toBe(resource.uri);
      }
    }

    expect(authorizationRequests.map((request) => ({
      resourceId: request.resourceId,
      resourceUri: request.resourceUri,
      contextScope: request.contextScope,
    }))).toEqual(CANONICAL_AGENT_RESOURCES.map((resource) => ({
      resourceId: resource.resource_id,
      resourceUri: resource.uri,
      contextScope: resource.context_scope,
    })));
  });

  it("fails closed when a resource request omits or spoofs its execution context", () => {
    const runtime = createAgentAccessRuntime();
    const readResourceWithoutContext = runtime.readResource.bind(runtime) as (
      uri: string,
    ) => unknown;
    const missingContextError = captureRuntimeError(() =>
      readResourceWithoutContext("logistics://modules/catalog"),
    );
    expect(missingContextError.code).toBe("resource_context_required");

    let trapTriggered = false;
    const context = new Proxy(executionContext("sales"), {
      get() {
        trapTriggered = true;
        throw new Error("resource context getter must not run");
      },
      ownKeys() {
        trapTriggered = true;
        throw new Error("resource context reflection must not run");
      },
    });
    const proxiedContextError = captureRuntimeError(() =>
      runtime.readResource("logistics://modules/catalog", context),
    );
    expect(proxiedContextError.code).toBe("resource_input_invalid");
    expect(trapTriggered).toBe(false);
  });

  it("binds profile selection to the current server context and removes static authorization state", () => {
    const pack = readFixedAgentStandardPack();
    const authorizationRequests: AgentContextAuthorizationRequest[] = [];
    const runtime = createAgentAccessRuntime({
      pack,
      authorizeProfile: (request) => {
        authorizationRequests.push(request);
        if (request.profileId === "module-reviewer") {
          return request.context.role === "customs_reviewer";
        }
        if (request.profileId === "release-operator") {
          return request.context.role === "operator";
        }
        return request.profileId === "runtime-caller" && request.context.role === "sales";
      },
    });
    const sales = executionContext("sales");
    const reviewer = executionContext("customs_reviewer");
    const operator = executionContext("operator");

    const blockedReviewer = runtime.getContext({ profile_id: "module-reviewer" }, sales);
    expect(blockedReviewer).toMatchObject({
      status: "blocked",
      data: null,
      blockers: [{
        code: "agent_context.profile_not_authorized",
        message: "The requested Agent profile is not authorized for this caller.",
      }],
    });
    expect(JSON.stringify(blockedReviewer)).not.toContain("CONTROL-");

    expect(runtime.getContext({ profile_id: "module-reviewer" }, reviewer).status).toBe("success");
    expect(runtime.getContext({ profile_id: "module-reviewer" }, sales)).toMatchObject({
      status: "blocked",
      data: null,
    });
    expect(runtime.getContext({ profile_id: "release-operator" }, operator).status).toBe("success");
    expect(runtime.getContext({ profile_id: "release-operator" }, reviewer)).toMatchObject({
      status: "blocked",
      data: null,
    });

    const inputAuthorization = runtime.getContext({
      profile_id: "module-reviewer",
      authorization: { audience: "reviewer", caller: "module-reviewer" },
    }, reviewer);
    expect(inputAuthorization).toMatchObject({
      status: "needs_input",
      data: null,
    });
    expect(JSON.stringify(inputAuthorization)).not.toContain("CONTROL-");
    expect(authorizationRequests.every((request) => request.context === sales || request.context === reviewer || request.context === operator)).toBe(true);
    expect(authorizationRequests.some((request) => request.profileId === "module-reviewer" && request.moduleId === null && request.context === reviewer)).toBe(true);
    expect(authorizationRequests.some((request) => request.profileId === "release-operator" && request.moduleId === null && request.context === operator)).toBe(true);

    const defaultRuntime = createAgentAccessRuntime({ pack });
    expect(defaultRuntime.getContext({ profile_id: "runtime-caller" }, sales).status).toBe("success");
    expect(defaultRuntime.getContext({ profile_id: "module-reviewer" }, reviewer)).toMatchObject({
      status: "blocked",
      data: null,
    });

    const legacyStaticAuthorization = createAgentAccessRuntime as unknown as (options: {
      readonly pack: AgentStandardPack;
      readonly authorization: { readonly audience: "reviewer"; readonly caller: "module-reviewer" };
    }) => ReturnType<typeof createAgentAccessRuntime>;
    expect(() => legacyStaticAuthorization({
      pack,
      authorization: { audience: "reviewer", caller: "module-reviewer" },
    })).toThrow(AgentAccessRuntimeError);
  });
});
