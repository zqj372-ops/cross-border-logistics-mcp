# RFC: Inquiry to quote link v1

Status: Accepted for M1 isolated fixture design / baseline reviewer Mac 01 / user authorization 2026-09-13.

Reviewed body SHA-256: `3a25b400f289643958936f3a1bd920cf5b1052f3c7138da79f9fe232c2755610`. This reference is the exact reviewed body; later acceptance-header edits do not replace it.

Revision: R2/R3 review incorporated; 01 acceptance recorded 2026-09-13. This acceptance is design-contract acceptance only, not code, Schema, business acceptance or release approval.

Date: 2026-09-13

Candidate scope: link an existing inquiry case to an existing native quote document so staff can see the inquiry source and decide whether a customer supplement requires new pricing review.

## 1. Problem and current evidence

On the current `main` (`c9edc80261986e70183a7d9ff0cad3366bbee8db`):

- `services/access-gateway/portal/cases.ts` owns `business_cases`, case versions, customer replies, internal notes and idempotent case events.
- `services/quote-documents/service.ts` owns `quote_documents`, document versions, native quote bindings, approval, PDF cache and idempotent document writes.
- `services/quote-documents/contracts.ts` binds `native_quote_v1` to a native request hash, release id/digest and source refs, but has no inquiry case reference.
- `apps/console/cases.js` has no quote-creation action. `apps/console/quote-documents.js` has no inquiry source display. `deploy/cli/workspace.ts` has `cases *` and `documents *` commands but no bridge between them.

The existing two chains therefore work independently. This RFC defines the smallest possible linked path; it does not claim that the link is implemented.

## 2. Non-goals

- Do not create another case service, CRM, workflow engine, state machine, queue or document store.
- Do not make the quote document the authority for inquiry input, prices, approval or customer messages.
- Do not auto-interpret a customer message, internal note or case status as a pricing change.
- Do not automatically move a personal (`organization_id = null`) case into an organization.
- Do not give a platform operator the organization member or document-approval power it does not already have.
- Do not add a new permission scope, role, response status or product page for this link.
- Do not change old unlinked document semantics or delete any existing case/document/PDF evidence.

## 3. Change semantics: progress, supplement and confirmed price input

The current `CaseService.update` and `CaseService.reply` methods do not mutate `input_json`; they append events and increment `version`. A case version change by itself must never be used as a price-invalidation signal.

| Case change | Stored change | Quote effect | Reason |
| --- | --- | --- | --- |
| Ordinary progress or internal note via `update` | New event, status/version/updated_at may change | No invalidation and no new approval requirement | No customer pricing fact was added; staff-only progress must not invalidate a quote |
| Customer supplement via `reply` | New customer event, version increments | New formal save, approval or reissue is blocked as `manual_review` until staff creates a new linked preview that includes that event reference | A customer message may change a pricing fact, but the system must not guess whether it does |
| Staff confirms no pricing change | The new signed preview records the latest customer supplement reference but may reuse the same native request hash | New preview/save/approve may continue with the same priced request; old approval is not reused automatically | The review is explicit; ordinary notes remain non-blocking |
| Staff confirms a pricing change | New structured native request, new `native_quote_v1.request_hash`, new preview/save/approve | Previous preview and approval cannot be reused | The authoritative pricing input changed and must be bound to the new request |
| Case becomes `closed` or `cancelled` | Terminal status/version change | New prepare/save/approve/formal export is blocked; existing stored PDFs remain historical reads | Terminal cases must not create new formal commitments |

The link does not store a case version or a digest of `input_json`. Those were withdrawn from the earlier candidate because:

- `case.version` changes for progress and notes, producing false invalidation.
- `hash(input_json)` covers only the original immutable draft and misses customer reply events.
- A message hash would invite automatic interpretation of text and would not identify which event staff actually reviewed.

The RFC therefore proposes only two persisted link values, both derived with the server's trusted context:

1. `case_ref`: the existing authoritative case id.
2. `reviewed_customer_event_ref`: the server-validated latest customer supplement covered by the signed quote preview, or `null` when the case has no customer supplement.

The existing `native_quote_v1.request_hash` remains the binding to the structured pricing request. The existing signed `preview_hash` remains the binding of the document input, template version, expiry, native quote binding and the new link object. No additional version, input digest or actor field is needed in the link.

### 3.1 Deriving a real customer supplement from existing evidence

The existing `business_case_events` row has `event_id`, `version`, `status`, `message`, `visibility`, `actor_label`, `created_at` and trusted server-written `actor_id`. `actor_label` is display text and must never be used as an authorization or event-type authority.

The server orders events by `version` and then the existing row insertion order (the same sequence used by `CaseService.view`) and derives the latest customer supplement as follows:

1. Exclude the creation event: `version = 1` with status `submitted` is the initial demand record, not a supplement.
2. Exclude events whose `visibility` is not `customer`; internal notes are not customer input.
3. A customer supplement candidate must satisfy all of the following:
   - `version > 1`;
   - `visibility = customer`;
   - trusted `actor_id` equals the authoritative case `owner_id`;
   - event status is `in_review`;
   - the immediately preceding event has status `needs_input`.
