import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  SqliteTenantAccessStore,
} from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import {
  TENANT_ACCESS_SCHEMA_VERSION,
  TenantAccessService,
} from "../../src/logistics_mcp/control-plane/tenant-access-service";
import { TENANT_API_KEY_TOOL_NAMES } from "../../src/logistics_mcp/control-plane/tenant-access-contracts";
import { FileSecretPepperProvider } from "./production-crypto";
import { assertCandidateSyntheticWriteTarget } from "./deployment-safety";

const CONFIRMATION = "run-synthetic-write";
const EXPECTED_RESOURCES = Object.freeze([
  "logistics://agent/bootstrap",
  "logistics://agent/profiles",
  "logistics://contracts/envelope/current",
  "logistics://modules/catalog",
  "logistics://standards/index",
] as const);
const REQUEST_TIMEOUT_MS = 15_000;

type JsonRecord = Readonly<Record<string, unknown>>;

export interface DeploymentSmokeSummary {
  readonly status: "success";
  readonly base_url: string;
  readonly run_id: string;
  readonly tools: readonly string[];
  readonly resources: readonly string[];
  readonly deterministic_call_status: "success";
  readonly tenant_isolation_http_status: 403;
  readonly revoked_exchange_http_status: 401;
  readonly gateway_audit_count: number;
  readonly cleanup: Readonly<{
    credentials: "revoked";
    tenants: "suspended";
  }>;
}

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, field: string, label: string): string {
  const selected = value[field];
  if (typeof selected !== "string" || selected.length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return selected;
}

function positiveIntegerField(value: JsonRecord, field: string, label: string): number {
  const selected = value[field];
  if (!Number.isSafeInteger(selected) || (selected as number) < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return selected as number;
}

function baseUrlFromEnvironment(): URL {
  const parsed = new URL(requiredSetting("DEPLOYMENT_SMOKE_BASE_URL"));
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("DEPLOYMENT_SMOKE_BASE_URL must be an HTTPS origin.");
  }
  return new URL(`${parsed.origin}/`);
}

async function jsonResponse(response: Response, label: string): Promise<JsonRecord> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new Error(`${label} did not return JSON.`);
  }
  return asRecord(await response.json(), label);
}

async function exchange(
  baseUrl: URL,
  apiKey: string,
  runId: string,
  sequence: string,
): Promise<Readonly<{ status: number; accessToken: string | null }>> {
  const response = await fetch(new URL("access/v1/token/exchange", baseUrl), {
    method: "POST",
    headers: {
      authorization: `ApiKey ${apiKey}`,
      "content-type": "application/json",
      origin: baseUrl.origin,
      "x-request-id": `req_smoke_${runId}_${sequence}`,
    },
    body: JSON.stringify({
      schema_version: "2026-08-27.v1",
      requested_tool_names: TENANT_API_KEY_TOOL_NAMES,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await jsonResponse(response, "token exchange response");
  if (response.status !== 200) return Object.freeze({ status: response.status, accessToken: null });
  if (payload.status !== "success") throw new Error("Token exchange did not succeed.");
  const data = asRecord(payload.data, "token exchange data");
  const accessToken = stringField(data, "access_token", "access token");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(accessToken)) {
    throw new Error("Access token is invalid.");
  }
  return Object.freeze({ status: response.status, accessToken });
}

function sorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...values].sort());
}

function equalStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export interface DeploymentSmokeToolCaller {
  callTool(request: Readonly<{
    name: string;
    arguments: Record<string, unknown>;
  }>): Promise<unknown>;
}

function cargoSmokeInput(): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "cargo.calculate@deployment-smoke-v1",
    cargo_lines: [{
      version: "cargo-line@deployment-smoke-v1",
      line_id: "line_deployment_smoke_1",
      description: "synthetic carton",
      quantity: 2,
      quantity_unit: "carton",
      package_type: "carton",
      unit_weight: { value: "12.5", unit: "kg" },
      dimensions: [{
        length: { value: "60", unit: "cm" },
        width: { value: "50", unit: "cm" },
        height: { value: "40", unit: "cm" },
        quantity: 2,
      }],
      stackable: true,
      fragile: false,
      sensitive: false,
      source_ref_ids: ["src_deployment_smoke_input_1"],
    }],
    dimensional_divisor: null,
    bubble_rule: {
      channel: "CAQ-HP",
      mode: "full",
      ratio: null,
      rule_version: "CAQ-HP@deployment-smoke-v1",
      source_ref_ids: ["src_deployment_smoke_rule_1"],
      density: { value: "1000", unit: "kg_per_cbm" },
      unit: "kg",
      rounding: { mode: "none", decimals: 6 },
    },
    channel_code: "CAQ-HP",
    source_refs: [
      {
        source_id: "src_deployment_smoke_input_1",
        source_type: "fixture",
        system: "deployment-smoke",
        locator: "fixture://deployment-smoke/cargo/input",
        version: "deployment-smoke-v1",
        retrieved_at: "2026-08-27T00:00:00Z",
        authority: "user_provided",
        content_hash: "sha256:deploymentsmokecargoinput01",
      },
      {
        source_id: "src_deployment_smoke_rule_1",
        source_type: "fixture",
        system: "deployment-smoke",
        locator: "fixture://deployment-smoke/cargo/rule",
        version: "CAQ-HP@deployment-smoke-v1",
        retrieved_at: "2026-08-27T00:00:00Z",
        authority: "authoritative",
        content_hash: "sha256:deploymentsmokecargorule01",
      },
    ],
  };
}

