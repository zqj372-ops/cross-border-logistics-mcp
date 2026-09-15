# RFC: Quote document workflow v3

Status: Accepted for local implementation by Mac review on 2026-09-15. This acceptance covers the R3 architecture plus the final baseline interpretations in section 21; production deployment and merge remain separately gated.

Date: 2026-09-15

Candidate scope: price-free standard fee templates, compact fee editing, an independent quote-record view, editable saved drafts, explicit review and export checkpoints, append-only revision evidence, and compatible v1/v2 readers.

## 1. Review disposition

This revision explicitly addresses the four P1 findings and the synchronized corrections on PR #28:

| Finding | R3 disposition |
| --- | --- |
| P1 legacy payload must not be renumbered | Preserves original legacy version/state/PDF keys, imports only the actual current snapshot, and defines legacy approval provenance. |
| P1 unmodified legacy writers cannot share an upgraded database | Changes rollback to a guarded read-only compatibility mode or a pre-upgrade backup restore; unmodified v2 writers are refused by the database version gate. |
| P1 read-only v3 access must not claim or migrate | Claims a legacy row only on the first explicit authorized v3 write; v1/v2 list and get have one consistent claimed/unclaimed rule. |
| P1 native/access invariants | Makes organization, owner, document kind and linked case reference immutable; supports `native_unlinked`; requires owner/admin for approve/reject/config-save/replay; defines server-owned native digest and source-kind transitions. |
| Synchronized corrections | Fixes mode-specific version guards, expired-current history, incomplete-draft export, render-time rechecks, stale reason codes, legacy fee-item preservation and partial-total labeling. |

The previous R1 and R2 text that allowed old payload renumbering, unguarded old writers or read-time migration is withdrawn. Neither revision is an accepted contract.

The final interpretation section is normative where it narrows an earlier R3 sentence.

## 2. Problem and current evidence

The current implementation provides:

- `services/quote-documents/contracts.ts`: `quote-documents@2026-09-08.v1` and linked `quote-documents@2026-09-13.v2`.
- `services/quote-documents/service.ts`: create-only save, preview, approval, rejection, PDF cache and linked safety checks.
- `quote_documents`: one mutable JSON payload per document id.
- `document_audit`: an action digest, actor and timestamp; it cannot reconstruct the prior input, template or rejection reason.
- `document_idempotency`: a scope, key, digest and serialized result; ordinary writes return the old result without re-checking current authorization.
- `document_pdfs`: cache keyed by document id and version.
- `apps/console/quote-documents.js`: the saved editor is disabled and records are displayed in the editor sidebar.

The existing enterprise template also contains priced `fee_items`. That is a common-fee list, not the price-free standard template proposed here. Reusing stored unit prices across quotes would create an unverified price source and is outside this contract.

## 3. Product decisions

These decisions are fixed for this RFC and do not require a further product-question round:

- A standard template contains fee structure only: name, description, group, unit, suggested quantity, display mode and merge label. It contains no price, tax rate, exchange rate, company, customer or carrier.
- Standard fee groups and candidate names are:
  - A: 起运提货、报关、起运港操作、文件
  - B: 海运费、保险
  - C: 目的港操作、清关服务、拆柜/分拣、仓储、尾程派送、预约、尾板、等待
- Taxes are manually optional fields. The system does not derive a tax rate or tax amount.
- Standard items are not selected by default. The user explicitly checks the applicable items.
- Native price-bound fee rows cannot be replaced by a standard template.
- `approved` documents are immutable. `draft` and `rejected` documents can be updated under the same document id with append-only history.
- Price-affecting edits to a native-bound draft require a new native prepare. Non-price edits may retain the existing binding only after all current source, case, customer-supplement and permission gates pass again.
- `document_kind` is immutable and is one of `manual`, `native_unlinked` or `linked`. Organization and owner are immutable after creation.
- A linked document's `case_ref` is immutable. A replacement native prepare can update the reviewed customer supplement reference and price but cannot attach the document to another case.
- Approve, reject, config-save and their replays require current organization owner/admin membership. A platform role does not create enterprise authority.

## 4. Goals and non-goals

Goals:

- Save incomplete manual drafts without filling missing prices with zero.
- Preserve every editable revision and its template snapshot, rejection reason and approval evidence.
- Continue an existing draft by document id without creating a duplicate.
- Require a current, version-bound human review before approval and formal export.
- Make draft, formal and historical exports unambiguous.
- Keep v1 and v2 behavior intact for legacy clients and legacy rows.
- Present editing, review and records as distinct work surfaces.

Non-goals:

- No new workflow engine, document store or price authority.
- No model, agent, host-permission or security-policy change.
- No production deployment, external send, booking or payment.
- No automatic tax calculation.
- No automatic conversion of missing values to zero or one.
- No template-based replacement of native engine fee rows.
- No new machine MCP tool or API Key grant.

## 5. Version and schema plan

### 5.1 Versions

- Request contract: `quote-documents-workflow@2026-09-15.v1`.
- Response schema: `quote-documents@2026-09-15.v3`.
- Standard fee template: `quote-fee-template@2026-09-15.v1`.
- Draft projection: `quote-document-draft@2026-09-15.v1`.
- Stored revision: `quote-document-revision@2026-09-15.v1`.

The existing v1 and v2 versions remain readable and writable under their existing rules. New behavior is selected only by the v3 request contract.

### 5.2 Closed-object rule

Every new request, response, draft, revision and list object is a Draft 2020-12 closed object. `additionalProperties` is explicitly `false`. Unknown fields are rejected; they are not ignored and are not copied into storage.

## 6. Draft input, completeness and save semantics

### 6.1 Draft input schema

A saved draft is a structurally valid but potentially incomplete document:

```json
{
  "schema_version": "quote-document-draft@2026-09-15.v1",
  "quote_no": null,
  "customer_name": null,
  "quote_date": null,
  "valid_until": null,
  "origin": null,
  "destination": null,
  "route_name": null,
  "job_no": null,
  "so_no": null,
  "container_no": null,
  "remark": null,
  "exchange_rates": {
    "USD": null,
    "CAD": null
  },
  "fee_items": []
}
```

