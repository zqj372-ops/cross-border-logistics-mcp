import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { createFetchJsonClient, type FetchImplementation } from "../adapters/http-client";
import { SCHEDULE_MCP_TOOLS, type ScheduleMcpTool } from "../platform/application-tools";
import { ENVELOPE_STATUSES, type EnvelopeData, type Notice, type SourceRef } from "../platform/envelope";
import { authorizeTool, getToolPolicy } from "../platform/rbac";
import { ManagedProviderRuntime, signedProviderReleaseSchema, verifyProviderRelease } from "../module-runtime/managed-provider";
import { readBoundedResponse } from "../platform/bounded-response";
import { requireRequestCredential } from "./request-credential";
import type { ToolDefinition } from "./tool-registry";
import {
  ScheduleLiveCarriersEnvelopeSchema,
  ScheduleLiveCarriersDataSchema,
  ScheduleLiveLocationsDataSchema,
  ScheduleLiveLocationsEnvelopeSchema,
  ScheduleLiveLocationsRequestSchema,
  ScheduleLiveSearchEnvelopeSchema,
  ScheduleLiveSearchRequestSchema,
  parseScheduleLiveCarriersEnvelope,
  parseScheduleLiveLocationsEnvelope,
  parseScheduleLiveSearchEnvelope,
} from "../../../services/maritime/schedule-live/contracts";
import { CollectorResultDataSchema } from "../../../services/maritime/schedule-collector/contracts";

const SCHEDULE_PROVIDER_HEALTH_VERSION = "schedule-provider-health@2026-09-18.v1" as const;
const SCHEDULE_PROVIDER_CONTRACT = "ocean-schedule-live@2026-09-18.v1" as const;
const CALL_VERSION = "application-mcp-call@2026-09-06.v1" as const;

const emptyInputSchema = z.object({}).strict();

function scheduleInputSchema(tool: ScheduleMcpTool): z.ZodType {
  if (tool === "maritime.schedule.carriers") return emptyInputSchema;
  if (tool === "maritime.schedule.locations") return ScheduleLiveLocationsRequestSchema;
  return ScheduleLiveSearchRequestSchema;
}

function scheduleOutputSchema(tool: ScheduleMcpTool): z.ZodType {
  if (tool === "maritime.schedule.carriers") return ScheduleLiveCarriersEnvelopeSchema;
  if (tool === "maritime.schedule.locations") return ScheduleLiveLocationsEnvelopeSchema;
  return ScheduleLiveSearchEnvelopeSchema;
}

function parseScheduleEnvelope(tool: ScheduleMcpTool, value: unknown): {
  readonly status: "success" | "needs_input" | "manual_review" | "blocked" | "unavailable";
  readonly data: unknown;
  readonly source_refs: readonly SourceRef[];
  readonly assumptions: readonly Notice[];
  readonly warnings: readonly Notice[];
  readonly blockers: readonly Notice[];
  readonly review_status: "not_required" | "pending" | "approved" | "rejected" | "manual_review";
} {
  if (tool === "maritime.schedule.carriers") return parseScheduleLiveCarriersEnvelope(value) as unknown as ReturnType<typeof parseScheduleEnvelope>;
  if (tool === "maritime.schedule.locations") return parseScheduleLiveLocationsEnvelope(value) as unknown as ReturnType<typeof parseScheduleEnvelope>;
  return parseScheduleLiveSearchEnvelope(value) as unknown as ReturnType<typeof parseScheduleEnvelope>;
}

