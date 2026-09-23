import type {PortalContext} from './contracts';
import {PortalError} from './contracts';
import type {DocumentWorkflowService} from '../../quote-documents/workflow';
import type {NativeAdminService} from './native-admin';
import type {FclExecutionService} from './fcl-execution';
import type {FclExecutionMailService} from './fcl-execution-mail';
import type {FclExecutionAction} from './fcl-execution-http-contracts';
import type {FclExecutionDirectory} from './fcl-execution-identity';

export class FclExecutionHttpService{
  constructor(readonly execution:FclExecutionService,readonly workflow:DocumentWorkflowService,readonly native:NativeAdminService,readonly mail:FclExecutionMailService,readonly directory?:FclExecutionDirectory){}
  async execute(ctx:PortalContext,action:FclExecutionAction,input:unknown,key:()=>string):Promise<unknown>{
    const run=async()=>{
      switch(action){
        case 'case-mail-resolve':return this.mail.resolveCaseMail(ctx,input,key());
        case 'case-mail-retry':return this.mail.resolveCaseMail(ctx,input,key(),true);
        case 'execution-preview':return this.workflow.previewFclExecution(ctx,input,this.execution);
        case 'execution-start':return this.execution.project(ctx,this.workflow.startFclExecution(ctx,input,key(),this.execution));
        case 'execution-amend-preview':return this.workflow.previewFclExecutionAmend(ctx,input,this.execution);
        case 'execution-amend':return this.execution.project(ctx,this.workflow.amendFclExecution(ctx,input,key(),this.execution));
        case 'execution-history':return this.execution.history(ctx,input);
        case 'execution-get':return this.execution.get(ctx,input);
        case 'workspace-list':return this.execution.workspaceList(ctx,input,caseRef=>this.workflow.fclAwaitingCustomerConfirmation(ctx,caseRef));
        case 'execution-node-mention':return this.execution.mention(ctx,input,key());
        case 'execution-list':return this.execution.list(ctx,input);
        case 'execution-shared-save':return this.execution.saveShared(ctx,input,key());
        case 'execution-node-save':return this.execution.saveNode(ctx,input,key());
        case 'execution-node-start':return this.execution.nodeAction(ctx,'start',input,key());
        case 'execution-node-complete':return this.execution.nodeAction(ctx,'complete',input,key());
        case 'execution-node-exception':return this.execution.nodeAction(ctx,'exception',input,key());
        case 'execution-node-return':return this.execution.nodeAction(ctx,'return',input,key());
        case 'execution-node-reopen':return this.execution.nodeAction(ctx,'reopen',input,key());
        case 'execution-node-skip':return this.execution.nodeAction(ctx,'skip',input,key());
        case 'execution-node-assign':return this.execution.assign(ctx,input,key());
        case 'execution-defaults-preview':return this.execution.defaultsPreview(ctx,input);
        case 'execution-defaults-apply':return this.execution.applyDefaults(ctx,input,key());
        case 'execution-mail-list':return this.mail.list(ctx,input);
        case 'execution-mail-resolve':return this.execution.mailAction(ctx,input,key());
        case 'execution-mail-retry':return this.execution.mailAction(ctx,input,key(),true);
        case 'notification-v2-get':return this.native.getFclNotificationV2(ctx);
        case 'notification-v2-save':return this.native.saveFclNotificationV2(ctx,input,key());
        case 'notification-preview':return this.native.previewFclNotification(ctx,input);
        case 'notification-test':return this.native.testFclNotification(ctx,input,key());
      }
    };
    if(!this.directory)return run();
    const ids=new Set([ctx.identity.userId]);
    // Only identity references from already schema-validated input are considered.
    const collect=(value:unknown)=>{
      if(!value||typeof value!=='object')return;
      for(const [key,item] of Object.entries(value)){
        if(['responsible_id','coordinator_id'].includes(key)&&typeof item==='string')ids.add(item);
        else if(key==='collaborator_ids'&&Array.isArray(item)){for(const id of item)if(typeof id==='string')ids.add(id);}
        else if(item&&typeof item==='object')collect(item);
      }
    };
    collect(input);
    if(action==='workspace-list')for(const id of this.execution.workspaceAuthorityIds(ctx,input))ids.add(id);
    if(action==='execution-list')for(const id of this.execution.listAuthorityIds(ctx))ids.add(id);
    const record=input as {case_ref?:string;handoff?:{case_ref:string}};
    const caseRef=record.case_ref??record.handoff?.case_ref;
    if(caseRef){const current=this.execution.readForDispatch(caseRef);if(current){ids.add(current.owner_id);ids.add(current.coordinator_id);collect(current.nodes);}}
    const config=this.native.getFclNotificationV2(ctx);collect(config.rows);
    return this.directory.run([...ids],()=>{
      if(!this.directory!.isActive(ctx.identity.userId))throw new PortalError('fcl_execution_authority_unavailable');
      return run();
    });
  }
}