Each draft fee row has this shape:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "source_kind": "manual",
  "template_ref": null,
  "name": null,
  "description": null,
  "group": null,
  "quantity": null,
  "unit": null,
  "unit_price": null,
  "currency": null,
  "display": null,
  "merge_name": null,
  "note": null
}
```

Rules:

- `id` is a UUID and is stable across updates within the same revision lineage.
- `source_kind` is `manual`, `template` or `native`.
- A `template` row requires `template_ref` with `template_id`, `template_version` and `item_key`.
- A `native` row is server-created from a native quote binding and cannot be changed into a manual or template row.
- Semantic missing means JSON `null`. Empty strings are not normalized to `null` or to `0`.
- Missing unit prices remain `null`. A literal decimal `"0"` is valid only when explicitly supplied by the user or native source; it is never a placeholder.
- Exchange rates remain `null` when missing. They are never defaulted to `1`.
- A fee currency is explicit or inherited only from a currency the user already selected for the document. The template does not select a currency.
- Per-currency totals remain available from valid rows. A converted total is `null` with a visible missing-rate reason when a required rate is absent; it is never calculated with an assumed rate of one.
- While a draft is incomplete, any monetary sum is marked `partial:true` and `complete:false`. Rows with a missing quantity or price contribute no amount, and the UI must not label the result as a complete quote total.
- The draft may contain zero to 60 fee rows. The server enforces the limit before any mutation.
- No business field uses a Zod/default transformation in v3. Defaults may be displayed by the UI, but the client must send the explicit value it presents to the user.

### 6.2 Completeness result

The server computes completeness from the stored revision. It returns JSON Pointer-style paths:

```json
{
  "complete": false,
  "missing_fields": [
    "/quote_no",
    "/valid_until",
    "/fee_items/0/name",
    "/fee_items/0/quantity",
    "/fee_items/0/unit",
    "/fee_items/0/unit_price",
    "/fee_items/0/currency",
    "/fee_items/0/group",
    "/fee_items/0/display"
  ],
  "blocking_reasons": [],
  "can_review": false
}
```

Completeness requires:

- non-empty `quote_no` and `customer_name`;
- ISO `quote_date` and `valid_until`, with `valid_until >= quote_date`;
- at least one fee row;
- every fee row has name, positive decimal quantity, unit, unit price, currency, group and display mode;
- `merge_name` when display is `merged`;
- no duplicate fee ids.

An explicit unit price of `"0"` satisfies the completeness rule only because the value is present. A missing price does not.

### 6.3 Save is not review

`save` writes work. It does not confirm price, source, validity, terms or customer risk. `save_intent` is the literal `"save_draft"`. The human-verification literal remains reserved for approval.

Manual draft save does not require a document preview. The draft schema is validated, completeness is recomputed and the revision is stored. `preview` and `review` may return `needs_input` with `missing_fields`; they must not write a draft.

This prevents the current defect in which a blank price cannot be saved without first producing a fully valid `documentSchema`.

### 6.4 Manual create request

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "operation": "create",
  "document_kind": "manual",
  "input": {
    "schema_version": "quote-document-draft@2026-09-15.v1",
    "quote_no": null,
    "customer_name": null,
    "quote_date": null,
    "valid_until": null,
    "origin": null,
    "destination": null,
    "route_name": null,
    "job_no": null,
    "so_no": null,
    "container_no": null,
    "remark": null,
    "exchange_rates": { "USD": null, "CAD": null },
    "fee_items": []
  },
  "template_selection": { "mode": "current" },
  "save_intent": "save_draft"
}
```

The `Idempotency-Key` header is required. No `preview_hash`, `confirmed` or fabricated monetary value is accepted.

### 6.5 Manual update request

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "operation": "update",
  "document_kind": "manual",
  "id": "00000000-0000-4000-8000-000000000001",
  "expected_version": 3,
  "input": {
    "schema_version": "quote-document-draft@2026-09-15.v1",
    "quote_no": "Q-2026-001",
    "customer_name": "Synthetic customer",
    "quote_date": "2026-09-15",
    "valid_until": null,
    "origin": null,
    "destination": null,
    "route_name": null,
    "job_no": null,
    "so_no": null,
    "container_no": null,
    "remark": null,
    "exchange_rates": { "USD": null, "CAD": null },
    "fee_items": [
      {
        "id": "00000000-0000-4000-8000-000000000002",
        "source_kind": "manual",
        "template_ref": null,
        "name": "Base freight",
        "description": null,
        "group": "B",
        "quantity": "1",
        "unit": "shipment",
        "unit_price": null,
        "currency": "USD",
        "display": "detail",
        "merge_name": null,
        "note": null
      }
    ]
  },
  "template_selection": { "mode": "retain" },
  "save_intent": "save_draft"
}
```

The `Idempotency-Key` header is required. The server checks `expected_version` in the same immediate transaction that appends the revision. A mismatch returns `version_conflict` without replacing the current revision.

### 6.6 Native and linked draft save

`document_kind`, organization, owner and linked `case_ref` are immutable from creation through every revision. A document cannot be converted between manual and native, and a linked document cannot be reattached to another case. Changing to another case requires creating a new document.

The three native-capable document kinds are:

| Kind | Required evidence |
| --- | --- |
| `manual` | No native binding. |
| `native_unlinked` | A server-issued native binding, with no inquiry case link. |
| `linked` | A server-issued native binding plus an inquiry case link. |

`native_unlinked` is a first-class path for a native quote that has no inquiry case. It must not be forced into manual mode or fabricated as a linked quote.

Native bindings reserve these validation fields:

```json
{
  "schema_version": "native-quote-binding@2026-09-15.v1",
  "request": { "<native request>": "..." },
  "preview": { "<native preview>": "..." },
  "source_refs": [{ "<source ref>": "..." }],
  "source_refs_digest": "<canonical sha256>",
  "release_id": "release-1",
  "release_digest": "<64 hex>",
  "request_hash": "<64 hex>",
  "document_fee_digest": "<canonical sha256>",
  "document_fee_digest_format": "canonical-json-sha256-v1",
  "binding_hash": "<server signature>",
  "provenance": "v3_server_signed"
}
```

`document_fee_digest` is computed by the server from the ordered native-bearing fields `id`, `source_kind`, `quantity`, `unit`, `unit_price`, `currency` and `display`. It excludes presentation-only name, description, note and merge label. The server recomputes it from persisted input and never trusts a client-supplied digest. `binding_hash` is server-generated over the complete binding, organization, owner, document kind, document id when known and linked `case_ref` when present. A client cannot manufacture or modify either value.

`source_kind` transitions are fixed:

| Current | Allowed next value |
| --- | --- |
| `manual` | `manual` or `template` |
| `template` | `template` or `manual` |
| `native` | `native` only |

A client cannot submit a `native` row without a server-verified binding. A native row cannot be downgraded to manual or template to evade rebind or approval. A template cannot overwrite, remove or hide a native row.

Native create carries the exact server-issued result:

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "operation": "create",
  "document_kind": "native_unlinked",
  "input": { "<quote-document-draft>": "..." },
  "template_selection": { "mode": "current" },
  "native_quote_v1": { "<server-issued binding>": "..." },
  "preview_hash": "<native-prepare signature>",
  "preview_expires_at": 1790000000000,
  "save_intent": "save_draft"
}
```

