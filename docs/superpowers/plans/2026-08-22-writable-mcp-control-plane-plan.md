# Writable MCP Module Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real, durable, fail-closed module control plane that registers only modules bundled in the current deployment inventory, previews changes, enforces two-person approval, publishes an activation policy with exact runtime readback, and rolls back through the same audited flow.

**Architecture:** Keep the existing Node/TypeScript MCP gateway and static Module Runtime v0. Add a narrow control-plane package, a separate strict SQLite control store, an immutable activation registry that gates already-mounted module handlers, authenticated loopback Admin APIs, and an AdminLTE 4 module-center UI. FastAdmin informs information architecture only; no PHP runtime, arbitrary package loader, business-data store, or production claim is introduced.

**Tech Stack:** Node.js 22, TypeScript 5.9, Zod 4, Ajv Draft 2020-12, `node:sqlite`, Vitest, native HTML/CSS/ES modules, AdminLTE 4.8.5, Bootstrap 5.3.8.

---

## Execution rules

- Work only in `/Users/autumn/.config/superpowers/worktrees/物流产品MCP/writable-mcp-control-plane` on branch `codex/writable-mcp-control-plane`.
- Before each task, read `AGENTS.md`, the task text below, and the directly affected current files. Do not read a different checkout.
- Other workers may have committed earlier tasks. Do not revert or rewrite their changes; start from current HEAD.
- Follow test-driven development: add the smallest failing test, run it and record the failure, implement the minimum behavior, rerun the focused test, then run the task regression set.
- Use `apply_patch` for edits. Do not connect production, add secrets, add customer/business fixtures, or modify `docs/contracts/**`.
- Every task ends with `git diff --check`, a focused test command, self-review, and one conventional commit.
- A successful local/fixture publish must still expose `production_eligible=false`; never rewrite it as production readiness.

## Locked design references

- Design: `docs/superpowers/specs/2026-08-22-writable-mcp-control-plane-design.md`
- RFC: `docs/rfcs/2026-08-22-writable-module-control-plane-v1.md`
- Visual reference: `/Users/autumn/.codex/generated_images/01a023ab-99c0-70c1-a4de-f0f75e5d9970/exec-cb608496-a874-401f-be3e-188aba22b047.png`
- Existing Module Runtime contract: `docs/rfcs/2026-08-21-module-runtime-agent-standard-access-v0.md`
- Security/release/rollback: `docs/runbooks/security-gates.md`, `docs/runbooks/release.md`, `docs/runbooks/rollback.md`

## Task 1: Define closed Admin contracts, deployment inventory, and activation snapshot

**Files:**

- Create: `src/logistics_mcp/control-plane/types.ts`
- Create: `src/logistics_mcp/control-plane/contracts.ts`
- Create: `src/logistics_mcp/control-plane/inventory.ts`
- Create: `src/logistics_mcp/control-plane/activation-registry.ts`
- Create: `src/logistics_mcp/control-plane/index.ts`
- Create: `schemas/admin-control/register-package-request.schema.json`
- Create: `schemas/admin-control/deployment-preview-request.schema.json`
- Create: `schemas/admin-control/approval-request.schema.json`
- Create: `schemas/admin-control/publish-request.schema.json`
- Create: `schemas/admin-control/control-envelope.schema.json`
- Create: `tests/control-plane/contracts.test.ts`
- Create: `tests/control-plane/inventory.test.ts`
- Create: `tests/control-plane/activation-registry.test.ts`

### Required design

Use these public type shapes; names may not be replaced with generic config/value records:

