import { describe, expect, it } from "vitest";
import { parseSmlLocations, parseSmlSchedules, createSmlAdapter } from "../../../../services/maritime/schedule-collector/carriers/sml";
import { parseEvergreenLocations, parseEvergreenSchedules, evergreenRequestBody } from "../../../../services/maritime/schedule-collector/carriers/evergreen";
import { ScheduleRecordSchema } from "../../../../services/maritime/schedule-collector/contracts";
import type { CarrierParserContext } from "../../../../services/maritime/schedule-collector/carriers/types";
import type { CarrierHttpRequest } from "../../../../services/maritime/schedule-collector/ports";

const origin = { input_text: "Shanghai", name: "SHANGHAI", country_code: "CN", type: "port" as const, carrier_location_id: "CNSHA", mapping_source: "synthetic@1", source_full_name: "SHANGHAI, CHINA", unlocode: "CNSHA" };
const destination = { ...origin, input_text: "Vancouver", name: "VANCOUVER,BC", country_code: "CA", carrier_location_id: "CAVAN", source_full_name: "VANCOUVER,BC, CANADA", unlocode: "CAVAN" };
const context: CarrierParserContext = {
  requestId: "synthetic-request", evidenceRef: "evidence:synthetic", observedAt: "2026-09-27T00:00:00Z", origin, destination,
  normalizedQuery: { carrier: "SML", query_origin: origin, query_destination: destination, departure_from: "2026-09-28", departure_until: "2026-10-25", date_filter_basis: "departure_from_first_ocean_leg", routing_filter: "any" },
};
const smlRow = {
  n1stVslNm: "SYNTHETIC VESSEL 001E", n1stVvd: "TEST001E", n1stLocNm: "SHANGHAI", polYdCd: "CNSHA01", n1stPodLocNm: "VANCOUVER,BC", n1stPodYdCd: "CAVAN01",
  n1stLaneCd: "TEST", polEtdDt: "2026-10-01 18:00", podEtaDt: "2026-10-14 00:00", n2ndLocNm: "Direct", n2ndVvd: "", lstPodYdCd: "CAVAN01", cct: "2026-09-30 14:00:00.0", ttlTzDys: "13", ocnTzDys: "12", allIbInlnd: "", allObInlnd: "",
};
const smlPayload = (rows = [smlRow]) => ({ TRANS_RESULT_KEY: "S", Exception: "", count: String(rows.length), list: rows });
const emcContext: CarrierParserContext = {
  ...context, origin: { ...origin, carrier_location_id: "CNSHG", source_full_name: "SHANGHAI (CNSHA)" }, destination: { ...destination, name: "VANCOUVER, BC", carrier_location_id: "CAVCR", source_full_name: "VANCOUVER, BC (CAVAN)" },
  normalizedQuery: { ...context.normalizedQuery, carrier: "EVERGREEN" },
};
// Synthetic markup using the observed public page's columns, not a live sailing.
const emcHtml = `<div id="RoutingSearchResult">The schedules from <span class="f12wrdb2">SHANGHAI (CNSHA)</span> to <span class="f12wrdb2">VANCOUVER, BC (CAVAN)</span> after <b>SEP-28-2026</b>
<thead class="Corner"><tr><td>1</td><td>SHANGHAI</td><td>SHANGHAI</td><td>SEP-30-2026 12:00</td><td>TEST</td><td>VANCOUVER, BC</td><td>VANCOUVER, BC</td><td>13</td><td><span params="seq=11">Details</span></td><td></td></tr>
<tr><td>----</td><td>OCT-01-2026</td><td>----</td><td><span params="vslCode=TEST&voyage=001E&vslName=SYNTHETIC&#x20;VESSEL">SYNTHETIC VESSEL 001E</span></td><td>OCT-14-2026</td><td>----</td></tr><tr><td>SEP-30-2026 12:00</td></tr></thead>
<table id="detailSeq11"><table><thead><tr><th>Vessel Voyage</th></tr></thead><tr><td>1</td><td>SHANGHAI</td><td>VANCOUVER, BC</td><td>OCT-01-2026</td><td>OCT-14-2026</td><td>TEST</td><td>SYNTHETIC VESSEL 001E</td><td>13</td></tr></table>Total Transit Time (Including Waiting Time) : 13 day(s)</table></div>`;

