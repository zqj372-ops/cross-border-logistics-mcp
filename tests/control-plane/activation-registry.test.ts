import { describe, expect, it } from "vitest";

import { createModuleInventory } from "../../src/logistics_mcp/control-plane/inventory";
import { ModuleActivationRegistry } from "../../src/logistics_mcp/control-plane/activation-registry";
import type {
  ActiveModuleRef,
  ModuleActivationSnapshot,
  ModuleInventoryInput,
} from "../../src/logistics_mcp/control-plane/types";

const digestFor = (letter: string): `sha256:${string}` => `sha256:${letter.repeat(64)}`;

const inventoryInput: ModuleInventoryInput = {
  mountedModules: [
    {
      moduleId: "cargo",
      version: "2026-08-21.v0",
      riskLevel: "T0",
      lifecycle: "static",
      requiredCapabilities: ["audit"],
      optionalCapabilities: [],
      standardRefs: ["module-runtime.v0"],
    },
    {
      moduleId: "container",
      version: "2026-08-21.v0",
      riskLevel: "T0",
      lifecycle: "static",
      requiredCapabilities: ["audit"],
      optionalCapabilities: [],
      standardRefs: ["module-runtime.v0"],
    },
  ],
  catalog: [
    {
      owner: "cargo",
      name: "cargo.calculate",
      permission: "quote:calculate",
      kind: "read",
      riskLevel: "T0",
      inputSchemaId: "urn:input:cargo",
      outputSchemaId: "urn:output:cargo",
      standardRefs: ["module-runtime.v0"],
    },
    {
      owner: "container",
      name: "container.plan_summary",
      permission: "container:calculate",
      kind: "read",
      riskLevel: "T0",
      inputSchemaId: "urn:input:container",
      outputSchemaId: "urn:output:container",
      standardRefs: ["module-runtime.v0"],
    },
  ],
  localEvidence: [
    {
      moduleId: "cargo",
      version: "2026-08-21.v0",
      evidenceRefs: {
        sourceShaRef: null,
        artifactDigestRef: null,
        signatureRef: null,
        sbomRef: null,
        attestationRef: null,
      },
    },
    {
      moduleId: "container",
      version: "2026-08-21.v0",
      evidenceRefs: {
        sourceShaRef: null,
        artifactDigestRef: null,
        signatureRef: null,
        sbomRef: null,
        attestationRef: null,
      },
    },
  ],
};

function makeRegistry(): {
  readonly registry: ModuleActivationRegistry;
  readonly refs: readonly ActiveModuleRef[];
} {
  const inventory = createModuleInventory(inventoryInput);
  const refs = inventory.map((entry) => ({
    moduleId: entry.moduleId,
    version: entry.version,
    descriptorDigest: entry.descriptorDigest,
  }));
  return { registry: new ModuleActivationRegistry(inventory), refs };
}

describe("module activation registry", () => {
  it("starts with every inventory entry active at release null and revision zero", () => {
    const { registry, refs } = makeRegistry();
    const snapshot = registry.snapshot();

    expect(snapshot).toEqual({ releaseId: null, revision: 0, activeModules: refs });
    expect(registry.isActive("cargo", "2026-08-21.v0")).toBe(true);
    expect(registry.isActive("missing", "2026-08-21.v0")).toBe(false);
  });

  it("replaces one immutable snapshot atomically and checks exact descriptor refs", () => {
    const { registry, refs } = makeRegistry();
    const next: ModuleActivationSnapshot = {
      releaseId: "release_1",
      revision: 1,
      activeModules: [refs[0]!],
    };

    registry.replace(next);
    expect(registry.snapshot()).toEqual(next);
    expect(registry.isActive("cargo", "2026-08-21.v0")).toBe(true);
    expect(registry.isActive("container", "2026-08-21.v0")).toBe(false);

    expect(() => registry.replace({
      releaseId: "release_bad",
      revision: 2,
      activeModules: [{ ...refs[0]!, descriptorDigest: digestFor("b") }],
    })).toThrow(/descriptor|inventory|exact/i);
    expect(registry.snapshot()).toEqual(next);
  });

  it("rejects duplicate and unknown refs, stale revisions, and unsafe revision values", () => {
    const { registry, refs } = makeRegistry();
    const duplicate = { ...refs[0]! };
    expect(() => registry.replace({ releaseId: "release_1", revision: 1, activeModules: [duplicate, duplicate] })).toThrow(/duplicate/i);
    expect(() => registry.replace({
      releaseId: "release_1",
      revision: 1,
      activeModules: [{ moduleId: "unknown", version: "2026-08-21.v0", descriptorDigest: refs[0]!.descriptorDigest }],
    })).toThrow(/unknown|inventory/i);
    expect(() => registry.replace({
      releaseId: "release_1",
      revision: 1,
      activeModules: [{ ...refs[0]!, descriptorDigest: "sha256:not-a-digest" } as unknown as ActiveModuleRef],
    })).toThrow(/digest/i);
    expect(() => registry.replace({ releaseId: "release_1", revision: -1, activeModules: [] })).toThrow(/revision/i);
    expect(() => registry.replace({ releaseId: "release_1", revision: Number.MAX_SAFE_INTEGER + 1, activeModules: [] })).toThrow(/revision/i);

    registry.replace({ releaseId: "release_1", revision: 1, activeModules: [refs[0]!] });
    expect(() => registry.replace({ releaseId: "release_0", revision: 1, activeModules: [] })).toThrow(/stale|monotonic|revision/i);
    expect(() => registry.replace({ releaseId: "release_0", revision: 0, activeModules: [] })).toThrow(/stale|monotonic|revision/i);
    expect(registry.snapshot()).toEqual({ releaseId: "release_1", revision: 1, activeModules: [refs[0]] });
  });

  it("resists mutation of replacement inputs and snapshot results", () => {
    const { registry, refs } = makeRegistry();
    const activeModules = [refs[0]!];
    const next: ModuleActivationSnapshot = {
      releaseId: "release_1",
      revision: 1,
      activeModules,
    };

    registry.replace(next);
    activeModules.length = 0;
    expect(registry.snapshot().activeModules).toHaveLength(1);

    const snapshot = registry.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.activeModules)).toBe(true);
    expect(Object.isFrozen(snapshot.activeModules[0])).toBe(true);
    expect(() => {
      (snapshot.activeModules as ActiveModuleRef[]).push(refs[1]!);
    }).toThrow();
    expect(registry.snapshot().activeModules).toHaveLength(1);
  });
});
