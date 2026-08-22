# Writable MCP Module Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real, durable, fail-closed local/fixture module control plane that registers only modules bundled in the current deployment inventory, previews changes, enforces two-person approval, publishes an activation policy with exact runtime readback, reconciles unknown results, and rolls back through the same audited flow while production Admin writes remain blocked in v1.

**Architecture:** Keep the existing Node/TypeScript MCP gateway and static Module Runtime v0. Add a narrow control-plane package, a separate strict single-process SQLite control store derived only from an explicit application root, an external immutable identity marker bound to `instance_id` and `management_tenant_id`, an immutable activation registry that gates already-mounted module handlers, fixture-authenticated loopback Admin APIs, and an AdminLTE 4 module-center UI. FastAdmin informs information architecture only; no PHP runtime, arbitrary package loader, verified-release claim, business-data store, production Admin write, or code hot-plug is introduced.

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
- `MCP_ADMIN_CONTROL_ENABLED` is never a bypass. The managed entrypoint may listen only after an
  explicit initializer has installed the fixed state directory, marker, and DB; missing state,
  identity, schema, tenant, root derivation, or a non-literal-`true` value fails before listen.
  There is no uninitialized compatibility start or implicit activation fallback.
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

inventory is an allowlist only, not an activation policy. `ModuleActivationRegistry` starts with the exact
empty snapshot `{releaseId:null, revision:0, activeModules:[]}`; it must not derive active entries from
inventory. Without an `active_verified` release, module handlers are not routable and return
`unavailable` with reason `module_policy_not_released`, while `tools/list` remains visible and non-module
tools are unaffected. The first activation must complete registration→preview→different-actor approval→
publish→runtime exact readback before any module is routable. `replace(next)` validates exact inventory
refs, duplicate refs, nonnegative safe revision, and monotonic revision. It replaces one frozen snapshot;
`snapshot()` never exposes mutable arrays. `isActive(moduleId, version)` only checks the fixed snapshot.

Admin request schemas use Zod `.strict()` at runtime and checked-in Draft 2020-12 JSON Schemas with `ADMIN_CONTROL_SCHEMA_VERSION="2026-08-22.v1"`. Exact request shapes are register `(schema_version,module_id,version,descriptor_digest)`, preview change `(schema_version,intent,desired_modules)`, preview rollback `(schema_version,intent,target_release_id)`, approval `(schema_version,preview_ref,decision,reason_code)`, publish `(schema_version,preview_ref,approval_id)`, and reconcile `(schema_version,release_id)`. Prohibit identity, URL/path/source/secret fields by construction.

The independent Admin envelope root is closed and contains `schema_version`, server `request_id`, `trace_id`, `audit_id`, existing five status strings, `reason_codes`, a closed readback object, and `data`. `trace_id` never replaces `audit_id`. `readback` is `{status:"not_applicable"|"pending"|"verified"|"mismatch"|"unknown",release_id:string|null,revision:integer|null}`; `verified` here means runtime activation exact readback only, never artifact signature or production qualification. A successful publish must keep the three state fields distinct and simultaneous: Only `module_control_idempotency.status` becomes `completed`; `module_releases.status` becomes `active_verified`; Admin `readback.status` becomes `verified`. `domain_committed`, `published_pending_readback`, `pending`, and `manual_review` are intermediate/unresolved states and cannot be substituted. `data` is null or a closed discriminated union with `kind=control_state|registration|preview|approval|release|reconciliation`; generic `z.record`/unknown data is forbidden.

### TDD steps

