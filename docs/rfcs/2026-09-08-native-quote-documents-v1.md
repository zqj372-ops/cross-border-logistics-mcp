# Native quotation documents v1

Status: accepted for local implementation under the user's request to migrate quote-pdf-builder. Production publication remains separate.

## Motivation and authority

Import the user's desktop quotation module into the existing FreightClaw personnel workspace. The native business layer owns explicitly entered quotation documents and organization templates. The MCP registry, query API Key privileges and existing source quote-record contracts do not change. This is a separate document workflow; a draft does not certify a quote engine's business readiness.

## Contract and migration

New `/console/api/v1/quote-documents/{config,config-save,preview,save,list,get,approve,export}` personnel-session routes use strict Zod contracts in `services/quote-documents/contracts.ts`, exported as Draft 2020-12 schemas. Old JSON: no endpoint. New JSON preview: `{input:{quote_no,customer_name,quote_date,valid_until,origin,destination,route_name,job_no,so_no,container_no,remark,exchange_rates,fee_items}}`. Money, rates and quantities are decimal strings. Exchange rates may be null and are never defaulted. Currency USD/CAD/CNY only; fee groups A/B/C; detail, hiddenIncluded, hiddenExcluded and merged modes. Desktop JSON is not silently trusted as an approved document.

Organization templates begin empty. Only owner/admin may update templates or confirm manually verified prices. Active members create and read their own documents; managers may inspect their organization's documents. No cross-organization access. No API Key authority expansion. CLI uses the same personnel session and contracts.

Preview signs actor, organization, template version, normalized document and ten-minute expiry. Save requires exact preview and explicit confirmation. Stored documents contain immutable input and template snapshots. Approval binds the current version, evidence reference/version, review note and `human_verified_price_and_source`; it increments the version. Expired or future-dated documents cannot be approved or exported formally. Draft PDFs carry a prominent draft label. Formal PDFs require an approved current-valid document. No email, booking or payment operation is provided.

SQLite is a separate native business store with schema version check, private filesystem permissions, transactional idempotency, audit hashes and write/readback. PDFs are rendered locally with a bounded Chromium process and no remote content, validated and stored with SHA-256. Every export rechecks membership, visibility, state, validity and stored checksum. Rendering failure returns unavailable. Generated customer PDFs never embed the editable input or hidden line metadata; source desktop PDF embedded-data behavior is deliberately not migrated.

## Compatibility, validation and rollback

No existing tools or response statuses change. New responses use the five-state envelope and a module schema version. API and CLI return the same snapshots. Existing source quote history remains distinct. Production needs an explicit local store path and Chromium executable; shared Postgres support is not included. Rollback removes module registration and endpoint wiring; keep the separate database for recovery. Do not delete customer records as a rollback step.

Run quote-documents tests (decimal calculation, visibility, escaping, tenant/actor checks, version conflict, idempotency, snapshot template, expiry, PDF integrity), HTTP and CLI regression, typecheck, lint, schema and Agent validations, build, and local browser export with an inspected PDF.

Billing, receipts, source desktop local archives, arbitrary PDF import, logos, and email delivery are not part of quotation v1. They require separate explicit product flows; no old customer records or credentials are imported automatically.
