import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCESS_OPERATIONS_SCHEMA_VERSION,
  createAccessOperationsAdminHandler,
  summarizeAccessOperations,
} from "../../services/access-gateway/operations-overview";
import {
  initializeSqliteGatewayOperationalState,
  SqliteGatewayOperationalStore,
} from "../../services/access-gateway/production-store";
import type { AccessState } from "../../services/access-gateway/contracts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateFixture(): AccessState {
  return Object.freeze({
    tenants: Object.freeze([
      Object.freeze({
        tenantId: "tenant_active",
        displayName: "Active",
        status: "active" as const,
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
        version: 1,
      }),
      Object.freeze({
        tenantId: "tenant_suspended",
        displayName: "Suspended",
        status: "suspended" as const,
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
        version: 1,
      }),
    ]),
    clients: Object.freeze([
      Object.freeze({
        clientId: "client_active",
        tenantId: "tenant_active",
        label: "Active client",
        status: "active" as const,
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
        version: 1,
      }),
      Object.freeze({
        clientId: "client_disabled",
        tenantId: "tenant_active",
        label: "Disabled client",
        status: "disabled" as const,
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
        version: 1,
      }),
    ]),
    credentials: Object.freeze([
      Object.freeze({
        credentialId: "key_active",
        tenantId: "tenant_active",
        clientId: "client_active",
        label: "Active key",
        actorRole: "service" as const,
        roles: Object.freeze(["service"] as const),
        toolNames: Object.freeze(["cargo.calculate"] as const),
        scopes: Object.freeze(["tool:cargo.calculate"] as const),
        status: "active" as const,
        deliveryStatus: "acknowledged" as const,
        deliveryAcknowledgedAt: "2026-08-30T00:01:00.000Z",
        effectiveStatus: "active" as const,
        keyPrefix: "lmcpk_key_active",
        secretLastFour: "0001",
        pepperVersion: "pepper-v1",
        createdAt: "2026-08-30T00:00:00.000Z",
        expiresAt: 1_900_000_000,
        lastUsedAt: "2026-08-30T00:02:00.000Z",
        revokedAt: null,
        rotatedFromId: null,
        version: 1,
      }),
      Object.freeze({
        credentialId: "key_pending",
        tenantId: "tenant_active",
        clientId: "client_active",
        label: "Pending key",
        actorRole: "service" as const,
        roles: Object.freeze(["service"] as const),
        toolNames: Object.freeze(["container.plan_summary"] as const),
        scopes: Object.freeze(["tool:container.plan_summary"] as const),
        status: "active" as const,
        deliveryStatus: "pending" as const,
        deliveryAcknowledgedAt: null,
        effectiveStatus: "pending_delivery" as const,
        keyPrefix: "lmcpk_key_pending",
        secretLastFour: "0002",
        pepperVersion: "pepper-v1",
        createdAt: "2026-08-30T00:00:00.000Z",
        expiresAt: 1_900_000_000,
        lastUsedAt: null,
        revokedAt: null,
        rotatedFromId: null,
        version: 1,
      }),
    ]),
    operations: Object.freeze([]),
  });
}

