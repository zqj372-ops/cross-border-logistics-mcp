# Ocean Schedule Collector

This is a read-only collector for public carrier point-to-point schedule queries.
The existing `schedule-live` service also uses these adapters for Portal queries.
It does not register a new MCP tool, create authoritative maritime records, or
turn a schedule into a booking or price.

## Public-source expansion (2026-09-27)

The registry now has 13 carriers. EMC/Evergreen, SML/SM Line and YML/Yang Ming
have live HTTP adapters and are selectable in the existing schedule page.
Maersk also has a locally verified optional browser CLI path, not yet enabled
in Portal; remaining access gaps are in the [access matrix](docs/carrier-access-matrix.md).

Local controlled Node queries and the Portal UI both returned these official
Shanghai → Vancouver results for 2026-09-28 through 2026-10-25:

| Carrier | Sailings | Source |
| --- | ---: | --- |
| EMC / EVERGREEN | 5 | ShipmentLink public HTML form |
| SML | 4 | SM Line public JSON form |
| YML | 4 | Yang Ming public P2P API |

The collector preserves date-only values, unknown timezones, source transit
durations, cutoff qualifications and location ambiguity. Evergreen's Vancouver
BC carrier ID is `CAVCR`; its UN/LOCODE is `CAVAN`. The collector does not infer
the operating carrier from a vessel name. Source bytes were read back with their
SHA-256 references and vessel/voyage/port/date fields checked for every record.
These are route-specific local observations, not production acceptance.

```sh
node --import tsx/esm services/maritime/schedule-collector/cli.ts query \
  --carrier EMC --origin Shanghai --origin-country CN \
  --destination Vancouver --destination-country CA --destination-id CAVCR \
  --from 2026-09-28 --until 2026-10-25 --routing any --mode live
```

For SML or YML use `--carrier SML` / `--carrier YML` and omit
`--destination-id CAVCR`. Evergreen rounds requests up to its offered 7-day
increments and filters results back to the requested dates; windows are at most
28 days. SML uses at most 30 days and YML at most 28 days per request. An 8-day
Evergreen query returned 2 sailings; a 44-day SML query returned 7 across two
windows. A later-window failure preserves earlier results as partial.

This Mac's default DNS returned synthetic `198.18.*` addresses, correctly rejected
by the private-address guard. Local live acceptance used an ignored test-only DNS
preloader with public DNS answers; TLS verification, address rejection, request
budgets and exact host/path rules stayed enabled. No system DNS or deployment
configuration was changed. The production host still needs its own acceptance.

## Optional browser collector (local verification only)

HMM and OOCL now have isolated Playwright form collectors behind the existing
browser port; Maersk uses the same optional transport. They use a fresh, anonymous browser profile, the official location
selector and read-only schedule form; they reuse the existing parsers, evidence
store, date windows and CLI envelope. No user profile, cookie or CAPTCHA token
is imported. Interactive challenges are not solved. Portal production assembly
does not enable this path while standalone live acceptance is incomplete.

Install the locked dependencies with `npm ci` and provision a compatible Chromium
executable. The following are **operator environment settings for the standalone
CLI**, not business-query fields:

```sh
SCHEDULE_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
node --import tsx/esm services/maritime/schedule-collector/cli.ts query \
  --carrier OOCL --origin Shanghai --origin-country CN \
  --destination Vancouver --destination-country CA \
  --from 2026-09-28 --until 2026-10-25 --mode live
```

Use `--carrier HMM` for HMM. `SCHEDULE_BROWSER_HEADED=true` enables a visible
diagnostic browser. If the operator's existing network requires a loopback HTTP
proxy, set `SCHEDULE_BROWSER_PROXY_PORT` to its port; there is no proxy discovery,
rotation, remote proxy URL or credential input. A short-lived loopback CONNECT
bridge pins the approved source hosts to public IPv4 addresses, including
when using that upstream proxy. TLS and the browser sandbox stay enabled.
Fixed source paths, request/body/response budgets, a 90-second attempt deadline,
cancellation and the existing December 31, 2026 approval expiry remain enforced.

The September 27 public browser returned 4 HMM routes and 16 OOCL routes for the
four-week Shanghai–Vancouver window. The independent browser processes were
rejected by the sites in this environment. These are **not** CLI live successes;
both remain `implemented_unverified`, and source errors return `unavailable`.
The access matrix records the remaining per-carrier gates.

Maersk's standalone CLI returned five Shanghai–Vancouver sailings for September
28–October 25 using a fresh headed Chromium on September 27. Its form uses CY/CY,
40-foot high-cube dry equipment and preferred routes. The parser preserves the
official city/facility IDs, each port's timezone and distinct departures sharing
one source route ID. Deadline fields remain null with an explicit warning.
Headless geography requests failed in this environment; the tested command is:

