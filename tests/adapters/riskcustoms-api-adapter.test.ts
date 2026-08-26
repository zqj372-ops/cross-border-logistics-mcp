import { describe, expect, it, vi } from "vitest";

import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  createFetchJsonClient,
  type FetchImplementation,
} from "../../src/logistics_mcp/adapters/http-client";
import { hashPayload } from "../../src/logistics_mcp/platform/idempotency";
import {
  RiskCustomsApiAdapter,
  type RiskCustomsApiAdapterOptions,
} from "../../src/logistics_mcp/adapters/customs/riskcustoms-api-adapter";
import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import { createPhase1Bundle } from "../../src/logistics_mcp/adapters/phase1-bundle";
import {
  customsSearchResultSchema,
} from "../../src/logistics_mcp/adapters/contracts";
import {
  executeRegisteredToolWithResult,
  registerPhaseOneTools,
} from "../../src/logistics_mcp/server/tool-registry";

const BASE_URL = "https://riskcustoms.example.invalid";
const HOST = "riskcustoms.example.invalid";
const RULE_DATE = "2026-08-12";
const EVALUATED_AT = "2026-08-12T00:00:00.000Z";
const QUERY_RETRIEVED_AT = "2026-08-12T00:00:01.000Z";
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
    ruleDate: RULE_DATE,
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

function jurisdictionCandidate(
  country: "CN" | "US" | "CA",
  sourceId: string,
  code: string,
): Record<string, unknown> {
  return {
    ...candidate({ code }),
    candidateId: `candidate-${country}-${code}`,
    country,
    hierarchy: [{
      code,
      displayCode: code,
      codeDigits: code.length,
      legalNames: [legalName(sourceId)],
    }],
    legalNames: [legalName(sourceId)],
    chineseExplanation: {
      translationId: `translation-${country}-${code}`,
      text: "Synthetic fixture explanation",
      status: "machine",
      basedOnSourceIds: [sourceId],
    },
    classificationSourceIds: [sourceId],
  };
}

