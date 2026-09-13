import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CaseService, CaseStore, type CaseView } from '../../services/access-gateway/portal/cases';
import type { PortalBusinessService } from '../../services/access-gateway/portal/business/service';
import type { PortalContext } from '../../services/access-gateway/portal/contracts';
import { DocumentService, DocumentStore } from '../../services/quote-documents/service';
import { INQUIRY_QUOTE_LINK_VERSION, V2_VERSION } from '../../services/quote-documents/contracts';
import { createNativeQuoteClient, type QuoteRelease } from '../../services/quote-native/client';
import { config as rates, request as quoteRequest } from '../quote-native/fixture';
import { sample, template } from '../quote-documents/fixtures';
import { createPortalHttpHandler } from '../../services/access-gateway/portal/http';
import { FixturePortalIdentityProvider } from '../../services/access-gateway/portal/identity';
import { InMemoryPortalSessionStore, PortalSessionManager } from '../../services/access-gateway/portal/session';
import { createDraft } from '../../apps/inquiry/model';

it('requires session, CSRF and exact query/body contracts and shares one persisted record through HTTP',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cases-http-')),store=new CaseStore(join(root,'cases.sqlite'));
 const portal={getState:()=>({data:{current_organization:null,memberships:[]}})};
 const server=createServer((req,res)=>{void handler.handle(req,res);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const handler=createPortalHttpHandler({mode:'fixtures',service:portal as never,caseService:new CaseService(store,portal as never),identityProvider:new FixturePortalIdentityProvider({mode:'fixtures',loopback:true}),sessions:new PortalSessionManager({store:new InMemoryPortalSessionStore(),secureCookie:false}),allowedHosts:[new URL(origin).host],allowedOrigins:[origin],allowLoopbackHttp:true});
 async function login(id:string){const response=await fetch(origin+'/console/api/v1/session');const anonymous=await response.json() as {csrf_token:string};const logged=await fetch(origin+'/console/api/v1/fixture-login',{method:'POST',headers:{cookie:response.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':anonymous.csrf_token,'idempotency-key':'fixture-login-case-key','content-type':'application/json'},body:JSON.stringify({identity_id:id})});expect(logged.status).toBe(200);const session=await logged.json() as {csrf_token:string};return {cookie:logged.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':session.csrf_token,'idempotency-key':'case-http-create-key','content-type':'application/json'};}
 try{
  expect((await fetch(origin+'/console/api/v1/cases')).status).toBe(401);
  const headers=await login('fixture-owner'),ops=await login('fixture-operator');
  const draft={...createDraft(),services:['ocean'],transportMode:'fcl',origin:'Shanghai',destination:'Vancouver',product:'Fixture cartons',containerType:'40HQ',containerCount:'1',contactName:'Fixture contact',email:'fixture@example.test',consent:true};
  const post=(path:string,payload:unknown,h:Record<string,string>=headers)=>fetch(origin+'/console/api/v1'+path,{method:'POST',headers:h,body:JSON.stringify(payload)});
  expect((await post('/cases',draft,{...headers,'x-csrf-token':'wrong'})).status).toBe(403);
  expect((await post('/cases',draft,{...headers,origin:'https://other.invalid'})).status).toBe(403);
  expect((await post('/cases',{...draft,owner_id:'forged'})).status).toBe(400);
  const response=await post('/cases',draft);expect(response.status).toBe(200);const created=(await response.json() as {data:CaseView}).data;
  expect(created.input.contactName).toBe('Fixture contact');
  expect((await (await post('/cases',draft)).json() as {data:CaseView}).data.case_id).toBe(created.case_id);
  expect((await fetch(origin+'/console/api/v1/cases?management=true',{headers})).status).toBe(403);
  expect((await fetch(origin+'/console/api/v1/cases?management=false&management=true',{headers:ops})).status).toBe(400);
  expect((await fetch(origin+'/console/api/v1/cases?unknown=true',{headers:ops})).status).toBe(400);
  const changed=await post(`/cases/${created.case_id}/update`,{expected_version:1,status:'needs_input',public_note:'请补充包装',internal_note:'内部资料'},ops);expect(changed.status).toBe(200);
  const detail=await fetch(origin+`/console/api/v1/cases/${created.case_id}`,{headers});const visible=await detail.json() as {data:CaseView};expect(visible.data.status).toBe('needs_input');expect(JSON.stringify(visible)).not.toContain('内部资料');
  expect(detail.headers.get('cache-control')).toBe('no-store');
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(root,{recursive:true,force:true});}
});

it('serves the linked quote chain and its counterexamples over loopback HTTP with precise v2 envelopes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'linked-http-')),documentStore=new DocumentStore(join(root,'documents.sqlite')),caseStore=new CaseStore(join(root,'cases.sqlite'));
 const ORGANIZATION='org_fixture',roles:Record<string,'owner'|'viewer'|null>={'fixture-owner':'owner','fixture-developer':'viewer','fixture-sales':'viewer','fixture-operator':null};
 const portal={getState:(context:{organizationId:string|null;identity:{userId:string}})=>({data:{current_organization:context.organizationId?{organizationId:context.organizationId,tenantId:'tenant_fixture',status:'active'}:null,memberships:roles[context.identity.userId]?[{organizationId:ORGANIZATION,userId:context.identity.userId,status:'active',role:roles[context.identity.userId]}]:[]}})};
 const caseService=new CaseService(caseStore,portal as never);
 const renderer=()=>Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120)));
 const release:QuoteRelease|null={version:1,release_id:'release_http',digest:'a'.repeat(64),input:rates,published_at:new Date().toISOString()};
 const client=createNativeQuoteClient(()=>release);
 const business={execute:async(_ctx:PortalContext,_tool:string,input:unknown,requestId:string)=>client.preview({input,requestId,actor:{type:'user',id:'fixture-owner'}})} as unknown as Pick<PortalBusinessService,'execute'>;
 const documentService=new DocumentService(documentStore,portal as never,renderer,{business,current:()=>release},caseService);
 const server=createServer((request,response)=>{void handler.handle(request,response);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const handler=createPortalHttpHandler({mode:'fixtures',service:portal as never,caseService,documentService,identityProvider:new FixturePortalIdentityProvider({mode:'fixtures',loopback:true}),sessions:new PortalSessionManager({store:new InMemoryPortalSessionStore(),secureCookie:false}),allowedHosts:[new URL(origin).host],allowedOrigins:[origin],allowLoopbackHttp:true});
 async function loginSession(id:string){const response=await fetch(origin+'/console/api/v1/session');const anonymous=await response.json() as {csrf_token:string};const logged=await fetch(origin+'/console/api/v1/fixture-login',{method:'POST',headers:{cookie:response.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':anonymous.csrf_token,'idempotency-key':`fixture-login-${id}-key`,'content-type':'application/json'},body:JSON.stringify({identity_id:id})});expect(logged.status).toBe(200);const session=await logged.json() as {csrf_token:string};return {cookie:logged.headers.get('set-cookie')!.split(';')[0]!,csrf:session.csrf_token};}
 async function selectOrganization(session:{cookie:string;csrf:string}){const selected=await fetch(origin+'/console/api/v1/session/organization',{method:'POST',headers:{cookie:session.cookie,origin,'x-csrf-token':session.csrf,'idempotency-key':'fixture-select-org-0001','content-type':'application/json'},body:JSON.stringify({organization_id:ORGANIZATION})});expect(selected.status).toBe(200);const body=await selected.json() as {csrf_token:string};return {cookie:selected.headers.get('set-cookie')?.split(';')[0]??session.cookie,csrf:body.csrf_token};}
 function call(session:{cookie:string;csrf:string},path:string,payload?:unknown,key?:string){return fetch(origin+'/console/api/v1'+path,{method:'POST',headers:{cookie:session.cookie,origin,'x-csrf-token':session.csrf,'idempotency-key':key??'linked-http-request-key-0001','content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});}
 try{
  const owner=await selectOrganization(await loginSession('fixture-owner')),
   platform=await loginSession('fixture-operator'),sales=await selectOrganization(await loginSession('fixture-sales'));
  const linkedPath=(action:string)=>`/quote-documents/${action}`;
  const configured=await call(owner,linkedPath('config-save'),{expected_version:0,input:template,confirmed:true},'linked-http-config-0001');
  expect(configured.status).toBe(200);
  expect((await configured.json() as {schema_version:string}).schema_version).toBe('quote-documents@2026-09-08.v1');
  const draft={...createDraft(),services:['ocean'],transportMode:'fcl',origin:'Shanghai',destination:'Toronto M5X 1A9',product:'Synthetic linked HTTP cargo',containerType:'40HQ',containerCount:'1',contactName:'Synthetic HTTP owner',email:'http@example.test',consent:true};
  const created=await (await call(owner,'/cases',draft,'linked-http-case-0001')).json() as {data:CaseView},caseId=created.data.case_id;
  const customer={quote_no:'QA-HTTP-001',customer_name:'Synthetic HTTP owner',quote_date:new Date().toISOString().slice(0,10),valid_until:rates.valid_until,job_no:'',so_no:'',container_no:'',remark:''};
  const prepared=await call(owner,linkedPath('native-prepare'),{contract_version:INQUIRY_QUOTE_LINK_VERSION,case_ref:caseId,expected_customer_event_ref:null,request:quoteRequest,customer},'linked-http-prepare-0001');
  expect(prepared.status).toBe(200);
  const preparedBody=await prepared.json() as {schema_version:string;status:string;data:{input:unknown;template_version:number;preview_hash:string;preview_expires_at:number;native_quote_v1:unknown;inquiry_case_link_v1:{case_ref:string};totals:{by_currency:Record<string,string>}}};
  expect(preparedBody.schema_version).toBe(V2_VERSION);
  expect(preparedBody.data.inquiry_case_link_v1.case_ref).toBe(caseId);
  expect(preparedBody.data.totals.by_currency.USD).toBeTruthy();
  const savePayload={contract_version:INQUIRY_QUOTE_LINK_VERSION,input:preparedBody.data.input,template_version:preparedBody.data.template_version,preview_hash:preparedBody.data.preview_hash,preview_expires_at:preparedBody.data.preview_expires_at,native_quote_v1:preparedBody.data.native_quote_v1,inquiry_case_link_v1:preparedBody.data.inquiry_case_link_v1,confirmed:true};
  const saved=await call(owner,linkedPath('save'),savePayload,'linked-http-save-0001');
  expect(saved.status).toBe(200);
  const savedBody=await saved.json() as {schema_version:string;status:string;data:{id:string;version:number;state:string;inquiry_case_link_v1:{case_ref:string}}};
  expect(savedBody.data.state).toBe('draft');
  expect(savedBody.data.inquiry_case_link_v1.case_ref).toBe(caseId);
  const documentId=savedBody.data.id;
  const approval={contract_version:INQUIRY_QUOTE_LINK_VERSION,id:documentId,expected_version:1,evidence_ref:'review:http',evidence_version:'1',review_notes:'HTTP review',confirmation:'human_verified_price_and_source'};
  const approved=await call(owner,linkedPath('approve'),approval,'linked-http-approve-0001');
  expect(approved.status).toBe(200);
  expect((await approved.json() as {data:{state:string;version:number}}).data).toMatchObject({state:'approved',version:2});
  const replay=await call(owner,linkedPath('save'),savePayload,'linked-http-save-0001');
  expect(replay.status).toBe(200);
  const replayBody=await replay.json() as {status:string;data:{id:string;version:number;current_version:number;current_state:string;committed:boolean;replay:boolean;historical:boolean};reason_codes:string[]};
  expect(replayBody).toMatchObject({status:'manual_review',reason_codes:['inquiry_quote_replay_not_current']});
  expect(replayBody.data).toMatchObject({id:documentId,version:1,current_version:2,current_state:'approved',committed:true,replay:true,historical:true});
  const formal=await call(owner,linkedPath('export'),{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:documentId,mode:'formal'},'linked-http-export-0001');
  expect(formal.status).toBe(200);
  const formalBody=await formal.json() as {status:string;reason_codes:string[];data:{draft:boolean;historical:boolean;valid_now:boolean;sha256:string;byte_length:number;content_base64:string;inquiry_case_link_v1:{case_ref:string}}};
  expect(formalBody).toMatchObject({status:'success',reason_codes:[]});
  expect(formalBody.data).toMatchObject({draft:false,historical:false,valid_now:true,inquiry_case_link_v1:{case_ref:caseId}});
  expect(createHash('sha256').update(Buffer.from(formalBody.data.content_base64,'base64')).digest('hex')).toBe(formalBody.data.sha256);
  const history=await call(owner,linkedPath('export'),{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:documentId,mode:'history'},'linked-http-export-0002');
  expect(history.status).toBe(200);
  const historyBody=await history.json() as {status:string;reason_codes:string[];data:{historical:boolean;valid_now:boolean;sha256:string}};
  expect(historyBody).toMatchObject({status:'success',reason_codes:['inquiry_quote_history_only']});
  expect(historyBody.data).toMatchObject({historical:true,valid_now:false,sha256:formalBody.data.sha256});
  const read=await call(owner,linkedPath('get'),{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:documentId});
  expect(read.status).toBe(200);
  expect((await read.json() as {data:{state:string;inquiry_case_link_v1:{case_ref:string}}}).data).toMatchObject({state:'approved',inquiry_case_link_v1:{case_ref:caseId}});
  const listed=await call(owner,linkedPath('list'),{contract_version:INQUIRY_QUOTE_LINK_VERSION,limit:10});
  expect(listed.status).toBe(200);
  const listedBody=await listed.json() as {data:{items:{id:string;inquiry_case_link_v1?:{case_ref:string}}[];next_cursor:number|null}};
  expect(listedBody.data.next_cursor).toBeNull();
  expect(listedBody.data.items.find(item=>item.id===documentId)?.inquiry_case_link_v1?.case_ref).toBe(caseId);
  const v1Listed=await call(owner,linkedPath('list'),{limit:10});
  expect(v1Listed.status).toBe(200);
  const v1ListedBody=await v1Listed.json() as {schema_version:string;data:{items:unknown[];next_cursor:null}};
  expect(v1ListedBody.schema_version).toBe('quote-documents@2026-09-08.v1');
  expect(v1ListedBody.data).toEqual({items:[],next_cursor:null});
  const v1Blocked=await call(owner,linkedPath('get'),{id:documentId});
  expect(v1Blocked.status).toBe(409);
  expect((await v1Blocked.json() as {status:string;reason_codes:string[]}).reason_codes).toEqual(['document_contract_version_required']);
  const v1Approve=await call(owner,linkedPath('approve'),{id:documentId,expected_version:2,evidence_ref:'review:v1',evidence_version:'1',review_notes:'v1 attempt',confirmation:'human_verified_price_and_source'},'linked-http-approve-v1-1');
  expect(v1Approve.status).toBe(409);
  expect((await call(owner,linkedPath('get'),{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:documentId})).status).toBe(200);
  const forged=await call(owner,linkedPath('save'),{...savePayload,preview_hash:'0'.repeat(64)},'linked-http-save-forged');
  expect(forged.status).toBe(403);
  expect((await forged.json() as {status:string;reason_codes:string[]}).reason_codes).toEqual(['inquiry_quote_link_forgery']);
  const stripped=await call(owner,linkedPath('save'),{...savePayload,inquiry_case_link_v1:undefined},'linked-http-save-strip-1');
  expect(stripped.status).toBe(400);
  expect((await stripped.json() as {reason_codes:string[]}).reason_codes).toEqual(['inquiry_quote_link_input_invalid']);
  const scoped=await call(platform,linkedPath('get'),{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:documentId});
  expect(scoped.status).toBe(403);
  expect((await scoped.json() as {reason_codes:string[]}).reason_codes).toEqual(['inquiry_quote_document_scope_required']);
  const notVisible=await call(sales,linkedPath('get'),{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:documentId});
  expect(notVisible.status).toBe(404);
  expect((await notVisible.json() as {reason_codes:string[]}).reason_codes).toEqual(['document_not_found']);
  expect((await call(owner,linkedPath('get'),{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:documentId})).status).toBe(200);
  const caseV2=await fetch(`${origin}/console/api/v1/cases/${caseId}?contract_version=${INQUIRY_QUOTE_LINK_VERSION}`,{headers:{cookie:owner.cookie}});
  expect(caseV2.status).toBe(200);
  const caseV2Body=await caseV2.json() as {schema_version:string;data:{review_context:{latest_customer_supplement_ref:string|null}}};
  expect(caseV2Body.schema_version).toBe('portal-cases@2026-09-13.v2');
  expect(caseV2Body.data.review_context.latest_customer_supplement_ref).toBeNull();
  const caseV1=await fetch(`${origin}/console/api/v1/cases/${caseId}`,{headers:{cookie:owner.cookie}});
  expect(caseV1.status).toBe(200);
  expect((await caseV1.json() as {schema_version:string}).schema_version).toBe('portal-cases@2026-09-07.v1');
  const responseVersionAsRequest=await fetch(`${origin}/console/api/v1/cases/${caseId}?contract_version=portal-cases@2026-09-13.v2`,{headers:{cookie:owner.cookie}});
  expect(responseVersionAsRequest.status).toBe(400);
  expect((await responseVersionAsRequest.json() as {reason_codes:string[]}).reason_codes).toEqual(['case_input_invalid']);
  expect((await fetch(`${origin}/console/api/v1/cases/${caseId}?contract_version=${INQUIRY_QUOTE_LINK_VERSION}&contract_version=${INQUIRY_QUOTE_LINK_VERSION}`,{headers:{cookie:owner.cookie}})).status).toBe(400);
  expect((await fetch(`${origin}/console/api/v1/cases/${caseId}?contract_version=portal-cases@2099-01-01.v9`,{headers:{cookie:owner.cookie}})).status).toBe(400);
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));documentStore.close();caseStore.close();rmSync(root,{recursive:true,force:true});}
});

async function linkedHttpFixture(){
 const root=mkdtempSync(join(tmpdir(),'linked-http2-')),documentStore=new DocumentStore(join(root,'documents.sqlite')),caseStore=new CaseStore(join(root,'cases.sqlite'));
 const ORGANIZATION='org_fixture',roles:Record<string,'owner'|'viewer'|null>={'fixture-owner':'owner','fixture-sales':'viewer','fixture-operator':null};
 const portal={getState:(context:{organizationId:string|null;identity:{userId:string}})=>({data:{current_organization:context.organizationId?{organizationId:context.organizationId,tenantId:'tenant_fixture',status:'active'}:null,memberships:roles[context.identity.userId]?[{organizationId:ORGANIZATION,userId:context.identity.userId,status:'active',role:roles[context.identity.userId]}]:[]}})};
 const caseService=new CaseService(caseStore,portal as never);
 let renderHook:(()=>void)|undefined,rendererFails=false;
 const renderer=()=>{renderCount++;renderHook?.();return rendererFails?Promise.reject(new Error('synthetic renderer failure')):Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120)));};
 const release:QuoteRelease|null={version:1,release_id:'release_http2',digest:'a'.repeat(64),input:rates,published_at:new Date().toISOString()};
 const client=createNativeQuoteClient(()=>release);
 let businessCalls=0,renderCount=0;
 const business={execute:async(_ctx:PortalContext,_tool:string,input:unknown,requestId:string)=>{businessCalls++;return client.preview({input,requestId,actor:{type:'user',id:'fixture-owner'}});}} as unknown as Pick<PortalBusinessService,'execute'>;
 const documentService=new DocumentService(documentStore,portal as never,renderer,{business,current:()=>release},caseService);
 const server=createServer((request,response)=>{void handler.handle(request,response);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const handler=createPortalHttpHandler({mode:'fixtures',service:portal as never,caseService,documentService,identityProvider:new FixturePortalIdentityProvider({mode:'fixtures',loopback:true}),sessions:new PortalSessionManager({store:new InMemoryPortalSessionStore(),secureCookie:false}),allowedHosts:[new URL(origin).host],allowedOrigins:[origin],allowLoopbackHttp:true});
 async function login(id:string){const response=await fetch(origin+'/console/api/v1/session');const anonymous=await response.json() as {csrf_token:string};const logged=await fetch(origin+'/console/api/v1/fixture-login',{method:'POST',headers:{cookie:response.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':anonymous.csrf_token,'idempotency-key':`fixture-login-${id}-2`,'content-type':'application/json'},body:JSON.stringify({identity_id:id})});const session=await logged.json() as {csrf_token:string};const selected=await fetch(origin+'/console/api/v1/session/organization',{method:'POST',headers:{cookie:logged.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':session.csrf_token,'idempotency-key':`fixture-select-${id}-2`,'content-type':'application/json'},body:JSON.stringify({organization_id:ORGANIZATION})});expect(selected.status).toBe(200);const body=await selected.json() as {csrf_token:string};return {cookie:selected.headers.get('set-cookie')?.split(';')[0]??logged.headers.get('set-cookie')!.split(';')[0]!,csrf:body.csrf_token};}
 function call(session:{cookie:string;csrf:string},path:string,payload:unknown,key:string=randomUUID()){return fetch(origin+'/console/api/v1'+path,{method:'POST',headers:{cookie:session.cookie,origin,'x-csrf-token':session.csrf,'idempotency-key':key,'content-type':'application/json'},body:JSON.stringify(payload)});}
 const owner=await login('fixture-owner');
 expect((await call(owner,'/quote-documents/config-save',{expected_version:0,input:template,confirmed:true},'linked-http2-config-01')).status).toBe(200);
 const draft={...createDraft(),services:['ocean'],transportMode:'fcl',origin:'Shanghai',destination:'Toronto M5X 1A9',product:'Synthetic linked HTTP cargo',containerType:'40HQ',containerCount:'1',contactName:'Synthetic HTTP owner',email:'http@example.test',consent:true};
 const created=await (await call(owner,'/cases',draft,'linked-http2-case-0001')).json() as {data:CaseView};
 async function prepare(){
  const payload={contract_version:INQUIRY_QUOTE_LINK_VERSION,case_ref:created.data.case_id,expected_customer_event_ref:null,request:quoteRequest,customer:{quote_no:'QA-HTTP-002',customer_name:'Synthetic HTTP owner',quote_date:new Date().toISOString().slice(0,10),valid_until:rates.valid_until,job_no:'',so_no:'',container_no:'',remark:''}};
  const prepared=await call(owner,'/quote-documents/native-prepare',payload,randomUUID());
  const body=await prepared.json() as {status:string;data:{input:unknown;template_version:number;preview_hash:string;preview_expires_at:number;native_quote_v1:unknown;inquiry_case_link_v1:unknown}};
  expect(prepared.status).toBe(200);
  const savePayload={contract_version:INQUIRY_QUOTE_LINK_VERSION,input:body.data.input,template_version:body.data.template_version,preview_hash:body.data.preview_hash,preview_expires_at:body.data.preview_expires_at,native_quote_v1:body.data.native_quote_v1,inquiry_case_link_v1:body.data.inquiry_case_link_v1,confirmed:true};
  const saved=await call(owner,'/quote-documents/save',savePayload,randomUUID());
  const savedBody=await saved.json() as {status:string;data:{id:string;version:number;state:string}};
  expect(saved.status).toBe(200);
  const approval={contract_version:INQUIRY_QUOTE_LINK_VERSION,id:savedBody.data.id,expected_version:1,evidence_ref:'review:http',evidence_version:'1',review_notes:'HTTP review',confirmation:'human_verified_price_and_source'};
  return {savePayload,saved:savedBody.data,approval};
 }
 return {documentStore,caseStore,caseService,call,owner,origin,prepare,cases:()=>created.data,businessCalls:()=>businessCalls,renderCount:()=>renderCount,counts:()=>({documents:(documentStore.db.prepare('SELECT COUNT(*) AS n FROM quote_documents').get() as {n:number}).n,audit:(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_audit').get() as {n:number}).n}),saveUnlinked:async()=>{const preview=await (await call(owner,'/quote-documents/preview',{input:sample()},randomUUID())).json() as {data:{input:unknown;template_version:number;preview_hash:string;preview_expires_at:number}};return (await (await call(owner,'/quote-documents/save',{input:preview.data.input,template_version:preview.data.template_version,preview_hash:preview.data.preview_hash,preview_expires_at:preview.data.preview_expires_at,confirmed:true},randomUUID())).json() as {data:{id:string;version:number}}).data;},setRenderHook:(hook:()=>void)=>{renderHook=hook;},failRenderer:()=>{rendererFails=true;},pdfCount:()=>(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get() as {n:number}).n,setRole:(user:string,role:'owner'|'viewer'|null)=>{roles[user]=role;},close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));documentStore.close();caseStore.close();rmSync(root,{recursive:true,force:true});}};
}

it('serves linked reject, the approved manual review errata and dependency failures over loopback HTTP',async()=>{
 const f=await linkedHttpFixture();
 try{
  const expired=await f.prepare();
  vi.useFakeTimers();vi.setSystemTime(new Date(Date.parse(`${rates.valid_until}T00:00:00Z`)+86400000));
  const expiredApprove=await f.call(f.owner,'/quote-documents/approve',expired.approval,randomUUID());
  vi.useRealTimers();
  expect(expiredApprove.status).toBe(200);
  const expiredBody=await expiredApprove.json() as {status:string;data:null;reason_codes:string[]};
  expect(expiredBody).toMatchObject({status:'manual_review',data:null,reason_codes:['document_expired']});
  expect((await (await f.call(f.owner,'/quote-documents/get',{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:expired.saved.id})).json() as {data:{state:string}}).data.state).toBe('draft');
  const approved=await f.prepare();
  expect((await f.call(f.owner,'/quote-documents/approve',approved.approval,randomUUID())).status).toBe(200);
  f.setRenderHook(()=>{const row=f.documentStore.db.prepare('SELECT payload FROM quote_documents WHERE id=?').get(approved.saved.id) as {payload:string},payload=JSON.parse(row.payload) as {version:number};f.documentStore.db.prepare('UPDATE quote_documents SET payload=? WHERE id=?').run(JSON.stringify({...payload,version:payload.version+1}),approved.saved.id);});
  const conflicted=await f.call(f.owner,'/quote-documents/export',{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:approved.saved.id,mode:'formal'},randomUUID());
  expect(conflicted.status).toBe(200);
  expect(await conflicted.json()).toMatchObject({status:'manual_review',data:null,reason_codes:['version_conflict']});
  expect(f.pdfCount()).toBe(0);
  f.setRenderHook(()=>{});
  const broken=await f.prepare();
  expect((await f.call(f.owner,'/quote-documents/approve',broken.approval,randomUUID())).status).toBe(200);
  f.failRenderer();
  const unavailable=await f.call(f.owner,'/quote-documents/export',{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:broken.saved.id,mode:'formal'},randomUUID());
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({status:'unavailable',data:null,reason_codes:['document_renderer_unavailable']});
  expect(f.pdfCount()).toBe(0);
  f.setRenderHook(()=>{});
  const rejectTarget=await f.prepare(),invisible=await f.prepare();
  const detail=await (await fetch(`${f.origin}/console/api/v1/cases/${f.cases().case_id}`,{headers:{cookie:f.owner.cookie}})).json() as {data:{version:number}};
  expect((await f.call(f.owner,`/cases/${f.cases().case_id}/update`,{expected_version:detail.data.version,status:'closed',public_note:'Closed for the corrective rejection.'},randomUUID())).status).toBe(200);
  const rejection={contract_version:INQUIRY_QUOTE_LINK_VERSION,id:rejectTarget.saved.id,expected_version:1,reason:'stale draft correction'};
  const rejectionKey=randomUUID();
  const rejected=await f.call(f.owner,'/quote-documents/reject',rejection,rejectionKey);
  expect(rejected.status).toBe(200);
  expect((await rejected.json() as {data:{state:string;version:number}}).data).toMatchObject({state:'rejected',version:2});
  const rejectionReplay=await f.call(f.owner,'/quote-documents/reject',rejection,rejectionKey);
  expect(rejectionReplay.status).toBe(200);
  expect((await rejectionReplay.json() as {status:string;data:{id:string;state:string}}).data).toMatchObject({id:rejectTarget.saved.id,state:'rejected'});
  f.setRole('fixture-owner',null);
  const hiddenReject=await f.call(f.owner,'/quote-documents/reject',{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:invisible.saved.id,expected_version:1,reason:'must not pass'},randomUUID());
  expect(hiddenReject.status).toBe(404);
  expect(await hiddenReject.json()).toMatchObject({status:'blocked',data:null,reason_codes:['document_not_found']});
  expect(JSON.parse((f.documentStore.db.prepare('SELECT payload FROM quote_documents WHERE id=?').get(invisible.saved.id) as {payload:string}).payload)).toMatchObject({state:'draft',version:1});
 } finally {await f.close();}
});

it('returns the accepted history-missing reason as a v2 unavailable envelope without rendering',async()=>{
 const f=await linkedHttpFixture();
 try{
  const draft=await f.prepare();
  const before=f.renderCount();
  const response=await f.call(f.owner,'/quote-documents/export',{contract_version:'inquiry-quote-link@2026-09-13.v1',id:draft.saved.id,mode:'history'},randomUUID());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({schema_version:'quote-documents@2026-09-13.v2',status:'unavailable',data:null,reason_codes:['inquiry_quote_history_bytes_missing']});
  expect(f.renderCount()).toBe(before);
  expect(f.pdfCount()).toBe(0);
 } finally {await f.close();}
});

it('keeps unlinked documents on v1 business semantics inside v2 envelopes over loopback HTTP',async()=>{
 const f=await linkedHttpFixture();
 try{
  const first=await f.saveUnlinked();
  const got=await f.call(f.owner,'/quote-documents/get',{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:first.id},randomUUID());
  expect(got.status).toBe(200);
  const gotBody=await got.json() as {schema_version:string;status:string;reason_codes:string[];data:{id:string;state:string;inquiry_case_link_v1?:unknown}};
  expect(gotBody).toMatchObject({schema_version:V2_VERSION,status:'success',reason_codes:[]});
  expect(gotBody.data).toMatchObject({id:first.id,state:'draft'});
  expect(gotBody.data.inquiry_case_link_v1).toBeUndefined();
  const history=await f.call(f.owner,'/quote-documents/export',{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:first.id,mode:'history'},randomUUID());
  expect(history.status).toBe(200);
  const historyBody=await history.json() as {schema_version:string;status:string;reason_codes:string[];data:{historical?:unknown;valid_now?:unknown;inquiry_case_link_v1?:unknown;draft:boolean;sha256:string;content_base64:string}};
  expect(historyBody).toMatchObject({schema_version:V2_VERSION,status:'success',reason_codes:[]});
  expect(historyBody.data.historical).toBeUndefined();
  expect(historyBody.data.valid_now).toBeUndefined();
  expect(historyBody.data.inquiry_case_link_v1).toBeUndefined();
  expect(historyBody.data.draft).toBe(true);
  expect(createHash('sha256').update(Buffer.from(historyBody.data.content_base64,'base64')).digest('hex')).toBe(historyBody.data.sha256);
  expect(f.renderCount()).toBe(1);
  expect(f.pdfCount()).toBe(1);
  const formal=await f.call(f.owner,'/quote-documents/export',{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:first.id,mode:'formal'},randomUUID());
  expect(formal.status).toBe(200);
  const formalBody=await formal.json() as {reason_codes:string[];data:{sha256:string}};
  expect(formalBody.reason_codes).toEqual([]);
  expect(formalBody.data.sha256).toBe(historyBody.data.sha256);
  expect(f.renderCount()).toBe(1);
  const approved=await f.call(f.owner,'/quote-documents/approve',{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:first.id,expected_version:1,evidence_ref:'review:http',evidence_version:'1',review_notes:'v2 unlinked approve',confirmation:'human_verified_price_and_source'},randomUUID());
  expect(approved.status).toBe(200);
  const approvedBody=await approved.json() as {schema_version:string;status:string;reason_codes:string[];data:{id:string;state:string;version:number;inquiry_case_link_v1?:unknown}};
  expect(approvedBody).toMatchObject({schema_version:V2_VERSION,status:'success',reason_codes:[]});
  expect(approvedBody.data).toMatchObject({id:first.id,state:'approved',version:2});
  expect(approvedBody.data.inquiry_case_link_v1).toBeUndefined();
  const second=await f.saveUnlinked();
  const rejected=await f.call(f.owner,'/quote-documents/reject',{contract_version:INQUIRY_QUOTE_LINK_VERSION,id:second.id,expected_version:1,reason:'v2 unlinked reject'},randomUUID());
  expect(rejected.status).toBe(200);
  const rejectedBody=await rejected.json() as {status:string;reason_codes:string[];data:{id:string;state:string}};
  expect(rejectedBody).toMatchObject({status:'success',reason_codes:[]});
  expect(rejectedBody.data).toMatchObject({id:second.id,state:'rejected'});
 } finally {await f.close();}
});

it('rejects an inverted documented validity window before the engine or any write',async()=>{
 const f=await linkedHttpFixture();
 try{
  const before=f.counts();
  const response=await f.call(f.owner,'/quote-documents/native-prepare',{contract_version:INQUIRY_QUOTE_LINK_VERSION,case_ref:f.cases().case_id,expected_customer_event_ref:null,request:quoteRequest,customer:{quote_no:'QA-HTTP-003',customer_name:'Synthetic HTTP owner',quote_date:'2026-09-20',valid_until:'2026-09-01',job_no:'',so_no:'',container_no:'',remark:''}},randomUUID());
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({schema_version:V2_VERSION,status:'needs_input',data:null,reason_codes:['inquiry_quote_link_input_invalid']});
  expect(f.businessCalls()).toBe(0);
  expect(f.renderCount()).toBe(0);
  expect(f.counts()).toEqual(before);
 } finally {await f.close();}
});

it('reports a missing document service as a v2 unavailable envelope only for identifiable v2 requests',async()=>{
 const root=mkdtempSync(join(tmpdir(),'linked-http3-')),caseStore=new CaseStore(join(root,'cases.sqlite'));
 const portal={getState:()=>({data:{current_organization:null,memberships:[]}})};
 const caseService=new CaseService(caseStore,portal as never);
 const server=createServer((request,response)=>{void handler.handle(request,response);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const handler=createPortalHttpHandler({mode:'fixtures',service:portal as never,caseService,identityProvider:new FixturePortalIdentityProvider({mode:'fixtures',loopback:true}),sessions:new PortalSessionManager({store:new InMemoryPortalSessionStore(),secureCookie:false}),allowedHosts:[new URL(origin).host],allowedOrigins:[origin],allowLoopbackHttp:true});
 try{
  const anonymous=await fetch(origin+'/console/api/v1/session');const {csrf_token}=await anonymous.json() as {csrf_token:string};
  const logged=await fetch(origin+'/console/api/v1/fixture-login',{method:'POST',headers:{cookie:anonymous.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':csrf_token,'idempotency-key':'fixture-login-missing-service','content-type':'application/json'},body:JSON.stringify({identity_id:'fixture-owner'})});
  expect(logged.status).toBe(200);
  const session=await logged.json() as {csrf_token:string},headers={cookie:logged.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':session.csrf_token,'content-type':'application/json'};
  const id='00000000-0000-4000-8000-000000000001';
  const v2=await fetch(origin+'/console/api/v1/quote-documents/get',{method:'POST',headers:{...headers,'idempotency-key':'missing-service-request-01'},body:JSON.stringify({contract_version:INQUIRY_QUOTE_LINK_VERSION,id})});
  expect(v2.status).toBe(503);
  expect(await v2.json()).toMatchObject({schema_version:V2_VERSION,status:'unavailable',data:null,reason_codes:['document_service_unavailable']});
  const v1=await fetch(origin+'/console/api/v1/quote-documents/get',{method:'POST',headers:{...headers,'idempotency-key':'missing-service-request-02'},body:JSON.stringify({id})});
  expect(v1.status).toBe(503);
  expect(await v1.json()).toMatchObject({schema_version:'portal@2026-09-05.v1',status:'unavailable',data:null,reason_codes:['document_service_unavailable']});
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));caseStore.close();rmSync(root,{recursive:true,force:true});}
});
