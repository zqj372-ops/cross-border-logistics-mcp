import {operationsFixture,estimateRequest,cosco} from '../quote-native/fixtures/fcl-operations';
import type {FclEstimateView} from '../../services/quote-native/fcl-operations-contracts';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {createFclInquiryDraft} from '../../apps/inquiry/fcl-model';
import {createPortalHttpHandler} from '../../services/access-gateway/portal/http';
import {FCL_HTTP_RESPONSE_LIMITS,FCL_RATE_RESPONSE_BYTES,fclHttpResponseSchemas,fclPublicOutputSchemas} from '../../services/access-gateway/portal/fcl-http-contracts';
import {FclHttpService} from '../../services/access-gateway/portal/fcl-http';
import {FixturePortalIdentityProvider} from '../../services/access-gateway/portal/identity';
import {InMemoryPortalSessionStore,PortalSessionManager} from '../../services/access-gateway/portal/session';
import {CaseService,CaseStore} from '../../services/access-gateway/portal/cases';
import {NativeAdminService,NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import {DocumentService,DocumentStore} from '../../services/quote-documents/service';
import {DocumentWorkflowService,DocumentWorkflowStore} from '../../services/quote-documents/workflow';
import {FclQuoteService} from '../../services/quote-native/fcl';
import {estimateToQuoteDraft} from '../../services/quote-native/fcl-operations';
import {FCL_QUOTE_WORKFLOW_VERSION,FCL_RATE_DATASET_VERSION,type FclRateDataset} from '../../services/quote-native/fcl-contracts';
import {FCL_DOCUMENT_WORKFLOW_VERSION} from '../../services/quote-documents/fcl-contracts';
import {createPortalFixtureRuntime} from '../../services/access-gateway/portal/fixture';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';
import {runWithVerifiedFclReceiver,type FclReceiverAuthority} from '../../services/access-gateway/portal/fcl-receiver-authority';

const receiverId='fixture-fcl-receiver';
const receiver:PortalContext={organizationId:null,identity:{userId:receiverId,displayName:'FCL receiver',email:'fcl-receiver@example.test',emailVerified:true,platformRole:null}};
const portal={getState:()=>({data:{current_organization:null,memberships:[]}})};
const fresh={fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}} as const;
const publicSecret='synthetic-public-session-secret-32-bytes';

function inquiry(){
  return {...createFclInquiryDraft(),origin_city:'Shenzhen',pol:'Yantian',pod:'Vancouver',final_destination:'Toronto',cargo_name:'Synthetic cargo',containers:[{type:'40HQ' as const,quantity:1}],cargo_type:'general' as const,estimated_weight:{value:'18000',unit:'kg' as const},cargo_ready_date:'2026-10-08',incoterm:'EXW' as const,selected_services:['ocean_freight'] as const,contact:{name:'Synthetic',company:null,email:'shipper@example.test',phone:null},notes:null,consent:true};
}

function rates():FclRateDataset{return {contract_version:FCL_RATE_DATASET_VERSION,label:'HTTP rates',rates:[{rate_id:'00000000-0000-4000-8000-000000000201',supplier_label:'Carrier',pol:'Yantian',pod:'Vancouver',valid_from:'2026-10-01',valid_until:'2026-10-15',source_ref:'synthetic:http-rate',source_version:'v1',note:null,items:[{container_type:'40HQ',ocean_freight:'3200',currency:'USD'}],additional_fees:[]}]};}
function largeRates():FclRateDataset{const base=rates().rates[0]!;return {contract_version:FCL_RATE_DATASET_VERSION,label:'Large HTTP rates',rates:Array.from({length:500},(_,index)=>({...base,rate_id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,source_ref:`synthetic:http-rate:${index}`,note:'x'.repeat(500)}))};}

async function staffSession(f:Pick<Awaited<ReturnType<typeof fclHttpFixture>>,'origin'>){
  const anonymous=await fetch(f.origin+'/console/api/v1/session'),anonymousBody=await anonymous.json() as {csrf_token:string};
  const logged=await fetch(f.origin+'/console/api/v1/fixture-login',{method:'POST',headers:{cookie:anonymous.headers.get('set-cookie')!.split(';')[0]!,origin:f.origin,'x-csrf-token':anonymousBody.csrf_token,'idempotency-key':'fcl-http-staff-login-0001','content-type':'application/json'},body:JSON.stringify({identity_id:receiverId})});
  if(logged.status!==200)throw new Error(`fcl_http_staff_login_${logged.status}`);
  const body=await logged.json() as {csrf_token:string};
  return {cookie:logged.headers.get('set-cookie')!.split(';')[0]!,csrf:body.csrf_token};
}

async function fclHttpFixture(authority?:FclReceiverAuthority,options:{portal?:typeof portal}={}){
  const root=mkdtempSync(join(tmpdir(),'fcl-http-red-')),caseStore=new CaseStore(join(root,'cases.sqlite'),fresh),rateStore=new NativeAdminStore(join(root,'rates.sqlite'),fresh),documentStore=new DocumentStore(join(root,'documents.sqlite'),fresh),workflowStore=new DocumentWorkflowStore(documentStore,fresh);
  const portalService=options.portal??portal;
  const caseService=new CaseService(caseStore,portalService as never,{receiverUserId:receiverId,receiverIsActive:()=>true,credentialSecret:'synthetic-fcl-credential-secret-32-bytes',credentialTtlDays:30,now:()=> '2026-10-08T12:00:00.000Z',mail:{enabled:false}});
  const rateService=new NativeAdminService(rateStore,portalService as never,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=> '2026-10-08T12:00:00.000Z'});
  const quoteService=new FclQuoteService({caseReader:caseService,rateReader:rateService,now:()=> '2026-10-08T12:00:00.000Z'});
  const documentWorkflow=new DocumentWorkflowService(workflowStore,new DocumentService(documentStore,portalService as never),portalService as never,()=>Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120))),{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=> '2026-10-08T12:00:00.000Z'},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService,rateReader:rateService,handoff:caseService});
  const server=createServer((request,response)=>{void handler.handle(request,response);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const sessions=new PortalSessionManager({store:new InMemoryPortalSessionStore(),secureCookie:false,canSelectPersonal:identity=>{try{caseService.listFclCases({identity,organizationId:null},{limit:1,status:null,cursor:null});return true;}catch{return false;}}});
  const handler=createPortalHttpHandler({mode:'fixtures',service:portalService as never,caseService,nativeAdmin:rateService,documentWorkflowService:documentWorkflow,identityProvider:new FixturePortalIdentityProvider({mode:'fixtures',loopback:true}),sessions,allowedHosts:[new URL(origin).host],allowedOrigins:[origin],allowLoopbackHttp:true,fcl:{caseService,nativeAdmin:rateService,documentWorkflow,publicSessionSecret:publicSecret,businessDate:()=> '2026-10-08',secureCookie:false,...(authority?{receiverAuthority:authority}:{})}});
  return {root,server,origin,caseService,rateService,workflowStore,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));workflowStore.close();documentStore.close();rateStore.close();caseStore.close();rmSync(root,{recursive:true,force:true});}};
}

