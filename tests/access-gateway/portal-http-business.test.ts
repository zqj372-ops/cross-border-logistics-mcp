import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortalBusinessService, type PortalBusinessClientResult } from "../../services/access-gateway/portal/business/service";
import { type PortalContext, type PortalIdentity, type PortalState, success } from "../../services/access-gateway/portal/contracts";
import { createPortalFixtureRuntime, type PortalFixtureRuntime } from "../../services/access-gateway/portal/fixture";
import { createPortalHttpHandler, type PortalHttpOptions } from "../../services/access-gateway/portal/http";
import { FixturePortalIdentityProvider } from "../../services/access-gateway/portal/identity";
import { InMemoryPortalSessionStore, PortalSessionManager } from "../../services/access-gateway/portal/session";
import type { PortalService } from "../../services/access-gateway/portal/service";

const servers: Server[] = [];
const runtimes: PortalFixtureRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ownerIdentity: PortalIdentity = { userId: "fixture-owner", displayName: "企业所有者", email: "owner@example.test", emailVerified: true, platformRole: null };
const createdAt = "2026-09-05T00:00:00.000Z";

function portalState(context: PortalContext): PortalState {
  const organizations = [{ organizationId: "org-a", displayName: "Alpha", status: "active" as const }];
  const memberships = context.identity.userId === ownerIdentity.userId
    ? [{ organizationId: "org-a", userId: ownerIdentity.userId, role: "owner" as const, status: "active" as const, createdAt }]
    : [];
  return {
    data_mode: "fixtures", identity: context.identity,
    current_organization: context.organizationId === "org-a" ? { organizationId: "org-a", tenantId: "tenant-a", displayName: "Alpha", status: "active", createdAt } : null,
    organizations, users: [{ userId: ownerIdentity.userId, displayName: ownerIdentity.displayName }], memberships,
    invitations: [], applications: [], requests: [], grants: [], catalog: [], operations: [],
  };
}

const portalService = { getState: (context: PortalContext) => success(portalState(context)) } as unknown as PortalService;

