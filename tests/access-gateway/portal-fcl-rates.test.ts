import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { NativeAdminService, NativeAdminStore } from '../../services/access-gateway/portal/native-admin';
import type { PortalContext } from '../../services/access-gateway/portal/contracts';
import { FCL_RATE_DATASET_VERSION, type FclRateDataset } from '../../services/quote-native/fcl-contracts';

const receiverId = 'fcl-rate-receiver';
const receiver: PortalContext = {
  organizationId: null,
  identity: {
    userId: receiverId,
    displayName: 'FCL Rate Receiver',
    email: 'receiver@example.test',
    emailVerified: true,
    platformRole: null,
  },
};
const other: PortalContext = {
  organizationId: null,
  identity: { ...receiver.identity, userId: 'other-person', email: 'other@example.test' },
};
const operator: PortalContext = {
  organizationId: null,
  identity: { ...receiver.identity, userId: 'operator', platformRole: 'operator' },
};
const organization: PortalContext = { ...receiver, organizationId: 'org-a' };
const portal = { getState: () => ({ data: { current_organization: null, memberships: [] } }) };
const upgradeOptions = {
  fcl: { mode: 'fresh_fixture', authorized: true, oldWritersStopped: true },
} as const;
const reopenOptions = { fcl: { mode: 'reopen' } } as const;

function dataset(label = 'Synthetic FCL rates', freight = '1850.00'): FclRateDataset {
  return {
    contract_version: FCL_RATE_DATASET_VERSION,
    label,
    rates: [{
      rate_id: '00000000-0000-4000-8000-000000000101',
      supplier_label: 'Synthetic direct carrier',
      pol: 'Yantian',
      pod: 'Vancouver',
      valid_from: '2026-10-01',
      valid_until: '2026-12-31',
      source_ref: 'synthetic:source:1',
      source_version: 'v1',
      note: null,
      items: [
        { container_type: '40HQ', ocean_freight: freight, currency: 'USD' },
        { container_type: '20GP', ocean_freight: '1200.00', currency: 'USD' },
      ],
      additional_fees: [{
        name: 'Pickup',
        group: 'A',
        service: 'pickup',
        unit: 'CNTR',
        container_type: '40HQ',
        cost_price: '250',
        currency: 'CNY',
        note: null,
      }],
    }],
  };
}

function serviceFor(store: NativeAdminStore, active: () => boolean = () => true, now: () => string = () => '2026-09-20T12:00:00.000Z') {
  return new NativeAdminService(store, portal as never, {
    receiverUserId: receiverId,
    receiverIsActive: active,
    now,
  });
}