it('boots an anonymous FCL session and submits through real loopback HTTP',async()=>{
  const f=await fclHttpFixture();
  try{
    const boot=await fetch(f.origin+'/inquiry/api/v1/session');
    expect(boot.status).toBe(200);
    const bootBody=await boot.json() as {schema_version:string;data:{session:{csrf_token:string}}};
    expect(bootBody.schema_version).toBe('fcl-http@2026-09-21.v1');
    const cookie=boot.headers.get('set-cookie')!.split(';')[0]!;
    const submit=await fetch(f.origin+'/inquiry/api/v1/fcl/submit',{method:'POST',headers:{cookie,origin:f.origin,'x-csrf-token':bootBody.data.session.csrf_token,'idempotency-key':'fcl-http-submit-key-0001','content-type':'application/json'},body:JSON.stringify(inquiry())});
    const body=await submit.json() as {status:string;data:{case_id:string;notification:{status:string}};reason_codes:string[]};
    expect(submit.status).toBe(200);
    expect(body).toMatchObject({status:'success',data:{notification:{status:'disabled'}}});
    expect(f.caseService.getFclCase(receiver,body.data.case_id).case_version).toBe(1);
  }finally{await f.close();}
});

it('binds public cookies to one ticket and rejects cross-tab or credential-query misuse',async()=>{
  const f=await fclHttpFixture();
  try{
    expect((await fetch(f.origin+'/inquiry/api/v1/session',{headers:{cookie:'preference=light'}})).status).toBe(200);
    const boot=await fetch(f.origin+'/inquiry/api/v1/session'),bootBody=await boot.json() as {data:{session:{csrf_token:string}}},cookie=boot.headers.get('set-cookie')!.split(';')[0]!,csrf=bootBody.data.session.csrf_token;
    const submit=async(key:string)=>{const response=await fetch(f.origin+'/inquiry/api/v1/fcl/submit',{method:'POST',headers:{cookie,origin:f.origin,'x-csrf-token':csrf,'idempotency-key':key,'content-type':'application/json'},body:JSON.stringify(inquiry())});return (await response.json() as {data:{inquiry_id:string;case_id:string;credential:string}}).data;};
    const a=await submit('fcl-http-ticket-a-submit-01'),b=await submit('fcl-http-ticket-b-submit-01');
    f.caseService.updateFclCaseStatus(receiver,a.case_id,{expected_version:1,status:'needs_input',public_note:'Need input',internal_note:''},'fcl-http-ticket-a-status-01');
    const exchange=async(ticket:{inquiry_id:string;credential:string},key:string)=>{const response=await fetch(f.origin+'/inquiry/api/v1/fcl/credential/exchange',{method:'POST',headers:{cookie,origin:f.origin,'x-csrf-token':csrf,'idempotency-key':key,'content-type':'application/json'},body:JSON.stringify({inquiry_id:ticket.inquiry_id,credential:ticket.credential})});return response;};
    const missingKey=await fetch(f.origin+'/inquiry/api/v1/fcl/credential/exchange',{method:'POST',headers:{cookie,origin:f.origin,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({inquiry_id:a.inquiry_id,credential:a.credential})});expect(missingKey.status).toBe(400);expect((await missingKey.json() as {reason_codes:string[]}).reason_codes).toEqual(['idempotency_key_invalid']);
    expect((await exchange(a,'short')).status).toBe(400);
    const aExchange=await exchange(a,'fcl-http-ticket-a-exchange-01');expect(aExchange.status).toBe(200);const acookie=aExchange.headers.get('set-cookie')!.split(';')[0]!;
    const supplied=await fetch(f.origin+'/inquiry/api/v1/fcl/supplement',{method:'POST',headers:{cookie:acookie,origin:f.origin,'x-csrf-token':csrf,'idempotency-key':'fcl-http-ticket-a-supplement-01','content-type':'application/json'},body:JSON.stringify({inquiry_id:a.inquiry_id,expected_version:2,fields:{changes:[{field:'pod',value:'Vancouver'}]},message:'Customer supplied POD'})});expect(supplied.status).toBe(200);expect((await supplied.json() as {data:{case_version:number}}).data.case_version).toBe(3);
    expect((await fetch(`${f.origin}/inquiry/api/v1/fcl?inquiry_id=${a.inquiry_id}`,{headers:{cookie:acookie}})).status).toBe(200);
    const bExchange=await exchange(b,'fcl-http-ticket-b-exchange-01');expect(bExchange.status).toBe(200);const bcookie=bExchange.headers.get('set-cookie')!.split(';')[0]!;
    const logoutMissing=await fetch(f.origin+'/inquiry/api/v1/logout',{method:'POST',headers:{cookie:acookie,origin:f.origin,'x-csrf-token':csrf,'content-type':'application/json'},body:'{}'});expect(logoutMissing.status).toBe(400);expect((await logoutMissing.json() as {reason_codes:string[]}).reason_codes).toEqual(['idempotency_key_invalid']);
    const mismatch=await fetch(`${f.origin}/inquiry/api/v1/fcl?inquiry_id=${a.inquiry_id}`,{headers:{cookie:bcookie}});expect(mismatch.status).toBe(403);expect((await mismatch.json() as {reason_codes:string[]}).reason_codes).toEqual(['fcl_ticket_mismatch']);
    const supplement=await fetch(f.origin+'/inquiry/api/v1/fcl/supplement',{method:'POST',headers:{cookie:bcookie,origin:f.origin,'x-csrf-token':csrf,'idempotency-key':'fcl-http-ticket-a-supplement-01','content-type':'application/json'},body:JSON.stringify({inquiry_id:a.inquiry_id,expected_version:2,fields:{changes:[]},message:'Mismatch'})});expect(supplement.status).toBe(403);expect((await supplement.json() as {reason_codes:string[]}).reason_codes).toEqual(['fcl_ticket_mismatch']);
    const own=await fetch(`${f.origin}/inquiry/api/v1/fcl?inquiry_id=${b.inquiry_id}`,{headers:{cookie:bcookie}});expect(own.status).toBe(200);
    expect((await fetch(`${f.origin}/inquiry/api/v1/fcl?credential=leak`,{headers:{cookie:bcookie}})).status).toBe(400);
    expect((await fetch(f.origin+'/inquiry/api/v1/session?credential=leak',{headers:{cookie:bcookie}})).status).toBe(400);
  }finally{await f.close();}
});

it('reports personal FCL capability from the exact receiver even after an organization context is selected',async()=>{
  const f=await fclHttpFixture();
  try{
    const anonymous=await fetch(f.origin+'/console/api/v1/session'),anonymousBody=await anonymous.json() as {csrf_token:string,cookie?:string};
    const logged=await fetch(f.origin+'/console/api/v1/fixture-login',{method:'POST',headers:{cookie:anonymous.headers.get('set-cookie')!.split(';')[0]!,origin:f.origin,'x-csrf-token':anonymousBody.csrf_token,'idempotency-key':'fcl-capability-login-0001','content-type':'application/json'},body:JSON.stringify({identity_id:receiverId})});
    expect(logged.status).toBe(200);
    const loggedBody=await logged.json() as {csrf_token:string;fcl_capability?:{fcl_personal:boolean;receiver_user_id:string|null;business_date:string}};
    expect(loggedBody.fcl_capability).toEqual({fcl_personal:true,receiver_user_id:receiverId,business_date:'2026-10-08'});
    const personal=await fetch(f.origin+'/console/api/v1/session/organization',{method:'POST',headers:{cookie:logged.headers.get('set-cookie')!.split(';')[0]!,origin:f.origin,'x-csrf-token':loggedBody.csrf_token,'idempotency-key':'fcl-capability-personal-01','content-type':'application/json'},body:JSON.stringify({organization_id:null})});
    expect(personal.status).toBe(200);
  }finally{await f.close();}
});

it('switches from an organization back to personal only with a fresh receiver proof',async()=>{
  let calls=0;
  const proof={sub:receiverId,active:true as const,emailVerified:true as const};
  const authority:FclReceiverAuthority={runVerified:async operation=>{calls++;return runWithVerifiedFclReceiver(proof,()=>operation(proof));}};
  const portalService={getState:()=>({data:{current_organization:{organization_id:'org_fixture',status:'active'},organizations:[],memberships:[{userId:receiverId,organizationId:'org_fixture',status:'active',role:'owner'}],invitations:[]}})};
  const f=await fclHttpFixture(authority,{portal:portalService as never});
  try{
    const session=await staffSession(f);
    const select=async(organizationId:string|null,key:string,csrf:string)=>fetch(`${f.origin}/console/api/v1/session/organization`,{method:'POST',headers:{cookie:session.cookie,origin:f.origin,'x-csrf-token':csrf,'idempotency-key':key,'content-type':'application/json'},body:JSON.stringify({organization_id:organizationId})});
    const organization=await select('org_fixture','fcl-http-switch-org-0001',session.csrf);
    expect(organization.status).toBe(200);
    const organizationBody=await organization.json() as {csrf_token:string};
    expect(organizationBody).toMatchObject({organization_id:'org_fixture',fcl_capability:{fcl_personal:true,receiver_user_id:receiverId}});
    const blocked=await fetch(`${f.origin}/console/api/v1/fcl/case-list?limit=1`,{headers:{cookie:session.cookie}});
    expect(blocked.status).toBe(403);
    expect((await blocked.json() as {reason_codes:string[]}).reason_codes).toEqual(['fcl_not_found']);
    const personal=await select(null,'fcl-http-switch-personal-01',organizationBody.csrf_token);
    const personalBody=await personal.json() as {organization_id:string|null;fcl_capability:{fcl_personal:boolean;receiver_user_id:string|null}};
    expect(personal.status,JSON.stringify(personalBody)).toBe(200);
    expect(personalBody).toMatchObject({organization_id:null,fcl_capability:{fcl_personal:true,receiver_user_id:receiverId}});
    expect((await fetch(`${f.origin}/console/api/v1/fcl/case-list?limit=1`,{headers:{cookie:session.cookie}})).status).toBe(200);
    expect(calls).toBeGreaterThanOrEqual(4);
  }finally{await f.close();}
});

it('runs the staff Quote, document, PDF, and handoff chain over real HTTP',async()=>{
  const f=await fclHttpFixture();
  try{
    const session=await staffSession(f),call=(action:string,payload:unknown,key:string)=>fetch(`${f.origin}/console/api/v1/fcl/${action}`,{method:'POST',headers:{cookie:session.cookie,origin:f.origin,'x-csrf-token':session.csrf,'idempotency-key':key,'content-type':'application/json'},body:JSON.stringify(payload)});
    expect((await fetch(f.origin+'/console/api/v1/fcl/case-list?limit=1',{headers:{cookie:session.cookie}})).status).toBe(200);
    const rateSave=await call('rate-save',{expected_version:0,input:rates()},'fcl-http-flow-rate-save-01');
    expect(rateSave.status).toBe(200);
    const preview=await fetch(f.origin+'/console/api/v1/fcl/rate-preview',{headers:{cookie:session.cookie}});expect(preview.status).toBe(200);
    const previewBody=await preview.json() as {data:{preview_hash:string}};
    const publish=await call('rate-publish',{expected_version:1,preview_hash:previewBody.data.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-http-flow-rate-publish-01');expect(publish.status).toBe(200);
    const config=await call('issuer-config-save',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,expected_version:0,input:{issuer_name:'Issuer',issuer_address:'Address',issuer_phone:'',issuer_email:'',terms:'Terms',standard_fee_template_v1:null},confirmed:true},'fcl-http-flow-config-0001');expect(config.status).toBe(200);
    const submission=await f.caseService.submitFclInquiry('fcl-http-flow-case-session','fcl-http-flow-case-submit-01',inquiry());
    const confirmed=await call('case-confirm',{case_id:submission.case_id,expected_version:submission.case_version,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'Confirmed'},'fcl-http-flow-case-confirm-01');expect(confirmed.status).toBe(200);
    const confirmedBody=await confirmed.json() as {data:{case_version:number}};
    const match=await call('quote-match',{contract_version:FCL_QUOTE_WORKFLOW_VERSION,case_ref:submission.case_id,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null,selected_rate_id:(rates().rates[0]!).rate_id},'fcl-http-flow-match-0001');expect(match.status).toBe(200);
    const matchBody=await match.json() as {status:string;data:{selected:{rate_id:string}}};
    expect(matchBody.status).toBe('success');
    const rateGet=await fetch(f.origin+'/console/api/v1/fcl/rate-get',{headers:{cookie:session.cookie}}),rateGetBody=await rateGet.json() as {data:{active_release:{release_id:string;version:number;digest:string}}},active=rateGetBody.data.active_release;
    const quote=await call('quote-save',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',case_ref:submission.case_id,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null,selected_rate_id:matchBody.data.selected.rate_id,expected_release_id:active.release_id,expected_release_version:active.version,expected_dataset_digest:active.digest,input:{source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],manual_fees:[],service_scopes:[],exchange_rates:{USD:null,CAD:null},remark:null}},'fcl-http-flow-quote-0001');
    expect(quote.status).toBe(200);
    const quoteBody=await quote.json() as {data:{quote_ref:string;version:number;content_digest:string}};
    const doc=await call('document-save',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',quote_ref:quoteBody.data.quote_ref,expected_quote_version:quoteBody.data.version,expected_quote_digest:quoteBody.data.content_digest,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-HTTP-001',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:null},'fcl-http-flow-document-01');expect(doc.status).toBe(200);
    const docBody=await doc.json() as {data:{document_id:string;version:number}};
    const review=await call('document-review',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:docBody.data.document_id,expected_version:docBody.data.version},'fcl-http-flow-review-01');expect(review.status).toBe(200);
    const reviewBody=await review.json() as {data:{review_hash:string}};
    const approved=await call('document-approve',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:docBody.data.document_id,expected_version:docBody.data.version,review_hash:reviewBody.data.review_hash,confirmed:true},'fcl-http-flow-approve-01');expect(approved.status).toBe(200);
    const approvedBody=await approved.json() as {data:{version:number}};
    const exported=await call('document-export',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,mode:'formal',document_id:docBody.data.document_id,expected_version:approvedBody.data.version},'fcl-http-flow-export-01');expect(exported.status).toBe(200);
    const exportedBody=await exported.json() as {data:{sha256:string;revision_id:string}};
    const handoff=await call('handoff-save',{contract_version:'fcl-handoff@2026-09-21.v1',case_ref:submission.case_id,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null,quote_ref:quoteBody.data.quote_ref,expected_quote_version:quoteBody.data.version,expected_quote_digest:quoteBody.data.content_digest,document_id:docBody.data.document_id,expected_document_version:approvedBody.data.version,expected_pdf_sha256:exportedBody.data.sha256,confirmed:true,note:'HTTP handoff'},'fcl-http-flow-handoff-01');expect(handoff.status).toBe(200);
    expect((await handoff.json() as {data:{status:string}}).data.status).toBe('handed_off');
  }finally{await f.close();}
});

