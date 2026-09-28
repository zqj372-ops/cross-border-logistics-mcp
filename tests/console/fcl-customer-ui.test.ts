import {expect,it} from 'vitest';
// @ts-expect-error Browser ESM boundary.
import {createCustomerPortal} from '../../apps/console/fcl-customer.js';

it('clears customer data on account change and ignores the previous account response',async()=>{
 let identity='a';const resolvers:Array<(v:unknown)=>void>=[];
 const create=createCustomerPortal as (dependencies:Record<string,unknown>)=>{page:(id:string)=>string};
 const ui=create({identity:()=>identity,api:()=>new Promise(resolve=>resolvers.push(resolve)),mutate:()=>{},esc:(s:unknown)=>String(s),head:()=>'',panel:(_t:unknown,_d:unknown,b:unknown)=>b,rerender:()=>{},notify:()=>{}});
 ui.page('');await new Promise(resolve=>setTimeout(resolve,0));
 identity='b';expect(ui.page('')).not.toContain('private-a');await new Promise(resolve=>setTimeout(resolve,0));
 resolvers[0]!({status:'success',data:{items:[{case_ref:'a',inquiry_no:'private-a',state:'inquiry'}],next_before:null}});
 await new Promise(resolve=>setTimeout(resolve,0));expect(ui.page('')).not.toContain('private-a');
 resolvers[1]!({status:'success',data:{items:[],next_before:null}});
 await new Promise(resolve=>setTimeout(resolve,0));expect(ui.page('')).toContain('暂无业务');
});

it('puts progress before the collapsed quote for an executing shipment',async()=>{
 const create=createCustomerPortal as (dependencies:Record<string,unknown>)=>{page:(id:string)=>string};
 const ui=create({identity:()=> 'customer',api:()=>Promise.resolve({status:'success',data:{case_ref:'case',inquiry_no:'FCL-1',extensions:{shipment_v1:{so:'SO-1',containers:['TEST1234567'],route:'Yantian → Vancouver'}},state:'executing',nodes:[{id:'canada_customs',status:'active',completed_at:null}],events:[],offer:{offer_id:'offer',document:{fee_items:[],valid_until:'2026-10-15'},totals:{by_currency:{}},scope:[],issuer:{}}}}),mutate:()=>{},esc:(s:string)=>s??'',head:(t:string)=>`<h1>${t}</h1>`,panel:(_t:unknown,_d:unknown,b:unknown)=>b,rerender:()=>{},notify:()=>{}});
 ui.page('case');await new Promise(resolve=>setTimeout(resolve,0));const html=ui.page('case');
 expect(html).toContain('SO-1');expect(html).toContain('customer-node-list');
 expect(html.indexOf('运输进度')).toBeLessThan(html.indexOf('报价与费用'));
 expect(html).toContain('<details class="panel customer-quote">');
});
