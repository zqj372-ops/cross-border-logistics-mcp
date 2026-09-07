import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { PortalError, type PortalContext } from './contracts';
import type { PortalService } from './service';
import { openPortalProductionDatabase, securePortalDatabaseFiles } from './production-persistence';
import { channelInput, channelSave, channelPublish, channelDisable, channelRollback, channelViewSchema, type ChannelInput, type ChannelView } from './channel-contracts';
const parse=<T>(schema:z.ZodType<T>,input:unknown):T=>{const value=schema.safeParse(input);if(!value.success)throw new PortalError('channel_input_invalid');return value.data;};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Scope={partition:string;actor:string;manager:boolean};
type Row={id:string;scope:string;payload:string;version:number;active:string|null;updated:string};
export class ChannelStore{
 readonly db:DatabaseSync;
 constructor(readonly path:string){this.db=openPortalProductionDatabase(path,'freightclaw-business-channels');const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;if(version>1){this.db.close();throw new Error('channels_schema_incompatible');}
 this.db.exec(`CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,scope TEXT NOT NULL,code TEXT NOT NULL,payload TEXT NOT NULL,version INTEGER NOT NULL,active TEXT,updated TEXT NOT NULL,UNIQUE(scope,code));
 CREATE TABLE IF NOT EXISTS channel_releases(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,scope TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS channel_audit(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,scope TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,version INTEGER NOT NULL,digest TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS channel_idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key));PRAGMA user_version=1;`);securePortalDatabaseFiles(path);}
 close(){this.db.close();securePortalDatabaseFiles(this.path);}
}
export class ChannelService{
 constructor(private store:ChannelStore,private portal:Pick<PortalService,'getState'>,private today=()=>new Date().toISOString().slice(0,10)){}
 private scope(ctx:PortalContext):Scope{
  if(!ctx.identity.emailVerified)throw new PortalError('authentication_required');
  const state=this.portal.getState(ctx).data;if(!state)throw new PortalError('channels_unavailable');
  if(ctx.organizationId===null){if(ctx.identity.platformRole!=='operator')throw new PortalError('channel_management_denied');return {partition:'platform',actor:ctx.identity.userId,manager:true};}
  const member=state.memberships.find(m=>m.userId===ctx.identity.userId&&m.organizationId===ctx.organizationId&&m.status==='active');
  if(!member||state.current_organization?.status!=='active')throw new PortalError('channel_management_denied');
  return {partition:`org:${ctx.organizationId}`,actor:ctx.identity.userId,manager:['owner','admin'].includes(member.role)};
 }
 private row(scope:Scope,id:string){const row=this.store.db.prepare('SELECT * FROM channels WHERE id=? AND scope=?').get(id,scope.partition) as Row|undefined;if(!row)throw new PortalError('channel_not_found');return row;}
 private view(row:Row):ChannelView{return channelViewSchema.parse({channel_id:row.id,version:row.version,input:JSON.parse(row.payload) as unknown,active_release:row.active?JSON.parse((this.store.db.prepare('SELECT payload FROM channel_releases WHERE id=? AND channel_id=? AND scope=?').get(row.active,row.id,row.scope) as {payload:string}).payload) as unknown:null,updated_at:row.updated,ready_for_quotes:false});}
 list(ctx:PortalContext){const s=this.scope(ctx);return {items:(this.store.db.prepare('SELECT * FROM channels WHERE scope=? ORDER BY updated DESC,id LIMIT 200').all(s.partition) as Row[]).map(r=>this.view(r)),can_manage:s.manager,scope:s.partition};}
 get(ctx:PortalContext,id:string){return this.view(this.row(this.scope(ctx),id));}
 history(ctx:PortalContext,id:string){const s=this.scope(ctx);this.row(s,id);return {releases:this.store.db.prepare('SELECT payload FROM channel_releases WHERE channel_id=? AND scope=? ORDER BY rowid DESC LIMIT 200').all(id,s.partition).map(r=>JSON.parse(r.payload as string) as NonNullable<ChannelView['active_release']>),audit:this.store.db.prepare('SELECT action,version,digest,created FROM channel_audit WHERE channel_id=? AND scope=? ORDER BY rowid DESC LIMIT 200').all(id,s.partition)};}
 private mutate(ctx:PortalContext,id:string|null,action:string,key:string,input:unknown,write:(scope:Scope)=>string){
  const s=this.scope(ctx);if(!s.manager)throw new PortalError('channel_management_denied');if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
  const db=this.store.db,partition=JSON.stringify([s.partition,s.actor,action,id]),digest=hash(input);db.exec('BEGIN IMMEDIATE');
  try{if(id)this.row(s,id);const prior=db.prepare('SELECT digest,result FROM channel_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
   if(prior){if(prior.digest!==digest)throw new PortalError('idempotency_conflict');db.exec('COMMIT');return JSON.parse(prior.result) as ChannelView;}
   const target=write(s),row=this.row(s,target),result=this.view(row);db.prepare('INSERT INTO channel_audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),target,s.partition,s.actor,action,row.version,digest,row.updated);db.prepare('INSERT INTO channel_idempotency VALUES(?,?,?,?)').run(partition,key,digest,JSON.stringify(result));db.exec('COMMIT');return this.view(this.row(s,target));
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 private version(row:Row,expected:number){if(row.version!==expected)throw new PortalError('version_conflict');if(row.version>=1000)throw new PortalError('channel_version_limit');}
 create(ctx:PortalContext,input:unknown,key:string){const data=parse(channelInput,input);return this.mutate(ctx,null,'create',key,data,s=>{const n=this.store.db.prepare('SELECT COUNT(*) AS n FROM channels WHERE scope=?').get(s.partition) as {n:number};if(n.n>=200)throw new PortalError('channel_limit');if(this.store.db.prepare('SELECT id FROM channels WHERE scope=? AND code=?').get(s.partition,data.code))throw new PortalError('channel_code_exists');const id=randomUUID();this.store.db.prepare('INSERT INTO channels VALUES(?,?,?,?,?,?,?)').run(id,s.partition,data.code,JSON.stringify(data),1,null,new Date().toISOString());return id;});}
 save(ctx:PortalContext,id:string,input:unknown,key:string){const data=parse(channelSave,input);return this.mutate(ctx,id,'save',key,data,s=>{const row=this.row(s,id);this.version(row,data.expected_version);if((JSON.parse(row.payload) as ChannelInput).code!==data.input.code)throw new PortalError('channel_code_immutable');this.store.db.prepare('UPDATE channels SET payload=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(data.input),new Date().toISOString(),id);return id;});}
 preview(ctx:PortalContext,id:string,releaseId?:string){const s=this.scope(ctx),row=this.row(s,id);let data=JSON.parse(row.payload) as ChannelInput;if(releaseId){const release=this.store.db.prepare('SELECT payload FROM channel_releases WHERE id=? AND channel_id=? AND scope=?').get(releaseId,id,s.partition) as {payload:string}|undefined;if(!release)throw new PortalError('channel_release_not_found');data=(JSON.parse(release.payload) as NonNullable<ChannelView['active_release']>).input;}
  if(data.valid_until<this.today())throw new PortalError('channel_expired');return {channel_id:id,version:row.version,input:data,preview_hash:hash([s.partition,id,row.version,data,releaseId??null]),release_id:releaseId??null,ready_for_quotes:false as const,warnings:['渠道信息不包含运价、分区或计费规则，不能单独用于报价。']};}
 publish(ctx:PortalContext,id:string,input:unknown,key:string){const data=parse(channelPublish,input);return this.mutate(ctx,id,'publish',key,data,s=>{const row=this.row(s,id);this.version(row,data.expected_version);const preview=this.preview(ctx,id);if(preview.preview_hash!==data.preview_hash)throw new PortalError('channel_preview_mismatch');const release={release_id:randomUUID(),version:row.version+1,input:preview.input,published_at:new Date().toISOString()};this.store.db.prepare('INSERT INTO channel_releases VALUES(?,?,?,?)').run(release.release_id,id,s.partition,JSON.stringify(release));this.store.db.prepare('UPDATE channels SET active=?,version=version+1,updated=? WHERE id=?').run(release.release_id,release.published_at,id);return id;});}
 disable(ctx:PortalContext,id:string,input:unknown,key:string){const data=parse(channelDisable,input);return this.mutate(ctx,id,'disable',key,data,s=>{this.version(this.row(s,id),data.expected_version);this.store.db.prepare('UPDATE channels SET active=NULL,version=version+1,updated=? WHERE id=?').run(new Date().toISOString(),id);return id;});}
 rollback(ctx:PortalContext,id:string,input:unknown,key:string){const data=parse(channelRollback,input);return this.mutate(ctx,id,'rollback',key,data,s=>{this.version(this.row(s,id),data.expected_version);const preview=this.preview(ctx,id,data.release_id);if(data.preview_hash!==preview.preview_hash)throw new PortalError('channel_preview_mismatch');this.store.db.prepare('UPDATE channels SET active=?,version=version+1,updated=? WHERE id=?').run(data.release_id,new Date().toISOString(),id);return id;});}
}
