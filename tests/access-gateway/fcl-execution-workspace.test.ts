import {expect,it} from 'vitest';
import {FclExecutionService} from '../../services/access-gateway/portal/fcl-execution';
import {FCL_EXECUTION_VERSION,emptyFclNotificationConfig} from '../../services/access-gateway/portal/fcl-execution-contracts';
import {receiver,other,readyFixture,closeFixture,handoffRequest} from '../quote-documents/fixtures/fcl-execution';

it('combines owner inquiries with assigned execution nodes and scopes phase cursors',async()=>{
  const f=await readyFixture();try{
    const execution=new FclExecutionService(f.caseService,{isActive:()=>true,now:()=> '2026-10-08T12:00:00Z'});
    const own=execution.workspaceList(receiver,{phase:'all'},()=>true);
    expect(own.items[0]?.phase).toBe('awaiting_confirmation');
    expect(execution.workspaceList(other,{},()=>true).items).toEqual([]);
    const config=emptyFclNotificationConfig();config.rows.find(r=>r.node_id==='booking')!.assignment.responsible_id=other.identity.userId;
    execution.options.configuration=()=>config;
    const p=f.workflow.startFclExecution(receiver,{contract_version:FCL_EXECUTION_VERSION,handoff:handoffRequest(f),confirmation:{method:'email',confirmed_at:'2026-10-08T11:00:00Z',contact_name:'Customer',note:'Accepted',evidence_refs:[]},coordinator_id:receiver.identity.userId,expected_config_version:0,confirmed:true},'workspace-start-0001',execution);
    const assigned=execution.workspaceList(other,{mine:true},()=>{throw new Error('participants must never query quotation');});
    expect(assigned.items[0]?.case_ref).toBe(p.case_ref);
    expect(assigned.items[0]?.pending_nodes).toEqual(['booking']);
    expect(JSON.stringify(assigned)).not.toContain('quote_digest');
    expect(execution.workspaceList(receiver,{phase:'inquiry_quote'},()=>true).items).toEqual([]);
    const list=execution.list(other,{state:'mine'});expect(list.items).toHaveLength(1);
    let currentVersion=p.version;
    for(const node of p.nodes){
      currentVersion=execution.saveNode(receiver,{contract_version:FCL_EXECUTION_VERSION,case_ref:p.case_ref,expected_version:currentVersion,node_id:node.node_id,fields:node.fields,deadline:node.node_id==='booking'?'2026-10-08T09:00:00-07:00':'2026-10-08T10:00:00+08:00',notes:'',evidence_refs:[]},`timezone-deadline-${node.node_id}`).version;
    }
    expect(execution.workspaceList(receiver,{},()=>true).items[0]?.deadline).toBe('2026-10-08T10:00:00+08:00');
  }finally{closeFixture(f);}
});

it('records explicit mentions once and preserves a per-case external override',async()=>{
  const f=await readyFixture();try{
    let events=0;
    const config=emptyFclNotificationConfig();Object.assign(config.rows.find(r=>r.node_id==='booking')!.assignment,{responsible_id:receiver.identity.userId,enabled:true,to:'internal@example.test'});
    const execution=new FclExecutionService(f.caseService,{isActive:()=>true,now:()=> '2026-10-08T12:00:00Z',configuration:()=>config,onEvent:()=>{events++;}});
    const p=f.workflow.startFclExecution(receiver,{contract_version:FCL_EXECUTION_VERSION,handoff:handoffRequest(f),confirmation:{method:'email',confirmed_at:'2026-10-08T11:00:00Z',contact_name:'Customer',note:'Accepted',evidence_refs:[]},coordinator_id:receiver.identity.userId,expected_config_version:0,confirmed:true},'mention-start-0001',execution);
    const input={contract_version:FCL_EXECUTION_VERSION,case_ref:p.case_ref,expected_version:p.version,node_id:'booking',reason:'Please verify this node',confirmed:true};
    const mentioned=execution.mention(receiver,input,'mention-event-0001');
    execution.mention(receiver,input,'mention-event-0001');expect(events).toBe(2);
    expect(()=>execution.mention(other,{...input,expected_version:mentioned.version},'mention-invalid-0001')).toThrow('fcl_not_found');
    const assigned=execution.assign(receiver,{...input,expected_version:mentioned.version,assignment:config.rows.find(r=>r.node_id==='booking')!.assignment,external:{external_to:'fleet@example.test',external_cc:[],external_enabled:true,visible_fields:['booking_so']}},'case-external-0001');
    expect(assigned.nodes[0]?.notification.external_to).toBe('fleet@example.test');
    expect(config.rows.find(r=>r.node_id==='booking')!.external_to).toBeNull();
    const signal={...input,expected_version:assigned.version,reason:'First exception'};
    const exception=execution.nodeAction(receiver,'exception',signal,'exception-first-0001');
    const repeat=execution.nodeAction(receiver,'exception',{...signal,expected_version:exception.version},'exception-repeat-0001');
    expect(repeat.version).toBe(exception.version);
    const additional=execution.nodeAction(receiver,'exception',{...signal,expected_version:repeat.version,reason:'Additional evidence received'},'exception-new-reason-01');
    expect(additional.version).toBe(repeat.version+1);
    expect('history' in additional&&additional.history.at(-1)?.reason).toBe('Additional evidence received');
  }finally{closeFixture(f);}
});