A linked create uses the same object with `document_kind:"linked"` plus:

```json
{
  "inquiry_case_link_v1": {
    "case_ref": "00000000-0000-4000-8000-000000000020",
    "reviewed_customer_event_ref": null
  }
}
```

Linked update retains the existing binding for non-price edits:

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "operation": "update",
  "document_kind": "linked",
  "id": "00000000-0000-4000-8000-000000000001",
  "expected_version": 3,
  "input": { "<quote-document-draft>": "..." },
  "template_selection": { "mode": "retain" },
  "binding_update": { "mode": "retain" },
  "save_intent": "save_draft"
}
```

`native_unlinked` uses the same update shape with `document_kind:"native_unlinked"` and no `inquiry_case_link_v1`. It rechecks the native release/source gates but has no case or customer-supplement gate. It cannot later add a case link; that requires a new linked document.

`retain` rechecks organization membership, document owner/manager visibility, case permission intersection, current customer-supplement reference, release id/digest, request hash, source-reference digest and release validity. A changed price-affecting digest fails with `native_quote_rebind_required`; removing the binding is `inquiry_quote_link_forgery`.

A price-affecting edit uses a new native prepare for the same organization and, for linked documents, the same `case_ref`:

```json
{
  "mode": "replace",
  "native_quote_v1": { "<new server-issued binding>": "..." },
  "inquiry_case_link_v1": {
    "case_ref": "<must equal the stored case_ref>",
    "reviewed_customer_event_ref": "<current server-validated value>"
  },
  "preview_hash": "<new native-prepare signature>",
  "preview_expires_at": 1790000000000
}
```

The replacement path verifies that `case_ref` is unchanged, the customer supplement/current case/source gates pass, and the server recomputed `document_fee_digest` matches the new binding. It appends a revision under the same document id.

Legacy native/approved rows retain `provenance:"legacy_v1_v2"` and their original binding. They may remain eligible for legacy formal export under the legacy gate, but they do not acquire a fabricated v3 review. A v3 edit, review or approval requires a new server-signed binding from `native-prepare`.

## 7. Standard fee template

### 7.1 Template object

```json
{
  "schema_version": "quote-fee-template@2026-09-15.v1",
  "template_id": "freightclaw-standard-v1",
  "template_version": 1,
  "source": "platform",
  "groups": [
    {
      "group": "A",
      "label": "起运段",
      "items": [
        {
          "item_key": "origin_pickup",
          "name": "起运提货",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "export_customs",
          "name": "报关",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "origin_port_handling",
          "name": "起运港操作",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "documentation",
          "name": "文件",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        }
      ]
    },
    {
      "group": "B",
      "label": "干线运输",
      "items": [
        {
          "item_key": "ocean_freight",
          "name": "海运费",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "insurance",
          "name": "保险",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        }
      ]
    },
    {
      "group": "C",
      "label": "目的段",
      "items": [
        {
          "item_key": "destination_port_handling",
          "name": "目的港操作",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "destination_customs_clearance",
          "name": "清关服务",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "devanning_sorting",
          "name": "拆柜/分拣",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "storage",
          "name": "仓储",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "final_mile_delivery",
          "name": "尾程派送",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "appointment",
          "name": "预约",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "liftgate",
          "name": "尾板",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        },
        {
          "item_key": "waiting",
          "name": "等待",
          "description": null,
          "unit_suggestion": null,
          "quantity_suggestion": "1",
          "display": "detail"
        }
      ]
    }
  ]
}
```

The template source does not contain `unit_price`, `amount`, `tax_rate`, `tax_amount`, currency selection, exchange rate, customer, carrier or company fields. A tax fee can be added manually through the ordinary fee editor; no rate is inferred.

### 7.2 Configuration and snapshots

V3 stores the selected standard template extension alongside the existing company template. V1/v2 config-save preserves `standard_fee_template_v1` rather than replacing the whole JSON with the old schema.

When an existing document is opened:

- Default template selection is `retain`; the document keeps its stored company, terms and template version snapshot.
- `refresh_current` is explicit and records a new template snapshot plus the current config version.
- Refreshing the template invalidates preview/review and requires a new server-issued preview/review signature before approval.

An old draft is migrated with its stored template snapshot. Changing enterprise configuration does not silently change the old draft.

### 7.3 Apply, duplicate and replace rules

The standard template is applied only to editable manual drafts:

- No item is selected by default.
- Default action is append.
- Exact duplicate `template_ref` rows are skipped and counted in the UI.
- A same `item_key` from a different template version, or a same normalized name/group/unit manual row, is surfaced as a conflict; the user must keep, add or replace it.
- Replace mode first lists every manual row it will remove and requires confirmation. Cancel leaves the draft unchanged.
- Native rows are never removed, replaced or hidden.
- The 60-row limit is preflighted before any mutation. If the addition would exceed 60, the entire apply is blocked with `fee_item_limit_exceeded`.
- Applying twice must not silently duplicate the same template item.

## 8. Create, get and list JSON

### 8.1 Save response and get response

V3 get request:

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "id": "00000000-0000-4000-8000-000000000001"
}
```

Save and get return the current revision projection:

```json
{
  "schema_version": "quote-documents@2026-09-15.v3",
  "status": "success",
  "data": {
    "id": "00000000-0000-4000-8000-000000000001",
    "document_id": "00000000-0000-4000-8000-000000000001",
    "revision_id": "00000000-0000-4000-8000-000000000010",
    "version": 3,
    "state": "draft",
    "document_kind": "manual",
    "organization_id": "org-1",
    "input": { "<quote-document-draft@2026-09-15.v1>": "..." },
    "completeness": {
      "complete": false,
      "missing_fields": ["/valid_until", "/fee_items/0/unit_price"],
      "blocking_reasons": [],
      "can_review": false
    },
    "template": { "<template snapshot>": "..." },
    "template_version": 4,
    "native_quote_v1": { "<optional binding>": "..." },
    "inquiry_case_link_v1": { "<optional link>": "..." },
    "owner_id": "staff-1",
    "created_at": "2026-09-15T00:00:00.000Z",
    "updated_at": "2026-09-15T00:05:00.000Z",
    "approval": null,
    "rejection": null
  },
  "reason_codes": []
}
```

