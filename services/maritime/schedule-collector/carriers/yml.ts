import { z } from "zod";
import type { Place, ScheduleRecord, TransportLeg } from "../contracts";
import type { LocationCandidate } from "../locations";
import type { CarrierAdapter, CarrierMetadata, CarrierParserContext, CarrierParserResult } from "./types";
import { CollectorRuntimeError, signalField } from "../errors";
import { collectWindows, localEvent, parserResult, recordId, sourceError } from "./public-schedule";

export const YML_METADATA: CarrierMetadata = { id: "YML", displayName: "Yang Ming Marine Transport", adapterVersion: "yml-schedule-parser@1", capabilityStatus: "live_verified", provenanceKind: "live", lastLiveVerifiedAt: "2026-09-27T09:21:48.902Z" };
const code = z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/u), text = z.string().trim().min(1);
const legSchema = z.object({ detailSeq: z.number().int().positive(), locationCodeFrom: code, locationCodeTo: code, locationNameFrom: text, locationNameTo: text, terminalNameFrom: z.string().nullable().optional(), serviceCode: text, vesselName: text, comnVoyage: text, transitMode: z.literal("VESSEL"), etd: text, eta: text });
const rowsSchema = z.array(z.object({ placeOfReceiptCode: code, placeOfDeliveryCode: code, masterETD: text, masterETA: text, transitDays: z.number().int().nonnegative(), routeDetails: z.array(legSchema).min(1).max(20), cutoffCY: z.string().nullable(), cutoffSI: z.string().nullable(), cutoffVGM: z.string().nullable(), maintenanceInfo: z.null(), blockStatus: z.null() })).max(500);
function port(name: string, id: string): Place { return { name, carrier_location_id: id, country_code: id.slice(0, 2), unlocode: id, type: "port" }; }

export function parseYmlLocations(input: unknown): LocationCandidate[] {
  const parsed = z.array(z.object({ locationCode: code, locationName: text })).max(500).safeParse(input);
  if (!parsed.success) sourceError("yml_locations_invalid");
  return parsed.data.map(row => ({ name: row.locationName, source_full_name: row.locationName, carrier_location_id: row.locationCode, country_code: row.locationCode.slice(0, 2), unlocode: row.locationCode, type: "city", mapping_source: "yml-official-location@1" }));
}

export function parseYmlSchedules(input: unknown, context: CarrierParserContext): CarrierParserResult {
  const parsed = rowsSchema.safeParse(input);
  if (!parsed.success) sourceError("yml_schedule_shape_changed_or_restricted");
  const conflicts: string[] = [];
  const records: ScheduleRecord[] = parsed.data.map(row => {
    const legs: TransportLeg[] = row.routeDetails.map((leg, index) => {
      if (leg.detailSeq !== index + 1) sourceError("yml_leg_order_invalid");
      return { sequence: leg.detailSeq, mode: "ocean", source_leg_id: null, vessel_name: leg.vesselName, voyage: leg.comnVoyage, from: port(leg.locationNameFrom, leg.locationCodeFrom), to: port(leg.locationNameTo, leg.locationCodeTo), events: [localEvent(leg.etd.replaceAll("/", "-"), "departure"), localEvent(leg.eta.replaceAll("/", "-"), "arrival")] };
    });
    const first = legs[0]!, last = legs.at(-1)!;
    if (row.placeOfReceiptCode !== context.origin.carrier_location_id || row.placeOfDeliveryCode !== context.destination.carrier_location_id || first.from.carrier_location_id !== row.placeOfReceiptCode || last.to.carrier_location_id !== row.placeOfDeliveryCode) conflicts.push("yml_query_location_mismatch");
    if (first.events[0]!.local_date !== row.masterETD.replaceAll("/", "-") || last.events[1]!.local_date !== row.masterETA.replaceAll("/", "-")) conflicts.push("yml_summary_detail_time_mismatch");
    for (let i = 1; i < legs.length; i++) if (legs[i - 1]!.to.carrier_location_id !== legs[i]!.from.carrier_location_id) conflicts.push("yml_disconnected_legs");
    const cutoff = (raw: string | null): ScheduleRecord["cutoffs"]["cy"] => {
      if (!raw?.trim()) return null;
      if (raw === "Contact local office") return { at: null, precision: "unknown", place: first.from, conditions: ["contact_carrier"], source_text: raw };
      const at = localEvent(raw.replaceAll("/", "-"), "departure");
      return { at: at.local_datetime ?? at.local_date, precision: at.precision === "date" ? "date" : "datetime", place: first.from, conditions: [], source_text: raw };
    };
    const service = row.routeDetails.map(leg => leg.serviceCode).join(" / ");
    return {
      record_id: recordId("yml", [service, legs]), source_itinerary_id: null, operating_carrier: null, service_name: service, routing: legs.length === 1 ? "direct" : "transshipment",
      query_origin: context.origin.carrier_location_id, query_destination: context.destination.carrier_location_id, place_of_receipt: row.placeOfReceiptCode, place_of_delivery: row.placeOfDeliveryCode,
      pol: first.from, pod: last.to, terminal: null, legs, cutoffs: { cy: cutoff(row.cutoffCY), si: cutoff(row.cutoffSI), vgm: cutoff(row.cutoffVGM), customs: null }, cargo_available_at: null,
      transit: { source_total_minutes: null, source_total_hours: null, source_total_days: String(row.transitDays), calculated_total_hours: null, source_ocean_minutes: null, source_ocean_hours: null, source_ocean_days: null, calculated_ocean_hours: null, basis: "yml_source_days" },
      evidence_ref: context.evidenceRef, observed_at: context.observedAt, parser_version: YML_METADATA.adapterVersion, missing_fields: [],
    };
  });
  return parserResult(context, records, conflicts, ["yml_dates_estimated_local", "yml_port_based_schedule"]);
}

export function createYmlAdapter(): CarrierAdapter {
  return {
    metadata: YML_METADATA,
    async resolveLocations(input, http) {
      const response = await http.request({ carrier: "YML", method: "GET", path: "/api/P2P/GetLocations", query: { queryType: "F", searchByCode: "TRUE", locationName: input.text }, ...signalField(input.signal) });
      if (response.status !== 200) throw new CollectorRuntimeError("access_restricted", "unavailable", "yml_location_source_unavailable");
      return parseYmlLocations(JSON.parse(new TextDecoder().decode(response.body)));
    },
    query: (context, http, evidence) => collectWindows(context, http, evidence, {
      carrier: "YML", days: 28,
      request: (from, until) => ({ carrier: "YML", method: "GET", path: "/api/P2P/GetP2PRoutes", query: { locationCodeFrom: context.origin.carrier_location_id, serviceTermFrom: "Y", locationCodeTo: context.destination.carrier_location_id, serviceTermTo: "Y", priorityWay: "ALL", dateDefinition: "DEP", startDate: from.replaceAll("-", ""), endDate: until.replaceAll("-", "") } }),
      parse: (body, parserContext) => parseYmlSchedules(JSON.parse(body), parserContext),
    }),
  };
}
