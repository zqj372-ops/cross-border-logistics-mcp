import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFclInquiryDraft} from '../../apps/inquiry/fcl-model';
import {CaseService,CaseStore} from '../../services/access-gateway/portal/cases';
import {NativeAdminService,NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';
import type {PortalService} from '../../services/access-gateway/portal/service';
import {DocumentService,DocumentStore} from '../../services/quote-documents/service';
import {DocumentWorkflowService,DocumentWorkflowStore,type FclQuoteWorkflowDependencies} from '../../services/quote-documents/workflow';
import {FCL_DOCUMENT_WORKFLOW_VERSION,FCL_HANDOFF_VERSION} from '../../services/quote-documents/fcl-contracts';
import {FclQuoteService} from '../../services/quote-native/fcl';
import {FCL_RATE_DATASET_VERSION,type FclRateDataset} from '../../services/quote-native/fcl-contracts';

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));

const receiverId='fcl-handoff-receiver';
const receiver:PortalContext={organizationId:null,identity:{userId:receiverId,displayName:'Receiver',email:'receiver@example.test',emailVerified:true,platformRole:null}};
const renamedReceiver:PortalContext={...receiver,identity:{...receiver.identity,displayName:'Renamed Receiver'}};
const receiverOperator:PortalContext={...receiver,identity:{...receiver.identity,displayName:'Receiver Operator',platformRole:'operator'}};
const other:PortalContext={organizationId:null,identity:{userId:'fcl-handoff-other',displayName:'Other',email:'other@example.test',emailVerified:true,platformRole:null}};
const enterprise:PortalContext={organizationId:'org-handoff',identity:{userId:receiverId,displayName:'Receiver',email:'receiver@example.test',emailVerified:true,platformRole:null}};
const operator:PortalContext={organizationId:null,identity:{userId:'fcl-handoff-operator',displayName:'Operator',email:'operator@example.test',emailVerified:true,platformRole:'operator'}};
const portal={getState:()=>({data:{current_organization:null,memberships:[]}})} as unknown as Pick<PortalService,'getState'>;
const fresh={fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}} as const;
const reopen={fcl:{mode:'reopen'}} as const;

function rates():FclRateDataset{
  return {
    contract_version:FCL_RATE_DATASET_VERSION,
    label:'Handoff rates',
    rates:[{
      rate_id:'00000000-0000-4000-8000-000000000201',
      supplier_label:'Carrier',
      pol:'Yantian',
      pod:'Vancouver',
      valid_from:'2026-10-01',
      valid_until:'2026-10-15',
      source_ref:'synthetic:handoff-rate',
      source_version:'v1',
      note:null,
      items:[{container_type:'40HQ',ocean_freight:'3200',currency:'USD'}],
      additional_fees:[],
    }],
  };
}

function inquiry(){
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

function quoteInput(price='3500'){
  return {
    source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:price,customer_note:'Customer ocean note'}],
    manual_fees:[],
    service_scopes:[],
    exchange_rates:{USD:null,CAD:null},
    remark:null,
  };
}

