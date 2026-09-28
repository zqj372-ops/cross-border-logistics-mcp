import { z } from "zod";
import type { Place, ScheduleRecord } from "../contracts";
import type { LocationCandidate } from "../locations";
import type { CarrierBrowserPort } from "../ports";
import { CollectorRuntimeError, signalField } from "../errors";
import type { CarrierAdapter, CarrierMetadata, CarrierParserContext, CarrierParserResult } from "./types";
import { collectWindows, localEvent, parserResult, recordId, sourceError } from "./public-schedule";

export const MAERSK_METADATA: CarrierMetadata = { id: "MAERSK", displayName: "Maersk", adapterVersion: "maersk-schedule-parser@1", capabilityStatus: "implemented_unverified", provenanceKind: "live", lastLiveVerifiedAt: null };
const text = z.string().trim().min(1).max(200);
const geoId = z.string().regex(/^[A-Z0-9]{8,32}$/u);
export const MaerskLocationSchema = z.object({
  cityName: text, countryName: text, countryCode: z.string().regex(/^[A-Z]{2}$/u),
  regionName: text.nullish(), maerskGeoLocationId: geoId, maerskRkstCode: text,
  unLocCode: z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/u).nullish(),
  hasMaerskContainerYard: z.boolean(), type: z.enum(["CITY", "TERMINAL"]),
  localityName: text.optional(), timezoneId: text.nullish(),
});
const codes = z.array(z.object({ alternativeCodeType: text, alternativeCode: text })).min(1).max(10);
const reference = z.object({ alternativeCodes: codes });
export const MaerskConditionsSchema = z.object({
  requestType: z.literal("DATED_SCHEDULES"), exportServiceType: z.literal("CY"), importServiceType: z.literal("CY"),
  timeRange: z.object({ routingsBasedOn: z.literal("DEPARTURE_DATE"), earliestTime: z.iso.date(), latestTime: z.iso.date() }),
  startLocation: reference, endLocation: reference,
});
const call = z.object({
  location: z.object({ facility: reference.extend({ facilityCode: text }) }),
  estimatedTimeOfDeparture: text.optional(), estimatedTimeOfArrival: text.optional(),
  departureVoyageNumber: text.optional(), departureService: z.object({ serviceName: text }).optional(),
});
const routing = z.object({ routeId: text, estimatedTransitTime: text, routingLegs: z.array(z.object({
  routingLegIdentifier: text, transportMode: z.object({ transportModeCode: z.literal("MVS") }),
  carriage: z.object({ carriageType: z.literal("OCEAN"), vessel: z.object({ vesselName: text }), vesselPortCallStart: call, vesselPortCallEnd: call }),
})).min(1).max(20) });
export const MaerskRoutingResponseSchema = z.object({ routings: z.array(routing).max(500) }).strict();
const bundleSchema = MaerskRoutingResponseSchema.extend({
  facilities: z.array(MaerskLocationSchema).max(100),
  origin: MaerskLocationSchema, destination: MaerskLocationSchema, conditions: MaerskConditionsSchema,
});

export function maerskGeoId(value: z.infer<typeof reference>): string {
  const matches = value.alternativeCodes.filter(code => code.alternativeCodeType === "GEO_ID");
  if (matches.length !== 1 || !geoId.safeParse(matches[0]?.alternativeCode).success) sourceError("maersk_geographic_id_missing");
  return matches[0]!.alternativeCode;
}
export function maerskLocationLabel(location: z.infer<typeof MaerskLocationSchema>): string {
  return `${location.cityName}${location.regionName ? ` (${location.regionName})` : ""}, ${location.countryName}`;
}
export function parseMaerskLocations(input: unknown): LocationCandidate[] {
  const parsed = z.array(MaerskLocationSchema).max(100).safeParse(input);
  if (!parsed.success) sourceError("maersk_locations_invalid");
  return parsed.data.filter(item => item.type === "CITY" && item.hasMaerskContainerYard).map(item => ({
    name: item.cityName, country_code: item.countryCode, type: "city", carrier_location_id: item.maerskGeoLocationId,
    source_full_name: maerskLocationLabel(item), unlocode: item.unLocCode ?? null, mapping_source: "maersk-official-location@1",
  }));
}
function transitMinutes(value: string): string {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/u.exec(value);
  if (!match || !match.slice(1).some(Boolean)) sourceError("maersk_transit_invalid");
  return (BigInt(match[1] ?? 0) * 1440n + BigInt(match[2] ?? 0) * 60n + BigInt(match[3] ?? 0)).toString();
}

