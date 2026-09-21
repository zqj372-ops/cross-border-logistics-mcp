import {z} from 'zod';
import {zoneInputSchema,zoneDataSchema,sourceRefSchema} from '../access-gateway/portal/business/quote-client';
import {nativeQuoteBindingSchema} from './contracts';

export const WORKFLOW_REQUEST_VERSION='quote-documents-workflow@2026-09-15.v1' as const;
export const WORKFLOW_RESPONSE_VERSION='quote-documents@2026-09-15.v3' as const;
export const DRAFT_VERSION='quote-document-draft@2026-09-15.v1' as const;
export const FEE_TEMPLATE_VERSION='quote-fee-template@2026-09-15.v1' as const;
export const FCL_DOCUMENT_WORKFLOW_VERSION='fcl-document-workflow@2026-09-20.v1' as const;
export const fclCurrentnessSchema=z.object({
  valid_now:z.boolean(),
  reason_codes:z.array(z.string().min(1).max(120)).max(64),
}).strict();

const text=(max=200)=>z.string().trim().max(max);
const nullableText=(max=200)=>text(max).nullable();
const decimal=z.string().regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/u);
const nullableDecimal=decimal.nullable();
const uuid=z.string().uuid();
const date=z.iso.date();
const currency=z.enum(['USD','CAD','CNY']);
const group=z.enum(['A','B','C']);
const display=z.enum(['detail','hiddenIncluded','hiddenExcluded','merged']);

export const feeTemplateItemSchema=z.object({
  item_key:z.string().regex(/^[a-z][a-z0-9_]{2,63}$/u),
  name:text(100).min(1),
  description:nullableText(500),
  unit_suggestion:nullableText(20),
  quantity_suggestion:nullableDecimal,
  display:display.nullable(),
}).strict();

export const feeTemplateGroupSchema=z.object({
  group,
  label:text(50).min(1),
  items:z.array(feeTemplateItemSchema).max(60),
}).strict();

export const feeTemplateSchema=z.object({
  schema_version:z.literal(FEE_TEMPLATE_VERSION),
  template_id:z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u),
  template_version:z.number().int().positive(),
  source:z.literal('platform'),
  groups:z.array(feeTemplateGroupSchema).length(3),
}).strict();

export const feeTemplateSelectionSchema=z.object({
  template_id:z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u),
  template_version:z.number().int().positive(),
  items:z.array(feeTemplateItemSchema).max(60),
}).strict();

export const templateSelectionSchema=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('current')}).strict(),
  z.object({mode:z.literal('retain')}).strict(),
  z.object({mode:z.literal('refresh_current')}).strict(),
]);

export const templateRefSchema=z.object({
  template_id:z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u),
  template_version:z.number().int().positive(),
  item_key:z.string().regex(/^[a-z][a-z0-9_]{2,63}$/u),
}).strict();

export const draftFeeSchema=z.object({
  id:uuid,
  source_kind:z.enum(['manual','template','native']),
  template_ref:templateRefSchema.nullable(),
  name:nullableText(200),
  description:nullableText(500),
  group:group.nullable(),
  quantity:nullableDecimal,
  unit:nullableText(20),
  unit_price:nullableDecimal,
  currency:currency.nullable(),
  display:display.nullable(),
  merge_name:nullableText(200),
  note:nullableText(500),
}).strict().superRefine((value,ctx)=>{
  if(value.source_kind==='template'&&value.template_ref===null)ctx.addIssue({code:'custom',message:'template fee requires template_ref'});
  if(value.source_kind!=='template'&&value.template_ref!==null)ctx.addIssue({code:'custom',message:'non-template fee cannot carry template_ref'});
});

export const draftDocumentSchema=z.object({
  schema_version:z.literal(DRAFT_VERSION),
  quote_no:nullableText(80),
  customer_name:nullableText(200),
  quote_date:date.nullable(),
  valid_until:date.nullable(),
  origin:nullableText(200),
  destination:nullableText(200),
  route_name:nullableText(200),
  job_no:nullableText(80),
  so_no:nullableText(80),
  container_no:nullableText(80),
  remark:nullableText(4000),
  exchange_rates:z.object({USD:nullableDecimal,CAD:nullableDecimal}).strict(),
  fee_items:z.array(draftFeeSchema).max(60),
}).strict().superRefine((value,ctx)=>{
  if(new Set(value.fee_items.map(item=>item.id)).size!==value.fee_items.length)ctx.addIssue({code:'custom',message:'duplicate fee id'});
  for(const rate of Object.values(value.exchange_rates))if(rate!==null&&/^0(?:\.0+)?$/u.test(rate))ctx.addIssue({code:'custom',message:'exchange rate must be positive'});
});

