import {z} from 'zod';
import {
  fclCaseConfirmationSchema,
  fclCaseInternalViewSchema,
  fclCaseListQuerySchema,
  fclCaseListSchema,
  fclCasePublicSummarySchema,
  fclCaseSubmissionSchema,
  fclCaseStaffSupplementSchema,
  fclCaseStatusUpdateSchema,
} from './case-contracts';
import {
  fclNotificationSaveSchema,
  fclNotificationViewSchema,
  nativeDataSchema,
  nativeDisableSchema,
  nativePublishSchema,
  nativeRollbackSchema,
} from './native-admin-contracts';
import {fclRateSaveSchema} from '../../quote-native/fcl-contracts';
import {
  fclConfigSaveSchema,
  fclConfigViewSchema,
  fclDocumentApproveRequestSchema,
  fclDocumentExportOutputSchema,
  fclDocumentExportRequestSchema,
  fclDocumentGetRequestSchema,
  fclDocumentListRequestSchema,
  fclDocumentListSchema,
  fclDocumentRejectRequestSchema,
  fclDocumentReviewRequestSchema,
  fclDocumentReviewViewSchema,
  fclDocumentSaveRequestSchema,
  fclDocumentViewSchema,
  fclHandoffGetRequestSchema,
  fclHandoffRequestSchema,
  fclHandoffViewSchema,
} from '../../quote-documents/fcl-contracts';
import {
  fclQuoteGetRequestSchema,
  fclQuoteListRequestSchema,
  fclQuoteListSchema,
  fclQuoteMatchDataSchema,
  fclQuoteMatchRequestSchema,
  fclQuoteSaveRequestSchema,
  fclQuoteViewSchema,
} from '../../quote-native/fcl-contracts';

export const FCL_HTTP_VERSION='fcl-http@2026-09-21.v1' as const;

const caseId=z.string().uuid();
const withCaseId=<T extends z.ZodObject<z.ZodRawShape>>(schema:T)=>schema.extend({case_id:caseId});
export const fclCaseStatusRequestSchema=withCaseId(fclCaseStatusUpdateSchema);
export const fclCaseStaffSupplementRequestSchema=withCaseId(fclCaseStaffSupplementSchema);
export const fclCaseConfirmationRequestSchema=withCaseId(fclCaseConfirmationSchema);
export const fclCaseIdRequestSchema=z.object({case_id:caseId}).strict();
export const fclEmptyRequestSchema=z.object({}).strict();
export const fclRatePreviewRequestSchema=z.object({release_id:z.string().uuid().optional()}).strict();

export const fclHttpActions=[
  'case-list',
  'case-get',
  'case-status',
  'case-staff-supplement',
  'case-confirm',
  'rate-get',
  'rate-save',
  'rate-preview',
  'rate-publish',
  'rate-disable',
  'rate-rollback',
  'quote-match',
  'quote-save',
  'quote-get',
  'quote-list',
  'issuer-config',
  'issuer-config-save',
  'document-save',
  'document-get',
  'document-list',
  'document-review',
  'document-approve',
  'document-reject',
  'document-export',
  'handoff-save',
  'handoff-get',
  'notification-get',
  'notification-save',
] as const;
export type FclHttpAction=typeof fclHttpActions[number];

export const FCL_HTTP_BODY_LIMITS:Record<FclHttpAction,number>={
  'case-list':16*1024,
  'case-get':16*1024,
  'case-status':1024*1024,
  'case-staff-supplement':1024*1024,
  'case-confirm':1024*1024,
  'rate-get':16*1024,
  'rate-save':16*1024*1024,
  'rate-preview':16*1024,
  'rate-publish':1024*1024,
  'rate-disable':16*1024,
  'rate-rollback':1024*1024,
  'quote-match':1024*1024,
  'quote-save':1024*1024,
  'quote-get':64*1024,
  'quote-list':64*1024,
  'issuer-config':16*1024,
  'issuer-config-save':1024*1024,
  'document-save':1024*1024,
  'document-get':64*1024,
  'document-list':64*1024,
  'document-review':64*1024,
  'document-approve':64*1024,
  'document-reject':64*1024,
  'document-export':64*1024,
  'handoff-save':1024*1024,
  'handoff-get':16*1024,
  'notification-get':16*1024,
  'notification-save':64*1024,
};

