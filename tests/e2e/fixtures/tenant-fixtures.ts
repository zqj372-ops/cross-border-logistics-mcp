import { createFixtureComposition, type GatewayComposition } from "../../../src/logistics_mcp/server/composition";
import type { AuthClaims, ExecutionContext } from "../../../src/logistics_mcp/platform/context";
import type { AdapterResult, QuoteAdapter } from "../../../src/logistics_mcp/adapters/ports";
import {
  quoteV2ResultSchema,
} from "../../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import {
  canonicalizeQuotePdfAuthorityBody,
  quoteCreatePdfInputSchema,
  type QuotePdfPort,
} from "../../../src/logistics_mcp/domains/quote/create-pdf";
import type { QuotePdfMetadata } from "../../../src/logistics_mcp/adapters/pdf/quote-pdf-api-adapter";
import { hashPayload } from "../../../src/logistics_mcp/platform/idempotency";

export const FIXTURE_ORIGIN = "https://client.example.invalid";
export const FIXTURE_HOST = "mcp.example.invalid";

export interface FixtureHarnessOptions {
  readonly tenantId?: string;
  readonly customsFixture?: "customs-ready" | "customs-not-ready";
}

export interface FixtureHarness {
  readonly composition: GatewayComposition;
  readonly close: () => Promise<void>;
  readonly request: (body: unknown, sessionId?: string) => Promise<Response>;
}

function claimsFor(tenantId: string): AuthClaims {
  return {
    tenant_id: tenantId,
    actor_id: "sales_demo",
    actor_role: "sales",
    roles: ["sales"],
    scopes: [
      "knowledge:read",
      "system:read",
      "quote:calculate",
      "container:calculate",
      "tariff:read",
      "tariff:estimate",
      "quote:draft_write",
      "quote:pdf_write",
      "review:create_task",
    ],
    client_id: "client_demo",
    session_id: `session_${tenantId}`,
    expires_at: Math.floor(Date.now() / 1000) + 300,
  };
}

export function quotePdfInput(
  operationMode: "preview" | "commit",
  idempotencyKey: string,
  previewRef: string | null = operationMode === "preview" ? null : "preview:missing",
): Record<string, unknown> {
  return quoteCreatePdfInputSchema.parse({
    schema_version: "2026-08-11.v1",
    version: "quote-create-pdf-request@2026-08-14.v1",
    quote_request: quoteInput(),
    presentation: { customer_display_name: "Fixture PDF customer" },
    write_context: {
      idempotency_key: idempotencyKey,
      operation_mode: operationMode,
      preview_ref: previewRef,
      approval: operationMode === "preview"
        ? { required: false, status: "not_required", approval_id: null }
        : { required: true, status: "approved", approval_id: "approval:pdf-e2e" },
    },
  });
}

