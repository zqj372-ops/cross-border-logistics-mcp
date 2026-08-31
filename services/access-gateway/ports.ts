import type {
  AccessState,
  AdminPrincipal,
  AuditEvent,
  ClientRecord,
  JwksResponse,
  JwtClaims,
  ProviderKind,
  SignedJwt,
  StoredCredentialRecord,
  TenantRecord,
} from "./contracts";

export interface ProviderIdentity {
  readonly kind: ProviderKind;
}

export interface AdminIdentityProvider extends ProviderIdentity {
  authenticateAdmin(token: string): Promise<AdminPrincipal>;
}

export interface CredentialExchangeRecord {
  readonly tenant: TenantRecord;
  readonly client: ClientRecord;
  readonly credential: StoredCredentialRecord;
}

export interface CredentialRepository extends ProviderIdentity {
  findForExchange(credentialId: string): Promise<CredentialExchangeRecord | null>;
  listState(): Promise<AccessState>;
  markUsed(credentialId: string, usedAt: string, nowSeconds: number): Promise<boolean>;
}

export interface SecretPepperProvider extends ProviderIdentity {
  hashCredentialSecret(input: Readonly<{
    secret: string;
    salt: Uint8Array;
    pepperVersion: string;
  }>): Promise<Uint8Array>;
  verifyCredentialSecret(input: Readonly<{
    secret: string;
    material: Readonly<{
      salt: Uint8Array;
      expectedHash: Uint8Array;
      pepperVersion: string;
    }> | null;
  }>): Promise<boolean>;
}

export interface JwtSigningProvider extends ProviderIdentity {
  sign(claims: JwtClaims): Promise<SignedJwt>;
  getJwks(): Promise<JwksResponse>;
}

export interface RateLimitRepository extends ProviderIdentity {
  reserve(input: Readonly<{
    tenantId: string;
    clientId: string;
    credentialId: string;
    clientIp: string;
    nowSeconds: number;
  }>): Promise<boolean>;
}

export interface RevocationRepository extends ProviderIdentity {
  isRevoked(input: Readonly<{
    tenantId: string;
    clientId: string;
    credentialId: string;
    jti: string | null;
  }>): Promise<boolean>;
}

export interface GatewayAuditRepository extends ProviderIdentity {
  append(event: AuditEvent): Promise<void>;
}

export interface GatewayAuditRequestEvidence {
  readonly requestId: string;
  readonly eventCount: number;
}

export interface GatewayAuditEvidenceReader extends ProviderIdentity {
  readByRequestIds(input: Readonly<{
    requestIds: readonly string[];
  }>): Promise<readonly GatewayAuditRequestEvidence[]>;
}

export interface GatewayClock extends ProviderIdentity {
  nowSeconds(): number;
}

export interface GatewayRandomSource extends ProviderIdentity {
  opaque(prefix: "req" | "auth" | "jwt" | "audit" | "tenant" | "client" | "key"): string;
  bytes(length: number): Uint8Array;
}

export interface GatewayProviders {
  readonly adminIdentityProvider: AdminIdentityProvider;
  readonly auditRepository: GatewayAuditRepository;
  readonly clock: GatewayClock;
  readonly credentialRepository: CredentialRepository;
  readonly jwtSigningProvider: JwtSigningProvider;
  readonly randomSource: GatewayRandomSource;
  readonly rateLimitRepository: RateLimitRepository;
  readonly revocationRepository: RevocationRepository;
  readonly secretPepperProvider: SecretPepperProvider;
}
