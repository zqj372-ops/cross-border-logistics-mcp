import { createHash, randomUUID } from 'node:crypto';
import {prepareFclMaintenance} from '../../quote-native/fcl-maintenance';
import { maritimeSaveSchema, validateMaritimeDataset, queryMaritime, type MaritimeKind, type MaritimeDataset } from '../../maritime/contracts';
import type { CustomsPackages } from '../../customs-native/packages';
import { type CustomsDataset } from '../../customs-native/contracts';
import { validateCustomsDataset, customsRelease } from '../../customs-native/publication';
import { residentialRatesSchema, validateResidentialRates, type ResidentialRates } from '../../quote-native/contracts';
import {
  fclRateDatasetSchema,
  fclRatePublicationSchema,
  fclRateSaveSchema,
  validateFclRateDataset,
  type FclRateDataset,
  type FclRatePublication,
} from '../../quote-native/fcl-contracts';
import { openPortalProductionDatabase, securePortalDatabaseFiles } from './production-persistence';
import { PortalError, type PortalContext } from './contracts';
import {SyncTransactionGuard} from './sync-transaction';
import {FclOperationsService} from './fcl-operations';
import {FCL_NOTIFICATION_V2,emptyFclNotificationConfig,fclNotificationV2ConfigSchema,fclNotificationV2SaveSchema,fclNotificationV2ViewSchema,fclNotificationPreviewRequestSchema,fclNotificationPreviewOutputSchema,fclNotificationTestSchema} from './fcl-execution-contracts';
import type {FclMailTransport} from './cases';
import {FCL_NODE_LABELS,renderNotificationTestBody} from './fcl-execution-mail-format';
import type { PortalService } from './service';
import {
  nativePublishSchema,
  nativeDisableSchema,
  nativeRollbackSchema,
  customsSaveSchema,
  FCL_NOTIFICATION_VERSION,
  fclNotificationSaveSchema,
  fclNotificationViewSchema,
  residentialSaveSchema,
  type NativeKind,
} from './native-admin-contracts';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const NATIVE_SCHEMA_VERSION = 3;
const LEGACY_SCHEMA_VERSION = 2;
type NativeInput = CustomsDataset | ResidentialRates | MaritimeDataset | FclRateDataset;
interface Row { scope: string; kind: NativeKind; version: number; draft: string; active: string | null }
export interface NativePublication<T = NativeInput> { release_id: string; version: number; input: T; published_at: string; digest: string }
export interface FclRateHistoryItem { release_id: string; version: number; label: string; published_at: string; digest: string }
export interface FclRateAdminView {
  kind: 'fcl';
  version: number;
  draft: FclRateDataset | null;
  active_release: FclRatePublication | null;
  history: FclRateHistoryItem[];
}

export type NativeAdminStoreOptions = {
  fcl?:
    | { mode: 'fresh_fixture'; authorized: true; oldWritersStopped: true }
    | { mode: 'exclusive_verified'; authorized: true; oldWritersStopped: true; assertExclusive: () => void }
    | { mode: 'reopen' };
};

export type FclNativeAdminOptions = {
  receiverUserId: string;
  receiverIsActive: (userId: string) => boolean;
  now?: () => string;
  executionIsActive?:(id:string)=>boolean;
  mailConfigured?:()=>boolean;
  mailTransport?:FclMailTransport;
};

type NormalizedFclOptions = {
  receiverUserId: string;
  receiverIsActive: (userId: string) => boolean;
  now: () => string;
  scope: string;
};