export function createQuotePdfFixturePorts() {
  const sourceId = `src:quote:snapshot:${"a".repeat(64)}`;
  const snapshotHash = `sha256:${"a".repeat(64)}`;
  const sourceRef = {
    source_id: sourceId,
    source_type: "internal_system" as const,
    system: "quote-service",
    locator: "opaque://quote/e2e-pdf",
    version: "quote-service@e2e-pdf",
    retrieved_at: "2026-08-14T00:00:00Z",
    authority: "authoritative" as const,
    content_hash: snapshotHash,
  };
  const quoteCalls: Array<{ context: ExecutionContext | undefined; signal: AbortSignal | undefined }> = [];
  const postCalls: Array<{ body: Record<string, unknown>; key: string; context: ExecutionContext; signal: AbortSignal | undefined }> = [];
  const getCalls: Array<{ documentRef: string; context: ExecutionContext; signal: AbortSignal | undefined }> = [];
  let metadata: QuotePdfMetadata | undefined;
  const quote: QuoteAdapter = {
    calculate: (_input, context, signal): Promise<AdapterResult> => {
      quoteCalls.push({ context, signal });
      const data = quoteV2ResultSchema.parse({
        version: "quote-result@2026-08-13.v2",
        quote_id: "quote:e2e-pdf:001",
        quote_status: "calculated",
        currency: "USD",
        total: { amount: "115.00", currency: "USD" },
        line_items: [{
          line_id: "line:e2e-pdf",
          label: "Fixture line",
          amount: { amount: "115.00", currency: "USD" },
          pricing_basis: "fixture",
          source_ref_ids: [sourceId],
        }],
        rule_version: "rules:e2e-pdf",
        data_version: "data:e2e-pdf",
        sendable: false,
        valid_from: "2026-08-01",
        valid_to: "2026-08-31",
        source_ref_ids: [sourceId],
        tenant: context?.tenantId ?? "tenant_demo_a",
        effective_date: "2026-08-14",
        ready: true,
        test_data: false,
        origin: "toronto",
        billing_pallets: 2,
        snapshot_hash: snapshotHash,
        service_version: "quote-service@e2e-pdf",
        contract_version: "quote-zone.v2",
        release_id: "release:e2e-pdf",
        release_hash: snapshotHash,
        published_at: "2026-08-14T00:00:00Z",
      });
      return Promise.resolve({
        status: "success",
        data,
        sourceRefs: [sourceRef],
        calculationTrace: [{
          step_id: "step:quote:e2e-pdf",
          operation: "fixture quote calculation",
          inputs: [],
          result: "calculated",
          source_ref_ids: [sourceId],
          rounding: null,
        }],
      });
    },
    previewDraft: () => Promise.reject(new Error("quote draft is not part of this fixture")),
    commitDraft: () => Promise.reject(new Error("quote draft is not part of this fixture")),
    readDraft: () => Promise.reject(new Error("quote draft is not part of this fixture")),
  };
  const quotePdf: QuotePdfPort = {
    post: (body, key, context, signal) => {
      postCalls.push({ body, key, context, signal });
      metadata = {
        document_ref: "01234567-89ab-cdef-0123-456789abcdef.pdf",
        sha256: "b".repeat(64),
        byte_length: 128,
        renderer_version: "renderer-8",
        template_version: "template-1",
        status: "ready",
        sendable: false,
        quote_id: String(body.quote_id),
        quote_version: String(body.quote_version),
        release_id: String(body.release_id),
        rule_version: String(body.rule_version),
        data_version: String(body.data_version),
        effective_date: String(body.effective_date),
        snapshot_hash: String(body.snapshot_hash),
        release_hash: String(body.release_hash),
        input_sha256: hashPayload(canonicalizeQuotePdfAuthorityBody(body)).slice("sha256:".length),
      };
      return Promise.resolve({ ok: true, status: 201, metadata });
    },
    get: (documentRef, context, signal) => {
      getCalls.push({ documentRef, context, signal });
      return Promise.resolve(metadata === undefined
        ? { ok: false, failure: { kind: "manual_review", code: "pdf.not_posted", dispatched: true } }
        : { ok: true, metadata });
    },
  };
  return { quote, quotePdf, quoteCalls, postCalls, getCalls };
}

export function createFixtureHarness(options: FixtureHarnessOptions = {}): FixtureHarness {
  const tenantId = options.tenantId ?? "tenant_demo_a";
  const composition = createFixtureComposition({
    dataMode: "fixtures",
    customsFixture: options.customsFixture,
    allowedOrigins: [FIXTURE_ORIGIN],
    allowedHosts: [FIXTURE_HOST],
    authenticate: (token) => {
      if (token !== `token_${tenantId}`) {
        throw new Error("fixture authentication failed");
      }
      return claimsFor(tenantId);
    },
  });

  const request = (body: unknown, sessionId?: string): Promise<Response> =>
    composition.handler(
      new Request(`https://${FIXTURE_HOST}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer token_${tenantId}`,
          origin: FIXTURE_ORIGIN,
          host: FIXTURE_HOST,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
        },
        body: JSON.stringify(body),
      }),
    );

  return { composition, close: composition.close, request };
}

export const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "fixture-client", version: "1.0.0" },
  },
};

export async function initialize(harness: FixtureHarness): Promise<string> {
  const response = await harness.request(initializeBody);
  if (!response.ok) throw new Error(`fixture initialize failed: ${response.status}`);
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("fixture session was not created");
  return sessionId;
}

export async function callTool(
  harness: FixtureHarness,
  sessionId: string,
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  const response = await harness.request(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    },
    sessionId,
  );
  const body = (await response.json()) as {
    result?: { structuredContent?: Record<string, unknown> };
    error?: { message?: string };
  };
  if (body.result?.structuredContent !== undefined) return body.result.structuredContent;
  throw new Error(body.error?.message ?? `tool call failed: ${response.status}`);
}

