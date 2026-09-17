import { describe, expect, it } from "vitest";

import {
  createHmmAdapter,
  parseHmmCitiesList,
  parseHmmScheduleResponse,
} from "../../../../services/maritime/schedule-collector/carriers/hmm";
import {
  CollectorQueryInputSchema,
  ResolvedLocationSchema,
} from "../../../../services/maritime/schedule-collector/contracts";
import { InMemoryEvidenceStore } from "../../../../services/maritime/schedule-collector/evidence";
import { normalizeQuery } from "../../../../services/maritime/schedule-collector/normalize";
import type { CarrierHttpRequest } from "../../../../services/maritime/schedule-collector/ports";

function context(
  from = "2026-09-17",
  until = "2026-10-14",
) {
  const input = CollectorQueryInputSchema.parse({
    carrier: "HMM",
    origin: {
      text: "Shanghai",
      country_code: "CN",
      carrier_location_id: "CNSYN",
    },
    destination: {
      text: "Vancouver",
      country_code: "CA",
      carrier_location_id: "CASYN",
    },
    from,
    until,
    routing: "any",
  });
  const origin = ResolvedLocationSchema.parse({
    input_text: "Shanghai",
    name: "SHANGHAI,CHINA",
    country_code: "CN",
    type: "city",
    carrier_location_id: "CNSYN",
    mapping_source: "hmm_cities_list",
    source_full_name: "SHANGHAI,CHINA",
    unlocode: null,
  });
  const destination = ResolvedLocationSchema.parse({
    input_text: "Vancouver",
    name: "VANCOUVER, BC, CANADA",
    country_code: "CA",
    type: "city",
    carrier_location_id: "CASYN",
    mapping_source: "hmm_cities_list",
    source_full_name: "VANCOUVER, BC, CANADA",
    unlocode: null,
  });
  return {
    requestId: "request_hmm_test",
    normalizedQuery: normalizeQuery(input, origin, destination),
    origin,
    destination,
    evidenceRef: "evidence:request_hmm_test:HMM:sha256:fixture",
    observedAt: "2026-09-17T00:00:00Z",
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    RTN_STS: "OK",
    grmData: [
      {
        grmNo: "SYNTH-HMM-1",
        grmSeq: 1,
        mthVslNm: "HYUNDAI SYNTHETIC",
        mthVvdCd: "HHSU0159E",
        mthCssmObVoyNo: "0159E",
        mthVslCarrCd: "HMM",
        mthLoopCd: "PN3",
        totTrstmHrs: 281,
        porLocCd: "CNSYN",
        pvyLocCd: "CASYN",
        polLocNm: "SHANGHAI,CHINA",
        polLocCd: "CNSYN",
        polFcltyCd: "CNSYN01",
        polFcltyNm: "SYNTHETIC TERMINAL",
        podLocNm: "VANCOUVER, BC, CANADA",
        podLocCd: "CASYN",
        podFcltyCd: "CASYN01",
        podFcltyNm: "SYNTHETIC TERMINAL",
        sigCtofDt: "2026-09-17T06:30:00",
        vgmCtofDt: null,
        portCtofDt: "2026-09-17T06:30:00",
        fcgoCtofDt: "2026-09-16T06:30:00",
        transit: [
          {
            orgLocCd: "CNSYN",
            orgLocNm: "SHANGHAI,CHINA",
            orgFcltyCd: "CNSYN01",
            orgFcltyNm: "SYNTHETIC TERMINAL",
            destnLocCd: "CASYN",
            destnLocNm: "VANCOUVER, BC, CANADA",
            destnFcltyCd: "CASYN01",
            destnFcltyNm: "SYNTHETIC TERMINAL",
            grmBouTpNm: "T/S",
            trsPtnModeCd: "MM",
            arvlStDt: "2026-09-18T23:00:00",
            dpartFnshDt: "2026-09-30T15:30:00",
            vvdCd: "HHSU0159E",
            vslNm: "HYUNDAI SYNTHETIC",
            vslCarrCd: "HMM",
            cssmObVoyNo: "0159E",
          },
        ],
        ...overrides,
      },
    ],
  };
}

