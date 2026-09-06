import type { Pool } from "pg";
import { createPostgresPool, postgresQualifiedTable, type PostgresGatewayConfiguration } from "../postgres-store";
import { callEventSchema, projectCallPage, type CallEvent, type CallAccessScope, type CallQuery, type CallLogRepository } from "./call-log";

export class PostgresCallLogStore implements CallLogRepository {
  readonly #pool:Pool;
  readonly #table:string;
  private constructor(configuration:PostgresGatewayConfiguration,readonly maximum=10_000,readonly now=Date.now){
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100_000)throw new Error("call_log_limit_invalid");
    this.#pool=createPostgresPool(configuration);this.#table=postgresQualifiedTable(configuration.schema,"portal_call_events");
  }
  static async open(configuration:PostgresGatewayConfiguration,options:{initialize?:boolean;maximum?:number;now?:()=>number}={}){
    const store=new PostgresCallLogStore(configuration,options.maximum,options.now);
    try {
      if(options.initialize)await store.#pool.query(`CREATE TABLE IF NOT EXISTS ${store.#table}(event_id text PRIMARY KEY,tenant_id text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL); CREATE INDEX IF NOT EXISTS portal_call_events_scope ON ${store.#table}(tenant_id,created_at DESC,event_id DESC); CREATE INDEX IF NOT EXISTS portal_call_events_expiry ON ${store.#table}(created_at)`);
      await store.#pool.query(`SELECT event_id FROM ${store.#table} LIMIT 1`);return store;
    }catch{await store.close();throw new Error("call_log_unavailable");}
  }
  async append(input:CallEvent){
    const parsed=callEventSchema.safeParse(input);if(!parsed.success)throw new Error("call_event_invalid");
    const event={...parsed.data,created_at:new Date(parsed.data.created_at).toISOString()};
    if(Date.parse(event.created_at)>this.now()+30_000)throw new Error("call_log_timestamp_invalid");
    const client=await this.#pool.connect();
    try {
      await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`portal-calls:${event.tenant_id}`]);
      const existing=await client.query<{payload:CallEvent}>(`SELECT payload FROM ${this.#table} WHERE event_id=$1`,[event.event_id]);
      if(existing.rowCount&&JSON.stringify(callEventSchema.parse(existing.rows[0]!.payload))!==JSON.stringify(event))throw new Error("call_log_event_conflict");
      await client.query(`INSERT INTO ${this.#table} VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,[event.event_id,event.tenant_id,JSON.stringify(event),event.created_at]);
      await client.query(`DELETE FROM ${this.#table} WHERE created_at<$1`,[new Date(this.now()-30*86_400_000).toISOString()]);
      await client.query(`DELETE FROM ${this.#table} WHERE tenant_id=$1 AND event_id NOT IN(SELECT event_id FROM ${this.#table} WHERE tenant_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT $2)`,[event.tenant_id,this.maximum]);
      await client.query("COMMIT");
    }catch{await client.query("ROLLBACK").catch(()=>undefined);throw new Error("call_log_unavailable");}finally{client.release();}
  }
  async query(scope:CallAccessScope,query:CallQuery){
    const rows=await this.#pool.query<{payload:CallEvent}>(`SELECT payload FROM ${this.#table} WHERE tenant_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT $2`,[scope.tenantId,this.maximum]);
    return projectCallPage(rows.rows.map(row=>callEventSchema.parse(row.payload)),scope,query,this.maximum,this.now());
  }
  async health(){try{await this.#pool.query(`SELECT event_id FROM ${this.#table} LIMIT 1`);return{ready:true};}catch{return{ready:false};}}
  async close(){await this.#pool.end();}
}
