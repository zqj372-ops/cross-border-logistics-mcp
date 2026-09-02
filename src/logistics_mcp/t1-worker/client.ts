import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  AdapterResult,
  CustomsAdapter,
  FreightcomRatePort,
  QuoteAdapter,
} from "../adapters/ports";
import {
  isTrustedExecutionContext,
  type ExecutionContext,
} from "../platform/context";
import type { T1ReadWorker } from "../server/composition";
import { T1_WORKER_PROTOCOL_VERSION } from "./service";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const responseSchema = z.union([
  z.object({
    protocol_version: z.literal(T1_WORKER_PROTOCOL_VERSION),
    request_id: z.string().min(1).max(128),
    ok: z.literal(true),
    result: z.unknown(),
  }).strict(),
  z.object({
    protocol_version: z.literal(T1_WORKER_PROTOCOL_VERSION),
    request_id: z.string().min(1).max(128),
    ok: z.literal(true),
    health: z.object({ ready: z.boolean() }).strict(),
  }).strict(),
  z.object({
    protocol_version: z.literal(T1_WORKER_PROTOCOL_VERSION),
    request_id: z.string().min(1).max(128),
    ok: z.literal(false),
    code: z.enum([
      "worker.request_invalid",
      "worker.deadline_expired",
      "worker.execution_failed",
      "worker.response_too_large",
    ]),
  }).strict(),
]);

type WorkerResponse = z.infer<typeof responseSchema>;

interface PendingRequest {
  readonly resolve: (value: WorkerResponse) => void;
  readonly reject: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbort: () => void;
}

export interface T1ReadWorkerClientOptions {
  readonly entryPoint: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

function result(
  status: "blocked" | "unavailable",
  code: string,
  message: string,
): AdapterResult {
  return {
    status,
    data: null,
    sourceRefs: [],
    calculationTrace: [],
    blockers: [{ code, message, severity: "error", field: null }],
    reviewStatus: "manual_review",
  };
}

function executionContextRequired(): AdapterResult {
  return result(
    "blocked",
    "t1_worker.execution_context_required",
    "The T1 read worker requires a server-authenticated execution context.",
  );
}

function workerUnavailable(): AdapterResult {
  return result(
    "unavailable",
    "t1_worker.unavailable",
    "The isolated T1 read worker is unavailable.",
  );
}

function writeClosed(): AdapterResult {
  return result(
    "blocked",
    "t1_worker.write_forbidden",
    "The read-preview worker does not expose business write operations.",
  );
}

function contextPayload(context: ExecutionContext): Record<string, unknown> {
  return {
    tenant_id: context.tenantId,
    actor_id: context.actorId,
    actor_role: context.role,
    roles: [...context.roles],
    scopes: [...context.scopes],
    client_id: context.clientId,
    session_id: context.sessionId,
    expires_at: context.expiresAt,
  };
}

function isAdapterResult(value: unknown): value is AdapterResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    ["success", "needs_input", "manual_review", "blocked", "unavailable"].includes(
      String(record.status),
    ) &&
    Object.hasOwn(record, "data") &&
    Array.isArray(record.sourceRefs)
  );
}

class ProcessT1ReadWorker implements T1ReadWorker {
  readonly kind = "t1_read_worker" as const;
  readonly adapters: T1ReadWorker["adapters"];
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #requestTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  #stdoutBuffer = "";
  #closed = false;
  #exited = false;

  constructor(options: T1ReadWorkerClientOptions) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#maxRequestBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1 ||
      !Number.isSafeInteger(this.#maxRequestBytes) || this.#maxRequestBytes < 1 ||
      !Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1
    ) throw new TypeError("T1 worker client limits are invalid.");

    this.#child = spawn(process.execPath, [options.entryPoint], {
      env: { ...options.environment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.#child.stderr.resume();
    this.#child.once("error", () => this.onExit());
    this.#child.once("exit", () => this.onExit());

    const quote: QuoteAdapter = {
      calculate: (input, context, signal) => this.callAdapter(
        "quote.canada_final_mile.calculate",
        input,
        context,
        signal,
      ),
      previewDraft: () => Promise.resolve(writeClosed()),
      commitDraft: () => Promise.resolve(writeClosed()),
      readDraft: () => Promise.resolve(writeClosed()),
    };
    const customs: CustomsAdapter = {
      getStatus: () => Promise.resolve(result(
        "blocked",
        "t1_worker.method_forbidden",
        "Direct worker status access is not exposed as an MCP business tool.",
      )),
      search: (input, context, signal) => this.callAdapter(
        "customs.ca.search",
        input,
        context,
        signal,
      ),
      estimate: (input, context, signal) => this.callAdapter(
        "customs.ca.estimate",
        input,
        context,
        signal,
      ),
    };
    const freightcom: FreightcomRatePort = {
      requestRate: (input, signal, context) => this.callAdapter(
        "quote.freightcom_ltl.preview",
        input,
        context,
        signal,
      ),
    };
    this.adapters = Object.freeze({ quote, customs, freightcom });
  }