export const completenessSchema=z.object({
  complete:z.boolean(),
  missing_fields:z.array(z.string()),
  blocking_reasons:z.array(z.string()),
  can_review:z.boolean(),
  partial:z.boolean(),
}).strict();

export const nativeBindingV3Schema=z.object({
  schema_version:z.literal('native-quote-binding@2026-09-15.v1'),
  request:zoneInputSchema,
  preview:zoneDataSchema,
  source_refs:z.array(sourceRefSchema).min(1).max(50),
  source_refs_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  release_id:z.string().min(1),
  release_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  request_hash:z.string().regex(/^[a-f0-9]{64}$/u),
  document_fee_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  document_fee_digest_format:z.literal('canonical-json-sha256-v1'),
  binding_hash:z.string().regex(/^[a-f0-9]{64}$/u),
  provenance:z.enum(['v3_server_signed','legacy_v1_v2']),
}).strict();
export const legacyNativeBindingSchema=nativeQuoteBindingSchema;

export const inquiryCaseLinkSchema=z.object({
  case_ref:uuid,
  reviewed_customer_event_ref:uuid.nullable(),
}).strict();

const saveIntent=z.literal('save_draft');

export const createManualSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  operation:z.literal('create'),
  document_kind:z.literal('manual'),
  input:draftDocumentSchema,
  template_selection:templateSelectionSchema,
  save_intent:saveIntent,
}).strict();

export const updateManualSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  operation:z.literal('update'),
  document_kind:z.literal('manual'),
  id:uuid,
  expected_version:z.number().int().positive(),
  input:draftDocumentSchema,
  template_selection:templateSelectionSchema,
  save_intent:saveIntent,
}).strict();

const bindingUpdateRetainSchema=z.object({mode:z.literal('retain')}).strict();
const bindingUpdateReplaceSchema=z.object({
  mode:z.literal('replace'),
  native_quote_v1:nativeBindingV3Schema,
  inquiry_case_link_v1:inquiryCaseLinkSchema.optional(),
  preview_hash:z.string().regex(/^[a-f0-9]{64}$/u),
  preview_expires_at:z.number().int().positive(),
}).strict();

export const createNativeSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  operation:z.literal('create'),
  document_kind:z.enum(['native_unlinked','linked']),
  input:draftDocumentSchema,
  template_selection:templateSelectionSchema,
  native_quote_v1:nativeBindingV3Schema,
  inquiry_case_link_v1:inquiryCaseLinkSchema.optional(),
  preview_hash:z.string().regex(/^[a-f0-9]{64}$/u),
  preview_expires_at:z.number().int().positive(),
  save_intent:saveIntent,
}).strict();

export const updateNativeSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  operation:z.literal('update'),
  document_kind:z.enum(['native_unlinked','linked']),
  id:uuid,
  expected_version:z.number().int().positive(),
  input:draftDocumentSchema,
  template_selection:templateSelectionSchema,
  binding_update:z.union([bindingUpdateRetainSchema,bindingUpdateReplaceSchema]),
  save_intent:saveIntent,
}).strict();