- [ ] Add contract tests proving every JSON Schema declares Draft 2020-12, root `additionalProperties:false`, rejects identity/URL/path/secret extras, and accepts only the documented request union.
- [ ] Run `npx vitest run tests/control-plane/contracts.test.ts`; expect failure because contracts and schema files do not exist.
- [ ] Implement the strict Zod contracts and static JSON Schemas; rerun until the contract test passes.
- [ ] Add inventory tests for deterministic digest under input reordering, digest changes for every module/tool contract field, duplicate module/tool rejection, local-only evidence truthfulness, and no filesystem/environment inputs.
- [ ] Keep Task 1's existing descriptor/inventory implementation scope unchanged in this revision; record the follow-up contract tests for request/preview canonical hashes: cross-restart stability, object-key order, semantic collection input order, preserved order-semantic arrays, schema-version separation, domain separation, and explicit distinction from `descriptorDigest`. If the shared helper is not owned by Task 1, implement it in Task 2/3 before those tests are marked complete.
- [ ] Run `npx vitest run tests/control-plane/inventory.test.ts`; expect missing-module failure.
- [ ] Implement canonical inventory construction and immutable returned entries; rerun until green.
- [ ] Add activation tests for the exact initial empty snapshot (`releaseId:null`, `revision:0`, `activeModules:[]`), inventory-only allowlist semantics, unavailable `module_policy_not_released` routing before any `active_verified` release, complete first activation through distinct-actor four-eyes publish/readback, atomic replacement, exact descriptor match, duplicate/unknown rejection, stale revision rejection, and mutation resistance.
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

The store is a separate file-backed database with `durability="durable"`. The trusted server assembly
is the only caller that may inject an absolute regular `application_root`; the managed entrypoint derives
exactly `<application-root>/.runtime/mcp-instance-state` and then exactly `<state_dir>/control.sqlite`
and `<state_dir>/control-identity.json`. Store/initializer options, CLI arguments, diagnostic objects and
configuration objects must reject explicit `stateDir`, `controlDbPath`, or `markerPath` values. The
runtime never reads cwd and rejects any environment-variable path override for the root, state directory,
DB, or marker. A changed root therefore derives a different absolute path and fails closed rather than
selecting another instance.
New-file creation is exposed only through an explicit initializer; normal runtime open requires an
existing v1 database and never silently recreates, repairs, replaces, or ignores a missing managed
store. The initializer atomically installs a new state directory containing both files. The marker is
one UTF-8/JCS JSON object plus LF with exactly `marker_format:"mcp-control-identity/v1"`,
`instance_id`, `management_tenant_id`, absolute `control_db_path`, random
`control_db_id=db_<32-lower-hex>`, and `schema_version:1`; the DB singleton `control_identity` row
must match every marker field, including `management_tenant_id`. The directory is `0700`, marker
`0400`, DB `0600`; the target, every intermediate path component, and both files must be regular
non-symlinks. `:memory:` is forbidden.

The initializer creates a sibling staging directory on the same parent filesystem using
`fs.mkdtemp` or an equivalent exclusive `mkdir` (never `O_CREAT` as a directory primitive), with
mode `0700`. Inside staging it runs one transaction to create the strict v1 schema, the singleton
`control_identity` row, and `user_version=1`, then executes `PRAGMA wal_checkpoint(TRUNCATE)` and
closes every SQLite handle. If clean close leaves `control.sqlite-wal` or `control.sqlite-shm`, it
fails and removes staging; otherwise it fsyncs the main DB. It writes the marker as a regular file
with `O_CREAT|O_EXCL`, fsyncs the marker, fsyncs the staging directory, renames staging exactly once
to a not-yet-existing final state directory, and fsyncs the parent directory. Any existing target,
symlink, intermediate symlink, non-atomic/cross-filesystem rename, permission mismatch, or cleanup
failure is a hard initialization failure. Normal runtime never creates, repairs, or replaces either
file. Crash-injection tests at transaction commit, WAL checkpoint/close, marker fsync, staging-dir
fsync, rename, and parent-dir fsync must prove that a restart sees either no installable final state
or a complete identity-consistent state, with abandoned staging cleaned or safely ignored.

