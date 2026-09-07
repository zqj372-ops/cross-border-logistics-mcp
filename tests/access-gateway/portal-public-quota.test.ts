import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SqlitePublicQuotaStore } from "../../services/access-gateway/portal/public-quota";

const directories: string[] = [];
const stores: SqlitePublicQuotaStore[] = [];
function open(path?: string) {
  if (!path) { const dir = mkdtempSync(join(tmpdir(), "public-quota-")); directories.push(dir); path = join(dir, "quota.sqlite"); }
  const store = new SqlitePublicQuotaStore(path); stores.push(store); return { store, path };
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
const time = Date.parse("2026-09-07T15:59:00Z");
it("persists a shared 20-query daily allowance across processes and resets at China midnight", () => {
  const first = open(); const second = open(first.path);
  expect(first.store.read("203.0.113.10", time).remaining).toBe(20);
  for (let i = 0; i < 20; i++) expect((i % 2 ? first.store : second.store).reserve("203.0.113.10", 1, time).allowed).toBe(true);
  expect(second.store.reserve("::ffff:203.0.113.10", 1, time)).toMatchObject({ allowed: false, remaining: 0, limit: 20, resets_at: "2026-09-07T16:00:00.000Z" });
  first.store.close(); const restarted = open(first.path);
  expect(restarted.store.read("203.0.113.10", time).remaining).toBe(0);
  expect(restarted.store.read("203.0.113.10", Date.parse("2026-09-07T16:00:00Z")).remaining).toBe(20);
  expect(restarted.store.read("203.0.113.11", time).remaining).toBe(20);
  expect(readFileSync(first.path).includes(Buffer.from("203.0.113.10"))).toBe(false);
});
it("counts batch products atomically and does not charge rejected oversized batches", () => {
  const { store } = open();
  expect(store.reserve("203.0.113.10", 19, time)).toMatchObject({ allowed: true, remaining: 1 });
  expect(store.reserve("203.0.113.10", 2, time)).toMatchObject({ allowed: false, remaining: 1 });
  expect(store.reserve("203.0.113.10", 1, time)).toMatchObject({ allowed: true, remaining: 0 });
  for (const cost of [0, -1, 1.5, 21]) expect(() => store.reserve("203.0.113.10", cost, time)).toThrow();
});
it("shares IPv6 /64 budget across equivalent and rotating privacy addresses", () => {
  const { store } = open();
  store.reserve("2001:db8:1:2::1", 20, time);
  expect(store.read("2001:0db8:0001:0002:abcd:0000:0000:0009", time).remaining).toBe(0);
  expect(store.read("2001:db8:1:3::1", time).remaining).toBe(20);
  expect(() => store.read("forwarded,spoof", time)).toThrow();
});

it("does not grant fresh allowance when the database is unavailable", () => {
  const { store } = open(); store.close();
  expect(() => store.reserve("203.0.113.10", 1, time)).toThrow();
});
