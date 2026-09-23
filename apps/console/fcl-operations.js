import {isBaseOceanFreight} from '../../services/quote-native/fcl-fee-identity.ts';
import {createFclSchedules,isCoscoScheduleRate} from './fcl-schedules.js';
import Decimal from 'decimal.js';
import {fclField,fclFieldHtml,FCL_FIELDS,FCL_CHARGE_CATALOG,FCL_SERVICE_MODE_LABELS} from '../inquiry/fcl-fields.ts';
import {displayMargin,displayAmount,readAmountInput,fclIssue} from '../inquiry/fcl-presentation.ts';
import {fclRateDatasetSchema} from '../../services/quote-native/fcl-contracts.ts';
import {FCL_RATE_DATASET_V2} from '../../services/quote-native/fcl-operations-contracts.ts';
import {FCL_CONTAINER_TYPES as types} from '../inquiry/fcl-model.ts';

const clone=value=>structuredClone(value);
const emptyCapacity={weight_min_kg:null,weight_max_kg:null,volume_min_cbm:null,volume_max_cbm:null};
const emptyWindow={valid_from:'',valid_until:''};
const sectionNames={compare:'报价',rates:'海运费表',charges:'基础费用库',history:'历史报价',delivery_rates:'内陆运价',templates:'费用模板',rate_details:'手工维护船期'};
const businessTabs=['compare','rates','templates','history'];
export {isBaseOceanFreight} from '../../services/quote-native/fcl-fee-identity.ts';
export function fclMaintenancePayload(dataset){
  const next=clone(dataset);
  const stripWindow=record=>{
    if(!record)return;
    record.valid_from=null;
    record.valid_until=null;
    delete record.updated_at;
  };
  (next?.rates||[]).forEach(stripWindow);
  (next?.operations?.charges||[]).forEach(stripWindow);
  (next?.operations?.templates||[]).forEach(stripWindow);
  return next;
}

export function sortFclEstimates(items,key,direction='asc'){
  const value=item=>{const c=item.calculation;if(key==='carrier')return c.carrier;if(key==='etd')return c.schedule?.etd??null;if(key==='transit_days')return c.schedule?.transit_days??null;if(key==='ocean')return c.lines.find(l=>l.category==='ocean')?.cost_amount??null;return c.totals[key];};
  return [...items].sort((a,b)=>{
    const left=value(a),right=value(b);if(left===null||left===undefined)return right==null?0:1;if(right===null||right===undefined)return -1;
    if(key==='ocean'){const ac=a.calculation.lines.find(l=>l.category==='ocean')?.currency,bc=b.calculation.lines.find(l=>l.category==='ocean')?.currency;if(ac!==bc)return String(ac).localeCompare(String(bc));}
    const order=['carrier','etd'].includes(key)?String(left).localeCompare(String(right)):new Decimal(left).comparedTo(right);
    return direction==='desc'?-order:order;
  });
}

export function referenceChargeGroup(charge){
  const remark=String(charge?.remark||''),name=String(charge?.name_zh||''),source=String(charge?.source_ref||'');
  const match=/^参考方案：([^；]+)；/u.exec(remark);
  const group=match?.[1]?.trim();
  if(!group||!source.startsWith('xlsx:')||!name.endsWith(` · ${group}`))return null;
  return group;
}

export function groupReferenceCharges(charges){
  const groups=new Map();
  charges.forEach((charge,index)=>{
    const name=referenceChargeGroup(charge);
    if(!name)return;
    const group=groups.get(name)??[];
    group.push({charge,index});
    groups.set(name,group);
  });
  return [...groups].map(([name,entries])=>({name,entries}));
}

export function fclTemplateChargeImpacts({templates=[],delivery_rates=[]},chargeId,currentTemplateId=null,currentTemplateVersion=null){
  const excludesCurrent=template=>template.id!==currentTemplateId||(currentTemplateVersion!==null&&template.version!==currentTemplateVersion);
  const direct=templates.filter(template=>excludesCurrent(template)&&template.charge_ids.includes(chargeId)).map(template=>template.label);
  const deliveryIds=new Set(delivery_rates.filter(rate=>rate.surcharge_ids.includes(chargeId)).map(rate=>rate.id));
  const indirect=templates.filter(template=>excludesCurrent(template)&&template.delivery_rate_id!==null&&deliveryIds.has(template.delivery_rate_id)).map(template=>template.label);
  return [...new Set([...direct,...indirect])];
}

