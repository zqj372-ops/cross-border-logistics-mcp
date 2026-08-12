import { describe, expect, it } from "vitest";

import {
  createFetchJsonClient,
  type FetchImplementation,
} from "../../src/logistics_mcp/adapters/http-client";
import {
  RiskCustomsApiAdapter,
  type RiskCustomsApiAdapterOptions,
} from "../../src/logistics_mcp/adapters/customs/riskcustoms-api-adapter";
import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import { createPhase1Bundle } from "../../src/logistics_mcp/adapters/phase1-bundle";
import {
  customsSearchResultSchema,
  dataStatusSchema,
} from "../../src/logistics_mcp/adapters/contracts";
import {
  executeRegisteredToolWithResult,
  registerPhaseOneTools,
} from "../../src/logistics_mcp/server/tool-registry";
import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";

const BASE_URL = "https://riskcustoms.example.invalid";
const HOST = "riskcustoms.example.invalid";
const RULE_DATE = "2026-08-12";
const CLOCK = new Date("2026-08-12T01:02:03.000Z");

interface FakeResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly raw?: string;
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fakeFetch(responses: readonly FakeResponse[]): {
  readonly calls: FetchCall[];
  readonly fetchImpl: FetchImplementation;
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl: FetchImplementation = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
    });
    const response = responses[index++];
    if (response === undefined) throw new Error("fixture response exhausted");
    return Promise.resolve(new Response(
      response.raw ?? JSON.stringify(response.body ?? {}),
      { status: response.status ?? 200 },
    ));
  };
  return { calls, fetchImpl };
}

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    retrievedAt: "2026-08-12T00:00:00.000Z",
    sourceLocator: "fixture://riskcustoms/source-ca-1",
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const code = typeof overrides.code === "string" ? overrides.code : "123456";
  const sourceIds = Array.isArray(overrides.classificationSourceIds)
    ? overrides.classificationSourceIds
    : ["source-ca-1"];
  return {
    candidateId: `candidate-${code}`,
    country: "CA",
    code,
    displayCode: code,
    codeDigits: code.length,
    parentCode: null,
    hierarchy: [
      {
        code,
        displayCode: code,
        codeDigits: code.length,
        legalNames: [{ language: "en", text: "Synthetic fixture", sourceId: "source-ca-1" }],
      },
    ],
    legalNames: [{ language: "en", text: "Synthetic fixture", sourceId: "source-ca-1" }],
    chineseExplanation: {
      translationId: `translation-${code}`,
      text: "Synthetic fixture explanation",
      status: "machine",
      basedOnSourceIds: sourceIds,
    },
    classificationReason: `Synthetic classification reason for ${code}`,
    classificationSourceIds: sourceIds,
    status: "candidate",
    hs6: code.length === 6 ? code : null,
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...candidate(overrides),
    rates: [],
    confirmedTotalPercent: null,
    documents: [],
    measures: [],
    warnings: [],
  };
}

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evaluatedAt: "2026-08-12T00:00:00.000Z",
    lastSourceCheckAt: "2026-08-12T00:00:00.000Z",
    ready: true,
    reasons: [],
    ...overrides,
  };
}

function queryResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    queryId: "query-fixture-1",
    mode: "name_search",
    ruleDate: RULE_DATE,
    selectedHs6: "123456",
    nextQuestion: {
      id: "material",
      label: "Confirm the material.",
      attribute: "material",
      options: ["steel", "plastic"],
    },
    candidates: [candidate()],
    results: [],
    sources: [source()],
    dataStatus: status(),
    testData: false,
    ...overrides,
  };
}

function adapter(
  fake: ReturnType<typeof fakeFetch>,
  overrides: Partial<RiskCustomsApiAdapterOptions> = {},
): RiskCustomsApiAdapter {
  return new RiskCustomsApiAdapter({
    baseUrl: BASE_URL,
    allowedHosts: [HOST],
    enabled: true,
    productionConnector: true,
    fetchImpl: fake.fetchImpl,
    headerProvider: () => ({
      authorization: "Bearer fixture-credential",
      "x-client": "fixture-client",
    }),
    clock: () => CLOCK,
    ...overrides,
  });
}

function searchInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "customs-request@fixture-1",
    rule_date: RULE_DATE,
    query_kind: "name_search",
    query: "  synthetic widget  ",
    query_code: "999999",
    product_description_ref: {
      ref_id: "opaque-product-fixture",
      kind: "raw_input",
      purpose: "synthetic fixture",
      expires_at: null,
    },
    product_attributes: {
      material: null,
      use: "fixture-use",
      origin_country: null,
      contains_steel_aluminum: false,
    },
    selected_hs6: "123456",
    turnstileToken: "fixture-turnstile-value",
    ...overrides,
  };
}