function rateLine(sourceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
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
    expect(authorizationProvider).toHaveBeenCalledWith(context, expect.any(AbortSignal));
    expect(JSON.stringify(fake.calls)).not.toContain("client-supplied-tenant");
    expect(JSON.stringify(response)).not.toContain("m2m-test-value");
  });

  it("uses the context tenant for every tenant, including a cross-tenant context", async () => {
    const fake = fakeFetch([{ body: statusResponse({ ready: false, testData: false, reasons: ["publication_pending"] }) }]);
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

  it("cancels a pending authorization provider on caller abort without fetching", async () => {
    const fake = fakeFetch([]);
    let providerSignal: AbortSignal | undefined;
    const authorizationProvider = vi.fn((_context: ExecutionContext, signal?: AbortSignal) => {
      providerSignal = signal;
      return new Promise<string>(() => undefined);
    });
    const customs = adapter(fake, { authorizationProvider, timeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = customs.getStatus({ rule_date: RULE_DATE }, context, controller.signal);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(authorizationProvider).toHaveBeenCalledWith(context, expect.any(AbortSignal));
    controller.abort();
    const response = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("caller abort did not settle")), 100)),
    ]);

    expect(response.status).toBe("unavailable");
    expect(providerSignal?.aborted).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("times out a pending authorization provider without fetching", async () => {
    const fake = fakeFetch([]);
    let providerSignal: AbortSignal | undefined;
    const authorizationProvider = vi.fn((_context: ExecutionContext, signal?: AbortSignal) => {
      providerSignal = signal;
      return new Promise<string>(() => undefined);
    });
    const customs = adapter(fake, { authorizationProvider, timeoutMs: 5 });
    const startedAt = Date.now();
    const response = await Promise.race([
      customs.getStatus({ rule_date: RULE_DATE }, context),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("provider timeout did not settle")), 100)),
    ]);

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(response.status).toBe("unavailable");
    expect(providerSignal?.aborted).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("cancels a pending search authorization provider without fetching", async () => {
    const fake = fakeFetch([]);
    let providerSignal: AbortSignal | undefined;
    const authorizationProvider = vi.fn((_context: ExecutionContext, signal?: AbortSignal) => {
      providerSignal = signal;
      return new Promise<string>(() => undefined);
    });
    const customs = adapter(fake, { authorizationProvider, timeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = customs.search(searchInput(), context, controller.signal);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(authorizationProvider).toHaveBeenCalledWith(context, expect.any(AbortSignal));
    controller.abort();
    const response = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("search abort did not settle")), 100)),
    ]);

    expect(response.status).toBe("unavailable");
    expect(providerSignal?.aborted).toBe(true);
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
    const query = queryResponse();
    const fake = fakeFetch([{ body: statusResponse() }, { body: query }]);
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
    expect(response.sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        locator: "opaque://riskcustoms/m2m/query",
        content_hash: hashPayload(query),
      }),
    ]));
  });

  it("records complete parsed status content and keeps snapshot identity separate", async () => {
    const status = statusResponse({ lastSourceCheckAt: "2026-08-12T00:00:00.500Z" });
    const fake = fakeFetch([{ body: status }]);

    const response = await adapter(fake).getStatus({ rule_date: RULE_DATE }, context);

    expect(response.status).toBe("success");
    expect(response.sourceRefs).toEqual([
      expect.objectContaining({
        content_hash: hashPayload(status),
      }),
    ]);
    expect(response.sourceRefs[0]?.content_hash).not.toBe(`sha256:${SNAPSHOT_HASH}`);
  });

  it("records one injected local query time and reuses it for query-derived evidence", async () => {
    const query = queryResponse({
      candidates: [candidate(), jurisdictionCandidate("CA", "source-ca-2", "234567")],
      sources: [source(), source({ id: "source-ca-2" })],
    });
    const fake = fakeFetch([{ body: statusResponse() }, { body: query }]);
    const clock = vi.fn(() => new Date(QUERY_RETRIEVED_AT));

    const response = await adapter(fake, { clock }).search(searchInput(), context);

    expect(response.status).toBe("success");
    expect(response.sourceRefs.find(({ locator }) => locator === "opaque://riskcustoms/m2m/status")?.retrieved_at).toBe(EVALUATED_AT);
    expect(response.sourceRefs.find(({ locator }) => locator === "opaque://riskcustoms/m2m/query")?.retrieved_at).toBe(QUERY_RETRIEVED_AT);
    const queryDerivedRefs = response.sourceRefs.filter(({ locator }) => locator !== "opaque://riskcustoms/m2m/status");
    expect(queryDerivedRefs).toHaveLength(3);
    expect(new Set(queryDerivedRefs.map(({ retrieved_at }) => retrieved_at))).toEqual(new Set([QUERY_RETRIEVED_AT]));
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it("projects only CA candidates from a multi-jurisdiction M2M response", async () => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({
        candidates: [
          jurisdictionCandidate("CN", "source-cn-1", "123456"),
          jurisdictionCandidate("US", "source-us-1", "234567"),
          jurisdictionCandidate("CA", "source-ca-candidate", "345678"),
        ],
        results: [{
          ...jurisdictionCandidate("CA", "source-ca-result", "345678"),
          status: "confirmed",
          rates: [],
          confirmedTotalPercent: null,
          documents: [],
          measures: [],
          warnings: [],
        }],
        sources: [
          source({ id: "source-cn-1" }),
          source({ id: "source-us-1" }),
          source({ id: "source-ca-candidate" }),
          source({ id: "source-ca-result" }),
        ],
      }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("success");
    expect((response.data as { candidates: Array<{ hs_code: string }> }).candidates).toEqual([
      expect.objectContaining({ hs_code: "345678", classification_status: "confirmed" }),
    ]);
    expect(response.sourceRefs).toHaveLength(3);
    expect(fake.calls).toHaveLength(2);
  });

  it("fails closed when a multi-jurisdiction response has no CA result or candidate", async () => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({
        candidates: [jurisdictionCandidate("CN", "source-cn-1", "123456")],
        results: [{
          ...jurisdictionCandidate("US", "source-us-1", "234567"),
          rates: [],
          confirmedTotalPercent: null,
          documents: [],
          measures: [],
          warnings: [],
        }],
        sources: [source({ id: "source-cn-1" }), source({ id: "source-us-1" })],
      }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.ca_results_missing");
    expect(fake.calls).toHaveLength(2);
  });

  it("rejects a contradictory ready=true and testData=true status", async () => {
    const fake = fakeFetch([{ body: statusResponse({ ready: true, testData: true }) }]);
    const customs = adapter(fake);

    const response = await customs.getStatus({ rule_date: RULE_DATE }, context);

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.status_contract_invalid");
    expect(response.data).toBeNull();
  });

  it("rejects ready=false status without a reason", async () => {
    const fake = fakeFetch([{ body: statusResponse({ ready: false, testData: false, reasons: [] }) }]);
    const customs = adapter(fake);

    const response = await customs.getStatus({ rule_date: RULE_DATE }, context);

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.status_contract_invalid");
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

  it("does not query when status was evaluated for a different rule date", async () => {
    const fake = fakeFetch([{ body: statusResponse({ ruleDate: "2026-08-11" }) }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.rule_date_mismatch");
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    ["contractVersion", { contractVersion: "riskcustoms-query.v2" }],
    ["serviceVersion", { serviceVersion: "riskcustoms-service.fixture-2" }],
    ["publishedAt", { publishedAt: "2026-08-10T00:00:00.000Z" }],
    ["supportedOperations", { supportedOperations: ["query", "status"] }],
    ["ruleDate", { ruleDate: "2026-08-11" }],
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

  it.each([
    ["material", 42],
    ["use", false],
    ["contains_steel_aluminum", "false"],
  ] as const)("rejects a non-contract %s attribute type before query", async (key, value) => {
    const fake = fakeFetch([{ body: statusResponse() }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput({
      product_attributes: {
        material: "synthetic",
        use: "fixture-use",
        origin_country: "CN",
        contains_steel_aluminum: false,
        [key]: value,
      },
    }), context);

    expect(response.status).toBe("needs_input");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.attributes_invalid");
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects material and use values over 200 characters before query", async () => {
    const fake = fakeFetch([{ body: statusResponse() }]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput({
      product_attributes: {
        material: "x".repeat(201),
        use: "fixture-use",
        origin_country: "CN",
        contains_steel_aluminum: false,
      },
    }), context);

    expect(response.status).toBe("needs_input");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.attributes_invalid");
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects online_search responses from the authoritative M2M path", async () => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({ mode: "online_search" }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.query_contract_invalid");
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
    expect(response.sourceRefs).toHaveLength(3);
  });

  it.each([
    "excise_duty",
    "excise_tax",
    "gst",
    "official_fee",
  ] as const)("accepts the current RiskCustoms %s rate category", async (category) => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({
        candidates: [],
        results: [{
          ...candidate(),
          status: "confirmed",
          rates: [rateLine("source-ca-1", { category })],
          confirmedTotalPercent: null,
          documents: [],
          measures: [],
          warnings: [],
        }],
      }) },
    ]);

    const response = await adapter(fake).search(searchInput(), context);

    expect(response.status).toBe("success");
  });

  it.each([
    "tax",
    "fee",
    "excise_duty",
    "excise_tax",
    "gst",
    "official_fee",
  ] as const)("rejects %s from the confirmed duty total", async (category) => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({
        candidates: [],
        results: [{
          ...candidate(),
          status: "confirmed",
          rates: [rateLine("source-ca-1", { category, includedInConfirmedTotal: true })],
          confirmedTotalPercent: "5",
          documents: [],
          measures: [],
          warnings: [],
        }],
      }) },
    ]);

    const response = await adapter(fake).search(searchInput(), context);

    expect(response.status).toBe("unavailable");
    expect(response.blockers?.map(({ code }) => code)).toContain("customs.query_contract_invalid");
  });

  it.each([
    ["future", { effectiveFrom: "2026-08-13", effectiveTo: null }],
    ["expired", { effectiveFrom: "2026-01-01", effectiveTo: "2026-08-11" }],
  ] as const)("fails closed for a %s classification source", async (_name, dates) => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({ sources: [source(dates)] }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).not.toBe("success");
  });

  it("keeps a classification source effective through its inclusive end date", async () => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({ sources: [source({ effectiveTo: RULE_DATE })] }) },
    ]);
    const customs = adapter(fake);

    const response = await customs.search(searchInput(), context);

    expect(response.status).toBe("success");
  });

  it("accepts a legal source retrievedAt with an explicit timezone offset", async () => {
    const fake = fakeFetch([
      { body: statusResponse() },
      { body: queryResponse({ sources: [source({ retrievedAt: "2026-08-12T08:00:00+08:00" })] }) },
    ]);

    const response = await adapter(fake).search(searchInput(), context);

    expect(response.status).toBe("success");
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
