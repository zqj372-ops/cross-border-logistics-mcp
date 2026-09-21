import type { CaseService } from '../access-gateway/portal/cases';
import type { PortalContext } from '../access-gateway/portal/contracts';
import { PortalError } from '../access-gateway/portal/contracts';
import type { FclRateAdminView, NativeAdminService } from '../access-gateway/portal/native-admin';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { D, divideRatio, roundMoney } from '../quote-documents/money';
import {
  type FCL_DOCUMENT_WORKFLOW_VERSION,
  fclQuoteMatchRequestSchema,
  fclQuoteResponseSchema,
  fclQuoteSnapshotSchema,
  FCL_QUOTE_WORKFLOW_VERSION,
  type FclQuoteCaseBinding,
  type FclQuoteCaseProjection,
  type FclQuoteCostRow,
  type FclQuoteDraftInput,
  type FclRowAdjustmentAuditChange,
  type FclRowAdjustmentValue,
  type FclQuoteSelectedSnapshot,
  type FclQuoteServiceCoverage,
  type FclQuoteSnapshot,
  type FclRateDataset,
  type FclRatePublication,
} from './fcl-contracts';
export {
  FCL_DOCUMENT_WORKFLOW_VERSION,
  FCL_QUOTE_WORKFLOW_VERSION,
  fclQuoteDraftInputSchema,
  fclQuoteGetRequestSchema,
  fclQuoteListRequestSchema,
  fclQuoteListSchema,
  fclQuoteMatchRequestSchema,
  fclQuoteReferenceSchema,
  fclQuoteResponseSchema,
  fclQuoteSaveRequestSchema,
  fclQuoteSnapshotSchema,
  fclQuoteViewSchema,
} from './fcl-contracts';
export type { FclQuoteCurrentness, FclQuoteSelectedSnapshot, FclQuoteView } from './fcl-contracts';

type FclCaseView = ReturnType<CaseService['getFclCase']>;
type FclQuoteMatchRequest = ReturnType<typeof fclQuoteMatchRequestSchema.parse>;
type FclQuoteResponse = ReturnType<typeof fclQuoteResponseSchema.parse>;
type FclQuoteCandidate = FclQuoteResponse['data']['candidates'][number];
type FclQuoteTraceStep = FclQuoteResponse['data']['calculation_trace'][number];

const stableValue=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(stableValue);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,stableValue(item)]));
  return value;
};
const stableDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');

export function fclQuoteSnapshotDigest(snapshot:Omit<FclQuoteSnapshot,'content_digest'>):string{
  return stableDigest(snapshot);
}

const hasOwn=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);

function validateFclRowAdjustmentAudit(snapshot:FclQuoteSnapshot):void{
  const input=snapshot.extensions?.fcl_row_adjustments_v1,audit=snapshot.extensions?.fcl_row_adjustment_audit_v1;
  if(!input&&!audit)return;
  if(!input||!audit||input.changes.length!==audit.changes.length)throw new PortalError('fcl_quote_readback_failed');
  const rows=new Map(snapshot.cost_rows.map(row=>[row.row_key,row]));
  for(let index=0;index<input.changes.length;index++){
    const change=input.changes[index]!,recorded=audit.changes[index]!,row=rows.get(change.row_key);
    if(recorded.row_key!==change.row_key||recorded.operation!==change.operation||recorded.reason!==change.reason||recorded.actor!==snapshot.actor||recorded.created_at!==snapshot.created_at)throw new PortalError('fcl_quote_readback_failed');
    if(change.operation==='remove'){
      if(row||recorded.effective!==null)throw new PortalError('fcl_quote_readback_failed');
      continue;
    }
    const effective=recorded.effective;
    if(!row||!effective||row.quantity!==effective.quantity||row.unit!==effective.unit||row.container_type!==effective.container_type)throw new PortalError('fcl_quote_readback_failed');
    if(row.cost_price!==effective.cost_price||row.sell_price!==effective.sell_price)throw new PortalError('fcl_quote_readback_failed');
    if(hasOwn(change,'cost_price')&&change.cost_price!==effective.cost_price)throw new PortalError('fcl_quote_readback_failed');
    if(hasOwn(change,'sell_price')&&change.sell_price!==effective.sell_price)throw new PortalError('fcl_quote_readback_failed');
    if(hasOwn(change,'unit')&&row.unit!==change.unit)throw new PortalError('fcl_quote_readback_failed');
    if(hasOwn(change,'container_type')&&row.container_type!==change.container_type)throw new PortalError('fcl_quote_readback_failed');
  }
}

