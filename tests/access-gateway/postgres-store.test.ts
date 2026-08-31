import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  POSTGRES_GATEWAY_SCHEMA_VERSION,
  PostgresGatewayStore,
  type PostgresGatewayConfiguration,
  postgresConfigurationFromEnvironment,
  readPostgresPassword,
} from "../../services/access-gateway/postgres-store";
import { evaluateAccessGatewayReadiness } from "../../services/access-gateway/start";
import type {
  TenantAccessEventRecord,
} from "../../src/logistics_mcp/control-plane/tenant-access-repository";

const roots: string[] = [];

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakePostgres {
  readonly pool: Pool;
  readonly poolQueries: RecordedQuery[];
  readonly clientQueries: RecordedQuery[];
  readonly releaseCalls: { value: number };
  readonly persistedAuditIds: Set<string>;
}

function testConfiguration(): PostgresGatewayConfiguration {
  return {
    backend: "postgresql",
    host: "postgres.test",
    port: 5432,
    database: "gateway_test",
    user: "gateway_test",
    passwordFile: "/unused/password",
    schema: "access_gateway",
    sslMode: "disable",
    maxConnections: 2,
    connectionTimeoutMillis: 500,
    idleTimeoutMillis: 1_000,
    statementTimeoutMillis: 500,
  };
}

