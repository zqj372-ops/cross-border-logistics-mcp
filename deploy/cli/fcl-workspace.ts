import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link,lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import type {CliIO} from './cli';
import type {Helpers} from './workspace';
import {
  FCL_HTTP_BODY_LIMITS,
  FCL_HTTP_RESPONSE_LIMITS,
  FCL_PUBLIC_BODY_LIMITS,
  FCL_PUBLIC_ROUTES,
  FCL_STAFF_ACTION_METHODS,
  FCL_STAFF_WRITE_ACTIONS,
  fclHttpActions,
  fclHttpRequestSchemas,
  fclHttpResponseSchemas,
  fclPublicOutputSchemas,
  fclPublicRequestSchemas,
  type FclHttpAction,
  type FclPublicAction,
} from '../../services/access-gateway/portal/fcl-http-contracts';

const keyPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const tokenPattern=/^[A-Za-z0-9_-]{32,128}$/u;
const sha256Pattern=/^[a-f0-9]{64}$/u;
const fclStaffWriteActions=new Set<FclHttpAction>(FCL_STAFF_WRITE_ACTIONS);
const description:Record<FclHttpAction,string>={
  'estimate-run':'计算并保存整柜预估报价',
  'estimate-list':'查询整柜比价方案',
  'estimate-get':'读取预估报价及历史版本',
  'estimate-adjust':'调整售价、推荐或锁定方案',
  'estimate-duplicate':'复制预估报价方案',
  'estimate-select':'选择预估方案并创建客户报价',
  'rate-bulk-preview':'预览批量海运费变更',
  'rate-bulk-publish':'发布批量海运费并重算关联方案',
  'case-list':'FCL 询价列表',
  'case-create':'新建本人受理的整柜询价',
  'case-get':'读取 FCL 询价',
  'case-status':'更新 FCL 询价状态',
  'case-staff-supplement':'工作人员代录 FCL 询价',
  'case-confirm':'确认 FCL 询价字段',
  'rate-get':'读取 FCL 运价',
  'rate-save':'保存 FCL 运价草稿',
  'rate-preview':'预览 FCL 运价发布或历史版本',
  'rate-publish':'发布已核对 FCL 运价',
  'rate-disable':'停用当前 FCL 运价',
  'rate-rollback':'回退 FCL 运价历史版本',
  'quote-match':'匹配 FCL 报价来源',
  'quote-save':'保存 FCL 报价成本售价',
  'quote-get':'读取 FCL 报价',
  'quote-list':'查询 FCL 报价历史',
  'issuer-config':'读取 FCL 出具人模板',
  'issuer-config-save':'保存 FCL 出具人模板',
  'document-save':'保存 FCL 报价单版本',
  'document-get':'读取 FCL 报价单',
  'document-list':'查询 FCL 报价单历史',
  'document-review':'生成 FCL 报价单核对结果',
  'document-approve':'确认 FCL 报价单',
  'document-reject':'退回 FCL 报价单',
  'document-export':'导出并校验 FCL PDF',
  'handoff-save':'保存 FCL 运营交接',
  'handoff-get':'读取 FCL 运营交接',
  'notification-get':'读取 FCL 提交通知配置',
  'notification-save':'保存 FCL 提交通知配置',
};

export const fclStaffWorkspaceCommands=fclHttpActions.map(action=>['fcl '+action,FCL_STAFF_ACTION_METHODS[action],'/fcl/'+action,description[action]] as const);
const publicDescriptions:Record<FclPublicAction,string>={
  session:'建立或读取当前匿名 FCL 询价会话',
  submit:'提交 FCL 询价并持久保存本票恢复信息',
  exchange:'使用受限凭证兑换本票 cookie',
  get:'读取当前本票询价',
  supplement:'补充当前本票询价',
  logout:'结束当前公开询价会话',
};
export const fclPublicWorkspaceCommands=(Object.keys(FCL_PUBLIC_ROUTES) as FclPublicAction[]).map(action=>['fcl inquiry '+action,FCL_PUBLIC_ROUTES[action].method,FCL_PUBLIC_ROUTES[action].path,publicDescriptions[action]] as const);
export const fclWorkspaceCommands=[...fclStaffWorkspaceCommands,...fclPublicWorkspaceCommands] as const;