function containerSmokeInput(): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "container-profile@deployment-smoke-v1",
    plan_id: "plan_deployment_smoke_1",
    container_type: "40HQ",
    physical_capacity: { value: "76", unit: "cbm" },
    operational_target: { value: "75", unit: "cbm" },
    max_payload: { value: "26000", unit: "kg" },
    source_ref_ids: ["src:container:deployment-smoke"],
    cargo_metrics: {
      version: "cargo-metrics@deployment-smoke-v1",
      line_count: 1,
      total_quantity: 2,
      total_volume: { value: "60", unit: "cbm" },
      actual_weight: { value: "18000", unit: "kg" },
      volumetric_weight: { value: "60000", unit: "kg" },
      weight_evidence: "line_total_weight",
      derived_from_line_ids: ["line_deployment_smoke_1"],
    },
    loading_constraints: {
      sensitive_at_head: true,
      declaration_at_tail: true,
      fifo_for_other: true,
      customer_priority: null,
    },
    loading_lines: [{
      line_id: "line_deployment_smoke_1",
      sensitive: false,
      customer_priority: null,
      declaration_required: false,
    }],
  };
}

export async function runDeterministicSmokeCalls(
  caller: DeploymentSmokeToolCaller,
): Promise<readonly ["cargo.calculate", "container.plan_summary"]> {
  const calls = Object.freeze([
    Object.freeze({ name: "cargo.calculate" as const, arguments: cargoSmokeInput() }),
    Object.freeze({ name: "container.plan_summary" as const, arguments: containerSmokeInput() }),
  ] as const);
  for (const call of calls) {
    const result = asRecord(await caller.callTool(call), `${call.name} call result`);
    const payload = asRecord(result.structuredContent, `${call.name} result`);
    if (payload.status !== "success") {
      throw new Error(`${call.name} deployment smoke did not succeed.`);
    }
  }
  return Object.freeze(["cargo.calculate", "container.plan_summary"] as const);
}

