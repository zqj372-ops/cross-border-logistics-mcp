import { describe, expect, it, vi } from "vitest";

import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import { createPhase1Bundle } from "../../src/logistics_mcp/adapters/phase1-bundle";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client";
import {
  QuoteApiAdapter,
  type QuoteApiAdapterOptions,
} from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";

const BASE_URL = "https://quote.example.invalid/root";
const ALLOWED_HOSTS = ["quote.example.invalid"];
const SNAPSHOT_HEX = "a".repeat(64);
const SOURCE_ID = `src:quote:snapshot:${SNAPSHOT_HEX}`;

const context: ExecutionContext = {
  tenantId: "tenant_fixture",
  actorId: "actor_sales",
  role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate"],
  clientId: "client_fixture",
  sessionId: "session_fixture",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function quoteInput(): Record<string, unknown> {
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
    effective_at: "2026-08-12",
  };
}

function nested(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`missing test object ${key}`);
  }
  return value as Record<string, unknown>;
}

function withCargo(patch: Record<string, unknown>): Record<string, unknown> {
  const input = quoteInput();
  return { ...input, cargo: { ...nested(input, "cargo"), ...patch } };
}

function withServices(patch: Record<string, unknown>): Record<string, unknown> {
  const input = quoteInput();
  return { ...input, services: { ...nested(input, "services"), ...patch } };
}

function withOrigin(warehouseCode: string): Record<string, unknown> {
  const input = quoteInput();
  return {
    ...input,
    origin: { warehouse_code: warehouseCode, province: "ON" },
  };
}

function fee(amount: string): Record<string, unknown> {
  return { amount, currency: "USD" };
}

function upstreamResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "quote-result@2026-08-13.v2",
    quote_id: "preview:quote:api:001",
    quote_version: "release-20260812-a:zone-rules-20260728:zone-data-20260728",
    status: "quoted",
    source_type: "zone_matrix",
    origin: "toronto",
    zone: 2,
    billing_pallets: 2,
    fees: {
      base: fee("100.00"),
      fuel: fee("10.00"),
      appointment_fee: fee("5.00"),
      total: fee("115.00"),
    },
    test_data: false,
    manual_review_required: false,
    matched_by: "fsa_single_zone",
    rule_version: "zone-rules-20260728",
    data_version: "zone-data-20260728",
    valid_from: "2026-07-28",
    valid_to: "2026-12-31",
    source_ref: "zone_price_matrix",
    service_version: "quote-service@fixture-1",
    contract_version: "quote-zone.v2",
    release_id: "release-20260812-a",
    release_hash: `sha256:${SNAPSHOT_HEX}`,
    snapshot_hash: `sha256:${SNAPSHOT_HEX}`,
    published_at: "2026-08-12T10:00:00Z",
    reasons: [],
    quote_status: "calculated",
    currency: "USD",
    total: fee("115.00"),
    line_items: [
      {
        line_id: "zone_base",
        label: "Canada final-mile base price",
        amount: fee("100.00"),
        pricing_basis: "zone_price_matrix",
        source_ref_ids: [SOURCE_ID],
      },
      {
        line_id: "zone_fee_1",
        label: "fuel",
        amount: fee("10.00"),
        pricing_basis: "zone_pricing_config",
        source_ref_ids: [SOURCE_ID],
      },
      {
        line_id: "zone_fee_2",
        label: "appointment_fee",
        amount: fee("5.00"),
        pricing_basis: "zone_pricing_config",
        source_ref_ids: [SOURCE_ID],
      },
    ],
    source_ref_ids: [SOURCE_ID],
    sendable: false,
    tenant: context.tenantId,
    effective_date: "2026-08-12",
    ready: true,
    ...overrides,
  };
}

function manualResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return upstreamResponse({
    status: "manual_required",
    source_type: "manual_required",
    zone: null,
    billing_pallets: null,
    fees: {},
    manual_review_required: true,
    matched_by: "split_record_conflict",
    reasons: ["zone_conflict"],
    quote_status: "manual_review",
    total: null,
    line_items: [],
    ...overrides,
  });
}

