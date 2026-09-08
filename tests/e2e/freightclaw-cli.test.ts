import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../deploy/cli/cli";
import { cargoInput, containerInput } from "./fixtures/tenant-fixtures";
import cargoResult from "../../docs/contracts/examples/success-cargo.json";
import containerResult from "../../docs/contracts/examples/success-container.json";

const key = `flcbk_bkey_${"1".repeat(24)}_synthetic_cli_fixture_not_a_real_key`;
const query = { query: "961700", ruleDate: "2026-09-07", attributes: { originCountry: "CN" } };
const unavailable = { schema_version: "portal-customs@2026-09-05.v1", status: "unavailable", data: null, reason_codes: ["source_not_ready"] };
const error = { schema_version: "business-access@2026-09-05.v1", status: "blocked", data: null, reason_codes: ["business_authentication_failed"], request_id: "req_cli_fixture_001" };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function invoke(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(args, { env: options.env ?? { FREIGHTCLAW_API_KEY: key }, stdin: Readable.from([options.input ?? JSON.stringify(query)]),
    stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return { code, stdout, stderr };
}

describe("FreightClaw command line client", () => {
  it("provides offline help, nine commands, and current input contracts without reading a credential", async () => {
    const env = Object.defineProperty({}, "FREIGHTCLAW_API_KEY", { get: () => { throw new Error("must not read a key"); } });
    expect((await invoke(["--help"], { env })).stdout).toContain("customs query");
    const listed = await invoke(["commands", "--json"], { env });
    expect((JSON.parse(listed.stdout) as { commands: unknown[] }).commands).toHaveLength(9);
    expect(listed.stdout).not.toContain("history list");
    const schema = await invoke(["schema", "customs", "query", "--json"], { env });
    expect(schema.code).toBe(0);
    expect((JSON.parse(schema.stdout) as { $schema: string }).$schema).toContain("2020-12");
  });

  it("validates before reading credentials or dispatching, including money types and unknown tenant input", async () => {
    const network = vi.fn<typeof fetch>();
    const env = Object.defineProperty({}, "FREIGHTCLAW_API_KEY", { get: () => { throw new Error("must not read a key"); } });
    for (const input of ["not JSON", JSON.stringify({ ...query, tenant_id: "another_tenant" }), JSON.stringify({ ...query, attributes: {} })]) {
      const result = await invoke(["customs", "query", "--input", "-"], { input, env, fetch: network });
      expect(result.code).toBe(2); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("must not read");
    }
    const money = await invoke(["customs", "tax", "--input", "-"], { input: JSON.stringify({ lineId: "line_1", ruleDate: "2026-09-07", declaredValue: 12.5 }), env, fetch: network });
    expect(money.code).toBe(2); expect(network).not.toHaveBeenCalled();
  });

  it.each([
    ["customs query", "/api/v2/business/customs/query", query, "portal-customs@2026-09-05.v1"],
    ["customs tax", "/api/v2/business/customs/tax-estimate", { lineId: "item_1", ruleDate: "2026-09-07" }, "portal-tax@2026-09-05.v1"],
    ["customs tax-batch", "/api/v2/business/customs/tax-estimates/batch", { ruleDate: "2026-09-07", items: [{ lineId: "item_1" }] }, "portal-tax@2026-09-05.v1"],
    ["quote extract", "/api/v2/business/quote/ai-extract-preview", { customer_message: "synthetic parcel inquiry" }, "portal-business@2026-09-05.v1"],
  ])("dispatches %s to its fixed route with the single application key", async (command, path, input, version) => {
    const network = vi.fn<typeof fetch>((url, options) => {
      expect((url as URL).href).toBe(`https://www.freightclaw.net${path}`);
      expect(options?.redirect).toBe("error"); expect(options?.credentials).toBe("omit");
      const headers = new Headers(options?.headers); expect(headers.get("authorization")).toBe(`ApiKey ${key}`); expect(headers.has("cookie")).toBe(false);
      expect(headers.has("x-tenant-id")).toBe(false);
      expect(JSON.parse(options?.body as string)).toEqual({ schema_version: "business-call@2026-09-05.v1", input });
      const body = { ...unavailable, schema_version: version, ...(version.startsWith("portal-tax") ? { request_id: "req_cli_fixture_001" } : {}) };
      return Promise.resolve(Response.json(body));
    });
    const result = await invoke([...String(command).split(" "), "--input", "-", "--json"], { input: JSON.stringify(input), fetch: network });
    expect(result.code).toBe(6); expect((JSON.parse(result.stdout) as { status: string }).status).toBe("unavailable"); expect(result.stderr).toBe("");
  });

  it.each([["success", 0], ["needs_input", 3], ["manual_review", 4], ["blocked", 5], ["unavailable", 6]])("preserves %s and its process exit code", async (status, exit) => {
    const body = { ...cargoResult, status, data: status === "success" ? cargoResult.data : null };
    const result = await invoke(["cargo", "calculate", "--input", "-", "--json"], { input: JSON.stringify(cargoInput()), fetch: () => Promise.resolve(Response.json(body)) });
    expect(result.code).toBe(exit); expect(JSON.parse(result.stdout)).toEqual(body);
  });

  it("preserves a closed authentication failure without displaying the credential", async () => {
    const result = await invoke(["customs", "query", "--input", "-"], { fetch: () => Promise.resolve(Response.json(error, { status: 401 })) });
    expect(result.code).toBe(5); expect(JSON.parse(result.stdout)).toEqual(error); expect(result.stdout + result.stderr).not.toContain(key);
  });

  it("rejects wrong-operation, unknown, non-JSON, and contradictory successful responses", async () => {
    for (const response of [Response.json({ ...error, status: "success" }, { status: 401 }), Response.json({ ...unavailable, status: "success" }),
      Response.json({ ...unavailable, extra: "unexpected" }), Response.json({ ...unavailable, schema_version: "portal-tax@2026-09-05.v1", request_id: "req_cli_fixture_001" }),
      new Response("private upstream stack", { status: 502, headers: { "content-type": "text/html" } })]) {
      const result = await invoke(["customs", "query", "--input", "-"], { fetch: () => Promise.resolve(response) });
      expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("private upstream stack");
    }
  });

  it("withholds reflected credentials even within an otherwise valid response", async () => {
    for (const reflected of [key, key.replaceAll("f", "\\u0066")]) {
      const body = JSON.stringify({ ...unavailable, reason_codes: [key] }).replace(key, reflected);
      const result = await invoke(["customs", "query", "--input", "-"], { fetch: () => Promise.resolve(new Response(body, { headers: { "content-type": "application/json" } })) });
      expect(result.code).toBe(1); expect(result.stdout + result.stderr).not.toContain(key);
      expect(result.stderr).toContain("credential_reflected");
    }
  });

  it("requires the correct T0 result and preserves the server calculation evidence", async () => {
    const result = await invoke(["container", "plan", "--input", "-"], { input: JSON.stringify(containerInput()), fetch: () => Promise.resolve(Response.json(containerResult)) });
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(containerResult);
    const wrong = await invoke(["cargo", "calculate", "--input", "-"], { input: JSON.stringify(cargoInput()), fetch: () => Promise.resolve(Response.json(containerResult)) });
    expect(wrong.code).toBe(1); expect(wrong.stdout).toBe("");
  });

  it("checks public Portal readiness without reading or sending an application key", async () => {
    const env = Object.defineProperty({}, "FREIGHTCLAW_API_KEY", { get: () => { throw new Error("must not read a key"); } });
    const data = { service: "freightclaw-portal", release_id: "fixture_release", build_id: "fixture_build", ready: true, checks: { portal_database: true } };
    const network = vi.fn<typeof fetch>((url, init) => {
      expect((url as URL).href).toBe("https://www.freightclaw.net/console/readyz"); expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Promise.resolve(Response.json({ status: "success", data, reason_codes: [] }));
    });
    expect((await invoke(["status", "--json"], { env, fetch: network })).code).toBe(0);
    expect((await invoke(["status"], { env, fetch: () => Promise.resolve(Response.json({ status: "success", data: { ...data, ready: false }, reason_codes: [] })) })).code).toBe(1);
  });

  it("preserves the server's explicit unconfigured readiness without accepting malformed checks", async () => {
    const body = { status: "unavailable", data: { service: "freightclaw-portal", release_id: "unknown", build_id: "unknown", ready: false, checks: null }, reason_codes: ["portal_readiness_unconfigured"] };
    const result = await invoke(["status", "--json"], { env: {}, fetch: () => Promise.resolve(Response.json(body, { status: 503 })) });
    expect(result.code).toBe(6); expect(JSON.parse(result.stdout)).toEqual(body); expect(result.stderr).toBe("");
    for (const invalid of [{ ...body, status: "success" }, { ...body, reason_codes: [] }, { ...body, data: { ...body.data, ready: true } }, { ...body, data: { ...body.data, checks: {} } }]) {
      const rejected = await invoke(["status"], { env: {}, fetch: () => Promise.resolve(Response.json(invalid, { status: 503 })) });
      expect(rejected.code).toBe(1); expect(rejected.stdout).toBe("");
    }
  });

  it("accepts a private key file, and rejects ambiguous key sources and public file permissions", async () => {
    const folder = await mkdtemp(join(tmpdir(), "freightclaw-cli-test-")); directories.push(folder);
    const filename = join(folder, "application-key"); await writeFile(filename, key + "\n", { mode: 0o600 });
    const options = { env: {}, fetch: () => Promise.resolve(Response.json(unavailable)) };
    expect((await invoke(["customs", "query", "--input", "-", "--key-file", filename], options)).code).toBe(6);
    expect((await invoke(["customs", "query", "--input", "-", "--key-file", filename], { ...options, env: { FREIGHTCLAW_API_KEY: key } })).code).toBe(2);
    if (process.platform !== "win32") { await chmod(filename, 0o644); expect((await invoke(["customs", "query", "--input", "-", "--key-file", filename], options)).code).toBe(2); }
  });

  it("does not accept raw key flags, arbitrary paths, duplicate options, or insecure remote endpoints", async () => {
    const network = vi.fn<typeof fetch>();
    for (const args of [["--api-key", key], ["request", "/admin"], ["customs", "history"], ["status", "--endpoint", "http://example.invalid"],
      ["status", "--endpoint", "https://user:password@example.invalid"], ["status", "--endpoint", "https://example.invalid/other"], ["status", "--timeout", "1", "--timeout", "2"]]) {
      const result = await invoke(args, { fetch: network }); expect(result.code).toBe(2); expect(result.stdout + result.stderr).not.toContain(key);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("caps incoming JSON before accessing credentials and cancels oversized streamed responses", async () => {
    const env = Object.defineProperty({}, "FREIGHTCLAW_API_KEY", { get: () => { throw new Error("must not read a key"); } });
    expect((await invoke(["customs", "query", "--input", "-"], { input: " ".repeat(70 * 1024), env })).code).toBe(2);
    let cancelled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(300 * 1024)); }, cancel() { cancelled = true; } });
    const result = await invoke(["customs", "query", "--input", "-"], { fetch: () => Promise.resolve(new Response(body, { headers: { "content-type": "application/json" } })) });
    expect(result.code).toBe(1); expect(cancelled).toBe(true); expect(result.stdout).toBe("");
  });

  it("exercises real HTTP and does not follow a redirect carrying the key", async () => {
    let calls = 0, leaked = 0;
    const other = createServer((_req, res) => { leaked++; res.end("unexpected"); });
    const server = createServer((req, res) => { calls++; expect(req.headers.authorization).toBe(`ApiKey ${key}`); res.writeHead(307, { location: `http://127.0.0.1:${(other.address() as { port: number }).port}/leak` }); res.end(); });
    await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve)); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await invoke(["customs", "query", "--input", "-", "--endpoint", `http://127.0.0.1:${(server.address() as { port: number }).port}`]);
      expect(result.code).toBe(1); expect(calls).toBe(1); expect(leaked).toBe(0); expect(result.stdout + result.stderr).not.toContain(key);
    } finally { server.closeAllConnections(); other.closeAllConnections(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => other.close(() => resolve()))]); }
  });

  it("times out a stalled HTTP response body without retrying the request", async () => {
    let calls = 0;
    const server = createServer((_req, res) => { calls++; res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await invoke(["customs", "query", "--input", "-", "--timeout", "1", "--endpoint", `http://127.0.0.1:${(server.address() as { port: number }).port}`]);
      expect(result.code).toBe(1); expect(result.stderr).toContain("request_timeout"); expect(calls).toBe(1); expect(result.stdout).toBe("");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
