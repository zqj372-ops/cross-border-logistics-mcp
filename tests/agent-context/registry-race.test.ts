import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const raceState = vi.hoisted(() => ({
  armed: false,
  outsidePath: "",
  pathReads: [] as string[],
  swapped: false,
  targetPath: "",
  trackPathReads: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  const beforePathOperation = (
    candidate: unknown,
    recordStringRead: boolean,
  ): void => {
    if (typeof candidate !== "string") return;
    if (recordStringRead && raceState.trackPathReads) {
      raceState.pathReads.push(candidate);
    }
    if (!raceState.armed || candidate !== raceState.targetPath) return;
    actual.rmSync(raceState.targetPath, { force: true });
    actual.symlinkSync(raceState.outsidePath, raceState.targetPath);
    raceState.armed = false;
    raceState.swapped = true;
  };

  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      beforePathOperation(args[0], false);
      return actual.openSync(...args);
    }) as typeof actual.openSync,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      beforePathOperation(args[0], true);
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

import {
  AgentRegistryError,
  loadAgentProfile,
  loadAgentRegistry,
  loadWorkstreamProjection,
  readRegisteredStandard,
} from "../../src/logistics_mcp/agent-context/registry";
import { validateAgentStandards } from "../../src/logistics_mcp/agent-context/validation";

const rootDir = resolve(import.meta.dirname, "../..");
const physicalTmpDir = realpathSync(tmpdir());

function writeFixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  raceState.armed = false;
  raceState.outsidePath = "";
  raceState.pathReads = [];
  raceState.swapped = false;
  raceState.targetPath = "";
  raceState.trackPathReads = false;
});

describe("Agent registry descriptor-safe reads", () => {
  it("rejects a final file changed to an external symlink after path validation", () => {
    const registry = loadAgentRegistry(rootDir);
    const sandbox = mkdtempSync(resolve(physicalTmpDir, "agent-registry-final-race-"));
    const trustedRoot = resolve(sandbox, "trusted");
    const targetPath = resolve(trustedRoot, "docs/standards/module-runtime-v0.md");
    const outsidePath = resolve(sandbox, "outside/module-runtime-v0.md");
    const canonical = readFileSync(
      resolve(rootDir, "docs/standards/module-runtime-v0.md"),
      "utf8",
    );
    const externalMarker = "EXTERNAL-RACE-CONTENT-MUST-NOT-BE-READ";
    writeFixture(targetPath, canonical);
    writeFixture(outsidePath, `${canonical}\n${externalMarker}\n`);

    raceState.armed = true;
    raceState.outsidePath = outsidePath;
    raceState.targetPath = realpathSync(targetPath);
    let content = "";
    let failure: unknown;
    try {
      content = readRegisteredStandard(
        trustedRoot,
        registry,
        "module-runtime.v0",
      ).content;
    } catch (error: unknown) {
      failure = error;
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }

    expect(raceState.swapped).toBe(true);
    expect(content).not.toContain(externalMarker);
    expect(failure).toBeInstanceOf(AgentRegistryError);
    expect((failure as AgentRegistryError).message).not.toContain(sandbox);
    expect((failure as AgentRegistryError).message).not.toContain(externalMarker);
  });

  it("uses descriptor reads for every registered index, standard, profile and workstream source", () => {
    raceState.trackPathReads = true;
    const registry = loadAgentRegistry(rootDir);
    readRegisteredStandard(rootDir, registry, "module-runtime.v0");
    loadAgentProfile(rootDir, registry, "module-developer");
    loadWorkstreamProjection(rootDir);
    expect(validateAgentStandards(rootDir).failures).toEqual([]);

    const registeredPathReads = raceState.pathReads.filter((path) =>
      path.includes("/docs/agent/") ||
      path.includes("/docs/standards/") ||
      path.includes("/docs/rfcs/"),
    );
    expect(registeredPathReads).toEqual([]);
  });
});
