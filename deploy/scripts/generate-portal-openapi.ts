import {maritimeSaveSchema,maritimeQuerySchema,maritimeResponseSchema} from '../../services/maritime/contracts';
import {nativeResponseSchema,nativeDataSchema,nativePublishSchema,nativeDisableSchema,nativeRollbackSchema} from '../../services/access-gateway/portal/native-admin-contracts';
import {packageSchemas,packageList} from '../../services/customs-native/package-contracts';
import {quoteDocumentSchemas,outputSchemas,responseSchema as documentResponseSchema} from '../../services/quote-documents/contracts';
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { cargoToolContract } from "../../src/logistics_mcp/domains/cargo/tool";
import { containerPlanSummaryToolContract } from "../../src/logistics_mcp/domains/container/service";
import { agentContextToolContract } from "../../src/logistics_mcp/agent-context/runtime";

type ObjectValue = Record<string, unknown>;
export function generatePortalOpenApi(): ObjectValue {
  const schemas: Record<string, ObjectValue> = {};
  const names = new Map<string, string>();
  const inputs: {name:string;path:string;schema:ObjectValue}[] = [];
  for (const directory of ["docs/contracts/schemas", "schemas/access-gateway"]){
    for (const file of readdirSync(directory).filter(name=>name.endsWith(".schema.json"))){
      if(directory.endsWith("access-gateway")&&!/^(?:application-(?:mcp-)?exchange-(?:request|response)|portal-call-(?:query|page|event)|customs-history-(?:list|get)-(?:request|response)|business-(?:call|exchange)-(?:request|response)|exchange-(?:request|response)|error-envelope|jwks-response)\./u.test(file))continue;
      const schema=JSON.parse(readFileSync(resolve(directory,file),"utf8")) as ObjectValue;
      const name=`${directory.endsWith("access-gateway")?"Access":"Domain"}${file.replace(/\.schema\.json$/u,"").split("-").map(part=>part[0]!.toUpperCase()+part.slice(1)).join("")}`;
      inputs.push({name,path:resolve(directory,file),schema});names.set(String(schema.$id),name);names.set(resolve(directory,file),name);
    }
  }
  const agentSchemaPath=resolve("schemas/agent-context-envelope.schema.json");
  const agentSchema=JSON.parse(readFileSync(agentSchemaPath,"utf8")) as ObjectValue;
  inputs.push({name:"AgentContextEnvelope",path:agentSchemaPath,schema:agentSchema});
  names.set(String(agentSchema.$id),"AgentContextEnvelope");names.set(agentSchemaPath,"AgentContextEnvelope");
  const rewrite=(value:unknown,origin:typeof inputs[number]):unknown=>{
    if(Array.isArray(value))return value.map(item=>rewrite(item,origin));
    if(typeof value!=="object"||value===null)return value;
    const result:ObjectValue={};
    for(const [key,entry] of Object.entries(value)){
      if(key==="$id"||key==="$schema")continue;
      if(key==="$ref"&&typeof entry==="string"){
        const [file,fragment]=entry.split("#");
        const target=file?(names.get(file)??names.get(resolve(origin.path,"..",file))):origin.name;
        if(!target)throw new Error(`Unresolved public API schema: ${entry}`);
        result[key]=`#/components/schemas/${target}${fragment??""}`;
      }else result[key]=rewrite(entry,origin);
    }
    return result;
  };
  for(const input of inputs)schemas[input.name]=rewrite(input.schema,input) as ObjectValue;
  schemas.BusinessError=(schemas.AccessBusinessExchangeResponse!.anyOf as ObjectValue[])[1]!;
  schemas.ApplicationMcpError=(schemas.AccessApplicationMcpExchangeResponse!.anyOf as ObjectValue[])[1]!;
  schemas.PortalBusinessError={type:"object",additionalProperties:false,required:["schema_version","status","data","reason_codes"],properties:{schema_version:{const:"portal-business@2026-09-05.v1"},status:{enum:["blocked","unavailable"]},data:{type:"null"},reason_codes:{type:"array",items:{type:"string"}}}};
  schemas.PortalError={type:"object",additionalProperties:false,required:["schema_version","status","data","reason_codes","request_id"],properties:{schema_version:{const:"portal@2026-09-05.v1"},status:{enum:["needs_input","blocked","unavailable"]},data:{type:"null"},reason_codes:{type:"array",items:{type:"string"}},request_id:{type:"string"}}};
  schemas.T0RestError={type:"object",additionalProperties:false,required:["schema_version","status","data","reason_codes"],properties:{schema_version:{const:"portal-t0-rest@2026-09-05.v1"},status:{const:"blocked"},data:{type:"null"},reason_codes:{type:"array",items:{type:"string"}}}};
  const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
  const paths:Record<string,unknown>={};
  const response=(schema:unknown)=>({description:"操作结果；业务状态及来源版本以响应为准。",content:{"application/json":{schema}}});
  const post=(path:string,id:string,summary:string,request:unknown,result:unknown,security:string|readonly string[],description:string)=>{
    const error=ref(path.startsWith("/console/")?"PortalError":path.includes("/application/mcp/")?"ApplicationMcpError":path.includes("/business/")?"BusinessError":"T0RestError");
    const securityOptions=(typeof security==="string"?[security]:security).map(name=>({[name]:[]}));
    paths[path]={post:{operationId:id,summary,description,security:securityOptions,...(path.startsWith("/console/")?{parameters:[{name:"X-CSRF-Token",in:"header",required:true,schema:{type:"string"}}]}:{}),requestBody:{required:true,content:{"application/json":{schema:request}}},responses:{"200":response(result),"400":response(error),"401":response(error),"403":response(error),"503":response(error)}}};
  };
  post("/access/v2/business/token/exchange","exchangeBusinessToken","业务 API 换取短期令牌",ref("AccessBusinessExchangeRequest"),ref("AccessBusinessExchangeResponse"),"ApplicationKey","Authorization: ApiKey <长期业务 Key>。最多300秒；只授予当前批准且生效的操作。");
  const businessDefs=(schemas.AccessBusinessCallRequest!.$defs as ObjectValue);
  for(const [suffix,id,title,input] of [
    ["customs/query","queryCustoms","关税与归类查询","customsQueryInput"],
    ["customs/tax-estimate","estimateTax","单项税费估算","taxEstimateInput"],
    ["customs/tax-estimates/batch","estimateTaxBatch","批量税费估算（最多20项）","taxEstimateBatchInput"],
    ["quote/zone-preview","previewQuote","加拿大尾程试算","quoteZonePreviewInput"],
    ["quote/ai-extract-preview","extractQuoteInput","询价资料提取","quoteAiExtractInput"],
    ["quote/freightcom-ltl-preview","previewFreightcomRate","Freightcom LTL 承运商询价","freightcomLtlPreviewInput"],
  ]){
    if(!businessDefs[input!])throw new Error("Missing operation input schema");
    post(`/api/v2/business/${suffix}`,id!,title!,{type:"object",additionalProperties:false,required:["schema_version","input"],properties:{schema_version:{const:"business-call@2026-09-05.v1"},input:ref(`AccessBusinessCallRequest/$defs/${input}`)}},ref("AccessBusinessCallResponse"),["ApplicationKey","BearerToken"],"可直接使用统一应用 Key，也可使用兼容的业务短令牌。权限由服务端校验，客户端不能指定企业或操作者。试算不会保存、发送或批准正式报价。");
  }
  post("/access/v2/tools/token/exchange","exchangeToolsToken","基础工具换取短期令牌",ref("AccessExchangeRequest"),ref("AccessExchangeResponse"),"ApplicationKey","使用已交付的基础工具 Key，令牌 audience 为 freightclaw-t0-rest-v2。旧 MCP audience 保持独立。");
  post("/access/v2/application/token/exchange","exchangeApplicationMcpToken","统一应用 Key 换取 MCP 短期令牌",ref("AccessApplicationExchangeRequest"),ref("AccessApplicationExchangeResponse"),"ApplicationKey","使用已交付的 flcbk 应用 Key，令牌仅用于当前批准的 MCP T0 工具，audience 为 logistics MCP。");
  post("/access/v2/application/mcp/token/exchange","exchangeBusinessMcpToken","统一应用 Key 换取八项 MCP 能力令牌",ref("AccessApplicationMcpExchangeRequest"),ref("AccessApplicationMcpExchangeResponse"),"ApplicationKey","使用显式 business-v1 profile；最多300秒，只包含当前授权操作。用返回 Bearer 连接 /mcp。工具当前是否启用由签名模块发布控制。");
  paths["/console/api/v1/calls"]={get:{operationId:"listOwnCalls",summary:"当前企业的调用记录与用量",security:[{PortalSession:[]}],parameters:Object.entries((schemas.AccessPortalCallQuery!.properties as ObjectValue)).map(([name,schema])=>({in:"query",name,required:false,schema})),responses:{"200":response(ref("AccessPortalCallPage")),"400":response(ref("PortalError")),"401":response(ref("PortalError")),"403":response(ref("PortalError")),"503":response(ref("PortalError"))}}};
  for(const action of ["list","get"])post(`/console/api/v1/business/customs/history/${action}`,`customsHistory${action}`,action==="list"?"关务来源历史列表":"恢复关务来源历史",{type:"object",additionalProperties:false,required:["input"],properties:{input:ref(`AccessCustomsHistory${action==="list"?"List":"Get"}Request`)}},{anyOf:[ref(`AccessCustomsHistory${action==="list"?"List":"Get"}Response`),ref("PortalBusinessError")]},"PortalSession","仅人员会话和CSRF；来源历史合同尚须适配验证。历史快照不代表当前税率。");
  for(const [tool,title,contract] of [["cargo.calculate","货物计算",cargoToolContract],["container.plan_summary","装柜摘要",containerPlanSummaryToolContract],["system.agent_context.get","Agent 上下文",agentContextToolContract]] as const){
    const name=tool.replaceAll(".","_");
    schemas[name]=z.toJSONSchema(contract.inputSchema,{unrepresentable:"any"});
    delete schemas[name].$schema;
    post(`/api/v2/tools/${tool}`,name,title,ref(name),ref(tool==="system.agent_context.get"?"AgentContextEnvelope":"DomainEnvelope"),["ApplicationKey","BearerToken"],"可直接使用统一应用 Key，也可使用兼容的 T0 REST 短令牌。请求体直接使用原工具 input，不能再包一层 input。数据及计算规则的来源必须明确。");
  }
  paths["/access/v2/business/jwks.json"]={get:{operationId:"businessJwks",summary:"业务令牌验证公钥",security:[],responses:{"200":response(ref("AccessJwksResponse"))}}};
  for(const action of Object.keys(outputSchemas)){
    const schema=action==='config'?null:quoteDocumentSchemas[(action==='export'?'get':action) as keyof typeof quoteDocumentSchemas];
    paths['/console/api/v1/quote-documents/'+action]={[action==='config'?'get':'post']:{operationId:'quoteDocuments_'+action.replace('-','_'),summary:'人员报价单 '+action,security:[{PortalSession:[]}],parameters:action==='config'?[]:[{name:'X-CSRF-Token',in:'header',required:true,schema:{type:'string'}},...(['save','config-save','approve','reject'].includes(action)?[{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:16,maxLength:128}}]:[])],...(schema?{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(schema,{target:'draft-2020-12'})}}}}:{}),responses:{'200':response(z.toJSONSchema(documentResponseSchema(action),{target:'draft-2020-12'})),'400':response(ref('PortalError')),'403':response(ref('PortalError')),'503':response(ref('PortalError'))}}};
  }
  for(const action of ['list','import','publish','disable','browse'] as const){const read=action==='list';paths['/console/api/v1/admin/customs-packages'+(read?'':'/'+action)]={[read?'get':'post']:{operationId:'customsPackages_'+action,summary:'完整关务数据包 '+action,security:[{PortalSession:[]}],parameters:read?[]:[{name:'X-CSRF-Token',in:'header',required:true,schema:{type:'string'}},...(action==='browse'?[]:[{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string'}}])],...(read?{}:{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(packageSchemas[action],{target:'draft-2020-12'})}}}}),responses:{'200':response(z.toJSONSchema(z.object({schema_version:z.literal('native-customs-packages@2026-09-08.v1'),status:z.literal('success'),data:action==='browse'?packageSchemas.browse_output:packageList,reason_codes:z.array(z.string()).length(0)}).strict(),{target:'draft-2020-12'})),'403':response(ref('PortalError'))}}};}
  for(const kind of ['schedules','terminals'] as const){
    const path=kind==='schedules'?'sailing-schedules':'terminal-efficiency';
    for(const action of ['get','save','preview','publish','disable','rollback','query'] as const){
      const read=action==='get'||action==='preview';
      const input=action==='query'?maritimeQuerySchema(kind):action==='save'?maritimeSaveSchema(kind):action==='publish'?nativePublishSchema:action==='rollback'?nativeRollbackSchema:action==='disable'?nativeDisableSchema:null;
      const result=action==='query'?maritimeResponseSchema(kind):nativeResponseSchema(nativeDataSchema(kind,action==='preview'));
      const url=action==='query'?'/console/api/v1/maritime/'+path+'/query':'/console/api/v1/admin/'+path+(action==='get'?'':'/'+action);
      paths[url]={[read?'get':'post']:{operationId:kind+'_'+action,summary:(kind==='schedules'?'船期':'码头效率')+' '+action,security:[{PortalSession:[]}],parameters:read?(action==='preview'?[{name:'release_id',in:'query',required:false,schema:{type:'string',format:'uuid'}}]:[]):[{name:'X-CSRF-Token',in:'header',required:true,schema:{type:'string'}},...(action==='query'?[]:[{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:16,maxLength:128}}])],...(input?{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(input,{target:'draft-2020-12'})}}}}:{}),responses:{'200':response(z.toJSONSchema(result,{target:'draft-2020-12'})),'403':response(ref('PortalError')),'503':response(ref('PortalError'))}}};
    }
  }
  return {openapi:"3.1.0",jsonSchemaDialect:"https://json-schema.org/draft/2020-12/schema",info:{title:"FreightClaw 机器接入 API",version:"2026-09-06.v4",description:"由当前代码和JSON Schema生成。统一应用 Key 可直接调用固定 REST 路由，也可换取 MCP 短令牌；网页使用邮箱账号密码。正式报价保存、人工审核和PDF是人员授权业务操作，不在机器凭证中隐式开放。"},servers:[{url:"https://www.freightclaw.net"}],paths,components:{securitySchemes:{PortalSession:{type:"apiKey",in:"cookie",name:"fc_portal_session",description:"人员会话；POST还需X-CSRF-Token。"},ApplicationKey:{type:"apiKey",in:"header",name:"Authorization",description:"完整值为 ApiKey <KEY>"},BearerToken:{type:"http",scheme:"bearer",bearerFormat:"JWT"}},schemas}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const result=JSON.stringify(generatePortalOpenApi(),null,2)+"\n";
  for(const path of process.argv.slice(2))writeFileSync(resolve(path),result);
  console.log(`Generated ${basename(process.argv[2]??"openapi.json")}`);
}
