import { describe, expect, it, vi } from "vitest";

import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import { createPhase1Bundle } from "../../src/logistics_mcp/adapters/phase1-bundle";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client";
import { writeResultSchema } from "../../src/logistics_mcp/adapters/contracts";
import {
  executeRegisteredToolWithResult,
  registerPhaseOneTools,
} from "../../src/logistics_mcp/server/tool-registry";
import { MemoryIdempotencyRepository } from "../../src/logistics_mcp/platform/idempotency";
import {
  QuoteApiAdapter,
  quoteV2InputSchema,
  quoteV2ResultSchema,
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

function draftInput(
  operationMode: "preview" | "commit",
  previewRef: string | null,
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "quote-save@fixture-1",
    quote_result: {
      version: "quote-result@fixture-1",
      quote_id: "quote-demo-001",
      quote_status: "calculated",
      currency: "USD",
      total: { amount: "143.80", currency: "USD" },
      line_items: [],
      rule_version: "zone-rule-fixture-1",
      data_version: "zone-price-fixture-1",
      sendable: false,
      valid_from: "2026-08-01T00:00:00Z",
      valid_to: "2026-08-31T23:59:59Z",
      source_ref_ids: ["src:quote:fixture:1"],
    },
    target: { system: "existing_quote_system", record_kind: "draft" },
    write_context: {
      tenant_context: {
        tenant_id: context.tenantId,
        actor_id: context.actorId,
        actor_role: context.role,
        client_id: context.clientId,
        session_id: context.sessionId,
      },
      idempotency_key: idempotencyKey,
      operation_mode: operationMode,
      preview_ref: previewRef,
      approval: {
        required: operationMode === "commit",
        status: operationMode === "commit" ? "approved" : "not_required",
        approval_id: operationMode === "commit" ? "approval:disabled" : null,
      },
    },
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
    originByTenantWarehouse: {
      [context.tenantId]: { "fixture-warehouse": "toronto" },
    },
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
      Authorization: "Bearer provider-must-not-forward",
      "X-Tenant-Id": "tenant-must-not-forward",
      "X-Custom": "custom-must-not-forward",
      ...(signal === undefined ? {} : { "X-Signal-Present": "provider-only" }),
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
    const forwardedHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(forwardedHeaders.get("authorization")).toBeNull();
    expect(forwardedHeaders.get("x-tenant-id")).toBeNull();
    expect(forwardedHeaders.get("x-custom")).toBeNull();
    expect(forwardedHeaders.get("x-signal-present")).toBeNull();
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(provider.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain("synthetic-api-key");
  });

  it.each([
    ["missing API key", { Authorization: "Bearer no-api-key" }],
    ["duplicate API key names", { "X-API-Key": "one", "x-api-key": "two" }],
  ] as const)("fails closed without fetching for %s", async (_label, headers) => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const result = await adapter(fetchImpl, {
      headerProvider: () => headers,
    }).calculate(quoteInput(), context);

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not call upstream for missing context, invalid v2 evidence, or an unmapped warehouse", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const cases: Array<[string, Record<string, unknown>, ExecutionContext | undefined]> = [
      ["context", quoteInput(), undefined],
      ["explicit pallet count", withCargo({ explicit_pallet_count: undefined }), context],
      ["zero volume", withCargo({ total_volume: { value: "0.000", unit: "cbm" } }), context],
      ["zero weight", withCargo({ weight_kg: { value: "0", unit: "kg" } }), context],
      ["zero longest side", withCargo({ longest_side: { value: "0", unit: "cm" } }), context],
      ["decimal digit limit", withCargo({ total_volume: { value: "1".repeat(24), unit: "cbm" } }), context],
      ["decimal length limit", withCargo({ total_volume: { value: "1".repeat(25), unit: "cbm" } }), context],
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

  it("scopes warehouse origins to the execution tenant and rejects prototype keys", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<FetchImplementation>((_input, init) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requestBodies.push(body);
      return Promise.resolve(
        new Response(JSON.stringify(upstreamResponse({
          origin: body.origin,
          tenant: body.tenant_id,
        }))),
      );
    });
    const tenantB = { ...context, tenantId: "tenant_b" };
    const scoped = adapter(fetchImpl, {
      originByTenantWarehouse: {
        [context.tenantId]: { "fixture-warehouse": "toronto" },
        [tenantB.tenantId]: { "fixture-warehouse": "calgary" },
      },
    });

    await expect(scoped.calculate(quoteInput(), context)).resolves.toMatchObject({ status: "success" });
    await expect(scoped.calculate(quoteInput(), tenantB)).resolves.toMatchObject({ status: "success" });
    expect(requestBodies.map((body) => body.origin)).toEqual(["toronto", "calgary"]);
    expect(requestBodies.map((body) => body.tenant_id)).toEqual([context.tenantId, tenantB.tenantId]);

    const unknownTenant = { ...context, tenantId: "tenant_c" };
    const unavailable = await scoped.calculate(quoteInput(), unknownTenant);
    expect(unavailable.status).toBe("needs_input");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const prototypeKey = await adapter(vi.fn<FetchImplementation>(), {
      originByTenantWarehouse: { [context.tenantId]: {} },
    }).calculate(withOrigin("toString"), context);
    expect(prototypeKey.status).toBe("needs_input");
  });

  it("exports the v2 runtime schemas and parses the projected result", async () => {
    expect(quoteV2InputSchema.safeParse(quoteInput()).success).toBe(true);
    const result = await adapter(responseFetch(upstreamResponse())).calculate(quoteInput(), context);

    expect(result.status).toBe("success");
    const validData = quoteV2ResultSchema.parse(result.data);
    expect(validData).not.toHaveProperty("fees");
    expect(quoteV2ResultSchema.safeParse({
      ...validData,
      release_hash: `sha256:${"b".repeat(64)}`,
    }).success).toBe(false);
    expect(quoteV2ResultSchema.safeParse({
      ...validData,
      effective_date: "2027-01-01",
    }).success).toBe(false);
    expect(quoteV2ResultSchema.safeParse({
      ...validData,
      source_ref_ids: [SOURCE_ID, SOURCE_ID],
    }).success).toBe(false);
    expect(quoteV2ResultSchema.safeParse({
      ...validData,
      total: { amount: "114.99", currency: "USD" },
    }).success).toBe(false);
    expect(quoteV2ResultSchema.safeParse({
      ...validData,
      currency: "CAD",
    }).success).toBe(false);
    expect(quoteV2ResultSchema.safeParse({
      ...validData,
      line_items: validData.line_items.map((line, index) => index === 0
        ? { ...line, source_ref_ids: ["src:quote:snapshot:b"] }
        : line),
    }).success).toBe(false);
    const wrongSnapshotSourceId = `src:quote:snapshot:${"b".repeat(64)}`;
    expect(quoteV2ResultSchema.safeParse({
      ...validData,
      source_ref_ids: [wrongSnapshotSourceId],
      line_items: validData.line_items.map((line) => ({
        ...line,
        source_ref_ids: [wrongSnapshotSourceId],
      })),
    }).success).toBe(false);

    const manual = await adapter(responseFetch(manualResponse())).calculate(quoteInput(), context);
    expect(quoteV2ResultSchema.safeParse(manual.data).success).toBe(true);
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

  it("maps a formal 422 validation response to needs_input without exposing the upstream body", async () => {
    const fetchImpl = responseFetch({
      detail: "sensitive upstream detail",
      credential: "synthetic-upstream-secret",
    }, 422);
    const result = await adapter(fetchImpl).calculate(quoteInput(), context);

    expect(result.status).toBe("needs_input");
    expect(result.data).toBeNull();
    expect(result.blockers).toEqual([
      expect.objectContaining({
        code: "quote.upstream_request_invalid",
        field: "input",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("sensitive upstream detail");
    expect(JSON.stringify(result)).not.toContain("synthetic-upstream-secret");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    ["missing base fee", { fees: { fuel: fee("10.00"), total: fee("115.00") } }],
    ["fee component sum", {
      fees: {
        base: fee("100.00"),
        fuel: fee("10.00"),
        appointment_fee: fee("6.00"),
        total: fee("115.00"),
      },
    }],
    ["fee total", {
      fees: {
        base: fee("100.00"),
        fuel: fee("10.00"),
        appointment_fee: fee("5.00"),
        total: fee("116.00"),
      },
    }],
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

  it("rejects non-empty fees on an available manual response", async () => {
    const result = await adapter(responseFetch(manualResponse({ fees: { base: fee("100.00") } })))
      .calculate(quoteInput(), context);

    expect(result.status).toBe("unavailable");
    expect(result.data).toBeNull();
  });

  it("stays disabled by default and keeps draft writes disabled", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const disabled = new QuoteApiAdapter({
      baseUrl: BASE_URL,
      allowedHosts: ALLOWED_HOSTS,
      originByTenantWarehouse: {
        [context.tenantId]: { "fixture-warehouse": "toronto" },
      },
      fetchImpl,
    });

  await expect(disabled.calculate(quoteInput(), context)).resolves.toMatchObject({
      status: "unavailable",
      data: null,
    });
    await expect(disabled.commitDraft(draftInput("commit", "preview:quote:disabled", "idem_disabled_quote_123456"))).resolves.toMatchObject({
      status: "unavailable",
      data: { operation_status: "rejected" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps disabled draft preview, commit, and read structured through the registered contract", async () => {
    const fetchImpl = vi.fn<FetchImplementation>();
    const quote = adapter(fetchImpl);
    const bundle = createPhase1Bundle({ ...createFixtureAdapters(), quote });
    const definition = registerPhaseOneTools(bundle.handlers, bundle.contracts).find(
      (candidate) => candidate.name === "quote.save_draft",
    );
    if (definition === undefined) throw new Error("quote.save_draft was not registered");
    const writeContext = { ...context, scopes: [...context.scopes, "quote:draft_write"] };
    const repository = new MemoryIdempotencyRepository();

    const preview = await executeRegisteredToolWithResult(
      definition,
      draftInput("preview", null, "idem_quote_disabled_preview_1"),
      writeContext,
      {
        requestId: "req:quote:disabled:preview",
        auditId: "audit:quote:disabled:preview",
        idempotencyRepository: repository,
      },
    );
    expect(preview.envelope.status).toBe("unavailable");
    expect(preview.envelope.data).toMatchObject({
      operation: "quote.save_draft",
      operation_status: "rejected",
    });
    writeResultSchema.parse(preview.envelope.data);

    const commit = await executeRegisteredToolWithResult(
      definition,
      draftInput("commit", "preview:quote:disabled", "idem_quote_disabled_commit_1"),
      writeContext,
      {
        requestId: "req:quote:disabled:commit",
        auditId: "audit:quote:disabled:commit",
        idempotencyRepository: repository,
      },
    );
    expect(commit.envelope.status).toBe("unavailable");
    expect(commit.envelope.data).toMatchObject({
      operation: "quote.save_draft",
      operation_status: "rejected",
    });
    writeResultSchema.parse(commit.envelope.data);

    const read = await quote.readDraft({
      record_id: "draft:disabled",
      tenant_id: context.tenantId,
      write_context: draftInput("preview", null, "idem_quote_disabled_read_1").write_context,
    });
    expect(read.status).toBe("unavailable");
    expect(read.data).toMatchObject({
      operation: "quote.save_draft",
      operation_status: "rejected",
    });
    writeResultSchema.parse(read.data);
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