4. The latest candidate by the server sequence is `latest_customer_supplement`. If no candidate exists, its value is `null`.

This rule deliberately does not use `actor_label` or message content. The current schema has no server-written event kind, and a case owner who is also an organization manager can produce an `update` event that has the same existing field shape as a customer `reply` event. In that ambiguous case the conservative result is a safe false positive: the event may be treated as a supplement candidate and require explicit staff confirmation. It must not be ignored as if it were ordinary progress.

No event type, column or migration is proposed for M1. If exact classification becomes operationally necessary, that requires separate evidence and a separate accepted contract; it is not silently added here.

### 3.2 Explicit expected event reference

Automatically taking the latest event during `prepare` is not evidence that staff reviewed it. The client must first read the existing case view/CLI output, show the staff member the current customer supplement reference, and submit an explicit `expected_customer_event_ref` (nullable) as an optimistic concurrency condition. It is not proof of authority and the server must not copy it into storage without validating it.

On `prepare`, the server:

1. Reads the authoritative case with trusted context.
2. Derives `latest_customer_supplement` using the rule in section 3.1.
3. Requires `expected_customer_event_ref` to equal that derived value, including `null = null` when there is no supplement. A mismatch, a forged reference, or a reference from another case returns `manual_review` and asks staff to refresh and review again.
4. Only after the match, signs a preview whose link contains the validated `reviewed_customer_event_ref`.

The client cannot cause the server to sign a newer event automatically. If a newer event arrives before the prepare request reaches the server, the expected reference is stale and prepare fails closed. If it arrives while the native quote call is awaiting, the after-await re-read must detect it and discard the candidate preview rather than signing the newer event.

No confirmation token, confirmation table or new service is introduced. `expected_customer_event_ref` is only a request field/optimistic condition; the existing preview signature binds the server-validated link.

## 4. Authorization and tenant boundary

M1 uses only the intersection of the existing permissions on the same active organization:

| Operation | Case side | Document side | Result |
| --- | --- | --- | --- |
| Prepare/save a linked draft | Active organization member who can manage the case (`CaseService.manages`) | Active organization member (`DocumentService.scope`) | Allowed only when the case belongs to that same organization |
| Approve a linked draft | Same case-management condition | Existing `DocumentService` owner/admin check | Allowed only when both checks pass |
| Read a linked document | Current case owner/manager access for the same organization | Existing document owner/manager visibility | If either side fails, do not expose link metadata; fail closed |
| Personal case (`organization_id = null`) | Existing personal case access only | DocumentService requires an active organization | No linked document in M1; no automatic organization assignment |
| Platform operator | May manage the case in its current scope | DocumentService rejects `platformRole` and requires membership | No quote power is inherited from platform administration |
| Cross-organization or inactive membership | Reject | Reject | Never fall back to another organization or to the platform role |

The server must read the authoritative case using trusted server context. A client-provided `case_ref` chooses a candidate; it is not proof of ownership, organization, case status or event reference. The server must not trust client-provided `case_version`, `organization_id`, authoritative `reviewed_customer_event_ref` or pricing hashes. The client-provided `expected_customer_event_ref` is only an optimistic condition and must be checked against the authoritative derivation.

### 4.1 Case status gate

`closed` and `cancelled` are terminal case states and must not be confused with ordinary progress or internal notes:

| Operation | `submitted` / `in_review` / `needs_input` | `closed` / `cancelled` |
| --- | --- | --- |
| New linked `prepare` | Allowed subject to permission and expected-event match | `blocked`; no new preview |
| Linked `save` of an existing preview | Allowed while the preview, case event and source are current | `blocked`; no document write |
| Linked `approve` | Allowed while the draft, event and source are current | `blocked`; no approval |
| Linked `reject` (corrective) | Allowed under current document-manager authorization | Allowed under current document-manager authorization; no source/supplement/validity gate |
| Formal export or reissue | Allowed only for a current approved document, event and source | `blocked`; no new formal PDF |
| Historical read of an already stored PDF | Allowed subject to document/case visibility | Allowed subject to document/case visibility; bytes are not re-rendered |

Progress or note updates inside the open statuses do not by themselves invalidate a quote. A terminal transition is a separate explicit gate and must fail with `blocked`, not be described as ordinary progress.

## 5. Association contract

### 5.1 Versioning

The existing `quote-documents@2026-09-08.v1` requests and stored documents remain unchanged. The linked path uses an explicit additive contract:

- Request contract version: `inquiry-quote-link@2026-09-13.v1`.
- Linked response schema: `quote-documents@2026-09-13.v2`.
- Every linked `native-prepare`, `save`, `list`, `get`, `approve`, `reject` or `export` request carries the explicit contract version on the existing route. v1 requests omit it and remain on the unchanged v1 path; v1 `reject` of a linked record is blocked before any write.
- Old v1 clients that do not send the version remain on the v1 path and create unlinked documents.
- New server versions may accept both v1 and v2. Old servers reject unknown v2 fields; this is expected and must be handled by client/version gating rather than silent field acceptance.
- No existing strict schema is extended in place. The existing v1 JSON Schema/Zod contract is not silently changed.

