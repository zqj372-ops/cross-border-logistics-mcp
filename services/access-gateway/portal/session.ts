import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Membership, PortalIdentity } from "./contracts";
import type { PortalOidcTransaction } from "./identity";
import { openPortalProductionDatabase, securePortalDatabaseFiles } from "./production-persistence";

export const PORTAL_SESSION_COOKIE = "fc_portal_session";
export interface PortalSession {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly identity: PortalIdentity | null;
  readonly organizationId: string | null;
  readonly oidcTransaction: PortalOidcTransaction | null;
  readonly oidcExpiresAt?: number | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}
export interface PortalSessionStore {
  readonly kind: "memory" | "persistent";
  get(sessionId: string): PortalSession | null;
  put(session: PortalSession): void;
  delete(sessionId: string): void;
  replace?(sessionId:string,expectedCsrfToken:string,next:PortalSession):boolean;
  consumeOidc?(sessionId:string,state:string,now:number):PortalOidcTransaction|null;
}
export class InMemoryPortalSessionStore implements PortalSessionStore {
  readonly kind = "memory" as const;
  readonly #sessions = new Map<string, PortalSession>();
  get(sessionId: string): PortalSession | null { return this.#sessions.get(sessionId) ?? null; }
  put(session: PortalSession): void { this.#sessions.set(session.sessionId, session); }
  delete(sessionId: string): void { this.#sessions.delete(sessionId); }
  replace(sessionId:string,expectedCsrfToken:string,next:PortalSession):boolean{const current=this.#sessions.get(sessionId);if(!current||current.csrfToken!==expectedCsrfToken)return false;this.#sessions.set(sessionId,next);return true;}
  consumeOidc(sessionId:string,state:string,now:number):PortalOidcTransaction|null{const current=this.#sessions.get(sessionId);if(!current?.oidcTransaction||current.oidcTransaction.state!==state||(current.oidcExpiresAt??0)<=now)return null;this.#sessions.set(sessionId,Object.freeze({...current,oidcTransaction:null,oidcExpiresAt:null}));return current.oidcTransaction;}
}
export class SqlitePersistentPortalSessionStore implements PortalSessionStore{
  readonly kind="persistent" as const;readonly #database:DatabaseSync;readonly #path:string;
  constructor(options:{readonly databasePath:string}){this.#path=options.databasePath;this.#database=openPortalProductionDatabase(this.#path,"freightclaw-portal-sessions");this.#database.exec("CREATE TABLE IF NOT EXISTS portal_sessions(session_id TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS portal_sessions_expiry ON portal_sessions(expires_at)");securePortalDatabaseFiles(this.#path);}
  get(sessionId:string):PortalSession|null{const row=this.#database.prepare("SELECT payload FROM portal_sessions WHERE session_id=?").get(sessionId) as {payload:string}|undefined;return row?JSON.parse(row.payload) as PortalSession:null;}
  put(session:PortalSession):void{this.#database.prepare("INSERT INTO portal_sessions VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at").run(session.sessionId,JSON.stringify(session),session.expiresAt);securePortalDatabaseFiles(this.#path);}
  delete(sessionId:string):void{this.#database.prepare("DELETE FROM portal_sessions WHERE session_id=?").run(sessionId);}
  replace(sessionId:string,expectedCsrfToken:string,next:PortalSession):boolean{this.#database.exec("BEGIN IMMEDIATE");try{const row=this.#database.prepare("SELECT payload FROM portal_sessions WHERE session_id=?").get(sessionId) as {payload:string}|undefined;if(!row||(JSON.parse(row.payload) as PortalSession).csrfToken!==expectedCsrfToken){this.#database.exec("COMMIT");return false;}this.#database.prepare("UPDATE portal_sessions SET payload=?,expires_at=? WHERE session_id=?").run(JSON.stringify(next),next.expiresAt,sessionId);this.#database.exec("COMMIT");securePortalDatabaseFiles(this.#path);return true;}catch(error){this.#database.exec("ROLLBACK");throw error;}}
  consumeOidc(sessionId:string,state:string,now:number):PortalOidcTransaction|null{this.#database.exec("BEGIN IMMEDIATE");try{const row=this.#database.prepare("SELECT payload FROM portal_sessions WHERE session_id=?").get(sessionId) as {payload:string}|undefined;if(!row){this.#database.exec("COMMIT");return null;}const current=JSON.parse(row.payload) as PortalSession;if(!current.oidcTransaction||current.oidcTransaction.state!==state||(current.oidcExpiresAt??0)<=now){this.#database.exec("COMMIT");return null;}const next=Object.freeze({...current,oidcTransaction:null,oidcExpiresAt:null});this.#database.prepare("UPDATE portal_sessions SET payload=? WHERE session_id=?").run(JSON.stringify(next),sessionId);this.#database.exec("COMMIT");return current.oidcTransaction;}catch(error){this.#database.exec("ROLLBACK");throw error;}}
  close():void{this.#database.close();securePortalDatabaseFiles(this.#path);}
}
function token(): string { return randomBytes(32).toString("base64url"); }
export function parsePortalSessionCookie(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null;
  const matches = cookieHeader.split(";").map((item) => item.trim()).filter((item) => item.startsWith(`${PORTAL_SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(PORTAL_SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{32,128}$/u.test(value) ? value : null;
}
export class PortalSessionManager {
  readonly store: PortalSessionStore;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #secureCookie: boolean;
  constructor(options: { readonly store: PortalSessionStore; readonly now?: () => number; readonly ttlMs?: number; readonly secureCookie?: boolean }) {
    this.store = options.store; this.#now = options.now ?? Date.now; this.#ttlMs = options.ttlMs ?? 30 * 60_000; this.#secureCookie = options.secureCookie ?? true;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 60_000 || this.#ttlMs > 24 * 60 * 60_000) throw new Error("session_ttl_invalid");
  }
  #cookie(sessionId: string): string { return `${PORTAL_SESSION_COOKIE}=${sessionId}; Path=/console; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.#ttlMs / 1000)}${this.#secureCookie ? "; Secure" : ""}`; }
  #create(identity: PortalIdentity | null = null, organizationId: string | null = null): PortalSession {
    const now = this.#now(); const session = Object.freeze({ sessionId: token(), csrfToken: token(), identity, organizationId, oidcTransaction: null, oidcExpiresAt:null, createdAt: now, expiresAt: now + this.#ttlMs }); this.store.put(session); return session;
  }
  get(sessionId: string | null): PortalSession | null {
    if (!sessionId) return null; const session = this.store.get(sessionId); if (!session) return null;
    if (session.expiresAt <= this.#now()) { this.store.delete(sessionId); return null; }
    return session;
  }
  ensure(sessionId: string | null): { readonly session: PortalSession; readonly setCookie: string } {
    const existing = this.get(sessionId); if (existing) return { session: existing, setCookie: this.#cookie(existing.sessionId) };
    const session = this.#create(); return { session, setCookie: this.#cookie(session.sessionId) };
  }
  authenticate(sessionId: string, identity: PortalIdentity): { readonly session: PortalSession; readonly setCookie: string } {
    this.store.delete(sessionId); const session = this.#create(identity); return { session, setCookie: this.#cookie(session.sessionId) };
  }
  selectOrganization(sessionId: string, organizationId: string, memberships: readonly Membership[]): PortalSession {
    const current = this.get(sessionId); if (!current?.identity) throw new Error("authentication_required");
    const allowed = memberships.some((membership) => membership.userId === current.identity!.userId && membership.organizationId === organizationId && membership.status === "active");
    if (!allowed) throw new Error("organization_membership_required");
    const next = Object.freeze({ ...current, organizationId, csrfToken: token(), expiresAt: this.#now() + this.#ttlMs }); if(this.store.replace?!this.store.replace(sessionId,current.csrfToken,next):(this.store.put(next),false))throw new Error("session_conflict"); return next;
  }
  beginOidc(sessionId: string, transaction: PortalOidcTransaction): PortalSession {
    const current = this.get(sessionId); if (!current || current.identity) throw new Error("oidc_session_invalid");
    const now=this.#now(),next = Object.freeze({ ...current, oidcTransaction: transaction,oidcExpiresAt:now+5*60_000, csrfToken: token(), expiresAt: now + this.#ttlMs }); if(this.store.replace?!this.store.replace(sessionId,current.csrfToken,next):(this.store.put(next),false))throw new Error("session_conflict"); return next;
  }
  consumeOidc(sessionId: string, state: string): PortalOidcTransaction {
    const consumed=this.store.consumeOidc?.(sessionId,state,this.#now());if(consumed)return consumed;
    if(this.store.consumeOidc)throw new Error("oidc_state_invalid");const current = this.get(sessionId); if (!current?.oidcTransaction || current.oidcTransaction.state !== state||(current.oidcExpiresAt??0)<=this.#now()) throw new Error("oidc_state_invalid");
    this.store.put(Object.freeze({ ...current, oidcTransaction: null,oidcExpiresAt:null })); return current.oidcTransaction;
  }
  logout(sessionId: string): { readonly session: PortalSession; readonly setCookie: string } { this.store.delete(sessionId); const session = this.#create(); return { session, setCookie: this.#cookie(session.sessionId) }; }
  verifyCsrf(session: PortalSession, supplied: string | undefined): boolean {
    if (typeof supplied !== "string") return false;
    const expected=Buffer.from(session.csrfToken); const actual=Buffer.from(supplied);
    return expected.length===actual.length&&timingSafeEqual(expected,actual);
  }
  cookieFor(session: PortalSession): string { return this.#cookie(session.sessionId); }
}
