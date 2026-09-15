# RFC: Quote document workflow v3

Status: Proposed for Mac review. This document defines an interface and version plan; it does not authorize or implement the behavior change.

Date: 2026-09-15

Candidate scope: add a reusable standard fee template, make saved drafts editable, replace the current editor/sidebar flow with explicit edit, review and export checkpoints, and compact the fee editor without changing v1 or v2 behavior.

## 1. Problem and current evidence

The current implementation is committed on the quote workflow branch and `main`:

- `services/quote-documents/contracts.ts` defines `quote-documents@2026-09-08.v1` and the linked `quote-documents@2026-09-13.v2` response contract.
- The enterprise template already contains `fee_items`, and the UI exposes `应用常用费用` for a new unlinked quote. This existing field is therefore a priced common-fee list, not a separate standard template.
- `apps/console/quote-documents.js` disables the editor after a document is saved:
  `fieldset ${saved&&!admin?'disabled':''}`.
- A saved document can be copied, approved, rejected or exported, but its input cannot be updated in place.
- `services/quote-documents/service.ts` implements preview, create-only save, approval, rejection and export. It has no update action and no saved-document review object.
- `export` currently selects draft versus formal output from stored state. Only linked v2 export has an explicit `formal` or `history` mode.
- The current fee editor renders every fee as a large card with all fields expanded. There is no compact summary row and detail disclosure for repeated fees.

The request has four product goals, but two require a contract decision before code:

1. Adding a standard fee template must not silently turn the existing priced common-fee list into a reusable price catalogue. Reusing a stored unit price across quotes would create an unverified price source and can reuse stale rates.
2. Making a saved draft editable requires an update contract with optimistic concurrency. Reusing the create-only `save` request would either create duplicates or silently overwrite newer work.

The layout change itself does not require an API version change. It is included in this plan because it changes how the same fields and review states are presented.

## 2. Confirmed facts, assumptions and review questions

Confirmed:

- Existing v1 and v2 clients and stored documents must remain readable.
- Existing native quote bindings remain immutable evidence. A linked quote's computed fee lines cannot be replaced by a reusable template without a separate pricing-authority decision.
- Existing approval semantically means `human_verified_price_and_source`, not merely that the user opened a review page.
- PDF caches are keyed by document id and document version.

Assumption for this proposal:

- `标准费用模板` means a reusable list of fee definitions such as name, description, group, unit, display mode and default quantity. It does not mean reusable prices, exchange rates, customer information or company information.
- The first implementation applies this template to manual or unlinked quote drafts. Linked native quote fee lines remain engine-owned. If staff need extra charge lines on a linked quote, that requires a separate contract that distinguishes native base fees from reviewed add-ons.

Required Mac review decisions:

1. Confirm the semantic above. If reusable unit prices are required, identify the authoritative price source and approval rule; this RFC cannot safely infer them.
2. Confirm that approved documents remain immutable and edits create a new draft copy; only `draft` and `rejected` documents may be updated in place.
3. Confirm whether an updated linked draft may change customer-facing notes and non-pricing fields while retaining the existing native binding, or whether every edit requires a fresh native prepare.
4. Provide the final standard fee item catalogue. The interface below is intentionally content-neutral and does not invent business fee names.

## 3. Non-goals

- Do not change v1 or v2 request or response contracts.
- Do not add a second document store, workflow engine, queue or price authority.
- Do not use a standard template as evidence that a price is current or approved.
- Do not allow editing of an approved document in place.
- Do not add automatic email, booking, payment or external writes.
- Do not change existing case, tenant, manager, PDF cache or PDF integrity rules.
- Do not make non-JavaScript clients adopt v3 in the same release.
- Do not remove existing common-fee data or existing stored template snapshots.
- Do not add full document revision history or restore in this RFC. The existing version field remains an optimistic-concurrency and PDF-cache key.

## 4. Version plan

### 4.1 Versions

The additive workflow contract uses:

- Request contract: `quote-documents-workflow@2026-09-15.v1`
- Response schema: `quote-documents@2026-09-15.v3`
- Standard fee template payload: `quote-fee-template@2026-09-15.v1`

The request contract and response schema are deliberately separate. The existing v2 request version is named for the inquiry quote link and cannot cleanly describe unlinked draft updates and review. The v3 request contract applies to both unlinked and linked documents; linked documents additionally carry `inquiry_case_link_v1`.

