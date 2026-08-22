# Writable MCP Module Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real, durable, fail-closed local/fixture module control plane that registers only modules bundled in the current deployment inventory, previews changes, enforces two-person approval, publishes an activation policy with exact runtime readback, reconciles unknown results, and rolls back through the same audited flow while production Admin writes remain blocked in v1.

**Architecture:** Keep the existing Node/TypeScript MCP gateway and static Module Runtime v0. Add a narrow control-plane package, a separate strict single-process SQLite control store with an external immutable identity marker bound to `MCP_INSTANCE_ID`, an immutable activation registry that gates already-mounted module handlers, fixture-authenticated loopback Admin APIs, and an AdminLTE 4 module-center UI. FastAdmin informs information architecture only; no PHP runtime, arbitrary package loader, verified-release claim, business-data store, production Admin write, or code hot-plug is introduced.

**Tech Stack:** Node.js 22, TypeScript 5.9, Zod 4, Ajv Draft 2020-12, `node:sqlite`, Vitest, native HTML/CSS/ES modules, AdminLTE 4.8.5, Bootstrap 5.3.8.

---

## Execution rules

- Work only in `/Users/autumn/.config/superpowers/worktrees/物流产品MCP/writable-mcp-control-plane` on branch `codex/writable-mcp-control-plane`.
- Before each task, read `AGENTS.md`, the task text below, and the directly affected current files. Do not read a different checkout.
- Other workers may have committed earlier tasks. Do not revert or rewrite their changes; start from current HEAD.
- Follow test-driven development: add the smallest failing test, run it and record the failure, implement the minimum behavior, rerun the focused test, then run the task regression set.
- Use `apply_patch` for edits. Do not connect production, add secrets, add customer/business fixtures, or modify `docs/contracts/**`.
- Every task ends with `git diff --check`, a focused test command, self-review, and one conventional commit.
- A successful local/fixture publish must expose `evidence_level=local_build` and `production_eligible=false`; v1 rejects `verified_release` and every production Admin POST.
- `MCP_ADMIN_CONTROL_ENABLED` is never a bypass. After explicit identity initialization, `false` or
  missing fails before listen; only a never-initialized fixed state directory with no marker/DB and
  explicit `MCP_LEGACY_STATIC_MODE=true` may use legacy static-all-active.
- This specification revision is documentation-only. Do not modify Task 1 `src/`, `schemas/`, or
  `tests/` files while another worker is reviewing them.

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
- Create: `schemas/admin-control/reconcile-request.schema.json`
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
  readonly evidenceLevel: "local_build";
  readonly productionEligible: false;
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

`createModuleInventory` receives explicit mounted module/catalog data and explicit local build evidence. The canonical descriptor covers module ID/version/risk/lifecycle/required and optional capabilities/module standards plus each tool's owner/name/permission/kind/risk/input schema ID/output schema ID/standard refs. It canonicalizes object keys, sorts set-like arrays by stable keys, sorts tools by name, then computes the descriptor digest as `sha256:<64 lowercase hex>`. It must not read cwd, files, environment variables, URLs, or Markdown. Reject duplicate module IDs, duplicate tool owners, malformed digests, any `verified_release`/`productionEligible=true` input, and incomplete tool contracts. Any visible contract change must change the digest. The request/preview control hashes are separate: RFC 8785/JCS UTF-8 + SHA-256 over `MCP-CONTROL-HASH\0v1\0<request|preview>\0<schema_version>\0<JCS bytes>`, formatted as `mcp-control-hash/v1/<domain>/sha256:<64 lowercase hex>`; set-like arrays are stably sorted, order-semantic arrays retain order, and schema/domain changes must change the hash.

`ModuleActivationRegistry` starts with all inventory entries active at release `null`, revision `0`. `replace(next)` validates exact inventory refs, duplicate refs, nonnegative safe revision, and monotonic revision. It replaces one frozen snapshot; `snapshot()` never exposes mutable arrays. `isActive(moduleId, version)` only checks the fixed snapshot.

Admin request schemas use Zod `.strict()` at runtime and checked-in Draft 2020-12 JSON Schemas with `ADMIN_CONTROL_SCHEMA_VERSION="2026-08-22.v1"`. Exact request shapes are register `(schema_version,module_id,version,descriptor_digest)`, preview change `(schema_version,intent,desired_modules)`, preview rollback `(schema_version,intent,target_release_id)`, approval `(schema_version,preview_ref,decision,reason_code)`, publish `(schema_version,preview_ref,approval_id)`, and reconcile `(schema_version,release_id)`. Prohibit identity, URL/path/source/secret fields by construction.

