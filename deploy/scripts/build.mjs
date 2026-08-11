import { rmSync } from "node:fs";
import { build } from "esbuild";

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
