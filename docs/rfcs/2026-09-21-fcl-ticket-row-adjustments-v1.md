# RFC: FCL per-ticket row adjustments v1

Status: **Accepted by root for A1 implementation, 2026-09-21**. This is a narrow domain-contract change for the existing `FclQuoteDraftInput` and `buildFclCostSellSnapshot` path. It does not approve estimate-bound Quote updates, Portal/UI wiring, deployment or production use.

## Motivation

The selected FCL rate and template are source evidence. A ticket may still need a different cost, selling amount, billing basis or removed source fee. The current draft supports source selling-price projection and manual additions, but cannot apply audited per-ticket overrides without modifying the source snapshot or guessing the billing quantity.

## Contract

`FclQuoteDraftInput.extensions` gains one optional closed name:

```json
{
  "fcl_row_adjustments_v1": {
    "changes": [
      {
        "row_key": "ocean_freight:40HQ",
        "operation": "override",
        "cost_price": "3250",
        "sell_price": "3500",
        "unit": "CNTR",
        "container_type": "40HQ",
        "reason": "Ticket-specific supplier correction"
      }
    ]
  }
}
```

Rules:

- `changes` has at most 60 entries and duplicate `row_key` values are rejected.
- `operation` is `override` or `remove`; `reason` is required.
- `override` contains at least one of `cost_price`, `sell_price`, `unit` or `container_type`. Money values are decimal strings or `null`; `null` is incomplete, while `"0"` is an explicit zero amount.
- `remove` contains no override fields.
- `unit` is `CNTR` or `SHIPMENT`. A CNTR override requires an explicit valid `container_type`; a SHIPMENT override forbids one.
- `container_type` cannot be supplied without an explicit `unit`; a standalone `container_type: null` is rejected rather than being treated as an implicit retained value.
- Quantity is not client input. SHIPMENT uses quantity `1`; CNTR uses the case projection quantity for the explicit container type.
- The client cannot provide actor, timestamp, original values, quantities, totals or audit records.
- Unknown row keys, invalid container types and adjustment/input conflicts fail closed.
- `fcl_estimate_v1` remains optional and may coexist with row adjustments.

When adjustments are present, the snapshot retains the parsed input extension and adds a server-owned read-only `fcl_row_adjustment_audit_v1`. Each audit entry records the adjustment reason, original values, effective values or removal, actor and creation time. Input schemas reject this audit name. Readback requires the audit actor/time to match the snapshot, every effective value to match the persisted row, and explicit cost/sell overrides to equal their audited `null`, zero or decimal values.

`source_snapshot.rate` is never rewritten. Effective cost rows use the existing Decimal calculation and may be projected into the existing Quote Document review/approval/PDF path. Removing a row does not infer `free`, `included` or `out_of_scope`; existing service-coverage validation still applies.

## Compatibility

Draft inputs and snapshots without this extension serialize exactly as before. The existing workflow version and all old `fcl_estimate_v1` JSON remain unchanged. No new table, fee entity or generic write endpoint is introduced.

## Verification

Tests cover one/two-container and per-shipment quantities, override/remove, null versus zero, explicit container switching, source-object immutability, server-owned audit, forged fields, duplicate/unknown rows, service-scope blocking, missing FX and legacy serialization.

## Rollback

Stop writing new snapshots with this extension and retain the reader. Existing snapshots remain immutable and readable; no historical amount is rewritten.
