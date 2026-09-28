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
