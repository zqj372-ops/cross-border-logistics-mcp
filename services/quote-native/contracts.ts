import { z } from 'zod';
const amount=z.string().regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,4})?$/u);
const money=z.string().regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/u);
const positive=amount.refine(v=>Number(v)>0);
const id=z.string().trim().min(1).max(100);
const zonesSchema=z.array(z.object({postal_prefix:z.string().regex(/^[ABCEGHJKLMNPRSTVXY][0-9][ABCEGHJKLMNPRSTVWXYZ](?:[0-9][ABCEGHJKLMNPRSTVWXYZ][0-9])?$/u),zone:z.number().int().min(0).max(999),city:id,province:z.string().regex(/^[A-Z]{2}$/u)}).strict()).min(1).max(100000);
const ratesSchema=z.array(z.object({zone:z.number().int().min(0).max(999),pallets:z.number().int().min(1).max(1000),amount:money}).strict()).min(1).max(10000);
const controlsSchema=z.array(z.object({zone:z.number().int().min(0).max(999),enabled:z.boolean(),fuel_percent:amount.nullable()}).strict()).max(1000);
export const residentialRatesSchema=z.object({
 label:id,currency:z.literal('USD'),origin:id,valid_from:z.iso.date(),valid_until:z.iso.date(),evidence_ref:id,evidence_version:id,customer_terms:z.string().trim().min(1).max(2000),
 zones:zonesSchema,
 rates:ratesSchema,
 extensions:z.object({zone_controls_v1:controlsSchema,postal_city_v1:z.literal(true).optional(),origins_v1:z.array(z.object({origin:id,zones:zonesSchema,rates:ratesSchema,zone_controls_v1:controlsSchema}).strict()).max(10).optional(),quote_valid_days_v1:z.number().int().min(1).max(365).optional()}).strict().optional(),
 billing:z.object({cbm_per_pallet:positive,kg_per_pallet:positive,long_piece_threshold_cm:positive,long_piece_multiplier:z.number().int().min(1).max(10),flexible_packaging_threshold:z.number().int().positive(),suspicious_min_pallets:z.number().int().positive(),suspicious_multiplier:z.number().int().positive(),max_weight_kg:positive.nullable(),max_cbm:positive.nullable(),max_length_cm:positive.nullable()}).strict(),
 fees:z.object({fuel_percent:amount,residential:money,liftgate:money,pallet_jack:money,appointment:money,detention_free_minutes:z.number().int().nonnegative(),detention_half_hour:money}).strict(),
}).strict().refine(d=>d.valid_from<=d.valid_until);
export type ResidentialRates=z.infer<typeof residentialRatesSchema>;
export function validateResidentialRates(input:unknown):string[]{const p=residentialRatesSchema.safeParse(input);if(!p.success)return ['运价格式不完整；费用和计费阈值必须明确填写，免费填 0。'];const d=p.data,errors:string[]=[];
 if(new Set(d.zones.map(z=>d.extensions?.postal_city_v1?`${z.postal_prefix}:${z.city.trim().replace(/\s+/gu,' ').toUpperCase()}:${z.province}:${z.zone}`:z.postal_prefix)).size!==d.zones.length)errors.push('邮编覆盖重复。');
 if(new Set(d.rates.map(r=>`${r.zone}:${r.pallets}`)).size!==d.rates.length)errors.push('同一区域、计费托数存在多个价格。');
 if(d.zones.some(z=>!d.rates.some(r=>r.zone===z.zone)&&!d.extensions?.zone_controls_v1.some(c=>c.zone===z.zone&&!c.enabled)))errors.push('部分分区没有运价。');
 const controls=d.extensions?.zone_controls_v1??[];
 if(new Set(controls.map(c=>c.zone)).size!==controls.length)errors.push('分区开关或燃油覆盖重复。');
 if(controls.some(c=>!d.zones.some(z=>z.zone===c.zone)&&!d.rates.some(r=>r.zone===c.zone)))errors.push('分区配置没有对应邮编或价格。');
 const origins=d.extensions?.origins_v1??[];if(new Set([d.origin,...origins.map(o=>o.origin)]).size!==origins.length+1)errors.push('起运地配置重复。');for(const origin of origins)errors.push(...validateResidentialRates({...d,origin:origin.origin,zones:origin.zones,rates:origin.rates,extensions:{zone_controls_v1:origin.zone_controls_v1,...(d.extensions?.postal_city_v1?{postal_city_v1:true}:{})}}));
 return [...new Set(errors)];
}
