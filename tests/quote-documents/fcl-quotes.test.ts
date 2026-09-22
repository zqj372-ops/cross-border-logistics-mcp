import {afterEach,describe,expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFclInquiryDraft} from '../../apps/inquiry/fcl-model';
import {CaseService,CaseStore} from '../../services/access-gateway/portal/cases';
import {NativeAdminService,NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';
import type {PortalService} from '../../services/access-gateway/portal/service';
import {DocumentService,DocumentStore} from '../../services/quote-documents/service';
import {DocumentWorkflowService,DocumentWorkflowStore} from '../../services/quote-documents/workflow';
import {FCL_DOCUMENT_WORKFLOW_VERSION} from '../../services/quote-documents/fcl-contracts';
import {FclQuoteService} from '../../services/quote-native/fcl';
import {FCL_RATE_DATASET_VERSION,type FclRateDataset} from '../../services/quote-native/fcl-contracts';
import {estimateToQuoteDraft} from '../../services/quote-native/fcl-operations';
import {operationsFixture,estimateRequest,cosco} from '../quote-native/fixtures/fcl-operations';
// @ts-expect-error Browser ESM module intentionally has no TypeScript declaration.
import {quoteDraftFromView} from '../../apps/console/fcl.js';

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));

const receiverId='fcl-quote-receiver';
const receiver:PortalContext={organizationId:null,identity:{userId:receiverId,displayName:'FCL Quote Receiver',email:'receiver@example.test',emailVerified:true,platformRole:null}};
const other:PortalContext={organizationId:null,identity:{...receiver.identity,userId:'other-quote-user',email:'other@example.test'}};
const enterprise:PortalContext={organizationId:'org-quote',identity:{...receiver.identity,userId:'enterprise-user',email:'enterprise@example.test'}};
const operator:PortalContext={organizationId:null,identity:{...receiver.identity,userId:'operator-quote',platformRole:'operator'}};
const portal={getState:()=>({data:{current_organization:null,memberships:[]}})} as unknown as Pick<PortalService,'getState'>;
const fclStore={fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}} as const;
const reopenFcl={fcl:{mode:'reopen'}} as const;
const now='2026-10-08T12:00:00.000Z';

function rateDataset():FclRateDataset{
  return {
    contract_version:FCL_RATE_DATASET_VERSION,
    label:'Synthetic FCL quotes',
    rates:[{
      rate_id:'00000000-0000-4000-8000-000000000201',
      supplier_label:'Synthetic carrier',
      pol:'Yantian',
      pod:'Vancouver',
      valid_from:'2026-10-01',
      valid_until:'2026-10-15',
      source_ref:'synthetic:rate:quote',
      source_version:'v1',
      note:null,
      items:[{container_type:'40HQ',ocean_freight:'3200',currency:'USD'}],
      additional_fees:[],
    }],
  };
}

function caseInput(){
  return {
    ...createFclInquiryDraft(),
    pol:'Yantian',
    pod:'Vancouver',
    cargo_name:'Synthetic cargo',
    containers:[{type:'40HQ' as const,quantity:2}],
    cargo_type:'general' as const,
    estimated_weight:{value:'18000',unit:'kg' as const},
    cargo_ready_date:'2026-10-08',
    incoterm:'EXW' as const,
    selected_services:['ocean_freight'] as const,
    contact:{name:'Synthetic Shipper',company:null,email:'shipper@example.test',phone:null},
    consent:true,
  };
}

function draftInput(sellPrice='3500'){
  return {
    source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:sellPrice,customer_note:'Ocean freight'}],
    manual_fees:[],
    service_scopes:[],
    exchange_rates:{USD:null,CAD:null},
    remark:null,
  };
}

