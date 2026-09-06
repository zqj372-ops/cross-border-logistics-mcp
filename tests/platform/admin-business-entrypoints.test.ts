import { describe, expect, it } from "vitest";

import { businessEntrypointsFromEnvironment } from "../../src/logistics_mcp/server/admin-business-entrypoints";

describe("admin business entrypoint metadata", () => {
  it("builds only the five fixed paths from independently configured HTTPS origins", () => {
    expect(businessEntrypointsFromEnvironment({
      MCP_QUOTE_UI_ORIGIN: "https://quote.example.com",
      MCP_CUSTOMS_UI_ORIGIN: "https://customs.example.com:8443",
    }, "production")).toEqual({
      schema_version: "business-entrypoints@2026-09-05.v1",
      status: "success",
      data: {
        quote: {
          configured: true,
          sales: "https://quote.example.com/quote",
          ai_quote: "https://quote.example.com/ai-quote",
          operations: "https://quote.example.com/ops",
        },
        customs: {
          configured: true,
          search: "https://customs.example.com:8443/",
          calculator: "https://customs.example.com:8443/calculator",
        },
      },
      reason_codes: [],
    });
  });

  it("keeps missing and invalid service configuration independent without reflecting input", () => {
    const metadata = businessEntrypointsFromEnvironment({
      MCP_QUOTE_UI_ORIGIN: "https://user:secret@private.example/quote?token=secret",
    }, "production");
    expect(metadata).toEqual({
      schema_version: "business-entrypoints@2026-09-05.v1",
      status: "success",
      data: {
        quote: { configured: false, sales: null, ai_quote: null, operations: null },
        customs: { configured: false, search: null, calculator: null },
      },
      reason_codes: ["quote_entrypoint_invalid", "customs_entrypoint_unconfigured"],
    });
    expect(JSON.stringify(metadata)).not.toMatch(/secret|private\.example/u);
  });

  it("allows HTTP only for literal loopback origins in fixture mode", () => {
    expect(businessEntrypointsFromEnvironment({
      MCP_QUOTE_UI_ORIGIN: "http://127.0.0.1:4173",
      MCP_CUSTOMS_UI_ORIGIN: "http://localhost:8090",
    }, "fixtures").data).toMatchObject({
      quote: { configured: true, sales: "http://127.0.0.1:4173/quote" },
      customs: { configured: true, search: "http://localhost:8090/" },
    });
    for (const value of [
      "http://example.com",
      "http://127.0.0.1.example.com",
      "https://example.com/path",
      "https://example.com/?q=x",
      "https://example.com/#x",
      "https://example.com/%2e%2e",
      "https://example.com/%0aevil",
      " javascript:alert(1)",
      "https:////example.com",
      "https:\\example.com",
      "https://2130706433",
      "https://0177.0.0.1",
      "https://127.0.0.1.",
      "https://EXAMPLE.com",
      "https://example.com:443",
    ]) {
      expect(businessEntrypointsFromEnvironment({ MCP_QUOTE_UI_ORIGIN: value }, "fixtures").data.quote)
        .toEqual({ configured: false, sales: null, ai_quote: null, operations: null });
    }
  });

  it("is a pure configuration projection and performs no fetch", () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => { calls += 1; throw new Error("network forbidden"); });
    try {
      businessEntrypointsFromEnvironment({ MCP_QUOTE_UI_ORIGIN: "https://quote.example" }, "production");
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
