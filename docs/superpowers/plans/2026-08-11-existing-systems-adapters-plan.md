# Existing Systems Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the Phase 1 MCP tools to existing quote, RiskCustoms, curated knowledge, status, and manual-review boundaries through narrow ports, fixture-backed contract tests, and fail-closed production configuration.

**Architecture:** Each adapter owns one existing-system boundary and implements a small port. The domains translate external records into the shared models; the adapters never become a new authority and never expose raw credentials or customer documents. Production endpoints remain disabled until an adapter contract test and read-only sandbox check confirm the actual route, auth, tenant scope, version field, and readback shape.

**Tech Stack:** Node.js 22, TypeScript strict mode, `fetch` with an allowlist, Vitest, Zod, fixture HTTP handlers, and the shared schemas/envelope. No live production call is part of this plan.

---

### Task 1: Define adapter ports and fake fixtures before external calls

**Files:**
- Create: `src/logistics_mcp/adapters/ports.ts`
- Create: `src/logistics_mcp/adapters/fixture-client.ts`
- Create: `tests/adapters/ports.test.ts`
- Create: `tests/adapters/fixtures/quote-success.json`
- Create: `tests/adapters/fixtures/customs-ready.json`

- [ ] **Step 1: Write failing port tests**

```ts
import { describe, expect, it } from "vitest";
import { createFixtureAdapters } from "../../src/logistics_mcp/adapters/fixture-client";

describe("adapter ports", () => {
  it("returns versioned source refs instead of raw upstream payloads", async () => {
    const adapters = createFixtureAdapters();
    const result = await adapters.quote.calculate({ fixture: "quote-success" });
    expect(result.sourceRefs[0]).toMatchObject({ system: "existing-quote-system", version: "quote-fixture@1" });
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("api_key");
  });
});
```

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/adapters/ports.test.ts`.

Expected: FAIL because no adapter ports exist.

- [ ] **Step 3: Define ports with no generic write method**

Define `QuoteAdapter.calculate`, `QuoteAdapter.previewDraft`, `QuoteAdapter.commitDraft`, `QuoteAdapter.readDraft`, `CustomsAdapter.getStatus`, `CustomsAdapter.search`, `CustomsAdapter.estimate`, `KnowledgeAdapter.searchCurated`, `ReviewAdapter.previewTask`, `ReviewAdapter.commitTask`, and `ReviewAdapter.readTask`. Do not define `commitOperation`, `writeAny`, `updateRate`, `publishQuote`, or `submitBooking`. Every method returns structured records plus source refs and version.

- [ ] **Step 4: Implement fixture client only**

Fixture responses must use fake IDs and `https://example.invalid` or `fixture://` locators. Fixture `customs-ready.json` must include `ready` and release IDs; add a second `customs-not-ready.json` with `ready=false`.

- [ ] **Step 5: Commit the adapter ports**

```bash
git add src/logistics_mcp/adapters/ports.ts src/logistics_mcp/adapters/fixture-client.ts tests/adapters/ports.test.ts tests/adapters/fixtures
git commit -m "feat: define narrow existing-system adapter ports"
```

### Task 2: Implement the existing quote adapter with fail-closed Zone and price mapping

**Files:**
- Create: `src/logistics_mcp/adapters/quote/existing-quote-adapter.ts`
- Create: `src/logistics_mcp/domains/quote/canada-final-mile.ts`
- Test: `tests/adapters/quote-adapter.test.ts`

- [ ] **Step 1: Write red quote adapter tests**

