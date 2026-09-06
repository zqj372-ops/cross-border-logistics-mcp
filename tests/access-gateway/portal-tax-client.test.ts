import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  createTaxPortalClient,
  type TaxDelegationSignInput,
  type TaxDelegationSigner,
  type TaxSourceEstimateResponse,
} from "../../services/access-gateway/portal/business/tax-client";

const RULE_DATE = "2026-09-05";
const PUBLISHED_AT = "2026-09-04T00:00:00.000Z";
const SNAPSHOT = "a".repeat(64);
const RELEASE = "b".repeat(64);
const NOW = 1_788_566_400;
const fixturePath = fileURLToPath(new URL("fixtures/riskcustoms-tariff-estimate-success.json", import.meta.url));
const successResponse = JSON.parse(readFileSync(fixturePath, "utf8")) as TaxSourceEstimateResponse;

function status(snapshotHash = SNAPSHOT) {
  return {
    contractVersion: "riskcustoms-query.v1", serviceVersion: "riskcustoms-2.0.0", publishedAt: PUBLISHED_AT,
    supportedOperations: ["status", "query"], ruleDate: RULE_DATE, releaseIds: ["release-1"],
    snapshotHash, releaseHash: RELEASE, evaluatedAt: PUBLISHED_AT, lastSourceCheckAt: PUBLISHED_AT,
    ready: true, testData: false, reasons: [],
  };
}

const input = {
  ruleDate: RULE_DATE, lineId: "line-1", description: "Cotton shirt", hsCode: "610510",
  destinationCountry: "CA", declaredValue: "100.00", currency: "CAD", attributes: { originCountry: "CN" },
} as const;
const itemInput = {
  lineId: input.lineId, description: input.description, hsCode: input.hsCode,
  destinationCountry: input.destinationCountry, declaredValue: input.declaredValue,
  currency: input.currency, attributes: input.attributes,
};

function signer(overrides: Partial<TaxDelegationSignInput> = {}): TaxDelegationSigner {
  const implementation: TaxDelegationSigner = (expected) => {
    const claims = {
      iss: "https://portal.example.invalid/", aud: "riskcustoms", sub: expected.subject,
      actor_type: expected.actorType, tenant_id: expected.tenantId, service_caller_id: expected.serviceCallerId,
      application_id: expected.applicationId, request_id: expected.requestId, scope: expected.scope,
      iat: NOW, nbf: NOW, exp: NOW + 240, jti: "jti-1", ...overrides,
    };
    return Promise.resolve({ token: "signed-token", claims });
  };
  return vi.fn(implementation);
}

function resourceUrl(resource: string | URL | Request): string {
  return typeof resource === "string" ? resource : resource instanceof URL ? resource.href : resource.url;
}

function requestBody(init: RequestInit): unknown {
  if (typeof init.body !== "string") throw new Error("missing request body");
  return JSON.parse(init.body) as unknown;
}

function client(fetchImpl: typeof fetch, delegationSigner: TaxDelegationSigner = signer()) {
  return createTaxPortalClient({
    baseUrl: "https://customs.example.invalid", tenantId: "tenant-1", serviceCallerId: "portal-bff",
    applicationId: "customs-app", connectionSecret: "connection-secret", delegationSigner, fetchImpl,
    clock: () => new Date(NOW * 1000),
  });
}