### 5.2 New JSON shape

Old v1 unlinked save request remains exactly the existing shape and has no link object:

```json
{
  "input": { "<existing quote document input>": "..." },
  "template_version": 2,
  "preview_hash": "<existing v1 preview signature>",
  "preview_expires_at": 1789239600000,
  "native_quote_v1": { "<existing native quote binding>": "..." },
  "confirmed": true
}
```

New linked prepare request (conceptual, exact schema requires baseline review):

```json
{
  "contract_version": "inquiry-quote-link@2026-09-13.v1",
  "case_ref": "<authoritative case id>",
  "expected_customer_event_ref": null,
  "request": { "<existing zoneInputSchema>": "..." },
  "customer": {
    "quote_no": "Q-2026-001",
    "customer_name": "Synthetic Shipper Ltd.",
    "quote_date": "2026-09-13",
    "valid_until": "2026-10-13",
    "job_no": "",
    "so_no": "",
    "container_no": "",
    "remark": "Synthetic local fixture"
  }
}
```

Server-issued linked prepare response:

The linked response uses the existing `{schema_version,status,data,reason_codes}` envelope. Additional complete old/new envelopes are shown in section 6.5.

```json
{
  "schema_version": "quote-documents@2026-09-13.v2",
  "status": "success",
  "data": {
    "input": { "<existing quote document input>": "..." },
    "template_version": 2,
    "preview_expires_at": 1789239600000,
    "preview_hash": "<server signature over the complete preview>",
    "native_quote_v1": {
      "request": { "<same structured request>": "..." },
      "preview": { "<existing quote preview>": "..." },
      "source_refs": [{ "<existing source ref>": "..." }],
      "release_id": "native-release-2026-09-13",
      "release_digest": "<64 hex characters>",
      "request_hash": "<64 hex characters>"
    },
    "inquiry_case_link_v1": {
      "case_ref": "<same authoritative case id>",
      "reviewed_customer_event_ref": null
    }
  },
  "reason_codes": []
}
```

`expected_customer_event_ref` is a nullable optimistic-concurrency condition supplied after staff read the case. The response's `reviewed_customer_event_ref` is the server-validated value; it is not a client assertion.

New linked save request echoes the server-issued link after signing:

```json
{
  "contract_version": "inquiry-quote-link@2026-09-13.v1",
  "input": { "<signed quote document input>": "..." },
  "template_version": 2,
  "preview_hash": "<server signature from prepare>",
  "preview_expires_at": 1789239600000,
  "native_quote_v1": { "<signed native quote binding>": "..." },
  "inquiry_case_link_v1": {
    "case_ref": "<authoritative case id>",
    "reviewed_customer_event_ref": "<server-issued reviewed customer event id or null>"
  },
  "confirmed": true
}
```

The link is all-or-nothing: if `inquiry_case_link_v1` is present, `contract_version`, `preview_hash`, `case_ref` and the server-issued link must all be present and valid. A linked document cannot be saved, approved or exported through a path that removes or replaces the link. An unlinked document has no link object and keeps the v1 behavior.

### 5.3 Required server checks

Before signing a linked preview, the server must:

1. Resolve the active organization scope and require the same organization on the authoritative case.
2. Require the existing case-management permission and the existing document member permission.
3. Read the authoritative case and derive the latest customer supplement using the section 3.1 rule. The client may select `case_ref` and submit `expected_customer_event_ref` only as an optimistic condition; it may not assert the authoritative event, case version, organization or hash.
4. Reject closed or cancelled cases for new linked quotes unless a later accepted contract explicitly allows them.
5. Require `expected_customer_event_ref` to equal the derived latest supplement, including `null = null`, and return `manual_review` without signing on mismatch.
6. Re-read the case, derived supplement, permission and native release after the quote engine await; if any value changed, discard the candidate preview rather than signing the newer event.
7. Bind the complete preview into `preview_hash`, including the existing document input, template version, expiry, native quote binding and link object.

### 5.4 Read-only review context for staff

The existing `CaseService.view` does not expose `actor_id` and does not currently return the server-derived customer supplement reference. Web and CLI must not infer it from `actor_label`, `visibility` or message text. Use one read-only authoritative accessor for both entry points:

- Route: the existing `GET /console/api/v1/cases/{case_id}`.
- Explicit version query: `?contract_version=inquiry-quote-link@2026-09-13.v1`; v1 clients omit it and receive the unchanged `portal-cases@2026-09-07.v1` DTO.
- v2 read response: `portal-cases@2026-09-13.v2` with the existing case fields/events plus one additive field. The following is a field excerpt, not a complete v1 case DTO:

```json
{
  "schema_version": "portal-cases@2026-09-13.v2",
  "status": "success",
  "data": {
    "case_id": "00000000-0000-4000-8000-000000000003",
    "version": 2,
    "review_context": {
      "latest_customer_supplement_ref": null
    }
  },
  "reason_codes": []
}
```

`review_context.latest_customer_supplement_ref` is nullable and is derived by the same server accessor as section 3.1. The existing `events` array remains the display source for event content; it continues to omit `actor_id`. No case version, hash, actor id, token or new table is added.

