import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {PortalError,type PortalContext,type PortalIdentity} from './contracts';
import {
  fclCaseInputSchema,
  fclCaseCustomerSupplementSchema,
  fclCasePublicSummarySchema,
  fclCaseSubmissionSchema,
} from './case-contracts';
import {
  fclHttpOutputSchemas,
  fclHttpRequestSchemas,
  FCL_HTTP_VERSION,
  type FclHttpAction,
} from './fcl-http-contracts';
import type {CaseService} from './cases';
import type {NativeAdminService} from './native-admin';
import type {DocumentWorkflowService} from '../../quote-documents/workflow';

const publicCookieName='fc_fcl_public';
const publicCookiePath='/inquiry';
const publicCookieTtlMs=30*24*60*60_000;
const publicGetRequestSchema=z.object({inquiry_id:z.string().uuid()}).strict();
const publicSupplementRequestSchema=fclCaseCustomerSupplementSchema.extend({inquiry_id:z.string().uuid()});

type FclCasePort=Pick<CaseService,'listFclCases'|'getFclCase'|'updateFclCaseStatus'|'supplementFclCaseAsStaff'|'confirmFclCase'|'submitFclInquiry'|'getFclCustomerView'|'supplementFclCase'>;
type FclRatePort=Pick<NativeAdminService,'get'|'save'|'preview'|'publish'|'disable'|'rollback'|'getFclNotification'|'saveFclNotification'>;
type FclDocumentPort=Pick<DocumentWorkflowService,
  'matchFclQuote'|'saveFclQuote'|'getFclQuote'|'listFclQuotes'|
  'fclConfig'|'saveFclConfig'|
  'saveFclDocument'|'getFclDocument'|'listFclDocuments'|'reviewFclDocument'|'approveFclDocument'|'rejectFclDocument'|'exportFclDocument'|
  'saveFclHandoff'|'getFclHandoff'>;

export interface FclHttpDependencies{
  readonly caseService:FclCasePort;
  readonly nativeAdmin:FclRatePort;
  readonly documentWorkflow:FclDocumentPort;
  readonly publicSessionSecret:string|Uint8Array;
  readonly businessDate:()=>string;
  readonly secureCookie?:boolean;
  readonly publicAttemptLimit?:number;
  readonly publicAttemptWindowMs?:number;
  readonly publicAttemptKeyLimit?:number;
  readonly now?:()=>number;
}

export interface FclPublicSession{
  readonly sessionId:string;
  readonly csrfToken:string;
  readonly inquiryId:string|null;
  readonly credential:string|null;
  readonly expiresAt:number;
}

interface FclPublicCookiePayload extends FclPublicSession{readonly v:1}
const fclPublicCookiePayloadSchema=z.object({
  v:z.literal(1),
  sessionId:z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  csrfToken:z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  inquiryId:z.string().uuid().nullable(),
  credential:z.string().min(32).max(256).nullable(),
  expiresAt:z.number().int().positive(),
}).strict();

