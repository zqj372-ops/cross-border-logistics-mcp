import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPortalFixtureRuntime } from "../../services/access-gateway/portal/fixture";
import { PortalCallLogService, SqliteCallLogStore, type CallEvent } from "../../services/access-gateway/portal/call-log";
import type { PortalContext } from "../../services/access-gateway/portal/contracts";

it("isolates tenants and application filters, paginates without duplication, bounds retention and survives restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "portal-call-log-"));
  const fixture = await createPortalFixtureRuntime({ databaseDirectory: root });
  const context: PortalContext = { identity: { userId: "fixture-owner", displayName: "Owner", email: "owner@example.test", emailVerified: true, platformRole: null }, organizationId: "org_fixture" };
  const app = (await fixture.bridge.createApplication(context, { idempotencyKey: "call-log-app-create01", input: { name: "Log test", purpose: "fixture", environment: "test" } })).data as { applicationId: string; clientId: string };
  const now = Date.now(), path = join(root, "calls.sqlite");
  let store = new SqliteCallLogStore(path, 4, () => now);
  const event = (id: number, changes: Partial<CallEvent> = {}): CallEvent => ({ event_id: `call_${id}`, tenant_id: "tenant_fixture", client_id: app.clientId, actor_ref: "fixture-owner",
    operation: "customs.query", request_id: `req_call_${id}`, status: "unavailable", duration_ms: 120, created_at: new Date(now-id*1000).toISOString(), ...changes });
  try {
    await store.append(event(1)); await store.append(event(2));
    await store.append(event(3, { client_id: null }));
    await store.append(event(4, { tenant_id: "tenant_other" }));
    await store.append(event(5, { created_at: new Date(now-31*86_400_000).toISOString() }));
    const service = new PortalCallLogService(store, fixture.service);
    const page = await service.query(context, { application_id: app.applicationId, limit: 1 });
    expect(page.data.summary.total).toBe(2);
    expect(page.data.events.map(item => item.event_id)).toEqual(["call_1"]);
    const next = await service.query(context, { application_id: app.applicationId, limit: 1, cursor: page.data.next_cursor! });
    expect(next.data.events.map(item => item.event_id)).toEqual(["call_2"]);
    expect(next.data.next_cursor).toBeNull();
    await expect(service.query(context, { tenant_id: "tenant_other" })).rejects.toThrow();
    await expect(service.query(context, { application_id: "app_other" })).rejects.toThrow();
    await expect(store.append({ ...event(9), input: "private body" } as CallEvent)).rejects.toThrow();
    await store.close(); store = new SqliteCallLogStore(path, 4, () => now);
    expect((await new PortalCallLogService(store, fixture.service).query(context, {})).data.summary.total).toBe(3);
    await store.append(event(6)); await store.append(event(7));
    expect((await new PortalCallLogService(store, fixture.service).query(context, {})).data.summary.total).toBe(4);
  } finally { await store.close(); await fixture.close(); rmSync(root, { recursive: true, force: true }); }
});
