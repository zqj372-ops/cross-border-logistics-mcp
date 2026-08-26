import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("safe deployment artifacts", () => {
  it("keeps runtime secrets and state out of Git and Docker build contexts", () => {
    const gitignore = read(".gitignore");
    const dockerignore = read(".dockerignore");
    for (const pattern of [".env", "*.sqlite", "*.db", "*.log"]) {
      expect(gitignore).toContain(pattern);
      expect(dockerignore).toContain(pattern);
    }
    expect(gitignore).toContain("!.env.example");
    for (const pattern of [".git", "node_modules", "dist", "coverage"]) {
      expect(dockerignore).toContain(pattern);
    }
  });

  it("runs the complete local gates and image build in GitHub CI", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain("actions/checkout@v7");
    expect(workflow).toContain("actions/setup-node@v7");
    expect(workflow).toMatch(/node-version:\s*["']22\.13\.0["']/);
    for (const command of [
      "npm ci",
      "npm run build",
      "npm test -- --run",
      "npm run typecheck",
      "npm run lint",
      "npm run validate:schemas",
      "bash deploy/scripts/check-release.sh --fixture-only",
      "docker compose --env-file deploy/env.example -f deploy/compose.yml config",
      "docker build -f deploy/Dockerfile .",
    ]) {
      expect(workflow).toContain(command);
    }
  });

  it("defines a Node 22.13 multi-stage non-root image with a minimal runtime", () => {
    const dockerfile = read("deploy/Dockerfile");
    expect(dockerfile.match(/node:22\.13\.0-bookworm-slim/g)).toHaveLength(2);
    expect(dockerfile).toMatch(/FROM .* AS build/i);
    expect(dockerfile).toMatch(/USER\s+[^#\s]+/);
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("COPY apps/admin ./apps/admin");
    expect(dockerfile).toContain("COPY docs/agent ./docs/agent");
    expect(dockerfile).toContain("COPY docs/standards ./docs/standards");
    expect(dockerfile).toContain("COPY docs/rfcs/2026-08-21-module-runtime-agent-standard-access-v0.md");
    expect(dockerfile).toContain("COPY docs/superpowers/plans/2026-08-21-module-runtime-agent-access-plan.md");
    expect(dockerfile).toMatch(/COPY --from=build .*\/dist \.\/dist/);
    expect(dockerfile).toMatch(/COPY --from=build .*\/docs\/contracts .*\/docs\/contracts/);
    expect(dockerfile).toContain('CMD ["node", "dist/src/logistics_mcp/server/start.mjs"]');
    expect(dockerfile).not.toMatch(/COPY --from=build .*\/src \.\/src/);
    expect(dockerfile).not.toMatch(/COPY --from=build .*\/node_modules \.\/node_modules/);
    expect(dockerfile).not.toMatch(/--import\s+tsx\/esm/);
    expect(dockerfile).toMatch(/CMD .*dist\/.*\.mjs/);
    expect(dockerfile).not.toMatch(/(?:sk|ghp_|AIza|BEGIN .* PRIVATE KEY)/i);
  });

  it("wires the production JWKS verifier and durable state provider", () => {
    const start = read("src/logistics_mcp/server/start.ts");
    const riskCustomsRuntime = read("src/logistics_mcp/adapters/customs/riskcustoms-runtime.ts");
    const deployReadme = read("deploy/README.md");
    expect(start).toContain("MCP_JWT_ISSUER");
    expect(start).toContain("MCP_JWT_AUDIENCE");
    expect(start).toContain("tokenPolicy");
    expect(start).toContain("fileURLToPath(import.meta.url)");
    expect(start).toContain("resolve");
    expect(start).toContain("createProductionComposition");
    expect(start).toContain("createProductionTokenVerifier");
    expect(start).toContain("SqliteProductionStore");
    expect(start).toContain("createRiskCustomsApiAdapterFromEnvironment");
    expect(riskCustomsRuntime).toContain("MCP_RISK_CUSTOMS_AUTH_SECRET_FILE");
    expect(riskCustomsRuntime).toContain("MCP_RISK_CUSTOMS_ALLOWED_TENANTS");
    expect(riskCustomsRuntime).toContain("MCP_ALLOWED_OUTBOUND_HOSTS");
    expect(riskCustomsRuntime).toContain("O_NOFOLLOW");
    expect(riskCustomsRuntime).not.toContain("readFileSync");
    expect(riskCustomsRuntime).not.toMatch(/MCP_RISK_CUSTOMS_M2M_TOKEN\s*:/);
    expect(deployReadme).toContain("JWKS");
    expect(deployReadme).toContain("SQLite");
  });

  it("keeps the service internal and requires explicit data/security settings", () => {
    const compose = read("deploy/compose.yml");
    const riskCustomsOverride = read("deploy/compose.riskcustoms.override.yml.example");
    const env = read("deploy/env.example");
    expect(compose).toMatch(/expose:/);
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).toMatch(/healthcheck:/);
    for (const required of [
      "MCP_DATA_MODE",
      "MCP_JWT_ISSUER",
      "MCP_JWT_AUDIENCE",
      "MCP_JWKS_URL",
      "MCP_INSTANCE_ID",
      "MCP_TRUSTED_PROXY_ADDRESSES",
      "MCP_ALLOWED_ORIGINS",
      "MCP_ALLOWED_HOSTS",
      "MCP_ALLOWED_OUTBOUND_HOSTS",
    ]) {
      expect(compose).toContain(`\${${required}:?`);
      expect(compose).not.toContain(`\${${required}:-`);
    }
    for (const required of [
      "MCP_JWT_ISSUER",
      "MCP_JWT_AUDIENCE",
      "MCP_ALLOWED_ORIGINS",
      "MCP_ALLOWED_OUTBOUND_HOSTS",
      "MCP_DATA_MODE",
    ]) {
      expect(env).toContain(required);
      expect(compose).toContain(required);
    }
    expect(env).toContain("https://issuer.example.invalid/");
    expect(env).toContain("MCP_ALLOWED_OUTBOUND_HOSTS=issuer.example.invalid");
    expect(env).toContain("MCP_TRUSTED_PROXY_ADDRESSES=192.0.2.10");
    expect(compose).toContain("MCP_RISK_CUSTOMS_ENABLED");
    expect(compose).toContain("MCP_RISK_CUSTOMS_ALLOWED_TENANTS");
    expect(env).toContain("MCP_RISK_CUSTOMS_AUTH_SECRET_FILE");
    expect(env).toContain("MCP_RISK_CUSTOMS_ALLOWED_TENANTS");
    expect(riskCustomsOverride).toContain("/run/secrets/riskcustoms_m2m_token");
    expect(riskCustomsOverride).toContain("MCP_RISK_CUSTOMS_ALLOWED_TENANTS");
    expect(riskCustomsOverride).toContain("RISK_CUSTOMS_M2M_TOKEN_FILE");
    expect(compose).toContain("MCP_STATE_DB_PATH");
    expect(compose).toMatch(/\/var\/lib\/logistics-mcp/);
    expect(compose).toMatch(/volumes:/);
    expect(env).not.toMatch(/(?:sk_live|ghp_|AKIA|Bearer\s+[A-Za-z0-9_-]{20,})/i);
    expect(riskCustomsOverride).not.toMatch(/(?:sk_live|ghp_|AKIA|Bearer\s+[A-Za-z0-9_-]{20,})/i);
  });

  it("sets runtime request and header timeout guards", () => {
    const start = read("src/logistics_mcp/server/start.ts");
    expect(start).toContain("RUNTIME_MAX_BODY_BYTES");
    expect(start).toContain("requestTimeout");
    expect(start).toContain("headersTimeout");
    expect(start).toContain("body_too_large");
  });

  it("documents health/readiness and refuses fixture mode in production", () => {
    const deployReadme = read("deploy/README.md");
    expect(deployReadme).toMatch(/health/i);
    expect(deployReadme).toMatch(/readiness/i);
    expect(deployReadme).toMatch(/ready=false/i);
    expect(deployReadme).toMatch(/RiskCustoms/i);
    expect(deployReadme).toMatch(/fixtures.*production|production.*fixtures/i);
  });
});