it('selects a calculated estimate with protected component validity through review, PDF and handoff',async()=>{
  const f=await fclHttpFixture();
  try{
    const session=await staffSession(f),call=(action:string,payload:unknown,key:string)=>fetch(`${f.origin}/console/api/v1/fcl/${action}`,{method:'POST',headers:{cookie:session.cookie,origin:f.origin,'x-csrf-token':session.csrf,'idempotency-key':key,'content-type':'application/json'},body:JSON.stringify(payload)});
    expect((await fetch(f.origin+'/console/api/v1/fcl/case-list?limit=1',{headers:{cookie:session.cookie}})).status).toBe(200);
    const rateSave=await call('rate-save',{expected_version:0,input:operationsFixture()},'fcl-http-flow-rate-save-01');
    expect(rateSave.status).toBe(200);
    const preview=await fetch(f.origin+'/console/api/v1/fcl/rate-preview',{headers:{cookie:session.cookie}});expect(preview.status).toBe(200);
    const previewBody=await preview.json() as {data:{preview_hash:string}};
    const publish=await call('rate-publish',{expected_version:1,preview_hash:previewBody.data.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-http-flow-rate-publish-01');expect(publish.status).toBe(200);
    const config=await call('issuer-config-save',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,expected_version:0,input:{issuer_name:'Issuer',issuer_address:'Address',issuer_phone:'',issuer_email:'',terms:'Terms',standard_fee_template_v1:null},confirmed:true},'fcl-http-flow-config-0001');expect(config.status).toBe(200);
    const submission=await f.caseService.submitFclInquiry('fcl-http-flow-case-session','fcl-http-flow-case-submit-01',{...inquiry(),pol:'Shanghai',final_destination:'Calgary',cargo_ready_date:'2026-09-28',selected_services:['ocean_freight','canada_customs','delivery']});
    const confirmed=await call('case-confirm',{case_id:submission.case_id,expected_version:submission.case_version,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'Confirmed'},'fcl-http-flow-case-confirm-01');expect(confirmed.status).toBe(200);
    const confirmedBody=await confirmed.json() as {data:{case_version:number}};
    const estimated=await call('estimate-run',{...estimateRequest(),case_ref:submission.case_id},'fcl-http-estimate-run-01');expect(estimated.status).toBe(200);
    const estimatedBody=await estimated.json() as {data:{items:FclEstimateView[]}};expect(estimatedBody.data.items).toHaveLength(3);
    const selected=estimatedBody.data.items.find(item=>item.calculation.rate_id===cosco)!;
    const quote=await call('estimate-select',{estimate_id:selected.estimate_id,expected_version:selected.version,case_ref:submission.case_id,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null},'fcl-http-estimate-select-01');
    const selectedResult=await quote.clone().json() as {data:{calculation:{unified_profit:unknown};extensions:{fcl_estimate_v1:{estimate_id:string}}}};expect(quote.status,JSON.stringify(selectedResult)).toBe(200);
    expect(selectedResult.data.calculation.unified_profit).toMatchObject({cost_subtotal:'30800.00',revenue_subtotal:'33880.00',gp_subtotal:'3080.00'});
    expect(selectedResult.data.extensions.fcl_estimate_v1.estimate_id).toBe(selected.estimate_id);
    const createdQuote=await quote.json() as {data:{quote_ref:string;version:number;content_digest:string}};
    const baseInput=estimateToQuoteDraft(selected),adjustedInput={...baseInput,extensions:{...baseInput.extensions,fcl_row_adjustments_v1:{changes:[{row_key:'ocean_freight:40HQ',operation:'override' as const,cost_price:'3250',sell_price:'3600',reason:'HTTP ticket-specific adjustment'}]}}};
    const updated=await call('quote-save',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:createdQuote.data.quote_ref,expected_version:createdQuote.data.version,source_binding:{mode:'retain'},input:adjustedInput},'fcl-http-estimate-quote-update-01');expect(updated.status).toBe(200);
    const quoteBody=await updated.json() as {data:{quote_ref:string;version:number;content_digest:string;extensions:{fcl_estimate_v1:{estimate_id:string};fcl_row_adjustments_v1:{changes:unknown[]}};cost_rows:Array<{row_key:string;cost_price:string|null;sell_price:string|null}>}};
    expect(quoteBody.data).toMatchObject({quote_ref:createdQuote.data.quote_ref,version:2,extensions:{fcl_estimate_v1:{estimate_id:selected.estimate_id},fcl_row_adjustments_v1:{changes:[expect.objectContaining({row_key:'ocean_freight:40HQ'})]}}});
    expect(quoteBody.data.cost_rows.find(row=>row.row_key==='ocean_freight:40HQ')).toMatchObject({cost_price:'3250',sell_price:'3600'});
    const excessive=await call('document-save',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',quote_ref:quoteBody.data.quote_ref,expected_quote_version:quoteBody.data.version,expected_quote_digest:quoteBody.data.content_digest,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-INVALID',quote_date:'2026-10-08',valid_until:'2027-01-01',remark:null},'fcl-http-invalid-validity-01');expect(excessive.status).not.toBe(200);
    const doc=await call('document-save',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',quote_ref:quoteBody.data.quote_ref,expected_quote_version:quoteBody.data.version,expected_quote_digest:quoteBody.data.content_digest,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-HTTP-001',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:null},'fcl-http-flow-document-01');expect(doc.status).toBe(200);
    const docBody=await doc.json() as {data:{document_id:string;version:number}};
    const review=await call('document-review',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:docBody.data.document_id,expected_version:docBody.data.version},'fcl-http-flow-review-01');expect(review.status).toBe(200);
    const reviewBody=await review.json() as {data:{review_hash:string}};
    const approved=await call('document-approve',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:docBody.data.document_id,expected_version:docBody.data.version,review_hash:reviewBody.data.review_hash,confirmed:true},'fcl-http-flow-approve-01');expect(approved.status).toBe(200);
    const approvedBody=await approved.json() as {data:{version:number}};
    const exported=await call('document-export',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,mode:'formal',document_id:docBody.data.document_id,expected_version:approvedBody.data.version},'fcl-http-flow-export-01');expect(exported.status).toBe(200);
    const exportedBody=await exported.json() as {data:{sha256:string;revision_id:string}};
    const handoff=await call('handoff-save',{contract_version:'fcl-handoff@2026-09-21.v1',case_ref:submission.case_id,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null,quote_ref:quoteBody.data.quote_ref,expected_quote_version:quoteBody.data.version,expected_quote_digest:quoteBody.data.content_digest,document_id:docBody.data.document_id,expected_document_version:approvedBody.data.version,expected_pdf_sha256:exportedBody.data.sha256,confirmed:true,note:'HTTP handoff'},'fcl-http-flow-handoff-01');expect(handoff.status).toBe(200);
    expect((await handoff.json() as {data:{status:string}}).data.status).toBe('handed_off');
    await call('estimate-adjust',{estimate_id:selected.estimate_id,expected_version:selected.version,reason:'New human price',locked:false,recommended:true,changes:[{line_id:'ocean_freight:40HQ',sell_price:'3900'}]},'fcl-http-estimate-adjust-01');
    const replay=await call('estimate-select',{estimate_id:selected.estimate_id,expected_version:selected.version,case_ref:submission.case_id,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null},'fcl-http-estimate-select-01');
    const replayBody=await replay.json() as {data:{quote_ref:string;currentness:{valid_now:boolean}}};expect(replay.status,JSON.stringify(replayBody)).toBe(200);expect(replayBody.data.quote_ref).toBe(quoteBody.data.quote_ref);expect(replayBody.data.currentness.valid_now).toBe(false);

  }finally{await f.close();}
});

