import type {CustomsPackages} from '../../customs-native/packages';
import type {DocumentService} from '../../quote-documents/service';
import type { NativeFreightcomService } from './native-freightcom';
import type { NativeAdminService } from './native-admin';
import type { ChannelService } from "./channels";
import type { CaseService } from "./cases";
import type { PortalPublicCustomsService } from "./public-customs";
import type { PortalCallLogService } from "./call-log";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { PortalIdentityProvider } from "./identity";
import { FixturePortalIdentityProvider } from "./identity";
import { createPortalHttpHandler, type PortalCredentialBridge } from "./http";
import type { OrganizationBridge } from "./organization-bridge";
import type { PortalBusinessService } from "./business/service";
import type { BusinessAccessService } from "./business-access/service";
import type { PortalService } from "./service";
import { InMemoryPortalSessionStore, PortalSessionManager, type PortalSessionStore } from "./session";

const CONTENT_TYPE: Readonly<Record<string, string>> = Object.freeze({ ".md": "text/markdown; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2" });
const CSP = "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";

type PortalServicePort = Pick<PortalService, "getState" | "getReviewQueue" | "getProvisioningQueue" | "getPlatformState" | "inviteMember" | "claimInvitation" | "revokeInvitation" | "changeMembership" | "createApplication" | "changeApplication" | "createRequest" | "submitRequest" | "withdrawRequest" | "markRequestInReview" | "decideRequest" | "updateRequest" | "changeGrantState" | "changeGrantCapabilities">;
export interface PortalMachineHandler { handle(request:IncomingMessage,response:ServerResponse):boolean|Promise<boolean> }
export interface PortalRuntimeStatus {
  readonly releaseId: string;
  readonly buildId: string;
  readiness(): Promise<Readonly<{ ready: boolean; checks: Readonly<Record<"portal_database"|"session_database"|"business_access_database"|"identity"|"business_configuration", boolean>> }>>;
}
export interface StartPortalServerOptions {
  readonly mode: "fixtures" | "production";
  readonly service: PortalServicePort;
  readonly bridge?: PortalCredentialBridge;
  readonly organizationBridge?: OrganizationBridge;
  readonly businessService?: PortalBusinessService;
  readonly publicCustoms?: PortalPublicCustomsService;
  readonly callLogService?: PortalCallLogService;
  readonly caseService?: CaseService;
  readonly channelService?: ChannelService;
  readonly documentService?: DocumentService;
  readonly nativeAdmin?: NativeAdminService;
 readonly customsPackages?:CustomsPackages;
  readonly nativeFreightcom?: NativeFreightcomService;
  readonly businessAccessService?: BusinessAccessService;
  readonly businessMachineHandler?:PortalMachineHandler;
  readonly machineHandler?:PortalMachineHandler;
  readonly identityProvider?: PortalIdentityProvider;
  readonly sessionStore?: PortalSessionStore;
  readonly repositoryKind?: "synthetic" | "production";
  readonly host?: string;
  readonly port?: number;
  readonly publicOrigin?: string;
  readonly staticDirectory?: string;
  readonly sessionTtlMs?: number;
  readonly trustedProxyAddresses?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly runtimeStatus?: PortalRuntimeStatus;
  readonly businessJwks?: () => Promise<unknown>;
}
export interface StartedPortalServer { readonly server: Server; readonly host: string; readonly port: number; readonly origin: string; close(): Promise<void> }

function checkedPublicOrigin(value: string | undefined, fixture: boolean): URL | null {
  if (value===undefined) return null;
  let url:URL; try{url=new URL(value);}catch{throw new Error("portal_public_origin_invalid");}
  if(!url.hostname||url.username||url.password||url.pathname!=="/"||url.search||url.hash||(fixture?url.protocol!=="http:":url.protocol!=="https:"))throw new Error("portal_public_origin_invalid");
  return url;
}

