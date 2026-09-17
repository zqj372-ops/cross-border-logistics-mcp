import { describe, expect, it, vi } from "vitest";

import {
  createCoscoAdapter,
  parseCoscoLocationResponse,
  parseCoscoScheduleResponse,
} from "../../../../services/maritime/schedule-collector/carriers/cosco";
import {
  syntheticCoscoLocationResponse,
  syntheticCoscoScheduleResponse,
} from "../../../../services/maritime/schedule-collector/fixtures/synthetic-cosco";
import { InMemoryEvidenceStore } from "../../../../services/maritime/schedule-collector/evidence";
import {
  CollectorQueryInputSchema,
  ResolvedLocationSchema,
} from "../../../../services/maritime/schedule-collector/contracts";
import { normalizeQuery } from "../../../../services/maritime/schedule-collector/normalize";

describe("COSCO schedule adapter", () => {
  it("parses official location candidates without collapsing same-name countries", () => {
    const candidates = parseCoscoLocationResponse(syntheticCoscoLocationResponse);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Vancouver",
          country_code: "CA",
          carrier_location_id: "synthetic-cosco-vancouver-ca",
          source_full_name: "Vancouver, ,BC,Canada",
        }),
        expect.objectContaining({
          name: "Vancouver",
          country_code: "US",
          carrier_location_id: "synthetic-cosco-vancouver-us",
        }),
      ]),
    );
  });

  it("keeps ETD, ETA, cutoff, available, and voyage identifiers distinct", () => {
    const input = CollectorQueryInputSchema.parse({
      carrier: "COSCO",
      origin: { text: "Shanghai", country_code: "CN", carrier_location_id: null },
      destination: {
        text: "Vancouver",
        country_code: "CA",
        carrier_location_id: null,
      },
      from: "2026-09-17",
      until: "2026-10-14",
      routing: "any",
    });
    const origin = ResolvedLocationSchema.parse({
      input_text: "Shanghai",
      name: "Shanghai",
      country_code: "CN",
      type: "city",
      carrier_location_id: "synthetic-cosco-shanghai",
      mapping_source: "cosco_find_city_district",
      source_full_name: "Shanghai,Shanghai,Shanghai,China",
      unlocode: "CNSHA",
    });
    const destination = ResolvedLocationSchema.parse({
      input_text: "Vancouver",
      name: "Vancouver",
      country_code: "CA",
      type: "city",
      carrier_location_id: "synthetic-cosco-vancouver-ca",
      mapping_source: "cosco_find_city_district",
      source_full_name: "Vancouver, ,BC,Canada",
      unlocode: "CAVCR",
    });
    const result = parseCoscoScheduleResponse(syntheticCoscoScheduleResponse, {
      requestId: "request_cosco_test",
      normalizedQuery: normalizeQuery(input, origin, destination),
      origin,
      destination,
      evidenceRef: "evidence:request_cosco_test:COSCO:sha256:fixture",
      observedAt: "2026-09-17T00:00:00Z",
    });
    const record = result.records[0];
    expect(record).toMatchObject({
      service_name: "CPV",
      routing: "direct",
      pol: {
        name: "Shanghai",
        carrier_location_id: "SHA",
      },
      pod: {
        name: "Vancouver",
        carrier_location_id: "VAN",
      },
      cargo_available_at: "2026-10-05T06:00:00.000",
      transit: { source_total_days: "12" },
    });
    expect(record?.legs[0]).toMatchObject({
      vessel_name: "XIN SHAN TOU",
      voyage: "225N",
    });
    expect(record?.legs[0]?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "departure",
          local_datetime: "2026-09-20T07:00:00.000",
        }),
        expect.objectContaining({
          event_type: "arrival",
          local_datetime: "2026-10-02T12:00:00.000",
        }),
      ]),
    );
  });

  it("returns five alternative itineraries as five independent records", () => {
    const rows = [1, 2, 3, 4, 5].map((id) => ({
      ...syntheticCoscoScheduleResponse.data.content.data[0],
      id: String(id),
    }));
    const response = {
      ...syntheticCoscoScheduleResponse,
      data: {
        content: {
          ...syntheticCoscoScheduleResponse.data.content,
          data: rows,
        },
      },
    };
    const result = parseCoscoScheduleResponse(response, context());
    expect(result.records).toHaveLength(5);
    expect(result.records.every((record) => record.legs.length === 1)).toBe(true);
    expect(result.quality.key_fields_complete).toBe(true);
  });

  it("fails closed for upstream errors and distinguishes a valid empty result", () => {
    expect(() =>
      parseCoscoScheduleResponse(
        { ...syntheticCoscoScheduleResponse, code: "500" },
        context(),
      ),
    ).toThrow();
    const empty = parseCoscoScheduleResponse(
      {
        ...syntheticCoscoScheduleResponse,
        data: {
          content: {
            ...syntheticCoscoScheduleResponse.data.content,
            data: [],
          },
        },
      },
      context(),
    );
    expect(empty.records).toEqual([]);
    expect(empty.coverage.complete).toBe(true);
  });

  it("does not mark missing ETD or ETA as complete", () => {
    const response = {
      ...syntheticCoscoScheduleResponse,
      data: {
        content: {
          ...syntheticCoscoScheduleResponse.data.content,
          data: [
            {
              ...syntheticCoscoScheduleResponse.data.content.data[0],
              etd: null,
              eta: null,
            },
          ],
        },
      },
    };
    const result = parseCoscoScheduleResponse(response, context());
    expect(result.quality.key_fields_complete).toBe(false);
    expect(result.quality.evaluation_status).toBe("partial");
  });

  it("marks source city echo conflicts as partial without discarding records", () => {
    const response = {
      ...syntheticCoscoScheduleResponse,
      data: {
        content: {
          ...syntheticCoscoScheduleResponse.data.content,
          conditions: {
            ...syntheticCoscoScheduleResponse.data.content.conditions,
            destinationCity: "Cato Ridge, ,KwaZulu-Natal,South Africa,ZACAT",
          },
        },
      },
    };
    const result = parseCoscoScheduleResponse(response, context());
    expect(result.records).toHaveLength(1);
    expect(result.quality).toMatchObject({
      key_fields_complete: false,
      evaluation_status: "partial",
      conflicts: ["cosco_destination_city_name_mismatch"],
    });
  });

  it("keeps a POD-terminal echo as terminal evidence without inventing an inland leg", () => {
    const response = {
      ...syntheticCoscoScheduleResponse,
      data: {
        content: {
          ...syntheticCoscoScheduleResponse.data.content,
          data: [
            {
              ...syntheticCoscoScheduleResponse.data.content.data[0],
              inboundFacilityName: "DP World-Centerm Container Terminal",
              deliFacilityCode: "VAN02",
              podFacilityCode: "VAN02",
              inboundTotalTransportModes: "Truck",
            },
          ],
        },
      },
    };
    const result = parseCoscoScheduleResponse(response, context());
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.legs).toHaveLength(1);
    expect(result.records[0]?.place_of_delivery).toBeNull();
    expect(result.records[0]?.terminal).toMatchObject({
      name: "DP World-Centerm Container Terminal",
      carrier_location_id: "VAN02",
      type: "terminal",
    });
    expect(result.quality).toMatchObject({
      key_fields_complete: true,
      evaluation_status: "evaluated",
      missing_field_count: 0,
    });
  });

  it("marks an unsegmented different delivery facility as manual review", () => {
    const response = {
      ...syntheticCoscoScheduleResponse,
      data: {
        content: {
          ...syntheticCoscoScheduleResponse.data.content,
          data: [
            {
              ...syntheticCoscoScheduleResponse.data.content.data[0],
              inboundFacilityName: "CN Rail  Brampton Facility",
              deliFacilityCode: "PRR01",
              inboundTotalTransportModes: "Rail,Truck",
            },
          ],
        },
      },
    };
    const result = parseCoscoScheduleResponse(response, context());
    expect(result.records[0]?.pod).toMatchObject({
      name: "Vancouver",
      carrier_location_id: "VAN",
    });
    expect(result.records[0]?.place_of_delivery).toBe("PRR01");
    expect(result.records[0]?.legs).toHaveLength(1);
    expect(result.records[0]?.routing).toBe("unknown");
    expect(result.records[0]?.terminal).toBeNull();
    expect(result.quality).toMatchObject({
      key_fields_complete: false,
      evaluation_status: "partial",
    });
    expect(result.quality.missing_field_count).toBe(1);
  });

  it("builds the official public HTTP request through the injected port", async () => {
    const request = vi.fn((input) => {
      expect(input).toMatchObject({
        carrier: "COSCO",
        method: "POST",
        path: "/ebschedule/public/purpoShipmentWs",
        body: {
          originCity: "Shanghai,Shanghai,Shanghai,China,CNSHA",
          destinationCity: "Vancouver, ,BC,Canada,CAVCR",
        },
      });
      return Promise.resolve({
        status: 200,
        url: "https://elines.coscoshipping.com/ebschedule/public/purpoShipmentWs",
        contentType: "application/json",
        headers: {},
        body: new TextEncoder().encode(JSON.stringify(syntheticCoscoScheduleResponse)),
      });
    });
    const input = CollectorQueryInputSchema.parse({
      carrier: "COSCO",
      origin: { text: "Shanghai", country_code: "CN", carrier_location_id: null },
      destination: {
        text: "Vancouver",
        country_code: "CA",
        carrier_location_id: null,
      },
      from: "2026-09-17",
      until: "2026-10-14",
      routing: "any",
    });
    const origin = ResolvedLocationSchema.parse({
      input_text: "Shanghai",
      name: "Shanghai",
      country_code: "CN",
      type: "city",
      carrier_location_id: "synthetic-cosco-shanghai",
      mapping_source: "cosco_find_city_district",
      source_full_name: "Shanghai,Shanghai,Shanghai,China",
      unlocode: "CNSHA",
    });
    const destination = ResolvedLocationSchema.parse({
      input_text: "Vancouver",
      name: "Vancouver",
      country_code: "CA",
      type: "city",
      carrier_location_id: "synthetic-cosco-vancouver-ca",
      mapping_source: "cosco_find_city_district",
      source_full_name: "Vancouver, ,BC,Canada",
      unlocode: "CAVCR",
    });
    const adapter = createCoscoAdapter();
    const result = await adapter.query(
      {
        requestId: "request_cosco_http",
        normalizedQuery: normalizeQuery(input, origin, destination),
        origin,
        destination,
        evidenceRef: "",
        observedAt: "2026-09-17T00:00:00Z",
      },
      { request },
      new InMemoryEvidenceStore(),
    );
    expect(request).toHaveBeenCalledOnce();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      query_origin: "synthetic-cosco-shanghai",
      query_destination: "synthetic-cosco-vancouver-ca",
    });
  });
});

