import { createHash } from "node:crypto";

import {
  PORTAL_SCHEMA_VERSION,
  PortalError,
  success,
  type PortalContext,
  type PortalEnvelope,
  type PortalMutation,
} from "./contracts";
import type {
  OrganizationService} from "./organization-service";
import {
  type PortalOrganizationAdmission,
} from "./organization-service";
import {
  TENANT_ACCESS_SCHEMA_VERSION,
  type TenantAccessService,
} from "../../../src/logistics_mcp/control-plane/tenant-access-service";
import { TenantAccessError } from "../../../src/logistics_mcp/control-plane/tenant-access-errors";
import { parseExecutionContext, type ExecutionContext } from "../../../src/logistics_mcp/platform/context";

const EMAIL = /^[^@\s]+@[^@\s]+$/u;
const REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;

export type CreateOrganizationInput = Readonly<{
  displayName: string;
  ownerEmail: string;
  ownerInvitationExpiresAt: string;
}>;

export type ChangeOrganizationStatusInput = Readonly<{
  expectedStatus: "active" | "suspended";
  status: "active" | "suspended";
  reason: string;
}>;

export type OrganizationAdmissionSummary = Readonly<{
  organization_id: string;
  tenant_id: string;
  display_name: string;
  organization_status: "active" | "suspended";
  tenant_status: "enabled" | "suspended" | "missing";
  owner_status: "owner_pending" | "owner_active" | "owner_missing";
  owner_invitation: Readonly<{
    invitation_id: string;
    status: "pending" | "claimed" | "revoked" | "expired";
    email_masked: string;
    expires_at: string;
  }> | null;
  reconciliation_required: boolean;
}>;

export interface OrganizationBridgeOptions {
  readonly organizationService: OrganizationService;
  readonly tenantAccessService: Pick<TenantAccessService, "createTenant" | "setTenantStatus" | "getState">;
  readonly internalAdminContext: ExecutionContext | (() => ExecutionContext);
}

export interface OrganizationBridge {
  createOrganization(
    context: PortalContext,
    mutation: PortalMutation<CreateOrganizationInput>,
  ): Promise<PortalEnvelope<OrganizationAdmissionSummary>>;
  setOrganizationStatus(
    context: PortalContext,
    organizationId: string,
    mutation: PortalMutation<ChangeOrganizationStatusInput>,
  ): Promise<PortalEnvelope<OrganizationAdmissionSummary>>;
  getOrganizationAdmission(
    context: PortalContext,
    organizationId: string,
  ): Promise<PortalEnvelope<OrganizationAdmissionSummary>>;
  listOrganizationAdmissions(
    context: PortalContext,
  ): Promise<PortalEnvelope<readonly OrganizationAdmissionSummary[]>>;
}

function stableId(prefix: "org" | "tenant" | "inv", key: string): string {
  const digest = createHash("sha256")
    .update(`${prefix}\u0000${key}`)
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

function operationKey(prefix: string, key: string): string {
  const digest = createHash("sha256")
    .update(`${prefix}\u0000${key}`)
    .digest("hex");
  return `${prefix}:${digest}`;
}

function delegatedAdmin(context: PortalContext, admin: ExecutionContext): ExecutionContext {
  try {
    return parseExecutionContext({
      tenant_id: admin.tenantId,
      actor_id: context.identity.userId,
      actor_role: admin.role,
      roles: admin.roles,
      scopes: admin.scopes,
      client_id: admin.clientId,
      session_id: admin.sessionId,
      expires_at: admin.expiresAt,
    });
  } catch {
    throw new PortalError("organization_bridge_unavailable");
  }
}

function createInput(value: unknown): CreateOrganizationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PortalError("input_invalid");
  const candidate = value as Partial<CreateOrganizationInput>;
  const keys = Object.keys(value);
  const displayName = candidate.displayName?.trim();
  const ownerEmail = candidate.ownerEmail?.toLowerCase();
  const expiry = typeof candidate.ownerInvitationExpiresAt === "string"
    ? Date.parse(candidate.ownerInvitationExpiresAt)
    : Number.NaN;
  if (
    keys.length !== 3 ||
    keys.some((key) => !["displayName", "ownerEmail", "ownerInvitationExpiresAt"].includes(key)) ||
    typeof displayName !== "string" ||
    displayName.length === 0 ||
    displayName.length > 120 ||
    typeof ownerEmail !== "string" ||
    !EMAIL.test(ownerEmail) ||
    !Number.isFinite(expiry)
  ) {
    throw new PortalError("input_invalid");
  }
  return Object.freeze({ displayName, ownerEmail, ownerInvitationExpiresAt: candidate.ownerInvitationExpiresAt! });
}