async function setup(){
  const root=mkdtempSync(join(tmpdir(),'fcl-quotes-'));roots.push(root);
  const caseStore=new CaseStore(join(root,'cases.sqlite'),fclStore);
  const rateStore=new NativeAdminStore(join(root,'rates.sqlite'),fclStore);
  const documentStore=new DocumentStore(join(root,'documents.sqlite'),fclStore);
  const active={value:true};
  const caseService=new CaseService(caseStore,portal,{receiverUserId:receiverId,receiverIsActive:()=>active.value,credentialSecret:'synthetic-fcl-quote-secret-32-bytes',credentialTtlDays:30,now:()=>now,mail:{enabled:false}});
  const rateService=new NativeAdminService(rateStore,portal,{receiverUserId:receiverId,receiverIsActive:()=>active.value,now:()=>now});
  const submitted=await caseService.submitFclInquiry('fcl-quote-session-1','fcl-quote-submit-0001',caseInput());
  const confirmed=caseService.confirmFclCase(receiver,submitted.case_id,{expected_version:1,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'Confirmed fixture'},'fcl-quote-confirm-0001');
  rateService.save(receiver,'fcl',{expected_version:0,input:rateDataset()},'fcl-quote-rate-save-0001');
  const preview=rateService.preview(receiver,'fcl');
  const published=rateService.publish(receiver,'fcl',{expected_version:1,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-quote-rate-publish-0001');
  const quoteService=new FclQuoteService({caseReader:caseService,rateReader:rateService,now:()=>now});
  const documentWorkflowStore=new DocumentWorkflowStore(documentStore,fclStore);
  const documentWorkflow=new DocumentWorkflowService(documentWorkflowStore,new DocumentService(documentStore,portal),portal,undefined,{receiverUserId:receiverId,receiverIsActive:()=>active.value,now:()=>now},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService,rateReader:rateService});
  return {root,caseStore,rateStore,documentStore,documentWorkflowStore,documentWorkflow,caseService,rateService,quoteService,active,confirmed,published:published.active_release!};
}

function createRequest(f: Awaited<ReturnType<typeof setup>>, sellPrice='3500'){
  return {
    contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,
    operation:'create' as const,
    case_ref:f.confirmed.case_id,
    expected_case_version:f.confirmed.case_version,
    expected_customer_supplement_ref:null,
    selected_rate_id:(f.published.input as FclRateDataset).rates[0]!.rate_id,
    expected_release_id:f.published.release_id,
    expected_release_version:f.published.version,
    expected_dataset_digest:f.published.digest,
    input:draftInput(sellPrice),
  };
}

function republish(f:Awaited<ReturnType<typeof setup>>,price:string){
  const dataset=rateDataset();
  dataset.rates[0]!.items[0]!.ocean_freight=price;
  f.rateService.save(receiver,'fcl',{expected_version:2,input:dataset},'fcl-quote-rate-save-0002');
  const preview=f.rateService.preview(receiver,'fcl');
  const published=f.rateService.publish(receiver,'fcl',{expected_version:3,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-quote-rate-publish-0002');
  return published.active_release!;
}

function estimateCaseInput(){
  return {
    ...caseInput(),
    pol:'Shanghai',
    final_destination:'Calgary',
    containers:[{type:'40HQ' as const,quantity:1}],
    selected_services:['ocean_freight','canada_customs','delivery'] as const,
  };
}

async function estimateSetup(configure?:(dataset:ReturnType<typeof operationsFixture>)=>void){
  const root=mkdtempSync(join(tmpdir(),'fcl-estimate-quotes-'));roots.push(root);
  const caseStore=new CaseStore(join(root,'cases.sqlite'),fclStore);
  const rateStore=new NativeAdminStore(join(root,'rates.sqlite'),fclStore);
  const documentStore=new DocumentStore(join(root,'documents.sqlite'),fclStore);
  const caseService=new CaseService(caseStore,portal,{receiverUserId:receiverId,receiverIsActive:()=>true,credentialSecret:'synthetic-fcl-quote-secret-32-bytes',credentialTtlDays:30,now:()=>now,mail:{enabled:false}});
  const rateService=new NativeAdminService(rateStore,portal,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>now});
  const submitted=await caseService.submitFclInquiry('fcl-estimate-session','fcl-estimate-submit-01',estimateCaseInput());
  const confirmed=caseService.confirmFclCase(receiver,submitted.case_id,{expected_version:1,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'Confirmed estimate fixture'},'fcl-estimate-confirm-01');
  const dataset=operationsFixture();configure?.(dataset);
  rateService.save(receiver,'fcl',{expected_version:0,input:dataset},'fcl-estimate-rate-save-01');
  const preview=rateService.preview(receiver,'fcl');
  rateService.publish(receiver,'fcl',{expected_version:1,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-estimate-rate-publish-01');
  const quoteService=new FclQuoteService({caseReader:caseService,rateReader:rateService,now:()=>now});
  const workflowStore=new DocumentWorkflowStore(documentStore,fclStore);
  let renderedHtml='';
  const documentWorkflow=new DocumentWorkflowService(workflowStore,new DocumentService(documentStore,portal),portal,html=>{renderedHtml=html;return Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120)));},{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>now},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService,rateReader:rateService});
  documentWorkflow.saveFclConfig(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,expected_version:0,input:{issuer_name:'Issuer',issuer_address:'',issuer_phone:'',issuer_email:'',terms:'Synthetic terms',standard_fee_template_v1:null},confirmed:true},'fcl-estimate-config-save-01');
  const estimates=rateService.fclOperations.run(receiver,{...estimateRequest(),case_ref:confirmed.case_id},'fcl-estimate-run-01');
  const estimate=estimates.items.find(item=>item.calculation.rate_id===cosco)!;
  const input=estimateToQuoteDraft(estimate);
  const active=rateService.get(receiver,'fcl').active_release!;
  const quote=documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',case_ref:confirmed.case_id,expected_case_version:confirmed.case_version,expected_customer_supplement_ref:null,selected_rate_id:estimate.calculation.rate_id,expected_release_id:active.release_id,expected_release_version:active.version,expected_dataset_digest:active.digest,input},'fcl-estimate-quote-create-01');
  return {root,caseStore,rateStore,documentStore,workflowStore,caseService,rateService,documentWorkflow,confirmed,estimate,input,quote,renderedHtml:()=>renderedHtml};
}

