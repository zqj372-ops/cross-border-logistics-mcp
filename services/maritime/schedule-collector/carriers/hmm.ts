import type {
  CalendarEvent,
  MissingField,
  Place,
  ScheduleRecord,
  TransportLeg,
} from "../contracts";
import {
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

const PARSER_VERSION = "hmm-schedule-parser@1";
const MAIN_PATH = "/e-service/general/schedule/ScheduleMain.do";
const LOCATION_PATH = "/data_files/ebiz/locationJS/CitiesList.js";
const POINT_TO_POINT_PATH =
  "/e-service/general/schedule/apiPointToPointList.do";
const SELECT_PATH =
  "/e-service/general/schedule/selectPointToPointList.do";

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

function decodeText(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function decodeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(decodeText(body));
  } catch {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "hmm_json_invalid",
    );
  }
}

function place(
  name: string | null,
  code: string | null,
  facilityName: string | null,
  facilityCode: string | null,
): Place | null {
  if (name === null && facilityName === null) return null;
  const locationName = facilityName ?? name;
  const locationCode = facilityCode ?? code;
  if (locationName === null || locationCode === null) return null;
  return {
    name: locationName,
    country_code:
      code !== null && /^[A-Z]{2}/u.test(code) ? code.slice(0, 2) : null,
    carrier_location_id: locationCode ?? locationName,
    unlocode: null,
    type: facilityCode === null ? "port" : "terminal",
  };
}

function portPlace(name: string | null, code: string | null): Place | null {
  if (name === null && code === null) return null;
  const locationName = name ?? code;
  const locationCode = code ?? name;
  if (locationName === null || locationCode === null) return null;
  return {
    name: locationName,
    country_code:
      code !== null && /^[A-Z]{2}/u.test(code) ? code.slice(0, 2) : null,
    carrier_location_id: locationCode,
    unlocode: null,
    type: "port",
  };
}

function localDateTime(
  value: unknown,
  eventType: CalendarEvent["event_type"],
): CalendarEvent | null {
  const raw = stringValue(value);
  if (
    raw === null ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u.test(raw)
  ) {
    return null;
  }
  const local = `${raw.slice(0, 10)}T${raw.slice(11, 19).padEnd(8, ":00")}`;
  return {
    event_type: eventType,
    raw_text: raw,
    local_date: raw.slice(0, 10),
    local_datetime: local,
    utc_datetime: null,
    offset: null,
    timezone: null,
    precision: "local_datetime",
    event_kind: "estimated",
    timezone_source: "not_provided",
  };
}

function cutoff(
  value: unknown,
  sourceField: string,
): ScheduleRecord["cutoffs"]["cy"] {
  const raw = stringValue(value);
  if (raw === null) return null;
  return {
    at: /^\d{4}-\d{2}-\d{2}T/u.test(raw) ? raw : null,
    precision: /^\d{4}-\d{2}-\d{2}T/u.test(raw) ? "datetime" : "unknown",
    place: null,
    conditions: [`source_field:${sourceField}`],
    source_text: raw,
  };
}

function modeFromCode(value: unknown): TransportLeg["mode"] {
  switch (stringValue(value)?.toUpperCase()) {
    case "MM":
    case "VESSEL":
      return "ocean";
    case "RA":
    case "RAIL":
      return "rail";
    case "TR":
    case "TK":
    case "TRUCK":
      return "truck";
    case "BG":
    case "BARGE":
      return "barge";
    default:
      return "unknown";
  }
}

function routingFromLegs(
  legs: readonly TransportLeg[],
): ScheduleRecord["routing"] {
  const oceanLegs = legs.filter((leg) => leg.mode === "ocean");
  if (oceanLegs.length === 0) return "unknown";
  if (oceanLegs.length === 1) {
    const oceanLeg = oceanLegs[0];
    return oceanLeg?.vessel_name !== null &&
      oceanLeg?.voyage !== null &&
      legs.every((leg) => leg.mode === "ocean")
      ? "direct"
      : "unknown";
  }
  const vesselKeys = new Set(
    oceanLegs.flatMap((leg) =>
      leg.vessel_name === null
        ? []
        : [`${leg.vessel_name}\u0000${leg.voyage ?? ""}`],
    ),
  );
  return vesselKeys.size > 1 ? "transshipment" : "unknown";
}

