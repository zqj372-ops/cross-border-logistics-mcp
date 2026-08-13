import { afterAll, beforeAll, describe, expect, it } from "vitest";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";

import {
  createFixtureComposition,
} from "../../src/logistics_mcp/server/composition";
import {
  executeRegisteredTool,
  registerPhaseOneTools,
  type DomainToolOutcome,
  type ToolContract,
  type ToolDefinition,
} from "../../src/logistics_mcp/server/tool-registry";
import {
  quoteV2InputSchema,
  quoteV2ResultSchema,
} from "../../src/logistics_mcp/adapters/quote/quote-api-adapter";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import type {
  CalculationStep,
  SourceRef,
} from "../../src/logistics_mcp/platform/envelope";

const QUOTE_TOOL = "quote.canada_final_mile.calculate" as const;
const SOURCE_ID = `src:quote:snapshot:${"a".repeat(64)}`;
const OTHER_SOURCE_ID = "src:quote:snapshot:other";

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
  });
}

function fee(amount: string): { amount: string; currency: string } {
  return { amount, currency: "USD" };
}

function quoteData(
  quoteStatus: "calculated" | "manual_review" | "not_calculable" = "calculated",
): Record<string, unknown> {
  return quoteV2ResultSchema.parse({
    version: "quote-result@2026-08-13.v2",
    quote_id: "preview:quote:001",
    quote_status: quoteStatus,
    currency: "USD",
    total: quoteStatus === "calculated" ? fee("115.00") : null,
    line_items:
      quoteStatus === "calculated"
        ? [
            {
              line_id: "line:base",
              label: "Base",
              amount: fee("100.00"),
              pricing_basis: "zone",
              source_ref_ids: [SOURCE_ID],
            },
            {
              line_id: "line:fuel",
              label: "Fuel",
              amount: fee("15.00"),
              pricing_basis: "fuel",
              source_ref_ids: [SOURCE_ID],
            },
          ]
        : [],
    billing_pallets: quoteStatus === "calculated" ? 2 : null,
    rule_version: "zone-rules-20260728",
    data_version: "zone-data-20260728",
    sendable: false,
    valid_from: "2026-07-28",
    valid_to: "2026-12-31",
    source_ref_ids: [SOURCE_ID],
    tenant: context.tenantId,
    effective_date: "2026-08-12",
    ready: true,
    test_data: false,
    origin: "toronto",
    snapshot_hash: `sha256:${"a".repeat(64)}`,
    service_version: "quote-service@fixture-1",
    contract_version: "quote-zone.v2",
    release_id: "release-20260812-a",
    release_hash: `sha256:${"a".repeat(64)}`,
    published_at: "2026-08-12T10:00:00Z",
  });
}

function sourceRef(sourceId: string, suffix = "source"): SourceRef {
  return {
    source_id: sourceId,
    source_type: "internal_system",
    system: "quote-service",
    locator: `opaque://quote/${suffix}`,
    version: "quote-service@fixture-1",
    retrieved_at: "2026-08-12T10:00:00Z",
    authority: "authoritative",
    content_hash: null,
  };
}

function trace(sourceIds: readonly string[] = [SOURCE_ID]): CalculationStep {
  return {
    step_id: "step:quote:preview:upstream",
    operation: "use upstream quote preview result",
    inputs: [{ name: "quote_status", value: "calculated" }],
    result: fee("115.00"),
    source_ref_ids: sourceIds,
    rounding: null,
  };
}

function blocker() {
  return {
    code: "quote.manual_review",
    message: "Manual review is required.",
    severity: "error" as const,
  };
}

