import {afterEach,describe,expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmodSync,linkSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DocumentStore,DocumentService} from '../../services/quote-documents/service';
import {closePortalProductionDatabase,openPortalProductionDatabase} from '../../services/access-gateway/portal/production-persistence';
import {DocumentWorkflowStore,DocumentWorkflowService,assertNoExternalSqliteHandles,nativeFeeDigest} from '../../services/quote-documents/workflow';
import {DRAFT_VERSION,WORKFLOW_REQUEST_VERSION,workflowDocumentViewSchema,type DraftDocument,type DraftFee} from '../../services/quote-documents/workflow-contracts';
import {createNativeQuoteClient,type QuoteRelease} from '../../services/quote-native/client';
import type {PortalBusinessService} from '../../services/access-gateway/portal/business/service';
import {config as rates,request as quoteRequest} from '../quote-native/fixture';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';
import type {PortalService} from '../../services/access-gateway/portal/service';
import {template} from './fixtures';

const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));

function setup(role:'owner'|'admin'|'sales'='owner',native?:ConstructorParameters<typeof DocumentService>[3]){
  const dir=mkdtempSync(join(tmpdir(),'quote-workflow-test-'));
  dirs.push(dir);
  const legacyStore=new DocumentStore(join(dir,'documents.sqlite'));
  const revoked=new Set<string>();
  const portal={getState:(ctx:PortalContext)=>({data:{current_organization:{organizationId:ctx.organizationId,status:'active'},memberships:ctx.organizationId==='org'&&!revoked.has(ctx.identity.userId)?[{userId:ctx.identity.userId,organizationId:'org',status:'active',role:ctx.identity.userId==='owner'?'owner':role}]:[]}})} as unknown as Pick<PortalService,'getState'>;
  const caseRef=randomUUID();let latestRef:string|null=null,mutableCaseStatus:'submitted'|'in_review'|'needs_input'|'closed'|'cancelled'='in_review',caseDenied=false;
  const caseAccess={
    readForQuoteView:()=>{if(caseDenied)throw new Error('case_not_found');return {case_ref:caseRef,owner_id:'owner',organization_id:'org',status:mutableCaseStatus,version:1,latest_customer_supplement_ref:latestRef};},
    readForQuoteLink:()=>{if(caseDenied)throw new Error('case_not_found');return {case_ref:caseRef,owner_id:'owner',organization_id:'org',status:mutableCaseStatus,version:1,latest_customer_supplement_ref:latestRef};},
  };
  const legacyService=new DocumentService(legacyStore,portal,undefined,native,caseAccess);
  const store=new DocumentWorkflowStore(legacyStore,{oldWritersStopped:true,ownershipMode:'fresh-fixture'});
  let renders=0;
  const service=new DocumentWorkflowService(store,legacyService,portal,()=>{renders++;return Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120)));});
  const ctx:PortalContext={identity:{userId:'owner',email:'owner@example.test',emailVerified:true,displayName:'Owner',platformRole:null},organizationId:'org'};
  service.saveConfig(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,expected_version:0,input:{...template,standard_fee_template_v1:{template_id:'freightclaw-standard-v1',template_version:1,items:[]}},confirmed:true},'workflow-config-0001');
  return {dir,legacyStore,store,service,legacyService,portal,ctx,caseRef,ctxFor:(userId:string,organizationId='org'):PortalContext=>({identity:{userId,email:userId+'@example.test',emailVerified:true,displayName:userId,platformRole:null},organizationId}),revoke:(userId:string)=>{revoked.add(userId);},setCaseLatest:(value:string|null)=>{latestRef=value;},setCaseStatus:(value:typeof mutableCaseStatus)=>{mutableCaseStatus=value;},denyCase:()=>{caseDenied=true;},allowCase:()=>{caseDenied=false;},renders:()=>renders};
}

function nativeSetup(){
  let release:QuoteRelease|null={version:1,release_id:'release_workflow',digest:'a'.repeat(64),input:rates,published_at:new Date().toISOString()};
  const client=createNativeQuoteClient(()=>release);
  const business={execute:async(_ctx:PortalContext,_tool:string,input:unknown,requestId:string)=>client.preview({input,requestId,actor:{type:'user',id:'owner'}})} as unknown as Pick<PortalBusinessService,'execute'>;
  const fixture=setup('owner',{business,current:()=>release});
  const customer={quote_no:'QA-NATIVE-001',customer_name:'Synthetic native',quote_date:new Date().toISOString().slice(0,10),valid_until:rates.valid_until,job_no:'',so_no:'',container_no:'',remark:''};
  return {...fixture,customer,prepare:()=>fixture.service.prepareNative(fixture.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,document_kind:'native_unlinked',request:quoteRequest,customer}),disable:()=>{release=null;},changeReleaseDigest:()=>{if(release)release={...release,digest:'f'.repeat(64)};},expireRelease:()=>{if(release)release={...release,input:{...release.input,valid_until:'2026-09-01'}};}};
}