The independent Admin envelope root is closed and contains `schema_version`, server `request_id`, `trace_id`, `audit_id`, existing five status strings, `reason_codes`, a closed readback object, and `data`. `trace_id` never replaces `audit_id`. `readback` is `{status:"not_applicable"|"pending"|"verified"|"mismatch"|"unknown",release_id:string|null,revision:integer|null}`; `verified` here means runtime activation exact readback only, never artifact signature or production qualification. `data` is null or a closed discriminated union with `kind=control_state|registration|preview|approval|release|reconciliation`; generic `z.record`/unknown data is forbidden.

### TDD steps

- [ ] Add contract tests proving every JSON Schema declares Draft 2020-12, root `additionalProperties:false`, rejects identity/URL/path/secret extras, and accepts only the documented request union.
- [ ] Run `npx vitest run tests/control-plane/contracts.test.ts`; expect failure because contracts and schema files do not exist.
- [ ] Implement the strict Zod contracts and static JSON Schemas; rerun until the contract test passes.
- [ ] Add inventory tests for deterministic digest under input reordering, digest changes for every module/tool contract field, duplicate module/tool rejection, local-only evidence truthfulness, and no filesystem/environment inputs.
- [ ] Keep Task 1's existing descriptor/inventory implementation scope unchanged in this revision; record the follow-up contract tests for request/preview canonical hashes: cross-restart stability, object-key order, semantic collection input order, preserved order-semantic arrays, schema-version separation, domain separation, and explicit distinction from `descriptorDigest`. If the shared helper is not owned by Task 1, implement it in Task 2/3 before those tests are marked complete.
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

The store is a separate file-backed database with `durability="durable"`. Startup always resolves a fixed absolute host anchor `MCP_INSTANCE_STATE_DIR`; fixture fixes it to `<application-root>/.runtime/mcp-instance-state`, and production fixes it in the service unit/host mount. The DB and external marker are derived fixed paths `<state_dir>/control.sqlite` and `<state_dir>/control-identity.json`; path overrides are rejected. New-file creation is exposed only through an explicit initializer; normal runtime open requires an existing v1 database and never silently recreates a missing enabled store. The initializer atomically installs a new state directory containing both files. The marker is one UTF-8/JCS JSON object plus LF with exactly `marker_format:"mcp-control-identity/v1"`, `instance_id`, absolute `control_db_path`, random `control_db_id=db_<32-lower-hex>`, and `schema_version:1`. The DB singleton `control_identity` row must match every marker field. The directory is `0700`, marker `0400`, DB `0600`; target existence, symlink, or replacement is rejected. The initializer uses staging + fsync + one directory rename; normal runtime never creates, repairs, or replaces either file.

Runtime open requires a regular non-symlink DB and marker, exact `MCP_INSTANCE_ID`, exact derived paths, matching `control_identity`, v1 schema and `MCP_ADMIN_CONTROL_ENABLED=true`. After initialization, false or missing enabled is a startup error even with zero releases. A marker/DB mismatch, missing marker, missing DB, new empty DB, corrupt identity, schema drift, or lock conflict fails closed before listen. With the fixed state-directory anchor present, an absent target directory and absent fixed files may select legacy only under explicit `MCP_LEGACY_STATIC_MODE=true`; if the anchor configuration itself is absent, startup fails. The flag is rejected once initialization exists. Deleting enabled/path/instance environment variables cannot hide the fixed marker. `:memory:` is forbidden. Tests use temporary regular files.

Schema version 1 contains only strict narrow tables:

```text
module_registrations
module_previews
module_approvals
module_releases
module_readbacks
module_control_idempotency
module_control_events
control_identity
```

