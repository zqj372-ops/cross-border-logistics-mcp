import {createHash} from 'node:crypto';
import type {PublicationSnapshotRow,SourceRow} from './upstream/worker/repositories/customs';
import {z} from 'zod';
const strings=z.array(z.string().min(1)).min(1).max(100);
const timestamp=z.string().datetime({offset:true});
/** The package must pass the same identity checks as the query publication gate. */
export function checkPackagePublication(snapshot:PublicationSnapshotRow|null,sources:readonly SourceRow[]):string[]{
 const errors:string[]=[];
 if(!snapshot||snapshot.ready!==1||snapshot.test_data!==0)return ['来源尚无非测试的就绪发布快照。'];
 const parse=(value:string)=>{try{return strings.safeParse(JSON.parse(value));}catch{return strings.safeParse(null);}};
 const ids=parse(snapshot.release_ids_json),approvals=parse(snapshot.approval_ids_json);
 if(!ids.success||new Set(ids.data).size!==ids.data.length)errors.push('快照来源编号为空、重复或格式错误。');
 if(!approvals.success||new Set(approvals.data).size!==approvals.data.length||!ids.success||approvals.data.length!==ids.data.length)errors.push('每个来源必须绑定独立的审核引用。');
 if(ids.success){
  const rows=ids.data.map(id=>sources.find(s=>s.id===id&&s.status==='published'));
  if(rows.some(s=>!s||!/^[a-f0-9]{64}$/iu.test(s.manifest_sha256)))errors.push('快照引用的来源版本尚未发布或缺少有效哈希。');
  else if(approvals.success){const hash=createHash('sha256').update([...rows.map(s=>`${s!.id}:${s!.manifest_sha256.toLowerCase()}`),...approvals.data].sort().join('|')).digest('hex');if(hash!==snapshot.gate_report_sha256?.toLowerCase())errors.push('发布哈希与来源版本和审核引用不一致。');}
 }
 try{const reasons:unknown=JSON.parse(snapshot.reasons_json);if(!Array.isArray(reasons)||reasons.length!==0)errors.push('来源发布门禁仍有未解决项。');}catch{errors.push('来源发布门禁记录无效。');}
 const validTime=(value:unknown)=>timestamp.safeParse(value).success&&typeof value==='string'&&new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)===value.slice(0,10);
 if(!validTime(snapshot.evaluated_at)||snapshot.last_source_check_at!==null&&!validTime(snapshot.last_source_check_at))errors.push('发布或来源检查时间无效。');
 return errors;
}
