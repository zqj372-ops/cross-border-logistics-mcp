import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAgentStandardPack,
  writeAgentStandardPack,
} from "../../src/logistics_mcp/agent-context/pack";

const rootDir = resolve(import.meta.dirname, "../..");

describe("Agent standard pack", () => {
  it("is deterministic and contains only registered source references", () => {
    const first = buildAgentStandardPack(rootDir);
    const second = buildAgentStandardPack(rootDir);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.pack_schema_version).toBe("2026-08-21.v1");
    expect(first.standards.every((standard) => standard.sha256.startsWith("sha256:"))).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/(?:\/Users\/|-----BEGIN|Bearer\s+)/i);

    const controlPlane = first.standards.find((standard) => standard.standard_id === "writable-module-control-plane-v1");
    expect(controlPlane).toBeDefined();
    expect(controlPlane?.source_ref).toBe("standard:writable-module-control-plane-v1:2026-08-22.v1");
    expect(controlPlane?.content).toBe(readFileSync(resolve(rootDir, "docs/rfcs/2026-08-22-writable-module-control-plane-v1.md"), "utf8"));
    expect(controlPlane?.sha256).toBe(
      `sha256:${createHash("sha256").update(controlPlane?.content ?? "", "utf8").digest("hex")}`,
    );
    expect(JSON.stringify(first)).not.toContain("admin-control-state-dto-v1");
    expect(first.modules.map((module) => module.module_id).sort()).toEqual(["agent-access", "cargo", "container"]);

    const outputDir = mkdtempSync(resolve(tmpdir(), "agent-pack-"));
    const outputPath = resolve(outputDir, "agent-standard-pack.json");
    writeAgentStandardPack(rootDir, outputPath);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(first);
  });
});
