# RFC: FCL high-frequency quotation operations v2

Status: Accepted for implementation from the user's explicit 2026-09-21 FCL operations specification. This is the scoped baseline acceptance for the existing Portal/native-business/document services, not a new MCP module or evidence of deployment.

## Scope and authority

Reuse FCL receiver authorization, NativeAdmin publication/preview/CAS/idempotency, Decimal money, Case, internal quotation and DocumentWorkflow review/PDF. Add a Chinese-first English-secondary field dictionary and a dense operations workspace. No CRM, LCL product, marketing, booking, carrier integration or new database.

The native business service owns maintained charges, inland rates, destination templates and estimated quotation revisions. Existing document service remains the authority for selected customer quotations, review and formal PDF. No model-generated commercial values or implicit FX.

## Minimal model change and compatibility

The strict v1 rate dataset remains readable and writable. A v2 JSON dataset retains `label` and existing `rates` and adds `operations`: `rate_details`, `charges`, `delivery_rates`, `templates`. Existing rate IDs and ocean prices remain their sole authority. Metadata joins by rate ID; it does not duplicate ocean prices. Each charge and delivery price has explicit validity, currency, source/version and billing basis. Templates select explicit component IDs, routing, container types, capacity constraints, FX and margin rules.

Old: `{contract_version:"fcl-rate-dataset@2026-09-20.v1",label,rates}`.

New: `{contract_version:"fcl-rate-dataset@2026-09-21.v2",label,rates,operations:{rate_details:[],charges:[],delivery_rates:[],templates:[]}}`.

UI migration copies a v1 draft into v2 with empty operations arrays only on explicit edit/save. No fabricated rates/templates. Historical releases retain their original JSON and digest.

Estimated quote revisions reuse `native_configs` for typed current pointers and `native_releases` for immutable snapshots under the private `fcl-estimate` namespace. They are pre-review calculations, distinct from an existing Case-bound internal quote. No SQLite DDL or schema-version migration is required. Writes are narrow typed service methods, never a generic public storage endpoint. Personal scope is server-derived and checked on every read/replay/write.

## Calculation and price selection

Engine uses explicit estimated shipping date, container quantities (`{type, quantity, unit:"CNTR"}`) and cargo measurements. New operations requests require the count unit; legacy inquiry and Case schemas remain unchanged. Missing constraints or FX produce blockers, never guessed values. Price windows must cover that date; conflicting versions for the same logical component are rejected. Route matching is exact; no city/port inference. Fixed, per-shipment and per-container charges are separate lines. Inland bands are explicit non-overlapping total-weight intervals; no extrapolation. Delivery surcharge rows retain independent validity and source refs.

Costs, sales, GP and GP/revenue are Decimal strings; row rounding and FX aggregation share the existing quotation money implementation. `cost_markup` and `gross_margin` are distinct ratios, with target margin below 1. Explicit fixed selling amounts remain possible. Risk reserve is a named cost line, not hidden profit. Estimates retain component versions, FX, margin rule, trace, source digest, calculated actor/time and shipping date.

Every new/recalculated option defaults to `system_estimated`, `send_status=not_sent`. Formal review state is not duplicated in the estimator. Selection into a Case creates a normal internal quote and proceeds through the existing separate review and PDF workflow. Neither recalculation nor selection approves or sends a quote. Selected drafts and snapshots carry the strict optional `extensions.fcl_estimate_v1` binding (estimate ID, version, digest and complete validity intersection). The server reconstructs its lines, checks Case route/quantities/date/weight, and invalidates the customer quote when this estimate changes. Document dates cannot exceed any included component validity. Existing v1 snapshots serialize identically when the extension is absent.

## Narrow API and CLI additions

Extend `/console/api/v1/fcl/<action>` and `freightclaw workspace fcl <action>` together with closed request/response schemas: estimate-run, estimate-list, estimate-get, estimate-adjust, estimate-duplicate, estimate-select, rate-bulk-preview and rate-bulk-publish. Existing private receiver, session, CSRF and explicit idempotency rules apply; application keys acquire no rights.

Batch input may include an explicit `estimate_request` (shipping date and quantities); in that case publication also creates the first matching destination estimates, without deriving a date from the current clock. Omitting it only refreshes existing estimates. Batch preview reports newly generated, affected and locked counts. Batch preview validates all rows and returns a content hash. Batch publish requires that hash, expected configuration version and explicit source-review confirmation; it atomically publishes the new rate dataset and recalculates affected saved options. Replaying the same key returns the original result version, including after later source publication or process restart; currentness is re-evaluated for historical estimate responses. Bulk publication replay returns its original publication view. Recalculation appends versions and preserves old amounts. Locked options retain their amount and are marked stale if dependencies change. Manual adjustments append original/new amount, actor, timestamp and reason; automatic repricing does not silently discard manual adjustments. Legacy fee identity uses the fee name/group/service/unit/container/currency, independent of row position and price; removal/identity change blocks an existing adjustment rather than assigning it to another fee. Ambiguous duplicate identities are blocked. Calculations exceeding 120 charge lines return an explicit blocker and null totals.

Comparison returns actual saved server calculations. Sorting uses amounts in one explicit comparison currency; missing amounts sort last. No client-side quotation calculation. User selects the option; no cheapest-source auto-selection. Comparison schedule fields are maintained metadata, not carrier-confirmed sailings.

## Verification and rollback

First test calculation, missing/expired/overlapping inputs, one-to-many repricing, history, lock/manual changes, idempotency, CAS, owner isolation, persistence/restart and write-after-readback failures. HTTP/CLI schemas and receiver permissions share the existing pipeline. Acceptance fixture: Shanghai → Vancouver → Calgary, 40HQ, COSCO/ONE/OOCL; ocean 3200 → 3500; fixed component prices unchanged, new estimates/version/compare, then normal selected quote/review/PDF.

Run relevant Vitest suites, typecheck/lint/build, schema/agent validation and desktop/mobile browser checks. Release requires exact commit checks plus normal backup/deployment gates. Rollback to a v1-only binary is unsafe after writing v2 data: retain a compatible binary or disable the affected feature and restore the complete pre-change database/config backup under stopped writers. Never overwrite quote history or silently relabel v2 as v1.
