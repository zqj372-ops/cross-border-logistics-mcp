# Acceptance Notes

## Delivered scope

The independent CLI is accepted for COSCO Shanghai-to-Vancouver and for ONE
Shanghai public point-to-point queries. This is a two-carrier collector
milestone, not a multi-carrier rollout or MCP/Portal deployment.

## Automated verification

- 13 collector test files, 68 tests passed after the 2026-09-17 structure review fixes.
- TypeScript `./node_modules/.bin/tsc --noEmit` passed.
- `npx eslint services/maritime/schedule-collector tests/maritime/schedule-collector` passed.
- `git diff --check` passed.
- Mac independently exercised 7 fixture service cases with no network: normal
  candidates, valid empty filter, unknown routing filtered empty, invalid data
  shape, source name conflict, conflict with no records, and source UUID conflict.
- Invalid-date CLI input returned `needs_input/validation_error`, recorded in
  `k12-invalid-date.json`.

Tests cover the closed contract, date and routing semantics, location ambiguity,
evidence hashes/redaction, bounded HTTP, error states, cancellation and lifecycle.
No synthetic test is counted as live evidence. Unchanged whole-repository build,
MCP runtime, release and production tests were not rerun for this narrow collector
change.

## ONE live verification

Four fresh K12 CLI processes ran after the ONE adapter was implemented:

| Query | Route shape | Status | Records |
| --- | --- | --- | --- |
| Shanghai to Vancouver, 2026-09-17 to 2026-10-28 | Direct | success/ok | 6 |
| Shanghai to Houston, 2026-09-17 to 2026-10-28, `--routing transshipment` | Two ocean legs through Busan | success/ok | 11 |
| Shanghai to Toronto, 2026-09-17 to 2026-10-28 | Ocean plus CN rail | success/ok | 13 |
| Shanghai to Vancouver, 2026-09-17 to 2026-12-14 | Three bounded source windows | success/ok | 13 |

Every normalized record was read back against the response bytes referenced by
its evidence hash. Vessel, voyage, ordered leg mode, leg endpoints, departure,
arrival, POL and POD matched the source rows; no mismatch was found. The ONE
source labels its documentation cutoff more broadly than the collector's
`si` field, so that value remains an explicit non-key warning rather than a
guessed mapping.

## COSCO current live verification

These fresh CLI processes ran on K12 through SSH using the delivered worktree.
Each query returned in about 1.6 to 1.9 seconds.

| Route and departure window | Status | Records | Accepted as a normal live query |
| --- | --- | --- | --- |
| Shanghai to Vancouver, 2026-09-17 to 2026-10-14 | success/ok | 5 | yes |
| Shanghai to Vancouver, 2026-10-01 to 2026-10-28 | success/ok | 4 | yes |
| Shanghai to Vancouver, 2026-10-15 to 2026-11-11 | success/ok | 6 | yes |
| Shanghai to Toronto, 2026-09-17 to 2026-10-14 | manual_review/partial | 9 | no |

All vessel, voyage, ETD, ETA, POL and POD values were compared to their raw source
rows. Actual evidence byte hashes, date windows and city UUIDs matched. The
three Vancouver observations have no source identity conflicts. Times lacking
a source timezone remain local; no UTC offset is inferred.

Toronto's selected location is Toronto/Canada, but COSCO echoed the destination
name as Cato Ridge/South Africa. The collector preserves the source location
full name, UN/LOCODE and UUID, checks the echo, and exposes
`cosco_destination_city_name_mismatch`. The source also reports unordered inland
modes. The old assertion that these were verified Toronto results is withdrawn.
The old evidence and receipt remain available as history.

The task-internal attempt at the first Vancouver window returned an immediate
`unavailable/timeout`; it is retained in
`k12-vancouver-2026-09-17_2026-10-14.json`. The later successful SSH checks are
separate observations, not an overwrite or reinterpretation of that failure.
A long-term guarantee about Codex task connectivity is not part of these CLI
query results.

## Evidence and operation

K12 worktree:
`/home/autumn/Documents/Codex/worktrees/MCP-schedule-collector-20260917`

Handoff directory:
`/home/autumn/Documents/Codex/handoffs/schedule-collector-20260917-01a0aaf7/`

- `cosco-integration-receipt.json`: corrected final receipt.
- `completion-live-readback.json`: full independent readback, SHA-256
  `a39c9748b9f6bb6437e7941c830b95b5fa111aaf1bc0236f367575c5be1146f3`.
- `mac-readback-*.json`: full outputs from fresh K12 CLI processes.
- `cosco-integration-receipt-v1-history.json`: superseded original receipt.
- Raw sanitized evidence stays under the worktree's
  `.runtime/schedule-collector/evidence/`.

The CLI defaults to `synthetic`; live requests require `--mode live`.
Use the exact K12 commands and existing dependency link documented in README.
No resident collector service is required.

## Remaining coverage limits

OOCL remains unverified on K12 after HTTP 451 at the public entry/route; no
bypass or session reuse was attempted. ZIM, Evergreen, Hapag-Lloyd, Maersk,
MSC, Matson, WHL and YML are not implemented. No claim is made about arbitrary
global routes, booking space, production deployment, or successful MCP
registration. The existing maritime publication contract, Portal and shared
MCP contracts remain unchanged.


## Structure review follow-up

Mac independently queried ONE (6 records) and COSCO (5 records), compared vessel,
voyage, departure, arrival, POL and POD to the source, and verified evidence hashes.
The review identified and fixed COSCO's invented same-terminal inland leg, ONE's
loss of successful windows after a later failure, and missing envelope warnings.
A failed later window now keeps manual_review/partial results and identifies both
failed and unattempted windows; all-failed queries remain unavailable. Evidence
from completed empty windows also survives aggregation. CLI help includes live
examples, the carrier registry and exit meanings without performing network I/O.

The initial review tests failed on all three new behaviors before implementation;
the completed collector suite passes 68 tests, with TypeScript and scoped ESLint.
Historical live evidence was not replaced. New output and independent field checks
are retained in the Mac review directory and the K12 handoff review receipt.

HMM's live location lookup succeeded but its point-to-point call returned
access_restricted (exit 6). This is not accepted live schedule support. Chromium
launched with chromiumSandbox:true after explicitly setting CHROME_DEVEL_SANDBOX;
EMC remains unverified because the official query entry timed out, including a
separate Mac browser check. Browser startup is not schedule acceptance.
