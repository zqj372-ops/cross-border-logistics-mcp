import {z} from 'zod';
import {FCL_CONTAINER_TYPES,FCL_INCOTERMS,FCL_SERVICE_IDS} from '../../apps/inquiry/fcl-model';
import {draftDocumentSchema,FCL_DOCUMENT_WORKFLOW_VERSION,feeTemplateSchema,feeTemplateSelectionSchema,fclCurrentnessSchema} from './workflow-contracts';
export {FCL_DOCUMENT_WORKFLOW_VERSION} from './workflow-contracts';

const issuerText=(max:number)=>z.string().trim().max(max);

export const fclConfigSchema=z.object({
  issuer_name:issuerText(200).min(1),
  issuer_address:issuerText(500),
  issuer_phone:issuerText(50),
  issuer_email:z.union([z.literal(''),z.email().max(254)]),
  terms:issuerText(4000).min(1),
  standard_fee_template_v1:feeTemplateSelectionSchema.nullable(),
}).strict();

export const fclConfigSaveSchema=z.object({
  contract_version:z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  expected_version:z.number().int().nonnegative(),
  input:fclConfigSchema,
  confirmed:z.literal(true),
}).strict();

export const fclConfigViewSchema=z.object({
  contract_version:z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  version:z.number().int().nonnegative(),
  input:fclConfigSchema.nullable(),
  catalog:feeTemplateSchema,
}).strict();

export const fclConfigSchemas:Record<string,z.ZodType>={
  'config-request':fclConfigSaveSchema,
  'config-output':fclConfigViewSchema,
};

export type FclConfig=z.infer<typeof fclConfigSchema>;
export type FclConfigSave=z.infer<typeof fclConfigSaveSchema>;
export type FclConfigView=z.infer<typeof fclConfigViewSchema>;
export type FclDocumentPayload=z.infer<typeof fclDocumentPayloadSchema>;
export type FclDocumentView=z.infer<typeof fclDocumentViewSchema>;
export type FclDocumentSaveRequest=z.infer<typeof fclDocumentSaveRequestSchema>;

export const fclDocumentCaseBindingSchema=z.object({
  case_ref:z.string().uuid(),
  case_version:z.number().int().positive(),
  latest_customer_supplement_ref:z.string().uuid().nullable(),
}).strict();

