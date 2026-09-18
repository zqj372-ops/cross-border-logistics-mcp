import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runWorkspace } from "../../deploy/cli/workspace";
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

function adapter(): CarrierAdapter {
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

function portalStub(): Pick<PortalService, "getState"> {
  const roles: Readonly<Record<string, "owner" | "viewer">> = {
    "fixture-owner": "owner",
    "fixture-sales": "viewer",
  };
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
          organizations: [],
          users: [],
          memberships:
            role === undefined
              ? []
              : [
                  {
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

async function start(): Promise<string> {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "cli-schedule-live-"));
  directories.push(evidenceRoot);
  const server = await startPortalServer({
    mode: "fixtures",
    service: portalStub() as never,
    scheduleLive: createScheduleLiveService({
      portal: portalStub(),
      policy: { liveEnabled: () => true },
      clock: { now: () => new Date("2026-09-18T00:00:00Z") },
      audit: new InMemoryScheduleLiveAuditSink(),
      evidenceRoot,
      adapters: [adapter()],
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

async function sessionFile(origin: string, identityId: string): Promise<string> {
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
  const directory = await mkdtemp(join(tmpdir(), "cli-session-"));
  directories.push(directory);
  const path = join(directory, "session.json");
  await writeFile(
    path,
    JSON.stringify({
      origin,
      session_token: cookie.slice("fc_portal_session=".length),
      csrf_token: selected.csrf_token,
      expires_at: Date.now() + 3_600_000,
    }),
    { mode: 0o600 },
  );
  return path;
}

function helpers() {
  return {
    endpoint: (value: string) => new URL(value),
    readFileBounded: async (name: string, maximum: number, secret = false) => {
      const info = await stat(name);
      if (!info.isFile() || info.size > maximum) throw new Error("file_invalid");
      if (secret && (info.mode & 0o077) !== 0) throw new Error("file_permissions");
      return readFile(name);
    },
    readStdin: () => Promise.resolve(Buffer.alloc(0)),
    parseJson: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown,
    readResponse: async (response: Response) => await response.text(),
  };
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runWorkspace(args, {
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
    env: {},
  }, helpers());
  return { code, stdout, stderr };
}

describe("workspace schedules live CLI", () => {
  it("runs live-carriers, live-locations and live-search through the person session", async () => {
    const origin = await start();
    const session = await sessionFile(origin, "fixture-owner");

    const carriers = await run([
      "schedules", "live-carriers", "--session-file", session, "--endpoint", origin,
    ]);
    expect(carriers.code).toBe(0);
    const carriersBody = JSON.parse(carriers.stdout) as {
      readonly status: string;
      readonly data: { readonly carriers: readonly { readonly id: string }[] };
    };
    expect(carriersBody.status).toBe("success");
    expect(carriersBody.data.carriers.some((carrier) => carrier.id === "ONE")).toBe(true);

    const directory = await mkdtemp(join(tmpdir(), "cli-input-"));
    directories.push(directory);
    const locationsInput = join(directory, "locations.json");
    await writeFile(
      locationsInput,
      JSON.stringify({
        carrier: "ONE",
        text: "Shanghai",
        country_code: "CN",
        carrier_location_id: "CNSHA",
      }),
    );
    const locations = await run([
      "schedules", "live-locations", "--session-file", session,
      "--endpoint", origin, "--input", locationsInput,
    ]);
    expect(locations.code).toBe(0);
    expect(JSON.parse(locations.stdout)).toMatchObject({
      status: "success",
      data: { resolved: { carrier_location_id: "CNSHA" } },
    });

    const searchInput = join(directory, "search.json");
    await writeFile(
      searchInput,
      JSON.stringify({
        carrier: "ONE",
        origin: { text: "Shanghai", country_code: "CN", carrier_location_id: "CNSHA" },
        destination: { text: "Vancouver", country_code: "CA", carrier_location_id: "CAVAN" },
        from: "2026-09-18",
        until: "2026-10-15",
        routing: "any",
      }),
    );
    const search = await run([
      "schedules", "live-search", "--session-file", session,
      "--endpoint", origin, "--input", searchInput,
    ]);
    expect(search.code).toBe(0);
    expect(JSON.parse(search.stdout)).toMatchObject({
      status: "success",
      data: { coverage: { complete: true }, provenance: { kind: "live" } },
    });
  });

  it("exposes the live-search schema and denies viewer search", async () => {
    const origin = await start();
    const session = await sessionFile(origin, "fixture-owner");
    const schema = await run([
      "schema", "schedules", "live-search", "--session-file", session,
      "--endpoint", origin,
    ]);
    expect(schema.code).toBe(0);
    const schemaBody = JSON.parse(schema.stdout) as {
      readonly $schema: string;
      readonly additionalProperties: boolean;
      readonly properties: { readonly carrier: { readonly enum: readonly string[] } };
    };
    expect(schemaBody.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schemaBody.additionalProperties).toBe(false);
    expect(schemaBody.properties.carrier.enum).toContain("ONE");

    const viewerSession = await sessionFile(origin, "fixture-sales");
    const directory = await mkdtemp(join(tmpdir(), "cli-viewer-"));
    directories.push(directory);
    const searchInput = join(directory, "search.json");
    await writeFile(
      searchInput,
      JSON.stringify({
        carrier: "ONE",
        origin: { text: "Shanghai", country_code: "CN", carrier_location_id: "CNSHA" },
        destination: { text: "Vancouver", country_code: "CA", carrier_location_id: "CAVAN" },
        from: "2026-09-18",
        until: "2026-10-15",
        routing: "any",
      }),
    );
    const denied = await run([
      "schedules", "live-search", "--session-file", viewerSession,
      "--endpoint", origin, "--input", searchInput,
    ]);
    expect(denied.code).toBe(5);
    expect(denied.stderr).toContain("permission_or_session_denied");
  });
});
