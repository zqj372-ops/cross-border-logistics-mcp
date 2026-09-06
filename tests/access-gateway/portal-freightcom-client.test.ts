import { describe, expect, it, vi } from "vitest";

import {
  createFreightcomPortalClient,
  type FreightcomCredentialProvider,
} from "../../services/access-gateway/portal/business/freightcom-client.js";

const NOW = new Date("2026-09-05T12:00:00Z");
const REQUEST_ID = "req_freightcom_00000001";

function rateInput() {
  return {
    services: ["service-ltl-1"],
    details: {
      origin: {
        address: {
          address_line_1: "10 Origin Rd",
          city: "Toronto",
          region: "ON",
          country: "CA",
          postal_code: "M5V 2T6",
        },
        residential: false,
        tailgate_required: false,
      },
      destination: {
        address: {
          address_line_1: "20 Destination Ave",
          city: "Vancouver",
          region: "BC",
          country: "CA",
          postal_code: "V6B 1A1",
        },
        residential: false,
        tailgate_required: true,
        ready_at: { hour: 9, minute: 0 },
        ready_until: { hour: 16, minute: 0 },
        signature_requirement: "not-required" as const,
      },
      expected_ship_date: { year: 2026, month: 9, day: 8 },
      packaging_type: "pallet" as const,
      packaging_properties: {
        pallet_type: "ltl" as const,
        has_stackable_pallets: false,
        pallets: [{
          measurements: {
            weight: { unit: "lb" as const, value: "500" },
            cuboid: { unit: "in" as const, l: "48", w: "40", h: "50" },
          },
          description: "machine parts",
          freight_class: "70",
          num_pieces: 1,
        }],
        pallet_service_details: {
          appointment_delivery: true,
          protect_from_freeze: true,
        },
      },
      shipment_classification: "B2B" as const,
    },
  };
}

function completedRate(overrides: Record<string, unknown> = {}) {
  return {
    status: { done: true, total: 1, complete: 1 },
    rates: [{
      carrier_name: "Carrier A",
      service_name: "LTL Standard",
      service_id: "service-ltl-1",
      valid_until: { year: 2026, month: 9, day: 7 },
      total: { currency: "CAD", value: "12345" },
      base: { currency: "CAD", value: "10000" },
      surcharges: [{ type: "fuel", amount: { currency: "CAD", value: "2000" } }],
      taxes: [{ type: "HST", amount: { currency: "CAD", value: "345" } }],
      transit_time_days: 4,
      paperless: false,
      customs_charge_data: {
        duties_and_taxes_surcharge_keys: ["HST"],
        is_rate_guaranteed: false,
      },
      ...overrides,
    }],
  };
}

function fixtureFetch(items: Array<{ status: number; body?: unknown; location?: string }>) {
  const calls: Array<{ url: string; init: RequestInit; body?: unknown }> = [];
  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const next = items.shift();
    if (!next) throw new Error("fixture exhausted");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      init: init ?? {},
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const responseInit: ResponseInit = { status: next.status };
    if (next.location !== undefined) responseInit.headers = { location: next.location };
    return Promise.resolve(new Response(JSON.stringify(next.body ?? {}), responseInit));
  });
  return { calls, fetchImpl };
}

const credentialProvider: FreightcomCredentialProvider = () => "production-api-key";

function client(fetchImpl: typeof fetch, provider = credentialProvider) {
  return createFreightcomPortalClient({
    connectionId: "connection-freightcom-ca-1",
    credentialProvider: provider,
    fetchImpl,
    clock: () => NOW,
    pollDelayMs: 0,
  });
}

