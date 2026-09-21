import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {
  FCL_DOCUMENT_WORKFLOW_VERSION,
  buildFclCostSellSnapshot,
  fclQuoteDraftInputSchema,
  fclQuoteSnapshotSchema,
  fclQuoteSnapshotDigest,
  validateFclQuoteSnapshot,
  type FclQuoteSelectedSnapshot,
} from '../../services/quote-native/fcl';
import {fclRowAdjustmentsSchema} from '../../services/quote-native/fcl-contracts';

const caseView={
  case_id:'00000000-0000-4000-8000-000000000001',
  case_status:'in_review' as const,
  case_version:4,
  current_input:{
    pol:'Yantian',
    pod:'Vancouver',
    containers:[{type:'40HQ' as const,quantity:2}],
    selected_services:['ocean_freight'] as const,
    incoterm:'EXW' as const,
  },
  review_context:{latest_customer_supplement_ref:null,last_confirmed_case_version:4,last_confirmed_customer_supplement_ref:null,review_required:false},
};

const selected:FclQuoteSelectedSnapshot={
  rate_id:'00000000-0000-4000-8000-000000000201',
  release_id:'00000000-0000-4000-8000-000000000301',
  release_version:3,
  dataset_digest:'a'.repeat(64),
  source_ref:'synthetic:rate:1',
  source_version:'v1',
  valid_from:'2026-10-01',
  valid_until:'2026-10-15',
  rate:{
    rate_id:'00000000-0000-4000-8000-000000000201',
    supplier_label:'Synthetic carrier',
    pol:'Yantian',
    pod:'Vancouver',
    valid_from:'2026-10-01',
    valid_until:'2026-10-15',
    source_ref:'synthetic:rate:1',
    source_version:'v1',
    note:null,
    items:[{container_type:'40HQ',ocean_freight:'3200',currency:'USD'}],
    additional_fees:[],
  },
  selected_at:'2026-10-08T12:00:00.000Z',
  case_ref:'00000000-0000-4000-8000-000000000001',
  case_version:4,
  latest_customer_supplement_ref:null,
};

function input(overrides:Record<string,unknown>={}){
  return fclQuoteDraftInputSchema.parse({
    source_sell_prices:[],
    manual_fees:[],
    service_scopes:[],
    exchange_rates:{USD:null,CAD:null},
    remark:null,
    ...overrides,
  });
}

function build(overrides:{
  selected?:FclQuoteSelectedSnapshot;
  caseView?:unknown;
  input?:ReturnType<typeof input>;
}={}){
  return buildFclCostSellSnapshot({
    contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,
    quote_ref:'00000000-0000-4000-8000-000000000401',
    version:1,
    actor:'fcl-document-receiver',
    created_at:'2026-10-08T12:00:00.000Z',
    caseView:(overrides.caseView??caseView) as never,
    selected:overrides.selected??selected,
    input:overrides.input??input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:'Ocean freight'}]}),
  });
}

it('derives immutable source cost and computes Cost/Sell/GP from explicit selling input',()=>{
  const input=fclQuoteDraftInputSchema.parse({
    source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:'Ocean freight'}],
    manual_fees:[],
    service_scopes:[],
    exchange_rates:{USD:null,CAD:null},
    remark:null,
  });
  const snapshot=buildFclCostSellSnapshot({
    contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,
    quote_ref:'00000000-0000-4000-8000-000000000401',
    version:1,
    actor:'fcl-document-receiver',
    created_at:'2026-10-08T12:00:00.000Z',
    caseView:caseView as never,
    selected,
    input,
  });
  expect(fclQuoteSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(snapshot.cost_rows[0]).toMatchObject({
    row_key:'ocean_freight:40HQ',
    quantity:'2',
    cost_price:'3200',
    sell_price:'3500',
    cost_amount:'6400.00',
    sell_amount:'7000.00',
  });
  expect(snapshot.calculation.by_currency.USD).toMatchObject({
    cost_subtotal:'6400.00',
    revenue_subtotal:'7000.00',
    gp_subtotal:'600.00',
    margin:'0.085714',
  });
  expect(snapshot.calculation.calculation_trace.some(entry=>entry.step==='row_amount'&&entry.detail.includes('ocean_freight:40HQ'))).toBe(true);
  expect(snapshot.completeness).toMatchObject({complete:true,missing_fields:[]});
});

