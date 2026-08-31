# Plugin Configuration Control v1 implementation plan

## Goal

Deliver the accepted P1.5 local-fixture configuration workflow without changing MCP tool contracts or
production eligibility.

## Work sequence

1. Contracts and red tests
   - Add a closed static registry and Freightcom ConfigSpec.
   - Add Draft 2020-12 request, state, operation and registry schemas.
   - Test unknown/missing/duplicate fields, kinds, ranges, allowlisted slots/profiles and stable digesting.

2. Independent persistence
   - Add explicit `mcp-plugin-config` initializer and identity marker.
   - Add strict tables for current state, validations, previews, approvals, releases, readbacks,
     attempts, idempotency and events.
   - Test permissions, identity binding, reopen, corruption, idempotency and unfinished-attempt recovery.

3. Service workflow
   - Validate draft against the static spec and current revision.
   - Create expiring previews, enforce different-admin approval and publish one release revision.
   - Record attempt before apply, finalize exact readback, and reconcile without a second apply.
   - Test stale state, expiry, approval conflicts, replay, mismatch and fatal finalization.

4. Runtime application
   - Add a delegating Freightcom rate port that drains in-flight calls before swapping its test adapter.
   - Map only the fixed egress profile and credential slot server-side.
   - Keep production adapter disabled and preserve manual-review output semantics.

5. Admin API and UI
   - Add fixed `/admin/api/v1/config` routes with existing Admin security boundaries.
   - Map the internal service records to the UI's strict dual-column readback contract.
   - Render only server ConfigSpec fields; keep credentials in memory and show exact-readback success only.

6. Startup and explicit fixture initialization
   - Add an argument-free initializer wrapper and package script.
   - Open/recover the store only in fixture mode after explicit initialization.
   - Create a production handler whose writes are fixed fail-closed and which never opens the store.

7. Verification
   - Run targeted tests after each slice, then full tests, typecheck, lint, schema and Agent validation,
     build, secret scan, `git diff --check`, and browser checks at desktop and 390px.

## Files

- `docs/rfcs/2026-08-31-plugin-config-control-v1.md`
- `schemas/admin-control/plugin-config-*.schema.json`
- `src/logistics_mcp/control-plane/plugin-config-*.ts`
- `src/logistics_mcp/server/admin-plugin-config-api.ts`
- `src/logistics_mcp/server/start.ts`
- `src/logistics_mcp/server/index.ts`
- `deploy/scripts/init-plugin-config-fixture.mjs`
- `deploy/scripts/build.mjs`
- `apps/admin/{index.html,styles.css,app.js,plugin-config.js}`
- `tests/control-plane/plugin-config-*.test.ts`
- `tests/platform/admin-plugin-config-api.test.ts`
- related startup/static/UI tests and `package.json`

## Exit criteria

- No public arbitrary settings object, URL, path, secret, environment or command field exists.
- Only the five Freightcom test fields are configurable.
- Four-eyes, idempotency, attempt-before-apply and exact readback are proved by tests.
- Production POST is fail-closed before auth/store access.
- Full repository checks pass and the result is reported as local fixture only.
