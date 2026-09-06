import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManagedBusinessProvider } from "../../src/logistics_mcp/server/managed-business-provider";
import { signProviderRelease } from "../../src/logistics_mcp/module-runtime/provider-release-cli";
import { verifyProviderRelease, ManagedProviderRuntime, type ProviderReleasePayload } from "../../src/logistics_mcp/module-runtime/managed-provider";
import { BUSINESS_MCP_TOOLS } from "../../src/logistics_mcp/platform/application-tools";
import { createBusinessRuntimeProvider } from "../../src/logistics_mcp/server/business-provider";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
const keys=generateKeyPairSync("ed25519");
const bytes=Buffer.from(JSON.stringify({schema_version:"private-provider@2026-09-06.v1",base_url:"https://provider.invalid/",contract_version:"business-mcp-result@2026-09-06.v1",tools:BUSINESS_MCP_TOOLS}));
const sbom=Buffer.from(JSON.stringify({bomFormat:"CycloneDX",specVersion:"1.6",components:[]}));
const digest=(b:Buffer)=>`sha256:${createHash("sha256").update(b).digest("hex")}`;
function release(revision:number,enabled=true){const payload={schema_version:"provider-release@2026-09-06.v1",module_id:"business-api",version:"1.0.0",revision,enabled,artifact_file:"provider.json",artifact_digest:digest(bytes),sbom_file:"sbom.json",sbom_digest:digest(sbom),source_commit:"a".repeat(40),issued_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+86400000).toISOString()};return {payload,alg:"Ed25519",key_id:"test-key",signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString("base64url")};}
function verified(revision:number,enabled=true){return verifyProviderRelease({release:release(revision,enabled),artifact:bytes,sbom,trustedKeys:{"test-key":keys.publicKey.export({type:"spki",format:"pem"}).toString()},allowedHosts:["provider.invalid"]});}
it("rejects tampered, expired and non-allowlisted provider artifacts before mounting",()=>{
  expect(verified(1).payload.revision).toBe(1);
  const input={release:release(1),artifact:bytes,sbom,trustedKeys:{"test-key":keys.publicKey.export({type:"spki",format:"pem"}).toString()},allowedHosts:["provider.invalid"]};
  expect(()=>verifyProviderRelease({...input,artifact:Buffer.from("{}")})).toThrow();
  expect(()=>verifyProviderRelease({...input,sbom:Buffer.from("{}")})).toThrow();
  expect(()=>verifyProviderRelease({...input,allowedHosts:["other.invalid"]})).toThrow();
  expect(()=>verifyProviderRelease({...input,release:{...input.release,payload:{...input.release.payload,enabled:false}}})).toThrow();
});
it("pins in-flight calls, atomically disables new calls, rolls back and disposes each generation once",async()=>{
  let finish!:(v:{status:"success";data:null})=>void;const held=new Promise<{status:"success";data:null}>(resolve=>{finish=resolve;});
  const disposed:number[]=[],persisted:number[]=[],notifications:number[]=[];
  const definitions=createBusinessRuntimeProvider({baseUrl:"https://provider.invalid/",allowedHosts:["provider.invalid"],runtimeSecret:"x".repeat(32)}).definitions;
  const runtime=new ManagedProviderRuntime({drainTimeoutMs:1000,persist:release=>{persisted.push(release.revision);return Promise.resolve();},prepare:candidate=>Promise.resolve({definitions:definitions.map(d=>({...d,handler:()=>candidate.payload.revision===1?held:Promise.resolve({status:"success" as const,data:null})})),close:()=>{disposed.push(candidate.payload.revision);return Promise.resolve();}})});
  runtime.subscribe(()=>{notifications.push(runtime.snapshot().revision!);});
  await runtime.activate(verified(1));
  const ctx=parseExecutionContext({tenant_id:"tenant_a",actor_id:"actor_a",actor_role:"service",roles:["service"],scopes:["tool:customs.query"],client_id:"client_a",session_id:"session_a",expires_at:Math.floor(Date.now()/1000)+60,mcp_profile:"business-v1"});
  const inflight=runtime.definitions[0]!.handler!({},ctx);
  await runtime.activate(verified(2,false));expect(runtime.definitions).toHaveLength(0);expect(disposed).not.toContain(1);
  finish({status:"success",data:null});await inflight;await Promise.resolve();expect(disposed.filter(x=>x===1)).toHaveLength(1);
  await runtime.activate(verified(3));expect(runtime.definitions).toHaveLength(5);
  await expect(runtime.activate(verified(2))).rejects.toThrow("provider_revision_conflict");
  await runtime.close();expect(persisted).toEqual([1,2,3]);expect(notifications).toEqual([1,2,3]);
});
it("retains the active generation when preparation or durable activation fails",async()=>{
  let reject=false;const runtime=new ManagedProviderRuntime({persist:(p:ProviderReleasePayload)=>{if(reject&&p.revision>1)return Promise.reject(new Error("storage_offline"));return Promise.resolve();},prepare:()=>Promise.resolve({definitions:createBusinessRuntimeProvider({baseUrl:"https://provider.invalid/",allowedHosts:["provider.invalid"],runtimeSecret:"x".repeat(32)}).definitions,close:()=>Promise.resolve()})});
  await runtime.activate(verified(1));reject=true;await expect(runtime.activate(verified(2))).rejects.toThrow("storage_offline");expect(runtime.snapshot().revision).toBe(1);await runtime.close();
});

