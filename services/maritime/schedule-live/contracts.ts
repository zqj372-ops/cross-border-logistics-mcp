import { z } from "zod";

import {
  CARRIER_CAPABILITY_STATUSES,
  CollectorQueryInputSchema,
  CollectorResultDataSchema,
  LocationTypeSchema,
  parseCollectorQueryInput,
  type CollectorQueryInput,
  type CollectorResultData,
} from "../schedule-collector/contracts";
import { CARRIER_IDS } from "../schedule-collector/carriers/aliases";
import {
  ENVELOPE_SCHEMA_VERSION,
  ENVELOPE_STATUSES,
  envelopeSchema,
  validateEnvelope,
  type EnvelopeStatus,
} from "../../../src/logistics_mcp/platform/envelope";

/**
 * Product-facing contract for the ocean schedule collector. It reuses the
 * collector data contract and the shared response envelope; it never rewrites
 * collector records into the legacy `sailingRow` snapshot shape.
 */
export const SCHEDULE_LIVE_VERSION = "ocean-schedule-live@2026-09-18.v1" as const;

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const shortText = z.string().trim().min(1).max(200);
/**
 * Controlled carrier enum. It is transform-free on purpose so the exported
 * Draft 2020-12 schema can be generated without the alias-normalizing
 * transform that only exists in the domain parser.
 */
export const ScheduleLiveCarrierIdSchema = z.enum(CARRIER_IDS);
const countryCode = z.string().regex(/^[A-Z]{2}$/u);
const wireDate = z.string().date();

export const ScheduleLiveCarriersDataSchema = z
  .object({
    carriers: z
      .array(
        z
          .object({
            id: ScheduleLiveCarrierIdSchema,
            display_name: shortText,
            adapter_version: shortText,
            capability_status: z.enum(CARRIER_CAPABILITY_STATUSES),
            last_live_verified_at: z.string().nullable(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

export const ScheduleLiveCarriersEnvelopeSchema = envelopeSchema
  .extend({
    data: ScheduleLiveCarriersDataSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.status === "success" && value.data === null) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "success requires carrier registry data",
      });
    }
    if (value.status !== "success" && value.data !== null) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "a non-success carrier registry response must not return data",
      });
    }
  });

export const ScheduleLiveLocationCandidateSchema = z
  .object({
    name: shortText,
    country_code: countryCode.nullable(),
    type: LocationTypeSchema,
    carrier_location_id: identifier,
    mapping_source: shortText,
    source_full_name: shortText.nullable(),
    unlocode: z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/u).nullable(),
  })
  .strict();

export const ScheduleLiveResolvedLocationSchema = z
  .object({
    input_text: shortText,
    name: shortText,
    country_code: countryCode.nullable(),
    type: LocationTypeSchema,
    carrier_location_id: identifier,
    mapping_source: shortText,
    source_full_name: shortText.nullable(),
    unlocode: z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/u).nullable(),
  })
  .strict();

export const ScheduleLiveLocationsRequestSchema = z
  .object({
    carrier: ScheduleLiveCarrierIdSchema,
    text: shortText,
    country_code: countryCode.nullable().optional(),
    carrier_location_id: identifier.nullable().optional(),
  })
  .strict();

export const ScheduleLiveLocationsDataSchema = z
  .object({
    carrier: ScheduleLiveCarrierIdSchema,
    query: shortText,
    candidates: z.array(ScheduleLiveLocationCandidateSchema).min(1).max(64),
    resolved: ScheduleLiveResolvedLocationSchema.nullable(),
  })
  .strict();

export const ScheduleLiveLocationsEnvelopeSchema = envelopeSchema
  .extend({
    data: ScheduleLiveLocationsDataSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.status === "success" &&
      (value.data === null || value.data.resolved === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "success requires a unique resolved location",
      });
    }
    if (
      value.status === "needs_input" &&
      value.data !== null &&
      value.data.resolved !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["data", "resolved"],
        message: "needs_input must not pre-select an ambiguous location",
      });
    }
    if (
      (value.status === "blocked" || value.status === "unavailable") &&
      value.data !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: `${value.status} must return data=null`,
      });
    }
  });

/**
 * Wire input for MCP tool discovery. It is deliberately transform/refine-free
 * so `z.toJSONSchema` can emit a real Draft 2020-12 document; the handler still
 * runs the domain `CollectorQueryInputSchema` for calendar and 90-day rules.
 */
export const ScheduleLiveSearchRequestSchema = z
  .object({
    carrier: ScheduleLiveCarrierIdSchema,
    origin: z
      .object({
        text: shortText,
        country_code: countryCode.nullable(),
        carrier_location_id: identifier.nullable(),
      })
      .strict(),
    destination: z
      .object({
        text: shortText,
        country_code: countryCode.nullable(),
        carrier_location_id: identifier.nullable(),
      })
      .strict(),
    from: wireDate,
    until: wireDate,
    routing: z.enum(["any", "direct", "transshipment"]),
  })
  .strict();

/** Domain search input, including carrier alias normalization and window rules. */
export const ScheduleLiveSearchDomainSchema = CollectorQueryInputSchema;

