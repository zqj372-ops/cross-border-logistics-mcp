import { z } from 'zod';
import { FCL_CONTAINER_TYPES, fclInquiryFieldDiffSchema, fclInquiryPatchSchema, fclInquirySchema } from '../../../apps/inquiry/fcl-model';
import { createDraft, validateStep, type Draft } from '../../../apps/inquiry/model';

export const CASE_VERSION = 'portal-cases@2026-09-07.v1';
export const CASE_STATUSES = ['submitted','in_review','needs_input','closed','cancelled'] as const;
export type CaseStatus = typeof CASE_STATUSES[number];
// Reject control characters while allowing normal multiline notes.
// eslint-disable-next-line no-control-regex
const safeText = (max:number) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const draftFields = Object.fromEntries(Object.entries(createDraft()).map(([key,value])=>[key, typeof value === 'boolean' ? z.boolean() : Array.isArray(value) ? z.array(z.string().max(40)).min(1).max(5).refine(values=>new Set(values).size===values.length) : safeText(key==='notes'?4000:254)]));
export const caseInputSchema = z.object(draftFields).strict().superRefine((input,ctx)=>{
 const value=input as Draft;
 if (!['shipping','business'].includes(value.mode)) ctx.addIssue({code:'custom',message:'invalid mode'});
 for(const step of [1,2,3]) for(const [field,message] of Object.entries(validateStep(value,step)))ctx.addIssue({code:'custom',path:[field],message});
});
export const caseUpdateSchema = z.object({expected_version:z.number().int().positive(),status:z.enum(CASE_STATUSES),public_note:safeText(2000).refine(v=>v.trim().length>0),internal_note:safeText(2000).default('')}).strict();
export const caseReplySchema = z.object({expected_version:z.number().int().positive(),message:safeText(2000).refine(v=>v.trim().length>0)}).strict();
export const caseListSchema = z.object({management:z.boolean().default(false),status:z.enum(CASE_STATUSES).optional(),cursor:z.string().max(300).optional(),limit:z.number().int().min(1).max(50).default(25)}).strict();
const caseEventSchema = z.object({event_id:z.string(),version:z.number().int().positive(),status:z.enum(CASE_STATUSES),message:z.string(),visibility:z.enum(['customer','internal']),actor_label:z.string(),created_at:z.string()}).strict();
export const caseViewSchema = z.object({case_id:z.string(),status:z.enum(CASE_STATUSES),version:z.number().int().positive(),input:caseInputSchema,created_at:z.string(),updated_at:z.string(),can_manage:z.boolean(),can_reply:z.boolean(),events:z.array(caseEventSchema).max(1000)}).strict();
export const caseResponseSchema = z.object({schema_version:z.literal(CASE_VERSION),status:z.literal('success'),data:z.union([caseViewSchema,z.object({items:z.array(caseViewSchema).max(50),next_cursor:z.string().nullable(),can_manage:z.boolean()}).strict()]),reason_codes:z.array(z.string()).length(0)}).strict();

// Inquiry-to-quote review context v2. The v1 DTO above remains unchanged.
export const CASE_LINK_VERSION = 'inquiry-quote-link@2026-09-13.v1' as const;
export const CASE_V2_VERSION = 'portal-cases@2026-09-13.v2' as const;
export const caseReviewContextSchema = z.object({
  latest_customer_supplement_ref: z.string().uuid().nullable(),
}).strict();
export const caseViewV2Schema = caseViewSchema.extend({review_context:caseReviewContextSchema}).strict();
export const caseResponseV2Schema = z.object({
  schema_version:z.literal(CASE_V2_VERSION),
  status:z.literal('success'),
  data:caseViewV2Schema,
  reason_codes:z.array(z.string()).length(0),
}).strict();

