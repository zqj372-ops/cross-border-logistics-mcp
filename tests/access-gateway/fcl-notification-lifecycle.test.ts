import {expect,it} from 'vitest';
import {CaseService} from '../../services/access-gateway/portal/cases';
import {FclExecutionService} from '../../services/access-gateway/portal/fcl-execution';
import {FclExecutionMailService} from '../../services/access-gateway/portal/fcl-execution-mail';
import {FCL_NOTIFICATION_V2} from '../../services/access-gateway/portal/fcl-execution-contracts';
import {receiver,other,readyFixture,closeFixture} from '../quote-documents/fixtures/fcl-execution';

it('enqueues personal intake in the case transaction and uses that owner rather than the public receiver',async()=>{
  const f=await readyFixture();try{
    const rows=f.rateService.getFclNotificationV2(other).rows;
    rows[0]!.assignment={responsible_id:other.identity.userId,collaborator_ids:[],to:'personal@example.test',cc:['personal-copy@example.test'],enabled:true};
    f.rateService.saveFclNotificationV2(other,{contract_version:FCL_NOTIFICATION_V2,expected_version:0,rows,confirmed:true},'personal-config-0001');
    const sent:unknown[]=[];
    const execution=new FclExecutionService(f.caseService,{isActive:()=>true});
    const mail=new FclExecutionMailService(execution,{verifyUsers:()=>Promise.resolve('active' as const),transport:{send:m=>{sent.push(m);}},configuration:owner=>f.rateService.readFclNotificationForDispatch(owner)});
    f.caseService.setFclEventObserver(event=>mail.enqueueCaseEvent(event));
    const input=f.caseService.getFclCase(receiver,f.confirmed.case_id).current_input;
    const created=await f.caseService.createPersonalFclInquiry(other,input,'personal-intake-0001');
    await f.caseService.createPersonalFclInquiry(other,input,'personal-intake-0001');
    expect(mail.list(other,{case_ref:created.case_id}).items).toHaveLength(1);
    expect(()=>mail.list(receiver,{case_ref:created.case_id})).toThrow('fcl_not_found');
    await mail.dispatchOnce();await mail.dispatchOnce();
    expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({to:'personal@example.test',cc:['personal-copy@example.test']});
    expect(execution.get(other,{case_ref:created.case_id})).toBeNull();
    // A queue insertion fault must roll back the inquiry and its event together.
    f.caseStore.db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON fcl_execution_outbox BEGIN SELECT RAISE(ABORT,'fixture_outbox_failure'); END");
    const count=f.caseStore.db.prepare('SELECT count(*) n FROM business_cases').get();
    await expect(f.caseService.createPersonalFclInquiry(other,input,'personal-intake-fail')).rejects.toThrow('fixture_outbox_failure');
    expect(f.caseStore.db.prepare('SELECT count(*) n FROM business_cases').get()).toEqual(count);
    expect(f.caseService).toBeInstanceOf(CaseService);
  }finally{closeFixture(f);}
});