it('keeps direct-currency profit complete independent from optional CNY conversion',()=>{
  const pureUsd=build({input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}]})});
  expect(pureUsd.completeness.complete).toBe(true);
  expect(pureUsd.calculation.unified_profit).toMatchObject({complete:false,missing_fx:['USD']});

  const usdWithFx=build({input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],exchange_rates:{USD:'7.2',CAD:null}})});
  expect(usdWithFx.calculation.unified_profit).toMatchObject({complete:true,cost_subtotal:'46080.00',revenue_subtotal:'50400.00',gp_subtotal:'4320.00'});

  const pureCnySelected={...selected,rate:{...selected.rate,items:[{container_type:'40HQ' as const,ocean_freight:'100',currency:'CNY' as const}]}};
  const pureCny=build({selected:pureCnySelected,caseView:{...caseView,current_input:{...caseView.current_input,containers:[{type:'40HQ' as const,quantity:1}]}},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'120',customer_note:null}]})});
  expect(pureCny.calculation.unified_profit).toMatchObject({complete:true,cost_subtotal:'100.00',revenue_subtotal:'120.00',gp_subtotal:'20.00'});
});

it('rounds line amounts before currency and CNY aggregation',()=>{
  const tiny={...selected,rate:{...selected.rate,items:[{container_type:'40HQ' as const,ocean_freight:'1',currency:'USD' as const}]}};
  const result=build({selected:tiny,caseView:{...caseView,current_input:{...caseView.current_input,containers:[{type:'40HQ' as const,quantity:1}]}},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'2',customer_note:null}],exchange_rates:{USD:'0.005',CAD:null}})});
  expect(result.cost_rows[0]).toMatchObject({cost_amount:'1.00',sell_amount:'2.00'});
  expect(result.calculation.unified_profit).toMatchObject({cost_subtotal:'0.01',revenue_subtotal:'0.01',gp_subtotal:'0.00',margin:'0.000000'});
});

it('rounds quantity times price per line and preserves zero revenue with null margin',()=>{
  const tiny={...selected,rate:{...selected.rate,items:[{container_type:'40HQ' as const,ocean_freight:'0.05',currency:'USD' as const}]}};
  const rounded=build({selected:tiny,caseView:{...caseView,current_input:{...caseView.current_input,containers:[{type:'40HQ' as const,quantity:0.1}]}},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'0.1',customer_note:null}]})});
  expect(rounded.cost_rows[0]).toMatchObject({cost_amount:'0.01',sell_amount:'0.01'});
  const zeroRevenue=build({input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'0',customer_note:null}]})});
  expect(zeroRevenue.calculation.by_currency.USD).toMatchObject({revenue_subtotal:'0.00',gp_subtotal:'-6400.00',margin:null});
  expect(zeroRevenue.calculation.warnings).toContain('negative_gp:USD');
});

it('supports legal large amounts and negative margin outputs without exponent notation',()=>{
  const extreme={...selected,rate:{...selected.rate,items:[{container_type:'40HQ' as const,ocean_freight:'9999999999',currency:'USD' as const}]}};
  const result=build({selected:extreme,caseView:{...caseView,current_input:{...caseView.current_input,containers:[{type:'40HQ' as const,quantity:1}]}},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'0.01',customer_note:null}],exchange_rates:{USD:'9999999999.999999',CAD:null}})});
  expect(result.calculation.by_currency.USD.margin).toMatch(/^-?\d+\.\d{6}$/u);
  expect(result.calculation.unified_profit.cost_subtotal).toMatch(/^\d+\.\d{2}$/u);
  expect(fclQuoteDraftInputSchema.safeParse({source_sell_prices:[],manual_fees:[],service_scopes:[],exchange_rates:{USD:'10000000000',CAD:null},remark:null}).success).toBe(false);
});

