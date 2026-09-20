import { z } from 'zod';
import { FCL_CONTAINER_TYPES, FCL_SERVICE_IDS } from '../../apps/inquiry/fcl-model';
import { FCL_DOCUMENT_WORKFLOW_VERSION } from '../quote-documents/fcl-contracts';
import { fclCurrentnessSchema } from '../quote-documents/workflow-contracts';
import { templateRefSchema } from '../quote-documents/workflow-contracts';
export { FCL_DOCUMENT_WORKFLOW_VERSION } from '../quote-documents/fcl-contracts';

export const FCL_RATE_DATASET_VERSION = 'fcl-rate-dataset@2026-09-20.v1' as const;

// eslint-disable-next-line no-control-regex
const SINGLE_LINE_PATTERN = /^(?=[\s\S]*\S)[^\u0000-\u001f\u007f]+$/u;
// eslint-disable-next-line no-control-regex
const NOTE_PATTERN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(0|[1-9]\d{0,9})(?:\.\d{1,6})?$/u;

const identifier = (max = 200) => z.string().min(1).max(max).regex(SINGLE_LINE_PATTERN);
const note = () => z.string().max(2000).regex(NOTE_PATTERN).nullable();
const customerNote = () => z.string().max(500).regex(NOTE_PATTERN).nullable();
const decimal = () => z.string().regex(NON_NEGATIVE_DECIMAL_PATTERN);
const positiveDecimal = () => z.string().regex(/^(?!0(?:\.0+)?$)(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/u);
const computedMoney = () => z.string().regex(/^(?:0|[1-9]\d{0,31})(?:\.\d{1,2})?$/u);
const computedProfit = () => z.string().regex(/^-?(?:0|[1-9]\d{0,31})(?:\.\d{1,2})?$/u);
const ratio = () => z.string().regex(/^-?(?:0|[1-9]\d{0,31})(?:\.\d{1,6})?$/u);
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

const quoteRowKey = () => z.string().min(1).max(160).regex(/^[a-z][A-Za-z0-9_:-]*$/u);

export const fclQuoteManualFeeInputSchema = z.object({
  id: z.string().uuid(),
  template_ref: templateRefSchema.nullable(),
  name: identifier(),
  group: z.enum(['A', 'B', 'C']),
  service,
  quantity: positiveDecimal(),
  unit: z.enum(['CNTR', 'SHIPMENT']),
  container_type: containerType.nullable(),
  cost_price: decimal().nullable(),
  sell_price: decimal().nullable(),
  currency,
  internal_note: note(),
  customer_note: customerNote(),
  evidence_ref: identifier(500).nullable(),
  evidence_version: identifier(100).nullable(),
  quantity_conditions: note(),
}).strict().superRefine((value, context) => {
  if (value.unit === 'CNTR' && value.container_type === null) {
    context.addIssue({ code: 'custom', path: ['container_type'], message: 'cntr_requires_container_type' });
  }
  if (value.unit === 'SHIPMENT' && value.container_type !== null) {
    context.addIssue({ code: 'custom', path: ['container_type'], message: 'shipment_forbids_container_type' });
  }
});

export const fclQuoteSourceSellPriceSchema = z.object({
  row_key: quoteRowKey(),
  sell_price: decimal().nullable(),
  customer_note: customerNote(),
}).strict();

export const fclQuoteServiceScopeInputSchema = z.object({
  service,
  disposition: z.enum(['included', 'free', 'out_of_scope']),
  note: identifier(2000),
  included_row_refs: z.array(quoteRowKey()).max(60),
}).strict().superRefine((value, context) => {
  if (value.disposition === 'included' && value.included_row_refs.length === 0) {
    context.addIssue({ code: 'custom', path: ['included_row_refs'], message: 'included_requires_rows' });
  }
  if (value.disposition !== 'included' && value.included_row_refs.length > 0) {
    context.addIssue({ code: 'custom', path: ['included_row_refs'], message: 'non_included_forbids_rows' });
  }
});

export const fclQuoteDraftInputSchema = z.object({
  source_sell_prices: z.array(fclQuoteSourceSellPriceSchema).max(120),
  manual_fees: z.array(fclQuoteManualFeeInputSchema).max(60),
  service_scopes: z.array(fclQuoteServiceScopeInputSchema).max(FCL_SERVICE_IDS.length),
  exchange_rates: z.object({ USD: positiveDecimal().nullable(), CAD: positiveDecimal().nullable() }).strict(),
  remark: note(),
}).strict().superRefine((value, context) => {
  const sourceRows = new Set<string>();
  value.source_sell_prices.forEach((row, index) => {
    if (sourceRows.has(row.row_key)) context.addIssue({ code: 'custom', path: ['source_sell_prices', index, 'row_key'], message: 'duplicate_row_key' });
    sourceRows.add(row.row_key);
  });
  const manualIds = new Set<string>();
  value.manual_fees.forEach((row, index) => {
    if (manualIds.has(row.id)) context.addIssue({ code: 'custom', path: ['manual_fees', index, 'id'], message: 'duplicate_manual_fee_id' });
    manualIds.add(row.id);
  });
  const services = new Set<string>();
  value.service_scopes.forEach((row, index) => {
    if (services.has(row.service)) context.addIssue({ code: 'custom', path: ['service_scopes', index, 'service'], message: 'duplicate_service_scope' });
    services.add(row.service);
  });
});

const caseBinding = fclQuoteCaseBindingSchema;
const selectedSourceBinding = z.object({
  selected_rate_id: z.string().uuid(),
  expected_release_id: z.string().uuid(),
  expected_release_version: z.number().int().positive(),
  expected_dataset_digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const fclQuoteCreateRequestSchema = z.object({
  contract_version: z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  operation: z.literal('create'),
  case_ref: z.string().uuid(),
  expected_case_version: z.number().int().positive(),
  expected_customer_supplement_ref: z.string().uuid().nullable(),
  ...selectedSourceBinding.shape,
  input: fclQuoteDraftInputSchema,
}).strict();

export const fclQuoteUpdateRequestSchema = z.object({
  contract_version: z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  operation: z.literal('update'),
  quote_ref: z.string().uuid(),
  expected_version: z.number().int().positive(),
  source_binding: z.union([
    z.object({ mode: z.literal('retain') }).strict(),
    z.object({
      mode: z.literal('replace'),
      expected_case_version: z.number().int().positive(),
      expected_customer_supplement_ref: z.string().uuid().nullable(),
      ...selectedSourceBinding.shape,
    }).strict(),
  ]),
  input: fclQuoteDraftInputSchema,
}).strict();

export const fclQuoteSaveRequestSchema = z.discriminatedUnion('operation', [
  fclQuoteCreateRequestSchema,
  fclQuoteUpdateRequestSchema,
]);

export const fclQuoteGetRequestSchema = z.object({
  contract_version: z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  quote_ref: z.string().uuid(),
  version: z.number().int().positive().nullable(),
}).strict();

export const fclQuoteListRequestSchema = z.object({
  contract_version: z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  case_ref: z.string().uuid(),
  limit: z.number().int().min(1).max(100),
  cursor: z.string().max(512).nullable(),
}).strict();

export const fclQuoteReferenceSchema = z.object({
  quote_ref: z.string().uuid(),
  version: z.number().int().positive(),
}).strict();

export const fclQuoteCostRowSchema = z.object({
  row_key: quoteRowKey(),
  source_kind: z.enum(['ocean_freight', 'rate_fee', 'manual']),
  template_ref: templateRefSchema.nullable(),
  source_ref: identifier(500).nullable(),
  source_version: identifier(200).nullable(),
  name: identifier(),
  group: z.enum(['A', 'B', 'C']),
  service,
  quantity: decimal(),
  unit: z.enum(['CNTR', 'SHIPMENT']),
  container_type: containerType.nullable(),
  cost_price: decimal().nullable(),
  sell_price: decimal().nullable(),
  currency,
  internal_note: note(),
  customer_note: customerNote(),
  evidence_ref: identifier(500).nullable(),
  evidence_version: identifier(100).nullable(),
  quantity_conditions: note(),
  cost_amount: computedMoney().nullable(),
  sell_amount: computedMoney().nullable(),
  fully_priced: z.boolean(),
}).strict();

export const fclQuoteServiceCoverageSchema = z.object({
  service,
  disposition: z.enum(['pending', 'priced', 'included', 'free', 'out_of_scope']),
  note: note(),
  included_row_refs: z.array(quoteRowKey()).max(60),
  actor: identifier().nullable(),
  confirmed_at: z.iso.datetime().nullable(),
}).strict();

export const fclQuoteProfitRefSchema = z.object({
  kind: z.enum(['case', 'rate', 'manual']),
  ref: identifier(500),
  version: identifier(200).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).strict();

export const fclQuoteTraceSchema = z.object({
  step: z.string().min(1).max(120),
  detail: z.string().min(1).max(1000),
}).strict();

export const fclQuoteCompletenessSchema = z.object({
  complete: z.boolean(),
  partial: z.boolean(),
  missing_fields: z.array(z.string().min(1).max(240)).max(256),
}).strict();

export const fclQuoteCurrencyBreakdownSchema = z.object({
  cost_subtotal: computedMoney().nullable(),
  revenue_subtotal: computedMoney().nullable(),
  gp_subtotal: computedProfit().nullable(),
  margin: ratio().nullable(),
  complete: z.boolean(),
}).strict();

export const fclQuoteCalculationSchema = z.object({
  calculation_version: z.literal('fcl-cost-sell-decimal-v1'),
  complete: z.boolean(),
  partial: z.boolean(),
  by_currency: z.object({
    USD: fclQuoteCurrencyBreakdownSchema,
    CAD: fclQuoteCurrencyBreakdownSchema,
    CNY: fclQuoteCurrencyBreakdownSchema,
  }).strict(),
  unified_profit: z.object({
    currency: z.literal('CNY'),
    cost_subtotal: computedMoney().nullable(),
    revenue_subtotal: computedMoney().nullable(),
    gp_subtotal: computedProfit().nullable(),
    margin: ratio().nullable(),
    complete: z.boolean(),
    missing_fx: z.array(z.enum(['USD', 'CAD'])).max(2),
  }).strict(),
  source_refs: z.array(fclQuoteProfitRefSchema).max(500),
  assumptions: z.array(z.string().max(1000)).max(100),
  warnings: z.array(z.string().max(1000)).max(100),
  blockers: z.array(z.string().max(1000)).max(100),
  calculation_trace: z.array(fclQuoteTraceSchema).max(300),
}).strict();

export const fclQuoteCaseProjectionSchema = z.object({
  containers: z.array(z.object({ type: containerType, quantity: positiveDecimal() }).strict()).min(1).max(4),
  services: z.array(service).max(FCL_SERVICE_IDS.length),
  incoterm: z.string().min(1).max(20).nullable(),
}).strict();

export const fclQuoteSnapshotSchema = z.object({
  contract_version: z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  schema_version: z.literal('fcl-cost-sell-snapshot@2026-09-20.v1'),
  quote_ref: z.string().uuid(),
  version: z.number().int().positive(),
  case_binding: caseBinding,
  source_snapshot: fclQuoteSelectedSnapshotSchema,
  case_projection: fclQuoteCaseProjectionSchema,
  cost_rows: z.array(fclQuoteCostRowSchema).max(120),
  service_coverage: z.array(fclQuoteServiceCoverageSchema).max(FCL_SERVICE_IDS.length),
  exchange_rates: z.object({ USD: positiveDecimal().nullable(), CAD: positiveDecimal().nullable() }).strict(),
  remark: note(),
  completeness: fclQuoteCompletenessSchema,
  calculation: fclQuoteCalculationSchema,
  content_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  actor: identifier(),
  created_at: z.iso.datetime(),
}).strict();

export const fclQuoteViewSchema = fclQuoteSnapshotSchema.extend({
  current_version: z.number().int().positive(),
  historical: z.boolean(),
  currentness: fclCurrentnessSchema,
  replay: z.object({
    replayed: z.boolean(),
    submitted_version: z.number().int().positive().nullable(),
    current: z.boolean(),
  }).strict(),
}).strict();

export const fclQuoteListItemSchema = z.object({
  quote_ref: z.string().uuid(),
  version: z.number().int().positive(),
  current_version: z.number().int().positive(),
  case_ref: z.string().uuid(),
  case_version: z.number().int().positive(),
  rate_id: z.string().uuid(),
  release_id: z.string().uuid(),
  complete: z.boolean(),
  by_currency: fclQuoteCalculationSchema.shape.by_currency,
  currentness: fclCurrentnessSchema,
  created_at: z.iso.datetime(),
}).strict();

export const fclQuoteListSchema = z.object({
  items: z.array(fclQuoteListItemSchema).max(100),
  next_cursor: z.string().nullable(),
}).strict();

export const fclQuoteCostSellSchemas = {
  'cost-sell-save-request': fclQuoteSaveRequestSchema,
  'cost-sell-get-request': fclQuoteGetRequestSchema,
  'cost-sell-list-request': fclQuoteListRequestSchema,
  'cost-sell-list-output': fclQuoteListSchema,
  'cost-sell-view-output': fclQuoteViewSchema,
  'cost-sell-snapshot': fclQuoteSnapshotSchema,
  'cost-sell-manual-fee-input': fclQuoteManualFeeInputSchema,
  'cost-sell-service-scope-input': fclQuoteServiceScopeInputSchema,
} as const;

export type FclQuoteDraftInput = z.infer<typeof fclQuoteDraftInputSchema>;
export type FclQuoteSaveRequest = z.infer<typeof fclQuoteSaveRequestSchema>;
export type FclQuoteSnapshot = z.infer<typeof fclQuoteSnapshotSchema>;
export type FclQuoteView = z.infer<typeof fclQuoteViewSchema>;
export type FclQuoteCostRow = z.infer<typeof fclQuoteCostRowSchema>;
export type FclQuoteServiceCoverage = z.infer<typeof fclQuoteServiceCoverageSchema>;
export type FclQuoteSelectedSnapshot = z.infer<typeof fclQuoteSelectedSnapshotSchema>;
export type FclQuoteCaseBinding = z.infer<typeof fclQuoteCaseBindingSchema>;
export type FclQuoteCaseProjection = z.infer<typeof fclQuoteCaseProjectionSchema>;
export type FclQuoteCurrentness = z.infer<typeof fclCurrentnessSchema>;
