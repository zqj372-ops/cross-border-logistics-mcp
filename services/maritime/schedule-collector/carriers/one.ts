import type {
  CalendarEvent,
  MissingField,
  Place,
  ScheduleRecord,
  TransportLeg,
} from "../contracts";
import {
  abortErrorFromSignal,
  CollectorRuntimeError,
  signalField,
  throwIfAborted,
} from "../errors";
import type { LocationCandidate } from "../locations";
import type {
  CarrierHttpPort,
  CarrierHttpResponse,
  EvidenceStore,
} from "../ports";
import type {
  CarrierAdapter,
  CarrierParserContext,
  CarrierParserResult,
} from "./types";

const PARSER_VERSION = "one-schedule-parser@1";
const LOCATION_PATH = "/api/v1/schedule/point-to-point/search";
const SCHEDULE_PATH = "/api/v1/schedule/point-to-point";
const MAX_WINDOW_DAYS = 42;
const REQUEST_DISCLOSURE_WARNINGS = [
  "one_request_terms_cy_cy",
  "one_cargo_nature_gp_only",
] as const;

const COUNTRY_CODES: Readonly<Record<string, string>> = {
  CANADA: "CA",
  CHINA: "CN",
  "HONG KONG": "HK",
  JAPAN: "JP",
  "REPUBLIC OF KOREA": "KR",
  SINGAPORE: "SG",
  TAIWAN: "TW",
  "UNITED STATES": "US",
};

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
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (
    typeof value === "string" &&
    /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)
  ) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function decodeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "one_json_invalid",
    );
  }
}

