import {afterEach} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFclInquiryDraft} from '../../../apps/inquiry/fcl-model';
import {CaseService,CaseStore} from '../../../services/access-gateway/portal/cases';
import {NativeAdminService,NativeAdminStore} from '../../../services/access-gateway/portal/native-admin';
import type {PortalContext} from '../../../services/access-gateway/portal/contracts';
import type {PortalService} from '../../../services/access-gateway/portal/service';
import {DocumentService,DocumentStore} from '../../../services/quote-documents/service';
import {DocumentWorkflowService,DocumentWorkflowStore,type FclQuoteWorkflowDependencies} from '../../../services/quote-documents/workflow';
import {FCL_DOCUMENT_WORKFLOW_VERSION,FCL_HANDOFF_VERSION} from '../../../services/quote-documents/fcl-contracts';
import {FclQuoteService} from '../../../services/quote-native/fcl';
import {FCL_RATE_DATASET_VERSION,type FclRateDataset} from '../../../services/quote-native/fcl-contracts';

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));

const receiverId='fcl-handoff-receiver';
const receiver:PortalContext={organizationId:null,identity:{userId:receiverId,displayName:'Receiver',email:'receiver@example.test',emailVerified:true,platformRole:null}};
const other:PortalContext={organizationId:null,identity:{userId:'fcl-handoff-other',displayName:'Other',email:'other@example.test',emailVerified:true,platformRole:null}};
const portal={getState:()=>({data:{current_organization:null,memberships:[]}})} as unknown as Pick<PortalService,'getState'>;
const fresh={fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}} as const;

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
  const root=mkdtempSync(join(tmpdir(),'fcl-handoff-')),caseStore=new CaseStore(join(root,'cases.sqlite'),{...fresh,execution:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}}),rateStore=new NativeAdminStore(join(root,'rates.sqlite'),fresh),documentStore=new DocumentStore(join(root,'documents.sqlite'),fresh);
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


export {receiver,other,readyFixture,closeFixture,handoffRequest,rates};
