import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  FCL_RATE_DATASET_VERSION,
  fclQuoteDraftInputSchema,
  fclQuoteSchemas,
  fclQuoteSnapshotExtensionsSchema,
  fclRowAdjustmentsSchema,
  fclRateDatasetSchema,
  validateFclRateDataset,
} from '../../services/quote-native/fcl-contracts';

function dataset() {
  return {
    contract_version: FCL_RATE_DATASET_VERSION,
    label: 'Synthetic personal FCL rates',
    rates: [
      {
        rate_id: '00000000-0000-4000-8000-000000000001',
        supplier_label: 'Synthetic direct carrier',
        pol: 'Yantian',
        pod: 'Vancouver',
        valid_from: '2026-10-01',
        valid_until: '2026-12-31',
        source_ref: 'synthetic:rate-book-1',
        source_version: 'v1',
        note: null,
        items: [
          { container_type: '40HQ', ocean_freight: '1850.00', currency: 'USD' },
          { container_type: '20GP', ocean_freight: '1200.00', currency: 'USD' },
        ],
        additional_fees: [
          {
            name: 'Pickup',
            group: 'A',
            service: 'pickup',
            unit: 'CNTR',
            container_type: '40HQ',
            cost_price: '250.00',
            currency: 'CNY',
            note: null,
          },
          {
            name: 'Documentation',
            group: 'B',
            service: 'export_customs',
            unit: 'SHIPMENT',
            container_type: null,
            cost_price: '0',
            currency: 'CNY',
            note: 'Synthetic zero fee',
          },
        ],
      },
      {
        rate_id: '00000000-0000-4000-8000-000000000002',
        supplier_label: 'Synthetic alternate carrier',
        pol: 'Yantian',
        pod: 'Vancouver',
        valid_from: '2026-10-01',
        valid_until: '2026-11-30',
        source_ref: 'synthetic:rate-book-2',
        source_version: 'v2',
        note: 'Same route is intentionally allowed',
        items: [{ container_type: '40HQ', ocean_freight: '1900.00', currency: 'USD' }],
        additional_fees: [],
      },
    ],
  };
}

