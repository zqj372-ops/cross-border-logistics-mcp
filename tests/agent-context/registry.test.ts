import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import * as registryModule from "../../src/logistics_mcp/agent-context/registry";
import * as publicAgentContext from "../../src/logistics_mcp/agent-context/index";
import {
  AgentRegistryError,
  loadAgentProfile,
  loadAgentRegistry,
  loadWorkstreamProjection,
  readRegisteredText,
  readRegisteredStandard,
} from "../../src/logistics_mcp/agent-context/registry";

const rootDir = resolve(import.meta.dirname, "../..");
const physicalTmpDir = realpathSync(tmpdir());

function withTemporaryRepository(run: (trustedRoot: string, outsideRoot: string) => void): void {
  const sandbox = mkdtempSync(resolve(physicalTmpDir, "agent-registry-security-"));
  const trustedRoot = resolve(sandbox, "trusted-repository");
  const outsideRoot = resolve(sandbox, "outside");
  mkdirSync(trustedRoot, { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  try {
    run(trustedRoot, outsideRoot);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function writeFixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function expectSymlinkRejection(run: () => unknown, sandboxPath: string): void {
  let error: unknown;
  try {
    run();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AgentRegistryError);
  expect((error as AgentRegistryError).code).toBe("registry.path_symlink");
  expect((error as AgentRegistryError).message).toBe("Registered source path contains a symbolic link.");
  expect((error as AgentRegistryError).message).not.toContain(sandboxPath);
}

function captureRegistryError(run: () => unknown): AgentRegistryError {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AgentRegistryError);
    return error as AgentRegistryError;
  }
  throw new Error("Expected AgentRegistryError.");
}

describe("Agent standard registry", () => {
  it("does not expose a resolved source path as a public registry API", () => {
    expect(registryModule).not.toHaveProperty("resolveRegisteredPath");
  });

  it("keeps low-level readers and pure pack resolvers out of the official barrel", () => {
    expect(publicAgentContext).not.toHaveProperty("readRegisteredBytes");
    expect(publicAgentContext).not.toHaveProperty("readRegisteredText");
    expect(publicAgentContext).not.toHaveProperty("readRegisteredJson");
    expect(publicAgentContext).not.toHaveProperty("resolveAgentContextFromPack");
    expect(publicAgentContext).not.toHaveProperty("readAgentStandardPack");
  });

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
    const unknownProfile = "unknown-profile-sensitive-value";
    const unknownStandard = "unknown-standard-sensitive-value";

    const profileError = captureRegistryError(() =>
      loadAgentProfile(rootDir, registry, unknownProfile),
    );
    const standardError = captureRegistryError(() =>
      readRegisteredStandard(rootDir, registry, unknownStandard),
    );
    expect(profileError.message).not.toContain(unknownProfile);
    expect(standardError.message).not.toContain(unknownStandard);
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

  it("rejects a registered standard file symlink before reading valid external front matter", () => {
    const registry = loadAgentRegistry(rootDir);
    withTemporaryRepository((trustedRoot, outsideRoot) => {
      const outsideStandard = resolve(outsideRoot, "module-runtime-v0.md");
      writeFixture(
        outsideStandard,
        readFileSync(resolve(rootDir, "docs/standards/module-runtime-v0.md"), "utf8"),
      );
      const registeredStandard = resolve(trustedRoot, "docs/standards/module-runtime-v0.md");
      mkdirSync(dirname(registeredStandard), { recursive: true });
      symlinkSync(outsideStandard, registeredStandard);

      expectSymlinkRejection(
        () => readRegisteredStandard(trustedRoot, registry, "module-runtime.v0"),
        trustedRoot,
      );
    });
  });

  it("rejects symlink ancestors for registered profile and workstream JSON", () => {
    const registry = loadAgentRegistry(rootDir);
    withTemporaryRepository((trustedRoot, outsideRoot) => {
      const outsideProfiles = resolve(outsideRoot, "profiles");
      writeFixture(
        resolve(outsideProfiles, "module-developer.json"),
        readFileSync(resolve(rootDir, "docs/agent/profiles/module-developer.json"), "utf8"),
      );
      mkdirSync(resolve(trustedRoot, "docs/agent"), { recursive: true });
      symlinkSync(outsideProfiles, resolve(trustedRoot, "docs/agent/profiles"));

      expectSymlinkRejection(
        () => loadAgentProfile(trustedRoot, registry, "module-developer"),
        trustedRoot,
      );

      const outsideWorkstreams = resolve(outsideRoot, "workstreams");
      writeFixture(
        resolve(outsideWorkstreams, "current.json"),
        readFileSync(resolve(rootDir, "docs/agent/workstreams/current.json"), "utf8"),
      );
      symlinkSync(outsideWorkstreams, resolve(trustedRoot, "docs/agent/workstreams"));

      expectSymlinkRejection(
        () => loadWorkstreamProjection(trustedRoot),
        trustedRoot,
      );
    });
  });

  it("rejects a symlinked registry index and accepts an ordinary regular file", () => {
    withTemporaryRepository((trustedRoot, outsideRoot) => {
      const outsideIndex = resolve(outsideRoot, "index.json");
      writeFixture(outsideIndex, readFileSync(resolve(rootDir, "docs/agent/index.json"), "utf8"));
      const registeredIndex = resolve(trustedRoot, "docs/agent/index.json");
      mkdirSync(dirname(registeredIndex), { recursive: true });
      symlinkSync(outsideIndex, registeredIndex);

      expectSymlinkRejection(() => loadAgentRegistry(trustedRoot), trustedRoot);

      const regularFile = resolve(trustedRoot, "docs/agent/regular.json");
      rmSync(registeredIndex, { force: true });
      writeFixture(regularFile, "{}\n");
      expect(readRegisteredText(trustedRoot, "docs/agent/regular.json")).toBe("{}\n");
    });
  });

  it("rejects a trusted root whose final directory entry is a symlink", () => {
    withTemporaryRepository((trustedRoot) => {
      const regularFile = resolve(trustedRoot, "docs/agent/regular.json");
      const symlinkRoot = resolve(dirname(trustedRoot), "trusted-root-link");
      writeFixture(regularFile, "{}\n");
      symlinkSync(trustedRoot, symlinkRoot);

      const error = captureRegistryError(() =>
        readRegisteredText(symlinkRoot, "docs/agent/regular.json"),
      );
      expect(error.code).toBe("registry.root_symlink");
      expect(error.message).not.toContain(symlinkRoot);
    });
  });

  it("rejects any symlink in the trusted root ancestry", () => {
    const sandbox = mkdtempSync(resolve(physicalTmpDir, "agent-registry-root-ancestor-"));
    const physicalParent = resolve(sandbox, "physical-parent");
    const linkedParent = resolve(sandbox, "linked-parent");
    const physicalRoot = resolve(physicalParent, "trusted-repository");
    const aliasedRoot = resolve(linkedParent, "trusted-repository");
    try {
      writeFixture(resolve(physicalRoot, "docs/agent/regular.json"), "{}\n");
      symlinkSync(physicalParent, linkedParent);

      const error = captureRegistryError(() =>
        readRegisteredText(aliasedRoot, "docs/agent/regular.json"),
      );
      expect(error.code).toBe("registry.root_symlink");
      expect(error.message).not.toContain(linkedParent);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("never returns external content during a bounded final-entry race", async () => {
    const registry = loadAgentRegistry(rootDir);
    const sandbox = mkdtempSync(resolve(physicalTmpDir, "agent-registry-stress-"));
    const trustedRoot = resolve(sandbox, "trusted");
    const targetPath = resolve(trustedRoot, "docs/standards/module-runtime-v0.md");
    const outsidePath = resolve(sandbox, "outside/module-runtime-v0.md");
    const canonical = readFileSync(
      resolve(rootDir, "docs/standards/module-runtime-v0.md"),
      "utf8",
    );
    const externalMarker = "EXTERNAL-STRESS-CONTENT-MUST-NOT-BE-READ";
    writeFixture(targetPath, canonical);
    writeFixture(outsidePath, `${canonical}\n${externalMarker}\n`);
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const state = new Int32Array(shared);
    const worker = new Worker(
      `
        const { workerData } = require("node:worker_threads");
        const fs = require("node:fs");
        const state = new Int32Array(workerData.shared);
        let iteration = 0;
        Atomics.store(state, 0, 1);
        Atomics.notify(state, 0);
        while (Atomics.load(state, 1) === 0 && iteration < 100000) {
          const temporary = workerData.targetPath + ".swap-" + (iteration % 2);
          fs.rmSync(temporary, { force: true });
          if (iteration % 2 === 0) {
            fs.writeFileSync(temporary, workerData.canonical, "utf8");
          } else {
            fs.symlinkSync(workerData.outsidePath, temporary);
          }
          fs.renameSync(temporary, workerData.targetPath);
          iteration += 1;
        }
      `,
      {
        eval: true,
        workerData: { canonical, outsidePath, shared, targetPath },
      },
    );

    let escaped = false;
    try {
      expect(Atomics.wait(state, 0, 0, 5_000)).not.toBe("timed-out");
      for (let iteration = 0; iteration < 2_000; iteration += 1) {
        try {
          const content = readRegisteredStandard(
            trustedRoot,
            registry,
            "module-runtime.v0",
          ).content;
          if (content.includes(externalMarker)) {
            escaped = true;
            break;
          }
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(AgentRegistryError);
        }
      }
    } finally {
      Atomics.store(state, 1, 1);
      await worker.terminate();
      rmSync(sandbox, { recursive: true, force: true });
    }
    expect(escaped).toBe(false);
  }, 15_000);

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

  it("rejects duplicate and unknown front-matter keys consistently with pack validation", () => {
    const registry = loadAgentRegistry(rootDir);
    withTemporaryRepository((trustedRoot) => {
      const sourcePath = resolve(trustedRoot, "docs/standards/module-runtime-v0.md");
      const canonical = readFileSync(
        resolve(rootDir, "docs/standards/module-runtime-v0.md"),
        "utf8",
      );
      const duplicate = canonical.replace(
        "version: 2026-08-21.v0",
        "version: 2026-08-21.v0\nversion: duplicate",
      );
      writeFixture(sourcePath, duplicate);
      expect(() => readRegisteredStandard(trustedRoot, registry, "module-runtime.v0")).toThrow(
        AgentRegistryError,
      );

      const unknown = canonical.replace(
        "priority: 80",
        "unexpected: field\npriority: 80",
      );
      writeFixture(sourcePath, unknown);
      expect(() => readRegisteredStandard(trustedRoot, registry, "module-runtime.v0")).toThrow(
        AgentRegistryError,
      );
    });
  });

  it("rejects unsafe repository-relative workstream paths at the registry boundary", () => {
    const canonical = JSON.parse(
      readFileSync(resolve(rootDir, "docs/agent/workstreams/current.json"), "utf8"),
    ) as {
      readonly $schema: string;
      readonly schema_version: string;
      readonly workstreams: readonly {
        readonly workstream_id: string;
        readonly owner: string;
        readonly writable_paths: readonly string[];
        readonly primary_delivery: string;
      }[];
      readonly escalation: string;
    };
    for (const unsafePath of [
      "tmp/generated/pack.json",
      "docs/temp/pack.json",
      "var/tmp/pack.json",
      "C:relative/pack.json",
      "~/private/pack.json",
      "https://example.invalid/pack.json",
      "./relative/pack.json",
      "../outside/pack.json",
    ]) {
      withTemporaryRepository((trustedRoot) => {
        const projection = {
          ...canonical,
          workstreams: canonical.workstreams.map((workstream, index) =>
            index === 0
              ? { ...workstream, writable_paths: [unsafePath] }
              : workstream,
          ),
        };
        writeFixture(
          resolve(trustedRoot, "docs/agent/workstreams/current.json"),
          JSON.stringify(projection),
        );
        expect(() => loadWorkstreamProjection(trustedRoot)).toThrow(AgentRegistryError);
      });
    }
  });

  it("mirrors the current AGENTS ownership boundaries in workstream context", () => {
    const projection = loadWorkstreamProjection(rootDir);
    const workstream = (workstreamId: string) => projection.workstreams.find((item) => item.workstream_id === workstreamId);
    const agentsTask02 = readFileSync(resolve(rootDir, "AGENTS.md"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| 02 平台 |"));
    const documentedTask02Paths = [...(agentsTask02?.matchAll(/`([^`]+)`/g) ?? [])]
      .map((match) => match[1]);
    const machineTask02Paths = workstream("02-platform")?.writable_paths ?? [];

    expect(workstream("01-baseline")?.writable_paths).toContain("schemas/admin-control/**");
    expect(documentedTask02Paths).toEqual(machineTask02Paths);
    expect(machineTask02Paths).toEqual([
      "src/logistics_mcp/platform/**",
      "src/logistics_mcp/server/**",
      "src/logistics_mcp/control-plane/**",
      "src/logistics_mcp/module-runtime/**",
      "src/logistics_mcp/agent-context/**",
      "tests/platform/**",
      "tests/control-plane/**",
      "tests/module-runtime/**",
      "tests/agent-context/**",
    ]);
    expect(workstream("06-integration")?.writable_paths).toContain("apps/admin/**");
    expect(projection.escalation).toContain("dated RFC");
    expect(projection.escalation).toContain("baseline maintainer acceptance");
  });
});
