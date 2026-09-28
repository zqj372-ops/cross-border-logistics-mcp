# Carrier Access Matrix

Status date: 2026-09-27. This document records implementation status and
source-access evidence. It does not grant permission to collect or redistribute
any carrier data.

The static registry has 13 entries. Registration alone is not supported query coverage.

## Implemented Collector Status

| Carrier | Adapter/query status | Live status | Notes |
| --- | --- | --- | --- |
| OOCL | Parser and optional browser collector; separate PDF development probe | P2P `implemented_unverified`; PDF partial only | Public browser returned 16; standalone Chromium returned HTTP 451. PNW2 PDF probe returned 2 records, while the latest PNW3 download returned 403. PDF scope does not establish complete P2P coverage. No K12 acceptance |
| COSCO | Live public HTTP adapter implemented | Vancouver path `live_verified` on K12, 2026-09-17; Toronto source echo conflict | Three public Vancouver queries completed; Toronto returned candidate records but its echoed destination identity did not match the selected location and is not accepted as verified; source terms are internal-use/on-demand, not a commercial redistribution license |
| ZIM | No live adapter | Blocked | Existing observation is an access denial; no source permission claimed |
| EVERGREEN / EMC | Public HTTP form and HTML parser | `live_verified` locally, 2026-09-27 | Shanghai → Vancouver Sep 28–Oct 25 returned 5; shorter 8-day window returned 2; Portal returned the same 5 after location disambiguation |
| SML / SM Line | Public HTTP form and JSON parser | `live_verified` locally, 2026-09-27 | Same 28-day route returned 4 in CLI, official browser and Portal; 44-day CLI query returned 7 in two windows |
| YML / Yang Ming | Public P2P API | `live_verified` locally, 2026-09-27 | Same 28-day route returned 4 in controlled Node, official browser and Portal; a separate curl attempt returned 403 and is not the successful connector path |
| HAPAG_LLOYD / HPL | No live adapter | Public browser collection unverified; current entry challenged | Both the P2P entry and schedule-download page challenged; download-page HTTP request returned 403. User chose not to complete this human verification. No challenge solved; a missing API credential alone does not prove the public form is unusable |
| HMM | HTTP adapter and optional isolated browser form collector implemented | `implemented_unverified` | Public browser returned 4 again; controlled Node and independent browser processes received `Access Denied`. The adapter preserves that refusal as `access_restricted` |
| MAERSK / MSK | Parser and optional headed browser collector implemented | Standalone CLI passed observed local routes; registry remains `implemented_unverified` pending target-host/Portal acceptance | Shanghai–Vancouver Sep 28–Oct 25 returned 5, Oct 5–18 returned 2; Ningbo–Vancouver returned 4; a fresh process repeated Shanghai's 5. CY/CY, 40-foot high-cube dry, official preferred routes only. City/facility identities and timezones retained; deadlines not collected. Headless access and production remain unverified |
| MSC | No live adapter | Public browser returned 7; independent HTTP and fresh browser returned 403 | Shanghai CNSHA → Vancouver CAVAN, starting Sep 28, returned 7 CHINOOK routes; 3 depart by Oct 25. `/api/feature/tools/SearchSailingRoutes` returned actual vessel/voyage, dates, legs and cutoffs. Fresh anonymous browser bootstrap was denied as well; commercial-use permission remains unverified |
| WHL / Wan Hai | No live adapter | Public entry and PDF downloads blocked | Browser challenge; main-site CMT and Japan-site JH2 PDF URLs returned HTTP 200 HTML interstitials, not PDFs. No challenge solved or token replayed |
| MATSON | No live adapter | Not verified | Outside the user's nine-carrier expansion |
| ONE | Official anonymous public point-to-point API implemented | `live_verified` on K12, 2026-09-17 | Four live CLI queries covered Vancouver direct, Houston ocean transshipment, Toronto ocean plus rail, and a three-window 89-day Vancouver query |

COSCO, ONE, EVERGREEN, SML and YML are currently labeled `live_verified`. The status is limited to
the observed public query behavior and does not grant broader source or
redistribution rights.

## September 27 evidence and limits

The three new adapters reuse the controlled Node connector, evidence store and
existing Portal/CLI contracts. Exact paths and permitted form fields are in
`transport/public-live.ts`. Those three HTTP adapters require no new dependency.
The subsequent HMM/OOCL browser attempt adds `playwright-core` and keeps its
sessions ephemeral. No browser credential transfer, background crawl, booking
write or container-tracking endpoint was added.

