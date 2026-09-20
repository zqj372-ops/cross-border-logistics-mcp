import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  buildFclInquirySummary,
  fclInquirySchema,
  type FclInquiryInput,
} from '../../../apps/inquiry/fcl-model';
import type { Draft } from '../../../apps/inquiry/model';
import { PortalError, type PortalContext } from './contracts';
import type { PortalService } from './service';
import { openPortalProductionDatabase, securePortalDatabaseFiles } from './production-persistence';
import {
  caseInputSchema,
  caseUpdateSchema,
  caseReplySchema,
  caseListSchema,
  fclCaseEventSchema,
  fclCaseInternalViewSchema,
  fclCaseListSchema,
  fclCaseNotificationSchema,
  fclCasePublicSummarySchema,
  fclCaseSubmissionSchema,
  type FCL_NOTIFICATION_STATUSES,
  type CaseStatus,
} from './case-contracts';
export {
  CASE_VERSION,
  CASE_STATUSES,
  CASE_LINK_VERSION,
  CASE_V2_VERSION,
  caseInputSchema,
  caseUpdateSchema,
  caseReplySchema,
  caseListSchema,
  caseViewSchema,
  caseResponseSchema,
  caseReviewContextSchema,
  caseViewV2Schema,
  caseResponseV2Schema,
  FCL_CASE_VERSION,
  FCL_NOTIFICATION_STATUSES,
  fclCaseInputSchema,
  fclCaseEventSchema,
  fclCaseNotificationSchema,
  fclCaseSubmissionSchema,
  fclCaseInternalViewSchema,
  fclCasePublicSummarySchema,
  fclCaseListSchema,
  fclCaseSuccessEnvelopeSchema,
  fclCaseErrorEnvelopeSchema,
} from './case-contracts';

type Scope = { user: string; org: string | null; manager: boolean; platform: boolean };
type Row = { case_id: string; owner_id: string; organization_id: string | null; status: CaseStatus; version: number; input_json: string; created_at: string; updated_at: string };
type Event = { event_id: string; version: number; status: CaseStatus; message: string; visibility: 'customer' | 'internal'; actor_label: string; created_at: string };
type EventWithActor = Event & { actor_id: string; rowid: number };
type NotificationStatus = typeof FCL_NOTIFICATION_STATUSES[number];
type FclRow = {
  fcl_inquiry_id: string;
  inquiry_no: string;
  case_id: string;
  inquiry_date: string;
  daily_sequence: number;
  original_payload_json: string;
  original_payload_digest: string;
  submission_session_hash: string;
  receiver_user_id: string;
  credential_hash: string;
  credential_expires_at: string;
  notification_status: NotificationStatus;
  notification_reason: string | null;
  notification_attempted_at: string | null;
  created_at: string;
};
type FclEventRow = {
  event_id: string;
  version: number;
  status: CaseStatus;
  message: string;
  visibility: 'customer' | 'internal';
  actor_label: string;
  created_at: string;
  event_kind: string;
  payload_json: string;
  actor_id: string;
};
export type CaseView = { case_id: string; status: CaseStatus; version: number; input: Draft; created_at: string; updated_at: string; can_manage: boolean; can_reply: boolean; events: Event[] };
export type CaseViewV2 = CaseView & { review_context: { latest_customer_supplement_ref: string | null } };
export type QuoteLinkCaseRead = { case_ref: string; owner_id: string; organization_id: string | null; status: CaseStatus; version: number; latest_customer_supplement_ref: string | null };
export type FclMailMessage = {
  to: string;
  cc: string[];
  subject: string;
  body: string;
};
export type FclMailTransport = {
  send(message: FclMailMessage): Promise<void> | void;
};
export type CaseStoreOptions = {
  fcl?:
    | { mode: 'fresh_fixture'; authorized: true; oldWritersStopped: true }
    | { mode: 'exclusive_verified'; authorized: true; oldWritersStopped: true; assertExclusive: () => void }
    | { mode: 'reopen' };
};
export type FclCaseServiceOptions = {
  receiverUserId: string;
  receiverIsActive: (userId: string) => boolean;
  credentialSecret: string | Uint8Array;
  credentialTtlDays: number;
  now?: () => string;
  mail?: {
    enabled?: boolean;
    recipient?: string;
    cc?: readonly string[];
    transport?: FclMailTransport;
    timeoutMs?: number;
  };
};
type NormalizedFclOptions = {
  receiverUserId: string;
  receiverIsActive: (userId: string) => boolean;
  credentialSecret: Buffer;
  credentialTtlDays: number;
  now: () => string;
  mail: {
    enabled: boolean;
    recipient: string | null;
    cc: string[];
    transport: FclMailTransport | undefined;
    timeoutMs: number;
    configurationReason: string | null;
  };
};
type FclCaseSubmission = z.infer<typeof fclCaseSubmissionSchema>;
type FclCaseInternalView = z.infer<typeof fclCaseInternalViewSchema>;
type FclCasePublicSummary = z.infer<typeof fclCasePublicSummarySchema>;

