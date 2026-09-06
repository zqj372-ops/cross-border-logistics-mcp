export const BUSINESS_ACCESS_SCHEMA_VERSION = "business-access@2026-09-05.v1" as const;
export const BUSINESS_EXCHANGE_SCHEMA_VERSION = "business-exchange@2026-09-05.v1" as const;
export const BUSINESS_CALL_SCHEMA_VERSION = "business-call@2026-09-05.v1" as const;
export const BUSINESS_TOKEN_AUDIENCE = "freightclaw-business-api-v2" as const;
export const BUSINESS_OPERATIONS = Object.freeze(["customs.query", "customs.tax.estimate", "quote.zone_preview", "quote.ai_extract_preview", "quote.freightcom_ltl.preview"] as const);
export type BusinessOperation = typeof BUSINESS_OPERATIONS[number];
export type BusinessRequestState = "draft"|"submitted"|"in_review"|"needs_input"|"approved"|"rejected"|"withdrawn";
export type BusinessGrantState = "provisioning"|"active"|"suspended"|"revoked"|"expired";
export interface BusinessAccessRequest { requestId:string; organizationId:string; applicationId:string; clientId:string; applicantUserId:string; operations:readonly BusinessOperation[]; justification:string; state:BusinessRequestState; reviewReason:string|null; reviewerUserId:string|null; version:number; createdAt:string; updatedAt:string }
export interface BusinessGrant { grantId:string; organizationId:string; applicationId:string; clientId:string; requestId:string; operations:readonly BusinessOperation[]; state:BusinessGrantState; expiresAt:string|null; version:number; createdAt:string; updatedAt:string }
export type ApplicationCredentialT0Mode = "none"|"current_grant";
export interface BusinessCredential { credentialId:string; organizationId:string; applicationId:string; clientId:string; label:string; operations:readonly BusinessOperation[]; /** Missing on legacy records and therefore interpreted as none. */ t0Mode?:ApplicationCredentialT0Mode; status:"active"|"revoked"; deliveryStatus:"pending"|"acknowledged"; secretSalt:string; secretHash:string; secretLastFour:string; pepperVersion:string; createdAt:string; expiresAt:number; lastUsedAt:string|null; revokedAt:string|null; rotatedFromId:string|null; version:number }
export type BusinessCredentialPublic = Omit<BusinessCredential,"secretSalt"|"secretHash">;
export interface BusinessAuditEvent { auditId:string; organizationId:string|null; actorRef:string; action:string; objectRef:string; status:"success"|"blocked"|"unavailable"; requestId:string; createdAt:string }
export interface BusinessAccessData { requests:BusinessAccessRequest[]; grants:BusinessGrant[]; credentials:BusinessCredential[]; audit:BusinessAuditEvent[] }
export interface BusinessMutation<T> { idempotencyKey:string; expectedVersion?:number; input:T }
export interface BusinessEnvelope<T> { schema_version:typeof BUSINESS_ACCESS_SCHEMA_VERSION; status:"success"|"needs_input"|"manual_review"|"blocked"|"unavailable"; data:T|null; reason_codes:readonly string[] }
export interface BusinessJwtClaims { iss:string; aud:typeof BUSINESS_TOKEN_AUDIENCE; sub:string; token_use:"business_api"; tenant_id:string; client_id:string; application_id:string; credential_id:string; operations:readonly BusinessOperation[]; iat:number; nbf:number; exp:number; jti:string }
export class BusinessAccessError extends Error { constructor(readonly code:string){super(code);this.name="BusinessAccessError";} }
