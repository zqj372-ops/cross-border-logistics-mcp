import {expect,it} from 'vitest';
import {FclExecutionService} from '../../services/access-gateway/portal/fcl-execution';
import {FclExecutionMailService} from '../../services/access-gateway/portal/fcl-execution-mail';
import {FclCustomerService} from '../../services/access-gateway/portal/fcl-customer';
import {emptyFclNotificationConfig} from '../../services/access-gateway/portal/fcl-execution-contracts';
import {receiver,other,readyFixture,closeFixture,handoffRequest} from '../quote-documents/fixtures/fcl-execution';

it('claims with proof, isolates customers and binds confirmation and acceptance to the published quote',async()=>{
 const f=await readyFixture();const config=emptyFclNotificationConfig();
 const execution=new FclExecutionService(f.caseService,{configuration:()=>config,isActive:()=>true,now:()=> '2026-10-08T12:00:00Z',onEvent:(p,e)=>mail.enqueue(p,e)});
 config.rows.find(r=>r.node_id==='customer_followup')!.assignment={responsible_id:receiver.identity.userId,collaborator_ids:[],to:'finance@example.test',cc:[],enabled:true};
 const sent:unknown[]=[];const mail=new FclExecutionMailService(execution,{configuration:()=>config,verifyUsers:()=>Promise.resolve('active'),now:()=> '2026-10-08T12:00:00Z',transport:{send:m=>{sent.push(m);}}});
 const service=new FclCustomerService(execution,f.workflow,mail);const customer={...other,identity:{...other.identity,email:'shipper@example.test'}};
 try{
  expect(()=>service.claim(customer,{inquiry_id:f.submitted.inquiry_id,credential:'x'.repeat(40)},'customer-claim-bad-0001')).toThrow();
  const claimed=service.claim(customer,{inquiry_id:f.submitted.inquiry_id,credential:f.submitted.credential},'customer-claim-good-0001');
  expect(claimed.case_ref).toBe(f.confirmed.case_id);
  expect(()=>service.get({...customer,identity:{...customer.identity,userId:'another'}},{case_ref:claimed.case_ref})).toThrow();
  f.caseService.setFclEventObserver(e=>mail.enqueueCaseEvent(e));
  const offer=service.publish(receiver,{handoff:handoffRequest(f)},'customer-publish-0001');
  const row=f.caseService.getFclCase(receiver,claimed.case_ref);
  mail.enqueueCaseEvent({event_id:'00000000-0000-4000-8000-000000000123',case_ref:claimed.case_ref,owner_id:receiver.identity.userId,case_version:row.case_version,kind:'fcl-document-approve',status:row.case_status});
  expect(mail.list(receiver,{case_ref:claimed.case_ref}).items.filter(m=>m.to==='finance@example.test')).toHaveLength(0);
  expect(JSON.stringify(service.get(customer,{case_ref:claimed.case_ref}))).not.toContain('cost_price');
  expect(()=>service.confirm(customer,{case_ref:claimed.case_ref,offer_id:'00000000-0000-4000-8000-000000000000',confirmed:true},'customer-confirm-bad-0001')).toThrow();
  f.setClock('2026-10-16T12:00:00Z');
  expect(()=>service.confirm(customer,{case_ref:claimed.case_ref,offer_id:offer.offer_id,confirmed:true},'customer-expired-0001')).toThrow('fcl_customer_quote_changed');
  f.setClock('2026-10-08T12:00:00Z');
  const originalStatus=(f.caseStore.db.prepare("SELECT status FROM business_cases WHERE case_id=?").get(claimed.case_ref) as {status:string}).status;
  f.caseStore.db.prepare("UPDATE business_cases SET status='cancelled' WHERE case_id=?").run(claimed.case_ref);
  expect(service.get(customer,{case_ref:claimed.case_ref}).state).toBe('ended');
  expect(()=>service.confirm(customer,{case_ref:claimed.case_ref,offer_id:offer.offer_id,confirmed:true},'customer-cancelled-0001')).toThrow('fcl_customer_quote_changed');
  f.caseStore.db.prepare("UPDATE business_cases SET status=? WHERE case_id=?").run(originalStatus,claimed.case_ref);
  f.caseStore.db.exec("CREATE TRIGGER fail_customer_mail BEFORE INSERT ON fcl_execution_outbox BEGIN SELECT RAISE(ABORT,'mail_insert_failed'); END");
  expect(()=>service.confirm(customer,{case_ref:claimed.case_ref,offer_id:offer.offer_id,confirmed:true},'customer-atomic-0001')).toThrow('mail_insert_failed');
  expect(service.get(customer,{case_ref:claimed.case_ref}).state).toBe('awaiting_customer');
  f.caseStore.db.exec('DROP TRIGGER fail_customer_mail');
  const confirmed=service.confirm(customer,{case_ref:claimed.case_ref,offer_id:offer.offer_id,confirmed:true},'customer-confirm-good-0001');
  expect(confirmed.state).toBe('awaiting_acceptance');
  service.confirm(customer,{case_ref:claimed.case_ref,offer_id:offer.offer_id,confirmed:true},'customer-confirm-good-0001');
  expect(mail.list(receiver,{case_ref:claimed.case_ref}).items.filter(m=>m.to==='finance@example.test')).toHaveLength(1);
  expect(execution.readForDispatch(claimed.case_ref)).toBeNull();
  const input={case_ref:claimed.case_ref,offer_id:offer.offer_id,confirmed:true as const};
  const accepted=service.accept(receiver,input,'customer-accept-good-0001');
  expect(accepted.state).toBe('executing');
  expect(service.accept(receiver,input,'customer-accept-good-0001').case_ref).toBe(claimed.case_ref);
  expect(service.get(customer,{case_ref:claimed.case_ref}).state).toBe('executing');
  const restarted=new FclCustomerService(execution,f.workflow,mail);
  expect(restarted.get(customer,{case_ref:claimed.case_ref}).state).toBe('executing');
  expect(()=>restarted.run({...customer,identity:{...customer.identity,userId:'another'}},'customer-pdf',{case_ref:claimed.case_ref,offer_id:offer.offer_id},()=> 'customer-pdf-0001')).toThrow('fcl_not_found');
  const acceptedMail=f.caseStore.db.prepare("SELECT count(*) n FROM fcl_execution_outbox WHERE json_extract(payload,'$.extensions.customer_notice_v1.kind')='accepted'").get() as {n:number};expect(acceptedMail.n).toBe(1);
  for(let i=0;i<8;i++)await mail.dispatchOnce();expect(sent.length).toBeGreaterThan(0);
  expect(sent.filter(m=>(m as {to:string}).to==='finance@example.test')).toHaveLength(1);
  expect(JSON.stringify(sent)).toContain('客户已确认下单');
  expect(JSON.stringify(sent)).not.toContain('cost_price');expect(JSON.stringify(sent)).toContain('2026-10-15');
 }finally{closeFixture(f);}
});

