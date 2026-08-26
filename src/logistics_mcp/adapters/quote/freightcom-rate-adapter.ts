import { z } from "zod";

import {
  createFetchJsonClient,
  HttpAdapterError,
  type FetchImplementation,
  type FetchJsonAllowedStatusResponse,
} from "../http-client";
import type { AdapterResult } from "../ports";
import { hashPayload } from "../../platform/idempotency";
import type { SourceRef } from "../../platform/envelope";

const FREIGHTCOM_API_VERSION = "2.10.0" as const;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const identifierSchema = z.string().regex(REQUEST_ID_RE);

const addressSchema = z
  .object({
    address_line_1: z.string().min(1),
    address_line_2: z.string().optional(),
    unit_number: z.string().optional(),
    city: z.string().min(1),
    region: z.string().min(1),
    country: z.string().regex(/^[A-Z]{2}$/u),
    postal_code: z.string().min(1),
  })
  .strict();

const phoneNumberSchema = z
  .object({
    number: z.string().min(1),
    extension: z.string().optional(),
  })
  .strict();

const moneyRequestSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/u),
    value: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  })
  .strict();

const establishmentSchema = z
  .object({
    name: z.string().optional(),
    address: addressSchema,
    residential: z.boolean().optional(),
    tailgate_required: z.boolean().optional(),
    instructions: z.string().optional(),
    contact_name: z.string().optional(),
    phone_number: phoneNumberSchema.optional(),
    email_addresses: z.array(z.string().email()).optional(),
    receives_email_updates: z.boolean().optional(),
  })
  .strict();

const dateSchema = z
  .object({
    year: z.number().int().min(1).max(9999),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })
  .strict();

const timeOfDaySchema = z
  .object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .strict();

const destinationSchema = establishmentSchema
  .extend({
    ready_at: timeOfDaySchema,
    ready_until: timeOfDaySchema,
    signature_requirement: z.enum(["not-required", "required", "adult-required"]),
  })
  .strict();

const positiveDecimalStringSchema = z
  .string()
  .max(128)
  .regex(/^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/u)
  .refine((value) => {
    const providerValue = Number(value);
    return Number.isFinite(providerValue) && providerValue > 0;
  }, "Weight must be representable by the Freightcom provider number field.");

const weightSchema = z
  .object({
    unit: z.enum(["kg", "lb", "g", "oz"]),
    value: positiveDecimalStringSchema,
  })
  .strict();

const cuboidSchema = z
  .object({
    unit: z.enum(["mm", "cm", "m", "in", "ft"]),
    l: z.number().finite().positive(),
    w: z.number().finite().positive(),
    h: z.number().finite().positive(),
  })
  .strict();

const ltlPalletSchema = z
  .object({
    measurements: z
      .object({ weight: weightSchema, cuboid: cuboidSchema })
      .strict(),
    description: z.string().min(1),
    freight_class: z.string().min(1),
    nmfc: z.string().optional(),
    contents_type: z.string().optional(),
    num_pieces: z.number().int().min(1).optional(),
  })
  .strict();

const dangerousGoodsDetailsSchema = z
  .object({
    packaging_group: z.string().min(1),
    goods_class: z.string().min(1),
    description: z.string().min(1),
    united_nations_number: z.string().min(1),
    emergency_contact_name: z.string().min(1),
    emergency_contact_phone_number: phoneNumberSchema,
  })
  .strict();

const inBondDetailsSchema = z
  .object({
    type: z.enum(["immediate-exportation", "transportation-and-exportation"]),
    name: z.string().min(1),
    address: z.string().min(1),
    contact_method: z.enum(["email-address", "phone-number", "fax-number"]),
    contact_email_address: z.string().email().optional(),
    contact_phone_number: phoneNumberSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contact_method === "email-address" && value.contact_email_address === undefined) {
      context.addIssue({
        code: "custom",
        message: "contact_email_address is required when contact_method is email-address",
        path: ["contact_email_address"],
      });
    }
    if (value.contact_method === "phone-number" && value.contact_phone_number === undefined) {
      context.addIssue({
        code: "custom",
        message: "contact_phone_number is required when contact_method is phone-number",
        path: ["contact_phone_number"],
      });
    }
  });

const amazonOrFbaDeliveryDetailsSchema = z
  .object({
    fba_number: z.string().min(1),
    order_id: z.string().min(1),
  })
  .strict();

