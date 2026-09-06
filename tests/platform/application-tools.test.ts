import { describe, expect, it } from "vitest";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { authorizeTool, isExactT0ServiceIdentity, toolVisibleForContext } from "../../src/logistics_mcp/platform/rbac";

describe("versioned application MCP scope", () => {
  const claims = { tenant_id: "tenant_a", actor_id: "bkey_0123456789abcdef01234567", actor_role: "service", roles: ["service"], scopes: ["tool:customs.query"], client_id: "client_a", session_id: "session_a", expires_at: Math.floor(Date.now()/1000)+300 };
  it("admits approved business scopes only in the explicit new profile", () => {
    const context = parseExecutionContext({ ...claims, mcp_profile: "business-v1" });
    expect(authorizeTool(context, "customs.query")).toBe(true);
    expect(toolVisibleForContext(context, "quote.zone_preview")).toBe(false);
    expect(() => authorizeTool(context, "quote.zone_preview")).toThrow();
    expect(() => authorizeTool(context, "customs.query", "tenant_b")).toThrow();
  });
  it("preserves exact T0 boundaries and rejects mixed wildcard identities", () => {
    expect(isExactT0ServiceIdentity({ role: "service", roles: claims.roles, scopes: claims.scopes })).toBe(false);
    expect(() => authorizeTool(parseExecutionContext(claims), "customs.query")).toThrow();
    const context = parseExecutionContext({ ...claims, mcp_profile: "business-v1", scopes: [...claims.scopes, "platform:admin"] });
    expect(() => authorizeTool(context, "customs.query")).toThrow();
  });
});
