import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';
import {createPortalHttpHandler} from '../../services/access-gateway/portal/http';
import {FixturePortalIdentityProvider} from '../../services/access-gateway/portal/identity';
import {InMemoryPortalSessionStore,PortalSessionManager} from '../../services/access-gateway/portal/session';
import {DocumentService,DocumentStore} from '../../services/quote-documents/service';
import {DocumentWorkflowService,DocumentWorkflowStore} from '../../services/quote-documents/workflow';
import {DRAFT_VERSION,WORKFLOW_REQUEST_VERSION} from '../../services/quote-documents/workflow-contracts';
import {template} from '../quote-documents/fixtures';

const organization='org_fixture';
const blankDraft=()=>({schema_version:DRAFT_VERSION,quote_no:null,customer_name:null,quote_date:null,valid_until:null,origin:null,destination:null,route_name:null,job_no:null,so_no:null,container_no:null,remark:null,exchange_rates:{USD:null,CAD:null},fee_items:[]});
const completeDraft=()=>({...blankDraft(),quote_no:'QA-V3-HTTP-001',customer_name:'Synthetic HTTP',quote_date:new Date().toISOString().slice(0,10),valid_until:'2099-12-31',fee_items:[{id:randomUUID(),source_kind:'manual' as const,template_ref:null,name:'Base freight',description:null,group:'B' as const,quantity:'1',unit:'shipment',unit_price:'10',currency:'USD' as const,display:'detail' as const,merge_name:null,note:null}]});

it('serves the v3 save-review-approve-export chain and blocks legacy v1 access after claim',async()=>{
  const root=mkdtempSync(join(tmpdir(),'quote-workflow-http-'));
  const documentStore=new DocumentStore(join(root,'documents.sqlite'));
  const portal={getState:(context:PortalContext)=>({data:{current_organization:context.organizationId?{organizationId:organization,status:'active'}:null,memberships:[{organizationId:organization,userId:context.identity.userId,status:'active',role:'owner'}]}})} as never;
  const documentService=new DocumentService(documentStore,portal,()=>Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120))));
  const workflow=new DocumentWorkflowService(new DocumentWorkflowStore(documentStore),documentService,portal,()=>Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120))));
  const server=createServer((request,response)=>{void handler.handle(request,response);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const handler=createPortalHttpHandler({mode:'fixtures',service:portal,identityProvider:new FixturePortalIdentityProvider({mode:'fixtures',loopback:true}),sessions:new PortalSessionManager({store:new InMemoryPortalSessionStore(),secureCookie:false}),allowedHosts:[new URL(origin).host],allowedOrigins:[origin],allowLoopbackHttp:true,documentService,documentWorkflowService:workflow});
  async function login(){
    const response=await fetch(origin+'/console/api/v1/session');
    const anonymous=await response.json() as {csrf_token:string};
    const logged=await fetch(origin+'/console/api/v1/fixture-login',{method:'POST',headers:{cookie:response.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':anonymous.csrf_token,'idempotency-key':'workflow-http-login-0001','content-type':'application/json'},body:JSON.stringify({identity_id:'fixture-owner'})});
    expect(logged.status).toBe(200);
    const session=await logged.json() as {csrf_token:string};
    const selected=await fetch(origin+'/console/api/v1/session/organization',{method:'POST',headers:{cookie:logged.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':session.csrf_token,'idempotency-key':'workflow-http-org-0001','content-type':'application/json'},body:JSON.stringify({organization_id:organization})});
    expect(selected.status).toBe(200);
    const selectedBody=await selected.json() as {csrf_token:string};
    return {cookie:selected.headers.get('set-cookie')?.split(';')[0]??logged.headers.get('set-cookie')!.split(';')[0]!,csrf:selectedBody.csrf_token};
  }
  const session=await login();
  const call=(path:string,payload:unknown,key:string)=>fetch(origin+'/console/api/v1'+path,{method:'POST',headers:{cookie:session.cookie,origin,'x-csrf-token':session.csrf,'idempotency-key':key,'content-type':'application/json'},body:JSON.stringify(payload)});
  try{
    const configured=await call('/quote-documents/config-save',{contract_version:WORKFLOW_REQUEST_VERSION,expected_version:0,input:{...template,standard_fee_template_v1:{template_id:'freightclaw-standard-v1',template_version:1,items:[]}},confirmed:true},'workflow-http-config-0001');
    expect(configured.status).toBe(200);
    expect((await configured.json() as {schema_version:string}).schema_version).toBe('quote-documents@2026-09-15.v3');
    const created=await call('/quote-documents/save',{contract_version:WORKFLOW_REQUEST_VERSION,operation:'create',document_kind:'manual',input:blankDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'workflow-http-create-0001');
    const createdBody=await created.json() as {status:string;data:{id:string;version:number}};
    expect(createdBody).toMatchObject({status:'success',data:{version:1}});
    const incomplete=await call('/quote-documents/review',{contract_version:WORKFLOW_REQUEST_VERSION,id:createdBody.data.id,expected_version:1},'workflow-http-review-0001');
    expect(await incomplete.json()).toMatchObject({status:'needs_input',reason_codes:['document_incomplete']});
    const updated=await call('/quote-documents/save',{contract_version:WORKFLOW_REQUEST_VERSION,operation:'update',document_kind:'manual',id:createdBody.data.id,expected_version:1,input:completeDraft(),template_selection:{mode:'retain'},save_intent:'save_draft'},'workflow-http-update-0001');
    const updatedBody=await updated.json() as {status:string;data:{version:number}};
    expect(updatedBody).toMatchObject({status:'success',data:{version:2}});
    const review=await call('/quote-documents/review',{contract_version:WORKFLOW_REQUEST_VERSION,id:createdBody.data.id,expected_version:2},'workflow-http-review-0002');
    const reviewBody=await review.json() as {status:string;data:{review_hash:string}};
    expect(reviewBody.status).toBe('success');
    const approved=await call('/quote-documents/approve',{contract_version:WORKFLOW_REQUEST_VERSION,id:createdBody.data.id,expected_version:2,review_hash:reviewBody.data.review_hash,evidence_ref:'review:http-v3',evidence_version:'1',review_notes:'核验',confirmation:'human_verified_price_and_source'},'workflow-http-approve-0001');
    const approvedBody=await approved.json() as {status:string;data:{state:string;version:number}};
    expect(approvedBody).toMatchObject({status:'success',data:{state:'approved',version:3}});
    const exported=await call('/quote-documents/export',{contract_version:WORKFLOW_REQUEST_VERSION,id:createdBody.data.id,mode:'formal',expected_version:3},'workflow-http-export-0001');
    const exportedBody=await exported.json() as {status:string;data:{content_base64:string;sha256:string;byte_length:number}};
    expect(exportedBody.status).toBe('success');
    expect(Buffer.from(exportedBody.data.content_base64,'base64')).toHaveLength(exportedBody.data.byte_length);
    const legacy=await call('/quote-documents/get',{id:createdBody.data.id},'workflow-http-legacy-0001');
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toMatchObject({status:'blocked',reason_codes:['document_contract_version_required']});
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    documentStore.close();
    rmSync(root,{recursive:true,force:true});
  }
});