function responseFetch(
  body: unknown,
  status = 200,
): ReturnType<typeof vi.fn<FetchImplementation>> {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

function adapter(
  fetchImpl: FetchImplementation,
  overrides: Partial<QuoteApiAdapterOptions> = {},
): QuoteApiAdapter {
  return new QuoteApiAdapter({
    baseUrl: BASE_URL,
    allowedHosts: ALLOWED_HOSTS,
    enabled: true,
    originByWarehouse: { "fixture-warehouse": "toronto" },
    headerProvider: () => ({ "X-API-Key": "synthetic-api-key" }),
    fetchImpl,
    clock: () => new Date("2026-08-12T12:00:00Z"),
    ...overrides,
  });
}

describe("quote API v2 adapter", () => {
  it("maps the formal preview request, server tenant, units, and one API-key call", async () => {
    let requestBody: unknown;
    let requestSignal: AbortSignal | null | undefined;
    const callerSignal = new AbortController().signal;
    const provider = vi.fn((_context: ExecutionContext, signal?: AbortSignal) => ({
      "X-API-Key": "synthetic-api-key",
      ...(signal === undefined ? {} : { "X-Signal-Present": "true" }),
    }));
    const fetchImpl = vi.fn<FetchImplementation>((_input, init) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      requestBody = JSON.parse(init.body) as unknown;
      requestSignal = init?.signal;
      return Promise.resolve(new Response(JSON.stringify(upstreamResponse())));
    });

    const result = await adapter(fetchImpl, { headerProvider: provider }).calculate(
      quoteInput(),
      context,
      callerSignal,
    );

    expect(result.status).toBe("success");
    expect(provider).toHaveBeenCalledWith(context, expect.any(AbortSignal));
    expect(requestBody).toEqual({
      tenant_id: context.tenantId,
      origin: "toronto",
      effective_date: "2026-08-12",
      quote: {
        postal_code: "A0A 0A0",
        city: "Fixture City",
        province: "ON",
        cbm: "1.25",
        weight_kg: "100",
        piece_count: 2,
        packaging_type: "pallet",
        longest_side_cm: "120",
        address_type: "commercial",
        requires_liftgate: false,
        requires_pallet_jack: true,
        requires_appointment: true,
        explicit_pallet_count: 2,
        is_stackable: false,
        detention_minutes: 15,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("x-api-key"))
      .toBe("synthetic-api-key");
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(provider.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain("synthetic-api-key");
  });

  it("does not call upstream for missing context, invalid v2 evidence, or an unmapped warehouse", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const cases: Array<[string, Record<string, unknown>, ExecutionContext | undefined]> = [
      ["context", quoteInput(), undefined],
      ["explicit pallet count", withCargo({ explicit_pallet_count: undefined }), context],
      ["zero volume", withCargo({ total_volume: { value: "0.000", unit: "cbm" } }), context],
      ["zero weight", withCargo({ weight_kg: { value: "0", unit: "kg" } }), context],
      ["zero longest side", withCargo({ longest_side: { value: "0", unit: "cm" } }), context],
      ["piece count maximum", withCargo({ pieces: 100001 }), context],
      ["pallet count maximum", withCargo({ explicit_pallet_count: 10001 }), context],
      ["detention maximum", withServices({ detention_minutes: 10081 }), context],
      ["wrong unit", withCargo({ weight_kg: { value: "100", unit: "lbm" } }), context],
      ["multiple package types", withCargo({ package_types: ["pallet", "carton"] }), context],
      ["client tenant field", { ...quoteInput(), tenant_id: "client-tenant" }, context],
      ["origin mapping", withOrigin("unknown-warehouse"), context],
    ];

    for (const [label, input, requestContext] of cases) {
      const result = await adapter(fetchImpl).calculate(input, requestContext);
      expect(result.status, label).not.toBe("success");
      expect(result.data, label).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["limited access", withServices({ limited_access: true })],
    ["remote area", withServices({ remote_area: true })],
  ])("returns zero-call manual review for %s", async (_label, input) => {
    const fetchImpl = vi.fn<FetchImplementation>();

    const result = await adapter(fetchImpl).calculate(input, context);

    expect(result.status).toBe("manual_review");
    expect(result.data).toBeNull();
    expect(result.sourceRefs).toEqual([]);
    expect(result.calculationTrace).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops a hanging credential provider on caller abort and deadline without fetching", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const provider = vi.fn((_context: ExecutionContext, signal?: AbortSignal) =>
      new Promise<Readonly<Record<string, string>>>((resolve) => {
        signal?.addEventListener("abort", () => resolve({}), { once: true });
      }),
    );
    const controller = new AbortController();
    const aborted = adapter(fetchImpl, { headerProvider: provider }).calculate(
      quoteInput(),
      context,
      controller.signal,
    );
    controller.abort();

    await expect(aborted).resolves.toMatchObject({ status: "unavailable", data: null });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    const timedOut = await adapter(fetchImpl, {
      headerProvider: () => new Promise<Readonly<Record<string, string>>>(() => undefined),
      timeoutMs: 1,
    }).calculate(quoteInput(), context);
    expect(timedOut).toMatchObject({ status: "unavailable", data: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("projects a calculated 200 response with exact source and sum evidence", async () => {
    const result = await adapter(responseFetch(upstreamResponse())).calculate(quoteInput(), context);

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      version: "quote-result@2026-08-13.v2",
      quote_id: "preview:quote:api:001",
      quote_status: "calculated",
      currency: "USD",
      total: { amount: "115.00", currency: "USD" },
      rule_version: "zone-rules-20260728",
      data_version: "zone-data-20260728",
      valid_from: "2026-07-28",
      valid_to: "2026-12-31",
      source_ref_ids: [SOURCE_ID],
      tenant: context.tenantId,
      effective_date: "2026-08-12",
      ready: true,
      test_data: false,
      origin: "toronto",
      billing_pallets: 2,
      service_version: "quote-service@fixture-1",
      contract_version: "quote-zone.v2",
      release_id: "release-20260812-a",
      release_hash: `sha256:${SNAPSHOT_HEX}`,
      snapshot_hash: `sha256:${SNAPSHOT_HEX}`,
      sendable: false,
    });
    expect(result.data).not.toHaveProperty("fees");
    expect(result.data).not.toHaveProperty("matched_by");
    expect(result.sourceRefs).toEqual([
      expect.objectContaining({
        source_id: SOURCE_ID,
        version: "release-20260812-a:zone-rules-20260728:zone-data-20260728",
      }),
    ]);
    expect(result.sourceRefs[0]?.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.calculationTrace?.[0]?.source_ref_ids).toEqual([SOURCE_ID]);
  });

  it("maps a 200 manual response to manual_review while retaining complete evidence", async () => {
    const result = await adapter(responseFetch(manualResponse())).calculate(quoteInput(), context);

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({
      quote_status: "manual_review",
      total: null,
      billing_pallets: null,
      source_ref_ids: [SOURCE_ID],
      ready: true,
      test_data: false,
    });
    expect(result.sourceRefs).toHaveLength(1);
    expect(result.calculationTrace?.every((step) => step.source_ref_ids.includes(SOURCE_ID))).toBe(true);
  });

  it("returns unavailable with null data for 503 and never exposes the upstream body", async () => {
    const unavailableResponse = {
      version: "quote-preview-unavailable@2026-08-13",
      quote_id: null,
      quote_version: null,
      status: "unavailable",
      source_type: "manual_required",
      origin: "toronto",
      zone: null,
      billing_pallets: null,
      fees: {},
      test_data: false,
      manual_review_required: true,
      matched_by: null,
      rule_version: null,
      data_version: null,
      valid_from: null,
      valid_to: null,
      source_ref: null,
      service_version: null,
      contract_version: "quote-zone.v2",
      release_id: null,
      release_hash: null,
      snapshot_hash: null,
      published_at: null,
      reasons: ["quote_preview_unavailable"],
      quote_status: "not_calculable",
      total: null,
      line_items: [],
      source_ref_ids: [],
      sendable: false,
      tenant: context.tenantId,
      effective_date: "2026-08-12",
      ready: false,
    };
    const result = await adapter(
      responseFetch(unavailableResponse, 503),
    ).calculate(quoteInput(), context);

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(result.sourceRefs).toEqual([]);
    expect(result.calculationTrace).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("synthetic-upstream-body");
  });

  it.each([
    ["tenant", { tenant: "other-tenant" }],
    ["origin", { origin: "calgary" }],
    ["effective date", { effective_date: "2026-08-13" }],
    ["validity", { valid_from: "2026-08-13" }],
    ["ready", { ready: false }],
    ["test data", { test_data: true }],
    ["contract", { contract_version: "quote-zone.v1" }],
    ["available version", { version: "quote-result@fixture-1" }],
    ["release hash", { release_hash: "sha256:" + "b".repeat(64) }],
    ["quote version", { quote_version: "release-20260812-a:wrong:data" }],
    ["source id", { source_ref_ids: ["src:quote:snapshot:" + "b".repeat(64)] }],
    ["line source ids", {
      line_items: [{
        line_id: "zone_base",
        label: "Canada final-mile base price",
        amount: fee("100.00"),
        pricing_basis: "zone_price_matrix",
        source_ref_ids: ["src:quote:snapshot:" + "b".repeat(64)],
      }],
    }],
    ["line sum", {
      line_items: [
        {
          line_id: "zone_base",
          label: "Canada final-mile base price",
          amount: fee("101.00"),
          pricing_basis: "zone_price_matrix",
          source_ref_ids: [SOURCE_ID],
        },
      ],
    }],
  ] as const)("fails closed on %s identity or evidence mismatch", async (_label, override) => {
    const result = await adapter(responseFetch(upstreamResponse(override))).calculate(quoteInput(), context);

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(result.sourceRefs).toEqual([]);
  });

  it("stays disabled by default and keeps draft writes disabled", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const disabled = new QuoteApiAdapter({
      baseUrl: BASE_URL,
      allowedHosts: ALLOWED_HOSTS,
      originByWarehouse: { "fixture-warehouse": "toronto" },
      fetchImpl,
    });

    await expect(disabled.calculate(quoteInput(), context)).resolves.toMatchObject({
      status: "unavailable",
      data: null,
    });
    await expect(disabled.commitDraft({})).resolves.toMatchObject({
      status: "unavailable",
      data: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes context and signal through the phase1 bundle domain handler", async () => {
    const fetchImpl = responseFetch(upstreamResponse());
    const quote = adapter(fetchImpl);
    const bundle = createPhase1Bundle({ ...createFixtureAdapters(), quote });
    const signal = new AbortController().signal;
    const handler = bundle.handlers["quote.canada_final_mile.calculate"];
    if (handler === undefined) throw new Error("quote handler missing");

    const result = await handler(quoteInput(), context, signal);

    expect(result.status).toBe("success");
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeTypeOf("object");
  });
});
