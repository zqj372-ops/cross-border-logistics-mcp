import {createHash} from 'node:crypto';
import {chmodSync,chownSync,existsSync,lstatSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseArgs} from 'node:util';
import {CaseStore} from '../../services/access-gateway/portal/cases';
import {NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import {DocumentStore} from '../../services/quote-documents/service';
import {DocumentWorkflowStore,assertNoExternalSqliteHandles} from '../../services/quote-documents/workflow';

interface LegacyDocumentSnapshot{
  readonly configs:string;
  readonly quotes:string;
  readonly idempotency:string;
  readonly audit:string;
  readonly pdfs:string;
  readonly quoteCount:number;
  readonly pdfCount:number;
}

interface MigrationResult{
  readonly status:'migrated'|'already_migrated';
  readonly case_version:2|3;
  readonly native_version:3;
  readonly document_version:5;
  readonly legacy_documents:{
    readonly quote_count:number;
    readonly pdf_count:number;
    readonly digest:string;
  };
}

export interface MigrateFclSqliteOfflineOptions{
  readonly stateRoot:string;
  readonly quoteDocumentsPath?:string;
  readonly writersStopped:boolean;
  readonly execution?:boolean;
  readonly exclusiveCheck?:(path:string)=>void;
  readonly runtimeUid?:number;
  readonly runtimeGid?:number;
}

function digestRows(rows:unknown[],pdfRows:Array<{sha256:string;bytes:Uint8Array}>):string{
  const hash=createHash('sha256');
  hash.update(JSON.stringify(rows));
  for(const row of pdfRows){hash.update(row.sha256);hash.update(Buffer.from(row.bytes));}
  return hash.digest('hex');
}

function legacySnapshot(path:string):LegacyDocumentSnapshot|null{
  if(!existsSync(path))return null;
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const configs=db.prepare('SELECT org,version,input FROM document_configs ORDER BY org').all() as unknown[];
    const quotes=db.prepare('SELECT id,org,owner,payload FROM quote_documents ORDER BY id').all() as unknown[];
    const idempotency=db.prepare('SELECT scope,key,digest,result FROM document_idempotency ORDER BY scope,key').all() as unknown[];
    const audit=db.prepare('SELECT id,org,actor,action,digest,created FROM document_audit ORDER BY id').all() as unknown[];
    const pdfRows=db.prepare('SELECT id,version,sha256,bytes FROM document_pdfs ORDER BY id,version').all() as Array<{sha256:string;bytes:Uint8Array}>;
    return {
      configs:createHash('sha256').update(JSON.stringify(configs)).digest('hex'),
      quotes:createHash('sha256').update(JSON.stringify(quotes)).digest('hex'),
      idempotency:createHash('sha256').update(JSON.stringify(idempotency)).digest('hex'),
      audit:createHash('sha256').update(JSON.stringify(audit)).digest('hex'),
      pdfs:digestRows(pdfRows,pdfRows),
      quoteCount:quotes.length,
      pdfCount:pdfRows.length,
    };
  }finally{db.close();}
}

function assertLegacyPreserved(before:LegacyDocumentSnapshot|null,after:LegacyDocumentSnapshot|null):void{
  if(!before)return;
  if(!after||before.configs!==after.configs||before.quotes!==after.quotes||before.idempotency!==after.idempotency||before.audit!==after.audit||before.pdfs!==after.pdfs||before.quoteCount!==after.quoteCount||before.pdfCount!==after.pdfCount)throw new Error('fcl_migration_legacy_readback_failed');
}

function restoreRuntimeOwnership(path:string,uid:number|undefined,gid:number|undefined):void{
  if(uid===undefined&&gid===undefined)return;
  for(const candidate of [path,`${path}-wal`,`${path}-shm`]){
    if(!existsSync(candidate))continue;
    chownSync(candidate,uid??process.getuid?.()??-1,gid??process.getgid?.()??-1);
    chmodSync(candidate,0o600);
  }
}

function assertSecureStatePaths(stateRoot:string,paths:readonly string[]):void{
  let root;
  try{root=lstatSync(stateRoot);}catch{throw new Error('fcl_migration_state_root_invalid');}
  if(!root.isDirectory()||root.isSymbolicLink()||(root.mode&0o077)!==0)throw new Error('fcl_migration_state_root_invalid');
  for(const path of paths){
    if(!path.startsWith(`${stateRoot}/`))throw new Error('fcl_migration_path_outside_state_root');
    for(const candidate of [path,`${path}-wal`,`${path}-shm`]){
      if(!existsSync(candidate))continue;
      const stat=lstatSync(candidate);
      if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error('fcl_migration_path_insecure');
    }
  }
}

function version(path:string,expectedIdentity:string):number|null{
  if(!existsSync(path))return null;
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const identity=db.prepare('SELECT application_id FROM portal_database_identity WHERE singleton=1').get() as {application_id:string}|undefined;
    if(identity?.application_id!==expectedIdentity)throw new Error('fcl_migration_identity_invalid');
    return Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
  }finally{db.close();}
}

