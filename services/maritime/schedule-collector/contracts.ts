import { z } from "zod";

import {
  CARRIER_IDS,
  normalizeCarrierId,
} from "./carriers/aliases";

export { CARRIER_IDS } from "./carriers/aliases";

export const COLLECTOR_CONTRACT_VERSION =
  "ocean-schedule-collector@2026-09-17.v1" as const;

export const CARRIER_CAPABILITY_STATUSES = [
  "not_probed",
  "probed",
  "implemented_unverified",
  "synthetic_only",
  "live_verified",
  "blocked",
  "unsupported",
] as const;

export const COLLECTOR_RUN_STATUSES = [
  "ok",
  "no_results",
  "partial",
  "failed",
  "unsupported",
  "not_run",
] as const;

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const versionToken = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const evidenceReference = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const shortText = z.string().trim().min(1).max(500);
const optionalShortText = shortText.nullable();
const countryCode = z.string().regex(/^[A-Z]{2}$/u);
const dateOnly = z.string().refine(isValidDateOnly, "invalid_calendar_date");
const offsetDateTime = z
  .string()
  .refine(isValidOffsetDateTime, "invalid_offset_datetime");
const localDateTime = z
  .string()
  .refine(isValidLocalDateTime, "invalid_local_datetime");
const decimalString = z.string().regex(/^(0|[1-9]\d*)(?:\.\d+)?$/u);
const carrierInput = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value, context) => {
    const normalized = normalizeCarrierId(value);
    if (normalized === null) {
      context.addIssue({
        code: "custom",
        message: "unsupported carrier",
      });
      return z.NEVER;
    }
    return normalized;
  });

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (days[month - 1] ?? 0);
}

function matchDate(value: string): readonly number[] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidDateParts(year, month, day) ? [year, month, day] : null;
}

function isValidDateOnly(value: string): boolean {
  return matchDate(value) !== null;
}

