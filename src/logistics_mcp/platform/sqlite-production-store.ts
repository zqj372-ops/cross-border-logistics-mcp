import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
} from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { redactAuditInput } from "./audit";
import type {
  DependencyHealth,
  DurableAuditRepository,
  DurableIdempotencyRepository,
  DurableSessionBindingStore,
  SessionBinding,
} from "./dependencies";
import {
  IdempotencyConflictError,
  IdempotencyStateError,
} from "./idempotency";
import type {
  AuditEvent,
  IdempotencyCommitRequest,
  IdempotencyRecord,
  IdempotencyReleaseRequest,
  IdempotencyReserveRequest,
  IdempotencyReserveResult,
} from "./repositories";

const SCHEMA_VERSION = 1;
const DEFAULT_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

type StoreErrorCode =
  | "database_closed"
  | "database_corrupt"
  | "database_not_writable"
  | "database_path_invalid"
  | "database_schema_unsupported"
  | "input_invalid";

export class SqliteProductionStoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteProductionStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Value is not JSON serializable.");
    return serialized;
  } catch (error) {
    throw new SqliteProductionStoreError(
      "input_invalid",
      "The value cannot be stored as JSON.",
      { cause: error },
    );
  }
}

function parseJson(value: SQLOutputValue): unknown {
  if (typeof value !== "string") {
    throw new SqliteProductionStoreError(
      "database_corrupt",
      "The production store contains invalid JSON data.",
    );
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new SqliteProductionStoreError(
      "database_corrupt",
      "The production store contains invalid JSON data.",
      { cause: error },
    );
  }
}

function requiredString(
  row: Record<string, SQLOutputValue>,
  key: string,
): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new SqliteProductionStoreError(
      "database_corrupt",
      "The production store contains an invalid text field.",
    );
  }
  return value;
}

function nullableString(
  row: Record<string, SQLOutputValue>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null) return null;
  return requiredString(row, key);
}

function requiredInteger(
  row: Record<string, SQLOutputValue>,
  key: string,
): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SqliteProductionStoreError(
      "database_corrupt",
      "The production store contains an invalid integer field.",
    );
  }
  return value;
}

function assertIdempotencyRequest(
  request:
    | IdempotencyReserveRequest
    | IdempotencyCommitRequest
    | IdempotencyReleaseRequest,
): void {
  if (
    request.tenantId.length === 0 ||
    request.tool.length === 0 ||
    request.requestHash.length === 0 ||
    request.key.length < 16 ||
    request.key.length > 200
  ) {
    throw new IdempotencyStateError();
  }
  if (
    "expectedExpiresAt" in request &&
    !Number.isSafeInteger(request.expectedExpiresAt)
  ) {
    throw new IdempotencyStateError();
  }
}

function assertSessionBinding(binding: SessionBinding): void {
  const textFields = [
    binding.sessionId,
    binding.tenantId,
    binding.actorId,
    binding.clientId,
    binding.authSessionId,
    binding.contextFingerprint,
    binding.ownerId,
  ];
  if (
    textFields.some((value) => value.length === 0) ||
    !Number.isSafeInteger(binding.createdAtMs) ||
    !Number.isSafeInteger(binding.expiresAtMs) ||
    binding.expiresAtMs <= binding.createdAtMs
  ) {
    throw new SqliteProductionStoreError(
      "database_corrupt",
      "The session binding is invalid.",
    );
  }
}

function secureDatabaseFile(path: string): void {
  if (path.length === 0 || path === ":memory:") {
    throw new SqliteProductionStoreError(
      "database_path_invalid",
      "A file-backed production database path is required.",
    );
  }

  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new SqliteProductionStoreError(
        "database_path_invalid",
        "The production database path must be a regular file.",
      );
    }
    if ((stats.mode & 0o200) === 0) {
      throw new SqliteProductionStoreError(
        "database_not_writable",
        "The production database file is not writable.",
      );
    }
    chmodSync(path, 0o600);
    return;
  }

  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600,
  );
  closeSync(descriptor);
}

function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  return row === undefined ? -1 : requiredInteger(row, "user_version");
}

function quickCheck(database: DatabaseSync): boolean {
  const row = database.prepare("PRAGMA quick_check(1)").get();
  return row !== undefined && requiredString(row, "quick_check") === "ok";
}

