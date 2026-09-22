/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Exercises the browser ESM boundary. */
import {describe,it,expect,vi,afterEach} from 'vitest';
// @ts-expect-error Browser ESM.
import {scheduleToRateDetail,selectableSailings,createScheduleClient} from '../../apps/console/maritime-query.js';
// @ts-expect-error Browser ESM.
import {createFclOperations,fclMaintenancePayload,fclTemplateChargeImpacts,groupReferenceCharges,isBaseOceanFreight,referenceChargeGroup} from '../../apps/console/fcl-operations.js';
import {operationsFixture} from '../quote-native/fixtures/fcl-operations';
afterEach(()=>vi.unstubAllGlobals());
const record={operating_carrier:'COSCO',routing:'direct',transit:{source_total_days:'18'},legs:[{mode:'ocean',vessel_name:'TEST VESSEL',voyage:'068E',events:[{event_type:'departure',event_kind:'planned',local_date:'2026-10-15'},{event_type:'arrival',event_kind:'estimated',local_date:'2026-11-02'}]}]};
type ControlStub={value:string;checked:boolean};
type QueryStub={querySelector:(selector:string)=>ControlStub|null};
type FormStub={dataset:{fclForm:string};values:Map<string,string|string[]>;querySelector:(selector:string)=>ControlStub|QueryStub|null};
const control=(value='',checked=false):ControlStub=>({value,checked});
const chargeRowStub=(index:number,values:{amount?:string;sell_amount?:string;selected?:string;currency?:string;unit?:string}={}):QueryStub=>{
 const entries={amount:values.amount??'100',sell_amount:values.sell_amount??'',selected:values.selected??'',currency:values.currency??'CAD',unit:values.unit??'SHIPMENT'};
 const controls=new Map(Object.entries(entries).map(([name,value])=>[`[name="charges.${index}.${name}"]`,control(value)]));
 return {querySelector:selector=>controls.get(selector)??null};
};
const formStub=(values:Record<string,string|string[]>={},controls:Record<string,ControlStub|QueryStub>={},fclForm='ops-template'):FormStub=>({
 dataset:{fclForm},
 values:new Map(Object.entries(values)),
 querySelector:selector=>controls[selector]??null,
});
const templateFormStub=(rows:Array<{amount?:string;sell_amount?:string;selected?:string;currency?:string;unit?:string}>,options:{containerTypes?:string[];enabled?:boolean;controls?:Record<string,ControlStub|QueryStub>}={}):FormStub=>{
 const controls={...options.controls};
 rows.forEach((row,index)=>{controls[`[data-template-charge="${index}"]`]=chargeRowStub(index,row);});
 if(options.enabled!==undefined)controls['[name="template.enabled"]']=control('',options.enabled);
 return formStub({'template.container_types':options.containerTypes??['40HQ']},controls);
};
const templateRows=(draft:ReturnType<typeof operationsFixture>,template:ReturnType<typeof operationsFixture>['operations']['templates'][number],overrides:Record<number,{amount?:string;sell_amount?:string;selected?:string;currency?:string;unit?:string}>={})=>template.charge_ids.map((id,index)=>{
 const charge=draft.operations.charges.find(row=>row.id===id);
 return {amount:charge?.amount??'',sell_amount:charge?.sell_amount??'',currency:charge?.currency??'CAD',unit:charge?.unit??'SHIPMENT',...overrides[index]};
});
const stubFormData=()=>vi.stubGlobal('FormData',class{
 private readonly values:Map<string,string|string[]>;
 constructor(form:FormStub){this.values=form.values;}
 get(name:string){const value=this.values.get(name);return Array.isArray(value)?value[0]??null:value??null;}
 getAll(name:string){const value=this.values.get(name);return value===undefined?[]:Array.isArray(value)?value:[value];}
});
const inputTemplate=(ops:ReturnType<typeof createFclOperations>,form:FormStub,name:string,value:string='')=>{void ops.input({target:{closest:(selector:string)=>selector==='.ops-workspace'||selector==='[data-fcl-form="ops-template"]',dataset:{},name,form,value,checked:false}});};
const changeTemplate=(ops:ReturnType<typeof createFclOperations>,form:FormStub,name:string,value:string,checked=false)=>{void ops.change({target:{closest:(selector:string)=>selector==='.ops-workspace'||selector==='[data-fcl-form="ops-template"]',dataset:{},name,form,value,checked}});};
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
  const table=ops.render('', 'rates');expect(table).toContain('ops-ocean-table');expect(table).toContain('<th>起运港</th><th>目的港</th><th>船公司</th><th>20GP</th><th>40GP</th><th>40HQ</th><th>45HQ</th><th>币种</th><th>更新时间</th><th>操作</th>');expect(table).toContain('查船期');expect(table).not.toContain('有效期');expect(table).not.toContain('Save Draft Item');
 });
 it('filters the compact ocean-rate ledger without changing source rows',async()=>{
  const draft=operationsFixture();
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:draft},history:[]}:{items:[]}}));
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render('', 'rates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));
  stubFormData();
  await ops.submit(formStub({filter_pol:'Shanghai',filter_pod:'Vancouver',filter_carrier:'ONE'},{},'ops-rate-filter'));
  const filtered=ops.render('', 'rates');
  expect(filtered).toContain('1 / 3 条');expect(filtered).toContain('value="ONE"');expect(filtered).not.toContain('value="COSCO"');
  expect(draft.rates).toHaveLength(3);
 });
 it('makes fee templates a first-class tab and renders the referenced fee ledger',async()=>{
  const draft=operationsFixture();
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:draft},history:[]}:{items:[]}}));
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render();await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));
  const html=ops.render('', 'templates');
  const tabs=html.match(/<nav class="ops-tabs"[\s\S]*?<\/nav>/)?.[0]??'';
  expect(tabs).toContain('data-tab="templates"');expect(tabs).toContain('费用模板');expect(tabs).not.toContain('data-tab="charges"');
  const header=html.match(/<header class="ops-heading">[\s\S]*?<\/header>/)?.[0]??'';
  expect(header).not.toContain('data-tab="templates"');expect(header).not.toContain('data-tab="rates"');
  expect(html).toContain('data-fcl-form="ops-template"');expect(html).toMatch(/name="charges\.0\.amount"[^>]*value="100"/u);
  expect(html).not.toContain('charges.0.sell_amount');expect(html).toContain('<th>费用名称</th><th>金额</th><th>币种</th><th>单位</th>');expect(html).toContain('高级已有规则');
  const row=html.match(/<tr data-template-charge="0"[\s\S]*?<\/tr>/)?.[0]??'';expect(row.match(/<td /g)).toHaveLength(5);
  expect(html).not.toContain('加入草稿');expect(html).not.toContain('ratio0.1');
 });
 it('shows every other template affected by editing a shared fee before confirmation',async()=>{
  const draft=operationsFixture();
  draft.operations.templates.push({...draft.operations.templates[0]!,id:'calgary-shared',label:'Calgary shared',charge_ids:[...draft.operations.templates[0]!.charge_ids]});
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:draft},history:[]}:{items:[]}}));
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render();await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));
  const html=ops.render('', 'templates');
  expect(html).toContain('还被其他模板使用');expect(html).toContain('Calgary shared');
 });
 it('recognizes only explicit imported reference plans and keeps fixed amounts un-converted',()=>{
  const charge=(id:string,name:string,remark:string,source_ref:string)=>({id,name_zh:name,remark,source_ref,destination:'Calgary',unit:'FIXED'});
  const first=charge('one','海运费 · 合成卡尔加里 OA 40HQ','参考方案：合成卡尔加里 OA 40HQ；待人工调整。','xlsx:20260914:fixture-a!C3');
  const second=charge('two','港口安保费 · 合成卡尔加里 OA 40HQ','参考方案：合成卡尔加里 OA 40HQ；待人工调整。','xlsx:20260914:fixture-a!C4');
  const otherPlan=charge('three','海运费 · 合成多伦多 OA 40HQ','参考方案：合成多伦多 OA 40HQ；待人工调整。','xlsx:20260914:fixture-b!C3');
  const ordinary={...charge('four','普通费用','普通费用说明','manual:fixture')};
  expect(referenceChargeGroup(first as never)).toBe('合成卡尔加里 OA 40HQ');
  expect(referenceChargeGroup(ordinary as never)).toBeNull();
  const groups=groupReferenceCharges([first,second,otherPlan,ordinary] as never);
  expect(groups.map((group:{name:string;entries:unknown[]})=>[group.name,group.entries.length])).toEqual([['合成卡尔加里 OA 40HQ',2],['合成多伦多 OA 40HQ',1]]);
 });
 it('identifies base ocean freight without treating other ocean category fees as the base fare',()=>{
  expect(isBaseOceanFreight({category:'ocean',code:'ocean_freight',name_zh:'海运费 · Calgary'})).toBe(true);
  expect(isBaseOceanFreight({category:'ocean',code:'emf',name_zh:'EMF 设备管理费'})).toBe(false);
  expect(isBaseOceanFreight({category:'ocean',code:'isps',name_en:'ISPS'})).toBe(false);
  expect(isBaseOceanFreight({category:'ocean',code:'ocean_surcharge',name_zh:'海运附加费'})).toBe(false);
 });
 it('clears maintenance dates and client updated_at while preserving delivery-rate validity',()=>{
  const draft=operationsFixture();
  (draft.rates[0] as unknown as Record<string,unknown>).updated_at='2026-10-08T12:00:00.000Z';
  (draft.operations.charges[0] as {valid_from:string|null}).valid_from=null;
  (draft.operations.templates[0] as {valid_until:string|null}).valid_until=null;
  const payload=fclMaintenancePayload(draft);
  expect(payload.rates[0]).toMatchObject({valid_from:null,valid_until:null});
  expect(payload.operations.charges[0]).toMatchObject({valid_from:null,valid_until:null});
  expect(payload.operations.templates[0]).toMatchObject({valid_from:null,valid_until:null});
  expect(payload.rates[0]).not.toHaveProperty('updated_at');
  expect(payload.operations.delivery_rates[0]).toMatchObject({valid_from:'2026-10-01',valid_until:'2026-12-31'});
 });
 it('keeps a historical base fare in rate additional fees until it is explicitly excluded',async()=>{
  const draft=operationsFixture(),rate=draft.rates[0]!;
  rate.additional_fees.push({name:'海运费 · 历史附费',group:'B',service:'ocean_freight',cost_price:'88',currency:'USD',note:null,unit:'SHIPMENT',container_type:null});
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:draft},history:[]}:{items:[]}}));
  const write=vi.fn((_action:string,body:{input:ReturnType<typeof operationsFixture>})=>Promise.resolve({status:'success',data:{version:2,draft:structuredClone(body.input),active_release:{input:draft},history:[]}}));
  vi.stubGlobal('window',{prompt:()=> '已迁入海运费表',confirm:()=>true});
  vi.stubGlobal('document',{querySelector:()=>null});
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render('', 'rates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));
  const pending=ops.render('', 'rates');
  expect(pending).toContain('海运费 · 历史附费');expect(pending).toContain('>88<');expect(pending).toContain('>USD<');expect(pending).toContain(`data-id="fee:${rate.rate_id}:0"`);
  await ops.action({dataset:{action:'ops-ocean-exclude',id:`fee:${rate.rate_id}:0`}});
  expect(ops.render('', 'rates')).toContain('已确认排除');
  await ops.action({dataset:{action:'ops-save-config'}});
  const saved=write.mock.calls[0]?.[1] as {input:ReturnType<typeof operationsFixture>}|undefined;
  const savedFee=saved?.input.rates[0]?.additional_fees[0] as {cost_price:string;ocean_freight_resolution?:unknown}|undefined;
  expect(savedFee?.cost_price).toBe('88');
  expect(savedFee?.ocean_freight_resolution).toEqual({action:'exclude',reason:'已迁入海运费表'});
});
 it('detects direct and delivery-rate indirect template references for a shared charge',()=>{
  const templates=[{id:'direct',label:'直接模板',charge_ids:['shared'],delivery_rate_id:null},{id:'indirect',label:'间接模板',charge_ids:[],delivery_rate_id:'delivery'},{id:'unrelated',label:'无关模板',charge_ids:[],delivery_rate_id:null}];
  const delivery_rates=[{id:'delivery',surcharge_ids:['shared']}];
  expect(fclTemplateChargeImpacts({templates,delivery_rates},'shared')).toEqual(['直接模板','间接模板']);
  expect(fclTemplateChargeImpacts({templates,delivery_rates},'shared','direct')).toEqual(['间接模板']);
 });
 it('defaults to imported reference groups and lays out only the selected group ledger',async()=>{
  const base=operationsFixture();
  const importedName='合成卡尔加里 OA 40HQ';
  const imported=(index:number,name:string)=>({...base.operations.charges[index]!,id:`import-${index}`,code:`import-${index}`,name_zh:`${name} · ${importedName}`,name_en:name,amount:String(10+index),unit:'FIXED' as const,destination:'Calgary',pod:null,remark:`参考方案：${importedName}；原表 40HQ 方案参考费用，未逐项标明按柜或按票，先保留固定金额；待人工调整计费单位。未自动关联报价方案。`,source_ref:`xlsx:20260914:fixture-calgary!C${index+3}`,source_version:'synthetic-only'});
  const otherName='合成多伦多 OA 40HQ';
  const other={...imported(3,'海运费'),id:'other-plan',name_zh:`海运费 · ${otherName}`,remark:`参考方案：${otherName}；原表 40HQ 方案参考费用，未逐项标明按柜或按票，先保留固定金额；待人工调整计费单位。未自动关联报价方案。`,destination:'Toronto'};
  const unclassified={...base.operations.charges[0]!,id:'ordinary',code:'ordinary',name_zh:'其他普通费用',remark:null,source_ref:'manual:ordinary'};
  const draft={...base,operations:{...base.operations,charges:[imported(0,'海运费'),imported(1,'港口安保费'),other,unclassified],templates:[],delivery_rates:[],rate_details:[]}};
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:draft},history:[]}:{items:[]}}));
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render();await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));
  const html=ops.render('', 'templates');
  expect(html).toContain('data-primary="reference" aria-current="page"');
  expect(html).toContain('参考费用 · 2 组');expect(html).toContain('合成卡尔加里 OA 40HQ · 2 项');
  const table=html.match(/<table class="ops-template-table is-reference">[\s\S]*?<\/table>/)?.[0]??'';
  expect(table).not.toContain('<strong>海运费</strong>');expect(table).toContain('<strong>港口安保费</strong>');
  const row=table.match(/<tr data-template-charge="0"[\s\S]*?<\/tr>/)?.[0]??'';
  expect(row.match(/<td /g)).toHaveLength(4);expect(table).not.toContain('<th></th>');expect(table).not.toContain('其他普通费用');expect(table).not.toContain('合成多伦多 OA 40HQ');
 });
 it('keeps an edited fee visible across a failed save and retries the same draft',async()=>{
  const published=operationsFixture(),call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft:published,active_release:{input:published},history:[]}:action==='rate-preview'?{can_publish:false,blockers:['fcl_rate_source_unavailable']}:{items:[]}}));
  let attempts=0;
  const write=vi.fn((_action:string,body:{input:ReturnType<typeof operationsFixture>})=>{
   attempts+=1;
   if(attempts===1)return Promise.reject(Object.assign(new Error('fcl_version_conflict'),{code:'fcl_version_conflict'}));
   return Promise.resolve({status:'success',data:{version:2,draft:structuredClone(body.input),active_release:{input:published},history:[]}});
  });
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render('', 'templates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));ops.render('', 'templates');
  stubFormData();
  const form=templateFormStub(templateRows(published,published.operations.templates[0]!,{0:{amount:'150'}}),{containerTypes:published.operations.templates[0]!.container_types});
  inputTemplate(ops,form,'charges.0.amount','150');
  await ops.submit(form);
  expect(write).toHaveBeenCalledTimes(1);
  expect(ops.render('', 'templates')).toContain('value="150"');
  expect(ops.render('', 'templates')).toContain('当前编辑仍保留');
  await ops.submit(form);
  expect(write).toHaveBeenCalledTimes(2);
  const retry=write.mock.calls[1]?.[1] as {input:ReturnType<typeof operationsFixture>}|undefined;
  expect(retry?.input.operations.charges[0]?.amount).toBe('150');
 });
 it('invalidates a checked publication as soon as a fee input changes',async()=>{
  const published=operationsFixture(),call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft:published,active_release:{input:published},history:[]}:action==='rate-preview'?{can_publish:true,blockers:[],preview_hash:'a'.repeat(64)}:{items:[]}}));
  const write=vi.fn();
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render('', 'templates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));ops.render('', 'templates');
  await ops.action({dataset:{action:'ops-template-check-again'}});
  expect(ops.render('', 'templates')).toContain('id="ops-config-confirm"');
  let removed=false;
  vi.stubGlobal('document',{querySelector:(selector:string)=>selector==='.ops-template-publication'?{remove:()=>{removed=true;}}:selector==='#ops-config-confirm'?{checked:true}:null});
  stubFormData();
  const form=templateFormStub(templateRows(published,published.operations.templates[0]!,{0:{amount:'151'}}),{containerTypes:published.operations.templates[0]!.container_types});
  inputTemplate(ops,form,'charges.0.amount','151');
  expect(removed).toBe(true);
  await ops.action({dataset:{action:'ops-publish-config'}});
  expect(write).not.toHaveBeenCalled();
  expect(ops.render('', 'templates')).toContain('请先保存并重新检查');
 });
 it('requires a human shared-fee confirmation instead of auto-checking it',async()=>{
  const published=operationsFixture(),draft=structuredClone(published);
  draft.operations.templates.push({...draft.operations.templates[0]!,id:'calgary-shared',label:'Calgary shared'});
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:published},history:[]}:action==='rate-preview'?{can_publish:false,blockers:[]}:{items:[]}}));
  const write=vi.fn((_action:string,body:{input:ReturnType<typeof operationsFixture>})=>Promise.resolve({status:'success',data:{version:2,draft:structuredClone(body.input),active_release:{input:published},history:[]}}));
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render('', 'templates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));ops.render('', 'templates');
  stubFormData();
  const form=templateFormStub(templateRows(draft,draft.operations.templates[0]!,{0:{amount:'152'}}),{containerTypes:draft.operations.templates[0]!.container_types});
  inputTemplate(ops,form,'charges.0.amount','152');
  await ops.submit(form);
  expect(write).not.toHaveBeenCalled();
  const blocked=ops.render('', 'templates');
  expect(blocked).toContain('还被其他模板使用：Calgary shared');
  expect(blocked).toMatch(/name="template\.shared_confirm"(?![^>]* checked)/u);
  changeTemplate(ops,form,'template.shared_confirm','',true);
  await ops.submit(form);
  expect(write).toHaveBeenCalledTimes(1);
 });
 it('does not add the first fee for a blank select and uses the source array index',async()=>{
  const published=operationsFixture(),draft=structuredClone(published),template=draft.operations.templates[0]!;
  template.charge_ids=['thc','reserve'];
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:draft},history:[]}:{items:[]}}));
  let form=formStub({'template.container_types':['40HQ']},{'[name="template_add_charge"]':control('')});
  vi.stubGlobal('document',{querySelector:(selector:string)=>selector==='[data-fcl-form="ops-template"]'?form:null});
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render('', 'templates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));ops.render('', 'templates');
  stubFormData();
  await ops.action({dataset:{action:'ops-template-add-charge'}});
  expect(ops.render('', 'templates')).toContain('请选择要加入的费用');
  const unchanged=ops.render('', 'templates').match(/<table class="ops-template-table">[\s\S]*?<\/table>/)?.[0]??'';
  expect(unchanged).not.toContain('清关费');expect(unchanged).not.toContain('data-template-charge="2"');
  form=formStub({'template.container_types':['40HQ']},{'[name="template_add_charge"]':control('1')});
  await ops.action({dataset:{action:'ops-template-add-charge'}});
  const added=ops.render('', 'templates');
  expect(added).toContain('清关费');expect(added).toContain('data-template-charge="2"');
 });
 it('checks every delivery validity version and its indirect surcharge when marking a template effective',async()=>{
  const published=operationsFixture(),nextDelivery={...published.operations.delivery_rates[0]!,version:2,valid_from:'2027-01-01',valid_until:'2027-12-31',surcharge_ids:['customs']};
  published.operations.delivery_rates[0]!.surcharge_ids=['thc'];
  published.operations.delivery_rates.push(nextDelivery);
  const draft=structuredClone(published);
  draft.operations.charges.find(charge=>charge.id==='customs')!.amount='250';
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:2,draft,active_release:{input:published},history:[]}:{items:[]}}));
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render('', 'templates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));
  const html=ops.render('', 'templates');
 expect(html).toContain('Calgary · Calgary · 未生效');
 expect(html).not.toContain('Calgary · Calgary · 已生效');
 });
 it('requires an explicit exclusion before moving referenced ancillary fees into a template',async()=>{
  const base=operationsFixture(),group='合成卡尔加里 OA 40HQ';
  const ocean={...base.operations.charges[0]!,id:'reference-ocean',code:'reference-ocean',category:'ocean' as const,name_zh:`海运费 · ${group}`,destination:'Calgary',source_ref:'xlsx:fixture!C3',remark:`参考方案：${group}；待人工调整。`};
  const fee={...base.operations.charges[1]!,id:'reference-fee',code:'reference-fee',name_zh:`港口安保费 · ${group}`,destination:'Calgary',source_ref:'xlsx:fixture!C4',remark:`参考方案：${group}；待人工调整。`};
  const emf={...base.operations.charges[2]!,id:'reference-emf',code:'emf',category:'ocean' as const,name_zh:`EMF 设备管理费 · ${group}`,destination:'Calgary',source_ref:'xlsx:fixture!C5',remark:`参考方案：${group}；待人工调整。`};
  const draft={...base,operations:{...base.operations,charges:[ocean,fee,emf],templates:[],delivery_rates:[],rate_details:[]}};
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:draft},history:[]}:{items:[]}}));
  const form=templateFormStub([{amount:'20'},{amount:'100'}]);
  vi.stubGlobal('document',{querySelector:(selector:string)=>selector==='[data-fcl-form="ops-template"]'?form:null});
  vi.stubGlobal('window',{prompt:()=> '已迁移到海运费表',confirm:()=>true});
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render('', 'templates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));ops.render('', 'templates');
  stubFormData();
  const rates=ops.render('', 'rates');
  expect(rates).toContain('待核对海运费');expect(rates).toContain('海运费 · 合成卡尔加里 OA 40HQ');expect(rates).toContain('>100<');expect(rates).toContain('>CAD<');expect(rates).toContain('按票');
  expect(rates).toContain('data-action="ops-ocean-exclude"');
  await ops.action({dataset:{action:'ops-template-new-from-reference'}});
  expect(ops.render('', 'templates')).toContain('还有 1 项基础海运费未确认排除');
  await ops.action({dataset:{action:'ops-ocean-exclude',id:'charge:reference-ocean'}});
  expect(ops.render('', 'rates')).toContain('已确认排除');
  await ops.action({dataset:{action:'ops-template-new-from-reference'}});
  const converted=ops.render('', 'templates');
  const table=converted.match(/<table class="ops-template-table">[\s\S]*?<\/table>/)?.[0]??'';
  expect(table).toContain('港口安保费');expect(table).toContain('EMF 设备管理费');expect(table).not.toContain('海运费 · 合成');
 });
 it('uses the latest charge version without exposing a validity selector',async()=>{
  const base=operationsFixture(),draft=structuredClone(base);
  const next={...draft.operations.charges[0]!,version:2,valid_from:'2027-01-01',valid_until:'2027-12-31',amount:'999'};
  draft.operations.charges.push(next);
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:draft},history:[]}:{items:[]}}));
  const write=vi.fn((_action:string,body:{input:ReturnType<typeof operationsFixture>})=>Promise.resolve({status:'success',data:{version:2,draft:structuredClone(body.input),active_release:{input:draft},history:[]}}));
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2027-02-15'}},state:{}})});
  ops.render('', 'templates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));ops.render('', 'templates');
  stubFormData();
  const form=templateFormStub(templateRows(draft,draft.operations.templates[0]!,{0:{amount:'999'}}),{containerTypes:draft.operations.templates[0]!.container_types});
  expect(ops.render('', 'templates')).toContain('value="999"');
  expect(ops.render('', 'templates')).not.toContain('费用有效期');
  await ops.submit(form);
  const saved=write.mock.calls[0]?.[1] as {input:ReturnType<typeof operationsFixture>}|undefined;
  expect(saved?.input.operations.charges[3]?.amount).toBe('999');
  expect(saved?.input.operations.charges[0]?.amount).toBe('100');
 });
 it('edits the selected same-id template version and keeps the other version unchanged',async()=>{
  const published=operationsFixture(),draft=structuredClone(published);
  draft.operations.templates.push({...draft.operations.templates[0]!,version:2,valid_from:'2027-01-01',valid_until:'2027-12-31',label:'Calgary Q1'});
  const call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft,active_release:{input:published},history:[]}:{items:[]}}));
  const write=vi.fn((_action:string,body:{input:ReturnType<typeof operationsFixture>})=>Promise.resolve({status:'success',data:{version:2,draft:structuredClone(body.input),active_release:{input:published},history:[]}}));
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2027-02-15'}},state:{}})});
  ops.render('', 'templates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));ops.render('', 'templates');
  stubFormData();
  const selector=templateFormStub(templateRows(draft,draft.operations.templates[0]!),{containerTypes:draft.operations.templates[0]!.container_types});
  changeTemplate(ops,selector,'template_choice','1');
  expect(ops.render('', 'templates')).toContain('Calgary Q1 · Calgary · 未生效');
  const edit=templateFormStub(templateRows(draft,draft.operations.templates[1]!),{containerTypes:draft.operations.templates[1]!.container_types,controls:{'[name="template.label"]':control('Calgary Q1 updated')}});
  await ops.submit(edit);
  const saved=write.mock.calls[0]?.[1] as {input:ReturnType<typeof operationsFixture>}|undefined;
  expect(saved?.input.operations.templates[0]?.label).toBe('Calgary');
  expect(saved?.input.operations.templates[1]?.label).toBe('Calgary Q1 updated');
 });
 it('translates schema paths and opens the affected nested fee settings',async()=>{
  const published=operationsFixture(),call=vi.fn((action:string)=>Promise.resolve({status:'success',data:action==='rate-get'?{version:1,draft:published,active_release:{input:published},history:[]}:{items:[]}}));
  const write=vi.fn();
  const ops=createFclOperations({call,write,api:vi.fn(),esc:(v:string|number|null)=>String(v??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-15'}},state:{}})});
  ops.render('', 'templates');await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(3));await new Promise(r=>setTimeout(r,0));ops.render('', 'templates');
  stubFormData();
  const form=templateFormStub(templateRows(published,published.operations.templates[0]!,{0:{amount:'not-a-number'}}),{containerTypes:published.operations.templates[0]!.container_types});
  await ops.submit(form);
  expect(write).not.toHaveBeenCalled();
  const errors=ops.render('', 'templates');
  expect(errors).toContain('成本金额需要核对');expect(errors).not.toContain('operations / charges');
  vi.stubGlobal('document',{querySelector:()=>null});
  await ops.action({dataset:{action:'ops-template-focus',field:'charges.0.remark'}});
  await new Promise(r=>setTimeout(r,0));
  expect(ops.render('', 'templates')).toContain('data-template-charge-settings="0" open');
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
