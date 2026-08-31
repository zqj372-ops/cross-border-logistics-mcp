import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { Pool, type PoolClient, type PoolConfig } from "pg";

import {
  normalizeStoredTenantApiKeyScopes,
  type TenantApiKeyScope,
} from "../../src/logistics_mcp/control-plane/tenant-access-contracts";
import { IDENTIFIER_PATTERN } from "../../src/logistics_mcp/control-plane/lexical-contracts";
import type {
  ClientRecord,
  ClientStatus,
  StoredCredentialRecord as TenantStoredCredentialRecord,
  TenantAccessEventRecord,
  TenantAccessRepository,
  TenantAccessResponseContext,
  TenantAccessStateRecord,
  TenantAccessWriteResult,
  TenantRecord,
  TenantStatus,
} from "../../src/logistics_mcp/control-plane/tenant-access-repository";
import {
  TenantAccessRepositoryError,
} from "../../src/logistics_mcp/control-plane/tenant-access-repository";
import type { AuditEvent } from "./contracts";
import type {
  GatewayActivitySummary,
  GatewayOperationsReader,
  GatewayRecentIssue,
} from "./operations-overview";
import { isCanonicalGatewayTimestamp } from "./operations-overview";
import type {
  GatewayAuditEvidenceReader,
  GatewayAuditRepository,
  GatewayAuditRequestEvidence,
  RateLimitRepository,
} from "./ports";

export const POSTGRES_GATEWAY_SCHEMA_VERSION = 2 as const;

const DEFAULT_CONNECTION_TIMEOUT_MILLIS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MILLIS = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MILLIS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 8;
const MAX_SECRET_BYTES = 4_096;
const SQL_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const PEPPER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const AUDIT_REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{8,128}$/u;
const MAX_AUDIT_EVIDENCE_REQUEST_IDS = 32;
const RESULT_SNAPSHOT_FORMAT = "mcp-tenant-access-result/v1" as const;
const SNAPSHOT_BYTES_KEY = "__mcp_bytes_base64" as const;

type DatabaseRow = Record<string, unknown>;
type SnapshotEntityKind = "tenant" | "client" | "credential";

type ResultSnapshotPayload = Readonly<{
  readonly snapshot_format: typeof RESULT_SNAPSHOT_FORMAT;
  readonly entity_kind: SnapshotEntityKind;
  readonly entity: unknown;
  readonly operation: unknown;
  readonly snapshot: unknown;
}>;

type IdempotentWriteResult<T> = Readonly<{
  readonly resultId: string;
  readonly value: T;
  readonly operation: TenantAccessEventRecord;
  readonly snapshot: TenantAccessResponseContext;
}>;

export interface PostgresGatewayConfiguration {
  readonly backend: "postgresql";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly passwordFile: string;
  readonly schema: string;
  readonly sslMode: "disable" | "verify-full";
  readonly sslRootCertificateFile?: string;
  readonly maxConnections: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly statementTimeoutMillis: number;
}

export interface PostgresGatewayMeta {
  readonly storeId: string;
  readonly instanceId: string;
  readonly managementTenantId: string;
  readonly sourceAccessStoreId: string;
  readonly sourceOperationStoreId: string;
  readonly sourceFingerprint: string;
  readonly createdAt: string;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function integerEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function sqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`PostgreSQL ${label} is invalid.`);
  }
  return value;
}

function databaseHost(value: string): string {
  if (
    value.length > 253 ||
    value.startsWith("/") ||
    /\s/u.test(value) ||
    containsAsciiControl(value)
  ) {
    throw new Error("PostgreSQL host is invalid.");
  }
  return value;
}

function containsAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function secureRegularFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
  const resolved = resolve(path);
  const entry = lstatSync(resolved);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private regular file.`);
  }
  if (entry.size < 1 || entry.size > MAX_SECRET_BYTES) {
    throw new Error(`${label} has an invalid size.`);
  }
  return resolved;
}

export function readPostgresPassword(path: string): string {
  const resolved = secureRegularFile(path, "PostgreSQL password file");
  const bytes = readFileSync(resolved);
  try {
    const value = bytes.toString("utf8").replace(/\r?\n$/u, "");
    if (
      value.length < 8 ||
      value.length > 1_024 ||
      value.trim() !== value ||
      containsAsciiControl(value)
    ) {
      throw new Error("PostgreSQL password file content is invalid.");
    }
    return value;
  } finally {
    bytes.fill(0);
  }
}

export function postgresConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): PostgresGatewayConfiguration {
  if (environment.ACCESS_GATEWAY_STORE_BACKEND?.trim() !== "postgresql") {
    throw new Error("ACCESS_GATEWAY_STORE_BACKEND must equal postgresql.");
  }
  if (
    (environment.ACCESS_GATEWAY_POSTGRES_PASSWORD?.trim().length ?? 0) > 0 ||
    (environment.PGPASSWORD?.trim().length ?? 0) > 0
  ) {
    throw new Error("Access Gateway rejects plaintext PostgreSQL secrets.");
  }
  if (
    (environment.ACCESS_GATEWAY_POSTGRES_URL?.trim().length ?? 0) > 0 ||
    (environment.DATABASE_URL?.trim().length ?? 0) > 0
  ) {
    throw new Error("Access Gateway rejects PostgreSQL connection URLs.");
  }
  const sslMode = environmentValue(environment, "ACCESS_GATEWAY_POSTGRES_SSL_MODE");
  if (sslMode !== "disable" && sslMode !== "verify-full") {
    throw new Error("ACCESS_GATEWAY_POSTGRES_SSL_MODE must be disable or verify-full.");
  }
  const passwordFile = secureRegularFile(
    environmentValue(environment, "ACCESS_GATEWAY_POSTGRES_PASSWORD_FILE"),
    "PostgreSQL password file",
  );
  const rawCertificatePath = environment.ACCESS_GATEWAY_POSTGRES_SSL_ROOT_CERT_FILE?.trim();
  const sslRootCertificateFile = sslMode === "verify-full"
    ? secureRegularFile(
        rawCertificatePath === undefined || rawCertificatePath.length === 0
          ? environmentValue(environment, "ACCESS_GATEWAY_POSTGRES_SSL_ROOT_CERT_FILE")
          : rawCertificatePath,
        "PostgreSQL root certificate file",
      )
    : undefined;
  if (sslMode === "disable" && rawCertificatePath !== undefined && rawCertificatePath.length > 0) {
    throw new Error("PostgreSQL root certificate requires verify-full SSL mode.");
  }
  return Object.freeze({
    backend: "postgresql" as const,
    host: databaseHost(environmentValue(environment, "ACCESS_GATEWAY_POSTGRES_HOST")),
    port: integerEnvironmentValue(
      environment,
      "ACCESS_GATEWAY_POSTGRES_PORT",
      5_432,
      1,
      65_535,
    ),
    database: sqlIdentifier(
      environmentValue(environment, "ACCESS_GATEWAY_POSTGRES_DATABASE"),
      "database",
    ),
    user: sqlIdentifier(
      environmentValue(environment, "ACCESS_GATEWAY_POSTGRES_USER"),
      "user",
    ),
    passwordFile,
    schema: sqlIdentifier(
      environmentValue(environment, "ACCESS_GATEWAY_POSTGRES_SCHEMA"),
      "schema",
    ),
    sslMode,
    ...(sslRootCertificateFile === undefined ? {} : { sslRootCertificateFile }),
    maxConnections: integerEnvironmentValue(
      environment,
      "ACCESS_GATEWAY_POSTGRES_MAX_CONNECTIONS",
      DEFAULT_MAX_CONNECTIONS,
      2,
      32,
    ),
    connectionTimeoutMillis: integerEnvironmentValue(
      environment,
      "ACCESS_GATEWAY_POSTGRES_CONNECTION_TIMEOUT_MILLIS",
      DEFAULT_CONNECTION_TIMEOUT_MILLIS,
      500,
      30_000,
    ),
    idleTimeoutMillis: integerEnvironmentValue(
      environment,
      "ACCESS_GATEWAY_POSTGRES_IDLE_TIMEOUT_MILLIS",
      DEFAULT_IDLE_TIMEOUT_MILLIS,
      1_000,
      300_000,
    ),
    statementTimeoutMillis: integerEnvironmentValue(
      environment,
      "ACCESS_GATEWAY_POSTGRES_STATEMENT_TIMEOUT_MILLIS",
      DEFAULT_STATEMENT_TIMEOUT_MILLIS,
      500,
      30_000,
    ),
  });
}

function quoteIdentifier(value: string): string {
  return `"${sqlIdentifier(value, "schema")}"`;
}

function qualified(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}."${sqlIdentifier(table, "table")}"`;
}

