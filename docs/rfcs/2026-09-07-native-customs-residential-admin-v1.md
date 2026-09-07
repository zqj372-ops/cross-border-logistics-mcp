# Native customs and residential administration v1

Status: implementation specification within the user-authorized native migration; no new MCP operations or Phase 1 domain schema changes. User priority is customs and residential quotation, with both own rates and Freightcom; every operation must be available in CLI.

This refines the native business authority RFC. Two named organization-owned resources are exposed under `/console/api/v1/admin/customs-data` and `/console/api/v1/admin/residential-rates`, each with get/save/preview/publish/disable/rollback. `/admin/freightcom` has get/save/disable and never returns credentials. These are explicit resource operations, not a generic commit endpoint. The old source adapters remain selectable only through explicit deployment configuration; native mode has no fallback to them.

## Contract and permission

Draft input: `{"expected_version":0,"input":{"label":"Operator supplied dataset", "...":"resource-specific fields; see schemas"}}`. This illustration is not a valid fixture. Publish: `{"expected_version":1,"preview_hash":"64 lowercase hex characters","confirmation":"reviewed_sources_and_conditions"}`. Rollback adds `release_id`. Disable needs expected_version. Each mutation requires an Idempotency-Key, bound to actor, organization, kind and action, with content conflicts rejected. Mutation commits and rereads the stored result.

Only active organization owners/admins write. No actor or organization can be supplied inside resource payloads. A platform role cannot impersonate an organization owner. Current organization membership is reread each request. A browser-confirmed CLI session receives the same personnel permissions and lifetime as server-managed sessions. API Key access to business queries remains separately authorized.

Success resource envelopes use portal-native-admin@2026-09-07.v1 with strict Draft 2020-12 shapes. Business query envelopes and existing tool names remain compatible. Errors use existing Portal error handling and the five permitted statuses. Official data and rates are owned by native business services, outside MCP transport.

## Publication and provenance

Start empty. A draft does not change an active release. Preview binds current revision and full content digest, validates coverage/duplicates/source references/effective dates, and requires explicit source/condition review. Published content is immutable; rollback creates an audited pointer change. Test-marked customs input cannot publish. An operator's source confirmation is not claimed as an automated government-site authenticity or completeness check. Official import currently accepts normalized JSON packages up to 16 MiB, not PDFs/HTML.

The source-status gate, provenance, no-result/manual-review semantics and test-data restrictions remain in the migrated customs engine. Python pricing retains Decimal and original pallet arithmetic; all business thresholds/fees are explicit fields. Exact postal prefix selection, source version, fees, pallet calculation and customer conditions remain traceable. Native own-rates currently retain the existing USD contract. Freightcom retains provider currency and residential classification.

## Migration, validation and rollback

Run agent standards validation/build, native/import tests, access-gateway/CLI regressions, schema checks, build and browser desktop/mobile acceptance. Initialize new native SQLite store and secure encryption key; do not copy credentials, old records or active rate defaults. Existing production connection config opts into nativeCustoms/nativeQuote/nativeFreightcom per organization. Native services must be explicitly enabled by PORTAL_NATIVE_BUSINESS_ENABLED=true. Native store currently rejects shared PostgreSQL deployment. Build includes the native Python source.

Switchback is an explicit deployment config change, never an automatic fallback. Preserve the native database, source publication history and key file. Disabling or reverting code does not erase native records. Credentials are encrypted with an organization-bound AES-GCM associated-data value; no credential appears in config readback, audit, fixture defaults or CLI response.