`control_identity` is a fixed singleton metadata table, not a generic key-value or business table. Store JSON columns have `json_valid` checks. IDs and status fields have CHECK constraints. Every domain/idempotency key includes explicit `tenant_id`, even though v1 allows one configured management tenant. Release revision is unique and strictly increasing inside that tenant. Approval is append-only/final, uniquely bound to preview canonical hash/base revision/inventory digest set/expiry, and publish atomically consumes preview plus approval. Foreign keys connect preview→approval→release→readback. Unknown `user_version`, unexpected columns/tables/index drift, corruption, failed quick check, or lock conflict closes the DB and fails closed.

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
getNewestUnresolvedRelease(): Promise<ModuleReleaseRecord | null>;
```

Every mutation takes server-created actor/context metadata, canonical request hash, action, idempotency key, and redacted event payload. Same action/key/hash replays; same action/key/different hash is a typed conflict. Register, preview, and approval store the complete response and event in their domain transaction. Publish reserves first, then atomically writes the release/event and advances idempotency to `domain_committed` with the immutable release ID. Activation/readback advances it to `completed`. A retry that finds `domain_committed` resumes readback for that exact release and never creates another release. Expired completed keys may be pruned only inside a later transaction; never prune `reserved`/`domain_committed` records or weaken release history.

Publish uses compare-and-set on expected base release/revision and writes release status `published_pending_readback`, but rejects any newest unresolved release (`published_pending_readback` or `manual_review`) before creating a new release. `recordReadback` can move it to `active_verified` only for exact release/revision/module refs; `active_verified` means runtime exact readback only, not artifact signature or production qualification. Mismatch/unknown records `manual_review` without deleting the release. Startup performs one automatic exact readback for the newest `published_pending_readback`; it does not retry an existing `manual_review`. Only operator `reconcile` may retry either fixed unresolved release, and it never creates a release or changes desired refs.

### TDD steps

- [ ] Add tests for explicit secure initialization, atomic DB+marker installation, marker format/permissions, runtime missing-file rejection, `control_identity` schema/tables/indexes, `0600`, WAL/exclusive lock, second-store denial, reopen persistence, health, idempotent close, explicit tenant keys, and no business columns.
- [ ] Run `npx vitest run tests/control-plane/sqlite-control-store.test.ts`; expect missing-store failure.
- [ ] Implement secure initialization and schema verification; rerun the focused cases.
- [ ] Add tests for exact register/preview/approval/publish/readback persistence and chronological redacted events.
- [ ] Add tests for idempotent replay, tenant-scoped conflict, self-consistent transaction rollback, base revision CAS, immutable reject/approve terminal decision, approval hash/expiry/consume binding, unknown references, readback mismatch, and restart state recovery. Cover request/preview canonical hash stability across restart, object-key reorder, semantic collection reorder vs order-semantic arrays, schema-version separation, and request-vs-preview domain separation.
- [ ] Add reconciliation tests proving startup automatically exact-reads `published_pending_readback` once, does not auto-retry `manual_review`, newest unresolved blocks a new publish, operator reconcile reuses the same release/revision, and reconcile never creates a second release.
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
reconcile(context: ExecutionContext, request: ReconcileRequest, meta: WriteMeta): Promise<ControlEnvelope>;
```

`WriteMeta` contains only server-created `idempotencyKey`, `requestHash`, `requestId`, `traceId`, and `auditId`. Authorization is rechecked in the service: `context.role === "admin"`, roles contains admin, scope contains `platform:admin`, and context tenant equals the single injected admin tenant. Request bodies never supply context.

Registration exact-matches inventory ID/version/digest and writes the inventory-owned local-build evidence. Preview `change` requires the full desired active set. Preview `rollback` resolves a target whose current runtime activation snapshot has an exact readback server-side and copies its active set; `active_verified` means runtime exact readback only, not artifact signature or production qualification. Both pin current base release/revision and inventory descriptors, create a redacted diff, enforce at least one active module, and prohibit duplicate/unknown/unregistered refs.

Approval requires a different actor from preview creator and atomically writes one terminal decision bound to tenant, preview canonical hash, base release/revision, inventory digest set and expiry. Reject cannot be overwritten. Publish first rejects any newest unresolved release (`published_pending_readback|manual_review`), then revalidates nonexpired/unconsumed preview, approved decision, exact approval ID/hash, base CAS, and current inventory, and atomically consumes preview+approval. After repository publish, call `activationRegistry.replace`, perform exact runtime readback, and record readback. Startup auto-reconciles only the newest `published_pending_readback` once; it does not retry `manual_review`. Operator `reconcile` accepts only the newest fixed pending/manual-review release and repeats activation/readback for that release without creating another release or changing desired refs. Return:

- `success` only when store, activation, and exact readback agree;
- `manual_review` when durable publish exists but activation/readback is unknown or mismatched;
- `blocked` for auth, self-approval, stale/consumed preview, inventory drift, idempotency conflict, or base conflict;
- `needs_input` for schema-valid but semantically incomplete desired changes;
- `unavailable` for unavailable store/inventory/readback dependency before a domain write.

