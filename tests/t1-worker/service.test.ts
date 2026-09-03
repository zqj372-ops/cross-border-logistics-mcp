import { describe, expect, it, vi } from "vitest";

import type {
  AdapterResult,
  CustomsAdapter,
  FreightcomRatePort,
  QuoteAdapter,
} from "../../src/logistics_mcp/adapters/ports.js";
import {
  T1_WORKER_PROTOCOL_VERSION,
  createT1WorkerRequestHandler,
} from "../../src/logistics_mcp/t1-worker/service.js";

function unavailable(code: string): AdapterResult {
  return {
    status: "unavailable",
    data: null,
    sourceRefs: [],
    calculationTrace: [],
    blockers: [{ code, message: code, severity: "error", field: null }],
  };
}

function adapters() {
  const quoteCalculate = vi.fn(() => Promise.resolve(unavailable("quote.called")));
  const customsSearch = vi.fn<CustomsAdapter["search"]>(
    () => Promise.resolve(unavailable("customs.called")),
  );
  const freightcomRate = vi.fn(() => Promise.resolve(unavailable("freightcom.called")));
  const quote: QuoteAdapter = {
    calculate: quoteCalculate,
    previewDraft: () => Promise.resolve(unavailable("write.closed")),
    commitDraft: () => Promise.resolve(unavailable("write.closed")),
    readDraft: () => Promise.resolve(unavailable("write.closed")),
  };
  const customs: CustomsAdapter = {
    getStatus: () => Promise.resolve(unavailable("status.closed")),
    search: customsSearch,
    estimate: () => Promise.resolve(unavailable("estimate.closed")),
  };
  const freightcom: FreightcomRatePort = { requestRate: freightcomRate };
  return { ports: { quote, customs, freightcom }, quoteCalculate, customsSearch, freightcomRate };
}

function request(method: string) {
  return {
    protocol_version: T1_WORKER_PROTOCOL_VERSION,
    request_id: "request-1",
    method,
    input: {},
    context: {
      tenant_id: "tenant-a",
      actor_id: "service-a",
      actor_role: "service",
      roles: ["service"],
      scopes: ["tool:customs.ca.search"],
      client_id: "client-a",
      session_id: "session-a",
      expires_at: 1_900_000_000,
    },
    deadline_unix_ms: Date.now() + 5_000,
  };
}

describe("T1 worker closed request service", () => {
  it("rejects unknown methods and unknown fields without touching adapters", async () => {
    const fixture = adapters();
    const handle = createT1WorkerRequestHandler(fixture.ports);

    const unknown = await handle(request("generic.execute"));
    const openRequest = await handle({ ...request("customs.ca.search"), endpoint: "https://evil.invalid" });

    expect(unknown).toMatchObject({ ok: false, code: "worker.request_invalid" });
    expect(openRequest).toMatchObject({ ok: false, code: "worker.request_invalid" });
    expect(fixture.quoteCalculate).not.toHaveBeenCalled();
    expect(fixture.customsSearch).not.toHaveBeenCalled();
  });

  it("reconstructs trusted server context and routes only the fixed method", async () => {
    const fixture = adapters();
    const handle = createT1WorkerRequestHandler(fixture.ports);

    const response = await handle(request("customs.ca.search"));

    expect(response).toMatchObject({ ok: true, request_id: "request-1" });
    expect(fixture.customsSearch).toHaveBeenCalledTimes(1);
    const calledContext = fixture.customsSearch.mock.calls[0]?.[1];
    expect(calledContext).toMatchObject({ tenantId: "tenant-a", role: "service" });
    expect(fixture.quoteCalculate).not.toHaveBeenCalled();
    expect(fixture.freightcomRate).not.toHaveBeenCalled();
  });

  it("rejects expired deadlines before adapter execution", async () => {
    const fixture = adapters();
    const handle = createT1WorkerRequestHandler(fixture.ports);
    const response = await handle({
      ...request("quote.canada_final_mile.calculate"),
      deadline_unix_ms: Date.now() - 1,
    });

    expect(response).toMatchObject({ ok: false, code: "worker.deadline_expired" });
    expect(fixture.quoteCalculate).not.toHaveBeenCalled();
  });

  it("honors the bounded parent deadline instead of aborting every request at 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const fixture = adapters();
      const freightcomRate = vi.fn<FreightcomRatePort["requestRate"]>((_input, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve(unavailable("freightcom.aborted"));
          }, { once: true });
        }),
      );
      const now = 1_000;
      const handle = createT1WorkerRequestHandler({
        ...fixture.ports,
        freightcom: { requestRate: freightcomRate },
      }, () => now);
      const responsePromise = handle({
        ...request("quote.freightcom_ltl.preview"),
        context: {
          ...request("quote.freightcom_ltl.preview").context,
          scopes: ["tool:quote.freightcom_ltl.preview"],
        },
        deadline_unix_ms: now + 120_000,
      });
      let settled = false;
      void responsePromise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(43_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await responsePromise).toMatchObject({
        ok: true,
        result: { blockers: [{ code: "freightcom.aborted" }] },
      });
      expect(freightcomRate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires the authenticated exact tool entitlement before routing", async () => {
    const fixture = adapters();
    const handle = createT1WorkerRequestHandler(fixture.ports);
    const response = await handle({
      ...request("quote.canada_final_mile.calculate"),
      context: {
        ...request("quote.canada_final_mile.calculate").context,
        scopes: ["tool:customs.ca.search"],
      },
    });

    expect(response).toMatchObject({ ok: false, code: "worker.request_invalid" });
    expect(fixture.quoteCalculate).not.toHaveBeenCalled();
  });

  it.each([
    ["platform scope", ["tool:customs.ca.search", "platform:admin"]],
    ["business wildcard", ["tool:customs.ca.search", "tariff:read:*"]],
    ["unknown tool", ["tool:customs.ca.search", "tool:generic.execute"]],
  ])("rejects %s mixed into the isolated worker identity", async (_label, scopes) => {
    const fixture = adapters();
    const handle = createT1WorkerRequestHandler(fixture.ports);
    const response = await handle({
      ...request("customs.ca.search"),
      context: {
        ...request("customs.ca.search").context,
        scopes,
      },
    });

    expect(response).toMatchObject({ ok: false, code: "worker.request_invalid" });
    expect(fixture.customsSearch).not.toHaveBeenCalled();
  });
});
