import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  FreightcomRateAdapter,
  freightcomRateRequestSchema,
  freightcomRatePollResponseSchema,
  toFreightcomProviderRateRequest,
  type FreightcomRateAdapterOptions,
} from "../../src/logistics_mcp/adapters/quote/freightcom-rate-adapter";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client";

const BASE_URL = "https://external-api.freightcom.com";
const ALLOWED_HOSTS = ["external-api.freightcom.com"];
const realPollResponses = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/freightcom-rate-poll-responses.json", import.meta.url)), "utf8"),
) as unknown[];

function rateRequest(): Record<string, unknown> {
  return {
    services: ["service-fixture-001"],
    details: {
      origin: {
        name: "Fixture Origin",
        address: {
          address_line_1: "1 Origin Way",
          city: "Toronto",
          region: "ON",
          country: "CA",
          postal_code: "M1M 1M1",
        },
      },
      destination: {
        name: "Fixture Destination",
        address: {
          address_line_1: "2 Destination Way",
          city: "Montreal",
          region: "QC",
          country: "CA",
          postal_code: "H1H 1H1",
        },
        ready_at: { hour: 9, minute: 0 },
        ready_until: { hour: 17, minute: 0 },
        signature_requirement: "not-required",
      },
      expected_ship_date: { year: 2026, month: 8, day: 21 },
      packaging_type: "pallet",
      packaging_properties: {
        pallet_type: "ltl",
        pallets: [
          {
            measurements: {
              weight: { unit: "lb", value: "100.125" },
              cuboid: { unit: "ft", l: "4.125", w: "4", h: "4" },
            },
            description: "Fixture freight",
            freight_class: "70",
          },
        ],
      },
    },
  };
}

function adapter(
  fetchImpl: FetchImplementation,
  overrides: Partial<FreightcomRateAdapterOptions> = {},
): FreightcomRateAdapter {
  return new FreightcomRateAdapter({
    mode: "fixtures",
    baseUrl: BASE_URL,
    allowedHosts: ALLOWED_HOSTS,
    fetchImpl,
    headerProvider: () => ({ Authorization: "Bearer fixture-authorization" }),
    pollDelayMs: 0,
    clock: () => new Date("2026-08-21T14:30:00.000Z"),
    ...overrides,
  });
}

