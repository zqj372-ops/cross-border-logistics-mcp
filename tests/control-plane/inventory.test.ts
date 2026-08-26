import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createModuleInventory,
  ModuleInventoryError,
} from "../../src/logistics_mcp/control-plane/inventory";
import {
  CapabilityRegistry,
  ModuleHost,
  normalizeCapabilityRequirement,
} from "../../src/logistics_mcp/module-runtime";
import type { ModuleDefinition } from "../../src/logistics_mcp/module-runtime";
import {
  agentContextToolName,
  ForbiddenError,
  getToolPolicy,
  phaseOneToolNames,
} from "../../src/logistics_mcp/platform/rbac";
import type {
  MountedModuleData,
  MountedToolContract,
  ModuleLocalEvidence,
  ModuleInventoryInput,
} from "../../src/logistics_mcp/control-plane/types";

function moduleData(
  moduleId: string,
  overrides: Partial<MountedModuleData> = {},
): MountedModuleData {
  return {
    moduleId,
    version: "2026-08-21.v0",
    riskLevel: "T0",
    lifecycle: "static",
    requiredCapabilities: ["audit", "tenant_context"],
    optionalCapabilities: ["clock"],
    standardRefs: ["platform.contracts", "module-runtime.v0"],
    ...overrides,
  };
}

function toolData(
  owner: string,
  name: string,
  overrides: Partial<MountedToolContract> = {},
): MountedToolContract {
  return {
    owner,
    name,
    permission: "quote:calculate",
    kind: "read",
    riskLevel: "T0",
    inputSchemaId: `urn:input:${name}`,
    outputSchemaId: `urn:output:${name}`,
    standardRefs: ["platform.contracts", "module-runtime.v0"],
    ...overrides,
  };
}

function localEvidence(
  moduleId: string,
  overrides: Partial<ModuleLocalEvidence["evidenceRefs"]> = {},
  version = "2026-08-21.v0",
): ModuleLocalEvidence {
  return {
    moduleId,
    version,
    evidenceRefs: {
      sourceShaRef: null,
      artifactDigestRef: null,
      signatureRef: null,
      sbomRef: null,
      attestationRef: null,
      ...overrides,
    },
  };
}

function input(overrides: Partial<ModuleInventoryInput> = {}): ModuleInventoryInput {
  return {
    mountedModules: [
      moduleData("cargo"),
      moduleData("container", { version: "2026-08-21.v1" }),
    ],
    catalog: [
      toolData("cargo", "cargo.calculate"),
      toolData("container", "container.plan_summary", { permission: "container:calculate" }),
    ],
    localEvidence: [localEvidence("cargo"), localEvidence("container", {
      sourceShaRef: "local:source:container-v1",
    }, "2026-08-21.v1")],
    ...overrides,
  };
}

