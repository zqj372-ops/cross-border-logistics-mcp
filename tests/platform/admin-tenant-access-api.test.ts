import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAdminTenantAccessApiHandler,
  type AdminTenantAccessApiHandler,
} from "../../src/logistics_mcp/server/admin-tenant-access-api";
import { TENANT_ACCESS_SCHEMA_VERSION } from "../../src/logistics_mcp/control-plane/tenant-access-service";

const managementTenantId = "tenant_management";
const tenant = {
  tenant_id: "tenant_demo_a",
  display_name: "北美演示租户",
  status: "active",
  created_at: "2026-08-27T00:00:00.000Z",
  updated_at: "2026-08-27T00:00:00.000Z",
} as const;
const credential = {
  credential_id: "key_00000001",
  tenant_id: tenant.tenant_id,
  client_id: "codex_ops",
  label: "运营 Codex",
  actor_role: "service",
  roles: ["service"],
  tool_names: ["cargo.calculate"],
  status: "active",
  key_prefix: "lmcpk_key_00000001",
  secret_last_four: "AAAA",
  created_at: "2026-08-27T00:00:00.000Z",
  expires_at: 1_802_505_600,
  last_used_at: null,
  revoked_at: null,
  rotated_from_id: null,
} as const;
const apiKey = `lmcpk_key_00000001_${"A".repeat(43)}`;

const getState = vi.fn(() => Promise.resolve({
  schema_version: TENANT_ACCESS_SCHEMA_VERSION,
  status: "success",
  data: {
    available_tools: [
      {
        tool_name: "cargo.calculate",
        kind: "read",
      },
      {
        tool_name: "container.plan_summary",
        kind: "read",
      },
      {
        tool_name: "system.agent_context.get",
        kind: "read",
      },
    ],
    tenants: [tenant],
    credentials: [credential],
    operations: [],
  },
  reason_codes: [],
}));
const createTenant = vi.fn(() => Promise.resolve({
  schema_version: TENANT_ACCESS_SCHEMA_VERSION,
  status: "success",
  replayed: false,
  data: { tenant },
  reason_codes: [],
}));
const setTenantStatus = vi.fn(() => Promise.resolve({
  schema_version: TENANT_ACCESS_SCHEMA_VERSION,
  status: "success",
  replayed: false,
  data: { tenant },
  reason_codes: [],
}));
const issueCredential = vi.fn<() => Promise<unknown>>(() => Promise.resolve({
  schema_version: TENANT_ACCESS_SCHEMA_VERSION,
  status: "success",
  replayed: false,
  secret_delivery: { status: "one_time", credential_id: credential.credential_id },
  data: { credential, api_key: apiKey },
  reason_codes: [],
}));
const rotateCredential = vi.fn(() => Promise.resolve({
  schema_version: TENANT_ACCESS_SCHEMA_VERSION,
  status: "success",
  replayed: false,
  secret_delivery: { status: "one_time", credential_id: credential.credential_id },
  data: { credential, api_key: apiKey },
  reason_codes: [],
}));
const revokeCredential = vi.fn(() => Promise.resolve({
  schema_version: TENANT_ACCESS_SCHEMA_VERSION,
  status: "success",
  replayed: false,
  data: { credential: { ...credential, status: "revoked", revoked_at: "2026-08-27T00:00:00.000Z" } },
  reason_codes: [],
}));
const acknowledgeCredentialDelivery = vi.fn(() => Promise.resolve({
  schema_version: TENANT_ACCESS_SCHEMA_VERSION,
  status: "success",
  replayed: false,
  data: { credential },
  reason_codes: [],
}));
const authenticate = vi.fn(() => ({
  tenant_id: managementTenantId,
  actor_id: "admin_operator",
  actor_role: "admin",
  roles: ["admin"],
  scopes: ["platform:admin", "tenant:admin"],
  client_id: "admin_console",
  session_id: "admin_session",
  expires_at: Math.floor(Date.now() / 1_000) + 3_600,
}));

function service() {
  return {
    getState,
    createTenant,
    setTenantStatus,
    issueCredential,
    rotateCredential,
    revokeCredential,
    acknowledgeCredentialDelivery,
  };
}

