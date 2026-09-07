import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createDraft, validateStep, type Draft } from '../../../apps/inquiry/model';
import { PortalError, type PortalContext } from './contracts';
import type { PortalService } from './service';
import { openPortalProductionDatabase, securePortalDatabaseFiles } from './production-persistence';

export const CASE_VERSION = 'portal-cases@2026-09-07.v1';
export const CASE_STATUSES = ['submitted','in_review','needs_input','closed','cancelled'] as const;
type CaseStatus = typeof CASE_STATUSES[number];
// Reject control characters while allowing normal multiline notes.
// eslint-disable-next-line no-control-regex
const safeText = (max:number) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const draftFields = Object.fromEntries(Object.entries(createDraft()).map(([key,value])=>[key, typeof value === 'boolean' ? z.boolean() : Array.isArray(value) ? z.array(z.string().max(40)).min(1).max(5).refine(values=>new Set(values).size===values.length) : safeText(key==='notes'?4000:254)]));
export const caseInputSchema = z.object(draftFields).strict().superRefine((input,ctx)=>{
 const value=input as Draft;
 if (!['shipping','business'].includes(value.mode)) ctx.addIssue({code:'custom',message:'invalid mode'});
 for(const step of [1,2,3]) for(const [field,message] of Object.entries(validateStep(value,step)))ctx.addIssue({code:'custom',path:[field],message});
});
export const caseUpdateSchema = z.object({expected_version:z.number().int().positive(),status:z.enum(CASE_STATUSES),public_note:safeText(2000).refine(v=>v.trim().length>0),internal_note:safeText(2000).default('')}).strict();
export const caseReplySchema = z.object({expected_version:z.number().int().positive(),message:safeText(2000).refine(v=>v.trim().length>0)}).strict();
export const caseListSchema = z.object({management:z.boolean().default(false),status:z.enum(CASE_STATUSES).optional(),cursor:z.string().max(300).optional(),limit:z.number().int().min(1).max(50).default(25)}).strict();
type Scope = {user:string;org:string|null;manager:boolean;platform:boolean};
type Row = {case_id:string;owner_id:string;organization_id:string|null;status:CaseStatus;version:number;input_json:string;created_at:string;updated_at:string};
type Event = {event_id:string;version:number;status:CaseStatus;message:string;visibility:'customer'|'internal';actor_label:string;created_at:string};
export type CaseView = {case_id:string;status:CaseStatus;version:number;input:Draft;created_at:string;updated_at:string;can_manage:boolean;can_reply:boolean;events:Event[]};
const parse = <T>(schema:z.ZodType<T>,input:unknown):T => {const result=schema.safeParse(input);if(!result.success)throw new PortalError('case_input_invalid');return result.data;};

export class CaseStore {
 readonly db:DatabaseSync;
 constructor(readonly path:string){
  this.db=openPortalProductionDatabase(path,'freightclaw-business-cases');
  const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  if(version>1){this.db.close();throw new Error('cases_schema_incompatible');}
  this.db.exec(`CREATE TABLE IF NOT EXISTS business_cases(case_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,organization_id TEXT,status TEXT NOT NULL,version INTEGER NOT NULL,input_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS business_cases_owner ON business_cases(owner_id,created_at,case_id);
   CREATE INDEX IF NOT EXISTS business_cases_org ON business_cases(organization_id,created_at,case_id);
   CREATE TABLE IF NOT EXISTS business_case_events(event_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES business_cases(case_id),version INTEGER NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,visibility TEXT NOT NULL,actor_label TEXT NOT NULL,created_at TEXT NOT NULL,actor_id TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS business_case_events_case ON business_case_events(case_id,version);
   CREATE TABLE IF NOT EXISTS business_case_idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,case_id TEXT NOT NULL REFERENCES business_cases(case_id),PRIMARY KEY(scope,key));`);
  if(!(this.db.prepare("PRAGMA table_info(business_case_events)").all() as {name:string}[]).some(column=>column.name==='actor_id')) { this.db.close(); throw new Error('cases_schema_incompatible'); }
  this.db.exec("PRAGMA user_version = 1");
  securePortalDatabaseFiles(path);
 }
 health(){try{this.db.prepare('SELECT case_id FROM business_cases LIMIT 1').get();return true;}catch{return false;}}
 close(){this.db.close();securePortalDatabaseFiles(this.path);}
}