function localDateTime(value: string | null): {
  readonly date: string;
  readonly datetime: string;
} | null {
  if (value === null) return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (match === null) return null;
  const date = match[1] ?? "";
  const hour = match[2] ?? "";
  const minute = match[3] ?? "";
  const second = match[4] ?? "00";
  const parsed = new Date(`${date}T${hour}:${minute}:${second}Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date ||
    parsed.toISOString().slice(11, 19) !== `${hour}:${minute}:${second}`
  ) {
    return null;
  }
  return {
    date,
    datetime: `${date}T${hour}:${minute}:${second}.000`,
  };
}

function eventFromValue(
  eventType: "departure" | "arrival",
  value: unknown,
): CalendarEvent {
  const raw = stringValue(value);
  const parsed = localDateTime(raw);
  return {
    event_type: eventType,
    raw_text: raw,
    local_date: parsed?.date ?? null,
    local_datetime: parsed?.datetime ?? null,
    utc_datetime: null,
    offset: null,
    timezone: null,
    precision: parsed === null ? "unknown" : "local_datetime",
    event_kind: "estimated",
    timezone_source: "not_provided",
  };
}

function cutoff(
  value: unknown,
): ScheduleRecord["cutoffs"]["cy"] {
  const raw = stringValue(value);
  const parsed = localDateTime(raw);
  if (parsed === null) return null;
  return {
    at: parsed.datetime,
    precision: "datetime",
    place: null,
    conditions: [],
    source_text: raw,
  };
}

function countryCode(value: unknown): string | null {
  const source = stringValue(value)?.toUpperCase() ?? null;
  if (source === null) return null;
  return COUNTRY_CODES[source] ?? (source.length === 2 ? source : null);
}

function placeFromJourney(
  journey: Record<string, unknown>,
  side: "pol" | "pod",
  mode: TransportLeg["mode"],
): Place | null {
  const name = stringValue(journey[`${side}Name`]);
  const code = stringValue(journey[`${side}Code`]);
  const country = countryCode(journey[`${side}CountryName`]);
  if (name === null || code === null) return null;
  return {
    name,
    country_code: country,
    carrier_location_id: code,
    unlocode: null,
    type:
      mode === "ocean"
        ? "port"
        : mode === "unknown"
          ? "unknown"
          : "inland",
  };
}

function terminalFromJourney(
  journey: Record<string, unknown>,
): Place | null {
  const name = stringValue(journey.polYardName);
  const code = stringValue(journey.polYardCode);
  const country = countryCode(journey.polCountryName);
  if (name === null || code === null) return null;
  return {
    name,
    country_code: country,
    carrier_location_id: code,
    unlocode: null,
    type: "terminal",
  };
}

function modeFromJourney(
  journey: Record<string, unknown>,
): TransportLeg["mode"] {
  const transferMode = stringValue(journey.transferMode)?.toUpperCase() ?? "";
  switch (transferMode) {
    case "":
    case "VESSEL":
      return stringValue(journey.vesselName) === null ? "unknown" : "ocean";
    case "RAIL":
      return "rail";
    case "TRUCK":
      return "truck";
    case "BARGE":
    case "WATER":
      return "barge";
    default:
      return "unknown";
  }
}

function matchingSailInfo(
  journey: Record<string, unknown>,
  sailInfo: readonly Record<string, unknown>[],
): Record<string, unknown> | null {
  const vesselName = stringValue(journey.vesselName);
  if (vesselName !== null) {
    const byName = sailInfo.find(
      (candidate) => stringValue(candidate.vvdName) === vesselName,
    );
    if (byName !== undefined) return byName;
  }
  const polYardCode = stringValue(journey.polYardCode);
  const podYardCode = stringValue(journey.podYardCode);
  const departureDate = stringValue(journey.departureDate);
  return (
    sailInfo.find(
      (candidate) =>
        stringValue(candidate.polYardCode) === polYardCode &&
        stringValue(candidate.podYardCode) === podYardCode &&
        stringValue(candidate.departureDate) === departureDate,
    ) ?? null
  );
}

function vesselIdentity(
  journey: Record<string, unknown>,
  sail: Record<string, unknown> | null,
): { readonly name: string | null; readonly voyage: string | null } {
  const fullName = stringValue(journey.vesselName);
  const name =
    stringValue(journey.vsslName) ?? stringValue(sail?.vsslName) ?? null;
  if (fullName !== null && name !== null && fullName.startsWith(name)) {
    const voyage = fullName.slice(name.length).trim();
    return { name, voyage: voyage === "" ? null : voyage };
  }
  return {
    name: name ?? fullName,
    voyage: null,
  };
}

function sourceRouting(
  value: unknown,
): "direct" | "transshipment" | null {
  switch (stringValue(value)?.toUpperCase()) {
    case "DIRECT":
      return "direct";
    case "TRANSSHIPMENT":
    case "TRANSHIPMENT":
      return "transshipment";
    default:
      return null;
  }
}

function derivedRouting(
  legs: readonly TransportLeg[],
): "direct" | "transshipment" | "unknown" {
  const oceanLegs = legs.filter((leg) => leg.mode === "ocean");
  if (oceanLegs.length === 0) return "unknown";
  return oceanLegs.length === 1 ? "direct" : "transshipment";
}

function sourceConflicts(
  line: Record<string, unknown>,
  records: readonly Record<string, unknown>[],
  context: CarrierParserContext,
  routing: "direct" | "transshipment" | "unknown",
): readonly string[] {
  const conflicts: string[] = [];
  const first = records[0];
  const last = records.at(-1);
  if (stringValue(first?.polCode) !== context.origin.carrier_location_id) {
    conflicts.push("one_query_origin_mismatch");
  }
  if (stringValue(last?.podCode) !== context.destination.carrier_location_id) {
    conflicts.push("one_query_destination_mismatch");
  }
  const source = sourceRouting(line.transshipmentType);
  if (source !== null && routing !== "unknown" && source !== routing) {
    conflicts.push("one_routing_echo_mismatch");
  }
  return conflicts;
}

function parseLine(
  rawLine: unknown,
  sequence: number,
  context: CarrierParserContext,
): {
  readonly record: ScheduleRecord | null;
  readonly missing: readonly MissingField[];
  readonly warnings: readonly string[];
  readonly conflicts: readonly string[];
} {
  const line = asRecord(rawLine);
  if (line === null) {
    return {
      record: null,
      missing: [
        { field: `scheduleLines[${sequence}]`, reason: "not_object" },
      ],
      warnings: [],
      conflicts: [],
    };
  }
  const journeys = asArray(line.journeys);
  const sailInfo = asArray(line.sailInfo)
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => value !== null);
  if (!Array.isArray(line.journeys) || journeys.length === 0) {
    return {
      record: null,
      missing: [
        {
          field: `scheduleLines[${sequence}].journeys`,
          reason: "not_provided",
        },
      ],
      warnings: [],
      conflicts: [],
    };
  }
  const missing: MissingField[] = [];
  const warnings: string[] = [];
  const parsedJourneys = journeys.map(asRecord);
  if (parsedJourneys.some((journey) => journey === null)) {
    return {
      record: null,
      missing: [
        {
          field: `scheduleLines[${sequence}].journeys`,
          reason: "not_object",
        },
      ],
      warnings: [],
      conflicts: [],
    };
  }
  const rawJourneys = parsedJourneys.filter(
    (value): value is Record<string, unknown> => value !== null,
  );
  const legs: TransportLeg[] = [];
  rawJourneys.forEach((journey, index) => {
    const mode = modeFromJourney(journey);
    const from = placeFromJourney(journey, "pol", mode);
    const to = placeFromJourney(journey, "pod", mode);
    const sail = matchingSailInfo(journey, sailInfo);
    const vessel = vesselIdentity(journey, sail);
    const departure = eventFromValue("departure", journey.departureDate);
    const arrival = eventFromValue("arrival", journey.berthingDate);
    if (from === null || to === null) {
      missing.push({
        field: `scheduleLines[${sequence}].journeys[${index}].from_or_to`,
        reason: "one_leg_location_missing",
      });
      return;
    }
    if (mode === "ocean" && vessel.name === null) {
      missing.push({
        field: `scheduleLines[${sequence}].journeys[${index}].vesselName`,
        reason: "not_provided",
      });
    }
    if (mode === "ocean" && vessel.voyage === null) {
      missing.push({
        field: `scheduleLines[${sequence}].journeys[${index}].voyage`,
        reason: "not_provided",
      });
    }
    if (departure.local_date === null) {
      missing.push({
        field: `scheduleLines[${sequence}].journeys[${index}].departureDate`,
        reason: "not_provided",
      });
    }
    if (arrival.local_date === null) {
      missing.push({
        field: `scheduleLines[${sequence}].journeys[${index}].berthingDate`,
        reason: "not_provided",
      });
    }
    if (mode === "unknown") {
      missing.push({
        field: `scheduleLines[${sequence}].journeys[${index}].transferMode`,
        reason: "one_transport_mode_unknown",
      });
    }
    legs.push({
      sequence: index + 1,
      mode,
      source_leg_id:
        stringValue(sail?.vvd) ??
        stringValue(journey.vvd) ??
        `one-${stringValue(line.trunkVvd) ?? sequence}-${index + 1}`,
      vessel_name: mode === "ocean" ? vessel.name : null,
      voyage: mode === "ocean" ? vessel.voyage : null,
      from,
      to,
      events: [departure, arrival].filter(
        (event) => event.local_date !== null,
      ),
    });
  });
  if (legs.length !== rawJourneys.length || legs.length === 0) {
    return {
      record: null,
      missing: [
        ...missing,
        {
          field: `scheduleLines[${sequence}].journeys`,
          reason: "one_journey_unparseable",
        },
      ],
      warnings,
      conflicts: [],
    };
  }
  const routing = derivedRouting(legs);
  const conflicts = sourceConflicts(line, rawJourneys, context, routing);
  const oceanLegs = legs.filter((leg) => leg.mode === "ocean");
  const firstOcean = oceanLegs[0];
  const lastOcean = oceanLegs.at(-1);
  if (firstOcean === undefined || lastOcean === undefined) {
    return {
      record: null,
      missing: [
        ...missing,
        {
          field: `scheduleLines[${sequence}].journeys`,
          reason: "one_ocean_leg_missing",
        },
      ],
      warnings,
      conflicts,
    };
  }
  const firstJourney = rawJourneys[0];
  const totalSeconds = numberValue(line.totalTransitTimeInSeconds);
  const oceanSeconds = numberValue(line.oceanTransitTimeInSeconds);
  if (totalSeconds === null) {
    missing.push({
      field: `scheduleLines[${sequence}].totalTransitTimeInSeconds`,
      reason: "not_provided",
    });
  }
  if (oceanSeconds === null) {
    missing.push({
      field: `scheduleLines[${sequence}].oceanTransitTimeInSeconds`,
      reason: "not_provided",
    });
  }
  if (stringValue(line.dct) !== null) {
    warnings.push("one_document_cutoff_not_mapped");
  }
  const sourceId =
    stringValue(line.trunkVvd) ??
    `${stringValue(line.polCode) ?? "origin"}-${stringValue(line.podCode) ?? "destination"}-${sequence}`;
  const firstLeg = legs[0];
  const lastLeg = legs.at(-1);
  const record: ScheduleRecord = {
    record_id: `one-${sourceId}-${sequence}`,
    source_itinerary_id: sourceId,
    operating_carrier: null,
    service_name:
      stringValue(sailInfo[0]?.serviceLaneCode) ??
      stringValue(firstJourney?.serviceLane),
    routing,
    query_origin: context.origin.carrier_location_id,
    query_destination: context.destination.carrier_location_id,
    place_of_receipt:
      firstLeg?.mode === "ocean"
        ? null
        : firstLeg?.from.carrier_location_id ?? null,
    place_of_delivery:
      lastLeg?.mode === "ocean"
        ? null
        : lastLeg?.to.carrier_location_id ?? null,
    pol: firstOcean.from,
    pod: lastOcean.to,
    terminal: terminalFromJourney(firstJourney ?? {}),
    legs,
    cutoffs: {
      si: null,
      vgm: cutoff(line.vgmCct),
      cy: cutoff(line.cct),
      customs: null,
    },
    cargo_available_at:
      localDateTime(stringValue(line.lastCyAvailableDate))?.datetime ?? null,
    transit: {
      source_total_minutes:
        totalSeconds === null ? null : String(Math.trunc(totalSeconds / 60)),
      source_total_hours:
        totalSeconds === null ? null : String(totalSeconds / 3600),
      source_total_days: stringValue(line.displayTransitDays),
      calculated_total_hours: null,
      source_ocean_minutes:
        oceanSeconds === null ? null : String(Math.trunc(oceanSeconds / 60)),
      source_ocean_hours:
        oceanSeconds === null ? null : String(oceanSeconds / 3600),
      source_ocean_days: null,
      calculated_ocean_hours: null,
      basis: "one_source_transit_seconds",
    },
    evidence_ref: context.evidenceRef,
    observed_at: context.observedAt,
    parser_version: PARSER_VERSION,
    missing_fields: missing,
  };
  return { record, missing, warnings, conflicts };
}

function emptyResult(
  context: CarrierParserContext,
): CarrierParserResult {
  return {
    records: [],
    coverage: {
      requested_from: context.normalizedQuery.departure_from,
      requested_until: context.normalizedQuery.departure_until,
      covered_windows: [
        {
          from: context.normalizedQuery.departure_from,
          until: context.normalizedQuery.departure_until,
        },
      ],
      uncovered_windows: [],
      pages_read: [1],
      complete: true,
      truncated: false,
      failure_reason: null,
    },
    quality: {
      key_fields_complete: true,
      evaluation_status: "evaluated",
      conflicts: [],
      warnings: [...REQUEST_DISCLOSURE_WARNINGS],
      missing_field_count: 0,
    },
    evidenceRef: context.evidenceRef,
  };
}

export function parseOneLocationResponse(
  input: unknown,
): readonly LocationCandidate[] {
  const root = asRecord(input);
  if (root === null || !Array.isArray(root.points)) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "one_location_response_invalid",
    );
  }
  const seen = new Set<string>();
  return asArray(root.points).flatMap((item) => {
    const point = asRecord(item);
    if (point === null || stringValue(point.termCd) !== "Y") return [];
    const code = stringValue(point.code);
    const name = stringValue(point.name);
    const country = countryCode(point.countryCode);
    if (code === null || name === null) return [];
    const key = `${code}\u0000${country ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        name,
        country_code: country,
        type: "city" as const,
        carrier_location_id: code,
        mapping_source: "one_point_to_point_search",
        source_full_name: name,
        unlocode: null,
      },
    ];
  });
}

