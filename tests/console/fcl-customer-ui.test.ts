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
