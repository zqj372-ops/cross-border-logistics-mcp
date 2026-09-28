import type {
  CalendarEvent,
  CollectorResultData,
  MissingField,
  Place,
  ScheduleRecord,
  TransportLeg,
} from "../contracts";
import { CollectorRuntimeError, signalField } from "../errors";
import { decimalMinutesToHours, eventFromCompactTimes, routingFromLegs } from "../normalize";
import type { LocationCandidate, ResolveLocationInput } from "../locations";
import type { CarrierBrowserPort, EvidenceStore } from "../ports";
import { collectWindows } from "./public-schedule";
import type { CarrierAdapter, CarrierParserContext, CarrierParserResult } from "./types";

const PARSER_VERSION = "oocl-schedule-parser@2";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  return null;
}

export function parseOoclLocations(input: unknown): readonly LocationCandidate[] {
  const root = asRecord(input), data = asRecord(root?.data);
  if (root?.success !== true || !Array.isArray(data?.results)) throw new CollectorRuntimeError("schema_changed", "unavailable", "oocl_locations_invalid");
  return data.results.map((value: unknown) => {
    const row = asRecord(value);
    const name = asArray(row?.Names).map(asRecord).find(item => item?.Language === "English");
    const id = stringValue(row?.LocationID), city = stringValue(name?.Name);
    if (!id || !/^\d+$/u.test(id) || !city || (typeof row?.LocationID === "number" && !Number.isSafeInteger(row.LocationID))) throw new CollectorRuntimeError("schema_changed", "unavailable", "oocl_location_identity_missing");
    const country = asArray(name?.Parents).map(asRecord).find(item => item?.Type === "Country");
    const code = asArray(row?.Codes).map(asRecord).find(item => item?.Standard === "UNLocode");
    const countryCode = stringValue(country?.Code), unlocode = stringValue(code?.Code);
    const fullName = [city, stringValue(name?.UpperAdministrativeLocation)].filter(Boolean).join(", ");
    return {
      name: fullName, country_code: countryCode && /^[A-Z]{2}$/u.test(countryCode) ? countryCode : null,
      type: "city" as const, carrier_location_id: id, mapping_source: "oocl_city_autocomplete", source_full_name: fullName,
      unlocode: unlocode && /^[A-Z]{2}[A-Z0-9]{3}$/u.test(unlocode) ? unlocode : null,
    };
  });
}

function rawDateValue(value: unknown): string | null {
  const direct = stringValue(value);
  if (direct !== null) return direct;
  const record = asRecord(value);
  if (record === null) return null;
  return (
    stringValue(record.dateStr) ??
    stringValue(record.date) ??
    stringValue(record.value)
  );
}

function placeFromRaw(
  value: unknown,
  type: Place["type"],
): Place | null {
  const record = asRecord(value);
  if (record === null) return null;
  const carrierLocationId =
    stringValue(record.ID) ??
    stringValue(record.id) ??
    stringValue(record.carrierLocationId);
  const name = stringValue(record.Name) ?? stringValue(record.name);
  if (carrierLocationId === null || name === null) return null;
  const code = stringValue(record.Code) ?? stringValue(record.code);
  return {
    name,
    country_code: null,
    carrier_location_id: carrierLocationId,
    unlocode:
      code !== null && /^[A-Z]{2}[A-Z0-9]{3}$/u.test(code) ? code : null,
    type,
  };
}

function eventKind(value: unknown): CalendarEvent["event_kind"] {
  const text = stringValue(value)?.toLowerCase() ?? "";
  if (text.includes("actual")) return "actual";
  if (text.includes("plan")) return "planned";
  if (text.includes("estimat") || text.includes("eta") || text.includes("etd")) {
    return "estimated";
  }
  return "unknown";
}

