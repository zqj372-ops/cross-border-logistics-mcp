import { describe, expect, it, vi } from "vitest";

import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";
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

const BASE_URL = "https://riskcustoms.example.invalid";
const HOST = "riskcustoms.example.invalid";
const RULE_DATE = "2026-08-12";
const EVALUATED_AT = "2026-08-12T00:00:00.000Z";
const PUBLISHED_AT = "2026-08-11T00:00:00.000Z";
const SNAPSHOT_HASH = "a".repeat(64);
const RELEASE_HASH = "b".repeat(64);

interface FakeResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly raw?: string;
  readonly pending?: boolean;
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
    if (response.pending) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return Promise.resolve(new Response(
      response.raw ?? JSON.stringify(response.body ?? {}),
      { status: response.status ?? 200 },
    ));
  };
  return { calls, fetchImpl };
}

function identity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: "riskcustoms-query.v1",
    serviceVersion: "riskcustoms-service.fixture-1",
    publishedAt: PUBLISHED_AT,
    supportedOperations: ["status", "query"],
    releaseIds: ["release-ca-1"],
    snapshotHash: SNAPSHOT_HASH,
    releaseHash: RELEASE_HASH,
    ...overrides,
  };
}

function statusResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...identity(),
    evaluatedAt: EVALUATED_AT,
    lastSourceCheckAt: EVALUATED_AT,
    ready: true,
    testData: false,
    reasons: [],
    ...overrides,
  };
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
    retrievedAt: EVALUATED_AT,
    sourceLocator: "fixture://riskcustoms/source-ca-1",
    ...overrides,
  };
}

function legalName(sourceId = "source-ca-1"): Record<string, unknown> {
  return { language: "en", text: "Synthetic fixture", sourceId };
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const code = typeof overrides.code === "string" ? overrides.code : "123456";
  return {
    candidateId: `candidate-${code}`,
    country: "CA",
    code,
    displayCode: code,
    codeDigits: code.length,
    parentCode: null,
    hierarchy: [{
      code,
      displayCode: code,
      codeDigits: code.length,
      legalNames: [legalName()],
    }],
    legalNames: [legalName()],
    chineseExplanation: {
      translationId: `translation-${code}`,
      text: "Synthetic fixture explanation",
      status: "machine",
      basedOnSourceIds: ["source-ca-1"],
    },
    classificationReason: `Synthetic classification reason for ${code}`,
    classificationSourceIds: ["source-ca-1"],
    status: "candidate",
    hs6: code.length === 6 ? code : null,
    ...overrides,
  };
}

function rateLine(sourceId: string): Record<string, unknown> {
  return {
    id: `rate-${sourceId}`,
    label: "Base duty",
    treatment: "standard",
    category: "base_duty",
    kind: "ad_valorem",
    rateExpressionRaw: "0%",
    displayValue: "0%",
    confirmed: true,
    includedInConfirmedTotal: false,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    conditionText: "",
    interactionNote: "",
    sourceId,
  };
}

function documentItem(sourceId: string): Record<string, unknown> {
  return {
    id: `document-${sourceId}`,
    label: "Commercial invoice",
    side: "ca_import",
    status: "prepare_retain",
    conditions: [],
    reason: "Fixture document",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    sourceId,
  };
}

function measure(sourceId: string): Record<string, unknown> {
  return {
    id: `measure-${sourceId}`,
    label: "Trade measure",
    measureType: "safeguard",
    originCountry: "CN",
    codeHint: null,
    matchStatus: "not_indicated",
    legalScope: "Fixture scope",
    exceptions: [],
    caseNumber: null,
    exporterOrProducer: null,
    rateExpressionRaw: null,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    sourceId,
  };
}

function queryResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const response = {
    ...identity(),
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
    dataStatus: {
      ...identity(),
      evaluatedAt: EVALUATED_AT,
      lastSourceCheckAt: EVALUATED_AT,
      ready: true,
      testData: false,
      reasons: [],
    },
    testData: false,
    ...overrides,
  };
  return response;
}