function withAdjustments(base:ReturnType<typeof estimateToQuoteDraft>,changes:unknown[],overrides:Record<string,unknown>={}){
  return {...base,...overrides,extensions:{...base.extensions,fcl_row_adjustments_v1:{changes}}};
}

describe('personal FCL cost sell quotes',()=>{
  it('selects an undated ocean and ancillary template as a quote without a delivery tariff',async()=>{
    const f=await estimateSetup(dataset=>{
      for(const row of [...dataset.rates,...dataset.operations.templates,...dataset.operations.charges]){delete row.valid_from;delete row.valid_until;}
      dataset.operations.templates[0]!.delivery_rate_id=null;
      for(const charge of dataset.operations.charges)charge.name_en=charge.name_zh;
    });
    expect(f.estimate.currentness.valid_now).toBe(true);
    expect(f.quote.cost_rows.filter(row=>row.source_kind==='ocean_freight')).toHaveLength(1);
    expect(f.quote.currentness.valid_now).toBe(true);
  });
  it('persists create/update snapshots, preserves history and reopens with the same amounts',async()=>{
    const f=await setup();
    const created=f.documentWorkflow.saveFclQuote(receiver,createRequest(f),'fcl-quote-create-0001');
    expect(created.quote_ref).toMatch(/^[0-9a-f-]{36}$/u);
    expect(created).toMatchObject({version:1,current_version:1,historical:false,completeness:{complete:true}});
    expect(created.currentness).toEqual({valid_now:true,reason_codes:[]});
    expect(created.calculation.by_currency.USD).toMatchObject({cost_subtotal:'6400.00',revenue_subtotal:'7000.00',gp_subtotal:'600.00',margin:'0.085714'});
    const updated=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:created.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:draftInput('3600')},'fcl-quote-update-0001');
    expect(updated).toMatchObject({quote_ref:created.quote_ref,version:2,current_version:2});
    expect(updated.calculation.by_currency.USD).toMatchObject({cost_subtotal:'6400.00',revenue_subtotal:'7200.00',gp_subtotal:'800.00'});
    expect(f.documentWorkflow.saveFclQuote(receiver,createRequest(f),'fcl-quote-create-0001')).toMatchObject({version:1,current_version:2,historical:true,replay:{replayed:true,submitted_version:1,current:false}});
    expect(f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:1})).toMatchObject({version:1,current_version:2,historical:true});
    expect(f.documentWorkflow.listFclQuotes(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,case_ref:f.confirmed.case_id,limit:10,cursor:null})).toMatchObject({items:[{quote_ref:created.quote_ref,version:2,current_version:2}]});
    f.documentStore.close();
    const reopenedStore=new DocumentStore(join(f.root,'documents.sqlite'),reopenFcl);
    const reopenedWorkflow=new DocumentWorkflowStore(reopenedStore,reopenFcl);
    const reopened=new DocumentWorkflowService(reopenedWorkflow,new DocumentService(reopenedStore,portal),portal,undefined,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>now},{quoteService:f.quoteService,caseReader:f.caseService,caseLock:f.caseService,rateLock:f.rateService,rateReader:f.rateService});
    expect(reopened.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null})).toMatchObject({version:2,calculation:{by_currency:{USD:{gp_subtotal:'800.00'}}}});
    reopenedStore.close();
    f.rateStore.close();f.caseStore.close();
  });

  it('enforces personal authorization, CAS, idempotency and true readback rollback',async()=>{
    const f=await setup();
    const created=f.documentWorkflow.saveFclQuote(receiver,createRequest(f),'fcl-quote-create-0002');
    expect(()=>f.documentWorkflow.getFclQuote(other,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null})).toThrow('fcl_quote_not_found');
    expect(()=>f.documentWorkflow.getFclQuote(enterprise,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null})).toThrow('fcl_quote_not_found');
    expect(()=>f.documentWorkflow.getFclQuote(operator,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null})).toThrow('fcl_quote_not_found');
    expect(()=>f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:created.quote_ref,expected_version:2,source_binding:{mode:'retain'},input:draftInput('3600')},'fcl-quote-update-0002')).toThrow('version_conflict');
    const replay=f.documentWorkflow.saveFclQuote(receiver,createRequest(f),'fcl-quote-create-0002');
    expect(replay.replay).toEqual({replayed:true,submitted_version:1,current:true});
    expect(()=>f.documentWorkflow.saveFclQuote(receiver,createRequest(f,'3600'),'fcl-quote-create-0002')).toThrow('idempotency_conflict');
    f.active.value=false;
    expect(()=>f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null})).toThrow('fcl_unavailable');
    f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('rolls back quote, audit and idempotency on semantic readback tampering',async()=>{
    const f=await setup();
    f.documentStore.db.exec("CREATE TRIGGER fcl_quote_tamper AFTER INSERT ON document_idempotency BEGIN UPDATE fcl_quote_revisions SET payload=json_set(payload,'$.cost_rows[0].sell_price','9999'); END;");
    expect(()=>f.documentWorkflow.saveFclQuote(receiver,createRequest(f),'fcl-quote-create-0003')).toThrow('fcl_quote_readback_failed');
    expect(f.documentStore.db.prepare('SELECT COUNT(*) AS n FROM fcl_quote_revisions').get()).toEqual({n:0});
    expect(f.documentStore.db.prepare("SELECT COUNT(*) AS n FROM document_audit WHERE personal_owner_id=?").get(receiverId)).toEqual({n:0});
    expect(f.documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_idempotency').get()).toEqual({n:0});
    f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('retains old source costs and requires an explicit current source for replacement',async()=>{
    const f=await setup();
    const created=f.documentWorkflow.saveFclQuote(receiver,createRequest(f),'fcl-quote-create-0004');
    const nextRelease=republish(f,'3400');
    const stale=f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null});expect(stale.currentness.valid_now).toBe(false);expect(stale.currentness.reason_codes).toContain('fcl_quote_source_release_changed');
    const retained=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:created.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:draftInput('3600')},'fcl-quote-update-0004');
    expect(retained.calculation.by_currency.USD).toMatchObject({cost_subtotal:'6400.00',revenue_subtotal:'7200.00'});
    expect(()=>f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:created.quote_ref,expected_version:2,source_binding:{mode:'replace',expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,selected_rate_id:(f.published.input as FclRateDataset).rates[0]!.rate_id,expected_release_id:f.published.release_id,expected_release_version:f.published.version,expected_dataset_digest:f.published.digest},input:draftInput('3700')},'fcl-quote-update-0005')).toThrow('fcl_quote_source_changed');
    const replaced=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:created.quote_ref,expected_version:2,source_binding:{mode:'replace',expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,selected_rate_id:(nextRelease.input as FclRateDataset).rates[0]!.rate_id,expected_release_id:nextRelease.release_id,expected_release_version:nextRelease.version,expected_dataset_digest:nextRelease.digest},input:draftInput('3700')},'fcl-quote-update-0006');
    expect(replaced.calculation.by_currency.USD).toMatchObject({cost_subtotal:'6800.00',revenue_subtotal:'7400.00',gp_subtotal:'600.00'});
    expect(f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:1}).calculation.by_currency.USD.cost_subtotal).toBe('6400.00');
    const caseView=f.caseService.getFclCase(receiver,f.confirmed.case_id);
    f.caseService.updateFclCaseStatus(receiver,f.confirmed.case_id,{expected_version:caseView.case_version,status:'closed',public_note:'Closed fixture',internal_note:''},'fcl-quote-close-0001');
    expect(()=>f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:created.quote_ref,expected_version:3,source_binding:{mode:'retain'},input:draftInput('3800')},'fcl-quote-update-0007')).toThrow('fcl_quote_case_closed');
    expect(f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:1})).toMatchObject({version:1,historical:true});
    expect(f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null}).currentness.reason_codes).toContain('fcl_quote_case_closed');
    f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('uses synchronous Case and Rate read locks and does not duplicate a committed quote after outer lock release failure',async()=>{
    const f=await setup();
    const asyncOperation=async()=>{await Promise.resolve();return 1;};
    expect(()=>f.caseService.withFclReadLock(receiver,asyncOperation as never)).toThrow('fcl_read_lock_async_forbidden');
    const blocked=f.caseService.withFclReadLock(receiver,()=>spawnSync(process.execPath,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=25; BEGIN IMMEDIATE');",f.caseStore.path],{encoding:'utf8',timeout:2000}));
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('database is locked');

    const request=createRequest(f),key='fcl-quote-create-lock-01';
    const db=f.caseStore.db as unknown as {exec:(sql:string)=>unknown};
    const original=db.exec.bind(db);
    let failed=false;
    db.exec=(sql:string)=>{
      if(!failed&&sql==='COMMIT'){failed=true;throw new Error('outer_lock_release_failed');}
      return original(sql);
    };
    expect(()=>f.documentWorkflow.saveFclQuote(receiver,request,key)).toThrow('outer_lock_release_failed');
    db.exec=original;
    const replay=f.documentWorkflow.saveFclQuote(receiver,request,key);
    expect(replay).toMatchObject({version:1,current_version:1,replay:{replayed:true,submitted_version:1,current:true}});
    expect(f.documentStore.db.prepare('SELECT COUNT(*) AS n FROM fcl_quote_revisions').get()).toEqual({n:1});
    expect(f.documentStore.db.prepare("SELECT COUNT(*) AS n FROM document_audit WHERE action='fcl-quote-create'").get()).toEqual({n:1});
    f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('updates an estimate-bound quote in place with audited adjustments and exact binding replay',async()=>{
    const f=await estimateSetup();
    try{
      const sourceBefore=structuredClone(f.quote.source_snapshot),estimateBefore=structuredClone(f.estimate),versionOne=structuredClone(f.quote);
      const active=f.rateService.get(receiver,'fcl').active_release!;
      const rateBefore=structuredClone(active.input);
      const second=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',case_ref:f.confirmed.case_id,expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,selected_rate_id:f.estimate.calculation.rate_id,expected_release_id:active.release_id,expected_release_version:active.version,expected_dataset_digest:active.digest,input:f.input},'fcl-estimate-quote-create-02');
      const secondBefore=structuredClone(second);
      const adjustment={row_key:'ocean_freight:40HQ',operation:'override' as const,cost_price:'3250',sell_price:'3600',reason:'Ticket-specific ocean correction'};
      const input=withAdjustments(f.input,[adjustment],{remark:'Adjusted on the bound quote'});
      const updated=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input},'fcl-estimate-quote-update-01');
      expect(updated).toMatchObject({quote_ref:f.quote.quote_ref,version:2,current_version:2,remark:'Adjusted on the bound quote'});
      expect(updated.extensions?.fcl_estimate_v1).toEqual(f.input.extensions?.fcl_estimate_v1);
      expect(updated.source_snapshot).toEqual(sourceBefore);
      expect(updated.cost_rows.find(row=>row.row_key==='ocean_freight:40HQ')).toMatchObject({cost_price:'3250',sell_price:'3600',cost_amount:'3250.00',sell_amount:'3600.00'});
      const audit=updated.extensions?.fcl_row_adjustment_audit_v1?.changes[0];
      expect(audit).toMatchObject({row_key:'ocean_freight:40HQ',operation:'override',actor:receiverId});
      expect(audit?.original.cost_price).toBe('3200');
      expect(audit?.effective).toMatchObject({cost_price:'3250',sell_price:'3600'});
      expect(f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:f.quote.quote_ref,version:1})).toMatchObject({version:1,content_digest:versionOne.content_digest,cost_rows:versionOne.cost_rows,source_snapshot:versionOne.source_snapshot});
      expect(f.rateService.fclOperations.get(receiver,{estimate_id:f.estimate.estimate_id,version:null})).toEqual(estimateBefore);
      expect(f.rateService.get(receiver,'fcl').active_release?.input).toEqual(rateBefore);
      expect(f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:second.quote_ref,version:null})).toMatchObject({version:1,content_digest:secondBefore.content_digest,cost_rows:secondBefore.cost_rows});
      const replay=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input},'fcl-estimate-quote-update-01');
      expect(replay.replay).toMatchObject({replayed:true,submitted_version:2,current:true});
      expect(()=>f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:2,source_binding:{mode:'retain'},input:{...input,remark:'Different body'}},'fcl-estimate-quote-update-01')).toThrow('idempotency_conflict');
      expect(()=>f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input},'fcl-estimate-quote-update-02')).toThrow('version_conflict');
      expect(()=>f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:2,source_binding:{mode:'replace',expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,selected_rate_id:f.quote.source_snapshot.rate_id,expected_release_id:f.quote.source_snapshot.release_id,expected_release_version:f.quote.source_snapshot.release_version,expected_dataset_digest:f.quote.source_snapshot.dataset_digest},input},'fcl-estimate-quote-update-03')).toThrow('fcl_estimate_replace_rejected');
      expect(()=>f.documentWorkflow.getFclQuote(other,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:f.quote.quote_ref,version:null})).toThrow('fcl_quote_not_found');
    }finally{f.documentStore.close();f.rateStore.close();f.caseStore.close();}
  });

  it('rejects missing, changed or stale estimate bindings without appending a Quote version',async()=>{
    const f=await estimateSetup();
    try{
      const binding=f.input.extensions!.fcl_estimate_v1!;
      const update=(input:unknown,key:string)=>f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input},key);
      const {fcl_estimate_v1:_binding,...withoutEstimate}=f.input.extensions!;
      void _binding;
      expect(()=>update({...f.input,extensions:withoutEstimate},'fcl-estimate-missing-binding-01')).toThrow('fcl_estimate_binding_required');
      for(const changed of [
        {...binding,estimate_id:'00000000-0000-4000-8000-000000000999'},
        {...binding,version:binding.version+1},
        {...binding,content_digest:'f'.repeat(64)},
        {...binding,valid_from:'2026-09-01'},
        {...binding,valid_until:'2026-11-01'},
      ]) expect(()=>update({...f.input,extensions:{...f.input.extensions,fcl_estimate_v1:changed}},'fcl-estimate-changed-binding-01')).toThrow('fcl_estimate_binding_immutable');
      expect(f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:f.quote.quote_ref,version:null}).version).toBe(1);

      f.rateService.fclOperations.adjust(receiver,{estimate_id:f.estimate.estimate_id,expected_version:f.estimate.version,locked:false,recommended:false,reason:'Estimate changed upstream',changes:[{line_id:'ocean_freight:40HQ',sell_price:'3700'}]},'fcl-estimate-adjust-01');
      expect(()=>update(f.input,'fcl-estimate-stale-01')).toThrow('fcl_estimate_binding_invalid');
      expect(f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:f.quote.quote_ref,version:null}).version).toBe(1);
    }finally{f.documentStore.close();f.rateStore.close();f.caseStore.close();}
  });

  it('keeps the full canonical gate when attaching a binding to an existing unbound Quote',async()=>{
    const f=await estimateSetup();
    try{
      const {extensions:_estimateExtension,...unboundInput}=estimateToQuoteDraft(f.estimate);
      void _estimateExtension;
      const active=f.rateService.get(receiver,'fcl').active_release!;
      const unbound=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',case_ref:f.confirmed.case_id,expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,selected_rate_id:f.estimate.calculation.rate_id,expected_release_id:active.release_id,expected_release_version:active.version,expected_dataset_digest:active.digest,input:unboundInput},'fcl-unbound-create-01');
      const forged={...f.input.extensions!.fcl_estimate_v1!,content_digest:'f'.repeat(64)};
      expect(()=>f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:unbound.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:{...unboundInput,extensions:{fcl_estimate_v1:forged}}},'fcl-unbound-binding-update-01')).toThrow('fcl_estimate_binding_invalid');
      expect(f.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:unbound.quote_ref,version:null}).version).toBe(1);
    }finally{f.documentStore.close();f.rateStore.close();f.caseStore.close();}
  });

  it('removes source and manual rows, round-trips writable extensions, and saves the next version',async()=>{
    const f=await estimateSetup();
    try{
      const source=f.quote.cost_rows.find(row=>row.source_kind==='ocean_freight')!;
      const manual=f.quote.cost_rows.find(row=>row.source_kind==='manual')!;
      const removed=withAdjustments(f.input,[
        {row_key:source.row_key,operation:'remove',reason:'Source fee removed on this ticket'},
        {row_key:manual.row_key,operation:'remove',reason:'Manual fee removed on this ticket'},
      ],{remark:'Rows removed'});
      const updated=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:removed},'fcl-estimate-remove-roundtrip-01');
      expect(updated.cost_rows.some(row=>row.row_key===source.row_key||row.row_key===manual.row_key)).toBe(false);
      const draft=(quoteDraftFromView as (value:unknown)=>typeof f.input)(updated);
      expect(draft.extensions).not.toHaveProperty('fcl_row_adjustment_audit_v1');
      expect(draft.extensions?.fcl_row_adjustments_v1?.changes).not.toContainEqual(expect.objectContaining({row_key:manual.row_key}));
      expect(draft.extensions?.fcl_row_adjustments_v1?.changes).toContainEqual(expect.objectContaining({row_key:source.row_key,operation:'remove'}));
      const next=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:2,source_binding:{mode:'retain'},input:draft},'fcl-estimate-remove-roundtrip-02');
      expect(next).toMatchObject({quote_ref:f.quote.quote_ref,version:3,current_version:3});
      expect(next.extensions?.fcl_estimate_v1).toEqual(f.input.extensions?.fcl_estimate_v1);
      expect(next.source_snapshot).toEqual(f.quote.source_snapshot);
    }finally{f.documentStore.close();f.rateStore.close();f.caseStore.close();}
  });

  it('invalidates the old review, then renders the adjusted Quote through the existing formal PDF path',async()=>{
    const f=await estimateSetup();
    try{
      const document=f.documentWorkflow.saveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',quote_ref:f.quote.quote_ref,expected_quote_version:1,expected_quote_digest:f.quote.content_digest,expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-A2-001',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:null},'fcl-estimate-document-create-01');
      const oldReview=f.documentWorkflow.reviewFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:document.document_id,expected_version:document.version});
      const adjusted=withAdjustments(f.input,[{row_key:'ocean_freight:40HQ',operation:'override',cost_price:'3250',sell_price:'3600',reason:'Adjusted before formal review'}]);
      const quote=f.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:adjusted},'fcl-estimate-document-quote-update-01');
      expect(()=>f.documentWorkflow.approveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:document.document_id,expected_version:document.version,review_hash:oldReview.review_hash,confirmed:true},'fcl-estimate-old-review-approve-01')).toThrow('fcl_document_quote_not_current');
      const refreshed=f.documentWorkflow.saveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'refresh',document_id:document.document_id,expected_document_version:document.version,quote_ref:quote.quote_ref,expected_quote_version:quote.version,expected_quote_digest:quote.content_digest,expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-A2-001',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:'Adjusted fixture'},'fcl-estimate-document-refresh-01');
      const review=f.documentWorkflow.reviewFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:refreshed.document_id,expected_version:refreshed.version});
      const approved=f.documentWorkflow.approveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:refreshed.document_id,expected_version:refreshed.version,review_hash:review.review_hash,confirmed:true},'fcl-estimate-document-approve-01');
      const exported=await f.documentWorkflow.exportFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,mode:'formal',document_id:approved.document_id,expected_version:approved.version},'fcl-estimate-document-export-01');
      expect(exported.sha256).toHaveLength(64);
      expect(f.renderedHtml()).toContain('3600.00');
      expect(quote.calculation.by_currency.USD).toMatchObject({cost_subtotal:'3250.00',revenue_subtotal:'3600.00'});
    }finally{f.documentStore.close();f.rateStore.close();f.caseStore.close();}
  });

  it('rejects changed Cases and changed source publications for bound updates',async()=>{
    const caseChanged=await estimateSetup();
    try{
      const view=caseChanged.caseService.getFclCase(receiver,caseChanged.confirmed.case_id);
      caseChanged.caseService.updateFclCaseStatus(receiver,caseChanged.confirmed.case_id,{expected_version:view.case_version,status:'needs_input',public_note:'Need customer input',internal_note:''},'fcl-estimate-case-change-01');
      expect(()=>caseChanged.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:caseChanged.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:caseChanged.input},'fcl-estimate-case-change-update-01')).toThrow('fcl_quote_case_review_required');
    }finally{caseChanged.documentStore.close();caseChanged.rateStore.close();caseChanged.caseStore.close();}

    const sourceChanged=await estimateSetup();
    try{
      const dataset=operationsFixture();dataset.rates.find(rate=>rate.rate_id===cosco)!.items[0]!.ocean_freight='3300';
      sourceChanged.rateService.save(receiver,'fcl',{expected_version:2,input:dataset},'fcl-estimate-source-save-01');
      const preview=sourceChanged.rateService.preview(receiver,'fcl');sourceChanged.rateService.publish(receiver,'fcl',{expected_version:3,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-estimate-source-publish-01');
      expect(()=>sourceChanged.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:sourceChanged.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:sourceChanged.input},'fcl-estimate-source-change-update-01')).toThrow('fcl_estimate_binding_invalid');
    }finally{sourceChanged.documentStore.close();sourceChanged.rateStore.close();sourceChanged.caseStore.close();}

    const unrelatedRelease=await estimateSetup();
    try{
      const dataset=operationsFixture();dataset.label='Unrelated metadata publication';
      unrelatedRelease.rateService.save(receiver,'fcl',{expected_version:2,input:dataset},'fcl-estimate-unrelated-save-01');
      const preview=unrelatedRelease.rateService.preview(receiver,'fcl');unrelatedRelease.rateService.publish(receiver,'fcl',{expected_version:3,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-estimate-unrelated-publish-01');
      expect(unrelatedRelease.rateService.fclOperations.get(receiver,{estimate_id:unrelatedRelease.estimate.estimate_id,version:null}).currentness.valid_now).toBe(true);
      expect(()=>unrelatedRelease.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:unrelatedRelease.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:unrelatedRelease.input},'fcl-estimate-unrelated-update-01')).toThrow('fcl_quote_source_changed');
      expect(unrelatedRelease.documentWorkflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:unrelatedRelease.quote.quote_ref,version:null}).version).toBe(1);
    }finally{unrelatedRelease.documentStore.close();unrelatedRelease.rateStore.close();unrelatedRelease.caseStore.close();}
  });
});