export function postgresQualifiedTable(schema: string, table: string): string {
  return qualified(schema, table);
}

export function createPostgresPool(configuration: PostgresGatewayConfiguration): Pool {
  const password = readPostgresPassword(configuration.passwordFile);
  const poolConfiguration: PoolConfig = {
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
    user: configuration.user,
    password,
    application_name: "freightclaw-access-gateway",
    max: configuration.maxConnections,
    connectionTimeoutMillis: configuration.connectionTimeoutMillis,
    idleTimeoutMillis: configuration.idleTimeoutMillis,
    statement_timeout: configuration.statementTimeoutMillis,
    idle_in_transaction_session_timeout: configuration.statementTimeoutMillis,
    allowExitOnIdle: true,
    ssl: configuration.sslMode === "disable"
      ? false
      : {
          rejectUnauthorized: true,
          ca: readFileSync(configuration.sslRootCertificateFile!, "utf8"),
        },
  };
  return new Pool(poolConfiguration);
}

export function postgresGatewaySchemaSql(schema: string): string {
  const namespace = quoteIdentifier(schema);
  const table = (name: string) => qualified(schema, name);
  return `
CREATE SCHEMA ${namespace};

CREATE TABLE ${table("gateway_meta")} (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version = ${POSTGRES_GATEWAY_SCHEMA_VERSION}),
  store_id text NOT NULL,
  instance_id text NOT NULL,
  management_tenant_id text NOT NULL,
  source_access_store_id text NOT NULL,
  source_operation_store_id text NOT NULL,
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL
);

CREATE TABLE ${table("tenants")} (
  tenant_id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE ${table("clients")} (
  tenant_id text NOT NULL REFERENCES ${table("tenants")}(tenant_id),
  client_id text NOT NULL,
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, client_id)
);

CREATE TABLE ${table("credentials")} (
  credential_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  client_id text NOT NULL,
  label text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role = 'service'),
  roles jsonb NOT NULL CHECK (roles = '["service"]'::jsonb),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  delivery_acknowledged_at timestamptz,
  key_prefix text NOT NULL,
  secret_last_four text NOT NULL,
  secret_salt bytea NOT NULL,
  secret_hash bytea NOT NULL,
  pepper_version text NOT NULL CHECK (length(pepper_version) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at >= 0),
  last_used_at timestamptz,
  revoked_at timestamptz,
  rotated_from_id text REFERENCES ${table("credentials")}(credential_id),
  UNIQUE (credential_id, tenant_id),
  FOREIGN KEY (tenant_id, client_id)
    REFERENCES ${table("clients")}(tenant_id, client_id)
);

CREATE TABLE ${table("access_events")} (
  event_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES ${table("tenants")}(tenant_id),
  client_id text,
  credential_id text,
  actor_ref text NOT NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, client_id)
    REFERENCES ${table("clients")}(tenant_id, client_id),
  FOREIGN KEY (credential_id, tenant_id)
    REFERENCES ${table("credentials")}(credential_id, tenant_id)
);

CREATE TABLE ${table("access_idempotency")} (
  action text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  result_id text NOT NULL,
  operation_id text NOT NULL REFERENCES ${table("access_events")}(event_id),
  created_at timestamptz NOT NULL,
  result_snapshot jsonb CHECK (
    result_snapshot IS NULL OR jsonb_typeof(result_snapshot) = 'object'
  ),
  PRIMARY KEY (action, idempotency_key)
);

CREATE TABLE ${table("gateway_audit")} (
  audit_id text PRIMARY KEY,
  action text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'needs_input', 'manual_review', 'blocked', 'unavailable')),
  request_id text NOT NULL,
  tenant_id text,
  client_id text,
  credential_id text,
  tool_names jsonb NOT NULL CHECK (jsonb_typeof(tool_names) = 'array'),
  request_hash text NOT NULL,
  jti text,
  reason_code text,
  created_at timestamptz NOT NULL
);

CREATE TABLE ${table("gateway_rate_windows")} (
  bucket_key text NOT NULL,
  window_start bigint NOT NULL CHECK (window_start >= 0),
  request_count integer NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (bucket_key, window_start)
);

CREATE TABLE ${table("migration_history")} (
  migration_id text PRIMARY KEY,
  source_fingerprint text NOT NULL UNIQUE CHECK (source_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  source_counts jsonb NOT NULL CHECK (jsonb_typeof(source_counts) = 'object'),
  destination_fingerprint text NOT NULL CHECK (destination_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL
);

CREATE INDEX credentials_tenant_status_idx
  ON ${table("credentials")}(tenant_id, status, expires_at);
CREATE INDEX clients_tenant_status_idx
  ON ${table("clients")}(tenant_id, status, client_id);
CREATE INDEX access_events_created_idx
  ON ${table("access_events")}(created_at DESC, event_id DESC);
CREATE INDEX access_events_credential_action_idx
  ON ${table("access_events")}(credential_id, action, created_at DESC);
CREATE INDEX gateway_audit_created_idx
  ON ${table("gateway_audit")}(created_at DESC, audit_id DESC);
CREATE INDEX gateway_audit_credential_idx
  ON ${table("gateway_audit")}(credential_id, created_at DESC);
CREATE INDEX gateway_rate_windows_expiry_idx
  ON ${table("gateway_rate_windows")}(window_start);
`;
}

