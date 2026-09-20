import {maritimeDatasetSchema,maritimeSaveSchema} from '../../maritime/contracts';
import {rateTableInput} from '../../quote-native/admin-tables';
import { customsBrowseInput, customsBrowseResult } from '../../customs-native/catalog';
import { z } from 'zod';
import { customsDatasetSchema } from '../../customs-native/contracts';
import { residentialRatesSchema } from '../../quote-native/contracts';
import { fclRateDatasetSchema, fclRatePublicationSchema, fclRateSaveSchema } from '../../quote-native/fcl-contracts';
export const NATIVE_ADMIN_VERSION='portal-native-admin@2026-09-07.v1';
export type NativeKind='customs'|'residential'|'schedules'|'terminals'|'fcl';
export const FCL_NOTIFICATION_VERSION='fcl-notification@2026-09-21.v1' as const;
const fclNotificationEmail=z.string().trim().min(1).max(254).refine(value=>z.email().safeParse(value).success);
export const fclNotificationConfigSchema=z.object({
  enabled:z.boolean(),
  recipient:z.string().trim().max(254).nullable(),
  cc:z.array(fclNotificationEmail).max(10),
}).strict().superRefine((value,context)=>{
  if(value.enabled&&(value.recipient===null||!z.email().safeParse(value.recipient).success))context.addIssue({code:'custom',path:['recipient'],message:'enabled_notification_requires_recipient'});
  if(value.recipient!==null&&value.recipient!==''&&!z.email().safeParse(value.recipient).success)context.addIssue({code:'custom',path:['recipient'],message:'notification_recipient_invalid'});
  if(new Set(value.cc).size!==value.cc.length)context.addIssue({code:'custom',path:['cc'],message:'notification_cc_duplicate'});
});
export const fclNotificationSaveSchema=z.object({
  contract_version:z.literal(FCL_NOTIFICATION_VERSION),
  expected_version:z.number().int().nonnegative(),
  input:fclNotificationConfigSchema,
  confirmed:z.literal(true),
}).strict();
export const fclNotificationViewSchema=z.object({
  contract_version:z.literal(FCL_NOTIFICATION_VERSION),
  version:z.number().int().nonnegative(),
  input:fclNotificationConfigSchema.nullable(),
  replay:z.object({
    replayed:z.boolean(),
    submitted_version:z.number().int().nonnegative().nullable(),
    current:z.boolean(),
  }).strict(),
}).strict();
export const fclNotificationSchemas={save:fclNotificationSaveSchema,output:fclNotificationViewSchema} as const;
export const nativePublishSchema=z.object({expected_version:z.number().int().nonnegative(),preview_hash:z.string().regex(/^[a-f0-9]{64}$/u),confirmation:z.literal('reviewed_sources_and_conditions')}).strict();
export const nativeDisableSchema=z.object({expected_version:z.number().int().nonnegative()}).strict();
export const nativeRollbackSchema=nativePublishSchema.extend({release_id:z.uuid()});
export const customsSaveSchema=z.object({expected_version:z.number().int().nonnegative(),input:customsDatasetSchema}).strict();
export const residentialSaveSchema=z.object({expected_version:z.number().int().nonnegative(),input:residentialRatesSchema}).strict();
export function nativeDataSchema(kind:NativeKind,preview=false){const input=kind==='customs'?customsDatasetSchema:kind==='residential'?residentialRatesSchema:kind==='fcl'?fclRateDatasetSchema:maritimeDatasetSchema(kind),hash=z.string().regex(/^[a-f0-9]{64}$/u),version=z.number().int().nonnegative(),activeRelease=kind==='fcl'?fclRatePublicationSchema:z.object({release_id:z.uuid(),version,input,published_at:z.iso.datetime(),digest:hash}).strict();if(preview)return z.object({kind:z.literal(kind),version,input,release_id:z.uuid().nullable(),preview_hash:hash,can_publish:z.boolean(),blockers:z.array(z.string())}).strict();return z.object({kind:z.literal(kind),version,draft:input.nullable(),active_release:activeRelease.nullable(),history:z.array(z.object({release_id:z.uuid(),version,label:z.string(),published_at:z.iso.datetime(),digest:hash}).strict()).max(50)}).strict();}
export const freightcomSaveSchema=z.object({expected_version:z.number().int().nonnegative(),label:z.string().trim().min(1).max(100),credential:z.string().min(8).max(4096).regex(/^[^\s]+$/u),confirmation:z.literal('use_for_current_organization')}).strict();
export const freightcomDisableSchema=nativeDisableSchema;
export const freightcomViewSchema=z.object({version:z.number().int().nonnegative(),label:z.string(),credential_present:z.boolean(),updated_at:z.iso.datetime().nullable(),provider:z.literal('Freightcom'),live_rate_verified:z.literal(false)}).strict();
export function nativeResponseSchema(data:z.ZodType){return z.object({schema_version:z.literal(NATIVE_ADMIN_VERSION),status:z.literal('success'),data,reason_codes:z.array(z.string()).length(0)}).strict();}

export const rateImportResponse=z.object({schema_version:z.literal('native-rate-table@2026-09-07.v1'),status:z.enum(['success','needs_input']),data:z.object({table:z.enum(['rates','zones']),sheet:z.string(),source_rows:z.number().int().nonnegative(),errors:z.array(z.string()).max(51),save_input:residentialSaveSchema.nullable()}).strict(),reason_codes:z.array(z.string())}).strict();
export const rateExportResponse=z.object({schema_version:z.literal('native-rate-table@2026-09-07.v1'),status:z.literal('success'),selection:z.enum(['draft','published']),table:z.enum(['rates','zones']),file:z.string(),version:z.number().int().nonnegative()}).strict();
 export const nativeSchemas={rate_table_input:rateTableInput,rate_import_response:rateImportResponse,rate_export_response:rateExportResponse,customs_browse_input:customsBrowseInput,customs_browse_response:z.object({schema_version:z.literal("native-customs-catalog@2026-09-07.v1"),status:z.literal("success"),data:customsBrowseResult,reason_codes:z.array(z.string()).length(0)}).strict(),customs_save:customsSaveSchema,residential_save:residentialSaveSchema,fcl_save:fclRateSaveSchema,publish:nativePublishSchema,rollback:nativeRollbackSchema,disable:nativeDisableSchema,freightcom_save:freightcomSaveSchema,freightcom_response:nativeResponseSchema(freightcomViewSchema),customs_response:nativeResponseSchema(nativeDataSchema("customs")),customs_preview:nativeResponseSchema(nativeDataSchema("customs",true)),residential_response:nativeResponseSchema(nativeDataSchema("residential")),residential_preview:nativeResponseSchema(nativeDataSchema("residential",true)),fcl_response:nativeResponseSchema(nativeDataSchema("fcl")),fcl_preview:nativeResponseSchema(nativeDataSchema("fcl",true))};

for(const kind of ['schedules','terminals'] as const) Object.assign(nativeSchemas,{[kind+'_save']:maritimeSaveSchema(kind),[kind+'_response']:nativeResponseSchema(nativeDataSchema(kind)),[kind+'_preview']:nativeResponseSchema(nativeDataSchema(kind,true))});