function outcome(
  status: DomainToolOutcome["status"],
  data: Record<string, unknown> | null,
  options: {
    readonly sourceRefs?: readonly SourceRef[];
    readonly calculationTrace?: readonly CalculationStep[];
    readonly blockers?: readonly ReturnType<typeof blocker>[];
  } = {},
): DomainToolOutcome {
  return {
    status,
    data,
    ...(options.sourceRefs === undefined ? {} : { sourceRefs: options.sourceRefs }),
    ...(options.calculationTrace === undefined
      ? {}
      : { calculationTrace: options.calculationTrace }),
    ...(options.blockers === undefined ? {} : { blockers: options.blockers }),
    ...(status === "manual_review" ? { reviewStatus: "manual_review" as const } : {}),
  };
}

let quoteContract: ToolContract;
let compositionDefinitions: readonly ToolDefinition[];
let closeComposition: (() => Promise<void>) | undefined;

beforeAll(() => {
  const composition = createFixtureComposition({ dataMode: "fixtures" });
  quoteContract = composition.contracts[QUOTE_TOOL]!;
  compositionDefinitions = composition.definitions;
  closeComposition = composition.close;
});

afterAll(async () => {
  await closeComposition?.();
});

function definitionFor(result: DomainToolOutcome): ToolDefinition {
  return registerPhaseOneTools(
    { [QUOTE_TOOL]: () => result },
    { [QUOTE_TOOL]: quoteContract },
  ).find((definition) => definition.name === QUOTE_TOOL)!;
}

async function execute(result: DomainToolOutcome) {
  return executeRegisteredTool(definitionFor(result), quoteInput(), context, {
    requestId: "req_quote_v2_001",
    auditId: "audit_quote_v2_001",
  });
}

