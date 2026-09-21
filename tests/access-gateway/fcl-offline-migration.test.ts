import {spawn,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {expect,it} from 'vitest';
import {DocumentStore} from '../../services/quote-documents/service';
import {migrateFclSqliteOffline} from '../../deploy/scripts/migrate-fcl-sqlite-offline';

function legacyFixture(root:string){
  const path=join(root,'quote-documents.sqlite'),store=new DocumentStore(path);
  try{
    const db=store.db;
    db.prepare('INSERT INTO document_configs VALUES(?,?,?)').run('org_legacy',7,JSON.stringify({company_name:'Legacy enterprise',terms:'Legacy terms'}));
    for(const id of ['legacy-doc-1','legacy-doc-2']){
      const payload=JSON.stringify({id,version:3,state:'approved',input:{quote_no:id},template:{company_name:'Legacy enterprise'}});
      db.prepare('INSERT INTO quote_documents VALUES(?,?,?,?)').run(id,'org_legacy','legacy-owner',payload);
      db.prepare('INSERT INTO document_audit VALUES(?,?,?,?,?,?)').run(`audit-${id}`,'org_legacy','legacy-owner','approve',createHash('sha256').update(payload).digest('hex'),'2026-09-01T00:00:00.000Z');
    }
    for(const [id,version] of [['legacy-doc-1',3],['legacy-doc-2',3]] as const){
      const bytes=Buffer.from(`%PDF-1.7\nlegacy-${id}-${'x'.repeat(120)}`),sha=createHash('sha256').update(bytes).digest('hex');
      db.prepare('INSERT INTO document_pdfs VALUES(?,?,?,?)').run(id,version,sha,bytes);
    }
    db.prepare('INSERT INTO document_idempotency VALUES(?,?,?,?)').run('org_legacy','legacy-idempotency','digest','result');
    expect(db.prepare('PRAGMA user_version').get()).toEqual({user_version:2});
  }finally{store.close();}
  return path;
}

it('migrates a real v2 document store to v5 and preserves legacy records and PDF bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-offline-migration-'));
  try{
    const path=legacyFixture(root);
    const migrated=migrateFclSqliteOffline({stateRoot:root,quoteDocumentsPath:path,writersStopped:true,exclusiveCheck:()=>undefined});
    expect(migrated).toMatchObject({status:'migrated',legacy_documents:{quote_count:2,pdf_count:2}});
    const store=new DocumentStore(path,{fcl:{mode:'reopen'}});
    try{
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({user_version:5});
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM quote_documents').get()).toEqual({n:2});
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM document_pdfs').get()).toEqual({n:2});
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM document_configs').get()).toEqual({n:1});
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM document_audit').get()).toEqual({n:2});
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM document_idempotency').get()).toEqual({n:1});
    }finally{store.close();}
    const repeated=migrateFclSqliteOffline({stateRoot:root,quoteDocumentsPath:path,writersStopped:true,exclusiveCheck:()=>undefined});
    expect(repeated.status).toBe('already_migrated');
  }finally{rmSync(root,{recursive:true,force:true});}
});

it.skipIf(process.platform!=='linux')('rejects a live external writer before any FCL schema upgrade',async()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-offline-writer-'));let child:ChildProcess|undefined;
  try{
    const path=legacyFixture(root);
    child=spawn(process.execPath,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL;');console.log('ready');setInterval(()=>{},1000);",path],{stdio:['ignore','pipe','inherit']});
    await new Promise<void>((resolve,reject)=>{let output='';child!.stdout!.on('data',chunk=>{output+=String(chunk);if(output.includes('ready'))resolve();});child!.once('error',reject);});
    expect(()=>migrateFclSqliteOffline({stateRoot:root,quoteDocumentsPath:path,writersStopped:true})).toThrow(/document_v3_upgrade|fcl_upgrade|fcl_migration/);
    const probe=new DocumentStore(path);
    try{expect(probe.db.prepare('PRAGMA user_version').get()).toEqual({user_version:2});}finally{probe.close();}
  }finally{
    if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'close');}
    rmSync(root,{recursive:true,force:true});
  }
});
