import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PortalError,type PortalContext} from './contracts';
import type {CaseService} from './cases';
import {SyncTransactionGuard} from './sync-transaction';
import {
  FCL_EXECUTION_VERSION,FCL_NODE_IDS,FCL_NODE_SERVICES,emptyFclNotificationConfig,
  fclExecutionSchema,fclExecutionGetSchema,type fclExecutionStartSchema,fclExecutionPreviewSchema,fclExecutionSharedSaveSchema,
  fclExecutionNodeSaveSchema,fclExecutionNodeActionSchema,fclExecutionNodeAssignSchema,fclExecutionListSchema,fclExecutionListOutputSchema,
  fclExecutionViewSchema,fclNodeFields,fclExecutionDefaultsSchema,fclExecutionDefaultsApplySchema,fclExecutionDefaultsPreviewSchema,
  fclExecutionNodeCompleteSchema,fclMailResolveSchema,fclMailRetrySchema,fclOutboxSchema,
  fclNotificationV2ConfigSchema,fclExecutionAmendSchema,fclWorkspaceListSchema,fclWorkspaceListOutputSchema,fclExecutionHistoryRequestSchema,fclExecutionHistorySchema,
  type FclExecution,type FclNode,type FclNotificationConfig,
} from './fcl-execution-contracts';
import type {FclHandoffPayload,FclDocumentPayload} from '../../quote-documents/fcl-contracts';

export const executionDigest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse=<T>(schema:z.ZodType<T>,input:unknown):T=>{const result=schema.safeParse(input);if(!result.success)throw new PortalError('fcl_execution_input_invalid');return result.data;};
const terminal=(node:FclNode)=>['completed','skipped','cancelled'].includes(node.status);
type Start=z.infer<typeof fclExecutionStartSchema>;
type Evidence={handoff:FclHandoffPayload;document:FclDocumentPayload};
export type FclExecutionOptions={now?:()=>string;isActive:(id:string)=>boolean;configuration?:(ctx:PortalContext)=>FclNotificationConfig;onEvent?:(progress:FclExecution,event:FclExecution['history'][number])=>void};

export function emptyNodeFields(node:typeof FCL_NODE_IDS[number]){
  const fields:Record<typeof FCL_NODE_IDS[number],unknown>={
    booking:{carrier:'',vessel_voyage:'',booking_so:'',etd:null,cutoff:null,booking_evidence:''},
    pickup:{location:'',contact:'',appointment:null,completed_at:null,work_evidence:''},
    export_customs:{contact:'',declaration_ref:'',release_confirmed:false,release_evidence:'',inspection_notes:''},
    shipping_documents:{checked:false,handover_evidence:'',cutoff:null},
    canada_customs:{importer:'',declaration_ref:'',release_confirmed:false,release_evidence:'',inspection_notes:''},
    devanning_storage:{warehouse:'',contact:'',arrival_at:null,handover_at:null,discrepancies:'',damage:'',handover_evidence:''},
    delivery:{pickup_location:'',release_source:'unconfirmed',release_evidence:'',delivery_address:'',contact:'',appointment:null,signed_at:null,pod_ref:'',empty_return_required:false,empty_return_at:null,empty_return_evidence:''},
  };
  return fclNodeFields[node].parse(fields[node]);
}

