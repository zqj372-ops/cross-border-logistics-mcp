import { createFixtureComposition, type GatewayComposition } from "../../../src/logistics_mcp/server/composition";
import type { AuthClaims } from "../../../src/logistics_mcp/platform/context";

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
      "review:create_task",
    ],
    client_id: "client_demo",
    session_id: `session_${tenantId}`,
    expires_at: Math.floor(Date.now() / 1000) + 300,
  };
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

export function quoteInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    },
    services: {
      appointment: true,
      liftgate: false,
      limited_access: false,
      remote_area: false,
    },
    effective_at: "2026-08-11",
    ...overrides,
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
