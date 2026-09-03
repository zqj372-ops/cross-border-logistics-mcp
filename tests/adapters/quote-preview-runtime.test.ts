import { describe, expect, it, vi } from "vitest";

import {
  createQuotePreviewAdapterFromEnvironment,
} from "../../src/logistics_mcp/adapters/quote/quote-runtime.js";

function runtimeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MCP_QUOTE_PREVIEW_ENABLED: "true",
    MCP_QUOTE_PREVIEW_BASE_URL: "https://quote.example.invalid",
    MCP_QUOTE_PREVIEW_ALLOWED_HOSTS: "quote.example.invalid",
    MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid,quote.example.invalid",
    MCP_QUOTE_PREVIEW_API_KEY_SECRET_FILE: "/run/secrets/quote-preview-api-key",
    MCP_QUOTE_PREVIEW_ORIGIN_MAP_FILE: "/run/config/quote-origin-map.json",
    ...overrides,
  };
}

const originMap = JSON.stringify({
  schema_version: "2026-09-02.v1",
  tenants: {
    "tenant-a": {
      "warehouse-toronto": "toronto",
      "warehouse-calgary": "calgary",
    },
  },
});

describe("quote preview worker runtime configuration", () => {
  it("stays disabled unless every server-owned reference is present", async () => {
    await expect(createQuotePreviewAdapterFromEnvironment({})).resolves.toBeUndefined();
    await expect(createQuotePreviewAdapterFromEnvironment(runtimeEnv({
      MCP_QUOTE_PREVIEW_API_KEY_SECRET_FILE: undefined,
    }))).resolves.toBeUndefined();
  });

  it("accepts only HTTPS hosts present in both quote and global egress allowlists", async () => {
    await expect(createQuotePreviewAdapterFromEnvironment(runtimeEnv({
      MCP_QUOTE_PREVIEW_BASE_URL: "http://quote.example.invalid",
    }), { readConfigFile: () => originMap })).resolves.toBeUndefined();
    await expect(createQuotePreviewAdapterFromEnvironment(runtimeEnv({
      MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid",
    }), { readConfigFile: () => originMap })).resolves.toBeUndefined();
  });

  it("loads a closed tenant warehouse map without reading the API key at startup", async () => {
    const readConfigFile = vi.fn(() => originMap);
    const readSecretFile = vi.fn(() => "quote-secret-value");
    const adapter = await createQuotePreviewAdapterFromEnvironment(
      runtimeEnv(),
      { readConfigFile, readSecretFile },
    );

    expect(adapter).toBeDefined();
    expect(readConfigFile).toHaveBeenCalledWith("/run/config/quote-origin-map.json");
    expect(readSecretFile).not.toHaveBeenCalled();
  });

  it.each([
    JSON.stringify({ schema_version: "2026-09-02.v1", tenants: {}, extra: true }),
    JSON.stringify({ schema_version: "2026-09-02.v1", tenants: { "tenant a": { wh: "toronto" } } }),
    JSON.stringify({ schema_version: "2026-09-02.v1", tenants: { "tenant-a": { wh: "vancouver" } } }),
  ])("rejects an invalid or open-ended origin map", async (invalidMap) => {
    await expect(createQuotePreviewAdapterFromEnvironment(
      runtimeEnv(),
      { readConfigFile: () => invalidMap },
    )).resolves.toBeUndefined();
  });
});
