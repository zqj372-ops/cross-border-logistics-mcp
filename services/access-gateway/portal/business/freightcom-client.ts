import { readBoundedResponse, ResponseSizeError } from "../../../../src/logistics_mcp/platform/bounded-response";
import { z } from "zod";

import {
  freightcomRateAcceptedResponseSchema,
  freightcomRatePollResponseSchema,
  freightcomRateRequestSchema,
  toFreightcomProviderRateRequest,
  type FreightcomRateRequest,
} from "../../../../src/logistics_mcp/adapters/quote/freightcom-rate-adapter.js";
import { hashPayload } from "../../../../src/logistics_mcp/platform/idempotency.js";
import type { SourceRef } from "../../../../src/logistics_mcp/platform/envelope.js";

export type FreightcomPortalRateInput = FreightcomRateRequest;
export const freightcomInputSchema = freightcomRateRequestSchema;

export const FREIGHTCOM_PORTAL_SCHEMA_VERSION =
  "portal-freightcom-rate@2026-09-05.v1" as const;
export const FREIGHTCOM_API_VERSION = "2.10.0" as const;
export const DEFAULT_FREIGHTCOM_PRODUCTION_BASE_URL =
  "https://external-api.freightcom.com/" as const;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_POLL_ATTEMPTS = 12;
const DEFAULT_POLL_DELAY_MS = 750;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SUPPORTED_TWO_DECIMAL_CURRENCIES = new Set(["CAD", "USD"]);

const requestSchema = z.object({
  input: freightcomRateRequestSchema,
  requestId: z.string().regex(/^req_[A-Za-z0-9_-]{8,128}$/u),
}).strict();

export type FreightcomCredentialProvider = (
  signal: AbortSignal,
) => string | Promise<string>;

