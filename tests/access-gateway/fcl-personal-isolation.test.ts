import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {NativeAdminService,NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';
import {CaseService,CaseStore} from '../../services/access-gateway/portal/cases';
import {createFclInquiryDraft} from '../../apps/inquiry/fcl-model';
import {operationsFixture} from '../quote-native/fixtures/fcl-operations';

const account=(userId:string,organizationId:string|null=null):PortalContext=>({organizationId,identity:{userId,displayName:userId,email:`${userId}@example.test`,emailVerified:true,platformRole:null}});
it('isolates personal rates, publications and replay even with a selected enterprise, without reassigning legacy data',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-personal-'));
  const options={fcl:{mode:'fresh_fixture' as const,authorized:true,oldWritersStopped:true}} as const;
  let store=new NativeAdminStore(join(root,'native.sqlite'),options);
  const portal={getState:()=>({data:{current_organization:null,memberships:[]}})};
  const create=()=>new NativeAdminService(store,portal as never,{receiverUserId:'alice',receiverIsActive:()=>true,now:()=> '2026-09-22T12:00:00.000Z'});
  try{
    const legacyJson=JSON.stringify({...operationsFixture(),label:'Unmapped enterprise prices'});
    store.db.prepare("INSERT INTO native_configs VALUES('legacy-company','fcl',1,?,NULL)").run(legacyJson);
    let service=create();
    const data=operationsFixture();for(const row of [...data.rates,...data.operations.charges,...data.operations.templates]){Reflect.deleteProperty(row,'valid_from');Reflect.deleteProperty(row,'valid_until');}
    service.save(account('alice','old-company'),'fcl',{expected_version:0,input:data},'same-personal-key-001');
    expect(service.get(account('alice'),'fcl').version).toBe(1);
    expect(service.get(account('bob'),'fcl').draft).toBeNull();
    const bob={...data,label:'Bob prices'};
    service.save(account('bob'),'fcl',{expected_version:0,input:bob},'same-personal-key-001');
    expect(service.get(account('alice'),'fcl').draft).toMatchObject({label:data.label});
    expect(service.get(account('bob','company-b'),'fcl').draft).toMatchObject({label:'Bob prices'});
    const unverified={...account('eve'),identity:{...account('eve').identity,emailVerified:false}};
    expect(()=>service.get(unverified,'fcl')).toThrow('fcl_not_found');
    store.close();store=new NativeAdminStore(join(root,'native.sqlite'),{fcl:{mode:'reopen'}});service=create();
    expect(service.get(account('bob'),'fcl').version).toBe(1);
    expect(store.db.prepare("SELECT draft FROM native_configs WHERE scope='legacy-company' AND kind='fcl'").get()).toEqual({draft:legacyJson});
    expect(store.db.prepare("SELECT DISTINCT scope FROM native_configs WHERE kind='fcl'").all()).toEqual(expect.arrayContaining([{scope:'fcl-person:alice'},{scope:'fcl-person:bob'}]));
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('lets each verified account create its own inquiry without a company, reassignment or notification',async()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-personal-case-'));
  const store=new CaseStore(join(root,'cases.sqlite'),{fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}});
  let sent=0;
  const service=new CaseService(store,{getState:()=>({data:{current_organization:null,memberships:[]}})} as never,{
    receiverUserId:'public-receiver',receiverIsActive:()=>true,credentialSecret:'synthetic-personal-case-credential-secret-32',
    now:()=> '2026-09-22T12:00:00.000Z',credentialTtlDays:30,
    mail:{enabled:true,recipient:'receiver@example.test',transport:{send:()=>{sent+=1;return Promise.resolve();}}},
  });
  const input={...createFclInquiryDraft(),contact:{name:'Synthetic customer',email:'customer@example.test',company:'Customer Ltd',phone:null},consent:true};
  try{
    const alice=await service.createPersonalFclInquiry(account('alice','old-company'),input,'personal-inquiry-key-0001');
    const replay=await service.createPersonalFclInquiry(account('alice'),input,'personal-inquiry-key-0001');
    const bob=await service.createPersonalFclInquiry(account('bob'),input,'personal-inquiry-key-0001');
    expect(replay.case_id).toBe(alice.case_id);expect(bob.case_id).not.toBe(alice.case_id);
    expect(alice.current_input.contact.company).toBe('Customer Ltd');
    expect(service.listFclCases(account('bob'),{}).items.map(item=>item.case_id)).toEqual([bob.case_id]);
    expect(()=>service.getFclCase(account('bob'),alice.case_id)).toThrow('fcl_not_found');
    expect(sent).toBe(0);
    const anonymous=await service.submitFclInquiry('public-session-0001','personal-inquiry-key-0001',input);
    expect(service.getFclCase(account('public-receiver'),anonymous.case_id).case_id).toBe(anonymous.case_id);
    expect(()=>service.getFclCase(account('alice'),anonymous.case_id)).toThrow('fcl_not_found');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