it('preserves needs_input quote data and updates the same quote after price and FX completion',async()=>{
  const f=await fclHttpFixture();
  try{
    const session=await staffSession(f),call=(action:string,payload:unknown,key:string)=>fetch(`${f.origin}/console/api/v1/fcl/${action}`,{method:'POST',headers:{cookie:session.cookie,origin:f.origin,'x-csrf-token':session.csrf,'idempotency-key':key,'content-type':'application/json'},body:JSON.stringify(payload)});
    await call('rate-save',{expected_version:0,input:rates()},'fcl-http-partial-rate-save-01');
    const preview=await fetch(f.origin+'/console/api/v1/fcl/rate-preview',{headers:{cookie:session.cookie}}),previewBody=await preview.json() as {data:{preview_hash:string}};
    await call('rate-publish',{expected_version:1,preview_hash:previewBody.data.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-http-partial-rate-publish-01');
    const rateGet=await fetch(f.origin+'/console/api/v1/fcl/rate-get',{headers:{cookie:session.cookie}}),rateGetBody=await rateGet.json() as {data:{active_release:{release_id:string;version:number;digest:string}}},active=rateGetBody.data.active_release;
    const submission=await f.caseService.submitFclInquiry('fcl-http-partial-session','fcl-http-partial-submit-01',inquiry());
    const confirmed=await call('case-confirm',{case_id:submission.case_id,expected_version:submission.case_version,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'Confirmed'},'fcl-http-partial-confirm-01');
    const confirmedBody=await confirmed.json() as {data:{case_version:number}};
    const partial=await call('quote-save',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'create',case_ref:submission.case_id,expected_case_version:confirmedBody.data.case_version,expected_customer_supplement_ref:null,selected_rate_id:rates().rates[0]!.rate_id,expected_release_id:active.release_id,expected_release_version:active.version,expected_dataset_digest:active.digest,input:{source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:null,customer_note:null}],manual_fees:[],service_scopes:[],exchange_rates:{USD:null,CAD:null},remark:null}},'fcl-http-partial-quote-create-01');
    expect(partial.status).toBe(200);
    const partialBody=await partial.json() as {status:string;data:{quote_ref:string;version:number;current_version:number;completeness:{complete:boolean;missing_fields:string[]};calculation:{unified_profit:{missing_fx:string[]}}}};
    expect(partialBody.status).toBe('needs_input');
    expect(partialBody.data).toMatchObject({version:1,current_version:1,completeness:{complete:false}});
    expect(partialBody.data.calculation.unified_profit.missing_fx).toEqual(['USD']);
    expect(partialBody.data.completeness.missing_fields).toEqual(expect.arrayContaining(['/cost_rows/0/sell_price','/service_coverage/0']));

    const completed=await call('quote-save',{contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,operation:'update',quote_ref:partialBody.data.quote_ref,expected_version:partialBody.data.version,source_binding:{mode:'retain'},input:{source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:'Customer confirmed'}],manual_fees:[],service_scopes:[],exchange_rates:{USD:'7.2',CAD:null},remark:'Complete synthetic quote'}},'fcl-http-partial-quote-update-01');
    expect(completed.status).toBe(200);
    const completedBody=await completed.json() as {status:string;data:{quote_ref:string;version:number;current_version:number;completeness:{complete:boolean};calculation:{complete:boolean;unified_profit:{missing_fx:string[]}}}};
    expect(completedBody.status).toBe('success');
    expect(completedBody.data).toMatchObject({quote_ref:partialBody.data.quote_ref,version:2,current_version:2,completeness:{complete:true},calculation:{complete:true}});
    expect(completedBody.data.calculation.unified_profit.missing_fx).toEqual([]);
  }finally{await f.close();}
});

