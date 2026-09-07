import { buildInquiry } from "./build-inquiry.mjs";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

function versionPortalAssets(directory) {
  const indexPath = resolve(directory, "index.html");
  let html = readFileSync(indexPath, "utf8");
  for (const name of ["styles.css", "app.js"]) {
    const digest = createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex").slice(0, 16);
    const plainUrl = `/console/${name}`;
    html = html.replace(new RegExp(`${plainUrl.replace(".", "\\.")}(?:\\?v=[a-f0-9]{16})?`, "gu"), `${plainUrl}?v=${digest}`);
  }
  writeFileSync(indexPath, html);
}

if (process.argv[2] === "--version-portal-assets") {
  if (!process.argv[3]) throw new Error("Portal asset directory is required.");
  versionPortalAssets(process.argv[3]);
  process.exit(0);
}

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
execFileSync(process.execPath, ["--import", "tsx/esm", "deploy/scripts/generate-portal-openapi.ts", "apps/console/openapi.json"], { stdio: "inherit" });
const portalAssetSpecs = ["index.html", "styles.css", "app.js", "openapi.json", "skill.md", "workspace-cli.md", "native-business.md", "brand-wordmark.svg", "brand-icon.svg", "auth-background.svg", "asset-licenses.md"].map((name) => ({ name, source: resolve("apps/console", name) }));
const nodeEsmBanner = {
  js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
};

rmSync("dist", { recursive: true, force: true });

execFileSync(process.execPath, [
  "--import",
  "tsx/esm",
  "src/logistics_mcp/module-runtime/artifact-attestation.ts",
], { stdio: "inherit" });

if ([...adminSourcePaths, ...accessConsoleSourcePaths, ...portalAssetSpecs.map(({ source }) => source)].some((path) => {
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

mkdirSync(resolve("dist/console"), { recursive: true });
for (const asset of portalAssetSpecs) cpSync(asset.source, resolve("dist/console", asset.name));
await build({
  entryPoints: ["apps/console/styles.css"], outfile: "dist/console/styles.css", bundle: true,
  loader: { ".woff2": "file" }, assetNames: "fonts/[name]-[hash]", publicPath: "/console",
});
await build({
  entryPoints: ["apps/console/app.js"], outfile: "dist/console/app.js", bundle: true,
  format: "esm", platform: "browser", target: "es2022", sourcemap: false, legalComments: "none",
});
versionPortalAssets("dist/console");
await build({
  entryPoints: ["deploy/scripts/start-portal-fixture.ts"], outfile: "dist/src/logistics_mcp/server/portal-fixture.mjs", bundle: true,
  format: "esm", platform: "node", target: "node22", banner: nodeEsmBanner, sourcemap: false, legalComments: "none",
});
await build({
  entryPoints: ["services/access-gateway/portal/start.ts"], outfile: "dist/services/access-gateway/portal/start.mjs", bundle: true,
  format: "esm", platform: "node", target: "node22", banner: nodeEsmBanner, sourcemap: false, legalComments: "none",
});

await build({entryPoints:["services/access-gateway/portal/postgres-worker.ts"],outfile:"dist/services/access-gateway/portal/postgres-worker.mjs",bundle:true,format:"esm",platform:"node",target:"node22",banner:nodeEsmBanner,sourcemap:false,legalComments:"none"});

await build({entryPoints:["services/access-gateway/portal/postgres-migration.ts"],outfile:"dist/services/access-gateway/portal/postgres-migration.mjs",bundle:true,format:"esm",platform:"node",target:"node22",banner:nodeEsmBanner,sourcemap:false,legalComments:"none"});
await build({entryPoints:["src/logistics_mcp/module-runtime/provider-release-cli.ts"],outfile:"dist/src/logistics_mcp/module-runtime/provider-release-cli.mjs",bundle:true,format:"esm",platform:"node",target:"node22",banner:nodeEsmBanner,sourcemap:false,legalComments:"none"});

await buildInquiry();

// Ship the native Python calculation core with the Portal build.
cpSync("services/quote-native", "dist/services/quote-native", { recursive: true, filter: (source) => !source.includes("__pycache__") });
// Operator CLI: offline, hash-bound CBSA candidate preparation. It never runs
// inside a request handler or grants publication approval.
mkdirSync(resolve('dist/services/customs-native'),{recursive:true});
cpSync('services/customs-native/data_pipeline','dist/services/customs-native/data_pipeline',{recursive:true,filter:(source)=>!source.includes('__pycache__')});
mkdirSync(resolve('dist/deploy/scripts'),{recursive:true});
cpSync('deploy/scripts/prepare-cbsa-release.py','dist/deploy/scripts/prepare-cbsa-release.py');

mkdirSync(resolve('dist/services/quote-documents'),{recursive:true});
cpSync(resolve('apps/console/fonts'),resolve('dist/services/quote-documents/fonts'),{recursive:true});

cpSync(resolve('services/quote-native/mixed_pallets.py'),resolve('dist/services/quote-native/mixed_pallets.py'));

await build({entryPoints:["deploy/scripts/verify-pdf-renderer.ts"],outfile:"dist/deploy/verify-pdf-renderer.mjs",bundle:true,format:"esm",platform:"node",target:"node22",banner:nodeEsmBanner,sourcemap:false,legalComments:"none"});
