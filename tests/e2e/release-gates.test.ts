import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("non-production release gates", () => {
  it("orders candidate build, backup, schemas, tests, digest, staging, status, readback, audit, smoke and approval", () => {
    const release = read("docs/runbooks/release.md");
    const ordered = [
      "candidate build",
      "non-empty backup",
      "Schema",
      "full test",
      "image digest",
      "staging health/readiness",
      "RiskCustoms",
      "write",
      "readback",
      "audit",
      "client smoke",
      "explicit approval",
    ];
    let previous = -1;
    for (const marker of ordered) {
      const index = release.toLowerCase().indexOf(marker.toLowerCase());
      expect(index, `missing release marker: ${marker}`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(release).toMatch(/no automatic.*(?:send|publish|booking)|without automatic.*(?:send|publish|booking)/i);
  });

  it("keeps applied migrations on rollback and records previous image/config", () => {
    const rollback = read("docs/runbooks/rollback.md");
    expect(rollback).toMatch(/applied migration/i);
    expect(rollback).toMatch(/previous.*digest|digest.*previous/i);
    expect(rollback).toMatch(/previous.*config|config.*previous/i);
    expect(rollback).toMatch(/readback|health/i);
  });

  it("runs fixture-only checks without a network command or secret output", () => {
    const script = read("deploy/scripts/check-release.sh");
    expect(script).toMatch(/set -euo pipefail/);
    expect(script).toContain("--fixture-only");
    expect(script).toMatch(/network.*(disabled|not allowed)|no network/i);
    expect(script).not.toMatch(/echo\s+\$[A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD)/i);
    const output = execFileSync("bash", ["deploy/scripts/check-release.sh", "--fixture-only"], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(output).toMatch(/fixture/i);
  });

  it("requires and propagates the quote v2 contract gate", () => {
    const script = read("deploy/scripts/check-release.sh");
    expect(script).toContain("node docs/contracts/quote-v2-contract.test.mjs");
    expect(script).toContain("node docs/contracts/quote-create-pdf-contract.test.mjs");

    const bin = mkdtempSync(join(tmpdir(), "logistics-mcp-release-gate-"));
    const fakeNode = join(bin, "node");
    const realNode = process.execPath.replaceAll("'", "'\\''");
    writeFileSync(fakeNode, `#!/bin/sh
if [ "$1" = "docs/contracts/quote-v2-contract.test.mjs" ]; then
  exit 91
fi
exec '${realNode}' "$@"
`);
    chmodSync(fakeNode, 0o755);

    try {
      const result = spawnSync("bash", ["deploy/scripts/check-release.sh", "--fixture-only"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(91);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("propagates the quote PDF contract gate", () => {
    const bin = mkdtempSync(join(tmpdir(), "logistics-mcp-release-pdf-gate-"));
    const fakeNode = join(bin, "node");
    const realNode = process.execPath.replaceAll("'", "'\\''");
    writeFileSync(fakeNode, `#!/bin/sh
if [ "$1" = "docs/contracts/quote-create-pdf-contract.test.mjs" ]; then
  exit 92
fi
exec '${realNode}' "$@"
`);
    chmodSync(fakeNode, 0o755);

    try {
      const result = spawnSync("bash", ["deploy/scripts/check-release.sh", "--fixture-only"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(92);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