```sh
SCHEDULE_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
SCHEDULE_BROWSER_HEADED=true \
node --import tsx/esm services/maritime/schedule-collector/cli.ts query \
  --carrier MSK --origin Shanghai --origin-country CN --origin-id 2IW9P6J7XAW72 \
  --destination Vancouver --destination-country CA --destination-id 365AMOGYI98RD \
  --from 2026-09-28 --until 2026-10-25 --mode live
```

Ningbo–Vancouver for the same four-week window returned four sailings. Use
`--origin Ningbo --origin-id 104T898SJZ6GU`; the official selector distinguishes
Ningbo (`CNNGB`) from Ningbo(zhoushan) (`CNZOS`), so an unselected name is ambiguous.

Maersk remains `implemented_unverified` in the registry pending target-host
acceptance and Portal integration. This local result does not establish headless, inland,
transshipment or production support. Source latency can exhaust the unchanged
120-second operation deadline. Its CLI reuses one anonymous page for the two
location lookups and schedule query, then closes it; no session survives the
operation. That browser session remains limited to 90 seconds. A fresh process
returned the same five records, and an October 5–18 query retained two of the
five source routes after departure filtering. Their saved source fields and
evidence hashes were read back.

## OOCL PDF source probe (development only)

OOCL also publishes service-loop PDFs. `tools/probe_oocl_pdf.py` downloads the
two observed PNW2/PNW3 files and matches ordered port calls on the same vessel.
It requires local `curl` and `pdfplumber` (tested with 0.11.10); it is not wired
into the collector or Portal and does not change carrier readiness.

```sh
python3 -I services/maritime/schedule-collector/tools/probe_oocl_pdf.py \
  --origin Shanghai --destination Vancouver \
  --from 2026-09-28 --until 2026-10-25
python3 -I tests/maritime/schedule-collector/test_oocl_pdf_probe.py
```

For an operator's existing loopback proxy, add `--proxy-port PORT`. This local
diagnostic does not provide the production connector's DNS pinning. Only the
fixed official PDF URLs are allowed; TLS checks stay on, redirects are rejected,
downloads are bounded to 2 MiB/25 seconds and eight PDF pages. Source dates must
be no more than seven days old. Missing names, changed layouts or ambiguous
calendar years fail closed. Years are inferred from the published update date
and port chronology; original date cells and source hashes remain in the output.

The September 27 live PNW2 probe returned two Shanghai–Vancouver records. PNW3
subsequently returned HTTP 403; three rows parsed from an earlier saved PDF are
document readback, not a fresh program success. Results always stay partial
`manual_review` (exit 4), or `unavailable` (exit 6) if both feeds fail. They do not
establish complete P2P coverage, transshipment, terminals, cutoffs or bookability.

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
The registry listed 12 carriers at this September 17 checkpoint; the current
September 27 additions and acceptance scope are recorded above.

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
official `ecomm.one-line.com` API. EMC/SML/YML use `transport/public-live.ts`
against exact anonymous endpoints, with no copied browser credentials.
OOCL metadata in `transport/oocl-live.ts` does not enable raw HTTP collection.
The optional browser path above is separately restricted to the observed forms.
No request is made when a connector is absent, the policy is not approved, the
target path differs, the request body has unapproved keys, or the client call
was already aborted.

## Running the delivered CLI on K12

These are historical instructions for the September 17 HTTP-only delivery.
The current optional browser collector also requires the locked `playwright-core`
dependency and an operator-provisioned compatible browser; the old dependency
link is not proof that those are installed. No resident service, queue or new
MCP registration is required.

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
unordered inland modes. It is not a verified Toronto query. OOCL was not usable
from the September 17 K12 path (HTTP 451 observed); HMM remained implemented but
unverified. This historical checkpoint predates the September 27 expansion.
ONE's document cutoff is deliberately not mapped to the shared
`si` field because the source label is broader than Shipping Instructions;
that non-key warning remains visible in `quality.warnings`.

Full evidence and the corrected COSCO receipt are under
`/home/autumn/Documents/Codex/handoffs/schedule-collector-20260917-01a0aaf7/`:
`completion-live-readback.json` and `cosco-integration-receipt.json`.
The ONE readbacks are the `one-*.json` files in the same directory.
The original receipt is retained as `cosco-integration-receipt-v1-history.json`;
its old Toronto acceptance wording is superseded.

To stop standalone collection, stop invoking this CLI. For the existing Portal
integration, disable the carrier in its deployment allowlist or disable schedule
live access. No database migration is needed; retain existing evidence.
