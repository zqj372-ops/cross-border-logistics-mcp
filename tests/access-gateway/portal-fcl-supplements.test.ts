import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFclInquiryDraft } from '../../apps/inquiry/fcl-model';
import { CaseService, CaseStore } from '../../services/access-gateway/portal/cases';
import type { PortalContext } from '../../services/access-gateway/portal/contracts';

const receiverId = 'supplement-receiver';
const receiverSecret = 'synthetic-supplement-secret-32-bytes';
const receiver: PortalContext = {
  identity: {
    userId: receiverId,
    displayName: 'Supplement Receiver',
    email: 'receiver@example.test',
    emailVerified: true,
    platformRole: null,
  },
  organizationId: null,
};
const other: PortalContext = {
  ...receiver,
  identity: { ...receiver.identity, userId: 'other-supplement-user' },
};
const operator: PortalContext = {
  identity: {
    userId: 'supplement-operator',
    displayName: 'Platform Operator',
    email: 'operator@example.test',
    emailVerified: true,
    platformRole: 'operator',
  },
  organizationId: null,
};
const portal = { getState: () => ({ data: { current_organization: null, memberships: [] } }) };
const upgradeOptions = {
  fcl: { mode: 'fresh_fixture', authorized: true, oldWritersStopped: true },
} as const;
const reopenOptions = { fcl: { mode: 'reopen' } } as const;

function initialInquiry() {
  return {
    ...createFclInquiryDraft(),
    origin_city: null,
    pol: null,
    pod: null,
    final_destination: null,
    cargo_name: 'Synthetic machinery',
    containers: [{ type: '40HQ' as const, quantity: null }],
    cargo_type: 'general' as const,
    estimated_weight: null,
    cargo_ready_date: null,
    incoterm: null,
    incoterm_other: null,
    selected_services: [] as const,
    contact: {
      name: 'Synthetic Shipper',
      company: 'Synthetic Co',
      email: 'shipper@example.test',
      phone: '+1 555 0100',
    },
    notes: null,
    consent: true,
  };
}

function serviceFor(
  store: CaseStore,
  now: () => string = () => '2026-09-20T12:00:00.000Z',
  active: boolean | (() => boolean) = true,
) {
  return new CaseService(store, portal as never, {
    receiverUserId: receiverId,
    receiverIsActive: typeof active === 'function' ? active : () => active,
    credentialSecret: receiverSecret,
    credentialTtlDays: 30,
    now,
    mail: { enabled: false },
  });
}

async function submitted(store: CaseStore, session = 'supplement-session-a', key = 'supplement-submit-key') {
  return serviceFor(store).submitFclInquiry(session, key, initialInquiry());
}