it("cancels expired drains but retains resources until an uncooperative handler settles",async()=>{
  vi.useFakeTimers();
  let finish!:(value:{status:"success";data:null})=>void;
  const held=new Promise<{status:"success";data:null}>(resolve=>{finish=resolve;});
  const disposed:number[]=[];
  const definitions=createBusinessRuntimeProvider({baseUrl:"https://provider.invalid/",allowedHosts:["provider.invalid"],runtimeSecret:"x".repeat(32)}).definitions;
  const runtime=new ManagedProviderRuntime({drainTimeoutMs:100,persist:()=>Promise.resolve(),prepare:candidate=>Promise.resolve({definitions:definitions.map(d=>({...d,handler:()=>held})),close:()=>{disposed.push(candidate.payload.revision);return Promise.resolve();}})});
  try{
    await runtime.activate(verified(1));
    const ctx=parseExecutionContext({tenant_id:"tenant_a",actor_id:"actor_a",actor_role:"service",roles:["service"],scopes:["tool:customs.query"],client_id:"client_a",session_id:"session_a",expires_at:Math.floor(Date.now()/1000)+60,mcp_profile:"business-v1"});
    const inflight=runtime.definitions[0]!.handler!({},ctx);await Promise.resolve();
    await runtime.activate(verified(2,false));await vi.advanceTimersByTimeAsync(101);
    expect(await inflight).toMatchObject({status:"unavailable"});expect(disposed).not.toContain(1);
    expect(runtime.snapshot().draining).toEqual([{revision:1,in_flight:1}]);
    finish({status:"success",data:null});await vi.advanceTimersByTimeAsync(0);
    expect(disposed.filter(x=>x===1)).toHaveLength(1);expect(runtime.snapshot().draining).toEqual([]);
  }finally{await runtime.close();vi.useRealTimers();}
});
it("removes expired releases from discovery and notifies subscribers",async()=>{
  vi.useFakeTimers();const notifications:number[]=[];
  const runtime=new ManagedProviderRuntime({persist:()=>Promise.resolve(),prepare:()=>Promise.resolve({definitions:createBusinessRuntimeProvider({baseUrl:"https://provider.invalid/",allowedHosts:["provider.invalid"],runtimeSecret:"x".repeat(32)}).definitions,close:()=>Promise.resolve()})});
  try{runtime.subscribe(()=>notifications.push(runtime.definitions.length));await runtime.activate(verified(1));await vi.advanceTimersByTimeAsync(86400001);expect(runtime.definitions).toHaveLength(0);expect(runtime.snapshot().enabled).toBe(false);expect(notifications).toEqual([5,0]);}finally{await runtime.close();vi.useRealTimers();}
});
it("publishes a verified release atomically and refuses revision replay or damaged artifacts",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"mcp-release-signing-"));
  try{
    const payload=release(1).payload;
    const payloadFile=join(directory,"payload.json"),privateKeyFile=join(directory,"key.pem"),outputFile=join(directory,"release.json");
    writeFileSync(payloadFile,JSON.stringify(payload),{mode:0o600});writeFileSync(join(directory,"provider.json"),bytes,{mode:0o600});writeFileSync(join(directory,"sbom.json"),sbom,{mode:0o600});writeFileSync(privateKeyFile,keys.privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});
    const options={payloadFile,privateKeyFile,outputFile,keyId:"test-key",allowedHosts:["provider.invalid"]};
    await expect(signProviderRelease(options)).resolves.toMatchObject({revision:1,artifact_digest:digest(bytes)});
    const first=readFileSync(outputFile,"utf8");await expect(signProviderRelease(options)).rejects.toThrow("release_revision_must_advance");expect(readFileSync(outputFile,"utf8")).toBe(first);
    writeFileSync(payloadFile,JSON.stringify({...payload,revision:2}));writeFileSync(join(directory,"provider.json"),"{}");await expect(signProviderRelease(options)).rejects.toThrow("provider_artifact_mismatch");expect(readFileSync(outputFile,"utf8")).toBe(first);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

