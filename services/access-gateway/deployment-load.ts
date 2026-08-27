import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  TENANT_ACCESS_SCHEMA_VERSION,
  TenantAccessService,
} from "../../src/logistics_mcp/control-plane/tenant-access-service";
import { TENANT_API_KEY_TOOL_NAMES } from "../../src/logistics_mcp/control-plane/tenant-access-contracts";
import { SqliteTenantAccessStore } from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { FileSecretPepperProvider } from "./production-crypto";

const CONFIRMATION = "run-synthetic-load";
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_STEP_MS = 400;
const READINESS_INTERVAL_MS = 30_000;
const RENEWAL_SAFETY_SECONDS = 60;

type JsonRecord = Readonly<Record<string, unknown>>;

export interface LatencySummary {
  readonly count: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  readonly max_ms: number;
}

export interface DeploymentLoadSummary {
  readonly status: "success" | "manual_review";
  readonly base_url: string;
  readonly run_id: string;
  readonly concurrency: number;
  readonly target_duration_seconds: number;
  readonly actual_duration_seconds: number;
  readonly request_interval_ms: number;
  readonly calls: LatencySummary;
  readonly envelope_statuses: Readonly<Record<string, number>>;
  readonly transport_errors: number;
  readonly authentication_rejections: number;
  readonly audit_failures: number;
  readonly token_renewals: number;
  readonly readiness_samples: number;
  readonly readiness_failures: number;
  readonly cleanup: Readonly<{
    credential: "revoked";
    tenant: "suspended";
  }>;
}

interface ManagedClient {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
}

interface ExchangeResult {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly issuedAtMs: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function nearestRank(values: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * values.length) - 1);
  return values[index] ?? values[values.length - 1]!;
}