Runtime open requires a regular non-symlink DB and marker, exact `MCP_INSTANCE_ID`, exact
`management_tenant_id` from the server-managed identity, exact derived paths, matching
`control_identity`, v1 schema, and `MCP_ADMIN_CONTROL_ENABLED=true`. After initialization, false or
missing enabled is a startup error even with zero releases. A marker/DB mismatch, missing state
directory, missing marker or DB, new empty DB, corrupt identity, tenant change, schema drift, path
change, any symlink, permission/lock conflict, or failed quick check fails closed before listen.
Deleting identity/enabled inputs cannot hide the fixed marker; it must instead fail closed. Tests use
temporary regular application roots and prove initialization, reopen, and tenant-change failure.

Task 2 owns one shared `canonicalControlHash` helper for both Task 2 and Task 3; Task 3 imports it
instead of implementing another serializer. The helper must frame bytes exactly as
`ASCII MCP-CONTROL-HASH`, one byte `0x00`, ASCII `v1`, one byte `0x00`, ASCII `request|preview`,
one byte `0x00`, ASCII `schema_version`, one byte `0x00`, then RFC 8785/JCS canonical JSON UTF-8
bytes, and hash the complete frame with SHA-256. The escaped `\x00` notation in docs is not literal
text. Set-like arrays use UTF-8 byte lexicographic sorting; `desired_modules` and `inventory_refs`
use the tuple `module_id NUL version NUL descriptor_digest`, while order-semantic arrays retain input
order. The exact design/RFC golden vectors are request
`mcp-control-hash/v1/request/sha256:1dc6b77eedfc0639d6fb264c4e0557bdeb39a46bbabb968db13a6be7ee8c86da`
and preview
`mcp-control-hash/v1/preview/sha256:13348c6594c3d24cc30aeb62f839e6b6fd1fe133830a2fdad11b8d4b59b6e503`;
the same request JCS payload under the preview domain must also produce
`mcp-control-hash/v1/preview/sha256:7f756bdf267eb3ef54b6ee5a3211a947255f491072f72f92dc7f844e6024c04b`.
Tests must assert the NUL bytes, JCS object-key normalization, UTF-8 tuple and set ordering,
object-key/set input reorder invariance, order-array preservation, descriptor/request/preview
separation, domain/schema-version separation, and equal hashes after close/reopen.

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

`control_identity` is a fixed singleton metadata table, not a generic key-value or business table. Store
JSON columns have `json_valid` checks. IDs and status fields have CHECK constraints. Every domain and
idempotency key includes explicit `management_tenant_id`, even though v1 allows one configured
management tenant. Release revision is unique and strictly increasing inside that tenant. Approval is
append-only/final, uniquely bound to preview canonical hash/base revision/inventory digest set/expiry,
and publish atomically consumes preview plus approval. Foreign keys connect preview→approval→release→
readback. Unknown `user_version`, unexpected columns/tables/index drift, corruption, failed quick
check, or lock conflict closes the DB and fails closed.

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

Every mutation takes server-created actor/context metadata, canonical request hash, action, idempotency key, and redacted event payload. Same action/key/hash replays; same action/key/different hash is a typed conflict. Register, preview, and approval store the complete response and event in their domain transaction. For a new publish key, the service checks the unresolved gate before reserving idempotency; it then atomically writes the release/event and advances the idempotency record to `domain_committed` with the immutable release ID. Automatic exact readback from `domain_committed` is permitted only while that fixed release is `published_pending_readback`; it may never create a second release. If the fixed release is already `manual_review`, publish replay returns only the persisted final result and performs zero activation and zero readback. After the one-shot pending attempt, operator `reconcile` is the only retry entry point for an unresolved release, using the same release/revision and desired refs. Only `module_control_idempotency.status` becomes `completed`; `module_releases.status` becomes `active_verified`; Admin `readback.status` becomes `verified`. Expired completed keys may be pruned only inside a later transaction; never prune `reserved`/`domain_committed` records or weaken release history.
Publish processing is ordered: first inspect the existing same-tenant/action/key idempotency record and
request hash; same-key conflict is returned immediately, same-key replay returns the persisted result,
`manual_review` replay performs zero activation/readback, and `domain_committed` may resume only the fixed
`published_pending_readback` readback. Only a new key checks newest unresolved releases; after that gate
passes, reserve idempotency and atomically create the release. Only
`module_control_idempotency.status` becomes `completed`; `module_releases.status` becomes
`active_verified`; Admin `readback.status` becomes `verified`.

