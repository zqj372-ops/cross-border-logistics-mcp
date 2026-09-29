/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Exercises browser ESM rendering. */
import {expect,it} from 'vitest';
// @ts-expect-error Browser ESM boundary.
import {orderRows,filterOrders,renderOrderTable} from '../../apps/console/fcl-order-list.js';
const esc=(v:string|number|null)=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
it('projects only public customer fields and matches visible identifiers, not internal values',()=>{
 const rows=orderRows([{case_ref:'one',inquiry_no:'FCL-1',state:'executing',extensions:{shipment_v1:{so:'SO-CA',containers:['ABCD1234567'],route:'Yantian → Toronto'}},nodes:[],events:[],internal_note:'secret',customer_name:'private',cost:'99'}],'customer');
 expect(filterOrders(rows,{query:'abcd123',route:'toronto'})).toHaveLength(1);
 expect(filterOrders(rows,{query:'secret'})).toHaveLength(0);
 const html=renderOrderTable(rows,'customer',esc);
 expect(html).toContain('SO-CA');expect(html).not.toContain('private');expect(html).not.toContain('负责人');expect(html).not.toContain('secret');
});
it('keeps authorized operator work and legacy inquiries in a compact table and escapes input',()=>{
 const rows=orderRows([{case_ref:'one',inquiry_no:'FCL-1',phase:'executing',customer_name:'<客户>',route:'Shanghai → Vancouver',pending_nodes:['canada_customs'],exception:true,deadline:null,extensions:{shipment_v1:{label:'SO-2 / TEST'}}},{case_id:'two',inquiry_no:'FCL-2',case_status:'needs_input',current_input:{pol:'Yantian',pod:'Toronto',contact:{name:'Alice'}}}],'ops');
 expect(filterOrders(rows,{customer:'客户',exception:true})).toHaveLength(1);
 const html=renderOrderTable(rows,'ops',esc);
 expect(html).toContain('&lt;客户>');expect(html).toContain('加拿大清关');expect(html).toContain('SO-2 / TEST');expect(html).toContain('#fcl/case/two');
});
it('uses quote route before execution, keeps missing identifiers honest and filters state exactly',()=>{
 const rows=orderRows([{case_ref:'one',inquiry_no:'FCL-1',state:'awaiting_customer',offer:{document:{origin:'Yantian',destination:'Vancouver'}},nodes:[],events:[]}],'customer');
 expect(rows[0].route).toBe('Yantian → Vancouver');expect(filterOrders(rows,{state:'completed'})).toHaveLength(0);
 expect(renderOrderTable(rows,'customer',esc)).toContain('确认报价');
});