### 4.2 Compatibility

| Client/request | Server behavior |
| --- | --- |
| Existing v1 request, no `contract_version` | Existing v1 route and schemas remain unchanged. |
| Existing v2 request, `inquiry-quote-link@2026-09-13.v1` | Existing linked behavior and `quote-documents@2026-09-13.v2` remain unchanged. |
| New v3 request, `quote-documents-workflow@2026-09-15.v1` | Returns `quote-documents@2026-09-15.v3` and uses the new workflow semantics. |
| Unknown version or mixed v2/v3 fields | Reject before any write with `needs_input`; do not fall back to another version. |

V1 and v2 requests must never mutate a record that was created under a newer contract unless the request is valid for that record. A v3 record may return to a v2 reader only through a complete v2 projection; it must not be silently downgraded or have v3 fields stripped before authorization checks.

### 4.3 Version selection

The existing routes remain in place. V3 requests carry the explicit request version:

- `GET /console/api/v1/quote-documents/config?contract_version=quote-documents-workflow@2026-09-15.v1`
- `POST /console/api/v1/quote-documents/{config-save,preview,native-prepare,save,review,get,list,approve,reject,export}`

`review` is a new action on the existing route family. It is read-only with respect to stored business records; it produces a short-lived review object bound to a current document version. The route allowlist, OpenAPI generator and CLI command table must be updated only after this RFC is accepted.

## 5. Standard fee template

### 5.1 Data model

The standard template is a reusable, price-free definition:

```json
{
  "schema_version": "quote-fee-template@2026-09-15.v1",
  "template_id": "platform-standard-v1",
  "template_version": 1,
  "label": "Standard charge lines",
  "source": "platform",
  "items": [
    {
      "item_key": "base_freight",
      "name": "Base freight",
      "description": "",
      "group": "B",
      "unit": "shipment",
      "default_quantity": "1",
      "allowed_currencies": ["USD", "CAD", "CNY"],
      "display": "detail",
      "merge_name": ""
    }
  ]
}
```

Rules:

- `item_key` is stable within a template and is the identity used for diagnostics and template upgrade comparisons.
- `default_quantity` is a decimal string and defaults to `"1"` only when explicitly present in the template.
- `allowed_currencies` is a constraint, not a selected currency and not an exchange-rate source.
- `unit_price`, `amount`, exchange rates, totals, customer data and company data do not exist in this schema.
- Applying a template creates ordinary editable fee rows with new UUIDs. The user must still enter or confirm every unit price before preview.
- A saved document stores the actual fee rows in its current revision. A later change to the standard template must not alter an existing draft, approved document, approval evidence or PDF.

### 5.2 Organization configuration

`document_configs.input` remains readable as the existing v1 template. V3 adds an optional, closed extension:

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "expected_version": 3,
  "confirmed": true,
  "input": {
    "company_name": "Example Logistics",
    "company_address": "",
    "company_phone": "",
    "company_email": "",
    "terms": "Example terms",
    "fee_items": [],
    "standard_fee_template_v1": {
      "template_id": "platform-standard-v1",
      "template_version": 1,
      "items": []
    }
  }
}
```

The v3 config response may return the selected template alongside the existing template fields. V1 and v2 config responses must project only the fields those schemas already allow.

Organization customisation is a copy, not a live reference. If an administrator edits the selected template, the saved configuration records a new `template_version`; existing documents keep their already materialized fee rows.

### 5.3 Applying the template

The client may offer an `应用标准费用` action. Applying the template is local draft mutation because it does not change an authoritative record:

1. The server returns the selected template from config.
2. The client materializes each item into an editable fee row with a new UUID.
3. The unit price remains empty until the user supplies it.
4. Preview first occurs after the resulting document input satisfies `documentSchema`.

No `apply-template` write endpoint is added. If a future server-side materialization is needed, it must return a signed preview and must not use a reusable price.

### 5.4 Linked quote boundary

The application must hide or disable `应用标准费用` when the current draft has `native_quote_v1`. The current engine-owned fee rows are bound to `native_quote_v1.preview.total_price` and `request_hash`; replacing them or adding unreviewed fee lines would break that binding.

Adding reviewed additional fee lines to linked quotes is a later contract with a distinct additive total and source binding. It is not part of v3 M1.

## 6. Editable saved drafts

### 6.1 States and transitions

| Current state | Operation | Result |
| --- | --- | --- |
| `draft` | update save | Same document id, version increments, state remains `draft`. |
| `rejected` | update save | Same document id, version increments, state becomes `draft`; rejection history remains in audit. |
| `approved` | update save | `blocked`; use `copy` to create a new draft. |
| `draft` or `rejected` | approve | Only `draft` is approvable. |
| Any state | formal export | Requires the approved current version and current validity/source/case checks. |

An update must use `expected_version`. A mismatch returns `version_conflict` before any write. A successful update invalidates any previous preview and review object.

### 6.2 Update request

The v3 `save` request is a discriminated union:

Create:

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "operation": "create",
  "input": { "<validated document input>": "..." },
  "template_version": 3,
  "preview_hash": "<server signature>",
  "preview_expires_at": 1790000000000,
  "native_quote_v1": { "<optional existing binding>": "..." },
  "inquiry_case_link_v1": { "<optional existing link>": "..." },
  "confirmed": true
}
```

