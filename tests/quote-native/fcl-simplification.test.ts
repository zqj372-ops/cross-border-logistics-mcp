import {expect,it} from 'vitest';
import {prepareFclMaintenance} from '../../services/quote-native/fcl-maintenance';
import {calculateFclEstimate} from '../../services/quote-native/fcl-operations';
import {fclRateDatasetSchema} from '../../services/quote-native/fcl-contracts';
import {operationsFixture,estimateRequest,cosco} from './fixtures/fcl-operations';

it('uses ocean and template prices without maintenance dates and ignores historical expiry',()=>{
  const data=operationsFixture();
  data.operations.templates[0]!.delivery_rate_id=null;
  for(const row of [...data.rates,...data.operations.charges,...data.operations.templates]){
    Reflect.deleteProperty(row,'valid_from');Reflect.deleteProperty(row,'valid_until');
  }
  expect(fclRateDatasetSchema.safeParse(data).success).toBe(true);
  const result=calculateFclEstimate(data,{...estimateRequest(),shipping_date:'2027-03-01'},cosco,'calgary');
  expect(result.blockers).toEqual([]);
  expect(result.valid_until).toBeNull();
  data.rates[0]!.valid_until='2000-01-01';
  data.operations.templates[0]!.valid_until='2000-01-01';
  expect(calculateFclEstimate(data,estimateRequest(),cosco,'calgary').blockers).toEqual([]);
});

it('holds a legacy base ocean fee for explicit reconciliation without losing ancillary ocean charges',()=>{
  const data=operationsFixture();
  const base={...data.operations.charges[0]!,id:'old-ocean',code:'ocean_freight',name_zh:'海运费',name_en:'Ocean Freight',category:'ocean' as const,amount:'3200',currency:'USD' as const,unit:'CNTR' as const};
  data.operations.charges.push(base,{...base,id:'emf',code:'EMF',name_zh:'EMF',name_en:'EMF',amount:'35'});
  data.operations.templates[0]!.charge_ids.push('old-ocean','emf');
  const pending=calculateFclEstimate(data,estimateRequest(),cosco,'calgary');
  expect(pending.blockers).toContain('legacy_ocean_fee_review:old-ocean');
  expect(pending.totals.cost_total).toBeNull();
  Object.assign(base,{ocean_freight_resolution:{action:'exclude',reason:'Confirmed base freight comes from selected ocean record'}});
  const resolved=calculateFclEstimate(data,estimateRequest(),cosco,'calgary');
  expect(resolved.blockers).toEqual([]);
  expect(resolved.lines.filter(l=>l.code==='ocean_freight')).toHaveLength(1);
  expect(resolved.lines.find(l=>l.code==='EMF')?.cost_amount).toBe('35.00');
  expect(base.amount).toBe('3200');
});

it('blocks missing ocean prices and leaves previously calculated quotes unchanged on repricing',()=>{
  const data=operationsFixture(),before=calculateFclEstimate(data,estimateRequest(),cosco,'calgary');
  const saved=JSON.stringify(before);
  data.rates[0]!.items[0]!.ocean_freight='3500';
  expect(calculateFclEstimate(data,estimateRequest(),cosco,'calgary').totals.cost_total).toBe('32900.00');
  expect(JSON.stringify(before)).toBe(saved);
  data.rates[0]!.items=[];
  const missing=calculateFclEstimate(data,estimateRequest(),cosco,'calgary');
  expect(missing.blockers).toContain('container_unavailable:40HQ');
  expect(missing.totals.cost_total).toBeNull();
});

it('stamps changes on the server and preserves unresolved historical base freight during template editing',()=>{
  const previous=operationsFixture(),now='2026-09-22T12:00:00.000Z';
  const stamped=prepareFclMaintenance(previous,null,now);
  expect(stamped.rates[0]!.updated_at).toBe(now);
  const forged=structuredClone(stamped);forged.rates[0]!.updated_at='2099-01-01T00:00:00.000Z';
  expect(prepareFclMaintenance(forged,stamped,'2026-09-23T12:00:00.000Z').rates[0]!.updated_at).toBe(now);
  forged.rates[0]!.items[0]!.ocean_freight='3500';
  expect(prepareFclMaintenance(forged,stamped,'2026-09-23T12:00:00.000Z').rates[0]!.updated_at).toBe('2026-09-23T12:00:00.000Z');
  const base={...previous.operations.charges[0]!,id:'base-ocean',code:'ocean_freight',name_zh:'基础海运费',name_en:'Ocean Freight',amount:'3200',currency:'USD' as const};
  previous.operations.charges.push(base);previous.operations.templates[0]!.charge_ids.push(base.id);
  const dropped=structuredClone(previous);dropped.operations.charges=dropped.operations.charges.filter(row=>row.id!==base.id);
  expect(()=>prepareFclMaintenance(dropped,previous,now)).toThrow('fcl_legacy_ocean_fee_review');
  const unlinked=structuredClone(previous);unlinked.operations.templates[0]!.charge_ids=unlinked.operations.templates[0]!.charge_ids.filter(id=>id!==base.id);
  expect(()=>prepareFclMaintenance(unlinked,previous,now)).toThrow('fcl_legacy_ocean_fee_review');
  Object.assign(unlinked.operations.charges.at(-1)!,{ocean_freight_resolution:{action:'exclude',reason:'Confirmed from original source'}});
  expect(prepareFclMaintenance(unlinked,previous,now).contract_version).toBe(previous.contract_version);
  expect(previous.operations.charges.at(-1)!.amount).toBe('3200');
});