export const saveWorkflowSchema=z.union([createManualSchema,updateManualSchema,createNativeSchema,updateNativeSchema]);
export const getWorkflowSchema=z.object({contract_version:z.literal(WORKFLOW_REQUEST_VERSION),id:uuid}).strict();
export const listWorkflowSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  limit:z.number().int().min(1).max(100),
  cursor:z.string().max(512).nullable().optional(),
  filters:z.object({
    state:z.enum(['all','draft','approved','rejected']),
    quote_no:nullableText(80),
    customer_name:nullableText(200),
  }).strict(),
}).strict();
export const reviewWorkflowSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  id:uuid,
  expected_version:z.number().int().positive(),
}).strict();
export const previewWorkflowSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  input:draftDocumentSchema,
}).strict();
const nativePrepareCustomerSchema=z.object({
  quote_no:z.string().trim().max(80).min(1),
  customer_name:z.string().trim().max(200).min(1),
  quote_date:date,
  valid_until:date,
  job_no:z.string().trim().max(80),
  so_no:z.string().trim().max(80),
  container_no:z.string().trim().max(80),
  remark:z.string().trim().max(4000),
}).strict();
export const nativePrepareWorkflowSchema=z.union([
  z.object({contract_version:z.literal(WORKFLOW_REQUEST_VERSION),document_kind:z.literal('native_unlinked'),request:zoneInputSchema,customer:nativePrepareCustomerSchema}).strict(),
  z.object({contract_version:z.literal(WORKFLOW_REQUEST_VERSION),document_kind:z.literal('linked'),case_ref:uuid,expected_customer_event_ref:uuid.nullable(),request:zoneInputSchema,customer:nativePrepareCustomerSchema}).strict(),
]);
export const approveWorkflowSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  id:uuid,
  expected_version:z.number().int().positive(),
  review_hash:z.string().regex(/^[a-f0-9]{64}$/u),
  evidence_ref:text(500).min(1),
  evidence_version:text(100).min(1),
  review_notes:text(2000).min(1),
  confirmation:z.literal('human_verified_price_and_source'),
}).strict();
export const rejectWorkflowSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  id:uuid,
  expected_version:z.number().int().positive(),
  reason:text(2000).min(1),
}).strict();
export const exportWorkflowSchema=z.discriminatedUnion('mode',[
  z.object({contract_version:z.literal(WORKFLOW_REQUEST_VERSION),id:uuid,mode:z.literal('draft'),expected_version:z.number().int().positive()}).strict(),
  z.object({contract_version:z.literal(WORKFLOW_REQUEST_VERSION),id:uuid,mode:z.literal('formal'),expected_version:z.number().int().positive()}).strict(),
  z.object({contract_version:z.literal(WORKFLOW_REQUEST_VERSION),id:uuid,mode:z.literal('history'),target_version:z.number().int().positive(),expected_current_version:z.number().int().positive()}).strict(),
]);
export const configSaveWorkflowSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  expected_version:z.number().int().nonnegative(),
  input:z.object({
    company_name:text().min(1),
    company_address:text(500),
    company_phone:text(50),
    company_email:text(254),
    terms:text(4000).min(1),
    fee_items:z.array(z.unknown()).max(60),
    standard_fee_template_v1:feeTemplateSelectionSchema.optional(),
  }).strict(),
  confirmed:z.literal(true),
}).strict();
export const configWorkflowSchema=z.object({contract_version:z.literal(WORKFLOW_REQUEST_VERSION)}).strict();

export const workflowRequestSchemas:Record<string,z.ZodType>={config:configWorkflowSchema,save:saveWorkflowSchema,get:getWorkflowSchema,list:listWorkflowSchema,review:reviewWorkflowSchema,preview:previewWorkflowSchema,'native-prepare':nativePrepareWorkflowSchema,approve:approveWorkflowSchema,reject:rejectWorkflowSchema,export:exportWorkflowSchema,'config-save':configSaveWorkflowSchema};

export const approvalViewSchema=z.object({
  contract_version:z.literal(WORKFLOW_REQUEST_VERSION),
  id:uuid,
  expected_version:z.number().int().positive(),
  review_hash:z.string().regex(/^[a-f0-9]{64}$/u),
  evidence_ref:text(500).min(1),
  evidence_version:text(100).min(1),
  review_notes:text(2000).min(1),
  confirmation:z.literal('human_verified_price_and_source'),
  source_revision_id:uuid,
  source_version:z.number().int().positive(),
  source_content_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  approved_revision_id:uuid,
  approved_version:z.number().int().positive(),
  review_expires_at:z.number().int().positive(),
  actor:z.string().min(1),
  at:z.iso.datetime(),
}).strict();
export const legacyApprovalViewSchema=z.object({
  evidence_ref:text(500).min(1),
  evidence_version:text(100).min(1),
  review_notes:text(2000).min(1),
  actor:z.string().min(1),
  at:z.iso.datetime(),
}).strict();
export const approvalProvenanceSchema=z.object({
  kind:z.literal('legacy_v1_v2'),
  legacy_version:z.number().int().positive(),
  legacy_approval_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  verified_by_rule:z.literal('legacy_approval_v1_v2'),
  v3_review_hash:z.null(),
  v3_source_revision_id:z.null(),
}).strict();

