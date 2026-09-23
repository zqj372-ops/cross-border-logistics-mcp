import {z} from 'zod';
import type {FCL_SERVICE_IDS} from '../../../apps/inquiry/fcl-model';
import {fclDocumentScopeSchema,fclDocumentSourceBindingSchema,fclHandoffRequestSchema,fclHandoffPayloadSchema} from '../../quote-documents/fcl-contracts';

export const FCL_EXECUTION_VERSION='fcl-execution@2026-09-23.v1' as const;
export const FCL_NOTIFICATION_V2='fcl-notification@2026-09-23.v2' as const;
export const FCL_MAIL_TEMPLATE_VERSION='fcl-node-mail@2026-09-23.v1' as const;
export const FCL_NODE_IDS=['booking','pickup','export_customs','shipping_documents','canada_customs','devanning_storage','delivery'] as const;
export const FCL_NOTIFICATION_NODE_IDS=['intake','quote','customer_followup',...FCL_NODE_IDS] as const;
export const FCL_NODE_SERVICES={booking:'ocean_freight',pickup:'pickup',export_customs:'export_customs',shipping_documents:'ocean_freight',canada_customs:'canada_customs',devanning_storage:'devanning_storage',delivery:'delivery'} as const satisfies Record<typeof FCL_NODE_IDS[number],typeof FCL_SERVICE_IDS[number]>;
const text=(max=200)=>z.string().trim().max(max),id=text().min(1),time=z.iso.datetime({offset:true}),version=z.number().int().positive(),hash=z.string().regex(/^[a-f0-9]{64}$/u);
const email=z.email().max(254),refs=z.array(text(500).min(1)).max(20),reason=text(2000).min(1);
const nonempty=<T>(items:T[]):[T,...T[]]=>[items[0]!,...items.slice(1)];
export const fclAssignmentSchema=z.object({responsible_id:id.nullable(),collaborator_ids:z.array(id).max(10),to:email.nullable(),cc:z.array(email).max(10),enabled:z.boolean()}).strict();
export const fclNotificationRowSchema=z.object({
  node_id:z.enum(FCL_NOTIFICATION_NODE_IDS),assignment:fclAssignmentSchema,template_version:z.literal(FCL_MAIL_TEMPLATE_VERSION),
  external_to:email.nullable(),external_cc:z.array(email).max(10),external_enabled:z.boolean(),
  visible_fields:z.array(z.enum(['carrier','vessel_voyage','booking_so','etd','eta','cutoff','pickup_location','appointment','declaration_ref','release_evidence','warehouse','handover_at','delivery_address','signed_at','empty_return_at'])).max(17),
}).strict();
export const fclNotificationV2ConfigSchema=z.object({contract_version:z.literal(FCL_NOTIFICATION_V2),version:z.number().int().nonnegative(),rows:z.array(fclNotificationRowSchema).length(10)}).strict();
export const fclNotificationV2SaveSchema=z.object({contract_version:z.literal(FCL_NOTIFICATION_V2),expected_version:z.number().int().nonnegative(),rows:z.array(fclNotificationRowSchema).length(10),confirmed:z.literal(true)}).strict();
export const fclNotificationV2ViewSchema=fclNotificationV2ConfigSchema.extend({transport:z.enum(['unconfigured','configured_unverified']),replay:z.boolean()});
export const fclConfirmationSchema=z.object({method:z.enum(['email','phone','chat','signed_document','in_person']),confirmed_at:time,contact_name:id,note:reason,evidence_refs:refs}).strict();
export const fclSharedSchema=z.object({containers:z.array(z.object({container_number:text(20).min(1),seal_number:text(40).min(1).nullable()}).strict()).max(100),hbl:id.nullable(),mbl:id.nullable(),eta:time.nullable()}).strict();
export const fclNodeFields={
  booking:z.object({carrier:text(),vessel_voyage:text(),booking_so:text(),etd:time.nullable(),cutoff:time.nullable(),booking_evidence:text(500)}).strict(),
  pickup:z.object({location:text(500),contact:text(),appointment:time.nullable(),completed_at:time.nullable(),work_evidence:text(500)}).strict(),
  export_customs:z.object({contact:text(),declaration_ref:text(),release_confirmed:z.boolean(),release_evidence:text(500),inspection_notes:text(2000)}).strict(),
  shipping_documents:z.object({checked:z.boolean(),handover_evidence:text(500),cutoff:time.nullable()}).strict(),
  canada_customs:z.object({importer:text(),declaration_ref:text(),release_confirmed:z.boolean(),release_evidence:text(500),inspection_notes:text(2000)}).strict(),
  devanning_storage:z.object({warehouse:text(500),contact:text(),arrival_at:time.nullable(),handover_at:time.nullable(),discrepancies:text(2000),damage:text(2000),handover_evidence:text(500)}).strict(),
  delivery:z.object({pickup_location:text(500),release_source:z.enum(['unconfirmed','company','external']),release_evidence:text(500),delivery_address:text(500),contact:text(),appointment:time.nullable(),signed_at:time.nullable(),pod_ref:text(500),empty_return_required:z.boolean(),empty_return_at:time.nullable(),empty_return_evidence:text(500)}).strict(),
};
const nodeBase={cycle:version,status:z.enum(['not_started','active','exception','completed','skipped','cancelled']),assignment:fclAssignmentSchema,notification:fclNotificationRowSchema,assignment_source:z.enum(['snapshot','case_override','applied_default']),deadline:time.nullable(),notes:text(2000),evidence_refs:refs,started_at:time.nullable(),completed_at:time.nullable()} as const;
export const fclNodeSchema=z.discriminatedUnion('node_id',nonempty(FCL_NODE_IDS.map(node_id=>z.object({...nodeBase,node_id:z.literal(node_id),fields:fclNodeFields[node_id]}).strict())));
export const fclExecutionAcceptanceSchema=z.object({acceptance_id:z.uuid(),confirmation:fclConfirmationSchema,registered_by:id,registered_at:time,handoff:fclHandoffPayloadSchema,source_binding:fclDocumentSourceBindingSchema,customer_scope:z.array(fclDocumentScopeSchema).max(6),configuration:fclNotificationV2ConfigSchema,reason}).strict();
export const fclExecutionAuditSchema=z.object({event_id:z.uuid(),version,actor_id:id,action:z.enum(['start','shared_save','node_save','node_start','node_complete','node_exception','node_return','node_assign','node_reopen','node_skip','node_cancel','amend','apply_defaults','mail_resolve','mail_retry','mention']),node_id:z.enum(FCL_NODE_IDS).nullable(),cycle:version.nullable(),reason:text(2000),before_nodes:z.array(fclNodeSchema).max(7),before_shared:fclSharedSchema.nullable(),notify_node_ids:z.array(z.enum(FCL_NODE_IDS)).max(7),created_at:time}).strict();
export const fclExecutionSchema=z.object({contract_version:z.literal(FCL_EXECUTION_VERSION),case_ref:z.uuid(),inquiry_no:text(80).min(1),customer_name:text().min(1),route:text(500),owner_id:id,coordinator_id:id,version,state:z.enum(['executing','completed']),acceptances:z.array(fclExecutionAcceptanceSchema).min(1).max(100),nodes:z.array(fclNodeSchema).max(7),shared:fclSharedSchema,history:z.array(fclExecutionAuditSchema).min(1).max(5000),created_at:time,updated_at:time}).strict();
// Participants receive no acceptance/contact/other-node history or financial references.
export const fclExecutionParticipantSchema=fclExecutionSchema.omit({acceptances:true,history:true}).extend({role:z.literal('participant')});
export const fclExecutionOwnerSchema=fclExecutionSchema.extend({history:z.array(fclExecutionAuditSchema).min(1).max(50),history_count:z.number().int().min(1),role:z.enum(['owner','coordinator'])});
export const fclExecutionViewSchema=z.union([fclExecutionOwnerSchema,fclExecutionParticipantSchema]);
export const fclExecutionGetSchema=z.object({case_ref:z.uuid()}).strict();
export const fclExecutionStartSchema=z.object({contract_version:z.literal(FCL_EXECUTION_VERSION),handoff:fclHandoffRequestSchema,confirmation:fclConfirmationSchema,coordinator_id:id,expected_config_version:z.number().int().nonnegative(),confirmed:z.literal(true)}).strict();
export const fclExecutionPreviewSchema=z.object({case_ref:z.uuid(),customer_name:text().min(1),route:text(500),nodes:z.array(fclNodeSchema).max(7),configuration_version:z.number().int().nonnegative(),missing_configuration:z.array(text()).max(30)}).strict();
const updateBase={contract_version:z.literal(FCL_EXECUTION_VERSION),case_ref:z.uuid(),expected_version:version};
export const fclExecutionSharedSaveSchema=z.object({...updateBase,shared:fclSharedSchema}).strict();
export const fclExecutionNodeSaveSchema=z.discriminatedUnion('node_id',nonempty(FCL_NODE_IDS.map(node_id=>z.object({...updateBase,node_id:z.literal(node_id),deadline:time.nullable(),notes:text(2000),evidence_refs:refs,fields:fclNodeFields[node_id]}).strict())));
export const fclExecutionNodeActionSchema=z.object({...updateBase,node_id:z.enum(FCL_NODE_IDS),reason,confirmed:z.literal(true)}).strict();
export const fclExecutionNodeCompleteSchema=fclExecutionNodeActionSchema.extend({handoff_node_ids:z.array(z.enum(FCL_NODE_IDS)).max(6).default([])});
export const fclExecutionNodeAssignSchema=fclExecutionNodeActionSchema.extend({assignment:fclAssignmentSchema,external:fclNotificationRowSchema.pick({external_to:true,external_cc:true,external_enabled:true,visible_fields:true}).optional()});
export const fclExecutionAmendSchema=fclExecutionStartSchema.extend({expected_version:version,reason});
export const fclExecutionDefaultsSchema=z.object({...updateBase,expected_config_version:z.number().int().nonnegative()}).strict();
export const fclExecutionDefaultsApplySchema=fclExecutionDefaultsSchema.extend({preview_digest:hash,confirmed:z.literal(true)});
export const fclExecutionDefaultsPreviewSchema=z.object({preview_digest:hash,configuration_version:z.number().int().nonnegative(),changes:z.array(z.object({node_id:z.enum(FCL_NODE_IDS),before:fclNotificationRowSchema,after:fclNotificationRowSchema}).strict()).max(7)}).strict();
export const fclExecutionListSchema=z.object({limit:z.number().int().min(1).max(50).default(20),cursor:text(500).nullable().default(null),state:z.enum(['all','executing','completed','mine']).default('all')}).strict();
export const fclExecutionListOutputSchema=z.object({items:z.array(z.object({case_ref:z.uuid(),inquiry_no:text(80),customer_name:text(),route:text(500),state:z.enum(['executing','completed']),coordinator_id:id,pending_nodes:z.array(z.enum(FCL_NODE_IDS)).max(7),deadline:time.nullable(),exception:z.boolean()}).strict()).max(50),next_cursor:text(500).nullable()}).strict();
export const fclPreExecutionNoticeSchema=z.object({owner_id:id,case_version:version,inquiry_no:text(80),customer_name:text(),route:text(500),notification:fclNotificationRowSchema,event_kind:text(80)}).strict();
export const fclOutboxSchema=z.object({pre_execution:fclPreExecutionNoticeSchema.optional(),resolutions:z.array(z.object({actor_id:id,reason,at:time,outcome:text(80)}).strict()).max(100).default([]),message_id:z.uuid(),event_id:z.uuid(),case_ref:z.uuid(),node_id:z.enum(FCL_NOTIFICATION_NODE_IDS).nullable(),cycle:version,audience:z.enum(['internal','external']),status:z.enum(['pending','sending','smtp_accepted','failed','unknown','cancelled']),assignment_digest:hash,template_version:z.literal(FCL_MAIL_TEMPLATE_VERSION),to:email,cc:z.array(email).max(10),attempts:z.number().int().min(0).max(100),lease_token:z.uuid().nullable(),lease_until:time.nullable(),result_code:text(120).nullable(),created_at:time,updated_at:time}).strict();
export const fclMailListRequestSchema=fclExecutionGetSchema.extend({limit:z.number().int().min(1).max(100).default(50),cursor:text(500).nullable().default(null)});
export const fclMailListSchema=z.object({items:z.array(fclOutboxSchema).max(100),next_cursor:text(500).nullable()}).strict();
export const fclExecutionHistoryRequestSchema=fclMailListRequestSchema;
export const fclExecutionHistorySchema=z.object({items:z.array(fclExecutionAuditSchema).max(100),next_cursor:text(500).nullable()}).strict();
export const fclMailResolveSchema=z.object({...updateBase,message_id:z.uuid(),outcome:z.enum(['confirmed_accepted','confirmed_not_sent','cancel']),reason,confirmed:z.literal(true)}).strict();
export const fclMailRetrySchema=z.object({...updateBase,message_id:z.uuid(),reason,confirmed:z.literal(true)}).strict();
export const fclNotificationPreviewRequestSchema=z.object({node_id:z.enum(FCL_NOTIFICATION_NODE_IDS),audience:z.enum(['internal','external'])}).strict();
export const fclNotificationTestSchema=fclNotificationPreviewRequestSchema.extend({expected_version:z.number().int().nonnegative(),confirmed:z.literal(true)});
export const fclNotificationPreviewOutputSchema=z.object({to:email.nullable(),cc:z.array(email).max(10),subject:text(500),body:text(8000),transport:z.enum(['unconfigured','configured_unverified']),status:z.enum(['preview','smtp_accepted','failed','unknown']),reason_code:text(120).nullable()}).strict();
export type FclExecution=z.infer<typeof fclExecutionSchema>;
export type FclNode=z.infer<typeof fclNodeSchema>;
export type FclNotificationConfig=z.infer<typeof fclNotificationV2ConfigSchema>;
export type FclNotificationRow=z.infer<typeof fclNotificationRowSchema>;
export type FclOutbox=z.infer<typeof fclOutboxSchema>;
export const emptyFclNotificationRow=(node_id:FclNotificationRow['node_id']):FclNotificationRow=>({node_id,assignment:{responsible_id:null,collaborator_ids:[],to:null,cc:[],enabled:false},template_version:FCL_MAIL_TEMPLATE_VERSION,external_to:null,external_cc:[],external_enabled:false,visible_fields:[]});
export const emptyFclNotificationConfig=():FclNotificationConfig=>({contract_version:FCL_NOTIFICATION_V2,version:0,rows:FCL_NOTIFICATION_NODE_IDS.map(emptyFclNotificationRow)});

export const fclWorkspaceListSchema=z.object({limit:z.number().int().min(1).max(50).default(25),cursor:text(500).nullable().default(null),phase:z.enum(['all','inquiry_quote','awaiting_confirmation','executing','completed']).default('all'),mine:z.boolean().default(false)}).strict();
export const fclWorkspaceListOutputSchema=z.object({items:z.array(z.object({case_ref:z.uuid(),inquiry_no:text(80),customer_name:text(),route:text(500),phase:z.enum(['inquiry_quote','awaiting_confirmation','executing','completed']),coordinator_id:id,pending_nodes:z.array(z.enum(FCL_NOTIFICATION_NODE_IDS)).max(10),deadline:time.nullable(),exception:z.boolean()}).strict()).max(50),next_cursor:text(500).nullable()}).strict();
export const fclCaseMailResolveSchema=z.object({case_ref:z.uuid(),expected_version:version,message_id:z.uuid(),outcome:z.enum(['confirmed_accepted','confirmed_not_sent','cancel']),reason,confirmed:z.literal(true)}).strict();
export const fclCaseMailRetrySchema=fclCaseMailResolveSchema.omit({outcome:true});
