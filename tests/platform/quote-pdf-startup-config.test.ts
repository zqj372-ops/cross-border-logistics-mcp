import { describe, expect, it, vi } from "vitest";

import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client";
import {
  createProductionApiAdapterSource,
  createProductionComposition,
} from "../../src/logistics_mcp/server/composition";
import { createQuotePdfStartupOptions } from "../../src/logistics_mcp/server/start";
import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";

const token = "startup-pdf-secret-token";
const context: ExecutionContext = {
  tenantId: "tenant_configured",
  actorId: "actor_sales",
  role: "sales",
  roles: ["sales"],
  scopes: ["quote:pdf_write"],
  clientId: "client_configured",
  sessionId: "session_configured",
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    MCP_QUOTE_PDF_ENABLED: "true",
    MCP_QUOTE_PDF_BASE_URL: "https://pdf.example.invalid",
    MCP_QUOTE_PDF_ALLOWED_HOSTS: "pdf.example.invalid",
    MCP_QUOTE_PDF_TENANT_ID: context.tenantId,
    MCP_QUOTE_PDF_BEARER_TOKEN: token,
    ...overrides,
  };
}

function response(status = 201): Response {
  return new Response(JSON.stringify({
    document_ref: "01234567-89ab-cdef-0123-456789abcdef.pdf",
    sha256: "b".repeat(64),
    byte_length: 1,
    renderer_version: "renderer-8",
    template_version: "template-1",
    status: "ready",
    sendable: false,
    quote_id: "quote:startup:001",
    quote_version: "release-1:rule-1:data-1",
    release_id: "release-1",
    rule_version: "rule-1",
    data_version: "data-1",
    effective_date: "2026-08-14",
    snapshot_hash: `sha256:${"a".repeat(64)}`,
    release_hash: `sha256:${"a".repeat(64)}`,
    input_sha256: "c".repeat(64),
  }), { status, headers: { "content-type": "application/json" } });
}

