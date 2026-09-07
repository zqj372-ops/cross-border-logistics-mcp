import type { CustomsDataset } from './contracts';
import { QueryRequestSchema, type QueryResponse } from './upstream/shared/contracts/query';
import { QueryService, publicationStatus, type CustomsRepositoryLike } from './upstream/worker/query/query-service';
import type { CandidateAssistant } from './upstream/worker/ai/adapter';
import { selectNextApprovedQuestion } from './upstream/worker/query/question-policy';
import type { NomenclatureRow, TariffRuleRow, TradeMeasureRow, RequirementRow, SourceRow, PublicationSnapshotRow } from './upstream/worker/repositories/customs';
export interface NativeCustomsRelease {
 readonly release_id:string;
 readonly repository?:CustomsRepositoryLike;
 readonly exchange_rates?:NonNullable<CustomsDataset['exchange_rates']>;
 readonly nomenclature:readonly NomenclatureRow[];
 readonly tariffs:readonly TariffRuleRow[];
 readonly measures:readonly TradeMeasureRow[];
 readonly requirements:readonly RequirementRow[];
 readonly sources:readonly SourceRow[];
 readonly snapshot:PublicationSnapshotRow;
}
export interface NativeReleaseReader{current(ruleDate:string):NativeCustomsRelease|null}
const assistant:CandidateAssistant={
 rankCandidateIds:input=>Promise.resolve(input.candidates.map(c=>c.id)),
 chooseQuestion:input=>Promise.resolve(selectNextApprovedQuestion({answeredAttributes:input.answeredAttributes,...(input.approvedQuestionIds[0]?{preferredId:input.approvedQuestionIds[0]}:{})})?.id??null),
};
const active=(from:string,to:string|null,date:string)=>from<=date&&(to===null||to>=date);
export function releaseRepository(release:NativeCustomsRelease):CustomsRepositoryLike{
 const sources=new Map(release.sources.map(s=>[s.id,s]));
 const eligible=(row:NomenclatureRow|TariffRuleRow|TradeMeasureRow|RequirementRow,date:string)=>{const source=sources.get(row.release_id);return source?.status==='published'&&row.release_status==='published'&&active(row.effective_from,row.effective_to,date)&&active(source.effective_from,source.effective_to,date);};
 return {
 testData:release.snapshot.test_data!==0,
 findExactCode:(country,code,date)=>Promise.resolve(release.nomenclature.filter(r=>r.country===country&&r.code===code&&eligible(r,date))),
 searchNames:(terms,date,limit)=>{const words=terms.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);return Promise.resolve(release.nomenclature.filter(r=>eligible(r,date)&&words.some(w=>`${r.code} ${r.description_original}`.normalize('NFKC').toLowerCase().includes(w))).slice(0,limit));},
 findByHs6:(hs6,country,date)=>Promise.resolve(release.nomenclature.filter(r=>r.country===country&&r.concept_code===hs6&&r.mapping_status!==undefined&&eligible(r,date))),
 findHierarchy:(id,date)=>{const row=release.nomenclature.find(r=>r.id===id);if(!row)return Promise.resolve([]);const parents:NomenclatureRow[]=[row];let code=row.parent_code;const seen=new Set<string>();while(code&&!seen.has(code)&&parents.length<7){seen.add(code);const parent=release.nomenclature.find(r=>r.country===row.country&&r.release_id===row.release_id&&r.code===code&&eligible(r,date));if(!parent)break;parents.unshift(parent);code=parent.parent_code;}return Promise.resolve(parents);},
 findTariffRules:(country,code,date)=>Promise.resolve(release.tariffs.filter(r=>r.country===country&&eligible(r,date)&&r.code===code)),
 findTradeMeasures:(country,code,date)=>Promise.resolve(release.measures.filter(r=>r.country===country&&eligible(r,date)&&r.code_hint===code)),
 findRequirements:(country,date)=>Promise.resolve(release.requirements.filter(r=>r.country===country&&eligible(r,date))),
 findSources:ids=>Promise.resolve(release.sources.filter(r=>ids.includes(r.id))),
 findPublicationSnapshot:date=>Promise.resolve(release.snapshot.rule_date<=date?release.snapshot:null),
 };
}
export class NativeCustomsEngine{
 constructor(private releases:NativeReleaseReader){}
 async query(input:unknown):Promise<{schema_version:string;status:'needs_input'|'unavailable'|'manual_review'|'success';data:QueryResponse|null;reason_codes:string[]}>{
  const fail=(status:'needs_input'|'unavailable'|'manual_review',code:string)=>({schema_version:'portal-customs-native@2026-09-07.v1',status,data:null,reason_codes:[code]});
  const parsed=QueryRequestSchema.safeParse(input);if(!parsed.success)return fail('needs_input','customs_request_invalid');
  const release=this.releases.current(parsed.data.ruleDate);if(!release)return fail('unavailable','native_customs_not_published');
  const repository=release.repository??releaseRepository(release);const before=await publicationStatus(release.snapshot,release.sources.map(s=>s.id),[...release.sources]);
  if(!before.dataStatus.ready||before.testData)return fail('unavailable','native_customs_release_not_ready');
  try{const data=await new QueryService(repository,assistant).query(parsed.data);if(this.releases.current(parsed.data.ruleDate)?.release_id!==release.release_id)return fail('unavailable','native_customs_release_changed');if(!data.dataStatus.ready||data.testData)return fail('unavailable','native_customs_release_not_ready');return {schema_version:'portal-customs-native@2026-09-07.v1',status:data.nextQuestion?'needs_input':data.results.length===0||data.results.some(r=>r.status!=='confirmed')||data.candidates.some(r=>r.status==='manual_review')?'manual_review':'success',data,reason_codes:data.nextQuestion?['customs_clarification_required']:[]};}catch{return fail('manual_review','native_customs_query_requires_review');}
 }
}
