FROM node:22.13.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY apps/admin ./apps/admin
COPY docs/contracts ./docs/contracts
COPY docs/agent ./docs/agent
COPY docs/standards ./docs/standards
COPY docs/rfcs/2026-08-21-module-runtime-agent-standard-access-v0.md ./docs/rfcs/2026-08-21-module-runtime-agent-standard-access-v0.md
COPY docs/superpowers/plans/2026-08-21-module-runtime-agent-access-plan.md ./docs/superpowers/plans/2026-08-21-module-runtime-agent-access-plan.md
COPY deploy/scripts/build.mjs ./deploy/scripts/build.mjs
COPY tsconfig.json .
COPY vitest.config.ts .
RUN npm run build
RUN npm run typecheck

FROM node:22.13.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV MCP_PORT=8080
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/docs/contracts ./docs/contracts

RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin mcp \
  && mkdir -p /var/lib/logistics-mcp \
  && chown -R mcp:mcp /app /var/lib/logistics-mcp

USER mcp
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/src/logistics_mcp/server/start.mjs"]
