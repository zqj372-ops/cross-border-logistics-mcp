import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ManagedProviderRuntime, signedProviderReleaseSchema, verifyProviderRelease } from "../module-runtime/managed-provider";
import { createBusinessRuntimeProvider } from "./business-provider";
import { BUSINESS_MCP_TOOLS } from "../platform/application-tools";
import { readBoundedResponse } from "../platform/bounded-response";
const digest=(bytes:Uint8Array|string)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function file(path:string,maximum:number,privateFile=false){if(!isAbsolute(path))throw new Error("provider_file_invalid");const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maximum||stat.size<1||(stat.mode&0o022)!==0||privateFile&&(stat.mode&0o077)!==0)throw new Error("provider_file_invalid");return readFileSync(path);}
const journalSchema=z.object({schema_version:z.literal("provider-activation@2026-09-06.v1"),revision:z.number().int().positive(),release_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/u)}).strict();
async function atomicJournal(path:string,value:z.infer<typeof journalSchema>){
  const parent=lstatSync(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)!==0)throw new Error("provider_journal_directory_insecure");
  const temporary=`${path}.${randomUUID()}.tmp`;let handle;
  try{handle=await open(temporary,"wx",0o600);await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=undefined;await rename(temporary,path);const directory=await open(dirname(path),"r");try{await directory.sync();}finally{await directory.close();}}
  finally{await handle?.close().catch(()=>undefined);await unlink(temporary).catch(()=>undefined);}
  const checked=journalSchema.parse(JSON.parse(file(path,4096,true).toString("utf8")) as unknown);if(JSON.stringify(checked)!==JSON.stringify(value))throw new Error("provider_activation_readback_failed");
}
export async function loadManagedBusinessProvider(environment:NodeJS.ProcessEnv){
  const required=(name:string)=>{const value=environment[name]?.trim();if(!value)throw new Error(`${name} is required.`);return value;};
  const releaseFile=required("MCP_BUSINESS_RELEASE_FILE"),signersFile=required("MCP_BUSINESS_SIGNERS_FILE"),stateFile=required("MCP_BUSINESS_RELEASE_STATE_PATH");
  if(!isAbsolute(stateFile))throw new Error("provider_journal_path_invalid");
  const allowedHosts=required("MCP_BUSINESS_PROVIDER_ALLOWED_HOST").split(",").map(x=>x.trim());
  if(allowedHosts.length>10||allowedHosts.some(x=>!x)||new Set(allowedHosts).size!==allowedHosts.length)throw new Error("provider_egress_invalid");
  const runtimeSecret=file(required("MCP_BUSINESS_PROVIDER_SECRET_FILE"),4096,true).toString("utf8").trim();if(runtimeSecret.length<32)throw new Error("provider_secret_invalid");
  const keys=()=>z.record(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),z.string().max(4096)).parse(JSON.parse(file(signersFile,32768).toString("utf8")) as unknown);
  const load=()=>{const release=signedProviderReleaseSchema.parse(JSON.parse(file(releaseFile,16384).toString("utf8")) as unknown);return verifyProviderRelease({release,artifact:file(resolve(dirname(releaseFile),release.payload.artifact_file),256*1024),sbom:file(resolve(dirname(releaseFile),release.payload.sbom_file),2*1024*1024),trustedKeys:keys(),allowedHosts});};
  let journal:z.infer<typeof journalSchema>|undefined;
  try{journal=journalSchema.parse(JSON.parse(file(stateFile,4096,true).toString("utf8")) as unknown);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const healthSchema=z.object({schema_version:z.literal("business-provider-health@2026-09-06.v1"),ready:z.literal(true),contract_version:z.literal("business-mcp-result@2026-09-06.v1"),operations:z.array(z.enum(BUSINESS_MCP_TOOLS)).length(5)}).strict();
  async function probe(baseUrl:string){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);try{const response=await fetch(new URL("/access/v2/application/mcp/provider/health",baseUrl),{method:"GET",redirect:"error",signal:controller.signal,headers:{"x-freightclaw-runtime-token":runtimeSecret}});if(!response.ok)throw new Error("provider_unavailable");const body=healthSchema.parse(JSON.parse(Buffer.from(await readBoundedResponse(response,8192,controller.signal)).toString("utf8")) as unknown);if(new Set(body.operations).size!==5)throw new Error("provider_contract_mismatch");}finally{clearTimeout(timer);}}
  let current:ReturnType<typeof load>|undefined,lastError:string|null=null;
  const runtime=new ManagedProviderRuntime({prepare:async release=>{if(release.payload.enabled)await probe(release.artifact.base_url);return{...createBusinessRuntimeProvider({baseUrl:release.artifact.base_url,allowedHosts,runtimeSecret}),close:()=>Promise.resolve()};},persist:async payload=>{
    const hash=digest(JSON.stringify(payload));if(journal&&(payload.revision<journal.revision||payload.revision===journal.revision&&hash!==journal.release_digest))throw new Error("provider_activation_replay");
    const next={schema_version:"provider-activation@2026-09-06.v1" as const,revision:payload.revision,release_digest:hash};if(!journal||journal.revision!==next.revision)await atomicJournal(stateFile,next);journal=next;
  }});
  const refresh=async()=>{const candidate=load();if(current?.payload.revision===candidate.payload.revision&&digest(JSON.stringify(current.payload))===digest(JSON.stringify(candidate.payload)))return;await runtime.activate(candidate);current=candidate;lastError=null;};
  try{await refresh();}catch(error){await runtime.close();throw error;}
  let running=false;const timer=setInterval(()=>{if(running)return;running=true;void refresh().catch(()=>{lastError="provider_candidate_rejected";}).finally(()=>{running=false;});},3000);timer.unref();
  return {get catalogDefinitions(){return runtime.catalogDefinitions;},get definitions(){return runtime.definitions;},subscribe:(listener:()=>void)=>runtime.subscribe(listener),snapshot:()=>({...runtime.snapshot(),last_error:lastError}),health:async()=>{if(!current||runtime.snapshot().cleanup_failed||Date.parse(current.payload.expires_at)<=Date.now())return{ready:false};try{if(current.payload.enabled)await probe(current.artifact.base_url);return{ready:true};}catch{return{ready:false};}},close:async()=>{clearInterval(timer);await runtime.close();}};
}
