import {mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {expect,it} from 'vitest';
import {CaseStore,CaseService} from '../../services/access-gateway/portal/cases';
import {migrateFclSqliteOffline} from '../../deploy/scripts/migrate-fcl-sqlite-offline';
import {receiver,readyFixture,closeFixture} from '../quote-documents/fixtures/fcl-execution';

it('requires exclusive offline migration, preserves legacy facts, and rejects an old reader after upgrade',async()=>{
  const f=await readyFixture(),root=mkdtempSync(join(tmpdir(),'fcl-execution-migration-')),path=join(root,'business-cases.sqlite');
  try{
    const old=new CaseStore(path,{fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}});
    const cases=new CaseService(old,f.caseService.portal,{receiverUserId:receiver.identity.userId,receiverIsActive:()=>true,credentialSecret:'synthetic-migration-secret-32-bytes',credentialTtlDays:30});
    await cases.createPersonalFclInquiry(receiver,f.confirmed.current_input,'migration-intake-0001');
    const before=old.db.prepare('SELECT * FROM business_cases').all();old.close();
    const backup=join(root,'before.sqlite');copyFileSync(path,backup);
    expect(()=>new CaseStore(path,{fcl:{mode:'reopen'},execution:{mode:'reopen'}})).toThrow('schema_not_upgraded');
    expect(()=>migrateFclSqliteOffline({stateRoot:root,writersStopped:false,execution:true})).toThrow('writers_must_be_stopped');
    expect(()=>migrateFclSqliteOffline({stateRoot:root,writersStopped:true,execution:true,exclusiveCheck:()=>{throw new Error('writer_open');}})).toThrow('writer_open');
    const result=migrateFclSqliteOffline({stateRoot:root,writersStopped:true,execution:true,exclusiveCheck:()=>undefined});
    expect(result.case_version).toBe(3);
    const current=new CaseStore(path,{fcl:{mode:'reopen'},execution:{mode:'reopen'}});
    expect(current.db.prepare('SELECT * FROM business_cases').all()).toEqual(before);
    expect(current.db.prepare('SELECT count(*) n FROM fcl_case_progress').get()).toEqual({n:0});
    expect(current.db.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});current.close();
    expect(()=>new CaseStore(path,{fcl:{mode:'reopen'}})).toThrow();
    expect(migrateFclSqliteOffline({stateRoot:root,writersStopped:true,execution:true,exclusiveCheck:()=>undefined}).status).toBe('already_migrated');
    const malformed=new DatabaseSync(path);malformed.exec('DROP INDEX fcl_execution_dispatch; CREATE INDEX fcl_execution_dispatch ON fcl_execution_outbox(audience)');malformed.close();
    expect(()=>new CaseStore(path,{fcl:{mode:'reopen'},execution:{mode:'reopen'}})).toThrow('fcl_execution_schema_incompatible');
    // Restore the pre-upgrade backup into a separate disposable path, not by downgrading v3.
    const restoredPath=join(root,'restored.sqlite');copyFileSync(backup,restoredPath);
    const restored=new CaseStore(restoredPath,{fcl:{mode:'reopen'}});expect(restored.db.prepare('SELECT * FROM business_cases').all()).toEqual(before);restored.close();
  }finally{closeFixture(f);rmSync(root,{recursive:true,force:true});}
});