function isValidTimeParts(
  hour: number,
  minute: number,
  second: number,
): boolean {
  return (
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function isValidLocalDateTime(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(
      value,
    );
  if (match === null || matchDate(match[1] ?? "") === null) return false;
  return isValidTimeParts(
    Number(match[2]),
    Number(match[3]),
    Number(match[4] ?? "0"),
  );
}

function isValidOffsetDateTime(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (
    match === null ||
    matchDate(match[1] ?? "") === null ||
    !isValidTimeParts(Number(match[2]), Number(match[3]), Number(match[4]))
  ) {
    return false;
  }
  if (match[6] === "Z") return true;
  const offsetHour = Number(match[7]);
  const offsetMinute = Number(match[8]);
  return (
    offsetHour >= 0 &&
    offsetHour <= 14 &&
    offsetMinute >= 0 &&
    offsetMinute <= 59 &&
    (offsetHour !== 14 || offsetMinute === 0)
  );
}

export const LocationQuerySchema = z
  .object({
    text: shortText,
    country_code: countryCode.nullable(),
    carrier_location_id: identifier.nullable(),
  })
  .strict();

export const CollectorQueryInputSchema = z
  .object({
    carrier: carrierInput,
    origin: LocationQuerySchema,
    destination: LocationQuerySchema,
    from: dateOnly,
    until: dateOnly,
    routing: z.enum(["any", "direct", "transshipment"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.until < value.from) {
      context.addIssue({
        code: "custom",
        path: ["until"],
        message: "until must not be before from",
      });
      return;
    }
    const days =
      (Date.parse(`${value.until}T00:00:00Z`) -
        Date.parse(`${value.from}T00:00:00Z`)) /
      86_400_000;
    if (!Number.isFinite(days) || days > 89) {
      context.addIssue({
        code: "custom",
        path: ["until"],
        message: "inclusive collector query window must not exceed 90 days",
      });
    }
  });

export const LocationTypeSchema = z.enum([
  "city",
  "port",
  "terminal",
  "inland",
  "unknown",
]);

export const ResolvedLocationSchema = z
  .object({
    input_text: shortText,
    name: shortText,
    country_code: countryCode.nullable(),
    type: LocationTypeSchema,
    carrier_location_id: identifier,
    mapping_source: versionToken,
    source_full_name: shortText.nullable().default(null),
    unlocode: z
      .string()
      .regex(/^[A-Z]{2}[A-Z0-9]{3}$/u)
      .nullable(),
  })
  .strict();

export const QueryLocationSchema = z
  .object({
    input_text: shortText,
    country_code: countryCode.nullable(),
    carrier_location_id: identifier,
    mapping_source: versionToken,
    source_full_name: shortText.nullable().default(null),
  })
  .strict();

export const NormalizedCollectorQuerySchema = z
  .object({
    carrier: z.enum(CARRIER_IDS),
    query_origin: QueryLocationSchema,
    query_destination: QueryLocationSchema,
    departure_from: dateOnly,
    departure_until: dateOnly,
    date_filter_basis: z.enum([
      "departure_from_first_ocean_leg",
      "departure_from_origin",
      "unknown",
    ]),
    routing_filter: z.enum(["any", "direct", "transshipment"]),
  })
  .strict();

export const PlaceSchema = z
  .object({
    name: shortText,
    country_code: countryCode.nullable(),
    carrier_location_id: identifier,
    unlocode: z
      .string()
      .regex(/^[A-Z]{2}[A-Z0-9]{3}$/u)
      .nullable(),
    type: LocationTypeSchema,
  })
  .strict();

export const CalendarEventSchema = z
  .object({
    event_type: z.enum(["departure", "arrival"]),
    raw_text: optionalShortText,
    local_date: dateOnly.nullable(),
    local_datetime: localDateTime.nullable(),
    utc_datetime: offsetDateTime.nullable(),
    offset: z.string().regex(/^[+-]\d{2}:\d{2}$/u).nullable(),
    timezone: shortText.nullable(),
    precision: z.enum([
      "date",
      "local_datetime",
      "utc_datetime",
      "unknown",
    ]),
    event_kind: z.enum(["planned", "estimated", "actual", "unknown"]),
    timezone_source: identifier,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.precision === "date") {
      if (
        value.local_date === null ||
        value.local_datetime !== null ||
        value.utc_datetime !== null ||
        value.offset !== null
      ) {
        context.addIssue({
          code: "custom",
          path: ["precision"],
          message:
            "date precision requires local_date and forbids a derived instant",
        });
      }
    }
    if (value.precision === "local_datetime") {
      if (value.local_date === null || value.local_datetime === null) {
        context.addIssue({
          code: "custom",
          path: ["precision"],
          message:
            "local_datetime precision requires local_date and local_datetime",
        });
      }
      if (value.local_datetime !== null) {
        const localDate = value.local_datetime.slice(0, 10);
        if (value.local_date !== null && localDate !== value.local_date) {
          context.addIssue({
            code: "custom",
            path: ["local_date"],
            message: "local_date must match local_datetime",
          });
        }
      }
    }
    if (value.precision === "utc_datetime") {
      if (value.utc_datetime === null) {
        context.addIssue({
          code: "custom",
          path: ["precision"],
          message: "utc_datetime precision requires utc_datetime",
        });
      }
    }
    if (value.precision === "unknown") {
      if (
        value.local_date !== null ||
        value.local_datetime !== null ||
        value.utc_datetime !== null ||
        value.offset !== null ||
        value.timezone !== null
      ) {
        context.addIssue({
          code: "custom",
          path: ["precision"],
          message: "unknown precision cannot contain a normalized time",
        });
      }
    }
  });

export const TransportLegSchema = z
  .object({
    sequence: z.number().int().positive(),
    mode: z.enum(["ocean", "rail", "truck", "barge", "unknown"]),
    source_leg_id: identifier.nullable(),
    vessel_name: optionalShortText,
    voyage: z.string().trim().min(1).max(80).nullable(),
    from: PlaceSchema,
    to: PlaceSchema,
    events: z.array(CalendarEventSchema).max(20),
  })
  .strict();

const CutoffSchema = z
  .object({
    at: z.union([dateOnly, localDateTime, offsetDateTime]).nullable(),
    precision: z.enum(["date", "datetime", "unknown"]),
    place: PlaceSchema.nullable(),
    conditions: z.array(shortText).max(20),
    source_text: optionalShortText,
  })
  .strict();

export const TransitSchema = z
  .object({
    source_total_minutes: decimalString.nullable(),
    source_total_hours: decimalString.nullable(),
    source_total_days: decimalString.nullable(),
    calculated_total_hours: decimalString.nullable(),
    source_ocean_minutes: decimalString.nullable(),
    source_ocean_hours: decimalString.nullable(),
    source_ocean_days: decimalString.nullable(),
    calculated_ocean_hours: decimalString.nullable(),
    basis: identifier,
  })
  .strict();

export const MissingFieldSchema = z
  .object({
    field: z.string().trim().min(1).max(200),
    reason: identifier,
  })
  .strict();

export const ScheduleRecordSchema = z
  .object({
    record_id: identifier,
    source_itinerary_id: identifier.nullable(),
    operating_carrier: optionalShortText,
    service_name: optionalShortText,
    routing: z.enum(["direct", "transshipment", "unknown"]),
    query_origin: identifier,
    query_destination: identifier,
    place_of_receipt: identifier.nullable(),
    place_of_delivery: identifier.nullable(),
    pol: PlaceSchema.nullable(),
    pod: PlaceSchema.nullable(),
    terminal: PlaceSchema.nullable(),
    legs: z.array(TransportLegSchema).min(1).max(20),
    cutoffs: z
      .object({
        si: CutoffSchema.nullable(),
        vgm: CutoffSchema.nullable(),
        cy: CutoffSchema.nullable(),
        customs: CutoffSchema.nullable(),
      })
      .strict(),
    cargo_available_at: z
      .union([dateOnly, localDateTime, offsetDateTime])
      .nullable(),
    transit: TransitSchema,
    evidence_ref: evidenceReference,
    observed_at: offsetDateTime,
    parser_version: versionToken,
    missing_fields: z.array(MissingFieldSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const sequences = value.legs.map((leg) => leg.sequence);
    if (sequences.some((sequence, index) => sequence !== index + 1)) {
      context.addIssue({
        code: "custom",
        path: ["legs"],
        message: "leg sequences must be contiguous and start at 1",
      });
    }
  });

const CoverageWindowSchema = z
  .object({
    from: dateOnly,
    until: dateOnly,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.until < value.from) {
      context.addIssue({
        code: "custom",
        path: ["until"],
        message: "coverage window is invalid",
      });
    }
  });

export const CoverageSchema = z
  .object({
    requested_from: dateOnly,
    requested_until: dateOnly,
    covered_windows: z.array(CoverageWindowSchema).max(90),
    uncovered_windows: z.array(CoverageWindowSchema).max(90),
    pages_read: z.array(z.number().int().positive()).max(1000),
    complete: z.boolean(),
    truncated: z.boolean(),
    failure_reason: identifier.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.complete && value.truncated) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "a complete result cannot be truncated",
      });
    }
    if (!value.complete && value.failure_reason === null) {
      context.addIssue({
        code: "custom",
        path: ["failure_reason"],
        message: "incomplete coverage requires a failure reason",
      });
    }
  });

