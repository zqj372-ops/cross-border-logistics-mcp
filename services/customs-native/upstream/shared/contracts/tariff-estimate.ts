import { z } from "zod";

import { SourceRefSchema } from "./query";

export const TARIFF_ESTIMATE_CONTRACT_VERSION = "riskcustoms-tariff-estimate.v1" as const;
export const TARIFF_ESTIMATE_BATCH_LIMIT = 20;

const DateSchema = z.string().date();
const DateTimeSchema = z.string().datetime({ offset: true });
const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const DecimalStringSchema = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/u);
const MoneyStringSchema = z.string().regex(/^(?:0|[1-9]\d{0,31})\.\d{2}$/u);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const CurrencySchema = z.enum(["USD", "CAD", "CNY"]);
const DestinationSchema = z.enum(["US", "CA"]);

export const TariffEstimateAttributesSchema = z.object({
  originCountry: z.literal("CN"),
  material: z.string().trim().min(1).max(200).optional(),
  use: z.string().trim().min(1).max(200).optional(),
  contains_steel_aluminum: z.boolean().optional(),
}).strict();

export const TariffEstimateItemInputSchema = z.object({
  lineId: IdentifierSchema,
  description: z.string().trim().min(1).max(200).optional(),
  hsCode: z.string().regex(/^\d{6,10}$/u).optional(),
  destinationCountry: DestinationSchema.optional(),
  declaredValue: DecimalStringSchema.optional(),
  currency: CurrencySchema.optional(),
  attributes: TariffEstimateAttributesSchema.optional(),
}).strict();

export const TariffEstimateRequestSchema = TariffEstimateItemInputSchema.extend({
  ruleDate: DateSchema,
}).strict();

export const TariffEstimateBatchRequestSchema = z.object({
  ruleDate: DateSchema,
  items: z.array(TariffEstimateItemInputSchema).min(1).max(TARIFF_ESTIMATE_BATCH_LIMIT),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    if (seen.has(item.lineId)) context.addIssue({ code: "custom", path: ["items", index, "lineId"], message: "lineId must be unique within a batch" });
    seen.add(item.lineId);
  });
});

export const TariffEstimateStatusSchema = z.enum(["success", "needs_input", "manual_review", "unavailable"]);

const MoneySchema = z.object({
  amount: MoneyStringSchema,
  currency: z.enum(["USD", "CAD"]),
}).strict();

const TaxLineSchema = z.object({
  id: IdentifierSchema,
  label: z.string().min(1),
  category: z.enum(["base_duty", "additional_duty", "trade_remedy", "excise_duty", "excise_tax", "gst", "official_fee", "tax", "fee"]),
  rateExpressionRaw: z.string(),
  ratePercent: z.string().regex(/^\d+(?:\.\d+)?$/u).nullable(),
  amount: MoneyStringSchema.nullable(),
  base: MoneyStringSchema,
  status: z.enum(["included", "manual_review", "excluded", "not_applicable"]),
  effectiveFrom: DateSchema,
  sourceId: z.string().min(1),
  note: z.string(),
}).strict();

const PublicationSchema = z.object({
  ruleDate: DateSchema,
  serviceVersion: z.string().min(1),
  publishedAt: DateTimeSchema,
  releaseIds: z.array(IdentifierSchema).min(1),
  snapshotHash: HashSchema,
  releaseHash: HashSchema,
  evaluatedAt: DateTimeSchema,
  lastSourceCheckAt: DateTimeSchema.nullable(),
  testData: z.literal(false),
}).strict();

const ExchangeEvidenceSchema = z.object({
  sourceAuthorities: z.array(z.enum(["CBSA", "BoC"])).min(1).max(2),
  sourceUrl: z.string().url(),
  effectiveDate: DateSchema,
  fetchedAt: DateTimeSchema,
  selection: z.enum(["same_day", "latest_business_day", "cached"]),
  fromCurrency: CurrencySchema,
  toCurrency: z.enum(["USD", "CAD"]),
  rate: z.string().regex(/^\d+(?:\.\d+)?$/u),
}).strict();

