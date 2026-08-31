import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { PoolClient } from "pg";

import { tenantAccessPaths } from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import { canonicalJson } from "./canonical-json";
import { gatewayOperationalPaths } from "./production-store";
import {
  POSTGRES_GATEWAY_SCHEMA_VERSION,
  createPostgresPool,
  initializePostgresGatewaySchema,
  normalizeTenantAccessResultSnapshotJson,
  postgresConfigurationFromEnvironment,
  postgresQualifiedTable,
  type PostgresGatewayConfiguration,
} from "./postgres-store";

type SqliteRow = Record<string, SQLInputValue>;

interface MigrationTenant {
  readonly tenantId: string;
  readonly displayName: string;
  readonly status: "active" | "suspended";
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MigrationClient {
  readonly tenantId: string;
  readonly clientId: string;
  readonly label: string;
  readonly status: "active" | "disabled";
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MigrationCredential {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly label: string;
  readonly actorRole: "service";
  readonly roles: readonly ["service"];
  readonly scopes: readonly string[];
  readonly status: "active" | "revoked";
  readonly deliveryAcknowledgedAt: string | null;
  readonly keyPrefix: string;
  readonly secretLastFour: string;
  readonly secretSalt: Uint8Array;
  readonly secretHash: Uint8Array;
  readonly pepperVersion: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly rotatedFromId: string | null;
}

interface MigrationEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly clientId: string | null;
  readonly credentialId: string | null;
  readonly actorRef: string;
  readonly action: string;
  readonly reasonCode: string;
  readonly createdAt: string;
}

interface MigrationIdempotency {
  readonly action: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly resultId: string;
  readonly operationId: string;
  readonly createdAt: string;
  readonly resultSnapshotJson: string | null;
}

interface MigrationAudit {
  readonly auditId: string;
  readonly action: string;
  readonly status: string;
  readonly requestId: string;
  readonly tenantId: string | null;
  readonly clientId: string | null;
  readonly credentialId: string | null;
  readonly toolNames: readonly string[];
  readonly requestHash: string;
  readonly jti: string | null;
  readonly reasonCode: string | null;
  readonly createdAt: string;
}

interface MigrationRateWindow {
  readonly bucketKey: string;
  readonly windowStart: number;
  readonly requestCount: number;
}

export interface GatewayMigrationCounts {
  readonly tenants: number;
  readonly clients: number;
  readonly credentials: number;
  readonly access_events: number;
  readonly access_idempotency: number;
  readonly gateway_audit: number;
  readonly gateway_rate_windows: number;
}

export interface SqliteGatewayMigrationSnapshot {
  readonly instanceId: string;
  readonly managementTenantId: string;
  readonly accessStoreId: string;
  readonly operationStoreId: string;
  readonly tenants: readonly MigrationTenant[];
  readonly clients: readonly MigrationClient[];
  readonly credentials: readonly MigrationCredential[];
  readonly events: readonly MigrationEvent[];
  readonly idempotency: readonly MigrationIdempotency[];
  readonly audits: readonly MigrationAudit[];
  readonly rateWindows: readonly MigrationRateWindow[];
  readonly counts: GatewayMigrationCounts;
  readonly sourceFingerprint: `sha256:${string}`;
}

export interface GatewayMigrationSummary {
  readonly status: "migrated" | "already_applied";
  readonly backend: "postgresql";
  readonly schema: string;
  readonly source_fingerprint: `sha256:${string}`;
  readonly destination_fingerprint: `sha256:${string}`;
  readonly counts: GatewayMigrationCounts;
}

function sourceFile(path: string): string {
  if (!isAbsolute(path)) throw new Error("SQLite migration source path must be absolute.");
  const resolved = realpathSync(resolve(path));
  const entry = lstatSync(resolved);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
    throw new Error("SQLite migration source must be a private regular file.");
  }
  return resolved;
}

function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("SQLite migration source is corrupt.");
  return value;
}

function nullableText(row: SqliteRow, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new Error("SQLite migration source is corrupt.");
  }
  return value;
}

function integer(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("SQLite migration source is corrupt.");
  }
  return value;
}

function bytes(row: SqliteRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new Error("SQLite migration source is corrupt.");
  return new Uint8Array(value);
}

function stringArray(row: SqliteRow, key: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(text(row, key));
    if (!isStringArray(value)) {
      throw new Error("invalid array");
    }
    return Object.freeze([...value]);
  } catch (error) {
    throw new Error("SQLite migration source is corrupt.", { cause: error });
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && (value as unknown[]).every(
    (item) => typeof item === "string",
  );
}

