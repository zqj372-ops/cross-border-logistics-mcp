import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { APPLICATION_MCP_TOOLS } from "../../../src/logistics_mcp/platform/application-tools";
import { ENVELOPE_STATUSES } from "../../../src/logistics_mcp/platform/envelope";
import type { DurableAuditRepository } from "../../../src/logistics_mcp/platform/dependencies";
import { openPortalProductionDatabase, securePortalDatabaseFiles } from "./production-persistence";
import type { PortalContext } from "./contracts";
import { PortalError } from "./contracts";
import type { PortalService } from "./service";

const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
export const callEventSchema = z.object({ event_id: ref, tenant_id: ref, client_id: ref.nullable(), actor_ref: ref,
  operation: z.enum(APPLICATION_MCP_TOOLS), request_id: ref, status: z.enum(ENVELOPE_STATUSES),
  duration_ms: z.number().int().min(0).max(86_400_000), created_at: z.string().datetime({ offset: true }),
}).strict();
export type CallEvent = z.infer<typeof callEventSchema>;
export const callQuerySchema = z.object({ application_id: ref.optional(), operation: z.enum(APPLICATION_MCP_TOOLS).optional(),
  status: z.enum(ENVELOPE_STATUSES).optional(), from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(), cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export type CallQuery = z.infer<typeof callQuerySchema>;
export interface CallAccessScope { tenantId: string; clientIds: readonly string[]; actorRef: string; allPersonnel: boolean; includePersonnel: boolean }
export interface CallPage { events: readonly CallEvent[]; next_cursor: string | null;
  summary: { total: number; status_counts: Record<typeof ENVELOPE_STATUSES[number], number>; average_duration_ms: number };
  window: { from: string; to: string; retention_days: number; maximum_events_per_tenant: number };
}
export interface CallLogRepository { append(event: CallEvent): Promise<void>; query(scope: CallAccessScope, query: CallQuery): Promise<CallPage>; health(): Promise<{ ready: boolean }>; close(): Promise<void> }
export type CallRecorder = (event: Omit<CallEvent, "event_id" | "created_at">) => Promise<void>;

export class SqliteCallLogStore implements CallLogRepository {
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(readonly databasePath: string, readonly maximumEventsPerTenant = 10_000, readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(maximumEventsPerTenant) || maximumEventsPerTenant < 1 || maximumEventsPerTenant > 100_000) throw new Error("call_log_limit_invalid");
    this.#db = openPortalProductionDatabase(databasePath, "freightclaw-call-log");
    this.#db.exec("CREATE TABLE IF NOT EXISTS portal_call_events(event_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,client_id TEXT,actor_ref TEXT NOT NULL,operation TEXT NOT NULL,request_id TEXT NOT NULL,status TEXT NOT NULL,duration_ms INTEGER NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS portal_call_events_scope ON portal_call_events(tenant_id,created_at DESC,event_id DESC); CREATE INDEX IF NOT EXISTS portal_call_events_expiry ON portal_call_events(created_at)");
    securePortalDatabaseFiles(databasePath);
  }
  append(input: CallEvent): Promise<void> {
    const parsed = callEventSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error("call_event_invalid"));
    const event = { ...parsed.data, created_at: new Date(parsed.data.created_at).toISOString() };
    if (Date.parse(event.created_at) > this.now()+30_000) return Promise.reject(new Error("call_log_timestamp_invalid"));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#db.prepare("SELECT * FROM portal_call_events WHERE event_id=?").get(event.event_id);
      if (prior && JSON.stringify(callEventSchema.parse(prior)) !== JSON.stringify(event)) throw new Error("call_log_event_conflict");
      this.#db.prepare("INSERT OR IGNORE INTO portal_call_events VALUES(?,?,?,?,?,?,?,?,?)").run(event.event_id,event.tenant_id,event.client_id,event.actor_ref,event.operation,event.request_id,event.status,event.duration_ms,event.created_at);
      this.#db.prepare("DELETE FROM portal_call_events WHERE created_at < ?").run(new Date(this.now()-30*86_400_000).toISOString());
      this.#db.prepare("DELETE FROM portal_call_events WHERE tenant_id=? AND event_id NOT IN (SELECT event_id FROM portal_call_events WHERE tenant_id=? ORDER BY created_at DESC,event_id DESC LIMIT ?)").run(event.tenant_id,event.tenant_id,this.maximumEventsPerTenant);
      this.#db.exec("COMMIT");
      return Promise.resolve();
    } catch (error) { this.#db.exec("ROLLBACK"); return Promise.reject(error instanceof Error ? error : new Error("call_log_unavailable")); }
  }
  query(scope: CallAccessScope, query: CallQuery): Promise<CallPage> {
    const events=this.#db.prepare("SELECT * FROM portal_call_events WHERE tenant_id=? ORDER BY created_at DESC,event_id DESC LIMIT ?").all(scope.tenantId,this.maximumEventsPerTenant).map(value=>callEventSchema.parse(value));
    return Promise.resolve(projectCallPage(events,scope,query,this.maximumEventsPerTenant,this.now()));
  }
  health(): Promise<{ ready: boolean }> { try { this.#db.prepare("SELECT event_id FROM portal_call_events LIMIT 1").get(); return Promise.resolve({ready:true}); } catch { return Promise.resolve({ready:false}); } }
  close(): Promise<void> { if (this.#closed) return Promise.resolve(); this.#closed = true; this.#db.close(); securePortalDatabaseFiles(this.databasePath); return Promise.resolve(); }
}

export function projectCallPage(input: readonly CallEvent[], scope: CallAccessScope, query: CallQuery, maximum: number, now: number): CallPage {
  query=callQuerySchema.parse(query);
  const requestedFrom=Date.parse(query.from??new Date(now-86_400_000).toISOString()), until=Date.parse(query.to??new Date(now).toISOString());
  if(requestedFrom>=until||until-requestedFrom>30*86_400_000||scope.clientIds.length>1000)throw new PortalError("call_query_bounds_invalid");
  const from=new Date(Math.max(requestedFrom,now-30*86_400_000)).toISOString(),to=new Date(until).toISOString();
  const matching=input.filter(event=>event.tenant_id===scope.tenantId&&(event.client_id===null?scope.includePersonnel&&(scope.allPersonnel||event.actor_ref===scope.actorRef):scope.clientIds.includes(event.client_id))&&event.created_at>=from&&event.created_at<=to&&(!query.operation||event.operation===query.operation)&&(!query.status||event.status===query.status)).sort((a,b)=>a.created_at!==b.created_at?(a.created_at<b.created_at?1:-1):a.event_id<b.event_id?1:a.event_id>b.event_id?-1:0);
  const counts=Object.fromEntries(ENVELOPE_STATUSES.map(status=>[status,matching.filter(event=>event.status===status).length])) as CallPage["summary"]["status_counts"];
  let events=matching;
  if(query.cursor){const cursor=z.object({at:z.string().datetime(),id:ref}).strict().parse(JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8")) as unknown);events=events.filter(event=>event.created_at<cursor.at||event.created_at===cursor.at&&event.event_id<cursor.id);}
  const page=events.slice(0,query.limit),last=page.at(-1);
  return {events:page,next_cursor:events.length>page.length&&last?Buffer.from(JSON.stringify({at:last.created_at,id:last.event_id})).toString("base64url"):null,summary:{total:matching.length,status_counts:counts,average_duration_ms:matching.length?Math.round(matching.reduce((n,e)=>n+e.duration_ms,0)/matching.length):0},window:{from,to,retention_days:30,maximum_events_per_tenant:maximum}};
}

export class PortalCallLogService {
  constructor(readonly repository: CallLogRepository, readonly portal: Pick<PortalService,"getState">) {}
  async query(ctx: PortalContext, input: unknown) {
    const parsed = callQuerySchema.safeParse(input);
    if (!parsed.success) throw new PortalError("call_query_invalid");
    const state = this.portal.getState(ctx).data;
    const org = state?.current_organization;
    const member = state?.memberships.find(value => value.organizationId === org?.organizationId && value.userId === ctx.identity.userId && value.status === "active");
    if (!org || org.status !== "active" || !member || ctx.identity.platformRole !== null) throw new PortalError("business_access_denied");
    const applications = state.applications.filter(value => value.organizationId === org.organizationId && (!parsed.data.application_id || value.applicationId === parsed.data.application_id));
    if (parsed.data.application_id && applications.length !== 1) throw new PortalError("application_access_denied");
    const data = await this.repository.query({ tenantId: org.tenantId, clientIds: applications.map(value => value.clientId), actorRef: ctx.identity.userId,
      includePersonnel: !parsed.data.application_id, allPersonnel: !parsed.data.application_id && (member.role === "owner" || member.role === "admin"),
    }, parsed.data);
    return { schema_version: "portal-call-log@2026-09-06.v1", status: "success", data, reason_codes: [] };
  }
}

export function callRecorder(repository: CallLogRepository): CallRecorder {
  return event => repository.append({ ...event, event_id: `call_${randomUUID()}`, created_at: new Date().toISOString() });
}

export function withCallLogAudit(audit: DurableAuditRepository, calls: CallLogRepository): DurableAuditRepository {
  return { durability: "durable", async append(event) {
    await audit.append(event);
    if (!(APPLICATION_MCP_TOOLS as readonly string[]).includes(event.tool) || event.tenant_id === "tenant_unknown") return;
    await calls.append({ event_id: event.audit_id, tenant_id: event.tenant_id, client_id: event.client_id, actor_ref: event.actor_id,
      operation: event.tool as CallEvent["operation"], request_id: event.request_id, status: event.status, duration_ms: event.duration_ms, created_at: new Date().toISOString() });
  }, list: () => audit.list(), health: async () => ({ready:(await audit.health()).ready && (await calls.health()).ready}), close: () => Promise.all([audit.close(), calls.close()]).then(() => undefined) };
}
