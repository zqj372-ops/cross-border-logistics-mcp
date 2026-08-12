import { describe, expect, it, vi } from "vitest";

import {
  ExistingQuoteAdapter,
  type QuoteLookupRecord,
  type QuoteUpstreamSource,
} from "../../src/logistics_mcp/adapters/quote/existing-quote-adapter";

const sourceRef = {
  source_id: "src:quote:fixture:1",
  source_type: "fixture" as const,
  system: "existing-quote-system",
  locator: "fixture://existing-quote/quote-demo-001",
  version: "zone-price-fixture@1",
  retrieved_at: "2026-08-11T00:00:00Z",
  authority: "authoritative" as const,
  content_hash: "sha256:quote-fixture-1",
};

function lookupRecord(
  overrides: Partial<QuoteLookupRecord> = {},
): QuoteLookupRecord {
  return {
    status: "matched",
    quote_id: "quote-demo-001",
    zone: 2,
    base_price: { amount: "123.45", currency: "USD" },
    fuel_percent: "10",
    accessorials: {
      residential_fee: { amount: "25.00", currency: "USD" },
      liftgate_fee: { amount: "15.00", currency: "USD" },
      appointment_fee: { amount: "8.00", currency: "USD" },
    },
    rule_version: "zone-rule-fixture@1",
    data_version: "zone-price-fixture@1",
    valid_from: "2026-08-01",
    valid_to: "2026-08-31",
    matched_by: "postal_fsa_exact",
    source_ref: sourceRef,
    ...overrides,
  };
}

function calculateInput(addressType = "commercial") {
  return {
    schema_version: "2026-08-11.v1",
    version: "quote-request@fixture-1",
    origin: { warehouse_code: "fixture-warehouse", province: "ON" },
    destination: {
      country: "CA",
      province: "ON",
      city: "Fixture City",
      postal_code: "A0A 0A0",
      address_type: addressType,
      full_address_ref: null,
    },
    cargo: {
      cargo_result_ref: null,
      billing_pallets: 2,
      weight_kg: { value: "100", unit: "kg" },
      pieces: 2,
      package_types: ["pallet"],
    },
    services: {
      appointment: true,
      liftgate: false,
      limited_access: false,
      remote_area: false,
    },
    effective_at: "2026-08-11",
  };
}

function createSource(record: QuoteLookupRecord): {
  source: QuoteUpstreamSource;
  lookup: ReturnType<typeof vi.fn>;
  saveDraft: ReturnType<typeof vi.fn>;
  readDraft: ReturnType<typeof vi.fn>;
} {
  const saveDraft = vi.fn(() => Promise.resolve({
    record_id: "sales-quote-demo-001",
    tenant_id: "tenant_demo",
    quote_id: "quote-demo-001",
    revision: "sales-quote-record@1",
    source_ref: {
      ...sourceRef,
      source_id: "src:quote:write:fixture",
      version: "quote-draft-write@1",
      locator: "fixture://existing-quote/sales-quote-demo-001",
    },
  }));
  const readDraft = vi.fn(() => Promise.resolve({
    record_id: "sales-quote-demo-001",
    tenant_id: "tenant_demo",
    quote_id: "quote-demo-001",
    revision: "sales-quote-record@1",
    status: "draft" as const,
    source_ref: {
      ...sourceRef,
      source_id: "src:quote:readback:fixture",
      locator: "fixture://existing-quote/sales-quote-demo-001",
      version: "sales-quote-record@1",
    },
  }));
  const lookup = vi.fn(() => Promise.resolve(record));
  return {
    source: {
      lookup,
      saveDraft,
      readDraft,
    },
    lookup,
    saveDraft,
    readDraft,
  };
}

describe("existing quote adapter", () => {
  it("prioritizes the disabled production boundary over missing address input", async () => {
    const result = await new ExistingQuoteAdapter().calculate(calculateInput("unknown"));

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map((item) => item.code)).toContain("quote.adapter_disabled");
  });

  it("calculates a versioned quote from the exact Zone and price row", async () => {
    const { source } = createSource(lookupRecord());
    const adapter = new ExistingQuoteAdapter({ source });

    const result = await adapter.calculate(calculateInput());

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      quote_status: "calculated",
      rule_version: "zone-rule-fixture@1",
      data_version: "zone-price-fixture@1",
      sendable: false,
      total: { amount: "143.80", currency: "USD" },
    });
    expect(result.sourceRefs).toContainEqual(sourceRef);
    expect(result.calculationTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "calculate fuel" }),
        expect.objectContaining({ operation: "sum quote line items" }),
      ]),
    );
  });

  it.each([
    ["zone_conflict", "quote.zone_conflict"],
    ["zone_missing", "quote.zone_missing"],
    ["price_missing", "quote.price_missing"],
  ] as const)("fails closed for %s without a total", async (status, blocker) => {
    const { source } = createSource(lookupRecord({ status, zone: null, base_price: null }));
    const adapter = new ExistingQuoteAdapter({ source });

    const result = await adapter.calculate(calculateInput());

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({
      quote_status: "manual_review",
      total: null,
      sendable: false,
    });
    expect(result.blockers?.map((item) => item.code)).toContain(blocker);
  });

  it("returns needs_input when address type is missing or unknown", async () => {
    const { source, lookup } = createSource(lookupRecord());
    const adapter = new ExistingQuoteAdapter({ source });

    const result = await adapter.calculate(calculateInput("unknown"));

    expect(result.status).toBe("needs_input");
    expect(result.data).toBeNull();
    expect(result.blockers?.[0]?.field).toBe("destination.address_type");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not use a map, portal, or public-catalog fallback", async () => {
    const { source } = createSource(lookupRecord());
    const fallback = vi.fn();
    const adapter = new ExistingQuoteAdapter({
      source,
      fallback: fallback as never,
    });

    await adapter.calculate(calculateInput());

    expect(fallback).not.toHaveBeenCalled();
  });

  it("rejects an expired rule instead of reusing an old price", async () => {
    const { source } = createSource(
      lookupRecord({ valid_to: "2026-08-10" }),
    );
    const adapter = new ExistingQuoteAdapter({ source });

    const result = await adapter.calculate(calculateInput());

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({ quote_status: "manual_review", total: null });
    expect(result.blockers?.map((item) => item.code)).toContain("quote.rule_expired");
  });
});

