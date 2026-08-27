import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import * as packValidationModule from "../../src/logistics_mcp/agent-context/pack-validation";
import {
  buildAgentStandardPack,
  isRuntimeTrustedAgentStandardPack,
  readAgentStandardPack,
  serializeAgentStandardPack,
  writeAgentStandardPack,
} from "../../src/logistics_mcp/agent-context/pack";
import { validateAndFreezeAgentStandardPack } from "../../src/logistics_mcp/agent-context/pack-validation";
import { CANONICAL_AGENT_RESOURCES } from "../../src/logistics_mcp/agent-context/resources";
import type { AgentStandardPack } from "../../src/logistics_mcp/agent-context/types";
import { findAgentArtifactSafetyIssues } from "./safety-assertions";

const rootDir = resolve(import.meta.dirname, "../..");
const physicalTmpDir = realpathSync(tmpdir());

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function mutableClone<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value).every((key) =>
    isDeepFrozen(Reflect.get(value, key), seen),
  );
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function acceptedNonCallerExtension(): DeepMutable<AgentStandardPack> {
  const extended = mutableClone(buildAgentStandardPack(rootDir));
  const standardId = "future.accepted-standard";
  const version = "2026-08-24.v1";
  const ruleId = "FUTURE-ACCEPTED-001";
  const content = [
    "---",
    `standard_id: ${standardId}`,
    `version: ${version}`,
    "priority: 75",
    "audience: developer,reviewer,operator",
    "status: accepted",
    `rule_ids: ${ruleId}`,
    "---",
    "",
    "# Future accepted standard",
    "",
  ].join("\n");
  extended.standards.push({
    standard_id: standardId,
    version,
    priority: 75,
    audiences: ["developer", "reviewer", "operator"],
    rule_ids: [ruleId],
    summary: "A future accepted standard used to prove count-independent validation.",
    sha256: sha256(content),
    source_ref: `standard:${standardId}:${version}`,
    content,
  });
  const developer = extended.profiles.find(
    (profile) => profile.profile_id === "platform-developer",
  );
  if (developer === undefined) throw new Error("Expected platform developer fixture.");
  developer.standard_ids.push(standardId);
  developer.allowed_rule_ids.push(ruleId);
  return extended;
}

async function readFixedPackFromLayoutClone(
  serializedPack: string,
  adjacentManifest?: string,
): Promise<AgentStandardPack> {
  const cloneRoot = mkdtempSync(resolve(rootDir, ".agent-fixed-pack-layout-"));
  try {
    const sourceParent = resolve(cloneRoot, "src/logistics_mcp");
    mkdirSync(sourceParent, { recursive: true });
    cpSync(
      resolve(rootDir, "src/logistics_mcp/agent-context"),
      resolve(sourceParent, "agent-context"),
      { recursive: true },
    );
    const standardsDir = resolve(cloneRoot, "dist/standards");
    mkdirSync(standardsDir, { recursive: true });
    writeFileSync(
      resolve(standardsDir, "agent-standard-pack.json"),
      serializedPack,
      "utf8",
    );
    if (adjacentManifest !== undefined) {
      writeFileSync(
        resolve(standardsDir, "agent-standard-pack.manifest.json"),
        adjacentManifest,
        "utf8",
      );
    }
    const imported = await import(
      pathToFileURL(resolve(sourceParent, "agent-context/pack.ts")).href
    ) as unknown as {
      readonly readFixedAgentStandardPack: () => AgentStandardPack;
    };
    return imported.readFixedAgentStandardPack();
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
  }
}

function withModifiedStandardsRoot(run: (modifiedRoot: string) => void): void {
  const modifiedRoot = mkdtempSync(resolve(physicalTmpDir, "agent-reviewed-pack-root-"));
  try {
    cpSync(resolve(rootDir, "docs"), resolve(modifiedRoot, "docs"), {
      recursive: true,
    });
    const changedStandard = resolve(
      modifiedRoot,
      "docs/standards/agent-bootstrap.md",
    );
    writeFileSync(
      changedStandard,
      `${readFileSync(changedStandard, "utf8")}\nReviewed descriptor mismatch fixture.\n`,
      "utf8",
    );
    run(modifiedRoot);
  } finally {
    rmSync(modifiedRoot, { recursive: true, force: true });
  }
}

