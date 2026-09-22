import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PortalContext, PortalRole } from "../../../services/access-gateway/portal/contracts";
import type { PortalService } from "../../../services/access-gateway/portal/service";
import type { CarrierAdapter } from "../../../services/maritime/schedule-collector/carriers/types";
import type { CarrierHttpPort } from "../../../services/maritime/schedule-collector/ports";
import { InMemoryScheduleLiveAuditSink } from "../../../services/maritime/schedule-live/audit";
import { createScheduleLiveService } from "../../../services/maritime/schedule-live/service";
import type {
  ScheduleLiveAuditEntry,
  ScheduleLiveAuditSink,
} from "../../../services/maritime/schedule-live/service";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function evidenceRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "schedule-live-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function context(organizationId: string, userId: string): PortalContext {
  return {
    identity: {
      userId,
      displayName: userId,
      email: `${userId}@example.test`,
      emailVerified: true,
      platformRole: null,
    },
    organizationId,
  };
}

function portalStub(
  members: Readonly<Record<string, { readonly tenantId: string; readonly role: PortalRole }>>,
): Pick<PortalService, "getState"> {
  return {
    getState(ctx: PortalContext) {
      const organizationId = ctx.organizationId;
      const member = organizationId === null ? undefined : members[organizationId];
      return {
        schema_version: "portal@2026-09-05.v1" as const,
        status: "success" as const,
        reason_codes: [],
        data: {
          data_mode: "fixtures" as const,
          identity: ctx.identity,
          current_organization:
            organizationId === null || member === undefined
              ? null
              : {
                  organizationId,
                  tenantId: member.tenantId,
                  displayName: organizationId,
                  status: "active" as const,
                  createdAt: "2026-01-01T00:00:00Z",
                },
          organizations:
            organizationId === null || member === undefined
              ? []
              : [{ organizationId, displayName: organizationId, status: "active" as const }],
          users: [],
          memberships:
            organizationId === null || member === undefined
              ? []
              : [
                  {
                    organizationId,
                    userId: ctx.identity.userId,
                    role: member.role,
                    status: "active" as const,
                    createdAt: "2026-01-01T00:00:00Z",
                  },
                ],
          invitations: [],
          applications: [],
          requests: [],
          grants: [],
          catalog: [],
          operations: [],
        },
      };
    },
  };
}

const unusableHttp: CarrierHttpPort = {
  request() {
    return Promise.reject(new Error("http must not be called"));
  },
};

