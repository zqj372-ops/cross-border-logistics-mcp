import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AgentRegistryError,
  loadAgentProfile,
  loadAgentRegistry,
  readRegisteredStandard,
} from "../../src/logistics_mcp/agent-context/registry";

const rootDir = resolve(import.meta.dirname, "../..");

describe("Agent standard registry", () => {
  it("loads the canonical registry and profiles without exposing absolute paths", () => {
    const registry = loadAgentRegistry(rootDir);
    const profile = loadAgentProfile(rootDir, registry, "module-developer");
    const standard = readRegisteredStandard(rootDir, registry, "module-runtime.v0");

    expect(registry.schema_version).toBe("2026-08-21.v1");
    expect(profile.profile_id).toBe("module-developer");
    expect(standard.standard_id).toBe("module-runtime.v0");
    expect(standard.path.startsWith("/")).toBe(false);
    expect(JSON.stringify({ registry, profile, standard })).not.toContain(rootDir);
  });

  it("fails closed for unknown profile, standard and path escape", () => {
    const registry = loadAgentRegistry(rootDir);

    expect(() => loadAgentProfile(rootDir, registry, "not-a-profile")).toThrow(
      AgentRegistryError,
    );
    expect(() => readRegisteredStandard(rootDir, registry, "not-a-standard")).toThrow(
      AgentRegistryError,
    );
    expect(() =>
      readRegisteredStandard(rootDir, {
        ...registry,
        standards: [
          {
            ...registry.standards[0]!,
            path: "../outside.md",
          },
        ],
      }, registry.standards[0]!.standard_id),
    ).toThrow(AgentRegistryError);
  });
});
