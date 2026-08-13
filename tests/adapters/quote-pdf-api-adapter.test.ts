import { describe, expect, it, vi } from "vitest";

import {
  QuotePdfApiAdapter,
  type QuotePdfMetadata,
} from "../../src/logistics_mcp/adapters/pdf/quote-pdf-api-adapter";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client";
import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";
import { hashPayload } from "../../src/logistics_mcp/platform/idempotency";

const context: ExecutionContext = {
  tenantId: "tenant_pdf_fixture",
  actorId: "actor_sales",
  role: "sales",
  roles: ["sales"],
  scopes: ["quote:pdf_write"],
  clientId: "client_fixture",
  sessionId: "session_fixture",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const body = {
  version: 2,
  kind: "quote",
  sendable: false,
  quote_id: "quote:pdf:001",
  quote_version: "release-1:rules-1:data-1",
  release_id: "release-1",
  rule_version: "rules-1",
  data_version: "data-1",
  effective_date: "2026-08-14",
  snapshot_hash: `sha256:${"a".repeat(64)}`,
  release_hash: `sha256:${"a".repeat(64)}`,
  data: {
    currency: "USD",
    total: { amount: "9007199254740993.00", currency: "USD" },
    line_items: [{
      line_id: "line-1",
      label: "authoritative line",
      amount: { amount: "9007199254740993.00", currency: "USD" },
      pricing_basis: "fixture",
      source_ref_ids: ["src:quote:snapshot:" + "a".repeat(64)],
    }],
    presentation: { customer_display_name: "Customer is not sent by adapter" },
  },
};

const metadata: QuotePdfMetadata = {
  document_ref: "01234567-89ab-cdef-0123-456789abcdef.pdf",
  sha256: "b".repeat(64),
  byte_length: 128,
  renderer_version: "renderer-8",
  template_version: "template-1",
  status: "ready",
  sendable: false,
  quote_id: body.quote_id,
  quote_version: body.quote_version,
  release_id: body.release_id,
  rule_version: body.rule_version,
  data_version: body.data_version,
  effective_date: body.effective_date,
  snapshot_hash: body.snapshot_hash,
  release_hash: body.release_hash,
  input_sha256: "c".repeat(64),
};

const response = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function adapter(
  fetchImpl: FetchImplementation,
  overrides: Partial<ConstructorParameters<typeof QuotePdfApiAdapter>[0]> = {},
): QuotePdfApiAdapter {
  return new QuotePdfApiAdapter({
    baseUrl: "https://pdf.example.invalid/root",
    allowedHosts: ["pdf.example.invalid"],
    enabled: true,
    credentialProvider: vi.fn((receivedContext, signal) => {
      expect(receivedContext).toBe(context);
      expect(signal).toBeInstanceOf(AbortSignal);
      return "Bearer fixture-pdf-token";
    }),
    fetchImpl,
    timeoutMs: 20,
    ...overrides,
  });
}

describe("quote PDF API adapter", () => {
  it("is disabled by default and does not fetch without credential or before abort", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const disabled = new QuotePdfApiAdapter({
      baseUrl: "https://pdf.example.invalid",
      allowedHosts: ["pdf.example.invalid"],
      fetchImpl,
    });

    await expect(disabled.post(body, "commit-key-123456", context)).resolves.toMatchObject({
      ok: false,
      failure: { kind: "unavailable", dispatched: false },
    });

    const missingCredential = new QuotePdfApiAdapter({
      baseUrl: "https://pdf.example.invalid",
      allowedHosts: ["pdf.example.invalid"],
      enabled: true,
      fetchImpl,
    });
    await expect(missingCredential.post(body, "commit-key-123456", context)).resolves.toMatchObject({
      ok: false,
      failure: { kind: "blocked", dispatched: false },
    });

    const controller = new AbortController();
    controller.abort();
    await expect(adapter(fetchImpl).post(body, "commit-key-123456", context, controller.signal)).resolves.toMatchObject({
      ok: false,
      failure: { kind: "unavailable", dispatched: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires HTTPS and the explicit host allowlist", () => {
    expect(() => new QuotePdfApiAdapter({
      baseUrl: "http://pdf.example.invalid",
      allowedHosts: ["pdf.example.invalid"],
    })).toThrow(/HTTPS/i);
    expect(() => new QuotePdfApiAdapter({
      baseUrl: "https://other.example.invalid",
      allowedHosts: ["pdf.example.invalid"],
    })).toThrow(/allowlisted|host/i);
  });

  it("sends only server credential and the exact commit key, then reads metadata", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn<FetchImplementation>((input, init) => {
      calls.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        init,
      });
      return Promise.resolve(calls.length === 1 ? response(metadata, 201) : response(metadata, 200));
    });
    const pdf = adapter(fetchImpl);

    await expect(pdf.post(body, "commit-key-123456", context)).resolves.toMatchObject({
      ok: true,
      status: 201,
      metadata,
    });
    await expect(pdf.get(metadata.document_ref, context)).resolves.toEqual({ ok: true, metadata });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://pdf.example.invalid/v2/quote-pdfs");
    expect(calls[1]?.url).toBe(`https://pdf.example.invalid/v2/quote-pdfs/${metadata.document_ref}`);
    const postHeaders = Object.fromEntries(new Headers(calls[0]?.init?.headers).entries());
    const getHeaders = Object.fromEntries(new Headers(calls[1]?.init?.headers).entries());
    expect(postHeaders).toMatchObject({
      authorization: "Bearer fixture-pdf-token",
      "idempotency-key": "commit-key-123456",
    });
    expect(postHeaders).not.toHaveProperty("x-tenant-id");
    expect(postHeaders).not.toHaveProperty("x-client-id");
    expect(calls[0]?.init?.body).toBe(JSON.stringify(body));
    expect(getHeaders).toMatchObject({ authorization: "Bearer fixture-pdf-token" });
    expect(hashPayload(body)).toBe(`sha256:22610e04efd281008d0dfbfd8206333dddf7ab837181ab932bffc6a55c783a8a`);
  });

  it("accepts upstream metadata version strings without imposing a narrower local cap", async () => {
    const upstreamMetadata = {
      ...metadata,
      renderer_version: "renderer-" + "r".repeat(200),
      template_version: "template-" + "t".repeat(200),
    };
    const fetchImpl = vi.fn<FetchImplementation>(() => Promise.resolve(response(upstreamMetadata, 201)));
    await expect(adapter(fetchImpl).post(body, "commit-key-123456", context)).resolves.toMatchObject({
      ok: true,
      status: 201,
      metadata: upstreamMetadata,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "unavailable"],
    [413, "unavailable"],
    [500, "unavailable"],
    [503, "unavailable"],
    [401, "blocked"],
    [403, "blocked"],
    [409, "blocked"],
  ] as const)("preserves known POST status %s without replaying", async (status, kind) => {
    const fetchImpl = vi.fn<FetchImplementation>(() => Promise.resolve(response({ secret: "do not expose" }, status)));
    const result = await adapter(fetchImpl).post(body, "commit-key-123456", context);

    expect(result).toMatchObject({ ok: false, failure: { kind, upstreamStatus: status } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("do not expose");
  });

  it("treats a synchronous connection failure before dispatch as unavailable", async () => {
    const fetchImpl = vi.fn<FetchImplementation>(() => {
      throw new Error("connection refused");
    });
    const result = await adapter(fetchImpl).post(body, "commit-key-123456", context);

    expect(result).toMatchObject({ ok: false, failure: { kind: "unavailable", dispatched: false } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not replay a control-character idempotency key rejected before dispatch", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const result = await adapter(fetchImpl).post(body, "commit-key-\u0000", context);

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "unavailable", dispatched: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("replays bad JSON from a successful POST once, but not malformed known errors", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<FetchImplementation>(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? new Response("{", { status: 200 }) : response(metadata, 200));
    });
    await expect(adapter(fetchImpl).post(body, "commit-key-123456", context)).resolves.toMatchObject({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const knownErrorFetch = vi.fn<FetchImplementation>(() => Promise.resolve(new Response("{", { status: 503 })));
    await expect(adapter(knownErrorFetch).post(body, "commit-key-123456", context)).resolves.toMatchObject({
      ok: false,
      failure: { kind: "unavailable", upstreamStatus: 503 },
    });
    expect(knownErrorFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [503, "unavailable"],
    [409, "blocked"],
  ] as const)("keeps known status %s when the error body is unreadable or oversized", async (status, kind) => {
    const readFailure = status === 409
      ? {
          status,
          ok: false,
          body: null,
          headers: new Headers(),
          text: vi.fn(() => Promise.reject(new Error("body read failed"))),
        } as unknown as Response
      : new Response("too large", { status, headers: { "content-length": "600000" } });
    const fetchImpl = vi.fn<FetchImplementation>(() => Promise.resolve(readFailure));
    const result = await adapter(fetchImpl).post(body, "commit-key-123456", context);

    expect(result).toMatchObject({ ok: false, failure: { kind, upstreamStatus: status } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "manual_review"],
    [500, "manual_review"],
    [503, "manual_review"],
    [401, "blocked"],
    [403, "blocked"],
  ] as const)("maps GET status %s to %s without leaking upstream body", async (status, kind) => {
    const fetchImpl = vi.fn<FetchImplementation>(() => Promise.resolve(response({ token: "secret" }, status)));
    const result = await adapter(fetchImpl).get(metadata.document_ref, context);

    expect(result).toMatchObject({ ok: false, failure: { kind, upstreamStatus: status } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("replays one uncertain POST with the identical body and key, but never after caller abort", async () => {
    const calls: Array<{ body: string | undefined; key: string | undefined }> = [];
    const fetchImpl = vi.fn<FetchImplementation>((_input, init) => {
      calls.push({
        body: typeof init?.body === "string" ? init.body : undefined,
        key: new Headers(init?.headers).get("idempotency-key") ?? undefined,
      });
      return calls.length === 1
        ? Promise.resolve(new Response("{", { status: 200 }))
        : Promise.resolve(response(metadata, 200));
    });
    const recovered = await adapter(fetchImpl, { timeoutMs: 5 }).post(body, "commit-key-123456", context);

    expect(recovered).toMatchObject({ ok: true, status: 200, metadata });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[1]).toEqual(calls[0]);

    const abortController = new AbortController();
    const abortCalls = vi.fn<FetchImplementation>((_input, init) => {
      setTimeout(() => abortController.abort(), 1);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const aborted = await adapter(abortCalls, { timeoutMs: 50 }).post(
      body,
      "commit-key-123456",
      context,
      abortController.signal,
    );
    expect(aborted).toMatchObject({ ok: false, failure: { kind: "manual_review", dispatched: true } });
    expect(abortCalls).toHaveBeenCalledTimes(1);
  });

  it("bounds a POST replay by the remaining deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let calls = 0;
      const fetchImpl = vi.fn<FetchImplementation>(() => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response("{", { status: 200 })), 6);
          });
        }
        return new Promise<Response>(() => undefined);
      });
      const request = adapter(fetchImpl, { timeoutMs: 10 }).post(body, "commit-key-123456", context);
      let settledAtDeadline = false;
      const observed = request.then(() => {
        settledAtDeadline = true;
      });

      await vi.advanceTimersByTimeAsync(10);
      const settledAfterDeadline = settledAtDeadline;
      await vi.advanceTimersByTimeAsync(40);
      await observed;

      expect(settledAfterDeadline).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the second uncertain POST is still unknown", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<FetchImplementation>(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(new Response("{", { status: 200 }))
        : new Promise<Response>(() => undefined);
    });
    const result = await adapter(fetchImpl, { timeoutMs: 5 }).post(body, "commit-key-123456", context);

    expect(result).toMatchObject({ ok: false, failure: { kind: "manual_review", dispatched: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not replay after credential time consumes the single POST deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fetchImpl = vi.fn<FetchImplementation>(() => new Promise<Response>(() => undefined));
      const credentialProvider = vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 8));
        return "Bearer fixture-pdf-token";
      });
      const request = adapter(fetchImpl, { credentialProvider, timeoutMs: 10 }).post(
        body,
        "commit-key-123456",
        context,
      );

      await vi.advanceTimersByTimeAsync(40);
      const result = await request;

      expect(result).toMatchObject({ ok: false, failure: { kind: "manual_review", dispatched: true } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the remaining GET budget after credential resolution", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fetchImpl = vi.fn<FetchImplementation>(() => new Promise<Response>(() => undefined));
      const credentialProvider = vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 8));
        return "Bearer fixture-pdf-token";
      });
      const request = adapter(fetchImpl, { credentialProvider, timeoutMs: 10 }).get(
        metadata.document_ref,
        context,
      );
      let settledAtDeadline = false;
      const observed = request.then(() => {
        settledAtDeadline = true;
      });

      await vi.advanceTimersByTimeAsync(10);
      const settledAfterDeadline = settledAtDeadline;
      await vi.advanceTimersByTimeAsync(40);
      await observed;

      expect(settledAfterDeadline).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hanging credential provider by timeout and caller abort without fetching", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const hanging = new QuotePdfApiAdapter({
      baseUrl: "https://pdf.example.invalid",
      allowedHosts: ["pdf.example.invalid"],
      enabled: true,
      timeoutMs: 5,
      fetchImpl,
      credentialProvider: vi.fn(() => new Promise<string>(() => undefined)),
    });
    await expect(hanging.post(body, "commit-key-123456", context)).resolves.toMatchObject({
      ok: false,
      failure: { kind: "unavailable", dispatched: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const controller = new AbortController();
    const aborting = new QuotePdfApiAdapter({
      baseUrl: "https://pdf.example.invalid",
      allowedHosts: ["pdf.example.invalid"],
      enabled: true,
      timeoutMs: 50,
      fetchImpl,
      credentialProvider: vi.fn(() => new Promise<string>(() => undefined)),
    });
    const request = aborting.post(body, "commit-key-123456", context, controller.signal);
    controller.abort();
    await expect(request).resolves.toMatchObject({
      ok: false,
      failure: { kind: "unavailable", dispatched: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
