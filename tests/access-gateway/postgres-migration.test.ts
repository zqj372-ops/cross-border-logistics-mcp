import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  migratePostgresGatewaySchema,
  readSqliteGatewayMigrationSnapshot,
  summarizeGatewayMigrationSnapshot,
} from "../../services/access-gateway/postgres-migration";
import { POSTGRES_GATEWAY_SCHEMA_VERSION } from "../../services/access-gateway/postgres-store";
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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite to PostgreSQL migration snapshot", () => {
  it("captures every authority row, binds idempotency to its operation and emits only redacted proof", async () => {
    const applicationRoot = mkdtempSync(join(tmpdir(), "logistics-mcp-migration-source-"));
    roots.push(applicationRoot);
    mkdirSync(join(applicationRoot, ".runtime"), { mode: 0o700 });
    await initializeSqliteTenantAccessState({
      applicationRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    await initializeSqliteGatewayOperationalState({ applicationRoot, instanceId: "gateway_01" });

    const tenantStore = new SqliteTenantAccessStore({
      applicationRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    const service = new TenantAccessService(tenantStore, {
      clock: () => 1_800_000_000,
      idGenerator: (() => {
        let sequence = 0;
        return (prefix: "event" | "key") => `${prefix}_${String(++sequence).padStart(8, "0")}`;
      })(),
      secretGenerator: () => "A".repeat(43),
      saltGenerator: () => new Uint8Array(16).fill(3),
    });
    const admin = parseExecutionContext({
      tenant_id: "tenant_management",
      actor_id: "admin_operator",
      actor_role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin", "tenant:admin"],
      client_id: "migration_test",
      session_id: "migration_test_session",
      expires_at: 1_900_000_000,
    });
    await service.createTenant(admin, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo",
      display_name: "Demo",
    }, "migration-create-tenant-0001");
    const issued = await service.issueCredential(admin, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo",
      client_id: "codex_ops",
      label: "Codex",
      tool_names: ["cargo.calculate"],
      expires_in_seconds: 86_400,
    }, "migration-issue-key-0001");
    await service.acknowledgeCredentialDelivery(admin, issued.data.credential.credential_id, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "operator_confirmed_secure_storage",
    }, "migration-ack-key-0001");
    await tenantStore.close();

    const operations = new SqliteGatewayOperationalStore({
      applicationRoot,
      instanceId: "gateway_01",
    });
    await operations.append({
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
    await operations.reserve({
      tenantId: "tenant_demo",
      clientId: "codex_ops",
      credentialId: issued.data.credential.credential_id,
      clientIp: "203.0.113.10",
      nowSeconds: 1_800_000_000,
    });
    await operations.close();

    const snapshot = readSqliteGatewayMigrationSnapshot({
      applicationRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    expect(snapshot.counts).toEqual({
      tenants: 1,
      clients: 1,
      credentials: 1,
      access_events: 4,
      access_idempotency: 3,
      gateway_audit: 1,
      gateway_rate_windows: 4,
    });
    expect(snapshot.idempotency.every(({ operationId }) => (
      snapshot.events.some(({ eventId }) => eventId === operationId)
    ))).toBe(true);
    expect(snapshot.idempotency.every(({ resultSnapshotJson }) => (
      typeof resultSnapshotJson === "string"
    ))).toBe(true);
    for (const record of snapshot.idempotency) {
      const result = JSON.parse(record.resultSnapshotJson ?? "null") as {
        readonly operation?: { readonly eventId?: unknown };
      } | null;
      expect(result?.operation?.eventId).toBe(record.operationId);
    }
    expect(snapshot.idempotency.map(({ resultSnapshotJson }) => resultSnapshotJson).join("\n"))
      .not.toContain(issued.data.api_key);
    expect(snapshot.credentials[0]?.deliveryAcknowledgedAt).toBe("2027-01-15T08:00:00.000Z");

    const summary = summarizeGatewayMigrationSnapshot(snapshot);
    expect(summary.source_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(summary.counts).toEqual(snapshot.counts);
    expect(JSON.stringify(summary)).not.toMatch(/secret|lmcpk_|jwt_00000001/u);
  });

  it("upgrades the PostgreSQL idempotency schema repeatably without reconstructing old rows", async () => {
    let schemaVersion = 1;
    let resultSnapshotColumn = false;
    const queries: string[] = [];
    const client = {
      query: (queryText: string) => {
        const sql = queryText.replace(/\s+/gu, " ").trim();
        queries.push(sql);
        if (sql.includes("SELECT schema_version")) {
          return Promise.resolve({ rows: [{ schema_version: schemaVersion }] });
        }
        if (sql.includes("ADD COLUMN IF NOT EXISTS result_snapshot")) {
          resultSnapshotColumn = true;
        }
        if (sql.includes("UPDATE") && sql.includes("gateway_meta")) {
          schemaVersion = POSTGRES_GATEWAY_SCHEMA_VERSION;
        }
        if (sql.includes("information_schema.columns")) {
          return Promise.resolve({ rows: resultSnapshotColumn ? [{ data_type: "jsonb" }] : [] });
        }
        return Promise.resolve({ rows: [] });
      },
    } as unknown as PoolClient;

    await expect(migratePostgresGatewaySchema(client, "access_gateway")).resolves.toBeUndefined();
    await expect(migratePostgresGatewaySchema(client, "access_gateway")).resolves.toBeUndefined();
    expect(schemaVersion).toBe(POSTGRES_GATEWAY_SCHEMA_VERSION);
    expect(resultSnapshotColumn).toBe(true);
    expect(queries.filter((sql) => sql.includes("ADD COLUMN IF NOT EXISTS result_snapshot")))
      .toHaveLength(2);
  });
});
