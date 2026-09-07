import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PortalBusinessService, type PortalBusinessServiceOptions } from "../../services/access-gateway/portal/business/service";
import { PortalPublicCustomsService } from "../../services/access-gateway/portal/public-customs";
import { SqlitePublicQuotaStore } from "../../services/access-gateway/portal/public-quota";
import { createPortalHttpHandler } from "../../services/access-gateway/portal/http";
import { FixturePortalIdentityProvider } from "../../services/access-gateway/portal/identity";
import { InMemoryPortalSessionStore, PortalSessionManager } from "../../services/access-gateway/portal/session";
import type { PortalService } from "../../services/access-gateway/portal/service";

const dirs: string[] = []; const quotas: SqlitePublicQuotaStore[] = []; const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); for (const quota of quotas.splice(0)) quota.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const binding = { organizationId: "org-public", tenantId: "tenant-public", applicationId: "app-public", clientId: "client-public", enabledOperations: ["customs.query", "customs.tax.estimate"] as const };
const input = { query: "cotton shirt", ruleDate: "2026-09-07", attributes: { originCountry: "CN" } };
function fixture(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "public-customs-")); dirs.push(directory);
  const quota = new SqlitePublicQuotaStore(join(directory, "quota.sqlite")); quotas.push(quota);
  const requireApplication = vi.fn(() => ({ ...binding, environment: "production" as const, ownerUserId: "owner-public" }));
  const source = vi.fn(() => Promise.resolve({ schema_version: "source-fixture.v1", status: "unavailable" as const, data: null, reason_codes: ["source_data_unready"] }));
  const portal = { getState: vi.fn(), requireBusinessApplication: requireApplication } as unknown as PortalBusinessServiceOptions["portalService"];
  const authority = vi.fn(() => Promise.resolve());
  const business = new PortalBusinessService({ publicAuthority: authority, portalService: portal, ...(enabled ? { publicAccess: binding } : {}), connections: [{ ...binding, serviceActors: { customs: "site-publisher" }, customsClient: { query: source }, taxClient: { estimate: source, estimateBatch: source } }] });
  const publicCustoms = new PortalPublicCustomsService({ business, quota, now: () => Date.parse("2026-09-07T00:00:00Z") });
  return { source, authority, requireApplication, business, publicCustoms, portal };
}
it("requires an explicit active publisher binding and only delegates customs service actors", async () => {
  const f = fixture();
  const result = await f.publicCustoms.execute("203.0.113.1", "customs.query", input, "req_public_0001", false);
  expect(result.body).toMatchObject({ status: "unavailable", reason_codes: ["source_data_unready"] });
  expect(f.source).toHaveBeenCalledWith({ input, actor: { type: "service", id: "site-publisher" }, requestId: "req_public_0001" });
  expect(result.quota?.remaining).toBe(19);
  f.requireApplication.mockReturnValueOnce({ ...binding, tenantId: "other-tenant", environment: "production", ownerUserId: "owner-public" });
  expect((await f.publicCustoms.execute("203.0.113.1", "customs.query", input, "req_public_scope", false)).httpStatus).toBe(503);
  f.requireApplication.mockImplementation(() => { throw new Error("inactive"); });
  expect((await f.publicCustoms.execute("203.0.113.1", "customs.query", input, "req_public_0002", false)).body.status).toBe("unavailable");
  expect(f.source).toHaveBeenCalledTimes(1);
  expect((await fixture(false).publicCustoms.execute("203.0.113.1", "customs.query", input, "req_public_0003", false)).body.status).toBe("unavailable");
});
it("rejects nested identity injection without consuming quota and charges batch products", async () => {
  const f = fixture();
  expect((await f.publicCustoms.execute("203.0.113.1", "customs.query", { ...input, tenant_id: "other" }, "req_public_0001", false)).httpStatus).toBe(400);
  expect(f.publicCustoms.status("203.0.113.1").remaining).toBe(20);
  const batch = { ruleDate: input.ruleDate, items: Array.from({ length: 20 }, (_, n) => ({ lineId: `line-${n}`, destinationCountry: "CA", hsCode: "610910" })) };
  expect((await f.publicCustoms.execute("203.0.113.1", "customs.tax.estimate", batch, "req_public_0002", true)).quota?.remaining).toBe(0);
  expect((await f.publicCustoms.execute("203.0.113.1", "customs.query", input, "req_public_0003", false))).toMatchObject({ httpStatus: 429, body: { status: "blocked", reason_codes: ["public_daily_limit_reached"] } });
  expect(f.source).toHaveBeenCalledTimes(1);
});
it("allows only exact public routes with same-origin anonymous CSRF; quotes, history and account APIs stay private", async () => {
  const f = fixture();
  const ref: { handler?: ReturnType<typeof createPortalHttpHandler> } = {};
  const server = createServer((req, res) => { void ref.handler!.handle(req, res); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  const origin = `http://127.0.0.1:${address.port}`;
  ref.handler = createPortalHttpHandler({ mode: "fixtures", service: f.portal as PortalService, publicCustoms: f.publicCustoms, identityProvider: new FixturePortalIdentityProvider({ mode: "fixtures", loopback: true }), sessions: new PortalSessionManager({ store: new InMemoryPortalSessionStore(), secureCookie: false }), allowedHosts: [new URL(origin).host], allowedOrigins: [origin], allowLoopbackHttp: true });
  const sessionResponse = await fetch(`${origin}/console/api/v1/session`);
  const session = await sessionResponse.json() as { authenticated: boolean; csrf_token: string };
  expect(session.authenticated).toBe(false);
  const headers = { cookie: sessionResponse.headers.get("set-cookie")!.split(";", 1)[0]!, origin, "x-csrf-token": session.csrf_token, "content-type": "application/json" };
  const post = (path: string, payload: unknown = { input }, overrides: Record<string, string> = {}) => fetch(`${origin}/console/api/v1/${path}`, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(payload) });
  expect((await post("public/customs/query", { input }, { origin: "https://attacker.invalid" })).status).toBe(403);
  expect((await post("public/customs/query", { input }, { "x-csrf-token": "bad" })).status).toBe(403);
  expect((await post("public/customs/query", { input, actor: "other" })).status).toBe(400);
  expect((await post("public/customs/query?tenant=other")).status).toBe(400);
  for (const path of ["public/quote/preview", "public/customs/history/list", "public/customs/query/extra"]) expect((await post(path)).status).toBe(404);
  for (const path of ["business/quote/preview", "business/customs/history/list", "business/customs/query", "applications", "state"]) expect((await post(path)).status).toBe(401);
  expect(f.source).not.toHaveBeenCalled();
  const responses = await Promise.all(Array.from({ length: 21 }, () => post("public/customs/query", { input }, { "x-forwarded-for": "203.0.113.99" })));
  expect(responses.filter(r => r.status === 200)).toHaveLength(20);
  expect(responses.filter(r => r.status === 429)).toHaveLength(1);
  expect(f.source).toHaveBeenCalledTimes(20);
  expect(responses.find(r => r.status === 429)?.headers.get("retry-after")).toBeTruthy();
  const newSession = await fetch(`${origin}/console/api/v1/public/customs/quota`);
  expect(await newSession.json()).toMatchObject({ data: { limit: 20, remaining: 0 } });
});

it("does not invoke the source when the publishing tenant or client is disabled", async () => {
  const f = fixture(); f.authority.mockRejectedValue(new Error("inactive"));
  expect((await f.publicCustoms.execute("203.0.113.1", "customs.query", input, "req_public_denied", false)).body).toMatchObject({ status: "unavailable", reason_codes: ["public_customs_unavailable"] });
  expect(f.source).not.toHaveBeenCalled();
});
