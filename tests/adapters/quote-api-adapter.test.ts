import { describe, expect, it, vi } from "vitest";

import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import { createPhase1Bundle } from "../../src/logistics_mcp/adapters/phase1-bundle";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client";
import {
  QuoteApiAdapter,
  type QuoteApiAdapterOptions,
} from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import {
  executeRegisteredToolWithResult,
  registerPhaseOneTools,
} from "../../src/logistics_mcp/server/tool-registry";
import type { ExecutionContext } from "../../src/logistics_mcp/platform/context";
import { hashPayload } from "../../src/logistics_mcp/platform/idempotency";

const BASE_URL = "https://quote.example.invalid/root";
const ALLOWED_HOSTS = ["quote.example.invalid"];
const ORIGIN_BY_WAREHOUSE = { "fixture-warehouse": "toronto" };

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
    version: "quote-request@fixture-1",
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
      billing_pallets: 2,
      weight_kg: { value: "100", unit: "kg" },
      pieces: 2,
      package_types: ["pallet"],
      total_volume: { value: "1.25", unit: "cbm" },
    },
    services: {
      appointment: true,
      liftgate: false,
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

function withDestination(patch: Record<string, unknown>): Record<string, unknown> {
  const input = quoteInput();
  return { ...input, destination: { ...nested(input, "destination"), ...patch } };
}

function withServices(patch: Record<string, unknown>): Record<string, unknown> {
  const input = quoteInput();
  return { ...input, services: { ...nested(input, "services"), ...patch } };
}

function withOrigin(origin: Record<string, unknown>): Record<string, unknown> {
  const input = quoteInput();
  return { ...input, origin };
}

function upstreamResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    quote_id: "quote-api-demo-001",
    source_type: "zone_matrix",
    confidence: 100,
    postal_code: "A0A 0A0",
    preferred_city: "Fixture City",
    postal_prefix: "A0A",
    city: "Fixture City",
    province: "ON",
    origin: "toronto",
    zone: 2,
    billing_pallets: 2,
    pallet_breakdown: { pallet: 2 },
    base_price_usd: "100.00",
    fuel_usd: "7.50",
    accessorials: { appointment_fee: "8.25" },
    total_price_usd: "999.99",
    risk_tags: [],
    manual_review_required: false,
    matched_rule: "synthetic-rule",
    matched_by: "postal_fsa_exact",
    candidate_count: 1,
    match_trace: { matched_by: "synthetic" },
    sales_note: "synthetic note",
    internal_note: "synthetic note",
    ...overrides,
  };
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
    originByWarehouse: ORIGIN_BY_WAREHOUSE,
    fetchImpl,
    clock: () => new Date("2026-08-12T00:00:00Z"),
    ...overrides,
  });
}

