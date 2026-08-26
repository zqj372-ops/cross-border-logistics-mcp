import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context.js";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client.js";
import {
  createRiskCustomsApiAdapterFromEnvironment,
  RISK_CUSTOMS_SECRET_MAX_BYTES,
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
  ruleDate: "2026-08-21",
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

function runtimeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MCP_RISK_CUSTOMS_ENABLED: "true",
    MCP_RISK_CUSTOMS_BASE_URL: "https://riskcustoms.example.invalid",
    MCP_RISK_CUSTOMS_ALLOWED_HOSTS: "riskcustoms.example.invalid",
    MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid,riskcustoms.example.invalid",
    MCP_RISK_CUSTOMS_AUTH_SECRET_FILE: "/run/secrets/riskcustoms-m2m-token",
    MCP_RISK_CUSTOMS_ALLOWED_TENANTS: "tenant-a",
    ...overrides,
  };
}

async function statusFor(
  env: NodeJS.ProcessEnv,
  dependencies: Parameters<typeof createRiskCustomsApiAdapterFromEnvironment>[1] = {},
  executionContext: ExecutionContext = context,
) {
  const adapter = createRiskCustomsApiAdapterFromEnvironment(env, dependencies);
  expect(adapter).toBeDefined();
  return adapter!.getStatus({ rule_date: "2026-08-21" }, executionContext);
}

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "riskcustoms-runtime-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("RiskCustoms runtime configuration", () => {
  it("stays disabled unless the server-side enablement and references are supplied", () => {
    expect(createRiskCustomsApiAdapterFromEnvironment({})).toBeUndefined();
  });

  it("constructs the M2M adapter and reads the token from the server-side secret file reference", async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const readSecretFile = vi.fn(() => "m2m-runtime-token\n");
    const adapter = createRiskCustomsApiAdapterFromEnvironment(
      runtimeEnv({ MCP_RISK_CUSTOMS_ALLOWED_TENANTS: " tenant-a, tenant-a " }),
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
      createRiskCustomsApiAdapterFromEnvironment(runtimeEnv({
        MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid",
      })),
    ).toBeUndefined();
  });

  it("does not create an adapter without an allowed tenant configuration", () => {
    expect(
      createRiskCustomsApiAdapterFromEnvironment(runtimeEnv({
        MCP_RISK_CUSTOMS_ALLOWED_TENANTS: undefined,
      })),
    ).toBeUndefined();
  });

  it.each([
    ["*", "wildcard"],
    ["tenant a", "whitespace"],
    ["1".repeat(129), "overlong identifier"],
  ])("does not create an adapter for an invalid allowed tenant (%s: %s)", (allowedTenants) => {
    expect(
      createRiskCustomsApiAdapterFromEnvironment(runtimeEnv({
        MCP_RISK_CUSTOMS_ALLOWED_TENANTS: allowedTenants,
      })),
    ).toBeUndefined();
  });

  it("fails closed before reading the secret or calling upstream for an unallowed tenant", async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const readSecretFile = vi.fn(() => "m2m-runtime-token");
    const result = await statusFor(
      runtimeEnv(),
      { fetchImpl, readSecretFile },
      { ...context, tenantId: "tenant-b" },
    );

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map(({ code }) => code)).toContain("customs.status_unavailable");
    expect(readSecretFile).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the server-side secret file returns an invalid token", async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const readSecretFile = vi.fn(() => "invalid token");
    const adapter = createRiskCustomsApiAdapterFromEnvironment(
      runtimeEnv(),
      { fetchImpl, readSecretFile },
    );

    const result = await adapter!.getStatus({ rule_date: "2026-08-21" }, context);

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map(({ code }) => code)).toContain("customs.status_unavailable");
    expect(readSecretFile).toHaveBeenCalledWith("/run/secrets/riskcustoms-m2m-token");
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("invalid token");
  });

  it("applies the byte limit to an injected secret reader", async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const oversized = "x".repeat(RISK_CUSTOMS_SECRET_MAX_BYTES + 1);
    const readSecretFile = vi.fn(() => oversized);

    const result = await statusFor(runtimeEnv(), { fetchImpl, readSecretFile });

    expect(result.status).toBe("unavailable");
    expect(readSecretFile).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(oversized);
  });

  it("reads a real regular secret file through the bounded default reader", async () => {
    await withTemporaryDirectory(async (directory) => {
      const secretPath = join(directory, "token");
      await writeFile(secretPath, "m2m-runtime-token\n", "utf8");
      const { calls, fetchImpl } = makeFetchSpy();

      const result = await statusFor(
        runtimeEnv({ MCP_RISK_CUSTOMS_AUTH_SECRET_FILE: secretPath }),
        { fetchImpl },
      );

      expect(result.status).toBe("success");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.headers.get("authorization")).toBe("Bearer m2m-runtime-token");
    });
  });

  it("fails closed for a symlink secret without exposing the path or token", async () => {
    await withTemporaryDirectory(async (directory) => {
      const targetPath = join(directory, "target");
      const secretPath = join(directory, "token");
      await writeFile(targetPath, "symlink-token\n", "utf8");
      await symlink(targetPath, secretPath);
      const { calls, fetchImpl } = makeFetchSpy();

      const result = await statusFor(
        runtimeEnv({ MCP_RISK_CUSTOMS_AUTH_SECRET_FILE: secretPath }),
        { fetchImpl },
      );

      expect(result.status).toBe("unavailable");
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(secretPath);
      expect(JSON.stringify(result)).not.toContain("symlink-token");
    });
  });

  it("fails closed when the secret file exceeds the byte limit", async () => {
    await withTemporaryDirectory(async (directory) => {
      const secretPath = join(directory, "token");
      const secret = "x".repeat(RISK_CUSTOMS_SECRET_MAX_BYTES + 1);
      await writeFile(secretPath, secret, "utf8");
      const { calls, fetchImpl } = makeFetchSpy();

      const result = await statusFor(
        runtimeEnv({ MCP_RISK_CUSTOMS_AUTH_SECRET_FILE: secretPath }),
        { fetchImpl },
      );

      expect(result.status).toBe("unavailable");
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(secretPath);
      expect(JSON.stringify(result)).not.toContain(secret);
    });
  });

  it("fails closed for a non-regular secret path", async () => {
    await withTemporaryDirectory(async (directory) => {
      const secretPath = join(directory, "secret-directory");
      await mkdir(secretPath);
      const { calls, fetchImpl } = makeFetchSpy();

      const result = await statusFor(
        runtimeEnv({ MCP_RISK_CUSTOMS_AUTH_SECRET_FILE: secretPath }),
        { fetchImpl },
      );

      expect(result.status).toBe("unavailable");
      expect(calls).toHaveLength(0);
    });
  });

  it.each([
    ["http://riskcustoms.example.invalid", "plain HTTP"],
    ["https://user:pass@riskcustoms.example.invalid", "URL credentials"],
  ])("does not create an adapter for %s (%s)", (baseUrl) => {
    expect(
      createRiskCustomsApiAdapterFromEnvironment(runtimeEnv({ MCP_RISK_CUSTOMS_BASE_URL: baseUrl })),
    ).toBeUndefined();
  });
});
