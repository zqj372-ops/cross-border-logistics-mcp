import {PortalError} from '../access-gateway/portal/contracts';
import {createHash} from 'node:crypto';
import {D,roundMoney} from '../quote-documents/money';
import {calculateFclMoney} from './fcl';
import type {FclRateDataset,FclQuoteDraftInput} from './fcl-contracts';
import {FCL_OPERATIONS_VERSION,FCL_RATE_DATASET_V2,fclEstimateCalculationSchema,type FclEstimateCalculation,type FclEstimateRequest,type FclCharge,type FclOperations,type FclEstimateSnapshot} from './fcl-operations-contracts';

type Line=FclEstimateCalculation['lines'][number];
type Template=FclOperations['templates'][number];
const inWindow=(v:{valid_from:string;valid_until:string},date:string)=>v.valid_from<=date&&date<=v.valid_until;
const selling=(cost:string,rule:Template['margin_rule'])=>new D(cost)[rule.mode==='gross_margin'?'div':'mul'](rule.mode==='gross_margin'?new D(1).minus(rule.value):new D(1).plus(rule.value)).toFixed(6);

export function refreshFclEstimateTotals(calculation:FclEstimateCalculation):FclEstimateCalculation {
  const result=structuredClone(calculation);
  for(const line of result.lines){line.cost_amount=roundMoney(new D(line.cost_price).mul(line.quantity));line.sell_amount=roundMoney(new D(line.sell_price).mul(line.quantity));}
  const sums=calculateFclMoney(result.lines.map(line=>({...line,fully_priced:true})),result.exchange_rates);
  result.blockers=result.blockers.filter(code=>!code.startsWith('fx_missing:'));
  result.blockers.push(...sums.missingFx.map(code=>`fx_missing:${code}`));
  result.by_currency=sums.currencies.filter(code=>result.lines.some(line=>line.currency===code)).map(code=>({currency:code,cost_total:sums.byCurrency[code].cost_subtotal,sell_total:sums.byCurrency[code].revenue_subtotal,gross_profit:sums.byCurrency[code].gp_subtotal,gross_margin:sums.byCurrency[code].margin}));
  const total=sums.unified;
  result.totals={currency:'CNY',cost_total:result.blockers.length?null:total.cost_subtotal,sell_total:result.blockers.length?null:total.revenue_subtotal,gross_profit:result.blockers.length?null:total.gp_subtotal,gross_margin:result.blockers.length?null:total.margin};
  result.breakdown=[];
  for(const line of result.lines){const found=result.breakdown.find(b=>b.category===line.category&&b.currency===line.currency);if(found)found.amount=roundMoney(new D(found.amount).plus(line.cost_amount));else result.breakdown.push({category:line.category,currency:line.currency,amount:line.cost_amount});}
  result.calculation_trace=result.lines.map(line=>({step:'charge_amount',detail:`${line.id}: ${line.quantity} × ${line.cost_price} / ${line.sell_price} ${line.currency} = ${line.cost_amount} / ${line.sell_amount}`}));
  result.calculation_trace.push({step:'margin_rule',detail:`${result.margin_rule.mode}=${result.margin_rule.value}; explicit selling overrides retained`},{step:'fx_snapshot',detail:JSON.stringify(result.exchange_rates)},{step:'totals',detail:JSON.stringify(result.totals)});
  return fclEstimateCalculationSchema.parse(result);
}

