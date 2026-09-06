import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPortalHttpHandler } from "../../services/access-gateway/portal/http";
import { FixturePortalIdentityProvider } from "../../services/access-gateway/portal/identity";
import type { PortalIdentityProvider } from "../../services/access-gateway/portal/identity";
import { InMemoryPortalSessionStore, PortalSessionManager, type PortalSession, type PortalSessionStore } from "../../services/access-gateway/portal/session";
import { PORTAL_SCHEMA_VERSION, success, type PortalContext, type PortalMutation } from "../../services/access-gateway/portal/contracts";
import type { PortalCredentialBridge } from "../../services/access-gateway/portal/http";
import type { PortalService } from "../../services/access-gateway/portal/service";
import { startPortalServer } from "../../services/access-gateway/portal/server";

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function setup(bridge?: PortalCredentialBridge) {
  const service = {
    getState: (context: PortalContext) => success({ data_mode: "fixtures", identity: context.identity, current_organization: null, organizations: [], users: [], memberships: [{ organizationId: "org-a", userId: "fixture-owner", role: "owner", status: "active", createdAt: "2026-09-05T00:00:00.000Z" }], invitations: [], applications: [], requests: [], grants: [], catalog: [], operations: [] }),
  } as unknown as PortalService;
  const handlerRef: { current?: ReturnType<typeof createPortalHttpHandler> } = {};
  const server = createServer((request, response) => { void handlerRef.current?.handle(request, response); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  handlerRef.current = createPortalHttpHandler({ mode: "fixtures", service, ...(bridge ? { bridge } : {}), identityProvider: new FixturePortalIdentityProvider({ mode: "fixtures", loopback: true }), sessions: new PortalSessionManager({ store: new InMemoryPortalSessionStore(), secureCookie: false }), allowedHosts: [new URL(origin).host], allowedOrigins: [origin], allowLoopbackHttp: true });
  return origin;
}

function cookieFrom(response: Response): string { const raw = response.headers.get("set-cookie"); if (!raw) throw new Error("missing cookie"); return raw.split(";", 1)[0]!; }

describe("portal HTTP boundary", () => {
  it("creates an anonymous session, requires CSRF, logs in only by fixture identity and keeps APIs JSON-only", async () => {
    const origin = await setup();
    const sessionResponse = await fetch(`${origin}/console/api/v1/session`);
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get("cache-control")).toBe("no-store");
    const cookie = cookieFrom(sessionResponse);
    const session = await sessionResponse.json() as { csrf_token: string };
    const denied = await fetch(`${origin}/console/api/v1/fixture-login`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ identity_id: "fixture-owner" }) });
    expect(denied.status).toBe(403);
    const login = await fetch(`${origin}/console/api/v1/fixture-login`, { method: "POST", headers: { cookie, origin, "x-csrf-token": session.csrf_token, "idempotency-key": "idem_fixture_login_0001", "content-type": "application/json" }, body: JSON.stringify({ identity_id: "fixture-owner" }) });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ schema_version: PORTAL_SCHEMA_VERSION, identity: { user_id: "fixture-owner" } });
    const unknown = await fetch(`${origin}/console/api/v1/not-a-resource`, { headers: { cookie: cookieFrom(login) } });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
  });

  it("serves only exact console assets, supports port 0, and refuses incomplete production providers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "portal-static-"));
    await writeFile(join(directory, "index.html"), "<!doctype html><title>Portal</title>");
    const service = { getState: (context: PortalContext) => success({ identity: context.identity, current_organization: null, organizations: [], memberships: [], invitations: [], applications: [], requests: [], grants: [], catalog: [], operations: [] }) } as unknown as PortalService;
    const machineHandler = { handle: (request:IncomingMessage,response:ServerResponse) => Promise.resolve().then(() => { if(request.url!=="/api/fixture/v1/tools/cargo.calculate")return false;response.statusCode=200;response.setHeader("content-type","application/json");response.end(JSON.stringify({status:"success"}));return true; }) };
    const started = await startPortalServer({ mode: "fixtures", service, machineHandler, port: 0, staticDirectory: directory });
    servers.push(started.server);
    const page = await fetch(`${started.origin}/console/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("Portal");
    expect(await (await fetch(`${started.origin}/api/fixture/v1/tools/cargo.calculate`)).json()).toEqual({status:"success"});
    const unknown = await fetch(`${started.origin}/console/api/v1/missing`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
    await expect(startPortalServer({ mode: "production", service, port: 0, staticDirectory: directory })).rejects.toThrow("production_identity_provider_required");
    await expect(startPortalServer({ mode: "production", service, machineHandler, port: 0, staticDirectory: directory })).rejects.toThrow("fixture_machine_handler_forbidden");
    const identityProvider: PortalIdentityProvider = { kind: "oidc", begin: () => Promise.resolve({ state: "state", nonce: "nonce", codeVerifier: "verifier", authorizationUrl: "https://id.example.test/authorize" }), complete: () => Promise.resolve({ userId: "user", displayName: "User", email: "user@example.test", emailVerified: true, platformRole: null }) };
    await expect(startPortalServer({ mode: "production", service, identityProvider, port: 0, staticDirectory: directory })).rejects.toThrow("production_session_store_required");
    const values = new Map<string, PortalSession>();
    const sessionStore: PortalSessionStore = { kind: "persistent", get: (id) => values.get(id) ?? null, put: (value) => { values.set(value.sessionId, value); }, delete: (id) => { values.delete(id); } };
    await expect(startPortalServer({ mode: "production", service, identityProvider, sessionStore, port: 0, staticDirectory: directory })).rejects.toThrow("production_portal_store_required");
    await expect(startPortalServer({ mode: "production", service, identityProvider, sessionStore, repositoryKind: "production", port: 0, staticDirectory: directory })).rejects.toThrow("production_public_origin_required");
    await started.close(); servers.splice(servers.indexOf(started.server), 1);
    await rm(directory, { recursive: true, force: true });
  });

  it("delegates stable application identity allocation to the bridge and rejects browser-supplied identifiers", async () => {
    const seen: PortalMutation<Record<string, unknown>>[] = [];
    const bridge: PortalCredentialBridge = { createApplication: (_context, value) => { seen.push(value); return success({ ...value.input, application_id: `app_${value.idempotencyKey}`, client_id: `client_${value.idempotencyKey}` }); } };
    const origin = await setup(bridge);
    const anonymousResponse = await fetch(`${origin}/console/api/v1/session`);
    const anonymous = await anonymousResponse.json() as { csrf_token: string };
    const loginResponse = await fetch(`${origin}/console/api/v1/fixture-login`, { method: "POST", headers: { cookie: cookieFrom(anonymousResponse), origin, "x-csrf-token": anonymous.csrf_token, "idempotency-key": "idem_fixture_login_0002", "content-type": "application/json" }, body: JSON.stringify({ identity_id: "fixture-owner" }) });
    const loggedIn = await loginResponse.json() as { csrf_token: string };
    const selectedResponse = await fetch(`${origin}/console/api/v1/session/organization`, { method: "POST", headers: { cookie: cookieFrom(loginResponse), origin, "x-csrf-token": loggedIn.csrf_token, "idempotency-key": "idem_select_org_000001", "content-type": "application/json" }, body: JSON.stringify({ organization_id: "org-a" }) });
    const selected = await selectedResponse.json() as { csrf_token: string };
    const selectedCookie = cookieFrom(selectedResponse);
    const headers = { cookie: selectedCookie, origin, "x-csrf-token": selected.csrf_token, "idempotency-key": "idem_create_app_000001", "content-type": "application/json" };
    const payload = { name: "Warehouse", purpose: "T0 integration", environment: "test" };
    const first = await fetch(`${origin}/console/api/v1/applications`, { method: "POST", headers, body: JSON.stringify(payload) });
    const second = await fetch(`${origin}/console/api/v1/applications`, { method: "POST", headers, body: JSON.stringify(payload) });
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(seen[0]?.input).toEqual({ name: "Warehouse", purpose: "T0 integration", environment: "test", ownerUserId: "fixture-owner" });
    expect(seen[1]?.input).toEqual(seen[0]?.input);
    const injected = await fetch(`${origin}/console/api/v1/applications`, { method: "POST", headers: { ...headers, "idempotency-key": "idem_create_app_000002" }, body: JSON.stringify({ ...payload, application_id: "attacker-app" }) });
    expect(injected.status).toBe(400);
    const invalid = await fetch(`${origin}/console/api/v1/applications`, { method: "POST", headers: { ...headers, "idempotency-key": "idem_create_app_000003" }, body: JSON.stringify({ ...payload, environment: "staging" }) });
    expect(invalid.status).toBe(400);
  });
});
