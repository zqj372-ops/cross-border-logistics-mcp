import { describe, expect, it } from "vitest";

import {
  createOneAdapter,
  parseOneLocationResponse,
  parseOneScheduleResponse,
} from "../../../../services/maritime/schedule-collector/carriers/one";
import {
  CollectorQueryInputSchema,
  ResolvedLocationSchema,
} from "../../../../services/maritime/schedule-collector/contracts";
import { InMemoryEvidenceStore } from "../../../../services/maritime/schedule-collector/evidence";
import { normalizeQuery } from "../../../../services/maritime/schedule-collector/normalize";
import type {
  CarrierHttpPort,
  CarrierHttpRequest,
  CarrierHttpResponse,
  CollectorPorts,
} from "../../../../services/maritime/schedule-collector/ports";
import { createCollectorService } from "../../../../services/maritime/schedule-collector/service";

function context(from = "2026-09-17", until = "2026-10-28") {
  const input = CollectorQueryInputSchema.parse({
    carrier: "ONE",
    origin: {
      text: "Shanghai",
      country_code: "CN",
      carrier_location_id: "CNSHA",
    },
    destination: {
      text: "Vancouver",
      country_code: "CA",
      carrier_location_id: "CAVAN",
    },
    from,
    until,
    routing: "any",
  });
  const origin = ResolvedLocationSchema.parse({
    input_text: "Shanghai",
    name: "SHANGHAI, SHANGHAI, CHINA",
    country_code: "CN",
    type: "city",
    carrier_location_id: "CNSHA",
    mapping_source: "one_point_to_point_search",
    source_full_name: "SHANGHAI, SHANGHAI, CHINA",
    unlocode: null,
  });
  const destination = ResolvedLocationSchema.parse({
    input_text: "Vancouver",
    name: "VANCOUVER, BC, CANADA",
    country_code: "CA",
    type: "city",
    carrier_location_id: "CAVAN",
    mapping_source: "one_point_to_point_search",
    source_full_name: "VANCOUVER, BC, CANADA",
    unlocode: null,
  });
  return {
    requestId: "request_one_test",
    normalizedQuery: normalizeQuery(input, origin, destination),
    origin,
    destination,
    evidenceRef: "evidence:request_one_test:ONE:sha256:fixture",
    observedAt: "2026-09-17T00:00:00Z",
  };
}

function inlandContext() {
  const input = CollectorQueryInputSchema.parse({
    carrier: "ONE",
    origin: {
      text: "Hefei",
      country_code: "CN",
      carrier_location_id: "CNHFE",
    },
    destination: {
      text: "Vancouver",
      country_code: "CA",
      carrier_location_id: "CAVAN",
    },
    from: "2026-09-17",
    until: "2026-10-28",
    routing: "any",
  });
  const origin = ResolvedLocationSchema.parse({
    input_text: "Hefei",
    name: "HEFEI, ANHUI, CHINA",
    country_code: "CN",
    type: "city",
    carrier_location_id: "CNHFE",
    mapping_source: "one_point_to_point_search",
    source_full_name: "HEFEI, ANHUI, CHINA",
    unlocode: null,
  });
  const destination = ResolvedLocationSchema.parse({
    input_text: "Vancouver",
    name: "VANCOUVER, BC, CANADA",
    country_code: "CA",
    type: "city",
    carrier_location_id: "CAVAN",
    mapping_source: "one_point_to_point_search",
    source_full_name: "VANCOUVER, BC, CANADA",
    unlocode: null,
  });
  return {
    requestId: "request_one_inland_test",
    normalizedQuery: normalizeQuery(input, origin, destination),
    origin,
    destination,
    evidenceRef: "evidence:request_one_inland_test:ONE:sha256:fixture",
    observedAt: "2026-09-17T00:00:00Z",
  };
}