export const ProvenanceSchema = z
  .object({
    kind: z.enum(["live", "synthetic", "replay"]),
    fetched_at: offsetDateTime.nullable(),
    fixture_generated_at: offsetDateTime.nullable(),
    source_updated_at: offsetDateTime.nullable(),
    parser_version: versionToken,
    source_refs: z.array(evidenceReference).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "live" && value.fetched_at === null) {
      context.addIssue({
        code: "custom",
        path: ["fetched_at"],
        message: "live provenance requires fetched_at",
      });
    }
    if (value.kind !== "live" && value.fetched_at !== null) {
      context.addIssue({
        code: "custom",
        path: ["fetched_at"],
        message: "non-live provenance cannot claim fetched_at",
      });
    }
  });

export const QualitySchema = z
  .object({
    key_fields_complete: z.boolean().nullable(),
    evaluation_status: z.enum(["evaluated", "partial", "not_evaluated"]),
    conflicts: z.array(shortText).max(100),
    warnings: z.array(identifier).max(100),
    missing_field_count: z.number().int().nonnegative(),
  })
  .strict();

export const CarrierIdentitySchema = z
  .object({
    id: z.enum(CARRIER_IDS),
    sales_carrier: shortText,
    adapter_version: versionToken,
    capability_status: z.enum(CARRIER_CAPABILITY_STATUSES),
    last_live_verified_at: offsetDateTime.nullable().default(null),
  })
  .strict();

