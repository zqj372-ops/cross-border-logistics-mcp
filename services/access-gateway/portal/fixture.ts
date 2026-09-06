import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { createLocalJWKSet, jwtVerify } from "jose";

import { createAccessGateway } from "../service";
import { TenantAccessGatewayRepository } from "../production-store";
import { createSyntheticAccessGatewayFixture } from "../synthetic";
import { createPortalAccessBridge, type PortalAccessBridge } from "./access-bridge";
import { FIXTURE_PORTAL_IDENTITIES } from "./identity";
import { createOrganizationBridge, type OrganizationBridge } from "./organization-bridge";
import { OrganizationService } from "./organization-service";
import { PortalService } from "./service";
import { SqliteSyntheticPortalStore } from "./store";
import { createAgentAccessRuntime, agentContextToolContract } from "../../../src/logistics_mcp/agent-context/runtime";
import { cargoToolContract, cargoToolHandler } from "../../../src/logistics_mcp/domains/cargo/tool";
import { containerPlanSummaryHandler, containerPlanSummaryToolContract } from "../../../src/logistics_mcp/domains/container/service";
import { parseExecutionContext } from "../../../src/logistics_mcp/platform/context";
import { initializeSqliteTenantAccessState, SqliteTenantAccessStore, tenantAccessPaths } from "../../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import { TENANT_ACCESS_SCHEMA_VERSION, TenantAccessService } from "../../../src/logistics_mcp/control-plane/tenant-access-service";
import type { ToolDefinition } from "../../../src/logistics_mcp/server/tool-registry";
import type { PortalContext, PortalIdentity, PortalRole } from "./contracts";
import type { BusinessAccessService } from "./business-access/service";

const INSTANCE_ID="portal_fixture";
const MANAGEMENT_TENANT_ID="tenant_management_fixture";
const ORGANIZATION_ID="org_fixture";
const TENANT_ID="tenant_fixture";
const ISSUER="https://fixture-access.example.invalid/";
const AUDIENCE="logistics-mcp";

export interface CreatePortalFixtureRuntimeOptions { readonly databaseDirectory:string; readonly nowSeconds?:number }
export interface PortalFixtureRuntime {
  readonly service:PortalService;
  readonly bridge:PortalAccessBridge;
  readonly organizationBridge:OrganizationBridge;
  createUnifiedBridge(authority:Pick<BusinessAccessService,"authorizeT0ApiKey"|"authorizeT0Credential"|"exchangeApplicationToken">):PortalAccessBridge;
  requireActiveTenantClient(tenantId:string,clientId:string):Promise<void>;
  readonly databaseFiles:Readonly<{portal:string;tenantAccess:string}>;
  close():Promise<void>;
}

function fixtureIdentity(userId:string):PortalIdentity {
  const value=FIXTURE_PORTAL_IDENTITIES.find(identity=>identity.userId===userId);
  if(!value)throw new Error("fixture_identity_missing");
  return value;
}
function context(identity:PortalIdentity,organizationId:string|null):PortalContext{return {identity,organizationId};}
function internalAdmin(nowSeconds:number){return parseExecutionContext({tenant_id:MANAGEMENT_TENANT_ID,actor_id:"portal_fixture_bridge",actor_role:"admin",roles:["admin"],scopes:["platform:admin","tenant:admin"],client_id:"portal_fixture_bridge",session_id:"portal_fixture_session",expires_at:Math.max(nowSeconds,Math.floor(Date.now()/1_000))+86_400});}

