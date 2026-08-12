import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

const adminAssetNames = ["index.html", "styles.css", "app.js", "fixture-data.js"];
const adminSourcePaths = adminAssetNames.map((name) => resolve("apps/admin", name));

rmSync("dist", { recursive: true, force: true });

if (adminSourcePaths.some((path) => {
  try {
    return !statSync(path).isFile();
  } catch {
    return true;
  }
})) {
  throw new Error("Admin UI build requires all four apps/admin assets.");
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

mkdirSync(resolve("dist/admin"), { recursive: true });
for (const [index, sourcePath] of adminSourcePaths.entries()) {
  cpSync(sourcePath, resolve("dist/admin", adminAssetNames[index]));
}