CLI uses the existing command path, for example:

```sh
freightclaw workspace cases get --id <case_id> --input '{"contract_version":"inquiry-quote-link@2026-09-13.v1"}'
```

The Web UI performs the same GET with the version query. After the staff member reads the returned events and explicitly chooses the linked quote action, the client sends `expected_customer_event_ref`; scheduled or background prepare must not be treated as human confirmation.

The HTTP handler must accept only the exact `contract_version=inquiry-quote-link@2026-09-13.v1` query on the single-case read route and continue rejecting duplicate or unknown query parameters. v1 requests remain byte-for-byte compatible with the existing DTO.

## 6. Prepare, save, approve and PDF checkpoints

### 6.1 Prepare

`prepare` is read-only with respect to business records. It resolves the authoritative case, requires the client's `expected_customer_event_ref` to match the derived latest supplement, calls the existing quote engine, and after the await re-reads the case, supplement, permission and native release. Only if all values are unchanged does it return a signed preview. Repeated prepares may produce new expiry/signature values but must not write a case, document, event or quote record.

### 6.2 Save

The existing document idempotency transaction remains in use. Save must:

1. Verify the v2 contract version, preview signature and expiry.
2. Re-read the authoritative case and require the same organization, case permission and derived customer supplement reference as signed.
3. Re-check the existing native quote release, request hash, validity and source refs.
4. Write the document only when all checks pass. If the case has a newer customer event, return `manual_review` with an inquiry-review reason and do not write a partial or unlinked document.
5. Store the link only inside the existing `quote_documents.payload`; no new table, column, service or workflow state is required.

Idempotency semantics:

- Before returning any committed replay, re-check current organization, document visibility and authoritative case visibility. A revoked member or case permission returns `blocked` with `data:null` and the same invisible-document reason used by the normal access path; it must not return or reveal the committed document.
- The same key with different input, case link or preview hash returns the existing conflict behavior.
- After authorization and input consistency, compare the committed identity with the current document version/state, `valid(row)`, terminal-case status, native source and derived customer supplement. Only an exact current match returns the original committed envelope; any mismatch uses the fixed non-current outcomes in section 6.5.
- A committed replay never performs a second write and never reports a historical committed version as the current formal document. A newer customer supplement or native source change returns `manual_review` with the committed document reference/version metadata, `replay:true`, `committed:true`, `valid_now:false` and `historical:true`.
- A new supplement requires a new prepare, a new signed preview and a new idempotency key.

### 6.3 Approve

Approve must re-read the authoritative case and derived latest customer supplement. A supplement newer than `reviewed_customer_event_ref` blocks approval as `manual_review`; ordinary progress/internal events do not. Closed or cancelled cases are `blocked`. The existing native release/request checks and document version check remain. Approval never reuses an earlier approval after a new customer supplement or a new pricing request. Replay follows section 6.5.

### 6.4 Cached PDF and asynchronous render

The existing PDF cache key remains document id plus document version. The linked path adds these checks:

1. Before an asynchronous render, capture the document version, link binding, organization and permission context.
2. After the render await, re-read the current document, authoritative case, derived customer supplement, native release and membership, then discard the rendered bytes if any value changed. Permission, organization or terminal-case changes return `blocked` with `data:null`; customer-supplement, native-source or document-version changes return `manual_review` with no new cache entry.
3. After inserting or reading a cached PDF, verify PDF magic bytes and SHA-256 as today. A document id/version may have only one cached PDF hash; concurrent renderers must converge on the stored bytes or fail closed, and a repeat export must return that same hash rather than silently replacing it.

History and reissue are separate outcomes:

- An already generated PDF may be read as historical evidence with `historical: true` and `valid_now: false` when it is no longer current. This read must still enforce document visibility and the linked case organization/permission boundary.
- Historical read reuses an explicit export history mode and returns only already stored bytes. It never invokes the renderer. If no cached bytes exist, return `unavailable`, `data:null`, reason `inquiry_quote_history_bytes_missing`.
- A new formal PDF or reissue requires a current approved document, current native release and no unreviewed customer event. It must go through the existing prepare/save/approve flow rather than mutating the old document.
- If the current export path cannot return an expired existing PDF as history without generating a new formal document, that is a FLOW-02 gap, not a reason to weaken the validity checks.

### 6.5 Replay, version selection and envelopes

Replay must use this fixed priority: current authorization, then idempotency input consistency, then committed identity versus the current document version/state/terminal status/source/customer event/validity. The committed identity never changes and replay never writes again. The following outcomes are fixed:

