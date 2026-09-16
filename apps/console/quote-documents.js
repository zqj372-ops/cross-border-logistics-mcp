const WORKFLOW_REQUEST_VERSION='quote-documents-workflow@2026-09-15.v1';
const DRAFT_VERSION='quote-document-draft@2026-09-15.v1';

const freshFee=()=>({id:crypto.randomUUID(),source_kind:'manual',template_ref:null,name:null,description:null,group:null,quantity:null,unit:null,unit_price:null,currency:null,display:null,merge_name:null,note:null});
const blankDraft=()=>({schema_version:DRAFT_VERSION,quote_no:null,customer_name:null,quote_date:null,valid_until:null,origin:null,destination:null,route_name:null,job_no:null,so_no:null,container_no:null,remark:null,exchange_rates:{USD:null,CAD:null},fee_items:[freshFee()]});
const blankTemplate=()=>({company_name:'',company_address:'',company_phone:'',company_email:'',terms:'',fee_items:[]});

export function createQuoteDocuments({api,mutate,model,esc,head,icon,rerender,canConfigure}){
 let epoch=0,scope='',config=null,templateDraft=blankTemplate(),loading=false,busy=false,message='',dirty=false;
 let current=null,draft=blankDraft(),mode='editor',list=null,listError='',filters={state:'all',quote_no:'',customer_name:''},review=null,nativeSeed=null,nativePrepared=null,selectedTemplateKeys=new Set(),replayNotice=null,guardInstalled=false;

 const configMode=()=>location.hash==='#configure/quote.documents';
 const context=()=>JSON.stringify([model().sessionGeneration,model().session?.organization_id,model().session?.identity?.user_id]);
 const request=async(action,input)=>{
  const body={contract_version:WORKFLOW_REQUEST_VERSION,...input};
  return api('/quote-documents/'+action,{method:'POST',body});
 };
 const configuredTemplate=value=>({company_name:value?.company_name??'',company_address:value?.company_address??'',company_phone:value?.company_phone??'',company_email:value?.company_email??'',terms:value?.terms??'',fee_items:Array.isArray(value?.fee_items)?value.fee_items:[]});
 const submit=async(action,input)=>{
  const body={contract_version:WORKFLOW_REQUEST_VERSION,...input};
  return mutate('/quote-documents/'+action,'POST',body);
 };
 const reset=()=>{epoch++;scope='';config=null;templateDraft=blankTemplate();loading=false;busy=false;message='';dirty=false;current=null;draft=blankDraft();mode='editor';list=null;listError='';filters={state:'all',quote_no:'',customer_name:''};review=null;nativeSeed=null;nativePrepared=null;selectedTemplateKeys=new Set();replayNotice=null;};
 const sync=()=>{const next=context();if(next!==scope){reset();scope=next;}};
 const field=(label,name,value='',type='text')=>`<label class="field"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(value??'')}" ${type==='text'?'maxlength="500"':''}></label>`;
 const area=(label,name,value='')=>`<label class="field"><span>${esc(label)}</span><textarea name="${name}" rows="3" maxlength="4000">${esc(value??'')}</textarea></label>`;
 const button=(label,action,primary=false,id='')=>`<button type="button" class="button ${primary?'primary':''}" data-action="qdoc-${action}" data-id="${esc(id)}" ${busy?'disabled':''}>${esc(label)}</button>`;
 const leaveGuard=()=>!dirty||window.confirm('当前报价单有未保存修改，确定放弃并继续吗？');

 async function load(){
  if(loading||config)return;loading=true;const e=epoch;
  try{
   const response=await api('/quote-documents/config?contract_version='+encodeURIComponent(WORKFLOW_REQUEST_VERSION));
   if(e!==epoch)return;config=response.data;templateDraft=configuredTemplate(config.input);
   await refreshList(e);
  }catch(error){if(e===epoch)message=reason(error);}finally{if(e===epoch){loading=false;rerender();}}
 }

 async function refreshList(e=epoch){
  try{
   const response=await request('list',{limit:30,cursor:null,filters:{state:filters.state,quote_no:filters.quote_no||null,customer_name:filters.customer_name||null}});
   if(e!==epoch)return;
   if(response.status==='success'){list=response.data;listError='';}
   else listError=response.reason_codes?.[0]||'response_invalid';
  }catch(error){if(e===epoch)listError=error.code||'network';}
 }

 function capture(){
  const form=document.querySelector(configMode()?'form[data-form="qdoc-template"]':'form[data-form="qdoc-editor"]');if(!form)return;
  if(configMode()){
   for(const el of form.querySelectorAll('[data-qdoc-template] input,textarea'))templateDraft[el.name]=el.value;
   return;
  }
  for(const el of form.querySelectorAll('[data-qdoc-info] input,textarea')){
   if(el.name==='USD'||el.name==='CAD')draft.exchange_rates[el.name]=el.value.trim()||null;
   else draft[el.name]=el.value.trim()||null;
  }
  draft.fee_items=[...form.querySelectorAll('[data-fee]')].map((row,index)=>{
   const base=draft.fee_items[index]||freshFee(),value={...base};
   for(const el of row.querySelectorAll('input,select'))value[el.name]=el.value.trim()||null;
   return value;
  });
 }

 function reason(error,suffix='操作未完成，请检查输入及当前企业权限。'){
  return error?.code?'操作未完成：'+error.code:error?.message||suffix;
 }

 function feeRows(items){
  return `<div class="qdoc-fee-table">${items.map((fee,index)=>`<section class="qdoc-fee-row" data-fee="${index}">
   <div class="qdoc-fee-main">
    ${field('费用名称','name',fee.name)}
    ${field('数量','quantity',fee.quantity)}
    ${field('单位','unit',fee.unit)}
    ${field('单价','unit_price',fee.unit_price)}
    <label class="field"><span>币种</span><select name="currency" aria-label="币种">${[['','待选择'],['USD','USD'],['CAD','CAD'],['CNY','CNY']].map(([v,l])=>`<option value="${v}" ${fee.currency===v||(!fee.currency&&!v)?'selected':''}>${l}</option>`).join('')}</select></label>
    <div class="qdoc-line-actions">${button('移除','remove',false,String(index))}</div>
   </div>
   <details><summary>分组、展示与备注</summary><div class="qdoc-fee-details">
    <label class="field"><span>分组</span><select name="group" aria-label="分组">${[['','待选择'],['A','A · 起运段'],['B','B · 干线运输'],['C','C · 目的段']].map(([v,l])=>`<option value="${v}" ${fee.group===v||(!fee.group&&!v)?'selected':''}>${l}</option>`).join('')}</select></label>
    <label class="field"><span>客户展示</span><select name="display" aria-label="客户展示">${[['','待选择'],['detail','显示明细'],['hiddenIncluded','隐藏明细，计入合计'],['hiddenExcluded','隐藏且不计入'],['merged','合并显示']].map(([v,l])=>`<option value="${v}" ${fee.display===v||(!fee.display&&!v)?'selected':''}>${l}</option>`).join('')}</select></label>
    ${field('合并显示名称','merge_name',fee.merge_name)}${field('说明','description',fee.description)}${field('备注','note',fee.note)}
   </div></details>
  </section>`).join('')}</div>`;
 }

 function templatePicker(){
  const catalog=config?.catalog;if(!catalog)return '';
  return `<details class="qdoc-template-picker"><summary>选择标准费用</summary><p>不会默认加入，不会预设价格或币种。</p>${catalog.groups.map(group=>`<section><h3>${esc(group.label)}</h3><div class="qdoc-template-grid">${group.items.map(item=>{
   const key=`${catalog.template_id}:${catalog.template_version}:${item.item_key}`;
   return `<label><input type="checkbox" data-qdoc-template-key="${esc(key)}" ${selectedTemplateKeys.has(key)?'checked':''}><span>${esc(item.name)}</span></label>`;
  }).join('')}</div></section>`).join('')}<div class="qdoc-template-actions">${button('追加所选项目','apply-template',false)}</div></details>`;
 }

 function completenessBanner(){
  const missing=current?.completeness?.missing_fields||[];
  if(!missing.length)return '';
  return `<div class="inline-note" role="status">草稿可保存，但核对前仍需补全：${missing.map(esc).join('、')}</div>`;
 }

 function editorPage(){
  const data=current?.claim_state==='legacy_unclaimed'?current.input:draft;
  const locked=current&&current.state==='approved';
  const info=`${field('报价单号 *','quote_no',data.quote_no)}${field('客户名称 *','customer_name',data.customer_name)}${field('报价日期 *','quote_date',data.quote_date,'date')}${field('有效期至 *','valid_until',data.valid_until,'date')}${field('起运地','origin',data.origin)}${field('目的地','destination',data.destination)}<details class="qdoc-details"><summary>运输单号、汇率与备注</summary><div class="qdoc-fields">${field('线路','route_name',data.route_name)}${field('单号','job_no',data.job_no)}${field('SO 号','so_no',data.so_no)}${field('柜号','container_no',data.container_no)}${field('1 USD = 多少 CNY','USD',data.exchange_rates.USD)}${field('1 CAD = 多少 CNY','CAD',data.exchange_rates.CAD)}${area('备注','remark',data.remark)}</div></details>`;
  return `<div class="qdoc-workbench"><form data-form="qdoc-editor"><fieldset ${locked?'disabled':''}><section class="qdoc-section"><div class="qdoc-section-head"><h2>客户与运输</h2>${current?`<span>${esc(current.claim_state)} · v${current.version}</span>`:''}</div><div class="qdoc-fields" data-qdoc-info>${info}</div></section>${templatePicker()}<section class="qdoc-section"><div class="qdoc-section-head"><h2>费用明细</h2><span>${data.fee_items.length}/60 行</span></div><p>缺失单价显示“待填写”，不会自动补 0。合计按币种展示，缺汇率时不做折算。</p>${feeRows(data.fee_items)}${button('添加费用','add')}</section></fieldset></form>
  <div class="qdoc-actionbar"><span>${dirty?'有未保存修改':'已读回服务器版本'}</span>${locked?button('导出正式 PDF','export-formal',true)+button('复制为新报价单','copy',false,current.id):`${button('保存草稿','save')}${button('导出草稿 PDF','export-draft')}${current?button('继续编辑并重新核对','review',true):button('核对报价','review',true)}`}</div></div>`;
 }

 function recordsPage(){
  return `<div class="qdoc-records"><div class="qdoc-record-toolbar"><label>状态<select data-qdoc-filter="state"><option value="all" ${filters.state==='all'?'selected':''}>全部</option><option value="draft" ${filters.state==='draft'?'selected':''}>草稿</option><option value="approved" ${filters.state==='approved'?'selected':''}>已确认</option><option value="rejected" ${filters.state==='rejected'?'selected':''}>已退回</option></select></label><label>单号<input data-qdoc-filter="quote_no" value="${esc(filters.quote_no)}"></label><label>客户<input data-qdoc-filter="customer_name" value="${esc(filters.customer_name)}"></label>${button('筛选','filter')}${button('新建报价单','new',true)}</div>${listError?`<div class="inline-note" role="status">${esc(reason({code:listError}))}</div>`:''}<div class="qdoc-record-columns"><strong>报价单号</strong><strong>客户</strong><strong>日期</strong><strong>状态</strong><strong>版本</strong><strong>操作</strong></div>${list?.items?.length?list.items.map(item=>`<div class="qdoc-record-row"><span data-label="报价单号">${esc(item.quote_no||'待填写')}</span><span data-label="客户">${esc(item.customer_name||'待填写')}</span><span data-label="日期">${esc(item.updated_at?.slice(0,10)||'')}</span><span data-label="状态">${item.state==='draft'?'草稿':item.state==='approved'?'已确认':'已退回'}</span><span data-label="版本">v${item.version}</span><span data-label="操作">${item.state==='approved'?button('查看/导出','open',false,item.id)+button('复制','copy',false,item.id):button('继续编辑','open',true,item.id)}</span></div>`).join(''):'<div class="qdoc-empty-inline">暂无报价记录</div>'}</div>`;
 }

 function reviewPage(){
  const data=review;if(!data)return editorPage();
  const totals=data.totals;
  return `<div class="qdoc-review"><section class="qdoc-section"><div class="qdoc-section-head"><h2>核对报价</h2><span>v${data.reviewed_version}</span></div><p>保存不等于核对。确认后生成新的 approved 版本，原草稿版本保留。</p><dl class="qdoc-totals">${Object.entries(totals.by_currency).map(([currency,value])=>`<dt>${currency}</dt><dd>${esc(value)}</dd>`).join('')}<dt>折算人民币</dt><dd>${totals.total_cny===null?'缺少汇率':esc(totals.total_cny)}</dd><dt>折算美元</dt><dd>${totals.total_usd===null?'缺少汇率':esc(totals.total_usd)}</dd>${totals.partial?'<dt>状态</dt><dd>不完整小计</dd>':''}</dl><div class="qdoc-actionbar">${button('返回修改','back-edit')}${data.can_approve&&canConfigure()?button('确认报价','approve',true):'<span>等待企业负责人或管理员确认</span>'}</div></section>${data.can_approve&&canConfigure()?`<form data-form="qdoc-approval"><div class="form-error" role="alert" hidden></div>${field('价格来源编号 *','evidence_ref')}${field('来源版本 *','evidence_version')}${area('核对说明 *','review_notes')}<label><input type="checkbox" name="confirmed">我已逐项核对价格、来源、有效期和客户条款。</label><button class="button primary" type="submit">确认人工核对</button></form>`:''}</div>`;
 }

 function page(){
  sync();if(!guardInstalled){guardInstalled=true;window.addEventListener('beforeunload',event=>{if(!dirty)return;event.preventDefault();event.returnValue='';});}if(!model().session?.organization_id)return head('报价单','请先在账号中选择企业。');if(!config&&!loading&&!message)void load();
  const admin=configMode();if(admin&&!canConfigure())return head('报价单配置','需要当前企业负责人或管理员权限。');
  const title=admin?'报价单配置':'报价单';
  let body=head(title,admin?'维护公司资料、客户条款和标准费用。':'保存草稿，核对报价，确认后导出正式 PDF。');
  body+=`<nav class="native-tabs"><button type="button" data-action="qdoc-editor" ${!admin&&mode!=='records'?'aria-current="page"':''}>制作报价单</button><button type="button" data-action="qdoc-records" ${!admin&&mode==='records'?'aria-current="page"':''}>报价记录</button>${canConfigure()?`<a href="#configure/quote.documents" ${admin?'aria-current="page"':''}>企业模板</a>`:''}</nav>${message?`<div class="inline-note" role="status">${esc(message)}</div>`:''}${replayNotice?`<div class="inline-note" role="status">${esc(replayNotice)}</div>`:''}`;
  if(!config)return body+(loading?'<p>正在读取报价单服务…</p>':'');
  if(admin){
   if(!config.input)body+=`<section class="qdoc-empty">${icon('file')}<h2>填写企业报价模板</h2><p>模板只保存公司资料、客户条款和常用费用。已有报价保留自己的快照。</p></section>`;
   body+=`<form data-form="qdoc-template"><fieldset data-qdoc-template><section class="qdoc-section"><h2>公司与条款</h2><div class="qdoc-fields">${field('公司名称 *','company_name',templateDraft.company_name)}${field('联系邮箱','company_email',templateDraft.company_email)}${field('联系电话','company_phone',templateDraft.company_phone)}${field('公司地址','company_address',templateDraft.company_address)}${area('客户条款 *','terms',templateDraft.terms)}</div></section></fieldset></form><div class="qdoc-actionbar">${button('保存企业模板','config-save',true)}</div>`;
   return body;
  }
  if(mode==='records'){body+=recordsPage();return body;}
  if(mode==='review'){body+=reviewPage();return body;}
  body+=completenessBanner()+editorPage();return body;
 }

 function addSelectedTemplate(){
  const selected=[...document.querySelectorAll('[data-qdoc-template-key]:checked')].map(input=>{
   const [templateId,templateVersion,itemKey]=input.getAttribute('data-qdoc-template-key').split(':');
   for(const group of config.catalog.groups){const item=group.items.find(candidate=>candidate.item_key===itemKey);if(item)return {templateId,templateVersion:Number(templateVersion),itemKey,group:group.group,item};}
   return null;
  }).filter(Boolean);
  const additions=[];
  for(const selectedItem of selected){
   if(draft.fee_items.some(fee=>fee.template_ref?.template_id===selectedItem.templateId&&fee.template_ref?.template_version===selectedItem.templateVersion&&fee.template_ref?.item_key===selectedItem.itemKey))continue;
   additions.push({...freshFee(),source_kind:'template',template_ref:{template_id:selectedItem.templateId,template_version:selectedItem.templateVersion,item_key:selectedItem.itemKey},name:selectedItem.item.name,description:selectedItem.item.description,group:selectedItem.group,quantity:selectedItem.item.quantity_suggestion,unit:selectedItem.item.unit_suggestion,display:selectedItem.item.display});
  }
  if(draft.fee_items.length+additions.length>60){message='费用明细最多 60 行，未应用任何项目。';return;}
  draft.fee_items.push(...additions);selectedTemplateKeys.clear();dirty=true;message=additions.length?`已追加 ${additions.length} 条标准费用。`:'没有可追加的新项目。';rerender();
 }

 async function prepareNativeIfNeeded(e){
  if(!nativeSeed||nativePrepared)return;
  const customer={quote_no:draft.quote_no,customer_name:draft.customer_name,quote_date:draft.quote_date,valid_until:draft.valid_until,job_no:draft.job_no||'',so_no:draft.so_no||'',container_no:draft.container_no||'',remark:draft.remark||''};
  const body=nativeSeed.link?{document_kind:'linked',case_ref:nativeSeed.link.case_ref,expected_customer_event_ref:nativeSeed.link.reviewed_customer_event_ref,request:nativeSeed.request,customer}:{document_kind:'native_unlinked',request:nativeSeed.request,customer};
  const response=await request('native-prepare',body);if(e!==epoch)return;
  if(response.status!=='success')throw Object.assign(new Error(response.reason_codes?.[0]||'native_quote_unavailable'),{code:response.reason_codes?.[0]});
  nativePrepared=response.data;draft=structuredClone(nativePrepared.input);dirty=true;
 }

 async function saveDraft(e,usePreparedInput=false){
  if(!usePreparedInput)capture();
  if(!current&&nativeSeed&&!nativePrepared){await prepareNativeIfNeeded(e);if(e!==epoch)return false;if(!nativePrepared){message='原生报价准备失败。';return false;}usePreparedInput=true;}
  const input=usePreparedInput&&nativePrepared?nativePrepared.input:draft;
  const body=current?{operation:'update',document_kind:current.document_kind,id:current.id,expected_version:current.version,input,template_selection:{mode:'retain'},save_intent:'save_draft'}: nativePrepared?{operation:'create',document_kind:nativePrepared.document_kind,input,template_selection:{mode:'current'},native_quote_v1:nativePrepared.native_quote_v1,...(nativePrepared.inquiry_case_link_v1?{inquiry_case_link_v1:nativePrepared.inquiry_case_link_v1}:{}),preview_hash:nativePrepared.preview_hash,preview_expires_at:nativePrepared.preview_expires_at,save_intent:'save_draft'}:{operation:'create',document_kind:'manual',input,template_selection:{mode:'current'},save_intent:'save_draft'};
  if(current?.native_quote_v1)body.binding_update=nativePrepared?{mode:'replace',native_quote_v1:nativePrepared.native_quote_v1,...(nativePrepared.inquiry_case_link_v1?{inquiry_case_link_v1:nativePrepared.inquiry_case_link_v1}:{}),preview_hash:nativePrepared.preview_hash,preview_expires_at:nativePrepared.preview_expires_at}:{mode:'retain'};
  const response=await submit('save',body);if(e!==epoch)return;
  if(response.status!=='success'){
   const code=response.reason_codes?.[0];
   if(current?.native_quote_v1&&!nativePrepared&&code==='native_quote_rebind_required'){await prepareNativeIfNeeded(e);if(e!==epoch)return false;if(nativePrepared)return saveDraft(e,true);}
   message=reason({'code':code});return false;
  }
  const value=response.data;
  if(value.replay){replayNotice='幂等重放命中历史提交，它不是当前版本。';current=await request('get',{id:value.id}).then(result=>result.data);}
  else{current=value;draft=structuredClone(value.input);}
  dirty=false;review=null;mode='editor';message=`草稿已保存：v${current.version} · ${current.updated_at}`;
  return true;
 }

 async function reviewDraft(e){
  if(dirty||!current){await saveDraft(e);if(dirty||!current)return;}
  const response=await request('review',{id:current.id,expected_version:current.version});if(e!==epoch)return;
  if(response.status==='success'){review=response.data;mode='review';message='已生成当前版本核对结果。';}
  else{message='草稿尚不完整：'+((response.data?.completeness?.missing_fields)||response.reason_codes||[]).join('、');}
 }

 function download(bytes,type,name){const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}

 async function exportDocument(modeValue){
  const input=modeValue==='history'?{id:current.id,mode:'history',target_version:current.version,expected_current_version:current.version}:{id:current.id,mode:modeValue,expected_version:current.version};
  const response=await request('export',input);
  if(response.status!=='success'){message=reason({'code':response.reason_codes?.[0]});return;}
  const data=response.data,bytes=Uint8Array.from(window.atob(data.content_base64),c=>c.charCodeAt(0)),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(digest!==data.sha256||bytes.length!==data.byte_length)throw new Error('PDF 校验失败。');download(bytes,'application/pdf',data.filename);message=(modeValue==='formal'?'正式 PDF':modeValue==='draft'?'草稿 PDF':'历史回执')+' 已生成并校验。';
 }

 async function action(buttonElement){
  const actionName=buttonElement.dataset.action;if(!actionName?.startsWith('qdoc-'))return false;sync();if(busy)return true;busy=true;const e=epoch;message='';replayNotice=null;
  try{
   const kind=actionName.slice(5);
   if(kind==='new'){if(!leaveGuard())return true;current=null;draft=blankDraft();nativeSeed=null;nativePrepared=null;review=null;dirty=false;mode='editor';}
   else if(kind==='editor'){if(mode!=='editor'&&!leaveGuard())return true;mode='editor';location.hash='quote-documents';}
   else if(kind==='save')await saveDraft(e);
   else if(kind==='review')await reviewDraft(e);
   else if(kind==='add'){capture();if(draft.fee_items.length>=60)throw new Error('费用明细最多 60 行。');draft.fee_items.push(freshFee());dirty=true;}
   else if(kind==='remove'){capture();draft.fee_items.splice(Number(buttonElement.dataset.id),1);dirty=true;}
   else if(kind==='apply-template'){capture();addSelectedTemplate();}
   else if(kind==='records'){if(mode==='editor'&&!leaveGuard())return true;mode='records';await refreshList(e);}
   else if(kind==='filter'){filters={state:document.querySelector('[data-qdoc-filter="state"]')?.value||'all',quote_no:document.querySelector('[data-qdoc-filter="quote_no"]')?.value.trim()||'',customer_name:document.querySelector('[data-qdoc-filter="customer_name"]')?.value.trim()||''};await refreshList(e);}
   else if(kind==='open'){const id=buttonElement.dataset.id;if(current?.id!==id&&!leaveGuard())return true;const response=await request('get',{id});if(response.status!=='success')throw Object.assign(new Error(response.reason_codes?.[0]),{code:response.reason_codes?.[0]});current=response.data;draft=structuredClone(current.input);nativeSeed=current.native_quote_v1?{request:structuredClone(current.native_quote_v1.request),link:current.inquiry_case_link_v1||null}:null;nativePrepared=null;review=null;mode='editor';dirty=false;}
   else if(kind==='copy'){if(!leaveGuard())return true;let source=current;const requested=buttonElement.dataset.id||source?.id||'';if(!source||source.id!==requested){if(!requested)throw new Error('document_input_invalid');const response=await request('get',{id:requested});if(response.status!=='success')throw Object.assign(new Error(response.reason_codes?.[0]),{code:response.reason_codes?.[0]});source=response.data;}current=null;draft=structuredClone(source.input);draft.quote_no=null;review=null;nativePrepared=null;if(source.native_quote_v1){nativeSeed={request:structuredClone(source.native_quote_v1.request),link:source.inquiry_case_link_v1||null};draft.fee_items=[];dirty=false;message='已复制报价信息；重新核对时将按当前来源重新生成不可改价费用。';}else{draft.fee_items.forEach(fee=>{fee.id=crypto.randomUUID();if(fee.source_kind!=='template')fee.template_ref=null;});nativeSeed=null;dirty=true;message='已复制为新的报价单，需重新核对。';}mode='editor';}
   else if(kind==='back-edit'){mode='editor';}
   else if(kind==='config-save'){const form=document.querySelector('form[data-form="qdoc-template"]');if(!form)throw new Error('模板表单不可用。');await formSubmit(form);}
   else if(kind==='approve'){if(!canConfigure())throw new Error('需要当前企业负责人或管理员权限。');const form=document.querySelector('form[data-form="qdoc-approval"]');if(!form.dataset.pending) {form.dataset.pending='1';form.scrollIntoView({block:'center'});message='填写来源依据并勾选确认后提交。';}}
   else if(kind==='export-draft')await exportDocument('draft');
   else if(kind==='export-formal')await exportDocument('formal');
   else if(kind==='history')await exportDocument('history');
  }catch(error){if(e===epoch)message=reason(error);}
  finally{if(e===epoch){busy=false;rerender();}}
  return true;
 }

 async function formSubmit(form){
  capture();
  if(form.dataset.form==='qdoc-template'){
   const body={expected_version:config.version,input:{...templateDraft,standard_fee_template_v1:config.standard_fee_template_v1||{template_id:config.catalog.template_id,template_version:config.catalog.template_version,items:[]}},confirmed:true};
   const response=await submit('config-save',body);if(response.status!=='success')throw Object.assign(new Error(response.reason_codes?.[0]),{code:response.reason_codes?.[0]});config=response.data;templateDraft=configuredTemplate(config.input);dirty=false;message='企业模板已保存并读回。';rerender();return true;
  }
  if(form.dataset.form==='qdoc-approval'){
   const data=new FormData(form);if(!data.has('confirmed'))return true;if(!review)throw new Error('请先重新核对。');
   const response=await submit('approve',{id:review.document_id,expected_version:review.reviewed_version,review_hash:review.review_hash,evidence_ref:data.get('evidence_ref'),evidence_version:data.get('evidence_version'),review_notes:data.get('review_notes'),confirmation:'human_verified_price_and_source'});
   if(response.status!=='success')throw Object.assign(new Error(response.reason_codes?.[0]),{code:response.reason_codes?.[0]});current=response.data;draft=structuredClone(current.input);review=null;mode='editor';dirty=false;message='人工核对已确认并读回。';rerender();return true;
  }
  return false;
 }

 function input(event){if(!event.target.closest('form[data-form="qdoc-editor"]')&&!event.target.closest('form[data-form="qdoc-template"]'))return false;capture();dirty=true;return true;}
 function change(event){if(event.target.matches('[data-qdoc-template-key]')){const key=event.target.getAttribute('data-qdoc-template-key');if(event.target.checked)selectedTemplateKeys.add(key);else selectedTemplateKeys.delete(key);return true;}return false;}
 function fromQuote(result,input,link){const next=context();if(next!==scope){reset();scope=next;}else{epoch++;loading=false;busy=false;}current=null;nativeSeed={request:structuredClone(input),link:link||null};nativePrepared=null;review=null;selectedTemplateKeys.clear();replayNotice=null;message='';const value=result?.data||{};draft=blankDraft();draft.origin=value.origin||null;draft.destination=[value.city,value.province,value.postal_code].filter(Boolean).join(' ')||null;draft.valid_until=value.match_trace?.valid_until||null;draft.remark='询价试算，仅作核对依据。';dirty=true;mode='editor';location.hash='quote-documents';}
 return {page,action,submit:formSubmit,input,change,reset,fromQuote,isDirty:()=>dirty};
}
