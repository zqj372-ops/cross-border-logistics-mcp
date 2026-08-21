import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeQuotePdfAuthorityBody,
  createQuotePdf,
  quoteCreatePdfInputSchema,
  quoteCreatePdfWriteResultSchema,
  type QuotePdfPort,
} from "../../src/logistics_mcp/domains/quote/create-pdf";
import { quoteV2ResultSchema } from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import type { QuoteAdapter } from "../../src/logistics_mcp/adapters/ports";
import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";
import type { AdapterResult } from "../../src/logistics_mcp/adapters/ports";
import type { QuotePdfMetadata } from "../../src/logistics_mcp/adapters/pdf/quote-pdf-api-adapter";
import { hashPayload } from "../../src/logistics_mcp/platform/idempotency";
import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import { createPhase1Bundle, phase1ToolNames } from "../../src/logistics_mcp/adapters/phase1-bundle";

const context: ExecutionContext = {
  tenantId: "tenant_pdf_fixture",
  actorId: "actor_sales",
  role: "sales",
  roles: ["sales"],
  scopes: ["quote:pdf_write"],
  clientId: "client_fixture",
  sessionId: "session_fixture",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const snapshot = "a".repeat(64);
const sourceId = `src:quote:snapshot:${snapshot}`;

function quoteRequest(): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "quote-request@2026-08-13.v2",
    origin: { warehouse_code: "fixture-warehouse", province: "ON" },
    destination: {
      country: "CA",
      province: "ON",
      city: "Fixture City",
      postal_code: "A0A 0A0",
      address_type: "commercial",
      full_address_ref: null,
    },
    cargo: {
      cargo_result_ref: null,
      explicit_pallet_count: 2,
      longest_side: { value: "1.20", unit: "m" },
      is_stackable: false,
      weight_kg: { value: "100", unit: "kg" },
      pieces: 2,
      package_types: ["pallet"],
      total_volume: { value: "1.25", unit: "cbm" },
    },
    services: {
      appointment: true,
      liftgate: false,
      pallet_jack: true,
      detention_minutes: 15,
      limited_access: false,
      remote_area: false,
    },
    effective_at: "2026-08-14",
  };
}

function input(operationMode: "preview" | "commit", key: string, previewRef: string | null = null) {
  return {
    schema_version: "2026-08-11.v1",
    version: "quote-create-pdf-request@2026-08-14.v1",
    quote_request: quoteRequest(),
    presentation: { customer_display_name: "Customer output must stay opaque" },
    write_context: {
      idempotency_key: key,
      operation_mode: operationMode,
      preview_ref: previewRef,
      approval: operationMode === "preview"
        ? { required: false, status: "not_required", approval_id: null }
        : { required: true, status: "approved", approval_id: "approval:fixture:1" },
    },
  };
}

function quoteData(overrides: Record<string, unknown> = {}) {
  return quoteV2ResultSchema.parse({
    version: "quote-result@2026-08-13.v2",
    quote_id: "quote:pdf:001",
    quote_status: "calculated",
    currency: "USD",
    total: { amount: "9007199254740993.00", currency: "USD" },
    line_items: [{
      line_id: "line-1",
      label: "authoritative line",
      amount: { amount: "9007199254740993.00", currency: "USD" },
      pricing_basis: "fixture",
      source_ref_ids: [sourceId],
    }],
    rule_version: "rules-1",
    data_version: "data-1",
    sendable: false,
    valid_from: "2026-08-14",
    valid_to: "2026-08-31",
    source_ref_ids: [sourceId],
    tenant: context.tenantId,
    effective_date: "2026-08-14",
    ready: true,
    test_data: false,
    origin: "toronto",
    billing_pallets: 2,
    snapshot_hash: `sha256:${snapshot}`,
    service_version: "quote-service@fixture-1",
    contract_version: "quote-zone.v2",
    release_id: "release-1",
    release_hash: `sha256:${snapshot}`,
    published_at: "2026-08-14T00:00:00Z",
    ...overrides,
  });
}

