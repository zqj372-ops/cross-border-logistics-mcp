import { describe, expect, it, vi } from "vitest";

import {
  createQuotePortalClient,
  type QuoteDelegationSignInput,
  type QuoteDelegationSigner,
} from "../../services/access-gateway/portal/business/quote-client.js";

const NOW = 1_788_566_400;
const SOURCE_SCHEMA = "quote-preview@2026-09-05.v2";
const REQUEST_ID = "req_quote_00000001";
const HASH = `sha256:${"a".repeat(64)}`;

function signer(capture?: (input: QuoteDelegationSignInput) => void): QuoteDelegationSigner {
  return (input) => {
    capture?.(input);
    return Promise.resolve({ token: "signed.jwt", claims: { iss: "https://issuer.example.invalid/", aud: "freightclaw-quote-preview", sub: input.subject, actor_type: input.actorType, tenant_id: input.tenantId, service_caller_id: input.serviceCallerId, application_id: input.applicationId, request_id: input.requestId, scope: input.scope, iat: NOW, nbf: NOW, exp: NOW + 300, jti: "jti-quote-1" } });
  };
}

function sourceRef(authority: "authoritative" | "supporting" = "authoritative") {
  return { source_id: "zone-price:source-1", source_type: "internal_system", system: "canada-final-mile-zone-matrix", locator: "zone-price://toronto/2/3", version: "2026-06-03", retrieved_at: "2026-09-05T00:00:00Z", authority, content_hash: HASH };
}

function zoneData() {
  return { currency: "USD", source_type: "zone_matrix", confidence: 90, postal_code: "L4K 2N2", postal_prefix: "L4K", preferred_city: "Concord", city: "Concord", province: "ON", origin: "toronto", zone: 2, billing_pallets: 3, pallet_breakdown: { volume: 2, weight: 3, pieces: 1, longest_side: 1, explicit: 0 }, base_price: "120.00", fuel: "12.00", accessorials: { appointment: "80.00" }, total_price: "212.00", risk_tags: [], manual_review_required: false, matched_rule: "zone_matrix", matched_by: "postal_prefix_city", candidate_count: 1, match_trace: {}, sales_note: "preview" };
}

function envelope(status: "success" | "needs_input" | "manual_review" | "blocked" | "unavailable", data: unknown, refs = [sourceRef()]) {
  return { schema_version: SOURCE_SCHEMA, status, data, reason_codes: [], source_refs: refs, request_id: REQUEST_ID };
}

