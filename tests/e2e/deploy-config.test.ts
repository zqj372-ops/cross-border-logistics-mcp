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
    expect(dockerfile).toContain("COPY deploy/clients/freightclaw-auth-headers.mjs");
    expect(dockerfile).toContain("COPY deploy/clients/freightclaw-codex-setup.mjs");
    expect(dockerfile).toContain("COPY deploy/clients/freightclaw-keychain-helper.swift");
    expect(dockerfile).toContain("RUN rm -r ./dist/deploy/clients");
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

  it("packages an OCI-KMS-only ephemeral staging JWT issuer without widening the gateway contract", () => {
    const build = read("deploy/scripts/build.mjs");
    const dockerfile = read("deploy/Dockerfile");
    const issuer = read("deploy/scripts/issue-read-preview-staging-jwt.mjs");

    expect(build).toContain("deploy/scripts/issue-read-preview-staging-jwt.mjs");
    expect(build).toContain("dist/deploy/issue-read-preview-staging-jwt.mjs");
    expect(dockerfile).toContain("COPY deploy/scripts/issue-read-preview-staging-jwt.mjs");
    expect(issuer).toContain('READ_PREVIEW_JWT_ENVIRONMENT") !== "staging"');
    expect(issuer).toContain("issue-ephemeral-read-preview-jwt");
    expect(issuer).toContain('profile !== "t0-v1" && profile !== "read-preview-staging"');
    expect(issuer).toContain("ttlSeconds < 60 || ttlSeconds > 300");
    expect(issuer).toContain("ociCryptoConfigurationFromEnvironment");
    expect(issuer).toContain("configuration.backend !== \"oci-vault\"");
    expect(issuer).toContain("const originalConsoleLog = console.log;");
    expect(issuer).toContain("console.log = (...values) => console.error(...values);");
    expect(issuer.indexOf("await providers.close()"))
      .toBeLessThan(issuer.indexOf("process.stdout.write"));
    expect(issuer).not.toMatch(/(?:BEGIN .* PRIVATE KEY|lmcpk_|Bearer\s+[A-Za-z0-9_-]{20,})/i);
  });

  it("packages the secure Codex credential exchange and setup helpers", () => {
    const build = read("deploy/scripts/build.mjs");
    const packageJson = read("package.json");
    const authHelper = read("deploy/clients/freightclaw-auth-headers.mjs");
    const setup = read("deploy/clients/freightclaw-codex-setup.mjs");

    for (const asset of [
      "freightclaw-auth-headers.mjs",
      "freightclaw-codex-setup.mjs",
      "freightclaw-keychain-helper.swift",
    ]) {
      expect(build).toContain(asset);
    }
    expect(build).toContain('mkdirSync(resolve("dist/deploy/clients")');
    expect(packageJson).toContain('"setup:codex-client"');
    expect(authHelper).toContain("http");
    expect(authHelper).toContain('Authorization: `Bearer ${exchange.accessToken}`');
    expect(authHelper).not.toContain("LOGISTICS_MCP_BEARER_TOKEN");
    expect(setup).toContain('resolve(homedir(), ".codex")');
    expect(setup).toContain('"127.0.0.1"');
    expect(setup).toContain("storeKeychainCredential");
    expect(setup).not.toMatch(/localStorage|sessionStorage|document\.cookie/iu);
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
    expect(start).toContain("allowedHosts: [jwksHost]");
    expect(start).toContain("SqliteProductionStore");
    expect(start).not.toContain("createRiskCustomsApiAdapterFromEnvironment");
    expect(start).not.toContain("MCP_RISK_CUSTOMS_");
    expect(start).toContain("createT1ReadWorkerClient");
    expect(start).toContain("const READ_PREVIEW_RUNTIME_REQUEST_TIMEOUT_MS = 75_000");
    expect(start).toContain("requestTimeoutMs: productionRequestTimeoutMs - 1_000");
    expect(start).toContain("requestTimeoutMs: productionRequestTimeoutMs,");
    expect(start).toContain("buildT1WorkerEnvironment");
    expect(start).toContain('new URL("../t1-worker/start.mjs", import.meta.url)');
    expect(start).toContain("return createProductionComposition({");
    expect(start).toContain("profile,");
    expect(start).toMatch(
      /if \(mode === "fixtures"\)[\s\S]*createFreightcomRuntimeAdapterFromEnvironment\(\)[\s\S]*return createFixtureComposition/,
    );
    expect(deployReadme).toContain("JWKS");
    expect(deployReadme).toContain("SQLite");
    expect(deployReadme).toContain("3 个工具");
  });

  it("packages the isolated T1 read-preview worker without loading business adapters in the MCP entry", () => {
    const build = read("deploy/scripts/build.mjs");
    const start = read("src/logistics_mcp/server/start.ts");
    const worker = read("src/logistics_mcp/t1-worker/start.ts");

    expect(build).toContain("src/logistics_mcp/t1-worker/start.ts");
    expect(build).toContain("dist/src/logistics_mcp/t1-worker/start.mjs");
    expect(start).not.toContain("createQuotePreviewAdapterFromEnvironment");
    expect(start).not.toContain("createRiskCustomsApiAdapterFromEnvironment");
    expect(start).not.toContain('from "../adapters/quote/freightcom-runtime"');
    expect(worker).toContain("createQuotePreviewAdapterFromEnvironment");
    expect(worker).toContain("createRiskCustomsApiAdapterFromEnvironment");
    expect(worker).toContain("createFreightcomTestAdapterFromEnvironment");
    expect(worker).toContain("MAX_REQUEST_BYTES");
    expect(worker).toContain("MAX_RESPONSE_BYTES");
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
      "MCP_TRANSPORT_MODE",
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
    expect(env).toContain("MCP_TRANSPORT_MODE=stateless");
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
    for (const setting of [
      "ACCESS_GATEWAY_CRYPTO_BACKEND",
      "ACCESS_GATEWAY_OCI_AUTH_MODE",
      "ACCESS_GATEWAY_OCI_REGION",
      "ACCESS_GATEWAY_OCI_KMS_KEY_ID",
      "ACCESS_GATEWAY_OCI_KMS_CURRENT_KEY_VERSION_ID",
      "ACCESS_GATEWAY_OCI_KMS_PREVIOUS_KEY_VERSION_ID",
      "ACCESS_GATEWAY_OCI_KMS_CRYPTO_ENDPOINT",
      "ACCESS_GATEWAY_OCI_KMS_MANAGEMENT_ENDPOINT",
      "ACCESS_GATEWAY_OCI_PEPPER_SECRET_ID",
    ]) {
      expect(compose).toContain(setting);
      expect(env).toContain(setting);
    }
  });

  it("keeps the read-preview deployment separate, secret-file based and staging-only", () => {
    const override = read("deploy/compose.read-preview-staging.override.yml.example");
    const standalone = read("deploy/compose.read-preview-staging.yml");
    const example = read("deploy/read-preview-staging.env.example");
    const runbook = read("docs/runbooks/read-preview-staging.md");

    expect(override).toContain('MCP_RUNTIME_PROFILE: "read-preview-staging"');
    expect(override).toContain("MCP_QUOTE_PREVIEW_API_KEY_SECRET_FILE");
    expect(override).toContain("MCP_RISK_CUSTOMS_AUTH_SECRET_FILE");
    expect(override).toContain("MCP_FREIGHTCOM_TEST_AUTH_SECRET_FILE");
    expect(override).toContain("MCP_FREIGHTCOM_TEST_ALLOWED_TENANTS");
    expect(override).not.toMatch(/(?:sk_live|ghp_|AKIA|Bearer\s+[A-Za-z0-9_-]{20,})/i);
    expect(standalone).toContain("logistics-mcp-read-preview-staging");
    expect(standalone).toContain("logistics-mcp-read-preview-staging-state");
    expect(standalone).toContain('MCP_RUNTIME_PROFILE: "read-preview-staging"');
    expect(standalone).toContain('MCP_DATA_MODE: "production"');
    expect(standalone).toContain('MCP_TRANSPORT_MODE: "stateless"');
    expect(standalone).toContain("READ_PREVIEW_SECRET_DIR");
    expect(standalone).toContain("quote-preview-origin-map.json");
    expect(standalone).toContain("read_only: true");
    expect(standalone).toContain("no-new-privileges:true");
    expect(standalone).not.toContain("access-gateway");
    expect(example).toContain("MCP_FREIGHTCOM_TEST_ENABLED=false");
    expect(example).not.toMatch(/(?:sk_live|ghp_|AKIA|Bearer\s+[A-Za-z0-9_-]{20,})/i);
    expect(runbook).toContain("7 tools / 5 resources");
    expect(runbook).toContain("staging-only / NO-GO");
    expect(runbook).toContain("customs.ca.estimate");
    expect(runbook).toMatch(/固定[\s\S]*unavailable[\s\S]*零 HTTP/u);
    expect(runbook).toContain("不得用占位 secret");
  });

  it("ships a staging-only readiness alert probe and isolated edge rate limit", () => {
    const nginx = read("deploy/nginx/www.freightclaw.net.conf");
    const healthcheck = read("deploy/scripts/read-preview-healthcheck.sh");
    const service = read("deploy/systemd/freightclaw-read-preview-healthcheck.service");
    const timer = read("deploy/systemd/freightclaw-read-preview-healthcheck.timer");
    const alert = read("deploy/systemd/freightclaw-read-preview-alert@.service");

    expect(nginx).toContain("zone=freightclaw_read_preview:10m rate=2r/s");
    expect(nginx).toContain("location = /staging/mcp");
    expect(nginx).toContain("limit_req_status 429;");
    expect(nginx).toContain("proxy_pass http://100.95.166.107:18080/mcp");
    expect(nginx).toContain("proxy_read_timeout 80s;");
    expect(nginx).toContain("location = /staging/runtime/readyz");
    expect(healthcheck).toContain("freightclaw-read-preview-alert");
    expect(healthcheck).toContain('"status"[[:space:]]*:[[:space:]]*"ready"');
    expect(service).toContain("OnFailure=freightclaw-read-preview-alert@%n.service");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(timer).toContain("OnUnitActiveSec=1min");
    expect(alert).toContain("systemd-cat");
  });

  it("ships a deny-by-default four-node tailnet policy", () => {
    const guangzhouOverride = read("deploy/compose.read-preview-guangzhou.override.yml");
    const policy = JSON.parse(read("deploy/tailscale/four-node-policy.hujson")) as {
      grants: readonly { src: readonly string[]; dst: readonly string[]; ip: readonly string[] }[];
      tests: readonly { src: string; accept?: readonly string[]; deny?: readonly string[] }[];
    };

    expect(guangzhouOverride).toContain("platform: linux/amd64");
    expect(guangzhouOverride).toContain('host_ip: 100.95.166.107');
    expect(guangzhouOverride).toContain("READ_PREVIEW_SOURCE_SHA is required");
    expect(policy.grants).not.toContainEqual({ src: ["*"], dst: ["*"], ip: ["*"] });
    expect(policy.grants).toContainEqual({
      src: ["tag:gateway"],
      dst: ["tag:worker"],
      ip: ["tcp:18080"],
    });
    expect(policy.grants.some(({ ip }) => ip.includes("tcp:5432"))).toBe(false);
    expect(policy.tests.some(({ src, deny }) =>
      src === "tag:china-edge" && deny?.includes("freightclaw-guangzhou-worker:18080") === true,
    )).toBe(true);
  });

  it("documents the bandwidth-aware four-node MCP topology and rollback boundary", () => {
    const topology = read("docs/runbooks/four-node-mcp-topology.md");
    const deployReadme = read("deploy/README.md");
    const stagingRunbook = read("docs/runbooks/read-preview-staging.md");
    const stagingEnvironment = read("deploy/read-preview-staging.env.example");

    expect(deployReadme).toContain("four-node-mcp-topology.md");
    expect(stagingRunbook).toContain("four-node-mcp-topology.md");
    expect(stagingEnvironment).toContain("READ_PREVIEW_SOURCE_SHA=");
    for (const required of [
      "Oracle",
      "广州",
      "深圳",
      "Tokyo",
      "ARM64",
      "AMD64",
      "27.7 Mbps",
      "6.03 Mbps",
      "不是 SLA",
      "不跨节点复制原始 PDF",
      "staging-only / NO-GO",
      "tcp:5432",
      "回滚",
    ]) {
      expect(topology).toContain(required);
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
