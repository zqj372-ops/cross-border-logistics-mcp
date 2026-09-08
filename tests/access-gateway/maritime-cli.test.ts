import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {runCli} from '../../deploy/cli/cli';
it('keeps maritime CLI queries and configuration narrow, authenticated, schema-checked and explicit about unavailable data',async()=>{
 const root=await mkdtemp(join(tmpdir(),'maritime-cli-')),session=join(root,'session.json');
 await writeFile(session,JSON.stringify({origin:'http://127.0.0.1:8930',session_token:'a'.repeat(43),csrf_token:'b'.repeat(43),expires_at:Date.now()+60000}),{mode:0o600});
 let output='',calls=0;
 const request={origin:'CNSHA',destination:'CAVAN',from:'2026-09-01',until:'2026-09-30'};
 const fetcher:typeof fetch=(url,init)=>{calls++;expect(url instanceof URL ? url.href : typeof url === 'string' ? url : url.url).toBe('http://127.0.0.1:8930/console/api/v1/maritime/sailing-schedules/query');expect(JSON.parse(init!.body as string)).toEqual(request);return Promise.resolve(new Response(JSON.stringify({schema_version:'maritime-query@2026-09-08.v1',status:'unavailable',data:{records:[],source:null,release:null},reason_codes:['maritime_not_published']}),{headers:{'content-type':'application/json'}}));};
 const io=(input:unknown)=>({env:{},fetch:fetcher,stdout:(s:string)=>{output+=s;},stderr:(s:string)=>{output+=s;},stdin:Readable.from([JSON.stringify(input)])});
 try{
  expect(await runCli(['workspace','commands'],io({}))).toBe(0);
  for(const kind of ['schedules','terminals'])for(const action of ['query','get','save','preview','publish','disable','rollback'])expect(output).toContain(`workspace ${kind} ${action}`);
  expect(await runCli(['workspace','schedules','query','--session-file',session,'--input','-'],io(request))).toBe(6);expect(calls).toBe(1);expect(output).toContain('maritime_not_published');
  expect(await runCli(['workspace','schedules','query','--session-file',session,'--input','-'],io({...request,tenant:'other'}))).toBe(2);expect(calls).toBe(1);
  expect(await runCli(['workspace','terminals','disable','--session-file',session,'--input','-'],io({expected_version:0}))).toBe(2);expect(calls).toBe(1);
  expect(await runCli(['workspace','schema','terminals','query'],io({}))).toBe(0);expect(output).toContain('additionalProperties');
 }finally{await rm(root,{recursive:true,force:true});}
});