it('accepts bounded positive decimals and rejects zero or over-precision values',()=>{
  for(const value of ['0.10','0.005000','1','9999999999.999999'])expect(fclQuoteDraftInputSchema.safeParse({source_sell_prices:[],manual_fees:[],service_scopes:[],exchange_rates:{USD:value,CAD:null},remark:null}).success,value).toBe(true);
  for(const value of ['0','0.000000','0.0000001','10000000000'])expect(fclQuoteDraftInputSchema.safeParse({source_sell_prices:[],manual_fees:[],service_scopes:[],exchange_rates:{USD:value,CAD:null},remark:null}).success,value).toBe(false);
});

it('handles mixed-currency FX completion, missing FX and unused zero currencies',()=>{
  const mixedSelected={...selected,rate:{...selected.rate,items:[{container_type:'40HQ' as const,ocean_freight:'3200',currency:'USD' as const},{container_type:'20GP' as const,ocean_freight:'40',currency:'CAD' as const}]}};
  const mixedCase={...caseView,current_input:{...caseView.current_input,containers:[{type:'40HQ' as const,quantity:2},{type:'20GP' as const,quantity:2}]}};
  const complete=build({selected:mixedSelected,caseView:mixedCase,input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null},{row_key:'ocean_freight:20GP',sell_price:'50',customer_note:null}],exchange_rates:{USD:'7.2',CAD:'5.3'}})});
  expect(complete.calculation.unified_profit).toMatchObject({revenue_subtotal:'50930.00',cost_subtotal:'46504.00',gp_subtotal:'4426.00',margin:'0.086904',complete:true});
  const missing=build({selected:mixedSelected,caseView:mixedCase,input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null},{row_key:'ocean_freight:20GP',sell_price:'50',customer_note:null}],exchange_rates:{USD:'7.2',CAD:null}})});
  expect(missing.completeness).toMatchObject({complete:false});
  expect(missing.completeness.missing_fields).toContain('/exchange_rates/CAD');
  expect(missing.calculation.blockers).toContain('fx_missing:CAD');

  const usdAndCny=build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['ocean_freight','delivery'] as const}},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],manual_fees:[{id:randomUUID(),template_ref:null,name:'Delivery',group:'C',service:'delivery',quantity:'1',unit:'SHIPMENT',container_type:null,cost_price:'10',sell_price:'20',currency:'CNY',internal_note:null,customer_note:null,evidence_ref:'synthetic:delivery',evidence_version:'v1',quantity_conditions:null}],exchange_rates:{USD:'7.2',CAD:null}})});
  expect(usdAndCny.calculation.unified_profit).toMatchObject({complete:true,cost_subtotal:'46090.00',revenue_subtotal:'50420.00'});

  const zero=build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:[]}},input:input()});
  expect(zero.calculation.unified_profit).toMatchObject({complete:true,cost_subtotal:'0.00',revenue_subtotal:'0.00',gp_subtotal:'0.00'});
});

