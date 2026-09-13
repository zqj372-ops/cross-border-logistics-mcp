import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDraft } from '../../apps/inquiry/model';
import { CaseService, CaseStore } from '../../services/access-gateway/portal/cases';
import type { PortalContext } from '../../services/access-gateway/portal/contracts';

const customer: PortalContext = {identity:{userId:'customer-a',displayName:'Customer A',email:'a@example.test',emailVerified:true,platformRole:null},organizationId:null};
const operator: PortalContext = {identity:{userId:'operator-a',displayName:'Operator',email:'ops@example.test',emailVerified:true,platformRole:'operator'},organizationId:null};
const other: PortalContext = {...customer,identity:{...customer.identity,userId:'customer-b'}};
const draft = {...createDraft(),services:['ocean'],transportMode:'fcl',origin:'Shanghai',destination:'Vancouver',product:'Synthetic cartons',containerType:'40HQ',containerCount:'1',contactName:'Synthetic contact',email:'contact@example.test',consent:true};
const portal = {getState:()=>({data:{current_organization:null,memberships:[]}})};

it('persists one inquiry, enforces ownership, filters internal notes and completes a customer/operator readback loop',()=>{
 const root=mkdtempSync(join(tmpdir(),'cases-')); const path=join(root,'cases.sqlite'); let store=new CaseStore(path); let service=new CaseService(store,portal as never);
 try {
  const first=service.create(customer,draft,'create-case-key-1');
  expect(first.status).toBe('submitted'); expect(first.version).toBe(1);
  expect(service.create(customer,draft,'create-case-key-1').case_id).toBe(first.case_id);
  expect(service.list(operator,{management:true}).items).toHaveLength(1);
  expect(service.list(other,{}).items).toHaveLength(0);
  expect(()=>service.get(other,first.case_id)).toThrow('case_not_found');
  expect(()=>service.list(customer,{management:true})).toThrow('case_management_denied');
  expect(()=>service.update(customer,first.case_id,{expected_version:1,status:'in_review',public_note:'Review',internal_note:''},'update-case-key-1')).toThrow();
  const pending=service.update(operator,first.case_id,{expected_version:1,status:'needs_input',public_note:'Please confirm packing.',internal_note:'Internal supplier cost only'},'update-case-key-1');
  expect(pending.version).toBe(2);
  const visible=service.get(customer,first.case_id); expect(JSON.stringify(visible)).not.toContain('Internal supplier cost');
  expect(visible.events.at(-1)?.message).toBe('Please confirm packing.');
  expect(()=>service.update(operator,first.case_id,{expected_version:1,status:'closed',public_note:'done',internal_note:''},'stale-case-key-1')).toThrow('version_conflict');
  const reply=service.reply(customer,first.case_id,{expected_version:2,message:'Confirmed carton packing.'},'reply-case-key-1');
  expect(reply.status).toBe('in_review');
  expect(store.db.prepare('SELECT actor_id FROM business_case_events WHERE case_id=? AND version=3').get(first.case_id)).toEqual({actor_id:customer.identity.userId});
  expect(service.get(operator,first.case_id).events.some(e=>e.message.includes('Internal supplier cost'))).toBe(true);
  store.close(); store=new CaseStore(path); service=new CaseService(store,portal as never);
  expect(service.get(customer,first.case_id).version).toBe(3);
  expect(service.create(customer,draft,'create-case-key-1').version).toBe(3);
  expect(()=>service.create(customer,{...draft,product:'changed'},'create-case-key-1')).toThrow('idempotency_conflict');
  service.update(operator,first.case_id,{expected_version:3,status:'closed',public_note:'Inquiry concluded.',internal_note:''},'close-case-key-1');
  expect(()=>service.reply(customer,first.case_id,{expected_version:4,message:'late'},'reply-case-key-2')).toThrow('case_transition_invalid');
 } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

it('rejects unverified users, forged authority fields and invalid or incomplete demand',()=>{
 const root=mkdtempSync(join(tmpdir(),'cases-'));const store=new CaseStore(join(root,'cases.sqlite'));const service=new CaseService(store,portal as never);
 try {
  expect(()=>service.create({...customer,identity:{...customer.identity,emailVerified:false}},draft,'create-case-key-1')).toThrow();
  expect(()=>service.create(customer,{...draft,tenant_id:'forged'},'create-case-key-1')).toThrow('case_input_invalid');
  expect(()=>service.create(customer,{...draft,consent:false},'create-case-key-1')).toThrow('case_input_invalid');
  expect(()=>service.create(customer,{...draft,containerCount:'-1'},'create-case-key-1')).toThrow('case_input_invalid');
  expect(()=>service.create(customer,{...draft,notes:'x'.repeat(4001)},'create-case-key-1')).toThrow('case_input_invalid');
 } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

it('isolates organizations, revokes management immediately and paginates without duplicates',()=>{
 const root=mkdtempSync(join(tmpdir(),'cases-org-')),store=new CaseStore(join(root,'cases.sqlite'));
 let role='admin',active=true;
 const orgPortal={getState:(ctx:PortalContext)=>({data:{current_organization:ctx.organizationId?{organizationId:ctx.organizationId,status:active?'active':'suspended'}:null,memberships:ctx.organizationId?[{userId:ctx.identity.userId,organizationId:ctx.organizationId,status:'active',role}]:[]}})};
 const service=new CaseService(store,orgPortal as never),member={...customer,organizationId:'org-a'},admin={...other,organizationId:'org-a'};
 try {
  const first=service.create(member,draft,'org-create-case-1');
  service.create(member,draft,'org-create-case-2');
  expect(service.list(admin,{management:true,limit:1}).items).toHaveLength(1);
  const page=service.list(admin,{management:true,limit:1}),next=service.list(admin,{management:true,limit:1,cursor:page.next_cursor});
  expect(next.items[0]?.case_id).not.toBe(page.items[0]?.case_id);expect(next.next_cursor).toBeNull();
  expect(service.list({...admin,organizationId:'org-b'},{management:true}).items).toHaveLength(0);
  expect(()=>service.get({...admin,organizationId:'org-b'},first.case_id)).toThrow('case_not_found');
  expect(()=>service.get(customer,first.case_id)).toThrow('case_not_found');
  service.update(admin,first.case_id,{expected_version:1,status:'in_review',public_note:'Received'},'org-update-case-1');
  role='viewer';
  expect(()=>service.update(admin,first.case_id,{expected_version:1,status:'in_review',public_note:'Received'},'org-update-case-1')).toThrow('case_not_found');
  expect(()=>service.list(admin,{management:true})).toThrow('case_management_denied');
  expect(service.get(member,first.case_id).can_manage).toBe(false);
  active=false;expect(()=>service.get(member,first.case_id)).toThrow('case_access_denied');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('derives a server-owned customer supplement reference without exposing actor_id',()=>{
 const root=mkdtempSync(join(tmpdir(),'cases-link-')),store=new CaseStore(join(root,'cases.sqlite'));
 const orgPortal={getState:(ctx:PortalContext)=>({data:{current_organization:ctx.organizationId?{organizationId:ctx.organizationId,status:'active'}:null,memberships:ctx.organizationId?[{userId:ctx.identity.userId,organizationId:ctx.organizationId,status:'active',role:ctx.identity.userId==='viewer-a'?'viewer':'owner'}]:[]}})};
 const service=new CaseService(store,orgPortal as never),member={...customer,organizationId:'org-a'};
 try {
  const created=service.create(member,draft,'link-case-create-0001');
  const view=service.getV2(member,created.case_id);
  expect(view.review_context.latest_customer_supplement_ref).toBeNull();
  expect(JSON.stringify(view)).not.toContain('actor_id');
  service.update(member,created.case_id,{expected_version:1,status:'needs_input',public_note:'Please confirm packing.',internal_note:''},'link-case-update-0001');
  service.reply(member,created.case_id,{expected_version:2,message:'Confirmed carton packing.'},'link-case-reply-0001');
  const linked=service.getV2(member,created.case_id);
  const event=linked.events.find(e=>e.version===3);
  expect(event).toBeDefined();
  expect(linked.review_context.latest_customer_supplement_ref).toBe(event?.event_id);
  const read=service.readForQuoteLink(member,created.case_id);
  expect(read).toMatchObject({case_ref:created.case_id,organization_id:'org-a',status:'in_review',latest_customer_supplement_ref:event?.event_id});
  expect(JSON.stringify(read)).not.toContain('actor_id');
  expect(()=>service.readForQuoteLink({...member,identity:{...member.identity,userId:'viewer-a'}},created.case_id)).toThrow();
  expect(()=>service.readForQuoteLink({...member,organizationId:'org-b'},created.case_id)).toThrow('case_not_found');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