`get` returns the v3 projection for v3 rows. It never converts `null` to an empty string or zero. A direct v1/v2 `get` of a v3 row is blocked as `document_contract_version_required`.

### 8.2 List request and response

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "limit": 20,
  "cursor": null,
  "filters": {
    "state": "all",
    "quote_no": null,
    "customer_name": null
  }
}
```

```json
{
  "schema_version": "quote-documents@2026-09-15.v3",
  "status": "success",
  "data": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000001",
        "revision_id": "00000000-0000-4000-8000-000000000010",
        "version": 3,
        "state": "draft",
        "quote_no": "Q-2026-001",
        "customer_name": "Synthetic customer",
        "created_at": "2026-09-15T00:00:00.000Z",
        "updated_at": "2026-09-15T00:05:00.000Z",
        "complete": false,
        "inquiry_case_link_v1": null
      }
    ],
    "next_cursor": null
  },
  "reason_codes": []
}
```

Filters are applied server-side before pagination. Status values are `all`, `draft`, `approved` and `rejected`. Quote number and customer search cover all visible records matching the filter, not only the current page. The cursor is opaque and includes the last stable `(updated_at, document_id)` key plus a filter digest; a cursor used with different filters is rejected. The UI must not call this a full search when a backend filter is unavailable.

## 9. Append-only revisions and storage

### 9.1 Revision model

`version` is monotonic per document. Every create, update, reject and approval appends one revision:

| Operation | Source | New revision |
| --- | --- | --- |
| Create draft | none | version 1, `draft` |
| Update draft | current draft | version n+1, `draft` |
| Update rejected draft | current rejected revision | version n+1, `draft` |
| Reject draft | current draft | version n+1, `rejected`, rejection snapshot stored |
| Approve reviewed draft | current version n | version n+1, `approved`, transition-only copy |
| Claim legacy row on first v3 write | actual legacy version n | import n, then append n+1 for the authorized write |

The approved version is a copy of the reviewed version with unchanged input/template content. It records:

```json
{
  "source_revision_id": "<reviewed revision n>",
  "source_version": 3,
  "approved_revision_id": "<approved revision n+1>",
  "approved_version": 4,
  "review_hash": "<server signature>",
  "review_expires_at": 1790000600000,
  "evidence_ref": "manual:review-2026-09-15",
  "evidence_version": "1",
  "review_notes": "Checked price, source, validity and terms.",
  "actor": "staff-1",
  "at": "2026-09-15T00:10:00.000Z"
}
```

Formal export uses approved version n+1 and verifies that `source_revision_id` content digest equals the approved revision's copied content digest. This removes the ambiguity between the reviewed version and the approved version.

### 9.2 Tables

The existing `quote_documents`, `document_idempotency`, `document_audit` and `document_pdfs` table shapes are not changed. Their rows remain available to an explicitly guarded read-only rollback reader. An unmodified old binary that knows only schema version 2 is not allowed to write an upgraded database.

New v3 tables:

```sql
CREATE TABLE IF NOT EXISTS document_store_metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_revisions(
  revision_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  org TEXT NOT NULL,
  owner TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  template_digest TEXT NOT NULL,
  source_revision_id TEXT,
  review_hash TEXT,
  rejection_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(document_id, version)
);

