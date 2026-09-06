import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { PortalError } from "../../services/access-gateway/portal/contracts";
import { createPortalMachineHttpHandler } from "../../services/access-gateway/portal/machine-http";
import { WriteContractError } from "../../src/logistics_mcp/server/tool-registry";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

type Execution = Readonly<{ accessToken: string; toolName: string; input: unknown }>;

async function startServer(
  execute: (input: Execution) => unknown,
  exchange: (input: unknown) => unknown = () => {
    throw new Error("unexpected exchange");
  },
) {
  let handler: ReturnType<typeof createPortalMachineHttpHandler> | null = null;
  const server = createServer((request, response) => {
    if (handler === null || !handler.handle(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  handler = createPortalMachineHttpHandler({
    mode: "fixtures",
    bridge: {
      executeT0: execute as never,
      exchangeToken: exchange as never,
    },
    allowedHosts: [`127.0.0.1:${address.port}`],
    allowedOrigins: [origin],
  });
  return { origin };
}

async function rawRequest(input: Readonly<{
  origin: string;
  path: string;
  method?: string;
  headers?: OutgoingHttpHeaders;
  body?: string;
}>) {
  const target = new URL(input.path, input.origin);
  const body = input.body ?? "";
  return new Promise<Readonly<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>>((resolve, reject) => {
    let responseHeaders: Record<string, string | string[] | undefined> = {};
    const request = httpRequest({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname + target.search,
      method: input.method ?? "POST",
      headers: {
        Host: target.host,
        ...(body.length === 0 ? {} : { "Content-Length": String(Buffer.byteLength(body)) }),
        ...input.headers,
      },
    }, (response) => {
      responseHeaders = response.headers;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: responseHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function headers(origin?: string): OutgoingHttpHeaders {
  return {
    Authorization: "Bearer signed.jwt.token",
    "Content-Type": "application/json",
    ...(origin === undefined ? {} : { Origin: origin }),
  };
}

describe("fixture machine HTTP", () => {
  it("dispatches only the three fixed T0 routes with the original tool input", async () => {
    const executions: Execution[] = [];
    const { origin } = await startServer((input) => {
      executions.push(input);
      return { status: "success", data: { tool: input.toolName } };
    });
    for (const toolName of [
      "cargo.calculate",
      "container.plan_summary",
      "system.agent_context.get",
    ]) {
      const response = await fetch(`${origin}/api/fixture/v1/tools/${toolName}`, {
        method: "POST",
        headers: headers(origin) as Record<string, string>,
        body: JSON.stringify({ input: { marker: toolName } }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "success", data: { tool: toolName } });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
    expect(executions).toEqual([
      "cargo.calculate",
      "container.plan_summary",
      "system.agent_context.get",
    ].map((toolName) => ({
      accessToken: "signed.jwt.token",
      toolName,
      input: { marker: toolName },
    })));
    const missing = await fetch(`${origin}/api/fixture/v1/tools/customs.query`, {
      method: "POST",
      headers: headers(origin) as Record<string, string>,
      body: JSON.stringify({ input: {} }),
    });
    expect(missing.status).toBe(404);
  });

  it("reuses the existing token exchange handler with the bridge exchange port", async () => {
    const exchanges: unknown[] = [];
    const { origin } = await startServer(
      () => ({ status: "success", data: null }),
      (input) => {
        exchanges.push(input);
        return {
          schema_version: "2026-08-27.v1",
          status: "success",
          data: {
            access_token: "signed.jwt.token",
            token_type: "Bearer",
            expires_in: 300,
            tool_names: ["cargo.calculate"],
            session_ref: "auth_fixture_0001",
            request_id: "req_fixture_exchange_0001",
          },
          warnings: [],
          blockers: [],
        };
      },
    );
    const response = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: "ApiKey fixture-key",
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({
        schema_version: "2026-08-27.v1",
        requested_tool_names: ["cargo.calculate"],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "success" });
    expect(exchanges).toEqual([expect.objectContaining({
      apiKey: "fixture-key",
      body: {
        schema_version: "2026-08-27.v1",
        requested_tool_names: ["cargo.calculate"],
      },
      clientIp: "127.0.0.1",
    })]);
  });

  it("requires a closed wrapper, JSON content type, the fixed path, and at most 32 KiB", async () => {
    const { origin } = await startServer(() => ({ status: "success", data: null }));
    const unknown = await fetch(`${origin}/api/fixture/v1/tools/cargo.calculate`, {
      method: "POST",
      headers: headers(origin) as Record<string, string>,
      body: JSON.stringify({ input: {}, tenant_id: "forbidden" }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ status: "needs_input", reason_codes: ["body_invalid"] });

    const contentType = await rawRequest({
      origin,
      path: "/api/fixture/v1/tools/cargo.calculate",
      headers: { Authorization: "Bearer signed.jwt.token", "Content-Type": "text/plain" },
      body: JSON.stringify({ input: {} }),
    });
    expect(contentType.status).toBe(400);

    const query = await fetch(`${origin}/api/fixture/v1/tools/cargo.calculate?tenant_id=forbidden`, {
      method: "POST",
      headers: headers(origin) as Record<string, string>,
      body: JSON.stringify({ input: {} }),
    });
    expect(query.status).toBe(403);

    const oversized = await fetch(`${origin}/api/fixture/v1/tools/cargo.calculate`, {
      method: "POST",
      headers: headers(origin) as Record<string, string>,
      body: JSON.stringify({ input: { padding: "x".repeat(33 * 1024) } }),
    });
    expect(oversized.status).toBe(413);
  });

  it("rejects cookies, non-Bearer and duplicate Authorization without echoing credentials", async () => {
    const { origin } = await startServer((input) => {
      if (input.accessToken !== "signed.jwt.token") throw new PortalError("machine_authentication_failed");
      return { status: "success", data: null };
    });
    const secret = "secret.jwt.material";
    const wrong = await fetch(`${origin}/api/fixture/v1/tools/cargo.calculate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: {} }),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(secret);

    const apiKey = await fetch(`${origin}/api/fixture/v1/tools/cargo.calculate`, {
      method: "POST",
      headers: {
        Authorization: "ApiKey customer-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: {} }),
    });
    expect(apiKey.status).toBe(401);

    const duplicate = await rawRequest({
      origin,
      path: "/api/fixture/v1/tools/cargo.calculate",
      headers: {
        Authorization: ["Bearer signed.jwt.token", "Bearer signed.jwt.token"],
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: {} }),
    });
    expect(duplicate.status).toBe(401);

    const cookie = await fetch(`${origin}/api/fixture/v1/tools/cargo.calculate`, {
      method: "POST",
      headers: {
        ...headers(),
        Cookie: "portal_session=customer",
      } as Record<string, string>,
      body: JSON.stringify({ input: {} }),
    });
    expect(cookie.status).toBe(403);
  });

  it("enforces exact Host, loopback, and an optional allowlisted Origin", async () => {
    const { origin } = await startServer(() => ({ status: "success", data: null }));
    const noOrigin = await fetch(`${origin}/api/fixture/v1/tools/cargo.calculate`, {
      method: "POST",
      headers: headers() as Record<string, string>,
      body: JSON.stringify({ input: {} }),
    });
    expect(noOrigin.status).toBe(200);

    const deniedOrigin = await fetch(`${origin}/api/fixture/v1/tools/cargo.calculate`, {
      method: "POST",
      headers: headers("http://attacker.example") as Record<string, string>,
      body: JSON.stringify({ input: {} }),
    });
    expect(deniedOrigin.status).toBe(403);

    const wrongHost = await rawRequest({
      origin,
      path: "/api/fixture/v1/tools/cargo.calculate",
      headers: { ...headers(), Host: "attacker.example" },
      body: JSON.stringify({ input: {} }),
    });
    expect(wrongHost.status).toBe(403);
  });

  it("maps tool contract failures and refuses production assembly", async () => {
    const { origin } = await startServer(() => {
      throw new WriteContractError("tool_input.invalid", "needs_input", "sensitive detail");
    });
    const response = await fetch(`${origin}/api/fixture/v1/tools/cargo.calculate`, {
      method: "POST",
      headers: headers() as Record<string, string>,
      body: JSON.stringify({ input: {} }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: "needs_input",
      reason_codes: ["tool_input.invalid"],
    });
    expect(() => createPortalMachineHttpHandler({
      mode: "production",
      bridge: {
        executeT0: (() => Promise.resolve({})) as never,
        exchangeToken: (() => Promise.resolve({})) as never,
      },
      allowedHosts: ["127.0.0.1:3000"],
      allowedOrigins: [],
    })).toThrowError(expect.objectContaining({ code: "fixture_machine_api_forbidden" }));
  });
});
