import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ENVELOPE_STATUSES } from "../../src/logistics_mcp/platform/envelope";
import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";
import type {
  ActiveModuleRef,
  ModuleActivationSnapshot,
} from "../../src/logistics_mcp/control-plane/types";
import type {
  ControlledDispatchFacade,
  ControlledDispatchRoute,
} from "../../src/logistics_mcp/control-plane/service";
import { ModuleControlServiceError } from "../../src/logistics_mcp/control-plane/errors";
import { createFixtureComposition } from "../../src/logistics_mcp/server/composition";
import {
  executeRegisteredToolWithResult,
  registerModuleToolDefinitions,
  wrapModuleToolDefinitions,
  type DomainToolOutcome,
  type ToolDefinition,
} from "../../src/logistics_mcp/server/tool-registry";

const executionContext: ExecutionContext = {
  tenantId: "tenant_fixture",
  actorId: "actor_fixture",
  role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate"],
  clientId: "client_fixture",
  sessionId: "session_fixture",
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};

function definition(
  handler: ToolDefinition["handler"],
  moduleFields:
    | { readonly moduleId: string; readonly moduleVersion: string }
    | null,
): ToolDefinition {
  return {
    name: moduleFields === null ? "system.get_data_status" : "cargo.calculate",
    title: "Test tool",
    description: "Test tool",
    inputSchemaId: "urn:test:input:v1",
    outputSchemaId: "urn:test:output:v1",
    permission: "test:read",
    kind: "read",
    statusMapping: ENVELOPE_STATUSES,
    inputSchema: z.object({}),
    validateOutput: () => undefined,
    outputSchema: z.object({}).strict(),
    riskLevel: "T0",
    standardRefs: ["module-runtime.v0"],
    ...(handler === undefined ? {} : { handler }),
    ...(moduleFields ?? {}),
  };
}

function unavailableOutcome(code: string): DomainToolOutcome {
  return {
    status: "unavailable",
    data: null,
    blockers: [
      {
        code,
        message: code,
        severity: "error",
        field: null,
      },
    ],
  };
}

function activeRef(digestLetter = "a"): ActiveModuleRef {
  return {
    moduleId: "cargo",
    version: "2026-08-21.v0",
    descriptorDigest: `sha256:${digestLetter.repeat(64)}`,
  };
}

function activeSnapshot(
  ref: ActiveModuleRef,
  releaseId = "release_001",
  revision = 1,
): ModuleActivationSnapshot {
  return { releaseId, revision, activeModules: [ref] };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}

type DispatchRunner = <T>(
  ref: ActiveModuleRef,
  handler: () => T | Promise<T>,
) => Promise<T>;

function dispatchForSnapshot(
  snapshot: () => ModuleActivationSnapshot,
  run: DispatchRunner = async (_ref, handler) => handler(),
): ControlledDispatchFacade["dispatch"] {
  return async <T>(
    route: ControlledDispatchRoute,
    handler: () => T | Promise<T>,
  ): Promise<T> => {
    const ref = typeof route === "function" ? route(snapshot()) : route;
    if (ref === null) throw new ModuleControlServiceError("module_not_active");
    return run(ref, handler);
  };
}

