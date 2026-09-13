import {createNativeQuoteClient,type QuoteRelease} from '../../services/quote-native/client';
import {config as rates,request as quoteRequest} from '../quote-native/fixture';
import type {PortalBusinessService} from '../../services/access-gateway/portal/business/service';
import {describe,it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DocumentService,DocumentStore,isLinkedReplayResult,type DocumentView,type LinkedWriteResult} from '../../services/quote-documents/service';
import {CaseService,CaseStore} from '../../services/access-gateway/portal/cases';
import {INQUIRY_QUOTE_LINK_VERSION,V2_VERSION,linkedErrorEnvelopeSchema,linkedResponseSchemas,approveLinkedSchema} from '../../services/quote-documents/contracts';
import {createDraft} from '../../apps/inquiry/model';
import {PortalError,type PortalContext} from '../../services/access-gateway/portal/contracts';
import type {PortalService} from '../../services/access-gateway/portal/service';
import {sample,template} from './fixtures';
const dirs:string[]=[];const stores:DocumentStore[]=[];
afterEach(()=>{vi.useRealTimers();stores.splice(0).forEach(s=>s.close());dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
const errorCode=(fn:()=>unknown)=>{try{fn();return null;}catch(error){return error instanceof PortalError?error.code:null;}};
const errorCodeAsync=async(fn:()=>Promise<unknown>)=>{try{await fn();return null;}catch(error){return error instanceof PortalError?error.code:null;}};
const blockedReason=(code:string)=>linkedErrorEnvelopeSchema.safeParse({schema_version:V2_VERSION,status:'blocked',data:null,reason_codes:[code]}).success;
const manualReviewReason=(kind:string,code:string,data:unknown=null)=>linkedResponseSchemas[kind]?.safeParse({schema_version:V2_VERSION,status:'manual_review',data,reason_codes:[code]}).success===true;
const context=(user='owner',org='org'):PortalContext=>({identity:{userId:user,email:user+'@example.test',emailVerified:true,displayName:user,platformRole:null},organizationId:org});
function setup(native?:ConstructorParameters<typeof DocumentService>[3]){const dir=mkdtempSync(join(tmpdir(),'quote-docs-test-'));dirs.push(dir);const store=new DocumentStore(join(dir,'docs.sqlite'));stores.push(store);const portal={getState:(ctx:PortalContext)=>({data:{current_organization:{status:'active'},memberships:[{userId:ctx.identity.userId,organizationId:ctx.organizationId,status:'active',role:ctx.identity.userId==='owner'?'owner':'sales'}]}})} as unknown as Pick<PortalService,'getState'>;const svc=new DocumentService(store,portal,()=>Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120))),native);return {svc,store};}
describe('documents permission and lifecycle',()=>{
 it('starts blank, needs preview and preserves snapshot after configuration changes',()=>{const {svc}=setup(),ctx=context();expect(svc.config(ctx).input).toBeNull();expect(()=>svc.preview(ctx,{input:sample()})).toThrow('document_template_missing');svc.saveConfig(ctx,{expected_version:0,input:template,confirmed:true},randomUUID());const p=svc.preview(ctx,{input:sample()});const input={input:p.input,template_version:p.template_version,preview_hash:p.preview_hash,preview_expires_at:p.preview_expires_at,confirmed:true};const key=randomUUID(),saved=svc.save(ctx,input,key);expect(svc.save(ctx,input,key).id).toBe(saved.id);expect(()=>svc.save(ctx,{...input,input:{...input.input,quote_no:'other'}},key)).toThrow();svc.saveConfig(ctx,{expected_version:1,input:{...template,company_name:'新公司'},confirmed:true},randomUUID());expect(svc.get(ctx,{id:saved.id}).template.company_name).toBe('测试物流');expect(()=>svc.save(ctx,input,randomUUID())).toThrow('document_preview_stale');});
 it('isolates actors and tenants, rejects sales approval and requires evidence',async()=>{const {svc}=setup(),ctx=context();svc.saveConfig(ctx,{expected_version:0,input:template,confirmed:true},randomUUID());const p=svc.preview(ctx,{input:sample()});const s=svc.save(ctx,{...p,confirmed:true},randomUUID());expect(()=>svc.get(context('sales'),{id:s.id})).toThrow('document_not_found');expect(()=>svc.get(context('owner','another'),{id:s.id})).toThrow('document_not_found');const approval={id:s.id,expected_version:1,evidence_ref:'manual:QA',evidence_version:'1',review_notes:'逐项核对',confirmation:'human_verified_price_and_source'};expect(()=>svc.approve(context('sales'),approval,randomUUID())).toThrow();const approved=svc.approve(ctx,approval,randomUUID());expect(approved.state).toBe('approved');const pdf=await svc.export(ctx,{id:s.id});expect(pdf.sha256).toHaveLength(64);expect(pdf.draft).toBe(false);});
 it('rejects expired approval and corrupt stored PDF',async()=>{const {svc,store}=setup(),ctx=context();svc.saveConfig(ctx,{expected_version:0,input:template,confirmed:true},randomUUID());const p=svc.preview(ctx,{input:{...sample(),quote_date:'2020-01-01',valid_until:'2020-01-02'}});const s=svc.save(ctx,{...p,confirmed:true},randomUUID());expect(()=>svc.approve(ctx,{id:s.id,expected_version:1,evidence_ref:'manual:QA',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID())).toThrow('document_expired');expect((await svc.export(ctx,{id:s.id})).draft).toBe(true);store.db.prepare("UPDATE document_pdfs SET bytes=?").run(Buffer.from('broken'));await expect(svc.export(ctx,{id:s.id})).rejects.toThrow('document_pdf_invalid');});
});
describe('preview and export failure closure',()=>{
 it('rejects preview replay by another actor and expired preview',()=>{const {svc}=setup(),ctx=context();svc.saveConfig(ctx,{expected_version:0,input:template,confirmed:true},randomUUID());const p=svc.preview(ctx,{input:sample()});expect(()=>svc.save(context('sales'),{...p,confirmed:true},randomUUID())).toThrow('document_preview_stale');expect(()=>svc.save(ctx,{...p,preview_expires_at:Date.now()-1,confirmed:true},randomUUID())).toThrow('document_preview_stale');});
 it('rejects non-manager template mutation and version conflict',()=>{const {svc}=setup(),input={expected_version:0,input:template,confirmed:true};expect(()=>svc.saveConfig(context('sales'),input,randomUUID())).toThrow('document_management_denied');svc.saveConfig(context(),input,randomUUID());expect(()=>svc.saveConfig(context(),input,randomUUID())).toThrow('version_conflict');});
 it('preserves the original draft PDF when approval creates a new version',async()=>{const {svc,store}=setup(),ctx=context();svc.saveConfig(ctx,{expected_version:0,input:template,confirmed:true},randomUUID());const p=svc.preview(ctx,{input:sample()}),d=svc.save(ctx,{...p,confirmed:true},randomUUID());expect((await svc.export(ctx,{id:d.id})).draft).toBe(true);svc.approve(ctx,{id:d.id,expected_version:1,evidence_ref:'manual:qa',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID());expect((await svc.export(ctx,{id:d.id})).version).toBe(2);expect((store.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get() as {n:number}).n).toBe(2);});
});

describe('native quote record binding',()=>{
 function nativeSetup(){let release:QuoteRelease|null={version:1,release_id:'release_1',digest:'a'.repeat(64),input:rates,published_at:new Date().toISOString()};const client=createNativeQuoteClient(()=>release);const business={execute:async(_ctx:PortalContext,_tool:string,input:unknown,requestId:string)=>client.preview({input,requestId,actor:{type:'user',id:'owner'}})} as unknown as Pick<PortalBusinessService,'execute'>;const {svc}=setup({business,current:()=>release});const ctx=context();svc.saveConfig(ctx,{expected_version:0,input:template,confirmed:true},randomUUID());const q=sample();const customer={quote_no:q.quote_no,customer_name:q.customer_name,quote_date:q.quote_date,valid_until:rates.valid_until,job_no:'',so_no:'',container_no:'',remark:''};return {svc,ctx,customer,disable:()=>{release=null;}};}
 it('recalculates, persists exact evidence, rejects tampering and exports after human approval',async()=>{const {svc,ctx,customer}=nativeSetup();const p=await svc.prepareNative(ctx,{request:quoteRequest,customer});expect(p.native_quote_v1.preview.total_price).toBe('268.00');expect(p.native_quote_v1.release_id).toBe('release_1');expect(()=>svc.save(ctx,{...p,input:{...p.input,fee_items:[{...p.input.fee_items[0],unit_price:'1'}]},confirmed:true},randomUUID())).toThrow('document_preview_stale');const row=svc.save(ctx,{...p,confirmed:true},randomUUID());expect(svc.get(ctx,{id:row.id}).native_quote_v1?.request).toEqual(quoteRequest);svc.approve(ctx,{id:row.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对来源版本和条件',confirmation:'human_verified_price_and_source'},randomUUID());expect((await svc.export(ctx,{id:row.id})).draft).toBe(false);});
 it('blocks saving and formal export after the release is disabled',async()=>{const {svc,ctx,customer,disable}=nativeSetup();const p=await svc.prepareNative(ctx,{request:quoteRequest,customer});const row=svc.save(ctx,{...p,confirmed:true},randomUUID());svc.approve(ctx,{id:row.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID());await svc.export(ctx,{id:row.id});disable();expect(()=>svc.save(ctx,{...p,confirmed:true},randomUUID())).toThrow('native_quote_source_changed');await expect(svc.export(ctx,{id:row.id})).rejects.toThrow('native_quote_source_changed');});
 it('records rejection once and refuses export or later approval',async()=>{const {svc,ctx,customer}=nativeSetup();const p=await svc.prepareNative(ctx,{request:quoteRequest,customer});const row=svc.save(ctx,{...p,confirmed:true},randomUUID());const input={id:row.id,expected_version:1,reason:'客户卸货条件需要修改'},key=randomUUID();expect(svc.reject(ctx,input,key).state).toBe('rejected');expect(svc.reject(ctx,input,key).version).toBe(2);await expect(svc.export(ctx,{id:row.id})).rejects.toThrow('document_rejected');expect(()=>svc.approve(ctx,{id:row.id,expected_version:2,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID())).toThrow('version_conflict');});
});

it('marks the binding and rejection storage format for rollback safety',()=>{const {store}=setup();expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(2);});

it('reopens version 2 without losing stored documents',()=>{const {store}=setup();const again=new DocumentStore(store.path);expect(again.db.prepare('PRAGMA user_version').get()!.user_version).toBe(2);again.close();});

describe('linked inquiry quote flow',()=>{
 function linkedSetup(){
  const dir=mkdtempSync(join(tmpdir(),'quote-docs-link-')),docStore=new DocumentStore(join(dir,'docs.sqlite')),caseStore=new CaseStore(join(dir,'cases.sqlite'));
  dirs.push(dir);stores.push(docStore);
  const org='org-link',owner='owner-link',revokedUsers=new Set<string>();let organizationActive=true,memberRole:'owner'|'admin'|'sales'='owner';
  const portal={getState:(ctx:PortalContext)=>({data:{current_organization:ctx.organizationId?{organizationId:ctx.organizationId,status:organizationActive?'active':'inactive'}:null,memberships:ctx.organizationId&&!revokedUsers.has(ctx.identity.userId)?[{userId:ctx.identity.userId,organizationId:ctx.organizationId,status:'active',role:memberRole}]:[]}})} as unknown as Pick<PortalService,'getState'>;
  let release:QuoteRelease|null={version:1,release_id:'release_link',digest:'a'.repeat(64),input:rates,published_at:new Date().toISOString()};
  const client=createNativeQuoteClient(()=>release);
  let nativeHook:(()=>void|Promise<void>)|undefined,renderHook:(()=>void)|undefined;
  const business={execute:async(_ctx:PortalContext,_tool:string,input:unknown,requestId:string)=>{const result=await client.preview({input,requestId,actor:{type:'user',id:owner}});await nativeHook?.();return result;}} as unknown as Pick<PortalBusinessService,'execute'>;
  let renderCount=0;const renderer=()=>{renderCount++;renderHook?.();return Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120)));};
  const caseService=new CaseService(caseStore,portal),ctx:PortalContext={identity:{userId:owner,displayName:'Owner',email:'owner@example.test',emailVerified:true,platformRole:null},organizationId:org};
  let caseAccessAllowed=true;
  const hiddenCases=new Set<string>(),caseDenied=(caseRef:string)=>!caseAccessAllowed||hiddenCases.has(caseRef);
  let caseAccessFailure=false;
  const caseAccess={readForQuoteView:(context:PortalContext,caseRef:string)=>{if(caseAccessFailure)throw new PortalError('cases_unavailable');if(caseDenied(caseRef))throw new PortalError('case_not_found');return caseService.readForQuoteView(context,caseRef);},readForQuoteLink:(context:PortalContext,caseRef:string)=>{if(caseAccessFailure)throw new PortalError('cases_unavailable');if(caseDenied(caseRef))throw new PortalError('case_not_found');return caseService.readForQuoteLink(context,caseRef);}};
  const svc=new DocumentService(docStore,portal,renderer,{business,current:()=>release},caseAccess);
  svc.saveConfig(ctx,{expected_version:0,input:template,confirmed:true},randomUUID());
  const caseDraft={...createDraft(),services:['ocean'],transportMode:'fcl',origin:'Shanghai',destination:'Toronto M5X 1A9',product:'Synthetic cargo',containerType:'40HQ',containerCount:'1',contactName:'Synthetic owner',email:'contact@example.test',consent:true};
  const created=caseService.create(ctx,caseDraft,'link-case-create-0001');
  caseService.update(ctx,created.case_id,{expected_version:1,status:'needs_input',public_note:'Please confirm packing.',internal_note:''},'link-case-update-0001');
  caseService.reply(ctx,created.case_id,{expected_version:2,message:'Carton packing confirmed.'},'link-case-reply-0001');
  const review=caseService.readForQuoteLink(ctx,created.case_id);
  const customer={quote_no:'QA-LINK-001',customer_name:'Synthetic owner',quote_date:new Date().toISOString().slice(0,10),valid_until:rates.valid_until,job_no:'',so_no:'',container_no:'',remark:''};
  const prepareInput=(customerOverride=customer)=>({contract_version:INQUIRY_QUOTE_LINK_VERSION,case_ref:created.case_id,expected_customer_event_ref:review.latest_customer_supplement_ref,request:quoteRequest,customer:customerOverride});
  type Prepared= Awaited<ReturnType<DocumentService['prepareNative']>>;
  const saveInput=(p:Prepared)=>{if(!p.inquiry_case_link_v1)throw new Error('missing link');return {contract_version:INQUIRY_QUOTE_LINK_VERSION,input:p.input,template_version:p.template_version,preview_hash:p.preview_hash,preview_expires_at:p.preview_expires_at,native_quote_v1:p.native_quote_v1,inquiry_case_link_v1:p.inquiry_case_link_v1,confirmed:true};};
  const addSupplement=(label:string)=>{caseService.update(ctx,created.case_id,{expected_version:caseService.get(ctx,created.case_id).version,status:'needs_input',public_note:label,internal_note:''},`link-case-update-${label}`);caseService.reply(ctx,created.case_id,{expected_version:caseService.get(ctx,created.case_id).version,message:`Supplement ${label}`},`link-case-reply-${label}`);};
  const documentOf=(result:LinkedWriteResult):DocumentView=>{if(isLinkedReplayResult(result))throw new Error(`unexpected replay:${result.reason}`);return result;};
  const count=(sql:string)=>(docStore.db.prepare(sql).get() as {n:number}).n;
  const counts=()=>({documents:count('SELECT COUNT(*) AS n FROM quote_documents'),audit:count('SELECT COUNT(*) AS n FROM document_audit'),pdfs:count('SELECT COUNT(*) AS n FROM document_pdfs')});
  return {svc,caseService,ctx,docStore,created,review,customer,prepareInput,saveInput,documentOf,addSupplement,counts,revokeMembership:(user:string=owner)=>{revokedUsers.add(user);},setRole:(role:'owner'|'admin'|'sales')=>{memberRole=role;},deactivateOrganization:()=>{organizationActive=false;},expireRelease:()=>{if(release)release={...release,input:{...release.input,valid_until:'2026-09-01'}};},createCase:(key:string)=>caseService.create(ctx,caseDraft,key),hideCase:(ref:string)=>{hiddenCases.add(ref);},renderCount:()=>renderCount,disableRelease:()=>{release=null;},changeReleaseDigest:()=>{if(release)release={...release,digest:'f'.repeat(64)};},revokeCaseAccess:()=>{caseAccessAllowed=false;},failCaseAccess:()=>{caseAccessFailure=true;},setNativeHook:(hook:()=>void|Promise<void>)=>{nativeHook=hook;},setRenderHook:(hook:()=>void)=>{renderHook=hook;}};
 }

 it('derives review context and completes linked prepare, save, approve and formal export',async()=>{
  const f=linkedSetup();const p=await f.svc.prepareLinked(f.ctx,f.prepareInput());
  expect(p.inquiry_case_link_v1).toEqual({case_ref:f.created.case_id,reviewed_customer_event_ref:f.review.latest_customer_supplement_ref});
  const saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));expect(saved.inquiry_case_link_v1?.case_ref).toBe(f.created.case_id);
  expect(linkedResponseSchemas.save?.safeParse({schema_version:V2_VERSION,status:'success',data:saved,reason_codes:[]}).success).toBe(true);
  expect(f.svc.getLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id}).inquiry_case_link_v1).toEqual(saved.inquiry_case_link_v1);
  const approved=f.documentOf(f.svc.approveLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对来源',confirmation:'human_verified_price_and_source'},randomUUID()));
  expect(approved.state).toBe('approved');
  const pdf=await f.svc.exportLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,mode:'formal'});
  expect(pdf).toMatchObject({draft:false,historical:false,valid_now:true});
  if(!('inquiry_case_link_v1' in pdf))throw new Error('linked export missing link');
  expect(pdf.inquiry_case_link_v1).toEqual(saved.inquiry_case_link_v1);
  expect(linkedResponseSchemas.export?.safeParse({schema_version:V2_VERSION,status:'success',data:pdf,reason_codes:[]}).success).toBe(true);
 });

 it('requires the staff-expected customer supplement before signing',async()=>{
  const f=linkedSetup();await expect(f.svc.prepareLinked(f.ctx,{...f.prepareInput(),expected_customer_event_ref:null})).rejects.toThrow('inquiry_quote_case_review_required');
 });

 it('blocks saving a preview when a new customer supplement is unreviewed',async()=>{
  const f=linkedSetup();const p=await f.svc.prepareLinked(f.ctx,f.prepareInput());f.addSupplement('after-preview');
  expect(()=>f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID())).toThrow('inquiry_quote_case_review_required');
 });

 it('keeps a signed preview valid across a staff status update and internal note (IQL-01)',async()=>{
  const f=linkedSetup(),staff=context('staff-link','org-link'),p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),version=()=>f.caseService.get(f.ctx,f.created.case_id).version;
  f.caseService.update(staff,f.created.case_id,{expected_version:version(),status:'needs_input',public_note:'Operator asks the customer for more detail.',internal_note:'Internal note only.'},'link-case-staff-update-1');
  f.caseService.update(staff,f.created.case_id,{expected_version:version(),status:'in_review',public_note:'Operator resumed review.'},'link-case-staff-update-2');
  expect(f.caseService.readForQuoteLink(staff,f.created.case_id).latest_customer_supplement_ref).toBe(f.review.latest_customer_supplement_ref);
  const saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  expect(saved).toMatchObject({state:'draft',version:1});
  expect(saved.inquiry_case_link_v1?.reviewed_customer_event_ref).toBe(f.review.latest_customer_supplement_ref);
 });

 it('rejects v1 mutation of a linked document before write and keeps linked reject available',async()=>{
  const f=linkedSetup();const p=await f.svc.prepareLinked(f.ctx,f.prepareInput());const saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  expect(()=>f.svc.reject(f.ctx,{id:saved.id,expected_version:1,reason:'v1 must not write'},randomUUID())).toThrow('document_contract_version_required');
  expect(()=>f.svc.get(f.ctx,{id:saved.id})).toThrow('document_contract_version_required');
  expect(f.svc.getLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id}).state).toBe('draft');
  f.addSupplement('before-reject');const rejected=f.documentOf(f.svc.rejectLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,reason:'stale draft correction'},randomUUID()));
  expect(rejected.state).toBe('rejected');
 });

 it('history export returns only cached bytes and never renders',async()=>{
  const f=linkedSetup();const p=await f.svc.prepareLinked(f.ctx,f.prepareInput());const saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  await expect(f.svc.exportLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,mode:'history'})).rejects.toThrow('inquiry_quote_history_bytes_missing');
  expect(f.renderCount()).toBe(0);
  const bytes=Buffer.from('%PDF-1.7\n'+'.'.repeat(120)),sha=createHash('sha256').update(bytes).digest('hex');
  f.docStore.db.prepare('INSERT OR REPLACE INTO document_pdfs VALUES(?,?,?,?)').run(saved.id,1,sha,bytes);
  const history=await f.svc.exportLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,mode:'history'});
  expect(history).toMatchObject({draft:true,historical:true,valid_now:false});expect(f.renderCount()).toBe(0);
 });

 it('blocks a new formal export but still reads history after the case becomes terminal (IQL-11)',async()=>{
  const f=linkedSetup(),doc=await approvedLinked(f),prepared=await f.svc.prepareLinked(f.ctx,f.prepareInput()),formal=await f.svc.exportLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:doc.id,mode:'formal'});
  f.caseService.update(f.ctx,f.created.case_id,{expected_version:f.caseService.get(f.ctx,f.created.case_id).version,status:'closed',public_note:'Closed after quote.'},'link-case-close-0001');
  expect(()=>f.svc.saveLinked(f.ctx,f.saveInput(prepared),randomUUID())).toThrow('inquiry_quote_case_closed');
  await expect(f.svc.prepareLinked(f.ctx,f.prepareInput())).rejects.toThrow('inquiry_quote_case_closed');
  await expect(f.svc.exportLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:doc.id,mode:'formal'})).rejects.toThrow('inquiry_quote_case_closed');
  const history=await f.svc.exportLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:doc.id,mode:'history'});
  expect(history).toMatchObject({id:doc.id,version:2,draft:false,historical:true,valid_now:false,sha256:formal.sha256});
  expect(f.renderCount()).toBe(1);
 });

 it('replay after approval is reported as not current without a second write',async()=>{
  const f=linkedSetup();const p=await f.svc.prepareLinked(f.ctx,f.prepareInput());const key=randomUUID(),input=f.saveInput(p),saved=f.documentOf(f.svc.saveLinked(f.ctx,input,key));
  f.svc.approveLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID());
  const replay=f.svc.saveLinked(f.ctx,input,key);
  expect(isLinkedReplayResult(replay)&&replay.reason).toBe('inquiry_quote_replay_not_current');
  if(!isLinkedReplayResult(replay))throw new Error('expected replay result');
  expect(replay.data).toMatchObject({id:saved.id,version:1,current_version:2,current_state:'approved',current:false});
  expect((f.docStore.db.prepare('SELECT COUNT(*) AS n FROM quote_documents').get() as {n:number}).n).toBe(1);
 });
 it('reports a committed linked save as stale after an unreviewed supplement without a second write',async()=>{
  const f=linkedSetup(),p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),key=randomUUID(),input=f.saveInput(p),saved=f.documentOf(f.svc.saveLinked(f.ctx,input,key));
  f.addSupplement('after-commit');
  const replay=f.svc.saveLinked(f.ctx,input,key);
  expect(isLinkedReplayResult(replay)&&replay.reason).toBe('inquiry_quote_replay_stale');
  if(!isLinkedReplayResult(replay))throw new Error('expected replay result');
  expect(replay.data).toEqual({id:saved.id,version:1,committed:true,replay:true,valid_now:false,historical:true});
  expect(linkedResponseSchemas.save?.safeParse({schema_version:V2_VERSION,status:'manual_review',data:replay.data,reason_codes:[replay.reason]}).success).toBe(true);
  expect((f.docStore.db.prepare('SELECT COUNT(*) AS n FROM quote_documents').get() as {n:number}).n).toBe(1);
  expect(f.svc.getLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id})).toMatchObject({id:saved.id,version:1,state:'draft'});
 });

 it('rejects a linked replay whose input changed for the same idempotency key before any other check',async()=>{
  const f=linkedSetup(),p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),key=randomUUID(),input=f.saveInput(p);f.documentOf(f.svc.saveLinked(f.ctx,input,key));
  expect(()=>f.svc.saveLinked(f.ctx,{...input,input:{...input.input,quote_no:'QA-LINK-ALTERED'}},key)).toThrow('idempotency_conflict');
  expect((f.docStore.db.prepare('SELECT COUNT(*) AS n FROM quote_documents').get() as {n:number}).n).toBe(1);
 });

 it('requires explicit v2 list limit and reads unlinked records through the v2 service path',()=>{
  const f=linkedSetup();expect(errorCode(()=>f.svc.listLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION}))).toBe('inquiry_quote_link_input_invalid');
  const p=f.svc.preview(f.ctx,{input:sample()}),unlinked=f.svc.save(f.ctx,{...p,confirmed:true},randomUUID());
  expect(f.svc.getLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:unlinked.id}).inquiry_case_link_v1).toBeUndefined();
 });

 it('filters linked records from v1 list and blocks v1 get',async()=>{
  const f=linkedSetup();const p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),linked=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  const v1=f.svc.preview(f.ctx,{input:sample()}),unlinked=f.svc.save(f.ctx,{...v1,confirmed:true},randomUUID());
  expect(f.svc.list(f.ctx,{limit:10}).items.map(item=>item.id)).toEqual([unlinked.id]);
  expect(()=>f.svc.get(f.ctx,{id:linked.id})).toThrow('document_contract_version_required');
  expect(f.svc.getLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:linked.id}).id).toBe(linked.id);
 });

 it('pages every visible linked and unlinked row exactly once when a linked case is hidden',async()=>{
  const f=linkedSetup(),second=f.createCase('link-case-create-0002'),hiddenCase=second.case_id;
  const first=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(await f.svc.prepareLinked(f.ctx,f.prepareInput())),randomUUID()));
  const hidden=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(await f.svc.prepareLinked(f.ctx,{...f.prepareInput(),case_ref:hiddenCase,expected_customer_event_ref:null})),randomUUID()));
  const third=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(await f.svc.prepareLinked(f.ctx,f.prepareInput())),randomUUID()));
  const unlinked=f.svc.save(f.ctx,{...f.svc.preview(f.ctx,{input:sample()}),confirmed:true},randomUUID());
  f.hideCase(hiddenCase);
  expect(()=>f.svc.getLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:hidden.id})).toThrow('document_not_found');
  expect((f.docStore.db.prepare('SELECT COUNT(*) AS n FROM quote_documents').get() as {n:number}).n).toBe(4);
  const readAll=(limit:number)=>{const ids:string[]=[];let before:number|undefined;for(let page=0;page<10;page++){const result=f.svc.listLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,limit,...(before===undefined?{}:{before})});expect(linkedResponseSchemas.list?.safeParse({schema_version:V2_VERSION,status:'success',data:result,reason_codes:[]}).success).toBe(true);ids.push(...result.items.map(item=>item.id));if(result.next_cursor===null)return ids;before=result.next_cursor;}throw new Error('pagination did not terminate');};
  const expected=[unlinked.id,third.id,first.id];
  expect(readAll(1)).toEqual(expected);
  expect(readAll(2)).toEqual(expected);
  expect(readAll(100)).toEqual(expected);
  expect(new Set(readAll(1)).size).toBe(3);
  expect(first.inquiry_case_link_v1?.case_ref).toBe(f.created.case_id);
  expect(hidden.id).not.toBe(first.id);
 });

 it('revokes linked reads when the case accessor loses visibility without rendering',async()=>{
  const f=linkedSetup();const p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),linked=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  const bytes=Buffer.from('%PDF-1.7\n'+'.'.repeat(120)),sha=createHash('sha256').update(bytes).digest('hex');
  f.docStore.db.prepare('INSERT OR REPLACE INTO document_pdfs VALUES(?,?,?,?)').run(linked.id,1,sha,bytes);
  await expect(f.svc.exportLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:linked.id,mode:'history'})).resolves.toMatchObject({historical:true,valid_now:false});
  f.revokeCaseAccess();
  expect(()=>f.svc.getLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:linked.id})).toThrow('document_not_found');
  await expect(f.svc.exportLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:linked.id,mode:'history'})).rejects.toThrow('document_not_found');
  expect(f.renderCount()).toBe(0);
 });

 it('returns structured expired replay data without a second write',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
  const f=linkedSetup(),customer={...f.customer,valid_until:'2026-10-13'},p=await f.svc.prepareLinked(f.ctx,f.prepareInput(customer));
  const input=f.saveInput(p),key=randomUUID(),saved=f.documentOf(f.svc.saveLinked(f.ctx,input,key));
  const approval={contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'};
  f.documentOf(f.svc.approveLinked(f.ctx,approval,key));
  vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
  const replay=f.svc.approveLinked(f.ctx,approval,key);
  expect(isLinkedReplayResult(replay)&&replay.reason).toBe('inquiry_quote_replay_expired');
  if(!isLinkedReplayResult(replay))throw new Error('expected replay result');
  expect(replay.data).toMatchObject({id:saved.id,version:2,committed:true,replay:true,valid_now:false,historical:true});
  expect((f.docStore.db.prepare('SELECT COUNT(*) AS n FROM quote_documents').get() as {n:number}).n).toBe(1);
 });

 it('rejects a tampered preview and never writes a cache for missing history bytes',async()=>{
  const f=linkedSetup();const p=await f.svc.prepareLinked(f.ctx,f.prepareInput());
  expect(errorCode(()=>f.svc.saveLinked(f.ctx,{...f.saveInput(p),preview_hash:'0'.repeat(64)},randomUUID()))).toBe('inquiry_quote_link_forgery');
  const saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  await expect(f.svc.exportLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,mode:'history'})).rejects.toThrow('inquiry_quote_history_bytes_missing');
  expect((f.docStore.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get() as {n:number}).n).toBe(0);
 });

 it('rechecks customer supplement and source changes after the native await',async()=>{
  const supplement=linkedSetup();supplement.setNativeHook(()=>supplement.addSupplement('during-native'));
  await expect(supplement.svc.prepareLinked(supplement.ctx,supplement.prepareInput())).rejects.toThrow('inquiry_quote_case_review_required');
  const source=linkedSetup();source.setNativeHook(()=>source.changeReleaseDigest());
  await expect(source.svc.prepareLinked(source.ctx,source.prepareInput())).rejects.toThrow('native_quote_source_changed');
 });

 async function approvedLinked(f:ReturnType<typeof linkedSetup>){const p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));f.documentOf(f.svc.approveLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID()));return saved;}

 it('rechecks case visibility and source after asynchronous PDF rendering without cache write',async()=>{
  const denied=linkedSetup();const deniedDoc=await approvedLinked(denied);denied.setRenderHook(()=>denied.revokeCaseAccess());
  await expect(denied.svc.exportLinked(denied.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:deniedDoc.id,mode:'formal'})).rejects.toThrow('document_not_found');
  expect((denied.docStore.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get() as {n:number}).n).toBe(0);
  const source=linkedSetup();const sourceDoc=await approvedLinked(source);source.setRenderHook(()=>source.disableRelease());
  await expect(source.svc.exportLinked(source.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:sourceDoc.id,mode:'formal'})).rejects.toThrow('native_quote_source_changed');
  expect((source.docStore.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get() as {n:number}).n).toBe(0);
 });

 it('writes no PDF cache when the document or the case changes while the render is pending',async()=>{
  const changed=linkedSetup(),changedDoc=await approvedLinked(changed);
  changed.setRenderHook(()=>{const row=changed.docStore.db.prepare('SELECT payload FROM quote_documents WHERE id=?').get(changedDoc.id) as {payload:string},payload=JSON.parse(row.payload) as DocumentView;changed.docStore.db.prepare('UPDATE quote_documents SET payload=? WHERE id=?').run(JSON.stringify({...payload,version:payload.version+1}),changedDoc.id);});
  await expect(changed.svc.exportLinked(changed.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:changedDoc.id,mode:'formal'})).rejects.toThrow('version_conflict');
  expect((changed.docStore.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get() as {n:number}).n).toBe(0);
  expect(changed.renderCount()).toBe(1);
  const supplemented=linkedSetup(),supplementedDoc=await approvedLinked(supplemented);
  supplemented.setRenderHook(()=>supplemented.addSupplement('during-render'));
  await expect(supplemented.svc.exportLinked(supplemented.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:supplementedDoc.id,mode:'formal'})).rejects.toThrow('inquiry_quote_case_review_required');
  expect((supplemented.docStore.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get() as {n:number}).n).toBe(0);
  expect(supplemented.renderCount()).toBe(1);
 });

 it('blocks replay of a closed case or revoked case access without a second write',async()=>{
  const closed=linkedSetup();const closedP=await closed.svc.prepareLinked(closed.ctx,closed.prepareInput()),closedKey=randomUUID(),closedInput=closed.saveInput(closedP);closed.documentOf(closed.svc.saveLinked(closed.ctx,closedInput,closedKey));
  const version=closed.caseService.get(closed.ctx,closed.created.case_id).version;closed.caseService.update(closed.ctx,closed.created.case_id,{expected_version:version,status:'closed',public_note:'Close after quote draft.'},randomUUID());
  expect(()=>closed.svc.saveLinked(closed.ctx,closedInput,closedKey)).toThrow('inquiry_quote_case_closed');
  expect((closed.docStore.db.prepare('SELECT COUNT(*) AS n FROM quote_documents').get() as {n:number}).n).toBe(1);
  const revoked=linkedSetup();const revokedP=await revoked.svc.prepareLinked(revoked.ctx,revoked.prepareInput()),revokedKey=randomUUID(),revokedInput=revoked.saveInput(revokedP);revoked.documentOf(revoked.svc.saveLinked(revoked.ctx,revokedInput,revokedKey));revoked.revokeCaseAccess();
  expect(errorCode(()=>revoked.svc.saveLinked(revoked.ctx,revokedInput,revokedKey))).toBe('document_not_found');
  expect((revoked.docStore.db.prepare('SELECT COUNT(*) AS n FROM quote_documents').get() as {n:number}).n).toBe(1);
 });

 it('rejects stripped or forged association input',async()=>{
  const f=linkedSetup();const p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),input=f.saveInput(p),stripped:Record<string,unknown>={...input};delete stripped.inquiry_case_link_v1;
  expect(errorCode(()=>f.svc.saveLinked(f.ctx,stripped,randomUUID()))).toBe('inquiry_quote_link_input_invalid');
  expect(errorCode(()=>f.svc.saveLinked(f.ctx,{...input,inquiry_case_link_v1:{...input.inquiry_case_link_v1,case_ref:randomUUID()}},randomUUID()))).toBe('inquiry_quote_link_forgery');
 });

 it('authorizes a linked save replay before key, terminal and version checks (C4 A/B/C)',async()=>{
  const closed=linkedSetup(),cp=await closed.svc.prepareLinked(closed.ctx,closed.prepareInput()),ckey=randomUUID(),cinput=closed.saveInput(cp);
  const saved=closed.documentOf(closed.svc.saveLinked(closed.ctx,cinput,ckey));
  closed.documentOf(closed.svc.approveLinked(closed.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID()));
  closed.caseService.update(closed.ctx,closed.created.case_id,{expected_version:closed.caseService.get(closed.ctx,closed.created.case_id).version,status:'closed',public_note:'Closed after approval.'},'link-case-close-0004');
  const closedBefore=closed.counts();
  expect(errorCode(()=>closed.svc.saveLinked(closed.ctx,cinput,ckey))).toBe('inquiry_quote_case_closed');
  expect(blockedReason('inquiry_quote_case_closed')).toBe(true);
  expect(closed.counts()).toEqual(closedBefore);
  expect(closed.counts().documents).toBe(1);
  const revoked=linkedSetup(),rp=await revoked.svc.prepareLinked(revoked.ctx,revoked.prepareInput()),rkey=randomUUID(),rinput=revoked.saveInput(rp);
  const revokedSaved=revoked.documentOf(revoked.svc.saveLinked(revoked.ctx,rinput,rkey));
  revoked.documentOf(revoked.svc.approveLinked(revoked.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:revokedSaved.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID()));
  revoked.revokeCaseAccess();
  const revokedBefore=revoked.counts();
  expect(errorCode(()=>revoked.svc.saveLinked(revoked.ctx,rinput,rkey))).toBe('document_not_found');
  expect(blockedReason('document_not_found')).toBe(true);
  expect(revoked.counts()).toEqual(revokedBefore);
  expect(errorCode(()=>revoked.svc.saveLinked(revoked.ctx,{...rinput,input:{...rinput.input,quote_no:'QA-LINK-ALTERED'}},rkey))).toBe('document_not_found');
  expect(revoked.counts()).toEqual(revokedBefore);
 });

 it('keeps the linked reject corrective exception while still enforcing case visibility',async()=>{
  const f=linkedSetup(),p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  const key=randomUUID(),body={contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,reason:'stale draft correction'};
  f.documentOf(f.svc.rejectLinked(f.ctx,body,key));
  f.addSupplement('after-reject');
  expect(f.svc.rejectLinked(f.ctx,body,key)).toMatchObject({id:saved.id,state:'rejected',version:2});
  f.caseService.update(f.ctx,f.created.case_id,{expected_version:f.caseService.get(f.ctx,f.created.case_id).version,status:'closed',public_note:'Closed after rejection.'},'link-case-close-0005');
  const before=f.counts();
  expect(f.svc.rejectLinked(f.ctx,body,key)).toMatchObject({id:saved.id,state:'rejected'});
  expect(f.counts()).toEqual(before);
  f.revokeCaseAccess();
  expect(errorCode(()=>f.svc.rejectLinked(f.ctx,body,key))).toBe('document_not_found');
  expect(f.counts()).toEqual(before);
 });

 it('rechecks the bound release validity after the native await before signing a linked preview',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2027-01-01T23:59:00Z'));
  const f=linkedSetup();f.setNativeHook(()=>{vi.setSystemTime(new Date('2027-01-02T00:01:00Z'));});
  expect(await errorCodeAsync(()=>f.svc.prepareLinked(f.ctx,f.prepareInput()))).toBe('native_quote_release_expired');
  expect(f.counts()).toEqual({documents:0,audit:1,pdfs:0});
  vi.useRealTimers();
 });

 it('requires case visibility before the first linked rejection and leaves the record untouched',async()=>{
  const f=linkedSetup(),p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  const before=f.counts();f.revokeCaseAccess();
  expect(errorCode(()=>f.svc.rejectLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,reason:'stale draft correction'},randomUUID()))).toBe('document_not_found');
  expect(f.counts()).toEqual(before);
  expect(JSON.parse((f.docStore.db.prepare('SELECT payload FROM quote_documents WHERE id=?').get(saved.id) as {payload:string}).payload)).toMatchObject({id:saved.id,version:1,state:'draft'});
 });

 it('propagates case dependency failures instead of returning an empty linked list',async()=>{
  const f=linkedSetup(),p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  f.failCaseAccess();
  expect(errorCode(()=>f.svc.listLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,limit:10}))).toBe('cases_unavailable');
  expect(errorCode(()=>f.svc.getLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id}))).toBe('cases_unavailable');
  expect(f.renderCount()).toBe(0);
 });

 it('approves an unlinked document through the v2 path and replays it with v1 semantics after expiry',()=>{
  const {svc,store}=setup(),ctx=context();
  svc.saveConfig(ctx,{expected_version:0,input:template,confirmed:true},randomUUID());
  const p=svc.preview(ctx,{input:{...sample(),quote_date:new Date().toISOString().slice(0,10)}});
  const saved=svc.save(ctx,{...p,confirmed:true},'link-unlinked-approve-01');
  const key='link-unlinked-approve-02',body=approveLinkedSchema.parse({contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'});
  const approved=svc.approveLinked(ctx,body,key);
  expect(approved).toMatchObject({id:saved.id,state:'approved',version:2});
  expect(approved).not.toHaveProperty('reason');
  const count=(table:string)=>(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n,documents=count('quote_documents'),audit=count('document_audit');
  vi.useFakeTimers();vi.setSystemTime(new Date(Date.parse(`${sample().valid_until}T00:00:00Z`)+86400000));
  const replay=svc.approveLinked(ctx,body,key);
  expect(replay).not.toHaveProperty('reason');
  expect(replay).toMatchObject({id:saved.id,state:'approved',version:2});
  expect(count('quote_documents')).toBe(documents);
  expect(count('document_audit')).toBe(audit);
  vi.useRealTimers();
 });

 it('uses the approved linked reason codes for forgery, stale preview, expired release and expired export',async()=>{
  const forged=linkedSetup(),fp=await forged.svc.prepareLinked(forged.ctx,forged.prepareInput());
  expect(errorCode(()=>forged.svc.saveLinked(forged.ctx,{...forged.saveInput(fp),preview_hash:'0'.repeat(64)},randomUUID()))).toBe('inquiry_quote_link_forgery');
  expect(blockedReason('inquiry_quote_link_forgery')).toBe(true);
  expect(forged.counts()).toEqual({documents:0,audit:1,pdfs:0});
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
  const stale=linkedSetup(),sp=await stale.svc.prepareLinked(stale.ctx,stale.prepareInput());
  vi.setSystemTime(new Date('2026-09-13T01:00:00Z'));
  expect(errorCode(()=>stale.svc.saveLinked(stale.ctx,stale.saveInput(sp),randomUUID()))).toBe('document_preview_stale');
  expect(manualReviewReason('save','document_preview_stale')).toBe(true);
  const expired=linkedSetup(),ep=await expired.svc.prepareLinked(expired.ctx,expired.prepareInput()),edoc=expired.documentOf(expired.svc.saveLinked(expired.ctx,expired.saveInput(ep),randomUUID()));
  expired.documentOf(expired.svc.approveLinked(expired.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:edoc.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID()));
  expired.expireRelease();
  expect(await errorCodeAsync(()=>expired.svc.exportLinked(expired.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:edoc.id,mode:'formal'}))).toBe('native_quote_release_expired');
  expect(manualReviewReason('export','native_quote_release_expired')).toBe(true);
  expect(expired.counts()).toEqual({documents:1,audit:3,pdfs:0});
  const exportExpired=linkedSetup(),xp=await exportExpired.svc.prepareLinked(exportExpired.ctx,exportExpired.prepareInput()),xdoc=exportExpired.documentOf(exportExpired.svc.saveLinked(exportExpired.ctx,exportExpired.saveInput(xp),randomUUID()));
  exportExpired.documentOf(exportExpired.svc.approveLinked(exportExpired.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:xdoc.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID()));
  vi.setSystemTime(new Date('2027-02-01T00:00:00Z'));
  expect(await errorCodeAsync(()=>exportExpired.svc.exportLinked(exportExpired.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:xdoc.id,mode:'formal'}))).toBe('inquiry_quote_export_expired');
  expect(manualReviewReason('export','inquiry_quote_export_expired')).toBe(true);
  expect(exportExpired.counts()).toEqual({documents:1,audit:3,pdfs:0});
  expect(exportExpired.renderCount()).toBe(0);
  vi.useRealTimers();
 });

 it('rebinds a new signed preview to the latest supplement and requires fresh save and approval for a changed request (IQL-03/04)',async()=>{
  const f=linkedSetup(),p1=await f.svc.prepareLinked(f.ctx,f.prepareInput());
  f.addSupplement('iql-03');
  const latest=()=>f.caseService.readForQuoteLink(f.ctx,f.created.case_id).latest_customer_supplement_ref;
  const p2=await f.svc.prepareLinked(f.ctx,{...f.prepareInput(),expected_customer_event_ref:latest()});
  expect(p2.inquiry_case_link_v1?.reviewed_customer_event_ref).toBe(latest());
  expect(p2.inquiry_case_link_v1?.reviewed_customer_event_ref).not.toBe(p1.inquiry_case_link_v1?.reviewed_customer_event_ref);
  expect(p2.native_quote_v1?.request_hash).toBe(p1.native_quote_v1?.request_hash);
  expect(errorCode(()=>f.svc.saveLinked(f.ctx,f.saveInput(p1),randomUUID()))).toBe('inquiry_quote_case_review_required');
  const saved2=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p2),randomUUID()));
  expect(saved2.inquiry_case_link_v1?.reviewed_customer_event_ref).toBe(p2.inquiry_case_link_v1?.reviewed_customer_event_ref);
  f.documentOf(f.svc.approveLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved2.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID()));
  const p3=await f.svc.prepareLinked(f.ctx,{...f.prepareInput(),request:{...quoteRequest,piece_count:2},expected_customer_event_ref:latest()});
  expect(p3.native_quote_v1?.request_hash).not.toBe(p1.native_quote_v1?.request_hash);
  const saved3=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p3),randomUUID()));
  expect(saved3.id).not.toBe(saved2.id);
  const approval={contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved3.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'};
  expect(f.documentOf(f.svc.approveLinked(f.ctx,approval,randomUUID()))).toMatchObject({id:saved3.id,state:'approved',version:2});
  expect(errorCode(()=>f.svc.approveLinked(f.ctx,{...approval,id:saved2.id},randomUUID()))).toBe('version_conflict');
  expect(f.counts()).toEqual({documents:2,audit:5,pdfs:0});
 });

 it('blocks personal, platform and cross-organization linked access without v1 changes (IQL-06)',async()=>{
  const f=linkedSetup(),p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  const personal:PortalContext={...f.ctx,organizationId:null},platform:PortalContext={...f.ctx,identity:{...f.ctx.identity,platformRole:'operator'},organizationId:null},cross:PortalContext={...f.ctx,organizationId:'other-org'};
  expect(errorCode(()=>f.svc.getLinked(personal,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id}))).toBe('inquiry_quote_document_scope_required');
  expect(errorCode(()=>f.svc.getLinked(platform,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id}))).toBe('inquiry_quote_document_scope_required');
  expect(errorCode(()=>f.svc.listLinked(personal,{contract_version:INQUIRY_QUOTE_LINK_VERSION,limit:5}))).toBe('inquiry_quote_document_scope_required');
  expect(errorCode(()=>f.svc.saveLinked(platform,f.saveInput(p),randomUUID()))).toBe('inquiry_quote_document_scope_required');
  expect(blockedReason('inquiry_quote_document_scope_required')).toBe(true);
  expect(errorCode(()=>f.svc.getLinked(cross,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id}))).toBe('document_not_found');
  expect(await errorCodeAsync(()=>f.svc.prepareLinked(cross,f.prepareInput()))).toBe('document_not_found');
  expect(blockedReason('document_not_found')).toBe(true);
  expect(errorCode(()=>f.svc.get(personal,{id:saved.id}))).toBe('document_organization_required');
  expect(f.counts()).toEqual({documents:1,audit:2,pdfs:0});
 });


 it('keeps linked writes behind document and case management for a non-owner membership',async()=>{
  const f=linkedSetup(),p=await f.svc.prepareLinked(f.ctx,f.prepareInput()),saved=f.documentOf(f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()));
  f.setRole('sales');
  const before=f.counts();
  expect(errorCode(()=>f.svc.approveLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,evidence_ref:'review:test',evidence_version:'1',review_notes:'核对',confirmation:'human_verified_price_and_source'},randomUUID()))).toBe('document_management_denied');
  expect(errorCode(()=>f.svc.rejectLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id,expected_version:1,reason:'not allowed'},randomUUID()))).toBe('document_management_denied');
  expect(errorCode(()=>f.svc.saveLinked(f.ctx,f.saveInput(p),randomUUID()))).toBe('document_not_found');
  expect(await errorCodeAsync(()=>f.svc.prepareLinked(f.ctx,f.prepareInput()))).toBe('document_not_found');
  expect(f.svc.getLinked(f.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:saved.id}).id).toBe(saved.id);
  expect(f.counts()).toEqual(before);
 });
 it('blocks linked work when the acting membership or organization changes during an await',async()=>{
  const native=linkedSetup();native.setNativeHook(()=>native.revokeMembership());
  expect(await errorCodeAsync(()=>native.svc.prepareLinked(native.ctx,native.prepareInput()))).toBe('document_not_found');
  expect(native.counts()).toEqual({documents:0,audit:1,pdfs:0});
  const inactive=linkedSetup();inactive.setNativeHook(()=>inactive.deactivateOrganization());
  expect(await errorCodeAsync(()=>inactive.svc.prepareLinked(inactive.ctx,inactive.prepareInput()))).toBe('document_not_found');
  expect(inactive.counts()).toEqual({documents:0,audit:1,pdfs:0});
  const render=linkedSetup(),doc=await approvedLinked(render);render.setRenderHook(()=>render.revokeMembership());
  expect(await errorCodeAsync(()=>render.svc.exportLinked(render.ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:doc.id,mode:'formal'}))).toBe('document_not_found');
  expect(render.counts()).toEqual({documents:1,audit:3,pdfs:0});
  expect(render.renderCount()).toBe(1);
 });
});

