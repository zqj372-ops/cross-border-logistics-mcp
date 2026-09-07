import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openPortalProductionDatabase, securePortalDatabaseFiles } from "./production-persistence";

export interface PublicQuota { readonly limit: number; readonly remaining: number; readonly resets_at: string }
export interface PublicQuotaStore {
  read(address: string, now: number): PublicQuota;
  reserve(address: string, count: number, now: number): PublicQuota & { readonly allowed: boolean };
}
const LIMIT = 20;
const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;

function network(address: string): string {
  const value = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/u, "");
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6 || value.includes("%") || value.includes(".")) throw new Error("public_client_address_invalid");
  const [left = "", right] = value.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const expanded = right === undefined ? start : [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end];
  // IPv6 privacy addresses in the same /64 consume the same visitor allowance.
  return expanded.slice(0, 4).map(part => part.padStart(4, "0")).join(":");
}
function window(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("public_quota_time_invalid");
  const day = Math.floor((now + OFFSET) / DAY);
  return { day, resets_at: new Date((day + 1) * DAY - OFFSET).toISOString() };
}

export class SqlitePublicQuotaStore implements PublicQuotaStore {
  readonly #database: DatabaseSync;
  readonly #secret: Buffer;
  #closed = false;
  constructor(databasePath: string) {
    this.#database = openPortalProductionDatabase(databasePath, "freightclaw-public-quota-v1");
    this.#database.exec(`CREATE TABLE IF NOT EXISTS public_quota_secret (singleton INTEGER PRIMARY KEY CHECK(singleton=1), secret BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS public_daily_quota (network_hash TEXT NOT NULL, day INTEGER NOT NULL, used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 20), PRIMARY KEY(network_hash, day));`);
    this.#database.prepare("INSERT OR IGNORE INTO public_quota_secret VALUES (1, ?)").run(randomBytes(32));
    this.#secret = Buffer.from((this.#database.prepare("SELECT secret FROM public_quota_secret WHERE singleton=1").get() as { secret: Uint8Array }).secret);
    securePortalDatabaseFiles(databasePath);
  }
  #key(address: string, day: number) { return createHmac("sha256", this.#secret).update(`${day}\0${network(address)}`).digest("hex"); }
  read(address: string, now: number): PublicQuota {
    const { day, resets_at } = window(now);
    const row = this.#database.prepare("SELECT used FROM public_daily_quota WHERE network_hash=? AND day=?").get(this.#key(address, day), day) as { used: number } | undefined;
    return { limit: LIMIT, remaining: LIMIT - (row?.used ?? 0), resets_at };
  }
  reserve(address: string, count: number, now: number): PublicQuota & { readonly allowed: boolean } {
    if (!Number.isSafeInteger(count) || count < 1 || count > LIMIT) throw new Error("public_quota_count_invalid");
    const { day } = window(now); const key = this.#key(address, day);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const quota = this.read(address, now);
      if (quota.remaining < count) { this.#database.exec("COMMIT"); return { ...quota, allowed: false }; }
      this.#database.prepare("DELETE FROM public_daily_quota WHERE day < ?").run(day - 1);
      this.#database.prepare("INSERT INTO public_daily_quota VALUES (?, ?, ?) ON CONFLICT(network_hash, day) DO UPDATE SET used=used+excluded.used").run(key, day, count);
      this.#database.exec("COMMIT");
      return { ...quota, remaining: quota.remaining - count, allowed: true };
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  close() { if (this.#closed) return; this.#closed = true; this.#database.close(); this.#secret.fill(0); }
}
