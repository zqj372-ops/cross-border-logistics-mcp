# Ocean Schedule Collector

This is an independent, read-only collector for public carrier point-to-point
schedule queries. It does not register an MCP tool, change Portal data, publish
maritime snapshots, or enable production build entry points.

## Status

- The `carriers`, `locations`, and `query` CLI commands are implemented.
- The collector data contract is closed and validated before it enters the shared
  `2026-08-11.v1` response envelope.
- Synthetic/replay data is always returned as `manual_review`, never as a live
  `success`.
- Live network access is disabled by default. The CLI defaults to `synthetic`
  mode; every live request requires an explicit `--mode live`. COSCO's official
  public Vancouver path and ONE's official public point-to-point API were
  verified from K12 through the controlled Node connector on 2026-09-17.
  COSCO Toronto still returns source identity conflicts and is not treated as
  verified. ONE Toronto returns an ocean plus rail itinerary without a source
  identity conflict.
- The collector preserves COSCO's source location `fullFormate`, UN/LOCODE, and
  UUID in the resolved query, sends all three to the schedule endpoint, and
  compares them with the source echo. A mismatch keeps the candidate records
  but returns `partial`/`manual_review`; it cannot become a live `success`.
- ONE uses its official anonymous API, preserves the source port and terminal
  codes, keeps ordered ocean and inland journeys, and splits requests longer
  than 42 days into bounded windows.
- Current OOCL live observations from the Mac handoff are evidence about the
  official public page, not K12 collector verification.

## CLI help and review fixes (2026-09-17)

Run `node --import tsx/esm services/maritime/schedule-collector/cli.ts --help`
or add `--help` to `query`, `locations`, or `carriers`. Help does not query a carrier.
Business commands continue to print JSON; live queries require `--mode live`.
The registry lists 12 carriers, including unverified and unimplemented entries;
only the observed COSCO/ONE routes have passed live acceptance.

Review fixes preserve partial ONE results and evidence when a later window fails,
project source restrictions into the shared envelope, and preserve evidence even
for completed windows with no records. COSCO no longer invents a truck leg from a
POD to the same terminal: the source facility is a terminal, not an inland journey.
A different delivery facility without segment evidence remains manual_review.
HMM has an adapter and location lookup, but its point-to-point endpoint returned
access_restricted on K12 on 2026-09-17; it is implemented_unverified.

## Offline commands

The CLI uses the repository's existing `tsx` installation:

```sh
node --import tsx/esm services/maritime/schedule-collector/cli.ts carriers
node --import tsx/esm services/maritime/schedule-collector/cli.ts locations \
  --carrier OOCL --query Vancouver --mode synthetic
node --import tsx/esm services/maritime/schedule-collector/cli.ts query \
  --carrier OOCL \
  --origin Shanghai --origin-country CN \
  --destination Toronto --destination-country CA \
  --from 2026-09-17 --until 2026-10-28 \
  --mode synthetic
```

The synthetic mode reads a clearly named fixture from
`fixtures/synthetic-oocl.ts`. It writes sanitized evidence to
`.runtime/schedule-collector/evidence` and always exits with `manual_review`
semantics. Omitting `--mode` selects this offline mode. Use `--mode live`
explicitly only for the approved exact targets and bounded connector.

Live COSCO example:

```sh
node --import tsx/esm services/maritime/schedule-collector/cli.ts locations \
  --carrier COSCO --query Shanghai --country CN --mode live

node --import tsx/esm services/maritime/schedule-collector/cli.ts query \
  --carrier COSCO \
  --origin Shanghai --origin-country CN \
  --destination Vancouver --destination-country CA \
  --from 2026-09-17 --until 2026-10-14 \
  --routing any --mode live
```

Live ONE examples:

```sh
node --import tsx/esm services/maritime/schedule-collector/cli.ts locations \
  --carrier ONE --query Vancouver --country CA --mode live

node --import tsx/esm services/maritime/schedule-collector/cli.ts query \
  --carrier ONE \
  --origin Shanghai --origin-country CN \
  --destination Vancouver --destination-country CA \
  --from 2026-09-17 --until 2026-10-28 \
  --routing any --mode live

node --import tsx/esm services/maritime/schedule-collector/cli.ts query \
  --carrier ONE \
  --origin Shanghai --origin-country CN \
  --destination Toronto --destination-country CA \
  --from 2026-09-17 --until 2026-10-28 \
  --routing any --mode live
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | `success` |
| `1` | internal failure |
| `2` | CLI usage or argument failure |
| `3` | `needs_input` |
| `4` | `manual_review` |
| `5` | `blocked` |
| `6` | `unavailable` |

The JSON envelope is authoritative even on error paths.

## Network boundary

Live mode requires a trusted runner-provided connector and an approved,
expiring exact target. The COSCO CLI uses `transport/cosco-live.ts` and the controlled Node HTTPS
connector. ONE uses `transport/one-live.ts` and the same connector against its
official `ecomm.one-line.com` API. OOCL metadata in `transport/oocl-live.ts`
does not enable an OOCL live adapter.
No request is made when a connector is absent, the policy is not approved, the
target path differs, the request body has unapproved keys, or the client call
was already aborted.

## Running the delivered CLI on K12

Use the existing worktree and dependency link. No new package installation,
server, queue, or MCP registration is required.

```sh
cd /home/autumn/Documents/Codex/worktrees/MCP-schedule-collector-20260917
node --import tsx/esm services/maritime/schedule-collector/cli.ts carriers
node --import tsx/esm services/maritime/schedule-collector/cli.ts locations   --carrier COSCO --query Vancouver --country CA --mode live
node --import tsx/esm services/maritime/schedule-collector/cli.ts query   --carrier COSCO --origin Shanghai --origin-country CN   --destination Vancouver --destination-country CA   --from 2026-09-17 --until 2026-10-14 --routing any --mode live
```

The date range filters departure from the first ocean leg. Change the dates for
later queries. Source local times remain local times; missing timezones are not
invented. A schedule result does not establish available booking space.

K12 uses its existing Node runtime and `node_modules` link to
`/home/autumn/Documents/Codex/MCP/node_modules`. Keep that link available.
The CLI is a one-shot process; it requires no resident service. The final live
checks ran from K12 SSH using this same worktree in separate fresh processes.

## Verified scope on 2026-09-17

| COSCO Shanghai to Vancouver departure window | Result | Records |
| --- | --- | --- |
| 2026-09-17 to 2026-10-14 | success | 5 |
| 2026-10-01 to 2026-10-28 | success | 4 |
| 2026-10-15 to 2026-11-11 | success | 6 |

| ONE Shanghai departure window | Route | Result | Records |
| --- | --- | --- | --- |
| 2026-09-17 to 2026-10-28 | Vancouver, direct | success | 6 |
| 2026-09-17 to 2026-10-28 | Houston, one transshipment | success | 11 |
| 2026-09-17 to 2026-10-28 | Toronto, ocean plus rail | success | 13 |
| 2026-09-17 to 2026-12-14 | Vancouver, 3 bounded windows | success | 13 |

These overlapping windows are separate observations, not a count of unique
sailings. Vessel, voyage, ETD, ETA, POL and POD were checked against every
corresponding source row; evidence byte hashes and echoed query conditions
were read back.

COSCO Toronto returned 9 candidates but remains `manual_review/partial` because the
source echoed Cato Ridge, South Africa as the destination name and reported
unordered inland modes. It is not a verified Toronto query. OOCL is not usable
from the current K12 path (HTTP 451 observed); HMM remains implemented but unverified, and the other listed carriers remain
unimplemented. ONE's document cutoff is deliberately not mapped to the shared
`si` field because the source label is broader than Shipping Instructions;
that non-key warning remains visible in `quality.warnings`.

Full evidence and the corrected COSCO receipt are under
`/home/autumn/Documents/Codex/handoffs/schedule-collector-20260917-01a0aaf7/`:
`completion-live-readback.json` and `cosco-integration-receipt.json`.
The ONE readbacks are the `one-*.json` files in the same directory.
The original receipt is retained as `cosco-integration-receipt-v1-history.json`;
its old Toronto acceptance wording is superseded.

To stop using the collector, stop invoking this CLI. No production service,
database, Portal, or MCP setting needs rollback. Existing evidence is retained;
this delivery does not delete files or dependencies.
