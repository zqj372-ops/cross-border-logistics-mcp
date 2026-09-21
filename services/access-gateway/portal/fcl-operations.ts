import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PortalError,type PortalContext} from './contracts';
import type {NativeAdminStore,FclRateAdminView} from './native-admin';
import {nativeDataSchema} from './native-admin-contracts';
import {fclRateDatasetSchema,type FclRatePublication} from '../../quote-native/fcl-contracts';
import {calculateFclEstimate,refreshFclEstimateTotals} from '../../quote-native/fcl-operations';
import {
  FCL_OPERATIONS_VERSION,FCL_RATE_DATASET_V2,fclEstimateRequestSchema,fclEstimateGetSchema,fclEstimateListRequestSchema,
  fclEstimateActionSchema,fclEstimateAdjustSchema,fclEstimateSnapshotSchema,fclEstimateViewSchema,
  fclBulkPreviewRequestSchema,fclBulkPublishRequestSchema,fclBulkPreviewSchema,
  type FclEstimateRequest,type FclEstimateSnapshot,type FclEstimateView,
} from '../../quote-native/fcl-operations-contracts';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse=<T>(schema:z.ZodType<T>,input:unknown):T=>{const r=schema.safeParse(input);if(!r.success)throw new PortalError('fcl_operations_input_invalid');return r.data;};
const revisionsSchema=z.array(z.object({estimate_id:z.string().uuid(),version:z.number().int().positive()}).strict());
type Dependencies={store:NativeAdminStore;authorize:(ctx:PortalContext)=>{scope:string;now:()=>string};getRates:(ctx:PortalContext)=>FclRateAdminView};