```ts
export interface ModuleInventoryEntry {
  readonly moduleId: string;
  readonly version: string;
  readonly riskLevel: ModuleRiskLevel;
  readonly toolNames: readonly string[];
  readonly standardRefs: readonly string[];
  readonly descriptorDigest: `sha256:${string}`;
  readonly evidenceLevel: "local_build" | "verified_release";
  readonly productionEligible: boolean;
  readonly evidenceRefs: Readonly<{
    sourceShaRef: string | null;
    artifactDigestRef: string | null;
    signatureRef: string | null;
    sbomRef: string | null;
    attestationRef: string | null;
  }>;
}

export interface ActiveModuleRef {
  readonly moduleId: string;
  readonly version: string;
  readonly descriptorDigest: `sha256:${string}`;
}

export interface ModuleActivationSnapshot {
  readonly releaseId: string | null;
  readonly revision: number;
  readonly activeModules: readonly ActiveModuleRef[];
}
```

`createModuleInventory` receives explicit mounted module/catalog data and explicit release evidence. It canonicalizes sorted object keys and sorted set-like arrays, then computes SHA-256. It must not read cwd, files, environment variables, URLs, or Markdown. Reject duplicate module IDs, duplicate tool owners, malformed digests, `productionEligible=true` without `verified_release`, and incomplete verified evidence.

`ModuleActivationRegistry` starts with all inventory entries active at release `null`, revision `0`. `replace(next)` validates exact inventory refs, duplicate refs, nonnegative safe revision, and monotonic revision. It replaces one frozen snapshot; `snapshot()` never exposes mutable arrays. `isActive(moduleId, version)` only checks the fixed snapshot.

Admin request schemas use Zod `.strict()` at runtime and checked-in Draft 2020-12 JSON Schemas. Prohibit identity, URL/path/source/secret fields by construction. The response envelope has the existing five status strings and closed `data`, `reason_codes`, `trace_id` fields.

### TDD steps

- [ ] Add contract tests proving every JSON Schema declares Draft 2020-12, root `additionalProperties:false`, rejects identity/URL/path/secret extras, and accepts only the documented request union.
- [ ] Run `npx vitest run tests/control-plane/contracts.test.ts`; expect failure because contracts and schema files do not exist.
- [ ] Implement the strict Zod contracts and static JSON Schemas; rerun until the contract test passes.
- [ ] Add inventory tests for deterministic digest under input reordering, duplicate module/tool rejection, evidence-level truthfulness, and no filesystem/environment inputs.
- [ ] Run `npx vitest run tests/control-plane/inventory.test.ts`; expect missing-module failure.
- [ ] Implement canonical inventory construction and immutable returned entries; rerun until green.
- [ ] Add activation tests for default-all-active, atomic replacement, exact descriptor match, duplicate/unknown rejection, stale revision rejection, and mutation resistance.
- [ ] Run `npx vitest run tests/control-plane/activation-registry.test.ts`; expect missing-module failure.
- [ ] Implement the activation registry; rerun until green.
- [ ] Run `npx vitest run tests/control-plane --pool=forks --no-file-parallelism --maxWorkers=1`.
- [ ] Run `npm run typecheck`, `npm run lint`, and `git diff --check`.
- [ ] Commit with `feat: define module control plane contracts`.

## Task 2: Implement the strict SQLite module control store

**Files:**

- Create: `src/logistics_mcp/control-plane/repository.ts`
- Create: `src/logistics_mcp/control-plane/sqlite-control-store.ts`
- Update: `src/logistics_mcp/control-plane/index.ts`
- Create: `tests/control-plane/sqlite-control-store.test.ts`

### Required design

The store is a separate file-backed database with `durability="durable"`. It requires a regular file, forces `0600`, rejects symlinks/non-files/non-writable paths, enables foreign keys, WAL, FULL synchronous, trusted_schema off, busy timeout, and quick check. Production does not accept `:memory:`. Tests use temporary regular files.

Schema version 1 contains only strict narrow tables:

```text
module_registrations
module_previews
module_approvals
module_releases
module_readbacks
module_control_idempotency
module_control_events
```

Store JSON columns have `json_valid` checks. IDs and status fields have CHECK constraints. Release revision is unique and strictly increasing. Foreign keys connect preview→approval→release→readback. Unknown `user_version`, unexpected columns/tables/index drift, corruption, or failed quick check closes the DB and fails closed.

