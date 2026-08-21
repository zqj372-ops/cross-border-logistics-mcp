---
standard_id: module-runtime.v0
version: 2026-08-21.v0
priority: 80
audience: developer,reviewer,operator
rule_ids: MOD-LIFE-001,MOD-CAP-001,MOD-TOOL-001,MOD-MOUNT-001
---

# Module Runtime v0

## MOD-LIFE-001

Modules are statically trusted at process startup. A manifest declares a stable module ID,
version, risk level, required capabilities and conformance standards. Mount is transactional:
if validation or registration fails, the host does not expose a partial catalog. Close releases
registrations in reverse order.

## MOD-CAP-001

A module receives only named capabilities from the host. It cannot request arbitrary filesystem,
network, tenant or credential handles. Missing required capabilities block mount; optional
capabilities are explicit and never silently replaced with a fixture.

## MOD-TOOL-001

Every contributed tool has a canonical name, closed input/output contract, permission, read/write
kind, risk level, handler and standard references. Duplicate canonical names are a mount error.
No generic operation, model-driven rule write or hidden cross-tenant query is a module capability.

## MOD-MOUNT-001

v0 does not perform remote installation or hot-plug. Module and tool versions are reported in the
catalog, and a catalog is not evidence that an upstream business source is ready or authoritative.