/** Typed FCL operations over the existing native business store. No public generic store access. */
export class FclOperationsService {
  constructor(private readonly deps:Dependencies){}
  private records(scope:string):FclEstimateSnapshot[]{
    return (this.deps.store.db.prepare("SELECT draft FROM native_configs WHERE scope=? AND kind LIKE 'fcl-estimate:%' ORDER BY rowid DESC LIMIT 501").all(scope) as {draft:string}[]).map(row=>this.decode(row.draft));
  }
  private decode(value:string):FclEstimateSnapshot{
    try{const parsed=fclEstimateSnapshotSchema.parse(JSON.parse(value));const {content_digest,...body}=parsed;if(hash(body)!==content_digest)throw new Error();return parsed;}catch{throw new PortalError('fcl_estimate_readback_failed');}
  }
  private current(scope:string,id:string):FclEstimateSnapshot{
    const row=this.deps.store.db.prepare('SELECT draft FROM native_configs WHERE scope=? AND kind=?').get(scope,`fcl-estimate:${id}`) as {draft:string}|undefined;
    if(!row)throw new PortalError('fcl_estimate_not_found');return this.decode(row.draft);
  }
  private release(ctx:PortalContext):FclRatePublication {const r=this.deps.getRates(ctx).active_release;if(!r||r.input.contract_version!==FCL_RATE_DATASET_V2)throw new PortalError('fcl_operations_not_configured');return r;}
  private view(ctx:PortalContext,snapshot:FclEstimateSnapshot):FclEstimateView{
    const owner=this.deps.authorize(ctx),current=this.current(owner.scope,snapshot.estimate_id);const reasons:string[]=[];
    if(snapshot.version!==current.version)reasons.push('fcl_estimate_historical');
    try{const release=this.release(ctx);const recalculated=calculateFclEstimate(release.input,snapshot.request,snapshot.calculation.rate_id,snapshot.calculation.template_id);if(hash(recalculated)!==snapshot.dependency_digest)reasons.push('fcl_estimate_source_changed');}catch{reasons.push('fcl_estimate_source_unavailable');}
    if(snapshot.calculation.valid_until<owner.now().slice(0,10))reasons.push('fcl_estimate_expired');
    if(snapshot.calculation.blockers.length)reasons.push('fcl_estimate_incomplete');
    return fclEstimateViewSchema.parse({...snapshot,historical:snapshot.version!==current.version,current_version:current.version,currentness:{valid_now:reasons.length===0,reason_codes:reasons}});
  }
  list(ctx:PortalContext,input:unknown){
    const owner=this.deps.authorize(ctx),request=parse(fclEstimateListRequestSchema,input);
    const records=this.records(owner.scope);if(records.length>500)throw new PortalError('fcl_estimate_limit');
    return {items:records.filter(r=>(request.case_ref===null||r.request.case_ref===request.case_ref)&&(request.destination===null||r.calculation.destination===request.destination)&&(request.shipping_date===null||r.request.shipping_date===request.shipping_date)).map(r=>this.view(ctx,r))};
  }
  get(ctx:PortalContext,input:unknown){
    const owner=this.deps.authorize(ctx),request=parse(fclEstimateGetSchema,input),current=this.current(owner.scope,request.estimate_id);
    if(request.version===null||request.version===current.version)return this.view(ctx,current);
    const row=this.deps.store.db.prepare("SELECT payload FROM native_releases WHERE scope=? AND kind='fcl-estimate' AND json_extract(payload,'$.estimate_id')=? AND json_extract(payload,'$.version')=?").get(owner.scope,request.estimate_id,request.version) as {payload:string}|undefined;
    if(!row)throw new PortalError('fcl_estimate_not_found');return this.view(ctx,this.decode(row.payload));
  }
  private append(ctx:PortalContext,body:Omit<FclEstimateSnapshot,'revision_id'|'content_digest'|'actor'|'created_at'>):FclEstimateSnapshot {
    const owner=this.deps.authorize(ctx);if(body.version>1000)throw new PortalError('fcl_estimate_version_limit');
    const snapshot=fclEstimateSnapshotSchema.parse({...body,revision_id:randomUUID(),actor:ctx.identity.userId,created_at:owner.now(),content_digest:'0'.repeat(64)});
    const {content_digest,...payload}=snapshot;void content_digest;snapshot.content_digest=hash(payload);
    const db=this.deps.store.db,serialized=JSON.stringify(snapshot);
    db.prepare('INSERT INTO native_releases VALUES(?,?,?,?)').run(snapshot.revision_id,owner.scope,'fcl-estimate',serialized);
    db.prepare('INSERT INTO native_configs VALUES(?,?,?,?,?) ON CONFLICT(scope,kind) DO UPDATE SET version=excluded.version,draft=excluded.draft,active=excluded.active').run(owner.scope,`fcl-estimate:${snapshot.estimate_id}`,snapshot.version,serialized,snapshot.revision_id);
    const readback=this.current(owner.scope,snapshot.estimate_id);
    const history=db.prepare('SELECT payload FROM native_releases WHERE id=? AND scope=? AND kind=?').get(snapshot.revision_id,owner.scope,'fcl-estimate') as {payload:string}|undefined;
    if(JSON.stringify(readback)!==serialized||history?.payload!==serialized)throw new PortalError('fcl_estimate_readback_failed');return readback;
  }
  private write<T>(ctx:PortalContext,action:string,input:unknown,key:string,schema:z.ZodType<T>,operation:()=>T):T{
    const owner=this.deps.authorize(ctx);if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    const db=this.deps.store.db,partition=JSON.stringify([owner.scope,ctx.identity.userId,'fcl-operations',action]),digest=hash(input);
    db.exec('BEGIN IMMEDIATE');let committed=false;
    try{
      const existing=db.prepare('SELECT digest,result FROM native_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
      if(existing){if(existing.digest!==digest)throw new PortalError('idempotency_conflict');const result=schema.parse(JSON.parse(existing.result));db.exec('COMMIT');committed=true;return result;}
      const result=schema.parse(operation());
      db.prepare('INSERT INTO native_audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(),owner.scope,'fcl-operations',ctx.identity.userId,action,digest,owner.now());
      db.prepare('INSERT INTO native_idempotency VALUES(?,?,?,?)').run(partition,key,digest,JSON.stringify(result));
      db.exec('COMMIT');committed=true;return result;
    }finally{if(!committed)db.exec('ROLLBACK');}
  }
  private calculate(ctx:PortalContext,release:FclRatePublication,request:FclEstimateRequest,rateId:string,templateId:string,previous?:FclEstimateSnapshot){
    let calculation=calculateFclEstimate(release.input,request,rateId,templateId);const dependencyDigest=hash(calculation);
    const adjustments=previous?.adjustments??[];
    for(const adjustment of adjustments){const line=calculation.lines.find(l=>l.id===adjustment.line_id);if(line?.editable)line.sell_price=adjustment.adjusted_amount;else calculation.blockers.push(`adjustment_source_changed:${adjustment.line_id}`);}
    if(adjustments.length)calculation=refreshFclEstimateTotals(calculation);
    return this.append(ctx,{contract_version:FCL_OPERATIONS_VERSION,estimate_id:previous?.estimate_id??randomUUID(),version:(previous?.version??0)+1,request,calculation,source_release_id:release.release_id,source_digest:release.digest,dependency_digest:dependencyDigest,locked:previous?.locked??false,recommended:previous?.recommended??false,adjustments,copied_from:previous?.copied_from??null});
  }
  private generate(ctx:PortalContext,request:FclEstimateRequest,release:FclRatePublication):string[]{
    const owner=this.deps.authorize(ctx);
    if(release.input.contract_version!==FCL_RATE_DATASET_V2)throw new PortalError('fcl_operations_not_configured');
      const rates=release.input.rates.filter(r=>r.pol===request.pol&&(!request.rate_ids.length||request.rate_ids.includes(r.rate_id)));
      const templates=[...new Set(release.input.operations.templates.filter(t=>t.enabled&&(!request.template_ids.length||request.template_ids.includes(t.id))).map(t=>t.id))];
      const previous=this.records(owner.scope);const ids:string[]=[];let added=0;
      for(const rate of rates)for(const templateId of templates){
        const template=release.input.operations.templates.find(t=>t.id===templateId)!;if(template.pod!==rate.pod)continue;
        const exact={...request,rate_ids:[rate.rate_id],template_ids:[templateId]};
        const old=previous.find(r=>r.copied_from===null&&hash(r.request)===hash(exact));
        if(old&&(old.locked||hash(calculateFclEstimate(release.input,exact,rate.rate_id,templateId))===old.dependency_digest)){ids.push(old.estimate_id);continue;}
        if((!old&&previous.length+added>=500)||ids.length>=100)throw new PortalError('fcl_estimate_limit');
        ids.push(this.calculate(ctx,release,exact,rate.rate_id,templateId,old).estimate_id);if(!old)added++;
      }
      if(!ids.length)throw new PortalError('fcl_estimate_no_candidates');return ids;
  }
  run(ctx:PortalContext,input:unknown,key:string){
    const request=parse(fclEstimateRequestSchema,input);
    const owner=this.deps.authorize(ctx);
    const revisions=this.write(ctx,'estimate-run',request,key,revisionsSchema,()=>this.generate(ctx,request,this.release(ctx)).map(estimate_id=>({estimate_id,version:this.current(owner.scope,estimate_id).version})));
    return {items:revisions.map(ref=>this.get(ctx,ref))};
  }
  duplicate(ctx:PortalContext,input:unknown,key:string){
    const request=parse(fclEstimateActionSchema,input),owner=this.deps.authorize(ctx);
    const revisions=this.write(ctx,'estimate-duplicate',request,key,revisionsSchema,()=>{
      const old=this.current(owner.scope,request.estimate_id);if(old.version!==request.expected_version)throw new PortalError('version_conflict');
      if(this.records(owner.scope).length>=500)throw new PortalError('fcl_estimate_limit');
      const copy=this.append(ctx,{...old,estimate_id:randomUUID(),version:1,locked:false,recommended:false,copied_from:{estimate_id:old.estimate_id,version:old.version}});return [{estimate_id:copy.estimate_id,version:copy.version}];
    });return this.get(ctx,revisions[0]);
  }
  adjust(ctx:PortalContext,input:unknown,key:string){
    const request=parse(fclEstimateAdjustSchema,input),owner=this.deps.authorize(ctx);
    const revisions=this.write(ctx,'estimate-adjust',request,key,revisionsSchema,()=>{
      const old=this.current(owner.scope,request.estimate_id);if(old.version!==request.expected_version)throw new PortalError('version_conflict');
      if(old.locked&&request.changes.length)throw new PortalError('fcl_estimate_locked');
      const calculation=structuredClone(old.calculation),adjustments=[...old.adjustments];const seen=new Set<string>();
      for(const change of request.changes){const line=calculation.lines.find(l=>l.id===change.line_id);if(!line?.editable||seen.has(change.line_id))throw new PortalError('fcl_estimate_adjustment_invalid');seen.add(change.line_id);adjustments.push({line_id:line.id,original_amount:line.sell_price,adjusted_amount:change.sell_price,reason:request.reason,actor:ctx.identity.userId,modified_at:owner.now()});line.sell_price=change.sell_price;}
      const updated=this.append(ctx,{...old,version:old.version+1,locked:request.locked,recommended:request.recommended,calculation:refreshFclEstimateTotals(calculation),adjustments});return [{estimate_id:updated.estimate_id,version:updated.version}];
    });return this.get(ctx,revisions[0]);
  }
  /** Called inside the existing source-publication transaction; all versions commit together. */
  reprice(ctx:PortalContext,release:FclRatePublication):void {
    if(release.input.contract_version!==FCL_RATE_DATASET_V2)return;
    const owner=this.deps.authorize(ctx);
    for(const old of this.records(owner.scope)){
      if(old.locked)continue;
      let calculation;try{calculation=calculateFclEstimate(release.input,old.request,old.calculation.rate_id,old.calculation.template_id);}catch(error){if(error instanceof PortalError&&error.code==='fcl_estimate_source_not_found')continue;throw error;}
      if(hash(calculation)!==old.dependency_digest)this.calculate(ctx,release,old.request,old.calculation.rate_id,old.calculation.template_id,old);
    }
  }
  private batch(ctx:PortalContext,input:unknown){
    const request=parse(fclBulkPreviewRequestSchema,input),owner=this.deps.authorize(ctx),view=this.deps.getRates(ctx),active=this.release(ctx);
    if(view.version!==request.expected_version)throw new PortalError('version_conflict');
    if(view.draft&&hash(view.draft)!==active.digest)throw new PortalError('fcl_rate_unsaved_publication');
    const candidate=structuredClone(active.input);const seen=new Set<string>();const windows=new Map<string,string>();
    const changes=request.changes.map(change=>{
      const rate=candidate.rates.find(r=>r.rate_id===change.rate_id),item=rate?.items.find(i=>i.container_type===change.container_type),identity=`${change.rate_id}:${change.container_type}`;
      if(!rate||!item||seen.has(identity))throw new PortalError('fcl_bulk_rate_input_invalid');seen.add(identity);
      const window=JSON.stringify([change.valid_from,change.valid_until,change.source_ref,change.source_version]);if(windows.has(change.rate_id)&&windows.get(change.rate_id)!==window)throw new PortalError('fcl_bulk_rate_window_conflict');windows.set(change.rate_id,window);
      const original=item.ocean_freight;item.ocean_freight=change.ocean_freight;rate.valid_from=change.valid_from;rate.valid_until=change.valid_until;rate.source_ref=change.source_ref;rate.source_version=change.source_version;
      return {rate_id:change.rate_id,container_type:change.container_type,original_amount:original,adjusted_amount:change.ocean_freight,currency:item.currency};
    });
    const validated=fclRateDatasetSchema.safeParse(candidate);if(!validated.success)throw new PortalError('fcl_bulk_rate_input_invalid');
    const affected=this.records(owner.scope).filter(r=>request.changes.some(c=>c.rate_id===r.calculation.rate_id));
    let newEstimates=0;
    if(request.estimate_request&&candidate.contract_version===FCL_RATE_DATASET_V2){
      const q=request.estimate_request,existing=this.records(owner.scope),templateIds=[...new Set(candidate.operations.templates.filter(t=>t.enabled&&(!q.template_ids.length||q.template_ids.includes(t.id))).map(t=>t.id))];
      for(const rate of candidate.rates.filter(r=>r.pol===q.pol&&(!q.rate_ids.length||q.rate_ids.includes(r.rate_id))))for(const templateId of templateIds){
        if(!candidate.operations.templates.some(t=>t.id===templateId&&t.pod===rate.pod))continue;
        const exact={...q,rate_ids:[rate.rate_id],template_ids:[templateId]};if(!existing.some(e=>e.copied_from===null&&hash(e.request)===hash(exact)))newEstimates++;
      }
      if(newEstimates+existing.length>500||newEstimates>100)throw new PortalError('fcl_estimate_limit');
    }
    return {request,candidate:validated.data,preview:fclBulkPreviewSchema.parse({preview_hash:hash({request,source:active.release_id,candidate,affected:affected.map(r=>[r.estimate_id,r.version])}),expected_version:view.version,changes,new_estimates:newEstimates,affected_estimates:affected.filter(r=>!r.locked).length,locked_estimates:affected.filter(r=>r.locked).length})};
  }
  bulkPreview(ctx:PortalContext,input:unknown){this.deps.authorize(ctx);return this.batch(ctx,input).preview;}
  bulkPublish(ctx:PortalContext,input:unknown,key:string){
    const request=parse(fclBulkPublishRequestSchema,input),owner=this.deps.authorize(ctx);
    return this.write(ctx,'rate-bulk-publish',request,key,nativeDataSchema('fcl') as z.ZodType<FclRateAdminView>,()=>{
      const {preview_hash,confirmation,...proposal}=request;void preview_hash;void confirmation;const batch=this.batch(ctx,proposal);
      if(batch.preview.preview_hash!==request.preview_hash)throw new PortalError('native_preview_mismatch');
      const release:FclRatePublication={release_id:randomUUID(),version:request.expected_version+1,input:batch.candidate,published_at:owner.now(),digest:hash(batch.candidate)};
      const db=this.deps.store.db;db.prepare('INSERT INTO native_releases VALUES(?,?,?,?)').run(release.release_id,owner.scope,'fcl',JSON.stringify(release));
      db.prepare("UPDATE native_configs SET version=?,draft=?,active=? WHERE scope=? AND kind='fcl'").run(release.version,JSON.stringify(release.input),release.release_id,owner.scope);
      this.reprice(ctx,release);
      if(request.estimate_request)this.generate(ctx,request.estimate_request,release);
      const readback=this.deps.getRates(ctx);if(readback.active_release?.digest!==release.digest||readback.version!==release.version||readback.active_release?.release_id!==release.release_id)throw new PortalError('native_readback_failed');return readback;
    });
  }
}
