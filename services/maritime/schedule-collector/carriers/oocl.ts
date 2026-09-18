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
import type { EvidenceStore } from "../ports";
import type { CarrierAdapter, CarrierParserContext, CarrierParserResult } from "./types";

const PARSER_VERSION = "oocl-schedule-parser@1";

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

function fallbackPlace(location: CarrierParserContext["origin"]): Place {
  return {
    name: location.name,
    country_code: location.country_code,
    carrier_location_id: location.carrier_location_id,
    unlocode: location.unlocode,
    type: location.type,
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
  context: CarrierParserContext,
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
    type.toLowerCase() === "voyage" ? "ocean" : "unknown";
  const loadingPort = placeFromRaw(
    leg.LoadingPort ?? leg.loadingPort,
    "port",
  );
  const dischargePort = placeFromRaw(
    leg.DischargePort ?? leg.dischargePort,
    "port",
  );
  const from =
    loadingPort ??
    (index === 0 ? fallbackPlace(context.origin) : null);
  const to = dischargePort ?? fallbackPlace(context.destination);
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
  const timezone =
    stringValue(leg.OriginFacilityTimezoneName) ??
    stringValue(leg.DestinationFacilityTimezoneName) ??
    null;
  const events: CalendarEvent[] = [];
  const departure = eventFromCompactTimes({
    eventType: "departure",
    rawText:
      rawDateValue(leg.FromETDLocalDateTime) ??
      rawDateValue(leg.FromETDGmtDateTime),
    localValue: rawDateValue(leg.FromETDLocalDateTime),
    utcValue: rawDateValue(leg.FromETDGmtDateTime),
    timezone,
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
    timezone,
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
  return {
    leg: {
      sequence: index + 1,
      mode,
      source_leg_id:
        stringValue(leg.LegId) ??
        stringValue(leg.LegID) ??
        stringValue(leg.Id),
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
    parseLeg(leg, legIndex, context),
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
  if (root === null || data === null || routes.length === 0) {
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
  const numberOfRouteReturn =
    numberValue(data.numberOfRouteReturn) ?? records.length;
  const complete = numberOfRouteReturn === records.length;
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
    failure_reason: complete ? null : "oocl_route_count_mismatch",
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

export function createOoclParserAdapter(): CarrierAdapter {
  return {
    metadata: OOCL_ADAPTER_METADATA,
    resolveLocations(): Promise<readonly LocationCandidate[]> {
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
      void context;
      void _http;
      void _evidence;
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