export function calculateFclEstimate(dataset:FclRateDataset,request:FclEstimateRequest,rateId:string,templateId:string):FclEstimateCalculation {
  if(dataset.contract_version!==FCL_RATE_DATASET_V2)throw new PortalError('fcl_operations_not_configured');
  const rate=dataset.rates.find(v=>v.rate_id===rateId),ops=dataset.operations;
  const templates=ops.templates.filter(t=>t.id===templateId&&t.enabled&&inWindow(t,request.shipping_date));
  const template=templates[0]??ops.templates.find(t=>t.id===templateId&&t.enabled);
  if(!rate||!template)throw new PortalError('fcl_estimate_source_not_found');
  const blockers:string[]=[];
  if(templates.length!==1)blockers.push(templates.length?'template_ambiguous':'template_expired');
  if(!inWindow(rate,request.shipping_date))blockers.push('ocean_rate_expired');
  if(rate.pol!==request.pol||rate.pod!==template.pod)blockers.push('route_mismatch');
  const details=ops.rate_details.filter(v=>v.rate_id===rateId),schedule=details[0]??null;
  if(details.length>1)blockers.push('schedule_ambiguous');
  const lines:Line[]=[];
  const componentVersions=[{ref:`ocean-rate:${rate.rate_id}`,version:rate.source_version},{ref:`template:${template.id}`,version:String(template.version)},{ref:template.fx_source,version:String(template.version)}];
  const capacity=(value:{weight_min_kg:string|null;weight_max_kg:string|null;volume_min_cbm:string|null;volume_max_cbm:string|null},prefix:string)=>{
    for(const [input,min,max,unit] of [[request.weight_kg,value.weight_min_kg,value.weight_max_kg,'kg'],[request.volume_cbm,value.volume_min_cbm,value.volume_max_cbm,'cbm']] as const){
      if(min===null&&max===null)continue;
      if(input===null)blockers.push(`${prefix}_${unit}_required`);
      else if((min!==null&&new D(input).lt(min))||(max!==null&&new D(input).gt(max)))blockers.push(`${prefix}_${unit}_out_of_range`);
    }
  };
  capacity(template,'template');
  const add=(line:Omit<Line,'cost_amount'|'sell_amount'>)=>lines.push({...line,cost_amount:'0.00',sell_amount:'0.00'});
  for(const box of request.containers){
    const item=rate.items.find(v=>v.container_type===box.type);
    if(!item||!template.container_types.includes(box.type)){blockers.push(`container_unavailable:${box.type}`);continue;}
    add({id:`ocean_freight:${box.type}`,code:'ocean_freight',name_zh:'海运费',name_en:'Ocean Freight',category:'ocean',source_ref:rate.source_ref,source_version:rate.source_version,valid_from:rate.valid_from,valid_until:rate.valid_until,unit:'CNTR',container_type:box.type,quantity:String(box.quantity),cost_price:item.ocean_freight,sell_price:selling(item.ocean_freight,template.margin_rule),currency:item.currency,editable:true});
  }
  const charged=new Set<string>();
  const addCharge=(chargeId:string)=>{
    if(charged.has(chargeId)){blockers.push(`charge_duplicate:${chargeId}`);return;}charged.add(chargeId);
    const choices=ops.charges.filter(v=>v.id===chargeId&&inWindow(v,request.shipping_date));
    if(choices.length!==1){blockers.push(`charge_${choices.length?'ambiguous':'unavailable'}:${chargeId}`);return;}
    const c=choices[0]!;
    componentVersions.push({ref:`charge:${c.id}`,version:String(c.version)});
    if(c.country!==template.country||(c.pod!==null&&c.pod!==template.pod)||(c.destination!==null&&c.destination!==template.destination)){blockers.push(`charge_route_mismatch:${c.id}`);return;}
    if(request.containers.some(box=>!c.container_types.includes(box.type))){blockers.push(`charge_container_mismatch:${c.id}`);return;}
    const boxes=c.unit==='CNTR'?request.containers:[{type:null,quantity:1}];
    for(const box of boxes)add({id:`charge:${c.id}:${box.type??'shipment'}`,code:c.code,name_zh:c.name_zh,name_en:c.name_en,category:c.category,...pickSource(c),unit:c.unit,container_type:box.type,quantity:String(box.quantity),cost_price:c.amount,sell_price:c.sell_amount??selling(c.amount,template.margin_rule),currency:c.currency,editable:c.editable});
  };
  for(const chargeId of template.charge_ids)addCharge(chargeId);
  rate.additional_fees.forEach((fee,index)=>{
    const box=fee.unit==='CNTR'?request.containers.find(c=>c.type===fee.container_type):{quantity:1};
    if(!box)return;
    add({id:`rate_fee:${index}:${fee.service}:${fee.unit}:${fee.container_type??'shipment'}`,code:`rate_fee_${index}`,name_zh:fee.name,name_en:fee.name,category:fee.group==='A'?'origin':fee.group==='B'?'ocean':'destination',source_ref:rate.source_ref,source_version:rate.source_version,valid_from:rate.valid_from,valid_until:rate.valid_until,unit:fee.unit,container_type:fee.container_type,quantity:String(box.quantity),cost_price:fee.cost_price,sell_price:selling(fee.cost_price,template.margin_rule),currency:fee.currency,editable:true});
  });
  if(template.delivery_rate_id!==null){
    const candidates=ops.delivery_rates.filter(d=>d.id===template.delivery_rate_id&&inWindow(d,request.shipping_date));
    if(candidates.length!==1)blockers.push(`delivery_${candidates.length?'ambiguous':'unavailable'}:${template.delivery_rate_id}`);
    else{
      const delivery=candidates[0]!;componentVersions.push({ref:`delivery:${delivery.id}`,version:String(delivery.version)});capacity(delivery,'delivery');
      if(delivery.country!==template.country||delivery.origin!==template.pod||delivery.destination!==template.destination||delivery.service_mode!==template.service_mode)blockers.push('delivery_route_mismatch');
      if(request.containers.some(box=>!delivery.container_types.includes(box.type)))blockers.push('delivery_container_mismatch');
      if(delivery.postal_codes.length&&(!request.postal_code||!delivery.postal_codes.includes(request.postal_code)))blockers.push('delivery_postal_code_mismatch');
      if(delivery.zones.length&&(!request.zone||!delivery.zones.includes(request.zone)))blockers.push('delivery_zone_mismatch');
      let amount=delivery.base_rate;
      if(delivery.tiers.length){
        const tiers=request.weight_kg===null?[]:delivery.tiers.filter(t=>new D(request.weight_kg!).gte(t.min_kg)&&new D(request.weight_kg!).lte(t.max_kg));
        if(tiers.length!==1)blockers.push(tiers.length?'delivery_tier_ambiguous':'delivery_tier_unavailable');
        else amount=tiers[0]!.amount;
      }
      const boxes=delivery.unit==='CNTR'?request.containers:[{type:null,quantity:1}];
      for(const box of boxes)add({id:`delivery:${delivery.id}:${box.type??'shipment'}`,code:'inland_delivery',name_zh:'内陆运输',name_en:'Inland Delivery',category:'inland',...pickSource(delivery),unit:delivery.unit,container_type:box.type,quantity:String(box.quantity),cost_price:amount,sell_price:selling(amount,template.margin_rule),currency:delivery.currency,editable:true});
      for(const chargeId of delivery.surcharge_ids)addCharge(chargeId);
    }
  }
  if(lines.filter(line=>!line.id.startsWith('ocean_freight:')&&!line.id.startsWith('rate_fee:')).length>60)blockers.push('fcl_estimate_too_many_customer_lines');
  const validFrom=[rate.valid_from,template.valid_from,...lines.map(l=>l.valid_from)].sort().at(-1)!;
  const validUntil=[rate.valid_until,template.valid_until,...lines.map(l=>l.valid_until)].sort()[0]!;
  return refreshFclEstimateTotals({engine_version:FCL_OPERATIONS_VERSION,quote_status:'system_estimated',send_status:'not_sent',rate_id:rate.rate_id,template_id:template.id,template_version:template.version,carrier:schedule?.carrier??rate.supplier_label,routing:schedule?.routing??template.routing,pol:rate.pol,pod:rate.pod,destination:template.destination,schedule,valid_from:validFrom,valid_until:validUntil,lines,totals:{currency:'CNY',cost_total:null,sell_total:null,gross_profit:null,gross_margin:null},by_currency:[],breakdown:[],margin_rule:template.margin_rule,exchange_rates:template.exchange_rates,source_refs:[...new Map([...componentVersions,...lines.map(l=>({ref:l.source_ref,version:l.source_version}))].map(ref=>[JSON.stringify(ref),ref])).values()],assumptions:['explicit_shipping_date','exact_route_match','maintained_schedule_not_carrier_confirmation','row_rounding_before_currency_totals'],warnings:[],blockers:[...new Set(blockers)],calculation_trace:[]});
}

