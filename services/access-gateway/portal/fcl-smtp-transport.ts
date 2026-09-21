import {spawn} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import type {FclMailMessage,FclMailTransport} from './cases';

const configSchema=z.object({
  host:z.string().trim().min(1).max(253),
  port:z.number().int().min(1).max(65535),
  secure:z.literal(true),
  username:z.string().min(1).max(320),
  password:z.string().min(1).max(4096),
  from:z.email().max(254),
}).strict();

export type FclSmtpConfig=z.infer<typeof configSchema>;
export const FCL_SMTP_CHILD_TIMEOUT_MS=8_000;
export const FCL_SMTP_NOTIFICATION_TIMEOUT_MS=10_000;

function fail(code:string,cause?:unknown):never{
  throw new Error(code,cause===undefined?undefined:{cause});
}

export function parseFclSmtpConfig(value:unknown):FclSmtpConfig{
  const parsed=configSchema.safeParse(value);
  if(!parsed.success)fail('fcl_smtp_config_invalid');
  if(/[\r\n]/u.test(parsed.data.host)||!/^[A-Za-z0-9.-]+$/u.test(parsed.data.host))fail('fcl_smtp_config_invalid');
  return Object.freeze(parsed.data);
}

export function readFclSmtpConfigFile(filename:string):FclSmtpConfig{
  if(!isAbsolute(filename)||resolve(filename)!==filename)fail('fcl_smtp_config_invalid');
  let stat;
  try{stat=lstatSync(filename);}catch(cause){fail('fcl_smtp_config_invalid',cause);}
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size<2||stat.size>16*1024)fail('fcl_smtp_config_invalid');
  let value:unknown;
  try{value=JSON.parse(readFileSync(filename,'utf8')) as unknown;}catch(cause){fail('fcl_smtp_config_invalid',cause);}
  return parseFclSmtpConfig(value);
}

export interface FclSmtpProcessResult{
  readonly code:number|null;
  readonly stdout:string;
  readonly stderr:string;
  readonly timedOut:boolean;
  readonly oversized:boolean;
}

export interface FclSmtpProcessRunner{
  run(payload:string,options:{scriptPath:string;pythonPath:string;timeoutMs:number}):Promise<FclSmtpProcessResult>;
}

export class ChildProcessFclSmtpRunner implements FclSmtpProcessRunner{
  run(payload:string,options:{scriptPath:string;pythonPath:string;timeoutMs:number}):Promise<FclSmtpProcessResult>{
    return new Promise((resolveRun)=>{
      const child=spawn(options.pythonPath,[options.scriptPath],{
        stdio:['pipe','pipe','pipe'],
        env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},
        windowsHide:true,
      });
      let stdout='',stderr='',timedOut=false,oversized=false,settled=false;
      const finish=()=>{
        if(settled)return;settled=true;clearTimeout(timer);
        resolveRun({code:child.exitCode,stdout,stderr,timedOut,oversized});
      };
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},options.timeoutMs);
      const collect=(stream:'stdout'|'stderr',maximum:number)=>(chunk:Buffer)=>{
        const current=stream==='stdout'?stdout:stderr;
        if(Buffer.byteLength(current,'utf8')+chunk.byteLength>maximum){oversized=true;child.kill('SIGKILL');return;}
        if(stream==='stdout')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');
      };
      child.stdout.on('data',collect('stdout',1024));
      child.stderr.on('data',collect('stderr',4096));
      child.once('error',finish);
      child.once('close',finish);
      child.stdin.once('error',()=>{/* Broken stdin is reported by the child result. */});
      child.stdin.end(payload);
    });
  }
}

export interface FclSmtpTransportOptions{
  readonly runner?:FclSmtpProcessRunner;
  readonly scriptPath?:string;
  readonly pythonPath?:string;
  readonly timeoutMs?:number;
  readonly maxMessageBytes?:number;
}

function validAddress(value:string):boolean{return z.email().max(254).safeParse(value).success&&!/[\r\n]/u.test(value);}

function requestPayload(config:FclSmtpConfig,message:FclMailMessage,maximum:number):string{
  if(!validAddress(message.to)||message.cc.some(address=>!validAddress(address))||message.cc.length>10||/[\r\n]/u.test(message.subject)||message.subject.length===0||message.subject.length>500)fail('fcl_mail_header_invalid');
  if(typeof message.body!=='string'||Buffer.byteLength(message.body,'utf8')>maximum)fail('fcl_mail_body_invalid');
  const payload=JSON.stringify({config,message});
  if(Buffer.byteLength(payload,'utf8')>maximum+4096)fail('fcl_mail_body_invalid');
  return payload;
}

export class SmtpFclMailTransport implements FclMailTransport{
  readonly #config:FclSmtpConfig;
  readonly #runner:FclSmtpProcessRunner;
  readonly #scriptPath:string;
  readonly #pythonPath:string;
  readonly #timeoutMs:number;
  readonly #maxMessageBytes:number;

  constructor(config:FclSmtpConfig,options:FclSmtpTransportOptions={}){
    this.#config=parseFclSmtpConfig(config);
    const timeout=options.timeoutMs??FCL_SMTP_CHILD_TIMEOUT_MS,maximum=options.maxMessageBytes??1024*1024;
    if(!Number.isInteger(timeout)||timeout<100||timeout>60_000)fail('fcl_smtp_config_invalid');
    if(!Number.isInteger(maximum)||maximum<1_024||maximum>8*1024*1024)fail('fcl_smtp_config_invalid');
    this.#runner=options.runner??new ChildProcessFclSmtpRunner();
    this.#scriptPath=options.scriptPath??resolve('dist/services/access-gateway/portal/fcl_smtp_send.py');
    this.#pythonPath=options.pythonPath??'/usr/bin/python3';
    this.#timeoutMs=timeout;
    this.#maxMessageBytes=maximum;
  }

  async send(message:FclMailMessage):Promise<void>{
    const payload=requestPayload(this.#config,message,this.#maxMessageBytes);
    const result=await this.#runner.run(payload,{scriptPath:this.#scriptPath,pythonPath:this.#pythonPath,timeoutMs:this.#timeoutMs});
    if(result.timedOut)fail('fcl_smtp_timeout');
    if(result.oversized)fail('fcl_smtp_protocol_error');
    if(result.code===0&&result.stdout.trim()==='OK')return;
    if(result.code===65)fail('fcl_smtp_rejected');
    fail('fcl_smtp_unavailable');
  }
}

export function createFclSmtpTransport(config:FclSmtpConfig,options:FclSmtpTransportOptions={}):FclMailTransport{
  return new SmtpFclMailTransport(config,options);
}