function parseLeg(
  rawLeg: unknown,
  index: number,
): { readonly leg: TransportLeg | null; readonly missing: readonly MissingField[] } {
  const leg = asRecord(rawLeg);
  if (leg === null) {
    return {
      leg: null,
      missing: [{ field: `legs[${index}]`, reason: "oocl_leg_not_object" }],
    };
  }
  const type = stringValue(leg.Type) ?? stringValue(leg.type) ?? "Unknown";
  const mode: TransportLeg["mode"] =
    type.toLowerCase() === "voyage" ? "ocean" :
      asRecord(leg.TransportMode)?.Code === "TRU" ? "truck" : "unknown";
  const loadingPort = placeFromRaw(
    leg.LoadingPort ?? leg.loadingPort,
    "port",
  );
  const dischargePort = placeFromRaw(
    leg.DischargePort ?? leg.dischargePort,
    "port",
  );
  // A query city is not evidence of a leg endpoint. Keep source facility IDs
  // distinct from city/port IDs, including the site's optional door legs.
  const from = loadingPort ?? (mode === "ocean" ? null : placeFromRaw(leg.OriginFacility, "unknown"));
  const to = dischargePort ?? (mode === "ocean" ? null : placeFromRaw(leg.DestinationFacility, "unknown"));
  if (from === null || to === null) {
    return {
      leg: null,
      missing: [
        {
          field: `legs[${index}].from_or_to`,
          reason: "oocl_leg_location_missing",
        },
      ],
    };
  }
  const events: CalendarEvent[] = [];
  const departure = eventFromCompactTimes({
    eventType: "departure",
    rawText:
      rawDateValue(leg.FromETDLocalDateTime) ??
      rawDateValue(leg.FromETDGmtDateTime),
    localValue: rawDateValue(leg.FromETDLocalDateTime),
    utcValue: rawDateValue(leg.FromETDGmtDateTime),
    timezone: stringValue(leg.OriginFacilityTimezoneName),
    eventKind: eventKind(leg.FromETDEventType),
    timezoneSource: "oocl_leg_timezone",
  });
  if (departure.local_date !== null || departure.utc_datetime !== null) {
    events.push(departure);
  }
  const arrival = eventFromCompactTimes({
    eventType: "arrival",
    rawText:
      rawDateValue(leg.ToETALocalDateTime) ??
      rawDateValue(leg.ToETAGmtDateTime),
    localValue: rawDateValue(leg.ToETALocalDateTime),
    utcValue: rawDateValue(leg.ToETAGmtDateTime),
    timezone: stringValue(leg.DestinationFacilityTimezoneName),
    eventKind: eventKind(leg.ToETAEventType),
    timezoneSource: "oocl_leg_timezone",
  });
  if (arrival.local_date !== null || arrival.utc_datetime !== null) {
    events.push(arrival);
  }
  const vesselName = stringValue(leg.VesselName) ?? stringValue(leg.vesselName);
  const voyage =
    stringValue(leg.ExternalVoyageReference) ??
    stringValue(leg.Voyage) ??
    stringValue(leg.voyage);
  const missing: MissingField[] = [];
  if (vesselName === null && mode === "ocean") {
    missing.push({ field: `legs[${index}].vessel_name`, reason: "not_provided" });
  }
  if (voyage === null && mode === "ocean") {
    missing.push({ field: `legs[${index}].voyage`, reason: "not_provided" });
  }
  if (mode === "ocean") {
    for (const event of ["departure", "arrival"] as const) {
      if (!events.some(item => item.event_type === event)) missing.push({ field: `legs[${index}].${event}`, reason: "not_provided" });
    }
  }
  return {
    leg: {
      sequence: index + 1,
      mode,
      source_leg_id:
        stringValue(leg.LegId) ??
        stringValue(leg.LegID) ??
        stringValue(leg.Id) ??
        stringValue(leg.ComponentId),
      vessel_name: vesselName,
      voyage,
      from,
      to,
      events,
    },
    missing,
  };
}

function cutoffFromRoute(
  rawRoute: Record<string, unknown>,
): ScheduleRecord["cutoffs"]["cy"] {
  const local = rawDateValue(rawRoute.CargoCutoffLocalDateTime);
  const utc = rawDateValue(rawRoute.CargoCutoffGmtDateTime);
  if (local === null && utc === null) return null;
  const parsed =
    local === null ? null : eventFromCompactTimes({
      eventType: "departure",
      rawText: local,
      localValue: local,
      utcValue: utc,
      timezone: null,
      eventKind: "estimated",
      timezoneSource: "oocl_cutoff",
    });
  return {
    at: parsed?.local_datetime ?? parsed?.utc_datetime ?? null,
    precision: parsed === null ? "unknown" : "datetime",
    place: null,
    conditions: [],
    source_text: local ?? utc,
  };
}