- [Evergreen official entry](https://www.shipmentlink.com/) redirects to
  `ss.shipmentlink.com`; the actual result form is
  `/tvs2/jsp/TVS2_InteractiveScheduleRouting.jsp`.
- [SM Line point-to-point form](https://esvc.smlines.com/smline/CUP_HOM_3001.do)
  returns data through `/smline/CUP_HOM_3001GS.do`.
- [Yang Ming point-to-point form](https://www.yangming.com/en/esolution/schedule/point_to_point_search)
  uses `/api/P2P/GetLocations` and `/api/P2P/GetP2PRoutes`.
- [HMM official schedule](https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do)
  remains usable in the observed browser session but not the controlled program.
- [Hapag-Lloyd API onboarding](https://doc.api-portal.hlag.com/01.basic-knowledge/getting-started.html)
  documents application credentials and subscription access.
- [Maersk current Ocean Commercial Schedules](https://developer.maersk.com/api-catalogue/ocean-commercial-schedules/Learn-more)
  is distinct from the retired legacy Point-to-Point product.
- [Maersk public point-to-point form](https://www.maersk.com/schedules/pointToPoint)
  produced five actual routes without login or manual challenge. The visible
  first voyage was Vienna Express 638E, departing Oct 3 and arriving Oct 18.
  The public response uses `/routing-unified/routing/routings-queries`; facility
  details and deadlines are separate responses. Several departures share the
  same source route ID; the implemented parser distinguishes their ordered legs.
- [MSC commercial schedule test console](https://developerportal.msc.com/api-details/#api=DPO-DCSACommercialSchedulesAPI-V1&operation=get-v1-point-to-point)
  cannot establish real query coverage when its response ignores route and date.
- [MSC public schedule form](https://www.msc.com/en/search-a-schedule) currently
  returned seven actual routes after the user confirmed this one query under
  its displayed terms; the first was MSC YUKTA X / UK640A, Oct 17–Nov 5.
  Its [terms](https://www.msc.com/en/terms-and-conditions)
  limit commercial copying/reuse absent written permission; a single query
  confirmation must not be treated as a product redistribution license.

Ignored local observations are under `.runtime/maritime-expansion-20260927/`:
`emc-cli.json`, `emc-short-cli.json`, `sml-cli.json`, `sml-multi-cli.json`,
`yml-cli.json`, `yml-browser-result.json`, `hmm-locations.js`,
`hpl-public-locations.json`, `msk-public-locations.json`,
`msc-public-program.json`, `msc-v1_2-program.json` and `source-readback.json`.
They are local diagnostics, not fixtures or committed customer data. The readback
verified every new carrier record's vessel, voyage, ports and dates plus the
saved evidence hashes. Full dates remain estimated; missing timezones and
operating-carrier ownership remain unknown.

The subsequent independent-browser check is recorded in
`browser-collector-acceptance.json`, `hmm-cli-chromium.json` and
`oocl-cli-chromium.json`. Neither browser attempt produced accepted live records.
EMC/SML/YML were queried again and returned 5/4/4, with evidence hashes and
departure ranges checked; EMC had one timeout before the separate retry succeeded.

`msk-browser-result.json` and `msc-browser-result.json` retain the subsequent
official browser query responses; corresponding PNGs show the rendered result.
These browser observations are not independent collector acceptance. In the
initial MSK standalone probe, public script dependencies and a collector bug involving
oversized blocked telemetry were identified; the latter now has a regression
test. After that fix, the location request still failed with
`net::ERR_HTTP2_PROTOCOL_ERROR`, not a confirmed 401 or CAPTCHA refusal.
The direct pinned path reproduced that location failure; an HTTP/1.1 diagnostic
also did not complete the query. A local fake-proxy check kept an idle established
tunnel open beyond its 15-second handshake timeout, so that suspected cause was
not reproduced and no timeout change was made.

The [Maersk-domain MCP service](https://captainpeter-gptapp.centralus.prod.maersk.io/mcp)
responded to initialization and tool discovery as `captainpeter-tracking-proxy`
version 1.0.1. Its `get_schedules` returned only `{ "error": "none" } and a UI
resource, not sailing records. This is not an accepted non-interactive schedule
API. The actual responses and readback assertions are in `msk-mcp-probe.json`
and `continuation-source-readback.json`. No tracking, telemetry-capture or other
write tool was invoked.
The schedules widget's published bundle also constructs requests to the same
`api.maersk.com` location/routing/deadline endpoints. That initial inspection did
not establish a separate working path; subsequent headed collection is below.
`msc-standalone-public.json` records the subsequent independent HTTP 403; the
request copied only public form fields, never browser headers, cookies or tokens.

This Mac needed a test-only public DNS resolver because its default resolver
returned synthetic private addresses. No deployment or production-host network
verification was performed. Evergreen's empty-result page and broader
transshipment/inland routes remain unverified and fail closed where the source
shape or route identity cannot be established.

## Maersk controlled-browser follow-up

A fresh headed Chromium subsequently returned five actual routes through the
existing DNS-pinned tunnel. The unified CLI also returned `success` with five
records for Shanghai–Vancouver, September 28–October 25. This supersedes the
earlier failure-only assessment of independent MSK collection. The flow selects
the exact official CY location, waits for the form rather than all page scripts,
and allows the observed language resource with its bounded public query fields.
No user browser session, copied cookie, credential or solved challenge was used.

The source's city GEO IDs remain distinct from UN/LOCODE and RKST codes.
Facility responses supply actual terminal names and each port's timezone.
Departure filtering retains five sailings even when source route IDs repeat;
operating carrier stays unknown and deadlines are explicitly not collected.
Only observed CY/CY ocean shapes are accepted. Inland shapes fail closed.

`msk-standalone-pinned-success.json`, `msk-cli-success.json`,
`msk-cli-short-shared.json`, `msk-cli-restart.json` and `msk-cli-readback.json`
retain the local evidence. A fresh CLI process repeated the five-record result;
October 5–18 returned two after filtering five source routes. Ningbo–Vancouver
returned four for September 28–October 25, saved in `msk-cli-ningbo-selected.json`.
The official Ningbo GEO ID is `104T898SJZ6GU` (`CNNGB`); Ningbo(zhoushan) is a
separate candidate with `CNZOS`. The unselected CLI query correctly returned
`needs_input/ambiguous_location`. Every accepted record's fields and evidence
hash passed readback.
Earlier repeated page loads exhausted the 120-second deadline. The CLI now
reuses one anonymous page within that operation and closes it afterward; the
short-window browser run completed in 25.391 seconds, not a general SLA.
The 90-second browser session limit, DNS/TLS checks and request
budgets are unchanged. Headless operation, routes beyond those above and production Portal
assembly are not accepted; the registry conservatively stays
`implemented_unverified`.

## Alternative downloads checked on September 27

The [OOCL service-loop index](https://www.oocl.com/eng/ourservices/eservices/sailingschedule/schedulebyserviceloops/Pages/default.aspx)
links to [PNW2](https://www.oocl.com/SiteCollectionDocuments/OOCL/eServices/Sailing%20Schedule%20by%20Service/PNW2_LT.pdf)
and [PNW3](https://www.oocl.com/SiteCollectionDocuments/OOCL/eServices/Sailing%20Schedule%20by%20Service/PNW3_LT.pdf).
Both saved files state September 27, 2026. The standalone Python/curl probe
downloaded PNW2 and returned CMA CGM ALMAVIVA / CLJ/066 (Sep 28–Oct 13) and
CYPRESS / HSA/070 (Oct 10–Oct 21), Shanghai to Vancouver. Its SHA-256 is
`37f00f5578ac817084572d41e3139d2ca9a5beeda1668fe7be5cbd0719213a6c`.

The latest PNW3 download returned HTTP 403. Its previously saved PDF parsed
three matching rows, checked against the rendered pages, but that is local
document readback. Do not combine those with PNW2 as five fresh program results.
`oocl-pdf-program-result.json`, `oocl-pdf-pnw3-diagnostic.json` and
`oocl-pdf-readback.json` retain the distinction and source hashes in the ignored
runtime directory. The probe is development-only and always reports partial
`manual_review`; production DNS pinning and full P2P coverage are not provided.

The [HPL download form](https://www.hapag-lloyd.com/en/online-business/schedule/schedule-download-solution.html)
also showed a human-verification challenge; the user declined it for this run.
WHL's [main-site CMT PDF](https://www.wanhai.com/views/skd/SkdBySvcPdf.jsp?bound=N&srv_code=CMT)
and [Japan-site JH2 PDF](https://jp.wanhai.com/views/skd/SkdBySvcPdf.jsp?bound=N&srv_code=JH2)
returned HTML interstitials despite HTTP 200. Search-index copies are not current
source acceptance. Fresh MSC browser access remained HTTP 403, including a
diagnostic through the existing proxy's hostname routing. HMM remained denied
through that diagnostic path as well; neither changes the production transport.

The [HMM P2P OpenAPI document](https://apiportal.hmm21.com/api/apiopenapi/0e625472-af2f-4bbf-baa3-564160d8d60c)
specifies `x-Gateway-APIKey` for its separate official gateway. No key was
available or invoked. [MSC direct integration](https://www.msc.com/es/solutions/digital-solutions/direct-integrations)
describes onboarding and a Data Sharing Agreement before credentials; this is
an alternative access path, not proof that every public query requires payment.

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

- `ocean-pp-cli` is a third-party aggregator. Its current source can filter the
  separate `CarrierServices` list; that alone does not verify carrier ownership
  for every returned voyage or official nine-carrier coverage.
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
