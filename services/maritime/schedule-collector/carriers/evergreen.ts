import { z } from "zod";
import type { Place, ScheduleRecord, TransportLeg } from "../contracts";
import type { LocationCandidate } from "../locations";
import type { CarrierAdapter, CarrierMetadata, CarrierParserContext, CarrierParserResult } from "./types";
import { signalField } from "../errors";
import { collectWindows, localEvent, parserResult, recordId, sourceError } from "./public-schedule";

export const EVERGREEN_METADATA: CarrierMetadata = { id: "EVERGREEN", displayName: "Evergreen Line", adapterVersion: "evergreen-schedule-parser@1", capabilityStatus: "live_verified", provenanceKind: "live", lastLiveVerifiedAt: "2026-09-27T09:06:04Z" };
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function plain(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/gu, "").replace(/<[^>]*>/gu, " ").replace(/&#(x[\da-f]+|\d+);/giu, (_, code: string) => {
    const n = code[0]!.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
    return n <= 0x10ffff ? String.fromCodePoint(n) : "";
  }).replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/\s+/gu, " ").trim();
}
const cells = (html: string): string[] => [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map(match => plain(match[1]!));
function isoDate(raw: string): string {
  const match = /^([A-Z]{3})-(\d{2})-(\d{4})(?: (\d{2}:\d{2}))?$/u.exec(raw);
  if (!match || !MONTHS.includes(match[1]!)) sourceError("evergreen_date_invalid");
  return `${match[3]}-${String(MONTHS.indexOf(match[1]!) + 1).padStart(2, "0")}-${match[2]}${match[4] ? `T${match[4]}:00` : ""}`;
}
export function parseEvergreenLocations(body: string): LocationCandidate[] {
  let input: unknown;
  try { input = JSON.parse(body.replace(/\\x([\da-f]{2})/giu, "\\u00$1")); } catch { sourceError("evergreen_locations_invalid"); }
  const rows = z.array(z.tuple([z.string(), z.string(), z.string()])).max(500).safeParse(input);
  if (!rows.success) sourceError("evergreen_locations_invalid");
  return rows.data.map(([label, id, name]) => {
    if (!/^[A-Z]{2}[A-Z0-9]{3}$/u.test(id)) sourceError("evergreen_location_id_invalid");
    try { label = decodeURIComponent(label); name = decodeURIComponent(name); } catch { sourceError("evergreen_location_encoding_invalid"); }
    const unlocode = /\(([A-Z]{2}[A-Z0-9]{3})\)/u.exec(label)?.[1] ?? null;
    return { name: name.replace(/\s*\[ZIP:[^\]]*\]/u, "").trim(), carrier_location_id: id, country_code: id.slice(0, 2), type: "city", unlocode, mapping_source: "evergreen-official-location@1", source_full_name: label };
  });
}
function place(name: string, context: CarrierParserContext): Place {
  const selected = [context.origin, context.destination].find(candidate => candidate.name.toUpperCase() === name.toUpperCase());
  return { name, country_code: selected?.country_code ?? null, carrier_location_id: selected?.carrier_location_id ?? recordId("evergreen-place", name), unlocode: selected?.unlocode ?? null, type: "port" };
}
export function sanitizeEvergreenEvidence(body: string): string {
  const start = body.indexOf('<div id="RoutingSearchResult">');
  if (start < 0) return sourceError("evergreen_results_marker_missing");
  // The public page embeds an anonymous session id in its Back link. Never persist it.
  return body.slice(start).split('<div class="ec-footer">')[0]!.replace(/;jsessionid=[A-Za-z0-9._-]+/giu, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "");
}
export function parseEvergreenSchedules(html: string, context: CarrierParserContext): CarrierParserResult {
  if (!html.includes('id="RoutingSearchResult"')) sourceError("evergreen_results_marker_missing");
  const conflicts: string[] = [], warnings = ["evergreen_non_reefer_only", "evergreen_dates_estimated_local"];
  const echo = [...html.matchAll(/<span class="f12wrdb2">([\s\S]*?)<\/span>/gu)].map(match => plain(match[1]!));
  if (echo.length < 2) sourceError("evergreen_query_echo_missing");
  if (echo[0] !== context.origin.source_full_name || echo[1] !== context.destination.source_full_name) conflicts.push("evergreen_query_location_mismatch");
  const dateEcho = /after\s*<b>([^<]+)<\/b>/u.exec(html)?.[1];
  if (!dateEcho || isoDate(dateEcho) !== context.normalizedQuery.departure_from) conflicts.push("evergreen_query_date_mismatch");
  const summaries = [...html.matchAll(/<thead\b[^>]*>([\s\S]*?)<\/thead>/giu)].map(match => match[1]!).filter(block => /params="seq=\d+"/u.test(block));
  // No confirmed empty-result shape has been observed. Unknown pages cannot mean zero sailings.
  if (!summaries.length) sourceError("evergreen_result_shape_unverified");
  const records: ScheduleRecord[] = summaries.map(summary => {
    const seq = /params="seq=(\d+)"/u.exec(summary)![1]!;
    const summaryRows = [...summary.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map(match => cells(match[1]!));
    if (summaryRows.length !== 3 || summaryRows[0]!.length !== 10 || summaryRows[1]!.length !== 6 || summaryRows[2]!.length !== 1) sourceError("evergreen_columns_changed");
    const [top, middle, bottom] = summaryRows as [string[], string[], string[]];
    const detailStart = html.indexOf(`id="detailSeq${seq}"`);
    if (detailStart < 0) sourceError("evergreen_route_detail_missing");
    const detail = html.slice(detailStart).split('</thead>')[1]?.split('</table>')[0];
    if (!detail) sourceError("evergreen_route_detail_invalid");
    const rows = [...detail.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map(match => cells(match[1]!));
    if (!rows.length) sourceError("evergreen_legs_missing");
    const legs: TransportLeg[] = rows.map((row, index) => {
      if (row.length !== 8 || row[0] !== String(index + 1)) sourceError("evergreen_leg_columns_changed");
      const vessel = /^(.*?)\s+([A-Z0-9-]+)$/u.exec(row[6]!);
      if (!vessel || /\b(RAIL|TRUCK|BARGE)\b/iu.test(row[6]!)) sourceError("evergreen_leg_mode_unverified");
      return { sequence: index + 1, mode: "ocean", source_leg_id: null, vessel_name: vessel[1]!, voyage: vessel[2]!, from: place(row[1]!, context), to: place(row[2]!, context), events: [localEvent(isoDate(row[3]!), "departure"), localEvent(isoDate(row[4]!), "arrival")] };
    });
    const first = legs[0]!, last = legs.at(-1)!;
    if (first.from.carrier_location_id !== context.origin.carrier_location_id || last.to.carrier_location_id !== context.destination.carrier_location_id || top[1] !== top[2] || top[5] !== top[6]) conflicts.push("evergreen_endpoint_or_inland_mismatch");
    if (first.events[0]!.local_date !== isoDate(middle[1]!) || last.events[1]!.local_date !== isoDate(middle[4]!)) conflicts.push("evergreen_summary_detail_time_mismatch");
    for (let i = 1; i < legs.length; i++) if (legs[i - 1]!.to.carrier_location_id !== legs[i]!.from.carrier_location_id) conflicts.push("evergreen_disconnected_legs");
    if (top[9]) warnings.push("evergreen_source_remark_present");
    const total = top[7]!;
    if (!/^\d+(?:\.\d+)?$/u.test(total)) sourceError("evergreen_transit_invalid");
    const cutoff = (raw: string, conditions: string[]): ScheduleRecord["cutoffs"]["cy"] => {
      if (!raw || raw === "----") return null;
      const event = localEvent(isoDate(raw), "departure");
      return { at: event.local_datetime ?? event.local_date, precision: event.precision === "date" ? "date" : "datetime", place: first.from, conditions, source_text: raw };
    };
    if (middle[2] !== "----" && middle[2] !== bottom[0]) warnings.push("evergreen_paper_vgm_cutoff_differs");
    return {
      record_id: recordId("evergreen", [top[4], legs]), source_itinerary_id: null, operating_carrier: null, service_name: top[4] || null, routing: legs.length === 1 ? "direct" : "transshipment",
      query_origin: context.origin.carrier_location_id, query_destination: context.destination.carrier_location_id, place_of_receipt: context.origin.carrier_location_id, place_of_delivery: context.destination.carrier_location_id,
      pol: first.from, pod: last.to, terminal: null, legs,
      cutoffs: { si: null, cy: cutoff(top[3]!, ["Port Cut Off Date"]), vgm: cutoff(bottom[0]!, ["EDI/WEB/APP"]), customs: null }, cargo_available_at: null,
      transit: { source_total_minutes: null, source_total_hours: null, source_total_days: total, calculated_total_hours: null, source_ocean_minutes: null, source_ocean_hours: null, source_ocean_days: null, calculated_ocean_hours: null, basis: "evergreen_source_days" },
      evidence_ref: context.evidenceRef, observed_at: context.observedAt, parser_version: EVERGREEN_METADATA.adapterVersion, missing_fields: [],
    };
  });
  return parserResult(context, records, conflicts, warnings);
}
export function evergreenRequestBody(context: CarrierParserContext, from: string, until: string): Record<string, string> {
  const duration = 7 * Math.ceil(((Date.parse(until) - Date.parse(from)) / 86400000 + 1) / 7);
  return { oriLocation: context.origin.carrier_location_id, oriLocationName: context.origin.source_full_name ?? context.origin.name, desLocation: context.destination.carrier_location_id, desLocationName: context.destination.source_full_name ?? context.destination.name, carrier: "V", serviceMode: "", isReefer: "N", func: "getSearchResult", oriUSCA: "", desUSCA: "", oriEastWest: ["US", "CA"].includes(context.origin.country_code ?? "") ? "ALL" : "", desEastWest: ["US", "CA"].includes(context.destination.country_code ?? "") ? "ALL" : "", oriUseMode: "I", desUseMode: "I", departureDate: "", departureDateShow: `${MONTHS[Number(from.slice(5, 7)) - 1]}-${from.slice(8)}-${from.slice(0, 4)}`, departureYear: from.slice(0, 4), departureMonth: from.slice(5, 7), departureDay: from.slice(8), arrivalYear: "", arrivalMonth: "", arrivalDay: "", durationWeek: String(duration), reeferCargo: "N" };
}
export function createEvergreenAdapter(): CarrierAdapter {
  return {
    metadata: EVERGREEN_METADATA,
    async resolveLocations(input, http) {
      const response = await http.request({ carrier: "EVERGREEN", method: "GET", path: "/servlet/TUF1_AutoCompleteServlet", query: { scope: "context", search: input.text, action: "preLoad", switchSql: "", datasource: "bkLocations", fromFirst: "false" }, ...signalField(input.signal) });
      if (response.status !== 200) sourceError("evergreen_location_source_unavailable");
      return parseEvergreenLocations(new TextDecoder().decode(response.body));
    },
    query: (context, http, evidence) => collectWindows(context, http, evidence, {
      carrier: "EVERGREEN", days: 28,
      request: (from, until) => ({ carrier: "EVERGREEN", method: "POST", path: "/tvs2/jsp/TVS2_InteractiveScheduleRouting.jsp", headers: { "content-type": "application/x-www-form-urlencoded" }, body: evergreenRequestBody(context, from, until) }),
      parse: parseEvergreenSchedules, sanitize: sanitizeEvergreenEvidence,
    }),
  };
}