export const fclDocumentQuoteBindingSchema=z.object({
  quote_ref:z.string().uuid(),
  quote_version:z.number().int().positive(),
  quote_digest:z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const fclDocumentSourceBindingSchema=z.object({
  rate_id:z.string().uuid(),
  release_id:z.string().uuid(),
  release_version:z.number().int().positive(),
  dataset_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  source_ref:z.string().min(1).max(200),
  source_version:z.string().min(1).max(200),
  valid_from:z.iso.date(),
  valid_until:z.iso.date(),
  rate_digest:z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const fclDocumentCaseProjectionSchema=z.object({
  origin_city:z.string().max(200).nullable(),
  pol:z.string().max(200).nullable(),
  pod:z.string().max(200).nullable(),
  final_destination:z.string().max(200).nullable(),
  containers:z.array(z.object({type:z.enum(FCL_CONTAINER_TYPES),quantity:z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/u)}).strict()).max(4),
  services:z.array(z.enum(FCL_SERVICE_IDS)).max(FCL_SERVICE_IDS.length),
  incoterm:z.enum(FCL_INCOTERMS).nullable(),
  incoterm_other:z.string().max(200).nullable(),
  customer_name:z.string().min(1).max(200),
}).strict();

export const fclDocumentScopeSchema=z.object({
  service:z.enum(FCL_SERVICE_IDS),
  disposition:z.enum(['pending','priced','included','free','out_of_scope']),
  note:z.string().max(2000).nullable(),
  included_row_refs:z.array(z.string().min(1).max(160)).max(60),
}).strict();

export const fclDocumentCustomerTotalsSchema=z.object({
  by_currency:z.object({
    USD:z.string().regex(/^(?:0|[1-9]\d{0,31})(?:\.\d{1,2})?$/u),
    CAD:z.string().regex(/^(?:0|[1-9]\d{0,31})(?:\.\d{1,2})?$/u),
    CNY:z.string().regex(/^(?:0|[1-9]\d{0,31})(?:\.\d{1,2})?$/u),
  }).strict(),
}).strict();

export const fclDocumentTemplateSchema=z.object({
  company_name:z.string().min(1).max(200),
  company_address:z.string().max(500),
  company_phone:z.string().max(50),
  company_email:z.string().max(254),
  terms:z.string().min(1).max(4000),
}).strict();

export const fclDocumentPayloadSchema=z.object({
  contract_version:z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  schema_version:z.literal('fcl-linked-document@2026-09-20.v1'),
  document_id:z.string().uuid(),
  revision_id:z.string().uuid(),
  document_kind:z.literal('fcl_linked'),
  personal_owner_id:z.string().min(1).max(200),
  version:z.number().int().positive(),
  state:z.enum(['draft','approved','rejected']),
  case_binding:fclDocumentCaseBindingSchema,
  quote_binding:fclDocumentQuoteBindingSchema,
  source_binding:fclDocumentSourceBindingSchema,
  case_projection:fclDocumentCaseProjectionSchema,
  customer_input:draftDocumentSchema,
  customer_scope:z.array(fclDocumentScopeSchema).max(FCL_SERVICE_IDS.length),
  customer_totals:fclDocumentCustomerTotalsSchema,
  template:fclDocumentTemplateSchema,
  template_version:z.number().int().nonnegative(),
  content_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  signature:z.string().regex(/^[a-f0-9]{64}$/u),
  actor:z.string().min(1).max(200),
  created_at:z.iso.datetime(),
  updated_at:z.iso.datetime(),
}).strict();

export const fclDocumentViewSchema=fclDocumentPayloadSchema.extend({
  current_version:z.number().int().positive(),
  historical:z.boolean(),
  currentness:fclCurrentnessSchema,
}).strict();

export const fclDocumentListItemSchema=z.object({
  document_id:z.string().uuid(),
  version:z.number().int().positive(),
  current_version:z.number().int().positive(),
  state:z.enum(['draft','approved','rejected']),
  case_ref:z.string().uuid(),
  quote_ref:z.string().uuid(),
  quote_version:z.number().int().positive(),
  source_release_id:z.string().uuid(),
  customer_name:z.string().min(1).max(200),
  quote_no:z.string().trim().min(1).max(80),
  quote_date:z.iso.date(),
  valid_until:z.iso.date(),
  currentness:fclCurrentnessSchema,
  created_at:z.iso.datetime(),
}).strict();

const displayFields={
  quote_no:z.string().trim().min(1).max(80),
  quote_date:z.iso.date(),
  valid_until:z.iso.date(),
  remark:z.string().max(4000).nullable(),
};

export const fclDocumentCreateRequestSchema=z.object({
  contract_version:z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  operation:z.literal('create'),
  quote_ref:z.string().uuid(),
  expected_quote_version:z.number().int().positive(),
  expected_quote_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  expected_case_version:z.number().int().positive(),
  expected_customer_supplement_ref:z.string().uuid().nullable(),
  expected_config_version:z.number().int().nonnegative(),
  ...displayFields,
}).strict();

export const fclDocumentRefreshRequestSchema=z.object({
  contract_version:z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  operation:z.literal('refresh'),
  document_id:z.string().uuid(),
  expected_document_version:z.number().int().positive(),
  quote_ref:z.string().uuid(),
  expected_quote_version:z.number().int().positive(),
  expected_quote_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  expected_case_version:z.number().int().positive(),
  expected_customer_supplement_ref:z.string().uuid().nullable(),
  expected_config_version:z.number().int().nonnegative(),
  ...displayFields,
}).strict();

export const fclDocumentSaveRequestSchema=z.discriminatedUnion('operation',[fclDocumentCreateRequestSchema,fclDocumentRefreshRequestSchema]);
export const fclDocumentGetRequestSchema=z.object({
  contract_version:z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  document_id:z.string().uuid(),
  version:z.number().int().positive().nullable(),
}).strict();
export const fclDocumentListRequestSchema=z.object({
  contract_version:z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  case_ref:z.string().uuid(),
  limit:z.number().int().min(1).max(100),
  cursor:z.string().max(512).nullable(),
}).strict();
export const fclDocumentListSchema=z.object({items:z.array(fclDocumentListItemSchema).max(100),next_cursor:z.string().nullable()}).strict();
export const fclDocumentReferenceSchema=z.object({document_id:z.string().uuid(),version:z.number().int().positive(),audit_id:z.string().uuid()}).strict();

export const fclDocumentSchemas:Record<string,z.ZodType>={
  ...fclConfigSchemas,
  'linked-save-request':fclDocumentSaveRequestSchema,
  'linked-get-request':fclDocumentGetRequestSchema,
  'linked-list-request':fclDocumentListRequestSchema,
  'linked-list-output':fclDocumentListSchema,
  'linked-view-output':fclDocumentViewSchema,
};
