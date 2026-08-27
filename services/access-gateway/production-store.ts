import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  tenantApiKeyToolNamesForScopes,
} from "../../src/logistics_mcp/control-plane/tenant-access-contracts";
import type {
  SqliteTenantAccessStore,
} from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import type {
  StoredCredentialRecord as TenantStoredCredentialRecord,
  TenantAccessEventRecord,
  TenantAccessStateRecord,
  TenantRecord as TenantStoreRecord,
} from "../../src/logistics_mcp/control-plane/tenant-access-repository";
import { canonicalJsonHash } from "./canonical-json";
import type {
  AccessState,
  AuditEvent,
  ClientRecord,
  OperationAction,
  OperationRecord,
  PublicCredentialRecord,
  StoredCredentialRecord,
  TenantRecord,
} from "./contracts";
import type {
  CredentialExchangeRecord,
  CredentialRepository,
  GatewayAuditRepository,
  RateLimitRepository,
  RevocationRepository,
} from "./ports";

const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
const MARKER_MODE = 0o400;
const SCHEMA_VERSION = 1;
const MARKER_FORMAT = "access-gateway-operations/v1";

const SCHEMA_SQL = `
CREATE TABLE gateway_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  store_id TEXT NOT NULL,
  instance_id TEXT NOT NULL
) STRICT;

CREATE TABLE gateway_audit (
  audit_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tenant_id TEXT,
  client_id TEXT,
  credential_id TEXT,
  tool_names_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  jti TEXT,
  reason_code TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE gateway_rate_windows (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
) STRICT;

CREATE INDEX gateway_audit_created_idx
  ON gateway_audit(created_at DESC, audit_id DESC);
CREATE INDEX gateway_audit_credential_idx
  ON gateway_audit(credential_id, created_at DESC);
`;

type SqlRow = Record<string, SQLInputValue>;

export interface GatewayOperationalPaths {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly markerPath: string;
}

interface GatewayOperationalMarker {
  readonly marker_format: typeof MARKER_FORMAT;
  readonly schema_version: typeof SCHEMA_VERSION;
  readonly store_id: string;
  readonly application_root: string;
  readonly database_path: string;
  readonly instance_id: string;
}

export function gatewayOperationalPaths(applicationRoot: string): GatewayOperationalPaths {
  const stateDir = join(resolve(applicationRoot), ".runtime", "access-gateway-operations");
  return Object.freeze({
    stateDir,
    databasePath: join(stateDir, "operations.sqlite"),
    markerPath: join(stateDir, "operations-identity.json"),
  });
}

function identifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value);
}

function normalizedRoot(applicationRoot: string): string {
  if (!isAbsolute(applicationRoot)) throw new TypeError("Application root must be absolute.");
  const root = realpathSync(resolve(applicationRoot));
  const entry = lstatSync(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("Application root must be a real directory.");
  }
  return root;
}

function assertSecureEntry(path: string, kind: "directory" | "file", mode: number): void {
  const entry = lstatSync(path);
  const expectedKind = kind === "directory" ? entry.isDirectory() : entry.isFile();
  if (!expectedKind || entry.isSymbolicLink() || (entry.mode & 0o777) !== mode) {
    throw new TypeError(`Gateway state ${kind} identity or permission is invalid.`);
  }
}

function markerFor(
  root: string,
  paths: GatewayOperationalPaths,
  instanceId: string,
): GatewayOperationalMarker {
  return Object.freeze({
    marker_format: MARKER_FORMAT,
    schema_version: SCHEMA_VERSION,
    store_id: `gateway_${randomBytes(16).toString("hex")}`,
    application_root: root,
    database_path: paths.databasePath,
    instance_id: instanceId,
  });
}

function readMarker(path: string): GatewayOperationalMarker {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Gateway state marker is invalid.");
  }
  const marker = value as Record<string, unknown>;
  if (
    marker.marker_format !== MARKER_FORMAT ||
    marker.schema_version !== SCHEMA_VERSION ||
    typeof marker.store_id !== "string" ||
    typeof marker.application_root !== "string" ||
    typeof marker.database_path !== "string" ||
    typeof marker.instance_id !== "string"
  ) {
    throw new TypeError("Gateway state marker is invalid.");
  }
  return marker as unknown as GatewayOperationalMarker;
}

