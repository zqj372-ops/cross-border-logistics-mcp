# RFC: Plugin Configuration Control v1

- Status: Accepted
- Accepted by: product owner confirmation on 2026-08-31
- Contract version: `2026-08-31.v1`
- Scope: local fixture Admin control only

## Summary

Add a narrow, auditable configuration workflow for image-bundled MCP modules. The first and only
configurable module is `freightcom-ltl`; `cargo`, `container`, and `agent-access` explicitly publish
`config_spec: null`. Configuration is deployment-scoped and follows:

`draft -> validate -> preview -> different-admin approval -> publish -> controlled apply -> exact readback`

This RFC does not add a plugin market, remote installation, arbitrary JSON settings, runtime code
loading, production Freightcom access, pricing or customs rule editing, or any business write tool.

## Motivation

The Admin console can currently activate static modules and manage tenant access, but it cannot show
which built-in module parameters are safe to change or prove that a requested change became active.
Putting an unrestricted settings map in the control database would weaken both the nine-table control
identity and the authority boundary. A separate typed configuration control is therefore required.

## Authority and safety boundary

- Only modules already present in the trusted image inventory may expose a `ConfigSpec`.
- A `ConfigSpec` is server-owned. The browser cannot add fields, options, URLs, paths, commands,
  environment variables, secrets, prices, zones, capacities, customs rules, or business records.
- Values use a closed typed array: `integer`, `boolean`, `enum`, or `secret_slot`.
- `secret_slot` stores only an allowlisted opaque slot identifier. It never stores secret material.
- Egress uses an allowlisted opaque profile identifier. It never accepts a URL or hostname.
- Freightcom remains test-only, T1, `manual_review`, `production_eligible=false`, non-sendable and
  non-bookable regardless of configuration state.
- Production Admin configuration POST routes return a fixed fail-closed response before
  authentication or persistence access.
- Existing MCP tool input/output contracts and deterministic domain authority remain unchanged.

## First ConfigSpec

`freightcom-ltl` exposes exactly five deployment fields:

| Field | Type | Allowed value | Apply policy |
| --- | --- | --- | --- |
| `request_timeout_ms` | integer | 1000..30000 ms | controlled restart |
| `poll_interval_ms` | integer | 100..5000 ms | controlled restart |
| `max_poll_attempts` | integer | 1..30 | controlled restart |
| `egress_profile_id` | enum | `freightcom_test_fixed` | controlled restart |
| `credential_slot_id` | secret_slot | `freightcom_test_credential` | controlled restart |

The fixed egress profile maps server-side to the existing Freightcom test host. The fixed credential
slot maps server-side to the existing Keychain reader. Neither mapping is client-configurable.

## Persistence and identity

Configuration state lives outside `control.sqlite` at:

```text
<application-root>/.runtime/mcp-plugin-config/config.sqlite
<application-root>/.runtime/mcp-plugin-config/config-identity.json
```

Initialization is explicit and argument-free. Runtime startup never creates or repairs this state.
The marker binds the canonical application root, database path, instance ID, management tenant ID,
schema version, and random store ID. Directories are mode `0700`, the database is `0600`, and the
marker is `0400`. Schema/table identity and SQLite quick-check are verified before use.

The store contains explicit configuration workflow records rather than a generic key/value table.
Every write is idempotent by `(action, idempotency_key, request_hash)` and produces an audit event.

## HTTP contract

The local Admin prefix is `/admin/api/v1/config`:

- `GET /state`
- `POST /drafts/validate`
- `POST /previews`
- `POST /approvals`
- `POST /releases/publish`
- `POST /releases/reconcile`

Requests use `2026-08-31.v1`, closed Draft 2020-12 schemas, Bearer authentication and, for POST,
`Idempotency-Key`. The same loopback, Host, Origin, Content-Type, body-size, cookie/query credential,
management-tenant, admin-role and `platform:admin` checks used by the existing Admin control boundary
apply here.

The UI projection returns only domain-separated, hashed `actor_ref` values for the current operator,
preview creator, and approver. These opaque references support four-eyes comparison without exposing
the internal actor identifier or decoding the Bearer token in the browser.

## Publish, readback, recovery and rollback

Publishing requires an unexpired preview and one final approval decision by an actor different from
the preview creator. A preview cannot accumulate or replace approval decisions.
The apply driver builds only a Freightcom test adapter from bounded values. A release is active only
when readback exactly matches `revision`, `config_digest`, and `module_generation` with no reason codes.

Each apply is recorded as an attempt before runtime mutation. If the process stops before finalization,
the next boot finalizes the attempt as `manual_review/readback_interrupted` without applying a second
time. If runtime mutation succeeds but durable finalization fails, the process enters a fatal state and
must not continue dispatching with ambiguous control evidence.

Rollback is represented as a preview targeting a previously verified release and follows the same
approval, publish, apply, and readback rules. The first Admin UI batch does not expose rollback unless
the server explicitly returns it in `allowed_actions`.

## Compatibility and migration

- Existing module-control, tenant-access, MCP and Agent contracts do not change.
- No migration of the nine-table module control database occurs.
- Existing fixture startup remains fail-closed until the new store is explicitly initialized.
- Removing the config API and delegating adapter restores the prior environment-based Freightcom
  behavior; persisted plugin-config state can remain offline for forensic inspection.

## Tests

Required regression coverage:

- Draft 2020-12 schema validation and closed ConfigSpec semantics.
- Unknown field, wrong type, out-of-range value, URL/path/secret and credential leakage rejection.
- Explicit initialization, marker/database identity, permissions, corruption and symlink rejection.
- Idempotency replay/conflict, stale revision, preview expiry and four-eyes approval.
- Apply-attempt recovery, exact readback, mismatch/manual-review and fatal-finalization behavior.
- API boundary ordering, production POST fail-closed and response redaction.
- Admin client same-origin paths, memory-only token handling and test-only qualification labels.
- Full repository test, typecheck, lint, schema validation, Agent standards and build.

## Rollback procedure

1. Stop the local fixture runtime.
2. Restore the previous application build.
3. Do not delete or mutate `.runtime/mcp-plugin-config`; retain it as audit evidence.
4. Start the prior build, which does not open the plugin configuration store.
5. Verify `/readyz`, the static module inventory, and Freightcom production-disabled behavior.
