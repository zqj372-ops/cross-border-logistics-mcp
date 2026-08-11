import { describe, expect, it } from "vitest";

import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";

describe("existing-system adapter ports", () => {
  it("returns versioned source references without exposing an upstream payload", async () => {
    const adapters = createFixtureAdapters();
    const result = await adapters.quote.calculate({
      schema_version: "2026-08-11.v1",
      version: "quote-request@fixture-1",
      origin: { warehouse_code: "fixture-warehouse", province: "ON" },
      destination: {
        country: "CA",
        province: "ON",
        city: "Fixture City",
        postal_code: "A0A 0A0",
        address_type: "commercial",
        full_address_ref: null,
      },
      cargo: {
        cargo_result_ref: null,
        billing_pallets: 1,
        weight_kg: { value: "10", unit: "kg" },
        pieces: 1,
        package_types: ["pallet"],
      },
      services: {
        appointment: false,
        liftgate: false,
        limited_access: false,
        remote_area: false,
      },
      effective_at: "2026-08-11",
    });

    expect(result.status).toBe("success");
    expect(result.sourceRefs[0]).toMatchObject({
      system: "existing-quote-system",
      version: "quote-fixture@1",
    });
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("api_key");
    expect(JSON.stringify(result)).not.toContain("fixture-credential-value");
  });

  it("exposes only narrow, named methods and no generic write escape hatch", () => {
    const adapters = createFixtureAdapters();
    const portNames = Object.keys(adapters).flatMap((name) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(adapters[name as keyof typeof adapters])).filter(
        (method) => method !== "constructor",
      ),
    );

    expect(portNames).not.toEqual(
      expect.arrayContaining([
        "commitOperation",
        "writeAny",
        "updateRate",
        "publishQuote",
        "submitBooking",
      ]),
    );
  });

  it("keeps customs readiness as source data instead of adding an AI fallback", async () => {
    const adapters = createFixtureAdapters();
    const result = await adapters.customs.search({ fixture: "customs-not-ready" });

    expect(result.status).toBe("unavailable");
    expect(result.data).toMatchObject({
      data_status: { ready: false },
    });
    expect(result).not.toHaveProperty("aiCandidate");
  });
});
