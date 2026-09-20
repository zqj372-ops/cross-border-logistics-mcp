import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { createFclInquiryDraft } from '../../apps/inquiry/fcl-model';
import {
  FCL_CASE_VERSION,
  fclCaseErrorEnvelopeSchema,
  fclCaseInternalViewSchema,
  fclCasePublicSummarySchema,
  fclCaseSubmissionSchema,
  fclCaseSuccessEnvelopeSchema,
} from '../../services/access-gateway/portal/case-contracts';
import { CaseService, CaseStore } from '../../services/access-gateway/portal/cases';
import type { PortalContext } from '../../services/access-gateway/portal/contracts';
import { openPortalProductionDatabase } from '../../services/access-gateway/portal/production-persistence';

const receiverId = 'receiver-a';
const otherId = 'other-a';
const receiverSecret = 'synthetic-fcl-credential-secret-32-bytes';
const receiver: PortalContext = {
  identity: {
    userId: receiverId,
    displayName: 'FCL Receiver',
    email: 'receiver@example.test',
    emailVerified: true,
    platformRole: null,
  },
  organizationId: null,
};
const operator: PortalContext = {
  identity: {
    userId: 'operator-a',
    displayName: 'Platform Operator',
    email: 'operator@example.test',
    emailVerified: true,
    platformRole: 'operator',
  },
  organizationId: null,
};
const other: PortalContext = {
  ...receiver,
  identity: { ...receiver.identity, userId: otherId, email: 'other@example.test' },
};
const portal = { getState: () => ({ data: { current_organization: null, memberships: [] } }) };
const fclUpgradeOptions = {
  fcl: { mode: 'fresh_fixture', authorized: true, oldWritersStopped: true },
} as const;
const fclControlledOfflineOptions = {
  fcl: {
    mode: 'exclusive_verified',
    authorized: true,
    oldWritersStopped: true,
    assertExclusive: () => undefined,
  },
} as const;
const fclReopenOptions = { fcl: { mode: 'reopen' } } as const;
const openFclStore = (path: string, reopen = false) =>
  new CaseStore(path, reopen ? fclReopenOptions : fclUpgradeOptions);

function inquiry() {
  return {
    ...createFclInquiryDraft(),
    origin_city: 'Shenzhen',
    pol: 'Yantian',
    pod: 'Vancouver',
    final_destination: 'Toronto',
    cargo_name: 'Synthetic furniture',
    containers: [{ type: '40HQ' as const, quantity: 2 }],
    cargo_type: 'general' as const,
    estimated_weight: { value: '18000', unit: 'kg' as const },
    cargo_ready_date: '2026-10-08',
    incoterm: 'EXW' as const,
    selected_services: ['pickup', 'export_customs', 'ocean_freight', 'canada_customs', 'delivery'] as const,
    contact: {
      name: 'Synthetic Shipper',
      company: 'Synthetic Co',
      email: 'shipper@example.test',
      phone: '+1 555 0100',
    },
    notes: 'Synthetic FCL inquiry.',
    consent: true,
  };
}

function harness(store: CaseStore, options: {
  receiverUserId?: string;
  active?: () => boolean;
  now?: () => string;
  mailEnabled?: boolean;
  transport?: { send: (message: unknown) => Promise<void> | void };
  ttlDays?: number;
  secret?: string;
} = {}) {
  const send = vi.fn(options.transport?.send ?? (() => undefined));
  const service = new CaseService(store, portal as never, {
    receiverUserId: options.receiverUserId ?? receiverId,
    receiverIsActive: (userId) => userId === (options.receiverUserId ?? receiverId) && (options.active?.() ?? true),
    credentialSecret: options.secret ?? receiverSecret,
    credentialTtlDays: options.ttlDays ?? 30,
    now: options.now ?? (() => '2026-09-20T12:00:00.000Z'),
    mail: {
      enabled: options.mailEnabled ?? true,
      recipient: 'ops@example.test',
      cc: ['cc@example.test'],
      timeoutMs: 25,
      transport: { send },
    },
  });
  return { service, send };
}

