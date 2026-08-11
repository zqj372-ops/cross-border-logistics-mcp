# MCP Platform and Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared remote MCP gateway foundation that validates the v1 envelope, binds tenant/actor context, enforces tool RBAC, records redacted audit events, and provides idempotent preview/commit primitives without adding business calculations.

**Architecture:** A single Node 22 TypeScript process owns transport, authentication context, tool registration, envelope validation, audit, and idempotency. Domain tools receive a typed `ExecutionContext` and return a tool-specific data object; the platform wraps it in the shared envelope. Business data remains behind adapters and no platform table becomes a quote/customs authority.

**Tech Stack:** Node.js 22, TypeScript 5.9, `@modelcontextprotocol/sdk`, Zod for runtime request validation, Vitest, built-in `fetch`, and a repository interface with an in-memory test implementation.

---

### Task 1: Scaffold the platform package and a failing envelope contract test

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/logistics_mcp/platform/index.ts`
- Test: `tests/platform/envelope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createEnvelope } from "../../src/logistics_mcp/platform/envelope";

describe("v1 response envelope", () => {
  it("accepts only the five baseline statuses and emits every required field", () => {
    const result = createEnvelope({ requestId: "req_test_001", status: "success", data: { ok: true }, auditId: "audit_test_001" });
    expect(result).toMatchObject({
      schema_version: "2026-08-11.v1",
      request_id: "req_test_001",
      status: "success",
      data: { ok: true },
      source_refs: [],
      assumptions: [],
      warnings: [],
      blockers: [],
      calculation_trace: [],
      review_status: "not_required",
      audit_id: "audit_test_001",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/platform/envelope.test.ts`

Expected: FAIL with a module-not-found error for `src/logistics_mcp/platform/envelope`.

- [ ] **Step 3: Create the package scaffold**

Use Node 22, TypeScript strict mode, and scripts whose commands are stable for all later plans:

```json
{
  "name": "cross-border-logistics-mcp",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src tests",
    "validate:schemas": "node scripts/validate-contracts.mjs"
  }
}
```

`tsconfig.json` must set `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and `moduleResolution: "Bundler"`. Keep the initial `index.ts` export-only; no transport or business logic is added in this task.

- [ ] **Step 4: Run the test again**

Run: `npm test -- --run tests/platform/envelope.test.ts`

Expected: FAIL with an undefined `createEnvelope` export, proving the test reaches the intended boundary.

- [ ] **Step 5: Commit the scaffold**

```bash
git add package.json tsconfig.json vitest.config.ts src/logistics_mcp/platform/index.ts tests/platform/envelope.test.ts
git commit -m "chore: scaffold MCP platform package"
```

### Task 2: Implement envelope construction and runtime validation

**Files:**
- Create: `src/logistics_mcp/platform/envelope.ts`
- Create: `src/logistics_mcp/platform/contract-errors.ts`
- Modify: `tests/platform/envelope.test.ts`
- Test: `tests/platform/envelope-invalid.test.ts`

- [ ] **Step 1: Add red tests for invalid statuses, missing audit IDs, and sensitive data**

```ts
import { describe, expect, it } from "vitest";
import { validateEnvelope } from "../../src/logistics_mcp/platform/envelope";

describe("validateEnvelope", () => {
  it("rejects a status outside the v1 enum", () => {
    expect(() => validateEnvelope({ status: "quoted" })).toThrow(/status/);
  });

  it("rejects a missing audit id", () => {
    expect(() => validateEnvelope({ status: "success", request_id: "req_1" })).toThrow(/audit_id/);
  });

  it("does not accept raw address or credential fields in audit metadata", () => {
    expect(() => validateEnvelope({ status: "success", request_id: "req_1", audit_id: "audit_1", customer_address: "secret" })).toThrow(/additional|address/i);
  });
});
```

- [ ] **Step 2: Run the focused red tests**

Run: `npm test -- --run tests/platform/envelope-invalid.test.ts`

Expected: FAIL because `validateEnvelope` is not implemented.

- [ ] **Step 3: Implement the minimum typed envelope**

Define `EnvelopeStatus`, `ReviewStatus`, `Notice`, `SourceRef`, `CalculationStep`, and `ResponseEnvelope` in `envelope.ts`. `createEnvelope` must set the version, empty arrays, and `review_status="not_required"` when omitted. `validateEnvelope` must use a strict Zod object with the five statuses, the 11 required top-level keys, and a `data` passthrough object validated by the tool-specific schema before this function is called. Do not accept unknown top-level keys.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- --run tests/platform/envelope.test.ts tests/platform/envelope-invalid.test.ts`

Expected: PASS with all envelope assertions; then `npm run typecheck` exits 0.

- [ ] **Step 5: Commit the envelope boundary**

```bash
git add src/logistics_mcp/platform/envelope.ts src/logistics_mcp/platform/contract-errors.ts tests/platform/envelope.test.ts tests/platform/envelope-invalid.test.ts
git commit -m "feat: enforce MCP response envelope"
```

### Task 3: Bind tenant/actor context and tool-level RBAC

**Files:**
- Create: `src/logistics_mcp/platform/context.ts`
- Create: `src/logistics_mcp/platform/rbac.ts`
- Test: `tests/platform/context-rbac.test.ts`

- [ ] **Step 1: Write the failing authorization tests**

```ts
import { describe, expect, it } from "vitest";
import { authorizeTool } from "../../src/logistics_mcp/platform/rbac";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";

describe("platform context and RBAC", () => {
  it("binds tenant and actor from the verified token claims", () => {
    expect(parseExecutionContext({ tenant_id: "tenant_demo", actor_id: "actor_sales", actor_role: "sales", client_id: "codex_demo", session_id: "sess_demo" })).toMatchObject({ tenantId: "tenant_demo", actorId: "actor_sales", role: "sales" });
  });

  it("allows sales to calculate but blocks sales from changing a rate", () => {
    const context = parseExecutionContext({ tenant_id: "tenant_demo", actor_id: "actor_sales", actor_role: "sales", client_id: "chatgpt_demo", session_id: "sess_demo" });
    expect(authorizeTool(context, "quote.canada_final_mile.calculate")).toBe(true);
    expect(() => authorizeTool(context, "rules.write")).toThrow(/forbidden/i);
  });
});
```

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/platform/context-rbac.test.ts`

Expected: FAIL because the context and RBAC functions are absent.

- [ ] **Step 3: Implement server-derived context**

`parseExecutionContext` must reject missing tenant, actor, role, client, or session IDs and must never read an actor or tenant from an LLM payload. `authorizeTool` must use a literal registry for the nine Phase 1 tools and permissions from `tool-catalog.md`; every unknown tool and every rule/write/send/booking capability must throw `ForbiddenError`. Add a `scope` check that receives the target tenant ID and rejects mismatches before an adapter call.

- [ ] **Step 4: Run RBAC tests including cross-tenant negatives**

Add cases for `viewer` reading status, `viewer` being blocked from `review.create_task`, and a `sales` context targeting another tenant. Run: `npm test -- --run tests/platform/context-rbac.test.ts`.

Expected: PASS with no authorization bypass.

- [ ] **Step 5: Commit context and RBAC**

```bash
git add src/logistics_mcp/platform/context.ts src/logistics_mcp/platform/rbac.ts tests/platform/context-rbac.test.ts
git commit -m "feat: add tenant context and tool RBAC"
```

### Task 4: Add redacted audit and idempotency repositories

**Files:**
- Create: `src/logistics_mcp/platform/audit.ts`
- Create: `src/logistics_mcp/platform/idempotency.ts`
- Create: `src/logistics_mcp/platform/repositories.ts`
- Test: `tests/platform/audit-idempotency.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { MemoryAuditRepository, redactAuditInput } from "../../src/logistics_mcp/platform/audit";
import { MemoryIdempotencyRepository } from "../../src/logistics_mcp/platform/idempotency";

describe("audit and idempotency", () => {
  it("removes raw addresses, quote amounts, tax text, and credentials", () => {
    const redacted = redactAuditInput({ postal_code: "A1A 1A1", full_address: "secret", amount: "999.00", password: "secret", raw_tax_document: "secret" });
    expect(redacted).toEqual({ postal_code: "A1A 1A1", full_address: "[opaque]", amount: "[redacted]", password: "[redacted]", raw_tax_document: "[opaque]" });
  });

  it("returns the first committed result for an identical key and rejects a different request hash", async () => {
    const store = new MemoryIdempotencyRepository();
    await store.reserve({ tenantId: "tenant_demo", tool: "quote.save_draft", key: "idem_demo_12345678", requestHash: "hash_a" });
    await store.commit({ tenantId: "tenant_demo", tool: "quote.save_draft", key: "idem_demo_12345678", requestHash: "hash_a", result: { recordId: "draft_1" } });
    await expect(store.reserve({ tenantId: "tenant_demo", tool: "quote.save_draft", key: "idem_demo_12345678", requestHash: "hash_b" })).rejects.toThrow(/idempotency/i);
  });
});
```

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/platform/audit-idempotency.test.ts`

Expected: FAIL because both repositories are missing.

- [ ] **Step 3: Implement bounded repositories**

The audit repository stores only IDs, tool, versions, status, reason codes, duration, source IDs, idempotency outcome and readback status. The redactor must recurse through objects and replace keys matching `address`, `raw`, `password`, `secret`, `token`, `credential`, `quote_amount`, `tax_document`, or `full_text` with `[opaque]`/`[redacted]`. The idempotency repository key is `(tenantId, tool, key)` and stores request hash, preview ref, status, record ID and expiration; it must not store full payloads.

- [ ] **Step 4: Run the repository tests**

Run: `npm test -- --run tests/platform/audit-idempotency.test.ts`.

Expected: PASS with the different-hash case failing closed.

- [ ] **Step 5: Commit audit and idempotency**

```bash
git add src/logistics_mcp/platform/audit.ts src/logistics_mcp/platform/idempotency.ts src/logistics_mcp/platform/repositories.ts tests/platform/audit-idempotency.test.ts
git commit -m "feat: add redacted audit and idempotency stores"
```

### Task 5: Register the nine tools and expose the remote MCP transport

**Files:**
- Create: `src/logistics_mcp/server/tool-registry.ts`
- Create: `src/logistics_mcp/server/http.ts`
- Create: `src/logistics_mcp/server/index.ts`
- Create: `tests/platform/tool-registry.test.ts`
- Create: `tests/platform/http-security.test.ts`

- [ ] **Step 1: Write failing registry and transport tests**

```ts
import { describe, expect, it } from "vitest";
import { phaseOneToolNames, registerPhaseOneTools } from "../../src/logistics_mcp/server/tool-registry";

describe("Phase 1 tool registry", () => {
  it("registers exactly the nine baseline tools", () => {
    expect(phaseOneToolNames).toEqual([
      "knowledge.search_curated", "system.get_data_status", "cargo.calculate", "container.plan_summary",
      "quote.canada_final_mile.calculate", "customs.ca.search", "customs.ca.estimate", "quote.save_draft", "review.create_task",
    ]);
    expect(registerPhaseOneTools().map((tool) => tool.name)).toEqual(phaseOneToolNames);
  });
});
```

The HTTP test must send an oversized body, an invalid origin, an expired token and a cross-tenant context; each must return a structured envelope or HTTP 4xx/413 without calling a domain handler.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/platform/tool-registry.test.ts tests/platform/http-security.test.ts`.

Expected: FAIL because the registry and HTTP handler do not exist.

- [ ] **Step 3: Implement the registry and handler**

`ToolDefinition` must carry name, input schema ID, output schema ID, permission, read/write kind, and a handler accepting `(input, executionContext)`. Register only the nine names in `tool-catalog.md`; unknown tool names return `blocked`. The HTTP adapter must enforce HTTPS at the deployment boundary, bounded body size, content type, origin allowlist, short-lived bearer validation, and no sensitive values in errors. It must wrap handler outcomes in the envelope and write an audit event for every outcome.

- [ ] **Step 4: Run platform verification**

Run: `npm test -- --run tests/platform` and `npm run typecheck`.

Expected: all platform tests PASS and TypeScript exits 0. Run `npm run lint` and require 0 errors.

- [ ] **Step 5: Commit the gateway foundation**

```bash
git add src/logistics_mcp/server tests/platform
git commit -m "feat: register Phase 1 MCP gateway tools"
```

### Task 6: Verify the complete platform plan before handoff

**Files:**
- Modify: `docs/runbooks/platform-verification.md`
- Test: `tests/platform/verification-contract.test.ts`

- [ ] **Step 1: Add a contract checklist test**

Read the nine names from the source registry and assert that each has a permission, input schema ID, output schema ID, and status mapping; assert that no name contains `commit_operation`, `send`, `publish`, `booking.submit`, or `rules.write`.

- [ ] **Step 2: Run the full command set**

Run: `npm test -- --run tests/platform && npm run typecheck && npm run lint && npm run validate:schemas && git diff --check`.

Expected: all test files PASS, typecheck/lint/schema validation exit 0, and `git diff --check` prints no errors.

- [ ] **Step 3: Commit the verification runbook**

```bash
git add docs/runbooks/platform-verification.md tests/platform/verification-contract.test.ts
git commit -m "docs: record platform verification gate"
```