function context() {
  const input = CollectorQueryInputSchema.parse({
    carrier: "COSCO",
    origin: { text: "Shanghai", country_code: "CN", carrier_location_id: null },
    destination: {
      text: "Vancouver",
      country_code: "CA",
      carrier_location_id: null,
    },
    from: "2026-09-17",
    until: "2026-10-14",
    routing: "any",
  });
  const origin = ResolvedLocationSchema.parse({
    input_text: "Shanghai",
    name: "Shanghai",
    country_code: "CN",
    type: "city",
    carrier_location_id: "synthetic-cosco-shanghai",
    mapping_source: "cosco_find_city_district",
    source_full_name: "Shanghai,Shanghai,Shanghai,China",
    unlocode: "CNSHA",
  });
  const destination = ResolvedLocationSchema.parse({
    input_text: "Vancouver",
    name: "Vancouver",
    country_code: "CA",
    type: "city",
    carrier_location_id: "synthetic-cosco-vancouver-ca",
    mapping_source: "cosco_find_city_district",
    source_full_name: "Vancouver, ,BC,Canada",
    unlocode: "CAVCR",
  });
  return {
    requestId: "request_cosco_test",
    normalizedQuery: normalizeQuery(input, origin, destination),
    origin,
    destination,
    evidenceRef: "evidence:request_cosco_test:COSCO:sha256:fixture",
    observedAt: "2026-09-17T00:00:00Z",
  };
}
