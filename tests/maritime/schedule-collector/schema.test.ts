import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

function readSchema(name: string): object {
  return JSON.parse(
    readFileSync(
      resolve(
        "services",
        "maritime",
        "schedule-collector",
        "contracts",
        name,
      ),
      "utf8",
    ),
  ) as object;
}

describe("collector Draft 2020-12 schemas", () => {
  it("compiles the query and result schemas and rejects unknown data", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const query = readSchema("collector-query.schema.json");
    const result = readSchema("collector-result.schema.json");
    const validateQuery = ajv.compile(query);
    const validateResult = ajv.compile(result);
    const validQuery = {
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
    expect(validateQuery(validQuery)).toBe(true);
    expect(validateQuery({ ...validQuery, carrier: "EMC" })).toBe(true);
    expect(validateQuery({ ...validQuery, unexpected: true })).toBe(false);

    const validResult = {
      collector_contract_version: "ocean-schedule-collector@2026-09-17.v1",
      run_status: "no_results",
      query: {
        carrier: "OOCL",
        query_origin: {
          input_text: "Shanghai",
          country_code: "CN",
          carrier_location_id: "origin",
          mapping_source: "fixture@1",
          source_full_name: null,
        },
        query_destination: {
          input_text: "Toronto",
          country_code: "CA",
          carrier_location_id: "destination",
          mapping_source: "fixture@1",
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
          {
            from: "2026-09-17",
            until: "2026-10-28",
          },
        ],
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
        source_refs: [
          "evidence:request:OOCL:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
      },
      quality: {
        key_fields_complete: true,
        evaluation_status: "evaluated",
        conflicts: [],
        warnings: [],
        missing_field_count: 0,
      },
    };
    expect(validateResult(validResult)).toBe(true);
    expect(validateResult({ ...validResult, unexpected: true })).toBe(false);
  });
});
