import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// @ts-expect-error TS7016: the browser-only app.js intentionally has no TypeScript declaration;
// this test imports its exported, side-effect-free validation/client helpers dynamically.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- the TS7016 suppression above is the intentional JS boundary.
const adminAppModule = await import("../../apps/admin/app.js");

type AccessResponse = {
  readonly schema_version: string;
  readonly status: string;
  readonly data: unknown;
  readonly reason_codes: readonly string[];
  readonly secret_delivery?: unknown;
};

type AccessFetch = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

type TenantAccessClient = {
  setToken(token: string): void;
  clearToken(): void;
  getState(): Promise<unknown>;
  createTenant(payload: unknown, idempotencyKey?: string): Promise<unknown>;
  setTenantStatus(tenantId: string, payload: unknown, idempotencyKey?: string): Promise<unknown>;
  issueCredential(payload: unknown, idempotencyKey?: string): Promise<unknown>;
  rotateCredential(credentialId: string, payload: unknown, idempotencyKey?: string): Promise<unknown>;
  revokeCredential(credentialId: string, payload: unknown, idempotencyKey?: string): Promise<unknown>;
  acknowledgeCredentialDelivery(credentialId: string, payload: unknown, idempotencyKey?: string): Promise<unknown>;
};

type TenantAccessAppModule = {
  readonly TENANT_ACCESS_SCHEMA_VERSION: string;
  readonly createTenantAccessClient: (options?: {
    readonly fetchImpl?: AccessFetch;
    readonly allowWrites?: boolean;
    readonly basePath?: string;
  }) => TenantAccessClient;
  readonly validateTenantAccessState: (value: unknown) => unknown;
};

const access = adminAppModule as unknown as TenantAccessAppModule;
const schemaVersion = "2026-08-27.v1";
const credentialId = "key_0123456789abcdef";
const tenantId = "tenant_demo_a";
const descriptorSecret = "A".repeat(43);
const apiKey = `lmcpk_${credentialId}_${descriptorSecret}`;
const availableTools = [
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
] as const;

const tenant = {
  tenant_id: tenantId,
  display_name: "北美演示租户",
  status: "active",
  created_at: "2026-08-27T00:00:00.000Z",
  updated_at: "2026-08-27T00:00:00.000Z",
  allowed_actions: ["suspend"],
} as const;

const credential = {
  credential_id: credentialId,
  tenant_id: tenantId,
  client_id: "codex_ops",
  label: "运营开发助手",
  actor_role: "service",
  roles: ["service"],
  tool_names: ["cargo.calculate", "container.plan_summary"],
  status: "active",
  delivery_status: "pending",
  delivery_acknowledged_at: null,
  effective_status: "pending_delivery",
  allowed_actions: ["acknowledge_delivery", "revoke"],
  key_prefix: "lmcpk_key_01234567",
  secret_last_four: "AAAA",
  created_at: "2026-08-27T00:00:00.000Z",
  expires_at: 1_802_505_600,
  last_used_at: null,
  revoked_at: null,
  rotated_from_id: null,
} as const;

const operation = {
  operation_id: "event_00000001",
  tenant_id: tenantId,
  credential_id: credentialId,
  actor_ref: "actor_admin:admin_console",
  action: "credential.issue",
  from_status: "absent",
  to_status: "pending_delivery",
  status: "success",
  reason_code: "operator_issued",
  created_at: "2026-08-27T00:00:00.000Z",
} as const;

const accessState = {
  available_tools: availableTools,
  tenants: [tenant],
  credentials: [credential],
  operations: [operation],
} as const;

