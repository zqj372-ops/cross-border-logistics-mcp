import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it,vi} from 'vitest';
import {NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import {FclSmtpSettings} from '../../services/access-gateway/portal/fcl-smtp-settings';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';
const ctx:PortalContext={organizationId:null,identity:{userId:'owner',displayName:'Owner',email:'owner@example.test',emailVerified:true,platformRole:null}};
const connection={host:'smtp.example.test',port:587 as const,secure:false,username:'sender@example.test',from:'sender@example.test',reply_to:'reply@example.test'};
it('encrypts credentials, isolates admin access, tests once and activates only the tested revision',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'smtp-settings-'));const store=new NativeAdminStore(join(dir,'native.sqlite'));
 const send=vi.fn(()=>Promise.resolve()),fallback={send:vi.fn(()=>Promise.resolve())};
 try{
  const service=new FclSmtpSettings({store,ownerId:'owner',secret:'synthetic-key-for-smtp-settings-32-bytes',fallback,transport:()=>({send})});
  expect(()=>service.get({...ctx,identity:{...ctx.identity,userId:'other'}})).toThrow('fcl_not_found');
  const input={expected_version:0,confirmed:true as const,connection,password:'unique-synthetic-password'};
  const saved=service.save(ctx,input,'smtp-save-fixture-0001');expect(saved.version).toBe(1);expect(JSON.stringify(saved)).not.toContain(input.password);
  expect(JSON.stringify(store.db.prepare('SELECT * FROM native_configs').all())).not.toContain(input.password);
  expect(JSON.stringify(store.db.prepare('SELECT * FROM native_idempotency').all())).not.toContain(input.password);
  expect(()=>service.activate(ctx,{expected_version:1,confirmed:true},'smtp-activate-fixture-001')).toThrow('fcl_smtp_test_required');
  await service.send({to:'customer@example.test',cc:[],subject:'test',body:'test'});expect(fallback.send).toHaveBeenCalledOnce();
  const request={expected_version:1,confirmed:true,recipient:'owner@example.test'};
  expect((await service.test(ctx,request,'smtp-test-fixture-0001')).test_status).toBe('smtp_accepted');
  await service.test(ctx,request,'smtp-test-fixture-0001');expect(send).toHaveBeenCalledOnce();
  service.activate(ctx,{expected_version:1,confirmed:true},'smtp-activate-fixture-002');await service.send({to:'customer@example.test',cc:[],subject:'test',body:'test'});expect(send).toHaveBeenCalledTimes(2);
  const newer=service.save(ctx,{...input,expected_version:2,password:null},'smtp-save-fixture-0002');expect(newer.test_status).toBe('not_tested');
  expect(()=>service.activate(ctx,{expected_version:3,confirmed:true},'smtp-activate-fixture-003')).toThrow('fcl_smtp_test_required');
  expect(()=>service.save(ctx,{...input,expected_version:3,password:null,connection:{...connection,host:'other.example.test'}},'smtp-save-fixture-0003')).toThrow('fcl_smtp_password_required');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
it('retains unknown test outcomes without automatically resending',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'smtp-settings-'));const store=new NativeAdminStore(join(dir,'native.sqlite'));const send=vi.fn(()=>Promise.reject(new Error('timeout')));
 try{const service=new FclSmtpSettings({store,ownerId:'owner',secret:'synthetic-key-for-smtp-settings-32-bytes',fallback:{send},transport:()=>({send})});service.save(ctx,{expected_version:0,confirmed:true,connection,password:'synthetic-secret'},'smtp-save-fixture-0001');const r={expected_version:1,confirmed:true,recipient:'owner@example.test'};expect((await service.test(ctx,r,'smtp-test-fixture-0001')).test_status).toBe('unknown');await expect(service.test(ctx,r,'smtp-test-fixture-0002')).rejects.toThrow('fcl_smtp_test_unknown');expect(send).toHaveBeenCalledOnce();}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

it('does not apply an old test result to a newer connection draft',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'smtp-settings-'));const store=new NativeAdminStore(join(dir,'native.sqlite'));let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;});
 try{
  const service=new FclSmtpSettings({store,ownerId:'owner',secret:'synthetic-key-for-smtp-settings-32-bytes',fallback:{send:async()=>{}},transport:()=>({send:()=>pending})});
  service.save(ctx,{expected_version:0,confirmed:true,connection,password:'synthetic-secret'},'smtp-save-fixture-0001');
  const testing=service.test(ctx,{expected_version:1,confirmed:true,recipient:'owner@example.test'},'smtp-test-fixture-0001');
  service.save(ctx,{expected_version:1,confirmed:true,connection:{...connection,from:'new@example.test'},password:null},'smtp-save-fixture-0002');
  finish();const result=await testing;expect(result.version).toBe(2);expect(result.test_status).toBe('not_tested');expect(result.draft?.from).toBe('new@example.test');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