export function validateFclQuoteSnapshot(value:unknown):FclQuoteSnapshot{
  const snapshot=fclQuoteSnapshotSchema.parse(value);
  const {content_digest,...payload}=snapshot;
  if(content_digest!==stableDigest(payload))throw new PortalError('fcl_quote_readback_failed');
  validateFclRowAdjustmentAudit(snapshot);
  for(const row of snapshot.cost_rows){
    const costAmount=row.cost_price===null?null:roundMoney(new D(row.quantity).mul(row.cost_price));
    const sellAmount=row.sell_price===null?null:roundMoney(new D(row.quantity).mul(row.sell_price));
    const evidenceComplete=row.source_kind!=='manual'||row.cost_price===null||Boolean(row.evidence_ref&&row.evidence_version);
    if(row.cost_amount!==costAmount||row.sell_amount!==sellAmount||row.fully_priced!==(costAmount!==null&&sellAmount!==null&&evidenceComplete))throw new PortalError('fcl_quote_readback_failed');
  }
  for(const currencyCode of ['USD','CAD','CNY'] as const){
    const rows=snapshot.cost_rows.filter(row=>row.currency===currencyCode),complete=rows.every(row=>row.fully_priced);
    const knownCost=rows.filter(row=>row.cost_amount!==null),knownRevenue=rows.filter(row=>row.sell_amount!==null);
    const cost=knownCost.length===0?(rows.length===0?'0.00':null):roundMoney(knownCost.reduce((sum,row)=>sum.add(row.cost_amount!),new D(0)));
    const revenue=knownRevenue.length===0?(rows.length===0?'0.00':null):roundMoney(knownRevenue.reduce((sum,row)=>sum.add(row.sell_amount!),new D(0)));
    const gp=complete&&cost!==null&&revenue!==null?roundMoney(new D(revenue).minus(cost)):null;
    const margin=gp!==null&&revenue!==null?divideRatio(gp,revenue):null;
    const actual=snapshot.calculation.by_currency[currencyCode];
    if(actual.complete!==complete||actual.cost_subtotal!==cost||actual.revenue_subtotal!==revenue||actual.gp_subtotal!==gp||actual.margin!==margin)throw new PortalError('fcl_quote_readback_failed');
  }
  const unified=snapshot.calculation.unified_profit;
  if(unified.complete&&unified.revenue_subtotal!==null&&unified.cost_subtotal!==null&&unified.gp_subtotal!==null&&unified.margin!==null){
    const gp=roundMoney(new D(unified.revenue_subtotal).minus(unified.cost_subtotal));
    if(unified.gp_subtotal!==gp||unified.margin!==divideRatio(gp,unified.revenue_subtotal))throw new PortalError('fcl_quote_readback_failed');
  }
  return snapshot;
}

export type BuildFclCostSellSnapshotInput={
  contract_version:typeof FCL_DOCUMENT_WORKFLOW_VERSION;
  quote_ref:string;
  version:number;
  actor:string;
  created_at:string;
  caseView:FclCaseView;
  selected:FclQuoteSelectedSnapshot;
  input:FclQuoteDraftInput;
  case_binding?:FclQuoteCaseBinding;
  case_projection?:FclQuoteCaseProjection;
};

const projectionFromCase=(caseView:FclCaseView):FclQuoteCaseProjection=>({
  containers:caseView.current_input.containers.flatMap(container=>container.quantity===null?[]:[{type:container.type,quantity:String(container.quantity)}]),
  services:[...caseView.current_input.selected_services],
  incoterm:caseView.current_input.incoterm,
});

const rowWithAmounts=(row:Omit<FclQuoteCostRow,'cost_amount'|'sell_amount'|'fully_priced'>):FclQuoteCostRow=>{
  const costAmount=row.cost_price===null?null:roundMoney(new D(row.quantity).mul(row.cost_price));
  const sellAmount=row.sell_price===null?null:roundMoney(new D(row.quantity).mul(row.sell_price));
  const evidenceComplete=row.source_kind!=='manual'||row.cost_price===null||Boolean(row.evidence_ref&&row.evidence_version);
  return {...row,cost_amount:costAmount,sell_amount:sellAmount,fully_priced:costAmount!==null&&sellAmount!==null&&evidenceComplete};
};