const context: ExecutionContext = {
  tenantId: "tenant_fixture",
  actorId: "actor_fixture",
  role: "sales",
  roles: ["sales"],
  scopes: ["tariff:read"],
  clientId: "client_fixture",
  sessionId: "session_fixture",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function registeredSearchTool(bundle: ReturnType<typeof createPhase1Bundle>) {
  const definition = registerPhaseOneTools(bundle.handlers, bundle.contracts).find(
    (candidateDefinition) => candidateDefinition.name === "customs.ca.search",
  );
  if (definition === undefined) throw new Error("customs.ca.search was not registered");
  return definition;
}

describe("RiskCustoms API CustomsAdapter", () => {
  it("returns needs_input for missing or blank query without any HTTP call", async () => {
    const fake = fakeFetch([]);
    const customs = adapter(fake);

    const missing = await customs.search(searchInput({ query: undefined }));
    const blank = await customs.search(searchInput({ query: " \t" }));

    expect(missing.status).toBe("needs_input");
    expect(blank.status).toBe("needs_input");
    expect(missing.blockers?.[0]?.field).toBe("query");
    expect(blank.blockers?.[0]?.field).toBe("query");
    expect(fake.calls).toHaveLength(0);
  });

  it("checks status first and does not POST when the upstream is not ready", async () => {
    const fake = fakeFetch([{ body: status({ ready: false, lastSourceCheckAt: null, reasons: ["fixture_not_ready"] }) }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput());

    expect(response.status).toBe("unavailable");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("GET");
    expect(fake.calls[0]?.url).toBe(`${BASE_URL}/api/status?ruleDate=${RULE_DATE}`);
    expect(response.data).toMatchObject({ data_status: { ready: false, release_ids: [] } });
  });

  it("performs exactly GET then POST with only explicit query attributes", async () => {
    const fake = fakeFetch([{ body: status() }, { body: queryResponse() }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput({
      product_attributes: {
        material: null,
        use: "fixture-use",
        origin_country: null,
        contains_steel_aluminum: false,
        secret_token: "do-not-send",
      },
    }));

    expect(response.status).toBe("success");
    expect(fake.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(fake.calls[0]?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer fixture-credential",
      "x-client": "fixture-client",
    });
    expect(fake.calls[1]?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer fixture-credential",
      "content-type": "application/json",
      "x-client": "fixture-client",
    });
    expect(fake.calls[1]?.body).toEqual({
      query: "synthetic widget",
      ruleDate: RULE_DATE,
      codeCountry: "CA",
      selectedHs6: "123456",
      attributes: {
        use: "fixture-use",
        contains_steel_aluminum: false,
      },
    });
    expect(JSON.stringify(fake.calls[1]?.body)).not.toContain("999999");
    expect(JSON.stringify(fake.calls[1]?.body)).not.toContain("turnstileToken");
    expect(JSON.stringify(fake.calls[1]?.body)).not.toContain("opaque-product-fixture");
    expect(JSON.stringify(fake.calls[1]?.body)).not.toContain("secret_token");
    expect(JSON.stringify(fake.calls[1]?.body)).not.toContain("do-not-send");
  });

  it("does not map candidates when the response selectedHs6 does not match", async () => {
    const fake = fakeFetch([
      { body: status() },
      { body: queryResponse({ selectedHs6: "654321" }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput({ selected_hs6: "123456" }));

    expect(response.status).toBe("manual_review");
    expect(response.data).toBeNull();
    expect(response.blockers?.map((item) => item.code)).toContain(
      "customs.response_correlation_mismatch",
    );
    expect(fake.calls).toHaveLength(2);
  });

  it("does not map candidates when exact_code receives a non-exact response mode", async () => {
    const fake = fakeFetch([
      { body: status() },
      { body: queryResponse({ mode: "name_search", selectedHs6: "123456" }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(
      searchInput({ query_kind: "exact_code", selected_hs6: "123456" }),
    );

    expect(response.status).toBe("manual_review");
    expect(response.data).toBeNull();
    expect(response.blockers?.map((item) => item.code)).toContain(
      "customs.response_correlation_mismatch",
    );
  });

  it("maps status into dataStatus without inventing release ids", async () => {
    const fake = fakeFetch([{ body: status({ ready: false, reasons: ["fixture_pending"] }) }]);
    const customs = adapter(fake);

    const response = await customs.getStatus({ rule_date: RULE_DATE });

    expect(response.status).toBe("success");
    dataStatusSchema.parse(response.data);
    expect(response.data).toEqual({
      version: "data-status@riskcustoms-api.v1",
      system: "riskcustoms",
      ready: false,
      test_data: false,
      evaluated_at: "2026-08-12T00:00:00.000Z",
      last_source_check_at: "2026-08-12T00:00:00.000Z",
      reasons: ["fixture_pending"],
      release_ids: [],
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("maps only CA candidates/results, deduplicates, preserves reasons and next question", async () => {
    const response = queryResponse({
      candidates: [
        candidate({ code: "123456", status: "candidate" }),
        candidate({ code: "123456", status: "candidate", candidateId: "candidate-duplicate" }),
        candidate({ code: "111111", country: "CN", status: "confirmed" }),
        candidate({ code: "222222", status: "possible" }),
      ],
      results: [result({ code: "333333", status: "manual_review" })],
    });
    const fake = fakeFetch([{ body: status() }, { body: response }]);
    const customs = adapter(fake);

    const resultValue = await customs.search(searchInput());

    expect(resultValue.status).toBe("success");
    const data = customsSearchResultSchema.parse(resultValue.data);
    expect(data.candidates.map((item) => item.hs_code)).toEqual(["123456", "222222", "333333"]);
    expect(data.candidates.map((item) => item.classification_status)).toEqual([
      "candidate",
      "candidate",
      "manual_review",
    ]);
    expect(data.candidates.map((item) => item.confidence)).toEqual(["0", "0", "0"]);
    expect(data.candidates[0]?.reason_summary).toBe("Synthetic classification reason for 123456");
    expect(data.next_questions).toEqual(["Confirm the material."]);
    expect(data.candidates.every((item) => item.source_ref_ids[0] !== "source-ca-1")).toBe(true);
    expect(resultValue.warnings?.map((item) => item.code)).toContain(
      "customs.numeric_confidence_not_provided",
    );
  });

  it("maps an explicit confirmed result to confidence 1 without upgrading candidates", async () => {
    const fake = fakeFetch([
      { body: status() },
      {
        body: queryResponse({
          candidates: [candidate({ code: "123456", status: "candidate" })],
          results: [result({ code: "654321", status: "confirmed" })],
        }),
      },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput());
    const data = customsSearchResultSchema.parse(response.data);

    expect(data.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hs_code: "123456", classification_status: "candidate", confidence: "0" }),
        expect.objectContaining({ hs_code: "654321", classification_status: "confirmed", confidence: "1" }),
      ]),
    );
  });

  it.each([
    ["dataStatus.ready=false", { dataStatus: status({ ready: false }), testData: true }, "unavailable"],
    ["testData=true", { dataStatus: status(), testData: true }, "unavailable"],
    ["ruleDate mismatch", { ruleDate: "2026-08-11" }, "unavailable"],
    ["sources missing", { sources: [] }, "unavailable"],
    ["releaseId missing", { sources: [source({ releaseId: "" })] }, "unavailable"],
    ["candidate source reference missing", { candidates: [candidate({ classificationSourceIds: ["missing-source"] })] }, "manual_review"],
  ] as const)("fails closed on %s", async (_name, responseOverrides, expectedStatus) => {
    const fake = fakeFetch([{ body: status() }, { body: queryResponse(responseOverrides) }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput());

    expect(response.status).toBe(expectedStatus);
    expect(fake.calls).toHaveLength(2);
    expect(response.blockers?.length).toBeGreaterThan(0);
    expect(response.blockers?.map((item) => item.message).join(" ")).not.toContain("synthetic widget");
  });

  it("fails closed when an official locator is not HTTPS or exceeds the output contract", async () => {
    for (const invalidSource of [
      source({ officialUrl: "http://official.example.invalid/source" }),
      source({ officialUrl: `https://official.example.invalid/${"x".repeat(500)}` }),
    ]) {
      const fake = fakeFetch([{ body: status() }, { body: queryResponse({ sources: [invalidSource] }) }]);
      const customs = adapter(fake);

      const response = await customs.search(searchInput());

      expect(response.status).toBe("unavailable");
      expect(response.blockers?.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["403", { status: 403, body: { error: "challenge" } }],
    ["429", { status: 429, body: { error: "rate limited" } }],
    ["5xx", { status: 503, body: { error: "fixture failure" } }],
    ["invalid JSON", { raw: "not-json" }],
  ] as const)("maps %s to unavailable without leaking request data", async (_name, failedResponse) => {
    const fake = fakeFetch([{ body: status() }, failedResponse]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput());
    const serialized = JSON.stringify(response);

    expect(response.status).toBe("unavailable");
    expect(serialized).not.toContain("synthetic widget");
    expect(serialized).not.toContain("fixture-credential");
    expect(serialized).not.toContain("fixture-turnstile-value");
  });

  it("maps a fake timeout to unavailable without exposing the underlying error", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: FetchImplementation = (input, init) => {
      calls.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: undefined,
      });
      if (calls.length === 1) return Promise.resolve(new Response(JSON.stringify(status())));
      throw new Error("fixture timeout with secret credential");
    };
    const customs = adapter({ calls, fetchImpl });

    const response = await customs.search(searchInput());

    expect(response.status).toBe("unavailable");
    expect(JSON.stringify(response)).not.toContain("secret credential");
  });

  it("stays disabled unless both enabled and the explicit production connector flag are true", async () => {
    const fake = fakeFetch([]);
    const customs = adapter(fake, { productionConnector: false });

    const response = await customs.search(searchInput());

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map((item) => item.code)).toContain("customs.adapter_disabled");
    expect(fake.calls).toHaveLength(0);

    const defaultResult = await new RiskCustomsApiAdapter().search(searchInput());
    expect(defaultResult.status).toBe("unavailable");
    expect(defaultResult.blockers?.map((item) => item.code)).toContain("customs.adapter_disabled");
  });

  it("blocks a base URL outside the explicit allowlist before any request", async () => {
    const fake = fakeFetch([]);
    const customs = new RiskCustomsApiAdapter({
      baseUrl: BASE_URL,
      allowedHosts: ["other.example.invalid"],
      enabled: true,
      productionConnector: true,
      fetchImpl: fake.fetchImpl,
    });

    const response = await customs.getStatus({ rule_date: RULE_DATE });

    expect(response.status).toBe("blocked");
    expect(response.blockers?.map((item) => item.code)).toContain("customs.endpoint_not_allowed");
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps estimate unavailable and performs zero HTTP calls", async () => {
    const fake = fakeFetch([]);
    const customs = adapter(fake);

    const response = await customs.estimate({
      rule_date: RULE_DATE,
      classification: { hs_code: "123456", status: "confirmed", source_ref_ids: ["fixture-source"] },
    });

    expect(response.status).toBe("unavailable");
    expect(response.data).toBeNull();
    expect(response.blockers?.[0]?.message).toContain("当前 API 不提供正式税额估算");
    expect(fake.calls).toHaveLength(0);
  });

  it("passes the formal tool input through createPhase1Bundle and registered output validation", async () => {
    const fake = fakeFetch([{ body: status() }, { body: queryResponse() }]);
    const customs = adapter(fake);
    const bundle = createPhase1Bundle({ ...createFixtureAdapters(), customs });

    const execution = await executeRegisteredToolWithResult(
      registeredSearchTool(bundle),
      {
        schema_version: "2026-08-11.v1",
        version: "customs-request@fixture-1",
        rule_date: RULE_DATE,
        query_kind: "name_search",
        query: "synthetic widget",
        query_code: null,
        product_description_ref: null,
        product_attributes: {
          material: "fixture-material",
          use: "fixture-use",
          origin_country: "CN",
          contains_steel_aluminum: false,
        },
        selected_hs6: null,
      },
      context,
      { requestId: "req:customs:api-fixture", auditId: "audit:customs:api-fixture" },
    );

    expect(execution.envelope.status).toBe("success");
    customsSearchResultSchema.parse(execution.envelope.data);
    expect(execution.envelope.data).toMatchObject({
      jurisdiction: "CA",
      data_status: { ready: true, test_data: false, release_ids: ["release-ca-1"] },
    });
  });

  it("reuses the shared HTTP client contract for disabled production calls", async () => {
    let fetchCalls = 0;
    const client = createFetchJsonClient({
      baseUrl: BASE_URL,
      allowedHosts: [HOST],
      fetchImpl: () => {
        fetchCalls += 1;
        throw new Error("fetch must not be called");
      },
    });

    await expect(client.get("/api/status")).rejects.toMatchObject({ code: "upstream_disabled" });
    expect(fetchCalls).toBe(0);
  });
});