describe("public SML and Evergreen adapters", () => {
  it("uses an offered Evergreen week window and filters the extra departure dates", () => {
    expect(evergreenRequestBody(emcContext, "2026-09-28", "2026-10-05").durationWeek).toBe("14");
    const limited = { ...emcContext, normalizedQuery: { ...emcContext.normalizedQuery, departure_until: "2026-09-30" } };
    expect(parseEvergreenSchedules(emcHtml, limited).records).toHaveLength(0);
  });
  it("decodes official location formats without evaluating source JavaScript or losing ambiguity", () => {
    expect(parseSmlLocations({ TRANS_RESULT_KEY: "S", count: "1", list: [{ locCd: "CNSHA", locNm: "SHANGHAI", locAndCntNm: "SHANGHAI, CHINA", callPortFlg: "Y" }] })[0]).toMatchObject({ carrier_location_id: "CNSHA", country_code: "CN", type: "port" });
    const values = parseEvergreenLocations('[["VANCOUVER\\x252c\\x2520BC\\x2520\\x2528CAVAN\\x2529","CAVCR","VANCOUVER\\x252c\\x2520BC"],["NORTH VANCOUVER (CAVAC)","CAVOC","NORTH VANCOUVER"]]');
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({ name: "VANCOUVER, BC", carrier_location_id: "CAVCR", unlocode: "CAVAN" });
    expect(() => parseEvergreenLocations('alert("not data")')).toThrow();
  });

  it("preserves SML local estimates, voyage, cutoff, and source transit without inventing UTC", () => {
    const result = parseSmlSchedules(smlPayload(), context);
    expect(result.quality.key_fields_complete).toBe(true);
    const record = ScheduleRecordSchema.parse(result.records[0]);
    expect(record.legs[0]).toMatchObject({ vessel_name: "SYNTHETIC VESSEL", voyage: "001E", events: [expect.objectContaining({ local_datetime: "2026-10-01T18:00:00", utc_datetime: null, event_kind: "estimated" }), expect.objectContaining({ local_date: "2026-10-14" })] });
    expect(record.cutoffs.cy?.at).toBe("2026-09-30T14:00:00");
    expect(record.transit.source_ocean_days).toBe("12");
    expect(record.operating_carrier).toBeNull();
  });

  it("fails closed on source errors, count mismatch, malformed rows and changed HTML", () => {
    for (const input of [{ ...smlPayload(), TRANS_RESULT_KEY: "F" }, { ...smlPayload(), count: "2" }, smlPayload([{ ...smlRow, polEtdDt: "2026-02-30 00:00" }])]) {
      expect(() => parseSmlSchedules(input, context)).toThrow();
    }
    expect(() => parseEvergreenSchedules('<html>Security Check</html>', emcContext)).toThrow();
    expect(() => parseEvergreenSchedules(emcHtml.replace('id="detailSeq11"', 'id="changed"'), emcContext)).toThrow();
  });

  it("does not accept source endpoint conflicts or unrepresented inland transport", () => {
    expect(parseSmlSchedules(smlPayload([{ ...smlRow, polYdCd: "CNNGB01" }]), context).quality.key_fields_complete).toBe(false);
    expect(parseSmlSchedules(smlPayload([{ ...smlRow, allIbInlnd: "RAIL" }]), context).quality.key_fields_complete).toBe(false);
    expect(parseEvergreenSchedules(emcHtml.replace('from <span class="f12wrdb2">SHANGHAI', 'from <span class="f12wrdb2">NINGBO'), emcContext).quality.key_fields_complete).toBe(false);
  });

  it("extracts Evergreen dates without assigning vessel ownership or a midnight time", () => {
    const result = parseEvergreenSchedules(emcHtml, emcContext);
    expect(result.quality.key_fields_complete).toBe(true);
    const record = ScheduleRecordSchema.parse(result.records[0]);
    expect(record.operating_carrier).toBeNull();
    expect(record.legs[0]).toMatchObject({ voyage: "001E", events: [expect.objectContaining({ local_date: "2026-10-01", local_datetime: null, precision: "date" }), expect.objectContaining({ local_date: "2026-10-14" })] });
    expect(record.cutoffs.vgm?.conditions).toContain("EDI/WEB/APP");
  });

  it("keeps successful windows and their evidence when the next source call fails", async () => {
    const requests: CarrierHttpRequest[] = [];
    const result = await createSmlAdapter().query({ ...context, normalizedQuery: { ...context.normalizedQuery, departure_until: "2026-11-10" } }, { request(input) {
      requests.push(input);
      if (requests.length > 1) throw new Error("source down");
      return Promise.resolve({ status: 200, url: "https://esvc.smlines.com/smline/CUP_HOM_3001GS.do", contentType: "application/json", headers: {}, body: new TextEncoder().encode(JSON.stringify(smlPayload())) });
    } }, { write(input) { expect(input.mediaType).toBe("application/json"); expect(() => { JSON.parse(new TextDecoder().decode(input.bytes)); }).not.toThrow(); return Promise.resolve({ ref: "evidence:synthetic-window", sha256: "a".repeat(64), byteLength: 1, storedAt: context.observedAt }); }, read() { return Promise.resolve(new Uint8Array()); } });
    expect(requests[0]?.body).toMatchObject({ frm_dt: "2026-09-28", to_dt: "2026-10-27" });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.evidence_ref).toBe("evidence:synthetic-window");
    expect(result.coverage).toMatchObject({ complete: false, uncovered_windows: [{ from: "2026-10-28", until: "2026-11-10" }] });
  });
});
