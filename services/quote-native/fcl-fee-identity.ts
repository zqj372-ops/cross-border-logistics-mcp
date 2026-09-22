/** Exact base-freight labels only. An ocean-category surcharge is not base freight. */
export function isBaseOceanFreight(value:{code?:string;name_zh?:string;name_en?:string;name?:string}):boolean {
  const labels=[value.code,value.name_zh,value.name_en,value.name].filter((v):v is string=>typeof v==='string');
  return labels.some(label=>['海运费','基础海运费','基本海运费','oceanfreight','baseoceanfreight','basicoceanfreight','of'].includes(label.split(' · ')[0]!.trim().toLowerCase().replace(/[\s_-]/gu,'')));
}
