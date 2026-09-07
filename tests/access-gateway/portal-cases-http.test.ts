import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CaseService, CaseStore, type CaseView } from '../../services/access-gateway/portal/cases';
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