it('keeps incomplete manual rows incomplete and enforces service coverage semantics',()=>{
  const manual=randomUUID();
  const incomplete=build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['delivery']}},input:input({manual_fees:[{id:manual,template_ref:null,name:'Delivery',group:'C',service:'delivery',quantity:'1',unit:'SHIPMENT',container_type:null,cost_price:'10',sell_price:null,currency:'USD',internal_note:null,customer_note:null,evidence_ref:null,evidence_version:null,quantity_conditions:null}]})});
  expect(incomplete.cost_rows[0]!.cost_amount).toBe('10.00');
  expect(incomplete.cost_rows[0]!.sell_amount).toBeNull();
  expect(incomplete.completeness.missing_fields).toEqual(expect.arrayContaining(['/cost_rows/0/sell_price','/cost_rows/0/evidence_ref','/cost_rows/0/evidence_version']));
  expect(incomplete.completeness.complete).toBe(false);

  const included=build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['ocean_freight','canada_customs']}},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],service_scopes:[{service:'canada_customs',disposition:'included',note:'Included in ocean freight',included_row_refs:['ocean_freight:40HQ']}]})});
  expect(included.completeness.complete).toBe(true);
  expect(included.service_coverage).toEqual(expect.arrayContaining([expect.objectContaining({service:'canada_customs',disposition:'included'})]));

  const free=build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['delivery']}},input:input({service_scopes:[{service:'delivery',disposition:'free',note:'Free fixture delivery',included_row_refs:[]}]})});
  expect(free.completeness.complete).toBe(true);
  expect(free.service_coverage[0]).toMatchObject({disposition:'free',actor:'fcl-document-receiver'});
  const outOfScope=build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['delivery'],incoterm:'DDP'}},input:input({service_scopes:[{service:'delivery',disposition:'out_of_scope',note:'Not quoted',included_row_refs:[]}]})});
  expect(outOfScope.completeness.complete).toBe(true);
  expect(outOfScope.calculation.warnings).toContain('ddp_tax_coverage_not_inferred');
  const freeWithZeroSell=build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['delivery']}},input:input({manual_fees:[{id:randomUUID(),template_ref:null,name:'Free handling',group:'C',service:'delivery',quantity:'1',unit:'SHIPMENT',container_type:null,cost_price:'2',sell_price:'0',currency:'USD',internal_note:null,customer_note:null,evidence_ref:'synthetic:free',evidence_version:'v1',quantity_conditions:null}],service_scopes:[{service:'delivery',disposition:'free',note:'Explicit zero selling price',included_row_refs:[]}]})});
  expect(freeWithZeroSell.completeness.complete).toBe(true);
  expect(freeWithZeroSell.calculation.by_currency.USD).toMatchObject({revenue_subtotal:'0.00',gp_subtotal:'-2.00'});
  expect(()=>build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['delivery']}},input:input({manual_fees:[{id:randomUUID(),template_ref:null,name:'Paid handling',group:'C',service:'delivery',quantity:'1',unit:'SHIPMENT',container_type:null,cost_price:'2',sell_price:'3',currency:'USD',internal_note:null,customer_note:null,evidence_ref:'synthetic:paid',evidence_version:'v1',quantity_conditions:null}],service_scopes:[{service:'delivery',disposition:'free',note:'Conflict',included_row_refs:[]}]})})).toThrow('fcl_quote_scope_invalid');

  expect(()=>build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['ocean_freight','delivery']}},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],service_scopes:[{service:'ocean_freight',disposition:'free',note:'Conflict',included_row_refs:[]}]})})).toThrow('fcl_quote_scope_invalid');
  expect(()=>build({input:input({source_sell_prices:[{row_key:'unknown:row',sell_price:'1',customer_note:null}]})})).toThrow('fcl_quote_source_row_unknown');
  expect(fclQuoteDraftInputSchema.safeParse({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'1',customer_note:null,cost_price:'3200'}],manual_fees:[],service_scopes:[],exchange_rates:{USD:null,CAD:null},remark:null}).success).toBe(false);
});

it('rejects combined rows over the old-document limit',()=>{
  const manual=Array.from({length:60},()=>({id:randomUUID(),template_ref:null,name:'Manual',group:'C' as const,service:'delivery' as const,quantity:'1',unit:'SHIPMENT' as const,container_type:null,cost_price:'1',sell_price:'2',currency:'USD' as const,internal_note:null,customer_note:null,evidence_ref:'synthetic:manual',evidence_version:'v1',quantity_conditions:null}));
  expect(()=>build({input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],manual_fees:manual})})).toThrow('fcl_quote_row_limit');
  expect(()=>build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['ocean_freight','delivery']}},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],manual_fees:manual.slice(0,59)})})).not.toThrow();
});

