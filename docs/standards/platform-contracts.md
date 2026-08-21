---
standard_id: platform.contracts
version: 2026-08-21.v1
priority: 90
audience: developer,reviewer,operator,caller
rule_ids: CONTRACT-SCHEMA-001,STATUS-ENVELOPE-001
---

# Platform Contract Standard

## CONTRACT-SCHEMA-001

Tool inputs and outputs use Draft 2020-12-compatible schemas with explicit closed objects by
default. Amounts are decimal strings with ISO 4217 currency codes. Weight, length, volume and
quantity carry units. Every calculation result includes versions, source references,
assumptions, warnings, blockers and a trace.

## STATUS-ENVELOPE-001

The only response statuses are `success`, `needs_input`, `manual_review`, `blocked` and
`unavailable`. Missing or conflicting evidence remains non-success. A ready flag from an
upstream system is not inferred from a successful HTTP response; release readiness requires
independent dependency, data and comparable-snapshot evidence.