export function parseOneScheduleResponse(
  input: unknown,
  context: CarrierParserContext,
): CarrierParserResult {
  const root = asRecord(input);
  if (root === null || !Array.isArray(root.scheduleLines)) {
    throw new CollectorRuntimeError(
      "schema_changed",
      "unavailable",
      "one_schedule_response_invalid",
    );
  }
  if (root.scheduleLines.length === 0) return emptyResult(context);
  if (root.scheduleLines.length > 500) {
    throw new CollectorRuntimeError(
      "incomplete_results",
      "unavailable",
      "one_schedule_record_limit_exceeded",
    );
  }
  const parsed = root.scheduleLines.map((line, index) =>
    parseLine(line, index + 1, context),
  );
  const records = parsed
    .map((entry) => entry.record)
    .filter((record): record is ScheduleRecord => record !== null);
  if (records.length !== root.scheduleLines.length) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "one_schedule_rows_unparseable",
    );
  }
  const missing = records.flatMap((record) => record.missing_fields);
  const warnings = [
    ...new Set([
      ...REQUEST_DISCLOSURE_WARNINGS,
      ...parsed.flatMap((entry) => entry.warnings),
    ]),
  ];
  const conflicts = [...new Set(parsed.flatMap((entry) => entry.conflicts))];
  return {
    records,
    coverage: {
      requested_from: context.normalizedQuery.departure_from,
      requested_until: context.normalizedQuery.departure_until,
      covered_windows: [
        {
          from: context.normalizedQuery.departure_from,
          until: context.normalizedQuery.departure_until,
        },
      ],
      uncovered_windows: [],
      pages_read: [1],
      complete: true,
      truncated: false,
      failure_reason: null,
    },
    quality: {
      key_fields_complete:
        missing.length === 0 && conflicts.length === 0,
      evaluation_status:
        missing.length === 0 && conflicts.length === 0
          ? "evaluated"
          : "partial",
      conflicts,
      warnings,
      missing_field_count: missing.length,
    },
    evidenceRef: context.evidenceRef,
  };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function windows(
  from: string,
  until: string,
): readonly { readonly from: string; readonly until: string }[] {
  const result: { from: string; until: string }[] = [];
  let start = from;
  while (start <= until) {
    const candidate = addDays(start, MAX_WINDOW_DAYS - 1);
    const end = candidate < until ? candidate : until;
    result.push({ from: start, until: end });
    start = addDays(end, 1);
  }
  return result;
}

