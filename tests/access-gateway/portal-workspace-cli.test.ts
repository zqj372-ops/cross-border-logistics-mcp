import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../deploy/cli/cli';
it('binds private sessions to origin, requires explicit write keys, redacts credentials and exposes matching schemas',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fc-workspace-cli-')),filename=join(root,'session.json');
 const secret='a'.repeat(43),csrf='b'.repeat(43);await writeFile(filename,JSON.stringify({origin:'http://127.0.0.1:8908',session_token:secret,csrf_token:csrf,expires_at:Date.now()+60000}),{mode:0o600});let calls=0,output='';
 const io={env:{},stdout:(s:string)=>{output+=s;},stderr:(s:string)=>{output+=s;},fetch:(()=>{calls++;return Promise.resolve(new Response(JSON.stringify({schema_version:'portal-channels@2026-09-07.v1',status:'success',data:{items:[],can_manage:true,scope:'platform'},reason_codes:[]}),{headers:{'content-type':'application/json'}}));}) as typeof fetch};
 try{
  expect(await runCli(['workspace','channels','list','--session-file',filename,'--endpoint','https://other.example'],io)).toBe(2);expect(calls).toBe(0);
  expect(await runCli(['workspace','channels','disable','--id','example','--session-file',filename,'--input','-'],{...io,stdin: (await import('node:stream')).Readable.from(['{"expected_version":1}'])})).toBe(2);expect(calls).toBe(0);
  expect(await runCli(['workspace','channels','list','--session-file',filename],io)).toBe(0);expect(calls).toBe(1);
  expect(await runCli(['workspace','channels','list','--session-file',filename],{...io,fetch:()=>Promise.resolve(new Response(JSON.stringify({status:'success',data:{unexpected:secret}}),{headers:{'content-type':'application/json'}}))})).toBe(1);expect(output).not.toContain(secret);expect(output).not.toContain(csrf);
  expect(await runCli(['workspace','schema','channels','create'],io)).toBe(0);expect(output).toContain('additionalProperties');
  expect(await runCli(['workspace','schema','cases','create'],io)).toBe(0);expect(output).toContain('contactName');
  expect(await runCli(['workspace','channels','list','--session-file',filename],{...io,fetch:()=>Promise.resolve(new Response(JSON.stringify({status:'success',data:{items:[]}})))})).toBe(1);
  expect((await stat(filename)).mode&0o777).toBe(0o600);expect(await readFile(filename,'utf8')).toContain(secret);
 }finally{await rm(root,{recursive:true,force:true});}
});

