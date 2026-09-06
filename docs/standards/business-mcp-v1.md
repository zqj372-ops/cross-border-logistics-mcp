---
standard_id: business-mcp.v1
version: 2026-09-06.v1
priority: 91
audience: developer,reviewer,operator,caller
rule_ids: BUSINESS-MCP-001,BUSINESS-MCP-002,BUSINESS-MCP-003
---

# Business MCP v1

## BUSINESS-MCP-001

The explicit `business-v1` Runtime profile adds `customs.query`, `customs.tax.estimate`,
`quote.zone_preview`, `quote.ai_extract_preview` and `quote.freightcom_ltl.preview` to the
three native T0 tools. `application-mcp-exchange@2026-09-06.v1` requests only currently
granted tool names. Its short JWT includes `mcp_profile=business-v1` and exact `tool:`
scopes. Every HTTP request rechecks current application, tenant, credential and grants.
Legacy `t0-v1` and its `runtime-caller` Agent profile retain their exact three-tool set.
The `business-runtime-caller` Agent profile is available only to the new service identity;
standards access does not grant tool execution or Admin permissions.

## BUSINESS-MCP-002

Business handlers run through an isolated private HTTP Provider, the Runtime tool contract,
persistent audit and a signed module release. Never send long application keys to Provider
handlers. Preserve source readiness, versions, opaque references and manual review states.
Signatures attest the reviewed provider descriptor and SBOM; they do not attest a remote
source's live data or replace provider deployment verification. New module types still
require approved contracts; a release cannot install or import arbitrary code.

## BUSINESS-MCP-003

Call history stores only identity references, operation, request ID, status, time and duration.
It is bounded operational usage, not commercial billing. Customs history is read from the
source using a separately configured read delegation; historical snapshots are not current
rates. Missing history endpoints return unavailable. PostgreSQL mode shares Portal state,
Business grants/credentials, sessions and call records. SQLite is a single-instance mode;
switching back to stale SQLite after shared writes is forbidden. WeCom is not required.