const context: ExecutionContext = {
  tenantId: "tenant_server_a",
  actorId: "actor_fixture",
  role: "service",
  roles: ["service"],
  scopes: ["tariff:read"],
  clientId: "client_fixture",
  sessionId: "session_fixture",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

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
    authorizationProvider: () => "m2m-test-value",
    clock: () => new Date(EVALUATED_AT),
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
    product_description_ref: null,
    product_attributes: {
      material: null,
      use: "fixture-use",
      origin_country: "CN",
      contains_steel_aluminum: false,
    },
    selected_hs6: "123456",
    ...overrides,
  };
}

describe("RiskCustoms M2M API CustomsAdapter", () => {
  it("uses only the dedicated M2M paths and provider auth plus server tenant headers", async () => {
    const fake = fakeFetch([{ body: statusResponse() }, { body: queryResponse() }]);
    const authorizationProvider = vi.fn(() => "m2m-test-value");
    const customs = adapter(fake, { authorizationProvider });

    const response = await customs.search(searchInput({ tenant_id: "client-supplied-tenant" }), context);

    expect(response.status).toBe("success");
    expect(fake.calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${BASE_URL}/api/m2m/status?ruleDate=${RULE_DATE}`],
      ["POST", `${BASE_URL}/api/m2m/query`],
    ]);
    expect(fake.calls[0]?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer m2m-test-value",
      "x-tenant-id": "tenant_server_a",
    });
    expect(fake.calls[1]?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer m2m-test-value",
      "content-type": "application/json",
      "x-tenant-id": "tenant_server_a",
    });
    expect(authorizationProvider).toHaveBeenCalledWith(context);
    expect(JSON.stringify(fake.calls)).not.toContain("client-supplied-tenant");
    expect(JSON.stringify(response)).not.toContain("m2m-test-value");
  });

  it("uses the context tenant for every tenant, including a cross-tenant context", async () => {
    const fake = fakeFetch([{ body: statusResponse({ ready: false, testData: false }) }]);
    const customs = adapter(fake);
    const otherTenant = { ...context, tenantId: "tenant_server_b" };

    const response = await customs.search(searchInput(), otherTenant);

    expect(response.status).toBe("unavailable");
    expect(fake.calls[0]?.headers["x-tenant-id"]).toBe("tenant_server_b");
    expect(fake.calls[0]?.headers["x-tenant-id"]).not.toBe("client-supplied-tenant");
  });

  it("blocks status and query without a server execution context", async () => {
    const fake = fakeFetch([]);
    const customs = adapter(fake);

    const status = await customs.getStatus({ rule_date: RULE_DATE });
    const query = await customs.search(searchInput());

    expect(status.status).toBe("blocked");
    expect(query.status).toBe("blocked");
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ["ready=false", { ready: false, reasons: ["publication_pending"] }],
    ["testData=true", { ready: true, testData: true, reasons: ["fixture_data"] }],
    ["unsupported operation", { supportedOperations: ["status", "status"] }],
    ["release identity missing", { releaseIds: [] }],
    ["snapshot identity missing", { snapshotHash: null }],
    ["release identity missing", { releaseHash: null }],
  ] as const)("does not query when status gate is %s", async (_name, overrides) => {
    const fake = fakeFetch([{ body: statusResponse(overrides) }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).not.toBe("success");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("GET");
  });

  it("allows query only when ready and non-test status facts are independently true", async () => {
    const fake = fakeFetch([{ body: statusResponse() }, { body: queryResponse() }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("success");
    expect(response.data).toMatchObject({
      data_status: {
        ready: true,
        test_data: false,
        release_ids: ["release-ca-1"],
      },
    });
  });

  it("maps a valid status with independent readiness facts and identity evidence", async () => {
    const fake = fakeFetch([{ body: statusResponse({ ready: true, testData: true }) }]);
    const customs = adapter(fake);

    const response = await customs.getStatus({ rule_date: RULE_DATE }, context);

    expect(response.status).toBe("success");
    dataStatusSchema.parse(response.data);
    expect(response.data).toMatchObject({
      ready: true,
      test_data: true,
      release_ids: ["release-ca-1"],
    });
    expect(response.sourceRefs).toHaveLength(1);
  });

  it("preserves the complete status evidence from a 503 data_not_ready response", async () => {
    const fake = fakeFetch([{
      status: 503,
      body: {
        ...statusResponse({ ready: false, testData: false, reasons: ["publication_pending"] }),
        error: { code: "data_not_ready", message: "publication pending" },
      },
    }]);
    const customs = adapter(fake);

    const response = await customs.getStatus({ rule_date: RULE_DATE }, context);

    expect(response.status).toBe("unavailable");
    expect(response.data).toMatchObject({
      ready: false,
      test_data: false,
      reasons: ["publication_pending"],
      release_ids: ["release-ca-1"],
    });
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.ready_false");
  });

  it("rejects ready status with reasons before attempting query", async () => {
    const fake = fakeFetch([{ body: statusResponse({ ready: true, reasons: ["publication_warning"] }) }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.status_contract_invalid");
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects ready query dataStatus with reasons", async () => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({
        dataStatus: {
          ...identity(),
          evaluatedAt: EVALUATED_AT,
          lastSourceCheckAt: EVALUATED_AT,
          ready: true,
          testData: false,
          reasons: ["publication_warning"],
        },
      }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.query_contract_invalid");
  });

  it.each([
    ["contractVersion", { contractVersion: "riskcustoms-query.v2" }],
    ["serviceVersion", { serviceVersion: "riskcustoms-service.fixture-2" }],
    ["publishedAt", { publishedAt: "2026-08-10T00:00:00.000Z" }],
    ["supportedOperations", { supportedOperations: ["query", "status"] }],
    ["releaseIds", { releaseIds: ["release-ca-2"] }],
    ["snapshotHash", { snapshotHash: "c".repeat(64) }],
    ["releaseHash", { releaseHash: "d".repeat(64) }],
  ] as const)("fails closed when query %s identity differs from status", async (_name, mismatch) => {
    const queryIdentity = { ...identity(), ...mismatch };
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({ ...queryIdentity, dataStatus: {
        ...queryIdentity,
        evaluatedAt: EVALUATED_AT,
        lastSourceCheckAt: EVALUATED_AT,
        ready: true,
        testData: false,
        reasons: [],
      } }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).not.toBe("success");
    expect(response.data).toBeNull();
    expect(response.blockers).toHaveLength(1);
  });

  it("fails closed when the publication identity changes during the query", async () => {
    const changedIdentity = { ...identity(), snapshotHash: "e".repeat(64) };
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({ ...changedIdentity, dataStatus: {
        ...changedIdentity,
        evaluatedAt: EVALUATED_AT,
        lastSourceCheckAt: EVALUATED_AT,
        ready: true,
        testData: false,
        reasons: [],
      } }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("manual_review");
    expect(response.blockers?.map(({ code }) => code)).toContain(
      "customs.identity_mismatch",
    );
  });

  it("rejects unknown fields in status and nested query responses", async () => {
    const statusFake = fakeFetch([{ body: statusResponse({ unexpected: true }) }]);
    const queryFake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({ candidates: [{ ...candidate(), unexpected: true }] }) },
    ]);

    const statusResult = await adapter(statusFake).getStatus({ rule_date: RULE_DATE }, context);
    const queryResult = await adapter(queryFake).search(searchInput(), context);

    expect(statusResult.status).toBe("unavailable");
    expect(queryResult.status).toBe("unavailable");
    expect(statusFake.calls).toHaveLength(1);
    expect(queryFake.calls).toHaveLength(2);
  });

  it("maps only the verified China-origin scope and camel-cases originCountry", async () => {
    const fake = fakeFetch([{ body: statusResponse() }, { body: queryResponse() }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput({
      product_attributes: {
        material: "synthetic",
        use: "fixture-use",
        origin_country: "CN",
        contains_steel_aluminum: false,
        extra_attribute: "not-in-tool-contract",
      },
    }), context);

    expect(response.status).toBe("success");
    expect(fake.calls[1]?.body).toEqual({
      query: "synthetic widget",
      ruleDate: RULE_DATE,
      codeCountry: "CA",
      selectedHs6: "123456",
      attributes: {
        material: "synthetic",
        use: "fixture-use",
        originCountry: "CN",
        contains_steel_aluminum: false,
      },
    });
    expect(JSON.stringify(fake.calls[1]?.body)).not.toContain("extra_attribute");
  });

  it("keeps classification source refs separate from rate, document, measure, and unused sources", async () => {
    const rateSourceId = "source-rate-1";
    const documentSourceId = "source-document-1";
    const measureSourceId = "source-measure-1";
    const unusedSourceId = "source-unused-1";
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({
        candidates: [],
        results: [{
          ...candidate(),
          rates: [rateLine(rateSourceId)],
          confirmedTotalPercent: null,
          documents: [documentItem(documentSourceId)],
          measures: [measure(measureSourceId)],
          warnings: [],
        }],
        sources: [
          source(),
          source({ id: rateSourceId }),
          source({ id: documentSourceId }),
          source({ id: measureSourceId }),
          source({ id: unusedSourceId }),
        ],
      }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("success");
    const data = response.data as { candidates: Array<{ source_ref_ids: string[] }> };
    expect(data.candidates[0]?.source_ref_ids).toHaveLength(1);
    expect(response.sourceRefs).toHaveLength(2);
  });

  it.each([
    ["future", { effectiveFrom: "2026-08-13", effectiveTo: null }],
    ["expired", { effectiveFrom: "2026-01-01", effectiveTo: RULE_DATE }],
  ] as const)("fails closed for a %s classification source", async (_name, dates) => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({ sources: [source(dates)] }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).not.toBe("success");
  });

  it("rejects HTTPS source URLs with userinfo without echoing credentials", async () => {
    const secret = "fixture-source-secret";
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({ sources: [source({ officialUrl: `https://fixture-user:${secret}@official.example.invalid/source` })] }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("unavailable");
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it("returns no HTTP call for missing or non-China origin", async () => {
    const fake = fakeFetch([]);
    const customs = adapter(fake);

    const missing = await customs.search(searchInput({
      product_attributes: { material: null, use: "fixture-use", origin_country: null, contains_steel_aluminum: false },
    }), context);
    const unsupported = await customs.search(searchInput({
      product_attributes: { material: null, use: "fixture-use", origin_country: "US", contains_steel_aluminum: false },
    }), context);

    expect(missing.status).toBe("needs_input");
    expect(unsupported.status).toBe("unavailable");
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    [401, "blocked"],
    [403, "blocked"],
    [429, "unavailable"],
    [503, "unavailable"],
  ] as const)("fails closed for M2M status HTTP %s", async (httpStatus, expectedStatus) => {
    const fake = fakeFetch([{ status: httpStatus, body: { error: "upstream failure" } }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe(expectedStatus);
    expect(JSON.stringify(response)).not.toContain("upstream failure");
    expect(JSON.stringify(response)).not.toContain("synthetic widget");
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps 503 query responses as generic upstream errors", async () => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { status: 503, body: { error: { code: "data_not_ready", message: "query changed" } } },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.query_unavailable");
    expect(JSON.stringify(response)).not.toContain("query changed");
  });

  it("fails closed for invalid JSON and schema-invalid JSON", async () => {
    const invalidJson = fakeFetch([{ raw: "not-json" }]);
    const invalidSchema = fakeFetch([{ body: { ...statusResponse(), ready: "true" } }]);

    const invalidJsonResult = await adapter(invalidJson).search(searchInput(), context);
    const invalidSchemaResult = await adapter(invalidSchema).search(searchInput(), context);

    expect(invalidJsonResult.status).toBe("unavailable");
    expect(invalidSchemaResult.status).toBe("unavailable");
  });

  it("maps timeout and caller abort to unavailable without leaking inputs", async () => {
    const timeoutFake = fakeFetch([{ pending: true }]);
    const timeoutResult = await adapter(timeoutFake, { timeoutMs: 5 }).search(searchInput(), context);
    expect(timeoutResult.status).toBe("unavailable");

    const abortFake = fakeFetch([{ pending: true }]);
    const controller = new AbortController();
    const promise = adapter(abortFake).search(searchInput(), context, controller.signal);
    controller.abort();
    const abortResult = await promise;
    expect(abortResult.status).toBe("unavailable");
    expect(JSON.stringify(abortResult)).not.toContain("synthetic widget");
  });

  it("keeps customs.ca.estimate unavailable with zero HTTP calls", async () => {
    const fake = fakeFetch([]);
    const customs = adapter(fake);

    const response = await customs.estimate({ rule_date: RULE_DATE }, context);

    expect(response.status).toBe("unavailable");
    expect(response.data).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("passes formal tool input, server context, and output validation end to end", async () => {
    const fake = fakeFetch([{ body: statusResponse() }, { body: queryResponse() }]);
    const customs = adapter(fake);
    const bundle = createPhase1Bundle({ ...createFixtureAdapters(), customs });
    const definition = registerPhaseOneTools(bundle.handlers, bundle.contracts).find(
      (candidateDefinition) => candidateDefinition.name === "customs.ca.search",
    );
    if (definition === undefined) throw new Error("customs.ca.search was not registered");

    const execution = await executeRegisteredToolWithResult(
      definition,
      searchInput(),
      context,
      { requestId: "req:customs:m2m", auditId: "audit:customs:m2m" },
    );

    expect(execution.envelope.status).toBe("success");
    customsSearchResultSchema.parse(execution.envelope.data);
    expect(execution.envelope.data).toMatchObject({
      data_status: { ready: true, test_data: false, release_ids: ["release-ca-1"] },
    });
    expect(fake.calls[0]?.headers["x-tenant-id"]).toBe(context.tenantId);
  });

  it("keeps the default production connector disabled", async () => {
    const fake = fakeFetch([]);
    const customs = new RiskCustomsApiAdapter({
      baseUrl: BASE_URL,
      allowedHosts: [HOST],
      fetchImpl: fake.fetchImpl,
    });

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("unavailable");
    expect(fake.calls).toHaveLength(0);
  });

  it("blocks a base URL outside the explicit allowlist before any request", async () => {
    const fake = fakeFetch([]);
    const customs = new RiskCustomsApiAdapter({
      baseUrl: BASE_URL,
      allowedHosts: ["other.example.invalid"],
      enabled: true,
      productionConnector: true,
      fetchImpl: fake.fetchImpl,
      authorizationProvider: () => "m2m-test-value",
    });

    const response = await customs.getStatus({ rule_date: RULE_DATE }, context);

    expect(response.status).toBe("blocked");
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps the shared HTTP client disabled by default", async () => {
    let fetchCalls = 0;
    const client = createFetchJsonClient({
      baseUrl: BASE_URL,
      allowedHosts: [HOST],
      fetchImpl: () => {
        fetchCalls += 1;
        throw new Error("fetch must not be called");
      },
    });

    await expect(client.get("/api/m2m/status")).rejects.toMatchObject({ code: "upstream_disabled" });
    expect(fetchCalls).toBe(0);
  });
});
