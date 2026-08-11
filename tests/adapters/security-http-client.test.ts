import { describe, expect, it } from "vitest";

import {
  createFetchJsonClient,
  HttpAdapterError,
  redactCredentialHeaders,
} from "../../src/logistics_mcp/adapters/http-client";

describe("allowlisted upstream HTTP client", () => {
  it("rejects non-HTTPS and hosts outside the explicit allowlist", async () => {
    expect(() =>
      createFetchJsonClient({
        baseUrl: "http://quote.example.invalid",
        allowedHosts: ["quote.example.invalid"],
        enabled: true,
      }),
    ).toThrow(/HTTPS/i);

    const client = createFetchJsonClient({
      baseUrl: "https://quote.example.invalid",
      allowedHosts: ["quote.example.invalid"],
      enabled: true,
      fetchImpl: () => Promise.resolve(new Response("{}")),
    });

    await expect(client.get("https://169.254.169.254/latest/meta-data")).rejects.toMatchObject({
      code: "upstream_host_not_allowed",
    });
  });

  it("times out without including credentials in the error", async () => {
    const client = createFetchJsonClient({
      baseUrl: "https://quote.example.invalid",
      allowedHosts: ["quote.example.invalid"],
      enabled: true,
      timeoutMs: 5,
      fetchImpl: () => new Promise<Response>(() => undefined),
    });

    await expect(
      client.get("/api/status", { Authorization: "Bearer fixture-token-value" }),
    ).rejects.toMatchObject({ code: "upstream_timeout" });
    await expect(
      client.get("/api/status", { Authorization: "Bearer fixture-token-value" }),
    ).rejects.not.toThrow("fixture-token-value");
  });

  it("enforces response size and rejects redirects", async () => {
    const oversized = createFetchJsonClient({
      baseUrl: "https://quote.example.invalid",
      allowedHosts: ["quote.example.invalid"],
      enabled: true,
      maxResponseBytes: 10,
      fetchImpl: () =>
        Promise.resolve(new Response('{"large":true}', {
          headers: { "content-length": "100" },
        })),
    });
    await expect(oversized.get("/api/status")).rejects.toMatchObject({
      code: "upstream_response_too_large",
    });

    const redirected = createFetchJsonClient({
      baseUrl: "https://quote.example.invalid",
      allowedHosts: ["quote.example.invalid"],
      enabled: true,
      fetchImpl: (_input, init) => {
        expect(init?.redirect).toBe("error");
        return Promise.resolve(new Response("", {
          status: 302,
          headers: { location: "https://other.example.invalid" },
        }));
      },
    });
    await expect(redirected.get("/api/status")).rejects.toMatchObject({
      code: "upstream_redirect_rejected",
    });
  });

  it("redacts credential values before any diagnostic projection", () => {
    const redacted = redactCredentialHeaders({
      authorization: "Bearer fixture-token-value",
      "x-api-key": "fixture-api-key-value",
      cookie: "session=fixture-cookie-value",
      accept: "application/json",
    });

    expect(redacted).toEqual({
      authorization: "[redacted]",
      "x-api-key": "[redacted]",
      cookie: "[redacted]",
      accept: "application/json",
    });
    expect(JSON.stringify(redacted)).not.toContain("fixture-token-value");
  });

  it("keeps disabled production endpoints unavailable without calling fetch", async () => {
    const fetchImpl = (): Promise<Response> => {
      throw new Error("fetch must not be called");
    };
    const client = createFetchJsonClient({
      baseUrl: "https://quote.example.invalid",
      allowedHosts: ["quote.example.invalid"],
      fetchImpl,
    });

    await expect(client.get("/api/status")).rejects.toBeInstanceOf(HttpAdapterError);
    await expect(client.get("/api/status")).rejects.toMatchObject({
      code: "upstream_disabled",
    });
  });
});
