import { describe, expect, it } from "vitest";

import {
  CapabilityRegistry,
  createT0CatalogGeneration,
  ModuleHost,
  ModuleRuntimeError,
  moduleManifestDigest,
  parseT0ProductionProfile,
  T0_MODULE_DESCRIPTORS,
  T0_PRODUCTION_RESOURCE_URIS,
  toolContractDigest,
  validateModuleDescriptor,
} from "../../src/logistics_mcp/module-runtime";
import { computeT0ModuleArtifactDigests } from "../../src/logistics_mcp/module-runtime/artifact-attestation";
import { cargoModule } from "../../src/logistics_mcp/modules";

describe("T0 production module descriptors", () => {
  it("accepts only the explicitly supported production profiles", () => {
    expect(parseT0ProductionProfile("t0-staging")).toBe("t0-staging");
    expect(parseT0ProductionProfile("t0-v1")).toBe("t0-v1");

    for (const profile of ["", "fixture-lab", "production", " t0-v1 "]) {
      expect(() => parseT0ProductionProfile(profile)).toThrow(ModuleRuntimeError);
    }
  });

  it("keeps a reviewed digest bound to every T0 module identity and capability set", () => {
    expect(T0_MODULE_DESCRIPTORS.map(({ module_id }) => module_id)).toEqual([
      "cargo",
      "container",
      "agent-access",
    ]);

    for (const descriptor of T0_MODULE_DESCRIPTORS) {
      expect(descriptor.artifact_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(descriptor.manifest_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(validateModuleDescriptor(descriptor)).toEqual(descriptor);
    }

    const cargo = T0_MODULE_DESCRIPTORS.find(({ module_id }) => module_id === "cargo");
    if (cargo === undefined) throw new Error("cargo descriptor missing");

    expect(() => validateModuleDescriptor({
      ...cargo,
      version: "2026-08-21.v1",
    })).toThrow(ModuleRuntimeError);
    expect(() => validateModuleDescriptor({
      ...cargo,
      tool_names: ["cargo.calculate", "cargo.unsafe"],
    })).toThrow(ModuleRuntimeError);
    expect(() => validateModuleDescriptor({
      ...cargo,
      required_capabilities: ["network.outbound"],
    })).toThrow(ModuleRuntimeError);
    expect(() => validateModuleDescriptor({
      ...cargo,
      tool_contracts: [{
        ...cargo.tool_contracts[0],
        input_schema_id: "urn:logistics-mcp:cargo.calculate:changed",
      }],
    })).toThrow(ModuleRuntimeError);
  });

  it("builds one immutable content-addressed generation for the exact T0 catalog", () => {
    const generation = createT0CatalogGeneration("t0-v1");
    const reordered = createT0CatalogGeneration(
      "t0-v1",
      [...T0_MODULE_DESCRIPTORS].reverse(),
      [...T0_PRODUCTION_RESOURCE_URIS].reverse(),
    );

    expect(reordered).toEqual(generation);
    expect(generation).toMatchObject({
      schema_version: "2026-09-02.v1",
      profile: "t0-v1",
      catalog_generation: `catalog_${generation.catalog_digest.slice("sha256:".length)}`,
      resource_uris: [...T0_PRODUCTION_RESOURCE_URIS].sort(),
      prompt_names: [],
    });
    expect(generation.modules.map(({ module_id }) => module_id)).toEqual([
      "agent-access",
      "cargo",
      "container",
    ]);
    expect(generation.modules.flatMap(({ tools }) => tools.map(({ name }) => name))).toEqual([
      "system.agent_context.get",
      "cargo.calculate",
      "container.plan_summary",
    ]);
    expect(generation.catalog_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(generation)).toBe(true);
    expect(Object.isFrozen(generation.modules)).toBe(true);
    expect(Object.isFrozen(generation.modules[0])).toBe(true);
    expect(Object.isFrozen(generation.modules[0]?.tools)).toBe(true);
    expect(Object.isFrozen(generation.resource_uris)).toBe(true);
    expect(Object.isFrozen(generation.prompt_names)).toBe(true);
  });

  it("changes the generation when reviewed content changes and rejects incomplete exact sets", () => {
    const current = createT0CatalogGeneration("t0-v1");
    const agentAccess = T0_MODULE_DESCRIPTORS.find(
      ({ module_id }) => module_id === "agent-access",
    );
    if (agentAccess === undefined) throw new Error("agent-access descriptor missing");
    const changedAgentAccess = {
      ...agentAccess,
      artifact_digest: `sha256:${"f".repeat(64)}` as const,
      manifest_digest: moduleManifestDigest({
        ...agentAccess,
        artifact_digest: `sha256:${"f".repeat(64)}`,
      }),
    };
    const changed = createT0CatalogGeneration(
      "t0-v1",
      T0_MODULE_DESCRIPTORS.map((descriptor) =>
        descriptor.module_id === "agent-access" ? changedAgentAccess : descriptor
      ),
    );

    expect(changed.catalog_digest).not.toBe(current.catalog_digest);
    expect(changed.catalog_generation).not.toBe(current.catalog_generation);
    expect(createT0CatalogGeneration("t0-staging").catalog_generation).not.toBe(
      current.catalog_generation,
    );
    expect(() => createT0CatalogGeneration(
      "t0-v1",
      T0_MODULE_DESCRIPTORS.slice(0, 2),
    )).toThrow(expect.objectContaining({ code: "t0_catalog_module_set_invalid" }));
    expect(() => createT0CatalogGeneration(
      "t0-v1",
      T0_MODULE_DESCRIPTORS,
      T0_PRODUCTION_RESOURCE_URIS.slice(0, 4),
    )).toThrow(expect.objectContaining({ code: "t0_catalog_resource_set_invalid" }));
  });

  it("binds each reviewed descriptor to reproducible implementation, validator, and schema bytes", async () => {
    const actual = await computeT0ModuleArtifactDigests();

    expect(Object.fromEntries(
      T0_MODULE_DESCRIPTORS.map((descriptor) => [
        descriptor.module_id,
        descriptor.artifact_digest,
      ]),
    )).toEqual(actual);
  });

  it("fails closed when the reviewed descriptor set or mounted tool set drifts", () => {
    expect(() => new ModuleHost({
      capabilities: new CapabilityRegistry(),
      modules: [cargoModule],
      trustedDescriptors: T0_MODULE_DESCRIPTORS,
    })).toThrow(expect.objectContaining({ code: "module_descriptor_set_mismatch" }));

    const cargo = T0_MODULE_DESCRIPTORS.find(({ module_id }) => module_id === "cargo");
    if (cargo === undefined) throw new Error("cargo descriptor missing");
    const cargoContract = cargo.tool_contracts[0];
    if (cargoContract === undefined) throw new Error("cargo tool contract missing");
    const renamedContract = {
      ...cargoContract,
      name: "cargo.changed",
      contract_digest: toolContractDigest({
        ...cargoContract,
        name: "cargo.changed",
      }),
    };
    const drifted = {
      ...cargo,
      tool_names: ["cargo.changed"],
      tool_contracts: [renamedContract],
      manifest_digest: moduleManifestDigest({
        ...cargo,
        tool_names: ["cargo.changed"],
        tool_contracts: [renamedContract],
      }),
    };
    const host = new ModuleHost({
      capabilities: new CapabilityRegistry(),
      modules: [cargoModule],
      trustedDescriptors: [drifted],
    });
    expect(() => host.mountSync()).toThrow(expect.objectContaining({
      code: "module_descriptor_tool_set_mismatch",
    }));
    expect(host.status).toBe("failed");
    expect(host.catalog.list()).toEqual([]);

    const reviewedContract = cargoContract;
    const changedContract = {
      ...reviewedContract,
      input_schema_id: "urn:logistics-mcp:cargo.calculate:2026-08-11.changed",
      contract_digest: toolContractDigest({
        ...reviewedContract,
        input_schema_id: "urn:logistics-mcp:cargo.calculate:2026-08-11.changed",
      }),
    };
    const contractDrifted = {
      ...cargo,
      tool_contracts: [changedContract],
      manifest_digest: moduleManifestDigest({
        ...cargo,
        tool_contracts: [changedContract],
      }),
    };
    const contractHost = new ModuleHost({
      capabilities: new CapabilityRegistry(),
      modules: [cargoModule],
      trustedDescriptors: [contractDrifted],
    });
    expect(() => contractHost.mountSync()).toThrow(expect.objectContaining({
      code: "module_descriptor_tool_contract_mismatch",
    }));
    expect(contractHost.status).toBe("failed");
  });
});
