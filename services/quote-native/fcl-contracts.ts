import { z } from 'zod';
import { FCL_CONTAINER_TYPES, FCL_SERVICE_IDS } from '../../apps/inquiry/fcl-model';

export const FCL_RATE_DATASET_VERSION = 'fcl-rate-dataset@2026-09-20.v1' as const;

// eslint-disable-next-line no-control-regex
const SINGLE_LINE_PATTERN = /^(?=[\s\S]*\S)[^\u0000-\u001f\u007f]+$/u;
// eslint-disable-next-line no-control-regex
const NOTE_PATTERN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(0|[1-9]\d{0,9})(?:\.\d{1,6})?$/u;

const identifier = (max = 200) => z.string().min(1).max(max).regex(SINGLE_LINE_PATTERN);
const note = () => z.string().max(2000).regex(NOTE_PATTERN).nullable();
const decimal = () => z.string().regex(NON_NEGATIVE_DECIMAL_PATTERN);
const date = () => z.iso.date();
const currency = z.enum(['USD', 'CAD', 'CNY']);
const containerType = z.enum(FCL_CONTAINER_TYPES);
const service = z.enum(FCL_SERVICE_IDS);

const fclRateItemSchema = z.object({
  container_type: containerType,
  ocean_freight: decimal(),
  currency,
}).strict();

const fclAdditionalFeeBase = {
  name: identifier(),
  group: z.enum(['A', 'B', 'C']),
  service,
  cost_price: decimal(),
  currency,
  note: note(),
};
const fclAdditionalFeeSchema = z.discriminatedUnion('unit', [
  z.object({ ...fclAdditionalFeeBase, unit: z.literal('CNTR'), container_type: containerType }).strict(),
  z.object({ ...fclAdditionalFeeBase, unit: z.literal('SHIPMENT'), container_type: z.null() }).strict(),
]);

export const fclRateSchema = z.object({
  rate_id: z.string().uuid(),
  supplier_label: identifier(),
  pol: identifier(),
  pod: identifier(),
  valid_from: date(),
  valid_until: date(),
  source_ref: identifier(),
  source_version: identifier(),
  note: note(),
  items: z.array(fclRateItemSchema).min(1).max(4),
  additional_fees: z.array(fclAdditionalFeeSchema).max(30),
}).strict();

export const fclRateDatasetSchema = z.object({
  contract_version: z.literal(FCL_RATE_DATASET_VERSION),
  label: identifier(),
  rates: z.array(fclRateSchema).min(1).max(500),
}).strict().superRefine((dataset, context) => {
  const seenRateIds = new Set<string>();
  dataset.rates.forEach((rate, rateIndex) => {
    if (seenRateIds.has(rate.rate_id)) {
      context.addIssue({ code: 'custom', path: ['rates', rateIndex, 'rate_id'], message: 'duplicate_rate_id' });
    }
    seenRateIds.add(rate.rate_id);

    if (rate.valid_from > rate.valid_until) {
      context.addIssue({ code: 'custom', path: ['rates', rateIndex, 'valid_until'], message: 'rate_date_order_invalid' });
    }

    const containers = new Set(rate.items.map((item) => item.container_type));
    if (containers.size !== rate.items.length) {
      context.addIssue({ code: 'custom', path: ['rates', rateIndex, 'items'], message: 'duplicate_container_type' });
    }

    rate.additional_fees.forEach((fee, feeIndex) => {
      if (fee.unit === 'CNTR' && fee.container_type !== null && !containers.has(fee.container_type)) {
        context.addIssue({ code: 'custom', path: ['rates', rateIndex, 'additional_fees', feeIndex, 'container_type'], message: 'fee_container_not_in_items' });
      }
    });
  });
});

export type FclRateDataset = z.infer<typeof fclRateDatasetSchema>;

export const fclRatePublicationSchema = z.object({
  release_id: z.string().uuid(),
  version: z.number().int().positive(),
  input: fclRateDatasetSchema,
  published_at: z.iso.datetime(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type FclRatePublication = z.infer<typeof fclRatePublicationSchema>;

export const fclRateSaveSchema = z.object({
  expected_version: z.number().int().nonnegative(),
  input: fclRateDatasetSchema,
}).strict();

export function validateFclRateDataset(input: unknown): string[] {
  const parsed = fclRateDatasetSchema.safeParse(input);
  if (parsed.success) return [];
  const messages = parsed.error.issues.map((issue) => issue.message.trim() || issue.code);
  if (messages.some((message) => ['duplicate_rate_id','rate_date_order_invalid','duplicate_container_type','fee_container_not_in_items'].includes(message))) {
    return [...new Set(messages)];
  }
  return ['fcl_rate_dataset_structure_invalid'];
}

export const FCL_QUOTE_WORKFLOW_VERSION = 'fcl-quote-workflow@2026-09-20.v1' as const;

export const fclQuoteMatchRequestSchema = z.object({
  contract_version: z.literal(FCL_QUOTE_WORKFLOW_VERSION),
  case_ref: z.string().uuid(),
  expected_case_version: z.number().int().positive(),
  expected_customer_supplement_ref: z.string().uuid().nullable(),
  selected_rate_id: z.string().uuid().nullable(),
}).strict();

export const fclQuoteCaseBindingSchema = z.object({
  case_ref: z.string().uuid(),
  case_version: z.number().int().positive(),
  latest_customer_supplement_ref: z.string().uuid().nullable(),
}).strict();

export const fclQuoteSourceRefSchema = z.object({
  rate_id: z.string().uuid(),
  release_id: z.string().uuid(),
  release_version: z.number().int().positive(),
  dataset_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  source_ref: identifier(),
  source_version: identifier(),
  valid_from: date(),
  valid_until: date(),
}).strict();

export const fclQuoteCandidateSchema = fclQuoteSourceRefSchema.extend({
  rate: fclRateSchema,
}).strict();

export const fclQuoteSelectedSnapshotSchema = fclQuoteCandidateSchema.extend({
  selected_at: z.iso.datetime(),
  case_ref: z.string().uuid(),
  case_version: z.number().int().positive(),
  latest_customer_supplement_ref: z.string().uuid().nullable(),
}).strict();

export const fclQuoteTraceStepSchema = z.object({
  step: z.string().min(1).max(120),
  detail: z.string().min(1).max(1000),
}).strict();

export const fclQuoteMatchDataSchema = z.object({
  case_binding: fclQuoteCaseBindingSchema,
  candidates: z.array(fclQuoteCandidateSchema).max(500),
  selected: fclQuoteSelectedSnapshotSchema.nullable(),
  missing_fields: z.array(z.string().min(1).max(200)).max(32),
  source_refs: z.array(fclQuoteSourceRefSchema).max(500),
  assumptions: z.array(z.string().max(1000)).max(50),
  warnings: z.array(z.string().max(1000)).max(50),
  blockers: z.array(z.string().max(1000)).max(50),
  calculation_trace: z.array(fclQuoteTraceStepSchema).max(200),
}).strict();

export const fclQuoteResponseSchema = z.object({
  contract_version: z.literal(FCL_QUOTE_WORKFLOW_VERSION),
  status: z.enum(['success', 'needs_input', 'manual_review', 'blocked', 'unavailable']),
  data: fclQuoteMatchDataSchema,
  reason_codes: z.array(z.string().min(1).max(120)).max(32),
}).strict();

export const fclQuoteSchemas = {
  request: fclQuoteMatchRequestSchema,
  response: fclQuoteResponseSchema,
} as const;