Expose use-case-oriented repository methods, not raw SQL or `put(key,value)`. Required operations:

```ts
health(): Promise<{ readonly ready: boolean }>;
close(): Promise<void>;
registerModule(request: RegisterModuleRecordRequest): Promise<RegistrationWriteResult>;
createPreview(request: CreatePreviewRecordRequest): Promise<PreviewWriteResult>;
decideApproval(request: DecideApprovalRecordRequest): Promise<ApprovalWriteResult>;
publishRelease(request: PublishReleaseRecordRequest): Promise<ReleaseWriteResult>;
recordReadback(request: RecordReadbackRequest): Promise<ReadbackWriteResult>;
completeIdempotency(request: CompleteControlIdempotencyRequest): Promise<ControlIdempotencyRecord>;
getControlState(): Promise<ModuleControlState>;
getActiveRelease(): Promise<ModuleReleaseRecord | null>;
getPendingRelease(): Promise<ModuleReleaseRecord | null>;
```

Every mutation takes server-created actor/context metadata, canonical request hash, action, idempotency key, and redacted event payload. Same action/key/hash replays; same action/key/different hash is a typed conflict. Register, preview, and approval store the complete response and event in their domain transaction. Publish reserves first, then atomically writes the release/event and advances idempotency to `domain_committed` with the immutable release ID. Activation/readback advances it to `completed`. A retry that finds `domain_committed` resumes readback for that exact release and never creates another release. Expired completed keys may be pruned only inside a later transaction; never prune `reserved`/`domain_committed` records or weaken release history.

Publish uses compare-and-set on expected base release/revision and writes release status `published_pending_readback`. `recordReadback` can move it to `active_verified` only for exact release/revision/module refs; mismatch records `manual_review` without deleting the release. Startup must reconcile the newest `published_pending_readback` release before serving Admin or MCP calls.

### TDD steps

- [ ] Add tests for secure new-file creation, schema/tables/indexes, `0600`, WAL, reopen persistence, health, idempotent close, and no business columns.
- [ ] Run `npx vitest run tests/control-plane/sqlite-control-store.test.ts`; expect missing-store failure.
- [ ] Implement secure initialization and schema verification; rerun the focused cases.
- [ ] Add tests for exact register/preview/approval/publish/readback persistence and chronological redacted events.
- [ ] Add tests for idempotent replay, conflict, self-consistent transaction rollback, base revision CAS, duplicate approval, unknown references, readback mismatch, and restart state recovery.
- [ ] Add tests that tamper `user_version`, table layout, JSON, status, and symlink path; each must fail closed with a stable typed error and no leaked SQL/value.
- [ ] Implement the narrow repository methods and transactions; do not introduce a generic write API.
- [ ] Run `npx vitest run tests/control-plane/sqlite-control-store.test.ts --pool=forks --no-file-parallelism --maxWorkers=1`.
- [ ] Run `npx vitest run tests/platform/sqlite-production-store.test.ts tests/control-plane/sqlite-control-store.test.ts --pool=forks --no-file-parallelism --maxWorkers=1`.
- [ ] Run `npm run typecheck`, `npm run lint`, and `git diff --check`.
- [ ] Commit with `feat: add durable module control store`.

## Task 3: Implement the module control service and four-eyes state machine

**Files:**

- Create: `src/logistics_mcp/control-plane/service.ts`
- Create: `src/logistics_mcp/control-plane/errors.ts`
- Update: `src/logistics_mcp/control-plane/index.ts`
- Create: `tests/control-plane/fake-control-repository.ts`
- Create: `tests/control-plane/service.test.ts`

### Required design

`ModuleControlService` is the only domain entry used by HTTP. Inject inventory, repository, activation registry, clock, ID generator, preview TTL, and runtime readback function. Do not read process environment inside the service.

Public methods:

