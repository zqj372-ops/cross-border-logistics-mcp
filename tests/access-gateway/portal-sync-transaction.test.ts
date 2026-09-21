import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {expect,it} from 'vitest';
import {SyncTransactionGuard} from '../../services/access-gateway/portal/sync-transaction';

it('tracks begin/commit/rollback without reading the Node 22.13 absent isTransaction API',()=>{
  const root=mkdtempSync(join(tmpdir(),'portal-sync-transaction-')),db=new DatabaseSync(join(root,'state.sqlite'));
  try{
    db.exec('CREATE TABLE values_table(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
    const withoutIsTransaction={exec:(sql:string)=>db.exec(sql)} as unknown as DatabaseSync;
    const guard=new SyncTransactionGuard();
    guard.begin(withoutIsTransaction,'transaction_uncertain');
    db.prepare('INSERT INTO values_table VALUES(?,?)').run(1,'committed');
    guard.commit(withoutIsTransaction);
    expect(db.prepare('SELECT COUNT(*) AS n FROM values_table').get()).toEqual({n:1});

    guard.begin(withoutIsTransaction,'transaction_uncertain');
    db.prepare('INSERT INTO values_table VALUES(?,?)').run(2,'rolled-back');
    guard.rollbackOnFailure(withoutIsTransaction);
    expect(db.prepare('SELECT COUNT(*) AS n FROM values_table').get()).toEqual({n:1});
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

it('keeps a real commit when COMMIT reached SQLite and then throws locally',()=>{
  const root=mkdtempSync(join(tmpdir(),'portal-sync-commit-')),db=new DatabaseSync(join(root,'state.sqlite'));
  try{
    db.exec('CREATE TABLE values_table(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
    const guard=new SyncTransactionGuard(),original=db.exec.bind(db);
    let fired=false;
    db.exec=(sql:string)=>{
      const result=original(sql);
      if(sql==='COMMIT'&&!fired){fired=true;throw new Error('post-commit-transport');}
      return result;
    };
    guard.begin(db,'transaction_uncertain');
    db.prepare('INSERT INTO values_table VALUES(?,?)').run(1,'committed');
    expect(()=>guard.commit(db)).toThrow('post-commit-transport');
    guard.rollbackOnFailure(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM values_table').get()).toEqual({n:1});
    db.exec=original;
    guard.begin(db,'transaction_uncertain');
    db.prepare('INSERT INTO values_table VALUES(?,?)').run(2,'after-uncertain');
    guard.commit(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM values_table').get()).toEqual({n:2});
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

it('rolls back safely when COMMIT failed before SQLite committed the transaction',()=>{
  const root=mkdtempSync(join(tmpdir(),'portal-sync-uncertain-')),db=new DatabaseSync(join(root,'state.sqlite'));
  try{
    db.exec('CREATE TABLE values_table(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
    const guard=new SyncTransactionGuard(),original=db.exec.bind(db);
    db.exec=(sql:string)=>{if(sql==='COMMIT')throw new Error('pre-commit-failure');return original(sql);};
    guard.begin(db,'transaction_uncertain');
    db.prepare('INSERT INTO values_table VALUES(?,?)').run(1,'uncommitted');
    expect(()=>guard.commit(db)).toThrow('pre-commit-failure');
    guard.rollbackOnFailure(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM values_table').get()).toEqual({n:0});
    guard.begin(db,'transaction_uncertain');
    db.prepare('INSERT INTO values_table VALUES(?,?)').run(2,'recovered');
    db.exec=original;
    guard.commit(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM values_table').get()).toEqual({n:1});
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
