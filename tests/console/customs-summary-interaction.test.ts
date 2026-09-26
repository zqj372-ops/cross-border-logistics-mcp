/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Exercises the browser ESM controller with an isolated DOM boundary. */
import {afterEach,expect,it,vi} from 'vitest';
// @ts-expect-error Browser ESM controller.
import {createBusinessWorkspace} from '../../apps/console/business.js';
import {dataset} from '../customs-native/publication-fixture';
afterEach(()=>vi.unstubAllGlobals());
it('switches existing candidates without network calls, preserves the query form and blocks stale copies',async()=>{
 vi.stubGlobal('matchMedia',()=>({matches:false}));
 const values:Record<string,string>={query:'123456',ruleDate:'2026-09-27',codeCountry:'CA'};
 vi.stubGlobal('FormData',class{get(name:string){return values[name]||'';}});
 const focus=vi.fn(),feedback={textContent:''},target={innerHTML:'',querySelector:()=>({focus}),scrollIntoView:vi.fn()};
 vi.stubGlobal('document',{querySelector:(selector:string)=>selector==='[data-customs-brief]'?{innerText:'Synthetic reference · 待核验 · 2026-09-27'}:selector==='[data-customs-copy-status]'?feedback:target});
 const writeText=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:{writeText}});
 const candidates=['CA','US'].flatMap(country=>['1234561000','1234562000'].map(code=>({item:{...dataset.nomenclature[0],country,code,display_code:code,description_original:'Synthetic article',language:'en'},hierarchy:[],rates:[]})));
 const api=vi.fn().mockResolvedValue({schema_version:'portal-customs-reference@2026-09-27.v1',status:'manual_review',data:{formal_ready:false,rule_date:'2026-09-27',candidates,sources:[],warnings:[],snapshot_sha256:'a'.repeat(64)},reason_codes:['customs_reference_only']});
 const rerender=vi.fn();
 const workspace=createBusinessWorkspace({api,rerender,esc:(v:string)=>String(v??''),head:()=>'',panel:(title:string,_subtitle:string,body:string)=>title+body,note:(v:string)=>v,icon:()=>'',field:()=>'',input:()=>'',actions:()=>'',formError:''});
 await workspace.submit({dataset:{form:'business-customs'}});
 const renderCount=rerender.mock.calls.length;
 await workspace.action({dataset:{action:'business-customs-country',country:'US'}});
 workspace.change({target:{matches:()=>true,value:'1234562000'}});
 expect(target.innerHTML).toContain('value="1234562000" selected');expect(target.innerHTML).toContain('美国进口 · 中国原产');
 expect(api).toHaveBeenCalledTimes(1);expect(rerender).toHaveBeenCalledTimes(renderCount);expect(focus).toHaveBeenCalled();
 await workspace.action({dataset:{action:'business-customs-copy'}});
 expect(writeText).toHaveBeenCalledTimes(1);expect(feedback.textContent).toBe('已复制参考摘要');
 workspace.input({target:{closest:(selector:string)=>selector==='form'?{dataset:{form:'business-customs'}}:null}});
 await workspace.action({dataset:{action:'business-customs-country',country:'CA'}});
 expect(target.innerHTML).toContain('资料已修改');expect(target.innerHTML).toContain('data-save-preview disabled');
 await workspace.action({dataset:{action:'business-customs-copy'}});expect(writeText).toHaveBeenCalledTimes(1);expect(api).toHaveBeenCalledTimes(1);
 await workspace.action({dataset:{action:'business-customs-candidate',id:'123456',country:'US'}});
 expect(api).toHaveBeenLastCalledWith('/business/customs/query',expect.objectContaining({body:{input:expect.objectContaining({selectedHs6:'123456',codeCountry:'US'})}}));
});