export function calculateFclMoney(rows: Pick<FclQuoteCostRow,'currency'|'fully_priced'|'cost_amount'|'sell_amount'>[], exchangeRates: FclQuoteDraftInput['exchange_rates']) {
  const currencies=['USD','CAD','CNY'] as const;
  const byCurrency=Object.fromEntries(currencies.map(currencyCode=>{
    const currencyRows=rows.filter(row=>row.currency===currencyCode);
    if(currencyRows.length===0)return [currencyCode,{cost_subtotal:'0.00',revenue_subtotal:'0.00',gp_subtotal:'0.00',margin:null,complete:true}];
    const complete=currencyRows.every(row=>row.fully_priced);
    const knownCost=currencyRows.filter(row=>row.cost_amount!==null);
    const knownRevenue=currencyRows.filter(row=>row.sell_amount!==null);
    const cost=knownCost.length===0?null:roundMoney(knownCost.reduce((sum,row)=>sum.add(row.cost_amount!),new D(0)));
    const revenue=knownRevenue.length===0?null:roundMoney(knownRevenue.reduce((sum,row)=>sum.add(row.sell_amount!),new D(0)));
    if(!complete)return [currencyCode,{cost_subtotal:cost,revenue_subtotal:revenue,gp_subtotal:null,margin:null,complete:false}];
    const gp=roundMoney(new D(revenue!).minus(cost!));
    return [currencyCode,{cost_subtotal:cost,revenue_subtotal:revenue,gp_subtotal:gp,margin:divideRatio(gp,revenue!),complete:true}];
  })) as FclQuoteSnapshot['calculation']['by_currency'];

  const allRowsPriced=rows.every(row=>row.fully_priced);
  const nonZeroCurrencies=currencies.filter(currencyCode=>{
    const breakdown=byCurrency[currencyCode];
    return (breakdown.cost_subtotal??'0')!=='0.00'||(breakdown.revenue_subtotal??'0')!=='0.00';
  });
  const conversionCurrencies=nonZeroCurrencies.filter(currencyCode=>currencyCode!=='CNY');
  const missingFx:Array<'USD'|'CAD'>=conversionCurrencies.filter(currencyCode=>exchangeRates[currencyCode]===null);
  const mixedCurrencies=nonZeroCurrencies.length>1;
  const unifiedComplete=allRowsPriced&&missingFx.length===0;
  let unified:FclQuoteSnapshot['calculation']['unified_profit'];
  if(!unifiedComplete){
    unified={currency:'CNY',cost_subtotal:null,revenue_subtotal:null,gp_subtotal:null,margin:null,complete:false,missing_fx:[...missingFx]};
  }else{
    const cnyCost=currencies.reduce((sum,currencyCode)=>{
      const amount=byCurrency[currencyCode].cost_subtotal??'0.00';
      const revenue=byCurrency[currencyCode].revenue_subtotal??'0.00';
      if(amount==='0.00'&&revenue==='0.00')return sum;
      const rate=currencyCode==='CNY'?'1':exchangeRates[currencyCode]!;
      return sum.add(new D(amount).mul(rate));
    },new D(0));
    const cnyRevenue=currencies.reduce((sum,currencyCode)=>{
      const amount=byCurrency[currencyCode].cost_subtotal??'0.00';
      const revenue=byCurrency[currencyCode].revenue_subtotal??'0.00';
      if(amount==='0.00'&&revenue==='0.00')return sum;
      const rate=currencyCode==='CNY'?'1':exchangeRates[currencyCode]!;
      return sum.add(new D(revenue).mul(rate));
    },new D(0));
    const cost=roundMoney(cnyCost),revenue=roundMoney(cnyRevenue),gp=roundMoney(new D(revenue).minus(cost));
    unified={currency:'CNY',cost_subtotal:cost,revenue_subtotal:revenue,gp_subtotal:gp,margin:divideRatio(gp,revenue),complete:true,missing_fx:[]};
  }
  return {currencies,byCurrency,unified,missingFx,mixedCurrencies,allRowsPriced};
}

type FclRawCostRow=Omit<FclQuoteCostRow,'cost_amount'|'sell_amount'|'fully_priced'>;
const rowAdjustmentValue=(row:FclRawCostRow):FclRowAdjustmentValue=>({
  quantity:row.quantity,
  unit:row.unit,
  container_type:row.container_type,
  cost_price:row.cost_price,
  sell_price:row.sell_price,
});

