import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFclInquiryDraft } from '../../apps/inquiry/fcl-model';
import { CaseService, CaseStore } from '../../services/access-gateway/portal/cases';
import type { PortalContext } from '../../services/access-gateway/portal/contracts';
import { NativeAdminService, NativeAdminStore } from '../../services/access-gateway/portal/native-admin';
import {
  FCL_QUOTE_WORKFLOW_VERSION,
  FclQuoteService,
  fclQuoteMatchRequestSchema,
  fclQuoteResponseSchema,
} from '../../services/quote-native/fcl';
import { FCL_RATE_DATASET_VERSION, type FclRateDataset } from '../../services/quote-native/fcl-contracts';

const receiverId = 'fcl-match-receiver';
const receiver: PortalContext = {
  organizationId: null,
  identity: {
    userId: receiverId,
    displayName: 'FCL Match Receiver',
    email: 'receiver@example.test',
    emailVerified: true,
    platformRole: null,
  },
};
const other: PortalContext = {
  organizationId: null,
  identity: { ...receiver.identity, userId: 'other-match-user', email: 'other@example.test' },
};
const portal = { getState: () => ({ data: { current_organization: null, memberships: [] } }) };
const caseUpgrade = {
  fcl: { mode: 'fresh_fixture', authorized: true, oldWritersStopped: true },
} as const;
const nativeUpgrade = {
  fcl: { mode: 'fresh_fixture', authorized: true, oldWritersStopped: true },
} as const;
const now = () => '2026-10-08T12:00:00.000Z';
let caseCounter = 0;

function caseInput(overrides: Partial<ReturnType<typeof createFclInquiryDraft>> = {}) {
  return {
    ...createFclInquiryDraft(),
    pol: 'Yantian',
    pod: 'Vancouver',
    cargo_name: 'Synthetic machinery',
    containers: [{ type: '40HQ' as const, quantity: 2 }],
    cargo_type: 'general' as const,
    estimated_weight: { value: '18000', unit: 'kg' as const },
    cargo_ready_date: '2026-10-08',
    incoterm: 'EXW' as const,
    selected_services: ['ocean_freight'] as const,
    contact: {
      name: 'Synthetic Shipper',
      company: null,
      email: 'shipper@example.test',
      phone: null,
    },
    consent: true,
    ...overrides,
  };
}

function rateDataset(overrides: Partial<Extract<FclRateDataset,{contract_version:typeof FCL_RATE_DATASET_VERSION}>> = {}): FclRateDataset {
  return {
    contract_version: FCL_RATE_DATASET_VERSION,
    label: 'Synthetic current FCL rates',
    rates: [{
      rate_id: '00000000-0000-4000-8000-000000000201',
      supplier_label: 'Synthetic carrier',
      pol: 'Yantian',
      pod: 'Vancouver',
      valid_from: '2026-10-01',
      valid_until: '2026-10-15',
      source_ref: 'synthetic:rate:1',
      source_version: 'v1',
      note: null,
      items: [{ container_type: '40HQ', ocean_freight: '3200', currency: 'USD' }],
      additional_fees: [],
    }],
    ...overrides,
  };
}

function caseService(store: CaseStore, active: () => boolean = () => true) {
  return new CaseService(store, portal as never, {
    receiverUserId: receiverId,
    receiverIsActive: active,
    credentialSecret: 'synthetic-fcl-match-secret-32-bytes',
    credentialTtlDays: 30,
    now,
    mail: { enabled: false },
  });
}

async function confirmedCase(store: CaseStore, input = caseInput()) {
  const service = caseService(store);
  const suffix = caseCounter++;
  const submitted = await service.submitFclInquiry(
    `fcl-match-session-${suffix}`,
    `fcl-match-submit-key-${suffix}`,
    input,
  );
  const confirmed = service.confirmFclCase(receiver, submitted.case_id, {
    expected_version: 1,
    expected_customer_supplement_ref: null,
    confirmed_fields: { changes: [] },
    reason: 'Fixture confirmation',
  }, 'fcl-match-confirm-key');
  return { submitted, confirmed };
}

function publishedRates(store: NativeAdminStore, dataset: FclRateDataset = rateDataset()) {
  const service = new NativeAdminService(store, portal as never, {
    receiverUserId: receiverId,
    receiverIsActive: () => true,
    now,
  });
  service.save(receiver, 'fcl', { expected_version: 0, input: dataset }, 'fcl-match-rate-save-key');
  const preview = service.preview(receiver, 'fcl');
  service.publish(receiver, 'fcl', {
    expected_version: 1,
    preview_hash: preview.preview_hash,
    confirmation: 'reviewed_sources_and_conditions',
  }, 'fcl-match-rate-publish-key');
  return service;
}