function securityHeaders(response: ServerResponse, cache: string): void {
  response.setHeader("cache-control", cache); response.setHeader("x-content-type-options", "nosniff"); response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()"); response.setHeader("content-security-policy", CSP);
}
function sendJson(response:ServerResponse,status:number,value:unknown,head:boolean):void{response.statusCode=status;securityHeaders(response,"no-store");response.setHeader("content-type","application/json; charset=utf-8");response.end(head?undefined:JSON.stringify(value));}
function exactStaticPath(root: string, pathname: string, prefix = "/console/"): string | null {
  if (pathname.includes("%2f") || pathname.includes("%5c")) return null;
  let decoded: string; try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\\") || decoded.split("/").includes("..")) return null;
  const relative = decoded === prefix ? "index.html" : decoded.startsWith(prefix) ? decoded.slice(prefix.length) : "";
  if (!relative) return null; const candidate = resolve(root, relative); return candidate.startsWith(`${root}${sep}`) ? candidate : null;
}
function serveStatic(request: IncomingMessage, response: ServerResponse, root: string, allowedHost: string, prefix = "/console/"): void {
  if (request.headers.host !== allowedHost || !["GET", "HEAD"].includes(request.method ?? "")) { response.statusCode = request.headers.host === allowedHost ? 405 : 403; securityHeaders(response,"no-store"); response.end(); return; }
  const pathname = new URL(request.url ?? "/", "http://portal.invalid").pathname;
  if (pathname === prefix.slice(0,-1)) { response.statusCode=308; securityHeaders(response,"no-store"); response.setHeader("location",prefix); response.end(); return; }
  const file = exactStaticPath(root, pathname === "/inquiry/details/" ? "/inquiry/details/index.html" : pathname, prefix);
  if (!file || !existsSync(file) || !statSync(file).isFile()) { response.statusCode=404; securityHeaders(response,"no-store"); response.end(); return; }
  response.statusCode=200; securityHeaders(response, file.endsWith("index.html") ? "no-store" : "public, max-age=300"); response.setHeader("content-type",CONTENT_TYPE[extname(file)]??"application/octet-stream");
  if (request.method === "HEAD") { response.end(); return; } createReadStream(file).pipe(response);
}

