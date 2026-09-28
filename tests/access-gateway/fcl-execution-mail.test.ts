import {expect,it} from 'vitest';
import {FclExecutionService} from '../../services/access-gateway/portal/fcl-execution';
import {FclExecutionMailService} from '../../services/access-gateway/portal/fcl-execution-mail';
import {FCL_EXECUTION_VERSION,emptyFclNotificationConfig} from '../../services/access-gateway/portal/fcl-execution-contracts';
import type {FclMailMessage} from '../../services/access-gateway/portal/cases';
import {CaseService,CaseStore} from '../../services/access-gateway/portal/cases';
import {join} from 'node:path';
import {receiver,other,readyFixture,closeFixture,handoffRequest} from '../quote-documents/fixtures/fcl-execution';

async function setup(send:(message:FclMailMessage)=>Promise<void>|void){
  const f=await readyFixture();let now='2026-10-08T12:00:00Z';
  const config=emptyFclNotificationConfig();
  const booking=config.rows.find(row=>row.node_id==='booking')!;
  booking.assignment={responsible_id:receiver.identity.userId,collaborator_ids:[],to:'internal@example.test',cc:['copy@example.test'],enabled:true};
  booking.external_enabled=true;booking.external_to='carrier@example.test';

  const execution=new FclExecutionService(f.caseService,{isActive:()=>true,now:()=>now,configuration:()=>config,onEvent:(progress,event)=>mail.enqueue(progress,event)});
  const mail:FclExecutionMailService=new FclExecutionMailService(execution,{publicOrigin:'https://portal.example.test',transport:{send},verifyUsers:()=>Promise.resolve('active' as const),now:()=>now,leaseMs:1000});
  const req={contract_version:FCL_EXECUTION_VERSION,handoff:handoffRequest(f),confirmation:{method:'email',confirmed_at:'2026-10-08T11:00:00Z',contact_name:'SECRET CUSTOMER CONTACT',note:'SECRET ACCEPTANCE NOTE',evidence_refs:[]},coordinator_id:receiver.identity.userId,expected_config_version:0,confirmed:true};
  const progress=f.workflow.startFclExecution(receiver,req,'outbox-start-0001',execution);
  return {...f,execution,mail,progress,setNow:(v:string)=>{now=v;}};
}

it('persists audience-separated messages atomically, sends real To/Cc and never sends on an ordinary save',async()=>{
  const sent:FclMailMessage[]=[];const f=await setup(m=>{sent.push(m);});try{
    const configured=f.execution.assign(receiver,{contract_version:FCL_EXECUTION_VERSION,case_ref:f.progress.case_ref,expected_version:1,node_id:'booking',reason:'Keep the saved recipients as a case override',confirmed:true,assignment:f.progress.nodes[0]!.assignment},'outbox-config-only-save');
    expect(f.mail.list(receiver,{case_ref:f.progress.case_ref}).items).toHaveLength(0);
    const start={contract_version:FCL_EXECUTION_VERSION,case_ref:f.progress.case_ref,expected_version:configured.version,node_id:'booking',reason:'Start booking',confirmed:true};
    f.execution.nodeAction(receiver,'start',start,'outbox-node-start-01');
    f.execution.nodeAction(receiver,'start',start,'outbox-node-start-01');
    expect(f.mail.list(receiver,{case_ref:f.progress.case_ref}).items).toHaveLength(2);
    const view=f.execution.get(receiver,{case_ref:f.progress.case_ref})!,node=view.nodes[0]!;
    f.execution.saveNode(receiver,{contract_version:FCL_EXECUTION_VERSION,case_ref:view.case_ref,expected_version:view.version,node_id:node.node_id,deadline:null,notes:'SECRET INTERNAL COST 5000',evidence_refs:['private:internal-only'],fields:node.fields},'outbox-draft-save-01');
    expect(f.mail.list(receiver,{case_ref:f.progress.case_ref}).items).toHaveLength(2);
    await f.mail.dispatchOnce();await f.mail.dispatchOnce();await f.mail.dispatchOnce();
    expect(sent).toHaveLength(2);
    expect(sent.find(m=>m.to==='internal@example.test')?.cc).toEqual(['copy@example.test']);
    expect(sent.find(m=>m.to==='internal@example.test')?.body).toContain(`https://portal.example.test/console/#fcl/case/${view.case_ref}`);
    const external=sent.find(m=>m.to==='carrier@example.test')!;
    expect(external.cc).toEqual([]);expect(external.body).not.toContain('/console/');
    expect(JSON.stringify(sent)).not.toMatch(/SECRET|private:internal-only/);
    expect(f.mail.list(receiver,{case_ref:f.progress.case_ref}).items.every(m=>m.status==='smtp_accepted')).toBe(true);
  }finally{closeFixture(f);}
});

