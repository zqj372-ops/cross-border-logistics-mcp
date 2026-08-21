import { describe, expect, it, vi } from "vitest";

import { createQuoteApiHandler } from "../../../apps/freightcom-quote/server.mjs";

const VALID_REQUEST = {
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

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:56570${path}`, init);
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("Freightcom quote page API", () => {
  it("returns unavailable without revealing an unset token", async () => {
    const client = {
      submitRate: vi.fn(),
      pollRate: vi.fn(),
    };
    const handler = createQuoteApiHandler({
      client,
      tokenConfigured: false,
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
    });

    const response = await handler(request("/api/freightcom-test/rate", {
      method: "POST",
      body: JSON.stringify({ details: {} }),
      headers: { "content-type": "application/json" },
    }));
    const body = await responseBody(response);

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ status: "unavailable", code: "FREIGHTCOM_TEST_TOKEN_NOT_CONFIGURED" });
    expect(JSON.stringify(body)).not.toContain("Authorization");
    expect(client.submitRate).not.toHaveBeenCalled();
  });

  it("accepts a request handle and returns structured polling output", async () => {
    const client = {
      submitRate: vi.fn().mockResolvedValue({ requestId: "test-rate-002" }),
      pollRate: vi.fn().mockResolvedValue({
        status: { done: true, total: 1, complete: 1 },
        rates: [{
          carrier_name: "Apex",
          service_name: "Standard",
          service_id: "apex.standard",
          total: { currency: "CAD", value: "17936" },
        }],
        retrievedAt: "2026-08-21T15:00:00.000Z",
        sourceRef: {
          source_id: "src:freightcom:test-rate-002",
          source_type: "opaque_reference",
          system: "Freightcom Customer API",
          locator: "opaque://freightcom/rate/test-rate-002",
          version: "freightcom-api@2.10.0",
          retrieved_at: "2026-08-21T15:00:00.000Z",
          authority: "opaque",
        },
      }),
    };
    const handler = createQuoteApiHandler({
      client,
      tokenConfigured: true,
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
    });

    const accepted = await handler(request("/api/freightcom-test/rate", {
      method: "POST",
      body: JSON.stringify(VALID_REQUEST),
      headers: { "content-type": "application/json" },
    }));
    const acceptedBody = await responseBody(accepted);
    const polled = await handler(request("/api/freightcom-test/rate/test-rate-002"));
    const polledBody = await responseBody(polled);

    expect(accepted.status).toBe(202);
    expect(acceptedBody).toMatchObject({
      status: "success",
      data: { request_id: "test-rate-002" },
    });
    expect(polled.status).toBe(200);
    expect(polledBody).toMatchObject({
      status: "manual_review",
      data: {
        environment: "test",
        status: { done: true, total: 1, complete: 1 },
        rates: [{ total: { currency: "CAD", value: "17936" } }],
      },
    });
    expect(JSON.stringify(polledBody)).not.toContain("synthetic-test-credential");
  });

  it("rejects an unknown request id instead of proxying arbitrary paths", async () => {
    const handler = createQuoteApiHandler({
      client: { submitRate: vi.fn(), pollRate: vi.fn() },
      tokenConfigured: true,
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
    });

    const response = await handler(request("/api/freightcom-test/rate/not-submitted"));

    expect(response.status).toBe(404);
    expect(await responseBody(response)).toMatchObject({ status: "blocked", code: "FREIGHTCOM_REQUEST_HANDLE_UNKNOWN" });
  });
});
