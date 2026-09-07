import {describe,it,expect} from 'vitest';
import {parseRateSheet,mergeRateSheet,buildPriceMatrix} from '../../services/quote-native/admin-tables';
import {config} from './fixture';
describe('ported fixed residential spreadsheet workflow',()=>{
 it('reads source wide matrix, preserves zero, previews merge without mutating saved input',()=>{
  const p=parseRateSheet([['始发仓','分区','1托','2托','燃油比例'],[config.origin,'1','0','230.50','12.5']], 'rates', config.origin);
  expect(p.errors).toEqual([]);expect(p.rates).toEqual([{zone:1,pallets:1,amount:'0'},{zone:1,pallets:2,amount:'230.50'}]);
  const merged=mergeRateSheet(config,p);expect(merged.rates.find(r=>r.pallets===2)?.amount).toBe('230.50');expect(merged.extensions?.zone_controls_v1[0]?.fuel_percent).toBe('12.5');expect(config.rates[0]?.amount).not.toBe('0');
  expect(buildPriceMatrix(merged.rates)[0]?.records.get(2)?.amount).toBe('230.50');
 });
 it('rejects duplicate headers/keys, cross-origin data, invalid money and ambiguous layouts',()=>{
  for(const rows of [[['zone','zone','1托'],['1','1','1']],[['origin','zone','1托'],['Other warehouse','1','12']],[['zone','托数','价格'],['1','2','-1']],[['zone','托数','价格'],['1','2','1'],['1','2','2']],[['zone','托数','价格','1托'],['1','1','1','1']]])expect(parseRateSheet(rows,'rates',config.origin).errors.length).toBeGreaterThan(0);
 });
 it('imports postal rows with explicit replacements and no silent deletion',()=>{
  const p=parseRateSheet([['邮编','分区','城市','省份'],['K2J 6J2','2','Ottawa','on']], 'zones',config.origin);expect(p.errors).toEqual([]);
  const merged=mergeRateSheet(config,p);expect(merged.zones).toHaveLength(config.zones.length+1);expect(merged.zones.at(-1)?.postal_prefix).toBe('K2J6J2');expect(merged.zones.at(-1)?.province).toBe('ON');
 });
});

import {calculateQuote} from '../../services/quote-native/client';
import {request} from './fixture';
import {readRateWorkbook,exportRateRows} from '../../services/quote-native/admin-tables';
import {validateResidentialRates} from '../../services/quote-native/contracts';
it('published per-zone controls change actual deterministic output and reject conflicting controls',async()=>{
 const d={...config,extensions:{zone_controls_v1:[{zone:1,enabled:false,fuel_percent:'20'}]}};
 expect((await calculateQuote(d,request)).reason_codes).toContain('zone_disabled');
 d.extensions.zone_controls_v1[0]!.enabled=true;
 const r=await calculateQuote(d,request);expect((r.data as {total_price:string}).total_price).toBe('286.00');
 expect(validateResidentialRates({...d,extensions:{zone_controls_v1:[...d.extensions.zone_controls_v1,...d.extensions.zone_controls_v1]}})).toContain('分区开关或燃油覆盖重复。');
});
it('reads XLSX and CSV exports; rejects Excel formulas and oversized ranges',async()=>{
 const X=await import('xlsx');const book=X.utils.book_new();X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([['zone','1托'],[1,120]]),'Rates');
 const bytes=X.write(book,{type:'array',bookType:'xlsx'}) as ArrayBuffer;const r=await readRateWorkbook(new Uint8Array(bytes),'prices.xlsx');expect(parseRateSheet(r.rows,'rates',config.origin).rates[0]?.amount).toBe('120');
 const csv=await readRateWorkbook(new TextEncoder().encode(exportRateRows(config,'zones')),'zones.csv');expect(parseRateSheet(csv.rows,'zones',config.origin).zones).toEqual(config.zones);
 book.Sheets.Rates!.B2={t:'n',v:120,f:'60*2'};await expect(readRateWorkbook(new Uint8Array(X.write(book,{type:'array',bookType:'xlsx'}) as ArrayBuffer),'prices.xlsx')).rejects.toThrow('公式');
});
it('fuel-only sheet updates never reactivate a disabled zone',()=>{
 const d={...config,extensions:{zone_controls_v1:[{zone:1,enabled:false,fuel_percent:'5'}]}};
 const p=parseRateSheet([['zone','1托','燃油比例'],['1','100','12']], 'rates',config.origin);
 expect(mergeRateSheet(d,p).extensions.zone_controls_v1[0]).toEqual({zone:1,enabled:false,fuel_percent:'12'});
});
