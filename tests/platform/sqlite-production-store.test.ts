import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { IdempotencyConflictError } from "../../src/logistics_mcp/platform/idempotency";
import { createProductionPlatformAssembly } from "../../src/logistics_mcp/platform/dependencies";
import { SqliteProductionStore } from "../../src/logistics_mcp/platform/sqlite-production-store";

const temporaryDirectories: string[] = [];
const openStores: SqliteProductionStore[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "logistics-mcp-sqlite-"));
  temporaryDirectories.push(directory);
  return join(directory, "platform.sqlite");
}

function track(store: SqliteProductionStore): SqliteProductionStore {
  openStores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite production store", () => {
  it("creates a secure WAL database and persists only redacted audit events", async () => {
    const path = databasePath();
    const store = track(new SqliteProductionStore(path));

    await store.append({
      audit_id: "audit_sqlite_001",
      tenant_id: "tenant_demo",
      actor_id: "actor_sales",
      client_id: "client_demo",
      request_id: "request_demo_001",
      tool: "quote.save_draft",
      schema_version: "2026-08-11.v1",
      status: "blocked",
      source_ids: [],
      versions: [],
      reason_codes: ["security.denied"],
      duration_ms: 4,
      idempotency_outcome: "not_applicable",
      readback_status: "not_applicable",
      metadata: {
        full_address: "secret customer address",
        amount: "999.00",
      },
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(store.health()).resolves.toEqual({ ready: true });
    await store.close();
    expect(readFileSync(path).includes(Buffer.from("secret"))).toBe(false);

    const database = new DatabaseSync(path);
    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(database.prepare("PRAGMA synchronous").get()).toEqual({
      synchronous: 2,
    });
    database.close();

    const reopened = track(new SqliteProductionStore(path));
    const events = await reopened.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({
      full_address: "[opaque]",
      amount: "[redacted]",
    });
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("replays, conflicts, and expires idempotency records across reopen", async () => {
    const path = databasePath();
    let now = 1_000;
    const first = track(new SqliteProductionStore(path, 100, () => now));
    const request = {
      tenantId: "tenant_demo",
      tool: "quote.save_draft",
      key: "idem_sqlite_12345678",
      requestHash: "hash_a",
    };

    await expect(first.reserve(request)).resolves.toMatchObject({
      replayed: false,
      inProgress: false,
    });
    await first.commit({
      ...request,
      result: { recordId: "draft_1" },
      recordId: "draft_1",
    });
    await first.close();

    const reopened = track(new SqliteProductionStore(path, 100, () => now));
    await expect(reopened.reserve(request)).resolves.toMatchObject({
      replayed: true,
      inProgress: false,
      record: { result: { recordId: "draft_1" } },
    });
    await expect(
      reopened.reserve({ ...request, requestHash: "hash_b" }),
    ).rejects.toThrow(IdempotencyConflictError);

    now = 1_101;
    await expect(
      reopened.reserve({ ...request, requestHash: "hash_b" }),
    ).resolves.toMatchObject({ replayed: false, inProgress: false });
  });

  it("serializes competing reservations with one composite unique key", async () => {
    const path = databasePath();
    const first = track(new SqliteProductionStore(path));
    const second = track(new SqliteProductionStore(path));
    const request = {
      tenantId: "tenant_demo",
      tool: "quote.save_draft",
      key: "idem_sqlite_concurrent_001",
      requestHash: "hash_a",
    };

    const reservations = await Promise.all([
      first.reserve(request),
      second.reserve(request),
    ]);

    expect(reservations.filter((result) => result.inProgress)).toHaveLength(1);
    expect(reservations.filter((result) => !result.inProgress)).toHaveLength(1);
  });

  it("persists session bindings and supports get, replace, delete, and expiry", async () => {
    const path = databasePath();
    let now = 1_000;
    const first = track(new SqliteProductionStore(path, 100, () => now));
    const binding = {
      sessionId: "session_001",
      tenantId: "tenant_demo",
      actorId: "actor_sales",
      clientId: "client_demo",
      authSessionId: "auth_001",
      contextFingerprint: "sha256:fingerprint",
      ownerId: "worker_001",
      createdAtMs: 900,
      expiresAtMs: 2_000,
    };

    await first.put(binding);
    await first.close();

    const reopened = track(new SqliteProductionStore(path, 100, () => now));
    await expect(reopened.get(binding.sessionId)).resolves.toEqual(binding);
    const replaced = { ...binding, ownerId: "worker_002" };
    await reopened.put(replaced);
    await expect(reopened.get(binding.sessionId)).resolves.toEqual(replaced);
    await reopened.delete(binding.sessionId);
    await expect(reopened.get(binding.sessionId)).resolves.toBeNull();

    await reopened.put(binding);
    now = binding.expiresAtMs;
    await expect(reopened.get(binding.sessionId)).resolves.toBeNull();
  });

  it("is safely closable more than once and becomes unhealthy when closed", async () => {
    const store = track(new SqliteProductionStore(databasePath()));

    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.health()).resolves.toEqual({ ready: false });
    await expect(store.list()).rejects.toThrow(/closed/i);
  });

  it("becomes unhealthy when a required index is removed after startup", async () => {
    const path = databasePath();
    const store = track(new SqliteProductionStore(path));
    const database = new DatabaseSync(path);
    database.exec("DROP INDEX session_binding_expiry_idx");
    database.close();

    await expect(store.health()).resolves.toEqual({ ready: false });
  });

  it("supplies all three durable production dependency views", async () => {
    const store = track(new SqliteProductionStore(databasePath()));
    const assembly = createProductionPlatformAssembly({
      auditRepository: store,
      idempotencyRepository: store,
      sessionBindingStore: store,
    });

    expect(assembly.status).toBe("available");
    await expect(assembly.readiness()).resolves.toEqual({
      ready: true,
      reasons: [],
    });
    await expect(assembly.close()).resolves.toBeUndefined();
    await expect(store.health()).resolves.toEqual({ ready: false });
  });

  it("fails closed for corrupt, read-only, and unsupported database files", () => {
    const corruptPath = databasePath();
    writeFileSync(corruptPath, "not a sqlite database", { mode: 0o600 });
    expect(() => new SqliteProductionStore(corruptPath)).toThrow();

    const readOnlyPath = databasePath();
    const readOnlyDatabase = new DatabaseSync(readOnlyPath);
    readOnlyDatabase.close();
    chmodSync(readOnlyPath, 0o400);
    expect(() => new SqliteProductionStore(readOnlyPath)).toThrow(/writable/i);

    const futurePath = databasePath();
    const futureDatabase = new DatabaseSync(futurePath);
    futureDatabase.exec("PRAGMA user_version = 99");
    futureDatabase.close();
    expect(() => new SqliteProductionStore(futurePath)).toThrow(/version/i);
    const unchangedFutureDatabase = new DatabaseSync(futurePath);
    expect(unchangedFutureDatabase.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 99,
    });
    unchangedFutureDatabase.close();

    const weakPath = databasePath();
    const weakDatabase = new DatabaseSync(weakPath);
    weakDatabase.exec(`
      CREATE TABLE audit_events (sequence INTEGER, audit_id TEXT, event_json TEXT);
      CREATE TABLE idempotency_records (
        tenant_id TEXT, tool TEXT, idempotency_key TEXT, request_hash TEXT,
        preview_ref TEXT, status TEXT, record_id TEXT, result_json TEXT, expires_at INTEGER
      );
      CREATE TABLE session_bindings (
        session_id TEXT, tenant_id TEXT, actor_id TEXT, client_id TEXT,
        auth_session_id TEXT, context_fingerprint TEXT, owner_id TEXT,
        created_at_ms INTEGER, expires_at_ms INTEGER
      );
      PRAGMA user_version = 1;
    `);
    weakDatabase.close();
    expect(() => new SqliteProductionStore(weakPath)).toThrow(/schema/i);

    const targetPath = databasePath();
    const targetDatabase = new DatabaseSync(targetPath);
    targetDatabase.close();
    const linkPath = `${targetPath}.link`;
    symlinkSync(targetPath, linkPath);
    expect(() => new SqliteProductionStore(linkPath)).toThrow(/regular file/i);
  });
});