const linkedExamples=(JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/contracts/examples/v2/inquiry-quote-link-v2.json',import.meta.url)),'utf8')) as {examples:{kind:string;request:Record<string,unknown>;envelope:Record<string,unknown>}[]}).examples;
const linkedExample=(kind:string)=>{const found=linkedExamples.find(entry=>entry.kind===kind);if(!found)throw new Error(`missing linked example ${kind}`);return found;};

it('selects approved linked v2 documents by explicit version, preserves business envelopes and never writes partial PDFs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fc-linked-cli-')),filename=join(root,'session.json');
 const {randomUUID}=await import('node:crypto');await writeFile(filename,JSON.stringify({origin:'http://127.0.0.1:8908',session_token:randomUUID().replaceAll('-','')+'Ab',csrf_token:randomUUID().replaceAll('-','')+'Cd',expires_at:Date.now()+60000}),{mode:0o600});
 let output='',requests:{path:string;body:unknown}[]=[],next:unknown=null,nextStatus=200;
 const io={env:{},stdout:(s:string)=>{output+=s;},stderr:(s:string)=>{output+=s;},fetch:((url:URL,init:RequestInit)=>{requests.push({path:String(url.pathname)+String(url.search),body:typeof init.body==='string'?JSON.parse(init.body):null});return Promise.resolve(new Response(JSON.stringify(next),{status:nextStatus,headers:{'content-type':'application/json'}}));}) as typeof fetch};
 const writeInput=async(name:string,value:unknown)=>{const path=join(root,name);await writeFile(path,JSON.stringify(value),{mode:0o600});return path;};
 const run=async(args:string[])=>{output='';requests=[];return runCli(['workspace',...args,'--session-file',filename],io);};
 const exists=async(path:string)=>{try{await stat(path);return true;}catch{return false;}};
 try{
  output='';expect(await runCli(['workspace','schema','documents','v2','save'],io)).toBe(0);expect(output).toContain('inquiry-quote-link@2026-09-13.v1');expect(output).toContain('native_quote_v1');
  output='';expect(await runCli(['workspace','schema','cases','get','v2'],io)).toBe(0);expect(output).toContain('inquiry-quote-link@2026-09-13.v1');
  const unknownVersion=await writeInput('unknown.json',{...linkedExample('get-linked-success').request,contract_version:'inquiry-quote-link@2099-01-01.v9'});
  expect(await run(['documents','get','--input',unknownVersion])).toBe(2);expect(output).toContain('input_schema_invalid');expect(requests).toHaveLength(0);
  const extraField=await writeInput('extra.json',{...linkedExample('get-linked-success').request,extra:true});
  expect(await run(['documents','get','--input',extraField])).toBe(2);expect(requests).toHaveLength(0);
  const saveRequest=await writeInput('save.json',linkedExample('save-success').request);
  next=linkedExample('save-success').envelope;nextStatus=200;
  expect(await run(['documents','save','--input',saveRequest,'--idempotency-key','linked-cli-save-0001'])).toBe(0);
  expect(requests).toHaveLength(1);expect(requests[0]!.path).toBe('/console/api/v1/quote-documents/save');
  expect(requests[0]!.body).toEqual(linkedExample('save-success').request);
  expect((JSON.parse(output) as {schema_version:string}).schema_version).toBe('quote-documents@2026-09-13.v2');
  next={...linkedExample('save-success').envelope,schema_version:'quote-documents@2026-09-08.v1'};
  expect(await run(['documents','save','--input',saveRequest,'--idempotency-key','linked-cli-save-0001'])).toBe(1);expect(output).toContain('response_invalid');
  const getRequest=await writeInput('get.json',linkedExample('replay-not-current').request);
  next=linkedExample('replay-not-current').envelope;nextStatus=200;
  expect(await run(['documents','get','--input',getRequest])).toBe(4);expect(output).toContain('inquiry_quote_replay_not_current');
  const historyRequest=await writeInput('history.json',linkedExample('history-unavailable').request);
  next=linkedExample('history-unavailable').envelope;nextStatus=503;
  const missingBytes=join(root,'missing-history.pdf');
  expect(await run(['documents','export','--input',historyRequest,'--file',missingBytes])).toBe(6);
  expect(output).toContain('inquiry_quote_history_bytes_missing');expect(await exists(missingBytes)).toBe(false);
  const exportRequest=await writeInput('export.json',linkedExample('formal-export').request);
  next=linkedExample('formal-export').envelope;nextStatus=200;
  const exported=join(root,'formal.pdf');
  expect(await run(['documents','export','--input',exportRequest,'--file',exported])).toBe(0);
  const bytes=await readFile(exported);expect(bytes.subarray(0,5).toString()).toBe('%PDF-');expect((await stat(exported)).mode&0o777).toBe(0o600);
  expect((JSON.parse(output) as {data:{file:string}}).data.file).toBe(exported);
  expect(await run(['documents','export','--input',exportRequest,'--file',exported])).toBe(1);expect((await readFile(exported)).equals(bytes)).toBe(true);
  const corrupt={...linkedExample('formal-export').envelope} as {data:{content_base64:string;[key:string]:unknown}};
  corrupt.data={...corrupt.data,content_base64:Buffer.from(Buffer.from(corrupt.data.content_base64,'base64').fill(0x2e)).toString('base64')};
  next=corrupt;nextStatus=200;
  const corruptPath=join(root,'corrupt.pdf');
  expect(await run(['documents','export','--input',exportRequest,'--file',corruptPath])).toBe(1);expect(output).toContain('pdf_integrity_failed');expect(await exists(corruptPath)).toBe(false);
  const caseRequest=await writeInput('case.json',{contract_version:'inquiry-quote-link@2026-09-13.v1'});
  next=linkedExample('case-review-context').envelope;nextStatus=200;
  expect(await run(['cases','get','--id','00000000-0000-4000-8000-000000000003','--input',caseRequest])).toBe(0);
  expect(requests[0]!.path).toBe('/console/api/v1/cases/00000000-0000-4000-8000-000000000003?contract_version=inquiry-quote-link%402026-09-13.v1');
  next={schema_version:'portal-cases@2026-09-07.v1',status:'success',data:{case_id:'00000000-0000-4000-8000-000000000003'},reason_codes:[]};
  expect(await run(['cases','get','--id','00000000-0000-4000-8000-000000000003','--input',caseRequest])).toBe(1);expect(output).toContain('response_invalid');
  next={schema_version:'portal@2026-09-05.v1',status:'blocked',data:null,reason_codes:['authentication_required'],request_id:'req_cli_401'};nextStatus=401;
  expect(await run(['documents','get','--input',getRequest])).toBe(5);expect(output).toContain('permission_or_session_denied');
  next=linkedExample('formal-export').envelope;nextStatus=500;
  const wrongStatusFile=join(root,'wrong-status.pdf');
  expect(await run(['documents','export','--input',exportRequest,'--file',wrongStatusFile])).not.toBe(0);
  expect(await exists(wrongStatusFile)).toBe(false);
  nextStatus=200;
 }finally{await rm(root,{recursive:true,force:true});}
});