describe("quote PDF startup configuration", () => {
  it("does not read or validate PDF secrets while disabled", () => {
    const base = createProductionApiAdapterSource();
    expect(createQuotePdfStartupOptions(base, { env: {} })).toEqual({});
    const disabledEnvironment = Object.create(null) as Record<string, string | undefined>;
    disabledEnvironment.MCP_QUOTE_PDF_ENABLED = "false";
    Object.defineProperty(disabledEnvironment, "MCP_QUOTE_PDF_BEARER_TOKEN", {
      get: () => { throw new Error("token must not be read while disabled"); },
    });

    expect(createQuotePdfStartupOptions(base, { env: disabledEnvironment })).toEqual({});
  });

  it("does not add a PDF startup reason while disabled", async () => {
    const composition = createProductionComposition({
      dataMode: "production",
      adapterSource: createProductionApiAdapterSource(),
    });
    try {
      const readiness = await composition.readiness();
      expect(readiness.reasons.filter((reason) => reason.includes("quote_pdf"))).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  it("fails closed for every required enabled setting without exposing values", () => {
    const required = [
      "MCP_QUOTE_PDF_BASE_URL",
      "MCP_QUOTE_PDF_ALLOWED_HOSTS",
      "MCP_QUOTE_PDF_TENANT_ID",
      "MCP_QUOTE_PDF_BEARER_TOKEN",
    ] as const;
    const base = createProductionApiAdapterSource();

    for (const name of required) {
      const values = environment();
      delete values[name];
      const result = createQuotePdfStartupOptions(base, { env: values });
      expect(result).toEqual({ quotePdfStartupFailure: "configuration_invalid" });
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });

  it.each([
    ["http://pdf.example.invalid", "pdf.example.invalid"],
    ["https://localhost", "localhost"],
    ["https://other.example.invalid", "pdf.example.invalid"],
    ["https://pdf.example.invalid", ""],
    ["https://127.0.0.1", "127.0.0.1"],
  ])("rejects unsafe base URL or allowlist (%s / %s)", (baseUrl, allowedHosts) => {
    const result = createQuotePdfStartupOptions(
      createProductionApiAdapterSource(),
      { env: environment({ MCP_QUOTE_PDF_BASE_URL: baseUrl, MCP_QUOTE_PDF_ALLOWED_HOSTS: allowedHosts }) },
    );
    expect(result).toEqual({ quotePdfStartupFailure: "configuration_invalid" });
  });

  it.each([
    "bad tenant",
    "",
  ])("rejects invalid configured tenant %s", (tenantId) => {
    expect(createQuotePdfStartupOptions(
      createProductionApiAdapterSource(),
      { env: environment({ MCP_QUOTE_PDF_TENANT_ID: tenantId }) },
    )).toEqual({ quotePdfStartupFailure: "configuration_invalid" });
  });

  it.each(["", "a".repeat(4097), "token with spaces", "token\nwith-control"]) (
    "rejects invalid bearer token",
    (bearerToken) => {
      expect(createQuotePdfStartupOptions(
        createProductionApiAdapterSource(),
        { env: environment({ MCP_QUOTE_PDF_BEARER_TOKEN: bearerToken }) },
      )).toEqual({ quotePdfStartupFailure: "configuration_invalid" });
    },
  );

  it("attaches the real adapter only for a valid config and binds credential to context tenant", async () => {
    const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn<FetchImplementation>((input, init) => {
      calls.push({ input, init });
      return Promise.resolve(response());
    });
    const baseHealth = vi.fn(() => Promise.resolve({ ready: true }));
    const baseClose = vi.fn(() => Promise.resolve());
    const base = { ...createProductionApiAdapterSource(), health: baseHealth, close: baseClose };
    const result = createQuotePdfStartupOptions(base, { env: environment(), fetchImpl });

    expect(result.quotePdfEnabled).toBe(true);
    expect(result).not.toHaveProperty("quotePdfStartupFailure");
    expect(result.adapterSource?.adapters.quote).toBe(base.adapters.quote);
    expect(result.adapterSource?.adapters.customs).toBe(base.adapters.customs);
    expect(Object.hasOwn(result.adapterSource?.adapters ?? {}, "quotePdf")).toBe(true);

    const pdf = result.adapterSource?.adapters.quotePdf;
    if (pdf === undefined) throw new Error("configured PDF adapter is missing");
    await expect(pdf.post({}, "commit-key-startup", {
      ...context,
      tenantId: "tenant_other",
    })).resolves.toMatchObject({
      ok: false,
      failure: { kind: "blocked", dispatched: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(pdf.post({}, "commit-key-startup", context)).resolves.toMatchObject({
      ok: true,
      status: 201,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = Object.fromEntries(new Headers(calls[0]?.init?.headers).entries());
    expect(headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "idempotency-key": "commit-key-startup",
    });
    expect(JSON.stringify(result)).not.toContain(token);
    await result.adapterSource?.health();
    await result.adapterSource?.close();
    expect(baseHealth).toHaveBeenCalledTimes(1);
    expect(baseClose).toHaveBeenCalledTimes(1);
  });

  it("passes the caller abort through the configured adapter without a second fetch", async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<FetchImplementation>((_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const source = createQuotePdfStartupOptions(
      createProductionApiAdapterSource(),
      { env: environment(), fetchImpl },
    );
    const pdf = source.adapterSource?.adapters.quotePdf;
    if (pdf === undefined) throw new Error("configured PDF adapter is missing");
    const controller = new AbortController();
    const pending = pdf.post({}, "commit-key-abort", context, controller.signal);
    await requestStarted;
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      failure: { kind: "manual_review", dispatched: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("keeps an invalid enabled config unavailable and blocks readiness with the standard reason", async () => {
    const composition = createProductionComposition({
      dataMode: "production",
      quotePdfStartupFailure: "configuration_invalid",
    });
    try {
      await expect(composition.readiness()).resolves.toMatchObject({ ready: false });
      const readiness = await composition.readiness();
      expect(readiness.reasons).toContain("production_quote_pdf_configuration_invalid");
      expect(composition.handlers["quote.create_pdf"]!({}, context)).toMatchObject({
        status: "unavailable",
        data: null,
      });
    } finally {
      await composition.close();
    }
  });

  it("keeps adapter-source helper failure separate from invalid PDF configuration", async () => {
    const malformedBase = {
      kind: "adapter_source",
      adapters: null,
      health: () => Promise.resolve({ ready: true }),
      close: () => Promise.resolve(),
    } as unknown as Parameters<typeof createQuotePdfStartupOptions>[0];
    const startup = createQuotePdfStartupOptions(malformedBase, { env: environment() });

    expect(startup).toEqual({ quotePdfStartupFailure: "adapter_source_invalid" });

    const composition = createProductionComposition({
      dataMode: "production",
      adapterSource: createProductionApiAdapterSource(),
      quotePdfEnabled: true,
      ...startup,
    });
    try {
      const readiness = await composition.readiness();
      expect(readiness.reasons).toContain("production_adapter_source_invalid");
      expect(readiness.reasons).not.toContain("production_quote_pdf_configuration_invalid");
      expect(readiness.reasons.filter((reason) => reason.includes("adapter_source") || reason.includes("quote_pdf")))
        .toEqual(["production_adapter_source_invalid"]);
      expect(composition.handlers["quote.create_pdf"]!({}, context)).toMatchObject({
        status: "unavailable",
        data: null,
      });
    } finally {
      await composition.close();
    }
  });

  it("maps one startup failure to one PDF readiness reason", async () => {
    const composition = createProductionComposition({
      dataMode: "production",
      adapterSource: createProductionApiAdapterSource(),
      quotePdfStartupFailure: "adapter_source_invalid",
    } as unknown as Parameters<typeof createProductionComposition>[0]);
    try {
      const readiness = await composition.readiness();
      expect(readiness.reasons.filter((reason) => reason.includes("quote_pdf") || reason.includes("adapter_source")))
        .toEqual(["production_adapter_source_invalid"]);
    } finally {
      await composition.close();
    }
  });
});