export const fclWorkspaceSchemas:Record<string,z.ZodType>=Object.fromEntries([
  ...fclHttpActions.map(action=>['fcl '+action,fclHttpRequestSchemas[action]] as const),
  ...(Object.keys(FCL_PUBLIC_ROUTES) as FclPublicAction[]).map(action=>['fcl inquiry '+action,fclPublicRequestSchemas[action]] as const),
]);

export function fclCommandMetadata(name:string):{auth:'person_session'|'public_inquiry_session';scope:'fcl_personal'|'public_inquiry_ticket'}|null{
  if(name.startsWith('fcl inquiry '))return {auth:'public_inquiry_session',scope:'public_inquiry_ticket'};
  if(name.startsWith('fcl '))return {auth:'person_session',scope:'fcl_personal'};
  return null;
}

class Failure extends Error{constructor(readonly code:string,readonly exitCode=2,readonly missing=false){super(code);}}

const ticketSchema=z.object({
  inquiry_id:z.string().uuid(),
  case_id:z.string().uuid().nullable(),
  inquiry_no:z.string().min(1).max(100).nullable(),
  submit_key:z.string().regex(keyPattern).nullable(),
  submit_digest:z.string().regex(sha256Pattern).nullable(),
  submit_body:z.unknown().nullable(),
  submit_response:z.unknown().nullable(),
  credential:z.string().min(32).max(256).nullable(),
  credential_expires_at:z.iso.datetime().nullable(),
  created_at:z.iso.datetime(),
}).strict();
const pendingSchema=z.object({
  action:z.enum(['submit','exchange','supplement','logout']),
  key:z.string().regex(keyPattern),
  digest:z.string().regex(sha256Pattern),
  body:z.unknown(),
}).strict();
const activeInquirySessionFileSchema=z.object({
  version:z.literal(1),
  origin:z.string(),
  cookie:z.string().regex(/^fc_fcl_public=[A-Za-z0-9_-]{20,4096}$/u),
  csrf_token:z.string().regex(tokenPattern),
  session_id:z.string().regex(tokenPattern),
  expires_at:z.number().int().positive(),
  ticket:ticketSchema.nullable(),
  pending:pendingSchema.nullable(),
}).strict();
const loggedOutInquirySessionFileSchema=z.object({version:z.literal(1),origin:z.string(),logged_out:z.literal(true)}).strict();
const inquirySessionFileSchema=z.union([activeInquirySessionFileSchema,loggedOutInquirySessionFileSchema]);
type InquirySessionFile=z.infer<typeof activeInquirySessionFileSchema>;
type StoredInquirySessionFile=z.infer<typeof inquirySessionFileSchema>;

interface FclHttpResponse{readonly status:number;readonly body:Record<string,unknown>;readonly setCookie:string|null}
export const fclActionTimeoutMs=(action:FclHttpAction)=>action==='document-export'?120_000:15_000;
type FclCliValues={
  help?:boolean;json?:boolean;input?:string;file?:string;endpoint?:string;
  'session-file'?:string;'inquiry-session-file'?:string;'idempotency-key'?:string;
  'credential-file'?:string;'credential-stdin'?:boolean;
};

function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
  return JSON.stringify(value);
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');

function validateCookieValue(value:string|null):string{
  const candidate=value?.split(';')[0]?.trim()??'';
  if(!/^fc_fcl_public=[A-Za-z0-9_-]{20,4096}$/u.test(candidate))throw new Failure('inquiry_session_cookie_missing',1);
  return candidate;
}

async function readPrivate(filename:string,maximum:number,code:string):Promise<Buffer>{
  let file;
  try{file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){
    const missing=(error as NodeJS.ErrnoException).code==='ENOENT';
    throw new Failure((error as NodeJS.ErrnoException).code==='ELOOP'&&code.startsWith('inquiry_session')?'inquiry_session_file_invalid':code,2,missing);
  }
  try{
    const stat=await file.stat();
    const owned=process.platform==='win32'||typeof process.getuid!=='function'||stat.uid===process.getuid();
    if(!stat.isFile()||stat.size>maximum||(process.platform!=='win32'&&((stat.mode&0o077)!==0||!owned)))throw new Failure(code);
    const buffer=Buffer.alloc(stat.size+1);let offset=0;
    while(offset<buffer.length){const result=await file.read(buffer,offset,buffer.length-offset,null);if(result.bytesRead===0)break;offset+=result.bytesRead;}
    if(offset>maximum)throw new Failure(code);
    return buffer.subarray(0,offset);
  }finally{await file.close();}
}

