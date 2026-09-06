import { z } from "zod";
import { readBoundedResponse } from "../../../../src/logistics_mcp/platform/bounded-response";
import { inputSchema as queryInputSchema, queryResponseSchema } from "./customs-client";
import { singleInputSchema, singleResponseSchema } from "./tax-client";
import type { PortalDelegationSigner } from "./delegation";
const ref=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const operation=z.enum(["customs.query","customs.tax.estimate"]);
const status=z.enum(["success","needs_input","manual_review","blocked","unavailable"]);
export const customsHistoryListInput=z.object({operation,limit:z.number().int().min(1).max(100).default(25),cursor:z.string().min(1).max(512).optional()}).strict();
export const customsHistoryGetInput=z.object({operation,record_ref:ref}).strict();
export const customsHistoryRecordSchema=z.object({record_ref:ref,operation,created_at:z.string().datetime({offset:true}),status,data_version:ref}).strict();
const envelope=z.object({schema_version:z.literal("customs-history@2026-09-06.v1"),request_id:ref,tenant_id:ref,actor_ref:ref,application_id:ref,status,data:z.unknown(),reason_codes:z.array(ref).max(20)}).strict();
export const customsHistoryListResponse=envelope.extend({data:z.object({records:z.array(customsHistoryRecordSchema).max(100),next_cursor:z.string().min(1).max(512).nullable()}).strict().nullable()});
export const customsHistoryGetResponse=envelope.extend({data:z.discriminatedUnion("operation",[
  z.object({operation:z.literal("customs.query"),record:customsHistoryRecordSchema,input:queryInputSchema,snapshot:queryResponseSchema.nullable()}).strict(),
  z.object({operation:z.literal("customs.tax.estimate"),record:customsHistoryRecordSchema,input:singleInputSchema,snapshot:singleResponseSchema.nullable()}).strict(),
]).nullable()});
export function createCustomsHistoryClient(options:{baseUrl:string;tenantId:string;serviceCallerId:string;applicationId:string;connectionSecret:string;delegationSigner:PortalDelegationSigner;fetchImpl?:typeof fetch;allowLoopbackFixtures?:boolean}){
  const base=new URL(options.baseUrl);
  if(base.username||base.password||base.search||base.hash||base.pathname!=="/"||base.protocol!=="https:"&&!(options.allowLoopbackFixtures&&base.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(base.hostname)))throw new Error("customs_history_config_invalid");
  const failure=(state:"blocked"|"unavailable",code:string)=>({schema_version:"portal-business@2026-09-05.v1",status:state,data:null,reason_codes:[code]});
  return {async read(request:{actorId:string;requestId:string;action:"list"|"get";input:unknown}){
    const parsed=(request.action==="list"?customsHistoryListInput:customsHistoryGetInput).safeParse(request.input);
    if(!parsed.success||!ref.safeParse(request.actorId).success||!ref.safeParse(request.requestId).success)return failure("blocked","customs_history_input_invalid");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try {
      const signed=await options.delegationSigner({subject:request.actorId,actorType:"user",tenantId:options.tenantId,serviceCallerId:options.serviceCallerId,applicationId:options.applicationId,requestId:request.requestId,scope:"customs.history.read"});
      if(!signed.token||signed.claims.service_caller_id!==options.serviceCallerId||!Number.isSafeInteger(signed.claims.iat)||!Number.isSafeInteger(signed.claims.exp)||signed.claims.nbf>Math.floor(Date.now()/1000)+30||signed.claims.iat>Math.floor(Date.now()/1000)+30||signed.claims.sub!==request.actorId||signed.claims.tenant_id!==options.tenantId||signed.claims.application_id!==options.applicationId||signed.claims.request_id!==request.requestId||signed.claims.scope!=="customs.history.read"||signed.claims.actor_type!=="user"||signed.claims.exp<=Date.now()/1000||signed.claims.exp-signed.claims.iat>300)throw new Error("delegation_mismatch");
      const response=await (options.fetchImpl??fetch)(new URL(`/api/m2m/v2/history/${request.action}`,base),{method:"POST",redirect:"error",signal:controller.signal,headers:{authorization:`Bearer ${options.connectionSecret}`,"x-tenant-id":options.tenantId,"x-freightclaw-delegation":signed.token,"content-type":"application/json"},body:JSON.stringify({schema_version:"customs-history-request@2026-09-06.v1",...parsed.data})});
      if(!response.ok||!response.headers.get("content-type")?.includes("application/json"))throw new Error("source_unavailable");
      const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await readBoundedResponse(response,2*1024*1024,controller.signal))) as unknown;
      const result=(request.action==="list"?customsHistoryListResponse:customsHistoryGetResponse).parse(raw);
      if(result.request_id!==request.requestId||result.tenant_id!==options.tenantId||result.actor_ref!==request.actorId||result.application_id!==options.applicationId)throw new Error("source_identity_mismatch");
      if(result.status!=="success"){if(result.data!==null)throw new Error("source_failed_data");return result;}
      if(!result.data)throw new Error("source_missing_data");
      if("records" in result.data){if(result.data.records.length>("limit" in parsed.data?parsed.data.limit:0)||result.data.records.some(x=>x.operation!==parsed.data.operation)||new Set(result.data.records.map(x=>x.record_ref)).size!==result.data.records.length)throw new Error("source_list_mismatch");}
      else {
        const data=result.data;
        if(!("record_ref" in parsed.data)||data.record.record_ref!==parsed.data.record_ref||data.operation!==parsed.data.operation||data.record.operation!==data.operation)throw new Error("source_record_mismatch");
        if(data.snapshot&&(data.snapshot.delegatedActor.type!=="user"||data.snapshot.delegatedActor.ref!==request.actorId||data.snapshot.delegatedActor.applicationId!==options.applicationId))throw new Error("source_snapshot_identity_mismatch");
        if(data.snapshot&&data.operation==="customs.tax.estimate"&&data.record.status!==data.snapshot.status)throw new Error("source_snapshot_status_mismatch");
        if(data.snapshot&&data.operation==="customs.query"){
          const snapshotStatus=data.snapshot.nextQuestion?"needs_input":[...data.snapshot.candidates,...data.snapshot.results].some(item=>item.status==="manual_review")?"manual_review":"success";
          if(data.record.status!==snapshotStatus)throw new Error("source_snapshot_status_mismatch");
        }
        if(data.record.status==="success"&&!data.snapshot)throw new Error("source_snapshot_missing");
      }
      return result;
    }catch{return failure("unavailable","customs_history_source_unavailable");}finally{clearTimeout(timer);}
  }};
}