export const ScheduleLiveSearchEnvelopeSchema = envelopeSchema
  .extend({
    status: z.enum(ENVELOPE_STATUSES),
    data: CollectorResultDataSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.status === "success") {
      if (value.data === null) {
        context.addIssue({
          code: "custom",
          path: ["data"],
          message: "success requires collector data",
        });
        return;
      }
      if (
        value.data.run_status !== "ok" &&
        value.data.run_status !== "no_results"
      ) {
        context.addIssue({
          code: "custom",
          path: ["data", "run_status"],
          message: "success is limited to ok or no_results",
        });
      }
      if (!value.data.coverage.complete) {
        context.addIssue({
          code: "custom",
          path: ["data", "coverage", "complete"],
          message: "success requires complete coverage",
        });
      }
      if (value.data.provenance.kind !== "live") {
        context.addIssue({
          code: "custom",
          path: ["data", "provenance", "kind"],
          message: "synthetic and replay data cannot be success",
        });
      }
    }
    if (
      (value.status === "blocked" ||
        value.status === "unavailable" ||
        value.status === "needs_input") &&
      value.data !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: `${value.status} must return data=null`,
      });
    }
  });

export type ScheduleLiveCarriersData = z.infer<typeof ScheduleLiveCarriersDataSchema>;
export type ScheduleLiveLocationsRequest = z.infer<typeof ScheduleLiveLocationsRequestSchema>;
export type ScheduleLiveLocationsData = z.infer<typeof ScheduleLiveLocationsDataSchema>;
export type ScheduleLiveSearchRequest = z.infer<typeof ScheduleLiveSearchRequestSchema>;
export type ScheduleLiveSearchDomainRequest = CollectorQueryInput;
export type ScheduleLiveEnvelope = z.infer<typeof envelopeSchema> & {
  readonly data: CollectorResultData | null;
};

export interface ScheduleLiveResponse {
  readonly status: EnvelopeStatus;
  readonly body: unknown;
}

function issuePaths(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "<root>"))
    .join(", ");
}

export function parseScheduleLiveLocationsRequest(
  input: unknown,
): ScheduleLiveLocationsRequest {
  const parsed = ScheduleLiveLocationsRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ScheduleLiveContractError(
      "schedule_live_location_input_invalid",
      issuePaths(parsed.error),
    );
  }
  return parsed.data;
}

export function parseScheduleLiveSearchRequest(
  input: unknown,
): ScheduleLiveSearchDomainRequest {
  const parsed = ScheduleLiveSearchRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ScheduleLiveContractError(
      "schedule_live_search_input_invalid",
      issuePaths(parsed.error),
    );
  }
  try {
    return parseCollectorQueryInput(parsed.data);
  } catch (error) {
    throw new ScheduleLiveContractError(
      "schedule_live_search_input_invalid",
      error instanceof Error ? error.message : "domain_validation_failed",
    );
  }
}

/** Draft 2020-12 projection used by tools/list; throws if a schema is not wire-safe. */
export function scheduleLiveJsonSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
}

export function parseScheduleLiveSearchEnvelope(
  input: unknown,
): z.infer<typeof ScheduleLiveSearchEnvelopeSchema> {
  let envelope: unknown;
  try {
    envelope = validateEnvelope(input);
  } catch (error) {
    throw new ScheduleLiveContractError(
      "schedule_live_search_response_invalid",
      error instanceof Error ? error.message : "envelope_invalid",
    );
  }
  const parsed = ScheduleLiveSearchEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new ScheduleLiveContractError(
      "schedule_live_search_response_invalid",
      issuePaths(parsed.error),
    );
  }
  return parsed.data;
}

export function parseScheduleLiveLocationsEnvelope(
  input: unknown,
): z.infer<typeof ScheduleLiveLocationsEnvelopeSchema> {
  let envelope: unknown;
  try {
    envelope = validateEnvelope(input);
  } catch (error) {
    throw new ScheduleLiveContractError(
      "schedule_live_location_response_invalid",
      error instanceof Error ? error.message : "envelope_invalid",
    );
  }
  const parsed = ScheduleLiveLocationsEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new ScheduleLiveContractError(
      "schedule_live_location_response_invalid",
      issuePaths(parsed.error),
    );
  }
  return parsed.data;
}

export function parseScheduleLiveCarriersEnvelope(
  input: unknown,
): z.infer<typeof ScheduleLiveCarriersEnvelopeSchema> {
  let envelope: unknown;
  try {
    envelope = validateEnvelope(input);
  } catch (error) {
    throw new ScheduleLiveContractError(
      "schedule_live_carriers_response_invalid",
      error instanceof Error ? error.message : "envelope_invalid",
    );
  }
  const parsed = ScheduleLiveCarriersEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new ScheduleLiveContractError(
      "schedule_live_carriers_response_invalid",
      issuePaths(parsed.error),
    );
  }
  return parsed.data;
}

export function assertScheduleLiveEnvelope(input: unknown): ScheduleLiveEnvelope {
  const envelope = validateEnvelope<CollectorResultData>(input);
  return envelope as ScheduleLiveEnvelope;
}

export class ScheduleLiveContractError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ScheduleLiveContractError";
  }
}

export const SCHEDULE_LIVE_ENVELOPE_VERSION = ENVELOPE_SCHEMA_VERSION;
