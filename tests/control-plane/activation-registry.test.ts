import { describe, expect, it } from "vitest";

import {
  ModuleActivationError,
  ModuleActivationRegistry,
} from "../../src/logistics_mcp/control-plane/activation-registry";
import * as publicControlPlane from "../../src/logistics_mcp/control-plane/index";
import type {
  ModuleActivationErrorCode,
} from "../../src/logistics_mcp/control-plane/activation-registry";
import {
  assertTrustedModuleInventory,
  createModuleInventory,
  isTrustedModuleInventory,
} from "../../src/logistics_mcp/control-plane/inventory";
import type {
  ActiveModuleRef,
  DescriptorDigest,
  ModuleActivationSnapshot,
  ModuleInventoryInput,
  TrustedModuleInventory,
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

interface MutableInventoryEntry {
  moduleId: string;
  version: string;
  riskLevel: "T0" | "T1" | "T2" | "T3";
  toolNames: string[];
  standardRefs: string[];
  descriptorDigest: DescriptorDigest;
  evidenceLevel: "local_build";
  productionEligible: false;
  evidenceRefs: {
    sourceShaRef: string | null;
    artifactDigestRef: string | null;
    signatureRef: string | null;
    sbomRef: string | null;
    attestationRef: string | null;
  };
}

interface UnsafeMutationSurface {
  stageCandidate?: (candidate: unknown) => unknown;
  candidateSnapshot?: (handle: unknown) => unknown;
  verifyCandidate?: (handle: unknown, observed: unknown) => unknown;
  commitCandidate?: (proof: unknown) => void;
  abortCandidate?: (handle: unknown) => void;
  restoreVerified?: (evidence: unknown) => void;
}

const FORBIDDEN_MUTATION_METHODS = [
  "stageCandidate",
  "candidateSnapshot",
  "verifyCandidate",
  "commitCandidate",
  "abortCandidate",
  "restoreVerified",
  "replace",
  "readbackSnapshot",
] as const;

function inventory(): TrustedModuleInventory {
  return createModuleInventory(inventoryInput);
}

function mutableInventoryEntry(index = 0): MutableInventoryEntry {
  const entry = inventory()[index]!;
  return {
    moduleId: entry.moduleId,
    version: entry.version,
    riskLevel: entry.riskLevel,
    toolNames: [...entry.toolNames],
    standardRefs: [...entry.standardRefs],
    descriptorDigest: entry.descriptorDigest,
    evidenceLevel: entry.evidenceLevel,
    productionEligible: entry.productionEligible,
    evidenceRefs: { ...entry.evidenceRefs },
  };
}

function makeRegistry(): {
  readonly registry: ModuleActivationRegistry;
  readonly refs: readonly ActiveModuleRef[];
} {
  const entries = inventory();
  const refs = entries.map((entry) => ({
    moduleId: entry.moduleId,
    version: entry.version,
    descriptorDigest: entry.descriptorDigest,
  }));
  return { registry: new ModuleActivationRegistry(entries), refs };
}

function expectCode(action: () => unknown, code: ModuleActivationErrorCode): void {
  let thrown: ModuleActivationError | null = null;
  try {
    action();
  } catch (error: unknown) {
    if (!(error instanceof ModuleActivationError)) {
      throw error;
    }
    thrown = error;
  }
  expect(thrown).not.toBeNull();
  expect(thrown?.code).toBe(code);
}

function expectInventoryInvalid(value: unknown): void {
  expectCode(
    () => new ModuleActivationRegistry(value as TrustedModuleInventory),
    "inventory_invalid",
  );
}

function activationCandidate(
  ref: ActiveModuleRef,
): ModuleActivationSnapshot {
  return {
    releaseId: "release_untrusted",
    revision: 1,
    activeModules: [{ ...ref }],
  };
}

describe("module activation registry", () => {
  it("treats only the exact createModuleInventory array as trusted constructor authority", () => {
    const trusted = inventory();
    const spread = [...trusted];
    const clone = trusted.map((entry) => ({
      ...entry,
      toolNames: [...entry.toolNames],
      standardRefs: [...entry.standardRefs],
      evidenceRefs: { ...entry.evidenceRefs },
    }));
    const proxy = new Proxy(trusted, {});
    const forgedNotMounted = [mutableInventoryEntry()] as unknown as TrustedModuleInventory;

    expect(isTrustedModuleInventory(trusted)).toBe(true);
    expect(isTrustedModuleInventory(spread)).toBe(false);
    expect(isTrustedModuleInventory(clone)).toBe(false);
    expect(isTrustedModuleInventory(proxy)).toBe(false);
    expect(isTrustedModuleInventory(forgedNotMounted)).toBe(false);
    expect(() => assertTrustedModuleInventory(trusted)).not.toThrow();
    expect(() => assertTrustedModuleInventory(spread)).toThrow();

    for (const candidate of [spread, clone, proxy, forgedNotMounted]) {
      expectInventoryInvalid(candidate);
    }
    expect(() => new ModuleActivationRegistry(trusted)).not.toThrow();
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(trusted[0])).toBe(true);
    expect(Object.isFrozen(trusted[0]!.toolNames)).toBe(true);
    expect(Object.isFrozen(trusted[0]!.standardRefs)).toBe(true);
    expect(Object.isFrozen(trusted[0]!.evidenceRefs)).toBe(true);
  });

  it("exposes only constructor, snapshot, and isActive on a frozen read-only public surface", () => {
    const { registry } = makeRegistry();
    const prototypeMethods = Object.getOwnPropertyNames(
      ModuleActivationRegistry.prototype,
    ).sort();

    expect(prototypeMethods).toEqual(["constructor", "isActive", "snapshot"]);
    for (const method of FORBIDDEN_MUTATION_METHODS) {
      expect(Object.hasOwn(ModuleActivationRegistry.prototype, method)).toBe(false);
      expect(method in registry).toBe(false);
      expect((registry as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
    expect(Reflect.ownKeys(registry).sort()).toEqual(["isActive", "snapshot"]);
    expect(Object.keys(registry)).toEqual([]);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("does not leak the service-private authority through the public control-plane index", () => {
    const publicExports = publicControlPlane as unknown as Record<string, unknown>;

    expect(publicExports.createActivationGate).toBeUndefined();
    expect(publicExports.ActivationAuthorityError).toBeUndefined();
    expect(publicExports.registerActivationRegistryState).toBeUndefined();
    expect(publicExports.readActivationRegistrySnapshot).toBeUndefined();
  });

  it("locks prototype methods and prototype chains against same-realm replacement", () => {
    const first = makeRegistry();
    const before = first.registry.snapshot();
    const prototype = ModuleActivationRegistry.prototype;
    const originalPrototype = Reflect.getPrototypeOf(prototype);
    const snapshotDescriptor = Object.getOwnPropertyDescriptor(prototype, "snapshot")!;
    const isActiveDescriptor = Object.getOwnPropertyDescriptor(prototype, "isActive")!;
    const forgedSnapshot = activationCandidate(first.refs[0]!);
    const fakeSnapshot = (): ModuleActivationSnapshot => forgedSnapshot;
    const fakeIsActive = (): boolean => true;
    const mutablePrototype = prototype;

    let assignmentError: unknown;
    try {
      mutablePrototype.snapshot = fakeSnapshot;
    } catch (error: unknown) {
      assignmentError = error;
    }
    const assignmentChangedExisting = first.registry.snapshot() === forgedSnapshot;
    const assignmentChangedNew = makeRegistry().registry.snapshot() === forgedSnapshot;
    if (Object.getOwnPropertyDescriptor(prototype, "snapshot")?.value !== snapshotDescriptor.value) {
      Object.defineProperty(prototype, "snapshot", snapshotDescriptor);
    }

    let definePropertyError: unknown;
    try {
      Object.defineProperty(prototype, "isActive", {
        configurable: true,
        enumerable: false,
        value: fakeIsActive,
        writable: true,
      });
    } catch (error: unknown) {
      definePropertyError = error;
    }
    const definePropertyChangedExisting = first.registry.isActive(first.refs[0]!);
    const freshDuringDefine = makeRegistry();
    const definePropertyChangedNew = freshDuringDefine.registry.isActive(
      freshDuringDefine.refs[0]!,
    );
    if (Object.getOwnPropertyDescriptor(prototype, "isActive")?.value !== isActiveDescriptor.value) {
      Object.defineProperty(prototype, "isActive", isActiveDescriptor);
    }

    const deleteResult = Reflect.deleteProperty(prototype, "snapshot");
    const deleteChangedExisting = typeof first.registry.snapshot !== "function";
    const deleteChangedNew = typeof makeRegistry().registry.snapshot !== "function";
    if (!Object.hasOwn(prototype, "snapshot")) {
      Object.defineProperty(prototype, "snapshot", snapshotDescriptor);
    }

    const hostilePrototype = {
      isActive: fakeIsActive,
      snapshot: fakeSnapshot,
    };
    const prototypeSetResult = Reflect.setPrototypeOf(prototype, hostilePrototype);
    const prototypeChainChanged = Reflect.getPrototypeOf(prototype) === hostilePrototype;
    if (prototypeChainChanged) {
      Reflect.setPrototypeOf(prototype, originalPrototype);
    }
    const instanceSetResult = Reflect.setPrototypeOf(first.registry, hostilePrototype);

    expect(Object.isFrozen(prototype)).toBe(true);
    expect(snapshotDescriptor).toMatchObject({ configurable: false, writable: false });
    expect(isActiveDescriptor).toMatchObject({ configurable: false, writable: false });
    expect(assignmentError).toBeInstanceOf(TypeError);
    expect(assignmentChangedExisting).toBe(false);
    expect(assignmentChangedNew).toBe(false);
    expect(definePropertyError).toBeInstanceOf(TypeError);
    expect(definePropertyChangedExisting).toBe(false);
    expect(definePropertyChangedNew).toBe(false);
    expect(deleteResult).toBe(false);
    expect(deleteChangedExisting).toBe(false);
    expect(deleteChangedNew).toBe(false);
    expect(prototypeSetResult).toBe(false);
    expect(prototypeChainChanged).toBe(false);
    expect(instanceSetResult).toBe(false);

    const freshAfterAttacks = makeRegistry();
    expect(first.registry.snapshot()).toBe(before);
    expect(first.registry.isActive(first.refs[0]!)).toBe(false);
    expect(freshAfterAttacks.registry.snapshot()).toEqual(before);
    expect(freshAfterAttacks.registry.isActive(freshAfterAttacks.refs[0]!)).toBe(false);
  });

  it("anchors the delivered facade against Proxy and borrowed-call receiver substitution", () => {
    const { registry, refs } = makeRegistry();
    const before = registry.snapshot();
    const snapshotDescriptor = Object.getOwnPropertyDescriptor(registry, "snapshot");
    const isActiveDescriptor = Object.getOwnPropertyDescriptor(registry, "isActive");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Borrowing is the behavior under test.
    const borrowedSnapshot = registry.snapshot;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Borrowing is the behavior under test.
    const borrowedIsActive = registry.isActive;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The raw prototype receiver check is intentional.
    const prototypeSnapshot = ModuleActivationRegistry.prototype.snapshot;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The raw prototype receiver check is intentional.
    const prototypeIsActive = ModuleActivationRegistry.prototype.isActive;

    expect(snapshotDescriptor).toMatchObject({
      configurable: false,
      enumerable: false,
      value: borrowedSnapshot,
      writable: false,
    });
    expect(isActiveDescriptor).toMatchObject({
      configurable: false,
      enumerable: false,
      value: borrowedIsActive,
      writable: false,
    });

    expect(Reflect.apply(borrowedSnapshot, {}, [])).toBe(before);
    expect(Reflect.apply(borrowedIsActive, {}, [refs[0]!])).toBe(false);
    expectCode(
      () => Reflect.apply(prototypeSnapshot, {}, []),
      "registry_invalid",
    );
    expect(Reflect.apply(
      prototypeIsActive,
      {},
      [refs[0]!],
    )).toBe(false);

    const transparentProxy = new Proxy(registry, {});
    expect(transparentProxy.snapshot()).toBe(before);
    expect(transparentProxy.isActive(refs[0]!)).toBe(false);

    let proxyGetCount = 0;
    const forgedSnapshot = activationCandidate(refs[0]!);
    const maliciousProxy = new Proxy(registry, {
      get(target, property, receiver): unknown {
        proxyGetCount += 1;
        if (property === "snapshot") {
          return (): ModuleActivationSnapshot => forgedSnapshot;
        }
        if (property === "isActive") {
          return (): boolean => true;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() => maliciousProxy.snapshot()).toThrow(TypeError);
    expect(() => maliciousProxy.isActive(refs[0]!)).toThrow(TypeError);
    expect(proxyGetCount).toBe(2);
    expect(registry.snapshot()).toBe(before);
    expect(registry.isActive(refs[0]!)).toBe(false);
  });

  it("keeps the exact initial snapshot empty and deeply frozen", () => {
    const { registry, refs } = makeRegistry();
    const snapshot = registry.snapshot();

    expect(snapshot).toEqual({
      releaseId: null,
      revision: 0,
      activeModules: [],
    });
    expect(registry.snapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.activeModules)).toBe(true);
    expect(registry.isActive(refs[0]!)).toBe(false);
    expect(registry.isActive(refs[1]!)).toBe(false);
    expect(() => {
      (snapshot.activeModules as ActiveModuleRef[]).push(refs[0]!);
    }).toThrow();
    expect(registry.snapshot()).toBe(snapshot);
  });

  it("does not let plain, cloned, structured-cloned, cast, or Proxy data self-attest activation", () => {
    const baseline = makeRegistry();
    const plain = activationCandidate(baseline.refs[0]!);
    const cloned = {
      ...plain,
      activeModules: plain.activeModules.map((ref) => ({ ...ref })),
    };
    const cast = plain as unknown as Readonly<{
      __verifiedActivationProof: "forged";
    }>;
    const candidates: readonly unknown[] = [
      plain,
      cloned,
      structuredClone(plain),
      cast,
      new Proxy(plain, {}),
    ];

    for (const candidate of candidates) {
      for (const proxyRegistry of [false, true]) {
        const { registry, refs } = makeRegistry();
        const before = registry.snapshot();
        const exposed = proxyRegistry
          ? new Proxy(registry, {})
          : registry;
        const surface = exposed as unknown as UnsafeMutationSurface;
        try {
          const handle = surface.stageCandidate?.(candidate);
          const proof = handle === undefined
            ? undefined
            : surface.verifyCandidate?.(handle, candidate);
          if (proof !== undefined) {
            surface.commitCandidate?.(proof);
          }
        } catch {
          // Inputs that already fail closed must still leave no reachable authority.
        }

        for (const method of FORBIDDEN_MUTATION_METHODS) {
          expect((surface as unknown as Record<string, unknown>)[method]).toBeUndefined();
        }
        expect(registry.snapshot()).toBe(before);
        expect(registry.isActive(refs[0]!)).toBe(false);
      }
    }
  });

  it("does not expose reflective instance state that a cast or Proxy can replace", () => {
    const { registry, refs } = makeRegistry();
    const before = registry.snapshot();
    const forged = activationCandidate(refs[0]!);
    const direct = registry as unknown as Record<string, unknown>;
    const proxy = new Proxy(registry, {}) as unknown as Record<string, unknown>;

    expect(Reflect.set(direct, "currentSnapshot", forged)).toBe(false);
    expect(Reflect.set(direct, "staged", forged)).toBe(false);
    expect(Reflect.set(proxy, "currentSnapshot", forged)).toBe(false);
    expect({ ...direct }).toEqual({});
    expect(registry.snapshot()).toBe(before);
    expect(registry.isActive(refs[0]!)).toBe(false);
  });

  it("requires a closed full ref and remains fail-closed for every identity", () => {
    const { registry, refs } = makeRegistry();
    const exact = refs[0]!;

    expect(registry.isActive(exact)).toBe(false);
    expect(registry.isActive({
      ...exact,
      descriptorDigest: digestFor("f"),
    })).toBe(false);
    expect(registry.isActive({
      ...exact,
      version: "2026-08-21.v1",
    })).toBe(false);
    expect(registry.isActive({
      ...exact,
      moduleId: "other",
    })).toBe(false);
    expect(registry.isActive({
      moduleId: exact.moduleId,
      version: exact.version,
    } as unknown as ActiveModuleRef)).toBe(false);

    let proxyTrapCount = 0;
    const proxied = new Proxy({ ...exact }, {
      get() {
        proxyTrapCount += 1;
        throw new Error("must not run");
      },
      getPrototypeOf() {
        proxyTrapCount += 1;
        throw new Error("must not run");
      },
      ownKeys() {
        proxyTrapCount += 1;
        throw new Error("must not run");
      },
    });
    expect(registry.isActive(proxied)).toBe(false);
    expect(proxyTrapCount).toBe(0);

    let getterReads = 0;
    const accessor = {
      version: exact.version,
      descriptorDigest: exact.descriptorDigest,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "moduleId", {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1;
        return exact.moduleId;
      },
    });
    expect(registry.isActive(accessor as unknown as ActiveModuleRef)).toBe(false);
    expect(getterReads).toBe(0);
  });
});