export interface FreightcomPortalClientOptions {
  /** Opaque reference to the server-side, single-account connection. */
  readonly connectionId: string;
  readonly credentialProvider?: FreightcomCredentialProvider;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly allowLoopbackFixtures?: boolean;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly maxPollAttempts?: number;
  readonly pollDelayMs?: number;
  readonly clock?: () => Date;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface FreightcomPortalMoney {
  readonly currency: string;
  /** Decimal major-unit amount, only when the currency exponent is known here. */
  readonly amount: string | null;
  /** Freightcom's original integer minor-unit value, retained without conversion loss. */
  readonly minor_value: string;
}

export interface FreightcomPortalCharge {
  readonly type: string;
  readonly amount: FreightcomPortalMoney;
}

export interface FreightcomPortalRate {
  readonly carrier_name: string | null;
  readonly service_name: string | null;
  readonly service_id: string | null;
  readonly valid_until: string | null;
  readonly total: FreightcomPortalMoney | null;
  readonly base: FreightcomPortalMoney | null;
  readonly surcharges: readonly FreightcomPortalCharge[];
  readonly taxes: readonly FreightcomPortalCharge[];
  readonly transit_time_days: number | null;
  readonly transit_time_not_available: boolean | null;
  readonly transit_time_hours: number | null;
  readonly carrier_cut_off_time: string | null;
  readonly estimated_delivery_time: string | null;
  readonly truck_details_ftl: string | null;
  readonly transit_mode_ftl: string | null;
  readonly paperless: boolean | null;
  readonly customs_charge_data: {
    readonly duties_and_taxes_surcharge_keys: readonly string[] | null;
    readonly guarantee_fee_surcharge_keys: readonly string[] | null;
    readonly carrier_and_government_fees_surcharge_keys: readonly string[] | null;
    readonly processing_fees_surcharge_keys: readonly string[] | null;
    readonly is_rate_guaranteed: boolean | null;
  } | null;
}

export interface FreightcomPortalRateData {
  readonly provider: "freightcom";
  readonly api_version: typeof FREIGHTCOM_API_VERSION;
  readonly environment: "production" | "fixture";
  readonly rate_request_ref: string;
  readonly request_status: {
    readonly done: boolean;
    readonly total: number;
    readonly complete: number;
  };
  readonly rates: readonly FreightcomPortalRate[];
  readonly read_only: true;
  readonly provider_quote_authoritative: boolean;
}

export type FreightcomPortalStatus =
  | "success"
  | "needs_input"
  | "manual_review"
  | "blocked"
  | "unavailable";

export interface FreightcomPortalResult {
  readonly schema_version: typeof FREIGHTCOM_PORTAL_SCHEMA_VERSION;
  readonly status: FreightcomPortalStatus;
  readonly data: FreightcomPortalRateData | null;
  readonly reason_codes: readonly string[];
  readonly source_refs: readonly SourceRef[];
  readonly request_id: string;
  readonly saved: false;
  readonly sendable: false;
  readonly bookable: false;
  readonly [key: string]: unknown;
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

class ClientFailure extends Error {
  constructor(
    readonly reason: string,
    readonly resultStatus: "needs_input" | "blocked" | "unavailable",
  ) {
    super(reason);
    this.name = "ClientFailure";
  }
}

function integerOption(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} is invalid.`);
  }
  return value;
}

function localResult(
  status: FreightcomPortalStatus,
  requestId: string,
  reasonCodes: readonly string[],
  data: FreightcomPortalRateData | null = null,
  sourceRefs: readonly SourceRef[] = [],
): FreightcomPortalResult {
  return {
    schema_version: FREIGHTCOM_PORTAL_SCHEMA_VERSION,
    status,
    data,
    reason_codes: reasonCodes,
    source_refs: sourceRefs,
    request_id: /^req_[A-Za-z0-9_-]{8,128}$/u.test(requestId)
      ? requestId
      : "req_unavailable",
    saved: false,
    sendable: false,
    bookable: false,
  };
}

function configuredBaseUrl(
  raw: string | undefined,
  allowLoopbackFixtures: boolean,
): { readonly url: URL; readonly environment: "production" | "fixture" } | null {
  const candidate = raw ?? DEFAULT_FREIGHTCOM_PRODUCTION_BASE_URL;
  if ([...candidate].some((character) => character === "\\" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return null;
  }
  try {
    const url = new URL(candidate);
    if (
      url.href !== candidate ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/"
    ) return null;
    if (url.href === DEFAULT_FREIGHTCOM_PRODUCTION_BASE_URL) {
      return { url, environment: "production" };
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (allowLoopbackFixtures && url.protocol === "http:" && loopback) {
      return { url, environment: "fixture" };
    }
    return null;
  } catch {
    return null;
  }
}

function validCredential(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !/[\r\n\0]/u.test(value);
}

async function readBoundedJson(response: Response, maximumBytes: number, signal: AbortSignal): Promise<unknown> {
  const bytes = await readBoundedResponse(response, maximumBytes, signal);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ClientFailure("freightcom_upstream_contract_invalid", "unavailable");
  }
}

function mapHttpStatus(status: number, operation: "submit" | "poll"): never {
  if (status === 401 || status === 403) {
    throw new ClientFailure("freightcom_authorization_rejected", "blocked");
  }
  if (operation === "submit" && [400, 409, 422].includes(status)) {
    throw new ClientFailure("freightcom_request_rejected", "needs_input");
  }
  if (status === 429 || status >= 500) {
    throw new ClientFailure("freightcom_upstream_unavailable", "unavailable");
  }
  throw new ClientFailure("freightcom_upstream_http_error", "unavailable");
}

function dateString(value: { year: number; month: number; day: number }): string {
  return `${value.year.toString().padStart(4, "0")}-${value.month.toString().padStart(2, "0")}-${value.day.toString().padStart(2, "0")}`;
}

function money(value: { currency: string; value: string }): FreightcomPortalMoney {
  let amount: string | null = null;
  if (SUPPORTED_TWO_DECIMAL_CURRENCIES.has(value.currency)) {
    const padded = value.value.padStart(3, "0");
    amount = `${padded.slice(0, -2)}.${padded.slice(-2)}`;
  }
  return { currency: value.currency, amount, minor_value: value.value };
}

function opaqueProviderRef(connectionId: string, providerRequestId: string): string {
  return hashPayload({ connectionId, providerRequestId }).slice("sha256:".length);
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function formalEvidenceIssues(
  response: z.infer<typeof freightcomRatePollResponseSchema>,
  today: string,
): string[] {
  const issues = new Set<string>();
  if (response.rates.length === 0) issues.add("freightcom_no_rates_returned");
  if (response.status.complete !== response.status.total) issues.add("freightcom_poll_count_incomplete");
  for (const rate of response.rates) {
    if (!rate.service_id || !rate.carrier_name || !rate.service_name || !rate.total || !rate.valid_until) {
      issues.add("freightcom_rate_evidence_incomplete");
      continue;
    }
    const validUntil = dateString(rate.valid_until);
    if (validUntil < today) issues.add("freightcom_rate_expired");
    if (!SUPPORTED_TWO_DECIMAL_CURRENCIES.has(rate.total.currency)) {
      issues.add("freightcom_currency_exponent_unsupported");
    }
    const charges = [
      ...(rate.base === undefined ? [] : [rate.base]),
      ...(rate.surcharges ?? []).map((item) => item.amount),
      ...(rate.taxes ?? []).map((item) => item.amount),
    ];
    if (charges.some((charge) => charge.currency !== rate.total?.currency)) {
      issues.add("freightcom_rate_currency_mismatch");
    }
  }
  return [...issues];
}

function mapRate(
  rate: z.infer<typeof freightcomRatePollResponseSchema>["rates"][number],
): FreightcomPortalRate {
  const customs = rate.customs_charge_data;
  return {
    carrier_name: rate.carrier_name ?? null,
    service_name: rate.service_name ?? null,
    service_id: rate.service_id ?? null,
    valid_until: rate.valid_until === undefined ? null : dateString(rate.valid_until),
    total: rate.total === undefined ? null : money(rate.total),
    base: rate.base === undefined ? null : money(rate.base),
    surcharges: (rate.surcharges ?? []).map((item) => ({ type: item.type, amount: money(item.amount) })),
    taxes: (rate.taxes ?? []).map((item) => ({ type: item.type, amount: money(item.amount) })),
    transit_time_days: rate.transit_time_days ?? null,
    transit_time_not_available: rate.transit_time_not_available ?? null,
    transit_time_hours: rate.transit_time_hours ?? null,
    carrier_cut_off_time: rate.carrier_cut_off_time ?? null,
    estimated_delivery_time: rate.estimated_delivery_time ?? null,
    truck_details_ftl: rate.truck_details_ftl ?? null,
    transit_mode_ftl: rate.transit_mode_ftl ?? null,
    paperless: rate.paperless ?? null,
    customs_charge_data: customs === undefined ? null : {
      duties_and_taxes_surcharge_keys: customs.duties_and_taxes_surcharge_keys ?? null,
      guarantee_fee_surcharge_keys: customs.guarantee_fee_surcharge_keys ?? null,
      carrier_and_government_fees_surcharge_keys: customs.carrier_and_government_fees_surcharge_keys ?? null,
      processing_fees_surcharge_keys: customs.processing_fees_surcharge_keys ?? null,
      is_rate_guaranteed: customs.is_rate_guaranteed ?? null,
    },
  };
}

export function createFreightcomPortalClient(options: FreightcomPortalClientOptions) {
  const connection = configuredBaseUrl(options.baseUrl, options.allowLoopbackFixtures === true);
  const connectionIdValid = ID.test(options.connectionId);
  const timeoutMs = integerOption(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 1);
  const maxBodyBytes = integerOption(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, "maxBodyBytes", 1);
  const maxPollAttempts = integerOption(options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS, "maxPollAttempts", 1);
  const pollDelayMs = integerOption(options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS, "pollDelayMs", 0);
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;

  async function http(
    path: string,
    init: RequestInit,
    outerSignal: AbortSignal | undefined,
  ): Promise<HttpResult> {
    if (connection === null) {
      throw new ClientFailure("freightcom_connection_unconfigured", "unavailable");
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    outerSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, connection.url), {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new ClientFailure("freightcom_upstream_redirect_rejected", "unavailable");
      }
      return { status: response.status, body: await readBoundedJson(response, maxBodyBytes, controller.signal) };
    } catch (error) {
      if (error instanceof ResponseSizeError) throw new ClientFailure("freightcom_upstream_response_too_large", "unavailable");
      if (error instanceof ClientFailure) throw error;
      if (controller.signal.aborted) {
        throw new ClientFailure(
          outerSignal?.aborted === true ? "freightcom_request_aborted" : "freightcom_upstream_timeout",
          "unavailable",
        );
      }
      throw new ClientFailure("freightcom_upstream_unavailable", "unavailable");
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", abort);
    }
  }

  return Object.freeze({
    async preview(request: {
      readonly input: FreightcomRateRequest;
      readonly requestId: string;
      readonly signal?: AbortSignal;
    }): Promise<FreightcomPortalResult> {
      const parsed = requestSchema.safeParse(request.signal === undefined
        ? request
        : { input: request.input, requestId: request.requestId });
      if (!parsed.success) {
        return localResult("needs_input", request.requestId, ["freightcom_request_invalid"]);
      }
      if (connection === null || !connectionIdValid || options.credentialProvider === undefined) {
        return localResult("unavailable", request.requestId, ["freightcom_connection_unconfigured"]);
      }
      const signal = request.signal ?? new AbortController().signal;
      let credential: string;
      try {
        credential = (await options.credentialProvider(signal)).trim();
      } catch {
        return localResult("unavailable", request.requestId, ["freightcom_credential_unavailable"]);
      }
      if (!validCredential(credential)) {
        return localResult("unavailable", request.requestId, ["freightcom_credential_unavailable"]);
      }
      const headers = {
        accept: "application/json",
        authorization: credential,
        "content-type": "application/json",
      };
      try {
        const accepted = await http("rate", {
          method: "POST",
          headers,
          body: JSON.stringify(toFreightcomProviderRateRequest(parsed.data.input)),
        }, signal);
        if (accepted.status !== 202) mapHttpStatus(accepted.status, "submit");
        const parsedAccepted = freightcomRateAcceptedResponseSchema.safeParse(accepted.body);
        if (!parsedAccepted.success || !PROVIDER_REQUEST_ID.test(parsedAccepted.data.request_id)) {
          throw new ClientFailure("freightcom_accepted_response_invalid", "unavailable");
        }

        let completed: z.infer<typeof freightcomRatePollResponseSchema> | null = null;
        for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
          const polled = await http(`rate/${encodeURIComponent(parsedAccepted.data.request_id)}`, {
            method: "GET",
            headers: { accept: "application/json", authorization: credential },
          }, signal);
          if (polled.status !== 200) mapHttpStatus(polled.status, "poll");
          const parsedPoll = freightcomRatePollResponseSchema.safeParse(polled.body);
          if (!parsedPoll.success) {
            throw new ClientFailure("freightcom_poll_response_invalid", "unavailable");
          }
          if (parsedPoll.data.status.done) {
            completed = parsedPoll.data;
            break;
          }
          if (attempt + 1 < maxPollAttempts) await sleep(pollDelayMs, signal);
        }
        if (completed === null) {
          return localResult("unavailable", request.requestId, ["freightcom_poll_incomplete"]);
        }

        const retrievedAt = clock().toISOString();
        const today = retrievedAt.slice(0, 10);
        const evidenceIssues = formalEvidenceIssues(completed, today);
        if (connection.environment === "fixture") evidenceIssues.push("freightcom_fixture_data");
        const opaqueRef = opaqueProviderRef(options.connectionId, parsedAccepted.data.request_id);
        const authoritative = evidenceIssues.length === 0 && connection.environment === "production";
        const data: FreightcomPortalRateData = {
          provider: "freightcom",
          api_version: FREIGHTCOM_API_VERSION,
          environment: connection.environment,
          rate_request_ref: `freightcom-rate:${opaqueRef}`,
          request_status: completed.status,
          rates: completed.rates.map(mapRate),
          read_only: true,
          provider_quote_authoritative: authoritative,
        };
        const sourceRef: SourceRef = {
          source_id: `src:freightcom:${connection.environment}:${opaqueRef}`,
          source_type: connection.environment === "production" ? "official_source" : "fixture",
          system: "Freightcom Customer API",
          locator: `opaque://freightcom/${connection.environment}/rate/${opaqueRef}`,
          version: `freightcom-api@${FREIGHTCOM_API_VERSION}`,
          retrieved_at: retrievedAt,
          authority: authoritative ? "authoritative" : "supporting",
          content_hash: hashPayload(completed),
        };
        return localResult(
          authoritative ? "success" : "manual_review",
          request.requestId,
          evidenceIssues,
          data,
          [sourceRef],
        );
      } catch (error) {
        if (error instanceof ClientFailure) {
          return localResult(error.resultStatus, request.requestId, [error.reason]);
        }
        return localResult("unavailable", request.requestId, ["freightcom_upstream_unavailable"]);
      }
    },
  });
}