CREATE TABLE IF NOT EXISTS document_current_revisions(
  document_id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  owner TEXT NOT NULL,
  revision_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  projection_digest TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_revision_events(
  audit_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL
);
```

`document_store_metadata` records logical `schema_version=3` and migration state. The database upgrade transaction also sets `PRAGMA user_version=3`; an unmodified v2 process rejects that database before opening it for business writes. If `PRAGMA user_version` is greater than 3, the v3 reader fails closed as incompatible.

### 9.3 Atomic write transaction

Every v3 write uses `BEGIN IMMEDIATE` and, before commit:

1. Reads current pointer and revision.
2. Resolves the current actor, organization, document ownership, owner/admin management role and linked case permission. It rejects any change to organization, owner, document kind or linked `case_ref`.
3. Checks the idempotency record and digest.
4. Checks `expected_version` and allowed state transition.
5. Validates the new draft/review/export contract.
6. Appends the revision.
7. Updates the current revision pointer.
8. Does not create a second writable legacy authority. Any legacy-compatible projection is derived only for a guarded read-only compatibility path.
9. Appends the existing audit row plus the revision-event link.
10. Stores the idempotent result.
11. Commits, then reads the new current revision back.

No partial revision, audit, idempotency or current-pointer state is visible after a failure.

### 9.4 Legacy claiming and version preservation

V3 read operations do not claim, migrate or rewrite a legacy row. They may return a read-only legacy projection marked `claim_state:"legacy_unclaimed"`; a list or get must not create `document_revisions` or `document_current_revisions`.

Opening a v2 database for v3 reads is also non-mutating: the reader may inspect the legacy schema and serve projections, but it must not create v3 tables or set the v3 version marker. The first explicit authorized v3 write performs the upgrade and claim.

The first explicitly authorized v3 write against a legacy row performs the claim in one immediate transaction:

1. Read the current legacy payload and preserve its actual `version=n`. Do not assume version 1.
2. Allocate a new `revision_id` for that current snapshot.
3. Store the actual state and the complete payload that exists now: input, template snapshot, native binding or case link, legacy approval object or rejection reason.
4. Record `legacy_import=true`, `original_version=n`, `current_snapshot_only=true`, `reconstructed_prior_versions=false` and `approval_provenance` where applicable.
5. Do not fabricate revisions for versions below n. Missing older editable inputs remain missing.
6. Append the new revision as `n+1`, update the v3 current pointer and mark the document `claim_state:"claimed_v3"`.

Existing PDF cache rows remain keyed by their original `(document_id, version)` values. A cache row for version 1, 4 or any other version is an exact historical receipt when bytes exist; it is not evidence that an editable revision snapshot exists. The history endpoint returns those cached bytes without converting them into revisions. No PDF is regenerated or renumbered during the claim.

Legacy approval provenance:

- A legacy `approved` payload has no v3 `review_hash` or `source_revision_id`. The claim records `approval_provenance:"legacy_v1_v2"`, the original approval object digest and the approved version.
- The legacy approval can continue to support the existing formal export path while the original validity, source and case gates pass. It does not acquire a new v3 human-verification package.
- A v3 edit of a legacy approved row is blocked; copy creates a new draft. A new v3 approval requires a new review and, for native/linked content, a new server-signed binding.
- A legacy rejected payload imports its original rejection reason as the current revision; later v3 edits append a draft and preserve the rejected revision.

```json
{
  "approval_provenance": {
    "kind": "legacy_v1_v2",
    "legacy_version": 4,
    "legacy_approval_digest": "<canonical sha256 of the original approval object>",
    "verified_by_rule": "legacy_approval_v1_v2",
    "v3_review_hash": null,
    "v3_source_revision_id": null
  }
}
```

### 9.5 Upgrade and rollback

Upgrade:

1. Acquire an exclusive SQLite transaction and require `PRAGMA user_version` to be 0 or 2.
2. Create the additive v3 tables and verify no partial v3 metadata exists.
3. Set logical metadata `schema_version=3` and `PRAGMA user_version=3` in the same transaction.
4. Commit before serving v3 writes. A crash before commit leaves a legacy database; a crash after commit leaves a v3 database that old writers cannot open.

Rollback is one of:

- a guarded compatibility binary that opens `PRAGMA user_version=3` with `query_only=ON`, serves only the legacy read projection and rejects every v3 or legacy write with `document_v3_rollback_read_only`;
- a full write rollback that restores the pre-upgrade SQLite backup into a separate path and atomically switches the configured database path.

An unmodified binary that knows only version 2 must fail closed against the upgraded database. It must not mutate the same database after a v3 claim. No dual-write reconciliation or post-hoc conflict repair is part of this RFC.

Rollback acceptance explicitly covers:

- an old binary attempting to open a v3 database and being rejected by the version gate;
- a read-only guarded reader denying approve/reject/save/PDF writes while returning permitted historical reads;
- a pre-upgrade backup restoring to a separate path without deleting v3 rows from the upgraded database;
- old documents at version greater than 1, in draft, approved and rejected states, retaining their original version and PDF cache keys.

## 10. Idempotency, replay and concurrency

### 10.1 Transport and scope

`Idempotency-Key` is required as the HTTP header for `config-save`, `save`, `approve` and `reject`. The value must satisfy `^[A-Za-z0-9._:-]{16,128}$`.

The personnel CLI passes `--idempotency-key` through the same header. It does not place the key in the JSON body or substitute a random key during an automatic retry.

The scope is:

`hash(contract_version, organization_id, actor_id, action, operation, document_id_or_null)`

The digest is a canonical JSON hash of the normalized request, excluding transport metadata. `null`, omitted and zero values remain distinct.

For a new key, the transaction writes the result and revision metadata. For an existing key:

- same key and same digest: replay path;
- same key and different digest: `idempotency_conflict`, no write.

Permission is re-evaluated before idempotency result disclosure. `approve`, `reject`, `config-save` and all of their replays require current organization owner/admin membership. Document ownership alone grants edit visibility but never approval authority. Platform roles without an active organization membership have no enterprise authority.

### 10.2 Replay authorization

Replay never returns a committed result before authorization:

1. Re-resolve active membership and organization.
2. Re-check document owner/managers and, for approve/reject/config-save, require current organization owner/admin membership.
3. For linked records, re-check case view/manage intersection.
4. If permission was revoked, return `document_not_found`/`blocked` with no document metadata.
5. If the committed revision is no longer current, return `manual_review` with committed id/version and current version/state, never a current success.
6. If the committed revision is current but validity/source/case is stale, return `manual_review` with `historical:true`, `valid_now:false` and no re-render.
7. Only an exact current, authorized replay may return the committed success, marked `replayed:true`.

### 10.3 Update/approve race

Both operations use one immediate transaction and read the current revision after acquiring the write lock. If update appends first, approval's `expected_version` is stale and it returns `version_conflict`; if approval appends first, update returns `document_state_not_editable`. A review whose `review_hash` does not name the attempted source version returns `document_review_stale`. No approval can bind version n after an update has advanced the document.

## 11. Review and approval

### 11.1 Review request

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "id": "00000000-0000-4000-8000-000000000001",
  "expected_version": 3
}
```

### 11.2 Review response

```json
{
  "schema_version": "quote-documents@2026-09-15.v3",
  "status": "success",
  "data": {
    "document_id": "00000000-0000-4000-8000-000000000001",
    "revision_id": "00000000-0000-4000-8000-000000000010",
    "reviewed_version": 3,
    "state": "draft",
    "input": { "<complete quote-document-draft>": "..." },
    "totals": { "<calculated totals>": "..." },
    "warnings": [],
    "blockers": [],
    "requirements": {
      "complete": true,
      "case_current": true,
      "native_source_current": true,
      "validity_ok": true
    },
    "can_approve": true,
    "available_export_modes": ["draft"],
    "review_hash": "<server signature of version n>",
    "review_expires_at": 1790000600000
  },
  "reason_codes": []
}
```

An incomplete draft returns `needs_input` with no hash and a closed completeness object:

```json
{
  "schema_version": "quote-documents@2026-09-15.v3",
  "status": "needs_input",
  "data": {
    "document_id": "00000000-0000-4000-8000-000000000001",
    "version": 3,
    "completeness": {
      "complete": false,
      "missing_fields": ["/valid_until", "/fee_items/0/unit_price"],
      "blocking_reasons": [],
      "can_review": false
    }
  },
  "reason_codes": ["document_incomplete"]
}
```

Saving remains available.

### 11.3 Approval request

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "id": "00000000-0000-4000-8000-000000000001",
  "expected_version": 3,
  "review_hash": "<server-issued review signature>",
  "evidence_ref": "manual:review-2026-09-15",
  "evidence_version": "1",
  "review_notes": "Checked price, source, validity and terms.",
  "confirmation": "human_verified_price_and_source"
}
```

The server verifies actor, organization, document revision, review expiry, current case/source gates and the exact reviewed version. It then appends the approved revision n+1 described in section 9.1.

The caller must currently be an organization owner/admin. A document owner who is not an organization owner/admin cannot approve or reject. The platform role has no implicit enterprise permission.

A legacy approved row is a separate branch:

- It retains `approval_provenance:"legacy_v1_v2"` and the original approval object digest.
- It can use the legacy formal-export verification path while its original validity/source/case checks pass.
- It cannot synthesize `review_hash`, `source_revision_id` or `human_verified_price_and_source`.
- A v3 change requires the user to copy/reopen under v3 and perform a fresh review.

## 12. Export contract

### 12.1 Modes

| Mode | Source |
| --- | --- |
| `draft` | Current unlinked manual draft/rejected revision, with a prominent draft marker. |
| `formal` | Current approved revision with current source/case/validity gates. |
| `history` | Exact cached bytes for a specified historical version. |

Version guards are mode-specific:

- `draft` and `formal` use `expected_version`.
- `history` does not accept `expected_version`; it uses `target_version` plus `expected_current_version`.

Formal export cannot use a draft revision as though it were approved. An incomplete draft request for `draft` export returns `needs_input`, includes the completeness pointers and does not invoke the renderer.

After any draft or formal render await, the server re-reads the document and current permissions, rechecks the source/case gates, verifies the document version is unchanged, validates PDF magic bytes and SHA-256, and performs the protected cache/readback write. It must discard the bytes and write no cache entry if any check changed.

Linked draft PDFs are disabled in v3 M1. The UI displays an explanation: the linked quote becomes formally exportable only after explicit approval; an existing cached receipt can be opened as history. A `draft` export request for linked input returns `document_export_mode_invalid` and never pretends to support it.

### 12.2 History request

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "id": "00000000-0000-4000-8000-000000000001",
  "mode": "history",
  "target_version": 2,
  "expected_current_version": 5
}
```