describe("runtime activation definition wrapper", () => {
  it("rejects an activation reader without the paired controlled dispatcher", () => {
    expect(() =>
      createFixtureComposition({
        dataMode: "fixtures",
        activation: {
          snapshot: () => ({
            releaseId: null,
            revision: 0,
            activeModules: [],
          }),
        },
      }),
    ).toThrow("Runtime activation requires both activation and dispatch facades.");
  });

  it("rejects a controlled dispatcher without the paired activation reader", () => {
    expect(() =>
      createFixtureComposition({
        dataMode: "fixtures",
        dispatch: {
          dispatch: async (_route, handler) => handler(),
        },
      }),
    ).toThrow("Runtime activation requires both activation and dispatch facades.");
  });

  it("returns module_policy_not_released before an active verified release exists", async () => {
    const originalHandler = vi.fn(() => unavailableOutcome("original_handler"));
    const snapshot = () => ({
      releaseId: null,
      revision: 0,
      activeModules: [],
    } as const);
    const dispatch = dispatchForSnapshot(snapshot);
    const wrapped = wrapModuleToolDefinitions(
      [
        definition(originalHandler, {
          moduleId: "cargo",
          moduleVersion: "2026-08-21.v0",
        }),
      ],
      {
        activation: { snapshot },
        dispatch: { dispatch },
      },
    );

    const result = await wrapped[0]!.handler!({}, {} as never);

    expect(result).toMatchObject({
      status: "unavailable",
      data: null,
      blockers: [{ code: "module_policy_not_released" }],
    });
    expect(originalHandler).not.toHaveBeenCalled();
  });

  it("leaves non-module definitions and their handlers unchanged", () => {
    const originalHandler = vi.fn<() => DomainToolOutcome>(() => ({
      status: "unavailable",
      data: null,
    }));
    const nonModule = definition(originalHandler, null);
    const dispatch = vi.fn();

    const wrapped = wrapModuleToolDefinitions([nonModule], {
      activation: {
        snapshot: () => ({
          releaseId: null,
          revision: 0,
          activeModules: [],
        }),
      },
      dispatch: { dispatch },
    });

    expect(wrapped[0]).toBe(nonModule);
    expect(wrapped[0]!.handler).toBe(originalHandler);
    expect(wrapped[0]!.handler!({}, {} as never)).toEqual({
      status: "unavailable",
      data: null,
    });
    expect(originalHandler).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("holds the dispatch reader until an async original handler settles", async () => {
    const ref = activeRef();
    const entered = deferred();
    const releaseHandler = deferred();
    let readerHeld = false;
    let readerReleased = false;
    const originalHandler = vi.fn(async () => {
      entered.resolve();
      await releaseHandler.promise;
      return unavailableOutcome("handler_settled");
    });
    const dispatch = dispatchForSnapshot(() => activeSnapshot(ref), async (
      _activeRef,
      handler,
    ) => {
      readerHeld = true;
      try {
        return await handler();
      } finally {
        readerHeld = false;
        readerReleased = true;
      }
    });
    const wrapped = wrapModuleToolDefinitions(
      [
        definition(originalHandler, {
          moduleId: ref.moduleId,
          moduleVersion: ref.version,
        }),
      ],
      {
        activation: { snapshot: () => activeSnapshot(ref) },
        dispatch: { dispatch },
      },
    );

    const pending = wrapped[0]!.handler!({}, {} as never);
    await entered.promise;

    expect(readerHeld).toBe(true);
    expect(readerReleased).toBe(false);
    releaseHandler.resolve();
    await expect(pending).resolves.toMatchObject({
      status: "unavailable",
      blockers: [{ code: "handler_settled" }],
    });
    expect(readerHeld).toBe(false);
    expect(readerReleased).toBe(true);
  });

  it("re-enables the same wrapped definition after a disable without rebuilding", async () => {
    const ref = activeRef();
    let currentSnapshot = activeSnapshot(ref);
    const snapshot = vi.fn(() => currentSnapshot);
    const originalHandler = vi.fn(() => unavailableOutcome("original_handler"));
    const dispatch = dispatchForSnapshot(snapshot);
    const wrapped = wrapModuleToolDefinitions(
      [
        definition(originalHandler, {
          moduleId: ref.moduleId,
          moduleVersion: ref.version,
        }),
      ],
      {
        activation: { snapshot },
        dispatch: { dispatch },
      },
    );

    await expect(wrapped[0]!.handler!({}, {} as never)).resolves.toMatchObject({
      blockers: [{ code: "original_handler" }],
    });
    currentSnapshot = {
      releaseId: "release_disabled",
      revision: 2,
      activeModules: [],
    };
    await expect(wrapped[0]!.handler!({}, {} as never)).resolves.toMatchObject({
      status: "unavailable",
      blockers: [{ code: "module_disabled_by_release" }],
    });
    expect(originalHandler).toHaveBeenCalledTimes(1);

    currentSnapshot = activeSnapshot(ref, "release_reenabled", 3);
    await expect(wrapped[0]!.handler!({}, {} as never)).resolves.toMatchObject({
      blockers: [{ code: "original_handler" }],
    });
    expect(originalHandler).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it("checks fatal inside the dispatch section and never calls the original handler", async () => {
    const ref = activeRef();
    const originalHandler = vi.fn(() => unavailableOutcome("handler_called"));
    const fatal = Object.assign(new Error("fatal"), { code: "fatal" });
    let inDispatchSection = false;
    let fatalCheckedInsideSection = false;
    const dispatch: ControlledDispatchFacade["dispatch"] = () => {
      inDispatchSection = true;
      fatalCheckedInsideSection = inDispatchSection;
      inDispatchSection = false;
      return Promise.reject(fatal);
    };
    const wrapped = wrapModuleToolDefinitions(
      [
        definition(originalHandler, {
          moduleId: ref.moduleId,
          moduleVersion: ref.version,
        }),
      ],
      {
        activation: { snapshot: () => activeSnapshot(ref) },
        dispatch: { dispatch },
      },
    );

    await expect(wrapped[0]!.handler!({}, {} as never)).rejects.toBe(fatal);
    expect(fatalCheckedInsideSection).toBe(true);
    expect(inDispatchSection).toBe(false);
    expect(originalHandler).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unreleased activation",
      { releaseId: null, revision: 0, activeModules: [] },
    ],
    [
      "release-disabled module",
      { releaseId: "release_disabled", revision: 2, activeModules: [] },
    ],
  ] as const)("lets the fatal dispatch fence dominate %s", async (_label, snapshot) => {
    const originalHandler = vi.fn(() => unavailableOutcome("handler_called"));
    const fatal = Object.assign(new Error("fatal"), { code: "fatal" });
    const dispatchCalls = vi.fn();
    const dispatch: ControlledDispatchFacade["dispatch"] = () => {
      dispatchCalls();
      return Promise.reject(fatal);
    };
    const wrapped = wrapModuleToolDefinitions(
      [
        definition(originalHandler, {
          moduleId: "cargo",
          moduleVersion: "2026-08-21.v0",
        }),
      ],
      {
        activation: { snapshot: () => snapshot },
        dispatch: { dispatch },
      },
    );

    await expect(wrapped[0]!.handler!({}, {} as never)).rejects.toBe(fatal);
    expect(dispatchCalls).toHaveBeenCalledTimes(1);
    expect(originalHandler).not.toHaveBeenCalled();
  });

  it("enters the fatal dispatch fence before registered-tool input validation", async () => {
    const ref = activeRef();
    const originalHandler = vi.fn(() => unavailableOutcome("handler_called"));
    const fatal = Object.assign(new Error("fatal"), { code: "fatal" });
    const dispatchCalls = vi.fn();
    const dispatch: ControlledDispatchFacade["dispatch"] = () => {
      dispatchCalls();
      return Promise.reject(fatal);
    };
    const baseDefinition = definition(originalHandler, {
      moduleId: ref.moduleId,
      moduleVersion: ref.version,
    });
    const wrapped = wrapModuleToolDefinitions(
      [{
        ...baseDefinition,
        inputSchema: z.object({ required: z.string() }).strict(),
      }],
      {
        activation: { snapshot: () => activeSnapshot(ref) },
        dispatch: { dispatch },
      },
    );

    await expect(executeRegisteredToolWithResult(
      wrapped[0]!,
      { unexpected: true },
      executionContext,
      { requestId: "req_fatal_preflight", auditId: "audit_fatal_preflight" },
    )).rejects.toBe(fatal);
    expect(dispatchCalls).toHaveBeenCalledTimes(1);
    expect(originalHandler).not.toHaveBeenCalled();
  });

  it("keeps registered-tool input validation inside one dispatch section", async () => {
    const ref = activeRef();
    const originalHandler = vi.fn(() => unavailableOutcome("handler_called"));
    const dispatchCalls = vi.fn();
    let inDispatchSection = false;
    let validationRanInsideDispatch = false;
    const dispatch: ControlledDispatchFacade["dispatch"] = async (
      route,
      operation,
    ) => {
      dispatchCalls();
      const activeModule = typeof route === "function"
        ? route(activeSnapshot(ref))
        : route;
      if (activeModule === null) {
        throw new ModuleControlServiceError("module_not_active");
      }
      inDispatchSection = true;
      try {
        return await operation();
      } finally {
        inDispatchSection = false;
      }
    };
    const baseDefinition = definition(originalHandler, {
      moduleId: ref.moduleId,
      moduleVersion: ref.version,
    });
    const wrapped = wrapModuleToolDefinitions(
      [{
        ...baseDefinition,
        inputSchema: z.unknown().refine(() => {
          validationRanInsideDispatch = inDispatchSection;
          return false;
        }),
      }],
      {
        activation: { snapshot: () => activeSnapshot(ref) },
        dispatch: { dispatch },
      },
    );

    await expect(executeRegisteredToolWithResult(
      wrapped[0]!,
      { unexpected: true },
      executionContext,
      { requestId: "req_guarded_validation", auditId: "audit_guarded_validation" },
    )).rejects.toMatchObject({ code: "tool_input.invalid" });
    expect(validationRanInsideDispatch).toBe(true);
    expect(dispatchCalls).toHaveBeenCalledTimes(1);
    expect(originalHandler).not.toHaveBeenCalled();
  });

  it("preserves every definition metadata field while keeping the module visible", () => {
    const original = definition(() => unavailableOutcome("original_handler"), {
      moduleId: "cargo",
      moduleVersion: "2026-08-21.v0",
    });
    const wrapped = wrapModuleToolDefinitions([original], {
      activation: {
        snapshot: () => ({
          releaseId: null,
          revision: 0,
          activeModules: [],
        }),
      },
      dispatch: {
        dispatch: async (_ref, handler) => handler(),
      },
    });
    const { handler: originalHandler, ...originalMetadata } = original;
    const { handler: wrappedHandler, ...wrappedMetadata } = wrapped[0]!;

    expect(wrappedMetadata).toEqual(originalMetadata);
    expect(wrappedHandler).not.toBe(originalHandler);
    expect(wrapped.map(({ name }) => name)).toContain("cargo.calculate");
  });

  it("keeps public composition, registry, definition, and diagnostics surfaces free of private capabilities", async () => {
    const composition = createFixtureComposition({
      dataMode: "fixtures",
      activation: {
        snapshot: () => ({
          releaseId: null,
          revision: 0,
          activeModules: [],
        }),
      },
      dispatch: {
        dispatch: async (_ref, handler) => handler(),
      },
    });
    try {
      const registryDefinitions = registerModuleToolDefinitions(
        composition.moduleHost.catalog.list(),
      );
      const diagnostics = composition.moduleHost.snapshot();
      const surfaces: readonly object[] = [
        composition,
        composition.definitions,
        ...composition.definitions,
        registryDefinitions,
        ...registryDefinitions,
        diagnostics,
        ...diagnostics.modules,
      ];
      const forbidden = [
        "privateDriver",
        "recoveryDriver",
        "mutationCoordinator",
        "withMutation",
        "tripFatal",
      ];

      for (const surface of surfaces) {
        const keys = Reflect.ownKeys(surface).map(String);
        expect(keys).not.toEqual(expect.arrayContaining(forbidden));
      }
      expect(composition.definitions.map(({ name }) => name)).toContain(
        "cargo.calculate",
      );
    } finally {
      await composition.close();
    }
  });

  it("uses each updated removal and rollback snapshot instead of caching the old decision", async () => {
    const wideRef = activeRef("a");
    const rollbackWideRef = activeRef("b");
    let currentSnapshot = activeSnapshot(wideRef, "release_wide", 1);
    const snapshot = vi.fn(() => currentSnapshot);
    const originalHandler = vi.fn(() => unavailableOutcome("original_handler"));
    const dispatchRefs: ActiveModuleRef[] = [];
    const dispatch = dispatchForSnapshot(snapshot, async (ref, handler) => {
      dispatchRefs.push(ref);
      return handler();
    });
    const wrapped = wrapModuleToolDefinitions(
      [
        definition(originalHandler, {
          moduleId: wideRef.moduleId,
          moduleVersion: wideRef.version,
        }),
      ],
      {
        activation: { snapshot },
        dispatch: { dispatch },
      },
    );

    await expect(wrapped[0]!.handler!({}, {} as never)).resolves.toMatchObject({
      blockers: [{ code: "original_handler" }],
    });
    currentSnapshot = {
      releaseId: "release_narrow",
      revision: 2,
      activeModules: [],
    };
    await expect(wrapped[0]!.handler!({}, {} as never)).resolves.toMatchObject({
      status: "unavailable",
      blockers: [{ code: "module_disabled_by_release" }],
    });
    currentSnapshot = activeSnapshot(rollbackWideRef, "release_rollback", 3);
    await expect(wrapped[0]!.handler!({}, {} as never)).resolves.toMatchObject({
      blockers: [{ code: "original_handler" }],
    });

    expect(originalHandler).toHaveBeenCalledTimes(2);
    expect(dispatchRefs).toEqual([wideRef, rollbackWideRef]);
    expect(snapshot).toHaveBeenCalledTimes(3);
  });
});
