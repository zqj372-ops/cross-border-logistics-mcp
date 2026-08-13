import { describe, expect, it, vi } from "vitest";

import {
  createFixtureAdapters,
  unavailableQuotePdfPort,
} from "../../src/logistics_mcp/adapters/fixture-client";
import { createQuotePdfProductionSource } from "../../src/logistics_mcp/adapters/production-source";
import { createProductionApiAdapterSource } from "../../src/logistics_mcp/server/composition";

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

  it("keeps production PDF source narrow, disabled by default, and fail-closed when malformed", async () => {
    const baseHealth = () => Promise.resolve({ ready: true });
    const baseClose = () => Promise.resolve();
    const base = { ...createProductionApiAdapterSource(), health: baseHealth, close: baseClose };
    const health = vi.fn(baseHealth);
    const close = vi.fn(baseClose);
    const source = createQuotePdfProductionSource({ ...base, health, close });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const disabledPdf = source.source.adapters.quotePdf;
    expect(disabledPdf).toBe(unavailableQuotePdfPort);
    if (disabledPdf === undefined) return;
    await expect(disabledPdf.post({}, "disabled-key", {} as never)).resolves.toMatchObject({
      ok: false,
      failure: { code: "pdf.adapter_disabled", dispatched: false },
    });
    await expect(disabledPdf.get("document.pdf", {} as never)).resolves.toMatchObject({
      ok: false,
      failure: { code: "pdf.adapter_disabled", dispatched: false },
    });
    expect(Object.keys(source.source.adapters).sort()).toEqual([
      "customs",
      "knowledge",
      "quote",
      "quotePdf",
      "review",
      "status",
    ]);

    const pdfHealth = vi.fn();
    const pdfClose = vi.fn();
    const provided = {
      post: () => Promise.resolve({
        ok: false as const,
        failure: { kind: "unavailable" as const, code: "fake", dispatched: false },
      }),
      get: () => Promise.resolve({
        ok: false as const,
        failure: { kind: "unavailable" as const, code: "fake", dispatched: false },
      }),
      health: pdfHealth,
      close: pdfClose,
    };
    const injected = createQuotePdfProductionSource(base, { quotePdf: provided });
    expect(injected.ok).toBe(true);
    if (!injected.ok) return;
    expect(injected.source.adapters.quotePdf).toBe(provided);
    expect(injected.source.adapters.quote).toBe(base.adapters.quote);
    expect(injected.source.adapters.customs).toBe(base.adapters.customs);
    expect(injected.source.health).toBe(baseHealth);
    expect(injected.source.close).toBe(baseClose);
    await injected.source.health();
    await injected.source.close();
    expect(pdfHealth).not.toHaveBeenCalled();
    expect(pdfClose).not.toHaveBeenCalled();

    for (const quotePdf of [null, {}, { post: () => Promise.resolve(), get: "invalid" }]) {
      expect(createQuotePdfProductionSource(base, { quotePdf: quotePdf as never })).toEqual({
        ok: false,
        code: "production_quote_pdf_source_invalid",
      });
    }
    expect(health).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
