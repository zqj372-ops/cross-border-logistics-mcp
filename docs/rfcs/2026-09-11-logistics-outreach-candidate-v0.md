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
- HTTP provider adapters cover opaque capture snapshots, an OpenAI-compatible model endpoint and private send/readback/inbox mail endpoints. They are inert unless explicitly configured; tests use fake HTTP implementations only.
- Bounded inbox batches, duplicate event suppression, conservative unsubscribe detection, automatic-message classification and pause/cancellation of cold follow-ups. Human-reply drafts use the same approval path.
- Tenant-scoped summaries and opaque content references; no raw address, HTML or message body in MCP results or audit records.

## Proposed tool permissions and effects

Every input has `schema_version=2026-08-11.v1`, `version=2026-09-11.v0`, a strict Zod object convertible to Draft 2020-12, and no unknown fields. No new top-level envelope states are introduced. Every handler requires a trusted, unexpired `ExecutionContext` and a role allowed by `platform/outreach-tools.ts`. When the token contains exact `tool:*` entitlements, only the matching exact entitlement is accepted; legacy role-scoped contexts use the named permission. Writes additionally use the platform's `write_context` contract with server-checked tenant/actor binding, `operation_mode=commit`, `preview_ref`, and an idempotency key. Existing credentials acquire **no** new permission from this code.

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

Writes use the platform `write_context` envelope with `operation_mode=commit`, `preview_ref`, `idempotency_key`, and the server-checked tenant/actor/session binding. Preview endpoints do not perform the subsequent source write. Candidate successful operations retain `manual_review`, `candidate_only=true` and `production_eligible=false`. Clients must inspect the returned object reference/state before retrying; `manual_review` does not mean that a local draft/job was not saved.

### Old/new examples and compatibility

Old catalogs: no outreach tools; unchanged by this PR.

Proposed research input:

```json
{"schema_version":"2026-08-11.v1","version":"2026-09-11.v0","capture_ref":"capture_fixture"}
```

Proposed import input (preview token must actually come from the preceding operation):

```json
{"schema_version":"2026-08-11.v1","version":"2026-09-11.v0","capture_ref":"capture_fixture","candidate_index":0,"write_context":{"tenant_context":{"tenant_id":"tenant_fixture","actor_id":"sales_fixture","actor_role":"sales","client_id":"client_fixture","session_id":"session_fixture"},"operation_mode":"commit","preview_ref":"<server-issued-token>","idempotency_key":"lead_import_001","approval":{"required":false}}}
```

This is a candidate, additive code delivery; there is no migration of existing data and no change to existing scopes. The manifest follows current static ModuleDefinition syntax, not the future generic hot-plug artifact contract. The platform RBAC policy for the candidate tools and the standard `write_context` input contract are implemented and covered by `executeRegisteredToolWithResult` tests, but the module is deliberately not added to `t0-v1`, `business-v1`, the production composition or any existing API Key entitlement. Production naming, formal input/output schema publication, delegated scopes, readback evidence DTOs, signed provider descriptor and profile changes require acceptance and baseline work. The factory alone is not a public deployment.

### Provider integration contract

`services/logistics-outreach/runtime.ts` composes the private service only when `MCP_OUTREACH_ENABLED=true`. Construction validates configuration and secret files but does not open a provider connection; the first actual request is made by the corresponding port.

| Provider | Adapter | Private bridge contract |
| --- | --- | --- |
| Mail | `providers/http-mail.ts` | `POST /v1/messages`, `GET /v1/messages/{idempotency_key}`, `GET /v1/inbox`; tenant header `x-freightclaw-tenant`; exact receipt/readback digest required |
| Model | `providers/openai-model.ts` | OpenAI-compatible `POST /v1/chat/completions`; untrusted company/incoming text is passed as JSON data; response must contain strict `subject`/`body` JSON |
| Capture | `providers/http-capture.ts` | `GET /v1/captures/{capture_ref}` and private collector `POST /v1/captures` with an opaque reference only; the bridge worker owns Chrome CDP, URL allowlists and page capture |

The base URLs must be HTTPS and their hosts must match `MCP_OUTREACH_*_ALLOWED_HOST`; secrets are read from absolute, non-symlink, owner-readable files. HTTP requests are bounded by timeout and response-size limits. Provider errors and response bodies are not returned in MCP results or logs. The capture bridge must never accept a URL or script from the model; it is an isolated worker boundary.

Required runtime settings are `MCP_OUTREACH_STATE_DB_PATH`, `MCP_OUTREACH_PREVIEW_KEY_FILE`, `MCP_OUTREACH_CAPTURE_BASE_URL`, `MCP_OUTREACH_CAPTURE_ALLOWED_HOST`, `MCP_OUTREACH_CAPTURE_TOKEN_FILE`, `MCP_OUTREACH_MODEL_BASE_URL`, `MCP_OUTREACH_MODEL_ALLOWED_HOST`, `MCP_OUTREACH_MODEL_API_KEY_FILE`, `MCP_OUTREACH_MODEL_NAME`, `MCP_OUTREACH_MAIL_BASE_URL`, `MCP_OUTREACH_MAIL_ALLOWED_HOST`, and `MCP_OUTREACH_MAIL_TOKEN_FILE`. `MCP_OUTREACH_PROVIDER_TIMEOUT_MS` is optional.

## Mandatory production gates / known gaps

1. **Chrome CDP/map bridge not deployed:** the HTTP capture port/collector contract is implemented, but no real Chrome CDP, Google Maps or other discovery worker is connected. The bridge worker must produce immutable tenant-scoped captures, enforce permitted sources, redirect/DNS/egress and size/time limits, and stop at access restrictions. Reading public email is not an approval to contact it.
2. **Real vendor bridge not connected:** the OpenAI-compatible model, private mail and capture adapters are implemented and tested with fake HTTP implementations, but no real SMTP/Gmail/Graph/OAuth/webhook/inbox credential, bounce/complaint handling or provider health evidence exists in this PR. The supplied mailbox and contacts are synthetic `.invalid` fixtures only.
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