describe("quote v2 runtime envelope contract", () => {
  it("registers v2 input/output IDs and schemas without changing the other eight IDs", () => {
    const definitions = compositionDefinitions;
    const quote = definitions.find((definition) => definition.name === QUOTE_TOOL)!;

    expect(quote.inputSchemaId).toBe(
      "urn:logistics-mcp:quote.canada_final_mile.calculate:2026-08-13.v2",
    );
    expect(quote.outputSchemaId).toBe("quote-envelope-v2.schema.json");
    expect(quoteContract.inputSchema).toBe(quoteV2InputSchema);
    expect(quote.outputSchema).toBe(quoteContract.outputSchema);
    expect(quoteV2ResultSchema.safeParse(quoteData()).success).toBe(true);

    const unchanged = {
      "knowledge.search_curated": "knowledge-search-result.schema.json",
      "system.get_data_status": "data-status.schema.json",
      "cargo.calculate": "cargo-result.schema.json",
      "container.plan_summary": "container-plan.schema.json",
      "customs.ca.search": "customs-search-result.schema.json",
      "customs.ca.estimate": "customs-assessment.schema.json",
      "quote.save_draft": "write-result.schema.json",
      "review.create_task": "write-result.schema.json",
    } as const;
    for (const [name, outputSchemaId] of Object.entries(unchanged)) {
      const definition = definitions.find((candidate) => candidate.name === name)!;
      expect(definition.inputSchemaId).toBe(`urn:logistics-mcp:${name}:2026-08-11.v1`);
      expect(definition.outputSchemaId).toBe(outputSchemaId);
    }
  });

  it("executes calculated success with matching source and trace evidence", async () => {
    const result = await execute(
      outcome("success", quoteData(), {
        sourceRefs: [sourceRef(SOURCE_ID)],
        calculationTrace: [trace()],
      }),
    );

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({ quote_status: "calculated" });
    expect(result.source_refs.map((source) => source.source_id)).toEqual([SOURCE_ID]);
    expect(result.calculation_trace[0]?.source_ref_ids).toEqual([SOURCE_ID]);
  });

  it("exposes structural v2 branches to Draft 2020-12 validators", () => {
    const outputJsonSchema = quoteContract.outputSchema!.toJSONSchema({ target: "draft-2020-12" });
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validator = ajv.compile(outputJsonSchema);
    const valid = {
      schema_version: "2026-08-11.v1",
      request_id: "req_schema_001",
      status: "success",
      data: quoteData(),
      source_refs: [sourceRef(SOURCE_ID)],
      assumptions: [],
      warnings: [],
      blockers: [],
      calculation_trace: [{ ...trace(), source_ref_ids: [] }],
      review_status: "not_required",
      audit_id: "audit_schema_001",
    };

    expect(() => quoteContract.outputSchema!.parse(valid)).not.toThrow();
    expect(validator(valid), JSON.stringify(validator.errors)).toBe(true);
    expect(outputJsonSchema.anyOf ?? outputJsonSchema.oneOf).toBeDefined();
    expect(
      validator({
        ...valid,
        data: quoteData("manual_review"),
      }),
    ).toBe(false);
    expect(
      validator({
        ...valid,
        status: "manual_review",
        blockers: [blocker()],
      }),
    ).toBe(false);
    expect(
      validator({
        ...valid,
        status: "unavailable",
        data: quoteData(),
      }),
    ).toBe(false);
  });

  it("executes manual review with v2 manual data and evidence", async () => {
    const result = await execute(
      outcome("manual_review", quoteData("manual_review"), {
        sourceRefs: [sourceRef(SOURCE_ID)],
        blockers: [blocker()],
      }),
    );

    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({ quote_status: "manual_review" });
    expect(result.calculation_trace).toEqual([]);
  });

  it("executes zero-call manual review and unavailable outcomes with empty evidence", async () => {
    await expect(
      execute(outcome("manual_review", null, { blockers: [blocker()] })),
    ).resolves.toMatchObject({
      status: "manual_review",
      data: null,
      source_refs: [],
      calculation_trace: [],
    });

    await expect(
      execute(
        outcome("unavailable", null, {
          blockers: [blocker()],
        }),
      ),
    ).resolves.toMatchObject({
      status: "unavailable",
      data: null,
      source_refs: [],
      calculation_trace: [],
    });
  });

  it("rejects wrong status, empty evidence, and non-empty evidence for empty outcomes", async () => {
    await expect(
      execute(
        outcome("success", quoteData("manual_review"), {
          sourceRefs: [sourceRef(SOURCE_ID)],
          calculationTrace: [trace()],
        }),
      ),
    ).rejects.toThrow();

    await expect(
      execute(outcome("success", quoteData(), { sourceRefs: [], calculationTrace: [] })),
    ).rejects.toThrow();

    await expect(
      execute(outcome("manual_review", quoteData("manual_review"), { blockers: [blocker()] })),
    ).rejects.toThrow();

    await expect(
      execute(
        outcome("manual_review", null, {
          sourceRefs: [sourceRef(SOURCE_ID)],
          calculationTrace: [trace()],
          blockers: [blocker()],
        }),
      ),
    ).rejects.toThrow();

    for (const status of ["needs_input", "blocked", "unavailable"] as const) {
      await expect(
        execute(
          outcome(status, quoteData(), {
            sourceRefs: [sourceRef(SOURCE_ID)],
            calculationTrace: [trace()],
            blockers: [blocker()],
          }),
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects a source ID union that differs from the outer refs or contains duplicates", async () => {
    await expect(
      execute(
        outcome("success", quoteData(), {
          sourceRefs: [sourceRef(SOURCE_ID)],
          calculationTrace: [trace([OTHER_SOURCE_ID])],
        }),
      ),
    ).rejects.toThrow();

    await expect(
      execute(
        outcome("success", quoteData(), {
          sourceRefs: [sourceRef(SOURCE_ID, "first"), sourceRef(SOURCE_ID, "second")],
          calculationTrace: [trace()],
        }),
      ),
    ).rejects.toThrow();

    await expect(
      execute(
        outcome("success", quoteData(), {
          sourceRefs: [sourceRef(SOURCE_ID)],
          calculationTrace: [trace([SOURCE_ID, SOURCE_ID])],
        }),
      ),
    ).rejects.toThrow();
  });
});
