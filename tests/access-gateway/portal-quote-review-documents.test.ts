import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createQuoteRecordPortalClient, type QuoteRecordDelegationSignInput, type QuoteRecordDelegationSigner } from "../../services/access-gateway/portal/business/quote-record-client.js";

const NOW = 1_788_566_400;
const REQUEST_ID = "req_quote_review_0001";
const ACTOR = { type: "user" as const, id: "fixture-owner" };
const HASH = `sha256:${"a".repeat(64)}`;
const zoneRequest = { address_line: "8888 Keele St", postal_code: "L4K 2N2", city: "Concord", province: "ON", cbm: "4.2", weight_kg: "850", piece_count: 10, packaging_type: "carton", longest_side_cm: "100", address_type: "commercial", requires_liftgate: false, requires_pallet_jack: false, requires_appointment: true, explicit_pallet_count: null, is_stackable: null, detention_minutes: 0 };
const preview = { currency: "USD", source_type: "manual_required", confidence: 50, postal_code: "L4K 2N2", postal_prefix: "L4K", preferred_city: "Concord", city: "Concord", province: "ON", origin: "toronto", zone: null, billing_pallets: 3, pallet_breakdown: { volume: 2, weight: 3 }, base_price: null, fuel: null, accessorials: {}, total_price: null, risk_tags: ["source_not_authoritative"], manual_review_required: true, matched_rule: "manual", matched_by: null, candidate_count: 0, match_trace: {}, sales_note: null };
const sourceRef = { source_id: "zone-price:source-1", source_type: "fixture", system: "canada-final-mile-zone-matrix", locator: "zone-price://toronto/2/3", version: "2026-06-03", retrieved_at: "2026-09-05T00:00:00Z", authority: "supporting", content_hash: HASH };
const evidence = { evidence_ref: "supplier_rate_ref_1", evidence_version: "supplier-release-2026-09-05", effective_at: "2026-09-05T08:00:00Z", valid_until: "2027-09-05T08:00:00Z" };
const chargeLines = [{ code: "base", label: "基础运费", amount_usd: "200.00" }, { code: "fuel", label: "燃油附加费", amount_usd: "45.50" }];
const resolution = { decision: "approve_manual_price", total_price_usd: "245.50", currency: "USD", review_evidence: evidence, charge_lines: chargeLines, customer_terms: "收货方负责现场卸货。", service_conditions: zoneRequest, source_snapshot_hash: HASH, note: "已核对供应商费率版本。", reviewer_actor_id: "fixture-owner", resolved_at: "2026-09-05T09:00:00Z", recalculation: { schema_version: "quote-preview@2026-09-05.v2", preview, source_refs: [sourceRef] } };

function signer(capture: QuoteRecordDelegationSignInput[] = []): QuoteRecordDelegationSigner {
  return (input) => { capture.push(input); return Promise.resolve({ token: "signed.jwt", claims: { iss: "https://issuer.example.invalid/", aud: "freightclaw-quote-preview", sub: input.subject, actor_type: input.actorType, tenant_id: input.tenantId, service_caller_id: input.serviceCallerId, application_id: input.applicationId, request_id: input.requestId, scope: input.scope, iat: NOW, nbf: NOW, exp: NOW + 300, jti: "jti-quote-review-1" } }); };
}

