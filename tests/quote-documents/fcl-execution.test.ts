import {expect,it,vi} from 'vitest';
import {CaseStore} from '../../services/access-gateway/portal/cases';
import {emptyFclNotificationConfig} from '../../services/access-gateway/portal/fcl-execution-contracts';
import {FCL_DOCUMENT_WORKFLOW_VERSION} from '../../services/quote-documents/fcl-contracts';
import {FclExecutionService} from '../../services/access-gateway/portal/fcl-execution';
import {FCL_EXECUTION_VERSION} from '../../services/access-gateway/portal/fcl-execution-contracts';
import {receiver,other,readyFixture,closeFixture,handoffRequest,rates} from './fixtures/fcl-execution';

async function setup(){
  const f=await readyFixture();
  const execution=new FclExecutionService(f.caseService,{now:()=> '2026-10-08T12:00:00.000Z',isActive:()=>true});
  const request={contract_version:FCL_EXECUTION_VERSION,handoff:handoffRequest(f),confirmation:{method:'email',confirmed_at:'2026-10-08T11:00:00Z',contact_name:'Synthetic customer',note:'Customer accepted this formal version',evidence_refs:[]},coordinator_id:receiver.identity.userId,expected_config_version:0,confirmed:true};
  return {...f,execution,request};
}

it('does not infer a sale from approval, PDF or handoff; starts exactly one execution with frozen evidence',async()=>{
  const f=await setup();try{
    expect(f.execution.get(receiver,{case_ref:f.confirmed.case_id})).toBeNull();
    f.workflow.saveFclHandoff(receiver,handoffRequest(f),'execution-existing-handoff');
    expect(f.execution.get(receiver,{case_ref:f.confirmed.case_id})).toBeNull();
    const before=f.caseService.getFclCase(receiver,f.confirmed.case_id);
    const preview=f.workflow.previewFclExecution(receiver,f.request,f.execution);
    expect(preview.nodes.map(n=>n.node_id)).toEqual(['booking','shipping_documents']);
    const first=f.workflow.startFclExecution(receiver,f.request,'execution-start-0001',f.execution);
    expect(first.acceptances[0]?.confirmation.note).toContain('accepted');
    expect(first.nodes).toHaveLength(2);
    expect(f.workflow.startFclExecution(receiver,f.request,'execution-start-0001',f.execution)).toEqual(first);
    expect(f.workflow.startFclExecution(receiver,f.request,'execution-start-0002',f.execution)).toEqual(first);
    expect(f.caseStore.db.prepare('SELECT count(*) AS n FROM fcl_case_progress').get()).toEqual({n:1});
    expect(f.caseService.getFclCase(receiver,f.confirmed.case_id).case_version).toBe(before.case_version);
    expect(f.caseStore.db.prepare("SELECT count(*) AS n FROM business_case_events WHERE event_kind='fcl_handoff_recorded'").get()).toEqual({n:1});
  }finally{closeFixture(f);}
});

it('fails closed on confirmation, version mismatch, unknown fields, and other account direct service calls',async()=>{
  const f=await setup();try{
    expect(()=>f.workflow.startFclExecution(receiver,{...f.request,confirmation:null},'execution-invalid-0001',f.execution)).toThrow();
    expect(()=>f.workflow.startFclExecution(receiver,{...f.request,handoff:{...f.request.handoff,expected_quote_version:2}},'execution-invalid-0002',f.execution)).toThrow('fcl_handoff_quote_changed');
    expect(()=>f.workflow.startFclExecution(receiver,{...f.request,price:'12'},'execution-invalid-0003',f.execution)).toThrow();
    expect(()=>f.workflow.startFclExecution(other,f.request,'execution-invalid-0004',f.execution)).toThrow('fcl_not_found');
    f.workflow.startFclExecution(receiver,f.request,'execution-valid-0001',f.execution);
    expect(()=>f.execution.get(other,{case_ref:f.confirmed.case_id})).toThrow('fcl_not_found');
    expect(()=>f.workflow.startFclExecution(receiver,{...f.request,confirmation:{...f.request.confirmation,note:'Different body'}},'execution-valid-0001',f.execution)).toThrow('idempotency_conflict');
  }finally{closeFixture(f);}
});

it('keeps accepted execution and independent updates after source expiry or replacement',async()=>{
  const f=await setup();try{
    const first=f.workflow.startFclExecution(receiver,f.request,'execution-independent-01',f.execution);
    f.setClock('2026-10-20T12:00:00.000Z');
    const next=rates();next.rates[0]!.items[0]!.ocean_freight='4000';
    f.rateService.save(receiver,'fcl',{expected_version:2,input:next},'execution-rate-change-01');
    const updated=f.execution.saveShared(receiver,{contract_version:FCL_EXECUTION_VERSION,case_ref:f.confirmed.case_id,expected_version:first.version,shared:{containers:[{container_number:'SYNTHETIC01',seal_number:'SEAL1'}],hbl:'HBL1',mbl:null,eta:'2026-11-01T12:00:00-08:00'}},'execution-shared-0001');
    expect(updated.version).toBe(2);
    expect('acceptances' in updated&&updated.acceptances).toEqual(first.acceptances);
    expect(f.caseService.getFclCase(receiver,f.confirmed.case_id).case_version).toBe(f.confirmed.case_version);
    expect(f.workflow.startFclExecution(receiver,f.request,'execution-independent-02',f.execution).version).toBe(2);
  }finally{closeFixture(f);}
});