export const TariffEstimateResultSchema = z.object({
  lineId: IdentifierSchema,
  status: TariffEstimateStatusSchema,
  input: TariffEstimateItemInputSchema,
  publication: PublicationSchema.nullable(),
  exchangeRate: ExchangeEvidenceSchema.nullable(),
  valueForDuty: MoneySchema.nullable(),
  valueForTax: MoneySchema.nullable(),
  confirmedSubtotal: MoneySchema.nullable(),
  customsPayable: MoneySchema.nullable(),
  lines: z.array(TaxLineSchema),
  sources: z.array(SourceRefSchema),
  reasonCodes: z.array(IdentifierSchema),
}).strict().superRefine((value, context) => {
  if (value.status === "success" && (
    value.customsPayable === null || value.confirmedSubtotal === null || value.valueForDuty === null ||
    value.publication === null || value.lines.length === 0 || value.sources.length === 0 ||
    value.input.hsCode === undefined || value.input.destinationCountry === undefined ||
    value.input.declaredValue === undefined || value.input.currency === undefined || value.input.attributes === undefined
  )) {
    context.addIssue({ code: "custom", message: "A successful estimate requires complete input, decimal amounts and published source evidence" });
  }
  if (value.status !== "success" && value.customsPayable !== null) {
    context.addIssue({ code: "custom", path: ["customsPayable"], message: "A non-success estimate cannot expose a complete payable amount" });
  }
  if (value.status === "unavailable" && (value.valueForDuty !== null || value.valueForTax !== null || value.confirmedSubtotal !== null || value.lines.length > 0)) {
    context.addIssue({ code: "custom", message: "Unavailable results must clear stale monetary output" });
  }
  const sourceIds = new Set(value.sources.map((source) => source.id));
  if (value.lines.some((line) => !sourceIds.has(line.sourceId))) {
    context.addIssue({ code: "custom", path: ["sources"], message: "Every tax line must retain its exact source reference" });
  }
  if (value.publication !== null && value.sources.some((source) => !value.publication!.releaseIds.includes(source.releaseId))) {
    context.addIssue({ code: "custom", path: ["sources"], message: "Every source must belong to the returned publication" });
  }
  const targetCurrency = value.input.destinationCountry === "US" ? "USD" : value.input.destinationCountry === "CA" ? "CAD" : null;
  const crossCurrency = targetCurrency !== null && value.input.currency !== undefined && value.input.currency !== targetCurrency;
  if (value.status === "success" && crossCurrency && value.exchangeRate === null) {
    context.addIssue({ code: "custom", path: ["exchangeRate"], message: "A converted successful estimate requires official exchange-rate evidence" });
  }
});

const DelegatedActorSchema = z.object({
  type: z.enum(["user", "service"]),
  ref: z.string().min(1).max(128),
  applicationId: z.string().min(1).max(64),
}).strict();

export const TariffEstimateResponseSchema = z.object({
  contractVersion: z.literal(TARIFF_ESTIMATE_CONTRACT_VERSION),
  requestId: z.string().regex(/^req_[A-Za-z0-9_-]{8,128}$/u),
  status: TariffEstimateStatusSchema,
  delegatedActor: DelegatedActorSchema,
  result: TariffEstimateResultSchema,
}).strict().superRefine((value, context) => {
  if (value.status !== value.result.status) context.addIssue({ code: "custom", path: ["status"], message: "Single response status must match its result" });
});

const BatchCountsSchema = z.object({
  total: z.number().int().min(1).max(TARIFF_ESTIMATE_BATCH_LIMIT),
  success: z.number().int().nonnegative(),
  needsInput: z.number().int().nonnegative(),
  manualReview: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
}).strict();

export const TariffEstimateBatchResponseSchema = z.object({
  contractVersion: z.literal(TARIFF_ESTIMATE_CONTRACT_VERSION),
  requestId: z.string().regex(/^req_[A-Za-z0-9_-]{8,128}$/u),
  status: TariffEstimateStatusSchema,
  partialFailure: z.boolean(),
  delegatedActor: DelegatedActorSchema,
  counts: BatchCountsSchema,
  results: z.array(TariffEstimateResultSchema).min(1).max(TARIFF_ESTIMATE_BATCH_LIMIT),
}).strict().superRefine((value, context) => {
  const counts = {
    success: value.results.filter((item) => item.status === "success").length,
    needsInput: value.results.filter((item) => item.status === "needs_input").length,
    manualReview: value.results.filter((item) => item.status === "manual_review").length,
    unavailable: value.results.filter((item) => item.status === "unavailable").length,
  };
  if (value.counts.total !== value.results.length || Object.entries(counts).some(([key, count]) => value.counts[key as keyof typeof counts] !== count)) {
    context.addIssue({ code: "custom", path: ["counts"], message: "Batch counts must match row statuses" });
  }
  const partial = new Set(value.results.map((item) => item.status)).size > 1;
  if (value.partialFailure !== partial) context.addIssue({ code: "custom", path: ["partialFailure"], message: "partialFailure must identify mixed successful and non-successful rows" });
  if (value.status === "success" && counts.success !== value.results.length) context.addIssue({ code: "custom", path: ["status"], message: "Batch success requires every row to succeed" });
  if (partial && value.status !== "manual_review") context.addIssue({ code: "custom", path: ["status"], message: "A partial batch uses manual_review status" });
});

export type TariffEstimateItemInput = z.infer<typeof TariffEstimateItemInputSchema>;
export type TariffEstimateRequest = z.infer<typeof TariffEstimateRequestSchema>;
export type TariffEstimateBatchRequest = z.infer<typeof TariffEstimateBatchRequestSchema>;
export type TariffEstimateResult = z.infer<typeof TariffEstimateResultSchema>;
export type TariffEstimateResponse = z.infer<typeof TariffEstimateResponseSchema>;
export type TariffEstimateBatchResponse = z.infer<typeof TariffEstimateBatchResponseSchema>;
