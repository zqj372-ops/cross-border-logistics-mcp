import { createHash, randomUUID } from "node:crypto";

import {
  PortalError,
  success,
  type Invitation,
  type Organization,
  type PortalContext,
  type PortalEnvelope,
  type PortalMutation,
} from "./contracts";
import type { PortalData, PortalRepository } from "./store";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const EMAIL = /^[^@\s]+@[^@\s]+$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new PortalError("input_invalid");
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export type OwnerAdmissionStatus = "owner_pending" | "owner_active" | "owner_missing";

export type PortalOrganizationAdmission = Readonly<{
  organization: Organization;
  ownerStatus: OwnerAdmissionStatus;
  ownerInvitation: Invitation | null;
}>;

export type CreateOrganizationRecordInput = Readonly<{
  organizationId: string;
  tenantId: string;
  invitationId: string;
  displayName: string;
  ownerEmail: string;
  ownerInvitationExpiresAt: string;
}>;

export type SetPortalOrganizationStatusInput = Readonly<{
  expectedStatus: Organization["status"];
  status: Organization["status"];
  reason: string;
}>;

export interface OrganizationServiceOptions {
  readonly repository: PortalRepository;
  readonly now?: () => string;
  readonly id?: (prefix: "op") => string;
}

export class OrganizationService {
  readonly #repository: PortalRepository;
  readonly #now: () => string;
  readonly #id: (prefix: "op") => string;

  constructor(options: OrganizationServiceOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
  }

  requireOperator(context: PortalContext): void {
    if (!context.identity.emailVerified) throw new PortalError("verified_identity_required");
    if (context.organizationId !== null) throw new PortalError("platform_context_required");
    if (context.identity.platformRole !== "operator") throw new PortalError("operator_required");
  }