export async function initializePostgresGatewaySchema(
  client: PoolClient,
  schema: string,
  meta: PostgresGatewayMeta,
): Promise<void> {
  const namespace = sqlIdentifier(schema, "schema");
  const existing = await client.query<{ exists: boolean }>(
    "SELECT to_regnamespace($1) IS NOT NULL AS exists",
    [namespace],
  );
  if (existing.rows[0]?.exists === true) {
    throw new Error("PostgreSQL Access Gateway schema already exists.");
  }
  await client.query(postgresGatewaySchemaSql(namespace));
  await client.query(`
    INSERT INTO ${qualified(namespace, "gateway_meta")} (
      singleton, schema_version, store_id, instance_id, management_tenant_id,
      source_access_store_id, source_operation_store_id, source_fingerprint, created_at
    ) VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    POSTGRES_GATEWAY_SCHEMA_VERSION,
    meta.storeId,
    meta.instanceId,
    meta.managementTenantId,
    meta.sourceAccessStoreId,
    meta.sourceOperationStoreId,
    meta.sourceFingerprint,
    meta.createdAt,
  ]);
}

function repositoryFailure(
  code: ConstructorParameters<typeof TenantAccessRepositoryError>[0],
): never {
  throw new TenantAccessRepositoryError(code);
}

function text(row: DatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") repositoryFailure("corrupt");
  return value;
}

function nullableText(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") repositoryFailure("corrupt");
  return value;
}

function integer(row: DatabaseRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) repositoryFailure("corrupt");
  return parsed;
}

function timestampValue(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  repositoryFailure("corrupt");
}

function timestamp(row: DatabaseRow, key: string): string {
  return timestampValue(row[key]);
}

function nullableTimestamp(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : timestampValue(value);
}

function bytes(row: DatabaseRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) repositoryFailure("corrupt");
  return new Uint8Array(value);
}

function scopes(row: DatabaseRow, key: string): readonly TenantApiKeyScope[] {
  const value: unknown = row[key];
  if (!Array.isArray(value)) repositoryFailure("corrupt");
  const normalized = normalizeStoredTenantApiKeyScopes(value as unknown[]);
  if (normalized === null) repositoryFailure("corrupt");
  return normalized;
}

function isPlainSnapshotObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactSnapshotObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isPlainSnapshotObject(value)) repositoryFailure("corrupt");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) repositoryFailure("corrupt");
  return value;
}

function snapshotString(value: unknown): string {
  if (typeof value !== "string") repositoryFailure("corrupt");
  return value;
}

function snapshotIdentifier(value: unknown): string {
  const identifier = snapshotString(value);
  if (!IDENTIFIER_PATTERN.test(identifier)) repositoryFailure("corrupt");
  return identifier;
}

function snapshotNullableIdentifier(value: unknown): string | null {
  return value === null ? null : snapshotIdentifier(value);
}

function snapshotTimestamp(value: unknown): string {
  const candidate = snapshotString(value);
  if (
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u.test(candidate) ||
    !Number.isFinite(Date.parse(candidate))
  ) {
    repositoryFailure("corrupt");
  }
  return candidate;
}

function snapshotNullableTimestamp(value: unknown): string | null {
  return value === null ? null : snapshotTimestamp(value);
}

function snapshotStatus<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) repositoryFailure("corrupt");
  return value as T;
}

function snapshotBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0) repositoryFailure("corrupt");
    return new Uint8Array(value);
  }
  const tagged = exactSnapshotObject(value, [SNAPSHOT_BYTES_KEY]);
  const encoded = snapshotString(tagged[SNAPSHOT_BYTES_KEY]);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    repositoryFailure("corrupt");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength === 0 || decoded.toString("base64") !== encoded) {
    repositoryFailure("corrupt");
  }
  return new Uint8Array(decoded);
}

function snapshotScopes(value: unknown): readonly TenantApiKeyScope[] {
  if (!Array.isArray(value)) repositoryFailure("corrupt");
  const normalized = normalizeStoredTenantApiKeyScopes(value);
  if (normalized === null || JSON.stringify(normalized) !== JSON.stringify(value)) {
    repositoryFailure("corrupt");
  }
  return normalized;
}

function snapshotEntityKind(action: string): SnapshotEntityKind {
  switch (action) {
    case "tenant.create":
    case "tenant.status":
      return "tenant";
    case "client.status":
      return "client";
    case "credential.issue":
    case "credential.rotate":
    case "credential.revoke":
    case "credential.delivery_acknowledge":
      return "credential";
    default:
      repositoryFailure("corrupt");
  }
}

function expectedSnapshotEventActions(action: string): readonly string[] {
  switch (action) {
    case "tenant.create":
      return ["tenant.created"];
    case "tenant.status":
      return ["tenant.active", "tenant.suspended"];
    case "client.status":
      return ["client.active", "client.disabled"];
    case "credential.issue":
      return ["credential.issued"];
    case "credential.rotate":
      return ["credential.rotated"];
    case "credential.revoke":
      return ["credential.revoked"];
    case "credential.delivery_acknowledge":
      return ["credential.delivery_acknowledged"];
    default:
      repositoryFailure("corrupt");
  }
}

function snapshotTenant(value: unknown): TenantRecord {
  const entity = exactSnapshotObject(value, [
    "tenantId", "displayName", "status", "createdAt", "updatedAt",
  ]);
  return Object.freeze({
    tenantId: snapshotIdentifier(entity.tenantId),
    displayName: snapshotString(entity.displayName),
    status: snapshotStatus(entity.status, ["active", "suspended"] as const),
    createdAt: snapshotTimestamp(entity.createdAt),
    updatedAt: snapshotTimestamp(entity.updatedAt),
  });
}

function snapshotClient(value: unknown): ClientRecord {
  const entity = exactSnapshotObject(value, [
    "clientId", "tenantId", "label", "status", "createdAt", "updatedAt",
  ]);
  return Object.freeze({
    clientId: snapshotIdentifier(entity.clientId),
    tenantId: snapshotIdentifier(entity.tenantId),
    label: snapshotString(entity.label),
    status: snapshotStatus(entity.status, ["active", "disabled"] as const),
    createdAt: snapshotTimestamp(entity.createdAt),
    updatedAt: snapshotTimestamp(entity.updatedAt),
  });
}

function snapshotCredential(value: unknown): TenantStoredCredentialRecord {
  const entity = exactSnapshotObject(value, [
    "credentialId", "tenantId", "clientId", "label", "actorRole", "roles", "scopes",
    "status", "keyPrefix", "secretLastFour", "secretSalt", "secretHash", "pepperVersion",
    "createdAt", "expiresAt", "lastUsedAt", "revokedAt", "rotatedFromId",
  ]);
  const roles = entity.roles;
  if (!Array.isArray(roles) || JSON.stringify(roles) !== '["service"]') {
    repositoryFailure("corrupt");
  }
  const keyPrefix = snapshotString(entity.keyPrefix);
  if (!/^lmcpk_[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(keyPrefix)) {
    repositoryFailure("corrupt");
  }
  const secretLastFour = snapshotString(entity.secretLastFour);
  if (!/^[A-Za-z0-9_-]{4}$/u.test(secretLastFour)) repositoryFailure("corrupt");
  const pepperVersion = snapshotString(entity.pepperVersion);
  if (!PEPPER_VERSION_PATTERN.test(pepperVersion)) repositoryFailure("corrupt");
  const expiresAt = entity.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 1) {
    repositoryFailure("corrupt");
  }
  return Object.freeze({
    credentialId: snapshotIdentifier(entity.credentialId),
    tenantId: snapshotIdentifier(entity.tenantId),
    clientId: snapshotIdentifier(entity.clientId),
    label: snapshotString(entity.label),
    actorRole: snapshotStatus(entity.actorRole, ["service"] as const),
    roles: Object.freeze(["service"] as const),
    scopes: snapshotScopes(entity.scopes),
    status: snapshotStatus(entity.status, ["active", "revoked"] as const),
    keyPrefix,
    secretLastFour,
    secretSalt: snapshotBytes(entity.secretSalt),
    secretHash: snapshotBytes(entity.secretHash),
    pepperVersion,
    createdAt: snapshotTimestamp(entity.createdAt),
    expiresAt,
    lastUsedAt: snapshotNullableTimestamp(entity.lastUsedAt),
    revokedAt: snapshotNullableTimestamp(entity.revokedAt),
    rotatedFromId: snapshotNullableIdentifier(entity.rotatedFromId),
  });
}

function snapshotOperation(
  value: unknown,
  action: string,
  resultId: string,
  operationId: string,
  createdAt: string,
): TenantAccessEventRecord {
  const operation = exactSnapshotObject(value, [
    "eventId", "tenantId", "clientId", "credentialId", "actorRef", "action",
    "reasonCode", "createdAt",
  ]);
  const operationAction = snapshotString(operation.action);
  if (!expectedSnapshotEventActions(action).includes(operationAction)) {
    repositoryFailure("corrupt");
  }
  const normalized = Object.freeze({
    eventId: snapshotIdentifier(operation.eventId),
    tenantId: snapshotIdentifier(operation.tenantId),
    clientId: snapshotNullableIdentifier(operation.clientId),
    credentialId: snapshotNullableIdentifier(operation.credentialId),
    actorRef: snapshotIdentifier(operation.actorRef),
    action: operationAction,
    reasonCode: snapshotIdentifier(operation.reasonCode),
    createdAt: snapshotTimestamp(operation.createdAt),
  });
  if (normalized.eventId !== operationId || normalized.createdAt !== createdAt) {
    repositoryFailure("corrupt");
  }
  if (action === "tenant.create" || action === "tenant.status") {
    if (
      normalized.tenantId !== resultId ||
      normalized.clientId !== null ||
      normalized.credentialId !== null
    ) {
      repositoryFailure("corrupt");
    }
  } else if (action === "client.status") {
    if (normalized.clientId !== resultId || normalized.credentialId !== null) {
      repositoryFailure("corrupt");
    }
  } else if (normalized.credentialId !== resultId || normalized.clientId === null) {
    repositoryFailure("corrupt");
  }
  return normalized;
}

function snapshotResponseContext(value: unknown): TenantAccessResponseContext {
  const snapshot = exactSnapshotObject(value, [
    "tenantStatus", "clientStatus", "deliveryAcknowledgedAt",
  ]);
  return Object.freeze({
    tenantStatus: snapshot.tenantStatus === null
      ? null
      : snapshotStatus(snapshot.tenantStatus, ["active", "suspended"] as const),
    clientStatus: snapshot.clientStatus === null
      ? null
      : snapshotStatus(snapshot.clientStatus, ["active", "disabled"] as const),
    deliveryAcknowledgedAt: snapshotNullableTimestamp(snapshot.deliveryAcknowledgedAt),
  });
}

function normalizedResultSnapshot(
  value: unknown,
  action: string,
  resultId: string,
  operationId: string,
  createdAt: string,
): Readonly<{
  value: TenantRecord | ClientRecord | TenantStoredCredentialRecord;
  operation: TenantAccessEventRecord;
  snapshot: TenantAccessResponseContext;
}> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      repositoryFailure("corrupt");
    }
  }
  const payload = exactSnapshotObject(parsed, [
    "snapshot_format", "entity_kind", "entity", "operation", "snapshot",
  ]) as unknown as ResultSnapshotPayload;
  if (payload.snapshot_format !== RESULT_SNAPSHOT_FORMAT) repositoryFailure("corrupt");
  const entityKind = payload.entity_kind;
  if (entityKind !== snapshotEntityKind(action)) repositoryFailure("corrupt");
  const operation = snapshotOperation(
    payload.operation,
    action,
    resultId,
    operationId,
    createdAt,
  );
  const snapshot = snapshotResponseContext(payload.snapshot);
  const entity = entityKind === "tenant"
    ? snapshotTenant(payload.entity)
    : entityKind === "client"
      ? snapshotClient(payload.entity)
      : snapshotCredential(payload.entity);
  const entityId = entityKind === "tenant"
    ? entity.tenantId
    : entityKind === "client"
      ? (entity as ClientRecord).clientId
      : (entity as TenantStoredCredentialRecord).credentialId;
  if (entityId !== resultId || operation.tenantId !== entity.tenantId) {
    repositoryFailure("corrupt");
  }
  if (entityKind === "tenant") {
    if (
      snapshot.tenantStatus !== (entity as TenantRecord).status ||
      snapshot.clientStatus !== null ||
      snapshot.deliveryAcknowledgedAt !== null
    ) {
      repositoryFailure("corrupt");
    }
  } else if (entityKind === "client") {
    const gatewayClient = entity as ClientRecord;
    if (
      operation.clientId !== gatewayClient.clientId ||
      snapshot.tenantStatus === null ||
      snapshot.clientStatus !== gatewayClient.status ||
      snapshot.deliveryAcknowledgedAt !== null
    ) {
      repositoryFailure("corrupt");
    }
  } else {
    const credential = entity as TenantStoredCredentialRecord;
    if (
      operation.clientId !== credential.clientId ||
      operation.credentialId !== credential.credentialId ||
      snapshot.tenantStatus === null ||
      snapshot.clientStatus === null
    ) {
      repositoryFailure("corrupt");
    }
    if (
      action === "credential.delivery_acknowledge" &&
      snapshot.deliveryAcknowledgedAt !== operation.createdAt
    ) {
      repositoryFailure("corrupt");
    }
    if (
      (action === "credential.issue" || action === "credential.rotate") &&
      snapshot.deliveryAcknowledgedAt !== null
    ) {
      repositoryFailure("corrupt");
    }
  }
  return Object.freeze({ value: entity, operation, snapshot });
}

function stringifyResultSnapshot(payload: ResultSnapshotPayload): string {
  const json = JSON.stringify(payload, (_key: string, current: unknown): unknown => (
    current instanceof Uint8Array
      ? { [SNAPSHOT_BYTES_KEY]: Buffer.from(current).toString("base64") }
      : current
  ));
  if (json === undefined) repositoryFailure("corrupt");
  return json;
}

function decodeResultSnapshot<T>(
  value: unknown,
  action: string,
  resultId: string,
  operationId: string,
  createdAt: string,
): Readonly<{
  value: T;
  operation: TenantAccessEventRecord;
  snapshot: TenantAccessResponseContext;
}> {
  const normalized = normalizedResultSnapshot(value, action, resultId, operationId, createdAt);
  return Object.freeze({
    value: normalized.value as T,
    operation: normalized.operation,
    snapshot: normalized.snapshot,
  });
}

export function normalizeTenantAccessResultSnapshotJson(
  value: unknown,
  action: string,
  resultId: string,
  operationId: string,
  createdAt: string,
): string {
  const normalized = normalizedResultSnapshot(value, action, resultId, operationId, createdAt);
  return stringifyResultSnapshot({
    snapshot_format: RESULT_SNAPSHOT_FORMAT,
    entity_kind: snapshotEntityKind(action),
    entity: normalized.value,
    operation: normalized.operation,
    snapshot: normalized.snapshot,
  });
}

function serializeResultSnapshot<T>(
  action: string,
  resultId: string,
  createdAt: string,
  value: T,
  operation: TenantAccessEventRecord,
  snapshot: TenantAccessResponseContext,
): string {
  return normalizeTenantAccessResultSnapshotJson(
    stringifyResultSnapshot({
      snapshot_format: RESULT_SNAPSHOT_FORMAT,
      entity_kind: snapshotEntityKind(action),
      entity: value,
      operation,
      snapshot,
    }),
    action,
    resultId,
    operation.eventId,
    createdAt,
  );
}

function resultSnapshotContext(
  tenantStatus: TenantStatus | null,
  clientStatus: ClientStatus | null,
  deliveryAcknowledgedAt: string | null,
): TenantAccessResponseContext {
  return Object.freeze({ tenantStatus, clientStatus, deliveryAcknowledgedAt });
}

function tenantFromRow(row: DatabaseRow): TenantRecord {
  const status = text(row, "status");
  if (status !== "active" && status !== "suspended") repositoryFailure("corrupt");
  return Object.freeze({
    tenantId: text(row, "tenant_id"),
    displayName: text(row, "display_name"),
    status,
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  });
}

function clientFromRow(row: DatabaseRow): ClientRecord {
  const status = text(row, "status");
  if (status !== "active" && status !== "disabled") repositoryFailure("corrupt");
  return Object.freeze({
    tenantId: text(row, "tenant_id"),
    clientId: text(row, "client_id"),
    label: text(row, "label"),
    status,
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  });
}

function credentialFromRow(row: DatabaseRow): TenantStoredCredentialRecord {
  const status = text(row, "status");
  if (status !== "active" && status !== "revoked") repositoryFailure("corrupt");
  if (text(row, "actor_role") !== "service") repositoryFailure("corrupt");
  const roles: unknown = row.roles;
  if (!Array.isArray(roles) || roles.length !== 1 || roles[0] !== "service") {
    repositoryFailure("corrupt");
  }
  const pepperVersion = text(row, "pepper_version");
  if (!PEPPER_VERSION_PATTERN.test(pepperVersion)) repositoryFailure("corrupt");
  return Object.freeze({
    credentialId: text(row, "credential_id"),
    tenantId: text(row, "tenant_id"),
    clientId: text(row, "client_id"),
    label: text(row, "label"),
    actorRole: "service",
    roles: Object.freeze(["service"] as const),
    scopes: scopes(row, "scopes"),
    status,
    keyPrefix: text(row, "key_prefix"),
    secretLastFour: text(row, "secret_last_four"),
    secretSalt: bytes(row, "secret_salt"),
    secretHash: bytes(row, "secret_hash"),
    pepperVersion,
    createdAt: timestamp(row, "created_at"),
    expiresAt: integer(row, "expires_at"),
    lastUsedAt: nullableTimestamp(row, "last_used_at"),
    revokedAt: nullableTimestamp(row, "revoked_at"),
    rotatedFromId: nullableText(row, "rotated_from_id"),
  });
}

function eventFromRow(row: DatabaseRow): TenantAccessEventRecord {
  return Object.freeze({
    eventId: text(row, "event_id"),
    tenantId: text(row, "tenant_id"),
    clientId: nullableText(row, "client_id"),
    credentialId: nullableText(row, "credential_id"),
    actorRef: text(row, "actor_ref"),
    action: text(row, "action"),
    reasonCode: text(row, "reason_code"),
    createdAt: timestamp(row, "created_at"),
  });
}

async function insertEvent(client: PoolClient, schema: string, event: TenantAccessEventRecord) {
  await client.query(`
    INSERT INTO ${qualified(schema, "access_events")} (
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

async function insertCredential(
  client: PoolClient,
  schema: string,
  credential: TenantStoredCredentialRecord,
) {
  await client.query(`
    INSERT INTO ${qualified(schema, "credentials")} (
      credential_id, tenant_id, client_id, label, actor_role, roles, scopes, status,
      delivery_acknowledged_at, key_prefix, secret_last_four, secret_salt, secret_hash,
      pepper_version, created_at, expires_at, last_used_at, revoked_at, rotated_from_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8,
      NULL, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
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
}

export interface PostgresGatewayStoreOptions {
  readonly configuration: PostgresGatewayConfiguration;
  readonly instanceId: string;
  readonly managementTenantId: string;
  readonly rateLimitPerMinute?: number;
  readonly pool?: Pool;
}

export class PostgresGatewayStore implements
  TenantAccessRepository,
  GatewayAuditRepository,
  GatewayAuditEvidenceReader,
  RateLimitRepository,
  GatewayOperationsReader {
  readonly kind = "production" as const;
  readonly managementTenantId: string;
  readonly #configuration: PostgresGatewayConfiguration;
  readonly #instanceId: string;
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #rateLimitPerMinute: number;
  #closed = false;

  private constructor(options: PostgresGatewayStoreOptions) {
    this.#configuration = options.configuration;
    this.#instanceId = options.instanceId;
    this.managementTenantId = options.managementTenantId;
    const limit = options.rateLimitPerMinute ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("Gateway rate limit must be an integer from 1 through 10000.");
    }
    this.#rateLimitPerMinute = limit;
    this.#pool = options.pool ?? createPostgresPool(options.configuration);
    this.#ownsPool = options.pool === undefined;
  }

  static async open(options: PostgresGatewayStoreOptions): Promise<PostgresGatewayStore> {
    const store = new PostgresGatewayStore(options);
    try {
      await store.#verify();
      return store;
    } catch (error) {
      if (store.#ownsPool) await store.#pool.end().catch(() => undefined);
      throw error;
    }
  }

  #active(): Pool {
    if (this.#closed) repositoryFailure("closed");
    return this.#pool;
  }

  async #verify(): Promise<void> {
    const row = (await this.#active().query<DatabaseRow>(`
      SELECT schema_version, instance_id, management_tenant_id
      FROM ${qualified(this.#configuration.schema, "gateway_meta")}
      WHERE singleton = true
    `)).rows[0];
    if (
      row === undefined ||
      integer(row, "schema_version") !== POSTGRES_GATEWAY_SCHEMA_VERSION ||
      text(row, "instance_id") !== this.#instanceId ||
      text(row, "management_tenant_id") !== this.managementTenantId
    ) {
      repositoryFailure("schema_unsupported");
    }
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#active().connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = '${this.#configuration.statementTimeoutMillis}ms'`);
      await client.query(
        `SET LOCAL idle_in_transaction_session_timeout = '${this.#configuration.statementTimeoutMillis}ms'`,
      );
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #readSnapshot<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#active().connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #auditWriteProbe(): Promise<void> {
    const client = await this.#active().connect();
    const auditId = `audit_health_probe_${randomBytes(16).toString("hex")}`;
    const requestId = `req_health_probe_${randomBytes(16).toString("hex")}`;
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(`SET LOCAL statement_timeout = '${this.#configuration.statementTimeoutMillis}ms'`);
      await client.query(
        `SET LOCAL idle_in_transaction_session_timeout = '${this.#configuration.statementTimeoutMillis}ms'`,
      );
      await client.query(`
        INSERT INTO ${qualified(this.#configuration.schema, "gateway_audit")} (
          audit_id, action, status, request_id, tenant_id, client_id, credential_id,
          tool_names, request_hash, jti, reason_code, created_at
        ) VALUES ($1, 'health.probe', 'success', $2, NULL, NULL, NULL,
          '[]'::jsonb, 'health-probe', NULL, NULL, '1970-01-01T00:00:00.000Z')
      `, [auditId, requestId]);
      await client.query("ROLLBACK");
      transactionStarted = false;
      const leftover = (await client.query<DatabaseRow>(`
        SELECT COUNT(*) AS count
        FROM ${qualified(this.#configuration.schema, "gateway_audit")}
        WHERE audit_id = $1
      `, [auditId])).rows[0];
      if (leftover === undefined || integer(leftover, "count") !== 0) {
        repositoryFailure("corrupt");
      }
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #tenant(client: PoolClient, tenantId: string, lock = false): Promise<TenantRecord> {
    const row = (await client.query<DatabaseRow>(`
      SELECT * FROM ${qualified(this.#configuration.schema, "tenants")}
      WHERE tenant_id = $1${lock ? " FOR UPDATE" : ""}
    `, [tenantId])).rows[0];
    if (row === undefined) repositoryFailure("tenant_not_found");
    return tenantFromRow(row);
  }

  async #client(
    client: PoolClient,
    tenantId: string,
    clientId: string,
    lock = false,
  ): Promise<ClientRecord> {
    const row = (await client.query<DatabaseRow>(`
      SELECT * FROM ${qualified(this.#configuration.schema, "clients")}
      WHERE tenant_id = $1 AND client_id = $2${lock ? " FOR UPDATE" : ""}
    `, [tenantId, clientId])).rows[0];
    if (row === undefined) repositoryFailure("client_not_found");
    return clientFromRow(row);
  }

  async #credential(
    client: PoolClient,
    credentialId: string,
    lock = false,
  ): Promise<TenantStoredCredentialRecord> {
    const row = (await client.query<DatabaseRow>(`
      SELECT * FROM ${qualified(this.#configuration.schema, "credentials")}
      WHERE credential_id = $1${lock ? " FOR UPDATE" : ""}
    `, [credentialId])).rows[0];
    if (row === undefined) repositoryFailure("credential_not_found");
    return credentialFromRow(row);
  }

  async #deliveryAcknowledgedAt(
    client: PoolClient,
    credentialId: string,
  ): Promise<string | null> {
    const row = (await client.query<DatabaseRow>(`
      SELECT delivery_acknowledged_at
      FROM ${qualified(this.#configuration.schema, "credentials")}
      WHERE credential_id = $1
    `, [credentialId])).rows[0];
    if (row === undefined) repositoryFailure("credential_not_found");
    return nullableTimestamp(row, "delivery_acknowledged_at");
  }

  async #idempotent<T>(
    client: PoolClient,
    action: string,
    idempotencyKey: string,
    requestHash: string,
    createdAt: string,
    write: () => Promise<IdempotentWriteResult<T>>,
  ): Promise<TenantAccessWriteResult<T>> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify(["access-gateway-idempotency/v1", action, idempotencyKey])],
    );
    const existing = (await client.query<DatabaseRow>(`
      SELECT request_hash, result_id, operation_id, created_at, result_snapshot
      FROM ${qualified(this.#configuration.schema, "access_idempotency")}
      WHERE action = $1 AND idempotency_key = $2
      FOR UPDATE
    `, [action, idempotencyKey])).rows[0];
    if (existing !== undefined) {
      if (text(existing, "request_hash") !== requestHash) {
        repositoryFailure("idempotency_conflict");
      }
      const resultId = text(existing, "result_id");
      const operationId = text(existing, "operation_id");
      const loaded = decodeResultSnapshot<T>(
        existing.result_snapshot,
        action,
        resultId,
        operationId,
        timestamp(existing, "created_at"),
      );
      return Object.freeze({
        replayed: true,
        value: loaded.value,
        operation: loaded.operation,
        snapshot: loaded.snapshot,
      });
    }
    const result = await write();
    const resultSnapshot = serializeResultSnapshot(
      action,
      result.resultId,
      createdAt,
      result.value,
      result.operation,
      result.snapshot,
    );
    await client.query(`
      INSERT INTO ${qualified(this.#configuration.schema, "access_idempotency")} (
        action, idempotency_key, request_hash, result_id, operation_id, created_at,
        result_snapshot
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `, [
      action,
      idempotencyKey,
      requestHash,
      result.resultId,
      result.operation.eventId,
      createdAt,
      resultSnapshot,
    ]);
    return Object.freeze({
      replayed: false,
      value: result.value,
      operation: result.operation,
      snapshot: result.snapshot,
    });
  }

  getState(): Promise<TenantAccessStateRecord> {
    return this.#readSnapshot(async (client) => {
      const tenantRows = await client.query<DatabaseRow>(`
        SELECT * FROM ${qualified(this.#configuration.schema, "tenants")} ORDER BY tenant_id
      `);
      const clientRows = await client.query<DatabaseRow>(`
        SELECT * FROM ${qualified(this.#configuration.schema, "clients")}
        ORDER BY tenant_id, client_id
      `);
      const credentialRows = await client.query<DatabaseRow>(`
        SELECT * FROM ${qualified(this.#configuration.schema, "credentials")}
        ORDER BY created_at DESC, credential_id DESC
      `);
      const eventRows = await client.query<DatabaseRow>(`
        SELECT * FROM ${qualified(this.#configuration.schema, "access_events")}
        ORDER BY created_at DESC, event_id DESC LIMIT 256
      `);
      const deliveryAcknowledgements = Object.freeze(Object.fromEntries(
        credentialRows.rows.flatMap((row) => {
          const acknowledgedAt = nullableTimestamp(row, "delivery_acknowledged_at");
          return acknowledgedAt === null ? [] : [[text(row, "credential_id"), acknowledgedAt]];
        }),
      ));
      return Object.freeze({
        tenants: Object.freeze(tenantRows.rows.map(tenantFromRow)),
        clients: Object.freeze(clientRows.rows.map(clientFromRow)),
        credentials: Object.freeze(credentialRows.rows.map(credentialFromRow)),
        events: Object.freeze(eventRows.rows.map(eventFromRow)),
        deliveryAcknowledgements,
      });
    });
  }

  createTenant(request: {
    readonly tenant: TenantRecord;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantRecord>> {
    return this.#transaction((client) => this.#idempotent(
      client,
      "tenant.create",
      request.idempotencyKey,
      request.requestHash,
      request.tenant.createdAt,
      async () => {
        const existing = await client.query(
          `SELECT 1 FROM ${qualified(this.#configuration.schema, "tenants")} WHERE tenant_id = $1`,
          [request.tenant.tenantId],
        );
        if (existing.rowCount !== 0) repositoryFailure("tenant_already_exists");
        await client.query(`
          INSERT INTO ${qualified(this.#configuration.schema, "tenants")} (
            tenant_id, display_name, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5)
        `, [
          request.tenant.tenantId,
          request.tenant.displayName,
          request.tenant.status,
          request.tenant.createdAt,
          request.tenant.updatedAt,
        ]);
        await insertEvent(client, this.#configuration.schema, request.event);
        return Object.freeze({
          resultId: request.tenant.tenantId,
          value: request.tenant,
          operation: request.event,
          snapshot: resultSnapshotContext(request.tenant.status, null, null),
        });
      },
    ));
  }

  setTenantStatus(request: {
    readonly tenantId: string;
    readonly status: TenantStatus;
    readonly updatedAt: string;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantRecord>> {
    return this.#transaction((client) => this.#idempotent(
      client,
      "tenant.status",
      request.idempotencyKey,
      request.requestHash,
      request.updatedAt,
      async () => {
        const tenant = await this.#tenant(client, request.tenantId, true);
        if (tenant.status === request.status) repositoryFailure("tenant_status_unchanged");
        await client.query(`
          UPDATE ${qualified(this.#configuration.schema, "tenants")}
          SET status = $1, updated_at = $2 WHERE tenant_id = $3
        `, [request.status, request.updatedAt, request.tenantId]);
        await insertEvent(client, this.#configuration.schema, request.event);
        const value = await this.#tenant(client, request.tenantId);
        return Object.freeze({
          resultId: request.tenantId,
          value,
          operation: request.event,
          snapshot: resultSnapshotContext(value.status, null, null),
        });
      },
    ));
  }

  setClientStatus(request: {
    readonly tenantId: string;
    readonly clientId: string;
    readonly status: ClientStatus;
    readonly updatedAt: string;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<ClientRecord>> {
    return this.#transaction((client) => this.#idempotent(
      client,
      "client.status",
      request.idempotencyKey,
      request.requestHash,
      request.updatedAt,
      async () => {
        const tenant = await this.#tenant(client, request.tenantId, true);
        if (request.status === "active" && tenant.status !== "active") {
          repositoryFailure("tenant_not_active");
        }
        const existing = await this.#client(client, request.tenantId, request.clientId, true);
        if (existing.status === request.status) repositoryFailure("client_status_unchanged");
        await client.query(`
          UPDATE ${qualified(this.#configuration.schema, "clients")}
          SET status = $1, updated_at = $2
          WHERE tenant_id = $3 AND client_id = $4
        `, [request.status, request.updatedAt, request.tenantId, request.clientId]);
        await insertEvent(client, this.#configuration.schema, request.event);
        const value = await this.#client(client, request.tenantId, request.clientId);
        return Object.freeze({
          resultId: request.clientId,
          value,
          operation: request.event,
          snapshot: resultSnapshotContext(tenant.status, value.status, null),
        });
      },
    ));
  }

  issueCredential(request: {
    readonly credential: TenantStoredCredentialRecord;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantStoredCredentialRecord>> {
    return this.#transaction((client) => this.#idempotent(
      client,
      "credential.issue",
      request.idempotencyKey,
      request.requestHash,
      request.credential.createdAt,
      async () => {
        const tenant = await this.#tenant(client, request.credential.tenantId, true);
        if (tenant.status !== "active") repositoryFailure("tenant_not_active");
        const clientRow = (await client.query<DatabaseRow>(`
          SELECT * FROM ${qualified(this.#configuration.schema, "clients")}
          WHERE tenant_id = $1 AND client_id = $2 FOR UPDATE
        `, [request.credential.tenantId, request.credential.clientId])).rows[0];
        if (clientRow === undefined) {
          await client.query(`
            INSERT INTO ${qualified(this.#configuration.schema, "clients")} (
              tenant_id, client_id, label, status, created_at, updated_at
            ) VALUES ($1, $2, $3, 'active', $4, $4)
          `, [
            request.credential.tenantId,
            request.credential.clientId,
            request.credential.label,
            request.credential.createdAt,
          ]);
          await insertEvent(client, this.#configuration.schema, Object.freeze({
            eventId: `${request.event.eventId}_client_created`,
            tenantId: request.credential.tenantId,
            clientId: request.credential.clientId,
            credentialId: null,
            actorRef: request.event.actorRef,
            action: "client.created",
            reasonCode: "credential_issue_created_client",
            createdAt: request.credential.createdAt,
          }));
        } else if (clientFromRow(clientRow).status !== "active") {
          repositoryFailure("client_not_active");
        }
        await insertCredential(client, this.#configuration.schema, request.credential);
        await insertEvent(client, this.#configuration.schema, request.event);
        return Object.freeze({
          resultId: request.credential.credentialId,
          value: request.credential,
          operation: request.event,
          snapshot: resultSnapshotContext(tenant.status, "active", null),
        });
      },
    ));
  }

  rotateCredential(request: {
    readonly previousCredentialId: string;
    readonly credential: TenantStoredCredentialRecord;
    readonly revokedAt: string;
    readonly nowSeconds: number;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantStoredCredentialRecord>> {
    return this.#transaction((client) => this.#idempotent(
      client,
      "credential.rotate",
      request.idempotencyKey,
      request.requestHash,
      request.credential.createdAt,
      async () => {
        const previous = await this.#credential(client, request.previousCredentialId, true);
        if (previous.status !== "active") repositoryFailure("credential_not_active");
        if (previous.expiresAt <= request.nowSeconds) repositoryFailure("credential_expired");
        if (await this.#deliveryAcknowledgedAt(client, previous.credentialId) === null) {
          repositoryFailure("credential_delivery_pending");
        }
        const tenant = await this.#tenant(client, previous.tenantId, true);
        if (tenant.status !== "active") {
          repositoryFailure("tenant_not_active");
        }
        const gatewayClient = await this.#client(
          client,
          previous.tenantId,
          previous.clientId,
          true,
        );
        if (gatewayClient.status !== "active") {
          repositoryFailure("client_not_active");
        }
        if (
          request.credential.tenantId !== previous.tenantId ||
          request.credential.clientId !== previous.clientId ||
          request.credential.rotatedFromId !== previous.credentialId
        ) {
          repositoryFailure("corrupt");
        }
        await client.query(`
          UPDATE ${qualified(this.#configuration.schema, "credentials")}
          SET status = 'revoked', revoked_at = $1 WHERE credential_id = $2
        `, [request.revokedAt, previous.credentialId]);
        await insertCredential(client, this.#configuration.schema, request.credential);
        await insertEvent(client, this.#configuration.schema, request.event);
        return Object.freeze({
          resultId: request.credential.credentialId,
          value: request.credential,
          operation: request.event,
          snapshot: resultSnapshotContext(tenant.status, gatewayClient.status, null),
        });
      },
    ));
  }

  revokeCredential(request: {
    readonly credentialId: string;
    readonly revokedAt: string;
    readonly nowSeconds: number;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantStoredCredentialRecord>> {
    return this.#transaction((client) => this.#idempotent(
      client,
      "credential.revoke",
      request.idempotencyKey,
      request.requestHash,
      request.revokedAt,
      async () => {
        const credential = await this.#credential(client, request.credentialId, true);
        if (credential.status !== "active") repositoryFailure("credential_not_active");
        if (credential.expiresAt <= request.nowSeconds) repositoryFailure("credential_expired");
        const tenant = await this.#tenant(client, credential.tenantId, true);
        const gatewayClient = await this.#client(
          client,
          credential.tenantId,
          credential.clientId,
          true,
        );
        const acknowledgedAt = await this.#deliveryAcknowledgedAt(
          client,
          credential.credentialId,
        );
        await client.query(`
          UPDATE ${qualified(this.#configuration.schema, "credentials")}
          SET status = 'revoked', revoked_at = $1 WHERE credential_id = $2
        `, [request.revokedAt, credential.credentialId]);
        await insertEvent(client, this.#configuration.schema, request.event);
        const value = await this.#credential(client, credential.credentialId);
        return Object.freeze({
          resultId: credential.credentialId,
          value,
          operation: request.event,
          snapshot: resultSnapshotContext(
            tenant.status,
            gatewayClient.status,
            acknowledgedAt,
          ),
        });
      },
    ));
  }

  acknowledgeCredentialDelivery(request: {
    readonly credentialId: string;
    readonly nowSeconds: number;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantStoredCredentialRecord>> {
    return this.#transaction((client) => this.#idempotent(
      client,
      "credential.delivery_acknowledge",
      request.idempotencyKey,
      request.requestHash,
      request.event.createdAt,
      async () => {
        const credential = await this.#credential(client, request.credentialId, true);
        if (credential.status !== "active") repositoryFailure("credential_not_active");
        if (credential.expiresAt <= request.nowSeconds) repositoryFailure("credential_expired");
        const tenant = await this.#tenant(client, credential.tenantId, true);
        if (tenant.status !== "active") {
          repositoryFailure("tenant_not_active");
        }
        const gatewayClient = await this.#client(
          client,
          credential.tenantId,
          credential.clientId,
          true,
        );
        if (gatewayClient.status !== "active") {
          repositoryFailure("client_not_active");
        }
        if (await this.#deliveryAcknowledgedAt(client, credential.credentialId) !== null) {
          repositoryFailure("credential_delivery_acknowledged");
        }
        await client.query(`
          UPDATE ${qualified(this.#configuration.schema, "credentials")}
          SET delivery_acknowledged_at = $1 WHERE credential_id = $2
        `, [request.event.createdAt, credential.credentialId]);
        await insertEvent(client, this.#configuration.schema, request.event);
        return Object.freeze({
          resultId: credential.credentialId,
          value: credential,
          operation: request.event,
          snapshot: resultSnapshotContext(
            tenant.status,
            gatewayClient.status,
            request.event.createdAt,
          ),
        });
      },
    ));
  }

  findCredentialForAuthentication(credentialId: string): Promise<{
    readonly tenant: TenantRecord;
    readonly client: ClientRecord;
    readonly credential: TenantStoredCredentialRecord;
    readonly deliveryAcknowledgedAt: string | null;
  } | null> {
    return this.#readSnapshot(async (client) => {
      const row = (await client.query<DatabaseRow>(`
        SELECT
          credential.*,
          tenant.display_name AS authority_tenant_display_name,
          tenant.status AS authority_tenant_status,
          tenant.created_at AS authority_tenant_created_at,
          tenant.updated_at AS authority_tenant_updated_at,
          gateway_client.label AS authority_client_label,
          gateway_client.status AS authority_client_status,
          gateway_client.created_at AS authority_client_created_at,
          gateway_client.updated_at AS authority_client_updated_at
        FROM ${qualified(this.#configuration.schema, "credentials")} AS credential
        JOIN ${qualified(this.#configuration.schema, "tenants")} AS tenant
          ON tenant.tenant_id = credential.tenant_id
        JOIN ${qualified(this.#configuration.schema, "clients")} AS gateway_client
          ON gateway_client.tenant_id = credential.tenant_id
         AND gateway_client.client_id = credential.client_id
        WHERE credential.credential_id = $1
      `, [credentialId])).rows[0];
      if (row === undefined) return null;
      const tenant = tenantFromRow({
        tenant_id: row.tenant_id,
        display_name: row.authority_tenant_display_name,
        status: row.authority_tenant_status,
        created_at: row.authority_tenant_created_at,
        updated_at: row.authority_tenant_updated_at,
      });
      const gatewayClient = clientFromRow({
        tenant_id: row.tenant_id,
        client_id: row.client_id,
        label: row.authority_client_label,
        status: row.authority_client_status,
        created_at: row.authority_client_created_at,
        updated_at: row.authority_client_updated_at,
      });
      return Object.freeze({
        tenant,
        client: gatewayClient,
        credential: credentialFromRow(row),
        deliveryAcknowledgedAt: nullableTimestamp(row, "delivery_acknowledged_at"),
      });
    });
  }

  async markCredentialUsed(
    credentialId: string,
    usedAt: string,
    nowSeconds: number,
  ): Promise<boolean> {
    const result = await this.#active().query(`
      UPDATE ${qualified(this.#configuration.schema, "credentials")} AS credential
      SET last_used_at = $1
      FROM ${qualified(this.#configuration.schema, "tenants")} AS tenant,
           ${qualified(this.#configuration.schema, "clients")} AS gateway_client
      WHERE credential.credential_id = $2
        AND credential.status = 'active'
        AND credential.expires_at > $3
        AND credential.delivery_acknowledged_at IS NOT NULL
        AND tenant.tenant_id = credential.tenant_id
        AND tenant.status = 'active'
        AND gateway_client.tenant_id = credential.tenant_id
        AND gateway_client.client_id = credential.client_id
        AND gateway_client.status = 'active'
    `, [usedAt, credentialId, nowSeconds]);
    return result.rowCount === 1;
  }

  append(event: AuditEvent): Promise<void> {
    return this.#active().query(`
      INSERT INTO ${qualified(this.#configuration.schema, "gateway_audit")} (
        audit_id, action, status, request_id, tenant_id, client_id, credential_id,
        tool_names, request_hash, jti, reason_code, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
    `, [
      event.auditId,
      event.action,
      event.status,
      event.requestId,
      event.tenantId,
      event.clientId,
      event.credentialId,
      JSON.stringify(event.toolNames),
      event.requestHash,
      event.jti,
      event.reasonCode,
      event.createdAt,
    ]).then(() => undefined);
  }

  async readByRequestIds(input: Readonly<{
    requestIds: readonly string[];
  }>): Promise<readonly GatewayAuditRequestEvidence[]> {
    const requestIds = input.requestIds;
    if (
      !Array.isArray(requestIds) ||
      requestIds.length < 1 ||
      requestIds.length > MAX_AUDIT_EVIDENCE_REQUEST_IDS ||
      new Set(requestIds).size !== requestIds.length ||
      requestIds.some((requestId) => (
        typeof requestId !== "string" || !AUDIT_REQUEST_ID_PATTERN.test(requestId)
      ))
    ) {
      throw new TypeError("Gateway audit evidence request is invalid.");
    }
    const requested = new Set(requestIds);
    return this.#readSnapshot(async (client) => {
      const rows = (await client.query<DatabaseRow>(`
        SELECT request_id, COUNT(*) AS event_count
        FROM ${qualified(this.#configuration.schema, "gateway_audit")}
        WHERE request_id = ANY($1::text[])
        GROUP BY request_id
        ORDER BY request_id ASC
      `, [requestIds])).rows;
      return Object.freeze(rows.map((row): GatewayAuditRequestEvidence => {
        const requestId = text(row, "request_id");
        const eventCount = integer(row, "event_count");
        if (!requested.has(requestId) || eventCount < 1) repositoryFailure("corrupt");
        return Object.freeze({ requestId, eventCount });
      }));
    });
  }

  reserve(input: Readonly<{
    tenantId: string;
    clientId: string;
    credentialId: string;
    clientIp: string;
    nowSeconds: number;
  }>): Promise<boolean> {
    if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 0) {
      return Promise.reject(new TypeError("Rate limit time is invalid."));
    }
    const bucketKeys = Object.freeze([
      ["tenant", input.tenantId],
      ["client", input.tenantId, input.clientId],
      ["credential", input.credentialId],
      ["ip", input.clientIp],
    ].map((parts) => createHash("sha256")
      .update(`access-gateway-rate/v2\u0000${parts.join("\u0000")}`, "utf8")
      .digest("hex"))
      .sort());
    const windowStart = Math.floor(input.nowSeconds / 60) * 60;
    return this.#transaction(async (client) => {
      for (const bucketKey of bucketKeys) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [JSON.stringify(["access-gateway-rate/v1", bucketKey])],
        );
      }
      await client.query(`
        DELETE FROM ${qualified(this.#configuration.schema, "gateway_rate_windows")}
        WHERE window_start < $1
      `, [windowStart - 3_600]);
      const rows = (await client.query<DatabaseRow>(`
        SELECT bucket_key, request_count
        FROM ${qualified(this.#configuration.schema, "gateway_rate_windows")}
        WHERE window_start = $1 AND bucket_key = ANY($2::text[])
        FOR UPDATE
      `, [windowStart, bucketKeys])).rows;
      if (rows.some((row) => integer(row, "request_count") >= this.#rateLimitPerMinute)) {
        return false;
      }
      await client.query(`
        INSERT INTO ${qualified(this.#configuration.schema, "gateway_rate_windows")} (
          bucket_key, window_start, request_count
        )
        SELECT bucket_key, $2, 1 FROM unnest($1::text[]) AS bucket_key
        ON CONFLICT (bucket_key, window_start) DO UPDATE
        SET request_count = ${qualified(this.#configuration.schema, "gateway_rate_windows")}.request_count + 1
      `, [bucketKeys, windowStart]);
      return true;
    });
  }

  async summarize(input: Readonly<{
    windowStartedAt: string;
    issueLimit: number;
  }>): Promise<GatewayActivitySummary> {
    if (
      !isCanonicalGatewayTimestamp(input.windowStartedAt) ||
      !Number.isSafeInteger(input.issueLimit) ||
      input.issueLimit < 1 ||
      input.issueLimit > 100
    ) {
      throw new TypeError("Gateway activity summary request is invalid.");
    }
    return this.#readSnapshot(async (client) => {
      const statusCounts = {
        success: 0,
        needs_input: 0,
        manual_review: 0,
        blocked: 0,
        unavailable: 0,
      };
      const countRows = await client.query<DatabaseRow>(`
        SELECT status, COUNT(*) AS count
        FROM ${qualified(this.#configuration.schema, "gateway_audit")}
        WHERE created_at >= $1
        GROUP BY status
      `, [input.windowStartedAt]);
      for (const row of countRows.rows) {
        const status = text(row, "status");
        if (!(status in statusCounts)) repositoryFailure("corrupt");
        statusCounts[status as keyof typeof statusCounts] = integer(row, "count");
      }
      const issueRows = await client.query<DatabaseRow>(`
        SELECT audit_id, action, status, reason_code, created_at
        FROM ${qualified(this.#configuration.schema, "gateway_audit")}
        WHERE created_at >= $1 AND status <> 'success'
        ORDER BY created_at DESC, audit_id DESC
        LIMIT $2
      `, [input.windowStartedAt, input.issueLimit]);
      const recentIssues: GatewayRecentIssue[] = issueRows.rows.map((row) => {
        const status = text(row, "status");
        if (
          status !== "needs_input" && status !== "manual_review" &&
          status !== "blocked" && status !== "unavailable"
        ) {
          repositoryFailure("corrupt");
        }
        return Object.freeze({
          auditRef: text(row, "audit_id"),
          action: text(row, "action"),
          status,
          reasonCode: nullableText(row, "reason_code"),
          createdAt: timestamp(row, "created_at"),
        });
      });
      return Object.freeze({
        windowStartedAt: input.windowStartedAt,
        totalAuditEvents: Object.values(statusCounts).reduce((total, count) => total + count, 0),
        statusCounts: Object.freeze(statusCounts),
        recentIssues: Object.freeze(recentIssues),
      });
    });
  }

  async isRevoked(input: Readonly<{
    tenantId: string;
    clientId: string;
    credentialId: string;
    jti: string | null;
  }>): Promise<boolean> {
    const record = await this.findCredentialForAuthentication(input.credentialId);
    return record === null ||
      record.tenant.tenantId !== input.tenantId ||
      record.client.clientId !== input.clientId ||
      record.tenant.status !== "active" ||
      record.client.status !== "active" ||
      record.credential.status !== "active";
  }

  async health(): Promise<{ readonly ready: boolean; readonly auditCount: number }> {
    try {
      await this.#verify();
      const count = (await this.#active().query<DatabaseRow>(`
        SELECT COUNT(*) AS count FROM ${qualified(this.#configuration.schema, "gateway_audit")}
      `)).rows[0];
      if (count === undefined) repositoryFailure("corrupt");
      const auditCount = integer(count, "count");
      if (auditCount < 0) repositoryFailure("corrupt");
      await this.#auditWriteProbe();
      return Object.freeze({ ready: true, auditCount });
    } catch {
      return Object.freeze({ ready: false, auditCount: 0 });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsPool) await this.#pool.end();
  }
}
