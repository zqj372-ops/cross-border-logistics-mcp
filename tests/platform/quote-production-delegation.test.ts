import { describe, expect, it, vi } from "vitest";

import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import {
  quoteV2InputSchema,
  quoteV2ResultSchema,
} from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  createFixtureComposition,
  createProductionComposition,
  type ProductionAdapterSource,
} from "../../src/logistics_mcp/server/composition";
import { executeRegisteredTool } from "../../src/logistics_mcp/server/tool-registry";

const context = parseExecutionContext({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate"],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

function quoteInput(): Record<string, unknown> {
  return quoteV2InputSchema.parse({
    schema_version: "2026-08-11.v1",
    version: "quote-request@2026-08-13.v2",
    origin: { warehouse_code: "tenant-warehouse-01", province: "ON" },
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
    effective_at: "2026-08-13",
  });
}

async function usingComposition<T>(
  composition: { close: () => Promise<void> },
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } finally {
    await composition.close();
  }
}

describe("quote fixture and v2 contract migration", () => {
  it("keeps the legacy quote fixture on the explicit fixture track with the v2 envelope", async () => {
    const composition = createFixtureComposition({ dataMode: "fixtures" });

    await usingComposition(composition, async () => {
      const definition = composition.definitions.find(
        ({ name }) => name === "quote.canada_final_mile.calculate",
      );
      if (definition === undefined) throw new Error("fixture quote definition missing");
      expect(definition.inputSchemaId).toBe(
        "urn:logistics-mcp:quote.canada_final_mile.calculate:2026-08-13.v2",
      );
      expect(definition.outputSchemaId).toBe("quote-envelope-v2.schema.json");

      const envelope = await executeRegisteredTool(
        definition,
        quoteInput(),
        context,
        {
          requestId: "request_quote_fixture_v2_001",
          auditId: "audit_quote_fixture_v2_001",
        },
      );
      expect(envelope).toMatchObject({
        status: "success",
        data: {
          version: "quote-result@2026-08-13.v2",
          quote_status: "calculated",
          sendable: false,
          test_data: false,
        },
      });
      expect(quoteV2ResultSchema.safeParse(envelope.data).success).toBe(true);
      expect(envelope.source_refs.length).toBeGreaterThan(0);
      expect(envelope.calculation_trace.length).toBeGreaterThan(0);
    });
  });

  it("keeps all quote adapters outside the exact T0 production composition", async () => {
    const health = vi.fn(() => Promise.resolve({ ready: true }));
    const close = vi.fn(() => Promise.resolve());
    const adapterSource: ProductionAdapterSource = {
      kind: "adapter_source",
      adapters: createFixtureAdapters(),
      health,
      close,
    };
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "t0-v1",
      adapterSource,
    });

    await usingComposition(composition, async () => {
      expect(composition.definitions.map(({ name }) => name)).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "system.agent_context.get",
      ]);
      expect(Object.keys(composition.adapters)).toEqual([]);
      expect((await composition.readiness()).reasons).toContain(
        "production_non_t0_adapter_configured",
      );
      expect(health).not.toHaveBeenCalled();
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("treats production quote absence as a directory boundary, not an unavailable handler", async () => {
    const composition = createProductionComposition({ dataMode: "production" });
    await usingComposition(composition, () => {
      expect(composition.definitions.some(
        ({ name }) => name === "quote.canada_final_mile.calculate",
      )).toBe(false);
      expect(Object.hasOwn(composition.handlers, "quote.canada_final_mile.calculate")).toBe(false);
      expect(Object.hasOwn(composition.contracts, "quote.canada_final_mile.calculate")).toBe(false);
      expect(Object.keys(composition.adapters)).toEqual([]);
    });
  });

  it("rejects even a malformed non-T0 adapter source without inspecting or invoking it", async () => {
    const health = vi.fn(() => Promise.resolve({ ready: true }));
    const close = vi.fn(() => Promise.resolve());
    const malformedSource = {
      kind: "adapter_source",
      health,
      close,
    } as unknown as ProductionAdapterSource;
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "t0-v1",
      adapterSource: malformedSource,
    });

    await usingComposition(composition, async () => {
      const readiness = await composition.readiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.reasons).toContain("production_non_t0_adapter_configured");
      expect(health).not.toHaveBeenCalled();

      const response = await composition.handler(
        new Request("https://mcp.example.invalid/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "unavailable" });
    });
    expect(close).not.toHaveBeenCalled();
  });
});