it('selects the single exact Rate and returns a stable source snapshot without writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-match-success-'));
  const caseStore = new CaseStore(join(root, 'cases.sqlite'), caseUpgrade);
  const rateStore = new NativeAdminStore(join(root, 'native.sqlite'), nativeUpgrade);
  try {
    const { confirmed } = await confirmedCase(caseStore);
    const rateService = publishedRates(rateStore);
    const service = new FclQuoteService({
      caseReader: caseService(caseStore),
      rateReader: rateService,
      now,
    });
    const request = {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: confirmed.case_id,
      expected_case_version: confirmed.case_version,
      expected_customer_supplement_ref: null,
      selected_rate_id: null,
    };
    expect(fclQuoteMatchRequestSchema.parse(request)).toEqual(request);
    const caseBefore = caseStore.db.prepare('SELECT status,version,input_json,updated_at FROM business_cases WHERE case_id=?').get(confirmed.case_id);
    const caseEventsBefore = caseStore.db.prepare('SELECT COUNT(*) AS n FROM business_case_events WHERE case_id=?').get(confirmed.case_id);
    const rateBefore = rateStore.db.prepare("SELECT COUNT(*) AS n FROM native_releases WHERE kind='fcl'").get();
    const auditBefore = rateStore.db.prepare("SELECT COUNT(*) AS n FROM native_audit WHERE kind='fcl'").get();
    const response = service.match(receiver, request);
    expect(fclQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.status).toBe('success');
    expect(response.data.candidates).toHaveLength(1);
    expect(response.data.selected?.rate.items[0]).toMatchObject({ container_type: '40HQ', ocean_freight: '3200' });
    expect(response.data.selected).toMatchObject({
      rate_id: '00000000-0000-4000-8000-000000000201',
      source_ref: 'synthetic:rate:1',
      source_version: 'v1',
      case_ref: confirmed.case_id,
      case_version: confirmed.case_version,
      latest_customer_supplement_ref: null,
      selected_at: '2026-10-08T12:00:00.000Z',
    });
    expect(caseStore.db.prepare('SELECT status,version,input_json,updated_at FROM business_cases WHERE case_id=?').get(confirmed.case_id)).toEqual(caseBefore);
    expect(caseStore.db.prepare('SELECT COUNT(*) AS n FROM business_case_events WHERE case_id=?').get(confirmed.case_id)).toEqual(caseEventsBefore);
    expect(rateStore.db.prepare("SELECT COUNT(*) AS n FROM native_releases WHERE kind='fcl'").get()).toEqual(rateBefore);
    expect(rateStore.db.prepare("SELECT COUNT(*) AS n FROM native_audit WHERE kind='fcl'").get()).toEqual(auditBefore);
  } finally {
    rateStore.close();
    caseStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires exact POL, POD, container and Ready Date matching and never fills missing fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-match-exact-'));
  const caseStore = new CaseStore(join(root, 'cases.sqlite'), caseUpgrade);
  const rateStore = new NativeAdminStore(join(root, 'native.sqlite'), nativeUpgrade);
  try {
    const { confirmed } = await confirmedCase(caseStore);
    const rateService = publishedRates(rateStore);
    const service = new FclQuoteService({ caseReader: caseService(caseStore), rateReader: rateService, now });
    const base = {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: confirmed.case_id,
      expected_case_version: confirmed.case_version,
      expected_customer_supplement_ref: null,
      selected_rate_id: null,
    };
    expect(service.match(receiver, { ...base, selected_rate_id: null }).status).toBe('success');

    for (const changed of [
      { pol: 'Shenzhen' },
      { pod: 'Prince Rupert' },
      { containers: [{ type: '40GP' as const, quantity: 2 }] },
    ]) {
      const next = await confirmedCase(caseStore, caseInput(changed));
      const result = service.match(receiver, {
        ...base,
        case_ref: next.confirmed.case_id,
        expected_case_version: next.confirmed.case_version,
      });
      expect(result.status).toBe('manual_review');
      expect(result.data.candidates).toHaveLength(0);
    }
    const zeroCandidateSelection = await confirmedCase(caseStore, caseInput({ pod: 'Prince Rupert' }));
    const blockedSelection = service.match(receiver, {
      ...base,
      case_ref: zeroCandidateSelection.confirmed.case_id,
      expected_case_version: zeroCandidateSelection.confirmed.case_version,
      selected_rate_id: '00000000-0000-4000-8000-000000000201',
    });
    expect(blockedSelection.status).toBe('blocked');
    expect(blockedSelection.reason_codes).toContain('fcl_selected_rate_not_candidate');

    const missing = await confirmedCase(caseStore, caseInput({ pol: null, pod: null, containers: [], cargo_ready_date: null }));
    const missingResult = service.match(receiver, {
      ...base,
      case_ref: missing.confirmed.case_id,
      expected_case_version: missing.confirmed.case_version,
    });
    expect(missingResult.status).toBe('needs_input');
    expect(missingResult.data.missing_fields).toEqual(expect.arrayContaining(['/pol', '/pod', '/containers', '/cargo_ready_date']));
  } finally {
    rateStore.close();
    caseStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('lists multiple candidates without choosing a lowest price and accepts only an explicit candidate id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-match-multiple-'));
  const caseStore = new CaseStore(join(root, 'cases.sqlite'), caseUpgrade);
  const rateStore = new NativeAdminStore(join(root, 'native.sqlite'), nativeUpgrade);
  try {
    const { confirmed } = await confirmedCase(caseStore);
    const dataset = rateDataset();
    dataset.rates.push({
      ...dataset.rates[0]!,
      rate_id: '00000000-0000-4000-8000-000000000202',
      supplier_label: 'Higher synthetic carrier',
      items: [{ container_type: '40HQ', ocean_freight: '3500', currency: 'USD' }],
    });
    const rateService = publishedRates(rateStore, dataset);
    const service = new FclQuoteService({ caseReader: caseService(caseStore), rateReader: rateService, now });
    const base = {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: confirmed.case_id,
      expected_case_version: confirmed.case_version,
      expected_customer_supplement_ref: null,
    };
    const undecided = service.match(receiver, { ...base, selected_rate_id: null });
    expect(undecided.status).toBe('manual_review');
    expect(undecided.data.candidates).toHaveLength(2);
    expect(undecided.data.selected).toBeNull();

    const selected = service.match(receiver, { ...base, selected_rate_id: dataset.rates[1]!.rate_id });
    expect(selected.status).toBe('success');
    expect(selected.data.selected?.rate_id).toBe(dataset.rates[1]!.rate_id);

    const rejected = service.match(receiver, { ...base, selected_rate_id: '00000000-0000-4000-8000-000000000999' });
    expect(rejected.status).toBe('blocked');
    expect(rejected.reason_codes).toContain('fcl_selected_rate_not_candidate');
    expect(rejected.data.selected).toBeNull();
  } finally {
    rateStore.close();
    caseStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires one Rate header to cover every container and preserves an explicit zero price', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-match-header-'));
  const caseStore = new CaseStore(join(root, 'cases.sqlite'), caseUpgrade);
  const rateStore = new NativeAdminStore(join(root, 'native.sqlite'), nativeUpgrade);
  try {
    const { confirmed } = await confirmedCase(caseStore, caseInput({
      containers: [{ type: '40HQ', quantity: 2 }, { type: '20GP', quantity: 1 }],
    }));
    const split = rateDataset();
    split.rates[0]!.items = [{ container_type: '40HQ', ocean_freight: '0', currency: 'USD' }];
    split.rates.push({
      ...split.rates[0]!,
      rate_id: '00000000-0000-4000-8000-000000000203',
      items: [{ container_type: '20GP', ocean_freight: '1200', currency: 'USD' }],
    });
    const rateService = publishedRates(rateStore, split);
    const service = new FclQuoteService({ caseReader: caseService(caseStore), rateReader: rateService, now });
    const base = {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: confirmed.case_id,
      expected_case_version: confirmed.case_version,
      expected_customer_supplement_ref: null,
      selected_rate_id: null,
    };
    expect(service.match(receiver, base).status).toBe('manual_review');
    expect(service.match(receiver, base).data.candidates).toHaveLength(0);

    const combined = rateDataset();
    combined.rates[0]!.items = [
      { container_type: '40HQ', ocean_freight: '0', currency: 'USD' },
      { container_type: '20GP', ocean_freight: '1200', currency: 'USD' },
    ];
    rateService.save(receiver, 'fcl', { expected_version: 2, input: combined }, 'fcl-match-combined-save-key');
    const combinedPreview = rateService.preview(receiver, 'fcl');
    rateService.publish(receiver, 'fcl', {
      expected_version: 3,
      preview_hash: combinedPreview.preview_hash,
      confirmation: 'reviewed_sources_and_conditions',
    }, 'fcl-match-combined-publish-key');
    const selected = service.match(receiver, base);
    expect(selected.status).toBe('success');
    expect(selected.data.selected?.rate.items).toEqual([
      { container_type: '40HQ', ocean_freight: '0', currency: 'USD' },
      { container_type: '20GP', ocean_freight: '1200', currency: 'USD' },
    ]);
  } finally {
    rateStore.close();
    caseStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('returns a quantity JSON Pointer and ignores rate maintenance dates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-match-boundary-'));
  const caseStore = new CaseStore(join(root, 'cases.sqlite'), caseUpgrade);
  const rateStore = new NativeAdminStore(join(root, 'native.sqlite'), nativeUpgrade);
  try {
    const rateService = publishedRates(rateStore);
    const service = new FclQuoteService({ caseReader: caseService(caseStore), rateReader: rateService, now });
    const missingQuantity = await confirmedCase(caseStore, caseInput({
      containers: [{ type: '40HQ', quantity: null }],
    }));
    const missingResponse = service.match(receiver, {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: missingQuantity.confirmed.case_id,
      expected_case_version: missingQuantity.confirmed.case_version,
      expected_customer_supplement_ref: null,
      selected_rate_id: null,
    });
    expect(missingResponse.status).toBe('needs_input');
    expect(missingResponse.data.missing_fields).toContain('/containers/0/quantity');

    for (const date of ['2026-10-01', '2026-10-15']) {
      const boundary = await confirmedCase(caseStore, caseInput({ cargo_ready_date: date }));
      expect(service.match(receiver, {
        contract_version: FCL_QUOTE_WORKFLOW_VERSION,
        case_ref: boundary.confirmed.case_id,
        expected_case_version: boundary.confirmed.case_version,
        expected_customer_supplement_ref: null,
        selected_rate_id: null,
      }).status).toBe('success');
    }
    const outside = await confirmedCase(caseStore, caseInput({ cargo_ready_date: '2026-09-30' }));
    expect(service.match(receiver, {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: outside.confirmed.case_id,
      expected_case_version: outside.confirmed.case_version,
      expected_customer_supplement_ref: null,
      selected_rate_id: null,
    }).status).toBe('success');
  } finally {
    rateStore.close();
    caseStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('checks missing fields before unconfirmed review and rejects stale bindings after a real customer supplement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-match-gates-'));
  const caseStore = new CaseStore(join(root, 'cases.sqlite'), caseUpgrade);
  const rateStore = new NativeAdminStore(join(root, 'native.sqlite'), nativeUpgrade);
  try {
    const rateService = publishedRates(rateStore);
    const caseServiceInstance = caseService(caseStore);
    const incomplete = await caseServiceInstance.submitFclInquiry(
      'fcl-match-incomplete-session',
      'fcl-match-incomplete-key',
      caseInput({ pol: null }),
    );
    const service = new FclQuoteService({ caseReader: caseServiceInstance, rateReader: rateService, now });
    const incompleteResponse = service.match(receiver, {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: incomplete.case_id,
      expected_case_version: incomplete.case_version,
      expected_customer_supplement_ref: null,
      selected_rate_id: null,
    });
    expect(incompleteResponse.status).toBe('needs_input');
    expect(incompleteResponse.data.missing_fields).toContain('/pol');

    const submitted = await confirmedCase(caseStore);
    const pending = caseServiceInstance.updateFclCaseStatus(receiver, submitted.confirmed.case_id, {
      expected_version: submitted.confirmed.case_version,
      status: 'needs_input',
      public_note: 'Confirm POD.',
      internal_note: '',
    }, 'fcl-match-pending-key');
    const supplied = caseServiceInstance.supplementFclCase(
      submitted.submitted.inquiry_id,
      submitted.submitted.credential,
      {
        expected_version: pending.case_version,
        fields: { changes: [{ field: 'pod', value: 'Prince Rupert' }] },
        message: 'Customer changed POD.',
      },
      'fcl-match-customer-supplement-key',
    );
    const current = caseServiceInstance.getFclCase(receiver, submitted.confirmed.case_id);
    expect(service.match(receiver, {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: current.case_id,
      expected_case_version: supplied.case_version - 1,
      expected_customer_supplement_ref: current.review_context.latest_customer_supplement_ref,
      selected_rate_id: null,
    }).status).toBe('blocked');
    expect(service.match(receiver, {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: current.case_id,
      expected_case_version: current.case_version,
      expected_customer_supplement_ref: null,
      selected_rate_id: null,
    }).status).toBe('blocked');
    expect(service.match(receiver, {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: current.case_id,
      expected_case_version: current.case_version,
      expected_customer_supplement_ref: current.review_context.latest_customer_supplement_ref,
      selected_rate_id: null,
    }).status).toBe('manual_review');
  } finally {
    rateStore.close();
    caseStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('fails closed for stale case binding, unconfirmed case, terminal case, disabled/corrupt rates and unauthorized users', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fcl-match-closed-'));
  const caseStore = new CaseStore(join(root, 'cases.sqlite'), caseUpgrade);
  const rateStore = new NativeAdminStore(join(root, 'native.sqlite'), nativeUpgrade);
  try {
    const { confirmed } = await confirmedCase(caseStore);
    const rateService = publishedRates(rateStore);
    const service = new FclQuoteService({ caseReader: caseService(caseStore), rateReader: rateService, now });
    const base = {
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      case_ref: confirmed.case_id,
      expected_case_version: confirmed.case_version,
      expected_customer_supplement_ref: null,
      selected_rate_id: null,
    };
    expect(service.match(receiver, { ...base, expected_case_version: 1 }).status).toBe('blocked');
    expect(service.match(receiver, {
      ...base,
      expected_customer_supplement_ref: '00000000-0000-4000-8000-000000000998',
    }).status).toBe('blocked');

    const unconfirmed = await caseService(caseStore).submitFclInquiry('fcl-match-unconfirmed', 'fcl-match-unconfirmed-key', caseInput());
    expect(service.match(receiver, {
      ...base,
      case_ref: unconfirmed.case_id,
      expected_case_version: unconfirmed.case_version,
    }).status).toBe('manual_review');

    expect(() => service.match(other, base)).toThrow('fcl_quote_case_unavailable');

    const rateRow = rateStore.db.prepare("SELECT id,payload FROM native_releases WHERE kind='fcl' ORDER BY rowid DESC LIMIT 1").get() as { id: string; payload: string };
    const active = rateStore.db.prepare("SELECT active FROM native_configs WHERE scope=? AND kind='fcl'").get(`fcl-person:${receiverId}`) as { active: string };
    rateStore.db.prepare('UPDATE native_configs SET active=NULL WHERE scope=? AND kind=?').run(`fcl-person:${receiverId}`, 'fcl');
    const disabled = service.match(receiver, base);
    expect(disabled.status).toBe('unavailable');
    expect(disabled.reason_codes).toContain('fcl_rate_source_unavailable');

    rateStore.db.prepare('UPDATE native_configs SET active=? WHERE scope=? AND kind=?').run(active.active, `fcl-person:${receiverId}`, 'fcl');
    rateStore.db.prepare('UPDATE native_releases SET payload=? WHERE id=?').run(
      JSON.stringify({ ...(JSON.parse(rateRow.payload) as Record<string, unknown>), published_at: 'invalid' }),
      rateRow.id,
    );
    const corrupt = service.match(receiver, base);
    expect(corrupt.status).toBe('unavailable');
    expect(corrupt.reason_codes).toContain('fcl_rate_source_unavailable');
    rateStore.db.prepare('UPDATE native_releases SET payload=? WHERE id=?').run(rateRow.payload, rateRow.id);
    const badClock = new FclQuoteService({
      caseReader: caseService(caseStore),
      rateReader: rateService,
      now: () => '10/08/2026',
    });
    expect(() => badClock.match(receiver, base)).toThrow('fcl_quote_clock_unavailable');

    const terminal = await confirmedCase(caseStore, caseInput({ cargo_name: 'Terminal fixture' }));
    const closed = caseService(caseStore).updateFclCaseStatus(receiver, terminal.confirmed.case_id, {
      expected_version: terminal.confirmed.case_version,
      status: 'closed',
      public_note: 'Closed fixture',
      internal_note: '',
    }, 'fcl-match-close-key');
    expect(service.match(receiver, {
      ...base,
      case_ref: terminal.confirmed.case_id,
      expected_case_version: closed.case_version,
    }).status).toBe('blocked');
  } finally {
    rateStore.close();
    caseStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects extra authority fields in the request contract', () => {
  const request = {
    contract_version: FCL_QUOTE_WORKFLOW_VERSION,
    case_ref: '00000000-0000-4000-8000-000000000001',
    expected_case_version: 1,
    expected_customer_supplement_ref: null,
    selected_rate_id: null,
    rate: { forged: true },
  };
  expect(fclQuoteMatchRequestSchema.safeParse(request).success).toBe(false);
});