Include these cases: exact postal/FSA match returns a versioned rule and price; postal/FSA conflict returns `manual_review` with no total; missing address type returns `needs_input`; missing matrix row returns `manual_review`; a map/portal fallback is never called; `sendable` is always false.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/adapters/quote-adapter.test.ts`.

Expected: FAIL because the quote adapter and domain function do not exist.

- [ ] **Step 3: Implement mapping against the verified boundary**

Translate the current system's `ZoneLookupRule`, `ZonePriceMatrix`, quote audit and manual-task result into `QuoteResult`/envelope. Record the upstream locator and effective version; do not copy rows into MCP storage. If the actual production route or field names differ from the read-only evidence, return a configuration error and keep the adapter disabled until the route is confirmed in a fixture.

- [ ] **Step 4: Implement draft preview and commit ports separately**

Preview returns a request hash and preview ref without writing. Commit accepts only the same preview ref, tenant-bound idempotency key and policy-approved context; it writes the existing quote draft, then calls `readDraft(recordId)` and verifies tenant, quote ID and revision. Any uncertain upstream response returns `manual_review`, never a second blind write.

- [ ] **Step 5: Run quote tests**

Run: `npm test -- --run tests/adapters/quote-adapter.test.ts`.

Expected: PASS with no price in conflict/missing-row paths and `sendable=false` in every output.

- [ ] **Step 6: Commit the quote adapter**

```bash
git add src/logistics_mcp/adapters/quote src/logistics_mcp/domains/quote tests/adapters/quote-adapter.test.ts
git commit -m "feat: adapt Canada final-mile quote boundary"
```

### Task 3: Implement RiskCustoms status, search, and estimate adapters

**Files:**
- Create: `src/logistics_mcp/adapters/customs/riskcustoms-adapter.ts`
- Create: `src/logistics_mcp/domains/customs/ca-search.ts`
- Create: `src/logistics_mcp/domains/customs/ca-estimate.ts`
- Test: `tests/adapters/riskcustoms-adapter.test.ts`

- [ ] **Step 1: Write failing readiness and source tests**

```ts
import { describe, expect, it } from "vitest";
import { RiskCustomsAdapter } from "../../src/logistics_mcp/adapters/customs/riskcustoms-adapter";

describe("RiskCustoms adapter", () => {
  it("maps ready=false to unavailable without calling the AI fallback", async () => {
    const adapter = new RiskCustomsAdapter({ baseUrl: "fixture://riskcustoms-not-ready" });
    const result = await adapter.search({ ruleDate: "2026-08-11", queryKind: "name_search", productDescriptionRef: { ref_id: "opaque_demo", kind: "raw_input", purpose: "fixture" } });
    expect(result.status).toBe("unavailable");
    expect(result.data?.data_status.ready).toBe(false);
    expect(result).not.toHaveProperty("aiCandidate");
  });
});
```

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/adapters/riskcustoms-adapter.test.ts`.

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement the status gate**

Call the verified `/api/status` contract through an allowlisted base URL and parse `DataStatusSchema`. If `ready` is false, test data is true, release IDs are missing, or the snapshot hash does not match the returned releases, return `unavailable`/`manual_review` and do not call query or AI fallback. Never log the query body or token.

- [ ] **Step 4: Implement search mapping**

Map candidates, next questions, source refs, rule date, effective dates, rate expressions, measures, and data status into `customs-search-result.schema.json`. Candidate status remains candidate/possible/manual_review; no adapter path may produce a formal confirmed classification from an AI-only response.

- [ ] **Step 5: Implement estimate mapping**

Require an explicit HS candidate, origin country, import date, value for duty, and release version. Preserve raw rate expressions as short structured fields, keep unparseable rates unconfirmed, and set `requires_broker_confirmation=true` by default. Return `manual_review` for scope conflicts and `unavailable` for missing published data.

- [ ] **Step 6: Run customs tests**

Run: `npm test -- --run tests/adapters/riskcustoms-adapter.test.ts`.

Expected: PASS for ready, not-ready, malformed hash, missing release, candidate-only, and unconfirmed measure cases.

- [ ] **Step 7: Commit customs adapters**

```bash
git add src/logistics_mcp/adapters/customs src/logistics_mcp/domains/customs tests/adapters/riskcustoms-adapter.test.ts
git commit -m "feat: adapt RiskCustoms readiness and estimates"
```

### Task 4: Implement curated knowledge and status adapters

**Files:**
- Create: `src/logistics_mcp/adapters/knowledge/curated-adapter.ts`
- Create: `src/logistics_mcp/adapters/status/system-status-adapter.ts`
- Create: `src/logistics_mcp/domains/knowledge/search-curated.ts`
- Create: `src/logistics_mcp/domains/status/data-status.ts`
- Test: `tests/adapters/knowledge-status-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Assert that `SOP_QUICK.md`, `RULES.yaml`, `QUOTE_TEMPLATE.md`, and `EDGE_CASES.md` can be returned as supporting/authoritative refs according to the authority matrix; archived long SOP is excluded; a missing index returns `unavailable`; status output preserves `ready=false`, reason and release IDs.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/adapters/knowledge-status-adapter.test.ts`.

Expected: FAIL because the adapters are absent.