export function summarizeLatency(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) throw new Error("Latency samples are empty.");
  if (samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Latency samples are invalid.");
  }
  const ordered = [...samples].sort((left, right) => left - right);
  return Object.freeze({
    count: ordered.length,
    p50_ms: rounded(nearestRank(ordered, 0.5)),
    p95_ms: rounded(nearestRank(ordered, 0.95)),
    p99_ms: rounded(nearestRank(ordered, 0.99)),
    max_ms: rounded(ordered[ordered.length - 1]!),
  });
}

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the allowed range.`);
  }
  return value;
}

function baseUrlFromEnvironment(): URL {
  const parsed = new URL(requiredSetting("DEPLOYMENT_LOAD_BASE_URL"));
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("DEPLOYMENT_LOAD_BASE_URL must be an HTTPS origin.");
  }
  return new URL(`${parsed.origin}/`);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as JsonRecord;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

async function delayUntil(timestamp: number): Promise<void> {
  await delay(timestamp - Date.now());
}

async function exchange(baseUrl: URL, apiKey: string, runId: string, sequence: number): Promise<ExchangeResult> {
  const response = await fetch(new URL("access/v1/token/exchange", baseUrl), {
    method: "POST",
    headers: {
      authorization: `ApiKey ${apiKey}`,
      "content-type": "application/json",
      origin: baseUrl.origin,
      "x-request-id": `req_load_${runId}_${sequence}`,
    },
    body: JSON.stringify({
      schema_version: "2026-08-27.v1",
      requested_tool_names: TENANT_API_KEY_TOOL_NAMES,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = asRecord(await response.json(), "Token exchange response");
  if (response.status !== 200 || payload.status !== "success") {
    throw new Error("Token exchange failed.");
  }
  const data = asRecord(payload.data, "Token exchange data");
  const accessToken = data.access_token;
  const expiresIn = data.expires_in;
  if (
    typeof accessToken !== "string" ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(accessToken) ||
    !Number.isSafeInteger(expiresIn) ||
    (expiresIn as number) < 60 ||
    (expiresIn as number) > 900
  ) {
    throw new Error("Token exchange payload is invalid.");
  }
  return Object.freeze({ accessToken, expiresIn: expiresIn as number, issuedAtMs: Date.now() });
}

async function openClient(baseUrl: URL, accessToken: string, name: string): Promise<ManagedClient> {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("mcp", baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  try {
    await client.connect(transport as Transport);
    if (transport.sessionId === undefined || transport.sessionId.length === 0) {
      throw new Error("MCP session was not created.");
    }
    return Object.freeze({ client, transport });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function closeClients(clients: readonly ManagedClient[]): Promise<void> {
  for (const managed of clients) {
    await managed.client.close().catch(() => undefined);
    await delay(SESSION_STEP_MS);
  }
}

function statusFromToolResult(result: unknown): string {
  const structured = asRecord(asRecord(result, "Tool result").structuredContent, "Tool envelope");
  const status = structured.status;
  if (typeof status !== "string" || status.length === 0) throw new Error("Tool status is invalid.");
  return status;
}

function isAuthenticationFailure(error: unknown): boolean {
  return /(?:\b401\b|authentication)/iu.test(error instanceof Error ? error.message : String(error));
}

async function readinessSample(baseUrl: URL): Promise<boolean> {
  try {
    const [gateway, runtime] = await Promise.all([
      fetch(new URL("access/v1/readyz", baseUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      fetch(new URL("runtime/readyz", baseUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    ]);
    const gatewayBody: unknown = await gateway.json();
    const runtimeBody: unknown = await runtime.json();
    return gateway.status === 200 && runtime.status === 200 &&
      asRecord(gatewayBody, "Gateway readiness").status === "manual_review" &&
      asRecord(runtimeBody, "Runtime readiness").status === "ready";
  } catch {
    return false;
  }
}

async function runLoad(input: Readonly<{
  baseUrl: URL;
  apiKey: string;
  runId: string;
  concurrency: number;
  durationSeconds: number;
  requestIntervalMs: number;
}>): Promise<Omit<DeploymentLoadSummary, "status" | "base_url" | "run_id" | "cleanup">> {
  let exchangeSequence = 1;
  let token = await exchange(input.baseUrl, input.apiKey, input.runId, exchangeSequence);
  const clients: ManagedClient[] = [];
  try {
    for (let index = 0; index < input.concurrency; index += 1) {
      clients.push(await openClient(
        input.baseUrl,
        token.accessToken,
        `t0-load-${input.runId}-${index}`,
      ));
      await delay(SESSION_STEP_MS);
    }

    const startedAt = Date.now();
    const deadline = startedAt + input.durationSeconds * 1_000;
    const latencies: number[] = [];
    const statuses: Record<string, number> = Object.create(null) as Record<string, number>;
    let transportErrors = 0;
    let authenticationRejections = 0;
    let readinessSamples = 0;
    let readinessFailures = 0;
    let tokenRenewals = 0;
    let paused = false;
    let activeCalls = 0;
    let resumeGeneration = 0;

    const workers = clients.map((_, index) => (async () => {
      let observedGeneration = 0;
      await delay(Math.floor((input.requestIntervalMs * index) / input.concurrency));
      while (Date.now() < deadline) {
        while (paused && Date.now() < deadline) await delay(25);
        if (Date.now() >= deadline) break;
        if (observedGeneration !== resumeGeneration) {
          observedGeneration = resumeGeneration;
          await delay(Math.floor((input.requestIntervalMs * index) / input.concurrency));
          if (Date.now() >= deadline) break;
        }
        const callStarted = performance.now();
        activeCalls += 1;
        try {
          const result = await clients[index]!.client.callTool({
            name: "system.agent_context.get",
            arguments: { profile_id: "runtime-caller" },
          });
          const status = statusFromToolResult(result);
          statuses[status] = (statuses[status] ?? 0) + 1;
        } catch (error) {
          transportErrors += 1;
          if (isAuthenticationFailure(error)) authenticationRejections += 1;
        } finally {
          activeCalls -= 1;
          latencies.push(performance.now() - callStarted);
        }
        await delay(input.requestIntervalMs - (performance.now() - callStarted));
      }
    })());

    const readiness = (async () => {
      let nextSample = startedAt;
      while (nextSample < deadline) {
        await delayUntil(nextSample);
        readinessSamples += 1;
        if (!(await readinessSample(input.baseUrl))) readinessFailures += 1;
        nextSample += READINESS_INTERVAL_MS;
      }
    })();

    const renewals = (async () => {
      let nextRenewal = token.issuedAtMs + Math.max(
        60_000,
        (token.expiresIn - RENEWAL_SAFETY_SECONDS) * 1_000,
      );
      while (nextRenewal < deadline) {
        await delayUntil(nextRenewal);
        if (Date.now() >= deadline) break;
        paused = true;
        while (activeCalls > 0) await delay(10);
        exchangeSequence += 1;
        token = await exchange(input.baseUrl, input.apiKey, input.runId, exchangeSequence);
        for (let index = 0; index < clients.length; index += 1) {
          const replacement = await openClient(
            input.baseUrl,
            token.accessToken,
            `t0-load-${input.runId}-${index}-renew-${exchangeSequence}`,
          );
          const previous = clients[index]!;
          clients[index] = replacement;
          await previous.client.close();
          await delay(SESSION_STEP_MS);
        }
        tokenRenewals += 1;
        resumeGeneration += 1;
        paused = false;
        nextRenewal = token.issuedAtMs + Math.max(
          60_000,
          (token.expiresIn - RENEWAL_SAFETY_SECONDS) * 1_000,
        );
      }
    })();

    await Promise.all([...workers, readiness, renewals]);
    const actualDurationSeconds = rounded((Date.now() - startedAt) / 1_000);
    const calls = summarizeLatency(latencies);
    const auditFailures = transportErrors;
    return Object.freeze({
      concurrency: input.concurrency,
      target_duration_seconds: input.durationSeconds,
      actual_duration_seconds: actualDurationSeconds,
      request_interval_ms: input.requestIntervalMs,
      calls,
      envelope_statuses: Object.freeze({ ...statuses }),
      transport_errors: transportErrors,
      authentication_rejections: authenticationRejections,
      audit_failures: auditFailures,
      token_renewals: tokenRenewals,
      readiness_samples: readinessSamples,
      readiness_failures: readinessFailures,
    });
  } finally {
    await closeClients(clients);
  }
}

export async function runT0DeploymentLoad(): Promise<DeploymentLoadSummary> {
  if (requiredSetting("DEPLOYMENT_LOAD_CONFIRM") !== CONFIRMATION) {
    throw new Error(`DEPLOYMENT_LOAD_CONFIRM must equal ${CONFIRMATION}.`);
  }
  const baseUrl = baseUrlFromEnvironment();
  const concurrency = integerSetting("DEPLOYMENT_LOAD_CONCURRENCY", 50, 1, 100);
  const durationSeconds = integerSetting("DEPLOYMENT_LOAD_DURATION_SECONDS", 600, 60, 900);
  const requestIntervalMs = integerSetting("DEPLOYMENT_LOAD_REQUEST_INTERVAL_MS", 7_000, 1_000, 60_000);
  const applicationRoot = requiredSetting("ACCESS_GATEWAY_APPLICATION_ROOT");
  const instanceId = requiredSetting("ACCESS_GATEWAY_INSTANCE_ID");
  const managementTenantId = requiredSetting("ACCESS_GATEWAY_MANAGEMENT_TENANT_ID");
  const pepperVersion = requiredSetting("ACCESS_GATEWAY_PEPPER_VERSION");
  const pepperPath = process.env.ACCESS_GATEWAY_PEPPER_PATH?.trim() ||
    join(applicationRoot, ".secrets", "credential-pepper.bin");
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const tenantId = `tenant_load_${runId}`;
  const admin = parseExecutionContext({
    tenant_id: managementTenantId,
    actor_id: "deployment_load_operator",
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin", "tenant:admin"],
    client_id: "deployment_load_cli",
    session_id: `deployment_load_${runId}`,
    expires_at: Math.floor(Date.now() / 1_000) + durationSeconds + 1_800,
  });
  const store = new SqliteTenantAccessStore({ applicationRoot, instanceId, managementTenantId });
  const pepper = new FileSecretPepperProvider({ pepperPath, pepperVersion });
  const service = new TenantAccessService(store, {
    credentialSecretProvider: {
      hash: (secret, salt) => pepper.hashCredentialSecret({
        secret,
        salt,
        pepperVersion: pepper.pepperVersion,
      }),
      verify: (secret, salt, expectedHash) => pepper.verifyCredentialSecret({
        secret,
        material: { salt, expectedHash, pepperVersion: pepper.pepperVersion },
      }),
    },
  });
  let tenantCreated = false;
  let credential: { id: string; apiKey: string; revoked: boolean } | null = null;
  let loadResult: Omit<DeploymentLoadSummary, "status" | "base_url" | "run_id" | "cleanup"> | null = null;
  let runFailure: unknown = null;
  let cleanupFailure: unknown = null;

  try {
    await service.createTenant(admin, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: tenantId,
      display_name: "T0 负载验收（自动停用）",
    }, `load:${runId}:tenant:create`);
    tenantCreated = true;
    const issued = await service.issueCredential(admin, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: tenantId,
      client_id: "deployment_load_client",
      label: "T0 负载验收 Key",
      tool_names: TENANT_API_KEY_TOOL_NAMES,
      expires_in_seconds: Math.min(2_400, durationSeconds + 1_200),
    }, `load:${runId}:credential:issue`);
    if (issued.data.api_key === null) throw new Error("Deployment load API key was withheld.");
    credential = {
      id: issued.data.credential.credential_id,
      apiKey: issued.data.api_key,
      revoked: false,
    };
    await service.acknowledgeCredentialDelivery(admin, credential.id, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "deployment_load_secure_memory",
    }, `load:${runId}:credential:ack`);
    loadResult = await runLoad({
      baseUrl,
      apiKey: credential.apiKey,
      runId,
      concurrency,
      durationSeconds,
      requestIntervalMs,
    });
  } catch (error) {
    runFailure = error;
  } finally {
    if (credential !== null && !credential.revoked) {
      try {
        await service.revokeCredential(admin, credential.id, {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          reason_code: "deployment_load_cleanup",
        }, `load:${runId}:credential:revoke`);
        credential.revoked = true;
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (tenantCreated) {
      try {
        const state = await service.getState(admin);
        if (state.data.tenants.find(({ tenant_id }) => tenant_id === tenantId)?.status === "active") {
          await service.setTenantStatus(admin, tenantId, {
            schema_version: TENANT_ACCESS_SCHEMA_VERSION,
            status: "suspended",
            reason_code: "deployment_load_cleanup",
          }, `load:${runId}:tenant:suspend`);
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
  if (cleanupFailure !== null) throw new Error("Deployment load cleanup failed.");
  if (runFailure instanceof Error) throw runFailure;
  if (runFailure !== null) throw new Error("Deployment load failed.");
  if (loadResult === null) throw new Error("Deployment load did not produce a result.");
  const successful = loadResult.transport_errors === 0 &&
    loadResult.authentication_rejections === 0 &&
    loadResult.audit_failures === 0 &&
    loadResult.readiness_failures === 0 &&
    Object.keys(loadResult.envelope_statuses).length === 1 &&
    loadResult.envelope_statuses.success === loadResult.calls.count;
  return Object.freeze({
    status: successful ? "success" : "manual_review",
    base_url: baseUrl.origin,
    run_id: runId,
    ...loadResult,
    cleanup: Object.freeze({ credential: "revoked", tenant: "suspended" }),
  });
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
  void runT0DeploymentLoad().then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.status !== "success") process.exitCode = 1;
  }).catch(() => {
    process.stderr.write("T0 deployment load failed; no credential material was emitted.\n");
    process.exitCode = 1;
  });
}
