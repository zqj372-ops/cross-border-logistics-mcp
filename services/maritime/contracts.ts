import { z } from 'zod';

export type MaritimeKind = 'schedules' | 'terminals';
export const MARITIME_VERSION = 'maritime-query@2026-09-08.v1';
export const originPorts = {CNSHA:'上海',CNNGB:'宁波',CNSZX:'深圳',CNTAO:'青岛',CNXMN:'厦门',CNTXG:'天津'} as const;
export const destinationPorts = {CAVAN:'温哥华',CAPRR:'鲁珀特王子港',CAMTR:'蒙特利尔',CAHAL:'哈利法克斯'} as const;
export const metrics = {
  rail_dwell_days:{label:'进口铁路滞箱时间',unit:'days',unitLabel:'天'},
  anchorage_wait_hours:{label:'锚地等待时间',unit:'hours',unitLabel:'小时'},
  truck_turn_minutes:{label:'闸口周转时间',unit:'minutes',unitLabel:'分钟'},
  on_dock_feet:{label:'进口堆场占用长度',unit:'feet',unitLabel:'英尺'},
} as const;
const text = (max = 120) => z.string().trim().min(1).max(max);
const offsetTime = z.iso.datetime({offset:true});
const port = z.enum(['CAVAN','CAPRR','CAMTR','CAHAL']);
const origin = z.enum(['CNSHA','CNNGB','CNSZX','CNTAO','CNXMN','CNTXG']);
const source = z.object({name:text(),url:z.url({protocol:/^https$/u}).max(2000).refine(value=>!new URL(value).username&&!new URL(value).password),version:text(),observed_at:offsetTime,expires_at:offsetTime,verified:z.boolean()}).strict();
const event = z.enum(['planned','estimated','actual']);
export const sailingRow = z.object({id:text(80),origin,destination:port,carrier:text(),vessel:text(),voyage:text(80),departure:offsetTime,arrival:offsetTime,departure_kind:event,arrival_kind:event,routing:z.enum(['direct','transshipment']),via:text().nullable()}).strict();
export const terminalRow = z.object({id:text(80),port,terminal:text(),metric:z.enum(['rail_dwell_days','anchorage_wait_hours','truck_turn_minutes','on_dock_feet']),value:z.string().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/u).nullable(),unit:z.enum(['days','hours','minutes','feet']),period_start:offsetTime,period_end:offsetTime,definition:text(500),missing_reason:text(500).nullable()}).strict();
const schedules = z.object({label:text(),source,records:z.array(sailingRow).max(500)}).strict();
const terminals = z.object({label:text(),source,records:z.array(terminalRow).max(500)}).strict();
export type MaritimeDataset = z.infer<typeof schedules> | z.infer<typeof terminals>;
export const maritimeDatasetSchema = (kind:MaritimeKind) => kind==='schedules'?schedules:terminals;
export const maritimeSaveSchema = (kind:MaritimeKind) => z.object({expected_version:z.number().int().nonnegative(),input:maritimeDatasetSchema(kind)}).strict();
export const maritimeQuerySchema = (kind:MaritimeKind) => kind==='schedules' ? z.object({origin,destination:port,from:z.iso.date(),until:z.iso.date(),carrier:text().optional()}).strict().refine(q=>q.until>=q.from&&Date.parse(q.until)-Date.parse(q.from)<=90*86400000) : z.object({port,terminal:text().optional(),metric:terminalRow.shape.metric.optional()}).strict();

