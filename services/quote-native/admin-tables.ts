/** Adapted from PricingSettingsPage.buildMatrixRows and zone_price_spreadsheet.py.
 * Source commit and adaptation evidence: provenance.json. Fixed enterprise origin;
 * no legacy DB writes, defaults, alias guesses or automatic publication. */
import {z} from 'zod';
import type {ResidentialRates} from './contracts';
const money=/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/u,decimal=/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,4})?$/u;
export const rateTableInput=z.object({table:z.enum(['rates','zones']).default('rates'),selection:z.enum(['draft','published']).default('draft'),origin:z.string().trim().min(1).max(100).optional()}).strict();
export type TableKind='rates'|'zones';
export type RateSheet={table:TableKind;rates:ResidentialRates['rates'];zones:ResidentialRates['zones'];controls:Array<{zone:number;enabled?:boolean;fuel_percent?:string|null}>;errors:string[];source_rows:number};
const aliases:Record<string,string[]>={origin:['origin','origin_warehouse','warehouse','始发仓','始发仓库','仓库'],zone:['zone','分区','区域'],pallets:['billing_pallets','billing_pallet','pallets','pallet_count','托数','计费托数'],amount:['base_price_usd','base_price','price_usd','基础派送费_usd','基础派送费','基础价格','价格','amount'],fuel:['fuel_percent','fuel_surcharge_percent','燃油附加比例','燃油附加比例_%','燃油比例','燃油比例_%'],enabled:['enabled','启用','分区启用'],postal:['postal_prefix','postal_code','fsa','邮编','邮编前缀'],city:['city','城市','标准城市'],province:['province','省份','省份代码']};
const normalize=(v:string)=>v.trim().replace(/^\uFEFF/u,'').toLowerCase().replace(/[%％]/gu,' percent ').replace(/[\s\-./\\（）()]+/gu,'_').replace(/_+/gu,'_').replace(/^_|_$/gu,'');
const text=(v:unknown)=>typeof v==='string'?v.trim():typeof v==='number'||typeof v==='boolean'?String(v):'';
export function buildPriceMatrix(records:ResidentialRates['rates']){
 const rows=new Map<number,{zone:number;records:Map<number,ResidentialRates['rates'][number]>}>();
 records.forEach(record=>{const row=rows.get(record.zone)??{zone:record.zone,records:new Map()};row.records.set(record.pallets,record);rows.set(record.zone,row);});
 return [...rows.values()].sort((a,b)=>a.zone-b.zone);
}
export function parseRateSheet(rows:unknown[][],table:TableKind,origin:string):RateSheet{
 const result:RateSheet={table,rates:[],zones:[],controls:[],errors:[],source_rows:0};
 const error=(message:string)=>{if(result.errors.length<50)result.errors.push(message);};
 if(rows.length<2){error('表格需要标题行和至少一行数据。');return result;}if(rows.length>5001||rows.some(row=>row.length>100)){error('表格最多 5000 行、100 列。');return result;}
 const headers=rows[0]!,columns=new Map<string,number>(),pallets=new Map<number,number>();
 headers.forEach((v,i)=>{const h=normalize(text(v)),key=Object.keys(aliases).find(k=>aliases[k]!.some(a=>normalize(a)===h));if(key){if(columns.has(key))error(`标题列重复：${text(v)}`);columns.set(key,i);return;}
 const match=/^(?:(\d+)_?(?:pallet|pallets|托|托数)(?:_?(?:price|usd|价格))?|(?:pallet|pallets|托|托数)_?(\d+)(?:_?(?:price|usd|价格))?|(?:base_price|price)_?(\d+)(?:_?usd)?)$/u.exec(h);if(match){const p=Number(match[1]??match[2]??match[3]);if(p<1||p>1000||pallets.has(p))error(`托数列无效或重复：${text(v)}`);pallets.set(p,i);}});
 for(const key of table==='zones'?['zone','postal','city','province']:['zone'])if(!columns.has(key))error(`缺少列：${key}`);
 if(table==='rates'&&((columns.has('pallets')!==columns.has('amount'))||columns.has('pallets')&&pallets.size>0||!columns.has('pallets')&&pallets.size===0))error('使用「托数、价格」明细列，或「1托、2托…」矩阵列；两种格式不可混用。');
 const seen=new Set<string>(),controls=new Map<number,RateSheet['controls'][number]>();
 for(let index=1;index<rows.length;index++){
  const row=rows[index]!;if(row.every(v=>text(v)===''))continue;result.source_rows++;const at=`第 ${index+1} 行`;
  const get=(k:string)=>text(row[columns.get(k)??-1]);
  if(columns.has('origin')&&get('origin').toLowerCase()!==origin.trim().toLowerCase())error(`${at}始发仓与当前固定始发仓不一致。`);
  const zone=Number(get('zone'));if(!/^\d{1,3}$/u.test(get('zone'))){error(`${at}分区应为 0–999 的整数。`);continue;}
  if(table==='zones'){
   const postal=get('postal').replaceAll(' ','').toUpperCase(),city=get('city'),province=get('province').toUpperCase();
   if(!/^[ABCEGHJKLMNPRSTVXY][0-9][ABCEGHJKLMNPRSTVWXYZ](?:[0-9][ABCEGHJKLMNPRSTVWXYZ][0-9])?$/u.test(postal)||!city||city.length>100||!/^[A-Z]{2}$/u.test(province))error(`${at}请核对邮编、城市和两位省份代码。`);
   if(seen.has(postal))error(`${at}邮编重复。`);seen.add(postal);result.zones.push({postal_prefix:postal,zone,city,province});continue;
  }
  if(get('fuel')!==''||get('enabled')!==''){
   const fuel=get('fuel'),rawEnabled=get('enabled').toLowerCase(),enabled=rawEnabled===''?true:['true','1','是','启用'].includes(rawEnabled);
   if(fuel&&!decimal.test(fuel)||rawEnabled&&!['true','1','是','启用','false','0','否','停用'].includes(rawEnabled))error(`${at}燃油比例或启用状态无效。`);
   const control={zone,...(rawEnabled?{enabled}:{}),...(fuel?{fuel_percent:fuel}:{})},old=controls.get(zone);if(old&&JSON.stringify(old)!==JSON.stringify(control))error(`${at}同一分区燃油比例或启用状态冲突。`);controls.set(zone,control);
  }
  const cells=columns.has('pallets')?[[Number(get('pallets')),columns.get('amount')!] as const]:[...pallets.entries()];
  for(const[p,column]of cells){const amount=text(row[column]);if(amount===''&&!columns.has('pallets'))continue;
   if(!Number.isInteger(p)||p<1||p>1000||columns.has('pallets')&&!/^\d+$/u.test(get('pallets'))){error(`${at}托数须为 1–1000 的整数。`);continue;}
   if(!money.test(amount)){error(`${at} ${p} 托价格无效：请填写非负金额，最多两位小数。`);continue;}
   const key=`${zone}:${p}`;if(seen.has(key))error(`${at}分区 ${zone} / ${p} 托重复。`);seen.add(key);result.rates.push({zone,pallets:p,amount});
  }
 }
 result.controls=[...controls.values()];if(result.rates.length>10000)error('展开后最多支持 10000 个价格。');
 if(!result.rates.length&&!result.zones.length)error('没有可导入的价格或邮编。');return result;
}
export function mergeRateSheet<T extends Pick<ResidentialRates,'rates'|'zones'> & Partial<ResidentialRates>>(draft:T,parsed:RateSheet):T{
 if(parsed.errors.length)throw new Error('rate_import_invalid');const next=structuredClone(draft);
 if(parsed.table==='rates'){
  const rows=new Map(next.rates.map(r=>[`${r.zone}:${r.pallets}`,r]));parsed.rates.forEach(r=>rows.set(`${r.zone}:${r.pallets}`,r));next.rates=[...rows.values()].sort((a,b)=>a.zone-b.zone||a.pallets-b.pallets);
  const controls=new Map((next.extensions?.zone_controls_v1??[]).map(c=>[c.zone,c]));parsed.controls.forEach(c=>controls.set(c.zone,{enabled:true,fuel_percent:null,...controls.get(c.zone),...c}));if(controls.size)next.extensions={...next.extensions,zone_controls_v1:[...controls.values()].sort((a,b)=>a.zone-b.zone)};
 }else{const rows=new Map(next.zones.map(r=>[r.postal_prefix,r]));parsed.zones.forEach(r=>rows.set(r.postal_prefix,r));next.zones=[...rows.values()];}
 return next;
}
export async function readRateWorkbook(bytes:Uint8Array,name:string){
 if(bytes.length>5*1024*1024||bytes.length===0||!(/\.(csv|xlsx|xls)$/iu.test(name)))throw new Error('仅支持不超过 5 MiB 的 CSV、XLSX 或 XLS。');
 const XLSX=await import('xlsx');const book=XLSX.read(bytes,{type:'array',raw:true,cellFormula:true,sheetRows:5002,cellDates:false});
 const first=book.SheetNames[0];if(!first)throw new Error('表格没有工作表。');const sheet=book.Sheets[first]!;
 const range=XLSX.utils.decode_range(text(sheet['!fullref'])||text(sheet['!ref'])||'A1');if(range.e.r>5000||range.e.c>99)throw new Error('表格最多 5000 行、100 列。');
 const cells:Record<string,unknown>=sheet;
 for(const[key,cell]of Object.entries(cells))if(!key.startsWith('!')&&cell&&typeof cell==='object'&&'f' in cell&&cell.f)throw new Error('表格含公式，请粘贴为数值后导入。');
 return {sheet:first,rows:XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,raw:true,defval:'',blankrows:true})};
}
export function exportRateRows(draft:Pick<ResidentialRates,'rates'|'zones'|'origin'> & Partial<ResidentialRates>,table:TableKind):string{
 const escape=(v:unknown)=>'"'+text(v).replace(/^([=+@-])/u,"'$1").replaceAll('"','""')+'"';
 const rows:unknown[][]=table==='zones'?[['始发仓','邮编','分区','城市','省份'],...draft.zones.map(z=>[draft.origin,z.postal_prefix,z.zone,z.city,z.province])]:[['始发仓','分区','托数','价格','燃油比例','启用'],...draft.rates.map(r=>{const c=draft.extensions?.zone_controls_v1.find(c=>c.zone===r.zone);return [draft.origin,r.zone,r.pallets,r.amount,c?.fuel_percent??'',c?String(c.enabled):''];})];
 return '\uFEFF'+rows.map(row=>row.map(escape).join(',')).join('\r\n')+'\r\n';
}

export function selectRateOrigin(draft:ResidentialRates,origin?:string):ResidentialRates{
 if(!origin||origin===draft.origin)return draft;
 const index=draft.extensions?.origins_v1?.findIndex(p=>p.origin===origin)??-1;if(index<0)throw new Error('rate_origin_not_found');
 const next=structuredClone(draft),profiles=next.extensions!.origins_v1!,selected=profiles[index]!;
 profiles[index]={origin:next.origin,zones:next.zones,rates:next.rates,zone_controls_v1:next.extensions!.zone_controls_v1};
 return {...next,origin:selected.origin,zones:selected.zones,rates:selected.rates,extensions:{...next.extensions!,zone_controls_v1:selected.zone_controls_v1}};
}