```ts
getState(context: ExecutionContext): Promise<ControlEnvelope>;
registerPackage(context: ExecutionContext, request: RegisterPackageRequest, meta: WriteMeta): Promise<ControlEnvelope>;
createDeploymentPreview(context: ExecutionContext, request: DeploymentPreviewRequest, meta: WriteMeta): Promise<ControlEnvelope>;
decideApproval(context: ExecutionContext, request: ApprovalRequest, meta: WriteMeta): Promise<ControlEnvelope>;
publish(context: ExecutionContext, request: PublishRequest, meta: WriteMeta): Promise<ControlEnvelope>;
```

`WriteMeta` contains only server-created `idempotencyKey`, `requestHash`, and `traceId`. Authorization is rechecked in the service: role list contains admin, scope contains `platform:admin`, and context tenant equals injected admin tenant. Request bodies never supply context.

Registration exact-matches inventory ID/version/digest and writes the inventory-owned evidence. Preview `change` requires the full desired active set. Preview `rollback` resolves the target verified release server-side and copies its active set. Both pin current base release/revision and inventory descriptors, create a redacted diff, enforce at least one active module, and prohibit duplicate/unknown/unregistered refs.

Approval requires a different actor from preview creator. Publish revalidates nonexpired/unconsumed preview, approved decision, exact approval ID, base CAS, and current inventory. After repository publish, call `activationRegistry.replace`, perform exact runtime readback, and record readback. Return:

- `success` only when store, activation, and exact readback agree;
- `manual_review` when durable publish exists but activation/readback is unknown or mismatched;
- `blocked` for auth, self-approval, stale/consumed preview, inventory drift, idempotency conflict, or base conflict;
- `needs_input` for schema-valid but semantically incomplete desired changes;
- `unavailable` for unavailable store/inventory/readback dependency before a domain write.

Do not catch a post-commit unknown result and report `unavailable`; that would hide a possible write.

### TDD steps

- [ ] Build a narrow fake repository that records method calls and can inject failures; it must implement the same interface and not duplicate service rules.
- [ ] Add failing tests for role/scope/admin-tenant denial before repository calls and for exact inventory registration/readback.
- [ ] Run `npx vitest run tests/control-plane/service.test.ts`; expect missing-service failure.
- [ ] Implement authorization, stable errors, server ID/time injection, and registration; rerun focused tests.
- [ ] Add failing tests for change preview, rollback preview from a verified release, duplicate/unknown/unregistered refs, redacted diff, TTL, and base pinning.
- [ ] Implement preview behavior; rerun.
- [ ] Add failing tests for self-approval, second decision, reject, expired/consumed preview, approval actor persistence, and idempotent replay/conflict.
- [ ] Implement approval behavior; rerun.
- [ ] Add failing tests for publish success, active snapshot exactness, readback mismatch, activation exception after commit, base race, inventory drift, and rollback creating a new revision without mutating the target.
- [ ] Implement publish/readback behavior and ensure unknown post-commit results are `manual_review`.
- [ ] Run `npx vitest run tests/control-plane --pool=forks --no-file-parallelism --maxWorkers=1`.
- [ ] Run `npm run typecheck`, `npm run lint`, and `git diff --check`.
- [ ] Commit with `feat: implement controlled module releases`.

## Task 4: Add authenticated loopback Admin Control API

**Files:**

- Create: `src/logistics_mcp/server/admin-control-api.ts`
- Update: `src/logistics_mcp/server/admin-static.ts`
- Update: `src/logistics_mcp/server/index.ts`
- Create: `tests/platform/admin-control-api.test.ts`
- Update: `tests/platform/admin-static.test.ts`

### Required design

`createAdminControlApiHandler` receives the service, token authenticator, allowed admin tenant, exact allowed origins/hosts, `allowLoopbackHttp`, max body bytes, and clock. It does not read global env. Its router recognizes only:

```text
GET  /admin/api/v1/control/state
POST /admin/api/v1/control/packages/register
POST /admin/api/v1/control/deployments/preview
POST /admin/api/v1/control/approvals
POST /admin/api/v1/control/deployments/publish
```

