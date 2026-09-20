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
  const documentWorkflow=new DocumentWorkflowService(documentWorkflowStore,new DocumentService(documentStore,portal),portal,undefined,{receiverUserId:receiverId,receiverIsActive:()=>active.value,now:()=>now},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService});
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

describe('personal FCL cost sell quotes',()=>{
  it('persists create/update snapshots, preserves history and reopens with the same amounts',async()=>{
    const f=await setup();
    const created=f.documentWorkflow.saveFclQuote(receiver,createRequest(f),'fcl-quote-create-0001');
    expect(created.quote_ref).toMatch(/^[0-9a-f-]{36}$/u);
    expect(created).toMatchObject({version:1,current_version:1,historical:false,completeness:{complete:true}});
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
    const reopened=new DocumentWorkflowService(reopenedWorkflow,new DocumentService(reopenedStore,portal),portal,undefined,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>now},{quoteService:f.quoteService,caseReader:f.caseService,caseLock:f.caseService,rateLock:f.rateService});
    expect(reopened.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null})).toMatchObject({version:2,calculation:{by_currency:{USD:{gp_subtotal:'800.00'}}}});
    reopenedStore.close();
    f.rateStore.close();f.caseStore.close();
  });

  it('enforces personal authorization, CAS, idempotency and true readback rollback',async()=>{
    const f=await setup();
    const created=f.documentWorkflow.saveFclQuote(receiver,createRequest(f),'fcl-quote-create-0002');
    expect(()=>f.documentWorkflow.getFclQuote(other,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null})).toThrow('fcl_not_found');
    expect(()=>f.documentWorkflow.getFclQuote(enterprise,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null})).toThrow('fcl_not_found');
    expect(()=>f.documentWorkflow.getFclQuote(operator,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:created.quote_ref,version:null})).toThrow('fcl_not_found');
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
});
