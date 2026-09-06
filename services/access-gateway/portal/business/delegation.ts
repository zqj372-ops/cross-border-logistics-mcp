import { importPKCS8, SignJWT } from "jose";

export const DELEGATION_CLAIMS_VERSION = "freightclaw-delegation@2026-09-05.v1" as const;
export type PortalDelegationScope =
  | "customs.query"
  | "customs.tax.estimate"
  | "quote.zone_preview"
  | "quote.ai_extract_preview"
  | "quote.record_save"
  | "quote.record_read"
  | "quote.review_read"
  | "quote.review_manage"
  | "quote.document_generate"
  | "quote.document_read";
export interface PortalDelegationSignInput<S extends PortalDelegationScope = PortalDelegationScope> { readonly subject: string; readonly actorType: "user" | "service"; readonly tenantId: string; readonly serviceCallerId: string; readonly applicationId: string; readonly requestId: string; readonly scope: S }
export interface PortalDelegationClaims<S extends PortalDelegationScope = PortalDelegationScope> { readonly iss: string; readonly aud: string; readonly sub: string; readonly actor_type: "user" | "service"; readonly tenant_id: string; readonly service_caller_id: string; readonly application_id: string; readonly request_id: string; readonly scope: S; readonly iat: number; readonly nbf: number; readonly exp: number; readonly jti: string }
export interface PortalDelegationSignedToken<S extends PortalDelegationScope = PortalDelegationScope> { readonly token: string; readonly claims: PortalDelegationClaims<S> }
export interface PortalDelegationSigner { <S extends PortalDelegationScope>(input: PortalDelegationSignInput<S>): Promise<PortalDelegationSignedToken<S>> }

export interface Rs256DelegationSignerOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly privateKey: string | CryptoKey;
  readonly ttlSeconds?: number;
  readonly clock?: () => Date;
  readonly jti?: () => string;
}

const identifier = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);

function configuredUrl(value: string): string | null {
  if (Array.from(value).some((character) => character === "\\" || character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.search === "" && url.hash === "" && url.href === value ? value : null;
  } catch { return null; }
}

export async function createRs256DelegationSigner(options: Rs256DelegationSignerOptions): Promise<PortalDelegationSigner> {
  const ttl = options.ttlSeconds ?? 300;
  if (!configuredUrl(options.issuer) || !identifier(options.audience) || !identifier(options.keyId) || !Number.isInteger(ttl) || ttl < 1 || ttl > 300) {
    throw new Error("delegation_signer_configuration_invalid");
  }
  const key = typeof options.privateKey === "string" ? await importPKCS8(options.privateKey, "RS256") : options.privateKey;
  return async <S extends PortalDelegationScope>(input: PortalDelegationSignInput<S>): Promise<PortalDelegationSignedToken<S>> => {
    const now = Math.floor((options.clock?.() ?? new Date()).getTime() / 1000);
    const jti = options.jti?.() ?? crypto.randomUUID();
    if (![input.subject, input.tenantId, input.serviceCallerId, input.applicationId, input.requestId, jti].every(identifier)) throw new Error("delegation_claim_invalid");
    if (input.actorType === "service" && input.subject !== input.serviceCallerId) throw new Error("delegation_service_subject_invalid");
    const claims: PortalDelegationClaims<S> = Object.freeze({
      iss: options.issuer, aud: options.audience, sub: input.subject, actor_type: input.actorType,
      tenant_id: input.tenantId, service_caller_id: input.serviceCallerId,
      application_id: input.applicationId, request_id: input.requestId, scope: input.scope,
      iat: now, nbf: now, exp: now + ttl, jti,
    });
    const token = await new SignJWT({
      actor_type: claims.actor_type, tenant_id: claims.tenant_id, service_caller_id: claims.service_caller_id,
      application_id: claims.application_id, request_id: claims.request_id, scope: claims.scope,
    }).setProtectedHeader({ alg: "RS256", typ: "JWT", kid: options.keyId })
      .setIssuer(claims.iss).setAudience(claims.aud).setSubject(claims.sub)
      .setIssuedAt(claims.iat).setNotBefore(claims.nbf).setExpirationTime(claims.exp).setJti(claims.jti).sign(key);
    return Object.freeze({ token, claims });
  };
}
