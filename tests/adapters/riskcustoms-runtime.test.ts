import { describe, expect, it, vi } from "vitest";

import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context.js";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client.js";
import {
  createRiskCustomsApiAdapterFromEnvironment,
} from "../../src/logistics_mcp/adapters/customs/riskcustoms-runtime.js";

const context: ExecutionContext = parseExecutionContext({
  tenant_id: "tenant-a",
  actor_id: "actor-a",
  actor_role: "service",
  roles: ["service"],
  scopes: ["customs:read"],
  client_id: "client-a",
  session_id: "session-a",
  expires_at: 1_900_000_000,
});

const statusPayload = {
  contractVersion: "riskcustoms-query.v1",
  serviceVersion: "m2m-test-release",
  publishedAt: "2026-08-20T00:00:00.000Z",
  supportedOperations: ["status", "query"],
  releaseIds: ["release-1"],
  snapshotHash: "a".repeat(64),
  releaseHash: "b".repeat(64),
  evaluatedAt: "2026-08-21T00:00:00.000Z",
  lastSourceCheckAt: "2026-08-20T23:59:00.000Z",
  ready: true,
  testData: false,
  reasons: [],
};

function makeFetchSpy() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = vi.fn<FetchImplementation>((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, headers: new Headers(init?.headers) });
    return Promise.resolve(
      new Response(JSON.stringify(statusPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return { calls, fetchImpl };
}

describe("RiskCustoms runtime configuration", () => {
  it("stays disabled unless the server-side enablement and references are supplied", () => {
    expect(createRiskCustomsApiAdapterFromEnvironment({})).toBeUndefined();
  });

  it("constructs the M2M adapter and reads the token from the server-side secret file reference", async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const readSecretFile = vi.fn(() => "m2m-runtime-token\n");
    const adapter = createRiskCustomsApiAdapterFromEnvironment(
      {
        MCP_RISK_CUSTOMS_ENABLED: "true",
        MCP_RISK_CUSTOMS_BASE_URL: "https://riskcustoms.example.invalid",
        MCP_RISK_CUSTOMS_ALLOWED_HOSTS: "riskcustoms.example.invalid",
        MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid,riskcustoms.example.invalid",
        MCP_RISK_CUSTOMS_AUTH_SECRET_FILE: "/run/secrets/riskcustoms-m2m-token",
      },
      { fetchImpl, readSecretFile },
    );

    expect(adapter).toBeDefined();
    const result = await adapter!.getStatus({ rule_date: "2026-08-21" }, context);

    expect(result.status).toBe("success");
    expect(readSecretFile).toHaveBeenCalledWith("/run/secrets/riskcustoms-m2m-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://riskcustoms.example.invalid/api/m2m/status?ruleDate=2026-08-21",
    );
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer m2m-runtime-token");
    expect(calls[0]?.headers.get("x-tenant-id")).toBe("tenant-a");
    expect(JSON.stringify(result)).not.toContain("m2m-runtime-token");
  });

  it("does not enable the adapter when the RiskCustoms host is absent from the global outbound allowlist", () => {
    expect(
      createRiskCustomsApiAdapterFromEnvironment({
        MCP_RISK_CUSTOMS_ENABLED: "true",
        MCP_RISK_CUSTOMS_BASE_URL: "https://riskcustoms.example.invalid",
        MCP_RISK_CUSTOMS_ALLOWED_HOSTS: "riskcustoms.example.invalid",
        MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid",
        MCP_RISK_CUSTOMS_AUTH_SECRET_FILE: "/run/secrets/riskcustoms-m2m-token",
      }),
    ).toBeUndefined();
  });
});
