import { describe, expect, it, vi } from "vitest";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client";
import { RiskCustomsApiAdapter } from "../../src/logistics_mcp/adapters/customs/riskcustoms-api-adapter";
import { QuoteApiAdapter } from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import { cargoToolHandler } from "../../src/logistics_mcp/domains/cargo/tool";
import { containerPlanSummaryHandler } from "../../src/logistics_mcp/domains/container/service";
import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import {
  createFixtureComposition,
  createProductionApiAdapterSource,
  createProductionComposition,
  type ProductionAdapterSource,
} from "../../src/logistics_mcp/server/composition";
import {
  cargoInput,
  containerInput,
  quoteInput,
} from "./fixtures/tenant-fixtures";
import { securityClaims } from "./fixtures/security-fixtures";

const API_DATE = "2026-08-12";
const API_TIME = `${API_DATE}T00:00:00.000Z`;

const apiQuoteInput = quoteInput({
  effective_at: API_DATE,
  cargo: {
    ...(quoteInput().cargo as Record<string, unknown>),
    total_volume: { value: "1.25", unit: "cbm" },
  },
});

const customsSearchInput = {
  rule_date: API_DATE,
  query_kind: "name_search",
  query: "synthetic widget",
  product_attributes: { material: "synthetic", origin_country: "CN" },
  selected_hs6: null,
};

function riskCustomsStatus(ready: boolean): Record<string, unknown> {
  return {
    evaluatedAt: API_TIME,
    lastSourceCheckAt: ready ? API_TIME : null,
    ready,
    reasons: ready ? [] : ["fixture_not_ready"],
  };
}

function quoteApi(fetchImpl: FetchImplementation): QuoteApiAdapter {
  return new QuoteApiAdapter({
    baseUrl: "https://quote.example.invalid",
    allowedHosts: ["quote.example.invalid"],
    enabled: true,
    fetchImpl,
    clock: () => new Date(API_TIME),
    originByWarehouse: { "fixture-warehouse": "toronto" },
  });
}

function customsApi(fetchImpl: FetchImplementation): RiskCustomsApiAdapter {
  return new RiskCustomsApiAdapter({
    baseUrl: "https://riskcustoms.example.invalid",
    allowedHosts: ["riskcustoms.example.invalid"],
    enabled: true,
    productionConnector: true,
    fetchImpl,
    clock: () => new Date(API_TIME),
  });
}