export class FclPublicSessionManager{
  private readonly key:Buffer;
  private readonly secureCookie:boolean;
  constructor(private readonly secret:string|Uint8Array,private readonly now:()=>number=Date.now,secureCookie=false){
    const secretBytes=typeof secret==='string'?Buffer.from(secret,'utf8'):Buffer.from(secret);
    if(secretBytes.byteLength<32)throw new Error('fcl_public_session_secret_invalid');
    this.key=createHash('sha256').update(secretBytes).digest();
    this.secureCookie=secureCookie;
  }
  private encode(session:FclPublicSession):string{
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv),payload:Buffer=Buffer.from(JSON.stringify({v:1,...session}),'utf8'),ciphertext=Buffer.concat([cipher.update(payload),cipher.final()]),tag=cipher.getAuthTag();
    const value=Buffer.concat([iv,tag,ciphertext]).toString('base64url');
    if(value.length>4096)throw new PortalError('fcl_public_cookie_too_large');
    return value;
  }
  private decode(value:string):FclPublicSession|null{
    try{
      const raw=Buffer.from(value,'base64url');if(raw.length<29)return null;
      const iv=raw.subarray(0,12),tag=raw.subarray(12,28),ciphertext=raw.subarray(28),decipher=createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAuthTag(tag);
      const parsed=fclPublicCookiePayloadSchema.safeParse(JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8')) as unknown);
      if(!parsed.success)return null;
      const payload=parsed.data as FclPublicCookiePayload;
      if(payload.expiresAt<=this.now())return null;
      return {sessionId:payload.sessionId,csrfToken:payload.csrfToken,inquiryId:payload.inquiryId,credential:payload.credential,expiresAt:payload.expiresAt};
    }catch{return null;}
  }
  private cookie(value:string,maxAge:number):string{return `${publicCookieName}=${value}; Path=${publicCookiePath}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0,Math.floor(maxAge/1000))}${this.secureCookie?'; Secure':''}`;}
  private newSession():FclPublicSession{const now=this.now();return {sessionId:randomBytes(32).toString('base64url'),csrfToken:randomBytes(32).toString('base64url'),inquiryId:null,credential:null,expiresAt:now+publicCookieTtlMs};}
  read(cookieHeader:string|undefined|null):FclPublicSession|null{
    if(!cookieHeader)return null;
    const matches=cookieHeader.split(';').map(item=>item.trim()).filter(item=>item.startsWith(`${publicCookieName}=`));
    if(matches.length===0)return null;
    if(matches.length!==1)throw new PortalError('fcl_public_session_invalid');
    const value=matches[0]!.slice(publicCookieName.length+1);
    if(value.length===0||value.length>4096)throw new PortalError('fcl_public_session_invalid');
    const session=this.decode(value);
    if(!session)throw new PortalError('fcl_public_session_invalid');
    return session;
  }
  ensure(cookieHeader:string|undefined|null):{session:FclPublicSession;setCookie:string}{
    const existing=this.read(cookieHeader),session=existing??this.newSession();
    return {session,setCookie:this.cookie(this.encode(session),session.expiresAt-this.now())};
  }
  exchange(cookieHeader:string|undefined|null,inquiryId:string,credential:string):{session:FclPublicSession;setCookie:string}{
    const base=this.read(cookieHeader)??this.newSession(),session={...base,inquiryId,credential};
    return {session,setCookie:this.cookie(this.encode(session),session.expiresAt-this.now())};
  }
  clearCookie():string{return `${publicCookieName}=; Path=${publicCookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie?'; Secure':''}`;}
}

class FclPublicAttemptLimiter{
  private readonly attempts=new Map<string,{windowStarted:number;count:number}>();
  constructor(private readonly limit:number,private readonly windowMs:number,private readonly keyLimit:number,private readonly now:()=>number=Date.now){
    if(!Number.isInteger(limit)||limit<1||limit>10_000||!Number.isInteger(keyLimit)||keyLimit<1||keyLimit>100_000||!Number.isInteger(windowMs)||windowMs<1_000||windowMs>86_400_000)throw new Error('fcl_public_attempt_limit_invalid');
  }
  allow(key:string):boolean{
    const now=this.now();
    for(const [candidate,value] of this.attempts)if(value.windowStarted+this.windowMs<=now)this.attempts.delete(candidate);
    const current=this.attempts.get(key);
    if(!current&&this.attempts.size>=this.keyLimit)return false;
    if(!current||current.windowStarted+this.windowMs<=now){this.attempts.set(key,{windowStarted:now,count:1});return true;}
    if(current.count>=this.limit)return false;
    current.count+=1;return true;
  }
}

export interface FclHttpResult{readonly status:'success'|'needs_input'|'manual_review'|'blocked'|'unavailable';readonly data:unknown;readonly reason_codes:readonly string[]}

function parse<T>(schema:z.ZodType<T>,input:unknown,code:string):T{const result=schema.safeParse(input);if(!result.success)throw new PortalError(code);return result.data;}

