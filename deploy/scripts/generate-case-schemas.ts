import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { caseInputSchema, caseUpdateSchema, caseReplySchema, caseListSchema, caseResponseSchema } from '../../services/access-gateway/portal/cases';
for(const [name,schema] of Object.entries({input:caseInputSchema,update:caseUpdateSchema,reply:caseReplySchema,list:caseListSchema,response:caseResponseSchema})) {
 const filename=`portal-cases-${name}.schema.json`;
 writeFileSync(`schemas/access-gateway/${filename}`,JSON.stringify({...z.toJSONSchema(schema,{target:'draft-2020-12'}),$id:`https://freightclaw.local/schemas/${filename}`},null,2)+'\n');
}