  async health(): Promise<{ readonly ready: boolean }> {
    try {
      const response = await this.rpc({ method: "system.health" });
      return {
        ready: response.ok === true && "health" in response && response.health.ready,
      };
    } catch {
      return { ready: false };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    if (this.#exited) return;
    this.#child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolve();
      }, 1_000);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async callAdapter(
    method:
      | "quote.canada_final_mile.calculate"
      | "customs.ca.search"
      | "customs.ca.estimate"
      | "quote.freightcom_ltl.preview",
    input: unknown,
    context: ExecutionContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AdapterResult> {
    if (!isTrustedExecutionContext(context)) return executionContextRequired();
    try {
      const response = await this.rpc({
        method,
        input,
        context: contextPayload(context),
      }, signal);
      if (!response.ok || !("result" in response) || !isAdapterResult(response.result)) {
        return workerUnavailable();
      }
      return response.result;
    } catch {
      return workerUnavailable();
    }
  }

  private rpc(
    input: Readonly<{
      readonly method: string;
      readonly input?: unknown;
      readonly context?: Record<string, unknown>;
    }>,
    signal?: AbortSignal,
  ): Promise<WorkerResponse> {
    if (this.#closed || this.#exited || signal?.aborted) return Promise.reject(new Error("worker unavailable"));
    const requestId = `t1_${randomUUID().replaceAll("-", "")}`;
    const payload = {
      protocol_version: T1_WORKER_PROTOCOL_VERSION,
      request_id: requestId,
      method: input.method,
      ...(Object.hasOwn(input, "input") ? { input: input.input } : {}),
      ...(input.context === undefined ? {} : { context: input.context }),
      deadline_unix_ms: Date.now() + this.#requestTimeoutMs,
    };
    let line: string;
    try {
      line = `${JSON.stringify(payload)}\n`;
    } catch {
      return Promise.reject(new Error("worker request invalid"));
    }
    if (Buffer.byteLength(line, "utf8") > this.#maxRequestBytes) {
      return Promise.reject(new Error("worker request invalid"));
    }
    return new Promise<WorkerResponse>((resolve, reject) => {
      const abort = () => this.rejectPending(requestId);
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => this.rejectPending(requestId), this.#requestTimeoutMs);
      this.#pending.set(requestId, {
        resolve,
        reject: () => reject(new Error("worker unavailable")),
        timer,
        removeAbort: () => signal?.removeEventListener("abort", abort),
      });
      this.#child.stdin.write(line, "utf8", (error) => {
        if (error !== null && error !== undefined) this.rejectPending(requestId);
      });
    });
  }

  private onStdout(chunk: string): void {
    if (this.#closed || this.#exited) return;
    this.#stdoutBuffer += chunk;
    let newline = this.#stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.#maxResponseBytes) {
        this.protocolFailure();
        return;
      }
      if (line.length > 0) this.onLine(line);
      if (this.#exited) return;
      newline = this.#stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > this.#maxResponseBytes) {
      this.protocolFailure();
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.protocolFailure();
      return;
    }
    const response = responseSchema.safeParse(parsed);
    if (!response.success) {
      this.protocolFailure();
      return;
    }
    const pending = this.#pending.get(response.data.request_id);
    if (pending === undefined) {
      this.protocolFailure();
      return;
    }
    this.#pending.delete(response.data.request_id);
    clearTimeout(pending.timer);
    pending.removeAbort();
    pending.resolve(response.data);
  }

  private rejectPending(requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbort();
    pending.reject();
  }

  private protocolFailure(): void {
    this.#child.kill("SIGKILL");
    this.onExit();
  }

  private onExit(): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const requestId of [...this.#pending.keys()]) this.rejectPending(requestId);
  }
}

export function createT1ReadWorkerClient(
  options: T1ReadWorkerClientOptions,
): T1ReadWorker {
  return new ProcessT1ReadWorker(options);
}
