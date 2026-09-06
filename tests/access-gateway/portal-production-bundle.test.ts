import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("production Portal bundle entrypoint", () => {
  it("versions each cached console asset from its final content without changing source HTML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "portal-assets-"));
    directories.push(directory);
    const sourceHtml = '<link rel="stylesheet" href="/console/styles.css"><script type="module" src="/console/app.js"></script>';
    await Promise.all([
      writeFile(join(directory, "index.html"), sourceHtml),
      writeFile(join(directory, "app.js"), "console.log('one')\n"),
      writeFile(join(directory, "styles.css"), "body { color: blue; }\n"),
    ]);
    await execFileAsync(process.execPath, [resolve("deploy/scripts/build.mjs"), "--version-portal-assets", directory]);
    const first = await readFile(join(directory, "index.html"), "utf8");
    const appUrl = first.match(/src="([^"]+)"/u)?.[1];
    const styleUrl = first.match(/href="([^"]+)"/u)?.[1];
    expect(appUrl).toMatch(/^\/console\/app\.js\?v=[a-f0-9]{16}$/u);
    expect(styleUrl).toMatch(/^\/console\/styles\.css\?v=[a-f0-9]{16}$/u);

    await writeFile(join(directory, "app.js"), "console.log('two')\n");
    await writeFile(join(directory, "index.html"), sourceHtml);
    await execFileAsync(process.execPath, [resolve("deploy/scripts/build.mjs"), "--version-portal-assets", directory]);
    const second = await readFile(join(directory, "index.html"), "utf8");
    expect(second.match(/src="([^"]+)"/u)?.[1]).not.toBe(appUrl);
    expect(second.match(/href="([^"]+)"/u)?.[1]).toBe(styleUrl);
    expect(await readFile(resolve("apps/console/index.html"), "utf8")).toContain('src="/console/app.js"');
  });

  it("does not bundle or execute the Access Gateway CLI entrypoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "portal-bundle-"));
    directories.push(directory);
    const outfile = join(directory, "portal.mjs");
    const result = await build({
      entryPoints: [resolve("services/access-gateway/portal/start.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      metafile: true,
      write: true,
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((path) => path.endsWith("services/access-gateway/start.ts"))).toBe(false);
    expect(inputs.some((path) => path.endsWith("services/access-gateway/crypto-runtime.ts"))).toBe(true);
    expect(await readFile(outfile, "utf8")).not.toContain("Access Gateway startup failed.");
  });
});