function stagePlace(
  item: Record<string, unknown>,
  prefix: "org" | "destn",
  mode: TransportLeg["mode"],
): Place | null {
  const locationName = stringValue(item[`${prefix}LocNm`]);
  const locationCode = stringValue(item[`${prefix}LocCd`]);
  const facilityName = stringValue(item[`${prefix}FcltyNm`]);
  const facilityCode = stringValue(item[`${prefix}FcltyCd`]);
  const value = place(locationName, locationCode, facilityName, facilityCode);
  if (value !== null && mode !== "ocean") {
    return { ...value, type: "unknown" };
  }
  return value;
}

function parseHmmRecord(
  row: unknown,
  sequence: number,
  context: CarrierParserContext,
): {
  readonly record: ScheduleRecord | null;
  readonly missing: readonly MissingField[];
  readonly warnings: readonly string[];
  readonly conflicts: readonly string[];
  readonly keyFieldsComplete: boolean;
} {
  const item = asRecord(row);
  if (item === null) {
    return {
      record: null,
      missing: [{ field: `grmData[${sequence}]`, reason: "not_object" }],
      warnings: [],
      conflicts: [],
      keyFieldsComplete: false,
    };
  }
  const missing: MissingField[] = [];
  const warnings: string[] = [];
  const conflicts: string[] = [];
  const vesselName = stringValue(item.mthVslNm);
  const internalVoyage = stringValue(item.mthVvdCd);
  const commercialVoyage = stringValue(item.mthCssmObVoyNo);
  const operator = stringValue(item.mthVslCarrCd);
  const grmNo = stringValue(item.grmNo);
  const grmSeq = numberValue(item.grmSeq) ?? sequence;
  if (vesselName === null) {
    missing.push({ field: `grmData[${sequence}].mthVslNm`, reason: "not_provided" });
  }
  if (internalVoyage === null && commercialVoyage === null) {
    missing.push({
      field: `grmData[${sequence}].mthVvdCd_or_mthCssmObVoyNo`,
      reason: "not_provided",
    });
  }
  if (grmNo === null) {
    missing.push({ field: `grmData[${sequence}].grmNo`, reason: "not_provided" });
  }
  const pol = portPlace(
    stringValue(item.polLocNm),
    stringValue(item.polLocCd),
  );
  const pod = portPlace(
    stringValue(item.podLocNm),
    stringValue(item.podLocCd),
  );
  if (pol === null) {
    missing.push({ field: `grmData[${sequence}].polLocNm`, reason: "not_provided" });
  }
  if (pod === null) {
    missing.push({ field: `grmData[${sequence}].podLocNm`, reason: "not_provided" });
  }
  const transit = asArray(item.transit);
  if (!Array.isArray(item.transit) || transit.length === 0) {
    missing.push({ field: `grmData[${sequence}].transit`, reason: "not_provided" });
  }
  const legs: TransportLeg[] = [];
  transit.forEach((entry, index) => {
    const leg = asRecord(entry);
    if (leg === null) {
      missing.push({
        field: `grmData[${sequence}].transit[${index + 1}]`,
        reason: "not_object",
      });
      return;
    }
    const mode = modeFromCode(leg.trsPtnModeCd ?? leg.trsPtnModeNm);
    const from = stagePlace(leg, "org", mode);
    const to = stagePlace(leg, "destn", mode);
    if (from === null || to === null) {
      missing.push({
        field: `grmData[${sequence}].transit[${index + 1}].from_or_to`,
        reason: "hmm_leg_location_missing",
      });
      return;
    }
    const departure = localDateTime(leg.arvlStDt, "departure");
    const arrival = localDateTime(leg.dpartFnshDt, "arrival");
    if (departure === null) {
      missing.push({
        field: `grmData[${sequence}].transit[${index + 1}].arvlStDt`,
        reason: "not_provided",
      });
    }
    if (arrival === null) {
      missing.push({
        field: `grmData[${sequence}].transit[${index + 1}].dpartFnshDt`,
        reason: "not_provided",
      });
    }
    const events = [departure, arrival].filter(
      (event): event is CalendarEvent => event !== null,
    );
    if (index > 0) {
      const previous = asRecord(transit[index - 1]);
      const previousDestination = stringValue(previous?.destnLocCd);
      const currentOrigin = stringValue(leg.orgLocCd);
      if (
        previousDestination !== null &&
        currentOrigin !== null &&
        previousDestination !== currentOrigin
      ) {
        conflicts.push(`hmm_transit_disconnected_${index}:${index + 1}`);
      }
      const previousFacility = stringValue(previous?.destnFcltyCd);
      const currentFacility = stringValue(leg.orgFcltyCd);
      if (
        previousFacility !== null &&
        currentFacility !== null &&
        previousFacility !== currentFacility
      ) {
        conflicts.push(`hmm_transit_facility_mismatch_${index}:${index + 1}`);
      }
    }
    legs.push({
      sequence: index + 1,
      mode,
      source_leg_id:
        stringValue(leg.vvdCd) ??
        stringValue(leg.grmSubSeq) ??
        `hmm-${grmNo ?? sequence}-${index + 1}`,
      vessel_name:
        stringValue(leg.vslNm) ??
        (index === 0 ? vesselName : null),
      voyage:
        stringValue(leg.cssmObVoyNo) ??
        (index === 0 ? commercialVoyage : null) ??
        (index === 0 ? internalVoyage : null),
      from,
      to,
      events,
    });
  });
  if (legs.length !== transit.length || legs.length === 0) {
    conflicts.push("hmm_transit_incomplete");
  }
  if (legs.length === 0) {
    return {
      record: null,
      missing: [
        ...missing,
        {
          field: `grmData[${sequence}].transit`,
          reason: "hmm_transit_unparseable",
        },
      ],
      warnings,
      conflicts,
      keyFieldsComplete: false,
    };
  }
  if (
    pol !== null &&
    stringValue(asRecord(transit[0])?.orgLocCd) !== pol.carrier_location_id
  ) {
    conflicts.push("hmm_first_leg_pol_mismatch");
  }
  if (
    pod !== null &&
    stringValue(asRecord(transit.at(-1))?.destnLocCd) !==
      pod.carrier_location_id
  ) {
    conflicts.push("hmm_last_leg_pod_mismatch");
  }
  if (
    pol !== null &&
    pol.carrier_location_id !== context.origin.carrier_location_id
  ) {
    conflicts.push("hmm_query_origin_mismatch");
  }
  if (
    pod !== null &&
    pod.carrier_location_id !== context.destination.carrier_location_id
  ) {
    conflicts.push("hmm_query_destination_mismatch");
  }
  const placeOfReceipt = stringValue(item.porLocCd);
  const placeOfDelivery = stringValue(item.pvyLocCd);
  if (
    placeOfReceipt !== null &&
    placeOfReceipt !== context.origin.carrier_location_id
  ) {
    conflicts.push("hmm_place_of_receipt_mismatch");
  }
  if (
    placeOfDelivery !== null &&
    placeOfDelivery !== context.destination.carrier_location_id
  ) {
    conflicts.push("hmm_place_of_delivery_mismatch");
  }
  if (stringValue(item.fcgoCtofDt) !== null) {
    warnings.push("hmm_fcgo_cutoff_not_mapped");
  }
  const totalHours = numberValue(item.totTrstmHrs);
  return {
    record: {
      record_id: `hmm-${grmNo ?? sequence}-${grmSeq}`,
      source_itinerary_id: grmNo === null ? null : `${grmNo}-${grmSeq}`,
      operating_carrier: operator,
      service_name: stringValue(item.mthLoopCd),
      routing: routingFromLegs(legs),
      query_origin: context.origin.carrier_location_id,
      query_destination: context.destination.carrier_location_id,
      place_of_receipt: placeOfReceipt,
      place_of_delivery: placeOfDelivery,
      pol,
      pod,
      terminal:
        pol === null
          ? null
          : place(
              stringValue(item.polLocNm),
              stringValue(item.polLocCd),
              stringValue(item.polFcltyNm),
              stringValue(item.polFcltyCd),
            ),
      legs,
      cutoffs: {
        si: cutoff(item.sigCtofDt, "sigCtofDt"),
        vgm: cutoff(item.vgmCtofDt, "vgmCtofDt"),
        cy: cutoff(item.portCtofDt, "portCtofDt"),
        customs: null,
      },
      cargo_available_at: null,
      transit: {
        source_total_minutes: null,
        source_total_hours: totalHours === null ? null : String(totalHours),
        source_total_days: null,
        calculated_total_hours: null,
        source_ocean_minutes: null,
        source_ocean_hours: null,
        source_ocean_days: null,
        calculated_ocean_hours: null,
        basis: "hmm_source_total_hours",
      },
      evidence_ref: context.evidenceRef,
      observed_at: context.observedAt,
      parser_version: PARSER_VERSION,
      missing_fields: missing,
    },
    missing,
    warnings,
    conflicts,
    keyFieldsComplete:
      vesselName !== null &&
      (internalVoyage !== null || commercialVoyage !== null) &&
      pol !== null &&
      pod !== null &&
      totalHours !== null &&
      missing.length === 0 &&
      conflicts.length === 0,
  };
}