it('previews a selected historical release before creating a rollback publication',async()=>{
  const f=await fclHttpFixture();
  try{
    const session=await staffSession(f),call=(action:string,payload:unknown,key:string)=>fetch(`${f.origin}/console/api/v1/fcl/${action}`,{method:'POST',headers:{cookie:session.cookie,origin:f.origin,'x-csrf-token':session.csrf,'idempotency-key':key,'content-type':'application/json'},body:JSON.stringify(payload)});
    await call('rate-save',{expected_version:0,input:rates()},'fcl-http-rollback-rate-v1-save');
    const firstPreview=await fetch(f.origin+'/console/api/v1/fcl/rate-preview',{headers:{cookie:session.cookie}}),firstPreviewBody=await firstPreview.json() as {data:{preview_hash:string}};
    await call('rate-publish',{expected_version:1,preview_hash:firstPreviewBody.data.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-http-rollback-rate-v1-publish');
    const firstGet=await fetch(f.origin+'/console/api/v1/fcl/rate-get',{headers:{cookie:session.cookie}}),firstGetBody=await firstGet.json() as {data:{version:number;active_release:{release_id:string;version:number;digest:string}}},first=firstGetBody.data.active_release;
    const secondRates=rates();secondRates.label='HTTP rates v2';secondRates.rates[0]!.items[0]!.ocean_freight='3300';secondRates.rates[0]!.source_version='v2';
    await call('rate-save',{expected_version:firstGetBody.data.version,input:secondRates},'fcl-http-rollback-rate-v2-save');
    const secondPreview=await fetch(f.origin+'/console/api/v1/fcl/rate-preview',{headers:{cookie:session.cookie}}),secondPreviewBody=await secondPreview.json() as {data:{preview_hash:string}};
    await call('rate-publish',{expected_version:firstGetBody.data.version+1,preview_hash:secondPreviewBody.data.preview_hash,confirmation:'reviewed_sources_and_conditions'},'fcl-http-rollback-rate-v2-publish');
    const secondGet=await fetch(f.origin+'/console/api/v1/fcl/rate-get',{headers:{cookie:session.cookie}}),secondGetBody=await secondGet.json() as {data:{version:number}};
    const historicalPreview=await fetch(`${f.origin}/console/api/v1/fcl/rate-preview?release_id=${encodeURIComponent(first.release_id)}`,{headers:{cookie:session.cookie}});
    expect(historicalPreview.status).toBe(200);
    const historicalBody=await historicalPreview.json() as {status:string;data:{release_id:string;can_publish:boolean;input:{label:string};preview_hash:string}};
    expect(historicalBody).toMatchObject({status:'success',data:{release_id:first.release_id,can_publish:true,input:{label:'HTTP rates'}}});
    const isolatedHttp=new FclHttpService({caseService:f.caseService,nativeAdmin:f.rateService,documentWorkflow:{} as never,publicSessionSecret:publicSecret,businessDate:()=> '2026-10-08'});
    const otherPersonal={organizationId:null,identity:{userId:'fixture-other-personal',displayName:'Other personal',email:'other@example.test',emailVerified:true,platformRole:null}};
    const organizationContext={organizationId:'org_fixture',identity:receiver.identity};
    await expect(isolatedHttp.executeStaff(otherPersonal,'rate-preview',{release_id:first.release_id},()=> 'isolated-other-preview')).rejects.toThrow();
    await expect(isolatedHttp.executeStaff(organizationContext,'rate-preview',{release_id:first.release_id},()=> 'isolated-org-preview')).rejects.toThrow();
    const rollback=await call('rate-rollback',{expected_version:secondGetBody.data.version,preview_hash:historicalBody.data.preview_hash,confirmation:'reviewed_sources_and_conditions',release_id:first.release_id},'fcl-http-rollback-rate-create');
    expect(rollback.status).toBe(200);
    const rollbackBody=await rollback.json() as {status:string;data:{active_release:{input:{label:string;rates:Array<{items:Array<{ocean_freight:string}>}>}}}};
    expect(rollbackBody.status).toBe('success');
    expect(rollbackBody.data.active_release.input.label).toBe('HTTP rates');
    expect(rollbackBody.data.active_release.input.rates[0]!.items[0]!.ocean_freight).toBe('3200');
    expect((await fetch(`${f.origin}/console/api/v1/fcl/rate-preview?release_id=not-a-uuid`,{headers:{cookie:session.cookie}})).status).toBe(400);
    expect((await fetch(`${f.origin}/console/api/v1/fcl/rate-preview?release_id=${first.release_id}&release_id=${first.release_id}`,{headers:{cookie:session.cookie}})).status).toBe(400);
    expect((await fetch(`${f.origin}/console/api/v1/fcl/rate-preview?unknown=value`,{headers:{cookie:session.cookie}})).status).toBe(400);
  }finally{await f.close();}
});

it('uses the FCL envelope for unauthenticated, CSRF, origin, and unknown-route failures',async()=>{
  const f=await fclHttpFixture();
  try{
    const unauth=await fetch(f.origin+'/console/api/v1/fcl/case-list');expect(unauth.status).toBe(401);expect(await unauth.json()).toMatchObject({schema_version:'fcl-http@2026-09-21.v1',status:'blocked',data:null,reason_codes:['authentication_required']});
    const session=await staffSession(f);
    const csrf=await fetch(f.origin+'/console/api/v1/fcl/rate-save',{method:'POST',headers:{cookie:session.cookie,origin:f.origin,'x-csrf-token':'wrong','idempotency-key':'fcl-http-envelope-csrf-01','content-type':'application/json'},body:JSON.stringify({expected_version:0,input:rates()})});expect(csrf.status).toBe(403);expect((await csrf.json() as {schema_version:string;reason_codes:string[]}).schema_version).toBe('fcl-http@2026-09-21.v1');
    const origin=await fetch(f.origin+'/console/api/v1/fcl/rate-save',{method:'POST',headers:{cookie:session.cookie,origin:'https://evil.invalid','x-csrf-token':session.csrf,'idempotency-key':'fcl-http-envelope-origin-1','content-type':'application/json'},body:JSON.stringify({expected_version:0,input:rates()})});expect(origin.status).toBe(403);expect((await origin.json() as {schema_version:string;reason_codes:string[]}).schema_version).toBe('fcl-http@2026-09-21.v1');
    const unknown=await fetch(f.origin+'/console/api/v1/fcl/not-an-action',{headers:{cookie:session.cookie}});expect(unknown.status).toBe(404);expect(await unknown.json()).toMatchObject({schema_version:'fcl-http@2026-09-21.v1',status:'blocked',reason_codes:['route_not_found']});
  }finally{await f.close();}
});

it('accepts a bounded rate dataset larger than the default generic request limit',async()=>{
  const f=await fclHttpFixture();
  try{
    const session=await staffSession(f),payload=JSON.stringify({expected_version:0,input:largeRates()});
    expect(Buffer.byteLength(payload)).toBeGreaterThan(256*1024);
    const response=await fetch(f.origin+'/console/api/v1/fcl/rate-save',{method:'POST',headers:{cookie:session.cookie,origin:f.origin,'x-csrf-token':session.csrf,'idempotency-key':'fcl-http-large-rate-save-01','content-type':'application/json'},body:payload});
    expect(response.status).toBe(200);
    const oversized=await fetch(f.origin+'/console/api/v1/fcl/notification-save',{method:'POST',headers:{cookie:session.cookie,origin:f.origin,'x-csrf-token':session.csrf,'idempotency-key':'fcl-http-body-limit-0001','content-type':'application/json'},body:JSON.stringify({contract_version:'fcl-notification@2026-09-21.v1',expected_version:0,input:{enabled:false,recipient:null,cc:[]},padding:'x'.repeat(70*1024)})});
    expect(oversized.status).toBe(413);expect(await oversized.json()).toMatchObject({schema_version:'fcl-http@2026-09-21.v1',status:'needs_input',data:null,reason_codes:['body_too_large']});
  }finally{await f.close();}
});

it('persists notification settings without changing the independent FCL rate state',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-notification-red-')),rateStore=new NativeAdminStore(join(root,'rates.sqlite'),fresh);
  try{
    const rateService=new NativeAdminService(rateStore,portal as never,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=> '2026-10-08T12:00:00.000Z'});
    const saved=rateService.saveFclNotification(receiver,{contract_version:'fcl-notification@2026-09-21.v1',expected_version:0,input:{enabled:true,recipient:'ops@example.test',cc:['cc@example.test']},confirmed:true},'fcl-notification-save-0001');
    expect(saved).toMatchObject({version:1,input:{enabled:true,recipient:'ops@example.test'}});
    expect(rateService.get(receiver,'fcl')).toMatchObject({version:0,active_release:null});
  }finally{rateStore.close();rmSync(root,{recursive:true,force:true});}
});

