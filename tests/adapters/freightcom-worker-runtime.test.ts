import { describe, expect, it, vi } from "vitest";

import type { ExecutionContext } from "../../src/logistics_mcp/platform/context.js";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context.js";
import {
  createFreightcomTestAdapterFromEnvironment,
} from "../../src/logistics_mcp/adapters/quote/freightcom-runtime.js";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client.js";

const context: ExecutionContext = parseExecutionContext({
  tenant_id: "tenant-a",
  actor_id: "service-a",
  actor_role: "service",
  roles: ["service"],
  scopes: ["tool:quote.freightcom_ltl.preview"],
  client_id: "client-a",
  session_id: "session-a",
  expires_at: 1_900_000_000,
});

function runtimeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MCP_FREIGHTCOM_TEST_ENABLED: "true",
    MCP_FREIGHTCOM_TEST_AUTH_SECRET_FILE: "/run/secrets/freightcom-test-token",
    MCP_FREIGHTCOM_TEST_ALLOWED_TENANTS: "tenant-a",
    MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid,customer-external-api.ssd-test.freightcom.com",
    ...overrides,
  };
}

function rateRequest(): Record<string, unknown> {
  return {
    details: {
      origin: {
        address: {
          address_line_1: "1 Test St",
          city: "Toronto",
          region: "ON",
          country: "CA",
          postal_code: "M5V 1A1",
        },
      },
      destination: {
        address: {
          address_line_1: "2 Test Ave",
          city: "Ottawa",
          region: "ON",
          country: "CA",
          postal_code: "K1A 0B1",
        },
        ready_at: { hour: 9, minute: 0 },
        ready_until: { hour: 17, minute: 0 },
        signature_requirement: "not-required",
      },
      expected_ship_date: { year: 2026, month: 9, day: 3 },
      packaging_type: "pallet",
      packaging_properties: {
        pallet_type: "ltl",
        pallets: [{
          measurements: {
            weight: { unit: "kg", value: "100" },
            cuboid: { unit: "cm", l: "120", w: "100", h: "100" },
          },
          description: "Test pallet",
          freight_class: "70",
        }],
      },
    },
  };
}

describe("Freightcom test worker runtime configuration", () => {
  it("stays disabled without the explicit test setting and fixed egress host", () => {
    expect(createFreightcomTestAdapterFromEnvironment({})).toBeUndefined();
    expect(createFreightcomTestAdapterFromEnvironment(runtimeEnv({
      MCP_ALLOWED_OUTBOUND_HOSTS: "issuer.example.invalid",
    }))).toBeUndefined();
  });

  it("rejects an unallowlisted tenant before reading the secret or making HTTP", async () => {
    const readSecretFile = vi.fn(() => "freightcom-test-token");
    const fetchImpl = vi.fn<FetchImplementation>();
    const adapter = createFreightcomTestAdapterFromEnvironment(
      runtimeEnv(),
      { readSecretFile, fetchImpl },
    );
    expect(adapter).toBeDefined();
    const tenantB = parseExecutionContext({
      tenant_id: "tenant-b",
      actor_id: "service-b",
      actor_role: "service",
      roles: ["service"],
      scopes: ["tool:quote.freightcom_ltl.preview"],
      client_id: "client-b",
      session_id: "session-b",
      expires_at: 1_900_000_000,
    });

    const result = await adapter!.requestRate(
      rateRequest(),
      undefined,
      tenantB,
    );

    expect(result.status).toBe("blocked");
    expect(result.blockers?.map(({ code }) => code)).toContain(
      "freightcom.tenant_not_allowed",
    );
    expect(readSecretFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the test token only at request time and never returns it", async () => {
    const readSecretFile = vi.fn(() => "freightcom-test-token");
    const fetchImpl = vi.fn<FetchImplementation>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "rate-1" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: { done: true, total: 0, complete: 0 },
        rates: [],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = createFreightcomTestAdapterFromEnvironment(
      runtimeEnv(),
      { readSecretFile, fetchImpl, clock: () => new Date("2026-09-02T00:00:00Z") },
    );
    expect(readSecretFile).not.toHaveBeenCalled();

    const result = await adapter!.requestRate(rateRequest(), undefined, context);

    expect(result.status).toBe("manual_review");
    expect(readSecretFile).toHaveBeenCalledWith("/run/secrets/freightcom-test-token");
    expect(JSON.stringify(result)).not.toContain("freightcom-test-token");
  });

  it("uses a low-frequency poll window long enough for observed test responses", async () => {
    let pollCount = 0;
    const pollDelays: number[] = [];
    const fetchImpl = vi.fn<FetchImplementation>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "rate-slow-1" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }))
      .mockImplementation(() => {
        pollCount += 1;
        return Promise.resolve(new Response(JSON.stringify({
          status: { done: pollCount === 21, total: 0, complete: 0 },
          rates: [],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      });
    const adapter = createFreightcomTestAdapterFromEnvironment(
      runtimeEnv(),
      {
        readSecretFile: () => "freightcom-test-token",
        fetchImpl,
        sleep: (delayMs) => {
          pollDelays.push(delayMs);
          return Promise.resolve();
        },
      },
    );

    const result = await adapter!.requestRate(rateRequest(), undefined, context);

    expect(result.status).toBe("manual_review");
    expect(pollCount).toBe(21);
    expect(pollDelays).toEqual(Array(20).fill(2_000));
  });
});