function captureInventoryError(candidate: unknown): unknown {
  try {
    createModuleInventory(candidate as ModuleInventoryInput);
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

describe("module deployment inventory", () => {
  it("has deterministic per-module digests under input and set-like array reordering", () => {
    const first = createModuleInventory(input());
    const second = createModuleInventory({
      mountedModules: [
        moduleData("container", {
          version: "2026-08-21.v1",
          requiredCapabilities: ["tenant_context", "audit"],
          optionalCapabilities: ["clock"],
          standardRefs: ["module-runtime.v0", "platform.contracts"],
        }),
        moduleData("cargo", {
          requiredCapabilities: ["tenant_context", "audit"],
          standardRefs: ["module-runtime.v0", "platform.contracts"],
        }),
      ],
      catalog: [
        toolData("container", "container.plan_summary", {
          permission: "container:calculate",
          standardRefs: ["module-runtime.v0", "platform.contracts"],
        }),
        toolData("cargo", "cargo.calculate", {
          standardRefs: ["module-runtime.v0", "platform.contracts"],
        }),
      ],
      localEvidence: [
        localEvidence("container", { sourceShaRef: "local:source:container-v1" }, "2026-08-21.v1"),
        localEvidence("cargo"),
      ],
    });

    expect(second).toEqual(first);
    expect(first.map((entry) => entry.moduleId)).toEqual(["cargo", "container"]);
    expect(first.every((entry) => entry.descriptorDigest.startsWith("sha256:"))).toBe(true);
    expect(first.every((entry) => entry.evidenceLevel === "local_build")).toBe(true);
    expect(first.every((entry) => entry.productionEligible === false)).toBe(true);
  });

  it("changes the digest when a visible module or tool contract field changes", () => {
    const base = createModuleInventory(input());
    const variants: ModuleInventoryInput[] = [
      input({ mountedModules: [moduleData("cargo", { version: "2026-08-21.v1" }), moduleData("container", { version: "2026-08-21.v1" })], localEvidence: [localEvidence("cargo", {}, "2026-08-21.v1"), localEvidence("container", { sourceShaRef: "local:source:container-v1" }, "2026-08-21.v1")] }),
      input({
        mountedModules: [
          moduleData("cargo", { riskLevel: "T1" }),
          moduleData("container", { version: "2026-08-21.v1" }),
        ],
        catalog: [
          toolData("cargo", "cargo.calculate", { riskLevel: "T1" }),
          toolData("container", "container.plan_summary", { permission: "container:calculate" }),
        ],
      }),
      input({ mountedModules: [moduleData("cargo", { requiredCapabilities: ["audit"] }), moduleData("container", { version: "2026-08-21.v1" })] }),
      input({ mountedModules: [moduleData("cargo", { optionalCapabilities: ["safe_http"] }), moduleData("container", { version: "2026-08-21.v1" })] }),
      input({ mountedModules: [moduleData("cargo", { standardRefs: ["module-runtime.v0"] }), moduleData("container", { version: "2026-08-21.v1" })] }),
      input({ catalog: [toolData("cargo", "cargo.calculate", { inputSchemaId: "urn:input:cargo.v2" }), toolData("container", "container.plan_summary", { permission: "container:calculate" })] }),
      input({ catalog: [toolData("cargo", "cargo.calculate", { outputSchemaId: "urn:output:cargo.v2" }), toolData("container", "container.plan_summary", { permission: "container:calculate" })] }),
      input({ catalog: [toolData("cargo", "cargo.calculate", { standardRefs: ["platform.contracts", "module-runtime.v0", "control-plane.v1"] }), toolData("container", "container.plan_summary", { permission: "container:calculate" })] }),
      input({ catalog: [toolData("container", "cargo.calculate", { inputSchemaId: "urn:input:cargo", outputSchemaId: "urn:output:cargo" }), toolData("cargo", "container.plan_summary", { permission: "container:calculate" })] }),
      input({ catalog: [toolData("cargo", "quote.canada_final_mile.calculate", { inputSchemaId: "urn:input:cargo.calculate", outputSchemaId: "urn:output:cargo.calculate" }), toolData("container", "container.plan_summary", { permission: "container:calculate" })] }),
    ];

    for (const variant of variants) {
      expect(createModuleInventory(variant)[0]?.descriptorDigest).not.toBe(base[0]?.descriptorDigest);
    }

    const renamedModule = createModuleInventory(input({
      mountedModules: [moduleData("freight"), moduleData("container", { version: "2026-08-21.v1" })],
      catalog: [
        toolData("freight", "cargo.calculate"),
        toolData("container", "container.plan_summary", { permission: "container:calculate" }),
      ],
      localEvidence: [
        localEvidence("freight"),
        localEvidence("container", { sourceShaRef: "local:source:container-v1" }, "2026-08-21.v1"),
      ],
    }));
    expect(renamedModule.find((entry) => entry.moduleId === "freight")?.descriptorDigest)
      .not.toBe(base.find((entry) => entry.moduleId === "cargo")?.descriptorDigest);
  });

  it("maps unknown RBAC tools to a stable non-disclosing inventory error", () => {
    for (const unknownToolName of ["future.tool", "future:read"]) {
      const thrown = captureInventoryError(input({
        catalog: [
          toolData("cargo", unknownToolName),
          toolData("container", "container.plan_summary", { permission: "container:calculate" }),
        ],
      }));

      expect(thrown).toBeInstanceOf(ModuleInventoryError);
      expect(thrown).not.toBeInstanceOf(ForbiddenError);
      expect(thrown).toMatchObject({ code: "tool_policy_unknown" });
      expect(thrown).not.toHaveProperty("message", expect.stringContaining(unknownToolName));
    }
  });

  it("maps inherited RBAC tool names to a stable non-disclosing inventory error", () => {
    for (const toolName of ["constructor", "toString"]) {
      const thrown = captureInventoryError(input({
        catalog: [
          toolData("cargo", toolName),
          toolData("container", "container.plan_summary", { permission: "container:calculate" }),
        ],
      }));

      expect(thrown).toBeInstanceOf(ModuleInventoryError);
      expect(thrown).not.toBeInstanceOf(ForbiddenError);
      expect(thrown).toMatchObject({
        code: "tool_policy_unknown",
        message: "Tool policy is not defined.",
      });
      expect(thrown).not.toHaveProperty("message", expect.stringContaining(toolName));
    }
  });

  it("rejects a known tool whose permission differs from its fixed RBAC policy", () => {
    const thrown = captureInventoryError(input({
      catalog: [
        toolData("cargo", "cargo.calculate", { permission: "system:read" }),
        toolData("container", "container.plan_summary", { permission: "container:calculate" }),
      ],
    }));

    expect(thrown).toBeInstanceOf(ModuleInventoryError);
    expect(thrown).toMatchObject({ code: "tool_permission_mismatch" });
  });

  it("rejects a known tool whose kind differs from its fixed RBAC policy", () => {
    const thrown = captureInventoryError(input({
      catalog: [
        toolData("cargo", "cargo.calculate", { kind: "write" }),
        toolData("container", "container.plan_summary", { permission: "container:calculate" }),
      ],
    }));

    expect(thrown).toBeInstanceOf(ModuleInventoryError);
    expect(thrown).toMatchObject({ code: "tool_kind_mismatch" });
  });

  it("accepts every existing bundled tool with its fixed RBAC policy", () => {
    const bundledToolNames = [...phaseOneToolNames, agentContextToolName];

    for (const [index, toolName] of bundledToolNames.entries()) {
      const owner = `policy-${index}`;
      const policy = getToolPolicy(toolName);
      const inventory = createModuleInventory({
        mountedModules: [moduleData(owner)],
        catalog: [toolData(owner, toolName, {
          permission: policy.permission,
          kind: policy.kind,
        })],
        localEvidence: [localEvidence(owner)],
      });

      expect(inventory).toHaveLength(1);
      expect(inventory[0]?.toolNames).toEqual([toolName]);
    }
  });

  it("rejects a tool whose risk level differs from its owner module", () => {
    const thrown = captureInventoryError(input({
      catalog: [
        toolData("cargo", "cargo.calculate", { riskLevel: "T1" }),
        toolData("container", "container.plan_summary", { permission: "container:calculate" }),
      ],
    }));

    expect(thrown).toBeInstanceOf(ModuleInventoryError);
    expect(thrown).toMatchObject({ code: "tool_risk_mismatch" });
  });

  it("rejects a tool that omits one of its owner module standards", () => {
    const thrown = captureInventoryError(input({
      catalog: [
        toolData("cargo", "cargo.calculate", { standardRefs: ["module-runtime.v0"] }),
        toolData("container", "container.plan_summary", { permission: "container:calculate" }),
      ],
    }));

    expect(thrown).toBeInstanceOf(ModuleInventoryError);
    expect(thrown).toMatchObject({ code: "tool_standard_missing" });
  });

  it("accepts two canonical ModuleHost tools for one owner and hashes them independent of catalog order", async () => {
    const manifest: ModuleDefinition["manifest"] = {
      module_id: "multi_tool",
      version: "2026-08-21.v0",
      risk_level: "T0",
      required_capabilities: [],
      optional_capabilities: [],
      standard_ids: ["platform.contracts", "module-runtime.v0"],
      lifecycle: "static",
    };
    const runtimeTool = (name: "cargo.calculate" | "quote.canada_final_mile.calculate") => {
      const policy = getToolPolicy(name);
      return {
        name,
        title: name,
        description: `${name} test tool`,
        inputSchemaId: `urn:input:${name}`,
        outputSchemaId: `urn:output:${name}`,
        permission: policy.permission,
        kind: policy.kind,
        riskLevel: "T0" as const,
        standardRefs: ["platform.contracts", "module-runtime.v0"],
        inputSchema: z.object({}).strict(),
        validateOutput: () => undefined,
        handler: () => ({ status: "success" as const, data: { ok: true } }),
      };
    };
    const definition: ModuleDefinition = {
      manifest,
      mount(context) {
        context.tools.register(runtimeTool("quote.canada_final_mile.calculate"));
        context.tools.register(runtimeTool("cargo.calculate"));
      },
    };
    const host = new ModuleHost({
      capabilities: new CapabilityRegistry(),
      modules: [definition],
    });
    await host.mount();

    const catalog: MountedToolContract[] = host.catalog.list().map((entry) => ({
      owner: entry.module_id,
      name: entry.name,
      permission: entry.permission,
      kind: entry.kind,
      riskLevel: entry.riskLevel,
      inputSchemaId: entry.inputSchemaId,
      outputSchemaId: entry.outputSchemaId,
      standardRefs: [...entry.standardRefs],
    }));
    const mountedModules: MountedModuleData[] = [{
      moduleId: manifest.module_id,
      version: manifest.version,
      riskLevel: manifest.risk_level,
      lifecycle: manifest.lifecycle,
      requiredCapabilities: manifest.required_capabilities.map(
        (requirement) => normalizeCapabilityRequirement(requirement).name,
      ),
      optionalCapabilities: manifest.optional_capabilities.map(
        (requirement) => normalizeCapabilityRequirement(requirement).name,
      ),
      standardRefs: [...manifest.standard_ids],
    }];
    const evidence = [localEvidence(manifest.module_id)];
    const first = createModuleInventory({
      mountedModules,
      catalog,
      localEvidence: evidence,
    });
    const reordered = createModuleInventory({
      mountedModules,
      catalog: [...catalog].reverse(),
      localEvidence: evidence,
    });
    const oneTool = createModuleInventory({
      mountedModules,
      catalog: [catalog[0]!],
      localEvidence: evidence,
    });

    expect(first[0]?.toolNames).toEqual([
      "cargo.calculate",
      "quote.canada_final_mile.calculate",
    ]);
    expect(reordered[0]?.descriptorDigest).toBe(first[0]?.descriptorDigest);
    expect(oneTool[0]?.descriptorDigest).not.toBe(first[0]?.descriptorDigest);
    await host.close();
  });

  it("rejects duplicate module IDs, duplicate tool names, and malformed local evidence refs", () => {
    expect(() => createModuleInventory(input({
      mountedModules: [moduleData("cargo"), moduleData("cargo", { version: "2026-08-21.v1" })],
    }))).toThrow(/module.*duplicate|duplicate.*module/i);

    expect(() => createModuleInventory(input({
      catalog: [toolData("cargo", "cargo.calculate"), toolData("container", "cargo.calculate")],
    }))).toThrow(/tool.*duplicate|duplicate.*tool/i);

    expect(() => createModuleInventory(input({
      localEvidence: [localEvidence("cargo", { sourceShaRef: "https://example.invalid/source" }), localEvidence("container")],
    }))).toThrow(/local|evidence|reference/i);

    expect(() => createModuleInventory(input({
      localEvidence: [
        { ...localEvidence("cargo"), productionEligible: true } as unknown as ModuleLocalEvidence,
        localEvidence("container"),
      ],
    }))).toThrow(/production|eligible|local/i);

    expect(() => createModuleInventory(input({
      localEvidence: [localEvidence("cargo"), localEvidence("container"), localEvidence("missing")],
    }))).toThrow(/unknown|mounted|evidence/i);

    expect(() => createModuleInventory(input({
      catalog: [
        toolData("cargo", "cargo.calculate", { standardRefs: [] }),
        toolData("container", "container.plan_summary", { permission: "container:calculate" }),
      ],
    }))).toThrow(/standard|incomplete|empty/i);

    expect(() => createModuleInventory({
      ...input(),
      mountedModules: input().mountedModules.map((module, index) =>
        index === 0 ? { ...module, lifecycle: "dynamic" } : module,
      ),
    } as unknown as ModuleInventoryInput)).toThrow(/static|lifecycle/i);
  });

  it("returns only local-build evidence and freezes every exposed collection", () => {
    const inventory = createModuleInventory(input());
    const first = inventory[0]!;

    expect(first.evidenceRefs).toEqual({
      sourceShaRef: null,
      artifactDigestRef: null,
      signatureRef: null,
      sbomRef: null,
      attestationRef: null,
    });
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.toolNames)).toBe(true);
    expect(Object.isFrozen(first.standardRefs)).toBe(true);
    expect(Object.isFrozen(first.evidenceRefs)).toBe(true);
  });

  it("rejects non-local evidence levels explicitly", () => {
    const untrustedEvidence = {
      ...localEvidence("cargo"),
      evidenceLevel: "verified_release",
    } as unknown as ModuleLocalEvidence;

    let thrown: unknown;
    try {
      createModuleInventory(input({
        localEvidence: [
          untrustedEvidence,
          localEvidence("container", { sourceShaRef: "local:source:container-v1" }, "2026-08-21.v1"),
        ],
      }));
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModuleInventoryError);
    expect(thrown).toMatchObject({ code: "local_evidence_invalid" });
  });

  it("keeps evidence metadata independent from the descriptor digest", () => {
    const base = createModuleInventory(input());
    const reordered = createModuleInventory({
      mountedModules: [
        moduleData("container", {
          version: "2026-08-21.v1",
          requiredCapabilities: ["tenant_context", "audit"],
          standardRefs: ["module-runtime.v0", "platform.contracts"],
        }),
        moduleData("cargo", {
          requiredCapabilities: ["tenant_context", "audit"],
          standardRefs: ["module-runtime.v0", "platform.contracts"],
        }),
      ],
      catalog: [
        toolData("container", "container.plan_summary", {
          permission: "container:calculate",
          standardRefs: ["module-runtime.v0", "platform.contracts"],
        }),
        toolData("cargo", "cargo.calculate", {
          standardRefs: ["module-runtime.v0", "platform.contracts"],
        }),
      ],
      localEvidence: [
        localEvidence("container", { sourceShaRef: "local:source:container-v1" }, "2026-08-21.v1"),
        localEvidence("cargo"),
      ],
    });
    const changedEvidence = createModuleInventory(input({
      localEvidence: [
        localEvidence("cargo", { attestationRef: "fixture:attestation:cargo-v1" }),
        localEvidence("container", { sourceShaRef: "local:source:container-v1" }, "2026-08-21.v1"),
      ],
    }));

    expect(reordered).toEqual(base);
    expect(changedEvidence.find((entry) => entry.moduleId === "cargo")?.descriptorDigest)
      .toBe(base.find((entry) => entry.moduleId === "cargo")?.descriptorDigest);
    expect(changedEvidence.find((entry) => entry.moduleId === "cargo")?.evidenceRefs)
      .not.toEqual(base.find((entry) => entry.moduleId === "cargo")?.evidenceRefs);
  });

  it("rejects every inventory boundary Proxy before any trap can run", () => {
    let trapCount = 0;
    const proxy = <T extends object>(value: T): T => new Proxy(value, {
      get() {
        trapCount += 1;
        throw new Error("proxy get trap leaked");
      },
      getPrototypeOf() {
        trapCount += 1;
        throw new Error("proxy prototype trap leaked");
      },
      ownKeys() {
        trapCount += 1;
        throw new Error("proxy ownKeys trap leaked");
      },
      getOwnPropertyDescriptor() {
        trapCount += 1;
        throw new Error("proxy descriptor trap leaked");
      },
    });

    const base = input();
    const moduleProxy = proxy({ ...base.mountedModules[0]! });
    const toolProxy = proxy({ ...base.catalog[0]! });
    const evidenceProxy = proxy({ ...base.localEvidence[0]! });
    const evidenceRefsProxy = proxy({ ...base.localEvidence[0]!.evidenceRefs });
    const requiredCapabilitiesProxy = proxy([...base.mountedModules[0]!.requiredCapabilities]);
    const optionalCapabilitiesProxy = proxy([...base.mountedModules[0]!.optionalCapabilities]);
    const moduleStandardRefsProxy = proxy([...base.mountedModules[0]!.standardRefs]);
    const toolStandardRefsProxy = proxy([...base.catalog[0]!.standardRefs]);

    const cases: readonly [string, unknown][] = [
      ["root", proxy({ ...base })],
      ["mountedModules", { ...base, mountedModules: proxy([...base.mountedModules]) }],
      ["catalog", { ...base, catalog: proxy([...base.catalog]) }],
      ["localEvidence", { ...base, localEvidence: proxy([...base.localEvidence]) }],
      ["module", { ...base, mountedModules: [moduleProxy, base.mountedModules[1]!] }],
      ["tool", { ...base, catalog: [toolProxy, base.catalog[1]!] }],
      ["evidence", { ...base, localEvidence: [evidenceProxy, base.localEvidence[1]!] }],
      ["evidenceRefs", {
        ...base,
        localEvidence: [{ ...base.localEvidence[0]!, evidenceRefs: evidenceRefsProxy }, base.localEvidence[1]!],
      }],
      ["requiredCapabilities", {
        ...base,
        mountedModules: [{ ...base.mountedModules[0]!, requiredCapabilities: requiredCapabilitiesProxy }, base.mountedModules[1]!],
      }],
      ["optionalCapabilities", {
        ...base,
        mountedModules: [{ ...base.mountedModules[0]!, optionalCapabilities: optionalCapabilitiesProxy }, base.mountedModules[1]!],
      }],
      ["module standardRefs", {
        ...base,
        mountedModules: [{ ...base.mountedModules[0]!, standardRefs: moduleStandardRefsProxy }, base.mountedModules[1]!],
      }],
      ["tool standardRefs", {
        ...base,
        catalog: [{ ...base.catalog[0]!, standardRefs: toolStandardRefsProxy }, base.catalog[1]!],
      }],
    ];

    for (const [label, candidate] of cases) {
      const thrown = captureInventoryError(candidate);
      expect(thrown, label).toBeInstanceOf(ModuleInventoryError);
    }
    expect(trapCount).toBe(0);
  });

  it("rejects accessors at every inventory boundary without invoking getters", () => {
    let getterReads = 0;
    const getter = <T extends object, K extends keyof T>(value: T, key: K, result: T[K]): T => {
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        get() {
          getterReads += 1;
          return result;
        },
      });
      return value;
    };

    const base = input();
    const cases: readonly [string, unknown][] = [
      ["root", getter({ ...base }, "mountedModules", base.mountedModules)],
      ["module", {
        ...base,
        mountedModules: [getter({ ...base.mountedModules[0]! }, "moduleId", "cargo"), base.mountedModules[1]!],
      }],
      ["tool", {
        ...base,
        catalog: [getter({ ...base.catalog[0]! }, "owner", "cargo"), base.catalog[1]!],
      }],
      ["evidence", {
        ...base,
        localEvidence: [getter({ ...base.localEvidence[0]! }, "moduleId", "cargo"), base.localEvidence[1]!],
      }],
      ["evidenceRefs", {
        ...base,
        localEvidence: [{
          ...base.localEvidence[0]!,
          evidenceRefs: getter({ ...base.localEvidence[0]!.evidenceRefs }, "sourceShaRef", null),
        }, base.localEvidence[1]!],
      }],
      ["string array index", {
        ...base,
        mountedModules: [{
          ...base.mountedModules[0]!,
          requiredCapabilities: getter(["audit", "tenant_context"], 0, "audit"),
        }, base.mountedModules[1]!],
      }],
    ];

    for (const [label, candidate] of cases) {
      const thrown = captureInventoryError(candidate);
      expect(thrown, label).toBeInstanceOf(ModuleInventoryError);
    }
    expect(getterReads).toBe(0);
  });

  it("rejects sparse, custom, symbol, null-prototype, hidden, and index-accessor shapes", () => {
    let customRuns = 0;
    const base = input();
    const customEntries = [...base.localEvidence];
    Object.defineProperty(customEntries, "entries", {
      configurable: true,
      enumerable: true,
      value: () => {
        customRuns += 1;
        return [][Symbol.iterator]();
      },
      writable: true,
    });
    const customIterator = ["audit"];
    Object.defineProperty(customIterator, Symbol.iterator, {
      configurable: true,
      enumerable: false,
      value: () => {
        customRuns += 1;
        return [][Symbol.iterator]();
      },
      writable: true,
    });
    const sparseModules = new Array<MountedModuleData>(2);
    const symbolCatalog = [...base.catalog] as MountedToolContract[] & Record<symbol, unknown>;
    symbolCatalog[Symbol("extra")] = true;
    const customPrototypeEvidence = [...base.localEvidence];
    Object.setPrototypeOf(customPrototypeEvidence, Object.create(Array.prototype) as object);
    const indexAccessor = [...base.mountedModules[0]!.requiredCapabilities];
    Object.defineProperty(indexAccessor, "0", {
      configurable: true,
      enumerable: true,
      get: () => "audit",
    });
    const nullPrototypeRoot = Object.assign(Object.create(null) as Record<string, unknown>, base);
    const hiddenRequired = { ...base.mountedModules[0]! } as Record<string, unknown>;
    Object.defineProperty(hiddenRequired, "moduleId", {
      configurable: true,
      enumerable: false,
      value: "cargo",
      writable: true,
    });
    const hiddenExtra = { ...base.mountedModules[0]! };
    Object.defineProperty(hiddenExtra, "hidden", {
      configurable: true,
      enumerable: false,
      value: true,
    });

    const cases: readonly [string, unknown][] = [
      ["custom entries", { ...base, localEvidence: customEntries }],
      ["custom iterator", {
        ...base,
        mountedModules: [{ ...base.mountedModules[0]!, requiredCapabilities: customIterator }, base.mountedModules[1]!],
      }],
      ["sparse", { ...base, mountedModules: sparseModules }],
      ["symbol", { ...base, catalog: symbolCatalog }],
      ["custom prototype", { ...base, localEvidence: customPrototypeEvidence }],
      ["index accessor", {
        ...base,
        mountedModules: [{ ...base.mountedModules[0]!, requiredCapabilities: indexAccessor }, base.mountedModules[1]!],
      }],
      ["null prototype", nullPrototypeRoot],
      ["hidden required", { ...base, mountedModules: [hiddenRequired, base.mountedModules[1]!] }],
      ["hidden extra", { ...base, mountedModules: [hiddenExtra, base.mountedModules[1]!] }],
    ];

    for (const [label, candidate] of cases) {
      expect(captureInventoryError(candidate), label).toBeInstanceOf(ModuleInventoryError);
    }
    expect(customRuns).toBe(0);
  });

  it("has a static and runtime dependency gate against cwd, files, URLs, Markdown, and network", () => {
    const inventorySource = readFileSync(
      resolve(import.meta.dirname, "../../src/logistics_mcp/control-plane/inventory.ts"),
      "utf8",
    );
    const imports = [...inventorySource.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
      .map((match) => match[1])
      .sort();
    const forbiddenSourcePatterns = [
      ["cwd", /process\.cwd\s*\(/],
      ["environment", /process\.env\b/],
      ["network", /\bfetch\s*\(/],
      ["URL", /\bnew\s+URL\s*\(/],
      ["dynamic dependency", /\b(?:import|require)\s*\(/],
      ["Markdown", /["'`][^"'`\n]*\.md(?:["'`?#]|$)/i],
    ] as const;

    expect(imports).toEqual([
      "../platform/rbac",
      "./lexical-contracts",
      "./types",
      "node:crypto",
      "node:util",
    ]);
    for (const [boundary, pattern] of forbiddenSourcePatterns) {
      expect(inventorySource, `inventory source crossed the ${boundary} boundary`).not.toMatch(pattern);
    }

    const cwdSpy = vi.spyOn(process, "cwd");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      createModuleInventory(input());
      expect(cwdSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("does not derive inventory from process environment or a filesystem location", () => {
    vi.stubEnv("MCP_CONTROL_DB_PATH", "/tmp/should-not-be-read");
    const withEnvironment = createModuleInventory(input());
    vi.unstubAllEnvs();
    const withoutEnvironment = createModuleInventory(input());

    expect(withEnvironment).toEqual(withoutEnvironment);
  });
});
