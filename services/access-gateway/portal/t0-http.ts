import type {IncomingMessage,ServerResponse} from "node:http";
import {T0_TOOL_NAMES,type T0ToolName} from "../contracts";
import type {PortalAccessBridge} from "./access-bridge";
import {PortalError} from "./contracts";
const paths=new Map<string,T0ToolName>(T0_TOOL_NAMES.map(name=>[`/api/v2/tools/${name}`,name] as const));
const send=(res:ServerResponse,status:number,value:unknown)=>{res.statusCode=status;res.setHeader("content-type","application/json; charset=utf-8");res.setHeader("cache-control","no-store");res.setHeader("content-security-policy","default-src 'none'; frame-ancestors 'none'");res.setHeader("referrer-policy","no-referrer");res.setHeader("x-content-type-options","nosniff");res.end(JSON.stringify(value));};
async function body(req:IncomingMessage){const chunks:Uint8Array[]=[];let size=0;for await(const chunk of req){const value=typeof chunk==="string"?Buffer.from(chunk):new Uint8Array(chunk);size+=value.length;if(size>32768)throw new PortalError("input_invalid");chunks.push(value);}try{return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;}catch{throw new PortalError("input_invalid");}}
const count=(req:IncomingMessage,name:string)=>req.rawHeaders.filter((_,index)=>index%2===0&&req.rawHeaders[index]?.toLowerCase()===name).length;
function auth(req:IncomingMessage,scheme:"ApiKey"|"Bearer"){if(req.headers.cookie!==undefined)throw new PortalError("machine_authentication_failed");const match=new RegExp(`^${scheme} ([^\\s]{1,16384})$`,`u`).exec(String(req.headers.authorization??""));if(!match?.[1])throw new PortalError("machine_authentication_failed");return match[1];}
export function createProductionT0HttpHandler(options:{
  bridge:Pick<PortalAccessBridge,"exchangeToken"|"exchangeApplicationToken"|"executeT0"|"executeT0WithApplicationKey"|"verifyApplicationTokenAuthority">;
  allowedHosts:readonly string[];
  trustedProxyAddresses:readonly string[];
  mode?:"fixtures"|"production";
  authorityHealth?:()=>Promise<boolean>;
}){
  return {handle(req:IncomingMessage,res:ServerResponse){
    const path=(req.url??"").split("?",1)[0]!;
    const tool=paths.get(path),legacyExchange=path==="/access/v2/tools/token/exchange",applicationExchange=path==="/access/v2/application/token/exchange",authorityCheck=path==="/access/v2/application/token/authority";
    const healthCheck=path==="/access/v2/application/token/health";
    if(!tool&&!legacyExchange&&!applicationExchange&&!authorityCheck&&!healthCheck)return false;
    void(async()=>{try{
      const remote=req.socket.remoteAddress??"",local=req.socket.localAddress??"",loopback=(value:string)=>["127.0.0.1","::1","::ffff:127.0.0.1"].includes(value);
      const transport=options.mode==="fixtures"
        ? loopback(remote)&&loopback(local)
        : count(req,"x-forwarded-proto")===1&&options.trustedProxyAddresses.includes(remote)&&req.headers["x-forwarded-proto"]==="https";
      if(healthCheck){
        if(req.method!=="GET"||req.url!==path||count(req,"host")!==1||req.headers.cookie!==undefined||req.headers.authorization!==undefined||!options.allowedHosts.includes(String(req.headers.host))||!transport)throw new PortalError("machine_request_denied");
        const ready=await options.authorityHealth?.().catch(()=>false)??false;
        send(res,ready?200:503,{schema_version:"application-authority-health@2026-09-06.v1",ready});return;
      }
      if(req.method!=="POST"||(req.url??"")!==path||count(req,"host")!==1||count(req,"authorization")!==1||count(req,"content-type")!==1||!options.allowedHosts.includes(String(req.headers.host))||!transport||!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(req.headers["content-type"]??"")))throw new PortalError("machine_request_denied");
      const value=await body(req);
      if(authorityCheck){
        if(typeof value!=="object"||value===null||Array.isArray(value)||Object.keys(value).join(",")!=="schema_version"||(value as Record<string,unknown>).schema_version!=="application-authority@2026-09-06.v1")throw new PortalError("input_invalid");
        await options.bridge.verifyApplicationTokenAuthority(auth(req,"Bearer"));
        send(res,200,{schema_version:"application-authority@2026-09-06.v1",status:"success",data:{active:true},reason_codes:[]});return;
      }
      if(legacyExchange){send(res,200,await options.bridge.exchangeToken({apiKey:auth(req,"ApiKey"),body:value,clientIp:remote||"unknown"}));return;}
      if(applicationExchange){
        if(typeof value!=="object"||value===null||Array.isArray(value)||Object.keys(value).sort().join(",")!=="requested_tool_names,schema_version")throw new PortalError("input_invalid");
        const request=value as Record<string,unknown>;
        if(request.schema_version!=="application-exchange@2026-09-06.v1"||!Array.isArray(request.requested_tool_names)||request.requested_tool_names.some(item=>typeof item!=="string"||!T0_TOOL_NAMES.includes(item as T0ToolName))||request.requested_tool_names.length<1||request.requested_tool_names.length>3||new Set(request.requested_tool_names).size!==request.requested_tool_names.length)throw new PortalError("input_invalid");
        send(res,200,await options.bridge.exchangeApplicationToken({apiKey:auth(req,"ApiKey"),requestedToolNames:request.requested_tool_names as T0ToolName[],clientIp:remote||"unknown"}));return;
      }
      const authorization=String(req.headers.authorization??"");
      if(authorization.startsWith("ApiKey ")){send(res,200,await options.bridge.executeT0WithApplicationKey({apiKey:auth(req,"ApiKey"),toolName:tool as T0ToolName,input:value}));return;}
      send(res,200,await options.bridge.executeT0({accessToken:auth(req,"Bearer"),toolName:tool as T0ToolName,input:value}));
    }catch(error){const code=error instanceof Error?error.message:"machine_unavailable";send(res,code.includes("input")?400:code.includes("authentication")?401:code.includes("unavailable")?503:403,{schema_version:"portal-t0-rest@2026-09-05.v1",status:code.includes("unavailable")?"unavailable":"blocked",data:null,reason_codes:[code]});}})();
    return true;
  }};
}
