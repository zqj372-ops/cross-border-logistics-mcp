import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createEnvelope } from "../../../src/logistics_mcp/platform/envelope";
import { validateEnvelope } from "../../../src/logistics_mcp/platform/envelope";
import {
  CollectorResultDataSchema,
  type CollectorResultData,
} from "../../../services/maritime/schedule-collector/contracts";
import {
  ScheduleLiveCarriersEnvelopeSchema,
  ScheduleLiveLocationsEnvelopeSchema,
  ScheduleLiveSearchEnvelopeSchema,
  ScheduleLiveSearchRequestSchema,
  parseScheduleLiveCarriersEnvelope,
  parseScheduleLiveLocationsEnvelope,
  parseScheduleLiveSearchEnvelope,
  scheduleLiveJsonSchema,
} from "../../../services/maritime/schedule-live/contracts";

const blocker = {
  code: "timeout",
  message: "collector_deadline_exceeded",
  severity: "error" as const,
};

function envelope(status: Parameters<typeof createEnvelope>[0]["status"], data: Record<string, unknown> | null, blockers: readonly typeof blocker[] = []) {
  return createEnvelope({
    requestId: "req_schedule_live_contract",
    auditId: "schedule-live-audit-contract",
    status,
    data,
    blockers,
    reviewStatus: status === "manual_review" ? "manual_review" : status === "needs_input" ? "pending" : "not_required",
  });
}

const liveNoResults: CollectorResultData = CollectorResultDataSchema.parse({
  collector_contract_version: "ocean-schedule-collector@2026-09-17.v1",
  run_status: "no_results",
  query: {
    carrier: "ONE",
    query_origin: {
      input_text: "Shanghai",
      country_code: "CN",
      carrier_location_id: "CNSHA",
      mapping_source: "one_point_to_point_search",
      source_full_name: "SHANGHAI, SHANGHAI, CHINA",
    },
    query_destination: {
      input_text: "Vancouver",
      country_code: "CA",
      carrier_location_id: "CAVAN",
      mapping_source: "one_point_to_point_search",
      source_full_name: "VANCOUVER, BC, CANADA",
    },
    departure_from: "2026-09-18",
    departure_until: "2026-10-15",
    date_filter_basis: "departure_from_first_ocean_leg",
    routing_filter: "any",
  },
  carrier: {
    id: "ONE",
    sales_carrier: "Ocean Network Express",
    adapter_version: "one-schedule-parser@1",
    capability_status: "live_verified",
    last_live_verified_at: "2026-09-17T10:26:31Z",
  },
  records: [],
  coverage: {
    requested_from: "2026-09-18",
    requested_until: "2026-10-15",
    covered_windows: [{ from: "2026-09-18", until: "2026-10-15" }],
    uncovered_windows: [],
    pages_read: [1],
    complete: true,
    truncated: false,
    failure_reason: null,
  },
  provenance: {
    kind: "live",
    fetched_at: "2026-09-18T00:00:00Z",
    fixture_generated_at: null,
    source_updated_at: null,
    parser_version: "one-schedule-parser@1",
    source_refs: [`evidence:req_schedule_live_contract:ONE:sha256:${"a".repeat(64)}`],
  },
  quality: {
    key_fields_complete: true,
    evaluation_status: "evaluated",
    conflicts: [],
    warnings: [],
    missing_field_count: 0,
  },
});

const partialLive: CollectorResultData = CollectorResultDataSchema.parse({
  ...liveNoResults,
  run_status: "partial",
  coverage: {
    ...liveNoResults.coverage,
    covered_windows: [{ from: "2026-09-18", until: "2026-10-01" }],
    uncovered_windows: [{ from: "2026-10-02", until: "2026-10-15" }],
    complete: false,
    failure_reason: "collector_deadline_exceeded",
  },
});

const syntheticPartial: CollectorResultData = CollectorResultDataSchema.parse({
  ...partialLive,
  provenance: {
    ...partialLive.provenance,
    kind: "synthetic",
    fetched_at: null,
    fixture_generated_at: "2026-09-18T00:00:00Z",
  },
});

const candidate = {
  name: "SHANGHAI, SHANGHAI, CHINA",
  country_code: "CN",
  type: "city" as const,
  carrier_location_id: "CNSHA",
  mapping_source: "one_point_to_point_search",
  source_full_name: "SHANGHAI, SHANGHAI, CHINA",
  unlocode: null,
};

