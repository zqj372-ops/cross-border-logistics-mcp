import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {NativeAdminService,NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';
import {operationsFixture,estimateRequest,cosco} from '../quote-native/fixtures/fcl-operations';
const receiver:PortalContext={organizationId:null,identity:{userId:'operations-receiver',displayName:'Synthetic',email:'receiver@example.test',emailVerified:true,platformRole:null}};
const options={receiverUserId:receiver.identity.userId,receiverIsActive:()=>true,now:()=> '2026-10-08T12:00:00.000Z'};
it('publishes one ocean change, appends affected estimate versions, preserves locked/history, replay and restart',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-operations-'));const path=join(root,'native.sqlite');
  let store=new NativeAdminStore(path,{fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}});
  try{
    let service=new NativeAdminService(store,{} as never,options);
    service.save(receiver,'fcl',{expected_version:0,input:operationsFixture()},'ops-save-initial-key');
    const preview=service.preview(receiver,'fcl');service.publish(receiver,'fcl',{expected_version:1,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'ops-publish-initial-key');
    const initial=service.fclOperations.run(receiver,estimateRequest(),'ops-estimate-initial-key');
    expect(initial.items).toHaveLength(3);
    const quote=initial.items.find(e=>e.calculation.rate_id===cosco)!;
    const copy=service.fclOperations.duplicate(receiver,{estimate_id:quote.estimate_id,expected_version:1},'ops-estimate-copy-key');
    service.fclOperations.adjust(receiver,{estimate_id:copy.estimate_id,expected_version:1,locked:true,recommended:false,reason:'Keep comparison',changes:[]},'ops-estimate-lock-key');
    const changes={expected_version:2,reason:'Verified new carrier sheet',changes:[{rate_id:cosco,container_type:'40HQ',ocean_freight:'3500',valid_from:'2026-10-01',valid_until:'2026-12-31',source_ref:'synthetic:new-sheet',source_version:'2'}]};
    const batch=service.fclOperations.bulkPreview(receiver,changes);
    expect(batch.affected_estimates).toBe(1);expect(batch.locked_estimates).toBe(1);
    const commit={...changes,preview_hash:batch.preview_hash,confirmation:'reviewed_sources_and_conditions'};
    service.fclOperations.bulkPublish(receiver,commit,'ops-bulk-publish-key');
    service.fclOperations.bulkPublish(receiver,commit,'ops-bulk-publish-key');
    const current=service.fclOperations.get(receiver,{estimate_id:quote.estimate_id,version:null});
    expect(current.version).toBe(2);expect(current.calculation.totals.cost_total).toBe('32900.00');
    expect(service.fclOperations.get(receiver,{estimate_id:quote.estimate_id,version:1}).calculation.totals.cost_total).toBe('30800.00');
    expect(service.fclOperations.get(receiver,{estimate_id:copy.estimate_id,version:null}).currentness.valid_now).toBe(false);
    expect(()=>service.fclOperations.list({...receiver,identity:{...receiver.identity,userId:'other'}},{case_ref:null,destination:null,shipping_date:null})).toThrow('fcl_not_found');
    store.close();store=new NativeAdminStore(path,{fcl:{mode:'reopen'}});service=new NativeAdminService(store,{} as never,options);
    expect(service.fclOperations.get(receiver,{estimate_id:quote.estimate_id,version:null}).version).toBe(2);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('reprices multiple destinations atomically, rejects stale previews, and retains manual audit',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-operations-atomic-'));const store=new NativeAdminStore(join(root,'native.sqlite'),{fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}});
  try{
    const service=new NativeAdminService(store,{} as never,options),data=operationsFixture();
    data.operations.delivery_rates.push({...data.operations.delivery_rates[0]!,id:'van-edmonton',destination:'Edmonton',base_rate:'1400'});
    data.operations.templates.push({...data.operations.templates[0]!,id:'edmonton',label:'Edmonton',destination:'Edmonton',delivery_rate_id:'van-edmonton'});
    service.save(receiver,'fcl',{expected_version:0,input:data},'ops-atomic-save-config');const preview=service.preview(receiver,'fcl');service.publish(receiver,'fcl',{expected_version:1,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'ops-atomic-publish-config');
    const initial=service.fclOperations.run(receiver,estimateRequest(),'ops-atomic-run-initial');expect(initial.items).toHaveLength(6);
    const quote=initial.items.find(e=>e.calculation.rate_id===cosco&&e.calculation.destination==='Calgary')!;
    const adjust={estimate_id:quote.estimate_id,expected_version:1,locked:false,recommended:true,reason:'Agreed sale override',changes:[{line_id:'ocean_freight:40HQ',sell_price:'3900'}]};
    service.fclOperations.adjust(receiver,adjust,'ops-atomic-adjust-manual');
    expect(()=>service.fclOperations.adjust(receiver,{...adjust,reason:'Changed request'},'ops-atomic-adjust-manual')).toThrow('idempotency_conflict');
    const changes={expected_version:2,reason:'Verified sheet',changes:[{rate_id:cosco,container_type:'40HQ',ocean_freight:'3500',valid_from:'2026-10-01',valid_until:'2026-12-31',source_ref:'synthetic:sheet',source_version:'2'}]};
    const batch=service.fclOperations.bulkPreview(receiver,changes);expect(batch.affected_estimates).toBe(2);
    const commit={...changes,preview_hash:batch.preview_hash,confirmation:'reviewed_sources_and_conditions'};
    expect(()=>service.fclOperations.bulkPublish(receiver,{...commit,preview_hash:'0'.repeat(64)},'ops-atomic-bad-preview')).toThrow('native_preview_mismatch');
    store.db.exec("CREATE TRIGGER synthetic_fail_audit BEFORE INSERT ON native_audit WHEN NEW.kind='fcl-operations' BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END");
    expect(()=>service.fclOperations.bulkPublish(receiver,commit,'ops-atomic-bulk-publish')).toThrow('synthetic_audit_failure');
    expect(service.fclOperations.get(receiver,{estimate_id:quote.estimate_id,version:null}).version).toBe(2);
    expect(service.get(receiver,'fcl').version).toBe(2);
    store.db.exec('DROP TRIGGER synthetic_fail_audit');
    service.fclOperations.bulkPublish(receiver,commit,'ops-atomic-bulk-publish');
    const updated=service.fclOperations.get(receiver,{estimate_id:quote.estimate_id,version:null});
    expect(updated.version).toBe(3);expect(updated.calculation.lines[0]?.sell_price).toBe('3900');
    expect(updated.adjustments[0]).toMatchObject({original_amount:'3520.000000',adjusted_amount:'3900',actor:receiver.identity.userId,reason:'Agreed sale override'});
    expect(service.fclOperations.list(receiver,{case_ref:null,destination:'Edmonton',shipping_date:null}).items.find(e=>e.calculation.rate_id===cosco)?.version).toBe(2);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});


it('can generate first destination estimates as part of an ocean update with explicit shipping inputs',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-operations-generate-')),store=new NativeAdminStore(join(root,'native.sqlite'),{fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}});
  try{
    const service=new NativeAdminService(store,{} as never,options);service.save(receiver,'fcl',{expected_version:0,input:operationsFixture()},'ops-generate-save-config');const published=service.preview(receiver,'fcl');service.publish(receiver,'fcl',{expected_version:1,preview_hash:published.preview_hash,confirmation:'reviewed_sources_and_conditions'},'ops-generate-publish-config');
    const input={expected_version:2,reason:'New sailing prices',estimate_request:estimateRequest(),changes:[{rate_id:cosco,container_type:'40HQ',ocean_freight:'3500',valid_from:'2026-10-01',valid_until:'2026-12-31',source_ref:'synthetic:new',source_version:'2'}]};
    const preview=service.fclOperations.bulkPreview(receiver,input);expect(preview.new_estimates).toBe(3);
    service.fclOperations.bulkPublish(receiver,{...input,preview_hash:preview.preview_hash,confirmation:'reviewed_sources_and_conditions'},'ops-generate-bulk-publish');
    const estimates=service.fclOperations.list(receiver,{case_ref:null,destination:null,shipping_date:null});expect(estimates.items).toHaveLength(3);expect(estimates.items.find(e=>e.calculation.rate_id===cosco)?.calculation.totals.cost_total).toBe('32900.00');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
