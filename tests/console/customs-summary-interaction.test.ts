/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Exercises the browser ESM controller with an isolated DOM boundary. */
import {afterEach,expect,it,vi} from 'vitest';
// @ts-expect-error Browser ESM controller.
import {createBusinessWorkspace} from '../../apps/console/business.js';
import {dataset} from '../customs-native/publication-fixture';
afterEach(()=>vi.unstubAllGlobals());
it.each(['2026-09-27.v1','2026-09-27.v2','2026-09-28.v3','2026-09-28.v4'])('renders reference %s, switches candidates without network calls and blocks stale copies',async version=>{
 vi.stubGlobal('matchMedia',()=>({matches:false}));
 const values:Record<string,string>={query:'123456',ruleDate:'2026-09-27',codeCountry:'CA',material:'不锈钢',use:'日常饮水',vacuumInsulated:'yes',contains_steel_aluminum:'yes'};
 vi.stubGlobal('FormData',class{get(name:string){return values[name]||'';}});
 const focus=vi.fn(),feedback={textContent:''},target={innerHTML:'',querySelector:()=>({focus}),scrollIntoView:vi.fn()};
 vi.stubGlobal('document',{querySelector:(selector:string)=>selector==='[data-customs-brief]'?{innerText:'Synthetic reference · 待核验 · 2026-09-27'}:selector==='[data-customs-copy-status]'?feedback:target});
 const writeText=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:{writeText}});
 const candidates=['CA','US'].flatMap(country=>['1234561000','1234562000'].map(code=>({item:{...dataset.nomenclature[0],country,code,display_code:code,description_original:'Synthetic article',language:'en'},hierarchy:[],rates:[]})));
 const api=vi.fn().mockResolvedValue({schema_version:`portal-customs-reference@${version}`,status:'manual_review',data:{formal_ready:false,rule_date:'2026-09-27',candidates,sources:[],warnings:[],snapshot_sha256:'a'.repeat(64)},reason_codes:['customs_reference_only']});
 const rerender=vi.fn();
 const workspace=createBusinessWorkspace({api,rerender,esc:(v:string)=>String(v??''),head:()=>'',panel:(title:string,_subtitle:string,body:string)=>title+body,note:(v:string)=>v,icon:()=>'',field:(_label:string,_name:string,control:string)=>control,input:(name:string)=>`<input name="${name}">`,actions:()=>'',formError:''});
 workspace.restoreHistory({query:values.query,ruleDate:values.ruleDate,codeCountry:values.codeCountry,attributes:{originCountry:'CN',vacuumInsulated:'yes',contains_steel_aluminum:'yes'}});
 const form=workspace.customsPage();expect(form).toContain('name="material"');expect(form).toContain('name="use"');
 expect(form).not.toContain('name="vacuumInsulated"');expect(form).not.toContain('name="contains_steel_aluminum"');
 await workspace.submit({dataset:{form:'business-customs'}});
 expect(workspace.customsPage()).toContain('进口税费与要求概览');expect(workspace.customsPage()).not.toContain('查询编号 undefined');
 expect(api).toHaveBeenLastCalledWith('/business/customs/query',expect.objectContaining({body:{input:expect.objectContaining({attributes:{originCountry:'CN',material:'不锈钢',use:'日常饮水'}})}}));
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

it('shows an update instruction for an unsupported reference version instead of the formal-results fallback',async()=>{
 vi.stubGlobal('matchMedia',()=>({matches:false}));
 vi.stubGlobal('FormData',class{get(name:string){return ({query:'合成商品',ruleDate:'2026-09-28',codeCountry:'CA'} as Record<string,string>)[name]||'';}});
 const api=vi.fn().mockResolvedValue({schema_version:'portal-customs-reference@2099-01-01.v5',status:'manual_review',data:{formal_ready:false,candidates:[]},reason_codes:['customs_reference_only']});
 const workspace=createBusinessWorkspace({api,rerender:()=>{},esc:(v:string)=>String(v??''),head:()=>'',panel:(title:string,subtitle:string,body:string)=>title+subtitle+body,note:(v:string)=>v,icon:()=>'',field:()=>'',input:()=>'',actions:()=>'',formError:''});
 await workspace.submit({dataset:{form:'business-customs'}});
 const page=workspace.customsPage();expect(page).toContain('请刷新页面');expect(page).not.toContain('查询编号 undefined');expect(page).not.toContain('服务返回：customs_reference_only');
});
