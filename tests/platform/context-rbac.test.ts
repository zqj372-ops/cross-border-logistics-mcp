import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  parseExecutionContext,
  type AuthClaims,
} from "../../src/logistics_mcp/platform/context";
import {
  CrossTenantAccessError,
  ForbiddenError,
  authorizeTool,
} from "../../src/logistics_mcp/platform/rbac";

const claims = (role: AuthClaims["actor_role"]): AuthClaims => ({
  tenant_id: "tenant_demo",
  actor_id: `actor_${role}`,
  actor_role: role,
  roles: [role],
  scopes: [
    "knowledge:read",
    "system:read",
    "quote:calculate",
    "container:calculate",
    "tariff:read",
    "tariff:estimate",
  ],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

describe("platform context and RBAC", () => {
  it("binds tenant, actor, roles, and scopes from verified auth claims", () => {
    const context = parseExecutionContext(claims("sales"));

    expect(context).toMatchObject({
      tenantId: "tenant_demo",
      actorId: "actor_sales",
      role: "sales",
      clientId: "client_demo",
      sessionId: "session_demo",
      roles: ["sales"],
    });
    expect(context.scopes).toContain("quote:calculate");
  });

  it("rejects missing or expired authentication claims", () => {
    expect(() => parseExecutionContext({})).toThrow(AuthenticationError);
    expect(() =>
      parseExecutionContext({
        ...claims("sales"),
        expires_at: Math.floor(Date.now() / 1000) - 1,
      }),
    ).toThrow(/expired/i);
  });

  it("allows viewer read access but denies viewer write access", () => {
    const context = parseExecutionContext(claims("viewer"));

    expect(authorizeTool(context, "system.get_data_status")).toBe(true);
    expect(() => authorizeTool(context, "review.create_task")).toThrow(
      ForbiddenError,
    );
  });

  it("allows sales calculation and draft access but denies generic writes", () => {
    const context = parseExecutionContext({
      ...claims("sales"),
      scopes: [...claims("sales").scopes, "quote:draft_write"],
    });

    expect(authorizeTool(context, "quote.canada_final_mile.calculate")).toBe(
      true,
    );
    expect(authorizeTool(context, "quote.save_draft")).toBe(true);
    expect(() => authorizeTool(context, "rules.write")).toThrow(
      ForbiddenError,
    );
  });

  it("allows the Freightcom LTL preview only through quote calculation permission", () => {
    const sales = parseExecutionContext(claims("sales"));
    expect(authorizeTool(sales, "quote.freightcom_ltl.preview")).toBe(true);

    const withoutScope = parseExecutionContext({
      ...claims("sales"),
      scopes: ["system:read"],
    });
    expect(() => authorizeTool(withoutScope, "quote.freightcom_ltl.preview")).toThrow(
      ForbiddenError,
    );
  });

  it("blocks a target tenant that differs from the authenticated tenant", () => {
    const context = parseExecutionContext(claims("sales"));

    expect(() =>
      authorizeTool(context, "system.get_data_status", "tenant_other"),
    ).toThrow(CrossTenantAccessError);
  });

  it("does not accept a business payload as an authorization context", () => {
    const businessPayload = {
      tenant_id: "tenant_attacker",
      actor_id: "actor_attacker",
      actor_role: "admin",
      roles: ["admin"],
      scopes: ["quote:draft_write"],
    };

    expect(() => parseExecutionContext(businessPayload)).toThrow(
      AuthenticationError,
    );
  });
});
