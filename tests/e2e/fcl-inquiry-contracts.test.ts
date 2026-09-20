import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FCL_CONTRACT_VERSION,
  FCL_INQUIRY_SCHEMA_ID,
  FCL_TRANSPORT_MODE,
  buildFclInquirySummary,
  createFclInquiryDraft,
  fclInquirySchema,
  FclInquiryValidationError,
  parseFclInquiry,
  validateFclInquiry,
  validateFclInquiryForSubmit,
  validateFclInquiryStep,
  validateFclInquiryDraft,
  type FclInquiryDraft,
} from '../../apps/inquiry/fcl-model.js';

const draftIssuePaths = (input: unknown) => validateFclInquiryDraft(input).map((issue) => issue.path.join('.'));
const submitIssuePaths = (input: unknown) => validateFclInquiryForSubmit(input).map((issue) => issue.path.join('.'));

function completeInput(): FclInquiryDraft {
  return {
    ...createFclInquiryDraft(),
    origin_city: 'Shanghai',
    pol: 'Shanghai',
    pod: 'Vancouver',
    final_destination: 'Toronto',
    cargo_name: 'Synthetic furniture',
    containers: [
      { type: '40HQ' as const, quantity: 2 },
      { type: '20GP' as const, quantity: null },
    ],
    cargo_type: 'general' as const,
    estimated_weight: { value: '12500.5', unit: 'kg' as const },
    cargo_ready_date: '2026-10-15',
    incoterm: 'FOB' as const,
    incoterm_other: null,
    selected_services: ['pickup', 'ocean_freight', 'canada_customs'],
    contact: {
      name: 'Synthetic Shipper',
      company: null,
      email: 'shipper@example.test',
      phone: null,
    },
    notes: 'Synthetic FCL inquiry.\nSecond line\twith a tab.',
    consent: true,
  };
}