function client(fetchImpl: typeof fetch, delegationSigner: QuoteRecordDelegationSigner) {
  return createQuoteRecordPortalClient({ baseUrl: "https://quote.example.invalid", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", connectionSecret: "connection-secret", delegationSigner, fetchImpl, clock: () => new Date(NOW * 1000) });
}

function envelope(schema_version: string, status: string, data: unknown, source_refs: unknown[] = [sourceRef], reason_codes: string[] = status === "manual_review" ? ["quote_source_not_authoritative"] : []) {
  return { schema_version, status, data, reason_codes, source_refs, request_id: REQUEST_ID };
}

describe("quote review and document source client", () => {
  it("keeps review queue provenance and sends an explicit human confirmation on resolution", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: unknown }> = []; const signed: QuoteRecordDelegationSignInput[] = [];
    const replies = [
      envelope("quote-review-resolution@2026-09-05.v2", "success", { tasks: [{ task_ref: "task_abcdefghijklmnop", task_version: 1, record_ref: "record_abcdefghijklmnop", record_version: 1, status: "pending", reason: "quote_source_requires_review", risk_tags: ["source_not_authoritative"], created_by_actor_id: "fixture-developer", created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" }] }, [], []),
      envelope("quote-review-resolution@2026-09-05.v2", "manual_review", { record_ref: "record_abcdefghijklmnop", record_version: 1, task_ref: "task_abcdefghijklmnop", task_version: 1, preview, resolution_handle: "opaque-resolution-handle-that-is-long-enough", expires_at: "2026-09-05T00:10:00Z" }),
      envelope("quote-review-resolution@2026-09-05.v2", "success", { operation_ref: "op_abcdefghijklmnop", record_ref: "record_abcdefghijklmnop", record_version: 2, record_status: "quoted", task_ref: "task_abcdefghijklmnop", task_version: 2, task_status: "resolved", total_price_usd: "245.50", currency: "USD", review_evidence: evidence, charge_lines: chargeLines, customer_terms: resolution.customer_terms, service_conditions: zoneRequest, source_snapshot_hash: HASH, source_refs: [sourceRef], quote_ready: true, saved: true, sendable: false, pdf_available: false, bookable: false, readback_verified: true }, [sourceRef], []),
    ];
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => { const response = replies.shift(); const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; calls.push({ url, init: init ?? {}, body: typeof init?.body === "string" ? JSON.parse(init.body) : null }); return Promise.resolve(new Response(JSON.stringify(response), { status: 200 })); });
    const api = client(fetchImpl, signer(signed));
    const queue = await api.reviewQueue({ actor: ACTOR, requestId: REQUEST_ID });
    expect(queue.data?.tasks[0]).toMatchObject({ created_by_actor_id: "fixture-developer", record_version: 1 });
    const prepared = await api.prepareReview({ taskRef: "task_abcdefghijklmnop", actor: ACTOR, requestId: REQUEST_ID });
    if (!prepared.data?.resolution_handle) throw new Error("review preparation missing handle");
    await expect(api.resolveReview({ taskRef: "task_abcdefghijklmnop", expectedTaskVersion: 1, resolutionHandle: prepared.data.resolution_handle,
      decision: "approve_manual_price", totalPriceUsd: "245.50", evidenceRef: "supplier_rate_ref_1", evidenceVersion: "supplier-release-2026-09-05",
      effectiveAt: evidence.effective_at, validUntil: evidence.valid_until, chargeLines: [{ code: "base", label: "基础运费", amountUsd: "200.00" }],
      customerTerms: resolution.customer_terms, note: "已核对供应商费率版本。", confirmed: "human_verified_price_and_source",
      idempotencyKey: "idem_quote_review_invalid", actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({ status: "needs_input", reason_codes: ["quote_review_resolution_invalid"] });
    const resolved = await api.resolveReview({ taskRef: "task_abcdefghijklmnop", expectedTaskVersion: 1, resolutionHandle: prepared.data.resolution_handle, decision: "approve_manual_price", totalPriceUsd: "245.50", evidenceRef: "supplier_rate_ref_1", evidenceVersion: "supplier-release-2026-09-05", effectiveAt: evidence.effective_at, validUntil: evidence.valid_until, chargeLines: chargeLines.map(({ amount_usd, ...line }) => ({ ...line, amountUsd: amount_usd })), customerTerms: resolution.customer_terms, note: "已核对供应商费率版本。", confirmed: "human_verified_price_and_source", idempotencyKey: "idem_quote_review_0001", actor: ACTOR, requestId: REQUEST_ID });
    expect(resolved).toMatchObject({ status: "success", data: { quote_ready: true, total_price_usd: "245.50", sendable: false, review_evidence: { evidence_ref: "supplier_rate_ref_1" } } });
    expect(signed.map((item) => item.scope)).toEqual(["quote.review_manage", "quote.review_manage", "quote.review_manage"]);
    expect(calls[2]!.body).toEqual({ schema_version: "quote-review-resolution@2026-09-05.v2", expected_task_version: 1, resolution_handle: "opaque-resolution-handle-that-is-long-enough", decision: "approve_manual_price", currency: "USD", note: "已核对供应商费率版本。", total_price_usd: "245.50", evidence_ref: "supplier_rate_ref_1", evidence_version: "supplier-release-2026-09-05", effective_at: evidence.effective_at, valid_until: evidence.valid_until, charge_lines: chargeLines, customer_terms: resolution.customer_terms, confirmed: "human_verified_price_and_source" });
  });

  it("verifies private PDF bytes against source metadata and refuses altered content", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nverified fixture\n%%EOF"); const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const metadata = { document_ref: "document_abcdefghijklmnop", record_ref: "record_abcdefghijklmnop", record_version: 3, document_kind: "formal_quote_pdf", formal: true, valid_now: true, historical_snapshot: true, watermark: null, media_type: "application/pdf", content_sha256: digest, content_length: bytes.byteLength, schema_version: "quote-document@2026-09-05.v2", download_path: "/api/v1/m2m/quote/documents/document_abcdefghijklmnop/content", issued_at: "2026-09-05T09:00:00Z", valid_until: evidence.valid_until, source_snapshot_hash: HASH, terms_hash: HASH, created_at: "2026-09-05T00:00:00Z", readback_verified: true };
    const ref = { source_type: "source_system_quote_record", authority: "record_snapshot", record_ref: "record_abcdefghijklmnop", record_version: 3, formal: true, valid_until: evidence.valid_until, source_snapshot_hash: HASH, content_hash: digest };
    const fetchImpl = vi.fn(() => fetchImpl.mock.calls.length === 1
      ? Promise.resolve(new Response(JSON.stringify(envelope("quote-document-create@2026-09-05.v2", "success", metadata, [ref], [])), { status: 200 }))
      : Promise.resolve(new Response(bytes, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength), etag: `"${digest.slice(7)}"` } })));
    const result = await client(fetchImpl, signer()).downloadDocument({ documentRef: "document_abcdefghijklmnop", actor: ACTOR, requestId: REQUEST_ID });
    expect(result.status).toBe("success"); expect(result.data?.bytes).toEqual(bytes); expect(result.data?.metadata.content_sha256).toBe(digest);

    const expiredFetch: typeof fetch = () => Promise.resolve(new Response(JSON.stringify(envelope("quote-document-create@2026-09-05.v2", "manual_review", { ...metadata, valid_now: false }, [ref], ["quote_document_expired"])), { status: 200 }));
    await expect(client(expiredFetch, signer()).getDocument({ documentRef: "document_abcdefghijklmnop", actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({ status: "manual_review", data: { formal: true, valid_now: false, historical_snapshot: true }, reason_codes: ["quote_document_expired"] });

    const corruptFetch = vi.fn(() => corruptFetch.mock.calls.length === 1
      ? Promise.resolve(new Response(JSON.stringify(envelope("quote-document-create@2026-09-05.v2", "success", metadata, [ref], [])), { status: 200 }))
      : Promise.resolve(new Response(new TextEncoder().encode("%PDF-corrupt"), { status: 200, headers: { "content-type": "application/pdf" } })));
    await expect(client(corruptFetch, signer()).downloadDocument({ documentRef: "document_abcdefghijklmnop", actor: ACTOR, requestId: REQUEST_ID })).resolves.toMatchObject({ status: "unavailable", data: null, reason_codes: ["quote_document_download_invalid"] });
  });

  it("retains the human resolution and its recalculation provenance when reading a quoted record", async () => {
    const quoted = { record_ref: "record_abcdefghijklmnop", record_version: 2, record_status: "quoted", review_task_ref: "task_abcdefghijklmnop", currency: "USD", saved: true, sendable: false, quote_ready: true, pdf_available: false, bookable: false, total_price_usd: "245.50", review_evidence: evidence, charge_lines: chargeLines, customer_terms: resolution.customer_terms, service_conditions: zoneRequest, source_snapshot_hash: HASH, readback_verified: true, created_at: "2026-09-05T00:00:00Z", request: zoneRequest, preview, resolution, source_refs: [sourceRef] };
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(JSON.stringify(envelope("quote-record-write@2026-09-05.v1", "success", quoted, [sourceRef], [])), { status: 200 }));
    const result = await client(fetchImpl, signer()).get({ recordRef: "record_abcdefghijklmnop", actor: ACTOR, requestId: REQUEST_ID });
    expect(result.data).toMatchObject({ record_status: "quoted", total_price_usd: "245.50", review_evidence: evidence, resolution: { reviewer_actor_id: "fixture-owner", recalculation: { source_refs: [sourceRef] } } });
  });
});
