FROM node:22.13.0-bookworm-slim@sha256:f5a0871ab03b035c58bdb3007c3d177b001c2145c18e81817b71624dcf7d8bff AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY services ./services
COPY apps/admin ./apps/admin
COPY apps/access-console ./apps/access-console
COPY docs/contracts ./docs/contracts
COPY docs/agent ./docs/agent
COPY docs/standards ./docs/standards
COPY docs/rfcs/2026-08-21-module-runtime-agent-standard-access-v0.md ./docs/rfcs/2026-08-21-module-runtime-agent-standard-access-v0.md
COPY docs/rfcs/2026-08-22-admin-control-state-dto-v1.md ./docs/rfcs/2026-08-22-admin-control-state-dto-v1.md
COPY docs/rfcs/2026-08-22-writable-module-control-plane-v1.md ./docs/rfcs/2026-08-22-writable-module-control-plane-v1.md
COPY docs/rfcs/2026-08-23-readback-attempt-finalization-v1.md ./docs/rfcs/2026-08-23-readback-attempt-finalization-v1.md
COPY docs/rfcs/2026-08-27-t0-production-profile-v1.md ./docs/rfcs/2026-08-27-t0-production-profile-v1.md
COPY docs/rfcs/2026-08-27-credential-exchange-v1.md ./docs/rfcs/2026-08-27-credential-exchange-v1.md
COPY docs/rfcs/2026-09-02-mcp-server-architecture-v1.md ./docs/rfcs/2026-09-02-mcp-server-architecture-v1.md
COPY docs/rfcs/2026-09-02-read-preview-staging-profile-v1.md ./docs/rfcs/2026-09-02-read-preview-staging-profile-v1.md
COPY docs/superpowers/plans/2026-08-21-module-runtime-agent-access-plan.md ./docs/superpowers/plans/2026-08-21-module-runtime-agent-access-plan.md
COPY deploy/scripts/build.mjs ./deploy/scripts/build.mjs
COPY deploy/scripts/init-access-gateway.mjs ./deploy/scripts/init-access-gateway.mjs
COPY deploy/scripts/migrate-access-gateway-postgres.mjs ./deploy/scripts/migrate-access-gateway-postgres.mjs
COPY deploy/scripts/issue-read-preview-staging-jwt.mjs ./deploy/scripts/issue-read-preview-staging-jwt.mjs
COPY deploy/clients/freightclaw-auth-headers.mjs ./deploy/clients/freightclaw-auth-headers.mjs
COPY deploy/clients/freightclaw-codex-setup.mjs ./deploy/clients/freightclaw-codex-setup.mjs
COPY deploy/clients/freightclaw-keychain-helper.swift ./deploy/clients/freightclaw-keychain-helper.swift
COPY tsconfig.json .
COPY vitest.config.ts .
RUN npm run build
RUN rm -r ./dist/deploy/clients
RUN npm run typecheck

FROM node:22.13.0-bookworm-slim@sha256:f5a0871ab03b035c58bdb3007c3d177b001c2145c18e81817b71624dcf7d8bff AS runtime

ENV NODE_ENV=production
ENV MCP_PORT=8080
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/docs/contracts ./docs/contracts
COPY --from=build /app/deploy/scripts/init-access-gateway.mjs ./deploy/scripts/init-access-gateway.mjs
COPY --from=build /app/deploy/scripts/migrate-access-gateway-postgres.mjs ./deploy/scripts/migrate-access-gateway-postgres.mjs

RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin mcp \
  && mkdir -p /var/lib/logistics-mcp /var/lib/access-gateway \
  && chown -R mcp:mcp /app /var/lib/logistics-mcp /var/lib/access-gateway

USER mcp
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/src/logistics_mcp/server/start.mjs"]