it('derives only selected-service source fees with CNTR and SHIPMENT quantities',()=>{
  const source={...selected,rate:{...selected.rate,additional_fees:[
    {name:'Export customs',group:'A' as const,service:'export_customs' as const,cost_price:'100',currency:'USD' as const,note:null,unit:'CNTR' as const,container_type:'40HQ' as const},
    {name:'Pickup',group:'A' as const,service:'pickup' as const,cost_price:'20',currency:'USD' as const,note:null,unit:'SHIPMENT' as const,container_type:null},
    {name:'Delivery',group:'C' as const,service:'delivery' as const,cost_price:'30',currency:'USD' as const,note:null,unit:'SHIPMENT' as const,container_type:null},
  ]}};
  const result=build({selected:source,caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['ocean_freight','export_customs','pickup'] as const}},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null},{row_key:'rate_fee:0:export_customs:CNTR:40HQ',sell_price:'110',customer_note:null},{row_key:'rate_fee:1:pickup:SHIPMENT:shipment',sell_price:'25',customer_note:null}]})});
  expect(result.cost_rows.map(row=>row.row_key)).toEqual(['ocean_freight:40HQ','rate_fee:0:export_customs:CNTR:40HQ','rate_fee:1:pickup:SHIPMENT:shipment']);
  expect(result.cost_rows[1]).toMatchObject({quantity:'2',cost_amount:'200.00',sell_amount:'220.00'});
  expect(result.cost_rows[2]).toMatchObject({quantity:'1',cost_amount:'20.00',sell_amount:'25.00'});
  expect(result.completeness.complete).toBe(true);
  expect(()=>build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['delivery']}},input:input({manual_fees:[{id:randomUUID(),template_ref:null,name:'Manual',group:'C',service:'delivery',quantity:'1',unit:'CNTR',container_type:'40HQ',cost_price:'1',sell_price:'2',currency:'USD',internal_note:null,customer_note:null,evidence_ref:'synthetic:manual',evidence_version:'v1',quantity_conditions:null}],service_scopes:[{service:'delivery',disposition:'included',note:'Manual fee',included_row_refs:['manual:anything']}]})})).toThrow('fcl_quote_scope_invalid');
  expect(()=>build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['delivery']}},input:input({manual_fees:[{id:randomUUID(),template_ref:null,name:'Manual',group:'C',service:'delivery',quantity:'2',unit:'SHIPMENT',container_type:null,cost_price:'1',sell_price:'2',currency:'USD',internal_note:null,customer_note:null,evidence_ref:'synthetic:manual',evidence_version:'v1',quantity_conditions:null}]})})).toThrow('fcl_quote_scope_invalid');
});

it('compares manual quantities numerically and accepts the source version boundary',()=>{
  const manual=(quantity:string,unit:'CNTR'|'SHIPMENT',container_type:'40HQ'|null)=>({id:randomUUID(),template_ref:null,name:'Manual',group:'C' as const,service:'delivery' as const,quantity,unit,container_type,cost_price:'1',sell_price:'2',currency:'USD' as const,internal_note:null,customer_note:null,evidence_ref:'synthetic:manual',evidence_version:'v1',quantity_conditions:null});
  const manualCase={...caseView,current_input:{...caseView.current_input,selected_services:['delivery'] as const}};
  expect(build({caseView:manualCase,input:input({manual_fees:[manual('1.0','SHIPMENT',null)]})}).cost_rows[0]!.quantity).toBe('1.0');
  expect(build({caseView:manualCase,input:input({manual_fees:[manual('2.00','CNTR','40HQ')]})}).cost_rows[0]!.quantity).toBe('2.00');
  const boundary={...selected,source_version:'v'.repeat(200)};
  expect(build({selected:boundary,input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}]})}).source_snapshot.source_version).toHaveLength(200);
  expect(()=>build({selected:{...selected,source_version:'v'.repeat(201)},input:input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}]})})).toThrow();
});

