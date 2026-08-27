import { describe, expect, it } from "vitest";

import {
  CapabilityRegistry,
  ModuleHost,
  ModuleRuntimeError,
  moduleManifestDigest,
  parseT0ProductionProfile,
  T0_MODULE_DESCRIPTORS,
  toolContractDigest,
  validateModuleDescriptor,
} from "../../src/logistics_mcp/module-runtime";
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