export function migrateFclSqliteOffline(options:MigrateFclSqliteOfflineOptions):MigrationResult{
  if(!options.writersStopped)throw new Error('fcl_migration_writers_must_be_stopped');
  if(!isAbsolute(options.stateRoot)||resolve(options.stateRoot)!==options.stateRoot)throw new Error('fcl_migration_state_root_invalid');
  const quotePath=options.quoteDocumentsPath??join(options.stateRoot,'quote-documents.sqlite');
  if(!isAbsolute(quotePath)||resolve(quotePath)!==quotePath)throw new Error('fcl_migration_quote_path_invalid');
  const casePath=join(options.stateRoot,'business-cases.sqlite'),nativePath=join(options.stateRoot,'native-business.sqlite');
  assertSecureStatePaths(options.stateRoot,[casePath,nativePath,quotePath]);
  const exclusiveCheck=options.exclusiveCheck??assertNoExternalSqliteHandles;
  const exclusive=(path:string)=>()=>exclusiveCheck(path);
  for(const path of [casePath,nativePath,quotePath])exclusiveCheck(path);
  const initialCase=version(casePath,'freightclaw-business-cases');
  const initialNative=version(nativePath,'freightclaw-native-business');
  const initialDocument=version(quotePath,'freightclaw-quote-documents');
  if(initialCase!==null&&!(options.execution?[1,2,3]:[1,2]).includes(initialCase))throw new Error('fcl_migration_case_version_invalid');
  if(initialNative!==null&&![1,2,3].includes(initialNative))throw new Error('fcl_migration_native_version_invalid');
  if(initialDocument!==null&&![2,3,4,5].includes(initialDocument))throw new Error('fcl_migration_document_version_invalid');
  const before=legacySnapshot(quotePath);

  const caseStore=new CaseStore(casePath,{...(options.execution?{execution:{mode:'exclusive_verified' as const,authorized:true as const,oldWritersStopped:true as const,assertExclusive:exclusive(casePath)}}:{}),fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:exclusive(casePath)}});
  let nativeStore:NativeAdminStore|undefined,documentStore:DocumentStore|undefined,workflowStore:DocumentWorkflowStore|undefined;
  try{
    nativeStore=new NativeAdminStore(nativePath,{fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:exclusive(nativePath)}});
    documentStore=new DocumentStore(quotePath,{fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:exclusive(quotePath)}});
    workflowStore=new DocumentWorkflowStore(documentStore,{oldWritersStopped:true,ownershipMode:'existing-database',externalHandleProbe:exclusiveCheck,fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:exclusive(quotePath)}});
    const caseVersion=Number((caseStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    const nativeVersion=Number((nativeStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    const documentVersion=Number((documentStore.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if(caseVersion!==(options.execution?3:2)||nativeVersion!==3||documentVersion!==5)throw new Error('fcl_migration_readback_failed');
    const after=legacySnapshot(quotePath);
    assertLegacyPreserved(before,after);
    return Object.freeze({
      status:initialCase===(options.execution?3:2)&&initialNative===3&&initialDocument===5?'already_migrated':'migrated',
      case_version:options.execution?3:2,
      native_version:3,
      document_version:5,
      legacy_documents:Object.freeze({
        quote_count:after?.quoteCount??0,
        pdf_count:after?.pdfCount??0,
        digest:after?createHash('sha256').update(JSON.stringify(after)).digest('hex'):createHash('sha256').update('none').digest('hex'),
      }),
    });
  }finally{
    workflowStore?.close();
    documentStore?.close();
    nativeStore?.close();
    caseStore.close();
    for(const path of [casePath,nativePath,quotePath])restoreRuntimeOwnership(path,options.runtimeUid,options.runtimeGid);
  }
}

if(process.argv[1]?.endsWith('migrate-fcl-sqlite-offline.ts')===true||process.argv[1]?.endsWith('migrate-fcl-sqlite-offline.mjs')===true){
  try{
    const {values}=parseArgs({args:process.argv.slice(2),strict:true,options:{'state-root':{type:'string'},'quote-documents':{type:'string'},'writers-stopped':{type:'boolean'},'execution':{type:'boolean'},'runtime-uid':{type:'string'},'runtime-gid':{type:'string'}}});
    if(!values['state-root']||values['writers-stopped']!==true)throw new Error('fcl_migration_arguments_invalid');
    const runtimeUid=values['runtime-uid']===undefined?undefined:Number(values['runtime-uid']),runtimeGid=values['runtime-gid']===undefined?undefined:Number(values['runtime-gid']);
    if(Boolean(values['runtime-uid'])!==Boolean(values['runtime-gid'])||(runtimeUid!==undefined&&(!Number.isSafeInteger(runtimeUid)||runtimeUid<1))||(runtimeGid!==undefined&&(!Number.isSafeInteger(runtimeGid)||runtimeGid<1)))throw new Error('fcl_migration_runtime_owner_invalid');
    const result=migrateFclSqliteOffline({stateRoot:resolve(values['state-root']),...(values['quote-documents']?{quoteDocumentsPath:resolve(values['quote-documents'])}:{}),writersStopped:true,execution:values.execution===true,...(runtimeUid===undefined?{}:{runtimeUid,runtimeGid:runtimeGid!})});
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){
    process.stderr.write(`${error instanceof Error?error.message:'fcl_migration_failed'}\n`);
    process.exitCode=1;
  }
}