function verifySchema(database: DatabaseSync): void {
  const specifications = [
    {
      name: "audit_events",
      withoutRowid: 0,
      columns: [
        ["sequence", "INTEGER", 0, 1],
        ["audit_id", "TEXT", 1, 0],
        ["event_json", "TEXT", 1, 0],
      ],
      sql: ["audit_id text not null unique", "check (json_valid(event_json))"],
    },
    {
      name: "idempotency_records",
      withoutRowid: 1,
      columns: [
        ["tenant_id", "TEXT", 1, 1], ["tool", "TEXT", 1, 2],
        ["idempotency_key", "TEXT", 1, 3], ["request_hash", "TEXT", 1, 0],
        ["preview_ref", "TEXT", 0, 0], ["status", "TEXT", 1, 0],
        ["record_id", "TEXT", 0, 0], ["result_json", "TEXT", 1, 0],
        ["expires_at", "INTEGER", 1, 0],
      ],
      sql: ["status in ('reserved', 'committed')", "check (json_valid(result_json))"],
    },
    {
      name: "session_bindings",
      withoutRowid: 1,
      columns: [
        ["session_id", "TEXT", 1, 1], ["tenant_id", "TEXT", 1, 0],
        ["actor_id", "TEXT", 1, 0], ["client_id", "TEXT", 1, 0],
        ["auth_session_id", "TEXT", 1, 0], ["context_fingerprint", "TEXT", 1, 0],
        ["owner_id", "TEXT", 1, 0], ["created_at_ms", "INTEGER", 1, 0],
        ["expires_at_ms", "INTEGER", 1, 0],
      ],
      sql: ["check (expires_at_ms > created_at_ms)"],
    },
  ] as const;
  try {
    for (const specification of specifications) {
      const table = database.prepare(`PRAGMA table_list('${specification.name}')`).get();
      if (
        table === undefined || requiredInteger(table, "strict") !== 1 ||
        requiredInteger(table, "wr") !== specification.withoutRowid
      ) throw new Error("invalid table options");
      const columns = database.prepare(`PRAGMA table_info('${specification.name}')`).all();
      if (
        columns.length !== specification.columns.length ||
        specification.columns.some(([name, type, notnull, primaryKey], index) => {
          const column = columns[index];
          return column === undefined || requiredString(column, "name") !== name ||
            requiredString(column, "type") !== type ||
            requiredInteger(column, "notnull") !== notnull ||
            requiredInteger(column, "pk") !== primaryKey;
        })
      ) throw new Error("invalid table columns");
      const schema = database
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(specification.name);
      const sql = schema === undefined
        ? ""
        : requiredString(schema, "sql").toLowerCase().replace(/\s+/g, " ");
      if (specification.sql.some((fragment) => !sql.includes(fragment))) {
        throw new Error("invalid table constraints");
      }
    }
    for (const [name, table, column] of [
      ["idempotency_expiry_idx", "idempotency_records", "expires_at"],
      ["session_binding_expiry_idx", "session_bindings", "expires_at_ms"],
    ] as const) {
      const index = database
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ? AND tbl_name = ?")
        .get(name, table);
      const sql = index === undefined
        ? ""
        : requiredString(index, "sql").toLowerCase().replace(/\s+/g, " ");
      if (!sql.includes(`on ${table} (${column})`)) throw new Error("invalid index");
    }
  } catch (error) {
    throw new SqliteProductionStoreError(
      "database_schema_unsupported",
      "The production database has an unsupported schema layout.",
      { cause: error },
    );
  }
}

function idempotencyRecord(
  row: Record<string, SQLOutputValue>,
): IdempotencyRecord {
  const status = requiredString(row, "status");
  if (status !== "reserved" && status !== "committed") {
    throw new SqliteProductionStoreError(
      "database_corrupt",
      "The production store contains an invalid idempotency status.",
    );
  }
  return {
    tenantId: requiredString(row, "tenant_id"),
    tool: requiredString(row, "tool"),
    key: requiredString(row, "idempotency_key"),
    requestHash: requiredString(row, "request_hash"),
    previewRef: nullableString(row, "preview_ref"),
    status,
    recordId: nullableString(row, "record_id"),
    result: parseJson(row.result_json ?? null),
    expiresAt: requiredInteger(row, "expires_at"),
  };
}