export const documentSummarySchema=z.object({
  id:uuid,
  revision_id:uuid.nullable(),
  version:z.number().int().positive(),
  state:z.enum(['draft','approved','rejected']),
  document_kind:z.enum(['manual','native_unlinked','linked']),
  organization_id:z.string().min(1),
  owner_id:z.string().min(1),
  quote_no:nullableText(80),
  customer_name:nullableText(200),
  created_at:z.iso.datetime(),
  updated_at:z.iso.datetime(),
  complete:z.boolean(),
  claim_state:z.enum(['legacy_unclaimed','claimed_v3']),
  inquiry_case_link_v1:inquiryCaseLinkSchema.nullable(),
}).strict();

export const workflowDocumentViewSchema=documentSummarySchema.extend({
  input:draftDocumentSchema,
  completeness:completenessSchema,
  template:z.object({company_name:text(),company_address:text(500),company_phone:text(50),company_email:text(254),terms:text(4000)}).strict(),
  template_version:z.number().int().positive(),
  native_quote_v1:z.union([nativeBindingV3Schema,legacyNativeBindingSchema]).nullable(),
  approval:z.union([approvalViewSchema,legacyApprovalViewSchema]).nullable(),
  approval_provenance:approvalProvenanceSchema.nullable(),
  rejection:z.object({reason:z.string(),actor:z.string(),at:z.iso.datetime()}).strict().nullable(),
}).strict();

export const workflowTotalSchema=z.object({
  partial:z.boolean(),
  complete:z.boolean(),
  rows:z.array(draftFeeSchema.extend({amount:z.string().nullable()}).strict()),
  by_currency:z.object({USD:z.string(),CAD:z.string(),CNY:z.string()}).strict(),
  total_cny:z.string().nullable(),
  total_usd:z.string().nullable(),
  warnings:z.array(z.string()),
  calculation_version:z.literal('quote-documents-decimal-v1'),
}).strict();

export const reviewViewSchema=z.object({
  document_id:uuid,
  revision_id:uuid.nullable(),
  reviewed_version:z.number().int().positive(),
  state:z.enum(['draft','approved','rejected']),
  input:draftDocumentSchema,
  completeness:completenessSchema,
  totals:workflowTotalSchema,
  warnings:z.array(z.string()),
  blockers:z.array(z.string()),
  requirements:z.object({complete:z.boolean(),case_current:z.boolean(),native_source_current:z.boolean(),validity_ok:z.boolean()}).strict(),
  can_approve:z.boolean(),
  available_export_modes:z.array(z.enum(['draft','formal','history'])),
  review_hash:z.string().regex(/^[a-f0-9]{64}$/u),
  review_expires_at:z.number().int().positive(),
}).strict();

export const workflowListSchema=z.object({items:z.array(documentSummarySchema).max(100),next_cursor:z.string().nullable()}).strict();

export const workflowExportSchema=z.object({
  id:uuid,
  version:z.number().int().positive(),
  revision_id:uuid.nullable(),
  current_version:z.number().int().positive(),
  mode:z.enum(['draft','formal','history']),
  draft:z.boolean(),
  historical:z.boolean(),
  valid_now:z.boolean(),
  target_version:z.number().int().positive(),
  filename:z.string().regex(/^quotation-[a-f0-9-]+-v[0-9]+\.pdf$/u),
  sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  byte_length:z.number().int().min(100).max(8388608),
  content_base64:z.string().max(11184812).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  totals:workflowTotalSchema.nullable(),
}).strict();

export const replayViewSchema=z.object({
  replay:z.literal(true),
  committed:z.literal(true),
  current:z.literal(false),
  historical:z.literal(true),
  valid_now:z.literal(false),
  id:uuid,
  version:z.number().int().positive(),
  revision_id:uuid.nullable(),
  current_version:z.number().int().positive(),
  current_revision_id:uuid.nullable(),
  current_state:z.enum(['draft','approved','rejected']),
}).strict();

