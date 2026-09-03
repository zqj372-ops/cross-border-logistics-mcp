import { describe, expect, it, vi } from "vitest";

import {
  createCodexAuthorizationHeaders,
  exchangeCredential,
} from "../../deploy/clients/freightclaw-auth-headers.mjs";

const API_KEY = `lmcpk_key_codex_test_${"A".repeat(43)}`;
const ACCESS_TOKEN = "header.payload.signature";
const REQUEST_ID = "req_codex_helper_test_001";
const TOOLS = [
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
];

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    schema_version: "2026-08-27.v1",
    status: "success",
    data: {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 300,
      tool_names: TOOLS,
      session_ref: "auth_codex_helper_test_001",
      request_id: REQUEST_ID,
      ...overrides,
    },
    warnings: [],
    blockers: [],
  }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("Codex dynamic FreightClaw authorization helper", () => {
  it("exchanges a Keychain credential for exact short-lived T0 authorization headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(successResponse());

    const headers = await createCodexAuthorizationHeaders({
      readCredential: () => Promise.resolve(API_KEY),
      fetchImpl,
      requestIdFactory: () => REQUEST_ID,
    });

    expect(headers).toEqual({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://www.freightclaw.net/access/v1/token/exchange");
    expect(init?.method).toBe("POST");
    const requestHeaders = new Headers(init?.headers);
    expect(requestHeaders.get("authorization")).toBe(`ApiKey ${API_KEY}`);
    expect(requestHeaders.get("origin")).toBe("https://www.freightclaw.net");
    expect(requestHeaders.get("x-request-id")).toBe(REQUEST_ID);
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
    expect(JSON.parse(init.body)).toEqual({
      schema_version: "2026-08-27.v1",
      requested_tool_names: TOOLS,
    });
  });

  it("fails closed on catalog drift without including the long credential", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(successResponse({
      tool_names: ["cargo.calculate"],
    })));

    let failure: unknown;
    try {
      await exchangeCredential({
        apiKey: API_KEY,
        fetchImpl,
        requestIdFactory: () => REQUEST_ID,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "exchange_contract_invalid" });
    expect(String(failure)).not.toContain(API_KEY);
  });

  it("maps authentication failures to a bounded error without echoing response details", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      status: "blocked",
      code: "authentication_failed",
      detail: API_KEY,
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })));

    let failure: unknown;
    try {
      await createCodexAuthorizationHeaders({
        readCredential: () => Promise.resolve(API_KEY),
        fetchImpl,
        requestIdFactory: () => REQUEST_ID,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "authentication_failed" });
    expect(String(failure)).not.toContain(API_KEY);
  });
});