async function createBase(options:{onRecord?:()=>void}={}){
  const root=mkdtempSync(join(tmpdir(),'fcl-handoff-')),caseStore=new CaseStore(join(root,'cases.sqlite'),fresh),rateStore=new NativeAdminStore(join(root,'rates.sqlite'),fresh),documentStore=new DocumentStore(join(root,'documents.sqlite'),fresh);
  roots.push(root);
  let clock='2026-10-08T12:00:00.000Z';
  const caseService=new CaseService(caseStore,portal,{receiverUserId:receiverId,receiverIsActive:()=>true,credentialSecret:'synthetic-handoff-secret-32-bytes',credentialTtlDays:30,now:()=>clock,mail:{enabled:false}});
  const rateService=new NativeAdminService(rateStore,portal,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>clock});
  const submitted=await caseService.submitFclInquiry('fcl-handoff-session','fcl-handoff-submit-0001',inquiry());
  const confirmed=caseService.confirmFclCase(receiver,submitted.case_id,{expected_version:1,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'Confirmed'},'fcl-handoff-confirm-0001');
  rateService.save(receiver,'fcl',{expected_version:0,input:rates()},'fcl-handoff-rate-save-0001');
  const preview=rateService.preview(receiver,'fcl');
  const published=rateService.publish(receiver,'fcl',{expected_version:1,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-handoff-rate-publish-0001');
  const quoteService=new FclQuoteService({caseReader:caseService,rateReader:rateService,now:()=>clock});
  const workflowStore=new DocumentWorkflowStore(documentStore,fresh);
  const pdf=Buffer.from('%PDF-1.7\n'+'.'.repeat(120));
  const handoff:NonNullable<FclQuoteWorkflowDependencies['handoff']>={
    withFclHandoffTransaction:(ctx,operation)=>caseService.withFclHandoffTransaction(ctx,operation),
    recordFclHandoffInTransaction:(ctx,input,key)=>{options.onRecord?.();return caseService.recordFclHandoffInTransaction(ctx,input,key);},
    listFclHandoffs:(ctx,caseId)=>caseService.listFclHandoffs(ctx,caseId),
    findFclHandoffByKey:(ctx,key,expected)=>caseService.findFclHandoffByKey(ctx,key,expected),
  };
  const workflow=new DocumentWorkflowService(workflowStore,new DocumentService(documentStore,portal),portal,()=>Promise.resolve(pdf),{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>clock},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService,rateReader:rateService,handoff});
  workflow.saveFclConfig(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,expected_version:0,input:{issuer_name:'Issuer',issuer_address:'Address',issuer_phone:'',issuer_email:'',terms:'Terms',standard_fee_template_v1:null},confirmed:true},'fcl-handoff-config-0001');
  const quote=workflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',case_ref:confirmed.case_id,expected_case_version:confirmed.case_version,expected_customer_supplement_ref:null,selected_rate_id:(published.active_release!.input as FclRateDataset).rates[0]!.rate_id,expected_release_id:published.active_release!.release_id,expected_release_version:published.active_release!.version,expected_dataset_digest:published.active_release!.digest,input:quoteInput()},'fcl-handoff-quote-0001');
  const doc=workflow.saveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',quote_ref:quote.quote_ref,expected_quote_version:quote.version,expected_quote_digest:quote.content_digest,expected_case_version:confirmed.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-HANDOFF-001',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:null},'fcl-handoff-doc-0001');
  return {root,caseStore,rateStore,documentStore,caseService,rateService,workflow,submitted,confirmed,published,quote,doc,pdf,setClock:(value:string)=>{clock=value;}};
}

async function readyFixture(options:{onRecord?:()=>void}={}){
  const base=await createBase(options);
  const review=base.workflow.reviewFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:base.doc.document_id,expected_version:base.doc.version});
  const approved=base.workflow.approveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:base.doc.document_id,expected_version:base.doc.version,review_hash:review.review_hash,confirmed:true},'fcl-handoff-approve-0001');
  const formal=await base.workflow.exportFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,mode:'formal',document_id:base.doc.document_id,expected_version:approved.version},'fcl-handoff-export-0001');
  return {...base,review,approved,formal};
}

async function approvedFixture(){
  const base=await createBase();
  const review=base.workflow.reviewFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:base.doc.document_id,expected_version:base.doc.version});
  const approved=base.workflow.approveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:base.doc.document_id,expected_version:base.doc.version,review_hash:review.review_hash,confirmed:true},'fcl-handoff-approved-only-01');
  return {...base,review,approved};
}

type BaseFixture=Awaited<ReturnType<typeof createBase>>;
type HandoffEvidence=BaseFixture&{
  approved:{version:number;revision_id:string};
  formal:{sha256:string};
};

function closeFixture(f:Pick<BaseFixture,'caseStore'|'rateStore'|'documentStore'>){
  f.documentStore.close();
  f.rateStore.close();
  f.caseStore.close();
}

function handoffRequest(f:HandoffEvidence){
  return {
    contract_version:FCL_HANDOFF_VERSION,
    case_ref:f.confirmed.case_id,
    expected_case_version:f.confirmed.case_version,
    expected_customer_supplement_ref:null,
    quote_ref:f.quote.quote_ref,
    expected_quote_version:f.quote.version,
    expected_quote_digest:f.quote.content_digest,
    document_id:f.doc.document_id,
    expected_document_version:f.approved.version,
    expected_pdf_sha256:f.formal.sha256,
    confirmed:true as const,
    note:'Internal handoff note',
  };
}