export class FclExecutionService{
  readonly #guard=new SyncTransactionGuard();
  readonly now:()=>string;
  constructor(readonly cases:CaseService,readonly options:FclExecutionOptions){this.now=options.now??(()=>new Date().toISOString());if(!cases.store.executionEnabled)throw new Error('fcl_execution_not_configured');}
  private actor(ctx:PortalContext){if(!ctx.identity?.emailVerified||!ctx.identity.userId||!this.active(ctx.identity.userId))throw new PortalError('fcl_not_found');return ctx.identity.userId;}
  active(id:string){try{return this.options.isActive(id)===true;}catch{return false;}}
  private row(caseRef:string):FclExecution|null{
    const row=this.cases.store.db.prepare('SELECT p.*,c.owner_id AS case_owner FROM fcl_case_progress p JOIN business_cases c ON c.case_id=p.case_id WHERE p.case_id=?').get(caseRef) as {case_id:string;owner_id:string;case_owner:string;version:number;payload:string;created_at:string;updated_at:string}|undefined;
    if(!row)return null;
    let value:FclExecution;try{value=fclExecutionSchema.parse(JSON.parse(row.payload));}catch{throw new PortalError('fcl_execution_readback_failed');}
    if(value.case_ref!==row.case_id||value.owner_id!==row.owner_id||row.owner_id!==row.case_owner||value.version!==row.version||value.created_at!==row.created_at||value.updated_at!==row.updated_at)throw new PortalError('fcl_execution_readback_failed');
    return value;
  }
  private visible(ctx:PortalContext,value:FclExecution){
    const user=this.actor(ctx);
    if(!this.active(value.owner_id))throw new PortalError('fcl_not_found');
    if(user===value.owner_id||user===value.coordinator_id)return value;
    if(!value.nodes.some(node=>node.assignment.responsible_id===user||node.assignment.collaborator_ids.includes(user)))throw new PortalError('fcl_not_found');
    return value;
  }
  private manager(ctx:PortalContext,value:FclExecution){this.visible(ctx,value);if(![value.owner_id,value.coordinator_id].includes(ctx.identity.userId))throw new PortalError('fcl_not_found');}
  private nodeAccess(ctx:PortalContext,value:FclExecution,nodeId:FclNode['node_id']){
    this.visible(ctx,value);const node=value.nodes.find(node=>node.node_id===nodeId);if(!node)throw new PortalError('fcl_not_found');
    if(![value.owner_id,value.coordinator_id,node.assignment.responsible_id,...node.assignment.collaborator_ids].includes(ctx.identity.userId))throw new PortalError('fcl_not_found');return node;
  }
  project(ctx:PortalContext,value:FclExecution){
    this.visible(ctx,value);
    if(ctx.identity.userId===value.owner_id)return fclExecutionViewSchema.parse({...value,history:value.history.slice(-50),history_count:value.history.length,role:'owner'});
    const {acceptances:_acceptances,history:_history,...safe}=value;void _acceptances;void _history;
    // A coordinator manages operational data, but still does not receive commercial evidence.
    const nodes=ctx.identity.userId===value.coordinator_id?safe.nodes:safe.nodes.filter(node=>node.assignment.responsible_id===ctx.identity.userId||node.assignment.collaborator_ids.includes(ctx.identity.userId));
    return fclExecutionViewSchema.parse({...safe,nodes,role:'participant'});
  }
  get(ctx:PortalContext,input:unknown){const request=parse(fclExecutionGetSchema,input);this.actor(ctx);const value=this.row(request.case_ref);if(!value){this.cases.getFclCase(ctx,request.case_ref);return null;}return this.project(ctx,value);}
  history(ctx:PortalContext,input:unknown){
    const request=parse(fclExecutionHistoryRequestSchema,input),value=this.row(request.case_ref);if(!value)throw new PortalError('fcl_not_found');
    const view=this.project(ctx,value),ids=new Set(view.nodes.map(n=>n.node_id));let before=Number.MAX_SAFE_INTEGER;
    if(request.cursor){try{const c=JSON.parse(Buffer.from(request.cursor,'base64url').toString()) as {case_ref:string;user:string;before:number};if(c.case_ref!==request.case_ref||c.user!==ctx.identity.userId||!Number.isSafeInteger(c.before)||c.before<1)throw new Error();before=c.before;}catch{throw new PortalError('fcl_execution_input_invalid');}}
    const visible=value.history.filter(e=>e.version<before&&(view.role==='owner'||(e.node_id!==null&&ids.has(e.node_id)))).reverse();
    const page=visible.slice(0,request.limit),items=page.map(e=>view.role==='owner'?e:{...e,before_nodes:e.before_nodes.filter(n=>ids.has(n.node_id)),before_shared:null,notify_node_ids:e.notify_node_ids.filter(n=>ids.has(n))});
    return fclExecutionHistorySchema.parse({items,next_cursor:visible.length>request.limit?Buffer.from(JSON.stringify({case_ref:request.case_ref,user:ctx.identity.userId,before:page.at(-1)!.version})).toString('base64url'):null});
  }
  getOwner(ctx:PortalContext,caseRef:string){this.actor(ctx);this.cases.getFclCase(ctx,caseRef);return this.row(caseRef);}
  private key(key:string){if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');}
  private replay(ctx:PortalContext,action:string,input:unknown,caseRef:string,key:string){
    this.key(key);const scope=JSON.stringify(['fcl-execution',this.actor(ctx),action]);
    const old=this.cases.store.db.prepare('SELECT digest,case_id FROM business_case_idempotency WHERE scope=? AND key=?').get(scope,key) as {digest:string;case_id:string}|undefined;
    if(old&&(old.case_id!==caseRef||old.digest!==executionDigest(input)))throw new PortalError('idempotency_conflict');
    return {scope,old:Boolean(old)};
  }
  private remember(scope:string,input:unknown,caseRef:string,key:string){this.cases.store.db.prepare('INSERT INTO business_case_idempotency(scope,key,digest,case_id) VALUES(?,?,?,?)').run(scope,key,executionDigest(input),caseRef);}
  existingStart(ctx:PortalContext,request:Start,key:string){
    this.cases.assertFclHandoffTransaction(ctx);
    const value=this.getOwner(ctx,request.handoff.case_ref);const {scope,old}=this.replay(ctx,'start',request,request.handoff.case_ref,key);
    if(old&&!value)throw new PortalError('fcl_execution_readback_failed');
    if(value){
      const accepted=value.acceptances[0]!.handoff,submitted=request.handoff;
      if(accepted.quote_ref!==submitted.quote_ref||accepted.quote_version!==submitted.expected_quote_version||accepted.quote_digest!==submitted.expected_quote_digest||accepted.document_id!==submitted.document_id||accepted.document_version!==submitted.expected_document_version||accepted.pdf_sha256!==submitted.expected_pdf_sha256)throw new PortalError('fcl_execution_already_exists_use_amend');
      if(!old)this.remember(scope,request,request.handoff.case_ref,key);
    }
    return value;
  }
  configuration(ctx:PortalContext,expected?:number){
    this.actor(ctx);const source=this.options.configuration?.(ctx)??emptyFclNotificationConfig();
    const value=fclNotificationV2ConfigSchema.parse({contract_version:source.contract_version,version:source.version,rows:source.rows});
    if(expected!==undefined&&value.version!==expected)throw new PortalError('version_conflict');
    return value;
  }
  buildNodes(evidence:Evidence,configuration:FclNotificationConfig):FclNode[]{
    const scope=evidence.document.customer_scope;
    if(scope.some(row=>row.disposition==='pending')||new Set(scope.map(row=>row.service)).size!==scope.length)throw new PortalError('fcl_execution_scope_needs_input');
    const included=new Set(scope.filter(row=>['priced','included','free'].includes(row.disposition)).map(row=>row.service));
    return FCL_NODE_IDS.filter(node=>included.has(FCL_NODE_SERVICES[node])).map(node_id=>{
      const notification=configuration.rows.find(row=>row.node_id===node_id);if(!notification)throw new PortalError('fcl_execution_configuration_invalid');
      return {node_id,cycle:1,status:'not_started',assignment:structuredClone(notification.assignment),notification:structuredClone(notification),assignment_source:'snapshot',deadline:null,notes:'',evidence_refs:[],fields:emptyNodeFields(node_id),started_at:null,completed_at:null};
    });
  }
  preview(ctx:PortalContext,request:Start,evidence:Evidence){
    this.cases.getFclCase(ctx,request.handoff.case_ref);this.actor(ctx);
    if(!this.active(request.coordinator_id))throw new PortalError('fcl_execution_responsible_unavailable');
    if(Date.parse(request.confirmation.confirmed_at)>Date.parse(this.now()))throw new PortalError('fcl_execution_confirmation_time_invalid');
    const config=this.configuration(ctx,request.expected_config_version),nodes=this.buildNodes(evidence,config),projection=evidence.document.case_projection;
    if(!nodes.length)throw new PortalError('fcl_execution_scope_needs_input');
    return fclExecutionPreviewSchema.parse({case_ref:request.handoff.case_ref,customer_name:projection.customer_name,route:[projection.pol,projection.pod,projection.final_destination].filter((place,index,places)=>place&&place!==places[index-1]).join(' → '),nodes,configuration_version:config.version,missing_configuration:nodes.flatMap(node=>this.configurationMissing(node))});
  }
  configurationMissing(node:FclNode){
    const missing:string[]=[];
    if(!node.assignment.responsible_id||!this.active(node.assignment.responsible_id))missing.push(`${node.node_id}:responsible_id`);
    if(node.assignment.enabled&&!node.assignment.to)missing.push(`${node.node_id}:to`);
    if(node.notification.external_enabled&&!node.notification.external_to)missing.push(`${node.node_id}:external_to`);
    return missing;
  }
  private audit(ctx:PortalContext,value:FclExecution,action:FclExecution['history'][number]['action'],reason:string,node:FclNode|null=null,beforeNodes:FclNode[]=[],beforeShared:FclExecution['shared']|null=null){
    if(value.history.length>=5000)throw new PortalError('fcl_execution_history_limit_exceeded');
    const event={event_id:randomUUID(),version:value.version,actor_id:this.actor(ctx),action,node_id:node?.node_id??null,cycle:node?.cycle??null,reason,before_nodes:structuredClone(beforeNodes),before_shared:beforeShared,notify_node_ids:node?[node.node_id]:[],created_at:this.now()};
    value.history.push(event);return event;
  }
  private readback(expected:FclExecution){const actual=this.row(expected.case_ref);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new PortalError('fcl_execution_readback_failed');return actual!;}
  createInTransaction(ctx:PortalContext,request:Start,evidence:Evidence,key:string){
    this.cases.assertFclHandoffTransaction(ctx);const preview=this.preview(ctx,request,evidence),at=this.now();
    const value:FclExecution={contract_version:FCL_EXECUTION_VERSION,case_ref:preview.case_ref,inquiry_no:evidence.handoff.inquiry_no,customer_name:preview.customer_name,route:preview.route,owner_id:this.actor(ctx),coordinator_id:request.coordinator_id,version:1,state:'executing',acceptances:[{acceptance_id:randomUUID(),confirmation:request.confirmation,registered_by:this.actor(ctx),registered_at:at,handoff:evidence.handoff,source_binding:evidence.document.source_binding,customer_scope:evidence.document.customer_scope,configuration:this.configuration(ctx,request.expected_config_version),reason:'员工代录客户确认并转执行'}],nodes:preview.nodes,shared:{containers:[],hbl:null,mbl:null,eta:null},history:[],created_at:at,updated_at:at};
    const event=this.audit(ctx,value,'start','员工代录客户确认并转执行');fclExecutionSchema.parse(value);
    const {scope}=this.replay(ctx,'start',request,value.case_ref,key);
    this.cases.store.db.prepare('INSERT INTO fcl_case_progress(case_id,owner_id,version,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(value.case_ref,value.owner_id,value.version,JSON.stringify(value),at,at);
    this.remember(scope,request,value.case_ref,key);this.options.onEvent?.(value,event);return this.readback(value);
  }
  verifyCommitted(ctx:PortalContext,expected:FclExecution){this.visible(ctx,expected);return this.readback(expected);}
  existingAmend(ctx:PortalContext,input:unknown,key:string){
    this.cases.assertFclHandoffTransaction(ctx);const request=parse(fclExecutionAmendSchema,input),value=this.getOwner(ctx,request.handoff.case_ref);
    if(!value)throw new PortalError('fcl_not_found');const {old}=this.replay(ctx,'amend',request,value.case_ref,key);return old?value:null;
  }
  amendInTransaction(ctx:PortalContext,input:unknown,evidence:Evidence,key:string){
    this.cases.assertFclHandoffTransaction(ctx);const request=parse(fclExecutionAmendSchema,input),value=this.getOwner(ctx,request.handoff.case_ref);
    if(!value)throw new PortalError('fcl_not_found');if(value.version!==request.expected_version)throw new PortalError('version_conflict');
    if(value.acceptances.length>=100)throw new PortalError('fcl_execution_history_limit_exceeded');
    if(value.acceptances.some(a=>a.handoff.document_revision_id===evidence.handoff.document_revision_id))throw new PortalError('fcl_execution_acceptance_already_recorded');
    const preview=this.preview(ctx,request,evidence),beforeNodes=structuredClone(value.nodes),at=this.now(),included=new Set(preview.nodes.map(n=>n.node_id));
    for(const node of value.nodes)if(!included.has(node.node_id)&&!terminal(node)){node.status='cancelled';node.completed_at=at;}
    for(const node of preview.nodes)if(!value.nodes.some(n=>n.node_id===node.node_id))value.nodes.push(node);
    value.acceptances.push({acceptance_id:randomUUID(),confirmation:request.confirmation,registered_by:this.actor(ctx),registered_at:at,handoff:evidence.handoff,source_binding:evidence.document.source_binding,customer_scope:evidence.document.customer_scope,configuration:this.configuration(ctx,request.expected_config_version),reason:request.reason});
    value.version++;value.updated_at=at;value.coordinator_id=request.coordinator_id;value.state=value.nodes.every(terminal)?'completed':'executing';
    const event=this.audit(ctx,value,'amend',request.reason,null,beforeNodes);fclExecutionSchema.parse(value);
    const {scope}=this.replay(ctx,'amend',request,value.case_ref,key);
    const changed=this.cases.store.db.prepare('UPDATE fcl_case_progress SET version=?,payload=?,updated_at=? WHERE case_id=? AND version=?').run(value.version,JSON.stringify(value),at,value.case_ref,request.expected_version);
    if(changed.changes!==1)throw new PortalError('version_conflict');this.remember(scope,request,value.case_ref,key);this.options.onEvent?.(value,event);return this.readback(value);
  }
  private transaction<T>(operation:()=>T){const db=this.cases.store.db;this.#guard.begin(db,'fcl_execution_readback_failed');try{const result=operation();this.#guard.commit(db);return result;}catch(error){this.#guard.rollbackOnFailure(db);throw error;}}
  private mutate(ctx:PortalContext,action:FclExecution['history'][number]['action'],input:{case_ref:string;expected_version:number},key:string,authorize:(value:FclExecution)=>void,change:(value:FclExecution)=>{reason:string;node?:FclNode;beforeNodes?:FclNode[];beforeShared?:FclExecution['shared'];notify?:boolean;notifyNodes?:FclNode['node_id'][];force?:boolean}){
    this.actor(ctx);const result=this.transaction(()=>{
      const value=this.row(input.case_ref);if(!value)throw new PortalError('fcl_not_found');authorize(value);
      const {scope,old}=this.replay(ctx,action,input,input.case_ref,key);if(old)return value;
      if(value.version!==input.expected_version)throw new PortalError('version_conflict');
      const before=JSON.stringify(value),changeResult=change(value);
      if(JSON.stringify(value)===before&&!changeResult.force){this.remember(scope,input,value.case_ref,key);return value;}
      value.version++;value.updated_at=this.now();value.state=value.nodes.every(terminal)?'completed':'executing';
      const event=this.audit(ctx,value,action,changeResult.reason,changeResult.node??null,changeResult.beforeNodes,changeResult.beforeShared??null);
      if(changeResult.notifyNodes)event.notify_node_ids=changeResult.notifyNodes;
      fclExecutionSchema.parse(value);
      const written=this.cases.store.db.prepare('UPDATE fcl_case_progress SET version=?,payload=?,updated_at=? WHERE case_id=? AND version=?').run(value.version,JSON.stringify(value),value.updated_at,value.case_ref,input.expected_version);
      if(written.changes!==1)throw new PortalError('version_conflict');this.remember(scope,input,value.case_ref,key);
      if(changeResult.notify)this.options.onEvent?.(value,event);
      return this.readback(value);
    });
    return this.project(ctx,this.readback(result));
  }
  saveShared(ctx:PortalContext,input:unknown,key:string){const request=parse(fclExecutionSharedSaveSchema,input);return this.mutate(ctx,'shared_save',request,key,value=>this.manager(ctx,value),value=>{const beforeShared=value.shared;value.shared=request.shared;return {reason:'更新共享运输资料',beforeShared};});}
  saveNode(ctx:PortalContext,input:unknown,key:string){const request=parse(fclExecutionNodeSaveSchema,input);return this.mutate(ctx,'node_save',request,key,value=>{this.nodeAccess(ctx,value,request.node_id);},value=>{
    const node=this.nodeAccess(ctx,value,request.node_id);if(terminal(node))throw new PortalError('fcl_execution_node_closed');const beforeNodes=[structuredClone(node)];
    Object.assign(node,{deadline:request.deadline,notes:request.notes,evidence_refs:request.evidence_refs,fields:request.fields});return {reason:'保存节点资料',node,beforeNodes};
  });}
  private requireCompletion(node:FclNode,value:FclExecution){
    const f=node.fields as Record<string,unknown>;let needed:string[]=[];
    switch(node.node_id){
      case 'booking':needed=['carrier','booking_so','booking_evidence'];break;
      case 'pickup':needed=['location','completed_at','work_evidence'];if(!value.shared.containers.length)needed.push('containers');break;
      case 'export_customs':needed=['declaration_ref','release_confirmed','release_evidence'];break;
      case 'canada_customs':needed=['importer','declaration_ref','release_confirmed','release_evidence'];break;
      case 'shipping_documents':needed=['checked','handover_evidence'];if(!value.shared.hbl&&!value.shared.mbl)needed.push('bill_of_lading');break;
      case 'devanning_storage':needed=['warehouse','handover_at','handover_evidence'];break;
      case 'delivery':needed=['release_evidence','delivery_address','signed_at','pod_ref'];if(f.release_source==='unconfirmed')needed.push('release_source_confirmed');if(f.empty_return_required)needed.push('empty_return_at','empty_return_evidence');break;
    }
    if(needed.some(key=>!f[key]))throw new PortalError('fcl_execution_completion_needs_input');
  }
  nodeAction(ctx:PortalContext,action:'start'|'complete'|'exception'|'return'|'reopen'|'skip',input:unknown,key:string){
    const completion=action==='complete'?parse(fclExecutionNodeCompleteSchema,input):null;
    const request=completion??parse(fclExecutionNodeActionSchema,input);
    return this.mutate(ctx,`node_${action}`,request,key,value=>{this.nodeAccess(ctx,value,request.node_id);if(['reopen','skip'].includes(action))this.manager(ctx,value);},value=>{
      const node=this.nodeAccess(ctx,value,request.node_id),beforeNodes=[structuredClone(node)];
      if(action==='reopen'){
        if(!terminal(node))throw new PortalError('fcl_execution_transition_invalid');
        const scope=value.acceptances.at(-1)!.customer_scope;
        if(!scope.some(row=>row.service===FCL_NODE_SERVICES[node.node_id]&&['priced','included','free'].includes(row.disposition)))throw new PortalError('fcl_execution_scope_needs_input');
        node.cycle++;node.status='not_started';node.completed_at=null;node.started_at=null;
      }else{
        if(terminal(node))throw new PortalError('fcl_execution_node_closed');
        if(['start','complete'].includes(action)&&this.configurationMissing(node).length)throw new PortalError('fcl_execution_configuration_needs_input');
        if(action==='complete'){if(node.status==='not_started')throw new PortalError('fcl_execution_node_not_started');this.requireCompletion(node,value);node.status='completed';node.completed_at=this.now();}
        if(action==='start'){if(node.status==='active')return {reason:request.reason,node};node.status='active';node.started_at??=this.now();}
        if(action==='exception'||action==='return')node.status='exception';
        if(action==='skip'){node.status='skipped';node.completed_at=this.now();}
      }
      const targets=completion?.handoff_node_ids??[];
      if(targets.length){
        this.manager(ctx,value);
        if(new Set(targets).size!==targets.length||targets.includes(node.node_id))throw new PortalError('fcl_execution_input_invalid');
        for(const nodeId of targets){const next=this.nodeAccess(ctx,value,nodeId);if(next.status!=='not_started'||this.configurationMissing(next).length)throw new PortalError('fcl_execution_configuration_needs_input');beforeNodes.push(structuredClone(next));next.status='active';next.started_at=this.now();}
      }
      const lastSignal=value.history.slice().reverse().find(event=>event.node_id===node.node_id&&['node_exception','node_return'].includes(event.action));
      const newSignal=['exception','return'].includes(action)&&(lastSignal?.action!==`node_${action}`||lastSignal.reason!==request.reason);
      return {reason:request.reason,node,beforeNodes,notify:true,notifyNodes:targets.length?targets:[node.node_id],force:newSignal};
    });
  }
  assign(ctx:PortalContext,input:unknown,key:string){const request=parse(fclExecutionNodeAssignSchema,input);return this.mutate(ctx,'node_assign',request,key,value=>this.manager(ctx,value),value=>{
    const node=this.nodeAccess(ctx,value,request.node_id);if(terminal(node))throw new PortalError('fcl_execution_node_closed');
    const users=[request.assignment.responsible_id,...request.assignment.collaborator_ids].filter((id):id is string=>id!==null);
    if(users.some(id=>!this.active(id))||new Set(users).size!==users.length)throw new PortalError('fcl_execution_responsible_unavailable');
    if(new Set([request.assignment.to,...request.assignment.cc].filter(Boolean)).size!==request.assignment.cc.length+(request.assignment.to?1:0))throw new PortalError('fcl_execution_input_invalid');
    const beforeNodes=[structuredClone(node)],previous=node.assignment;
    const reassigned=previous.responsible_id!==request.assignment.responsible_id||JSON.stringify([...previous.collaborator_ids].sort())!==JSON.stringify([...request.assignment.collaborator_ids].sort());
    node.assignment=request.assignment;node.notification.assignment=request.assignment;
    if(request.external){const addresses=[request.external.external_to,...request.external.external_cc].filter(Boolean);if(new Set(addresses).size!==addresses.length)throw new PortalError('fcl_execution_input_invalid');Object.assign(node.notification,request.external);}
    node.assignment_source='case_override';return {reason:request.reason,node,beforeNodes,notify:reassigned};
  });}
  mention(ctx:PortalContext,input:unknown,key:string){
    const request=parse(fclExecutionNodeActionSchema,input);
    return this.mutate(ctx,'mention',request,key,value=>{this.nodeAccess(ctx,value,request.node_id);},value=>{
      const node=this.nodeAccess(ctx,value,request.node_id);
      if(terminal(node)||this.configurationMissing(node).length)throw new PortalError('fcl_execution_configuration_needs_input');
      if(!node.assignment.enabled||!node.assignment.to)throw new PortalError('fcl_execution_configuration_needs_input');
      return {reason:request.reason,node,notify:true,force:true};
    });
  }
  defaultsPreview(ctx:PortalContext,input:unknown){
    const request=parse(fclExecutionDefaultsSchema,input),value=this.getOwner(ctx,request.case_ref);if(!value)throw new PortalError('fcl_not_found');if(value.version!==request.expected_version)throw new PortalError('version_conflict');
    const config=this.configuration(ctx,request.expected_config_version),changes=value.nodes.filter(node=>node.status==='not_started').flatMap(node=>{const after=config.rows.find(row=>row.node_id===node.node_id)!;return JSON.stringify(node.notification)===JSON.stringify(after)?[]:[{node_id:node.node_id,before:node.notification,after}];});
    return fclExecutionDefaultsPreviewSchema.parse({preview_digest:executionDigest({request,changes}),configuration_version:config.version,changes});
  }
  applyDefaults(ctx:PortalContext,input:unknown,key:string){const request=parse(fclExecutionDefaultsApplySchema,input);return this.mutate(ctx,'apply_defaults',request,key,value=>{if(value.owner_id!==this.actor(ctx))throw new PortalError('fcl_not_found');},value=>{
    const preview=this.defaultsPreview(ctx,{contract_version:request.contract_version,case_ref:request.case_ref,expected_version:request.expected_version,expected_config_version:request.expected_config_version});
    if(preview.preview_digest!==request.preview_digest)throw new PortalError('fcl_execution_preview_changed');const beforeNodes=preview.changes.map(change=>structuredClone(value.nodes.find(n=>n.node_id===change.node_id)!));
    for(const change of preview.changes){const node=value.nodes.find(n=>n.node_id===change.node_id)!;node.notification=structuredClone(change.after);node.assignment=structuredClone(change.after.assignment);node.assignment_source='applied_default';}
    return {reason:'显式应用默认配置到未启动节点',beforeNodes};
  });}
  list(ctx:PortalContext,input:unknown){
    const request=parse(fclExecutionListSchema,input),user=this.actor(ctx);let cursor='';
    if(request.cursor){try{const c=z.object({user:z.string(),state:z.string(),case_ref:z.uuid()}).strict().parse(JSON.parse(Buffer.from(request.cursor,'base64url').toString()));if(c.user!==user||c.state!==request.state)throw new Error();cursor=c.case_ref;}catch{throw new PortalError('fcl_execution_input_invalid');}}
    // SQL restricts candidate visibility before pagination; no global in-memory case scan.
    const rows=this.cases.store.db.prepare(`SELECT case_id FROM fcl_case_progress p WHERE case_id>? AND (owner_id=? OR json_extract(payload,'$.coordinator_id')=? OR EXISTS(SELECT 1 FROM json_each(p.payload,'$.nodes') n WHERE json_extract(n.value,'$.assignment.responsible_id')=? OR EXISTS(SELECT 1 FROM json_each(n.value,'$.assignment.collaborator_ids') c WHERE c.value=?))) AND (? NOT IN ('executing','completed') OR json_extract(payload,'$.state')=?) AND (?<>'mine' OR EXISTS(SELECT 1 FROM json_each(p.payload,'$.nodes') n WHERE json_extract(n.value,'$.status') IN ('not_started','active','exception') AND (json_extract(n.value,'$.assignment.responsible_id')=? OR EXISTS(SELECT 1 FROM json_each(n.value,'$.assignment.collaborator_ids') c WHERE c.value=?)))) ORDER BY case_id LIMIT ?`).all(cursor,user,user,user,user,request.state,request.state,request.state,user,user,request.limit+1) as {case_id:string}[];
    const page=rows.slice(0,request.limit),items=page.map(row=>{const value=this.row(row.case_id)!;const projected=this.project(ctx,value),pending=projected.nodes.filter(node=>!terminal(node));return {case_ref:value.case_ref,inquiry_no:value.inquiry_no,customer_name:value.customer_name,route:value.route,state:value.state,coordinator_id:value.coordinator_id,pending_nodes:pending.map(node=>node.node_id),deadline:pending.map(n=>n.deadline).filter((v):v is string=>v!==null).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]??null,exception:pending.some(n=>n.status==='exception')};});
    return fclExecutionListOutputSchema.parse({items,next_cursor:rows.length>request.limit?Buffer.from(JSON.stringify({user,state:request.state,case_ref:page.at(-1)!.case_id})).toString('base64url'):null});
  }
  private workspaceCandidates(ctx:PortalContext,input:unknown){
    const request=parse(fclWorkspaceListSchema,input),user=ctx.identity.userId;let cursor='';
    if(!ctx.identity.emailVerified)throw new PortalError('fcl_not_found');
    if(request.cursor){try{const c=JSON.parse(Buffer.from(request.cursor,'base64url').toString()) as {user:string;phase:string;mine:boolean;case_ref:string};if(c.user!==user||c.phase!==request.phase||c.mine!==request.mine||!z.uuid().safeParse(c.case_ref).success)throw new Error();cursor=c.case_ref;}catch{throw new PortalError('fcl_execution_input_invalid');}}
    const rows=this.cases.store.db.prepare(`SELECT c.case_id,c.owner_id FROM business_cases c JOIN fcl_inquiries i ON i.case_id=c.case_id LEFT JOIN fcl_case_progress p ON p.case_id=c.case_id WHERE c.case_id>? AND (c.owner_id=? OR json_extract(p.payload,'$.coordinator_id')=? OR EXISTS(SELECT 1 FROM json_each(p.payload,'$.nodes') n WHERE json_extract(n.value,'$.assignment.responsible_id')=? OR EXISTS(SELECT 1 FROM json_each(n.value,'$.assignment.collaborator_ids') a WHERE a.value=?))) ORDER BY c.case_id LIMIT ?`).all(cursor,user,user,user,user,request.limit+1) as {case_id:string;owner_id:string}[];
    return {request,rows,user};
  }
  // Only used to verify authority for already caller-scoped list candidates.
  workspaceAuthorityIds(ctx:PortalContext,input:unknown){return this.workspaceCandidates(ctx,input).rows.map(r=>r.owner_id);}
  listAuthorityIds(ctx:PortalContext){
    const user=ctx.identity.userId;
    return (this.cases.store.db.prepare(`SELECT DISTINCT owner_id FROM fcl_case_progress p WHERE owner_id=? OR json_extract(payload,'$.coordinator_id')=? OR EXISTS(SELECT 1 FROM json_each(p.payload,'$.nodes') n WHERE json_extract(n.value,'$.assignment.responsible_id')=? OR EXISTS(SELECT 1 FROM json_each(n.value,'$.assignment.collaborator_ids') c WHERE c.value=?)) LIMIT 101`).all(user,user,user,user) as {owner_id:string}[]).map(row=>row.owner_id);
  }
  workspaceList(ctx:PortalContext,input:unknown,isAwaiting:(caseRef:string)=>boolean){
    this.actor(ctx);const {request,rows,user}=this.workspaceCandidates(ctx,input),page=rows.slice(0,request.limit);
    const items: z.infer<typeof fclWorkspaceListOutputSchema>['items']=[];
    for(const row of page){
      if(!this.active(row.owner_id))continue;
      const execution=this.row(row.case_id);
      let item:z.infer<typeof fclWorkspaceListOutputSchema>['items'][number];
      if(execution){const view=this.project(ctx,execution),pending=view.nodes.filter(n=>!terminal(n));if(request.mine&&!pending.some(n=>[n.assignment.responsible_id,...n.assignment.collaborator_ids].includes(user)))continue;item={case_ref:row.case_id,inquiry_no:view.inquiry_no,customer_name:view.customer_name,route:view.route,phase:view.state,coordinator_id:view.coordinator_id,pending_nodes:pending.map(n=>n.node_id),deadline:pending.map(n=>n.deadline).filter((v):v is string=>v!==null).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]??null,exception:pending.some(n=>n.status==='exception')};}
      else{const view=this.cases.getFclCase(ctx,row.case_id),input=view.current_input,awaiting=isAwaiting(row.case_id);item={case_ref:row.case_id,inquiry_no:view.inquiry_no,customer_name:input.contact.company||input.contact.name,route:[input.pol,input.pod,input.final_destination].filter((place,index,places)=>place&&place!==places[index-1]).join(' → '),phase:awaiting?'awaiting_confirmation':'inquiry_quote',coordinator_id:user,pending_nodes:[awaiting?'customer_followup':view.review_context.review_required?'intake':'quote'],deadline:null,exception:view.case_status==='needs_input'};}
      if(request.phase==='all'||item.phase===request.phase)items.push(item);
    }
    // Filtering is bounded to one scan page; an empty page can still carry a continuation cursor.
    return fclWorkspaceListOutputSchema.parse({items,next_cursor:rows.length>request.limit?Buffer.from(JSON.stringify({user,phase:request.phase,mine:request.mine,case_ref:page.at(-1)!.case_id})).toString('base64url'):null});
  }
  // Service-only port for the outbox worker; it is deliberately absent from HTTP/CLI actions.
  readForDispatch(caseRef:string){return this.row(caseRef);}
  mailAction(ctx:PortalContext,input:unknown,key:string,retry=false){
    const request=retry?parse(fclMailRetrySchema,input):parse(fclMailResolveSchema,input);
    return this.mutate(ctx,retry?'mail_retry':'mail_resolve',request,key,value=>this.manager(ctx,value),()=>{
      const db=this.cases.store.db,row=db.prepare('SELECT payload FROM fcl_execution_outbox WHERE message_id=? AND case_id=?').get(request.message_id,request.case_ref) as {payload:string}|undefined;
      if(!row)throw new PortalError('fcl_not_found');const message=fclOutboxSchema.parse(JSON.parse(row.payload));
      if(retry){if(message.status!=='failed')throw new PortalError('fcl_mail_result_requires_verification');message.status='pending';message.result_code=null;}
      else{
        if(!['unknown','failed','pending'].includes(message.status)||!('outcome' in request))throw new PortalError('fcl_mail_resolution_invalid');
        message.status=request.outcome==='confirmed_accepted'?'smtp_accepted':request.outcome==='confirmed_not_sent'?'failed':'cancelled';message.result_code=`human_${String(request.outcome)}`;
      }
      message.updated_at=this.now();message.lease_token=null;message.lease_until=null;
      message.resolutions.push({actor_id:ctx.identity.userId,reason:request.reason,at:message.updated_at,outcome:retry?'retry':('outcome' in request?String(request.outcome):'')});fclOutboxSchema.parse(message);
      db.prepare('UPDATE fcl_execution_outbox SET status=?,payload=? WHERE message_id=?').run(message.status,JSON.stringify(message),message.message_id);
      const check=db.prepare('SELECT payload FROM fcl_execution_outbox WHERE message_id=?').get(message.message_id) as {payload:string};if(check.payload!==JSON.stringify(message))throw new PortalError('fcl_execution_readback_failed');
      return {reason:request.reason,force:true};
    });
  }
}
