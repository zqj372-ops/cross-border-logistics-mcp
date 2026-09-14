import {zoneInputSchema,zoneDataSchema,sourceRefSchema} from '../access-gateway/portal/business/quote-client';
import { z } from 'zod';
export const VERSION='quote-documents@2026-09-08.v1';
const text=(n=200)=>z.string().trim().max(n);
export const decimal=z.string().regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/u);
export const currency=z.enum(['USD','CAD','CNY']);
const date=z.iso.date();
export const feeSchema=z.object({id:z.string().uuid(),name:text().min(1),description:text(500).default(''),group:z.enum(['A','B','C']),quantity:decimal,unit:text(20).min(1),unit_price:decimal,currency,display:z.enum(['detail','hiddenIncluded','hiddenExcluded','merged']),merge_name:text().default(''),note:text(500).default('')}).strict().refine(f=>f.display!=='merged'||f.merge_name.length>0,{message:'合并费用必须填写显示名称'});
export const templateSchema=z.object({company_name:text().min(1),company_address:text(500),company_phone:text(50),company_email:text(254),terms:text(4000).min(1),fee_items:z.array(feeSchema).max(60)}).strict();
export const documentSchema=z.object({quote_no:text(80).min(1),customer_name:text().min(1),quote_date:date,valid_until:date,origin:text(),destination:text(),route_name:text(),job_no:text(80),so_no:text(80),container_no:text(80),remark:text(4000),exchange_rates:z.object({USD:decimal.nullable(),CAD:decimal.nullable()}).strict(),fee_items:z.array(feeSchema).min(1).max(60)}).strict().superRefine((d,c)=>{if(d.valid_until<d.quote_date)c.addIssue({code:'custom',message:'有效期早于报价日期'});if(new Set(d.fee_items.map(f=>f.id)).size!==d.fee_items.length)c.addIssue({code:'custom',message:'费用 ID 重复'});for(const rate of Object.values(d.exchange_rates))if(rate!==null&&/^0(?:\.0+)?$/u.test(rate))c.addIssue({code:'custom',message:'汇率必须大于零'});});
export const configSaveSchema=z.object({expected_version:z.number().int().min(0),input:templateSchema,confirmed:z.literal(true)}).strict();
export const previewSchema=z.object({input:documentSchema}).strict();
export const nativeQuoteBindingSchema=z.object({request:zoneInputSchema,preview:zoneDataSchema,source_refs:z.array(sourceRefSchema).min(1).max(50),release_id:z.string(),release_digest:z.string().regex(/^[a-f0-9]{64}$/u),request_hash:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const nativePrepareSchema=z.object({request:zoneInputSchema,customer:z.object(documentSchema.shape).strict().pick({quote_no:true,customer_name:true,quote_date:true,valid_until:true,job_no:true,so_no:true,container_no:true,remark:true})}).strict();
export const rejectSchema=z.object({id:z.string().uuid(),expected_version:z.number().int().positive(),reason:text(2000).min(1)}).strict();
export const saveSchema=z.object({input:documentSchema,template_version:z.number().int().positive(),preview_hash:z.string().regex(/^[a-f0-9]{64}$/u),preview_expires_at:z.number().int().positive(),native_quote_v1:nativeQuoteBindingSchema.optional(),confirmed:z.literal(true)}).strict();
export const approveSchema=z.object({id:z.string().uuid(),expected_version:z.number().int().positive(),evidence_ref:text(500).min(1),evidence_version:text(100).min(1),review_notes:text(2000).min(1),confirmation:z.literal('human_verified_price_and_source')}).strict();
export const idSchema=z.object({id:z.string().uuid()}).strict();
export const listSchema=z.object({limit:z.number().int().min(1).max(100).default(30),before:z.number().int().positive().optional()}).strict();
export const quoteDocumentSchemas={'template':templateSchema,'input':documentSchema,'config-save':configSaveSchema,'preview':previewSchema,'save':saveSchema,'approve':approveSchema,'get':idSchema,'list':listSchema,'native-prepare':nativePrepareSchema,'reject':rejectSchema};
export type QuoteDocument=z.infer<typeof documentSchema>;
export type QuoteTemplate=z.infer<typeof templateSchema>;
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const configViewSchema=z.object({version:z.number().int().nonnegative(),input:templateSchema.nullable()}).strict();
export const totalsSchema=z.object({rows:z.array(feeSchema.and(z.object({amount:z.string()}))).max(60),by_currency:z.object({USD:z.string(),CAD:z.string(),CNY:z.string()}).strict(),total_cny:z.string().nullable(),total_usd:z.string().nullable(),warnings:z.array(z.string()),calculation_version:z.literal('quote-documents-decimal-v1')}).strict();
// Rows are a closed extension of the validated fee input, with computed amount only.
export const calculatedFeeSchema=z.object({...feeSchema.shape,amount:z.string().regex(/^[0-9]+\.[0-9]{2}$/u)}).strict();
export const calculatedTotalsSchema=totalsSchema.extend({rows:z.array(calculatedFeeSchema).max(60)});
export const previewViewSchema=saveSchema.omit({confirmed:true}).extend({totals:calculatedTotalsSchema});
export const documentViewSchema=z.object({id:z.string().uuid(),version:z.number().int().positive(),state:z.enum(['draft','approved','rejected']),input:documentSchema,template:templateSchema,template_version:z.number().int().positive(),created_at:z.iso.datetime(),owner_id:z.string(),native_quote_v1:nativeQuoteBindingSchema.optional(),rejection:z.object({reason:z.string(),actor:z.string(),at:z.iso.datetime()}).strict().optional(),approval:z.object({evidence_ref:z.string(),evidence_version:z.string(),review_notes:z.string(),actor:z.string(),at:z.iso.datetime()}).strict().nullable()}).strict();
export const documentListViewSchema=z.object({items:z.array(documentViewSchema.pick({id:true,version:true,state:true,created_at:true}).extend({quote_no:z.string(),customer_name:z.string()})).max(100),next_cursor:z.number().int().positive().nullable()}).strict();
export const exportViewSchema=z.object({id:z.string().uuid(),version:z.number().int().positive(),draft:z.boolean(),filename:z.string().regex(/^quotation-[a-f0-9-]+-v[0-9]+\.pdf$/u),sha256:sha,byte_length:z.number().int().min(100).max(8388608),content_base64:z.string().max(11184812).regex(/^[A-Za-z0-9+/]+={0,2}$/u),totals:calculatedTotalsSchema}).strict();
export const outputSchemas:Record<string,z.ZodType>={config:configViewSchema,'config-save':configViewSchema,preview:previewViewSchema,save:documentViewSchema,get:documentViewSchema,approve:documentViewSchema,list:documentListViewSchema,export:exportViewSchema,'native-prepare':previewViewSchema,reject:documentViewSchema};
export const responseSchema=(action:string)=>z.object({schema_version:z.literal(VERSION),status:z.literal('success'),data:outputSchemas[action]!,reason_codes:z.array(z.string()).length(0)}).strict();

// Inquiry-to-quote link v2. v1 exports above remain unchanged.
export const INQUIRY_QUOTE_LINK_VERSION='inquiry-quote-link@2026-09-13.v1' as const;
export const V2_VERSION='quote-documents@2026-09-13.v2' as const;
export const inquiryCaseLinkSchema=z.object({
  case_ref:z.string().uuid(),
  reviewed_customer_event_ref:z.string().uuid().nullable(),
}).strict();
const signedFeeBaseSchema=z.object({id:z.string().uuid(),name:text().min(1),description:text(500),group:z.enum(['A','B','C']),quantity:decimal,unit:text(20).min(1),unit_price:decimal,currency,display:z.enum(['detail','hiddenIncluded','hiddenExcluded','merged']),merge_name:text(),note:text(500)}).strict();
export const signedFeeSchema=signedFeeBaseSchema.refine(f=>f.display!=='merged'||f.merge_name.length>0,{message:'合并费用必须填写显示名称'});
export const signedDocumentSchema=z.object({quote_no:text(80).min(1),customer_name:text().min(1),quote_date:date,valid_until:date,origin:text(),destination:text(),route_name:text(),job_no:text(80),so_no:text(80),container_no:text(80),remark:text(4000),exchange_rates:z.object({USD:decimal.nullable(),CAD:decimal.nullable()}).strict(),fee_items:z.array(signedFeeSchema).min(1).max(60)}).strict().superRefine((d,c)=>{if(d.valid_until<d.quote_date)c.addIssue({code:'custom',message:'有效期早于报价日期'});if(new Set(d.fee_items.map(f=>f.id)).size!==d.fee_items.length)c.addIssue({code:'custom',message:'费用 ID 重复'});for(const rate of Object.values(d.exchange_rates))if(rate!==null&&/^0(?:\.0+)?$/u.test(rate))c.addIssue({code:'custom',message:'汇率必须大于零'});});
export const signedCalculatedFeeSchema=signedFeeBaseSchema.extend({amount:z.string().regex(/^[0-9]+\.[0-9]{2}$/u)}).strict().refine(f=>f.display!=='merged'||f.merge_name.length>0,{message:'合并费用必须填写显示名称'});
export const signedTotalsSchema=totalsSchema.extend({rows:z.array(signedCalculatedFeeSchema).max(60)});
export const signedExportViewSchema=exportViewSchema.extend({totals:signedTotalsSchema}).strict();
const documentListV1ItemSchema=documentViewSchema.pick({id:true,version:true,state:true,created_at:true}).extend({quote_no:z.string(),customer_name:z.string()}).strict();
const linkedDocumentListV2ItemSchema=documentListV1ItemSchema.extend({inquiry_case_link_v1:inquiryCaseLinkSchema}).strict();
export const nativePrepareLinkedSchema=z.object({
  contract_version:z.literal(INQUIRY_QUOTE_LINK_VERSION),
  case_ref:z.string().uuid(),
  expected_customer_event_ref:z.string().uuid().nullable(),
  request:zoneInputSchema,
  customer:nativePrepareSchema.shape.customer,
}).strict();
export const saveLinkedSchema=saveSchema.extend({
  contract_version:z.literal(INQUIRY_QUOTE_LINK_VERSION),
  input:signedDocumentSchema,
  native_quote_v1:nativeQuoteBindingSchema,
  inquiry_case_link_v1:inquiryCaseLinkSchema,
}).strict();
export const getLinkedSchema=idSchema.extend({contract_version:z.literal(INQUIRY_QUOTE_LINK_VERSION)}).strict();
export const listLinkedSchema=z.object({contract_version:z.literal(INQUIRY_QUOTE_LINK_VERSION),limit:z.number().int().min(1).max(100),before:z.number().int().positive().optional()}).strict();
export const approveLinkedSchema=approveSchema.extend({contract_version:z.literal(INQUIRY_QUOTE_LINK_VERSION)}).strict();
export const rejectLinkedSchema=rejectSchema.extend({contract_version:z.literal(INQUIRY_QUOTE_LINK_VERSION)}).strict();
export const exportLinkedSchema=idSchema.extend({contract_version:z.literal(INQUIRY_QUOTE_LINK_VERSION),mode:z.enum(['formal','history'])}).strict();
export const linkedPreviewViewSchema=previewViewSchema.extend({input:signedDocumentSchema,native_quote_v1:nativeQuoteBindingSchema,inquiry_case_link_v1:inquiryCaseLinkSchema}).strict();
export const v2UnlinkedDocumentViewSchema=documentViewSchema.extend({input:signedDocumentSchema}).strict();
export const linkedDocumentViewSchema=v2UnlinkedDocumentViewSchema.extend({native_quote_v1:nativeQuoteBindingSchema,inquiry_case_link_v1:inquiryCaseLinkSchema}).strict();
export const documentViewV2Schema=z.union([v2UnlinkedDocumentViewSchema,linkedDocumentViewSchema]);
export const documentListViewV2Schema=z.object({items:z.array(z.union([documentListV1ItemSchema,linkedDocumentListV2ItemSchema])).max(100),next_cursor:z.number().int().positive().nullable()}).strict();
export const linkedFormalExportViewSchema=signedExportViewSchema.extend({draft:z.literal(false),historical:z.literal(false),valid_now:z.literal(true),inquiry_case_link_v1:inquiryCaseLinkSchema}).strict();
export const linkedHistoryExportViewSchema=signedExportViewSchema.extend({historical:z.literal(true),valid_now:z.literal(false),inquiry_case_link_v1:inquiryCaseLinkSchema}).strict();
export const replayNotCurrentDataSchema=z.object({
  id:z.string().uuid(),
  version:z.number().int().positive(),
  current_version:z.number().int().positive(),
  current_state:z.enum(['draft','approved','rejected']),
  current:z.literal(false),
  committed:z.literal(true),
  replay:z.literal(true),
  historical:z.literal(true),
}).strict();
export const replayValidityDataSchema=z.object({
  id:z.string().uuid(),
  version:z.number().int().positive(),
  committed:z.literal(true),
  replay:z.literal(true),
  valid_now:z.literal(false),
  historical:z.literal(true),
}).strict();
export const linkedErrorEnvelopeSchema=z.object({
  schema_version:z.literal(V2_VERSION),
  status:z.enum(['needs_input','blocked','unavailable']),
  data:z.null(),
  reason_codes:z.array(z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u)).min(1),
}).strict();
export const quoteDocumentSchemasV2:Record<string,z.ZodType>={
  'native-prepare-v2':nativePrepareLinkedSchema,
  'save-v2':saveLinkedSchema,
  'get-v2':getLinkedSchema,
  'list-v2':listLinkedSchema,
  'approve-v2':approveLinkedSchema,
  'reject-v2':rejectLinkedSchema,
  'export-v2':exportLinkedSchema,
};
const successV2=<S extends z.ZodType>(data:S)=>z.object({
  schema_version:z.literal(V2_VERSION),
  status:z.literal('success'),
  data,
  reason_codes:z.array(z.string()).max(0),
}).strict();
const manualReviewV2=<S extends z.ZodType>(data:S,reasons:readonly [string,...string[]])=>z.object({
  schema_version:z.literal(V2_VERSION),
  status:z.literal('manual_review'),
  data,
  reason_codes:z.array(z.enum(reasons)).length(1),
}).strict();
export const linkedResponseSchemas:Record<string,z.ZodType>={
  'native-prepare':z.union([successV2(linkedPreviewViewSchema),manualReviewV2(z.null(),['inquiry_quote_case_review_required','native_quote_source_changed','native_quote_release_expired'])]),
  'save':z.union([successV2(linkedDocumentViewSchema),manualReviewV2(z.null(),['inquiry_quote_case_review_required','document_preview_stale','native_quote_source_changed','native_quote_release_expired']),manualReviewV2(replayNotCurrentDataSchema,['inquiry_quote_replay_not_current']),manualReviewV2(replayValidityDataSchema,['inquiry_quote_replay_expired']),manualReviewV2(replayValidityDataSchema,['inquiry_quote_replay_stale'])]),
  'get':z.union([successV2(documentViewV2Schema),manualReviewV2(replayNotCurrentDataSchema,['inquiry_quote_replay_not_current']),manualReviewV2(replayValidityDataSchema,['inquiry_quote_replay_expired']),manualReviewV2(replayValidityDataSchema,['inquiry_quote_replay_stale'])]),
  'list':successV2(documentListViewV2Schema),
  'approve':z.union([successV2(documentViewV2Schema),manualReviewV2(z.null(),['inquiry_quote_case_review_required','document_preview_stale','native_quote_source_changed','native_quote_release_expired','document_expired']),manualReviewV2(replayNotCurrentDataSchema,['inquiry_quote_replay_not_current']),manualReviewV2(replayValidityDataSchema,['inquiry_quote_replay_expired']),manualReviewV2(replayValidityDataSchema,['inquiry_quote_replay_stale'])]),
  'reject':z.union([successV2(documentViewV2Schema),manualReviewV2(replayNotCurrentDataSchema,['inquiry_quote_replay_not_current'])]),
  'export':z.union([successV2(signedExportViewSchema),successV2(linkedFormalExportViewSchema),z.object({schema_version:z.literal(V2_VERSION),status:z.literal('success'),data:linkedHistoryExportViewSchema,reason_codes:z.array(z.literal('inquiry_quote_history_only')).length(1)}).strict(),manualReviewV2(z.null(),['inquiry_quote_export_expired','native_quote_source_changed','native_quote_release_expired','inquiry_quote_case_review_required','version_conflict'])]),
};
