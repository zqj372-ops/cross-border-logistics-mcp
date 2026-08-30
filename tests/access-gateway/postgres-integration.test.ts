import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { migrateSqliteGatewayToPostgres } from "../../services/access-gateway/postgres-migration";
import {
  PostgresGatewayStore,
  createPostgresPool,
  postgresConfigurationFromEnvironment,
} from "../../services/access-gateway/postgres-store";
import {
  SqliteGatewayOperationalStore,
  initializeSqliteGatewayOperationalState,
} from "../../services/access-gateway/production-store";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  SqliteTenantAccessStore,
  initializeSqliteTenantAccessState,
} from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import {
  TENANT_ACCESS_SCHEMA_VERSION,
  TenantAccessService,
} from "../../src/logistics_mcp/control-plane/tenant-access-service";

const enabled = process.env.ACCESS_GATEWAY_TEST_POSTGRES === "1";
const roots: string[] = [];
const schemas: string[] = [];

function admin() {
  return parseExecutionContext({
    tenant_id: "tenant_management",
    actor_id: "admin_operator",
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin", "tenant:admin"],
    client_id: "postgres_integration",
    session_id: "postgres_integration_session",
    expires_at: 1_900_000_000,
  });
}

afterAll(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (!enabled) return;
  for (const schema of schemas.splice(0)) {
    const configuration = postgresConfigurationFromEnvironment({
      ...process.env,
      ACCESS_GATEWAY_POSTGRES_SCHEMA: schema,
    });
    const pool = createPostgresPool(configuration);
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  }
});

(enabled ? describe : describe.skip)("PostgreSQL Access Gateway integration", () => {
  it("migrates SQLite exactly and preserves transactional state, audit and rate limits", async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "logistics-mcp-postgres-integration-"));
    roots.push(sourceRoot);
    mkdirSync(join(sourceRoot, ".runtime"), { mode: 0o700 });
    await initializeSqliteTenantAccessState({
      applicationRoot: sourceRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    await initializeSqliteGatewayOperationalState({
      applicationRoot: sourceRoot,
      instanceId: "gateway_01",
    });
    const sqlite = new SqliteTenantAccessStore({
      applicationRoot: sourceRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    const sqliteService = new TenantAccessService(sqlite, {
      clock: () => 1_800_000_000,
      idGenerator: (() => {
        let sequence = 0;
        return (prefix: "event" | "key") => `${prefix}_${String(++sequence).padStart(8, "0")}`;
      })(),
      secretGenerator: () => "A".repeat(43),
      saltGenerator: () => new Uint8Array(16).fill(3),
    });
    await sqliteService.createTenant(admin(), {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo",
      display_name: "Demo",
    }, "postgres-create-tenant-0001");
    const issued = await sqliteService.issueCredential(admin(), {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo",
      client_id: "codex_ops",
      label: "Codex",
      tool_names: ["cargo.calculate"],
      expires_in_seconds: 86_400,
    }, "postgres-issue-key-0001");
    await sqliteService.acknowledgeCredentialDelivery(admin(), issued.data.credential.credential_id, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "operator_confirmed_secure_storage",
    }, "postgres-ack-key-0001");
    await sqlite.close();
    const sqliteOperations = new SqliteGatewayOperationalStore({
      applicationRoot: sourceRoot,
      instanceId: "gateway_01",
      rateLimitPerMinute: 2,
    });
    await sqliteOperations.append({
      auditId: "audit_00000001",
      action: "token.exchange",
      status: "success",
      requestId: "req_00000001",
      tenantId: "tenant_demo",
      clientId: "codex_ops",
      credentialId: issued.data.credential.credential_id,
      toolNames: ["cargo.calculate"],
      requestHash: `sha256:v1:${"a".repeat(64)}`,
      jti: "jwt_00000001",
      reasonCode: null,
      createdAt: "2027-01-15T08:00:00.000Z",
    });
    await sqliteOperations.close();

    const schema = `access_gateway_test_${Date.now().toString(36)}`;
    schemas.push(schema);
    const configuration = postgresConfigurationFromEnvironment({
      ...process.env,
      ACCESS_GATEWAY_POSTGRES_SCHEMA: schema,
    });
    const migration = await migrateSqliteGatewayToPostgres({
      applicationRoot: sourceRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
      configuration,
      now: () => new Date("2027-01-15T08:00:00.000Z"),
    });
    expect(migration.status).toBe("migrated");
    expect(migration.source_fingerprint).toBe(migration.destination_fingerprint);
    await expect(migrateSqliteGatewayToPostgres({
      applicationRoot: sourceRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
      configuration,
    })).resolves.toMatchObject({ status: "already_applied" });

    const store = await PostgresGatewayStore.open({
      configuration,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
      rateLimitPerMinute: 2,
    });
    try {
      const state = await store.getState();
      expect(state).toMatchObject({
        tenants: [{ tenantId: "tenant_demo", status: "active" }],
        clients: [{ clientId: "codex_ops", status: "active" }],
        credentials: [{ credentialId: issued.data.credential.credential_id }],
      });
      expect(state.deliveryAcknowledgements[issued.data.credential.credential_id]).toBe(
        "2027-01-15T08:00:00.000Z",
      );
      const service = new TenantAccessService(store, { clock: () => 1_800_000_060 });
      await service.setTenantStatus(admin(), "tenant_demo", {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "suspended",
        reason_code: "integration_test",
      }, "postgres-suspend-tenant-0001");
      await expect(service.setTenantStatus(admin(), "tenant_demo", {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "suspended",
        reason_code: "integration_test",
      }, "postgres-suspend-tenant-0001")).resolves.toMatchObject({ replayed: true });
      expect((await store.getState()).tenants[0]?.status).toBe("suspended");

      const reservation = {
        tenantId: "tenant_demo",
        clientId: "codex_ops",
        credentialId: issued.data.credential.credential_id,
        clientIp: "203.0.113.10",
        nowSeconds: 1_800_000_060,
      };
      await expect(store.reserve(reservation)).resolves.toBe(true);
      await expect(store.reserve(reservation)).resolves.toBe(true);
      await expect(store.reserve(reservation)).resolves.toBe(false);
      const concurrent = await Promise.all(Array.from({ length: 10 }, () => store.reserve({
        ...reservation,
        nowSeconds: reservation.nowSeconds + 60,
      })));
      expect(concurrent.filter(Boolean)).toHaveLength(2);
      await expect(store.health()).resolves.toMatchObject({ ready: true, auditCount: 1 });
      await expect(store.summarize({
        windowStartedAt: "2027-01-14T08:00:00.000Z",
        issueLimit: 20,
      })).resolves.toEqual({
        windowStartedAt: "2027-01-14T08:00:00.000Z",
        totalAuditEvents: 1,
        statusCounts: {
          success: 1,
          needs_input: 0,
          manual_review: 0,
          blocked: 0,
          unavailable: 0,
        },
        recentIssues: [],
      });
    } finally {
      await store.close();
    }
  }, 30_000);
});
