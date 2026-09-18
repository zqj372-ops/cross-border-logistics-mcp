import type {
  CalendarEvent,
  CollectorQueryInput,
  NormalizedCollectorQuery,
  ResolvedLocation,
  TransportLeg,
} from "./contracts";
import {
  NormalizedCollectorQuerySchema,
  QueryLocationSchema,
} from "./contracts";
import { CollectorRuntimeError } from "./errors";
import type { Clock } from "./ports";

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return toIsoDate(value);
}

export function defaultDateWindow(
  clock: Clock,
  timeZone: string,
  days = 42,
): { readonly from: string; readonly until: string } {
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new CollectorRuntimeError(
      "validation_error",
      "needs_input",
      "collector_default_window_invalid",
    );
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(clock.now());
  } catch {
    throw new CollectorRuntimeError(
      "validation_error",
      "needs_input",
      "collector_timezone_invalid",
    );
  }
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const from = `${values.year}-${values.month}-${values.day}`;
  return { from, until: addUtcDays(from, days - 1) };
}

export function normalizeQuery(
  input: CollectorQueryInput,
  origin: ResolvedLocation,
  destination: ResolvedLocation,
  options: {
    readonly dateFilterBasis:
      | "departure_from_first_ocean_leg"
      | "departure_from_origin"
      | "unknown";
  } = { dateFilterBasis: "departure_from_first_ocean_leg" },
): NormalizedCollectorQuery {
  const query = {
    carrier: input.carrier,
    query_origin: QueryLocationSchema.parse({
      input_text: origin.input_text,
      country_code: origin.country_code,
      carrier_location_id: origin.carrier_location_id,
      mapping_source: origin.mapping_source,
      source_full_name: origin.source_full_name,
    }),
    query_destination: QueryLocationSchema.parse({
      input_text: destination.input_text,
      country_code: destination.country_code,
      carrier_location_id: destination.carrier_location_id,
      mapping_source: destination.mapping_source,
      source_full_name: destination.source_full_name,
    }),
    departure_from: input.from,
    departure_until: input.until,
    date_filter_basis: options.dateFilterBasis,
    routing_filter: input.routing,
  };
  return NormalizedCollectorQuerySchema.parse(query);
}

export function parseCompactDateTime(
  value: string | null | undefined,
): {
  readonly date: string;
  readonly datetime: string;
  readonly utcDatetime: string;
} | null {
  if (value === null || value === undefined) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?$/u.exec(
    value,
  );
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction = "000"] = match;
  const date = `${year}-${month}-${day}`;
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    return null;
  }
  if (
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return null;
  }
  const datetime = `${date}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0")}`;
  return {
    date,
    datetime,
    utcDatetime: `${datetime}Z`,
  };
}

export function eventFromCompactTimes(input: {
  readonly eventType: "departure" | "arrival";
  readonly rawText: string | null;
  readonly localValue: string | null;
  readonly utcValue: string | null;
  readonly timezone: string | null;
  readonly eventKind: CalendarEvent["event_kind"];
  readonly timezoneSource: string;
}): CalendarEvent {
  const local = parseCompactDateTime(input.localValue);
  const utc = parseCompactDateTime(input.utcValue);
  if (local !== null && utc !== null) {
    return {
      event_type: input.eventType,
      raw_text: input.rawText,
      local_date: local.date,
      local_datetime: local.datetime,
      utc_datetime: utc.utcDatetime,
      offset: null,
      timezone: input.timezone,
      precision: "local_datetime",
      event_kind: input.eventKind,
      timezone_source: input.timezoneSource,
    };
  }
  if (local !== null) {
    return {
      event_type: input.eventType,
      raw_text: input.rawText,
      local_date: local.date,
      local_datetime: local.datetime,
      utc_datetime: null,
      offset: null,
      timezone: input.timezone,
      precision: "local_datetime",
      event_kind: input.eventKind,
      timezone_source: input.timezoneSource,
    };
  }
  if (utc !== null) {
    return {
      event_type: input.eventType,
      raw_text: input.rawText,
      local_date: null,
      local_datetime: null,
      utc_datetime: utc.utcDatetime,
      offset: null,
      timezone: input.timezone,
      precision: "utc_datetime",
      event_kind: input.eventKind,
      timezone_source: input.timezoneSource,
    };
  }
  return {
    event_type: input.eventType,
    raw_text: input.rawText,
    local_date: null,
    local_datetime: null,
    utc_datetime: null,
    offset: null,
    timezone: input.timezone,
    precision: "unknown",
    event_kind: input.eventKind,
    timezone_source: input.timezoneSource,
  };
}

export function routingFromLegs(
  sourceRouting: unknown,
  legs: readonly Pick<TransportLeg, "mode">[],
): "direct" | "transshipment" | "unknown" {
  void legs;
  if (sourceRouting === "direct" || sourceRouting === "transshipment") {
    return sourceRouting;
  }
  return "unknown";
}

export function decimalMinutesToHours(
  minutes: number | null | undefined,
): string | null {
  if (
    minutes === null ||
    minutes === undefined ||
    !Number.isSafeInteger(minutes) ||
    minutes < 0
  ) {
    return null;
  }
  const whole = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return String(whole);
  return (minutes / 60).toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}
