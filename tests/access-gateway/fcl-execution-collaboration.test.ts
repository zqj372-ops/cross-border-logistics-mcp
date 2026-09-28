import {expect,it} from 'vitest';
import {FclExecutionService} from '../../services/access-gateway/portal/fcl-execution';
import {FCL_EXECUTION_VERSION,FCL_NOTIFICATION_V2,emptyFclNotificationConfig} from '../../services/access-gateway/portal/fcl-execution-contracts';
import {receiver,other,readyFixture,closeFixture,handoffRequest} from '../quote-documents/fixtures/fcl-execution';

it('isolates defaults, only migrates intake, and preserves v2 nodes through a v1 save',async()=>{
  const f=await readyFixture();try{
    f.rateService.saveFclNotification(receiver,{contract_version:'fcl-notification@2026-09-21.v1',expected_version:0,input:{enabled:true,recipient:'intake@example.test',cc:[]},confirmed:true},'notification-legacy-0001');
    const migrated=f.rateService.getFclNotificationV2(receiver);
    expect(migrated.rows[0]?.assignment.to).toBe('intake@example.test');
    expect(migrated.rows.slice(1).every(row=>row.assignment.to===null)).toBe(true);
    const rows=structuredClone(migrated.rows),booking=rows.find(row=>row.node_id==='booking')!;
    booking.assignment={responsible_id:receiver.identity.userId,collaborator_ids:[],to:'booking@example.test',cc:[],enabled:true};
    const saved=f.rateService.saveFclNotificationV2(receiver,{contract_version:FCL_NOTIFICATION_V2,expected_version:1,rows,confirmed:true},'notification-v2-0001');
    expect(saved.version).toBe(2);
    expect(f.rateService.getFclNotificationV2(other).rows.every(row=>row.assignment.to===null)).toBe(true);
    f.rateService.saveFclNotification(receiver,{contract_version:'fcl-notification@2026-09-21.v1',expected_version:2,input:{enabled:false,recipient:null,cc:[]},confirmed:true},'notification-legacy-0002');
    expect(f.rateService.getFclNotificationV2(receiver).rows.find(row=>row.node_id==='booking')?.assignment.to).toBe('booking@example.test');
    expect(()=>f.rateService.saveFclNotificationV2(receiver,{contract_version:FCL_NOTIFICATION_V2,expected_version:2,rows,confirmed:true},'notification-stale-0001')).toThrow('version_conflict');
  }finally{closeFixture(f);}
});

it('allows only assigned-node work, revokes old assignees, and preserves quotation authority',async()=>{
  const f=await readyFixture();try{
    let config=emptyFclNotificationConfig();
    const active=new Set([receiver.identity.userId,other.identity.userId]);
    const execution=new FclExecutionService(f.caseService,{isActive:id=>active.has(id),now:()=> '2026-10-08T12:00:00Z',configuration:()=>config});
    const req={contract_version:FCL_EXECUTION_VERSION,handoff:handoffRequest(f),confirmation:{method:'email',confirmed_at:'2026-10-08T11:00:00Z',contact_name:'Customer',note:'Accepted',evidence_refs:[]},coordinator_id:receiver.identity.userId,expected_config_version:0,confirmed:true};
    let progress=f.workflow.startFclExecution(receiver,req,'collab-start-0001',execution);
    const action=()=>({contract_version:FCL_EXECUTION_VERSION,case_ref:progress.case_ref,expected_version:progress.version,node_id:'booking',reason:'Explicit action',confirmed:true});
    expect(()=>execution.nodeAction(receiver,'start',action(),'collab-missing-0001')).toThrow('needs_input');
    const assigned=execution.assign(receiver,{...action(),assignment:{responsible_id:other.identity.userId,collaborator_ids:[],to:null,cc:[],enabled:false}},'collab-assign-0001');
    progress={...progress,...assigned};
    const view=execution.get(other,{case_ref:progress.case_ref});
    expect(view?.nodes.map(n=>n.node_id)).toEqual(['booking']);
    expect(view).not.toHaveProperty('acceptances');expect(view).not.toHaveProperty('history');
    expect(()=>f.caseService.getFclCase(other,progress.case_ref)).toThrow('fcl_not_found');
    expect(()=>f.workflow.getFclQuote(other,{contract_version:'fcl-document-workflow@2026-09-20.v1',quote_ref:f.quote.quote_ref,version:null})).toThrow();
    expect(()=>execution.nodeAction(other,'start',{...action(),node_id:'shipping_documents'},'collab-other-node-0001')).toThrow('fcl_not_found');
    const started=execution.nodeAction(other,'start',action(),'collab-start-node-0001');progress.version=started.version;
    expect(()=>execution.nodeAction(other,'complete',action(),'collab-no-proof-0001')).toThrow('needs_input');
    config={...config,version:1,rows:config.rows.map(row=>({...row,assignment:{...row.assignment,responsible_id:receiver.identity.userId}}))};
    expect(execution.get(receiver,{case_ref:progress.case_ref})?.nodes[0]?.assignment.responsible_id).toBe(other.identity.userId);
    const reassigned=execution.assign(receiver,{...action(),assignment:{responsible_id:receiver.identity.userId,collaborator_ids:[],to:null,cc:[],enabled:false}},'collab-reassign-0001');progress.version=reassigned.version;
    expect(()=>execution.get(other,{case_ref:progress.case_ref})).toThrow('fcl_not_found');
    expect(()=>execution.nodeAction(other,'start',action(),'collab-start-node-0001')).toThrow('fcl_not_found');
    active.delete(receiver.identity.userId);
    expect(()=>execution.get(receiver,{case_ref:progress.case_ref})).toThrow('fcl_not_found');
  }finally{closeFixture(f);}
});