export const FCL_HTTP_MAX_RESPONSE_BYTES=12*1024*1024;
export const FCL_RATE_RESPONSE_BYTES=40*1024*1024;
export const FCL_HTTP_RESPONSE_LIMITS:Record<FclHttpAction,number>=Object.fromEntries(
  fclHttpActions.map(action=>[action,action.startsWith('rate-')?FCL_RATE_RESPONSE_BYTES:FCL_HTTP_MAX_RESPONSE_BYTES]),
) as Record<FclHttpAction,number>;
export const FCL_PUBLIC_BODY_LIMITS={
  session:1024,
  submit:1024*1024,
  exchange:16*1024,
  supplement:1024*1024,
  logout:1024,
} as const;

export const fclHttpRequestSchemas:Record<FclHttpAction,z.ZodType>={
  'case-list':fclCaseListQuerySchema,
  'case-get':fclCaseIdRequestSchema,
  'case-status':fclCaseStatusRequestSchema,
  'case-staff-supplement':fclCaseStaffSupplementRequestSchema,
  'case-confirm':fclCaseConfirmationRequestSchema,
  'rate-get':fclEmptyRequestSchema,
  'rate-save':fclRateSaveSchema,
  'rate-preview':fclRatePreviewRequestSchema,
  'rate-publish':nativePublishSchema,
  'rate-disable':nativeDisableSchema,
  'rate-rollback':nativeRollbackSchema,
  'quote-match':fclQuoteMatchRequestSchema,
  'quote-save':fclQuoteSaveRequestSchema,
  'quote-get':fclQuoteGetRequestSchema,
  'quote-list':fclQuoteListRequestSchema,
  'issuer-config':fclEmptyRequestSchema,
  'issuer-config-save':fclConfigSaveSchema,
  'document-save':fclDocumentSaveRequestSchema,
  'document-get':fclDocumentGetRequestSchema,
  'document-list':fclDocumentListRequestSchema,
  'document-review':fclDocumentReviewRequestSchema,
  'document-approve':fclDocumentApproveRequestSchema,
  'document-reject':fclDocumentRejectRequestSchema,
  'document-export':fclDocumentExportRequestSchema,
  'handoff-save':fclHandoffRequestSchema,
  'handoff-get':fclHandoffGetRequestSchema,
  'notification-get':fclEmptyRequestSchema,
  'notification-save':fclNotificationSaveSchema,
};

export const fclHttpOutputSchemas:Record<FclHttpAction,z.ZodType>={
  'case-list':fclCaseListSchema,
  'case-get':fclCaseInternalViewSchema,
  'case-status':fclCaseInternalViewSchema,
  'case-staff-supplement':fclCaseInternalViewSchema,
  'case-confirm':fclCaseInternalViewSchema,
  'rate-get':nativeDataSchema('fcl'),
  'rate-save':nativeDataSchema('fcl'),
  'rate-preview':nativeDataSchema('fcl',true),
  'rate-publish':nativeDataSchema('fcl'),
  'rate-disable':nativeDataSchema('fcl'),
  'rate-rollback':nativeDataSchema('fcl'),
  'quote-match':fclQuoteMatchDataSchema,
  'quote-save':fclQuoteViewSchema,
  'quote-get':fclQuoteViewSchema,
  'quote-list':fclQuoteListSchema,
  'issuer-config':fclConfigViewSchema,
  'issuer-config-save':fclConfigViewSchema,
  'document-save':fclDocumentViewSchema,
  'document-get':fclDocumentViewSchema,
  'document-list':fclDocumentListSchema,
  'document-review':fclDocumentReviewViewSchema,
  'document-approve':fclDocumentViewSchema,
  'document-reject':fclDocumentViewSchema,
  'document-export':fclDocumentExportOutputSchema,
  'handoff-save':fclHandoffViewSchema,
  'handoff-get':fclHandoffViewSchema,
  'notification-get':fclNotificationViewSchema,
  'notification-save':fclNotificationViewSchema,
};