export function initializeSqliteGatewayOperationalState(input: Readonly<{
  applicationRoot: string;
  instanceId: string;
}>): Promise<void> {
  if (!identifier(input.instanceId)) throw new TypeError("Gateway instance ID is invalid.");
  const root = normalizedRoot(input.applicationRoot);
  const paths = gatewayOperationalPaths(root);
  mkdirSync(paths.stateDir, { mode: DIRECTORY_MODE });
  chmodSync(paths.stateDir, DIRECTORY_MODE);
  const marker = markerFor(root, paths, input.instanceId);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(paths.databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec(SCHEMA_SQL);
    database.prepare(`
      INSERT INTO gateway_meta (singleton, schema_version, store_id, instance_id)
      VALUES (1, ?, ?, ?)
    `).run(SCHEMA_VERSION, marker.store_id, marker.instance_id);
    const quickCheck = database.prepare("PRAGMA quick_check").get() as SqlRow | undefined;
    if (quickCheck === undefined || Object.values(quickCheck)[0] !== "ok") {
      throw new Error("Gateway database quick check failed.");
    }
    database.close();
    database = undefined;
    chmodSync(paths.databasePath, DATABASE_MODE);
    writeFileSync(paths.markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: MARKER_MODE,
    });
    chmodSync(paths.markerPath, MARKER_MODE);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the initialization error.
    }
    throw error;
  }
  return Promise.resolve();
}

export interface SqliteGatewayOperationalStoreOptions {
  readonly applicationRoot: string;
  readonly instanceId: string;
  readonly rateLimitPerMinute?: number;
}

export class SqliteGatewayOperationalStore implements GatewayAuditRepository, RateLimitRepository {
  readonly kind = "production" as const;
  readonly #database: DatabaseSync;
  readonly #rateLimitPerMinute: number;
  #closed = false;

  constructor(options: SqliteGatewayOperationalStoreOptions) {
    if (!identifier(options.instanceId)) throw new TypeError("Gateway instance ID is invalid.");
    const root = normalizedRoot(options.applicationRoot);
    const paths = gatewayOperationalPaths(root);
    assertSecureEntry(paths.stateDir, "directory", DIRECTORY_MODE);
    assertSecureEntry(paths.databasePath, "file", DATABASE_MODE);
    assertSecureEntry(paths.markerPath, "file", MARKER_MODE);
    const marker = readMarker(paths.markerPath);
    if (
      marker.application_root !== root ||
      marker.database_path !== paths.databasePath ||
      marker.instance_id !== options.instanceId
    ) {
      throw new TypeError("Gateway operational state identity mismatch.");
    }
    const limit = options.rateLimitPerMinute ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("Gateway rate limit must be an integer from 1 through 10000.");
    }
    this.#rateLimitPerMinute = limit;
    this.#database = new DatabaseSync(paths.databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec("PRAGMA trusted_schema = OFF");
    this.#verify(marker);
  }

  #active(): DatabaseSync {
    if (this.#closed) throw new Error("Gateway operational store is closed.");
    return this.#database;
  }

  #verify(marker: GatewayOperationalMarker): void {
    const row = this.#database.prepare(`
      SELECT schema_version, store_id, instance_id FROM gateway_meta WHERE singleton = 1
    `).get() as SqlRow | undefined;
    if (
      row === undefined ||
      row.schema_version !== SCHEMA_VERSION ||
      row.store_id !== marker.store_id ||
      row.instance_id !== marker.instance_id
    ) {
      throw new TypeError("Gateway operational database identity mismatch.");
    }
  }

  append(event: AuditEvent): Promise<void> {
    const database = this.#active();
    database.prepare(`
      INSERT INTO gateway_audit (
        audit_id, action, status, request_id, tenant_id, client_id,
        credential_id, tool_names_json, request_hash, jti, reason_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    );
    return Promise.resolve();
  }

  reserve(input: Readonly<{
    tenantId: string;
    clientId: string;
    credentialId: string;
    clientIp: string;
    nowSeconds: number;
  }>): Promise<boolean> {
    const database = this.#active();
    if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 0) {
      return Promise.reject(new TypeError("Rate limit time is invalid."));
    }
    const bucketKey = createHash("sha256")
      .update(
        `access-gateway-rate/v1\u0000${input.tenantId}\u0000${input.clientId}` +
        `\u0000${input.credentialId}\u0000${input.clientIp}`,
        "utf8",
      )
      .digest("hex");
    const windowStart = Math.floor(input.nowSeconds / 60) * 60;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("DELETE FROM gateway_rate_windows WHERE window_start < ?")
        .run(windowStart - 3_600);
      const row = database.prepare(`
        SELECT window_start, request_count FROM gateway_rate_windows WHERE bucket_key = ?
      `).get(bucketKey) as SqlRow | undefined;
      const currentCount = row?.window_start === windowStart &&
        typeof row.request_count === "number" ? row.request_count : 0;
      if (currentCount >= this.#rateLimitPerMinute) {
        database.exec("COMMIT");
        return Promise.resolve(false);
      }
      database.prepare(`
        INSERT INTO gateway_rate_windows (bucket_key, window_start, request_count)
        VALUES (?, ?, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET
          window_start = excluded.window_start,
          request_count = excluded.request_count
      `).run(bucketKey, windowStart, currentCount + 1);
      database.exec("COMMIT");
      return Promise.resolve(true);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      return Promise.reject(error instanceof Error ? error : new Error("Rate limit write failed."));
    }
  }

  health(): Promise<{ readonly ready: boolean; readonly auditCount: number }> {
    const database = this.#active();
    const quickCheck = database.prepare("PRAGMA quick_check").get() as SqlRow | undefined;
    const count = database.prepare("SELECT COUNT(*) AS count FROM gateway_audit").get() as
      | SqlRow
      | undefined;
    return Promise.resolve(Object.freeze({
      ready: quickCheck !== undefined && Object.values(quickCheck)[0] === "ok",
      auditCount: typeof count?.count === "number" ? count.count : 0,
    }));
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#database.close();
    return Promise.resolve();
  }
}

