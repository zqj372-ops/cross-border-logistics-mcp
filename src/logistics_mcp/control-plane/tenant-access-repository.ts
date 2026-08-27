import type { TenantApiKeyScope } from "./tenant-access-contracts";

export type TenantStatus = "active" | "suspended";
export type ClientStatus = "active" | "disabled";
export type StoredCredentialStatus = "active" | "revoked";

export interface TenantRecord {
  readonly tenantId: string;
  readonly displayName: string;
  readonly status: TenantStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClientRecord {
  readonly clientId: string;
  readonly tenantId: string;
  readonly label: string;
  readonly status: ClientStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredCredentialRecord {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly label: string;
  readonly actorRole: "service";
  readonly roles: readonly ["service"];
  readonly scopes: readonly TenantApiKeyScope[];
  readonly status: StoredCredentialStatus;
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
}

export interface TenantAccessEventRecord {
  readonly eventId: string;
  readonly tenantId: string;
  readonly clientId: string | null;
  readonly credentialId: string | null;
  readonly actorRef: string;
  readonly action: string;
  readonly reasonCode: string;
  readonly createdAt: string;
}

export interface TenantAccessStateRecord {
  readonly tenants: readonly TenantRecord[];
  readonly clients: readonly ClientRecord[];
  readonly credentials: readonly StoredCredentialRecord[];
  readonly events: readonly TenantAccessEventRecord[];
  readonly deliveryAcknowledgements: Readonly<Record<string, string>>;
}

export type TenantAccessWriteResult<T> = Readonly<{
  replayed: boolean;
  value: T;
  operation: TenantAccessEventRecord;
}>;

export type TenantAccessRepositoryErrorCode =
  | "closed"
  | "corrupt"
  | "credential_delivery_acknowledged"
  | "credential_delivery_pending"
  | "credential_expired"
  | "credential_not_found"
  | "credential_not_active"
  | "client_not_active"
  | "client_not_found"
  | "client_status_unchanged"
  | "idempotency_conflict"
  | "path_invalid"
  | "schema_unsupported"
  | "tenant_already_exists"
  | "tenant_not_active"
  | "tenant_not_found"
  | "tenant_status_unchanged";

export class TenantAccessRepositoryError extends Error {
  constructor(
    readonly code: TenantAccessRepositoryErrorCode,
    message = "Tenant access repository operation failed.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TenantAccessRepositoryError";
  }
}

export interface TenantAccessRepository {
  readonly managementTenantId: string;
  getState(): Promise<TenantAccessStateRecord>;
  createTenant(request: {
    readonly tenant: TenantRecord;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantRecord>>;
  setTenantStatus(request: {
    readonly tenantId: string;
    readonly status: TenantStatus;
    readonly updatedAt: string;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantRecord>>;
  setClientStatus(request: {
    readonly tenantId: string;
    readonly clientId: string;
    readonly status: ClientStatus;
    readonly updatedAt: string;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<ClientRecord>>;
  issueCredential(request: {
    readonly credential: StoredCredentialRecord;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<StoredCredentialRecord>>;
  rotateCredential(request: {
    readonly previousCredentialId: string;
    readonly credential: StoredCredentialRecord;
    readonly revokedAt: string;
    readonly nowSeconds: number;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<StoredCredentialRecord>>;
  revokeCredential(request: {
    readonly credentialId: string;
    readonly revokedAt: string;
    readonly nowSeconds: number;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<StoredCredentialRecord>>;
  acknowledgeCredentialDelivery(request: {
    readonly credentialId: string;
    readonly nowSeconds: number;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<StoredCredentialRecord>>;
  findCredentialForAuthentication(credentialId: string): Promise<{
    readonly tenant: TenantRecord;
    readonly client: ClientRecord;
    readonly credential: StoredCredentialRecord;
    readonly deliveryAcknowledgedAt: string | null;
  } | null>;
  markCredentialUsed(
    credentialId: string,
    usedAt: string,
    nowSeconds: number,
  ): Promise<boolean>;
  health(): Promise<{ readonly ready: boolean }>;
  close(): Promise<void>;
}
