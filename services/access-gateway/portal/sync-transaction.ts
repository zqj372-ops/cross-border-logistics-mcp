import type {DatabaseSync} from 'node:sqlite';

type TransactionState='idle'|'open'|'uncertain';

/**
 * Tracks synchronous SQLite transactions without relying on DatabaseSync.isTransaction,
 * which is absent in the pinned Node 22.13 runtime.
 */
export class SyncTransactionGuard{
  private state:TransactionState='idle';
  private owner:DatabaseSync|null=null;

  get isOpen():boolean{return this.state==='open';}

  begin(db:DatabaseSync,uncertainCode:string):void{
    if(this.state==='open')throw new Error('transaction_already_open');
    if(this.state==='uncertain'&&this.owner!==db)throw new Error(uncertainCode);
    try{
      db.exec('BEGIN IMMEDIATE');
    }catch(error){
      if(this.state==='uncertain')throw new Error(uncertainCode,{cause:error});
      throw error;
    }
    this.state='open';
    this.owner=db;
  }

  commit(db:DatabaseSync):void{
    if(this.state!=='open'||this.owner!==db)throw new Error('transaction_not_open');
    db.exec('COMMIT');
    this.state='idle';
    this.owner=null;
  }

  rollbackOnFailure(db:DatabaseSync):void{
    if(this.state!=='open'||this.owner!==db)return;
    try{
      db.exec('ROLLBACK');
      this.state='idle';
      this.owner=null;
    }catch{
      this.state='uncertain';
    }
  }
}
