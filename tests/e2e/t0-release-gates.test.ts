import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("T0 single-region release gates", () => {
  it("preserves the existing public homepage and isolates the access console", () => {
    const nginx = read("deploy/nginx/www.freightclaw.net.conf");

    expect(nginx).toContain("location = /access-console {");
    expect(nginx).toContain("location ^~ /access-console/ {");
    expect(nginx).toMatch(
      /location = \/access-console \{[\s\S]*?proxy_pass http:\/\/logistics-mcp-access-gateway:8081;/u,
    );
    expect(nginx).toMatch(
      /location \^~ \/access-console\/ \{[\s\S]*?proxy_pass http:\/\/logistics-mcp-access-gateway:8081;/u,
    );
    expect(nginx).toMatch(
      /location \/ \{\s*root \/usr\/share\/nginx\/html;\s*try_files \$uri \$uri\/ =404;\s*\}/u,
    );
    expect(nginx).not.toContain(
      "location / {\n        proxy_pass http://logistics-mcp-access-gateway:8081;",
    );
  });

  it("requires an Edge-injected administrator identity for every backend route", () => {
    const nginx = read("deploy/nginx/www.freightclaw.net.conf");

    expect(nginx).toMatch(
      /map \$http_cf_access_jwt_assertion \$freightclaw_admin_edge_authenticated \{\s*default 1;\s*"" 0;\s*\}/u,
    );
    expect(nginx).toMatch(
      /map \$http_cf_access_jwt_assertion \$freightclaw_admin_authorization \{\s*default "Bearer \$http_cf_access_jwt_assertion";\s*"" "";\s*\}/u,
    );

    for (const location of [
      "location = /admin {",
      "location = /admin/ {",
      "location ^~ /admin/api/v1/access/ {",
      "location = /access-console {",
      "location ^~ /access-console/ {",
    ]) {
      const start = nginx.indexOf(location);
      expect(start, `${location} is missing`).toBeGreaterThanOrEqual(0);
      const end = nginx.indexOf("\n    }", start);
      expect(nginx.slice(start, end)).toContain(
        "if ($freightclaw_admin_edge_authenticated = 0) { return 401; }",
      );
    }

    expect(nginx).toMatch(
      /location = \/admin \{[\s\S]*?return 308 \/access-console\/;/u,
    );
    expect(nginx).toMatch(
      /location = \/admin\/ \{[\s\S]*?return 308 \/access-console\/;/u,
    );
  });

  it("hardens the runtime container and routes traffic by readiness", () => {
    const compose = read("deploy/compose.yml");

    expect(compose).toContain('MCP_RUNTIME_PROFILE: "${MCP_RUNTIME_PROFILE:?');
    expect(compose).toContain('MCP_TRANSPORT_MODE: "${MCP_TRANSPORT_MODE:?');
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toMatch(/cap_drop:\s*\n\s*- ALL/);
    expect(compose).toContain("pids_limit:");
    expect(compose).toMatch(/resources:\s*\n\s*limits:\s*\n\s*cpus:/);
    expect(compose).toContain("memory:");
    expect(compose).toContain("/readyz");
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).not.toContain("MCP_RISK_CUSTOMS_");
    expect(compose).not.toContain("MCP_FREIGHTCOM_");
  });

  it("requires exact release, recovery, load, alert and rollback evidence", () => {
    const release = read("docs/runbooks/t0-release.md");
    const rollback = read("docs/runbooks/t0-rollback.md");
    const evidence = read("docs/runbooks/t0-single-region-evidence.template.md");

    for (const marker of [
      "source SHA",
      "image digest",
      "Standard Pack digest",
      "config hash",
      "tools/list",
      "resources/list",
      "backup",
      "restore",
      "50 concurrency",
      "alert",
      "rollback",
      "[待实际执行]",
    ]) {
      expect(`${release}\n${evidence}`).toContain(marker);
    }
    expect(release).toContain("cargo.calculate");
    expect(release).toContain("container.plan_summary");
    expect(release).toContain("system.agent_context.get");
    expect(release).toContain("NO-GO");
    expect(rollback).toContain("previous image digest");
    expect(rollback).toContain("previous config hash");
    expect(rollback).toContain("previous Standard Pack digest");
    expect(rollback).toContain("3 tools / 5 resources");
    expect(rollback).toContain("[待实际执行]");
    expect(evidence).toContain("real IdP");
    expect(evidence).toContain("KMS / Secret Manager");
    expect(evidence).toContain("Edge denylist");
    expect(evidence).toContain("RPO");
    expect(evidence).toContain("RTO");
  });

  it("includes T0 artifacts in the offline release preflight", () => {
    const script = read("deploy/scripts/check-release.sh");

    for (const artifact of [
      "docs/rfcs/2026-08-27-t0-production-profile-v1.md",
      "docs/rfcs/2026-08-27-credential-exchange-v1.md",
      "docs/rfcs/2026-09-02-mcp-server-architecture-v1.md",
      "docs/runbooks/t0-release.md",
      "docs/runbooks/t0-rollback.md",
      "docs/runbooks/t0-single-region-evidence.template.md",
    ]) {
      expect(script).toContain(artifact);
    }
  });
});
