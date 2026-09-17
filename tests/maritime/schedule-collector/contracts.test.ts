import { describe, expect, it } from "vitest";

import {
  CollectorQueryInputSchema,
  parseCollectorQueryInput,
  parseCollectorResultData,
} from "../../../services/maritime/schedule-collector/contracts";

describe("schedule collector contracts", () => {
  it("accepts a closed query and rejects injected transport or identity fields", () => {
    const valid = {
      carrier: "COSCO",
      origin: {
        text: "上海",
        country_code: "CN",
        carrier_location_id: null,
      },
      destination: {
        text: "温哥华",
        country_code: "CA",
        carrier_location_id: null,
      },
      from: "2026-09-17",
      until: "2026-10-28",
      routing: "any",
    };

    expect(parseCollectorQueryInput(valid)).toMatchObject(valid);
    expect(() =>
      parseCollectorQueryInput({ ...valid, evidence_path: "/tmp/evidence" }),
    ).toThrow();
    expect(() =>
      parseCollectorQueryInput({ ...valid, base_url: "https://example.invalid" }),
    ).toThrow();
    expect(() => parseCollectorQueryInput({ ...valid, tenant_id: "tenant" })).toThrow();
  });

  it("keeps synthetic result data closed and separate from the envelope version", () => {
    const input = {
      collector_contract_version: "ocean-schedule-collector@2026-09-17.v1",
      run_status: "partial",
      query: {
        carrier: "COSCO",
        query_origin: {
          input_text: "上海",
          country_code: "CN",
          carrier_location_id: "synthetic-origin",
          mapping_source: "synthetic_fixture",
          source_full_name: null,
        },
        query_destination: {
          input_text: "温哥华",
          country_code: "CA",
          carrier_location_id: "synthetic-destination",
          mapping_source: "synthetic_fixture",
          source_full_name: null,
        },
        departure_from: "2026-09-17",
        departure_until: "2026-10-28",
        date_filter_basis: "departure_from_first_ocean_leg",
        routing_filter: "any",
      },
      carrier: {
        id: "COSCO",
        sales_carrier: "COSCO",
        adapter_version: "synthetic-fixture@0",
        capability_status: "synthetic_only",
      },
      records: [],
      coverage: {
        requested_from: "2026-09-17",
        requested_until: "2026-10-28",
        covered_windows: [],
        uncovered_windows: [],
        pages_read: [],
        complete: false,
        truncated: false,
        failure_reason: "synthetic_fixture_not_live",
      },
      provenance: {
        kind: "synthetic",
        fetched_at: null,
        fixture_generated_at: "2026-09-17T00:00:00Z",
        source_updated_at: null,
        parser_version: "synthetic-fixture@0",
        source_refs: ["source:synthetic-design-example"],
      },
      quality: {
        key_fields_complete: false,
        evaluation_status: "not_evaluated",
        conflicts: [],
        warnings: ["synthetic_data_not_for_validation"],
        missing_field_count: 0,
      },
    };

    expect(parseCollectorResultData(input).collector_contract_version).toBe(
      "ocean-schedule-collector@2026-09-17.v1",
    );
    expect(() =>
      parseCollectorResultData({ ...input, status: "success" }),
    ).toThrow();
  });

  it("rejects impossible calendar dates and inconsistent date precision", () => {
    const valid = {
      carrier: "OOCL",
      origin: { text: "Shanghai", country_code: "CN", carrier_location_id: null },
      destination: {
        text: "Toronto",
        country_code: "CA",
        carrier_location_id: null,
      },
      from: "2026-09-17",
      until: "2026-10-28",
      routing: "any",
    };
    expect(() => CollectorQueryInputSchema.parse({ ...valid, from: "2026-02-30" })).toThrow();
    expect(() =>
      CollectorQueryInputSchema.parse({ ...valid, until: "2026-12-16" }),
    ).toThrow();
  });

  it("models adjacent covered windows as one inclusive range and rejects a real gap", () => {
    const base = {
      collector_contract_version: "ocean-schedule-collector@2026-09-17.v1",
      run_status: "no_results",
      query: {
        carrier: "OOCL",
        query_origin: {
          input_text: "Shanghai",
          country_code: "CN",
          carrier_location_id: "origin",
          mapping_source: "fixture",
          source_full_name: null,
        },
        query_destination: {
          input_text: "Toronto",
          country_code: "CA",
          carrier_location_id: "destination",
          mapping_source: "fixture",
          source_full_name: null,
        },
        departure_from: "2026-09-17",
        departure_until: "2026-10-28",
        date_filter_basis: "departure_from_first_ocean_leg",
        routing_filter: "any",
      },
      carrier: {
        id: "OOCL",
        sales_carrier: "OOCL",
        adapter_version: "fixture@1",
        capability_status: "implemented_unverified",
        last_live_verified_at: null,
      },
      records: [],
      coverage: {
        requested_from: "2026-09-17",
        requested_until: "2026-10-28",
        covered_windows: [
          { from: "2026-09-17", until: "2026-10-07" },
          { from: "2026-10-08", until: "2026-10-28" },
        ],
        uncovered_windows: [],
        pages_read: [1, 2],
        complete: true,
        truncated: false,
        failure_reason: null,
      },
      provenance: {
        kind: "live",
        fetched_at: "2026-09-17T00:00:00Z",
        fixture_generated_at: null,
        source_updated_at: null,
        parser_version: "fixture@1",
        source_refs: ["evidence:request:OOCL:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      },
      quality: {
        key_fields_complete: true,
        evaluation_status: "evaluated",
        conflicts: [],
        warnings: [],
        missing_field_count: 0,
      },
    };
    expect(parseCollectorResultData(base).coverage.complete).toBe(true);
    expect(() =>
      parseCollectorResultData({
        ...base,
        coverage: {
          ...base.coverage,
          covered_windows: [
            { from: "2026-09-17", until: "2026-10-07" },
            { from: "2026-10-09", until: "2026-10-28" },
          ],
        },
      }),
    ).toThrow();
  });

  it("allows complete coverage with partial quality for manual review", () => {
    const base = {
      collector_contract_version: "ocean-schedule-collector@2026-09-17.v1",
      run_status: "partial",
      query: {
        carrier: "OOCL",
        query_origin: {
          input_text: "Shanghai",
          country_code: "CN",
          carrier_location_id: "origin",
          mapping_source: "fixture",
          source_full_name: null,
        },
        query_destination: {
          input_text: "Toronto",
          country_code: "CA",
          carrier_location_id: "destination",
          mapping_source: "fixture",
          source_full_name: null,
        },
        departure_from: "2026-09-17",
        departure_until: "2026-10-28",
        date_filter_basis: "departure_from_first_ocean_leg",
        routing_filter: "any",
      },
      carrier: {
        id: "OOCL",
        sales_carrier: "OOCL",
        adapter_version: "fixture@1",
        capability_status: "implemented_unverified",
        last_live_verified_at: null,
      },
      records: [],
      coverage: {
        requested_from: "2026-09-17",
        requested_until: "2026-10-28",
        covered_windows: [{ from: "2026-09-17", until: "2026-10-28" }],
        uncovered_windows: [],
        pages_read: [1],
        complete: true,
        truncated: false,
        failure_reason: null,
      },
      provenance: {
        kind: "live",
        fetched_at: "2026-09-17T00:00:00Z",
        fixture_generated_at: null,
        source_updated_at: null,
        parser_version: "fixture@1",
        source_refs: ["evidence:request:OOCL:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      },
      quality: {
        key_fields_complete: false,
        evaluation_status: "partial",
        conflicts: [],
        warnings: ["missing_fields"],
        missing_field_count: 1,
      },
    };
    expect(parseCollectorResultData(base).run_status).toBe("partial");
  });
});