| Replay situation | HTTP | Envelope status | Data | Reason |
| --- | --- | --- | --- | --- |
| Membership, organization or case visibility revoked | 404 | `blocked` | `null` | Existing invisible-document reason `document_not_found`; no document metadata |
| Different input/link for the same key | 409 | `blocked` | `null` | `idempotency_conflict` |
| Committed document version/state changed (for example save v1 → approve/reject v2) | 200 | `manual_review` | Same committed id/version plus `current_version`, `current_state`, `replay:true`, `committed:true`, `current:false`, `historical:true` | `inquiry_quote_replay_not_current` |
| Same committed version/state but current `valid(row)` is false | 200 | `manual_review` | Same committed id/version plus `replay:true`, `committed:true`, `valid_now:false`, `historical:true` | `inquiry_quote_replay_expired` |
| Same committed version/state but newer customer supplement or native source change | 200 | `manual_review` | Same committed id/version plus `replay:true`, `committed:true`, `valid_now:false`, `historical:true` | `inquiry_quote_replay_stale` |
| Case became terminal for save/approve replay | 409 | `blocked` | `null` | `inquiry_quote_case_closed` |
| Exact replay of a current draft/approval/rejection with no change | 200 | Original committed status | Original committed object | Original reason codes |

`reject` replay is an explicit corrective exception: after current document-manager authorization and idempotency consistency, it may return the original committed rejection even if the case is terminal, the native source changed or a customer supplement arrived. It still performs no second write and returns its original rejection envelope; if the document version/state is no longer the committed rejection, it follows the non-current replay row.

The same-route version selection exhaustively covers the existing document actions:

| Action | Type | v1 request | v2 linked request |
| --- | --- | --- | --- |
| `config`, `config-save` | template read/write | Unchanged; no document-record link access | Not a linked-document action; unchanged |
| `preview` | manual document preview/read | Unchanged; no link | Unchanged; linked path uses `native-prepare` |
| `native-prepare` | read/preview | Existing unlinked native prepare | Linked prepare with `case_ref` and `expected_customer_event_ref` |
| `save` | write | Create only an unlinked v1 document | Linked save with signed link and replay rules |
| `list` | read | Filter out linked records; return v1 unlinked items only | Return v1 unlinked and v2 linked items |
| `get` | read | Linked record: `blocked`, `data:null`, `document_contract_version_required` | v2 envelope; unlinked record data retains v1 business semantics; linked data includes `inquiry_case_link_v1` |
| `approve` | write | Linked record: `blocked` before any write | v2 envelope; unlinked record data retains v1 approval semantics; linked approval checks apply to the linked branch |
| `reject` | write | Linked record: `blocked` before any write | v2 envelope; unlinked record data retains v1 reject semantics; linked rejection uses current document-manager authorization with no supplement/source/validity gate |
| `export` | read/render/cache | Linked record: `blocked` before render or cache write | v2 envelope; unlinked record data retains v1 export semantics; linked formal/history branches apply to the linked branch |

For every write action (`save`, `approve`, `reject`), the HTTP handler and service must resolve the stored record's contract version and link state before invoking any mutation. A v1 request must not reach the v1 mutation function for a linked record and fail only later during response parsing.

Explicit v2 requests always return the v2 envelope. Existing unlinked records retain their v1 business-data semantics inside that v2 envelope; linked records must use the linked branch and cannot be downgraded or stripped. V1 requests and v1 response contracts remain unchanged. The HTTP handler must select the schema version from the explicit request/record version rather than always returning the existing fixed `DOCUMENT_VERSION`.

Complete synthetic old/new list envelopes (the v2 example is a proposed shape, not current):

```json
{
  "schema_version": "quote-documents@2026-09-08.v1",
  "status": "success",
  "data": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000001",
        "version": 1,
        "state": "draft",
        "created_at": "2026-09-13T00:00:00.000Z",
        "quote_no": "Q-2026-001",
        "customer_name": "Synthetic Shipper Ltd."
      }
    ],
    "next_cursor": null
  },
  "reason_codes": []
}
```

```json
{
  "schema_version": "quote-documents@2026-09-13.v2",
  "status": "success",
  "data": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000001",
        "version": 1,
        "state": "draft",
        "created_at": "2026-09-13T00:00:00.000Z",
        "quote_no": "Q-2026-001",
        "customer_name": "Synthetic Shipper Ltd."
      },
      {
        "id": "00000000-0000-4000-8000-000000000002",
        "version": 1,
        "state": "draft",
        "created_at": "2026-09-13T00:01:00.000Z",
        "quote_no": "Q-2026-002",
        "customer_name": "Synthetic Linked Shipper Ltd.",
        "inquiry_case_link_v1": {
          "case_ref": "00000000-0000-4000-8000-000000000003",
          "reviewed_customer_event_ref": null
        }
      }
    ],
    "next_cursor": null
  },
  "reason_codes": []
}
```

```json
{
  "schema_version": "quote-documents@2026-09-13.v2",
  "status": "manual_review",
  "data": {
    "id": "00000000-0000-4000-8000-000000000002",
    "version": 1,
    "committed": true,
    "replay": true,
    "valid_now": false,
    "historical": true
  },
  "reason_codes": ["inquiry_quote_replay_stale"]
}
```

## 7. Reason codes and status mapping

No new top-level envelope status is introduced. The linked path must return business outcomes explicitly, not rely on the generic `PortalError` status conversion. This mapping is fixed for the proposed contract; 01 baseline may reject the contract, but it must not silently reinterpret these statuses:

