import type {
  CalendarEvent,
  MissingField,
  Place,
  ResolvedLocation,
  ScheduleRecord,
  TransportLeg,
} from "../contracts";
import { CollectorRuntimeError, signalField } from "../errors";
import type { LocationCandidate } from "../locations";
import type { EvidenceStore } from "../ports";
import type {
  CarrierAdapter,
  CarrierParserContext,
  CarrierParserResult,
} from "./types";

const PARSER_VERSION = "cosco-schedule-parser@1";
const LOCATION_PATH = "/ebbase/public/general/findCityDistrictByPrefix";
const SCHEDULE_PATH = "/ebschedule/public/purpoShipmentWs";

const COUNTRY_CODES: Readonly<Record<string, string>> = {
  China: "CN",
  Canada: "CA",
  "United States": "US",
  "United States of America": "US",
  USA: "US",
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  return null;
}

function decodeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "cosco_json_invalid",
    );
  }
}

function compactLocalDateTime(value: string | null): {
  readonly date: string;
  readonly datetime: string;
} | null {
  if (value === null) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (match === null) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const datetime = `${date}T${match[4]}:${match[5]}:${match[6] ?? "00"}.000`;
  return { date, datetime };
}

function eventFromValue(
  eventType: "departure" | "arrival",
  value: string | null,
): CalendarEvent {
  const parsed = compactLocalDateTime(value);
  return {
    event_type: eventType,
    raw_text: value,
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
  value: string | null,
): ScheduleRecord["cutoffs"]["cy"] {
  const parsed = compactLocalDateTime(value);
  if (parsed === null) return null;
  return {
    at: parsed.datetime,
    precision: "datetime",
    place: null,
    conditions: [],
    source_text: value,
  };
}

function place(
  name: string | null,
  code: string | null,
  countryCode: string | null,
): Place | null {
  if (name === null) return null;
  return {
    name,
    country_code: countryCode,
    carrier_location_id: code ?? name,
    unlocode: null,
    type: "port",
  };
}

function candidateCountryCode(country: string | null): string | null {
  return country === null ? null : COUNTRY_CODES[country] ?? null;
}

export function parseCoscoLocationResponse(
  input: unknown,
): readonly LocationCandidate[] {
  const root = asRecord(input);
  const content = asArray(asRecord(root?.data)?.content);
  return content.flatMap((item) => {
    const record = asRecord(item);
    if (record === null) return [];
    const id = stringValue(record.cityUuid);
    const name = stringValue(record.cityLocName);
    if (id === null || name === null) return [];
    return [
      {
        name,
        country_code: candidateCountryCode(stringValue(record.country)),
        type: "city" as const,
        carrier_location_id: id,
        mapping_source: "cosco_find_city_district",
        source_full_name: stringValue(record.fullFormate),
        unlocode: stringValue(record.unloCode),
      },
    ];
  });
}

function sourceLocationValue(location: ResolvedLocation): string {
  if (location.source_full_name === null || location.unlocode === null) {
    throw new CollectorRuntimeError(
      "schema_changed",
      "unavailable",
      "cosco_location_source_identity_missing",
    );
  }
  return `${location.source_full_name},${location.unlocode}`;
}

function sourceEchoConflicts(
  conditions: unknown,
  context: CarrierParserContext,
): readonly string[] {
  const record = asRecord(conditions);
  if (record === null) return ["cosco_schedule_conditions_missing"];
  const conflicts: string[] = [];
  if (
    stringValue(record.originCityUuid) !==
    context.origin.carrier_location_id
  ) {
    conflicts.push("cosco_origin_city_uuid_mismatch");
  }
  if (
    stringValue(record.destinationCityUuid) !==
    context.destination.carrier_location_id
  ) {
    conflicts.push("cosco_destination_city_uuid_mismatch");
  }
  const originFullName = context.origin.source_full_name;
  if (
    originFullName !== null &&
    context.origin.unlocode !== null &&
    stringValue(record.originCity) !==
      `${originFullName},${context.origin.unlocode}`
  ) {
    conflicts.push("cosco_origin_city_name_mismatch");
  }
  const destinationFullName = context.destination.source_full_name;
  if (
    destinationFullName !== null &&
    context.destination.unlocode !== null &&
    stringValue(record.destinationCity) !==
      `${destinationFullName},${context.destination.unlocode}`
  ) {
    conflicts.push("cosco_destination_city_name_mismatch");
  }
  return conflicts;
}

function parseScheduleRow(
  rawRow: unknown,
  sequence: number,
  context: CarrierParserContext,
): {
  readonly record: ScheduleRecord | null;
  readonly missing: readonly MissingField[];
  readonly keyFieldsComplete: boolean;
} {
  const row = asRecord(rawRow);
  if (row === null) {
    return {
      record: null,
      missing: [{ field: `content.data[${sequence}]`, reason: "not_object" }],
      keyFieldsComplete: false,
    };
  }
  const polName = stringValue(row.pol);
  const podName = stringValue(row.pod);
  const polId = stringValue(row.polPortCode);
  const podId = stringValue(row.podPortCode);
  const pol = place(
    polName,
    polId,
    context.origin.country_code,
  );
  const pod = place(
    podName,
    podId,
    context.destination.country_code,
  );
  if (pol === null || pod === null) {
    return {
      record: null,
      missing: [
        {
          field: `content.data[${sequence}].pol_or_pod`,
          reason: "cosco_leg_location_missing",
        },
      ],
      keyFieldsComplete: false,
    };
  }
  const vesselName = stringValue(row.vessel);
  const voyage =
    stringValue(row.extVoyage) ??
    stringValue(row.voyage) ??
    stringValue(row.newExtVoyage);
  const missing: MissingField[] = [];
  if (vesselName === null) {
    missing.push({ field: `content.data[${sequence}].vessel`, reason: "not_provided" });
  }
  if (voyage === null) {
    missing.push({ field: `content.data[${sequence}].voyage`, reason: "not_provided" });
  }
  const etdValue = stringValue(row.etd);
  const etaValue = stringValue(row.eta);
  const etd = eventFromValue("departure", etdValue);
  const eta = eventFromValue("arrival", etaValue);
  const events: CalendarEvent[] = [];
  if (etd.local_date !== null) events.push(etd);
  else missing.push({ field: `content.data[${sequence}].etd`, reason: "not_provided" });
  if (eta.local_date !== null) events.push(eta);
  else missing.push({ field: `content.data[${sequence}].eta`, reason: "not_provided" });
  const rawId = stringValue(row.id) ?? String(sequence);
  const legSequence = numberValue(row.legSequence) ?? 1;
  const deList1 = asArray(row.deList1);
  const deList2 = asArray(row.deList2);
  const direct =
    legSequence === 1 && deList1.length === 0 && deList2.length === 0;
  if (!direct) {
    missing.push({
      field: `content.data[${sequence}].routing`,
      reason: "cosco_routing_semantics_unverified",
    });
  }
  const leg: TransportLeg = {
    sequence: 1,
    mode: "ocean",
    source_leg_id: `cosco-${rawId}-${legSequence}`,
    vessel_name: vesselName,
    voyage,
    from: pol,
    to: pod,
    events,
  };
  const legs: TransportLeg[] = [leg];
  const inboundFacilityName = stringValue(row.inboundFacilityName);
  const inboundFacilityCode = stringValue(row.deliFacilityCode);
  const podFacilityCode = stringValue(row.podFacilityCode);
  const samePodFacility =
    inboundFacilityCode !== null &&
    podFacilityCode !== null &&
    inboundFacilityCode === podFacilityCode;
  let terminal: Place | null = null;
  let placeOfDelivery: string | null = null;
  if (inboundFacilityName !== null) {
    if (samePodFacility) {
      terminal = {
        name: inboundFacilityName,
        country_code: context.destination.country_code,
        carrier_location_id:
          inboundFacilityCode ?? podFacilityCode ?? inboundFacilityName,
        unlocode: null,
        type: "terminal",
      };
    } else {
      placeOfDelivery = inboundFacilityCode ?? inboundFacilityName;
      missing.push({
        field: `content.data[${sequence}].deList1_or_deList2`,
        reason:
          deList1.length > 0 || deList2.length > 0
            ? "cosco_inland_segments_unparsed"
            : "cosco_inland_leg_segments_unavailable",
      });
    }
  }
  return {
    record: {
      record_id: `cosco-${rawId}`,
      source_itinerary_id: rawId,
      operating_carrier: null,
      service_name: stringValue(row.service),
      routing: direct && placeOfDelivery === null ? "direct" : "unknown",
      query_origin: context.origin.carrier_location_id,
      query_destination: context.destination.carrier_location_id,
      place_of_receipt: null,
      place_of_delivery: placeOfDelivery,
      pol,
      pod,
      terminal,
      legs,
      cutoffs: {
        si: cutoff(stringValue(row.siCutoff)),
        vgm: cutoff(stringValue(row.vgmCutoffDt)),
        cy: cutoff(stringValue(row.cutOff)),
        customs: null,
      },
      cargo_available_at:
        compactLocalDateTime(stringValue(row.available))?.datetime ?? null,
      transit: {
        source_total_minutes: null,
        source_total_hours: null,
        source_total_days: stringValue(row.transitTime),
        calculated_total_hours: null,
        source_ocean_minutes: null,
        source_ocean_hours: null,
        source_ocean_days: null,
        calculated_ocean_hours: null,
        basis: "cosco_source_transit_days",
      },
      evidence_ref: context.evidenceRef,
      observed_at: context.observedAt,
      parser_version: PARSER_VERSION,
      missing_fields: missing,
    },
    missing,
    keyFieldsComplete:
      vesselName !== null &&
      voyage !== null &&
      etd.local_datetime !== null &&
      eta.local_datetime !== null,
  };
}

export function parseCoscoScheduleResponse(
  input: unknown,
  context: CarrierParserContext,
): CarrierParserResult {
  const root = asRecord(input);
  if (root === null) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "cosco_schedule_response_invalid",
    );
  }
  const sourceCode = stringValue(root.code);
  if (sourceCode !== "200") {
    throw new CollectorRuntimeError(
      "access_restricted",
      "unavailable",
      `cosco_upstream_code_${sourceCode ?? "missing"}`,
    );
  }
  const content = asRecord(asRecord(root.data)?.content);
  if (content === null) {
    throw new CollectorRuntimeError(
      "schema_changed",
      "unavailable",
      "cosco_schedule_response_invalid",
    );
  }
  if (!Array.isArray(content.data)) {
    throw new CollectorRuntimeError(
      "schema_changed",
      "unavailable",
      "cosco_schedule_rows_not_array",
    );
  }
  const rows = content.data;
  const echoConflicts = sourceEchoConflicts(content.conditions, context);
  if (rows.length === 0) {
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
        key_fields_complete: echoConflicts.length === 0,
        evaluation_status:
          echoConflicts.length === 0 ? "evaluated" : "partial",
        conflicts: [...echoConflicts],
        warnings:
          echoConflicts.length === 0
            ? []
            : ["cosco_source_identity_conflict"],
        missing_field_count: 0,
      },
      evidenceRef: context.evidenceRef,
    };
  }
  const parsedRows = rows.map((row, index) =>
    parseScheduleRow(row, index + 1, context),
  );
  const records = parsedRows
    .map((entry) => entry.record)
    .filter((record): record is ScheduleRecord => record !== null);
  if (records.length !== rows.length) {
    throw new CollectorRuntimeError(
      "parse_error",
      "unavailable",
      "cosco_schedule_rows_unparseable",
    );
  }
  const missing = parsedRows.flatMap((entry) => entry.missing);
  const keyFieldsComplete = parsedRows.every((entry) => entry.keyFieldsComplete);
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
        keyFieldsComplete &&
        missing.length === 0 &&
        echoConflicts.length === 0,
      evaluation_status:
        missing.length === 0 &&
        keyFieldsComplete &&
        echoConflicts.length === 0
          ? "evaluated"
          : "partial",
      conflicts: [...echoConflicts],
      warnings: [
        ...(missing.length === 0 ? [] : ["cosco_missing_fields"]),
        ...(echoConflicts.length === 0
          ? []
          : ["cosco_source_identity_conflict"]),
      ],
      missing_field_count: missing.length,
    },
    evidenceRef: context.evidenceRef,
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
    return candidate.name.toLowerCase() === input.text.toLowerCase();
  });
}

