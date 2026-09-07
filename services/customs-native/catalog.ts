import { z } from 'zod';
import { type CustomsDataset, NomenclatureRowSchema, TariffRuleRowSchema, TradeMeasureRowSchema, RequirementRowSchema, SourceRowSchema } from './contracts';
export const customsBrowseInput=z.object({selection:z.enum(['published','draft']).default('published'),collection:z.enum(['nomenclature','tariffs','measures','requirements','sources']).default('nomenclature'),country:z.enum(['all','CN','US','CA']).default('all'),query:z.string().trim().max(200).default(''),offset:z.number().int().nonnegative().max(100000).default(0),limit:z.number().int().min(1).max(100).default(25)}).strict();
export const customsBrowseResult=z.object({selection:z.enum(['published','draft']),collection:z.enum(['nomenclature','tariffs','measures','requirements','sources']),label:z.string().nullable(),release_id:z.string().nullable(),version:z.number().int().nonnegative(),total:z.number().int().nonnegative(),offset:z.number().int().nonnegative(),limit:z.number().int().positive().max(100),rows:z.array(z.union([NomenclatureRowSchema,TariffRuleRowSchema,TradeMeasureRowSchema,RequirementRowSchema,SourceRowSchema])).max(100)}).strict();
type View={version:number;draft:CustomsDataset|null;active_release:{release_id:string;version:number;input:CustomsDataset}|null};
export function browseCustoms(view:View,input:unknown){
 const f=customsBrowseInput.parse(input),release=f.selection==='published'?view.active_release:null,data=f.selection==='published'?release?.input:view.draft;
 const terms=f.query.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);
 const matching=(data?.[f.collection]??[]).filter(row=>{if(f.country!=='all'&&row.country!==f.country)return false;const text=Object.values(row).filter(v=>typeof v==='string').join(' ').normalize('NFKC').toLowerCase();return terms.every(term=>text.includes(term));});
 return {selection:f.selection,collection:f.collection,label:data?.label??null,release_id:release?.release_id??null,version:release?.version??(f.selection==='draft'?view.version:0),total:matching.length,offset:f.offset,limit:f.limit,rows:matching.slice(f.offset,f.offset+f.limit)};
}
