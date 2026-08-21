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
    expect(JSON.stringify(result)).not.toMatch(/(?:\/Users\/|password|secret|bearer)/i);
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
