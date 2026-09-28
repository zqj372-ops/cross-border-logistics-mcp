import {createAuthentikExecutionDirectory} from './fcl-execution-identity';
import type {PortalContext as FclScheduleContext} from './contracts';
import {createHash as fclScheduleHash} from 'node:crypto';
import {CustomsPackages} from '../../customs-native/packages';
import {DocumentStore,DocumentService} from '../../quote-documents/service';
import {DocumentWorkflowStore,DocumentWorkflowService} from '../../quote-documents/workflow';
import { NativeAdminStore, NativeAdminService } from './native-admin';
import { NativeFreightcomService } from './native-freightcom';
import { CaseStore, CaseService } from "./cases";
import { SqlitePublicQuotaStore } from "./public-quota";
import { PortalPublicCustomsService } from "./public-customs";
import { PostgresPortalStores } from "./postgres-stores";
import { PostgresCallLogStore } from "./postgres-call-log";
import { postgresConfigurationFromEnvironment } from "../postgres-store";
import type { PortalRepository } from "./store";
import type { PortalSessionStore } from "./session";
import type { BusinessAccessRepository } from "./business-access/store";
import type { CallLogRepository } from "./call-log";
import { SqliteCallLogStore, PortalCallLogService, callRecorder } from "./call-log";
import { ApplicationMcpAccessService } from "./business-access/mcp";
import { createApplicationMcpHttpHandler } from "./business-access/mcp-http";
import { JsonlScheduleLiveAuditSink } from "../../maritime/schedule-live/audit";
import { createProductionScheduleLiveService, parseScheduleLiveCarrierAllowlist, parseScheduleLiveTenantAllowlist } from "../../maritime/schedule-live/production";
import { SCHEDULE_MCP_TOOLS, type ScheduleMcpTool } from "../../../src/logistics_mcp/platform/application-tools";
import { readFileSync,lstatSync } from "node:fs";
import { isAbsolute,resolve } from "node:path";
import {isIP} from "node:net";
import { createLocalJWKSet,jwtVerify } from "jose";
import { createProductionAccessGateway } from "../assembly";
import { TenantAccessGatewayRepository } from "../production-store";
import { openGatewayStores } from "../store-runtime";
import { openGatewayCrypto } from "../crypto-runtime";
import { SystemGatewayClock,SystemGatewayRandomSource,UnavailableAdminIdentityProvider } from "../production-identity";
import { TenantAccessService } from "../../../src/logistics_mcp/control-plane/tenant-access-service";
import { parseExecutionContext } from "../../../src/logistics_mcp/platform/context";
import { PortalService } from "./service";
import { OrganizationService } from "./organization-service";
import { SqliteProductionPortalStore } from "./store";
import { SqlitePersistentPortalSessionStore } from "./session";
import { createProductionPortalIdentityProvider } from "./production-identity";
import { createPortalAccessBridge } from "./access-bridge";
import { createOrganizationBridge } from "./organization-bridge";
import { loadPortalBusinessService } from "./business/config";
import { SqliteProductionBusinessAccessStore } from "./business-access/store";
import { createProductionBusinessAccessCrypto } from "./business-access/production-crypto";
import { BusinessAccessService } from "./business-access/service";
import { createBusinessMachineHttpHandler } from "./business-access/http";
import {createProductionT0HttpHandler} from "./t0-http";
import { startPortalServer,type StartedPortalServer } from "./server";
import { createPortalRuntimeExecutor } from "./runtime-executor";
import {createAuthentikFclReceiverAuthority} from "./fcl-receiver-authority";
import {createFclSmtpTransport,FCL_SMTP_CHILD_TIMEOUT_MS,readFclSmtpConfigFile} from "./fcl-smtp-transport";
import {readPortalProductionDatabaseVersion} from "./production-persistence";
import type {FclHttpDependencies} from "./fcl-http";
import type {FclMailTransport} from "./cases";
import {composeProductionFcl} from "./production-fcl";

