import { z } from "zod";

export const CountrySchema = z.enum(["CN", "US", "CA"]);
export const ResultStatusSchema = z.enum(["confirmed", "candidate", "possible", "manual_review"]);
export const DocumentStatusSchema = z.enum([
  "prepare_retain",
  "required_now",
  "conditional",
  "on_request",
  "not_applicable",
  "manual_review",
]);

// Release manifests may retain an official publication timestamp, while the
// public API exposes the stable calendar date. Normalize both forms at this
// boundary so timestamp precision cannot turn a reviewed source into a 500.
const PublishedDateSchema = z
  .union([z.string().date(), z.string().datetime()])
  .transform((value) => value.slice(0, 10));

export const SourceRefSchema = z.object({
  id: z.string().min(1),
  releaseId: z.string().min(1),
  artifactId: z.string().min(1),
  authority: z.string().min(1),
  dataset: z.string().min(1),
  edition: z.string().min(1),
  revision: z.string().min(1),
  officialUrl: z.string().url().refine((value) => /^https:\/\//i.test(value), {
    message: "officialUrl must use HTTPS",
  }),
  publishedAt: PublishedDateSchema,
  effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().nullable(),
  retrievedAt: z.string().datetime(),
  sourceLocator: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
    ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must not be before effectiveFrom" });
  }
});

export const RateLineSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  treatment: z.string().min(1),
  category: z.enum([
    "export_duty",
    "provisional_export_duty",
    "base_duty",
    "additional_duty",
    "trade_remedy",
    "excise_duty",
    "excise_tax",
    "gst",
    "official_fee",
    "tax",
    "fee",
  ]),
  kind: z.enum(["free", "ad_valorem", "specific", "compound", "text"]),
  rateExpressionRaw: z.string().min(1),
  displayValue: z.string().min(1),
  confirmed: z.boolean(),
  includedInConfirmedTotal: z.boolean(),
  effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().nullable(),
  conditionText: z.string(),
  interactionNote: z.string(),
  sourceId: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
    ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must not be before effectiveFrom" });
  }
  if (value.includedInConfirmedTotal && !value.confirmed) {
    ctx.addIssue({
      code: "custom",
      path: ["includedInConfirmedTotal"],
      message: "A rate included in the confirmed total must be confirmed",
    });
  }
  if (value.includedInConfirmedTotal && (value.category === "tax" || value.category === "fee" || value.category === "excise_duty" || value.category === "excise_tax" || value.category === "gst" || value.category === "official_fee")) {
    ctx.addIssue({
      code: "custom",
      path: ["includedInConfirmedTotal"],
      message: "Tax, excise, GST and official-fee rates cannot be included in the confirmed total",
    });
  }
});

export const DocumentItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  side: z.enum(["cn_export", "us_import", "ca_import"]),
  status: DocumentStatusSchema,
  conditions: z.array(z.string()),
  reason: z.string().min(1),
  effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().nullable(),
  sourceId: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
    ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must not be before effectiveFrom" });
  }
});

export const LegalNameSchema = z.object({
  language: z.string().min(2),
  text: z.string().min(1),
  sourceId: z.string().min(1),
});

export const ChineseExplanationSchema = z.object({
  translationId: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(["machine", "human_reviewed", "not_needed"]),
  basedOnSourceIds: z.array(z.string().min(1)).min(1),
});

export const CodeHierarchyNodeSchema = z.object({
  code: z.string().regex(/^\d{4,10}$/),
  displayCode: z.string().min(1),
  codeDigits: z.number().int().min(4).max(10),
  legalNames: z.array(LegalNameSchema).min(1),
});

export const CandidateSchema = z.object({
  candidateId: z.string().min(1),
  country: CountrySchema,
  code: z.string().regex(/^\d{4,10}$/),
  displayCode: z.string().min(1),
  codeDigits: z.number().int().min(4).max(10),
  parentCode: z.string().regex(/^\d{4,10}$/).nullable(),
  hierarchy: z.array(CodeHierarchyNodeSchema).min(1).max(7),
  legalNames: z.array(LegalNameSchema).min(1),
  chineseExplanation: ChineseExplanationSchema,
  classificationReason: z.string().min(1),
  classificationSourceIds: z.array(z.string().min(1)).min(1),
  status: ResultStatusSchema,
  hs6: z.string().regex(/^\d{6}$/).nullable(),
});