const palletServiceDetailsSchema = z
  .object({
    limited_access_delivery_type: z.enum([
      "construction-site",
      "fair",
      "farm",
      "mall",
      "mini-storage-unit",
      "place-of-worship",
      "school",
      "secured-location",
      "other",
    ]).optional(),
    limited_access_delivery_other_name: z.string().min(1).optional(),
    in_bond: z.boolean().optional(),
    in_bond_details: inBondDetailsSchema.optional(),
    appointment_delivery: z.boolean().optional(),
    protect_from_freeze: z.boolean().optional(),
    threshold_pickup: z.boolean().optional(),
    threshold_delivery: z.boolean().optional(),
    amazon_or_fba_delivery: z.boolean().optional(),
    amazon_or_fba_delivery_details: amazonOrFbaDeliveryDetailsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.limited_access_delivery_type === "other" &&
      value.limited_access_delivery_other_name === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "limited_access_delivery_other_name is required for other",
        path: ["limited_access_delivery_other_name"],
      });
    }
    if (
      value.limited_access_delivery_type !== undefined &&
      value.limited_access_delivery_type !== "other" &&
      value.limited_access_delivery_other_name !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "limited_access_delivery_other_name is only valid for other",
        path: ["limited_access_delivery_other_name"],
      });
    }
    if (value.in_bond === true && value.in_bond_details === undefined) {
      context.addIssue({
        code: "custom",
        message: "in_bond_details is required when in_bond is true",
        path: ["in_bond_details"],
      });
    }
    if (value.in_bond !== true && value.in_bond_details !== undefined) {
      context.addIssue({
        code: "custom",
        message: "in_bond_details requires in_bond to be true",
        path: ["in_bond_details"],
      });
    }
    if (value.amazon_or_fba_delivery === true && value.amazon_or_fba_delivery_details === undefined) {
      context.addIssue({
        code: "custom",
        message: "amazon_or_fba_delivery_details is required when amazon_or_fba_delivery is true",
        path: ["amazon_or_fba_delivery_details"],
      });
    }
    if (value.amazon_or_fba_delivery !== true && value.amazon_or_fba_delivery_details !== undefined) {
      context.addIssue({
        code: "custom",
        message: "amazon_or_fba_delivery_details requires amazon_or_fba_delivery to be true",
        path: ["amazon_or_fba_delivery_details"],
      });
    }
  });

const palletPropertiesSchema = z
  .object({
    pallet_type: z.literal("ltl"),
    has_stackable_pallets: z.boolean().optional(),
    dangerous_goods: z.enum(["limited-quantity", "exemption-500-kg", "fully-regulated"]).optional(),
    dangerous_goods_details: dangerousGoodsDetailsSchema.optional(),
    pallets: z.array(ltlPalletSchema).min(1),
    pallet_service_details: palletServiceDetailsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dangerous_goods !== undefined && value.dangerous_goods_details === undefined) {
      context.addIssue({
        code: "custom",
        message: "dangerous_goods_details is required when dangerous_goods is provided",
        path: ["dangerous_goods_details"],
      });
    }
    if (value.dangerous_goods === undefined && value.dangerous_goods_details !== undefined) {
      context.addIssue({
        code: "custom",
        message: "dangerous_goods_details requires dangerous_goods",
        path: ["dangerous_goods_details"],
      });
    }
  });

const shippingDetailsSchema = z
  .object({
    origin: establishmentSchema,
    destination: destinationSchema,
    expected_ship_date: dateSchema,
    packaging_type: z.literal("pallet"),
    packaging_properties: palletPropertiesSchema,
    insurance: z
      .object({
        type: z.enum(["internal", "carrier"]),
        total_cost: moneyRequestSchema,
      })
      .strict()
      .optional(),
    reference_codes: z.array(z.string().min(1)).optional(),
    shipment_classification: z.enum(["B2B", "B2C", "C2B", "C2C"]).optional(),
  })
  .strict();

export const freightcomRateRequestSchema = z
  .object({
    services: z.array(z.string().min(1)).optional(),
    excluded_services: z.array(z.string().min(1)).optional(),
    details: shippingDetailsSchema,
  })
  .strict();

export const freightcomRateAcceptedResponseSchema = z
  .object({ request_id: identifierSchema })
  .strict();

const moneySchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/u),
    value: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  })
  .strict();

const surchargeSchema = z
  .object({
    type: z.string().min(1),
    amount: moneySchema,
  })
  .strict();

