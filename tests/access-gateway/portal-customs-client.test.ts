import { describe, expect, it, vi } from "vitest";

import {
  createCustomsPortalClient,
  type CustomsDelegationSignInput,
  type CustomsDelegationSigner,
} from "../../services/access-gateway/portal/business/customs-client";

const RULE_DATE = "2026-09-05";
const PUBLISHED_AT = "2026-09-04T00:00:00.000Z";
const SNAPSHOT = "a".repeat(64);
const RELEASE = "b".repeat(64);
const NOW = 1_788_566_400;

function identity(contractVersion: "riskcustoms-query.v1" | "riskcustoms-query.v2", snapshotHash = SNAPSHOT) {
  return { contractVersion, serviceVersion: "riskcustoms-2.0.0", publishedAt: PUBLISHED_AT,
    supportedOperations: ["status", "query"], ruleDate: RULE_DATE, releaseIds: ["release-1"], snapshotHash, releaseHash: RELEASE };
}
function status(snapshotHash = SNAPSHOT) {
  return { ...identity("riskcustoms-query.v1", snapshotHash), evaluatedAt: PUBLISHED_AT, lastSourceCheckAt: PUBLISHED_AT, ready: true, testData: false, reasons: [] };
}
function source() {
  return { id: "source-cn", releaseId: "release-1", artifactId: "artifact-1", authority: "official", dataset: "cn-tariff", edition: "2026", revision: "1", officialUrl: "https://official.example.invalid/tariff", publishedAt: "2026-01-01", effectiveFrom: "2026-01-01", effectiveTo: null, retrievedAt: PUBLISHED_AT, sourceLocator: "opaque://source-cn" };
}
function candidate() {
  return { candidateId: "candidate-cn", country: "CN", code: "123456", displayCode: "123456", codeDigits: 6, parentCode: null,
    hierarchy: [{ code: "123456", displayCode: "123456", codeDigits: 6, legalNames: [{ language: "zh", text: "测试商品", sourceId: "source-cn" }] }],
    legalNames: [{ language: "zh", text: "测试商品", sourceId: "source-cn" }], chineseExplanation: { translationId: "translation-1", text: "测试说明", status: "not_needed", basedOnSourceIds: ["source-cn"] },
    classificationReason: "测试分类依据", classificationSourceIds: ["source-cn"], status: "confirmed", hs6: "123456" };
}
function queryResponse(snapshotHash = SNAPSHOT) {
  const base = candidate();
  return { ...identity("riskcustoms-query.v2", snapshotHash), requestId: "request-1", delegatedActor: { type: "user", ref: "user-1", applicationId: "app-1" },
    queryId: "query-1", mode: "exact_code", selectedHs6: "123456", nextQuestion: null, candidates: [base],
    results: [{ ...base, rates: [{ id: "rate-1", label: "出口税", treatment: "一般", category: "export_duty", kind: "free", rateExpressionRaw: "Free", displayValue: "Free", confirmed: true, includedInConfirmedTotal: false, effectiveFrom: "2026-01-01", effectiveTo: null, conditionText: "", interactionNote: "", sourceId: "source-cn" }], confirmedTotalPercent: null,
      documents: [{ id: "doc-1", label: "发票", side: "cn_export", status: "prepare_retain", conditions: [], reason: "报关资料", effectiveFrom: "2026-01-01", effectiveTo: null, sourceId: "source-cn" }],
      measures: [{ id: "measure-1", label: "监管措施", measureType: "license", originCountry: "CN", codeHint: null, matchStatus: "not_indicated", legalScope: "未指示", exceptions: [], caseNumber: null, exporterOrProducer: null, rateExpressionRaw: null, effectiveFrom: "2026-01-01", effectiveTo: null, sourceId: "source-cn" }], warnings: [] }],
    sources: [source()], dataStatus: { ...identity("riskcustoms-query.v2", snapshotHash), evaluatedAt: PUBLISHED_AT, lastSourceCheckAt: PUBLISHED_AT, ready: true, testData: false, reasons: [] }, testData: false };
}

function signer(capture?: (input: CustomsDelegationSignInput) => void): CustomsDelegationSigner {
  return (input) => {
    capture?.(input);
    return Promise.resolve({ token: "signed.jwt", claims: { iss: "https://issuer.example.invalid/", aud: "riskcustoms", sub: input.subject, actor_type: input.actorType, tenant_id: input.tenantId, service_caller_id: input.serviceCallerId, application_id: input.applicationId, request_id: input.requestId, scope: input.scope, iat: NOW, nbf: NOW, exp: NOW + 300, jti: "jti-1" } });
  };
}

function resourceUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function fixtureFetch(items: Array<{ status?: number; body?: unknown; location?: string }>) {
  const calls: Array<{ url: string; init: RequestInit; body?: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const item = items.shift();
    if (!item) throw new Error("fixture exhausted");
    const parsedBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? parsedBody as Record<string, unknown> : undefined;
    calls.push({ url: resourceUrl(input), init: init ?? {}, ...(body ? { body } : {}) });
    const responseInit: ResponseInit = { status: item.status ?? 200 };
    if (item.location) responseInit.headers = { location: item.location };
    return Promise.resolve(new Response(JSON.stringify(item.body ?? {}), responseInit));
  });
  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch, delegationSigner: CustomsDelegationSigner) {
  return createCustomsPortalClient({ baseUrl: "https://customs.example.invalid", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", connectionSecret: "connection-secret", delegationSigner, fetchImpl, clock: () => new Date(NOW * 1000) });
}
const request = { input: { query: "测试商品", ruleDate: RULE_DATE, codeCountry: "CN" as const, selectedHs6: "123456", attributes: { originCountry: "CN" as const, contains_steel_aluminum: "unknown" as const, vacuumInsulated: "unknown" as const } }, actor: { type: "user" as const, id: "user-1" }, requestId: "request-1" };

describe("customs portal client", () => {
  it("cancels an oversized chunked response before consuming the full body", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (pulls === 20) controller.close();
      },
      cancel,
    }))));
    await expect(client(fetchImpl, signer()).query(request)).resolves.toMatchObject({ status: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThan(8);
  });

  it("returns the complete v2 projection after bound delegation and comparable status checks", async () => {
    let signInput: CustomsDelegationSignInput | undefined;
    const fake = fixtureFetch([{ body: status() }, { body: queryResponse() }, { body: status() }]);
    const result = await client(fake.fetchImpl, signer((value) => { signInput = value; })).query(request);
    expect(result.status).toBe("success");
    expect(result.data?.results[0]?.country).toBe("CN");
    expect(result.data?.results[0]?.rates[0]?.displayValue).toBe("Free");
    expect(signInput).toEqual({ subject: "user-1", actorType: "user", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", requestId: "request-1", scope: "customs.query" });
    expect(fake.calls.map(({ url }) => url)).toEqual([
      `https://customs.example.invalid/api/m2m/status?ruleDate=${RULE_DATE}`,
      "https://customs.example.invalid/api/m2m/v2/query",
      `https://customs.example.invalid/api/m2m/status?ruleDate=${RULE_DATE}`,
    ]);
    expect(fake.calls[1]?.init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(fake.calls[1]?.init.headers).get("authorization")).toBe("Bearer connection-secret");
    expect(new Headers(fake.calls[1]?.init.headers).get("x-freightclaw-delegation")).toBe("signed.jwt");
    expect(fake.calls[1]?.body).toEqual(request.input);
    expect(fake.calls[1]?.body).not.toHaveProperty("querySessionId");
    expect(fake.calls[1]?.body).not.toHaveProperty("actor");
  });

  it.each([
    ["yes", true],
    ["no", false],
  ] as const)("normalizes %s product answers for the source while preserving the reviewed fields", async (answer, normalized) => {
    const fake = fixtureFetch([{ body: status() }, { body: queryResponse() }, { body: status() }]);
    const input = {
      ...request,
      input: { ...request.input, attributes: { originCountry: "CN" as const, contains_steel_aluminum: answer, vacuumInsulated: answer } },
    };
    await expect(client(fake.fetchImpl, signer()).query(input)).resolves.toMatchObject({ status: "success" });
    expect(fake.calls[1]?.body).toMatchObject({
      attributes: { originCountry: "CN", contains_steel_aluminum: normalized, vacuumInsulated: normalized },
    });
  });

  it("fails closed when the post-query snapshot changes", async () => {
    const fake = fixtureFetch([{ body: status() }, { body: queryResponse() }, { body: status("c".repeat(64)) }]);
    await expect(client(fake.fetchImpl, signer()).query(request)).resolves.toMatchObject({ status: "unavailable", reason_codes: ["customs_snapshot_changed"] });
  });

  it("preserves a source manual-review classification in the portal status", async () => {
    const response = queryResponse();
    response.candidates[0]!.status = "manual_review";
    response.results[0]!.status = "manual_review";
    const fake = fixtureFetch([{ body: status() }, { body: response }, { body: status() }]);
    await expect(client(fake.fetchImpl, signer()).query(request)).resolves.toMatchObject({
      status: "manual_review",
      reason_codes: ["customs_manual_review_required"],
      data: { results: [expect.objectContaining({ status: "manual_review" })] },
    });
  });

  it("rejects an upstream redirect without following it", async () => {
    const fake = fixtureFetch([{ body: status() }, { status: 302, location: "https://other.example.invalid/api" }]);
    const result = await client(fake.fetchImpl, signer()).query(request);
    expect(result).toMatchObject({ status: "unavailable", reason_codes: ["customs_upstream_redirect_rejected"] });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.init.redirect).toBe("manual");
  });

  it("does not call the signer or network for missing or unsafe configuration", async () => {
    const fetchImpl = vi.fn(); const delegationSigner = vi.fn();
    const missing = createCustomsPortalClient({ delegationSigner });
    const unsafe = createCustomsPortalClient({ baseUrl: "https://user:pass@customs.example.invalid", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", connectionSecret: "secret", delegationSigner, fetchImpl: fetchImpl as typeof fetch });
    await expect(missing.query(request)).resolves.toMatchObject({ status: "unavailable", reason_codes: ["customs_connection_unconfigured"] });
    await expect(unsafe.query(request)).resolves.toMatchObject({ status: "unavailable", reason_codes: ["customs_connection_unconfigured"] });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(delegationSigner).not.toHaveBeenCalled();
  });
});
