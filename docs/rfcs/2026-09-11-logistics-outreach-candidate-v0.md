# RFC: Toronto logistics outreach candidate v0

- Status: **Proposed — not accepted; no production registration or permission expansion**
- Date: 2026-09-11
- Candidate module: `logistics-outreach`, `2026-09-11.v0`, risk `T2`
- Capability: `outreach.private_service@outreach-service@2026-09-11.v0`
- Scope: Toronto businesses potentially needing China–Canada freight; email first, no AI phone calls.

## Motivation and inspected baseline

The user requested implementation inside the existing FreightClaw repository, not a browser extension or another standalone sales website. Inspected baseline: `AGENTS.md`, module standard, README, envelope/tool/authority contracts, `module-runtime/types.ts`, `host.ts`, `capabilities.ts`, `platform/context.ts`, Freightcom module and new-service onboarding guide.

The current T0 and business profiles have exact reviewed tool sets. The Gateway does not own CRM records, mailboxes, browser automation or background queues. This change therefore adds a candidate module and a **source-owned private business service in the same repository**, without editing production registries, existing profiles, grants, schemas, application-key exchange, Portal, or deployment configuration. This RFC does not claim approval of a new public contract.

## Authority and architecture

```
MCP client -> existing Gateway authentication/audit -> candidate ModuleDefinition
          -> injected, narrow OutreachServicePort -> private outreach business service
                                              -> dedicated SQLite store (candidate)
                                              -> capture / approvals / model / mail ports
```

The private service owns lead evidence, drafts, idempotency records, inbox state and outbox jobs. It must not use the Gateway's database file or become an authority for rates, customs, orders or existing CRM records. A production private HTTP provider must be separately reviewed, isolated, authenticated and signed. In-process mounting is demonstrated only in synthetic tests; the production provider/release has not been implemented.

The module imports service types only; it neither instantiates SQLite nor runs a worker. The service's `dispatchOne(tenant)` is a private worker function, **not an MCP tool**. No module can supply an arbitrary URL, browser script, mailbox password, tenant or actor through a tool call.

## Implemented candidate behavior

- Research **already available, server-owned page snapshots** by opaque capture reference. Extract observed business email candidates, with source digest and time validation. No guessed addresses. China import status remains `unknown`; product category alone does not prove Chinese procurement or freight decision authority.
- Import only an observed candidate after tenant/actor-bound, expiring HMAC preview; normalized tenant-scoped deduplication.
- Prepare a template or injected-model draft using approved sender information. Identity and reply-based unsubscribe footer are appended deterministically. All drafts require exact-content human approval. Provider errors are not silently replaced with invented responses.
- Contact review, source evidence/digest, approval digest/expiry, different reviewer and unchanged sender are rechecked before queuing and before dispatch. The model cannot issue approvals or remove suppression.
- Dedicated SQLite WAL store, immediate write-readback check, transaction-bound audit/idempotency records and atomic queue claim. Draft-reference uniqueness prevents the same draft being sent again under a fresh operation key.
- Send disabled in supplied fixtures. A configured private worker can exercise the mail port; fixture acceptance is `simulated`, not delivery. Real-provider acceptance, if implemented later, is not proof of inbox delivery.
- Ambiguous sends and mismatched readbacks become `manual_review`, never automatic resends. Pre-send policy failures cancel the job.
- Bounded inbox batches, duplicate event suppression, conservative unsubscribe detection, automatic-message classification and pause/cancellation of cold follow-ups. Human-reply drafts use the same approval path.
- Tenant-scoped summaries and opaque content references; no raw address, HTML or message body in MCP results or audit records.

## Proposed tool permissions and effects

Every input has `schema_version=2026-08-11.v1`, `version=2026-09-11.v0`, a strict Zod object convertible to Draft 2020-12, and no unknown fields. No new top-level envelope states are introduced. Every handler requires a trusted, unexpired `ExecutionContext`, the named permission and the exact `tool:<name>` scope. Writes also require an authorized business role. Existing credentials acquire **no** new permission from this code.

| Tool | Permission | Effect |
| --- | --- | --- |
| outreach.research.preview | outreach:research | Read a configured capture, return candidate indices and preview |
| outreach.leads.list | outreach:read | Read bounded lead summaries |
| outreach.lead.import | outreach:lead_write | Persist one observed contact after preview |
| outreach.draft.preview | outreach:draft | Preview draft-generation intent |
| outreach.draft.prepare | outreach:draft | Persist a pending-review draft |
| outreach.draft.get | outreach:read | Read digest and protected content reference |
| outreach.message.preview | outreach:queue | Check contact and exact-content approval |
| outreach.message.queue | outreach:queue | Persist one private-service job; no immediate delivery |
| outreach.job.get | outreach:read | Read actual queue/attempt state |
| outreach.inbox.preview | outreach:inbox | Preview explicitly bound mailbox sync |
| outreach.inbox.sync | outreach:inbox | Save inbox events, pause/suppress and cancel follow-ups |
| outreach.inbox.list | outreach:inbox | Read message references/classification, no body |
| outreach.reply.preview | outreach:draft | Preview response generation |
| outreach.reply.prepare | outreach:draft | Save a pending-review reply |
| outreach.contact.preview | outreach:suppress | Preview monotonic suppression |
| outreach.contact.suppress | outreach:suppress | Suppress and cancel queued follow-ups |

