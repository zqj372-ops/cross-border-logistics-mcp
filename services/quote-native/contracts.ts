import { z } from 'zod';
const amount=z.string().regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,4})?$/u);
const money=z.string().regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/u);
const positive=amount.refine(v=>Number(v)>0);
const id=z.string().trim().min(1).max(100);
export const residentialRatesSchema=z.object({
 label:id,currency:z.literal('USD'),origin:id,valid_from:z.iso.date(),valid_until:z.iso.date(),evidence_ref:id,evidence_version:id,customer_terms:z.string().trim().min(1).max(2000),
 zones:z.array(z.object({postal_prefix:z.string().regex(/^[ABCEGHJKLMNPRSTVXY][0-9][ABCEGHJKLMNPRSTVWXYZ](?:[0-9][ABCEGHJKLMNPRSTVWXYZ][0-9])?$/u),zone:z.number().int().min(0).max(999),city:id,province:z.string().regex(/^[A-Z]{2}$/u)}).strict()).min(1).max(100000),
 rates:z.array(z.object({zone:z.number().int().min(0).max(999),pallets:z.number().int().min(1).max(1000),amount:money}).strict()).min(1).max(10000),
 billing:z.object({cbm_per_pallet:positive,kg_per_pallet:positive,long_piece_threshold_cm:positive,long_piece_multiplier:z.number().int().min(1).max(10),flexible_packaging_threshold:z.number().int().positive(),suspicious_min_pallets:z.number().int().positive(),suspicious_multiplier:z.number().int().positive(),max_weight_kg:positive,max_cbm:positive,max_length_cm:positive}).strict(),
 fees:z.object({fuel_percent:amount,residential:money,liftgate:money,pallet_jack:money,appointment:money,detention_free_minutes:z.number().int().nonnegative(),detention_half_hour:money}).strict(),
}).strict().refine(d=>d.valid_from<=d.valid_until);
export type ResidentialRates=z.infer<typeof residentialRatesSchema>;
export function validateResidentialRates(input:unknown):string[]{const p=residentialRatesSchema.safeParse(input);if(!p.success)return ['运价格式不完整；费用和计费阈值必须明确填写，免费填 0。'];const d=p.data,errors:string[]=[];
 if(new Set(d.zones.map(z=>z.postal_prefix)).size!==d.zones.length)errors.push('邮编覆盖重复。');
 if(new Set(d.rates.map(r=>`${r.zone}:${r.pallets}`)).size!==d.rates.length)errors.push('同一区域、计费托数存在多个价格。');
 if(d.zones.some(z=>!d.rates.some(r=>r.zone===z.zone)))errors.push('部分分区没有运价。');
 return errors;
}