it('records the approved quotation handoff from server-side evidence',async()=>{
  const f=await readyFixture();
  try{
    const request=handoffRequest(f);
    const view=f.workflow.saveFclHandoff(receiver,request,'fcl-handoff-save-0001');
    expect(view).toMatchObject({status:'handed_off',reason_codes:[],history:[],replay:{replayed:false,submitted_request_digest:null,submitted_current:false}});
    expect(view.current).toMatchObject({
      inquiry_no:f.submitted.inquiry_no,
      case_id:f.confirmed.case_id,
      case_version:f.confirmed.case_version,
      quote_ref:f.quote.quote_ref,
      quote_version:f.quote.version,
      quote_digest:f.quote.content_digest,
      document_id:f.doc.document_id,
      document_revision_id:f.approved.revision_id,
      document_version:f.approved.version,
      approved_revision_id:f.approved.revision_id,
      approved_version:f.approved.version,
      pdf_sha256:f.formal.sha256,
      pdf_byte_length:f.pdf.length,
      approved_at:f.approved.decision!.at,
      handoff_status:'handed_off',
      handoff_note:request.note,
      actor:receiverId,
    });
    const event=f.caseStore.db.prepare("SELECT event_id,visibility,event_kind,payload_json FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get() as {event_id:string;visibility:string;event_kind:string;payload_json:string};
    expect(event.visibility).toBe('internal');
    expect(event.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(JSON.parse(event.payload_json)).toEqual(view.current);
    expect(f.caseService.getFclCase(receiver,f.confirmed.case_id).case_version).toBe(f.confirmed.case_version);
    expect(f.workflow.getFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:f.quote.quote_ref,version:null})).toMatchObject({version:f.quote.version,current_version:f.quote.version});
    expect(f.workflow.getFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:f.doc.document_id,version:null})).toMatchObject({version:f.approved.version,state:'approved'});
  }finally{closeFixture(f);}
});

it('returns pending before any handoff and does not write',async()=>{
  const f=await readyFixture();
  try{
    const before={events:(f.caseStore.db.prepare('SELECT COUNT(*) AS n FROM business_case_events').get() as {n:number}).n,idem:(f.caseStore.db.prepare('SELECT COUNT(*) AS n FROM business_case_idempotency').get() as {n:number}).n};
    const view=f.workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:f.confirmed.case_id});
    expect(view).toEqual({contract_version:FCL_HANDOFF_VERSION,case_ref:f.confirmed.case_id,status:'pending',reason_codes:['fcl_handoff_not_recorded'],current:null,history:[],replay:{replayed:false,submitted_request_digest:null,submitted_current:false}});
    expect(f.caseStore.db.prepare('SELECT COUNT(*) AS n FROM business_case_events').get()).toEqual({n:before.events});
    expect(f.caseStore.db.prepare('SELECT COUNT(*) AS n FROM business_case_idempotency').get()).toEqual({n:before.idem});
  }finally{closeFixture(f);}
});