function sessionBinding(row: Record<string, SQLOutputValue>): SessionBinding {
  return {
    sessionId: requiredString(row, "session_id"),
    tenantId: requiredString(row, "tenant_id"),
    actorId: requiredString(row, "actor_id"),
    clientId: requiredString(row, "client_id"),
    authSessionId: requiredString(row, "auth_session_id"),
    contextFingerprint: requiredString(row, "context_fingerprint"),
    ownerId: requiredString(row, "owner_id"),
    createdAtMs: requiredInteger(row, "created_at_ms"),
    expiresAtMs: requiredInteger(row, "expires_at_ms"),
  };
}

export class SqliteProductionStore
  implements
    DurableAuditRepository,
    DurableIdempotencyRepository,
    DurableSessionBindingStore
{
  readonly durability = "durable" as const;

  private database: DatabaseSync | null = null;

  constructor(
    databasePath: string,
    private readonly idempotencyTtlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(idempotencyTtlMs) || idempotencyTtlMs <= 0) {
      throw new IdempotencyStateError();
    }
    secureDatabaseFile(databasePath);

    try {
      this.database = new DatabaseSync(databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
      });
      this.initialize();
    } catch (error) {
      if (this.database !== null) {
        try {
          this.database.close();
        } catch {
          // The original initialization failure is the actionable error.
        }
        this.database = null;
      }
      if (error instanceof SqliteProductionStoreError) throw error;
      throw new SqliteProductionStoreError(
        "database_corrupt",
        "The production database could not be opened safely.",
        { cause: error },
      );
    }
  }

  private initialize(): void {
    const database = this.openDatabase();
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA synchronous = FULL;
    `);
    if (!quickCheck(database)) {
      throw new SqliteProductionStoreError(
        "database_corrupt",
        "The production database failed its integrity check.",
      );
    }

    const version = schemaVersion(database);
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw new SqliteProductionStoreError(
        "database_schema_unsupported",
        "The production database has an unsupported schema version.",
      );
    }
    if (version === SCHEMA_VERSION) {
      verifySchema(database);
    } else {
      const row = database
        .prepare(
          "SELECT count(*) AS table_count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .get();
      if (row === undefined || requiredInteger(row, "table_count") !== 0) {
        throw new SqliteProductionStoreError(
          "database_schema_unsupported",
          "The production database has an unsupported schema version.",
        );
      }
    }

    const journal = database.prepare("PRAGMA journal_mode = WAL").get();
    if (journal === undefined || requiredString(journal, "journal_mode") !== "wal") {
      throw new SqliteProductionStoreError(
        "database_not_writable",
        "The production database could not enable WAL mode.",
      );
    }

    if (version === 0) {
      this.transaction(() => {
        database.exec(`
          CREATE TABLE audit_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            audit_id TEXT NOT NULL UNIQUE,
            event_json TEXT NOT NULL CHECK (json_valid(event_json))
          ) STRICT;

          CREATE TABLE idempotency_records (
            tenant_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            preview_ref TEXT,
            status TEXT NOT NULL CHECK (status IN ('reserved', 'committed')),
            record_id TEXT,
            result_json TEXT NOT NULL CHECK (json_valid(result_json)),
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (tenant_id, tool, idempotency_key)
          ) STRICT, WITHOUT ROWID;
          CREATE INDEX idempotency_expiry_idx
            ON idempotency_records (expires_at);

          CREATE TABLE session_bindings (
            session_id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            client_id TEXT NOT NULL,
            auth_session_id TEXT NOT NULL,
            context_fingerprint TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL,
            CHECK (expires_at_ms > created_at_ms)
          ) STRICT, WITHOUT ROWID;
          CREATE INDEX session_binding_expiry_idx
            ON session_bindings (expires_at_ms);

          PRAGMA user_version = 1;
        `);
      });
      verifySchema(database);
    }
  }

  private openDatabase(): DatabaseSync {
    if (this.database === null) {
      throw new SqliteProductionStoreError(
        "database_closed",
        "The production database is closed.",
      );
    }
    return this.database;
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value)) throw new IdempotencyStateError();
    return value;
  }

  private transaction<T>(operation: () => T): T {
    const database = this.openDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        try {
          database.close();
        } finally {
          this.database = null;
        }
      }
      throw error;
    }
  }

  async append(event: AuditEvent): Promise<void> {
    await Promise.resolve();
    const redactedMetadata =
      event.metadata === undefined ? undefined : redactAuditInput(event.metadata);
    const metadata =
      redactedMetadata === undefined
        ? undefined
        : isRecord(redactedMetadata)
          ? redactedMetadata
          : { value: redactedMetadata };
    const stored: AuditEvent = {
      ...event,
      source_ids: [...event.source_ids],
      versions: [...event.versions],
      reason_codes: [...event.reason_codes],
      ...(metadata === undefined ? {} : { metadata }),
    };
    const serialized = serializeJson(stored);

    this.transaction(() => {
      this.openDatabase()
        .prepare("INSERT INTO audit_events (audit_id, event_json) VALUES (?, ?)")
        .run(event.audit_id, serialized);
    });
  }

  async list(): Promise<readonly AuditEvent[]> {
    await Promise.resolve();
    const rows = this.openDatabase()
      .prepare("SELECT event_json FROM audit_events ORDER BY sequence")
      .all();
    return rows.map((row) => {
      const event = parseJson(row.event_json ?? null);
      if (!isRecord(event)) {
        throw new SqliteProductionStoreError(
          "database_corrupt",
          "The production store contains an invalid audit event.",
        );
      }
      return structuredClone(event) as unknown as AuditEvent;
    });
  }

  async reserve(
    request: IdempotencyReserveRequest,
  ): Promise<IdempotencyReserveResult> {
    await Promise.resolve();
    assertIdempotencyRequest(request);
    const now = this.now();
    const expiresAt = now + this.idempotencyTtlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new IdempotencyStateError();

    return this.transaction(() => {
      const database = this.openDatabase();
      database
        .prepare(
          "DELETE FROM idempotency_records WHERE tenant_id = ? AND tool = ? AND idempotency_key = ? AND expires_at <= ?",
        )
        .run(request.tenantId, request.tool, request.key, now);
      const row = database
        .prepare(
          "SELECT tenant_id, tool, idempotency_key, request_hash, preview_ref, status, record_id, result_json, expires_at FROM idempotency_records WHERE tenant_id = ? AND tool = ? AND idempotency_key = ?",
        )
        .get(request.tenantId, request.tool, request.key);
      if (row !== undefined) {
        const existing = idempotencyRecord(row);
        if (existing.requestHash !== request.requestHash) {
          throw new IdempotencyConflictError();
        }
        return {
          replayed: existing.status === "committed",
          inProgress: existing.status === "reserved",
          record: existing,
        };
      }

      database
        .prepare(
          "INSERT INTO idempotency_records (tenant_id, tool, idempotency_key, request_hash, preview_ref, status, record_id, result_json, expires_at) VALUES (?, ?, ?, ?, ?, 'reserved', NULL, 'null', ?)",
        )
        .run(
          request.tenantId,
          request.tool,
          request.key,
          request.requestHash,
          request.previewRef ?? null,
          expiresAt,
        );
      return {
        replayed: false,
        inProgress: false,
        record: {
          tenantId: request.tenantId,
          tool: request.tool,
          key: request.key,
          requestHash: request.requestHash,
          previewRef: request.previewRef ?? null,
          status: "reserved",
          recordId: null,
          result: null,
          expiresAt,
        },
      };
    });
  }

  async commit(request: IdempotencyCommitRequest): Promise<IdempotencyRecord> {
    await Promise.resolve();
    assertIdempotencyRequest(request);
    const now = this.now();
    const serializedResult = serializeJson(request.result);

    return this.transaction(() => {
      const database = this.openDatabase();
      database
        .prepare(
          "DELETE FROM idempotency_records WHERE tenant_id = ? AND tool = ? AND idempotency_key = ? AND expires_at <= ?",
        )
        .run(request.tenantId, request.tool, request.key, now);
      const row = database
        .prepare(
          "SELECT tenant_id, tool, idempotency_key, request_hash, preview_ref, status, record_id, result_json, expires_at FROM idempotency_records WHERE tenant_id = ? AND tool = ? AND idempotency_key = ?",
        )
        .get(request.tenantId, request.tool, request.key);
      if (row === undefined) throw new IdempotencyStateError();

      const existing = idempotencyRecord(row);
      if (existing.requestHash !== request.requestHash) {
        throw new IdempotencyConflictError();
      }
      if (existing.status === "committed") return existing;

      database
        .prepare(
          "UPDATE idempotency_records SET status = 'committed', record_id = ?, result_json = ? WHERE tenant_id = ? AND tool = ? AND idempotency_key = ? AND status = 'reserved'",
        )
        .run(
          request.recordId ?? null,
          serializedResult,
          request.tenantId,
          request.tool,
          request.key,
        );
      return {
        ...existing,
        status: "committed",
        recordId: request.recordId ?? null,
        result: structuredClone(request.result),
      };
    });
  }

  async release(request: IdempotencyReleaseRequest): Promise<void> {
    await Promise.resolve();
    assertIdempotencyRequest(request);
    this.transaction(() => {
      this.openDatabase()
        .prepare(
          "DELETE FROM idempotency_records WHERE tenant_id = ? AND tool = ? AND idempotency_key = ? AND request_hash = ? AND status = 'reserved' AND expires_at = ?",
        )
        .run(
          request.tenantId,
          request.tool,
          request.key,
          request.requestHash,
          request.expectedExpiresAt,
        );
    });
  }

  get(sessionId: string): Promise<SessionBinding | null>;
  get(
    tenantId: string,
    tool: string,
    key: string,
  ): Promise<IdempotencyRecord | null>;
  async get(
    tenantOrSessionId: string,
    tool?: string,
    key?: string,
  ): Promise<IdempotencyRecord | SessionBinding | null> {
    await Promise.resolve();
    const now = this.now();
    if (tool === undefined && key === undefined) {
      if (tenantOrSessionId.length === 0) {
        throw new SqliteProductionStoreError(
          "input_invalid",
          "A session ID is required.",
        );
      }
      return this.transaction(() => {
        const database = this.openDatabase();
        database
          .prepare(
            "DELETE FROM session_bindings WHERE session_id = ? AND expires_at_ms <= ?",
          )
          .run(tenantOrSessionId, now);
        const row = database
          .prepare(
            "SELECT session_id, tenant_id, actor_id, client_id, auth_session_id, context_fingerprint, owner_id, created_at_ms, expires_at_ms FROM session_bindings WHERE session_id = ?",
          )
          .get(tenantOrSessionId);
        return row === undefined ? null : sessionBinding(row);
      });
    }
    if (tool === undefined || key === undefined) {
      throw new IdempotencyStateError();
    }
    return this.transaction(() => {
      const database = this.openDatabase();
      database
        .prepare(
          "DELETE FROM idempotency_records WHERE tenant_id = ? AND tool = ? AND idempotency_key = ? AND expires_at <= ?",
        )
        .run(tenantOrSessionId, tool, key, now);
      const row = database
        .prepare(
          "SELECT tenant_id, tool, idempotency_key, request_hash, preview_ref, status, record_id, result_json, expires_at FROM idempotency_records WHERE tenant_id = ? AND tool = ? AND idempotency_key = ?",
        )
        .get(tenantOrSessionId, tool, key);
      return row === undefined ? null : idempotencyRecord(row);
    });
  }

  async put(binding: SessionBinding): Promise<void> {
    await Promise.resolve();
    assertSessionBinding(binding);
    this.transaction(() => {
      this.openDatabase()
        .prepare(
          `INSERT INTO session_bindings (
            session_id, tenant_id, actor_id, client_id, auth_session_id,
            context_fingerprint, owner_id, created_at_ms, expires_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (session_id) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            actor_id = excluded.actor_id,
            client_id = excluded.client_id,
            auth_session_id = excluded.auth_session_id,
            context_fingerprint = excluded.context_fingerprint,
            owner_id = excluded.owner_id,
            created_at_ms = excluded.created_at_ms,
            expires_at_ms = excluded.expires_at_ms`,
        )
        .run(
          binding.sessionId,
          binding.tenantId,
          binding.actorId,
          binding.clientId,
          binding.authSessionId,
          binding.contextFingerprint,
          binding.ownerId,
          binding.createdAtMs,
          binding.expiresAtMs,
        );
    });
  }

  async delete(sessionId: string): Promise<void> {
    await Promise.resolve();
    this.transaction(() => {
      this.openDatabase()
        .prepare("DELETE FROM session_bindings WHERE session_id = ?")
        .run(sessionId);
    });
  }

  async health(): Promise<DependencyHealth> {
    await Promise.resolve();
    if (this.database === null) return { ready: false };
    try {
      const ready = schemaVersion(this.database) === SCHEMA_VERSION;
      if (!ready) return { ready: false };
      verifySchema(this.database);
      this.database.exec("BEGIN IMMEDIATE; ROLLBACK");
      return { ready: true };
    } catch {
      return { ready: false };
    }
  }

  async close(): Promise<void> {
    await Promise.resolve();
    const database = this.database;
    if (database === null) return;
    this.database = null;
    database.close();
  }
}