function jsonResponse(body: unknown): CarrierHttpResponse {
  return {
    status: 200,
    url: "https://ecomm.one-line.com/api/v1/schedule/point-to-point",
    contentType: "application/json",
    headers: {},
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function servicePorts(http: CarrierHttpPort): CollectorPorts {
  return {
    clock: { now: () => new Date("2026-09-17T00:00:00Z") },
    context: {
      requestId: "request_one_service_test",
      auditId: "audit_one_service_test",
      localFixture: false,
    },
    audit: { record: () => Promise.resolve() },
    evidence: new InMemoryEvidenceStore(),
    http,
  };
}

function directLine(overrides: Record<string, unknown> = {}) {
  return {
    sailInfo: [
      {
        vvd: "YMWT0193E",
        vvdName: "YM WEALTH 193E",
        serviceLaneCode: "PN3",
        serviceLaneName: "PACIFIC NORTH 3",
        polYardCode: "CNSHA19",
        polLocationName: "SHANGHAI, SHANGHAI",
        departureDate: "2026-09-26 04:00",
        podYardCode: "CAVAN01",
        podLocationName: "VANCOUVER, BC",
        arrivalDate: "2026-10-10 23:00",
        vsslName: "YM WEALTH",
      },
    ],
    journeys: [
      {
        vesselName: "YM WEALTH 193E",
        serviceLane: "PN3",
        transferMode: "",
        polYardCode: "CNSHA19",
        polLocationName:
          "SHANGHAI, SHANGHAI (SIPG - SHANGDONG BRANCH)",
        departureDate: "2026-09-26 04:00",
        podYardCode: "CAVAN01",
        podLocationName: "VANCOUVER, BC (3891 DELTAPORT GCT)",
        berthingDate: "2026-10-11 05:00",
        transitTime: "15 day(s) 1 hour(s)",
        vesselCode: "YMWT",
        polCode: "CNSHA",
        polName: "SHANGHAI, SHANGHAI",
        polCountryName: "CHINA",
        polYardName: "SIPG - SHANGDONG BRANCH",
        podCode: "CAVAN",
        podName: "VANCOUVER, BC",
        podCountryName: "CANADA",
        podYardName: "3891 DELTAPORT GCT",
        transitTimeInSeconds: "1299600",
        vsslName: "YM WEALTH",
      },
    ],
    transshipmentMethods: [],
    porCode: "CNSHA19",
    porName: "SHANGHAI, SHANGHAI",
    porDepartureDate: "2026-09-26",
    polCode: "CNSHA19",
    polName: "SHANGHAI, SHANGHAI",
    polDepartureDate: "2026-09-26",
    podCode: "CAVAN01",
    podName: "VANCOUVER, BC",
    podArrivalDate: "2026-10-11",
    delCode: "CAVAN01",
    delName: "VANCOUVER, BC",
    delArrivalDate: "2026-10-11",
    trunkVvd: "YMWT0193E",
    cct: "2026-09-24 17:00",
    dct: "2026-09-23 13:00",
    inlandCct: "2026-09-24 17:00",
    vgmCct: "2026-09-24 13:00",
    oceanTransitTime: "15 day(s) 1 hour(s)",
    oceanTransitTimeInSeconds: "1299600",
    totalTransitTimeInSeconds: "1447200",
    displayTransitDays: "15",
    lastCyAvailableDate: "2026-10-11 11:00",
    transshipmentType: "DIRECT",
    totalTransshipment: 0,
    totalTransitTime: "16 day(s) 18 hour(s)",
    ...overrides,
  };
}

function transshipmentLine() {
  const line = directLine({
    trunkVvd: "OART0079E",
    transshipmentType: "TRANSSHIPMENT",
    totalTransshipment: 1,
    transshipmentMethods: ["RAIL"],
  });
  line.sailInfo = [
    {
      vvd: "OTLT0029W",
      vvdName: "ONE TREASURE 029W",
      serviceLaneCode: "FE4",
      serviceLaneName: "FAR EAST - EUROPE 4",
      polYardCode: "CNSHA19",
      polLocationName: "SHANGHAI, SHANGHAI",
      departureDate: "2026-09-18 20:00",
      podYardCode: "KRPUS14",
      podLocationName: "PUSAN",
      arrivalDate: "2026-09-20 03:00",
      vsslName: "ONE TREASURE",
    },
    {
      vvd: "OART0079E",
      vvdName: "ONE ARCADIA 079E",
      serviceLaneCode: "EC4",
      serviceLaneName: "EAST COAST 4",
      polYardCode: "KRPUS14",
      polLocationName: "PUSAN",
      departureDate: "2026-10-14 00:00",
      podYardCode: "USHOU05",
      podLocationName: "HOUSTON, TX",
      arrivalDate: "2026-11-08 14:00",
      vsslName: "ONE ARCADIA",
    },
  ];
  line.journeys = [
    {
      vesselName: "ONE TREASURE 029W",
      serviceLane: "FE4",
      transferMode: "",
      polYardCode: "CNSHA19",
      polLocationName: "SHANGHAI, SHANGHAI (TERMINAL)",
      departureDate: "2026-09-18 20:00",
      podYardCode: "KRPUS14",
      podLocationName: "PUSAN (TERMINAL)",
      berthingDate: "2026-09-22 01:00",
      transitTime: "3 day(s) 5 hour(s)",
      vesselCode: "OTLT",
      polCode: "CNSHA",
      polName: "SHANGHAI, SHANGHAI",
      polCountryName: "CHINA",
      polYardName: "TERMINAL",
      podCode: "KRPUS",
      podName: "PUSAN",
      podCountryName: "REPUBLIC OF KOREA",
      podYardName: "BUSAN TERMINAL",
      transitTimeInSeconds: "277200",
      vsslName: "ONE TREASURE",
    },
    {
      vesselName: "ONE ARCADIA 079E",
      serviceLane: "EC4",
      transferMode: "",
      polYardCode: "KRPUS14",
      polLocationName: "PUSAN (BUSAN TERMINAL)",
      departureDate: "2026-10-14 00:00",
      podYardCode: "USHOU05",
      podLocationName: "HOUSTON, TX (BAYPORT TERMINAL)",
      berthingDate: "2026-11-08 14:00",
      transitTime: "26 day(s) 4 hour(s)",
      vesselCode: "OART",
      polCode: "KRPUS",
      polName: "PUSAN",
      polCountryName: "REPUBLIC OF KOREA",
      polYardName: "BUSAN TERMINAL",
      podCode: "USHOU",
      podName: "HOUSTON, TX",
      podCountryName: "UNITED STATES",
      podYardName: "BAYPORT CONTAINER TERMINAL",
      transitTimeInSeconds: "2260800",
      vsslName: "ONE ARCADIA",
    },
    {
      vesselName: "CN (RAIL)",
      serviceLane: "",
      transferMode: "RAIL",
      polYardCode: "USHOU05",
      polLocationName: "HOUSTON, TX (BAYPORT TERMINAL)",
      departureDate: "2026-11-09 02:00",
      podYardCode: "USTOR64",
      podLocationName: "TORONTO, ON (CN RAIL - BRAMPTON)",
      berthingDate: "2026-11-16 01:00",
      transitTime: "6 day(s) 23 hour(s)",
      vesselCode: "",
      polCode: "USHOU",
      polName: "HOUSTON, TX",
      polCountryName: "UNITED STATES",
      polYardName: "BAYPORT CONTAINER TERMINAL",
      podCode: "USTOR",
      podName: "TORONTO, ON",
      podCountryName: "CANADA",
      podYardName: "CN RAIL - BRAMPTON",
      transitTimeInSeconds: "601200",
      vsslName: "",
    },
  ];
  line.porCode = "CNSHA19";
  line.porDepartureDate = "2026-09-18";
  line.polCode = "CNSHA19";
  line.podCode = "USHOU05";
  line.delCode = "USTOR64";
  line.delArrivalDate = "2026-11-16";
  return line;
}

describe("ONE schedule parser", () => {
  it("keeps only confirmed CY locations and preserves country codes", () => {
    const candidates = parseOneLocationResponse({
      points: [
        {
          code: "CAVAN",
          name: "VANCOUVER, BC, CANADA",
          termCd: "Y",
          countryCode: "CA",
        },
        {
          code: "CAVAN",
          name: "VANCOUVER, BC, CANADA",
          termCd: "D",
          countryCode: "CA",
        },
        {
          code: "USVAN",
          name: "VANCOUVER - USA, WA, UNITED STATES",
          termCd: "Y",
          countryCode: "US",
        },
      ],
    });
    expect(candidates).toEqual([
      expect.objectContaining({
        carrier_location_id: "CAVAN",
        country_code: "CA",
        type: "city",
        unlocode: null,
      }),
      expect.objectContaining({
        carrier_location_id: "USVAN",
        country_code: "US",
        type: "city",
        unlocode: null,
      }),
    ]);
  });

  it("maps a direct itinerary without inventing timezones or UN/LOCODEs", () => {
    const result = parseOneScheduleResponse(
      { scheduleLines: [directLine()], cargoNature: "GP" },
      context(),
    );
    const record = result.records[0];
    expect(result.quality).toMatchObject({
      key_fields_complete: true,
      evaluation_status: "evaluated",
      conflicts: [],
    });
    expect(record).toMatchObject({
      source_itinerary_id: "YMWT0193E",
      service_name: "PN3",
      routing: "direct",
      pol: {
        carrier_location_id: "CNSHA",
        country_code: "CN",
        unlocode: null,
      },
      pod: {
        carrier_location_id: "CAVAN",
        country_code: "CA",
        unlocode: null,
      },
      transit: {
        source_total_hours: "402",
        source_ocean_hours: "361",
        source_total_days: "15",
      },
      cutoffs: {
        si: null,
        vgm: {
          source_text: "2026-09-24 13:00",
        },
        cy: {
          source_text: "2026-09-24 17:00",
        },
      },
      cargo_available_at: "2026-10-11T11:00:00.000",
    });
    expect(record?.legs[0]).toMatchObject({
      mode: "ocean",
      vessel_name: "YM WEALTH",
      voyage: "193E",
      events: [
        {
          event_type: "departure",
          local_datetime: "2026-09-26T04:00:00.000",
          timezone: null,
          timezone_source: "not_provided",
        },
        {
          event_type: "arrival",
          local_datetime: "2026-10-11T05:00:00.000",
          timezone: null,
          timezone_source: "not_provided",
        },
      ],
    });
    expect(result.quality.warnings).toContain(
      "one_document_cutoff_not_mapped",
    );
    expect(result.quality.warnings).toEqual(
      expect.arrayContaining([
        "one_request_terms_cy_cy",
        "one_cargo_nature_gp_only",
      ]),
    );
  });

  it("keeps ordered ocean and inland legs and separates POD from delivery", () => {
    const result = parseOneScheduleResponse(
      { scheduleLines: [transshipmentLine()], cargoNature: "GP" },
      context("2026-09-17", "2026-12-15"),
    );
    const record = result.records[0];
    expect(record?.routing).toBe("transshipment");
    expect(record?.legs.map((leg) => leg.mode)).toEqual([
      "ocean",
      "ocean",
      "rail",
    ]);
    expect(record?.legs.map((leg) => leg.voyage)).toEqual([
      "029W",
      "079E",
      null,
    ]);
    expect(record?.pod).toMatchObject({
      carrier_location_id: "USHOU",
      name: "HOUSTON, TX",
    });
    expect(record?.place_of_delivery).toBe("USTOR");
    expect(record?.legs.at(-1)?.to).toMatchObject({
      carrier_location_id: "USTOR",
      type: "inland",
    });
  });

  it("accepts scientific-notation transit seconds from the public API", () => {
    const result = parseOneScheduleResponse(
      {
        scheduleLines: [
          directLine({
            totalTransitTimeInSeconds: "1.44E+6",
            oceanTransitTimeInSeconds: "1.296E+6",
          }),
        ],
        cargoNature: "GP",
      },
      context(),
    );
    expect(result.records[0]?.transit).toMatchObject({
      source_total_hours: "400",
      source_ocean_hours: "360",
    });
    expect(result.quality.missing_field_count).toBe(0);
  });

  it("returns complete empty coverage instead of a parse failure", () => {
    const result = parseOneScheduleResponse(
      { scheduleLines: [], cargoNature: "GP" },
      context(),
    );
    expect(result.records).toEqual([]);
    expect(result.quality.warnings).toEqual(
      expect.arrayContaining([
        "one_request_terms_cy_cy",
        "one_cargo_nature_gp_only",
      ]),
    );
    expect(result.coverage).toMatchObject({
      complete: true,
      covered_windows: [
        { from: "2026-09-17", until: "2026-10-28" },
      ],
    });
  });

  it("splits long windows, filters departures, and deduplicates boundaries", async () => {
    const requests: CarrierHttpRequest[] = [];
    const adapter = createOneAdapter();
    const result = await adapter.query(
      context("2026-09-17", "2026-12-15"),
      {
        request(input: CarrierHttpRequest) {
          requests.push(input);
          const fromDate = input.query?.fromDate ?? "";
          const lines =
            fromDate === "2026-12-10"
              ? [
                  directLine({
                    trunkVvd: "DECEMBER",
                    porDepartureDate: "2026-12-12",
                    sailInfo: [
                      {
                        ...directLine().sailInfo[0],
                        vvd: "DECEMBER",
                        vvdName: "DECEMBER VESSEL 001E",
                        vsslName: "DECEMBER VESSEL",
                        departureDate: "2026-12-12 04:00",
                      },
                    ],
                    journeys: [
                      {
                        ...directLine().journeys[0],
                        vesselName: "DECEMBER VESSEL 001E",
                        vsslName: "DECEMBER VESSEL",
                        departureDate: "2026-12-12 04:00",
                        berthingDate: "2026-12-27 05:00",
                      },
                    ],
                  }),
                ]
              : [directLine()];
          return Promise.resolve({
            status: 200,
            url: "https://ecomm.one-line.com/api/v1/schedule/point-to-point",
            contentType: "application/json",
            headers: {},
            body: new TextEncoder().encode(
              JSON.stringify({ scheduleLines: lines, cargoNature: "GP" }),
            ),
          });
        },
      },
      new InMemoryEvidenceStore(),
    );
    expect(requests.map((request) => request.query?.fromDate)).toEqual([
      "2026-09-17",
      "2026-10-29",
      "2026-12-10",
    ]);
    expect(result.records).toHaveLength(2);
    expect(result.coverage).toMatchObject({
      complete: true,
      pages_read: [1, 2, 3],
    });
  });

  it("preserves missing departure evidence across windows and returns manual review", async () => {
    const good = directLine();
    const missingDeparture = directLine({
      trunkVvd: "MISSING-DEPARTURE",
      sailInfo: [
        {
          ...good.sailInfo[0],
          departureDate: null,
        },
      ],
      journeys: [
        {
          ...good.journeys[0],
          departureDate: null,
        },
      ],
      porDepartureDate: null,
    });
    const http: CarrierHttpPort = {
      request(input: CarrierHttpRequest) {
        if (input.path.endsWith("/point-to-point/search")) {
          const isOrigin = input.query?.pointName === "Shanghai";
          return Promise.resolve(
            jsonResponse({
              points: [
                isOrigin
                  ? {
                      code: "CNSHA",
                      name: "SHANGHAI, SHANGHAI, CHINA",
                      termCd: "Y",
                      countryCode: "CN",
                    }
                  : {
                      code: "CAVAN",
                      name: "VANCOUVER, BC, CANADA",
                      termCd: "Y",
                      countryCode: "CA",
                    },
              ],
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            scheduleLines:
              input.query?.fromDate === "2026-10-29"
                ? [missingDeparture]
                : [good],
            cargoNature: "GP",
          }),
        );
      },
    };
    const service = createCollectorService({
      ports: servicePorts(http),
      adapters: [createOneAdapter()],
    });
    const result = await service.query({
      carrier: "ONE",
      origin: {
        text: "Shanghai",
        country_code: "CN",
        carrier_location_id: null,
      },
      destination: {
        text: "Vancouver",
        country_code: "CA",
        carrier_location_id: null,
      },
      from: "2026-09-17",
      until: "2026-11-30",
      routing: "any",
    });
    const envelope = result.envelope as { readonly status: string };
    const data = result.data as {
      readonly records: readonly unknown[];
      readonly quality: {
        readonly missing_field_count: number;
        readonly evaluation_status: string;
      };
    };
    expect(envelope.status).toBe("manual_review");
    expect(data.records).toHaveLength(2);
    expect(data.quality).toMatchObject({
      evaluation_status: "partial",
      missing_field_count: 1,
    });
  });

  it("preserves an inland receipt point and filters by the first ocean departure", async () => {
    const base = directLine();
    const inlandLine = directLine({
      porCode: "CNHFE",
      porDepartureDate: "2026-09-16",
      sailInfo: [
        {
          ...base.sailInfo[0],
          departureDate: "2026-09-19 04:00",
        },
      ],
      journeys: [
        {
          vesselName: null,
          serviceLane: "",
          transferMode: "TRUCK",
          polYardCode: "CNHFE01",
          polLocationName: "HEFEI, ANHUI, CHINA (INLAND DEPOT)",
          departureDate: "2026-09-16 12:00",
          podYardCode: "CNSHA19",
          podLocationName: "SHANGHAI, SHANGHAI (SIPG - SHANGDONG BRANCH)",
          berthingDate: "2026-09-17 08:00",
          transitTime: "20 hour(s)",
          vesselCode: "",
          polCode: "CNHFE",
          polName: "HEFEI, ANHUI, CHINA",
          polCountryName: "CHINA",
          polYardName: "INLAND DEPOT",
          podCode: "CNSHA",
          podName: "SHANGHAI, SHANGHAI",
          podCountryName: "CHINA",
          podYardName: "SIPG - SHANGDONG BRANCH",
          transitTimeInSeconds: "72000",
          vsslName: "",
        },
        {
          ...base.journeys[0],
          departureDate: "2026-09-19 04:00",
        },
      ],
    });
    const result = await createOneAdapter().query(
      inlandContext(),
      {
        request() {
          return Promise.resolve(
            jsonResponse({
              scheduleLines: [inlandLine],
              cargoNature: "GP",
            }),
          );
        },
      },
      new InMemoryEvidenceStore(),
    );
    const record = result.records[0];
    expect(record).toMatchObject({
      place_of_receipt: "CNHFE",
      routing: "direct",
      legs: [
        {
          mode: "truck",
          from: {
            carrier_location_id: "CNHFE",
            type: "inland",
          },
        },
        {
          mode: "ocean",
          from: {
            carrier_location_id: "CNSHA",
            type: "port",
          },
        },
      ],
    });
    expect(result.coverage).toMatchObject({
      complete: false,
      failure_reason: "one_inland_origin_date_basis_unverified",
    });
    expect(result.quality.warnings).toContain(
      "one_inland_origin_date_basis_unverified",
    );
  });

  it("retains completed windows and stops after a later source failure", async () => {
    let calls = 0;
    const result = await createOneAdapter().query(context("2026-09-17", "2026-12-15"), {
      request() {
        calls += 1;
        return Promise.resolve(calls === 1
          ? jsonResponse({ scheduleLines: [directLine()], cargoNature: "GP" })
          : { ...jsonResponse({ error: "synthetic failure" }), status: 503 });
      },
    }, new InMemoryEvidenceStore());
    expect(calls).toBe(2);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.evidence_ref).toMatch(/sha256:/u);
    expect(result.coverage).toMatchObject({
      complete: false,
      covered_windows: [{ from: "2026-09-17", until: "2026-10-28" }],
      uncovered_windows: [{ from: "2026-10-29", until: "2026-12-09" }, { from: "2026-12-10", until: "2026-12-15" }],
      pages_read: [1],
      failure_reason: "one_upstream_http_503",
    });
  });

  it("retains source evidence for a completed empty window before failure", async () => {
    let calls = 0;
    const result = await createOneAdapter().query(context("2026-09-17", "2026-12-15"), {
      request() { calls += 1; return Promise.resolve(calls === 1 ? jsonResponse({ scheduleLines: [], cargoNature: "GP" }) : { ...jsonResponse({ error: "synthetic failure" }), status: 503 }); },
    }, new InMemoryEvidenceStore());
    expect(result.records).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(result.evidenceRefs).toHaveLength(1);
    expect(result.evidenceRefs?.[0]).toMatch(/sha256:/u);
  });

  it("keeps all-failed queries unavailable instead of returning an empty success", async () => {
    let calls = 0;
    await expect(createOneAdapter().query(context("2026-09-17", "2026-12-15"), {
      request() { calls += 1; return Promise.resolve({ ...jsonResponse({ error: "synthetic failure" }), status: 503 }); },
    }, new InMemoryEvidenceStore())).rejects.toMatchObject({ status: "unavailable", message: "one_upstream_http_503" });
    expect(calls).toBe(1);
  });

  it("classifies upstream HTTP failures before JSON shape validation", async () => {
    const adapter = createOneAdapter();
    await expect(
      adapter.query(
        context(),
        {
          request() {
            return Promise.resolve({
              status: 403,
              url: "https://ecomm.one-line.com/api/v1/schedule/point-to-point",
              contentType: "text/plain",
              headers: {},
              body: new TextEncoder().encode("Access Denied"),
            });
          },
        },
        new InMemoryEvidenceStore(),
      ),
    ).rejects.toMatchObject({
      code: "access_restricted",
      status: "unavailable",
    });
  });
});
