import {maritimeDatasetSchema,maritimeQuerySchema,maritimeResponseSchema} from '../../services/maritime/contracts';
import {packageSchemas} from '../../services/customs-native/package-contracts';
import {quoteDocumentSchemas,outputSchemas,quoteDocumentSchemasV2,linkedResponseSchemas,linkedErrorEnvelopeSchema} from '../../services/quote-documents/contracts';
import {workflowRequestSchemas,workflowOutputSchemas,workflowErrorEnvelopeSchema} from '../../services/quote-documents/workflow-contracts';
import {fclDocumentSchemas} from '../../services/quote-documents/fcl-contracts';
import {fclNotificationSchemas} from '../../services/access-gateway/portal/native-admin-contracts';
import {fclHttpRequestSchemas,fclHttpResponseSchemas,fclPublicOutputSchemas} from '../../services/access-gateway/portal/fcl-http-contracts';
import {fclQuoteSchemas,fclQuoteCostSellSchemas} from '../../services/quote-native/fcl-contracts';
import { z } from 'zod';
import { writeFileSync,mkdirSync } from 'node:fs';
import { nativeSchemas } from '../../services/access-gateway/portal/native-admin-contracts';
mkdirSync('schemas/admin-control/native-business',{recursive:true});
for(const [name,schema]of Object.entries(nativeSchemas))writeFileSync(`schemas/admin-control/native-business/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
console.log(`Generated ${Object.keys(nativeSchemas).length} native administration schemas.`);

mkdirSync('schemas/admin-control/quote-documents',{recursive:true});
for(const [name,schema] of Object.entries({...quoteDocumentSchemas,...Object.fromEntries(Object.entries(outputSchemas).map(([key,value])=>[key+'-output',value]))}))writeFileSync(`schemas/admin-control/quote-documents/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
for(const [name,schema] of Object.entries({...quoteDocumentSchemasV2,...Object.fromEntries(Object.entries(linkedResponseSchemas).map(([key,value])=>[key+'-v2-response',value])),'linked-error-v2-response':linkedErrorEnvelopeSchema}))writeFileSync(`schemas/admin-control/quote-documents/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
for(const [name,schema] of Object.entries({...Object.fromEntries(Object.entries(workflowRequestSchemas).map(([key,value])=>[`${key}-v3-request`,value])),...Object.fromEntries(Object.entries(workflowOutputSchemas).map(([key,value])=>[`${key}-v3-output`,value])),'workflow-error-v3-response':workflowErrorEnvelopeSchema}))writeFileSync(`schemas/admin-control/quote-documents/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
for(const [name,schema] of Object.entries(fclQuoteSchemas))writeFileSync(`schemas/admin-control/quote-documents/fcl-quote-${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
for(const [name,schema] of Object.entries(fclQuoteCostSellSchemas))writeFileSync(`schemas/admin-control/quote-documents/fcl-quote-${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
for(const [name,schema] of Object.entries(fclDocumentSchemas))writeFileSync(`schemas/admin-control/quote-documents/fcl-${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
for(const [name,schema] of Object.entries(fclNotificationSchemas))writeFileSync(`schemas/admin-control/native-business/fcl-notification-${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
mkdirSync('schemas/access-gateway/fcl',{recursive:true});
for(const [name,schema] of Object.entries(fclHttpRequestSchemas))writeFileSync(`schemas/access-gateway/fcl/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
for(const [name,schema] of Object.entries(fclHttpResponseSchemas))writeFileSync(`schemas/access-gateway/fcl/${name}-response.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
for(const [name,schema] of Object.entries(fclPublicOutputSchemas))writeFileSync(`schemas/access-gateway/fcl/public-${name}-response.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');

mkdirSync('schemas/admin-control/customs-packages',{recursive:true});for(const [name,schema] of Object.entries(packageSchemas))writeFileSync(`schemas/admin-control/customs-packages/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');

mkdirSync('schemas/admin-control/maritime',{recursive:true});
for(const kind of ['schedules','terminals'] as const)for(const [name,schema] of Object.entries({dataset:maritimeDatasetSchema(kind),query:maritimeQuerySchema(kind),response:maritimeResponseSchema(kind)}))writeFileSync(`schemas/admin-control/maritime/${kind}-${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