describe('FCL rate dataset contract', () => {
  it('accepts a complete personal dataset and multiple rates on the same route', () => {
    expect(fclRateDatasetSchema.parse(dataset())).toEqual(dataset());
    expect(validateFclRateDataset(dataset())).toEqual([]);
    expect(() => z.toJSONSchema(fclRateDatasetSchema, { target: 'draft-2020-12' })).not.toThrow();
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(z.toJSONSchema(fclRateDatasetSchema, { target: 'draft-2020-12' }));
    expect(validate(dataset())).toBe(true);
  });

  it('rejects duplicate rate ids and duplicate container types in one rate', () => {
    const duplicateRate = dataset();
    duplicateRate.rates[1]!.rate_id = duplicateRate.rates[0]!.rate_id;
    expect(validateFclRateDataset(duplicateRate)).toContain('duplicate_rate_id');

    const duplicateContainer = dataset();
    duplicateContainer.rates[0]!.items[1]!.container_type = '40HQ';
    expect(validateFclRateDataset(duplicateContainer)).toContain('duplicate_container_type');
  });

  it('accepts unused historical maintenance dates without imposing their order', () => {
    const inverted = dataset();
    inverted.rates[0]!.valid_from = '2027-01-01';
    expect(validateFclRateDataset(inverted)).toEqual([]);

    const impossible = dataset();
    impossible.rates[0]!.valid_from = '2026-02-30';
    expect(fclRateDatasetSchema.safeParse(impossible).success).toBe(false);
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(z.toJSONSchema(fclRateDatasetSchema, { target: 'draft-2020-12' }));
    expect(validate(impossible)).toBe(false);
  });

  it('requires CNTR fees to name an item container and SHIPMENT fees to omit it', () => {
    const missing = dataset();
    missing.rates[0]!.additional_fees[0]!.service = 'delivery';
    missing.rates[0]!.additional_fees[0]!.container_type = '20GP';
    // 20GP exists, so switch to a valid type that is not in this dataset.
    missing.rates[0]!.items = missing.rates[0]!.items.filter((item) => item.container_type !== '20GP');
    expect(validateFclRateDataset(missing)).toContain('fee_container_not_in_items');

    const missingType = dataset();
    missingType.rates[0]!.additional_fees[0]!.container_type = null;
    expect(fclRateDatasetSchema.safeParse(missingType).success).toBe(false);

    const shipmentWithContainer = dataset();
    shipmentWithContainer.rates[0]!.additional_fees[1]!.container_type = '40HQ';
    expect(fclRateDatasetSchema.safeParse(shipmentWithContainer).success).toBe(false);
  });

  it('rejects negative, floating, null and over-precision money values', () => {
    for (const value of ['-1', '001', '1.1234567', 0, null]) {
      const invalid = dataset();
      (invalid.rates[0]!.items[0] as { ocean_freight: unknown }).ocean_freight = value;
      expect(fclRateDatasetSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('rejects unknown fields, forged versions and overlong notes', () => {
    expect(fclRateDatasetSchema.safeParse({ ...dataset(), owner_id: 'forged' }).success).toBe(false);
    expect(fclRateDatasetSchema.safeParse({ ...dataset(), contract_version: 'fcl-rate-dataset@2099-01-01.v1' }).success).toBe(false);
    const longNote = dataset();
    longNote.rates[0]!.note = 'x'.repeat(2001);
    expect(fclRateDatasetSchema.safeParse(longNote).success).toBe(false);
  });

  it('keeps generated FCL quote schemas synchronized and Draft 2020-12 compilable', () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    for (const [name, schema] of Object.entries(fclQuoteSchemas)) {
      const generated = JSON.parse(
        readFileSync(`schemas/admin-control/quote-documents/fcl-quote-${name}.schema.json`, 'utf8'),
      ) as unknown;
      expect(generated).toEqual(z.toJSONSchema(schema, { target: 'draft-2020-12' }));
      expect(() => ajv.compile(generated as object)).not.toThrow();
    }
  });
});

describe('FCL per-ticket row adjustment contract', () => {
  const changes = {
    changes: [
      {
        row_key: 'ocean_freight:40HQ',
        operation: 'override' as const,
        cost_price: '3250',
        sell_price: null,
        unit: 'CNTR' as const,
        container_type: '40HQ' as const,
        reason: 'Ticket-specific supplier correction',
      },
    ],
  };

  const input = (extensions: unknown) => ({
    extensions,
    source_sell_prices: [],
    manual_fees: [],
    service_scopes: [],
    exchange_rates: { USD: null, CAD: null },
    remark: null,
  });

  it('accepts override/remove, decimal null/zero and explicit billing basis', () => {
    expect(fclRowAdjustmentsSchema.parse(changes)).toEqual(changes);
    expect(fclRowAdjustmentsSchema.safeParse({
      changes: [
        { row_key: 'rate_fee:0:delivery:CNTR:40HQ', operation: 'override', cost_price: '0', unit: 'SHIPMENT', reason: 'Bill once' },
        { row_key: 'ocean_freight:20GP', operation: 'remove', reason: 'Combined into another line' },
      ],
    }).success).toBe(true);
    expect(fclQuoteDraftInputSchema.safeParse(input({ fcl_row_adjustments_v1: changes })).success).toBe(true);
  });

  it('rejects duplicate/unknown or forged adjustment fields', () => {
    expect(fclRowAdjustmentsSchema.safeParse({ changes: [...changes.changes, changes.changes[0]] }).success).toBe(false);
    for (const forged of [
      { ...changes.changes[0], quantity: '2' },
      { ...changes.changes[0], actor: 'forged' },
      { ...changes.changes[0], created_at: '2026-10-08T12:00:00.000Z' },
      { ...changes.changes[0], original_cost_price: '3200' },
      { ...changes.changes[0], cost_amount: '6400.00' },
      { row_key: 'ocean_freight:40HQ', operation: 'remove', cost_price: null, reason: 'invalid removal' },
      { row_key: 'ocean_freight:40HQ', operation: 'override', reason: 'no actual field' },
      { row_key: 'ocean_freight:40HQ', operation: 'override', container_type: null, reason: 'unit is required with container_type' },
      { row_key: 'ocean_freight:40HQ', operation: 'override', unit: 'CNTR', reason: 'missing container' },
      { row_key: 'ocean_freight:40HQ', operation: 'override', unit: 'SHIPMENT', container_type: '40HQ', reason: 'invalid shipment container' },
    ]) {
      expect(fclRowAdjustmentsSchema.safeParse({ changes: [forged] }).success).toBe(false);
    }
  });

  it('accepts the read-only audit only on snapshots and keeps legacy input closed', () => {
    const audit = {
      fcl_row_adjustments_v1: changes,
      fcl_row_adjustment_audit_v1: {
        changes: [{
          row_key: 'ocean_freight:40HQ',
          operation: 'override',
          reason: 'Ticket-specific supplier correction',
          original: { quantity: '2', unit: 'CNTR', container_type: '40HQ', cost_price: '3200', sell_price: null },
          effective: { quantity: '2', unit: 'CNTR', container_type: '40HQ', cost_price: '3250', sell_price: null },
          actor: 'fcl-document-receiver',
          created_at: '2026-10-08T12:00:00.000Z',
        }],
      },
    };
    expect(fclQuoteSnapshotExtensionsSchema.safeParse(audit).success).toBe(true);
    expect(fclQuoteDraftInputSchema.safeParse(input(audit)).success).toBe(false);
    expect(fclQuoteDraftInputSchema.safeParse(input(undefined)).success).toBe(true);
  });
});