describe("quote draft lifecycle", () => {
  function quoteResult() {
    return {
      version: "quote-result@fixture-1",
      quote_id: "quote-demo-001",
      quote_status: "calculated",
      currency: "USD",
      total: { amount: "143.80", currency: "USD" },
      line_items: [],
      rule_version: "zone-rule-fixture@1",
      data_version: "zone-price-fixture@1",
      sendable: false,
      valid_from: "2026-08-01T00:00:00Z",
      valid_to: "2026-08-31T23:59:59Z",
      source_ref_ids: ["src:quote:fixture:1"],
    };
  }

  function writeContext(
    operationMode: "preview" | "commit",
    previewRef: string | null,
    key = "idem_demo_quote_12345678",
  ) {
    return {
      tenant_context: {
        tenant_id: "tenant_demo",
        actor_id: "actor_sales",
        actor_role: "sales",
        client_id: "client_demo",
        session_id: "session_demo",
      },
      idempotency_key: key,
      operation_mode: operationMode,
      preview_ref: previewRef,
      approval: { required: false, status: "not_required", approval_id: null },
    };
  }

  it("previews without calling the upstream draft write boundary", async () => {
    const { source, saveDraft, readDraft } = createSource(lookupRecord());
    const adapter = new ExistingQuoteAdapter({ source });

    const result = await adapter.previewDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("preview", null),
    });

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      operation: "quote.save_draft",
      operation_status: "previewed",
      record_id: null,
      readback_evidence: null,
    });
    expect(saveDraft).not.toHaveBeenCalled();
    expect(readDraft).not.toHaveBeenCalled();
  });

  it("does not create a local preview when the production write source is absent", async () => {
    const result = await new ExistingQuoteAdapter().previewDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("preview", null),
    });

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map((item) => item.code)).toContain("quote.adapter_disabled");
    expect(result.data).toMatchObject({ operation_status: "rejected" });
    expect(result.data).not.toMatchObject({ operation_status: "previewed" });
  });

  it("commits once, reads back the same tenant/quote/revision, and replays idempotently", async () => {
    const { source, saveDraft, readDraft } = createSource(lookupRecord());
    const adapter = new ExistingQuoteAdapter({ source });
    const preview = await adapter.previewDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("preview", null),
    });
    const previewRef = String(preview.data && preview.data.preview_ref);
    const commitInput = {
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("commit", previewRef),
    };

    const first = await adapter.commitDraft(commitInput);
    const replay = await adapter.commitDraft(commitInput);

    expect(first.status).toBe("success");
    expect(first.data).toMatchObject({
      operation_status: "committed",
      preview_ref: previewRef,
      readback_evidence: { verified: true, record_id: "sales-quote-demo-001" },
    });
    expect(replay.data).toMatchObject({ operation_status: "already_committed" });
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: "idem_demo_quote_12345678" }),
      expect.any(AbortSignal),
    );
    expect(readDraft).toHaveBeenCalledTimes(1);
  });

  it("returns a conflict instead of writing when a preview is reused for another payload", async () => {
    const { source, saveDraft } = createSource(lookupRecord());
    const adapter = new ExistingQuoteAdapter({ source });
    const preview = await adapter.previewDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("preview", null),
    });
    const previewRef = String(preview.data && preview.data.preview_ref);

    const result = await adapter.commitDraft({
      quote_result: { ...quoteResult(), total: { amount: "999.00", currency: "USD" } },
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("commit", previewRef, "idem_demo_quote_87654321"),
    });

    expect(result.status).toBe("manual_review");
    expect(result.blockers?.map((item) => item.code)).toContain("quote.preview_hash_mismatch");
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("requires approval before committing a draft", async () => {
    const { source, saveDraft } = createSource(lookupRecord());
    const adapter = new ExistingQuoteAdapter({ source });
    const preview = await adapter.previewDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("preview", null),
    });
    const result = await adapter.commitDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: {
        ...writeContext("commit", String(preview.data && preview.data.preview_ref)),
        approval: { required: true, status: "pending", approval_id: null },
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.blockers?.map((item) => item.code)).toContain("quote.approval_required");
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("does not cross the upstream write boundary after cancellation", async () => {
    const { source, saveDraft } = createSource(lookupRecord());
    const adapter = new ExistingQuoteAdapter({ source });
    const preview = await adapter.previewDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("preview", null),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.commitDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("commit", String(preview.data && preview.data.preview_ref)),
    }, controller.signal)).rejects.toThrow();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("does not report success when readback is missing or mismatched", async () => {
    const { source, readDraft } = createSource(lookupRecord());
    readDraft.mockResolvedValueOnce(null);
    const adapter = new ExistingQuoteAdapter({ source });
    const preview = await adapter.previewDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("preview", null),
    });

    const result = await adapter.commitDraft({
      quote_result: quoteResult(),
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: writeContext("commit", String(preview.data && preview.data.preview_ref)),
    });

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({ operation_status: "rejected", readback_evidence: null });
    expect(result.blockers?.map((item) => item.code)).toContain("quote.readback_missing");
  });
});