async function validatePrivateTarget(filename:string):Promise<void>{
  try{
    const stat=await lstat(filename);
    const owned=process.platform==='win32'||typeof process.getuid!=='function'||stat.uid===process.getuid();
    if(stat.isSymbolicLink()||!stat.isFile()||(process.platform!=='win32'&&((stat.mode&0o077)!==0||!owned)))throw new Failure('inquiry_session_file_permissions');
  }catch(error){
    if(error instanceof Failure)throw error;
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Failure('inquiry_session_file_permissions');
  }
}

async function atomicPrivateWrite(filename:string,value:unknown,createOnly=false):Promise<void>{
  await mkdir(dirname(filename),{recursive:true,mode:0o700});
  await validatePrivateTarget(filename);
  const temporary=join(dirname(filename),`.${basename(filename)}.${randomUUID()}.tmp`);
  let file;
  try{
    file=await open(temporary,'wx',0o600);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();file=undefined;
    await validatePrivateTarget(filename);
    if(createOnly){
      try{await link(temporary,filename);}catch(error){throw new Failure((error as NodeJS.ErrnoException).code==='EEXIST'?'inquiry_session_file_exists':'inquiry_session_persist_failed');}
      await unlink(temporary);
    }else await rename(temporary,filename);
    const directory=await open(dirname(filename),constants.O_RDONLY);
    try{await directory.sync();}finally{await directory.close();}
  }catch(error){
    try{await file?.close();}catch{/* close is best effort after a failed write */}
    try{await unlink(temporary);}catch{/* temp cleanup is best effort */}
    if(error instanceof Failure)throw error;
    throw new Failure('inquiry_session_persist_failed');
  }
}

async function acquirePrivateLock(filename:string):Promise<()=>Promise<void>>{
  await mkdir(dirname(filename),{recursive:true,mode:0o700});
  const lockfile=join(dirname(filename),`.${basename(filename)}.lock`);
  let file;
  try{file=await open(lockfile,'wx',0o600);}catch{throw new Failure('inquiry_session_locked');}
  try{await file.writeFile(JSON.stringify({pid:process.pid,created_at:new Date().toISOString()}));await file.sync();}finally{await file.close();}
  return async()=>{try{await unlink(lockfile);}catch{/* lock cleanup is best effort */}};
}

function parseSession(raw:Buffer):StoredInquirySessionFile{
  try{
    const parsed=inquirySessionFileSchema.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as unknown);
    if(!parsed.success)throw new Failure('inquiry_session_file_invalid');
    return parsed.data;
  }catch(error){
    if(error instanceof Failure)throw error;
    throw new Failure('inquiry_session_file_invalid');
  }
}

async function loadSession(filename:string):Promise<InquirySessionFile>{
  const stored=parseSession(await readPrivate(filename,16*1024*1024,'inquiry_session_file_unreadable'));
  if('logged_out' in stored)throw new Failure('inquiry_session_logged_out',5);
  if(!stored.ticket&&stored.pending?.action==='exchange'&&!fclPublicRequestSchemas.exchange.safeParse(stored.pending.body).success)throw new Failure('inquiry_session_file_invalid');
  if(stored.expires_at<=Date.now())throw new Failure('inquiry_session_expired',5);
  if(stored.ticket&&stored.ticket.submit_response!==null){
    const submit=fclPublicOutputSchemas.submit.safeParse(stored.ticket.submit_response);
    if(!submit.success)throw new Failure('inquiry_session_file_invalid');
  }
  return stored;
}