it('runs the incomplete inquiry to customer supplement, staff supplement and confirmation chain without changing the original inquiry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-supplement-chain-'));
  const path = join(root, 'cases.sqlite');
  let store = new CaseStore(path, upgradeOptions);
  try {
    const service = serviceFor(store);
    const inquiry = await submitted(store);
    const original = store.db.prepare('SELECT original_payload_json,original_payload_digest FROM fcl_inquiries WHERE fcl_inquiry_id=?')
      .get(inquiry.inquiry_id) as { original_payload_json: string; original_payload_digest: string };

    const pending = service.updateFclCaseStatus(receiver, inquiry.case_id, {
      expected_version: 1,
      status: 'needs_input',
      public_note: 'Please confirm POL, POD, container quantities and ready date.',
      internal_note: 'Internal note must not become customer progress.',
    }, 'status-needs-input-key');
    expect(pending.case_status).toBe('needs_input');
    expect(pending.case_version).toBe(2);
    const statusEvent = pending.events.find((event) => event.kind === 'fcl_case_status_updated');
    expect(statusEvent?.kind === 'fcl_case_status_updated' ? statusEvent.payload : null).toMatchObject({
      from_version: 1,
      to_version: 2,
    });
    expect(pending.review_context).toMatchObject({
      latest_customer_supplement_ref: null,
      last_confirmed_case_version: null,
      review_required: true,
    });

    const supplied = service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, {
      expected_version: 2,
      fields: {
        changes: [
          { field: 'pol', value: 'Yantian' },
          { field: 'pod', value: 'Prince Rupert' },
          { field: 'containers', value: [{ type: '40HQ', quantity: 2 }, { type: '20GP', quantity: 1 }] },
          { field: 'cargo_ready_date', value: '2026-10-08' },
          { field: 'incoterm', value: 'EXW' },
          { field: 'selected_services', value: ['pickup', 'export_customs', 'ocean_freight', 'delivery'] },
        ],
      },
      message: 'Customer confirmed route and containers.',
    }, 'customer-supplement-key');
    expect(supplied.case_status).toBe('in_review');
    expect(supplied.case_version).toBe(3);
    expect(supplied.input.pol).toBe('Yantian');
    expect(supplied.input.pod).toBe('Prince Rupert');
    expect(supplied.input.containers).toEqual([{ type: '40HQ', quantity: 2 }, { type: '20GP', quantity: 1 }]);

    const afterCustomer = service.getFclCase(receiver, inquiry.case_id);
    const customerRef = afterCustomer.review_context.latest_customer_supplement_ref;
    expect(customerRef).toBe(afterCustomer.events.find((event) => event.kind === 'fcl_customer_supplement')?.event_id);
    const customerEvent = afterCustomer.events.find((event) => event.kind === 'fcl_customer_supplement');
    expect(customerEvent?.kind === 'fcl_customer_supplement' ? customerEvent.payload.field_changes : []).toEqual(
      expect.arrayContaining([
        { field: 'pod', before: null, after: 'Prince Rupert' },
        { field: 'containers', before: [{ type: '40HQ', quantity: null }], after: [{ type: '40HQ', quantity: 2 }, { type: '20GP', quantity: 1 }] },
      ]),
    );
    expect(afterCustomer.review_context.review_required).toBe(true);

    const staff = service.supplementFclCaseAsStaff(receiver, inquiry.case_id, {
      expected_version: 3,
      fields: { changes: [{ field: 'final_destination', value: 'Toronto' }] },
      message: 'Staff recorded the final city during the offline call.',
    }, 'staff-supplement-key');
    expect(staff.case_version).toBe(4);
    expect(staff.current_input.final_destination).toBe('Toronto');
    expect(staff.review_context.latest_customer_supplement_ref).toBe(customerRef);
    expect(staff.events.find((event) => event.kind === 'fcl_staff_supplement')).toMatchObject({
      actor_kind: 'staff',
      actor_ref: receiverId,
    });

    const confirmed = service.confirmFclCase(receiver, inquiry.case_id, {
      expected_version: 4,
      expected_customer_supplement_ref: customerRef,
      confirmed_fields: { changes: [{ field: 'origin_city', value: 'Shenzhen' }, { field: 'pol', value: 'Yantian' }] },
      reason: 'Checked against the customer supplement.',
    }, 'staff-confirmation-key');
    expect(confirmed.case_version).toBe(5);
    expect(confirmed.current_input.origin_city).toBe('Shenzhen');
    expect(confirmed.review_context).toEqual({
      latest_customer_supplement_ref: customerRef,
      last_confirmed_case_version: 5,
      last_confirmed_customer_supplement_ref: customerRef,
      review_required: false,
    });
    const confirmationEvent = confirmed.events.find((event) => event.kind === 'fcl_staff_confirmation');
    expect(confirmationEvent?.kind === 'fcl_staff_confirmation' ? confirmationEvent.payload.field_changes : []).toEqual([
      { field: 'origin_city', before: null, after: 'Shenzhen' },
      { field: 'pol', before: 'Yantian', after: 'Yantian' },
    ]);

    expect(store.db.prepare('SELECT original_payload_json,original_payload_digest FROM fcl_inquiries WHERE fcl_inquiry_id=?')
      .get(inquiry.inquiry_id)).toEqual(original);
    expect(original.original_payload_digest).toBe(createHash('sha256').update(original.original_payload_json).digest('hex'));
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_case_events WHERE case_id=?').get(inquiry.case_id)).toEqual({ n: 7 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_case_idempotency').get()).toEqual({ n: 5 });

    service.updateFclCaseStatus(receiver, inquiry.case_id, {
      expected_version: 1,
      status: 'needs_input',
      public_note: 'Please confirm POL, POD, container quantities and ready date.',
      internal_note: 'Internal note must not become customer progress.',
    }, 'status-needs-input-key');
    service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, {
      expected_version: 2,
      fields: {
        changes: [
          { field: 'pol', value: 'Yantian' },
          { field: 'pod', value: 'Prince Rupert' },
          { field: 'containers', value: [{ type: '40HQ', quantity: 2 }, { type: '20GP', quantity: 1 }] },
          { field: 'cargo_ready_date', value: '2026-10-08' },
          { field: 'incoterm', value: 'EXW' },
          { field: 'selected_services', value: ['pickup', 'export_customs', 'ocean_freight', 'delivery'] },
        ],
      },
      message: 'Customer confirmed route and containers.',
    }, 'customer-supplement-key');
    service.supplementFclCaseAsStaff(receiver, inquiry.case_id, {
      expected_version: 3,
      fields: { changes: [{ field: 'final_destination', value: 'Toronto' }] },
      message: 'Staff recorded the final city during the offline call.',
    }, 'staff-supplement-key');
    service.confirmFclCase(receiver, inquiry.case_id, {
      expected_version: 4,
      expected_customer_supplement_ref: customerRef,
      confirmed_fields: { changes: [{ field: 'origin_city', value: 'Shenzhen' }, { field: 'pol', value: 'Yantian' }] },
      reason: 'Checked against the customer supplement.',
    }, 'staff-confirmation-key');
    expect(() => service.updateFclCaseStatus(receiver, inquiry.case_id, {
      expected_version: 1,
      status: 'needs_input',
      public_note: 'Different body for the same key.',
      internal_note: 'Internal note must not become customer progress.',
    }, 'status-needs-input-key')).toThrow('fcl_idempotency_conflict');
    expect(store.db.prepare('SELECT version FROM business_cases WHERE case_id=?').get(inquiry.case_id)).toEqual({ version: 5 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_case_events WHERE case_id=?').get(inquiry.case_id)).toEqual({ n: 7 });

    store.close();
    store = new CaseStore(path, reopenOptions);
    const reopened = serviceFor(store).getFclCase(receiver, inquiry.case_id);
    expect(reopened.case_version).toBe(5);
    expect(reopened.current_input.origin_city).toBe('Shenzhen');
    expect(reopened.review_context.review_required).toBe(false);
    expect(reopened.original_input.pol).toBeNull();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects stale versions and stale customer supplement references without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-supplement-stale-'));
  const store = new CaseStore(join(root, 'cases.sqlite'), upgradeOptions);
  try {
    const service = serviceFor(store);
    const inquiry = await submitted(store, 'supplement-session-stale', 'supplement-submit-stale');
    service.updateFclCaseStatus(receiver, inquiry.case_id, {
      expected_version: 1,
      status: 'needs_input',
      public_note: 'Confirm details.',
      internal_note: '',
    }, 'stale-status-key');
    service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, {
      expected_version: 2,
      fields: { changes: [{ field: 'pod', value: 'Vancouver' }] },
      message: null,
    }, 'stale-supplement-key');
    const current = service.getFclCase(receiver, inquiry.case_id);
    const eventCount = store.db.prepare('SELECT COUNT(*) AS n FROM business_case_events WHERE case_id=?').get(inquiry.case_id);

    expect(() => service.confirmFclCase(receiver, inquiry.case_id, {
      expected_version: current.case_version,
      expected_customer_supplement_ref: null,
      confirmed_fields: { changes: [] },
      reason: 'Stale reference must fail.',
    }, 'stale-confirm-ref-key')).toThrow('fcl_supplement_stale');
    expect(() => service.confirmFclCase(receiver, inquiry.case_id, {
      expected_version: current.case_version - 1,
      expected_customer_supplement_ref: current.review_context.latest_customer_supplement_ref,
      confirmed_fields: { changes: [] },
      reason: 'Stale version must fail.',
    }, 'stale-confirm-version-key')).toThrow('fcl_version_conflict');
    expect(store.db.prepare('SELECT version FROM business_cases WHERE case_id=?').get(inquiry.case_id)).toEqual({ version: current.case_version });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_case_events WHERE case_id=?').get(inquiry.case_id)).toEqual(eventCount);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects unknown fields, invalid merged values and empty no-op supplements', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-supplement-invalid-'));
  const store = new CaseStore(join(root, 'cases.sqlite'), upgradeOptions);
  try {
    const service = serviceFor(store);
    const inquiry = await submitted(store, 'supplement-session-invalid', 'supplement-submit-invalid');
    service.updateFclCaseStatus(receiver, inquiry.case_id, {
      expected_version: 1,
      status: 'needs_input',
      public_note: 'Need details.',
      internal_note: '',
    }, 'invalid-status-key');

    expect(() => service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, {
      expected_version: 2,
      fields: { changes: [{ field: 'contract_version', value: 'forged' }] },
      message: null,
    }, 'invalid-field-key')).toThrow('fcl_input_invalid');
    expect(() => service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, {
      expected_version: 2,
      fields: { changes: [{ field: 'cargo_ready_date', value: '2026-02-30' }] },
      message: null,
    }, 'invalid-date-key')).toThrow('fcl_input_invalid');
    expect(() => service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, {
      expected_version: 2,
      fields: { changes: [{ field: 'containers', value: [{ type: '40HQ', quantity: 1 }, { type: '40HQ', quantity: 2 }] }] },
      message: null,
    }, 'invalid-containers-key')).toThrow('fcl_input_invalid');
    expect(() => service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, {
      expected_version: 2,
      fields: { changes: [] },
      message: null,
    }, 'empty-supplement-key')).toThrow('fcl_input_invalid');

    service.supplementFclCaseAsStaff(receiver, inquiry.case_id, {
      expected_version: 2,
      fields: { changes: [] },
      message: 'Staff recorded an offline clarification.',
    }, 'message-only-key');
    expect(() => service.supplementFclCaseAsStaff(receiver, inquiry.case_id, {
      expected_version: 3,
      fields: { changes: [{ field: 'pod', value: null }] },
      message: null,
    }, 'no-op-key')).toThrow('fcl_no_change');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('fails closed for wrong credentials, expired tickets, wrong receivers and platform operators', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-supplement-auth-'));
  const store = new CaseStore(join(root, 'cases.sqlite'), upgradeOptions);
  let now = '2026-09-20T12:00:00.000Z';
  let active = true;
  try {
    const service = serviceFor(store, () => now, () => active);
    const first = await submitted(store, 'supplement-session-auth-a', 'supplement-submit-auth-a');
    const second = await submitted(store, 'supplement-session-auth-b', 'supplement-submit-auth-b');
    service.updateFclCaseStatus(receiver, first.case_id, {
      expected_version: 1,
      status: 'needs_input',
      public_note: 'Need details.',
      internal_note: '',
    }, 'auth-status-key');
    const supplement = {
      expected_version: 2,
      fields: { changes: [{ field: 'pod', value: 'Vancouver' }] },
      message: null,
    };
    expect(() => service.supplementFclCase(first.inquiry_id, second.credential, supplement, 'wrong-ticket-key'))
      .toThrow('fcl_not_found');
    expect(() => service.supplementFclCaseAsStaff(other, first.case_id, supplement, 'wrong-staff-key'))
      .toThrow('fcl_not_found');
    expect(() => service.confirmFclCase(operator, first.case_id, {
      expected_version: 2,
      expected_customer_supplement_ref: null,
      confirmed_fields: { changes: [] },
      reason: 'Not authorized.',
    }, 'operator-confirm-key')).toThrow('fcl_not_found');

    const customerKey = 'auth-customer-success-key';
    service.supplementFclCase(first.inquiry_id, first.credential, supplement, customerKey);
    const staffKey = 'auth-staff-success-key';
    service.supplementFclCaseAsStaff(receiver, first.case_id, {
      expected_version: 3,
      fields: { changes: [{ field: 'final_destination', value: 'Toronto' }] },
      message: 'Staff replay authorization check.',
    }, staffKey);
    active = false;
    expect(() => service.supplementFclCaseAsStaff(receiver, first.case_id, {
      expected_version: 3,
      fields: { changes: [{ field: 'final_destination', value: 'Toronto' }] },
      message: 'Staff replay authorization check.',
    }, staffKey)).toThrow('fcl_unavailable');
    active = true;
    now = '2026-10-21T12:00:00.000Z';
    expect(() => service.supplementFclCase(first.inquiry_id, first.credential, supplement, customerKey))
      .toThrow('fcl_not_found');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('rolls back the case, event and idempotency when an AFTER UPDATE trigger writes another legal value', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-supplement-trigger-'));
  const store = new CaseStore(join(root, 'cases.sqlite'), upgradeOptions);
  try {
    const service = serviceFor(store);
    const inquiry = await submitted(store, 'supplement-session-trigger', 'supplement-submit-trigger');
    service.updateFclCaseStatus(receiver, inquiry.case_id, {
      expected_version: 1,
      status: 'needs_input',
      public_note: 'Confirm POD.',
      internal_note: '',
    }, 'trigger-status-key');
    const before = {
      case: store.db.prepare('SELECT status,version,input_json FROM business_cases WHERE case_id=?').get(inquiry.case_id),
      events: store.db.prepare('SELECT COUNT(*) AS n FROM business_case_events WHERE case_id=?').get(inquiry.case_id),
      idempotency: store.db.prepare('SELECT COUNT(*) AS n FROM business_case_idempotency').get(),
    };
    store.db.exec(`CREATE TRIGGER fcl_tamper_after_update
      AFTER UPDATE OF input_json ON business_cases
      WHEN NEW.status='in_review' AND json_extract(NEW.input_json,'$.pod')='Vancouver'
      BEGIN
        UPDATE business_cases SET input_json=json_set(NEW.input_json,'$.pod','Tampered') WHERE case_id=NEW.case_id;
      END;`);
    const supplement = {
      expected_version: 2,
      fields: { changes: [{ field: 'pod', value: 'Vancouver' }] },
      message: 'Customer confirmed Vancouver.',
    };
    expect(() => service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, supplement, 'trigger-supplement-key'))
      .toThrow('fcl_readback_failed');
    expect(store.db.prepare('SELECT status,version,input_json FROM business_cases WHERE case_id=?').get(inquiry.case_id)).toEqual(before.case);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_case_events WHERE case_id=?').get(inquiry.case_id)).toEqual(before.events);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM business_case_idempotency').get()).toEqual(before.idempotency);
    store.db.exec('DROP TRIGGER fcl_tamper_after_update');
    const retried = service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, supplement, 'trigger-supplement-key');
    expect(retried.case_version).toBe(3);
    expect(retried.input.pod).toBe('Vancouver');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('blocks supplements and confirmation after a terminal case state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-supplement-terminal-'));
  const store = new CaseStore(join(root, 'cases.sqlite'), upgradeOptions);
  try {
    const service = serviceFor(store);
    const inquiry = await submitted(store, 'supplement-session-terminal', 'supplement-submit-terminal');
    service.updateFclCaseStatus(receiver, inquiry.case_id, {
      expected_version: 1,
      status: 'closed',
      public_note: 'Inquiry closed.',
      internal_note: '',
    }, 'terminal-status-key');
    expect(() => service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, {
      expected_version: 2,
      fields: { changes: [{ field: 'pod', value: 'Vancouver' }] },
      message: null,
    }, 'terminal-customer-key')).toThrow('fcl_state_conflict');
    expect(() => service.supplementFclCaseAsStaff(receiver, inquiry.case_id, {
      expected_version: 2,
      fields: { changes: [{ field: 'pod', value: 'Vancouver' }] },
      message: null,
    }, 'terminal-staff-key')).toThrow('fcl_state_conflict');
    expect(() => service.confirmFclCase(receiver, inquiry.case_id, {
      expected_version: 2,
      expected_customer_supplement_ref: null,
      confirmed_fields: { changes: [] },
      reason: 'Cannot confirm closed case.',
    }, 'terminal-confirm-key')).toThrow('fcl_state_conflict');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps public progress events on the customer whitelist and hides internal confirmations and notes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-supplement-public-'));
  const store = new CaseStore(join(root, 'cases.sqlite'), upgradeOptions);
  try {
    const service = serviceFor(store);
    const inquiry = await submitted(store, 'supplement-session-public', 'supplement-submit-public');
    service.updateFclCaseStatus(receiver, inquiry.case_id, {
      expected_version: 1,
      status: 'needs_input',
      public_note: 'Please confirm the final route.',
      internal_note: 'INTERNAL-ONLY-STATUS-NOTE',
    }, 'public-status-key');
    service.supplementFclCase(inquiry.inquiry_id, inquiry.credential, {
      expected_version: 2,
      fields: { changes: [{ field: 'pod', value: 'Vancouver' }] },
      message: 'Customer confirmed Vancouver.',
    }, 'public-customer-key');
    const internal = service.getFclCase(receiver, inquiry.case_id);
    service.supplementFclCaseAsStaff(receiver, inquiry.case_id, {
      expected_version: 3,
      fields: { changes: [{ field: 'final_destination', value: 'Toronto' }] },
      message: 'Staff recorded the inland final city.',
    }, 'public-staff-key');
    service.confirmFclCase(receiver, inquiry.case_id, {
      expected_version: 4,
      expected_customer_supplement_ref: internal.review_context.latest_customer_supplement_ref,
      confirmed_fields: { changes: [] },
      reason: 'INTERNAL-CONFIRMATION-REASON',
    }, 'public-confirm-key');
    const publicView = service.getFclCustomerView(inquiry.inquiry_id, inquiry.credential);
    expect(publicView.events.map((event) => event.kind)).toEqual([
      'fcl_inquiry_submitted',
      'fcl_case_status_updated',
      'fcl_customer_supplement',
      'fcl_staff_supplement',
    ]);
    const json = JSON.stringify(publicView);
    expect(json).not.toContain('INTERNAL-ONLY-STATUS-NOTE');
    expect(json).not.toContain('INTERNAL-CONFIRMATION-REASON');
    expect(json).not.toContain(receiverId);
    expect(json).not.toContain(receiverSecret);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('paginates more than 50 personal FCL inquiries without returning original inquiries or full event histories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-supplement-pagination-'));
  const store = new CaseStore(join(root, 'cases.sqlite'), upgradeOptions);
  try {
    const service = serviceFor(store);
    let firstCaseId: string | null = null;
    for (let index = 0; index < 51; index++) {
      const submittedInquiry = await service.submitFclInquiry(`pagination-session-${index}`, `pagination-key-${index}`, initialInquiry());
      if (index === 0) firstCaseId = submittedInquiry.case_id;
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = service.listFclCases(receiver, { limit: 20, status: null, cursor });
      for (const item of page.items) {
        expect(item).not.toHaveProperty('original_input');
        expect(item).not.toHaveProperty('events');
        expect(item).not.toHaveProperty('receiver_user_id');
        seen.add(item.inquiry_id);
      }
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen.size).toBe(51);
    service.updateFclCaseStatus(receiver, firstCaseId!, {
      expected_version: 1,
      status: 'closed',
      public_note: 'Closed for pagination status filter.',
      internal_note: '',
    }, 'pagination-status-key');
    expect(service.listFclCases(receiver, { limit: 20, status: 'closed', cursor: null }).items).toHaveLength(1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