it('keeps notification replay bound to the committed version and rolls back tampered evidence',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-notification-replay-')),store=new NativeAdminStore(join(root,'rates.sqlite'),fresh);
  try{
    const service=new NativeAdminService(store,portal as never,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>'2026-10-08T12:00:00.000Z'});
    const request={contract_version:'fcl-notification@2026-09-21.v1',expected_version:0,input:{enabled:true,recipient:'ops@example.test',cc:[]},confirmed:true as const};
    const first=service.saveFclNotification(receiver,request,'fcl-notification-replay-0001');
    expect(first).toMatchObject({version:1,replay:{replayed:false,submitted_version:null,current:true}});
    expect(service.saveFclNotification(receiver,request,'fcl-notification-replay-0001')).toMatchObject({version:1,replay:{replayed:true,submitted_version:1,current:true}});
    const second=service.saveFclNotification(receiver,{...request,expected_version:1,input:{...request.input,enabled:false,recipient:null}},'fcl-notification-replay-0002');
    expect(second).toMatchObject({version:2,replay:{replayed:false,current:true}});
    expect(service.saveFclNotification(receiver,request,'fcl-notification-replay-0001')).toMatchObject({version:2,input:{enabled:false,recipient:null},replay:{replayed:true,submitted_version:1,current:false}});
    store.db.prepare("UPDATE native_idempotency SET result='{}' WHERE key='fcl-notification-replay-0001'").run();
    expect(()=>service.saveFclNotification(receiver,request,'fcl-notification-replay-0001')).toThrow('native_readback_failed');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
  const tamperRoot=mkdtempSync(join(tmpdir(),'fcl-notification-tamper-')),tamperStore=new NativeAdminStore(join(tamperRoot,'rates.sqlite'),fresh);
  try{
    const service=new NativeAdminService(tamperStore,portal as never,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>'2026-10-08T12:00:00.000Z'});
    tamperStore.db.exec("CREATE TRIGGER fcl_notification_audit_tamper AFTER INSERT ON native_audit WHEN NEW.kind='fcl-notification' BEGIN UPDATE native_audit SET created='tampered' WHERE id=NEW.id; END;");
    expect(()=>service.saveFclNotification(receiver,{contract_version:'fcl-notification@2026-09-21.v1',expected_version:0,input:{enabled:true,recipient:'ops@example.test',cc:[]},confirmed:true},'fcl-notification-tamper-0001')).toThrow('native_readback_failed');
    expect(tamperStore.db.prepare("SELECT COUNT(*) AS n FROM native_configs WHERE kind='fcl-notification'").get()).toEqual({n:0});
    expect(tamperStore.db.prepare("SELECT COUNT(*) AS n FROM native_audit WHERE kind='fcl-notification'").get()).toEqual({n:0});
    expect(tamperStore.db.prepare("SELECT COUNT(*) AS n FROM native_idempotency WHERE key='fcl-notification-tamper-0001'").get()).toEqual({n:0});
  }finally{tamperStore.close();rmSync(tamperRoot,{recursive:true,force:true});}
});

