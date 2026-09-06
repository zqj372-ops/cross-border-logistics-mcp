/* eslint-disable @typescript-eslint/require-await */
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalContext,PortalIdentity } from "../../services/access-gateway/portal/contracts";
import { PortalService } from "../../services/access-gateway/portal/service";
import { SqliteSyntheticPortalStore } from "../../services/access-gateway/portal/store";
import { type BusinessJwtClaims } from "../../services/access-gateway/portal/business-access/contracts";
import { BusinessAccessService } from "../../services/access-gateway/portal/business-access/service";
import { SqliteSyntheticBusinessAccessStore } from "../../services/access-gateway/portal/business-access/store";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const identity=(id:string,role:null|"reviewer"|"operator"=null):PortalIdentity=>({userId:id,displayName:id,email:`${id}@example.test`,emailVerified:true,platformRole:role});
const ctx=(id:PortalIdentity,org:string|null):PortalContext=>({identity:id,organizationId:org});
function setup(){let hashGate:Promise<void>|null=null,tenantGate:Promise<void>|null=null,signGate:Promise<void>|null=null,verifyGate:Promise<void>|null=null;const root=mkdtempSync(join(tmpdir(),"business-access-"));roots.push(root);let seq=0;const portalStore=new SqliteSyntheticPortalStore({databasePath:join(root,"portal.sqlite")});const portal=new PortalService({repository:portalStore,now:()=>"2026-09-05T12:00:00.000Z",id:p=>`${p}_${String(++seq).padStart(8,"0")}`});const owner=identity("owner_user"),reviewer=identity("reviewer_user","reviewer"),operator=identity("operator_user","operator");portal.bootstrapOrganization(ctx(operator,null),{idempotencyKey:"bootstrap-key-0001",input:{organizationId:"org_acme",tenantId:"tenant_acme",displayName:"Acme"}});const operatorCtx=ctx(operator,"org_acme");portal.inviteMember(operatorCtx,{idempotencyKey:"invite-owner-0001",input:{email:owner.email,role:"owner",expiresAt:"2026-10-01T00:00:00.000Z"}});const invitation=portal.getState(ctx(owner,null)).data!.invitations[0]!;portal.claimInvitation(ctx(owner,null),invitation.invitationId,"claim-owner-key1");const ownerCtx=ctx(owner,"org_acme");portal.createApplication(ownerCtx,{idempotencyKey:"create-app-key-01",input:{applicationId:"app_business",clientId:"client_business",name:"Business",purpose:"API",environment:"test",ownerUserId:owner.userId}});const businessStore=new SqliteSyntheticBusinessAccessStore({databasePath:join(root,"business.sqlite")});const tokens=new Map<string,BusinessJwtClaims>();const service=new BusinessAccessService({repository:businessStore,portalService:portal,issuer:"https://gateway.example.test/",now:()=>1788609600,id:p=>`${p}_${String(++seq).padStart(8,"0")}`,operationAuthority:{isAvailable:(_tenant,op)=>op!=="customs.tax.estimate"},tenantClientAuthority:{requireActive:()=>tenantGate??Promise.resolve()},secretProvider:{pepperVersion:"pepper-v1",hash:async(secret,salt)=>{if(hashGate)await hashGate;return createHash("sha256").update(secret).update(salt).digest();},verify:async(secret,material)=>{const actual=createHash("sha256").update(secret).update(material?.salt??new Uint8Array()).digest();return material!==null&&actual.length===material.hash.length&&timingSafeEqual(actual,material.hash);}},tokenSigner:{sign:async(claims)=>{if(signGate)await signGate;const token=`jwt-${claims.jti}`;tokens.set(token,claims);return token;}},tokenVerifier:{verify:async(token)=>{if(verifyGate)await verifyGate;const claims=tokens.get(token);if(!claims)throw new Error("bad token");return {...claims};}}});return{portalStore,businessStore,portal,service,ownerCtx,reviewer,operator,setHashGate:(value:Promise<void>|null)=>{hashGate=value;},setTenantGate:(value:Promise<void>|null)=>{tenantGate=value;},setSignGate:(value:Promise<void>|null)=>{signGate=value;},setVerifyGate:(value:Promise<void>|null)=>{verifyGate=value;}};}
describe("business access v2 domain",()=>{
  it("issues a T0-only application Key, exchanges it through the restricted signer, and revokes old-token authority immediately", async () => {
    const x = setup();
    const request = x.portal.createRequest(x.ownerCtx, { idempotencyKey: "t0-request-create01", input: { requestId: "request_t0_only", applicationId: "app_business", capabilities: ["cargo.calculate"], justification: "MCP" } }).data! as {requestId:string};
    x.portal.submitRequest(x.ownerCtx, request.requestId, 1, "t0-request-submit01");
    const decision = x.portal.decideRequest(ctx(x.reviewer, "org_acme"), request.requestId, { idempotencyKey: "t0-request-review01", expectedVersion: 2, input: { decision: "approve", reason: "ok" } }).data! as {grant:{grantId:string}};
    x.portal.markGrantActive(ctx(x.operator, "org_acme"), decision.grant.grantId, { idempotencyKey: "t0-grant-active001", expectedVersion: 1, input: { provisionedRef: "client:client_business" } });

    const issued = await x.service.issueCredential(x.ownerCtx, "app_business", { idempotencyKey: "t0-only-issue-key1", input: { label: "MCP", operations: [], t0Mode: "current_grant", expiresInSeconds: 3600 } });
    expect(issued.data!.credential).toMatchObject({ operations: [], t0Mode: "current_grant" });
    x.service.acknowledgeCredential(x.ownerCtx, issued.data!.credential.credentialId, { idempotencyKey: "t0-only-ack-key01", expectedVersion: 1, input: {} });

    const issueAuthorizedToken = vi.fn(async (_input, authorize: () => Promise<void>) => {
      await authorize();
      await authorize();
      return { schema_version: "2026-08-27.v1", status: "success", data: { access_token: "mcp.jwt.token", token_type: "Bearer", expires_in: 300, tool_names: ["cargo.calculate"], session_ref: "auth_12345678", request_id: "req_12345678" }, warnings: [], blockers: [] } as const;
    });
    const exchanged = await x.service.exchangeApplicationToken({ apiKey: issued.data!.api_key!, requestedToolNames: ["cargo.calculate"], clientIp: "198.51.100.30", issuer: { issueAuthorizedToken } });
    expect(exchanged.data.tool_names).toEqual(["cargo.calculate"]);
    expect(issueAuthorizedToken).toHaveBeenCalledWith(expect.objectContaining({ credentialId: issued.data!.credential.credentialId, tenantId: "tenant_acme", clientId: "client_business" }), expect.any(Function));
    await expect(x.service.authorizeT0ApiKey(issued.data!.api_key!, ["cargo.calculate"])).resolves.toMatchObject({ credentialId: issued.data!.credential.credentialId });

    x.service.setCredentialT0Mode(x.ownerCtx, issued.data!.credential.credentialId, { idempotencyKey: "t0-only-disable001", expectedVersion: 2, input: { mode: "none" } });
    await expect(x.service.authorizeT0Credential({ credentialId: issued.data!.credential.credentialId, tenantId: "tenant_acme", clientId: "client_business", requestedToolNames: ["cargo.calculate"] })).rejects.toThrow("business_authorization_denied");
    x.businessStore.transact("test.legacy.credential", "legacy-credential-0001", "legacy", (data) => {
      const credential = data.credentials.find((value) => value.credentialId === issued.data!.credential.credentialId)!;
      delete credential.t0Mode;
      return null;
    });
    expect(x.service.getState(x.ownerCtx).data!.credentials[0]).toMatchObject({ t0Mode: "none" });
    await expect(x.service.authorizeT0ApiKey(issued.data!.api_key!, ["cargo.calculate"])).rejects.toThrow("business_authorization_denied");
    x.portalStore.close(); x.businessStore.close();
  });

  it("persists approval, activation, one-time Key delivery, exchange and current authorization",async()=>{const x=setup();const created=x.service.createRequest(x.ownerCtx,{idempotencyKey:"business-request-01",input:{applicationId:"app_business",operations:["customs.query","quote.zone_preview"],justification:"ERP read APIs"}}).data!;x.service.submitRequest(x.ownerCtx,created.requestId,1,"business-submit-01");const requestReplay=x.service.createRequest(x.ownerCtx,{idempotencyKey:"business-request-01",input:{applicationId:"app_business",operations:["customs.query","quote.zone_preview"],justification:"ERP read APIs"}}).data!;expect(requestReplay).toMatchObject({requestId:created.requestId,version:2,state:"submitted"});const decision=x.service.decideRequest(ctx(x.reviewer,null),created.requestId,{idempotencyKey:"business-review-01",expectedVersion:2,input:{decision:"approve",reason:"approved",approvedOperations:["customs.query"]}}).data!;expect(decision.grant?.state).toBe("provisioning");const grant=(await x.service.activateGrant(ctx(x.operator,null),decision.grant!.grantId,{idempotencyKey:"business-active-01",expectedVersion:1,input:{}})).data!;expect(grant.state).toBe("active");const mutation={idempotencyKey:"business-issue-001",input:{label:"ERP",operations:["customs.query"] as const,expiresInSeconds:31_536_000}};const issued=await x.service.issueCredential(x.ownerCtx,"app_business",mutation);expect(issued.data!.api_key).toMatch(/^flcbk_bkey_/u);expect(issued.data!.credential.expiresAt).toBe(1788609600+31_536_000);const replay=await x.service.issueCredential(x.ownerCtx,"app_business",mutation);expect(replay.data!.api_key).toBeNull();expect(JSON.stringify(x.businessStore.read())).not.toContain(issued.data!.api_key);const credential=issued.data!.credential;x.service.acknowledgeCredential(x.ownerCtx,credential.credentialId,{idempotencyKey:"business-ack-key01",expectedVersion:1,input:{}});const exchanged=await x.service.exchange(issued.data!.api_key!,["customs.query"]);const machine=await x.service.authorize(exchanged.data!.access_token,"customs.query");expect(machine).toMatchObject({tenantId:"tenant_acme",clientId:"client_business",applicationId:"app_business"});const nextOwner=identity("next_owner");x.portal.inviteMember(x.ownerCtx,{idempotencyKey:"invite-next-owner",input:{email:nextOwner.email,role:"owner",expiresAt:"2026-10-01T00:00:00.000Z"}});const nextInvitation=x.portal.getState(ctx(nextOwner,null)).data!.invitations[0]!;x.portal.claimInvitation(ctx(nextOwner,null),nextInvitation.invitationId,"claim-next-owner1");x.portal.changeApplication(x.ownerCtx,"app_business",{idempotencyKey:"transfer-app-owner",expectedVersion:1,input:{ownerUserId:nextOwner.userId}});await expect(x.service.authorize(exchanged.data!.access_token,"customs.query")).resolves.toMatchObject({applicationId:"app_business"});expect(()=>x.service.revokeCredential(x.ownerCtx,credential.credentialId,{idempotencyKey:"old-owner-revoke1",expectedVersion:2,input:{}})).toThrow();let releaseTenant!:()=>void;const tenantGate=new Promise<void>(resolve=>{releaseTenant=resolve;});x.setVerifyGate(tenantGate);const pendingAuthorization=x.service.authorize(exchanged.data!.access_token,"customs.query");await Promise.resolve();x.service.revokeCredential(ctx(nextOwner,"org_acme"),credential.credentialId,{idempotencyKey:"business-revoke-01",expectedVersion:2,input:{}});releaseTenant();await expect(pendingAuthorization).rejects.toThrow("business_authorization_denied");const auditCount=x.businessStore.read().audit.length;x.service.changeGrant(ctx(x.operator,null),grant.grantId,{idempotencyKey:"business-grant-revoke",expectedVersion:2,input:{state:"revoked"}});const afterRevokeAudit=x.businessStore.read().audit.length;const activationReplay=(await x.service.activateGrant(ctx(x.operator,null),grant.grantId,{idempotencyKey:"business-active-01",expectedVersion:1,input:{}})).data!;expect(activationReplay).toMatchObject({grantId:grant.grantId,state:"revoked",version:3});expect(x.businessStore.read().audit).toHaveLength(afterRevokeAudit);expect(afterRevokeAudit).toBe(auditCount+1);x.portalStore.close();x.businessStore.close();});
  it("fails closed for unavailable operations, non-owner credential access and idempotency conflicts",async()=>{const x=setup();const request=x.service.createRequest(x.ownerCtx,{idempotencyKey:"business-request-02",input:{applicationId:"app_business",operations:["customs.tax.estimate"],justification:"tax"}}).data!;x.service.submitRequest(x.ownerCtx,request.requestId,1,"business-submit-02");const grant=x.service.decideRequest(ctx(x.reviewer,null),request.requestId,{idempotencyKey:"business-review-02",expectedVersion:2,input:{decision:"approve",reason:"policy"}}).data!.grant!;await expect(x.service.activateGrant(ctx(x.operator,null),grant.grantId,{idempotencyKey:"business-active-02",expectedVersion:1,input:{}})).rejects.toThrow("business_grant_not_provisionable");expect(()=>x.service.decideRequest(ctx({...x.ownerCtx.identity,platformRole:"reviewer"},null),request.requestId,{idempotencyKey:"self-review-denied",expectedVersion:2,input:{decision:"reject",reason:"self"}})).toThrow("business_review_denied");expect(()=>x.service.createRequest(x.ownerCtx,{idempotencyKey:"business-request-02",input:{applicationId:"app_business",operations:["customs.query"],justification:"changed"}})).toThrow();x.portalStore.close();x.businessStore.close();});
});

