import { createHash, randomUUID } from 'node:crypto';
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
import type { PortalService } from './service';
import {
  nativePublishSchema,
  nativeDisableSchema,
  nativeRollbackSchema,
  customsSaveSchema,
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
  readonly #fcl: NormalizedFclOptions | null;
  constructor(
    private store: NativeAdminStore,
    private portal: Pick<PortalService, 'getState'>,
    fcl?: FclNativeAdminOptions,
  ) {
    this.#fcl = fcl ? this.normalizeFclOptions(fcl) : null;
    if (this.#fcl !== null) this.assertFclStartup(this.#fcl);
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
    const scopes = this.store.db.prepare(`SELECT scope FROM native_configs WHERE kind='fcl'
      UNION SELECT scope FROM native_releases WHERE kind='fcl'
      UNION SELECT scope FROM native_audit WHERE kind='fcl'`).all() as { scope: string }[];
    if (scopes.some((row) => row.scope !== options.scope)) throw new Error('fcl_receiver_configuration_mismatch');
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
  private scope(ctx: PortalContext, write = false, kind?: NativeKind) {
    if (kind === 'fcl') {
      const options = this.fclOptions();
      if (!ctx.identity.emailVerified || ctx.organizationId !== null || ctx.identity.userId !== options.receiverUserId) {
        throw new PortalError('fcl_not_found');
      }
      try {
        if (!options.receiverIsActive(options.receiverUserId)) throw new PortalError('fcl_unavailable');
      } catch (error) {
        if (error instanceof PortalError && error.code === 'fcl_unavailable') throw error;
        throw new PortalError('fcl_unavailable');
      }
      return options.scope;
    }
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
    let expectedActive: string | null = null;
    return this.mutate(ctx, kind, 'save', change, key, (scope) => {
      expectedActive = this.expected(scope, kind, change.expected_version)?.active ?? null;
      this.store.db.prepare('INSERT INTO native_configs VALUES(?,?,?,?,NULL) ON CONFLICT(scope,kind) DO UPDATE SET draft=excluded.draft,version=excluded.version')
        .run(scope, kind, change.expected_version + 1, JSON.stringify(change.input));
    }, kind === 'fcl'
      ? (scope, actionDigest) => this.verifyFclDraft(scope, change.expected_version + 1, change.input, expectedActive, 'save', actionDigest, ctx.identity.userId)
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