it('completes save, preview, publish, disable and a new-release rollback without reviving the old release', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-rates-lifecycle-'));
  const path = join(root, 'native.sqlite');
  let store = new NativeAdminStore(path, upgradeOptions);
  try {
    const service = serviceFor(store);
    expect(service.get(receiver, 'fcl').draft).toBeNull();
    service.save(receiver, 'fcl', { expected_version: 0, input: dataset('Original release', '1850.00') }, 'fcl-rate-save-key-0001');
    const firstPreview = service.preview(receiver, 'fcl');
    expect(firstPreview.can_publish).toBe(true);
    const first = service.publish(receiver, 'fcl', {
      expected_version: 1,
      preview_hash: firstPreview.preview_hash,
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-rate-publish-key-0001');
    const r2 = first.active_release!;
    expect(r2.version).toBe(2);
    expect(first.version).toBe(2);

    service.save(receiver, 'fcl', { expected_version: 2, input: dataset('Changed release', '1900.00') }, 'fcl-rate-save-key-0002');
    const secondPreview = service.preview(receiver, 'fcl');
    const second = service.publish(receiver, 'fcl', {
      expected_version: 3,
      preview_hash: secondPreview.preview_hash,
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-rate-publish-key-0002');
    const r4 = second.active_release!;
    expect(r4.version).toBe(4);
    expect(r4.input.label).toBe('Changed release');

    service.disable(receiver, 'fcl', { expected_version: 4 }, 'fcl-rate-disable-key-0001');
    const oldPreview = service.preview(receiver, 'fcl', r2.release_id);
    const rolled = service.rollback(receiver, 'fcl', {
      expected_version: 5,
      release_id: r2.release_id,
      preview_hash: oldPreview.preview_hash,
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-rate-rollback-key-01');
    const r6 = rolled.active_release!;
    expect(r6.release_id).not.toBe(r2.release_id);
    expect(r6.version).toBe(6);
    expect(r6.input).toEqual(r2.input);
    expect(r6.digest).toBe(r2.digest);
    expect(rolled.version).toBe(6);
    expect(rolled.history.map((item) => item.version)).toEqual([6, 4, 2]);

    store.close();
    store = new NativeAdminStore(path, reopenOptions);
    const reopened = serviceFor(store).get(receiver, 'fcl');
    expect(reopened.active_release?.release_id).toBe(r6.release_id);
    expect(reopened.active_release?.version).toBe(6);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('enforces CAS, preview integrity and idempotent replay with current-state reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-rates-cas-'));
  const store = new NativeAdminStore(join(root, 'native.sqlite'), upgradeOptions);
  try {
    const service = serviceFor(store);
    service.save(receiver, 'fcl', { expected_version: 0, input: dataset() }, 'fcl-cas-save-key-0001');
    const preview = service.preview(receiver, 'fcl');
    expect(() => service.publish(receiver, 'fcl', {
      expected_version: 1,
      preview_hash: '0'.repeat(64),
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-cas-publish-key-01')).toThrow('native_preview_mismatch');
    expect(() => service.save(receiver, 'fcl', { expected_version: 0, input: dataset('Stale') }, 'fcl-cas-save-key-0002'))
      .toThrow('version_conflict');
    const current = service.save(receiver, 'fcl', { expected_version: 1, input: dataset('Current') }, 'fcl-cas-save-key-0003');
    expect(current.version).toBe(2);
    expect(() => service.publish(receiver, 'fcl', {
      expected_version: 2,
      preview_hash: preview.preview_hash,
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-cas-publish-key-02')).toThrow('native_preview_mismatch');

    expect(service.save(receiver, 'fcl', { expected_version: 1, input: dataset('Current') }, 'fcl-cas-save-key-0003').version).toBe(2);
    expect(() => service.save(receiver, 'fcl', { expected_version: 1, input: dataset('Different') }, 'fcl-cas-save-key-0003'))
      .toThrow('idempotency_conflict');
    const livePreview = service.preview(receiver, 'fcl');
    const published = service.publish(receiver, 'fcl', {
      expected_version: 2,
      preview_hash: livePreview.preview_hash,
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-cas-publish-key-03');
    const releaseCount = Number((store.db.prepare("SELECT COUNT(*) AS n FROM native_releases WHERE kind='fcl'").get() as { n: number }).n);
    service.publish(receiver, 'fcl', {
      expected_version: 2,
      preview_hash: livePreview.preview_hash,
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-cas-publish-key-03');
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM native_releases WHERE kind='fcl'").get()).toEqual({ n: releaseCount });
    expect(service.get(receiver, 'fcl').active_release?.release_id).toBe(published.active_release?.release_id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('isolates FCL rates per account regardless of enterprise selection or platform roles', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-rates-auth-'));
  const path = join(root, 'native.sqlite');
  let store = new NativeAdminStore(path, upgradeOptions);
  let active = true;
  let throwFromReceiver = false;
  try {
    const service = serviceFor(store, () => {
      if (throwFromReceiver) throw new Error('sensitive callback failure');
      return active;
    });
    service.save(receiver, 'fcl', { expected_version: 0, input: dataset() }, 'fcl-auth-save-key-0001');
    expect(service.get(other, 'fcl').draft).toBeNull();
    expect(service.get(operator, 'fcl').draft).toBeNull();
    expect(service.get(organization, 'fcl').version).toBe(1);
    expect(() => service.save(other, 'fcl', { expected_version: 1, input: dataset('Other') }, 'fcl-auth-save-key-0002'))
      .toThrow('version_conflict');
    active = false;
    expect(() => service.get(receiver, 'fcl')).toThrow('fcl_unavailable');
    active = true;
    throwFromReceiver = true;
    expect(() => service.get(receiver, 'fcl')).toThrow('fcl_unavailable');
    throwFromReceiver = false;
    expect(() => new NativeAdminService(store, portal as never).get(receiver, 'fcl')).toThrow('fcl_unavailable');
    store.close();
    store = new NativeAdminStore(path, reopenOptions);
    expect(() => new NativeAdminService(store, portal as never, {
      receiverUserId: 'different-receiver',
      receiverIsActive: () => true,
    }).get(other,'fcl')).not.toThrow();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('fails closed on corrupt active release payload and rolls back a semantically mismatched publish', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-rates-corrupt-'));
  const store = new NativeAdminStore(join(root, 'native.sqlite'), upgradeOptions);
  try {
    const service = serviceFor(store);
    service.save(receiver, 'fcl', { expected_version: 0, input: dataset() }, 'fcl-corrupt-save-key-01');
    const preview = service.preview(receiver, 'fcl');
    const published = service.publish(receiver, 'fcl', {
      expected_version: 1,
      preview_hash: preview.preview_hash,
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-corrupt-publish-k1');
    const releaseId = published.active_release!.release_id;
    const originalPayload = (store.db.prepare('SELECT payload FROM native_releases WHERE id=?').get(releaseId) as { payload: string }).payload;
    const originalRelease = JSON.parse(originalPayload) as Record<string, unknown>;
    const corruptions: Record<string, unknown>[] = [
      { ...originalRelease, input: dataset('Corrupted').rates },
      { ...originalRelease, version: 'bad' },
      { ...originalRelease, version: 2.5 },
      { ...originalRelease, published_at: 'not-a-date' },
      { ...originalRelease, extra_metadata: 'forbidden' },
      { ...originalRelease, release_id: '00000000-0000-4000-8000-000000000999' },
    ];
    for (const corrupted of corruptions) {
      store.db.prepare('UPDATE native_releases SET payload=? WHERE id=?').run(JSON.stringify(corrupted), releaseId);
      expect(() => service.get(receiver, 'fcl')).toThrow('native_publication_blocked');
    }
    store.db.prepare('UPDATE native_releases SET payload=? WHERE id=?').run(originalPayload, releaseId);
    expect(service.get(receiver, 'fcl').active_release?.release_id).toBe(releaseId);
    const originalDraft = (store.db.prepare('SELECT draft FROM native_configs WHERE scope=? AND kind=?')
      .get(`fcl-person:${receiverId}`, 'fcl') as { draft: string }).draft;
    store.db.prepare('UPDATE native_configs SET draft=? WHERE scope=? AND kind=?')
      .run('{"broken":true}', `fcl-person:${receiverId}`, 'fcl');
    expect(() => service.get(receiver, 'fcl')).toThrow('native_publication_blocked');
    store.db.prepare('UPDATE native_configs SET draft=? WHERE scope=? AND kind=?')
      .run(originalDraft, `fcl-person:${receiverId}`, 'fcl');

    store.db.prepare('DELETE FROM native_releases WHERE id=?').run(releaseId);
    store.db.prepare('UPDATE native_configs SET active=NULL,version=0 WHERE scope=? AND kind=?').run(`fcl-person:${receiverId}`, 'fcl');
    service.save(receiver, 'fcl', { expected_version: 0, input: dataset('Fault injection') }, 'fcl-corrupt-save-key-02');
    const faultPreview = service.preview(receiver, 'fcl');
    const before = {
      releases: store.db.prepare("SELECT COUNT(*) AS n FROM native_releases WHERE kind='fcl'").get(),
      audits: store.db.prepare("SELECT COUNT(*) AS n FROM native_audit WHERE kind='fcl'").get(),
      config: store.db.prepare('SELECT version,active FROM native_configs WHERE scope=? AND kind=?').get(`fcl-person:${receiverId}`, 'fcl'),
    };
    store.db.exec(`CREATE TRIGGER fcl_rate_tamper_release
      AFTER INSERT ON native_releases
      WHEN NEW.kind='fcl'
      BEGIN
        UPDATE native_releases SET payload=json_set(NEW.payload,'$.published_at','2026-01-01T00:00:00.000Z') WHERE id=NEW.id;
      END;`);
    expect(() => service.publish(receiver, 'fcl', {
      expected_version: 1,
      preview_hash: faultPreview.preview_hash,
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-corrupt-publish-k2')).toThrow('native_readback_failed');
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM native_releases WHERE kind='fcl'").get()).toEqual(before.releases);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM native_audit WHERE kind='fcl'").get()).toEqual(before.audits);
    expect(store.db.prepare('SELECT version,active FROM native_configs WHERE scope=? AND kind=?').get(`fcl-person:${receiverId}`, 'fcl')).toEqual(before.config);
    store.db.exec('DROP TRIGGER fcl_rate_tamper_release');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires controlled schema v3 upgrade and keeps the old v2 reader closed after FCL enablement', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-rates-migration-'));
  const path = join(root, 'native.sqlite');
  try {
    const oldStore = new NativeAdminStore(path);
    expect(oldStore.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    oldStore.close();
    expect(() => new NativeAdminStore(path, {
      fcl: { mode: 'exclusive_verified', authorized: true, oldWritersStopped: true },
    } as never)).toThrow('fcl_upgrade_exclusive_check_required');
    expect(() => new NativeAdminStore(path, {
      fcl: {
        mode: 'exclusive_verified',
        authorized: true,
        oldWritersStopped: true,
        assertExclusive: () => { throw new Error('writer alive'); },
      },
    } as never)).toThrow('fcl_upgrade_exclusive_check_failed');
    const upgraded = new NativeAdminStore(path, upgradeOptions);
    expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    upgraded.close();
    expect(() => new NativeAdminStore(path)).toThrow('portal_database_version_unsupported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects fresh-fixture upgrade when old NativeAdmin business rows already exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-rates-fresh-guard-'));
  const path = join(root, 'native.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE portal_database_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),application_id TEXT NOT NULL);
      INSERT INTO portal_database_identity VALUES(1,'freightclaw-native-business');
      CREATE TABLE native_configs(scope TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL,draft TEXT NOT NULL,active TEXT,PRIMARY KEY(scope,kind));
      CREATE TABLE native_releases(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE native_audit(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,digest TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE native_idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key));
      INSERT INTO native_configs VALUES('org-a','residential',1,'{}',NULL);
      PRAGMA user_version=2;`);
    legacy.close();
    expect(() => new NativeAdminStore(path, upgradeOptions)).toThrow('fcl_upgrade_fresh_fixture_not_empty');
    const unchanged = new NativeAdminStore(path);
    expect(unchanged.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(unchanged.db.prepare('SELECT COUNT(*) AS n FROM native_configs').get()).toEqual({ n: 1 });
    unchanged.close();
    const upgraded = new NativeAdminStore(path, {
      fcl: {
        mode: 'exclusive_verified',
        authorized: true,
        oldWritersStopped: true,
        assertExclusive: () => undefined,
      },
    });
    try {
      expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
      expect(upgraded.db.prepare('SELECT scope,kind,version,draft,active FROM native_configs').get()).toEqual({
        scope: 'org-a',
        kind: 'residential',
        version: 1,
        draft: '{}',
        active: null,
      });
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
