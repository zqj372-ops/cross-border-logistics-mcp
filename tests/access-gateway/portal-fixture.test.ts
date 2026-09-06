import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPortalFixtureRuntime } from "../../services/access-gateway/portal/fixture";
import type { PortalContext, PortalIdentity } from "../../services/access-gateway/portal/contracts";

const roots:string[]=[];
afterEach(()=>{vi.useRealTimers();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

const owner:PortalIdentity={userId:"fixture-owner",displayName:"企业所有者",email:"owner@example.test",emailVerified:true,platformRole:null};
const ownerContext:PortalContext={identity:owner,organizationId:"org_fixture"};
const operatorContext:PortalContext={identity:{userId:"fixture-operator",displayName:"平台运维管理员",email:"operator@example.test",emailVerified:true,platformRole:"operator"},organizationId:null};

describe("portal fixture runtime",()=>{
  it("assembles persistent portal and tenant stores without pre-approved access or secrets",async()=>{
    const databaseDirectory=mkdtempSync(join(tmpdir(),"portal-runtime-"));roots.push(databaseDirectory);
    const runtime=await createPortalFixtureRuntime({databaseDirectory,nowSeconds:1_788_537_600});
    expect(Object.keys(runtime).sort()).toEqual(["bridge","close","createUnifiedBridge","databaseFiles","organizationBridge","requireActiveTenantClient","service"]);
    expect(runtime.databaseFiles.portal).toBe(join(databaseDirectory,"portal.sqlite"));
    expect(runtime.databaseFiles.tenantAccess).toBe(join(databaseDirectory,".runtime","mcp-tenant-access","access.sqlite"));
    expect((await runtime.organizationBridge.listOrganizationAdmissions(operatorContext)).data).toEqual([
      expect.objectContaining({organization_id:"org_fixture",tenant_id:"tenant_fixture",tenant_status:"enabled",owner_status:"owner_active"}),
    ]);
    const state=runtime.service.getState(ownerContext).data!;
    expect(state.current_organization).toMatchObject({organizationId:"org_fixture",tenantId:"tenant_fixture",displayName:"示例物流企业"});
    expect(state.memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({userId:"fixture-owner",role:"owner",status:"active"}),
      expect.objectContaining({userId:"fixture-developer",role:"developer",status:"active"}),
    ]));
    expect(state.invitations.filter(item=>item.status==="pending")).toEqual([expect.objectContaining({email:"sales@example.test",role:"viewer",status:"pending"})]);
    expect(state.applications).toEqual([]);expect(state.requests).toEqual([]);expect(state.grants).toEqual([]);
    expect(JSON.stringify(runtime)).not.toMatch(/api_key|private|secret/i);
    await runtime.close();

    const reopened=await createPortalFixtureRuntime({databaseDirectory,nowSeconds:1_788_537_600});
    const reopenedState=reopened.service.getState(ownerContext).data!;
    expect(reopenedState.memberships.filter(item=>item.status==="active")).toHaveLength(2);
    expect(reopenedState.invitations.filter(item=>item.status==="pending")).toHaveLength(1);
    await reopened.close();
  });

  it("connects application creation through the real bridge without issuing a credential",async()=>{
    const databaseDirectory=mkdtempSync(join(tmpdir(),"portal-runtime-"));roots.push(databaseDirectory);
    const runtime=await createPortalFixtureRuntime({databaseDirectory,nowSeconds:1_788_537_600});
    const created=await runtime.bridge.createApplication(ownerContext,{idempotencyKey:"fixture-create-app-0001",input:{name:"ERP 测试应用",purpose:"验证 T0 接入",environment:"test"}});
    expect(created.data).toMatchObject({name:"ERP 测试应用",ownerUserId:"fixture-owner"});
    const state=runtime.service.getState(ownerContext).data!;
    expect(state.applications).toHaveLength(1);expect(state.requests).toEqual([]);expect(state.grants).toEqual([]);
    expect(await runtime.bridge.getCredentialState(ownerContext,state.applications[0]!.applicationId)).toMatchObject({data:{credentials:[]}});
    await runtime.close();
  });

  it("uses a live clock unless a frozen test clock is explicitly supplied",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-05T10:00:00.000Z"));
    const databaseDirectory=mkdtempSync(join(tmpdir(),"portal-runtime-"));roots.push(databaseDirectory);
    const runtime=await createPortalFixtureRuntime({databaseDirectory});
    vi.setSystemTime(new Date("2026-09-05T10:05:00.000Z"));
    const created=await runtime.bridge.createApplication(ownerContext,{idempotencyKey:"fixture-live-clock-app",input:{name:"Live clock",purpose:"expiry verification",environment:"test"}});
    expect(created.data).toMatchObject({createdAt:"2026-09-05T10:05:00.000Z"});
    await runtime.close();
  });
});
