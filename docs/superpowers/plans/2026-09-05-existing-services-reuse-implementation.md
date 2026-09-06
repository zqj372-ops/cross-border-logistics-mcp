# Existing Business Services Reuse v1 implementation plan

> Scope update: The user authorized the cross-service work and replaced webpage handoff with an API-native console, user management and API applications. The current product plan is `docs/product/2026-09-05-mcp-product-redesign/14-api-platform-delivery.md`. This earlier plan remains technical input for upstream adapters; it is not the complete current implementation scope, and does not imply new contracts or production readiness are already verified.

## Goal

After `docs/rfcs/2026-09-05-existing-services-reuse-v1.md` is accepted, reuse the existing RiskCustoms and quote-service authority through narrow, fail-closed contracts. Preserve `customs.ca.search`, keep `t0-v1` unchanged, and add no business write path.

This plan describes future work. No item below is complete merely because this document exists.

## Delivery gates

1. **RFC acceptance:** baseline owner records acceptance and freezes names, schema versions, permissions and ownership.
2. **Local contract evidence:** closed schemas, examples, adapter fixtures and negative tests pass.
3. **Upstream readiness:** each service owner implements its endpoint and provides version/release/readback evidence.
4. **Staging integration:** one explicit tenant mapping passes status, authorization, correlation and response readback.
5. **Profile release:** a separately reviewed non-T0 profile and exact entitlement are published and read back.

Skipping a gate keeps the affected tool `unavailable` or absent. UI readiness and API readiness remain separate.

## Work sequence

### 0. Freeze audited baselines

Owner: 01 baseline with the two upstream service owners.

- Record MCP commit/worktree state and exact upstream commits/worktree hashes used for implementation.
- Confirm RiskCustoms M2M request/response against its checked-in OpenAPI and current source.
- Confirm the quote engine entry that can be called without record/task/notification side effects.
- Record every unresolved fee, rate, version, tenant and release definition as a blocker; do not fill it with fixtures.

Exit: a review note identifies exact source versions and states whether each upstream tree is clean. No production claim is made.

### 1. Add shared schemas and red contract tests

Owner: 01 baseline; writable scope `docs/contracts/**`, contract examples and shared schema registry.

- Add closed Draft 2020-12 schemas for `customs.trade.search` request/result and its MCP envelope.
- Model structured question, national classification, legal names/hierarchy, rate lines, documents, measures, publication identity and source references.
- Keep text/specific/compound rates distinct; only authoritative numeric percentages use decimal strings.
- Add quote preview request/result schemas matching the accepted upstream route. Require units, ISO currency, decimal strings, validity and release evidence; fix `sendable=false` and `bookable=false`.
- Add old/new examples and tests proving the existing Canada schema is unchanged.
- Do not add tool registry entries until the RFC is accepted.

Targeted validation:

```bash
npm run validate:schemas
npm test -- tests/platform
git diff --check
```

Exit: schemas reject unknown fields, floats, missing units, mixed currency, incomplete identity and any client-supplied tenant/endpoint/credential/release field.

### 2. Implement complete RiskCustoms projection

Owner: 05 adapters for `src/logistics_mcp/adapters/customs/**` and `tests/adapters/**`; RiskCustoms owner only for its own repository.

- Add a new adapter method/tool implementation for `customs.trade.search`; do not alter the `customs.ca.search` output.
- Accept explicit `jurisdictions` and project only those jurisdictions from the upstream response.
- Preserve query correlation, structured next question, code hierarchy, names/translation state, rate lines, confirmed total, documents, measures, warnings, publication identity and used sources.
- Reuse the current status-before-query and snapshot/identity comparison. No query occurs after `ready=false`, `testData=true` or incomplete identity.
- Preserve source references per field and reject missing, duplicate, out-of-release or out-of-date references.
- Return `manual_review` for candidate/conflict states and `unavailable` for readiness/contract failure; never upgrade upstream status.

Required tests:

