import { z } from "zod";

import {
  createFetchJsonClient,
  HttpAdapterError,
  type FetchImplementation,
  type FetchJsonAllowedStatusResponse,
} from "../http-client";
import { hashPayload } from "../../platform/idempotency";
import type { SourceRef } from "../../platform/envelope";
import {
  freightcomRateAcceptedResponseSchema,
  freightcomRatePollResponseSchema,
  freightcomRateRequestSchema,
  toFreightcomProviderRateRequest,
  type FreightcomRatePollResponse,
} from "./freightcom-rate-adapter";

export const DEFAULT_FREIGHTCOM_TEST_BASE_URL =
  "https://customer-external-api.ssd-test.freightcom.com" as const;
export const FREIGHTCOM_TEST_API_VERSION = "2.10.0" as const;

const requestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

export interface FreightcomTestRateClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly allowedHosts: readonly string[];
  readonly fetchImpl?: FetchImplementation;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly clock?: () => Date;
}

export interface FreightcomTestRateClient {
  submitRate(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly requestId: string }>;
  pollRate(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<FreightcomTestPollResult>;
}

export interface FreightcomTestPollResult extends FreightcomRatePollResponse {
  readonly retrievedAt: string;
  readonly sourceRef: SourceRef;
}

export class FreightcomTestClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FreightcomTestClientError";
  }
}

function isAllowedStatusResponse(value: unknown): value is FetchJsonAllowedStatusResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { status?: unknown }).status === "number" &&
    "body" in value
  );
}

function mapHttpError(
  error: unknown,
  operation: "submit" | "poll",
): FreightcomTestClientError {
  if (error instanceof FreightcomTestClientError) return error;
  if (error instanceof HttpAdapterError && (error.status === 401 || error.status === 403)) {
    return new FreightcomTestClientError(
      "freightcom.test_auth_failed",
      "The Freightcom test endpoint rejected the configured authorization.",
      error.status,
    );
  }
  if (
    operation === "submit" &&
    error instanceof HttpAdapterError &&
    error.status !== undefined &&
    [400, 409, 422].includes(error.status)
  ) {
    return new FreightcomTestClientError(
      "freightcom.test_request_rejected",
      "The Freightcom test endpoint rejected one or more request fields.",
      error.status,
    );
  }
  if (error instanceof HttpAdapterError && error.code === "upstream_aborted") {
    return new FreightcomTestClientError(
      "freightcom.test_request_aborted",
      "The Freightcom test request was aborted.",
    );
  }
  return new FreightcomTestClientError(
    "freightcom.test_upstream_unavailable",
    "The Freightcom test endpoint could not be reached safely.",
  );
}

function sourceRef(
  requestId: string,
  response: FreightcomRatePollResponse,
  retrievedAt: string,
): SourceRef {
  return {
    source_id: `src:freightcom:test:${requestId}`,
    source_type: "opaque_reference",
    system: "Freightcom Customer API",
    locator: `opaque://freightcom/test/rate/${requestId}`,
    version: `freightcom-api@${FREIGHTCOM_TEST_API_VERSION}`,
    retrieved_at: retrievedAt,
    authority: "opaque",
    content_hash: hashPayload(response),
  };
}

export function createFreightcomTestRateClient(
  options: FreightcomTestRateClientOptions,
): FreightcomTestRateClient {
  if (options.token.trim().length === 0) {
    throw new FreightcomTestClientError(
      "freightcom.test_token_missing",
      "The Freightcom test token must be provided by the server environment.",
    );
  }
  const client = createFetchJsonClient({
    baseUrl: options.baseUrl,
    allowedHosts: options.allowedHosts,
    enabled: true,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
  });
  const clock = options.clock ?? (() => new Date());
  const headers = { Authorization: options.token };

  return {
    async submitRate(input, signal) {
      const parsed = freightcomRateRequestSchema.safeParse(input);
      if (!parsed.success) {
        throw new FreightcomTestClientError(
          "freightcom.test_request_invalid",
          "The LTL pallet request does not satisfy the Freightcom test contract.",
          400,
        );
      }
      let accepted: unknown;
      try {
        accepted = await client.post(
          "/rate",
          toFreightcomProviderRateRequest(parsed.data),
          headers,
          signal,
          [202],
        );
      } catch (error: unknown) {
        throw mapHttpError(error, "submit");
      }
      if (!isAllowedStatusResponse(accepted) || accepted.status !== 202) {
        throw new FreightcomTestClientError(
          "freightcom.test_accepted_status_invalid",
          "The Freightcom test endpoint did not return the documented 202 response.",
        );
      }
      const parsedAccepted = freightcomRateAcceptedResponseSchema.safeParse(accepted.body);
      if (!parsedAccepted.success) {
        throw new FreightcomTestClientError(
          "freightcom.test_accepted_response_invalid",
          "The Freightcom test endpoint did not return a valid request id.",
        );
      }
      return { requestId: parsedAccepted.data.request_id };
    },

    async pollRate(requestId, signal) {
      if (!requestIdSchema.safeParse(requestId).success) {
        throw new FreightcomTestClientError(
          "freightcom.test_request_id_invalid",
          "The Freightcom request id is invalid.",
          400,
        );
      }
      let polled: unknown;
      try {
        polled = await client.get(
          `/rate/${encodeURIComponent(requestId)}`,
          headers,
          signal,
        );
      } catch (error: unknown) {
        throw mapHttpError(error, "poll");
      }
      const parsed = freightcomRatePollResponseSchema.safeParse(polled);
      if (!parsed.success) {
        throw new FreightcomTestClientError(
          "freightcom.test_poll_response_invalid",
          "The Freightcom test polling response did not satisfy the validated provider contract.",
        );
      }
      const retrievedAt = clock().toISOString();
      return {
        ...parsed.data,
        retrievedAt,
        sourceRef: sourceRef(requestId, parsed.data, retrievedAt),
      };
    },
  };
}