describe('FCL inquiry shared input contract', () => {
  it('creates a fixed-version FCL draft without guessing business values', () => {
    expect(createFclInquiryDraft()).toEqual({
      contract_version: FCL_CONTRACT_VERSION,
      transport_mode: FCL_TRANSPORT_MODE,
      origin_city: null,
      pol: null,
      pod: null,
      final_destination: null,
      cargo_name: null,
      containers: [],
      cargo_type: null,
      estimated_weight: null,
      cargo_ready_date: null,
      incoterm: null,
      incoterm_other: null,
      selected_services: [],
      contact: {
        name: null,
        company: null,
        email: null,
        phone: null,
      },
      notes: null,
      consent: false,
    });
  });

  it('accepts an incomplete inquiry with multiple container types', () => {
    const input = {
      ...createFclInquiryDraft(),
      containers: [
        { type: '40HQ' as const, quantity: 2 },
        { type: '20GP' as const, quantity: null },
      ],
      selected_services: ['pickup', 'ocean_freight'] as const,
      notes: 'Line one\nLine two\tcontinued',
    };

    expect(validateFclInquiryDraft(input)).toEqual([]);
  });

  it('rejects invalid structure and cross-field semantics with field paths', () => {
    const draft = createFclInquiryDraft();
    const cases: Array<[string, unknown, string]> = [
      ['transport mode', { ...draft, transport_mode: 'LCL' }, 'transport_mode'],
      ['container type', { ...draft, containers: [{ type: 'RORO', quantity: 1 }] }, 'containers.0.type'],
      ['zero container count', { ...draft, containers: [{ type: '20GP', quantity: 0 }] }, 'containers.0.quantity'],
      ['fractional container count', { ...draft, containers: [{ type: '20GP', quantity: 1.5 }] }, 'containers.0.quantity'],
      ['negative container count', { ...draft, containers: [{ type: '20GP', quantity: -1 }] }, 'containers.0.quantity'],
      [
        'duplicate container type',
        {
          ...draft,
          containers: [
            { type: '40HQ', quantity: 1 },
            { type: '40HQ', quantity: null },
          ],
        },
        'containers.1.type',
      ],
      ['cargo type', { ...draft, cargo_type: 'hazard' }, 'cargo_type'],
      ['weight JSON number', { ...draft, estimated_weight: { value: 1.5, unit: 'kg' } }, 'estimated_weight.value'],
      ['scientific weight', { ...draft, estimated_weight: { value: '1e3', unit: 'kg' } }, 'estimated_weight.value'],
      ['signed weight', { ...draft, estimated_weight: { value: '-1', unit: 'kg' } }, 'estimated_weight.value'],
      ['zero weight', { ...draft, estimated_weight: { value: '0', unit: 'kg' } }, 'estimated_weight.value'],
      ['comma weight', { ...draft, estimated_weight: { value: '1,000', unit: 'kg' } }, 'estimated_weight.value'],
      ['long decimal weight', { ...draft, estimated_weight: { value: '1.1234567', unit: 'kg' } }, 'estimated_weight.value'],
      ['invalid calendar date', { ...draft, cargo_ready_date: '2026-02-30' }, 'cargo_ready_date'],
      ['date shape', { ...draft, cargo_ready_date: '2026-2-3' }, 'cargo_ready_date'],
      ['incoterm', { ...draft, incoterm: 'FCA' }, 'incoterm'],
      ['service id', { ...draft, selected_services: ['booking'] }, 'selected_services.0'],
      [
        'duplicate service',
        { ...draft, selected_services: ['pickup', 'pickup'] },
        'selected_services.1',
      ],
      ['control character', { ...draft, origin_city: 'Shanghai\nInjected' }, 'origin_city'],
      ['whitespace-only text', { ...draft, pol: '   ' }, 'pol'],
      ['invalid email', { ...draft, contact: { ...draft.contact, email: 'not-an-email' } }, 'contact.email'],
      ['notes control character', { ...draft, notes: 'valid\u0001invalid' }, 'notes'],
      ['consent type', { ...draft, consent: 'true' }, 'consent'],
    ];

    for (const [label, input, path] of cases) {
      expect(draftIssuePaths(input), label).toContain(path);
    }
  });

  it('rejects every required-key omission and root or nested unknown field', () => {
    const draft = createFclInquiryDraft();
    const missingContact: Record<string, unknown> = { ...draft };
    delete missingContact.contact;
    expect(draftIssuePaths(missingContact)).toContain('contact');

    for (const key of ['owner', 'tenant', 'org', 'reviewer', 'price']) {
      expect(draftIssuePaths({ ...draft, [key]: 'forbidden' }), key).toContain(key);
    }

    expect(draftIssuePaths({ ...draft, contact: { ...draft.contact, tenant: 'forbidden' } })).toContain('contact.tenant');
    expect(draftIssuePaths({ ...draft, containers: [{ type: '20GP', quantity: 1, owner: 'forbidden' }] })).toContain(
      'containers.0.owner',
    );
  });

  it('groups validation by the three form steps and gates final submission separately', () => {
    const incomplete = completeInput();
    incomplete.pol = 'Shanghai\nInjected';
    incomplete.selected_services = ['pickup', 'pickup'];
    incomplete.contact = { name: null, company: null, email: null, phone: null };
    incomplete.consent = false;

    expect(validateFclInquiryStep(incomplete, 1).map((issue) => issue.path.join('.'))).toContain('pol');
    expect(validateFclInquiryStep(incomplete, 2).map((issue) => issue.path.join('.'))).toContain('selected_services.1');
    expect(validateFclInquiryStep(incomplete, 3).map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['contact.name', 'contact.email', 'consent']),
    );
    expect(submitIssuePaths(incomplete)).toEqual(
      expect.arrayContaining(['pol', 'contact.name', 'contact.email', 'consent']),
    );

    expect(validateFclInquiry(completeInput())).toEqual([]);
    expect(validateFclInquiryForSubmit(completeInput())).toEqual([]);
    expect(validateFclInquiryStep(completeInput(), 3)).toEqual([]);
  });

  it('rejects control characters in the final delivery email', () => {
    const input = completeInput();
    input.contact.email = 'fixture\u0001@example.test';

    expect(submitIssuePaths(input)).toContain('contact.email');
  });

  it('rejects consecutive dots in the final delivery email across parser and shared validator', () => {
    for (const email of ['a..b@example.test', 'fixture@example..test']) {
      const input = completeInput();
      input.contact.email = email;

      expect(submitIssuePaths(input), email).toContain('contact.email');
      expect(() => parseFclInquiry(input), email).toThrow(FclInquiryValidationError);
    }

    expect(submitIssuePaths(completeInput())).toEqual([]);
    expect(parseFclInquiry(completeInput()).contact.email).toBe('shipper@example.test');
  });

  it('keeps the public parser on the final submission contract rather than the draft contract', () => {
    expect(() => parseFclInquiry(createFclInquiryDraft())).toThrow(FclInquiryValidationError);
    expect(parseFclInquiry(completeInput()).consent).toBe(true);
  });

  it('summarizes POD and final city separately without claiming submission or pricing', () => {
    const summary = buildFclInquirySummary(completeInput());

    expect(summary.state).toBe('draft');
    expect(summary.route.pod).toBe('Vancouver');
    expect(summary.route.final_destination).toBe('Toronto');
    expect(summary.route.origin_city).toBe('Shanghai');
    expect(summary.route.pol).toBe('Shanghai');
    expect(summary.containers).toEqual(completeInput().containers);
    expect(summary).not.toHaveProperty('submitted');
    expect(summary).not.toHaveProperty('sent');
    expect(summary).not.toHaveProperty('quoted');
    expect(summary).not.toHaveProperty('price');
  });

  it('keeps the exported JSON Schema structural while the shared validator owns refinements', () => {
    const expectedSchema = {
      ...z.toJSONSchema(fclInquirySchema, { target: 'draft-2020-12' }),
      $id: FCL_INQUIRY_SCHEMA_ID,
    };
    const checkedIn = JSON.parse(
      readFileSync('schemas/access-gateway/portal-fcl-inquiry-input.schema.json', 'utf8'),
    ) as object;

    expect(checkedIn).toEqual(expectedSchema);
    const schema = checkedIn as {
      properties: {
        containers: { items: { additionalProperties: boolean } };
        contact: {
          additionalProperties: boolean;
          properties: {
            name: { anyOf?: unknown };
            email: { anyOf?: unknown };
          };
          required: string[];
        };
        consent: { const?: boolean };
      };
    };
    expect(schema.properties.containers.items.additionalProperties).toBe(false);
    expect(schema.properties.contact.additionalProperties).toBe(false);
    expect(schema.properties.contact.required).toEqual(expect.arrayContaining(['name', 'email']));
    expect(schema.properties.contact.properties.name.anyOf).toBeUndefined();
    expect(schema.properties.contact.properties.email.anyOf).toBeUndefined();
    expect(schema.properties.consent.const).toBe(true);

    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validateSchema = ajv.compile(checkedIn);
    const duplicateSemantics = {
      ...completeInput(),
      cargo_ready_date: '2026-02-30',
      selected_services: ['pickup', 'pickup'],
    };

    expect(validateSchema(duplicateSemantics)).toBe(true);
    expect(draftIssuePaths(duplicateSemantics)).toEqual(
      expect.arrayContaining(['cargo_ready_date', 'selected_services.1']),
    );
    expect(validateSchema({ ...completeInput(), owner: 'forbidden' })).toBe(false);
    expect(validateSchema(createFclInquiryDraft())).toBe(false);
    expect(
      validateSchema({
        ...completeInput(),
        contact: { ...completeInput().contact, name: null },
      }),
    ).toBe(false);
    expect(validateSchema({ ...completeInput(), consent: false })).toBe(false);
    for (const email of ['a..b@example.test', 'fixture@example..test']) {
      expect(
        validateSchema({
          ...completeInput(),
          contact: { ...completeInput().contact, email },
        }),
        email,
      ).toBe(false);
    }
    expect(validateSchema(completeInput())).toBe(true);
    expect(validateFclInquiryDraft(createFclInquiryDraft())).toEqual([]);
  });
});