it('normalizes the precise inactive-membership permission error for linked paths only',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'quote-docs-membership-'));dirs.push(dir);const store=new DocumentStore(join(dir,'docs.sqlite'));stores.push(store);
 const ctx:PortalContext={identity:{userId:'owner',email:'owner@example.test',emailVerified:true,displayName:'Owner',platformRole:null},organizationId:'org'};
 let mode:'ok'|'throw-first'|'throw-second'|'unknown'='ok',calls=0;
 const active=()=>({data:{current_organization:{organizationId:'org',status:'active'},memberships:[{userId:'owner',organizationId:'org',status:'active',role:'owner'}]}});
 const portal={getState:()=>{calls+=1;if(mode==='throw-first')throw new PortalError('active_organization_membership_required');if(mode==='throw-second'&&calls===2)throw new PortalError('active_organization_membership_required');if(mode==='unknown')throw new Error('boom');return active();}} as unknown as Pick<PortalService,'getState'>;
 const svc=new DocumentService(store,portal);
 const linkedCalls:Array<[string,()=>unknown]>=[['native-prepare',()=>svc.prepareLinked(ctx,{})],['save',()=>svc.saveLinked(ctx,{},randomUUID())],['list',()=>svc.listLinked(ctx,{})],['get',()=>svc.getLinked(ctx,{})],['approve',()=>svc.approveLinked(ctx,{},randomUUID())],['reject',()=>svc.rejectLinked(ctx,{},randomUUID())],['export',()=>svc.exportLinked(ctx,{})]];
 mode='throw-first';
 expect(errorCode(()=>svc.get(ctx,{id:randomUUID()}))).toBe('active_organization_membership_required');
 for(const [name,call] of linkedCalls){
  let captured:unknown;try{await call();}catch(error){captured=error;}
  expect(captured,name).toBeInstanceOf(PortalError);expect((captured as PortalError).code,name).toBe('document_not_found');
 }
 mode='throw-second';calls=0;
 expect(errorCode(()=>svc.getLinked(ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:randomUUID()}))).toBe('document_not_found');expect(calls).toBe(2);
 mode='unknown';
 expect(()=>svc.getLinked(ctx,{id:randomUUID()})).toThrow('boom');
});