describe("Access operations overview", () => {
  it("validates a closed response contract", () => {
    const schemaPath = fileURLToPath(new URL(
      "../../schemas/access-gateway/admin-operations-overview-response.schema.json",
      import.meta.url,
    ));
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
      JSON.parse(readFileSync(schemaPath, "utf8")) as object,
    );
    const response = summarizeAccessOperations({
      state: stateFixture(),
      generatedAt: "2026-08-30T12:00:00.000Z",
      activity: {
        windowStartedAt: "2026-08-29T12:00:00.000Z",
        totalAuditEvents: 0,
        statusCounts: {
          success: 0,
          needs_input: 0,
          manual_review: 0,
          blocked: 0,
          unavailable: 0,
        },
        recentIssues: Object.freeze([]),
      },
    });
    expect(validate(response), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...response, unexpected: true })).toBe(false);
  });

  it("fails closed when audit totals or timestamps are corrupt", () => {
    expect(() => summarizeAccessOperations({
      state: stateFixture(),
      generatedAt: "2026-08-30T12:00:00.000Z",
      activity: {
        windowStartedAt: "2026-08-29T12:00:00.000Z",
        totalAuditEvents: 2,
        statusCounts: {
          success: 1,
          needs_input: 0,
          manual_review: 0,
          blocked: 0,
          unavailable: 0,
        },
        recentIssues: Object.freeze([]),
      },
    })).toThrow("inconsistent");

    expect(() => summarizeAccessOperations({
      state: stateFixture(),
      generatedAt: "2026-08-30T12:00:00.000Z",
      activity: {
        windowStartedAt: "2026-99-29T12:00:00.000Z",
        totalAuditEvents: 0,
        statusCounts: {
          success: 0,
          needs_input: 0,
          manual_review: 0,
          blocked: 0,
          unavailable: 0,
        },
        recentIssues: Object.freeze([]),
      },
    })).toThrow("metadata");
  });

  it("returns bounded aggregate counts and a credential-free Agent onboarding contract", () => {
    const result = summarizeAccessOperations({
      state: stateFixture(),
      generatedAt: "2026-08-30T12:00:00.000Z",
      activity: {
        windowStartedAt: "2026-08-29T12:00:00.000Z",
        totalAuditEvents: 3,
        statusCounts: {
          success: 1,
          needs_input: 0,
          manual_review: 1,
          blocked: 1,
          unavailable: 0,
        },
        recentIssues: Object.freeze([
          Object.freeze({
            auditRef: "audit_problem_01",
            action: "token.exchange",
            status: "blocked" as const,
            reasonCode: "authentication_failed",
            createdAt: "2026-08-30T11:59:00.000Z",
          }),
        ]),
      },
    });

    expect(result).toMatchObject({
      schema_version: ACCESS_OPERATIONS_SCHEMA_VERSION,
      status: "success",
      data: {
        access_state: {
          tenants: { total: 2, active: 1, suspended: 1 },
          clients: { total: 2, active: 1, disabled: 1 },
          credentials: {
            total: 2,
            active: 1,
            pending_delivery: 1,
            tenant_suspended: 0,
            client_disabled: 0,
            expired: 0,
            revoked: 0,
          },
        },
        gateway_activity: {
          total_audit_events: 3,
          recent_issues: [{ audit_ref: "audit_problem_01" }],
        },
        agent_onboarding: {
          supported_clients: ["chatgpt-work", "codex", "enterprise-assistant"],
          token_exchange_path: "/access/v1/token/exchange",
          mcp_path: "/mcp",
          tool_names: [
            "cargo.calculate",
            "container.plan_summary",
            "system.agent_context.get",
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /key_active|key_pending|lmcpk_|secret|request_hash|jti|tenant_active|client_active/u,
    );
  });

  it("summarizes a fixed audit window in SQLite without returning credential identifiers", async () => {
    const root = mkdtempSync(join(tmpdir(), "access-operations-overview-"));
    roots.push(root);
    mkdirSync(join(root, ".runtime"));
    await initializeSqliteGatewayOperationalState({
      applicationRoot: root,
      instanceId: "gateway_01",
    });
    const store = new SqliteGatewayOperationalStore({
      applicationRoot: root,
      instanceId: "gateway_01",
    });
    await store.append({
      auditId: "audit_success_01",
      action: "token.exchange",
      status: "success",
      requestId: "request_success_01",
      tenantId: "tenant_private",
      clientId: "client_private",
      credentialId: "credential_private",
      toolNames: ["cargo.calculate"],
      requestHash: "hash_private",
      jti: "jti_private",
      reasonCode: null,
      createdAt: "2026-08-30T11:55:00.000Z",
    });
    await store.append({
      auditId: "audit_blocked_01",
      action: "token.exchange",
      status: "blocked",
      requestId: "request_blocked_01",
      tenantId: null,
      clientId: null,
      credentialId: null,
      toolNames: [],
      requestHash: "hash_blocked_private",
      jti: null,
      reasonCode: "authentication_failed",
      createdAt: "2026-08-30T11:56:00.000Z",
    });
    await store.append({
      auditId: "audit_old_01",
      action: "token.exchange",
      status: "unavailable",
      requestId: "request_old_01",
      tenantId: null,
      clientId: null,
      credentialId: null,
      toolNames: [],
      requestHash: "hash_old_private",
      jti: null,
      reasonCode: "old_failure",
      createdAt: "2026-08-28T11:59:00.000Z",
    });

    const summary = await store.summarize({
      windowStartedAt: "2026-08-29T12:00:00.000Z",
      issueLimit: 20,
    });
    expect(summary).toEqual({
      windowStartedAt: "2026-08-29T12:00:00.000Z",
      totalAuditEvents: 2,
      statusCounts: {
        success: 1,
        needs_input: 0,
        manual_review: 0,
        blocked: 1,
        unavailable: 0,
      },
      recentIssues: [{
        auditRef: "audit_blocked_01",
        action: "token.exchange",
        status: "blocked",
        reasonCode: "authentication_failed",
        createdAt: "2026-08-30T11:56:00.000Z",
      }],
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /credential_private|tenant_private|client_private|request_|hash_|jti_/u,
    );
    await store.close();
  });

  it("serves the overview only to an authenticated management administrator", async () => {
    const authenticate = vi.fn((token: string) => {
      if (token !== "valid-admin-token") return Promise.reject(new Error("invalid"));
      return Promise.resolve({
        tenantId: "tenant_management",
        actorId: "admin_operator",
        role: "admin" as const,
        roles: ["admin"] as const,
        scopes: ["platform:admin", "tenant:admin"] as const,
      });
    });
    const allowedHosts = ["127.0.0.1"];
    const handler = createAccessOperationsAdminHandler({
      authenticate,
      managementTenantId: "tenant_management",
      allowedHosts,
      trustedProxyAddresses: [],
      allowLoopbackHttp: true,
      readState: () => Promise.resolve(stateFixture()),
      readActivity: ({ windowStartedAt }) => Promise.resolve({
        windowStartedAt,
        totalAuditEvents: 0,
        statusCounts: {
          success: 0,
          needs_input: 0,
          manual_review: 0,
          blocked: 0,
          unavailable: 0,
        },
        recentIssues: Object.freeze([]),
      }),
      nowSeconds: () => 1_777_550_400,
    });
    const server = createServer((request, response) => {
      if (!handler.handle(request, response)) {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("port unavailable");
    const host = `127.0.0.1:${address.port}`;
    allowedHosts.push(host);

    const denied = await fetch(`http://${host}/admin/api/v1/access/overview`);
    expect(denied.status).toBe(401);
    expect(authenticate).not.toHaveBeenCalled();

    const allowed = await fetch(`http://${host}/admin/api/v1/access/overview`, {
      headers: {
        Authorization: "Bearer valid-admin-token",
      },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("permissions-policy")).toContain("camera=()");
    expect(await allowed.json()).toMatchObject({
      schema_version: ACCESS_OPERATIONS_SCHEMA_VERSION,
      status: "success",
    });
    expect(authenticate).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error === undefined ? resolvePromise() : reject(error));
    });
  });
});
