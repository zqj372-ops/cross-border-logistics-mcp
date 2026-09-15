import { describe, expect, it } from "vitest";
import { InMemoryPortalSessionStore, PortalSessionManager, parsePortalSessionCookie } from "../../services/access-gateway/portal/session";
import type { Membership, PortalIdentity } from "../../services/access-gateway/portal/contracts";

const identity: PortalIdentity = { userId: "fixture-owner", displayName: "Owner", email: "owner@example.test", emailVerified: true, platformRole: null };
const membership: Membership = { organizationId: "org-a", userId: identity.userId, role: "owner", status: "active", createdAt: "2026-09-05T00:00:00.000Z" };
const operator: PortalIdentity = { userId: "fixture-operator", displayName: "Operator", email: "operator@example.test", emailVerified: true, platformRole: "operator" };
const operatorMembership: Membership = { organizationId: "org-a", userId: operator.userId, role: "admin", status: "active", createdAt: "2026-09-15T00:00:00.000Z" };

describe("portal browser sessions", () => {
  it("issues HttpOnly SameSite cookies, verifies CSRF, rotates on login/logout and expires", () => {
    let now = Date.parse("2026-09-05T00:00:00.000Z");
    const manager = new PortalSessionManager({ store: new InMemoryPortalSessionStore(), now: () => now, ttlMs: 60_000, secureCookie: false });
    const anonymous = manager.ensure(null);
    expect(anonymous.setCookie).toContain("HttpOnly");
    expect(anonymous.setCookie).toContain("SameSite=Lax");
    expect(manager.verifyCsrf(anonymous.session, anonymous.session.csrfToken)).toBe(true);
    const authenticated = manager.authenticate(anonymous.session.sessionId, identity);
    expect(authenticated.session.sessionId).not.toBe(anonymous.session.sessionId);
    expect(manager.get(anonymous.session.sessionId)).toBeNull();
    const selected = manager.selectOrganization(authenticated.session.sessionId, "org-a", [membership]);
    expect(selected.organizationId).toBe("org-a");
    expect(() => manager.selectOrganization(authenticated.session.sessionId, "org-b", [membership])).toThrow("organization_membership_required");
    const loggedOut = manager.logout(authenticated.session.sessionId);
    expect(loggedOut.session.identity).toBeNull();
    expect(parsePortalSessionCookie(loggedOut.setCookie)).toBe(loggedOut.session.sessionId);
    now += 61_000;
    expect(manager.get(loggedOut.session.sessionId)).toBeNull();
  });

  it("switches a dual-role operator between an explicitly authorized organization and the platform workspace", () => {
    const manager = new PortalSessionManager({ store: new InMemoryPortalSessionStore(), secureCookie: false });
    const anonymous = manager.ensure(null);
    const authenticated = manager.authenticate(anonymous.session.sessionId, operator);
    const organization = manager.selectOrganization(authenticated.session.sessionId, "org-a", [operatorMembership]);
    expect(organization.organizationId).toBe("org-a");
    const platform = manager.selectOrganization(organization.sessionId, null, [operatorMembership]);
    expect(platform.organizationId).toBeNull();
    expect(platform.csrfToken).not.toBe(organization.csrfToken);

    const ownerAnonymous = manager.ensure(null);
    const owner = manager.authenticate(ownerAnonymous.session.sessionId, identity);
    expect(() => manager.selectOrganization(owner.session.sessionId, null, [membership])).toThrow("platform_identity_required");
  });
});
