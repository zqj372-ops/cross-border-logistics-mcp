# Integration, Security, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the Phase 1 platform and adapters as one multi-client product, provide reproducible deployment/runbook artifacts, and enforce security/release gates without touching production systems.

**Architecture:** The integration layer tests the shared remote MCP endpoint against fixture adapters and isolated test stores. Deployment uses one gateway process behind HTTPS termination and an allowlisted outbound adapter network. Client examples contain fake endpoints and tokens only. Release is candidate-build → schema/test/security gates → staging smoke → explicit approval; no automatic publish/send/booking path is included.

**Tech Stack:** Node.js 22, TypeScript/Vitest, Playwright for contract-level browser/client smoke where needed, Docker Compose config validation, Nginx or managed HTTPS boundary as a deployment option, and shell/Python standard-library checks. No live production call is made by these tests.

---

### Task 1: Add isolated integration fixtures and red e2e tests

**Files:**
- Create: `tests/e2e/fixtures/tenant-fixtures.ts`
- Create: `tests/e2e/phase1-tools.test.ts`
- Create: `tests/e2e/security-fixtures.ts`

- [ ] **Step 1: Write failing end-to-end contract tests**

The test must invoke the gateway in an isolated process with tenant `tenant_demo_a`, actor `sales_demo`, and fixture adapters. Assert one successful cargo/quote flow, one `needs_input` flow, one unavailable RiskCustoms flow, one blocked send attempt, one review-task write/readback, and a cross-tenant request that never reaches an adapter.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/e2e/phase1-tools.test.ts`.

Expected: FAIL because the integration harness is absent.

- [ ] **Step 3: Implement isolated harness**

Start the gateway with `DATA_MODE=fixtures`, fake issuer keys, bounded body size, an in-memory audit/idempotency repository, and fixture adapters. Do not read `.env`, host credentials, or external URLs. Provide a `close()` hook so every test terminates the process.

- [ ] **Step 4: Run the e2e fixture tests**

Run: `npm test -- --run tests/e2e/phase1-tools.test.ts`.

Expected: PASS with exact status assertions and zero adapter calls on blocked/cross-tenant cases.

- [ ] **Step 5: Commit isolated e2e harness**

```bash
git add tests/e2e
git commit -m "test: add isolated Phase 1 integration fixtures"
```

### Task 2: Add security gates for tokens, tenant isolation, SSRF, limits, and logs

**Files:**
- Create: `src/logistics_mcp/platform/security.ts`
- Test: `tests/e2e/security-gates.test.ts`
- Create: `docs/runbooks/security-gates.md`

- [ ] **Step 1: Write failing security tests**

Cover: expired token rejected; wrong issuer/audience rejected; actor tenant mismatch rejected; unknown tool blocked; body over 32 KiB rejected; outbound URL `http://169.254.169.254/` and non-allowlisted host rejected; error logs contain no bearer token, API key, full address, quote amount, or tax document.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/e2e/security-gates.test.ts`.

Expected: FAIL until the security functions and redaction hooks are implemented.

- [ ] **Step 3: Implement the minimal security policy**

`validateShortLivedToken` must require issuer, audience, subject, tenant, role, issued-at and expiration; reject expired/future tokens. `assertTenantScope` must compare every target tenant. `assertAllowedOutboundUrl` must allow only configured HTTPS hosts and deny private/link-local/loopback IP literals and redirects. The request parser must enforce a 32 KiB default body cap and the audit redactor from platform must be used in every error path.

- [ ] **Step 4: Run security tests**

Run: `npm test -- --run tests/e2e/security-gates.test.ts`.

Expected: PASS with all denial paths returning structured 4xx/blocked results and no sensitive log match.

- [ ] **Step 5: Commit security gates**

```bash
git add src/logistics_mcp/platform/security.ts tests/e2e/security-gates.test.ts docs/runbooks/security-gates.md
git commit -m "feat: enforce gateway security gates"
```

### Task 3: Add deployment artifacts with safe defaults

**Files:**
- Create: `deploy/Dockerfile`
- Create: `deploy/compose.yml`
- Create: `deploy/env.example`
- Create: `deploy/README.md`
- Test: `tests/e2e/deploy-config.test.ts`

- [ ] **Step 1: Write failing deployment assertions**

Assert the Docker image runs as a non-root user, binds only the internal service port, has a healthcheck that does not expose secrets, requires `MCP_JWT_ISSUER`, `MCP_JWT_AUDIENCE`, `MCP_ALLOWED_ORIGINS`, `MCP_ALLOWED_OUTBOUND_HOSTS`, and `MCP_DATA_MODE`, and refuses a production mode with fixture adapters.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/e2e/deploy-config.test.ts`.

Expected: FAIL because deployment files do not exist.

- [ ] **Step 3: Create the artifacts**

Use a multi-stage Node 22 build, copy only compiled application and contract assets, run as an unprivileged user, and expose no host database. `deploy/env.example` must contain only fake values such as `https://issuer.example.invalid/`, `tenant_demo`, and `CHANGE_ME_IN_SECRET_STORE`; do not put a real key or token in the file. Compose must keep adapter credentials on a secret mount or environment injection point and must not publish the service directly to the public network.

