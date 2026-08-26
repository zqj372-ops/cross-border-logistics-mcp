import { request as httpRequest } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createQuoteApiHandler, createQuoteServer } from "../../../apps/freightcom-quote/server.mjs";
import { FreightcomTestClientError } from "../../../src/logistics_mcp/adapters/quote/freightcom-test-client";

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
          weight: { unit: "lb", value: "100" },
          cuboid: { unit: "in", l: "48", w: "40", h: "52" },
        },
        description: "Industrial parts",
        freight_class: "70",
      }],
    },
  },
};

function request(path: string, init: RequestInit = {}): Request {
  const target = new URL(path, "http://127.0.0.1:56570");
  const headers = new Headers(init.headers);
  if ((init.method ?? "GET").toUpperCase() === "POST" && !headers.has("origin")) {
    headers.set("origin", target.origin);
  }
  return new Request(target, { ...init, headers });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function rawServerRequest(
  port: number,
  hostHeader: string,
): Promise<{
  readonly status: number | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/freightcom-test/config",
      method: "GET",
      headers: { host: hostHeader },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        contentType: response.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("Freightcom quote page API", () => {
  it("serves the browser-side calculation modules required by the app", async () => {
    const runtime = createQuoteServer({ port: 0, token: "" });
    await new Promise<void>((resolve) => runtime.server.listen(0, runtime.host, resolve));
    try {
      const address = runtime.server.address();
      if (address === null || typeof address === "string") throw new Error("test server address unavailable");
      const [originResponse, freightClassResponse, pollingResponse] = await Promise.all([
        fetch(`http://${runtime.host}:${address.port}/origin-presets.mjs`),
        fetch(`http://${runtime.host}:${address.port}/freight-class.mjs`),
        fetch(`http://${runtime.host}:${address.port}/polling.mjs`),
      ]);

      expect(originResponse.status).toBe(200);
      expect(originResponse.headers.get("content-type")).toContain("text/javascript");
      expect(await originResponse.text()).toContain("calgary-t2e6m9");
      expect(freightClassResponse.status).toBe(200);
      expect(freightClassResponse.headers.get("content-type")).toContain("text/javascript");
      expect(await freightClassResponse.text()).toContain("suggestFreightClass");
      expect(pollingResponse.status).toBe(200);
      expect(pollingResponse.headers.get("content-type")).toContain("text/javascript");
      expect(await pollingResponse.text()).toContain("schedulePollingTask");
    } finally {
      await new Promise<void>((resolve, reject) => runtime.server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it.each(["%", "127.0.0.1:bad"])(
    "returns a blocked JSON envelope for malformed Host %s",
    async (hostHeader) => {
      const runtime = createQuoteServer({ port: 0, token: "" });
      await new Promise<void>((resolve) => runtime.server.listen(0, runtime.host, resolve));
      try {
        const address = runtime.server.address();
        if (address === null || typeof address === "string") {
          throw new Error("test server address unavailable");
        }

        const response = await rawServerRequest(address.port, hostHeader);

        expect(response.status).toBe(400);
        expect(response.contentType).toContain("application/json");
        expect(JSON.parse(response.body)).toMatchObject({
          status: "blocked",
          code: "REQUEST_URL_INVALID",
        });
      } finally {
        await new Promise<void>((resolve, reject) => runtime.server.close((error) => error === undefined ? resolve() : reject(error)));
      }
    },
  );

  it("reports the CAD numeric relabel policy without claiming FX conversion", async () => {
    const handler = createQuoteApiHandler({
      client: { submitRate: vi.fn(), pollRate: vi.fn() },
      tokenConfigured: true,
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
    });

    const response = await handler(request("/api/freightcom-test/config"));

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toMatchObject({
      status: "success",
      data: {
        display_currency: "USD",
        currency_policy: "cad-numeric-relabel-to-usd",
        conversion_applied: false,
        relabel_applied: true,
      },
    });
  });

  it("returns a sanitized postal lookup for Canada and the United States", async () => {
    const postalLookup = vi.fn().mockResolvedValue({
      postal_code: "L3R 8N4",
      city: "Markham",
      region: "ON",
      country: "CA",
      approximate: true,
      source: "Zippopotam.us / GeoNames",
    });
    const handler = createQuoteApiHandler({
      client: { submitRate: vi.fn(), pollRate: vi.fn() },
      tokenConfigured: false,
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
      postalLookup,
    });

    const response = await handler(request("/api/postal-lookup?postal=L3R%208N4"));

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toMatchObject({
      status: "success",
      data: { city: "Markham", region: "ON", country: "CA", approximate: true },
    });
    expect(postalLookup).toHaveBeenCalledWith("L3R 8N4");
  });

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

  it("rejects cross-origin browser writes before parsing or submitting a rate", async () => {
    const client = {
      submitRate: vi.fn(),
      pollRate: vi.fn(),
    };
    const handler = createQuoteApiHandler({
      client,
      tokenConfigured: true,
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
    });

    const response = await handler(request("/api/freightcom-test/rate", {
      method: "POST",
      body: JSON.stringify(VALID_REQUEST),
      headers: {
        "content-type": "text/plain",
        origin: "https://malicious.example",
        "sec-fetch-site": "cross-site",
      },
    }));

    expect(response.status).toBe(403);
    expect(await responseBody(response)).toMatchObject({
      status: "blocked",
      code: "CROSS_ORIGIN_REQUEST_BLOCKED",
    });
    expect(client.submitRate).not.toHaveBeenCalled();
  });

  it("requires JSON content type for same-origin rate writes", async () => {
    const client = {
      submitRate: vi.fn(),
      pollRate: vi.fn(),
    };
    const handler = createQuoteApiHandler({
      client,
      tokenConfigured: true,
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
    });

    const response = await handler(request("/api/freightcom-test/rate", {
      method: "POST",
      body: JSON.stringify(VALID_REQUEST),
      headers: { "content-type": "text/plain" },
    }));

    expect(response.status).toBe(415);
    expect(await responseBody(response)).toMatchObject({
      status: "blocked",
      code: "JSON_CONTENT_TYPE_REQUIRED",
    });
    expect(client.submitRate).not.toHaveBeenCalled();
  });

  it("returns a sanitized needs-input response when Freightcom rejects request fields", async () => {
    const handler = createQuoteApiHandler({
      client: {
        submitRate: vi.fn().mockRejectedValue(new FreightcomTestClientError(
          "freightcom.test_request_rejected",
          "provider body must not escape",
          422,
        )),
        pollRate: vi.fn(),
      },
      tokenConfigured: true,
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
    });

    const response = await handler(request("/api/freightcom-test/rate", {
      method: "POST",
      body: JSON.stringify(VALID_REQUEST),
      headers: { "content-type": "application/json" },
    }));
    const body = await responseBody(response);

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      status: "needs_input",
      code: "FREIGHTCOM_TEST_REQUEST_REJECTED",
      upstream_status: 422,
    });
    expect(JSON.stringify(body)).not.toContain("provider body must not escape");
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
        display_currency: "USD",
        currency_policy: "cad-numeric-relabel-to-usd",
        conversion_applied: false,
        relabel_applied: true,
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

  it("returns a blocked JSON response for a malformed encoded request handle", async () => {
    const client = { submitRate: vi.fn(), pollRate: vi.fn() };
    const handler = createQuoteApiHandler({
      client,
      tokenConfigured: true,
      baseUrl: "https://customer-external-api.ssd-test.freightcom.com",
    });

    const response = await handler(request("/api/freightcom-test/rate/%"));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await responseBody(response)).toMatchObject({
      status: "blocked",
      code: "FREIGHTCOM_REQUEST_HANDLE_UNKNOWN",
    });
    expect(client.pollRate).not.toHaveBeenCalled();
  });
});