async function start(options: { readonly service?: PortalService; readonly businessService?: PortalHttpOptions["businessService"] } = {}) {
  const handlerRef: { current?: ReturnType<typeof createPortalHttpHandler> } = {};
  const server = createServer((request, response) => {
    void handlerRef.current!.handle(request, response).then((handled) => {
      if (!handled && !response.writableEnded) { response.statusCode = 404; response.end(); }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  handlerRef.current = createPortalHttpHandler({
    mode: "fixtures", service: options.service ?? portalService,
    ...(options.businessService ? { businessService: options.businessService } : {}),
    identityProvider: new FixturePortalIdentityProvider({ mode: "fixtures", loopback: true }),
    sessions: new PortalSessionManager({ store: new InMemoryPortalSessionStore(), secureCookie: false }),
    allowedHosts: [new URL(origin).host], allowedOrigins: [origin], allowLoopbackHttp: true,
  });
  return origin;
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie"); if (!value) throw new Error("session cookie missing");
  return value.split(";", 1)[0]!;
}

async function login(origin: string, identityId = "fixture-owner", organizationId: string | null = "org-a") {
  const anonymousResponse = await fetch(`${origin}/console/api/v1/session`);
  const anonymous = await anonymousResponse.json() as { csrf_token: string };
  const authenticatedResponse = await fetch(`${origin}/console/api/v1/fixture-login`, {
    method: "POST", headers: { cookie: cookie(anonymousResponse), origin, "x-csrf-token": anonymous.csrf_token, "idempotency-key": "idem_fixture_login_business_01", "content-type": "application/json" },
    body: JSON.stringify({ identity_id: identityId }),
  });
  const authenticated = await authenticatedResponse.json() as { csrf_token: string };
  if (organizationId === null) return { cookie: cookie(authenticatedResponse), csrf: authenticated.csrf_token };
  const selectedResponse = await fetch(`${origin}/console/api/v1/session/organization`, {
    method: "POST", headers: { cookie: cookie(authenticatedResponse), origin, "x-csrf-token": authenticated.csrf_token, "idempotency-key": "idem_select_business_org_01", "content-type": "application/json" },
    body: JSON.stringify({ organization_id: organizationId }),
  });
  const selected = await selectedResponse.json() as { csrf_token: string };
  return { cookie: cookie(selectedResponse), csrf: selected.csrf_token };
}

function post(origin: string, path: string, session: { cookie: string; csrf: string }, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: "POST", headers: { cookie: session.cookie, origin, "x-csrf-token": session.csrf, "idempotency-key": "idem_business_call_0001", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const result = (status: PortalBusinessClientResult["status"], data: unknown, reasonCodes: readonly string[] = []): PortalBusinessClientResult => ({
  schema_version: "portal-source-test.v1", status, data, reason_codes: reasonCodes, request_id: "req_business1234",
});

describe("portal personnel business HTTP", () => {
  it("requires an authenticated session, CSRF and idempotency before invoking a business operation", async () => {
    const execute = vi.fn(() => Promise.resolve(result("success", {})));
    const executeBatch = vi.fn(() => Promise.resolve(result("success", {})));
    const origin = await start({ businessService: { describe: vi.fn() as never, execute, executeBatch } });
    const anonymous = await fetch(`${origin}/console/api/v1/business/customs/query`, {
      method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": "idem_business_call_0001" }, body: JSON.stringify({ input: {} }),
    });
    expect(anonymous.status).toBe(401);
    const session = await login(origin);
    const missingCsrf = await fetch(`${origin}/console/api/v1/business/customs/query`, {
      method: "POST", headers: { cookie: session.cookie, origin, "content-type": "application/json", "idempotency-key": "idem_business_call_0002" }, body: JSON.stringify({ input: {} }),
    });
    expect(missingCsrf.status).toBe(403);
    const missingIdempotency = await post(origin, "/console/api/v1/business/customs/query", session, { input: {} }, { "idempotency-key": "" });
    expect(missingIdempotency.status).toBe(400);
    expect(execute).not.toHaveBeenCalled(); expect(executeBatch).not.toHaveBeenCalled();
  });

  it("rejects browser-supplied tenant and actor fields at the closed top-level body", async () => {
    const execute = vi.fn(() => Promise.resolve(result("success", {})));
    const origin = await start({ businessService: { describe: vi.fn() as never, execute, executeBatch: vi.fn() } });
    const session = await login(origin);
    for (const injected of [{ tenant_id: "tenant-attacker" }, { actor: { id: "other-user" } }]) {
      const response = await post(origin, "/console/api/v1/business/customs/query", session, { input: { query: "shirt" }, ...injected });
      expect(response.status).toBe(400);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("derives the actor and organization from the session and maps every single and batch route exactly once", async () => {
    const customsQuery = vi.fn(() => Promise.resolve(result("success", { sourceShape: true })));
    const taxEstimate = vi.fn(() => Promise.resolve(result("manual_review", { customsPayable: null, confirmedSubtotal: { amount: "10.25", currency: "CAD" }, reasonCodes: ["tariff_manual_review"] }, ["tariff_manual_review"])));
    const taxEstimateBatch = vi.fn(() => Promise.resolve(result("needs_input", { partialFailure: false, counts: { total: 1, success: 0, needsInput: 1, manualReview: 0, unavailable: 0 }, results: [{ valueForDuty: null, reasonCodes: ["missing_hs_code"] }] }, ["missing_hs_code"])));
    const quotePreview = vi.fn(() => Promise.resolve(result("unavailable", null, ["quote_source_unavailable"])));
    const quoteExtract = vi.fn(() => Promise.resolve(result("blocked", null, ["quote_policy_blocked"])));
    const freightcomPreview = vi.fn(() => Promise.resolve(result("manual_review", { provider: "freightcom", rates: [] }, ["freightcom_no_rates_returned"])));
    const businessService = new PortalBusinessService({ portalService, connections: [{
      organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["customs.query", "customs.tax.estimate", "quote.zone_preview", "quote.ai_extract_preview", "quote.freightcom_ltl.preview"],
      customsClient: { query: customsQuery }, taxClient: { estimate: taxEstimate, estimateBatch: taxEstimateBatch }, quoteClient: { preview: quotePreview, extract: quoteExtract }, freightcomClient: { preview: freightcomPreview },
    }] });
    const origin = await start({ businessService }); const session = await login(origin);
    const cases = [
      ["/console/api/v1/business/customs/query", { query: "shirt" }, "success"],
      ["/console/api/v1/business/customs/tax-estimate", { ruleDate: "2026-09-05", lineId: "line-1" }, "manual_review"],
      ["/console/api/v1/business/customs/tax-estimates/batch", { ruleDate: "2026-09-05", items: [{ lineId: "line-1" }] }, "needs_input"],
      ["/console/api/v1/business/quote/preview", { postal_code: "M5V3A8" }, "unavailable"],
      ["/console/api/v1/business/quote/extract", { customer_message: "one pallet" }, "blocked"],
      ["/console/api/v1/business/quote/freightcom-ltl-preview", { details: { providerInput: true } }, "manual_review"],
    ] as const;
    const responses: Array<Record<string, unknown>> = [];
    for (const [path, input, expectedStatus] of cases) {
      const response = await post(origin, path, session, { input }, { "x-request-id": "req_business1234" });
      expect(response.status, path).toBe(200);
      const body = await response.json() as Record<string, unknown>; responses.push(body);
      expect(body.status).toBe(expectedStatus);
    }
    expect(customsQuery).toHaveBeenCalledWith({ input: cases[0][1], actor: { type: "user", id: "fixture-owner" }, requestId: "req_business1234" });
    expect(taxEstimate).toHaveBeenCalledWith({ input: cases[1][1], actor: { type: "user", id: "fixture-owner" }, requestId: "req_business1234" });
    expect(taxEstimateBatch).toHaveBeenCalledWith({ input: cases[2][1], actor: { type: "user", id: "fixture-owner" }, requestId: "req_business1234" });
    expect(quotePreview).toHaveBeenCalledOnce(); expect(quoteExtract).toHaveBeenCalledOnce();
    expect(freightcomPreview).toHaveBeenCalledWith({ input: cases[5][1], requestId: "req_business1234" });
    expect(responses[1]).toMatchObject({ status: "manual_review", data: { customsPayable: null, confirmedSubtotal: { amount: "10.25", currency: "CAD" }, reasonCodes: ["tariff_manual_review"] } });
    expect(responses[2]).toMatchObject({ status: "needs_input", data: { partialFailure: false, counts: { needsInput: 1, manualReview: 0 }, results: [{ valueForDuty: null, reasonCodes: ["missing_hs_code"] }] } });
  });

  it("lets the real business service reject a platform session before any organization client runs", async () => {
    const query = vi.fn(() => Promise.resolve(result("success", {})));
    const businessService = new PortalBusinessService({ portalService, connections: [{ organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["customs.query"], customsClient: { query } }] });
    const origin = await start({ businessService }); const session = await login(origin, "fixture-reviewer", null);
    const response = await post(origin, "/console/api/v1/business/customs/query", session, { input: { query: "shirt" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "blocked", data: null, reason_codes: ["business_personnel_session_required"] });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns only the signed-in person's organization summaries across enterprises", async () => {
    const directory = mkdtempSync(join(tmpdir(), "portal-http-business-")); directories.push(directory);
    const runtime = await createPortalFixtureRuntime({ databaseDirectory: directory, nowSeconds: 1_788_537_600 }); runtimes.push(runtime);
    const operator: PortalContext = { identity: { userId: "fixture-operator", displayName: "平台运维管理员", email: "operator@example.test", emailVerified: true, platformRole: "operator" }, organizationId: null };
    runtime.service.bootstrapOrganization(operator, { idempotencyKey: "fixture-hidden-org-0001", input: { organizationId: "org-hidden", tenantId: "tenant-hidden", displayName: "Hidden Enterprise" } });
    const origin = await start({ service: runtime.service }); const session = await login(origin, "fixture-owner", "org_fixture");
    const response = await fetch(`${origin}/console/api/v1/my-organizations`, { headers: { cookie: session.cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { organizations: Array<{ organization_id: string }>; memberships: Array<{ organization_id: string }>; invitations: unknown[] } };
    expect(body.data.organizations.map((item) => item.organization_id)).toEqual(["org_fixture"]);
    expect(body.data.memberships.every((item) => item.organization_id === "org_fixture")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("org-hidden");
    expect(JSON.stringify(body)).not.toContain("tenant-hidden");
  });

  it("maps reviewer actions and streams only a verified private PDF", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nportal verified\n%%EOF");
    const digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`;
    const records = vi.fn((...args: unknown[]) => {
      const action = args[1] as string;
      if (action === "documentDownload") return Promise.resolve({ status: "success", data: { metadata: { document_ref: "document_abcdefghijklmnop", media_type: "application/pdf", content_length: bytes.byteLength, content_sha256: digest }, bytes } });
      return Promise.resolve(result("success", action === "reviewQueue" ? { tasks: [] } : { action }));
    });
    const origin = await start({ businessService: { describe: vi.fn() as never, execute: vi.fn(), executeBatch: vi.fn(), records } });
    const session = await login(origin);
    const queue = await fetch(`${origin}/console/api/v1/business/quote/review-queue`, { headers: { cookie: session.cookie, "x-request-id": "req_review_queue_01" } });
    expect(queue.status).toBe(200); expect(await queue.json()).toMatchObject({ status: "success", data: { tasks: [] } });
    const resolved = await post(origin, "/console/api/v1/business/quote/review-tasks/task_abcdefghijklmnop/resolve", session, {
      expected_task_version: 1, resolution_handle: "opaque-resolution-handle-that-is-long-enough", decision: "keep_manual_review", note: "继续人工核对。",
    });
    expect(resolved.status).toBe(200);
    const download = await fetch(`${origin}/console/api/v1/business/quote/documents/document_abcdefghijklmnop/content`, { headers: { cookie: session.cookie } });
    expect(download.status).toBe(200); expect(download.headers.get("cache-control")).toBe("no-store"); expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(records.mock.calls.map((call) => call[1])).toEqual(["reviewQueue", "reviewResolve", "documentDownload"]);
    expect(records.mock.calls[1]?.[2]).toMatchObject({ task_ref: "task_abcdefghijklmnop", decision: "keep_manual_review" });
  });
});