Publish uses compare-and-set on expected base release/revision and writes release status
`published_pending_readback`. For a new idempotency key only, it rejects any newest unresolved release
(`published_pending_readback` or `manual_review`) before creating a new release. `recordReadback` can move
it to `active_verified` only for exact release/revision/module refs; `active_verified` means runtime exact
readback only, not artifact signature or production qualification. Mismatch/unknown records
`manual_review` without deleting the release. Startup performs one automatic exact readback for the
newest `published_pending_readback`; it does not retry an existing `manual_review`. After that one-shot
pending attempt, operator `reconcile` is the only retry entry point for an unresolved release, and it
never creates a release or changes desired refs.

### TDD steps

- [ ] Add tests for explicit secure initialization, same-parent sibling staging with `mkdtemp`/exclusive
  mkdir, strict marker format/permissions, DB/marker atomic install, WAL checkpoint/truncate and
  closed handles, lingering-sidecar failure and staging cleanup, DB/marker/dir/parent fsync ordering,
  regular non-symlink checks, non-overwrite and atomic-rename rejection, crash interruption at each
  install boundary, runtime missing-state rejection,
  `control_identity` schema/tables/indexes, `management_tenant_id` in marker and identity row, `0600`,
  WAL/exclusive lock, second-store denial, reopen persistence, health, idempotent close, explicit
  management-tenant keys, tenant-change failure, and no business columns.
- [ ] Add path-boundary tests that pass `stateDir`, `controlDbPath`, and `markerPath` as explicit
  constructor/initializer parameters, CLI flags, diagnostic values, and config values; each must be
  rejected before filesystem open/listen. Also test cwd and every environment-variable path override;
  the trusted assembly may inject only `applicationRoot`, and all three derived paths must remain fixed.
- [ ] Run `npx vitest run tests/control-plane/sqlite-control-store.test.ts`; expect missing-store failure.
- [ ] Implement secure initialization and schema verification; rerun the focused cases.
- [ ] Add tests for exact register/preview/approval/publish/readback persistence and chronological redacted events.
- [ ] Add tests for idempotent replay, management-tenant-scoped conflict, self-consistent transaction
  rollback, base revision CAS, immutable reject/approve terminal decision, approval hash/expiry/consume
  binding, unknown references, readback mismatch, and restart state recovery. Use the shared
  `canonicalControlHash` helper and the two locked design/RFC golden vectors above; assert literal NUL
  framing bytes, RFC 8785/JCS, UTF-8 tuple sorting, object-key and set-order invariance,
  order-semantic-array preservation, descriptor/request/preview separation, schema-version/domain
  separation, and request/preview equality after repository restart.
- [ ] Add reconciliation/idempotency tests proving startup automatically exact-reads
  `published_pending_readback` once, does not auto-retry `manual_review`, newest unresolved blocks a
  new-key publish, same-key/hash replay/conflict is evaluated before that unresolved gate, a
  `domain_committed` retry only resumes pending readback, a manual-review publish replay returns the
  persisted result with zero activation/readback, only operator `reconcile` retries an unresolved release,
  reconcile reuses the same release/revision, and reconcile never creates a second release.
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

Task 3 must import Task 2's shared `canonicalControlHash` helper and use the same strict request and
preview payloads, JCS bytes, UTF-8 tuple sorting, and NUL framing. Service tests must assert the exact
design/RFC request vector
`mcp-control-hash/v1/request/sha256:1dc6b77eedfc0639d6fb264c4e0557bdeb39a46bbabb968db13a6be7ee8c86da`
and preview vector
`mcp-control-hash/v1/preview/sha256:13348c6594c3d24cc30aeb62f839e6b6fd1fe133830a2fdad11b8d4b59b6e503`,
plus the domain-separated Vector 1 preview result
`mcp-control-hash/v1/preview/sha256:7f756bdf267eb3ef54b6ee5a3211a947255f491072f72f92dc7f844e6024c04b`.
They must cover object-key/set reorder, order-semantic arrays, schema-version separation, descriptor
digest non-equivalence, literal `0x00` framing, and equality after service/repository restart; no
second serializer or JSON.stringify-only substitute is allowed.

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