describe("Freightcom rate adapter", () => {
  it("accepts the sanitized real test response fixture shape", () => {
    const parsed = realPollResponses.map((response) => freightcomRatePollResponseSchema.parse(response));

    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.status).toEqual({ done: false, total: 146, complete: 99 });
    expect(parsed[1]?.status).toEqual({ done: false, total: 146, complete: 125 });
    expect(parsed[2]?.status).toEqual({ done: true, total: 146, complete: 146 });
    expect(parsed[2]?.rates).toHaveLength(9);
    expect(parsed[2]?.rates[0]).toMatchObject({
      carrier_name: "Apex",
      service_name: "Standard",
      service_id: "apex.standard",
      customs_charge_data: {
        duties_and_taxes_surcharge_keys: null,
        is_rate_guaranteed: false,
      },
      truck_details_ftl: "",
      transit_mode_ftl: "",
    });
  });

  it("polls the captured real response sequence without rejecting provider fields", async () => {
    let pollIndex = 0;
    const fetchImpl = vi.fn<FetchImplementation>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/rate") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ request_id: "rate-real-fixture-001" }), { status: 202 }));
      }
      const response = realPollResponses[pollIndex++];
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    });

    const result = await adapter(fetchImpl, { maxPollAttempts: 3 }).requestRate(rateRequest());

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({
      request_id: "rate-real-fixture-001",
      status: { done: true, total: 146, complete: 146 },
    });
    expect(result.data?.rates).toHaveLength(9);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("validates the narrow pallet rate request shape", () => {
    expect(freightcomRateRequestSchema.safeParse(rateRequest()).success).toBe(true);
    const numericWeight = structuredClone(rateRequest()) as {
      details: { packaging_properties: { pallets: Array<{ measurements: { weight: { value: unknown } } }> } };
    };
    numericWeight.details.packaging_properties.pallets[0]!.measurements.weight.value = 100.125;
    expect(freightcomRateRequestSchema.safeParse(numericWeight).success).toBe(false);
    const numericDimension = structuredClone(rateRequest()) as {
      details: { packaging_properties: { pallets: Array<{ measurements: { cuboid: { l: unknown } } }> } };
    };
    numericDimension.details.packaging_properties.pallets[0]!.measurements.cuboid.l = 4.125;
    expect(freightcomRateRequestSchema.safeParse(numericDimension).success).toBe(false);
    expect(freightcomRateRequestSchema.safeParse({
      details: { packaging_type: "pallet" },
    }).success).toBe(false);
  });

  it("converts decimal-string measurements only at the provider boundary", () => {
    const request = freightcomRateRequestSchema.parse(rateRequest());
    const providerRequest = toFreightcomProviderRateRequest(request);

    expect(providerRequest).toMatchObject({
      details: {
        packaging_properties: {
          pallets: [{
            measurements: {
              weight: { value: 100.125 },
              cuboid: { l: 4.125, w: 4, h: 4 },
            },
          }],
        },
      },
    });
    expect(request).toMatchObject({
      details: {
        packaging_properties: {
          pallets: [{
            measurements: {
              weight: { value: "100.125" },
              cuboid: { l: "4.125", w: "4", h: "4" },
            },
          }],
        },
      },
    });
  });

  it("rejects measurements that would change when serialized as provider numbers", async () => {
    const precisionLosingWeight = structuredClone(rateRequest()) as {
      details: {
        packaging_properties: {
          pallets: Array<{ measurements: { weight: { value: string } } }>;
        };
      };
    };
    precisionLosingWeight.details.packaging_properties.pallets[0]!
      .measurements.weight.value = "9007199254740993";
    const precisionLosingLength = structuredClone(rateRequest()) as {
      details: {
        packaging_properties: {
          pallets: Array<{ measurements: { cuboid: { l: string } } }>;
        };
      };
    };
    precisionLosingLength.details.packaging_properties.pallets[0]!
      .measurements.cuboid.l = "0.10000000000000001";
    const fetchImpl = vi.fn<FetchImplementation>();

    for (const request of [precisionLosingWeight, precisionLosingLength]) {
      const result = await adapter(fetchImpl).requestRate(request);

      expect(result.status).toBe("needs_input");
      expect(result.blockers?.map((item) => item.code)).toContain(
        "freightcom.request_invalid",
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("converts public decimal insurance money to provider minor units only at the boundary", () => {
    const requestWithInsurance = structuredClone(rateRequest()) as {
      details: Record<string, unknown>;
    };
    requestWithInsurance.details.insurance = {
      type: "carrier",
      total_cost: { amount: "125.50", currency: "USD" },
    };
    const request = freightcomRateRequestSchema.parse(requestWithInsurance);

    expect(toFreightcomProviderRateRequest(request)).toMatchObject({
      details: {
        insurance: {
          type: "carrier",
          total_cost: { value: "12550", currency: "USD" },
        },
      },
    });
    expect(request.details.insurance?.total_cost).toEqual({
      amount: "125.50",
      currency: "USD",
    });
  });

  it("rejects impossible calendar dates before any provider request", async () => {
    const impossibleDate = structuredClone(rateRequest()) as {
      details: { expected_ship_date: { year: number; month: number; day: number } };
    };
    impossibleDate.details.expected_ship_date = { year: 2026, month: 2, day: 31 };
    const fetchImpl = vi.fn<FetchImplementation>();

    const result = await adapter(fetchImpl).requestRate(impossibleDate);

    expect(result.status).toBe("needs_input");
    expect(result.blockers?.map((item) => item.code)).toContain("freightcom.request_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([400, 409, 422])(
    "maps a provider POST /rate field rejection with HTTP %s to sanitized needs_input",
    async (status) => {
      const fetchImpl = vi.fn<FetchImplementation>(() => Promise.resolve(new Response(
        JSON.stringify({ message: "private provider field detail" }),
        { status },
      )));

      const result = await adapter(fetchImpl).requestRate(rateRequest());

      expect(result.status).toBe("needs_input");
      expect(result.blockers).toEqual([expect.objectContaining({
        code: "freightcom.test_request_rejected",
        field: "input",
      })]);
      expect(JSON.stringify(result)).not.toContain("private provider field detail");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("runs fixture POST /rate then GET /rate/{request_id} and keeps fixture data at manual review", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    const fetchImpl = vi.fn<FetchImplementation>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      });
      if (url.endsWith("/rate") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ request_id: "rate-fixture-001" }), { status: 202 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        status: { done: true, total: 1, complete: 1 },
        rates: [{
          carrier_name: "Fixture Carrier",
          service_name: "Fixture LTL",
          service_id: "service-fixture-001",
          total: { currency: "CAD", value: "12500" },
          base: { currency: "CAD", value: "10000" },
          surcharges: [{ type: "fuel", amount: { currency: "CAD", value: "2500" } }],
        }],
      }), { status: 200 }));
    });

    const result = await adapter(fetchImpl).requestRate(rateRequest());

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({
      provider: "freightcom",
      environment: "fixture",
      request_id: "rate-fixture-001",
      status: { done: true, total: 1, complete: 1 },
    });
    expect(result.blockers?.map((item) => item.code)).toEqual([
      "freightcom.fixture_data",
      "freightcom.release_evidence_missing",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: `${BASE_URL}/rate`,
      method: "POST",
      body: {
        details: {
          packaging_properties: {
            pallets: [{
              measurements: {
                weight: { unit: "lb", value: 100.125 },
              },
            }],
          },
        },
      },
    });
    expect(calls[1]).toMatchObject({
      url: `${BASE_URL}/rate/rate-fixture-001`,
      method: "GET",
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer fixture-authorization");
    expect(JSON.stringify(result)).not.toContain("fixture-authorization");
  });

  it("bounds pending polling and returns unavailable without inventing rates", async () => {
    const fetchImpl = vi.fn<FetchImplementation>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/rate") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ request_id: "rate-pending-001" }), { status: 202 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        status: { done: false, total: 2, complete: 1 },
        rates: [],
      }), { status: 200 }));
    });

    const result = await adapter(fetchImpl, { maxPollAttempts: 2 }).requestRate(rateRequest());

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(result.blockers?.map((item) => item.code)).toContain("freightcom.rate_poll_timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps production calls unavailable and never invokes fetch", async () => {
    const fetchImpl = vi.fn<FetchImplementation>(() => {
      throw new Error("real Freightcom calls are disabled");
    });
    const result = await adapter(fetchImpl, { mode: "production" }).requestRate(rateRequest());

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map((item) => item.code)).toContain("freightcom.production_disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the accepted response has no request id", async () => {
    const fetchImpl = vi.fn<FetchImplementation>(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 202 })),
    );

    const result = await adapter(fetchImpl).requestRate(rateRequest());

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map((item) => item.code)).toContain("freightcom.accepted_response_invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
