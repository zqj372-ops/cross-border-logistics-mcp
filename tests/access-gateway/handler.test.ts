import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSyntheticAccessGatewayFixture,
  createTokenExchangeHandler,
} from "../../services/access-gateway/index";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startServer(fixture: ReturnType<typeof createSyntheticAccessGatewayFixture>) {
  let handler: ReturnType<typeof createTokenExchangeHandler> | null = null;
  const server = createServer((request, response) => {
    if (handler === null || !handler.handle(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  handler = createTokenExchangeHandler({
    gateway: fixture.gateway,
    allowedHosts: [`127.0.0.1:${address.port}`],
    allowedOrigins: [origin],
    allowLoopbackHttp: true,
  });
  return { origin };
}

function exchangeBody(requestedToolNames: readonly string[] = ["cargo.calculate"]): string {
  return JSON.stringify({ schema_version: "2026-08-27.v1", requested_tool_names: requestedToolNames });
}

describe("POST /access/v1/token/exchange handler", () => {
  it("enforces ApiKey auth, closed body, stable errors, and success envelope", async () => {
    const fixture = createSyntheticAccessGatewayFixture();
    const seeded = await fixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    const { origin } = await startServer(fixture);

    const success = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${seeded.apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: exchangeBody(),
    });
    expect(success.status).toBe(200);
    const successBody = await success.json() as Record<string, unknown>;
    expect(successBody).toMatchObject({ schema_version: "2026-08-27.v1", status: "success" });

    const bearer = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${seeded.apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: exchangeBody(),
    });
    expect(bearer.status).toBe(401);
    expect(await bearer.json()).toMatchObject({ status: "blocked", code: "authentication_failed", data: null });

    const unknownField = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${seeded.apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ schema_version: "2026-08-27.v1", requested_tool_names: ["cargo.calculate"], tenant_id: "leak" }),
    });
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toMatchObject({ status: "needs_input", code: "invalid_request", data: null });

    const denied = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${seeded.apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: exchangeBody(["system.agent_context.get"]),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ status: "blocked", code: "tool_entitlement_denied", data: null });
  });

  it("maps rate-limit and provider failures without returning a token", async () => {
    const fixture = createSyntheticAccessGatewayFixture();
    const seeded = await fixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    const { origin } = await startServer(fixture);
    fixture.rateLimit.denyNext();
    const limited = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${seeded.apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: exchangeBody(),
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ status: "blocked", code: "rate_limited", data: null });

    fixture.audit.failNext();
    const unavailable = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${seeded.apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: exchangeBody(),
    });
    expect(unavailable.status).toBe(503);
    const unavailableBody = await unavailable.json() as Record<string, unknown>;
    expect(unavailableBody).toMatchObject({ status: "unavailable", code: "access_gateway_unavailable", data: null });
    expect(JSON.stringify(unavailableBody)).not.toContain("access_token");
  });

  it("rejects spoofed forwarding headers and trusts only one configured proxy hop", async () => {
    const fixture = createSyntheticAccessGatewayFixture();
    const seeded = await fixture.seedAcknowledgedCredential({ toolNames: ["cargo.calculate"] });
    let handler: ReturnType<typeof createTokenExchangeHandler> | null = null;
    const server = createServer((request, response) => {
      if (handler === null || !handler.handle(request, response)) {
        response.statusCode = 404;
        response.end();
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server address unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const baseOptions = {
      gateway: fixture.gateway,
      allowedHosts: [`127.0.0.1:${address.port}`],
      allowedOrigins: [origin],
    } as const;

    handler = createTokenExchangeHandler(baseOptions);
    const spoofed = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${seeded.apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
        "X-Forwarded-For": "198.51.100.50",
        "X-Forwarded-Proto": "https",
      },
      body: exchangeBody(),
    });
    expect(spoofed.status).toBe(400);

    handler = createTokenExchangeHandler({
      ...baseOptions,
      trustedProxyAddresses: ["127.0.0.1"],
    });
    const trusted = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${seeded.apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
        "X-Forwarded-For": "198.51.100.50",
        "X-Forwarded-Proto": "https",
      },
      body: exchangeBody(),
    });
    expect(trusted.status).toBe(200);

    const chained = await fetch(`${origin}/access/v1/token/exchange`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${seeded.apiKey}`,
        "Content-Type": "application/json",
        Origin: origin,
        "X-Forwarded-For": "198.51.100.50, 203.0.113.8",
        "X-Forwarded-Proto": "https",
      },
      body: exchangeBody(),
    });
    expect(chained.status).toBe(400);
  });
});
