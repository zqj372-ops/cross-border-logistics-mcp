import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const adminAssetNames = ["index.html", "styles.css", "app.js", "fixture-data.js"];
const adminBundleSetting = process.env.MCP_ADMIN_UI_BUNDLE;
if (
  adminBundleSetting !== undefined &&
  adminBundleSetting !== "true" &&
  adminBundleSetting !== "false"
) {
  throw new Error("MCP_ADMIN_UI_BUNDLE must be true or false when set.");
}

rmSync("dist", { recursive: true, force: true });

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

if (adminBundleSetting === "true") {
  const sourcePaths = adminAssetNames.map((name) => resolve("apps/admin", name));
  if (sourcePaths.some((path) => {
    try {
      return !statSync(path).isFile();
    } catch {
      return true;
    }
  })) {
    throw new Error("MCP_ADMIN_UI_BUNDLE requires all four apps/admin assets.");
  }
  mkdirSync(resolve("dist/admin"), { recursive: true });
  for (const [index, sourcePath] of sourcePaths.entries()) {
    cpSync(sourcePath, resolve("dist/admin", adminAssetNames[index]));
  }
}
