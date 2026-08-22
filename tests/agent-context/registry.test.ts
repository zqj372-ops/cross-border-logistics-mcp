import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AgentRegistryError,
  loadAgentProfile,
  loadAgentRegistry,
  loadWorkstreamProjection,
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

  it("registers the accepted writable control-plane RFC without expanding MCP modules or resources", () => {
    const registry = loadAgentRegistry(rootDir);
    const standard = readRegisteredStandard(rootDir, registry, "writable-module-control-plane-v1");
    expect(registry.standards.find((candidate) => candidate.standard_id === standard.standard_id)).toEqual({
      standard_id: "writable-module-control-plane-v1",
      version: "2026-08-22.v1",
      path: "docs/rfcs/2026-08-22-writable-module-control-plane-v1.md",
      priority: 85,
      audiences: ["developer", "reviewer", "operator"],
      rule_ids: ["CONTROL-WRITE-001", "CONTROL-AUTH-001", "CONTROL-RELEASE-001"],
      summary: "Accepted local/fixture module-control rules for static mounted modules; profiles provide standard content only, not HTTP permissions; production Admin POST remains blocked.",
    });

    expect(standard.front_matter).toEqual({
      standard_id: "writable-module-control-plane-v1",
      version: "2026-08-22.v1",
      priority: 85,
      audiences: ["developer", "reviewer", "operator"],
      rule_ids: ["CONTROL-WRITE-001", "CONTROL-AUTH-001", "CONTROL-RELEASE-001"],
    });
    expect(registry.standards.some((candidate) => candidate.standard_id === "admin-control-state-dto-v1")).toBe(false);
    expect(registry.standards.some((candidate) => candidate.path === "docs/superpowers/plans/2026-08-22-writable-mcp-control-plane-plan.md")).toBe(false);
    expect(registry.modules.map((module) => module.module_id).sort()).toEqual([
      "agent-access",
      "cargo",
      "container",
    ]);
    expect(registry.resources.map((resource) => resource.resource_id).sort()).toEqual([
      "agent.bootstrap",
      "agent.profiles",
      "contracts.envelope.current",
      "modules.catalog",
      "standards.index",
    ]);
    expect(registry.modules.flatMap((module) => module.tool_names)).not.toContain("admin.api");
  });

  it("mirrors the current AGENTS ownership boundaries in workstream context", () => {
    const projection = loadWorkstreamProjection(rootDir);
    const workstream = (workstreamId: string) => projection.workstreams.find((item) => item.workstream_id === workstreamId);

    expect(workstream("01-baseline")?.writable_paths).toContain("schemas/admin-control/**");
    expect(workstream("02-platform")?.writable_paths).toEqual(
      expect.arrayContaining(["src/logistics_mcp/control-plane/**", "tests/control-plane/**"]),
    );
    expect(workstream("06-integration")?.writable_paths).toContain("apps/admin/**");
    expect(projection.escalation).toContain("dated RFC");
    expect(projection.escalation).toContain("baseline maintainer acceptance");
  });
});
