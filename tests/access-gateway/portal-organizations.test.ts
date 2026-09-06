import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOrganizationBridge,
  type OrganizationBridge,
} from "../../services/access-gateway/portal/organization-bridge";
import { OrganizationService } from "../../services/access-gateway/portal/organization-service";
import { PortalError, type PortalContext, type PortalIdentity } from "../../services/access-gateway/portal/contracts";
import { PortalService } from "../../services/access-gateway/portal/service";
import { SqliteSyntheticPortalStore } from "../../services/access-gateway/portal/store";
import {
  initializeSqliteTenantAccessState,
  SqliteTenantAccessStore,
} from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import {
  TenantAccessService,
} from "../../src/logistics_mcp/control-plane/tenant-access-service";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";

const NOW_SECONDS = 1_788_537_600;
const NOW = new Date(NOW_SECONDS * 1_000).toISOString();
const MANAGEMENT_TENANT_ID = "tenant_management_org_tests";

const operator: PortalIdentity = Object.freeze({
  userId: "platform-operator",
  displayName: "Platform operator",
  email: "operator@example.test",
  emailVerified: true,
  platformRole: "operator",
});
const reviewer: PortalIdentity = Object.freeze({
  userId: "platform-reviewer",
  displayName: "Platform reviewer",
  email: "reviewer@example.test",
  emailVerified: true,
  platformRole: "reviewer",
});
const owner: PortalIdentity = Object.freeze({
  userId: "customer-owner",
  displayName: "Customer owner",
  email: "owner@example.test",
  emailVerified: true,
  platformRole: null,
});

function context(identity: PortalIdentity, organizationId: string | null = null): PortalContext {
  return Object.freeze({ identity, organizationId });
}

function adminContext(actorId = "portal-organization-bridge") {
  return parseExecutionContext({
    tenant_id: MANAGEMENT_TENANT_ID,
    actor_id: actorId,
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin", "tenant:admin"],
    client_id: "portal-organization-bridge",
    session_id: "portal-organization-tests",
    expires_at: Math.max(NOW_SECONDS, Math.floor(Date.now() / 1_000)) + 86_400,
  });
}

type Runtime = Readonly<{
  bridge: OrganizationBridge;
  portal: PortalService;
  tenantAccess: TenantAccessService;
  close(): Promise<void>;
}>;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runtime(): Promise<Runtime> {
  const root = mkdtempSync(join(tmpdir(), "portal-organizations-"));
  roots.push(root);
  await initializeSqliteTenantAccessState({
    applicationRoot: root,
    instanceId: "organization_tests",
    managementTenantId: MANAGEMENT_TENANT_ID,
  });
  const tenantStore = new SqliteTenantAccessStore({
    applicationRoot: root,
    instanceId: "organization_tests",
    managementTenantId: MANAGEMENT_TENANT_ID,
  });
  const portalStore = new SqliteSyntheticPortalStore({ databasePath: join(root, "portal.sqlite") });
  const tenantAccess = new TenantAccessService(tenantStore, { clock: () => NOW_SECONDS });
  const portal = new PortalService({ repository: portalStore, dataMode: "fixtures", now: () => NOW });
  const organizations = new OrganizationService({
    repository: portalStore,
    now: () => NOW,
    id: (prefix) => `${prefix}_fixed`,
  });
  const bridge = createOrganizationBridge({
    organizationService: organizations,
    tenantAccessService: tenantAccess,
    internalAdminContext: adminContext(),
  });
  return {
    bridge,
    portal,
    tenantAccess,
    close: async () => {
      portalStore.close();
      await tenantStore.close();
    },
  };
}

