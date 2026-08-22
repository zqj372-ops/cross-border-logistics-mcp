import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AgentContextResolutionError,
  resolveAgentContextFromRepository,
  resolveAgentContextFromPack,
  type AgentStandardPack,
} from "../../src/logistics_mcp/agent-context/resolver";
import { buildAgentStandardPack } from "../../src/logistics_mcp/agent-context/pack";

const rootDir = resolve(import.meta.dirname, "../..");

describe("Agent context resolver", () => {
  it("projects a profile and its standards with deterministic rule ordering", () => {
    const result = resolveAgentContextFromRepository({
      rootDir,
      profileId: "module-developer",
      moduleId: "cargo",
    });

    expect(result.status).toBe("success");
    expect(result.profile_id).toBe("module-developer");
    expect(result.standards.length).toBeGreaterThan(0);
    expect(result.rules.map((rule) => rule.priority)).toEqual(
      [...result.rules.map((rule) => rule.priority)].sort((a, b) => b - a),
    );
    expect(result.modules).toEqual(
      expect.arrayContaining([expect.objectContaining({ module_id: "cargo" })]),
    );
    expect(JSON.stringify(result)).not.toMatch(/(?:\/Users\/|-----BEGIN|Bearer\s+[A-Za-z0-9_-]{20,}|sk-|ghp_|AIza)/i);
  });

  it("resolves the accepted control-plane standard only for its developer, reviewer and operator audiences", () => {
    for (const profileId of ["platform-developer", "module-developer", "module-reviewer", "release-operator"] as const) {
      const result = resolveAgentContextFromRepository({ rootDir, profileId });
      const standard = result.standards.find((candidate) => candidate.standard_id === "writable-module-control-plane-v1");

      expect(standard?.standard_id).toBe("writable-module-control-plane-v1");
      expect(standard?.version).toBe("2026-08-22.v1");
      expect(standard?.priority).toBe(85);
      expect(standard?.rule_ids).toEqual(expect.arrayContaining([
        "CONTROL-WRITE-001",
        "CONTROL-AUTH-001",
        "CONTROL-RELEASE-001",
      ]));
      expect(result.rules.map((rule) => rule.rule_id)).toEqual(expect.arrayContaining([
        "CONTROL-WRITE-001",
        "CONTROL-AUTH-001",
        "CONTROL-RELEASE-001",
      ]));
      expect(result.source_refs).toContainEqual(expect.objectContaining({
        source_id: "standard:writable-module-control-plane-v1:2026-08-22.v1",
        version: "2026-08-22.v1",
        locator: "standard:writable-module-control-plane-v1:2026-08-22.v1",
      }));
    }
  });

  it("keeps runtime-caller outside Admin control-plane standards and permissions", () => {
    const result = resolveAgentContextFromRepository({ rootDir, profileId: "runtime-caller" });

    expect(result.standards.some((standard) => standard.standard_id === "writable-module-control-plane-v1")).toBe(false);
    expect(result.rules.some((rule) => rule.rule_id.startsWith("CONTROL-") || rule.standard_id === "writable-module-control-plane-v1")).toBe(false);
    expect(result.source_refs.some((source) => source.source_id === "standard:writable-module-control-plane-v1:2026-08-22.v1")).toBe(false);
    expect(result.modules.map((module) => module.module_id).sort()).toEqual(["cargo", "container"]);
  });

  it("rejects a same-priority conflicting rule instead of guessing", () => {
    const pack = buildAgentStandardPack(rootDir);
    const conflicting: AgentStandardPack = {
      ...pack,
      profiles: pack.profiles.map((profile) =>
        profile.profile_id === "module-developer"
          ? {
              ...profile,
              standard_ids: [...profile.standard_ids, "conflict.standard"],
            }
          : profile,
      ),
      standards: [
        ...pack.standards,
        {
          ...pack.standards[0]!,
          standard_id: "conflict.standard",
          priority: pack.standards[0]!.priority,
          rule_ids: [pack.standards[0]!.rule_ids[0]!],
          sha256: "sha256:conflicting-content",
        },
      ],
    };

    expect(() =>
      resolveAgentContextFromPack(conflicting, {
        profileId: "module-developer",
      }),
    ).toThrow(AgentContextResolutionError);
  });
});