it('replays the deterministic event and rejects ambiguous duplicate writes',async()=>{
  const f=await readyFixture();
  try{
    const request=handoffRequest(f);
    const first=f.workflow.saveFclHandoff(receiver,request,'fcl-handoff-replay-0001');
    const eventBefore=f.caseStore.db.prepare("SELECT event_id FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get() as {event_id:string};
    const replay=f.workflow.saveFclHandoff(renamedReceiver,request,'fcl-handoff-replay-0001');
    expect(replay).toMatchObject({status:'handed_off',replay:{replayed:true,submitted_request_digest:first.current!.request_digest,submitted_current:true}});
    expect(replay.current).toEqual(first.current);
    expect(f.caseStore.db.prepare("SELECT event_id FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get()).toEqual(eventBefore);
    expect(()=>f.workflow.saveFclHandoff(receiver,{...request,note:'Changed body'},'fcl-handoff-replay-0001')).toThrow('idempotency_conflict');
    expect(()=>f.workflow.saveFclHandoff(receiver,request,'fcl-handoff-replay-0002')).toThrow('fcl_handoff_already_recorded');
    expect(f.caseStore.db.prepare("SELECT COUNT(*) AS n FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get()).toEqual({n:1});
  }finally{closeFixture(f);}
});

it('replays historical evidence without presenting it as current after a case change',async()=>{
  const f=await readyFixture();
  try{
    const request=handoffRequest(f);
    const first=f.workflow.saveFclHandoff(receiver,request,'fcl-handoff-history-0001');
    f.caseService.updateFclCaseStatus(receiver,f.confirmed.case_id,{expected_version:f.confirmed.case_version,status:'needs_input',public_note:'Need more input',internal_note:''},'fcl-handoff-case-change-0001');
    const replay=f.workflow.saveFclHandoff(receiver,request,'fcl-handoff-history-0001');
    expect(replay).toMatchObject({status:'pending',reason_codes:['fcl_handoff_case_changed'],current:null,replay:{replayed:true,submitted_request_digest:first.current!.request_digest,submitted_current:false}});
    expect(replay.history).toEqual([first.current]);
    expect(f.workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:f.confirmed.case_id})).toMatchObject({status:'pending',current:null,history:[first.current]});
  }finally{closeFixture(f);}
});

it('rejects other people, enterprise contexts, and operators',async()=>{
  const f=await readyFixture();
  try{
    const request={contract_version:FCL_HANDOFF_VERSION,case_ref:f.confirmed.case_id};
    expect(()=>f.workflow.getFclHandoff(other,request)).toThrow('fcl_not_found');
    expect(()=>f.workflow.getFclHandoff(enterprise,request)).toThrow('fcl_not_found');
    expect(()=>f.workflow.getFclHandoff(operator,request)).toThrow('fcl_not_found');
  }finally{closeFixture(f);}
});

it('allows the exact receiver to hand off even when the receiver also has an operator role',async()=>{
  const f=await readyFixture();
  try{
    expect(f.workflow.getFclHandoff(receiverOperator,{contract_version:FCL_HANDOFF_VERSION,case_ref:f.confirmed.case_id})).toMatchObject({status:'pending'});
    expect(f.workflow.saveFclHandoff(receiverOperator,handoffRequest(f),'fcl-handoff-operator-receiver-01')).toMatchObject({status:'handed_off',current:{actor:receiverId}});
  }finally{closeFixture(f);}
});

it('blocks draft, rejected, and approved-without-PDF handoffs',async()=>{
  const draft=await createBase();
  try{
    const request={contract_version:FCL_HANDOFF_VERSION,case_ref:draft.confirmed.case_id,expected_case_version:draft.confirmed.case_version,expected_customer_supplement_ref:null,quote_ref:draft.quote.quote_ref,expected_quote_version:draft.quote.version,expected_quote_digest:draft.quote.content_digest,document_id:draft.doc.document_id,expected_document_version:draft.doc.version,expected_pdf_sha256:'a'.repeat(64),confirmed:true as const,note:'Internal handoff note'};
    expect(()=>draft.workflow.saveFclHandoff(receiver,request,'fcl-handoff-draft-block-0001')).toThrow('fcl_document_not_approved');
  }finally{closeFixture(draft);}
  const rejected=await createBase();
  try{
    const row=rejected.workflow.rejectFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:rejected.doc.document_id,expected_version:rejected.doc.version,reason:'Correction required'},'fcl-handoff-reject-0001');
    const request={contract_version:FCL_HANDOFF_VERSION,case_ref:rejected.confirmed.case_id,expected_case_version:rejected.confirmed.case_version,expected_customer_supplement_ref:null,quote_ref:rejected.quote.quote_ref,expected_quote_version:rejected.quote.version,expected_quote_digest:rejected.quote.content_digest,document_id:rejected.doc.document_id,expected_document_version:row.version,expected_pdf_sha256:'a'.repeat(64),confirmed:true as const,note:'Internal handoff note'};
    expect(()=>rejected.workflow.saveFclHandoff(receiver,request,'fcl-handoff-rejected-block-01')).toThrow('fcl_document_not_approved');
  }finally{closeFixture(rejected);}
  const approved=await approvedFixture();
  try{
    const request=handoffRequest({...approved,formal:{sha256:'b'.repeat(64)}});
    expect(()=>approved.workflow.saveFclHandoff(receiver,request,'fcl-handoff-no-pdf-block-01')).toThrow('fcl_handoff_pdf_unavailable');
  }finally{closeFixture(approved);}
});

it('rejects an approved document whose decision proof is missing',async()=>{
  const f=await readyFixture();
  try{
    f.documentStore.db.prepare("UPDATE document_revisions SET payload=json_remove(payload,'$.decision') WHERE document_id=? AND version=?").run(f.doc.document_id,f.approved.version);
    expect(()=>f.workflow.saveFclHandoff(receiver,handoffRequest(f),'fcl-handoff-proof-block-0001')).toThrow('fcl_document_readback_failed');
  }finally{closeFixture(f);}
});

it('derives pending currentness after quote, source, template, date, and document changes',async()=>{
  const quote=await readyFixture();
  try{
    const first=quote.workflow.saveFclHandoff(receiver,handoffRequest(quote),'fcl-handoff-change-base-01');
    quote.workflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:quote.quote.quote_ref,expected_version:quote.quote.version,source_binding:{mode:'retain'},input:quoteInput('3600')},'fcl-handoff-quote-change-01');
    const quoteView=quote.workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:quote.confirmed.case_id});
    expect(quoteView).toMatchObject({status:'pending',current:null,reason_codes:['fcl_handoff_quote_changed'],history:[first.current]});
  }finally{closeFixture(quote);}
  const source=await readyFixture();
  try{
    const first=source.workflow.saveFclHandoff(receiver,handoffRequest(source),'fcl-handoff-source-base-01');
    const next=rates();
    next.rates[0]!.items[0]!.ocean_freight='3400';
    source.rateService.save(receiver,'fcl',{expected_version:2,input:next},'fcl-handoff-rate-change-01');
    const preview=source.rateService.preview(receiver,'fcl');
    source.rateService.publish(receiver,'fcl',{expected_version:3,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-handoff-rate-publish-02');
    expect(source.workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:source.confirmed.case_id})).toMatchObject({status:'pending',current:null,reason_codes:['fcl_handoff_source_changed'],history:[first.current]});
  }finally{closeFixture(source);}
  const template=await readyFixture();
  try{
    template.workflow.saveFclHandoff(receiver,handoffRequest(template),'fcl-handoff-template-base-1');
    template.workflow.saveFclConfig(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,expected_version:1,input:{issuer_name:'Changed',issuer_address:'Address',issuer_phone:'',issuer_email:'',terms:'Changed',standard_fee_template_v1:null},confirmed:true},'fcl-handoff-template-change-1');
    expect(template.workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:template.confirmed.case_id})).toMatchObject({status:'pending',reason_codes:['fcl_handoff_source_changed']});
  }finally{closeFixture(template);}
  const date=await readyFixture();
  try{
    date.workflow.saveFclHandoff(receiver,handoffRequest(date),'fcl-handoff-date-base-0001');
    date.setClock('2026-10-16T12:00:00.000Z');
    expect(date.workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:date.confirmed.case_id})).toMatchObject({status:'pending',reason_codes:['fcl_handoff_source_changed']});
  }finally{closeFixture(date);}
  const document=await readyFixture();
  try{
    const first=document.workflow.saveFclHandoff(receiver,handoffRequest(document),'fcl-handoff-document-base-1');
    const next=document.workflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:document.quote.quote_ref,expected_version:document.quote.version,source_binding:{mode:'retain'},input:quoteInput('3700')},'fcl-handoff-document-quote-1');
    document.workflow.saveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'re_quote',document_id:document.doc.document_id,expected_document_version:document.approved.version,quote_ref:next.quote_ref,expected_quote_version:next.version,expected_quote_digest:next.content_digest,expected_case_version:document.confirmed.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-HANDOFF-001',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:null},'fcl-handoff-document-change-1');
    const view=document.workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:document.confirmed.case_id});
    expect(view).toMatchObject({status:'pending',current:null,history:[first.current]});
    expect(view.reason_codes).toContain('fcl_handoff_document_changed');
  }finally{closeFixture(document);}
});

