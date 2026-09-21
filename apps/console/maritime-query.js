// Both workspaces use the same Console request transport and collector endpoints.
export function createScheduleClient(api){
  const request=(action,body,signal)=>api(`/maritime/schedule-collector/${action}`,{method:body?'POST':'GET',acceptBusiness:true,...(body?{body}:{}),...(signal?{signal}:{})});
  return {carriers:signal=>request('carriers',null,signal),locations:(body,signal)=>request('locations',body,signal),search:(body,signal)=>request('search',body,signal)};
}
export function voyageTimes(record){
    const first=record.legs.find(leg=>leg.mode==='ocean')||record.legs[0],last=record.legs.at(-1);
    const departures=first?.events.filter(e=>e.event_type==='departure')||[];
    const planned=departures.find(e=>e.event_kind==='planned')||departures.find(e=>e.event_kind==='estimated')||departures.find(e=>e.event_kind==='unknown');
    const actual=departures.find(e=>e.event_kind==='actual');
    const arrivals=last?.events.filter(e=>e.event_type==='arrival')||[];
    return{first,last,planned,actual,departure:planned||actual,arrival:arrivals.find(e=>e.event_kind==='actual')||arrivals.find(e=>e.event_kind==='estimated')||arrivals[0]};
  }
export function transitLabel(transit){
    if(transit?.source_total_days!=null)return transit.source_total_days+' 天';
    const hours=transit?.source_total_hours;
    if(hours==null)return transit?.source_total_minutes!=null?transit.source_total_minutes+' 分钟':'未提供';
    const match=/^(\d+)(?:\.(\d+))?$/u.exec(hours);
    if(!match)return hours+' 小时';
    const whole=BigInt(match[1]),days=whole/24n,remainder=whole%24n;
    const fraction=(match[2]||'').replace(/0+$/u,'');
    const rest=String(remainder)+(fraction?'.'+fraction:'');
    return days>0n?String(days)+' 天'+(remainder>0n||fraction?' '+rest+' 小时':''):rest+' 小时';
  }

export function selectableSailings(response){
  const d=response?.data;
  return response?.status==='success'&&d?.coverage?.complete&&d?.provenance?.kind==='live'&&!d?.quality?.conflicts?.length&&!response.blockers?.length?d.records||[]:[];
}
// FCL carrier identifies the quoted sales source, not the vessel operator.
// The existing rate detail contract accepts whole days only. Never round a source duration.
export function scheduleToRateDetail(record,rateId,sourceCarrier){
  const {first,departure,arrival}=voyageTimes(record);
  const date=e=>{const value=(e?.local_date||e?.local_datetime||'').slice(0,10);return /^\d{4}-\d{2}-\d{2}$/u.test(value)?value:null;};
  const transit=record.transit||{};
  const exactDays=transit.source_total_days??(transit.source_total_hours&&Number(transit.source_total_hours)/24)??(transit.source_total_minutes&&Number(transit.source_total_minutes)/1440);
  const days=Number(exactDays);
  return {rate_id:rateId,carrier:sourceCarrier||record.operating_carrier||'',routing:record.routing==='direct'?'直达':record.routing==='transshipment'?'中转':'待确认',vessel:first?.vessel_name||null,voyage:first?.voyage||null,etd:date(departure),eta:date(arrival),transit_days:Number.isInteger(days)&&days>=1&&days<=180?days:null};
}