function envelope(status: string, data: unknown, secretDelivery?: unknown): AccessResponse {
  return {
    schema_version: schemaVersion,
    status,
    data,
    reason_codes: status === "success" ? [] : ["access.operation_not_completed"],
    ...(secretDelivery === undefined ? {} : { secret_delivery: secretDelivery }),
  };
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url, "http://127.0.0.1").pathname;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Tenant Access 管理控制台切片", () => {
  it("提供独立导航、中文视图、一次性凭证容器和脱敏列表边界", async () => {
    const [html, app, css] = await Promise.all([
      readFile(new URL("../../apps/admin/index.html", import.meta.url), "utf8"),
      readFile(new URL("../../apps/admin/app.js", import.meta.url), "utf8"),
      readFile(new URL("../../apps/admin/styles.css", import.meta.url), "utf8"),
    ]);

    expect(html).toContain('data-view="tenant-access"');
    expect(html).toContain("租户与 API Key");
    expect(html).toContain('id="access-identity-dialog"');
    expect(html).toContain('id="one-time-credential-dialog"');
    expect(html).toContain('id="one-time-credential-body"');
    expect(html).toContain('id="credential-tool-dialog"');
    expect(html).toContain('id="credential-tool-form"');
    expect(app).toContain("/admin/api/v1/access/state");
    expect(app).toContain("renderTenantAccess");
    expect(app).toContain("secret_last_four");
    expect(app).toContain("key_prefix");
    expect(app).toContain("复制后无法恢复");
    expect(app).toContain("createTenant");
    expect(app).toContain("setTenantStatus");
    expect(app).toContain("issueCredential");
    expect(app).toContain("rotateCredential");
    expect(app).toContain("revokeCredential");
    expect(app).toContain("acknowledgeCredentialDelivery");
    expect(app).toContain("操作状态流转");
    expect(app).toContain("确认已安全保存");
    expect(app).toContain("operation_id");
    expect(app).toContain("delivery_status");
    expect(app).toContain("可调用插件功能");
    expect(app).toContain("调整功能并轮换");
    expect(app).toContain("tool_names");
    expect(app).toContain('target.form?.id === "credential-tool-form"');
    expect(app).toMatch(/Bearer/);
    expect(app).toMatch(/idempotency-key/i);
    expect(app).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(app).not.toMatch(/apiKey[^\n]*(?:location|storage|cookie)/i);
    expect(css).toContain("tenant-access");
    expect(css).toContain("one-time-credential");
    expect(css).toContain("credential-tool-dialog");
  });

  it("validates only redacted Tenant Access state and rejects a persisted full key", () => {
    expect(access.TENANT_ACCESS_SCHEMA_VERSION).toBe(schemaVersion);
    expect(access.validateTenantAccessState(accessState)).toEqual(accessState);
    expect(() => access.validateTenantAccessState({
      ...accessState,
      credentials: [{ ...credential, api_key: apiKey }],
    })).toThrow();
    expect(() => access.validateTenantAccessState({
      ...accessState,
      operations: [{ ...operation, to_status: "active" }],
    })).toThrow(/操作状态流转/);
    expect(() => access.validateTenantAccessState({
      ...accessState,
      credentials: [{ ...credential, allowed_actions: ["rotate", "revoke"] }],
    })).toThrow(/allowed_actions/);
    expect(() => access.validateTenantAccessState({
      ...accessState,
      credentials: [{
        ...credential,
        tool_names: ["quote.save_draft"],
      }],
    })).toThrow(/tool_names/);
  });

  it("sends Bearer and idempotency headers on every Access request and covers all paths", async () => {
    const requests: Array<{ readonly path: string; readonly init: RequestInit }> = [];
    const client = access.createTenantAccessClient({
      fetchImpl: ((input, init) => {
        const path = requestPath(input);
        requests.push({ path, init: init ?? {} });
        if (path.endsWith("/state")) return jsonResponse(envelope("success", accessState));
        if (path.endsWith("/tenants") && init?.method === "POST") {
          return jsonResponse(envelope("success", { tenant, operation }));
        }
        if (path.endsWith("/status")) return jsonResponse(envelope("success", { tenant, operation }));
        if (path.endsWith("/credentials") && init?.method === "POST") {
          return jsonResponse(envelope("success", { credential, api_key: apiKey, operation }, {
            status: "one_time",
            credential_id: credentialId,
          }));
        }
        if (path.endsWith("/rotate")) {
          return jsonResponse(envelope("success", { credential, api_key: apiKey, operation }, {
            status: "one_time",
            credential_id: credentialId,
          }));
        }
        if (path.endsWith("/revoke")) return jsonResponse(envelope("success", { credential, operation }));
        if (path.endsWith("/acknowledge-delivery")) {
          return jsonResponse(envelope("success", {
            credential: {
              ...credential,
              delivery_status: "acknowledged",
              delivery_acknowledged_at: "2026-08-27T00:01:00.000Z",
              effective_status: "active",
              allowed_actions: ["rotate", "revoke"],
            },
            operation: {
              ...operation,
              operation_id: "event_00000002",
              action: "credential.delivery_acknowledge",
              from_status: "pending_delivery",
              to_status: "active",
              reason_code: "operator_confirmed_secure_storage",
            },
          }));
        }
        return jsonResponse(envelope("unavailable", null), 503);
      }) satisfies AccessFetch,
    });
    client.setToken("memory-only-bearer");

    await expect(client.getState()).resolves.toEqual(accessState);
    await expect(client.createTenant({
      schema_version: schemaVersion,
      tenant_id: "tenant_new",
      display_name: "新租户",
    }, "create-tenant-idem-0001")).resolves.toMatchObject({ tenant });
    await expect(client.setTenantStatus(tenantId, {
      schema_version: schemaVersion,
      status: "suspended",
      reason_code: "operator_suspended",
    }, "suspend-tenant-idem-0001")).resolves.toMatchObject({ tenant });
    await expect(client.issueCredential({
      schema_version: schemaVersion,
      tenant_id: tenantId,
      client_id: "codex_ops",
      label: "运营开发助手",
      tool_names: ["cargo.calculate"],
      expires_in_seconds: 86_400,
    }, "issue-credential-idem-0001")).resolves.toMatchObject({ api_key: apiKey });
    await expect(client.rotateCredential(credentialId, {
      schema_version: schemaVersion,
      tool_names: ["cargo.calculate"],
      expires_in_seconds: 86_400,
      reason_code: "scheduled_rotation",
    }, "rotate-credential-idem-0001")).resolves.toMatchObject({ api_key: apiKey });
    await expect(client.revokeCredential(credentialId, {
      schema_version: schemaVersion,
      reason_code: "operator_revoked",
    }, "revoke-credential-idem-0001")).resolves.toMatchObject({ credential });
    await expect(client.acknowledgeCredentialDelivery(credentialId, {
      schema_version: schemaVersion,
      reason_code: "operator_confirmed_secure_storage",
    }, "ack-credential-idem-0001")).resolves.toMatchObject({
      credential: { delivery_status: "acknowledged", effective_status: "active" },
    });

    expect(requests.map((request) => request.path)).toEqual([
      "/admin/api/v1/access/state",
      "/admin/api/v1/access/tenants",
      "/admin/api/v1/access/tenants/tenant_demo_a/status",
      "/admin/api/v1/access/credentials",
      "/admin/api/v1/access/credentials/key_0123456789abcdef/rotate",
      "/admin/api/v1/access/credentials/key_0123456789abcdef/revoke",
      "/admin/api/v1/access/credentials/key_0123456789abcdef/acknowledge-delivery",
    ]);
    const issueBody = requests[3]?.init.body;
    const rotateBody = requests[4]?.init.body;
    if (typeof issueBody !== "string" || typeof rotateBody !== "string") {
      throw new Error("expected JSON request bodies");
    }
    const issuePayload: unknown = JSON.parse(issueBody);
    const rotatePayload: unknown = JSON.parse(rotateBody);
    expect(issuePayload).toMatchObject({
      tool_names: ["cargo.calculate"],
    });
    expect(issuePayload).not.toHaveProperty("scopes");
    expect(rotatePayload).toMatchObject({
      tool_names: ["cargo.calculate"],
    });
    for (const request of requests) {
      const headers = new Headers(request.init.headers);
      expect(headers.get("authorization")).toBe("Bearer memory-only-bearer");
      expect(request.init.credentials).toBe("omit");
      if (request.init.method === "POST") {
        expect(headers.get("idempotency-key")).toBeTruthy();
        expect(headers.get("idempotency-key")?.length).toBeGreaterThanOrEqual(16);
      }
    }
  });

  it("does not expose replayed secrets and keeps non-fixture writes fail closed", async () => {
    const replayRequests: Array<{ readonly path: string; readonly init: RequestInit }> = [];
    const replayClient = access.createTenantAccessClient({
      fetchImpl: ((input, init) => {
        replayRequests.push({ path: requestPath(input), init: init ?? {} });
        return jsonResponse(envelope("manual_review", {
          credential,
          api_key: null,
        }, {
          status: "withheld",
          credential_id: credentialId,
        }), 409);
      }) satisfies AccessFetch,
    });
    replayClient.setToken("memory-only-bearer");
    await expect(replayClient.issueCredential({
      schema_version: schemaVersion,
      tenant_id: tenantId,
      client_id: "codex_ops",
      label: "运营开发助手",
      tool_names: ["cargo.calculate"],
      expires_in_seconds: 86_400,
    }, "issue-replay-idempotency-0001")).rejects.toMatchObject({ status: "manual_review" });
    expect(replayRequests).toHaveLength(1);

    const liveRequests: string[] = [];
    const liveClient = access.createTenantAccessClient({
      allowWrites: false,
      fetchImpl: ((input) => {
        liveRequests.push(requestPath(input));
        return jsonResponse(envelope("success", { tenant }));
      }) satisfies AccessFetch,
    });
    liveClient.setToken("memory-only-bearer");
    await expect(liveClient.createTenant({
      schema_version: schemaVersion,
      tenant_id: "tenant_new",
      display_name: "不应写入",
    }, "live-write-idempotency-0001")).rejects.toMatchObject({ status: "blocked" });
    expect(liveRequests).toEqual([]);
  });
});
