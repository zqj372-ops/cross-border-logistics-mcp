import { describe, expect, it, vi } from "vitest";

import type { FetchImplementation } from "../../../src/logistics_mcp/adapters/http-client";
import { createFreightcomTestRateClient } from "../../../src/logistics_mcp/adapters/quote/freightcom-test-client";

const REQUEST = {
  details: {
    origin: {
      address: {
        address_line_1: "1 Origin Way",
        city: "Toronto",
        region: "ON",
        country: "CA",
        postal_code: "M1M 1M1",
      },
    },
    destination: {
      address: {
        address_line_1: "2 Destination Way",
        city: "Chicago",
        region: "IL",
        country: "US",
        postal_code: "60601",
      },
      ready_at: { hour: 9, minute: 0 },
      ready_until: { hour: 17, minute: 0 },
      signature_requirement: "not-required",
    },
    expected_ship_date: { year: 2026, month: 8, day: 27 },
    packaging_type: "pallet",
    packaging_properties: {
      pallet_type: "ltl",
      pallets: [{
        measurements: {
          weight: { unit: "lb", value: 100 },
          cuboid: { unit: "in", l: 48, w: 40, h: 52 },
        },
        description: "Industrial parts",
        freight_class: "70",
      }],
    },
  },
};

describe("Freightcom test-only rate client", () => {
  it("uses the raw test token and validates POST then GET responses", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn<FetchImplementation>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(init === undefined ? { url } : { url, init });
      if (init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ request_id: "test-rate-001" }), { status: 202 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        status: { done: true, total: 1, complete: 1 },
        rates: [{
          carrier_name: "Apex",
          service_name: "Standard",
          service_id: "apex.standard",
          total: { currency: "CAD", value: "17936" },
        }],
      }), { status: 200 }));
    });
    const client = createFreightcomTestRateClient({
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
      token: "synthetic-test-credential",
      allowedHosts: ["customer-external-api.ssd-test.freightcom.com"],
      fetchImpl,
      clock: () => new Date("2026-08-21T15:00:00.000Z"),
    });

    const accepted = await client.submitRate(REQUEST);
    const polled = await client.pollRate(accepted.requestId);

    expect(accepted).toEqual({ requestId: "test-rate-001" });
    expect(polled.status).toEqual({ done: true, total: 1, complete: 1 });
    expect(polled.rates[0]?.total).toEqual({ currency: "CAD", value: "17936" });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("synthetic-test-credential");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).not.toContain("Bearer");
    expect(JSON.stringify(polled)).not.toContain("synthetic-test-credential");
  });

  it("fails closed on provider authentication failure", async () => {
    const fetchImpl = vi.fn<FetchImplementation>(() =>
      Promise.resolve(new Response("", { status: 401 })),
    );
    const client = createFreightcomTestRateClient({
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
      token: "synthetic-test-credential",
      allowedHosts: ["customer-external-api.ssd-test.freightcom.com"],
      fetchImpl,
    });

    await expect(client.submitRate(REQUEST)).rejects.toMatchObject({
      code: "freightcom.test_auth_failed",
      status: 401,
    });
  });
});
