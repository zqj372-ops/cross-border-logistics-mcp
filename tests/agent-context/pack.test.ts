import { mkdtempSync, readFileSync } from "node:fs";
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

    const outputDir = mkdtempSync(resolve(tmpdir(), "agent-pack-"));
    const outputPath = resolve(outputDir, "agent-standard-pack.json");
    writeAgentStandardPack(rootDir, outputPath);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(first);
  });
});