const rateSchema = z
  .object({
    carrier_name: z.string().optional(),
    service_name: z.string().optional(),
    service_id: z.string().optional(),
    valid_until: dateSchema.optional(),
    total: moneySchema.optional(),
    base: moneySchema.optional(),
    surcharges: z.array(surchargeSchema).optional(),
    taxes: z.array(surchargeSchema).optional(),
    transit_time_days: z.number().int().min(0).optional(),
    transit_time_not_available: z.boolean().optional(),
    transit_time_hours: z.number().int().min(0).optional(),
    carrier_cut_off_time: z.string().optional(),
    estimated_delivery_time: z.string().optional(),
    truck_details_ftl: z.string().optional(),
    transit_mode_ftl: z.string().optional(),
    paperless: z.boolean().optional(),
    customs_charge_data: z
      .object({
        duties_and_taxes_surcharge_keys: z.array(z.string()).nullable().optional(),
        guarantee_fee_surcharge_keys: z.array(z.string()).nullable().optional(),
        carrier_and_government_fees_surcharge_keys: z.array(z.string()).nullable().optional(),
        processing_fees_surcharge_keys: z.array(z.string()).nullable().optional(),
        is_rate_guaranteed: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const freightcomRatePollResponseSchema = z
  .object({
    status: z
      .object({
        done: z.boolean(),
        total: z.number().int().min(0),
        complete: z.number().int().min(0),
      })
      .strict(),
    rates: z.array(rateSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status.complete > value.status.total) {
      context.addIssue({
        code: "custom",
        message: "complete cannot exceed total",
        path: ["status", "complete"],
      });
    }
  });

export type FreightcomRateRequest = z.infer<typeof freightcomRateRequestSchema>;
export type FreightcomRatePollResponse = z.infer<typeof freightcomRatePollResponseSchema>;

export function toFreightcomProviderRateRequest(request: FreightcomRateRequest): unknown {
  const packaging = request.details.packaging_properties;
  return {
    ...request,
    details: {
      ...request.details,
      packaging_properties: {
        ...packaging,
        pallets: packaging.pallets.map((pallet) => ({
          ...pallet,
          measurements: {
            ...pallet.measurements,
            weight: {
              ...pallet.measurements.weight,
              value: Number(pallet.measurements.weight.value),
            },
          },
        })),
      },
    },
  };
}

export interface FreightcomRateData extends Record<string, unknown> {
  readonly provider: "freightcom";
  readonly api_version: typeof FREIGHTCOM_API_VERSION;
  readonly environment: "fixture" | "test";
  readonly request_id: string;
  readonly status: FreightcomRatePollResponse["status"];
  readonly rates: FreightcomRatePollResponse["rates"];
  readonly mcp_compatibility: "manual_review";
}

export type FreightcomRateHeaderProvider = (
  signal: AbortSignal,
) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

export type FreightcomRateSleep = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;

export interface FreightcomRateAdapterOptions {
  readonly mode: "fixtures" | "test" | "production";
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly fetchImpl?: FetchImplementation;
  readonly headerProvider?: FreightcomRateHeaderProvider;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxPollAttempts?: number;
  readonly pollDelayMs?: number;
  readonly sleep?: FreightcomRateSleep;
  readonly clock?: () => Date;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedStatusResponse(value: unknown): value is FetchJsonAllowedStatusResponse {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function notice(
  code: string,
  message: string,
  severity: "info" | "warning" | "error" = "error",
  field: string | null = null,
) {
  return { code, message, severity, field } as const;
}

function unavailable(code: string, message: string): AdapterResult {
  return {
    status: "unavailable",
    data: null,
    sourceRefs: [],
    calculationTrace: [],
    blockers: [notice(code, message)],
    reviewStatus: "manual_review",
  };
}

function needsInput(code: string, message: string, field: string): AdapterResult {
  return {
    status: "needs_input",
    data: null,
    sourceRefs: [],
    blockers: [notice(code, message, "error", field)],
  };
}

function blocked(code: string, message: string): AdapterResult {
  return {
    ...unavailable(code, message),
    status: "blocked",
  };
}

function hasAuthorizationHeader(headers: Readonly<Record<string, string>>): boolean {
  const matches = Object.entries(headers).filter(([name]) => name.toLowerCase() === "authorization");
  return matches.length === 1 && (matches[0]?.[1].trim().length ?? 0) > 0;
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new HttpAdapterError("upstream_aborted", "The Freightcom request was aborted."));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new HttpAdapterError("upstream_aborted", "The Freightcom request was aborted."));
    }, { once: true });
  });
}