function departureDate(record: ScheduleRecord): string | null {
  return (
    record.legs
      .find((leg) => leg.mode === "ocean")
      ?.events.find((event) => event.event_type === "departure")
      ?.local_date ?? null
  );
}

function assertOneResponse(response: CarrierHttpResponse): void {
  switch (response.status) {
    case 200:
      return;
    case 400:
      throw new CollectorRuntimeError(
        "schema_changed",
        "unavailable",
        "one_upstream_request_invalid",
      );
    case 401:
    case 403:
    case 451:
      throw new CollectorRuntimeError(
        "access_restricted",
        "unavailable",
        "one_access_restricted",
      );
    case 429:
      throw new CollectorRuntimeError(
        "rate_limited",
        "manual_review",
        "one_rate_limited",
      );
    default:
      throw new CollectorRuntimeError(
        response.status >= 500 ? "timeout" : "access_restricted",
        "unavailable",
        `one_upstream_http_${response.status}`,
      );
  }
}

async function queryWindow(
  context: CarrierParserContext,
  http: CarrierHttpPort,
  evidence: EvidenceStore,
  window: { readonly from: string; readonly until: string },
  page: number,
): Promise<CarrierParserResult> {
  const response = await http.request({
    carrier: "ONE",
    method: "GET",
    path: SCHEDULE_PATH,
    query: {
      porCode: context.origin.carrier_location_id,
      delCode: context.destination.carrier_location_id,
      rcvTermCode: "Y",
      deTermCode: "Y",
      tsFlag:
        context.normalizedQuery.routing_filter === "direct"
          ? "D"
          : context.normalizedQuery.routing_filter === "transshipment"
            ? "T"
            : "",
      fromDate: window.from,
      toDate: window.until,
      cargoNature: "GP",
      searchType: "List",
    },
    ...signalField(context.signal),
  });
  assertOneResponse(response);
  const parsed = parseOneScheduleResponse(decodeJson(response.body), {
    ...context,
    normalizedQuery: {
      ...context.normalizedQuery,
      departure_from: window.from,
      departure_until: window.until,
    },
  });
  const records = parsed.records.filter((record) => {
    const departure = departureDate(record);
    return (
      departure === null ||
      (departure >= window.from && departure <= window.until)
    );
  });
  const hasInlandOrigin = records.some(
    (record) => record.legs[0]?.mode !== "ocean",
  );
  const reference = await evidence.write({
    requestId: context.requestId,
    carrier: "ONE",
    kind: "http_response",
    mediaType: response.contentType ?? "application/json",
    bytes: response.body,
    redactions: [],
    ...signalField(context.signal),
  });
  return {
    ...parsed,
    coverage: {
      ...parsed.coverage,
      ...(hasInlandOrigin
        ? {
            uncovered_windows: [window],
            complete: false,
            failure_reason: "one_inland_origin_date_basis_unverified",
          }
        : {}),
      pages_read: [page],
    },
    quality: {
      ...parsed.quality,
      warnings: [
        ...new Set([
          ...parsed.quality.warnings,
          ...(hasInlandOrigin
            ? ["one_inland_origin_date_basis_unverified"]
            : []),
        ]),
      ],
    },
    records: records.map((record) => ({
      ...record,
      evidence_ref: reference.ref,
    })),
    evidenceRef: reference.ref,
  };
}

