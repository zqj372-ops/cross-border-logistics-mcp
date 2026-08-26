import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AgentContextResolutionError,
  resolveAgentContextFromRepository,
  resolveAgentContextFromPack,
  type AgentStandardPack,
} from "../../src/logistics_mcp/agent-context/resolver";
import { buildAgentStandardPack } from "../../src/logistics_mcp/agent-context/pack";
import { findAgentArtifactSafetyIssues } from "./safety-assertions";

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function mutableClone<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

const rootDir = resolve(import.meta.dirname, "../..");
const adminControlStateStandardId = "admin-control-state-dto-v1";
const adminControlStateVersion = "2026-08-22.v1";
const adminControlStatePriority = 86;
const adminControlStateRuleIds = [
  "CONTROL-STATE-001",
  "CONTROL-STATE-002",
  "CONTROL-STATE-003",
] as const;
const adminControlStateSourceRef =
  "standard:admin-control-state-dto-v1:2026-08-22.v1";
const adminControlStateProfiles = [
  "module-developer",
  "platform-developer",
  "module-reviewer",
  "release-operator",
] as const;

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
    expect(findAgentArtifactSafetyIssues(result)).toEqual([]);
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

  it.each(adminControlStateProfiles)(
    "resolves the Admin control-state DTO exactly for %s",
    (profileId) => {
      const result = resolveAgentContextFromRepository({ rootDir, profileId });
      const standard = result.standards.find(
        (candidate) => candidate.standard_id === adminControlStateStandardId,
      );

      expect(result.standards.filter(
        (candidate) => candidate.standard_id === adminControlStateStandardId,
      )).toHaveLength(1);
      expect(standard).toBeDefined();
      if (standard === undefined) throw new Error("Expected Admin control-state standard.");
      expect(standard.version).toBe(adminControlStateVersion);
      expect(standard.priority).toBe(adminControlStatePriority);
      expect(standard.rule_ids).toEqual([...adminControlStateRuleIds]);

      expect(result.rules.filter(
        (rule) => rule.standard_id === adminControlStateStandardId,
      )).toEqual(adminControlStateRuleIds.map((ruleId) => ({
        rule_id: ruleId,
        standard_id: adminControlStateStandardId,
        priority: adminControlStatePriority,
        source_sha256: standard.sha256,
      })));

      expect(result.source_refs.filter(
        (source) => source.source_id === adminControlStateSourceRef,
      )).toEqual([{
        source_id: adminControlStateSourceRef,
        version: adminControlStateVersion,
        content_hash: standard.sha256,
        locator: adminControlStateSourceRef,
      }]);
    },
  );

  it("keeps runtime-caller outside Admin control-plane standards and permissions", () => {
    const result = resolveAgentContextFromRepository({ rootDir, profileId: "runtime-caller" });

    expect(result.standards.some((standard) => standard.standard_id === "writable-module-control-plane-v1")).toBe(false);
    expect(result.standards.some((standard) => standard.standard_id === adminControlStateStandardId)).toBe(false);
    expect(result.rules.some((rule) => rule.rule_id.startsWith("CONTROL-") || rule.standard_id === "writable-module-control-plane-v1")).toBe(false);
    for (const ruleId of adminControlStateRuleIds) {
      expect(result.rules.some((rule) => rule.rule_id === ruleId)).toBe(false);
    }
    expect(result.source_refs.some((source) => source.source_id === "standard:writable-module-control-plane-v1:2026-08-22.v1")).toBe(false);
    expect(result.source_refs.some((source) => source.source_id === adminControlStateSourceRef)).toBe(false);
    expect(result.modules.map((module) => module.module_id).sort()).toEqual([
      "cargo",
      "container",
      "freightcom-ltl",
    ]);
  });

  it("rejects a forged broadened pack before it can project control-plane rules", () => {
    const broadened = mutableClone(buildAgentStandardPack(rootDir));
    const runtimeCaller = broadened.profiles.find(
      (profile) => profile.profile_id === "runtime-caller",
    );
    const controlStandard = broadened.standards.find(
      (standard) => standard.standard_id === adminControlStateStandardId,
    );
    if (runtimeCaller === undefined || controlStandard === undefined) {
      throw new Error("Expected runtime-caller and control standard fixtures.");
    }
    runtimeCaller.standard_ids.push(controlStandard.standard_id);
    runtimeCaller.allowed_rule_ids.push(...controlStandard.rule_ids);

    let error: unknown;
    try {
      resolveAgentContextFromPack(broadened, { profileId: "runtime-caller" });
    } catch (candidate: unknown) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(AgentContextResolutionError);
    expect((error as AgentContextResolutionError).code).toBe("pack_invalid");
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

  it("does not reflect unknown profile or standard identifiers in errors", () => {
    const pack = buildAgentStandardPack(rootDir);
    const unknownProfile = "unknown-profile-sensitive-value";
    let profileError: unknown;
    try {
      resolveAgentContextFromPack(pack, { profileId: unknownProfile });
    } catch (error: unknown) {
      profileError = error;
    }
    expect(profileError).toBeInstanceOf(AgentContextResolutionError);
    expect((profileError as AgentContextResolutionError).message).not.toContain(
      unknownProfile,
    );

    const unknownStandard = "unknown-standard-sensitive-value";
    const malformed: AgentStandardPack = {
      ...pack,
      profiles: pack.profiles.map((profile) =>
        profile.profile_id === "module-developer"
          ? { ...profile, standard_ids: [unknownStandard] }
          : profile,
      ),
    };
    let standardError: unknown;
    try {
      resolveAgentContextFromPack(malformed, { profileId: "module-developer" });
    } catch (error: unknown) {
      standardError = error;
    }
    expect(standardError).toBeInstanceOf(AgentContextResolutionError);
    expect((standardError as AgentContextResolutionError).message).not.toContain(
      unknownStandard,
    );
  });
});
