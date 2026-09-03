import { createInterface } from "node:readline";

const protocol = "2026-09-02.v1";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({
      protocol_version: protocol,
      request_id: "invalid",
      ok: false,
      code: "worker.request_invalid",
    })}\n`);
    continue;
  }
  if (request.method === "system.health") {
    process.stdout.write(`${JSON.stringify({
      protocol_version: protocol,
      request_id: request.request_id,
      ok: true,
      health: { ready: true },
    })}\n`);
    continue;
  }
  if (process.env.T1_STUB_OVERSIZED === "true") {
    process.stdout.write(`${JSON.stringify({
      protocol_version: protocol,
      request_id: request.request_id,
      ok: true,
      result: {
        status: "unavailable",
        data: "x".repeat(4096),
        sourceRefs: [],
        calculationTrace: [],
      },
    })}\n`);
    continue;
  }
  process.stdout.write(`${JSON.stringify({
    protocol_version: protocol,
    request_id: request.request_id,
    ok: true,
    result: {
      status: "unavailable",
      data: null,
      sourceRefs: [],
      calculationTrace: [],
      blockers: [{
        code: `stub.${request.method}`,
        message: "stub",
        severity: "error",
        field: null,
      }],
    },
  })}\n`);
}