`module_disabled_by_release` is only ordinary operational unavailable: the tool remains in `tools/list`
and the call returns `unavailable`. Security quarantine, retirement, and administrator security disable
are not v1 semantics; requests for them return `blocked` and cannot reuse the operational disable reason.

Do not catch a post-commit unknown result and report `unavailable`; that would hide a possible write.

### TDD steps

- [ ] Build a narrow fake repository that records method calls and can inject failures; it must implement the same interface and not duplicate service rules.
- [ ] Add failing tests for non-admin active role even when roles includes admin, missing role/scope/admin-tenant denial before repository calls, and exact inventory registration/readback.
- [ ] Run `npx vitest run tests/control-plane/service.test.ts`; expect missing-service failure.
- [ ] Implement authorization, stable errors, server ID/time injection, and registration; rerun focused tests.
- [ ] Add failing tests for change preview, rollback preview from a runtime-readback-verified release, duplicate/unknown/unregistered refs, redacted diff, TTL, and base pinning.
- [ ] Add failing tests for request/preview canonical hashes: RFC 8785/JCS object-key normalization, semantic collection sorting vs order-semantic array preservation, schema-version/domain separation, descriptor-digest non-equivalence, and equality after service/repository restart.
- [ ] Implement preview behavior; rerun.
- [ ] Add failing tests for self-approval, second/overwritten decision, reject terminal state, preview-hash/base/inventory mismatch, expired/consumed preview or approval, approval actor persistence, and idempotent replay/conflict.
- [ ] Implement approval behavior; rerun.
- [ ] Add failing tests for publish success, active snapshot exactness, readback mismatch, activation exception after commit, base race, inventory drift, newest unresolved publish block, startup one-shot pending readback, no startup retry for `manual_review`, operator reconcile reusing the same release, reconcile rejection for unknown/verified/superseded release, and rollback creating a new revision without mutating the target.
- [ ] Add failing tests proving operational disable remains visible/unavailable while security quarantine, retirement, and administrator security-disable requests are `blocked` and never remove the catalog entry in v1.
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

`createAdminControlApiHandler` receives data mode, the service, fixture-only token authenticator, allowed admin tenant, exact allowed origins/hosts, `allowLoopbackHttp`, max body bytes, and clock. It does not read global env. In production mode every POST is rejected with `blocked/admin_control_production_disabled_v1` before authenticator or service calls. Its router recognizes only:

```text
GET  /admin/api/v1/control/state
POST /admin/api/v1/control/packages/register
POST /admin/api/v1/control/deployments/preview
POST /admin/api/v1/control/approvals
POST /admin/api/v1/control/deployments/publish
POST /admin/api/v1/control/deployments/reconcile
```

`admin-static.ts` delegates recognized control routes before its static 404. Static assets and redacted snapshot behavior stay compatible.

Security order for POST: loopback/Host/Origin → method/path → production-mode fixed block → Content-Type → declared and streamed body size → Bearer extraction → fixture authenticator → `parseExecutionContext` → active admin role/roles/scope/admin tenant → `Idempotency-Key` → strict JSON schema → service. GET state still requires Bearer and auth but no idempotency key. Duplicate Authorization headers, query tokens, cookies as auth, missing exact Origin for writes, non-JSON, invalid length, malformed JSON, or unknown fields fail before service invocation. Do not reuse the current signature-only production verifier for Admin writes; production support is a future RFC requiring full issuer/audience/iat/exp/max-lifetime claim policy.

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

Every response uses the exact independent Admin envelope, existing Admin security headers and `Cache-Control:no-store`. Never echo auth input, raw parser error, stack, SQL, request body, or authenticator message.

### TDD steps

- [ ] Add a fake service spy and failing happy-path tests for all six routes, including server-bound request/trace/audit/context and idempotency metadata.
- [ ] Run `npx vitest run tests/platform/admin-control-api.test.ts`; expect missing-handler failure.
- [ ] Implement path/method dispatch and success/status mapping; rerun focused tests.
- [ ] Add a table-driven security test for remote address, Host, Origin, production-mode fixed block (zero authenticator calls), Content-Type, body size, malformed JSON, missing/duplicate Bearer, expired fixture claims, non-admin active role with admin in roles, scope, tenant, idempotency key, unknown fields, identity fields, URL/path/secret fields, and unknown routes. Assert zero service calls on every rejection.
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
3. fixed `MCP_INSTANCE_STATE_DIR` identity anchor and its derived control store/marker;
4. newest `published_pending_readback` release exact-read back once against that exact inventory, then active runtime snapshot restored into the registry; an existing `manual_review` is not retried at startup;
5. control service and Admin API using the same inventory/registry/store;
6. HTTP server, which starts listening only after reconciliation;
7. one close path that closes HTTP, composition and the separate control store exactly once.

