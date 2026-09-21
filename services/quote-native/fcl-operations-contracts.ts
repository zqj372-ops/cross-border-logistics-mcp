import {z} from 'zod';
import Decimal from 'decimal.js';
import {FCL_CONTAINER_TYPES} from '../../apps/inquiry/fcl-model';

export const FCL_OPERATIONS_VERSION='fcl-operations@2026-09-21.v1' as const;
export const FCL_RATE_DATASET_V2='fcl-rate-dataset@2026-09-21.v2' as const;
const id=z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u);
const text=z.string().trim().min(1).max(200);
const decimal=z.string().regex(/^(0|[1-9]\d{0,9})(?:\.\d{1,6})?$/u);
const positive=decimal.refine(value=>!/^0(?:\.0+)?$/u.test(value),'positive_amount_required');
const money=z.string().regex(/^-?\d{1,32}(?:\.\d{1,6})?$/u);
const currency=z.enum(['USD','CAD','CNY']);
const container=z.enum(FCL_CONTAINER_TYPES);
const date=z.iso.date();
const validity={valid_from:date,valid_until:date};
const source={source_ref:text,source_version:text};
const capacity={weight_min_kg:decimal.nullable(),weight_max_kg:decimal.nullable(),volume_min_cbm:decimal.nullable(),volume_max_cbm:decimal.nullable()};
export const fclChargeCategories=['ocean','origin','destination','customs','inland','other','risk'] as const;
export const fclDeliveryModes=['FTL','LTL','container_drayage','bonded_truck','rail_truck','warehouse_transfer'] as const;
export const fclChargeSchema=z.object({
  id,version:z.number().int().positive(),code:id,name_zh:text,name_en:text,
  category:z.enum(fclChargeCategories),amount:decimal,currency,
  unit:z.enum(['FIXED','CNTR','SHIPMENT']),container_types:z.array(container).min(1).max(4),
  sell_amount:decimal.nullable(),editable:z.boolean(),country:z.string().length(2),pod:text.nullable(),destination:text.nullable(),
  ...validity,...source,remark:z.string().max(500).nullable(),
}).strict();
export const fclDeliveryRateSchema=z.object({
  id,version:z.number().int().positive(),origin:text,destination:text,country:z.string().length(2),
  postal_codes:z.array(text).max(100),zones:z.array(text).max(50),service_mode:z.enum(fclDeliveryModes),
  container_types:z.array(container).min(1).max(4),...capacity,
  base_rate:decimal,currency,unit:z.enum(['CNTR','SHIPMENT']),
  tiers:z.array(z.object({min_kg:decimal,max_kg:decimal,amount:decimal}).strict()).max(30),
  surcharge_ids:z.array(id).max(30),...validity,...source,remark:z.string().max(500).nullable(),
}).strict();
export const fclMarginRuleSchema=z.object({mode:z.enum(['cost_markup','gross_margin']),value:decimal}).strict().refine(v=>v.mode!=='gross_margin'||/^(?:0(?:\.\d+)?)$/u.test(v.value),'gross_margin_must_be_below_one');
export const fclDestinationTemplateSchema=z.object({
  id,version:z.number().int().positive(),label:text,country:z.string().length(2),pod:text,destination:text,routing:text,
  service_mode:z.enum(fclDeliveryModes),customs_mode:text,container_types:z.array(container).min(1).max(4),...capacity,
  charge_ids:z.array(id).max(40),delivery_rate_id:id.nullable(),
  margin_rule:fclMarginRuleSchema,exchange_rates:z.object({USD:positive.nullable(),CAD:positive.nullable()}).strict(),
  fx_source:text,...validity,enabled:z.boolean(),
}).strict();
export const fclRateDetailSchema=z.object({rate_id:z.string().uuid(),carrier:text,routing:text,vessel:text.nullable(),voyage:text.nullable(),etd:date.nullable(),eta:date.nullable(),transit_days:z.number().int().min(1).max(180).nullable()}).strict();
export const fclOperationsSchema=z.object({
  rate_details:z.array(fclRateDetailSchema).max(500),charges:z.array(fclChargeSchema).max(1000),
  delivery_rates:z.array(fclDeliveryRateSchema).max(500),templates:z.array(fclDestinationTemplateSchema).max(200),
}).strict();
export function validateFclOperations(ops:z.infer<typeof fclOperationsSchema>,rateIds:string[]):string[]{
  const errors=new Set<string>();
  const unique=(values:string[])=>new Set(values).size===values.length;
  for(const records of [ops.charges,ops.delivery_rates,ops.templates]){
    records.forEach((row,index)=>{
      if(row.valid_from>row.valid_until)errors.add('operations_date_order_invalid');
      if(!unique(row.container_types))errors.add('duplicate_container_type');
      for(const other of records.slice(index+1))if(row.id===other.id){
        if(row.version===other.version)errors.add('operations_duplicate_version');
        if(row.valid_from<=other.valid_until&&other.valid_from<=row.valid_until)errors.add('operations_validity_overlap');
      }
    });
  }
  for(const row of [...ops.delivery_rates,...ops.templates]){
    for(const [min,max] of [[row.weight_min_kg,row.weight_max_kg],[row.volume_min_cbm,row.volume_max_cbm]])if(min!==null&&max!==null&&new Decimal(min!).gt(max!))errors.add('operations_capacity_invalid');
  }
  const charges=new Set(ops.charges.map(c=>c.id)),delivery=new Set(ops.delivery_rates.map(d=>d.id));
  for(const row of ops.delivery_rates){
    if(!unique(row.surcharge_ids)||row.surcharge_ids.some(id=>!charges.has(id)))errors.add('operations_charge_reference_invalid');
    row.tiers.forEach((tier,index)=>{
      if(new Decimal(tier.min_kg).gt(tier.max_kg))errors.add('operations_tier_invalid');
      if(row.tiers.slice(index+1).some(other=>new Decimal(tier.min_kg).lte(other.max_kg)&&new Decimal(other.min_kg).lte(tier.max_kg)))errors.add('operations_tier_overlap');
    });
  }
  for(const row of ops.templates){
    if(!unique(row.charge_ids)||row.charge_ids.some(id=>!charges.has(id)))errors.add('operations_charge_reference_invalid');
    if(row.delivery_rate_id!==null&&!delivery.has(row.delivery_rate_id))errors.add('operations_delivery_reference_invalid');
  }
  if(!unique(ops.rate_details.map(d=>d.rate_id)))errors.add('operations_schedule_duplicate');
  for(const detail of ops.rate_details){if(!rateIds.includes(detail.rate_id))errors.add('operations_rate_reference_invalid');if(detail.etd&&detail.eta&&detail.etd>detail.eta)errors.add('operations_schedule_date_invalid');}
  return [...errors];
}
export type FclOperations=z.infer<typeof fclOperationsSchema>;
export type FclCharge=z.infer<typeof fclChargeSchema>;
export const fclEstimateRequestSchema=z.object({
  shipping_date:date,pol:text,rate_ids:z.array(z.string().uuid()).max(30),template_ids:z.array(id).max(30),
  containers:z.array(z.object({type:container,quantity:z.number().int().min(1).max(1000),unit:z.literal('CNTR')}).strict()).min(1).max(4),
  weight_kg:positive.nullable(),volume_cbm:positive.nullable(),postal_code:text.nullable(),zone:text.nullable(),
  case_ref:z.string().uuid().nullable(),
}).strict().refine(v=>new Set(v.containers.map(c=>c.type)).size===v.containers.length,'duplicate_container_type');
export type FclEstimateRequest=z.infer<typeof fclEstimateRequestSchema>;
export const fclEstimateLineSchema=z.object({
  id:text,code:text,name_zh:text,name_en:text,category:z.enum(fclChargeCategories),
  source_ref:text,source_version:text,...validity,
  unit:z.enum(['FIXED','CNTR','SHIPMENT']),container_type:container.nullable(),quantity:positive,
  cost_price:decimal,sell_price:decimal,currency,cost_amount:money,sell_amount:money,editable:z.boolean(),
}).strict();
const totalSchema=z.object({currency,cost_total:money.nullable(),sell_total:money.nullable(),gross_profit:money.nullable(),gross_margin:money.nullable()}).strict();
export const fclEstimateCalculationSchema=z.object({
  engine_version:z.literal(FCL_OPERATIONS_VERSION),quote_status:z.literal('system_estimated'),send_status:z.literal('not_sent'),
  rate_id:z.string().uuid(),template_id:id,template_version:z.number().int().positive(),carrier:text,routing:text,pol:text,pod:text,destination:text,
  schedule:fclRateDetailSchema.nullable(),...validity,
  lines:z.array(fclEstimateLineSchema).max(120),totals:totalSchema,
  by_currency:z.array(totalSchema).max(3),breakdown:z.array(z.object({category:z.enum(fclChargeCategories),currency,amount:money}).strict()).max(21),
  margin_rule:fclMarginRuleSchema,exchange_rates:fclDestinationTemplateSchema.shape.exchange_rates,
  source_refs:z.array(z.object({ref:text,version:text}).strict()).max(150),
  assumptions:z.array(text).max(20),warnings:z.array(text).max(100),blockers:z.array(text).max(100),
  calculation_trace:z.array(z.object({step:text,detail:z.string().max(1000)}).strict()).max(200),
}).strict();
export type FclEstimateCalculation=z.infer<typeof fclEstimateCalculationSchema>;
export const fclEstimateAdjustmentSchema=z.object({line_id:text,original_amount:decimal,adjusted_amount:decimal,reason:z.string().trim().min(1).max(500),actor:text,modified_at:z.iso.datetime()}).strict();
export const fclEstimateSnapshotSchema=z.object({
  contract_version:z.literal(FCL_OPERATIONS_VERSION),estimate_id:z.string().uuid(),version:z.number().int().positive(),
  revision_id:z.string().uuid(),request:fclEstimateRequestSchema,calculation:fclEstimateCalculationSchema,
  source_release_id:z.string().uuid(),source_digest:z.string().length(64),dependency_digest:z.string().length(64),actor:text,created_at:z.iso.datetime(),
  locked:z.boolean(),recommended:z.boolean(),adjustments:z.array(fclEstimateAdjustmentSchema).max(120),
  copied_from:z.object({estimate_id:z.string().uuid(),version:z.number().int().positive()}).strict().nullable(),
  content_digest:z.string().length(64),
}).strict();
export const fclEstimateViewSchema=fclEstimateSnapshotSchema.extend({historical:z.boolean(),current_version:z.number().int().positive(),currentness:z.object({valid_now:z.boolean(),reason_codes:z.array(text).max(10)}).strict()}).strict();
export type FclEstimateSnapshot=z.infer<typeof fclEstimateSnapshotSchema>;
export type FclEstimateView=z.infer<typeof fclEstimateViewSchema>;
export const fclEstimateListSchema=z.object({items:z.array(fclEstimateViewSchema).max(500)}).strict();
export const fclEstimateListRequestSchema=z.object({case_ref:z.string().uuid().nullable(),destination:text.nullable(),shipping_date:date.nullable()}).strict();
export const fclEstimateGetSchema=z.object({estimate_id:z.string().uuid(),version:z.number().int().positive().nullable()}).strict();
export const fclEstimateActionSchema=z.object({estimate_id:z.string().uuid(),expected_version:z.number().int().positive()}).strict();
export const fclEstimateAdjustSchema=fclEstimateActionSchema.extend({locked:z.boolean(),recommended:z.boolean(),reason:z.string().trim().min(1).max(500),changes:z.array(z.object({line_id:text,sell_price:decimal}).strict()).max(120)}).strict();
export const fclEstimateSelectSchema=fclEstimateActionSchema.extend({case_ref:z.string().uuid(),expected_case_version:z.number().int().positive(),expected_customer_supplement_ref:z.string().uuid().nullable()}).strict();
export const fclBulkChangeSchema=z.object({rate_id:z.string().uuid(),container_type:container,ocean_freight:decimal,...validity,source_ref:text,source_version:text}).strict();
export const fclBulkPreviewRequestSchema=z.object({expected_version:z.number().int().nonnegative(),estimate_request:fclEstimateRequestSchema.nullable().optional(),changes:z.array(fclBulkChangeSchema).min(1).max(100),reason:z.string().trim().min(1).max(500)}).strict();
export const fclBulkPublishRequestSchema=fclBulkPreviewRequestSchema.extend({preview_hash:z.string().length(64),confirmation:z.literal('reviewed_sources_and_conditions')}).strict();
export const fclBulkPreviewSchema=z.object({preview_hash:z.string().length(64),expected_version:z.number().int().nonnegative(),changes:z.array(z.object({rate_id:z.string().uuid(),container_type:container,original_amount:decimal,adjusted_amount:decimal,currency}).strict()).max(100),new_estimates:z.number().int().nonnegative(),affected_estimates:z.number().int().nonnegative(),locked_estimates:z.number().int().nonnegative()}).strict();