function pickSource(value:Pick<FclCharge,'source_ref'|'source_version'|'valid_from'|'valid_until'>){return {source_ref:value.source_ref,source_version:value.source_version,valid_from:value.valid_from,valid_until:value.valid_until};}

export function estimateToQuoteDraft(estimate:FclEstimateSnapshot):FclQuoteDraftInput {
  const calculation=estimate.calculation;
  const source=calculation.lines.filter(l=>l.id.startsWith('ocean_freight:')||l.id.startsWith('rate_fee:'));
  const manual=calculation.lines.filter(l=>!source.includes(l));
  return {
    extensions:{fcl_estimate_v1:{estimate_id:estimate.estimate_id,version:estimate.version,content_digest:estimate.content_digest,valid_from:calculation.valid_from,valid_until:calculation.valid_until}},
    source_sell_prices:source.map(l=>({row_key:l.id,sell_price:l.sell_price,customer_note:null})),
    manual_fees:manual.map(l=>{
      const h=createHash('sha256').update(`${estimate.estimate_id}:${l.id}`).digest('hex');
      const service=({origin:'pickup',destination:'delivery',customs:'canada_customs',inland:'delivery',ocean:'ocean_freight',other:'ocean_freight',risk:'ocean_freight'} as const)[l.category];
      return {id:`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`,template_ref:null,name:`${l.name_zh} ${l.name_en}`,group:l.category==='origin'?'A':l.category==='ocean'?'B':'C',service,quantity:l.quantity,unit:l.unit==='CNTR'?'CNTR':'SHIPMENT',container_type:l.container_type,cost_price:l.cost_price,sell_price:l.sell_price,currency:l.currency,internal_note:null,customer_note:null,evidence_ref:`fcl-estimate:${estimate.estimate_id}`,evidence_version:String(estimate.version),quantity_conditions:`${l.code}; ${l.valid_from}..${l.valid_until}`};
    }),service_scopes:[],exchange_rates:calculation.exchange_rates,remark:null,
  };
}