export function buildFclCostSellSnapshot(input:BuildFclCostSellSnapshotInput):FclQuoteSnapshot{
  const noInput=()=>{throw new PortalError('fcl_quote_input_invalid');};
  const sourceOverrides=new Map(input.input.source_sell_prices.map(row=>[row.row_key,row]));
  const caseProjection=input.case_projection??projectionFromCase(input.caseView);
  const sourceRows:FclRawCostRow[]=[];
  const addSourceRow=(row:FclRawCostRow,overrideSource=true)=>{
    const override=sourceOverrides.get(row.row_key);
    if(overrideSource&&override)sourceOverrides.delete(row.row_key);
    sourceRows.push({...row,sell_price:override?.sell_price??null,customer_note:override?.customer_note??null});
  };
  if(caseProjection.services.includes('ocean_freight')){
    for(const container of caseProjection.containers){
      const item=input.selected.rate.items.find(candidate=>candidate.container_type===container.type);
      if(!item)return noInput();
      addSourceRow({
        row_key:`ocean_freight:${container.type}`,
        source_kind:'ocean_freight',
        template_ref:null,
        source_ref:input.selected.source_ref,
        source_version:input.selected.source_version,
        name:'Ocean freight',
        group:'B',
        service:'ocean_freight',
        quantity:container.quantity,
        unit:'CNTR',
        container_type:container.type,
        cost_price:item.ocean_freight,
        sell_price:null,
        currency:item.currency,
        internal_note:null,
        customer_note:null,
        evidence_ref:null,
        evidence_version:null,
        quantity_conditions:null,
      });
    }
  }
  input.selected.rate.additional_fees.forEach((fee,index)=>{
    if(!caseProjection.services.includes(fee.service))return;
    let quantity='1';
    if(fee.unit==='CNTR'){
      const container=caseProjection.containers.find(candidate=>candidate.type===fee.container_type);
      if(!container)return;
      quantity=container.quantity;
    }
    addSourceRow({
      row_key:`rate_fee:${index}:${fee.service}:${fee.unit}:${fee.container_type??'shipment'}`,
      source_kind:'rate_fee',
      template_ref:null,
      source_ref:input.selected.source_ref,
      source_version:input.selected.source_version,
      name:fee.name,
      group:fee.group,
      service:fee.service,
      quantity,
      unit:fee.unit,
      container_type:fee.container_type,
      cost_price:fee.cost_price,
      sell_price:null,
      currency:fee.currency,
      internal_note:fee.note,
      customer_note:null,
      evidence_ref:null,
      evidence_version:null,
      quantity_conditions:null,
    });
  });
  if(sourceOverrides.size>0)throw new PortalError('fcl_quote_source_row_unknown');

  const manualRows:FclRawCostRow[]=input.input.manual_fees.map(fee=>{
    const container=fee.unit==='CNTR'&&fee.container_type!==null?caseProjection.containers.find(candidate=>candidate.type===fee.container_type):null;
    if(fee.unit==='SHIPMENT'&&!new D(fee.quantity).eq(1))throw new PortalError('fcl_quote_scope_invalid');
    if(fee.unit==='CNTR'&&(!container||!new D(container.quantity).eq(fee.quantity)))throw new PortalError('fcl_quote_scope_invalid');
    return {
      row_key:`manual:${fee.id}`,
      source_kind:'manual',
      template_ref:fee.template_ref,
      source_ref:null,
      source_version:null,
      name:fee.name,
      group:fee.group,
      service:fee.service,
      quantity:fee.quantity,
      unit:fee.unit,
      container_type:fee.container_type,
      cost_price:fee.cost_price,
      sell_price:fee.sell_price,
      currency:fee.currency,
      internal_note:fee.internal_note,
      customer_note:fee.customer_note,
      evidence_ref:fee.evidence_ref,
      evidence_version:fee.evidence_version,
      quantity_conditions:fee.quantity_conditions,
    };
  });
  const baseRows=[...sourceRows,...manualRows];
  const baseByKey=new Map(baseRows.map((row,index)=>[row.row_key,index]));
  const adjustmentChanges=input.input.extensions?.fcl_row_adjustments_v1?.changes??[];
  const adjustedRows=baseRows.map(row=>structuredClone(row));
  const removedRows=new Set<string>();
  const seenAdjustments=new Set<string>();
  const adjustmentAudit:FclRowAdjustmentAuditChange[]=[];
  for(const change of adjustmentChanges){
    if(seenAdjustments.has(change.row_key))throw new PortalError('fcl_quote_input_invalid');
    seenAdjustments.add(change.row_key);
    const index=baseByKey.get(change.row_key);
    if(index===undefined)throw new PortalError('fcl_quote_source_row_unknown');
    const original=structuredClone(baseRows[index]!),row=adjustedRows[index]!;
    if(change.operation==='remove'){
      removedRows.add(change.row_key);
      adjustmentAudit.push({row_key:change.row_key,operation:'remove',reason:change.reason,original:rowAdjustmentValue(original),effective:null,actor:input.actor,created_at:input.created_at});
      continue;
    }
    if(hasOwn(change,'cost_price'))row.cost_price=change.cost_price??null;
    if(hasOwn(change,'sell_price'))row.sell_price=change.sell_price??null;
    const effectiveUnit=change.unit??row.unit;
    if(effectiveUnit==='SHIPMENT'){
      row.unit='SHIPMENT';row.container_type=null;row.quantity='1';
    }else{
      const effectiveContainer=change.container_type??row.container_type;
      if(effectiveContainer===null)throw new PortalError('fcl_quote_scope_invalid');
      const container=caseProjection.containers.find(candidate=>candidate.type===effectiveContainer);
      if(!container)throw new PortalError('fcl_quote_scope_invalid');
      row.unit='CNTR';row.container_type=effectiveContainer;row.quantity=container.quantity;
    }
    adjustmentAudit.push({row_key:change.row_key,operation:'override',reason:change.reason,original:rowAdjustmentValue(original),effective:rowAdjustmentValue(row),actor:input.actor,created_at:input.created_at});
  }
  const rows=adjustedRows.filter(row=>!removedRows.has(row.row_key)).map(rowWithAmounts);
  if(rows.length>60)throw new PortalError('fcl_quote_row_limit');
  if(rows.some(row=>!caseProjection.services.includes(row.service)))throw new PortalError('fcl_quote_scope_invalid');
  const rowByKey=new Map(rows.map(row=>[row.row_key,row]));
  const missing:string[]=[];
  rows.forEach((row,index)=>{
    if(row.cost_price===null)missing.push(`/cost_rows/${index}/cost_price`);
    if(row.sell_price===null)missing.push(`/cost_rows/${index}/sell_price`);
    if(row.source_kind==='manual'&&row.cost_price!==null&&!row.evidence_ref)missing.push(`/cost_rows/${index}/evidence_ref`);
    if(row.source_kind==='manual'&&row.cost_price!==null&&!row.evidence_version)missing.push(`/cost_rows/${index}/evidence_version`);
  });
  const scopeByService=new Map(input.input.service_scopes.map(scope=>[scope.service,scope]));
  const coverage:FclQuoteServiceCoverage[]=caseProjection.services.map(serviceName=>{
    const serviceRows=rows.filter(row=>row.service===serviceName);
    const completeServiceRows=serviceRows.filter(row=>row.fully_priced);
    const scope=scopeByService.get(serviceName);
    if(!scope){
      if(completeServiceRows.length>0)return {service:serviceName,disposition:'priced',note:'Complete fee rows are explicitly priced.',included_row_refs:completeServiceRows.map(row=>row.row_key),actor:input.actor,confirmed_at:input.created_at};
      return {service:serviceName,disposition:'pending',note:null,included_row_refs:[],actor:null,confirmed_at:null};
    }
    if(scope.disposition==='out_of_scope'&&serviceRows.length>0)throw new PortalError('fcl_quote_scope_invalid');
    if(scope.disposition==='free'&&serviceRows.length>0){
      if(serviceRows.some(row=>!row.fully_priced||(row.sell_amount!==null&&new D(row.sell_amount).gt(0))))throw new PortalError('fcl_quote_scope_invalid');
    }
    if(scope.disposition==='included'){
      for(const ref of scope.included_row_refs){
        const row=rowByKey.get(ref);
        if(!row||!row.fully_priced)throw new PortalError('fcl_quote_scope_invalid');
      }
    }
    return {
      service:serviceName,
      disposition:scope.disposition,
      note:scope.note,
      included_row_refs:scope.included_row_refs,
      actor:input.actor,
      confirmed_at:input.created_at,
    };
  });
  for(const scope of input.input.service_scopes)if(!caseProjection.services.includes(scope.service))throw new PortalError('fcl_quote_scope_invalid');
  coverage.forEach((entry,index)=>{
    if(entry.disposition==='pending')missing.push(`/service_coverage/${index}`);
  });

  const {currencies,byCurrency,unified,missingFx,mixedCurrencies,allRowsPriced}=calculateFclMoney(rows,input.input.exchange_rates);
  const warnings:string[]=[];
  for(const currencyCode of currencies){const gp=byCurrency[currencyCode].gp_subtotal;if(gp!==null&&new D(gp).isNegative())warnings.push(`negative_gp:${currencyCode}`);}
  if(caseProjection.incoterm==='DDP')warnings.push('ddp_tax_coverage_not_inferred');
  if(mixedCurrencies)missingFx.forEach(currencyCode=>missing.push(`/exchange_rates/${currencyCode}`));
  const completeness={complete:missing.length===0&&allRowsPriced,partial:missing.length>0||!allRowsPriced,missing_fields:missing};
  const sourceRefs=[
    {kind:'case' as const,ref:input.selected.case_ref,version:String(input.selected.case_version),digest:null},
    {kind:'rate' as const,ref:input.selected.rate_id,version:input.selected.source_version,digest:input.selected.dataset_digest},
    ...rows.filter(row=>row.source_kind==='manual'&&row.evidence_ref).map(row=>({kind:'manual' as const,ref:row.evidence_ref!,version:row.evidence_version,digest:null})),
  ];
  const hasAdjustments=adjustmentChanges.length>0;
  const calculationTrace:FclQuoteSnapshot['calculation']['calculation_trace']=[
    ...rows.map(row=>({step:'row_amount',detail:`${row.row_key} cost ${row.quantity} × ${row.cost_price??'null'} ${row.currency} = ${row.cost_amount??'null'}; sell ${row.quantity} × ${row.sell_price??'null'} ${row.currency} = ${row.sell_amount??'null'}`})),
    ...currencies.filter(currencyCode=>rows.some(row=>row.currency===currencyCode)).map(currencyCode=>({step:'currency_subtotal',detail:`${currencyCode} cost=${byCurrency[currencyCode].cost_subtotal??'null'} revenue=${byCurrency[currencyCode].revenue_subtotal??'null'} GP=${byCurrency[currencyCode].gp_subtotal??'null'}`})),
    ...(['USD','CAD'] as const).filter(currencyCode=>input.input.exchange_rates[currencyCode]!==null&&rows.some(row=>row.currency===currencyCode)).map(currencyCode=>({step:'fx_conversion',detail:`1 ${currencyCode} = ${input.input.exchange_rates[currencyCode]} CNY`})),
    {step:'unified_profit',detail:`CNY cost=${unified.cost_subtotal??'null'} revenue=${unified.revenue_subtotal??'null'} GP=${unified.gp_subtotal??'null'} margin=${unified.margin??'null'}`},
  ];
  const snapshotExtensions=input.input.extensions?{
    ...input.input.extensions,
    ...(input.input.extensions.fcl_row_adjustments_v1?{fcl_row_adjustment_audit_v1:{changes:adjustmentAudit}}:{}),
  }:undefined;
  const payload={
    ...(snapshotExtensions?{extensions:snapshotExtensions}:{}),
    contract_version:input.contract_version,
    schema_version:'fcl-cost-sell-snapshot@2026-09-20.v1' as const,
    quote_ref:input.quote_ref,
    version:input.version,
    case_binding:input.case_binding??caseBinding(input.caseView),
    source_snapshot:input.selected,
    case_projection:caseProjection,
    cost_rows:rows,
    service_coverage:coverage,
    exchange_rates:input.input.exchange_rates,
    remark:input.input.remark,
    completeness,
    actor:input.actor,
    created_at:input.created_at,
    calculation:{
      calculation_version:'fcl-cost-sell-decimal-v1' as const,
      complete:completeness.complete,
      partial:!completeness.complete,
      by_currency:byCurrency,
      unified_profit:unified,
      source_refs:sourceRefs,
      assumptions:hasAdjustments?['source_base_costs_from_selected_rate','per_quote_adjustments_audited','effective_costs_may_be_adjusted','fx_is_explicit_snapshot','no_inferred_included_services']:['source_costs_server_derived','fx_is_explicit_snapshot','no_inferred_included_services'],
      warnings,
      blockers:mixedCurrencies&&missingFx.length>0?missingFx.map(currencyCode=>`fx_missing:${currencyCode}`):[],
      calculation_trace:[
        {step:'source_rows_derived',detail:hasAdjustments?`${sourceRows.length} source row(s); source snapshot retained unchanged`:`${sourceRows.length} immutable source row(s)`},
        ...(hasAdjustments?adjustmentAudit.map(change=>({step:'per_quote_adjustment',detail:`${change.row_key}: ${change.operation}; reason=${change.reason}`})):[]),
        {step:'manual_rows_collected',detail:`${manualRows.length} manual row(s)`},
        {step:'service_coverage_checked',detail:`${coverage.filter(item=>item.disposition!=='pending').length} resolved service(s)`},
        ...calculationTrace,
      ],
    },
  };
  return fclQuoteSnapshotSchema.parse({...payload,content_digest:stableDigest(payload)});
}