describe("gateway composition modes", () => {
  it("keeps source health local and omitted API adapters fail closed", async () => {
    const customsHealthFetch = vi.fn<FetchImplementation>();
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsHealthFetch),
    });

    await expect(source.health()).resolves.toEqual({ ready: true });
    expect(customsHealthFetch).not.toHaveBeenCalled();
    await source.close();

    const missing = createProductionApiAdapterSource();
    const [quote, customs] = await Promise.all([
      missing.adapters.quote.calculate(apiQuoteInput),
      missing.adapters.customs.search(customsSearchInput),
    ]);
    expect(quote.status).toBe("unavailable");
    expect(quote.blockers?.map(({ code }) => code)).toContain("quote.adapter_disabled");
    expect(customs.status).toBe("unavailable");
    expect(customs.blockers?.map(({ code }) => code)).toContain("customs.adapter_disabled");
    await missing.close();
  });

  it("keeps disabled quote local while local and customs handlers stay usable", async () => {
    const customsFetch = vi.fn<FetchImplementation>(() =>
      Promise.resolve(new Response(JSON.stringify(riskCustomsStatus(true)))),
    );
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsFetch),
    });
    const context = parseExecutionContext(securityClaims);
    const [quote, cargo, container, customs] = await Promise.all([
      source.adapters.quote.calculate(apiQuoteInput),
      cargoToolHandler(cargoInput(), context),
      containerPlanSummaryHandler(containerInput(), context),
      source.adapters.customs.getStatus({ rule_date: API_DATE }),
    ]);

    expect(quote.status).toBe("unavailable");
    expect(quote.blockers?.map(({ code }) => code)).toContain("quote.adapter_disabled");
    expect(cargo.status).toBe("success");
    expect(container.status).toBe("success");
    expect(customs.status).toBe("success");
    await source.close();
  });

  it("keeps RiskCustoms ready=false scoped while local handlers stay usable", async () => {
    const customsFetch = vi.fn<FetchImplementation>(() =>
      Promise.resolve(new Response(JSON.stringify(riskCustomsStatus(false)))),
    );
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsFetch),
    });
    const context = parseExecutionContext(securityClaims);
    const [customs, quote, cargo, container] = await Promise.all([
      source.adapters.customs.search(customsSearchInput),
      source.adapters.quote.calculate(apiQuoteInput),
      cargoToolHandler(cargoInput(), context),
      containerPlanSummaryHandler(containerInput(), context),
    ]);

    expect(customs.status).toBe("unavailable");
    expect(customs.blockers?.map(({ code }) => code)).toContain("customs.ready_false");
    expect(customs.data).toMatchObject({ data_status: { ready: false } });
    expect(quote.status).toBe("unavailable");
    expect(quote.blockers?.map(({ code }) => code)).toContain("quote.adapter_disabled");
    expect(cargo.status).toBe("success");
    expect(container.status).toBe("success");
    await source.close();
  });

  it("overrides production write adapters supplied through a manually constructed source", async () => {
    const quoteFetch = vi.fn<FetchImplementation>();
    const fixtureAdapters = createFixtureAdapters();
    const adapterSource: ProductionAdapterSource = {
      kind: "adapter_source",
      adapters: { ...fixtureAdapters, quote: quoteApi(quoteFetch) },
      health: () => Promise.resolve({ ready: true }),
      close: () => Promise.resolve(),
    };
    const composition = createProductionComposition({
      dataMode: "production",
      adapterSource,
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => securityClaims,
    });

    try {
      const result = await composition.adapters.quote.calculate(apiQuoteInput);
      const review = await composition.adapters.review.previewTask({
        schema_version: "2026-08-11.v1",
        version: "review-request@test",
        task_type: "quote",
        priority: "high",
        reason_codes: ["quote.zone_conflict"],
        opaque_context_refs: [],
        write_context: {
          tenant_context: {
            tenant_id: "tenant_demo_a",
            actor_id: "sales_demo",
            actor_role: "sales",
            client_id: "client_demo",
            session_id: "session_demo",
          },
          idempotency_key: "idem_review_disabled_123456",
          operation_mode: "preview",
          preview_ref: null,
          approval: { required: false, status: "not_required", approval_id: null },
        },
      });

      expect(result.status).toBe("unavailable");
      expect(result.blockers?.map(({ code }) => code)).toContain("quote.adapter_disabled");
      expect(review.status).toBe("unavailable");
      expect(review.blockers?.map(({ code }) => code)).toContain("review.adapter_disabled");
      expect(composition.adapters.review).not.toBe(fixtureAdapters.review);
      expect(quoteFetch).not.toHaveBeenCalled();
    } finally {
      await composition.close();
    }
  });

  it("keeps production adapters disabled until endpoint, tenant and readiness contracts are verified", async () => {
    const composition = createProductionComposition({
      dataMode: "production",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => securityClaims,
    });
    try {
      expect(composition.dataMode).toBe("production");
      expect(composition.definitions).toHaveLength(9);
      expect(composition.adapters.quote).not.toBe(composition.adapters.status);

      const context = parseExecutionContext(securityClaims);
      const quoteHandler = composition.handlers["quote.canada_final_mile.calculate"];
      if (quoteHandler === undefined) throw new Error("quote handler was not registered");
      const quote = await quoteHandler(quoteInput(), context);
      expect(quote.status).toBe("unavailable");
      expect(quote.data).toBeNull();

      const customs = await composition.adapters.customs.getStatus({ fixture: "ignored" });
      expect(customs.status).toBe("unavailable");
      expect(JSON.stringify(customs)).toContain("customs.adapter_disabled");
    } finally {
      await composition.close();
    }
  });

  it("does not allow fixture adapters under a production data mode", () => {
    expect(() =>
      createFixtureComposition({
        dataMode: "production",
      } as never),
    ).toThrow("Fixture adapters require DATA_MODE=fixtures.");
  });

  it("keeps the default production HTTP entrypoint fail-closed without a verifier", async () => {
    let authenticateCalls = 0;
    const composition = createProductionComposition({
      dataMode: "production",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => {
        authenticateCalls += 1;
        return securityClaims;
      },
    });
    try {
      const response = await composition.handler(
        new Request("https://mcp.example.invalid/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer fake-production-token",
            origin: "https://client.example.invalid",
          host: "mcp.example.invalid",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "fixture-client", version: "1.0.0" },
            },
          }),
        }),
      );
      expect(response.status).toBe(503);
      expect((await response.json()) as { status: string }).toMatchObject({ status: "unavailable" });
      expect(authenticateCalls).toBe(0);
    } finally {
      await composition.close();
    }
  });
});
