import { z } from "zod";

import type {
  AdapterResult,
  CustomsAdapter,
  FreightcomRatePort,
  QuoteAdapter,
} from "../adapters/ports";
import { parseExecutionContext } from "../platform/context";
import { isExactReadPreviewServiceIdentity } from "../platform/rbac";

export const T1_WORKER_PROTOCOL_VERSION = "2026-09-02.v1" as const;

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const contextSchema = z.object({
  tenant_id: identifierSchema,
  actor_id: identifierSchema,
  actor_role: z.literal("service"),
  roles: z.tuple([z.literal("service")]),
  scopes: z.array(z.string().min(1).max(200)).min(1).max(16),
  client_id: identifierSchema,
  session_id: identifierSchema,
  expires_at: z.number().int().positive(),
}).strict();
const methodSchema = z.enum([
  "quote.canada_final_mile.calculate",
  "customs.ca.search",
  "customs.ca.estimate",
  "quote.freightcom_ltl.preview",
]);
const requestSchema = z.object({
  protocol_version: z.literal(T1_WORKER_PROTOCOL_VERSION),
  request_id: identifierSchema,
  method: methodSchema,
  input: z.unknown(),
  context: contextSchema,
  deadline_unix_ms: z.number().int().positive(),
}).strict();

export interface T1WorkerPorts {
  readonly quote: QuoteAdapter;
  readonly customs: CustomsAdapter;
  readonly freightcom: FreightcomRatePort;
}

export type T1WorkerResponse =
  | Readonly<{
      protocol_version: typeof T1_WORKER_PROTOCOL_VERSION;
      request_id: string;
      ok: true;
      result: AdapterResult;
    }>
  | Readonly<{
      protocol_version: typeof T1_WORKER_PROTOCOL_VERSION;
      request_id: string;
      ok: false;
      code: "worker.request_invalid" | "worker.deadline_expired" | "worker.execution_failed";
    }>;

function failure(
  requestId: string,
  code: Extract<T1WorkerResponse, { ok: false }>["code"],
): T1WorkerResponse {
  return Object.freeze({
    protocol_version: T1_WORKER_PROTOCOL_VERSION,
    request_id: requestId,
    ok: false,
    code,
  });
}

export function createT1WorkerRequestHandler(
  ports: T1WorkerPorts,
  clock: () => number = Date.now,
): (input: unknown) => Promise<T1WorkerResponse> {
  return async (input) => {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return failure("invalid", "worker.request_invalid");
    const request = parsed.data;
    const remainingMs = request.deadline_unix_ms - clock();
    if (remainingMs <= 0) return failure(request.request_id, "worker.deadline_expired");

    let context;
    try {
      context = parseExecutionContext(request.context);
    } catch {
      return failure(request.request_id, "worker.request_invalid");
    }
    if (
      !isExactReadPreviewServiceIdentity(context) ||
      !context.scopes.includes(`tool:${request.method}`)
    ) {
      return failure(request.request_id, "worker.request_invalid");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remainingMs, 30_000));
    try {
      let result: AdapterResult;
      switch (request.method) {
        case "quote.canada_final_mile.calculate":
          result = await ports.quote.calculate(
            request.input as Record<string, unknown>,
            context,
            controller.signal,
          );
          break;
        case "customs.ca.search":
          result = await ports.customs.search(
            request.input as Record<string, unknown>,
            context,
            controller.signal,
          );
          break;
        case "customs.ca.estimate":
          result = await ports.customs.estimate(
            request.input as Record<string, unknown>,
            context,
            controller.signal,
          );
          break;
        case "quote.freightcom_ltl.preview":
          result = await ports.freightcom.requestRate(
            request.input,
            controller.signal,
            context,
          );
          break;
      }
      return Object.freeze({
        protocol_version: T1_WORKER_PROTOCOL_VERSION,
        request_id: request.request_id,
        ok: true,
        result,
      });
    } catch {
      return failure(request.request_id, "worker.execution_failed");
    } finally {
      clearTimeout(timer);
    }
  };
}
