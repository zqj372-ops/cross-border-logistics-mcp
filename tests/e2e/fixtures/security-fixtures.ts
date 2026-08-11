import type { AuthClaims } from "../../../src/logistics_mcp/platform/context";

export const securityClaims: AuthClaims = {
  tenant_id: "tenant_demo_a",
  actor_id: "sales_demo",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["system:read", "quote:calculate", "quote:draft_write", "review:create_task"],
  client_id: "client_demo",
  session_id: "session_demo_a",
  expires_at: Math.floor(Date.now() / 1000) + 300,
};

export const fakeJwtClaims = {
  iss: "https://issuer.example.invalid/",
  aud: "logistics-mcp",
  sub: "sales_demo",
  tenant_id: "tenant_demo_a",
  actor_role: "sales",
  iat: Math.floor(Date.now() / 1000) - 5,
  exp: Math.floor(Date.now() / 1000) + 300,
};
