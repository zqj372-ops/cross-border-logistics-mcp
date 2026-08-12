import { describe, expect, it } from "vitest";

import {
  HttpQuoteSource,
  type HttpQuoteSourceOptions,
} from "../../src/logistics_mcp/adapters/quote/http-quote-source";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client";

const sourceOptions = (
  fetchImpl: FetchImplementation,
  overrides: Partial<HttpQuoteSourceOptions> = {},
): HttpQuoteSourceOptions => ({
  baseUrl: "https://quote.example.invalid",
  allowedHosts: ["quote.example.invalid"],
  fetchImpl,
  enabled: true,
  clock: () => new Date("2026-08-11T12:00:00Z"),
  ...overrides,
});

function lookupInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address_line: "Fixture address",
    postal_code: "A0A 0A0",
    city: "Fixture City",
    province: "ON",
    cbm: "4.20",
    weight_kg: "100.00",
    piece_count: 2,
    packaging_type: "pallet",
    longest_side_cm: null,
    address_type: "commercial",
    requires_liftgate: false,
    requires_pallet_jack: false,
    requires_appointment: true,
    explicit_pallet_count: 2,
    is_stackable: null,
    detention_minutes: 0,
    ...overrides,
  };
}

function successResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "quote-result@fixture-1",
    quote_id: "quote-http-fixture-001",
    source_type: "zone_matrix",
    confidence: 90,
    postal_code: "A0A 0A0",
    origin: "fixture-warehouse",
    zone: 2,
    billing_pallets: 2,
    base_price_usd: "100.00",
    fuel_usd: "10.00",
    fuel_percent: "10.00",
    accessorials: { appointment_fee_usd: "5.00" },
    total_price_usd: "115.00",
    manual_review_required: false,
    matched_by: "postal_fsa_exact",
    candidate_count: 1,
    rule_version: "zone-rule@fixture-1",
    data_version: "zone-price@fixture-1",
    valid_from: "2026-08-01",
    valid_to: "2026-08-31",
    ...overrides,
  };
}

function jsonFetch(
  body: unknown,
  calls: Array<{ input: string | URL | Request; init?: RequestInit }>,
): FetchImplementation {
  return async (input, init) => {
    const call: { input: string | URL | Request; init?: RequestInit } = { input };
    if (init !== undefined) call.init = init;
    calls.push(call);
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };
}