function setupLegacy(options:{version:number;state:'draft'|'rejected'}){
  const fixture=setup(),id=randomUUID(),input=completeDraft(),payload={id,version:options.version,state:options.state,input,template,template_version:1,created_at:'2026-09-15T00:00:00.000Z',owner_id:'owner',approval:null,...(options.state==='rejected'?{rejection:{reason:'legacy rejection',actor:'owner',at:'2026-09-15T00:00:00.000Z'}}:{})};
  fixture.legacyStore.db.prepare('INSERT INTO quote_documents VALUES(?,?,?,?)').run(id,'org','owner',JSON.stringify(payload));
  return {...fixture,id};
}

  it('reopens a claimed v3 database with the current document store',()=>{
  const {dir,legacyStore}=setup();
  const first=new DocumentWorkflowStore(legacyStore,{oldWritersStopped:true,ownershipMode:'fresh-fixture'});
  first.close();
  legacyStore.close();
  const reopened=new DocumentStore(join(dir,'documents.sqlite'));
  expect((reopened.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(3);
  expect(reopened.health()).toBe(true);
  const workflow=new DocumentWorkflowStore(reopened,{oldWritersStopped:true,ownershipMode:'fresh-fixture'});
  expect((workflow.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(3);
  workflow.close();
    reopened.close();
  });

  it('keeps an unmodified version-2 opener from using an upgraded database',()=>{
    const f=setup();
    expect(()=>openPortalProductionDatabase(join(f.dir,'documents.sqlite'),'freightclaw-quote-documents',2)).toThrow('portal_database_version_unsupported');
  });

  it.skipIf(process.platform!=='linux'||process.getuid?.()===0)('fails closed when an existing process file descriptor table cannot be inspected',()=>{
    const dir=mkdtempSync(join(tmpdir(),'workflow-upgrade-proc-'));dirs.push(dir);
    const database=join(dir,'documents.sqlite'),procRoot=join(dir,'proc'),fdDir=join(procRoot,'42','fd');
    writeFileSync(database,'sqlite');
    mkdirSync(fdDir,{recursive:true});
    chmodSync(fdDir,0o000);
    try{
      expect(()=>assertNoExternalSqliteHandles(database,{procRoot,currentPid:1})).toThrow('document_v3_upgrade_ownership_unverified');
    }finally{
      chmodSync(fdDir,0o700);
    }
  });

  it('rejects fresh-fixture ownership mode when legacy data already exists',()=>{
    const dir=mkdtempSync(join(tmpdir(),'workflow-fresh-fixture-'));dirs.push(dir);
    const store=new DocumentStore(join(dir,'documents.sqlite'));
    store.db.prepare('INSERT INTO quote_documents VALUES(?,?,?,?)').run(randomUUID(),'org','owner','{}');
    const workflow=new DocumentWorkflowStore(store,{oldWritersStopped:true,ownershipMode:'fresh-fixture'});
    expect(()=>workflow.ensureWritable()).toThrow('document_v3_upgrade_ownership_unverified');
    store.close();
  });

const blankDraft=()=>({schema_version:'quote-document-draft@2026-09-15.v1' as const,quote_no:null,customer_name:null,quote_date:null,valid_until:null,origin:null,destination:null,route_name:null,job_no:null,so_no:null,container_no:null,remark:null,exchange_rates:{USD:null,CAD:null},fee_items:[]});
const completeDraft=()=>({...blankDraft(),quote_no:'Q-1',customer_name:'Synthetic',quote_date:'2026-09-15',valid_until:'2099-12-31',fee_items:[{id:randomUUID(),source_kind:'manual' as const,template_ref:null,name:'Base freight',description:null,group:'B' as const,quantity:'1',unit:'shipment',unit_price:'10',currency:'USD' as const,display:'detail' as const,merge_name:null,note:null}]});

describe('quote workflow v3',()=>{
  it('saves nullable drafts, updates the same id and reviews completeness separately',()=>{
    const f=setup();
    const created=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:blankDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-create-0001');
    expect(created).toMatchObject({state:'draft',version:1,completeness:{complete:false},claim_state:'claimed_v3'});
    const incomplete=f.service.review(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:created.id,expected_version:1});
    expect(incomplete).toMatchObject({status:'needs_input',completeness:{complete:false}});
    const updated=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'manual',id:created.id,expected_version:1,input:completeDraft(),template_selection:{mode:'retain'},save_intent:'save_draft'},'workflow-update-0001');
    expect(updated).toMatchObject({id:created.id,version:2,completeness:{complete:true}});
    const review=f.service.review(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:created.id,expected_version:2});
    if(review.status!=='success')throw new Error('complete review unexpectedly requires input');
    expect(review).toMatchObject({status:'success',reviewed_version:2});
    expect(review.review_hash).toHaveLength(64);
  });

  it('preserves the actual legacy version and does not claim during get',()=>{
    const f=setup();
    const id=randomUUID();
    const legacyInput={quote_no:'LEGACY',customer_name:'Legacy',quote_date:'2026-09-15',valid_until:'2099-12-31',origin:'',destination:'',route_name:'',job_no:'',so_no:'',container_no:'',remark:'',exchange_rates:{USD:null,CAD:null},fee_items:[{id:randomUUID(),name:'Freight',description:'',group:'B',quantity:'1',unit:'shipment',unit_price:'10',currency:'USD',display:'detail',merge_name:'',note:''}]};
    const payload={id,version:4,state:'approved',input:legacyInput,template,template_version:1,created_at:'2026-09-15T00:00:00.000Z',owner_id:'owner',approval:{evidence_ref:'legacy',evidence_version:'1',review_notes:'legacy',actor:'owner',at:'2026-09-15T00:00:00.000Z'}};
    f.legacyStore.db.prepare('INSERT INTO quote_documents VALUES(?,?,?,?)').run(id,'org','owner',JSON.stringify(payload));
    const pdf=Buffer.from('%PDF-1.7\n'+'.'.repeat(120));
    f.legacyStore.db.prepare('INSERT INTO document_pdfs VALUES(?,?,?,?)').run(id,4,createHash('sha256').update(pdf).digest('hex'),pdf);
    const read=f.service.get(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id});
    expect(read).toMatchObject({version:4,claim_state:'legacy_unclaimed',revision_id:null,state:'approved'});
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()).toEqual({n:0});
    expect(f.legacyStore.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs WHERE id=?').get(id)).toEqual({n:1});
  });

  it('classifies legacy linked rows before native_unlinked and requires a fresh signed binding before v3 edits',()=>{
    const f=setup();
    const id=randomUUID(),fee={id:randomUUID(),source_kind:'native' as const,template_ref:null,name:'Freight',description:null,group:'B' as const,quantity:'1',unit:'shipment',unit_price:'10',currency:'USD' as const,display:'detail' as const,merge_name:null,note:null};
    const input={schema_version:DRAFT_VERSION,quote_no:'LEGACY-LINK',customer_name:'Legacy',quote_date:'2026-09-15',valid_until:'2099-12-31',origin:null,destination:null,route_name:null,job_no:null,so_no:null,container_no:null,remark:null,exchange_rates:{USD:null,CAD:null},fee_items:[fee]};
    const nativeQuote={schema_version:'native-quote-binding@2026-09-15.v1',request:{},preview:{},source_refs:[],source_refs_digest:'a'.repeat(64),release_id:'release',release_digest:'b'.repeat(64),request_hash:'c'.repeat(64),document_fee_digest:nativeFeeDigest([fee]),document_fee_digest_format:'canonical-json-sha256-v1',binding_hash:'d'.repeat(64),provenance:'legacy_v1_v2'};
    const payload={id,version:4,state:'draft',input,template,template_version:1,created_at:'2026-09-15T00:00:00.000Z',owner_id:'owner',approval:null,native_quote_v1:nativeQuote,inquiry_case_link_v1:{case_ref:f.caseRef,reviewed_customer_event_ref:null}};
    f.legacyStore.db.prepare('INSERT INTO quote_documents VALUES(?,?,?,?)').run(id,'org','owner',JSON.stringify(payload));
    expect(f.service.get(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id})).toMatchObject({document_kind:'linked',claim_state:'legacy_unclaimed'});
    f.denyCase();
    expect(()=>f.service.get(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id})).toThrow('document_not_found');
    f.allowCase();
    expect(()=>f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'linked',id,expected_version:4,input,template_selection:{mode:'retain'},binding_update:{mode:'retain'},save_intent:'save_draft'},'workflow-linked-0001')).toThrow('native_quote_rebind_required');
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()).toEqual({n:0});
  });

  it('requires owner/admin approval and records reviewed n to approved n+1',()=>{
    const owner=setup('owner');
    const draft=owner.service.save(owner.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:completeDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-approve-0001');
    const review=owner.service.review(owner.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,expected_version:draft.version});
    if(review.status!=='success')throw new Error('review unexpectedly requires input');
    const approved=owner.service.approve(owner.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,expected_version:1,review_hash:review.review_hash,evidence_ref:'qa',evidence_version:'1',review_notes:'reviewed',confirmation:'human_verified_price_and_source'},'workflow-approve-0002');
    expect(approved).toMatchObject({state:'approved',version:2});
    expect(approved.approval).toMatchObject({source_version:1,approved_version:2});
    const sales=setup('sales'),salesCtx=sales.ctxFor('sales-user');
    const salesDraft=sales.service.save(salesCtx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:completeDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-approve-0003');
    const salesReview=sales.service.review(salesCtx,{contract_version:WORKFLOW_REQUEST_VERSION,id:salesDraft.id,expected_version:1});
    if(salesReview.status!=='success')throw new Error('sales review unexpectedly requires input');
    expect(()=>sales.service.approve(salesCtx,{contract_version:WORKFLOW_REQUEST_VERSION,id:salesDraft.id,expected_version:1,review_hash:salesReview.review_hash,evidence_ref:'qa',evidence_version:'1',review_notes:'reviewed',confirmation:'human_verified_price_and_source'},'workflow-approve-0004')).toThrow('document_management_denied');
  });

  it('returns a historical idempotency replay instead of the concurrent current version',()=>{
    const f=setup();
    const first={contract_version:WORKFLOW_REQUEST_VERSION,operation:'create' as const,document_kind:'manual' as const,input:blankDraft(),template_selection:{mode:'current' as const},save_intent:'save_draft' as const};
    const created=f.service.save(f.ctx,first,'workflow-replay-0001');
    f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'manual',id:created.id,expected_version:1,input:completeDraft(),template_selection:{mode:'retain'},save_intent:'save_draft'},'workflow-replay-0002');
    const replay=f.service.save(f.ctx,first,'workflow-replay-0001');
    expect(replay).toMatchObject({replay:true,committed:true,current:false,version:1,current_version:2});
  });

  it('detects native row additions and hidden-excluded evasion',()=>{
    const native={id:'n',source_kind:'native' as const,template_ref:null,name:'Freight',description:null,group:'B' as const,quantity:'1',unit:'shipment',unit_price:'10',currency:'USD' as const,display:'detail' as const,merge_name:null,note:null};
    expect(nativeFeeDigest([native])).toBe(nativeFeeDigest([native]));
    expect(nativeFeeDigest([native,{...native,id:'m',source_kind:'manual'}])).not.toBe(nativeFeeDigest([native]));
    expect(nativeFeeDigest([{...native,display:'hiddenExcluded'}])).not.toBe(nativeFeeDigest([native]));
  });

  it('does not render an incomplete draft export',async()=>{
    const f=setup();
    const draft=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:blankDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-export-0001');
    await expect(f.service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,mode:'draft',expected_version:1})).rejects.toThrow('document_incomplete');
    expect(f.renders()).toBe(0);
  });

  it('accepts only the exact server-signed native row set',async()=>{
    const f=nativeSetup(),prepared=await f.prepare();
    const create={contract_version:WORKFLOW_REQUEST_VERSION,operation:'create' as const,document_kind:'native_unlinked' as const,input:prepared.input,template_selection:{mode:'current' as const},native_quote_v1:prepared.native_quote_v1,inquiry_case_link_v1:undefined,preview_hash:prepared.preview_hash,preview_expires_at:prepared.preview_expires_at,save_intent:'save_draft' as const};
    const extra={...prepared.input.fee_items[0]!,id:randomUUID(),source_kind:'manual' as const};
    expect(()=>f.service.save(f.ctx,{...create,input:{...prepared.input,fee_items:[...prepared.input.fee_items,extra]}},'workflow-native-forgery-01')).toThrow('native_quote_rebind_required');
    expect(()=>f.service.save(f.ctx,{...create,native_quote_v1:{...prepared.native_quote_v1,binding_hash:'b'.repeat(64)}},'workflow-native-forgery-02')).toThrow('inquiry_quote_link_forgery');
    const saved=f.service.save(f.ctx,create,'workflow-native-valid-01');
    expect(saved).toMatchObject({state:'draft',document_kind:'native_unlinked',version:1});
  });

  it('keeps reviewed content, approval evidence, formal exports and historical receipts consistent',async()=>{
    const f=nativeSetup(),prepared=await f.prepare();
    const saved=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'native_unlinked',input:prepared.input,template_selection:{mode:'current'},native_quote_v1:prepared.native_quote_v1,preview_hash:prepared.preview_hash,preview_expires_at:prepared.preview_expires_at,save_intent:'save_draft'},'workflow-native-approve-01');
    const draftPdf=await f.service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,mode:'draft',expected_version:1});
    expect(draftPdf).toMatchObject({mode:'draft',historical:false,version:1});
    const review=f.service.review(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:1});
    if(review.status!=='success')throw new Error('native review unexpectedly requires input');
    const approved=f.service.approve(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:1,review_hash:review.review_hash,evidence_ref:'review:native',evidence_version:'1',review_notes:'核验',confirmation:'human_verified_price_and_source'},'workflow-native-approve-02');
    expect(approved).toMatchObject({state:'approved',version:2});
    expect(approved.approval).toMatchObject({source_version:1,approved_version:2,source_revision_id:saved.revision_id,approved_revision_id:approved.revision_id});
    const formal=await f.service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,mode:'formal',expected_version:2});
    expect(formal).toMatchObject({mode:'formal',historical:false,version:2});
    await expect(f.service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,mode:'history',target_version:2,expected_current_version:2})).rejects.toThrow('document_export_mode_invalid');
    const historical=await f.service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,mode:'history',target_version:1,expected_current_version:2});
    expect(historical).toMatchObject({mode:'history',historical:true,valid_now:false,version:1});
    f.expireRelease();
    const expiredCurrent=await f.service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,mode:'history',target_version:2,expected_current_version:2});
    expect(expiredCurrent).toMatchObject({mode:'history',historical:true,valid_now:false,version:2});
    await expect(f.service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,mode:'formal',expected_version:2})).rejects.toThrow('native_quote_source_changed');
  });

  it('imports the actual legacy version before the first v3 approve or edit',()=>{
    const approved=setupLegacy({version:4,state:'draft'});
    const review=approved.service.review(approved.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:approved.id,expected_version:4});
    if(review.status!=='success')throw new Error('legacy review unexpectedly requires input');
    const value=approved.service.approve(approved.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:approved.id,expected_version:4,review_hash:review.review_hash,evidence_ref:'review:legacy',evidence_version:'1',review_notes:'核验',confirmation:'human_verified_price_and_source'},'workflow-legacy-approve-01');
    expect(value).toMatchObject({version:5,state:'approved',claim_state:'claimed_v3'});
    expect(approved.store.db.prepare('SELECT version FROM document_revisions ORDER BY version').all()).toEqual([{version:4},{version:5}]);

    const edited=setupLegacy({version:5,state:'rejected'});
    const value2=edited.service.save(edited.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'manual',id:edited.id,expected_version:5,input:{...completeDraft(),quote_no:'LEGACY-EDITED'},template_selection:{mode:'retain'},save_intent:'save_draft'},'workflow-legacy-edit-01');
    expect(value2).toMatchObject({version:6,state:'draft',claim_state:'claimed_v3'});
    const rejected=edited.store.db.prepare('SELECT payload FROM document_revisions WHERE version=5').get() as {payload:string};
    expect(JSON.parse(rejected.payload)).toMatchObject({state:'rejected',rejection:{reason:'legacy rejection'}});
  });

  it('filters before pagination and rejects a cursor reused with different filters',()=>{
    const f=setup();
    for(const quoteNo of ['Q-1','Q-2','Q-3'])f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:{...completeDraft(),quote_no:quoteNo},template_selection:{mode:'current'},save_intent:'save_draft'},`workflow-list-${quoteNo}-0001`);
    const first=f.service.list(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,limit:1,cursor:null,filters:{state:'all',quote_no:null,customer_name:null}});
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second=f.service.list(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,limit:10,cursor:first.next_cursor,filters:{state:'all',quote_no:null,customer_name:null}});
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items,...second.items].map(item=>item.id)).size).toBe(3);
    expect(()=>f.service.list(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,limit:10,cursor:first.next_cursor,filters:{state:'draft',quote_no:'Q-1',customer_name:null}})).toThrow('document_input_invalid');
  });

  it('preserves missing amounts, preserves explicit zero and preflights the 61-row limit',()=>{
    const f=setup(),missing={...completeDraft(),fee_items:[{...completeDraft().fee_items[0]!,unit_price:null}]};
    const saved=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:missing,template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-null-price-01');
    expect(f.service.get(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id}).input.fee_items[0]!.unit_price).toBeNull();
    const zero=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'manual',id:saved.id,expected_version:1,input:{...missing,fee_items:[{...missing.fee_items[0]!,unit_price:'0'}]},template_selection:{mode:'retain'},save_intent:'save_draft'},'workflow-zero-price-01');
    expect(zero.input.fee_items[0]!.unit_price).toBe('0');
    expect(zero.completeness.complete).toBe(true);
    const tooMany=Array.from({length:61},()=>({...completeDraft().fee_items[0]!,id:randomUUID()}));
    const before=(f.store.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get() as {n:number}).n;
    expect(()=>f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:{...completeDraft(),fee_items:tooMany},template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-limit-0001')).toThrow('document_input_invalid');
    expect((f.store.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get() as {n:number}).n).toBe(before);
  });

  it('rejects a stale concurrent render and corrupt cached PDF bytes',async()=>{
    const f=setup(),saved=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:completeDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-render-0001');
    const racing=new DocumentWorkflowService(f.store,f.legacyService,f.portal,()=>{
      f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'manual',id:saved.id,expected_version:1,input:{...completeDraft(),quote_no:'RACED'},template_selection:{mode:'retain'},save_intent:'save_draft'},'workflow-render-0002');
      return Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120)));
    });
    await expect(racing.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,mode:'draft',expected_version:1})).rejects.toThrow('version_conflict');
    const stable=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:completeDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-pdf-0001');
    await f.service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:stable.id,mode:'draft',expected_version:1});
    f.store.db.prepare('UPDATE document_pdfs SET bytes=? WHERE id=? AND version=1').run(Buffer.from('broken'),stable.id);
    await expect(f.service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:stable.id,mode:'draft',expected_version:1})).rejects.toThrow('document_pdf_invalid');
  });

  it('enforces current membership, cross-tenant isolation, expected_version and idempotency digests',()=>{
    const f=setup(),input={contract_version:WORKFLOW_REQUEST_VERSION,operation:'create' as const,document_kind:'manual' as const,input:completeDraft(),template_selection:{mode:'current' as const},save_intent:'save_draft' as const};
    const saved=f.service.save(f.ctx,input,'workflow-permission-0001');
    expect(()=>f.service.get(f.ctxFor('sales-user','other-org'),{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id})).toThrow('document_not_found');
    expect(()=>f.service.save(f.ctx,{...input,input:{...input.input,quote_no:'DIFFERENT'}},'workflow-permission-0001')).toThrow('idempotency_conflict');
    const updated=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'manual',id:saved.id,expected_version:1,input:{...completeDraft(),quote_no:'UPDATED'},template_selection:{mode:'retain'},save_intent:'save_draft'},'workflow-permission-0002');
    expect(updated.version).toBe(2);
    expect(()=>f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'manual',id:saved.id,expected_version:1,input:{...completeDraft(),quote_no:'STALE'},template_selection:{mode:'retain'},save_intent:'save_draft'},'workflow-permission-0003')).toThrow('version_conflict');
    const review=f.service.review(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:2});
    if(review.status!=='success')throw new Error('review unexpectedly requires input');
    f.revoke('owner');
    expect(()=>f.service.approve(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:2,review_hash:review.review_hash,evidence_ref:'review:revoked',evidence_version:'1',review_notes:'核验',confirmation:'human_verified_price_and_source'},'workflow-permission-0004')).toThrow('document_not_found');
  });

  it('uses one decimal engine rule for pure CNY, mixed currencies, missing rates, hidden rows and precision',()=>{
    const f=setup(),base:DraftDocument=completeDraft();
    const fee=(currency:'USD'|'CAD'|'CNY',quantity:string,unitPrice:string,display:'detail'|'hiddenIncluded'|'hiddenExcluded'='detail'):DraftFee=>({...base.fee_items[0]!,id:randomUUID(),currency,quantity,unit_price:unitPrice,display});
    const totals=(input:DraftDocument)=>f.service.preview(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,input}).totals;
    expect(totals({...base,fee_items:[fee('CNY','1','10')]})).toMatchObject({by_currency:{CNY:'10.00'},total_cny:'10.00'});
    expect(totals({...base,exchange_rates:{USD:'7',CAD:'5'},fee_items:[fee('USD','1','10'),fee('CAD','1','10'),fee('CNY','1','10')]})).toMatchObject({by_currency:{USD:'10.00',CAD:'10.00',CNY:'10.00'},total_cny:'130.00',total_usd:'18.57'});
    expect(totals({...base,exchange_rates:{USD:null,CAD:'5'},fee_items:[fee('USD','1','10'),fee('CAD','1','10'),fee('CNY','1','10')]})).toMatchObject({total_cny:null,total_usd:null});
    expect(totals({...base,exchange_rates:{USD:'7',CAD:null},fee_items:[fee('USD','1','10'),fee('USD','1','5','hiddenIncluded'),fee('USD','1','999','hiddenExcluded')]})).toMatchObject({by_currency:{USD:'15.00'},total_cny:'105.00'});
    expect(totals({...base,fee_items:[fee('CNY','0.1','0.2')]})).toMatchObject({by_currency:{CNY:'0.02'},total_cny:'0.02'});
  });

  it('verifies server-signed native bindings against immutable document owner for authorized managers',async()=>{
    const f=nativeSetup(),prepared=await f.prepare();
    const saved=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'native_unlinked',input:prepared.input,template_selection:{mode:'current'},native_quote_v1:prepared.native_quote_v1,preview_hash:prepared.preview_hash,preview_expires_at:prepared.preview_expires_at,save_intent:'save_draft'},'workflow-owner-signature-01');
    const admin=f.ctxFor('admin-user');
    expect(f.service.get(admin,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id}).owner_id).toBe('owner');
    expect(f.service.list(admin,{contract_version:WORKFLOW_REQUEST_VERSION,limit:10,cursor:null,filters:{state:'all',quote_no:null,customer_name:null}}).items.some(item=>item.id===saved.id)).toBe(true);
    const review=f.service.review(admin,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:1});
    if(review.status!=='success')throw new Error('manager review unexpectedly requires input');
    const updated=f.service.save(admin,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'native_unlinked',id:saved.id,expected_version:1,input:{...prepared.input,quote_no:'ADMIN-RETAIN'},template_selection:{mode:'retain'},binding_update:{mode:'retain'},save_intent:'save_draft'},'workflow-owner-signature-02');
    expect(updated).toMatchObject({id:saved.id,owner_id:'owner',version:2});
    const managerReview=f.service.review(admin,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:2});
    if(managerReview.status!=='success')throw new Error('manager review unexpectedly requires input');
    const approved=f.service.approve(admin,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:2,review_hash:managerReview.review_hash,evidence_ref:'review:manager',evidence_version:'1',review_notes:'核验',confirmation:'human_verified_price_and_source'},'workflow-owner-signature-03');
    expect(approved).toMatchObject({owner_id:'owner',state:'approved'});
    await expect(f.service.export(admin,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,mode:'formal',expected_version:approved.version})).resolves.toMatchObject({id:saved.id,mode:'formal'});
  });

  it('preserves a legacy v1/v2 native binding without fabricating v3 proof',async()=>{
    const f=nativeSetup(),prepared=await f.legacyService.prepareNative(f.ctx,{request:quoteRequest,customer:f.customer});
    const saved=f.legacyService.save(f.ctx,{...prepared,confirmed:true},'workflow-legacy-native-01');
    const view=f.service.get(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id});
    expect(workflowDocumentViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({claim_state:'legacy_unclaimed',document_kind:'native_unlinked'});
    expect(view.native_quote_v1).not.toHaveProperty('schema_version');
    expect(view.native_quote_v1).not.toHaveProperty('provenance');
  });

  it('rechecks source and permission on exact idempotency replay',async()=>{
    const f=nativeSetup(),prepared=await f.prepare(),saveInput={contract_version:WORKFLOW_REQUEST_VERSION,operation:'create' as const,document_kind:'native_unlinked' as const,input:prepared.input,template_selection:{mode:'current' as const},native_quote_v1:prepared.native_quote_v1,preview_hash:prepared.preview_hash,preview_expires_at:prepared.preview_expires_at,save_intent:'save_draft' as const};
    const saved=f.service.save(f.ctx,saveInput,'workflow-replay-source-01');
    const review=f.service.review(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:1});
    if(review.status!=='success')throw new Error('native review unexpectedly requires input');
    const approval={contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:1,review_hash:review.review_hash,evidence_ref:'review:replay',evidence_version:'1',review_notes:'核验',confirmation:'human_verified_price_and_source' as const};
    f.service.approve(f.ctx,approval,'workflow-replay-approve-01');
    f.disable();
    expect(f.service.save(f.ctx,saveInput,'workflow-replay-source-01')).toMatchObject({replay:true,current:false,historical:true,valid_now:false,version:1,current_version:2});
    expect(f.service.approve(f.ctx,approval,'workflow-replay-approve-01')).toMatchObject({replay:true,current:false,historical:true,valid_now:false,version:2});
    const revoked=setup(),draft=revoked.service.save(revoked.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:completeDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-replay-reject-01');
    const reject={contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,expected_version:1,reason:'reject for replay'};
    revoked.service.reject(revoked.ctx,reject,'workflow-replay-reject-02');
    revoked.revoke('owner');
    expect(()=>revoked.service.reject(revoked.ctx,reject,'workflow-replay-reject-02')).toThrow('document_not_found');
  });

  it('does not upgrade on read and requires explicit ownership plus guarded read-only rollback',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workflow-upgrade-owner-'));dirs.push(dir);
    const documentStore=new DocumentStore(join(dir,'documents.sqlite')),portal={getState:(ctx:PortalContext)=>({data:{current_organization:{organizationId:ctx.organizationId,status:'active'},memberships:[{userId:ctx.identity.userId,organizationId:'org',status:'active',role:'owner'}]}})} as unknown as Pick<PortalService,'getState'>;
    const legacyService=new DocumentService(documentStore,portal),store=new DocumentWorkflowStore(documentStore),service=new DocumentWorkflowService(store,legacyService,portal);
    const ctx:PortalContext={identity:{userId:'owner',email:'owner@example.test',emailVerified:true,displayName:'Owner',platformRole:null},organizationId:'org'},id=randomUUID();
    documentStore.db.prepare('INSERT INTO quote_documents VALUES(?,?,?,?)').run(id,'org','owner',JSON.stringify({id,version:3,state:'draft',input:completeDraft(),template,template_version:1,created_at:'2026-09-15T00:00:00.000Z',owner_id:'owner',approval:null}));
    const legacyPdf=Buffer.from('%PDF-1.7\n'+'.'.repeat(120));
    documentStore.db.prepare('INSERT INTO document_pdfs VALUES(?,?,?,?)').run(id,2,createHash('sha256').update(legacyPdf).digest('hex'),legacyPdf);
    expect((documentStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(2);
    expect(service.get(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id}).claim_state).toBe('legacy_unclaimed');
    expect(service.list(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,limit:10,cursor:null,filters:{state:'all',quote_no:null,customer_name:null}}).items).toHaveLength(1);
    expect((documentStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(2);
    const config={contract_version:WORKFLOW_REQUEST_VERSION,expected_version:0,input:{...template,standard_fee_template_v1:{template_id:'freightclaw-standard-v1',template_version:1,items:[]}},confirmed:true} as const;
    expect(()=>service.saveConfig(ctx,config,'workflow-upgrade-owner-01')).toThrow('document_v3_upgrade_ownership_required');
    expect((documentStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(2);
    const legacyWriter=new DocumentStore(join(dir,'documents.sqlite'));
    const blocked=new DocumentWorkflowService(new DocumentWorkflowStore(documentStore,{oldWritersStopped:true}),legacyService,portal);
    expect(()=>blocked.saveConfig(ctx,config,'workflow-upgrade-owner-02')).toThrow('document_v3_upgrade_old_writer_open');
    legacyWriter.close();
    const authorized=new DocumentWorkflowService(new DocumentWorkflowStore(documentStore,{oldWritersStopped:true,externalHandleProbe:()=>{}}),legacyService,portal,()=>Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120))));
    authorized.saveConfig(ctx,config,'workflow-upgrade-owner-03');
    const claimed=authorized.save(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:completeDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-upgrade-owner-04');
    await authorized.export(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:claimed.id,mode:'draft',expected_version:1});
    const claimedUpdated=authorized.save(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'manual',id:claimed.id,expected_version:1,input:{...completeDraft(),quote_no:'CLAIMED-HISTORY'},template_selection:{mode:'retain'},save_intent:'save_draft'},'workflow-upgrade-owner-05');
    expect((documentStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(3);
    documentStore.close();
    const reopened=new DocumentStore(join(dir,'documents.sqlite')),readOnly=new DocumentWorkflowService(DocumentWorkflowStore.openReadOnly(reopened),new DocumentService(reopened,portal),portal);
    expect(readOnly.get(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:claimed.id})).toMatchObject({id:claimed.id,version:claimedUpdated.version,claim_state:'claimed_v3'});
    expect(await readOnly.export(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:claimed.id,mode:'history',target_version:1,expected_current_version:2})).toMatchObject({historical:true,version:1});
    expect(await readOnly.export(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id,mode:'history',target_version:2,expected_current_version:3})).toMatchObject({historical:true,version:2});
    expect(()=>readOnly.saveConfig(ctx,{...config,expected_version:1},'workflow-upgrade-owner-06')).toThrow('document_v3_rollback_read_only');
    reopened.close();
  });

  it.skipIf(process.platform!=='linux')('fails the upgrade while a separate legacy process still holds the database',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workflow-upgrade-process-'));dirs.push(dir);
    const path=join(dir,'documents.sqlite'),alias=join(dir,'documents-link.sqlite'),documentStore=new DocumentStore(path),portal={getState:(ctx:PortalContext)=>({data:{current_organization:{organizationId:ctx.organizationId,status:'active'},memberships:[{userId:ctx.identity.userId,organizationId:'org',status:'active',role:'owner'}]}})} as unknown as Pick<PortalService,'getState'>,legacyService=new DocumentService(documentStore,portal),ctx:PortalContext={identity:{userId:'owner',email:'owner@example.test',emailVerified:true,displayName:'Owner',platformRole:null},organizationId:'org'};
    linkSync(path,alias);
    const child=spawn(process.execPath,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL;');console.log('ready');setInterval(()=>{},1000);",alias],{stdio:['ignore','pipe','inherit']});
    const childPid=child.pid;
    if(childPid===undefined)throw new Error('legacy writer did not start');
    try{
      await new Promise<void>((resolve,reject)=>{let output='';child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('ready'))resolve();});child.once('error',reject);child.once('exit',code=>{if(!output.includes('ready'))reject(new Error(`legacy writer exited ${code}`));});});
      const service=new DocumentWorkflowService(new DocumentWorkflowStore(documentStore,{oldWritersStopped:true,externalHandleProbe:path=>assertNoExternalSqliteHandles(path,{onlyPids:new Set([childPid])})}),legacyService,portal);
      expect(()=>service.saveConfig(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,expected_version:0,input:{...template,standard_fee_template_v1:{template_id:'freightclaw-standard-v1',template_version:1,items:[]}},confirmed:true},'workflow-upgrade-process-01')).toThrow('document_v3_upgrade_old_writer_open');
      expect((documentStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(2);
    }finally{
      child.kill('SIGTERM');
      await once(child,'close');
      documentStore.close();
    }
  });

  it('fails the upgrade while a same-process native connection still holds the database',()=>{
    const dir=mkdtempSync(join(tmpdir(),'workflow-upgrade-same-process-'));dirs.push(dir);
    const path=join(dir,'documents.sqlite'),documentStore=new DocumentStore(path),portal={getState:(ctx:PortalContext)=>({data:{current_organization:{organizationId:ctx.organizationId,status:'active'},memberships:[{userId:ctx.identity.userId,organizationId:'org',status:'active',role:'owner'}]}})} as unknown as Pick<PortalService,'getState'>,legacyService=new DocumentService(documentStore,portal),ctx:PortalContext={identity:{userId:'owner',email:'owner@example.test',emailVerified:true,displayName:'Owner',platformRole:null},organizationId:'org'};
    const oldConnection=openPortalProductionDatabase(path,'freightclaw-quote-documents',2);
    try{
      const service=new DocumentWorkflowService(new DocumentWorkflowStore(documentStore,{oldWritersStopped:true,externalHandleProbe:()=>{}}),legacyService,portal);
      expect(()=>service.saveConfig(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,expected_version:0,input:{...template,standard_fee_template_v1:{template_id:'freightclaw-standard-v1',template_version:1,items:[]}},confirmed:true},'workflow-upgrade-same-process-01')).toThrow('document_v3_upgrade_old_writer_open');
      expect((documentStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(2);
    }finally{
      closePortalProductionDatabase(path,oldConnection);
      documentStore.close();
    }
  });

  it('rejects a same-inode path alias before opening a second SQLite connection',()=>{
    const dir=mkdtempSync(join(tmpdir(),'workflow-upgrade-alias-'));dirs.push(dir);
    const path=join(dir,'documents.sqlite'),alias=join(dir,'documents-link.sqlite'),documentStore=new DocumentStore(path);
    linkSync(path,alias);
    try{
      expect(()=>openPortalProductionDatabase(alias,'freightclaw-quote-documents',2)).toThrow('portal_database_path_alias_in_use');
      expect((documentStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(2);
    }finally{
      documentStore.close();
    }
  });

  it('reads history bytes from an unclaimed v2 database without creating v3 revision tables',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workflow-v2-history-'));dirs.push(dir);
    const path=join(dir,'documents.sqlite'),documentStore=new DocumentStore(path),portal={getState:(ctx:PortalContext)=>({data:{current_organization:{organizationId:ctx.organizationId,status:'active'},memberships:[{userId:ctx.identity.userId,organizationId:'org',status:'active',role:'owner'}]}})} as unknown as Pick<PortalService,'getState'>,legacyService=new DocumentService(documentStore,portal),ctx:PortalContext={identity:{userId:'owner',email:'owner@example.test',emailVerified:true,displayName:'Owner',platformRole:null},organizationId:'org'},id=randomUUID(),pdf=Buffer.from('%PDF-1.7\n'+'.'.repeat(120));
    documentStore.db.prepare('INSERT INTO quote_documents VALUES(?,?,?,?)').run(id,'org','owner',JSON.stringify({id,version:4,state:'draft',input:completeDraft(),template,template_version:1,created_at:'2026-09-15T00:00:00.000Z',owner_id:'owner',approval:null}));
    documentStore.db.prepare('INSERT INTO document_pdfs VALUES(?,?,?,?)').run(id,2,createHash('sha256').update(pdf).digest('hex'),pdf);
    const service=new DocumentWorkflowService(new DocumentWorkflowStore(documentStore),legacyService,portal);
    const history=await service.export(ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id,mode:'history',target_version:2,expected_current_version:4});
    expect(history).toMatchObject({id,version:2,revision_id:null,historical:true,valid_now:false});
    expect(Buffer.from(history.content_base64,'base64')).toEqual(pdf);
    expect((documentStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(2);
    expect(documentStore.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_revisions'").get()).toBeUndefined();
    documentStore.close();
  });

  it('retries a transient post-commit readback failure without writing another revision',()=>{
    const f=setup();
    const internals=f.service as unknown as {readbackResult:(...args:unknown[])=>unknown};
    const original=internals.readbackResult;
    let failOnce=true;
    internals.readbackResult=function(this:unknown,...args:unknown[]){
      if(failOnce){failOnce=false;throw new Error('transient_readback');}
      return original.apply(this,args);
    };
    const input={contract_version:WORKFLOW_REQUEST_VERSION,operation:'create' as const,document_kind:'manual' as const,input:completeDraft(),template_selection:{mode:'current' as const},save_intent:'save_draft' as const};
    expect(()=>f.service.save(f.ctx,input,'workflow-readback-transient-01')).toThrow('document_readback_failed');
    const replay=f.service.save(f.ctx,input,'workflow-readback-transient-01');
    expect(replay).toMatchObject({version:1,input:{quote_no:'Q-1'},claim_state:'claimed_v3'});
    expect(f.store.store.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()).toEqual({n:1});
  });

  it('keeps failing a persistently mismatched committed revision on the same-key retry',()=>{
    const f=setup();
    f.store.store.db.exec("CREATE TRIGGER workflow_readback_tamper AFTER INSERT ON document_idempotency BEGIN UPDATE document_revisions SET payload=json_set(payload,'$.input.quote_no','MISMATCHED-READBACK'); END;");
    const input={contract_version:WORKFLOW_REQUEST_VERSION,operation:'create' as const,document_kind:'manual' as const,input:completeDraft(),template_selection:{mode:'current' as const},save_intent:'save_draft' as const};
    expect(()=>f.service.save(f.ctx,input,'workflow-readback-tamper-01')).toThrow('document_readback_failed');
    expect(()=>f.service.save(f.ctx,input,'workflow-readback-tamper-01')).toThrow('document_readback_failed');
    expect(f.store.store.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()).toEqual({n:1});
  });

  it('fails closed when the persisted payload state differs from the committed result',()=>{
    const f=setup();
    f.store.store.db.exec("CREATE TRIGGER workflow_readback_state AFTER INSERT ON document_idempotency BEGIN UPDATE document_revisions SET payload=json_set(payload,'$.state','approved'); END;");
    const input={contract_version:WORKFLOW_REQUEST_VERSION,operation:'create' as const,document_kind:'manual' as const,input:completeDraft(),template_selection:{mode:'current' as const},save_intent:'save_draft' as const};
    expect(()=>f.service.save(f.ctx,input,'workflow-readback-state-01')).toThrow('document_readback_failed');
    expect(f.store.store.db.prepare('SELECT state FROM document_revisions').get()).toEqual({state:'draft'});
    expect(f.store.store.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()).toEqual({n:1});
  });

  it('preserves v3-only configuration when a legacy config-save updates the enterprise template',()=>{
    const f=setup(),before=f.service.config(f.ctx);
    expect(before.standard_fee_template_v1).not.toBeNull();
    f.legacyService.saveConfig(f.ctx,{expected_version:before.version,input:{...template,company_name:'Updated company'},confirmed:true},'workflow-legacy-config-01');
    const after=f.service.config(f.ctx);
    expect(after).toMatchObject({version:before.version+1,standard_fee_template_v1:before.standard_fee_template_v1});
    expect(after.input).toMatchObject({company_name:'Updated company'});
  });

  it('keeps historical list reads available when native pricing is no longer current',async()=>{
    const f=nativeSetup(),prepared=await f.prepare();
    f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'native_unlinked',input:prepared.input,template_selection:{mode:'current'},native_quote_v1:prepared.native_quote_v1,preview_hash:prepared.preview_hash,preview_expires_at:prepared.preview_expires_at,save_intent:'save_draft'},'workflow-list-native-stale-01');
    f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:{...completeDraft(),quote_no:'MANUAL-STALE-LIST'},template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-list-native-stale-02');
    f.disable();
    const all=f.service.list(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,limit:10,cursor:null,filters:{state:'all',quote_no:null,customer_name:null}});
    expect(all.items).toHaveLength(2);
    const filtered=f.service.list(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,limit:10,cursor:null,filters:{state:'all',quote_no:'MANUAL-STALE',customer_name:null}});
    expect(filtered.items).toHaveLength(1);
  });

  it('rejects native date tampering before persistence or review',async()=>{
    const f=nativeSetup(),prepared=await f.prepare(),tampered={...prepared.input,valid_until:'2099-12-31'};
    expect(()=>f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'native_unlinked',input:tampered,template_selection:{mode:'current'},native_quote_v1:prepared.native_quote_v1,preview_hash:prepared.preview_hash,preview_expires_at:prepared.preview_expires_at,save_intent:'save_draft'},'workflow-native-validity-01')).toThrow('native_quote_validity_invalid');
    const saved=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'native_unlinked',input:prepared.input,template_selection:{mode:'current'},native_quote_v1:prepared.native_quote_v1,preview_hash:prepared.preview_hash,preview_expires_at:prepared.preview_expires_at,save_intent:'save_draft'},'workflow-native-validity-02');
    expect(()=>f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'native_unlinked',id:saved.id,expected_version:1,input:tampered,template_selection:{mode:'retain'},binding_update:{mode:'retain'},save_intent:'save_draft'},'workflow-native-validity-03')).toThrow('native_quote_validity_invalid');
  });

  it('allows an authorized manager to rebind the immutable owner and keeps reviews actor-scoped',async()=>{
    const f=nativeSetup(),prepared=await f.prepare();
    const saved=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'native_unlinked',input:prepared.input,template_selection:{mode:'current'},native_quote_v1:prepared.native_quote_v1,preview_hash:prepared.preview_hash,preview_expires_at:prepared.preview_expires_at,save_intent:'save_draft'},'workflow-admin-rebind-01');
    const admin=f.ctxFor('admin-user');
    const adminPrepared=await f.service.prepareNative(admin,{contract_version:WORKFLOW_REQUEST_VERSION,document_kind:'native_unlinked',request:quoteRequest,customer:f.customer});
    const rebound=f.service.save(admin,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'native_unlinked',id:saved.id,expected_version:1,input:adminPrepared.input,template_selection:{mode:'retain'},binding_update:{mode:'replace',native_quote_v1:adminPrepared.native_quote_v1,preview_hash:adminPrepared.preview_hash,preview_expires_at:adminPrepared.preview_expires_at},save_intent:'save_draft'},'workflow-admin-rebind-02');
    expect(rebound).toMatchObject({id:saved.id,owner_id:'owner',version:2});
    const ownerReview=f.service.review(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:2});
    if(ownerReview.status!=='success')throw new Error('owner review unexpectedly requires input');
    expect(()=>f.service.approve(admin,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:2,review_hash:ownerReview.review_hash,evidence_ref:'review:actor',evidence_version:'1',review_notes:'核验',confirmation:'human_verified_price_and_source'},'workflow-admin-rebind-03')).toThrow('document_review_stale');
    const adminReview=f.service.review(admin,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:2});
    if(adminReview.status!=='success')throw new Error('admin review unexpectedly requires input');
    expect(f.service.approve(admin,{contract_version:WORKFLOW_REQUEST_VERSION,id:saved.id,expected_version:2,review_hash:adminReview.review_hash,evidence_ref:'review:actor',evidence_version:'1',review_notes:'核验',confirmation:'human_verified_price_and_source'},'workflow-admin-rebind-04')).toMatchObject({owner_id:'owner',state:'approved'});
  });

  it('revalidates membership after rendering and never caches unauthorized bytes',async()=>{
    const f=setup(),draft=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:completeDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-render-revoke-01');
    const revoking=new DocumentWorkflowService(f.store,f.legacyService,f.portal,()=>{f.revoke('owner');return Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120)));});
    await expect(revoking.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,mode:'draft',expected_version:1})).rejects.toThrow('document_not_found');
    expect((f.legacyStore.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get() as {n:number}).n).toBe(0);
  });

  it('returns the cache winner bytes and digest when concurrent renderers race',async()=>{
    const f=setup(),draft=f.service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:completeDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-cache-race-01');
    const bytesA=Buffer.from('%PDF-1.7\nA'+'.'.repeat(120)),bytesB=Buffer.from('%PDF-1.7\nB'+'.'.repeat(120));
    const serviceA=new DocumentWorkflowService(f.store,f.legacyService,f.portal,()=>Promise.resolve(bytesA));
    const serviceB=new DocumentWorkflowService(f.store,f.legacyService,f.portal,async()=>{await serviceA.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,mode:'draft',expected_version:1});return bytesB;});
    const result=await serviceB.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,mode:'draft',expected_version:1}),decoded=Buffer.from(result.content_base64,'base64');
    expect(createHash('sha256').update(decoded).digest('hex')).toBe(result.sha256);
    expect(decoded).toEqual(bytesA);
    expect(f.legacyStore.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get()).toEqual({n:1});
  });

  it('uses draft and formal watermarks consistently and rejects draft mode for approved rows',async()=>{
    const f=setup();let rendered='';
    const service=new DocumentWorkflowService(f.store,f.legacyService,f.portal,html=>{rendered=html;return Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120)));});
    const draft=service.save(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:completeDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-watermark-01');
    await service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,mode:'draft',expected_version:1});
    expect(rendered).toContain('DRAFT - NOT A FORMAL QUOTE');
    const review=service.review(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,expected_version:1});
    if(review.status!=='success')throw new Error('review unexpectedly requires input');
    const approved=service.approve(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,expected_version:1,review_hash:review.review_hash,evidence_ref:'review:watermark',evidence_version:'1',review_notes:'核验',confirmation:'human_verified_price_and_source'},'workflow-watermark-02');
    await expect(service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,mode:'draft',expected_version:approved.version})).rejects.toThrow('document_export_mode_invalid');
    await service.export(f.ctx,{contract_version:WORKFLOW_REQUEST_VERSION,id:draft.id,mode:'formal',expected_version:approved.version});
    expect(rendered).not.toContain('DRAFT - NOT A FORMAL QUOTE');
  });
});
