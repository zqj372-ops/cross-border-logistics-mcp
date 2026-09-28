import {expect,it} from 'vitest';
import {NativeAdminService} from '../../services/access-gateway/portal/native-admin';
import {FclExecutionService} from '../../services/access-gateway/portal/fcl-execution';
import {FCL_EXECUTION_VERSION,FCL_NOTIFICATION_V2,emptyFclNotificationConfig} from '../../services/access-gateway/portal/fcl-execution-contracts';
import {receiver,readyFixture,closeFixture,handoffRequest} from '../quote-documents/fixtures/fcl-execution';

it('previews only synthetic data, persists test outcomes, prevents replay sends, and rate limits explicit tests',async()=>{
  const f=await readyFixture();try{
    const sent:string[]=[];let partial=false;
    const service=new NativeAdminService(f.rateStore,f.caseService.portal,{receiverUserId:receiver.identity.userId,receiverIsActive:()=>true,now:()=> '2026-10-08T12:00:00.000Z',mailConfigured:()=>true,mailTransport:{send:message=>{sent.push(JSON.stringify(message));if(partial)throw new Error('fcl_smtp_partial_unknown');}}});
    const rows=service.getFclNotificationV2(receiver).rows;rows[3]!.assignment={responsible_id:receiver.identity.userId,collaborator_ids:[],to:'synthetic@example.test',cc:[],enabled:true};rows[3]!.visible_fields=['booking_so','eta'];
    const unsupported=structuredClone(rows);unsupported[0]!.external_enabled=true;unsupported[0]!.external_to='external@example.test';
    expect(()=>service.saveFclNotificationV2(receiver,{contract_version:FCL_NOTIFICATION_V2,expected_version:0,rows:unsupported,confirmed:true},'test-unsupported-external')).toThrow('native_input_invalid');
    service.saveFclNotificationV2(receiver,{contract_version:FCL_NOTIFICATION_V2,expected_version:0,rows,confirmed:true},'test-notification-save');
    expect(sent).toEqual([]);
    const preview=service.previewFclNotification(receiver,{node_id:'booking',audience:'internal'});expect(preview.body).toContain('合成测试客户');expect(preview.body).not.toContain(f.confirmed.inquiry_no);
    expect(preview.body).toContain('Booking / SO：TEST-SO');expect(preview.body).toContain('2026-01-02 09:00 UTC-08:00');expect(preview.body).not.toContain('TEST-CARRIER');
    const input={node_id:'booking',audience:'internal',expected_version:1,confirmed:true};
    const first=await service.testFclNotification(receiver,input,'test-notification-send');expect(first.status).toBe('smtp_accepted');
    expect(await service.testFclNotification(receiver,input,'test-notification-send')).toEqual(first);expect(sent).toHaveLength(1);
    partial=true;expect((await service.testFclNotification(receiver,input,'test-notification-two')).status).toBe('unknown');
    await service.testFclNotification(receiver,input,'test-notification-three');
    await expect(service.testFclNotification(receiver,input,'test-notification-four')).rejects.toThrow('fcl_rate_limited');
    expect(sent).toHaveLength(3);expect(service.getFclNotificationV2(receiver).transport).toBe('configured_unverified');
  }finally{closeFixture(f);}
});

it('applies a previewed default revision only to unstarted nodes and rejects a changed preview',async()=>{
  const f=await readyFixture();try{
    let config=emptyFclNotificationConfig();for(const row of config.rows)row.assignment.responsible_id=receiver.identity.userId;
    const execution=new FclExecutionService(f.caseService,{isActive:()=>true,now:()=> '2026-10-08T12:00:00Z',configuration:()=>config});
    const p=f.workflow.startFclExecution(receiver,{contract_version:FCL_EXECUTION_VERSION,handoff:handoffRequest(f),confirmation:{method:'email',confirmed_at:'2026-10-08T11:00:00Z',contact_name:'Customer',note:'Accepted',evidence_refs:[]},coordinator_id:receiver.identity.userId,expected_config_version:0,confirmed:true},'defaults-start-0001',execution);
    const active=execution.nodeAction(receiver,'start',{contract_version:FCL_EXECUTION_VERSION,case_ref:p.case_ref,expected_version:1,node_id:'booking',reason:'Start',confirmed:true},'defaults-active-0001');
    config={...config,version:1,rows:config.rows.map(r=>({...r,assignment:{...r.assignment,to:'updated@example.test',enabled:true}}))};
    const request={contract_version:FCL_EXECUTION_VERSION,case_ref:p.case_ref,expected_version:active.version,expected_config_version:1};
    const preview=execution.defaultsPreview(receiver,request);expect(preview.changes.map(c=>c.node_id)).toEqual(['shipping_documents']);
    expect(()=>execution.applyDefaults(receiver,{...request,preview_digest:'0'.repeat(64),confirmed:true},'defaults-wrong-0001')).toThrow('preview_changed');
    const changed=execution.applyDefaults(receiver,{...request,preview_digest:preview.preview_digest,confirmed:true},'defaults-apply-0001');
    expect(changed.nodes.find(n=>n.node_id==='booking')?.assignment.to).toBeNull();expect(changed.nodes.find(n=>n.node_id==='shipping_documents')?.assignment.to).toBe('updated@example.test');
  }finally{closeFixture(f);}
});