export type FclCaseReader = Pick<CaseService, 'getFclCase'>;
export type FclRateReader = Pick<NativeAdminService, 'get'>;
export type FclQuoteServiceOptions = {
  caseReader: FclCaseReader;
  rateReader: FclRateReader;
  now: () => string;
};

type MatchInput = {
  request: FclQuoteMatchRequest;
  caseView: FclCaseView;
  rateView: FclRateAdminView;
  now: string;
  shippingDate?: string;
};

const caseBinding = (caseView: FclCaseView) => ({
  case_ref: caseView.case_id,
  case_version: caseView.case_version,
  latest_customer_supplement_ref: caseView.review_context.latest_customer_supplement_ref,
});

const buildData = (
  caseView: FclCaseView,
  overrides: Partial<FclQuoteResponse['data']> = {},
): FclQuoteResponse['data'] => ({
  case_binding: caseBinding(caseView),
  candidates: [],
  selected: null,
  missing_fields: [],
  source_refs: [],
  assumptions: [],
  warnings: [],
  blockers: [],
  calculation_trace: [],
  ...overrides,
});

const trace = (step: string, detail: string): FclQuoteTraceStep => ({ step, detail });

const missingFields = (input: FclCaseView['current_input']): string[] => {
  const missing: string[] = [];
  if (input.pol === null) missing.push('/pol');
  if (input.pod === null) missing.push('/pod');
  if (input.containers.length === 0) missing.push('/containers');
  input.containers.forEach((container, index) => {
    if (container.quantity === null) missing.push(`/containers/${index}/quantity`);
  });
  if (input.cargo_ready_date === null) missing.push('/cargo_ready_date');
  return missing;
};