it('starts an explicit zero-enterprise FCL personal fixture runtime',async()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-zero-enterprise-'));
  try{
    const runtime=await createPortalFixtureRuntime({databaseDirectory:root,nowSeconds:1_788_537_600,mode:'fcl-personal'});
    const state=runtime.service.getState(receiver).data!;
    expect(state.organizations).toEqual([]);
    expect(state.memberships).toEqual([]);
    await runtime.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

it('fails closed when the trusted receiver authority is false or throws',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-receiver-authority-')),store=new CaseStore(join(root,'cases.sqlite'),fresh);
  try{
    expect(()=>new CaseService(store,portal as never,{receiverUserId:receiverId,receiverIsActive:()=>false,credentialSecret:'synthetic-fcl-credential-secret-32-bytes',credentialTtlDays:30,mail:{enabled:false}})).toThrow('fcl_receiver_unavailable');
    expect(()=>new CaseService(store,portal as never,{receiverUserId:receiverId,receiverIsActive:()=>{throw new Error('authority_unavailable');},credentialSecret:'synthetic-fcl-credential-secret-32-bytes',credentialTtlDays:30,mail:{enabled:false}})).toThrow('fcl_receiver_unavailable');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('keeps success response data non-null while allowing domain evidence only on non-success',()=>{
  expect(fclPublicOutputSchemas.session.safeParse({schema_version:'fcl-http@2026-09-21.v1',status:'success',data:null,reason_codes:[]}).success).toBe(false);
  expect(fclHttpResponseSchemas['quote-match'].safeParse({schema_version:'fcl-http@2026-09-21.v1',status:'success',data:null,reason_codes:[]}).success).toBe(false);
  expect(fclHttpResponseSchemas['quote-match'].safeParse({schema_version:'fcl-http@2026-09-21.v1',status:'manual_review',data:null,reason_codes:['fcl_manual_review']}).success).toBe(true);
  expect(FCL_RATE_RESPONSE_BYTES).toBe(40*1024*1024);
  expect(FCL_HTTP_RESPONSE_LIMITS['rate-get']).toBeGreaterThan(2*16*1024*1024);
});

it('bounds public attempt keys and restores new keys after the window expires',()=>{
  let now=1_000;
  const service=new FclHttpService({caseService:{} as never,nativeAdmin:{} as never,documentWorkflow:{} as never,publicSessionSecret:publicSecret,businessDate:()=> '2026-10-08',publicAttemptLimit:1,publicAttemptWindowMs:1_000,publicAttemptKeyLimit:2,now:()=>now});
  expect(()=>service.consumePublicAttempt('a')).not.toThrow();
  expect(()=>service.consumePublicAttempt('b')).not.toThrow();
  expect(()=>service.consumePublicAttempt('c')).toThrow('fcl_rate_limited');
  now=2_001;
  expect(()=>service.consumePublicAttempt('c')).not.toThrow();
});

it('validates the public key closure inside exchange and logout service paths',async()=>{
  const service=new FclHttpService({caseService:{} as never,nativeAdmin:{} as never,documentWorkflow:{} as never,publicSessionSecret:publicSecret,businessDate:()=> '2026-10-08'});
  const cookie=service.publicSessions.ensure(null).setCookie.split(';')[0]!;
  const invalidKey=()=>{throw new Error('idempotency_key_invalid');};
  await expect(service.executePublic({} as never,'exchange',{},invalidKey,cookie)).rejects.toThrow('idempotency_key_invalid');
  await expect(service.executePublic({} as never,'logout',{},invalidKey,cookie)).rejects.toThrow('idempotency_key_invalid');
});

it('revalidates receiver authority for session capability and staff FCL requests, without blocking unrelated login',async()=>{
  let calls=0;
  const proof={sub:receiverId,active:true as const,emailVerified:true as const};
  const authority:FclReceiverAuthority={runVerified:async operation=>{calls++;return runWithVerifiedFclReceiver(proof,()=>operation(proof));}};
  const f=await fclHttpFixture(authority);
  try{
    const session=await staffSession(f),capability=await fetch(`${f.origin}/console/api/v1/session`,{headers:{cookie:session.cookie}});
    const body=await capability.json() as {fcl_capability:{fcl_personal:boolean;receiver_user_id:string|null}};
    expect(capability.status).toBe(200);expect(body.fcl_capability).toEqual({fcl_personal:true,receiver_user_id:receiverId,business_date:'2026-10-08'});
    const list=await fetch(`${f.origin}/console/api/v1/fcl/case-list?limit=1`,{headers:{cookie:session.cookie}});
    expect(list.status).toBe(200);expect(calls).toBeGreaterThanOrEqual(3);

    const denied=await fclHttpFixture({runVerified:()=>Promise.reject(new Error('fcl_receiver_authority_unavailable'))});
    try{
      const deniedSession=await staffSession(denied);
      const deniedCapability=await fetch(`${denied.origin}/console/api/v1/session`,{headers:{cookie:deniedSession.cookie}});
      expect(await deniedCapability.json()).toMatchObject({authenticated:true,fcl_capability:{fcl_personal:false,receiver_user_id:null}});
      const deniedList=await fetch(`${denied.origin}/console/api/v1/fcl/case-list?limit=1`,{headers:{cookie:deniedSession.cookie}});
      expect(deniedList.status).toBe(503);
      expect(await deniedList.json()).toMatchObject({schema_version:'fcl-http@2026-09-21.v1',status:'unavailable',reason_codes:['fcl_receiver_authority_unavailable']});
    }finally{await denied.close();}
  }finally{await f.close();}
});
