# Freightcom production rate preview for Business API v2

- Status: Accepted for implementation; production connection not yet verified
- Date: 2026-09-05
- Scope: Portal personnel API and Business API v2 only

## Problem and resulting behavior

The repository previously exposed a fixture-only Freightcom MCP adapter and a test-account workflow. Those paths cannot establish a production rate. This change adds a separate Portal operation, `quote.freightcom_ltl.preview`, backed only by an explicitly configured production Freightcom customer credential. It returns carrier rate estimates, surcharge and tax lines, original currency, validity date, service identity, and opaque source evidence. It does not save a sales quote, send a message, book a shipment, purchase a label, or alter the Phase 1/T0 MCP catalog.

Freightcom documents Customer API 2.10.0 `POST /rate` as an estimated-rate request returning `202`, followed by bounded `GET /rate/{rate_id}` polling at `https://external-api.freightcom.com/`. The Portal connector performs exactly that sequence with redirects disabled and bounded response size and time.

## Public contracts

Personnel session route:

- `POST /console/api/v1/business/quote/freightcom-ltl-preview`
- browser body: `{ "input": <freightcom-ltl-preview-input> }`
- actor, organization, tenant, account connection, and request ID are injected by the BFF.

Machine route:

- `POST /api/v2/business/quote/freightcom-ltl-preview`
- body: `{ "schema_version": "business-call@2026-09-05.v1", "input": <freightcom-ltl-preview-input> }`
- requires a Business Key whose current active Grant contains only the requested operation, followed by a short-lived Business API v2 Bearer token.

New operation JSON:

```json
{
  "requested_operations": ["quote.freightcom_ltl.preview"],
  "schema_version": "business-exchange@2026-09-05.v1"
}
```

The response is `portal-freightcom-rate@2026-09-05.v1`. Amounts preserve Freightcom's integer minor-unit value and add a deterministic decimal string for CAD or USD. No FX conversion occurs. Every response fixes `saved=false`, `sendable=false`, and `bookable=false`.

## Status and evidence rules

- `success`: production connection, completed polling, at least one rate, consistent supported currency, service ID, amount lines, unexpired validity date, and an official source reference are all present.
- `needs_input`: closed request validation or Freightcom request validation fails.
- `manual_review`: returned rates have missing evidence, no rate, expired validity, mixed/unsupported currency, or the connector is running against a loopback fixture.
- `blocked`: the caller lacks the exact operation grant or Freightcom rejects the configured account credential.
- `unavailable`: connection or credential is absent, polling is incomplete, response contract is invalid, response is too large, redirect is attempted, timeout occurs, or the provider is unavailable.

The provider rate ID is never returned directly. The result contains only a SHA-256 opaque request reference and source locator. No request body, customer address, credential, or provider error body is logged or returned.

## Tenant, account, and credential boundary

Deployment configuration maps one Portal organization and tenant to one server-owned Freightcom account connection. Browser and machine bodies cannot choose or override tenant, application, actor, connection, hostname, or credential. Test credentials are not a fallback for production.

The Freightcom block is optional. Omitting it leaves this operation unconfigured while existing customs and quote connections continue to start. If deployment explicitly enables this operation, its credential file must exist, be a private regular file, and contain a bounded non-empty value; malformed explicit configuration fails before listening.

## Compatibility, migration, and rollback

This is an additive Business API v2 operation. Existing four operations, T0 JWT audience, MCP tools, quote record APIs, and static module registration do not change. Existing clients continue to exchange only their approved operations. Rollout requires an updated Business schema/OpenAPI artifact, an explicit organization connection, a production Freightcom credential obtained from the provider account, and a fresh Grant approval. Rollback removes the Freightcom operation from the organization connection and grants, then deploys the previous schema/route set; other business operations remain available.

## Verification

Required regression covers: closed input, tenant injection, exact Grant authorization, server-owned credential, production/fixture distinction, 202 plus bounded polling, CAD/USD preservation, incomplete evidence to `manual_review`, provider/auth/redirect/timeout failure closure, strict response fields, and absence of save/send/book behavior. Production readiness additionally requires a real account-owned read-only rate request and read-back with non-customer acceptance data. No production rate request was executed by this implementation task.
