import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {createFclInquiryDraft} from '../../apps/inquiry/fcl-model';
import {createPortalHttpHandler} from '../../services/access-gateway/portal/http';
import {fclHttpResponseSchemas,fclPublicOutputSchemas} from '../../services/access-gateway/portal/fcl-http-contracts';
import {FixturePortalIdentityProvider} from '../../services/access-gateway/portal/identity';
import {InMemoryPortalSessionStore,PortalSessionManager} from '../../services/access-gateway/portal/session';
import {CaseService,CaseStore} from '../../services/access-gateway/portal/cases';
import {NativeAdminService,NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import {DocumentService,DocumentStore} from '../../services/quote-documents/service';
import {DocumentWorkflowService,DocumentWorkflowStore} from '../../services/quote-documents/workflow';
import {FclQuoteService} from '../../services/quote-native/fcl';
import {FCL_QUOTE_WORKFLOW_VERSION,FCL_RATE_DATASET_VERSION,type FclRateDataset} from '../../services/quote-native/fcl-contracts';
import {FCL_DOCUMENT_WORKFLOW_VERSION} from '../../services/quote-documents/fcl-contracts';
import {createPortalFixtureRuntime} from '../../services/access-gateway/portal/fixture';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';

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

async function fclHttpFixture(){
  const root=mkdtempSync(join(tmpdir(),'fcl-http-red-')),caseStore=new CaseStore(join(root,'cases.sqlite'),fresh),rateStore=new NativeAdminStore(join(root,'rates.sqlite'),fresh),documentStore=new DocumentStore(join(root,'documents.sqlite'),fresh),workflowStore=new DocumentWorkflowStore(documentStore,fresh);
  const caseService=new CaseService(caseStore,portal as never,{receiverUserId:receiverId,receiverIsActive:()=>true,credentialSecret:'synthetic-fcl-credential-secret-32-bytes',credentialTtlDays:30,now:()=> '2026-10-08T12:00:00.000Z',mail:{enabled:false}});
  const rateService=new NativeAdminService(rateStore,portal as never,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=> '2026-10-08T12:00:00.000Z'});
  const quoteService=new FclQuoteService({caseReader:caseService,rateReader:rateService,now:()=> '2026-10-08T12:00:00.000Z'});
  const documentWorkflow=new DocumentWorkflowService(workflowStore,new DocumentService(documentStore,portal as never),portal as never,()=>Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120))),{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=> '2026-10-08T12:00:00.000Z'},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService,rateReader:rateService,handoff:caseService});
  const server=createServer((request,response)=>{void handler.handle(request,response);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const sessions=new PortalSessionManager({store:new InMemoryPortalSessionStore(),secureCookie:false,canSelectPersonal:identity=>{try{caseService.listFclCases({identity,organizationId:null},{limit:1,status:null,cursor:null});return true;}catch{return false;}}});
  const handler=createPortalHttpHandler({mode:'fixtures',service:portal as never,caseService,nativeAdmin:rateService,documentWorkflowService:documentWorkflow,identityProvider:new FixturePortalIdentityProvider({mode:'fixtures',loopback:true}),sessions,allowedHosts:[new URL(origin).host],allowedOrigins:[origin],allowLoopbackHttp:true,fcl:{caseService,nativeAdmin:rateService,documentWorkflow,publicSessionSecret:publicSecret,businessDate:()=> '2026-10-08',secureCookie:false}});
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
    const aExchange=await exchange(a,'fcl-http-ticket-a-exchange-01');expect(aExchange.status).toBe(200);const acookie=aExchange.headers.get('set-cookie')!.split(';')[0]!;
    const supplied=await fetch(f.origin+'/inquiry/api/v1/fcl/supplement',{method:'POST',headers:{cookie:acookie,origin:f.origin,'x-csrf-token':csrf,'idempotency-key':'fcl-http-ticket-a-supplement-01','content-type':'application/json'},body:JSON.stringify({inquiry_id:a.inquiry_id,expected_version:2,fields:{changes:[{field:'pod',value:'Vancouver'}]},message:'Customer supplied POD'})});expect(supplied.status).toBe(200);expect((await supplied.json() as {data:{case_version:number}}).data.case_version).toBe(3);
    expect((await fetch(`${f.origin}/inquiry/api/v1/fcl?inquiry_id=${a.inquiry_id}`,{headers:{cookie:acookie}})).status).toBe(200);
    const bExchange=await exchange(b,'fcl-http-ticket-b-exchange-01');expect(bExchange.status).toBe(200);const bcookie=bExchange.headers.get('set-cookie')!.split(';')[0]!;
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
});