Approval requires a different actor from preview creator and atomically writes one terminal decision bound to management tenant, preview canonical hash, base release/revision, inventory digest set and expiry. Reject cannot be overwritten. Publish first looks up the same-tenant/action/idempotency-key record and compares the request hash: conflict blocks immediately; same-key replay returns the persisted result; a `manual_review` replay performs zero activation and zero readback; only a `domain_committed` record whose fixed release is still `published_pending_readback` may resume pending-only readback. Only a new key then checks newest unresolved (`published_pending_readback|manual_review`); after that gate it revalidates nonexpired/unconsumed preview, approved decision, exact approval ID/hash, base CAS, and current inventory, and atomically consumes preview+approval while creating the release. After repository publish, call `activationRegistry.replace`, perform exact runtime readback, and record readback. Startup auto-reconciles only the newest `published_pending_readback` once; it does not retry `manual_review`. After that one-shot pending attempt, operator `reconcile` is the only retry entry point for an unresolved release, and it accepts only the newest fixed pending/manual-review release without creating another release or changing desired refs. Only `module_control_idempotency.status` becomes `completed`; `module_releases.status` becomes `active_verified`; Admin `readback.status` becomes `verified`. Return:

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
- [ ] Add failing tests for the shared request/preview canonical hashes using the exact design/RFC
  golden vectors: literal NUL framing, RFC 8785/JCS object-key normalization, UTF-8 tuple and set
  sorting, semantic collection sorting vs order-semantic array preservation, schema-version/domain
  separation, descriptor-digest non-equivalence, and equality after service/repository restart.
- [ ] Implement preview behavior; rerun.
- [ ] Add failing tests for self-approval, second/overwritten decision, reject terminal state, preview-hash/base/inventory mismatch, expired/consumed preview or approval, approval actor persistence, and idempotent replay/conflict.
- [ ] Implement approval behavior; rerun.
- [ ] Add failing tests for publish success, active snapshot exactness, readback mismatch, activation exception after commit, base race, inventory drift, newest unresolved publish block, `domain_committed` pending-only automatic readback, manual-review publish replay with zero activation/readback, startup one-shot pending readback, no startup retry for `manual_review`, operator-only reconcile reusing the same release, reconcile rejection for unknown/verified/superseded release, and rollback creating a new revision without mutating the target.
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

The definition remains in tools/list with unchanged name, contract, RBAC, version, risk and standards. Non-module definitions are unchanged. Before any `active_verified` release exists, module definitions return `unavailable` with `module_policy_not_released`; the first activation must complete the full distinct-actor preview→approval→publish→exact-readback flow. Re-enable restores the original handler without rebuilding the composition.

Refactor startup into a narrow runtime assembly that receives only an explicit absolute regular
`application_root` from the trusted server assembly and creates, in this order:

1. token verifier(s);
2. composition and its mounted static module inventory plus an unapplied activation registry, without listening;
3. validates that the explicit application root is a regular non-symlink directory, derives exactly
   `<application-root>/.runtime/mcp-instance-state/control.sqlite` and
   `<application-root>/.runtime/mcp-instance-state/control-identity.json`, and rejects cwd,
   state-directory environment variables, CLI, or any other path override;
