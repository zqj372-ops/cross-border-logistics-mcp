import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CapabilityRegistry,
  ModuleHost,
  ModuleRuntimeError,
  RegistrationLease,
  type CapabilityRequirementInput,
  type ModuleDefinition,
} from "../../src/logistics_mcp/module-runtime";

const tool = (name: string) => ({
  name,
  title: name,
  description: `${name} tool`,
  inputSchemaId: `urn:test:${name}:input`,
  outputSchemaId: `urn:test:${name}:output`,
  permission: "system:read",
  kind: "read" as const,
  riskLevel: "T0" as const,
  standardRefs: ["module-runtime.v0"],
  inputSchema: z.object({}).strict(),
  validateOutput: () => undefined,
  handler: () => ({ status: "success" as const, data: { ok: true } }),
});

function moduleDefinition(
  moduleId: string,
  mount: ModuleDefinition["mount"],
  requiredCapabilities: readonly CapabilityRequirementInput[] = [],
  optionalCapabilities: readonly CapabilityRequirementInput[] = [],
): ModuleDefinition {
  return {
    manifest: {
      module_id: moduleId,
      version: "2026-08-21.v0",
      risk_level: "T0",
      required_capabilities: requiredCapabilities,
      optional_capabilities: optionalCapabilities,
      standard_ids: ["module-runtime.v0"],
      lifecycle: "static",
    },
    mount,
  };
}

describe("Module Runtime v0", () => {
  it("provides named capabilities and cleans registration leases in reverse order", async () => {
    const capabilities = new CapabilityRegistry();
    const logger = { info: vi.fn() };
    capabilities.provide("logger", logger);
    expect(capabilities.resolve<typeof logger>("logger")).toBe(logger);
    expect(() => capabilities.provide("logger", logger)).toThrow(ModuleRuntimeError);

    const events: string[] = [];
    const lease = new RegistrationLease();
    lease.add(() => { events.push("first"); });
    lease.add(() => { events.push("second"); });
    await lease.close();
    await lease.close();
    expect(events).toEqual(["second", "first"]);
  });

  it("mounts a static module into a catalog and removes it on close", async () => {
    const host = new ModuleHost({
      capabilities: new CapabilityRegistry(),
      modules: [
        moduleDefinition("demo", (context) => {
          context.tools.register(tool("demo.read"));
        }),
      ],
    });

    await host.mount();
    expect(host.status).toBe("mounted");
    expect(host.catalog.list().map((entry) => entry.name)).toEqual(["demo.read"]);
    await host.close();
    expect(host.status).toBe("closed");
    expect(host.catalog.list()).toEqual([]);
  });

  it("fails closed for missing capabilities and duplicate tool names without a partial catalog", async () => {
    const missing = new ModuleHost({
      capabilities: new CapabilityRegistry(),
      modules: [
        moduleDefinition("needs-db", (context) => {
          context.tools.register(tool("should.not.appear"));
        }, ["database"]),
      ],
    });
    await expect(missing.mount()).rejects.toThrow(ModuleRuntimeError);
    expect(missing.catalog.list()).toEqual([]);

    const duplicate = new ModuleHost({
      capabilities: new CapabilityRegistry(),
      modules: [
        moduleDefinition("one", (context) => context.tools.register(tool("same.name"))),
        moduleDefinition("two", (context) => context.tools.register(tool("same.name"))),
      ],
    });
    await expect(duplicate.mount()).rejects.toThrow(ModuleRuntimeError);
    expect(duplicate.catalog.list()).toEqual([]);
  });

  it("scopes modules to declared, version-matching capabilities", async () => {
    const declared = { name: "declared" };
    const hidden = { name: "hidden" };
    const optionalMissing = "optional-missing@v1";
    const capabilities = new CapabilityRegistry();
    capabilities.provide("declared", declared, "v1");
    capabilities.provide("hidden", hidden, "v1");

    const host = new ModuleHost({
      capabilities,
      modules: [
        moduleDefinition(
          "scoped",
          (context) => {
            expect(context.capabilities.names()).toEqual(["declared"]);
            expect(context.capabilities.has("declared")).toBe(true);
            expect(context.capabilities.resolve<typeof declared>("declared")).toBe(declared);
            expect(context.capabilities.has("hidden")).toBe(false);
            expect(context.capabilities.has("optional-missing")).toBe(false);
            expect(() => context.capabilities.resolve("hidden")).toThrowError(
              expect.objectContaining({ code: "capability_undeclared" }),
            );
          },
          [{ name: "declared", version: "v1" }],
          [optionalMissing],
        ),
      ],
    });

    await host.mount();
    expect(host.status).toBe("mounted");
    await host.close();
  });

  it("blocks mount before module code runs when a required capability version mismatches", async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.provide("jht_browser_session", {}, "v2");
    let mounted = false;
    const host = new ModuleHost({
      capabilities,
      modules: [
        moduleDefinition("needs-jht-session", () => {
          mounted = true;
        }, ["jht_browser_session@v1"]),
      ],
    });

    await expect(host.mount()).rejects.toMatchObject({ code: "capability_version_mismatch" });
    expect(mounted).toBe(false);
    expect(host.status).toBe("failed");
    expect(host.catalog.list()).toEqual([]);
  });

  it("fails closed when a module resolves a globally provided but undeclared capability", async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.provide("global-only", { secret: true }, "v1");
    const host = new ModuleHost({
      capabilities,
      modules: [
        moduleDefinition("undeclared-resolver", (context) => {
          context.capabilities.resolve("global-only");
        }),
      ],
    });

    await expect(host.mount()).rejects.toMatchObject({ code: "capability_undeclared" });
    expect(host.status).toBe("failed");
    expect(host.catalog.list()).toEqual([]);
  });
});