function sourceRef(
  requestId: string,
  response: FreightcomRatePollResponse,
  retrievedAt: string,
  environment: "fixture" | "test",
): SourceRef {
  return {
    source_id: `src:freightcom:${environment}:${requestId}`,
    source_type: environment === "fixture" ? "fixture" : "opaque_reference",
    system: "Freightcom Customer API",
    locator: environment === "fixture"
      ? `fixture://freightcom/rate/${requestId}`
      : `opaque://freightcom/test/rate/${requestId}`,
    version: `freightcom-api@${FREIGHTCOM_API_VERSION}`,
    retrieved_at: retrievedAt,
    authority: "opaque",
    content_hash: hashPayload(response),
  };
}

function mapError(error: unknown): AdapterResult {
  if (error instanceof HttpAdapterError && error.code === "upstream_aborted") {
    return unavailable("freightcom.request_aborted", "The Freightcom rate request was aborted.");
  }
  if (error instanceof HttpAdapterError && (error.status === 401 || error.status === 403)) {
    return blocked(
      error.status === 401 ? "freightcom.unauthorized" : "freightcom.forbidden",
      "The Freightcom rate request was rejected by the configured authorization boundary.",
    );
  }
  return unavailable(
    "freightcom.upstream_unavailable",
    "The Freightcom rate request could not be completed safely.",
  );
}

export class FreightcomRateAdapter {
  private readonly mode: FreightcomRateAdapterOptions["mode"];
  private readonly client: ReturnType<typeof createFetchJsonClient>;
  private readonly headerProvider: FreightcomRateHeaderProvider | undefined;
  private readonly maxPollAttempts: number;
  private readonly pollDelayMs: number;
  private readonly sleep: FreightcomRateSleep;
  private readonly clock: () => Date;

  constructor(options: FreightcomRateAdapterOptions) {
    this.mode = options.mode;
    this.headerProvider = options.headerProvider;
    this.maxPollAttempts = positiveInteger(options.maxPollAttempts ?? 3, "maxPollAttempts");
    this.pollDelayMs = nonNegativeInteger(options.pollDelayMs ?? 0, "pollDelayMs");
    this.sleep = options.sleep ?? defaultSleep;
    this.clock = options.clock ?? (() => new Date());
    this.client = createFetchJsonClient({
      baseUrl: options.baseUrl,
      allowedHosts: options.allowedHosts,
      enabled: options.mode !== "production",
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    });
  }

