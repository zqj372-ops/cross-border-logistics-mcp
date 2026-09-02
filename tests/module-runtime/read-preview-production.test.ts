import { describe, expect, it } from "vitest";

import {
  READ_PREVIEW_MODULE_DESCRIPTORS,
  READ_PREVIEW_MODULE_IDS,
  READ_PREVIEW_RESOURCE_URIS,
  READ_PREVIEW_TOOL_NAMES,
  createReadPreviewCatalogGeneration,
  parseProductionRuntimeProfile,
  validateModuleDescriptor,
} from "../../src/logistics_mcp/module-runtime/index.js";

describe("read-preview staging production profile", () => {
  it("parses only the reviewed profile names without weakening T0", () => {
    expect(parseProductionRuntimeProfile("t0-v1")).toBe("t0-v1");
    expect(parseProductionRuntimeProfile("t0-staging")).toBe("t0-staging");
    expect(parseProductionRuntimeProfile("read-preview-staging")).toBe(
      "read-preview-staging",
    );
    for (const value of ["", "read-preview", "production", " read-preview-staging "]) {
      expect(() => parseProductionRuntimeProfile(value)).toThrow();
    }
  });

  it("freezes an exact six-module, seven-tool and five-resource generation", () => {
    const generation = createReadPreviewCatalogGeneration();

    expect(generation.profile).toBe("read-preview-staging");
    expect(generation.modules.map(({ module_id }) => module_id).sort()).toEqual(
      [...READ_PREVIEW_MODULE_IDS].sort(),
    );
    expect(
      generation.modules.flatMap(({ tools }) => tools.map(({ name }) => name)).sort(),
    ).toEqual([...READ_PREVIEW_TOOL_NAMES].sort());
    expect(generation.resource_uris).toEqual([...READ_PREVIEW_RESOURCE_URIS].sort());
    expect(generation.prompt_names).toEqual([]);
    expect(generation.catalog_generation).toBe(
      generation.catalog_digest.replace("sha256:", "catalog_"),
    );
    expect(Object.isFrozen(generation)).toBe(true);
    expect(Object.isFrozen(generation.modules)).toBe(true);
  });

  it("requires every read-preview descriptor to be internally reviewed", () => {
    expect(READ_PREVIEW_MODULE_DESCRIPTORS).toHaveLength(6);
    for (const descriptor of READ_PREVIEW_MODULE_DESCRIPTORS) {
      expect(validateModuleDescriptor(descriptor)).toStrictEqual(descriptor);
      expect(descriptor.manifest_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(descriptor.artifact_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
  });

  it("rejects catalog drift instead of accepting a superset", () => {
    expect(() => createReadPreviewCatalogGeneration(
      READ_PREVIEW_MODULE_DESCRIPTORS.slice(0, 5),
    )).toThrow();
    expect(() => createReadPreviewCatalogGeneration(
      READ_PREVIEW_MODULE_DESCRIPTORS,
      [...READ_PREVIEW_RESOURCE_URIS, "logistics://unexpected"],
    )).toThrow();
  });
});