async function listen(
  dataMode: "fixtures" | "production",
  options: {
    readonly allowLoopbackHttp?: boolean;
    readonly productionWritesEnabled?: boolean;
    readonly trustedProxyAddresses?: readonly string[];
  } = {},
): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  const ref: { current?: AdminTenantAccessApiHandler } = {};
  const server = createServer((request, response) => {
    if (ref.current?.handle(request, response) !== true) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  const host = `127.0.0.1:${address.port}`;
  const url = `http://${host}`;
  ref.current = createAdminTenantAccessApiHandler({
    dataMode,
    ...(options.productionWritesEnabled === undefined
      ? {}
      : { productionWritesEnabled: options.productionWritesEnabled }),
    ...(options.trustedProxyAddresses === undefined
      ? {}
      : { trustedProxyAddresses: options.trustedProxyAddresses }),
    service: service(),
    authenticate,
    managementTenantId,
    allowedOrigins: [url],
    allowedHosts: [host],
    allowLoopbackHttp: options.allowLoopbackHttp ?? true,
    maxBodyBytes: 32 * 1024,
  });
  return { server, url };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function request(
  url: string,
  path: string,
  options: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly key?: string;
    readonly forwardedProto?: "https";
  } = {},
): Promise<Response> {
  const method = options.method ?? "POST";
  return fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: "Bearer fixture-admin-token",
      ...(options.forwardedProto === undefined
        ? {}
        : { "x-forwarded-proto": options.forwardedProto }),
      ...(method === "POST" ? {
        origin: url,
        "content-type": "application/json",
        "idempotency-key": options.key ?? "tenant-access-idem-0001",
      } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Admin Tenant Access API", () => {
  it("authenticates the management admin and serves redacted state", async () => {
    const { server, url } = await listen("fixtures");
    try {
      const response = await request(url, "/admin/api/v1/access/state", { method: "GET" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "success",
        data: { tenants: [tenant], credentials: [credential] },
      });
      expect(getState).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });

  it("dispatches every lifecycle endpoint with closed bodies and idempotency", async () => {
    const { server, url } = await listen("fixtures");
    try {
      const cases = [
        ["/admin/api/v1/access/tenants", {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          tenant_id: tenant.tenant_id,
          display_name: tenant.display_name,
        }, "create-tenant-idem-0001"],
        [`/admin/api/v1/access/tenants/${tenant.tenant_id}/status`, {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          status: "suspended",
          reason_code: "operator_suspended",
        }, "status-tenant-idem-0001"],
        ["/admin/api/v1/access/credentials", {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          tenant_id: tenant.tenant_id,
          client_id: "codex_ops",
          label: "运营 Codex",
          tool_names: ["cargo.calculate"],
          expires_in_seconds: 86_400,
        }, "issue-credential-idem-0001"],
        [`/admin/api/v1/access/credentials/${credential.credential_id}/rotate`, {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          tool_names: ["system.agent_context.get"],
          expires_in_seconds: 86_400,
          reason_code: "scheduled_rotation",
        }, "rotate-credential-idem-0001"],
        [`/admin/api/v1/access/credentials/${credential.credential_id}/revoke`, {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          reason_code: "operator_revoked",
        }, "revoke-credential-idem-0001"],
        [`/admin/api/v1/access/credentials/${credential.credential_id}/acknowledge-delivery`, {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          reason_code: "operator_confirmed_secure_storage",
        }, "ack-credential-idem-0001"],
      ] as const;
      for (const [path, body, key] of cases) {
        const response = await request(url, path, { body, key });
        expect([200, 201]).toContain(response.status);
      }
      expect(createTenant).toHaveBeenCalledWith(expect.anything(), cases[0][1], cases[0][2]);
      expect(setTenantStatus).toHaveBeenCalledWith(expect.anything(), tenant.tenant_id, cases[1][1], cases[1][2]);
      expect(issueCredential).toHaveBeenCalledWith(expect.anything(), cases[2][1], cases[2][2]);
      expect(rotateCredential).toHaveBeenCalledWith(expect.anything(), credential.credential_id, cases[3][1], cases[3][2]);
      expect(revokeCredential).toHaveBeenCalledWith(expect.anything(), credential.credential_id, cases[4][1], cases[4][2]);
      expect(acknowledgeCredentialDelivery).toHaveBeenCalledWith(
        expect.anything(),
        credential.credential_id,
        cases[5][1],
        cases[5][2],
      );
    } finally {
      await close(server);
    }
  });

  it("rejects unknown body fields and missing tenant:admin before service", async () => {
    const { server, url } = await listen("fixtures");
    try {
      const strict = await request(url, "/admin/api/v1/access/tenants", {
        body: {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          tenant_id: tenant.tenant_id,
          display_name: tenant.display_name,
          api_key: "must-not-be-accepted",
        },
      });
      expect(strict.status).toBe(400);
      expect(createTenant).not.toHaveBeenCalled();

      authenticate.mockReturnValueOnce({
        tenant_id: managementTenantId,
        actor_id: "admin_operator",
        actor_role: "admin",
        roles: ["admin"],
        scopes: ["platform:admin"],
        client_id: "admin_console",
        session_id: "admin_session",
        expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      });
      const denied = await request(url, "/admin/api/v1/access/tenants", {
        body: {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          tenant_id: tenant.tenant_id,
          display_name: tenant.display_name,
        },
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ reason_codes: ["tenant_admin_scope_required"] });
      expect(createTenant).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it.each([
    "/admin/api/v1/access/tenants",
    `/admin/api/v1/access/tenants/${tenant.tenant_id}/status`,
    "/admin/api/v1/access/credentials",
    `/admin/api/v1/access/credentials/${credential.credential_id}/rotate`,
    `/admin/api/v1/access/credentials/${credential.credential_id}/revoke`,
    `/admin/api/v1/access/credentials/${credential.credential_id}/acknowledge-delivery`,
  ])("blocks production POST %s before auth and service", async (path) => {
    const { server, url } = await listen("production");
    try {
      const response = await request(url, path);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        status: "blocked",
        reason_codes: ["tenant_access_production_disabled_v1"],
      });
      expect(authenticate).not.toHaveBeenCalled();
      expect(getState).not.toHaveBeenCalled();
      expect(createTenant).not.toHaveBeenCalled();
      expect(issueCredential).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("allows an explicitly enabled production tenant write after boundary and admin auth", async () => {
    const { server, url } = await listen("production", { productionWritesEnabled: true });
    try {
      const response = await request(url, "/admin/api/v1/access/tenants", {
        body: {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          tenant_id: tenant.tenant_id,
          display_name: tenant.display_name,
        },
        key: "production-tenant-idem-0001",
      });
      expect(response.status).toBe(201);
      expect(createTenant).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });

  it("accepts HTTPS only from an explicitly trusted reverse proxy", async () => {
    const { server, url } = await listen("production", {
      allowLoopbackHttp: false,
      productionWritesEnabled: true,
      trustedProxyAddresses: ["127.0.0.1"],
    });
    try {
      const response = await request(url, "/admin/api/v1/access/state", {
        method: "GET",
        forwardedProto: "https",
      });
      expect(response.status).toBe(200);

      const missingProof = await request(url, "/admin/api/v1/access/state", { method: "GET" });
      expect(missingProof.status).toBe(403);
      expect(await missingProof.json()).toMatchObject({
        reason_codes: ["admin_https_required"],
      });
    } finally {
      await close(server);
    }
  });

  it("rejects auth in query/cookie and maps one-time replay to HTTP 409", async () => {
    const { server, url } = await listen("fixtures");
    try {
      const query = await fetch(`${url}/admin/api/v1/access/state?token=leak`, {
        headers: { authorization: "Bearer fixture-admin-token" },
      });
      expect(query.status).toBe(401);
      const cookie = await fetch(`${url}/admin/api/v1/access/state`, {
        headers: { authorization: "Bearer fixture-admin-token", cookie: "token=leak" },
      });
      expect(cookie.status).toBe(401);
      issueCredential.mockResolvedValueOnce({
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "manual_review",
        replayed: true,
        secret_delivery: { status: "withheld", credential_id: credential.credential_id },
        data: { credential, api_key: null },
        reason_codes: ["credential_secret.withheld"],
      });
      const replay = await request(url, "/admin/api/v1/access/credentials", {
        body: {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          tenant_id: tenant.tenant_id,
          client_id: "codex_ops",
          label: "运营 Codex",
          tool_names: ["cargo.calculate"],
          expires_in_seconds: 86_400,
        },
      });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({
        status: "manual_review",
        data: { api_key: null },
        secret_delivery: { status: "withheld" },
      });
    } finally {
      await close(server);
    }
  });
});