`MCP_ADMIN_CONTROL_ENABLED` is never a bypass. A never-initialized fixed state-directory path with no marker/DB may retain legacy static-all-active only when `MCP_LEGACY_STATIC_MODE=true`; the absolute `MCP_INSTANCE_STATE_DIR` host configuration itself is mandatory, and deleting that anchor configuration is a startup error, not a fresh-mode signal. Before initialization the target directory may be absent only under the explicit legacy flag; once explicit initialization creates the marker and `control_identity` row, even a zero-release DB is sticky enabled: `MCP_ADMIN_CONTROL_ENABLED=false` or missing, marker/DB missing or damaged, DB path mismatch, a replacement fresh empty DB, identity/schema mismatch, or lock conflict aborts startup before listen and never falls back to all-active. An initialized run must provide the fixed `MCP_INSTANCE_STATE_DIR`, one `MCP_INSTANCE_ID`, exact derived DB/marker paths, exact inventory, and `MCP_ADMIN_TENANT_ID`; `MCP_ADMIN_CONTROL_ENABLED=true` is required as a consistency assertion. V1 permits this enabled mode only with fixture/local data mode. Production Admin POST remains blocked regardless of configuration. Enabling Admin UI does not make MCP readiness green.

Fixture mode adds a separate `MCP_FIXTURE_APPROVER_TOKEN` only to the loopback Admin authenticator. It maps to actor `local_approver`, admin role, `platform:admin`, same fixture tenant, distinct session/client IDs. The existing `MCP_FIXTURE_TOKEN` remains applicant `local_operator`; production verifier never accepts either as a special case.

Add `npm run init:control-fixture` as the explicit local initializer. It creates a new ignored `.runtime/mcp-instance-state/` directory with `0700`, atomically installs `.runtime/mcp-instance-state/control.sqlite` (`0600`) and sibling `.runtime/mcp-instance-state/control-identity.json` (`0400`), and never overwrites an existing target. The marker binds `MCP_INSTANCE_ID`, the absolute DB path, random `control_db_id`, and `schema_version=1`; the DB singleton must match. `npm run start:fixture` always supplies the same stable `MCP_INSTANCE_STATE_DIR`, sets `MCP_ADMIN_CONTROL_ENABLED=true`, derives those fixed paths, and sets a fixture management tenant and both fixture tokens. `.runtime/` is added to `.gitignore`; no database or marker is committed. Starting without explicit initialization, with a fresh replacement DB, with the marker missing, after deleting the enabled/path/instance control variables, or with a second process on the same DB fails closed.

### TDD steps

- [ ] Add failing tests proving disabled module calls return unavailable while tools/list metadata remains, non-module tools are unaffected, and re-enable restores behavior.
- [ ] Add failing tests proving `module_disabled_by_release` is ordinary operational unavailable only; security quarantine, retirement, and administrator security-disable requests are `blocked` and never remove the tool from `tools/list` in v1.
- [ ] Run `npx vitest run tests/control-plane/runtime-activation.test.ts`; expect missing integration failure.
- [ ] Implement the definition wrapper and composition injection; rerun.
- [ ] Add failing startup tests for the never-initialized no-marker legacy case; explicit initialized no-release default; after initialization with `MCP_ADMIN_CONTROL_ENABLED=false` or missing; after a release with `MCP_ADMIN_CONTROL_ENABLED=false` or missing; fresh replacement DB; marker missing/corrupt; marker/DB `control_db_id`, absolute path, instance, and schema mismatch; missing/corrupt/locked store abort before listen; and production POST fixed block. Assert zero implicit DB/marker creation.
- [ ] Add failing startup/reconciliation tests proving `published_pending_readback` gets one automatic exact readback before serving, `manual_review` gets no automatic retry, newest unresolved blocks publish, and operator reconcile reuses the same release/revision without creating another release.
- [ ] Implement runtime assembly and restoration before listen; rerun.
- [ ] Add failing fixture identity tests proving applicant cannot self-approve, approver token is distinct, both remain loopback-only, and production verifier path has no fixture branch.
- [ ] Implement fixture Admin authenticator and update `start:fixture`/`.gitignore`.
- [ ] Extend runtime smoke to complete API register→preview with applicant→approve with approver→publish/readback→forced pending→reconcile→rollback preview; assert `evidence_level=local_build`, `production_eligible=false`, `active_verified` means runtime exact readback only, production POST zero authenticator/service calls, security-disable requests are `blocked`, and persistence after process restart.
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
- selected-module inspector using only `local_build` descriptor/evidence display, never a verified-signature claim, URLs, email, raw refs, source path, token, or secret;
- preview diff, validation results, creator/approver distinction, release trail and rollback target;
- actions: 保存草稿 (browser memory only), 生成预览, 提交审批, 发布并读回, 对待确认 release 重新读回, 回滚到上一已读回版本（本地受控环境）.

