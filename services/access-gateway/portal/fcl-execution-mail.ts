import {randomUUID} from 'node:crypto';
import {PortalError,type PortalContext} from './contracts';
import type {FclCaseNotificationEvent,FclMailMessage,FclMailTransport} from './cases';
import {SyncTransactionGuard} from './sync-transaction';
import {executionDigest,type FclExecutionService} from './fcl-execution';
import {FCL_MAIL_TEMPLATE_VERSION,fclMailListRequestSchema,fclMailListSchema,fclOutboxSchema,type FclExecution,type FclNode,type FclOutbox,type FclNotificationConfig,fclCaseMailResolveSchema,fclCaseMailRetrySchema} from './fcl-execution-contracts';

import {FCL_NODE_LABELS,renderExecutionMail} from './fcl-execution-mail-format';

const binding=(node:FclNode)=>executionDigest({cycle:node.cycle,status:node.status,assignment:node.assignment,notification:node.notification});
export interface FclExecutionMailOptions{
  publicOrigin?:string;
  transport?:FclMailTransport;
  configuration?:(ownerId:string)=>FclNotificationConfig;
  verifyUsers:(ids:string[])=>Promise<'active'|'inactive'|'unavailable'>;
  now?:()=>string;
  leaseMs?:number;
  timeoutMs?:number;
}
export class FclExecutionMailService{
  readonly #guard=new SyncTransactionGuard();
  readonly now:()=>string;
  readonly leaseMs:number;
  private running=false;
  constructor(readonly execution:FclExecutionService,readonly options:FclExecutionMailOptions){this.now=options.now??(()=>new Date().toISOString());this.leaseMs=options.leaseMs??30_000;if(this.leaseMs<1000||this.leaseMs>300_000)throw new Error('fcl_mail_lease_invalid');}
  private get db(){return this.execution.cases.store.db;}
  private transaction<T>(operation:()=>T){this.#guard.begin(this.db,'fcl_mail_readback_failed');try{const result=operation();this.#guard.commit(this.db);return result;}catch(error){this.#guard.rollbackOnFailure(this.db);throw error;}}
  private read(id:string){
    const row=this.db.prepare('SELECT * FROM fcl_execution_outbox WHERE message_id=?').get(id) as {message_id:string;event_id:string;case_id:string;node_id:string;cycle:number;audience:string;status:string;payload:string}|undefined;
    if(!row)return null;
    let record:FclOutbox;try{record=fclOutboxSchema.parse(JSON.parse(row.payload));}catch{throw new PortalError('fcl_mail_readback_failed');}
    if(record.message_id!==row.message_id||record.event_id!==row.event_id||record.case_ref!==row.case_id||(record.node_id??'')!==row.node_id||record.cycle!==row.cycle||record.audience!==row.audience||record.status!==row.status)throw new PortalError('fcl_mail_readback_failed');return record;
  }
  private update(message:FclOutbox){this.db.prepare('UPDATE fcl_execution_outbox SET status=?,payload=? WHERE message_id=?').run(message.status,JSON.stringify(message),message.message_id);if(JSON.stringify(this.read(message.message_id))!==JSON.stringify(message))throw new PortalError('fcl_mail_readback_failed');}
  enqueue(progress:FclExecution,event:FclExecution['history'][number]){
    // Invoked only by the execution service inside its Case transaction, never by a request body.
    for(const id of event.notify_node_ids){
      const node=progress.nodes.find(n=>n.node_id===id);if(!node||this.execution.configurationMissing(node).length)continue;
      for(const audience of ['internal','external'] as const){
        if(event.action==='mention'&&audience==='external')continue;
        const enabled=audience==='internal'?node.assignment.enabled:node.notification.external_enabled;
        const to=audience==='internal'?node.assignment.to:node.notification.external_to;
        if(!enabled||!to)continue;
        const existing=this.db.prepare('SELECT message_id FROM fcl_execution_outbox WHERE event_id=? AND node_id=? AND cycle=? AND audience=?').get(event.event_id,id,node.cycle,audience) as {message_id:string}|undefined;
        if(existing){if(!this.read(existing.message_id))throw new PortalError('fcl_mail_readback_failed');continue;}
        const at=this.now(),message=fclOutboxSchema.parse({message_id:randomUUID(),event_id:event.event_id,case_ref:progress.case_ref,node_id:id,cycle:node.cycle,audience,status:'pending',assignment_digest:binding(node),template_version:FCL_MAIL_TEMPLATE_VERSION,to,cc:audience==='internal'?node.assignment.cc:node.notification.external_cc,attempts:0,lease_token:null,lease_until:null,result_code:null,created_at:at,updated_at:at});
        this.db.prepare('INSERT INTO fcl_execution_outbox(message_id,event_id,case_id,node_id,cycle,audience,status,payload) VALUES(?,?,?,?,?,?,?,?)').run(message.message_id,event.event_id,progress.case_ref,id,node.cycle,audience,'pending',JSON.stringify(message));
        if(JSON.stringify(this.read(message.message_id))!==JSON.stringify(message))throw new PortalError('fcl_mail_readback_failed');
      }
    }
  }
  enqueueCaseEvent(event:FclCaseNotificationEvent){
    const nodeId=event.kind==='fcl_inquiry_submitted'?'intake':event.kind==='fcl_staff_confirmation'?'quote':event.kind==='fcl_handoff_recorded'||event.kind==='fcl-document-approve'?'customer_followup':event.kind==='fcl-document-reject'?'quote':event.kind==='fcl_case_status_updated'&&event.status==='needs_input'?'intake':null;
    if(!nodeId)return;
    const config=this.options.configuration?.(event.owner_id),notification=config?.rows.find(r=>r.node_id===nodeId);
    if(!notification||!notification.assignment.enabled||!notification.assignment.to||notification.assignment.responsible_id!==event.owner_id)return;
    const row=this.db.prepare('SELECT c.owner_id,c.version,c.input_json,i.inquiry_no FROM business_cases c JOIN fcl_inquiries i ON i.case_id=c.case_id WHERE c.case_id=?').get(event.case_ref) as {owner_id:string;version:number;input_json:string;inquiry_no:string}|undefined;
    if(!row||row.owner_id!==event.owner_id||row.version!==event.case_version)throw new PortalError('fcl_mail_readback_failed');
    const input=JSON.parse(row.input_json) as {contact:{name:string;company:string|null};pol:string|null;pod:string|null;final_destination:string|null};
    const pre_execution={owner_id:row.owner_id,case_version:row.version,inquiry_no:row.inquiry_no,customer_name:input.contact.company||input.contact.name,route:[input.pol,input.pod,input.final_destination].filter((place,index,places)=>place&&place!==places[index-1]).join(' → '),notification,event_kind:event.kind};
    const old=this.db.prepare("SELECT message_id FROM fcl_execution_outbox WHERE event_id=? AND node_id=? AND cycle=1 AND audience='internal'").get(event.event_id,nodeId) as {message_id:string}|undefined;
    if(old){if(!this.read(old.message_id))throw new PortalError('fcl_mail_readback_failed');return;}
    const at=this.now(),message=fclOutboxSchema.parse({pre_execution,message_id:randomUUID(),event_id:event.event_id,case_ref:event.case_ref,node_id:nodeId,cycle:1,audience:'internal',status:'pending',assignment_digest:executionDigest(notification),template_version:FCL_MAIL_TEMPLATE_VERSION,to:notification.assignment.to,cc:notification.assignment.cc,attempts:0,lease_token:null,lease_until:null,result_code:null,created_at:at,updated_at:at});
    this.db.prepare('INSERT INTO fcl_execution_outbox(message_id,event_id,case_id,node_id,cycle,audience,status,payload) VALUES(?,?,?,?,?,?,?,?)').run(message.message_id,message.event_id,message.case_ref,nodeId,1,'internal','pending',JSON.stringify(message));
    if(JSON.stringify(this.read(message.message_id))!==JSON.stringify(message))throw new PortalError('fcl_mail_readback_failed');
  }
  resolveCaseMail(ctx:PortalContext,input:unknown,key:string,retry=false){
    const request=(retry?fclCaseMailRetrySchema:fclCaseMailResolveSchema).parse(input),cases=this.execution.cases;
    if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    cases.withFclReadLock(ctx,()=>{
      const current=cases.getFclCase(ctx,request.case_ref),partition=JSON.stringify(['fcl-case-mail',ctx.identity.userId,retry]),digest=executionDigest(request);
      const old=this.db.prepare('SELECT digest,case_id FROM business_case_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;case_id:string}|undefined;
      if(old){if(old.digest!==digest||old.case_id!==request.case_ref)throw new PortalError('idempotency_conflict');return;}
      if(current.case_version!==request.expected_version)throw new PortalError('version_conflict');
      const message=this.read(request.message_id);if(!message||message.case_ref!==request.case_ref)throw new PortalError('fcl_not_found');
      if(retry){if(message.status!=='failed')throw new PortalError('fcl_mail_result_requires_verification');message.status='pending';message.result_code=null;}
      else{if(!['unknown','failed','pending'].includes(message.status)||!('outcome' in request))throw new PortalError('fcl_mail_resolution_invalid');message.status=request.outcome==='confirmed_accepted'?'smtp_accepted':request.outcome==='confirmed_not_sent'?'failed':'cancelled';message.result_code=`human_${String(request.outcome)}`;}
      message.updated_at=this.now();message.resolutions.push({actor_id:ctx.identity.userId,reason:request.reason,at:message.updated_at,outcome:retry?'retry':('outcome' in request?String(request.outcome):'')});fclOutboxSchema.parse(message);this.update(message);
      this.db.prepare('INSERT INTO business_case_idempotency(scope,key,digest,case_id) VALUES(?,?,?,?)').run(partition,key,digest,request.case_ref);
    });
    return this.list(ctx,{case_ref:request.case_ref});
  }
  list(ctx:PortalContext,input:unknown){
    const request=fclMailListRequestSchema.parse(input),view=this.execution.get(ctx,{case_ref:request.case_ref});
    const ids=view?.nodes.map(n=>n.node_id)??[],owner=!view||view.role==='owner';let before=Number.MAX_SAFE_INTEGER;
    if(request.cursor){try{const c=JSON.parse(Buffer.from(request.cursor,'base64url').toString()) as {user:string;case_ref:string;before:number};if(c.user!==ctx.identity.userId||c.case_ref!==request.case_ref||!Number.isSafeInteger(c.before)||c.before<1)throw new Error();before=c.before;}catch{throw new PortalError('fcl_execution_input_invalid');}}
    const rows=this.db.prepare(`SELECT rowid,message_id FROM fcl_execution_outbox WHERE case_id=? AND rowid<? AND (?=1 OR node_id IN (${ids.map(()=>'?').join(',')||'NULL'})) ORDER BY rowid DESC LIMIT ?`).all(request.case_ref,before,owner?1:0,...ids,request.limit+1) as {rowid:number;message_id:string}[];
    const page=rows.slice(0,request.limit);
    return fclMailListSchema.parse({items:page.map(row=>this.read(row.message_id)!),next_cursor:rows.length>request.limit?Buffer.from(JSON.stringify({user:ctx.identity.userId,case_ref:request.case_ref,before:page.at(-1)!.rowid})).toString('base64url'):null});
  }

  private applicable(message:FclOutbox):{people:string[];render:()=>FclMailMessage}|null{
    if(message.pre_execution){
      const snapshot=message.pre_execution,row=this.db.prepare('SELECT owner_id,version,status FROM business_cases WHERE case_id=?').get(message.case_ref) as {owner_id:string;version:number;status:string}|undefined;
      const current=this.options.configuration?.(snapshot.owner_id)?.rows.find(r=>r.node_id===message.node_id);
      if(!row||row.owner_id!==snapshot.owner_id||row.version!==snapshot.case_version||['closed','cancelled'].includes(row.status)||!current||executionDigest(current)!==message.assignment_digest)return null;
      if(message.node_id==='customer_followup'&&this.execution.readForDispatch(message.case_ref))return null;
      return {people:[snapshot.owner_id],render:()=>({to:message.to,cc:message.cc,subject:`${snapshot.inquiry_no} · ${FCL_NODE_LABELS[message.node_id!]}`,body:[`业务单号：${snapshot.inquiry_no}`,`客户：${snapshot.customer_name}`,`路线：${snapshot.route}`,`环节：${FCL_NODE_LABELS[message.node_id!]}`,`待办：${snapshot.event_kind==='fcl-document-reject'?'报价文件被退回，请补充后重新审核':'请登录核对本环节资料'}`,`负责人：${snapshot.owner_id}`,`详情（需登录）：${this.options.publicOrigin??''}/console/#fcl/case/${message.case_ref}`].join('\n')})};
    }

    const progress=this.execution.readForDispatch(message.case_ref),node=progress?.nodes.find(n=>n.node_id===message.node_id);
    if(!progress||!node||['cancelled','skipped'].includes(node.status)||node.cycle!==message.cycle||binding(node)!==message.assignment_digest)return null;
    const enabled=message.audience==='internal'?node.assignment.enabled:node.notification.external_enabled;
    const to=message.audience==='internal'?node.assignment.to:node.notification.external_to;
    if(!enabled||to!==message.to||!node.assignment.responsible_id)return null;
    return {render:()=>renderExecutionMail(progress,node,message.audience,this.options.publicOrigin),people:[progress.owner_id,progress.coordinator_id,node.assignment.responsible_id,...node.assignment.collaborator_ids]};
  }
  async dispatchOnce():Promise<void>{
    if(this.running)return;this.running=true;
    try{
      this.transaction(()=>{
        const rows=this.db.prepare("SELECT message_id FROM fcl_execution_outbox WHERE status='sending'").all() as {message_id:string}[];
        for(const row of rows){const message=this.read(row.message_id)!;if(!message.lease_until||Date.parse(message.lease_until)<=Date.parse(this.now())){message.status='unknown';message.result_code='sending_lease_expired';message.lease_token=null;message.lease_until=null;message.updated_at=this.now();this.update(message);}}
      });
      const pending=this.db.prepare("SELECT message_id FROM fcl_execution_outbox WHERE status='pending' ORDER BY rowid LIMIT 100").all() as {message_id:string}[];
      for(const candidate of pending){
        const message=this.read(candidate.message_id);if(!message||message.status!=='pending')continue;
        const target=this.applicable(message);
        let authority:'active'|'inactive'|'unavailable'='inactive';
        if(target){try{authority=await this.options.verifyUsers([...new Set(target.people)]);}catch{authority='unavailable';}}
        if(authority==='unavailable')return;
        if(!target||authority==='inactive'){
          this.transaction(()=>{const current=this.read(message.message_id);if(current?.status==='pending'){current.status='cancelled';current.result_code='assignment_or_authority_changed';current.updated_at=this.now();this.update(current);}});continue;
        }
        if(!this.options.transport)return;
        const claimed=this.transaction(()=>{
          const current=this.read(message.message_id);if(!current||current.status!=='pending'||!this.applicable(current))return null;
          current.status='sending';current.attempts++;current.lease_token=randomUUID();current.lease_until=new Date(Date.parse(this.now())+this.leaseMs).toISOString();current.updated_at=this.now();this.update(current);return current;
        });
        if(!claimed)continue;
        const fresh=this.applicable(claimed);
        let result:FclOutbox['status']='cancelled',code:string|null='assignment_changed_before_send';
        if(fresh){
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{
            const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('fcl_smtp_timeout')),this.options.timeoutMs??10_000);});
            await Promise.race([Promise.resolve(this.options.transport.send(fresh.render())),timeout]);
            result='smtp_accepted';code=null;
          }catch(error){
            const reason=error instanceof Error?error.message:'';
            result=reason==='fcl_smtp_rejected'?'failed':'unknown';
            code=reason==='fcl_smtp_rejected'?'smtp_rejected':reason==='fcl_smtp_partial_unknown'?'partial_recipient_result_unknown':'smtp_result_unknown';
          }finally{if(timer)clearTimeout(timer);}
        }
        this.transaction(()=>{const current=this.read(claimed.message_id);if(current?.status!=='sending'||current.lease_token!==claimed.lease_token)return;current.status=result;current.result_code=code;current.updated_at=this.now();current.lease_token=null;current.lease_until=null;this.update(current);});
        return;
      }
    }finally{this.running=false;}
  }
  startWorker(intervalMs=1000){const timer=setInterval(()=>{void this.dispatchOnce().catch(()=>{/* Durable rows retain pending/unknown state; no content is logged. */});},intervalMs);timer.unref();return async()=>{clearInterval(timer);while(this.running)await new Promise(resolve=>setTimeout(resolve,20));};}
}