it('maps formal included/free services, blocks pending scope, and never requires a booking for destination-only work',async()=>{
  const f=await setup();try{
    const p=f.workflow.startFclExecution(receiver,f.request,'scope-execution-0001',f.execution),handoff=p.acceptances[0]!.handoff,configuration=emptyFclNotificationConfig();
    const document={...f.approved,customer_scope:[{service:'delivery' as const,disposition:'free' as const,note:'Included for customer',included_row_refs:[]},{service:'canada_customs' as const,disposition:'included' as const,note:'Included',included_row_refs:[]},{service:'ocean_freight' as const,disposition:'out_of_scope' as const,note:null,included_row_refs:[]}]};
    expect(f.execution.buildNodes({handoff,document},configuration).map(n=>n.node_id)).toEqual(['canada_customs','delivery']);
    expect(()=>f.execution.buildNodes({handoff,document:{...document,customer_scope:[{...document.customer_scope[0]!,disposition:'pending'}]}},configuration)).toThrow('scope_needs_input');
  }finally{closeFixture(f);}
});

it('recovers an ambiguous post-COMMIT response and enforces uniqueness across independent connections',async()=>{
  const f=await setup();try{
    const exec=f.caseStore.db.exec.bind(f.caseStore.db);let fault=true;
    const spy=vi.spyOn(f.caseStore.db,'exec').mockImplementation(sql=>{exec(sql);if(sql==='COMMIT'&&fault){fault=false;throw new Error('fixture_post_commit_response_lost');}});
    expect(()=>f.workflow.startFclExecution(receiver,f.request,'recovery-execution-01',f.execution)).toThrow();spy.mockRestore();
    const recovered=f.workflow.startFclExecution(receiver,f.request,'recovery-execution-01',f.execution);
    const second=new CaseStore(f.caseStore.path,{fcl:{mode:'reopen'},execution:{mode:'reopen'}});
    try{
      expect(second.db.prepare('SELECT count(*) n FROM fcl_case_progress').get()).toEqual({n:1});
      expect(()=>second.db.prepare('INSERT INTO fcl_case_progress SELECT * FROM fcl_case_progress WHERE case_id=?').run(recovered.case_ref)).toThrow(/UNIQUE/);
    }finally{second.close();}
    expect(f.workflow.startFclExecution(receiver,f.request,'recovery-execution-02',f.execution).case_ref).toBe(recovered.case_ref);
  }finally{closeFixture(f);}
});

it('requires new approved evidence for commercial amendments and retains old acceptance and finished nodes',async()=>{
  const f=await setup();try{
    const first=f.workflow.startFclExecution(receiver,f.request,'amend-original-0001',f.execution);
    const skipped=f.execution.nodeAction(receiver,'skip',{contract_version:FCL_EXECUTION_VERSION,case_ref:first.case_ref,expected_version:1,node_id:'booking',reason:'External booking supplied',confirmed:true},'amend-skip-booking');
    const nextQuote=f.workflow.saveFclQuote(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:f.quote.quote_ref,expected_version:1,source_binding:{mode:'retain'},input:{source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3700',customer_note:'Reconfirmed ocean price'}],manual_fees:[],service_scopes:[],exchange_rates:{USD:null,CAD:null},remark:null}},'amend-quote-0001');
    const nextDoc=f.workflow.saveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'re_quote',document_id:f.doc.document_id,expected_document_version:f.approved.version,quote_ref:nextQuote.quote_ref,expected_quote_version:nextQuote.version,expected_quote_digest:nextQuote.content_digest,expected_case_version:f.confirmed.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-RECONFIRMED',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:null},'amend-document-0001');
    const review=f.workflow.reviewFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:nextDoc.document_id,expected_version:nextDoc.version});
    const approved=f.workflow.approveFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:nextDoc.document_id,expected_version:nextDoc.version,review_hash:review.review_hash,confirmed:true},'amend-approve-0001');
    const formal=await f.workflow.exportFclDocument(receiver,{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,mode:'formal',document_id:approved.document_id,expected_version:approved.version},'amend-export-0001');
    const amendment={...f.request,handoff:{...f.request.handoff,expected_quote_version:nextQuote.version,expected_quote_digest:nextQuote.content_digest,expected_document_version:approved.version,expected_pdf_sha256:formal.sha256},expected_version:skipped.version,reason:'Customer explicitly accepted revised price'};
    const updated=f.workflow.amendFclExecution(receiver,amendment,'amend-accepted-0001',f.execution);
    expect(updated.acceptances).toHaveLength(2);expect(updated.acceptances[0]).toEqual(first.acceptances[0]);
    expect(updated.nodes.find(n=>n.node_id==='booking')?.status).toBe('skipped');
    expect(f.workflow.amendFclExecution(receiver,amendment,'amend-accepted-0001',f.execution).version).toBe(updated.version);
    expect(f.caseService.getFclCase(receiver,first.case_ref).case_version).toBe(f.confirmed.case_version);
  }finally{closeFixture(f);}
});
