import Decimal from "decimal.js";

import {
  createFetchJsonClient,
  HttpAdapterError,
  type FetchImplementation,
  type FetchJsonClient,
} from "../http-client";
import type { SourceRef } from "../../platform/envelope";
import type {
  QuoteDraftReadbackRecord,
  QuoteDraftWriteRecord,
  QuoteLookupRecord,
  QuoteUpstreamSource,
} from "./existing-quote-adapter";

export const ZONE_CALCULATE_PATH = "/quotes/zone-calculate";

export interface HttpQuoteSourceOptions {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: FetchImplementation;
  readonly headers?: Readonly<Record<string, string>>;
  readonly authorization?: string;
  readonly apiKey?: string;
  readonly clock?: () => Date;
}

export class QuoteHttpContractError extends Error {
  readonly code = "quote_upstream_contract_invalid" as const;

  constructor(field: string) {
    super(`The upstream quote response has an invalid or missing ${field} field.`);
    this.name = "QuoteHttpContractError";
  }
}

type JsonRecord = Record<string, unknown>;
type HttpQuoteLookupRecord = QuoteLookupRecord & { readonly quote_version: string };

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ADDRESS_TYPES = ["commercial", "residential", "private", "rural_residential"] as const;
const SOURCE_TYPES = [
  "zone_matrix",
  "manual_required",
  "llm_auxiliary_advice",
  "hermes_agent_correction",
  "learned_manual_quote",
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string): never {
  throw new QuoteHttpContractError(field);
}

function requiredString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    return invalid(field);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

function decimalString(value: unknown, field: string): string {
  return requiredString(value, field, DECIMAL);
}

function optionalDecimal(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return decimalString(value, field);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid(field);
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid(field);
  return value as number;
}

function optionalInteger(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return positiveInteger(value, field);
}

function booleanValue(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") return invalid(field);
  return value;
}

function fieldValue(
  direct: JsonRecord,
  nested: JsonRecord | null,
  directKey: string,
  nestedKey: string,
): unknown {
  return direct[directKey] ?? nested?.[nestedKey];
}

function measurementValue(value: unknown, field: string, unit: string): string {
  if (!isRecord(value)) return decimalString(value, field);
  if (value.unit !== unit) return invalid(`${field}.unit`);
  return decimalString(value.value, `${field}.value`);
}

