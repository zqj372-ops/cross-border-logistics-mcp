import type {DatabaseSync} from 'node:sqlite';

export const FCL_EXECUTION_STORE_VERSION=3;
const tables={
  fcl_case_progress:'CREATE TABLE fcl_case_progress(case_id TEXT PRIMARY KEY REFERENCES business_cases(case_id),owner_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),payload TEXT NOT NULL CHECK(json_valid(payload)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL)',
  fcl_execution_outbox:'CREATE TABLE fcl_execution_outbox(message_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,case_id TEXT NOT NULL REFERENCES business_cases(case_id),node_id TEXT NOT NULL,cycle INTEGER NOT NULL CHECK(cycle>0),audience TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),UNIQUE(event_id,node_id,cycle,audience))',
} as const;
const indexes={fcl_execution_owner:'CREATE INDEX fcl_execution_owner ON fcl_case_progress(owner_id,updated_at,case_id)',fcl_execution_dispatch:'CREATE INDEX fcl_execution_dispatch ON fcl_execution_outbox(status,message_id)'} as const;
export type ExecutionMigration={mode:'reopen'}|{mode:'fresh_fixture';authorized:true;oldWritersStopped:true}|{mode:'exclusive_verified';authorized:true;oldWritersStopped:true;assertExclusive:()=>void};
export function checkExecutionMigration(version:number,mode:ExecutionMigration){
  if(version>=FCL_EXECUTION_STORE_VERSION)return;
  if(mode.mode==='reopen')throw new Error('fcl_execution_schema_not_upgraded');
  if(mode.authorized!==true||mode.oldWritersStopped!==true)throw new Error('fcl_execution_upgrade_not_authorized');
  if(mode.mode==='exclusive_verified'){
    if(typeof mode.assertExclusive!=='function')throw new Error('fcl_execution_exclusive_required');
    try{mode.assertExclusive();}catch{throw new Error('fcl_execution_exclusive_failed');}
  }
}
export function initializeExecutionTables(db:DatabaseSync,version:number,mode:ExecutionMigration){
  if(version<FCL_EXECUTION_STORE_VERSION){
    if(mode.mode==='reopen')throw new Error('fcl_execution_schema_not_upgraded');
    if(mode.mode==='fresh_fixture'&&(db.prepare('SELECT count(*) AS n FROM business_cases').get() as {n:number}).n!==0)throw new Error('fcl_execution_fixture_not_empty');
    for(const sql of Object.values(tables))db.exec(sql);
    for(const sql of Object.values(indexes))db.exec(sql);
  }
  for(const [name,sql] of Object.entries(tables)){
    const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as {sql:string}|undefined;
    if(row?.sql!==sql)throw new Error('fcl_execution_schema_incompatible');
  }
  for(const [name,sql] of Object.entries(indexes)){
    const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as {sql:string}|undefined;
    if(row?.sql!==sql)throw new Error('fcl_execution_schema_incompatible');
  }
  db.exec(`PRAGMA user_version=${FCL_EXECUTION_STORE_VERSION}`);
}
