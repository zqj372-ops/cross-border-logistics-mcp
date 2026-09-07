import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