it('applies audited per-ticket cost, sell and billing overrides without mutating the source snapshot',()=>{
  const source={...selected,rate:{...selected.rate,additional_fees:[
    {name:'Destination delivery',group:'C' as const,service:'delivery' as const,cost_price:'200',currency:'CAD' as const,note:null,unit:'CNTR' as const,container_type:'40HQ' as const},
  ]}};
  const projectedCase={...caseView,current_input:{...caseView.current_input,selected_services:['ocean_freight','delivery'] as const}};
  const sourceBefore=structuredClone(source),caseBefore=structuredClone(projectedCase);
  const adjustments={
    fcl_row_adjustments_v1:{changes:[
      {row_key:'ocean_freight:40HQ',operation:'override' as const,cost_price:'3250',reason:'Supplier corrected the ticket cost'},
      {row_key:'rate_fee:0:delivery:CNTR:40HQ',operation:'override' as const,unit:'SHIPMENT' as const,cost_price:'260',sell_price:'300',reason:'One delivery charge for this shipment'},
    ]},
  };
  const value=input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],extensions:adjustments,exchange_rates:{USD:'7',CAD:'5'}});
  const inputBefore=structuredClone(value);
  const snapshot=build({selected:source,caseView:projectedCase,input:value});
  expect(source).toEqual(sourceBefore);expect(projectedCase).toEqual(caseBefore);expect(value).toEqual(inputBefore);
  expect(snapshot.source_snapshot).toEqual(source);
  expect(snapshot.cost_rows).toEqual(expect.arrayContaining([
    expect.objectContaining({row_key:'ocean_freight:40HQ',quantity:'2',cost_price:'3250',sell_price:'3500',cost_amount:'6500.00',sell_amount:'7000.00'}),
    expect.objectContaining({row_key:'rate_fee:0:delivery:CNTR:40HQ',quantity:'1',unit:'SHIPMENT',container_type:null,cost_price:'260',sell_price:'300',cost_amount:'260.00',sell_amount:'300.00'}),
  ]));
  expect(snapshot.extensions).toMatchObject({
    fcl_row_adjustments_v1:adjustments.fcl_row_adjustments_v1,
    fcl_row_adjustment_audit_v1:{changes:[
      expect.objectContaining({row_key:'ocean_freight:40HQ',operation:'override',actor:'fcl-document-receiver',created_at:'2026-10-08T12:00:00.000Z',original:expect.objectContaining({quantity:'2',cost_price:'3200'}),effective:expect.objectContaining({quantity:'2',cost_price:'3250'})}),
      expect.objectContaining({row_key:'rate_fee:0:delivery:CNTR:40HQ',operation:'override',actor:'fcl-document-receiver',original:expect.objectContaining({quantity:'2',unit:'CNTR',container_type:'40HQ'}),effective:expect.objectContaining({quantity:'1',unit:'SHIPMENT',container_type:null})}),
    ]},
  });
  expect(snapshot.calculation.unified_profit).toMatchObject({cost_subtotal:'46800.00',revenue_subtotal:'50500.00',gp_subtotal:'3700.00'});
  expect(snapshot.calculation.assumptions).toContain('per_quote_adjustments_audited');
  expect(snapshot.calculation.calculation_trace.some(entry=>entry.step==='per_quote_adjustment'&&entry.detail.includes('ocean_freight:40HQ'))).toBe(true);
});