function buildZoneRequest(input: Record<string, unknown>): JsonRecord {
  if (!isRecord(input)) throw new HttpAdapterError("upstream_request_invalid", "The quote request is invalid.");

  const destination = isRecord(input.destination) ? input.destination : null;
  const cargo = isRecord(input.cargo) ? input.cargo : null;
  const services = isRecord(input.services) ? input.services : null;
  const country = fieldValue(input, destination, "country", "country");
  if (country !== undefined && country !== "CA") {
    throw new HttpAdapterError("upstream_request_invalid", "The quote destination country is not supported.");
  }

  const addressType = fieldValue(input, destination, "address_type", "address_type");
  if (
    typeof addressType !== "string" ||
    addressType === "unknown" ||
    !(ADDRESS_TYPES as readonly string[]).includes(addressType)
  ) {
    throw new HttpAdapterError("upstream_request_invalid", "A confirmed destination address type is required.");
  }

  if (services?.limited_access === true || services?.remote_area === true) {
    throw new HttpAdapterError(
      "upstream_request_invalid",
      "The verified zone endpoint does not accept limited-access or remote-area service flags.",
    );
  }

  const packageTypes = cargo?.package_types;
  const packageType = fieldValue(input, cargo, "packaging_type", "packaging_type");
  const resolvedPackageType =
    packageType ??
    (Array.isArray(packageTypes) && packageTypes.length === 1 ? packageTypes[0] : undefined);
  if (Array.isArray(packageTypes) && packageTypes.length !== 1 && packageType === undefined) {
    throw new HttpAdapterError(
      "upstream_request_invalid",
      "The verified zone endpoint requires one packaging type.",
    );
  }

  const weight = fieldValue(input, cargo, "weight_kg", "weight_kg");
  const cbm = fieldValue(input, cargo, "cbm", "cbm");
  const pieces = fieldValue(input, cargo, "piece_count", "pieces");
  const request: JsonRecord = {
    postal_code: requiredString(fieldValue(input, destination, "postal_code", "postal_code"), "postal_code"),
    cbm: measurementValue(cbm, "cbm", "cbm"),
    weight_kg: measurementValue(weight, "weight_kg", "kg"),
    piece_count: positiveInteger(pieces, "piece_count"),
    packaging_type: requiredString(resolvedPackageType, "packaging_type"),
    address_type: addressType,
    requires_liftgate: booleanValue(
      fieldValue(input, services, "requires_liftgate", "liftgate"),
      "requires_liftgate",
    ),
    requires_pallet_jack: booleanValue(
      fieldValue(input, services, "requires_pallet_jack", "pallet_jack"),
      "requires_pallet_jack",
    ),
    requires_appointment: booleanValue(
      fieldValue(input, services, "requires_appointment", "appointment"),
      "requires_appointment",
    ),
  };

  const city = optionalString(fieldValue(input, destination, "city", "city"), "city");
  const province = optionalString(fieldValue(input, destination, "province", "province"), "province");
  if (city !== undefined) request.city = city;
  if (province !== undefined) request.province = province;

  const longestSide = optionalDecimal(input.longest_side_cm, "longest_side_cm");
  if (longestSide !== undefined) request.longest_side_cm = longestSide;
  const explicitPallets = optionalInteger(
    fieldValue(input, cargo, "explicit_pallet_count", "billing_pallets"),
    "explicit_pallet_count",
  );
  if (explicitPallets !== undefined) request.explicit_pallet_count = explicitPallets;
  const stackable = input.is_stackable;
  if (stackable !== undefined) request.is_stackable = stackable === null ? null : booleanValue(stackable, "is_stackable");
  const detention = input.detention_minutes;
  if (detention !== undefined) request.detention_minutes = nonNegativeInteger(detention, "detention_minutes");

  return { quote: request, notify_email: false, notify_wecom: false };
}

function requiredVersion(value: unknown, field: string): string {
  const version = requiredString(value, field, VERSION);
  if (version === "latest") return invalid(field);
  return version;
}

function dateValue(value: unknown, field: string): string {
  const date = requiredString(value, field);
  const day = date.slice(0, 10);
  if (!DATE.test(day) || (!DATE_TIME.test(date) && date !== day)) return invalid(field);
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return invalid(field);
  return date;
}

function sourceRefValue(
  response: JsonRecord,
  locator: string,
  dataVersion: string,
  quoteId: string,
  clock: () => Date,
): SourceRef {
  const value = response.source_ref;
  if (value === undefined) {
    return {
      source_id: `src:quote:http:${quoteId}`,
      source_type: "internal_system",
      system: "existing-quote-system",
      locator,
      version: dataVersion,
      retrieved_at: clock().toISOString(),
      authority: "authoritative",
      content_hash: null,
    };
  }
  if (!isRecord(value)) return invalid("source_ref");
  const sourceTypes = [
    "internal_system",
    "official_source",
    "tenant_record",
    "user_input",
    "opaque_reference",
    "fixture",
  ] as const;
  const authorities = ["authoritative", "supporting", "user_provided", "opaque"] as const;
  const sourceType = requiredString(value.source_type, "source_ref.source_type");
  const authority = requiredString(value.authority, "source_ref.authority");
  if (!(sourceTypes as readonly string[]).includes(sourceType)) return invalid("source_ref.source_type");
  if (!(authorities as readonly string[]).includes(authority)) return invalid("source_ref.authority");
  const retrievedAt = requiredString(value.retrieved_at, "source_ref.retrieved_at");
  if (!DATE_TIME.test(retrievedAt) || Number.isNaN(Date.parse(retrievedAt))) return invalid("source_ref.retrieved_at");
  const locatorValue = requiredString(value.locator, "source_ref.locator");
  if (/authorization|api[-_]?key|token|secret|password|cookie/i.test(locatorValue)) return invalid("source_ref.locator");
  const contentHash = value.content_hash;
  if (contentHash !== undefined && contentHash !== null && typeof contentHash !== "string") return invalid("source_ref.content_hash");
  const sourceRef = {
    source_id: requiredString(value.source_id, "source_ref.source_id", IDENTIFIER),
    source_type: sourceType as SourceRef["source_type"],
    system: requiredString(value.system, "source_ref.system"),
    locator: locatorValue,
    version: requiredVersion(value.version, "source_ref.version"),
    retrieved_at: retrievedAt,
    authority: authority as SourceRef["authority"],
  };
  return contentHash === undefined
    ? sourceRef
    : { ...sourceRef, content_hash: contentHash as string | null };
}