describe("business access RS256 codec",()=>{it("signs only the isolated business audience with RS256 and verifies it",async()=>{const {generateKeyPair}=await import("jose");const {createBusinessRs256TokenCodec}=await import("../../services/access-gateway/portal/business-access/crypto");const {privateKey,publicKey}=await generateKeyPair("RS256",{modulusLength:2048});const codec=createBusinessRs256TokenCodec({privateKey,publicKey,keyId:"business-key-1",issuer:"https://gateway.example.test/"});const now=Math.floor(Date.now()/1000);const claims:BusinessJwtClaims={iss:"https://gateway.example.test/",aud:"freightclaw-business-api-v2",sub:"bkey_123",token_use:"business_api",tenant_id:"tenant",client_id:"client",application_id:"app",credential_id:"bkey_123",operations:["customs.query"],iat:now,nbf:now,exp:now+300,jti:"jti_123"};const token=await codec.signer.sign(claims);await expect(codec.verifier.verify(token)).resolves.toMatchObject({aud:"freightclaw-business-api-v2",token_use:"business_api",operations:["customs.query"]});});});

describe("business access concurrency revalidation",()=>{
  it("does not activate a Grant when its application is suspended during tenant readback", async () => {
    const x = setup();
    const request = x.service.createRequest(x.ownerCtx, { idempotencyKey: "activate-race-request", input: { applicationId: "app_business", operations: ["customs.query"], justification: "race" } }).data!;
    x.service.submitRequest(x.ownerCtx, request.requestId, 1, "activate-race-submit");
    const grant = x.service.decideRequest(ctx(x.reviewer, null), request.requestId, { idempotencyKey: "activate-race-review", expectedVersion: 2, input: { decision: "approve", reason: "ok" } }).data!.grant!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    x.setTenantGate(gate);
    const pending = x.service.activateGrant(ctx(x.operator, null), grant.grantId, { idempotencyKey: "activate-race-final", expectedVersion: 1, input: {} });
    await Promise.resolve();
    x.portal.changeApplication(x.ownerCtx, "app_business", { idempotencyKey: "activate-race-suspend", expectedVersion: 1, input: { status: "suspended" } });
    release();
    await expect(pending).rejects.toThrow("business_grant_not_provisionable");
    expect(x.businessStore.read().grants[0]?.state).toBe("provisioning");
    x.portalStore.close(); x.businessStore.close();
  });

  it("does not create a Key when application ownership changes while hashing",async()=>{
    const x=setup();
    const request=x.service.createRequest(x.ownerCtx,{idempotencyKey:"race-request-key1",input:{applicationId:"app_business",operations:["customs.query"],justification:"race"}}).data!;
    x.service.submitRequest(x.ownerCtx,request.requestId,1,"race-submit-key01");
    const grant=x.service.decideRequest(ctx(x.reviewer,null),request.requestId,{idempotencyKey:"race-review-key01",expectedVersion:2,input:{decision:"approve",reason:"ok"}}).data!.grant!;
    await x.service.activateGrant(ctx(x.operator,null),grant.grantId,{idempotencyKey:"race-active-key01",expectedVersion:1,input:{}});
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});x.setHashGate(gate);
    const pending=x.service.issueCredential(x.ownerCtx,"app_business",{idempotencyKey:"race-issue-key001",input:{label:"Race",operations:["customs.query"],expiresInSeconds:3600}});
    await Promise.resolve();
    const next=identity("race_next_owner");x.portal.inviteMember(x.ownerCtx,{idempotencyKey:"race-invite-owner",input:{email:next.email,role:"owner",expiresAt:"2026-10-01T00:00:00.000Z"}});const invitation=x.portal.getState(ctx(next,null)).data!.invitations[0]!;x.portal.claimInvitation(ctx(next,null),invitation.invitationId,"race-claim-owner1");x.portal.changeApplication(x.ownerCtx,"app_business",{idempotencyKey:"race-transfer-app",expectedVersion:1,input:{ownerUserId:next.userId}});
    release();await expect(pending).rejects.toThrow();expect(x.businessStore.read().credentials).toHaveLength(0);x.portalStore.close();x.businessStore.close();
  });
  it("does not create a Key when the active Grant is suspended while hashing",async()=>{
    const x=setup();const request=x.service.createRequest(x.ownerCtx,{idempotencyKey:"grant-race-request",input:{applicationId:"app_business",operations:["customs.query"],justification:"race"}}).data!;x.service.submitRequest(x.ownerCtx,request.requestId,1,"grant-race-submit");const grant=x.service.decideRequest(ctx(x.reviewer,null),request.requestId,{idempotencyKey:"grant-race-review",expectedVersion:2,input:{decision:"approve",reason:"ok"}}).data!.grant!;await x.service.activateGrant(ctx(x.operator,null),grant.grantId,{idempotencyKey:"grant-race-active",expectedVersion:1,input:{}});
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});x.setHashGate(gate);const pending=x.service.issueCredential(x.ownerCtx,"app_business",{idempotencyKey:"grant-race-issue1",input:{label:"Race",operations:["customs.query"],expiresInSeconds:3600}});await Promise.resolve();x.service.changeGrant(x.ownerCtx,grant.grantId,{idempotencyKey:"grant-race-pause1",expectedVersion:2,input:{state:"suspended"}});release();await expect(pending).rejects.toThrow("business_authorization_denied");expect(x.businessStore.read().credentials).toHaveLength(0);x.portalStore.close();x.businessStore.close();
  });

});

