import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createModuleInventory,
  ModuleInventoryError,
} from "../../src/logistics_mcp/control-plane/inventory";
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

function captureInventoryError(candidate: ModuleInventoryInput): unknown {
  try {
    createModuleInventory(candidate);
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
      input({ mountedModules: [moduleData("cargo", { riskLevel: "T1" }), moduleData("container", { version: "2026-08-21.v1" })] }),
      input({ mountedModules: [moduleData("cargo", { requiredCapabilities: ["audit"] }), moduleData("container", { version: "2026-08-21.v1" })] }),
      input({ mountedModules: [moduleData("cargo", { optionalCapabilities: ["safe_http"] }), moduleData("container", { version: "2026-08-21.v1" })] }),
      input({ mountedModules: [moduleData("cargo", { standardRefs: ["module-runtime.v0"] }), moduleData("container", { version: "2026-08-21.v1" })] }),
      input({ catalog: [toolData("cargo", "cargo.calculate", { riskLevel: "T1" }), toolData("container", "container.plan_summary", { permission: "container:calculate" })] }),
      input({ catalog: [toolData("cargo", "cargo.calculate", { inputSchemaId: "urn:input:cargo.v2" }), toolData("container", "container.plan_summary", { permission: "container:calculate" })] }),
      input({ catalog: [toolData("cargo", "cargo.calculate", { outputSchemaId: "urn:output:cargo.v2" }), toolData("container", "container.plan_summary", { permission: "container:calculate" })] }),
      input({ catalog: [toolData("cargo", "cargo.calculate", { standardRefs: ["module-runtime.v0"] }), toolData("container", "container.plan_summary", { permission: "container:calculate" })] }),
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

  it("rejects duplicate module IDs, duplicate tool owners, and malformed local evidence refs", () => {
    expect(() => createModuleInventory(input({
      mountedModules: [moduleData("cargo"), moduleData("cargo", { version: "2026-08-21.v1" })],
    }))).toThrow(/module.*duplicate|duplicate.*module/i);

    expect(() => createModuleInventory(input({
      catalog: [toolData("cargo", "cargo.calculate"), toolData("container", "cargo.calculate")],
    }))).toThrow(/tool.*duplicate|duplicate.*tool/i);

    expect(() => createModuleInventory(input({
      catalog: [
        toolData("cargo", "cargo.calculate"),
        toolData("cargo", "system.get_data_status", { permission: "system:read" }),
      ],
    }))).toThrow(/owner.*duplicate|duplicate.*owner/i);

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

  it("binds evidence refs into the digest while preserving set-order canonicalization", () => {
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
      .not.toBe(base.find((entry) => entry.moduleId === "cargo")?.descriptorDigest);
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