function dateToEpoch(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

const DAY_MS = 86_400_000;

function coverageCoversQuery(
  queryFrom: string,
  queryUntil: string,
  windows: readonly { readonly from: string; readonly until: string }[],
): boolean {
  if (windows.length === 0) return false;
  const ordered = [...windows].sort((left, right) =>
    left.from.localeCompare(right.from),
  );
  let coveredUntil = dateToEpoch(queryFrom) - DAY_MS;
  for (const window of ordered) {
    const start = dateToEpoch(window.from);
    const end = dateToEpoch(window.until);
    if (start > coveredUntil + DAY_MS) return false;
    if (end > coveredUntil) coveredUntil = end;
    if (coveredUntil >= dateToEpoch(queryUntil)) return true;
  }
  return coveredUntil >= dateToEpoch(queryUntil);
}

export const CollectorResultDataSchema = z
  .object({
    collector_contract_version: z.literal(COLLECTOR_CONTRACT_VERSION),
    run_status: z.enum(COLLECTOR_RUN_STATUSES),
    query: NormalizedCollectorQuerySchema,
    carrier: CarrierIdentitySchema,
    records: z.array(ScheduleRecordSchema).max(500),
    coverage: CoverageSchema,
    provenance: ProvenanceSchema,
    quality: QualitySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.coverage.requested_from !== value.query.departure_from ||
      value.coverage.requested_until !== value.query.departure_until
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "coverage must align with the normalized query window",
      });
    }
    if (value.coverage.complete) {
      if (
        value.coverage.uncovered_windows.length !== 0 ||
        value.coverage.failure_reason !== null
      ) {
        context.addIssue({
          code: "custom",
          path: ["coverage"],
          message: "complete coverage cannot contain gaps or failure reasons",
        });
      }
      if (
        !coverageCoversQuery(
          value.query.departure_from,
          value.query.departure_until,
          value.coverage.covered_windows,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["coverage", "covered_windows"],
          message: "covered windows do not cover the requested query window",
        });
      }
    }
    if (value.run_status === "ok" && value.records.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["run_status"],
        message: "ok requires at least one record",
      });
    }
    if (value.run_status === "no_results" && value.records.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "no_results cannot contain records",
      });
    }
    if (value.run_status === "no_results" && !value.coverage.complete) {
      context.addIssue({
        code: "custom",
        path: ["run_status"],
        message: "no_results requires complete coverage",
      });
    }
    if (value.provenance.kind !== "live" && value.run_status === "ok") {
      context.addIssue({
        code: "custom",
        path: ["run_status"],
        message: "synthetic and replay data cannot be reported as ok",
      });
    }
  });

export type CollectorQueryInput = z.infer<typeof CollectorQueryInputSchema>;
export type CollectorResultData = z.infer<typeof CollectorResultDataSchema>;
export type NormalizedCollectorQuery = z.infer<
  typeof NormalizedCollectorQuerySchema
>;
export type ResolvedLocation = z.infer<typeof ResolvedLocationSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type TransportLeg = z.infer<typeof TransportLegSchema>;
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;
export type MissingField = z.infer<typeof MissingFieldSchema>;

export class CollectorContractError extends Error {
  constructor(
    readonly code: "invalid_query" | "invalid_result_data",
    message: string,
  ) {
    super(message);
    this.name = "CollectorContractError";
  }
}

export function parseCollectorQueryInput(input: unknown): CollectorQueryInput {
  const result = CollectorQueryInputSchema.safeParse(input);
  if (!result.success) {
    throw new CollectorContractError("invalid_query", "collector_query_invalid");
  }
  return result.data;
}

export function parseCollectorResultData(input: unknown): CollectorResultData {
  const result = CollectorResultDataSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.message}`)
      .join(",");
    throw new CollectorContractError(
      "invalid_result_data",
      `collector_result_data_invalid${details === "" ? "" : `:${details}`}`,
    );
  }
  return result.data;
}
