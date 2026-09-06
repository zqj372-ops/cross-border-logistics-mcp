import type { PortalIdentity } from "./contracts";

export interface PortalOidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly authorizationUrl: string;
}

export interface PortalIdentityProvider {
  readonly kind: "fixture" | "oidc";
  listFixtureIdentities?(): readonly PortalIdentity[];
  authenticateFixture?(identityId: string): Promise<PortalIdentity>;
  begin?(): Promise<PortalOidcTransaction>;
  complete?(input: { readonly code: string; readonly state: string; readonly transaction: PortalOidcTransaction }): Promise<PortalIdentity>;
}

export const FIXTURE_PORTAL_IDENTITIES: readonly PortalIdentity[] = Object.freeze([
  Object.freeze({ userId: "fixture-developer", displayName: "企业开发者", email: "developer@example.test", emailVerified: true, platformRole: null }),
  Object.freeze({ userId: "fixture-owner", displayName: "企业所有者", email: "owner@example.test", emailVerified: true, platformRole: null }),
  Object.freeze({ userId: "fixture-sales", displayName: "业务员", email: "sales@example.test", emailVerified: true, platformRole: null }),
  Object.freeze({ userId: "fixture-reviewer", displayName: "平台审核员", email: "reviewer@example.test", emailVerified: true, platformRole: "reviewer" }),
  Object.freeze({ userId: "fixture-operator", displayName: "平台运维管理员", email: "operator@example.test", emailVerified: true, platformRole: "operator" }),
]);

export class FixturePortalIdentityProvider implements PortalIdentityProvider {
  readonly kind = "fixture" as const;
  constructor(options: { readonly mode: "fixtures" | "production"; readonly loopback: boolean }) {
    if (options.mode !== "fixtures" || !options.loopback) throw new Error("fixture_identity_forbidden");
  }
  listFixtureIdentities(): readonly PortalIdentity[] { return FIXTURE_PORTAL_IDENTITIES; }
  authenticateFixture(identityId: string): Promise<PortalIdentity> {
    const identity = FIXTURE_PORTAL_IDENTITIES.find((candidate) => candidate.userId === identityId);
    if (!identity) return Promise.reject(new Error("fixture_identity_not_found"));
    return Promise.resolve(identity);
  }
}

export { OidcPortalIdentityProvider, createProductionPortalIdentityProvider, type OidcPortalIdentityProviderOptions } from "./production-identity";
