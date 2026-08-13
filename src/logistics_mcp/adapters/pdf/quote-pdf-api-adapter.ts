import { z } from "zod";

import type { ExecutionContext } from "../../platform/context";
import {
  createFetchJsonClient,
  HttpAdapterError,
  type FetchImplementation,
  type FetchJsonAllowedStatusResponse,
  type FetchJsonClient,
} from "../http-client";

const POST_PATH = "/v2/quote-pdfs";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const DOCUMENT_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/u;
const HASH = /^[0-9a-f]{64}$/u;
const UPSTREAM_HASH = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

const metadataSchema = z
  .object({
    document_ref: z.string().regex(DOCUMENT_REF),
    sha256: z.string().regex(HASH),
    byte_length: z.number().int().min(0).max(50 * 1024 * 1024),
    renderer_version: z.string().min(1).max(128),
    template_version: z.string().min(1).max(128),
    status: z.literal("ready"),
    sendable: z.literal(false),
    quote_id: z.string().regex(IDENTIFIER),
    quote_version: z.string().regex(VERSION),
    release_id: z.string().regex(IDENTIFIER),
    rule_version: z.string().regex(IDENTIFIER),
    data_version: z.string().regex(IDENTIFIER),
    effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(isValidDate),
    snapshot_hash: z.string().regex(UPSTREAM_HASH),
    release_hash: z.string().regex(UPSTREAM_HASH),
    input_sha256: z.string().regex(HASH),
  })
  .strict();

export type QuotePdfMetadata = z.infer<typeof metadataSchema>;

export type QuotePdfCredentialProvider = (
  context: ExecutionContext,
  signal: AbortSignal,
) => string | Promise<string>;

export interface QuotePdfApiAdapterOptions {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly enabled?: boolean;
  readonly fetchImpl?: FetchImplementation;
  readonly timeoutMs?: number;
  readonly credentialProvider?: QuotePdfCredentialProvider;
}

export interface QuotePdfFailure {
  readonly kind: "blocked" | "unavailable" | "manual_review";
  readonly code: string;
  readonly dispatched: boolean;
  readonly upstreamStatus?: number;
}

export type QuotePdfPostResult =
  | { readonly ok: true; readonly status: 200 | 201; readonly metadata: QuotePdfMetadata }
  | { readonly ok: false; readonly failure: QuotePdfFailure };

export type QuotePdfGetResult =
  | { readonly ok: true; readonly metadata: QuotePdfMetadata }
  | { readonly ok: false; readonly failure: QuotePdfFailure };

function isAllowedStatusResponse(value: unknown): value is FetchJsonAllowedStatusResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as { status?: unknown }).status === "number" && "body" in value;
}

function isValidDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function failure(
  kind: QuotePdfFailure["kind"],
  code: string,
  dispatched: boolean,
  upstreamStatus?: number,
): QuotePdfFailure {
  return {
    kind,
    code,
    dispatched,
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
  };
}

function statusFailure(status: number, dispatched: boolean): QuotePdfFailure {
  if (status === 401 || status === 403 || status === 409) {
    return failure("blocked", `pdf.http_${status}`, dispatched, status);
  }
  if (status === 404) return failure("manual_review", "pdf.not_found", dispatched, status);
  return failure("unavailable", `pdf.http_${status}`, dispatched, status);
}

function getStatusFailure(status: number): QuotePdfFailure {
  if (status === 401 || status === 403) return failure("blocked", `pdf.http_${status}`, true, status);
  if (status === 404 || status >= 500) return failure("manual_review", `pdf.get_http_${status}`, true, status);
  return failure("unavailable", `pdf.get_http_${status}`, true, status);
}

function safeError(error: unknown): HttpAdapterError | null {
  return error instanceof HttpAdapterError ? error : null;
}

function preDispatchFailure(error: HttpAdapterError): QuotePdfFailure | null {
  if (error.code === "upstream_disabled") return failure("unavailable", "pdf.adapter_disabled", false);
  if (
    error.code === "upstream_scheme_not_allowed" ||
    error.code === "upstream_host_not_allowed" ||
    error.code === "upstream_request_invalid"
  ) {
    return failure("unavailable", "pdf.endpoint_invalid", false, error.status);
  }
  return null;
}

function isUncertain(error: HttpAdapterError): boolean {
  return (
    error.code === "upstream_timeout" ||
    error.code === "upstream_invalid_json" ||
    error.code === "upstream_response_too_large" ||
    (error.code === "upstream_http_error" && error.status === undefined)
  );
}

export class QuotePdfApiAdapter {
  private readonly client: FetchJsonClient;
  private readonly enabled: boolean;
  private readonly credentialProvider: QuotePdfCredentialProvider | undefined;