async function request(fetcher:typeof fetch,helpers:Helpers,base:URL,path:string,options:{method:'GET'|'POST';body?:unknown;cookie?:string|undefined;csrf?:string|undefined;idempotencyKey?:string|undefined;maximum:number;secrets?:readonly string[]|undefined;timeoutMs?:number|undefined}):Promise<FclHttpResponse>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??15_000);
  try{
    const response=await fetcher(new URL(path,base),{method:options.method,redirect:'error',credentials:'omit',signal:controller.signal,headers:{
      accept:'application/json',origin:base.origin,
      ...(options.cookie?{cookie:options.cookie}:{}),
      ...(options.csrf?{'x-csrf-token':options.csrf}:{}),
      ...(options.idempotencyKey?{'idempotency-key':options.idempotencyKey}:{}),
      ...(options.method==='POST'?{'content-type':'application/json'}:{}),
    },...(options.method==='GET'?{}:{body:JSON.stringify(options.body??{})})});
    const text=await helpers.readResponse(response,options.maximum);
    if(options.secrets?.some(secret=>secret&&text.includes(secret)))throw new Failure('credential_reflected',1);
    let body:Record<string,unknown>;
    try{body=JSON.parse(text) as Record<string,unknown>;}catch{throw new Failure('response_invalid',1);}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new Failure('response_invalid',1);
    return {status:response.status,body,setCookie:response.headers.get('set-cookie')};
  }catch(error){
    if(error instanceof Failure)throw error;
    throw new Failure(controller.signal.aborted?'request_timeout':'request_failed',1);
  }finally{clearTimeout(timer);}
}

function envelope(schema:z.ZodType,response:FclHttpResponse):Record<string,unknown>{
  const parsed=schema.safeParse(response.body);
  if(!parsed.success)throw new Failure('response_invalid',1);
  return parsed.data as Record<string,unknown>;
}

function statusExit(value:unknown):number{
  return ({success:0,needs_input:3,manual_review:4,blocked:5,unavailable:6} as Record<string,number>)[String(value)]??1;
}

async function readInput(values:{input?:string},io:CliIO,helpers:Helpers,maximum:number,required:boolean):Promise<unknown>{
  if(!values.input){
    if(required)throw new Failure('input_missing');
    return {};
  }
  const bytes=values.input==='-'?await helpers.readStdin((io.stdin??process.stdin) as NodeJS.ReadStream,maximum):await helpers.readFileBounded(values.input,maximum);
  return helpers.parseJson(bytes);
}

async function credentialRecovery(values:{'credential-file'?:string;'credential-stdin'?:boolean},io:CliIO,helpers:Helpers):Promise<{inquiry_id:string|null;credential:string}>{
  if(values['credential-file']&&values['credential-stdin'])throw new Failure('credential_source_ambiguous');
  const bytes=values['credential-stdin']?await helpers.readStdin((io.stdin??process.stdin) as NodeJS.ReadStream,4096):values['credential-file']?await readPrivate(values['credential-file'],4096,'credential_file_unreadable'):null;
  if(!bytes)throw new Failure('credential_source_required');
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();}catch{throw new Failure('credential_invalid');}
  let value:unknown;
  try{value=JSON.parse(text) as unknown;}catch{value=text;}
  if(typeof value==='string'){
    if(value.length<32||value.length>256)throw new Failure('credential_invalid');
    return {inquiry_id:null,credential:value};
  }
  const parsed=z.object({inquiry_id:z.string().uuid(),credential:z.string().min(32).max(256)}).strict().safeParse(value);
  if(!parsed.success)throw new Failure('credential_invalid');
  return parsed.data;
}

function sanitizedSubmit(response:Record<string,unknown>,file:string,replay=false){
  const data=response.data as Record<string,unknown>;
  const {credential:_credential,...metadata}=data;void _credential;
  const sanitized={...metadata,recovery_saved:true,replay:replay||data.replay===true};
  return {...response,data:sanitized,file};
}