| Situation | HTTP | Envelope status | Data | Reason |
| --- | --- | --- | --- | --- |
| Missing/malformed `case_ref` or v2 link fields | 400 | `needs_input` | `null` | `inquiry_quote_link_input_invalid` |
| Case not found, different organization, inactive membership or insufficient case permission | 404 | `blocked` | `null` | `document_not_found`; do not distinguish unauthorized existence |
| Personal or platform-only context cannot enter the document path | 403 | `blocked` | `null` | `inquiry_quote_document_scope_required` |
| Expected event does not equal the derived latest supplement | 200 | `manual_review` | `null` | `inquiry_quote_case_review_required` |
| Preview expired but signature/link is intact | 200 | `manual_review` | `null` | `document_preview_stale` |
| Link/signature is forged or stripped | 403 | `blocked` | `null` | `inquiry_quote_link_forgery` |
| Native release or request hash changed before a write | 200 | `manual_review` | `null` | `native_quote_source_changed` |
| Linked record accessed through v1 get/approve/reject/export | 409 | `blocked` | `null` | `document_contract_version_required`; `reject` is blocked before any write |
| Terminal case blocks new prepare/save/approve/formal export | 409 | `blocked` | `null` | `inquiry_quote_case_closed` |
| Native release has expired before a write | 200 | `manual_review` | `null` | `native_quote_release_expired` |
| New formal export requested after `valid(row)` becomes false and no history mode is requested | 200 | `manual_review` | `null` | `inquiry_quote_export_expired` |
| Committed replay after a new supplement/source change | 200 | `manual_review` | Same committed id/version plus replay/historical metadata | `inquiry_quote_replay_stale` |
| Committed replay after version/state change | 200 | `manual_review` | Same committed id/version plus `current_version`, `current_state`, replay/historical metadata | `inquiry_quote_replay_not_current` |
| Committed replay after `valid(row)` becomes false | 200 | `manual_review` | Same committed id/version plus replay/historical metadata | `inquiry_quote_replay_expired` |
| Revoked permission during replay | 404 | `blocked` | `null` | `document_not_found` |
| Existing PDF read as historical evidence | 200 | `success` | Existing cached bytes metadata plus `historical:true`, `valid_now:false` | `inquiry_quote_history_only` |
| Historical read requested but cached bytes are absent | 503 | `unavailable` | `null` | `inquiry_quote_history_bytes_missing` |

`manual_review` outcomes are service outcomes and are returned with HTTP 200. `blocked` outcomes carry `data:null` and a non-disclosing reason. A v2 `reject` of a stale linked draft is allowed under current document-manager authorization and returns the normal rejection result; it is not subject to supplement/source/validity gates.

### 7.1 C5 勘误与确定映射（2026-09-13，01 放行）

两条最小勘误只增加 reason，不改字段、不改 v1、不新增版本；生成器仅重出 `approve-v2-response.schema.json` 与 `export-v2-response.schema.json`：

- `approve` 的 `manual_review` 允许集末尾新增 `document_expired`：文档窗口过期时返回 HTTP 200 `manual_review`、`data:null`。
- `export` 的 `manual_review` 允许集末尾新增 `version_conflict`：render 之后发现版本变化必须丢弃 bytes 且零 cache 写入，返回 HTTP 200 `manual_review`、`data:null`。

其余确定映射为局部精确映射，不依赖全局子串推断；错误响应同样用本文档既有的 `linkedErrorEnvelopeSchema` 校验，不新增第二套错误结构：

| 情形 | HTTP | 状态 | Data | Reason |
| --- | --- | --- | --- | --- |
| `document_rejected` / `document_not_approved` | 409 | `blocked` | null | 同名 |
| approve/reject 新请求的 `version_conflict` | 409 | `blocked` | null | `version_conflict` |
| `cases_unavailable` / `inquiry_case_unavailable` / `document_service_unavailable` / `document_renderer_unavailable` / `document_pdf_invalid` | 503 | `unavailable` | null | 同名 |
| 无法归类的服务异常 | 503 | `unavailable` | null | `document_service_unavailable`（脱敏） |
| case 权限不可见 | 404 | `blocked` | null | `document_not_found` |

- HR-1：单条 case 读取的请求版本是 `?contract_version=inquiry-quote-link@2026-09-13.v1`（与 document 链接同一合同常量）；`portal-cases@2026-09-13.v2` 只是响应 `schema_version`，作为请求值必须拒绝；重复或未知取值同样拒绝。
- HR-2：v2 请求读到的 unlinked 记录保留 v1 业务语义，成功返回 `successV2(signedExportViewSchema)` 或对应 unlinked 视图且 `reason_codes: []`；`inquiry_quote_history_only` 只用于实际返回 linked 历史视图的结果，不由请求 `mode` 推断。
- HR-3：`documentService` 依赖缺失时，能识别为 v2 的请求返回 v2 `unavailable`/null；v1 请求保持既有 `portal@2026-09-05.v1` 包络；认证/CSRF/host 前置与无法解析 body 时的既有语义不变。
- HR-4：linked `native-prepare` 在进入任何 case 读、引擎调用或写入之前校验 `customer.valid_until >= customer.quote_date`，违反时返回 400 `needs_input`/null `inquiry_quote_link_input_invalid`；该跨字段规则只覆盖已明确的文档窗口，不把其它 ZodError 一概转 400（输出或内部依赖坏数据仍为 unavailable），v1 路径与字段不变。
- linked 列表只过滤明确的 `document_not_found`，不把依赖故障吞成空成功；短页 + 非空 cursor 属允许行为，不引入补满页抽象。

