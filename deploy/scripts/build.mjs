import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const adminAssetSpecs = [
  { name: "index.html", source: resolve("apps/admin/index.html") },
  { name: "styles.css", source: resolve("apps/admin/styles.css") },
  { name: "app.js", source: resolve("apps/admin/app.js") },
  { name: "control-plane.js", source: resolve("apps/admin/control-plane.js") },
  { name: "fixture-data.js", source: resolve("apps/admin/fixture-data.js") },
  {
    name: "vendor/adminlte/adminlte.min.css",
    source: resolve("node_modules/admin-lte/dist/css/adminlte.min.css"),
  },
  {
    name: "vendor/adminlte/adminlte.min.js",
    source: resolve("node_modules/admin-lte/dist/js/adminlte.min.js"),
  },
  {
    name: "vendor/bootstrap/bootstrap.min.css",
    source: resolve("node_modules/bootstrap/dist/css/bootstrap.min.css"),
  },
  {
    name: "vendor/bootstrap/bootstrap.bundle.min.js",
    source: resolve("node_modules/bootstrap/dist/js/bootstrap.bundle.min.js"),
  },
];
const adminSourcePaths = adminAssetSpecs.map(({ source }) => source);

rmSync("dist", { recursive: true, force: true });

if (adminSourcePaths.some((path) => {
  try {
    return !statSync(path).isFile();
  } catch {
    return true;
  }
})) {
  throw new Error("Admin UI build requires all declared application and vendor assets.");
}

const { build } = await import("esbuild");

await build({
  entryPoints: ["src/logistics_mcp/server/start.ts"],
  outfile: "dist/src/logistics_mcp/server/start.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
});

execFileSync(process.execPath, [
  "--import",
  "tsx/esm",
  "src/logistics_mcp/agent-context/cli.ts",
  "build",
  "dist/standards/agent-standard-pack.json",
], { stdio: "inherit" });

mkdirSync(resolve("dist/admin"), { recursive: true });
for (const asset of adminAssetSpecs) {
  const destination = resolve("dist/admin", asset.name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(asset.source, destination);
}