export function createFclOperations({call:readRequest,write:writeRequest,esc,rerender,notify,model,api}){
  let generation=0,loading=false,loaded=false,contextId='',view=null,draft=null,items=[],caseView=null,caseList=[],section='compare',editor=null,dirty=false,publication=null,batch=null,batchPreview=null,message='',sort='cost_total',direction='asc',destination='',history=null,historyRows=[];
  let templatePrimary='',templateId='',templateIndex=-1,referencePlan='',templateEditor=null,templateIssues=[],templateSharedConfirmation=false,templateMoreOpen=false,templateOpenCharge=null,templatePreviewFailed=false;
  let routePod='',routeDestination='',entrySection='',advanced=false,feeSearch='',rateFilter={pol:'',pod:'',carrier:''};
  const emptyQuery=()=>({shipping_date:'',pol:'',rate_ids:[],template_ids:[],containers:[{type:'40HQ',quantity:1,unit:'CNTR'}],weight_kg:null,volume_cbm:null,postal_code:null,zone:null,case_ref:null});
  const emptyCasePicker=()=>({open:false,loading:false,loaded:false,cursor:null,error:''});
  let query=emptyQuery(),casePicker=emptyCasePicker(),historyLoad={loaded:false,loading:false,error:''},historyRequest=0;
  const invalidateHistory=()=>{historyRequest++;historyLoad={loaded:false,loading:false,error:''};};
  const guarded=fn=>async(...args)=>{const token=generation;const result=await fn(...args);if(token!==generation)throw Object.assign(new Error('fcl_request_superseded'),{code:'fcl_request_superseded'});return result;};
  const call=guarded(readRequest),write=guarded(writeRequest);
  const reset=()=>{schedules.reset();oceanCurrencies.clear();section='compare';entrySection='';advanced=false;feeSearch='';rateFilter={pol:'',pod:'',carrier:''};routePod='';routeDestination='';generation++;loading=false;loaded=false;contextId='';view=null;draft=null;items=[];caseView=null;caseList=[];casePicker=emptyCasePicker();query=emptyQuery();destination='';sort='cost_total';direction='asc';invalidateHistory();editor=null;dirty=false;publication=null;batch=null;batchPreview=null;history=null;historyRows=[];message='';templatePrimary='';templateId='';templateIndex=-1;referencePlan='';templateEditor=null;templateIssues=[];templateSharedConfirmation=false;templateMoreOpen=false;templateOpenCharge=null;templatePreviewFailed=false;};
  const requireData=response=>{if(!response.data||!['success','needs_input','manual_review'].includes(response.status))throw Object.assign(new Error(response.reason_codes?.[0]||'fcl_unavailable'),{code:response.reason_codes?.[0]||'fcl_unavailable'});return response.data;};
  const emptyOperations={rate_details:[],charges:[],delivery_rates:[],templates:[]};
  const publishedDataset=()=>view?.active_release?.input.contract_version===FCL_RATE_DATASET_V2?view.active_release.input:null;
  const publishedOptions=()=>publishedDataset()?.operations??emptyOperations;
  const draftOptions=()=>draft?.operations??emptyOperations;
  const normalizeTemplateSelection=()=>{
    if(templateEditor?.isNew&&templateEditor.kind==='template')return -1;
    const templates=draftOptions().templates;
    if(templateIndex>=0&&templates[templateIndex]?.id===templateId)return templateIndex;
    templateIndex=templateId?templates.findIndex(template=>template.id===templateId):-1;
    if(templateIndex<0){templateIndex=templates.length?0:-1;templateId=templates[0]?.id||'';}
    return templateIndex;
  };
  const updatedAt=row=>row?.updated_at||null;
  const currentDate=()=>model().session?.fcl_capability?.business_date||'';
  const load=async(id='',force=false)=>{
    if(id!==contextId){generation++;contextId=id;loaded=false;loading=false;view=null;draft=null;editor=null;history=null;historyRows=[];caseView=null;items=[];caseList=[];casePicker=emptyCasePicker();query=emptyQuery();routePod='';routeDestination='';destination='';invalidateHistory();}
    if(loading||loaded&&!force)return;
    loading=true;const token=generation;
    try{
      const results=await Promise.all([call('rate-get',{},'GET'),...(id?[call('case-get',{case_id:id})]:[])]);
      if(token!==generation)return;
      view=requireData(results[0]);draft=clone(view.draft||view.active_release?.input||{contract_version:FCL_RATE_DATASET_V2,label:'整柜海运费表',rates:[],operations:{rate_details:[],charges:[],delivery_rates:[],templates:[]}});
      if(draft.contract_version!==FCL_RATE_DATASET_V2)draft={...draft,contract_version:FCL_RATE_DATASET_V2,operations:{rate_details:[],charges:[],delivery_rates:[],templates:[]}};
      normalizeTemplateSelection();
      const referenceGroups=groupReferenceCharges(draftOptions().charges);
      if(!['reference','templates'].includes(templatePrimary))templatePrimary=draftOptions().templates.length?'templates':'reference';
      if(!referenceGroups.some(group=>group.name===referencePlan))referencePlan=referenceGroups[0]?.name||'';
      templateEditor=null;templateIssues=[];templateSharedConfirmation=false;templateMoreOpen=false;templateOpenCharge=null;templatePreviewFailed=false;
      caseView=id?requireData(results[1]):null;
      if(caseView){const c=caseView.current_input;routePod=c.pod||'';routeDestination=c.final_destination||'';query={...query,case_ref:id,pol:c.pol||'',shipping_date:c.cargo_ready_date||'',containers:c.containers.filter(b=>b.quantity!==null).map(b=>({...b,unit:'CNTR'})),weight_kg:c.estimated_weight?.value||null,template_ids:[]};}
      else query={...query,case_ref:null,shipping_date:query.shipping_date||currentDate()};
      loaded=true;dirty=false;message='';
    }catch(error){if(token===generation){loaded=true;message=fclIssue(error.code||error.message);}}
    finally{if(token===generation){loading=false;rerender();}}
  };
  const loadHistory=async(force=false)=>{
    if(historyLoad.loading||historyLoad.loaded&&!force)return;
    const token=generation,request=++historyRequest;
    historyLoad.loading=true;historyLoad.error='';
    try{
      const data=requireData(await call('estimate-list',{case_ref:contextId||null,destination:null,shipping_date:null}));
      if(request===historyRequest){items=data.items;historyLoad.loaded=true;}
    }catch(error){if(token===generation&&request===historyRequest){historyLoad.loaded=true;historyLoad.error=fclError(error);}}
    finally{if(token===generation&&request===historyRequest){historyLoad.loading=false;rerender();}}
  };
  const loadCases=async(more=false)=>{
    if(contextId||casePicker.loading||more&&!casePicker.cursor||!more&&casePicker.loaded)return;
    const token=generation;
    casePicker.loading=true;casePicker.error='';rerender();
    try{
      const search=new URLSearchParams({limit:'50',...(more?{cursor:casePicker.cursor}:{})});
      const data=requireData(await call('case-list',null,'GET',`?${search}`));
      const rows=data.items.filter(c=>!['closed','cancelled'].includes(c.case_status));
      caseList=[...new Map([...(more?caseList:[]),...rows].map(row=>[row.case_id,row])).values()];
      casePicker.loaded=true;casePicker.cursor=data.next_cursor;
    }catch(error){if(token===generation)casePicker.error=fclError(error);}
    finally{if(token===generation){casePicker.loading=false;rerender();}}
  };
  const monetaryKey=key=>['amount','sell_amount','base_rate'].includes(key)||key.startsWith('tier-amount-');
  const input=(key,value,attrs='',label=key)=>`<label class="field">${fclFieldHtml(label)}<input name="${key}" value="${esc(monetaryKey(key)?displayAmount(value,''):value??'')}" ${attrs}></label>`;
  const select=(key,value,entries,attrs='',label=key)=>`<label class="field">${fclFieldHtml(label)}<select name="${key}" ${attrs}>${entries.map(([v,title])=>`<option value="${esc(v)}"${v===value?' selected':''}>${esc(title)}</option>`).join('')}</select></label>`;
  const boxes=(selected,name='container_types')=>`<fieldset class="ops-inline-checks"><legend>${fclField('container_types')}</legend>${types.map(t=>`<label><input type="checkbox" name="${name}" value="${t}"${selected.includes(t)?' checked':''}>${t}</label>`).join('')}</fieldset>`;
  const many=(key,selected,entries)=>`<fieldset class="ops-check-list"><legend>${fclField(key)}</legend>${entries.length?entries.map(([v,title])=>`<label><input type="checkbox" name="${key}" value="${esc(v)}"${selected.includes(v)?' checked':''}>${esc(title)}</label>`).join(''):'<p class="muted">暂无可选项目，请先维护相应费用。</p>'}</fieldset>`;
  const errorBox='<div class="form-error" hidden></div>';
  const btn=(action,text,attrs='')=>`<button type="button" class="button" data-action="ops-${action}" ${attrs}>${text}</button>`;
  const notifyState=()=>message?`<p class="ops-message" role="status">${esc(message)}</p>`:'';
  const fclError=error=>fclIssue(error?.code||error?.message||'fcl_unavailable');
  const refresh=async()=>{invalidateHistory();if(section==='compare'||section==='history')await loadHistory();else items=[];};
  const caseSelector=()=>{
    if(contextId)return `<a class="button" href="#fcl/case/${esc(contextId)}">返回本票</a>`;
    if(!casePicker.open)return btn('cases-open','关联询价');
    return select('case_ref',query.case_ref||'',[['','选择关联询价后生成客户报价'],...caseList.map(c=>[c.case_id,`${c.inquiry_no} · ${c.current_input.final_destination||''}`])])+
      (casePicker.loading?'<span role="status">正在读取询价…</span>':casePicker.cursor?btn('cases-more','加载更多询价'):!casePicker.loaded?btn('cases-open','重试读取询价'):'')+
      (casePicker.error?`<span role="status">${esc(casePicker.error)}</span>`:'');
  };
  const categoryName=key=>fclField(({ocean:'ocean_freight',origin:'origin_charges',destination:'destination_charges',inland:'inland_delivery',customs:'customs',risk:'risk',other:'other'})[key]);
  const amount=(value,currency='CNY')=>value===null||value===undefined?'—':`${esc(displayAmount(value))} <small>${currency}</small>`;
  const breakdown=estimate=>`<details class="ops-breakdown"><summary>查看计算明细</summary><p>报价第 ${estimate.version} 版 · 来源发布 ${esc(estimate.source_release_id)}</p><div class="table-wrap"><table><thead><tr>${['name_zh','quantity','cost_price','sell_price','currency'].map(k=>`<th>${fclFieldHtml(k)}</th>`).join('')}</tr></thead><tbody>${estimate.calculation.lines.map(l=>`<tr><td><strong>${esc(l.name_zh)}</strong><small>${esc(l.name_en)}</small></td><td>${esc(l.quantity)} ${l.unit==='CNTR'?'柜':'票'}</td><td>${esc(displayAmount(l.cost_price))}</td><td>${esc(displayAmount(l.sell_price))}</td><td>${l.currency}</td></tr>`).join('')}</tbody></table></div><details><summary>来源与计算记录</summary><dl class="ops-source-list">${estimate.calculation.source_refs.map(r=>`<div><dt>${esc(r.ref)}</dt><dd>${esc(r.version)}</dd></div>`).join('')}</dl><p>${fclField('exchange_rates')}：USD ${esc(estimate.calculation.exchange_rates.USD??'待填')} / CAD ${esc(estimate.calculation.exchange_rates.CAD??'待填')}</p><ul>${estimate.calculation.calculation_trace.map(t=>`<li>${esc(t.detail)}</li>`).join('')}</ul></details>${estimate.adjustments.length?`<details><summary>人工调整记录</summary><ul>${estimate.adjustments.map(a=>`<li>${esc(displayAmount(a.original_amount))} → ${esc(displayAmount(a.adjusted_amount))} · ${esc(a.reason)} · ${esc(a.actor===model().session?.identity?.user_id?'本人':a.actor)} · ${esc(a.modified_at)}</li>`).join('')}</ul></details>`:''}</details>`;
  const card=estimate=>{
    const c=estimate.calculation,selected=estimate.recommended;const grouped=category=>c.breakdown.filter(r=>r.category===category).map(r=>`${displayAmount(r.amount)} ${r.currency}`).join(' + ')||'—';
    return `<article class="ops-quote-card${selected?' is-recommended':''}"><header><div><small>${fclField('carrier')}</small><h2>${esc(c.carrier)}</h2></div><span class="badge${estimate.currentness.valid_now?'':' warning'}">${estimate.currentness.valid_now?'系统预估':estimate.currentness.reason_codes.includes('fcl_estimate_expired')?'需重新核对':'待复核'}</span></header><p class="ops-route">${esc(c.pol)} → ${esc(c.pod)} → <strong>${esc(c.destination)}</strong></p><div class="ops-card-meta"><span>${esc(estimate.request.containers.map(b=>`${b.type} × ${b.quantity}`).join(' / '))}</span><span>${fclField('shipping_date')} ${esc(estimate.request.shipping_date)}</span><span>船名 / 航次 ${esc(c.schedule?.vessel||'待确认')} / ${esc(c.schedule?.voyage||'待确认')}</span><span>${fclField('eta')} ${esc(c.schedule?.eta||'待确认')}</span><span>${fclField('etd')} ${esc(c.schedule?.etd||'待确认')}</span><span>${fclField('transit_days')} ${esc(c.schedule?.transit_days??'—')}</span></div><dl class="ops-cost-summary">${[['ocean','ocean_freight'],['origin','origin_charges'],['destination','destination_charges'],['customs','customs'],['inland','inland_delivery'],['other','other'],['risk','risk']].map(([category,key])=>`<div><dt>${fclFieldHtml(key)}</dt><dd>${esc(grouped(category))}</dd></div>`).join('')}</dl><div class="ops-totals"><div><span>${fclFieldHtml('total_cost')}</span><strong>${amount(c.totals.cost_total)}</strong></div><div><span>${fclFieldHtml('sell_price')}</span><strong>${amount(c.totals.sell_total)}</strong></div><div class="ops-profit"><span>${fclFieldHtml('gross_profit')}</span><strong>${amount(c.totals.gross_profit)}</strong><small>${fclField('gross_margin')} ${displayMargin(c.totals.gross_margin)}</small></div></div><div class="ops-card-meta"><span>${estimate.locked?'已锁定':selected?'推荐方案':'历史版本'}</span></div>${c.blockers.length||!estimate.currentness.valid_now?`<p class="ops-blockers">${[...c.blockers,...estimate.currentness.reason_codes].map(x=>esc(fclIssue(x))).join(' · ')}</p>`:''}${breakdown(estimate)}<footer>${btn('select','选用此方案',`data-id="${estimate.estimate_id}"${estimate.currentness.valid_now?'':' disabled'}` )}${btn('duplicate','复制方案',`data-id="${estimate.estimate_id}"`)}${btn('adjust','调整 / 锁定',`data-id="${estimate.estimate_id}"`)}${btn('history','历史版本',`data-id="${estimate.estimate_id}"`)}</footer></article>`;
  };
  const matchingTemplates=()=>publishedOptions().templates.filter(t=>t.enabled&&(!routePod||t.pod===routePod)&&(!routeDestination||t.destination===routeDestination));
  const matchingRates=()=>(publishedDataset()?.rates||[]).filter(r=>(!query.pol||r.pol===query.pol)&&(!routePod||r.pod===routePod));
  const queryForm=()=>{
    const templates=matchingTemplates();
    const noPublished=!publishedDataset()||!matchingTemplates().length;
    return `<form data-fcl-form="ops-run" class="ops-query panel ops-daily-sheet">${errorBox}<div class="ops-flow-steps" aria-label="报价流程"><span aria-current="step">1 套模板</span><span>2 改本票</span><span>3 出报价</span></div><h2>选择海运费和费用模板</h2>${caseView?`<p class="muted">已带入 ${esc(caseView.inquiry_no)} 的客户需求</p>`:''}<div class="ops-query-grid"><div>${input('pol',query.pol,'required')}</div><div>${input('pod',routePod,'required list="ops-pods"')}</div><div>${input('destination',routeDestination,'required list="ops-destinations"')}</div><div>${input('shipping_date',query.shipping_date,'type="date" required')}</div><div>${select('selected_rate',query.rate_ids[0]||'',[['','请选择一条已发布海运费'],...matchingRates().map(r=>[r.rate_id,`${r.supplier_label} · ${r.pol} → ${r.pod}`])])}</div><div>${select('template',query.template_ids.length===1?query.template_ids[0]:'',[['','请选择一套费用模板'],...templates.map(t=>[t.id,t.label])])}</div></div><datalist id="ops-pods">${[...new Set((publishedDataset()?.rates||[]).map(r=>r.pod))].map(v=>`<option value="${esc(v)}">`).join('')}</datalist><datalist id="ops-destinations">${[...new Set(publishedOptions().templates.map(t=>t.destination))].map(v=>`<option value="${esc(v)}">`).join('')}</datalist><div class="ops-query-bottom"><div class="ops-quantities">${types.map(type=>`<label>${type}<input aria-label="${type}柜数" name="box-${type}" type="number" min="0" max="1000" value="${query.containers.find(c=>c.type===type)?.quantity||''}"></label>`).join('')}</div><div class="head-actions">${btn('tab','模板维护','data-tab="templates"')}<button class="button primary" type="submit"${noPublished?' disabled':''}>套用模板</button></div></div><details class="ops-query-advanced"><summary>其他条件</summary><div class="field-grid">${input('weight_kg',query.weight_kg,'inputmode="decimal"')}${input('volume_cbm',query.volume_cbm,'inputmode="decimal"')}${input('postal_code',query.postal_code)}${input('zone',query.zone)}</div></details>${noPublished?'<p class="inline-note warning">当前没有可用的已发布费用模板，请先完成模板维护。</p>':''}</form>`;
  };
  const matchesQuery=item=>{
    if(!query.pol)return true;
    const r=item.request,decimalEqual=(a,b)=>a===null||b===null?a===b:new Decimal(a).equals(b);
    return (!routePod||item.calculation.pod===routePod)&&(!routeDestination||item.calculation.destination===routeDestination)&&(!query.rate_ids.length||query.rate_ids.includes(item.calculation.rate_id))&&r.pol===query.pol&&r.shipping_date===query.shipping_date&&decimalEqual(r.weight_kg,query.weight_kg)&&decimalEqual(r.volume_cbm,query.volume_cbm)&&r.postal_code===query.postal_code&&r.zone===query.zone&&r.containers.length===query.containers.length&&r.containers.every(box=>query.containers.some(q=>q.type===box.type&&q.quantity===box.quantity))&&(!query.template_ids.length||query.template_ids.includes(item.calculation.template_id));
  };
  const compare=()=>`${section==='history'?'':queryForm()+schedules.render()}<h2 class="ops-result-title">${section==='history'?'历史报价':'报价结果'}</h2>${historyLoad.loading?'<p role="status">正在读取历史报价…</p>':historyLoad.error?`<p role="status">${esc(historyLoad.error)} ${btn('history-retry','重试读取历史')}</p>`:''}<div class="ops-toolbar">${select('sort',sort,[['cost_total',fclField('total_cost')],['ocean',fclField('ocean_freight')+'（同币种）'],['transit_days',fclField('transit_days')],['gross_profit',fclField('gross_profit')],['etd',fclField('etd')],['carrier',fclField('carrier')]])}${select('direction',direction,[['asc','从低到高 / 从早到晚'],['desc','从高到低 / 从晚到早']])}${select('destination',destination,[['','全部目的地'],...[...new Set(items.map(i=>i.calculation.destination))].map(x=>[x,x])])}${caseSelector()}</div>${history?`<section class="panel ops-history"><header><h2>历史报价 v${history.version} / ${history.current_version}</h2><div>${history.version>1?btn('history','上一版',`data-id="${history.estimate_id}" data-version="${history.version-1}"`):''}${history.version<history.current_version?btn('history','下一版',`data-id="${history.estimate_id}" data-version="${history.version+1}"`):''}</div>${btn('close-history','收起')}</header><p>${esc(history.calculation.carrier)} · ${esc(history.calculation.destination)} · ${esc(history.created_at)}</p><div class="ops-card-meta">${history.calculation.lines.filter(l=>l.code==='ocean_freight').map(l=>`${l.container_type}: ${l.cost_price} ${l.currency}`).join(' · ')}</div>${breakdown(history)}<details open><summary>${fclField('price_trend')} · 本版及之前最多 12 版</summary><div class="table-wrap ops-trend"><table><thead><tr>${['version','generated_at','ocean_freight','total_cost','sell_price'].map(k=>`<th>${fclFieldHtml(k)}</th>`).join('')}</tr></thead><tbody>${historyRows.map(row=>`<tr><td>v${row.version}</td><td>${esc(row.created_at)}</td><td>${row.calculation.lines.filter(l=>l.code==='ocean_freight').map(l=>`${l.container_type}: ${esc(displayAmount(l.cost_price))} ${l.currency}`).join(' / ')}</td><td>${amount(row.calculation.totals.cost_total)}</td><td>${amount(row.calculation.totals.sell_total)}</td></tr>`).join('')}</tbody></table></div></details><p>${fclField('total_cost')} ${amount(history.calculation.totals.cost_total)} · ${fclField('sell_price')} ${amount(history.calculation.totals.sell_total)}</p></section>`:''}<div class="ops-comparison">${sortFclEstimates(items.filter(i=>(!destination||i.calculation.destination===destination)&&(section==='history'||matchesQuery(i))&&(!contextId||((i.request.case_ref===null||i.request.case_ref===contextId)&&i.calculation.destination===caseView?.current_input.final_destination))),sort,direction).map(card).join('')||'<div class="panel empty-state"><h2>选择路线与目的地，生成预估方案</h2><p>填写线路并选择已发布海运费后计算。若线路尚未维护费用方案，可在高级设置补充，或从客户询价中填写单票报价。</p></div>'}</div>`;
  const newRecord=kind=>{
    const id=crypto.randomUUID();const base={id,version:1};
    if(kind==='charges')return {...base,code:`fee_${id}`,name_zh:'',name_en:'',category:'other',amount:'',currency:'CAD',unit:'SHIPMENT',container_types:query.containers.map(c=>c.type),sell_amount:null,editable:true,country:'CA',pod:null,destination:null,source_ref:'',source_version:'v1',remark:null};
    if(kind==='delivery_rates')return {...base,...emptyWindow,origin:'',destination:'',country:'CA',postal_codes:[],zones:[],service_mode:'container_drayage',container_types:['40HQ'],...emptyCapacity,base_rate:'',currency:'CAD',unit:'CNTR',tiers:[],surcharge_ids:[],source_ref:'',source_version:'v1',remark:null};
    if(kind==='templates')return {...base,label:'',country:'CA',pod:'',destination:'',routing:'',service_mode:'rail_truck',customs_mode:'',container_types:['40HQ'],...emptyCapacity,charge_ids:[],delivery_rate_id:null,margin_rule:{mode:'cost_markup',value:''},exchange_rates:{USD:null,CAD:null},fx_source:'',enabled:true};
    return {rate_id:draft.rates[0]?.rate_id||'',carrier:'',routing:'',vessel:null,voyage:null,etd:null,eta:null,transit_days:null};
  };
  const chargeList=()=>{
    const records=draftOptions().charges,needle=feeSearch.trim().toLocaleLowerCase();
    const rows=records.map((r,index)=>({r,index})).filter(({r})=>!isBaseOceanFreight(r)).filter(({r})=>[r.name_zh,r.name_en,r.code,r.destination,r.pod,...r.container_types].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle));
    return `<section class="ops-charges"><div class="ops-toolbar ops-charge-toolbar"><h2>基础费用</h2><form data-fcl-form="ops-fee-search" role="search">${errorBox}<input type="search" name="fee_search" aria-label="搜索费用" placeholder="费用名称、目的地或柜型" value="${esc(feeSearch)}"${editor?' disabled':''}><button class="button" type="submit"${editor?' disabled':''}>筛选</button></form><span class="muted">${rows.length} / ${records.length} 项</span>${btn('new','新增费用','data-kind="charges"')}</div><div class="table-wrap panel"><table class="ops-charge-table"><thead><tr><th>费用名称</th><th>成本</th><th>售价</th><th>计费 / 适用</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows.map(({r,index})=>`<tr><td><strong>${esc(r.name_zh)}</strong><small>${esc(r.name_en)}</small></td><td class="ops-money">${amount(r.amount,r.currency)}</td><td class="ops-money">${amount(r.sell_amount,r.currency)}</td><td>${r.unit==='CNTR'?'按柜':r.unit==='SHIPMENT'?'按票':'固定金额'} · ${esc(r.container_types.join(' / '))}<small>${esc([r.pod,r.destination].filter(Boolean).join(' → ')||'未限定地点')}</small></td><td class="ops-validity">${esc(updatedLabel(r))}</td><td class="ops-row-actions">${btn('edit','编辑',`data-index="${index}" data-kind="charges"`)}${btn('copy-record','复制',`data-index="${index}" data-kind="charges"`)}</td></tr>`).join('')||`<tr><td colspan="6" class="muted">${records.length?'没有匹配的费用，请更换关键词。':'暂无基础费用，点击“新增费用”开始填写。'}</td></tr>`}</tbody></table></div></section>`;
  };
  const recordList=()=>{
    if(section==='charges')return chargeList();
    const records=draftOptions()[section];
    return `<div class="ops-toolbar"><h2>${sectionNames[section]}</h2>${btn('new','新增',`data-kind="${section}"`)}<span class="muted">${records.length} 项</span></div><div class="table-wrap panel"><table><thead><tr><th>项目</th><th>${fclFieldHtml('validity')}</th><th>价格 / 路线</th><th>${fclFieldHtml('version')}</th><th>操作</th></tr></thead><tbody>${records.map((r,index)=>`<tr><td><strong>${esc(r.name_zh||r.label||r.carrier||`${r.origin} → ${r.destination}`)}</strong><small>${esc(r.name_en||r.code||'')}</small></td><td>${esc(r.valid_from||r.etd||'—')} → ${esc(r.valid_until||r.eta||'—')}</td><td>${esc(r.amount!==undefined?`${displayAmount(r.amount)} ${r.currency}`:r.base_rate!==undefined?`${displayAmount(r.base_rate)} ${r.currency}`:r.routing||'—')}</td><td>${r.version||'—'}</td><td>${btn('edit','编辑',`data-index="${index}" data-kind="${section}"`)}${section!=='rate_details'?btn('copy-record','复制',`data-index="${index}" data-kind="${section}"`)+btn('next-version','新有效期',`data-index="${index}" data-kind="${section}"`):''}</td></tr>`).join('')}</tbody></table></div>`;
  };
  const chargeCandidates=chargeId=>draftOptions().charges.map((charge,index)=>({charge,index})).filter(item=>item.charge.id===chargeId);
  const templateChargeRows=chargeIds=>chargeIds.map(chargeId=>{
    const candidates=chargeCandidates(chargeId),selected=candidates.length===1?candidates[0]:null;
    return {chargeId,selectedIndex:selected?.index??null,original:selected?clone(selected.charge):null,value:selected?clone(selected.charge):null,candidates};
  }).filter(row=>row.candidates.some(candidate=>!isBaseOceanFreight(candidate.charge)));
  const createTemplateEditor=(index)=>{
    const template=draftOptions().templates[index];
    if(!template)return null;
    const chargeIds=template.charge_ids;
    return {kind:'template',index,id:template.id,isNew:false,base:clone(template),value:{...clone(template),charge_ids:chargeIds},marginPercent:new Decimal(template.margin_rule.value).mul(100).toString(),marginPercentInvalid:false,charges:templateChargeRows(chargeIds)};
  };
  const createReferenceEditor=(name)=>{
    const group=groupReferenceCharges(draftOptions().charges).find(row=>row.name===name);
    if(!group)return null;
    return {kind:'reference',id:name,isNew:false,base:null,value:{label:name},charges:group.entries.filter(entry=>!isBaseOceanFreight(entry.charge)).map(entry=>({chargeId:entry.charge.id,selectedIndex:entry.index,original:clone(entry.charge),value:clone(entry.charge),candidates:[entry]}))};
  };
  const createTemplateFromReference=()=>{
    const editor=templateEditor?.kind==='reference'?templateEditor:createReferenceEditor(referencePlan);
    if(!editor)return null;
    const rows=editor.charges.filter(row=>row.value&&!isBaseOceanFreight(row.value));
    const charges=rows.flatMap(row=>row.value?[row.value]:[]);
    const countries=[...new Set(charges.map(charge=>charge.country).filter(Boolean))];
    const destinations=[...new Set(charges.map(charge=>charge.destination).filter(Boolean))];
    const containers=[...new Set(charges.flatMap(charge=>charge.container_types))];
    const id=`template-${crypto.randomUUID()}`;
    return {kind:'template',index:null,id,isNew:true,base:null,marginPercent:'',marginPercentInvalid:false,value:{id,version:1,label:editor.id,country:countries.length===1?countries[0]:'',pod:'',destination:destinations.length===1?destinations[0]:'',routing:'',service_mode:'',customs_mode:'',container_types:containers,weight_min_kg:null,weight_max_kg:null,volume_min_cbm:null,volume_max_cbm:null,charge_ids:[...new Set(charges.map(charge=>charge.id))],delivery_rate_id:null,margin_rule:{mode:'',value:''},exchange_rates:{USD:null,CAD:null},fx_source:'',enabled:false},charges:rows.map(row=>({...row,original:row.original?clone(row.original):null,value:row.value?clone(row.value):null,candidates:row.candidates.map(candidate=>({...candidate,charge:clone(candidate.charge)}))}))};
  };
  const ensureTemplateEditor=()=>{
    if(templateEditor)return templateEditor;
    templateEditor=templatePrimary==='reference'?createReferenceEditor(referencePlan):createTemplateEditor(normalizeTemplateSelection());
    return templateEditor;
  };
  const templateEditorDirty=()=>{
    if(!templateEditor)return false;
    if(templateEditor.kind==='template')return templateEditor.isNew||JSON.stringify(templateEditor.base)!==JSON.stringify(templateEditor.value)||templateEditor.charges.some(row=>JSON.stringify(row.original)!==JSON.stringify(row.value));
    return templateEditor.charges.some(row=>JSON.stringify(row.original)!==JSON.stringify(row.value));
  };
  const chargeDisplayName=(row,groupName=null)=>{
    const name=row.value?.name_zh||row.original?.name_zh||row.candidates?.[0]?.charge?.name_zh||'';
    return groupName&&name.endsWith(` · ${groupName}`)?name.slice(0,-` · ${groupName}`.length):name;
  };
  const templateImpactRows=()=>{
    if(!templateEditor)return [];
    const currentId=templateEditor.kind==='template'&&!templateEditor.isNew?templateEditor.id:null;
    const currentVersion=templateEditor.kind==='template'&&!templateEditor.isNew?templateEditor.value.version:null;
    return templateEditor.charges.flatMap(row=>{
      const names=fclTemplateChargeImpacts(draftOptions(),row.chargeId,currentId,currentVersion);
      return names.length?[{row,names}]:[];
    });
  };
  const templateChangedImpactRows=()=>templateImpactRows().filter(({row})=>JSON.stringify(row.original)!==JSON.stringify(row.value));
  const setFormValue=(form,name,apply)=>{const input=form?.querySelector(`[name="${name}"]`);if(input)apply(input);};
  const templateEditorSnapshot=()=>templateEditor?JSON.stringify({value:templateEditor.value,marginPercent:templateEditor.marginPercent,marginPercentInvalid:templateEditor.marginPercentInvalid,charges:templateEditor.charges.map(row=>({selectedIndex:row.selectedIndex,value:row.value}))}):'';
  const invalidateTemplatePublication=()=>{
    if(!publication&&!templatePreviewFailed)return;
    publication=null;templatePreviewFailed=false;
    if(typeof document!=='undefined')document.querySelector('.ops-template-publication')?.remove();
  };
  const captureTemplateEditor=form=>{
    if(!templateEditor||!form)return false;
    const before=templateEditorSnapshot();
    const data=new FormData(form);
    if(templateEditor.kind==='template'){
      const set=(name,apply)=>setFormValue(form,`template.${name}`,input=>apply(input.value));
      for(const name of ['label','country','pod','destination','routing','service_mode','customs_mode','fx_source'])set(name,value=>{templateEditor.value[name]=value;});
      set('margin_mode',value=>{templateEditor.value.margin_rule.mode=value;});
      setFormValue(form,'template.margin_percent',input=>{
        templateEditor.marginPercent=input.value.trim();
        try{templateEditor.value.margin_rule.value=templateEditor.marginPercent?new Decimal(templateEditor.marginPercent).div(100).toString():'';templateEditor.marginPercentInvalid=false;}
        catch{templateEditor.marginPercentInvalid=true;}
      });
      set('USD',value=>{templateEditor.value.exchange_rates.USD=value||null;});
      set('CAD',value=>{templateEditor.value.exchange_rates.CAD=value||null;});
      set('delivery_rate_id',value=>{templateEditor.value.delivery_rate_id=value||null;});
      setFormValue(form,'template.enabled',input=>{templateEditor.value.enabled=input.checked;});
      templateEditor.value.container_types=data.getAll('template.container_types').map(String);
    }
    templateEditor.charges.forEach((row,index)=>{
      const root=form.querySelector(`[data-template-charge="${index}"]`),settings=form.querySelector(`[data-template-charge-settings="${index}"]`);
      setFormValue(root,`charges.${index}.selected`,input=>{if(input.value==='')return;const next=Number(input.value),candidate=row.candidates.find(item=>item.index===next);if(candidate&&next!==row.selectedIndex){row.selectedIndex=candidate.index;row.original=clone(candidate.charge);row.value=clone(candidate.charge);}});
      if(!row.value)return;
      const apply=(name,applyValue)=>setFormValue(root,`charges.${index}.${name}`,input=>applyValue(input.value));
      apply('name_zh',value=>{const name=value.trim();row.value.name_zh=templateEditor.kind==='reference'?`${name} · ${templateEditor.id}`:name;if(row.isNew)row.value.name_en=name;});
      apply('amount',value=>{row.value.amount=readAmountInput(value,row.value.amount)??'';});
      apply('sell_amount',value=>{row.value.sell_amount=readAmountInput(value,row.value.sell_amount);});
      apply('currency',value=>{row.value.currency=value;});
      apply('unit',value=>{row.value.unit=value;});
      for(const name of ['name_zh','name_en','code','country','category','pod','destination','source_ref','source_version','remark'])setFormValue(settings,`charges.${index}.${name}`,input=>{
        const value=input.value.trim();
        if(name==='name_zh'&&templateEditor.kind==='reference'&&value&&!value.endsWith(` · ${templateEditor.id}`)){row.value.name_zh=`${value} · ${templateEditor.id}`;return;}
        row.value[name]=['pod','destination','remark'].includes(name)?(value||null):value;
      });
      if(row.isNew&&!row.value.name_en)row.value.name_en=row.value.name_zh;
      if(settings){row.value.container_types=[...settings.querySelectorAll(`[name="charges.${index}.container_types"]:checked`)].map(input=>input.value);row.value.editable=settings.querySelector(`[name="charges.${index}.editable"]`)?.checked??false;}
    });
    return before!==templateEditorSnapshot();
  };
  const templateSchemaIssue=issue=>{
    const path=Array.isArray(issue.path)?issue.path:[];
    const lastString=[...path].reverse().find(part=>typeof part==='string'&&!['operations','templates','charges'].includes(part));
    const fieldLabel=key=>key==='margin_value'||(path.includes('margin_rule')&&key==='value')?'利润百分比':key==='USD'||key==='CAD'?`${key} 汇率`:FCL_FIELDS[key]?.zh||'金额或适用条件';
    if(path[0]==='operations'&&path[1]==='charges'&&typeof path[2]==='number'){
      const newRows=templateEditor.charges.filter(row=>row.isNew);
      const rowIndex=templateEditor.charges.findIndex(row=>row.selectedIndex===path[2]||row.chargeId===draftOptions().charges[path[2]]?.id||row===newRows[path[2]-draftOptions().charges.length]);
      if(rowIndex<0)return {field:'',label:`费用配置：请核对第 ${path[2]+1} 项费用。`};
      const row=templateEditor.charges[rowIndex],name=chargeDisplayName(row)||`第 ${rowIndex+1} 项费用`;
      const key=lastString||'',uiKey=path.includes('margin_rule')&&key==='value'?'margin_percent':key;
      return {field:`charges.${rowIndex}.${uiKey}`,label:`费用“${name}”的${fieldLabel(key)}需要核对。`};
    }
    if(path[0]==='operations'&&path[1]==='templates'&&typeof path[2]==='number'){
      const key=lastString||'',uiKey=path.includes('margin_rule')&&key==='value'?'margin_percent':path.includes('exchange_rates')?key:key;
      return {field:`template.${uiKey}`,label:`模板“${templateEditor.value.label||'未命名'}”的${fieldLabel(key)}需要核对。`};
    }
    const detail=fclIssue(issue.message||'input_invalid');
    return {field:'',label:`费用配置：${detail===issue.message?'请核对费用、日期和引用关系。':detail}`};
  };
  const validatedTemplateDraft=()=>{
    if(!templateEditor)throw Object.assign(new Error('请先选择费用模板。'),{code:'fcl_template_required'});
    const next=clone(draft),issues=[];
    templateEditor.charges.forEach((row,index)=>{if(row.candidates.length>1&&row.selectedIndex===null)issues.push({field:`charges.${index}.selected`,label:`第 ${index+1} 项存在多个历史费用版本，请先核对版本，不能自动择价。`});if(row.value&&isBaseOceanFreight(row.value))issues.push({field:`charges.${index}.name_zh`,label:'基础海运费请在海运费表维护。'});});
    if(templateEditor.kind==='reference')templateEditor.charges.forEach((row,index)=>{
      if(row.value&&referenceChargeGroup(row.value)!==templateEditor.id){
        const sourceOk=String(row.value.source_ref||'').startsWith('xlsx:'),remarkOk=String(row.value.remark||'').startsWith(`参考方案：${templateEditor.id}；`);
        issues.push({field:`charges.${index}.${!sourceOk?'source_ref':!remarkOk?'remark':'name_zh'}`,label:`${chargeDisplayName(row)||`第 ${index+1} 项费用`}必须保留参考方案“${templateEditor.id}”的来源、说明和名称后缀；如需修改为正式模板，请先选择“设置报价条件”。`});
      }
    });
    if(templateEditor.kind==='template'&&templateEditor.marginPercentInvalid)issues.push({field:'template.margin_percent',label:'利润百分比必须是有效数字。'});
    templateChangedImpactRows().forEach(({row,names})=>{if(!templateSharedConfirmation)issues.push({field:'template.shared_confirm',label:`${chargeDisplayName(row)}还会影响模板：${names.join('、')}。请确认共享费用影响。`});});
    if(issues.length)return {issues,next:null};
    for(const row of templateEditor.charges){if(row.isNew&&row.value)next.operations.charges.push(clone(row.value));else if(row.selectedIndex!==null&&row.value&&JSON.stringify(row.original)!==JSON.stringify(row.value))next.operations.charges[row.selectedIndex]=clone(row.value);}
    if(templateEditor.kind==='template'){
      let index=templateEditor.index;
      if(index===null||next.operations.templates[index]?.id!==templateEditor.id||next.operations.templates[index]?.version!==templateEditor.value.version)index=next.operations.templates.findIndex(row=>row.id===templateEditor.id&&row.version===templateEditor.value.version);
      if(templateEditor.isNew&&!templateEditor.value.routing)templateEditor.value.routing=`${templateEditor.value.pod} → ${templateEditor.value.destination}`;
      if(index<0)next.operations.templates.push(clone(templateEditor.value));else next.operations.templates[index]=clone(templateEditor.value);
    }
    const checked=fclRateDatasetSchema.safeParse(fclMaintenancePayload(next));
    if(!checked.success)issues.push(...checked.error.issues.slice(0,12).map(templateSchemaIssue));
    return {issues,next:issues.length?null:next};
  };
  const templateStatus=template=>{
    const published=publishedOptions().templates.find(row=>row.id===template.id&&row.version===template.version);
    if(!published||JSON.stringify(published)!==JSON.stringify(template))return '未生效';
    const publishedDelivery=template.delivery_rate_id===null?[]:publishedOptions().delivery_rates.filter(rate=>rate.id===template.delivery_rate_id);
    const draftDelivery=template.delivery_rate_id===null?[]:draftOptions().delivery_rates.filter(rate=>rate.id===template.delivery_rate_id);
    if(JSON.stringify(publishedDelivery)!==JSON.stringify(draftDelivery))return '未生效';
    const chargeIds=new Set([...template.charge_ids,...publishedDelivery.flatMap(rate=>rate.surcharge_ids),...draftDelivery.flatMap(rate=>rate.surcharge_ids)]);
    const publishedCharges=publishedOptions().charges.filter(charge=>chargeIds.has(charge.id));
    const draftCharges=draftOptions().charges.filter(charge=>chargeIds.has(charge.id));
    if(JSON.stringify(publishedCharges)!==JSON.stringify(draftCharges))return '未生效';
    return template.enabled?'已生效':'已停用';
  };
  const templateChargeTable=(editor)=>{
    const reference=editor.kind==='reference',group=reference?editor.id:null;
    const rows=editor.charges.map((row,index)=>{
      const value=row.value,disabled=!value;
      const removed=reference?'':btn('template-remove-charge','移除',`data-charge="${esc(row.chargeId)}"`);
      const name=chargeDisplayName(row,group)||`第 ${index+1} 项费用`;
      const version=row.candidates.length>1?`<select name="charges.${index}.selected" aria-label="${esc(name)}历史版本"><option value="">待核对版本</option>${row.candidates.map(c=>`<option value="${c.index}"${row.selectedIndex===c.index?' selected':''}>v${c.charge.version} · ${esc(displayAmount(c.charge.amount))} ${esc(c.charge.currency)}</option>`).join('')}</select>`:'';
      return `<tr data-template-charge="${index}" data-charge-id="${esc(row.chargeId)}"><td data-label="费用名称"><input name="charges.${index}.name_zh" aria-label="第 ${index+1} 项费用名称" value="${esc(disabled?name:chargeDisplayName(row,group))}" placeholder="费用名称"${disabled?' disabled':''}>${version}</td><td data-label="金额"><input name="charges.${index}.amount" aria-label="${esc(name)}金额" value="${esc(displayAmount(value?.amount,''))}" inputmode="decimal"${disabled?' disabled':''}></td><td data-label="币种"><select name="charges.${index}.currency" aria-label="${esc(name)}币种"${disabled?' disabled':''}>${['USD','CAD','CNY'].map(code=>`<option${value?.currency===code?' selected':''}>${code}</option>`).join('')}</select></td><td data-label="单位"><select name="charges.${index}.unit" aria-label="${esc(name)}计费单位"${disabled?' disabled':''}><option value="FIXED"${value?.unit==='FIXED'?' selected':''}>固定金额</option><option value="CNTR"${value?.unit==='CNTR'?' selected':''}>按柜</option><option value="SHIPMENT"${value?.unit==='SHIPMENT'?' selected':''}>按票</option></select></td>${reference?'':`<td data-label="操作">${removed}</td>`}</tr>`;
    }).join('');
    return `<div class="table-wrap ops-template-table-wrap"><table class="ops-template-table${reference?' is-reference':''}"><thead><tr><th>费用名称</th><th>金额</th><th>币种</th><th>单位</th>${reference?'':'<th></th>'}</tr></thead><tbody>${rows||`<tr><td colspan="${reference?'4':'5'}" class="muted">${reference?'当前参考方案没有其他费用。':'暂无费用，先添加已有费用。'}</td></tr>`}</tbody></table></div>`;
  };
  const templateMoreSettings=(editor)=>{
    const template=editor.kind==='template';
    const chargeSettings=editor.charges.map((row,index)=>row.value?`<details class="ops-template-charge-settings" data-template-charge-settings="${index}"${templateOpenCharge===index?' open':''}><summary>${esc(chargeDisplayName(row,editor.kind==='reference'?editor.id:null))} · 来源与适用条件</summary><div class="field-grid"><label class="field">英文名称<input name="charges.${index}.name_en" value="${esc(row.value.name_en)}"></label><label class="field">代码<input name="charges.${index}.code" value="${esc(row.value.code)}"></label><label class="field">国家<input name="charges.${index}.country" value="${esc(row.value.country)}"></label><label class="field">类别<select name="charges.${index}.category">${['ocean','origin','destination','customs','inland','other','risk'].map(value=>`<option value="${value}"${row.value.category===value?' selected':''}>${esc(categoryName(value))}</option>`).join('')}</select></label><label class="field">目的港<input name="charges.${index}.pod" value="${esc(row.value.pod||'')}"></label><label class="field">目的地<input name="charges.${index}.destination" value="${esc(row.value.destination||'')}"></label><label class="field">来源<input name="charges.${index}.source_ref" value="${esc(row.value.source_ref)}"></label><label class="field">来源版本<input name="charges.${index}.source_version" value="${esc(row.value.source_version)}"></label><label class="field">备注<textarea name="charges.${index}.remark" rows="2">${esc(row.value.remark||'')}</textarea></label></div><fieldset class="ops-inline-checks"><legend>适用柜型</legend>${types.map(type=>`<label><input type="checkbox" name="charges.${index}.container_types" value="${type}"${row.value.container_types.includes(type)?' checked':''}>${type}</label>`).join('')}</fieldset><label class="check-row"><input type="checkbox" name="charges.${index}.editable"${row.value.editable?' checked':''}>允许在报价中调整售价</label></details>`:'').join('');
    const templateSettings=template?`<section><h3>高级规则</h3><div class="field-grid"><label class="field">国家<input name="template.country" value="${esc(editor.value.country)}"></label><label class="field">路线<input name="template.routing" value="${esc(editor.value.routing)}"></label><label class="field">运输方式<select name="template.service_mode"><option value="">请选择</option>${Object.entries(FCL_SERVICE_MODE_LABELS).map(([value,label])=>`<option value="${value}"${editor.value.service_mode===value?' selected':''}>${esc(label)}</option>`).join('')}</select></label><label class="field">清关方式<input name="template.customs_mode" value="${esc(editor.value.customs_mode)}"></label><label class="field">利润方式<select name="template.margin_mode"><option value="">请选择</option><option value="cost_markup"${editor.value.margin_rule.mode==='cost_markup'?' selected':''}>成本加成</option><option value="gross_margin"${editor.value.margin_rule.mode==='gross_margin'?' selected':''}>目标毛利率</option></select></label><label class="field">利润百分比<input name="template.margin_percent" value="${esc(editor.marginPercent??'')}" inputmode="decimal" placeholder="例如 10 表示 10%"></label><label class="field">汇率来源<input name="template.fx_source" value="${esc(editor.value.fx_source)}"></label><label class="field">内陆运输<select name="template.delivery_rate_id"><option value="">不包含</option>${draftOptions().delivery_rates.map(rate=>`<option value="${esc(rate.id)}"${editor.value.delivery_rate_id===rate.id?' selected':''}>${esc(rate.origin)} → ${esc(rate.destination)} · ${esc(displayAmount(rate.base_rate))} ${rate.currency}</option>`).join('')}</select></label></div><fieldset class="ops-inline-checks"><legend>模板适用柜型</legend>${types.map(type=>`<label><input type="checkbox" name="template.container_types" value="${type}"${editor.value.container_types.includes(type)?' checked':''}>${type}</label>`).join('')}</fieldset><label class="check-row"><input type="checkbox" name="template.enabled"${editor.value.enabled?' checked':''}>允许用于报价</label></section>`:'';
    return `<details class="ops-template-details"${templateMoreOpen?' open':''}><summary>加价、汇率与其他设置</summary><div class="ops-template-settings">${templateSettings}<section><h3>费用来源与适用条件</h3>${chargeSettings||'<p class="muted">暂无可设置费用。</p>'}</section></div></details>`;
  };
  const templateSharedNote=(editor)=>{
    const impacts=templateImpactRows();
    if(!impacts.length)return '';
    return `<div class="inline-note warning"><strong>共享费用影响</strong>${impacts.map(({row,names})=>`<p>${esc(chargeDisplayName(row,editor.kind==='reference'?editor.id:null))}还被其他模板使用：${esc(names.join('、'))}</p>`).join('')}<label class="check-row"><input type="checkbox" name="template.shared_confirm"${templateSharedConfirmation?' checked':''}>我已确认修改这些共享费用会影响上述模板</label></div>`;
  };
  const templateIssuePanel=()=>templateIssues.length?`<div class="form-error" role="alert">${templateIssues.map(issue=>`<p>${esc(issue.label)} ${issue.field?`<button type="button" class="text-button" data-action="ops-template-focus" data-field="${esc(issue.field)}">定位</button>`:''}</p>`).join('')}</div>`:'<div class="form-error" hidden></div>';
  const templateSavePanel=()=>{
    const changeScope=configurationChangeScope();
    if(publication)return `<section class="panel ops-template-publication"><div class="panel-body"><h3>${publication.can_publish?'待生效内容':'检查未通过'}</h3><p>本次“确认生效”会发布整套配置，不只是当前${templatePrimary==='reference'?'参考费用':'费用模板'}。</p><p class="muted">${esc(changeScope)}</p>${publication.can_publish?`<label class="check-row"><input type="checkbox" id="ops-config-confirm">我已核对模板费用、来源与计价条件</label><button class="button primary" data-action="ops-publish-config">确认生效</button>`:`<ul class="ops-template-blockers">${(publication.blockers||[]).map(code=>`<li>${esc(fclIssue(code))}</li>`).join('')}</ul><button class="button" data-action="ops-template-check-again">重新检查</button>`}</div></section>`;
    if(templatePreviewFailed)return `<section class="panel ops-template-publication"><div class="panel-body"><h3>草稿已保存，检查未完成</h3><p>费用修改没有丢失。可重新检查，不会重复保存数据。</p><button class="button primary" data-action="ops-template-check-again">重新检查</button></div></section>`;
    return '';
  };
  const templateWorkbench=()=>{
    const groups=groupReferenceCharges(draftOptions().charges);
    const templates=draftOptions().templates;
    if(!['reference','templates'].includes(templatePrimary))templatePrimary=templates.length?'templates':'reference';
    if(!groups.some(group=>group.name===referencePlan))referencePlan=groups[0]?.name||'';
    normalizeTemplateSelection();
    const editor=ensureTemplateEditor();
    const reference=templatePrimary==='reference';
    const selector=reference?`<label class="field">参考方案<select name="reference_plan"><option value="">请选择</option>${groups.map(group=>`<option value="${esc(group.name)}"${group.name===referencePlan?' selected':''}>${esc(group.name)} · ${group.entries.length} 项</option>`).join('')}</select></label>`:`<label class="field">费用模板<select name="template_choice"><option value="">请选择</option>${templates.map((template,index)=>`<option value="${index}"${index===templateIndex?' selected':''}>${esc(template.label)} · ${esc(template.destination)} · ${esc(templateStatus(template))}</option>`).join('')}</select></label>`;
    const empty=!editor&&(reference?!groups.length:!templates.length);
    const addable=[...new Map(draftOptions().charges.map((charge,index)=>[charge.id,{charge,index}]).filter(([id,entry])=>!isBaseOceanFreight(entry.charge)&&!(editor?.value?.charge_ids||[]).includes(id))).values()];
    const applicability=reference?`${editor?.charges.length||0} 项其他费用`:`目的港 ${esc(editor?.value?.pod||'待设置')} · 目的地 ${esc(editor?.value?.destination||'待设置')} · ${esc((editor?.value?.container_types||[]).join(' / ')||'柜型待设置')}`;
    return `<section class="ops-template-workbench"><div class="ops-toolbar ops-template-toolbar">${btn('template-new','新增模板')}${pendingOceanTable()}</div>${groups.length?`<nav class="ops-template-source-tabs" aria-label="费用模板来源"><button type="button" class="console-tab" data-action="ops-template-primary" data-primary="reference"${reference?' aria-current="page"':''}>参考费用 · ${groups.length} 组</button><button type="button" class="console-tab" data-action="ops-template-primary" data-primary="templates"${!reference?' aria-current="page"':''}>费用模板 · ${templates.length} 个</button></nav>`:''}${empty?`<div class="empty-state"><h2>${reference?'没有可用的参考费用':'还没有费用模板'}</h2><p>${reference?'参考费用只用于核对其他费用；基础海运费请在海运费表维护。':'新增模板后维护名称、适用范围和其他费用。'}</p>${reference?btn('tab','查看费用库','data-tab="charges"'):''}</div>`:''}${editor?`<form data-fcl-form="ops-template">${templateIssuePanel()}<div class="ops-template-head">${selector}<p class="muted">${applicability}</p><div class="head-actions">${reference?'':`<span class="badge${templateStatus(editor.value)==='已生效'?'':' warning'}">${esc(templateStatus(editor.value))}</span>`}${reference?btn('template-new-from-reference','设为费用模板'):''}${btn('template-cancel','取消修改')}</div></div>${reference?'':`<div class="field-grid ops-template-basics"><label class="field">模板名称<input name="template.label" value="${esc(editor.value.label)}" required></label><label class="field">目的港<input name="template.pod" value="${esc(editor.value.pod)}" required></label><label class="field">目的地<input name="template.destination" value="${esc(editor.value.destination)}" required></label></div>`}${templateChargeTable(editor)}${reference?'':`<div class="ops-template-add">${btn('template-new-charge','新增费用')}${addable.length?`<label class="field">添加其他费用<select name="template_add_charge"><option value="">请选择</option>${addable.map(({charge,index})=>`<option value="${index}">${esc(charge.name_zh)} · ${esc(charge.amount)} ${charge.currency}</option>`).join('')}</select></label>${btn('template-add-charge','添加')}`:''}</div>`}${templateSharedNote(editor)}${reference?'':`<div class="ops-template-fx"><span class="muted">折算汇率<br>1 外币 = 人民币</span><label class="field">USD → CNY<input name="template.USD" value="${esc(editor.value.exchange_rates.USD||'')}" inputmode="decimal"></label><label class="field">CAD → CNY<input name="template.CAD" value="${esc(editor.value.exchange_rates.CAD||'')}" inputmode="decimal"></label></div>`}${templateMoreSettings(editor)}<div class="ops-template-actions"><button class="button primary" type="submit">保存模板</button></div></form>${templateSavePanel()}`:''}</section>`;
  };
  const configurationChangeScope=()=>{
    const active=publishedDataset();
    if(!active)return '当前尚无已发布配置；本次会建立首套草稿发布。';
    const labels={rates:'海运费',charges:'基础费用库',delivery_rates:'内陆运价',rate_details:'手工船期',templates:'费用模板'};
    const changed=Object.entries(labels).flatMap(([key,label])=>{
      const before=active.operations?.[key]||[],after=draft.operations?.[key]||[];
      const count=Math.max(before.length,after.length)-([...Array(Math.min(before.length,after.length))].filter((_,index)=>JSON.stringify(before[index])===JSON.stringify(after[index])).length);
      return count?[`${label} ${count} 项`]:[];
    });
    changed.unshift(...(JSON.stringify(active.rates)===JSON.stringify(draft.rates)?[]:[`海运费 ${Math.abs(active.rates.length-draft.rates.length)||1} 项`]));
    return changed.length?`本次草稿改动范围：${changed.join('、')}。`:'本次草稿没有检测到其他结构变化。';
  };
  const editorForm=()=>{
    if(!editor)return '';const r=editor.value,kind=editor.kind;
    if(kind==='adjust')return `<form data-fcl-form="ops-adjust" class="panel ops-editor">${errorBox}<header><h2>人工调整</h2>${btn('close-editor','取消')}</header><div class="table-wrap"><table><thead><tr><th>费用</th><th>原售价</th><th>新售价</th></tr></thead><tbody>${r.calculation.lines.map(l=>`<tr><td>${esc(l.name_zh)} ${l.currency}</td><td>${esc(displayAmount(l.sell_price))}</td><td><input name="sell:${esc(l.id)}" aria-label="${esc(l.name_zh)}销售价" value="${esc(displayAmount(l.sell_price))}" inputmode="decimal"${!l.editable||r.locked?' disabled':''}></td></tr>`).join('')}</tbody></table></div>${input('reason','','required maxlength="500"')}<div class="ops-inline-checks"><label><input type="checkbox" name="locked"${r.locked?' checked':''}>锁定报价</label><label><input type="checkbox" name="recommended"${r.recommended?' checked':''}>推荐方案</label></div><button class="button primary" type="submit">保存为新版本</button></form>`;
    let fields='';
    if(kind==='charges')return `<form data-fcl-form="ops-record" class="panel ops-editor ops-charge-editor">${errorBox}<header><h2>基础费用</h2>${btn('close-editor','取消')}</header><div class="field-grid">${input('name_zh',r.name_zh,'required list="ops-fee-names"','charge_name')}${input('amount',r.amount,'required inputmode="decimal"')}${select('currency',r.currency,['USD','CAD','CNY'].map(c=>[c,c]))}${select('unit',r.unit,[['CNTR','按柜'],['SHIPMENT','按票'],...(r.unit==='FIXED'?[['FIXED','固定金额']]:[])])}${input('sell_amount',r.sell_amount,'inputmode="decimal"')}</div><datalist id="ops-fee-names">${FCL_CHARGE_CATALOG.map(c=>`<option value="${esc(c[1])}">`).join('')}</datalist><details class="ops-advanced"><summary>高级设置 · 适用范围与价格依据</summary><div class="field-grid">${['name_en','code','country'].map(k=>input(k,r[k])).join('')}${select('category',r.category,['ocean','origin','destination','customs','inland','other','risk'].map(c=>[c,categoryName(c)]))}${input('pod',r.pod)}${input('destination',r.destination)}${input('source_ref',r.source_ref)}${input('source_version',r.source_version)}${input('remark',r.remark)}</div>${boxes(r.container_types)}<label class="check-row"><input type="checkbox" name="editable"${r.editable?' checked':''}>允许调整售价</label><p class="muted">价格依据必须核实；未填时可以加入本地草稿，但不能保存发布。</p></details><button class="button primary" type="submit">加入草稿</button></form>`;
    if(kind==='delivery_rates')fields=`<div class="field-grid">${['origin','destination','country'].map(k=>input(k,r[k],'required')).join('')}${select('service_mode',r.service_mode,Object.entries(FCL_SERVICE_MODE_LABELS))}${input('base_rate',r.base_rate,'required inputmode="decimal"')}${select('currency',r.currency,['USD','CAD','CNY'].map(c=>[c,c]))}${select('unit',r.unit,[['CNTR','按柜'],['SHIPMENT','按票']])}${input('postal_codes',r.postal_codes.join(', '))}${input('zones',r.zones.join(', '))}</div><details><summary>${fclField('tiers')}</summary><div class="ops-tier-list">${r.tiers.map((t,i)=>`<div class="field-grid">${input(`tier-min-${i}`,t.min_kg,'inputmode="decimal" aria-label="最低重量 kg"','weight_min_kg')}${input(`tier-max-${i}`,t.max_kg,'inputmode="decimal" aria-label="最高重量 kg"','weight_max_kg')}${input(`tier-amount-${i}`,t.amount,'inputmode="decimal" aria-label="阶梯价格"','amount')}</div>`).join('')}</div>${btn('add-tier','添加重量区间')}<p class="muted">区间不得重叠；填写阶梯后，按总重量匹配，不使用基础价回退。</p></details>${many('surcharge_ids',r.surcharge_ids,draftOptions().charges.map(c=>[c.id,`${c.name_zh} ${displayAmount(c.amount)} ${c.currency}`]))}`;
    if(kind==='templates')fields=`<div class="field-grid">${['label','country','pod','destination','routing','customs_mode'].map(k=>input(k,r[k],'required')).join('')}${select('service_mode',r.service_mode,Object.entries(FCL_SERVICE_MODE_LABELS))}${select('delivery_rate_id',r.delivery_rate_id||'',[['','不包含内陆运输'],...draftOptions().delivery_rates.map(d=>[d.id,`${d.origin} → ${d.destination} · ${d.base_rate} ${d.currency}`])])}${select('margin_mode',r.margin_rule.mode,[['cost_markup',fclField('cost_markup')],['gross_margin',fclField('target_margin')]])}${input('margin_value',r.margin_rule.value,'required inputmode="decimal" placeholder="0.1 = 10%"')}${input('USD',r.exchange_rates.USD,'inputmode="decimal" aria-label="USD 对 CNY 汇率"')}${input('CAD',r.exchange_rates.CAD,'inputmode="decimal" aria-label="CAD 对 CNY 汇率"')}${input('fx_source',r.fx_source,'required')}</div>${many('charge_ids',r.charge_ids,draftOptions().charges.map(c=>[c.id,`${c.name_zh} ${displayAmount(c.amount)} ${c.currency}`]))}<label class="check-row"><input type="checkbox" name="enabled"${r.enabled?' checked':''}>启用模板</label>`;
    if(kind==='rate_details')fields=`<div class="field-grid">${select('rate_id',r.rate_id,draft.rates.map(rate=>[rate.rate_id,`${rate.supplier_label} · ${rate.pol} → ${rate.pod}`]))}${['carrier','routing'].map(k=>input(k,r[k],'required')).join('')}${['vessel','voyage'].map(k=>input(k,r[k])).join('')}${['etd','eta'].map(k=>input(k,r[k],'type="date"')).join('')}${input('transit_days',r.transit_days,'type="number" min="1" max="180"')}</div>`;
    const tail=kind==='rate_details'?'':`${boxes(r.container_types)}${kind==='delivery_rates'?`<div class="field-grid">${input('valid_from',r.valid_from,'type="date" required')}${input('valid_until',r.valid_until,'type="date" required')}${input('source_ref',r.source_ref,'required')}${input('source_version',r.source_version,'required')}</div>`:''}<details><summary>重量与体积限制</summary><div class="field-grid">${Object.keys(emptyCapacity).map(k=>input(k,r[k],'inputmode="decimal"')).join('')}</div></details>`;
    return `<form data-fcl-form="ops-record" class="panel ops-editor">${errorBox}<header><h2>${sectionNames[kind]}</h2>${btn('close-editor','取消')}</header>${fields}${tail}${['charges','delivery_rates'].includes(kind)?input('remark',r.remark):''}<button class="button primary" type="submit">加入草稿</button></form>`;
  };
  const captureEditor=form=>{
    if(!form||!editor)return;
    const d=new FormData(form),r=editor.value,kind=editor.kind;const text=k=>String(d.get(k)||'').trim();const nullable=k=>text(k)||null;
    if(kind==='adjust')return;
    for(const key of Object.keys(r))if(d.has(key)&&!['version','container_types','charge_ids','surcharge_ids','margin_rule','exchange_rates','tiers','editable','enabled','postal_codes','zones'].includes(key))r[key]=monetaryKey(key)?readAmountInput(text(key),r[key]):['pod','destination','vessel','voyage','etd','eta','sell_amount',...Object.keys(emptyCapacity)].includes(key)?nullable(key):text(key);
    if(kind==='rate_details'){r.transit_days=nullable('transit_days')===null?null:Number(text('transit_days'));return;}
    r.container_types=d.getAll('container_types').map(String);
    if(kind==='charges'){r.editable=d.has('editable');const entry=FCL_CHARGE_CATALOG.find(c=>c[1]===r.name_zh);if(!r.name_en)r.name_en=entry?.[2]||r.name_zh;if(editor.index===null&&entry){r.code=entry[0];r.category=entry[3];}}
    if(kind==='templates'){r.charge_ids=d.getAll('charge_ids').map(String);r.delivery_rate_id=nullable('delivery_rate_id');r.margin_rule={mode:text('margin_mode'),value:text('margin_value')};r.exchange_rates={USD:nullable('USD'),CAD:nullable('CAD')};r.enabled=d.has('enabled');}
    if(kind==='delivery_rates'){r.postal_codes=text('postal_codes').split(',').map(v=>v.trim()).filter(Boolean);r.zones=text('zones').split(',').map(v=>v.trim()).filter(Boolean);r.surcharge_ids=d.getAll('surcharge_ids').map(String);r.tiers=r.tiers.map((_,i)=>({min_kg:text(`tier-min-${i}`),max_kg:text(`tier-max-${i}`),amount:readAmountInput(text(`tier-amount-${i}`),r.tiers[i].amount)}));}
  };
  const batchForm=()=>!batch?'':`<form data-fcl-form="ops-batch" class="panel ops-editor">${errorBox}<header><h2>批量更新海运费</h2>${btn('close-batch','取消')}</header><div class="table-wrap"><table><thead><tr><th>${fclFieldHtml('carrier')}</th><th>${fclFieldHtml('container_type')}</th><th>原金额</th><th>${fclFieldHtml('ocean_freight')}</th><th>${fclFieldHtml('source_version')}</th></tr></thead><tbody>${batch.rows.map((r,i)=>`<tr><td>${esc(r.carrier)}<small>${esc(r.pol)} → ${esc(r.pod)}</small></td><td>${r.container_type}</td><td>${r.original} ${r.currency}</td><td><input name="amount-${i}" value="${esc(r.ocean_freight)}" aria-label="${esc(r.carrier)} ${r.container_type} 海运费" required inputmode="decimal"></td><td><input name="source-${i}" value="${esc(r.source_version)}" aria-label="${esc(r.carrier)} 来源版本" required></td></tr>`).join('')}</tbody></table></div>${input('reason',batch.reason,'required maxlength="500"')}<button class="button primary" type="submit">预览受影响报价</button>${batchPreview?`<div class="ops-preview"><p>将生成 ${batchPreview.new_estimates} 个新方案，重算 ${batchPreview.affected_estimates} 个已有方案；${batchPreview.locked_estimates} 个锁定方案保留原价并提示来源变化。</p><label class="check-row"><input type="checkbox" name="confirmed">已核对价格与来源</label>${btn('publish-batch','发布海运费并重算')}</div>`:''}</form>`;
  const captureBatch=form=>{const d=new FormData(form);batch.reason=String(d.get('reason')||'').trim();batch.rows.forEach((r,i)=>{r.ocean_freight=String(d.get(`amount-${i}`)||'');r.source_version=String(d.get(`source-${i}`)||'');});};
  const batchRequest=()=>({expected_version:view.version,reason:batch.reason,estimate_request:query.pol&&query.shipping_date?clone(query):null,changes:batch.rows.filter(r=>r.ocean_freight!==r.original||r.source_version!==r.originalSource).map(r=>({rate_id:r.rate_id,container_type:r.container_type,ocean_freight:r.ocean_freight,source_ref:r.source_ref,source_version:r.source_version}))});
  const markDirty=()=>{dirty=true;publication=null;const panel=document.querySelector('.ops-publication');if(panel){panel.open=true;panel.querySelector('summary').textContent='保存与发布 · 有未保存修改';panel.querySelector('[data-action="ops-publish-config"]')?.remove();panel.querySelector('#ops-config-confirm')?.closest('label')?.remove();}};
  const schedules=createFclSchedules({api,model,esc,rerender,apply:detail=>{
    const index=draftOptions().rate_details.findIndex(r=>r.rate_id===detail.rate_id);
    if(index<0)draftOptions().rate_details.push(detail);else draftOptions().rate_details[index]=detail;
    markDirty();message='船期已加入草稿，海运费金额未改变。请保存并发布后计算报价。';
  }});
  const cell=(index,key,value,attrs='')=>`<input data-ocean-index="${index}" data-ocean-key="${key}" aria-label="第 ${index+1} 行 ${key.startsWith('price:')?key.slice(6)+' 海运费':fclField(key)}" value="${esc(key.startsWith('price:')?displayAmount(value,''):value??'')}" ${attrs}>`;
  const updatedLabel=row=>{
    const value=updatedAt(row);
    if(!value)return '—';
    try{return new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));}
    catch{return value;}
  };
  const rateFilterForm=()=>`<form class="ops-rate-filter" data-fcl-form="ops-rate-filter"><label class="field">起运港<input name="filter_pol" value="${esc(rateFilter.pol)}" placeholder="筛选起运港"></label><label class="field">目的港<input name="filter_pod" value="${esc(rateFilter.pod)}" placeholder="筛选目的港"></label><label class="field">船公司<input name="filter_carrier" value="${esc(rateFilter.carrier)}" placeholder="筛选船公司或供应商"></label><button class="button" type="submit">筛选</button>${rateFilter.pol||rateFilter.pod||rateFilter.carrier?`<button class="text-button" type="button" data-action="ops-rate-filter-clear">清除</button>`:''}</form>`;
  const pendingOceanEntries=()=>[
    ...draftOptions().charges.filter(isBaseOceanFreight).map(charge=>({kind:'charge',id:`charge:${charge.id}`,name:charge.name_zh||charge.name_en||charge.code,code:charge.code,amount:charge.amount,currency:charge.currency,unit:charge.unit,source_ref:charge.source_ref,resolution:charge.ocean_freight_resolution,charge})),
    ...draft.rates.flatMap(rate=>(rate.additional_fees||[]).map((fee,index)=>({kind:'fee',id:`fee:${rate.rate_id}:${index}`,name:fee.name,code:'additional_fee',amount:fee.cost_price,currency:fee.currency,unit:fee.unit,source_ref:rate.source_ref,resolution:fee.ocean_freight_resolution,rate,fee}))).filter(entry=>isBaseOceanFreight({code:entry.code,name:entry.name})),
  ];
  const pendingOceanTable=()=>{
    const entries=pendingOceanEntries();
    if(!entries.length)return '';
    return `<details class="ops-rate-pending"><summary>历史基础海运费 · ${entries.filter(entry=>entry.resolution?.action!=='exclude').length} 项待核对</summary><p class="muted">历史基础海运费保留原金额、币种和单位。确认排除后只记录说明，不删除原记录，也不参与模板叠加。未核对的重复费用会阻止生成报价。</p><div class="table-wrap"><table><thead><tr><th>费用名称</th><th>位置</th><th>金额</th><th>币种</th><th>单位</th><th>来源</th><th>状态</th><th></th></tr></thead><tbody>${entries.map(entry=>{const excluded=entry.resolution?.action==='exclude';return `<tr><td><strong>${esc(entry.name)}</strong><small>${esc(entry.code)}</small></td><td>${entry.kind==='fee'?'海运费附费':'基础费用库'}</td><td class="num">${esc(displayAmount(entry.amount))}</td><td>${esc(entry.currency)}</td><td>${entry.unit==='CNTR'?'按柜':entry.unit==='SHIPMENT'?'按票':'固定金额'}</td><td>${esc(entry.source_ref||'—')}</td><td><span class="badge${excluded?' success':' warning'}">${excluded?'已确认排除':'待核对'}</span>${excluded&&entry.resolution?.reason?`<small>${esc(entry.resolution.reason)}</small>`:''}</td><td>${excluded?'—':btn('ocean-exclude','确认排除',`data-id="${esc(entry.id)}"`)}</td></tr>`;}).join('')}</tbody></table></div></details>`;
  };
  const filteredRates=()=>draft.rates.map((rate,index)=>({rate,index})).filter(({rate})=>{
    const carrier=String(draftOptions().rate_details.find(detail=>detail.rate_id===rate.rate_id)?.carrier||rate.supplier_label||'').toLocaleLowerCase(),pol=String(rate.pol||'').toLocaleLowerCase(),pod=String(rate.pod||'').toLocaleLowerCase();
    return (!rateFilter.pol||pol.includes(rateFilter.pol.toLocaleLowerCase()))&&(!rateFilter.pod||pod.includes(rateFilter.pod.toLocaleLowerCase()))&&(!rateFilter.carrier||carrier.includes(rateFilter.carrier.toLocaleLowerCase()));
  });
  const oceanTable=()=>{
    const rows=filteredRates();
    return `${rateFilterForm()}${pendingOceanTable()}<section class="ops-rate-panel"><div class="ops-toolbar">${btn('ocean-add','新增海运费')}<button type="button" class="button primary" data-action="ops-save-config">保存运价</button><span class="muted">${rows.length} / ${draft.rates.length} 条</span></div><div class="table-wrap"><table class="ops-ocean-table"><thead><tr><th>起运港</th><th>目的港</th><th>船公司</th>${types.map(t=>`<th>${t}</th>`).join('')}<th>币种</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows.map(({rate:r,index:i})=>{const detail=draftOptions().rate_details.find(d=>d.rate_id===r.rate_id),currencies=[...new Set(r.items.map(x=>x.currency))];return `<tr><td>${cell(i,'pol',r.pol)}</td><td>${cell(i,'pod',r.pod)}</td><td>${cell(i,'carrier',detail?.carrier,'placeholder="待补充"')}</td>${types.map(t=>`<td class="num">${cell(i,'price:'+t,r.items.find(x=>x.container_type===t)?.ocean_freight,'inputmode="decimal" placeholder="—"')}${currencies.length>1?`<small>${esc(r.items.find(x=>x.container_type===t)?.currency||'')}</small>`:''}</td>`).join('')}<td><select data-ocean-index="${i}" data-ocean-key="currency" aria-label="第 ${i+1} 行币种">${currencies.length>1?'<option value="mixed">多币种</option>':''}${['USD','CAD','CNY'].map(c=>`<option${currencies.length<=1&&c===(currencies[0]||oceanCurrencies.get(r.rate_id)||'USD')?' selected':''}>${c}</option>`).join('')}</select></td><td class="ops-updated">${esc(updatedLabel(r))}</td><td class="ops-row-actions">${btn('ocean-more','来源',`data-index="${i}"`)}${btn('ocean-sailing','查船期',`data-index="${i}"${isCoscoScheduleRate(r,detail)?'':' disabled'}`)}${btn('ocean-disable','停用',`data-index="${i}"`)}</td></tr>`;}).join('')||`<tr><td colspan="10" class="muted">没有符合筛选条件的海运费。</td></tr>`}</tbody></table></div><p class="muted">空白柜型表示未提供价格。基础海运费只在当前表维护；船期查询不会改动金额。</p></section>`;
  };
  const captureOceanCell=target=>{
    if(target.dataset.oceanIndex===undefined)return false;
    const r=draft.rates[Number(target.dataset.oceanIndex)],key=target.dataset.oceanKey,value=target.value.trim();if(!r)return true;
    if(key.startsWith('price:')){const type=key.slice(6),old=r.items.find(x=>x.container_type===type),price=readAmountInput(value,old?.ocean_freight);if(price===old?.ocean_freight)return true;r.items=r.items.filter(x=>x.container_type!==type);if(value)r.items.push({container_type:type,ocean_freight:price,currency:old?.currency||r.items[0]?.currency||oceanCurrencies.get(r.rate_id)||'USD'});}
    else if(key==='currency'&&value!=='mixed'){r.items=r.items.map(x=>({...x,currency:value}));oceanCurrencies.set(r.rate_id,value);}
    else if(['carrier','pol','pod'].includes(key)){
      const old=draftOptions().rate_details.find(detail=>detail.rate_id===r.rate_id);
      if(key==='carrier'&&old?.carrier===value||key!=='carrier'&&r[key]===value)return true;
      if(key!=='carrier')r[key]=value;
      const carrier=key==='carrier'?value:old?.carrier;
      draft.operations.rate_details=draftOptions().rate_details.filter(detail=>detail.rate_id!==r.rate_id);
      if(carrier)draft.operations.rate_details.push({rate_id:r.rate_id,carrier,routing:`${r.pol} → ${r.pod}`,vessel:null,voyage:null,etd:null,eta:null,transit_days:null});
      if(old?.vessel||old?.etd)message='线路或船公司已改变，原船期已解除关联。';
      schedules.invalidate();
    }
    markDirty();return true;
  };
  const oceanCurrencies=new Map();
  const oceanAdvanced=()=>{const r=editor.value,fees=r.additional_fees||[];return `<form class="panel ops-editor" data-fcl-form="ops-ocean-advanced">${errorBox}<header><h2>${esc(r.supplier_label||'海运费')} · 来源</h2>${btn('close-editor','取消')}</header><div class="field-grid">${input('supplier_label',r.supplier_label)}${input('source_ref',r.source_ref,'required')}${input('source_version',r.source_version,'required')}${input('note',r.note)}</div><p class="muted">填写实际文件、邮件或供应商报价编号，不要用船期查询来源代替价格依据。</p><details><summary>历史随海运附费（只读）</summary>${fees.length?`<div class="table-wrap"><table><thead><tr><th>名称</th><th>金额</th><th>币种</th><th>单位</th><th>分组</th><th>核对</th></tr></thead><tbody>${fees.map(f=>`<tr><td>${esc(f.name)}</td><td class="num">${esc(displayAmount(f.cost_price))}</td><td>${esc(f.currency)}</td><td>${f.unit==='CNTR'?'按柜':'按票'}${f.unit==='CNTR'&&f.container_type?` · ${esc(f.container_type)}`:''}</td><td>${esc(f.group)}</td><td>${isBaseOceanFreight({code:'',name:f.name})?(f.ocean_freight_resolution?.action==='exclude'?'已确认排除':'待核对'):'历史明细'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">没有历史随海运附费。</p>'}<p class="muted">历史附费保留用于核对，不再从海运费表新增或修改；其他费用请在费用模板中维护。</p></details><button class="button primary" type="submit">加入草稿</button></form>`;};
  const captureOceanAdvanced=form=>{if(!form||editor?.kind!=='ocean')return;const d=new FormData(form),r=editor.value,v=k=>String(d.get(k)||'').trim();r.supplier_label=v('supplier_label')||'未填写供应商';r.source_ref=v('source_ref');r.source_version=v('source_version');r.note=v('note')||null;};
  const oceanAction=async button=>{
    const name=button.dataset.action;
    if(name==='ops-disable-release'){if(!window.confirm('确认停用当前运价发布？已保存的历史报价将保留。'))return true;view=requireData(await write('rate-disable',{expected_version:view.version}));draft=clone(view.draft);publication=null;dirty=false;await refresh();rerender();return true;}
    if(name==='ops-rollback'){if(dirty||editor){message='请先保存或取消当前编辑。';rerender();return true;}const p=requireData(await call('rate-preview',null,'GET',`?release_id=${encodeURIComponent(button.dataset.id)}`));if(!p.can_publish){message='历史版本暂不能发布，请核对发布条件与来源。';rerender();return true;}if(!window.confirm('确认按此历史版本创建新的运价发布？'))return true;view=requireData(await write('rate-rollback',{expected_version:view.version,release_id:button.dataset.id,preview_hash:p.preview_hash,confirmation:'reviewed_sources_and_conditions'}));draft=clone(view.draft);publication=null;await refresh();rerender();return true;}
    if(!name?.startsWith('ops-ocean-'))return false;
    const i=Number(button.dataset.index),r=draft.rates[i];
    if(name==='ops-ocean-exclude'){
      const entry=pendingOceanEntries().find(item=>item.id===button.dataset.id);
      if(!entry){message='这条费用不是基础海运费。';rerender();return true;}
      const reason=window.prompt('请说明排除原因。原金额、币种和单位会保留，确认后不参与模板叠加。');
      if(!reason?.trim())return true;
      if(entry.kind==='charge')entry.charge.ocean_freight_resolution={action:'exclude',reason:reason.trim()};
      else entry.fee.ocean_freight_resolution={action:'exclude',reason:reason.trim()};
      markDirty();message='已确认排除，原记录仍保留；保存发布后不再参与模板叠加。';rerender();return true;
    }
    if(name==='ops-ocean-sailing'){schedules.show(r,query.shipping_date||'',draftOptions().rate_details.find(d=>d.rate_id===r.rate_id));return true;}
    if(editor){message='请先将编辑内容加入草稿或取消。';rerender();return true;}
    if(name==='ops-ocean-more'){editor={kind:'ocean',index:i,value:clone(r)};rerender();return true;}
    if(name==='ops-ocean-add')draft.rates.push({rate_id:crypto.randomUUID(),supplier_label:'未填写供应商',pol:query.pol,pod:routePod,valid_from:null,valid_until:null,source_ref:`manual:${crypto.randomUUID()}`,source_version:'v1',note:null,items:[],additional_fees:[]});
    if(name==='ops-ocean-disable'){
      if(draft.rates.length===1){message='最后一条海运费请通过高级设置中的“停用当前运价发布”停用。';rerender();return true;}
      if(!window.confirm('从今后的报价中停用这条运价？历史报价和价格版本仍保留。'))return true;draft.rates.splice(i,1);draft.operations.rate_details=draftOptions().rate_details.filter(d=>d.rate_id!==r.rate_id);schedules.invalidate();
    }
    markDirty();rerender();return true;
  };
  const unpublished=()=>!view?.active_release||JSON.stringify(draft)!==JSON.stringify(view.active_release.input);
  const publicationPanel=()=>section==='rates'?`<div class="ops-savebar"><span class="muted">${dirty?'有未保存修改':unpublished()?'草稿待生效':'当前运价已生效'}</span>${publication?`<label><input type="checkbox" id="ops-config-confirm">已核对价格和来源</label>${btn('publish-config','确认生效',publication.can_publish?'':'disabled')}`:''}</div>`:`<details class="panel ops-publication"${dirty||publication||unpublished()?' open':''}><summary>保存与发布${dirty?' · 有未保存修改':unpublished()?' · 草稿待发布':''}</summary><div class="ops-savebar"><span>草稿第 ${view.version} 版 · ${view.active_release?'已有发布版本':'尚未发布'}</span>${btn('save-config','保存草稿')}${btn('preview-config','预览发布')}${publication?`<label><input type="checkbox" id="ops-config-confirm">已核对来源与条件</label>${btn('publish-config','确认发布',publication.can_publish?'':'disabled')}`:''}</div><p class="muted">发布后用于报价；每次变更保留原有版本和核对记录。</p></details>`;
  const advancedPanel=()=>`<details class="panel ops-advanced"${advanced?' open':''}><summary>高级维护</summary><nav class="ops-toolbar">${['charges','delivery_rates','rate_details'].map(key=>btn('tab',sectionNames[key],`data-tab="${key}"`)).join('')}<a class="button" href="#fcl/config">报价与通知设置</a>${btn('bulk','批量调价')}${view.active_release?btn('disable-release','停用当前运价发布'):''}</nav>${['charges','delivery_rates','rate_details'].includes(section)?recordList():''}<details><summary>发布历史与回退</summary>${(view.history||[]).map(r=>`<p>第 ${r.version} 版 · ${esc(r.published_at)} ${btn('rollback','回退为新发布',`data-id="${esc(r.release_id)}"`)}</p>`).join('')||'<p>暂无发布记录</p>'}</details></details>`;
  const render=(id='',initial='')=>{
    if(initial!==entrySection){entrySection=initial;section=initial||'compare';}
    void load(id);if(!loaded||!view)return `<h1>整柜报价工作台</h1>${notifyState()}<p role="status">${loading?'正在读取费用和报价…':'读取失败，请刷新重试。'}</p>${btn('reload','重试')}`;
    if(section==='history')void loadHistory();
    const maintenance=section!=='compare'&&section!=='history';
    return `<div class="ops-workspace"><header class="ops-heading"><div><h1>整柜报价工作台</h1><p>从已发布海运费与费用模板开始，修改本票后生成客户报价。</p></div><div class="head-actions">${btn('reload','刷新')}${section==='templates'?'':btn('tab','模板维护','data-tab="templates"')}</div></header><nav class="ops-tabs" aria-label="报价工作台导航">${businessTabs.map(key=>`<button class="console-tab" data-action="ops-tab" data-tab="${key}"${section===key?' aria-current="page"':''}>${sectionNames[key]}</button>`).join('')}</nav>${notifyState()}${batchForm()}${editor?.kind==='ocean'?oceanAdvanced():editorForm()}${section==='compare'||section==='history'?compare():section==='rates'?oceanTable()+schedules.render():section==='templates'?templateWorkbench():section==='charges'?recordList():''}${maintenance?advancedPanel():''}${maintenance&&section!=='templates'?publicationPanel():''}</div>`;
  };
  const captureQuery=form=>{
    if(batchPreview){batchPreview=null;const button=document.querySelector('[data-action="ops-publish-batch"]');if(button)button.disabled=true;}
    const data=new FormData(form),text=k=>String(data.get(k)||'').trim()||null;
    const changed=query.pol!==(text('pol')||'')||routePod!==(text('pod')||'')||query.shipping_date!==(text('shipping_date')||'')||query.rate_ids[0]!==(text('selected_rate')||undefined);
    routePod=text('pod')||'';routeDestination=text('destination')||'';
    query={...query,pol:text('pol')||'',shipping_date:text('shipping_date')||'',rate_ids:text('selected_rate')?[text('selected_rate')]:[],template_ids:matchingTemplates().some(t=>t.id===text('template'))?[text('template')]:[],containers:types.flatMap(type=>Number(text(`box-${type}`))>0?[{type,quantity:Number(text(`box-${type}`)),unit:'CNTR'}]:[]),weight_kg:text('weight_kg'),volume_cbm:text('volume_cbm'),postal_code:text('postal_code'),zone:text('zone')};
    query.rate_ids=query.rate_ids.filter(id=>matchingRates().some(r=>r.rate_id===id));
    if(changed)schedules.invalidate();
  };
  const submit=async form=>{
    const kind=form.dataset.fclForm;if(!kind?.startsWith('ops-'))return false;
    if(kind==='ops-rate-filter'){const data=new FormData(form);rateFilter={pol:String(data.get('filter_pol')||'').trim(),pod:String(data.get('filter_pod')||'').trim(),carrier:String(data.get('filter_carrier')||'').trim()};rerender();return true;}
    if(kind==='ops-fee-search'){if(editor)return true;feeSearch=String(new FormData(form).get('fee_search')||'').trim();rerender();return true;}
    if(kind==='ops-template'){
      if(captureTemplateEditor(form))invalidateTemplatePublication();
      const {issues,next}=validatedTemplateDraft();
      if(issues.length){templateIssues=issues;message=issues[0]?.label||'请核对模板。';rerender();return true;}
      const saved={kind:templateEditor.kind,id:templateEditor.id,version:templateEditor.value.version};
      try{
        const data=requireData(await write('rate-save',{expected_version:view.version,input:fclMaintenancePayload(next)}));
        view=data;draft=clone(data.draft);dirty=false;publication=null;templateIssues=[];templateSharedConfirmation=false;templatePreviewFailed=false;
        if(saved.kind==='template'){
          const index=draftOptions().templates.findIndex(template=>template.id===saved.id&&template.version===saved.version);
          templateIndex=index;templateId=index>=0?draftOptions().templates[index].id:saved.id;templateEditor=createTemplateEditor(index);
        }else{
          templateEditor=createReferenceEditor(referencePlan);
        }
        try{
          publication=requireData(await call('rate-preview',{},'GET'));
          message=publication.can_publish?'草稿已保存并检查通过。核对整套配置后确认生效。':`草稿已保存，但仍有阻断：${(publication.blockers||[]).map(fclIssue).join('、')}`;
        }catch(error){templatePreviewFailed=true;message=`草稿已保存，检查未完成：${fclError(error)}。修改没有丢失，可重试检查。`;}
      }catch(error){templateIssues=[{field:'',label:fclError(error)}];message='保存失败，当前编辑仍保留，可直接重试。';}
      rerender();return true;
    }
    if(kind==='ops-ocean-advanced'){captureOceanAdvanced(form);const {source_ref,source_version,note,additional_fees}=editor.value;Object.assign(draft.rates[editor.index],{source_ref,source_version,note,additional_fees});editor=null;markDirty();rerender();return true;}
    if(kind==='ops-record'){captureEditor(form);if(editor.kind==='charges'&&isBaseOceanFreight(editor.value)){message='基础海运费请在海运费表维护。';rerender();return true;}const group=draftOptions()[editor.kind];if(editor.index===null)group.push(clone(editor.value));else group[editor.index]=clone(editor.value);editor=null;dirty=true;publication=null;message='已加入草稿；保存并发布后用于计算。';rerender();return true;}
    if(kind==='ops-run'){
      message='';
      captureQuery(form);
      if(!publishedDataset()){message='当前没有已发布的海运费与费用模板，请先完成模板维护并发布。';rerender();return true;}
      if(!query.rate_ids.length){message='请选择一条已发布海运费。';rerender();return true;}
      if(query.template_ids.length!==1){message='请选择一套费用模板。';rerender();return true;}
      // A published price change starts a new calculation intent; retries against the
      // same publication keep their idempotency key, including uncertain writes.
      const response=await write('estimate-run',query,view.active_release.release_id),result=requireData(response);invalidateHistory();items=result.items;
      if(result.items.length===1&&!result.items[0].currentness.valid_now){
        const selected=result.items[0],issues=[...new Set([...selected.calculation.blockers,...selected.currentness.reason_codes])];
        message=`请补齐后重新套用模板：${issues.map(fclIssue).join('；')}。`;
        rerender();return true;
      }
      if(contextId&&caseView&&!caseView.review_context.review_required&&result.items.length===1){
        const selected=result.items[0],quote=requireData(await write('estimate-select',{estimate_id:selected.estimate_id,expected_version:selected.version,case_ref:contextId,expected_case_version:caseView.case_version,expected_customer_supplement_ref:caseView.review_context.latest_customer_supplement_ref}));
        notify(`客户报价第 ${quote.version} 版已保存，请核对并修改本票费用。`);
        location.hash=`fcl/case/${contextId}/${quote.quote_ref}`;
        return true;
      }
      message=result.items.length>1?`已生成 ${result.items.length} 个候选，请人工选择一套方案。`:'服务器已保存内部试算；选择询价后可生成客户报价。';
      rerender();return true;
    }
    if(kind==='ops-batch'){captureBatch(form);batchPreview=requireData(await call('rate-bulk-preview',batchRequest()));rerender();return true;}
    if(kind==='ops-adjust'){
      const d=new FormData(form),old=editor.value,changes=old.calculation.lines.flatMap(l=>{const value=d.get(`sell:${l.id}`);return value!==null&&String(value)!==l.sell_price?[{line_id:l.id,sell_price:String(value)}]:[];});
      requireData(await write('estimate-adjust',{estimate_id:old.estimate_id,expected_version:old.version,locked:d.has('locked'),recommended:d.has('recommended'),reason:String(d.get('reason')||''),changes}));editor=null;await refresh();message='已保存调整记录和新版本。';rerender();return true;
    }return false;
  };
  const action=async(button)=>{
    const token=generation;
    if(await schedules.action(button))return true;
    if(token!==generation)return true;
    const name=button.dataset.action;if(!name?.startsWith('ops-'))return false;
    if(name==='ops-cases-open'){casePicker.open=true;await loadCases();return true;}
    if(name==='ops-cases-more'){await loadCases(true);return true;}
    if(name==='ops-history-retry'){await loadHistory(true);return true;}
    if(name==='ops-rate-filter-clear'){rateFilter={pol:'',pod:'',carrier:''};rerender();return true;}
    if(await oceanAction(button))return true;
    if(token!==generation)return true;
    const id=button.dataset.id,estimate=items.find(i=>i.estimate_id===id);
    if(name==='ops-template-new'){
      if(templateEditorDirty()){message='请先保存或取消当前模板修改。';rerender();return true;}
      const value={...newRecord('templates'),pod:routePod,destination:routeDestination,margin_rule:{mode:'cost_markup',value:'0'},service_mode:'container_drayage',customs_mode:'按本票要求',fx_source:'手工维护',enabled:true};
      templatePrimary='templates';templateId=value.id;templateIndex=-1;templateEditor={kind:'template',index:null,id:value.id,isNew:true,base:null,value,marginPercent:'0',marginPercentInvalid:false,charges:[]};templateMoreOpen=false;templateIssues=[];rerender();return true;
    }
    if(name==='ops-template-new-charge'){
      const form=document.querySelector('[data-fcl-form="ops-template"]');if(form)captureTemplateEditor(form);
      const value={...newRecord('charges'),source_ref:`manual:${crypto.randomUUID()}`,container_types:[...templateEditor.value.container_types]};
      templateEditor.charges.push({chargeId:value.id,selectedIndex:null,original:null,value,candidates:[],isNew:true});templateEditor.value.charge_ids.push(value.id);invalidateTemplatePublication();rerender();return true;
    }
    if(name==='ops-template-primary'){
      if(templatePrimary===button.dataset.primary)return true;
      if(templateEditorDirty()&&!window.confirm('切换分区会取消尚未保存的费用修改，是否继续？'))return true;
      invalidateTemplatePublication();templatePrimary=button.dataset.primary;templateEditor=null;templateIssues=[];templateSharedConfirmation=false;templateMoreOpen=false;templateOpenCharge=null;rerender();return true;
    }
    const convertReference=()=>{
      const next=createTemplateFromReference();
      if(!next){message='请先选择一个参考方案。';rerender();return true;}
      templatePrimary='templates';templateId=next.id;templateIndex=-1;templateEditor=next;templateIssues=[];templateSharedConfirmation=false;templateMoreOpen=true;templateOpenCharge=null;message='请补齐适用范围和高级规则后保存模板；基础海运费请在海运费表单独选择。';rerender();return true;
    };
    if(name==='ops-template-new-from-reference'){
      const form=document.querySelector('[data-fcl-form="ops-template"]');if(form&&captureTemplateEditor(form))invalidateTemplatePublication();
      const group=groupReferenceCharges(draftOptions().charges).find(item=>item.name===referencePlan);
      const unresolved=(group?.entries||[]).filter(entry=>isBaseOceanFreight(entry.charge)&&entry.charge.ocean_freight_resolution?.action!=='exclude');
      if(unresolved.length){message=`参考方案还有 ${unresolved.length} 项基础海运费未确认排除，请先到“海运费表”的待核对区处理。`;rerender();return true;}
      return convertReference();
    }
    if(name==='ops-template-cancel'){
      templateEditor=null;templateIssues=[];templateSharedConfirmation=false;templateMoreOpen=false;templateOpenCharge=null;message='已取消未保存的修改。';rerender();return true;
    }
    if(name==='ops-template-add-charge'){
      const form=document.querySelector('[data-fcl-form="ops-template"]');if(form&&captureTemplateEditor(form))invalidateTemplatePublication();
      const selected=form?.querySelector('[name="template_add_charge"]'),raw=String(selected?.value??'').trim(),index=/^\d+$/u.test(raw)?Number(raw):-1;
      const charge=Number.isSafeInteger(index)&&index>=0?draftOptions().charges[index]:null;
      if(!charge){message='请选择要加入的费用。';rerender();return true;}
      if(templateEditor.charges.some(row=>row.chargeId===charge.id)){message='这项费用已经在当前方案中。';rerender();return true;}
      const candidates=chargeCandidates(charge.id);
      templateEditor.charges.push({chargeId:charge.id,selectedIndex:index,original:clone(charge),value:clone(charge),candidates});templateEditor.value.charge_ids=[...new Set([...templateEditor.value.charge_ids,charge.id])];invalidateTemplatePublication();rerender();return true;
    }
    if(name==='ops-template-remove-charge'){
      const form=document.querySelector('[data-fcl-form="ops-template"]');if(form&&captureTemplateEditor(form))invalidateTemplatePublication();
      const chargeId=button.dataset.charge;templateEditor.charges=templateEditor.charges.filter(row=>row.chargeId!==chargeId);templateEditor.value.charge_ids=templateEditor.value.charge_ids.filter(id=>id!==chargeId);invalidateTemplatePublication();rerender();return true;
    }
    if(name==='ops-template-check-again'){
      if(dirty||templateEditorDirty()){invalidateTemplatePublication();message='有未保存的费用修改，请先保存并检查。';rerender();return true;}
      try{publication=requireData(await call('rate-preview',{},'GET'));templatePreviewFailed=false;templateIssues=[];message=publication.can_publish?'检查通过。核对整套配置后确认生效。':`仍有阻断：${(publication.blockers||[]).map(fclIssue).join('、')}`;}
      catch(error){templatePreviewFailed=true;message=`检查未完成：${fclError(error)}。草稿仍保留，可再次重试。`;}
      rerender();return true;
    }
    if(name==='ops-template-focus'){
      const field=button.dataset.field||'',charge= /^charges\.(\d+)\./u.exec(field);templateMoreOpen=true;templateOpenCharge=charge?Number(charge[1]):null;rerender();setTimeout(()=>document.querySelector(`[name="${field}"]`)?.focus(),0);return true;
    }
    if(name==='ops-tab'){if(editor||templateEditorDirty()){if(!window.confirm('当前有未保存的费用编辑，切换会取消这些编辑。是否继续？'))return true;templateEditor=null;templateIssues=[];templateOpenCharge=null;}section=button.dataset.tab;advanced=!businessTabs.includes(section);schedules.invalidate();rerender();return true;}
    if(name==='ops-advanced'){advanced=true;section='templates';rerender();return true;}
    if(name==='ops-sailing'){const rate=(publishedDataset()?.rates||[]).find(r=>r.rate_id===query.rate_ids[0]);if(!rate){message='请先选择一条已发布 COSCO 海运费，再查询该线路船期。';rerender();return true;}schedules.show(rate,query.shipping_date,publishedOptions().rate_details.find(d=>d.rate_id===rate.rate_id));return true;}
    if(name==='ops-reload'){if(dirty||editor||batch||templateEditorDirty()){message='请先保存或取消当前编辑。';rerender();return true;}generation++;loading=false;loaded=false;items=[];history=null;historyRows=[];caseList=[];casePicker=emptyCasePicker();invalidateHistory();void load(contextId,true);return true;}
    if(name==='ops-new'||name==='ops-copy-record'||name==='ops-next-version'||name==='ops-edit'){if(editor){message='请先保存或取消当前编辑。';rerender();return true;}const kind=button.dataset.kind,index=button.dataset.index===undefined?null:Number(button.dataset.index),value=index===null?newRecord(kind):clone(draftOptions()[kind][index]);if(name==='ops-copy-record'&&kind!=='rate_details'){value.id=crypto.randomUUID();value.version=1;}else if(index!==null&&kind!=='rate_details')value.version=Math.max(...draftOptions()[kind].filter(r=>r.id===value.id).map(r=>r.version))+1;if(name==='ops-next-version'){value.valid_from='';value.valid_until='';}editor={kind,index:['ops-copy-record','ops-next-version'].includes(name)?null:index,value};rerender();return true;}
    if(name==='ops-close-editor'){editor=null;rerender();return true;}
    if(name==='ops-add-tier'){captureEditor(document.querySelector('[data-fcl-form="ops-record"]'));editor.value.tiers.push({min_kg:'',max_kg:'',amount:''});rerender();return true;}
    if(name==='ops-save-config'){if(editor){message='请先将编辑内容加入草稿。';rerender();return true;}const checked=fclRateDatasetSchema.safeParse(fclMaintenancePayload(draft));if(!checked.success){message='请补充或核对：'+checked.error.issues.slice(0,4).map(issue=>{const keys=issue.path,field=FCL_FIELDS[keys.at(-1)]?.zh||'金额或适用条件',group=keys[0]==='rates'?'海运费':sectionNames[keys[1]]||'费用',index=keys.find(k=>typeof k==='number');return `${group}${index===undefined?'':`第 ${index+1} 项`}的${field}`;}).join('；')+'。价格来源等字段可在“更多信息”或“高级设置”中补充。';rerender();return true;}const data=requireData(await write('rate-save',{expected_version:view.version,input:fclMaintenancePayload(draft)}));view=data;draft=clone(data.draft);dirty=false;publication=null;publication=requireData(await call('rate-preview',{},'GET'));message=publication.can_publish?'运价已保存，请核对后确认生效。':'运价已保存，请核对提示项目。';rerender();return true;}
    if(name==='ops-preview-config'){if(dirty||editor||batch){message='请先保存或取消当前编辑。';rerender();return true;}publication=requireData(await call('rate-preview',{},'GET'));message=publication.can_publish?'校验通过，请确认后发布。':`尚不能发布：${(publication.blockers||[]).map(fclIssue).join('、')}`;rerender();return true;}
    if(name==='ops-publish-config'){
      if(dirty||templateEditorDirty()||!publication){invalidateTemplatePublication();message='有未保存的费用修改，请先保存并重新检查。';rerender();return true;}
      if(!document.querySelector('#ops-config-confirm')?.checked){message='请先核对来源与条件。';rerender();return true;}
      view=requireData(await write('rate-publish',{expected_version:view.version,preview_hash:publication.preview_hash,confirmation:'reviewed_sources_and_conditions'}));draft=clone(view.draft);publication=null;templatePreviewFailed=false;await refresh();message='已发布，并重新计算受影响的预估报价。';rerender();return true;
    }
    if(name==='ops-bulk'){if(dirty){message='请先完成配置草稿的保存与发布。';rerender();return true;}batch={reason:'',rows:(view.active_release?.input.rates||[]).flatMap(r=>r.items.map(i=>({rate_id:r.rate_id,carrier:r.supplier_label,pol:r.pol,pod:r.pod,...i,original:i.ocean_freight,source_ref:r.source_ref,source_version:r.source_version,originalSource:r.source_version})))};batchPreview=null;rerender();return true;}
    if(name==='ops-close-batch'){batch=null;batchPreview=null;rerender();return true;}
    if(name==='ops-publish-batch'){const form=document.querySelector('[data-fcl-form="ops-batch"]');if(!new FormData(form).has('confirmed')){message='请先确认已核对价格与来源。';rerender();return true;}captureBatch(form);view=requireData(await write('rate-bulk-publish',{...batchRequest(),preview_hash:batchPreview.preview_hash,confirmation:'reviewed_sources_and_conditions'}));draft=clone(view.draft);batch=null;batchPreview=null;await refresh();message='新海运费与关联报价版本已保存。';rerender();return true;}
    if(name==='ops-close-history'){history=null;rerender();return true;}
    if(!estimate)return true;
    if(name==='ops-adjust'){if(editor){message='请先保存或取消当前编辑。';rerender();return true;}editor={kind:'adjust',value:clone(estimate)};rerender();return true;}
    if(name==='ops-duplicate'){requireData(await write('estimate-duplicate',{estimate_id:id,expected_version:estimate.version}));await refresh();message='已复制为独立方案。';rerender();return true;}
    if(name==='ops-history'){const target=button.dataset.version?Number(button.dataset.version):Math.max(1,estimate.version-1);history=requireData(await call('estimate-get',{estimate_id:id,version:target}));historyRows=await Promise.all(Array.from({length:Math.min(12,target)},(_,index)=>target-index).map(version=>version===target?history:call('estimate-get',{estimate_id:id,version}).then(requireData)));rerender();return true;}
    if(name==='ops-select'){
      const caseId=contextId||query.case_ref;if(!caseId){message='请先选择要关联的客户询价。';rerender();return true;}
      const c=requireData(await call('case-get',{case_id:caseId}));const quote=requireData(await write('estimate-select',{estimate_id:id,expected_version:estimate.version,case_ref:caseId,expected_case_version:c.case_version,expected_customer_supplement_ref:c.review_context.latest_customer_supplement_ref}));
      notify(`客户报价第 ${quote.version} 版已保存，请继续核对与审核。`);location.hash=`fcl/case/${caseId}/${quote.quote_ref}`;return true;
    }return true;
  };
  const change=event=>{
    const target=event.target;if(!target.closest('.ops-workspace'))return false;if(schedules.change(target))return true;if(captureOceanCell(target))return true;if(target.closest('[data-fcl-form="ops-run"]'))captureQuery(target.form);
    if(target.name==='sort'){sort=target.value;rerender();return true;}if(target.name==='direction'){direction=target.value;rerender();return true;}
    if(target.name==='destination'&&!target.closest('form')){destination=target.value;rerender();return true;}
    if(target.name==='case_ref'){if(dirty||editor||templateEditorDirty()){message='请先保存草稿再切换询价。';rerender();return true;}location.hash=target.value?`fcl/compare/${target.value}`:'fcl/compare';return true;}
    if(target.closest('[data-fcl-form="ops-template"]')){
      if(captureTemplateEditor(target.form))invalidateTemplatePublication();
      if(target.name==='reference_plan'){if(templateEditorDirty()&&!window.confirm('切换参考方案会取消尚未保存的修改，是否继续？')){rerender();return true;}referencePlan=target.value;templateEditor=null;templateIssues=[];templateSharedConfirmation=false;templateOpenCharge=null;rerender();return true;}
      if(target.name==='template_choice'){
        if(templateEditorDirty()&&!window.confirm('切换报价模板会取消尚未保存的修改，是否继续？')){rerender();return true;}
        const index=Number(target.value),template=draftOptions().templates[index];
        if(template){templateIndex=index;templateId=template.id;}
        templateEditor=null;templateIssues=[];templateSharedConfirmation=false;templateOpenCharge=null;rerender();return true;
      }
      if(target.name==='template.shared_confirm'){templateSharedConfirmation=target.checked;return true;}
      if(/^charges\.\d+\.selected$/u.test(target.name)){rerender();return true;}
      return true;
    }
    if(target.closest('[data-fcl-form="ops-run"]')&&['pol','pod','destination','shipping_date','selected_rate','template'].includes(target.name)){rerender();return true;}
    if(target.name==='catalog'&&target.value){captureEditor(target.form);const entry=FCL_CHARGE_CATALOG.find(c=>c[0]===target.value);Object.assign(editor.value,{code:entry[0],name_zh:entry[1],name_en:entry[2],category:entry[3]});rerender();return true;}
    if(target.closest('[data-fcl-form="ops-batch"]')&&target.name!=='confirmed'){batchPreview=null;const publish=document.querySelector('[data-action="ops-publish-batch"]');if(publish)publish.disabled=true;}
    return true;
  };
    return {render,reset,submit:async form=>{const token=generation;try{return await submit(form);}catch(error){if(token!==generation)return true;throw error;}},action:async button=>{const token=generation;try{return await action(button);}catch(error){if(token!==generation)return true;throw error;}},change,input:event=>{if(!event.target.closest('.ops-workspace'))return false;if(captureOceanCell(event.target))return true;if(event.target.closest('[data-fcl-form="ops-run"]'))captureQuery(event.target.form);if(event.target.closest('[data-fcl-form="ops-template"]')){if(captureTemplateEditor(event.target.form)&&event.target.name!=='template.shared_confirm')invalidateTemplatePublication();return true;}if(event.target.closest('[data-fcl-form="ops-batch"]')&&event.target.name!=='confirmed'){batchPreview=null;const button=document.querySelector('[data-action="ops-publish-batch"]');if(button)button.disabled=true;}return true;},isDirty:()=>dirty||Boolean(editor)||Boolean(batch)||templateEditorDirty()};
}
