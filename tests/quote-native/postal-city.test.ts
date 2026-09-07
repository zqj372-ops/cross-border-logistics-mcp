import {it,expect} from 'vitest';
import {config,request} from './fixture';
import {calculateQuote} from '../../services/quote-native/client';
import {validateResidentialRates} from '../../services/quote-native/contracts';
import {parseRateSheet,mergeRateSheet} from '../../services/quote-native/admin-tables';
const zones=[{postal_prefix:'T0L',city:'ALDERSYDE',province:'AB',zone:1},{postal_prefix:'T0L',city:'CLARESHOLM',province:'AB',zone:2}];
const rates=[{zone:1,pallets:1,amount:'100.00'},{zone:2,pallets:1,amount:'200.00'}];
const data={...config,origin:'calgary',zones,rates,extensions:{zone_controls_v1:[],postal_city_v1:true as const}};
const input={...request,postal_code:'T0L1A0',province:'AB',city:'Aldersyde',cbm:'1',weight_kg:'100',piece_count:1,longest_side_cm:'100'};
it('uses source city conditions for split FSA instead of rejecting the entire prefix',async()=>{expect(validateResidentialRates(data)).toEqual([]);expect((await calculateQuote(data,input)).data).toMatchObject({zone:1,base_price:'100.00',matched_by:'published_postal_city'});expect((await calculateQuote(data,{...input,city:' clAREsholm '})).data).toMatchObject({zone:2,base_price:'200.00'});expect((await calculateQuote(data,{...input,city:null})).reason_codes).toContain('postal_city_required');expect((await calculateQuote(data,{...input,city:'Unknown'})).status).toBe('manual_review');});
it('preserves genuine same-city conflicting zones and never chooses by price or row order',async()=>{const bad={...data,zones:[...zones,{...zones[0]!,zone:2}]};expect(validateResidentialRates(bad)).toEqual([]);expect((await calculateQuote(bad,input)).reason_codes).toContain('postal_zone_conflict');expect(validateResidentialRates({...data,extensions:{zone_controls_v1:[]}})).toContain('邮编覆盖重复。');});
it('round trips different cities in a postal table and leaves unrelated conflicts unchanged',()=>{const parsed=parseRateSheet([['邮编','城市','省份','分区'],['T0L','ALDERSYDE','AB','1'],['T0L','CLARESHOLM','AB','2']],'zones','calgary',true);expect(parsed.errors).toEqual([]);const conflict={...data,zones:[...zones,{postal_prefix:'H8Y',city:'PIERREFONDS',province:'QC',zone:1},{postal_prefix:'H8Y',city:'PIERREFONDS',province:'QC',zone:2}]};const merged=mergeRateSheet(conflict,parsed);expect(merged.zones.filter(z=>z.postal_prefix==='H8Y')).toHaveLength(2);expect(merged.zones).toHaveLength(4);});

it('imports an existing conflicting city without silently discarding a zone',()=>{const result=parseRateSheet([['邮编','城市','省份','分区'],['H8Y','PIERREFONDS','QC','7'],['H8Y','PIERREFONDS','QC','8']],'zones','toronto',true);expect(result.errors).toEqual([]);expect(result.zones).toHaveLength(2);});