const req=(e:NodeJS.ProcessEnv,n:string)=>{const v=e[n]?.trim();if(!v)throw new Error(`${n} is required.`);return v;};
const list=(e:NodeJS.ProcessEnv,n:string)=>{const v=req(e,n).split(",").map(x=>x.trim());if(v.some(x=>!x)||new Set(v).size!==v.length)throw new Error(`${n} is invalid.`);return Object.freeze(v);};
const integer=(e:NodeJS.ProcessEnv,n:string,d:number)=>{const v=Number(e[n]??d);if(!Number.isSafeInteger(v)||v<1||v>65535)throw new Error(`${n} is invalid.`);return v;};
const flag=(e:NodeJS.ProcessEnv,n:string)=>{const value=e[n];if(value===undefined||value==="false")return false;if(value==="true")return true;throw new Error(`${n} is invalid.`);};
function secret(path:string){if(!isAbsolute(path))throw new Error("portal_secret_file_invalid");const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.size<1||s.size>65536)throw new Error("portal_secret_file_invalid");return readFileSync(path,"utf8").replace(/\r?\n$/u,"");}
function secureFclFile(path:string):void{try{const value=secret(path);if(value.length===0)throw new Error("portal_secret_file_invalid");}catch(error){if(error instanceof Error&&error.message==="portal_secret_file_invalid")throw error;throw new Error("portal_secret_file_invalid",{cause:error});}}