function statusInput(value: unknown): ChangeOrganizationStatusInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PortalError("input_invalid");
  const candidate = value as Partial<ChangeOrganizationStatusInput>;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    keys.some((key) => !["expectedStatus", "status", "reason"].includes(key)) ||
    (candidate.expectedStatus !== "active" && candidate.expectedStatus !== "suspended") ||
    (candidate.status !== "active" && candidate.status !== "suspended") ||
    candidate.status === candidate.expectedStatus ||
    typeof candidate.reason !== "string" ||
    !REASON.test(candidate.reason)
  ) {
    throw new PortalError("input_invalid");
  }
  return Object.freeze({
    expectedStatus: candidate.expectedStatus,
    status: candidate.status,
    reason: candidate.reason,
  } as ChangeOrganizationStatusInput);
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (local.length <= 2) return `${local.slice(0, 1)}***@${domain}`;
  return `${local.slice(0, 1)}***${local.slice(-1)}@${domain}`;
}

function mapTenantError(error: unknown): never {
  if (error instanceof PortalError) throw error;
  if (error instanceof TenantAccessError) {
    if (error.code === "idempotency_conflict") throw new PortalError("idempotency_conflict");
    throw new PortalError("organization_bridge_unavailable");
  }
  throw new PortalError("organization_bridge_unavailable");
}

export class DefaultOrganizationBridge implements OrganizationBridge {
  readonly #organizations: OrganizationService;
  readonly #tenantAccess: OrganizationBridgeOptions["tenantAccessService"];
  readonly #admin: () => ExecutionContext;

  constructor(options: OrganizationBridgeOptions) {
    this.#organizations = options.organizationService;
    this.#tenantAccess = options.tenantAccessService;
    this.#admin = typeof options.internalAdminContext === "function"
      ? options.internalAdminContext
      : () => options.internalAdminContext as ExecutionContext;
  }