export function validateMaritimeDataset(kind:MaritimeKind,input:unknown,now=new Date()):string[] {
  const parsed=maritimeDatasetSchema(kind).safeParse(input);
  if(!parsed.success)return ['maritime_data_invalid'];
  const d=parsed.data, errors:string[]=[];
  if(!d.source.verified)errors.push('source_unverified');
  if(Date.parse(d.source.observed_at)>now.getTime())errors.push('source_observed_in_future');
  if(Date.parse(d.source.expires_at)<=now.getTime()||Date.parse(d.source.expires_at)<=Date.parse(d.source.observed_at))errors.push('source_expired');
  if(!d.records.length)errors.push('records_required');
  const ids=new Set(),identities=new Set();
  for(const r of d.records){
    const identity='origin' in r ? JSON.stringify([r.origin,r.destination,r.carrier,r.vessel,r.voyage,r.departure]) : JSON.stringify([r.port,r.terminal,r.metric,r.period_start,r.period_end]);
    if(ids.has(r.id)||identities.has(identity))errors.push('duplicate_records');ids.add(r.id);identities.add(identity);
    if('origin' in r){
      if(Date.parse(r.arrival)<Date.parse(r.departure))errors.push('arrival_before_departure');
      if((r.routing==='direct')!==(r.via===null))errors.push('routing_via_conflict');
      if(r.departure_kind==='actual'&&Date.parse(r.departure)>Date.parse(d.source.observed_at)||r.arrival_kind==='actual'&&Date.parse(r.arrival)>Date.parse(d.source.observed_at))errors.push('actual_event_after_observation');
    }else{
      if(metrics[r.metric].unit!==r.unit)errors.push('metric_unit_mismatch');
      if(Date.parse(r.period_end)<Date.parse(r.period_start)||Date.parse(r.period_end)>Date.parse(d.source.observed_at))errors.push('metric_period_invalid');
      if(r.value===null&&!r.missing_reason)errors.push('missing_value_reason_required');
      if(r.value!==null&&r.missing_reason!==null)errors.push('value_reason_conflict');
    }
  }
  return [...new Set(errors)];
}
export interface MaritimePublication {release_id:string;version:number;input:unknown;published_at:string;digest:string}
export const maritimeResponseSchema = (kind:MaritimeKind) => z.object({schema_version:z.literal(MARITIME_VERSION),status:z.enum(['success','needs_input','manual_review','blocked','unavailable']),data:z.object({records:z.array(kind==='schedules'?sailingRow:terminalRow).max(500),source:source.nullable(),release:z.object({id:z.string(),version:z.number().int(),published_at:offsetTime,digest:z.string().regex(/^[a-f0-9]{64}$/u)}).strict().nullable()}).strict(),reason_codes:z.array(z.string()).max(20)}).strict();
export function queryMaritime(kind:MaritimeKind,input:unknown,release:MaritimePublication|null,now=new Date()) {
  const query=maritimeQuerySchema(kind).safeParse(input);
  const empty={records:[],source:null,release:null};
  if(!query.success)return {schema_version:MARITIME_VERSION,status:'needs_input' as const,data:empty,reason_codes:['maritime_query_invalid']};
  if(!release)return {schema_version:MARITIME_VERSION,status:'unavailable' as const,data:empty,reason_codes:['maritime_not_published']};
  const parsed=maritimeDatasetSchema(kind).safeParse(release.input);
  if(!parsed.success)return {schema_version:MARITIME_VERSION,status:'unavailable' as const,data:empty,reason_codes:['maritime_data_invalid']};
  const data=parsed.data,q=query.data;
  const records=data.records.filter(r=> 'origin' in r&&'origin' in q ? r.origin===q.origin&&r.destination===q.destination&&r.departure.slice(0,10)>=q.from&&r.departure.slice(0,10)<=q.until&&(!q.carrier||r.carrier.toLocaleLowerCase().includes(q.carrier.toLocaleLowerCase())) : 'port' in r&&'port' in q&&r.port===q.port&&(!q.terminal||r.terminal.toLocaleLowerCase().includes(q.terminal.toLocaleLowerCase()))&&(!q.metric||r.metric===q.metric));
  const reasons=validateMaritimeDataset(kind,data,now);
  if(records.some(r=>'value' in r&&r.value===null))reasons.push('metric_value_missing');
  if(!records.length)reasons.push('no_matching_records');
  return {schema_version:MARITIME_VERSION,status:reasons.some(r=>r!=='no_matching_records')?'manual_review' as const:'success' as const,data:{records,source:data.source,release:{id:release.release_id,version:release.version,published_at:release.published_at,digest:release.digest}},reason_codes:reasons};
}

// These are reviewed navigation links, not API connectors or current measurements.
export const maritimeSources = [
  {name:'Maersk 船期',kind:'schedules',ports:[],url:'https://www.maersk.com/schedules/',description:'船司点到点、港口挂靠与船舶船期；在官方页面确认查询条件。'},
  {name:'鲁珀特王子港 · 到离港',kind:'schedules',ports:['CAPRR'],url:'https://www.rupertport.com/arrivals-departures/',description:'港务局到离港与泊位记录；不等同于中国起运港的可订航线。'},
  {name:'蒙特利尔港 · 实时运营',kind:'schedules',ports:['CAMTR'],url:'https://www.port-montreal.com/en/goods/real-time',description:'进入港务局船期、船舶在港与预计到港页面。'},
  {name:'加拿大交通部 · 港口看板',kind:'terminals',ports:['CAVAN','CAPRR','CAMTR','CAHAL'],url:'https://tdih-cdit.tc.canada.ca/en/dashboard/marine-and-port-dashboard',description:'港口统计与铁路滞箱指标；按页面注明的统计周期使用。'},
  {name:'蒙特利尔港 · 效率报告',kind:'terminals',ports:['CAMTR'],url:'https://www.port-montreal.com/en/goods/real-time',description:'查看码头、铁路、卡车与滞箱时间报告。'},
] as const;
