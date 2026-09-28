import { z } from "zod";
import type { Place, ScheduleRecord, TransportLeg } from "../contracts";
import type { LocationCandidate } from "../locations";
import type { CarrierAdapter, CarrierParserContext, CarrierParserResult, CarrierMetadata } from "./types";
import { signalField } from "../errors";
import { collectWindows, localEvent, parserResult, recordId, sourceError } from "./public-schedule";

export const SML_METADATA: CarrierMetadata = { id: "SML", displayName: "SM Line", adapterVersion: "sml-schedule-parser@1", capabilityStatus: "live_verified", provenanceKind: "live", lastLiveVerifiedAt: "2026-09-27T09:06:05Z" };
const rowsSchema = z.object({ TRANS_RESULT_KEY: z.literal("S"), Exception: z.string().optional(), count: z.string().regex(/^\d+$/u), list: z.array(z.record(z.string(), z.unknown())).max(500) });
function rows(input: unknown): Record<string, unknown>[] {
  const parsed = rowsSchema.safeParse(input);
  if (!parsed.success || parsed.data.Exception || Number(parsed.data.count) !== parsed.data.list.length) sourceError("sml_response_invalid");
  return parsed.data.list;
}
function value(row: Record<string, unknown>, key: string): string {
  return typeof row[key] === "string" ? row[key].trim() : "";
}
export function parseSmlLocations(input: unknown): LocationCandidate[] {
  return rows(input).map(row => {
    const id = value(row, "locCd"), name = value(row, "locNm");
    if (!/^[A-Z]{2}[A-Z0-9]{3}$/u.test(id) || !name) sourceError("sml_location_invalid");
    return { name, carrier_location_id: id, country_code: id.slice(0, 2), type: value(row, "callPortFlg") === "Y" ? "port" : "inland", mapping_source: "sml-official-location@1", source_full_name: value(row, "locAndCntNm") || name, unlocode: id };
  });
}
function port(name: string, yard: string): Place {
  if (!name || !/^[A-Z]{2}[A-Z0-9]{3}[A-Z0-9]{2}$/u.test(yard)) sourceError("sml_leg_port_invalid");
  return { name, country_code: yard.slice(0, 2), carrier_location_id: yard.slice(0, 5), unlocode: yard.slice(0, 5), type: "port" };
}
export function parseSmlSchedules(input: unknown, context: CarrierParserContext): CarrierParserResult {
  const conflicts: string[] = [], warnings = ["sml_times_estimated_local", "sml_port_based_schedule"];
  const records: ScheduleRecord[] = rows(input).map(row => {
    const legs: TransportLeg[] = [];
    for (const [index, prefix] of ["n1st", "n2nd", "n3rd", "n4th"].entries()) {
      const label = value(row, `${prefix}VslNm`), vvd = value(row, `${prefix}Vvd`);
      if (index > 0 && !label && !vvd) continue;
      const ship = /^(.*?)\s+([A-Z0-9-]+)$/u.exec(label);
      if (!ship || !vvd.endsWith(ship[2]!)) sourceError("sml_vessel_voyage_invalid");
      const from = port(value(row, index === 0 ? "n1stLocNm" : index === 1 ? "n2ndLocNm" : `${prefix}PolLocNm`), value(row, index === 0 ? "polYdCd" : `${prefix}PolYdCd`));
      const to = port(value(row, `${prefix}PodLocNm`), value(row, `${prefix}PodYdCd`));
      legs.push({ sequence: legs.length + 1, mode: "ocean", source_leg_id: vvd, vessel_name: ship[1]!, voyage: ship[2]!, from, to, events: [localEvent(value(row, index === 0 ? "polEtdDt" : `${prefix}PolEtdDt`), "departure"), localEvent(value(row, index === 0 ? "podEtaDt" : `${prefix}PodEtaDt`), "arrival")] });
    }
    if (!legs.length) sourceError("sml_legs_missing");
    const first = legs[0]!, last = legs.at(-1)!;
    if (first.from.carrier_location_id !== context.origin.carrier_location_id || last.to.carrier_location_id !== context.destination.carrier_location_id) conflicts.push("sml_query_port_mismatch");
    if (value(row, "allIbInlnd") || value(row, "allObInlnd")) conflicts.push("sml_inland_legs_not_verified");
    for (let i = 1; i < legs.length; i++) if (legs[i - 1]!.to.carrier_location_id !== legs[i]!.from.carrier_location_id) conflicts.push("sml_disconnected_legs");
    if (value(row, "skdRmk")) warnings.push("sml_source_schedule_remark_present");
    const cutoff = value(row, "cct"), total = value(row, "ttlTzDys"), ocean = value(row, "ocnTzDys");
    if (![total, ocean].every(v => /^\d+(?:\.\d+)?$/u.test(v))) sourceError("sml_transit_invalid");
    return {
      record_id: recordId("sml", legs), source_itinerary_id: null, operating_carrier: null, service_name: value(row, "n1stLaneCd") || null, routing: legs.length === 1 ? "direct" : "transshipment",
      query_origin: context.origin.carrier_location_id, query_destination: context.destination.carrier_location_id, place_of_receipt: null, place_of_delivery: null, pol: first.from, pod: last.to, terminal: null, legs,
      cutoffs: { si: null, vgm: null, cy: cutoff ? { at: localEvent(cutoff, "departure").local_datetime, precision: "datetime", place: first.from, conditions: ["Cargo Closing Time"], source_text: cutoff } : null, customs: null }, cargo_available_at: null,
      transit: { source_total_minutes: null, source_total_hours: null, source_total_days: total, calculated_total_hours: null, source_ocean_minutes: null, source_ocean_hours: null, source_ocean_days: ocean, calculated_ocean_hours: null, basis: "sml_source_days" },
      evidence_ref: context.evidenceRef, observed_at: context.observedAt, parser_version: SML_METADATA.adapterVersion, missing_fields: [],
    };
  });
  return parserResult(context, records, conflicts, warnings);
}
export function createSmlAdapter(): CarrierAdapter {
  return {
    metadata: SML_METADATA,
    async resolveLocations(input, http) {
      const response = await http.request({ carrier: "SML", method: "GET", path: "/smline/CommonCodeGS.do", query: { f_cmd: "123", loc_nm: input.text }, ...signalField(input.signal) });
      if (response.status !== 200) sourceError("sml_location_source_unavailable");
      return parseSmlLocations(JSON.parse(new TextDecoder().decode(response.body)));
    },
    query: (context, http, evidence) => collectWindows(context, http, evidence, {
      carrier: "SML", days: 30,
      request: (from, until) => ({ carrier: "SML", method: "POST", path: "/smline/CUP_HOM_3001GS.do", headers: { "content-type": "application/x-www-form-urlencoded" }, body: { f_cmd: "3", por_cd: context.origin.carrier_location_id, del_cd: context.destination.carrier_location_id, frm_dt: from, to_dt: until, ts_ind: context.normalizedQuery.routing_filter === "direct" ? "D" : context.normalizedQuery.routing_filter === "transshipment" ? "T" : "" } }),
      parse: (body, parserContext) => parseSmlSchedules(JSON.parse(body), parserContext),
    }),
  };
}
