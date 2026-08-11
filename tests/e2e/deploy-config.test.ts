import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("safe deployment artifacts", () => {
  it("defines a Node 22 multi-stage non-root image with a minimal runtime", () => {
    const dockerfile = read("deploy/Dockerfile");
    expect(dockerfile).toMatch(/node:22/i);
    expect(dockerfile).toMatch(/FROM .* AS build/i);
    expect(dockerfile).toMatch(/USER\s+[^#\s]+/);
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toMatch(/COPY --from=build .*\/dist \.\/dist/);
    expect(dockerfile).toMatch(/COPY --from=build .*\/docs\/contracts .*\/docs\/contracts/);
    expect(dockerfile).toContain('CMD ["node", "dist/src/logistics_mcp/server/start.mjs"]');
    expect(dockerfile).not.toMatch(/COPY --from=build .*\/src \.\/src/);
    expect(dockerfile).not.toMatch(/COPY --from=build .*\/node_modules \.\/node_modules/);
    expect(dockerfile).not.toMatch(/--import\s+tsx\/esm/);
    expect(dockerfile).toMatch(/CMD .*dist\/.*\.mjs/);
    expect(dockerfile).not.toMatch(/(?:sk|ghp_|AIza|BEGIN .* PRIVATE KEY)/i);
  });

  it("does not claim production JWT verification without an injected verifier", () => {
    const start = read("src/logistics_mcp/server/start.ts");
    const deployReadme = read("deploy/README.md");
    expect(start).toContain("MCP_JWT_ISSUER");
    expect(start).toContain("MCP_JWT_AUDIENCE");
    expect(start).toContain("tokenPolicy");
    expect(start).toContain("fileURLToPath(import.meta.url)");
    expect(start).toContain("resolve");
    expect(start).toMatch(/production token verifier.*configured|token verifier.*gateway/i);
    expect(deployReadme).toMatch(/no built-in JWT signature verifier|没有内置 JWT 签名验证器/i);
    expect(deployReadme).toContain("/mcp` 请求在验证器接入前会被拒绝");
  });

  it("keeps the service internal and requires explicit data/security settings", () => {
    const compose = read("deploy/compose.yml");
    const env = read("deploy/env.example");
    expect(compose).toMatch(/expose:/);
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).toMatch(/healthcheck:/);
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
    expect(env).toContain("tenant_demo");
    expect(env).toContain("CHANGE_ME_IN_SECRET_STORE");
    expect(env).not.toMatch(/(?:sk_live|ghp_|AKIA|Bearer\s+[A-Za-z0-9_-]{20,})/i);
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
