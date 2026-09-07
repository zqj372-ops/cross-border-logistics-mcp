import {rateTableInput,readRateWorkbook,parseRateSheet,mergeRateSheet,exportRateRows} from '../../services/quote-native/admin-tables';
import type {ResidentialRates} from '../../services/quote-native/contracts';
import { browseCustoms, customsBrowseInput } from '../../services/customs-native/catalog';
import type { CustomsDataset } from '../../services/customs-native/contracts';
import { commands as publicCommands, validateResponse as validatePublicResponse } from './contracts';
import { inputSchema as customsInput } from '../../services/access-gateway/portal/business/customs-client';
import { singleInputSchema as taxInput, batchInputSchema as taxBatchInput } from '../../services/access-gateway/portal/business/tax-client';
import { zoneInputSchema } from '../../services/access-gateway/portal/business/quote-client';
import { freightcomInputSchema } from '../../services/access-gateway/portal/business/freightcom-client';
import { customsHistoryListInput, customsHistoryGetInput, customsHistoryListResponse, customsHistoryGetResponse } from '../../services/access-gateway/portal/business/customs-history-client';
import { customsSaveSchema, residentialSaveSchema, nativePublishSchema, nativeRollbackSchema, nativeDisableSchema } from '../../services/access-gateway/portal/native-admin-contracts';
import { freightcomSaveSchema, freightcomDisableSchema, nativeDataSchema, nativeResponseSchema, freightcomViewSchema } from '../../services/access-gateway/portal/native-admin-contracts';
import { caseSchemas, validCaseInput, validateCaseResponse } from './workspace-contracts';
import { constants } from 'node:fs';
import { open, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CliIO } from './cli';
import { channelInput, channelSave, channelPublish, channelDisable, channelRollback, channelViewSchema, channelListSchema, channelPreviewSchema, channelHistorySchema, CHANNEL_VERSION } from '../../services/access-gateway/portal/channel-contracts';
type Helpers={endpoint:(s:string)=>URL;readFileBounded:(s:string,n:number,secret?:boolean)=>Promise<Buffer>;readStdin:(s:NodeJS.ReadStream,n:number)=>Promise<Buffer>;parseJson:(b:Uint8Array)=>unknown;readResponse:(r:Response,maximum?:number)=>Promise<string>};
const map=[
 ['whoami','GET','/session','当前登录身份'],['state','GET','/state','当前企业、成员与应用'],['organizations','GET','/my-organizations','可进入的企业'],['use','POST','/session/organization','切换当前企业'],
 ['cases list','GET','/cases','查询询价列表'],['cases get','GET','/cases/:id','读取询价与进度'],['cases create','POST','/cases','提交询价'],['cases update','POST','/cases/:id/update','管理询价进度'],['cases reply','POST','/cases/:id/reply','补充询价资料'],
 ['channels list','GET','/admin/channels','查看渠道与仓库'],['channels get','GET','/admin/channels/:id','读取渠道草稿与发布版本'],['channels create','POST','/admin/channels','新增渠道草稿'],['channels save','POST','/admin/channels/:id/save','保存渠道草稿'],['channels preview','GET','/admin/channels/:id/preview','预览发布或回退'],['channels publish','POST','/admin/channels/:id/publish','确认发布渠道信息'],['channels disable','POST','/admin/channels/:id/disable','停用渠道'],['channels history','GET','/admin/channels/:id/history','发布版本与操作记录'],['channels rollback','POST','/admin/channels/:id/rollback','确认回退指定版本'],
 ['customs-data browse','GET','/admin/customs-data','按发布或草稿版本检索税号、税率、措施、单证和来源'],
 ['customs-data get','GET','/admin/customs-data','关务数据 get'],
 ['customs-data save','POST','/admin/customs-data/save','关务数据 save'],
 ['customs-data preview','GET','/admin/customs-data/preview','关务数据 preview'],
 ['customs-data publish','POST','/admin/customs-data/publish','关务数据 publish'],
 ['customs-data disable','POST','/admin/customs-data/disable','关务数据 disable'],
 ['customs-data rollback','POST','/admin/customs-data/rollback','关务数据 rollback'],
 ['residential-rates import-preview','GET','/admin/residential-rates','读取 --file 表格并预览合并到草稿；不保存、不发布'],
 ['residential-rates export','GET','/admin/residential-rates','将选定草稿或发布版本导出到 --file CSV'],
 ['residential-rates get','GET','/admin/residential-rates','私人地址运价 get'],
 ['residential-rates save','POST','/admin/residential-rates/save','私人地址运价 save'],
 ['residential-rates preview','GET','/admin/residential-rates/preview','私人地址运价 preview'],
 ['residential-rates publish','POST','/admin/residential-rates/publish','私人地址运价 publish'],
 ['residential-rates disable','POST','/admin/residential-rates/disable','私人地址运价 disable'],
 ['residential-rates rollback','POST','/admin/residential-rates/rollback','私人地址运价 rollback'],
 ['freightcom get','GET','/admin/freightcom','承运商配置 get'],
 ['freightcom save','POST','/admin/freightcom/save','承运商配置 save'],
 ['freightcom disable','POST','/admin/freightcom/disable','承运商配置 disable'],
 ['customs query','POST','/business/customs/query','关务查询'],['tax estimate','POST','/business/customs/tax-estimate','税费估算'],['tax batch','POST','/business/customs/tax-estimates/batch','批量税费估算'],['quote self','POST','/business/quote/preview','自有运价试算'],['quote freightcom','POST','/business/quote/freightcom-ltl-preview','承运商实时报价'],['customs-history list','POST','/business/customs/history/list','本人关务历史'],['customs-history get','POST','/business/customs/history/get','读取历史快照'],
] as const;
const schemas:Record<string,z.ZodType>={'residential-rates import-preview':rateTableInput,'residential-rates export':rateTableInput,'customs-data browse':customsBrowseInput,'channels create':channelInput,'channels save':channelSave,'channels publish':channelPublish,'channels disable':channelDisable,'channels rollback':channelRollback};
for(const name of ['customs-data','residential-rates']){schemas[name+' save']=name==='customs-data'?customsSaveSchema:residentialSaveSchema;schemas[name+' publish']=nativePublishSchema;schemas[name+' rollback']=nativeRollbackSchema;schemas[name+' disable']=nativeDisableSchema;}schemas['freightcom save']=freightcomSaveSchema;schemas['freightcom disable']=freightcomDisableSchema;
Object.assign(schemas,{'customs query':customsInput,'tax estimate':taxInput,'tax batch':taxBatchInput,'quote self':zoneInputSchema,'quote freightcom':freightcomInputSchema,'customs-history list':customsHistoryListInput,'customs-history get':customsHistoryGetInput});
const token=z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u);
const sessionSchema=z.object({origin:z.string(),session_token:token,csrf_token:token,expires_at:z.number()}).strict();
const pendingSchema=z.object({origin:z.string(),device_secret:token,user_code:z.string().regex(/^[A-F0-9]{8}$/u),expires_at:z.number()}).strict();
class Failure extends Error{constructor(readonly code:string,readonly exitCode=2){super(code);}}
export async function runWorkspace(args:string[],io:CliIO,helpers:Helpers):Promise<number>{
 const output=io.stdout??(s=>{process.stdout.write(s);}),errorOutput=io.stderr??(s=>{process.stderr.write(s);});const env=io.env??process.env;
 try{
  const {values,positionals,tokens}=parseArgs({args,allowPositionals:true,tokens:true,options:{help:{type:'boolean',short:'h'},json:{type:'boolean'},input:{type:'string',short:'i'},file:{type:'string'},id:{type:'string'},'session-file':{type:'string'},endpoint:{type:'string'},'idempotency-key':{type:'string'}}});
  const optionNames=tokens.filter(t=>t.kind==='option').map(t=>t.name);if(new Set(optionNames).size!==optionNames.length)throw new Failure('duplicate_option');
  const emit=(value:unknown)=>output(JSON.stringify(value,null,values.json?undefined:2)+'\n');const name=positionals.join(' ');
  if(values.help||!name){output('FreightClaw 人员工作台 CLI\nworkspace login start --session-file <私有文件> [--endpoint <地址>]\n打开返回链接并在网页确认，再运行 workspace login finish --session-file <同一文件>\nworkspace commands 列出已实现操作；workspace schema channels create 查看输入。\n价格表 import-preview / export 使用 --file 指定本地表格。\n业务命令使用 --session-file，--id 指定记录，--input 提供 JSON（或 - 读标准输入）。\n写入要求 --idempotency-key，同一请求重试保留同一个值；不自动重试。\nworkspace logout 撤销 CLI 会话。查询 API Key 不自动获得管理权限。\n');return 0;}
  if(name==='commands'){emit(map.map(([command,method,path,description])=>({command:`workspace ${command}`,method,path,description,auth:'person_session'})));return 0;}
  if(positionals[0]==='schema'){const schema=schemas[positionals.slice(1).join(' ')];if(!schema){const frozen=caseSchemas[positionals.slice(1).join(' ')];if(!frozen)throw new Failure('schema_not_available');emit(frozen);}else emit(z.toJSONSchema(schema));return 0;}
  const filename=values['session-file']??env.FREIGHTCLAW_SESSION_FILE;if(!filename)throw new Failure('session_file_required');
  const suppliedOrigin=values.endpoint??env.FREIGHTCLAW_ENDPOINT;
  let stored:Record<string,unknown>|undefined;if(name!=='login start'){const input=helpers.parseJson(await helpers.readFileBounded(filename,4096,true));stored=(name==='login finish'?pendingSchema:sessionSchema).parse(input);}
  const base=helpers.endpoint(suppliedOrigin??(typeof stored?.origin==='string'?stored.origin:'https://www.freightclaw.net'));if(stored&&base.origin!==stored.origin)throw new Failure('session_origin_mismatch');
  const request=async(path:string,method='GET',body?:unknown,authenticated=true)=>{
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
   try{const response=await(io.fetch??fetch)(new URL('/console/api/v1'+path,base),{method,redirect:'error',credentials:'omit',signal:controller.signal,headers:{accept:'application/json',origin:base.origin,...(authenticated?{cookie:`fc_portal_session=${String(stored!.session_token)}`,'x-csrf-token':String(stored!.csrf_token)}:{}),...(method==='GET'?{}:{'content-type':'application/json','idempotency-key':values['idempotency-key']??randomUUID()})},...(method==='GET'?{}:{body:JSON.stringify(body??{})})});const text=await helpers.readResponse(response,name.startsWith('customs-data ')||name.startsWith('residential-rates ')?40*1024*1024:undefined);let data:Record<string,unknown>;try{data=JSON.parse(text) as Record<string,unknown>;}catch{throw new Failure('response_invalid',1);}if(!data||typeof data!=='object')throw new Failure('response_invalid',1);
    if(authenticated&&[stored!.session_token,stored!.csrf_token].some(t=>text.includes(String(t)))&&path!=='/session'&&path!=='/session/organization'&&path!=='/logout')throw new Failure('credential_reflected',1);
    if(!response.ok){const status=String(data.status);throw new Failure(status==='blocked'?'permission_or_session_denied':status==='needs_input'?'input_or_version_invalid':'service_unavailable',status==='blocked'?5:status==='needs_input'?3:6);}return data;
   }finally{clearTimeout(timer);}
  };
  const save=async(value:unknown,create=false)=>{await mkdir(dirname(filename),{recursive:true,mode:0o700});const file=await open(filename,create?'wx':constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{const st=await file.stat();if(!st.isFile()||process.platform!=='win32'&&((st.mode&0o077)!==0||st.uid!==process.getuid?.()))throw new Failure('session_file_permissions');await file.truncate(0);await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}};
  if(name==='login start'){const response=await request('/cli-auth/start','POST',{},false);const data=response.data as Record<string,unknown>;const pending=pendingSchema.parse({origin:base.origin,device_secret:data.device_secret,user_code:data.user_code,expires_at:Date.now()+Number(data.expires_in)*1000});await save(pending,true);emit({status:'needs_input',verification_url:`${base.origin}/console/#cli-authorize/${pending.user_code}`,user_code:pending.user_code,next:'请在网页核对代码并确认，再执行 workspace login finish。'});return 3;}
  if(Number(stored!.expires_at)<=Date.now())throw new Failure('session_expired',5);
  if(name==='login finish'){const response=await request('/cli-auth/poll','POST',{device_secret:stored!.device_secret},false);const data=response.data as Record<string,unknown>;if(data.state==='pending'){emit({status:'needs_input',reason:'等待网页确认'});return 3;}if(data.state!=='authorized')throw new Failure('response_invalid',1);const session=sessionSchema.parse({origin:base.origin,session_token:data.session_token,csrf_token:data.csrf_token,expires_at:data.expires_at});await save(session);emit({status:'success',expires_at:new Date(session.expires_at).toISOString()});return 0;}
  if(name==='logout'){await request('/logout','POST',{});await unlink(filename);emit({status:'success'});return 0;}
  const tableCommand=['residential-rates import-preview','residential-rates export'].includes(name);
  if(Boolean(values.file)!==tableCommand)throw new Failure(tableCommand?'spreadsheet_file_required':'unexpected_file');
  const command=map.find(c=>c[0]===name);if(!command)throw new Failure('command_unknown');
  let path:string=command[2];if(path.includes(':id')){if(!values.id||!/^[A-Za-z0-9_-]{1,128}$/u.test(values.id))throw new Failure('id_required');path=path.replace(':id',encodeURIComponent(values.id));}else if(values.id)throw new Failure('unexpected_id');
  let input:unknown={};if(values.input){input=helpers.parseJson(values.input==='-'?await helpers.readStdin((io.stdin??process.stdin) as NodeJS.ReadStream,name.startsWith("customs-data ")||name.startsWith("residential-rates ")?16*1024*1024:15000):await helpers.readFileBounded(values.input,name.startsWith("customs-data ")||name.startsWith("residential-rates ")?16*1024*1024:32768,name==="freightcom save"));}if(!input||typeof input!=='object'||Array.isArray(input))throw new Failure('input_invalid');
  if(!validCaseInput(name,input)||schemas[name]&&!schemas[name].safeParse(input).success)throw new Failure('input_schema_invalid');
  if(command[1]==='POST'&&!path.startsWith('/business/')&&(!values['idempotency-key']||!/^[A-Za-z0-9._:-]{16,128}$/u.test(values['idempotency-key'])))throw new Failure('idempotency_key_required');
  if(command[1]==='GET'){const query=new URLSearchParams();for(const[k,v]of Object.entries(name==='customs-data browse'||tableCommand?{}:input)){if(!['string','number','boolean'].includes(typeof v))throw new Failure('query_invalid');query.set(k,String(v));}if(query.size)path+='?'+query.toString();}
  const response=await request(path,command[1],path.startsWith('/business/')?{input}:input);
  if(response.data!==null){const publicName=({'customs query':'customs query','tax estimate':'customs tax','tax batch':'customs tax-batch','quote self':'quote zone','quote freightcom':'quote freightcom'} as Record<string,string>)[name];if(publicName&&!validatePublicResponse(publicCommands.find(c=>c.name===publicName)!,200,response))throw new Failure('response_invalid',1);}
  if(name.startsWith('customs-history ')&&response.data!==null&&!(name.endsWith(' list')?customsHistoryListResponse:customsHistoryGetResponse).safeParse(response).success)throw new Failure('response_invalid',1);
  if(response.status==='success'&&(name.startsWith('customs-data ')||name.startsWith('residential-rates ')||name.startsWith('freightcom '))){const schema=name.startsWith('freightcom ')?freightcomViewSchema:nativeDataSchema(name.startsWith('customs-data ')?'customs':'residential',name.endsWith(' preview'));if(!nativeResponseSchema(schema).safeParse(response).success)throw new Failure('response_invalid',1);}
  if(name.startsWith('channels ')&&response.status==='success'){const dataSchema=name==='channels list'?channelListSchema:name==='channels preview'?channelPreviewSchema:name==='channels history'?channelHistorySchema:channelViewSchema;if(!z.object({schema_version:z.literal(CHANNEL_VERSION),status:z.literal('success'),data:dataSchema,reason_codes:z.array(z.string()).length(0)}).strict().safeParse(response).success)throw new Failure('response_invalid',1);}
  if(name.startsWith('cases ')&&response.status==='success'&&!validateCaseResponse(response))throw new Failure('response_invalid',1);
  if(tableCommand&&response.status==='success'){
   const f=rateTableInput.parse(input),view=response.data as {version:number;draft:ResidentialRates|null;active_release:{input:ResidentialRates;version:number}|null};
   const selected=f.selection==='published'?view.active_release?.input:view.draft;if(!selected)throw new Failure('selected_configuration_missing',3);
   if(name==='residential-rates export'){const file=await open(values.file!,'wx',0o600);try{await file.writeFile(exportRateRows(selected,f.table));await file.sync();}finally{await file.close();}emit({schema_version:'native-rate-table@2026-09-07.v1',status:'success',selection:f.selection,table:f.table,file:values.file,version:f.selection==='published'?view.active_release!.version:view.version});return 0;}
   if(f.selection!=='draft')throw new Failure('import_requires_draft',3);
   const workbook=await readRateWorkbook(await helpers.readFileBounded(values.file!,5*1024*1024),values.file!);const parsed=parseRateSheet(workbook.rows,f.table,selected.origin);
   const next=parsed.errors.length?null:mergeRateSheet(selected,parsed),checked=next?residentialSaveSchema.safeParse({expected_version:view.version,input:next}):null;
   const errors=[...parsed.errors,...(checked&&!checked.success?['合并后的完整草稿超出配置限制，请核对条目数量和字段。']:[])];
   emit({schema_version:'native-rate-table@2026-09-07.v1',status:errors.length?'needs_input':'success',data:{table:f.table,sheet:workbook.sheet,source_rows:parsed.source_rows,errors,save_input:checked?.success?checked.data:null},reason_codes:errors.length?['rate_import_invalid']:[]});return errors.length?3:0;
  }
  if(name==='customs-data browse'&&response.status==='success'){const view=response.data as {version:number;draft:CustomsDataset|null;active_release:{release_id:string;version:number;input:CustomsDataset}|null};emit({schema_version:'native-customs-catalog@2026-09-07.v1',status:'success',data:browseCustoms(view,input),reason_codes:[]});return 0;}
  if(name==='whoami'||name==='use'){if(response.authenticated!==true)throw new Failure('session_expired',5);if(typeof response.csrf_token==='string'&&response.csrf_token!==stored!.csrf_token){await save({...stored,csrf_token:response.csrf_token});}const {csrf_token:_secret,fixture_identities:_fixtures,...publicSession}=response;void _secret;void _fixtures;emit(publicSession);}else{if(!['success','needs_input','manual_review','blocked','unavailable'].includes(String(response.status)))throw new Failure('response_invalid',1);emit(response);return ({success:0,needs_input:3,manual_review:4,blocked:5,unavailable:6} as Record<string,number>)[String(response.status)]!;}
  return 0;
 }catch(error){const known=error instanceof Failure;errorOutput(JSON.stringify({cli_error:{code:known?error.code:'workspace_request_failed',message:known?error.code:'请求或会话文件处理失败，原始错误已隐藏。'}})+'\n');return known?error.exitCode:1;}
}