Update:

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "operation": "update",
  "id": "00000000-0000-4000-8000-000000000001",
  "expected_version": 2,
  "input": { "<validated edited input>": "..." },
  "template_version": 3,
  "preview_hash": "<server signature over the edited input>",
  "preview_expires_at": 1790000000000,
  "native_quote_v1": { "<unchanged binding when present>": "..." },
  "inquiry_case_link_v1": { "<unchanged link when present>": "..." },
  "confirmed": true
}
```

Update rules:

- `id`, `expected_version`, `preview_hash` and `preview_expires_at` are required.
- `operation` is required; unknown operations are rejected.
- A linked update must retain the existing `inquiry_case_link_v1` object. It cannot add, remove or replace the link.
- A native-bound update must retain the existing `native_quote_v1.request_hash` and release binding unless the user explicitly starts a new native prepare through the linked flow.
- The server validates `expected_version`, current state and preview signature in one transaction before updating the existing row.
- The server updates the existing row in place, increments its version and then reads it back. It does not create a second document row.

## 7. Review checkpoint

### 7.1 Purpose

Review must be explicit and version-bound. Opening the editor or saving a draft is not evidence that a human checked price, source, validity and terms.

`review` is a read-only action:

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "id": "00000000-0000-4000-8000-000000000001",
  "expected_version": 3
}
```

It returns a short-lived review object:

```json
{
  "schema_version": "quote-documents@2026-09-15.v3",
  "status": "success",
  "data": {
    "document_id": "00000000-0000-4000-8000-000000000001",
    "document_version": 3,
    "state": "draft",
    "totals": { "<calculated totals>": "..." },
    "warnings": [],
    "blockers": [],
    "requirements": {
      "case_current": true,
      "native_source_current": true,
      "validity_ok": true
    },
    "can_approve": true,
    "available_export_modes": ["draft"],
    "review_hash": "<server signature>",
    "review_expires_at": 1790000600000
  },
  "reason_codes": []
}
```

`review_hash` is signed over the server context plus:

- organization and actor;
- document id, document version and state;
- normalized document input and template snapshot;
- native quote binding and inquiry case link when present;
- calculated totals, warnings and blockers;
- current release/case checks;
- expiry.

The client receives a redacted, display-only review object. It must not be able to edit, recompute or extend the reviewed document while retaining the same `review_hash`.

### 7.2 Approval

`approve` in v3 adds `review_hash`:

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

The server must:

1. Re-read the document and verify `expected_version` and `state === "draft"`.
2. Verify the review signature, expiry, actor, organization and exact version.
3. Re-check the current native release, case supplement and document validity.
4. Reject stale review with `manual_review` and no state change.
5. Store `review_hash`, reviewed version and review timestamp with the approval evidence.
6. Increment the document version and store the approval on the current revision.

Any edit, case supplement, native release change or membership change that invalidates the reviewed inputs makes approval fail closed. Approval never reuses an earlier review after a new version.

## 8. Export checkpoint

V3 replaces state inference with an explicit export mode:

```json
{
  "contract_version": "quote-documents-workflow@2026-09-15.v1",
  "id": "00000000-0000-4000-8000-000000000001",
  "expected_version": 4,
  "mode": "draft"
}
```

| Mode | Allowed source state | Result |
| --- | --- | --- |
| `draft` | Current `draft` or `rejected` document | PDF with a prominent draft marker. |
| `formal` | Current `approved` document with current source, case and validity | Formal PDF; cache remains keyed by id and version. |
| `history` | Existing cached bytes only | Historical bytes, never renderer output. |