function gatewayTenant(value: TenantStoreRecord): TenantRecord {
  return Object.freeze({
    tenantId: value.tenantId,
    displayName: value.displayName,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: 1,
  });
}

function gatewayClient(value: TenantStoredCredentialRecord): ClientRecord {
  return Object.freeze({
    clientId: value.clientId,
    tenantId: value.tenantId,
    label: value.label,
    status: "active",
    createdAt: value.createdAt,
    updatedAt: value.lastUsedAt ?? value.createdAt,
    version: 1,
  });
}

function gatewayCredential(
  value: TenantStoredCredentialRecord,
  acknowledgedAt: string | null,
  pepperVersion: string,
): StoredCredentialRecord {
  const toolNames = tenantApiKeyToolNamesForScopes(value.scopes);
  return Object.freeze({
    credentialId: value.credentialId,
    tenantId: value.tenantId,
    clientId: value.clientId,
    label: value.label,
    actorRole: value.actorRole,
    roles: value.roles,
    toolNames,
    scopes: value.scopes,
    status: value.status,
    deliveryStatus: acknowledgedAt === null ? "pending" : "acknowledged",
    deliveryAcknowledgedAt: acknowledgedAt,
    keyPrefix: value.keyPrefix,
    secretLastFour: value.secretLastFour,
    secretSalt: value.secretSalt,
    secretHash: value.secretHash,
    pepperVersion,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    lastUsedAt: value.lastUsedAt,
    revokedAt: value.revokedAt,
    rotatedFromId: value.rotatedFromId,
    version: 1,
  });
}

function publicCredential(
  value: StoredCredentialRecord,
  tenantStatus: TenantStoreRecord["status"],
  nowSeconds: number,
): PublicCredentialRecord {
  const effectiveStatus = value.status === "revoked"
    ? "revoked"
    : value.expiresAt <= nowSeconds
      ? "expired"
      : value.deliveryStatus === "pending"
        ? "pending_delivery"
        : tenantStatus === "suspended"
          ? "tenant_suspended"
          : "active";
  return Object.freeze({
    credentialId: value.credentialId,
    tenantId: value.tenantId,
    clientId: value.clientId,
    label: value.label,
    actorRole: value.actorRole,
    roles: value.roles,
    toolNames: value.toolNames,
    scopes: value.scopes,
    status: value.status,
    deliveryStatus: value.deliveryStatus,
    deliveryAcknowledgedAt: value.deliveryAcknowledgedAt,
    effectiveStatus,
    keyPrefix: value.keyPrefix,
    secretLastFour: value.secretLastFour,
    pepperVersion: value.pepperVersion,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    lastUsedAt: value.lastUsedAt,
    revokedAt: value.revokedAt,
    rotatedFromId: value.rotatedFromId,
    version: value.version,
  });
}

