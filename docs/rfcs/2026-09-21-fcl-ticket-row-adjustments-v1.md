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

## A2 Accepted Scope: Estimate-Bound Quote Updates

Status addendum: **Accepted by root for A2 implementation, 2026-09-21**. This addendum connects the A1 row-adjustment contract to the existing personal FCL Quote and DocumentWorkflow path. It does not add an API, table, engine, UI layout or deployment approval.

An existing Quote carrying `extensions.fcl_estimate_v1` may be updated through the existing `quote-save` action only with `source_binding.mode="retain"`. The request must carry the exact existing estimate binding in its input extensions and may additionally carry `fcl_row_adjustments_v1`, manual fee changes, service scopes, FX and remark changes. Missing or changed identity fields fail closed; `replace` is rejected for a bound Quote.

The service rereads the exact estimate version, requires it to remain current, verifies its content digest and reconstructs the canonical estimate binding. It also rechecks the existing Case binding, source snapshot, route, container quantities and cargo-ready date before appending the next Quote version. The original estimate, selected rate/template, prior Quote revision and other Tickets remain unchanged.

The server persists the original binding and the A1 server-owned audit extension. The console `quoteDraftFromView` helper returns only writable input extensions, never the read-only audit. Source removals survive round-trip; an already-applied manual-row removal is dropped from the input adjustments because the manual row is absent and must not be reconstructed as an unknown row. Historical audit remains in the prior immutable snapshot.

An adjusted update invalidates old Document reviews through the existing Quote currentness checks. Formal Document review, approval and PDF continue to use the existing service and require a new current revision.