`target_version` selects cached bytes. Normally it is strictly less than `current_version`. It may equal the current version only when that current revision is no longer eligible for a new formal export because of expiry, source change or case terminal state and a cached PDF exists; this preserves v2-compatible historical receipt behavior. If the current version still supports formal export and target equals current, return `document_export_mode_invalid` and direct the caller to draft/formal mode.

`expected_current_version` is always a concurrency guard against reading history while the user is looking at a changed current document. If it differs from the stored current version, return `version_conflict`. History never invokes the renderer and returns `historical:true`, `valid_now:false`, `target_version` and `current_version`. On the v1/v2 compatibility branch, the existing successful `inquiry_quote_history_only` reason is preserved.

## 13. V1 and V2 compatibility

### 13.1 Reads

- A legacy row remains `legacy_unclaimed` until the first authorized v3 write. V3 get/list may return its read-only legacy projection but do not claim it.
- V1/v2 `get` of an unclaimed legacy row continues to return the existing payload.
- Once a row is `claimed_v3`, v1/v2 `list` omits it and v1/v2 `get` returns `blocked`, `data:null`, `document_contract_version_required`. The list/get behavior is therefore consistent: a row is either listable and readable under v1/v2, or omitted and blocked.
- V3 rows are never converted into fake complete records or zero-filled projections.
- Pagination scans the legacy rowid range and filters claimed v3 rows. A page may be short, but it never duplicates or silently wraps; `next_cursor` advances from the last scanned legacy row.

### 13.2 Mutations

V1/v2 `save`, `approve`, `reject` and `export` must resolve whether the target is claimed v3 before any write or render. They return `document_contract_version_required` and do not bypass v3 review, revision or source gates.

An unmodified v2 process must not open the upgraded database at all. A guarded read-only compatibility binary may serve permitted legacy reads but must deny every write. Full old-writer rollback is restore-of-backup, not concurrent access to the upgraded file.

### 13.3 Config-save

V1/v2 config-save may update the legacy company, terms and `fee_items` fields, but it must preserve `standard_fee_template_v1` and all v3-only config fields. It cannot replace the stored JSON with an old `templateSchema` object or drop the v3 extension.

### 13.4 Template snapshots

An old draft opened through v3 is displayed with its stored company/terms snapshot but remains unclaimed. The first authorized v3 write imports that actual snapshot at its original version n, then appends n+1. `template_selection:retain` is the default. Only an explicit `refresh_current` changes the snapshot and invalidates review.

## 14. Console workflow and records

The quote module has two separate top-level views:

- `制作报价单`: new/edit/review/export workflow.
- `报价记录`: full-width record list; it is not an editor sidebar.

The record list columns are quote number, customer, date, state, version and actions. It shows null values as `待填写`, never zero. The primary action for `draft`/`rejected` is `继续编辑`, which opens the same document id and updates it. Approved rows show view/export as primary and copy as secondary. Search/filter requests use the v3 list contract; the UI does not claim global search when only the current page was searched.

The list uses summary fields returned by the list contract. It does not issue one `get` request per row and does not imply per-row totals when the list contract does not provide them. Empty, loading, failed and paginated states are explicit; a failed list is not rendered as `暂无报价记录`.

Editing behavior:

- Draft save remains visible while editing and does not imply review or approval.
- A successful save shows the returned revision time and version and leaves the editor editable.
- A failed save/conflict preserves the current input in the page, does not clear fields and shows the latest server version for comparison.
- Leaving, creating, opening another record or applying a replace-template action checks for unsaved edits.
- A version conflict requires an explicit reload; the client never silently overwrites the server revision.

## 15. Compact fee layout

Desktop at 1280/1440 uses a compact row with name, quantity/unit, unit price/currency, group/display summary and remove action. The main row targets 44-52 px so 6-10 common fees can be scanned without opening each row. Numeric values are right-aligned and use tabular figures. Description, note, group, display and merge label are disclosed per row. Mobile at 390/320 uses the same semantic row stacked in one column with persistent field labels and explicit actions, no page-level horizontal overflow and no inaccessible action below an expanded row.

The implementation must preserve:

- stable fee ids and label-to-input associations;
- keyboard Tab order through names, quantity, unit, price and currency;
- visible focus;
- the 60-row limit;
- no zero substitution for an absent price;
- screenshot/PDF evidence at 1440, 1280, 390 and 320 widths.

## 16. Status and reason mapping

V3 uses the existing five-state envelope:

| Situation | HTTP | Status | Data | Reason |
| --- | --- | --- | --- | --- |
| Incomplete draft saved | 200 | `success` | draft projection | empty |
| Review/preview called on incomplete draft | 200 | `needs_input` | completeness object | `document_incomplete` |
| Draft PDF requested for incomplete draft | 200 | `needs_input` | completeness object | `document_incomplete` |
| Unknown/mixed v3 version | 400 | `needs_input` | null | `document_contract_version_invalid` |
| Missing update id/expected_version | 400 | `needs_input` | null | `document_update_input_invalid` |
| Update current-version mismatch | 409 | `blocked` | null | `version_conflict` |
| Approval source-version/review-hash mismatch | 409 | `blocked` | null | `document_review_stale` |
| Approved row update | 409 | `blocked` | null | `document_state_not_editable` |
| Non-owner/admin approve, reject, config-save or replay | 403 | `blocked` | null | `document_management_denied` |
| Platform role without enterprise membership on manual/native_unlinked | 403 | `blocked` | null | `document_organization_required` |
| Platform role without enterprise membership on linked data | 403 | `blocked` | null | `inquiry_quote_document_scope_required` |
| Revoked replay permission | 404 | `blocked` | null | `document_not_found` |
| Same idempotency key, different digest | 409 | `blocked` | null | `idempotency_conflict` |
| Historical replay not current | 200 | `manual_review` | committed metadata | `document_replay_not_current` |
| Linked draft PDF requested | 409 | `blocked` | null | `document_export_mode_invalid` |
| History target equals a still-valid current version | 409 | `blocked` | null | `document_export_mode_invalid` |
| History target equals an expired/stale current version with cached bytes | 200 | `success` | historical cache metadata | empty or legacy history reason |
| `expected_current_version` differs from current | 409 | `blocked` | null | `version_conflict` |
| History bytes missing | 503 | `unavailable` | null | `inquiry_quote_history_bytes_missing` |
| Native price-affecting edit without new prepare | 200 | `manual_review` | null | `native_quote_rebind_required` |
| Guarded read-only rollback receives a write | 409 | `blocked` | null | `document_v3_rollback_read_only` |
| Render completes after version/source/permission change | 200 | `manual_review` | null | applicable `version_conflict`, source/case reason |