function quoteDataForSource(nextSourceId: string, nextSnapshot: string) {
  const base = quoteData();
  return quoteData({
    source_ref_ids: [nextSourceId],
    snapshot_hash: `sha256:${nextSnapshot}`,
    release_hash: `sha256:${nextSnapshot}`,
    line_items: base.line_items.map((line) => ({ ...line, source_ref_ids: [nextSourceId] })),
  });
}

const sourceRef = {
  source_id: sourceId,
  source_type: "internal_system" as const,
  system: "ai-quote-zone-preview",
  locator: "/private/customer/path",
  version: "release-1:rules-1:data-1",
  retrieved_at: "2026-08-14T00:00:00Z",
  authority: "authoritative" as const,
  content_hash: `sha256:${"d".repeat(64)}`,
};
const quoteTrace = {
  step_id: "step:quote:preview:upstream",
  operation: "use upstream quote preview result",
  inputs: [{ name: "total", value: { amount: "9007199254740993.00", currency: "USD" } }],
  result: { amount: "9007199254740993.00", currency: "USD" },
  source_ref_ids: [sourceId],
  rounding: null,
};

const upstreamCanonicalFixture = {
  version: 2,
  kind: "quote",
  sendable: false,
  quote_id: "quote-001",
  quote_version: "release-2026-08-13:zone-rules-2026-08-13:release:rule:data",
  release_id: "release-2026-08-13",
  rule_version: "zone-rules-2026-08-13",
  data_version: "release:rule:data",
  effective_date: "2026-08-13",
  snapshot_hash: `sha256:${"a".repeat(64)}`,
  release_hash: `sha256:${"a".repeat(64)}`,
  data: {
    currency: "USD",
    total: { amount: "9007199254740994.000", currency: "USD" },
    line_items: [
      { line_id: "line-1", label: "six", amount: { amount: "6.00", currency: "USD" }, pricing_basis: "fixture", source_ref_ids: ["src:fixture"] },
      { line_id: "line-2", label: "precise", amount: { amount: "0.005", currency: "USD" }, pricing_basis: "fixture", source_ref_ids: ["src:fixture"] },
      { line_id: "line-3", label: "zero", amount: { amount: "0.000", currency: "USD" }, pricing_basis: "fixture", source_ref_ids: ["src:fixture"] },
      { line_id: "line-4", label: "large", amount: { amount: "9007199254740987.995", currency: "USD" }, pricing_basis: "fixture", source_ref_ids: ["src:fixture"] },
    ],
    presentation: { customer_display_name: "Fixture customer" },
  },
};

type MockQuoteAdapter = QuoteAdapter & {
  calculateMock: ReturnType<typeof vi.fn<QuoteAdapter["calculate"]>>;
};

function quoteAdapter(results: Array<AdapterResult>): MockQuoteAdapter {
  const calculate = vi.fn<QuoteAdapter["calculate"]>(() => Promise.resolve(results.shift() ?? {
      status: "unavailable",
      data: null,
      sourceRefs: [],
      blockers: [{ code: "quote.fixture_exhausted", message: "fixture exhausted", severity: "error" as const }],
    } satisfies AdapterResult));
  return {
    calculate,
    calculateMock: calculate,
    previewDraft: vi.fn(),
    commitDraft: vi.fn(),
    readDraft: vi.fn(),
  };
}

type MockPdfPort = QuotePdfPort & {
  postMock: ReturnType<typeof vi.fn<QuotePdfPort["post"]>>;
  getMock: ReturnType<typeof vi.fn<QuotePdfPort["get"]>>;
};
type PdfOverrides = Partial<{
  post: ReturnType<typeof vi.fn<QuotePdfPort["post"]>>;
  get: ReturnType<typeof vi.fn<QuotePdfPort["get"]>>;
}>;

