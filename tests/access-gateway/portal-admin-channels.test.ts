import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelStore, ChannelService } from '../../services/access-gateway/portal/channels';
import type { PortalService } from '../../services/access-gateway/portal/service';
import type { PortalContext } from '../../services/access-gateway/portal/contracts';
const operator:PortalContext={identity:{userId:'operator',displayName:'Operator',email:'operator@example.test',emailVerified:true,platformRole:'operator'},organizationId:null};
const user:PortalContext={identity:{userId:'viewer',displayName:'User',email:'user@example.test',emailVerified:true,platformRole:null},organizationId:'org1'};
const portal={getState:(ctx:PortalContext)=>({data:{current_organization:ctx.organizationId?{status:'active'}:null,memberships:[{organizationId:ctx.organizationId,userId:ctx.identity.userId,role:ctx.identity.userId==='admin'?'admin':'viewer',status:'active'}]}})} as unknown as PortalService;
const input={code:'CA-SEA',name:'合成加拿大海运',warehouse:'上海仓',origin_country:'CN',destination_country:'CA',service:'ocean_fcl',currency:'CAD',valid_from:'2026-09-01',valid_until:'2026-12-31'};
it('starts empty, isolates organizations, publishes fixed previews, persists and supports rollback without rates',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'fc-channels-')),'channels.sqlite');let store=new ChannelStore(path);let service=new ChannelService(store,portal,()=> '2026-09-07');
 expect(service.list(operator).items).toEqual([]);
 expect(()=>service.create(user,input,'key-denied-000001')).toThrow('channel_management_denied');
 const created=service.create(operator,input,'key-create-000001');expect(created.version).toBe(1);expect(created.active_release).toBeNull();
 expect(service.create(operator,input,'key-create-000001').channel_id).toBe(created.channel_id);
 expect(()=>service.get(user,created.channel_id)).toThrow('channel_not_found');
 const preview=service.preview(operator,created.channel_id);expect(preview.ready_for_quotes).toBe(false);
 expect(()=>service.publish(operator,created.channel_id,{expected_version:1,preview_hash:'0'.repeat(64)},'key-publish-bad001')).toThrow('channel_preview_mismatch');
 const published=service.publish(operator,created.channel_id,{expected_version:1,preview_hash:preview.preview_hash},'key-publish-00001');expect(published.active_release?.input.currency).toBe('CAD');
 expect(()=>service.save(operator,created.channel_id,{expected_version:1,input},'key-stale-000001')).toThrow('version_conflict');
 const changed=service.save(operator,created.channel_id,{expected_version:published.version,input:{...input,name:'第二版'}},'key-save-0000001');expect(changed.active_release?.input.name).toBe(input.name);
 const p2=service.preview(operator,created.channel_id);const r2=service.publish(operator,created.channel_id,{expected_version:changed.version,preview_hash:p2.preview_hash},'key-publish-00002');
 const target=published.active_release!.release_id;const back=service.preview(operator,created.channel_id,target);const rolled=service.rollback(operator,created.channel_id,{expected_version:r2.version,release_id:target,preview_hash:back.preview_hash},'key-rollback-0001');expect(rolled.active_release?.input.name).toBe(input.name);
 store.close();store=new ChannelStore(path);service=new ChannelService(store,portal,()=> '2026-09-07');expect(service.get(operator,created.channel_id).active_release?.release_id).toBe(target);store.close();
});
it('rejects invalid and conflicting writes, rechecks revoked access and never falls back across scopes',()=>{
 const store=new ChannelStore(join(mkdtempSync(join(tmpdir(),'fc-channels-')),'channels.sqlite'));
 let active=true;const livePortal={getState:(ctx:PortalContext)=>({data:{current_organization:{status:active?'active':'suspended'},memberships:[{organizationId:ctx.organizationId,userId:ctx.identity.userId,role:'admin',status:active?'active':'suspended'}]}})} as unknown as PortalService;
 const service=new ChannelService(store,livePortal,()=> '2026-09-07'),admin={...user,identity:{...user.identity,userId:'admin'}};
 try{
  for(const bad of [{...input,warehouse:''},{...input,valid_from:'2026-12-32'},{...input,valid_from:'2027-01-01'},{...input,currency:'EUR'},{...input,tenant_id:'forged'}])expect(()=>service.create(admin,bad,'invalid-input-key')).toThrow('channel_input_invalid');
  const created=service.create(admin,input,'org-create-key001');
  expect(()=>service.create(admin,{...input,name:'different'},'org-create-key001')).toThrow('idempotency_conflict');
  expect(()=>service.create(admin,input,'org-create-key002')).toThrow('channel_code_exists');
  expect(service.list(operator).items).toHaveLength(0);
  expect(()=>service.get({...admin,organizationId:'org2'},created.channel_id)).toThrow('channel_not_found');
  expect(()=>service.save(admin,created.channel_id,{expected_version:1,input:{...input,code:'OTHER'}},'org-save-key0001')).toThrow('channel_code_immutable');
  const preview=service.preview(admin,created.channel_id);const published=service.publish(admin,created.channel_id,{expected_version:1,preview_hash:preview.preview_hash},'org-publish-key1');
  const disabled=service.disable(admin,created.channel_id,{expected_version:published.version},'org-disable-key1');expect(disabled.active_release).toBeNull();expect(service.history(admin,created.channel_id).releases).toHaveLength(1);
  active=false;expect(()=>service.create(admin,input,'org-create-key001')).toThrow('channel_management_denied');expect(()=>service.get(admin,created.channel_id)).toThrow('channel_management_denied');
  active=true;const expired=new ChannelService(store,livePortal,()=> '2027-01-01');expect(()=>expired.preview(admin,created.channel_id,published.active_release!.release_id)).toThrow('channel_expired');
 }finally{store.close();}
});