## 8. Old/new JSON, compatibility and rollback

- Old v1 prepare/save requests and old unlinked documents are unchanged.
- New linked requests require `contract_version: inquiry-quote-link@2026-09-13.v1` plus a link object returned by the server. Unknown fields remain rejected by the old strict schema.
- New linked document responses use `quote-documents@2026-09-13.v2`; v1 responses remain v1.
- No database migration is required because the link is stored inside the existing JSON payload and no new table or column is proposed.
- A linked document must not be downgraded to an unlinked v1 document. Removing the link does not bypass review.
- v1 `reject` of a linked document is rejected before any write. v2 `reject` remains the legal corrective action for a stale or otherwise blocked draft under current document-manager authorization.
- Historical read is bytes-only; missing bytes return `unavailable`/`inquiry_quote_history_bytes_missing` and never trigger rendering.
- Rollback is feature-disable, not data deletion: stop accepting new linked prepares/saves, stop exposing the link action, keep linked documents and PDFs, and retain a reader compatible with the v2 payload. A binary rollback that cannot parse v2 payloads is not a valid rollback.

## 9. Counterexample acceptance matrix

| ID | Counterexample | Expected result |
| --- | --- | --- |
| IQL-01 | Staff updates status within `submitted`/`in_review`/`needs_input` or writes an internal note after approval | Quote remains valid; no new review and no invalidation |
| IQL-02 | Customer sends a supplement after the signed preview | Save/approve/reissue returns `manual_review`; a historical PDF may still be read as history; no automatic text interpretation |
| IQL-03 | Staff reviews the supplement and confirms the same pricing input | New signed preview binds the latest customer supplement ref; old approval is not reused; the request hash may remain the same |
| IQL-04 | Staff confirms a changed pricing input | New request hash, preview, save and approval are required; old version cannot be approved again |
| IQL-05 | Client supplies a forged case id, organization, authoritative event ref, case version, hash or `actor_label` | Server ignores non-authoritative values and checks the expected ref against its own derivation; no cross-organization lookup occurs |
| IQL-06 | Personal case, platform-operator context or cross-organization case | Link is blocked; no automatic organization assignment or platform-power inheritance |
| IQL-07 | Client strips or replaces the link on a linked document | Preview/signature or all-or-nothing validation fails; no unlinked downgrade |
| IQL-08 | Permission or organization membership changes while PDF rendering is pending | Post-await re-read discards the PDF and returns `blocked`, `data:null` |
| IQL-08b | Customer supplement or native source changes while PDF rendering is pending | Post-await re-read discards the PDF and returns `manual_review`; no cache write |
| IQL-09 | Duplicate save with the same idempotency key and no newer event | Same committed document is returned; no duplicate document or side effect |
| IQL-10 | Old v1 client saves an unlinked document | Existing v1 behavior and old schema remain unchanged |
| IQL-11 | Case is `closed` or `cancelled` | New prepare/save/approve/formal PDF is `blocked`; an already stored PDF may still be read as history |
| IQL-12 | Staff saw E1, E2 arrives before the prepare request | `expected_customer_event_ref=E1` does not match latest E2; `manual_review`, no signature, staff must refresh and review |
| IQL-13 | E2 arrives while the native quote call is awaiting | After-await re-read detects E2; candidate preview is discarded, not signed as if E2 was reviewed |
| IQL-14 | Replay after membership or case permission is revoked | `blocked`, `data:null`, no committed document metadata or existence leak |
| IQL-15 | Replay after a newer supplement or source change | Same committed object is referenced without a second write, but the envelope is `manual_review` with `valid_now:false`/`historical:true` |
| IQL-16 | Replay an approval after `valid(row)` becomes false | `manual_review`, same committed id/version, `inquiry_quote_replay_expired`; never reported as current formal quote |
| IQL-17 | Replay a save after the document has been approved or rejected | `manual_review`, same committed id/version plus current version/state, `inquiry_quote_replay_not_current`; no second write |
| IQL-18 | v1 client sends `reject` for a linked document | `blocked` before any write, `data:null`, `document_contract_version_required`; no history or response parse bypass |
| IQL-19 | v2 `reject` on a linked stale draft after a customer supplement or source change | Allowed under current document-manager authorization and idempotency; returns the normal rejection result, without requiring current price validity |
| IQL-20 | Web/CLI tries to infer the review event from `actor_label` or message text | Rejected by design; both use the server-derived `review_context.latest_customer_supplement_ref` and explicit staff confirmation |

## 10. Minimal candidate files and ownership proposal

This list is a proposal for a later implementation. It does not grant write permission now and deliberately does not claim the whole `apps/inquiry/**` or `services/quote-native/**` trees.