function pdfPort(options: PdfOverrides = {}): MockPdfPort {
  let latestMetadata: QuotePdfMetadata = {
    document_ref: "01234567-89ab-cdef-0123-456789abcdef.pdf",
    sha256: "b".repeat(64),
    byte_length: 128,
    renderer_version: "renderer-8",
    template_version: "template-1",
    status: "ready" as const,
    sendable: false as const,
    quote_id: "quote:pdf:001",
    quote_version: "release-1:rules-1:data-1",
    release_id: "release-1",
    rule_version: "rules-1",
    data_version: "data-1",
    effective_date: "2026-08-14",
    snapshot_hash: `sha256:${snapshot}`,
    release_hash: `sha256:${snapshot}`,
    input_sha256: "c".repeat(64),
  };
  const defaultPost = vi.fn<QuotePdfPort["post"]>((body) => {
    latestMetadata = { ...latestMetadata, input_sha256: hashPayload(canonicalizeQuotePdfAuthorityBody(body)).slice("sha256:".length) };
    return Promise.resolve({
      ok: true as const,
      status: 201 as const,
      metadata: latestMetadata,
    });
  });
  const defaultGet = vi.fn<QuotePdfPort["get"]>(() => Promise.resolve({
      ok: true as const,
      metadata: latestMetadata,
    }));
  const post = options.post ?? defaultPost;
  const get = options.get ?? defaultGet;
  return { post, get, postMock: post, getMock: get };
}

