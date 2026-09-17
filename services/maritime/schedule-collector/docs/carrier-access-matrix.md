# Carrier Access Matrix

Status date: 2026-09-17. This document records implementation status and
source-access evidence. It does not grant permission to collect or redistribute
any carrier data.

The static registry has 12 entries. Registration alone is not supported query coverage.

## Implemented Collector Status

| Carrier | Adapter/query status | Live status | Notes |
| --- | --- | --- | --- |
| OOCL | Parser and synthetic fixture implemented | Blocked pending trusted browser connector/captcha flow | Official public UI observations exist in the Mac handoff; no K12 live verification |
| COSCO | Live public HTTP adapter implemented | Vancouver path `live_verified` on K12, 2026-09-17; Toronto source echo conflict | Three public Vancouver queries completed; Toronto returned candidate records but its echoed destination identity did not match the selected location and is not accepted as verified; source terms are internal-use/on-demand, not a commercial redistribution license |
| ZIM | No live adapter | Blocked | Existing observation is an access denial; no source permission claimed |
| EVERGREEN | No live adapter | Unavailable / not verified | Current K12 and Mac public-entry navigation timed out; no valid source result, no confirmed zero-match result |
| HAPAG_LLOYD | No live adapter | Blocked | Existing observation is an access challenge; no source permission claimed |
| HMM | Adapter and live location lookup implemented | `implemented_unverified` | K12 location lookup succeeds; P2P returns access_restricted, exit 6 (2026-09-17) |
| MAERSK / MSC / MATSON / WHL / YML | No live adapter | Not live-verified | Maersk has an official credentialed schedule API; no current key or product access was verified by this task |
| ONE | Official anonymous public point-to-point API implemented | `live_verified` on K12, 2026-09-17 | Four live CLI queries covered Vancouver direct, Houston ocean transshipment, Toronto ocean plus rail, and a three-window 89-day Vancouver query |

COSCO and ONE are currently labeled `live_verified`. The status is limited to
the observed public query behavior and does not grant broader source or
redistribution rights.

## COSCO Verified Commands

```sh
node --import tsx/esm services/maritime/schedule-collector/cli.ts locations \
  --carrier COSCO --query Vancouver --country CA --mode live

node --import tsx/esm services/maritime/schedule-collector/cli.ts query \
  --carrier COSCO \
  --origin Shanghai --origin-country CN \
  --destination Vancouver --destination-country CA \
  --from 2026-09-17 --until 2026-10-14 \
  --routing any --mode live
```

## ONE Verified Commands

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

ONE's public endpoint is reached at `ecomm.one-line.com:443` through the
controlled Node HTTPS connector. The adapter sends fixed public query fields,
uses CY/CY by default, rejects arbitrary targets and headers, and does not use
a browser, login, cookie transfer, captcha bypass, or copied session.

## OOCL Observed Public Flow

The Mac handoff records a normal public browser flow with no login or manual
challenge:

- Entry page: `https://www.oocl.com/eng/ourservices/eservices/sailingschedule/Pages/default.aspx`
- Observed host/port: `moc.oocl.com:443`
- Observed location metadata GET:
  `/nj_prs_wss/mocss/secured/supportData/gsp/locationDetails`
- Observed point-to-point query POST:
  `/nj_prs_wss/mocss/secured/supportData/nsso/searchHubToHubRoute`
- Observed UI counts: 8 routes for Shanghai/Vancouver default 2 weeks, 22 routes
  for 6 weeks, and 36 routes for Shanghai/Toronto 6 weeks.

The observed response contains `data.standardRoutes[]`, `RouteId`,
`TransitTimeInMinute`, cutoff fields, and ordered legs. The Mac record also
states that the UI loads a CargoSmart captcha SDK and the query body contains a
non-empty captcha token. The collector does not copy, replay, or fabricate that
token.

## Reference Repository Boundaries

The five source-review candidates are not part of the supported collector:

- `ocean-pp-cli` is a third-party aggregator and does not filter voyages by
  carrier.
- `get-schedule-data` uses a third-party API and must preserve co-loading,
  sales-carrier, and shared-voyage identity; its test-data fallback is not
  acceptable.
- `maersk-mcp` exposes deadline/port-call operations, not full point-to-point
  schedule search.
- `COP` documents a credentialed COSCO official API; credentials and current
  commercial conditions are not available.
- `schedulesmcp-mcp` public demo data is synthetic and cannot count as a live
  carrier result.

## Required Before Live Support

- A trusted runner must provide a connector with DNS pinning, private-address
  rejection, redirect rejection, decompression/size bounds, cancellation, and
  per-attempt budget enforcement.
- OOCL live use must be driven through the official public browser flow or a
  separately authorized API. The required captcha token must come from the
  official flow; it must never be copied, logged, or passed through business
  input.
- K12 must repeat at least three queries, including one non-empty result, and
  perform a process restart verification before OOCL can become `live_verified`.