describe("schedule live envelope contracts", () => {
  it("accepts the real failure branches with data=null and blockers", () => {
    const unavailable = envelope("unavailable", null, [blocker]);
    expect(ScheduleLiveCarriersEnvelopeSchema.safeParse(unavailable).success).toBe(true);
    expect(ScheduleLiveLocationsEnvelopeSchema.safeParse(unavailable).success).toBe(true);
    expect(ScheduleLiveSearchEnvelopeSchema.safeParse(unavailable).success).toBe(true);
    expect(
      ScheduleLiveLocationsEnvelopeSchema.safeParse(
        envelope("blocked", null, [{ code: "schedule_live_disabled", message: "schedule_live_disabled", severity: "error" }]),
      ).success,
    ).toBe(true);
  });

  it("accepts multi-candidate and unique-match location outcomes", () => {
    const multiple = envelope("needs_input", {
      carrier: "ONE",
      query: "Shanghai",
      candidates: [
        candidate,
        {
          ...candidate,
          name: "SHANGHAI YANGSHAN, SHANGHAI, CHINA",
          carrier_location_id: "CNSHY",
          source_full_name: "SHANGHAI YANGSHAN, SHANGHAI, CHINA",
        },
      ],
      resolved: null,
    }, [{
      code: "ambiguous_location",
      message: "Multiple carrier locations match; select a carrier_location_id.",
      severity: "error",
    }]);
    expect(ScheduleLiveLocationsEnvelopeSchema.safeParse(multiple).success).toBe(true);

    const unique = envelope("success", {
      carrier: "ONE",
      query: "Shanghai",
      candidates: [candidate],
      resolved: {
        input_text: "Shanghai",
        name: candidate.name,
        country_code: "CN",
        type: "city",
        carrier_location_id: "CNSHA",
        mapping_source: "one_point_to_point_search",
        source_full_name: candidate.source_full_name,
        unlocode: null,
      },
    });
    expect(ScheduleLiveLocationsEnvelopeSchema.safeParse(unique).success).toBe(true);
  });

  it("keeps partial and no-result search semantics honest", () => {
    expect(
      ScheduleLiveSearchEnvelopeSchema.safeParse(envelope("success", liveNoResults)).success,
    ).toBe(true);
    expect(
      ScheduleLiveSearchEnvelopeSchema.safeParse(
        envelope("manual_review", partialLive, [{ code: "incomplete_results", message: "incomplete_results", severity: "error" }]),
      ).success,
    ).toBe(true);
    expect(
      ScheduleLiveSearchEnvelopeSchema.safeParse(envelope("success", partialLive)).success,
    ).toBe(false);
    expect(
      ScheduleLiveSearchEnvelopeSchema.safeParse(
        envelope("manual_review", syntheticPartial, [{ code: "synthetic_data", message: "synthetic_data", severity: "error" }]),
      ).success,
    ).toBe(true);
    expect(
      ScheduleLiveSearchEnvelopeSchema.safeParse(envelope("success", syntheticPartial)).success,
    ).toBe(false);
  });

  it("rejects success without required data", () => {
    expect(ScheduleLiveCarriersEnvelopeSchema.safeParse(envelope("success", null)).success).toBe(false);
    expect(ScheduleLiveLocationsEnvelopeSchema.safeParse(envelope("success", null)).success).toBe(false);
    expect(ScheduleLiveSearchEnvelopeSchema.safeParse(envelope("success", null)).success).toBe(false);
  });

  it("runs the shared envelope invariant inside every formal parser", () => {
    const broken = {
      ...envelope("unavailable", null, [blocker]),
      blockers: [],
    } as unknown;
    expect(() => validateEnvelope(broken)).toThrow();
    expect(() => parseScheduleLiveCarriersEnvelope(broken)).toThrow(
      "schedule_live_carriers_response_invalid",
    );
    expect(() => parseScheduleLiveLocationsEnvelope(broken)).toThrow(
      "schedule_live_location_response_invalid",
    );
    expect(() => parseScheduleLiveSearchEnvelope(broken)).toThrow(
      "schedule_live_search_response_invalid",
    );
  });
});

describe("schedule live Draft 2020-12 projection", () => {
  it("exports the search wire input without transforms", () => {
    const schema = z.toJSONSchema(ScheduleLiveSearchRequestSchema, {
      target: "draft-2020-12",
    });
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(schema)).toContain("ONE");
    expect(JSON.stringify(schema)).not.toContain("FAKE");
  });

  it("exports every tool schema and compiles with Ajv 2020", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const schemas = [
      scheduleLiveJsonSchema(ScheduleLiveSearchRequestSchema),
      scheduleLiveJsonSchema(ScheduleLiveCarriersEnvelopeSchema),
      scheduleLiveJsonSchema(ScheduleLiveLocationsEnvelopeSchema),
      scheduleLiveJsonSchema(ScheduleLiveSearchEnvelopeSchema),
    ];
    for (const schema of schemas) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(ajv.compile(schema)).toBeTypeOf("function");
    }
    const validateSearch = ajv.compile(schemas[0]!);
    expect(
      validateSearch({
        carrier: "ONE",
        origin: { text: "Shanghai", country_code: "CN", carrier_location_id: "CNSHA" },
        destination: { text: "Vancouver", country_code: "CA", carrier_location_id: "CAVAN" },
        from: "2026-09-18",
        until: "2026-10-15",
        routing: "any",
      }),
    ).toBe(true);
    expect(
      validateSearch({
        carrier: "FAKE",
        origin: { text: "Shanghai", country_code: "CN", carrier_location_id: null },
        destination: { text: "Vancouver", country_code: "CA", carrier_location_id: null },
        from: "2026-09-18",
        until: "2026-10-15",
        routing: "any",
        tenant_id: "tenant_override",
      }),
    ).toBe(false);
    expect(
      validateSearch({
        carrier: "ONE",
        origin: { text: "Shanghai", country_code: "CN", carrier_location_id: "CNSHA" },
        destination: { text: "Vancouver", country_code: "CA", carrier_location_id: "CAVAN" },
        from: "2026-99-99",
        until: "2026-10-15",
        routing: "any",
      }),
    ).toBe(false);
  });
});
