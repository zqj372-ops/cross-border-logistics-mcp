import { describe, expect, it } from "vitest";

import {
  NormalizedCollectorQuerySchema,
  ResolvedLocationSchema,
} from "../../../../services/maritime/schedule-collector/contracts";
import { parseOoclScheduleResponse } from "../../../../services/maritime/schedule-collector/carriers/oocl";
import { syntheticOoclScheduleResponse } from "../../../../services/maritime/schedule-collector/fixtures/synthetic-oocl";

describe("OOCL schedule parser", () => {
  it("parses the observed standardRoutes shape without converting a rail or door leg into ocean routing", () => {
    const result = parseOoclScheduleResponse(syntheticOoclScheduleResponse, {
      requestId: "request_synthetic_oocl",
      normalizedQuery: NormalizedCollectorQuerySchema.parse({
        carrier: "OOCL",
        query_origin: {
          input_text: "上海",
          country_code: "CN",
          carrier_location_id: "synthetic-oocl-shanghai",
          mapping_source: "synthetic_fixture",
        },
        query_destination: {
          input_text: "Toronto",
          country_code: "CA",
          carrier_location_id: "synthetic-oocl-toronto-ca",
          mapping_source: "synthetic_fixture",
        },
        departure_from: "2026-09-17",
        departure_until: "2026-10-28",
        date_filter_basis: "departure_from_first_ocean_leg",
        routing_filter: "any",
      }),
      origin: ResolvedLocationSchema.parse({
        input_text: "上海",
        name: "Shanghai",
        country_code: "CN",
        type: "city",
        carrier_location_id: "synthetic-oocl-shanghai",
        mapping_source: "synthetic_fixture",
        unlocode: null,
      }),
      destination: ResolvedLocationSchema.parse({
        input_text: "Toronto",
        name: "Toronto",
        country_code: "CA",
        type: "city",
        carrier_location_id: "synthetic-oocl-toronto-ca",
        mapping_source: "synthetic_fixture",
        unlocode: null,
      }),
      evidenceRef: "evidence:request_synthetic_oocl:OOCL:sha256:fixture",
      observedAt: "2026-09-17T00:00:00Z",
    });

    expect(result.coverage.complete).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      source_itinerary_id: "9000000001",
      routing: "transshipment",
      service_name: null,
      transit: {
        source_total_minutes: "1710",
        source_total_hours: "28.5",
      },
    });
    expect(result.records[0]?.legs.map((leg) => leg.mode)).toEqual([
      "ocean",
      "ocean",
      "unknown",
    ]);
    expect(result.records[0]?.legs[0]?.events[0]).toMatchObject({
      local_date: "2026-09-18",
      local_datetime: "2026-09-18T03:30:00.000",
      utc_datetime: "2026-09-17T19:30:00.000Z",
      precision: "local_datetime",
    });
  });
});
