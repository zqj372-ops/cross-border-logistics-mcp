import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { inputSchema as customsInput, queryResponseSchema as customsData } from "../../services/access-gateway/portal/business/customs-client";
import { freightcomInputSchema } from "../../services/access-gateway/portal/business/freightcom-client";
import { extractDataSchema, extractInputSchema, sourceRefSchema, zoneDataSchema, zoneInputSchema } from "../../services/access-gateway/portal/business/quote-client";
import { batchInputSchema, batchResponseSchema, singleInputSchema, singleResponseSchema } from "../../services/access-gateway/portal/business/tax-client";
import { BUSINESS_OPERATIONS } from "../../services/access-gateway/portal/business-access/contracts";

type JsonObject=Record<string,unknown>;
const output=(name:string,value:JsonObject)=>writeFileSync(resolve("schemas/access-gateway",name),`${JSON.stringify(value,null,2)}\n`);

function normalize(value:unknown):void{
  if(Array.isArray(value)){value.forEach(normalize);return;}
  if(typeof value!=="object"||value===null)return;
  const item=value as JsonObject;
  delete item.$schema;
  const format=item.format;delete item.format;
  if(format==="date")item.pattern="^\\d{4}-\\d{2}-\\d{2}$";
  else if(format==="date-time")item.pattern="^\\d{4}-\\d{2}-\\d{2}T[^\\s]+$";
  else if(format==="uri"||format==="url")item.pattern="^https://[^\\s]+$";
  if(item.type==="object"){
    const additional=item.additionalProperties;
    if(typeof additional==="object"&&additional!==null){item.patternProperties={"^.+$":additional};item.additionalProperties=false;}
    else if(additional===true){item.patternProperties={"^.+$":{}};item.additionalProperties=false;}
    if(item.additionalProperties===undefined)item.additionalProperties=false;
    if(item.required===undefined)item.required=[];
  }
  if(Array.isArray(item.prefixItems)){const count=item.prefixItems.length;if(count===0)delete item.prefixItems;item.minItems=count;item.maxItems=count;item.items=false;}
  Object.values(item).forEach(normalize);
}

function jsonSchema(schema:z.ZodType):JsonObject{const result=z.toJSONSchema(schema,{unrepresentable:"any"}) as JsonObject;normalize(result);return result;}
const requestDefs={customsQueryInput:jsonSchema(customsInput),taxEstimateInput:jsonSchema(singleInputSchema),taxEstimateBatchInput:jsonSchema(batchInputSchema),quoteZonePreviewInput:jsonSchema(zoneInputSchema),quoteAiExtractInput:jsonSchema(extractInputSchema),freightcomLtlPreviewInput:jsonSchema(freightcomInputSchema)};
output("freightcom-ltl-preview-input.schema.json",{$schema:"https://json-schema.org/draft/2020-12/schema",$id:"https://freightclaw.local/schemas/freightcom-ltl-preview-input.schema.json",...requestDefs.freightcomLtlPreviewInput});
output("business-call-request.schema.json",{$schema:"https://json-schema.org/draft/2020-12/schema",$id:"https://freightclaw.local/schemas/business-call-request.schema.json",$defs:requestDefs,type:"object",additionalProperties:false,required:["schema_version","input"],properties:{schema_version:{const:"business-call@2026-09-05.v1"},input:{anyOf:Object.keys(requestDefs).map(name=>({$ref:`#/$defs/${name}`}))}}});

// The provider response contract is maintained as JSON Schema; embed its exact
// closed shape without introducing another source of response definitions.
const freightcomResponse=JSON.parse(readFileSync(resolve("schemas/access-gateway/freightcom-ltl-preview-response.schema.json"),"utf8")) as JsonObject;
normalize(freightcomResponse);
delete freightcomResponse.$id;

const error=()=>({type:"object",additionalProperties:false,required:["schema_version","status","data","reason_codes","request_id"],properties:{schema_version:{const:"business-access@2026-09-05.v1"},status:{enum:["needs_input","blocked","unavailable"]},data:{type:"null"},reason_codes:{type:"array",minItems:1,items:{type:"string"}},request_id:{type:"string",pattern:"^req_[A-Za-z0-9_-]{8,128}$"}}});
const envelope=(version:string,data:JsonObject,extra:JsonObject={})=>({type:"object",additionalProperties:false,required:["schema_version","status","data","reason_codes",...Object.keys(extra)],properties:{schema_version:{const:version},status:{enum:["success","needs_input","manual_review","blocked","unavailable"]},data:{anyOf:[data,{type:"null"}]},reason_codes:{type:"array",items:{type:"string"}},...extra}});
const quoteExtra={source_schema_version:{const:"quote-preview@2026-09-05.v2"},source_refs:{type:"array",items:jsonSchema(sourceRefSchema)},request_id:{type:"string"},preview_only:{const:true},saved:{const:false},sendable:{const:false}};
const response:JsonObject & {anyOf:JsonObject[]}={$schema:"https://json-schema.org/draft/2020-12/schema",$id:"https://freightclaw.local/schemas/business-call-response.schema.json",anyOf:[envelope("portal-customs@2026-09-05.v1",jsonSchema(customsData)),envelope("portal-tax@2026-09-05.v1",jsonSchema(singleResponseSchema),{request_id:{type:"string"}}),envelope("portal-tax@2026-09-05.v1",jsonSchema(batchResponseSchema),{request_id:{type:"string"}}),envelope("portal-quote@2026-09-05.v1",jsonSchema(zoneDataSchema),quoteExtra),envelope("portal-quote@2026-09-05.v1",jsonSchema(extractDataSchema),quoteExtra),{type:"object",additionalProperties:false,required:["schema_version","status","data","reason_codes"],properties:{schema_version:{const:"portal-business@2026-09-05.v1"},status:{enum:["blocked","unavailable"]},data:{type:"null"},reason_codes:{type:"array",items:{type:"string"}}}},error()]};
response.anyOf.push(freightcomResponse);
output("business-call-response.schema.json",response);

const operations={type:"array",minItems:1,maxItems:BUSINESS_OPERATIONS.length,uniqueItems:true,items:{enum:BUSINESS_OPERATIONS}};
output("business-exchange-request.schema.json",{$schema:"https://json-schema.org/draft/2020-12/schema",$id:"https://freightclaw.local/schemas/business-exchange-request.schema.json",type:"object",additionalProperties:false,required:["schema_version","requested_operations"],properties:{schema_version:{const:"business-exchange@2026-09-05.v1"},requested_operations:operations}});
const exchangeSuccess={type:"object",additionalProperties:false,required:["schema_version","status","data","reason_codes"],properties:{schema_version:{const:"business-access@2026-09-05.v1"},status:{const:"success"},data:{type:"object",additionalProperties:false,required:["access_token","token_type","expires_in","operations"],properties:{access_token:{type:"string",minLength:1},token_type:{const:"Bearer"},expires_in:{type:"integer",minimum:60,maximum:300},operations}},reason_codes:{type:"array",items:{type:"string"}}}};
output("business-exchange-response.schema.json",{$schema:"https://json-schema.org/draft/2020-12/schema",$id:"https://freightclaw.local/schemas/business-exchange-response.schema.json",anyOf:[exchangeSuccess,error()]});