function parseRoute(
  rawRoute: unknown,
  index: number,
  context: CarrierParserContext,
): {
  readonly record: ScheduleRecord | null;
  readonly missing: readonly MissingField[];
} {
  const route = asRecord(rawRoute);
  if (route === null) {
    return {
      record: null,
      missing: [{ field: `standardRoutes[${index}]`, reason: "not_object" }],
    };
  }
  const parsedLegs = asArray(route.Legs ?? route.legs).map((leg, legIndex) =>
    parseLeg(leg, legIndex),
  );
  const legs = parsedLegs
    .map((entry) => entry.leg)
    .filter((leg): leg is TransportLeg => leg !== null);
  const missing = parsedLegs.flatMap((entry) => entry.missing);
  if (legs.length === 0) {
    return {
      record: null,
      missing: [
        ...missing,
        { field: `standardRoutes[${index}].legs`, reason: "no_parseable_leg" },
      ],
    };
  }
  const oceanLegs = legs.filter((leg) => leg.mode === "ocean");
  const pol = oceanLegs[0]?.from ?? null;
  const pod = oceanLegs.at(-1)?.to ?? null;
  const routeId =
    stringValue(route.RouteId) ??
    stringValue(route.routeId) ??
    `route-${index + 1}`;
  const transitMinutes = numberValue(
    route.TransitTimeInMinute ?? route.transitTimeInMinute,
  );
  const record: ScheduleRecord = {
    record_id: `oocl-route-${routeId}`,
    source_itinerary_id: routeId,
    operating_carrier: null,
    service_name: null,
    routing: routingFromLegs(route.Routing ?? route.routing, legs),
    query_origin: context.origin.carrier_location_id,
    query_destination: context.destination.carrier_location_id,
    place_of_receipt: legs[0]?.from.carrier_location_id ?? null,
    place_of_delivery: legs.at(-1)?.to.carrier_location_id ?? null,
    pol,
    pod,
    terminal: null,
    legs,
    cutoffs: {
      si: null,
      vgm: null,
      cy: cutoffFromRoute(route),
      customs: null,
    },
    cargo_available_at: null,
    transit: {
      source_total_minutes:
        transitMinutes === null ? null : String(transitMinutes),
      source_total_hours:
        transitMinutes === null ? null : decimalMinutesToHours(transitMinutes),
      source_total_days: null,
      calculated_total_hours: null,
      source_ocean_minutes: null,
      source_ocean_hours: null,
      source_ocean_days: null,
      calculated_ocean_hours: null,
      basis: "source_transit_minutes",
    },
    evidence_ref: context.evidenceRef,
    observed_at: context.observedAt,
    parser_version: PARSER_VERSION,
    missing_fields: missing,
  };
  return { record, missing };
}

export function parseOoclScheduleResponse(
  input: unknown,
  context: CarrierParserContext,
): CarrierParserResult {
  const root = asRecord(input);
  const data = root === null ? null : asRecord(root.data);
  const routes = asArray(data?.standardRoutes);
  if (root?.success !== true || data === null || !Array.isArray(data.standardRoutes)) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "oocl_schedule_response_invalid",
    );
  }
  const parsed = routes.map((route, index) =>
    parseRoute(route, index, context),
  );
  const records = parsed
    .map((entry) => entry.record)
    .filter((record): record is ScheduleRecord => record !== null);
  const missing = parsed.flatMap((entry) => entry.missing);
  const numberOfRouteReturn = numberValue(data.numberOfRouteReturn);
  const complete = numberOfRouteReturn !== null && Number.isSafeInteger(numberOfRouteReturn) && numberOfRouteReturn === records.length &&
    records.length === routes.length && !missing.some(field =>
      ["oocl_leg_not_object", "oocl_leg_location_missing", "no_parseable_leg"].includes(field.reason));
  const coverage: CollectorResultData["coverage"] = {
    requested_from: context.normalizedQuery.departure_from,
    requested_until: context.normalizedQuery.departure_until,
    covered_windows: complete
      ? [
          {
            from: context.normalizedQuery.departure_from,
            until: context.normalizedQuery.departure_until,
          },
        ]
      : [],
    uncovered_windows: complete ? [] : [
      {
        from: context.normalizedQuery.departure_from,
        until: context.normalizedQuery.departure_until,
      },
    ],
    pages_read: [1],
    complete,
    truncated: !complete,
    failure_reason: complete ? null : "oocl_incomplete_routes",
  };
  return {
    records,
    coverage,
    quality: {
      key_fields_complete: missing.length === 0,
      evaluation_status: missing.length === 0 ? "evaluated" : "partial",
      conflicts: [],
      warnings: missing.length === 0 ? [] : ["oocl_missing_fields"],
      missing_field_count: missing.length,
    },
    evidenceRef: context.evidenceRef,
  };
}

