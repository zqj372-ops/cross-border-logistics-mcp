import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const adminAssetSpecs = [
  { name: "index.html", source: resolve("apps/admin/index.html") },
  { name: "styles.css", source: resolve("apps/admin/styles.css") },
  { name: "app.js", source: resolve("apps/admin/app.js") },
  { name: "control-plane.js", source: resolve("apps/admin/control-plane.js") },
  { name: "plugin-config.js", source: resolve("apps/admin/plugin-config.js") },
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
const accessConsoleAssetSpecs = [
  { name: "index.html", source: resolve("apps/access-console/index.html") },
  { name: "styles.css", source: resolve("apps/access-console/styles.css") },
  { name: "app.js", source: resolve("apps/access-console/app.js") },
];
const accessConsoleSourcePaths = accessConsoleAssetSpecs.map(({ source }) => source);
const nodeEsmBanner = {
  js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
};

rmSync("dist", { recursive: true, force: true });

execFileSync(process.execPath, [
  "--import",
  "tsx/esm",
  "src/logistics_mcp/module-runtime/artifact-attestation.ts",
], { stdio: "inherit" });

if ([...adminSourcePaths, ...accessConsoleSourcePaths].some((path) => {
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
  banner: nodeEsmBanner,
  sourcemap: false,
  legalComments: "none",
});

await build({
  entryPoints: ["src/logistics_mcp/t1-worker/start.ts"],
  outfile: "dist/src/logistics_mcp/t1-worker/start.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  banner: nodeEsmBanner,
  sourcemap: false,
  legalComments: "none",
});

await build({
  entryPoints: ["services/access-gateway/start.ts"],
  outfile: "dist/services/access-gateway/start.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  banner: nodeEsmBanner,
  sourcemap: false,
  legalComments: "none",
});

await build({
  entryPoints: ["services/access-gateway/deployment-smoke.ts"],
  outfile: "dist/services/access-gateway/deployment-smoke.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  banner: nodeEsmBanner,
  sourcemap: false,
  legalComments: "none",
});

await build({
  entryPoints: ["services/access-gateway/deployment-load.ts"],
  outfile: "dist/services/access-gateway/deployment-load.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  banner: nodeEsmBanner,
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

await build({
  entryPoints: ["apps/admin/app.js"],
  outfile: "dist/admin/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  legalComments: "none",
});

mkdirSync(resolve("dist/access-console"), { recursive: true });
for (const asset of accessConsoleAssetSpecs) {
  cpSync(asset.source, resolve("dist/access-console", asset.name));
}
