import { DatabaseSync } from "node:sqlite";
import type { AccessRequest, Application, Grant, Invitation, Membership, Organization, PortalOperation, PortalUser } from "./contracts";
import { openPortalProductionDatabase, securePortalDatabaseFiles } from "./production-persistence";

export interface PortalData { users: PortalUser[]; organizations: Organization[]; memberships: Membership[]; invitations: Invitation[]; applications: Application[]; requests: AccessRequest[]; grants: Grant[]; operations: PortalOperation[] }
export interface PortalRepository {
  readonly kind: "synthetic" | "production";
  read(): PortalData;
  transact<T>(action: string, idempotencyKey: string, requestHash: string, mutate: (data: PortalData) => T): T;
  close(): void;
}

const EMPTY: PortalData = { users: [], organizations: [], memberships: [], invitations: [], applications: [], requests: [], grants: [], operations: [] };
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validKey(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(value); }

export class SqliteSyntheticPortalStore implements PortalRepository {
  readonly kind = "synthetic" as const;
  readonly #database: DatabaseSync;
  constructor(options: { readonly databasePath: string }) {
    this.#database = new DatabaseSync(options.databasePath);
    this.#database.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS portal_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS portal_idempotency(action TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(action,idempotency_key));`);
    this.#database.prepare("INSERT OR IGNORE INTO portal_state(singleton,payload) VALUES(1,?)").run(JSON.stringify(EMPTY));
  }
  read(): PortalData { return clone(JSON.parse(String(this.#database.prepare("SELECT payload FROM portal_state WHERE singleton=1").get()!.payload)) as PortalData); }
  transact<T>(action: string, idempotencyKey: string, requestHash: string, mutate: (data: PortalData) => T): T {
    if (!validKey(idempotencyKey)) throw new Error("idempotency_key_invalid");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#database.prepare("SELECT request_hash,result_json FROM portal_idempotency WHERE action=? AND idempotency_key=?").get(action,idempotencyKey) as {request_hash:string;result_json:string}|undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) throw new Error("idempotency_conflict");
        this.#database.exec("COMMIT");
        return clone(JSON.parse(prior.result_json) as T);
      }
      const data = this.read();
      const result = mutate(data);
      this.#database.prepare("UPDATE portal_state SET payload=? WHERE singleton=1").run(JSON.stringify(data));
      this.#database.prepare("INSERT INTO portal_idempotency VALUES(?,?,?,?)").run(action,idempotencyKey,requestHash,JSON.stringify(result));
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.#database.close(); }
}

export class UnavailablePortalRepository implements PortalRepository {
  readonly kind = "production" as const;
  read(): never { throw new Error("portal_store_unavailable"); }
  transact<T>(): T { throw new Error("portal_store_unavailable"); }
  close(): void {}
}

export class SqliteProductionPortalStore implements PortalRepository {
  readonly kind="production" as const;readonly #database:DatabaseSync;readonly #path:string;
  constructor(options:{readonly databasePath:string}){this.#path=options.databasePath;this.#database=openPortalProductionDatabase(this.#path,"freightclaw-portal");this.#database.exec(`CREATE TABLE IF NOT EXISTS portal_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS portal_idempotency(action TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(action,idempotency_key));`);this.#database.prepare("INSERT OR IGNORE INTO portal_state VALUES(1,?)").run(JSON.stringify(EMPTY));securePortalDatabaseFiles(this.#path);}
  read():PortalData{return clone(JSON.parse(String(this.#database.prepare("SELECT payload FROM portal_state WHERE singleton=1").get()!.payload)) as PortalData);}
  transact<T>(action:string,idempotencyKey:string,requestHash:string,mutate:(data:PortalData)=>T):T{if(!validKey(idempotencyKey))throw new Error("idempotency_key_invalid");this.#database.exec("BEGIN IMMEDIATE");try{const prior=this.#database.prepare("SELECT request_hash,result_json FROM portal_idempotency WHERE action=? AND idempotency_key=?").get(action,idempotencyKey) as {request_hash:string;result_json:string}|undefined;if(prior){if(prior.request_hash!==requestHash)throw new Error("idempotency_conflict");this.#database.exec("COMMIT");return clone(JSON.parse(prior.result_json) as T);}const data=this.read(),result=mutate(data);this.#database.prepare("UPDATE portal_state SET payload=? WHERE singleton=1").run(JSON.stringify(data));this.#database.prepare("INSERT INTO portal_idempotency VALUES(?,?,?,?)").run(action,idempotencyKey,requestHash,JSON.stringify(result));this.#database.exec("COMMIT");securePortalDatabaseFiles(this.#path);return clone(result);}catch(error){this.#database.exec("ROLLBACK");throw error;}}
  close():void{this.#database.close();securePortalDatabaseFiles(this.#path);}
}
