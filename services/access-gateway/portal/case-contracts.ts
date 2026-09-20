import { z } from 'zod';
import { fclInquirySchema } from '../../../apps/inquiry/fcl-model';
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
  actor_kind:z.enum(['anonymous_customer','system']),
  actor_ref:z.string().min(1).max(200),
  created_at:z.string().datetime(),
};
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
}).strict();
export const fclCaseListSchema = z.object({
  items:z.array(fclCaseInternalViewSchema).max(50),
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
