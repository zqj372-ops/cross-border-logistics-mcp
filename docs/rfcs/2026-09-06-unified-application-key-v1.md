# Unified application API Key v1

Status: accepted for implementation under the user's 2026-09-06 direction to simplify the production workflow, use one Key across services, and follow Wind Alice Market's service discovery and Agent onboarding pattern. This RFC authorizes implementation and scoped production acceptance; it is not a claim that the new behavior is deployed.

## Problem and product behavior

The current user must create an application, submit separate T0 and Business requests, wait for grants, create two credential types, acknowledge each, and paste each into another diagnostics page. The separation of internal authorities has become a customer-facing prerequisite.

The product shall expose one API Key per chosen integration, usable for all of that application's explicitly enabled services. An ordinary person uses the business workbench with their verified login and membership, without creating or pasting API credentials. Applications and clients remain internal authority objects; advanced management remains available. The normal console presents API Keys, enabled services, usage and request history. A capability market explains what each service does and offers online use or Agent configuration.

## Single authority and compatibility

Reuse the existing Business credential store, pepper, salt, hash, identifier and revocation state as the application-key authority. Keep the `flcbk_` prefix. Do not persist paired plaintext credentials, mirror old PostgreSQL credentials into a second table, or create a third independent authentication system.

Current Portal T0 grants and Business grants remain their separate authorization authorities. A key never grants access beyond a live application, organization, owner, tenant, client and corresponding grant. Business operation restrictions on a key remain effective. A new application credential may support only T0, only Business, or both.

Legacy credentials retain their existing access by default. A legacy Business key gains T0 access only through an explicit version-checked enablement operation by its application owner, after active T0 grants are read back. This preserves the existing secret and records the scope extension in audit. The current user's instruction authorizes upgrading their already issued production key through that normal operation. Do not silently expand every legacy key during database migration.

New application credentials declare their T0 mode explicitly (`none` or `current_grant`). In current-grant mode, T0 tools are bounded by the application's currently active grants; grant changes are checked for every exchange and call. Existing `lmcpk_` credentials and exchange routes remain compatible and manageable, but the simplified UI no longer asks users to create a second T0 credential.

## Public contract

Versioned REST tool and business endpoints accept `Authorization: ApiKey flcbk_…` as a direct application-key authentication option. Existing Bearer short tokens remain supported. Fixed routes determine operation and authority; no arbitrary target, URL or tenant can be supplied. Reject duplicate/mixed authentication headers and cookie-based machine authentication.

Add `POST /access/v2/application/token/exchange` for MCP clients. Request:

```json
{
  "schema_version": "application-exchange@2026-09-06.v1",
  "requested_tool_names": ["cargo.calculate"]
}
```

The closed Draft 2020-12 schema permits only the established T0 tool names. The response uses the existing T0 short-token envelope and MCP audience. No mixed-audience token is introduced. MCP Runtime continues to accept short JWTs only; the long-key verifier stays in the separate access gateway/Portal process. Existing `/access/v2/tools/token/exchange` and `/access/v2/business/token/exchange` retain their meanings.

Before returning a token and before dispatching a request, recheck current authority after asynchronous credential/signing work. Existing-token authorization must resolve the correct credential namespace and reject a revoked application key immediately. Request bodies, tool output contracts, five business statuses, deterministic rules and source readiness remain unchanged.

## UI and safe delivery

The customer sees one Key list with name, masked suffix, created time, last-used time and current status. The existing customer secret is not displayed again. New secrets are displayed once, and confirmation of saving is still recorded. Confirmation can trigger an in-memory read-only connectivity check in the same screen; it cannot fabricate delivery, business approval or source readiness. Key and Token values never enter localStorage, sessionStorage, audit, examples or reports.

The Agent guide must distinguish currently exposed MCP tools from REST/Agent capabilities. A service card or install prompt cannot claim a Business operation is already part of the T0 MCP tool catalog. Source data that is unpublished stays unavailable/manual_review even when the account and API Key work.

Usage and request history must use actual bounded, redacted audit/readback data. Do not invent balances, pricing, usage counts, success rates or request history. Until a metric is recorded, show an explicit empty/unavailable state.

## Required acceptance

- The same real key calls T0 REST and Business REST, and exchanges a token for existing MCP tools.
- Credential delivery, expiry, revocation, organization/application/owner/tenant/client suspension and relevant grant changes are enforced for direct calls and old tokens.
- Cross-tenant, unknown scope/tool, wrong audience, malformed body, duplicate auth, cookie mixing and revocation races fail closed.
- Legacy v1 records survive restart without secret regeneration or implicit access expansion. Owner enablement is versioned, auditable and idempotent.
- Existing old-key/exchange tests continue to pass; no existing source business records are changed by the acceptance probes.
- Desktop/mobile flow shows one credential path, direct business use and automatic safe validation without copying the secret between internal pages.

## Release and rollback

Back up the three Portal databases and protected configuration consistently. Deploy a content-hashed candidate beside the previous release, run targeted contracts/security tests and ordinary-role browser checks, and verify production build identity and actual request results. On failure, restore routing/image compatibility without deleting new audit or credential records; retain the old credential routes and preserve all existing secrets and grants.