export function validateProductionPortalEnvironment(environment:NodeJS.ProcessEnv):void{
 if(flag(environment,"PORTAL_FCL_SCHEDULE_LIVE_ENABLED")&&!flag(environment,"PORTAL_FCL_ENABLED"))throw new Error("fcl_personal_schedule_configuration_invalid");
 const root=req(environment,"PORTAL_STATE_ROOT");if(!isAbsolute(root)||resolve(root)!==root)throw new Error("PORTAL_STATE_ROOT must be an absolute normalized path.");
 const origin=new URL(req(environment,"PORTAL_PUBLIC_ORIGIN"));if(origin.protocol!=="https:"||origin.pathname!=="/"||origin.search||origin.hash||origin.username||origin.password)throw new Error("PORTAL_PUBLIC_ORIGIN is invalid.");
 const operator=req(environment,"PORTAL_OIDC_OPERATOR_GROUP"),reviewer=req(environment,"PORTAL_OIDC_REVIEWER_GROUP");if(operator===reviewer)throw new Error("Portal OIDC role groups must be distinct.");
 if(list(environment,"PORTAL_TRUSTED_PROXY_ADDRESSES").some(value=>isIP(value)===0))throw new Error("PORTAL_TRUSTED_PROXY_ADDRESSES must contain IP addresses.");
 for(const name of ["PORTAL_OIDC_CLIENT_SECRET_FILE","PORTAL_BUSINESS_CONFIG_FILE","PORTAL_BUSINESS_PEPPER_FILE","PORTAL_BUSINESS_JWT_PRIVATE_KEY_FILE"]){const path=req(environment,name);if(!isAbsolute(path)){throw new Error(`${name} must be absolute.`);}const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`${name} is invalid.`);}
 for(const name of ["ACCESS_GATEWAY_APPLICATION_ROOT","ACCESS_GATEWAY_MANAGEMENT_TENANT_ID","ACCESS_GATEWAY_INSTANCE_ID","ACCESS_GATEWAY_JWT_ISSUER","ACCESS_GATEWAY_JWT_AUDIENCE","ACCESS_GATEWAY_PEPPER_VERSION","PORTAL_T0_REST_AUDIENCE","PORTAL_RELEASE_ID","PORTAL_BUILD_ID","PORTAL_OIDC_ISSUER","PORTAL_OIDC_CLIENT_ID","PORTAL_BUSINESS_TOKEN_ISSUER","PORTAL_BUSINESS_PEPPER_VERSION","PORTAL_BUSINESS_JWT_KEY_HISTORY_FILE"]){req(environment,name);}
 if(environment.PORTAL_T0_REST_AUDIENCE?.trim()===environment.ACCESS_GATEWAY_JWT_AUDIENCE?.trim())throw new Error("portal_t0_audience_not_isolated");
 const fclEnabled=flag(environment,"PORTAL_FCL_ENABLED");
 if(flag(environment,"PORTAL_FCL_EXECUTION_ENABLED")){if(!fclEnabled)throw new Error("fcl_execution_requires_fcl");secureFclFile(req(environment,"PORTAL_FCL_EXECUTION_DIRECTORY_FILE"));}
 if(fclEnabled){
  const quotePath=req(environment,"PORTAL_QUOTE_DOCUMENTS_SQLITE_PATH"),renderer=req(environment,"PORTAL_PDF_BROWSER_EXECUTABLE");
  if(!isAbsolute(quotePath)||resolve(quotePath)!==quotePath||!isAbsolute(renderer)||resolve(renderer)!==renderer)throw new Error("portal_fcl_path_invalid");
  req(environment,"PORTAL_FCL_RECEIVER_SUB");req(environment,"PORTAL_FCL_RECEIVER_AUTHORITY_URL");
  if(new URL(req(environment,"PORTAL_FCL_RECEIVER_AUTHORITY_URL")).origin!==new URL(req(environment,"PORTAL_OIDC_ISSUER")).origin)throw new Error("portal_fcl_authority_origin_mismatch");
  for(const name of ["PORTAL_FCL_RECEIVER_AUTHORITY_TOKEN_FILE","PORTAL_FCL_CASE_CREDENTIAL_SECRET_FILE","PORTAL_FCL_PUBLIC_SESSION_SECRET_FILE","PORTAL_FCL_SMTP_CONFIG_FILE"])secureFclFile(req(environment,name));
 }
}
export interface ProductionPortalRuntime{readonly server:StartedPortalServer;close():Promise<void>}
export async function startProductionPortal(environment:NodeJS.ProcessEnv=process.env):Promise<ProductionPortalRuntime>{
 validateProductionPortalEnvironment(environment);
 const root=resolve(req(environment,"PORTAL_STATE_ROOT")),management=req(environment,"ACCESS_GATEWAY_MANAGEMENT_TENANT_ID"),instance=req(environment,"ACCESS_GATEWAY_INSTANCE_ID"),issuer=req(environment,"ACCESS_GATEWAY_JWT_ISSUER"),audience=req(environment,"ACCESS_GATEWAY_JWT_AUDIENCE"),restAudience=req(environment,"PORTAL_T0_REST_AUDIENCE"),pepperVersion=req(environment,"ACCESS_GATEWAY_PEPPER_VERSION"),clock=new SystemGatewayClock(),random=new SystemGatewayRandomSource();if(audience===restAudience)throw new Error("portal_t0_audience_not_isolated");
 const casesEnabled=flag(environment,"PORTAL_CASES_ENABLED"),nativeEnabled=flag(environment,"PORTAL_NATIVE_BUSINESS_ENABLED"),fclEnabled=flag(environment,"PORTAL_FCL_ENABLED");
 const fclReceiverSub=fclEnabled?req(environment,"PORTAL_FCL_RECEIVER_SUB"):null;
 const fclCaseCredentialSecret=fclEnabled?secret(req(environment,"PORTAL_FCL_CASE_CREDENTIAL_SECRET_FILE")):null;
 const fclPublicSessionSecret=fclEnabled?secret(req(environment,"PORTAL_FCL_PUBLIC_SESSION_SECRET_FILE")):null;
 if(fclEnabled&&[Buffer.byteLength(fclCaseCredentialSecret!,'utf8'),Buffer.byteLength(fclPublicSessionSecret!,'utf8')].some(size=>size<32))throw new Error("portal_fcl_secret_invalid");
 const fclAuthority=fclEnabled?createAuthentikFclReceiverAuthority({expectedSub:fclReceiverSub!,oidcIssuer:req(environment,"PORTAL_OIDC_ISSUER"),endpoint:req(environment,"PORTAL_FCL_RECEIVER_AUTHORITY_URL"),token:secret(req(environment,"PORTAL_FCL_RECEIVER_AUTHORITY_TOKEN_FILE"))}):undefined;
 const fclMailTransport:FclMailTransport|undefined=fclEnabled?createFclSmtpTransport(readFclSmtpConfigFile(req(environment,"PORTAL_FCL_SMTP_CONFIG_FILE")),{timeoutMs:FCL_SMTP_CHILD_TIMEOUT_MS}):undefined;
 const executionEnabled=flag(environment,"PORTAL_FCL_EXECUTION_ENABLED");
 const executionDirectory=executionEnabled?createAuthentikExecutionDirectory(JSON.parse(secret(req(environment,"PORTAL_FCL_EXECUTION_DIRECTORY_FILE"))),req(environment,"PORTAL_OIDC_ISSUER"),secret(req(environment,"PORTAL_FCL_RECEIVER_AUTHORITY_TOKEN_FILE"))):undefined;
 let closeFcl:(()=>Promise<void>)|undefined;
 const personalScheduleEnabled=flag(environment,"PORTAL_FCL_SCHEDULE_LIVE_ENABLED");
 if(personalScheduleEnabled&&(!fclEnabled||!fclAuthority||!fclReceiverSub))throw new Error("fcl_personal_schedule_configuration_invalid");
 const personalScheduleAccess=personalScheduleEnabled?{perAccount:true,scopeId:`fcl-personal-${fclScheduleHash('sha256').update(fclReceiverSub!).digest('hex').slice(0,32)}`,authorize:async(ctx:FclScheduleContext)=>{
  if(!ctx.identity.emailVerified||!ctx.identity.userId.trim())return false;
  if(ctx.identity.userId!==fclReceiverSub)return true;
  return fclAuthority!.runVerified(proof=>proof.sub===ctx.identity.userId);
 }}:undefined;
 const scheduleLiveTenants=parseScheduleLiveTenantAllowlist(environment.PORTAL_SCHEDULE_LIVE_TENANT_ALLOWLIST);
 const stores=await openGatewayStores({environment,applicationRoot:req(environment,"ACCESS_GATEWAY_APPLICATION_ROOT"),instanceId:instance,managementTenantId:management});let crypto:Awaited<ReturnType<typeof openGatewayCrypto>>|undefined;let publicQuota:SqlitePublicQuotaStore|undefined;let shared:PostgresPortalStores|undefined;let portalStore:PortalRepository|undefined,sessionStore:(PortalSessionStore&{close():void})|undefined,businessStore:BusinessAccessRepository|undefined,server:StartedPortalServer|undefined,callStore:CallLogRepository|undefined;let caseStore:CaseStore|undefined,caseService:CaseService|undefined;let documentStore:DocumentStore|undefined,documentService:DocumentService|undefined,documentWorkflowStore:DocumentWorkflowStore|undefined,documentWorkflowService:DocumentWorkflowService|undefined;
let nativeStore:NativeAdminStore|undefined,nativeAdminService:NativeAdminService|undefined,nativeFreightcom:NativeFreightcomService|undefined,scheduleLive:ReturnType<typeof createProductionScheduleLiveService>|undefined,fclDependencies:FclHttpDependencies|undefined;
 try{const state=await stores.tenantStore.getState();crypto=await openGatewayCrypto({environment,applicationRoot:req(environment,"ACCESS_GATEWAY_APPLICATION_ROOT"),pepperVersion,requiredPepperVersions:Object.freeze([...new Set([pepperVersion,...state.credentials.map(x=>x.pepperVersion)])]),keyRetentionSeconds:1230,nowSeconds:()=>clock.nowSeconds()});
 const gatewayProviders={adminIdentityProvider:new UnavailableAdminIdentityProvider(),auditRepository:stores.operationalStore,clock,credentialRepository:new TenantAccessGatewayRepository({store:stores.tenantStore,nowSeconds:()=>clock.nowSeconds()}),jwtSigningProvider:crypto.signer,randomSource:random,rateLimitRepository:stores.operationalStore,revocationRepository:new TenantAccessGatewayRepository({store:stores.tenantStore,nowSeconds:()=>clock.nowSeconds()}),secretPepperProvider:crypto.pepper},tenant=new TenantAccessService(stores.tenantStore,{credentialSecretProvider:{pepperVersion:crypto.pepper.pepperVersion,hash:(s,x)=>crypto!.pepper.hashCredentialSecret({secret:s,salt:x,pepperVersion:crypto!.pepper.pepperVersion}),verify:(s,x,h,v)=>crypto!.pepper.verifyCredentialSecret({secret:s,material:{salt:x,expectedHash:h,pepperVersion:v}})}}),restGateway=createProductionAccessGateway(gatewayProviders,{issuer,audience:restAudience}),mcpGateway=createProductionAccessGateway(gatewayProviders,{issuer,audience});
 const backend=environment.PORTAL_STORE_BACKEND?.trim()||"sqlite";if(!["sqlite","postgresql"].includes(backend))throw new Error("portal_store_backend_invalid");if(backend==="postgresql")shared=new PostgresPortalStores({configuration:postgresConfigurationFromEnvironment(environment)});
 portalStore=shared?.portal??new SqliteProductionPortalStore({databasePath:resolve(root,"portal.sqlite")});sessionStore=shared?.sessions??new SqlitePersistentPortalSessionStore({databasePath:resolve(root,"sessions.sqlite")});businessStore=shared?.business??new SqliteProductionBusinessAccessStore({databasePath:resolve(root,"business-access.sqlite")});const portal=new PortalService({repository:portalStore,dataMode:"production"}),organizations=new OrganizationService({repository:portalStore}),admin=()=>parseExecutionContext({tenant_id:management,actor_id:"portal_production_bridge",actor_role:"admin",roles:["admin"],scopes:["platform:admin","tenant:admin"],client_id:"portal_production_bridge",session_id:`portal_${clock.nowSeconds()}`,expires_at:clock.nowSeconds()+60}),signingKeys=await crypto.signer.getJwks(),jwks=createLocalJWKSet({keys:signingKeys.keys.map(key=>({...key}))});
 const organizationBridge=createOrganizationBridge({organizationService:organizations,tenantAccessService:tenant,internalAdminContext:admin});
 if(casesEnabled||fclEnabled){if(shared)throw new Error("cases_shared_store_unavailable");const path=resolve(root,"business-cases.sqlite"),version=readPortalProductionDatabaseVersion(path,"freightclaw-business-cases");if(fclEnabled&&version!==(executionEnabled?3:2))throw new Error("fcl_schema_not_upgraded");caseStore=new CaseStore(path,(version??0)>=2?{fcl:{mode:"reopen" as const},...(executionEnabled?{execution:{mode:"reopen" as const}}:{})}:undefined);if(!fclEnabled&&casesEnabled)caseService=new CaseService(caseStore,portal);}
 callStore=shared?await PostgresCallLogStore.open(postgresConfigurationFromEnvironment(environment)):new SqliteCallLogStore(resolve(root,"calls.sqlite"));
 if(nativeEnabled||fclEnabled){if(shared)throw new Error("native_shared_store_unavailable");const path=resolve(root,"native-business.sqlite"),version=readPortalProductionDatabaseVersion(path,"freightclaw-native-business");if(fclEnabled&&version!==3)throw new Error("fcl_schema_not_upgraded");nativeStore=new NativeAdminStore(path,version===3?{fcl:{mode:"reopen" as const}}:undefined);if(nativeEnabled){nativeAdminService=new NativeAdminService(nativeStore,portal);nativeFreightcom=new NativeFreightcomService(nativeStore,portal);nativeStore.packages=new CustomsPackages(nativeStore,portal,resolve(root,'customs-inbox'));}}
 const business=await loadPortalBusinessService({...(nativeEnabled&&nativeFreightcom?{nativeStore:nativeStore!,nativeFreightcom,nativeQuoteScript:resolve("dist/services/quote-native/run.py")} : {}),publicAuthority:async binding=>{const current=await tenant.getState(admin());if(!current.data.tenants.some(t=>t.tenant_id===binding.tenantId&&t.status==="active")||!current.data.clients.some(c=>c.tenant_id===binding.tenantId&&c.client_id===binding.clientId&&c.status==="active"))throw new Error("public_publisher_inactive");},callRecorder:callRecorder(callStore),portalService:portal,configPath:req(environment,"PORTAL_BUSINESS_CONFIG_FILE")}),businessCrypto=await createProductionBusinessAccessCrypto({issuer:req(environment,"PORTAL_BUSINESS_TOKEN_ISSUER"),pepper:{pepperPath:req(environment,"PORTAL_BUSINESS_PEPPER_FILE"),pepperVersion:req(environment,"PORTAL_BUSINESS_PEPPER_VERSION"),...(environment.PORTAL_BUSINESS_PEPPER_HISTORY_FILE?{historyPath:req(environment,"PORTAL_BUSINESS_PEPPER_HISTORY_FILE")}:{})},jwt:{privateKeyPath:req(environment,"PORTAL_BUSINESS_JWT_PRIVATE_KEY_FILE"),historyPath:req(environment,"PORTAL_BUSINESS_JWT_KEY_HISTORY_FILE"),nowSeconds:()=>clock.nowSeconds(),retentionSeconds:integer(environment,"PORTAL_BUSINESS_JWT_RETENTION_SECONDS",1230)}}),businessAccess=new BusinessAccessService({repository:businessStore,portalService:portal,secretProvider:businessCrypto.secretProvider,tokenSigner:businessCrypto.tokenSigner,tokenVerifier:businessCrypto.tokenVerifier,operationAuthority:{isAvailable:(t,o)=>SCHEDULE_MCP_TOOLS.includes(o as ScheduleMcpTool)?scheduleLiveTenants.includes(t):business.isAvailable(t,o as never)},tenantClientAuthority:{requireActive:async(t,c)=>{const x=await tenant.getState(admin());if(!x.data.tenants.some(v=>v.tenant_id===t&&v.status==="active")||!x.data.clients.some(v=>v.tenant_id===t&&v.client_id===c&&v.status==="active"))throw new Error("business_tenant_client_denied");}},issuer:req(environment,"PORTAL_BUSINESS_TOKEN_ISSUER")}),bridge=createPortalAccessBridge({dataMode:"production",portalService:portal,tenantAccessService:tenant,accessGateway:restGateway,applicationTokenIssuer:mcpGateway,applicationCredentialAuthority:businessAccess,internalAdminContext:admin,tokenVerifier:{verify:async token=>(await jwtVerify(token,jwks,{algorithms:["RS256"],issuer,audience:restAudience})).payload},restTokenPolicy:{issuer,audience:restAudience,maxLifetimeSeconds:900},applicationTokenVerifier:{verify:async token=>(await jwtVerify(token,jwks,{algorithms:["RS256"],issuer,audience})).payload},applicationTokenPolicy:{issuer,audience,maxLifetimeSeconds:900},exchangeAudience:audience,runtimeExecutor:createPortalRuntimeExecutor({url:new URL("/mcp",req(environment,"PORTAL_PUBLIC_ORIGIN")).href,allowedHosts:[new URL(req(environment,"PORTAL_PUBLIC_ORIGIN")).host],issuer,audience,signer:crypto.signer})});
 const origin=req(environment,"PORTAL_PUBLIC_ORIGIN"),host=new URL(origin).host,trusted=list(environment,"PORTAL_TRUSTED_PROXY_ADDRESSES"),t0Machine=createProductionT0HttpHandler({bridge,authorityHealth:async()=>{portalStore!.read();businessStore!.read();await tenant.getState(admin());return true;},allowedHosts:[host],trustedProxyAddresses:trusted}),machine=createBusinessMachineHttpHandler({mode:"production",service:businessAccess,executor:{execute:r=>business.executeMachine(r as never)},allowedHosts:[host],allowedOrigins:[origin],trustedProxyAddresses:trusted});
 const mcpAccess=new ApplicationMcpAccessService({authority:businessAccess,signer:crypto.signer,verifier:{verify:async token=>(await jwtVerify(token,jwks,{algorithms:["RS256"],issuer,audience})).payload},limiter:gatewayProviders.rateLimitRepository,issuer,audience});
 if(scheduleLiveTenants.length>0||personalScheduleAccess){const evidenceRoot=environment.PORTAL_SCHEDULE_LIVE_EVIDENCE_ROOT?.trim()||resolve(root,"schedule-collector","evidence"),auditPath=environment.PORTAL_SCHEDULE_LIVE_AUDIT_PATH?.trim()||resolve(root,"schedule-collector","audit.jsonl");if(!isAbsolute(evidenceRoot)||!isAbsolute(auditPath))throw new Error("schedule_live_path_must_be_absolute");scheduleLive=createProductionScheduleLiveService({portal,...(personalScheduleAccess?{personalAccess:personalScheduleAccess}:{}),audit:new JsonlScheduleLiveAuditSink(auditPath),evidenceRoot,tenantAllowlist:scheduleLiveTenants,carrierAllowlist:parseScheduleLiveCarrierAllowlist(environment.PORTAL_SCHEDULE_LIVE_CARRIER_ALLOWLIST)});}
 const mcpMachine=environment.PORTAL_MCP_PROVIDER_SECRET_FILE?createApplicationMcpHttpHandler({mode:"production",service:businessAccess,executor:{execute:async r=>{if(SCHEDULE_MCP_TOOLS.includes(r.operation as ScheduleMcpTool)){if(!scheduleLive)throw new Error("schedule_live_unavailable");const result=await scheduleLive.machineExecute({tool:r.operation as ScheduleMcpTool,tenantId:r.machine.tenantId,actorId:r.machine.credentialId,input:r.input,requestId:r.requestId});return result.body;}return business.executeMachine({...r,recordCall:false} as never);}},mcpAccess,providerHealth:async()=>{portalStore!.read();businessStore!.read();return(await callStore!.health()).ready;},runtimeSecret:secret(req(environment,"PORTAL_MCP_PROVIDER_SECRET_FILE")),allowedHosts:[host],allowedOrigins:[origin],trustedProxyAddresses:trusted}):undefined;
 const identity=createProductionPortalIdentityProvider({issuer:req(environment,"PORTAL_OIDC_ISSUER"),clientId:req(environment,"PORTAL_OIDC_CLIENT_ID"),clientSecret:secret(req(environment,"PORTAL_OIDC_CLIENT_SECRET_FILE")),callbackUrl:`${origin}/console/auth/callback`,roleClaimMap:{[req(environment,"PORTAL_OIDC_OPERATOR_GROUP")]:"operator",[req(environment,"PORTAL_OIDC_REVIEWER_GROUP")]:"reviewer"}});
 if (business.publicConfigured && shared) throw new Error("public_quota_shared_store_required");
 const publicCustoms = business.publicConfigured ? new PortalPublicCustomsService({ business, quota: publicQuota = new SqlitePublicQuotaStore(resolve(root, "public-quota.sqlite")) }) : undefined;
 if(environment.PORTAL_QUOTE_DOCUMENTS_SQLITE_PATH){
  if(shared)throw new Error("documents_shared_store_unavailable");
  const path=req(environment,"PORTAL_QUOTE_DOCUMENTS_SQLITE_PATH"),version=readPortalProductionDatabaseVersion(path,"freightclaw-quote-documents");
  if(fclEnabled&&version!==5)throw new Error("fcl_schema_not_upgraded");
  const fclStore=version===5?{fcl:{mode:"reopen" as const}}:undefined;
  documentStore=new DocumentStore(path,fclStore);
  documentWorkflowStore=new DocumentWorkflowStore(documentStore,{oldWritersStopped:environment.PORTAL_QUOTE_WORKFLOW_OLD_WRITERS_STOPPED==='true',...(version===5?{fcl:{mode:"reopen" as const}}:{})});
  if(!fclEnabled){
   documentService=new DocumentService(documentStore,portal,undefined,nativeEnabled?{business,current:org=>nativeStore!.current(org,'residential')}:undefined,caseService);
   documentWorkflowService=new DocumentWorkflowService(documentWorkflowStore,documentService,portal);
  }
 }
 if(fclEnabled){
  if(!caseStore||!nativeStore||!documentStore||!documentWorkflowStore||!fclAuthority||!fclMailTransport)throw new Error("fcl_production_composition_invalid");
  const composed=await composeProductionFcl({publicOrigin:new URL(origin).origin,...(executionDirectory?{executionDirectory}:{}),portal,caseStore,nativeStore,documentStore,documentWorkflowStore,receiverSub:fclReceiverSub!,authority:fclAuthority,mailTransport:fclMailTransport,caseCredentialSecret:fclCaseCredentialSecret!,publicSessionSecret:fclPublicSessionSecret!,...(nativeEnabled?{nativeBusiness:{business,current:org=>nativeStore!.current(org,'residential')}}:{})});
  closeFcl=composed.close;caseService=composed.caseService;nativeAdminService=composed.nativeAdmin;documentService=composed.documentService;documentWorkflowService=composed.documentWorkflow;fclDependencies=composed.fcl;
 }
 server=await startPortalServer({...(documentService?{documentService}:{}),...(documentWorkflowService?{documentWorkflowService}:{}),...(nativeEnabled&&nativeStore?{customsPackages:nativeStore.packages!,nativeAdmin:nativeAdminService!,nativeFreightcom:nativeFreightcom!}:{}),...(scheduleLive?{scheduleLive}:{}),...(casesEnabled&&caseService?{caseService}:{}),...(fclEnabled&&fclDependencies?{fcl:fclDependencies}:{}),...(publicCustoms ? { publicCustoms } : {}),mode:"production",service:portal,bridge,organizationBridge,callLogService:new PortalCallLogService(callStore,portal),businessService:business,businessAccessService:businessAccess,businessMachineHandler:{handle:(req,res)=>(mcpMachine?.handle(req,res)??false)||t0Machine.handle(req,res)||machine.handle(req,res)},identityProvider:identity,sessionStore,repositoryKind:"production",host:environment.PORTAL_HOST?.trim()||"0.0.0.0",port:integer(environment,"PORTAL_PORT",8082),publicOrigin:origin,staticDirectory:environment.PORTAL_STATIC_DIRECTORY?.trim()||"dist/console",trustedProxyAddresses:trusted,businessJwks:businessCrypto.getJwks,runtimeStatus:{releaseId:req(environment,"PORTAL_RELEASE_ID"),buildId:req(environment,"PORTAL_BUILD_ID"),readiness:async()=>{const checks={...(caseStore?{cases_database:caseStore.health()}:{}),...(documentStore?{quote_documents_database:documentStore.health()}:{}),...(documentWorkflowStore?{quote_workflow_database:documentWorkflowStore.health()}:{}),...(fclEnabled?{fcl_receiver_authority:false}:{}),portal_database:false,session_database:false,business_access_database:false,identity:false,business_configuration:false,call_log_database:false};try{portal.getState({identity:{userId:"health",displayName:"health",email:"health@invalid.test",emailVerified:true,platformRole:null},organizationId:null});checks.portal_database=true;}catch{checks.portal_database=false;}try{sessionStore!.get("health_probe");checks.session_database=true;}catch{checks.session_database=false;}try{businessStore!.read();checks.business_access_database=true;}catch{checks.business_access_database=false;}checks.call_log_database=(await callStore!.health()).ready;
 if (publicQuota) { try { publicQuota.read("127.0.0.1", Date.now()); } catch { checks.business_configuration=false; return {ready:false,checks}; } }
	checks.identity=await identity.health();if(fclEnabled){try{await fclAuthority!.runVerified(()=>undefined);checks.fcl_receiver_authority=true;}catch{checks.fcl_receiver_authority=false;}}checks.business_configuration=true;const tenantReady=await tenant.getState(admin()).then(()=>true,()=>false);return{ready:tenantReady&&Object.values(checks).every(Boolean),checks};}}});let closed=false;return Object.freeze({server,close:async()=>{if(closed)return;closed=true;await server!.close();await closeFcl?.();publicQuota?.close();documentStore?.close();caseStore?.close();nativeFreightcom?.close();nativeStore?.close();await callStore!.close();businessStore!.close();sessionStore!.close();portalStore!.close();shared?.close();await Promise.all([crypto!.close(),stores.close()]);}});
 }catch(error){await closeFcl?.();publicQuota?.close();documentStore?.close();caseStore?.close();nativeFreightcom?.close();nativeStore?.close();if(server)await server.close().catch(()=>undefined);await callStore?.close().catch(()=>undefined);businessStore?.close();sessionStore?.close();portalStore?.close();shared?.close();if(crypto)await crypto.close().catch(()=>undefined);await stores.close().catch(()=>undefined);throw error;}
}