export const TradeMeasureSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  measureType: z.string().min(1),
  originCountry: z.string().min(2),
  codeHint: z.string().nullable(),
  matchStatus: z.enum(["not_indicated", "possible", "confirmed_by_rule", "manual_review"]),
  legalScope: z.string().min(1),
  exceptions: z.array(z.string()),
  caseNumber: z.string().nullable(),
  exporterOrProducer: z.string().nullable(),
  rateExpressionRaw: z.string().nullable(),
  effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().nullable(),
  sourceId: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
    ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must not be before effectiveFrom" });
  }
});

export const CountryResultSchema = CandidateSchema.extend({
  rates: z.array(RateLineSchema),
  confirmedTotalPercent: z.string().nullable(),
  documents: z.array(DocumentItemSchema),
  measures: z.array(TradeMeasureSchema),
  warnings: z.array(z.string()),
}).superRefine((result, ctx) => {
  const expectedSide = {
    CN: "cn_export",
    US: "us_import",
    CA: "ca_import",
  } as const;
  for (const [index, document] of result.documents.entries()) {
    if (document.side !== expectedSide[result.country]) {
      ctx.addIssue({
        code: "custom",
        path: ["documents", index, "side"],
        message: `Document side ${document.side} does not match country ${result.country}`,
      });
    }
  }
});

export const QueryRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    ruleDate: z.string().date(),
    codeCountry: CountrySchema.optional(),
    selectedHs6: z.string().regex(/^\d{6}$/).optional(),
    attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    querySessionId: z.string().uuid().optional(),
  })
  .strict();

export const DataStatusSchema = z.object({
  evaluatedAt: z.string().datetime(),
  lastSourceCheckAt: z.string().datetime().nullable(),
  sourceSnapshotId: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  ready: z.boolean(),
  reasons: z.array(z.string()),
});

export const FeedbackEventTypeSchema = z.enum([
  "accepted_candidate",
  "rejected_candidate",
  "corrected_translation",
  "manual_review",
]);

export const FeedbackRequestSchema = z.object({
  eventId: z.string().trim().min(1).max(200).optional(),
  eventType: FeedbackEventTypeSchema,
  sourceReleaseId: z.string().trim().min(1).max(200),
  sourceSnapshotId: z.string().regex(/^[a-f0-9]{64}$/i),
  queryId: z.string().trim().min(1).max(200),
  candidateId: z.string().trim().min(1).max(200).optional(),
  occurredAt: z.string().datetime().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  if ((value.eventType === "accepted_candidate" || value.eventType === "rejected_candidate") && !value.candidateId) {
    ctx.addIssue({ code: "custom", path: ["candidateId"], message: "candidateId is required for candidate feedback" });
  }
  if (value.eventType === "corrected_translation") {
    const sourceTextSha256 = value.payload.source_text_sha256;
    if (typeof sourceTextSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(sourceTextSha256)) {
      ctx.addIssue({ code: "custom", path: ["payload", "source_text_sha256"], message: "source_text_sha256 must be a 64-character SHA-256 hex digest" });
    }
    for (const field of ["target_language", "translator_version"] as const) {
      if (typeof value.payload[field] !== "string" || value.payload[field].trim().length === 0) {
        ctx.addIssue({ code: "custom", path: ["payload", field], message: `${field} is required for corrected translation feedback` });
      }
    }
  }
});

