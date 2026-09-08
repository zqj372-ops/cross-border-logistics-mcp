import {originPorts,destinationPorts,metrics,maritimeDatasetSchema,maritimeSources} from '../../services/maritime/contracts.ts';

const modules={schedules:{title:'船期查询',id:'ocean.schedules',path:'sailing-schedules',route:'schedules',icon:'ship'},terminals:{title:'码头效率',id:'port.efficiency',path:'terminal-efficiency',route:'terminal-efficiency',icon:'clock'}};
const events={planned:'计划',estimated:'预计',actual:'实际'};
const reasonLabels={maritime_not_published:'当前企业尚未发布数据，请先查看下方官方查询入口。',source_expired:'来源已超过有效期，以下仅为历史快照，请重新核验。',source_unverified:'来源尚未人工核验。',source_observed_in_future:'来源观察时间晚于当前时间。',records_required:'请至少填写一条记录。',duplicate_records:'存在重复航次或同一统计周期的重复指标，请核对。',arrival_before_departure:'到港时间早于离港时间，请核对日期和时区。',actual_event_after_observation:'实际事件时间不能晚于来源观察时间。',routing_via_conflict:'中转航线必须填写中转港，直达航线请留空。',metric_unit_mismatch:'指标与单位不匹配。',metric_period_invalid:'统计结束应晚于开始，且不晚于来源观察时间。',missing_value_reason_required:'指标没有数值时，请说明缺失原因。',value_reason_conflict:'已有数值时请清空缺失原因。',metric_value_missing:'部分指标尚无数据，不能视为 0 或运行正常。',no_matching_records:'当前发布批次没有匹配记录，不代表没有航次或码头没有等待。'};
const fresh=()=>({label:'',source:{name:'',url:'',version:'',observed_at:'',expires_at:'',verified:false},records:[]});
export function createMaritimeWorkspace({api,mutate,esc,head,note,icon,model,rerender,canConfigure}){
  let epoch=0, state=new Map();
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
    return `${result.reason_codes?.length?note(result.reason_codes.map(r=>reasonLabels[r]||'数据需要核对，请联系管理员。').join(' '),'warning'):''}${d?.source?`<div class="maritime-provenance"><strong>${esc(d.source.name)}</strong><span>版本 ${esc(d.source.version)} · 观察于 ${stamp(d.source.observed_at)}</span><span>有效至 ${stamp(d.source.expires_at)}</span><a href="${esc(d.source.url)}" target="_blank" rel="noopener noreferrer">核对来源 ${icon('arrow')}</a><details><summary>查看发布记录</summary><small>发布 ${esc(d.release.id)} · ${esc(d.release.digest.slice(0,12))}</small></details></div>`:''}<div class="maritime-results">${(d?.records||[]).map(r=>kind==='schedules'?`<article class="panel sailing-card"><div class="sailing-card-head"><strong>${esc(r.carrier)}</strong><span class="badge">${r.routing==='direct'?'直达':'中转 · '+esc(r.via)}</span></div><div class="sailing-route"><div><h3>${esc(originPorts[r.origin])}</h3><span>${events[r.departure_kind]}离港</span><time>${stamp(r.departure)}</time></div><span class="sailing-route-icon">${icon('ship')}${icon('arrow')}</span><div><h3>${esc(destinationPorts[r.destination])}</h3><span>${events[r.arrival_kind]}到港</span><time>${stamp(r.arrival)}</time></div></div><p>${esc(r.vessel)} · 航次 ${esc(r.voyage)}</p></article>`:`<article class="panel metric-card"><div><span>${esc(destinationPorts[r.port])} · ${esc(r.terminal)}</span><h3>${esc(metrics[r.metric].label)}</h3></div><p class="metric-value">${r.value===null?'暂无数据':esc(r.value)} <small>${r.value===null?'':esc(metrics[r.metric].unitLabel)}</small></p><p>${esc(r.definition)}</p>${r.missing_reason?note(r.missing_reason,'warning'):''}<small>统计区间 ${stamp(r.period_start)} — ${stamp(r.period_end)}</small></article>`).join('')}</div>`;
  }
  function page(kind){
    const m=modules[kind],s=item(kind),q=s.input||{};
    const query=kind==='schedules'?`${select('起运港','origin',originPorts,q.origin)}${select('目的港','destination',destinationPorts,q.destination)}${field('离港开始日期','from',q.from,'type="date" required')}${field('离港截止日期','until',q.until,'type="date" required')}${field('船司（可选）','carrier',q.carrier,'')}`:`${select('港口','port',destinationPorts,q.port)}${field('码头（可选）','terminal',q.terminal,'')}${select('指标','metric',Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,v.label])),q.metric,false)}`;
    return `<div class="maritime-workspace">${head(m.title,kind==='schedules'?'从起运港到目的港，核对航次、到离港时间与中转安排。':'查看铁路、锚地、闸口与堆场指标，按统计区间判断运输安排。',canConfigure()?`<a class="button" href="#configure/${m.id}">配置${kind==='schedules'?'船期':'效率数据'}</a>`:'')}<div class="maritime-intro">${icon(m.icon)}<p>${kind==='schedules'?'计划与实际分别标注，时间保留来源时区。':'不同码头与统计周期分别展示；堆场占用英尺不等于箱量。'}</p></div>${signed()?`<form class="panel maritime-query" data-form="maritime-query" data-kind="${kind}"><div class="form-error" role="alert" hidden></div><div class="field-grid">${query}</div><button type="submit" class="button primary">查询企业已发布数据 ${icon('search')}</button><small>最长查询区间 90 天 · 企业资料仅本企业成员可见</small></form>${s.error?note(s.error,'error'):''}${results(kind,s.result)}`:`<div class="maritime-empty"><h2>从官方来源开始查询</h2><p>下方入口可公开使用。企业自行核验的船期和运营资料会显示在登录后的工作区。</p></div>`}${sources(kind,q.destination||q.port)}<p class="maritime-cli"><a href="/console/workspace-cli.md" target="_blank" rel="noopener">${icon('terminal')} CLI 使用说明</a> <code>freightclaw workspace ${kind} query</code></p></div>`;
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
    const queryForm=event.target.closest('[data-form="maritime-query"]');
    if(queryForm){const s=item(queryForm.dataset.kind);s.result=null;document.querySelector('.maritime-results')?.replaceChildren();const source=document.querySelector('.maritime-provenance');if(source)source.textContent='条件已修改，请重新查询。';return true;}
    const form=event.target.closest('[data-form="maritime-save"]');if(!form)return false;const s=item(form.dataset.kind);capture(form);s.dirty=true;s.approval=null;document.querySelector('[data-maritime-dirty]').textContent='有未保存修改';document.querySelectorAll('[data-action="maritime-preview"],[data-action="maritime-confirm"]').forEach(b=>{b.disabled=true;});return true;}
  return {page,admin,action,submit,input,reset(){epoch++;state=new Map();},isDirty:()=>[...state.values()].some(s=>s.dirty),configurationStatus(kind){const s=load(kind==='sailing-schedules'?'schedules':'terminals');return s.pending?'正在读取…':s.error?'状态读取失败':s.config?.active_release?'已发布快照':s.config?.draft?'草稿待发布':'尚未配置';}};
}
