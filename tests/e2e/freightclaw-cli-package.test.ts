import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import cargoResult from "../../docs/contracts/examples/success-cargo.json";
import containerResult from "../../docs/contracts/examples/success-container.json";

const exec = promisify(execFile);
const key = `flcbk_bkey_${"2".repeat(24)}_synthetic_package_fixture_not_a_real_key`;
const examples = [
  ["cargo calculate", "cargo", "/api/v2/tools/cargo.calculate"],
  ["container plan", "container", "/api/v2/tools/container.plan_summary"],
  ["agent context", "agent", "/api/v2/tools/system.agent_context.get"],
  ["customs query", "customs-query", "/api/v2/business/customs/query"],
  ["customs tax", "customs-tax", "/api/v2/business/customs/tax-estimate"],
  ["customs tax-batch", "customs-tax-batch", "/api/v2/business/customs/tax-estimates/batch"],
  ["quote zone", "quote-zone", "/api/v2/business/quote/zone-preview"],
  ["quote extract", "quote-extract", "/api/v2/business/quote/ai-extract-preview"],
  ["quote freightcom", "quote-freightcom", "/api/v2/business/quote/freightcom-ltl-preview"],
] as const;
let folder: string, packageRoot: string, binary: string;
const env = { ...process.env };
delete env.FREIGHTCLAW_API_KEY;
delete env.FREIGHTCLAW_ENDPOINT;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "freightclaw-cli-package-"));
  const built = join(folder, "built");
  await exec(process.execPath, ["deploy/cli/build.mjs", "--outdir", built], { env });
  const packed = await exec("npm", ["pack", built, "--json", "--offline", "--ignore-scripts"], { cwd: folder, env });
  const files = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
  expect(files[0]!.files.map(file => file.path).sort()).toEqual([
    "README.md", "THIRD-PARTY-NOTICES.txt", "bin/freightclaw.mjs", "package.json", "workspace.md", "native-business.md", ...examples.map(([, name]) => `examples/${name}.json`),
  ].sort());
  const prefix = join(folder, "installed");
  await exec("npm", ["install", "--global", "--prefix", prefix, join(folder, files[0]!.filename), "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: folder, env });
  packageRoot = join(prefix, "lib/node_modules/@freightclaw/cli");
  binary = join(prefix, "bin/freightclaw");
}, 60_000);
afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

async function installed(args: string[], credential = false) {
  try {
    const result = await exec(binary, args, { cwd: folder, env: { ...env, ...(credential ? { FREIGHTCLAW_API_KEY: key } : {}) }, timeout: 10_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe("standalone CLI installation", () => {
  it("runs outside the repository with embedded contracts and no runtime install dependencies", async () => {
    expect((await installed(["--version"])).stdout.trim()).toBe("0.1.0");
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { dependencies?: unknown };
    expect(metadata.dependencies).toBeUndefined();
    const listed = JSON.parse((await installed(["commands", "--json"])).stdout) as { commands: unknown[] };
    expect(listed.commands).toHaveLength(9);
    expect(JSON.parse((await installed(["workspace","commands","--json"])).stdout)).toHaveLength(44);
    expect((await installed(["workspace","schema","cases","create"])).code).toBe(0);
    expect((await installed(["workspace","schema","channels","publish"])).code).toBe(0);
    expect(await readFile(join(packageRoot,"workspace.md"),"utf8")).toContain("workspace login start");
    for (const [command] of examples) {
      const schema = await installed(["schema", ...command.split(" "), "--json"]);
      expect(schema.code).toBe(0);
      expect(schema.stdout).toContain('"$schema":"https://json-schema.org/draft/2020-12/schema"');
      expect(schema.stdout).not.toContain("#/components/schemas/");
    }
  }, 20_000);

  it("invokes all nine fixed HTTP routes from installed example files and keeps business exit codes", async () => {
    const receipts: { path: string | undefined; method: string | undefined; authorization: string | undefined; body: unknown }[] = [];
    const server = createServer((req, res) => {
      let body = ""; req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        receipts.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(body) as unknown });
        const response = req.url?.endsWith("cargo.calculate") ? cargoResult : req.url?.endsWith("container.plan_summary") ? containerResult :
          req.url?.includes("/tools/") ? { schema_version: "portal-t0-rest@2026-09-05.v1", status: "blocked", data: null, reason_codes: ["synthetic_fixture_denied"] } :
            { schema_version: "portal-business@2026-09-05.v1", status: "unavailable", data: null, reason_codes: ["synthetic_source_not_ready"] };
        res.writeHead(response.status === "blocked" ? 503 : 200, { "content-type": "application/json" }); res.end(JSON.stringify(response));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      for (const [command, name, path] of examples) {
        const filename = join(packageRoot, `examples/${name}.json`);
        const input = JSON.parse(await readFile(filename, "utf8")) as unknown;
        const result = await installed([...command.split(" "), "--input", filename, "--endpoint", `http://127.0.0.1:${(server.address() as { port: number }).port}`, "--json"], true);
        expect(result.code, `${command}: ${result.stderr}`).toBe(name === "cargo" || name === "container" ? 0 : name === "agent" ? 5 : 6);
        expect(result.stderr).toBe(""); expect(result.stdout).not.toContain(key);
        expect(receipts.at(-1)).toEqual({ path, method: "POST", authorization: `ApiKey ${key}`, body: path.includes("/tools/") ? input : { schema_version: "business-call@2026-09-05.v1", input } });
      }
      expect(receipts).toHaveLength(9);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 20_000);
});