  validateCreateInput(
    context: PortalContext,
    input: Readonly<{ displayName: string; ownerEmail: string; ownerInvitationExpiresAt: string }>,
  ): Readonly<{ displayName: string; ownerEmail: string; ownerInvitationExpiresAt: string }> {
    this.requireOperator(context);
    const keys = Object.keys(input);
    const displayName = input.displayName?.trim();
    const ownerEmail = input.ownerEmail?.toLowerCase();
    const expiry = Date.parse(input.ownerInvitationExpiresAt);
    if (
      keys.length !== 3 ||
      keys.some((key) => !["displayName", "ownerEmail", "ownerInvitationExpiresAt"].includes(key)) ||
      typeof displayName !== "string" ||
      displayName.length === 0 ||
      displayName.length > 120 ||
      typeof ownerEmail !== "string" ||
      !EMAIL.test(ownerEmail) ||
      !Number.isFinite(expiry) ||
      expiry <= Date.parse(this.#now())
    ) {
      throw new PortalError("input_invalid");
    }
    return Object.freeze({ displayName, ownerEmail, ownerInvitationExpiresAt: input.ownerInvitationExpiresAt });
  }

  #admission(data: PortalData, organizationId: string): PortalOrganizationAdmission {
    const organization = data.organizations.find((value) => value.organizationId === organizationId);
    if (!organization) throw new PortalError("organization_not_found");
    const activeOwner = data.memberships.some((value) => (
      value.organizationId === organizationId && value.role === "owner" && value.status === "active"
    ));
    const storedInvitation = [...data.invitations]
      .reverse()
      .find((value) => value.organizationId === organizationId && value.role === "owner") ?? null;
    const ownerInvitation = storedInvitation?.status === "pending" && Date.parse(storedInvitation.expiresAt) <= Date.parse(this.#now())
      ? { ...storedInvitation, status: "expired" as const }
      : storedInvitation;
    const ownerStatus: OwnerAdmissionStatus = activeOwner
      ? "owner_active"
      : ownerInvitation?.status === "pending"
        ? "owner_pending"
        : "owner_missing";
    return Object.freeze({ organization, ownerStatus, ownerInvitation });
  }

  getOrganizationAdmission(
    context: PortalContext,
    organizationId: string,
  ): PortalEnvelope<PortalOrganizationAdmission> {
    this.requireOperator(context);
    if (!IDENTIFIER.test(organizationId)) throw new PortalError("input_invalid");
    return success(this.#admission(this.#repository.read(), organizationId));
  }

  listOrganizationAdmissions(
    context: PortalContext,
  ): PortalEnvelope<readonly PortalOrganizationAdmission[]> {
    this.requireOperator(context);
    const data = this.#repository.read();
    return success(Object.freeze(data.organizations.slice(-200).map((value) => (
      this.#admission(data, value.organizationId)
    ))));
  }

  createOrganizationRecord(
    context: PortalContext,
    mutation: PortalMutation<CreateOrganizationRecordInput>,
  ): PortalEnvelope<PortalOrganizationAdmission> {
    this.requireOperator(context);
    const input = mutation.input;
    const keys = Object.keys(input);
    const displayName = input.displayName.trim();
    const ownerEmail = input.ownerEmail.toLowerCase();
    const expiry = Date.parse(input.ownerInvitationExpiresAt);
    if (
      !IDENTIFIER.test(input.organizationId) ||
      !IDENTIFIER.test(input.tenantId) ||
      !IDENTIFIER.test(input.invitationId) ||
      displayName.length === 0 ||
      displayName.length > 120 ||
      !EMAIL.test(ownerEmail) ||
      !Number.isFinite(expiry) ||
      expiry <= Date.parse(this.#now()) ||
      keys.length !== 6 ||
      keys.some((key) => !["organizationId", "tenantId", "invitationId", "displayName", "ownerEmail", "ownerInvitationExpiresAt"].includes(key))
    ) {
      throw new PortalError("input_invalid");
    }
    const action = "organization.admit";
    try {
      return this.#repository.transact(
        action,
        mutation.idempotencyKey,
        hash({
          actorUserId: context.identity.userId,
          organizationId: input.organizationId,
          action,
          input: { ...input, displayName, ownerEmail },
        }),
        (data) => {
          if (data.organizations.some((value) => (
            value.organizationId === input.organizationId || value.tenantId === input.tenantId
          ))) {
            throw new PortalError("organization_exists");
          }
          if (data.invitations.some((value) => value.invitationId === input.invitationId)) {
            throw new PortalError("invitation_exists");
          }
          const createdAt = this.#now();
          const organization: Organization = {
            organizationId: input.organizationId,
            tenantId: input.tenantId,
            displayName,
            status: "active",
            createdAt,
          };
          const invitation: Invitation = {
            invitationId: input.invitationId,
            organizationId: input.organizationId,
            email: ownerEmail,
            role: "owner",
            status: "pending",
            expiresAt: input.ownerInvitationExpiresAt,
            invitedBy: context.identity.userId,
            claimedBy: null,
            createdAt,
          };
          data.organizations.push(organization);
          data.invitations.push(invitation);
          data.operations.push({
            operationId: this.#id("op"),
            organizationId: organization.organizationId,
            actorUserId: context.identity.userId,
            action,
            objectType: "organization",
            objectRef: organization.organizationId,
            fromState: null,
            toState: "active:owner_pending",
            createdAt,
          });
          return success(this.#admission(data, organization.organizationId));
        },
      );
    } catch (error) {
      if (error instanceof PortalError) throw error;
      throw new PortalError(error instanceof Error ? error.message : "portal_store_unavailable");
    }
  }

  setOrganizationStatus(
    context: PortalContext,
    organizationId: string,
    mutation: PortalMutation<SetPortalOrganizationStatusInput>,
  ): PortalEnvelope<PortalOrganizationAdmission> {
    this.requireOperator(context);
    const input = mutation.input;
    const keys = Object.keys(input);
    if (
      !IDENTIFIER.test(organizationId) ||
      (input.expectedStatus !== "active" && input.expectedStatus !== "suspended") ||
      (input.status !== "active" && input.status !== "suspended") ||
      input.status === input.expectedStatus ||
      !IDENTIFIER.test(input.reason) ||
      keys.length !== 3 ||
      keys.some((key) => !["expectedStatus", "status", "reason"].includes(key))
    ) {
      throw new PortalError("input_invalid");
    }
    const action = `organization.${input.status}`;
    try {
      return this.#repository.transact(
        action,
        mutation.idempotencyKey,
        hash({
          actorUserId: context.identity.userId,
          organizationId,
          action,
          input,
        }),
        (data) => {
          const organization = data.organizations.find((value) => value.organizationId === organizationId);
          if (!organization) throw new PortalError("organization_not_found");
          if (organization.status !== input.expectedStatus) throw new PortalError("state_conflict");
          organization.status = input.status;
          data.operations.push({
            operationId: this.#id("op"),
            organizationId,
            actorUserId: context.identity.userId,
            action,
            objectType: "organization",
            objectRef: organizationId,
            fromState: input.expectedStatus,
            toState: input.status,
            createdAt: this.#now(),
          });
          return success(this.#admission(data, organizationId));
        },
      );
    } catch (error) {
      if (error instanceof PortalError) throw error;
      throw new PortalError(error instanceof Error ? error.message : "portal_store_unavailable");
    }
  }
}
