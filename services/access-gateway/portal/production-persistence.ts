import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const VERSION=1;
export function openPortalProductionDatabase(databasePath:string,applicationId:string):DatabaseSync{
  if(!isAbsolute(databasePath)||resolve(databasePath)!==databasePath||databasePath.includes("\0"))throw new Error("portal_database_path_invalid");
  const parent=dirname(databasePath);mkdirSync(parent,{recursive:true,mode:0o700});
  const parentEntry=lstatSync(parent);if(!parentEntry.isDirectory()||parentEntry.isSymbolicLink()||(parentEntry.mode&0o077)!==0)throw new Error("portal_database_parent_insecure");
  const canonicalPath=join(realpathSync(parent),basename(databasePath));
  for(const path of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`])try{const entry=lstatSync(path);if(entry.isSymbolicLink()||!entry.isFile())throw new Error("portal_database_path_invalid");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const database=new DatabaseSync(canonicalPath);chmodSync(canonicalPath,0o600);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL;");
  const version=Number((database.prepare("PRAGMA user_version").get() as {user_version:number}).user_version);
  if(version>VERSION){database.close();throw new Error("portal_database_version_unsupported");}
  database.exec("CREATE TABLE IF NOT EXISTS portal_database_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),application_id TEXT NOT NULL)");
  const identity=database.prepare("SELECT application_id FROM portal_database_identity WHERE singleton=1").get() as {application_id:string}|undefined;
  if(identity&&identity.application_id!==applicationId){database.close();throw new Error("portal_database_identity_mismatch");}
  if(!identity)database.prepare("INSERT INTO portal_database_identity VALUES(1,?)").run(applicationId);
  if(version===0)database.exec(`PRAGMA user_version=${VERSION}`);
  return database;
}

export function securePortalDatabaseFiles(databasePath:string):void{
  for(const path of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`]){try{const entry=lstatSync(path);if(entry.isSymbolicLink()||!entry.isFile())throw new Error("portal_database_path_invalid");chmodSync(path,0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
}