describe("portal tariff estimate client", () => {
  it("signs the exact estimate scope and preserves a complete source response after two matching publication reads", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const delegationSigner = signer();
    const fetchImpl: typeof fetch = vi.fn((resource: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: resourceUrl(resource), init: init ?? {} });
      const body = calls.length === 2 ? successResponse : status();
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    });
    const result = await client(fetchImpl, delegationSigner).estimate({ input, actor: { type: "user", id: "user-1" }, requestId: "req_12345678" });
    expect(result).toEqual({ schema_version: "portal-tax@2026-09-05.v1", status: "success", data: successResponse, reason_codes: [], request_id: "req_12345678" });
    expect(delegationSigner).toHaveBeenCalledWith({ subject: "user-1", actorType: "user", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "customs-app", requestId: "req_12345678", scope: "customs.tax.estimate" });
    expect(calls.map((call) => [new URL(call.url).pathname, call.init.method])).toEqual([
      ["/api/m2m/status", "GET"], ["/api/m2m/v1/tariff-estimate", "POST"], ["/api/m2m/status", "GET"],
    ]);
    expect(calls[1]!.init.headers).toMatchObject({ authorization: "Bearer connection-secret", "x-tenant-id": "tenant-1", "x-freightclaw-delegation": "signed-token" });
    expect(requestBody(calls[1]!.init)).toEqual(input);
  });

  it("preserves mixed batch row states, exact counts and original camelCase source evidence", async () => {
    const second = { ...successResponse.result, lineId: "line-2", status: "needs_input", input: { lineId: "line-2" }, exchangeRate: null,
      valueForDuty: null, valueForTax: null, confirmedSubtotal: null, customsPayable: null, lines: [], sources: [], reasonCodes: ["missing_hs_code"] };
    const batch = {
      contractVersion: "riskcustoms-tariff-estimate.v1", requestId: "req_12345678", status: "manual_review",
      partialFailure: true, delegatedActor: successResponse.delegatedActor,
      counts: { total: 2, success: 1, needsInput: 1, manualReview: 0, unavailable: 0 },
      results: [successResponse.result, second],
    };
    let call = 0;
    const fetchMock = vi.fn(() => { call += 1; return Promise.resolve(new Response(JSON.stringify(call === 2 ? batch : status()), { status: 200 })); });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const result = await client(fetchImpl).estimateBatch({ input: { ruleDate: RULE_DATE, items: [itemInput, { lineId: "line-2" }] }, actor: { type: "user", id: "user-1" }, requestId: "req_12345678" });
    expect(result).toEqual({ schema_version: "portal-tax@2026-09-05.v1", status: "manual_review", data: batch, reason_codes: ["missing_hs_code"], request_id: "req_12345678" });
  });

  it("fails closed on stale publication, malformed money and mismatched delegated identity", async () => {
    let staleCall = 0;
    const staleMock = vi.fn(() => { staleCall += 1; return Promise.resolve(new Response(JSON.stringify(staleCall === 1 ? status() : staleCall === 2 ? successResponse : status("c".repeat(64))), { status: 200 })); });
    const staleFetch = staleMock as unknown as typeof fetch;
    await expect(client(staleFetch).estimate({ input, actor: { type: "user", id: "user-1" }, requestId: "req_12345678" })).resolves.toMatchObject({ status: "unavailable", data: null, reason_codes: ["tax_snapshot_changed"] });

    const malformed = { ...successResponse, result: { ...successResponse.result, customsPayable: { amount: 10.25, currency: "CAD" } } };
    let malformedCall = 0;
    const malformedMock = vi.fn(() => { malformedCall += 1; return Promise.resolve(new Response(JSON.stringify(malformedCall === 2 ? malformed : status()), { status: 200 })); });
    const malformedFetch = malformedMock as unknown as typeof fetch;
    await expect(client(malformedFetch).estimate({ input, actor: { type: "user", id: "user-1" }, requestId: "req_12345678" })).resolves.toMatchObject({ status: "unavailable", data: null, reason_codes: ["tax_upstream_contract_invalid"] });

    const mismatch = { ...successResponse, delegatedActor: { ...successResponse.delegatedActor, ref: "other-user" } };
    let mismatchCall = 0;
    const mismatchMock = vi.fn(() => { mismatchCall += 1; return Promise.resolve(new Response(JSON.stringify(mismatchCall === 2 ? mismatch : status()), { status: 200 })); });
    const mismatchFetch = mismatchMock as unknown as typeof fetch;
    await expect(client(mismatchFetch).estimate({ input, actor: { type: "user", id: "user-1" }, requestId: "req_12345678" })).resolves.toMatchObject({ status: "blocked", data: null, reason_codes: ["tax_delegation_mismatch"] });

    const wrongInput = { ...successResponse, result: { ...successResponse.result, input: { ...successResponse.result.input, declaredValue: "999.00" } } };
    let wrongInputCall = 0;
    const wrongInputMock = vi.fn(() => { wrongInputCall += 1; return Promise.resolve(new Response(JSON.stringify(wrongInputCall === 2 ? wrongInput : status()), { status: 200 })); });
    await expect(client(wrongInputMock as unknown as typeof fetch).estimate({ input, actor: { type: "user", id: "user-1" }, requestId: "req_12345678" })).resolves.toMatchObject({ status: "blocked", data: null, reason_codes: ["tax_response_request_mismatch"] });
  });

  it("accepts a contract-valid 503 unavailable result but rejects invalid requests before signing or network access", async () => {
    const unavailableSource = { ...successResponse, status: "unavailable", result: { ...successResponse.result, status: "unavailable", exchangeRate: null,
      valueForDuty: null, valueForTax: null, confirmedSubtotal: null, customsPayable: null, lines: [], sources: [], reasonCodes: ["estimate_dependency_unavailable"] } };
    let unavailableCall = 0;
    const fetchMock = vi.fn(() => {
      unavailableCall += 1;
      const sourceCall = unavailableCall === 2;
      return Promise.resolve(new Response(JSON.stringify(sourceCall ? unavailableSource : status()), { status: sourceCall ? 503 : 200 }));
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(client(fetchImpl).estimate({ input, actor: { type: "user", id: "user-1" }, requestId: "req_12345678" })).resolves.toEqual({ schema_version: "portal-tax@2026-09-05.v1", status: "unavailable", data: unavailableSource, reason_codes: ["estimate_dependency_unavailable"], request_id: "req_12345678" });

    const neverFetch = vi.fn() as unknown as typeof fetch; const neverSign = signer();
    await expect(client(neverFetch, neverSign).estimate({ input: { ...input, declaredValue: 100 } as never, actor: { type: "user", id: "user-1" }, requestId: "req_12345678" })).resolves.toMatchObject({ status: "needs_input", reason_codes: ["tax_request_invalid"] });
    expect(neverFetch).not.toHaveBeenCalled(); expect(neverSign).not.toHaveBeenCalled();
  });
});
