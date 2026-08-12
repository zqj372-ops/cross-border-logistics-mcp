import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";

import { cargoInput } from "./fixtures/tenant-fixtures";

const root = resolve(import.meta.dirname, "../..");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("A local runtime smoke port was not allocated.");
  }
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
  return port;
}

async function waitForHealth(port: number, child: ChildProcess): Promise<Response> {
  let lastError = "runtime did not become healthy";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${lastError}; child exited with ${child.exitCode}`);
    }
    try {
      return await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error(lastError);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const onExit = () => {
      child.removeListener("exit", onExit);
      resolvePromise();
    };
    child.once("exit", onExit);
    if (child.exitCode !== null) {
      onExit();
    } else {
      child.kill("SIGTERM");
    }
  });
}

describe("built runtime smoke", () => {
  it("starts the dist entry directly, loads cargo contracts and answers health", async () => {
    execFileSync("npm", ["run", "build"], {
      cwd: root,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        npm_config_update_notifier: "false",
      },
    });
    const layout = await mkdtemp(resolve(tmpdir(), "logistics-mcp-runtime-"));
    await cp(resolve(root, "dist"), resolve(layout, "dist"), { recursive: true });
    await cp(resolve(root, "docs/contracts"), resolve(layout, "docs/contracts"), { recursive: true });
    const entry = resolve(layout, "dist/src/logistics_mcp/server/start.mjs");
    expect(existsSync(resolve(layout, "package.json"))).toBe(false);
    const port = await freePort();
    const child = spawn(process.execPath, [entry], {
      cwd: layout,
      env: {
        PATH: process.env.PATH ?? "",
        MCP_PORT: String(port),
        MCP_DATA_MODE: "production",
        MCP_JWT_ISSUER: "https://issuer.example.invalid/",
        MCP_JWT_AUDIENCE: "logistics-mcp-demo",
        MCP_ALLOWED_ORIGINS: "https://client.example.invalid",
        MCP_ALLOWED_HOSTS: "mcp.example.invalid",
        MCP_ALLOWED_OUTBOUND_HOSTS: "riskcustoms.example.invalid",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const health = await waitForHealth(port, child);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(readiness.status).toBe(503);
      const readinessBody = (await readiness.json()) as {
        status?: string;
        reasons?: string[];
      };
      expect(readinessBody).toMatchObject({ status: "not_ready" });
      expect(readinessBody.reasons).toEqual(
        expect.arrayContaining([
          "platform_audit_repository_missing",
          "production_token_verifier_missing",
          "production_adapter_source_missing",
        ]),
      );
      const unavailable = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          origin: "https://client.example.invalid",
          host: "mcp.example.invalid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "runtime-smoke", version: "1.0.0" },
          },
        }),
      });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ status: "unavailable" });
      const oversized = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(32 * 1024 + 1),
          "x-forwarded-proto": "https",
          origin: "https://client.example.invalid",
          host: "mcp.example.invalid",
        },
        body: "x".repeat(32 * 1024 + 1),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ status: "blocked" });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`,
        { cause: error },
      );
    } finally {
      await stop(child);
      await rm(layout, { recursive: true, force: true });
    }
  }, 10_000);

  it("starts the dist fixture entry and serves admin plus a real MCP tool call", async () => {
    execFileSync("npm", ["run", "build"], {
      cwd: root,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        npm_config_update_notifier: "false",
      },
    });
    const layout = await mkdtemp(resolve(tmpdir(), "logistics-mcp-fixture-runtime-"));
    await cp(resolve(root, "dist"), resolve(layout, "dist"), { recursive: true });
    await cp(resolve(root, "docs/contracts"), resolve(layout, "docs/contracts"), { recursive: true });
    const entry = resolve(layout, "dist/src/logistics_mcp/server/start.mjs");
    const port = await freePort();
    const child = spawn(process.execPath, [entry], {
      cwd: layout,
      env: {
        PATH: process.env.PATH ?? "",
        MCP_PORT: String(port),
        MCP_DATA_MODE: "fixtures",
        MCP_ADMIN_UI_ENABLED: "true",
        MCP_FIXTURE_TOKEN: "local-fixture-token",
        MCP_JWT_ISSUER: "https://issuer.example.invalid/",
        MCP_JWT_AUDIENCE: "logistics-mcp-local",
        MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        MCP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        MCP_ALLOWED_OUTBOUND_HOSTS: "fixture.example.invalid",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let client: Client | undefined;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      expect((await waitForHealth(port, child)).status).toBe(200);
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(readiness.status).toBe(503);
      const readinessBody = (await readiness.json()) as {
        status?: string;
        reasons?: string[];
      };
      expect(readinessBody.status).toBe("not_ready");
      expect(readinessBody.reasons).toContain("fixture_mode_not_production_ready");
      const admin = await fetch(`http://127.0.0.1:${port}/admin/?fixture=1`);
      expect(admin.status).toBe(200);
      expect(await admin.text()).toContain("跨境物流控制台");

      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const rejected = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { ...headers, authorization: "Bearer wrong-fixture-token" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "local-runtime-smoke", version: "1.0.0" },
          },
        }),
      });
      expect(rejected.status).toBe(401);

      const wrongOrigin = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...headers,
          authorization: "Bearer local-fixture-token",
          origin: "https://evil.example.invalid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "local-runtime-smoke", version: "1.0.0" },
          },
        }),
      });
      expect(wrongOrigin.status).toBe(403);

      client = new Client({ name: "local-runtime-smoke", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        {
          requestInit: {
            headers: {
              authorization: "Bearer local-fixture-token",
            },
          },
        },
      );
      await client.connect(transport as Transport);
      expect(transport.sessionId).toBeTruthy();

      const toolList = await client.listTools();
      expect(toolList.tools.map((tool) => tool.name).sort()).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "customs.ca.estimate",
        "customs.ca.search",
        "knowledge.search_curated",
        "quote.canada_final_mile.calculate",
        "quote.save_draft",
        "review.create_task",
        "system.get_data_status",
      ].sort());

      const toolCall = await client.callTool({
        name: "cargo.calculate",
        arguments: cargoInput(),
      });
      const structured = toolCall.structuredContent as {
        status?: string;
        data?: { metrics?: { actual_weight?: { unit?: string } } };
        calculation_trace?: unknown[];
      } | undefined;
      expect(structured?.status).toBe("success");
      expect(structured?.data?.metrics?.actual_weight?.unit).toBe("kg");
      expect(structured?.calculation_trace?.length).toBeGreaterThan(0);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`,
        { cause: error },
      );
    } finally {
      await client?.close().catch(() => undefined);
      await stop(child);
      await rm(layout, { recursive: true, force: true });
    }
  }, 10_000);
});
