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
      if(directory.endsWith("access-gateway")&&!/^(?:application-exchange-(?:request|response)|business-(?:call|exchange)-(?:request|response)|exchange-(?:request|response)|error-envelope|jwks-response)\./u.test(file))continue;
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
  schemas.T0RestError={type:"object",additionalProperties:false,required:["schema_version","status","data","reason_codes"],properties:{schema_version:{const:"portal-t0-rest@2026-09-05.v1"},status:{const:"blocked"},data:{type:"null"},reason_codes:{type:"array",items:{type:"string"}}}};
  const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
  const paths:Record<string,unknown>={};
  const response=(schema:unknown)=>({description:"操作结果；业务状态及来源版本以响应为准。",content:{"application/json":{schema}}});
  const post=(path:string,id:string,summary:string,request:unknown,result:unknown,security:string|readonly string[],description:string)=>{
    const error=ref(path.includes("/business/")?"BusinessError":"T0RestError");
    const securityOptions=(typeof security==="string"?[security]:security).map(name=>({[name]:[]}));
    paths[path]={post:{operationId:id,summary,description,security:securityOptions,requestBody:{required:true,content:{"application/json":{schema:request}}},responses:{"200":response(result),"400":response(error),"401":response(error),"403":response(error),"503":response(error)}}};
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
  for(const [tool,title,contract] of [["cargo.calculate","货物计算",cargoToolContract],["container.plan_summary","装柜摘要",containerPlanSummaryToolContract],["system.agent_context.get","Agent 上下文",agentContextToolContract]] as const){
    const name=tool.replaceAll(".","_");
    schemas[name]=z.toJSONSchema(contract.inputSchema,{unrepresentable:"any"});
    delete schemas[name].$schema;
    post(`/api/v2/tools/${tool}`,name,title,ref(name),ref(tool==="system.agent_context.get"?"AgentContextEnvelope":"DomainEnvelope"),["ApplicationKey","BearerToken"],"可直接使用统一应用 Key，也可使用兼容的 T0 REST 短令牌。请求体直接使用原工具 input，不能再包一层 input。数据及计算规则的来源必须明确。");
  }
  paths["/access/v2/business/jwks.json"]={get:{operationId:"businessJwks",summary:"业务令牌验证公钥",security:[],responses:{"200":response(ref("AccessJwksResponse"))}}};
  return {openapi:"3.1.0",jsonSchemaDialect:"https://json-schema.org/draft/2020-12/schema",info:{title:"FreightClaw 机器接入 API",version:"2026-09-06.v3",description:"由当前代码和JSON Schema生成。统一应用 Key 可直接调用固定 REST 路由，也可换取 MCP 短令牌；网页使用邮箱账号密码。正式报价保存、人工审核和PDF是人员授权业务操作，不在机器凭证中隐式开放。"},servers:[{url:"https://www.freightclaw.net"}],paths,components:{securitySchemes:{ApplicationKey:{type:"apiKey",in:"header",name:"Authorization",description:"完整值为 ApiKey <KEY>"},BearerToken:{type:"http",scheme:"bearer",bearerFormat:"JWT"}},schemas}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const result=JSON.stringify(generatePortalOpenApi(),null,2)+"\n";
  for(const path of process.argv.slice(2))writeFileSync(resolve(path),result);
  console.log(`Generated ${basename(process.argv[2]??"openapi.json")}`);
}
