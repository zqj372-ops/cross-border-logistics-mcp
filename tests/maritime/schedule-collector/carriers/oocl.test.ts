import { describe, expect, it } from "vitest";

import {
  NormalizedCollectorQuerySchema,
  ResolvedLocationSchema,
} from "../../../../services/maritime/schedule-collector/contracts";
import { createOoclParserAdapter, parseOoclLocations, parseOoclScheduleResponse } from "../../../../services/maritime/schedule-collector/carriers/oocl";
import { InMemoryEvidenceStore } from "../../../../services/maritime/schedule-collector/evidence";
import { syntheticOoclScheduleResponse } from "../../../../services/maritime/schedule-collector/fixtures/synthetic-oocl";

function context() {
  return {
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
  };
}

describe("OOCL schedule parser", () => {
  it("uses explicit country and UNLocode metadata rather than the internal city code", () => {
    const result = parseOoclLocations({ success: true, data: { results: [{ LocationID: 123456,
      Names: [{ Language: "English", Name: "Fixture City", UpperAdministrativeLocation: "Canada", Parents: [{ Type: "Country", Code: "CA" }] }],
      Codes: [{ Standard: "Internal Code", Code: "SYN" }, { Standard: "UNLocode", Code: "CASYN" }],
    }] } });
    expect(result).toMatchObject([{ carrier_location_id: "123456", name: "Fixture City, Canada", country_code: "CA", unlocode: "CASYN" }]);
    expect(() => parseOoclLocations({ success: false, data: { results: [] } })).toThrow();
  });
  it("parses the observed standardRoutes shape without converting a rail or door leg into ocean routing", () => {
    const result = parseOoclScheduleResponse(syntheticOoclScheduleResponse, context());

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
  it("keeps departure and arrival timezones separate", () => {
    const result = parseOoclScheduleResponse(syntheticOoclScheduleResponse, context());
    expect(result.records[0]?.legs[1]?.events.map(event => event.timezone)).toEqual(["Asia/Seoul", "America/Vancouver"]);
  });

  it("never supplies missing source ports from the query or silently counts a broken leg as complete", () => {
    const payload = structuredClone(syntheticOoclScheduleResponse) as unknown as { data: { standardRoutes: { Legs: Record<string, unknown>[] }[] } };
    delete payload.data.standardRoutes[0]!.Legs[0]!.LoadingPort;
    const result = parseOoclScheduleResponse(payload, context());
    expect(result.records[0]?.legs).toHaveLength(2);
    expect(result.quality.key_fields_complete).toBe(false);
    expect(result.coverage.complete).toBe(false);
    expect(result.quality.missing_field_count).toBeGreaterThan(0);
  });

  it("preserves actual facility endpoints on truck legs and rejects a source error even with route data", () => {
    const payload = structuredClone(syntheticOoclScheduleResponse) as unknown as { success: boolean; data: { standardRoutes: { Legs: Record<string, unknown>[] }[] } };
    payload.data.standardRoutes[0]!.Legs.push({ Type: "InboundDoor", TransportMode: { Code: "TRU", Name: "Truck" },
      OriginFacility: { ID: "synthetic-terminal", Name: "Fixture terminal", Type: "Terminal" },
      DestinationFacility: { ID: "synthetic-depot", Name: "Fixture depot", Type: "Depot" } });
    const result = parseOoclScheduleResponse(payload, context());
    expect(result.records[0]?.legs.at(-1)).toMatchObject({ mode: "truck", from: { carrier_location_id: "synthetic-terminal" }, to: { carrier_location_id: "synthetic-depot" } });
    payload.success = false;
    expect(() => parseOoclScheduleResponse(payload, context())).toThrow("oocl_schedule_response_invalid");
  });

  it("retains browser evidence and incomplete coverage across the shared window collector", async () => {
    const payload = structuredClone(syntheticOoclScheduleResponse) as unknown as { data: { standardRoutes: { Legs: Record<string, unknown>[] }[] } };
    delete payload.data.standardRoutes[0]!.Legs[1]!.DischargePort;
    payload.data.standardRoutes[0]!.Legs.unshift({ Type: "OutboundDoor", TransportMode: { Code: "TRU" },
      OriginFacility: { ID: "synthetic-depot", Name: "Fixture depot" },
      DestinationFacility: { ID: "synthetic-terminal", Name: "Fixture terminal" } });
    const evidence = new InMemoryEvidenceStore();
    const calls: unknown[] = [];
    const adapter = createOoclParserAdapter({ available: true, search(input) {
      calls.push(input.query);
      return Promise.resolve({ status: 200, url: "https://moc.oocl.com/", headers: {}, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify(payload)) });
    } });
    const result = await adapter.query(context(), { request: () => { throw new Error("unexpected HTTP"); } }, evidence);
    expect(calls).toHaveLength(2);
    expect(result.records).toHaveLength(1);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.uncovered_windows).toHaveLength(2);
    expect(result.quality.key_fields_complete).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(await evidence.read(result.records[0]!.evidence_ref)))).toEqual(payload);
  });

  it("requires an explicit source count and distinguishes an empty response from missing dates", () => {
    const empty = parseOoclScheduleResponse({ success: true, data: { standardRoutes: [], numberOfRouteReturn: 0 } }, context());
    expect(empty.records).toEqual([]);
    expect(empty.coverage.complete).toBe(true);
    const payload = structuredClone(syntheticOoclScheduleResponse) as unknown as { data: { numberOfRouteReturn?: number; standardRoutes: { Legs: Record<string, unknown>[] }[] } };
    delete payload.data.numberOfRouteReturn;
    expect(parseOoclScheduleResponse(payload, context()).coverage.complete).toBe(false);
    delete payload.data.standardRoutes[0]!.Legs[0]!.FromETDLocalDateTime;
    delete payload.data.standardRoutes[0]!.Legs[0]!.FromETDGmtDateTime;
    expect(parseOoclScheduleResponse(payload, context()).quality.key_fields_complete).toBe(false);
  });

});
