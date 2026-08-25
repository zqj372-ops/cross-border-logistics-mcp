import { describe, expect, it, vi } from "vitest";

import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context";
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
const RISK_CUSTOMS_IDENTITY = {
  contractVersion: "riskcustoms-query.v1",
  serviceVersion: "riskcustoms-service.fixture-1",
  publishedAt: "2026-08-11T00:00:00.000Z",
  supportedOperations: ["status", "query"],
  releaseIds: ["release-ca-1"],
  snapshotHash: "a".repeat(64),
  releaseHash: "b".repeat(64),
};

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

function serverContext(): ExecutionContext {
  return parseExecutionContext({
    ...securityClaims,
    scopes: [...securityClaims.scopes, "tariff:read"],
  });
}

function riskCustomsStatus(
  ready: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...RISK_CUSTOMS_IDENTITY,
    evaluatedAt: API_TIME,
    lastSourceCheckAt: ready ? API_TIME : null,
    ready,
    testData: false,
    reasons: ready ? [] : ["fixture_not_ready"],
    ...overrides,
  };
}

function riskCustomsSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "source-ca-1",
    releaseId: "release-ca-1",
    artifactId: "artifact-ca-1",
    authority: "official",
    dataset: "ca-tariff",
    edition: "fixture-edition",
    revision: "fixture-revision",
    officialUrl: "https://official.example.invalid/ca-tariff/release-ca-1",
    publishedAt: "2026-01-01",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    retrievedAt: API_TIME,
    sourceLocator: "fixture://riskcustoms/source-ca-1",
    ...overrides,
  };
}

function riskCustomsCandidate(
  country: "CN" | "US" | "CA",
  sourceId: string,
  code: string,
): Record<string, unknown> {
  const legalName = { language: "en", text: "Synthetic fixture", sourceId };
  return {
    candidateId: `candidate-${country}-${code}`,
    country,
    code,
    displayCode: code,
    codeDigits: code.length,
    parentCode: null,
    hierarchy: [{
      code,
      displayCode: code,
      codeDigits: code.length,
      legalNames: [legalName],
    }],
    legalNames: [legalName],
    chineseExplanation: {
      translationId: `translation-${country}-${code}`,
      text: "Synthetic fixture explanation",
      status: "machine",
      basedOnSourceIds: [sourceId],
    },
    classificationReason: "Synthetic classification reason",
    classificationSourceIds: [sourceId],
    status: "candidate",
    hs6: code.length === 6 ? code : null,
  };
}

function riskCustomsResult(
  country: "CN" | "US" | "CA",
  sourceId: string,
  code: string,
): Record<string, unknown> {
  return {
    ...riskCustomsCandidate(country, sourceId, code),
    rates: [],
    confirmedTotalPercent: null,
    documents: [],
    measures: [],
    warnings: [],
  };
}

function riskCustomsQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...RISK_CUSTOMS_IDENTITY,
    queryId: "query-fixture-1",
    mode: "name_search",
    ruleDate: API_DATE,
    selectedHs6: null,
    nextQuestion: null,
    candidates: [riskCustomsCandidate("CA", "source-ca-1", "123456")],
    results: [],
    sources: [riskCustomsSource()],
    dataStatus: riskCustomsStatus(true),
    testData: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function quoteApi(fetchImpl: FetchImplementation): QuoteApiAdapter {
  return new QuoteApiAdapter({
    baseUrl: "https://quote.example.invalid",
    allowedHosts: ["quote.example.invalid"],
    enabled: true,
    fetchImpl,
    clock: () => new Date(API_TIME),
    originByTenantWarehouse: {
      tenant_demo_a: { "fixture-warehouse": "toronto" },
    },
  });
}

type AuthorizationProvider = (
  context: ExecutionContext,
  signal?: AbortSignal,
) => string | Promise<string>;