  constructor(options: QuotePdfApiAdapterOptions) {
    this.client = createFetchJsonClient({
      baseUrl: options.baseUrl,
      allowedHosts: options.allowedHosts,
      enabled: options.enabled === true,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    this.enabled = options.enabled === true;
    this.credentialProvider = options.credentialProvider;
  }

  async post(
    body: Record<string, unknown>,
    idempotencyKey: string,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<QuotePdfPostResult> {
    if (!this.enabled) {
      return { ok: false, failure: failure("unavailable", "pdf.adapter_disabled", false) };
    }
    if (signal?.aborted) {
      return { ok: false, failure: failure("unavailable", "pdf.request_aborted", false) };
    }
    const authorization = await this.authorization(context, signal);
    if (typeof authorization !== "string") return { ok: false, failure: authorization };

    const first = await this.postOnce(body, idempotencyKey, authorization, signal);
    if (first.ok || !first.uncertain) return first.result;
    if (signal?.aborted) {
      return { ok: false, failure: failure("manual_review", "pdf.post_unknown_after_abort", true) };
    }

    const replay = await this.postOnce(body, idempotencyKey, authorization, signal);
    if (replay.ok) return replay.result;
    return {
      ok: false,
      failure: failure("manual_review", "pdf.post_result_unknown", true, replay.result.failure.upstreamStatus),
    };
  }

  async get(
    documentRef: string,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<QuotePdfGetResult> {
    if (!this.enabled) {
      return { ok: false, failure: failure("unavailable", "pdf.adapter_disabled", false) };
    }
    if (signal?.aborted) {
      return { ok: false, failure: failure("unavailable", "pdf.request_aborted", false) };
    }
    if (!DOCUMENT_REF.test(documentRef)) {
      return { ok: false, failure: failure("manual_review", "pdf.document_ref_invalid", false) };
    }
    const authorization = await this.authorization(context, signal);
    if (typeof authorization !== "string") return { ok: false, failure: authorization };

    try {
      const response = await this.client.get(
        `${POST_PATH}/${encodeURIComponent(documentRef)}`,
        { Authorization: authorization },
        signal,
        [200, 401, 403, 404, 500, 503],
      );
      if (!isAllowedStatusResponse(response)) {
        return { ok: false, failure: failure("manual_review", "pdf.get_contract_invalid", true) };
      }
      if (response.status !== 200) {
        return { ok: false, failure: getStatusFailure(response.status) };
      }
      const parsed = metadataSchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, metadata: parsed.data }
        : { ok: false, failure: failure("manual_review", "pdf.get_contract_invalid", true) };
    } catch (error: unknown) {
      const parsed = safeError(error);
      if (parsed === null) return { ok: false, failure: failure("manual_review", "pdf.get_unknown", true) };
      const beforeDispatch = preDispatchFailure(parsed);
      if (beforeDispatch !== null) return { ok: false, failure: beforeDispatch };
      if (parsed.code === "upstream_aborted" && !signal?.aborted) {
        return { ok: false, failure: failure("manual_review", "pdf.get_aborted", true) };
      }
      if (parsed.status !== undefined) {
        return { ok: false, failure: getStatusFailure(parsed.status) };
      }
      return { ok: false, failure: failure("manual_review", "pdf.get_unknown", true) };
    }
  }

  private async authorization(
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<string | QuotePdfFailure> {
    if (signal?.aborted) return failure("unavailable", "pdf.request_aborted", false);
    if (this.credentialProvider === undefined) {
      return failure("blocked", "pdf.credential_missing", false);
    }
    const providerSignal = signal ?? new AbortController().signal;
    try {
      const value = await this.credentialProvider(context, providerSignal);
      if (typeof value !== "string" || !/^Bearer [^\s\r\n]+$/u.test(value)) {
        return failure("blocked", "pdf.credential_invalid", false);
      }
      return value;
    } catch {
      return signal?.aborted
        ? failure("unavailable", "pdf.request_aborted", false)
        : failure("blocked", "pdf.credential_unavailable", false);
    }
  }

  private async postOnce(
    body: Record<string, unknown>,
    idempotencyKey: string,
    authorization: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly result: Extract<QuotePdfPostResult, { ok: true }> }
    | { readonly ok: false; readonly uncertain: boolean; readonly result: Extract<QuotePdfPostResult, { ok: false }> }
  > {
    try {
      const response = await this.client.post(
        POST_PATH,
        body,
        { Authorization: authorization, "Idempotency-Key": idempotencyKey },
        signal,
        [200, 201, 400, 401, 403, 404, 409, 413, 500, 503],
      );
      if (!isAllowedStatusResponse(response)) {
        return {
          ok: false,
          uncertain: true,
          result: { ok: false, failure: failure("manual_review", "pdf.post_contract_invalid", true) },
        };
      }
      if (response.status !== 200 && response.status !== 201) {
        return {
          ok: false,
          uncertain: false,
          result: { ok: false, failure: statusFailure(response.status, true) },
        };
      }
      const parsed = metadataSchema.safeParse(response.body);
      if (!parsed.success) {
        return {
          ok: false,
          uncertain: true,
          result: { ok: false, failure: failure("manual_review", "pdf.post_contract_invalid", true) },
        };
      }
      return { ok: true, result: { ok: true, status: response.status, metadata: parsed.data } };
    } catch (error: unknown) {
      const parsed = safeError(error);
      if (parsed === null) {
        return {
          ok: false,
          uncertain: true,
          result: { ok: false, failure: failure("manual_review", "pdf.post_unknown", true) },
        };
      }
      const beforeDispatch = preDispatchFailure(parsed);
      if (beforeDispatch !== null) {
        return { ok: false, uncertain: false, result: { ok: false, failure: beforeDispatch } };
      }
      if (parsed.code === "upstream_aborted") {
        return {
          ok: false,
          uncertain: false,
          result: { ok: false, failure: failure("manual_review", "pdf.post_aborted", true) },
        };
      }
      if (parsed.status !== undefined) {
        return {
          ok: false,
          uncertain: false,
          result: { ok: false, failure: statusFailure(parsed.status, true) },
        };
      }
      return {
        ok: false,
        uncertain: isUncertain(parsed),
        result: { ok: false, failure: failure("manual_review", "pdf.post_unknown", true) },
      };
    }
  }
}