describe("HMM schedule parser", () => {
  it("maps source departure and arrival fields without inventing UN/LOCODEs", () => {
    const result = parseHmmScheduleResponse(response(), context());
    const record = result.records[0];
    expect(result.quality).toMatchObject({
      key_fields_complete: true,
      evaluation_status: "evaluated",
      conflicts: [],
    });
    expect(record).toMatchObject({
      operating_carrier: "HMM",
      service_name: "PN3",
      routing: "direct",
      pol: {
        carrier_location_id: "CNSYN",
        unlocode: null,
        type: "port",
      },
      pod: {
        carrier_location_id: "CASYN",
        unlocode: null,
        type: "port",
      },
      transit: { source_total_hours: "281" },
      cutoffs: { customs: null },
    });
    expect(record?.legs[0]?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "departure",
          local_datetime: "2026-09-18T23:00:00",
        }),
        expect.objectContaining({
          event_type: "arrival",
          local_datetime: "2026-09-30T15:30:00",
        }),
      ]),
    );
    expect(result.quality.warnings).toContain("hmm_fcgo_cutoff_not_mapped");
  });

  it("rejects a malformed grmData response instead of reporting empty success", () => {
    expect(() =>
      parseHmmScheduleResponse({ RTN_STS: "OK", grmData: {} }, context()),
    ).toThrow();
  });

  it("does not infer direct routing from a single unknown leg", () => {
    const value = response();
    const row = value.grmData[0]!;
    row.transit[0]!.trsPtnModeCd = "XX";
    const result = parseHmmScheduleResponse(value, context());
    expect(result.records[0]?.routing).toBe("unknown");
  });

  it("marks disconnected or mismatched legs as conflict/manual-review evidence", () => {
    const value = response();
    value.grmData[0]!.transit[0]!.destnLocCd = "OTHER";
    const result = parseHmmScheduleResponse(value, context());
    expect(result.quality.conflicts).toContain("hmm_last_leg_pod_mismatch");
    expect(result.quality.key_fields_complete).toBe(false);
    expect(result.quality.evaluation_status).toBe("partial");
  });

  it("splits a long query into bounded four-week requests and filters by departure", async () => {
    const windowStarts: string[] = [];
    let latestHandle = "";
    const adapter = createHmmAdapter();
    const result = await adapter.query(
      context("2026-09-17", "2026-12-15"),
      {
        request(input: CarrierHttpRequest) {
          if (input.path.endsWith("/ScheduleMain.do")) {
            return Promise.resolve({
              status: 200,
              url: "https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do",
              contentType: "text/html",
              headers: {},
              body: new TextEncoder().encode(
                '<meta name="_csrf" content="synthetic" /><meta name="_csrf_header" content="X-CSRF-TOKEN" />',
              ),
            });
          }
          if (input.path.endsWith("/apiPointToPointList.do")) {
            const body = input.body as { srchSailDate: string };
            windowStarts.push(body.srchSailDate);
            latestHandle = `SYNTH-${windowStarts.length}`;
            return Promise.resolve({
              status: 200,
              url: "https://www.hmm21.com/e-service/general/schedule/apiPointToPointList.do",
              contentType: "application/json",
              headers: {},
              body: new TextEncoder().encode(
                JSON.stringify({
                  RTN_STS: "OK",
                  RTN_DATA: {
                    resultData: { resultCode: "S", GrmNo: latestHandle },
                  },
                }),
              ),
            });
          }
          const payload = response();
          const firstRow = payload.grmData[0]!;
          payload.grmData[0] = {
            ...firstRow,
            grmNo: latestHandle,
          };
          const boundary = {
            ...firstRow,
            grmNo: `${latestHandle}-boundary`,
            grmSeq: 2,
            transit: [
              {
                ...firstRow.transit[0]!,
                arvlStDt: "2026-10-15T23:00:00",
                dpartFnshDt: "2026-10-27T15:30:00",
              },
            ],
          };
          payload.grmData.push(boundary, {
            ...boundary,
            grmNo: `${latestHandle}-boundary-duplicate`,
          });
          return Promise.resolve({
            status: 200,
            url: "https://www.hmm21.com/e-service/general/schedule/selectPointToPointList.do",
            contentType: "application/json",
            headers: {},
            body: new TextEncoder().encode(JSON.stringify(payload)),
          });
        },
      },
      new InMemoryEvidenceStore(),
    );
    expect(windowStarts).toEqual([
      "20260917",
      "20261015",
      "20261112",
      "20261210",
    ]);
    expect(result.coverage.covered_windows).toHaveLength(4);
    expect(result.records).toHaveLength(2);
  });

  it("filters a short window by the actual departure date", async () => {
    const payload = response();
    const firstRow = payload.grmData[0]!;
    payload.grmData.push({
      ...firstRow,
      grmSeq: 2,
      mthVvdCd: "HHSU0160E",
      mthCssmObVoyNo: "0160E",
      transit: [
        {
          ...firstRow.transit[0]!,
          arvlStDt: "2026-09-28T23:00:00",
          dpartFnshDt: "2026-10-10T15:30:00",
          vvdCd: "HHSU0160E",
          cssmObVoyNo: "0160E",
        },
      ],
    });
    const adapter = createHmmAdapter();
    const result = await adapter.query(
      context("2026-09-17", "2026-09-20"),
      {
        request(input: CarrierHttpRequest) {
          if (input.path.endsWith("/ScheduleMain.do")) {
            return Promise.resolve({
              status: 200,
              url: "https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do",
              contentType: "text/html",
              headers: {},
              body: new TextEncoder().encode(
                '<meta name="_csrf" content="synthetic" />',
              ),
            });
          }
          if (input.path.endsWith("/apiPointToPointList.do")) {
            return Promise.resolve({
              status: 200,
              url: "https://www.hmm21.com/e-service/general/schedule/apiPointToPointList.do",
              contentType: "application/json",
              headers: {},
              body: new TextEncoder().encode(
                JSON.stringify({
                  RTN_STS: "OK",
                  RTN_DATA: { resultData: { resultCode: "S", GrmNo: "SYNTH" } },
                }),
              ),
            });
          }
          return Promise.resolve({
            status: 200,
            url: "https://www.hmm21.com/e-service/general/schedule/selectPointToPointList.do",
            contentType: "application/json",
            headers: {},
            body: new TextEncoder().encode(JSON.stringify(payload)),
          });
        },
      },
      new InMemoryEvidenceStore(),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.legs[0]?.events[0]?.local_date).toBe(
      "2026-09-18",
    );
  });

  it("extracts only the declared cities array and never executes trailing script", () => {
    const state = globalThis as typeof globalThis & {
      __hmmMaliciousExecuted?: boolean;
    };
    state.__hmmMaliciousExecuted = false;
    const source =
      'var cities = ["SHANGHAI,CHINA  [CNSYN]","VANCOUVER, BC, CANADA  [CASYN]"];' +
      'globalThis.__hmmMaliciousExecuted = true;';
    const candidates = parseHmmCitiesList(source);
    expect(candidates.map((candidate) => candidate.carrier_location_id)).toEqual([
      "CNSYN",
      "CASYN",
    ]);
    expect(candidates.every((candidate) => candidate.unlocode === null)).toBe(
      true,
    );
    expect(state.__hmmMaliciousExecuted).toBe(false);
    delete state.__hmmMaliciousExecuted;
  });

  it("classifies an HMM point-to-point 403 before JSON shape validation", async () => {
    const adapter = createHmmAdapter();
    await expect(
      adapter.query(
        context(),
        {
          request(input: CarrierHttpRequest) {
            if (input.path.endsWith("/ScheduleMain.do")) {
              return Promise.resolve({
                status: 200,
                url: "https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do",
                contentType: "text/html",
                headers: {},
                body: new TextEncoder().encode(
                  '<meta name="_csrf" content="synthetic" />',
                ),
              });
            }
            return Promise.resolve({
              status: 403,
              url: "https://www.hmm21.com/e-service/general/schedule/apiPointToPointList.do",
              contentType: "text/plain",
              headers: {},
              body: new Uint8Array(),
            });
          },
        },
        new InMemoryEvidenceStore(),
      ),
    ).rejects.toMatchObject({
      code: "access_restricted",
      status: "unavailable",
      message: "hmm_point_to_point_access_restricted",
    });
  });

  it("classifies an HMM select 403 before JSON shape validation", async () => {
    const adapter = createHmmAdapter();
    await expect(
      adapter.query(
        context(),
        {
          request(input: CarrierHttpRequest) {
            if (input.path.endsWith("/ScheduleMain.do")) {
              return Promise.resolve({
                status: 200,
                url: "https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do",
                contentType: "text/html",
                headers: {},
                body: new TextEncoder().encode(
                  '<meta name="_csrf" content="synthetic" />',
                ),
              });
            }
            if (input.path.endsWith("/apiPointToPointList.do")) {
              return Promise.resolve({
                status: 200,
                url: "https://www.hmm21.com/e-service/general/schedule/apiPointToPointList.do",
                contentType: "application/json",
                headers: {},
                body: new TextEncoder().encode(
                  '{"RTN_STS":"OK","RTN_DATA":{"resultData":{"resultCode":"S","GrmNo":"SYNTH"}}}',
                ),
              });
            }
            return Promise.resolve({
              status: 403,
              url: "https://www.hmm21.com/e-service/general/schedule/selectPointToPointList.do",
              contentType: "text/plain",
              headers: {},
              body: new Uint8Array(),
            });
          },
        },
        new InMemoryEvidenceStore(),
      ),
    ).rejects.toMatchObject({
      code: "access_restricted",
      status: "unavailable",
      message: "hmm_schedule_access_restricted",
    });
  });
});