export const QueryResponseSchema = z
  .object({
    queryId: z.string().min(1),
    mode: z.enum(["exact_code", "name_search", "degraded_search", "online_search"]),
    ruleDate: z.string().date(),
    selectedHs6: z.string().regex(/^\d{6}$/).nullable(),
    nextQuestion: z
      .object({
        id: z.string().min(1),
        label: z.string().min(1),
        attribute: z.string().min(1),
        options: z.array(z.string().min(1)).min(1).max(3),
      })
      .nullable(),
    candidates: z.array(CandidateSchema).max(9),
    results: z.array(CountryResultSchema),
    sources: z.array(SourceRefSchema),
    dataStatus: DataStatusSchema,
    testData: z.boolean(),
  })
  .superRefine((response, ctx) => {
    const sourceIds = new Set(response.sources.map((source) => source.id));
    if (sourceIds.size !== response.sources.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate source IDs" });
    }

    for (const candidate of [...response.candidates, ...response.results]) {
      if (candidate.codeDigits !== candidate.code.length) {
        ctx.addIssue({ code: "custom", message: `Code digit count does not match ${candidate.code}` });
      }
      if (candidate.hs6 !== null && !candidate.code.startsWith(candidate.hs6)) {
        ctx.addIssue({ code: "custom", message: `HS6 ${candidate.hs6} is not a prefix of ${candidate.code}` });
      }
      if (candidate.parentCode !== null) {
        const isStrictPrefix = candidate.parentCode.length < candidate.code.length && candidate.code.startsWith(candidate.parentCode);
        if (!isStrictPrefix) {
          ctx.addIssue({ code: "custom", message: `Parent code ${candidate.parentCode} is not a strict prefix of ${candidate.code}` });
        } else if (candidate.hierarchy.length > 0 && !candidate.hierarchy.some((node) => node.code === candidate.parentCode)) {
          ctx.addIssue({ code: "custom", message: `Parent code ${candidate.parentCode} is missing from hierarchy` });
        }
      }
      for (const node of candidate.hierarchy) {
        if (node.codeDigits !== node.code.length) {
          ctx.addIssue({ code: "custom", message: `Hierarchy code digit count does not match ${node.code}` });
        }
        if (!candidate.code.startsWith(node.code)) {
          ctx.addIssue({ code: "custom", message: `Hierarchy code ${node.code} is not a prefix of ${candidate.code}` });
        }
      }
      if (!candidate.hierarchy.some((node) => node.code === candidate.code)) {
        ctx.addIssue({ code: "custom", message: `Hierarchy is missing candidate code ${candidate.code}` });
      }
      for (const name of candidate.legalNames) {
        if (!sourceIds.has(name.sourceId)) {
          ctx.addIssue({ code: "custom", message: `Unknown legal-name source ${name.sourceId}` });
        }
      }
      for (const node of candidate.hierarchy) {
        for (const name of node.legalNames) {
          if (!sourceIds.has(name.sourceId)) {
            ctx.addIssue({ code: "custom", message: `Unknown hierarchy source ${name.sourceId}` });
          }
        }
      }
      for (const sourceId of [...candidate.classificationSourceIds, ...candidate.chineseExplanation.basedOnSourceIds]) {
        if (!sourceIds.has(sourceId)) {
          ctx.addIssue({ code: "custom", message: `Unknown classification source ${sourceId}` });
        }
      }
    }

    const resultCountries = new Set<string>();
    for (const result of response.results) {
      if (resultCountries.has(result.country)) {
        ctx.addIssue({ code: "custom", message: `Duplicate result country ${result.country}` });
      }
      resultCountries.add(result.country);
      for (const rate of result.rates) {
        if (!sourceIds.has(rate.sourceId)) {
          ctx.addIssue({ code: "custom", message: `Unknown rate source ${rate.sourceId}` });
        }
      }
      for (const document of result.documents) {
        if (!sourceIds.has(document.sourceId)) {
          ctx.addIssue({ code: "custom", message: `Unknown document source ${document.sourceId}` });
        }
      }
      for (const measure of result.measures) {
        if (!sourceIds.has(measure.sourceId)) {
          ctx.addIssue({ code: "custom", message: `Unknown trade-measure source ${measure.sourceId}` });
        }
      }
    }

    if (response.testData && response.dataStatus.ready) {
      ctx.addIssue({ code: "custom", message: "A ready response cannot be marked as test data" });
    }
  });

export type QueryRequest = z.infer<typeof QueryRequestSchema>;
export type QueryResponse = z.infer<typeof QueryResponseSchema>;
export type CountryResult = z.infer<typeof CountryResultSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type RateLine = z.infer<typeof RateLineSchema>;
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;