function t0Definitions():readonly ToolDefinition[]{
  const runtime=createAgentAccessRuntime();
  const common={kind:"read" as const,statusMapping:["success","needs_input","manual_review","blocked","unavailable"] as const};
  return Object.freeze([
    {...common,name:"cargo.calculate",title:"货物计算",description:"确定性货物与计费重计算",inputSchemaId:"cargo-input",outputSchemaId:"cargo-output",permission:"quote:calculate",handler:cargoToolHandler,inputSchema:cargoToolContract.inputSchema,validateOutput:cargoToolContract.validateOutput},
    {...common,name:"container.plan_summary",title:"装柜摘要",description:"确定性装柜计划摘要",inputSchemaId:"container-input",outputSchemaId:"container-output",permission:"container:calculate",handler:containerPlanSummaryHandler,inputSchema:containerPlanSummaryToolContract.inputSchema,validateOutput:containerPlanSummaryToolContract.validateOutput},
    {...common,name:"system.agent_context.get",title:"Agent 上下文",description:"读取当前受控 Agent 上下文",inputSchemaId:"agent-context-input",outputSchemaId:"agent-context-output",permission:"system:agent_context",handler:(input,executionContext)=>runtime.getContext(input,executionContext),inputSchema:agentContextToolContract.inputSchema,validateOutput:agentContextToolContract.validateOutput},
  ]);
}

function seedPortal(service:PortalService):void{
  const operator=fixtureIdentity("fixture-operator");
  const owner=fixtureIdentity("fixture-owner");
  const developer=fixtureIdentity("fixture-developer");
  service.bootstrapOrganization(context(operator,null),{idempotencyKey:"fixture-seed-org-0001",input:{organizationId:ORGANIZATION_ID,tenantId:TENANT_ID,displayName:"示例物流企业"}});
  const operatorOrganization=context(operator,ORGANIZATION_ID);
  const invite=(identity:PortalIdentity,role:PortalRole,key:string)=>{
    const invitation=service.inviteMember(operatorOrganization,{idempotencyKey:`${key}-invite`,input:{email:identity.email,role,expiresAt:"2099-12-31T23:59:59.000Z"}}).data as {invitationId:string};
    service.claimInvitation(context(identity,null),invitation.invitationId,`${key}-claim0`);
  };
  invite(owner,"owner","fixture-seed-owner-01");
  invite(developer,"developer","fixture-seed-developer-01");
  service.changeMembership(context(owner,ORGANIZATION_ID),operator.userId,{idempotencyKey:"fixture-seed-operator-suspend",input:{status:"suspended"}});
  service.inviteMember(context(owner,ORGANIZATION_ID),{idempotencyKey:"fixture-seed-sales-invite",input:{email:fixtureIdentity("fixture-sales").email,role:"viewer",expiresAt:"2099-12-31T23:59:59.000Z"}});
}