describe("portal organization admission", () => {
  it("creates a real tenant and a pending first-owner invitation without membership or credentials", async () => {
    const app = await runtime();
    const mutation = {
      idempotencyKey: "organization-create-0001",
      input: {
        displayName: "Acme Logistics",
        ownerEmail: owner.email,
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
      },
    } as const;

    const first = await app.bridge.createOrganization(context(operator), mutation);
    const replay = await app.bridge.createOrganization(context(operator), mutation);

    expect(replay).toEqual(first);
    expect(first.data).toMatchObject({
      organization_status: "active",
      tenant_status: "enabled",
      owner_status: "owner_pending",
      reconciliation_required: false,
      owner_invitation: {
        status: "pending",
        email_masked: "o***r@example.test",
      },
    });
    const tenantState = (await app.tenantAccess.getState(adminContext())).data;
    expect(tenantState.tenants).toEqual([
      expect.objectContaining({
        tenant_id: first.data!.tenant_id,
        display_name: "Acme Logistics",
        status: "active",
      }),
    ]);
    expect(tenantState.credentials).toEqual([]);
    expect(tenantState.operations).toEqual([
      expect.objectContaining({
        actor_ref: "platform-operator:portal-organization-bridge",
        action: "tenant.create",
      }),
    ]);
    const portalState = app.portal.getState(context(owner)).data!;
    expect(portalState.memberships).toEqual([]);
    expect(portalState.invitations).toEqual([
      expect.objectContaining({
        invitationId: first.data!.owner_invitation!.invitation_id,
        role: "owner",
        status: "pending",
      }),
    ]);
    const platformAdmission = await app.bridge.getOrganizationAdmission(context(operator), first.data!.organization_id);
    expect(app.portal.getPlatformState(context(operator)).status).toBe("success");
    expect(platformAdmission.data!.organization_id).toBe(first.data!.organization_id);
    expect(JSON.stringify(first)).not.toContain(owner.email);
    await app.close();
  });

  it("requires the verified target email to claim the existing invitation before reporting owner_active", async () => {
    const app = await runtime();
    const created = await app.bridge.createOrganization(context(operator), {
      idempotencyKey: "organization-create-0002",
      input: {
        displayName: "Claimed Logistics",
        ownerEmail: owner.email,
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
      },
    });
    const invitationId = created.data!.owner_invitation!.invitation_id;
    expect(() => app.portal.claimInvitation(context({ ...owner, email: "other@example.test" }), invitationId, "owner-claim-wrong-0001"))
      .toThrowError("invitation_identity_mismatch");

    app.portal.claimInvitation(context(owner), invitationId, "owner-claim-right-0001");
    const admission = await app.bridge.getOrganizationAdmission(context(operator), created.data!.organization_id);
    expect(admission.data).toMatchObject({ owner_status: "owner_active", owner_invitation: { status: "claimed" } });
    const ownerState = app.portal.getState(context(owner, created.data!.organization_id)).data!;
    expect(ownerState.memberships).toEqual([
      expect.objectContaining({ role: "owner", status: "active", userId: owner.userId }),
    ]);
    expect(ownerState.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "organization.admit", actorUserId: operator.userId }),
      expect.objectContaining({ action: "invitation.claim", actorUserId: owner.userId }),
    ]));
    await app.close();
  });

  it("suspends and restores both the tenant and portal organization with write-after-readback", async () => {
    const app = await runtime();
    const created = await app.bridge.createOrganization(context(operator), {
      idempotencyKey: "organization-create-0003",
      input: {
        displayName: "Lifecycle Logistics",
        ownerEmail: owner.email,
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
      },
    });
    const organizationId = created.data!.organization_id;

    const suspended = await app.bridge.setOrganizationStatus(context(operator), organizationId, {
      idempotencyKey: "organization-suspend-001",
      input: { expectedStatus: "active", status: "suspended", reason: "operator_review" },
    });
    expect(suspended.data).toMatchObject({
      organization_status: "suspended",
      tenant_status: "suspended",
      owner_status: "owner_pending",
      reconciliation_required: false,
    });
    expect(await app.bridge.setOrganizationStatus(context(operator), organizationId, {
      idempotencyKey: "organization-suspend-001",
      input: { expectedStatus: "active", status: "suspended", reason: "operator_review" },
    })).toEqual(suspended);

    const restored = await app.bridge.setOrganizationStatus(context(operator), organizationId, {
      idempotencyKey: "organization-restore-0001",
      input: { expectedStatus: "suspended", status: "active", reason: "operator_restored" },
    });
    expect(restored.data).toMatchObject({
      organization_status: "active",
      tenant_status: "enabled",
      owner_status: "owner_pending",
      reconciliation_required: false,
    });
    await app.close();
  });

  it("rejects non-operators, selected organization contexts, changed replays, and unverified identities before side effects", async () => {
    const app = await runtime();
    const mutation = {
      idempotencyKey: "organization-create-0004",
      input: {
        displayName: "Denied Logistics",
        ownerEmail: owner.email,
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
      },
    } as const;

    await expect(app.bridge.createOrganization(context(reviewer), mutation)).rejects.toThrowError("operator_required");
    await expect(app.bridge.createOrganization(context(operator, "org_selected"), mutation)).rejects.toThrowError("platform_context_required");
    await expect(app.bridge.createOrganization(context({ ...operator, emailVerified: false }), mutation)).rejects.toThrowError("verified_identity_required");
    expect((await app.tenantAccess.getState(adminContext())).data.tenants).toEqual([]);

    await app.bridge.createOrganization(context(operator), mutation);
    await expect(app.bridge.createOrganization(context({ ...operator, userId: "other-operator" }), mutation))
      .rejects.toThrowError("idempotency_conflict");
    await expect(app.bridge.createOrganization(context(operator), {
      ...mutation,
      input: { ...mutation.input, displayName: "Changed replay" },
    })).rejects.toThrowError("idempotency_conflict");
    expect((await app.tenantAccess.getState(adminContext())).data.tenants).toHaveLength(1);
    await app.close();
  });

  it("does not commit a portal organization when tenant readback cannot prove creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "portal-organizations-readback-"));
    roots.push(root);
    const portalStore = new SqliteSyntheticPortalStore({ databasePath: join(root, "portal.sqlite") });
    const organizations = new OrganizationService({ repository: portalStore, now: () => NOW });
    const tenantAccess = {
      createTenant: () => Promise.resolve(Object.freeze({ status: "success" })),
      setTenantStatus: () => Promise.resolve(Object.freeze({ status: "success" })),
      getState: () => Promise.resolve(Object.freeze({ data: Object.freeze({ tenants: Object.freeze([]) }) })),
    } as unknown as Pick<TenantAccessService, "createTenant" | "setTenantStatus" | "getState">;
    const bridge = createOrganizationBridge({
      organizationService: organizations,
      tenantAccessService: tenantAccess,
      internalAdminContext: adminContext(),
    });

    await expect(bridge.createOrganization(context(operator), {
      idempotencyKey: "organization-readback-001",
      input: {
        displayName: "Unproven Logistics",
        ownerEmail: owner.email,
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
      },
    })).rejects.toThrowError("organization_tenant_readback_failed");
    expect(organizations.listOrganizationAdmissions(context(operator)).data).toEqual([]);
    portalStore.close();
  });

  it("rejects invalid invitation expiry before tenant creation and scopes status idempotency across targets", async () => {
    const app = await runtime();
    await expect(app.bridge.createOrganization(context(operator), {
      idempotencyKey: "organization-unknown-0001",
      input: {
        displayName: "Unknown field",
        ownerEmail: owner.email,
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
        tenantId: "caller_supplied_tenant",
      } as never,
    })).rejects.toThrowError("input_invalid");
    await expect(app.bridge.createOrganization(context(operator), {
      idempotencyKey: "organization-expired-0001",
      input: {
        displayName: "Expired Invitation",
        ownerEmail: owner.email,
        ownerInvitationExpiresAt: "2020-01-01T00:00:00.000Z",
      },
    })).rejects.toThrowError("input_invalid");
    expect((await app.tenantAccess.getState(adminContext())).data.tenants).toEqual([]);

    const first = await app.bridge.createOrganization(context(operator), {
      idempotencyKey: "organization-target-a-001",
      input: {
        displayName: "Target A",
        ownerEmail: "a@example.test",
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
      },
    });
    const second = await app.bridge.createOrganization(context(operator), {
      idempotencyKey: "organization-target-b-001",
      input: {
        displayName: "Target B",
        ownerEmail: "b@example.test",
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
      },
    });
    await app.bridge.setOrganizationStatus(context(operator), first.data!.organization_id, {
      idempotencyKey: "organization-target-status",
      input: { expectedStatus: "active", status: "suspended", reason: "operator_review" },
    });
    await expect(app.bridge.setOrganizationStatus(context(operator), second.data!.organization_id, {
      idempotencyKey: "organization-target-status",
      input: { expectedStatus: "active", status: "suspended", reason: "operator_review" },
    })).rejects.toThrowError("idempotency_conflict");
    expect((await app.bridge.getOrganizationAdmission(context(operator), second.data!.organization_id)).data)
      .toMatchObject({ organization_status: "active", tenant_status: "enabled" });
    await app.close();
  });

  it("preserves last-owner protection and does not revive a revoked grant after organization restore", async () => {
    const app = await runtime();
    const created = await app.bridge.createOrganization(context(operator), {
      idempotencyKey: "organization-create-0006",
      input: {
        displayName: "Grant Lifecycle Logistics",
        ownerEmail: owner.email,
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
      },
    });
    const organizationId = created.data!.organization_id;
    const invitationId = created.data!.owner_invitation!.invitation_id;
    app.portal.claimInvitation(context(owner), invitationId, "owner-claim-grant-0001");
    const ownerContext = context(owner, organizationId);
    expect(() => app.portal.changeMembership(ownerContext, owner.userId, {
      idempotencyKey: "owner-suspend-denied-01",
      input: { status: "suspended" },
    })).toThrowError("last_owner_protected");

    app.portal.createApplication(ownerContext, {
      idempotencyKey: "grant-test-application-01",
      input: {
        applicationId: "app_grant_lifecycle",
        clientId: "client_grant_lifecycle",
        name: "Grant lifecycle",
        purpose: "Verify restore semantics",
        environment: "test",
        ownerUserId: owner.userId,
      },
    });
    app.portal.createRequest(ownerContext, {
      idempotencyKey: "grant-test-request-0001",
      input: {
        requestId: "request_grant_lifecycle",
        applicationId: "app_grant_lifecycle",
        capabilities: ["cargo.calculate"],
        justification: "Verify restore semantics",
      },
    });
    app.portal.submitRequest(ownerContext, "request_grant_lifecycle", 1, "grant-test-submit-0001");
    const decision = app.portal.decideRequest(context(reviewer), "request_grant_lifecycle", {
      idempotencyKey: "grant-test-decision-001",
      expectedVersion: 2,
      input: { decision: "approve", reason: "approved" },
    }).data as { grant: { grantId: string } };
    app.portal.markGrantActive(context(operator), decision.grant.grantId, {
      idempotencyKey: "grant-test-active-0001",
      expectedVersion: 1,
      input: { provisionedRef: "client_grant_lifecycle" },
    });
    app.portal.changeGrantState(context(operator), decision.grant.grantId, {
      idempotencyKey: "grant-test-revoke-0001",
      expectedVersion: 2,
      input: { state: "revoked" },
    });

    await app.bridge.setOrganizationStatus(context(operator), organizationId, {
      idempotencyKey: "grant-org-suspend-0001",
      input: { expectedStatus: "active", status: "suspended", reason: "operator_review" },
    });
    await app.bridge.setOrganizationStatus(context(operator), organizationId, {
      idempotencyKey: "grant-org-restore-0001",
      input: { expectedStatus: "suspended", status: "active", reason: "operator_restored" },
    });

    expect(app.portal.getState(ownerContext).data!.grants).toEqual([
      expect.objectContaining({ grantId: decision.grant.grantId, state: "revoked" }),
    ]);
    await app.close();
  });

  it("returns an operator-only bounded admission list without credentials or full owner email", async () => {
    const app = await runtime();
    await app.bridge.createOrganization(context(operator), {
      idempotencyKey: "organization-create-0005",
      input: {
        displayName: "Summary Logistics",
        ownerEmail: owner.email,
        ownerInvitationExpiresAt: "2099-12-31T23:59:59.000Z",
      },
    });
    const summaries = await app.bridge.listOrganizationAdmissions(context(operator));
    expect(summaries.data).toHaveLength(1);
    expect(JSON.stringify(summaries)).not.toMatch(/credential|api_key|owner@example\.test/u);
    await expect(app.bridge.listOrganizationAdmissions(context(reviewer))).rejects.toThrowError(PortalError);
    await app.close();
  });
});