4. requires the explicit initializer to have completed before runtime open, then validates the
   whole fixed state directory, marker, DB, `control_identity`, strict v1 schema, exact
   `instance_id`, exact `management_tenant_id`, derived paths, permissions, and
   `MCP_ADMIN_CONTROL_ENABLED=true`; runtime never creates, repairs, replaces, or selects another
   state directory, and any missing/changed root, deleted state directory, missing file, fresh DB,
   corruption, schema drift, symlink, tenant/identity mismatch, or lock conflict aborts before listen;
5. exact-reads the newest `published_pending_readback` release once against that exact inventory, then
   restores only the resulting `active_verified` runtime snapshot into the registry; an existing
   `manual_review` is not retried at startup, and if no `active_verified` release exists the registry
   remains at `releaseId:null`, `revision:0`, `activeModules:[]` so module calls return
   `unavailable/module_policy_not_released`;
6. control service and Admin API using the same inventory/registry/store;
7. HTTP server, which starts listening only after validation and the one-shot pending readback;
8. one close path that closes HTTP, composition and the separate control store exactly once.

`MCP_ADMIN_CONTROL_ENABLED` is never a bypass or initializer. There is no uninitialized start branch,
no implicit activation fallback, and no path environment anchor. An initialized run must provide the
server-managed `instance_id` and `management_tenant_id` that match marker/DB, exact inventory, and
literal `MCP_ADMIN_CONTROL_ENABLED=true`; a missing/non-true value fails closed even with zero releases.
V1 permits this managed mode only with fixture/local data mode. Production Admin POST remains blocked
regardless of configuration. Enabling Admin UI does not make MCP readiness green.

Fixture mode adds a separate `MCP_FIXTURE_APPROVER_TOKEN` only to the loopback Admin authenticator. It maps to actor `local_approver`, admin role, `platform:admin`, same fixture tenant, distinct session/client IDs. The existing `MCP_FIXTURE_TOKEN` remains applicant `local_operator`; production verifier never accepts either as a special case.

Add `npm run init:control-fixture` as the explicit local initializer. The fixture assembly supplies an
explicit application root; the initializer derives a new ignored `.runtime/mcp-instance-state/`
directory with `0700`, atomically installs `.runtime/mcp-instance-state/control.sqlite` (`0600`) and
sibling `.runtime/mcp-instance-state/control-identity.json` (`0400`), and never overwrites an existing
target. The marker binds `MCP_INSTANCE_ID`, the fixture `management_tenant_id`, the absolute DB path,
random `control_db_id`, and `schema_version=1`; the DB singleton must match. `npm run start:fixture`
passes the same explicit application root through assembly, sets `MCP_ADMIN_CONTROL_ENABLED=true`,
and supplies the fixture management tenant and both fixture tokens; it does not read cwd or accept a
state-path environment override. `.runtime/` is added to `.gitignore`; no database or marker is
committed. Starting without explicit initialization, after deleting the entire derived state
directory, with a fresh replacement DB, with the marker missing, after changing the application root,
after changing/deleting identity or enabled inputs, or with a second process on the same DB fails
closed.

### TDD steps

- [ ] Add failing tests proving the initial empty snapshot and no-`active_verified` module calls return
  `unavailable/module_policy_not_released` while tools/list metadata remains, non-module tools are
  unaffected, and re-enable restores behavior only after the complete four-eyes publish/readback flow.
- [ ] Add failing tests proving `module_disabled_by_release` is ordinary operational unavailable only; security quarantine, retirement, and administrator security-disable requests are `blocked` and never remove the tool from `tools/list` in v1.
- [ ] Run `npx vitest run tests/control-plane/runtime-activation.test.ts`; expect missing integration failure.
- [ ] Implement the definition wrapper and composition injection; rerun.
- [ ] Add failing startup tests proving explicit initializer is required; no-marker, missing-whole-state-directory,
  fresh replacement DB, changed application root/derived path, any symlink, marker/DB `control_db_id`,
  absolute path, `instance_id`, `management_tenant_id`, and schema mismatch; missing/corrupt/locked
  store; and non-literal-`true`/missing `MCP_ADMIN_CONTROL_ENABLED` all abort before listen. Assert
  zero implicit DB/marker creation, zero cwd/path-env discovery, and production POST fixed block.