export class NativeAdminStore {
  readonly db;
  readonly fclEnabled: boolean;
  packages?: CustomsPackages;
  constructor(readonly path: string, options: NativeAdminStoreOptions = {}) {
    const fclOption = options.fcl;
    const fclRequested = fclOption !== undefined;
    this.db = openPortalProductionDatabase(
      path,
      'freightclaw-native-business',
      fclRequested ? NATIVE_SCHEMA_VERSION : LEGACY_SCHEMA_VERSION,
    );
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > (fclRequested ? NATIVE_SCHEMA_VERSION : LEGACY_SCHEMA_VERSION)) throw new Error('native_schema_incompatible');
      if (fclRequested && version < NATIVE_SCHEMA_VERSION) {
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
          CREATE TABLE IF NOT EXISTS native_configs(scope TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL,draft TEXT NOT NULL,active TEXT,PRIMARY KEY(scope,kind));
          CREATE TABLE IF NOT EXISTS native_releases(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS native_audit(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,digest TEXT NOT NULL,created TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS native_idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key));
        `);
        if (fclRequested && version < NATIVE_SCHEMA_VERSION && fclOption?.mode === 'fresh_fixture') {
          const rows = Number((this.db.prepare(`SELECT
            (SELECT COUNT(*) FROM native_configs)+
            (SELECT COUNT(*) FROM native_releases)+
            (SELECT COUNT(*) FROM native_audit)+
            (SELECT COUNT(*) FROM native_idempotency) AS n`).get() as { n: number }).n);
          if (rows !== 0) throw new Error('fcl_upgrade_fresh_fixture_not_empty');
        }
        this.db.exec(`PRAGMA user_version=${fclRequested ? NATIVE_SCHEMA_VERSION : LEGACY_SCHEMA_VERSION}`);
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
  close() { this.packages?.close(); this.db.close(); securePortalDatabaseFiles(this.path); }
  current<T = NativeInput>(scope: string, kind: NativeKind): NativePublication<T> | null {
    const row = this.db.prepare(`SELECT r.payload FROM native_releases r
      JOIN native_configs c ON c.active=r.id AND c.scope=r.scope AND c.kind=r.kind
      WHERE c.scope=? AND c.kind=?`).get(scope, kind) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as NativePublication<T> : null;
  }
  customsReader(scope: string) {
    return {
      current: (date: string) => {
        if (this.packages?.hasSelection(scope)) return this.packages.current(scope, date);
        const release = this.current<CustomsDataset>(scope, 'customs');
        if (!release || release.input.rule_date > date) return null;
        return customsRelease(release.input, release.release_id, release.published_at);
      },
    };
  }
}

export class NativeAdminService {
  readonly fclOperations:FclOperationsService;
  readonly #fcl: NormalizedFclOptions | null;
  readonly #fclNotificationTransaction=new SyncTransactionGuard();
  private readonly executionPeople:((id:string)=>boolean)|undefined;
  private readonly mailConfigured:()=>boolean;
  private readonly notificationTransport:FclMailTransport|undefined;
  constructor(
    private store: NativeAdminStore,
    private portal: Pick<PortalService, 'getState'>,
    fcl?: FclNativeAdminOptions,
  ) {
    this.executionPeople=fcl?.executionIsActive;
    this.mailConfigured=fcl?.mailConfigured??(()=>false);
    this.notificationTransport=fcl?.mailTransport;
    this.#fcl = fcl ? this.normalizeFclOptions(fcl) : null;
    if (this.#fcl !== null) this.assertFclStartup(this.#fcl);
    this.fclOperations=new FclOperationsService({store:this.store,authorize:ctx=>this.fclReceiverScope(ctx),getRates:ctx=>this.get(ctx,'fcl') as FclRateAdminView});
  }
  private normalizeFclOptions(options: FclNativeAdminOptions): NormalizedFclOptions {
    if (!options.receiverUserId.trim()) throw new Error('fcl_receiver_configuration_invalid');
    const now = options.now ?? (() => new Date().toISOString());
    if (!Number.isFinite(Date.parse(now()))) throw new Error('fcl_clock_invalid');
    return {
      receiverUserId: options.receiverUserId,
      receiverIsActive: options.receiverIsActive,
      now,
      scope: `fcl-person:${options.receiverUserId}`,
    };
  }
  private assertFclStartup(options: NormalizedFclOptions) {
    if (!this.store.fclEnabled) throw new Error('fcl_upgrade_not_authorized');
    try {
      if (!options.receiverIsActive(options.receiverUserId)) throw new Error('inactive');
    } catch {
      throw new Error('fcl_receiver_unavailable');
    }
    // Existing scopes retain their owners. Enterprise scopes are never adopted by a personal account.
  }
  private fclOptions() {
    if (this.#fcl === null) throw new PortalError('fcl_unavailable');
    return this.#fcl;
  }
  query(ctx: PortalContext, kind: MaritimeKind, input: unknown) {
    const scope = this.scope(ctx, false, kind), release = this.store.current(scope, kind);
    if (release && digest(release.input) !== release.digest) throw new PortalError('native_publication_blocked');
    const result = queryMaritime(kind, input, release);
    this.store.db.prepare('INSERT INTO native_audit VALUES(?,?,?,?,?,?,?)').run(
      randomUUID(), scope, kind, ctx.identity.userId, 'query', digest(input), this.time(kind),
    );
    return result;
  }
  private fclReceiverScope(ctx: PortalContext): NormalizedFclOptions {
    const options = this.fclOptions();
    if (!ctx.identity.emailVerified || !ctx.identity.userId.trim()) {
      throw new PortalError('fcl_not_found');
    }
    try {
      if (!options.receiverIsActive(ctx.identity.userId)) throw new PortalError('fcl_unavailable');
    } catch (error) {
      if (error instanceof PortalError && error.code === 'fcl_unavailable') throw error;
      throw new PortalError('fcl_unavailable');
    }
    return {...options,receiverUserId:ctx.identity.userId,scope:`fcl-person:${ctx.identity.userId}`};
  }
  private scope(ctx: PortalContext, write = false, kind?: NativeKind) {
    if (kind === 'fcl') return this.fclReceiverScope(ctx).scope;
    if (!ctx.identity.emailVerified || !ctx.organizationId) throw new PortalError('native_organization_required');
    const state = this.portal.getState(ctx).data;
    const member = state?.memberships.find((value) => value.userId === ctx.identity.userId && value.organizationId === ctx.organizationId && value.status === 'active');
    if (!member || state?.current_organization?.status !== 'active' || write && !['owner', 'admin'].includes(member.role)) {
      throw new PortalError('native_management_denied');
    }
    return ctx.organizationId;
  }
  private time(kind: NativeKind) {
    return kind === 'fcl' ? this.fclOptions().now() : new Date().toISOString();
  }
  private row(scope: string, kind: NativeKind) {
    return this.store.db.prepare('SELECT * FROM native_configs WHERE scope=? AND kind=?').get(scope, kind) as Row | undefined;
  }
  private problems(kind: NativeKind, input: unknown) {
    const errors = kind === 'customs'
      ? validateCustomsDataset(input)
      : kind === 'residential'
        ? validateResidentialRates(input)
        : kind === 'fcl'
          ? validateFclRateDataset(input)
          : validateMaritimeDataset(kind, input);
    if (kind === 'residential' && residentialRatesSchema.safeParse(input).success && (input as ResidentialRates).valid_until < new Date().toISOString().slice(0, 10)) {
      errors.push('运价已经到期。');
    }
    return errors;
  }
  private parseFclRelease(rowId: string, payload: string): FclRatePublication {
    try {
      const release = fclRatePublicationSchema.parse(JSON.parse(payload) as unknown);
      const blockers = validateFclRateDataset(release.input);
      if (release.release_id !== rowId || blockers.length > 0 || digest(release.input) !== release.digest) {
        throw new Error('invalid release');
      }
      return release;
    } catch {
      throw new PortalError('native_publication_blocked');
    }
  }
  private fclRelease(scope: string, releaseId: string): FclRatePublication {
    const row = this.store.db.prepare(`SELECT id,payload FROM native_releases WHERE id=? AND scope=? AND kind='fcl'`)
      .get(releaseId, scope) as { id: string; payload: string } | undefined;
    if (!row) throw new PortalError('native_release_not_found');
    return this.parseFclRelease(row.id, row.payload);
  }
  private fclGet(scope: string): FclRateAdminView {
    const row = this.row(scope, 'fcl');
    let draft: FclRateDataset | null;
    try {
      draft = row ? fclRateDatasetSchema.parse(JSON.parse(row.draft) as unknown) : null;
      if (draft && validateFclRateDataset(draft).length > 0) throw new Error('invalid draft');
    } catch {
      throw new PortalError('native_publication_blocked');
    }
    const active = row?.active ? this.fclRelease(scope, row.active) : null;
    const history = (this.store.db.prepare(`SELECT id,payload FROM native_releases WHERE scope=? AND kind='fcl' ORDER BY rowid DESC LIMIT 50`)
      .all(scope) as { id: string; payload: string }[]).map((item) => this.parseFclRelease(item.id, item.payload));
    return {
      kind: 'fcl' as const,
      version: row?.version ?? 0,
      draft,
      active_release: active,
      history: history.map((release) => ({
        release_id: release.release_id,
        version: release.version,
        label: release.input.label,
        published_at: release.published_at,
        digest: release.digest,
      })),
    };
  }
  get(ctx: PortalContext, kind: NativeKind) {
    const scope = this.scope(ctx, false, kind);
    if (kind === 'fcl') return this.fclGet(scope);
    const row = this.row(scope, kind);
    const history = this.store.db.prepare('SELECT payload FROM native_releases WHERE scope=? AND kind=? ORDER BY rowid DESC LIMIT 50')
      .all(scope, kind).map((item) => {
        const publication = JSON.parse((item as { payload: string }).payload) as NativePublication;
        return { release_id: publication.release_id, version: publication.version, label: publication.input.label, published_at: publication.published_at, digest: publication.digest };
      });
    return {
      kind,
      version: row?.version ?? 0,
      draft: row ? JSON.parse(row.draft) as unknown : null,
      active_release: this.store.current(scope, kind),
      history,
    };
  }
  private fclNotificationView(scope: string, replay: { replayed: boolean; submitted_version: number | null; current: boolean } = { replayed: false, submitted_version: null, current: true }) {
    const row = this.store.db.prepare("SELECT version,draft FROM native_configs WHERE scope=? AND kind='fcl-notification'").get(scope) as { version: number; draft: string } | undefined;
    let input: unknown = null;
    if (row) {
      try {
        input = JSON.parse(row.draft) as unknown;
        if((input as {contract_version?:string})?.contract_version===FCL_NOTIFICATION_V2){
          const config=fclNotificationV2ConfigSchema.parse(input),intake=config.rows.find(row=>row.node_id==='intake');
          if(!intake)throw new Error('invalid');
          input={enabled:intake.assignment.enabled,recipient:intake.assignment.to,cc:intake.assignment.cc};
        }
      }
      catch { throw new PortalError('native_readback_failed'); }
    }
    try { return fclNotificationViewSchema.parse({ contract_version: FCL_NOTIFICATION_VERSION, version: row?.version ?? 0, input, replay }); }
    catch { throw new PortalError('native_readback_failed'); }
  }
  private assertFclNotificationCommitted(scope: string, expected: ReturnType<NativeAdminService['fclNotificationView']>, auditId: string, createdAt: string, actionDigest: string, partition: string, key: string, actor: string): void {
    const row = this.store.db.prepare("SELECT scope,kind,version,draft,active FROM native_configs WHERE scope=? AND kind='fcl-notification'").get(scope) as { scope:string;kind:string;version:number;draft:string;active:string|null }|undefined;
    const readback=this.fclNotificationView(scope);
    const audit=this.store.db.prepare('SELECT id,scope,kind,actor,action,digest,created FROM native_audit WHERE id=?').get(auditId) as {id:string;scope:string;kind:string;actor:string;action:string;digest:string;created:string}|undefined;
    const idempotency=this.store.db.prepare('SELECT digest,result FROM native_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
    if(!row||row.scope!==scope||row.kind!=='fcl-notification'||row.active!==null||row.version!==expected.version||row.draft!==JSON.stringify(expected.input)||JSON.stringify(readback)!==JSON.stringify(expected)||!audit||audit.id!==auditId||audit.scope!==scope||audit.kind!=='fcl-notification'||audit.actor!==actor||audit.action!=='save'||audit.digest!==actionDigest||audit.created!==createdAt||!idempotency||idempotency.digest!==actionDigest||idempotency.result!==JSON.stringify(expected))throw new PortalError('native_readback_failed');
  }
  getFclNotification(ctx: PortalContext) {
    const scope = this.fclReceiverScope(ctx).scope;
    return this.fclNotificationView(scope);
  }
  saveFclNotification(ctx: PortalContext, input: unknown, key: string) {
    const options = this.fclReceiverScope(ctx), scope = options.scope;
    if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(key)) throw new PortalError('idempotency_key_invalid');
    const change = fclNotificationSaveSchema.safeParse(input);
    if (!change.success) throw new PortalError('native_input_invalid');
    const raw=this.store.db.prepare("SELECT draft FROM native_configs WHERE scope=? AND kind='fcl-notification'").get(scope) as {draft:string}|undefined;
    if(raw&&(JSON.parse(raw.draft) as {contract_version?:string}).contract_version===FCL_NOTIFICATION_V2){
      const current=this.getFclNotificationV2(ctx),rows=structuredClone(current.rows),intake=rows.find(row=>row.node_id==='intake')!;
      intake.assignment={...intake.assignment,to:change.data.input.recipient||null,cc:change.data.input.cc,enabled:change.data.input.enabled};
      const saved=this.saveNotificationV2(ctx,{contract_version:FCL_NOTIFICATION_V2,expected_version:change.data.expected_version,rows,confirmed:true},key,change.data);
      return this.fclNotificationView(scope,{replayed:saved.replay,submitted_version:change.data.expected_version+1,current:saved.version===change.data.expected_version+1});
    }
    const db = this.store.db, partition = JSON.stringify([scope, 'fcl-notification', 'save']), actionDigest = digest(change.data);
    this.#fclNotificationTransaction.begin(db,'native_readback_failed');
    let committed = false;
    try {
      const old = db.prepare('SELECT digest,result FROM native_idempotency WHERE scope=? AND key=?').get(partition, key) as { digest: string; result: string } | undefined;
      if (old) {
        if (old.digest !== actionDigest) throw new PortalError('idempotency_conflict');
        let submitted:ReturnType<NativeAdminService['fclNotificationView']>;
        try{submitted=fclNotificationViewSchema.parse(JSON.parse(old.result) as unknown);}catch{throw new PortalError('native_readback_failed');}
        this.#fclNotificationTransaction.commit(db);committed=true;
        const current=this.fclNotificationView(scope);
        return this.fclNotificationView(scope,{replayed:true,submitted_version:submitted.version,current:current.version===submitted.version&&JSON.stringify(current.input)===JSON.stringify(submitted.input)});
      }
      const current = this.fclNotificationView(scope);
      if (current.version !== change.data.expected_version) throw new PortalError('version_conflict');
      const next = fclNotificationViewSchema.parse({ contract_version: FCL_NOTIFICATION_VERSION, version: current.version + 1, input: change.data.input, replay:{replayed:false,submitted_version:null,current:true} });
      db.prepare("INSERT INTO native_configs(scope,kind,version,draft,active) VALUES(?,?,?,?,NULL) ON CONFLICT(scope,kind) DO UPDATE SET version=excluded.version,draft=excluded.draft,active=NULL")
        .run(scope, 'fcl-notification', next.version, JSON.stringify(next.input));
      const auditId = randomUUID(), createdAt = options.now();
      db.prepare('INSERT INTO native_audit VALUES(?,?,?,?,?,?,?)').run(auditId, scope, 'fcl-notification', ctx.identity.userId, 'save', actionDigest, createdAt);
      db.prepare('INSERT INTO native_idempotency VALUES(?,?,?,?)').run(partition, key, actionDigest, JSON.stringify(next));
      this.assertFclNotificationCommitted(scope,next,auditId,createdAt,actionDigest,partition,key,ctx.identity.userId);
      this.#fclNotificationTransaction.commit(db); committed = true;
      this.assertFclNotificationCommitted(scope,next,auditId,createdAt,actionDigest,partition,key,ctx.identity.userId);
      return this.fclNotificationView(scope);
    } catch (error) {
      if (!committed) this.#fclNotificationTransaction.rollbackOnFailure(db);
      throw error;
    }
  }
  getFclNotificationV2(ctx:PortalContext){
    this.fclReceiverScope(ctx);return this.readFclNotificationForDispatch(ctx.identity.userId);
  }
  // Service identity port: owner is resolved from a persisted case, never from an HTTP owner override.
  readFclNotificationForDispatch(ownerId:string){
    const scope=`fcl-person:${ownerId}`;
    const row=this.store.db.prepare("SELECT version,draft FROM native_configs WHERE scope=? AND kind='fcl-notification'").get(scope) as {version:number;draft:string}|undefined;
    let config=emptyFclNotificationConfig();
    if(row){
      let raw:unknown;try{raw=JSON.parse(row.draft);}catch{throw new PortalError('native_readback_failed');}
      if((raw as {contract_version?:string})?.contract_version===FCL_NOTIFICATION_V2){
        const parsed=fclNotificationV2ConfigSchema.safeParse(raw);if(!parsed.success||parsed.data.version!==row.version)throw new PortalError('native_readback_failed');config=parsed.data;
      }else{
        const old=this.fclNotificationView(scope);config.version=row.version;
        config.rows[0]!.assignment={responsible_id:ownerId,collaborator_ids:[],to:old.input?.recipient||null,cc:old.input?.cc??[],enabled:old.input?.enabled??false};
      }
    }
    if(new Set(config.rows.map(row=>row.node_id)).size!==10)throw new PortalError('native_readback_failed');
    return fclNotificationV2ViewSchema.parse({...config,transport:this.mailConfigured()?'configured_unverified':'unconfigured',replay:false});
  }
  saveFclNotificationV2(ctx:PortalContext,input:unknown,key:string){return this.saveNotificationV2(ctx,input,key);}
  private saveNotificationV2(ctx:PortalContext,input:unknown,key:string,legacy?:unknown){
    const options=this.fclReceiverScope(ctx),scope=options.scope,change=fclNotificationV2SaveSchema.safeParse(input);
    if(!change.success||new Set(change.data.rows.map(row=>row.node_id)).size!==10)throw new PortalError('native_input_invalid');
    if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    for(const row of change.data.rows){
      if(['intake','quote','customer_followup'].includes(row.node_id)&&row.external_enabled)throw new PortalError('native_input_invalid');
      const people=[row.assignment.responsible_id,...row.assignment.collaborator_ids].filter((id):id is string=>id!==null);
      if(new Set(people).size!==people.length)throw new PortalError('native_input_invalid');
      if(['intake','quote','customer_followup'].includes(row.node_id)&&people.some(person=>person!==ctx.identity.userId))throw new PortalError('fcl_quote_owner_required');
      if(people.some(person=>person!==ctx.identity.userId&&!this.fclExecutionPersonActive(person)))throw new PortalError('fcl_execution_responsible_unavailable');
      for(const addresses of [[row.assignment.to,...row.assignment.cc],[row.external_to,...row.external_cc]]){const actual=addresses.filter(Boolean);if(new Set(actual).size!==actual.length)throw new PortalError('native_input_invalid');}
    }
    const db=this.store.db,partition=JSON.stringify([scope,'fcl-notification',legacy?'save':'save-v2']),actionDigest=digest(legacy??change.data);
    this.#fclNotificationTransaction.begin(db,'native_readback_failed');let committed=false;
    try{
      const old=db.prepare('SELECT digest,result FROM native_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
      if(old){if(old.digest!==actionDigest)throw new PortalError('idempotency_conflict');this.#fclNotificationTransaction.commit(db);committed=true;return {...this.getFclNotificationV2(ctx),replay:true};}
      const current=this.getFclNotificationV2(ctx);if(current.version!==change.data.expected_version)throw new PortalError('version_conflict');
      const next=fclNotificationV2ConfigSchema.parse({contract_version:FCL_NOTIFICATION_V2,version:current.version+1,rows:change.data.rows});
      const serialized=JSON.stringify(next),auditId=randomUUID(),created=options.now();
      db.prepare("INSERT INTO native_configs(scope,kind,version,draft,active) VALUES(?,?,?,?,NULL) ON CONFLICT(scope,kind) DO UPDATE SET version=excluded.version,draft=excluded.draft,active=NULL").run(scope,'fcl-notification',next.version,serialized);
      db.prepare('INSERT INTO native_audit VALUES(?,?,?,?,?,?,?)').run(auditId,scope,'fcl-notification',ctx.identity.userId,'save-v2',actionDigest,created);
      db.prepare('INSERT INTO native_idempotency VALUES(?,?,?,?)').run(partition,key,actionDigest,serialized);
      const readback=()=>{
        const actual=this.getFclNotificationV2(ctx),audit=db.prepare('SELECT actor,digest,created FROM native_audit WHERE id=?').get(auditId) as {actor:string;digest:string;created:string}|undefined;
        const idem=db.prepare('SELECT digest,result FROM native_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
        if(actual.version!==next.version||JSON.stringify(actual.rows)!==JSON.stringify(next.rows)||audit?.actor!==ctx.identity.userId||audit.digest!==actionDigest||audit.created!==created||idem?.digest!==actionDigest||idem.result!==serialized)throw new PortalError('native_readback_failed');return actual;
      };
      readback();this.#fclNotificationTransaction.commit(db);committed=true;return readback();
    }catch(error){if(!committed)this.#fclNotificationTransaction.rollbackOnFailure(db);throw error;}
  }
  previewFclNotification(ctx:PortalContext,input:unknown){
    const request=fclNotificationPreviewRequestSchema.safeParse(input);if(!request.success)throw new PortalError('native_input_invalid');
    const config=this.getFclNotificationV2(ctx),row=config.rows.find(row=>row.node_id===request.data.node_id)!;
    const internal=request.data.audience==='internal';
    return fclNotificationPreviewOutputSchema.parse({to:internal?row.assignment.to:row.external_to,cc:internal?row.assignment.cc:row.external_cc,subject:`[测试] ${FCL_NODE_LABELS[row.node_id]}通知`,body:renderNotificationTestBody(row,request.data.audience),transport:this.notificationTransport?'configured_unverified':'unconfigured',status:'preview',reason_code:null});
  }
  async testFclNotification(ctx:PortalContext,input:unknown,key:string){
    const request=fclNotificationTestSchema.safeParse(input);if(!request.success)throw new PortalError('native_input_invalid');
    if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    const authority=this.fclReceiverScope(ctx),scope=JSON.stringify([authority.scope,'fcl-notification-test']),actionDigest=digest(request.data),db=this.store.db;
    let result=this.previewFclNotification(ctx,{node_id:request.data.node_id,audience:request.data.audience});
    let replay=false,committed=false;
    this.#fclNotificationTransaction.begin(db,'native_readback_failed');
    try{
      const old=db.prepare('SELECT digest,result FROM native_idempotency WHERE scope=? AND key=?').get(scope,key) as {digest:string;result:string}|undefined;
      if(old){if(old.digest!==actionDigest)throw new PortalError('idempotency_conflict');result=fclNotificationPreviewOutputSchema.parse(JSON.parse(old.result));replay=true;}
      else{
        if(this.getFclNotificationV2(ctx).version!==request.data.expected_version)throw new PortalError('version_conflict');
        if(!result.to)throw new PortalError('fcl_mail_recipient_needs_input');
        if(!this.notificationTransport)throw new PortalError('fcl_mail_transport_not_configured');
        const since=new Date(Date.parse(authority.now())-60_000).toISOString();
        if((db.prepare("SELECT count(*) AS n FROM native_audit WHERE scope=? AND kind='fcl-notification' AND action='test' AND created>=?").get(authority.scope,since) as {n:number}).n>=3)throw new PortalError('fcl_rate_limited');
        result={...result,status:'unknown',reason_code:'test_result_unknown'};
        db.prepare('INSERT INTO native_audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(),authority.scope,'fcl-notification',ctx.identity.userId,'test',actionDigest,authority.now());
        db.prepare('INSERT INTO native_idempotency VALUES(?,?,?,?)').run(scope,key,actionDigest,JSON.stringify(result));
        const read=db.prepare('SELECT result FROM native_idempotency WHERE scope=? AND key=?').get(scope,key) as {result:string};if(read.result!==JSON.stringify(result))throw new PortalError('native_readback_failed');
      }
      this.#fclNotificationTransaction.commit(db);committed=true;
    }catch(error){if(!committed)this.#fclNotificationTransaction.rollbackOnFailure(db);throw error;}
    if(replay)return result;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([Promise.resolve(this.notificationTransport!.send({to:result.to!,cc:result.cc,subject:result.subject,body:result.body})),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('fcl_smtp_timeout')),10_000);})]);
      result={...result,status:'smtp_accepted',reason_code:null};
    }catch(error){const rejected=error instanceof Error&&error.message==='fcl_smtp_rejected';result={...result,status:rejected?'failed':'unknown',reason_code:rejected?'smtp_rejected':'smtp_result_unknown'};}
    finally{if(timer)clearTimeout(timer);}
    // A post-send persistence failure leaves the reserved unknown record; it never causes an implicit resend.
    db.prepare('UPDATE native_idempotency SET result=? WHERE scope=? AND key=? AND digest=?').run(JSON.stringify(result),scope,key,actionDigest);
    const read=db.prepare('SELECT result FROM native_idempotency WHERE scope=? AND key=?').get(scope,key) as {result:string};
    if(read.result!==JSON.stringify(result))throw new PortalError('native_readback_failed');return result;
  }
  private fclExecutionPersonActive(id:string):boolean{
    // The legacy receiver predicate is not an account directory.
    try{return this.executionPeople?.(id)===true;}catch{return false;}
  }
  withFclReadLock<T>(ctx: PortalContext, operation: () => T extends Promise<unknown> ? never : T): T {
    this.scope(ctx, false, 'fcl');
    if (Object.prototype.toString.call(operation) === '[object AsyncFunction]') throw new PortalError('fcl_read_lock_async_forbidden');
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      if (result !== null && typeof result === 'object' && 'then' in result) {
        throw new PortalError('fcl_read_lock_async_forbidden');
      }
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the operation or commit error. */ }
      throw error;
    }
  }
  preview(ctx: PortalContext, kind: NativeKind, releaseId?: string) {
    const scope = this.scope(ctx, false, kind), row = this.row(scope, kind);
    if (!row) throw new PortalError('native_draft_missing');
    let input = JSON.parse(row.draft) as unknown;
    if (kind === 'fcl') {
      try { input = fclRateDatasetSchema.parse(input); }
      catch { throw new PortalError('native_publication_blocked'); }
    }
    if (kind === 'fcl' && releaseId) input = this.fclRelease(scope, releaseId).input;
    if (kind !== 'fcl' && releaseId) {
      const release = this.store.db.prepare('SELECT payload FROM native_releases WHERE id=? AND scope=? AND kind=?').get(releaseId, scope, kind) as { payload: string } | undefined;
      if (!release) throw new PortalError('native_release_not_found');
      input = (JSON.parse(release.payload) as NativePublication).input;
    }
    const blockers = this.problems(kind, input);
    return {
      kind,
      version: row.version,
      input,
      release_id: releaseId ?? null,
      preview_hash: digest([scope, kind, row.version, input, releaseId ?? null]),
      can_publish: blockers.length === 0,
      blockers,
    };
  }
  private verifyFclAudit(scope: string, action: string, actionDigest: string, actor: string) {
    const row = this.store.db.prepare(`SELECT scope,kind,actor,action,digest FROM native_audit
      WHERE scope=? AND kind='fcl' ORDER BY rowid DESC LIMIT 1`).get(scope) as
      { scope: string; kind: string; actor: string; action: string; digest: string } | undefined;
    if (!row || row.scope !== scope || row.kind !== 'fcl' || row.actor !== actor || row.action !== action || row.digest !== actionDigest) {
      throw new PortalError('native_readback_failed');
    }
  }
  private verifyFclDraft(scope: string, expectedVersion: number, expectedInput: unknown, expectedActive: string | null, action: string, actionDigest: string, actor: string) {
    const row = this.row(scope, 'fcl');
    if (!row || row.version !== expectedVersion || row.active !== expectedActive || row.draft !== JSON.stringify(expectedInput)) {
      throw new PortalError('native_readback_failed');
    }
    try {
      const draft = fclRateDatasetSchema.parse(JSON.parse(row.draft) as unknown);
      if (validateFclRateDataset(draft).length > 0) throw new Error('invalid draft');
    } catch {
      throw new PortalError('native_readback_failed');
    }
    this.verifyFclAudit(scope, action, actionDigest, actor);
  }
  private verifyFclRelease(scope: string, expectedRelease: FclRatePublication, expectedVersion: number, action: string, actionDigest: string, actor: string) {
    const release = this.fclRelease(scope, expectedRelease.release_id);
    const row = this.row(scope, 'fcl');
    if (!row || row.version !== expectedVersion || row.active !== expectedRelease.release_id ||
      JSON.stringify(release) !== JSON.stringify(expectedRelease)) {
      throw new PortalError('native_readback_failed');
    }
    this.verifyFclAudit(scope, action, actionDigest, actor);
  }
  private mutate(
    ctx: PortalContext,
    kind: NativeKind,
    action: string,
    input: unknown,
    key: string,
    write: (scope: string) => void,
    verify?: (scope: string, actionDigest: string) => void,
  ) {
    const scope = this.scope(ctx, true, kind);
    if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(key)) throw new PortalError('idempotency_key_invalid');
    const db = this.store.db, partition = JSON.stringify([scope, ctx.identity.userId, kind, action]), actionDigest = digest(input);
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const old = db.prepare('SELECT digest,result FROM native_idempotency WHERE scope=? AND key=?').get(partition, key) as { digest: string; result: string } | undefined;
      if (old) {
        if (old.digest !== actionDigest) throw new PortalError('idempotency_conflict');
        if (kind === 'fcl') {
          db.exec('COMMIT');
          committed = true;
          return this.get(ctx, kind);
        }
        db.exec('COMMIT');
        committed = true;
        return JSON.parse(old.result) as ReturnType<NativeAdminService['get']>;
      }
      write(scope);
      db.prepare('INSERT INTO native_audit VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), scope, kind, ctx.identity.userId, action, actionDigest, this.time(kind));
      if (kind === 'fcl') {
        if (!verify) throw new PortalError('native_readback_failed');
        verify(scope, actionDigest);
      }
      const result = this.get(ctx, kind);
      db.prepare('INSERT INTO native_idempotency VALUES(?,?,?,?)').run(partition, key, actionDigest, JSON.stringify(result));
      db.exec('COMMIT');
      committed = true;
      return this.get(ctx, kind);
    } catch (error) {
      if (!committed) db.exec('ROLLBACK');
      throw error;
    }
  }
  private expected(scope: string, kind: NativeKind, version: number) {
    const row = this.row(scope, kind);
    if ((row?.version ?? 0) !== version) throw new PortalError('version_conflict');
    if (version >= 1000) throw new PortalError('native_version_limit');
    return row;
  }
  save(ctx: PortalContext, kind: NativeKind, input: unknown, key: string) {
    const parsed = (kind === 'customs'
      ? customsSaveSchema
      : kind === 'residential'
        ? residentialSaveSchema
        : kind === 'fcl'
          ? fclRateSaveSchema
          : maritimeSaveSchema(kind)).safeParse(input);
    if (!parsed.success) throw new PortalError('native_input_invalid');
    const change = parsed.data;
    let savedInput=change.input;
    let expectedActive: string | null = null;
    return this.mutate(ctx, kind, 'save', change, key, (scope) => {
      expectedActive = this.expected(scope, kind, change.expected_version)?.active ?? null;
      if(kind==='fcl')savedInput=prepareFclMaintenance(change.input as FclRateDataset,this.fclGet(scope).draft,this.time(kind));
      this.store.db.prepare('INSERT INTO native_configs VALUES(?,?,?,?,NULL) ON CONFLICT(scope,kind) DO UPDATE SET draft=excluded.draft,version=excluded.version')
        .run(scope, kind, change.expected_version + 1, JSON.stringify(savedInput));
    }, kind === 'fcl'
      ? (scope, actionDigest) => this.verifyFclDraft(scope, change.expected_version + 1, savedInput, expectedActive, 'save', actionDigest, ctx.identity.userId)
      : undefined);
  }
  publish(ctx: PortalContext, kind: NativeKind, input: unknown, key: string) {
    const parsed = nativePublishSchema.safeParse(input);
    if (!parsed.success) throw new PortalError('native_input_invalid');
    const publish = parsed.data;
    let expectedRelease: NativePublication<FclRateDataset> | null = null;
    return this.mutate(ctx, kind, 'publish', publish, key, (scope) => {
      this.expected(scope, kind, publish.expected_version);
      const preview = this.preview(ctx, kind);
      if (preview.preview_hash !== publish.preview_hash) throw new PortalError('native_preview_mismatch');
      if (!preview.can_publish) throw new PortalError('native_publication_blocked');
      const release: NativePublication<NativeInput> = {
        release_id: randomUUID(),
        version: publish.expected_version + 1,
        input: preview.input as NativeInput,
        published_at: this.time(kind),
        digest: digest(preview.input),
      };
      if (kind === 'fcl') expectedRelease = release as NativePublication<FclRateDataset>;
      this.store.db.prepare('INSERT INTO native_releases VALUES(?,?,?,?)').run(release.release_id, scope, kind, JSON.stringify(release));
      this.store.db.prepare('UPDATE native_configs SET active=?,version=version+1 WHERE scope=? AND kind=?').run(release.release_id, scope, kind);
      if(kind==='fcl')this.fclOperations.reprice(ctx,release as FclRatePublication);
    }, kind === 'fcl'
      ? (scope, actionDigest) => {
          if (!expectedRelease) throw new PortalError('native_readback_failed');
          this.verifyFclRelease(scope, expectedRelease, expectedRelease.version, 'publish', actionDigest, ctx.identity.userId);
        }
      : undefined);
  }
  disable(ctx: PortalContext, kind: NativeKind, input: unknown, key: string) {
    const parsed = nativeDisableSchema.safeParse(input);
    if (!parsed.success) throw new PortalError('native_input_invalid');
    const disable = parsed.data;
    return this.mutate(ctx, kind, 'disable', disable, key, (scope) => {
      if (!this.expected(scope, kind, disable.expected_version)) throw new PortalError('native_draft_missing');
      this.store.db.prepare('UPDATE native_configs SET active=NULL,version=version+1 WHERE scope=? AND kind=?').run(scope, kind);
    }, kind === 'fcl'
      ? (scope, actionDigest) => {
          const row = this.row(scope, 'fcl');
          if (!row || row.version !== disable.expected_version + 1 || row.active !== null) throw new PortalError('native_readback_failed');
          this.verifyFclAudit(scope, 'disable', actionDigest, ctx.identity.userId);
        }
      : undefined);
  }
  rollback(ctx: PortalContext, kind: NativeKind, input: unknown, key: string) {
    const parsed = nativeRollbackSchema.safeParse(input);
    if (!parsed.success) throw new PortalError('native_input_invalid');
    const rollback = parsed.data;
    let expectedRelease: NativePublication<FclRateDataset> | null = null;
    return this.mutate(ctx, kind, 'rollback', rollback, key, (scope) => {
      this.expected(scope, kind, rollback.expected_version);
      const preview = this.preview(ctx, kind, rollback.release_id);
      if (preview.preview_hash !== rollback.preview_hash || !preview.can_publish) throw new PortalError('native_preview_mismatch');
      if (kind === 'fcl') {
        const release: NativePublication<FclRateDataset> = {
          release_id: randomUUID(),
          version: rollback.expected_version + 1,
          input: preview.input as FclRateDataset,
          published_at: this.time(kind),
          digest: digest(preview.input),
        };
        expectedRelease = release;
        this.store.db.prepare('INSERT INTO native_releases VALUES(?,?,?,?)').run(release.release_id, scope, kind, JSON.stringify(release));
        this.store.db.prepare('UPDATE native_configs SET active=?,version=version+1 WHERE scope=? AND kind=?').run(release.release_id, scope, kind);
        this.fclOperations.reprice(ctx,release);
      } else {
        this.store.db.prepare('UPDATE native_configs SET active=?,version=version+1 WHERE scope=? AND kind=?').run(rollback.release_id, scope, kind);
      }
    }, kind === 'fcl'
      ? (scope, actionDigest) => {
          if (!expectedRelease) throw new PortalError('native_readback_failed');
          this.verifyFclRelease(scope, expectedRelease, expectedRelease.version, 'rollback', actionDigest, ctx.identity.userId);
        }
      : undefined);
  }
}
