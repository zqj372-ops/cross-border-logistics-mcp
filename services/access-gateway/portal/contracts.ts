export const PORTAL_SCHEMA_VERSION = "portal@2026-09-05.v1" as const;

export const PORTAL_CAPABILITIES = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
] as const);
export type PortalCapabilityId = (typeof PORTAL_CAPABILITIES)[number];
export type PortalRole = "owner" | "admin" | "developer" | "viewer";
export type PlatformRole = "reviewer" | "operator" | null;
export type RequestState = "draft" | "submitted" | "in_review" | "needs_input" | "approved" | "rejected" | "withdrawn";
export type GrantState = "provisioning" | "active" | "suspended" | "revoked" | "expired";

export interface PortalIdentity { userId: string; displayName: string; email: string; emailVerified: boolean; platformRole: PlatformRole }
export interface PortalContext { readonly identity: PortalIdentity; readonly organizationId: string | null }
export interface PortalUser { userId: string; displayName: string; email: string; emailVerified: boolean; createdAt: string }
export interface Organization { organizationId: string; tenantId: string; displayName: string; status: "active" | "suspended"; createdAt: string }
export interface PortalOrganizationSummary { organizationId: string; displayName: string; status: "active" | "suspended" }
export interface Membership { organizationId: string; userId: string; role: PortalRole; status: "active" | "suspended"; createdAt: string }
export interface Invitation { invitationId: string; organizationId: string; email: string; role: PortalRole; status: "pending" | "claimed" | "revoked" | "expired"; expiresAt: string; invitedBy: string; claimedBy: string | null; createdAt: string }
export interface Application { applicationId: string; organizationId: string; clientId: string; name: string; purpose: string; environment: "test" | "production"; ownerUserId: string; status: "active" | "suspended"; createdAt: string; version: number }
export interface AccessRequest { requestId: string; organizationId: string; applicationId: string; requestedCapabilities: readonly PortalCapabilityId[]; state: RequestState; version: number; applicantUserId: string; justification: string; reviewReason: string | null; reviewerUserId: string | null; createdAt: string; updatedAt: string }
export interface Grant { grantId: string; organizationId: string; applicationId: string; requestId: string; capabilities: readonly PortalCapabilityId[]; state: GrantState; version: number; expiresAt: string | null; provisionedRef: string | null; createdAt: string; updatedAt: string }
export interface PortalOperation { operationId: string; organizationId: string | null; actorUserId: string; action: string; objectType: string; objectRef: string; fromState: string | null; toState: string | null; createdAt: string }
export interface PortalCatalogItem { readonly capabilityId: string; readonly available: boolean; readonly reasonCode: string | null }

export type PortalState = Readonly<{ data_mode: "fixtures" | "production"; identity: PortalIdentity; current_organization: Organization | null; organizations: readonly PortalOrganizationSummary[]; users: readonly Pick<PortalUser,"userId"|"displayName">[]; memberships: readonly Membership[]; invitations: readonly Invitation[]; applications: readonly Application[]; requests: readonly AccessRequest[]; grants: readonly Grant[]; catalog: readonly PortalCatalogItem[]; operations: readonly PortalOperation[] }>;
export type PortalEnvelope<T> = Readonly<{ schema_version: typeof PORTAL_SCHEMA_VERSION; status: "success" | "needs_input" | "blocked" | "unavailable"; data: T | null; reason_codes: readonly string[] }>;
export interface PortalMutation<T> { readonly idempotencyKey: string; readonly expectedVersion?: number; readonly input: T }

export class PortalError extends Error { constructor(readonly code: string) { super(code); this.name = "PortalError"; } }
export function success<T>(data: T): PortalEnvelope<T> { return Object.freeze({ schema_version: PORTAL_SCHEMA_VERSION, status: "success", data, reason_codes: Object.freeze([]) }); }
export function failure(status: "needs_input" | "blocked" | "unavailable", code: string): PortalEnvelope<null> { return Object.freeze({ schema_version: PORTAL_SCHEMA_VERSION, status, data: null, reason_codes: Object.freeze([code]) }); }
