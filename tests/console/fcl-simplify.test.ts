/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Exercises the browser ESM boundary. */
import {describe,it,expect,vi,afterEach} from 'vitest';
// @ts-expect-error Browser ESM.
import {scheduleToRateDetail,selectableSailings,createScheduleClient} from '../../apps/console/maritime-query.js';
// @ts-expect-error Browser ESM.
import {createFclOperations} from '../../apps/console/fcl-operations.js';
import {operationsFixture} from '../quote-native/fixtures/fcl-operations';
afterEach(()=>vi.unstubAllGlobals());
const record={operating_carrier:'COSCO',routing:'direct',transit:{source_total_days:'18'},legs:[{mode:'ocean',vessel_name:'TEST VESSEL',voyage:'068E',events:[{event_type:'departure',event_kind:'planned',local_date:'2026-10-15'},{event_type:'arrival',event_kind:'estimated',local_date:'2026-11-02'}]}]};
describe('FCL simplified workbench',()=>{
 it('filters fees without changing the source row used by edit and copy',async()=>{
  const draft=operationsFixture();
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:null,history:[]}:{items:[]}}));
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{},state:{}})});
  ops.render('', 'charges');await new Promise(r=>setTimeout(r,0));
  vi.stubGlobal('FormData',class {get(){return 'customs';}});
  await ops.submit({dataset:{fclForm:'ops-fee-search'}});
  const filtered=ops.render('', 'charges');
  expect(filtered).toMatch(/data-fcl-form="ops-fee-search"[^>]*><div class="form-error" hidden>/);
  expect(filtered).toContain('1 / 3 项');expect(filtered).not.toContain('码头操作费');
  expect(filtered).toContain('data-index="1" data-kind="charges"');
  await ops.action({dataset:{action:'ops-edit',kind:'charges',index:'1'}});
  expect(ops.render('', 'charges')).toContain('name="amount" value="200"');
  await ops.action({dataset:{action:'ops-close-editor'}});
  await ops.action({dataset:{action:'ops-copy-record',kind:'charges',index:'1'}});
  expect(ops.render('', 'charges')).toContain('name="name_zh" value="清关费"');
  await ops.action({dataset:{action:'ops-close-editor'}});
  vi.stubGlobal('FormData',class {get(){return 'no matching fee';}});
  await ops.submit({dataset:{fclForm:'ops-fee-search'}});
  expect(ops.render('', 'charges')).toContain('没有匹配的费用');
  vi.stubGlobal('FormData',class {get(){return '';}});
  await ops.submit({dataset:{fclForm:'ops-fee-search'}});
  expect(ops.render('', 'charges')).toContain('3 / 3 项');expect(draft.operations.charges).toHaveLength(3);
 });
 it('projects sailing fields without changing or inventing price evidence',()=>{
  const rate=operationsFixture().rates[0]!;const before=structuredClone(rate);
  const detail=scheduleToRateDetail(record,rate.rate_id);
  expect(detail).toEqual({rate_id:rate.rate_id,carrier:'COSCO',routing:'直达',vessel:'TEST VESSEL',voyage:'068E',etd:'2026-10-15',eta:'2026-11-02',transit_days:18});expect(rate).toEqual(before);
  expect(scheduleToRateDetail({...record,transit:{source_total_days:'18.5'}},rate.rate_id).transit_days).toBeNull();
  expect(scheduleToRateDetail({...record,operating_carrier:'OOCL'},rate.rate_id,'COSCO').carrier).toBe('COSCO');
 });
 it('allows only complete live success without conflicts or blockers for automatic fill',()=>{
  const result={status:'success',data:{records:[record],coverage:{complete:true},quality:{conflicts:[]},provenance:{kind:'live'}},blockers:[]};
  expect(selectableSailings(result)).toEqual([record]);
  for(const status of ['needs_input','manual_review','blocked','unavailable'])expect(selectableSailings({...result,status})).toEqual([]);
  expect(selectableSailings({...result,data:{...result.data,quality:{conflicts:['conflict']}}})).toEqual([]);
  expect(selectableSailings({...result,data:{...result.data,provenance:{kind:'synthetic'}}})).toEqual([]);
 });
 it('reuses existing API paths and does not pick ambiguous locations',async()=>{
  const api=vi.fn().mockResolvedValue({status:'needs_input',data:{candidates:[{carrier_location_id:'one'},{carrier_location_id:'two'}],resolved:null}});
  const client=createScheduleClient(api);const response=await client.locations({carrier:'ONE',text:'Shanghai',country_code:'CN'});
  expect(response.status).toBe('needs_input');expect(api).toHaveBeenCalledWith('/maritime/schedule-collector/locations',expect.objectContaining({method:'POST',acceptBusiness:true}));expect(api).toHaveBeenCalledTimes(1);
 });
 it('renders four business tabs and only two header actions; legacy rate entry shares same table',async()=>{
  const draft=operationsFixture();const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:draft},history:[]}:{items:[]}}));
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{authenticated:true,identity:{user_id:'personal'},fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render();await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));
  const html=ops.render();expect(html).toContain('从已发布海运费与费用模板开始');expect(html).toContain('选择海运费和费用模板');expect(html).toContain('其他条件');expect(html).toContain('模板维护');expect(html).not.toContain('更多报价条件');
  const header=html.match(/<header class="ops-heading">[\s\S]*?<\/header>/)?.[0]??'';expect(header.match(/data-action=/g)).toHaveLength(2);expect(header).not.toContain('保存与发布');
  const tabs=html.match(/<nav class="ops-tabs"[\s\S]*?<\/nav>/)?.[0]??'';expect(tabs.match(/data-tab=/g)).toHaveLength(4);expect(tabs).not.toContain('目的地模板');
  const table=ops.render('', 'rates');expect(table).toContain('ops-ocean-table');expect(table).toContain('20GP');expect(table).toContain('查询 COSCO 船期');expect(table).not.toContain('Save Draft Item');
 });
 it('uses only published data for daily quoting even when an unrelated public draft exists',async()=>{
  const published=operationsFixture(),draft=structuredClone(published);draft.rates[0]!.items[0]!.ocean_freight='9999';draft.operations.templates[0]!.label='Draft template only';
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:2,draft,active_release:{input:published},history:[]}:{items:[]}}));
  const write=vi.fn((action:string,body?:unknown)=>{void action;void body;return Promise.resolve({status:'success',data:{items:[]}});});
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render();await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));
  const html=ops.render();
  expect(html).toContain('Calgary');expect(html).not.toContain('Draft template only');expect(html).not.toContain('保存与发布');
  vi.stubGlobal('FormData',class {get(key:string){return ({pol:'Shanghai',pod:'Vancouver',destination:'Calgary',shipping_date:'2026-10-15','box-40HQ':'1',selected_rate:published.rates[0]!.rate_id,template:published.operations.templates[0]!.id} as Record<string,string>)[key]??null;}});
  await ops.submit({dataset:{fclForm:'ops-run'}});
  expect(write.mock.calls[0]?.[0]).toBe('estimate-run');
  expect(write.mock.calls[0]?.[1]).toMatchObject({rate_ids:[published.rates[0]!.rate_id],template_ids:[published.operations.templates[0]!.id]});
 });
 it('auto-selects one explicit case candidate and leaves multiple candidates for human choice',async()=>{
  const published=operationsFixture(),caseView={case_id:'00000000-0000-4000-8000-000000000901',case_status:'in_review',case_version:2,current_input:{pol:'Shanghai',pod:'Vancouver',final_destination:'Calgary',containers:[{type:'40HQ',quantity:1}],cargo_ready_date:'2026-10-15',estimated_weight:null,selected_services:['ocean_freight','canada_customs','delivery']},review_context:{latest_customer_supplement_ref:null,review_required:false}};
  const estimate={estimate_id:'00000000-0000-4000-8000-000000000902',version:1,calculation:{rate_id:published.rates[0]!.rate_id},request:{case_ref:caseView.case_id}};
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:2,draft:published,active_release:{input:published},history:[]}:action==='case-get'?caseView:{items:[]}}));
  const writes:string[]=[];const write=vi.fn((action:string)=>{writes.push(action);return Promise.resolve({status:'success',data:action==='estimate-run'?{items:[estimate]}:{quote_ref:'00000000-0000-4000-8000-000000000903',version:1}});});
  const location={hash:''};vi.stubGlobal('location',location);
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{},state:{}})});
  ops.render(caseView.case_id);await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(4));await new Promise(r=>setTimeout(r,0));
  vi.stubGlobal('FormData',class {get(key:string){return ({pol:'Shanghai',pod:'Vancouver',destination:'Calgary',shipping_date:'2026-10-15','box-40HQ':'1',selected_rate:published.rates[0]!.rate_id,template:published.operations.templates[0]!.id} as Record<string,string>)[key]??null;}});
  await ops.submit({dataset:{fclForm:'ops-run'}});
  expect(writes).toEqual(['estimate-run','estimate-select']);expect(location.hash).toContain(`fcl/case/${caseView.case_id}/`);
  const multiple=createFclOperations({call,write:vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='estimate-run'?{items:[estimate,{...estimate,estimate_id:'00000000-0000-4000-8000-000000000904'}]}:{items:[]}})),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{},state:{}})});
  multiple.render(caseView.case_id);await vi.waitFor(()=>expect(call.mock.calls.length).toBeGreaterThanOrEqual(8));await new Promise(r=>setTimeout(r,0));
  await multiple.submit({dataset:{fclForm:'ops-run'}});
  expect(multiple.render(caseView.case_id)).toContain('已生成 2 个候选');
 });
 it('keeps prices and sources when cancelling advanced edits, and clears only stale sailing associations',async()=>{
  vi.stubGlobal('document',{querySelector:()=>null});
  const initial=operationsFixture();let saved:ReturnType<typeof operationsFixture>|undefined;
  const view=(draft=initial)=>({version:1,draft,active_release:{input:initial},history:[]});
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?view():{items:[]}}));
  const write=vi.fn((_action:string,body:{input:ReturnType<typeof operationsFixture>})=>{saved=structuredClone(body.input);return Promise.resolve({status:'success',data:view(saved)});});
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{},state:{}})});
  ops.render('', 'rates');await new Promise(r=>setTimeout(r,0));
  const action=async(action:string,index='0'):Promise<void>=>{await ops.action({dataset:{action,index}});};
  const edit=(index:string,key:string,value:string):void=>{ops.input({target:{closest:()=>true,dataset:{oceanIndex:index,oceanKey:key},value}});};
  await action('ops-ocean-more');edit('1','price:40HQ','3350');await action('ops-close-editor');await action('ops-save-config');
  expect(ops.render('', 'rates')).toContain('草稿待发布');
  vi.stubGlobal('FormData',class {get(key:string){return ({pol:'Shanghai',pod:'Vancouver',destination:'Calgary',shipping_date:'2026-10-15','box-40HQ':'1'} as Record<string,string>)[key]??null;}});
  await ops.submit({dataset:{fclForm:'ops-run'}});expect(write.mock.calls.map(([name])=>name)).not.toContain('estimate-run');
  expect(saved!.rates[1]!.items[0]!.ocean_freight).toBe('3350');expect(saved!.operations.rate_details).toEqual(initial.operations.rate_details);
  expect(saved!.rates.map(r=>[r.source_ref,r.source_version])).toEqual(initial.rates.map(r=>[r.source_ref,r.source_version]));
  edit('0','pod','Prince Rupert');await action('ops-save-config');
  expect(saved!.operations.rate_details.map(r=>r.rate_id)).toEqual(initial.operations.rate_details.slice(1).map(r=>r.rate_id));
  expect(saved!.rates[0]!.items).toEqual(initial.rates[0]!.items);
 });

});