export function cargoInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "cargo.calculate@fixture-1",
    cargo_lines: [
      {
        version: "cargo-line@fixture-1",
        line_id: "line_fixture_1",
        description: "synthetic carton",
        quantity: 2,
        quantity_unit: "carton",
        package_type: "carton",
        unit_weight: { value: "12.5", unit: "kg" },
        dimensions: [
          {
            length: { value: "60", unit: "cm" },
            width: { value: "50", unit: "cm" },
            height: { value: "40", unit: "cm" },
            quantity: 2,
          },
        ],
        stackable: true,
        fragile: false,
        sensitive: false,
        source_ref_ids: ["src_input_fixture_1"],
      },
    ],
    dimensional_divisor: null,
    bubble_rule: {
      channel: "CAQ-HP",
      mode: "full",
      ratio: null,
      rule_version: "CAQ-HP@fixture-1",
      source_ref_ids: ["src_rule_fixture_1"],
      density: { value: "1000", unit: "kg_per_cbm" },
      unit: "kg",
      rounding: { mode: "none", decimals: 6 },
    },
    channel_code: "CAQ-HP",
    source_refs: [
      {
        source_id: "src_input_fixture_1",
        source_type: "fixture",
        system: "fixture-gateway",
        locator: "fixture://cargo/input",
        version: "input@fixture-1",
        retrieved_at: "2026-08-11T00:00:00Z",
        authority: "user_provided",
        content_hash: "sha256:fixturecargo01",
      },
      {
        source_id: "src_rule_fixture_1",
        source_type: "fixture",
        system: "fixture-rule-registry",
        locator: "fixture://cargo/rule",
        version: "CAQ-HP@fixture-1",
        retrieved_at: "2026-08-11T00:00:00Z",
        authority: "authoritative",
        content_hash: "sha256:fixturecargo02",
      },
    ],
    ...overrides,
  };
}

export function containerInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "container-profile@fixture-1",
    plan_id: "plan_fixture_1",
    container_type: "40HQ",
    physical_capacity: { value: "76", unit: "cbm" },
    operational_target: { value: "75", unit: "cbm" },
    max_payload: { value: "26000", unit: "kg" },
    source_ref_ids: ["src:container:profile:fixture"],
    cargo_metrics: {
      version: "cargo-metrics@fixture-1",
      line_count: 1,
      total_quantity: 2,
      total_volume: { value: "60", unit: "cbm" },
      actual_weight: { value: "18000", unit: "kg" },
      volumetric_weight: { value: "60000", unit: "kg" },
      weight_evidence: "line_total_weight",
      derived_from_line_ids: ["line_fixture_1"],
    },
    loading_constraints: {
      sensitive_at_head: true,
      declaration_at_tail: true,
      fifo_for_other: true,
      customer_priority: null,
    },
    loading_lines: [
      {
        line_id: "line_fixture_1",
        sensitive: false,
        customer_priority: null,
        declaration_required: false,
      },
    ],
    ...overrides,
  };
}

export function quoteInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      detention_minutes: 0,
      limited_access: false,
      remote_area: false,
    },
    effective_at: "2026-08-11",
    ...overrides,
  };
}

export function legacyQuoteDraftResult(): Record<string, unknown> {
  const sourceRefId = "src:quote:legacy:fixture";
  return {
    version: "quote-result@2026-08-11.v1",
    quote_id: "quote-legacy-fixture-001",
    quote_status: "calculated",
    currency: "USD",
    total: { amount: "135.80", currency: "USD" },
    line_items: [
      {
        line_id: "line:quote:legacy-base",
        label: "Canada final-mile base price",
        amount: { amount: "123.45", currency: "USD" },
        pricing_basis: "fixture",
        source_ref_ids: [sourceRefId],
      },
      {
        line_id: "line:quote:legacy-fuel",
        label: "Fuel surcharge",
        amount: { amount: "12.35", currency: "USD" },
        pricing_basis: "fixture",
        source_ref_ids: [sourceRefId],
      },
    ],
    rule_version: "zone-rule-fixture@1",
    data_version: "zone-price-fixture@1",
    sendable: false,
    valid_from: "2026-08-11T00:00:00Z",
    valid_to: "2026-08-31T23:59:59Z",
    source_ref_ids: [sourceRefId],
  };
}

export function writeContext(
  tenantId: string,
  operationMode: "preview" | "commit",
  previewRef: string | null,
  idempotencyKey: string,
  approval: Record<string, unknown> = {
    required: false,
    status: "not_required",
    approval_id: null,
  },
): Record<string, unknown> {
  return {
    tenant_context: {
      tenant_id: tenantId,
      actor_id: "sales_demo",
      actor_role: "sales",
      client_id: "client_demo",
      session_id: `session_${tenantId}`,
    },
    idempotency_key: idempotencyKey,
    operation_mode: operationMode,
    preview_ref: previewRef,
    approval,
  };
}