it('atomically persists an immutable personal FCL inquiry and returns a restorable credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-cases-'));
  const path = join(root, 'cases.sqlite');
  let store = openFclStore(path);
  const { service, send } = harness(store);
  try {
    const input = inquiry();
    const first = await service.submitFclInquiry('anonymous-session-1', 'fcl-submit-key-0001', input);
    expect(fclCaseSubmissionSchema.parse(first)).toEqual(first);
    expect(first.inquiry_no).toBe('FCL-20260920-0001');
    expect(first.case_status).toBe('submitted');
    expect(first.case_version).toBe(1);
    expect(first.replay).toBe(false);
    expect(first.credential.length).toBeGreaterThanOrEqual(32);
    expect(first.notification.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0]?.[0] as { subject: string; body: string; to: string };
    expect(mail.to).toBe('ops@example.test');
    expect(mail.subject).toBe(`[FCL询价][${first.inquiry_no}] Yantian → Vancouver | 40HQ × 2`);
    expect(mail.body).toContain('Shenzhen');
    expect(mail.body).toContain('40HQ');
    expect(mail.body).toContain('Company: Synthetic Co');
    expect(mail.body).toContain('Phone: +1 555 0100');
    expect(JSON.stringify(mail)).not.toContain(first.credential);

    const row = store.db.prepare('SELECT * FROM fcl_inquiries WHERE fcl_inquiry_id=?').get(first.inquiry_id) as {
      original_payload_json: string;
      original_payload_digest: string;
      credential_hash: string;
    };
    expect(JSON.parse(row.original_payload_json)).toEqual(input);
    expect(row.original_payload_digest).toBe(createHash('sha256').update(row.original_payload_json).digest('hex'));
    expect(row.credential_hash).not.toContain(first.credential);
    expect(() => store.db.prepare('UPDATE fcl_inquiries SET original_payload_json=? WHERE fcl_inquiry_id=?')
      .run('{"changed":true}', first.inquiry_id)).toThrow('fcl_inquiry_immutable');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_cases').get()).toEqual({ n: 1 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_case_events').get()).toEqual({ n: 2 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_case_idempotency').get()).toEqual({ n: 1 });

    const internal = service.getFclCase(receiver, first.case_id);
    expect(fclCaseInternalViewSchema.parse(internal)).toEqual(internal);
    expect(internal.original_input).toEqual(input);
    expect(internal.current_input).toEqual(input);
    expect(internal.events.map((event) => event.kind)).toEqual([
      'fcl_inquiry_submitted',
      'fcl_receiver_assigned',
    ]);
    expect(internal.events[0]?.actor_kind).toBe('anonymous_customer');
    expect(internal.events[0]?.actor_ref).toMatch(/^anonymous:/u);
    expect(internal.events[1]?.actor_kind).toBe('system');
    expect(internal.events[1]?.actor_ref).toBe('system:fcl_receiver_assignment');
    const publicView = service.getFclCustomerView(first.inquiry_id, first.credential);
    expect(fclCasePublicSummarySchema.parse(publicView)).toEqual(publicView);
    expect(publicView.inquiry_no).toBe(first.inquiry_no);
    expect(JSON.stringify(publicView)).not.toContain('events');

    const replay = await service.submitFclInquiry('anonymous-session-1', 'fcl-submit-key-0001', input);
    expect(replay.replay).toBe(true);
    expect(replay.case_id).toBe(first.case_id);
    expect(replay.credential).toBe(first.credential);
    expect(send).toHaveBeenCalledTimes(1);
    store.db.prepare('UPDATE business_cases SET status=?,version=?,input_json=?,updated_at=? WHERE case_id=?')
      .run('needs_input', 2, JSON.stringify({ ...input, cargo_name: 'Updated cargo' }), '2026-09-21T12:00:00.000Z', first.case_id);
    const replayedAfterProcessing = await service.submitFclInquiry('anonymous-session-1', 'fcl-submit-key-0001', input);
    expect(replayedAfterProcessing.case_status).toBe('needs_input');
    expect(replayedAfterProcessing.case_version).toBe(2);
    await expect(
      service.submitFclInquiry('anonymous-session-1', 'fcl-submit-key-0001', { ...input, cargo_name: 'Changed' }),
    ).rejects.toThrow('fcl_idempotency_conflict');

    const originalDigest = row.original_payload_digest;
    store.close();
    store = openFclStore(path, true);
    const reopened = harness(store);
    const read = reopened.service.getFclCustomerView(first.inquiry_id, first.credential);
    expect(read.input).toEqual({ ...input, cargo_name: 'Updated cargo' });
    expect(store.db.prepare('SELECT original_payload_digest FROM fcl_inquiries WHERE fcl_inquiry_id=?').get(first.inquiry_id))
      .toEqual({ original_payload_digest: originalDigest });
    expect(reopened.send).not.toHaveBeenCalled();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('allocates persistent unique FCL numbers inside the write transaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-sequence-'));
  const path = join(root, 'cases.sqlite');
  let store = openFclStore(path);
  try {
    const first = await harness(store).service.submitFclInquiry('session-a', 'sequence-key-a', inquiry());
    const second = await harness(store).service.submitFclInquiry('session-b', 'sequence-key-b', inquiry());
    expect(first.inquiry_no).toBe('FCL-20260920-0001');
    expect(second.inquiry_no).toBe('FCL-20260920-0002');
    store.close();
    store = openFclStore(path, true);
    const third = await harness(store).service.submitFclInquiry('session-c', 'sequence-key-c', inquiry());
    expect(third.inquiry_no).toBe('FCL-20260920-0003');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
  });