function moneyValue(
  value: unknown,
  field: string,
  defaultCurrency: string | undefined,
): { readonly amount: string; readonly currency: string } | null {
  if (value === null || value === undefined) return null;
  if (isRecord(value)) {
    return {
      amount: decimalString(value.amount, `${field}.amount`),
      currency: requiredString(value.currency, `${field}.currency`, CURRENCY),
    };
  }
  if (defaultCurrency === undefined) return invalid(`${field}.currency`);
  return { amount: decimalString(value, field), currency: defaultCurrency };
}

function accessorialValues(
  value: unknown,
  defaultCurrency: string | undefined,
): Readonly<Record<string, { readonly amount: string; readonly currency: string }>> {
  if (value === undefined) return {};
  if (!isRecord(value)) return invalid("accessorials");
  const result: Record<string, { readonly amount: string; readonly currency: string }> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.endsWith("_usd") ? rawKey.slice(0, -4) : rawKey;
    if (!IDENTIFIER.test(key)) return invalid(`accessorials.${rawKey}`);
    const amount = moneyValue(rawValue, `accessorials.${rawKey}`, defaultCurrency ?? "USD");
    if (amount === null) return invalid(`accessorials.${rawKey}`);
    result[key] = amount;
  }
  return result;
}

function responseRecord(
  value: unknown,
  locator: string,
  clock: () => Date,
): HttpQuoteLookupRecord {
  if (!isRecord(value)) return invalid("response");
  const quoteId = requiredString(value.quote_id, "quote_id", IDENTIFIER);
  const quoteVersion = requiredVersion(value.quote_version ?? value.version, "version");
  const ruleVersion = requiredVersion(value.rule_version, "rule_version");
  const dataVersion = requiredVersion(value.data_version, "data_version");
  const validFrom = dateValue(value.valid_from, "valid_from");
  const validTo = dateValue(value.valid_to, "valid_to");
  if (validFrom.slice(0, 10) > validTo.slice(0, 10)) return invalid("validity");
  const sourceType = requiredString(value.source_type, "source_type");
  if (!(SOURCE_TYPES as readonly string[]).includes(sourceType)) return invalid("source_type");
  if (typeof value.manual_review_required !== "boolean") return invalid("manual_review_required");
  const matchedBy = requiredString(value.matched_by, "matched_by", IDENTIFIER);
  const candidateCount =
    value.candidate_count === undefined ? 0 : nonNegativeInteger(value.candidate_count, "candidate_count");
  const zone = value.zone === null ? null : value.zone === undefined ? null : nonNegativeInteger(value.zone, "zone");
  const responseCurrency =
    value.currency === undefined ? undefined : requiredString(value.currency, "currency", CURRENCY);
  const basePrice = moneyValue(
    value.base_price_usd ?? value.base_price,
    "base_price_usd",
    responseCurrency ?? (value.base_price_usd !== undefined ? "USD" : undefined),
  );
  const fuel = moneyValue(
    value.fuel_usd,
    "fuel_usd",
    responseCurrency ?? (value.fuel_usd !== undefined ? "USD" : undefined),
  );
  const total = moneyValue(
    value.total_price_usd ?? value.total,
    "total_price_usd",
    responseCurrency ?? (value.total_price_usd !== undefined ? "USD" : undefined),
  );
  const rawFuelPercent = value.fuel_percent;
  let fuelPercent: string | null = null;
  if (rawFuelPercent !== undefined && rawFuelPercent !== null) {
    fuelPercent = decimalString(rawFuelPercent, "fuel_percent");
  } else if (basePrice !== null && fuel !== null) {
    const base = new Decimal(basePrice.amount);
    if (base.isZero()) {
      if (!new Decimal(fuel.amount).isZero()) return invalid("fuel_percent");
      fuelPercent = "0";
    } else {
      fuelPercent = new Decimal(fuel.amount).mul(100).div(base).toString();
    }
  }
  const accessorials = accessorialValues(value.accessorials, responseCurrency ?? "USD");
  const usable =
    sourceType === "zone_matrix" &&
    value.manual_review_required === false &&
    zone !== null &&
    basePrice !== null &&
    fuelPercent !== null &&
    total !== null;
  const status: QuoteLookupRecord["status"] = usable
    ? "matched"
    : candidateCount > 1 || /conflict|split/i.test(matchedBy)
      ? "zone_conflict"
      : zone === null
        ? "zone_missing"
        : "price_missing";
  const currency = basePrice?.currency ?? fuel?.currency ?? total?.currency ?? responseCurrency;
  const resultBase = {
    status,
    quote_id: quoteId,
    quote_version: quoteVersion,
    zone,
    base_price: basePrice,
    fuel_percent: fuelPercent,
    accessorials,
    rule_version: ruleVersion,
    data_version: dataVersion,
    valid_from: validFrom,
    valid_to: validTo,
    matched_by: matchedBy,
    source_ref: sourceRefValue(value, locator, dataVersion, quoteId, clock),
  };
  return currency === undefined
    ? resultBase
    : { ...resultBase, currency };
}