function fakePostgres(options: Readonly<{
  readonly failAuditProbe?: boolean;
  readonly evidenceRows?: readonly Record<string, unknown>[];
}> = {}): FakePostgres {
  const poolQueries: RecordedQuery[] = [];
  const clientQueries: RecordedQuery[] = [];
  const releaseCalls = { value: 0 };
  const persistedAuditIds = new Set<string>();
  const transactionAuditIds = new Set<string>();
  let transactionActive = false;
  const record = (target: RecordedQuery[], text: string, values?: readonly unknown[]) => {
    target.push({ text, values: values ?? [] });
  };
  const client = {
    query: (text: string, values?: readonly unknown[]) => {
      record(clientQueries, text, values);
      if (text.trim() === "BEGIN") {
        transactionActive = true;
        transactionAuditIds.clear();
      }
      if (options.failAuditProbe === true && text.includes("INSERT INTO") && text.includes("gateway_audit")) {
        throw new Error("audit store is read-only");
      }
      if (text.includes("INSERT INTO") && text.includes("gateway_audit")) {
        const auditId = values?.[0];
        if (!transactionActive || typeof auditId !== "string") throw new Error("fake transaction is invalid");
        transactionAuditIds.add(auditId);
      }
      if (text.trim() === "COMMIT") {
        for (const auditId of transactionAuditIds) persistedAuditIds.add(auditId);
        transactionAuditIds.clear();
        transactionActive = false;
      }
      if (text.trim() === "ROLLBACK") {
        transactionAuditIds.clear();
        transactionActive = false;
      }
      if (text.includes("SELECT request_id, COUNT(*)")) {
        return Promise.resolve({ rows: options.evidenceRows ?? [] });
      }
      if (text.includes("SELECT COUNT(*)")) {
        const auditId = values?.[0];
        const count = typeof auditId === "string" && (
          persistedAuditIds.has(auditId) || transactionAuditIds.has(auditId)
        ) ? "1" : "0";
        return Promise.resolve({ rows: [{ count }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => {
      releaseCalls.value += 1;
    },
  } as unknown as PoolClient;
  const pool = {
    query: (text: string, values?: readonly unknown[]) => {
      record(poolQueries, text, values);
      if (text.includes("SELECT schema_version")) {
        return Promise.resolve({
          rows: [{
            schema_version: POSTGRES_GATEWAY_SCHEMA_VERSION,
            instance_id: "gateway_01",
            management_tenant_id: "tenant_management",
          }],
        });
      }
      if (text.includes("SELECT COUNT(*)")) return Promise.resolve({ rows: [{ count: "0" }] });
      return Promise.resolve({ rows: [] });
    },
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool;
  return { pool, poolQueries, clientQueries, releaseCalls, persistedAuditIds };
}

async function openTestStore(fake: Pick<FakePostgres, "pool">): Promise<PostgresGatewayStore> {
  return PostgresGatewayStore.open({
    configuration: testConfiguration(),
    instanceId: "gateway_01",
    managementTenantId: "tenant_management",
    pool: fake.pool,
  });
}

interface TenantAccessPostgres {
  readonly pool: Pool;
  readonly tenant: Record<string, unknown>;
  readonly gatewayClient: Record<string, unknown>;
  readonly credential: Record<string, unknown>;
  readonly events: Map<string, Record<string, unknown>>;
  readonly idempotency: Map<string, Record<string, unknown>>;
}

function tenantAccessPostgres(): TenantAccessPostgres {
  const tenant: Record<string, unknown> = {
    tenant_id: "tenant_demo",
    display_name: "Demo",
    status: "active",
    created_at: "2027-01-15T08:00:00.000Z",
    updated_at: "2027-01-15T08:00:00.000Z",
  };
  const gatewayClient: Record<string, unknown> = {
    tenant_id: "tenant_demo",
    client_id: "codex_ops",
    label: "Codex",
    status: "active",
    created_at: "2027-01-15T08:00:00.000Z",
    updated_at: "2027-01-15T08:00:00.000Z",
  };
  const credential: Record<string, unknown> = {
    credential_id: "key_credential_0001",
    tenant_id: "tenant_demo",
    client_id: "codex_ops",
    label: "Codex",
    actor_role: "service",
    roles: ["service"],
    scopes: ["tool:cargo.calculate"],
    status: "active",
    delivery_acknowledged_at: null,
    key_prefix: "lmcpk_key_credential_0001",
    secret_last_four: "AAAA",
    secret_salt: new Uint8Array(16).fill(3),
    secret_hash: new Uint8Array(32).fill(7),
    pepper_version: "unpeppered-scrypt-v1",
    created_at: "2027-01-15T08:00:00.000Z",
    expires_at: 1_900_000_000,
    last_used_at: null,
    revoked_at: null,
    rotated_from_id: null,
  };
  const events = new Map<string, Record<string, unknown>>();
  const idempotency = new Map<string, Record<string, unknown>>();
  const client = {
    query: (queryText: string, values?: readonly unknown[]) => {
      const sql = queryText.replace(/\s+/gu, " ").trim();
      if (
        sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" ||
        sql.startsWith("SET LOCAL ") || sql.includes("pg_advisory_xact_lock")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes('FROM "access_gateway"."access_idempotency"')) {
        const key = `${String(values?.[0])}\u0000${String(values?.[1])}`;
        const row = idempotency.get(key);
        return Promise.resolve({ rows: row === undefined ? [] : [{ ...row }], rowCount: row === undefined ? 0 : 1 });
      }
      if (sql.startsWith("INSERT INTO") && sql.includes('"access_idempotency"')) {
        const [action, key, requestHash, resultId, operationId, createdAt, resultSnapshot] = values ?? [];
        idempotency.set(`${String(action)}\u0000${String(key)}`, {
          request_hash: requestHash,
          result_id: resultId,
          operation_id: operationId,
          created_at: createdAt,
          result_snapshot: resultSnapshot ?? null,
        });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.startsWith("INSERT INTO") && sql.includes('"access_events"')) {
        const [eventId, tenantId, clientId, credentialId, actorRef, action, reasonCode, createdAt] = values ?? [];
        events.set(String(eventId), {
          event_id: eventId,
          tenant_id: tenantId,
          client_id: clientId,
          credential_id: credentialId,
          actor_ref: actorRef,
          action,
          reason_code: reasonCode,
          created_at: createdAt,
        });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes('FROM "access_gateway"."access_events"')) {
        const row = events.get(String(values?.[0]));
        return Promise.resolve({ rows: row === undefined ? [] : [{ ...row }], rowCount: row === undefined ? 0 : 1 });
      }
      if (sql.startsWith("UPDATE") && sql.includes('"tenants"')) {
        tenant.status = values?.[0];
        tenant.updated_at = values?.[1];
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes('FROM "access_gateway"."tenants"')) {
        return Promise.resolve({ rows: [{ ...tenant }], rowCount: 1 });
      }
      if (sql.startsWith("UPDATE") && sql.includes('"clients"')) {
        gatewayClient.status = values?.[0];
        gatewayClient.updated_at = values?.[1];
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes('FROM "access_gateway"."clients"')) {
        return Promise.resolve({ rows: [{ ...gatewayClient }], rowCount: 1 });
      }
      if (sql.startsWith("UPDATE") && sql.includes("delivery_acknowledged_at")) {
        credential.delivery_acknowledged_at = values?.[0];
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.startsWith("UPDATE") && sql.includes('"credentials"')) {
        credential.status = "revoked";
        credential.revoked_at = values?.[0];
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.startsWith("SELECT delivery_acknowledged_at")) {
        return Promise.resolve({
          rows: [{ delivery_acknowledged_at: credential.delivery_acknowledged_at }],
          rowCount: 1,
        });
      }
      if (sql.includes('FROM "access_gateway"."credentials"')) {
        return Promise.resolve({ rows: [{ ...credential }], rowCount: 1 });
      }
      throw new Error(`Unhandled Tenant Access PostgreSQL test query: ${sql}`);
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = {
    query: (queryText: string) => {
      if (queryText.includes("SELECT schema_version")) {
        return Promise.resolve({
          rows: [{
            schema_version: POSTGRES_GATEWAY_SCHEMA_VERSION,
            instance_id: "gateway_01",
            management_tenant_id: "tenant_management",
          }],
        });
      }
      throw new Error("Unhandled Tenant Access PostgreSQL pool query.");
    },
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool;
  return { pool, tenant, gatewayClient, credential, events, idempotency };
}

function accessEvent(input: Readonly<{
  eventId: string;
  action: string;
  createdAt: string;
  clientId?: string | null;
  credentialId?: string | null;
}>): TenantAccessEventRecord {
  return Object.freeze({
    eventId: input.eventId,
    tenantId: "tenant_demo",
    clientId: input.clientId ?? null,
    credentialId: input.credentialId ?? null,
    actorRef: "admin_operator:postgres_test",
    action: input.action,
    reasonCode: "test_transition",
    createdAt: input.createdAt,
  });
}

function securePasswordFile(): string {
  const root = mkdtempSync(join(tmpdir(), "logistics-mcp-postgres-config-"));
  roots.push(root);
  const path = join(root, "password");
  writeFileSync(path, "test-password\n", { mode: 0o400 });
  chmodSync(path, 0o400);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PostgreSQL Access Gateway configuration", () => {
  it("proves audit write capability with a rollback-only health probe", async () => {
    const fake = fakePostgres();
    const store = await openTestStore(fake);
    try {
      await expect(store.health()).resolves.toEqual({ ready: true, auditCount: 0 });
      const probeIndex = fake.clientQueries.findIndex(({ text }) => (
        text.includes("INSERT INTO") && text.includes("gateway_audit")
      ));
      expect(probeIndex).toBeGreaterThanOrEqual(0);
      const beginIndex = fake.clientQueries.findIndex(({ text }) => text.trim() === "BEGIN");
      const rollbackIndex = fake.clientQueries.findIndex((entry, index) => (
        index > probeIndex && entry.text.trim() === "ROLLBACK"
      ));
      expect(beginIndex).toBeGreaterThanOrEqual(0);
      expect(beginIndex).toBeLessThan(probeIndex);
      expect(probeIndex).toBeLessThan(rollbackIndex);
      expect(fake.clientQueries[probeIndex]?.values).toHaveLength(2);
      expect(fake.clientQueries[rollbackIndex + 1]?.text).toMatch(/SELECT COUNT\(\*\)/u);
      expect(fake.clientQueries[rollbackIndex + 1]?.values).toHaveLength(1);
      expect(fake.clientQueries[probeIndex - 1]?.text.trim()).toBe(
        "SET LOCAL idle_in_transaction_session_timeout = '500ms'",
      );
      expect(fake.clientQueries.some(({ text }) => text.trim() === "COMMIT")).toBe(false);
      expect(fake.persistedAuditIds.size).toBe(0);
      expect(fake.releaseCalls.value).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("fails health when the audit write probe is rejected and releases the client after rollback", async () => {
    const fake = fakePostgres({ failAuditProbe: true });
    const store = await openTestStore(fake);
    try {
      await expect(store.health()).resolves.toEqual({ ready: false, auditCount: 0 });
      const probeIndex = fake.clientQueries.findIndex(({ text }) => (
        text.includes("INSERT INTO") && text.includes("gateway_audit")
      ));
      expect(probeIndex).toBeGreaterThanOrEqual(0);
      const beginIndex = fake.clientQueries.findIndex(({ text }) => text.trim() === "BEGIN");
      const rollbackIndex = fake.clientQueries.findIndex((entry, index) => (
        index > probeIndex && entry.text.trim() === "ROLLBACK"
      ));
      expect(beginIndex).toBeGreaterThanOrEqual(0);
      expect(beginIndex).toBeLessThan(probeIndex);
      expect(probeIndex).toBeLessThan(rollbackIndex);
      expect(fake.clientQueries.some(({ text }) => text.trim() === "COMMIT")).toBe(false);
      expect(fake.persistedAuditIds.size).toBe(0);
      expect(fake.releaseCalls.value).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("reads bounded request-specific audit evidence through a parameterized read-only query", async () => {
    const requestIds = [
      "req_smoke_run_0001_a",
      "req_smoke_run_0001_b",
    ] as const;
    const fake = fakePostgres({
      evidenceRows: [
        { request_id: requestIds[0], event_count: "1" },
        { request_id: requestIds[1], event_count: "1" },
      ],
    });
    const store = await openTestStore(fake);
    try {
      await expect(store.readByRequestIds({ requestIds })).resolves.toEqual([
        { requestId: requestIds[0], eventCount: 1 },
        { requestId: requestIds[1], eventCount: 1 },
      ]);
      const query = fake.clientQueries.find(({ text }) => text.includes("SELECT request_id, COUNT(*)"));
      expect(query).toBeDefined();
      expect(query?.text).toMatch(/request_id = ANY\(\$1::text\[\]\)/u);
      expect(query?.text).not.toMatch(/tenant_id|client_id|credential_id|tool_names|request_hash/u);
      expect(query?.values).toEqual([requestIds]);
      expect(fake.clientQueries[0]?.text.trim()).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(fake.clientQueries.at(-1)?.text.trim()).toBe("COMMIT");

      await expect(store.readByRequestIds({
        requestIds: [requestIds[0], requestIds[0]],
      })).rejects.toThrow("Gateway audit evidence request is invalid.");
      await expect(store.readByRequestIds({ requestIds: ["not-a-request-id"] })).rejects.toThrow(
        "Gateway audit evidence request is invalid.",
      );
      await expect(store.readByRequestIds({
        requestIds: Array.from({ length: 33 }, (_, index) => `req_evidence_${String(index).padStart(2, "0")}`),
      })).rejects.toThrow("Gateway audit evidence request is invalid.");
    } finally {
      await store.close();
    }
  });

  it("replays immutable tenant, client and credential snapshots after later mutations", async () => {
    const fake = tenantAccessPostgres();
    const store = await openTestStore(fake);
    try {
      const suspendedAt = "2027-01-15T08:01:00.000Z";
      const suspendedEvent = accessEvent({
        eventId: "event_tenant_suspended_0001",
        action: "tenant.suspended",
        createdAt: suspendedAt,
      });
      const suspended = await store.setTenantStatus({
        tenantId: "tenant_demo",
        status: "suspended",
        updatedAt: suspendedAt,
        event: suspendedEvent,
        idempotencyKey: "postgres-suspend-tenant-0001",
        requestHash: "hash_tenant_suspend",
      });
      expect(suspended).toMatchObject({
        replayed: false,
        value: { status: "suspended" },
        operation: suspendedEvent,
        snapshot: {
          tenantStatus: "suspended",
          clientStatus: null,
          deliveryAcknowledgedAt: null,
        },
      });

      const reactivatedAt = "2027-01-15T08:02:00.000Z";
      await store.setTenantStatus({
        tenantId: "tenant_demo",
        status: "active",
        updatedAt: reactivatedAt,
        event: accessEvent({
          eventId: "event_tenant_active_0001",
          action: "tenant.active",
          createdAt: reactivatedAt,
        }),
        idempotencyKey: "postgres-activate-tenant-0001",
        requestHash: "hash_tenant_activate",
      });
      const suspendedReplay = await store.setTenantStatus({
        tenantId: "tenant_demo",
        status: "suspended",
        updatedAt: "2027-01-15T08:03:00.000Z",
        event: accessEvent({
          eventId: "event_tenant_replay_unused",
          action: "tenant.suspended",
          createdAt: "2027-01-15T08:03:00.000Z",
        }),
        idempotencyKey: "postgres-suspend-tenant-0001",
        requestHash: "hash_tenant_suspend",
      });
      expect(fake.tenant.status).toBe("active");
      expect(suspendedReplay).toEqual({ ...suspended, replayed: true });

      const disabledAt = "2027-01-15T08:04:00.000Z";
      const disabledEvent = accessEvent({
        eventId: "event_client_disabled_0001",
        action: "client.disabled",
        createdAt: disabledAt,
        clientId: "codex_ops",
      });
      const disabled = await store.setClientStatus({
        tenantId: "tenant_demo",
        clientId: "codex_ops",
        status: "disabled",
        updatedAt: disabledAt,
        event: disabledEvent,
        idempotencyKey: "postgres-disable-client-0001",
        requestHash: "hash_client_disable",
      });
      expect(disabled.snapshot).toEqual({
        tenantStatus: "active",
        clientStatus: "disabled",
        deliveryAcknowledgedAt: null,
      });
      const enabledAt = "2027-01-15T08:05:00.000Z";
      await store.setClientStatus({
        tenantId: "tenant_demo",
        clientId: "codex_ops",
        status: "active",
        updatedAt: enabledAt,
        event: accessEvent({
          eventId: "event_client_active_0001",
          action: "client.active",
          createdAt: enabledAt,
          clientId: "codex_ops",
        }),
        idempotencyKey: "postgres-enable-client-0001",
        requestHash: "hash_client_enable",
      });
      const disabledReplay = await store.setClientStatus({
        tenantId: "tenant_demo",
        clientId: "codex_ops",
        status: "disabled",
        updatedAt: "2027-01-15T08:06:00.000Z",
        event: accessEvent({
          eventId: "event_client_replay_unused",
          action: "client.disabled",
          createdAt: "2027-01-15T08:06:00.000Z",
          clientId: "codex_ops",
        }),
        idempotencyKey: "postgres-disable-client-0001",
        requestHash: "hash_client_disable",
      });
      expect(fake.gatewayClient.status).toBe("active");
      expect(disabledReplay).toEqual({ ...disabled, replayed: true });

      const acknowledgedAt = "2027-01-15T08:07:00.000Z";
      const acknowledgedEvent = accessEvent({
        eventId: "event_credential_ack_0001",
        action: "credential.delivery_acknowledged",
        createdAt: acknowledgedAt,
        clientId: "codex_ops",
        credentialId: "key_credential_0001",
      });
      const acknowledged = await store.acknowledgeCredentialDelivery({
        credentialId: "key_credential_0001",
        nowSeconds: 1_800_000_420,
        event: acknowledgedEvent,
        idempotencyKey: "postgres-ack-credential-0001",
        requestHash: "hash_credential_ack",
      });
      expect(acknowledged.snapshot).toEqual({
        tenantStatus: "active",
        clientStatus: "active",
        deliveryAcknowledgedAt: acknowledgedAt,
      });
      const revokedAt = "2027-01-15T08:08:00.000Z";
      await store.revokeCredential({
        credentialId: "key_credential_0001",
        revokedAt,
        nowSeconds: 1_800_000_480,
        event: accessEvent({
          eventId: "event_credential_revoked_0001",
          action: "credential.revoked",
          createdAt: revokedAt,
          clientId: "codex_ops",
          credentialId: "key_credential_0001",
        }),
        idempotencyKey: "postgres-revoke-credential-0001",
        requestHash: "hash_credential_revoke",
      });
      const acknowledgementReplay = await store.acknowledgeCredentialDelivery({
        credentialId: "key_credential_0001",
        nowSeconds: 1_800_000_540,
        event: accessEvent({
          eventId: "event_credential_ack_replay_unused",
          action: "credential.delivery_acknowledged",
          createdAt: "2027-01-15T08:09:00.000Z",
          clientId: "codex_ops",
          credentialId: "key_credential_0001",
        }),
        idempotencyKey: "postgres-ack-credential-0001",
        requestHash: "hash_credential_ack",
      });
      expect(fake.credential.status).toBe("revoked");
      expect(acknowledgementReplay).toEqual({ ...acknowledged, replayed: true });

      const serializedSnapshots = [...fake.idempotency.values()]
        .map((row) => JSON.stringify(row.result_snapshot));
      expect(serializedSnapshots.every((value) => value !== undefined && value !== "null")).toBe(true);
      expect(serializedSnapshots.join("\n")).not.toContain(
        `lmcpk_key_credential_0001_${"A".repeat(43)}`,
      );
    } finally {
      await store.close();
    }
  });

  it("fails closed when a legacy idempotency row has no immutable snapshot", async () => {
    const fake = tenantAccessPostgres();
    const operation = accessEvent({
      eventId: "event_legacy_suspend_0001",
      action: "tenant.suspended",
      createdAt: "2027-01-15T08:01:00.000Z",
    });
    fake.events.set(operation.eventId, {
      event_id: operation.eventId,
      tenant_id: operation.tenantId,
      client_id: operation.clientId,
      credential_id: operation.credentialId,
      actor_ref: operation.actorRef,
      action: operation.action,
      reason_code: operation.reasonCode,
      created_at: operation.createdAt,
    });
    fake.idempotency.set("tenant.status\u0000postgres-legacy-suspend-0001", {
      request_hash: "hash_legacy_suspend",
      result_id: "tenant_demo",
      operation_id: operation.eventId,
      created_at: operation.createdAt,
      result_snapshot: null,
    });
    const store = await openTestStore(fake);
    try {
      await expect(store.setTenantStatus({
        tenantId: "tenant_demo",
        status: "suspended",
        updatedAt: "2027-01-15T08:10:00.000Z",
        event: accessEvent({
          eventId: "event_legacy_replay_unused",
          action: "tenant.suspended",
          createdAt: "2027-01-15T08:10:00.000Z",
        }),
        idempotencyKey: "postgres-legacy-suspend-0001",
        requestHash: "hash_legacy_suspend",
      })).rejects.toMatchObject({ code: "corrupt" });
      expect(fake.tenant.status).toBe("active");
    } finally {
      await store.close();
    }
  });

  it("requires explicit, file-backed connection settings without exposing the password", () => {
    const passwordFile = securePasswordFile();
    const configuration = postgresConfigurationFromEnvironment({
      ACCESS_GATEWAY_STORE_BACKEND: "postgresql",
      ACCESS_GATEWAY_POSTGRES_HOST: "mcp-postgresql",
      ACCESS_GATEWAY_POSTGRES_PORT: "5432",
      ACCESS_GATEWAY_POSTGRES_DATABASE: "freightclaw_mcp",
      ACCESS_GATEWAY_POSTGRES_USER: "freightclaw_mcp",
      ACCESS_GATEWAY_POSTGRES_PASSWORD_FILE: passwordFile,
      ACCESS_GATEWAY_POSTGRES_SCHEMA: "access_gateway",
      ACCESS_GATEWAY_POSTGRES_SSL_MODE: "disable",
      ACCESS_GATEWAY_POSTGRES_MAX_CONNECTIONS: "8",
    });

    expect(configuration).toEqual({
      backend: "postgresql",
      host: "mcp-postgresql",
      port: 5432,
      database: "freightclaw_mcp",
      user: "freightclaw_mcp",
      passwordFile,
      schema: "access_gateway",
      sslMode: "disable",
      maxConnections: 8,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statementTimeoutMillis: 5_000,
    });
    expect(JSON.stringify(configuration)).not.toContain("test-password");
    expect(readPostgresPassword(passwordFile)).toBe("test-password");
  });

  it("rejects plaintext secrets, connection URLs and injectable schema names", () => {
    const passwordFile = securePasswordFile();
    const base = {
      ACCESS_GATEWAY_STORE_BACKEND: "postgresql",
      ACCESS_GATEWAY_POSTGRES_HOST: "mcp-postgresql",
      ACCESS_GATEWAY_POSTGRES_PORT: "5432",
      ACCESS_GATEWAY_POSTGRES_DATABASE: "freightclaw_mcp",
      ACCESS_GATEWAY_POSTGRES_USER: "freightclaw_mcp",
      ACCESS_GATEWAY_POSTGRES_PASSWORD_FILE: passwordFile,
      ACCESS_GATEWAY_POSTGRES_SCHEMA: "access_gateway",
      ACCESS_GATEWAY_POSTGRES_SSL_MODE: "disable",
    } satisfies NodeJS.ProcessEnv;

    expect(() => postgresConfigurationFromEnvironment({
      ...base,
      ACCESS_GATEWAY_POSTGRES_PASSWORD: "plaintext",
    })).toThrow(/plaintext PostgreSQL secrets/u);
    expect(() => postgresConfigurationFromEnvironment({
      ...base,
      DATABASE_URL: "postgresql://example.invalid/database",
    })).toThrow(/connection URLs/u);
    expect(() => postgresConfigurationFromEnvironment({
      ...base,
      ACCESS_GATEWAY_POSTGRES_SCHEMA: "access_gateway;drop schema public",
    })).toThrow(/schema/u);
  });

  it("reports PostgreSQL as configured without promoting the candidate to production", () => {
    expect(evaluateAccessGatewayReadiness({
      tenantStoreReady: true,
      operationStoreReady: true,
      signingKeyCount: 1,
      adminConfigured: true,
      adminReady: true,
      databaseBackend: "postgresql",
    })).toEqual({
      httpStatus: 200,
      status: "manual_review",
      operationalReady: true,
      blockers: [
        "kms_signer_unconfigured",
        "managed_database_qualification_pending",
      ],
    });
  });
});
