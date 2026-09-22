import {PortalError} from '../access-gateway/portal/contracts';
import type {FclRateDataset} from './fcl-contracts';
import {FCL_RATE_DATASET_V2} from './fcl-operations-contracts';
import {isBaseOceanFreight} from './fcl-fee-identity';

const comparable=(value:object)=>{
  const copy={...value} as Record<string,unknown>;
  delete copy.updated_at;delete copy.valid_from;delete copy.valid_until;
  return JSON.stringify(copy);
};

/** Applied inside the normal audited/CAS configuration transaction, never to history. */
export function prepareFclMaintenance(next:FclRateDataset,previous:FclRateDataset|null,now:string):FclRateDataset {
  const result=structuredClone(next);
  const stamp=(rows:Array<{updated_at?:string|undefined}>,old:Array<{updated_at?:string|undefined}>,identity:(row:object)=>string)=>{
    for(const row of rows){
      const before=old.find(candidate=>identity(candidate)===identity(row));
      if(before&&comparable(before)===comparable(row)){
        if(before.updated_at)row.updated_at=before.updated_at;else delete row.updated_at;
      }else row.updated_at=now;
    }
  };
  for(const before of previous?.rates??[]){
    const nextRate=result.rates.find(rate=>rate.rate_id===before.rate_id);
    if(!nextRate)continue;
    for(const fee of before.additional_fees){
      if(!isBaseOceanFreight(fee)||fee.ocean_freight_resolution?.action==='exclude')continue;
      const replacement=nextRate.additional_fees.find(candidate=>candidate.name===fee.name&&candidate.unit===fee.unit&&candidate.container_type===fee.container_type);
      if(!replacement||replacement.cost_price!==fee.cost_price||replacement.currency!==fee.currency)throw new PortalError('fcl_legacy_ocean_fee_review');
    }
  }
  stamp(result.rates,previous?.rates??[],row=>(row as {rate_id:string}).rate_id);
  if(result.contract_version===FCL_RATE_DATASET_V2){
    const old=previous?.contract_version===FCL_RATE_DATASET_V2?previous.operations:null;
    for(const charge of old?.charges??[]){
      if(!isBaseOceanFreight(charge)||charge.ocean_freight_resolution?.action==='exclude')continue;
      const replacement=result.operations.charges.find(c=>c.id===charge.id&&c.version===charge.version);
      // Unresolved amounts and original billing evidence cannot disappear during an unrelated edit.
      if(!replacement||!isBaseOceanFreight(replacement)||['amount','currency','unit','container_types'].some(key=>JSON.stringify(replacement[key as keyof typeof replacement])!==JSON.stringify(charge[key as keyof typeof charge])))throw new PortalError('fcl_legacy_ocean_fee_review');
      for(const template of old?.templates??[]){
        if(!template.charge_ids.includes(charge.id))continue;
        const updated=result.operations.templates.find(t=>t.id===template.id&&t.version===template.version);
        if(updated&&!updated.charge_ids.includes(charge.id)&&replacement.ocean_freight_resolution?.action!=='exclude')throw new PortalError('fcl_legacy_ocean_fee_review');
      }
    }
    stamp(result.operations.charges,old?.charges??[],row=>{const c=row as {id:string;version:number};return `${c.id}:${c.version}`;});
    stamp(result.operations.templates,old?.templates??[],row=>{const c=row as {id:string;version:number};return `${c.id}:${c.version}`;});
  }
  return result;
}