describe("Agent standard pack", () => {
  it("does not mark a developer-built pack as runtime trusted", () => {
    expect(isRuntimeTrustedAgentStandardPack(buildAgentStandardPack(rootDir))).toBe(false);
  });

  it("pins the current thirteen-standard build to the reviewed serialized-byte digest", () => {
    const pack = buildAgentStandardPack(rootDir);
    const serialized = serializeAgentStandardPack(pack);

    expect(pack.standards).toHaveLength(13);
    expect(Buffer.byteLength(serialized, "utf8")).toBe(138_416);
    expect(sha256(serialized)).toBe(
      "sha256:6e18315d97cfcf2f5b81b1b8e68d3b1e1c4d3bc651f3f18c00e9bc026bcef264",
    );
  });

  it("rejects a stale but schema-valid fixed-layout pack", async () => {
    const currentBytes = serializeAgentStandardPack(buildAgentStandardPack(rootDir));
    const staleBytes = currentBytes.endsWith("\n")
      ? currentBytes.slice(0, -1)
      : `${currentBytes} `;

    await expect(readFixedPackFromLayoutClone(staleBytes)).rejects.toThrow(
      /reviewed Agent Standard Pack descriptor/i,
    );
  });

  it("rejects a self-consistent non-caller extension even with a forged adjacent manifest", async () => {
    const extendedBytes = serializeAgentStandardPack(acceptedNonCallerExtension());
    const forgedManifest = `${JSON.stringify({
      format: "serializeAgentStandardPack:utf8-json-pretty-lf:v1",
      registry_id: "logistics-mcp.agent-standards",
      pack_schema_version: "2026-08-21.v1",
      serialized_sha256: sha256(extendedBytes),
    }, null, 2)}\n`;

    await expect(
      readFixedPackFromLayoutClone(extendedBytes, forgedManifest),
    ).rejects.toThrow(/reviewed Agent Standard Pack descriptor/i);
  });

  it("fails closed when building or writing valid unreviewed source bytes", () => {
    withModifiedStandardsRoot((modifiedRoot) => {
      expect(() => buildAgentStandardPack(modifiedRoot)).toThrow(
        /reviewed Agent Standard Pack descriptor/i,
      );
      expect(() => writeAgentStandardPack(
        modifiedRoot,
        resolve(modifiedRoot, "dist/standards/agent-standard-pack.json"),
      )).toThrow(/reviewed Agent Standard Pack descriptor/i);
    });
  });

  it("does not export a runtime-brand constructor from the validation module", () => {
    const exportedNames = Object.keys(packValidationModule);
    expect(
      exportedNames.filter((name) => /(?:seal|runtimeTrusted|brand)/iu.test(name)),
    ).toEqual([]);
  });

  it("is deterministic and contains only registered source references", () => {
    const first = buildAgentStandardPack(rootDir);
    const second = buildAgentStandardPack(rootDir);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(isDeepFrozen(first)).toBe(true);
    expect(first.pack_schema_version).toBe("2026-08-21.v1");
    expect(first.standards.every((standard) => standard.sha256.startsWith("sha256:"))).toBe(true);
    expect(findAgentArtifactSafetyIssues(first)).toEqual([]);
    expect(first.standards.map((standard) => standard.standard_id)).toEqual([
      "active-workstreams",
      "admin-control-state-dto-v1",
      "agent-access.v0",
      "agent.bootstrap",
      "credential-exchange-v1",
      "effective-rfc",
      "implementation-plan",
      "module-runtime.v0",
      "platform.contracts",
      "readback-attempt-finalization-v1",
      "release-agent-adapters",
      "t0-production-profile-v1",
      "writable-module-control-plane-v1",
    ]);

    const controlPlane = first.standards.find((standard) => standard.standard_id === "writable-module-control-plane-v1");
    expect(controlPlane).toBeDefined();
    expect(controlPlane?.source_ref).toBe("standard:writable-module-control-plane-v1:2026-08-22.v1");
    expect(controlPlane?.content).toBe(readFileSync(resolve(rootDir, "docs/rfcs/2026-08-22-writable-module-control-plane-v1.md"), "utf8"));
    expect(controlPlane?.sha256).toBe(
      `sha256:${createHash("sha256").update(controlPlane?.content ?? "", "utf8").digest("hex")}`,
    );
    const adminControlState = first.standards.find(
      (standard) => standard.standard_id === "admin-control-state-dto-v1",
    );
    expect(adminControlState).toEqual({
      standard_id: "admin-control-state-dto-v1",
      version: "2026-08-22.v1",
      priority: 86,
      audiences: ["developer", "operator", "reviewer"],
      rule_ids: ["CONTROL-STATE-001", "CONTROL-STATE-002", "CONTROL-STATE-003"],
      summary:
        "Accepted closed, bounded and redacted Admin control-state DTO plus fail-closed producer semantics; contract access grants no Admin write permission or production readiness.",
      sha256:
        "sha256:42b97c0c87ac4ab2afe4b8c39d910645daa01cc7b50be240806aaa724216c051",
      source_ref: "standard:admin-control-state-dto-v1:2026-08-22.v1",
      content: readFileSync(
        resolve(rootDir, "docs/rfcs/2026-08-22-admin-control-state-dto-v1.md"),
        "utf8",
      ),
    });
    expect(first.modules.map((module) => module.module_id).sort()).toEqual([
      "agent-access",
      "cargo",
      "container",
      "freightcom-ltl",
    ]);

    const outputDir = mkdtempSync(resolve(physicalTmpDir, "agent-pack-"));
    const outputPath = resolve(outputDir, "agent-standard-pack.json");
    try {
      writeAgentStandardPack(rootDir, outputPath);
      const generated = JSON.parse(readFileSync(outputPath, "utf8")) as unknown;
      expect(generated).toEqual(first);
      expect(findAgentArtifactSafetyIssues(generated)).toEqual([]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("strictly validates serialized packs and rejects self-consistent runtime-caller broadening", () => {
    const valid = buildAgentStandardPack(rootDir);
    const variants: DeepMutable<AgentStandardPack>[] = [];

    const extraRootKey = mutableClone(valid) as DeepMutable<AgentStandardPack> & {
      unexpected?: string;
    };
    extraRootKey.unexpected = "closed-schema-violation";
    variants.push(extraRootKey);

    const extraStandardKey = mutableClone(valid);
    const firstStandard = extraStandardKey.standards[0] as
      | (DeepMutable<AgentStandardPack["standards"][number]> & { path?: string })
      | undefined;
    if (firstStandard === undefined) throw new Error("Expected a standard fixture.");
    firstStandard.path = "docs/unregistered.md";
    variants.push(extraStandardKey);

    const badDigest = mutableClone(valid);
    badDigest.standards[0]!.sha256 = `sha256:${"0".repeat(64)}`;
    variants.push(badDigest);

    const badSourceRef = mutableClone(valid);
    badSourceRef.standards[0]!.source_ref = "standard:forged:version";
    variants.push(badSourceRef);

    const badFrontMatter = mutableClone(valid);
    const frontMatterStandard = badFrontMatter.standards[0]!;
    frontMatterStandard.content = frontMatterStandard.content.replace(
      `standard_id: ${frontMatterStandard.standard_id}`,
      "standard_id: forged-front-matter",
    );
    frontMatterStandard.sha256 = sha256(frontMatterStandard.content);
    variants.push(badFrontMatter);

    const brokenReference = mutableClone(valid);
    brokenReference.modules[0]!.standard_ids.push("missing.standard");
    variants.push(brokenReference);

    const duplicateProfile = mutableClone(valid);
    duplicateProfile.profiles.push(mutableClone(duplicateProfile.profiles[0]!));
    variants.push(duplicateProfile);

    const broadenedRuntimeCaller = mutableClone(valid);
    const runtimeCaller = broadenedRuntimeCaller.profiles.find(
      (profile) => profile.profile_id === "runtime-caller",
    );
    const controlStateStandard = broadenedRuntimeCaller.standards.find(
      (standard) => standard.standard_id === "admin-control-state-dto-v1",
    );
    if (runtimeCaller === undefined || controlStateStandard === undefined) {
      throw new Error("Expected runtime-caller and Admin control-state standard fixtures.");
    }
    runtimeCaller.standard_ids.push(controlStateStandard.standard_id);
    runtimeCaller.allowed_rule_ids.push(...controlStateStandard.rule_ids);
    variants.push(broadenedRuntimeCaller);

    const broadenedRuntimeModule = mutableClone(valid);
    const cargoModule = broadenedRuntimeModule.modules.find(
      (module) => module.module_id === "cargo",
    );
    if (cargoModule === undefined) throw new Error("Expected cargo module fixture.");
    cargoModule.tool_names.push("admin.control");
    cargoModule.standard_ids.push("writable-module-control-plane-v1");
    variants.push(broadenedRuntimeModule);

    const outputDir = mkdtempSync(resolve(physicalTmpDir, "agent-pack-validation-"));
    try {
      variants.forEach((variant, index) => {
        const path = resolve(outputDir, `invalid-${index}.json`);
        writeFileSync(path, JSON.stringify(variant), "utf8");
        expect(() => readAgentStandardPack(path)).toThrow();
      });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps the runtime caller entitlement to the three T0 modules", () => {
    const valid = buildAgentStandardPack(rootDir);
    expect(valid.modules.find((module) => module.module_id === "freightcom-ltl")).toEqual({
      module_id: "freightcom-ltl",
      version: "2026-08-26.v1",
      risk_level: "T1",
      standard_ids: ["module-runtime.v0", "platform.contracts"],
      tool_names: ["quote.freightcom_ltl.preview"],
    });
    expect([...(valid.profiles.find((profile) => profile.profile_id === "runtime-caller")?.allowed_module_ids ?? [])].sort()).toEqual([
      "agent-access",
      "cargo",
      "container",
    ]);

    const broadened = mutableClone(valid);
    const runtimeCaller = broadened.profiles.find(
      (profile) => profile.profile_id === "runtime-caller",
    );
    if (runtimeCaller === undefined) throw new Error("Expected runtime-caller fixture.");
    runtimeCaller.allowed_module_ids.push("freightcom-ltl");

    expect(() => validateAndFreezeAgentStandardPack(broadened)).toThrowError(
      expect.objectContaining({
        code: "pack.runtime_caller_entitlement_mismatch",
      }),
    );
  });

  it("enforces canonical resources, relative workstream paths, and production safety scanning", () => {
    expect(Object.isFrozen(CANONICAL_AGENT_RESOURCES)).toBe(true);
    expect(CANONICAL_AGENT_RESOURCES.every((resource) => Object.isFrozen(resource))).toBe(true);
    expect(
      CANONICAL_AGENT_RESOURCES.every((resource) =>
        Object.isFrozen(resource.standard_ids),
      ),
    ).toBe(true);

    const valid = buildAgentStandardPack(rootDir);
    const variants: DeepMutable<AgentStandardPack>[] = [];

    const badResource = mutableClone(valid);
    badResource.resources.find((resource) => resource.resource_id === "agent.bootstrap")!.uri =
      "logistics://untrusted/bootstrap";
    variants.push(badResource);

    for (const unsafePath of [
      "../outside",
      "/absolute/path",
      "/var/folders/ab/cd/T/pack.json",
      "tmp/generated/pack.json",
      "docs/temp/pack.json",
      "var/tmp/pack.json",
      "C:relative/pack.json",
      "C:/absolute/pack.json",
      "~/private/pack.json",
      "https://example.invalid/pack.json",
      "./relative/pack.json",
    ]) {
      const badPath = mutableClone(valid);
      badPath.workstreams.workstreams[0]!.writable_paths[0] = unsafePath;
      variants.push(badPath);
    }

    const legalGeneratedName = mutableClone(valid);
    legalGeneratedName.workstreams.workstreams[0]!.writable_paths[0] =
      "docs/generated-artifacts/**";
    expect(() => validateAndFreezeAgentStandardPack(legalGeneratedName)).not.toThrow();

    const legalTemporaryName = mutableClone(valid);
    legalTemporaryName.workstreams.workstreams[0]!.writable_paths[0] =
      "docs/temporary-notes/**";
    expect(() => validateAndFreezeAgentStandardPack(legalTemporaryName)).not.toThrow();

    const unsafeContent = mutableClone(valid);
    const firstStandard = unsafeContent.standards[0]!;
    firstStandard.content += "\nAuthorization: Bearer live-0123456789abcdef\n";
    firstStandard.sha256 = sha256(firstStandard.content);
    variants.push(unsafeContent);

    for (const [index, variant] of variants.entries()) {
      expect(() => validateAndFreezeAgentStandardPack(variant), `variant ${index}`).toThrow();
    }
  });

  it("rejects unsafe object graphs before serialization or safety scanning", () => {
    const valid = buildAgentStandardPack(rootDir);
    const proxied = new Proxy(valid, {
      get() {
        throw new Error("pack getter trap must not run");
      },
      ownKeys() {
        throw new Error("pack ownKeys trap must not run");
      },
    });
    const accessor = mutableClone(valid);
    Object.defineProperty(accessor, "standards", {
      configurable: true,
      get() {
        throw new Error("pack accessor must not run");
      },
    });
    const customPrototype = mutableClone(valid);
    Object.setPrototypeOf(customPrototype, { forged: true });
    const cyclic = mutableClone(valid) as DeepMutable<AgentStandardPack> & {
      cycle?: unknown;
    };
    cyclic.cycle = cyclic;

    for (const unsafe of [proxied, accessor, customPrototype, cyclic]) {
      expect(() => serializeAgentStandardPack(unsafe)).toThrow(
        "Agent Standard Pack failed closed validation.",
      );
      expect(() => findAgentArtifactSafetyIssues(unsafe)).toThrow(
        "Agent artifact input is invalid.",
      );
    }
  });

  it("reads a valid arbitrary pack as frozen validation data but rejects a symlink source", () => {
    const valid = buildAgentStandardPack(rootDir);
    const outputDir = mkdtempSync(resolve(physicalTmpDir, "agent-pack-read-"));
    const regularPath = resolve(outputDir, "agent-standard-pack.json");
    const symlinkPath = resolve(outputDir, "agent-standard-pack-link.json");
    try {
      writeFileSync(regularPath, serializeAgentStandardPack(valid), "utf8");
      const readPack = readAgentStandardPack(regularPath);
      expect(readPack).toEqual(valid);
      expect(isDeepFrozen(readPack)).toBe(true);

      symlinkSync(regularPath, symlinkPath);
      expect(() => readAgentStandardPack(symlinkPath)).toThrow();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("accepts an additional valid non-caller standard without pinning pack count or digest", () => {
    const extended = mutableClone(buildAgentStandardPack(rootDir));
    const standardId = "future.accepted-standard";
    const version = "2026-08-24.v1";
    const ruleId = "FUTURE-ACCEPTED-001";
    const content = [
      "---",
      `standard_id: ${standardId}`,
      `version: ${version}`,
      "priority: 75",
      "audience: developer,reviewer,operator",
      "status: accepted",
      `rule_ids: ${ruleId}`,
      "---",
      "",
      "# Future accepted standard",
      "",
    ].join("\n");
    extended.standards.push({
      standard_id: standardId,
      version,
      priority: 75,
      audiences: ["developer", "reviewer", "operator"],
      rule_ids: [ruleId],
      summary: "A future accepted standard used to prove count-independent validation.",
      sha256: sha256(content),
      source_ref: `standard:${standardId}:${version}`,
      content,
    });
    const developer = extended.profiles.find(
      (profile) => profile.profile_id === "platform-developer",
    );
    if (developer === undefined) throw new Error("Expected platform developer fixture.");
    developer.standard_ids.push(standardId);
    developer.allowed_rule_ids.push(ruleId);

    const outputDir = mkdtempSync(resolve(physicalTmpDir, "agent-pack-future-standard-"));
    const acceptedPath = resolve(outputDir, "accepted.json");
    const draftPath = resolve(outputDir, "draft.json");
    try {
      writeFileSync(acceptedPath, JSON.stringify(extended), "utf8");
      const accepted = readAgentStandardPack(acceptedPath);
      expect(accepted.standards).toHaveLength(
        buildAgentStandardPack(rootDir).standards.length + 1,
      );

      const draft = mutableClone(extended);
      const draftStandard = draft.standards.find(
        (standard) => standard.standard_id === standardId,
      );
      if (draftStandard === undefined) throw new Error("Expected future standard fixture.");
      draftStandard.content = draftStandard.content.replace(
        "status: accepted",
        "status: draft",
      );
      draftStandard.sha256 = sha256(draftStandard.content);
      writeFileSync(draftPath, JSON.stringify(draft), "utf8");
      expect(() => readAgentStandardPack(draftPath)).toThrow();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
