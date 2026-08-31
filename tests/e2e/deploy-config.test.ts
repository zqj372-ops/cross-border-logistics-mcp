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
    expect(dockerfile.match(/node:22\.13\.0-bookworm-slim@sha256:f5a0871ab03b035c58bdb3007c3d177b001c2145c18e81817b71624dcf7d8bff/g)).toHaveLength(2);
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

  it("packages a fail-closed T0 deployment smoke without exposing credentials", () => {
    const build = read("deploy/scripts/build.mjs");
    const packageJson = read("package.json");
    const smoke = read("services/access-gateway/deployment-smoke.ts");

    expect(build).toContain("services/access-gateway/deployment-smoke.ts");
    expect(build).toContain("dist/services/access-gateway/deployment-smoke.mjs");
    expect(packageJson).toContain("smoke:t0-deployment");
    expect(smoke).toContain("DEPLOYMENT_SMOKE_CONFIRM");
    expect(smoke).toContain("DEPLOYMENT_SMOKE_ENVIRONMENT");
    expect(smoke).toContain("assertCandidateSyntheticWriteTarget");
    expect(smoke).toContain("run-synthetic-write");
    expect(smoke).toContain('name: "cargo.calculate"');
    expect(smoke).toContain('name: "container.plan_summary"');
    expect(smoke).toContain("revokeCredential");
    expect(smoke).toContain("setTenantStatus");
    expect(smoke).toContain("terminateSession");
    expect(smoke).toContain("tenant_isolation_http_status");
    expect(smoke).toContain("revoked_exchange_http_status");
    expect(smoke).not.toMatch(/console\.(?:log|error)\([^\n]*(?:apiKey|accessToken|authorization)/i);
  });

  it("packages the bounded T0 deployment load runner", () => {
    const build = read("deploy/scripts/build.mjs");
    const packageJson = read("package.json");
    const load = read("services/access-gateway/deployment-load.ts");

    expect(build).toContain("services/access-gateway/deployment-load.ts");
    expect(build).toContain("dist/services/access-gateway/deployment-load.mjs");
    expect(packageJson).toContain("load:t0-deployment");
    expect(load).toContain("DEPLOYMENT_LOAD_CONFIRM");
    expect(load).toContain("DEPLOYMENT_LOAD_ENVIRONMENT");
    expect(load).toContain("assertCandidateSyntheticWriteTarget");
    expect(load).toContain("run-synthetic-load");
    expect(load).toContain("revokeCredential");
    expect(load).toContain("setTenantStatus");
    expect(load).toContain("terminateSession");
    expect(load).toContain("readiness_failures");
    expect(load).not.toMatch(/console\.(?:log|error)\([^\n]*(?:apiKey|accessToken|authorization)/i);
  });

  it("copies every registered Agent source into the image build stage", () => {
    const dockerfile = read("deploy/Dockerfile");
    const registry = JSON.parse(read("docs/agent/index.json")) as {
      readonly standards: readonly { readonly path: string }[];
      readonly profiles: readonly { readonly path: string }[];
    };
    const buildCopies = [...dockerfile.matchAll(/^COPY\s+(?!--from=)(\S+)\s+(\S+)$/gm)].map(
      (match) => ({
        source: match[1]!.replace(/^\.\//, "").replace(/\/$/, ""),
        destination: match[2]!.replace(/^\.\//, "").replace(/\/$/, ""),
      }),
    );
    const registeredPaths = [
      "docs/agent/index.json",
      ...registry.standards.map(({ path }) => path),
      ...registry.profiles.map(({ path }) => path),
    ];

    for (const registeredPath of registeredPaths) {
      expect(
        buildCopies.some(
          ({ source, destination }) =>
            source === destination &&
            (registeredPath === source || registeredPath.startsWith(`${source}/`)),
        ),
        `deploy/Dockerfile does not copy registered Agent source: ${registeredPath}`,
      ).toBe(true);
    }
  });

  it("wires the T0 production profile, JWKS verifier and durable state provider", () => {
    const start = read("src/logistics_mcp/server/start.ts");
    const deployReadme = read("deploy/README.md");
    expect(start).toContain("MCP_RUNTIME_PROFILE");
    expect(start).toContain("MCP_JWT_ISSUER");
    expect(start).toContain("MCP_JWT_AUDIENCE");
    expect(start).toContain("tokenPolicy");
    expect(start).toContain("fileURLToPath(import.meta.url)");
    expect(start).toContain("resolve");
    expect(start).toContain("createProductionComposition");
    expect(start).toContain("createProductionTokenVerifier");
    expect(start).toContain('splitSetting("MCP_ALLOWED_OUTBOUND_HOSTS", "")');
    expect(start).toContain("allowedHosts: allowedOutboundHosts");
    expect(start).not.toContain("allowedHosts: [jwksHost]");
    expect(start).toContain("SqliteProductionStore");
    expect(start).not.toContain("createRiskCustomsApiAdapterFromEnvironment");
    expect(start).not.toContain("MCP_RISK_CUSTOMS_");
    expect(start).toContain("return createProductionComposition({");
    expect(start).toContain("profile,");
    expect(start).toMatch(
      /if \(mode === "fixtures"\)[\s\S]*createFreightcomRuntimeAdapterFromEnvironment\(\)[\s\S]*return createFixtureComposition/,
    );
    expect(deployReadme).toContain("JWKS");
    expect(deployReadme).toContain("SQLite");
    expect(deployReadme).toContain("3 个工具");
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
      "MCP_RUNTIME_PROFILE",
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
    expect(env).toContain("MCP_RUNTIME_PROFILE=t0-v1");
    expect(env).toContain("MCP_ALLOWED_OUTBOUND_HOSTS=issuer.example.invalid");
    expect(env).toContain("MCP_TRUSTED_PROXY_ADDRESSES=192.0.2.10");
    expect(compose).not.toContain("MCP_RISK_CUSTOMS_");
    expect(compose).not.toContain("MCP_FREIGHTCOM_");
    expect(env).not.toContain("MCP_RISK_CUSTOMS_");
    expect(env).not.toContain("MCP_FREIGHTCOM_");
    expect(riskCustomsOverride).toContain("/run/secrets/riskcustoms_m2m_token");
    expect(riskCustomsOverride).toContain("MCP_RISK_CUSTOMS_ALLOWED_TENANTS");
    expect(riskCustomsOverride).toContain("RISK_CUSTOMS_M2M_TOKEN_FILE");
    expect(compose).toContain("MCP_STATE_DB_PATH");
    expect(compose).toMatch(/\/var\/lib\/logistics-mcp/);
    expect(compose).toMatch(/volumes:/);
    expect(compose).toContain('restart: "unless-stopped"');
    expect(compose).toContain("/readyz");
    expect(compose).not.toContain("fetch('http://127.0.0.1:8080/healthz')");
    expect(env).not.toMatch(/(?:sk_live|ghp_|AKIA|Bearer\s+[A-Za-z0-9_-]{20,})/i);
    expect(riskCustomsOverride).not.toMatch(/(?:sk_live|ghp_|AKIA|Bearer\s+[A-Za-z0-9_-]{20,})/i);

    for (const setting of [
      "ACCESS_GATEWAY_ADMIN_IDENTITY_MODE",
      "ACCESS_GATEWAY_ADMIN_ALLOWED_EMAILS",
      "ACCESS_GATEWAY_ADMIN_ALLOWED_SUBJECTS",
      "ACCESS_GATEWAY_ADMIN_MAX_TOKEN_AGE_SECONDS",
    ]) {
      expect(compose).toContain(setting);
      expect(env).toContain(setting);
    }
  });

  it("documents the exact Cloudflare Access assertion-to-admin mapping boundary", () => {
    const deployReadme = read("deploy/README.md");
    expect(deployReadme).toContain("Cf-Access-Jwt-Assertion");
    expect(deployReadme).toContain("cloudflare-access");
    expect(deployReadme).toContain("ACCESS_GATEWAY_ADMIN_ALLOWED_EMAILS");
    expect(deployReadme).toContain("ACCESS_GATEWAY_ADMIN_ALLOWED_SUBJECTS");
    expect(deployReadme).toMatch(/service token[\s\S]*拒绝|拒绝[\s\S]*service token/iu);
    expect(deployReadme).toContain("显式 email 映射");
  });

  it("sets runtime request and header timeout guards", () => {
    const start = read("src/logistics_mcp/server/start.ts");
    expect(start).toContain("RUNTIME_MAX_BODY_BYTES");
    expect(start).toContain("requestTimeout");
    expect(start).toContain("headersTimeout");
    expect(start).toContain("body_too_large");
  });

  it("documents T0 health/readiness and refuses fixture or business adapters in production", () => {
    const deployReadme = read("deploy/README.md");
    expect(deployReadme).toMatch(/health/i);
    expect(deployReadme).toMatch(/readiness/i);
    expect(deployReadme).toMatch(/ready=false/i);
    expect(deployReadme).toMatch(/RiskCustoms/i);
    expect(deployReadme).toMatch(/不注册|未注册/);
    expect(deployReadme).toContain("t0-v1");
    expect(deployReadme).toMatch(/fixture[\s\S]*production|production[\s\S]*fixture/i);
  });

  it("documents Freightcom fixture initialization and activation before provider calls", () => {
    const runbook = read("docs/runbooks/freightcom-test-mcp.md");
    const initialize = runbook.indexOf("npm run init:control-fixture");
    const start = runbook.indexOf("npm run start:freightcom-test-mcp");
    const register = runbook.indexOf("登记选中模块");
    const preview = runbook.indexOf("生成预览");
    const approval = runbook.indexOf("提交审批");
    const publish = runbook.indexOf("发布并读回");
    const providerCall = runbook.indexOf("adapter 执行 `POST /rate`");

    expect(initialize).toBeGreaterThan(-1);
    expect(initialize).toBeLessThan(start);
    expect(runbook).toContain("http://127.0.0.1:8080/admin/?fixture=1");
    expect(runbook).toContain("freightcom-ltl");
    expect(register).toBeGreaterThan(start);
    expect(register).toBeLessThan(preview);
    expect(preview).toBeLessThan(approval);
    expect(approval).toBeLessThan(publish);
    expect(publish).toBeLessThan(providerCall);
    expect(runbook).toContain("module_policy_not_released");
    expect(runbook).toContain("active_verified");
    expect(runbook).toContain("latest_readback.status=verified");
  });
});
