# Self-hosted Authentik candidate

This stack replaces the planned Cloudflare Access administrator login with a dedicated Authentik
instance on the existing Oracle VM. It does not replace the current Cloudflare DNS/proxy path and it
does not make the Access Gateway production-eligible.

## Boundary

- Authentik is pinned to `2026.8.0` and PostgreSQL to `16-alpine`; both image references also include
  the immutable registry digests verified on the target when this candidate was created.
- PostgreSQL is private to the Authentik network. Only Authentik HTTP is published, on
  `127.0.0.1:19000`, for the initial SSH-tunnel setup and local diagnostics.
- The worker has no Docker socket. The embedded proxy outpost is declared by a reviewed blueprint.
- Host secret files live under `secrets/`, are generated on the target, and must remain owned by the
  Authentik runtime UID/GID `1000:1000` with mode `0400`.
- The host `blueprints/` directory must be `root:1000` mode `0750` and blueprint files `root:1000`
  mode `0640`, so the non-root Authentik worker can discover them without making them world-readable.
- The application is bound to the built-in `authentik Admins` group and emits fixed, short-lived
  management claims. The Gateway must still verify RS256, issuer, audience, time and the exact
  management tenant.
- Quote, customs, Freightcom and every business write operation remain absent from `t0-v1`.

## Target layout

```text
/data/logistics-mcp/infra/authentik/
  compose.yml
  blueprints/freightclaw-admin.yaml
  secrets/postgres-password
  secrets/authentik-secret-key
  state/postgresql/
  state/data/
  state/certs/
  state/templates/
```

The first setup page is reached only through an SSH tunnel:

```bash
ssh -N -L 19000:127.0.0.1:19000 oracle-new
```

Then open `http://127.0.0.1:19000/if/flow/initial-setup/` and set the `akadmin` password. Do not put
that password in chat, repository files, shell history or the Gateway environment.

Before exposing the console, verify the blueprint status, the provider discovery/JWKS endpoint,
RS256, exact claims, the administrator group binding and the embedded outpost. Nginx must protect
only `/admin`, `/access-console` and `/admin/api/v1/access/`; MCP, token exchange, JWKS and the public
homepage keep their existing boundaries.

## Backup and rollback

Back up PostgreSQL with `pg_dump` and archive the blueprint/config references before every change.
The same-host backup is only a single-node recovery copy; it is not an off-host disaster-recovery
copy. Rollback restores the previous Nginx file, restarts only the Access Gateway if its IdP settings
changed, and leaves Authentik PostgreSQL/data intact for incident evidence.
