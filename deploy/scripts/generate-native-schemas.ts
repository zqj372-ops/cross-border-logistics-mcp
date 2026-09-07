import { z } from 'zod';
import { writeFileSync,mkdirSync } from 'node:fs';
import { nativeSchemas } from '../../services/access-gateway/portal/native-admin-contracts';
mkdirSync('schemas/admin-control/native-business',{recursive:true});
for(const [name,schema]of Object.entries(nativeSchemas))writeFileSync(`schemas/admin-control/native-business/${name}.schema.json`,JSON.stringify(z.toJSONSchema(schema,{target:'draft-2020-12'}),null,2)+'\n');
console.log(`Generated ${Object.keys(nativeSchemas).length} native administration schemas.`);