function quickAdapter(): CarrierAdapter {
  return {
    metadata: {
      id: "ONE",
      displayName: "Ocean Network Express",
      adapterVersion: "one-schedule-parser@1",
      capabilityStatus: "live_verified",
      provenanceKind: "live",
      lastLiveVerifiedAt: "2026-09-17T10:26:31Z",
    },
    resolveLocations(lookup) {
      return Promise.resolve([
        {
          name: lookup.text.toUpperCase(),
          country_code: lookup.countryCode,
          type: "city",
          carrier_location_id: lookup.carrierLocationId ?? "CNSHA",
          mapping_source: "one_point_to_point_search",
          source_full_name: lookup.text.toUpperCase(),
          unlocode: null,
        },
      ]);
    },
    async query(request, _http, evidence) {
      const reference = await evidence.write({
        requestId: request.requestId,
        carrier: "ONE",
        kind: "http_response",
        mediaType: "application/json",
        bytes: new TextEncoder().encode(JSON.stringify({ fixture: true })),
        redactions: [],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return {
        records: [],
        coverage: {
          requested_from: request.normalizedQuery.departure_from,
          requested_until: request.normalizedQuery.departure_until,
          covered_windows: [
            {
              from: request.normalizedQuery.departure_from,
              until: request.normalizedQuery.departure_until,
            },
          ],
          uncovered_windows: [],
          pages_read: [1],
          complete: true,
          truncated: false,
          failure_reason: null,
        },
        quality: {
          key_fields_complete: true,
          evaluation_status: "evaluated",
          conflicts: [],
          warnings: [],
          missing_field_count: 0,
        },
        evidenceRef: reference.ref,
      };
    },
  };
}

const searchInput = {
  carrier: "ONE",
  origin: {
    text: "Shanghai",
    country_code: "CN",
    carrier_location_id: "CNSHA",
  },
  destination: {
    text: "Vancouver",
    country_code: "CA",
    carrier_location_id: "CAVAN",
  },
  from: "2026-09-18",
  until: "2026-10-15",
  routing: "any",
};

describe("schedule live service audit and isolation", () => {
  it("binds one request_id and audit_id across the envelope and every audit event", async () => {
    const audit = new InMemoryScheduleLiveAuditSink();
    const service = createScheduleLiveService({
      portal: portalStub({ org_a: { tenantId: "tenant_a", role: "owner" } }),
      policy: { liveEnabled: (tenantId) => tenantId === "tenant_a" },
      clock: { now: () => new Date("2026-09-18T00:00:00Z") },
      audit,
      evidenceRoot: await evidenceRoot(),
      adapters: [quickAdapter()],
      http: unusableHttp,
    });

    const result = await service.search(
      context("org_a", "user_a"),
      searchInput,
      { requestId: "req_audit_chain" },
    );
    const body = result.body as { readonly request_id: string; readonly audit_id: string; readonly status: string };
    expect(body.status).toBe("success");
    expect(body.request_id).toBe("req_audit_chain");

    const searchEvents = audit.entries.filter((entry) => entry.action === "search");
    expect(searchEvents.length).toBeGreaterThanOrEqual(2);
    expect(searchEvents.every((entry) => entry.audit_id === body.audit_id)).toBe(true);
    expect(searchEvents.every((entry) => entry.request_id === body.request_id)).toBe(true);
    expect(searchEvents.every((entry) => entry.tenant_id === "tenant_a")).toBe(true);
    expect(searchEvents.every((entry) => entry.actor_id === "user_a")).toBe(true);
  });

  it("records a real tenantId, not the organizationId, on role denial", async () => {
    const audit = new InMemoryScheduleLiveAuditSink();
    const service = createScheduleLiveService({
      portal: portalStub({ org_a: { tenantId: "tenant_a", role: "viewer" } }),
      policy: { liveEnabled: () => true },
      clock: { now: () => new Date("2026-09-18T00:00:00Z") },
      audit,
      evidenceRoot: await evidenceRoot(),
      adapters: [quickAdapter()],
      http: unusableHttp,
    });

    await expect(
      service.search(context("org_a", "user_viewer"), searchInput),
    ).rejects.toThrow("schedule_live_role_denied");
    const denial = audit.entries.at(-1)!;
    expect(denial.tenant_id).toBe("tenant_a");
    expect(denial.tenant_id).not.toBe("org_a");
    expect(denial.issue_code).toBe("schedule_live_role_denied");
  });

  it("lets a viewer read the static carrier registry but not search", async () => {
    const audit = new InMemoryScheduleLiveAuditSink();
    const service = createScheduleLiveService({
      portal: portalStub({ org_a: { tenantId: "tenant_a", role: "viewer" } }),
      policy: { liveEnabled: () => true },
      clock: { now: () => new Date("2026-09-18T00:00:00Z") },
      audit,
      evidenceRoot: await evidenceRoot(),
      adapters: [quickAdapter()],
      http: unusableHttp,
    });
    const ctx = context("org_a", "user_viewer");
    const carriers = await service.carriers(ctx);
    expect(carriers.status).toBe("success");
    await expect(service.search(ctx, searchInput)).rejects.toThrow(
      "schedule_live_role_denied",
    );
  });

  it("rejects a search when the deployment tenant allowlist does not match", async () => {
    const audit = new InMemoryScheduleLiveAuditSink();
    const service = createScheduleLiveService({
      portal: portalStub({ org_b: { tenantId: "tenant_b", role: "owner" } }),
      policy: { liveEnabled: (tenantId) => tenantId === "tenant_a" },
      clock: { now: () => new Date("2026-09-18T00:00:00Z") },
      audit,
      evidenceRoot: await evidenceRoot(),
      adapters: [quickAdapter()],
      http: unusableHttp,
    });
    await expect(
      service.search(context("org_b", "user_b"), searchInput),
    ).rejects.toThrow("schedule_live_disabled");
    expect(audit.entries.at(-1)?.tenant_id).toBe("tenant_b");
  });

  it("returns evidence metadata only to the owning tenant", async () => {
    const audit = new InMemoryScheduleLiveAuditSink();
    const service = createScheduleLiveService({
      portal: portalStub({
        org_a: { tenantId: "tenant_a", role: "owner" },
        org_b: { tenantId: "tenant_b", role: "owner" },
      }),
      policy: { liveEnabled: (tenantId) => tenantId === "tenant_a" },
      clock: { now: () => new Date("2026-09-18T00:00:00Z") },
      audit,
      evidenceRoot: await evidenceRoot(),
      adapters: [quickAdapter()],
      http: unusableHttp,
    });
    const result = await service.search(context("org_a", "user_a"), searchInput);
    const data = (result.body as { readonly data: { readonly provenance: { readonly source_refs: readonly string[] } } }).data;
    const reference = data.provenance.source_refs[0]!;

    const readback = await service.readEvidence(context("org_a", "user_a"), reference);
    expect(readback.ref).toBe(reference);
    expect(readback.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readback.byte_length).toBeGreaterThan(0);

    await expect(
      service.readEvidence(context("org_b", "user_b"), reference),
    ).rejects.toThrow("evidence_not_found");
  });

  it("does not persist a success terminal event when the audit write is cancelled", async () => {
    const entries: ScheduleLiveAuditEntry[] = [];
    const slowSink: ScheduleLiveAuditSink = {
      async record(entry, options) {
        if (entry.status === "no_results" || entry.status === "ok") {
          await delay(30);
          if (options?.signal?.aborted === true) {
            throw new Error("audit_aborted");
          }
        }
        entries.push(entry);
      },
    };
    const controller = new AbortController();
    const service = createScheduleLiveService({
      portal: portalStub({ org_a: { tenantId: "tenant_a", role: "owner" } }),
      policy: { liveEnabled: () => true },
      clock: { now: () => new Date("2026-09-18T00:00:00Z") },
      audit: slowSink,
      evidenceRoot: await evidenceRoot(),
      adapters: [quickAdapter()],
      http: unusableHttp,
    });
    const timer = setTimeout(() => controller.abort(), 10);
    const result = await service.search(context("org_a", "user_a"), searchInput, {
      requestId: "req_cancel_terminal_audit",
      signal: controller.signal,
    });
    clearTimeout(timer);

    expect(result.status).toBe("unavailable");
    expect(entries.some((entry) => entry.status === "no_results" || entry.status === "ok")).toBe(false);
    expect(entries.some((entry) => entry.status === "error")).toBe(true);
  });
});


describe('fixed FCL personal receiver schedule access',()=>{
  it('requires current personal authorization and deployment enablement; other callers stay denied',async()=>{
    const audit=new InMemoryScheduleLiveAuditSink();let active=true;let enabled=true;let checks=0;
    const service=createScheduleLiveService({portal:portalStub({}),policy:{liveEnabled:scope=>enabled&&scope==='fcl-personal-test'},clock:{now:()=>new Date('2026-10-01T00:00:00Z')},audit,evidenceRoot:await evidenceRoot(),adapters:[],http:{request:()=>Promise.reject(new Error('no external access'))},personalAccess:{scopeId:'fcl-personal-test',authorize:ctx=>{checks++;return Promise.resolve(active&&ctx.identity.userId==='receiver');}}});
    const receiver={...context('unused','receiver'),organizationId:null};
    await expect(service.carriers(receiver)).resolves.toMatchObject({status:'success'});expect(checks).toBe(1);
    await expect(service.carriers({...receiver,identity:{...receiver.identity,userId:'other'}})).rejects.toMatchObject({code:'schedule_live_membership_required'});
    await expect(service.carriers({...receiver,identity:{...receiver.identity,emailVerified:false}})).rejects.toMatchObject({code:'schedule_live_membership_required'});
    active=false;await expect(service.carriers(receiver)).rejects.toMatchObject({code:'schedule_live_membership_required'});
    active=true;enabled=false;await expect(service.locations(receiver,{carrier:'ONE',text:'Shanghai'})).rejects.toMatchObject({code:'schedule_live_disabled'});
  });
  it('uses the personal evidence scope for search and rejects a revoked identity before another query',async()=>{
    const audit=new InMemoryScheduleLiveAuditSink();let active=true;
    const service=createScheduleLiveService({portal:portalStub({}),policy:{liveEnabled:scope=>scope==='fcl-personal-test'},clock:{now:()=>new Date('2026-09-18T00:00:00Z')},audit,evidenceRoot:await evidenceRoot(),adapters:[quickAdapter()],http:unusableHttp,personalAccess:{scopeId:'fcl-personal-test',authorize:ctx=>Promise.resolve(active&&ctx.identity.userId==='receiver')}});
    const receiver={...context('unused','receiver'),organizationId:null};
    const result=await service.search(receiver,searchInput);
    expect(result.status).toBe('success');
    expect((await service.machineExecute({tool:'maritime.schedule.search',tenantId:'fcl-personal-test',actorId:'receiver',input:searchInput})).status).toBe('blocked');
    const data=(result.body as {data:{provenance:{source_refs:string[]}}}).data;
    const ref=data.provenance.source_refs[0]!;
    expect((await service.readEvidence(receiver,ref)).byte_length).toBeGreaterThan(0);
    expect(audit.entries.filter(e=>e.action==='search').every(e=>e.tenant_id==='fcl-personal-test'&&e.actor_id==='receiver')).toBe(true);
    active=false;
    await expect(service.search(receiver,searchInput)).rejects.toMatchObject({code:'schedule_live_membership_required'});
    await expect(service.readEvidence(receiver,ref)).rejects.toMatchObject({code:'schedule_live_membership_required'});
  });

});

it('isolates personal sailing evidence across accounts even with an old enterprise selected',async()=>{
  const audit=new InMemoryScheduleLiveAuditSink();
  const service=createScheduleLiveService({portal:portalStub({}),policy:{liveEnabled:scope=>scope.startsWith('fcl-personal-test-')},clock:{now:()=>new Date('2026-09-18T00:00:00Z')},audit,evidenceRoot:await evidenceRoot(),adapters:[quickAdapter()],http:unusableHttp,personalAccess:{scopeId:'fcl-personal-test',perAccount:true,authorize:ctx=>Promise.resolve(ctx.identity.emailVerified)}});
  const alice=context('old-company','alice'),bob={...context('unused','bob'),organizationId:null};
  const result=await service.search(alice,searchInput);
  const ref=(result.body as {data:{provenance:{source_refs:string[]}}}).data.provenance.source_refs[0]!;
  expect((await service.readEvidence(alice,ref)).byte_length).toBeGreaterThan(0);
  await expect(service.readEvidence(bob,ref)).rejects.toThrow();
  await service.search(bob,searchInput);
  const scopes=new Set(audit.entries.filter(entry=>entry.action==='search'&&entry.status==='success').map(entry=>entry.tenant_id));
  expect(scopes.size).toBe(2);
  for(const tenantId of scopes)expect((await service.machineExecute({tool:'maritime.schedule.search',tenantId,actorId:'alice',input:searchInput})).status).toBe('blocked');
});