export class FclHttpService{
  readonly publicSessions:FclPublicSessionManager;
  private readonly publicAttempts:FclPublicAttemptLimiter;
  constructor(private readonly dependencies:FclHttpDependencies){
    const now=dependencies.now??Date.now;
    this.publicSessions=new FclPublicSessionManager(dependencies.publicSessionSecret,now,dependencies.secureCookie===true);
    this.publicAttempts=new FclPublicAttemptLimiter(dependencies.publicAttemptLimit??60,dependencies.publicAttemptWindowMs??60_000,dependencies.publicAttemptKeyLimit??10_000,now);
  }
  consumePublicAttempt(key:string):void{if(!this.publicAttempts.allow(key))throw new PortalError('fcl_rate_limited');}
  capability(identity:PortalIdentity):{fcl_personal:boolean;receiver_user_id:string|null;business_date:string}{
    const ctx:PortalContext={identity,organizationId:null};
    try{
      this.dependencies.caseService.listFclCases(ctx,{limit:1,status:null,cursor:null});
      return {fcl_personal:true,receiver_user_id:identity.userId,business_date:this.businessDate()};
    }catch{
      return {fcl_personal:false,receiver_user_id:null,business_date:this.businessDate()};
    }
  }
  private businessDate():string{
    const value=this.dependencies.businessDate();
    if(!z.iso.date().safeParse(value).success)throw new PortalError('fcl_business_date_invalid');
    return value;
  }
  publicBusinessDate():string{return this.businessDate();}
  private currentnessResult(action:FclHttpAction,data:unknown):FclHttpResult{
    if(action==='rate-preview'&&typeof data==='object'&&data!==null&&(data as {can_publish?:unknown}).can_publish===false){
      return {status:'manual_review',data,reason_codes:['fcl_rate_publication_blocked']};
    }
    const currentness=(data as {currentness?:{valid_now?:boolean;reason_codes?:string[]}}|null)?.currentness;
    if(currentness?.valid_now===false)return {status:'manual_review',data,reason_codes:['fcl_currentness_manual_review']};
    const complete=(data as {completeness?:{complete?:boolean;missing_fields?:string[]}}|null)?.completeness;
    if(complete?.complete===false)return {status:'needs_input',data,reason_codes:['fcl_quote_incomplete']};
    return {status:'success',data,reason_codes:[]};
  }
  private output(action:FclHttpAction,data:unknown):FclHttpResult{
    const parsed=fclHttpOutputSchemas[action].parse(data),result=this.currentnessResult(action,parsed);
    return {...result,data:parsed};
  }
  async executeStaff(ctx:PortalContext,action:FclHttpAction,input:unknown,key:()=>string):Promise<FclHttpResult>{
    const request=parse(fclHttpRequestSchemas[action],input,'fcl_input_invalid');
    let data:unknown;
    switch(action){
      case 'case-list':data=this.dependencies.caseService.listFclCases(ctx,request);break;
      case 'case-get':data=this.dependencies.caseService.getFclCase(ctx,(request as {case_id:string}).case_id);break;
      case 'case-status':{const value=request as {case_id:string}&Record<string,unknown>;const {case_id,...body}=value;data=this.dependencies.caseService.updateFclCaseStatus(ctx,case_id,body,key());break;}
      case 'case-staff-supplement':{const value=request as {case_id:string}&Record<string,unknown>;const {case_id,...body}=value;data=this.dependencies.caseService.supplementFclCaseAsStaff(ctx,case_id,body,key());break;}
      case 'case-confirm':{const value=request as {case_id:string}&Record<string,unknown>;const {case_id,...body}=value;data=this.dependencies.caseService.confirmFclCase(ctx,case_id,body,key());break;}
      case 'rate-get':data=this.dependencies.nativeAdmin.get(ctx,'fcl');break;
      case 'rate-save':data=this.dependencies.nativeAdmin.save(ctx,'fcl',request,key());break;
      case 'rate-preview':data=this.dependencies.nativeAdmin.preview(ctx,'fcl');break;
      case 'rate-publish':data=this.dependencies.nativeAdmin.publish(ctx,'fcl',request,key());break;
      case 'rate-disable':data=this.dependencies.nativeAdmin.disable(ctx,'fcl',request,key());break;
      case 'rate-rollback':data=this.dependencies.nativeAdmin.rollback(ctx,'fcl',request,key());break;
      case 'quote-match':{const result=this.dependencies.documentWorkflow.matchFclQuote(ctx,request);data=fclHttpOutputSchemas[action].parse(result.data);return {status:result.status,data,reason_codes:result.reason_codes};}
      case 'quote-save':data=this.dependencies.documentWorkflow.saveFclQuote(ctx,request,key());break;
      case 'quote-get':data=this.dependencies.documentWorkflow.getFclQuote(ctx,request);break;
      case 'quote-list':data=this.dependencies.documentWorkflow.listFclQuotes(ctx,request);break;
      case 'issuer-config':data=this.dependencies.documentWorkflow.fclConfig(ctx);break;
      case 'issuer-config-save':data=this.dependencies.documentWorkflow.saveFclConfig(ctx,request,key());break;
      case 'document-save':data=this.dependencies.documentWorkflow.saveFclDocument(ctx,request,key());break;
      case 'document-get':data=this.dependencies.documentWorkflow.getFclDocument(ctx,request);break;
      case 'document-list':data=this.dependencies.documentWorkflow.listFclDocuments(ctx,request);break;
      case 'document-review':data=this.dependencies.documentWorkflow.reviewFclDocument(ctx,request);break;
      case 'document-approve':data=this.dependencies.documentWorkflow.approveFclDocument(ctx,request,key());break;
      case 'document-reject':data=this.dependencies.documentWorkflow.rejectFclDocument(ctx,request,key());break;
      case 'document-export':data=await this.dependencies.documentWorkflow.exportFclDocument(ctx,request,key());break;
      case 'handoff-save':data=this.dependencies.documentWorkflow.saveFclHandoff(ctx,request,key());break;
      case 'handoff-get':data=this.dependencies.documentWorkflow.getFclHandoff(ctx,request);break;
      case 'notification-get':data=this.dependencies.nativeAdmin.getFclNotification(ctx);break;
      case 'notification-save':data=this.dependencies.nativeAdmin.saveFclNotification(ctx,request,key());break;
    }
    return this.output(action,data);
  }
  async executePublicAction(ctx:PortalContext,action:'submit'|'exchange'|'get'|'supplement'|'logout',input:unknown,key:()=>string,cookieHeader:string|undefined|null):Promise<{status:FclHttpResult['status'];data:unknown;reason_codes:readonly string[];setCookie?:string}>{
    const current=this.publicSessions.read(cookieHeader);
    if(action==='exchange'||action==='logout')key();
    if(action==='submit'){
      const ensured=this.publicSessions.ensure(cookieHeader),payload=parse(fclCaseInputSchema,input,'fcl_input_invalid');
      const result=await this.dependencies.caseService.submitFclInquiry(ensured.session.sessionId,key(),payload);
      return {status:'success',data:fclCaseSubmissionSchema.parse(result),reason_codes:[],setCookie:ensured.setCookie};
    }
    if(action==='exchange'){
      const value=parse(z.object({inquiry_id:z.string().uuid(),credential:z.string().min(32).max(256)}).strict(),input,'fcl_input_invalid');
      this.dependencies.caseService.getFclCustomerView(value.inquiry_id,value.credential);
      const exchanged=this.publicSessions.exchange(cookieHeader,value.inquiry_id,value.credential);
      return {status:'success',data:{inquiry_id:value.inquiry_id},reason_codes:[],setCookie:exchanged.setCookie};
    }
    if(action==='logout')return {status:'success',data:null,reason_codes:[],setCookie:this.publicSessions.clearCookie()};
    if(!current?.inquiryId||!current.credential)throw new PortalError('fcl_not_found');
    if(action==='get'){
      const value=parse(publicGetRequestSchema,input,'fcl_input_invalid');
      if(value.inquiry_id!==current.inquiryId)throw new PortalError('fcl_ticket_mismatch');
      return {status:'success',data:fclCasePublicSummarySchema.parse(this.dependencies.caseService.getFclCustomerView(current.inquiryId,current.credential)),reason_codes:[]};
    }
    if(action!=='supplement')throw new PortalError('fcl_input_invalid');
    const wrapped=parse(publicSupplementRequestSchema,input,'fcl_input_invalid');
    const {inquiry_id,...body}=wrapped;
    if(inquiry_id!==current.inquiryId)throw new PortalError('fcl_ticket_mismatch');
    const result=this.dependencies.caseService.supplementFclCase(current.inquiryId,current.credential,body,key());
    return {status:'success',data:fclCasePublicSummarySchema.parse(result),reason_codes:[]};
  }
  async executePublic(ctx:PortalContext,action:'submit'|'exchange'|'get'|'supplement'|'logout',input:unknown,key:()=>string,cookieHeader:string|undefined|null){
    return this.executePublicAction(ctx,action,input,key,cookieHeader);
  }
}

export function fclHttpFailure(error:unknown):{http:number;body:Record<string,unknown>}{
  const code=error instanceof PortalError?error.code:error instanceof Error&&/^[a-z0-9_]+$/u.test(error.message)?error.message:'fcl_unavailable';
  if(code==='body_too_large')return {http:413,body:{schema_version:FCL_HTTP_VERSION,status:'needs_input',data:null,reason_codes:['body_too_large']}};
  const security=['authentication_required','csrf_invalid','origin_denied','invalid_host','transport_required','fcl_ticket_mismatch','method_not_allowed'].includes(code);
  const status=security?'blocked':code==='fcl_not_found'||code.includes('not_found')?'blocked':code.includes('unavailable')||code.includes('not_configured')?'unavailable':code.includes('invalid')||code.includes('input')?'needs_input':'blocked';
  const http=code==='fcl_rate_limited'?429:status==='unavailable'?503:status==='blocked'?code==='method_not_allowed'?405:code==='authentication_required'?401:403:status==='needs_input'?400:200;
  return {http,body:{schema_version:FCL_HTTP_VERSION,status,data:null,reason_codes:[code]}};
}