it('does not fake currentness when the bound PDF disappears',async()=>{
  const f=await readyFixture();
  try{
    const first=f.workflow.saveFclHandoff(receiver,handoffRequest(f),'fcl-handoff-pdf-base-0001');
    f.documentStore.db.prepare('DELETE FROM document_pdfs WHERE id=? AND version=?').run(f.doc.document_id,f.approved.version);
    expect(f.workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:f.confirmed.case_id})).toMatchObject({status:'pending',current:null,reason_codes:['fcl_handoff_pdf_unavailable'],history:[first.current]});
  }finally{closeFixture(f);}
});

it('holds rate and document write guards until the Case handoff commits',async()=>{
  let rateProbe:NativeAdminStore|null=null,documentProbe:DocumentStore|null=null;
  const f=await readyFixture({onRecord:()=>{
    rateProbe!.db.exec('PRAGMA busy_timeout=0');
    documentProbe!.db.exec('PRAGMA busy_timeout=0');
    expect(()=>rateProbe!.db.exec('BEGIN IMMEDIATE')).toThrow();
    expect(()=>documentProbe!.db.exec('BEGIN IMMEDIATE')).toThrow();
  }});
  rateProbe=new NativeAdminStore(f.rateStore.path,reopen);
  documentProbe=new DocumentStore(f.documentStore.path,reopen);
  try{
    expect(f.workflow.saveFclHandoff(receiver,handoffRequest(f),'fcl-handoff-lock-0001').status).toBe('handed_off');
  }finally{
    documentProbe.close();
    rateProbe.close();
    closeFixture(f);
  }
});