function operationTransition(event: TenantAccessEventRecord): readonly [
  OperationAction,
  string,
  string,
] {
  switch (event.action) {
    case "tenant.created": return ["tenant.create", "absent", "active"];
    case "tenant.active": return ["tenant.activate", "suspended", "active"];
    case "tenant.suspended": return ["tenant.suspend", "active", "suspended"];
    case "credential.issued": return ["credential.issue", "absent", "pending_delivery"];
    case "credential.delivery_acknowledged":
      return ["credential.delivery_acknowledge", "pending_delivery", "active"];
    case "credential.rotated": return ["credential.rotate", "active", "pending_delivery"];
    case "credential.revoked": return ["credential.revoke", "active", "revoked"];
    default: throw new TypeError("Tenant access operation is unsupported.");
  }
}

function gatewayOperation(event: TenantAccessEventRecord): OperationRecord {
  const [action, fromStatus, toStatus] = operationTransition(event);
  return Object.freeze({
    operationId: event.eventId,
    tenantId: event.tenantId,
    clientId: null,
    credentialId: event.credentialId,
    actorRef: event.actorRef,
    action,
    fromStatus,
    toStatus,
    status: "success",
    reasonCode: event.reasonCode,
    requestHash: canonicalJsonHash("access-gateway/operation/v1", {
      event_id: event.eventId,
      action: event.action,
      tenant_id: event.tenantId,
      credential_id: event.credentialId,
      created_at: event.createdAt,
    }),
    createdAt: event.createdAt,
  });
}

export interface TenantAccessGatewayRepositoryOptions {
  readonly store: SqliteTenantAccessStore;
  readonly pepperVersion: string;
  readonly nowSeconds?: () => number;
}

export class TenantAccessGatewayRepository implements CredentialRepository, RevocationRepository {
  readonly kind = "production" as const;
  readonly #store: SqliteTenantAccessStore;
  readonly #pepperVersion: string;
  readonly #nowSeconds: () => number;

  constructor(options: TenantAccessGatewayRepositoryOptions) {
    if (!identifier(options.pepperVersion)) {
      throw new TypeError("Gateway pepper version is invalid.");
    }
    this.#store = options.store;
    this.#pepperVersion = options.pepperVersion;
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  }

  async findForExchange(credentialId: string): Promise<CredentialExchangeRecord | null> {
    const found = await this.#store.findCredentialForAuthentication(credentialId);
    if (found === null) return null;
    return Object.freeze({
      tenant: gatewayTenant(found.tenant),
      client: gatewayClient(found.credential),
      credential: gatewayCredential(
        found.credential,
        found.deliveryAcknowledgedAt,
        this.#pepperVersion,
      ),
    });
  }

  async listState(): Promise<AccessState> {
    const state: TenantAccessStateRecord = await this.#store.getState();
    const tenants = state.tenants.map(gatewayTenant);
    const tenantStatus = new Map(state.tenants.map((tenant) => [tenant.tenantId, tenant.status]));
    const clients = new Map<string, ClientRecord>();
    const credentials = state.credentials.map((credential) => {
      const client = gatewayClient(credential);
      clients.set(`${client.tenantId}\u0000${client.clientId}`, client);
      const status = tenantStatus.get(credential.tenantId);
      if (status === undefined) throw new TypeError("Credential tenant is unavailable.");
      const stored = gatewayCredential(
        credential,
        state.deliveryAcknowledgements[credential.credentialId] ?? null,
        this.#pepperVersion,
      );
      return publicCredential(stored, status, this.#nowSeconds());
    });
    return Object.freeze({
      tenants: Object.freeze(tenants),
      clients: Object.freeze([...clients.values()]),
      credentials: Object.freeze(credentials),
      operations: Object.freeze(state.events.map(gatewayOperation)),
    });
  }

  markUsed(credentialId: string, usedAt: string, nowSeconds: number): Promise<boolean> {
    return this.#store.markCredentialUsed(credentialId, usedAt, nowSeconds);
  }

  async isRevoked(input: Readonly<{
    tenantId: string;
    clientId: string;
    credentialId: string;
    jti: string | null;
  }>): Promise<boolean> {
    const record = await this.findForExchange(input.credentialId);
    return record === null ||
      record.tenant.tenantId !== input.tenantId ||
      record.client.clientId !== input.clientId ||
      record.tenant.status !== "active" ||
      record.client.status !== "active" ||
      record.credential.status !== "active";
  }
}
