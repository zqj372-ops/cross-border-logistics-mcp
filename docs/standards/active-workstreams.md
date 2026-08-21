---
standard_id: active-workstreams
version: 2026-08-21.v1
priority: 80
audience: developer,reviewer,operator
rule_ids: WORKSTREAM-001
---

# Active Workstreams

## WORKSTREAM-001

Use `docs/agent/workstreams/current.json` for current ownership and escalation. Workstreams
must preserve unrelated changes and may not edit another workstream's source or tests. Shared
contract changes require a dated RFC describing compatibility, migration, tests and rollback.
