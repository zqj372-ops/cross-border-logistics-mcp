import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCredentialSetupServer,
  renderManagedCodexBlock,
  upsertManagedCodexConfig,
  verifyFreightClawReadback,
} from "../../deploy/clients/freightclaw-codex-setup.mjs";

const API_KEY = `lmcpk_key_codex_setup_${"B".repeat(43)}`;
const REQUEST_ID = "req_codex_setup_test_001";
const ACCESS_TOKEN = "header.payload.signature";
const TOOLS = [
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
];
const RESOURCES = [
  "logistics://agent/bootstrap",
  "logistics://agent/profiles",
  "logistics://contracts/envelope/current",
  "logistics://modules/catalog",
  "logistics://standards/index",
];
const servers: Array<ReturnType<typeof createCredentialSetupServer>["server"]> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function start(completeSetup = vi.fn(() => Promise.resolve({
  toolCount: 3,
  resourceCount: 5,
  transportMode: "stateless" as const,
}))) {
  const created = createCredentialSetupServer({ port: 0, completeSetup });
  servers.push(created.server);
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = created.server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  return {
    ...created,
    completeSetup,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function rawGet(url: string, headers: Record<string, string>) {
  const target = new URL(url);
  return new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("FreightClaw Codex client setup", () => {
  it("renders an idempotent managed Codex block using the dynamic header helper", () => {
    const helper = "/Users/example/.codex/freightclaw/freightclaw-auth-headers";
    const block = renderManagedCodexBlock(helper);
    expect(block).toContain("[mcp_servers.freightclaw]");
    expect(block).toContain('url = "https://www.freightclaw.net/mcp"');
    expect(block).toContain(`http_headers_helper = "${helper}"`);
    expect(block).toContain('"cargo.calculate"');
    expect(block).toContain('"container.plan_summary"');
    expect(block).toContain('"system.agent_context.get"');
    expect(block).not.toContain("bearer_token_env_var");
    expect(block).not.toContain("lmcpk_");

    const initial = 'model = "gpt-5.6-sol"\n';
    const once = upsertManagedCodexConfig(initial, helper);
    const twice = upsertManagedCodexConfig(once, helper);
    expect(twice).toBe(once);
    expect(twice).toContain(initial.trim());
    expect(twice.match(/\[mcp_servers\.freightclaw\]/gu)).toHaveLength(1);
  });

  it("refuses to overwrite an unmanaged FreightClaw MCP section", () => {
    expect(() => upsertManagedCodexConfig(
      '[mcp_servers.freightclaw]\nurl = "https://other.example/mcp"\n',
      "/safe/helper",
    )).toThrowError(expect.objectContaining({ code: "codex_config_conflict" }));
  });

  it("verifies before storing and never renders the submitted long Key", async () => {
    const harness = await start();
    const page = await fetch(`${harness.origin}/`);
    const pageBody = await page.text();
    const nonce = pageBody.match(/name="nonce" value="([a-f0-9]+)"/u)?.[1] ?? "";

    const response = await fetch(`${harness.origin}/save`, {
      method: "POST",
      headers: {
        origin: harness.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce, api_key: API_KEY }),
    });
    const responseBody = await response.text();

    expect(response.status).toBe(200);
    expect(harness.completeSetup).toHaveBeenCalledWith(API_KEY);
    expect(responseBody).toContain("3 tools / 5 resources");
    expect(responseBody).toContain("stateless");
    expect(responseBody).not.toContain(API_KEY);
    expect(await (await fetch(`${harness.origin}/status`)).json()).toEqual({
      configured: true,
      resource_count: 5,
      tool_count: 3,
      transport_mode: "stateless",
    });

    const replay = await fetch(`${harness.origin}/save`, {
      method: "POST",
      headers: {
        origin: harness.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce, api_key: API_KEY }),
    });
    expect(replay.status).toBe(400);
    expect(harness.completeSetup).toHaveBeenCalledTimes(1);
  });

  it("rejects a rebound or cross-origin request before accepting a Key", async () => {
    const harness = await start();
    const rebound = await rawGet(`${harness.origin}/`, { host: "attacker.example" });
    expect(rebound.status).toBe(403);
    expect(rebound.body).not.toContain('name="nonce"');

    const pageBody = await (await fetch(`${harness.origin}/`)).text();
    const nonce = pageBody.match(/name="nonce" value="([a-f0-9]+)"/u)?.[1] ?? "";
    const crossOrigin = await fetch(`${harness.origin}/save`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce, api_key: API_KEY }),
    });

    expect(crossOrigin.status).toBe(403);
    expect(harness.completeSetup).not.toHaveBeenCalled();
    expect(await crossOrigin.text()).not.toContain(API_KEY);
  });

  it("performs a real stateless protocol readback before reporting completion", async () => {
    const rpcMethods: string[] = [];
    const calledTools: string[] = [];
    const readResources: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockImplementation((input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.endsWith("/access/v1/token/exchange")) {
        return Promise.resolve(new Response(JSON.stringify({
          schema_version: "2026-08-27.v1",
          status: "success",
          data: {
            access_token: ACCESS_TOKEN,
            token_type: "Bearer",
            expires_in: 300,
            tool_names: TOOLS,
            session_ref: "auth_codex_setup_test_001",
            request_id: REQUEST_ID,
          },
          warnings: [],
          blockers: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      if (typeof init?.body !== "string") throw new Error("Expected an MCP JSON body.");
      const request = JSON.parse(init.body) as {
        readonly id?: number;
        readonly method: string;
        readonly params?: { readonly uri?: string; readonly name?: string };
      };
      rpcMethods.push(request.method);
      let result: unknown;
      if (request.method === "initialize") {
        result = { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} };
      } else if (request.method === "resources/list") {
        result = { resources: RESOURCES.map((uri) => ({ uri, name: uri })) };
      } else if (request.method === "resources/read") {
        readResources.push(request.params?.uri ?? "");
        result = { contents: [{ uri: request.params?.uri, text: "verified" }] };
      } else if (request.method === "tools/list") {
        result = { tools: TOOLS.map((name) => ({ name, inputSchema: {} })) };
      } else if (request.method === "tools/call") {
        calledTools.push(request.params?.name ?? "");
        result = { structuredContent: { status: "success" } };
      } else {
        throw new Error(`Unexpected method: ${request.method}`);
      }
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });

    const readback = await verifyFreightClawReadback(API_KEY, {
      fetchImpl,
      requestIdFactory: () => REQUEST_ID,
    });

    expect(readback).toEqual({ toolCount: 3, resourceCount: 5, transportMode: "stateless" });
    expect(readResources).toEqual(RESOURCES);
    expect(calledTools).toEqual(TOOLS);
    expect(rpcMethods).not.toContain("notifications/initialized");
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true);
  });
});