describe("HTTP quote upstream source", () => {
  it("is disabled by default without calling fetch", async () => {
    let calls = 0;
    const source = new HttpQuoteSource({
      baseUrl: "https://quote.example.invalid",
      allowedHosts: ["quote.example.invalid"],
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}");
      },
    });

    await expect(source.lookup(lookupInput())).rejects.toMatchObject({
      code: "upstream_disabled",
    });
    expect(calls).toBe(0);
  });

  it("calls only the read-only zone route once and maps versioned money", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const source = new HttpQuoteSource(
      sourceOptions(jsonFetch(successResponse(), calls)),
    );

    const result = await source.lookup(lookupInput());

    expect(result).toMatchObject({
      status: "matched",
      quote_id: "quote-http-fixture-001",
      zone: 2,
      base_price: { amount: "100.00", currency: "USD" },
      fuel_percent: "10.00",
      rule_version: "zone-rule@fixture-1",
      data_version: "zone-price@fixture-1",
      valid_from: "2026-08-01",
      valid_to: "2026-08-31",
      matched_by: "postal_fsa_exact",
      accessorials: {
        appointment_fee: { amount: "5.00", currency: "USD" },
      },
      source_ref: {
        system: "existing-quote-system",
        version: "zone-price@fixture-1",
      },
    });
    expect(calls).toHaveLength(1);
    const requestUrl = String(calls[0]?.input);
    expect(requestUrl).toBe("https://quote.example.invalid/quotes/zone-calculate");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      quote: {
        postal_code: "A0A 0A0",
        cbm: "4.20",
        weight_kg: "100.00",
        address_type: "commercial",
      },
      notify_email: false,
      notify_wecom: false,
    });
    expect(JSON.stringify(calls[0]?.init?.body)).not.toContain("ai-auto-quote");
  });

  it("fails closed for missing versions, missing prices, and incomplete input", async () => {
    const missingVersionCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const missingVersion = new HttpQuoteSource(
      sourceOptions(jsonFetch(successResponse({ data_version: undefined }), missingVersionCalls)),
    );
    await expect(missingVersion.lookup(lookupInput())).rejects.toMatchObject({
      code: "quote_upstream_contract_invalid",
    });

    const noPriceCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const noPrice = new HttpQuoteSource(
      sourceOptions(
        jsonFetch(
          successResponse({
            base_price_usd: null,
            fuel_usd: null,
            fuel_percent: null,
            total_price_usd: null,
          }),
          noPriceCalls,
        ),
      ),
    );
    await expect(noPrice.lookup(lookupInput())).resolves.toMatchObject({
      status: "price_missing",
      base_price: null,
      fuel_percent: null,
    });

    const invalidInputCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const invalidInput = new HttpQuoteSource(
      sourceOptions(jsonFetch(successResponse(), invalidInputCalls)),
    );
    await expect(
      invalidInput.lookup(lookupInput({ address_type: "unknown" })),
    ).rejects.toMatchObject({ code: "upstream_request_invalid" });
    await expect(
      invalidInput.lookup(lookupInput({ cbm: undefined })),
    ).rejects.toMatchObject({ code: "upstream_request_invalid" });
    expect(invalidInputCalls).toHaveLength(0);
  });

  it.each([
    [400, "upstream_http_error"],
    [500, "upstream_http_error"],
  ] as const)("does not expose a %s upstream response", async (status, code) => {
    const source = new HttpQuoteSource(
      sourceOptions(async () => new Response("secret upstream body", { status })),
    );

    await expect(source.lookup(lookupInput())).rejects.toMatchObject({ code });
    await expect(source.lookup(lookupInput())).rejects.not.toThrow("secret upstream body");
  });

  it("inherits timeout, redirect, allowlist, and credential protections", async () => {
    const timeoutSource = new HttpQuoteSource(
      sourceOptions(() => new Promise<Response>(() => undefined), { timeoutMs: 5 }),
    );
    await expect(timeoutSource.lookup(lookupInput())).rejects.toMatchObject({
      code: "upstream_timeout",
    });

    const redirectSource = new HttpQuoteSource(
      sourceOptions(async (_input, init) => {
        expect(init?.redirect).toBe("error");
        return new Response("", {
          status: 302,
          headers: { location: "https://other.example.invalid" },
        });
      }),
    );
    await expect(redirectSource.lookup(lookupInput())).rejects.toMatchObject({
      code: "upstream_redirect_rejected",
    });

    expect(() =>
      new HttpQuoteSource({
        baseUrl: "https://not-allowlisted.example.invalid",
        allowedHosts: ["quote.example.invalid"],
        enabled: true,
      }),
    ).toThrow(/allowlist|host/i);

    const secret = "fixture-secret-value";
    const credentialSource = new HttpQuoteSource(
      sourceOptions(() => new Promise<Response>(() => undefined), {
        timeoutMs: 5,
        headers: { Authorization: `Bearer ${secret}` },
      }),
    );
    await expect(credentialSource.lookup(lookupInput())).rejects.not.toThrow(secret);
  });

  it("keeps saveDraft and readDraft explicitly read-only with zero network calls", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const source = new HttpQuoteSource(
      sourceOptions(jsonFetch(successResponse(), calls)),
    );

    await expect(source.saveDraft({})).rejects.toMatchObject({
      code: "upstream_disabled",
    });
    await expect(source.readDraft("record-fixture-001", "tenant-fixture-001")).rejects.toMatchObject({
      code: "upstream_disabled",
    });
    expect(calls).toHaveLength(0);
  });
});