The exact v3 schema must list allowed reason codes; arbitrary exception text is never exposed as a reason.

Legacy approval formal export is not converted into a v3 reason table. It uses the existing v1/v2 approval and export reason mapping, and only its original source, validity and case gates can permit new formal bytes.

## 17. Counterexample acceptance matrix

| ID | Counterexample | Expected result |
| --- | --- | --- |
| QW-01 | Save a draft with no price | Saved with `unit_price:null`; no zero inserted. |
| QW-02 | Save a draft with no fee rows or dates | Saved; completeness lists missing pointers. |
| QW-03 | Review an incomplete draft | `needs_input`, no review hash, no write. |
| QW-04 | Apply a priced template | Schema rejects the template price field. |
| QW-05 | Apply the same template twice | Existing template refs are skipped or surfaced as conflicts; no silent duplicate. |
| QW-06 | Apply a template that would create 61 rows | Entire apply fails with `fee_item_limit_exceeded`; draft unchanged. |
| QW-07 | Replace template rows containing native rows | Native rows are protected; operation cannot silently remove them. |
| QW-08 | Two tabs update version 3 | One appends version 4; the other receives `version_conflict` and preserves its input. |
| QW-09 | Edit rejected draft | Appends a new draft revision under the same id; rejection remains in revision history. |
| QW-10 | Update approved draft | Blocked; copy creates a new draft id. |
| QW-11 | Approve review at version 3 after update to version 4 | `version_conflict`; no approval write. |
| QW-12 | Approve review at version 3 | Appends approved version 4 with source/version evidence. |
| QW-13 | Request history target 2 while current is 5 | Returns bytes for version 2, `historical:true`, `valid_now:false`. |
| QW-14 | Request history target 5 while version 5 is still valid | `document_export_mode_invalid`; use draft/formal mode. |
| QW-15 | Replay a save after membership revocation | `document_not_found`; no metadata leak. |
| QW-16 | Replay an old save after the document advanced | `manual_review`, old revision/version, current version visible, never current success. |
| QW-17 | v1 client lists v3 incomplete rows | Rows omitted; no zero-filled projection. |
| QW-18 | v1 client gets/approves a v3 row | Blocked before write with `document_contract_version_required`. |
| QW-19 | v1 config-save after v3 template selection | `standard_fee_template_v1` remains intact. |
| QW-20 | Open old draft after enterprise template change | Old company/terms snapshot retained unless explicit refresh. |
| QW-21 | Linked non-price edit with stale customer supplement | Save blocked by existing customer/case gate. |
| QW-22 | Linked price edit without native prepare | `native_quote_rebind_required`; old binding unchanged. |
| QW-23 | Linked history bytes missing | `unavailable`; renderer not called. |
| QW-24 | 320/390/1280/1440 viewport | No overflow, no overlap, controls and focus order reachable. |
| QW-25 | Legacy draft first explicit v3 write | Claims the actual version n snapshot, appends n+1 and continues under the same document id with its stored template snapshot. |
| QW-26 | Browser flow finishes | Zero unexplained console/page errors, and generated draft/formal PDFs contain the expected state markers and totals. |
| QW-27 | Review hash names version 3 while current version is also 3 but content/source changed | `document_review_stale`; no approval write. |
| QW-28 | Legacy row is version 4 with PDF caches at versions 1 and 4 | Claim imports only actual version 4; first v3 write appends version 5; existing PDF keys are unchanged. |
| QW-29 | Unmodified v2 binary opens upgraded database | Version gate rejects it before write; guarded rollback is read-only. |
| QW-30 | Incomplete draft asks for draft PDF | `needs_input`, completeness pointers, no renderer call. |
| QW-31 | Current version is expired and has cached PDF | History returns that cache as historical, still subject to read permission. |
| QW-32 | Legacy config-save edits old fee_items | Legacy fee_items update while `standard_fee_template_v1` remains intact. |
| QW-33 | Incomplete draft shows monetary subtotal | UI labels it as partial/incomplete subtotal, not a complete quote total. |
| QW-34 | Legacy approved version 4 has no v3 review hash | Legacy provenance branch exports only when its original gates pass; no fabricated v3 review. |
| QW-35 | Native quote has no inquiry case | Uses `native_unlinked`; it is not converted to manual or forced to bind a case. |
| QW-36 | Linked replace prepare names another case | Blocked as forgery; original `case_ref` remains immutable. |
| QW-37 | Legacy rejected row is version 5 | Claim preserves version 5 and its rejection reason; first v3 edit appends draft version 6. |
| QW-38 | Legacy draft is version 7 with unrelated cached PDF versions | Claim preserves version 7; only actual revisions are stored and existing PDF keys remain unchanged. |
| QW-39 | V3 list/get opens an unclaimed legacy row | Returns a read-only projection and performs no claim/revision write. |
| QW-40 | Claimed v3 row appears through v1 list | It is omitted; direct get is blocked, so listing and opening remain consistent. |
| QW-41 | Replay approve after owner/admin downgrade | `document_management_denied`; no result disclosure. |
| QW-42 | Platform role without organization membership attempts approve/config-save | Blocked; platform role grants no enterprise authority. |

## 18. Candidate implementation files after acceptance

This RFC does not authorize their modification yet.