const CASE_SCHEMA_VERSION = 2;
const parse = <T>(schema: z.ZodType<T>, input: unknown, code = 'case_input_invalid'): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new PortalError(code);
  return result.data;
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const validEmail = (value: string) => z.email().max(254).safeParse(value).success;
const validIdempotencyKey = (value: string) => /^[A-Za-z0-9_.:-]{8,128}$/u.test(value);
const validSessionId = (value: string) => /^[A-Za-z0-9_.:-]{8,128}$/u.test(value);

export class CaseStore {
  readonly db: DatabaseSync;
  readonly fclEnabled: boolean;
  constructor(readonly path: string, options: CaseStoreOptions = {}) {
    const fclOption = options.fcl;
    const fclRequested = fclOption !== undefined;
    this.db = openPortalProductionDatabase(path, 'freightclaw-business-cases', fclRequested ? CASE_SCHEMA_VERSION : 1);
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > (fclRequested ? CASE_SCHEMA_VERSION : 1)) throw new Error('cases_schema_incompatible');
      if (fclRequested && version < CASE_SCHEMA_VERSION) {
        if (!fclOption || fclOption.mode === 'reopen') throw new Error('fcl_schema_not_upgraded');
        if (!fclOption.authorized || !fclOption.oldWritersStopped) throw new Error('fcl_upgrade_not_authorized');
        if (fclOption.mode === 'exclusive_verified') {
          if (typeof fclOption.assertExclusive !== 'function') throw new Error('fcl_upgrade_exclusive_check_required');
          try { fclOption.assertExclusive(); } catch { throw new Error('fcl_upgrade_exclusive_check_failed'); }
        }
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS business_cases(case_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,organization_id TEXT,status TEXT NOT NULL,version INTEGER NOT NULL,input_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS business_cases_owner ON business_cases(owner_id,created_at,case_id);
          CREATE INDEX IF NOT EXISTS business_cases_org ON business_cases(organization_id,created_at,case_id);
          CREATE TABLE IF NOT EXISTS business_case_events(event_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES business_cases(case_id),version INTEGER NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,visibility TEXT NOT NULL,actor_label TEXT NOT NULL,created_at TEXT NOT NULL,actor_id TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS business_case_events_case ON business_case_events(case_id,version);
          CREATE TABLE IF NOT EXISTS business_case_idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,case_id TEXT NOT NULL REFERENCES business_cases(case_id),PRIMARY KEY(scope,key));
        `);
        const eventColumns = new Set((this.db.prepare('PRAGMA table_info(business_case_events)').all() as { name: string }[]).map((column) => column.name));
        if (!eventColumns.has('actor_id')) throw new Error('cases_schema_incompatible');
        if (fclRequested) {
          if (version < CASE_SCHEMA_VERSION && fclOption?.mode === 'fresh_fixture') {
            const rows = Number((this.db.prepare(`SELECT
              (SELECT COUNT(*) FROM business_cases)+
              (SELECT COUNT(*) FROM business_case_events)+
              (SELECT COUNT(*) FROM business_case_idempotency) AS n`).get() as { n: number }).n);
            if (rows !== 0) throw new Error('fcl_upgrade_fresh_fixture_not_empty');
          }
          if (!eventColumns.has('event_kind')) this.db.exec("ALTER TABLE business_case_events ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'legacy'");
          if (!eventColumns.has('payload_json')) this.db.exec("ALTER TABLE business_case_events ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS fcl_inquiries(
              fcl_inquiry_id TEXT PRIMARY KEY,
              inquiry_no TEXT NOT NULL UNIQUE,
              case_id TEXT NOT NULL UNIQUE REFERENCES business_cases(case_id),
              inquiry_date TEXT NOT NULL,
              daily_sequence INTEGER NOT NULL CHECK(daily_sequence>0),
              original_payload_json TEXT NOT NULL CHECK(json_valid(original_payload_json)),
              original_payload_digest TEXT NOT NULL,
              submission_session_hash TEXT NOT NULL,
              receiver_user_id TEXT NOT NULL,
              credential_hash TEXT NOT NULL,
              credential_expires_at TEXT NOT NULL,
              notification_status TEXT NOT NULL CHECK(notification_status IN ('not_attempted','disabled','sent','failed')),
              notification_reason TEXT,
              notification_attempted_at TEXT,
              created_at TEXT NOT NULL,
              UNIQUE(inquiry_date,daily_sequence)
            );
            CREATE INDEX IF NOT EXISTS fcl_inquiries_receiver ON fcl_inquiries(receiver_user_id,created_at,fcl_inquiry_id);
            CREATE TRIGGER IF NOT EXISTS fcl_inquiries_immutable_original
            BEFORE UPDATE OF fcl_inquiry_id,inquiry_no,case_id,inquiry_date,daily_sequence,original_payload_json,original_payload_digest,submission_session_hash,receiver_user_id,credential_hash,credential_expires_at,created_at
            ON fcl_inquiries BEGIN SELECT RAISE(ABORT,'fcl_inquiry_immutable'); END;
            CREATE TRIGGER IF NOT EXISTS fcl_inquiries_no_delete
            BEFORE DELETE ON fcl_inquiries BEGIN SELECT RAISE(ABORT,'fcl_inquiry_immutable'); END;
            PRAGMA user_version=${CASE_SCHEMA_VERSION};
          `);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.fclEnabled = fclRequested;
      securePortalDatabaseFiles(path);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  health() { try { this.db.prepare('SELECT case_id FROM business_cases LIMIT 1').get(); return true; } catch { return false; } }
  close() { this.db.close(); securePortalDatabaseFiles(this.path); }
}

export class CaseService {
  readonly #fcl: NormalizedFclOptions | null;
  constructor(readonly store: CaseStore, readonly portal: Pick<PortalService, 'getState'>, fcl?: FclCaseServiceOptions) {
    this.#fcl = fcl ? this.normalizeFclOptions(fcl) : null;
    if (this.#fcl !== null) this.assertFclStartup(this.#fcl);
  }
  private normalizeFclOptions(options: FclCaseServiceOptions): NormalizedFclOptions {
    const secret = typeof options.credentialSecret === 'string'
      ? Buffer.from(options.credentialSecret, 'utf8')
      : Buffer.from(options.credentialSecret);
    if (secret.byteLength < 32) throw new Error('fcl_credential_secret_invalid');
    if (!Number.isInteger(options.credentialTtlDays) || options.credentialTtlDays < 1 || options.credentialTtlDays > 30) {
      throw new Error('fcl_credential_ttl_invalid');
    }
    if (!options.receiverUserId.trim()) throw new Error('fcl_receiver_configuration_invalid');
    const mail = options.mail ?? {};
    const enabled = mail.enabled === true;
    const recipient = typeof mail.recipient === 'string' ? mail.recipient : null;
    const cc = [...(mail.cc ?? [])];
    const timeoutMs = mail.timeoutMs ?? 5000;
    let configurationReason: string | null = null;
    if (enabled) {
      if (!recipient || !validEmail(recipient) || cc.some((email) => !validEmail(email))) configurationReason = 'mail_configuration_invalid';
      else if (!mail.transport) configurationReason = 'mail_transport_unavailable';
      else if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) configurationReason = 'mail_configuration_invalid';
    }
    return {
      receiverUserId: options.receiverUserId,
      receiverIsActive: options.receiverIsActive,
      credentialSecret: secret,
      credentialTtlDays: options.credentialTtlDays,
      now: options.now ?? (() => new Date().toISOString()),
      mail: { enabled, recipient, cc, transport: mail.transport, timeoutMs, configurationReason },
    };
  }
  private assertFclStartup(options: NormalizedFclOptions) {
    if (!this.store.fclEnabled) throw new Error('fcl_upgrade_not_authorized');
    if (!options.receiverIsActive(options.receiverUserId)) throw new Error('fcl_receiver_unavailable');
    const owners = this.store.db.prepare('SELECT DISTINCT receiver_user_id FROM fcl_inquiries').all() as { receiver_user_id: string }[];
    if (owners.some((owner) => owner.receiver_user_id !== options.receiverUserId)) throw new Error('fcl_receiver_configuration_mismatch');
  }
  private fclOptions() {
    if (this.#fcl === null) throw new PortalError('fcl_unavailable');
    return this.#fcl;
  }
  private requireFclReceiver(ctx: PortalContext) {
    const options = this.fclOptions();
    if (!ctx.identity.emailVerified || ctx.organizationId !== null || ctx.identity.userId !== options.receiverUserId) throw new PortalError('fcl_not_found');
    if (!options.receiverIsActive(options.receiverUserId)) throw new PortalError('fcl_unavailable');
    return options;
  }
  private scope(ctx: PortalContext): Scope {
    if (!ctx.identity.emailVerified) throw new PortalError('authentication_required');
    const state = this.portal.getState(ctx).data;
    if (!state) throw new PortalError('cases_unavailable');
    const platform = ctx.identity.platformRole === 'operator' && ctx.organizationId === null;
    const org = state.current_organization;
    const membership = state.memberships.find((value) => value.userId === ctx.identity.userId && value.organizationId === ctx.organizationId && value.status === 'active');
    if (ctx.organizationId && (!org || org.status !== 'active' || !membership)) throw new PortalError('case_access_denied');
    return { user: ctx.identity.userId, org: ctx.organizationId, platform, manager: platform || Boolean(membership && ['owner', 'admin'].includes(membership.role)) };
  }
  private read(scope: Scope, id: string): Row {
    const fclFilter = this.store.fclEnabled ? ' AND NOT EXISTS(SELECT 1 FROM fcl_inquiries f WHERE f.case_id=c.case_id)' : '';
    const row = this.store.db.prepare(`SELECT c.* FROM business_cases c WHERE c.case_id=?${fclFilter}`).get(id) as Row | undefined;
    if (!row || !(scope.platform || (row.owner_id === scope.user && (row.organization_id === null || row.organization_id === scope.org)) || scope.manager && scope.org !== null && row.organization_id === scope.org)) throw new PortalError('case_not_found');
    return row;
  }
  private manages(scope: Scope, row: Row) { return scope.platform || scope.manager && scope.org !== null && scope.org === row.organization_id; }
  private view(scope: Scope, row: Row): CaseView {
    const manages = this.manages(scope, row);
    const events = this.store.db.prepare(`SELECT event_id,version,status,message,visibility,actor_label,created_at FROM business_case_events WHERE case_id=? ${manages ? '' : "AND visibility='customer'"} ORDER BY version,rowid`).all(row.case_id) as Event[];
    return { case_id: row.case_id, status: row.status, version: row.version, input: JSON.parse(row.input_json) as Draft, created_at: row.created_at, updated_at: row.updated_at, can_manage: manages, can_reply: row.owner_id === scope.user && row.status === 'needs_input', events };
  }
  private eventsWithActor(caseId: string): EventWithActor[] {
    return this.store.db.prepare('SELECT rowid,event_id,version,status,message,visibility,actor_label,created_at,actor_id FROM business_case_events WHERE case_id=? ORDER BY version,rowid').all(caseId) as EventWithActor[];
  }
  private latestCustomerSupplement(row: Row): string | null {
    const events = this.eventsWithActor(row.case_id);
    let latest: string | null = null;
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (event === undefined || event.version === 1 && event.status === 'submitted' || event.visibility !== 'customer' || event.actor_id !== row.owner_id || event.status !== 'in_review') continue;
      const previous = events[index - 1];
      if (previous === undefined || previous.status !== 'needs_input') continue;
      latest = event.event_id;
    }
    return latest;
  }
  get(ctx: PortalContext, id: string) { const scope = this.scope(ctx); return this.view(scope, this.read(scope, id)); }
  getV2(ctx: PortalContext, id: string): CaseViewV2 { const scope = this.scope(ctx), row = this.read(scope, id); return { ...this.view(scope, row), review_context: { latest_customer_supplement_ref: this.latestCustomerSupplement(row) } }; }
  readForQuoteView(ctx: PortalContext, id: string): QuoteLinkCaseRead { const scope = this.scope(ctx), row = this.read(scope, id); return { case_ref: row.case_id, owner_id: row.owner_id, organization_id: row.organization_id, status: row.status, version: row.version, latest_customer_supplement_ref: this.latestCustomerSupplement(row) }; }
  readForQuoteLink(ctx: PortalContext, id: string): QuoteLinkCaseRead { const scope = this.scope(ctx); if (!scope.manager && !scope.platform) throw new PortalError('case_management_denied'); return this.readForQuoteView(ctx, id); }
  list(ctx: PortalContext, input: unknown) {
    const query = parse(caseListSchema, input), scope = this.scope(ctx);
    if (query.management && !scope.manager) throw new PortalError('case_management_denied');
    const where: string[] = this.store.fclEnabled ? ['NOT EXISTS(SELECT 1 FROM fcl_inquiries f WHERE f.case_id=c.case_id)'] : [];
    const params: (string | number | null)[] = [];
    if (query.management) { if (!scope.platform) { where.push('c.organization_id=?'); params.push(scope.org); } } else { where.push('c.owner_id=? AND (c.organization_id IS NULL OR c.organization_id=?)'); params.push(scope.user, scope.org); }
    if (query.status) { where.push('c.status=?'); params.push(query.status); }
    if (query.cursor) {
      let cursor: { at: string; id: string };
      try { cursor = z.object({ at: z.string().datetime(), id: z.string().uuid() }).strict().parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
      catch { throw new PortalError('case_input_invalid'); }
      where.push('(c.created_at < ? OR (c.created_at=? AND c.case_id<?))'); params.push(cursor.at, cursor.at, cursor.id);
    }
    params.push(query.limit + 1);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.store.db.prepare(`SELECT c.* FROM business_cases c ${whereSql} ORDER BY c.created_at DESC,c.case_id DESC LIMIT ?`).all(...params) as Row[];
    const page = rows.slice(0, query.limit), last = page.at(-1);
    return { items: page.map((row) => { const value = this.view(scope, row); return { ...value, events: [] }; }), next_cursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.case_id })).toString('base64url') : null, can_manage: scope.manager };
  }
  private mutate(scope: Scope, action: string, key: string, input: unknown, write: () => string): CaseView {
    if (!validIdempotencyKey(key)) throw new PortalError('idempotency_key_invalid');
    const partition = JSON.stringify([scope.user, scope.org, action]), digest = sha256(JSON.stringify(input)), db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    let id: string;
    try {
      const prior = db.prepare('SELECT digest,case_id FROM business_case_idempotency WHERE scope=? AND key=?').get(partition, key) as { digest: string; case_id: string } | undefined;
      if (prior) { if (prior.digest !== digest) throw new PortalError('idempotency_conflict'); id = prior.case_id; }
      else { id = write(); db.prepare('INSERT INTO business_case_idempotency VALUES(?,?,?,?)').run(partition, key, digest, id); }
      this.read(scope, id); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return this.view(scope, this.read(scope, id));
  }
  private event(row: Row, message: string, visibility: Event['visibility'], label: string, actorId: string, kind = 'legacy', payload: unknown = {}) {
    if (!this.store.fclEnabled) {
      this.store.db.prepare('INSERT INTO business_case_events VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), row.case_id, row.version, row.status, message, visibility, label, row.updated_at, actorId);
      return;
    }
    this.store.db.prepare('INSERT INTO business_case_events(event_id,case_id,version,status,message,visibility,actor_label,created_at,actor_id,event_kind,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), row.case_id, row.version, row.status, message, visibility, label, row.updated_at, actorId, kind, JSON.stringify(payload));
  }
  create(ctx: PortalContext, input: unknown, key: string) {
    const scope = this.scope(ctx), draft = parse(caseInputSchema, input) as Draft;
    if (ctx.identity.platformRole !== null && ctx.organizationId === null) throw new PortalError('case_customer_required');
    return this.mutate(scope, 'create', key, draft, () => {
      const daily = this.store.db.prepare('SELECT COUNT(*) AS n FROM business_cases WHERE owner_id=? AND created_at>=?').get(scope.user, new Date(Date.now() - 86400000).toISOString()) as { n: number };
      if (daily.n >= 50) throw new PortalError('case_daily_limit');
      const at = new Date().toISOString(), id = randomUUID();
      const row: Row = { case_id: id, owner_id: scope.user, organization_id: scope.org, status: 'submitted', version: 1, input_json: JSON.stringify(draft), created_at: at, updated_at: at };
      this.store.db.prepare('INSERT INTO business_cases VALUES(?,?,?,?,?,?,?,?)').run(id, scope.user, scope.org, row.status, 1, row.input_json, at, at);
      this.event(row, '需求已提交，等待工作人员处理。', 'customer', '客户', scope.user); return id;
    });
  }
  update(ctx: PortalContext, id: string, input: unknown, key: string) {
    const scope = this.scope(ctx), change = parse(caseUpdateSchema, input);
    if (!this.manages(scope, this.read(scope, id))) throw new PortalError('case_management_denied');
    return this.mutate(scope, `update:${id}`, key, change, () => {
      const row = this.read(scope, id);
      if (row.version !== change.expected_version) throw new PortalError('version_conflict');
      const transitions: Record<CaseStatus, readonly CaseStatus[]> = { submitted: ['in_review', 'needs_input', 'closed', 'cancelled'], in_review: ['in_review', 'needs_input', 'closed', 'cancelled'], needs_input: ['in_review', 'needs_input', 'closed', 'cancelled'], closed: [], cancelled: [] };
      if (!transitions[row.status].includes(change.status) || row.version >= 500) throw new PortalError('case_transition_invalid');
      row.status = change.status; row.version++; row.updated_at = new Date().toISOString();
      this.store.db.prepare('UPDATE business_cases SET status=?,version=?,updated_at=? WHERE case_id=?').run(row.status, row.version, row.updated_at, id);
      this.event(row, change.public_note.trim(), 'customer', '工作人员', scope.user);
      if (change.internal_note.trim()) this.event(row, change.internal_note.trim(), 'internal', ctx.identity.displayName, scope.user);
      return id;
    });
  }
  reply(ctx: PortalContext, id: string, input: unknown, key: string) {
    const scope = this.scope(ctx), reply = parse(caseReplySchema, input);
    if (this.read(scope, id).owner_id !== scope.user) throw new PortalError('case_access_denied');
    return this.mutate(scope, `reply:${id}`, key, reply, () => {
      const row = this.read(scope, id);
      if (row.version !== reply.expected_version) throw new PortalError('version_conflict');
      if (row.status !== 'needs_input' || row.version >= 500) throw new PortalError('case_transition_invalid');
      row.version++; row.status = 'in_review'; row.updated_at = new Date().toISOString();
      this.store.db.prepare('UPDATE business_cases SET status=?,version=?,updated_at=? WHERE case_id=?').run(row.status, row.version, row.updated_at, id);
      this.event(row, reply.message.trim(), 'customer', '客户', scope.user); return id;
    });
  }
  private fclRowByCase(caseId: string): FclRow | undefined {
    return this.store.db.prepare('SELECT * FROM fcl_inquiries WHERE case_id=?').get(caseId) as FclRow | undefined;
  }
  private fclRowById(inquiryId: string): FclRow | undefined {
    return this.store.db.prepare('SELECT * FROM fcl_inquiries WHERE fcl_inquiry_id=?').get(inquiryId) as FclRow | undefined;
  }
  private notification(row: FclRow) {
    return fclCaseNotificationSchema.parse({
      status: row.notification_status,
      reason_code: row.notification_reason,
      attempted_at: row.notification_attempted_at,
    });
  }
  private fclEvents(caseId: string) {
    const rows = this.store.db.prepare(`SELECT event_id,version,status,message,visibility,actor_label,created_at,event_kind,payload_json,actor_id
      FROM business_case_events WHERE case_id=? AND event_kind IN ('fcl_inquiry_submitted','fcl_receiver_assigned') ORDER BY version,rowid`).all(caseId) as FclEventRow[];
    return rows.map((row) => fclCaseEventSchema.parse({
      event_id: row.event_id,
      version: row.version,
      status: row.status,
      message: row.message,
      visibility: row.visibility,
      actor_label: row.actor_label,
      actor_kind: row.event_kind === 'fcl_inquiry_submitted' ? 'anonymous_customer' : 'system',
      actor_ref: row.actor_id,
      created_at: row.created_at,
      kind: row.event_kind,
      payload: JSON.parse(row.payload_json) as unknown,
    }));
  }
  private fclInternalView(row: FclRow): FclCaseInternalView {
    const caseRow = this.store.db.prepare('SELECT * FROM business_cases WHERE case_id=?').get(row.case_id) as Row | undefined;
    if (!caseRow) throw new PortalError('fcl_readback_failed');
    return fclCaseInternalViewSchema.parse({
      contract_version: 'fcl-case@2026-09-20.v1',
      inquiry_id: row.fcl_inquiry_id,
      inquiry_no: row.inquiry_no,
      case_id: row.case_id,
      receiver_user_id: row.receiver_user_id,
      original_input: JSON.parse(row.original_payload_json) as unknown,
      current_input: JSON.parse(caseRow.input_json) as unknown,
      case_status: caseRow.status,
      case_version: caseRow.version,
      created_at: row.created_at,
      updated_at: caseRow.updated_at,
      notification: this.notification(row),
      events: this.fclEvents(row.case_id),
    });
  }
  private fclPublicSummary(row: FclRow, input: FclInquiryInput): FclCasePublicSummary {
    const complete = Boolean(
      input.pol && input.pod && input.cargo_name &&
      input.containers.length > 0 && input.containers.every((container) => container.quantity !== null) &&
      input.cargo_type && input.estimated_weight && input.cargo_ready_date && input.incoterm &&
      input.selected_services.length > 0 && (input.incoterm !== 'Other' || Boolean(input.incoterm_other)),
    );
    return fclCasePublicSummarySchema.parse({
      contract_version: 'fcl-case@2026-09-20.v1',
      inquiry_id: row.fcl_inquiry_id,
      inquiry_no: row.inquiry_no,
      case_status: (this.store.db.prepare('SELECT status FROM business_cases WHERE case_id=?').get(row.case_id) as { status: CaseStatus }).status,
      case_version: (this.store.db.prepare('SELECT version FROM business_cases WHERE case_id=?').get(row.case_id) as { version: number }).version,
      created_at: row.created_at,
      credential_expires_at: row.credential_expires_at,
      complete,
      input,
    });
  }
  getFclCase(ctx: PortalContext, caseId: string): FclCaseInternalView {
    this.requireFclReceiver(ctx);
    const row = this.fclRowByCase(caseId);
    if (!row || row.receiver_user_id !== ctx.identity.userId) throw new PortalError('fcl_not_found');
    return this.fclInternalView(row);
  }
  listFclCases(ctx: PortalContext) {
    const options = this.requireFclReceiver(ctx);
    const rows = this.store.db.prepare('SELECT * FROM fcl_inquiries WHERE receiver_user_id=? ORDER BY created_at DESC,fcl_inquiry_id DESC LIMIT 50').all(options.receiverUserId) as FclRow[];
    return fclCaseListSchema.parse({ items: rows.map((row) => this.fclInternalView(row)) });
  }
  getFclCustomerView(inquiryId: string, credential: string): FclCasePublicSummary {
    const options = this.fclOptions();
    const row = this.fclRowById(inquiryId);
    if (!row || Date.parse(row.credential_expires_at) <= Date.parse(options.now()) || !this.credentialMatches(row, credential)) {
      throw new PortalError('fcl_not_found');
    }
    return this.fclPublicSummary(row, parse(fclInquirySchema, JSON.parse((this.store.db.prepare('SELECT input_json FROM business_cases WHERE case_id=?').get(row.case_id) as { input_json: string }).input_json), 'fcl_readback_failed'));
  }
  private credentialMatches(row: FclRow, credential: string) {
    const expected = Buffer.from(row.credential_hash, 'hex'), actual = Buffer.from(sha256(credential), 'hex');
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }
  private deriveCredential(options: NormalizedFclOptions, sessionId: string, key: string, bodyDigest: string, inquiryId: string, caseId: string) {
    return createHmac('sha256', options.credentialSecret)
      .update(['fcl-inquiry-credential', sessionId, key, bodyDigest, inquiryId, caseId].join('\0'))
      .digest('base64url');
  }
  private verifyFclReadback(row: FclRow, expectedInput: FclInquiryInput, initial: boolean) {
    const caseRow = this.store.db.prepare('SELECT * FROM business_cases WHERE case_id=?').get(row.case_id) as Row | undefined;
    if (!caseRow || caseRow.owner_id !== row.receiver_user_id || caseRow.organization_id !== null) throw new PortalError('fcl_readback_failed');
    if (sha256(row.original_payload_json) !== row.original_payload_digest) throw new PortalError('fcl_readback_failed');
    const currentInput = parse(fclInquirySchema, JSON.parse(caseRow.input_json), 'fcl_readback_failed');
    if (initial && (caseRow.status !== 'submitted' || caseRow.version !== 1 || JSON.stringify(currentInput) !== JSON.stringify(expectedInput))) {
      throw new PortalError('fcl_readback_failed');
    }
    return { caseRow, currentInput };
  }
  private mailBody(submission: FclCaseSubmission, input: FclInquiryInput) {
    const summary = buildFclInquirySummary(input);
    return [
      `Inquiry: ${submission.inquiry_no}`,
      `Inquiry ID: ${submission.inquiry_id}`,
      `Customer: ${summary.contact.name ?? 'Pending'} <${summary.contact.email ?? 'Pending'}>`,
      `Company: ${summary.contact.company ?? 'None'}`,
      `Phone: ${summary.contact.phone ?? 'None'}`,
      `Origin: ${summary.route.origin_city ?? 'Pending'} / ${summary.route.pol ?? 'Pending'}`,
      `POD: ${summary.route.pod ?? 'Pending'}`,
      `Final destination: ${summary.route.final_destination ?? 'Pending'}`,
      `Containers: ${summary.containers.map((container) => `${container.type} x ${container.quantity ?? 'Pending'}`).join(', ') || 'Pending'}`,
      `Cargo: ${summary.cargo.cargo_name ?? 'Pending'} (${summary.cargo.cargo_type ?? 'Pending'})`,
      `Estimated gross weight: ${summary.cargo.estimated_weight ? `${summary.cargo.estimated_weight.value} ${summary.cargo.estimated_weight.unit}` : 'Pending'}`,
      `Ready date: ${summary.cargo.cargo_ready_date ?? 'Pending'}`,
      `Incoterm: ${summary.cargo.incoterm ?? 'Pending'}${summary.cargo.incoterm_other ? ` (${summary.cargo.incoterm_other})` : ''}`,
      `Services: ${summary.selected_services.join(', ') || 'Pending'}`,
      `Notes: ${summary.notes ?? 'None'}`,
    ].join('\n');
  }
  private mailSubject(submission: FclCaseSubmission, input: FclInquiryInput) {
    const summary = buildFclInquirySummary(input);
    const containers = summary.containers
      .map((container) => `${container.type} × ${container.quantity ?? '待确认'}`)
      .join(' | ') || '待确认';
    return `[FCL询价][${submission.inquiry_no}] ${summary.route.pol ?? '待确认'} → ${summary.route.pod ?? '待确认'} | ${containers}`;
  }
  private async attemptFclNotification(row: FclRow, submission: FclCaseSubmission, input: FclInquiryInput) {
    const options = this.fclOptions();
    if (!options.mail.enabled) {
      return this.setFclNotification(row.fcl_inquiry_id, 'disabled', null, null);
    }
    if (options.mail.configurationReason !== null) {
      const at = options.now();
      return this.setFclNotification(row.fcl_inquiry_id, 'failed', options.mail.configurationReason, at);
    }
    const mail = options.mail;
    const transport = mail.transport;
    const recipient = mail.recipient;
    if (!transport || !recipient) throw new PortalError('fcl_readback_failed');
    const at = options.now();
    let status: NotificationStatus = 'sent', reason: string | null = null;
    try {
      await this.withTimeout(Promise.resolve(transport.send({
        to: recipient,
        cc: [...mail.cc],
        subject: this.mailSubject(submission, input),
        body: this.mailBody(submission, input),
      })), mail.timeoutMs);
    } catch (error) {
      status = 'failed';
      reason = error instanceof Error && error.message === 'fcl_mail_timeout' ? 'mail_timeout' : 'mail_transport_failed';
    }
    return this.setFclNotification(row.fcl_inquiry_id, status, reason, at);
  }
  private setFclNotification(inquiryId: string, status: NotificationStatus, reason: string | null, attemptedAt: string | null) {
    this.store.db.prepare('UPDATE fcl_inquiries SET notification_status=?,notification_reason=?,notification_attempted_at=? WHERE fcl_inquiry_id=?').run(status, reason, attemptedAt, inquiryId);
    const row = this.fclRowById(inquiryId);
    if (!row || row.notification_status !== status || row.notification_reason !== reason || row.notification_attempted_at !== attemptedAt) {
      throw new PortalError('fcl_readback_failed');
    }
    return this.notification(row);
  }
  private withTimeout(value: Promise<void>, timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fcl_mail_timeout')), timeoutMs);
      value.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error('fcl_mail_transport_failed')); },
      );
    });
  }
  async submitFclInquiry(submissionSessionId: string, key: string, input: unknown): Promise<FclCaseSubmission> {
    const options = this.fclOptions();
    if (!options.receiverIsActive(options.receiverUserId)) throw new PortalError('fcl_unavailable');
    if (!validSessionId(submissionSessionId)) throw new PortalError('fcl_input_invalid');
    if (!validIdempotencyKey(key)) throw new PortalError('idempotency_key_invalid');
    const inquiry = parse(fclInquirySchema, input, 'fcl_input_invalid');
    const bodyJson = JSON.stringify(inquiry), bodyDigest = sha256(bodyJson), sessionHash = sha256(submissionSessionId);
    const scope = `fcl-submit:${sessionHash}`;
    const db = this.store.db;
    let row: FclRow;
    let first = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT digest,case_id FROM business_case_idempotency WHERE scope=? AND key=?').get(scope, key) as { digest: string; case_id: string } | undefined;
      if (prior) {
        if (prior.digest !== bodyDigest) throw new PortalError('fcl_idempotency_conflict');
        const existing = this.fclRowByCase(prior.case_id);
        if (!existing) throw new PortalError('fcl_readback_failed');
        row = existing;
      } else {
        first = true;
        const createdAt = options.now();
        const inquiryDate = createdAt.slice(0, 10);
        const sequence = (db.prepare('SELECT COALESCE(MAX(daily_sequence),0) AS value FROM fcl_inquiries WHERE inquiry_date=?').get(inquiryDate) as { value: number }).value + 1;
        const inquiryId = randomUUID(), caseId = randomUUID();
        const inquiryNo = `FCL-${inquiryDate.replaceAll('-', '')}-${String(sequence).padStart(4, '0')}`;
        const credential = this.deriveCredential(options, submissionSessionId, key, bodyDigest, inquiryId, caseId);
        const credentialHash = sha256(credential);
        const credentialExpiresAt = new Date(Date.parse(createdAt) + options.credentialTtlDays * 86400000).toISOString();
        const caseRow: Row = { case_id: caseId, owner_id: options.receiverUserId, organization_id: null, status: 'submitted', version: 1, input_json: bodyJson, created_at: createdAt, updated_at: createdAt };
        db.prepare('INSERT INTO business_cases VALUES(?,?,?,?,?,?,?,?)').run(caseId, caseRow.owner_id, caseRow.organization_id, caseRow.status, caseRow.version, caseRow.input_json, caseRow.created_at, caseRow.updated_at);
        db.prepare('INSERT INTO fcl_inquiries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          inquiryId, inquiryNo, caseId, inquiryDate, sequence, bodyJson, bodyDigest, sessionHash, options.receiverUserId,
          credentialHash, credentialExpiresAt, 'not_attempted', null, null, createdAt,
        );
        this.event(caseRow, 'FCL inquiry submitted by anonymous customer.', 'customer', 'Anonymous customer', `anonymous:${sessionHash.slice(0, 24)}`, 'fcl_inquiry_submitted', { fcl_inquiry_id: inquiryId, inquiry_no: inquiryNo });
        this.event(caseRow, 'FCL inquiry assigned to configured receiver.', 'internal', 'System', 'system:fcl_receiver_assignment', 'fcl_receiver_assigned', { receiver_user_id: options.receiverUserId });
        db.prepare('INSERT INTO business_case_idempotency VALUES(?,?,?,?)').run(scope, key, bodyDigest, caseId);
        row = this.fclRowById(inquiryId) as FclRow;
      }
      if (first) this.verifyFclReadback(row, inquiry, true);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const readback = this.verifyFclReadback(row, inquiry, first);
    const credential = this.deriveCredential(options, submissionSessionId, key, bodyDigest, row.fcl_inquiry_id, row.case_id);
    if (sha256(credential) !== row.credential_hash) throw new PortalError('fcl_credential_unavailable');
    if (Date.parse(row.credential_expires_at) <= Date.parse(options.now())) throw new PortalError('fcl_credential_expired');
    const base = fclCaseSubmissionSchema.parse({
      contract_version: 'fcl-case@2026-09-20.v1',
      inquiry_id: row.fcl_inquiry_id,
      inquiry_no: row.inquiry_no,
      case_id: row.case_id,
      case_status: readback.caseRow.status,
      case_version: readback.caseRow.version,
      created_at: row.created_at,
      credential,
      credential_expires_at: row.credential_expires_at,
      notification: this.notification(row),
      replay: !first,
    });
    if (!first) return base;
    const notification = await this.attemptFclNotification(row, base, inquiry);
    return fclCaseSubmissionSchema.parse({ ...base, notification });
  }
}
