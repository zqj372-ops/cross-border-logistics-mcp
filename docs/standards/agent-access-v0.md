---
standard_id: agent-access.v0
version: 2026-08-21.v0
priority: 80
audience: developer,reviewer,operator,caller
rule_ids: AGENT-PROFILE-001,AGENT-CONTEXT-001,AGENT-RESOURCE-001
---

# Agent Standard Access v0

## AGENT-PROFILE-001

Only registered profiles may be requested: module developer, platform developer, module
reviewer, release operator and runtime caller. Profiles select standard IDs, rule IDs and
context scopes. They do not accept arbitrary paths, URLs, credentials or tenant identifiers.

## AGENT-CONTEXT-001

`system.agent_context.get` is read-only. It returns a bounded projection of standards, rules,
module catalog entries and source hashes. The server injects tenant and actor context; tool input
cannot override identity. No customer record, raw certificate, or sensitive credential material
is returned.

## AGENT-RESOURCE-001

MCP resources use fixed `logistics://` URIs and are backed by the immutable generated Standard
Pack. A missing or invalid pack is `unavailable`; the server does not fall back to arbitrary cwd
Markdown. Resource content is descriptive evidence, not an authority claim for business data.
