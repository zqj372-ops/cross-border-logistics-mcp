import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("state-aware client examples", () => {
  it("provides a Codex Streamable HTTP configuration without client-supplied identity", () => {
    const content = read("deploy/clients/codex.example.toml");
    expect(content).toContain("[mcp_servers.cross_border_logistics]");
    expect(content).toContain('url = "https://mcp.example.invalid/mcp"');
    expect(content).toContain('bearer_token_env_var = "LOGISTICS_MCP_BEARER_TOKEN"');
    expect(content).toContain("enabled_tools = [");
    expect(content).toContain('"cargo.calculate"');
    expect(content).toContain('"container.plan_summary"');
    expect(content).toContain('"system.agent_context.get"');
    expect(content).not.toMatch(/quote\.|customs\.|freightcom|save_draft|create_task|write_tools|approval/i);
    expect(content).toContain("短期 JWT");
    expect(content).toContain("待真实 staging 适配验证");
    expect(content).not.toMatch(/^(?:client|client_id|tenant_id|token|endpoint|tools|transport)\s*=/m);
  });

  it("keeps non-Codex examples explicitly non-importable and identity-free", () => {
    for (const file of [
      "deploy/clients/chatgpt.example.json",
      "deploy/clients/enterprise-assistant.example.json",
    ]) {
      const parsed = JSON.parse(read(file)) as Record<string, unknown>;
      expect(parsed.importable).toBe(false);
      expect(parsed).not.toHaveProperty("client_id");
      expect(parsed).not.toHaveProperty("tenant_id");
      expect(parsed).not.toHaveProperty("authentication.token");
      expect(parsed.allowed_tools).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "system.agent_context.get",
      ]);
      expect(JSON.stringify(parsed)).not.toMatch(/quote\.|customs\.|freightcom|save_draft|create_task|write_tools|approval/i);
      expect(JSON.stringify(parsed)).toContain("短期 JWT");
      expect(JSON.stringify(parsed)).toContain("待真实 staging 适配验证");
    }
  });

  it("uses only fake endpoints and contains no credential material", () => {
    for (const file of [
      "deploy/clients/chatgpt.example.json",
      "deploy/clients/codex.example.toml",
      "deploy/clients/enterprise-assistant.example.json",
    ]) {
      const content = read(file);
      expect(content).toContain("https://mcp.example.invalid/mcp");
      expect(content).not.toMatch(/(?:sk-|ghp_|AIza|-----BEGIN|Bearer\s+[A-Za-z0-9_-]{20,})/i);
      expect(content).not.toMatch(/commit_operation|send_quote|publish|booking\.submit/i);
    }
  });

  it("documents all five statuses and the non-sendable/theoretical boundaries", () => {
    const onboarding = read("docs/runbooks/client-onboarding.md");
    for (const status of ["success", "needs_input", "manual_review", "unavailable", "blocked"]) {
      expect(onboarding).toContain(status);
    }
    expect(onboarding).toContain("sendable=false");
    expect(onboarding).toContain("theoretical_only=true");
    expect(onboarding).toContain("精确三项");
    expect(onboarding).toContain("system.agent_context.get");
    expect(onboarding).toContain("旧的九业务工具");
  });
});
