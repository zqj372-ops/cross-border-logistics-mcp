import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { SqliteProductionPortalStore } from "../../services/access-gateway/portal/store";
import { SqliteProductionBusinessAccessStore } from "../../services/access-gateway/portal/business-access/store";
import { SqlitePersistentPortalSessionStore } from "../../services/access-gateway/portal/session";
import { migratePortalPostgres } from "../../services/access-gateway/portal/postgres-migration";
import { PostgresCallLogStore } from "../../services/access-gateway/portal/postgres-call-log";
import { PostgresPortalStores } from "../../services/access-gateway/portal/postgres-stores";
import type { PostgresGatewayConfiguration } from "../../services/access-gateway/postgres-store";
import { PortalSessionManager } from "../../services/access-gateway/portal/session";

const enabled = process.env.PORTAL_TEST_POSTGRES_PORT !== undefined;
const root = mkdtempSync(join(tmpdir(), "portal-pg-fixture-"));
const schema = `portal_test_${process.pid}_${Date.now()}`;
let config: PostgresGatewayConfiguration, a: PostgresPortalStores, b: PostgresPortalStores;
let admin: Pool;
beforeAll(async () => {
  if (!enabled) return;
  writeFileSync(join(root,"password"),"fixture-password-only",{mode:0o600});
  config={backend:"postgresql",host:"127.0.0.1",port:Number(process.env.PORTAL_TEST_POSTGRES_PORT),database:"capability_fixture",user:"capability_fixture",passwordFile:join(root,"password"),schema,sslMode:"disable",maxConnections:2,connectionTimeoutMillis:1000,idleTimeoutMillis:1000,statementTimeoutMillis:1000};
  admin=new Pool({host:config.host,port:config.port,database:config.database,user:config.user});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for(const [entry,out] of [["postgres-worker.ts","postgres-worker.mjs"],["postgres-stores.ts","postgres-stores.mjs"]]) await build({entryPoints:[resolve("services/access-gateway/portal",entry!)],outfile:join(root,out!),bundle:true,format:"esm",platform:"node",target:"node22",banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'},logLevel:"silent"});
  a=new PostgresPortalStores({initialize:true,configuration:config,workerUrl:pathToFileURL(join(root,"postgres-worker.mjs"))});
  b=new PostgresPortalStores({configuration:config,workerUrl:pathToFileURL(join(root,"postgres-worker.mjs"))});
},20000);
afterAll(async()=>{a?.close();b?.close();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}rmSync(root,{recursive:true,force:true});});

it.skipIf(!enabled)("shares durable account mutations and idempotency, preserves rollback, and observes revocation across instances",()=>{
  a.portal.transact("create","postgres-test-create001","hash",data=>{data.users.push({userId:"shared-user",displayName:"Test",email:"test@example.invalid",emailVerified:true,createdAt:new Date().toISOString()});return{id:"shared-user"};});
  expect(b.portal.read().users.map(x=>x.userId)).toEqual(["shared-user"]);
  expect(b.portal.transact("create","postgres-test-create001","hash",()=>({id:"wrong"}))).toEqual({id:"shared-user"});
  expect(()=>b.portal.transact("create","postgres-test-create001","other",()=>null)).toThrow("idempotency_conflict");
  expect(()=>a.portal.transact("rollback","postgres-test-rollback1","hash",data=>{data.users.length=0;throw new Error("rollback");})).toThrow("rollback");
  expect(b.portal.read().users).toHaveLength(1);
  const mA=new PortalSessionManager({store:a.sessions}),mB=new PortalSessionManager({store:b.sessions});
  const first=mA.ensure(null).session;
  expect(mB.get(first.sessionId)?.csrfToken).toBe(first.csrfToken);
  mA.beginOidc(first.sessionId,{state:"once",nonce:"nonce",codeVerifier:"verifier",authorizationUrl:"https://id.invalid/authorize"});
  expect(mB.consumeOidc(first.sessionId,"once").state).toBe("once");
  expect(()=>mA.consumeOidc(first.sessionId,"once")).toThrow("oidc_state_invalid");
  const current=mA.get(first.sessionId)!;
  b.sessions.delete(first.sessionId);
  expect(a.sessions.replace!(first.sessionId,current.csrfToken,{...current,csrfToken:"stale"})).toBe(false);
  expect(mA.get(first.sessionId)).toBeNull();
});

it.skipIf(!enabled)("serializes concurrent changes from separate processes without lost updates",async()=>{
  const run=(prefix:string)=>new Promise<void>((resolve,reject)=>{
    const worker=new Worker(`const {workerData,parentPort}=require('node:worker_threads'); (async()=>{const {PostgresPortalStores}=await import(workerData.module);const s=new PostgresPortalStores({configuration:workerData.config});try {for(let i=0;i<12;i++)s.business.transact('concurrency',workerData.prefix+'-concurrent-key-'+i,'hash',data=>{data.audit.push({auditId:workerData.prefix+i,organizationId:null,actorRef:'fixture',action:'test',objectRef:'counter',status:'success',requestId:'fixture',createdAt:new Date().toISOString()});return true;});parentPort.postMessage('done');}finally{s.close();}})().catch(()=>process.exit(1));`,{eval:true,workerData:{module:pathToFileURL(join(root,"postgres-stores.mjs")).href,config,prefix}});
    worker.on("message",()=>resolve());worker.on("error",reject);worker.on("exit",code=>{if(code!==0)reject(new Error(`worker_exit_${code}`));});
  });
  await Promise.all([run("a"),run("b")]);
  expect(a.business.read().audit).toHaveLength(24);
  a.close();a=new PostgresPortalStores({configuration:config,workerUrl:pathToFileURL(join(root,"postgres-worker.mjs"))});
  expect(a.business.read().audit).toHaveLength(24);
  expect(a.portal.read().users).toHaveLength(1);
},20000);

it.skipIf(!enabled)("fails closed when shared storage is unavailable and reconnects after recovery",async()=>{
  const table=`"${schema}"."portal_shared_state"`;
  await admin.query(`ALTER TABLE ${table} RENAME TO portal_shared_state_offline`);
  expect(()=>a.portal.read()).toThrow("portal_shared_store_unavailable");
  await admin.query(`ALTER TABLE "${schema}"."portal_shared_state_offline" RENAME TO portal_shared_state`);
  expect(a.portal.read().users).toHaveLength(1);
});

it.skipIf(!enabled)("shares scoped call records between Runtime and Portal without request payloads",async()=>{
  const now=Date.now(),first=await PostgresCallLogStore.open(config,{initialize:true,now:()=>now}),second=await PostgresCallLogStore.open(config,{now:()=>now});
  try{await first.append({event_id:"call_shared01",tenant_id:"tenant_shared",client_id:"client_shared",actor_ref:"fixture_actor",operation:"customs.query",request_id:"req_shared01",status:"unavailable",duration_ms:20,created_at:new Date(now-1000).toISOString()});
    const page=await second.query({tenantId:"tenant_shared",clientIds:["client_shared"],actorRef:"fixture_actor",allPersonnel:false,includePersonnel:false},{limit:25});
    expect(page.summary.total).toBe(1);expect(page.events[0]?.request_id).toBe("req_shared01");
    expect((await second.query({tenantId:"tenant_other",clientIds:["client_shared"],actorRef:"fixture_actor",allPersonnel:true,includePersonnel:true},{limit:25})).summary.total).toBe(0);
  }finally{await first.close();await second.close();}
});

it.skipIf(!enabled)("migrates a stopped SQLite installation with replay journals and revoked credentials intact",async()=>{
  const source=join(root,"sqlite-source"),portal=new SqliteProductionPortalStore({databasePath:join(source,"portal.sqlite")}),business=new SqliteProductionBusinessAccessStore({databasePath:join(source,"business-access.sqlite")}),sessions=new SqlitePersistentPortalSessionStore({databasePath:join(source,"sessions.sqlite")});
  portal.transact("migration","migration-fixture-key1","hash",data=>{data.users.push({userId:"migrated-user",displayName:"Test",email:"test@example.invalid",emailVerified:true,createdAt:new Date().toISOString()});return{saved:true};});
  business.transact("migration","migration-fixture-key2","hash",data=>{data.credentials.push({credentialId:"bkey_111111111111111111111111",organizationId:"org_fixture",applicationId:"app_fixture",clientId:"client_fixture",label:"Revoked fixture",operations:["customs.query"],status:"revoked",deliveryStatus:"acknowledged",secretSalt:"synthetic-salt",secretHash:"synthetic-hash",secretLastFour:"0000",pepperVersion:"fixture-pepper-v1",createdAt:new Date().toISOString(),expiresAt:Math.floor(Date.now()/1000)+3600,lastUsedAt:null,revokedAt:new Date().toISOString(),rotatedFromId:null,version:3});return{saved:true};});
  const prior=business.read().credentials[0];const session=new PortalSessionManager({store:sessions}).ensure(null).session;portal.close();business.close();sessions.close();
  const target={...config,schema:`${schema}_migration`};await admin.query(`CREATE SCHEMA "${target.schema}"`);let migrated:PostgresPortalStores|undefined;
  try{const options={configuration:target,sourceRoot:source,workerUrl:pathToFileURL(join(root,"postgres-worker.mjs"))};expect((await migratePortalPostgres(options)).status).toBe("verified");expect((await migratePortalPostgres(options)).replayed).toBe(true);
    migrated=new PostgresPortalStores({configuration:target,workerUrl:options.workerUrl});expect(migrated.business.read().credentials[0]).toEqual(prior);expect(()=>migrated!.business.recordUse(prior!.credentialId,Math.floor(Date.now()/1000))).toThrow("business_authorization_denied");expect(migrated.sessions.get(session.sessionId)).toEqual(session);expect(migrated.portal.transact("migration","migration-fixture-key1","hash",()=>({saved:false}))).toEqual({saved:true});
  }finally{migrated?.close();await admin.query(`DROP SCHEMA "${target.schema}" CASCADE`);}
});

it.skipIf(!enabled)("reconnects after PostgreSQL terminates an idle authority connection",async()=>{
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='freightclaw-portal-shared' AND datname=$1",[config.database]);
  await vi.waitFor(()=>expect(a.portal.read().users).toHaveLength(1),{timeout:12000,interval:100});
},15000);