async function writePdfResponse(response:Record<string,unknown>,file:string):Promise<Record<string,unknown>>{
  if(response.status!=='success')return response;
  const data=response.data as Record<string,unknown>;
  if(typeof data.content_base64!=='string')throw new Failure('response_invalid',1);
  const bytes=Buffer.from(data.content_base64,'base64');
  if(bytes.byteLength!==data.byte_length||bytes.byteLength>8*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-'||createHash('sha256').update(bytes).digest('hex')!==data.sha256)throw new Failure('pdf_integrity_failed',1);
  if(data.mode==='history'&&(data.historical!==true||data.valid_now!==false))throw new Failure('pdf_history_metadata_invalid',1);
  let output;
  try{output=await open(file,'wx',0o600);}catch{throw new Failure('pdf_file_exists');}
  try{await output.writeFile(bytes);await output.sync();}finally{await output.close();}
  const {content_base64:_content,file:_serverFile,...metadata}=data;void _content;void _serverFile;
  return {...response,data:{...metadata,file}};
}

async function staffCommand(action:FclHttpAction,values:FclCliValues,io:CliIO,helpers:Helpers):Promise<number>{
  const output=io.stdout??(value=>{process.stdout.write(value);});
  const filename=values['session-file'];
  if(!filename)throw new Failure('session_file_required');
  const session=helpers.parseJson(await readPrivate(filename,4096,'session_file_invalid')) as {origin?:unknown;session_token?:unknown;csrf_token?:unknown;expires_at?:unknown};
  if(typeof session.origin!=='string'||typeof session.session_token!=='string'||typeof session.csrf_token!=='string'||typeof session.expires_at!=='number'||session.expires_at<=Date.now())throw new Failure('session_file_invalid');
  const base=helpers.endpoint(values.endpoint??session.origin);
  if(base.origin!==session.origin)throw new Failure('session_origin_mismatch');
  const method=FCL_STAFF_ACTION_METHODS[action];
  const maximum=FCL_HTTP_RESPONSE_LIMITS[action];
  const key=values['idempotency-key'];
  if(fclStaffWriteActions.has(action)&&(!key||!keyPattern.test(key)))throw new Failure('idempotency_key_required');
  if(!fclStaffWriteActions.has(action)&&key)throw new Failure('unexpected_idempotency_key');
  const body=values.input===undefined?(action==='case-list'?{limit:25,status:null,cursor:null}:{}):await readInput(values,io,helpers,FCL_HTTP_BODY_LIMITS[action],true);
  const parsed=fclHttpRequestSchemas[action].safeParse(body);
  if(!parsed.success)throw new Failure('input_schema_invalid');
  const query=new URLSearchParams();
  if(method==='GET')for(const [name,value] of Object.entries(parsed.data as Record<string,unknown>)){
    if(value===null||value===undefined)continue;
    if(typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')throw new Failure('query_invalid');
    query.set(name,String(value));
  }
  const path='/console/api/v1/fcl/'+action+(query.size?'?'+query.toString():'');
  const response=await request(io.fetch??fetch,helpers,base,path,{method,body:method==='POST'?parsed.data:undefined,cookie:`fc_portal_session=${session.session_token}`,csrf:method==='POST'?session.csrf_token:undefined,idempotencyKey:key,maximum,secrets:[session.session_token,session.csrf_token],timeoutMs:fclActionTimeoutMs(action)});
  let result=envelope(fclHttpResponseSchemas[action],response);
  if(action==='document-export'&&result.status==='success'){
    if(!values.file)throw new Failure('pdf_file_required');
    result=await writePdfResponse(result,values.file);
  }
  output(JSON.stringify(result,null,values.json?undefined:2)+'\n');
  return statusExit(result.status);
}

async function establishPublicSession(filename:string,base:URL,existing:InquirySessionFile|null,io:CliIO,helpers:Helpers):Promise<{session:InquirySessionFile;response:Record<string,unknown>}>{
  const response=await request(io.fetch??fetch,helpers,base,FCL_PUBLIC_ROUTES.session.path,{method:'GET',cookie:existing?.cookie,maximum:FCL_HTTP_RESPONSE_LIMITS['case-get']});
  const result=envelope(fclPublicOutputSchemas.session,response);
  if(result.status!=='success')return {session:existing??({} as InquirySessionFile),response:result};
  const data=result.data as {session:{session_id:string;csrf_token:string};inquiry_id:string|null;capability:unknown};
  if(existing&&data.session.session_id!==existing.session_id)throw new Failure('inquiry_session_identity_changed',5);
  const cookie=validateCookieValue(response.setCookie??existing?.cookie??null);
  const session:InquirySessionFile={version:1,origin:base.origin,cookie,csrf_token:data.session.csrf_token,session_id:data.session.session_id,expires_at:existing?.expires_at??Date.now()+30*24*60*60_000,ticket:existing?.ticket??null,pending:existing?.pending??null};
  await atomicPrivateWrite(filename,session,existing===null);
  return {session,response:result};
}

async function publicCommand(action:FclPublicAction,values:FclCliValues,io:CliIO,helpers:Helpers):Promise<number>{
  const output=io.stdout??(value=>{process.stdout.write(value);});
  const originalFile=values['inquiry-session-file'];
  if(!originalFile)throw new Failure('inquiry_session_file_required');
  const release=await acquirePrivateLock(originalFile);
  try{
    let session:InquirySessionFile|null;
    try{session=await loadSession(originalFile);}catch(error){if(error instanceof Failure&&error.missing)session=null;else throw error;}
    if(action==='session'){
      if(values.input!==undefined||values['idempotency-key']!==undefined||values.file!==undefined||values['credential-file']!==undefined||values['credential-stdin']!==undefined)throw new Failure('unexpected_inquiry_option');
      const base=helpers.endpoint(values.endpoint??session?.origin??'https://www.freightclaw.net');
      if(session&&base.origin!==session.origin)throw new Failure('inquiry_session_origin_mismatch');
      const established=await establishPublicSession(originalFile,base,session,io,helpers);
      if(established.response.status!=='success'){output(JSON.stringify(established.response,null,values.json?undefined:2)+'\n');return statusExit(established.response.status);}
      const data=established.response.data as {inquiry_id:string|null;capability:unknown};
      output(JSON.stringify({...established.response,data:{auth:'public_inquiry_session',inquiry_id:data.inquiry_id,capability:data.capability}},null,values.json?undefined:2)+'\n');
      return 0;
    }
    let recovery:{inquiry_id:string|null;credential:string}|null=null;
    if(values['credential-file']!==undefined||values['credential-stdin']===true)recovery=await credentialRecovery(values,io,helpers);
    let base:URL;
    if(!session){
      if(action!=='exchange'||!recovery?.inquiry_id)throw new Failure('inquiry_session_file_unreadable');
      base=helpers.endpoint(values.endpoint??'https://www.freightclaw.net');
      const established=await establishPublicSession(originalFile,base,null,io,helpers);
      if(established.response.status!=='success'){output(JSON.stringify(established.response,null,values.json?undefined:2)+'\n');return statusExit(established.response.status);}
      session=established.session;
    }else{
      base=helpers.endpoint(values.endpoint??session.origin);
      if(base.origin!==session.origin)throw new Failure('inquiry_session_origin_mismatch');
    }
    if(action==='get'){
      if(values.input!==undefined||values['idempotency-key']!==undefined||values.file!==undefined||recovery)throw new Failure('unexpected_inquiry_option');
      if(!session.ticket)throw new Failure('inquiry_ticket_missing');
      const response=await request(io.fetch??fetch,helpers,base,FCL_PUBLIC_ROUTES.get.path+'?inquiry_id='+encodeURIComponent(session.ticket.inquiry_id),{method:'GET',cookie:session.cookie,maximum:FCL_HTTP_RESPONSE_LIMITS['case-get'],secrets:[session.csrf_token]});
      const result=envelope(fclPublicOutputSchemas.get,response);
      if(result.status==='success'){
        const data=result.data as {inquiry_no:string};
        if(session.ticket.inquiry_no!==data.inquiry_no)await atomicPrivateWrite(originalFile,{...session,ticket:{...session.ticket,inquiry_no:data.inquiry_no}});
      }
      output(JSON.stringify(result,null,values.json?undefined:2)+'\n');return statusExit(result.status);
    }
    const key=values['idempotency-key'];
    if(!key||!keyPattern.test(key))throw new Failure('idempotency_key_required');
    if(values.file!==undefined)throw new Failure('unexpected_file');
    const expectedAction=action;
    let body:unknown;
    if(action==='submit'){
      if(recovery)throw new Failure('unexpected_credential_source');
      body=await readInput(values,io,helpers,FCL_PUBLIC_BODY_LIMITS.submit,true);
      const parsed=fclPublicRequestSchemas.submit.safeParse(body);if(!parsed.success)throw new Failure('input_schema_invalid');body=parsed.data;
      const requestDigest=digest(body);
      if(session.ticket){
        if(session.ticket.submit_key!==key||session.ticket.submit_digest!==requestDigest||session.ticket.submit_body===null)throw new Failure('inquiry_ticket_exists');
        body=session.ticket.submit_body;
      }
      if(session.pending&&(session.pending.action!=='submit'||session.pending.key!==key||session.pending.digest!==digest(body)))throw new Failure('inquiry_pending_mismatch');
      body=session.pending?.body??body;
    }else if(action==='supplement'){
      if(recovery)throw new Failure('unexpected_credential_source');
      if(!session.ticket)throw new Failure('inquiry_ticket_missing');
      body=await readInput(values,io,helpers,FCL_PUBLIC_BODY_LIMITS.supplement,true);
      const parsed=fclPublicRequestSchemas.supplement.safeParse(body);if(!parsed.success)throw new Failure('input_schema_invalid');
      if((parsed.data as {inquiry_id:string}).inquiry_id!==session.ticket.inquiry_id)throw new Failure('inquiry_ticket_mismatch');
      const requestDigest=digest(parsed.data);
      if(session.pending&&(session.pending.action!=='supplement'||session.pending.key!==key||session.pending.digest!==requestDigest))throw new Failure('inquiry_pending_mismatch');
      body=session.pending?.body??parsed.data;
    }else if(action==='exchange'){
      if(values.input!==undefined)throw new Failure('unexpected_input');
      const stored=session.ticket?.credential??null;
      const pendingExchangeResult=session.pending?.action==='exchange'?fclPublicRequestSchemas.exchange.safeParse(session.pending.body):null;
      const pendingExchange=pendingExchangeResult?.success?pendingExchangeResult.data:null;
      if(session.pending?.action==='exchange'&&!pendingExchange)throw new Failure('inquiry_session_file_invalid');
      const credential=recovery?.credential??pendingExchange?.credential??stored;
      if(!credential)throw new Failure('credential_source_required');
      const inquiryId=recovery?.inquiry_id??pendingExchange?.inquiry_id??session.ticket?.inquiry_id;
      if(!inquiryId)throw new Failure('inquiry_ticket_missing');
      if(session.ticket&&session.ticket.inquiry_id!==inquiryId)throw new Failure('inquiry_ticket_mismatch');
      const parsed=fclPublicRequestSchemas.exchange.safeParse({inquiry_id:inquiryId,credential});if(!parsed.success)throw new Failure('credential_invalid');
      const requestDigest=digest(parsed.data);
      if(session.pending&&(session.pending.action!=='exchange'||session.pending.key!==key||session.pending.digest!==requestDigest))throw new Failure('inquiry_pending_mismatch');
      body=session.pending?.body??parsed.data;
    }else{
      if(values.input!==undefined||recovery)throw new Failure('unexpected_inquiry_option');
      body={};
    }
    if(!session.pending)await atomicPrivateWrite(originalFile,{...session,pending:{action:expectedAction,key,digest:digest(body),body}});
    const route=FCL_PUBLIC_ROUTES[action];
    const requestSecrets=[session.csrf_token,...(action==='exchange'&&typeof (body as {credential?:unknown}).credential==='string'?[(body as {credential:string}).credential]:[])];
    const response=await request(io.fetch??fetch,helpers,base,route.path,{method:'POST',body,cookie:session.cookie,csrf:session.csrf_token,idempotencyKey:key,maximum:FCL_HTTP_RESPONSE_LIMITS['case-get'],secrets:requestSecrets});
    const result=envelope(fclPublicOutputSchemas[action],response);
    if(result.status==='success'){
      if(action==='submit'){
        const data=result.data as {inquiry_id:string;case_id:string;inquiry_no:string;credential:string;credential_expires_at:string};
        if(session.ticket&&session.ticket.inquiry_id!==data.inquiry_id)throw new Failure('inquiry_submit_mismatch',1);
        const ticket={inquiry_id:data.inquiry_id,case_id:data.case_id,inquiry_no:data.inquiry_no,submit_key:key,submit_digest:digest(body),submit_body:body,submit_response:null,credential:session.ticket?.credential??data.credential,credential_expires_at:session.ticket?.credential_expires_at??data.credential_expires_at,created_at:session.ticket?.created_at??new Date().toISOString()};
        await atomicPrivateWrite(originalFile,{...session,pending:null,ticket});
        output(JSON.stringify(sanitizedSubmit(result,originalFile),null,values.json?undefined:2)+'\n');return 0;
      }
      if(action==='exchange'){
        const cookie=validateCookieValue(response.setCookie??session.cookie);
        const inquiryId=(body as {inquiry_id:string}).inquiry_id;
        const ticket=session.ticket?{...session.ticket,inquiry_id:inquiryId,credential:null,credential_expires_at:null,submit_response:null}:{inquiry_id:inquiryId,case_id:null,inquiry_no:null,submit_key:null,submit_digest:null,submit_body:null,submit_response:null,credential:null,credential_expires_at:null,created_at:new Date().toISOString()};
        await atomicPrivateWrite(originalFile,{...session,cookie,pending:null,ticket});
        output(JSON.stringify(result,null,values.json?undefined:2)+'\n');return 0;
      }
      if(action==='logout'){
        await atomicPrivateWrite(originalFile,{version:1,origin:base.origin,logged_out:true});
        output(JSON.stringify(result,null,values.json?undefined:2)+'\n');return 0;
      }
      await atomicPrivateWrite(originalFile,{...session,pending:null});
      output(JSON.stringify(result,null,values.json?undefined:2)+'\n');return 0;
    }
    await atomicPrivateWrite(originalFile,{...session,pending:null});
    output(JSON.stringify(result,null,values.json?undefined:2)+'\n');
    return statusExit(result.status);
  }finally{await release();}
}

export async function runFclWorkspace(args:string[],io:CliIO,helpers:Helpers):Promise<number>{
  const output=io.stdout??(value=>{process.stdout.write(value);});
  const errorOutput=io.stderr??(value=>{process.stderr.write(value);});
  let compact=false;
  try{
    let parsed;
    try{parsed=parseArgs({args,allowPositionals:true,tokens:true,options:{
      help:{type:'boolean',short:'h'},json:{type:'boolean'},input:{type:'string',short:'i'},file:{type:'string'},
      endpoint:{type:'string'},'session-file':{type:'string'},'inquiry-session-file':{type:'string'},
      'idempotency-key':{type:'string'},'credential-file':{type:'string'},'credential-stdin':{type:'boolean'},
    }});}catch{throw new Failure('arguments_invalid');}
    const optionNames=parsed.tokens.filter(token=>token.kind==='option').map(token=>token.name);
    if(new Set(optionNames).size!==optionNames.length)throw new Failure('duplicate_option');
    const values=parsed.values;const {positionals}=parsed;compact=values.json===true;
    const label=positionals.join(' ');
    if(values.help||!label){output('FreightClaw FCL CLI\nworkspace fcl <action> --session-file <私有人员会话文件>\nworkspace fcl inquiry session|submit|exchange|get|supplement|logout --inquiry-session-file <私有本票文件>\n');return 0;}
    if(positionals[0]!=='fcl'||positionals.length<2||positionals.length>3)throw new Failure('command_unknown');
    if(positionals[1]==='inquiry'){
      if(positionals.length!==3)throw new Failure('command_unknown');
      const action=positionals[2] as FclPublicAction;
      if(!Object.hasOwn(FCL_PUBLIC_ROUTES,action))throw new Failure('command_unknown');
      if(values['session-file']!==undefined)throw new Failure('unexpected_session_file');
      return await publicCommand(action,values,io,helpers);
    }else{
      if(positionals.length!==2)throw new Failure('command_unknown');
      const action=positionals[1] as FclHttpAction;
      if(!fclHttpActions.includes(action))throw new Failure('command_unknown');
      if(values['inquiry-session-file']!==undefined||values['credential-file']!==undefined||values['credential-stdin']!==undefined)throw new Failure('unexpected_inquiry_option');
      if(values.file!==undefined&&action!=='document-export')throw new Failure('unexpected_file');
      if(action==='document-export'&&values.file===undefined)throw new Failure('pdf_file_required');
      return await staffCommand(action,values,io,helpers);
    }
  }catch(error){
    const known=error instanceof Failure,failure=known?error:{code:'fcl_cli_failed',exitCode:1} as Failure;
    errorOutput(JSON.stringify({cli_error:{code:failure.code,message:failure.code}},null,compact?undefined:2)+'\n');
    return failure.exitCode;
  }
}