function fclResponseSchema(data:z.ZodType,preserveDomainEvidence=false){
  if(preserveDomainEvidence)return z.object({
    schema_version:z.literal(FCL_HTTP_VERSION),
    status:z.literal('success'),
    data,
    reason_codes:z.array(z.string().min(1).max(120)).max(32),
  }).strict().or(z.object({
    schema_version:z.literal(FCL_HTTP_VERSION),
    status:z.enum(['needs_input','manual_review','blocked','unavailable']),
    data:data.nullable(),
    reason_codes:z.array(z.string().min(1).max(120)).max(32),
  }).strict());
  return z.union([
    z.object({
      schema_version:z.literal(FCL_HTTP_VERSION),
      status:z.literal('success'),
      data,
      reason_codes:z.array(z.string().min(1).max(120)).max(32),
    }).strict(),
    z.object({
      schema_version:z.literal(FCL_HTTP_VERSION),
      status:z.enum(['needs_input','manual_review']),
      data:data.nullable(),
      reason_codes:z.array(z.string().min(1).max(120)).max(32),
    }).strict(),
    z.object({
      schema_version:z.literal(FCL_HTTP_VERSION),
      status:z.enum(['blocked','unavailable']),
      data:z.null(),
      reason_codes:z.array(z.string().min(1).max(120)).max(32),
    }).strict(),
  ]);
}

export const fclHttpResponseSchemas=Object.fromEntries(
  fclHttpActions.map(action=>[action,fclResponseSchema(fclHttpOutputSchemas[action],action==='quote-match')]),
) as unknown as Record<FclHttpAction,z.ZodType>;

function publicResponseSchema(data:z.ZodType){
  return z.union([
    z.object({
      schema_version:z.literal(FCL_HTTP_VERSION),
      status:z.literal('success'),
      data,
      reason_codes:z.array(z.string().min(1).max(120)).max(32),
    }).strict(),
    z.object({
      schema_version:z.literal(FCL_HTTP_VERSION),
      status:z.enum(['needs_input','manual_review','blocked','unavailable']),
      data:z.null(),
      reason_codes:z.array(z.string().min(1).max(120)).max(32),
    }).strict(),
  ]);
}

const fclPublicSessionDataSchema=z.object({
  session:z.object({session_id:z.string().min(32).max(128),csrf_token:z.string().min(32).max(128)}).strict(),
  inquiry_id:z.string().uuid().nullable(),
  capability:z.object({fcl_personal:z.boolean(),receiver_user_id:z.string().max(200).nullable(),business_date:z.iso.date()}).strict(),
}).strict();
export const fclPublicSessionResponseSchema=publicResponseSchema(fclPublicSessionDataSchema);

export const fclPublicExchangeResponseSchema=publicResponseSchema(z.object({inquiry_id:z.string().uuid()}).strict());

export const fclPublicSubmitResponseSchema=publicResponseSchema(fclCaseSubmissionSchema);

export const fclPublicViewResponseSchema=publicResponseSchema(fclCasePublicSummarySchema);

export const fclPublicOutputSchemas={
  session:fclPublicSessionResponseSchema,
  submit:fclPublicSubmitResponseSchema,
  exchange:fclPublicExchangeResponseSchema,
  get:fclPublicViewResponseSchema,
  supplement:fclPublicViewResponseSchema,
  logout:publicResponseSchema(z.null()),
} as const;
