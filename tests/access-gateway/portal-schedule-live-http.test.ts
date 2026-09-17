import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PortalContext } from "../../services/access-gateway/portal/contracts";
import { FixturePortalIdentityProvider } from "../../services/access-gateway/portal/identity";
import { InMemoryPortalSessionStore } from "../../services/access-gateway/portal/session";
import { startPortalServer, type StartedPortalServer } from "../../services/access-gateway/portal/server";
import type { PortalService } from "../../services/access-gateway/portal/service";
import type { CarrierAdapter } from "../../services/maritime/schedule-collector/carriers/types";
import type { CarrierHttpPort } from "../../services/maritime/schedule-collector/ports";
import { InMemoryScheduleLiveAuditSink } from "../../services/maritime/schedule-live/audit";
import { createScheduleLiveService } from "../../services/maritime/schedule-live/service";

const servers: StartedPortalServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const unusableHttp: CarrierHttpPort = {
  request() {
    return Promise.reject(new Error("http must not be called"));
  },
};

function adapter(candidates: number): CarrierAdapter {
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
      const base = {
        name: lookup.text.toUpperCase(),
        country_code: lookup.countryCode,
        type: "city" as const,
        carrier_location_id: lookup.carrierLocationId ?? "CNSHA",
        mapping_source: "one_point_to_point_search",
        source_full_name: lookup.text.toUpperCase(),
        unlocode: null,
      };
      return Promise.resolve(
        candidates > 1
          ? [
              base,
              {
                ...base,
                name: `${base.name} YANGSHAN`,
                carrier_location_id: "CNSHY",
              },
            ]
          : [base],
      );
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

const roles: Readonly<Record<string, "owner" | "developer" | "viewer">> = {
  "fixture-owner": "owner",
  "fixture-developer": "developer",
  "fixture-sales": "viewer",
};

function portalStub(): Pick<PortalService, "getState"> {
  return {
    getState(ctx: PortalContext) {
      const role = roles[ctx.identity.userId];
      const organizationId = ctx.organizationId;
      return {
        schema_version: "portal@2026-09-05.v1" as const,
        status: "success" as const,
        reason_codes: [],
        data: {
          data_mode: "fixtures" as const,
          identity: ctx.identity,
          current_organization:
            organizationId === null
              ? null
              : {
                  organizationId,
                  tenantId: "tenant-a",
                  displayName: "Fixture Org",
                  status: "active" as const,
                  createdAt: "2026-01-01T00:00:00Z",
                },
          organizations:
            organizationId === null
              ? []
              : [{ organizationId, displayName: "Fixture Org", status: "active" as const }],
          users: [],
          memberships:
            role === undefined
              ? []
              : [
                  {
                    // `getState({organizationId:null})` is used by the
                    // organization picker, so membership rows stay visible.
                    organizationId: organizationId ?? "org-a",
                    userId: ctx.identity.userId,
                    role,
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

async function start(liveEnabled: boolean, candidates = 1): Promise<string> {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "portal-schedule-live-"));
  directories.push(evidenceRoot);
  const server = await startPortalServer({
    mode: "fixtures",
    service: portalStub() as never,
    scheduleLive: createScheduleLiveService({
      portal: portalStub(),
      policy: { liveEnabled: () => liveEnabled },
      clock: { now: () => new Date("2026-09-18T00:00:00Z") },
      audit: new InMemoryScheduleLiveAuditSink(),
      evidenceRoot,
      adapters: [adapter(candidates)],
      http: unusableHttp,
    }),
    identityProvider: new FixturePortalIdentityProvider({ mode: "fixtures", loopback: true }),
    sessionStore: new InMemoryPortalSessionStore(),
    host: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  return server.origin;
}

async function login(origin: string, identityId: string) {
  const anonymousResponse = await fetch(`${origin}/console/api/v1/session`);
  const anonymous = (await anonymousResponse.json()) as { csrf_token: string };
  const loginResponse = await fetch(`${origin}/console/api/v1/fixture-login`, {
    method: "POST",
    headers: {
      cookie: anonymousResponse.headers.get("set-cookie")!.split(";", 1)[0]!,
      origin,
      "x-csrf-token": anonymous.csrf_token,
      "idempotency-key": `fixture_login_${identityId.padEnd(16, "0")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ identity_id: identityId }),
  });
  expect(loginResponse.status).toBe(200);
  const logged = (await loginResponse.json()) as { csrf_token: string };
  const cookie = loginResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
  const selectResponse = await fetch(`${origin}/console/api/v1/session/organization`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "x-csrf-token": logged.csrf_token,
      "idempotency-key": `select_org_${identityId.padEnd(16, "0")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ organization_id: "org-a" }),
  });
  expect(selectResponse.status).toBe(200);
  const selected = (await selectResponse.json()) as { csrf_token: string };
  return {
    cookie,
    origin,
    "x-csrf-token": selected.csrf_token,
    "content-type": "application/json",
  };
}

const searchInput = {
  carrier: "ONE",
  origin: { text: "Shanghai", country_code: "CN", carrier_location_id: "CNSHA" },
  destination: { text: "Vancouver", country_code: "CA", carrier_location_id: "CAVAN" },
  from: "2026-09-18",
  until: "2026-10-15",
  routing: "any",
};

describe("portal schedule-collector routes", () => {
  it("serves carriers, locations and search over the person session and keeps legacy snapshots separate", async () => {
    const origin = await start(true);
    const headers = await login(origin, "fixture-owner");
    const carriersResponse = await fetch(
      `${origin}/console/api/v1/maritime/schedule-collector/carriers`,
      { headers },
    );
    expect(carriersResponse.status).toBe(200);
    const carriers = (await carriersResponse.json()) as {
      status: string;
      data: { carriers: readonly { id: string }[] };
    };
    expect(carriers.status).toBe("success");
    expect(carriers.data.carriers.some((carrier) => carrier.id === "ONE")).toBe(true);

    const locationsResponse = await fetch(
      `${origin}/console/api/v1/maritime/schedule-collector/locations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          carrier: "ONE",
          text: "Shanghai",
          country_code: "CN",
          carrier_location_id: "CNSHA",
        }),
      },
    );
    expect(locationsResponse.status).toBe(200);
    expect(await locationsResponse.json()).toMatchObject({
      status: "success",
      data: { resolved: { carrier_location_id: "CNSHA" } },
    });

    const searchResponse = await fetch(
      `${origin}/console/api/v1/maritime/schedule-collector/search`,
      { method: "POST", headers, body: JSON.stringify(searchInput) },
    );
    expect(searchResponse.status).toBe(200);
    const search = (await searchResponse.json()) as {
      status: string;
      data: { coverage: { complete: boolean }; provenance: { kind: string } };
    };
    expect(search.status).toBe("success");
    expect(search.data.coverage.complete).toBe(true);
    expect(search.data.provenance.kind).toBe("live");
  });

  it("returns needs_input for multiple location candidates without pre-selecting one", async () => {
    const origin = await start(true, 2);
    const headers = await login(origin, "fixture-owner");
    const response = await fetch(
      `${origin}/console/api/v1/maritime/schedule-collector/locations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          carrier: "ONE",
          text: "Shanghai",
          country_code: "CN",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "needs_input",
      data: { resolved: null },
      blockers: [{ code: "ambiguous_location" }],
    });
  });

  it("lets viewers read carriers but denies viewer search and disabled tenants", async () => {
    const origin = await start(true);
    const viewer = await login(origin, "fixture-sales");
    expect(
      (
        await fetch(`${origin}/console/api/v1/maritime/schedule-collector/carriers`, {
          headers: viewer,
        })
      ).status,
    ).toBe(200);
    const deniedSearch = await fetch(
      `${origin}/console/api/v1/maritime/schedule-collector/search`,
      { method: "POST", headers: viewer, body: JSON.stringify(searchInput) },
    );
    expect(deniedSearch.status).toBe(403);
    expect(await deniedSearch.json()).toMatchObject({
      reason_codes: ["schedule_live_role_denied"],
    });

    const disabledOrigin = await start(false);
    const owner = await login(disabledOrigin, "fixture-owner");
    const disabledSearch = await fetch(
      `${disabledOrigin}/console/api/v1/maritime/schedule-collector/search`,
      { method: "POST", headers: owner, body: JSON.stringify(searchInput) },
    );
    expect(disabledSearch.status).toBe(403);
    expect(await disabledSearch.json()).toMatchObject({
      reason_codes: ["schedule_live_disabled"],
    });
  });
});