- CN-only, US-only, CA-only and explicit multi-jurisdiction requests.
- Existing `customs.ca.search` golden output unchanged.
- Exact code, name search, candidate selection and typed follow-up.
- Percentage, free, specific, compound and text rates without display-string parsing.
- Complete document/measure/source mapping and missing-source rejection.
- Snapshot changes between status/query, rule-date mismatch, invalid tenant, timeout, 429 and non-test readiness.

Targeted command:

```bash
npm test -- tests/adapters/riskcustoms-api-adapter.test.ts tests/adapters/riskcustoms-runtime.test.ts
```

Exit: a fixed upstream response round-trips all accepted fields, and field-omission mutation tests fail.

### 3. Build the quote-service read-only preview

Owner: AI 自动报价模块 service owner. MCP repository remains read-only during this upstream slice.

- Extract one deterministic calculation function used by both the existing UI flow and `POST /quotes/zone-preview`.
- Separate calculation from quote/sales persistence, manual-task creation, notifications, customer-copy generation, learning feedback and booking.
- Add service credential verification and exact `X-Tenant-Id` binding. Map one MCP tenant to one upstream account/instance; no wildcard/default fallback.
- Map `tenant + warehouse_code` to one canonical origin in server configuration.
- Publish fee taxonomy, inclusion rules, rounding, currency, validity, rule/data/service/contract versions, release ID and hashes.
- Write only a redacted security access audit. Add fake stores/sinks and compare them before/after every endpoint outcome.
- Return explicit calculated/manual-review/not-calculable/readiness outcomes; HTTP 200 is insufficient evidence.

Upstream required tests:

- Same input and same active snapshot produce the same normalized result.
- Total equals same-currency line sum; every line cites a published source.
- Missing unit, unsupported service and ambiguous charge fail closed.
- Cross-tenant and unknown warehouse are rejected before engine access.
- Quote, sales, task, notification, booking, rule and feedback fakes have zero writes.
- Audit contains no address, cargo detail, price body, customer text or credential.

Exit: upstream owner supplies a versioned schema, local tests, fixture readback and release procedure. This does not yet prove production availability.

### 4. Align and enable the MCP quote adapter locally

Owner: 05 adapters; files under `src/logistics_mcp/adapters/quote/**` and `tests/adapters/**`.

- Update `QuoteApiAdapter` to the accepted upstream request: tenant stays in server-authenticated context/header and is absent from client-controlled body.
- Keep exact tenant/warehouse-to-origin mapping and bounded HTTPS/host/timeout/response-size policy.
- Validate release/readiness before projecting data; verify currency, totals, fee references, validity and request correlation.
- Keep `sendable=false`, `bookable=false`; do not reuse `ExistingQuoteAdapter` write methods or point to `/quotes/zone-calculate`.
- Map failures to the five envelope states exactly as specified in the RFC.

Targeted command:

```bash
npm test -- tests/adapters/quote-api-adapter.test.ts tests/platform/quote-v2-runtime.test.ts tests/platform/quote-production-delegation.test.ts
```

Exit: adapter is disabled by default and passes fixtures for all states and zero-write behavior.

### 5. Register tools in a separate non-T0 profile

Owner: 02 platform/server for composition and registry; 01 baseline for catalog/contracts; 07 access for entitlements and deployment identity.

- Add `customs.trade.search` and the accepted quote preview tool only to a new named profile.
- Add exact tool entitlements and reject broad or Admin scopes as substitutes.
- Prove `t0-v1` tool/resource/adapter set and zero-construction behavior remain unchanged.
- Keep endpoint, host, credential file/slot, tenant and origin mappings server-owned.
- Require reconnect/readback after grant or profile changes.

Required tests:

- Exact new profile inventory; new tools absent from `t0-v1`.
- Non-entitled client cannot list or call either tool.
- Wrong tenant, issuer, audience, credential, host or profile is blocked.
- Adapter constructors and secret readers are never invoked in `t0-v1`.

Exit: local fixture profile works; production profile remains disabled until staging evidence passes.

