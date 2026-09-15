import { z } from "zod";
import type { Capture, OutreachPorts } from "../types.js";
import { createProviderClient, providerError, providerHeaders, providerInvalid, type ProviderHttpOptions } from "./common.js";

export const OUTREACH_CAPTURE_REQUEST_SCHEMA_VERSION = "outreach-capture-request@2026-09-11.v1" as const;
export const OUTREACH_CAPTURE_SCHEMA_VERSION = "outreach-capture@2026-09-11.v1" as const;

const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const captureSchema = z.object({
  schema_version: z.literal(OUTREACH_CAPTURE_SCHEMA_VERSION),
  capture_ref: ref,
  company: z.string().min(1).max(200),
  city: z.literal("Toronto"),
  url: z.string().url().max(2000),
  captured_at: z.string().datetime(),
  html: z.string().min(1).max(250_000),
  test_data: z.boolean(),
}).strict();
const statusResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
}).strict();

export type HttpCaptureOptions = ProviderHttpOptions;

function parseCapture(value: unknown, expectedRef: string): Capture {
  const parsed = captureSchema.safeParse(value);
  if (!parsed.success || parsed.data.capture_ref !== expectedRef) throw providerInvalid();
  return {
    capture_ref: parsed.data.capture_ref,
    company: parsed.data.company,
    city: parsed.data.city,
    url: parsed.data.url,
    captured_at: parsed.data.captured_at,
    html: parsed.data.html,
    test_data: parsed.data.test_data,
  };
}

export function createHttpCapturePort(options: HttpCaptureOptions): OutreachPorts["capture"] {
  const client = createProviderClient(options);
  return async (tenantId, captureRef): Promise<Capture | null> => {
    try {
      const response = await client.get(
        `/v1/captures/${encodeURIComponent(captureRef)}`,
        providerHeaders(options.token, tenantId),
        undefined,
        [200, 404],
      );
      const status = statusResponseSchema.safeParse(response);
      if (!status.success) throw providerInvalid();
      if (status.data.status === 404) return null;
      if (status.data.status !== 200) throw providerInvalid();
      return parseCapture(status.data.body, captureRef);
    } catch (error: unknown) {
      throw providerError(error);
    }
  };
}

export class HttpCaptureCollector {
  private readonly client;
  constructor(private readonly options: HttpCaptureOptions) {
    this.client = createProviderClient(options);
  }

  async collect(tenantId: string, captureRef: string): Promise<Capture> {
    try {
      const response = await this.client.post("/v1/captures", {
        schema_version: OUTREACH_CAPTURE_REQUEST_SCHEMA_VERSION,
        capture_ref: captureRef,
      }, providerHeaders(this.options.token, tenantId));
      return parseCapture(response, captureRef);
    } catch (error: unknown) {
      throw providerError(error);
    }
  }
}
