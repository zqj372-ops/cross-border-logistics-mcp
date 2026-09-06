# Production business platform v1

Status: accepted for implementation under the user's 2026-09-05 instruction to finish production identity, persistence, source connections, formal-data verification, deployment acceptance, and future-service onboarding.

## Scope and authority

Extend the existing FreightClaw platform at www.freightclaw.net with /console and versioned business APIs. Reuse the existing Oracle Authentik instance and Gateway tenant/client PostgreSQL authority; keep the existing runtime and its T0 contracts separate. Connect quote.freightclaw.net and clearddp.com through authenticated APIs. The former quote system remains the sole authority for prices, quote records and manual review; the customs system remains the sole authority for publications and tariff results. No customer dispatch, payment or carrier booking is implied by a successful query or deployment.

## Production profile

This release supports a single self-hosted region. Portal, business entitlements and sessions use dedicated SQLite WAL databases on persistent storage, FULL synchronous commits, protected file permissions, schema identity/version checks and tested backups/restores. Existing Gateway tenant/client/credential storage continues to use its current PostgreSQL instance. Existing T0 signing and credential peppers continue to use the verified OCI Vault / KMS instance-principal integration from production release bba4ea6ccc39. The new business audience uses separate protected host signing keys and peppers with version history, rotation overlap and recovery backups. This release does not claim a managed Portal database or multi-region high availability. Missing required identity, database, key or source configuration fails startup or the individual operation closed.

People authenticate with the existing Authentik through a separate confidential OIDC application, authorization code + PKCE, nonce and verified email. Platform roles come from explicit IdP groups. Portal membership and application ownership are rechecked on each operation. Browser credentials use persistent, expiring, revocable sessions with CSRF protection; pending OIDC authorization is short-lived and consumed once.

## API and compatibility

Existing /mcp, /access/v1 and T0 schemas retain their meanings. /console/api/v1 is the person-facing BFF. /access/v2/business and /api/v2/business use dedicated business credentials, audience and current entitlements. Source calls use separate connection identity and signed actor delegation. New write actions have individual contracts and permissions; there is no generic operation endpoint.

Before: a local fixture session could exercise a synthetic Portal while source calls were unavailable. After: an OIDC session uses production durable state and explicitly configured source connections. A source that lacks reviewed published data still returns unavailable/manual_review. Production mode is not permission to convert fixture data or unreviewed rates into a successful result.

Quote manual resolution and PDF export must be backed by source records and verified evidence; these capabilities require their own source schemas and BFF tests before exposure. Other existing services are exposed only through their own narrow verified API contracts.

## Migration, verification and rollback

Deploy candidates beside existing releases, preserve all existing state and deployments, and record artifact hashes and configuration presence without secrets. Back up database state before migrations. Create new Portal databases empty; do not migrate fixture users, grants, keys or synthetic business results. Configure OIDC and source mappings explicitly. Verify real login, organization/application authorization, API approval/key exchange/revocation, source readiness/version identity, actual quote record write/readback, restart persistence, and public HTTPS routes. Use designated acceptance records and retain their audit identity. Do not notify customers or book a shipment during acceptance.

Required local commands: npm run typecheck; npm run lint; npm run validate:schemas; npm run validate:agent-standards; npm run build:agent-pack; npm run build; relevant Vitest suites and browser acceptance; git diff --check. Source service test suites run in their own isolated worktrees. Production evidence records passed, blocked and unverified separately, including the exact release identity. Rollback switches the proxy to the prior healthy service and preserves all new state/evidence; destructive down migrations are not used.