const candidateFromRate = (release: FclRatePublication, rate: FclRatePublication['input']['rates'][number]): FclQuoteCandidate => ({
  rate_id: rate.rate_id,
  release_id: release.release_id,
  release_version: release.version,
  dataset_digest: release.digest,
  source_ref: rate.source_ref,
  source_version: rate.source_version,
  valid_from: rate.valid_from,
  valid_until: rate.valid_until,
  rate,
});

const rateMatches = (input: FclCaseView['current_input'], rate: FclRateDataset['rates'][number], shippingDate?:string): boolean => {
  if (input.pol !== rate.pol || input.pod !== rate.pod || input.cargo_ready_date === null) return false;
  if ((shippingDate??input.cargo_ready_date) < rate.valid_from || (shippingDate??input.cargo_ready_date) > rate.valid_until) return false;
  const containers = new Set(rate.items.map((item) => item.container_type));
  return input.containers.every((container) => containers.has(container.type));
};

const selectedSnapshot = (
  candidate: FclQuoteCandidate,
  caseView: FclCaseView,
  now: string,
): FclQuoteSelectedSnapshot => ({
  ...candidate,
  selected_at: now,
  case_ref: caseView.case_id,
  case_version: caseView.case_version,
  latest_customer_supplement_ref: caseView.review_context.latest_customer_supplement_ref,
});

