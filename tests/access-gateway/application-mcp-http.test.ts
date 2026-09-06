import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createApplicationMcpHttpHandler } from "../../services/access-gateway/portal/business-access/mcp-http";
import { BUSINESS_MCP_TOOLS } from "../../src/logistics_mcp/platform/application-tools";
it("requires the private workload credential as well as current application authority for provider execution",async()=>{
  let executions=0,authorized=true;
  const server=createServer((req,res)=>{if(!handler.handle(req,res)){res.statusCode=404;res.end();}});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const host=`127.0.0.1:${(server.address() as AddressInfo).port}`,origin=`http://${host}`;
  const handler=createApplicationMcpHttpHandler({mode:"fixtures",runtimeSecret:"s".repeat(48),providerHealth:()=>Promise.resolve(true),allowedHosts:[host],allowedOrigins:[origin],trustedProxyAddresses:[],service:{repositoryKind:"synthetic",exchange:()=>Promise.reject(new Error("unused")),authorize:()=>Promise.reject(new Error("unused"))},mcpAccess:{exchange:()=>Promise.reject(new Error("unused")),verify:()=>authorized?Promise.resolve({tenantId:"tenant_fixture",clientId:"client_fixture",applicationId:"app_fixture",credentialId:"bkey_123",toolNames:[...BUSINESS_MCP_TOOLS]}):Promise.reject(new Error("revoked"))},executor:{execute:()=>{executions++;return Promise.resolve({schema_version:"portal-business@2026-09-05.v1",status:"unavailable",data:null,reason_codes:["fixture_source_unavailable"]});}}});
  const call=(secret?:string)=>fetch(`${origin}/access/v2/application/mcp/tools/customs.query`,{method:"POST",headers:{authorization:"Bearer fixture-token","content-type":"application/json",...(secret?{"x-freightclaw-runtime-token":secret}:{})},body:JSON.stringify({schema_version:"application-mcp-call@2026-09-06.v1",request_id:"req_fixture_0123456",input:{query:"fixture",ruleDate:"2026-09-06",attributes:{originCountry:"CN"}}})});
  try{expect((await call()).status).toBe(401);expect((await call("wrong")).status).toBe(401);expect(executions).toBe(0);expect((await call("s".repeat(48))).status).toBe(200);expect(executions).toBe(1);authorized=false;expect((await call("s".repeat(48))).status).toBe(503);expect(executions).toBe(1);
    expect((await fetch(`${origin}/access/v2/application/mcp/provider/health`)).status).toBe(401);
    expect(await fetch(`${origin}/access/v2/application/mcp/provider/health`,{headers:{"x-freightclaw-runtime-token":"s".repeat(48)}}).then(r=>r.json())).toMatchObject({ready:true,operations:BUSINESS_MCP_TOOLS});
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
