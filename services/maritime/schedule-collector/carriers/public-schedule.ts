import { createHash } from "node:crypto";
import { CalendarEventSchema, type CalendarEvent, type ScheduleRecord } from "../contracts";
import { addUtcDays } from "../normalize";
import { CollectorRuntimeError, signalField, throwIfAborted } from "../errors";
import type { CarrierHttpPort, CarrierHttpRequest, CarrierHttpResponse, EvidenceStore } from "../ports";
import type { CarrierParserContext, CarrierParserResult } from "./types";

export function sourceError(message: string): never {
  throw new CollectorRuntimeError("schema_changed", "unavailable", message);
}

export function localEvent(raw: string, eventType: CalendarEvent["event_type"]): CalendarEvent {
  const value = raw.trim().replace(" ", "T").replace(/\.0$/u, "");
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const datetime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value) ? `${value}:00` : value;
  const parsed = CalendarEventSchema.safeParse({
    event_type: eventType, raw_text: raw, local_date: value.slice(0, 10),
    local_datetime: dateOnly ? null : datetime, utc_datetime: null, offset: null,
    timezone: null, precision: dateOnly ? "date" : "local_datetime", event_kind: "estimated", timezone_source: "source_not_provided",
  });
  if (!parsed.success) sourceError("public_schedule_time_invalid");
  return parsed.data;
}

export function recordId(carrier: string, value: unknown): string {
  return `${carrier.toLowerCase()}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
}

export function parserResult(context: CarrierParserContext, records: ScheduleRecord[], conflicts: string[], warnings: string[]): CarrierParserResult {
  const query = context.normalizedQuery;
  const missing = records.reduce((sum, record) => sum + record.missing_fields.length, 0);
  return {
    records: records.filter(record => {
      const date = record.legs.find(leg => leg.mode === "ocean")?.events.find(event => event.event_type === "departure")?.local_date;
      return date !== null && date !== undefined && date >= query.departure_from && date <= query.departure_until &&
        (query.routing_filter === "any" || record.routing === query.routing_filter || record.routing === "unknown");
    }),
    coverage: { requested_from: query.departure_from, requested_until: query.departure_until, covered_windows: [{ from: query.departure_from, until: query.departure_until }], uncovered_windows: [], pages_read: [1], complete: true, truncated: false, failure_reason: null },
    quality: { key_fields_complete: conflicts.length === 0 && missing === 0, evaluation_status: conflicts.length === 0 && missing === 0 ? "evaluated" : "partial", conflicts: [...new Set(conflicts)], warnings: [...new Set(warnings)], missing_field_count: missing },
    evidenceRef: context.evidenceRef,
  };
}

// Public sources limit date windows. Retain completed windows if a later one fails.
export async function collectWindows(context: CarrierParserContext, http: CarrierHttpPort, evidence: EvidenceStore, options: {
  carrier: string; days: number;
  parse: (body: string, context: CarrierParserContext) => CarrierParserResult;
  sanitize?: (body: string) => string;
} & ({ request: (from: string, until: string) => CarrierHttpRequest; fetch?: never } |
  { request?: never; fetch: (from: string, until: string) => Promise<CarrierHttpResponse> })): Promise<CarrierParserResult> {
  const query = context.normalizedQuery;
  const results: CarrierParserResult[] = [];
  const covered: { from: string; until: string }[] = [];
  const refs: string[] = [];
  let from = query.departure_from;
  let failure: string | null = null;
  while (from <= query.departure_until) {
    throwIfAborted(context.signal);
    const until = [addUtcDays(from, options.days - 1), query.departure_until].sort()[0]!;
    try {
      const response = options.fetch ? await options.fetch(from, until) :
        await http.request({ ...options.request(from, until), ...signalField(context.signal) });
      if (response.status !== 200) throw new CollectorRuntimeError("access_restricted", "unavailable", `${options.carrier.toLowerCase()}_http_${response.status}`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      const sourceText = options.sanitize ? options.sanitize(text) : text;
      const bytes = new TextEncoder().encode(JSON.stringify(options.sanitize ? { source_html: sourceText } : JSON.parse(sourceText)));
      const reference = await evidence.write({ requestId: context.requestId, carrier: options.carrier, kind: "http_response", mediaType: "application/json", bytes, redactions: options.sanitize ? ["session_ids_and_page_chrome"] : [], ...signalField(context.signal) });
      refs.push(reference.ref);
      const parsed = options.parse(sourceText, { ...context, evidenceRef: reference.ref, normalizedQuery: { ...query, departure_from: from, departure_until: until } });
      results.push(parsed);
      covered.push(...parsed.coverage.covered_windows);
      from = addUtcDays(until, 1);
    } catch (error) {
      throwIfAborted(context.signal);
      if (results.length === 0) throw error;
      failure = error instanceof CollectorRuntimeError ? error.code : "unexpected_error";
      break;
    }
  }
  const records = [...new Map(results.flatMap(result => result.records).map(record => [record.record_id, record])).values()];
  const combined = parserResult(context, records, results.flatMap(result => result.quality.conflicts), results.flatMap(result => result.quality.warnings));
  return {
    ...combined,
    coverage: { ...combined.coverage, covered_windows: covered, uncovered_windows: [...results.flatMap(result => result.coverage.uncovered_windows), ...(failure ? [{ from, until: query.departure_until }] : [])], pages_read: results.map((_, i) => i + 1), complete: failure === null && results.every(result => result.coverage.complete), truncated: results.some(result => result.coverage.truncated), failure_reason: failure ?? results.find(result => !result.coverage.complete)?.coverage.failure_reason ?? null },
    quality: { ...combined.quality, key_fields_complete: failure === null && results.every(result => result.quality.key_fields_complete === true), evaluation_status: failure || results.some(result => result.quality.evaluation_status !== "evaluated") ? "partial" : "evaluated", missing_field_count: results.reduce((n, result) => n + result.quality.missing_field_count, 0) },
    evidenceRef: refs[0] ?? null, evidenceRefs: refs,
  };
}