`admin-static.ts` delegates recognized control routes before its static 404. Static assets and redacted snapshot behavior stay compatible.

Security order for POST: loopback/Host/Origin → method/path → Content-Type → declared and streamed body size → Bearer extraction → verifier → `parseExecutionContext` → role/scope/admin tenant → `Idempotency-Key` → strict JSON schema → service. GET state still requires Bearer and auth but no idempotency key. Duplicate Authorization headers, query tokens, cookies as auth, missing exact Origin for writes, non-JSON, invalid length, malformed JSON, or unknown fields fail before service invocation.

HTTP mapping:

```text
success       200 (or 201 for first registration/release creation)
needs_input   400
blocked       403; authentication failure 401 with WWW-Authenticate: Bearer
manual_review 409
unavailable   503
body too large 413
wrong method  405 with exact Allow
unknown route 404
```

Every response uses existing Admin security headers and `Cache-Control:no-store`. Never echo auth input, raw parser error, stack, SQL, request body, or verifier message.

### TDD steps

- [ ] Add a fake service spy and failing happy-path tests for all five routes, including server-bound context and idempotency metadata.
- [ ] Run `npx vitest run tests/platform/admin-control-api.test.ts`; expect missing-handler failure.
- [ ] Implement path/method dispatch and success/status mapping; rerun focused tests.
- [ ] Add a table-driven security test for remote address, Host, Origin, Content-Type, body size, malformed JSON, missing/duplicate Bearer, expired claims, role, scope, tenant, idempotency key, unknown fields, identity fields, URL/path/secret fields, and unknown routes. Assert zero service calls on every rejection.
- [ ] Implement ordered fail-closed checks and redacted errors; rerun.
- [ ] Update static handler tests to serve any newly allowlisted local asset and delegate control routes without weakening the original four-asset assertions until Task 6 changes the build list.
- [ ] Run `npx vitest run tests/platform/admin-static.test.ts tests/platform/admin-control-api.test.ts --pool=forks --no-file-parallelism --maxWorkers=1`.
- [ ] Run `npx vitest run tests/e2e/security-gates.test.ts tests/platform/http-security.test.ts`.
- [ ] Run `npm run typecheck`, `npm run lint`, and `git diff --check`.
- [ ] Commit with `feat: expose authenticated admin control api`.

## Task 5: Wire inventory, startup recovery, activation gating, and fixture identities

**Files:**

- Update: `src/logistics_mcp/server/composition.ts`
- Update: `src/logistics_mcp/server/tool-registry.ts`
- Update: `src/logistics_mcp/server/start.ts`
- Update: `src/logistics_mcp/module-runtime/types.ts` only if a typed inventory projection is required; do not change `lifecycle:"static"`
- Update: `src/logistics_mcp/modules/index.ts` if an explicit trusted module list export is required
- Update: `package.json`
- Create: `tests/control-plane/runtime-activation.test.ts`
- Update: `tests/e2e/composition-mode.test.ts`
- Update: `tests/e2e/runtime-smoke.test.ts`
- Update: `tests/platform/tool-registry.test.ts`

### Required design

Composition accepts an optional `ModuleActivationRegistry`. After ModuleHost mounts and module definitions are built, wrap only definitions carrying `moduleId/moduleVersion`. The wrapper checks the immutable activation snapshot at request start. Disabled module handlers return a valid domain outcome:

```ts
{
  status: "unavailable",
  data: null,
  blockers: [{
    code: "module_disabled_by_release",
    message: "The module is disabled by the active release.",
    severity: "error"
  }]
}
```

The definition remains in tools/list with unchanged name, contract, RBAC, version, risk and standards. Non-module legacy definitions are unchanged. Re-enable restores the original handler without rebuilding the composition.

Refactor startup into a narrow runtime assembly that creates, in this order:

