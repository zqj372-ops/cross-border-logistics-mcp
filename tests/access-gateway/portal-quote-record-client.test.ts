import { describe, expect, it, vi } from "vitest";

import {
  createQuoteRecordPortalClient,
  type QuoteRecordDelegationSignInput,
  type QuoteRecordDelegationSigner,
} from "../../services/access-gateway/portal/business/quote-record-client.js";

const NOW = 1_788_566_400;
const REQUEST_ID = "req_quote_record_0001";
const HASH = `sha256:${"a".repeat(64)}`;
const ACTOR = { type: "user" as const, id: "user-1" };
const INPUT = { address_line: "8888 Keele St", postal_code: "L4K 2N2", city: "Concord", province: "ON", cbm: "4.2", weight_kg: "850",
  piece_count: 10, packaging_type: "carton", longest_side_cm: "100", address_type: "commercial" as const, requires_liftgate: false,
  requires_pallet_jack: false, requires_appointment: true, explicit_pallet_count: null, is_stackable: null, detention_minutes: 0 };

function signer(capture?: (input: QuoteRecordDelegationSignInput) => void): QuoteRecordDelegationSigner {
  return (input) => { capture?.(input); return Promise.resolve({ token: "signed.jwt", claims: { iss: "https://issuer.example.invalid/",
    aud: "freightclaw-quote-preview", sub: input.subject, actor_type: input.actorType, tenant_id: input.tenantId,
    service_caller_id: input.serviceCallerId, application_id: input.applicationId, request_id: input.requestId, scope: input.scope,
    iat: NOW, nbf: NOW, exp: NOW + 300, jti: "jti-quote-record-1" } }); };
}

function sourceRef() {
  return { source_id: "zone-price:source-1", source_type: "fixture", system: "canada-final-mile-zone-matrix",
    locator: "zone-price://toronto/2/3", version: "2026-06-03", retrieved_at: "2026-09-05T00:00:00Z",
    authority: "supporting", content_hash: HASH };
}

function preview() {
  return { currency: "USD", source_type: "zone_matrix", confidence: 90, postal_code: "L4K 2N2", postal_prefix: "L4K",
    preferred_city: "Concord", city: "Concord", province: "ON", origin: "toronto", zone: 2, billing_pallets: 3,
    pallet_breakdown: { volume: 2, weight: 3 }, base_price: "120.00", fuel: "12.00", accessorials: { appointment: "80.00" },
    total_price: "212.00", risk_tags: [], manual_review_required: true, matched_rule: "zone_matrix", matched_by: "postal_prefix_city",
    candidate_count: 1, match_trace: {}, sales_note: "preview" };
}

function envelope(schema_version: string, status: string, data: unknown, source_refs: unknown[] = [sourceRef()]) {
  return { schema_version, status, data, reason_codes: status === "manual_review" ? ["quote_source_not_authoritative"] : [], source_refs, request_id: REQUEST_ID };
}

function fixtureFetch(items: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit; body?: unknown }> = [];
  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const item = items.shift(); if (!item) throw new Error("fixture exhausted");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {}, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return Promise.resolve(new Response(JSON.stringify(item), { status: 200 }));
  });
  return { calls, fetchImpl };
}

function oneResponse(body: unknown, status = 200): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function client(fetchImpl: typeof fetch, delegationSigner: QuoteRecordDelegationSigner = signer()) {
  return createQuoteRecordPortalClient({ baseUrl: "https://quote.example.invalid", tenantId: "tenant-1", serviceCallerId: "portal-bff",
    applicationId: "app-1", connectionSecret: "connection-secret", delegationSigner, fetchImpl, clock: () => new Date(NOW * 1000) });
}

