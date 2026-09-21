import {afterEach,describe,expect,it} from 'vitest';
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
const receiverId='fcl-document-receiver';
const receiver:PortalContext={organizationId:null,identity:{userId:receiverId,displayName:'Receiver',email:'receiver@example.test',emailVerified:true,platformRole:null}};
const other:PortalContext={organizationId:null,identity:{...receiver.identity,userId:'other-document-user',email:'other@example.test'}};
const enterprise:PortalContext={organizationId:'org-document',identity:{...receiver.identity,userId:'enterprise-document',email:'enterprise@example.test'}};
const operator:PortalContext={organizationId:null,identity:{...receiver.identity,userId:'operator-document',platformRole:'operator'}};
const portal={getState:()=>({data:{current_organization:null,memberships:[]}})} as unknown as Pick<PortalService,'getState'>;
const fcl={fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}} as const;
const now='2026-10-08T12:00:00.000Z';

function rates():FclRateDataset{return {contract_version:FCL_RATE_DATASET_VERSION,label:'FCL documents',rates:[{rate_id:'00000000-0000-4000-8000-000000000201',supplier_label:'Carrier',pol:'Yantian',pod:'Vancouver',valid_from:'2026-10-01',valid_until:'2026-10-15',source_ref:'synthetic:document-rate',source_version:'v1',note:null,items:[{container_type:'40HQ',ocean_freight:'3200',currency:'USD'}],additional_fees:[]}]};}
function inquiry(){return {...createFclInquiryDraft(),pol:'Yantian',pod:'Vancouver',cargo_name:'Synthetic cargo',containers:[{type:'40HQ' as const,quantity:2}],cargo_type:'general' as const,estimated_weight:{value:'18000',unit:'kg' as const},cargo_ready_date:'2026-10-08',incoterm:'EXW' as const,selected_services:['ocean_freight'] as const,contact:{name:'Synthetic Shipper',company:null,email:'shipper@example.test',phone:null},consent:true};}
function quoteInput(price:string|null='3500'){return {source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:price,customer_note:'Ocean freight'}],manual_fees:[],service_scopes:[],exchange_rates:{USD:null,CAD:null},remark:null};}

async function setup(){
  const root=mkdtempSync(join(tmpdir(),'fcl-documents-'));roots.push(root);
  const caseStore=new CaseStore(join(root,'cases.sqlite'),fcl),rateStore=new NativeAdminStore(join(root,'rates.sqlite'),fcl),documentStore=new DocumentStore(join(root,'documents.sqlite'),fcl),active={value:true};
  const caseService=new CaseService(caseStore,portal,{receiverUserId:receiverId,receiverIsActive:()=>active.value,credentialSecret:'synthetic-document-secret-32-bytes',credentialTtlDays:30,now:()=>now,mail:{enabled:false}});
  const rateService=new NativeAdminService(rateStore,portal,{receiverUserId:receiverId,receiverIsActive:()=>active.value,now:()=>now});
  const submitted=await caseService.submitFclInquiry('fcl-doc-session-1','fcl-doc-submit-0001',inquiry());
  const confirmed=caseService.confirmFclCase(receiver,submitted.case_id,{expected_version:1,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'Confirmed fixture'},'fcl-doc-confirm-0001');
  rateService.save(receiver,'fcl',{expected_version:0,input:rates()},'fcl-doc-rate-save-0001');const preview=rateService.preview(receiver,'fcl');const published=rateService.publish(receiver,'fcl',{expected_version:1,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-doc-rate-publish-0001');
  const quoteService=new FclQuoteService({caseReader:caseService,rateReader:rateService,now:()=>now});
  const documentWorkflowStore=new DocumentWorkflowStore(documentStore,fcl);
  const documentWorkflow=new DocumentWorkflowService(documentWorkflowStore,new DocumentService(documentStore,portal),portal,undefined,{receiverUserId:receiverId,receiverIsActive:()=>active.value,now:()=>now},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService,rateReader:rateService});
  documentWorkflow.saveFclConfig(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,expected_version:0,input:{issuer_name:'Synthetic Issuer',issuer_address:'Address',issuer_phone:'',issuer_email:'',terms:'Terms',standard_fee_template_v1:null},confirmed:true},'fcl-doc-config-0001');
  return {root,caseStore,rateStore,documentStore,documentWorkflow,caseService,rateService,quoteService,confirmed,published:published.active_release!};
}

