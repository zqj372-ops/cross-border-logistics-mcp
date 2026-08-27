export const ACCESS_GATEWAY_SCHEMA_VERSION = "2026-08-27.v1" as const;

export const T0_TOOL_NAMES = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
] as const);

export type T0ToolName = (typeof T0_TOOL_NAMES)[number];
export type ExactToolScope = `tool:${T0ToolName}`;
export type AccessStatus = "success" | "needs_input" | "manual_review" | "blocked" | "unavailable";
export type ProviderKind = "production" | "synthetic";

export interface AdminPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
  readonly role: "admin";
  readonly roles: readonly ["admin"];
  readonly scopes: readonly ["platform:admin", "tenant:admin"];
}

export interface TenantRecord {
  readonly tenantId: string;
  readonly displayName: string;
  readonly status: "active" | "suspended";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ClientRecord {
  readonly clientId: string;
  readonly tenantId: string;
  readonly label: string;
  readonly status: "active" | "disabled";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface StoredCredentialRecord {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly label: string;
  readonly actorRole: "service";
  readonly roles: readonly ["service"];
  readonly toolNames: readonly T0ToolName[];
  readonly scopes: readonly ExactToolScope[];
  readonly status: "active" | "revoked";
  readonly deliveryStatus: "pending" | "acknowledged";
  readonly deliveryAcknowledgedAt: string | null;
  readonly keyPrefix: string;
  readonly secretLastFour: string;
  readonly secretSalt: Uint8Array;
  readonly secretHash: Uint8Array;
  readonly pepperVersion: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly rotatedFromId: string | null;
  readonly version: number;
}

export interface PublicCredentialRecord {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly label: string;
  readonly actorRole: "service";
  readonly roles: readonly ["service"];
  readonly toolNames: readonly T0ToolName[];
  readonly scopes: readonly ExactToolScope[];
  readonly status: "active" | "revoked";
  readonly deliveryStatus: "pending" | "acknowledged";
  readonly deliveryAcknowledgedAt: string | null;
  readonly effectiveStatus: "pending_delivery" | "active" | "tenant_suspended" | "client_disabled" | "expired" | "revoked";
  readonly keyPrefix: string;
  readonly secretLastFour: string;
  readonly pepperVersion: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly rotatedFromId: string | null;
  readonly version: number;
}

export type OperationAction =
  | "tenant.create"
  | "tenant.suspend"
  | "tenant.activate"
  | "client.create"
  | "client.disable"
  | "client.enable"
  | "credential.issue"
  | "credential.delivery_acknowledge"
  | "credential.rotate"
  | "credential.revoke";

export interface OperationRecord {
  readonly operationId: string;
  readonly tenantId: string;
  readonly clientId: string | null;
  readonly credentialId: string | null;
  readonly actorRef: string;
  readonly action: OperationAction;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly status: "success";
  readonly reasonCode: string;
  readonly requestHash: string;
  readonly createdAt: string;
}

export interface IdempotencyRecord {
  readonly action: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly resultId: string;
  readonly operationId: string;
  readonly createdAt: string;
}

export interface AuditEvent {
  readonly auditId: string;
  readonly action: string;
  readonly status: AccessStatus;
  readonly requestId: string;
  readonly tenantId: string | null;
  readonly clientId: string | null;
  readonly credentialId: string | null;
  readonly toolNames: readonly T0ToolName[];
  readonly requestHash: string;
  readonly jti: string | null;
  readonly reasonCode: string | null;
  readonly createdAt: string;
}

export interface AccessState {
  readonly tenants: readonly TenantRecord[];
  readonly clients: readonly ClientRecord[];
  readonly credentials: readonly PublicCredentialRecord[];
  readonly operations: readonly OperationRecord[];
}

export interface ExchangeRequest {
  readonly schema_version: typeof ACCESS_GATEWAY_SCHEMA_VERSION;
  readonly requested_tool_names: readonly T0ToolName[];
}

export interface JwtClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly actor_role: "service";
  readonly roles: readonly ["service"];
  readonly scopes: readonly ExactToolScope[];
  readonly client_id: string;
  readonly session_id: string;
}

export interface SignedJwt {
  readonly token: string;
  readonly kid: string;
}

export interface PublicJwk {
  readonly kty: "RSA";
  readonly kid: string;
  readonly alg: "RS256";
  readonly use: "sig";
  readonly n: string;
  readonly e: string;
}

export interface JwksResponse {
  readonly keys: readonly PublicJwk[];
}

export interface ExchangeSuccessResponse {
  readonly schema_version: typeof ACCESS_GATEWAY_SCHEMA_VERSION;
  readonly status: "success";
  readonly data: Readonly<{
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    tool_names: readonly T0ToolName[];
    session_ref: string;
    request_id: string;
  }>;
  readonly warnings: readonly [];
  readonly blockers: readonly [];
}

export interface ErrorResponse {
  readonly schema_version: typeof ACCESS_GATEWAY_SCHEMA_VERSION;
  readonly status: "needs_input" | "blocked" | "unavailable";
  readonly data: null;
  readonly code: "invalid_request" | "authentication_failed" | "tool_entitlement_denied" | "rate_limited" | "access_gateway_unavailable";
  readonly request_id: string;
}

export interface ExchangeInput {
  readonly apiKey: string;
  readonly body: unknown;
  readonly clientIp: string;
  readonly requestId?: string;
}

export interface GatewayOptions {
  readonly issuer?: string;
  readonly audience?: string;
  readonly defaultTtlSeconds?: number;
}