function verifySqlite(database: DatabaseSync): void {
  const quickCheck = database.prepare("PRAGMA quick_check").get() as SqliteRow | undefined;
  if (quickCheck === undefined || Object.values(quickCheck)[0] !== "ok") {
    throw new Error("SQLite migration source quick check failed.");
  }
  const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length !== 0) {
    throw new Error("SQLite migration source foreign-key check failed.");
  }
}

function inferOperationId(
  idempotency: Omit<MigrationIdempotency, "operationId" | "resultSnapshotJson">,
  events: readonly MigrationEvent[],
): string {
  const actionNames: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "tenant.create": ["tenant.created"],
    "tenant.status": ["tenant.active", "tenant.suspended"],
    "client.status": ["client.active", "client.disabled"],
    "credential.issue": ["credential.issued"],
    "credential.rotate": ["credential.rotated"],
    "credential.revoke": ["credential.revoked"],
    "credential.delivery_acknowledge": ["credential.delivery_acknowledged"],
  });
  const expectedActions = actionNames[idempotency.action];
  if (expectedActions === undefined) {
    throw new Error("SQLite idempotency action is unsupported.");
  }
  const candidates = events.filter((event) => {
    if (event.createdAt !== idempotency.createdAt || !expectedActions.includes(event.action)) {
      return false;
    }
    if (idempotency.action.startsWith("credential.")) {
      return event.credentialId === idempotency.resultId;
    }
    if (idempotency.action === "client.status") return event.clientId === idempotency.resultId;
    return event.tenantId === idempotency.resultId;
  });
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error("SQLite idempotency operation readback is ambiguous.");
  }
  return candidates[0].eventId;
}

function snapshotCounts(input: Readonly<{
  tenants: readonly unknown[];
  clients: readonly unknown[];
  credentials: readonly unknown[];
  events: readonly unknown[];
  idempotency: readonly unknown[];
  audits: readonly unknown[];
  rateWindows: readonly unknown[];
}>): GatewayMigrationCounts {
  return Object.freeze({
    tenants: input.tenants.length,
    clients: input.clients.length,
    credentials: input.credentials.length,
    access_events: input.events.length,
    access_idempotency: input.idempotency.length,
    gateway_audit: input.audits.length,
    gateway_rate_windows: input.rateWindows.length,
  });
}

function fingerprintMaterial(snapshot: Omit<
  SqliteGatewayMigrationSnapshot,
  "counts" | "sourceFingerprint"
>): Record<string, unknown> {
  return {
    instance_id: snapshot.instanceId,
    management_tenant_id: snapshot.managementTenantId,
    access_store_id: snapshot.accessStoreId,
    operation_store_id: snapshot.operationStoreId,
    tenants: snapshot.tenants,
    clients: snapshot.clients,
    credentials: snapshot.credentials.map((credential) => ({
      ...credential,
      secretSalt: Buffer.from(credential.secretSalt).toString("base64"),
      secretHash: Buffer.from(credential.secretHash).toString("base64"),
    })),
    events: snapshot.events,
    idempotency: snapshot.idempotency.map((record) => ({
      action: record.action,
      idempotencyKey: record.idempotencyKey,
      requestHash: record.requestHash,
      resultId: record.resultId,
      operationId: record.operationId,
      createdAt: record.createdAt,
    })),
    audits: snapshot.audits,
    rate_windows: snapshot.rateWindows,
  };
}