function readOnlyError(): HttpAdapterError {
  return new HttpAdapterError(
    "upstream_disabled",
    "The HTTP quote source is read-only; draft writes and draft readbacks are disabled.",
  );
}

export class HttpQuoteSource implements QuoteUpstreamSource {
  private readonly client: FetchJsonClient;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly locator: string;
  private readonly clock: () => Date;

  constructor(options: HttpQuoteSourceOptions) {
    const clientOptions: {
      baseUrl: string;
      allowedHosts: readonly string[];
      enabled?: boolean;
      timeoutMs?: number;
      maxResponseBytes?: number;
      fetchImpl?: FetchImplementation;
    } = {
      baseUrl: options.baseUrl,
      allowedHosts: options.allowedHosts,
    };
    if (options.enabled !== undefined) clientOptions.enabled = options.enabled;
    if (options.timeoutMs !== undefined) clientOptions.timeoutMs = options.timeoutMs;
    if (options.maxResponseBytes !== undefined) clientOptions.maxResponseBytes = options.maxResponseBytes;
    if (options.fetchImpl !== undefined) clientOptions.fetchImpl = options.fetchImpl;
    this.client = createFetchJsonClient(clientOptions);
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.authorization !== undefined) headers.authorization = options.authorization;
    if (options.apiKey !== undefined) headers["x-api-key"] = options.apiKey;
    this.headers = headers;
    this.locator = new URL(ZONE_CALCULATE_PATH, options.baseUrl).toString();
    this.clock = options.clock ?? (() => new Date());
  }

  async lookup(input: Record<string, unknown>): Promise<QuoteLookupRecord> {
    let payload: JsonRecord;
    try {
      payload = buildZoneRequest(input);
    } catch (error: unknown) {
      if (error instanceof QuoteHttpContractError) {
        throw new HttpAdapterError(
          "upstream_request_invalid",
          "The quote request does not satisfy the verified zone endpoint contract.",
        );
      }
      throw error;
    }
    const response = await this.client.post(ZONE_CALCULATE_PATH, payload, this.headers);
    return responseRecord(response, this.locator, this.clock);
  }

  async saveDraft(input: Record<string, unknown>): Promise<QuoteDraftWriteRecord> {
    void input;
    throw readOnlyError();
  }

  async readDraft(recordId: string, tenantId: string): Promise<QuoteDraftReadbackRecord | null> {
    void recordId;
    void tenantId;
    throw readOnlyError();
  }
}
