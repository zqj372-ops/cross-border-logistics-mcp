import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createCustomsHistoryClient } from "../../services/access-gateway/portal/business/customs-history-client";
import type { PortalDelegationSigner } from "../../services/access-gateway/portal/business/delegation";
const signer:PortalDelegationSigner=input=>Promise.resolve({token:"fixture-delegation",claims:{iss:"https://id.invalid/",aud:"history",sub:input.subject,actor_type:input.actorType,tenant_id:input.tenantId,service_caller_id:input.serviceCallerId,application_id:input.applicationId,request_id:input.requestId,scope:input.scope,iat:Math.floor(Date.now()/1000),nbf:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,jti:"fixture-history"}});
const body={schema_version:"customs-history@2026-09-06.v1",request_id:"req_history_001",tenant_id:"tenant_a",actor_ref:"user_a",application_id:"source_app",status:"success",data:{records:[{record_ref:"history_source_001",operation:"customs.query",created_at:"2026-09-06T00:00:00Z",status:"manual_review",data_version:"snapshot_version_1"}],next_cursor:null},reason_codes:[]};
function client(fetchImpl:typeof fetch){return createCustomsHistoryClient({baseUrl:"https://customs.invalid/",tenantId:"tenant_a",serviceCallerId:"portal",applicationId:"source_app",connectionSecret:"source-connection-fixture",delegationSigner:signer,fetchImpl});}
it("reads source-owned references and rejects cross-tenant, actor and record substitution",async()=>{
  const request={actorId:"user_a",requestId:"req_history_001",action:"list" as const,input:{operation:"customs.query",limit:25}};
  expect((await client(()=>Promise.resolve(Response.json(body))).read(request)).status).toBe("success");
  for(const change of [{tenant_id:"tenant_b"},{actor_ref:"user_b"},{application_id:"source_other"}])expect((await client(()=>Promise.resolve(Response.json({...body,...change}))).read(request)).status).toBe("unavailable");
  expect((await client(()=>Promise.resolve(new Response("missing",{status:404}))).read(request)).reason_codes).toContain("customs_history_source_unavailable");
  expect((await client(()=>Promise.resolve(Response.json(body))).read({...request,input:{...request.input,tenant_id:"tenant_b"}})).status).toBe("blocked");
});

it("restores an exact source record without promoting a mismatched tax snapshot",async()=>{
  const snapshot=JSON.parse(readFileSync(new URL("fixtures/riskcustoms-tariff-estimate-success.json",import.meta.url),"utf8")) as Record<string,unknown>;
  snapshot.delegatedActor={type:"user",ref:"user_a",applicationId:"source_app"};
  const record={record_ref:"history_tax_001",operation:"customs.tax.estimate",created_at:"2026-09-06T00:00:00Z",status:"success",data_version:"snapshot_version_1"};
  const input={ruleDate:"2026-09-05",lineId:"line-1",description:"Cotton shirt",hsCode:"610510",destinationCountry:"CA",declaredValue:"100.00",currency:"CAD",attributes:{originCountry:"CN"}};
  const data={operation:"customs.tax.estimate",record,input,snapshot};
  const request={actorId:"user_a",requestId:"req_history_001",action:"get" as const,input:{operation:"customs.tax.estimate",record_ref:"history_tax_001"}};
  expect((await client(()=>Promise.resolve(Response.json({...body,data}))).read(request)).status).toBe("success");
  for(const changed of [
    {...data,record:{...record,record_ref:"another_record"}},
    {...data,record:{...record,status:"manual_review"}},
    {...data,snapshot:{...snapshot,delegatedActor:{type:"user",ref:"user_b",applicationId:"source_app"}}},
    {...data,snapshot:null},
  ])expect((await client(()=>Promise.resolve(Response.json({...body,data:changed}))).read(request)).status).toBe("unavailable");
});