it('supports explicit zero/null and removal while retaining service-coverage blockers',()=>{
  const zero=input({extensions:{fcl_row_adjustments_v1:{changes:[
    {row_key:'ocean_freight:40HQ',operation:'override',cost_price:'0',sell_price:'0',reason:'Explicit zero fixture'},
  ]}}});
  const zeroSnapshot=build({input:zero,caseView:{...caseView,current_input:{...caseView.current_input,containers:[{type:'40HQ' as const,quantity:1}]}}});
  expect(zeroSnapshot.cost_rows[0]).toMatchObject({cost_price:'0',sell_price:'0',cost_amount:'0.00',sell_amount:'0.00',fully_priced:true});
  expect(zeroSnapshot.calculation.by_currency.USD).toMatchObject({cost_subtotal:'0.00',revenue_subtotal:'0.00',gp_subtotal:'0.00'});

  const blank=input({extensions:{fcl_row_adjustments_v1:{changes:[
    {row_key:'ocean_freight:40HQ',operation:'override',cost_price:null,sell_price:null,reason:'Clear both amounts'},
  ]}}});
  const blankSnapshot=build({input:blank});
  expect(blankSnapshot.cost_rows[0]).toMatchObject({cost_price:null,sell_price:null,cost_amount:null,sell_amount:null,fully_priced:false});
  expect(blankSnapshot.completeness.complete).toBe(false);
  expect(blankSnapshot.completeness.missing_fields).toEqual(expect.arrayContaining(['/cost_rows/0/cost_price','/cost_rows/0/sell_price','/service_coverage/0']));

  const removed=input({extensions:{fcl_row_adjustments_v1:{changes:[
    {row_key:'ocean_freight:40HQ',operation:'remove',reason:'Removed from this ticket'},
  ]}}});
  const removedSnapshot=build({input:removed});
  expect(removedSnapshot.cost_rows).toHaveLength(0);
  expect(removedSnapshot.service_coverage[0]).toMatchObject({service:'ocean_freight',disposition:'pending'});
  expect(removedSnapshot.completeness.missing_fields).toContain('/service_coverage/0');
  expect(removedSnapshot.extensions?.fcl_row_adjustment_audit_v1?.changes[0]).toMatchObject({operation:'remove',effective:null});

  const includedRemoved=input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],service_scopes:[{service:'canada_customs',disposition:'included',note:'Included in ocean',included_row_refs:['ocean_freight:40HQ']}],extensions:{fcl_row_adjustments_v1:{changes:[{row_key:'ocean_freight:40HQ',operation:'remove',reason:'No included source row remains'}]}}});
  expect(()=>build({caseView:{...caseView,current_input:{...caseView.current_input,selected_services:['ocean_freight','canada_customs']}},input:includedRemoved})).toThrow('fcl_quote_scope_invalid');
});

it('derives CNTR quantities from the case and rejects unknown, duplicate or invalid container rows',()=>{
  const multi={...selected,rate:{...selected.rate,items:[
    {container_type:'40HQ' as const,ocean_freight:'3200',currency:'USD' as const},
    {container_type:'20GP' as const,ocean_freight:'1800',currency:'USD' as const},
  ]}};
  const multiCase={...caseView,current_input:{...caseView.current_input,containers:[{type:'40HQ' as const,quantity:2},{type:'20GP' as const,quantity:1}]}};
  const adjusted=input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null},{row_key:'ocean_freight:20GP',sell_price:'2000',customer_note:null}],extensions:{fcl_row_adjustments_v1:{changes:[
    {row_key:'ocean_freight:40HQ',operation:'override',cost_price:'3250',reason:'Keep both containers'},
    {row_key:'ocean_freight:20GP',operation:'override',unit:'CNTR',container_type:'20GP',sell_price:'2100',reason:'Explicit 20GP pricing'},
  ]}}});
  const snapshot=build({selected:multi,caseView:multiCase,input:adjusted});
  expect(snapshot.cost_rows).toEqual(expect.arrayContaining([
    expect.objectContaining({row_key:'ocean_freight:40HQ',quantity:'2',unit:'CNTR',container_type:'40HQ'}),
    expect.objectContaining({row_key:'ocean_freight:20GP',quantity:'1',unit:'CNTR',container_type:'20GP'}),
  ]));
  expect(()=>build({input:input({extensions:{fcl_row_adjustments_v1:{changes:[{row_key:'unknown:row',operation:'remove',reason:'Unknown'}]}}})})).toThrow('fcl_quote_source_row_unknown');
  expect(fclRowAdjustmentsSchema.safeParse({changes:[{row_key:'ocean_freight:40HQ',operation:'override',cost_price:'1',reason:'one'},{row_key:'ocean_freight:40HQ',operation:'remove',reason:'duplicate'}]}).success).toBe(false);
  expect(()=>build({input:input({extensions:{fcl_row_adjustments_v1:{changes:[{row_key:'ocean_freight:40HQ',operation:'override',unit:'CNTR',container_type:'20GP',reason:'Missing case container'}]}}})})).toThrow('fcl_quote_scope_invalid');
});