function combineResults(
  results: readonly CarrierParserResult[],
  context: CarrierParserContext,
): CarrierParserResult {
  const recordsByIdentity = new Map<string, ScheduleRecord>();
  for (const record of results.flatMap((result) => result.records)) {
    const departure = departureDate(record);
    const shape = record.legs
      .map(
        (leg) =>
          `${leg.mode}:${leg.from.carrier_location_id}>${leg.to.carrier_location_id}:${leg.vessel_name ?? ""}:${leg.voyage ?? ""}`,
      )
      .join("|");
    recordsByIdentity.set(
      `${record.source_itinerary_id ?? ""}\u0000${departure ?? "unknown"}\u0000${shape}`,
      record,
    );
  }
  const records = [...recordsByIdentity.values()].sort((left, right) =>
    (departureDate(left) ?? "9999-12-31").localeCompare(
      departureDate(right) ?? "9999-12-31",
    ),
  );
  const missing = records.flatMap((record) => record.missing_fields);
  const warnings = [
    ...new Set(results.flatMap((result) => result.quality.warnings)),
  ];
  const conflicts = [
    ...new Set(results.flatMap((result) => result.quality.conflicts)),
  ];
  const coveredWindows = results.flatMap(
    (result) => result.coverage.covered_windows,
  );
  const uncoveredWindows = results.flatMap(
    (result) => result.coverage.uncovered_windows,
  );
  const failureReason =
    results.find((result) => result.coverage.failure_reason !== null)
      ?.coverage.failure_reason ?? null;
  const complete = results.every((result) => result.coverage.complete);
  return {
    records,
    coverage: {
      requested_from: context.normalizedQuery.departure_from,
      requested_until: context.normalizedQuery.departure_until,
      covered_windows: coveredWindows,
      uncovered_windows: complete ? [] : uncoveredWindows,
      pages_read: results.flatMap((result) => result.coverage.pages_read),
      complete,
      truncated: results.some((result) => result.coverage.truncated),
      failure_reason: complete
        ? null
        : failureReason ?? "one_window_incomplete",
    },
    quality: {
      key_fields_complete:
        missing.length === 0 && conflicts.length === 0,
      evaluation_status:
        missing.length === 0 && conflicts.length === 0
          ? "evaluated"
          : "partial",
      conflicts,
      warnings,
      missing_field_count: missing.length,
    },
    evidenceRef: null,
    evidenceRefs: [...new Set(results.flatMap((result) => [
      ...(result.evidenceRef === null ? [] : [result.evidenceRef]),
      ...(result.evidenceRefs ?? []),
    ]))],
  };
}

