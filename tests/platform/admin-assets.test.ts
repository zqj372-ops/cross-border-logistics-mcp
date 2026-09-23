import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedAdminFiles = [
  "app.js",
  "control-plane.js",
  "fixture-data.js",
  "index.html",
  "plugin-config.js",
  "styles.css",
  "vendor/adminlte/adminlte.min.css",
  "vendor/adminlte/adminlte.min.js",
  "vendor/bootstrap/bootstrap.bundle.min.js",
  "vendor/bootstrap/bootstrap.min.css",
] as const;

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) return listFiles(entryPath);
      if (entry.isFile()) return [relative(resolve(repositoryRoot, "dist/admin"), entryPath)];
      return [];
    }),
  );
  return files.flat().sort();
}

describe("admin build asset boundary", () => {
  it("copies only the declared application and vendor files into dist/admin", async () => {
    const sourceOpenApi = resolve(repositoryRoot, 'apps/console/openapi.json');
    const before = await stat(sourceOpenApi);
    await execFileAsync(process.execPath, ["deploy/scripts/build.mjs"], {
      cwd: repositoryRoot,
      env: process.env,
    });

    const adminDirectory = resolve(repositoryRoot, "dist/admin");
    await expect(listFiles(adminDirectory)).resolves.toEqual([...expectedAdminFiles]);
    for (const file of expectedAdminFiles) {
      const body = await readFile(resolve(adminDirectory, file));
      expect(body.byteLength).toBeGreaterThan(0);
    }
    expect((await stat(sourceOpenApi)).mtimeMs, 'build must not rewrite tracked OpenAPI').toBe(before.mtimeMs);
    expect(await readFile(resolve(repositoryRoot, 'dist/console/openapi.json'), 'utf8')).toBe(await readFile(sourceOpenApi, 'utf8'));
    expect(await readFile(resolve(repositoryRoot, 'dist/services/quote-native/mixed_pallets.py'), 'utf8')).toBe(await readFile(resolve(repositoryRoot, 'services/quote-native/mixed_pallets.py'), 'utf8'));
  }, 30_000);
});
