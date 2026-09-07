import { createHash } from 'node:crypto';
import { customsDatasetSchema, type CustomsDataset } from './contracts';
import type { NomenclatureRow } from './upstream/worker/repositories/customs';
import type { NativeCustomsRelease } from './engine';
export function validateCustomsDataset(input:unknown):string[]{
 const parsed=customsDatasetSchema.safeParse(input);if(!parsed.success)return ['关务数据格式不完整，请按导入规范检查字段、日期和来源哈希。'];
 const d=parsed.data,errors:string[]=[];
 if(d.test_data)errors.push('测试数据不能发布到正式查询。');
 const unique=(values:readonly (number|string)[])=>new Set(values).size===values.length;
 if(!unique(d.sources.map(s=>s.id)))errors.push('来源编号重复。');
 const sources=new Map(d.sources.map(s=>[s.id,s]));
 for(const source of d.sources){
  try{const url=new URL(source.official_url);if(url.protocol!=='https:'||url.username||url.password||url.hostname==='example.com'||url.hostname.endsWith('.invalid')||url.hostname.endsWith('.test'))throw new Error();}catch{errors.push('来源必须是可核对的官方 HTTPS 地址。');}
  if(!source.id||!source.authority||!source.dataset||!source.edition||!source.revision||!source.parser_name||!source.parser_version||!Number.isFinite(Date.parse(source.retrieved_at))||!Number.isFinite(Date.parse(source.published_at)))errors.push('来源版本、发布日期或解析器信息缺失。');
  if(source.effective_from>d.rule_date||source.effective_to!==null&&source.effective_to<d.rule_date)errors.push('来源不覆盖本次核验日期。');
 }
 for(const rows of [d.nomenclature,d.tariffs,d.measures,d.requirements]){
  if(!unique(rows.map(r=>r.id)))errors.push('同一数据表内的记录编号重复。');
  for(const row of rows){const s=sources.get(row.release_id);if(!s||row.country!==s.country||row.release_manifest_sha256!==s.manifest_sha256||!row.artifact_id||!row.source_locator)errors.push('记录与来源版本、国家或证据引用不一致。');
   if(row.effective_to!==null&&row.effective_to<row.effective_from)errors.push('记录有效期倒置。');
   for(const [k,v]of Object.entries(row))if(k.endsWith('_json'))try{JSON.parse(String(v));}catch{errors.push('结构化规则字段不是有效 JSON。');}
  }
 }
 const codes=new Set<string>();for(const row of d.nomenclature){const key=[row.country,row.code,row.language].join(':');if(codes.has(key))errors.push('同一国家、编码、语言存在多个版本；请先消除重叠。');codes.add(key);if(!/^\d{4,10}$/u.test(row.code)||row.code.length!==row.code_digits||![0,1].includes(row.is_declarable))errors.push('税号层级或申报标识无效。');if(row.concept_code&&!/^\d{6}$/u.test(row.concept_code))errors.push('HS6 映射无效。');}
 return [...new Set(errors)];
}
export function customsRelease(d:CustomsDataset,id:string,publishedAt:string):NativeCustomsRelease{
 const sources=d.sources.map(s=>({...s,status:'published' as const}));
 const normalize=<T extends {release_id:string}>(row:T)=>{const s=sources.find(s=>s.id===row.release_id)!;return {...row,release_status:'published' as const,release_authority:s.authority,release_dataset:s.dataset,release_edition:s.edition,release_revision:s.revision,release_languages_json:s.languages_json,release_official_url:s.official_url,release_published_at:s.published_at,release_effective_from:s.effective_from,release_effective_to:s.effective_to,release_retrieved_at:s.retrieved_at,release_manifest_sha256:s.manifest_sha256,release_parser_name:s.parser_name,release_parser_version:s.parser_version,release_supersedes_id:s.supersedes_id};};
 const approvals=sources.map((s,i)=>`${id}:${i}`),gate=createHash('sha256').update([...sources.map(s=>`${s.id}:${s.manifest_sha256}`),...approvals].sort().join('|')).digest('hex');
 return {release_id:id,...(d.exchange_rates?{exchange_rates:d.exchange_rates}:{}),nomenclature:d.nomenclature.map(normalize) as NomenclatureRow[],tariffs:d.tariffs.map(normalize),measures:d.measures.map(normalize),requirements:d.requirements.map(normalize),sources,snapshot:{id,evaluated_at:publishedAt,rule_date:d.rule_date,ready:d.test_data?0:1,test_data:d.test_data?1:0,release_ids_json:JSON.stringify(sources.map(s=>s.id)),approval_ids_json:JSON.stringify(approvals),reasons_json:'[]',gate_report_sha256:gate,last_source_check_at:[...sources].map(s=>s.retrieved_at).sort()[0]??null}};
}
