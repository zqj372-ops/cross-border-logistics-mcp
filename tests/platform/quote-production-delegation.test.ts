import { describe, expect, it, vi } from "vitest";

import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";
import type { AdapterResult, QuoteAdapter } from "../../src/logistics_mcp/adapters/ports";
import {
  quoteV2InputSchema,
  quoteV2ResultSchema,
} from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context";
import type { CalculationStep, SourceRef } from "../../src/logistics_mcp/platform/envelope";
import { executeRegisteredTool } from "../../src/logistics_mcp/server/tool-registry";
import {
  createProductionComposition,
  type ProductionAdapterSource,
} from "../../src/logistics_mcp/server/composition";

const SOURCE_ID = `src:quote:snapshot:${"a".repeat(64)}`;
const context = parseExecutionContext({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate", "quote:draft_write"],
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

function sourceRef(): SourceRef {
  return {
    source_id: SOURCE_ID,
    source_type: "internal_system",
    system: "quote-service",
    locator: "opaque://quote/delegation-test",
    version: "quote-service@delegation-test",
    retrieved_at: "2026-08-13T00:00:00Z",
    authority: "authoritative",
    content_hash: null,
  };
}

function quoteData(): Record<string, unknown> {
  return quoteV2ResultSchema.parse({
    version: "quote-result@2026-08-13.v2",
    quote_id: "quote-delegation-001",
    quote_status: "calculated",
    currency: "USD",
    total: { amount: "115.00", currency: "USD" },
    line_items: [
      {
        line_id: "line:base",
        label: "Base",
        amount: { amount: "100.00", currency: "USD" },
        pricing_basis: "delegated quote source",
        source_ref_ids: [SOURCE_ID],
      },
      {
        line_id: "line:fuel",
        label: "Fuel",
        amount: { amount: "15.00", currency: "USD" },
        pricing_basis: "delegated quote source",
        source_ref_ids: [SOURCE_ID],
      },
    ],
    billing_pallets: 2,
    rule_version: "quote-rule@delegation-test",
    data_version: "quote-data@delegation-test",
    sendable: false,
    valid_from: "2026-08-01",
    valid_to: "2026-08-31",
    source_ref_ids: [SOURCE_ID],
    tenant: context.tenantId,
    effective_date: "2026-08-13",
    ready: true,
    test_data: false,
    origin: "toronto",
    snapshot_hash: `sha256:${"a".repeat(64)}`,
    service_version: "quote-service@delegation-test",
    contract_version: "quote-zone.v2",
    release_id: "quote-release-delegation-test",
    release_hash: `sha256:${"a".repeat(64)}`,
    published_at: "2026-08-13T00:00:00Z",
  });
}

function calculationTrace(): CalculationStep {
  return {
    step_id: "step:quote:delegation",
    operation: "delegate quote calculation",
    inputs: [{ name: "quote_request", value: "opaque://quote/request" }],
    result: { amount: "115.00", currency: "USD" },
    source_ref_ids: [SOURCE_ID],
    rounding: null,
  };
}

function quoteOutcome(): AdapterResult {
  return {
    status: "success",
    data: quoteData(),
    sourceRefs: [sourceRef()],
    calculationTrace: [calculationTrace()],
  };
}

function productionSource(quote: QuoteAdapter): ProductionAdapterSource {
  return {
    kind: "adapter_source",
    adapters: { ...createFixtureAdapters(), quote },
    health: () => Promise.resolve({ ready: true }),
    close: () => Promise.resolve(),
  };
}

function draftInput(operationMode: "preview" | "commit"): Record<string, unknown> {
  return {
    schema_version: "2026-08-11.v1",
    version: "quote-save@delegation-test",
    quote_result: {
      version: "quote-result@fixture-1",
      quote_id: "quote-delegation-001",
      quote_status: "calculated",
      currency: "USD",
      total: { amount: "115.00", currency: "USD" },
      line_items: [{
        line_id: "line:base",
        label: "Base",
        amount: { amount: "115.00", currency: "USD" },
        pricing_basis: "delegation test",
        source_ref_ids: ["src_quote_delegation_test"],
      }],
      rule_version: "quote-rule@fixture-1",
      data_version: "quote-data@fixture-1",
      sendable: false,
      valid_from: null,
      valid_to: null,
      source_ref_ids: ["src_quote_delegation_test"],
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
      idempotency_key: `idem_quote_delegation_${operationMode}`,
      operation_mode: operationMode,
      preview_ref: operationMode === "preview" ? null : "preview:quote:delegation",
      approval: { required: false, status: "not_required", approval_id: null },
    },
  };
}

function fakeQuote() {
  const calculate = vi.fn((
    input: Record<string, unknown>,
    executionContext?: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<AdapterResult> => {
    void input;
    void executionContext;
    void signal;
    return Promise.resolve(quoteOutcome());
  });
  const reject = () => Promise.reject<AdapterResult>(
    new Error("injected quote write must not be called"),
  );
  const previewDraft = vi.fn(reject);
  const commitDraft = vi.fn(reject);
  const readDraft = vi.fn(reject);
  return {
    adapter: { calculate, previewDraft, commitDraft, readDraft },
    calculate,
    previewDraft,
    commitDraft,
    readDraft,
  };
}

async function usingComposition<T>(
  composition: { close: () => Promise<void> },
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } finally {
    await composition.close();
  }
}

describe("production quote delegation", () => {
  it("delegates calculate context and signal while keeping quote writes disabled", async () => {
    const fake = fakeQuote();
    const composition = createProductionComposition({
      dataMode: "production",
      adapterSource: productionSource(fake.adapter),
    });
    const signal = new AbortController().signal;

    await usingComposition(composition, async () => {
      const result = await composition.adapters.quote.calculate(
        quoteInput(),
        context,
        signal,
      );
      expect(result.status).toBe("success");
      expect(fake.calculate).toHaveBeenCalledWith(quoteInput(), context, signal);

      const writes = await Promise.all([
        composition.adapters.quote.previewDraft(draftInput("preview")),
        composition.adapters.quote.commitDraft(draftInput("commit")),
        composition.adapters.quote.readDraft({ record_id: "draft-delegation-001" }),
      ]);
      for (const write of writes) {
        expect(write.data).toMatchObject({
          version: "write-result@2026-08-11.v1",
          operation: "quote.save_draft",
          operation_status: "rejected",
          readback_evidence: null,
        });
        expect(write.blockers?.map(({ code }) => code)).toContain(
          "quote.adapter_disabled",
        );
      }
      expect(fake.previewDraft).not.toHaveBeenCalled();
      expect(fake.commitDraft).not.toHaveBeenCalled();
      expect(fake.readDraft).not.toHaveBeenCalled();
    });
  });

  it("executes the registered production quote definition as v2", async () => {
    const fake = fakeQuote();
    const composition = createProductionComposition({
      dataMode: "production",
      adapterSource: productionSource(fake.adapter),
    });

    await usingComposition(composition, async () => {
      const definition = composition.definitions.find(
        ({ name }) => name === "quote.canada_final_mile.calculate",
      );
      if (definition === undefined) throw new Error("quote definition missing");
      const envelope = await executeRegisteredTool(
        definition,
        quoteInput(),
        context,
        {
          requestId: "request_quote_delegation_001",
          auditId: "audit_quote_delegation_001",
        },
      );
      expect(envelope).toMatchObject({
        status: "success",
        data: { quote_status: "calculated" },
      });
      expect(envelope.source_refs.map(({ source_id }) => source_id)).toEqual([
        SOURCE_ID,
      ]);
    });
  });

  it("keeps the default production quote unavailable", async () => {
    const composition = createProductionComposition({ dataMode: "production" });
    await usingComposition(composition, async () => {
      const result = await composition.adapters.quote.calculate(
        quoteInput(),
        context,
      );
      expect(result).toMatchObject({ status: "unavailable", data: null });
      expect(result.blockers?.map(({ code }) => code)).toContain(
        "quote.adapter_disabled",
      );
    });
  });

  it("fails closed for an adapter source with missing adapters", async () => {
    const malformedSource = {
      kind: "adapter_source",
      health: () => Promise.resolve({ ready: true }),
      close: () => Promise.resolve(),
    } as unknown as ProductionAdapterSource;

    const composition = createProductionComposition({
      dataMode: "production",
      adapterSource: malformedSource,
    });

    await usingComposition(composition, async () => {
      await expect(composition.readiness()).resolves.toMatchObject({ ready: false });
      const readiness = await composition.readiness();
      expect(readiness.reasons).toContain("production_adapter_source_invalid");

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
  });
});
