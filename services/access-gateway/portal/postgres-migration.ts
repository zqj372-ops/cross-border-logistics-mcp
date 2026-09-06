import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { PostgresPortalStores } from "./postgres-stores";
import { PostgresCallLogStore } from "./postgres-call-log";
import { callEventSchema } from "./call-log";
import { createPostgresPool, postgresConfigurationFromEnvironment, postgresQualifiedTable, type PostgresGatewayConfiguration } from "../postgres-store";

function readDatabase(root:string,name:string,identity:string,queries:Record<string,string>){
  const path=resolve(root,name),stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error("migration_source_insecure");
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    if(db.prepare("PRAGMA user_version").get()?.user_version!==1||db.prepare("SELECT application_id FROM portal_database_identity WHERE singleton=1").get()?.application_id!==identity)throw new Error("migration_source_identity_invalid");
    return Object.fromEntries(Object.entries(queries).map(([key,sql])=>[key,db.prepare(sql).all()]));
  }finally{db.close();}
}
function snapshot(root:string){
  if(!isAbsolute(root)||resolve(root)!==root)throw new Error("migration_source_invalid");
  return {
    portal:readDatabase(root,"portal.sqlite","freightclaw-portal",{state:"SELECT payload FROM portal_state",idempotency:"SELECT action,idempotency_key AS key,request_hash AS hash,result_json AS result FROM portal_idempotency ORDER BY action,idempotency_key"}),
    business:readDatabase(root,"business-access.sqlite","freightclaw-business-access",{state:"SELECT payload FROM business_access_state",idempotency:"SELECT scope AS action,key,hash,result FROM business_access_idempotency ORDER BY scope,key"}),
    sessions:readDatabase(root,"sessions.sqlite","freightclaw-portal-sessions",{values:"SELECT session_id AS id,payload,expires_at AS expires FROM portal_sessions ORDER BY session_id"}),
    calls:existsSync(resolve(root,"calls.sqlite"))?readDatabase(root,"calls.sqlite","freightclaw-call-log",{values:"SELECT * FROM portal_call_events ORDER BY event_id"}):{values:[]},
  };
}
const canonical=(value:unknown):string=>JSON.stringify(value,(_,v:unknown)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
const fingerprint=(input:unknown)=>`sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
export async function migratePortalPostgres(options:{configuration:PostgresGatewayConfiguration;sourceRoot?:string;initializeEmpty?:boolean;workerUrl?:URL}){
  if(Boolean(options.sourceRoot)===Boolean(options.initializeEmpty))throw new Error("migration_source_or_empty_required");
  const data=options.sourceRoot?snapshot(options.sourceRoot):null,digest=fingerprint(data),table=(name:string)=>postgresQualifiedTable(options.configuration.schema,name);
  const bootstrap=new PostgresPortalStores({configuration:options.configuration,initialize:true,...(options.workerUrl?{workerUrl:options.workerUrl}:{})});bootstrap.close();
  const callStore=await PostgresCallLogStore.open(options.configuration,{initialize:true});await callStore.close();
  const pool=createPostgresPool(options.configuration),client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`${options.configuration.schema}:portal-migration-v1`]);
    await client.query(`CREATE TABLE IF NOT EXISTS ${table("portal_shared_migration")}(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),fingerprint text NOT NULL,completed_at timestamptz NOT NULL)`);
    const prior=await client.query<{fingerprint:string}>(`SELECT fingerprint FROM ${table("portal_shared_migration")}`);
    if(prior.rowCount){if(prior.rows[0]!.fingerprint!==digest)throw new Error("migration_target_conflict");await client.query("COMMIT");return{status:"verified",fingerprint:digest,replayed:true};}
    const rows=await client.query<{payload:Record<string,unknown[]>}>(`SELECT payload FROM ${table("portal_shared_state")} ORDER BY kind FOR UPDATE`);
    if(rows.rows.some(row=>Object.values(row.payload).some(values=>values.length>0)))throw new Error("migration_target_not_empty");
    for(const name of ["portal_shared_sessions","portal_shared_idempotency","portal_call_events"])if((await client.query(`SELECT 1 FROM ${table(name)} LIMIT 1`)).rowCount)throw new Error("migration_target_not_empty");
    if(data){
      for(const kind of ["portal","business"] as const){
        const payload=data[kind].state?.[0]?.payload;if(typeof payload!=="string"||Buffer.byteLength(payload)>8*1024*1024)throw new Error("migration_payload_invalid");
        await client.query(`UPDATE ${table("portal_shared_state")} SET payload=$2::jsonb WHERE kind=$1`,[kind,payload]);
        for(const row of data[kind].idempotency??[])await client.query(`INSERT INTO ${table("portal_shared_idempotency")} VALUES($1,$2,$3,$4,$5::jsonb)`,[kind,row.action,row.key,row.hash,row.result]);
        const check=await client.query<{payload:unknown}>(`SELECT payload FROM ${table("portal_shared_state")} WHERE kind=$1`,[kind]);
        if(canonical(check.rows[0]?.payload)!==canonical(JSON.parse(payload) as unknown))throw new Error("migration_readback_failed");
        const idempotency=await client.query(`SELECT action,key,hash,result FROM ${table("portal_shared_idempotency")} WHERE kind=$1 ORDER BY action COLLATE "C",key COLLATE "C"`,[kind]);
        const expected=(data[kind].idempotency??[]).map(row=>({...row,result:JSON.parse(String(row.result)) as unknown}));
        if(canonical(idempotency.rows)!==canonical(expected))throw new Error("migration_idempotency_readback_failed");
      }
      for(const row of data.sessions.values??[])await client.query(`INSERT INTO ${table("portal_shared_sessions")} VALUES($1,$2::jsonb,$3)`,[row.id,row.payload,row.expires]);
      for(const row of data.calls.values??[]){const event=callEventSchema.parse(row);await client.query(`INSERT INTO ${table("portal_call_events")} VALUES($1,$2,$3::jsonb,$4)`,[event.event_id,event.tenant_id,JSON.stringify(event),event.created_at]);}
      const sessions=await client.query<{id:string;payload:unknown;expires:string}>(`SELECT id,payload,expires FROM ${table("portal_shared_sessions")} ORDER BY id COLLATE "C"`);
      const expectedSessions=(data.sessions.values??[]).map(row=>({...row,payload:JSON.parse(String(row.payload)) as unknown,expires:String(row.expires)}));
      if(canonical(sessions.rows)!==canonical(expectedSessions))throw new Error("migration_sessions_readback_failed");
      const calls=await client.query<{payload:unknown}>(`SELECT payload FROM ${table("portal_call_events")} ORDER BY event_id COLLATE "C"`);
      if(canonical(calls.rows.map(row=>row.payload))!==canonical(data.calls.values??[]))throw new Error("migration_calls_readback_failed");
      if(fingerprint(snapshot(options.sourceRoot!))!==digest)throw new Error("migration_source_changed");
    }
    await client.query(`INSERT INTO ${table("portal_shared_migration")} VALUES(true,$1,now())`,[digest]);
    await client.query("COMMIT");return{status:"verified",fingerprint:digest,replayed:false};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  if(!(args.length===1&&args[0]==="--empty"||args.length===3&&args[0]==="--offline-source"&&args[2]==="--writers-stopped"))throw new Error("Use --empty for a new installation, or --offline-source /absolute/path --writers-stopped for a stopped SQLite installation.");
  void migratePortalPostgres({configuration:postgresConfigurationFromEnvironment(process.env),...(args[0]==="--empty"?{initializeEmpty:true}:{sourceRoot:args[1]!})}).then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(()=>{process.stderr.write("portal_migration_failed; source retained; do not switch traffic\n");process.exitCode=1;});
}
