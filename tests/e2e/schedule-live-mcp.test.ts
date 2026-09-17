import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { expect, it } from "vitest";

import { SCHEDULE_MCP_TOOLS, type ApplicationMcpTool, type ScheduleMcpTool } from "../../src/logistics_mcp/platform/application-tools";
import { createProductionComposition } from "../../src/logistics_mcp/server/composition";
import { createScheduleRuntimeProvider } from "../../src/logistics_mcp/server/schedule-provider";
import { SqliteProductionStore } from "../../src/logistics_mcp/platform/sqlite-production-store";
import { SyntheticJwtSigner } from "../../services/access-gateway/synthetic";
import { ApplicationMcpAccessService } from "../../services/access-gateway/portal/business-access/mcp";
import type { CarrierAdapter } from "../../services/maritime/schedule-collector/carriers/types";
import type { CarrierHttpPort } from "../../services/maritime/schedule-collector/ports";
import { InMemoryScheduleLiveAuditSink } from "../../services/maritime/schedule-live/audit";
import { createScheduleLiveService } from "../../services/maritime/schedule-live/service";

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

it("serves schedule-live-v1 tools/list and tools/call with exact scope, tenant binding and revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "schedule-mcp-e2e-"));
  const evidenceRoot = mkdtempSync(join(tmpdir(), "schedule-mcp-evidence-"));
  const store = new SqliteProductionStore(join(root, "runtime.sqlite"));
  const signer = new SyntheticJwtSigner();
  const jwks = createLocalJWKSet({ keys: (await signer.getJwks()).keys.map((key) => ({ ...key })) });
  const verifier = {
    verify: async (token: string) =>
      (await jwtVerify(token, jwks, { algorithms: ["RS256"], issuer: "https://issuer.example.invalid/", audience: "mcp" })).payload,
  };
  const audit = new InMemoryScheduleLiveAuditSink();
  const scheduleLive = createScheduleLiveService({
    portal: { getState: () => { throw new Error("machine path must not read Portal membership"); } },
    policy: { liveEnabled: () => true },
    clock: { now: () => new Date("2026-09-18T00:00:00Z") },
    audit,
    evidenceRoot,
    adapters: [adapter()],
    http: unusableHttp,
  });
  let active = true;
  const current = (tools: readonly (ApplicationMcpTool | ScheduleMcpTool)[]) => {
    if (!active) throw new Error("revoked");
    return {
      tenantId: "tenant_fixture",
      clientId: "client_fixture",
      applicationId: "app_fixture",
      credentialId: "bkey_0123456789abcdef01234567",
      toolNames: [...tools],
    };
  };
  const access = new ApplicationMcpAccessService({
    signer,
    verifier,
    issuer: "https://issuer.example.invalid/",
    audience: "mcp",
    limiter: { reserve: () => Promise.resolve(true) },
    authority: {
      authorizeMcpApiKey: (_key, tools) => Promise.resolve(current(tools)),
      authorizeMcpCredential: (input) => Promise.resolve(current(input.requestedToolNames)),
    },
  });
  const exchange = async (tools: readonly (ApplicationMcpTool | ScheduleMcpTool)[]) =>
    (await access.exchange("synthetic-schedule-key", {
      schema_version: "application-mcp-exchange@2026-09-06.v1",
      requested_tool_names: tools,
    }, "127.0.0.1")).data.access_token;
  const token = await exchange(SCHEDULE_MCP_TOOLS);
  const runtimeSecret = "s".repeat(48);
  const provider = createScheduleRuntimeProvider({
    baseUrl: "https://provider.example.invalid/",
    allowedHosts: ["provider.example.invalid"],
    runtimeSecret,
    fetchImpl: async (resource, init) => {
      const url = new URL(resource instanceof Request ? resource.url : resource);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-freightclaw-runtime-token")).toBe(runtimeSecret);
      if (url.pathname === "/access/v2/application/schedule/provider/health") {
        return Response.json({
          schema_version: "schedule-provider-health@2026-09-18.v1",
          ready: true,
          contract_version: "ocean-schedule-live@2026-09-18.v1",
          operations: SCHEDULE_MCP_TOOLS,
        });
      }
      const tool = SCHEDULE_MCP_TOOLS.find((name) => url.pathname === `/access/v2/application/mcp/tools/${name}`);
      if (tool === undefined) return new Response("not found", { status: 404 });
      const bearer = headers.get("authorization")!.slice(7);
      const machine = await access.verify(bearer, [tool]);
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as {
        readonly request_id: string;
        readonly input: unknown;
      };
      const result = await scheduleLive.machineExecute({
        tool,
        tenantId: machine.tenantId,
        actorId: machine.credentialId,
        input: body.input,
        requestId: body.request_id,
      });
      return Response.json(result.body);
    },
  });
  const composition = createProductionComposition({
    dataMode: "production",
    profile: "schedule-live-v1",
    scheduleProvider: provider,
    auditRepository: store,
    idempotencyRepository: store,
    sessionBindingStore: store,
    sessionOwnerId: "instance_fixture",
    allowedHosts: ["runtime.example.invalid"],
    allowedOrigins: ["https://client.example.invalid"],
    tokenPolicy: { issuer: "https://issuer.example.invalid/", audience: "mcp", maxLifetimeSeconds: 300 },
    tokenVerifier: {
      kind: "token_verifier",
      verify: async (value) => {
        await access.verify(value);
        return verifier.verify(value);
      },
      health: () => Promise.resolve({ ready: true }),
      close: () => Promise.resolve(),
    },
  });
  const connect = (bearer: string) => {
    const client = new Client({ name: "schedule-live-mcp", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("https://runtime.example.invalid/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: (resource, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", "runtime.example.invalid");
        headers.set("origin", "https://client.example.invalid");
        return composition.handler(new Request(resource, { ...init, headers }));
      },
    });
    return { client, transport };
  };
  const client = connect(token);
  try {
    expect(composition.definitions).toHaveLength(6);
    expect(await composition.readiness()).toEqual({ ready: true, reasons: [] });
    await client.client.connect(client.transport as Parameters<Client["connect"]>[0]);
    expect((await client.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...SCHEDULE_MCP_TOOLS].sort());

    const carriers = await client.client.callTool({ name: "maritime.schedule.carriers", arguments: {} });
    expect(carriers.structuredContent).toMatchObject({ status: "success" });
    const carrierData = (carriers.structuredContent as {
      readonly data: { readonly carriers: readonly { readonly id: string }[] };
    }).data;
    expect(carrierData.carriers.some((carrier) => carrier.id === "ONE")).toBe(true);
    const locations = await client.client.callTool({
      name: "maritime.schedule.locations",
      arguments: { carrier: "ONE", text: "Shanghai", country_code: "CN", carrier_location_id: "CNSHA" },
    });
    expect(locations.structuredContent).toMatchObject({
      status: "success",
      data: { resolved: { carrier_location_id: "CNSHA" } },
    });
    const search = await client.client.callTool({
      name: "maritime.schedule.search",
      arguments: searchInput,
    });
    expect(search.structuredContent).toMatchObject({
      status: "success",
      data: { coverage: { complete: true }, provenance: { kind: "live" } },
    });
    expect(audit.entries.filter((entry) => entry.action === "search").every((entry) =>
      entry.tenant_id === "tenant_fixture" && entry.actor_id === "bkey_0123456789abcdef01234567"
    )).toBe(true);

    const narrowToken = await exchange(["maritime.schedule.carriers"]);
    const narrow = connect(narrowToken);
    try {
      await narrow.client.connect(narrow.transport as Parameters<Client["connect"]>[0]);
      expect((await narrow.client.listTools()).tools.map((tool) => tool.name)).toEqual(["maritime.schedule.carriers"]);
      expect(
        await narrow.client.callTool({ name: "maritime.schedule.search", arguments: searchInput }),
      ).toMatchObject({ isError: true });
    } finally {
      await narrow.client.close();
    }

    active = false;
    await expect(
      client.client.callTool({ name: "maritime.schedule.carriers", arguments: {} }),
    ).rejects.toThrow();
  } finally {
    await client.client.close();
    await composition.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
}, 20_000);
