import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { NomenclatureRowSchema, TariffRuleRowSchema, SourceRowSchema } from './contracts';
import { inputSchema } from '../access-gateway/portal/business/customs-client';
import type { CustomsBusinessClientPort, PortalBusinessClientResult } from '../access-gateway/portal/business/service';
import { nameTranslationSchema, nameTranslationConfig, type createCustomsNameTranslator } from './name-translation';
import type { createCustomsSearchTerms } from './search-terms';
import {complianceConfig,complianceData,loadComplianceReference} from './compliance-reference';

export const customsReferenceDataV1 = z.object({
  request_id: z.string().min(1).max(128),
  formal_ready: z.literal(false), rule_date: z.iso.date(), snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  candidates: z.array(z.object({
    item: NomenclatureRowSchema, hierarchy: z.array(NomenclatureRowSchema).max(7),
    rates: z.array(TariffRuleRowSchema).max(100),
  }).strict()).max(27), sources: z.array(SourceRowSchema).max(20), warnings: z.array(z.string()).max(10),
}).strict();
export const customsReferenceDataV2 = customsReferenceDataV1.extend({candidates:z.array(customsReferenceDataV1.shape.candidates.element.extend({name_translation:nameTranslationSchema.nullable()})).max(27)});
// CBSA 9914 contains a complete legal list exceeding 50,000 characters. Preserve it, not a truncated substitute.
const referenceItem=NomenclatureRowSchema.extend({description_original:z.string().max(100_000)});
export const customsReferenceDataV3 = customsReferenceDataV1.extend({candidates:z.array(z.object({item:referenceItem,hierarchy:z.array(referenceItem).max(7),rates:z.array(TariffRuleRowSchema).max(100),name_translation:nameTranslationSchema.nullable()}).strict()).max(81),search:z.object({terms:z.array(z.string().min(1).max(500)).min(1).max(7),assisted:z.boolean()}).strict().optional()});
export const customsReferenceData = customsReferenceDataV3.extend({compliance:complianceData.nullable().optional(),search:customsReferenceDataV3.shape.search.unwrap().extend({hs6_hints:z.array(z.string().regex(/^\d{6}$/u)).max(3).optional()}).optional()});
export const customsReferenceVersion = 'portal-customs-reference@2026-09-28.v4';
export const customsReferenceConfig = z.object({ snapshotFile: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u), nameTranslation:nameTranslationConfig.optional(),searchTerms:nameTranslationConfig.optional(),compliance:complianceConfig.optional() }).strict();
const officialHosts = new Set(['gss.mof.gov.cn','online.customs.gov.cn','www.cbsa-asfc.gc.ca','www.usitc.gov','hts.usitc.gov']);
function nameScore(description:string,terms:string[],screenParts=true) {
  const name=description.normalize('NFKC').toLowerCase().replace(/[-‐‑–—]/gu,' ').replace(/\b(?:other than|excluding|not including|except)\b[^;.]*|但[^；。]*除外/gu,' ').trim();
  const query=terms.join(' ');
  if(!terms.length||!terms.every(term=>name.includes(term)||!/\p{Script=Han}/u.test(term)&&term.endsWith('s')&&name.includes(term.slice(0,-1))))return 0;
  if(name===query)return 10_000;
  if(/\p{Script=Han}/u.test(query)){
    // A mention as the intended use or a prefix of another product is not a goods match.
    // ponytail: lexical screening only; common names absent from official text still need reviewed search terms.
    if(screenParts&&!/(零件|部件|组件|配件)/u.test(query)&&/(零件|部件|组件|配件)/u.test(name))return 0;
    for(const term of terms.slice(-1)){
      let position=name.indexOf(term),matched=false;
      while(position>=0){
        const rest=name.slice(position+term.length);
        if(!/^[\p{Script=Han}]/u.test(rest)||/^[及和或与、，；。()（）]/u.test(rest)){
          if(!/用(?:于|的)?/u.test(rest)&&!/(?:用于|用作|适用于)[^；。]*$/u.test(name.slice(0,position)))matched=true;
        }
        position=name.indexOf(term,position+term.length);
      }
      if(!matched)return 0;
    }
  }else{
    const words=name.match(/[\p{L}\p{N}]+/gu)??[];
    if(!terms.every(term=>words.some(word=>word===term||word===term+'s'||term===word+'s')))return 0;
    if(screenParts&&!/\b(parts?|components?|accessories)\b/u.test(query)&&/\b(parts?|components?|accessories)\b/u.test(name)&&!/(?:and|including) (?:their )?parts/iu.test(name))return 0;
    const purpose=name.indexOf(' for ');
    if(purpose>=0&&terms.every(term=>!name.slice(0,purpose).includes(term)))return 0;
  }
  return 1_000/(1+name.length);
}
function identity(path: string) {
  const s=lstatSync(path);
  if(!isAbsolute(path)||!s.isFile()||s.isSymbolicLink()||s.size>1024**3||existsSync(path+'-wal'))throw new Error('customs_reference_file_invalid');
  return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
}
function hash(path: string) {
  const fd=openSync(path,'r'), h=createHash('sha256'), b=Buffer.alloc(1024*1024);
  try { let n; while((n=readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n)); return h.digest('hex'); } finally { closeSync(fd); }
}
export function createCustomsReferenceClient(config: z.infer<typeof customsReferenceConfig>,translate?:ReturnType<typeof createCustomsNameTranslator>,suggestTerms?:ReturnType<typeof createCustomsSearchTerms>): CustomsBusinessClientPort {
  const compliance=config.compliance?loadComplianceReference(config.compliance):undefined;
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
      const terms=(text:string)=>[...new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[])];
      const originalTerms=terms(parsed.data.query);
      const nameRows=!code?db.prepare(`SELECT id,release_id,country,language,code,description_original FROM nomenclature WHERE ${eligible}`).all(...ids,ruleDate,ruleDate):[];
      const originalMatched=nameRows.some(row=>(!codeCountry||row.country===codeCountry||row.country==='CN'&&/\p{Script=Han}/u.test(parsed.data.query))&&nameScore(String(row.description_original),originalTerms)>0);
      const suggested=!code&&suggestTerms?await suggestTerms(parsed.data.query):null;
      // Translations still rank foreign subheadings; model families cannot replace a direct official name match.
      const aiHs6=originalMatched?[]:[...new Set(suggested?.hs6??[])].filter(hs6=>nameRows.some(row=>(!codeCountry||row.country===codeCountry)&&String(row.code).startsWith(hs6)));
      const byNameKey=new Map(nameRows.map(row=>[`${String(row.release_id)}:${String(row.language)}:${String(row.code)}`,row]));
      const partialScores=new Map<unknown,number>();
      const scores=new Map(nameRows.map(row=>{
        const alternatives=suggested?.terms.filter(term=>String(row.language).startsWith(term.language)).map(term=>terms(term.text))??[];
        const parents=Array.from({length:Math.max(0,String(row.code).length-4)},(_,i)=>byNameKey.get(`${String(row.release_id)}:${String(row.language)}:${String(row.code).slice(0,i+4)}`)).filter(parent=>parent&&parent.country===row.country);
        const segments=[...parents.map(parent=>String(parent!.description_original)),String(row.description_original)];
        const path=segments.join(' — ');
        // A code-prefix path supplies context without trusting malformed raw parent links.
        const scoreFor=(words:string[])=>{
          const partsQuery=/(零件|部件|组件|配件|\bparts?\b|\bcomponents?\b|\baccessories\b)/iu.test(words.join(' '));
          const partsOnly=!partsQuery&&segments.some(text=>/^[-—\s]*(?:parts?\b|components?\b|accessories\b|零件|部件|组件|配件)/iu.test(text));
          return Math.max(nameScore(String(row.description_original),words),partsOnly?0:nameScore(path,words,false)/2);
        };
        const original=scoreFor(originalTerms);
        const score=original?1_000_000+original:Math.max(0,...alternatives.map((words,index)=>{const value=scoreFor(words);return value?(alternatives.length-index)*10_000+value:0;}));
        // Partial literal words only rank already bounded HS6 candidates, never widen a name search.
        const literal=String(row.language).startsWith('en')&&/\p{Script=Han}/u.test(parsed.data.query)?alternatives[0]??[]:originalTerms;
        const words=literal.filter(word=>word.length>2&&!['the','and','for','with','other'].includes(word));
        const matched=words.filter(word=>scoreFor([word])>0).length;
        partialScores.set(row.id,!score&&matched?matched*100/Math.max(1,words.length)+1/(1+path.length):0);
        return [row.id,score] as const;
      }));
      db.function('reference_name_score',{deterministic:true},id=>scores.get(id)??0);
      db.function('reference_partial_score',{deterministic:true},id=>partialScores.get(id)??0);
      const nameSearch='reference_name_score(id)>0';
      const chineseQuery=!code&&/\p{Script=Han}/u.test(parsed.data.query);
      // Use official Chinese names as search anchors, never as a foreign classification or translation.
      const anchors=chineseQuery?db.prepare(`SELECT substr(code,1,6) AS hs6,MAX(reference_name_score(id)) AS score FROM nomenclature WHERE country='CN' AND language LIKE 'zh%' AND length(code)>=6 AND ${eligible} AND (${nameSearch}) GROUP BY hs6 ORDER BY score DESC,hs6 LIMIT 9`).all(...ids,ruleDate,ruleDate):[];
      const anchorTier=anchors.length?(Number(anchors[0]!.score)>=1_000_000?1_000_000:Math.floor(Number(anchors[0]!.score)/10_000)*10_000):0;
      const chineseHs6=anchors.filter(row=>Number(row.score)>=anchorTier).map(row=>String(row.hs6));
      let incompleteHierarchy=false;
      for(const country of ['CN','US','CA']) {
        if(!code&&!chineseQuery&&codeCountry&&codeCountry!==country)continue;
        const directions=aiHs6.length?aiHs6:country!=='CN'?chineseHs6:[];
        const crossCountry=directions.length>0;
        const search=code?(code.length>6&&codeCountry===country?'code=?':"substr(code,1,?)=?"):crossCountry?`substr(code,1,6) IN (${directions.map(()=>'?').join(',')})${aiHs6.length?'':` OR ${nameSearch}`}`:nameSearch;
        const lookup=code?(code.length>6&&codeCountry===country?[code]:[Math.min(code.length,6),code.slice(0,6)]):crossCountry?directions:[];
        const relevance=code?'0':crossCountry?`(reference_name_score(id)+reference_partial_score(id)+CASE substr(code,1,6) ${directions.map((_,i)=>`WHEN ? THEN ${10_000_000-i*10}`).join(' ')} ELSE 0 END)`:'reference_name_score(id)';
        const broadFirst=!code&&crossCountry?'CASE WHEN MAX(reference_name_score(id)+reference_partial_score(id))=0 THEN length(code) ELSE 0 END,':'';
        const selectedCodes=db.prepare(`SELECT code FROM nomenclature WHERE country=? AND ${eligible} AND (${search}) GROUP BY code ORDER BY MAX(${relevance}) DESC,${broadFirst}MAX(is_declarable) DESC,code LIMIT 9`).all(country,...ids,ruleDate,ruleDate,...lookup,...(crossCountry&&!code?directions:[])).map(row=>String(row.code));
        if(!selectedCodes.length)continue;
        // Limit codes before languages, then retain up to three source language records per code.
        const rows=selectedCodes.flatMap(selected=>db!.prepare(`SELECT * FROM nomenclature WHERE country=? AND ${eligible} AND code=? ORDER BY language,release_id LIMIT 3`).all(country,...ids,ruleDate,ruleDate,selected));
        for(const row of rows){
          const item=referenceItem.parse(normalize(row));
          const prefixes=Array.from({length:Math.max(0,item.code.length-4)},(_,i)=>item.code.slice(0,i+4));
          const hierarchy:z.infer<typeof referenceItem>[]=[];
          for(const prefix of prefixes){
            const parents=db.prepare(`SELECT * FROM nomenclature WHERE country=? AND ${eligible} AND code=? AND language=?`).all(country,...ids,ruleDate,ruleDate,prefix,item.language).map(r=>referenceItem.parse(normalize(r)));
            const sameRelease=parents.filter(p=>p.release_id===item.release_id);
            // GACC's ten-digit table explicitly points to the same-year MOF eight-digit tariff item.
            const compatible=sameRelease.length?sameRelease:parents.filter(p=>item.country==='CN'&&item.release_authority==='GACC'&&p.release_authority==='MOF'&&p.release_dataset==='customs_tariff_8_digit'&&p.release_edition===item.release_edition&&p.code.length===8&&p.code===item.parent_code);
            if(compatible.length===1)hierarchy.push(compatible[0]!);
          }
          if(item.parent_code&&!hierarchy.some(p=>p.code===item.parent_code))incompleteHierarchy=true;
          const ancestorCodes=[item.code,...hierarchy.map(p=>p.code)],params:SQLInputValue[]=[country,...ids,ruleDate,ruleDate,...ancestorCodes,item.code];
          const rawRates=db.prepare(`SELECT * FROM tariff_rule WHERE country=? AND ${eligible} AND (code IN (${ancestorCodes.map(()=>'?').join(',')}) OR (code_match_type='prefix' AND substr(?,1,length(code))=code)) ORDER BY code,treatment,id LIMIT 100`).all(...params);
          candidates.push({item,hierarchy,rates:rawRates.map(row=>TariffRuleRowSchema.parse(normalize(row))),name_translation:null});
        }
      }
      if(identity(config.snapshotFile)!==expectedIdentity)return fail('customs_reference_changed');
      db.close();db=undefined;
      // Translate the selected source language once; the Canadian French original remains available in evidence.
      const toTranslate=candidates.filter(candidate=>!candidate.item.language.startsWith('fr')||!candidates.some(other=>other.item.country===candidate.item.country&&other.item.code===candidate.item.code&&other.item.language.startsWith('en')));
      if(translate){const translations=await translate(toTranslate.map(({item,hierarchy})=>({language:item.language,text:[...new Set([...hierarchy.map(parent=>parent.description_original),item.description_original].filter(Boolean))].join(' — ')})));toTranslate.forEach((candidate,index)=>{candidate.name_translation=translations[index]??null;});}
      if(identity(config.snapshotFile)!==expectedIdentity)return fail('customs_reference_changed');
      const data=customsReferenceData.parse({request_id:request.requestId,formal_ready:false,rule_date:ruleDate,snapshot_sha256:config.sha256,candidates,sources,compliance:compliance?.(candidates.map(c=>c.item),ruleDate)??null,search:{terms:[...new Set([parsed.data.query,...(suggested?.terms.map(term=>term.text)??[])])],assisted:Boolean(suggested?.terms.length||aiHs6.length),...(aiHs6.length?{hs6_hints:aiHs6}:{})},warnings:[
        '官方原文参考与候选归类；来源资料尚未完成正式发布审核，不是正式归类或应缴税费。',
        '税率按所属税目原文展示；父级规则、优惠待遇、原产地及商品条件仍须核对。',
        '附加税、贸易救济、排除条款、许可证、汇率和总税费尚待核验；未展示不代表不适用或税率为零。',
        '各地区最多展示 9 个不同税号，每个税号保留最多 3 个语言版本；请用更完整税号或法律品名缩小范围，其他地区同 HS 前缀仅供对照。',
        ...(chineseQuery&&!aiHs6.length?['中文品名匹配中国官方税目，再以 HS6 检索各地区候选；跨地区同前缀不代表归类相同，须核对目的国细分品名与商品条件。']:[]),
        ...(incompleteHierarchy?['来源层级不完整或包含无效父级；仅展示当前日期有效的同国前缀税目，不引用无关父级税率。']:[]),
        ...(suggested?.terms.length||aiHs6.length?['机器建议检索词及 HS6 方向只用于查找官方原文，可能不完整或偏离商品；请核对已展示的建议与候选，不作为归类依据。']:!code&&!originalMatched&&suggestTerms?['品名检索词建议暂不可用或未能识别商品，已保留原始关键词检索。']:[]),
      ]});
      return {schema_version:customsReferenceVersion,status:'manual_review',data,reason_codes:['customs_reference_only']};
    } catch { return fail('customs_reference_invalid'); } finally { db?.close(); }
  })};
}
