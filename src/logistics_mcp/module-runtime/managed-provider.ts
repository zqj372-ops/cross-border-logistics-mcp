import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { BUSINESS_MCP_TOOLS } from "../platform/application-tools";
import type { ExecutionContext } from "../platform/context";
import type { ToolDefinition } from "../server/tool-registry";
import { ModuleHost } from "./host";
import { CapabilityRegistry } from "./capabilities";
import type { ModuleManifest, ModuleMountContext } from "./types";
import { moduleManifestDigest, toolContractDigest, type ModuleDescriptor } from "./production";

const digestSchema=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const filename=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.json$/u);
export const providerReleasePayloadSchema=z.object({schema_version:z.literal("provider-release@2026-09-06.v1"),module_id:z.literal("business-api"),version:z.string().regex(/^\d+\.\d+\.\d+$/u),revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),enabled:z.boolean(),artifact_file:filename,artifact_digest:digestSchema,sbom_file:filename,sbom_digest:digestSchema,source_commit:z.string().regex(/^[a-f0-9]{40}$/u),issued_at:z.string().datetime(),expires_at:z.string().datetime()}).strict();
export const signedProviderReleaseSchema=z.object({payload:providerReleasePayloadSchema,alg:z.literal("Ed25519"),key_id:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/u)}).strict();
const artifactSchema=z.object({schema_version:z.literal("private-provider@2026-09-06.v1"),base_url:z.string().url(),contract_version:z.literal("business-mcp-result@2026-09-06.v1"),tools:z.array(z.enum(BUSINESS_MCP_TOOLS)).length(5)}).strict();
export type ProviderReleasePayload=z.infer<typeof providerReleasePayloadSchema>;
interface VerifiedRelease {readonly payload:ProviderReleasePayload;readonly artifact:z.infer<typeof artifactSchema>}
const verified=new WeakSet<object>();
export function verifyProviderRelease(options:{release:unknown;artifact:Uint8Array;sbom:Uint8Array;trustedKeys:Readonly<Record<string,string>>;allowedHosts:readonly string[];now?:number}):VerifiedRelease{
  const release=signedProviderReleaseSchema.parse(options.release),key=options.trustedKeys[release.key_id];
  if(!key)throw new Error("provider_signer_untrusted");
  const publicKey=createPublicKey(key);
  if(publicKey.asymmetricKeyType!=="ed25519"||!verify(null,Buffer.from(JSON.stringify(release.payload)),publicKey,Buffer.from(release.signature,"base64url")))throw new Error("provider_signature_invalid");
  const now=options.now??Date.now(),issued=Date.parse(release.payload.issued_at),expires=Date.parse(release.payload.expires_at);
  if(issued>now+30000||expires<=now||expires-issued>31*86400000||expires<=issued)throw new Error("provider_release_expired");
  const digest=(bytes:Uint8Array)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if(options.artifact.byteLength>256*1024||options.sbom.byteLength>2*1024*1024||digest(options.artifact)!==release.payload.artifact_digest||digest(options.sbom)!==release.payload.sbom_digest)throw new Error("provider_artifact_mismatch");
  const artifact=artifactSchema.parse(JSON.parse(Buffer.from(options.artifact).toString("utf8")) as unknown);
  const sbom=z.object({bomFormat:z.literal("CycloneDX"),specVersion:z.string().regex(/^1\.[4-6]$/u),components:z.array(z.unknown()).max(10000)}).passthrough().parse(JSON.parse(Buffer.from(options.sbom).toString("utf8")) as unknown);
  if(!sbom.components)throw new Error("provider_sbom_invalid");
  const url=new URL(artifact.base_url);
  if(url.protocol!=="https:"||url.username||url.password||url.pathname!=="/"||url.search||url.hash||!options.allowedHosts.includes(url.host)||new Set(artifact.tools).size!==5)throw new Error("provider_egress_denied");
  const result=Object.freeze({payload:Object.freeze(release.payload),artifact:Object.freeze({...artifact,tools:Object.freeze([...artifact.tools]) as unknown as typeof artifact.tools})});verified.add(result);return result;
}
interface PreparedProvider {readonly definitions:readonly ToolDefinition[];close():Promise<void>}
interface Generation {release:VerifiedRelease;provider:PreparedProvider;host:ModuleHost;definitions:readonly ToolDefinition[];calls:Set<AbortController>;retired:boolean;disposed:boolean;timer?:ReturnType<typeof setTimeout>;expiryTimer?:ReturnType<typeof setTimeout>}
type Handler=NonNullable<ToolDefinition["handler"]>;
function mountProvider(release:VerifiedRelease,provider:PreparedProvider){
  if(provider.definitions.length!==5||new Set(provider.definitions.map(x=>x.name)).size!==5||provider.definitions.some(x=>!BUSINESS_MCP_TOOLS.includes(x.name as typeof BUSINESS_MCP_TOOLS[number])||x.kind!=="read"||x.riskLevel!=="T1"||!x.handler||!x.inputSchema||!x.validateOutput))throw new Error("provider_contract_invalid");
  const groups=[{id:"business-api",version:release.payload.version,definitions:provider.definitions.filter(d=>d.name!=="quote.freightcom_ltl.preview")},{id:"freightcom-ltl",version:"2026-08-26.v1",definitions:provider.definitions.filter(d=>d.name==="quote.freightcom_ltl.preview")}];
  const descriptors:ModuleDescriptor[]=[],modules=groups.map(group=>{
    const manifest:ModuleManifest={module_id:group.id,version:group.version,risk_level:"T1",required_capabilities:[],optional_capabilities:[],standard_ids:["business-mcp.v1"],lifecycle:"static"};
    const contracts=group.definitions.map(d=>{const c={name:d.name,input_schema_id:d.inputSchemaId,output_schema_id:d.outputSchemaId,permission:d.permission,kind:d.kind,risk_level:"T1" as const,standard_refs:["business-mcp.v1"]};return{...c,contract_digest:toolContractDigest(c)};});
    const descriptorBase={module_id:manifest.module_id,version:manifest.version,risk_level:manifest.risk_level,tool_names:group.definitions.map(d=>d.name),tool_contracts:contracts,required_capabilities:[],optional_capabilities:[],artifact_digest:release.payload.artifact_digest as `sha256:${string}`};
    descriptors.push({...descriptorBase,manifest_digest:moduleManifestDigest(descriptorBase)});
    return{manifest,mount(ctx:ModuleMountContext){for(const d of group.definitions)ctx.tools.register({name:d.name,title:d.title,description:d.description,inputSchemaId:d.inputSchemaId,outputSchemaId:d.outputSchemaId,permission:d.permission,kind:"read" as const,riskLevel:"T1" as const,standardRefs:["business-mcp.v1"],handler:d.handler!,inputSchema:d.inputSchema!,validateOutput:d.validateOutput!,...(d.outputSchema?{outputSchema:d.outputSchema}:{})});}};
  });
  const host=new ModuleHost({capabilities:new CapabilityRegistry(),trustedDescriptors:descriptors,modules});
  host.mountSync();return host;
}
interface ManagedProviderOptions {prepare:(release:VerifiedRelease)=>Promise<PreparedProvider>;persist:(release:ProviderReleasePayload)=>Promise<void>;drainTimeoutMs?:number}
export class ManagedProviderRuntime {
  readonly #options:ManagedProviderOptions;
  readonly #listeners=new Set<()=>void>();readonly #retired=new Set<Generation>();
  #active:Generation|undefined;#queue=Promise.resolve();#closed=false;#cleanupFailed=false;
  constructor(options:ManagedProviderOptions){this.#options=options;}
  get catalogDefinitions():readonly ToolDefinition[]{const current=this.#active;if(!current)return[];return current.definitions.map(d=>({...d,moduleId:d.name==="quote.freightcom_ltl.preview"?"freightcom-ltl":"business-api",moduleVersion:d.name==="quote.freightcom_ltl.preview"?"2026-08-26.v1":current.release.payload.version,handler:((input,ctx,signal)=>this.#invoke(d.name,input,ctx,signal))}));}
  get definitions():readonly ToolDefinition[]{const current=this.#active;if(!current||this.#closed||!current.release.payload.enabled||Date.parse(current.release.payload.expires_at)<=Date.now())return[];return current.definitions.map(d=>({...d,moduleId:d.name==="quote.freightcom_ltl.preview"?"freightcom-ltl":"business-api",moduleVersion:d.name==="quote.freightcom_ltl.preview"?"2026-08-26.v1":current.release.payload.version,handler:((input,ctx,signal)=>this.#invoke(d.name,input,ctx,signal))}));}
  subscribe(listener:()=>void){this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};}
  snapshot(){return{module_id:"business-api",revision:this.#active?.release.payload.revision??null,enabled:!this.#closed&&this.#active?.release.payload.enabled===true&&Date.parse(this.#active.release.payload.expires_at)>Date.now(),artifact_digest:this.#active?.release.payload.artifact_digest??null,in_flight:this.#active?.calls.size??0,cleanup_failed:this.#cleanupFailed,draining:[...this.#retired].map(g=>({revision:g.release.payload.revision,in_flight:g.calls.size})),modules:this.#active?.host.snapshot().modules??[]};}
  activate(release:VerifiedRelease):Promise<void>{const work=this.#queue.then(()=>this.#activate(release));this.#queue=work.catch(()=>undefined);return work;}
  async #activate(release:VerifiedRelease){
    if(!verified.has(release)||this.#closed)throw new Error("provider_release_untrusted");
    if(this.#active&&release.payload.revision<=this.#active.release.payload.revision)throw new Error("provider_revision_conflict");
    if(this.#retired.size>=2)throw new Error("provider_drain_pending");
    const provider=await this.#options.prepare(release);
    let host:ModuleHost|undefined;
    try{host=mountProvider(release,provider);await this.#options.persist(release.payload);}catch(error){if(host)await host.close().catch(()=>undefined);await provider.close().catch(()=>undefined);throw error;}
    const previous=this.#active;
    this.#active={release,provider,host:host,definitions:provider.definitions,calls:new Set(),retired:false,disposed:false};
    const activated=this.#active;
    const expire=()=>{if(this.#active!==activated||this.#closed)return;const remaining=Date.parse(activated.release.payload.expires_at)-Date.now();if(remaining>0){activated.expiryTimer=setTimeout(expire,Math.min(remaining,2_147_000_000));activated.expiryTimer.unref();}else for(const listener of this.#listeners)try{listener();}catch{/* Client cleanup is independent of expiry. */}};
    expire();
    if(previous){previous.retired=true;this.#retired.add(previous);if(previous.calls.size===0)await this.#dispose(previous);else {previous.timer=setTimeout(()=>{for(const call of previous.calls)call.abort();},this.#options.drainTimeoutMs??30000);previous.timer.unref();}}
    for(const listener of this.#listeners)try{listener();}catch{/* A broken client notification cannot revert a persisted release. */}
  }
  async #dispose(g:Generation){if(g.disposed)return;g.disposed=true;if(g.timer)clearTimeout(g.timer);if(g.expiryTimer)clearTimeout(g.expiryTimer);try{await g.host.close();await g.provider.close();}catch{this.#cleanupFailed=true;}finally{this.#retired.delete(g);}}
  async #invoke(name:string,input:unknown,context:ExecutionContext,signal?:AbortSignal):Promise<Awaited<ReturnType<Handler>>>{
    const current=this.#active,definition=current?.definitions.find(d=>d.name===name);
    if(!current||this.#closed||!current.release.payload.enabled||Date.parse(current.release.payload.expires_at)<=Date.now()||!definition?.handler)return{status:"unavailable",data:null,blockers:[{code:"module_disabled_by_release",message:"业务模块当前未开放。",severity:"error"}]};
    const controller=new AbortController();current.calls.add(controller);
    const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener("abort",abort,{once:true});
    let rejectAbort!:()=>void;const aborted=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(new Error("provider_request_aborted"));controller.signal.addEventListener("abort",rejectAbort,{once:true});});
    const running=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return definition.handler!(input,context,controller.signal);}).finally(async()=>{current.calls.delete(controller);signal?.removeEventListener("abort",abort);controller.signal.removeEventListener("abort",rejectAbort);if(current.retired&&current.calls.size===0)await this.#dispose(current);});
    if(controller.signal.aborted)rejectAbort();
    try{return await Promise.race([running,aborted]);}catch{return{status:"unavailable",data:null,blockers:[{code:"provider_request_unavailable",message:"业务模块请求未完成。",severity:"error"}]};}
  }
  async close(){if(this.#closed)return;this.#closed=true;await this.#queue;this.#listeners.clear();if(this.#active){this.#active.retired=true;this.#retired.add(this.#active);}for(const g of this.#retired){for(const call of g.calls)call.abort();if(g.calls.size===0)await this.#dispose(g);}}
}