export const COSCO_ADAPTER_METADATA = {
  id: "COSCO",
  displayName: "COSCO SHIPPING Lines",
  adapterVersion: PARSER_VERSION,
  capabilityStatus: "live_verified",
  provenanceKind: "live",
  lastLiveVerifiedAt: "2026-09-17T02:49:46Z",
} as const;

export function createCoscoAdapter(): CarrierAdapter {
  return {
    metadata: COSCO_ADAPTER_METADATA,
    async resolveLocations(input, http): Promise<readonly LocationCandidate[]> {
      const response = await http.request({
        carrier: "COSCO",
        method: "GET",
        path: LOCATION_PATH,
        query: {
          prefix: input.text,
          timestamp: String(Date.now()),
        },
        ...signalField(input.signal),
      });
      return locationBody(input, parseCoscoLocationResponse(decodeJson(response.body)));
    },
    async query(context, http, evidence: EvidenceStore): Promise<CarrierParserResult> {
      const response = await http.request({
        carrier: "COSCO",
        method: "POST",
        path: SCHEDULE_PATH,
        headers: { "content-type": "application/json;charset=UTF-8" },
        body: {
          fromDate: context.normalizedQuery.departure_from,
          pickup: "B",
          delivery: "B",
          estimateDate: "D",
          toDate: context.normalizedQuery.departure_until,
          originCityUuid: context.origin.carrier_location_id,
          destinationCityUuid: context.destination.carrier_location_id,
          originCity: sourceLocationValue(context.origin),
          destinationCity: sourceLocationValue(context.destination),
          cargoNature: "All",
        },
        ...signalField(context.signal),
      });
      const reference = await evidence.write({
        requestId: context.requestId,
        carrier: "COSCO",
        kind: "http_response",
        mediaType: response.contentType ?? "application/json",
        bytes: response.body,
        redactions: [],
        ...signalField(context.signal),
      });
      return parseCoscoScheduleResponse(decodeJson(response.body), {
        ...context,
        evidenceRef: reference.ref,
      });
    },
  };
}