export function parseHmmCitiesList(
  source: string,
): readonly LocationCandidate[] {
  const literal = extractCitiesArrayLiteral(source);
  let values: unknown;
  try {
    values = JSON.parse(literal);
  } catch {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "hmm_location_list_invalid",
    );
  }
  if (!Array.isArray(values)) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "hmm_location_list_invalid",
    );
  }
  const stringValues = values.filter(
    (value): value is string => typeof value === "string",
  );
  if (stringValues.length !== values.length) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "hmm_location_list_invalid",
    );
  }
  return stringValues.flatMap((value) => {
    const entry = /^(.*?)\s*\[([A-Z]{2}[A-Z0-9]{3})\]\s*$/u.exec(value);
    if (entry === null) return [];
    const name = entry[1]?.trim();
    const code = entry[2] ?? "";
    if (name === undefined || name === "") return [];
    return [
      {
        name,
        country_code: code.slice(0, 2),
        type: "city" as const,
        carrier_location_id: code,
        mapping_source: "hmm_cities_list",
        source_full_name: name,
        unlocode: null,
      },
    ];
  });
}

function extractCitiesArrayLiteral(source: string): string {
  const declaration = /\bvar\s+cities\s*=\s*/u.exec(source);
  if (declaration === null) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "hmm_location_list_invalid",
    );
  }
  const start = source.indexOf("[", declaration.index + declaration[0].length);
  if (start < 0) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "hmm_location_list_invalid",
    );
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
      if (depth < 0) break;
    }
  }
  throw new CollectorRuntimeError(
    "parse_error",
    "unavailable",
    "hmm_location_list_invalid",
  );
}