### 6. Integrate task entry without freezing Admin DTO

Owner: 06 integration for `apps/admin/**`; configuration owner supplies its accepted server contract.

- Consume only server-projected, allowlisted business-entry state.
- Show original service, current entry verification, MCP connection and data readiness as separate fields.
- Use top-level/new-tab navigation; do not depend on iframe or shared SSO.
- Label plain links “打开工作台”. Use “打开本次结果” only after result readback exists.
- Keep current preparation forms non-authoritative and do not auto-submit upstream actions.

Required UI checks: role visibility, missing/unverified URL, disabled state, keyboard navigation, desktop/mobile screenshots, console errors and no sensitive URL parameters.

Exit: UI does not infer service health from configured URL or infer MCP readiness from page reachability.

### 7. Add handoff and result references as a later slice

Owner: new accepted RFC must assign the handoff service; 01 owns contract, 02/05 implement server adapters, 06 integrates UI, 07 enforces identity.

- Define create, atomic claim, status, revoke and result-reference return/readback schemas.
- Store only opaque identifiers and minimum binding metadata in FreightClaw; the source service retains business payload/result authority.
- Bind tenant, actor ref, issuer, recipient, purpose, allowed fields and expiry server-side.
- Require confirmation after prefill. Never auto-quote, classify, notify, save, send or book.
- Invalidate result display when input fingerprint, version, validity or authorization changes.
- Test expired, revoked, duplicate claim, replay after timeout, cross-tenant, arbitrary return URL and missing source readback.

Exit: a returned reference can be reauthorized and read from its owner. A delivered handoff alone is never shown as a successful quote/customs result.

## Staging acceptance matrix

| Gate | Customs | Quote |
| --- | --- | --- |
| Identity | exact M2M client/tenant, no browser state | exact service client/tenant/account mapping |
| Release | ready, non-test, stable status/query identity | active non-test release with rule/data/snapshot hashes |
| Result | requested jurisdictions and every field/source read back | request correlation, currency, lines, total, validity read back |
| Failure | ready false, snapshot change, bad source, timeout fail closed | unknown warehouse, unsupported service, write attempt, bad total fail closed |
| Side effects | only required redacted M2M audit | only required redacted access audit; zero business writes |
| Permissions | exact new tool entitlement | exact new tool entitlement; no send/save/book permission |

Production enablement requires recorded responses from the authorized staging/production-like environment. Local fixtures, UI screenshots, endpoint reachability and green CI are supporting evidence only.

## Full repository verification

After all accepted MCP slices land:

```bash
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:agent-standards
npm run build:agent-pack
npm test
npm run build
git diff --check
```

Also scan changed fixtures/log assertions for raw addresses, quote details, tax materials, customer text, bearer/API keys, endpoints and tenant leakage.

## Rollback drill

1. Remove new entitlements and disable the new profile.
2. Deploy the prior verified MCP build; verify `t0-v1` and `customs.ca.search` exact inventories and golden outputs.
3. Disable the quote preview upstream route. Never redirect it to a write-capable route.
4. Verify no business records/tasks/notifications/bookings appeared during the drill.
5. Retain redacted audits and failed-attempt evidence for review.

## Exit criteria

- Existing service UI and authority remain the business system of record.
- `customs.ca.search` is byte-for-byte contract compatible; multi-country semantics exist only in an explicit new tool.
- Customs complete results preserve rates, totals, measures, documents, sources, questions and publication identity without AI completion.
- Quote preview uses the same deterministic engine and demonstrably creates no business writes.
- All amounts/rates and measurements follow decimal-string, currency and unit rules.
- Every error maps to one of `success|needs_input|manual_review|blocked|unavailable` without status upgrading.
- `t0-v1` and existing grants do not expose or construct the new integrations.
- Handoff/result references remain separately authorized opaque locators, not copied records or proof of success.
- Unresolved upstream fee, rate, version, release and tenant definitions remain visible blockers until verified.