// @ts-expect-error Browser ESM.
import {createFclSchedules} from '../../apps/console/fcl-schedules.js';
describe('schedule association lifecycle',()=>{
 it('fills the selected rate only and refuses a response after changing context',async()=>{
  let release:((v:unknown)=>void)|undefined;
  const response={status:'success',data:{carrier:{id:'COSCO'},records:[record],coverage:{complete:true},quality:{conflicts:[]},provenance:{kind:'live'}},blockers:[]};
  const api=vi.fn((path:string)=>path.endsWith('carriers')?Promise.resolve({status:'success',data:{carriers:[{id:'COSCO',capability_status:'live_verified'}]}}):path.endsWith('locations')?Promise.resolve({status:'success',data:{resolved:{carrier_location_id:'location'}}}):new Promise(r=>{release=r;}));
  const apply=vi.fn();const ui=createFclSchedules({api,model:()=>({session:{authenticated:true,identity:{user_id:'personal'},fcl_capability:{fcl_personal:true}}}),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),apply});
  ui.show(operationsFixture().rates[0],'2026-10-15');await new Promise(r=>setTimeout(r,0));ui.render();
  const pending=ui.action({dataset:{action:'ops-schedule-search'}});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  ui.invalidate();release!(response);await pending;await ui.action({dataset:{action:'ops-schedule-use',index:'0'}});expect(apply).not.toHaveBeenCalled();
  ui.show(operationsFixture().rates[0],'2026-10-15');await new Promise(r=>setTimeout(r,0));ui.render();release=undefined;
  const next=ui.action({dataset:{action:'ops-schedule-search'}});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));release!(response);await next;
  await ui.action({dataset:{action:'ops-schedule-use',index:'0'}});expect(apply).toHaveBeenCalledOnce();expect(apply).toHaveBeenCalledWith(expect.objectContaining({rate_id:operationsFixture().rates[0]!.rate_id,vessel:'TEST VESSEL'}));
 });
});