export function parseHmmPointToPointResponse(input: unknown): string {
  const root = asRecord(input);
  if (stringValue(root?.RTN_STS) !== "OK") {
    throw new CollectorRuntimeError(
      "access_restricted",
      "unavailable",
      "hmm_point_to_point_rejected",
    );
  }
  const result = asRecord(asRecord(root?.RTN_DATA)?.resultData);
  const grmNo = stringValue(result?.GrmNo);
  if (result?.resultCode !== "S" || grmNo === null) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "hmm_point_to_point_handle_missing",
    );
  }
  return grmNo;
}

export function parseHmmScheduleResponse(
  input: unknown,
  context: CarrierParserContext,
): CarrierParserResult {
  const root = asRecord(input);
  if (stringValue(root?.RTN_STS) !== "OK") {
    throw new CollectorRuntimeError(
      "access_restricted",
      "unavailable",
      "hmm_schedule_rejected",
    );
  }
  if (!Array.isArray(root?.grmData)) {
    throw new CollectorRuntimeError(
      "schema_changed",
      "unavailable",
      "hmm_schedule_rows_not_array",
    );
  }
  const rows = root.grmData;
  const parsed = rows.map((row, index) =>
    parseHmmRecord(row, index + 1, context),
  );
  const records = parsed
    .map((entry) => entry.record)
    .filter((record): record is ScheduleRecord => record !== null);
  const missing = parsed.flatMap((entry) => entry.missing);
  const warnings = parsed.flatMap((entry) => entry.warnings);
  const conflicts = parsed.flatMap((entry) => entry.conflicts);
  const keyFieldsComplete = parsed.every((entry) => entry.keyFieldsComplete);
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
      key_fields_complete: keyFieldsComplete,
      evaluation_status:
        missing.length === 0 &&
        conflicts.length === 0 &&
        keyFieldsComplete
          ? "evaluated"
          : "partial",
      conflicts,
      warnings: [
        ...(missing.length === 0 ? [] : ["hmm_missing_fields"]),
        ...warnings,
        ...(records.length === rows.length
          ? []
          : ["hmm_schedule_rows_unparseable"]),
      ],
      missing_field_count: missing.length,
    },
    evidenceRef: context.evidenceRef,
  };
}

