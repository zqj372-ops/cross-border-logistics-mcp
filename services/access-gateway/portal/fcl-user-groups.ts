import {createHash,randomUUID} from 'node:crypto';
import type {z} from 'zod';
import type {NativeAdminStore} from './native-admin';
import {PortalError,type PortalIdentity} from './contracts';
import {groupRecordSchema,groupSelfSchema,groupListInput,groupListOutput,groupSaveInput,groupSaveOutput} from './fcl-user-groups-contracts';
type GroupRecord=z.infer<typeof groupRecordSchema>;
export class FclUserGroups{
 private readonly prefix:string;
 constructor(private readonly store:NativeAdminStore,private readonly administratorId:string){this.prefix=`fcl-users:${administratorId}:`;}
 private verified(identity:PortalIdentity){if(!identity.emailVerified||!identity.userId)throw new PortalError('fcl_not_found');}
 private admin(identity:PortalIdentity){this.verified(identity);if(identity.userId!==this.administratorId)throw new PortalError('fcl_not_found');}
 private read(id:string){const row=this.store.db.prepare("SELECT draft FROM native_configs WHERE scope=? AND kind='user-group'").get(this.prefix+id) as {draft:string}|undefined;return row?groupRecordSchema.parse(JSON.parse(row.draft)):null;}
 private persist(row:GroupRecord){this.store.db.prepare("INSERT INTO native_configs(scope,kind,version,draft,active) VALUES(?,'user-group',?,?,NULL) ON CONFLICT(scope,kind) DO UPDATE SET version=excluded.version,draft=excluded.draft").run(this.prefix+row.user_id,row.version,JSON.stringify(groupRecordSchema.parse(row)));}
 explicit(identity:PortalIdentity){this.verified(identity);return this.read(identity.userId)?.group??null;}
 self(identity:PortalIdentity,participant=false){this.verified(identity);return groupSelfSchema.parse({group:identity.userId===this.administratorId?'administrator':this.explicit(identity)??(identity.platformRole==='operator'?'sales':participant?'operations':'customer'),can_manage:identity.userId===this.administratorId});}
 observe(identity:PortalIdentity,participant:boolean){
  this.verified(identity);const old=this.read(identity.userId),legacy=identity.platformRole==='operator'?'sales':participant?'operations':'customer';
  if(old&&old.name===identity.displayName&&old.email===identity.email&&old.legacy_group===legacy)return;
  this.persist({user_id:identity.userId,name:identity.displayName,email:identity.email,group:old?.group??null,legacy_group:legacy,version:old?.version??0});
 }
 list(identity:PortalIdentity,input:unknown){this.admin(identity);const r=groupListInput.parse(input);
  const rows=this.store.db.prepare("SELECT rowid,draft FROM native_configs WHERE kind='user-group' AND substr(scope,1,?)=? AND rowid<? AND (?='' OR instr(lower(json_extract(draft,'$.name')),lower(?))>0 OR instr(lower(json_extract(draft,'$.email')),lower(?))>0) ORDER BY rowid DESC LIMIT 51").all(this.prefix.length,this.prefix,r.before??Number.MAX_SAFE_INTEGER,r.query,r.query,r.query) as {rowid:number;draft:string}[];
  return groupListOutput.parse({items:rows.slice(0,50).map(row=>{const person=groupRecordSchema.parse(JSON.parse(row.draft)),admin=person.user_id===this.administratorId;return {...person,group:admin?'administrator':person.group??person.legacy_group,source:admin?'administrator':person.group?'explicit':person.legacy_group!=='customer'?'existing':'default'};}),next_before:rows.length>50?rows[49]!.rowid:null});
 }
 save(identity:PortalIdentity,input:unknown,key:string){
  this.admin(identity);const r=groupSaveInput.parse(input);if(r.user_id===this.administratorId)throw new PortalError('fcl_group_administrator_protected');
  if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
  const db=this.store.db,scope=this.prefix+'save:'+identity.userId,digest=createHash('sha256').update(JSON.stringify(r)).digest('hex');
  db.exec('BEGIN IMMEDIATE');try{
   const prior=db.prepare('SELECT digest FROM native_idempotency WHERE scope=? AND key=?').get(scope,key) as {digest:string}|undefined;
   if(prior&&prior.digest!==digest)throw new PortalError('idempotency_conflict');
   const row=this.read(r.user_id);if(!row)throw new PortalError('fcl_group_user_not_found');
   if(!prior){if(row.version!==r.expected_version)throw new PortalError('version_conflict');row.group=r.group;row.version++;this.persist(row);db.prepare('INSERT INTO native_idempotency VALUES(?,?,?,?)').run(scope,key,digest,'{}');db.prepare('INSERT INTO native_audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(),this.prefix+r.user_id,'user-group',identity.userId,'group-save',digest,new Date().toISOString());}
   const saved=this.read(r.user_id)!;const result=groupSaveOutput.parse({user_id:saved.user_id,group:saved.group,version:saved.version});db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
}