| Candidate file or exact injection point | Change | Proposed owner to verify |
| --- | --- | --- |
| `services/quote-documents/contracts.ts` | Add explicit v2/link contract and versioned response schemas; preserve v1 | Shared contract must be reviewed by 01 baseline; service implementation owner still unassigned |
| `services/quote-documents/service.ts` | Prepare/save/approve/reject/export checkpoints, expected-event validation, replay and PDF rules; link stays inside existing payload | Business document owner, currently unassigned |
| `services/access-gateway/portal/cases.ts` | Read-only authoritative case/event accessor, derived supplement logic and v2 `review_context`; no case mutation route | Platform/Portal owner; task 07 scope needs clarification |
| `services/access-gateway/portal/http.ts` | Existing same-route version selection for case read and `native-prepare`, `save`, `list`, `get`, `approve`, `reject`, `export`; linked envelopes | Platform/Portal owner |
| `services/access-gateway/portal/server.ts` | Pass the case accessor/version-aware document service through the existing options | Platform/Portal owner |
| `services/access-gateway/portal/production.ts` | Production composition currently constructs `DocumentService` and `CaseService` separately at line 81; wire the read-only accessor here | Platform/Portal owner |
| `deploy/scripts/start-portal-fixture.ts` | Local fixture composition currently constructs both services separately at line 48; wire the same accessor here | 06 integration owner, verify task ownership |
| `deploy/scripts/generate-native-schemas.ts` | Regenerate `schemas/admin-control/quote-documents/*.schema.json` only after v2 contract approval | 01 baseline plus 06 build owner |
| `deploy/scripts/generate-portal-openapi.ts` | Emit the versioned linked request/response OpenAPI entries; do not hand-edit `apps/console/openapi.json` | 06 integration owner |
| `apps/console/cases.js` | Existing-personnel action showing `expected_customer_event_ref` and review-pending state | Console owner, currently unassigned |
| `apps/console/quote-documents.js` | Linked record/version display and v1/v2 handling | Console owner, currently unassigned |
| `deploy/cli/workspace.ts` | Existing `cases get` passes `contract_version` as a GET query and accepts the v2 review context; document commands accept the v2 union. No new command is proposed | CLI/06 integration owner to confirm |
| `schemas/access-gateway/portal-cases-response.schema.json` | Add the versioned v2 case-read response with `review_context`; preserve the v1 schema | 07/task owner plus 01 review if treated as shared contract |
| `schemas/admin-control/quote-documents/*.schema.json` | Generated reviewed schemas; shared JSON Schema and Zod contract both require 01 baseline approval | 01 baseline |
| existing `tests/quote-documents/service.test.ts`, `tests/access-gateway/portal-cases.test.ts`, `tests/access-gateway/portal-quote-review-documents.test.ts`, `tests/access-gateway/portal-workspace-cli.test.ts` | Add linked-path, replay, version and PDF counterexamples; no new test framework/entity | Relevant test owners |

Read-only reuse is expected for `apps/inquiry/model.ts`, `services/quote-native/contracts.ts`, `services/quote-native/client.ts` and the existing quote engine. `services/access-gateway/portal/fixture.ts` is not the fixture composition point for these services; `deploy/scripts/start-portal-fixture.ts` is. No new mapping module, table, service, scope or workflow state is proposed.

## 11. Validation and rollout

When approved, the narrow regression set should include:

```sh
npx vitest run tests/quote-documents/service.test.ts tests/access-gateway/portal-cases.test.ts
npm run typecheck
npm run lint
npm run validate:schemas
npm run build
git diff --check
```

The implementation should use the existing single-instance SQLite plus synthetic fixtures for isolation. Shared PostgreSQL remains a separate storage decision and is not changed by this RFC. No production call, real customer message, real price or external provider is used in validation.

Replay tests must explicitly cover an expired approval, a save followed by approve or reject, and a replay after permission revocation. Linked-path tests must also cover v1 reject blocked before write, v2 reject of a stale draft, server-derived review context for both Web and CLI, and history read with and without cached bytes.

Rollout gates are: accepted contract/schema review; ownership assignment for the exact candidate files; v1 regression; linked-path counterexamples; historical-read/reissue distinction; and a rollback plan that preserves linked payloads.

## 12. Decisions required before implementation

Resolved constraints for this RFC: M1 linked-path validation uses the existing single-instance SQLite with synthetic fixtures; this is not a production storage choice and does not reopen shared PostgreSQL. OCR remains inventory-only and is not an M1 prerequisite.

1. Assign ownership for the exact candidate file and injection-point rows in section 10. Do not grant whole-directory ownership for `apps/inquiry/**`, `services/quote-native/**`, `apps/console/**` or `services/quote-documents/**` by implication.
2. Accept or reject the explicit v2 contract and the single `inquiry_case_link_v1` object with only `case_ref` and `reviewed_customer_event_ref`.
3. Confirm the historical-read versus reissue behavior for existing PDFs, including whether the current export path already satisfies it.

The design contract is accepted for the M1 isolated fixture scope as recorded in the roadmap 01 decision. Source and shared-contract implementation remain gated on the 01-maintained versioned candidates and per-file ownership release; no implementation candidate is itself an accepted Schema or behavior change.
