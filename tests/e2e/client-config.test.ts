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
    expect(content).toContain('default_tools_approval_mode = "writes"');
    expect(content).toContain("enabled_tools = [");
    expect(content).toContain('"quote.create_pdf"');
    expect(content).not.toMatch(/^(?:client|client_id|tenant_id|token|endpoint|tools|transport)\s*=/m);
  });

  it("keeps non-Codex examples explicitly non-importable and identity-free", () => {
    for (const file of [
      "deploy/clients/chatgpt.example.json",
      "deploy/clients/enterprise-assistant.example.json",
    ]) {
      const parsed = JSON.parse(read(file)) as Record<string, unknown>;
      expect(parsed.importable).toBe(false);
      expect(JSON.stringify(parsed.allowed_tools)).toContain("quote.create_pdf");
      expect(parsed).not.toHaveProperty("client_id");
      expect(parsed).not.toHaveProperty("tenant_id");
      expect(parsed).not.toHaveProperty("authentication.token");
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
    expect(onboarding).toContain("system.get_data_status");
    expect(onboarding).toContain("十个工具");
    expect(onboarding).toContain("quote.create_pdf");
    expect(onboarding).toContain("正式连接未启用");
  });
});