describe("business access platform review projection", () => {
  it("keeps historical requests visible when the organization application is suspended", () => {
    const x = setup();
    const request = x.service.createRequest(x.ownerCtx, { idempotencyKey: "queue-suspend-request", input: { applicationId: "app_business", operations: ["customs.query"], justification: "history" } }).data!;
    x.service.submitRequest(x.ownerCtx, request.requestId, 1, "queue-suspend-submit");
    x.portal.changeApplication(x.ownerCtx, "app_business", { idempotencyKey: "queue-suspend-app", expectedVersion: 1, input: { status: "suspended" } });
    const queue = x.service.getReviewQueue(ctx(x.reviewer, null)).data!;
    expect(queue.requests).toEqual([expect.objectContaining({ requestId: request.requestId })]);
    expect(queue.applications).toEqual([expect.objectContaining({
      organizationId: "org_acme", organizationName: "Acme", organizationStatus: "active",
      applicationId: "app_business", applicationName: "Business", applicationStatus: "suspended",
      clientId: "client_business", tenantId: "tenant_acme",
    })]);
    expect(Object.keys(queue.applications[0]!).sort()).toEqual([
      "applicationId", "applicationName", "applicationStatus", "clientId",
      "organizationId", "organizationName", "organizationStatus", "tenantId",
    ]);
    x.portalStore.transact("test.organization.suspend", "queue-suspend-org1", "suspended", (data) => {
      data.organizations[0]!.status = "suspended";
      return null;
    });
    const suspendedOrganizationQueue = x.service.getReviewQueue(ctx(x.reviewer, null)).data!;
    expect(suspendedOrganizationQueue.applications).toEqual([expect.objectContaining({
      organizationId: "org_acme", organizationStatus: "suspended",
      applicationId: "app_business", applicationStatus: "suspended",
    })]);
    expect(() => x.portal.getBusinessApplicationReviewSummaries(x.ownerCtx, ["client_business"])).toThrow("reviewer_required");
    x.portalStore.close(); x.businessStore.close();
  });
});
