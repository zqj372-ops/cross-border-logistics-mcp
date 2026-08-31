---
standard_id: release-agent-adapters
version: 2026-08-21.v1
priority: 60
audience: operator,caller
rule_ids: RELEASE-ADAPTER-001,RELEASE-ADAPTER-002
---

# Agent Invocation Adapter Standard

## RELEASE-ADAPTER-001

An Agent client adapter declares transport, endpoint shape, authentication injection, session
requirements, tool approval behavior and resource discovery. It never places short-lived tokens,
tenant IDs or actor IDs in a shareable configuration file.

For the T0 runtime profile, the adapter declares only `cargo.calculate`,
`container.plan_summary` and `system.agent_context.get`, discovers the five fixed Agent
resources, and receives a short-lived JWT from the credential exchange boundary. The examples
remain templates pending real staging adaptation verification.

## RELEASE-ADAPTER-002

Client success means the MCP initialize/session handshake, tool discovery, resource discovery,
authorization and a deterministic readback all work. A reachable URL, a green liveness probe or
a locally rendered UI is not production readiness.