function customsApi(
  fetchImpl: FetchImplementation,
  authorizationProvider: AuthorizationProvider = () => "m2m-test-value",
): RiskCustomsApiAdapter {
  return new RiskCustomsApiAdapter({
    baseUrl: "https://riskcustoms.example.invalid",
    allowedHosts: ["riskcustoms.example.invalid"],
    enabled: true,
    productionConnector: true,
    fetchImpl,
    authorizationProvider,
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
    const context = serverContext();
    const [quote, customs] = await Promise.all([
      missing.adapters.quote.calculate(apiQuoteInput),
      missing.adapters.customs.search(customsSearchInput, context),
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
      source.adapters.customs.getStatus({ rule_date: API_DATE }, context),
    ]);

    expect(quote.status).toBe("unavailable");
    expect(quote.blockers?.map(({ code }) => code)).toContain("quote.adapter_disabled");
    expect(cargo.status).toBe("success");
    expect(container.status).toBe("success");
    expect(customs.status).toBe("success");
    await source.close();
  });

  it("keeps RiskCustoms ready=false scoped while local handlers stay usable", async () => {
    const customsFetch = vi.fn<FetchImplementation>(() => Promise.resolve(jsonResponse({
      ...riskCustomsStatus(false),
      error: { code: "data_not_ready", message: "publication pending" },
    }, 503)));
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsFetch),
    });
    const context = parseExecutionContext(securityClaims);
    const [customs, quote, cargo, container] = await Promise.all([
      source.adapters.customs.search(customsSearchInput, context),
      source.adapters.quote.calculate(apiQuoteInput),
      cargoToolHandler(cargoInput(), context),
      containerPlanSummaryHandler(containerInput(), context),
    ]);

    expect(customs.status).toBe("unavailable");
    expect(customs.blockers?.map(({ code }) => code)).toContain("customs.ready_false");
    expect(customs.data).toMatchObject({
      data_status: {
        ready: false,
        test_data: false,
        release_ids: ["release-ca-1"],
      },
    });
    expect(customsFetch).toHaveBeenCalledTimes(1);
    expect(quote.status).toBe("unavailable");
    expect(quote.blockers?.map(({ code }) => code)).toContain("quote.adapter_disabled");
    expect(cargo.status).toBe("success");
    expect(container.status).toBe("success");
    await source.close();
  });

  it("passes server execution context to M2M and projects the CA result through the inclusive source date", async () => {
    const customsFetch = vi.fn<FetchImplementation>()
      .mockResolvedValueOnce(jsonResponse(riskCustomsStatus(true)))
      .mockResolvedValueOnce(jsonResponse(riskCustomsQuery({
        candidates: [
          riskCustomsCandidate("CN", "source-cn-1", "123456"),
          riskCustomsCandidate("US", "source-us-1", "234567"),
          riskCustomsCandidate("CA", "source-ca-candidate", "345678"),
        ],
        results: [{
          ...riskCustomsResult("CA", "source-ca-result", "345678"),
          status: "confirmed",
        }],
        sources: [
          riskCustomsSource({ id: "source-cn-1" }),
          riskCustomsSource({ id: "source-us-1" }),
          riskCustomsSource({ id: "source-ca-candidate" }),
          riskCustomsSource({ id: "source-ca-result", effectiveTo: API_DATE }),
        ],
      })));
    const authorizationProvider = vi.fn<AuthorizationProvider>(() => "m2m-test-value");
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsFetch, authorizationProvider),
    });
    const context = serverContext();

    const result = await source.adapters.customs.search(customsSearchInput, context);

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      jurisdiction: "CA",
      candidates: [{ hs_code: "345678", classification_status: "confirmed" }],
    });
    expect(result.sourceRefs).toHaveLength(3);
    expect(authorizationProvider).toHaveBeenCalledTimes(2);
    expect(authorizationProvider).toHaveBeenNthCalledWith(1, context, expect.any(AbortSignal));
    expect(authorizationProvider).toHaveBeenNthCalledWith(2, context, expect.any(AbortSignal));
    expect(customsFetch.mock.calls.map(([url, init]) => [init?.method, requestUrl(url)])).toEqual([
      ["GET", "https://riskcustoms.example.invalid/api/m2m/status?ruleDate=2026-08-12"],
      ["POST", "https://riskcustoms.example.invalid/api/m2m/query"],
    ]);
    for (const [, init] of customsFetch.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer m2m-test-value");
      expect(headers.get("x-tenant-id")).toBe(context.tenantId);
    }
    const queryBodyRaw = customsFetch.mock.calls[1]?.[1]?.body;
    if (typeof queryBodyRaw !== "string") throw new Error("M2M query body was not JSON text");
    const queryBody = JSON.parse(queryBodyRaw) as Record<string, unknown>;
    expect(queryBody).not.toHaveProperty("tenant_id");
    await source.close();
  });

  it("keeps a query 503 fail-closed after a ready status", async () => {
    const customsFetch = vi.fn<FetchImplementation>()
      .mockResolvedValueOnce(jsonResponse(riskCustomsStatus(true)))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: "data_not_ready", message: "query changed" },
      }, 503));
    const source = createProductionApiAdapterSource({
      customs: customsApi(customsFetch),
    });

    const result = await source.adapters.customs.search(customsSearchInput, serverContext());

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map(({ code }) => code)).toContain("customs.query_unavailable");
    expect(JSON.stringify(result)).not.toContain("query changed");
    expect(customsFetch).toHaveBeenCalledTimes(2);
    await source.close();
  });

  it("keeps customs estimate unavailable without an HTTP call", async () => {
    const customsFetch = vi.fn<FetchImplementation>();
    const result = await customsApi(customsFetch).estimate({ rule_date: API_DATE }, serverContext());

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(customsFetch).not.toHaveBeenCalled();
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
      const result = await composition.adapters.quote.calculate(apiQuoteInput, serverContext());
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

      expect(result.status).toBe("blocked");
      expect(result.blockers?.map(({ code }) => code)).toContain("quote.authorization_unconfigured");
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
      expect(composition.definitions).toHaveLength(10);
      expect(composition.adapters.quote).not.toBe(composition.adapters.status);

      const context = parseExecutionContext(securityClaims);
      const quoteHandler = composition.handlers["quote.canada_final_mile.calculate"];
      if (quoteHandler === undefined) throw new Error("quote handler was not registered");
      const quote = await quoteHandler(quoteInput(), context);
      expect(quote.status).toBe("unavailable");
      expect(quote.data).toBeNull();

      const customs = await composition.adapters.customs.getStatus({ rule_date: API_DATE }, context);
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
