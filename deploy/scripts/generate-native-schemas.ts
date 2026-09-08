import {maritimeDatasetSchema,maritimeQuerySchema,maritimeResponseSchema} from '../../services/maritime/contracts';
import {packageSchemas} from '../../services/customs-native/package-contracts';
import {quoteDocumentSchemas,outputSchemas} from '../../services/quote-documents/contracts';
import { z } from 'zod';
import { writeFileSync,mkdirSync } from 'node:fs';
import { nativeSchemas } from '../../services/access-gateway/portal/native-admin-contracts';
mkdirSync('schemas/admin-control/native-business',{recursive:true});
for(const [name,schema]of Object.entries(nativeSchemas))writeFileSync(`schemas/admin-control/native-business/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
console.log(`Generated ${Object.keys(nativeSchemas).length} native administration schemas.`);

mkdirSync('schemas/admin-control/quote-documents',{recursive:true});
for(const [name,schema] of Object.entries({...quoteDocumentSchemas,...Object.fromEntries(Object.entries(outputSchemas).map(([key,value])=>[key+'-output',value]))}))writeFileSync(`schemas/admin-control/quote-documents/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');

mkdirSync('schemas/admin-control/customs-packages',{recursive:true});for(const [name,schema] of Object.entries(packageSchemas))writeFileSync(`schemas/admin-control/customs-packages/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');

mkdirSync('schemas/admin-control/maritime',{recursive:true});
for(const kind of ['schedules','terminals'] as const)for(const [name,schema] of Object.entries({dataset:maritimeDatasetSchema(kind),query:maritimeQuerySchema(kind),response:maritimeResponseSchema(kind)}))writeFileSync(`schemas/admin-control/maritime/${kind}-${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