describe("quote.create_pdf domain", () => {
  it("keeps the public input strict and lifecycle-bound", () => {
    const valid = input("preview", "preview-key-123456");
    expect(quoteCreatePdfInputSchema.safeParse(valid).success).toBe(true);
    for (const field of ["total", "line_items", "logo", "path", "html", "url", "tenant", "actor"]) {
      expect(quoteCreatePdfInputSchema.safeParse({ ...valid, [field]: "forbidden" }).success).toBe(false);
    }
    expect(quoteCreatePdfInputSchema.safeParse({
      ...valid,
      presentation: { customer_display_name: "   " },
    }).success).toBe(false);
    expect(quoteCreatePdfInputSchema.safeParse({
      ...valid,
      presentation: { customer_display_name: "https://example.invalid/customer" },
    }).success).toBe(false);
    expect(quoteCreatePdfInputSchema.safeParse({
      ...valid,
      write_context: { ...valid.write_context, preview_ref: "preview:existing:1", approval: { required: false, status: "not_required", approval_id: null } },
    }).success).toBe(false);
    expect(quoteCreatePdfInputSchema.safeParse({
      ...input("commit", "commit-key-123456"),
      write_context: { ...input("commit", "commit-key-123456").write_context, preview_ref: null },
    }).success).toBe(false);
    expect(quoteCreatePdfInputSchema.safeParse({
      ...input("commit", "commit-key-123456"),
      write_context: {
        ...input("commit", "commit-key-123456").write_context,
        approval: { required: true, status: "pending", approval_id: "approval:fixture:1" },
      },
    }).success).toBe(false);
    const whitespaceKey = " ".repeat(16);
    expect(quoteCreatePdfInputSchema.safeParse(input("preview", whitespaceKey)).success).toBe(false);
    expect(quoteCreatePdfInputSchema.safeParse(input("commit", whitespaceKey, "preview:valid:1")).success).toBe(false);
  });

  it("uses the upstream decimal canonicalization and stable hash without Number", () => {
    const canonical = canonicalizeQuotePdfAuthorityBody(upstreamCanonicalFixture);
    const data = canonical.data as Record<string, unknown>;
    const total = data.total as Record<string, unknown>;
    const lines = data.line_items as Array<Record<string, unknown>>;
    expect(total.amount).toBe("9007199254740994");
    expect(lines.map((line) => (line.amount as Record<string, unknown>).amount)).toEqual([
      "6",
      "0.005",
      "0",
      "9007199254740987.995",
    ]);
    expect(hashPayload(canonical)).toBe("sha256:c698ce124c58532c47f6c3dee1bfb02154065a236c3a9162229829159693ea9f");
  });

  it("previews with one Quote call, zero PDF calls, stable opaque ref, and no PDF evidence or amount", async () => {
    const quote = quoteAdapter([{
      status: "success",
      data: quoteData(),
      sourceRefs: [sourceRef],
      calculationTrace: [quoteTrace],
      warnings: [{ code: "quote.fixture_warning", message: "customer secret amount 9007199254740993.00", severity: "warning" }],
    }]);
    const pdf = pdfPort();

    const result = await createQuotePdf(quote, pdf, input("preview", "preview-key-123456"), context);
    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      operation: "quote.create_pdf",
      operation_status: "previewed",
      record_id: null,
      readback_evidence: null,
      approval: { required: false, status: "not_required", approval_id: null },
    });
    expect(result.data).toHaveProperty("preview_ref");
    const previewRef = result.data?.preview_ref as string;
    const previewParts = previewRef.split(":");
    expect(previewRef.length).toBeLessThanOrEqual(128);
    expect(Buffer.from(previewParts[2] ?? "", "base64url")).toHaveLength(32);
    expect(Buffer.from(previewParts[3] ?? "", "base64url")).toHaveLength(32);
    expect(JSON.stringify(result)).not.toContain("9007199254740993.00");
    expect(JSON.stringify(result)).not.toContain("/private/customer/path");
    expect(JSON.stringify(result)).not.toContain("customer secret");
    expect(JSON.stringify({ sourceRefs: result.sourceRefs, calculationTrace: result.calculationTrace }).toLowerCase()).not.toMatch(/pdf|readback|document/);
    expect(result.sourceRefs.map((ref) => ref.source_id)).toEqual([sourceId]);
    expect(result.calculationTrace?.every((step) => step.source_ref_ids.every((id) => id === sourceId))).toBe(true);
    expect(quote.calculateMock).toHaveBeenCalledTimes(1);
    expect(pdf.postMock).not.toHaveBeenCalled();
    expect(pdf.getMock).not.toHaveBeenCalled();
    quote.calculateMock.mockResolvedValueOnce({
      status: "success",
      data: quoteData(),
      sourceRefs: [sourceRef],
      calculationTrace: [quoteTrace],
    });
    const replay = await createQuotePdf(quote, pdf, input("preview", "preview-key-123456"), context);
    expect(replay.data).toMatchObject({ preview_ref: result.data?.preview_ref });
    quoteCreatePdfWriteResultSchema.parse(result.data);
  });

  it("keeps the preview identity stable when only source observation time changes", async () => {
    const firstRetrievedAt = "2026-08-14T00:00:00Z";
    const secondRetrievedAt = "2026-08-14T00:00:01Z";
    const quote = quoteAdapter([
      { status: "success", data: quoteData(), sourceRefs: [{ ...sourceRef, retrieved_at: firstRetrievedAt }], calculationTrace: [quoteTrace] },
      { status: "success", data: quoteData(), sourceRefs: [{ ...sourceRef, retrieved_at: secondRetrievedAt }], calculationTrace: [quoteTrace] },
    ]);
    const pdf = pdfPort();

    const first = await createQuotePdf(quote, pdf, input("preview", "preview-key-123456"), context);
    const replay = await createQuotePdf(quote, pdf, input("preview", "preview-key-123456"), context);

    expect(replay.data).toMatchObject({ preview_ref: first.data?.preview_ref });
    expect(first.sourceRefs[0]?.retrieved_at).toBe(firstRetrievedAt);
    expect(replay.sourceRefs[0]?.retrieved_at).toBe(secondRetrievedAt);
    expect(pdf.postMock).not.toHaveBeenCalled();
  });

  it("allows commit when only source observation time changes and preserves the commit evidence", async () => {
    const firstRetrievedAt = "2026-08-14T00:00:00Z";
    const secondRetrievedAt = "2026-08-14T00:00:01Z";
    const quote = quoteAdapter([
      { status: "success", data: quoteData(), sourceRefs: [{ ...sourceRef, retrieved_at: firstRetrievedAt }], calculationTrace: [quoteTrace] },
      { status: "success", data: quoteData(), sourceRefs: [{ ...sourceRef, retrieved_at: secondRetrievedAt }], calculationTrace: [quoteTrace] },
    ]);
    const pdf = pdfPort();
    const preview = await createQuotePdf(quote, pdf, input("preview", "preview-key-123456"), context);
    const committed = await createQuotePdf(
      quote,
      pdf,
      input("commit", "commit-key-123456", (preview.data as Record<string, unknown>).preview_ref as string),
      context,
    );

    expect(committed.status).toBe("success");
    expect(committed.sourceRefs.find((ref) => ref.source_id === sourceId)?.retrieved_at).toBe(secondRetrievedAt);
    expect(pdf.postMock).toHaveBeenCalledTimes(1);
  });

  it("reviews any stable quote evidence or trace change before PDF write", async () => {
    const changedSnapshot = "b".repeat(64);
    const changedSourceId = `src:quote:snapshot:${changedSnapshot}`;
    const cases = [
      {
        name: "version",
        source: { ...sourceRef, version: "release-2:rules-1:data-1" },
        data: quoteData(),
        trace: quoteTrace,
      },
      {
        name: "content_hash",
        source: { ...sourceRef, content_hash: `sha256:${"e".repeat(64)}` },
        data: quoteData(),
        trace: quoteTrace,
      },
      {
        name: "locator",
        source: { ...sourceRef, locator: "opaque://quote-authority-v2" },
        data: quoteData(),
        trace: quoteTrace,
      },
      {
        name: "source_id",
        source: { ...sourceRef, source_id: changedSourceId },
        data: quoteDataForSource(changedSourceId, changedSnapshot),
        trace: { ...quoteTrace, source_ref_ids: [changedSourceId] },
      },
      {
        name: "trace",
        source: sourceRef,
        data: quoteData(),
        trace: { ...quoteTrace, operation: "changed quote evidence" },
      },
    ];

    for (const testCase of cases) {
      const quote = quoteAdapter([
        { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
        { status: "success", data: testCase.data, sourceRefs: [testCase.source], calculationTrace: [testCase.trace] },
      ]);
      const pdf = pdfPort();
      const preview = await createQuotePdf(quote, pdf, input("preview", "preview-key-123456"), context);
      const result = await createQuotePdf(
        quote,
        pdf,
        input("commit", "commit-key-123456", (preview.data as Record<string, unknown>).preview_ref as string),
        context,
      );

      expect(result, testCase.name).toMatchObject({ status: "manual_review", data: null });
      expect(pdf.postMock, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("requires non-empty quote calculation trace for preview and commit", async () => {
    const previewPdf = pdfPort();
    const unavailablePreview = await createQuotePdf(quoteAdapter([{
      status: "success",
      data: quoteData(),
      sourceRefs: [sourceRef],
      calculationTrace: [],
    }]), previewPdf, input("preview", "preview-key-123456"), context);
    expect(unavailablePreview).toMatchObject({ status: "unavailable", data: null });
    expect(previewPdf.postMock).not.toHaveBeenCalled();

    const commitPdf = pdfPort();
    const quote = quoteAdapter([
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [] },
    ]);
    const preview = await createQuotePdf(quote, commitPdf, input("preview", "preview-key-123456"), context);
    const unavailableCommit = await createQuotePdf(
      quote,
      commitPdf,
      input("commit", "commit-key-123456", (preview.data as Record<string, unknown>).preview_ref as string),
      context,
    );
    expect(unavailableCommit).toMatchObject({ status: "unavailable", data: null });
    expect(commitPdf.postMock).not.toHaveBeenCalled();
  });

  it("requires P != C, requotes on commit, projects exact decimal strings, and reads back before success", async () => {
    const quote = quoteAdapter([
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
    ]);
    const pdf = pdfPort();
    const preview = await createQuotePdf(quote, pdf, input("preview", "preview-key-123456"), context);
    const previewRef = (preview.data as Record<string, unknown>).preview_ref as string;

    const sameKey = await createQuotePdf(quote, pdf, input("commit", "preview-key-123456", previewRef), context);
    expect(sameKey.status).toBe("needs_input");
    expect(pdf.postMock).not.toHaveBeenCalled();

    const committed = await createQuotePdf(quote, pdf, input("commit", "commit-key-123456", previewRef), context);
    expect(committed.status).toBe("success");
    expect(committed.data).toMatchObject({
      operation_status: "committed",
      record_id: "01234567-89ab-cdef-0123-456789abcdef.pdf",
      readback_evidence: { verified: true },
      approval: { required: true, status: "approved", approval_id: "approval:fixture:1" },
    });
    expect(pdf.postMock).toHaveBeenCalledTimes(1);
    const postedCall = pdf.postMock.mock.calls[0];
    const postedBody = postedCall?.[0];
    expect(postedBody).toMatchObject({
      version: 2,
      kind: "quote",
      sendable: false,
      quote_id: "quote:pdf:001",
      quote_version: "release-1:rules-1:data-1",
      data: { total: { amount: "9007199254740993", currency: "USD" } },
    });
    expect(postedCall?.[1]).toBe("commit-key-123456");
    expect(postedCall?.[2]).toBe(context);
    expect(JSON.stringify(committed)).not.toContain("9007199254740993.00");
    expect(committed.sourceRefs.map((ref) => ref.source_id)).toEqual(expect.arrayContaining([
      sourceId,
      expect.stringMatching(/^src:quote:pdf:readback:/u),
    ]));
    expect(committed.calculationTrace?.every((step) => step.source_ref_ids.every((id) =>
      committed.sourceRefs.some((ref) => ref.source_id === id)))).toBe(true);
    quoteCreatePdfWriteResultSchema.parse(committed.data);
  });

  it("rejects unsafe PDF projection text, duplicate sources, unknown trace sources, and overlong PDF identity", async () => {
    const oversizedLines = Array.from({ length: 501 }, (_, index) => ({
      line_id: `line-${index}`,
      label: "line",
      amount: { amount: "1.00", currency: "USD" },
      pricing_basis: "fixture",
      source_ref_ids: [sourceId],
    }));
    const unsafeQuotes = [
      quoteData({ line_items: [{ ...quoteData().line_items[0], label: "https://example.invalid" }] }),
      quoteData({ line_items: [{ ...quoteData().line_items[0], pricing_basis: "/absolute/path" }] }),
      quoteData({ line_items: [{ ...quoteData().line_items[0], label: "<b>line</b>" }] }),
      quoteData({ line_items: [{ ...quoteData().line_items[0], pricing_basis: "   " }] }),
      quoteData({ line_items: oversizedLines, total: { amount: "501.00", currency: "USD" } }),
      quoteData({ release_id: "r".repeat(64), rule_version: "s".repeat(64), data_version: "d" }),
    ];
    for (const data of unsafeQuotes) {
      const pdf = pdfPort();
      const result = await createQuotePdf(quoteAdapter([{
        status: "success",
        data,
        sourceRefs: [sourceRef],
        calculationTrace: [quoteTrace],
      }]), pdf, input("preview", "preview-key-123456"), context);
      expect(result).toMatchObject({ status: "unavailable", data: null });
      expect(pdf.postMock).not.toHaveBeenCalled();
    }

    const duplicateLinePdf = pdfPort();
    const duplicateLineBase = quoteData();
    const duplicateLineData = {
      ...duplicateLineBase,
      total: { amount: "2.00", currency: "USD" },
      line_items: [
        { ...duplicateLineBase.line_items[0], line_id: "same-line", amount: { amount: "1.00", currency: "USD" } },
        { ...duplicateLineBase.line_items[0], line_id: "same-line", amount: { amount: "1.00", currency: "USD" } },
      ],
    };
    const duplicateLine = await createQuotePdf(quoteAdapter([{
      status: "success",
      data: duplicateLineData,
      sourceRefs: [sourceRef],
      calculationTrace: [quoteTrace],
    }]), duplicateLinePdf, input("preview", "preview-key-123456"), context);
    expect(duplicateLine).toMatchObject({ status: "unavailable", data: null });

    const duplicateLineSourcePdf = pdfPort();
    const duplicateLineSourceBase = quoteData();
    const duplicateLineSourceData = {
      ...duplicateLineSourceBase,
      line_items: [{ ...quoteData().line_items[0], source_ref_ids: [sourceId, sourceId] }],
    };
    const duplicateLineSource = await createQuotePdf(quoteAdapter([{
      status: "success",
      data: duplicateLineSourceData,
      sourceRefs: [sourceRef],
      calculationTrace: [quoteTrace],
    }]), duplicateLineSourcePdf, input("preview", "preview-key-123456"), context);
    expect(duplicateLineSource).toMatchObject({ status: "unavailable", data: null });

    const duplicateSourcePdf = pdfPort();
    const duplicateSource = await createQuotePdf(quoteAdapter([{
      status: "success",
      data: quoteData(),
      sourceRefs: [sourceRef, sourceRef],
      calculationTrace: [quoteTrace],
    }]), duplicateSourcePdf, input("preview", "preview-key-123456"), context);
    expect(duplicateSource).toMatchObject({ status: "unavailable", data: null });

    const unknownTracePdf = pdfPort();
    const unknownTrace = await createQuotePdf(quoteAdapter([{
      status: "success",
      data: quoteData(),
      sourceRefs: [sourceRef],
      calculationTrace: [{ ...quoteTrace, source_ref_ids: ["src:unknown"] }],
    }]), unknownTracePdf, input("preview", "preview-key-123456"), context);
    expect(unknownTrace).toMatchObject({ status: "unavailable", data: null });

    const extraSourcePdf = pdfPort();
    const extraSource = await createQuotePdf(quoteAdapter([{
      status: "success",
      data: quoteData(),
      sourceRefs: [sourceRef, { ...sourceRef, source_id: "src:quote:extra" }],
      calculationTrace: [quoteTrace],
    }]), extraSourcePdf, input("preview", "preview-key-123456"), context);
    expect(extraSource).toMatchObject({ status: "unavailable", data: null });
  });

  it("keeps drift, non-calculated quotes, and PDF failures fail-closed with zero PDF write", async () => {
    const driftingQuote = quoteAdapter([
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
      { status: "success", data: quoteData({ release_id: "release-2" }), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
    ]);
    const driftPdf = pdfPort();
    const preview = await createQuotePdf(driftingQuote, driftPdf, input("preview", "preview-key-123456"), context);
    const drift = await createQuotePdf(
      driftingQuote,
      driftPdf,
      input("commit", "commit-key-123456", (preview.data as Record<string, unknown>).preview_ref as string),
      context,
    );
    expect(drift).toMatchObject({ status: "manual_review", data: null });
    expect(driftPdf.postMock).not.toHaveBeenCalled();

    const manual = quoteAdapter([{
      status: "manual_review",
      data: null,
      sourceRefs: [sourceRef],
      blockers: [{ code: "quote.manual", message: "manual review", severity: "error" }],
    }]);
    const manualResult = await createQuotePdf(manual, pdfPort(), input("preview", "preview-key-123456"), context);
    expect(manualResult).toMatchObject({ status: "manual_review", data: null });

    const unavailablePdf = pdfPort({
      post: vi.fn(() => Promise.resolve({ ok: false as const, failure: { kind: "unavailable" as const, code: "pdf_503", dispatched: true, upstreamStatus: 503 } })),
    });
    const availableQuote = quoteAdapter([
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
    ]);
    const pdfPreview = await createQuotePdf(availableQuote, unavailablePdf, input("preview", "preview-key-123456"), context);
    const failedCommit = await createQuotePdf(
      availableQuote,
      unavailablePdf,
      input("commit", "commit-key-123456", (pdfPreview.data as Record<string, unknown>).preview_ref as string),
      context,
    );
    expect(failedCommit).toMatchObject({ status: "unavailable", data: null });
  });

  it("maps GET identity mismatch to manual_review and wires the phase-one handler", async () => {
    const mismatchedPdf = pdfPort({
      get: vi.fn(() => Promise.resolve({
        ok: true as const,
        metadata: {
          document_ref: "01234567-89ab-cdef-0123-456789abcdef.pdf",
          sha256: "e".repeat(64),
          byte_length: 128,
          renderer_version: "renderer-8",
          template_version: "template-1",
          status: "ready" as const,
          sendable: false as const,
          quote_id: "quote:pdf:001",
          quote_version: "release-1:rules-1:data-1",
          release_id: "release-1",
          rule_version: "rules-1",
          data_version: "data-1",
          effective_date: "2026-08-14",
          snapshot_hash: `sha256:${snapshot}`,
          release_hash: `sha256:${snapshot}`,
          input_sha256: "c".repeat(64),
        },
      })),
    });
    const quote = quoteAdapter([
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
    ]);
    const preview = await createQuotePdf(quote, mismatchedPdf, input("preview", "preview-key-123456"), context);
    const result = await createQuotePdf(
      quote,
      mismatchedPdf,
      input("commit", "commit-key-123456", (preview.data as Record<string, unknown>).preview_ref as string),
      context,
    );
    expect(result).toMatchObject({ status: "manual_review", data: null });
    expect(phase1ToolNames).toContain("quote.create_pdf");
  });

  it("uses injected quote and PDF ports through the phase-one bundle", async () => {
    const pdf = pdfPort();
    const quote = quoteAdapter([
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
      { status: "success", data: quoteData(), sourceRefs: [sourceRef], calculationTrace: [quoteTrace] },
    ]);
    const bundle = createPhase1Bundle({
      ...createFixtureAdapters(),
      quote,
      quotePdf: pdf,
    });
    const handler = bundle.handlers["quote.create_pdf"];
    const signal = new AbortController().signal;

    const preview = await handler(input("preview", "preview-key-123456"), context, signal);
    expect(preview.status).toBe("success");
    const previewRef = (preview.data as Record<string, unknown>).preview_ref as string;
    expect(pdf.postMock).not.toHaveBeenCalled();

    const committed = await handler(
      input("commit", "commit-key-123456", previewRef),
      context,
      signal,
    );
    expect(committed.status).toBe("success");
    expect(pdf.postMock).toHaveBeenCalledTimes(1);
    expect(pdf.getMock).toHaveBeenCalledTimes(1);
    expect(quote.calculateMock).toHaveBeenCalledTimes(2);
    expect(quote.calculateMock).toHaveBeenNthCalledWith(1, expect.anything(), context, signal);
    expect(pdf.postMock).toHaveBeenCalledWith(expect.anything(), "commit-key-123456", context, signal);
    expect(pdf.getMock).toHaveBeenCalledWith(expect.any(String), context, signal);
  });

  it("keeps the default bundle unavailable without a PDF source", async () => {
    const adapters = createFixtureAdapters();
    const pdfPost = vi.spyOn(adapters.quotePdf!, "post");
    const pdfGet = vi.spyOn(adapters.quotePdf!, "get");
    const bundle = createPhase1Bundle(adapters);

    const result = await bundle.handlers["quote.create_pdf"](
      input("preview", "preview-key-123456"),
      context,
    );

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(pdfPost).not.toHaveBeenCalled();
    expect(pdfGet).not.toHaveBeenCalled();
  });
});