1. token verifier(s);
2. composition and its mounted static module inventory plus default-all-active registry, without listening;
3. explicit control store if `MCP_CONTROL_DB_PATH` is configured;
4. newest `published_pending_readback` release reconciled against that exact inventory, then active verified release restored into the registry;
5. control service and Admin API using the same inventory/registry/store;
6. HTTP server, which starts listening only after reconciliation;
7. one close path that closes HTTP, composition and the separate control store exactly once.

If control store/inventory/admin config is missing, existing MCP service can still run, but Admin control state returns `unavailable` and no writes occur. Production Admin writes additionally require `MCP_ADMIN_TENANT_ID`. Enabling Admin UI does not make MCP readiness green.

Fixture mode adds a separate `MCP_FIXTURE_APPROVER_TOKEN` only to the loopback Admin authenticator. It maps to actor `local_approver`, admin role, `platform:admin`, same fixture tenant, distinct session/client IDs. The existing `MCP_FIXTURE_TOKEN` remains applicant `local_operator`; production verifier never accepts either as a special case.

`npm run start:fixture` configures a repository-local ignored `.runtime/module-control.sqlite`, creates the parent with `0700` only in fixture startup, and sets both fixture tokens. `.runtime/` is added to `.gitignore`; no database is committed.

### TDD steps

- [ ] Add failing tests proving disabled module calls return unavailable while tools/list metadata remains, non-module tools are unaffected, and re-enable restores behavior.
- [ ] Run `npx vitest run tests/control-plane/runtime-activation.test.ts`; expect missing integration failure.
- [ ] Implement the definition wrapper and composition injection; rerun.
- [ ] Add failing startup tests for no-release default compatibility, recovery of active release from a reopened SQLite file, exact readback, missing control store fail-closed Admin state, and production admin tenant requirement.
- [ ] Implement runtime assembly and restoration before listen; rerun.
- [ ] Add failing fixture identity tests proving applicant cannot self-approve, approver token is distinct, both remain loopback-only, and production verifier path has no fixture branch.
- [ ] Implement fixture Admin authenticator and update `start:fixture`/`.gitignore`.
- [ ] Extend runtime smoke to complete API register→preview with applicant→approve with approver→publish/readback→rollback preview; assert `production_eligible=false` and persistence after process restart.
- [ ] Run `npx vitest run tests/control-plane/runtime-activation.test.ts tests/e2e/composition-mode.test.ts tests/e2e/runtime-smoke.test.ts tests/platform/tool-registry.test.ts --pool=forks --no-file-parallelism --maxWorkers=1 --testTimeout=15000`.
- [ ] Run `npm run typecheck`, `npm run lint`, and `git diff --check`.
- [ ] Commit with `feat: activate bundled modules through releases`.

## Task 6: Build the AdminLTE module-center UI against the real API

**Files:**

- Update: `package.json`
- Update: `package-lock.json`
- Update: `deploy/scripts/build.mjs`
- Update: `apps/admin/index.html`
- Update: `apps/admin/app.js`
- Create: `apps/admin/control-plane.js`
- Update: `apps/admin/styles.css`
- Update: `apps/admin/fixture-data.js` only for non-authoritative display compatibility; do not add fake control writes
- Update: `apps/admin/self-check.mjs`
- Update: `apps/admin/README.md`
- Update: `tests/platform/admin-static.test.ts`
- Create: `tests/platform/admin-control-ui.test.ts`

### Required design

Pin `admin-lte@4.8.5` and `bootstrap@5.3.8`. Copy only self-hosted required AdminLTE assets into `dist/admin/vendor`; no CDN or external fonts. Extend the static allowlist explicitly for `control-plane.js` and the vendor files. Keep CSP `script-src 'self'; style-src 'self'` and no inline style/script.

Implement the visual reference as a native ES-module screen, preserving existing read-only views. Main navigation becomes:

```text
总览 / 模块中心 / Agent 接入 / 适配器状态 / 审批与发布 / 审计日志
```

The module-center screen must include:

- fixed warning: `报价、关务与客户数据仍由外部权威系统管理`;
- release rail: 登记制品→生成预览→双人审批→发布读回;
- status cards: 已登记、待审批、当前激活;
- table: module name, version, risk, abbreviated descriptor digest, registration state, runtime state, desired enable switch;
- selected-module inspector using only opaque/evidence-level display, never URLs, email, raw refs, source path, token, or secret;
- preview diff, validation results, creator/approver distinction, release trail and rollback target;
- actions: 保存草稿 (browser memory only), 生成预览, 提交审批, 发布并读回, 回滚到上一已验证版本.

The bearer exists only in a module-scoped JS variable. Never write it to storage, DOM text, URL, error report, or console. A visible identity dialog uses password input. `?fixture=1` may offer two clearly labeled local demo identity buttons with hardcoded non-secret fixture tokens; those buttons must never appear on the live/production query path.

Switches edit a desired draft only. Runtime badges update only after API publish returns exact verified readback. On `manual_review`, preserve the server state, show the reason, and force refresh; never optimistically mark active. Adapter cards keep `待适配验证`/`未获生产资格`.

Use the concept's true-white/light-gray palette, navy sidebar, blue accent, table-driven open layout, compact typography and restrained semantic colors. Do not add gradients, glass, fake charts, email/Git/registry URLs, production success, shipment counts, prices, or marketing copy. Maintain keyboard focus, skip link, `aria-live`, text status, reduced motion and mobile horizontal table access.

### TDD and visual steps

- [ ] Add pure-function tests for `validateControlState`, digest/reference redaction, release-stage derivation, desired-draft diff, action enablement, fixture identity visibility, and no token persistence API usage.
- [ ] Run `npx vitest run tests/platform/admin-control-ui.test.ts`; expect missing-module failure.
- [ ] Implement `control-plane.js` model/API client without DOM rendering; rerun.
- [ ] Update HTML/nav/imports and self-check assertions; run `node apps/admin/self-check.mjs` and expect failures before the new render wiring.
- [ ] Implement the module-center render and interactions in focused functions; keep `app.js` as composition glue and do not duplicate escaping/display helpers.
- [ ] Add AdminLTE/Bootstrap dependencies and explicit build/static asset copying. Assert build fails if any allowlisted asset is missing and no unexpected node_modules file is served.
- [ ] Run `node --check apps/admin/app.js`, `node --check apps/admin/control-plane.js`, `node --check apps/admin/fixture-data.js`, and `node apps/admin/self-check.mjs`.
- [ ] Run `npx vitest run tests/platform/admin-control-ui.test.ts tests/platform/admin-static.test.ts tests/e2e/release-gates.test.ts`.
- [ ] Run `npm run build` and inspect `dist/admin` for only expected application/vendor files.
- [ ] Start fixture runtime and use the in-app Browser first. Verify 1440×900: bind applicant, register, edit desired set, preview; switch approver, approve; switch applicant/admin, publish/readback; generate rollback preview and repeat approval/publish.
- [ ] Verify mobile viewport has no clipped primary controls and the table remains keyboard-scrollable.
- [ ] Capture the rendered 1440×900 screenshot. Use `view_image` on both the visual reference and rendered screenshot. Record at least five comparisons: shell/layout, typography, palette, table/inspector density, release workflow/status semantics. Fix every material mismatch.
- [ ] Run the above-the-fold copy diff; no unapproved production claim, email, URL, price, shipment metric, decorative badge, gradient, or secret may remain.
- [ ] Run `npm run typecheck`, `npm run lint`, and `git diff --check`.
- [ ] Commit with `feat: add writable module center console`.

## Task 7: Close security, release, rollback, and full-repository evidence

**Files:**

- Update: `docs/product/admin-console.md`
- Update: `docs/runbooks/security-gates.md`
- Update: `docs/runbooks/release.md`
- Update: `docs/runbooks/rollback.md`
- Update: `docs/runbooks/integration-handoff.md` only where the Admin control-plane handoff changed
- Update: `README.md`
- Update: `deploy/env.example`
- Update: `deploy/compose.yml` if and only if the control DB mount/config is required for the documented local/production assembly
- Update: `tests/e2e/security-gates.test.ts`
- Update: `tests/e2e/release-gates.test.ts`
- Create: `tests/e2e/module-control-plane.test.ts`

