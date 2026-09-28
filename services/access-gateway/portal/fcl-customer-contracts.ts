import {z} from 'zod';
import {fclHandoffRequestSchema,fclDocumentCustomerTotalsSchema,fclDocumentScopeSchema,fclDocumentTemplateSchema} from '../../quote-documents/fcl-contracts';
import {draftDocumentSchema} from '../../quote-documents/workflow-contracts';
const ref=z.object({case_ref:z.uuid()}).strict();
export const customerClaimSchema=z.object({inquiry_id:z.uuid(),credential:z.string().min(32).max(256)}).strict();
export const customerConfirmSchema=ref.extend({offer_id:z.uuid(),confirmed:z.literal(true)});
export const customerPublishSchema=z.object({handoff:fclHandoffRequestSchema}).strict();
export const customerOfferSchema=z.object({offer_id:z.uuid(),document_version:z.number().int().positive(),document:draftDocumentSchema,scope:z.array(fclDocumentScopeSchema.omit({included_row_refs:true})).max(6),issuer:fclDocumentTemplateSchema,totals:fclDocumentCustomerTotalsSchema,published_at:z.iso.datetime()}).strict();
export const customerCaseSchema=ref.extend({inquiry_no:z.string(),state:z.enum(['inquiry','awaiting_customer','awaiting_acceptance','executing','completed','ended']),offer:customerOfferSchema.nullable(),events:z.array(z.object({message:z.string(),at:z.iso.datetime()}).strict()).max(5000),nodes:z.array(z.object({id:z.string(),status:z.string(),completed_at:z.iso.datetime({offset:true}).nullable()}).strict()).max(7)});
export const customerListSchema=z.object({limit:z.number().int().min(1).max(50).default(20),before:z.number().int().positive().nullable().default(null)}).strict();
export const customerListOutput=z.object({items:z.array(customerCaseSchema).max(50),next_before:z.number().int().positive().nullable()}).strict();
export const customerRoutes={
 'customer-claim':[customerClaimSchema,customerCaseSchema,true,'关联本人询价'],
 'customer-list':[customerListSchema,customerListOutput,false,'查看本人业务'],
 'customer-get':[ref,customerCaseSchema,false,'查看本人业务详情'],
 'customer-pdf':[ref.extend({offer_id:z.uuid()}),z.object({filename:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),content_base64:z.string().max(11184812)}).strict(),false,'下载本人已发布的报价单'],
 'customer-confirm':[customerConfirmSchema,customerCaseSchema,true,'确认报价并提交委托'],
 'customer-quote-publish':[customerPublishSchema,customerOfferSchema,true,'发布正式报价并通知客户'],
 'customer-order-accept':[customerConfirmSchema,customerCaseSchema,true,'接受客户委托并转执行'],
 'customer-order-get':[ref,customerCaseSchema,false,'查看客户确认与接单状态'],
} as const;
export type CustomerAction=keyof typeof customerRoutes;
export const CUSTOMER_ACTIONS=['customer-claim','customer-list','customer-get','customer-confirm','customer-pdf'];
