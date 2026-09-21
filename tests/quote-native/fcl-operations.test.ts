import {expect,it} from 'vitest';
import {calculateFclEstimate} from '../../services/quote-native/fcl-operations';
import {operationsFixture,estimateRequest,cosco} from './fixtures/fcl-operations';

it('calculates independent ocean, destination, customs, inland, reserve and margin with explicit FX',()=>{
  const result=calculateFclEstimate(operationsFixture(),estimateRequest(),cosco,'calgary');
  expect(result.blockers).toEqual([]);
  expect(result.totals.cost_total).toBe('30800.00');
  expect(result.totals.sell_total).toBe('33880.00');
  expect(result.totals.gross_profit).toBe('3080.00');
  expect(result.totals.gross_margin).toBe('0.090909');
  expect(result.lines).toHaveLength(5);
  expect(result.quote_status).toBe('system_estimated');
  const changed=operationsFixture();changed.rates[0]!.items[0]!.ocean_freight='3500';
  const next=calculateFclEstimate(changed,estimateRequest(),cosco,'calgary');
  expect(next.totals.cost_total).toBe('32900.00');
  expect(next.lines.slice(1)).toEqual(result.lines.slice(1));
});

it('never guesses a missing FX, component price or out-of-range inland tier',()=>{
  const data=operationsFixture();data.operations.templates[0]!.exchange_rates.USD=null;
  expect(calculateFclEstimate(data,estimateRequest(),cosco,'calgary').totals.cost_total).toBeNull();
  data.operations.templates[0]!.charge_ids.push('missing');
  expect(calculateFclEstimate(data,estimateRequest(),cosco,'calgary').blockers).toContain('charge_unavailable:missing');
});

it('selects by shipping date, blocks ambiguity and distinguishes markup from target margin',()=>{
  const data=operationsFixture();
  expect(calculateFclEstimate(data,{...estimateRequest(),shipping_date:'2027-01-01'},cosco,'calgary').blockers).toContain('ocean_rate_expired');
  data.operations.templates[0]!.margin_rule={mode:'gross_margin',value:'0.2'};
  expect(calculateFclEstimate(data,estimateRequest(),cosco,'calgary').totals.gross_margin).toBe('0.200000');
  data.operations.charges.push({...data.operations.charges[0]!,version:2});
  expect(calculateFclEstimate(data,estimateRequest(),cosco,'calgary').blockers).toContain('charge_ambiguous:thc');
});

it('rejects overlapping validity, duplicate references and invalid capacity before publication',async()=>{
  const {fclRateDatasetSchema}=await import('../../services/quote-native/fcl-contracts');
  const data=operationsFixture();data.operations.charges.push({...data.operations.charges[0]!,version:2});
  expect(fclRateDatasetSchema.safeParse(data).success).toBe(false);
  const capacity=operationsFixture();capacity.operations.delivery_rates[0]!.weight_min_kg='20000';capacity.operations.delivery_rates[0]!.weight_max_kg='10000';
  expect(fclRateDatasetSchema.safeParse(capacity).success).toBe(false);
  const badRef=operationsFixture();badRef.operations.templates[0]!.charge_ids.push('missing');expect(fclRateDatasetSchema.safeParse(badRef).success).toBe(false);
  const tiers=operationsFixture();tiers.operations.delivery_rates[0]!.tiers=[{min_kg:'0',max_kg:'10000',amount:'100'},{min_kg:'10000',max_kg:'20000',amount:'200'}];expect(fclRateDatasetSchema.safeParse(tiers).success).toBe(false);
});

it('bills per container separately from per shipment and chooses dated cost versions',()=>{
  const data=operationsFixture();const old=data.operations.charges[0]!;old.valid_until='2026-10-20';
  data.operations.charges.push({...old,version:2,valid_from:'2026-10-21',valid_until:'2026-12-31',amount:'150'});
  const request={...estimateRequest(),containers:[{type:'40HQ' as const,quantity:2}]};
  const first=calculateFclEstimate(data,request,cosco,'calgary');const later=calculateFclEstimate(data,{...request,shipping_date:'2026-10-25'},cosco,'calgary');
  expect(first.lines.find(l=>l.code==='ocean_freight')?.cost_amount).toBe('6400.00');
  expect(first.lines.find(l=>l.code==='thc')?.cost_amount).toBe('100.00');
  expect(later.lines.find(l=>l.code==='thc')?.cost_amount).toBe('150.00');
  expect(first.source_refs).toContainEqual({ref:'charge:thc',version:'1'});
  expect(later.source_refs).toContainEqual({ref:'charge:thc',version:'2'});
});