  async #tenantStatus(context: PortalContext, tenantId: string): Promise<"enabled" | "suspended" | "missing"> {
    const state = await this.#tenantAccess.getState(delegatedAdmin(context, this.#admin()));
    const tenant = state.data.tenants.find((value) => value.tenant_id === tenantId);
    return tenant ? (tenant.status === "active" ? "enabled" : "suspended") : "missing";
  }

  async #summary(context: PortalContext, admission: PortalOrganizationAdmission): Promise<OrganizationAdmissionSummary> {
    const tenantStatus = await this.#tenantStatus(context, admission.organization.tenantId);
    const organizationStatus = admission.organization.status;
    const expectedTenant = organizationStatus === "active" ? "enabled" : "suspended";
    const invitation = admission.ownerInvitation;
    return Object.freeze({
      organization_id: admission.organization.organizationId,
      tenant_id: admission.organization.tenantId,
      display_name: admission.organization.displayName,
      organization_status: organizationStatus,
      tenant_status: tenantStatus,
      owner_status: admission.ownerStatus,
      owner_invitation: invitation === null ? null : Object.freeze({
        invitation_id: invitation.invitationId,
        status: invitation.status,
        email_masked: maskEmail(invitation.email),
        expires_at: invitation.expiresAt,
      }),
      reconciliation_required: tenantStatus !== expectedTenant || admission.ownerStatus === "owner_missing",
    });
  }

  async createOrganization(
    context: PortalContext,
    mutation: PortalMutation<CreateOrganizationInput>,
  ): Promise<PortalEnvelope<OrganizationAdmissionSummary>> {
    this.#organizations.requireOperator(context);
    const input = this.#organizations.validateCreateInput(context, createInput(mutation.input));
    const organizationId = stableId("org", mutation.idempotencyKey);
    const tenantId = stableId("tenant", mutation.idempotencyKey);
    const invitationId = stableId("inv", mutation.idempotencyKey);
    const admin = delegatedAdmin(context, this.#admin());
    try {
      await this.#tenantAccess.createTenant(admin, {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tenant_id: tenantId,
        display_name: input.displayName,
      }, operationKey("organization-create-tenant", mutation.idempotencyKey));
      if (await this.#tenantStatus(context, tenantId) !== "enabled") {
        throw new PortalError("organization_tenant_readback_failed");
      }
      const recorded = this.#organizations.createOrganizationRecord(context, {
        idempotencyKey: mutation.idempotencyKey,
        input: {
          organizationId,
          tenantId,
          invitationId,
          displayName: input.displayName,
          ownerEmail: input.ownerEmail,
          ownerInvitationExpiresAt: input.ownerInvitationExpiresAt,
        },
      });
      return success(await this.#summary(context, recorded.data!));
    } catch (error) {
      mapTenantError(error);
    }
  }

  async setOrganizationStatus(
    context: PortalContext,
    organizationId: string,
    mutation: PortalMutation<ChangeOrganizationStatusInput>,
  ): Promise<PortalEnvelope<OrganizationAdmissionSummary>> {
    this.#organizations.requireOperator(context);
    const input = statusInput(mutation.input);
    const current = this.#organizations.getOrganizationAdmission(context, organizationId).data!;
    if (current.organization.status === input.status) {
      const replayed = this.#organizations.setOrganizationStatus(context, organizationId, {
        idempotencyKey: mutation.idempotencyKey,
        input,
      });
      return success(await this.#summary(context, replayed.data!));
    }
    if (current.organization.status !== input.expectedStatus) throw new PortalError("state_conflict");
    const admin = delegatedAdmin(context, this.#admin());
    const tenantStatus = input.status === "active" ? "active" : "suspended";
    try {
      await this.#tenantAccess.setTenantStatus(admin, current.organization.tenantId, {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: tenantStatus,
        reason_code: input.reason,
      }, operationKey(`organization-${input.status}-tenant`, mutation.idempotencyKey));
      const expectedReadback = input.status === "active" ? "enabled" : "suspended";
      if (await this.#tenantStatus(context, current.organization.tenantId) !== expectedReadback) {
        throw new PortalError("organization_tenant_readback_failed");
      }
      const changed = this.#organizations.setOrganizationStatus(context, organizationId, {
        idempotencyKey: mutation.idempotencyKey,
        input,
      });
      return success(await this.#summary(context, changed.data!));
    } catch (error) {
      mapTenantError(error);
    }
  }

  async getOrganizationAdmission(
    context: PortalContext,
    organizationId: string,
  ): Promise<PortalEnvelope<OrganizationAdmissionSummary>> {
    try {
      const admission = this.#organizations.getOrganizationAdmission(context, organizationId).data!;
      return success(await this.#summary(context, admission));
    } catch (error) {
      mapTenantError(error);
    }
  }

  async listOrganizationAdmissions(
    context: PortalContext,
  ): Promise<PortalEnvelope<readonly OrganizationAdmissionSummary[]>> {
    try {
      const admissions = this.#organizations.listOrganizationAdmissions(context).data!;
      return Object.freeze({
        schema_version: PORTAL_SCHEMA_VERSION,
        status: "success",
        data: Object.freeze(await Promise.all(admissions.map((value) => this.#summary(context, value)))),
        reason_codes: Object.freeze([]),
      });
    } catch (error) {
      mapTenantError(error);
    }
  }
}

export function createOrganizationBridge(options: OrganizationBridgeOptions): OrganizationBridge {
  return new DefaultOrganizationBridge(options);
}
