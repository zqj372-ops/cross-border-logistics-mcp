import {it,expect} from 'vitest';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {z} from 'zod';
import {quoteDocumentSchemas,outputSchemas} from '../../services/quote-documents/contracts';
it('compiles all input/output Draft 2020-12 schemas and closes object fields',()=>{const ajv=new Ajv({strict:false});addFormats(ajv);for(const schema of Object.values({...quoteDocumentSchemas,...Object.fromEntries(Object.entries(outputSchemas).map(([k,v])=>[k+'-output',v]))})){const json=z.toJSONSchema(schema,{target:'draft-2020-12'});expect(json.$schema).toBe('https://json-schema.org/draft/2020-12/schema');expect(()=>ajv.compile(json)).not.toThrow();expect(json.additionalProperties).toBe(false);}});