For v3:

- `expected_version` is required for all modes.
- `formal` requires an approved version whose stored approval references the exact current version.
- `history` never renders and returns `unavailable` if bytes are absent.
- A draft update increments the version, so an old review or export request cannot silently export the newer content.
- The downloadable PDF still contains no editable input or hidden fee metadata.
- PDF bytes, SHA-256, length and cache write-after-read checks remain unchanged.

## 9. UI workflow

The page becomes an explicit three-step workflow while remaining one console route:

1. `编辑`
   - Basic fields and compact fee rows.
   - A selected standard fee template can add empty, editable charge lines.
   - Draft save is available for both create and update.
   - Approved documents show `复制为新报价单`, not an editable form.
2. `核对`
   - Shows totals, warnings, blockers, current source/case state and a version label.
   - Requires an explicit user action to obtain a review object.
   - The approval form is displayed only after a current review object is available.
3. `导出`
   - Shows only modes allowed for the current version and state.
   - Draft and formal exports are visually distinct.
   - History is a read-only action that never claims to create a new formal quote.

The sidebar no longer mixes saved-document actions with unsaved preview totals. The editor remains usable after a successful draft save; the saved version is displayed next to the edit form.

## 10. Compact fee layout

This portion is a client contract and should not require a schema change.

Each fee is rendered as a compact row containing:

- fee name;
- quantity and unit;
- unit price and currency;
- a short group/display summary;
- a remove action.

The following fields move into an expandable detail area:

- description;
- note;
- group;
- display mode;
- merge display name.

Desktop uses a bounded responsive grid. Mobile uses one column, but the same row remains a single semantic unit. The implementation must preserve unique fee IDs, label-to-input associations and the existing 60-row limit. No horizontal scrolling is allowed at 390 px, and the review/export controls must not be pushed below an unreachable expanded row.

## 11. Status and reason mapping

V3 uses the existing five-state envelope. Proposed v3 reason codes:

| Situation | HTTP | Status | Data | Reason |
| --- | --- | --- | --- | --- |
| Unknown or mixed request version | 400 | `needs_input` | `null` | `document_contract_version_invalid` |
| Update without `id` or `expected_version` | 400 | `needs_input` | `null` | `document_update_input_invalid` |
| Update version changed before write | 409 | `blocked` | `null` | `version_conflict` |
| Update targets an approved document | 409 | `blocked` | `null` | `document_state_not_editable` |
| Review or preview expired | 200 | `manual_review` | `null` | `document_review_stale` |
| Review belongs to another actor or version | 403 | `blocked` | `null` | `document_review_forgery` |
| Approval without current review | 409 | `blocked` | `null` | `document_review_required` |
| Invalid export mode for state | 409 | `blocked` | `null` | `document_export_mode_invalid` |
| Formal export after approval but before current source/case recheck | 200 | `manual_review` | `null` | existing native/case reason |
| History bytes absent | 503 | `unavailable` | `null` | `inquiry_quote_history_bytes_missing` |

Existing v1/v2 reason codes remain unchanged for their clients. The implementation must not use string matching over arbitrary error text to select a v3 envelope.

## 12. Old/new JSON and migration

No database table or column change is required for the proposed behavior:

- Existing `quote_documents.payload` already stores document versions as JSON.
- Existing `document_audit` and `document_idempotency` can record update, review and export actions.
- The standard fee template can be stored as an optional v3 field inside the existing config JSON.
- Existing rows without the new fields are projected as existing v1/v2 records.
- The version field is a concurrency token, not a complete historical revision store. Stored PDFs remain available by their original id/version; restoring an older editable input is outside this RFC.

If implementation discovers that a new table is necessary, stop and extend this RFC before changing persistence. Do not implement an ad hoc migration under the name of a client-only layout change.

Migration behavior:

1. Existing approved and draft rows remain unchanged.
2. V3 `get` returns a v3 projection of old rows.
3. V1/v2 requests continue to receive their existing projections.
4. No PDF cache is regenerated during migration.
5. No historical document is edited to add a template reference.

Rollback:

- Stop accepting v3 requests and hide v3 UI.
- Keep v1/v2 readers active for all stored rows.
- Keep all document versions, audits, templates and PDF caches.
- Do not delete or rewrite customer data as rollback.