it('keeps internal progress out of customer timelines and mail while showing SO and container references',async()=>{
 const f=await readyFixture(),config=emptyFclNotificationConfig();
 for(const row of config.rows)row.assignment.responsible_id=receiver.identity.userId;
 const execution=new FclExecutionService(f.caseService,{configuration:()=>config,isActive:()=>true,now:()=> '2026-10-08T12:00:00Z',onEvent:(p,e)=>mail.enqueue(p,e)});
 const mail=new FclExecutionMailService(execution,{verifyUsers:()=>Promise.resolve('active')}),service=new FclCustomerService(execution,f.workflow,mail);
 const customer={...other,identity:{...other.identity,email:'shipper@example.test'}};
 try{
 const c=service.claim(customer,{inquiry_id:f.submitted.inquiry_id,credential:f.submitted.credential},'visibility-claim-0001');
 const offer=service.publish(receiver,{handoff:handoffRequest(f)},'visibility-publish-01');
 service.confirm(customer,{case_ref:c.case_ref,offer_id:offer.offer_id,confirmed:true},'visibility-confirm-01');
 service.accept(receiver,{case_ref:c.case_ref,offer_id:offer.offer_id,confirmed:true},'visibility-accept-001');
 const before=mail.list(receiver,{case_ref:c.case_ref}).items.length;
 const v=execution.get(receiver,{case_ref:c.case_ref})!;
 execution.nodeAction(receiver,'exception',{contract_version:v.contract_version,case_ref:c.case_ref,expected_version:v.version,node_id:'booking',reason:'PRIVATE-INTERNAL',confirmed:true,extensions:{progress_v1:{visibility:'internal',message:''}}},'visibility-internal-01');
 expect(service.get(customer,{case_ref:c.case_ref}).nodes.find(n=>n.id==='booking')?.status).toBe('not_started');
 expect(JSON.stringify(service.get(customer,{case_ref:c.case_ref}))).not.toContain('PRIVATE-INTERNAL');
 expect(mail.list(receiver,{case_ref:c.case_ref}).items.length).toBe(before);
 const current=execution.get(receiver,{case_ref:c.case_ref})!;
 execution.nodeAction(receiver,'skip',{contract_version:current.contract_version,case_ref:c.case_ref,expected_version:current.version,node_id:'booking',reason:'客户确认无需订舱',confirmed:true,extensions:{progress_v1:{visibility:'customer',message:'本单无需订舱。'}}},'visibility-public-001');
 const publicView=service.get(customer,{case_ref:c.case_ref});
 expect(publicView.nodes.find(n=>n.id==='booking')?.status).toBe('skipped');
 expect(publicView.events.some(e=>e.message==='本单无需订舱。')).toBe(true);
 expect(JSON.stringify(publicView)).not.toContain('PRIVATE-INTERNAL');
 expect(mail.list(receiver,{case_ref:c.case_ref}).items.length).toBe(before+1);

 }finally{closeFixture(f);}
});