export const workflowReasonCodeSchema=z.enum([
  'document_input_invalid',
  'document_update_input_invalid',
  'document_contract_version_invalid',
  'document_incomplete',
  'document_preview_stale',
  'document_template_missing',
  'document_expired',
  'document_v3_rollback_read_only',
  'document_v3_upgrade_ownership_required',
  'document_v3_upgrade_old_writer_open',
  'document_v3_upgrade_ownership_unverified',
  'version_conflict',
  'document_state_not_editable',
  'document_management_denied',
  'document_organization_required',
  'inquiry_quote_document_scope_required',
  'document_not_found',
  'idempotency_key_invalid',
  'idempotency_conflict',
  'document_review_stale',
  'document_review_forgery',
  'native_quote_rebind_required',
  'native_quote_source_changed',
  'native_quote_release_expired',
  'native_quote_validity_invalid',
  'inquiry_quote_link_forgery',
  'inquiry_quote_case_review_required',
  'document_export_mode_invalid',
  'document_not_approved',
  'document_rejected',
  'inquiry_quote_history_bytes_missing',
  'document_renderer_unavailable',
  'document_pdf_invalid',
  'document_service_unavailable',
  'document_readback_failed',
  'document_replay_not_current',
]);

export const workflowOutputSchemas:Record<string,z.ZodType>={
  config:z.object({version:z.number().int().nonnegative(),input:z.record(z.string(),z.unknown()).nullable(),standard_fee_template_v1:feeTemplateSelectionSchema.nullable(),catalog:feeTemplateSchema}).strict(),
  preview:z.union([reviewViewSchema,z.object({document_id:z.null(),version:z.null(),completeness:completenessSchema,totals:workflowTotalSchema}).strict()]),
  'native-prepare':z.object({document_kind:z.enum(['native_unlinked','linked']),input:draftDocumentSchema,template_version:z.number().int().positive(),native_quote_v1:nativeBindingV3Schema,inquiry_case_link_v1:inquiryCaseLinkSchema.nullable(),preview_hash:z.string().regex(/^[a-f0-9]{64}$/u),preview_expires_at:z.number().int().positive(),totals:workflowTotalSchema}).strict(),
  save:z.union([workflowDocumentViewSchema,replayViewSchema]),
  get:workflowDocumentViewSchema,
  list:workflowListSchema,
  review:z.union([reviewViewSchema,z.object({document_id:uuid,version:z.number().int().positive(),completeness:completenessSchema,totals:workflowTotalSchema}).strict()]),
  approve:workflowDocumentViewSchema,
  reject:workflowDocumentViewSchema,
  export:workflowExportSchema,
  'config-save':z.object({version:z.number().int().nonnegative(),input:z.record(z.string(),z.unknown()).nullable(),standard_fee_template_v1:feeTemplateSelectionSchema.nullable(),catalog:feeTemplateSchema}).strict(),
};

export const workflowErrorEnvelopeSchema=z.object({
  schema_version:z.literal(WORKFLOW_RESPONSE_VERSION),
  status:z.enum(['needs_input','manual_review','blocked','unavailable']),
  data:z.union([
    z.null(),
    z.object({document_id:uuid,version:z.number().int().positive(),completeness:completenessSchema,totals:workflowTotalSchema}).strict(),
    replayViewSchema,
  ]),
  reason_codes:z.array(workflowReasonCodeSchema).min(1),
}).strict();

export const workflowResponseSchema=(action:string,status:'success'|'needs_input'|'manual_review'= 'success')=>z.object({
  schema_version:z.literal(WORKFLOW_RESPONSE_VERSION),
  status:z.literal(status),
  data:workflowOutputSchemas[action]!,
  reason_codes:z.array(z.string()),
}).strict();

export type DraftDocument=z.infer<typeof draftDocumentSchema>;
export type DraftFee=z.infer<typeof draftFeeSchema>;
export type NativeBindingV3=z.infer<typeof nativeBindingV3Schema>;
export type WorkflowDocumentView=z.infer<typeof workflowDocumentViewSchema>;
