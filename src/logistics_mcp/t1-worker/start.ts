import { ExistingQuoteAdapter } from "../adapters/quote/existing-quote-adapter";
import { createQuotePreviewAdapterFromEnvironment } from "../adapters/quote/quote-runtime";
import { RiskCustomsAdapter } from "../adapters/customs/riskcustoms-adapter";
import { createRiskCustomsApiAdapterFromEnvironment } from "../adapters/customs/riskcustoms-runtime";
import { createFreightcomDisabledRateAdapter } from "../adapters/quote/freightcom-rate-adapter";
import { createFreightcomTestAdapterFromEnvironment } from "../adapters/quote/freightcom-runtime";
import {
  T1_WORKER_PROTOCOL_VERSION,
  createT1WorkerRequestHandler,
} from "./service";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface HealthRequest {
  readonly protocol_version: typeof T1_WORKER_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly method: "system.health";
  readonly deadline_unix_ms: number;
}

function isHealthRequest(value: unknown): value is HealthRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).length === 4 &&
    request.protocol_version === T1_WORKER_PROTOCOL_VERSION &&
    typeof request.request_id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(request.request_id) &&
    request.method === "system.health" &&
    typeof request.deadline_unix_ms === "number" &&
    Number.isSafeInteger(request.deadline_unix_ms) &&
    request.deadline_unix_ms > Date.now()
  );
}

function invalidResponse(requestId = "invalid") {
  return {
    protocol_version: T1_WORKER_PROTOCOL_VERSION,
    request_id: requestId,
    ok: false,
    code: "worker.request_invalid",
  } as const;
}

function responseTooLarge(requestId: string) {
  return {
    protocol_version: T1_WORKER_PROTOCOL_VERSION,
    request_id: requestId,
    ok: false,
    code: "worker.response_too_large",
  } as const;
}

function requestIdOf(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
  const requestId = (value as Record<string, unknown>).request_id;
  return typeof requestId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(requestId)
    ? requestId
    : "invalid";
}

function writeResponse(value: unknown, requestId: string): void {
  let line: string;
  try {
    line = `${JSON.stringify(value)}\n`;
  } catch {
    line = `${JSON.stringify({
      protocol_version: T1_WORKER_PROTOCOL_VERSION,
      request_id: requestId,
      ok: false,
      code: "worker.execution_failed",
    })}\n`;
  }
  if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_BYTES) {
    line = `${JSON.stringify(responseTooLarge(requestId))}\n`;
  }
  process.stdout.write(line);
}

async function main(): Promise<void> {
  if (process.argv.slice(2).length !== 0) {
    throw new Error("The T1 worker entry does not accept command-line arguments.");
  }

  const quote = await createQuotePreviewAdapterFromEnvironment() ?? new ExistingQuoteAdapter();
  const customs = createRiskCustomsApiAdapterFromEnvironment() ?? new RiskCustomsAdapter();
  const freightcom = createFreightcomTestAdapterFromEnvironment() ??
    createFreightcomDisabledRateAdapter();
  const handle = createT1WorkerRequestHandler({ quote, customs, freightcom });

  process.stdin.setEncoding("utf8");
  let buffer = "";
  let chain = Promise.resolve();
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
        writeResponse(invalidResponse(), "invalid");
        process.stdin.destroy();
        process.exitCode = 1;
        return;
      }
      if (line.length > 0) {
        chain = chain.then(async () => {
          let request: unknown;
          try {
            request = JSON.parse(line) as unknown;
          } catch {
            writeResponse(invalidResponse(), "invalid");
            return;
          }
          const requestId = requestIdOf(request);
          if (isHealthRequest(request)) {
            writeResponse({
              protocol_version: T1_WORKER_PROTOCOL_VERSION,
              request_id: request.request_id,
              ok: true,
              health: { ready: true },
            }, request.request_id);
            return;
          }
          writeResponse(await handle(request), requestId);
        });
      }
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      writeResponse(invalidResponse(), "invalid");
      buffer = "";
      process.stdin.destroy();
      process.exitCode = 1;
    }
  });
  process.stdin.once("end", () => {
    void chain.finally(() => {
      if (buffer.length > 0) writeResponse(invalidResponse(), "invalid");
    });
  });
}

void main().catch(() => {
  process.exitCode = 1;
});