### Required design

Documentation must replace the old “write APIs not connected” statement with exact v1 truth:

- module control writes are implemented and verified locally/fixture;
- only current deployment inventory can be registered;
- activation is a handler policy for already-mounted static modules, not arbitrary code hot-plug;
- business adapters and production qualifications remain unchanged;
- production Admin still requires an enterprise identity path, admin tenant, durable control DB, exact Origin/Host and verified release evidence;
- full production deployment is not performed by this work.

Release runbook must record control DB backup, active release/revision, inventory digest set, Admin auth/approval evidence, runtime readback, and rollback target. Rollback must use a new approved release and preserve migrations/history. Security gates must cover token memory handling, fixture identity exclusion from production, no arbitrary artifact fields, self-approval rejection, unknown-result manual review and redacted events.

The e2e test must use a temporary SQLite file and real HTTP server to prove:

1. unauthenticated writes are zero-effect;
2. package registration is exact inventory-only and durable;
3. creator cannot approve;
4. distinct approver can approve;
5. publish changes a bundled module from callable to unavailable while retaining tools/list visibility;
6. readback records exact release/revision/module refs;
7. same idempotency key replays and conflicting hash blocks;
8. rollback preview/approval/publish restores behavior as a new revision;
9. restart restores the active release and event history;
10. responses/events contain no token, URL, path, email, business data, price, address or raw secret.

### Verification steps

- [ ] Add/extend e2e tests first and run `npx vitest run tests/e2e/module-control-plane.test.ts tests/e2e/security-gates.test.ts tests/e2e/release-gates.test.ts`; confirm the intended doc/config gaps fail.
- [ ] Update docs/config with exact current behavior and complete the tests without adding production calls.
- [ ] Run `npm test`; expected final result is all test files and tests passing with no skipped new control-plane cases.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run validate:schemas`.
- [ ] Run `npm run validate:agent-standards`.
- [ ] Run `npm run build:agent-pack`.
- [ ] Run `npm run validate:agent-adapters`.
- [ ] Run `npm run build`.
- [ ] Run `npm run verify:runtime`.
- [ ] Run `bash deploy/scripts/check-release.sh --fixture-only`.
- [ ] Run `git diff --check`.
- [ ] Run secret/PII scan over changed files and fixtures using targeted `rg`; review every match rather than treating pattern absence as sole proof.
- [ ] Inspect `git status --short`, `git diff --stat 81b5ca83aeca65e3b44ffc06c50e368d948e4f09..HEAD`, and the complete diff for unrelated files.
- [ ] Commit with `docs: document writable module control plane`.

## Task 8: Independent final review and branch handoff

**Files:** none unless review findings require a focused fix commit.

- [ ] Dispatch a fresh gpt-5.6-luna Max spec reviewer with the full design, RFC, this plan, base SHA, current HEAD, and actual implementer reports. Require file/line evidence and do not trust reports.
- [ ] If the spec reviewer finds an issue, dispatch the responsible implementer with only that finding, add a regression test, commit the fix, and repeat spec review.
- [ ] After spec approval, dispatch a fresh gpt-5.6-luna Max code-quality/security reviewer over the complete base..HEAD range.
- [ ] Fix every Critical/Important issue with TDD and repeat quality review until `Ready to merge: Yes`.
- [ ] Rerun the entire Task 7 verification suite after the last fix; earlier green output is not final evidence.
- [ ] Confirm the original main checkout still has its pre-existing uncommitted files untouched.
- [ ] Report branch, HEAD, commits, actual command outputs, visual concept/render paths, verified local behavior, and explicit production/unverified boundaries.
- [ ] Do not merge to `main`, push, deploy, delete branches, or remove worktrees unless the user separately requests that action.