function extractCsrf(html: string): {
  readonly token: string;
  readonly header: string;
} {
  const token = /<meta\s+name=["']_csrf["']\s+content=["']([^"']+)["']/u.exec(
    html,
  )?.[1];
  const header =
    /<meta\s+name=["']_csrf_header["']\s+content=["']([^"']+)["']/u.exec(
      html,
    )?.[1] ?? "X-CSRF-TOKEN";
  if (token === undefined) {
    throw new CollectorRuntimeError(
      "schema_changed",
      "unavailable",
      "hmm_csrf_missing",
    );
  }
  return { token, header };
}

function assertHmmJsonResponse(
  response: CarrierHttpResponse,
  stage: "point_to_point" | "schedule",
): void {
  if (response.status === 401 || response.status === 403) {
    throw new CollectorRuntimeError(
      "access_restricted",
      "unavailable",
      `hmm_${stage}_access_restricted`,
    );
  }
  if (
    response.status !== 200 ||
    response.contentType?.includes("json") !== true
  ) {
    throw new CollectorRuntimeError(
      "schema_changed",
      "unavailable",
      `hmm_${stage}_response_invalid_${response.status}_${response.contentType ?? "missing"}`,
    );
  }
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
    const query = input.text.trim().toLowerCase();
    const name = candidate.name.toLowerCase();
    return name === query || name.startsWith(query) || name.includes(query);
  });
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function windows(
  from: string,
  until: string,
  maximumDays = 28,
): readonly { readonly from: string; readonly until: string }[] {
  const result: { from: string; until: string }[] = [];
  let start = from;
  while (start <= until) {
    const candidate = addDays(start, maximumDays - 1);
    const end = candidate < until ? candidate : until;
    result.push({ from: start, until: end });
    start = addDays(end, 1);
  }
  return result;
}

function departureDate(record: ScheduleRecord): string | null {
  const departure = record.legs
    .flatMap((leg) => leg.events)
    .find((event) => event.event_type === "departure");
  return departure?.local_date ?? null;
}

function combineHmmResults(
  results: readonly CarrierParserResult[],
  context: CarrierParserContext,
): CarrierParserResult {
  const byId = new Map<string, ScheduleRecord>();
  for (const record of results.flatMap((result) => result.records)) {
    const departure = departureDate(record);
    if (departure === null) continue;
    const first = record.legs[0];
    const last = record.legs.at(-1);
    const key = [
      record.operating_carrier ?? "",
      first?.vessel_name ?? "",
      first?.voyage ?? "",
      departure,
      first?.from.carrier_location_id ?? "",
      last?.to.carrier_location_id ?? "",
    ].join("\u0000");
    byId.set(key, record);
  }
  const records = [...byId.values()].sort((left, right) =>
    (departureDate(left) ?? "").localeCompare(departureDate(right) ?? ""),
  );
  const missingCount = results.reduce(
    (total, result) => total + result.quality.missing_field_count,
    0,
  );
  const conflicts = [...new Set(results.flatMap((result) => result.quality.conflicts))];
  const warnings = [...new Set(results.flatMap((result) => result.quality.warnings))];
  const keyFieldsComplete = results.every(
    (result) => result.quality.key_fields_complete === true,
  );
  return {
    records,
    coverage: {
      requested_from: context.normalizedQuery.departure_from,
      requested_until: context.normalizedQuery.departure_until,
      covered_windows: results.flatMap(
        (result) => result.coverage.covered_windows,
      ),
      uncovered_windows: [],
      pages_read: [1],
      complete: results.every((result) => result.coverage.complete),
      truncated: false,
      failure_reason: null,
    },
    quality: {
      key_fields_complete: keyFieldsComplete,
      evaluation_status:
        missingCount === 0 && conflicts.length === 0 && keyFieldsComplete
          ? "evaluated"
          : "partial",
      conflicts,
      warnings,
      missing_field_count: missingCount,
    },
    evidenceRef: null,
    evidenceRefs: [...new Set(results.flatMap((result) => [
      ...(result.evidenceRef === null ? [] : [result.evidenceRef]),
      ...(result.evidenceRefs ?? []),
    ]))],
  };
}

async function queryHmmWindow(
  context: CarrierParserContext,
  http: CarrierHttpPort,
  evidence: EvidenceStore,
  csrf: { readonly token: string; readonly header: string },
  window: { readonly from: string; readonly until: string },
): Promise<CarrierParserResult> {
  const headers = {
    "content-type": "application/json;charset=UTF-8",
    origin: "https://www.hmm21.com",
    referer: "https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do",
    [csrf.header.toLowerCase()]: csrf.token,
  };
  const days =
    (Date.parse(`${window.until}T00:00:00Z`) -
      Date.parse(`${window.from}T00:00:00Z`)) /
      86_400_000 +
    1;
  const first = await http.request({
    carrier: "HMM",
    method: "POST",
    path: POINT_TO_POINT_PATH,
    headers,
    body: {
      srchPointFromCd: context.origin.carrier_location_id,
      srchCityFrom: "CY",
      srchPointToCd: context.destination.carrier_location_id,
      srchCityTo: "CY",
      srchSelPriority: "A",
      srchPorFcltyCd: "",
      srchPvyFcltyCd: "",
      paramToday: context.observedAt.slice(0, 10).replaceAll("-", ""),
      srchViewType: "L",
      srchSailDate: window.from.replaceAll("-", ""),
      srchSelWeeks: String(Math.max(1, Math.ceil(days / 7))),
      srchSelSortBy: "D",
      itemPolCd: "",
      itemPodCd: "",
    },
    ...signalField(context.signal),
  });
  assertHmmJsonResponse(first, "point_to_point");
  const grmNo = parseHmmPointToPointResponse(decodeJson(first.body));
  const second = await http.request({
    carrier: "HMM",
    method: "POST",
    path: SELECT_PATH,
    headers,
    body: {
      srchViewType: "L",
      srchGrmNo: grmNo,
      isNew: true,
      srchSelPriority: "A",
      srchSelSortBy: "D",
    },
    ...signalField(context.signal),
  });
  assertHmmJsonResponse(second, "schedule");
  const payload = decodeJson(second.body);
  const parsed = parseHmmScheduleResponse(payload, {
    ...context,
    normalizedQuery: {
      ...context.normalizedQuery,
      departure_from: window.from,
      departure_until: window.until,
    },
    evidenceRef: context.evidenceRef,
  });
  const records = parsed.records.filter((record) => {
    const departure = departureDate(record);
    return (
      departure !== null &&
      departure >= window.from &&
      departure <= window.until
    );
  });
  const reference = await evidence.write({
    requestId: context.requestId,
    carrier: "HMM",
    kind: "http_response",
    mediaType: second.contentType ?? "application/json",
    bytes: second.body,
    redactions: [],
    ...signalField(context.signal),
  });
  return {
    ...parsed,
    records: records.map((record) => ({
      ...record,
      evidence_ref: reference.ref,
    })),
    evidenceRef: reference.ref,
  };
}

export const HMM_ADAPTER_METADATA = {
  id: "HMM",
  displayName: "HMM",
  adapterVersion: PARSER_VERSION,
  capabilityStatus: "implemented_unverified",
  provenanceKind: "live",
  lastLiveVerifiedAt: null,
} as const;

export function createHmmAdapter(): CarrierAdapter {
  return {
    metadata: HMM_ADAPTER_METADATA,
    async resolveLocations(input, http): Promise<readonly LocationCandidate[]> {
      const response = await http.request({
        carrier: "HMM",
        method: "GET",
        path: LOCATION_PATH,
        ...signalField(input.signal),
      });
      return locationBody(
        input,
        parseHmmCitiesList(decodeText(response.body)),
      );
    },
    async query(
      context,
      http,
      evidence: EvidenceStore,
    ): Promise<CarrierParserResult> {
      const page = await http.request({
        carrier: "HMM",
        method: "GET",
        path: MAIN_PATH,
        ...signalField(context.signal),
      });
      const csrf = extractCsrf(decodeText(page.body));
      const results: CarrierParserResult[] = [];
      const queryWindows = windows(
        context.normalizedQuery.departure_from,
        context.normalizedQuery.departure_until,
      );
      for (const [index, window] of queryWindows.entries()) {
        throwIfAborted(context.signal);
        try {
          results.push(
            await queryHmmWindow(context, http, evidence, csrf, window),
          );
        } catch (error: unknown) {
          throwIfAborted(context.signal);
          if (results.length === 0) throw error;
          const completed = combineHmmResults(results, context);
          return {
            ...completed,
            coverage: {
              ...completed.coverage,
              complete: false,
              uncovered_windows: [
                ...completed.coverage.uncovered_windows,
                ...queryWindows.slice(index),
              ],
              failure_reason:
                error instanceof CollectorRuntimeError
                  ? error.message
                  : "hmm_window_failed",
            },
          };
        }
      }
      throwIfAborted(context.signal);
      return combineHmmResults(results, context);
    },
  };
}