- [ ] **Step 3: Implement curated search**

Filter by an explicit allowlist of current files and `status=active`; return title, short summary, checksum/version and SourceRef. Do not return raw credentials, full customer address, or full tax documents. A search result is supporting context unless the authority matrix marks it as executable and the relevant deterministic engine consumes it.

- [ ] **Step 4: Implement status aggregation**

Return one `data-status.schema.json` object per requested system. A status request that succeeds at transport but says `ready=false` has envelope `success` for the status tool and blocks dependent tools; a transport/data verification failure has envelope `unavailable`.

- [ ] **Step 5: Run and commit**

Run: `npm test -- --run tests/adapters/knowledge-status-adapter.test.ts`.

Expected: PASS. Commit with:

```bash
git add src/logistics_mcp/adapters/knowledge src/logistics_mcp/adapters/status src/logistics_mcp/domains/knowledge src/logistics_mcp/domains/status tests/adapters/knowledge-status-adapter.test.ts
git commit -m "feat: add curated knowledge and status adapters"
```

### Task 5: Implement manual review task adapter with readback

**Files:**
- Create: `src/logistics_mcp/adapters/review/manual-task-adapter.ts`
- Create: `src/logistics_mcp/domains/review/create-task.ts`
- Test: `tests/adapters/review-adapter.test.ts`

- [ ] **Step 1: Write failing task tests**

Test preview has no fixture write; commit creates one task with fake opaque refs; repeating the same tenant/tool/idempotency key returns the same task ID; a different request hash rejects; readback missing status returns `manual_review`; raw address/credential fields never reach the fixture.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/adapters/review-adapter.test.ts`.

Expected: FAIL because no review adapter exists.

- [ ] **Step 3: Implement the narrow task lifecycle**

Accept only `task_type`, `priority`, `reason_codes`, and `opaque_context_refs`; construct a `review-task.schema.json` object; use the platform idempotency repository; commit via the existing manual-task boundary; call `readTask` and validate task ID/status/version. Do not accept a resolution or rule promotion field.

- [ ] **Step 4: Run review tests and commit**

Run: `npm test -- --run tests/adapters/review-adapter.test.ts`.

Expected: PASS. Commit:

```bash
git add src/logistics_mcp/adapters/review src/logistics_mcp/domains/review tests/adapters/review-adapter.test.ts
git commit -m "feat: create auditable manual review tasks"
```

### Task 6: Wire the nine tools to adapters and run contract fixtures

**Files:**
- Modify: `src/logistics_mcp/server/tool-registry.ts`
- Create: `src/logistics_mcp/domains/knowledge/tool.ts`
- Create: `src/logistics_mcp/domains/status/tool.ts`
- Create: `src/logistics_mcp/domains/quote/tool.ts`
- Create: `src/logistics_mcp/domains/customs/tool.ts`
- Create: `src/logistics_mcp/domains/review/tool.ts`
- Test: `tests/domains/phase1-tools.test.ts`

- [ ] **Step 1: Write the end-to-end fixture tests**

Invoke every catalog tool with fake contexts and assert: every result is a valid envelope; every success has source refs and versions; every write has idempotency, preview/approval fields and readback; no result exposes raw text; RiskCustoms not-ready remains unavailable/manual_review.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/domains/phase1-tools.test.ts`.

Expected: FAIL until all tool handlers are registered.

- [ ] **Step 3: Implement the tool wrappers**

Each wrapper validates its input, checks RBAC through the platform, calls one domain/adapter boundary, and wraps the result. Do not add a tool not listed in `tool-catalog.md`; do not let a wrapper call another write tool implicitly.

- [ ] **Step 4: Run full adapter/domain verification**

Run: `npm test -- --run tests/adapters tests/domains && npm run typecheck && npm run lint && npm run validate:schemas`.

Expected: all fixture tests PASS and all static checks exit 0.

- [ ] **Step 5: Commit the tool wiring**

```bash
git add src/logistics_mcp/server/tool-registry.ts src/logistics_mcp/domains/knowledge/tool.ts src/logistics_mcp/domains/status/tool.ts src/logistics_mcp/domains/quote/tool.ts src/logistics_mcp/domains/customs/tool.ts src/logistics_mcp/domains/review/tool.ts tests/domains/phase1-tools.test.ts
git commit -m "feat: wire Phase 1 tools to existing systems"
```