| File/area | Proposed change |
| --- | --- |
| `services/quote-documents/contracts.ts` | v3 draft, revision, template, review, export and list schemas |
| `services/quote-documents/service.ts` | append-only revisions, idempotency, review, update and export gates |
| `services/quote-documents/storage.ts` | new v3 tables, claim-on-first-write and transaction helpers if extraction is warranted |
| `services/access-gateway/portal/http.ts` | v3 version dispatch, `review` action and v1/v2 projection boundaries |
| `deploy/scripts/generate-native-schemas.ts` | generate v3 schemas after contract acceptance |
| `deploy/scripts/generate-portal-openapi.ts` | v3 request/response variants and review route |
| `deploy/cli/workspace.ts` | same-personnel CLI commands for create/get/list/update/review/approve/export |
| `apps/console/quote-documents.js` | edit, review, export and records views |
| `apps/console/quote-documents.css` | compact fee layout and responsive states |
| `tests/quote-documents/service.test.ts` | revision, migration, idempotency, completeness, review and export cases |
| `tests/access-gateway/portal-cases-http.test.ts` | v1/v2 compatibility and v3 envelopes |
| `tests/e2e/portal-browser/quote-documents-flow.mjs` | same-id edit, filters, leave guard, four viewports and PDF checks |

## 19. K12 execution checklist after Mac acceptance

1. Generate and validate closed v3 Draft 2020-12 schemas.
2. Add failing tests for nullable drafts, completeness pointers, zero preservation and save/review separation.
3. Add failing tests for append-only revisions, current pointer, audit linkage, actual-version claiming, legacy approval provenance, legacy version greater than 1 and guarded rollback.
4. Add failing tests for idempotency scope/digest, replay authorization, stale replay and update/approve races.
5. Add v1/v2 compatibility tests for unclaimed reads, claimed-row list/get/mutate blocking, pagination, legacy fee_items plus v3 extension preservation and old-binary version refusal.
6. Implement service and HTTP behind the explicit v3 selector; leave v1/v2 routes untouched.
7. Implement CLI commands and examples using the same personnel session.
8. Implement the separate records view, compact rows, template apply/replace flow, conflict preservation and leave guard.
9. Run focused unit/HTTP/CLI/e2e checks, including `native_unlinked`, immutable case/kind checks, incomplete export no-render, render-time revalidation, expired-current history and partial totals; then `typecheck`, `lint`, `validate:schemas`, `build`, `build:cli` and diff checks.
10. Verify actual Chromium screenshots at 1440/1280/390/320, zero unexplained console/page errors, and inspect draft/formal PDFs.

## 20. Acceptance gate

This RFC remains proposed. It is not accepted until Mac confirms:

- nullable incomplete draft save and completeness/review separation;
- append-only revision storage, original-version legacy claim, legacy approval provenance and guarded rollback;
- idempotency, replay authorization, owner/admin approval and immutable document/case identity;
- v1/v2 claimed/unclaimed filtering, pagination, config-extension and legacy fee-item preservation;
- native-bound and `native_unlinked` digest/source-kind rules;
- target-version history semantics, expired-current cache compatibility and review/approval version evidence;
- incomplete export no-render and post-render version/permission/source/checksum revalidation;
- the console records view, template application rules and four-width PDF acceptance.

No production deployment, real customer data, host security change or external write is part of this RFC.

## 21. Final Mac baseline interpretation

This section is the implementation baseline accepted on 2026-09-15. It narrows the R3 text where the two could be read differently.

### 21.1 Upgrade ownership and rollback

- Before the database version changes, all old writers and connections stop. The upgrade transaction obtains exclusive ownership and verifies that no legacy connection can still write.
- `PRAGMA user_version=3` prevents a newly opened old process from using the database; it does not evict an already running writer. Deployment tests must prove the old connection is stopped before upgrade.
- The default rollback is the guarded read-only compatibility mode. It opens the v3 database read-only, serves only allowed legacy projections and rejects all writes.
- Restoring a pre-upgrade backup to another path is disaster recovery, not the default rollback. It can lose business progress made after upgrade. It requires a separately confirmed recovery point and impact review, keeps the original v3 database, and never enables two writable databases or automatic cross-database merging.

### 21.2 Native pricing ownership

V3 M1 does not allow a manual or template fee row in a `native_unlinked` or `linked` document.

- Every priced row must come from the current server-side native prepare.
- A client cannot add, remove, downgrade or hide a native row. `hiddenExcluded` cannot be used to remove a native charge from the native total.
- A changed priced set requires a complete new native prepare and a server-signed replacement binding.
- The native fee digest is computed over the complete ordered native row set, including row identity, source kind and display behavior. It must not be a filter that silently ignores an unexpected manual extra row.

### 21.3 Permissions

- Ordinary active members retain the existing permission to create, update and read their own manual drafts.
- `owner` or `admin` is required for `approve`, `reject`, `config-save` and all replays of those actions.
- Section 9.3 is not a rule that every save requires manager authority.
- Linked actions use the intersection of the existing document permission and case permission.

### 21.4 Revision readback and replay

- One atomic transaction commits revision, current pointer, audit and idempotency together.
- The write result must read back by the exact document id, version and revision id created by this request. A concurrent next revision is never returned as this request's result.
- The current document pointer is returned through separate `current_version` and `current_revision_id` fields.
- Replay checks current authorization first, then distinguishes an exact current success from a historical committed result. A historical result never claims to be current.

### 21.5 Legacy unclaimed reads and write claiming

- `legacy_unclaimed` may be returned by v3 get/list/review using an explicit projection. `revision_id` may be `null`, and `claim_state` must be explicit.
- Review may sign the old version plus the complete legacy payload digest without writing a revision.
- Only the first actual `update`, `approve` or `reject` imports the actual version n and appends n+1.
- Only `create`, `update`, `reject` and `approve` append document revisions. `config-save` maintains a config version. `preview`, `review` and `export` do not increment document versions.

### 21.6 Closed schemas and final gates

- The final closed schemas use discriminated unions for requests and views, concrete reason-code enums, and no placeholder fields.
- V1, v2 and legacy approval branches remain readable and retain their existing gates.
- Manual and `native_unlinked` drafts may export draft PDF. `native_unlinked` export rechecks its native source. Linked draft PDF remains disabled with an explicit explanation.
- Incomplete drafts do not render. Existing PDF limits remain: minimum and maximum byte length, `%PDF-` header, SHA-256, protected cache write and readback, and version/permission/source rechecks on every export.
- Amounts are decimal strings. Missing amounts remain missing, not zero. Monetary subtotals for incomplete drafts are partial.
- History returns only the selected cached bytes. An expired current revision may be read as history when permission remains and the result is explicitly historical, never current-usable.

This section does not authorize production deployment, real customer data, external quote calls, email or merge.
