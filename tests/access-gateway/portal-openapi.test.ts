import { expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { generatePortalOpenApi } from "../../deploy/scripts/generate-portal-openapi";

it("publishes self-contained operation-specific machine schemas and rejects mixed identity input",()=>{
 const document=generatePortalOpenApi();
 const refs:string[]=[];
 const visit=(value:unknown)=>{if(Array.isArray(value)){value.forEach(visit);return;}if(typeof value!=="object"||value===null)return;for(const [key,item] of Object.entries(value)){if(key==="$ref"){expect(typeof item).toBe("string");refs.push(String(item));}else visit(item);}};
 visit(document);
 for(const ref of refs){expect(ref.startsWith("#/components/schemas/")).toBe(true);let value:unknown=document;for(const part of ref.slice(2).split("/")){value=(value as Record<string,unknown>)[part];}expect(value,ref).toBeDefined();}
 const paths=document.paths as Record<string,{post?:{requestBody:{content:{"application/json":{schema:unknown}}}}}>;
 expect(Object.keys(paths)).toHaveLength(13);
 const ajv=new Ajv2020({strict:false});addFormats(ajv);
 ajv.addSchema({...document,$id:"https://test.invalid/openapi"});
 const pointer="https://test.invalid/openapi#/paths/~1api~1v2~1business~1customs~1query/post/requestBody/content/application~1json/schema";
 const validate=ajv.compile({$ref:pointer});
 const input={schema_version:"business-call@2026-09-05.v1",input:{query:"水杯",ruleDate:"2026-09-05",attributes:{originCountry:"CN"}}};
 expect(validate(input)).toBe(true);
 expect(validate({...input,tenant_id:"another-tenant"})).toBe(false);
 expect(validate({...input,input:{customer_message:"wrong operation"}})).toBe(false);
 const freightcom=ajv.compile({$ref:"https://test.invalid/openapi#/paths/~1api~1v2~1business~1quote~1freightcom-ltl-preview/post/requestBody/content/application~1json/schema"});
 expect(freightcom(input)).toBe(false);
 const t0=paths["/api/v2/tools/cargo.calculate"]!.post!.requestBody.content["application/json"].schema as {$ref:string};
 expect(t0.$ref).toBe("#/components/schemas/cargo_calculate");
 const applicationExchange=paths["/access/v2/application/token/exchange"]!.post!.requestBody.content["application/json"].schema as {$ref:string};
 expect(applicationExchange.$ref).toBe("#/components/schemas/AccessApplicationExchangeRequest");
 const validateApplicationExchange=ajv.compile({$ref:"https://test.invalid/openapi#/paths/~1access~1v2~1application~1token~1exchange/post/requestBody/content/application~1json/schema"});
 expect(validateApplicationExchange({schema_version:"application-exchange@2026-09-06.v1",requested_tool_names:["cargo.calculate"]})).toBe(true);
 expect(validateApplicationExchange({schema_version:"application-exchange@2026-09-06.v1",requested_tool_names:["quote.zone_preview"]})).toBe(false);
});