it('rolls back event and idempotency when handoff readback evidence is tampered',async()=>{
  const eventTamper=await readyFixture();
  try{
    eventTamper.caseStore.db.exec("CREATE TRIGGER fcl_handoff_event_tamper AFTER INSERT ON business_case_events WHEN NEW.event_kind='fcl_handoff_recorded' BEGIN UPDATE business_case_events SET actor_id='tampered' WHERE event_id=NEW.event_id; END;");
    expect(()=>eventTamper.workflow.saveFclHandoff(receiver,handoffRequest(eventTamper),'fcl-handoff-tamper-event-01')).toThrow('fcl_handoff_readback_failed');
    expect(eventTamper.caseStore.db.prepare("SELECT COUNT(*) AS n FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get()).toEqual({n:0});
    expect(eventTamper.caseStore.db.prepare("SELECT COUNT(*) AS n FROM business_case_idempotency WHERE scope LIKE '%fcl-handoff%'").get()).toEqual({n:0});
  }finally{closeFixture(eventTamper);}
  const caseTamper=await readyFixture();
  try{
    caseTamper.caseStore.db.exec("CREATE TRIGGER fcl_handoff_case_tamper AFTER INSERT ON business_case_events WHEN NEW.event_kind='fcl_handoff_recorded' BEGIN UPDATE business_cases SET updated_at='tampered' WHERE case_id=NEW.case_id; END;");
    expect(()=>caseTamper.workflow.saveFclHandoff(receiver,handoffRequest(caseTamper),'fcl-handoff-tamper-case-0001')).toThrow('fcl_handoff_case_changed');
    expect(caseTamper.caseStore.db.prepare("SELECT COUNT(*) AS n FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get()).toEqual({n:0});
    expect(caseTamper.caseStore.db.prepare("SELECT COUNT(*) AS n FROM business_case_idempotency WHERE scope LIKE '%fcl-handoff%'").get()).toEqual({n:0});
  }finally{closeFixture(caseTamper);}
});

it('recovers a committed handoff exactly once after post-COMMIT transport failure',async()=>{
  const f=await readyFixture();
  try{
    const request=handoffRequest(f),db=f.caseStore.db as unknown as {exec:(sql:string)=>unknown},original=db.exec.bind(db);
    let fired=false;
    db.exec=(sql:string)=>{const result=original(sql);if(sql==='COMMIT'&&!fired){fired=true;throw new Error('local_actual_commit_exception');}return result;};
    expect(()=>f.workflow.saveFclHandoff(receiver,request,'fcl-handoff-postcommit-0001')).toThrow('local_actual_commit_exception');
    db.exec=original;
    f.setClock('2026-10-08T12:01:00.000Z');
    const replay=f.workflow.saveFclHandoff(receiver,request,'fcl-handoff-postcommit-0001');
    expect(replay).toMatchObject({status:'handed_off',replay:{replayed:true,submitted_current:true}});
    expect(f.caseStore.db.prepare("SELECT COUNT(*) AS n FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get()).toEqual({n:1});
    expect(f.caseStore.db.prepare("SELECT COUNT(*) AS n FROM business_case_idempotency WHERE scope LIKE '%fcl-handoff%'").get()).toEqual({n:1});
  }finally{closeFixture(f);}
});

it('reopens persisted handoffs and keeps the internal note out of public Case events',async()=>{
  const f=await readyFixture();
  let reopenedCase:CaseStore|null=null,reopenedRate:NativeAdminStore|null=null,reopenedDocument:DocumentStore|null=null;
  try{
    const request={...handoffRequest(f),note:'DO-NOT-EXPOSE-HANDOFF-NOTE'};
    f.workflow.saveFclHandoff(receiver,request,'fcl-handoff-reopen-0001');
    const casePath=f.caseStore.path,ratePath=f.rateStore.path,documentPath=f.documentStore.path;
    closeFixture(f);
    reopenedCase=new CaseStore(casePath,reopen);
    reopenedRate=new NativeAdminStore(ratePath,reopen);
    reopenedDocument=new DocumentStore(documentPath,reopen);
    const caseService=new CaseService(reopenedCase,portal,{receiverUserId:receiverId,receiverIsActive:()=>true,credentialSecret:'synthetic-handoff-secret-32-bytes',credentialTtlDays:30,now:()=>'2026-10-08T12:00:00.000Z',mail:{enabled:false}});
    const rateService=new NativeAdminService(reopenedRate,portal,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>'2026-10-08T12:00:00.000Z'});
    const quoteService=new FclQuoteService({caseReader:caseService,rateReader:rateService,now:()=>'2026-10-08T12:00:00.000Z'});
    const workflow=new DocumentWorkflowService(new DocumentWorkflowStore(reopenedDocument,reopen),new DocumentService(reopenedDocument,portal),portal,()=>Promise.resolve(f.pdf),{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>'2026-10-08T12:00:00.000Z'},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService,rateReader:rateService,handoff:caseService});
    expect(workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:f.confirmed.case_id})).toMatchObject({status:'handed_off',current:{handoff_note:'DO-NOT-EXPOSE-HANDOFF-NOTE'}});
    const publicView=caseService.getFclCustomerView(f.submitted.inquiry_id,f.submitted.credential);
    expect(JSON.stringify(publicView)).not.toContain('DO-NOT-EXPOSE-HANDOFF-NOTE');
    expect((publicView.events as Array<{kind:string}>).some(event=>event.kind==='fcl_handoff_recorded')).toBe(false);
  }finally{
    if(reopenedDocument)reopenedDocument.close();
    if(reopenedRate)reopenedRate.close();
    if(reopenedCase)reopenedCase.close();
  }
});

it('fails closed instead of silently truncating handoff history',async()=>{
  const f=await readyFixture();
  try{
    const first=f.workflow.saveFclHandoff(receiver,handoffRequest(f),'fcl-handoff-capacity-0001');
    const insert=f.caseStore.db.prepare('INSERT INTO business_case_events(event_id,case_id,version,status,message,visibility,actor_label,created_at,actor_id,event_kind,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for(let index=0;index<99;index++){
      const recordedAt=new Date(Date.parse('2026-10-08T12:00:00.000Z')+index+1).toISOString();
      const payload={...first.current!,recorded_at:recordedAt,request_digest:index.toString(16).padStart(64,'0')};
      insert.run(randomUUID(),f.confirmed.case_id,f.confirmed.case_version,'in_review','FCL quotation handed off.','internal','Receiver',recordedAt,receiverId,'fcl_handoff_recorded',JSON.stringify(payload));
    }
    expect(()=>f.workflow.saveFclHandoff(receiver,handoffRequest(f),'fcl-handoff-capacity-0002')).toThrow('fcl_handoff_history_limit_exceeded');
    expect(f.caseStore.db.prepare("SELECT COUNT(*) AS n FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get()).toEqual({n:100});
    const recordedAt=new Date(Date.parse('2026-10-08T12:00:00.000Z')+100).toISOString();
    insert.run(randomUUID(),f.confirmed.case_id,f.confirmed.case_version,'in_review','FCL quotation handed off.','internal','Receiver',recordedAt,receiverId,'fcl_handoff_recorded',JSON.stringify({...first.current!,recorded_at:recordedAt,request_digest:'f'.repeat(64)}));
    expect(f.caseStore.db.prepare("SELECT COUNT(*) AS n FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get()).toEqual({n:101});
    expect(()=>f.workflow.getFclHandoff(receiver,{contract_version:FCL_HANDOFF_VERSION,case_ref:f.confirmed.case_id})).toThrow('fcl_handoff_history_limit_exceeded');
  }finally{closeFixture(f);}
});
