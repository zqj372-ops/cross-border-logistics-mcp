import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortalHttpHandler } from "../../services/access-gateway/portal/http";
import type { PortalIdentityProvider } from "../../services/access-gateway/portal/identity";
import { InMemoryPortalSessionStore, PortalSessionManager } from "../../services/access-gateway/portal/session";
import type { PortalService } from "../../services/access-gateway/portal/service";

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("missing cookie");
  return value.split(";", 1)[0]!;
}

async function setup(provider: PortalIdentityProvider, sessions = new PortalSessionManager({ store: new InMemoryPortalSessionStore(), secureCookie: false }), allowLoopbackHttp = true) {
  const service = {} as PortalService;
  const holder: { handler?: ReturnType<typeof createPortalHttpHandler> } = {};
  const server = createServer((request, response) => { void holder.handler?.handle(request, response); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  holder.handler = createPortalHttpHandler({ mode: "production", service, identityProvider: provider, sessions, allowedHosts: [new URL(origin).host], allowedOrigins: [origin], allowLoopbackHttp });
  return origin;
}

async function rawGet(origin: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: target.hostname, port: target.port, path, method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject); request.end();
  });
}

describe("OIDC browser recovery", () => {
  it("redirects expired and cross-browser HTML callbacks to one fixed safe category without reflecting secrets", async () => {
    let now = 1_000;
    const complete = vi.fn(() => Promise.resolve({ userId: "user", displayName: "User", email: "user@example.test", emailVerified: true, platformRole: null }));
    const provider: PortalIdentityProvider = {
      kind: "oidc",
      begin: () => Promise.resolve({ state: "expected-state", nonce: "nonce", codeVerifier: "verifier", authorizationUrl: "https://identity.example.test/authorize" }),
      complete,
    };
    const sessions = new PortalSessionManager({ store: new InMemoryPortalSessionStore(), secureCookie: false, now: () => now });
    const origin = await setup(provider, sessions);
    const login = await fetch(`${origin}/console/auth/login`, { headers: { accept: "text/html" }, redirect: "manual" });
    const cookie = cookieFrom(login);
    now += 300_001;
    const expired = await fetch(`${origin}/console/auth/callback?code=secret-code&state=expected-state&token=secret-token`, { headers: { accept: "text/html", cookie }, redirect: "manual" });
    expect(expired.status).toBe(303);
    expect(expired.headers.get("location")).toBe("/console/?auth_error=login_expired");
    expect(expired.headers.get("cache-control")).toBe("no-store");
    expect(expired.headers.get("referrer-policy")).toBe("no-referrer");
    expect(`${expired.headers.get("location")} ${await expired.text()}`).not.toMatch(/secret-code|expected-state|secret-token/u);
    expect(complete).not.toHaveBeenCalled();

    const crossBrowser = await fetch(`${origin}/console/auth/callback?code=other-secret&state=other-state`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(crossBrowser.status).toBe(303);
    expect(crossBrowser.headers.get("location")).toBe("/console/?auth_error=login_expired");
  });

  it("keeps JSON errors and boundary failures non-redirecting", async () => {
    const provider: PortalIdentityProvider = { kind: "oidc", begin: () => Promise.reject(new Error("oidc_discovery_invalid")), complete: () => Promise.reject(new Error("oidc_token_invalid")) };
    const origin = await setup(provider);
    const jsonCallback = await fetch(`${origin}/console/auth/callback?code=secret&state=secret`, { headers: { accept: "application/json" }, redirect: "manual" });
    expect(jsonCallback.status).toBe(401);
    expect(jsonCallback.headers.get("location")).toBeNull();
    expect(await jsonCallback.json()).toMatchObject({ reason_codes: ["authentication_required"] });

    const invalidHost = await rawGet(origin, "/console/auth/callback?code=secret&state=secret", { accept: "text/html", host: "attacker.example" });
    expect(invalidHost.status).toBe(403);
    expect(invalidHost.headers.location).toBeUndefined();
    expect(JSON.parse(invalidHost.body)).toMatchObject({ reason_codes: ["invalid_host"] });

    const transportOrigin = await setup(provider, new PortalSessionManager({ store: new InMemoryPortalSessionStore(), secureCookie: false }), false);
    const invalidTransport = await fetch(`${transportOrigin}/console/auth/callback?code=secret&state=secret`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(invalidTransport.status).toBe(403);
    expect(invalidTransport.headers.get("location")).toBeNull();
    expect(await invalidTransport.json()).toMatchObject({ reason_codes: ["transport_required"] });
  });

  it("uses only fixed unavailable and rejected categories for other HTML OIDC failures", async () => {
    const unavailableOrigin = await setup({ kind: "oidc", begin: () => Promise.reject(new Error("oidc_discovery_invalid")), complete: () => Promise.reject(new Error("oidc_token_invalid")) });
    const unavailable = await fetch(`${unavailableOrigin}/console/auth/login`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(unavailable.status).toBe(303);
    expect(unavailable.headers.get("location")).toBe("/console/?auth_error=login_unavailable");

    const rejectedOrigin = await setup({
      kind: "oidc",
      begin: () => Promise.resolve({ state: "valid-state", nonce: "nonce", codeVerifier: "verifier", authorizationUrl: "https://identity.example.test/authorize" }),
      complete: () => Promise.reject(new Error("oidc_token_invalid")),
    });
    const login = await fetch(`${rejectedOrigin}/console/auth/login`, { headers: { accept: "text/html" }, redirect: "manual" });
    const rejected = await fetch(`${rejectedOrigin}/console/auth/callback?code=private-code&state=valid-state`, { headers: { accept: "text/html", cookie: cookieFrom(login) }, redirect: "manual" });
    expect(rejected.status).toBe(303);
    expect(rejected.headers.get("location")).toBe("/console/?auth_error=login_rejected");
    expect(`${rejected.headers.get("location")} ${await rejected.text()}`).not.toContain("private-code");
  });

  it("preserves normal authorization and successful callback redirects", async () => {
    const complete = vi.fn(() => Promise.resolve({ userId: "user", displayName: "User", email: "user@example.test", emailVerified: true, platformRole: null }));
    const provider: PortalIdentityProvider = {
      kind: "oidc",
      begin: () => Promise.resolve({ state: "valid-state", nonce: "nonce", codeVerifier: "verifier", authorizationUrl: "https://identity.example.test/authorize?client_id=portal" }),
      complete,
    };
    const origin = await setup(provider);
    const login = await fetch(`${origin}/console/auth/login`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("https://identity.example.test/authorize?client_id=portal");
    const callback = await fetch(`${origin}/console/auth/callback?code=valid-code&state=valid-state`, { headers: { accept: "text/html", cookie: cookieFrom(login) }, redirect: "manual" });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/console/");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ code: "valid-code", state: "valid-state" }));
  });
});
