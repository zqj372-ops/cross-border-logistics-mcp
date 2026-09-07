import {z} from 'zod';
import Decimal from 'decimal.js';
const D=Decimal.clone({precision:48});
const positive=z.string().regex(/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,8})?$/u).refine(v=>new D(v).gt(0));
export const cargoLineSchema=z.object({id:z.string().min(1).max(80),quantity:z.number().int().min(1).max(100000),packaging_type:z.enum(['carton','crate','pallet','bag','other']),length_cm:positive,width_cm:positive,height_cm:positive,weight:z.object({mode:z.enum(['unit_weight','line_total_weight']),value_kg:positive}).strict()}).strict();
export const cargoLinesSchema=z.array(cargoLineSchema).min(1).max(100).refine(rows=>new Set(rows.map(r=>r.id)).size===rows.length);
export type CargoLine=z.infer<typeof cargoLineSchema>;
export function cargoTotals(input:unknown){const rows=cargoLinesSchema.parse(input);let cbm=new D(0),weight=new D(0),longest=new D(0),pieces=0;const lines=rows.map(r=>{const volume=new D(r.length_cm).mul(r.width_cm).mul(r.height_cm).mul(r.quantity).div(1000000),kg=new D(r.weight.value_kg).mul(r.weight.mode==='unit_weight'?r.quantity:1),max=D.max(r.length_cm,r.width_cm,r.height_cm);cbm=cbm.add(volume);weight=weight.add(kg);longest=D.max(longest,max);pieces+=r.quantity;return {...r,total_cbm:volume.toFixed(),total_weight_kg:kg.toFixed(),longest_side_cm:max.toFixed()};});return {cbm:cbm.toFixed(),weight_kg:weight.toFixed(),piece_count:pieces,longest_side_cm:longest.toFixed(),lines};}
export function cargoTotalsMatch(input:{cbm:string;weight_kg:string;piece_count:number;longest_side_cm?:string|null|undefined},totals:ReturnType<typeof cargoTotals>){return new D(input.cbm).eq(totals.cbm)&&new D(input.weight_kg).eq(totals.weight_kg)&&input.piece_count===totals.piece_count&&!!input.longest_side_cm&&new D(input.longest_side_cm).eq(totals.longest_side_cm);}