export async function startPortalServer(options: StartPortalServerOptions): Promise<StartedPortalServer> {
  const host = options.host ?? "127.0.0.1"; const port = options.port ?? 8882; const fixture = options.mode === "fixtures";
  if (fixture && host !== "127.0.0.1" && host !== "::1") throw new Error("fixture_portal_requires_loopback");
  if (!fixture && options.machineHandler) throw new Error("fixture_machine_handler_forbidden");
  if (!fixture && options.businessAccessService && options.businessAccessService.repositoryKind !== "production") throw new Error("production_business_access_store_required");
  if (options.businessMachineHandler && !options.businessAccessService) throw new Error("business_access_service_required");
  if (!fixture && (!options.identityProvider || options.identityProvider.kind !== "oidc" || !options.identityProvider.begin || !options.identityProvider.complete)) throw new Error("production_identity_provider_required");
  if (!fixture && (!options.sessionStore || options.sessionStore.kind !== "persistent")) throw new Error("production_session_store_required");
  if (!fixture && options.repositoryKind !== "production") throw new Error("production_portal_store_required");
  if (!fixture && !options.publicOrigin) throw new Error("production_public_origin_required");
  const configuredOrigin=checkedPublicOrigin(options.publicOrigin,fixture);
  const identityProvider = options.identityProvider ?? new FixturePortalIdentityProvider({ mode: "fixtures", loopback: true });
  if (fixture && identityProvider.kind !== "fixture") throw new Error("fixture_identity_provider_required");
  const sessionStore = options.sessionStore ?? new InMemoryPortalSessionStore();
  const sessions = new PortalSessionManager({ store: sessionStore, ...(options.sessionTtlMs === undefined ? {} : { ttlMs: options.sessionTtlMs }), secureCookie: !fixture });
  const staticRoot = resolve(options.staticDirectory ?? "dist/console"); let portalHandler: ReturnType<typeof createPortalHttpHandler> | null = null; let allowedHost = "";
  const server = createServer((request,response)=>{ void (async()=>{
    const pathname=new URL(request.url??"/","http://portal.invalid").pathname;
    if(["/console/healthz","/console/readyz","/access/v2/business/jwks.json"].includes(pathname)){
      if(request.headers.host!==allowedHost){sendJson(response,403,{status:"blocked",reason_codes:["host_denied"]},request.method==="HEAD");return;}
      if(!["GET","HEAD"].includes(request.method??"")||(request.url??"")!==pathname){sendJson(response,405,{status:"blocked",reason_codes:["method_denied"]},request.method==="HEAD");return;}
      if(pathname==="/access/v2/business/jwks.json"){
        if(!options.businessJwks){sendJson(response,503,{status:"unavailable",reason_codes:["business_jwks_unavailable"]},request.method==="HEAD");return;}
        sendJson(response,200,await options.businessJwks(),request.method==="HEAD");return;
      }
      const identity={service:"freightclaw-portal",release_id:options.runtimeStatus?.releaseId??"unknown",build_id:options.runtimeStatus?.buildId??"unknown"};
      if(pathname==="/console/healthz"){sendJson(response,200,{status:"success",data:identity,reason_codes:[]},request.method==="HEAD");return;}
      if(!options.runtimeStatus){sendJson(response,503,{status:"unavailable",data:{...identity,ready:false,checks:null},reason_codes:["portal_readiness_unconfigured"]},request.method==="HEAD");return;}
      const readiness=await options.runtimeStatus.readiness();sendJson(response,readiness.ready?200:503,{status:readiness.ready?"success":"unavailable",data:{...identity,...readiness},reason_codes:readiness.ready?[]:["portal_dependencies_unready"]},request.method==="HEAD");return;
    }
    if(options.businessMachineHandler&&await options.businessMachineHandler.handle(request,response))return; if(options.machineHandler&&await options.machineHandler.handle(request,response))return; if (portalHandler && await portalHandler.handle(request,response)) return; serveStatic(request,response,pathname.startsWith("/inquiry/")||pathname==="/inquiry"?resolve(staticRoot,"../inquiry"):staticRoot,allowedHost,pathname.startsWith("/inquiry/")||pathname==="/inquiry"?"/inquiry/":"/console/"); })().catch(()=>{ if(!response.headersSent){response.statusCode=500;securityHeaders(response,"no-store");}response.end();}); });
  await new Promise<void>((resolveListen,reject)=>{server.once("error",reject);server.listen(port,host,()=>{server.off("error",reject);resolveListen();});});
  const address=server.address(); if(!address||typeof address==="string"){server.close();throw new Error("portal_address_unavailable");}
  const boundHost=`${host.includes(":")?`[${host}]`:host}:${address.port}`; const origin=configuredOrigin?.origin??`http://${boundHost}`;
  const publicUrl=configuredOrigin??new URL(origin);
  allowedHost=publicUrl.host;
  portalHandler=createPortalHttpHandler({...(options.customsPackages?{customsPackages:options.customsPackages}:{}),...(options.documentService?{documentService:options.documentService}:{}), ...(options.nativeFreightcom?{nativeFreightcom:options.nativeFreightcom}:{}), ...(options.nativeAdmin?{nativeAdmin:options.nativeAdmin}:{}), ...(options.channelService ? {channelService: options.channelService} : {}),...(options.caseService?{caseService:options.caseService}:{}),...(options.publicCustoms ? { publicCustoms: options.publicCustoms } : {}),mode:options.mode,service:options.service,...(options.bridge?{bridge:options.bridge}:{}),...(options.organizationBridge?{organizationBridge:options.organizationBridge}:{}),...(options.businessService?{businessService:options.businessService}:{}),...(options.businessAccessService?{businessAccessService:options.businessAccessService}:{}),...(options.callLogService?{callLogService:options.callLogService}:{}),identityProvider,sessions,allowedHosts:[allowedHost],allowedOrigins:[origin],allowLoopbackHttp:fixture,...(options.trustedProxyAddresses?{trustedProxyAddresses:options.trustedProxyAddresses}:{}),...(options.maxBodyBytes===undefined?{}:{maxBodyBytes:options.maxBodyBytes})});
  return {server,host,port:address.port,origin,close:()=>new Promise<void>((resolveClose,reject)=>server.close(error=>error?reject(error):resolveClose()))};
}
