/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Exercises the browser ESM controller. */
import {expect,it} from 'vitest';
// @ts-expect-error Browser module is intentionally plain JavaScript.
import {createFclExecutionUI} from '../../apps/console/fcl-execution.js';

const esc=(value:string|number|null)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
it('shows an explicit unavailable state without claiming execution or notification success',async()=>{
  const ui=createFclExecutionUI({call:()=>Promise.resolve({status:'unavailable',data:null,reason_codes:['fcl_execution_not_configured']}),write:()=>Promise.resolve(null),esc,rerender:()=>{},notify:()=>{},context:()=>({})});
  ui.setCase('case-a');await ui.load();
  expect(ui.render()).toContain('执行功能未配置');
  expect(ui.render()).not.toContain('已完成');
});
it('drops a previous case response when switching before the response arrives',async()=>{
  let resolve!:(value:unknown)=>void;
  const ui=createFclExecutionUI({call:()=>new Promise(r=>{resolve=r;}),write:()=>Promise.resolve(null),esc,rerender:()=>{},notify:()=>{},context:()=>({})});
  ui.setCase('case-a');const pending=ui.load();ui.setCase('case-b');
  resolve({status:'success',data:{case_ref:'case-a',nodes:[],customer_name:'DO NOT SHOW'},reason_codes:[]});await pending;
  expect(ui.render()).not.toContain('DO NOT SHOW');expect(ui.view()).toBeNull();
});
it('does not expose conversion controls for a node participant',async()=>{
  const view={case_ref:'case-a',inquiry_no:'FCL-TEST',customer_name:'Test',route:'Yantian → Vancouver',owner_id:'owner',coordinator_id:'owner',role:'participant',version:1,state:'executing',nodes:[],shared:{containers:[],hbl:null,mbl:null,eta:null}};
  const ui=createFclExecutionUI({call:()=>Promise.resolve({status:'success',data:view,reason_codes:[]}),write:()=>Promise.resolve(null),esc,rerender:()=>{},notify:()=>{},context:()=>({userId:'participant'})});
  ui.setCase('case-a');await ui.load();
  expect(ui.render()).toContain('订单流转');expect(ui.conversionPanel()).not.toContain('确认成交并转执行');
});
it('preserves assignment reason and notification edits across rerenders and selecting self',async()=>{
  const {vi}=await import('vitest');
  const assignment={responsible_id:null,collaborator_ids:[],to:null,cc:[],enabled:false};
  const notification={external_to:null,external_cc:[],external_enabled:false,visible_fields:[]};
  const view={case_ref:'case-a',inquiry_no:'FCL-TEST',route:'Test',owner_id:'owner',coordinator_id:'owner',role:'owner',version:1,state:'executing',shared:{containers:[]},nodes:[{node_id:'booking',status:'not_started',assignment,notification,assignment_source:'snapshot',fields:{},evidence_refs:[],deadline:null}]};
  const write=vi.fn(()=>Promise.resolve({status:'success',data:view}));
  const ui=createFclExecutionUI({call:(action:string)=>Promise.resolve({status:'success',data:action==='execution-mail-list'?{items:[]}:view}),write,esc,rerender:()=>{},notify:()=>{},context:()=>({userId:'owner'})});
  const values:Record<string,string>={reason:'核对后交由本人处理',to:'test@example.invalid',enabled:'on'};
  vi.stubGlobal('FormData',class{get(key:string){return values[key]||'';}});
  try{
    ui.setCase('case-a');await ui.load();
    const form={dataset:{fclExecForm:'assignment',node:'booking'}};
    ui.input({target:{closest:()=>form}});
    expect(ui.render()).toContain('value="核对后交由本人处理"');
    await ui.action({dataset:{action:'fcl-exec-assign-self',node:'booking'}});
    expect(ui.render()).toContain('value="test@example.invalid"');
    expect(ui.render()).toContain('value="核对后交由本人处理"');
    values.responsible_id='owner';await ui.submit(form);
    expect(write).toHaveBeenCalledWith('execution-node-assign',expect.objectContaining({reason:values.reason,assignment:expect.objectContaining({responsible_id:'owner',to:values.to,enabled:true})}),expect.any(String));
    values.reason='';await ui.submit(form);
    expect(write).toHaveBeenLastCalledWith('execution-node-assign',expect.objectContaining({reason:'首次分派'}),expect.any(String));
    view.nodes[0]!.assignment.responsible_id='owner' as never;write.mockClear();await ui.submit(form);expect(write).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();}
});

it('renders mail settings as compact node sections and preserves other nodes on self assignment',async()=>{
  // @ts-expect-error Browser module is intentionally plain JavaScript.
  const {createFclNodeNotifications}=await import('../../apps/console/fcl-node-notifications.js');
  const {vi}=await import('vitest');
  const rows=['intake','booking'].map(node_id=>({node_id,assignment:{responsible_id:null,collaborator_ids:[],to:null,cc:[],enabled:false},external_to:null,external_cc:[],external_enabled:false,visible_fields:[]}));
  const view={version:1,transport:'configured_unverified',rows};
  const write=vi.fn(()=>Promise.resolve({status:'success',data:view}));
  const ui=createFclNodeNotifications({call:()=>Promise.resolve({status:'success',data:view}),write,esc,rerender:()=>{},notify:()=>{},context:()=>({userId:'owner',email:'owner@example.invalid'})});
  ui.render();await Promise.resolve();
  expect(ui.render()).not.toContain('<table');
  expect(ui.render()).toContain('内部提醒');expect(ui.render()).toContain('对接人邮件');
  const values:Record<string,string>={'intake:to':'intake@example.invalid','booking:external_to':'agent@example.invalid','booking:external_enabled':'on'};
  const form={matches:(selector:string)=>selector==='[data-fcl-notifications]'};
  vi.stubGlobal('FormData',class{get(key:string){return values[key]||'';}});
  try{
    await ui.action({dataset:{action:'fcl-mail-self',node:'booking'},closest:()=>form});
    expect(ui.render()).toContain('agent@example.invalid');expect(ui.render()).toContain('intake@example.invalid');
    expect(ui.render()).toContain('data-mail-node="booking" open');
    values['booking:responsible_id']='owner';values['booking:to']='owner@example.invalid';
    await ui.submit(form);
    expect(write).toHaveBeenCalledWith('notification-v2-save',expect.objectContaining({rows:expect.arrayContaining([expect.objectContaining({node_id:'booking',external_to:'agent@example.invalid',external_enabled:true}),expect.objectContaining({node_id:'intake',assignment:expect.objectContaining({to:'intake@example.invalid'})})])}));
  }finally{vi.unstubAllGlobals();}
});