Writes require `operation_mode=commit`, `idempotency_key` and `preview_ref`. Preview endpoints do not perform the subsequent source write. Candidate successful operations retain `manual_review`, `candidate_only=true` and `production_eligible=false`. Clients must inspect the returned object reference/state before retrying; `manual_review` does not mean that a local draft/job was not saved.

### Old/new examples and compatibility

Old catalogs: no outreach tools; unchanged by this PR.

Proposed research input:

```json
{"schema_version":"2026-08-11.v1","version":"2026-09-11.v0","capture_ref":"capture_fixture"}
```

Proposed import input (preview token must actually come from the preceding operation):

```json
{"schema_version":"2026-08-11.v1","version":"2026-09-11.v0","operation_mode":"commit","capture_ref":"capture_fixture","candidate_index":0,"preview_ref":"<server-issued-token>","idempotency_key":"lead_import_001"}
```

This is a candidate, additive code delivery; there is no migration of existing data and no change to existing scopes. The manifest follows current static ModuleDefinition syntax, not the future generic hot-plug artifact contract. Production naming, formal input/output schema publication, delegated scopes, readback evidence DTOs, signed provider descriptor and profile changes require acceptance and baseline work. The factory alone is not a public deployment.

## Mandatory production gates / known gaps

1. **Browser discovery not implemented:** no Google Maps API and no CDP connection is invoked. `capture` is an injected snapshot reader. A reviewed browser worker must produce immutable tenant-scoped captures, enforce permitted sources, redirect/DNS/egress and size/time limits, and stop at access restrictions. Reading public email is not an approval to contact it.
2. **Real providers not implemented:** SMTP/Gmail/Graph, OAuth/secrets rotation, authentic webhook/inbox cursor, bounce/complaint handling and model HTTP adapters still require implementation/verification. The supplied mailbox and contacts are synthetic `.invalid` fixtures only.
3. **Policy authority is not fixture approval:** production must provide current contact-basis evidence, exact-content human review, sender address and operational permission checks through trusted authority ports. This code does not certify CASL/PIPEDA compliance or automatically infer consent.
4. **No continuous worker or auto-reply deployment:** scheduling, mailbox serialization, rate/budget limits, Toronto send windows and managed worker lifecycle remain to implement. A response draft never autonomously sends. Per-call 15-second bounds do not guarantee a remote provider cancelled its operation.
5. **Crash ambiguity:** queued work survives restart. An attempt left in `dispatching` by a crash must be investigated/read back; it is deliberately not requeued. Durable lease-based reconciliation and provider idempotency contracts must be completed before live operation.
6. **Source retention and privacy:** define and enforce retention/deletion, database/backup permissions and encryption, key storage/rotation, review UI and protected content retrieval. Raw mail belongs only in the private service. Candidate HMAC keys must be persistent and secret in deployment, never random per production process.
7. **Classification is conservative:** the current unsubscribe matcher may flag quoted unsubscribe text. MIME-aware reply extraction, bounce/complaint normalization and authenticated sender/event binding are required for a real mailbox.
8. **Single candidate service:** SQLite and synchronous snapshot reads are for a single-host candidate. No PostgreSQL/multi-host store, production health/readiness, signed private provider, public REST or Portal integration is claimed.

## Validation and rollout

Actual local evidence: Node 22.16.0, shared service test cases executed with built-in `node:test`, 18 passed; strict core compilation passed with the locally installed TypeScript and Node type package. Module wrapper syntax transpilation passed. The local environment could not clone GitHub or install project dependencies; full repository build/typecheck/lint, actual ModuleHost tests and locked-version compatibility must be checked by the existing PR CI or a normal development checkout. Do not equate the local harness to the full Vitest suite.

Candidate checkout commands:

```sh
npm ci
npm test -- tests/outreach
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:agent-standards
npm run build:agent-pack
npm run build
git diff --check
```

Rollback: remove/revert only the candidate additions; existing profiles remain unchanged. Never delete service evidence, suppression records or ambiguous attempts to reset a send. Future activation must first stop new queue entries, drain/inspect attempts and preserve the private store and audit trail. Do not downgrade to a stale database copy after sending.
