import {it,expect} from 'vitest';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {quoteDocumentSchemas,outputSchemas,linkedResponseSchemas,V2_VERSION} from '../../services/quote-documents/contracts';
const directory=fileURLToPath(new URL('../../schemas/admin-control/quote-documents/',import.meta.url));
const files=(pattern:RegExp)=>readdirSync(directory).filter(file=>pattern.test(file)).sort();
const v2Inputs=files(/-v2\.schema\.json$/u),v2Responses=files(/-v2-response\.schema\.json$/u);
const read=(file:string)=>JSON.parse(readFileSync(join(directory,file),'utf8')) as Record<string,unknown>;
function compile(file:string){const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);return ajv.compile(read(file));}
function assertClosed(value:unknown,path='schema'):void{
 if(Array.isArray(value)){value.forEach((item,index)=>assertClosed(item,`${path}[${index}]`));return;}
 if(typeof value!=='object'||value===null)return;
 const record=value as Record<string,unknown>;
 if(record.type==='object'&&record.properties!==undefined)expect(record.additionalProperties,`${path} must be closed`).toBe(false);
 Object.entries(record).forEach(([key,item])=>assertClosed(item,`${path}.${key}`));
}
it('compiles all input/output Draft 2020-12 schemas and closes object fields',()=>{const ajv=new Ajv({strict:false});addFormats(ajv);for(const schema of Object.values({...quoteDocumentSchemas,...Object.fromEntries(Object.entries(outputSchemas).map(([k,v])=>[k+'-output',v]))})){const json=z.toJSONSchema(schema,{target:'draft-2020-12'});expect(json.$schema).toBe('https://json-schema.org/draft/2020-12/schema');expect(()=>ajv.compile(json)).not.toThrow();expect(json.additionalProperties).toBe(false);}});
it('ships the versioned v2 input and response schemas as closed Draft 2020-12 contracts',()=>{
 expect(v2Inputs).toHaveLength(7);
 expect(v2Responses).toHaveLength(8);
 for(const file of [...v2Inputs,...v2Responses]){const schema=read(file);expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');expect(()=>compile(file)).not.toThrow();assertClosed(schema,file);}
 const list=compile('list-v2-response.schema.json');
 expect(list({schema_version:V2_VERSION,status:'success',data:{items:[],next_cursor:null},reason_codes:[]})).toBe(true);
 expect(list({schema_version:V2_VERSION,status:'success',data:{items:[],next_cursor:null},reason_codes:[],extra:true})).toBe(false);
 expect(list({schema_version:'quote-documents@2026-09-08.v1',status:'success',data:{items:[],next_cursor:null},reason_codes:[]})).toBe(false);
 const get=compile('get-v2.schema.json');
 expect(get({contract_version:'inquiry-quote-link@2026-09-13.v1',id:'00000000-0000-4000-8000-000000000001'})).toBe(true);
 expect(get({contract_version:'inquiry-quote-link@2026-09-13.v1',id:'00000000-0000-4000-8000-000000000001',case_ref:'00000000-0000-4000-8000-000000000002'})).toBe(false);
});
it('allows exactly the approved manual review additions for approve (document_expired) and export (version_conflict)',()=>{
 const approve=compile('approve-v2-response.schema.json'),exported=compile('export-v2-response.schema.json');
 const manual=(code:string)=>({schema_version:V2_VERSION,status:'manual_review',data:null,reason_codes:[code]});
 expect(approve(manual('document_expired'))).toBe(true);
 expect(approve(manual('inquiry_quote_case_review_required'))).toBe(true);
 expect(approve(manual('version_conflict'))).toBe(false);
 expect(exported(manual('version_conflict'))).toBe(true);
 expect(exported(manual('inquiry_quote_export_expired'))).toBe(true);
 expect(exported(manual('document_expired'))).toBe(false);
 expect(linkedResponseSchemas.approve?.safeParse(manual('document_expired')).success).toBe(true);
 expect(linkedResponseSchemas.approve?.safeParse(manual('version_conflict')).success).toBe(false);
 expect(linkedResponseSchemas.export?.safeParse(manual('version_conflict')).success).toBe(true);
 expect(linkedResponseSchemas.export?.safeParse(manual('document_expired')).success).toBe(false);
 expect(linkedResponseSchemas.approve?.safeParse({...manual('document_expired'),data:{id:'00000000-0000-4000-8000-000000000001'}}).success).toBe(false);
});