- [ ] Add failing startup/reconciliation/idempotency tests proving `published_pending_readback` gets
  one automatic exact readback before serving, `manual_review` gets no automatic retry, a
  `domain_committed` retry is pending-only, manual-review publish replay performs zero activation and
  zero readback, newest unresolved blocks publish, and only operator reconcile reuses the same
  release/revision without creating another release.
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
- an explicit initializer and the explicit application root are mandatory; missing or incomplete
  derived state, root changes, identity/tenant drift, or `MCP_ADMIN_CONTROL_ENABLED=false`/missing
  fails closed before listen, with no uninitialized compatibility branch or implicit activation fallback;
- ordinary `module_disabled_by_release` keeps tools/list visibility and returns `unavailable`; security quarantine, retirement, and administrator security-disable requests are `blocked` and require a future catalog-removal contract;
- production Admin cannot be enabled by environment alone and requires a future accepted RFC for complete JWT claim policy, admin tenant, durable control DB plus external marker identity, exact Origin/Host, Deployment Evidence trust chain and multi-instance fencing;
- full production deployment is not performed by this work.

This is the only task that may update the release, security, rollback, and integration-handoff runbooks; this current specification revision must not edit them. Until Task 7 updates and accepts those documents, the existing release/security/rollback runbooks are historical application/integration references, not authority for the new control plane. That gate blocks declaring Task 5 complete and blocks final acceptance, but does not block Task 2's store implementation. The final release runbook must record control DB/marker backup and identity tuple, active release/revision, inventory digest set, Admin auth/approval evidence, runtime exact readback, and rollback target. The final rollback runbook must reject every pre-control-plane image that could ignore active policy, isolate or remove the old static entry from managed rollback targets, enforce a control DB/schema/activation-policy compatibility gate, preserve DB, release, and event history, and roll a module profile back only through preview→two-person approval→new release→exact readback using the UI phrase “回滚到上一已读回版本（本地受控环境）”. Security gates must cover token memory handling, fixture identity exclusion from production, production POST fixed block before authenticator/service, no arbitrary artifact fields, self-approval rejection, terminal approval binding, one-shot pending vs manual-review reconciliation, domain-committed pending-only readback, manual-review replay with zero activation/readback, operator-only reconcile, unresolved publish block, redacted events, application-root/marker/DB/management-tenant continuity, and single-process SQLite lock. Final handoff acceptance must explicitly prove production Admin POST=`blocked`, fixture identities absent from production, the initializer/root gate, the single-process lock, and all red tests below.

The e2e test must use a temporary SQLite file and real HTTP server to prove:

1. unauthenticated writes are zero-effect;
2. package registration is exact inventory-only and durable;
3. creator cannot approve;
4. distinct approver can approve;
5. publish changes a bundled module from callable to unavailable while retaining tools/list visibility;
6. readback records exact release/revision/module refs;
7. same idempotency key replays and conflicting hash blocks; `domain_committed` automatic readback is
   pending-only, manual-review publish replay returns the persisted result with zero activation and
   zero readback, and only operator reconcile can retry an unresolved release;
8. the shared canonical hash helper matches the two exact design/RFC golden vectors, uses literal NUL
   framing, RFC 8785/JCS, UTF-8 tuple and set ordering, preserves order-semantic arrays, and proves
   object-key/set input reorder, schema-version/domain separation, descriptor/request/preview
   separation, and cross-restart stability;
9. rollback preview/approval/publish restores behavior as a new revision;
10. an explicit initializer is required; restart restores/reconciles active release and event history,
    while missing/corrupt/locked derived state, missing/corrupt marker, `control_db_id`/absolute path/
    `instance_id`/`management_tenant_id`/schema mismatch, deleted whole state directory, changed
    application root, any symlink, fresh replacement DB, and non-literal-`true`/missing enabled or
    identity inputs after initialization or after a release prevent listen and never create implicit
    state;
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
