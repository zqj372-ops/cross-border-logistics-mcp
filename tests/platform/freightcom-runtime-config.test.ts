import { afterEach, describe, expect, it, vi } from "vitest";

import { createFreightcomTestAdapterFromEnvironment } from "../../src/logistics_mcp/server/start";

const original = {
  enabled: process.env.MCP_FREIGHTCOM_TEST_ENABLED,
  account: process.env.FREIGHTCOM_TEST_KEYCHAIN_ACCOUNT,
  service: process.env.FREIGHTCOM_TEST_KEYCHAIN_SERVICE,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of [
    ["MCP_FREIGHTCOM_TEST_ENABLED", original.enabled],
    ["FREIGHTCOM_TEST_KEYCHAIN_ACCOUNT", original.account],
    ["FREIGHTCOM_TEST_KEYCHAIN_SERVICE", original.service],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Freightcom test MCP runtime configuration", () => {
  it("is disabled unless explicitly enabled", () => {
    delete process.env.MCP_FREIGHTCOM_TEST_ENABLED;
    expect(createFreightcomTestAdapterFromEnvironment()).toBeUndefined();
  });

  it("creates a test adapter backed by the configured Keychain identity", () => {
    process.env.MCP_FREIGHTCOM_TEST_ENABLED = "true";
    process.env.FREIGHTCOM_TEST_KEYCHAIN_ACCOUNT = "fixture-account";
    process.env.FREIGHTCOM_TEST_KEYCHAIN_SERVICE = "fixture-service";
    const readSecret = vi.fn(() => Promise.resolve("fixture-token"));

    const adapter = createFreightcomTestAdapterFromEnvironment(readSecret);

    expect(adapter).toBeDefined();
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("uses runtime fetch when the test adapter is enabled", async () => {
    process.env.MCP_FREIGHTCOM_TEST_ENABLED = "true";
    const readSecret = vi.fn(() => Promise.resolve("fixture-token"));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ request_id: "rate-runtime-fetch-001" }),
        { status: 202, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: { done: true, total: 1, complete: 1 },
        rates: [{
          service_id: "fixture.ltl",
          total: { currency: "CAD", value: "14342" },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = createFreightcomTestAdapterFromEnvironment(readSecret);

    const result = await adapter?.requestRate({
      details: {
        origin: {
          address: {
            address_line_1: "1 Test Way",
            city: "Markham",
            region: "ON",
            country: "CA",
            postal_code: "L3R 8N4",
          },
        },
        destination: {
          address: {
            address_line_1: "2 Test Way",
            city: "Montreal",
            region: "QC",
            country: "CA",
            postal_code: "H1H 1H1",
          },
          ready_at: { hour: 9, minute: 0 },
          ready_until: { hour: 17, minute: 0 },
          signature_requirement: "not-required",
        },
        expected_ship_date: { year: 2026, month: 8, day: 26 },
        packaging_type: "pallet",
        packaging_properties: {
          pallet_type: "ltl",
          pallets: [{
            measurements: {
              weight: { unit: "lb", value: 100 },
              cuboid: { unit: "in", l: 48, w: 40, h: 48 },
            },
            description: "Synthetic test freight",
            freight_class: "70",
          }],
        },
      },
    });

    expect(result?.status).toBe("manual_review");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readSecret).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous enablement settings", () => {
    process.env.MCP_FREIGHTCOM_TEST_ENABLED = "yes";
    expect(() => createFreightcomTestAdapterFromEnvironment()).toThrow(/true or false/u);
  });
});
