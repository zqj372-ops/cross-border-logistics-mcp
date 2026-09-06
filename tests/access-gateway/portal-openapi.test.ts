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
 expect(Object.keys(paths)).toHaveLength(17);
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
 const businessMcp=ajv.compile({$ref:"https://test.invalid/openapi#/paths/~1access~1v2~1application~1mcp~1token~1exchange/post/requestBody/content/application~1json/schema"});
 const request={schema_version:"application-mcp-exchange@2026-09-06.v1",requested_tool_names:["cargo.calculate","customs.query"]};
 expect(businessMcp(request)).toBe(true);expect(businessMcp({...request,tenant_id:"other"})).toBe(false);expect(businessMcp({...request,requested_tool_names:["customs.query","customs.query"]})).toBe(false);
 const historyResult=ajv.compile({$ref:"https://test.invalid/openapi#/paths/~1console~1api~1v1~1business~1customs~1history~1list/post/responses/200/content/application~1json/schema"});
 expect(historyResult({schema_version:"portal-business@2026-09-05.v1",status:"unavailable",data:null,reason_codes:["customs_history_source_unconfigured"]})).toBe(true);
 const mcpError=ajv.compile({$ref:"https://test.invalid/openapi#/paths/~1access~1v2~1application~1mcp~1token~1exchange/post/responses/403/content/application~1json/schema"});
 expect(mcpError({schema_version:"application-mcp-access@2026-09-06.v1",status:"blocked",data:null,reason_codes:["business_access_denied"]})).toBe(true);
});