  async requestRate(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AdapterResult<FreightcomRateData>> {
    if (this.mode === "production") {
      return unavailable(
        "freightcom.production_disabled",
        "Freightcom production calls are disabled; only the explicitly enabled test environment may be used.",
      ) as AdapterResult<FreightcomRateData>;
    }
    if (signal?.aborted) {
      return unavailable(
        "freightcom.request_aborted",
        "The Freightcom rate request was aborted.",
      ) as AdapterResult<FreightcomRateData>;
    }
    const parsedInput = freightcomRateRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      return needsInput(
        "freightcom.request_invalid",
        "The Freightcom rate request does not satisfy the narrowed pallet-rate contract.",
        "input",
      ) as AdapterResult<FreightcomRateData>;
    }
    if (this.headerProvider === undefined) {
      return blocked(
        "freightcom.authorization_unconfigured",
        "The Freightcom Authorization header provider is not configured.",
      ) as AdapterResult<FreightcomRateData>;
    }

    const requestSignal = signal ?? new AbortController().signal;
    let headers: Readonly<Record<string, string>>;
    try {
      headers = await this.headerProvider(requestSignal);
    } catch {
      return blocked(
        "freightcom.authorization_unavailable",
        "The Freightcom Authorization header could not be obtained.",
      ) as AdapterResult<FreightcomRateData>;
    }
    if (!hasAuthorizationHeader(headers)) {
      return blocked(
        "freightcom.authorization_invalid",
        "The Freightcom Authorization header is missing or empty.",
      ) as AdapterResult<FreightcomRateData>;
    }

    let accepted: unknown;
    try {
      accepted = await this.client.post(
        "/rate",
        toFreightcomProviderRateRequest(parsedInput.data),
        headers,
        requestSignal,
        [202],
      );
    } catch (error: unknown) {
      return mapError(error) as AdapterResult<FreightcomRateData>;
    }
    if (!isAllowedStatusResponse(accepted) || accepted.status !== 202) {
      return unavailable(
        "freightcom.accepted_response_status_invalid",
        "The Freightcom rate request did not return the documented 202 response.",
      ) as AdapterResult<FreightcomRateData>;
    }
    const acceptedBody = freightcomRateAcceptedResponseSchema.safeParse(accepted.body);
    if (!acceptedBody.success) {
      return unavailable(
        "freightcom.accepted_response_invalid",
        "The Freightcom 202 response did not contain a valid request_id.",
      ) as AdapterResult<FreightcomRateData>;
    }

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      let polled: unknown;
      try {
        polled = await this.client.get(
          `/rate/${encodeURIComponent(acceptedBody.data.request_id)}`,
          headers,
          requestSignal,
        );
      } catch (error: unknown) {
        return mapError(error) as AdapterResult<FreightcomRateData>;
      }
      const parsedPoll = freightcomRatePollResponseSchema.safeParse(polled);
      if (!parsedPoll.success) {
        return unavailable(
          "freightcom.poll_response_invalid",
          "The Freightcom rate polling response did not satisfy the narrowed response contract.",
        ) as AdapterResult<FreightcomRateData>;
      }
      if (parsedPoll.data.status.done) {
        const retrievedAt = this.clock().toISOString();
        const environment = this.mode === "test" ? "test" : "fixture";
        const ref = sourceRef(
          acceptedBody.data.request_id,
          parsedPoll.data,
          retrievedAt,
          environment,
        );
        return {
          status: "manual_review",
          data: {
            provider: "freightcom",
            api_version: FREIGHTCOM_API_VERSION,
            environment,
            request_id: acceptedBody.data.request_id,
            status: parsedPoll.data.status,
            rates: parsedPoll.data.rates,
            mcp_compatibility: "manual_review",
          },
          sourceRefs: [ref],
          warnings: [
            notice(
              environment === "fixture" ? "freightcom.fixture_only" : "freightcom.test_only",
              environment === "fixture"
                ? "The Freightcom response came from an isolated fixture and is not an authoritative rate."
                : "The Freightcom response came from the test environment and is not an authoritative production rate.",
              "warning",
            ),
          ],
          blockers: [
            notice(
              environment === "fixture" ? "freightcom.fixture_data" : "freightcom.test_data",
              environment === "fixture"
                ? "Fixture data cannot be promoted to an MCP quote success result."
                : "Test-environment data cannot be promoted to an MCP quote success result.",
            ),
            notice(
              "freightcom.release_evidence_missing",
              "The Freightcom response does not provide the MCP quote release, snapshot, tenant, and validity evidence.",
            ),
          ],
          calculationTrace: [],
          reviewStatus: "manual_review",
        };
      }
      if (attempt + 1 < this.maxPollAttempts) {
        try {
          await this.sleep(this.pollDelayMs, requestSignal);
        } catch (error: unknown) {
          return mapError(error) as AdapterResult<FreightcomRateData>;
        }
      }
    }
    return unavailable(
      "freightcom.rate_poll_timeout",
      "The Freightcom rate request did not reach done=true within the bounded polling window.",
    ) as AdapterResult<FreightcomRateData>;
  }
}

export function createFreightcomFixtureRateAdapter(): FreightcomRateAdapter {
  return new FreightcomRateAdapter({
    mode: "fixtures",
    baseUrl: "https://fixture.example.invalid",
    allowedHosts: ["fixture.example.invalid"],
    headerProvider: () => ({ Authorization: "fixture-authorization" }),
    fetchImpl: (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.endsWith("/rate") && init?.method === "POST") {
        return Promise.resolve(new Response(
          JSON.stringify({ request_id: "rate-fixture-mcp-001" }),
          { status: 202, headers: { "content-type": "application/json" } },
        ));
      }
      if (url.endsWith("/rate/rate-fixture-mcp-001") && init?.method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({
          status: { done: true, total: 1, complete: 1 },
          rates: [{
            carrier_name: "Fixture Carrier",
            service_name: "Fixture LTL",
            service_id: "fixture.ltl",
            valid_until: { year: 2026, month: 8, day: 31 },
            total: { currency: "CAD", value: "17936" },
            base: { currency: "CAD", value: "15000" },
            surcharges: [{
              type: "fuel",
              amount: { currency: "CAD", value: "2936" },
            }],
            taxes: [],
            transit_time_days: 2,
            transit_time_not_available: false,
            paperless: false,
          }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    },
    maxPollAttempts: 1,
    pollDelayMs: 0,
    clock: () => new Date("2026-08-25T00:00:00.000Z"),
  });
}