- [ ] **Step 4: Validate configuration without deploying**

Run: `docker compose -f deploy/compose.yml config` and `npm test -- --run tests/e2e/deploy-config.test.ts`.

Expected: Compose renders successfully; tests PASS; no container is started by this step.

- [ ] **Step 5: Commit deployment artifacts**

```bash
git add deploy tests/e2e/deploy-config.test.ts
git commit -m "chore: add safe MCP deployment configuration"
```

### Task 4: Add client configuration examples and state-aware smoke tests

**Files:**
- Create: `deploy/clients/chatgpt.example.json`
- Create: `deploy/clients/codex.example.toml`
- Create: `deploy/clients/enterprise-assistant.example.json`
- Create: `tests/e2e/client-config.test.ts`
- Create: `docs/runbooks/client-onboarding.md`

- [ ] **Step 1: Write failing configuration tests**

Assert every example points to `https://mcp.example.invalid/mcp`, uses a fake `client_demo` ID, contains no token-like long secret, declares handling for all five statuses, and has no tool named `commit_operation`, `send`, `publish`, or `booking.submit`.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/e2e/client-config.test.ts`.

Expected: FAIL because the examples are absent.

- [ ] **Step 3: Add state-aware examples**

Document that clients render `needs_input` as questions, `manual_review` as a handoff with reason/source, `unavailable` as unavailable with no substitute value, `blocked` as a policy denial, and `success` as a versioned result that still respects `sendable=false`/`theoretical_only=true`.

- [ ] **Step 4: Run the configuration tests**

Run: `npm test -- --run tests/e2e/client-config.test.ts`.

Expected: PASS with only fake endpoint/identity values.

- [ ] **Step 5: Commit client examples**

```bash
git add deploy/clients tests/e2e/client-config.test.ts docs/runbooks/client-onboarding.md
git commit -m "docs: add state-aware MCP client examples"
```

### Task 5: Build the release, rollback, and public smoke runbook

**Files:**
- Create: `docs/runbooks/release.md`
- Create: `docs/runbooks/rollback.md`
- Create: `tests/e2e/release-gates.test.ts`
- Create: `deploy/scripts/check-release.sh`

- [ ] **Step 1: Write failing release gate tests**

Require: a non-empty backup manifest, schema validation, full unit/integration tests, no secrets in tracked files, image digest recorded, staging URL smoke returns health and a structured envelope, RiskCustoms ready false is preserved, and a write fixture has verified readback. Reject release when any gate is absent.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/e2e/release-gates.test.ts`.

Expected: FAIL until the release checklist and script exist.

- [ ] **Step 3: Implement the checks and runbooks**

`check-release.sh` must use `set -euo pipefail`, accept explicit paths/URLs, avoid printing secret values, and perform only read-only checks plus an isolated fixture smoke unless an operator separately approves a staging URL. `release.md` must list candidate build, backup, hash, deploy, health, status, write-readback, audit review, client smoke, and rollback evidence in order. `rollback.md` must specify previous image digest/config and preserve applied migrations.

- [ ] **Step 4: Run the complete non-production release gate**

Run: `npm test -- --run tests/e2e && npm run typecheck && npm run lint && npm run validate:schemas && bash deploy/scripts/check-release.sh --fixture-only`.

Expected: all tests/checks PASS; the script performs no network or production mutation in `--fixture-only` mode.

- [ ] **Step 5: Commit release gates**

```bash
git add docs/runbooks/release.md docs/runbooks/rollback.md tests/e2e/release-gates.test.ts deploy/scripts/check-release.sh
git commit -m "docs: define secure MCP release and rollback gates"
```

### Task 6: Final integration handoff verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create: `docs/runbooks/integration-handoff.md`

- [ ] **Step 1: Write the handoff checklist**

List exact commands and evidence paths for contract validation, cargo/container/domain tests, platform tests, adapter fixtures, security gates, Docker config, client examples, and release fixture smoke. State that all live endpoints remain “待适配验证” until an approved staging evidence record exists.

- [ ] **Step 2: Run the full handoff command**

Run: `npm test -- --run tests/platform tests/cargo tests/container tests/adapters tests/domains tests/e2e && npm run typecheck && npm run lint && npm run validate:schemas && git diff --check && git status --short`.

Expected: all tests PASS, static checks exit 0, diff has no whitespace errors, and the status contains only intentionally changed files.

- [ ] **Step 3: Commit the handoff record**

```bash
git add README.md AGENTS.md docs/runbooks/integration-handoff.md
git commit -m "docs: record integration handoff verification"
```
