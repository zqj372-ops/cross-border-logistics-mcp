import { z } from "zod";

import { quoteV2ResultSchema } from "../../adapters/quote/quote-v2-contract";
import { envelopeSchema } from "../../platform/envelope";

const calculatedQuoteDataSchema = quoteV2ResultSchema.options[0];
const manualQuoteDataSchema = quoteV2ResultSchema.options[1];

const quoteV2EnvelopeBranches = z.union([
  envelopeSchema.extend({
    status: z.literal("success"),
    data: calculatedQuoteDataSchema,
    source_refs: envelopeSchema.shape.source_refs.min(1),
    calculation_trace: envelopeSchema.shape.calculation_trace.min(1),
  }),
  envelopeSchema.extend({
    status: z.literal("manual_review"),
    data: z.null(),
    source_refs: envelopeSchema.shape.source_refs.max(0),
    calculation_trace: envelopeSchema.shape.calculation_trace.max(0),
  }),
  envelopeSchema.extend({
    status: z.literal("manual_review"),
    data: manualQuoteDataSchema,
    source_refs: envelopeSchema.shape.source_refs.min(1),
  }),
  envelopeSchema.extend({
    status: z.enum(["needs_input", "blocked", "unavailable"]),
    data: z.null(),
    source_refs: envelopeSchema.shape.source_refs.max(0),
    calculation_trace: envelopeSchema.shape.calculation_trace.max(0),
  }),
]);

export const quoteV2EnvelopeSchema = envelopeSchema
  .extend({ data: quoteV2ResultSchema.nullable() })
  .superRefine((envelope, refinement) => {
    if (!quoteV2EnvelopeBranches.safeParse(envelope).success) {
      refinement.addIssue({
        code: "custom",
        message: "quote status and data do not match an allowed v2 envelope branch",
      });
    }
    const sourceIds = envelope.source_refs.map((source) => source.source_id);
    const traceIds = envelope.calculation_trace.flatMap(
      (step) => step.source_ref_ids,
    );
    const data = envelope.data;
    const dataSourceIds = data?.source_ref_ids ?? [];
    const lineSourceIds = data?.line_items.flatMap(
      (line) => line.source_ref_ids,
    ) ?? [];
    const union = [...new Set([...dataSourceIds, ...lineSourceIds, ...traceIds])];
    const sameSourceSet =
      new Set(sourceIds).size === sourceIds.length &&
      union.length === sourceIds.length &&
      union.every((sourceId) => sourceIds.includes(sourceId));

    if (
      (data !== null || sourceIds.length > 0 || traceIds.length > 0) &&
      !sameSourceSet
    ) {
      refinement.addIssue({
        code: "custom",
        message: "quote source IDs must match the outer source refs exactly",
      });
    }
  })
  .meta({
    anyOf: z.toJSONSchema(quoteV2EnvelopeBranches, {
      target: "draft-2020-12",
    }).anyOf,
  });
