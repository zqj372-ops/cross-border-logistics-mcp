import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";

import { createApplicationMcpHttpHandler } from "../../services/access-gateway/portal/business-access/mcp-http";
import { BUSINESS_MCP_TOOLS, SCHEDULE_MCP_TOOLS } from "../../src/logistics_mcp/platform/application-tools";
import { SCHEDULE_LIVE_VERSION } from "../../services/maritime/schedule-live/contracts";

const runtimeSecret = "s".repeat(48);

async function startHandler(providerHealthy = true) {
  const holder: { handler?: ReturnType<typeof createApplicationMcpHttpHandler> } = {};
  const server = createServer((request, response) => {
    if (!holder.handler?.handle(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = `http://${host}`;
  holder.handler = createApplicationMcpHttpHandler({
    mode: "fixtures",
    runtimeSecret,
    providerHealth: () => Promise.resolve(providerHealthy),
    allowedHosts: [host],
    allowedOrigins: [origin],
    trustedProxyAddresses: [],
    service: {
      repositoryKind: "synthetic",
      exchange: () => Promise.reject(new Error("unused")),
      authorize: () => Promise.reject(new Error("unused")),
    },
    mcpAccess: {
      exchange: () => Promise.reject(new Error("unused")),
      verify: () => Promise.reject(new Error("unused")),
    },
    executor: { execute: () => Promise.reject(new Error("unused")) },
  });
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))),
  };
}

it("serves the real schedule provider health contract expected by the managed loader", async () => {
  const server = await startHandler();
  try {
    const unauthenticated = await fetch(
      `${server.origin}/access/v2/application/schedule/provider/health`,
    );
    expect(unauthenticated.status).toBe(401);
    const wrongSecret = await fetch(
      `${server.origin}/access/v2/application/schedule/provider/health`,
      { headers: { "x-freightclaw-runtime-token": "x".repeat(48) } },
    );
    expect(wrongSecret.status).toBe(401);

    const response = await fetch(
      `${server.origin}/access/v2/application/schedule/provider/health`,
      { headers: { "x-freightclaw-runtime-token": runtimeSecret } },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      readonly schema_version: string;
      readonly ready: boolean;
      readonly contract_version: string;
      readonly operations: readonly string[];
    };
    expect(body.schema_version).toBe("schedule-provider-health@2026-09-18.v1");
    expect(body.ready).toBe(true);
    // The managed loader compares this exact version; a typo must fail here.
    expect(body.contract_version).toBe(SCHEDULE_LIVE_VERSION);
    expect(body.operations).toEqual([...SCHEDULE_MCP_TOOLS]);
    expect(body.operations).toHaveLength(3);

    const business = await fetch(
      `${server.origin}/access/v2/application/mcp/provider/health`,
      { headers: { "x-freightclaw-runtime-token": runtimeSecret } },
    );
    expect(business.status).toBe(200);
    expect(await business.json()).toMatchObject({
      schema_version: "business-provider-health@2026-09-06.v1",
      contract_version: "business-mcp-result@2026-09-06.v1",
      operations: BUSINESS_MCP_TOOLS,
    });
  } finally {
    await server.close();
  }
});

it("returns unavailable schedule health when the provider dependency is unhealthy", async () => {
  const server = await startHandler(false);
  try {
    const response = await fetch(
      `${server.origin}/access/v2/application/schedule/provider/health`,
      { headers: { "x-freightclaw-runtime-token": runtimeSecret } },
    );
    expect(response.status).toBe(503);
  } finally {
    await server.close();
  }
});