it('claims each queued message once across independent database connections and survives a worker restart',async()=>{
  const sent:string[]=[];let release!:()=>void;
  const f=await setup(async message=>{sent.push(message.to);await new Promise<void>(resolve=>{release=resolve;});});
  const secondStore=new CaseStore(join(f.root,'cases.sqlite'),{fcl:{mode:'reopen'},execution:{mode:'reopen'}});
  try{
    const cases=new CaseService(secondStore,f.caseService.portal,{receiverUserId:receiver.identity.userId,receiverIsActive:()=>true,credentialSecret:'synthetic-restart-secret-32-bytes',credentialTtlDays:30});
    const execution=new FclExecutionService(cases,{isActive:()=>true});
    const restarted=new FclExecutionMailService(execution,{transport:{send:message=>{sent.push(message.to);}},verifyUsers:()=>Promise.resolve('active'),now:()=> '2026-10-08T12:00:00Z'});
    f.execution.nodeAction(receiver,'start',{contract_version:FCL_EXECUTION_VERSION,case_ref:f.progress.case_ref,expected_version:1,node_id:'booking',reason:'Start',confirmed:true},'outbox-two-workers-start');
    const first=f.mail.dispatchOnce();await new Promise(resolve=>setImmediate(resolve));
    try{await restarted.dispatchOnce();}finally{release();await first;}
    await restarted.dispatchOnce();await f.mail.dispatchOnce();
    expect(sent.sort()).toEqual(['carrier@example.test','internal@example.test']);
    expect(restarted.list(receiver,{case_ref:f.progress.case_ref}).items.every(m=>m.status==='smtp_accepted'&&m.attempts===1)).toBe(true);
  }finally{secondStore.close();closeFixture(f);}
});

it('keeps timeout and partial-recipient results unknown without automatic retransmission',async()=>{
  let calls=0,accept=false;const f=await setup(()=>{calls++;if(!accept)throw new Error('fcl_smtp_partial_unknown');});try{
    f.execution.nodeAction(receiver,'start',{contract_version:FCL_EXECUTION_VERSION,case_ref:f.progress.case_ref,expected_version:1,node_id:'booking',reason:'Start',confirmed:true},'outbox-unknown-start');
    await f.mail.dispatchOnce();await f.mail.dispatchOnce();await f.mail.dispatchOnce();
    expect(calls).toBe(2);expect(f.mail.list(receiver,{case_ref:f.progress.case_ref}).items.every(m=>m.status==='unknown')).toBe(true);
    const message=f.mail.list(receiver,{case_ref:f.progress.case_ref}).items[0]!;
    expect(()=>f.execution.mailAction(receiver,{contract_version:FCL_EXECUTION_VERSION,case_ref:f.progress.case_ref,expected_version:2,message_id:message.message_id,reason:'Retry',confirmed:true},'outbox-unsafe-retry',true)).toThrow('requires_verification');
    expect(f.execution.get(receiver,{case_ref:f.progress.case_ref})?.nodes[0]?.status).toBe('active');
    const request={contract_version:FCL_EXECUTION_VERSION,case_ref:f.progress.case_ref,expected_version:2,message_id:message.message_id,reason:'Verified against the synthetic relay log: no recipient accepted',confirmed:true};
    const resolved=f.execution.mailAction(receiver,{...request,outcome:'confirmed_not_sent'},'outbox-verified-not-sent');
    f.execution.mailAction(receiver,{...request,expected_version:resolved.version,reason:'Explicit retry after verification'},'outbox-verified-retry',true);
    const queued=f.mail.list(receiver,{case_ref:f.progress.case_ref}).items.find(item=>item.message_id===message.message_id)!;
    expect(queued.resolutions.map(item=>item.outcome)).toEqual(['confirmed_not_sent','retry']);
    expect(queued.resolutions.every(item=>item.actor_id===receiver.identity.userId&&item.reason)).toBe(true);
    accept=true;await f.mail.dispatchOnce();expect(calls).toBe(3);
    expect(f.mail.list(receiver,{case_ref:f.progress.case_ref}).items.find(item=>item.message_id===message.message_id)?.status).toBe('smtp_accepted');
  }finally{closeFixture(f);}
});

it('cancels stale assignments and treats a crashed sending lease as unknown on another worker',async()=>{
  let release!:()=>void;let called=0;
  const f=await setup(async()=>{called++;await new Promise<void>(resolve=>{release=resolve;});});try{
    f.execution.nodeAction(receiver,'start',{contract_version:FCL_EXECUTION_VERSION,case_ref:f.progress.case_ref,expected_version:1,node_id:'booking',reason:'Start',confirmed:true},'outbox-claim-start');
    const sending=f.mail.dispatchOnce();
    await new Promise(resolve=>setImmediate(resolve));
    const second=new FclExecutionMailService(f.execution,{transport:{send:()=>{throw new Error('must not resend');}},verifyUsers:()=>Promise.resolve('active' as const),now:()=> '2026-10-08T12:00:02Z',leaseMs:1000});
    f.setNow('2026-10-08T12:00:02Z');
    f.execution.assign(receiver,{contract_version:FCL_EXECUTION_VERSION,case_ref:f.progress.case_ref,expected_version:2,node_id:'booking',reason:'Reassign',confirmed:true,assignment:{responsible_id:other.identity.userId,collaborator_ids:[],to:'new@example.test',cc:[],enabled:true}},'outbox-reassign-0001');
    await second.dispatchOnce();release();await sending;
    const items=f.mail.list(receiver,{case_ref:f.progress.case_ref}).items;
    expect(called).toBe(1);expect(items.some(m=>m.status==='unknown')).toBe(true);expect(items.some(m=>m.status==='cancelled')).toBe(true);
  }finally{closeFixture(f);}
});
