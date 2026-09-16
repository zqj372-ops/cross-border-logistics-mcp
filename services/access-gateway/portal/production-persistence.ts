import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const VERSION=1;
const quoteDatabaseIdentityByConnection=new WeakMap<DatabaseSync,string>();
const quoteDatabasePathByConnection=new WeakMap<DatabaseSync,string>();
const quoteDatabaseConnections=new Map<string,Set<DatabaseSync>>();
function quoteDatabaseIdentity(databasePath:string):string{
  const stat=statSync(databasePath,{bigint:true});
  return `${stat.dev}:${stat.ino}`;
}
function registerQuoteDatabaseConnection(databasePath:string,database:DatabaseSync):void{
  const identity=quoteDatabaseIdentity(databasePath),connections=quoteDatabaseConnections.get(identity)??new Set<DatabaseSync>();
  connections.add(database);quoteDatabaseConnections.set(identity,connections);quoteDatabaseIdentityByConnection.set(database,identity);quoteDatabasePathByConnection.set(database,databasePath);
}
function connectionIsOpen(database:DatabaseSync):boolean{
  try{database.prepare("SELECT 1").get();return true;}catch{return false;}
}
export function assertExclusivePortalDatabaseOwnership(databasePath:string,database:DatabaseSync):void{
  const identity=quoteDatabaseIdentityByConnection.get(database)??quoteDatabaseIdentity(databasePath),connections=quoteDatabaseConnections.get(identity);
  if(connections){for(const connection of connections)if(!connectionIsOpen(connection))connections.delete(connection);}
  if(!connections||connections.size!==1||!connections.has(database))throw new Error("portal_database_ownership_conflict");
}
function assertNoQuoteDatabasePathAlias(databasePath:string):void{
  let identity:string;try{identity=quoteDatabaseIdentity(databasePath);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const connections=quoteDatabaseConnections.get(identity);if(!connections)return;
  for(const connection of connections)if(!connectionIsOpen(connection))connections.delete(connection);
  if([...connections].some(connection=>quoteDatabasePathByConnection.get(connection)!==databasePath))throw new Error('portal_database_path_alias_in_use');
}
export function closePortalProductionDatabase(databasePath:string,database:DatabaseSync):void{
  const identity=quoteDatabaseIdentityByConnection.get(database)??quoteDatabaseIdentity(databasePath),connections=quoteDatabaseConnections.get(identity);
  connections?.delete(database);if(connections?.size===0)quoteDatabaseConnections.delete(identity);quoteDatabaseIdentityByConnection.delete(database);quoteDatabasePathByConnection.delete(database);database.close();
}
export function openPortalProductionDatabase(databasePath:string,applicationId:string,maxVersion=VERSION):DatabaseSync{
  if(!isAbsolute(databasePath)||resolve(databasePath)!==databasePath||databasePath.includes("\0"))throw new Error("portal_database_path_invalid");
  const parent=dirname(databasePath);mkdirSync(parent,{recursive:true,mode:0o700});
  const parentEntry=lstatSync(parent);if(!parentEntry.isDirectory()||parentEntry.isSymbolicLink()||(parentEntry.mode&0o077)!==0)throw new Error("portal_database_parent_insecure");
  const canonicalPath=join(realpathSync(parent),basename(databasePath));
  for(const path of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`])try{const entry=lstatSync(path);if(entry.isSymbolicLink()||!entry.isFile())throw new Error("portal_database_path_invalid");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(applicationId==="freightclaw-quote-documents")assertNoQuoteDatabasePathAlias(canonicalPath);
  const database=new DatabaseSync(canonicalPath);chmodSync(canonicalPath,0o600);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL;");
  const version=Number((database.prepare("PRAGMA user_version").get() as {user_version:number}).user_version);
  if(version>maxVersion){database.close();throw new Error("portal_database_version_unsupported");}
  database.exec("CREATE TABLE IF NOT EXISTS portal_database_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),application_id TEXT NOT NULL)");
  const identity=database.prepare("SELECT application_id FROM portal_database_identity WHERE singleton=1").get() as {application_id:string}|undefined;
  if(identity&&identity.application_id!==applicationId){database.close();throw new Error("portal_database_identity_mismatch");}
  if(!identity)database.prepare("INSERT INTO portal_database_identity VALUES(1,?)").run(applicationId);
  if(version===0)database.exec(`PRAGMA user_version=${VERSION}`);
  if(applicationId==="freightclaw-quote-documents")registerQuoteDatabaseConnection(canonicalPath,database);
  return database;
}

export function securePortalDatabaseFiles(databasePath:string):void{
  for(const path of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`]){try{const entry=lstatSync(path);if(entry.isSymbolicLink()||!entry.isFile())throw new Error("portal_database_path_invalid");chmodSync(path,0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
}
