import { describe, expect, it } from "vitest";

import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import { quoteSaveDraftInputSchema } from "../../src/logistics_mcp/adapters/contracts";
import {
  quoteV2InputSchema,
  quoteV2ResultSchema,
} from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";

const context = parseExecutionContext({
  tenant_id: "tenant_fixture",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate", "quote:draft_write"],
  client_id: "client_fixture",
  session_id: "session_fixture",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

function quoteInput(): Record<string, unknown> {
  return quoteV2InputSchema.parse({
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
  });
}

describe("quote v2 fixture migration", () => {
  it("projects the fixture lookup into the verified v2 result contract", async () => {
    const result = await createFixtureAdapters().quote.calculate(quoteInput(), context);

    expect(result.status).toBe("success");
    const data = quoteV2ResultSchema.parse(result.data);
    expect(data).toMatchObject({
      version: "quote-result@2026-08-13.v2",
      quote_status: "calculated",
      tenant: context.tenantId,
      effective_date: "2026-08-11",
      ready: true,
      test_data: false,
      billing_pallets: 2,
    });
    expect(data.source_ref_ids[0]).toMatch(/^src:quote:snapshot:[a-f0-9]{64}$/);
    expect(result.sourceRefs?.map((source) => source.source_id)).toEqual(data.source_ref_ids);
    expect(result.calculationTrace?.every((step) => step.source_ref_ids.join() === data.source_ref_ids.join())).toBe(true);
  });

  it("allows a v2 calculation result to enter the existing draft write contract", () => {
    const snapshotHash = `sha256:${"a".repeat(64)}`;
    const sourceId = `src:quote:snapshot:${"a".repeat(64)}`;
    const result = quoteV2ResultSchema.parse({
      version: "quote-result@2026-08-13.v2",
      quote_id: "quote-v2-fixture-001",
      quote_status: "calculated",
      currency: "USD",
      total: { amount: "100.00", currency: "USD" },
      line_items: [{
        line_id: "line:base",
        label: "Base",
        amount: { amount: "100.00", currency: "USD" },
        pricing_basis: "fixture",
        source_ref_ids: [sourceId],
      }],
      rule_version: "quote-rule@fixture-v2",
      data_version: "quote-data@fixture-v2",
      sendable: false,
      valid_from: "2026-08-01",
      valid_to: "2026-08-31",
      source_ref_ids: [sourceId],
      tenant: context.tenantId,
      effective_date: "2026-08-11",
      ready: true,
      test_data: false,
      origin: "fixture-origin",
      billing_pallets: 2,
      snapshot_hash: snapshotHash,
      service_version: "quote-service@fixture-v2",
      contract_version: "quote-zone.v2",
      release_id: "quote-release-fixture-v2",
      release_hash: snapshotHash,
      published_at: "2026-08-11T00:00:00Z",
    });

    const parsed = quoteSaveDraftInputSchema.safeParse({
      schema_version: "2026-08-11.v1",
      version: "quote-save@fixture-v2",
      quote_result: result,
      target: { system: "existing_quote_system", record_kind: "draft" },
      write_context: {
        tenant_context: {
          tenant_id: context.tenantId,
          actor_id: context.actorId,
          actor_role: context.role,
          client_id: context.clientId,
          session_id: context.sessionId,
        },
        idempotency_key: "idem_quote_v2_fixture_001",
        operation_mode: "preview",
        preview_ref: null,
        approval: { required: false, status: "not_required", approval_id: null },
      },
    });

    expect(parsed.success).toBe(true);
  });
});
