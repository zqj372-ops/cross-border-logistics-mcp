import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {
  ChildProcessFclSmtpRunner,
  FCL_SMTP_CHILD_TIMEOUT_MS,
  FCL_SMTP_NOTIFICATION_TIMEOUT_MS,
  readFclSmtpConfigFile,
  SmtpFclMailTransport,
  type FclSmtpConfig,
  type FclSmtpProcessResult,
  type FclSmtpProcessRunner,
} from '../../services/access-gateway/portal/fcl-smtp-transport';

const config:FclSmtpConfig={host:'smtp.qq.com',port:465,secure:true,username:'synthetic@qq.com',password:'synthetic-auth-code',from:'synthetic@qq.com'};

function runner(result:Partial<FclSmtpProcessResult>={}){
  const calls:{payload:string;options:{scriptPath:string;pythonPath:string;timeoutMs:number}}[]=[];
  const value:FclSmtpProcessRunner={run:(payload,options)=>{calls.push({payload,options});return Promise.resolve({code:0,stdout:'OK\n',stderr:'',timedOut:false,oversized:false,...result});}};
  return {runner:value,calls};
}

it('passes one UTF-8 message to the fixed Python runner via stdin and treats OK as accepted',async()=>{
  const fake=runner(),transport=new SmtpFclMailTransport(config,{runner:fake.runner,scriptPath:'/opt/fcl/fcl_smtp_send.py',pythonPath:'/usr/bin/python3',timeoutMs:500});
  await transport.send({to:'receiver@example.test',cc:['ops@example.test'],subject:'合成询价',body:'line one\nline two'});
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.options).toEqual({scriptPath:'/opt/fcl/fcl_smtp_send.py',pythonPath:'/usr/bin/python3',timeoutMs:500});
  expect(JSON.parse(fake.calls[0]!.payload)).toEqual({config,message:{to:'receiver@example.test',cc:['ops@example.test'],subject:'合成询价',body:'line one\nline two'}});
  expect(JSON.stringify(fake.calls[0]!.options)).not.toContain(config.password);
});

it.each([
  [{code:65,stdout:'',stderr:'authentication failed'},'fcl_smtp_rejected'],
  [{code:66,stdout:'',stderr:'connection failed'},'fcl_smtp_unavailable'],
  [{code:null,stdout:'',stderr:'',timedOut:true},'fcl_smtp_timeout'],
  [{code:null,stdout:'x'.repeat(2000),stderr:'',oversized:true},'fcl_smtp_protocol_error'],
])('maps child outcome %j to %s without retrying',async(result,code)=>{
  const fake=runner(result),transport=new SmtpFclMailTransport(config,{runner:fake.runner,timeoutMs:500});
  await expect(transport.send({to:'receiver@example.test',cc:[],subject:'synthetic',body:'synthetic'})).rejects.toThrow(code);
  expect(fake.calls).toHaveLength(1);
});

it('rejects injected headers before starting a child process',async()=>{
  const fake=runner(),transport=new SmtpFclMailTransport(config,{runner:fake.runner,timeoutMs:500});
  await expect(transport.send({to:'receiver@example.test\r\nBcc: evil@example.test',cc:[],subject:'synthetic',body:'synthetic'})).rejects.toThrow('fcl_mail_header_invalid');
  await expect(transport.send({to:'receiver@example.test',cc:[],subject:'synthetic\r\nX-Evil: 1',body:'synthetic'})).rejects.toThrow('fcl_mail_header_invalid');
  expect(fake.calls).toEqual([]);
  expect(()=>new SmtpFclMailTransport({...config,secure:false as never})).toThrow('fcl_smtp_config_invalid');
});

it('reads only a closed private SMTP JSON file',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-smtp-config-')),path=join(root,'smtp.json');
  try{
    writeFileSync(path,JSON.stringify(config),{mode:0o400});
    expect(readFclSmtpConfigFile(path)).toEqual(config);
    rmSync(path);
    writeFileSync(path,JSON.stringify({...config,extra:true}),{mode:0o400});
    expect(()=>readFclSmtpConfigFile(path)).toThrow('fcl_smtp_config_invalid');
  }finally{rmSync(root,{recursive:true,force:true});}
});

it('executes a fixed local child fixture when explicitly injected',async()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-smtp-child-')),path=join(root,'fixture.sh');
  try{
    writeFileSync(path,'#!/bin/sh\npayload=$(cat)\ncase "$payload" in *accepted*) echo OK; exit 0;; *) exit 65;; esac\n',{mode:0o700});
    const processRunner=new ChildProcessFclSmtpRunner();
    await expect(processRunner.run('{"kind":"accepted"}',{scriptPath:path,pythonPath:'/bin/sh',timeoutMs:500})).resolves.toMatchObject({code:0,stdout:'OK\n'});
    await expect(processRunner.run('{"kind":"rejected"}',{scriptPath:path,pythonPath:'/bin/sh',timeoutMs:500})).resolves.toMatchObject({code:65});
  }finally{rmSync(root,{recursive:true,force:true});}
});

it('keeps the child hard deadline below the outer notification deadline',()=>{
  expect(FCL_SMTP_CHILD_TIMEOUT_MS).toBeLessThan(FCL_SMTP_NOTIFICATION_TIMEOUT_MS);
});