export function parseMaerskSchedules(input: unknown, context: CarrierParserContext): CarrierParserResult {
  const parsed = bundleSchema.safeParse(input);
  if (!parsed.success) sourceError("maersk_schedule_shape_invalid");
  const data = parsed.data, query = context.normalizedQuery, conditions = data.conditions;
  if (maerskGeoId(conditions.startLocation) !== context.origin.carrier_location_id ||
      maerskGeoId(conditions.endLocation) !== context.destination.carrier_location_id ||
      data.origin.maerskGeoLocationId !== context.origin.carrier_location_id ||
      data.destination.maerskGeoLocationId !== context.destination.carrier_location_id ||
      conditions.timeRange.earliestTime !== query.departure_from || conditions.timeRange.latestTime < query.departure_until) sourceError("maersk_query_identity_or_window_mismatch");
  const facilities = new Map(data.facilities.map(item => [item.maerskGeoLocationId, item]));
  if (facilities.size !== data.facilities.length) sourceError("maersk_duplicate_facility_identity");
  const conflicts: string[] = [], warnings = ["maersk_cy_cy_40_dry_high", "maersk_preferred_routes_only", "maersk_deadlines_not_collected"];
  const records: ScheduleRecord[] = data.routings.map(row => {
    // ponytail: only observed CY/CY ocean legs; reject inland shapes until verified.
    const legs = row.routingLegs.map((leg, index) => {
      const start = leg.carriage.vesselPortCallStart, end = leg.carriage.vesselPortCallEnd;
      const places = [start, end].map(portCall => {
        const id = maerskGeoId(portCall.location.facility), source = facilities.get(id);
        if (!source || source.type !== "TERMINAL" || !source.localityName || source.maerskRkstCode !== portCall.location.facility.facilityCode) sourceError("maersk_facility_identity_missing");
        const place: Place = { name: source.localityName, country_code: source.countryCode, carrier_location_id: id, unlocode: source.unLocCode ?? null, type: "terminal" };
        return { place, timezone: source.timezoneId ?? null };
      });
      if (!start.departureVoyageNumber || !start.estimatedTimeOfDeparture || !end.estimatedTimeOfArrival) sourceError("maersk_voyage_or_dates_missing");
      const events = [localEvent(start.estimatedTimeOfDeparture, "departure"), localEvent(end.estimatedTimeOfArrival, "arrival")].map((event, i) => ({ ...event, timezone: places[i]!.timezone, timezone_source: places[i]!.timezone ? "maersk_facility" : "source_not_provided" }));
      return { sequence: index + 1, mode: "ocean" as const, source_leg_id: leg.routingLegIdentifier, vessel_name: leg.carriage.vessel.vesselName, voyage: start.departureVoyageNumber, from: places[0]!.place, to: places[1]!.place, events };
    });
    const first = legs[0]!, last = legs.at(-1)!;
    if (!first.from.unlocode || first.from.unlocode !== context.origin.unlocode || first.from.country_code !== context.origin.country_code ||
        !last.to.unlocode || last.to.unlocode !== context.destination.unlocode || last.to.country_code !== context.destination.country_code) conflicts.push("maersk_query_port_mismatch");
    for (let index = 1; index < legs.length; index++) if (legs[index - 1]!.to.carrier_location_id !== legs[index]!.from.carrier_location_id) conflicts.push("maersk_disconnected_legs");
    return {
      record_id: recordId("maersk", legs), source_itinerary_id: row.routeId, operating_carrier: null,
      service_name: row.routingLegs[0]!.carriage.vesselPortCallStart.departureService?.serviceName ?? null,
      routing: legs.length === 1 ? "direct" : "transshipment", query_origin: context.origin.carrier_location_id, query_destination: context.destination.carrier_location_id,
      place_of_receipt: context.origin.carrier_location_id, place_of_delivery: context.destination.carrier_location_id, pol: first.from, pod: last.to, terminal: first.from, legs,
      cutoffs: { si: null, vgm: null, cy: null, customs: null }, cargo_available_at: null,
      transit: { source_total_minutes: transitMinutes(row.estimatedTransitTime), source_total_hours: null, source_total_days: null, calculated_total_hours: null, source_ocean_minutes: null, source_ocean_hours: null, source_ocean_days: null, calculated_ocean_hours: null, basis: "maersk_source_duration" },
      evidence_ref: context.evidenceRef, observed_at: context.observedAt, parser_version: MAERSK_METADATA.adapterVersion, missing_fields: [],
    };
  });
  return parserResult(context, records, conflicts, warnings);
}

export function createMaerskAdapter(browser?: CarrierBrowserPort): CarrierAdapter {
  const search: CarrierBrowserPort["search"] = input => {
    if (!browser?.available) throw new CollectorRuntimeError("live_not_approved", "unavailable", "maersk_browser_not_configured");
    return browser.search(input);
  };
  return {
    metadata: MAERSK_METADATA,
    async resolveLocations(input) {
      const response = await search({ carrier: "MAERSK", query: { operation: "locations", text: input.text }, ...signalField(input.signal) });
      if (response.status !== 200) throw new CollectorRuntimeError("access_restricted", "unavailable", "maersk_location_source_unavailable");
      return parseMaerskLocations(JSON.parse(new TextDecoder().decode(response.body)));
    },
    query: (context, http, evidence) => collectWindows(context, http, evidence, {
      carrier: "MAERSK", days: 28,
      fetch: (from, until) => search({ carrier: "MAERSK", query: { operation: "schedules", origin: { id: context.origin.carrier_location_id, name: context.origin.name }, destination: { id: context.destination.carrier_location_id, name: context.destination.name }, from, until }, ...signalField(context.signal) }),
      parse: (body, parserContext) => parseMaerskSchedules(JSON.parse(body), parserContext),
    }),
  };
}