export function createScheduleRuntimeProvider(options: {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly runtimeSecret: string;
  readonly fetchImpl?: FetchImplementation;
}) {
  if (options.runtimeSecret.length < 32) throw new Error("mcp_provider_secret_invalid");
  const client = createFetchJsonClient({
    enabled: true,
    baseUrl: options.baseUrl,
    allowedHosts: options.allowedHosts,
    timeoutMs: 25_000,
    maxResponseBytes: 2 * 1024 * 1024,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const definitions: readonly ToolDefinition[] = SCHEDULE_MCP_TOOLS.map((operation) => ({
    name: operation,
    title: operation === "maritime.schedule.carriers"
      ? "船期来源目录"
      : operation === "maritime.schedule.locations"
        ? "官方地点解析"
        : "官方船期查询",
    description: "受控船公司船期查询；完整保留分段、覆盖、来源限制和证据引用。",
    inputSchemaId: `urn:logistics-mcp:${operation}:2026-09-18.v1`,
    outputSchemaId: `urn:logistics-mcp:ocean-schedule-live:2026-09-18.v1`,
    permission: getToolPolicy(operation).permission,
    kind: "read",
    riskLevel: "T1",
    moduleId: "maritime.schedule_collector",
    moduleVersion: "1.0.0",
    inputSchema: scheduleInputSchema(operation),
    outputSchema: scheduleOutputSchema(operation),
    statusMapping: ENVELOPE_STATUSES,
    validateOutput(data) {
      const parsed =
        operation === "maritime.schedule.carriers"
          ? ScheduleLiveCarriersDataSchema.safeParse(data)
          : operation === "maritime.schedule.locations"
            ? ScheduleLiveLocationsDataSchema.safeParse(data)
            : CollectorResultDataSchema.safeParse(data);
      if (!parsed.success) throw new Error("schedule_output_invalid");
    },
    async handler(input, context, signal) {
      authorizeTool(context, operation);
      const requestId = `req_${randomUUID().replaceAll("-", "")}`;
      try {
        const result = await client.post(`/access/v2/application/mcp/tools/${operation}`, {
          schema_version: CALL_VERSION,
          request_id: requestId,
          input,
        }, {
          authorization: `Bearer ${requireRequestCredential()}`,
          "x-freightclaw-runtime-token": options.runtimeSecret,
        }, signal);
        const envelope = parseScheduleEnvelope(operation, result);
        if (envelope.status === "success" || envelope.status === "manual_review") {
          return {
            status: envelope.status,
            data: envelope.data as EnvelopeData | null,
            sourceRefs: envelope.source_refs,
            assumptions: envelope.assumptions,
            warnings: envelope.warnings,
            blockers: envelope.blockers,
            reviewStatus: envelope.review_status,
          };
        }
        return {
          status: envelope.status,
          data: null,
          sourceRefs: envelope.source_refs,
          warnings: envelope.warnings,
          blockers: envelope.blockers.length > 0
            ? envelope.blockers
            : [{ code: "schedule_source_unready", message: "船期来源未就绪。", severity: "error" as const }],
          reviewStatus: "not_required" as const,
        };
      } catch {
        return {
          status: "unavailable" as const,
          data: null,
          blockers: [{ code: "schedule_provider_unavailable", message: "船期提供方暂不可用。", severity: "error" as const }],
        };
      }
    },
  }));
  return Object.freeze({ definitions });
}

export function loadScheduleRuntimeProvider(environment: NodeJS.ProcessEnv) {
  const baseUrl = environment.MCP_SCHEDULE_PROVIDER_URL?.trim();
  const host = environment.MCP_SCHEDULE_PROVIDER_ALLOWED_HOST?.trim();
  const secretFile = environment.MCP_SCHEDULE_PROVIDER_SECRET_FILE?.trim();
  if (!baseUrl || !host || !secretFile || !isAbsolute(secretFile)) throw new Error("MCP schedule provider URL, host and secret file are required.");
  const stat = lstatSync(secretFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error("mcp_provider_secret_invalid");
  return createScheduleRuntimeProvider({ baseUrl, allowedHosts: [host], runtimeSecret: readFileSync(secretFile, "utf8").trim() });
}

const digest = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function providerFile(path: string, maximum: number, privateFile = false): Buffer {
  if (!isAbsolute(path)) throw new Error("provider_file_invalid");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || stat.size < 1 || (stat.mode & 0o022) !== 0 || privateFile && (stat.mode & 0o077) !== 0) throw new Error("provider_file_invalid");
  return readFileSync(path);
}

const journalSchema = z.object({
  schema_version: z.literal("provider-activation@2026-09-06.v1"),
  revision: z.number().int().positive(),
  release_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();

async function atomicJournal(path: string, value: z.infer<typeof journalSchema>) {
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error("provider_journal_directory_insecure");
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  const checked = journalSchema.parse(JSON.parse(providerFile(path, 4096, true).toString("utf8")) as unknown);
  if (JSON.stringify(checked) !== JSON.stringify(value)) throw new Error("provider_activation_readback_failed");
}

export async function loadManagedScheduleProvider(environment: NodeJS.ProcessEnv) {
  const required = (name: string) => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const releaseFile = required("MCP_SCHEDULE_RELEASE_FILE");
  const signersFile = required("MCP_SCHEDULE_SIGNERS_FILE");
  const stateFile = required("MCP_SCHEDULE_RELEASE_STATE_PATH");
  if (!isAbsolute(stateFile)) throw new Error("provider_journal_path_invalid");
  const allowedHosts = required("MCP_SCHEDULE_PROVIDER_ALLOWED_HOST").split(",").map((x) => x.trim());
  if (allowedHosts.length > 10 || allowedHosts.some((x) => !x) || new Set(allowedHosts).size !== allowedHosts.length) throw new Error("provider_egress_invalid");
  const runtimeSecret = providerFile(required("MCP_SCHEDULE_PROVIDER_SECRET_FILE"), 4096, true).toString("utf8").trim();
  if (runtimeSecret.length < 32) throw new Error("provider_secret_invalid");
  const keys = () => z.record(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), z.string().max(4096)).parse(JSON.parse(providerFile(signersFile, 32768).toString("utf8")) as unknown);
  const load = () => {
    const release = signedProviderReleaseSchema.parse(JSON.parse(providerFile(releaseFile, 16384).toString("utf8")) as unknown);
    return verifyProviderRelease({
      release,
      artifact: providerFile(resolve(dirname(releaseFile), release.payload.artifact_file), 256 * 1024),
      sbom: providerFile(resolve(dirname(releaseFile), release.payload.sbom_file), 2 * 1024 * 1024),
      trustedKeys: keys(),
      allowedHosts,
    });
  };
  let journal: z.infer<typeof journalSchema> | undefined;
  try {
    journal = journalSchema.parse(JSON.parse(providerFile(stateFile, 4096, true).toString("utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const healthSchema = z.object({
    schema_version: z.literal(SCHEDULE_PROVIDER_HEALTH_VERSION),
    ready: z.literal(true),
    contract_version: z.literal(SCHEDULE_PROVIDER_CONTRACT),
    operations: z.array(z.enum(SCHEDULE_MCP_TOOLS)).length(3),
  }).strict();
  async function probe(baseUrl: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(new URL("/access/v2/application/schedule/provider/health", baseUrl), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { "x-freightclaw-runtime-token": runtimeSecret },
      });
      if (!response.ok) throw new Error("provider_unavailable");
      const body = healthSchema.parse(JSON.parse(Buffer.from(await readBoundedResponse(response, 8192, controller.signal)).toString("utf8")) as unknown);
      if (new Set(body.operations).size !== 3) throw new Error("provider_contract_mismatch");
    } finally {
      clearTimeout(timer);
    }
  }
  let current: ReturnType<typeof load> | undefined;
  let lastError: string | null = null;
  const runtime = new ManagedProviderRuntime({
    prepare: async (release) => {
      if (release.payload.enabled) await probe(release.artifact.base_url);
      return {
        ...createScheduleRuntimeProvider({ baseUrl: release.artifact.base_url, allowedHosts, runtimeSecret }),
        close: () => Promise.resolve(),
      };
    },
    persist: async (payload) => {
      const hash = digest(JSON.stringify(payload));
      if (journal && (payload.revision < journal.revision || payload.revision === journal.revision && hash !== journal.release_digest)) throw new Error("provider_activation_replay");
      const next = { schema_version: "provider-activation@2026-09-06.v1" as const, revision: payload.revision, release_digest: hash };
      if (!journal || journal.revision !== next.revision) await atomicJournal(stateFile, next);
      journal = next;
    },
  });
  const refresh = async () => {
    const candidate = load();
    if (current?.payload.revision === candidate.payload.revision && digest(JSON.stringify(current.payload)) === digest(JSON.stringify(candidate.payload))) return;
    await runtime.activate(candidate);
    current = candidate;
    lastError = null;
  };
  try {
    await refresh();
  } catch (error) {
    await runtime.close();
    throw error;
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void refresh().catch(() => {
      lastError = "provider_candidate_rejected";
    }).finally(() => {
      running = false;
    });
  }, 3000);
  timer.unref();
  return {
    get catalogDefinitions() {
      return runtime.catalogDefinitions;
    },
    get definitions() {
      return runtime.definitions;
    },
    subscribe: (listener: () => void) => runtime.subscribe(listener),
    snapshot: () => ({ ...runtime.snapshot(), last_error: lastError }),
    health: async () => {
      if (!current || runtime.snapshot().cleanup_failed || Date.parse(current.payload.expires_at) <= Date.now()) return { ready: false };
      try {
        if (current.payload.enabled) await probe(current.artifact.base_url);
        return { ready: true };
      } catch {
        return { ready: false };
      }
    },
    close: async () => {
      clearInterval(timer);
      await runtime.close();
    },
  };
}