async function tenantIsolationStatus(
  baseUrl: URL,
  accessToken: string,
  sessionId: string,
): Promise<number> {
  const response = await fetch(new URL("mcp", baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/list", params: {} }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.arrayBuffer();
  return response.status;
}

async function gatewayAuditCount(baseUrl: URL): Promise<number> {
  const response = await fetch(new URL("access/v1/readyz", baseUrl), {
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error("Access Gateway readiness failed.");
  const payload = await jsonResponse(response, "Access Gateway readiness response");
  const data = asRecord(payload.data, "Access Gateway readiness data");
  return positiveIntegerField(data, "audit_count", "Access Gateway audit count");
}

export async function runT0DeploymentSmoke(): Promise<DeploymentSmokeSummary> {
  if (requiredSetting("DEPLOYMENT_SMOKE_CONFIRM") !== CONFIRMATION) {
    throw new Error(`DEPLOYMENT_SMOKE_CONFIRM must equal ${CONFIRMATION}.`);
  }
  if (requiredSetting("DEPLOYMENT_SMOKE_ENVIRONMENT") !== "staging") {
    throw new Error("DEPLOYMENT_SMOKE_ENVIRONMENT must equal staging.");
  }
  if (requiredSetting("ACCESS_GATEWAY_PROFILE") !== "single-node-candidate") {
    throw new Error("Deployment smoke requires the single-node-candidate profile.");
  }
  const baseUrl = baseUrlFromEnvironment();
  await assertCandidateSyntheticWriteTarget({ baseUrl });
  const applicationRoot = requiredSetting("ACCESS_GATEWAY_APPLICATION_ROOT");
  const instanceId = requiredSetting("ACCESS_GATEWAY_INSTANCE_ID");
  const managementTenantId = requiredSetting("ACCESS_GATEWAY_MANAGEMENT_TENANT_ID");
  const pepperVersion = requiredSetting("ACCESS_GATEWAY_PEPPER_VERSION");
  const pepperPath = process.env.ACCESS_GATEWAY_PEPPER_PATH?.trim() ||
    join(applicationRoot, ".secrets", "credential-pepper.bin");
  const pepperHistoryPath = process.env.ACCESS_GATEWAY_PEPPER_HISTORY_PATH?.trim() ||
    join(applicationRoot, ".secrets", "credential-pepper-history.json");
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const tenantIds = Object.freeze([
    `tenant_smoke_a_${runId}`,
    `tenant_smoke_b_${runId}`,
  ] as const);
  const admin = parseExecutionContext({
    tenant_id: managementTenantId,
    actor_id: "deployment_smoke_operator",
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin", "tenant:admin"],
    client_id: "deployment_smoke_cli",
    session_id: `deployment_smoke_${runId}`,
    expires_at: Math.floor(Date.now() / 1_000) + 1_800,
  });
  const pepper = new FileSecretPepperProvider({
    pepperPath,
    pepperVersion,
    historyPath: pepperHistoryPath,
  });
  const store = new SqliteTenantAccessStore({
    applicationRoot,
    instanceId,
    managementTenantId,
  });
  const service = new TenantAccessService(store, {
    credentialSecretProvider: {
      pepperVersion: pepper.pepperVersion,
      hash: (secret, salt) => pepper.hashCredentialSecret({
        secret,
        salt,
        pepperVersion: pepper.pepperVersion,
      }),
      verify: (secret, salt, expectedHash, storedPepperVersion) => pepper.verifyCredentialSecret({
        secret,
        material: { salt, expectedHash, pepperVersion: storedPepperVersion },
      }),
    },
  });
  const createdTenants: string[] = [];
  const credentials: Array<{ id: string; apiKey: string; revoked: boolean }> = [];
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  let completed = false;
  let cleanupFailure: unknown = null;
  let runFailure: unknown = null;
  let summary: DeploymentSmokeSummary | null = null;

  try {
    for (const [index, tenantId] of tenantIds.entries()) {
      const marker = index === 0 ? "a" : "b";
      await service.createTenant(admin, {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tenant_id: tenantId,
        display_name: `T0 部署验收 ${marker.toUpperCase()}（自动停用）`,
      }, `smoke:${runId}:tenant:${marker}:create`);
      createdTenants.push(tenantId);
      const issued = await service.issueCredential(admin, {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tenant_id: tenantId,
        client_id: `deployment_smoke_${marker}`,
        label: `T0 部署验收 Key ${marker.toUpperCase()}`,
        tool_names: TENANT_API_KEY_TOOL_NAMES,
        expires_in_seconds: 900,
      }, `smoke:${runId}:credential:${marker}:issue`);
      const apiKey = issued.data.api_key;
      if (apiKey === null) throw new Error("Deployment smoke API key was withheld.");
      const credentialId = issued.data.credential.credential_id;
      credentials.push({ id: credentialId, apiKey, revoked: false });
      await service.acknowledgeCredentialDelivery(admin, credentialId, {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        reason_code: "deployment_smoke_secure_memory",
      }, `smoke:${runId}:credential:${marker}:ack`);
    }

    const first = credentials[0];
    const second = credentials[1];
    if (first === undefined || second === undefined) throw new Error("Smoke credentials are missing.");
    const firstExchange = await exchange(baseUrl, first.apiKey, runId, "a");
    const secondExchange = await exchange(baseUrl, second.apiKey, runId, "b");
    if (firstExchange.status !== 200 || firstExchange.accessToken === null) {
      throw new Error("First token exchange failed.");
    }
    if (secondExchange.status !== 200 || secondExchange.accessToken === null) {
      throw new Error("Second token exchange failed.");
    }

    client = new Client({ name: "t0-public-deployment-smoke", version: "1.0.0" });
    transport = new StreamableHTTPClientTransport(new URL("mcp", baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${firstExchange.accessToken}` } },
    });
    await client.connect(transport as Transport);
    const sessionId = transport.sessionId;
    if (sessionId === undefined || sessionId.length === 0) {
      throw new Error("MCP session was not created.");
    }
    const tools = sorted((await client.listTools()).tools.map(({ name }) => name));
    const expectedTools = sorted(TENANT_API_KEY_TOOL_NAMES);
    if (!equalStrings(tools, expectedTools)) throw new Error("T0 tool catalog drifted.");
    const resources = sorted((await client.listResources()).resources.map(({ uri }) => uri));
    const expectedResources = sorted(EXPECTED_RESOURCES);
    if (!equalStrings(resources, expectedResources)) throw new Error("Agent resource catalog drifted.");
    const context = await client.callTool({
      name: "system.agent_context.get",
      arguments: { profile_id: "runtime-caller" },
    });
    const contextPayload = asRecord(context.structuredContent, "Agent context result");
    if (contextPayload.status !== "success") throw new Error("Agent context call did not succeed.");
    const deterministicTools = await runDeterministicSmokeCalls(client);
    const deterministicCallStatus = deterministicTools.length === 2 ? "success" as const : null;
    if (deterministicCallStatus === null) {
      throw new Error("Deterministic deployment smoke calls are incomplete.");
    }

    const isolationStatus = await tenantIsolationStatus(
      baseUrl,
      secondExchange.accessToken,
      sessionId,
    );
    if (isolationStatus !== 403) throw new Error("Cross-tenant MCP session was not rejected.");
    await transport.terminateSession();
    await client.close();
    client = undefined;
    transport = undefined;

    await service.revokeCredential(admin, first.id, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "deployment_smoke_cleanup",
    }, `smoke:${runId}:credential:a:revoke`);
    first.revoked = true;
    const revokedExchange = await exchange(baseUrl, first.apiKey, runId, "revoked");
    if (revokedExchange.status !== 401 || revokedExchange.accessToken !== null) {
      throw new Error("Revoked API key was not rejected.");
    }
    await service.revokeCredential(admin, second.id, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "deployment_smoke_cleanup",
    }, `smoke:${runId}:credential:b:revoke`);
    second.revoked = true;
    for (const [index, tenantId] of tenantIds.entries()) {
      const marker = index === 0 ? "a" : "b";
      await service.setTenantStatus(admin, tenantId, {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "suspended",
        reason_code: "deployment_smoke_cleanup",
      }, `smoke:${runId}:tenant:${marker}:suspend`);
    }
    const state = await service.getState(admin);
    const smokeTenants = state.data.tenants.filter(({ tenant_id }) => tenantIds.includes(
      tenant_id as (typeof tenantIds)[number],
    ));
    const smokeCredentials = state.data.credentials.filter(({ credential_id }) => (
      credentials.some(({ id }) => id === credential_id)
    ));
    if (
      smokeTenants.length !== 2 ||
      smokeTenants.some(({ status }) => status !== "suspended") ||
      smokeCredentials.length !== 2 ||
      smokeCredentials.some(({ status }) => status !== "revoked")
    ) {
      throw new Error("Deployment smoke cleanup readback failed.");
    }
    const auditCount = await gatewayAuditCount(baseUrl);
    if (auditCount < 3) throw new Error("Access Gateway audit evidence is incomplete.");
    completed = true;
    summary = Object.freeze({
      status: "success",
      base_url: baseUrl.origin,
      run_id: runId,
      tools,
      resources,
      deterministic_call_status: deterministicCallStatus,
      tenant_isolation_http_status: 403,
      revoked_exchange_http_status: 401,
      gateway_audit_count: auditCount,
      cleanup: Object.freeze({ credentials: "revoked", tenants: "suspended" }),
    });
  } catch (error) {
    runFailure = error;
  } finally {
    if (transport?.sessionId !== undefined) {
      try {
        await transport.terminateSession();
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    await client?.close().catch(() => undefined);
    for (const [index, credential] of credentials.entries()) {
      if (credential.revoked) continue;
      const marker = index === 0 ? "a" : "b";
      try {
        await service.revokeCredential(admin, credential.id, {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          reason_code: "deployment_smoke_cleanup",
        }, `smoke:${runId}:credential:${marker}:revoke`);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    for (const [index, tenantId] of createdTenants.entries()) {
      if (completed) break;
      const marker = index === 0 ? "a" : "b";
      try {
        const state = await service.getState(admin);
        if (state.data.tenants.find(({ tenant_id }) => tenant_id === tenantId)?.status === "active") {
          await service.setTenantStatus(admin, tenantId, {
            schema_version: TENANT_ACCESS_SCHEMA_VERSION,
            status: "suspended",
            reason_code: "deployment_smoke_cleanup",
          }, `smoke:${runId}:tenant:${marker}:suspend`);
        }
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    try {
      await store.close();
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (cleanupFailure !== null) throw new Error("Deployment smoke cleanup failed.");
  if (runFailure instanceof Error) throw runFailure;
  if (runFailure !== null) throw new Error("Deployment smoke failed.");
  if (summary === null) throw new Error("Deployment smoke did not produce a result.");
  return summary;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void runT0DeploymentSmoke().then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }).catch(() => {
    process.stderr.write("T0 deployment smoke failed; no credential material was emitted.\n");
    process.exitCode = 1;
  });
}