export async function createPortalFixtureRuntime(options:CreatePortalFixtureRuntimeOptions):Promise<PortalFixtureRuntime>{
  if(options.nowSeconds!==undefined&&(!Number.isSafeInteger(options.nowSeconds)||options.nowSeconds<0))throw new Error("fixture_clock_invalid");
  const frozen=options.nowSeconds!==undefined;
  const clock=()=>options.nowSeconds??Math.floor(Date.now()/1_000);
  const nowSeconds=clock();
  const databaseDirectory=resolve(options.databaseDirectory);
  mkdirSync(databaseDirectory,{recursive:true,mode:0o700});
  const accessPaths=tenantAccessPaths(databaseDirectory);
  if(!existsSync(accessPaths.databasePath)&&!existsSync(accessPaths.markerPath))await initializeSqliteTenantAccessState({applicationRoot:databaseDirectory,instanceId:INSTANCE_ID,managementTenantId:MANAGEMENT_TENANT_ID});
  const tenantStore=new SqliteTenantAccessStore({applicationRoot:databaseDirectory,instanceId:INSTANCE_ID,managementTenantId:MANAGEMENT_TENANT_ID});
  const portalPath=join(databaseDirectory,"portal.sqlite");
  const portalStore=new SqliteSyntheticPortalStore({databasePath:portalPath});
  try{
    const crypto=createSyntheticAccessGatewayFixture({nowSeconds});
    const tenantService=new TenantAccessService(tenantStore,{clock,credentialSecretProvider:{pepperVersion:crypto.pepper.version,hash:(secret,salt)=>crypto.pepper.hashCredentialSecret({secret,salt,pepperVersion:crypto.pepper.version}),verify:(secret,salt,expectedHash,pepperVersion)=>crypto.pepper.verifyCredentialSecret({secret,material:{salt,expectedHash,pepperVersion}})}});
    const gatewayRepository=new TenantAccessGatewayRepository({store:tenantStore,nowSeconds:clock});
    const gateway=createAccessGateway({...crypto.providers,clock:{kind:"synthetic",nowSeconds:clock},credentialRepository:gatewayRepository,revocationRepository:gatewayRepository},{issuer:ISSUER,audience:AUDIENCE});
    const service=new PortalService({repository:portalStore,dataMode:"fixtures",now:()=>new Date(clock()*1_000).toISOString()});
    const organizationService=new OrganizationService({repository:portalStore,now:()=>new Date(clock()*1_000).toISOString()});
    const organizationBridge=createOrganizationBridge({organizationService,tenantAccessService:tenantService,internalAdminContext:internalAdmin(nowSeconds)});
    const signingJwks=await crypto.signer.getJwks();
    const jwks=createLocalJWKSet({keys:signingJwks.keys.map(key=>({...key}))});
    const createBridge=(applicationCredentialAuthority?:Pick<BusinessAccessService,"authorizeT0ApiKey"|"authorizeT0Credential"|"exchangeApplicationToken">)=>createPortalAccessBridge({dataMode:"fixtures",portalService:service,tenantAccessService:tenantService,accessGateway:gateway,...(applicationCredentialAuthority===undefined?{}:{applicationCredentialAuthority,applicationTokenVerifier:{verify:async(token:string)=>(await jwtVerify(token,jwks,{algorithms:["RS256"],...(frozen?{currentDate:new Date(nowSeconds*1_000)}:{})})).payload},applicationTokenPolicy:{issuer:ISSUER,audience:AUDIENCE,...(frozen?{nowSeconds}:{}),maxLifetimeSeconds:900}}),internalAdminContext:internalAdmin(nowSeconds),tokenVerifier:{verify:async(token:string)=>(await jwtVerify(token,jwks,{algorithms:["RS256"],...(frozen?{currentDate:new Date(nowSeconds*1_000)}:{})})).payload},restTokenPolicy:{issuer:ISSUER,audience:AUDIENCE,...(frozen?{nowSeconds}:{}),maxLifetimeSeconds:900},exchangeAudience:AUDIENCE,t0Definitions:t0Definitions()});
    const bridge=createBridge();
    await tenantService.createTenant(internalAdmin(nowSeconds),{schema_version:TENANT_ACCESS_SCHEMA_VERSION,tenant_id:TENANT_ID,display_name:"示例物流企业"},"fixture-seed-tenant-0001");
    seedPortal(service);
    let closed=false;
    const requireActiveTenantClient=async(tenantId:string,clientId:string)=>{
      const state=await tenantService.getState(internalAdmin(clock()));
      if(!state.data.tenants.some(x=>x.tenant_id===tenantId&&x.status==="active")||!state.data.clients.some(x=>x.client_id===clientId&&x.tenant_id===tenantId&&x.status==="active"))throw new Error("business_tenant_client_denied");
    };
    return Object.freeze({service,bridge,organizationBridge,createUnifiedBridge:(authority:Pick<BusinessAccessService,"authorizeT0ApiKey"|"authorizeT0Credential"|"exchangeApplicationToken">)=>createBridge(authority),requireActiveTenantClient,databaseFiles:Object.freeze({portal:portalPath,tenantAccess:accessPaths.databasePath}),close:async()=>{if(closed)return;closed=true;try{portalStore.close();}finally{await tenantStore.close();}}});
  }catch(error){try{portalStore.close();}finally{await tenantStore.close();}throw error;}
}