it('keeps legacy estimate-only extensions unchanged and does not forge missing FX totals',()=>{
  const estimate={estimate_id:'00000000-0000-4000-8000-000000000501',version:1,content_digest:'b'.repeat(64),valid_from:'2026-10-01',valid_until:'2026-10-15'};
  const legacy=input({source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],extensions:{fcl_estimate_v1:estimate}});
  const legacySnapshot=build({input:legacy});
  expect(legacySnapshot.extensions).toEqual({fcl_estimate_v1:estimate});
  expect(Object.keys(legacySnapshot.extensions??{})).toEqual(['fcl_estimate_v1']);
  expect(legacySnapshot.calculation.assumptions).toEqual(['source_costs_server_derived','fx_is_explicit_snapshot','no_inferred_included_services']);

  const missingFx=input({extensions:{fcl_row_adjustments_v1:{changes:[{row_key:'ocean_freight:40HQ',operation:'override',cost_price:'3250',sell_price:'3500',reason:'Keep FX incomplete'}]}}});
  const missing=build({input:missingFx});
  expect(missing.calculation.by_currency.USD).toMatchObject({cost_subtotal:'6500.00',revenue_subtotal:'7000.00'});
  expect(missing.calculation.unified_profit).toMatchObject({complete:false,cost_subtotal:null,revenue_subtotal:null,gp_subtotal:null,missing_fx:['USD']});
});

it('rejects re-digested audit or override tampering with all effective fields checked',()=>{
  const adjusted=input({extensions:{fcl_row_adjustments_v1:{changes:[
    {row_key:'ocean_freight:40HQ',operation:'override',cost_price:'0',sell_price:null,reason:'Explicit audited values'},
  ]}},exchange_rates:{USD:'7',CAD:null}});
  const snapshot=build({input:adjusted});
  const reDigest=(candidate:typeof snapshot)=>{
    const {content_digest:_content,...body}=candidate;
    void _content;
    return fclQuoteSnapshotSchema.parse({...body,content_digest:fclQuoteSnapshotDigest(body)});
  };
  const forgedAudit=structuredClone(snapshot);
  forgedAudit.extensions!.fcl_row_adjustment_audit_v1!.changes[0]!.actor='forged-actor';
  expect(()=>validateFclQuoteSnapshot(reDigest(forgedAudit))).toThrow('fcl_quote_readback_failed');
  const forgedAuditTime=structuredClone(snapshot);
  forgedAuditTime.extensions!.fcl_row_adjustment_audit_v1!.changes[0]!.created_at='2026-10-08T12:00:01.000Z';
  expect(()=>validateFclQuoteSnapshot(reDigest(forgedAuditTime))).toThrow('fcl_quote_readback_failed');

  const tamperedEffective=structuredClone(snapshot);
  tamperedEffective.extensions!.fcl_row_adjustment_audit_v1!.changes[0]!.effective!.cost_price='1';
  expect(()=>validateFclQuoteSnapshot(reDigest(tamperedEffective))).toThrow('fcl_quote_readback_failed');
  const tamperedQuantity=structuredClone(snapshot);
  tamperedQuantity.extensions!.fcl_row_adjustment_audit_v1!.changes[0]!.effective!.quantity='1';
  expect(()=>validateFclQuoteSnapshot(reDigest(tamperedQuantity))).toThrow('fcl_quote_readback_failed');

  const tamperedInput=structuredClone(snapshot);
  tamperedInput.extensions!.fcl_row_adjustments_v1!.changes[0]!.sell_price='0';
  expect(()=>validateFclQuoteSnapshot(reDigest(tamperedInput))).toThrow('fcl_quote_readback_failed');
});
