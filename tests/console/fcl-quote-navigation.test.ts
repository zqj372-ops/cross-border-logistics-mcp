/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Tests browser controller state with a narrow transport fixture. */
import {afterEach,expect,it,vi} from 'vitest';
import {createFclInquiryDraft} from '../../apps/inquiry/fcl-model';
// Schema validation is covered by HTTP tests; this fixture isolates cached editor state.
vi.mock('../../services/access-gateway/portal/fcl-http-contracts.ts',()=>({fclHttpResponseSchemas:new Proxy({}, {get:()=>({safeParse:(data:unknown)=>({success:true,data})})})}));
// @ts-expect-error Browser ESM boundary.
import {createFclWorkspace} from '../../apps/console/fcl.js';
afterEach(()=>vi.unstubAllGlobals());

it('replaces the cached editor when another quote for the same case is selected',async()=>{
 const caseId='00000000-0000-4000-8000-000000000001',first='00000000-0000-4000-8000-000000000002',second='00000000-0000-4000-8000-000000000003';
 const location={hash:`#fcl/case/${caseId}/${first}`};vi.stubGlobal('location',location);vi.stubGlobal('document',{querySelector:()=>null});
 const input={...createFclInquiryDraft(),pol:'Yantian',pod:'Vancouver',containers:[{type:'40HQ',quantity:1}],selected_services:['ocean_freight']};
 const detail={case_id:caseId,inquiry_no:'FCL-FIXTURE',case_version:1,case_status:'in_review',current_input:input,original_input:input,review_context:{review_required:false},events:[]};
 const quote=(ref:string)=>({quote_ref:ref,version:1,currentness:{valid_now:true},completeness:{complete:true},case_binding:{case_ref:caseId},cost_rows:[{row_key:'ocean_freight:40HQ',source_kind:'ocean_freight',name:'海运费',group:'B',service:'ocean_freight',unit:'CNTR',container_type:'40HQ',quantity:'1',cost_price:ref===first?'3200.123456':'3500.123456',sell_price:'3850.000000',currency:'USD',sell_amount:'3850.00'}],source_snapshot:{rate_id:'rate',release_id:'release',release_version:1,dataset_digest:'digest',rate:{items:[]}},service_coverage:[],exchange_rates:{USD:'7',CAD:'5'},remark:null,calculation:{by_currency:{USD:{cost_subtotal:'3500.12',revenue_subtotal:'3850.00',gp_subtotal:'349.88',margin:'0.09'}},unified_profit:{gp_subtotal:'2449.16'}}});
 const api=vi.fn((url:string,options:{body?:{quote_ref?:string}}={})=>Promise.resolve({status:'success',data:url.includes('case-get')?detail:url.includes('quote-list')?{items:[]}:url.includes('quote-get')?quote(options.body?.quote_ref??first):url.includes('document-list')?{items:[]}:null,reason_codes:[]}));
 const ui=createFclWorkspace({api,mutate:vi.fn(),model:()=>({session:{identity:{user_id:'fixture'},fcl_capability:{fcl_personal:true}}}),esc:(v:string|number|null)=>String(v??''),head:()=>'',panel:(_title:string,_description:string,body:string)=>body,empty:()=>'',note:()=>'',field:(_label:string,_id:string,body:string)=>body,actions:()=>'',formError:'',icon:()=>'',rerender:vi.fn(),notify:vi.fn()});
 ui.page();await new Promise(r=>setTimeout(r,0));ui.page();await new Promise(r=>setTimeout(r,0));
 expect(ui.page()).toContain('value="3200.12"');expect(ui.page()).not.toContain('value="3200.123456"');
 location.hash=`#fcl/case/${caseId}/${second}`;const loading=ui.page();expect(loading).not.toContain('value="3200.12"');
 await new Promise(r=>setTimeout(r,0));
 expect(ui.page()).toContain('value="3500.12"');expect(ui.page()).not.toContain('value="3200.12"');
});
