import { DatabaseSync } from "node:sqlite";

/** Dedicated private-service DB, never the Gateway or an existing CRM database. */
export class OutreachStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS outreach_records_v1 (
      tenant TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
      value TEXT NOT NULL CHECK (json_valid(value)),
      PRIMARY KEY (tenant, kind, ref)
    ) STRICT;`);
  }
  get<T>(tenant: string, kind: string, ref: string): T | null {
    const row = this.db.prepare("SELECT value FROM outreach_records_v1 WHERE tenant=? AND kind=? AND ref=?").get(tenant, kind, ref);
    return row === undefined ? null : JSON.parse(String(row.value)) as T;
  }
  set(tenant: string, kind: string, ref: string, value: unknown): void {
    this.db.prepare("INSERT INTO outreach_records_v1 VALUES(?,?,?,?) ON CONFLICT(tenant,kind,ref) DO UPDATE SET value=excluded.value")
      .run(tenant, kind, ref, JSON.stringify(value));
    const readback = this.db.prepare("SELECT value FROM outreach_records_v1 WHERE tenant=? AND kind=? AND ref=?").get(tenant, kind, ref);
    if (readback?.value !== JSON.stringify(value)) throw new Error("outreach_store_readback_failed");
  }
  list<T>(tenant: string, kind: string, limit = 100): T[] {
    return this.db.prepare("SELECT value FROM outreach_records_v1 WHERE tenant=? AND kind=? ORDER BY ref LIMIT ?")
      .all(tenant, kind, limit).map((row) => JSON.parse(String(row.value)) as T);
  }
  queued<T>(tenant: string): T | null {
    const row = this.db.prepare("SELECT value FROM outreach_records_v1 WHERE tenant=? AND kind='job' AND json_extract(value,'$.state')='queued' ORDER BY ref LIMIT 1").get(tenant);
    return row === undefined ? null : JSON.parse(String(row.value)) as T;
  }
  cancelQueued(tenant: string, leadRef: string, reason: string, now: string): void {
    this.db.prepare(`UPDATE outreach_records_v1 SET value=json_set(value,'$.state','cancelled','$.reason',?,'$.updated_at',?)
      WHERE tenant=? AND kind='job' AND json_extract(value,'$.state')='queued'
      AND json_extract(value,'$.draft_ref') IN (
        SELECT ref FROM outreach_records_v1 WHERE tenant=? AND kind='draft' AND json_extract(value,'$.lead_ref')=?
      )`).run(reason, now, tenant, tenant, leadRef);
  }
  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