describe('COSCO-only FCL schedules',()=>{
 const model=()=>({session:{authenticated:true,identity:{user_id:'personal'},fcl_capability:{fcl_personal:true}}});
 const esc=(value:string|number|null)=>String(value??'');
 const live=(source='COSCO',row={...record,operating_carrier:null})=>({status:'success',data:{carrier:{id:source},records:[row],coverage:{complete:true},quality:{conflicts:[]},provenance:{kind:'live'}},blockers:[]});
 const harness=(response=live(),carriers=[{id:'COSCO',capability_status:'live_verified'},{id:'ONE',capability_status:'live_verified'}])=>{
  const api=vi.fn((path:string)=>Promise.resolve(path.endsWith('carriers')?{status:'success',data:{carriers}}:path.endsWith('locations')?{status:'success',data:{resolved:{carrier_location_id:'location'}}}:response));
  const apply=vi.fn();const ui=createFclSchedules({api,model,esc,rerender:vi.fn(),apply});
  return {api,apply,ui};
 };
 it('uses the verified sales source when COSCO omits the operating carrier',async()=>{
  const {ui,api,apply}=harness();ui.show(operationsFixture().rates[0],'2026-10-15');await new Promise(r=>setTimeout(r,0));
  const html=ui.render();expect(html).toContain('COSCO 官方船期');expect(html).not.toContain('name="sailing_carrier"');
  await ui.action({dataset:{action:'ops-schedule-search'}});await ui.action({dataset:{action:'ops-schedule-use',index:'0'}});
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({carrier:'COSCO',vessel:'TEST VESSEL',etd:'2026-10-15'}));
  for(const [,options] of api.mock.calls as unknown as [string,{body?:{carrier:string}}][])if(options.body)expect(options.body.carrier).toBe('COSCO');
 });
 it('does not associate COSCO sailings with another carrier rate or unknown supplier',async()=>{
  for(const rate of [operationsFixture().rates[1],{...operationsFixture().rates[0],supplier_label:'Forwarder'}]){
   const {ui,api,apply}=harness();ui.show(rate,'2026-10-15');await new Promise(r=>setTimeout(r,0));
   expect(ui.render()).toContain('请选择 COSCO 海运费');await ui.action({dataset:{action:'ops-schedule-search'}});expect(api).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
  }
 });
 it('recognizes an explicit COSCO carrier on a supplier rate and rejects another source response',async()=>{
  const {ui,api,apply}=harness(live('ONE'));const rate={...operationsFixture().rates[0],supplier_label:'Forwarder'};
  ui.show(rate,'2026-10-15',{carrier:'COSCO'});await new Promise(r=>setTimeout(r,0));ui.render();
  await ui.action({dataset:{action:'ops-schedule-search'}});await ui.action({dataset:{action:'ops-schedule-use',index:'0'}});expect(api).toHaveBeenCalledTimes(4);expect(apply).not.toHaveBeenCalled();
 });
 it('does not query when COSCO is absent from the available source list',async()=>{
  const {ui,api}=harness(live(),[{id:'ONE',capability_status:'live_verified'}]);ui.show(operationsFixture().rates[0],'2026-10-15');await new Promise(r=>setTimeout(r,0));ui.render();
  ui.change({name:'sailing_carrier',value:'ONE'});await ui.action({dataset:{action:'ops-schedule-search'}});expect(api).toHaveBeenCalledTimes(1);
 });
});