function quoteRequest(f:Awaited<ReturnType<typeof setup>>,price:string|null='3500'){return {contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create' as const,case_ref:f.confirmed.case_id,expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,selected_rate_id:(f.published.input as FclRateDataset).rates[0]!.rate_id,expected_release_id:f.published.release_id,expected_release_version:f.published.version,expected_dataset_digest:f.published.digest,input:quoteInput(price)};}
function documentRequest(f:Awaited<ReturnType<typeof setup>>,quote_ref:string,quote_version=1,expected_quote_digest?:string){return {contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create' as const,quote_ref,expected_quote_version:quote_version,expected_quote_digest:expected_quote_digest??'',expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-CUSTOMER-001',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:'Customer-facing remark'};}
function republish(f:Awaited<ReturnType<typeof setup>>){const dataset=rates();dataset.rates[0]!.items[0]!.ocean_freight='3400';f.rateService.save(receiver,'fcl',{expected_version:2,input:dataset},'fcl-doc-rate-save-0002');const preview=f.rateService.preview(receiver,'fcl');return f.rateService.publish(receiver,'fcl',{expected_version:3,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-doc-rate-publish-0002').active_release!;}

describe('FCL linked customer documents',()=>{
  it('creates a sell-only fcl_linked draft, refreshes it and returns historical views',async()=>{
    const f=await setup();const quote=f.documentWorkflow.saveFclQuote(receiver,quoteRequest(f),'fcl-doc-quote-create-0001');const created=f.documentWorkflow.saveFclDocument(receiver,documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),'fcl-doc-create-0001');
    expect(created).toMatchObject({document_kind:'fcl_linked',state:'draft',version:1,current_version:1,quote_binding:{quote_ref:quote.quote_ref,quote_version:1}});
    expect(created.customer_input.fee_items).toHaveLength(1);expect(created.customer_input.fee_items[0]).toMatchObject({unit_price:'3500',quantity:'2',currency:'USD'});expect(created.customer_input).not.toHaveProperty('cost_price');expect(created.customer_totals.by_currency.USD).toBe('7000.00');
    const refreshed=f.documentWorkflow.saveFclDocument(receiver,{...documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),operation:'refresh',document_id:created.document_id,expected_document_version:1,quote_no:'FCL-CUSTOMER-002'},'fcl-doc-refresh-0001');
    expect(refreshed).toMatchObject({version:2,current_version:2,historical:false});
    expect(f.documentWorkflow.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:created.document_id,version:1})).toMatchObject({version:1,historical:true,customer_input:{quote_no:'FCL-CUSTOMER-001'}});
    expect(f.documentWorkflow.listFclDocuments(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,case_ref:f.confirmed.case_id,limit:10,cursor:null}).items).toEqual([expect.objectContaining({document_id:created.document_id,version:2})]);
    f.documentStore.close();
    const reopenedStore=new DocumentStore(join(f.root,'documents.sqlite'),{fcl:{mode:'reopen'}});const reopenedWorkflowStore=new DocumentWorkflowStore(reopenedStore,{fcl:{mode:'reopen'}});const reopened=new DocumentWorkflowService(reopenedWorkflowStore,new DocumentService(reopenedStore,portal),portal,undefined,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>now},{quoteService:f.quoteService,caseReader:f.caseService,caseLock:f.caseService,rateLock:f.rateService,rateReader:f.rateService});
    expect(reopened.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:created.document_id,version:1})).toMatchObject({version:1,historical:true,customer_totals:{by_currency:{USD:'7000.00'}}});
    expect(reopened.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:created.document_id,version:null})).toMatchObject({version:2,currentness:{valid_now:true}});
    reopenedStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('rejects forged client fields, unauthorized readers and invalid dates',async()=>{
    const f=await setup();const quote=f.documentWorkflow.saveFclQuote(receiver,quoteRequest(f),'fcl-doc-quote-create-0002');
    expect(()=>f.documentWorkflow.saveFclDocument(receiver,{...documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),cost_price:'3200'},'fcl-doc-forged-0001')).toThrow('fcl_document_input_invalid');
    expect(()=>f.documentWorkflow.saveFclDocument(receiver,{...documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),quote_no:'   '},'fcl-doc-blank-quote-0001')).toThrow('fcl_document_input_invalid');
    expect(()=>f.documentWorkflow.getFclDocument(other,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:'00000000-0000-4000-8000-000000000999',version:null})).toThrow('fcl_not_found');
    expect(()=>f.documentWorkflow.getFclDocument(enterprise,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:'00000000-0000-4000-8000-000000000999',version:null})).toThrow('fcl_not_found');
    expect(()=>f.documentWorkflow.getFclDocument(operator,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:'00000000-0000-4000-8000-000000000999',version:null})).toThrow('fcl_not_found');
    expect(()=>f.documentWorkflow.saveFclDocument(receiver,{...documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),quote_date:'2026-10-20'},'fcl-doc-date-0001')).toThrow('fcl_document_date_invalid');
    expect(f.documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()).toEqual({n:0});
    f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('marks changed Case, quote, source and template as not current while retaining history',async()=>{
    const f=await setup();const quote=f.documentWorkflow.saveFclQuote(receiver,quoteRequest(f),'fcl-doc-quote-create-0003');const created=f.documentWorkflow.saveFclDocument(receiver,documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),'fcl-doc-create-0003');
    const caseView=f.caseService.getFclCase(receiver,f.confirmed.case_id);f.caseService.updateFclCaseStatus(receiver,f.confirmed.case_id,{expected_version:caseView.case_version,status:'needs_input',public_note:'Need supplement',internal_note:''},'fcl-doc-case-change-0001');
    const afterCase=f.documentWorkflow.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:created.document_id,version:null});expect(afterCase.historical).toBe(false);expect(afterCase.currentness.valid_now).toBe(false);expect(afterCase.currentness.reason_codes).toContain('fcl_quote_case_version_changed');
    expect(afterCase.currentness.reason_codes).toContain('fcl_quote_case_review_required');
    f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('invalidates currentness on source/template/quote changes and rejects payload tampering',async()=>{
    const source=await setup();const sourceQuote=source.documentWorkflow.saveFclQuote(receiver,quoteRequest(source),'fcl-doc-quote-create-0004');const sourceDoc=source.documentWorkflow.saveFclDocument(receiver,documentRequest(source,sourceQuote.quote_ref,sourceQuote.version,sourceQuote.content_digest),'fcl-doc-create-0004');republish(source);const sourceChanged=source.documentWorkflow.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:sourceDoc.document_id,version:null});expect(sourceChanged.currentness).toMatchObject({valid_now:false});expect(sourceChanged.currentness.reason_codes).toContain('fcl_quote_source_release_changed');expect(sourceChanged.customer_totals.by_currency.USD).toBe('7000.00');source.rateService.disable(receiver,'fcl',{expected_version:source.rateService.get(receiver,'fcl').version},'fcl-doc-rate-disable-0001');const disabled=source.documentWorkflow.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:sourceDoc.document_id,version:null});expect(disabled.currentness.reason_codes).toContain('fcl_quote_source_unavailable');source.documentStore.close();source.rateStore.close();source.caseStore.close();

    const template=await setup();const templateQuote=template.documentWorkflow.saveFclQuote(receiver,quoteRequest(template),'fcl-doc-quote-create-0005');const templateDoc=template.documentWorkflow.saveFclDocument(receiver,documentRequest(template,templateQuote.quote_ref,templateQuote.version,templateQuote.content_digest),'fcl-doc-create-0005');template.documentWorkflow.saveFclConfig(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,expected_version:1,input:{issuer_name:'Changed Issuer',issuer_address:'Address',issuer_phone:'',issuer_email:'',terms:'Changed terms',standard_fee_template_v1:null},confirmed:true},'fcl-doc-config-0002');const templateChanged=template.documentWorkflow.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:templateDoc.document_id,version:null});expect(templateChanged.currentness.reason_codes).toContain('fcl_document_template_changed');template.documentStore.close();template.rateStore.close();template.caseStore.close();

    const quoteChange=await setup();const oldQuote=quoteChange.documentWorkflow.saveFclQuote(receiver,quoteRequest(quoteChange),'fcl-doc-quote-create-0007');const quoteDoc=quoteChange.documentWorkflow.saveFclDocument(receiver,documentRequest(quoteChange,oldQuote.quote_ref,oldQuote.version,oldQuote.content_digest),'fcl-doc-create-0007');quoteChange.documentWorkflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:oldQuote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:quoteInput('3600')}, 'fcl-doc-quote-update-0007');const quoteChanged=quoteChange.documentWorkflow.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:quoteDoc.document_id,version:null});expect(quoteChanged.currentness.valid_now).toBe(false);expect(quoteChanged.currentness.reason_codes).toContain('fcl_quote_not_current_version');expect(quoteChanged.currentness.reason_codes).toContain('fcl_document_quote_changed');quoteChange.documentStore.close();quoteChange.rateStore.close();quoteChange.caseStore.close();

    const tamper=await setup();const tamperQuote=tamper.documentWorkflow.saveFclQuote(receiver,quoteRequest(tamper),'fcl-doc-quote-create-0006');const tamperDoc=tamper.documentWorkflow.saveFclDocument(receiver,documentRequest(tamper,tamperQuote.quote_ref,tamperQuote.version,tamperQuote.content_digest),'fcl-doc-create-0006');tamper.documentStore.db.prepare("UPDATE document_revisions SET payload=json_set(payload,'$.customer_input.fee_items[0].unit_price','9999') WHERE document_id=?").run(tamperDoc.document_id);expect(()=>tamper.documentWorkflow.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:tamperDoc.document_id,version:null})).toThrow('fcl_document_readback_failed');tamper.documentStore.close();tamper.rateStore.close();tamper.caseStore.close();
  });

  it('enforces quote completeness, customer-only route fields and date boundaries',async()=>{
    const incomplete=await setup();const incompleteQuote=incomplete.documentWorkflow.saveFclQuote(receiver,quoteRequest(incomplete,null),'fcl-doc-quote-incomplete-0001');expect(incompleteQuote.completeness.complete).toBe(false);expect(()=>incomplete.documentWorkflow.saveFclDocument(receiver,documentRequest(incomplete,incompleteQuote.quote_ref,incompleteQuote.version,incompleteQuote.content_digest),'fcl-doc-incomplete-0001')).toThrow('fcl_document_quote_incomplete');expect(incomplete.documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()).toEqual({n:0});incomplete.documentStore.close();incomplete.rateStore.close();incomplete.caseStore.close();

    const dates=await setup();const quote=dates.documentWorkflow.saveFclQuote(receiver,quoteRequest(dates),'fcl-doc-quote-date-0001');const past=dates.documentWorkflow.saveFclDocument(receiver,{...documentRequest(dates,quote.quote_ref,quote.version,quote.content_digest),quote_date:'2026-10-07'},'fcl-doc-past-0001');expect(past.customer_input.quote_date).toBe('2026-10-07');expect(past.customer_input.container_no).toBeNull();expect(past.case_projection.incoterm).toBe('EXW');expect(()=>dates.documentWorkflow.saveFclDocument(receiver,{...documentRequest(dates,quote.quote_ref,quote.version,quote.content_digest),quote_date:'2026-10-09'},'fcl-doc-future-0001')).toThrow('fcl_document_date_invalid');expect(dates.documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()).toEqual({n:1});dates.documentStore.close();dates.rateStore.close();dates.caseStore.close();
  });

  it('rolls back document revision/current/event/audit/idempotency on metadata tampering',async()=>{
    const f=await setup();const quote=f.documentWorkflow.saveFclQuote(receiver,quoteRequest(f),'fcl-doc-quote-tamper-0001');f.documentStore.db.exec("CREATE TRIGGER fcl_document_meta_tamper AFTER INSERT ON document_idempotency BEGIN UPDATE document_revisions SET schema_version=6; END;");expect(()=>f.documentWorkflow.saveFclDocument(receiver,documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),'fcl-doc-meta-tamper-0001')).toThrow('fcl_document_readback_failed');expect(f.documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()).toEqual({n:0});expect(f.documentStore.db.prepare("SELECT COUNT(*) AS n FROM document_audit WHERE action LIKE 'fcl-document-%'").get()).toEqual({n:0});expect(f.documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_idempotency WHERE scope LIKE \'%"fcl-document-create"%\'').get()).toEqual({n:0});f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('does not let refresh move a document revision to another Case',async()=>{
    const f=await setup();const quote=f.documentWorkflow.saveFclQuote(receiver,quoteRequest(f),'fcl-doc-quote-case-a-0001');const doc=f.documentWorkflow.saveFclDocument(receiver,documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),'fcl-doc-case-a-0001');
    const submitted=await f.caseService.submitFclInquiry('fcl-doc-session-2','fcl-doc-submit-0002',{...inquiry(),cargo_name:'Second synthetic cargo'});const secondCase=f.caseService.confirmFclCase(receiver,submitted.case_id,{expected_version:1,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'Second fixture'},'fcl-doc-confirm-0002');const secondQuote=f.documentWorkflow.saveFclQuote(receiver,{...quoteRequest(f),case_ref:secondCase.case_id,expected_case_version:secondCase.case_version},'fcl-doc-quote-case-b-0001');
    expect(()=>f.documentWorkflow.saveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'refresh',document_id:doc.document_id,expected_document_version:1,quote_ref:secondQuote.quote_ref,expected_quote_version:1,expected_quote_digest:secondQuote.content_digest,expected_case_version:secondCase.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-CUSTOMER-B',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:null},'fcl-doc-case-b-refresh-0001')).toThrow('fcl_document_case_mismatch');expect(f.documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_revisions WHERE personal_owner_id=?').get(receiverId)).toEqual({n:1});f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('detects idempotency references pointing at another valid document and rejects same-key body changes',async()=>{
    const f=await setup();const quote=f.documentWorkflow.saveFclQuote(receiver,quoteRequest(f),'fcl-doc-quote-ref-0001');const firstRequest=documentRequest(f,quote.quote_ref,quote.version,quote.content_digest);const first=f.documentWorkflow.saveFclDocument(receiver,firstRequest,'fcl-doc-ref-first-0001');expect(f.documentWorkflow.saveFclDocument(receiver,firstRequest,'fcl-doc-ref-first-0001')).toMatchObject({document_id:first.document_id,version:1});const second=f.documentWorkflow.saveFclDocument(receiver,{...documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),quote_no:'FCL-CUSTOMER-SECOND'},'fcl-doc-ref-second-0001');
    f.documentStore.db.prepare("UPDATE document_idempotency SET result=json_set(result,'$.document_id',?,'$.version',?) WHERE key=?").run(second.document_id,second.version,'fcl-doc-ref-first-0001');
    expect(()=>f.documentWorkflow.saveFclDocument(receiver,documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),'fcl-doc-ref-first-0001')).toThrow('fcl_document_readback_failed');
    expect(()=>f.documentWorkflow.saveFclDocument(receiver,{...documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),quote_no:'CHANGED'},'fcl-doc-ref-second-0001')).toThrow('idempotency_conflict');
    expect(f.documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_revisions WHERE personal_owner_id=?').get(receiverId)).toEqual({n:2});f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });

  it('keeps an unpublished Rate draft from invalidating the selected active source',async()=>{
    const f=await setup();const quote=f.documentWorkflow.saveFclQuote(receiver,quoteRequest(f),'fcl-doc-quote-draft-rate-0001');const doc=f.documentWorkflow.saveFclDocument(receiver,documentRequest(f,quote.quote_ref,quote.version,quote.content_digest),'fcl-doc-draft-rate-0001');const draft=rates();draft.rates[0]!.items[0]!.ocean_freight='3400';f.rateService.save(receiver,'fcl',{expected_version:2,input:draft},'fcl-doc-rate-draft-save-0002');expect(f.documentWorkflow.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:doc.document_id,version:null}).currentness).toEqual({valid_now:true,reason_codes:[]});f.documentStore.close();f.rateStore.close();f.caseStore.close();
  });
});