it('keeps final destination optional and requires an Other incoterm explanation for basic completeness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-complete-'));
  const store = openFclStore(join(root, 'cases.sqlite'));
  try {
    const service = harness(store).service;
    const portToPort = await service.submitFclInquiry('session-complete-a', 'complete-key-a', {
      ...inquiry(),
      final_destination: null,
    });
    expect(service.getFclCustomerView(portToPort.inquiry_id, portToPort.credential).complete).toBe(true);

    const otherMissing = await service.submitFclInquiry('session-complete-b', 'complete-key-b', {
      ...inquiry(),
      final_destination: null,
      incoterm: 'Other',
      incoterm_other: null,
    });
    expect(service.getFclCustomerView(otherMissing.inquiry_id, otherMissing.credential).complete).toBe(false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('isolates FCL cases from every legacy case and platform selector', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-isolation-'));
  const store = openFclStore(join(root, 'cases.sqlite'));
  try {
    const { service } = harness(store);
    const submitted = await service.submitFclInquiry('session-isolation', 'isolation-key-1', inquiry());
    expect(() => service.get(receiver, submitted.case_id)).toThrow('case_not_found');
    expect(() => service.get(operator, submitted.case_id)).toThrow('case_not_found');
    expect(() => service.getV2(receiver, submitted.case_id)).toThrow('case_not_found');
    expect(() => service.readForQuoteView(operator, submitted.case_id)).toThrow('case_not_found');
    expect(() => service.update(receiver, submitted.case_id, {
      expected_version: 1,
      status: 'in_review',
      public_note: 'legacy update',
      internal_note: '',
    }, 'legacy-update-key-1')).toThrow('case_not_found');
    expect(service.list(receiver, { management: false }).items).toHaveLength(0);
    expect(service.list(operator, { management: true }).items).toHaveLength(0);
    expect(() => service.getFclCase(other, submitted.case_id)).toThrow('fcl_not_found');
    expect(() => service.getFclCase(operator, submitted.case_id)).toThrow('fcl_not_found');
    expect(() => service.getFclCase({ ...receiver, organizationId: 'org-a' }, submitted.case_id)).toThrow('fcl_not_found');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('fails closed for receiver changes, credential expiry, cross-ticket access and invalid configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-security-'));
  const path = join(root, 'cases.sqlite');
  let store = openFclStore(path);
  let active = true;
  let now = '2026-09-20T12:00:00.000Z';
  try {
    const firstHarness = harness(store, { active: () => active, now: () => now });
    const first = await firstHarness.service.submitFclInquiry('session-secure-a', 'secure-key-a', inquiry());
    const second = await firstHarness.service.submitFclInquiry('session-secure-b', 'secure-key-b', inquiry());
    expect(() => firstHarness.service.getFclCustomerView(first.inquiry_id, second.credential)).toThrow('fcl_not_found');
    active = false;
    expect(() => firstHarness.service.getFclCase(receiver, first.case_id)).toThrow('fcl_unavailable');
    active = true;
    now = '2026-10-21T12:00:00.000Z';
    expect(() => firstHarness.service.getFclCustomerView(first.inquiry_id, first.credential)).toThrow('fcl_not_found');
    await expect(
      firstHarness.service.submitFclInquiry('session-secure-a', 'secure-key-a', inquiry()),
    ).rejects.toThrow('fcl_credential_expired');

    expect(() => harness(store, { ttlDays: 31 })).toThrow('fcl_credential_ttl_invalid');
    expect(() => harness(store, { secret: 'short' })).toThrow('fcl_credential_secret_invalid');

    store.close();
    store = openFclStore(path, true);
    expect(() => harness(store, { receiverUserId: 'receiver-b' })).toThrow('fcl_receiver_configuration_mismatch');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps the inquiry after failed or timed-out notification and never sends twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-mail-'));
  const path = join(root, 'cases.sqlite');
  const store = openFclStore(path);
  try {
    const failedSend = vi.fn(() => Promise.reject(new Error('synthetic transport failure')));
    const failed = await harness(store, { transport: { send: failedSend } }).service
      .submitFclInquiry('session-mail-fail', 'mail-fail-key', inquiry());
    expect(failed.notification.status).toBe('failed');
    expect(failedSend).toHaveBeenCalledTimes(1);
    expect(store.db.prepare('SELECT notification_status,notification_reason FROM fcl_inquiries WHERE fcl_inquiry_id=?')
      .get(failed.inquiry_id)).toEqual({ notification_status: 'failed', notification_reason: 'mail_transport_failed' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_cases').get()).toEqual({ n: 1 });
    await harness(store, { transport: { send: failedSend } }).service
      .submitFclInquiry('session-mail-fail', 'mail-fail-key', inquiry());
    expect(failedSend).toHaveBeenCalledTimes(1);

    const disabled = await harness(store, {
      mailEnabled: false,
      transport: { send: vi.fn() },
    }).service.submitFclInquiry('session-mail-disabled', 'mail-disabled-key', inquiry());
    expect(disabled.notification.status).toBe('disabled');

    const never = vi.fn(() => new Promise<void>(() => undefined));
    const timeout = await harness(store, { transport: { send: never } }).service
      .submitFclInquiry('session-mail-timeout', 'mail-timeout-key', inquiry());
    expect(timeout.notification.status).toBe('failed');
    expect(timeout.notification.reason_code).toBe('mail_timeout');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('migrates controlled v1 fixtures and refuses old writers after the FCL schema upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-migration-'));
  const path = join(root, 'cases.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE portal_database_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),application_id TEXT NOT NULL);
      INSERT INTO portal_database_identity VALUES(1,'freightclaw-business-cases');
      CREATE TABLE business_cases(case_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,organization_id TEXT,status TEXT NOT NULL,version INTEGER NOT NULL,input_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE business_case_events(event_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES business_cases(case_id),version INTEGER NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,visibility TEXT NOT NULL,actor_label TEXT NOT NULL,created_at TEXT NOT NULL,actor_id TEXT NOT NULL);
      CREATE TABLE business_case_idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,case_id TEXT NOT NULL REFERENCES business_cases(case_id),PRIMARY KEY(scope,key));
      INSERT INTO business_cases VALUES('00000000-0000-4000-8000-000000000001','customer-a',NULL,'submitted',1,'{"legacy":true}','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO business_case_events VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',1,'submitted','legacy event','customer','Customer','2026-09-01T00:00:00.000Z','customer-a');
      PRAGMA user_version=1;`);
    legacy.close();

    const store = new CaseStore(path, fclControlledOfflineOptions);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(store.db.prepare('SELECT input_json FROM business_cases').get()).toEqual({ input_json: '{"legacy":true}' });
      expect(store.db.prepare('SELECT event_kind,payload_json FROM business_case_events').get()).toEqual({
        event_kind: 'legacy',
        payload_json: '{}',
      });
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fcl_inquiries'").get()).toEqual({
        name: 'fcl_inquiries',
      });
    } finally {
      store.close();
    }
    expect(() => openPortalProductionDatabase(path, 'freightclaw-business-cases', 1)).toThrow(
      'portal_database_version_unsupported',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps default v1 stores unchanged and requires an explicit controlled FCL upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-controlled-upgrade-'));
  const path = join(root, 'cases.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE portal_database_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),application_id TEXT NOT NULL);
      INSERT INTO portal_database_identity VALUES(1,'freightclaw-business-cases');
      CREATE TABLE business_cases(case_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,organization_id TEXT,status TEXT NOT NULL,version INTEGER NOT NULL,input_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE business_case_events(event_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES business_cases(case_id),version INTEGER NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,visibility TEXT NOT NULL,actor_label TEXT NOT NULL,created_at TEXT NOT NULL,actor_id TEXT NOT NULL);
      CREATE TABLE business_case_idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,case_id TEXT NOT NULL REFERENCES business_cases(case_id),PRIMARY KEY(scope,key));
      PRAGMA user_version=1;`);
    legacy.close();

    const defaultStore = new CaseStore(path);
    expect(defaultStore.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(defaultStore.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fcl_inquiries'").get()).toBeUndefined();
    defaultStore.close();
    expect(() => new CaseStore(path, { fcl: { mode: 'fresh_fixture', authorized: false, oldWritersStopped: true } } as never))
      .toThrow('fcl_upgrade_not_authorized');
    expect(() => new CaseStore(path, {
      fcl: { mode: 'exclusive_verified', authorized: true, oldWritersStopped: true },
    } as never)).toThrow('fcl_upgrade_exclusive_check_required');
    expect(() => new CaseStore(path, {
      fcl: {
        mode: 'exclusive_verified',
        authorized: true,
        oldWritersStopped: true,
        assertExclusive: () => { throw new Error('writer still active'); },
      },
    } as never)).toThrow('fcl_upgrade_exclusive_check_failed');

    const upgraded = new CaseStore(path, {
      fcl: { mode: 'fresh_fixture', authorized: true, oldWritersStopped: true },
    } as never);
    try {
      expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fcl_inquiries'").get()).toEqual({
        name: 'fcl_inquiries',
      });
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects the fresh-fixture upgrade mode when any legacy business row exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-fresh-guard-'));
  const path = join(root, 'cases.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE portal_database_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),application_id TEXT NOT NULL);
      INSERT INTO portal_database_identity VALUES(1,'freightclaw-business-cases');
      CREATE TABLE business_cases(case_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,organization_id TEXT,status TEXT NOT NULL,version INTEGER NOT NULL,input_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE business_case_events(event_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES business_cases(case_id),version INTEGER NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,visibility TEXT NOT NULL,actor_label TEXT NOT NULL,created_at TEXT NOT NULL,actor_id TEXT NOT NULL);
      CREATE TABLE business_case_idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,case_id TEXT NOT NULL REFERENCES business_cases(case_id),PRIMARY KEY(scope,key));
      INSERT INTO business_cases VALUES('00000000-0000-4000-8000-000000000001','customer-a',NULL,'submitted',1,'{"legacy":true}','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      PRAGMA user_version=1;`);
    legacy.close();

    expect(() => new CaseStore(path, fclUpgradeOptions)).toThrow('fcl_upgrade_fresh_fixture_not_empty');
    const unchanged = openPortalProductionDatabase(path, 'freightclaw-business-cases', 1);
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fcl_inquiries'").get()).toBeUndefined();
      expect(unchanged.prepare('SELECT COUNT(*) AS n FROM business_cases').get()).toEqual({ n: 1 });
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves an inquiry when mail is disabled, unconfigured or invalid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-mail-config-'));
  const store = openFclStore(join(root, 'cases.sqlite'));
  try {
    const disabled = new CaseService(store, portal as never, {
      receiverUserId: receiverId,
      receiverIsActive: () => true,
      credentialSecret: receiverSecret,
      credentialTtlDays: 30,
      now: () => '2026-09-20T12:00:00.000Z',
      mail: { enabled: false },
    });
    const disabledResult = await disabled.submitFclInquiry('session-mail-off', 'mail-off-key', inquiry());
    expect(disabledResult.notification).toEqual({ status: 'disabled', reason_code: null, attempted_at: null });

    const unconfigured = new CaseService(store, portal as never, {
      receiverUserId: receiverId,
      receiverIsActive: () => true,
      credentialSecret: receiverSecret,
      credentialTtlDays: 30,
      now: () => '2026-09-20T12:00:00.000Z',
      mail: { enabled: true },
    });
    const unconfiguredResult = await unconfigured.submitFclInquiry('session-mail-unconfigured', 'mail-unconfigured-key', inquiry());
    expect(unconfiguredResult.notification.status).toBe('failed');
    expect(unconfiguredResult.notification.reason_code).toBe('mail_configuration_invalid');
    const invalidTransport = vi.fn();
    const invalid = new CaseService(store, portal as never, {
      receiverUserId: receiverId,
      receiverIsActive: () => true,
      credentialSecret: receiverSecret,
      credentialTtlDays: 30,
      now: () => '2026-09-20T12:00:00.000Z',
      mail: {
        enabled: true,
        recipient: 'invalid\r\nBcc: attacker@example.test',
        cc: ['valid@example.test'],
        transport: { send: invalidTransport },
      },
    });
    const invalidResult = await invalid.submitFclInquiry('session-mail-invalid-header', 'mail-invalid-header-key', inquiry());
    expect(invalidResult.notification.reason_code).toBe('mail_configuration_invalid');
    expect(invalidTransport).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_cases').get()).toEqual({ n: 3 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('exposes closed FCL envelopes and rejects injected authority fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-envelope-'));
  const store = openFclStore(join(root, 'cases.sqlite'));
  try {
    const { service } = harness(store);
    const input = inquiry();
    await expect(
      service.submitFclInquiry('session-injected', 'injected-key-1', { ...input, owner_id: receiverId }),
    ).rejects.toThrow('fcl_input_invalid');
    const success = fclCaseSuccessEnvelopeSchema.parse({
      schema_version: FCL_CASE_VERSION,
      status: 'success',
      data: {
        contract_version: FCL_CASE_VERSION,
        inquiry_id: '00000000-0000-4000-8000-000000000010',
        inquiry_no: 'FCL-20260920-0010',
        case_id: '00000000-0000-4000-8000-000000000011',
        case_status: 'submitted',
        case_version: 1,
        created_at: '2026-09-20T12:00:00.000Z',
        credential: 'x'.repeat(43),
        credential_expires_at: '2026-10-20T12:00:00.000Z',
        notification: { status: 'disabled', reason_code: null, attempted_at: null },
        replay: false,
      },
      reason_codes: [],
    });
    expect(success.status).toBe('success');
    expect(fclCaseErrorEnvelopeSchema.parse({
      schema_version: FCL_CASE_VERSION,
      status: 'blocked',
      data: null,
      reason_codes: ['fcl_not_found'],
    }).status).toBe('blocked');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