function fixtureFetch(items: Array<{ status?: number; body?: unknown; location?: string }>) {
  const calls: Array<{ url: string; init: RequestInit; body?: unknown }> = [];
  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const item = items.shift();
    if (!item) throw new Error("fixture exhausted");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {}, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const responseInit: ResponseInit = { status: item.status ?? 200 };
    if (item.location) responseInit.headers = { location: item.location };
    return Promise.resolve(new Response(JSON.stringify(item.body ?? {}), responseInit));
  });
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch, delegationSigner: QuoteDelegationSigner) {
  return createQuotePortalClient({ baseUrl: "https://quote.example.invalid", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", connectionSecret: "connection-secret", delegationSigner, fetchImpl, clock: () => new Date(NOW * 1000) });
}

const previewRequest = { input: { address_line: "8888 Keele St", postal_code: "L4K 2N2", city: "Concord", province: "ON", cbm: "4.2", weight_kg: "850", piece_count: 10, packaging_type: "carton", longest_side_cm: "100", address_type: "commercial" as const, requires_liftgate: false, requires_pallet_jack: false, requires_appointment: true, explicit_pallet_count: null, is_stackable: null, detention_minutes: 0 }, actor: { type: "user" as const, id: "user-1" }, requestId: REQUEST_ID };

describe("quote portal client", () => {
  it("sends a closed native preview request and preserves USD plus real source evidence", async () => {
    let signInput: QuoteDelegationSignInput | undefined;
    const fake = fixtureFetch([{ body: envelope("success", zoneData()) }]);
    const result = await client(fake.fetchImpl, signer((input) => { signInput = input; })).preview(previewRequest);
    expect(result).toMatchObject({ status: "success", source_schema_version: SOURCE_SCHEMA, saved: false, sendable: false, preview_only: true });
    expect(result.data?.total_price).toBe("212.00");
    expect(result.data?.currency).toBe("USD");
    expect(result.source_refs[0]).toMatchObject({ version: "2026-06-03", content_hash: HASH });
    expect(signInput).toEqual({ subject: "user-1", actorType: "user", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", requestId: REQUEST_ID, scope: "quote.zone_preview" });
    expect(fake.calls[0]?.url).toBe("https://quote.example.invalid/api/v1/m2m/quote/zone-preview");
    expect(fake.calls[0]?.init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(fake.calls[0]?.init.headers).get("authorization")).toBe("Bearer connection-secret");
    expect(fake.calls[0]?.body).toEqual({ schema_version: SOURCE_SCHEMA, request: previewRequest.input });
    expect(fake.calls[0]?.body).not.toHaveProperty("tenant_id");
    expect(fake.calls[0]?.body).not.toHaveProperty("actor");
  });

  it("keeps a rule preview in manual review when its source is not authoritative", async () => {
    const fake = fixtureFetch([{ body: envelope("success", zoneData(), [sourceRef("supporting")]) }]);
    await expect(client(fake.fetchImpl, signer()).preview(previewRequest)).resolves.toMatchObject({ status: "manual_review", reason_codes: ["quote_source_not_authoritative"], saved: false, sendable: false });
  });

  it("preserves AI missing-input data and never asks the source to calculate a quote", async () => {
    const data = { extraction: { address_line: null, postal_code: "L4K 2N2", city: null, province: null, cbm: null, weight_kg: null, piece_count: null, packaging_type: null, longest_side_cm: null, explicit_pallet_count: null, is_stackable: null, address_type: null, requires_liftgate: false, requires_pallet_jack: false, requires_appointment: false, detention_minutes: 0, missing_fields: ["cbm"], confidence: 50, extraction_notes: null, cargo_items: [], cargo_agent: null, address_agent: null, validation_notes: [] }, extraction_mode: "ai", missing_fields: ["cbm"], follow_up_question: "请补充体积", quote_result: null };
    const fake = fixtureFetch([{ status: 422, body: envelope("needs_input", data, []) }]);
    const result = await client(fake.fetchImpl, signer()).extract({ input: { customer_message: "deliver to L4K 2N2" }, actor: { type: "user", id: "user-1" }, requestId: REQUEST_ID });
    expect(result).toMatchObject({ status: "needs_input", data: { quote_result: null }, saved: false, sendable: false });
    expect(fake.calls[0]?.url).toBe("https://quote.example.invalid/api/v1/m2m/quote/ai-extract-preview");
    expect(fake.calls[0]?.body).toEqual({ schema_version: SOURCE_SCHEMA, customer_message: "deliver to L4K 2N2" });
  });

  it("preserves an unavailable response body and rejects redirects", async () => {
    const unavailable = fixtureFetch([{ status: 503, body: envelope("unavailable", { quote_result: null }, []) }]);
    await expect(client(unavailable.fetchImpl as typeof fetch, signer()).extract({ input: { customer_message: "10 cartons" }, actor: { type: "service", id: "portal-bff" }, requestId: REQUEST_ID })).resolves.toMatchObject({ status: "unavailable" });
    const redirected = fixtureFetch([{ status: 302, location: "https://other.example.invalid" }]);
    await expect(client(redirected.fetchImpl as typeof fetch, signer()).preview(previewRequest)).resolves.toMatchObject({ status: "unavailable", reason_codes: ["quote_upstream_redirect_rejected"] });
    expect(redirected.calls[0]?.init.redirect).toBe("manual");
  });

  it("does not sign or call the network for unsafe configuration or numeric decimal input", async () => {
    const fetchImpl = vi.fn(); const delegationSigner = vi.fn();
    const unsafe = createQuotePortalClient({ baseUrl: "https://user:pass@quote.example.invalid", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", connectionSecret: "secret", delegationSigner, fetchImpl: fetchImpl as typeof fetch });
    await expect(unsafe.preview(previewRequest)).resolves.toMatchObject({ status: "unavailable", reason_codes: ["quote_connection_unconfigured"] });
    const configured = client(fetchImpl as typeof fetch, delegationSigner as QuoteDelegationSigner);
    const invalidRequest: unknown = { ...previewRequest, input: { ...previewRequest.input, weight_kg: 850 } };
    await expect(configured.preview(invalidRequest as Parameters<typeof configured.preview>[0])).resolves.toMatchObject({ status: "needs_input", reason_codes: ["quote_request_invalid"] });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(delegationSigner).not.toHaveBeenCalled();
  });

  it("fails closed on oversized bodies and invalid signer claims", async () => {
    const oversized = fixtureFetch([{ body: { value: "x".repeat(500) } }]);
    const limited = createQuotePortalClient({ baseUrl: "https://quote.example.invalid", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", connectionSecret: "secret", delegationSigner: signer(), fetchImpl: oversized.fetchImpl, maxBodyBytes: 100, clock: () => new Date(NOW * 1000) });
    await expect(limited.preview(previewRequest)).resolves.toMatchObject({ status: "unavailable", reason_codes: ["quote_upstream_response_too_large"] });
    const badSigner: QuoteDelegationSigner = async (input) => ({ ...(await signer()(input)), claims: { ...(await signer()(input)).claims, tenant_id: "other" } });
    const unused = vi.fn();
    await expect(client(unused as typeof fetch, badSigner).preview(previewRequest)).resolves.toMatchObject({ status: "blocked", reason_codes: ["quote_delegation_invalid"] });
    expect(unused).not.toHaveBeenCalled();
  });

  it("aborts an upstream request at the configured timeout", async () => {
    const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out with sensitive upstream detail", "AbortError")), { once: true });
    });
    const timed = createQuotePortalClient({ baseUrl: "http://127.0.0.1:9999", allowLoopbackFixtures: true, tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", connectionSecret: "secret", delegationSigner: signer(), fetchImpl, timeoutMs: 1, clock: () => new Date(NOW * 1000) });
    await expect(timed.preview(previewRequest)).resolves.toMatchObject({ status: "unavailable", reason_codes: ["quote_upstream_timeout"] });
  });
});