export function preflightFclMatch(request: FclQuoteMatchRequest, caseView: FclCaseView): FclQuoteResponse | null {
  const baseTrace: FclQuoteTraceStep[] = [
    trace('case_binding_checked', `Case ${caseView.case_id} version ${caseView.case_version}`),
  ];
  if (request.expected_case_version !== caseView.case_version) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'blocked',
      data: buildData(caseView, { blockers: ['fcl_case_version_conflict'], calculation_trace: baseTrace }),
      reason_codes: ['fcl_case_version_conflict'],
    });
  }
  if (request.expected_customer_supplement_ref !== caseView.review_context.latest_customer_supplement_ref) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'blocked',
      data: buildData(caseView, { blockers: ['fcl_customer_supplement_conflict'], calculation_trace: baseTrace }),
      reason_codes: ['fcl_customer_supplement_conflict'],
    });
  }
  if (caseView.case_status === 'closed' || caseView.case_status === 'cancelled') {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'blocked',
      data: buildData(caseView, { blockers: ['fcl_case_closed'], calculation_trace: baseTrace }),
      reason_codes: ['fcl_case_closed'],
    });
  }
  const missing = missingFields(caseView.current_input);
  if (missing.length > 0) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'needs_input',
      data: buildData(caseView, {
        missing_fields: missing,
        blockers: ['fcl_case_input_incomplete'],
        calculation_trace: [...baseTrace, trace('missing_fields_collected', missing.join(', '))],
      }),
      reason_codes: ['fcl_case_input_incomplete'],
    });
  }
  if (caseView.case_status === 'submitted' || caseView.case_status === 'needs_input' || caseView.review_context.review_required) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'manual_review',
      data: buildData(caseView, { blockers: ['fcl_case_review_required'], calculation_trace: baseTrace }),
      reason_codes: ['fcl_case_review_required'],
    });
  }
  return null;
}

