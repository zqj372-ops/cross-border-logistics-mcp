import { describe, expect, it } from "vitest";

import type { FreightcomRatePort } from "../../src/logistics_mcp/adapters/ports";
import {
  createFreightcomLtlToolHandler,
  freightcomLtlInputSchema,
  freightcomLtlResultSchema,
} from "../../src/logistics_mcp/domains/quote/freightcom-ltl-tool";
import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";

const context: ExecutionContext = {
  tenantId: "tenant_fixture",
  actorId: "actor_fixture",
  role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate"],
  clientId: "client_fixture",
  sessionId: "session_fixture",
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};

function input(): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "freightcom-ltl-rate-request@2026-08-26.v1",
    display_policy: "usd_numeric_relabel_test_only",
    details: {
      origin: {
        name: "Origin",
        address: {
          address_line_1: "1 Test Way",
          city: "Markham",
          region: "ON",
          country: "CA",
          postal_code: "L3R 8N4",
        },
      },
      destination: {
        name: "Destination",
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
            weight: { unit: "lb", value: "100" },
            cuboid: { unit: "in", l: "48", w: "40", h: "48" },
          },
          description: "Test freight",
          freight_class: "70",
          num_pieces: 1,
        }],
      },
    },
  };
}

function port(): FreightcomRatePort {
  return {
    requestRate: () => Promise.resolve({
      status: "manual_review",
      data: {
        provider: "freightcom",
        api_version: "2.10.0",
        environment: "test",
        request_id: "rate-test-001",
        status: { done: true, total: 1, complete: 1 },
        rates: [{
          carrier_name: "Test Carrier",
          service_name: "LTL",
          service_id: "test.ltl",
          total: { currency: "CAD", value: "17936" },
          base: { currency: "CAD", value: "15000" },
          surcharges: [{ type: "fuel", amount: { currency: "CAD", value: "2936" } }],
          transit_time_days: 2,
          transit_time_not_available: false,
        }],
        mcp_compatibility: "manual_review",
      },
      sourceRefs: [{
        source_id: "src:freightcom:test:rate-test-001",
        source_type: "opaque_reference",
        system: "Freightcom Customer API",
        locator: "opaque://freightcom/test/rate/rate-test-001",
        version: "freightcom-api@2.10.0",
        retrieved_at: "2026-08-25T00:00:00.000Z",
        authority: "opaque",
        content_hash: "sha256:freightcomtest001",
      }],
      assumptions: [],
      warnings: [],
      blockers: [{
        code: "freightcom.test_data",
        message: "Test data is not authoritative.",
        severity: "error",
        field: null,
      }],
      calculationTrace: [],
      reviewStatus: "manual_review",
    }),
  };
}

describe("Freightcom LTL MCP tool contract", () => {
  it("uses a closed narrowed pallet request", () => {
    expect(freightcomLtlInputSchema.safeParse(input()).success).toBe(true);
    expect(freightcomLtlInputSchema.safeParse({ ...input(), token: "forbidden" }).success).toBe(false);
    expect(freightcomLtlInputSchema.safeParse({
      ...input(),
      details: {
        ...(input().details as Record<string, unknown>),
        packaging_type: "package",
      },
    }).success).toBe(false);
  });

  it("preserves source CAD and adds the test-only same-number USD display field", async () => {
    const outcome = await createFreightcomLtlToolHandler(port())(input(), context);

    expect(outcome.status).toBe("manual_review");
    expect(outcome.data).toMatchObject({
      version: "freightcom-ltl-rate-result@2026-08-26.v1",
      provider: "freightcom",
      environment: "test",
      sendable: false,
      bookable: false,
      authoritative: false,
      currency_display_policy: {
        policy: "usd_numeric_relabel_test_only",
        conversion_applied: false,
      },
      rates: [{
        total: {
          amount: "179.36",
          currency: "CAD",
          provider_value: "17936",
          provider_scale: 2,
        },
        display_total: {
          amount: "179.36",
          currency: "USD",
          conversion_method: "none_numeric_relabel",
        },
      }],
    });
    expect(freightcomLtlResultSchema.safeParse(outcome.data).success).toBe(true);
    expect(outcome.calculationTrace?.length).toBeGreaterThan(0);
    expect(outcome.sourceRefs).toHaveLength(1);
  });

  it("passes fail-closed unavailable results through without creating rate data", async () => {
    const unavailablePort: FreightcomRatePort = {
      requestRate: () => Promise.resolve({
        status: "unavailable",
        data: null,
        sourceRefs: [],
        blockers: [{
          code: "freightcom.production_disabled",
          message: "Production is disabled.",
          severity: "error",
          field: null,
        }],
        reviewStatus: "manual_review",
      }),
    };

    const outcome = await createFreightcomLtlToolHandler(unavailablePort)(input(), context);
    expect(outcome.status).toBe("unavailable");
    expect(outcome.data).toBeNull();
    expect(outcome.blockers?.map((item) => item.code)).toEqual(["freightcom.production_disabled"]);
  });
});
