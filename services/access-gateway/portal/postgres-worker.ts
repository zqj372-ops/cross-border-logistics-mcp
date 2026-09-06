import { parentPort, workerData } from "node:worker_threads";
import type { PoolClient } from "pg";
import { createPostgresPool, postgresQualifiedTable, type PostgresGatewayConfiguration } from "../postgres-store";

// The worker owns all sockets. The existing synchronous control-plane mutation
// callbacks run only between BEGIN and COMMIT; they must never await I/O.
const configuration = workerData as PostgresGatewayConfiguration;
const pool = createPostgresPool(configuration);
pool.options.application_name="freightclaw-portal-shared";
const table = (name: string) => postgresQualifiedTable(configuration.schema, name);
let transaction: PoolClient | undefined;
type Command = { op: "init" | "read" | "begin" | "commit" | "rollback" | "session-get" | "session-put" | "session-delete" | "session-replace" | "session-consume";
  initialize?: boolean; kind?: string; action?: string; key?: string; hash?: string; data?: unknown; result?: unknown; id?: string; csrf?: string; state?: string; now?: number; expires?: number };
async function execute(c: Command): Promise<unknown> {
  const query = (sql: string, values?: unknown[]) => (transaction ?? pool).query<{payload:unknown;value:unknown}>(sql, values);
  if (c.op === "init") {
    if(!c.initialize){const result=await pool.query<{version:number}>(`SELECT version FROM ${table("portal_shared_meta")}`);if(result.rows[0]?.version!==1)throw new Error("portal_shared_schema_unsupported");await pool.query(`SELECT kind FROM ${table("portal_shared_state")} LIMIT 1`);return true;}
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${configuration.schema}:portal-schema-v1`]);
      await client.query(`CREATE TABLE IF NOT EXISTS ${table("portal_shared_meta")}(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL)`);
      await client.query(`INSERT INTO ${table("portal_shared_meta")} VALUES(true,1) ON CONFLICT DO NOTHING`);
      const meta = await client.query<{version:number}>(`SELECT version FROM ${table("portal_shared_meta")}`);
      if(meta.rows[0]?.version!==1) throw new Error("portal_shared_schema_unsupported");
      await client.query(`CREATE TABLE IF NOT EXISTS ${table("portal_shared_state")}(kind text PRIMARY KEY CHECK(kind IN ('portal','business')),payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS ${table("portal_shared_idempotency")}(kind text NOT NULL,action text NOT NULL,key text NOT NULL,hash text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(kind,action,key));
CREATE TABLE IF NOT EXISTS ${table("portal_shared_sessions")}(id text PRIMARY KEY,payload jsonb NOT NULL,expires bigint NOT NULL);
CREATE INDEX IF NOT EXISTS portal_shared_sessions_expiry ON ${table("portal_shared_sessions")}(expires)`);
      await client.query(`INSERT INTO ${table("portal_shared_state")} VALUES('portal',$1::jsonb),('business',$2::jsonb) ON CONFLICT DO NOTHING`,[
        JSON.stringify({users:[],organizations:[],memberships:[],invitations:[],applications:[],requests:[],grants:[],operations:[]}), JSON.stringify({requests:[],grants:[],credentials:[],audit:[]}),
      ]);
      await client.query("COMMIT");
    } catch(error) {await client.query("ROLLBACK").catch(()=>undefined);throw error;} finally {client.release();}
    return true;
  }
  if (c.op === "read") return (await query(`SELECT payload FROM ${table("portal_shared_state")} WHERE kind=$1`,[c.kind])).rows[0]?.payload;
  if (c.op === "begin") {
    if(transaction) throw new Error("portal_shared_transaction_reentrant");
    transaction=await pool.connect();await transaction.query("BEGIN");
    const row=await transaction.query<{payload:unknown}>(`SELECT payload FROM ${table("portal_shared_state")} WHERE kind=$1 FOR UPDATE`,[c.kind]);
    if(row.rowCount!==1) throw new Error("portal_shared_store_unavailable");
    if(c.key!==undefined){
      const prior=await transaction.query<{hash:string;result:unknown}>(`SELECT hash,result FROM ${table("portal_shared_idempotency")} WHERE kind=$1 AND action=$2 AND key=$3`,[c.kind,c.action,c.key]);
      if(prior.rowCount){if(prior.rows[0]!.hash!==c.hash)throw new Error("idempotency_conflict");await transaction.query("COMMIT");transaction.release();transaction=undefined;return {replayed:true,result:prior.rows[0]!.result};}
    }
    return {replayed:false,data:row.rows[0]!.payload};
  }
  if(c.op === "commit") {
    if(!transaction)throw new Error("portal_shared_store_unavailable");
    await transaction.query(`UPDATE ${table("portal_shared_state")} SET payload=$2::jsonb WHERE kind=$1`,[c.kind,JSON.stringify(c.data)]);
    if(c.key!==undefined)await transaction.query(`INSERT INTO ${table("portal_shared_idempotency")} VALUES($1,$2,$3,$4,$5::jsonb)`,[c.kind,c.action,c.key,c.hash,JSON.stringify(c.result)]);
    await transaction.query("COMMIT");transaction.release();transaction=undefined;return true;
  }
  if(c.op === "rollback") {if(transaction){await transaction.query("ROLLBACK");transaction.release();transaction=undefined;}return true;}
  if(c.op === "session-get")return (await query(`SELECT payload FROM ${table("portal_shared_sessions")} WHERE id=$1`,[c.id])).rows[0]?.payload ?? null;
  if(c.op === "session-put") {await query(`INSERT INTO ${table("portal_shared_sessions")} VALUES($1,$2::jsonb,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires`,[c.id,JSON.stringify(c.data),c.expires]);await query(`DELETE FROM ${table("portal_shared_sessions")} WHERE expires<$1`,[Date.now()]);return true;}
  if(c.op === "session-delete") {await query(`DELETE FROM ${table("portal_shared_sessions")} WHERE id=$1`,[c.id]);return true;}
  if(c.op === "session-replace")return (await query(`UPDATE ${table("portal_shared_sessions")} SET payload=$3::jsonb,expires=$4 WHERE id=$1 AND payload->>'csrfToken'=$2`,[c.id,c.csrf,JSON.stringify(c.data),c.expires])).rowCount===1;
  if(c.op === "session-consume") {
    // A single statement both claims and consumes OIDC state across replicas.
    const result=await query(`WITH current AS (SELECT id,payload->'oidcTransaction' AS value FROM ${table("portal_shared_sessions")} WHERE id=$1 AND payload->'oidcTransaction'->>'state'=$2 AND (payload->>'oidcExpiresAt')::bigint>$3 AND expires>$3 FOR UPDATE)
UPDATE ${table("portal_shared_sessions")} s SET payload=jsonb_set(jsonb_set(s.payload,'{oidcTransaction}','null'::jsonb),'{oidcExpiresAt}','null'::jsonb) FROM current WHERE s.id=current.id RETURNING current.value`,[c.id,c.state,c.now]);
    return result.rows[0]?.value ?? null;
  }
  throw new Error("portal_shared_command_invalid");
}
let queue=Promise.resolve();
parentPort!.on("message",(request:{command:Command;buffer:SharedArrayBuffer})=>{
  queue=queue.then(async()=>{
    const control=new Int32Array(request.buffer,0,2), output=new Uint8Array(request.buffer,8);
    let body: {ok:boolean;value?:unknown;code?:string};
    try {body={ok:true,value:await execute(request.command)};}
    catch(error){if(transaction){await transaction.query("ROLLBACK").catch(()=>undefined);transaction.release(true);transaction=undefined;}body={ok:false,code:error instanceof Error&&["idempotency_conflict","portal_shared_schema_unsupported","portal_shared_transaction_reentrant"].includes(error.message)?error.message:"portal_shared_store_unavailable"};}
    let encoded=Buffer.from(JSON.stringify(body));
    if(encoded.length>output.length)encoded=Buffer.from(JSON.stringify({ok:false,code:"portal_shared_payload_limit"}));
    output.set(encoded);Atomics.store(control,1,encoded.length);Atomics.store(control,0,1);Atomics.notify(control,0);
  });
});
