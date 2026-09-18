import {originPorts,destinationPorts,metrics,maritimeDatasetSchema,maritimeSources} from '../../services/maritime/contracts.ts';
import {scheduleAccessState} from './maritime-access.ts';

const modules={schedules:{title:'船期查询',id:'ocean.schedules',path:'sailing-schedules',route:'schedules',icon:'ship'},terminals:{title:'码头效率',id:'port.efficiency',path:'terminal-efficiency',route:'terminal-efficiency',icon:'clock'}};
const events={planned:'计划',estimated:'预计',actual:'实际'};
const reasonLabels={maritime_not_published:'当前企业尚未发布数据，请先查看下方官方查询入口。',source_expired:'来源已超过有效期，以下仅为历史快照，请重新核验。',source_unverified:'来源尚未人工核验。',source_observed_in_future:'来源观察时间晚于当前时间。',records_required:'请至少填写一条记录。',duplicate_records:'存在重复航次或同一统计周期的重复指标，请核对。',arrival_before_departure:'到港时间早于离港时间，请核对日期和时区。',actual_event_after_observation:'实际事件时间不能晚于来源观察时间。',routing_via_conflict:'中转航线必须填写中转港，直达航线请留空。',metric_unit_mismatch:'指标与单位不匹配。',metric_period_invalid:'统计结束应晚于开始，且不晚于来源观察时间。',missing_value_reason_required:'指标没有数值时，请说明缺失原因。',value_reason_conflict:'已有数值时请清空缺失原因。',metric_value_missing:'部分指标尚无数据，不能视为 0 或运行正常。',no_matching_records:'当前发布批次没有匹配记录，不代表没有航次或码头没有等待。'};
const fresh=()=>({label:'',source:{name:'',url:'',version:'',observed_at:'',expires_at:'',verified:false},records:[]});
function localDate(value){return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`}
function defaultScheduleWindow(){const now=new Date();return{from:localDate(now),until:localDate(new Date(now.getFullYear(),now.getMonth(),now.getDate()+28))}}
export function createMaritimeWorkspace({api,mutate,esc,head,note,icon,model,rerender,canConfigure}){
  let epoch=0, state=new Map(), liveEpoch=0, carriersEpoch=0;
  let live={mode:'live',carriers:null,carriersPending:false,carriersRequested:false,carrier:'ONE',originText:'',originCountry:'CN',destinationText:'',destinationCountry:'CA',...defaultScheduleWindow(),routing:'any',originId:'',destinationId:'',originCandidates:[],destinationCandidates:[],result:null,pending:false,error:'',controller:null};
  const item=kind=>{if(!state.has(kind))state.set(kind,{input:null,result:null,config:null,editor:null,pending:false,dirty:false,approval:null,error:''});return state.get(kind);};
  const endpoint=kind=>'/admin/'+modules[kind].path;
  const signed=()=>Boolean(model().session?.authenticated&&model().session.organization_id);
  const select=(label,name,options,value='',required=true)=>`<div class="field"><label for="marine-${name}">${esc(label)}</label><select id="marine-${name}" name="${name}" ${required?'required':''}><option value="">${required?'请选择':'全部'}</option>${Object.entries(options).map(([key,title])=>`<option value="${esc(key)}" ${value===key?'selected':''}>${esc(title)}</option>`).join('')}</select></div>`;
  const field=(label,name,value='',attrs='required')=>`<div class="field"><label for="marine-${name}">${esc(label)}</label><input id="marine-${name}" name="${name}" value="${esc(value??'')}" ${attrs} maxlength="2000"></div>`;
  const button=(label,action,kind,attrs='')=>`<button type="button" class="button" data-action="maritime-${action}" data-kind="${kind}" ${attrs}>${label}</button>`;
  const stamp=value=>esc(value?.replace('T',' ').replace(/:00(?=[Z+-])/u,'').replace(/Z$/u,' UTC').replace(/([+-][0-9]{2}:[0-9]{2})$/u,' UTC$1')||'未提供');
  function sources(kind,portCode=''){
    const sources=maritimeSources.filter(s=>s.kind===kind&&(!portCode||!s.ports.length||s.ports.includes(portCode)));
    return `<section class="maritime-sources"><h2>官方查询入口</h2><p>在来源网站查看当前资料；本页不会自动同步这些网站。</p><div class="maritime-source-grid">${sources.map(s=>`<a class="panel maritime-source" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><span>${icon(modules[kind].icon)}</span><h3>${esc(s.name)} ${icon('arrow')}</h3><p>${esc(s.description)}</p></a>`).join('')}</div></section>`;
  }
  function results(kind,result){
    if(!result)return '<div class="maritime-empty"><h2>查看已核验的数据</h2><p>选择查询条件，读取当前企业发布的记录。每条结果保留来源和日期。</p></div>';
    const d=result.data;
    return `${result.reason_codes?.length?note(result.reason_codes.map(r=>reasonLabels[r]||'数据需要核对，请联系管理员。').join(' '),'warning'):''}${d?.source?`<div class="maritime-provenance"><strong>${esc(d.source.name)}</strong><span>${kind==='schedules'?'更新于':'版本 '+esc(d.source.version)+' · 观察于'} ${stamp(d.source.observed_at)}</span><span>有效至 ${stamp(d.source.expires_at)}</span><a href="${esc(d.source.url)}" target="_blank" rel="noopener noreferrer">核对来源 ${icon('arrow')}</a>${kind==='schedules'?'':`<details><summary>查看发布记录</summary><small>发布 ${esc(d.release.id)} · ${esc(d.release.digest.slice(0,12))}</small></details>`}</div>`:''}<div class="maritime-results">${(d?.records||[]).map(r=>kind==='schedules'?`<article class="panel sailing-card"><div class="sailing-card-head"><strong>${esc(r.carrier)}</strong><span class="badge">${r.routing==='direct'?'直达':'中转 · '+esc(r.via)}</span></div><div class="sailing-route"><div><h3>${esc(originPorts[r.origin])}</h3><span>${events[r.departure_kind]}离港</span><time>${stamp(r.departure)}</time></div><span class="sailing-route-icon">${icon('ship')}${icon('arrow')}</span><div><h3>${esc(destinationPorts[r.destination])}</h3><span>${events[r.arrival_kind]}到港</span><time>${stamp(r.arrival)}</time></div></div><p>${esc(r.vessel)} · 航次 ${esc(r.voyage)}</p></article>`:`<article class="panel metric-card"><div><span>${esc(destinationPorts[r.port])} · ${esc(r.terminal)}</span><h3>${esc(metrics[r.metric].label)}</h3></div><p class="metric-value">${r.value===null?'暂无数据':esc(r.value)} <small>${r.value===null?'':esc(metrics[r.metric].unitLabel)}</small></p><p>${esc(r.definition)}</p>${r.missing_reason?note(r.missing_reason,'warning'):''}<small>统计区间 ${stamp(r.period_start)} — ${stamp(r.period_end)}</small></article>`).join('')}</div>`;
  }
  const liveStatusLabels={success:'查询完成',manual_review:'部分船期待确认',needs_input:'请补充查询条件',blocked:'当前无法查询，请联系企业管理员',unavailable:'船公司暂时无法提供船期，请稍后重试'};
  const scheduleAccess=()=>scheduleAccessState({session:model().session,directory:model().directory});
  function scheduleNotice(access){
    if(access.phase==='anonymous')return `<div class="schedule-context-note">${note('登录企业账号，查询船公司最新船期。','info')}<button type="button" class="button" data-login-return="schedules">登录</button></div>`;
    if(access.phase==='platform-no-org')return note(access.organizations.length?'平台工作区不执行企业船期查询。请使用页面上方“当前工作区”选择具体企业，再提交查询。':'平台账号当前没有可用的企业工作区。请切换到企业账号，或由企业管理员邀请。','info');
    if(access.phase==='select-org')return note('请先在页面顶部选择企业；选择后会继续留在本页，已填写的查询条件会保留。','info');
    if(access.phase==='no-membership')return note('当前账号没有可用的企业成员资格。请联系企业管理员邀请或恢复成员状态；没有成员资格时不会发起真实查询。','warning');
    if(access.phase==='viewer')return note('当前角色为查看者，不能发起官方船期查询。请联系企业管理员调整为负责人、管理员或开发者。','warning');
    return '';
  }
  function liveCandidateChoices(list,side){
    if(list.length<2)return '';
    return `<fieldset class="maritime-record" data-location-side="${side}"><legend>选择${side==='origin'?'起运地':'目的地'}</legend>${list.map(c=>`<label class="choice-row"><input type="radio" name="live_${side}_id" value="${esc(c.carrier_location_id)}" ${(side==='origin'?live.originId:live.destinationId)===c.carrier_location_id?'checked':''}><span class="choice-copy"><strong>${esc(c.name)}</strong><small>${esc([c.country_code,c.unlocode].filter(Boolean).join(' · '))}</small></span></label>`).join('')}</fieldset>`;
  }
  function liveForm(access){
    const carriers=live.carriers?.carriers||[];
    const fallback=[{id:'ONE',display_name:'Ocean Network Express',capability_status:null},{id:'COSCO',display_name:'COSCO SHIPPING Lines',capability_status:null}];
    const visible=(carriers.length?carriers:fallback).filter(c=>['ONE','COSCO'].includes(c.id));
    const disabled=!access.canQuery||!visible.length;
    return `<form class="panel maritime-query schedule-query" data-form="maritime-live-query"><h2 class="schedule-form-title">点到点船期</h2><div class="form-error" role="alert" hidden></div><div class="field-grid schedule-primary-fields">
<div class="field"><label for="live-carrier">船公司</label><select id="live-carrier" name="carrier" required>${visible.map(c=>`<option value="${esc(c.id)}" ${live.carrier===c.id?'selected':''}>${esc(c.id)}</option>`).join('')}</select></div>
<div class="field"><label for="live-origin">起运港 / 起运地</label><input id="live-origin" name="origin" value="${esc(live.originText)}" required maxlength="200" placeholder="例如 Shanghai"></div>
<div class="field"><label for="live-destination">目的港 / 目的地</label><input id="live-destination" name="destination" value="${esc(live.destinationText)}" required maxlength="200" placeholder="例如 Vancouver"></div>
<div class="field"><label for="live-from">离港开始</label><input id="live-from" name="from" type="date" value="${esc(live.from)}" required></div>
<div class="field"><label for="live-until">离港截止</label><input id="live-until" name="until" type="date" value="${esc(live.until)}" required></div>
<div class="field"><label for="live-routing">直达 / 中转</label><select id="live-routing" name="routing"><option value="any" ${live.routing==='any'?'selected':''}>不限</option><option value="direct" ${live.routing==='direct'?'selected':''}>直达</option><option value="transshipment" ${live.routing==='transshipment'?'selected':''}>中转</option></select></div>
</div><details class="schedule-secondary schedule-country"><summary>高级条件</summary><div class="field-grid"><div class="field"><label for="live-origin-country">起运国家 / 地区代码</label><input id="live-origin-country" name="origin_country" value="${esc(live.originCountry)}" maxlength="2" pattern="[A-Za-z]{2}" placeholder="例如 CN"></div><div class="field"><label for="live-destination-country">目的国家 / 地区代码</label><input id="live-destination-country" name="destination_country" value="${esc(live.destinationCountry)}" maxlength="2" pattern="[A-Za-z]{2}" placeholder="例如 CA"></div></div></details>${liveCandidateChoices(live.originCandidates,'origin')}${liveCandidateChoices(live.destinationCandidates,'destination')}<button type="submit" class="button primary" ${disabled?'disabled':''}>${live.pending?'查询中…':'查询船期'} ${icon('search')}</button>${live.error&&!live.carriers?`<button type="button" class="button" data-action="maritime-live-reload-carriers">重试加载船公司</button>`:''}</form>`;
  }
  const eventKindLabel=event=>events[event?.event_kind]||'事件类型未提供';
  function readableDateTime(value){if(!value)return null;const match=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/u.exec(value);return match?(match[4]?`${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`:`${match[1]}-${match[2]}-${match[3]}`):value;}
  function liveEventSummary(event){if(!event)return '时间未提供';return `${eventKindLabel(event)} ${readableDateTime(event.local_datetime||event.local_date)||'时间未提供'} · ${event.timezone||'来源未提供时区'}`;}
  function liveRecord(record){
    const modes={ocean:'海运',rail:'铁路',truck:'公路',barge:'驳船',unknown:'运输方式待确认'};
    const legEvents=leg=>leg.events.map(e=>`<li>${e.event_type==='departure'?'离港':'到达'} · ${esc(liveEventSummary(e))}</li>`).join('');
    const legs=record.legs.map(leg=>`<div class="schedule-leg"><strong>第 ${leg.sequence} 段 · ${modes[leg.mode]||modes.unknown}${leg.vessel_name?' · '+esc(leg.vessel_name):''}${leg.voyage?' / '+esc(leg.voyage):''}</strong><p>${esc(leg.from?.name||'地点未提供')} → ${esc(leg.to?.name||'地点未提供')}</p>${leg.events.length?`<ul>${legEvents(leg)}</ul>`:'<p>时间未提供</p>'}</div>`).join('');
    const ocean=record.legs.filter(leg=>leg.mode==='ocean');
    const first=ocean[0]||record.legs[0],last=ocean.at(-1)||record.legs.at(-1);
    const departure=first?.events.find(e=>e.event_type==='departure')||null;
    const arrival=last?.events.find(e=>e.event_type==='arrival')||null;
    const vessel=ocean.find(leg=>leg.vessel_name)?.vessel_name||null;
    const voyage=ocean.find(leg=>leg.voyage)?.voyage||null;
    const routing=record.routing==='direct'?'直达':record.routing==='transshipment'?'中转':'待确认';
    const cutoffLabels={si:'补料截止',vgm:'VGM 截止',cy:'截港',customs:'报关截止'};
    const cutoffs=Object.entries(record.cutoffs||{}).filter(([,v])=>v?.at).map(([k,v])=>`<p>${cutoffLabels[k]||'截止时间'}：${stamp(v.at)}</p>`).join('');
    const timeCell=(event,missing)=>event?`<time>${esc(readableDateTime(event.local_datetime||event.local_date)||'时间未提供')}</time><small>${esc(eventKindLabel(event))} · ${esc(event.timezone||'来源未提供时区')}</small>`:`<small>${missing}</small>`;
    return `<article class="schedule-card"><div class="voyage-grid"><div class="voyage-vessel"><span class="voyage-label">船名 / 航次</span><strong>${esc(vessel||'船名未提供')}</strong><span>${voyage?'航次 '+esc(voyage):'航次未提供'}</span>${record.operating_carrier?`<small>承运船公司 ${esc(record.operating_carrier)}</small>`:''}</div><div><span class="voyage-label">起运港 / 离港</span><strong>${esc(record.pol?.name||'港口未提供')}</strong>${timeCell(departure,'离港时间未提供')}</div><div><span class="voyage-label">目的港 / 到达</span><strong>${esc(record.pod?.name||'港口未提供')}</strong>${timeCell(arrival,'到达时间未提供')}</div><div><span class="voyage-label">航程</span><strong>${record.transit?.source_total_hours?esc(record.transit.source_total_hours)+' 小时':'未提供'}</strong></div><div><span class="voyage-label">运输安排</span><span class="badge">${routing}</span><small>${record.legs.length} 段运输</small></div></div><details class="schedule-voyage-details"><summary>航线详情</summary>${record.service_name?`<p>航线 ${esc(record.service_name)}</p>`:''}${legs}${cutoffs}</details></article>`;
  }
  function liveResults(){
    if(live.error)return note(live.error,'error');
    const r=live.result;
    if(!r)return '<div class="maritime-empty schedule-result-empty"><h2>查询您的下一程</h2><p>选择起运地、目的地和离港日期，查看可选航次。</p></div>';
    const d=r.data,coverage=d?.coverage;
    if(!d)return note(liveStatusLabels[r.status]||'暂时无法查询，请稍后重试。','warning');
    const uncovered=(coverage?.uncovered_windows||[]).map(w=>`${w.from}—${w.until}`).join('、');
    const records=d.records||[];
    const partial=r.status!=='success'||!coverage.complete;
    const empty=records.length?'':`<div class="maritime-empty"><h3>${partial?'暂未取得完整船期':'未找到匹配航次'}</h3><p>${partial?'请稍后重试，或向船公司确认。':'请调整起运地、目的地或离港日期后重试。'}</p></div>`;
    return `<div class="schedule-result-heading"><h2>${records.length} 条${partial?'已取得的':''}航次</h2><span>${esc(d.carrier.sales_carrier)} · ${esc(coverage.requested_from)} — ${esc(coverage.requested_until)}</span></div>${partial?note('部分日期的船期尚未取得'+(uncovered?'（'+uncovered+'）':'')+'，以下仅供参考。','warning'):''}${d.carrier.id==='ONE'?'<p class="schedule-business-note">到港时间采用船公司公布的靠泊时间。</p>':''}${!partial&&(r.warnings?.length||r.blockers?.length)?note('部分船期信息仍需向船公司确认。','warning'):''}${empty}${records.length?`<div class="schedule-results"><div class="voyage-grid voyage-header" aria-hidden="true"><span>船名 / 航次</span><span>起运港 / 离港</span><span>目的港 / 到达</span><span>航程</span><span>运输安排</span></div>${records.map(liveRecord).join('')}</div><p class="schedule-business-note">船期可能调整，请在出运前向船公司确认。</p>`:''}`;
  }
  async function loadLiveCarriers(){
    if(live.carriers||live.carriersPending)return;
    const generation=carriersEpoch;
    live.carriersPending=true;
    try{const r=await api('/maritime/schedule-collector/carriers',{acceptBusiness:true});if(generation!==carriersEpoch)return;live.carriers=r.data;}catch(error){if(generation!==carriersEpoch)return;live.error=error.code==='schedule_live_unavailable'?'官方查询尚未在此环境启用。':'船公司列表加载失败，请重试。';}
    finally{if(generation===carriersEpoch){live.carriersPending=false;rerender();}}
  }
  async function runLive(form){
    const access=scheduleAccess();
    if(!access.canQuery){live.error=access.phase==='viewer'?'当前角色是查看者，不能发起官方船期查询。':access.phase==='anonymous'?'请先登录后再提交真实船期查询。':'请先选择有效的企业工作区，再提交真实船期查询。';rerender();return;}
    const data=new FormData(form),get=k=>String(data.get(k)||'').trim();
    live.carrier=get('carrier')||live.carrier;live.originText=get('origin');live.originCountry=get('origin_country').toUpperCase();live.destinationText=get('destination');live.destinationCountry=get('destination_country').toUpperCase();live.from=get('from');live.until=get('until');live.routing=get('routing')||'any';
    if(get('live_origin_id'))live.originId=get('live_origin_id');
    if(get('live_destination_id'))live.destinationId=get('live_destination_id');
    live.controller?.abort();
    const controller=new AbortController();live.controller=controller;
    const generation=++liveEpoch;live.pending=true;live.error='';live.result=null;rerender();
    try{
      const resolve=async(side,text,country,selected)=>{if(selected)return{id:selected};const r=await api('/maritime/schedule-collector/locations',{method:'POST',acceptBusiness:true,signal:controller.signal,body:{carrier:live.carrier,text,country_code:country||null}});if(r.status==='needs_input')return{needs:r.data?.candidates||[],query:r.data?.query||text};if(r.status!=='success')throw Object.assign(new Error(r.status),{code:r.blockers?.[0]?.code||r.status});return{id:r.data.resolved.carrier_location_id};};
      const [origin,destination]=await Promise.all([resolve('origin',live.originText,live.originCountry,live.originId),resolve('destination',live.destinationText,live.destinationCountry,live.destinationId)]);
      if(generation!==liveEpoch)return;
      live.originCandidates=origin.needs||[];live.destinationCandidates=destination.needs||[];live.originId=origin.id||'';live.destinationId=destination.id||'';
      if(origin.needs||destination.needs){live.pending=false;live.error='官方地点存在多个匹配，请选择后再查询。';rerender();return;}
      const result=await api('/maritime/schedule-collector/search',{method:'POST',acceptBusiness:true,signal:controller.signal,body:{carrier:live.carrier,origin:{text:live.originText,country_code:live.originCountry||null,carrier_location_id:live.originId},destination:{text:live.destinationText,country_code:live.destinationCountry||null,carrier_location_id:live.destinationId},from:live.from,until:live.until,routing:live.routing}});
      if(generation!==liveEpoch)return;
      live.result=result;
    }catch(error){
      if(generation!==liveEpoch||error.code==='request_aborted')return;
      live.error=error.code==='schedule_live_role_denied'?'当前角色不能发起官方来源查询。':error.code==='schedule_live_disabled'?'当前企业尚未启用官方来源查询。':error.code==='schedule_live_carrier_denied'?'该船司未对企业开放。':'船公司查询暂时不可用，请稍后重试。';
    }finally{if(generation===liveEpoch){live.pending=false;rerender();}}
  }
  function page(kind){
    const m=modules[kind],s=item(kind),q=s.input||{};
    const query=kind==='schedules'?`${select('起运港','origin',originPorts,q.origin)}${select('目的港','destination',destinationPorts,q.destination)}${field('离港开始日期','from',q.from,'type="date" required')}${field('离港截止日期','until',q.until,'type="date" required')}${field('船司（可选）','carrier',q.carrier,'')}`:`${select('港口','port',destinationPorts,q.port)}${field('码头（可选）','terminal',q.terminal,'')}${select('指标','metric',Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,v.label])),q.metric,false)}`;
    const snapshotBody=`<form class="panel maritime-query" data-form="maritime-query" data-kind="${kind}"><div class="form-error" role="alert" hidden></div><div class="field-grid">${query}</div><button type="submit" class="button primary">查询企业已发布数据 ${icon('search')}</button><small>${kind==='schedules'?'最长查询区间 90 天 · ':''}企业资料仅本企业成员可见</small></form>${s.error?note(s.error,'error'):''}${results(kind,s.result)}`;
    if(kind==='schedules'){
      const access=scheduleAccess();
      if(access.canQuery&&!live.carriers&&!live.carriersRequested){live.carriersRequested=true;void loadLiveCarriers();}
      const firstScreen=`<section class="schedule-query-shell" data-schedule-phase="${access.phase}">${scheduleNotice(access)}${liveForm(access)}<div data-schedule-results aria-live="polite">${liveResults()}</div></section>`;
      return `<div class="maritime-workspace schedule-page">${head(m.title,'查找航线，安排下一程。')}${firstScreen}${signed()?`<details class="schedule-secondary schedule-snapshot"><summary>企业船期记录</summary>${snapshotBody}</details>`:''}<details class="schedule-secondary schedule-sources"><summary>其他官方来源</summary>${sources('schedules',q.destination||'')}</details><p class="maritime-cli"><a href="/console/workspace-cli.md" target="_blank" rel="noopener">${icon('terminal')} CLI 使用说明</a></p></div>`;
    }
    return `<div class="maritime-workspace">${head(m.title,'查看铁路、锚地、闸口与堆场指标，按统计区间判断运输安排。',canConfigure()?`<a class="button" href="#configure/${m.id}">配置效率数据</a>`:'')}<div class="maritime-intro">${icon(m.icon)}<p>不同码头与统计周期分别展示；堆场占用英尺不等于箱量。</p></div>${signed()?snapshotBody:`<div class="maritime-empty"><h2>登录后查看企业数据</h2><p>企业自行核验的码头效率资料会显示在登录后的工作区。</p></div>`}${sources(kind,q.destination||q.port)}<p class="maritime-cli"><a href="/console/workspace-cli.md" target="_blank" rel="noopener">${icon('terminal')} CLI 使用说明</a> <code>freightclaw workspace ${kind} query</code></p></div>`;
  }
  function load(kind){
    const s=item(kind);if(s.config||s.pending||s.error)return s;
    s.pending=true;const generation=epoch;
    api(endpoint(kind)).then(r=>{if(generation===epoch){s.config=r.data;s.editor=structuredClone(r.data.draft||fresh());}}).catch(()=>{if(generation===epoch)s.error='配置读取失败，请刷新后重试。';}).finally(()=>{if(generation===epoch){s.pending=false;rerender();}});return s;
  }
  const rowFields=(kind,r,i)=>{
    const prefix='r'+i+'.';
    const f=(label,key,attrs='required')=>field(label,prefix+key,r[key],attrs);
    const sel=(label,key,choices)=>select(label,prefix+key,choices,r[key]);
    return `<fieldset class="maritime-record"><legend>${kind==='schedules'?'航次':'指标'} ${i+1}</legend><div class="field-grid">${kind==='schedules'?`${sel('起运港','origin',originPorts)}${sel('目的港','destination',destinationPorts)}${f('船司','carrier')}${f('船名','vessel')}${f('航次','voyage')}${f('离港时间（含时区）','departure')}${sel('离港状态','departure_kind',events)}${f('到港时间（含时区）','arrival')}${sel('到港状态','arrival_kind',events)}${sel('直达或中转','routing',{direct:'直达',transshipment:'中转'})}${f('中转港（直达留空）','via','')}`:`${sel('港口','port',destinationPorts)}${f('码头','terminal')}${sel('指标','metric',Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,v.label])))}${f('数值（缺失留空）','value','inputmode="decimal"')}${f('统计开始（含时区）','period_start')}${f('统计截止（含时区）','period_end')}${f('统计口径','definition')}${f('缺失原因（有数值留空）','missing_reason','')}`}</div>${button('移除记录','remove',kind,`data-index="${i}"`)}</fieldset>`;
  };
  function admin(kind){
    const m=modules[kind];if(!canConfigure())return head('需要企业管理权限','请使用当前企业管理员账号维护来源数据。');
    const s=load(kind);if(s.pending)return head(m.title+'配置','正在读取当前企业配置…');
    if(!s.config)return head(m.title+'配置',s.error||'配置暂不可用',button('重新读取','reload',kind));
    const d=s.editor,p=s.approval;
    return `<div class="maritime-workspace">${head(m.title+'配置','维护来源和记录，核对后发布到企业工作区。',`<a class="button" href="#market/configure">返回模块配置</a><a class="button" href="#${m.route}">打开${m.title}</a>`)}${s.error?note(s.error,'warning'):''}<form class="panel maritime-editor" data-form="maritime-save" data-kind="${kind}"><div class="form-error" role="alert" hidden></div><h2>来源与有效期</h2><p>时间必须包含时区，例如 2026-09-08T09:00:00+08:00。每个批次来自同一份核验资料。</p><div class="field-grid">${field('批次名称','label',d.label)}${field('来源名称','source.name',d.source.name)}${field('来源证据链接','source.url',d.source.url,'type="url" required placeholder="https://"')}${field('来源版本或报告编号','source.version',d.source.version)}${field('来源观察时间（含时区）','source.observed_at',d.source.observed_at)}${field('数据有效至（含时区）','source.expires_at',d.source.expires_at)}</div><label class="choice-row"><input type="checkbox" name="source.verified" ${d.source.verified?'checked':''}>我已核对来源、统计口径与使用权限</label><h2>${kind==='schedules'?'船期记录':'效率指标'}</h2>${d.records.length?d.records.map((r,i)=>rowFields(kind,r,i)).join(''):'<p>尚无记录。添加需要在前台查询的航次或效率指标。</p>'}<div class="channel-actions">${button('添加记录','add',kind,d.records.length>=500?'disabled':'')}<button class="button primary" type="submit">保存草稿</button><span data-maritime-dirty>${s.dirty?'有未保存修改':'草稿已读回'}</span></div></form><section class="panel maritime-publish"><h2>核验与发布</h2><p>当前${s.config.active_release?'已发布版本 '+s.config.active_release.version:'尚未发布'}。保存草稿后，预览来源与记录再确认发布。</p>${p?`<div class="channel-confirm"><h3>${p.disable?'确认停用':p.release_id?'确认回退':'确认发布'}</h3>${p.input?`<p>${esc(p.input.label)} · ${p.input.records.length} 条记录</p><p>${esc(p.input.source.name)} · ${esc(p.input.source.version)} · 有效至 ${stamp(p.input.source.expires_at)}</p><details><summary>核对本次全部记录</summary><pre class="native-config-preview">${esc(JSON.stringify(p.input,null,2))}</pre></details>`:'<p>停用后本企业的新查询将提示暂无发布数据，历史仍保留。</p>'}${p.blockers?.length?note(p.blockers.map(x=>reasonLabels[x]||x).join(' '),'error'):''}<div class="channel-actions">${p.disable||p.can_publish?button('确认'+(p.disable?'停用':p.release_id?'回退':'发布'),'confirm',kind):''}${button('取消','cancel',kind)}</div></div>`:`<div class="channel-actions">${s.config.draft?button('预览发布','preview',kind,s.dirty?'disabled':''):''}${s.config.active_release?button('停用当前版本','disable',kind):''}</div>`}<h3>发布历史</h3>${s.config.history.length?s.config.history.map(r=>`<div class="channel-release"><div><strong>${esc(r.label)}</strong><p>版本 ${r.version} · ${stamp(r.published_at)}</p></div>${r.release_id===s.config.active_release?.release_id?'<span class="badge">当前版本</span>':button('预览回退','preview',kind,`data-release="${esc(r.release_id)}" ${s.dirty?'disabled':''}`)}</div>`).join(''):'<p>尚无发布记录。</p>'}</section></div>`;
  }
  function capture(form){
    const kind=form.dataset.kind,s=item(kind),d=s.editor,data=new FormData(form),get=k=>String(data.get(k)||'').trim();
    d.label=get('label');for(const key of ['name','url','version','observed_at','expires_at'])d.source[key]=get('source.'+key);d.source.verified=data.has('source.verified');
    d.records=d.records.map((r,i)=>{const keys=kind==='schedules'?['origin','destination','carrier','vessel','voyage','departure','arrival','departure_kind','arrival_kind','routing','via']:['port','terminal','metric','value','period_start','period_end','definition','missing_reason'];const row={id:r.id};for(const key of keys)row[key]=get('r'+i+'.'+key)||(['via','value','missing_reason'].includes(key)?null:'');if(kind==='terminals')row.unit=metrics[row.metric]?.unit||'';return row;});
  }
  async function submit(form){
    if(!form.dataset.form?.startsWith('maritime-'))return false;
    const kind=form.dataset.kind,s=item(kind),generation=epoch;s.error='';
    if(form.dataset.form==='maritime-live-query'){await runLive(form);return true;}
    if(form.dataset.form==='maritime-query'){
      const q=Object.fromEntries([...new FormData(form)].filter(([,v])=>String(v).trim()).map(([k,v])=>[k,String(v).trim()]));s.input=q;s.result=null;
      try{const response=await api('/maritime/'+modules[kind].path+'/query',{method:'POST',body:q,acceptBusiness:true});if(generation===epoch)s.result=response;}catch{if(generation===epoch)s.error='查询暂不可用，请核对登录状态或稍后重试。';}
    }else{
      capture(form);const parsed=maritimeDatasetSchema(kind).safeParse(s.editor);
      if(!parsed.success){s.error='请补齐记录，检查含时区的日期、来源链接和数值格式。';rerender();return true;}
      const r=await mutate(endpoint(kind)+'/save','POST',{expected_version:s.config.version,input:parsed.data});if(generation===epoch){s.config=r.data;s.dirty=false;s.approval=null;}
    }
    if(generation===epoch)rerender();return true;
  }
  async function action(b){
    if(!b.dataset.action?.startsWith('maritime-'))return false;
    const kind=b.dataset.kind,s=item(kind),a=b.dataset.action.slice(9),generation=epoch;
    if(a==='reload'){state.delete(kind);rerender();return true;}
    if(a==='live-reload-carriers'){live.carriers=null;live.carriersPending=false;live.carriersRequested=true;live.error='';rerender();void loadLiveCarriers();return true;}
    if(a==='add'||a==='remove'){
      capture(document.querySelector('[data-form="maritime-save"]'));
      if(a==='add'&&s.editor.records.length<500)s.editor.records.push({id:crypto.randomUUID()});
      if(a==='remove')s.editor.records.splice(Number(b.dataset.index),1);
      s.dirty=true;s.approval=null;
    }else if(a==='preview'){
      if(s.dirty){s.error='请先保存草稿，再预览发布。';rerender();return true;}
      const r=await api(endpoint(kind)+'/preview'+(b.dataset.release?'?release_id='+encodeURIComponent(b.dataset.release):''));if(generation===epoch)s.approval=r.data;
    }else if(a==='disable')s.approval={disable:true,version:s.config.version};
    else if(a==='cancel')s.approval=null;
    else if(a==='confirm'){
      const p=s.approval;if(!p)return true;
      const r=await mutate(endpoint(kind)+'/'+(p.disable?'disable':p.release_id?'rollback':'publish'),'POST',{expected_version:p.version,...(p.disable?{}:{preview_hash:p.preview_hash,confirmation:'reviewed_sources_and_conditions'}),...(p.release_id?{release_id:p.release_id}:{})});
      if(generation===epoch){s.config=r.data;s.approval=null;s.result=null;}
    }
    if(generation===epoch)rerender();return true;
  }
  function input(event){
    const liveForm=event.target.closest('[data-form="maritime-live-query"]');
    if(liveForm){
      const data=new FormData(liveForm),get=k=>String(data.get(k)??'').trim();
      live.carrier=get('carrier')||live.carrier;live.originText=get('origin');live.originCountry=get('origin_country').toUpperCase();live.destinationText=get('destination');live.destinationCountry=get('destination_country').toUpperCase();live.from=get('from');live.until=get('until');live.routing=get('routing')||'any';
      live.controller?.abort();live.controller=null;liveEpoch++;live.pending=false;live.result=null;live.error='';
      const field=event.target.name;
      if(field==='carrier'){live.originId='';live.destinationId='';live.originCandidates=[];live.destinationCandidates=[];}
      else if(field==='origin'||field==='origin_country'){live.originId='';live.originCandidates=[];}
      else if(field==='destination'||field==='destination_country'){live.destinationId='';live.destinationCandidates=[];}
      if(field==='carrier'||field==='origin'||field==='origin_country')liveForm.querySelector('[data-location-side="origin"]')?.remove();
      if(field==='carrier'||field==='destination'||field==='destination_country')liveForm.querySelector('[data-location-side="destination"]')?.remove();
      const resultRegion=document.querySelector('[data-schedule-results]');
      if(resultRegion)resultRegion.innerHTML='<p class="schedule-business-note">查询条件已更新，请重新查询。</p>';
      const submitButton=liveForm.querySelector('button[type="submit"]');
      if(submitButton)submitButton.innerHTML='查询船期 '+icon('search');
      return true;
    }
    const queryForm=event.target.closest('[data-form="maritime-query"]');
    if(queryForm){const s=item(queryForm.dataset.kind);s.result=null;document.querySelector('.maritime-results')?.replaceChildren();const source=document.querySelector('.maritime-provenance');if(source)source.textContent='条件已修改，请重新查询。';return true;}
    const form=event.target.closest('[data-form="maritime-save"]');if(!form)return false;const s=item(form.dataset.kind);capture(form);s.dirty=true;s.approval=null;document.querySelector('[data-maritime-dirty]').textContent='有未保存修改';document.querySelectorAll('[data-action="maritime-preview"],[data-action="maritime-confirm"]').forEach(b=>{b.disabled=true;});return true;}
  return {page,admin,action,submit,input,reset(preserveQuery=false){epoch++;state=new Map();liveEpoch++;carriersEpoch++;live.controller?.abort();const keep=preserveQuery?{carrier:live.carrier,originText:live.originText,originCountry:live.originCountry,destinationText:live.destinationText,destinationCountry:live.destinationCountry,from:live.from,until:live.until,routing:live.routing}:null;live={mode:'live',carriers:null,carriersPending:false,carriersRequested:false,carrier:keep?.carrier??'ONE',originText:keep?.originText??'',originCountry:keep?.originCountry??'CN',destinationText:keep?.destinationText??'',destinationCountry:keep?.destinationCountry??'CA',...defaultScheduleWindow(),...(keep?{from:keep.from,until:keep.until,routing:keep.routing}:{}),originId:'',destinationId:'',originCandidates:[],destinationCandidates:[],result:null,pending:false,error:'',controller:null};},isDirty:()=>[...state.values()].some(s=>s.dirty),configurationStatus(kind){const s=load(kind==='sailing-schedules'?'schedules':'terminals');return s.pending?'正在读取…':s.error?'状态读取失败':s.config?.active_release?'已发布快照':s.config?.draft?'草稿待发布':'尚未配置';}};
}
