# MCP Integration Deferred

No MCP tool, portal route, global registry entry, or production build entry is
added by this collector.

The following names remain candidates only:

- `maritime.schedule_collector`
- `maritime.schedule.search`
- `maritime.schedule.locations`
- `maritime.schedule.carriers`

A future integration must consume the same validated collector service, pass
through the shared envelope, use a server-injected tenant/actor/audit context,
and provide a real egress connector. It must not reimplement a crawler inside
the Gateway or expose raw evidence, captcha tokens, cookies, or arbitrary URLs.
