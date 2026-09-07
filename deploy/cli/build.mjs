import { build } from "esbuild";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const source = fileURLToPath(new URL("./", import.meta.url));
const root = resolve(source, "../..");
const { values } = parseArgs({ options: { outdir: { type: "string" } } });
const output = resolve(values.outdir ?? resolve(root, "dist/cli"));
const metadata = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
await mkdir(resolve(output, "bin"), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [resolve(source, "main.ts")],
  outfile: resolve(output, "bin/freightclaw.mjs"),
  bundle: true, format: "esm", platform: "node", target: "node22.13", sourcemap: false,
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "inline",
});
await chmod(resolve(output, "bin/freightclaw.mjs"), 0o755);
for (const file of ["package.json", "README.md"]) await copyFile(resolve(source, file), resolve(output, file));
await copyFile(resolve(root, "apps/console/workspace-cli.md"), resolve(output, "workspace.md"));
await writeFile(resolve(output, "README.md"), (await readFile(resolve(source, "README.md"), "utf8")).replace("../../apps/console/workspace-cli.md", "./workspace.md"));
await mkdir(resolve(output, "examples"), { recursive: true });
// Explicit package contents keep local credentials and untracked files out of releases.
for (const name of ["cargo", "container", "agent", "customs-query", "customs-tax", "customs-tax-batch", "quote-zone", "quote-extract", "quote-freightcom"]) {
  await copyFile(resolve(source, `examples/${name}.json`), resolve(output, `examples/${name}.json`));
}
const dependencies = ["ajv", "ajv-formats", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string", "zod"];
const notices = [];
for (const dependency of dependencies) {
  const folder = resolve(root, "node_modules", dependency);
  const pkg = JSON.parse(await readFile(resolve(folder, "package.json"), "utf8"));
  notices.push(`${dependency} ${pkg.version}\n${await readFile(resolve(folder, dependency === "require-from-string" ? "license" : "LICENSE"), "utf8")}`);
}
await writeFile(resolve(output, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n"));
console.log(JSON.stringify({ package: metadata.name, version: metadata.version, directory: output }));
