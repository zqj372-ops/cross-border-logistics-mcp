import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBusinessAccessFixture } from "../../services/access-gateway/portal/business-access/fixture";
import type { PortalContext, PortalIdentity } from "../../services/access-gateway/portal/contracts";
import { createPortalFixtureRuntime } from "../../services/access-gateway/portal/fixture";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const identity=(userId:string,platformRole:null|"reviewer"|"operator"):PortalIdentity=>({userId,displayName:userId,email:`${userId}@example.test`,emailVerified:true,platformRole});
const context=(value:PortalIdentity,organizationId:string|null):PortalContext=>({identity:value,organizationId});

describe("unified application Key integration",()=>{
  it("uses one flcbk credential for current T0 and Business grants and invalidates its MCP token after revocation",async()=>{
    const root=mkdtempSync(join(tmpdir(),"unified-application-key-"));roots.push(root);
    const runtime=await createPortalFixtureRuntime({databaseDirectory:root});
    const owner=context(identity("fixture-owner",null),"org_fixture"),reviewer=context(identity("fixture-reviewer","reviewer"),"org_fixture"),operator=context(identity("fixture-operator","operator"),"org_fixture");
    const application=await runtime.bridge.createApplication(owner,{idempotencyKey:"unified-create-app01",input:{name:"Unified",purpose:"Agent",environment:"test"}}).then(result=>result.data as {applicationId:string;clientId:string});
    const t0Request=runtime.service.createRequest(owner,{idempotencyKey:"unified-t0-request1",input:{requestId:"request_unified_t0",applicationId:application.applicationId,capabilities:["cargo.calculate","system.agent_context.get"],justification:"MCP"}}).data as {requestId:string};
    runtime.service.submitRequest(owner,t0Request.requestId,1,"unified-t0-submit01");
    const t0Grant=runtime.service.decideRequest(reviewer,t0Request.requestId,{idempotencyKey:"unified-t0-review01",expectedVersion:2,input:{decision:"approve",reason:"ok"}}).data as {grant:{grantId:string}};
    runtime.service.markGrantActive(operator,t0Grant.grant.grantId,{idempotencyKey:"unified-t0-active01",expectedVersion:1,input:{provisionedRef:`client:${application.clientId}`}});

    const business=await createBusinessAccessFixture({databasePath:join(root,"unified-business.sqlite"),portalService:runtime.service,credentialPepper:new Uint8Array(32).fill(7),operationAuthority:{isAvailable:()=>true},tenantClientAuthority:{requireActive:(tenantId,clientId)=>runtime.requireActiveTenantClient(tenantId,clientId)}});
    const request=business.service.createRequest(owner,{idempotencyKey:"unified-business-request1",input:{applicationId:application.applicationId,operations:["customs.query"],justification:"API"}}).data!;
    business.service.submitRequest(owner,request.requestId,1,"unified-business-submit");
    const decision=business.service.decideRequest(context(identity("fixture-reviewer","reviewer"),null),request.requestId,{idempotencyKey:"unified-business-review",expectedVersion:2,input:{decision:"approve",reason:"ok"}}).data!;
    await business.service.activateGrant(context(identity("fixture-operator","operator"),null),decision.grant!.grantId,{idempotencyKey:"unified-business-active",expectedVersion:1,input:{}});
    const issued=await business.service.issueCredential(owner,application.applicationId,{idempotencyKey:"unified-key-issue001",input:{label:"Unified",operations:["customs.query"],t0Mode:"current_grant",expiresInSeconds:3600}});
    const key=issued.data!.api_key!,credential=issued.data!.credential;
    business.service.acknowledgeCredential(owner,credential.credentialId,{idempotencyKey:"unified-key-ack0001",expectedVersion:1,input:{}});
    const bridge=runtime.createUnifiedBridge(business.service);

    await expect(business.service.authorizeApiKey(key,"customs.query")).resolves.toMatchObject({applicationId:application.applicationId});
    await expect(bridge.executeT0WithApplicationKey({apiKey:key,toolName:"system.agent_context.get",input:{profile_id:"runtime-caller"}})).resolves.toMatchObject({status:"success"});
    const exchanged=await bridge.exchangeApplicationToken({apiKey:key,requestedToolNames:["cargo.calculate"],clientIp:"127.0.0.1",requestId:"req_unified_0000001"});
    await expect(bridge.verifyApplicationTokenAuthority(exchanged.data.access_token)).resolves.toBeUndefined();

    business.service.revokeCredential(owner,credential.credentialId,{idempotencyKey:"unified-key-revoke01",expectedVersion:2,input:{}});
    await expect(bridge.verifyApplicationTokenAuthority(exchanged.data.access_token)).rejects.toThrow("business_authorization_denied");
    await expect(business.service.authorizeApiKey(key,"customs.query")).rejects.toThrow("business_authorization_denied");
    business.repository.close();await runtime.close();
  });
});