export class CaseService {
 constructor(readonly store:CaseStore,readonly portal:Pick<PortalService,'getState'>){}
 private scope(ctx:PortalContext):Scope{
  if(!ctx.identity.emailVerified)throw new PortalError('authentication_required');
  const state=this.portal.getState(ctx).data;
  if(!state)throw new PortalError('cases_unavailable');
  const platform=ctx.identity.platformRole==='operator' && ctx.organizationId===null;
  const org=state?.current_organization;
  const membership=state?.memberships.find(m=>m.userId===ctx.identity.userId&&m.organizationId===ctx.organizationId&&m.status==='active');
  if(ctx.organizationId && (!org||org.status!=='active'||!membership))throw new PortalError('case_access_denied');
  return {user:ctx.identity.userId,org:ctx.organizationId,platform,manager:platform||!!membership&&['owner','admin'].includes(membership.role)};
 }
 private read(scope:Scope,id:string):Row{
  const row=this.store.db.prepare('SELECT * FROM business_cases WHERE case_id=?').get(id) as Row|undefined;
  if(!row||!(scope.platform||(row.owner_id===scope.user&&(row.organization_id===null||row.organization_id===scope.org))||scope.manager&&scope.org!==null&&row.organization_id===scope.org))throw new PortalError('case_not_found');
  return row;
 }
 private manages(scope:Scope,row:Row){return scope.platform||scope.manager&&scope.org!==null&&scope.org===row.organization_id;}
 private view(scope:Scope,row:Row):CaseView{
  const manages=this.manages(scope,row);
  const events=this.store.db.prepare(`SELECT event_id,version,status,message,visibility,actor_label,created_at FROM business_case_events WHERE case_id=? ${manages?'':"AND visibility='customer'"} ORDER BY version,rowid`).all(row.case_id) as Event[];
  return {case_id:row.case_id,status:row.status,version:row.version,input:JSON.parse(row.input_json) as Draft,created_at:row.created_at,updated_at:row.updated_at,can_manage:manages,can_reply:row.owner_id===scope.user&&row.status==='needs_input',events};
 }
 get(ctx:PortalContext,id:string){const scope=this.scope(ctx);return this.view(scope,this.read(scope,id));}
 list(ctx:PortalContext,input:unknown){
  const query=parse(caseListSchema,input),scope=this.scope(ctx);
  if(query.management&&!scope.manager)throw new PortalError('case_management_denied');
  const where:string[]=[];const params:(string|number|null)[]=[];
  if(query.management){if(!scope.platform){where.push('organization_id=?');params.push(scope.org);}}else{where.push('owner_id=? AND (organization_id IS NULL OR organization_id=?)');params.push(scope.user,scope.org);}
  if(query.status){where.push('status=?');params.push(query.status);}
  if(query.cursor){let cursor:{at:string;id:string};try{cursor=z.object({at:z.string().datetime(),id:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8')));}catch{throw new PortalError('case_input_invalid');}where.push('(created_at < ? OR (created_at=? AND case_id<?))');params.push(cursor.at,cursor.at,cursor.id);}
  params.push(query.limit+1);
  const rows=this.store.db.prepare(`SELECT * FROM business_cases ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC,case_id DESC LIMIT ?`).all(...params) as Row[];
  const page=rows.slice(0,query.limit),last=page.at(-1);
  return {items:page.map(row=>{const value=this.view(scope,row);return {...value,events:[]};}),next_cursor:rows.length>query.limit&&last?Buffer.from(JSON.stringify({at:last.created_at,id:last.case_id})).toString('base64url'):null,can_manage:scope.manager};
 }
 private mutate(scope:Scope,action:string,key:string,input:unknown,write:()=>string):CaseView{
  if(!/^[A-Za-z0-9_.:-]{8,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
  const partition=JSON.stringify([scope.user,scope.org,action]);const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex');const db=this.store.db;
  db.exec('BEGIN IMMEDIATE');let id:string;
  try{const prior=db.prepare('SELECT digest,case_id FROM business_case_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;case_id:string}|undefined;
   if(prior){if(prior.digest!==digest)throw new PortalError('idempotency_conflict');id=prior.case_id;}
   else{id=write();db.prepare('INSERT INTO business_case_idempotency VALUES(?,?,?,?)').run(partition,key,digest,id);}
   this.read(scope,id);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return this.view(scope,this.read(scope,id));
 }
 private event(row:Row,message:string,visibility:Event['visibility'],label:string,actorId:string){this.store.db.prepare('INSERT INTO business_case_events VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.case_id,row.version,row.status,message,visibility,label,row.updated_at,actorId);}
 create(ctx:PortalContext,input:unknown,key:string){
  const scope=this.scope(ctx),draft=parse(caseInputSchema,input) as Draft;
  if(ctx.identity.platformRole!==null)throw new PortalError('case_customer_required');
  return this.mutate(scope,'create',key,draft,()=>{
   const daily=this.store.db.prepare('SELECT COUNT(*) AS n FROM business_cases WHERE owner_id=? AND created_at>=?').get(scope.user,new Date(Date.now()-86400000).toISOString()) as {n:number};
   if(daily.n>=50)throw new PortalError('case_daily_limit');
   const at=new Date().toISOString(),id=randomUUID();
   const row:Row={case_id:id,owner_id:scope.user,organization_id:scope.org,status:'submitted',version:1,input_json:JSON.stringify(draft),created_at:at,updated_at:at};
   this.store.db.prepare('INSERT INTO business_cases VALUES(?,?,?,?,?,?,?,?)').run(id,scope.user,scope.org,row.status,1,row.input_json,at,at);
   this.event(row,'需求已提交，等待工作人员处理。','customer','客户',scope.user);return id;
  });
 }
 update(ctx:PortalContext,id:string,input:unknown,key:string){
  const scope=this.scope(ctx),change=parse(caseUpdateSchema,input);if(!this.manages(scope,this.read(scope,id)))throw new PortalError('case_management_denied');
  return this.mutate(scope,`update:${id}`,key,change,()=>{
   const row=this.read(scope,id);if(row.version!==change.expected_version)throw new PortalError('version_conflict');
   const transitions:Record<CaseStatus,readonly CaseStatus[]>={submitted:['in_review','needs_input','closed','cancelled'],in_review:['in_review','needs_input','closed','cancelled'],needs_input:['in_review','needs_input','closed','cancelled'],closed:[],cancelled:[]};
   if(!transitions[row.status].includes(change.status)||row.version>=500)throw new PortalError('case_transition_invalid');
   row.status=change.status;row.version++;row.updated_at=new Date().toISOString();
   this.store.db.prepare('UPDATE business_cases SET status=?,version=?,updated_at=? WHERE case_id=?').run(row.status,row.version,row.updated_at,id);
   this.event(row,change.public_note.trim(),'customer','工作人员',scope.user);if(change.internal_note.trim())this.event(row,change.internal_note.trim(),'internal',ctx.identity.displayName,scope.user);
   return id;
  });
 }
 reply(ctx:PortalContext,id:string,input:unknown,key:string){
  const scope=this.scope(ctx),reply=parse(caseReplySchema,input);if(this.read(scope,id).owner_id!==scope.user)throw new PortalError('case_access_denied');
  return this.mutate(scope,`reply:${id}`,key,reply,()=>{
   const row=this.read(scope,id);if(row.version!==reply.expected_version)throw new PortalError('version_conflict');
   if(row.status!=='needs_input'||row.version>=500)throw new PortalError('case_transition_invalid');
   row.version++;row.status='in_review';row.updated_at=new Date().toISOString();this.store.db.prepare('UPDATE business_cases SET status=?,version=?,updated_at=? WHERE case_id=?').run(row.status,row.version,row.updated_at,id);
   this.event(row,reply.message.trim(),'customer','客户',scope.user);return id;
  });
 }
}

const caseEventSchema = z.object({event_id:z.string(),version:z.number().int().positive(),status:z.enum(CASE_STATUSES),message:z.string(),visibility:z.enum(['customer','internal']),actor_label:z.string(),created_at:z.string()}).strict();
export const caseViewSchema = z.object({case_id:z.string(),status:z.enum(CASE_STATUSES),version:z.number().int().positive(),input:caseInputSchema,created_at:z.string(),updated_at:z.string(),can_manage:z.boolean(),can_reply:z.boolean(),events:z.array(caseEventSchema).max(1000)}).strict();
export const caseResponseSchema = z.object({schema_version:z.literal(CASE_VERSION),status:z.literal('success'),data:z.union([caseViewSchema,z.object({items:z.array(caseViewSchema).max(50),next_cursor:z.string().nullable(),can_manage:z.boolean()}).strict()]),reason_codes:z.array(z.string()).length(0)}).strict();
