import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const entry = resolve(root, "dist/src/logistics_mcp/server/start.js");

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
    expect(readFileSync(entry, "utf8")).toContain("cross-border-logistics-mcp");
    const port = await freePort();
    const child = spawn(process.execPath, [entry], {
      cwd: root,
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
      expect(await readiness.json()).toMatchObject({ status: "not_ready" });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`,
        { cause: error },
      );
    } finally {
      await stop(child);
    }
  });
});
