import { describe, expect, it } from "vitest";

import { scheduleAccessState } from "../../apps/console/maritime-access";

const identity = (overrides: Record<string, unknown> = {}) => ({
  user_id: "user_a",
  display_name: "User A",
  platform_role: null,
  ...overrides,
});

const membership = (organizationId: string, role: string, userId = "user_a") => ({
  organization_id: organizationId,
  user_id: userId,
  role,
  status: "active",
});

const organization = (organizationId: string, status = "active") => ({
  organization_id: organizationId,
  display_name: organizationId,
  status,
});

describe("schedule first-screen access matrix", () => {
  it("keeps the form visible but non-querying for anonymous visitors", () => {
    const access = scheduleAccessState({ session: { authenticated: false } });
    expect(access).toMatchObject({ authenticated: false, canQuery: false, phase: "anonymous", organizations: [] });
  });

  it("asks an authenticated member to select an organization when several are available", () => {
    const access = scheduleAccessState({
      session: { authenticated: true, organization_id: null, identity: identity() },
      directory: {
        organizations: [organization("org_a"), organization("org_b")],
        memberships: [membership("org_a", "owner"), membership("org_b", "viewer")],
      },
    });
    expect(access.canQuery).toBe(false);
    expect(access.phase).toBe("select-org");
    expect(access.organizations.map((item: { organization_id: string }) => item.organization_id)).toEqual(["org_a", "org_b"]);
  });

  it("separates a platform identity without an organization from anonymous visitors", () => {
    const access = scheduleAccessState({
      session: {
        authenticated: true,
        organization_id: null,
        identity: identity({ platform_role: "reviewer" }),
      },
      directory: { organizations: [organization("org_a")], memberships: [membership("org_a", "owner")] },
    });
    expect(access).toMatchObject({ authenticated: true, platform: true, canQuery: false, phase: "platform-no-org" });
    expect(access.organizations).toHaveLength(1);
  });

  it("reports no membership instead of a login prompt when no organization is available", () => {
    const access = scheduleAccessState({
      session: { authenticated: true, organization_id: null, identity: identity() },
      directory: { organizations: [], memberships: [] },
    });
    expect(access).toMatchObject({ authenticated: true, platform: false, canQuery: false, phase: "no-membership" });
  });

  it("enables querying for owner, admin and developer of the selected organization", () => {
    for (const role of ["owner", "admin", "developer"]) {
      const access = scheduleAccessState({
        session: { authenticated: true, organization_id: "org_a", identity: identity() },
        directory: { organizations: [organization("org_a")], memberships: [membership("org_a", role)] },
      });
      expect(access).toMatchObject({ role, canQuery: true, phase: "ready" });
    }
  });

  it("keeps a viewer read-only with a clear phase", () => {
    const access = scheduleAccessState({
      session: { authenticated: true, organization_id: "org_a", identity: identity() },
      directory: { organizations: [organization("org_a")], memberships: [membership("org_a", "viewer")] },
    });
    expect(access).toMatchObject({ role: "viewer", canQuery: false, phase: "viewer" });
  });

  it("does not borrow a membership from another organization or a suspended member", () => {
    const otherOrganization = scheduleAccessState({
      session: { authenticated: true, organization_id: "org_b", identity: identity() },
      directory: { organizations: [organization("org_a")], memberships: [membership("org_a", "owner")] },
    });
    expect(otherOrganization).toMatchObject({ canQuery: false, role: null, phase: "no-membership" });

    const suspended = scheduleAccessState({
      session: { authenticated: true, organization_id: "org_a", identity: identity() },
      directory: {
        organizations: [organization("org_a")],
        memberships: [{ ...membership("org_a", "owner"), status: "suspended" }],
      },
    });
    expect(suspended).toMatchObject({ canQuery: false, role: null, phase: "no-membership" });
  });

  it("does not expose a suspended organization as a selectable membership", () => {
    const access = scheduleAccessState({
      session: { authenticated: true, organization_id: null, identity: identity() },
      directory: { organizations: [organization("org_a", "suspended")], memberships: [membership("org_a", "owner")] },
    });
    expect(access.phase).toBe("no-membership");
    expect(access.organizations).toEqual([]);
  });
});