export const OOCL_ADAPTER_METADATA = {
  id: "OOCL",
  displayName: "OOCL",
  adapterVersion: PARSER_VERSION,
  capabilityStatus: "implemented_unverified",
  provenanceKind: "live",
  lastLiveVerifiedAt: null,
} as const;

export function createOoclParserAdapter(browser?: CarrierBrowserPort): CarrierAdapter {
  return {
    metadata: OOCL_ADAPTER_METADATA,
    async resolveLocations(input): Promise<readonly LocationCandidate[]> {
      if (browser?.available) {
        const result = await browser.search({ carrier: "OOCL", query: { operation: "locations", text: input.text }, ...signalField(input.signal) });
        if (result.status !== 200) throw new CollectorRuntimeError("access_restricted", "unavailable", "oocl_locations_access_restricted");
        return parseOoclLocations(JSON.parse(new TextDecoder().decode(result.body)) as unknown)
          .filter(candidate => (input.countryCode === null || candidate.country_code === input.countryCode) &&
            (!input.carrierLocationId || candidate.carrier_location_id === input.carrierLocationId));
      }
      return Promise.reject(
        new CollectorRuntimeError(
          "auth_required",
          "blocked",
          "oocl_browser_egress_not_configured",
        ),
      );
    },
    query(
      context,
      _http,
      _evidence,
    ): Promise<CarrierParserResult> {
      if (browser?.available) return collectWindows(context, _http, _evidence, {
        carrier: "OOCL", days: 28,
        fetch: (from, until) => browser.search({ carrier: "OOCL", query: { operation: "schedules",
          origin: { id: context.origin.carrier_location_id, name: context.origin.name },
          destination: { id: context.destination.carrier_location_id, name: context.destination.name }, from, until,
        }, ...signalField(context.signal) }),
        parse: (body, parserContext) => parseOoclScheduleResponse(JSON.parse(body) as unknown, parserContext),
      });
      return Promise.reject(
        new CollectorRuntimeError(
          "auth_required",
          "blocked",
          "oocl_captcha_browser_flow_not_configured",
        ),
      );
    },
  };
}

function matchesCandidate(
  candidate: LocationCandidate,
  input: ResolveLocationInput,
): boolean {
  if (input.carrier_location_id !== null) {
    return (
      candidate.carrier_location_id === input.carrier_location_id &&
      (input.country_code === null || candidate.country_code === input.country_code)
    );
  }
  return (
    candidate.name.trim().toLocaleLowerCase() ===
      input.text.trim().toLocaleLowerCase() &&
    (input.country_code === null ||
      candidate.country_code === input.country_code)
  );
}

export function createSyntheticOoclAdapter(options: {
  readonly origin: readonly LocationCandidate[];
  readonly destination: readonly LocationCandidate[];
  readonly response: unknown;
  readonly observedAt: string;
}): CarrierAdapter {
  const metadata = {
    id: "OOCL",
    displayName: "OOCL synthetic fixture",
    adapterVersion: PARSER_VERSION,
    capabilityStatus: "synthetic_only",
    provenanceKind: "synthetic",
    lastLiveVerifiedAt: null,
  } as const;
  return {
    metadata,
    resolveLocations(input): Promise<readonly LocationCandidate[]> {
      const all = [...options.origin, ...options.destination];
      const candidates =
        input.carrierLocationId === undefined || input.carrierLocationId === null
          ? input.text.trim().toLocaleLowerCase() ===
            options.origin[0]?.name.trim().toLocaleLowerCase()
            ? options.origin
            : options.destination
          : all.filter(
              (candidate) =>
                candidate.carrier_location_id === input.carrierLocationId,
            );
      return Promise.resolve(
        candidates.filter((candidate) =>
          matchesCandidate(candidate, {
            text: input.text,
            country_code: input.countryCode,
            carrier_location_id: input.carrierLocationId ?? null,
          }),
        ),
      );
    },
    async query(context, _http, evidence: EvidenceStore) {
      const bytes = new TextEncoder().encode(JSON.stringify(options.response));
      const reference = await evidence.write({
        requestId: context.requestId,
        carrier: metadata.id,
        kind: "fixture",
        mediaType: "application/json",
        bytes,
        redactions: ["synthetic_fixture"],
        ...signalField(context.signal),
      });
      return parseOoclScheduleResponse(options.response, {
        ...context,
        evidenceRef: reference.ref,
        observedAt: options.observedAt,
      });
    },
  };
}
