/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Exercises the browser ESM controller. */
import {afterEach,expect,it,vi} from 'vitest';
// @ts-expect-error Browser ESM boundary.
import {createFclWorkspace} from '../../apps/console/fcl.js';
afterEach(()=>vi.unstubAllGlobals());

it('recovers a failed list without losing the open inquiry form or writing business data',async()=>{
 vi.stubGlobal('location',{hash:'#fcl'});
 vi.stubGlobal('document',{querySelector:()=>null});
 const api=vi.fn().mockRejectedValueOnce(Object.assign(new Error('network'),{code:'network'})).mockResolvedValue({schema_version:'fcl-http@2026-09-21.v1',status:'success',data:{items:[],next_cursor:null},reason_codes:[]});
 const mutate=vi.fn(),rerender=vi.fn();
 const ui=createFclWorkspace({api,mutate,model:()=>({session:{identity:{user_id:'fixture-user'},fcl_capability:{fcl_personal:true}}}),esc:(v:string|number|null)=>String(v??''),head:(title:string,_description:string,actions:string)=>title+actions,panel:vi.fn(),empty:(title:string)=>title,note:(message:string)=>message,field:(_label:string,_id:string,body:string)=>body,actions:vi.fn(),formError:'',icon:()=>'',rerender,notify:vi.fn()});
 ui.page();await vi.waitFor(()=>expect(rerender).toHaveBeenCalled());
 expect(ui.page()).toContain('重新加载');
 await ui.action({dataset:{action:'fcl-case-new'}});
 expect(ui.page()).toContain('data-fcl-form="case-create"');
 expect(api).toHaveBeenCalledTimes(1);
 await ui.action({dataset:{action:'fcl-cases-retry'}});
 const html=ui.page();
 expect(html).toContain('还没有询价');expect(html).toContain('data-fcl-form="case-create"');
 expect(html).not.toContain('重新加载');expect(api).toHaveBeenCalledTimes(2);expect(mutate).not.toHaveBeenCalled();
});