## 13. Counterexample acceptance matrix

| ID | Counterexample | Expected result |
| --- | --- | --- |
| QW-01 | Apply a standard template containing a stored unit price | Rejected by schema; only price-free items are accepted. |
| QW-02 | Change the standard template after saving a draft | Existing draft and its saved version do not change. |
| QW-03 | Two tabs update the same draft | One succeeds; the stale update gets `version_conflict` and no write. |
| QW-04 | Edit a rejected draft | Same id becomes a new `draft` version. |
| QW-05 | Edit an approved document | Blocked; the user must copy it. |
| QW-06 | Approve with an expired review | `manual_review`, no state change. |
| QW-07 | Approve after a customer supplement or release change | `manual_review`, no approval; a new review is required. |
| QW-08 | Export version 3 after the document has advanced to version 4 | No export of stale content. |
| QW-09 | Export linked history with no cached bytes | `unavailable`; renderer is not invoked. |
| QW-10 | Apply the standard template to a native-bound quote | Template action is unavailable in M1; native fee binding remains unchanged. |
| QW-11 | v1/v2 client reads a v3-created row | Version-specific projection remains valid; no v3 fields leak into old strict schemas. |
| QW-12 | Fee layout at 390 px | No horizontal overflow, no overlapping text and all controls remain reachable. |

## 14. Candidate implementation files

This is an ownership proposal, not an implementation authorization.

| File or area | Proposed change | Owner to confirm |
| --- | --- | --- |
| `services/quote-documents/contracts.ts` | Add v3 request/response schemas and fee-template schema; preserve v1/v2 | Shared contract/review owner |
| `services/quote-documents/service.ts` | Add update, review, explicit export and approval review binding | Document service owner |
| `services/access-gateway/portal/http.ts` | Version dispatch, route allowlist and v3 envelopes | Portal/platform owner |
| `deploy/scripts/generate-native-schemas.ts` | Generate v3 schemas only after baseline acceptance | Build/schema owner |
| `deploy/scripts/generate-portal-openapi.ts` | Add v3 request variants and `review` route | Integration/build owner |
| `deploy/cli/workspace.ts` | Add v3 commands and explicit export modes while preserving old commands | CLI owner |
| `apps/console/quote-documents.js` | Edit/review/export workflow and draft reopening | Console owner |
| `apps/console/quote-documents.css` | Compact fee row layout and responsive states | Console owner |
| `tests/quote-documents/service.test.ts` | Update concurrency, review, export and template counterexamples | Document service tests |
| `tests/access-gateway/portal-cases-http.test.ts` | Version dispatch, v1/v2 compatibility and v3 envelopes | Portal tests |
| `tests/e2e/portal-browser/quote-documents-flow.mjs` | Edit saved draft, review/export flow and 390 px checks | E2E owner |
| `docs/product/2026-09-08-native-quote-documents.md` | Update user-facing workflow after implementation | Product/docs owner |

## 15. K12 execution checklist after Mac acceptance

1. Freeze the v3 JSON examples and reason-code table in a baseline commit.
2. Add schema tests for v1/v2 preservation, v3 strictness, unknown versions and fee-template price rejection.
3. Add service tests for update concurrency, rejected-to-draft transition, review expiry/forgery, approval source checks and explicit export modes.
4. Implement service and HTTP dispatch behind v3 contract selection; do not change existing v1/v2 routes.
5. Add CLI v3 commands with input/output examples and preserve the old commands.
6. Implement compact fee rows and the edit/review/export console flow.
7. Run focused service, HTTP, CLI and browser tests.
8. Run `npm run typecheck`, `npm run lint`, `npm run validate:schemas`, `npm run build`, `npm run build:cli` and `git diff --check`.
9. Validate desktop and 390 px layouts with an actual browser and inspect generated draft/formal PDFs.
10. Commit as focused `feat|fix|test|docs: quote-workflow-v3 ...` changes, push the branch and create a review PR.

## 16. Acceptance gate

This RFC is ready for Mac review only as an interface/version proposal. It is not accepted until the reviewer confirms:

- the price-free standard fee template boundary;
- the v3 request and response versions;
- the update and review state transitions;
- the linked-quote exclusion for template application;
- the explicit export modes;
- and the exact candidate file ownership.

No production deployment, device operation, customer data use or external write is part of this RFC.
