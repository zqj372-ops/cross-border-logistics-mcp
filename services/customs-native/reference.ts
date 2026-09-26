import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { NomenclatureRowSchema, TariffRuleRowSchema, SourceRowSchema } from './contracts';
import { inputSchema } from '../access-gateway/portal/business/customs-client';
import type { CustomsBusinessClientPort, PortalBusinessClientResult } from '../access-gateway/portal/business/service';
import { nameTranslationSchema, nameTranslationConfig, type createCustomsNameTranslator } from './name-translation';

export const customsReferenceDataV1 = z.object({
  request_id: z.string().min(1).max(128),
  formal_ready: z.literal(false), rule_date: z.iso.date(), snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  candidates: z.array(z.object({
    item: NomenclatureRowSchema, hierarchy: z.array(NomenclatureRowSchema).max(7),
    rates: z.array(TariffRuleRowSchema).max(100),
  }).strict()).max(27), sources: z.array(SourceRowSchema).max(20), warnings: z.array(z.string()).max(10),
}).strict();
export const customsReferenceData = customsReferenceDataV1.extend({candidates:z.array(customsReferenceDataV1.shape.candidates.element.extend({name_translation:nameTranslationSchema.nullable()})).max(27)});
export const customsReferenceVersion = 'portal-customs-reference@2026-09-27.v2';
export const customsReferenceConfig = z.object({ snapshotFile: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u), nameTranslation:nameTranslationConfig.optional() }).strict();
const officialHosts = new Set(['gss.mof.gov.cn','online.customs.gov.cn','www.cbsa-asfc.gc.ca','www.usitc.gov','hts.usitc.gov']);
function identity(path: string) {
  const s=lstatSync(path);
  if(!isAbsolute(path)||!s.isFile()||s.isSymbolicLink()||s.size>1024**3||existsSync(path+'-wal'))throw new Error('customs_reference_file_invalid');
  return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
}
function hash(path: string) {
  const fd=openSync(path,'r'), h=createHash('sha256'), b=Buffer.alloc(1024*1024);
  try { let n; while((n=readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n)); return h.digest('hex'); } finally { closeSync(fd); }
}
export function createCustomsReferenceClient(config: z.infer<typeof customsReferenceConfig>,translate?:ReturnType<typeof createCustomsNameTranslator>): CustomsBusinessClientPort {
  const expectedIdentity=identity(config.snapshotFile);
  if(hash(config.snapshotFile)!==config.sha256||identity(config.snapshotFile)!==expectedIdentity)throw new Error('customs_reference_hash_mismatch');
  return { query: request => Promise.resolve().then(async () => {
    const fail=(code:string):PortalBusinessClientResult=>({schema_version:'portal-business@2026-09-05.v1',status:'unavailable',data:null,reason_codes:[code]});
    const parsed=inputSchema.safeParse(request.input); if(!parsed.success)return fail('customs_request_invalid');
    let db:DatabaseSync|undefined;
    try {
      if(identity(config.snapshotFile)!==expectedIdentity)return fail('customs_reference_changed');
      db=new DatabaseSync(config.snapshotFile,{readOnly:true});db.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF');
      const {ruleDate,codeCountry,selectedHs6}=parsed.data;
      const sources=SourceRowSchema.array().max(20).parse(db.prepare('SELECT * FROM source_release WHERE effective_from<=? AND (effective_to IS NULL OR effective_to>=?)').all(ruleDate,ruleDate));
      if(!sources.length)return fail('customs_reference_date_unavailable');
      for(const s of sources){const url=new URL(s.official_url);if(url.protocol!=='https:'||url.username||url.password||!officialHosts.has(url.hostname))throw new Error('source_invalid');}
      const byId=new Map(sources.map(s=>[s.id,s]));
      const normalize=(row:Record<string,unknown>)=>{const s=byId.get(String(row.release_id));if(!s)throw new Error('source_invalid');return {...row,...Object.fromEntries(Object.entries(s).filter(([k])=>k!=='id'&&k!=='country').map(([k,v])=>['release_'+k,v]))};};
      const numeric=parsed.data.query.replace(/[.\s]/gu,'');
      const code=selectedHs6??(/^\d{4,10}$/u.test(numeric)?numeric:null);
      const candidates:z.infer<typeof customsReferenceData>['candidates']=[];
      const ids=sources.map(s=>s.id),inIds=ids.map(()=>'?').join(',');
      const eligible=`release_id IN (${inIds}) AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)`;
      for(const country of ['CN','US','CA']) {
        if(!code&&codeCountry&&codeCountry!==country)continue;
        const terms=parsed.data.query.normalize('NFKC').trim().split(/\s+/u).slice(0,8);
        const search=code?(code.length>6&&codeCountry===country?'code=?':"substr(code,1,?)=?"):terms.map(()=>"instr(lower(description_original),lower(?))>0").join(' AND ');
        const lookup=code?(code.length>6&&codeCountry===country?[code]:[Math.min(code.length,6),code.slice(0,6)]):terms;
        const rows=db.prepare(`SELECT * FROM nomenclature WHERE country=? AND ${eligible} AND (${search}) ORDER BY is_declarable DESC,code,language LIMIT 9`).all(country,...ids,ruleDate,ruleDate,...lookup);
        for(const row of rows){
          const item=NomenclatureRowSchema.parse(normalize(row));
          const hierarchy:z.infer<typeof NomenclatureRowSchema>[]=[];let parent=item.parent_code;
          while(parent&&hierarchy.length<7&&!hierarchy.some(p=>p.code===parent)){
            const r=db.prepare('SELECT * FROM nomenclature WHERE release_id=? AND code=? AND language=? LIMIT 1').get(item.release_id,parent,item.language);
            if(!r)break;const p=NomenclatureRowSchema.parse(normalize(r));hierarchy.unshift(p);parent=p.parent_code;
          }
          const ancestorCodes=[item.code,...hierarchy.map(p=>p.code)],params:SQLInputValue[]=[country,...ids,ruleDate,ruleDate,...ancestorCodes,item.code];
          const rawRates=db.prepare(`SELECT * FROM tariff_rule WHERE country=? AND ${eligible} AND (code IN (${ancestorCodes.map(()=>'?').join(',')}) OR (code_match_type='prefix' AND substr(?,1,length(code))=code)) ORDER BY code,treatment,id LIMIT 100`).all(...params);
          candidates.push({item,hierarchy,rates:rawRates.map(row=>TariffRuleRowSchema.parse(normalize(row))),name_translation:null});
        }
      }
      if(identity(config.snapshotFile)!==expectedIdentity)return fail('customs_reference_changed');
      db.close();db=undefined;
      // Translate the selected source language once; the Canadian French original remains available in evidence.
      const toTranslate=candidates.filter(candidate=>!candidate.item.language.startsWith('fr')||!candidates.some(other=>other.item.country===candidate.item.country&&other.item.code===candidate.item.code&&other.item.language.startsWith('en')));
      if(translate){const translations=await translate(toTranslate.map(({item,hierarchy})=>({language:item.language,text:[...new Set([hierarchy.at(-1)?.description_original,item.description_original].filter(Boolean))].join(' — ')})));toTranslate.forEach((candidate,index)=>{candidate.name_translation=translations[index]??null;});}
      if(identity(config.snapshotFile)!==expectedIdentity)return fail('customs_reference_changed');
      const data=customsReferenceData.parse({request_id:request.requestId,formal_ready:false,rule_date:ruleDate,snapshot_sha256:config.sha256,candidates,sources,warnings:[
        '官方原文参考与候选归类；来源资料尚未完成正式发布审核，不是正式归类或应缴税费。',
        '税率按所属税目原文展示；父级规则、优惠待遇、原产地及商品条件仍须核对。',
        '附加税、贸易救济、排除条款、许可证、汇率和总税费尚待核验；未展示不代表不适用或税率为零。',
        '各地区最多展示 9 条候选，请用更完整税号或法律品名缩小范围；其他地区同 HS 前缀仅供对照。',
      ]});
      return {schema_version:customsReferenceVersion,status:'manual_review',data,reason_codes:['customs_reference_only']};
    } catch { return fail('customs_reference_invalid'); } finally { db?.close(); }
  })};
}
