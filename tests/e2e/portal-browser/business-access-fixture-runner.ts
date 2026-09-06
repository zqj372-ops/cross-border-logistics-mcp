import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createPortalFixtureRuntime } from "../../../services/access-gateway/portal/fixture";
import { createPortalMachineHttpHandler } from "../../../services/access-gateway/portal/machine-http";
import { PortalBusinessService } from "../../../services/access-gateway/portal/business/service";
import { createBusinessAccessFixture } from "../../../services/access-gateway/portal/business-access/fixture";
import { createBusinessMachineHttpHandler } from "../../../services/access-gateway/portal/business-access/http";
import { startPortalServer } from "../../../services/access-gateway/portal/server";

const directory = await mkdtemp(join(tmpdir(), "portal-business-browser-"));
let sourceCalls = 0;
let sourceContractValid = true;
let closed = false;

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("fixture_source_address_unavailable"));
      resolveListen(address.port);
    });
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > 16 * 1024) throw new Error("fixture_source_body_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const sourceServer = createServer((request, response) => {
  void (async () => {
    if (request.method !== "POST" || request.url !== "/fixture/customs/query" || request.headers.cookie || request.headers.authorization) {
      sourceContractValid = false;
      response.statusCode = 403;
      response.end();
      return;
    }
    const raw = await readJson(request);
    const valid = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      && Object.keys(raw).sort().join(",") === "input,request_id,schema_version"
      && (raw as Record<string, unknown>).schema_version === "fixture-customs-source@2026-09-05.v1"
      && typeof (raw as Record<string, unknown>).request_id === "string"
      && typeof (raw as Record<string, unknown>).input === "object"
      && (raw as { input: Record<string, unknown> }).input.query === "不锈钢水杯"
      && (raw as { input: Record<string, unknown> }).input.ruleDate === "2026-09-05"
      && Object.keys((raw as { input: Record<string, unknown> }).input).sort().join(",") === "attributes,query,ruleDate"
      && typeof (raw as { input: Record<string, unknown> }).input.attributes === "object"
      && (raw as { input: { attributes: Record<string, unknown> } }).input.attributes.originCountry === "CN"
      && Object.keys((raw as { input: { attributes: Record<string, unknown> } }).input.attributes).join(",") === "originCountry";
    sourceContractValid &&= valid;
    sourceCalls += 1;
    response.statusCode = 503;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ status: "unavailable", reason_code: "fixture_source_503" }));
  })().catch(() => {
    sourceContractValid = false;
    if (!response.headersSent) response.statusCode = 503;
    response.end();
  });
});

const sourcePort = await listen(sourceServer);
const sourceOrigin = `http://127.0.0.1:${sourcePort}`;
const portalRuntime = await createPortalFixtureRuntime({ databaseDirectory: join(directory, "portal") });

const customsClient = Object.freeze({
  async query(request: { input: unknown; actor: { type: "user" | "service"; id: string }; requestId: string }) {
    let reasonCode = "fixture_source_unavailable";
    try {
      const response = await fetch(`${sourceOrigin}/fixture/customs/query`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
        body: JSON.stringify({ schema_version: "fixture-customs-source@2026-09-05.v1", request_id: request.requestId, input: request.input }),
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 503) {
        const body = await response.json() as { reason_code?: unknown };
        if (body.reason_code === "fixture_source_503") reasonCode = body.reason_code;
      }
    } catch {
      reasonCode = "fixture_source_disconnected";
    }
    return Object.freeze({ schema_version: "portal-customs@2026-09-05.v1" as const, status: "unavailable" as const, data: null, reason_codes: Object.freeze([reasonCode]) });
  },
});

const quoteClient = Object.freeze({
  preview(request: { requestId: string }) {
    return Promise.resolve(Object.freeze({ schema_version: "portal-quote@2026-09-05.v1" as const, status: "unavailable" as const, data: null, reason_codes: Object.freeze(["fixture_quote_source_unavailable"]), request_id: request.requestId, source_schema_version: "fixture-quote-source@2026-09-05.v1", preview_only: true as const, saved: false as const, sendable: false as const, source_refs: Object.freeze([]) }));
  },
  extract(request: { requestId: string }) {
    return Promise.resolve(Object.freeze({ schema_version: "portal-quote@2026-09-05.v1" as const, status: "unavailable" as const, data: null, reason_codes: Object.freeze(["fixture_quote_source_unavailable"]), request_id: request.requestId, source_schema_version: "fixture-quote-source@2026-09-05.v1", preview_only: true as const, saved: false as const, sendable: false as const, source_refs: Object.freeze([]) }));
  },
});

const businessService = new PortalBusinessService({
  portalService: portalRuntime.service,
  connections: [{
    organizationId: "org_fixture",
    tenantId: "tenant_fixture",
    enabledOperations: ["customs.query", "quote.zone_preview"],
    customsClient,
    quoteClient,
    serviceActors: { customs: "fixture-customs-service", quote: "fixture-quote-service" },
  }],
});
const businessFixture = await createBusinessAccessFixture({
  databasePath: join(directory, "business-access.sqlite"),
  portalService: portalRuntime.service,
  operationAuthority: { isAvailable: (tenantId, operation) => businessService.isAvailable(tenantId, operation) },
  tenantClientAuthority: { requireActive: (tenantId, clientId) => portalRuntime.requireActiveTenantClient(tenantId, clientId) },
  credentialPepper: randomBytes(32),
});

const allowedHosts = ["fixture.invalid"];
const allowedOrigins: string[] = [];
const businessMachineHandler = createBusinessMachineHttpHandler({
  mode: "fixtures",
  service: businessFixture.service,
  executor: { execute: (request) => businessService.executeMachine(request) },
  allowedHosts,
  allowedOrigins,
  trustedProxyAddresses: [],
});
const machineHandler = createPortalMachineHttpHandler({
  mode: "fixtures",
  bridge: portalRuntime.bridge,
  allowedHosts,
  allowedOrigins,
});
const portal = await startPortalServer({
  mode: "fixtures",
  host: "127.0.0.1",
  port: 0,
  staticDirectory: resolve("apps/console"),
  service: portalRuntime.service,
  bridge: portalRuntime.bridge,
  organizationBridge: portalRuntime.organizationBridge,
  businessService,
  businessAccessService: businessFixture.service,
  businessMachineHandler,
  machineHandler,
  repositoryKind: "synthetic",
});
allowedHosts.splice(0, allowedHosts.length, new URL(portal.origin).host);
allowedOrigins.splice(0, allowedOrigins.length, portal.origin);

async function shutdown(exitCode = 0): Promise<void> {
  if (closed) return;
  closed = true;
  await portal.close();
  await new Promise<void>((resolveClose, reject) => sourceServer.close((error) => error ? reject(error) : resolveClose()));
  businessFixture.repository.close();
  await portalRuntime.close();
  await rm(directory, { recursive: true, force: true });
  const valid = sourceCalls === 1 && sourceContractValid;
  process.stdout.write(`${JSON.stringify({ closed: true, source_calls: sourceCalls, source_contract_valid: sourceContractValid })}\n`);
  process.exitCode = exitCode || (valid ? 0 : 1);
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
process.stdout.write(`${JSON.stringify({ ready: true, base_url: portal.origin, source_origin: sourceOrigin })}\n`);