it("persists activation across restart and rejects a replayed release on disk",async()=>{
  vi.useFakeTimers();
  const directory=mkdtempSync(join(tmpdir(),"mcp-release-loader-"));
  let runtime:Awaited<ReturnType<typeof loadManagedBusinessProvider>>|undefined;
  try{
    const signed=release(1),releaseFile=join(directory,"release.json"),stateFile=join(directory,"activation.json"),signersFile=join(directory,"signers.json"),secretFile=join(directory,"secret");
    writeFileSync(releaseFile,JSON.stringify(signed),{mode:0o600});writeFileSync(join(directory,"provider.json"),bytes,{mode:0o600});writeFileSync(join(directory,"sbom.json"),sbom,{mode:0o600});writeFileSync(signersFile,JSON.stringify({"test-key":keys.publicKey.export({type:"spki",format:"pem"}).toString()}),{mode:0o600});writeFileSync(secretFile,"fixture-runtime-secret-not-production".repeat(2),{mode:0o600});
    vi.stubGlobal("fetch",()=>Promise.resolve(Response.json({schema_version:"business-provider-health@2026-09-06.v1",ready:true,contract_version:"business-mcp-result@2026-09-06.v1",operations:BUSINESS_MCP_TOOLS})));
    const env={MCP_BUSINESS_RELEASE_FILE:releaseFile,MCP_BUSINESS_SIGNERS_FILE:signersFile,MCP_BUSINESS_RELEASE_STATE_PATH:stateFile,MCP_BUSINESS_PROVIDER_ALLOWED_HOST:"provider.invalid",MCP_BUSINESS_PROVIDER_SECRET_FILE:secretFile};
    runtime=await loadManagedBusinessProvider(env);expect(runtime.definitions).toHaveLength(5);
    writeFileSync(releaseFile,JSON.stringify(release(2,false)));await vi.advanceTimersByTimeAsync(3100);await vi.waitFor(()=>expect(runtime!.snapshot().revision).toBe(2));expect(runtime.definitions).toHaveLength(0);
    await runtime.close();runtime=await loadManagedBusinessProvider(env);expect(runtime.snapshot()).toMatchObject({revision:2,enabled:false});await runtime.close();runtime=undefined;
    writeFileSync(releaseFile,JSON.stringify(signed));await expect(loadManagedBusinessProvider(env)).rejects.toThrow("provider_activation_replay");
    expect(JSON.parse(readFileSync(stateFile,"utf8")) as unknown).toMatchObject({revision:2});
  }finally{await runtime?.close();vi.unstubAllGlobals();vi.useRealTimers();rmSync(directory,{recursive:true,force:true});}
});