describe("quote record portal client", () => {
  it("prepares an opaque handle without adding tenant or actor to the body", async () => {
    let signed: QuoteRecordDelegationSignInput | undefined;
    const fake = fixtureFetch([envelope("quote-record-prepare@2026-09-05.v1", "manual_review", { preview: preview(), preview_handle: "opaque-handle-value-that-is-long-enough", expires_at: "2026-09-05T00:10:00Z" })]);
    const result = await client(fake.fetchImpl, signer((input) => { signed = input; })).prepare({ input: INPUT, actor: ACTOR, requestId: REQUEST_ID });
    expect(result).toMatchObject({ status: "manual_review", data: { preview_handle: "opaque-handle-value-that-is-long-enough" } });
    expect(signed?.scope).toBe("quote.zone_preview");
    expect(fake.calls[0]?.body).toEqual({ schema_version: "quote-record-prepare@2026-09-05.v1", request: INPUT });
    expect(fake.calls[0]?.body).not.toHaveProperty("tenant_id");
  });

  it("saves with explicit intent and idempotency then preserves readback and source evidence", async () => {
    let signed: QuoteRecordDelegationSignInput | undefined;
    const saved = { operation_ref: "op_abcdefghijklmnop", record_ref: "record_abcdefghijklmnop", record_version: 1,
      record_status: "manual_required", review_task_ref: "task_abcdefghijklmnop", currency: "USD", saved: true, sendable: false,
      readback_verified: true, created_at: "2026-09-05T00:00:00Z", request: INPUT, preview: preview(), source_refs: [sourceRef()] };
    const fake = fixtureFetch([envelope("quote-record-write@2026-09-05.v1", "manual_review", saved)]);
    const result = await client(fake.fetchImpl, signer((input) => { signed = input; })).save({ input: INPUT,
      previewHandle: "opaque-handle-value-that-is-long-enough", idempotencyKey: "idem_quote_record_0001", actor: ACTOR, requestId: REQUEST_ID });
    expect(result).toMatchObject({ status: "manual_review", data: { saved: true, sendable: false, readback_verified: true, currency: "USD" } });
    expect(result.source_refs[0]).toMatchObject({ authority: "supporting", version: "2026-06-03" });
    expect(signed?.scope).toBe("quote.record_save");
    expect(new Headers(fake.calls[0]?.init.headers).get("idempotency-key")).toBe("idem_quote_record_0001");
    expect(fake.calls[0]?.body).toEqual({ schema_version: "quote-record-write@2026-09-05.v1", preview_handle: "opaque-handle-value-that-is-long-enough", request: INPUT, intent: "save_draft" });
  });

  it("reads bounded personal history and review tasks using GET without bodies", async () => {
    const record = { record_ref: "record_abcdefghijklmnop", record_version: 1, record_status: "manual_required",
      review_task_ref: "task_abcdefghijklmnop", currency: "USD", saved: true, sendable: false, readback_verified: true,
      created_at: "2026-09-05T00:00:00Z", request: INPUT, preview: preview(), source_refs: [sourceRef()] };
    const task = { task_ref: "task_abcdefghijklmnop", record_ref: "record_abcdefghijklmnop", status: "pending", task_version: 1,
      reason: "quote_source_requires_review", risk_tags: ["source_not_authoritative"], resolved_price_usd: null,
      created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" };
    const fake = fixtureFetch([
      envelope("quote-record-write@2026-09-05.v1", "success", { records: [record], next_cursor: null }),
      envelope("quote-record-write@2026-09-05.v1", "success", { tasks: [task] }, []),
    ]);
    const api = client(fake.fetchImpl);
    const history = await api.list({ limit: 25, status: "manual_required", actor: ACTOR, requestId: REQUEST_ID });
    expect(history.data?.records).toHaveLength(1);
    await expect(api.reviewTasks({ recordRef: "record_abcdefghijklmnop", actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({ data: { tasks: [{ status: "pending" }] } });
    expect(fake.calls.map((call) => [call.url, call.init.method, call.init.body])).toEqual([
      ["https://quote.example.invalid/api/v1/m2m/quote/records?limit=25&status=manual_required", "GET", undefined],
      ["https://quote.example.invalid/api/v1/m2m/quote/review-tasks?record_ref=record_abcdefghijklmnop", "GET", undefined],
    ]);
  });

  it("blocks service record writes locally and rejects malformed decimals before signing", async () => {
    const fetchImpl = vi.fn(); const delegationSigner = vi.fn(); const api = client(fetchImpl as typeof fetch, delegationSigner as QuoteRecordDelegationSigner);
    await expect(api.save({ input: INPUT, previewHandle: "opaque-handle-value-that-is-long-enough", idempotencyKey: "idem_quote_record_0002",
      actor: { type: "service", id: "portal-bff" }, requestId: REQUEST_ID })).resolves.toMatchObject({ status: "blocked", reason_codes: ["quote_record_user_required"] });
    const bad: unknown = { input: { ...INPUT, weight_kg: 850 }, actor: ACTOR, requestId: REQUEST_ID };
    await expect(api.prepare(bad as Parameters<typeof api.prepare>[0])).resolves.toMatchObject({ status: "needs_input", reason_codes: ["quote_record_request_invalid"] });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(delegationSigner).not.toHaveBeenCalled();
  });

  it("fails closed for redirect, oversized response, request mismatch and invalid signer claims", async () => {
    const redirectFetch: typeof fetch = () => Promise.resolve(new Response("", { status: 302, headers: { location: "https://other.invalid" } }));
    await expect(client(redirectFetch).prepare({ input: INPUT, actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({ status: "unavailable", reason_codes: ["quote_upstream_redirect_rejected"] });
    const oversized = fixtureFetch([{ value: "x".repeat(500) }]);
    const limited = createQuoteRecordPortalClient({ baseUrl: "https://quote.example.invalid", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1",
      connectionSecret: "secret", delegationSigner: signer(), fetchImpl: oversized.fetchImpl, maxBodyBytes: 100, clock: () => new Date(NOW * 1000) });
    await expect(limited.prepare({ input: INPUT, actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({ status: "unavailable", reason_codes: ["quote_upstream_response_too_large"] });
    const mismatch = fixtureFetch([{ ...envelope("quote-record-write@2026-09-05.v1", "blocked", null, []), request_id: "req_other_00000001" }]);
    await expect(client(mismatch.fetchImpl).get({ recordRef: "record_abcdefghijklmnop", actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({ status: "blocked", reason_codes: ["quote_delegation_mismatch"] });
    const badSigner: QuoteRecordDelegationSigner = async (input) => ({ ...(await signer()(input)), claims: { ...(await signer()(input)).claims, application_id: "other-app" } });
    const unused = vi.fn();
    await expect(client(unused as typeof fetch, badSigner).prepare({ input: INPUT, actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({ status: "blocked", reason_codes: ["quote_delegation_invalid"] });
    expect(unused).not.toHaveBeenCalled();
  });

  it("downgrades prepare success when source evidence is missing or supporting", async () => {
    const supporting = envelope("quote-record-prepare@2026-09-05.v1", "success", { preview: preview(),
      preview_handle: "opaque-handle-value-that-is-long-enough", expires_at: "2026-09-05T00:10:00Z" });
    await expect(client(oneResponse(supporting)).prepare({ input: INPUT, actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "manual_review", reason_codes: ["quote_source_not_authoritative"],
    });
    const missing = envelope("quote-record-prepare@2026-09-05.v1", "success", { preview: preview(),
      preview_handle: "opaque-handle-value-that-is-long-enough", expires_at: "2026-09-05T00:10:00Z" }, []);
    await expect(client(oneResponse(missing)).prepare({ input: INPUT, actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "manual_review", reason_codes: ["quote_source_evidence_missing"],
    });
  });

  it("accepts saved pending only as explicit manual-review readback pending", async () => {
    const pending = { operation_ref: "op_abcdefghijklmnop", record_ref: "record_abcdefghijklmnop", saved: true, sendable: false, readback_verified: false };
    const valid = envelope("quote-record-write@2026-09-05.v1", "manual_review", pending, []);
    valid.reason_codes = ["write_readback_pending"];
    await expect(client(oneResponse(valid)).save({ input: INPUT, previewHandle: "opaque-handle-value-that-is-long-enough",
      idempotencyKey: "idem_quote_record_0003", actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "manual_review", data: { saved: true, readback_verified: false }, reason_codes: ["write_readback_pending"],
    });
    const falseSuccess = { ...valid, status: "success" };
    await expect(client(oneResponse(falseSuccess)).save({ input: INPUT, previewHandle: "opaque-handle-value-that-is-long-enough",
      idempotencyKey: "idem_quote_record_0004", actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable", data: null, reason_codes: ["quote_upstream_contract_invalid"],
    });
  });

  it("rejects HTTP/status conflicts, failure data and mismatched inner evidence", async () => {
    const prepareData = { preview: preview(), preview_handle: "opaque-handle-value-that-is-long-enough", expires_at: "2026-09-05T00:10:00Z" };
    const httpFailureSuccess = envelope("quote-record-prepare@2026-09-05.v1", "success", prepareData);
    await expect(client(oneResponse(httpFailureSuccess, 500)).prepare({ input: INPUT, actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable", reason_codes: ["quote_upstream_contract_invalid"],
    });
    const blockedWithData = envelope("quote-record-write@2026-09-05.v1", "blocked", { operation_ref: "op_abcdefghijklmnop",
      record_ref: "record_abcdefghijklmnop", saved: true, sendable: false, readback_verified: false }, []);
    await expect(client(oneResponse(blockedWithData, 403)).save({ input: INPUT, previewHandle: "opaque-handle-value-that-is-long-enough",
      idempotencyKey: "idem_quote_record_0005", actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable", reason_codes: ["quote_upstream_contract_invalid"],
    });
    const saved = { operation_ref: "op_abcdefghijklmnop", record_ref: "record_abcdefghijklmnop", record_version: 1,
      record_status: "manual_required", review_task_ref: "task_abcdefghijklmnop", currency: "USD", saved: true, sendable: false,
      readback_verified: true, created_at: "2026-09-05T00:00:00Z", request: INPUT, preview: preview(),
      source_refs: [{ ...sourceRef(), version: "different-version" }] };
    const mismatch = envelope("quote-record-write@2026-09-05.v1", "manual_review", saved);
    await expect(client(oneResponse(mismatch)).save({ input: INPUT, previewHandle: "opaque-handle-value-that-is-long-enough",
      idempotencyKey: "idem_quote_record_0006", actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unavailable", reason_codes: ["quote_upstream_contract_invalid"],
    });
  });
});