export function matchFclRateSources({ request, caseView, rateView, now, shippingDate }: MatchInput): FclQuoteResponse {
  const preflight = preflightFclMatch(request, caseView);
  if (preflight) return preflight;
  const baseTrace: FclQuoteTraceStep[] = [
    trace('case_binding_checked', `Case ${caseView.case_id} version ${caseView.case_version}`),
  ];
  if (!rateView.active_release) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'unavailable',
      data: buildData(caseView, {
        blockers: ['fcl_rate_source_unavailable'],
        calculation_trace: [...baseTrace, trace('active_rate_checked', 'No active FCL rate release')],
      }),
      reason_codes: ['fcl_rate_source_unavailable'],
    });
  }

  const release = rateView.active_release;
  const candidates = release.input.rates
    .filter((rate) => rateMatches(caseView.current_input, rate, shippingDate))
    .map((rate) => candidateFromRate(release, rate))
    .sort((left, right) => left.rate_id.localeCompare(right.rate_id));
  const sourceRefs = candidates.map((candidate) => ({
    rate_id: candidate.rate_id,
    release_id: candidate.release_id,
    release_version: candidate.release_version,
    dataset_digest: candidate.dataset_digest,
    source_ref: candidate.source_ref,
    source_version: candidate.source_version,
    valid_from: candidate.valid_from,
    valid_until: candidate.valid_until,
  }));
  const matchTrace = [
    ...baseTrace,
    trace('active_rate_checked', `Release ${release.release_id} version ${release.version}`),
    trace('rates_filtered', `${candidates.length} exact candidate(s)`),
  ];

  if (candidates.length === 0) {
    if (request.selected_rate_id !== null) {
      return fclQuoteResponseSchema.parse({
        contract_version: FCL_QUOTE_WORKFLOW_VERSION,
        status: 'blocked',
        data: buildData(caseView, {
          candidates: [],
          source_refs: [],
          blockers: ['fcl_selected_rate_not_candidate'],
          calculation_trace: [...matchTrace, trace('rate_selection_rejected', 'Selected rate is not an exact candidate')],
        }),
        reason_codes: ['fcl_selected_rate_not_candidate'],
      });
    }
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'manual_review',
      data: buildData(caseView, {
        candidates: [],
        source_refs: [],
        blockers: ['fcl_rate_no_match'],
        calculation_trace: matchTrace,
      }),
      reason_codes: ['fcl_rate_no_match'],
    });
  }

  if (request.selected_rate_id === null && candidates.length > 1) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'manual_review',
      data: buildData(caseView, {
        candidates,
        source_refs: sourceRefs,
        blockers: ['fcl_rate_selection_required'],
        calculation_trace: [...matchTrace, trace('rate_selection_required', 'Multiple candidates require explicit selection')],
      }),
      reason_codes: ['fcl_rate_selection_required'],
    });
  }

  const selectedCandidate = request.selected_rate_id === null
    ? candidates[0]!
    : candidates.find((candidate) => candidate.rate_id === request.selected_rate_id);
  if (!selectedCandidate) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'blocked',
      data: buildData(caseView, {
        candidates,
        source_refs: sourceRefs,
        blockers: ['fcl_selected_rate_not_candidate'],
        calculation_trace: [...matchTrace, trace('rate_selection_rejected', 'Selected rate is not an exact candidate')],
      }),
      reason_codes: ['fcl_selected_rate_not_candidate'],
    });
  }

  const selected = selectedSnapshot(selectedCandidate, caseView, now);
  return fclQuoteResponseSchema.parse({
    contract_version: FCL_QUOTE_WORKFLOW_VERSION,
    status: 'success',
    data: buildData(caseView, {
      candidates,
      selected,
      source_refs: sourceRefs,
      assumptions: ['exact_pol_pod_container_ready_date_match'],
      calculation_trace: [...matchTrace, trace('rate_selected', selected.rate_id)],
    }),
    reason_codes: [],
  });
}

export class FclQuoteService {
  readonly #caseReader: FclCaseReader;
  readonly #rateReader: FclRateReader;
  readonly #now: () => string;
  constructor(options: FclQuoteServiceOptions) {
    this.#caseReader = options.caseReader;
    this.#rateReader = options.rateReader;
    this.#now = options.now;
  }
  match(ctx: PortalContext, input: unknown, shippingDate?:string): FclQuoteResponse {
    if(shippingDate!==undefined&&!z.iso.date().safeParse(shippingDate).success)throw new PortalError('fcl_quote_input_invalid');
    let request: FclQuoteMatchRequest;
    try {
      request = fclQuoteMatchRequestSchema.parse(input);
    } catch {
      throw new PortalError('fcl_quote_input_invalid');
    }
    let caseView: FclCaseView;
    try {
      caseView = this.#caseReader.getFclCase(ctx, request.case_ref);
    } catch {
      throw new PortalError('fcl_quote_case_unavailable');
    }
    const preflight = preflightFclMatch(request, caseView);
    if (preflight) return preflight;
    let rateView: FclRateAdminView;
    try {
      const current = this.#rateReader.get(ctx, 'fcl');
      if (current.kind !== 'fcl') throw new PortalError('fcl_rate_source_unavailable');
      rateView = current;
    } catch {
      return fclQuoteResponseSchema.parse({
        contract_version: FCL_QUOTE_WORKFLOW_VERSION,
        status: 'unavailable',
        data: buildData(caseView, {
          blockers: ['fcl_rate_source_unavailable'],
          calculation_trace: [trace('active_rate_checked', 'FCL rate source unavailable')],
        }),
        reason_codes: ['fcl_rate_source_unavailable'],
      });
    }
    return matchFclRateSources({ request, caseView, rateView, now: this.#safeNow(),...(shippingDate?{shippingDate}:{}) });
  }
  #safeNow() {
    try {
      const now = this.#now();
      if (!z.iso.datetime().safeParse(now).success) throw new Error('invalid');
      return now;
    } catch {
      throw new PortalError('fcl_quote_clock_unavailable');
    }
  }
}
