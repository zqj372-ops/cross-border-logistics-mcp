import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("state-aware client examples", () => {
  it("uses only fake endpoint and identity values", () => {
    for (const file of [
      "deploy/clients/chatgpt.example.json",
      "deploy/clients/codex.example.toml",
      "deploy/clients/enterprise-assistant.example.json",
    ]) {
      const content = read(file);
      expect(content).toContain("https://mcp.example.invalid/mcp");
      expect(content).toContain("client_demo");
      expect(content).toContain("tenant_demo");
      for (const status of ["success", "needs_input", "manual_review", "unavailable", "blocked"]) {
        expect(content).toContain(status);
      }
      expect(content).toContain("sendable");
      expect(content).toContain("theoretical_only");
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
  });
});
