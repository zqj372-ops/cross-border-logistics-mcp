import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortalContext } from '../../../services/access-gateway/portal/contracts';
import { createProductionScheduleLiveService } from '../../../services/maritime/schedule-live/production';
import { InMemoryScheduleLiveAuditSink } from '../../../services/maritime/schedule-live/audit';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const receiver:PortalContext={identity:{userId:'receiver',displayName:'Test receiver',email:'receiver@example.test',emailVerified:true,platformRole:null},organizationId:null};
const scope='fcl-personal-test';
// Pre-abort every request so even a failing policy test cannot access a carrier.
const offline={signal:AbortSignal.abort()};
async function service(carrierAllowlist?:Record<string,string[]>){
 const root=await mkdtemp(join(tmpdir(),'cosco-personal-policy-'));roots.push(root);
 return createProductionScheduleLiveService({portal:{getState:()=>{throw new Error('personal access must not read a company');}},audit:new InMemoryScheduleLiveAuditSink(),evidenceRoot:root,tenantAllowlist:[],personalAccess:{scopeId:scope,authorize:ctx=>Promise.resolve(ctx.identity.userId==='receiver')},...(carrierAllowlist?{carrierAllowlist}:{})});
}
describe('personal FCL production carrier boundary',()=>{
 it('rejects other carriers even when an older deployment allowlist includes them',async()=>{
  for(const allowlist of [undefined,{[scope]:['COSCO','ONE']}]){
   const app=await service(allowlist);
   await expect(app.locations(receiver,{carrier:'ONE',text:'Shanghai',country_code:'CN'},offline)).rejects.toMatchObject({code:'schedule_live_carrier_denied'});
   await expect(app.search(receiver,{carrier:'OOCL',origin:{text:'Shanghai',country_code:'CN',carrier_location_id:null},destination:{text:'Vancouver',country_code:'CA',carrier_location_id:null},from:'2026-10-01',until:'2026-10-28',routing:'any'},offline)).rejects.toMatchObject({code:'schedule_live_carrier_denied'});
  }
 });
 it('retains deployment restrictions for COSCO and accepts it when allowed without making network calls',async()=>{
  const denied=await service({[scope]:['ONE']});
  await expect(denied.locations(receiver,{carrier:'COSCO',text:'Shanghai',country_code:'CN'},offline)).rejects.toMatchObject({code:'schedule_live_carrier_denied'});
  const allowed=await service();const controller=new AbortController();controller.abort();
  const result=await allowed.locations(receiver,{carrier:'COSCO',text:'Shanghai',country_code:'CN'},{signal:controller.signal});
  expect(result.status).toBe('unavailable');
 });
});