The bearer exists only in a module-scoped JS variable. Never write it to storage, DOM text, URL, error report, or console. A visible identity dialog uses password input. `?fixture=1` may offer two clearly labeled local demo identity buttons with hardcoded non-secret fixture tokens; those buttons must never appear on the live/production query path.

Switches edit a desired draft only. Runtime badges update only after API publish returns runtime exact readback. `active_verified`/`verified` is never rendered as artifact signature or production qualification. On `manual_review`, preserve the server state, show the reason, and force refresh; never optimistically mark active. Adapter cards keep `待适配验证`/`未获生产资格`; security quarantine, retirement, and administrator security-disable controls are not offered as operational toggles in v1.

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

- module control writes are implemented and have local/fixture runtime exact-readback evidence; `active_verified`/`verified` is not artifact signature or production qualification; v1 production Admin POST is fixed blocked;
- only current deployment inventory can be registered;
- activation is a handler policy for already-mounted static modules, not arbitrary code hot-plug;
- business adapters and production qualifications remain unchanged;
- `MCP_ADMIN_CONTROL_ENABLED=false`/missing cannot disable an initialized policy or recover legacy mode; only the fixed state-directory path with no marker/DB plus explicit `MCP_LEGACY_STATIC_MODE=true` may select fresh legacy static-all-active;
- ordinary `module_disabled_by_release` keeps tools/list visibility and returns `unavailable`; security quarantine, retirement, and administrator security-disable requests are `blocked` and require a future catalog-removal contract;
- production Admin cannot be enabled by environment alone and requires a future accepted RFC for complete JWT claim policy, admin tenant, durable control DB plus external marker identity, exact Origin/Host, Deployment Evidence trust chain and multi-instance fencing;
- full production deployment is not performed by this work.

This is the only task that may update the release, security, rollback, and integration-handoff runbooks; this current specification revision must not edit them. The final release runbook must record control DB/marker backup and identity tuple, active release/revision, inventory digest set, Admin auth/approval evidence, runtime exact readback, and rollback target. The final rollback runbook must prohibit any pre-control-plane image that could ignore active policy; enforce a control DB/schema/activation-policy compatibility gate; preserve DB, release, and event history; and roll a module profile back only through preview→two-person approval→new release→exact readback using the UI phrase “回滚到上一已读回版本（本地受控环境）”. Security gates must cover token memory handling, fixture identity exclusion from production, production POST fixed block before authenticator/service, no arbitrary artifact fields, self-approval rejection, terminal approval binding, one-shot pending vs manual-review reconciliation, unresolved publish block, redacted events, and single-process SQLite lock. Final handoff acceptance must explicitly prove production Admin POST=`blocked`, fixture identities absent from production, and the single-process lock.

The e2e test must use a temporary SQLite file and real HTTP server to prove:

1. unauthenticated writes are zero-effect;
2. package registration is exact inventory-only and durable;
3. creator cannot approve;
4. distinct approver can approve;
5. publish changes a bundled module from callable to unavailable while retaining tools/list visibility;
6. readback records exact release/revision/module refs;
7. same idempotency key replays and conflicting hash blocks;
8. rollback preview/approval/publish restores behavior as a new revision;
9. `published_pending_readback` gets one startup exact readback, `manual_review` gets no startup retry, newest unresolved blocks new publish, and operator reconcile uses the same release/revision without creating a duplicate;
10. restart restores/reconciles active release and event history, while missing/corrupt/locked enabled store, missing/corrupt marker, path/DB identity mismatch, fresh replacement DB, and enabled=false/missing after initialization or after a release prevent listen;
11. ordinary operational disable keeps tools/list and returns unavailable, while security quarantine/retirement/administrator security-disable requests are blocked;
12. production POST is blocked before authenticator/service and responses/events contain no token, URL, path, email, business data, price, address or raw secret.

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