function locationBody(
  input: {
    readonly text: string;
    readonly countryCode: string | null;
    readonly carrierLocationId?: string | null;
  },
  candidates: readonly LocationCandidate[],
): readonly LocationCandidate[] {
  return candidates.filter((candidate) => {
    if (
      input.countryCode !== null &&
      candidate.country_code !== input.countryCode
    ) {
      return false;
    }
    if (
      input.carrierLocationId !== undefined &&
      input.carrierLocationId !== null
    ) {
      return candidate.carrier_location_id === input.carrierLocationId;
    }
    return (
      candidate.name.toLowerCase().includes(input.text.toLowerCase()) ||
      input.text.toLowerCase().includes(candidate.name.toLowerCase())
    );
  });
}

export const ONE_ADAPTER_METADATA = {
  id: "ONE",
  displayName: "Ocean Network Express",
  adapterVersion: PARSER_VERSION,
  capabilityStatus: "live_verified",
  provenanceKind: "live",
  lastLiveVerifiedAt: "2026-09-17T10:26:31Z",
} as const;

export function createOneAdapter(): CarrierAdapter {
  return {
    metadata: ONE_ADAPTER_METADATA,
    async resolveLocations(input, http): Promise<readonly LocationCandidate[]> {
      const response = await http.request({
        carrier: "ONE",
        method: "GET",
        path: LOCATION_PATH,
        query: {
          pointName: input.text,
          userCountryCode: input.countryCode ?? "",
          sortType: "origin",
        },
        ...signalField(input.signal),
      });
      assertOneResponse(response);
      return locationBody(
        input,
        parseOneLocationResponse(decodeJson(response.body)),
      );
    },
    async query(context, http, evidence): Promise<CarrierParserResult> {
      const results: CarrierParserResult[] = [];
      const queryWindows = windows(
        context.normalizedQuery.departure_from,
        context.normalizedQuery.departure_until,
      );
      for (const [index, window] of queryWindows.entries()) {
        throwIfAborted(context.signal);
        try {
          results.push(
            await queryWindow(context, http, evidence, window, index + 1),
          );
        } catch (error: unknown) {
          const abortError = abortErrorFromSignal(context.signal);
          if (results.length === 0) throw abortError ?? error;
          const completed = combineResults(results, context);
          return {
            ...completed,
            coverage: {
              ...completed.coverage,
              complete: false,
              uncovered_windows: [
                ...completed.coverage.uncovered_windows,
                ...queryWindows.slice(index),
              ],
              failure_reason: error instanceof CollectorRuntimeError
                ? abortError?.message ?? error.message
                : abortError?.message ?? "one_window_failed",
            },
          };
        }
      }
      throwIfAborted(context.signal);
      return combineResults(results, context);
    },
  };
}