describe("Freightcom portal production rate client", () => {
  it("submits and polls a production rate while preserving original CAD evidence", async () => {
    const fake = fixtureFetch([
      { status: 202, body: { request_id: "provider-rate-1" } },
      { status: 200, body: { status: { done: false, total: 1, complete: 0 }, rates: [] } },
      { status: 200, body: completedRate() },
    ]);

    const result = await client(fake.fetchImpl).preview({
      input: rateInput(),
      requestId: REQUEST_ID,
    });

    expect(result).toMatchObject({
      schema_version: "portal-freightcom-rate@2026-09-05.v1",
      status: "success",
      request_id: REQUEST_ID,
      saved: false,
      sendable: false,
      bookable: false,
      data: {
        provider: "freightcom",
        api_version: "2.10.0",
        environment: "production",
        read_only: true,
        provider_quote_authoritative: true,
        rates: [{
          service_id: "service-ltl-1",
          valid_until: "2026-09-07",
          total: { currency: "CAD", amount: "123.45", minor_value: "12345" },
          base: { currency: "CAD", amount: "100.00", minor_value: "10000" },
          surcharges: [{ type: "fuel", amount: { currency: "CAD", amount: "20.00", minor_value: "2000" } }],
          taxes: [{ type: "HST", amount: { currency: "CAD", amount: "3.45", minor_value: "345" } }],
        }],
      },
    });
    expect(result.source_refs).toHaveLength(1);
    expect(result.source_refs[0]).toMatchObject({
      system: "Freightcom Customer API",
      version: "freightcom-api@2.10.0",
      authority: "authoritative",
    });
    expect(result.source_refs[0]?.locator).not.toContain("provider-rate-1");
    expect(fake.calls.map((call) => call.url)).toEqual([
      "https://external-api.freightcom.com/rate",
      "https://external-api.freightcom.com/rate/provider-rate-1",
      "https://external-api.freightcom.com/rate/provider-rate-1",
    ]);
    expect(fake.calls[0]?.body).toMatchObject({
      details: {
        packaging_properties: {
          pallets: [{ measurements: { weight: { value: 500 }, cuboid: { l: 48, w: 40, h: 50 } } }],
        },
      },
    });
    for (const call of fake.calls) {
      expect(new Headers(call.init.headers).get("authorization")).toBe("production-api-key");
      expect(call.init.redirect).toBe("error");
    }
  });

  it("fails before credential or network access for invalid closed input", async () => {
    const fetchImpl = vi.fn();
    const provider = vi.fn();
    const invalid = { ...rateInput(), tenant_id: "attacker-tenant" };
    const result = await client(fetchImpl as typeof fetch, provider).preview({ input: invalid, requestId: REQUEST_ID });
    expect(result).toMatchObject({ status: "needs_input", reason_codes: ["freightcom_request_invalid"] });
    expect(provider).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the credential is absent or rejected and never returns it", async () => {
    const noCredentialFetch = vi.fn();
    const missing = await client(noCredentialFetch as typeof fetch, () => "").preview({ input: rateInput(), requestId: REQUEST_ID });
    expect(missing).toMatchObject({ status: "unavailable", reason_codes: ["freightcom_credential_unavailable"] });
    expect(noCredentialFetch).not.toHaveBeenCalled();

    const deniedFetch = fixtureFetch([{ status: 401, body: { message: "secret production-api-key" } }]);
    const denied = await client(deniedFetch.fetchImpl).preview({ input: rateInput(), requestId: REQUEST_ID });
    expect(denied).toMatchObject({ status: "blocked", reason_codes: ["freightcom_authorization_rejected"] });
    expect(JSON.stringify(denied)).not.toContain("production-api-key");
  });

  it("keeps incomplete, expired, mixed-currency, or unsupported-currency rates in manual review", async () => {
    for (const rate of [
      { service_id: undefined },
      { valid_until: { year: 2026, month: 9, day: 4 } },
      { base: { currency: "USD", value: "10000" } },
      { total: { currency: "JPY", value: "12345" } },
    ]) {
      const fake = fixtureFetch([
        { status: 202, body: { request_id: "provider-rate-2" } },
        { status: 200, body: completedRate(rate) },
      ]);
      const result = await client(fake.fetchImpl).preview({ input: rateInput(), requestId: REQUEST_ID });
      expect(result.status).toBe("manual_review");
      expect(result.data?.provider_quote_authoritative).toBe(false);
      expect(result.sendable).toBe(false);
      expect(result.bookable).toBe(false);
    }
  });

  it("maps bounded polling, redirects, and unsafe base URLs to unavailable without fallback", async () => {
    const pending = fixtureFetch([
      { status: 202, body: { request_id: "provider-rate-3" } },
      { status: 200, body: { status: { done: false, total: 1, complete: 0 }, rates: [] } },
    ]);
    const limited = createFreightcomPortalClient({
      connectionId: "connection-freightcom-ca-1",
      credentialProvider,
      fetchImpl: pending.fetchImpl,
      clock: () => NOW,
      maxPollAttempts: 1,
      pollDelayMs: 0,
    });
    await expect(limited.preview({ input: rateInput(), requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable",
      reason_codes: ["freightcom_poll_incomplete"],
    });

    const redirected = fixtureFetch([{ status: 302, location: "https://attacker.invalid" }]);
    await expect(client(redirected.fetchImpl).preview({ input: rateInput(), requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable",
      reason_codes: ["freightcom_upstream_redirect_rejected"],
    });

    const unsafeFetch = vi.fn();
    const unsafe = createFreightcomPortalClient({
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
      connectionId: "connection-freightcom-ca-1",
      credentialProvider,
      fetchImpl: unsafeFetch as typeof fetch,
    });
    await expect(unsafe.preview({ input: rateInput(), requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable",
      reason_codes: ["freightcom_connection_unconfigured"],
    });
    expect(unsafeFetch).not.toHaveBeenCalled();
  });

  it("fails closed on malformed, oversized, and timed-out upstream responses", async () => {
    const malformed = fixtureFetch([{ status: 202, body: { request_id: "bad id with spaces" } }]);
    await expect(client(malformed.fetchImpl).preview({ input: rateInput(), requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable",
      reason_codes: ["freightcom_accepted_response_invalid"],
    });

    const oversized = fixtureFetch([{ status: 202, body: { ignored: "x".repeat(1_000) } }]);
    const bounded = createFreightcomPortalClient({
      connectionId: "connection-freightcom-ca-1",
      credentialProvider,
      fetchImpl: oversized.fetchImpl,
      maxBodyBytes: 100,
    });
    await expect(bounded.preview({ input: rateInput(), requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable",
      reason_codes: ["freightcom_upstream_response_too_large"],
    });

    const timedFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("sensitive provider detail", "AbortError"));
      }, { once: true });
    });
    const timed = createFreightcomPortalClient({
      connectionId: "connection-freightcom-ca-1",
      credentialProvider,
      fetchImpl: timedFetch,
      timeoutMs: 1,
    });
    await expect(timed.preview({ input: rateInput(), requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable",
      reason_codes: ["freightcom_upstream_timeout"],
    });
  });
});