function snapshotFingerprint(snapshot: Omit<
  SqliteGatewayMigrationSnapshot,
  "counts" | "sourceFingerprint"
>): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("access-gateway/sqlite-to-postgres/v1\u0000", "utf8")
    .update(canonicalJson(fingerprintMaterial(snapshot)), "utf8")
    .digest("hex")}`;
}

export function readSqliteGatewayMigrationSnapshot(input: Readonly<{
  applicationRoot: string;
  instanceId: string;
  managementTenantId: string;
}>): SqliteGatewayMigrationSnapshot {
  const tenantPath = sourceFile(tenantAccessPaths(input.applicationRoot).databasePath);
  const operationPath = sourceFile(gatewayOperationalPaths(input.applicationRoot).databasePath);
  const tenantDatabase = new DatabaseSync(tenantPath, { readOnly: true });
  const operationDatabase = new DatabaseSync(operationPath, { readOnly: true });
  try {
    tenantDatabase.exec("PRAGMA query_only = ON");
    operationDatabase.exec("PRAGMA query_only = ON");
    verifySqlite(tenantDatabase);
    verifySqlite(operationDatabase);
    const accessMeta = tenantDatabase.prepare(`
      SELECT schema_version, access_store_id, instance_id, management_tenant_id
      FROM access_meta WHERE singleton = 1
    `).get() as SqliteRow | undefined;
    const operationMeta = operationDatabase.prepare(`
      SELECT schema_version, store_id, instance_id FROM gateway_meta WHERE singleton = 1
    `).get() as SqliteRow | undefined;
    const accessSchemaVersion = accessMeta === undefined
      ? null
      : integer(accessMeta, "schema_version");
    if (
      accessMeta === undefined ||
      operationMeta === undefined ||
      (accessSchemaVersion !== 3 && accessSchemaVersion !== 4) ||
      integer(operationMeta, "schema_version") !== 1 ||
      text(accessMeta, "instance_id") !== input.instanceId ||
      text(operationMeta, "instance_id") !== input.instanceId ||
      text(accessMeta, "management_tenant_id") !== input.managementTenantId
    ) {
      throw new Error("SQLite migration source identity or schema mismatch.");
    }

    const tenants = Object.freeze((tenantDatabase.prepare(`
      SELECT * FROM tenants ORDER BY tenant_id
    `).all() as SqliteRow[]).map((row): MigrationTenant => {
      const status = text(row, "status");
      if (status !== "active" && status !== "suspended") {
        throw new Error("SQLite migration source is corrupt.");
      }
      return Object.freeze({
        tenantId: text(row, "tenant_id"),
        displayName: text(row, "display_name"),
        status,
        createdAt: text(row, "created_at"),
        updatedAt: text(row, "updated_at"),
      });
    }));
    const clients = Object.freeze((tenantDatabase.prepare(`
      SELECT * FROM clients ORDER BY tenant_id, client_id
    `).all() as SqliteRow[]).map((row): MigrationClient => {
      const status = text(row, "status");
      if (status !== "active" && status !== "disabled") {
        throw new Error("SQLite migration source is corrupt.");
      }
      return Object.freeze({
        tenantId: text(row, "tenant_id"),
        clientId: text(row, "client_id"),
        label: text(row, "label"),
        status,
        createdAt: text(row, "created_at"),
        updatedAt: text(row, "updated_at"),
      });
    }));
    const acknowledgementRows = tenantDatabase.prepare(`
      SELECT credential_id, MAX(created_at) AS acknowledged_at
      FROM access_events
      WHERE action = 'credential.delivery_acknowledged' AND credential_id IS NOT NULL
      GROUP BY credential_id ORDER BY credential_id
    `).all() as SqliteRow[];
    const acknowledgements = new Map(acknowledgementRows.map((row) => [
      text(row, "credential_id"),
      text(row, "acknowledged_at"),
    ]));
    const credentials = Object.freeze((tenantDatabase.prepare(`
      SELECT * FROM credentials ORDER BY created_at, credential_id
    `).all() as SqliteRow[]).map((row): MigrationCredential => {
      const status = text(row, "status");
      if (status !== "active" && status !== "revoked") {
        throw new Error("SQLite migration source is corrupt.");
      }
      const roles = stringArray(row, "roles_json");
      if (roles.length !== 1 || roles[0] !== "service" || text(row, "actor_role") !== "service") {
        throw new Error("SQLite migration source is corrupt.");
      }
      const credentialId = text(row, "credential_id");
      return Object.freeze({
        credentialId,
        tenantId: text(row, "tenant_id"),
        clientId: text(row, "client_id"),
        label: text(row, "label"),
        actorRole: "service",
        roles: Object.freeze(["service"] as const),
        scopes: stringArray(row, "scopes_json"),
        status,
        deliveryAcknowledgedAt: acknowledgements.get(credentialId) ?? null,
        keyPrefix: text(row, "key_prefix"),
        secretLastFour: text(row, "secret_last_four"),
        secretSalt: bytes(row, "secret_salt"),
        secretHash: bytes(row, "secret_hash"),
        pepperVersion: text(row, "pepper_version"),
        createdAt: text(row, "created_at"),
        expiresAt: integer(row, "expires_at"),
        lastUsedAt: nullableText(row, "last_used_at"),
        revokedAt: nullableText(row, "revoked_at"),
        rotatedFromId: nullableText(row, "rotated_from_id"),
      });
    }));
    const events = Object.freeze((tenantDatabase.prepare(`
      SELECT * FROM access_events ORDER BY created_at, event_id
    `).all() as SqliteRow[]).map((row): MigrationEvent => Object.freeze({
      eventId: text(row, "event_id"),
      tenantId: text(row, "tenant_id"),
      clientId: nullableText(row, "client_id"),
      credentialId: nullableText(row, "credential_id"),
      actorRef: text(row, "actor_ref"),
      action: text(row, "action"),
      reasonCode: text(row, "reason_code"),
      createdAt: text(row, "created_at"),
    })));
    const idempotency = Object.freeze((tenantDatabase.prepare(`
      SELECT action, idempotency_key, request_hash, result_id, created_at,
        ${accessSchemaVersion === 4 ? "result_json" : "NULL AS result_json"}
      FROM access_idempotency ORDER BY action, idempotency_key
    `).all() as SqliteRow[]).map((row): MigrationIdempotency => {
      const base = Object.freeze({
        action: text(row, "action"),
        idempotencyKey: text(row, "idempotency_key"),
        requestHash: text(row, "request_hash"),
        resultId: text(row, "result_id"),
        createdAt: text(row, "created_at"),
      });
      const operationId = inferOperationId(base, events);
      const resultJson = nullableText(row, "result_json");
      return Object.freeze({
        ...base,
        operationId,
        resultSnapshotJson: resultJson === null
          ? null
          : normalizeTenantAccessResultSnapshotJson(
              resultJson,
              base.action,
              base.resultId,
              operationId,
              base.createdAt,
            ),
      });
    }));
    const audits = Object.freeze((operationDatabase.prepare(`
      SELECT * FROM gateway_audit ORDER BY created_at, audit_id
    `).all() as SqliteRow[]).map((row): MigrationAudit => Object.freeze({
      auditId: text(row, "audit_id"),
      action: text(row, "action"),
      status: text(row, "status"),
      requestId: text(row, "request_id"),
      tenantId: nullableText(row, "tenant_id"),
      clientId: nullableText(row, "client_id"),
      credentialId: nullableText(row, "credential_id"),
      toolNames: stringArray(row, "tool_names_json"),
      requestHash: text(row, "request_hash"),
      jti: nullableText(row, "jti"),
      reasonCode: nullableText(row, "reason_code"),
      createdAt: text(row, "created_at"),
    })));
    const rateWindows = Object.freeze((operationDatabase.prepare(`
      SELECT * FROM gateway_rate_windows ORDER BY bucket_key
    `).all() as SqliteRow[]).map((row): MigrationRateWindow => Object.freeze({
      bucketKey: text(row, "bucket_key"),
      windowStart: integer(row, "window_start"),
      requestCount: integer(row, "request_count"),
    })));
    const base = Object.freeze({
      instanceId: input.instanceId,
      managementTenantId: input.managementTenantId,
      accessStoreId: text(accessMeta, "access_store_id"),
      operationStoreId: text(operationMeta, "store_id"),
      tenants,
      clients,
      credentials,
      events,
      idempotency,
      audits,
      rateWindows,
    });
    return Object.freeze({
      ...base,
      counts: snapshotCounts(base),
      sourceFingerprint: snapshotFingerprint(base),
    });
  } finally {
    tenantDatabase.close();
    operationDatabase.close();
  }
}

export function summarizeGatewayMigrationSnapshot(
  snapshot: SqliteGatewayMigrationSnapshot,
): Readonly<{
  source_fingerprint: `sha256:${string}`;
  counts: GatewayMigrationCounts;
}> {
  return Object.freeze({
    source_fingerprint: snapshot.sourceFingerprint,
    counts: snapshot.counts,
  });
}

type PostgresRow = Record<string, unknown>;

function postgresText(row: PostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("PostgreSQL migration readback is corrupt.");
  return value;
}

function postgresNullableText(row: PostgresRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("PostgreSQL migration readback is corrupt.");
  return value;
}

function postgresInteger(row: PostgresRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error("PostgreSQL migration readback is corrupt.");
  return parsed;
}

function postgresTimestampValue(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  throw new Error("PostgreSQL migration readback is corrupt.");
}

function postgresTimestamp(row: PostgresRow, key: string): string {
  return postgresTimestampValue(row[key]);
}

function postgresNullableTimestamp(row: PostgresRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : postgresTimestampValue(value);
}

function postgresBytes(row: PostgresRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new Error("PostgreSQL migration readback is corrupt.");
  return new Uint8Array(value);
}

function postgresStringArray(row: PostgresRow, key: string): readonly string[] {
  const raw: unknown = row[key];
  const value = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  if (!isStringArray(value)) {
    throw new Error("PostgreSQL migration readback is corrupt.");
  }
  return Object.freeze([...value]);
}

async function readPostgresMigrationSnapshot(
  client: PoolClient,
  configuration: PostgresGatewayConfiguration,
): Promise<Omit<SqliteGatewayMigrationSnapshot, "counts" | "sourceFingerprint">> {
  const table = (name: string) => postgresQualifiedTable(configuration.schema, name);
  const meta = (await client.query<PostgresRow>(`
    SELECT instance_id, management_tenant_id, source_access_store_id, source_operation_store_id
    FROM ${table("gateway_meta")} WHERE singleton = true
  `)).rows[0];
  if (meta === undefined) throw new Error("PostgreSQL migration metadata is missing.");
  const tenants = Object.freeze((await client.query<PostgresRow>(`
    SELECT * FROM ${table("tenants")} ORDER BY tenant_id
  `)).rows.map((row): MigrationTenant => {
    const status = postgresText(row, "status");
    if (status !== "active" && status !== "suspended") {
      throw new Error("PostgreSQL migration readback is corrupt.");
    }
    return Object.freeze({
      tenantId: postgresText(row, "tenant_id"),
      displayName: postgresText(row, "display_name"),
      status,
      createdAt: postgresTimestamp(row, "created_at"),
      updatedAt: postgresTimestamp(row, "updated_at"),
    });
  }));
  const clients = Object.freeze((await client.query<PostgresRow>(`
    SELECT * FROM ${table("clients")} ORDER BY tenant_id, client_id
  `)).rows.map((row): MigrationClient => {
    const status = postgresText(row, "status");
    if (status !== "active" && status !== "disabled") {
      throw new Error("PostgreSQL migration readback is corrupt.");
    }
    return Object.freeze({
      tenantId: postgresText(row, "tenant_id"),
      clientId: postgresText(row, "client_id"),
      label: postgresText(row, "label"),
      status,
      createdAt: postgresTimestamp(row, "created_at"),
      updatedAt: postgresTimestamp(row, "updated_at"),
    });
  }));
  const credentials = Object.freeze((await client.query<PostgresRow>(`
    SELECT * FROM ${table("credentials")} ORDER BY created_at, credential_id
  `)).rows.map((row): MigrationCredential => {
    const status = postgresText(row, "status");
    if (status !== "active" && status !== "revoked") {
      throw new Error("PostgreSQL migration readback is corrupt.");
    }
    const roles = postgresStringArray(row, "roles");
    if (roles.length !== 1 || roles[0] !== "service" || postgresText(row, "actor_role") !== "service") {
      throw new Error("PostgreSQL migration readback is corrupt.");
    }
    return Object.freeze({
      credentialId: postgresText(row, "credential_id"),
      tenantId: postgresText(row, "tenant_id"),
      clientId: postgresText(row, "client_id"),
      label: postgresText(row, "label"),
      actorRole: "service",
      roles: Object.freeze(["service"] as const),
      scopes: postgresStringArray(row, "scopes"),
      status,
      deliveryAcknowledgedAt: postgresNullableTimestamp(row, "delivery_acknowledged_at"),
      keyPrefix: postgresText(row, "key_prefix"),
      secretLastFour: postgresText(row, "secret_last_four"),
      secretSalt: postgresBytes(row, "secret_salt"),
      secretHash: postgresBytes(row, "secret_hash"),
      pepperVersion: postgresText(row, "pepper_version"),
      createdAt: postgresTimestamp(row, "created_at"),
      expiresAt: postgresInteger(row, "expires_at"),
      lastUsedAt: postgresNullableTimestamp(row, "last_used_at"),
      revokedAt: postgresNullableTimestamp(row, "revoked_at"),
      rotatedFromId: postgresNullableText(row, "rotated_from_id"),
    });
  }));
  const events = Object.freeze((await client.query<PostgresRow>(`
    SELECT * FROM ${table("access_events")} ORDER BY created_at, event_id
  `)).rows.map((row): MigrationEvent => Object.freeze({
    eventId: postgresText(row, "event_id"),
    tenantId: postgresText(row, "tenant_id"),
    clientId: postgresNullableText(row, "client_id"),
    credentialId: postgresNullableText(row, "credential_id"),
    actorRef: postgresText(row, "actor_ref"),
    action: postgresText(row, "action"),
    reasonCode: postgresText(row, "reason_code"),
    createdAt: postgresTimestamp(row, "created_at"),
  })));
  const idempotency = Object.freeze((await client.query<PostgresRow>(`
    SELECT * FROM ${table("access_idempotency")} ORDER BY action, idempotency_key
  `)).rows.map((row): MigrationIdempotency => {
    const action = postgresText(row, "action");
    const resultId = postgresText(row, "result_id");
    const operationId = postgresText(row, "operation_id");
    const createdAt = postgresTimestamp(row, "created_at");
    const resultSnapshot = row.result_snapshot;
    return Object.freeze({
      action,
      idempotencyKey: postgresText(row, "idempotency_key"),
      requestHash: postgresText(row, "request_hash"),
      resultId,
      operationId,
      createdAt,
      resultSnapshotJson: resultSnapshot === null || resultSnapshot === undefined
        ? null
        : normalizeTenantAccessResultSnapshotJson(
            resultSnapshot,
            action,
            resultId,
            operationId,
            createdAt,
          ),
    });
  }));
  const audits = Object.freeze((await client.query<PostgresRow>(`
    SELECT * FROM ${table("gateway_audit")} ORDER BY created_at, audit_id
  `)).rows.map((row): MigrationAudit => Object.freeze({
    auditId: postgresText(row, "audit_id"),
    action: postgresText(row, "action"),
    status: postgresText(row, "status"),
    requestId: postgresText(row, "request_id"),
    tenantId: postgresNullableText(row, "tenant_id"),
    clientId: postgresNullableText(row, "client_id"),
    credentialId: postgresNullableText(row, "credential_id"),
    toolNames: postgresStringArray(row, "tool_names"),
    requestHash: postgresText(row, "request_hash"),
    jti: postgresNullableText(row, "jti"),
    reasonCode: postgresNullableText(row, "reason_code"),
    createdAt: postgresTimestamp(row, "created_at"),
  })));
  const rateWindows = Object.freeze((await client.query<PostgresRow>(`
    SELECT * FROM ${table("gateway_rate_windows")} ORDER BY bucket_key, window_start
  `)).rows.map((row): MigrationRateWindow => Object.freeze({
    bucketKey: postgresText(row, "bucket_key"),
    windowStart: postgresInteger(row, "window_start"),
    requestCount: postgresInteger(row, "request_count"),
  })));
  return Object.freeze({
    instanceId: postgresText(meta, "instance_id"),
    managementTenantId: postgresText(meta, "management_tenant_id"),
    accessStoreId: postgresText(meta, "source_access_store_id"),
    operationStoreId: postgresText(meta, "source_operation_store_id"),
    tenants,
    clients,
    credentials,
    events,
    idempotency,
    audits,
    rateWindows,
  });
}

async function insertMigrationSnapshot(
  client: PoolClient,
  configuration: PostgresGatewayConfiguration,
  snapshot: SqliteGatewayMigrationSnapshot,
): Promise<void> {
  const table = (name: string) => postgresQualifiedTable(configuration.schema, name);
  for (const tenant of snapshot.tenants) {
    await client.query(`
      INSERT INTO ${table("tenants")} (
        tenant_id, display_name, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5)
    `, [tenant.tenantId, tenant.displayName, tenant.status, tenant.createdAt, tenant.updatedAt]);
  }
  for (const gatewayClient of snapshot.clients) {
    await client.query(`
      INSERT INTO ${table("clients")} (
        tenant_id, client_id, label, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      gatewayClient.tenantId,
      gatewayClient.clientId,
      gatewayClient.label,
      gatewayClient.status,
      gatewayClient.createdAt,
      gatewayClient.updatedAt,
    ]);
  }
  const pendingCredentials = new Map(snapshot.credentials.map((credential) => [
    credential.credentialId,
    credential,
  ]));
  const insertedCredentials = new Set<string>();
  while (pendingCredentials.size > 0) {
    let insertedInPass = 0;
    for (const [credentialId, credential] of [...pendingCredentials]) {
      if (
        credential.rotatedFromId !== null &&
        !insertedCredentials.has(credential.rotatedFromId)
      ) {
        continue;
      }
      await client.query(`
        INSERT INTO ${table("credentials")} (
          credential_id, tenant_id, client_id, label, actor_role, roles, scopes, status,
          delivery_acknowledged_at, key_prefix, secret_last_four, secret_salt, secret_hash,
          pepper_version, created_at, expires_at, last_used_at, revoked_at, rotated_from_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19
        )
      `, [
        credential.credentialId,
        credential.tenantId,
        credential.clientId,
        credential.label,
        credential.actorRole,
        JSON.stringify(credential.roles),
        JSON.stringify(credential.scopes),
        credential.status,
        credential.deliveryAcknowledgedAt,
        credential.keyPrefix,
        credential.secretLastFour,
        Buffer.from(credential.secretSalt),
        Buffer.from(credential.secretHash),
        credential.pepperVersion,
        credential.createdAt,
        credential.expiresAt,
        credential.lastUsedAt,
        credential.revokedAt,
        credential.rotatedFromId,
      ]);
      pendingCredentials.delete(credentialId);
      insertedCredentials.add(credentialId);
      insertedInPass += 1;
    }
    if (insertedInPass === 0) {
      throw new Error("SQLite credential rotation graph is invalid.");
    }
  }
  for (const event of snapshot.events) {
    await client.query(`
      INSERT INTO ${table("access_events")} (
        event_id, tenant_id, client_id, credential_id, actor_ref, action, reason_code, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      event.eventId,
      event.tenantId,
      event.clientId,
      event.credentialId,
      event.actorRef,
      event.action,
      event.reasonCode,
      event.createdAt,
    ]);
  }
  for (const record of snapshot.idempotency) {
    await client.query(`
      INSERT INTO ${table("access_idempotency")} (
        action, idempotency_key, request_hash, result_id, operation_id, created_at,
        result_snapshot
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `, [
      record.action,
      record.idempotencyKey,
      record.requestHash,
      record.resultId,
      record.operationId,
      record.createdAt,
      record.resultSnapshotJson,
    ]);
  }
  for (const audit of snapshot.audits) {
    await client.query(`
      INSERT INTO ${table("gateway_audit")} (
        audit_id, action, status, request_id, tenant_id, client_id, credential_id,
        tool_names, request_hash, jti, reason_code, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
    `, [
      audit.auditId,
      audit.action,
      audit.status,
      audit.requestId,
      audit.tenantId,
      audit.clientId,
      audit.credentialId,
      JSON.stringify(audit.toolNames),
      audit.requestHash,
      audit.jti,
      audit.reasonCode,
      audit.createdAt,
    ]);
  }
  for (const rateWindow of snapshot.rateWindows) {
    await client.query(`
      INSERT INTO ${table("gateway_rate_windows")} (
        bucket_key, window_start, request_count
      ) VALUES ($1, $2, $3)
    `, [rateWindow.bucketKey, rateWindow.windowStart, rateWindow.requestCount]);
  }
}

export async function migratePostgresGatewaySchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const metaTable = postgresQualifiedTable(schema, "gateway_meta");
  const idempotencyTable = postgresQualifiedTable(schema, "access_idempotency");
  const meta = (await client.query<PostgresRow>(`
    SELECT schema_version FROM ${metaTable} WHERE singleton = true
  `)).rows[0];
  if (meta === undefined) throw new Error("PostgreSQL Access Gateway metadata is missing.");
  const currentVersion = postgresInteger(meta, "schema_version");
  if (currentVersion !== 1 && currentVersion !== POSTGRES_GATEWAY_SCHEMA_VERSION) {
    throw new Error("PostgreSQL Access Gateway schema version is unsupported.");
  }
  await client.query(`
    ALTER TABLE ${idempotencyTable}
    ADD COLUMN IF NOT EXISTS result_snapshot jsonb CHECK (
      result_snapshot IS NULL OR jsonb_typeof(result_snapshot) = 'object'
    )
  `);
  if (currentVersion === 1) {
    await client.query(`
      ALTER TABLE ${metaTable}
        DROP CONSTRAINT IF EXISTS gateway_meta_schema_version_check;
      UPDATE ${metaTable}
        SET schema_version = ${POSTGRES_GATEWAY_SCHEMA_VERSION}
        WHERE singleton = true;
      ALTER TABLE ${metaTable}
        ADD CONSTRAINT gateway_meta_schema_version_check
        CHECK (schema_version = ${POSTGRES_GATEWAY_SCHEMA_VERSION})
    `);
  }
  const resultColumn = (await client.query<PostgresRow>(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name = 'access_idempotency'
      AND column_name = 'result_snapshot'
  `, [schema])).rows[0];
  if (resultColumn === undefined || postgresText(resultColumn, "data_type") !== "jsonb") {
    throw new Error("PostgreSQL Access Gateway result snapshot column is invalid.");
  }
}

function assertResultSnapshotReadback(
  source: readonly MigrationIdempotency[],
  destination: readonly MigrationIdempotency[],
): void {
  const material = (records: readonly MigrationIdempotency[]) => records.map((record) => ({
    action: record.action,
    idempotency_key: record.idempotencyKey,
    result_snapshot_json: record.resultSnapshotJson,
  }));
  if (canonicalJson(material(source)) !== canonicalJson(material(destination))) {
    throw new Error("PostgreSQL migration result snapshot readback mismatch.");
  }
}

async function existingMigrationSummary(
  client: PoolClient,
  configuration: PostgresGatewayConfiguration,
  snapshot: SqliteGatewayMigrationSnapshot,
): Promise<GatewayMigrationSummary | null> {
  const namespace = (await client.query<{ exists: boolean }>(
    "SELECT to_regnamespace($1) IS NOT NULL AS exists",
    [configuration.schema],
  )).rows[0]?.exists === true;
  if (!namespace) return null;
  await migratePostgresGatewaySchema(client, configuration.schema);
  const history = (await client.query<PostgresRow>(`
    SELECT source_fingerprint, destination_fingerprint
    FROM ${postgresQualifiedTable(configuration.schema, "migration_history")}
    WHERE source_fingerprint = $1
  `, [snapshot.sourceFingerprint])).rows[0];
  if (history === undefined) {
    throw new Error("PostgreSQL Access Gateway schema is not an idempotent migration target.");
  }
  const destination = await readPostgresMigrationSnapshot(client, configuration);
  assertResultSnapshotReadback(snapshot.idempotency, destination.idempotency);
  const destinationFingerprint = snapshotFingerprint(destination);
  if (
    destinationFingerprint !== snapshot.sourceFingerprint ||
    postgresText(history, "destination_fingerprint") !== destinationFingerprint
  ) {
    throw new Error("PostgreSQL migration readback fingerprint mismatch.");
  }
  const counts = snapshotCounts(destination);
  if (canonicalJson(counts) !== canonicalJson(snapshot.counts)) {
    throw new Error("PostgreSQL migration readback count mismatch.");
  }
  return Object.freeze({
    status: "already_applied",
    backend: "postgresql",
    schema: configuration.schema,
    source_fingerprint: snapshot.sourceFingerprint,
    destination_fingerprint: destinationFingerprint,
    counts,
  });
}

export async function migrateSqliteGatewayToPostgres(input: Readonly<{
  applicationRoot: string;
  instanceId: string;
  managementTenantId: string;
  configuration: PostgresGatewayConfiguration;
  now?: () => Date;
}>): Promise<GatewayMigrationSummary> {
  const snapshot = readSqliteGatewayMigrationSnapshot(input);
  const pool = createPostgresPool(input.configuration);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify(["access-gateway-migration/v1", input.configuration.schema])],
    );
    const existing = await existingMigrationSummary(client, input.configuration, snapshot);
    if (existing !== null) {
      await client.query("COMMIT");
      return existing;
    }
    const appliedAt = (input.now ?? (() => new Date()))().toISOString();
    await initializePostgresGatewaySchema(client, input.configuration.schema, {
      storeId: `postgres_${randomBytes(16).toString("hex")}`,
      instanceId: input.instanceId,
      managementTenantId: input.managementTenantId,
      sourceAccessStoreId: snapshot.accessStoreId,
      sourceOperationStoreId: snapshot.operationStoreId,
      sourceFingerprint: snapshot.sourceFingerprint,
      createdAt: appliedAt,
    });
    await insertMigrationSnapshot(client, input.configuration, snapshot);
    const destination = await readPostgresMigrationSnapshot(client, input.configuration);
    assertResultSnapshotReadback(snapshot.idempotency, destination.idempotency);
    const destinationFingerprint = snapshotFingerprint(destination);
    const destinationCounts = snapshotCounts(destination);
    if (destinationFingerprint !== snapshot.sourceFingerprint) {
      throw new Error("PostgreSQL migration readback fingerprint mismatch.");
    }
    if (canonicalJson(destinationCounts) !== canonicalJson(snapshot.counts)) {
      throw new Error("PostgreSQL migration readback count mismatch.");
    }
    await client.query(`
      INSERT INTO ${postgresQualifiedTable(input.configuration.schema, "migration_history")} (
        migration_id, source_fingerprint, source_counts, destination_fingerprint, applied_at
      ) VALUES ($1, $2, $3::jsonb, $4, $5)
    `, [
      `sqlite_to_postgres_${snapshot.sourceFingerprint.slice(-24)}`,
      snapshot.sourceFingerprint,
      JSON.stringify(snapshot.counts),
      destinationFingerprint,
      appliedAt,
    ]);
    await client.query("COMMIT");
    return Object.freeze({
      status: "migrated",
      backend: "postgresql",
      schema: input.configuration.schema,
      source_fingerprint: snapshot.sourceFingerprint,
      destination_fingerprint: destinationFingerprint,
      counts: destinationCounts,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

export function migrateSqliteGatewayToPostgresFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GatewayMigrationSummary> {
  return migrateSqliteGatewayToPostgres({
    applicationRoot: requiredEnvironmentValue(environment, "ACCESS_GATEWAY_APPLICATION_ROOT"),
    instanceId: requiredEnvironmentValue(environment, "ACCESS_GATEWAY_INSTANCE_ID"),
    managementTenantId: requiredEnvironmentValue(
      environment,
      "ACCESS_GATEWAY_MANAGEMENT_TENANT_ID",
    ),
    configuration: postgresConfigurationFromEnvironment(environment),
  });
}
