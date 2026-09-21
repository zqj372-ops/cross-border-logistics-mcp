import {scheduleAccessState} from './maritime-access.ts';
import {createScheduleClient,selectableSailings,scheduleToRateDetail,transitLabel} from './maritime-query.js';

const COSCO='COSCO';
const coscoNames=new Set(['COSCO','COSCO SHIPPING','COSCO SHIPPING LINES','中远','中远海运','中远海运集运']);
export const isCoscoScheduleRate=(rate,detail)=>coscoNames.has(String(detail?.carrier||rate?.supplier_label||'').trim().toUpperCase());

const statuses={success:'查询完成',needs_input:'需要补充资料',manual_review:'需要人工核对',blocked:'查询被阻止',unavailable:'暂时不可用'};
export function createFclSchedules({api,model,esc,rerender,apply}){
  const client=createScheduleClient(api);
  let epoch=0,controller=null,rate=null,from='',eligible=false,carriers=null,pending=false,result=null,error='',choices={},ids={},chosen=null,open=false;
  const access=()=>scheduleAccessState({session:model().session,directory:model().directory||model().state});
  const coscoAvailable=()=>carriers?.some(c=>c.id===COSCO&&['live_verified','implemented_unverified'].includes(c.capability_status));
  const canUse=record=>{
    if(!eligible||result?.data?.carrier?.id!==COSCO||!selectableSailings(result).includes(record))return false;
    const detail=scheduleToRateDetail(record,rate.rate_id,COSCO);
    return Boolean(detail.vessel&&detail.voyage&&detail.etd&&detail.eta);
  };
  const clear=()=>{epoch++;controller?.abort();pending=false;result=null;choices={};ids={};chosen=null;error='';};
  const reset=()=>{clear();rate=null;carriers=null;open=false;};
  const button=(action,text,attrs='')=>`<button type="button" class="button" data-action="ops-schedule-${action}" ${attrs}>${text}</button>`;
  const loadCarriers=async()=>{const e=epoch;try{const r=await client.carriers();if(e!==epoch)return;carriers=r.status==='success'?r.data?.carriers||[]:[];if(r.status!=='success')error=statuses[r.status]||'无法读取船公司';}catch{if(e===epoch){carriers=[];error='船公司列表加载失败，请重试。';}}if(e===epoch)rerender();};
  const show=(value,date,detail)=>{clear();rate=structuredClone(value);from=date||value.valid_from;eligible=isCoscoScheduleRate(value,detail);carriers=null;open=true;if(access().canQuery&&eligible)void loadCarriers();rerender();};
  const invalidate=()=>{if(open){clear();open=false;}};
  const render=()=>{
    if(!open)return '';
    const enabled=access().canQuery;
    const records=result?.data?.quality?.conflicts?.length||result?.data?.carrier?.id!==COSCO?[]:result?.data?.records||[],selectable=records.filter(canUse);
    return `<section class="panel ops-schedule"><header class="ops-toolbar"><h2>COSCO 官方船期 · ${esc(rate.pol)} → ${esc(rate.pod)}</h2>${button('close','收起')}</header>${!enabled?'<p class="inline-note warning">当前账号没有官方船期查询权限。请使用指定受理人或已授权企业成员账号；已保存的船期仍可查看。</p>':!eligible?'<p class="inline-note warning">目前仅查询 COSCO 官方船期，请选择 COSCO 海运费。其他船公司暂不查询。</p>':`<div class="ops-toolbar"><strong>来源：COSCO 中远海运</strong><span>${esc(from)} 起 28 天</span>${button('search',pending?'查询中…':'查询 COSCO 船期',pending||!coscoAvailable()?'disabled':'')}${button('retry-carriers','刷新连接状态')}</div>${!coscoAvailable()?`<p class="muted">${carriers===null?'正在检查 COSCO 查询服务…':'COSCO 查询服务暂不可用，请刷新连接状态。'}</p>`:''}`}${Object.entries(choices).map(([side,list])=>`<label class="field">确认${side==='origin'?'起运港':'目的港'}<select name="sailing_${side}"><option value="">请选择匹配港口</option>${list.map(c=>`<option value="${esc(c.carrier_location_id)}"${ids[side]===c.carrier_location_id?' selected':''}>${esc(c.name)} · ${esc(c.country_code||'')} · ${esc(c.source_full_name||c.unlocode||'')}</option>`).join('')}</select></label>`).join('')}${error?`<p role="status" class="inline-note warning">${esc(error)}</p>`:''}${result?`<p role="status">${statuses[result.status]||'状态待核对'}${selectable.length?' · 官方查询结果':' · 未确认完整实时数据，不能直接回填'}</p>${result.data?.provenance?.kind&&result.data.provenance.kind!=='live'?'<p class="inline-note warning">此结果为测试或回放数据。</p>':''}${(result.blockers||[]).length?'<p class="muted">服务返回阻断信息，请在船期模块核对。</p>':''}`:''}${records.length?`<div class="table-wrap"><table><thead><tr><th>船期来源 / 船名 / 航次</th><th>开船日期</th><th>到港日期</th><th>航程 / 路线</th><th>码头 / 航线</th><th>操作</th></tr></thead><tbody>${records.map((record,i)=>{const d=scheduleToRateDetail(record,rate.rate_id,COSCO);return `<tr><td>${esc(d.carrier)}<strong>${esc(d.vessel||'船名待确认')}</strong><small>${esc(d.voyage||'航次待确认')}</small><small>实际承运人：${esc(record.operating_carrier||'未提供')}</small></td><td>${esc(d.etd||'待确认')}</td><td>${esc(d.eta||'待确认')}</td><td>${esc(transitLabel(record.transit))}<small>${esc(d.routing)}</small></td><td>${esc(record.terminal?.name||'—')}<small>${esc(record.service_name||'')}</small></td><td>${button('use',chosen===i?'已加入草稿':'使用此船期',`data-index="${i}"${selectable.includes(record)&&d.carrier?'':' disabled'}`)}</td></tr>`;}).join('')}</tbody></table></div>`:''}<p class="muted">船期只关联到所选海运费，金额和价格来源保持原值。保存并发布草稿后用于新报价。</p></section>`;
  };
  const search=async()=>{
    if(!rate||!access().canQuery||!eligible||!coscoAvailable()||pending)return;
    const e=++epoch;controller?.abort();controller=new AbortController();pending=true;result=null;chosen=null;error='';rerender();
    try{
      const locations=await Promise.all(['origin','destination'].map(async(side)=>{
        const body={carrier:COSCO,text:side==='origin'?rate.pol:rate.pod,country_code:side==='origin'?'CN':'CA',...(ids[side]?{carrier_location_id:ids[side]}:{})};
        return {side,body,response:await client.locations(body,controller.signal)};
      }));
      if(e!==epoch)return;
      choices={};let incomplete=false;
      for(const {side,response} of locations){if(response.status==='needs_input'){choices[side]=response.data?.candidates||[];incomplete=true;error='需要补充资料：请选择准确港口后重新查询。';}else if(response.status!=='success'||!response.data?.resolved){incomplete=true;error=`${statuses[response.status]||'查询失败'}：港口尚未确认。`;}else ids[side]=response.data.resolved.carrier_location_id;}
      if(!incomplete){const until=new Date(from+'T00:00:00Z');until.setUTCDate(until.getUTCDate()+27);const response=await client.search({carrier:COSCO,origin:{text:rate.pol,country_code:'CN',carrier_location_id:ids.origin},destination:{text:rate.pod,country_code:'CA',carrier_location_id:ids.destination},from,until:until.toISOString().slice(0,10),routing:'any'},controller.signal);if(e!==epoch)return;result=response;if(response.data&&response.data.carrier?.id!==COSCO)error='船期来源与 COSCO 不一致，不能使用此结果。';}
    }catch(err){if(e===epoch)error=err.code==='schedule_live_disabled'?'当前工作区尚未启用官方船期。':'船期暂时不可用，请稍后重试或在船期模块核对权限。';}
    finally{if(e===epoch){pending=false;rerender();}}
  };
  const action=async button=>{const action=button.dataset.action?.replace('ops-schedule-','');if(!button.dataset.action?.startsWith('ops-schedule-'))return false;if(action==='close'){invalidate();rerender();}if(action==='retry-carriers'&&eligible&&access().canQuery)await loadCarriers();if(action==='search')await search();if(action==='use'){const index=Number(button.dataset.index),record=result?.data?.records[index];if(record&&canUse(record)&&access().canQuery){apply(scheduleToRateDetail(record,rate.rate_id,COSCO));chosen=index;rerender();}}return true;};
  const change=target=>{if(!target.name?.startsWith('sailing_'))return false;if(['sailing_origin','sailing_destination'].includes(target.name)){epoch++;controller?.abort();pending=false;ids[target.name.slice(8)]=target.value;result=null;chosen=null;}rerender();return true;};
  return {show,render,reset,invalidate,action,change};
}
