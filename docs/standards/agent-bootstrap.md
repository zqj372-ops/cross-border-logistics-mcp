---
standard_id: agent.bootstrap
version: 2026-08-21.v1
priority: 100
audience: developer,reviewer,operator,caller
rule_ids: AGENT-BOOT-001,SEC-BOUNDARY-001
---

# Agent Bootstrap Standard

## AGENT-BOOT-001

The canonical machine-readable entry is `docs/agent/index.json`. Resolve an Agent profile
before using repository conventions. A profile is an allowlist, not a request to discover
arbitrary files.

## SEC-BOUNDARY-001

The MCP service is independent of any Agent host or harness. Customer records, credentials,
production endpoints, current rates, customs evidence and deployment state are authoritative
only in their explicitly controlled systems. A screenshot, chat transcript, fixture or model
output cannot promote itself to authority.