// FCL personal-case contracts. These are additive and do not reinterpret the old Draft.
export const FCL_CASE_VERSION = 'fcl-case@2026-09-20.v1' as const;
export const FCL_NOTIFICATION_STATUSES = ['not_attempted','disabled','sent','failed'] as const;
export const fclCaseInputSchema = fclInquirySchema;
const optionalMessageSchema = z.union([safeText(2000).refine((value) => value.trim().length > 0), z.null()]);
const fclCaseSupplementShape = {
  expected_version:z.number().int().positive(),
  fields:fclInquiryPatchSchema,
  message:optionalMessageSchema,
};
export const fclCaseCustomerSupplementSchema = z.object(fclCaseSupplementShape).strict().superRefine((input, context) => {
  if (input.fields.changes.length === 0 && input.message === null) {
    context.addIssue({ code:'custom', path:['message'], message:'supplement_content_required' });
  }
});
export const fclCaseStaffSupplementSchema = z.object(fclCaseSupplementShape).strict().superRefine((input, context) => {
  if (input.fields.changes.length === 0 && input.message === null) {
    context.addIssue({ code:'custom', path:['message'], message:'supplement_content_required' });
  }
});
export const fclCaseConfirmationSchema = z.object({
  expected_version:z.number().int().positive(),
  expected_customer_supplement_ref:z.string().uuid().nullable(),
  confirmed_fields:fclInquiryPatchSchema,
  reason:safeText(2000).refine((value) => value.trim().length > 0),
}).strict();
export const fclCaseStatusUpdateSchema = caseUpdateSchema;
export const fclCaseListQuerySchema = z.object({
  limit:z.number().int().min(1).max(50),
  status:z.union([z.enum(CASE_STATUSES),z.null()]),
  cursor:z.union([z.string().max(300),z.null()]),
}).strict();
export const fclCaseNotificationSchema = z.object({
  status:z.enum(FCL_NOTIFICATION_STATUSES),
  reason_code:z.string().min(1).max(120).nullable(),
  attempted_at:z.string().datetime().nullable(),
}).strict();
const fclCaseEventBase = {
  event_id:z.string().uuid(),
  version:z.number().int().positive(),
  status:z.enum(CASE_STATUSES),
  message:safeText(2000),
  visibility:z.enum(['customer','internal']),
  actor_label:safeText(80),
  actor_kind:z.enum(['anonymous_customer','staff','system']),
  actor_ref:z.string().min(1).max(200),
  created_at:z.string().datetime(),
};
const fclCaseSupplementPayloadSchema = z.object({
  fields:fclInquiryPatchSchema,
  message:optionalMessageSchema,
  from_version:z.number().int().positive(),
  to_version:z.number().int().positive(),
  changed_fields:z.array(z.string().min(1).max(80)).max(17),
  field_changes:z.array(fclInquiryFieldDiffSchema).max(17),
}).strict();
export const FCL_HANDOFF_VERSION='fcl-handoff@2026-09-21.v1' as const;
export const fclHandoffPayloadSchema=z.object({
  contract_version:z.literal(FCL_HANDOFF_VERSION),
  inquiry_no:z.string().min(1).max(80),
  case_id:z.string().uuid(),
  case_version:z.number().int().positive(),
  latest_customer_supplement_ref:z.string().uuid().nullable(),
  quote_ref:z.string().uuid(),
  quote_version:z.number().int().positive(),
  quote_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  document_id:z.string().uuid(),
  document_revision_id:z.string().uuid(),
  document_version:z.number().int().positive(),
  approved_revision_id:z.string().uuid(),
  approved_version:z.number().int().positive(),
  pdf_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  pdf_byte_length:z.number().int().min(100).max(8388608),
  customer_name:z.string().min(1).max(200),
  pol:z.string().max(200).nullable(),
  pod:z.string().max(200).nullable(),
  containers:z.array(z.object({type:z.enum(FCL_CONTAINER_TYPES),quantity:z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/u)}).strict()).max(4),
  approved_at:z.iso.datetime(),
  handoff_status:z.literal('handed_off'),
  handoff_note:safeText(2000).refine(value=>value.trim().length>0),
  actor:z.string().min(1).max(200),
  recorded_at:z.iso.datetime(),
  request_digest:z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const fclCaseEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...fclCaseEventBase,
    kind:z.literal('fcl_inquiry_submitted'),
    payload:z.object({fcl_inquiry_id:z.string().uuid(), inquiry_no:z.string().regex(/^FCL-\d{8}-\d{4,}$/u)}).strict(),
  }).strict(),
  z.object({
    ...fclCaseEventBase,
    kind:z.literal('fcl_receiver_assigned'),
    payload:z.object({receiver_user_id:z.string().min(1).max(128)}).strict(),
  }).strict(),
  z.object({
    ...fclCaseEventBase,
    kind:z.literal('fcl_customer_supplement'),
    payload:fclCaseSupplementPayloadSchema,
  }).strict(),
  z.object({
    ...fclCaseEventBase,
    kind:z.literal('fcl_staff_supplement'),
    payload:fclCaseSupplementPayloadSchema.extend({ recorded_by_staff:z.literal(true) }).strict(),
  }).strict(),
  z.object({
    ...fclCaseEventBase,
    kind:z.literal('fcl_staff_confirmation'),
    payload:z.object({
      confirmed_fields:fclInquiryPatchSchema,
      reason:safeText(2000).refine((value) => value.trim().length > 0),
      reviewed_customer_supplement_ref:z.string().uuid().nullable(),
      from_version:z.number().int().positive(),
      to_version:z.number().int().positive(),
      confirmed_case_version:z.number().int().positive(),
      field_changes:z.array(fclInquiryFieldDiffSchema).max(17),
    }).strict(),
  }).strict(),
  z.object({
    ...fclCaseEventBase,
    kind:z.literal('fcl_case_status_updated'),
    payload:z.object({
      from_status:z.enum(CASE_STATUSES),
      to_status:z.enum(CASE_STATUSES),
      from_version:z.number().int().positive(),
      to_version:z.number().int().positive(),
      public_note:safeText(2000).refine((value) => value.trim().length > 0),
    }).strict(),
  }).strict(),
  z.object({
    ...fclCaseEventBase,
    kind:z.literal('fcl_internal_note'),
    payload:z.object({ note:safeText(2000).refine((value) => value.trim().length > 0) }).strict(),
  }).strict(),
  z.object({
    ...fclCaseEventBase,
    kind:z.literal('fcl_handoff_recorded'),
    payload:fclHandoffPayloadSchema,
  }).strict(),
]);
export const fclCaseSubmissionSchema = z.object({
  contract_version:z.literal(FCL_CASE_VERSION),
  inquiry_id:z.string().uuid(),
  inquiry_no:z.string().regex(/^FCL-\d{8}-\d{4,}$/u),
  case_id:z.string().uuid(),
  case_status:z.enum(CASE_STATUSES),
  case_version:z.number().int().positive(),
  created_at:z.string().datetime(),
  credential:z.string().min(32).max(256),
  credential_expires_at:z.string().datetime(),
  notification:fclCaseNotificationSchema,
  replay:z.boolean(),
}).strict();
export const fclCaseReviewContextSchema = z.object({
  latest_customer_supplement_ref:z.string().uuid().nullable(),
  last_confirmed_case_version:z.number().int().positive().nullable(),
  last_confirmed_customer_supplement_ref:z.string().uuid().nullable(),
  review_required:z.boolean(),
}).strict();
export const fclCaseInternalViewSchema = z.object({
  contract_version:z.literal(FCL_CASE_VERSION),
  inquiry_id:z.string().uuid(),
  inquiry_no:z.string().regex(/^FCL-\d{8}-\d{4,}$/u),
  case_id:z.string().uuid(),
  receiver_user_id:z.string().min(1).max(128),
  original_input:fclInquirySchema,
  current_input:fclInquirySchema,
  case_status:z.enum(CASE_STATUSES),
  case_version:z.number().int().positive(),
  created_at:z.string().datetime(),
  updated_at:z.string().datetime(),
  notification:fclCaseNotificationSchema,
  events:z.array(fclCaseEventSchema).min(1).max(1000),
  review_context:fclCaseReviewContextSchema,
}).strict();
export const fclCaseListItemSchema = fclCaseInternalViewSchema.omit({
  receiver_user_id:true,
  original_input:true,
  notification:true,
  events:true,
});
export const fclCasePublicEventSchema = z.object({
  event_id:z.string().uuid(),
  version:z.number().int().positive(),
  kind:z.enum(['fcl_inquiry_submitted','fcl_customer_supplement','fcl_staff_supplement','fcl_case_status_updated']),
  message:safeText(2000),
  actor_label:safeText(80),
  created_at:z.string().datetime(),
}).strict();
export const fclCasePublicSummarySchema = z.object({
  contract_version:z.literal(FCL_CASE_VERSION),
  inquiry_id:z.string().uuid(),
  inquiry_no:z.string().regex(/^FCL-\d{8}-\d{4,}$/u),
  case_status:z.enum(CASE_STATUSES),
  case_version:z.number().int().positive(),
  created_at:z.string().datetime(),
  credential_expires_at:z.string().datetime(),
  complete:z.boolean(),
  input:fclInquirySchema,
  events:z.array(fclCasePublicEventSchema).max(1000),
}).strict();
export const fclCaseListSchema = z.object({
  items:z.array(fclCaseListItemSchema).max(50),
  next_cursor:z.string().nullable(),
}).strict();
export const fclCaseSuccessEnvelopeSchema = z.object({
  schema_version:z.literal(FCL_CASE_VERSION),
  status:z.literal('success'),
  data:z.union([fclCaseSubmissionSchema,fclCaseInternalViewSchema,fclCasePublicSummarySchema,fclCaseListSchema]),
  reason_codes:z.array(z.string()).length(0),
}).strict();
export const fclCaseErrorEnvelopeSchema = z.object({
  schema_version:z.literal(FCL_CASE_VERSION),
  status:z.enum(['needs_input','manual_review','blocked','unavailable']),
  data:z.null(),
  reason_codes:z.array(z.string().min(1).max(120)).min(1).max(32),
}).strict();