describe("quote API adapter", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
  ])("does not fetch when total volume is %s", async (_label, totalVolume) => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const input = withCargo({ total_volume: totalVolume });

    const result = await adapter(fetchImpl).calculate(input);

    expect(result.status).toBe("needs_input");
    expect(result.data).toBeNull();
    expect(result.blockers).toEqual([
      expect.objectContaining({ field: "cargo.total_volume" }),
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["historical", "2026-08-11"],
    ["future", "2026-08-13"],
  ])("does not fetch for a %s effective date", async (_label, effectiveAt) => {
    const fetchImpl = vi.fn<FetchImplementation>();

    const result = await adapter(fetchImpl).calculate({
      ...quoteInput(),
      effective_at: effectiveAt,
    });

    expect(result.status).toBe("manual_review");
    expect(result.blockers?.[0]).toMatchObject({
      code: "quote.effective_date_unsupported",
      field: "effective_at",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["postal_code", withDestination({ postal_code: null })],
    ["weight_kg", withCargo({ weight_kg: null })],
    ["pieces", withCargo({ pieces: null })],
    ["package_types", withCargo({ package_types: [] })],
    ["origin mapping", withOrigin({ warehouse_code: "unknown-warehouse", province: "ON" })],
  ])("does not fetch when %s is missing", async (_field, input) => {
    const fetchImpl = vi.fn<FetchImplementation>();

    const result = await adapter(fetchImpl).calculate(input);

    expect(result.status).toBe("needs_input");
    expect(result.data).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not silently ignore multiple package types or unsupported services", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();

    const packageResult = await adapter(fetchImpl).calculate(
      withCargo({ package_types: ["pallet", "carton"] }),
    );
    const serviceResults = await Promise.all([
      adapter(fetchImpl).calculate(withServices({ limited_access: true })),
      adapter(fetchImpl).calculate(withServices({ remote_area: true })),
    ]);

    expect(packageResult.status).toBe("manual_review");
    expect(packageResult.blockers?.map(({ code }) => code)).toContain(
      "quote.package_types_conflict",
    );
    for (const serviceResult of serviceResults) {
      expect(serviceResult.status).toBe("manual_review");
      expect(serviceResult.blockers?.map(({ code }) => code)).toContain(
        "quote.service_not_supported",
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a known address type before fetching", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();

    const result = await adapter(fetchImpl).calculate(
      withDestination({ address_type: "unknown" }),
    );

    expect(result.status).toBe("needs_input");
    expect(result.blockers?.[0]).toMatchObject({
      code: "quote.address_type_required",
      field: "destination.address_type",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps the formal request exactly, fixes notifications, and injects headers immediately before one fetch", async () => {
    const events: string[] = [];
    let requestBody: unknown;
    let requestHeaders: Record<string, string> = {};
    const headerProvider = vi.fn(() => {
      events.push("headers");
      return Promise.resolve({
        Authorization: "Bearer synthetic-test-credential",
        "x-correlation-id": "fixture-correlation",
      });
    });
    const fetchImpl = vi.fn<FetchImplementation>((_input, init) => {
      events.push("fetch");
      const body = init?.body;
      if (typeof body !== "string") throw new Error("synthetic request body missing");
      requestBody = JSON.parse(body);
      requestHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return Promise.resolve(new Response(JSON.stringify(upstreamResponse())));
    });

    const result = await adapter(fetchImpl, { headerProvider }).calculate({
      ...quoteInput(),
      notify_email: true,
      notify_wecom: true,
    });

    expect(result.status).toBe("manual_review");
    expect(events).toEqual(["headers", "fetch"]);
    expect(headerProvider).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestBody).toEqual({
      quote: {
        postal_code: "A0A 0A0",
        city: "Fixture City",
        province: "ON",
        cbm: "1.250000",
        weight_kg: "100",
        piece_count: 2,
        packaging_type: "pallet",
        address_type: "commercial",
        requires_liftgate: false,
        requires_appointment: true,
        explicit_pallet_count: 2,
      },
      notify_email: false,
      notify_wecom: false,
    });
    expect(requestHeaders.authorization).toBe("Bearer synthetic-test-credential");
    expect(JSON.stringify(result)).not.toContain("synthetic-test-credential");
    expect(requestHeaders.accept).toBe("application/json");
    expect(requestHeaders["content-type"]).toBe("application/json");
  });

  it("does not leak a header-provider error and never calls fetch after that error", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const result = await adapter(fetchImpl, {
      headerProvider: () => {
        throw new Error("synthetic-header-credential");
      },
    }).calculate(quoteInput());

    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("synthetic-header-credential");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses upstream amounts without recomputing and records sentinels plus response hash", async () => {
    const response = upstreamResponse();
    const fetchImpl = responseFetch(response);
    const result = await adapter(fetchImpl).calculate(quoteInput());
    const expectedHash = hashPayload(response);

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({
      quote_status: "manual_review",
      total: { amount: "999.99", currency: "USD" },
      rule_version: "upstream-rule-version:not-provided",
      data_version: `response-sha256:${expectedHash.slice(7)}`,
      sendable: false,
    });
    expect(result.blockers?.map(({ code }) => code)).toContain(
      "quote.business_version_missing",
    );
    expect(result.sourceRefs[0]).toMatchObject({
      version: "quote-zone-api.v1",
      content_hash: expectedHash,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "quote.upstream_side_effects",
          severity: "warning",
        }),
      ]),
    );
    expect(result.calculationTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "use upstream total_price_usd" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("synthetic note");
    expect(JSON.stringify(result)).not.toContain("matched_by");
  });

  it("clears all prices when the upstream origin disagrees with the explicit mapping", async () => {
    const fetchImpl = responseFetch(upstreamResponse({ origin: "calgary" }));

    const result = await adapter(fetchImpl).calculate(quoteInput());

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({
      quote_status: "manual_review",
      total: null,
      line_items: [
        { amount: null },
        { amount: null },
        { amount: null },
      ],
    });
    expect(result.blockers?.map(({ code }) => code)).toContain(
      "quote.origin_mismatch",
    );
  });

  it("preserves manual upstream status and never upgrades it to success", async () => {
    const fetchImpl = responseFetch(
      upstreamResponse({ manual_review_required: true }),
    );

    const result = await adapter(fetchImpl).calculate(quoteInput());

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({
      quote_status: "manual_review",
      total: { amount: "999.99", currency: "USD" },
      sendable: false,
    });
    expect(result.blockers?.map(({ code }) => code)).toContain(
      "quote.upstream_manual_review",
    );
  });

  it.each([
    ["missing field", (() => {
      const response = upstreamResponse();
      delete response.total_price_usd;
      return response;
    })()],
    ["non-decimal amount", upstreamResponse({ base_price_usd: 100 })],
    ["negative amount", upstreamResponse({ base_price_usd: "-1.00" })],
  ])("fails closed for a %s response", async (_label, response) => {
    const fetchImpl = responseFetch(response);

    const result = await adapter(fetchImpl).calculate(quoteInput());

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(result.blockers?.map(({ code }) => code)).toContain(
      "quote.upstream_contract_invalid",
    );
    expect(JSON.stringify(result)).not.toContain("synthetic note");
  });

  it.each([400, 500])("maps upstream HTTP %s to unavailable", async (status) => {
    const fetchImpl = responseFetch({ error: "synthetic upstream detail" }, status);

    const result = await adapter(fetchImpl).calculate(quoteInput());

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(result.blockers?.map(({ code }) => code)).toContain(
      "quote.upstream_unavailable",
    );
    expect(JSON.stringify(result)).not.toContain("synthetic upstream detail");
  });

  it("maps timeout to unavailable without leaking provider errors", async () => {
    const fetchImpl = vi.fn<FetchImplementation>(
      () => new Promise<Response>(() => undefined),
    );

    const result = await adapter(fetchImpl, { timeoutMs: 1 }).calculate(quoteInput());

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map(({ code }) => code)).toContain(
      "quote.upstream_unavailable",
    );
  });

  it("is disabled by default and rejects unsafe base URLs before any fetch", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const disabled = new QuoteApiAdapter({
      baseUrl: BASE_URL,
      allowedHosts: ALLOWED_HOSTS,
      originByWarehouse: ORIGIN_BY_WAREHOUSE,
      fetchImpl,
    });

    const disabledResult = await disabled.calculate(quoteInput());

    expect(disabledResult.status).toBe("unavailable");
    expect(disabledResult.blockers?.map(({ code }) => code)).toContain(
      "quote.adapter_disabled",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() =>
      new QuoteApiAdapter({
        baseUrl: "http://quote.example.invalid",
        allowedHosts: ALLOWED_HOSTS,
        enabled: true,
        originByWarehouse: ORIGIN_BY_WAREHOUSE,
        fetchImpl,
      }),
    ).toThrow(/HTTPS/i);
    expect(() =>
      new QuoteApiAdapter({
        baseUrl: "https://synthetic-user:synthetic-password@quote.example.invalid",
        allowedHosts: ALLOWED_HOSTS,
        enabled: true,
        originByWarehouse: ORIGIN_BY_WAREHOUSE,
        fetchImpl,
      }),
    ).toThrow(/credential|URL/i);
  });

  it("keeps inherited draft commit fail closed", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const result = await adapter(fetchImpl).commitDraft({
      quote_result: {
        version: "quote-result@fixture-1",
        quote_id: "quote-api-demo-001",
        quote_status: "manual_review",
        currency: "USD",
        total: null,
        line_items: [],
        rule_version: "upstream-rule-version:not-provided",
        data_version: "response-sha256:synthetic",
        sendable: false,
        valid_from: null,
        valid_to: null,
        source_ref_ids: ["src:quote:api:quote-api-demo-001"],
      },
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: {
        tenant_context: {
          tenant_id: "tenant_fixture",
          actor_id: "actor_sales",
          actor_role: "sales",
          client_id: "client_fixture",
          session_id: "session_fixture",
        },
        idempotency_key: "idem_quote_api_fixture_001",
        operation_mode: "commit",
        preview_ref: "preview:quote-save:fixture",
        approval: { required: false, status: "not_required", approval_id: null },
      },
    });

    expect(result.status).toBe("unavailable");
    expect(result.blockers?.map(({ code }) => code)).toContain(
      "quote.adapter_disabled",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs through createPhase1Bundle and registered output validation", async () => {
    const fetchImpl = responseFetch(upstreamResponse());
    const quote = adapter(fetchImpl);
    const bundle = createPhase1Bundle({ ...createFixtureAdapters(), quote });
    const definition = registerPhaseOneTools(bundle.handlers, bundle.contracts).find(
      ({ name }) => name === "quote.canada_final_mile.calculate",
    );
    if (definition === undefined) throw new Error("quote tool definition missing");

    const result = await executeRegisteredToolWithResult(
      definition,
      quoteInput(),
      context,
      { requestId: "req:quote:api", auditId: "audit:quote:api" },
    );

    expect(result.envelope.status).toBe("manual_review");
    expect(result.envelope.data).toMatchObject({
      quote_id: "quote-api-demo-001",
      rule_version: "upstream-rule-version:not-provided",
      sendable: false,
    });
    expect(result.envelope.blockers.map(({ code }) => code)).toContain(
      "quote.business_version_missing",
    );
  });
});
