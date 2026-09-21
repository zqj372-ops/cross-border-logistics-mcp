import {fclRateDatasetV2Schema} from '../../../services/quote-native/fcl-contracts';
import {fclEstimateRequestSchema} from '../../../services/quote-native/fcl-operations-contracts';
export const cosco='00000000-0000-4000-8000-000000000101';
export const one='00000000-0000-4000-8000-000000000102';
export const oocl='00000000-0000-4000-8000-000000000103';
const validity={valid_from:'2026-10-01',valid_until:'2026-12-31'};
const capacity={weight_min_kg:null,weight_max_kg:null,volume_min_cbm:null,volume_max_cbm:null};
export function operationsFixture(){return fclRateDatasetV2Schema.parse({
  contract_version:'fcl-rate-dataset@2026-09-21.v2',label:'Synthetic operations acceptance',
  rates:[cosco,one,oocl].map((rate_id,i)=>({rate_id,supplier_label:['COSCO','ONE','OOCL'][i],pol:'Shanghai',pod:'Vancouver',...validity,source_ref:'synthetic:ocean',source_version:'1',note:null,items:[{container_type:'40HQ',ocean_freight:String(3200+i*100),currency:'USD'}],additional_fees:[]})),
  operations:{
    rate_details:[cosco,one,oocl].map((rate_id,i)=>({rate_id,carrier:['COSCO','ONE','OOCL'][i],routing:'Shanghai → Vancouver',vessel:null,voyage:null,etd:'2026-10-15',eta:null,transit_days:18-i})),
    charges:[['thc','destination','100'],['customs','customs','200'],['reserve','risk','100']].map(([id,category,amount])=>({id,version:1,code:id,name_zh:id==='thc'?'码头操作费':id==='customs'?'清关费':'风险预留',name_en:id,category,amount,currency:'CAD',unit:'SHIPMENT',container_types:['40HQ'],sell_amount:null,editable:true,country:'CA',pod:'Vancouver',destination:null,...validity,source_ref:`synthetic:${id}`,source_version:'1',remark:null})),
    delivery_rates:[{id:'van-calgary',version:1,origin:'Vancouver',destination:'Calgary',country:'CA',postal_codes:[],zones:[],service_mode:'rail_truck',container_types:['40HQ'],...capacity,base_rate:'1200',currency:'CAD',unit:'CNTR',tiers:[],surcharge_ids:[],...validity,source_ref:'synthetic:delivery',source_version:'1',remark:null}],
    templates:[{id:'calgary',version:1,label:'Calgary',country:'CA',pod:'Vancouver',destination:'Calgary',routing:'Shanghai → Vancouver → Calgary',service_mode:'rail_truck',customs_mode:'broker',container_types:['40HQ'],...capacity,charge_ids:['thc','customs','reserve'],delivery_rate_id:'van-calgary',margin_rule:{mode:'cost_markup',value:'0.1'},exchange_rates:{USD:'7',CAD:'5.25'},fx_source:'synthetic:fx',...validity,enabled:true}],
  },
});}
export function estimateRequest(){return fclEstimateRequestSchema.parse({shipping_date:'2026-10-15',pol:'Shanghai',rate_ids:[],template_ids:[],containers:[{type:'40HQ',quantity:1}],weight_kg:null,volume_cbm:null,postal_code:null,zone:null,case_ref:null});}
