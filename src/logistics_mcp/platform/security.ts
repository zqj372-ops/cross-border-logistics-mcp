import { isIP } from "node:net";

import { ACTOR_ROLES, type ExecutionContext } from "./context";
import { CrossTenantAccessError } from "./contract-errors";

export class SecurityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityPolicyError";
  }
}

export interface ShortLivedTokenValidationOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly nowSeconds?: number;
  readonly clockSkewSeconds?: number;
  readonly maxLifetimeSeconds?: number;
}

export interface ValidatedShortLivedTokenClaims extends Record<string, unknown> {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly tenant_id: string;
  readonly actor_role: string;
  readonly iat: number;
  readonly exp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  claims: Record<string, unknown>,
  field: string,
): string {
  const value = claims[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new SecurityPolicyError(`Token ${field} is required.`);
  }
  return value;
}

function requiredTimestamp(
  claims: Record<string, unknown>,
  field: string,
): number {
  const value = claims[field];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new SecurityPolicyError(`Token ${field} must be a positive integer.`);
  }
  return value as number;
}

/**
 * Validates claims after the configured authenticator has verified the token
 * signature. Signature verification and key rotation remain the responsibility
 * of that injected authenticator; this function enforces the gateway policy.
 */
export function validateShortLivedToken(
  input: unknown,
  options: ShortLivedTokenValidationOptions,
): ValidatedShortLivedTokenClaims {
  if (!isRecord(input)) {
    throw new SecurityPolicyError("Verified token claims are required.");
  }

  const issuer = requiredString(input, "iss");
  if (issuer !== options.issuer) {
    throw new SecurityPolicyError("Token issuer is not allowed.");
  }

  const audience = input.aud;
  const audienceMatches =
    typeof audience === "string"
      ? audience === options.audience
      : Array.isArray(audience) && audience.includes(options.audience);
  if (!audienceMatches) {
    throw new SecurityPolicyError("Token audience is not allowed.");
  }

  const subject = requiredString(input, "sub");
  const tenantId = requiredString(input, "tenant_id");
  const actorRole = requiredString(input, "actor_role");
  if (!(ACTOR_ROLES as readonly string[]).includes(actorRole)) {
    throw new SecurityPolicyError("Token actor role is not allowed.");
  }

  const issuedAt = requiredTimestamp(input, "iat");
  const expiresAt = requiredTimestamp(input, "exp");
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const clockSkew = options.clockSkewSeconds ?? 30;
  const maxLifetime = options.maxLifetimeSeconds ?? 15 * 60;

  if (issuedAt > now + clockSkew) {
    throw new SecurityPolicyError("Token issued-at time is in the future.");
  }
  if (expiresAt <= now - clockSkew) {
    throw new SecurityPolicyError("Token is expired.");
  }
  if (expiresAt <= issuedAt) {
    throw new SecurityPolicyError("Token expiration must be after issued-at time.");
  }
  if (expiresAt - issuedAt > maxLifetime + clockSkew) {
    throw new SecurityPolicyError("Token lifetime exceeds the short-lived limit.");
  }

  return {
    ...input,
    iss: issuer,
    aud: audience as string | readonly string[],
    sub: subject,
    tenant_id: tenantId,
    actor_role: actorRole,
    iat: issuedAt,
    exp: expiresAt,
  };
}

export function assertTenantScope(
  context: ExecutionContext,
  targetTenantId = context.tenantId,
): true {
  if (targetTenantId !== context.tenantId) {
    throw new CrossTenantAccessError();
  }
  return true;
}

function ipv4Value(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return null;
  return (
    ((numbers[0]! << 24) >>> 0) +
    (numbers[1]! << 16) +
    (numbers[2]! << 8) +
    numbers[3]!
  ) >>> 0;
}

function inIpv4Range(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

function ipv4IsPrivateOrReserved(hostname: string): boolean {
  const value = ipv4Value(hostname);
  if (value === null) return false;
  return (
    inIpv4Range(value, 0x00000000, 0x00000000) ||
    inIpv4Range(value, 0x0a000000, 0x0affffff) ||
    inIpv4Range(value, 0x64400000, 0x647fffff) ||
    inIpv4Range(value, 0x7f000000, 0x7fffffff) ||
    inIpv4Range(value, 0xa9fe0000, 0xa9feffff) ||
    inIpv4Range(value, 0xac100000, 0xac1fffff) ||
    inIpv4Range(value, 0xc0a80000, 0xc0a8ffff) ||
    inIpv4Range(value, 0xc0000000, 0xc00000ff) ||
    inIpv4Range(value, 0xc0000200, 0xc00002ff) ||
    inIpv4Range(value, 0xe0000000, 0xffffffff)
  );
}

function ipv6Bytes(hostname: string): number[] | null {
  let value = hostname.toLowerCase();
  if (value.includes("%")) return null;
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const embedded = ipv4Value(value.slice(lastColon + 1));
    if (embedded === null) return null;
    value = `${value.slice(0, lastColon)}:${((embedded >>> 16) & 0xffff).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => "0"), ...right].flatMap((part) => {
    const number = Number.parseInt(part, 16);
    return [(number >> 8) & 0xff, number & 0xff];
  });
}

function ipv6IsPrivateOrReserved(hostname: string): boolean {
  const bytes = ipv6Bytes(hostname);
  if (bytes === null || bytes.length !== 16) return false;
  const allZero = bytes.every((value) => value === 0);
  const loopback =
    bytes.slice(0, 15).every((value) => value === 0) && Number(bytes[15]) === 1;
  const uniqueLocal = (bytes[0]! & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80;
  const mappedV4 = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const mappedAddress = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  return allZero || loopback || uniqueLocal || linkLocal || (mappedV4 && ipv4IsPrivateOrReserved(mappedAddress));
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/**
 * Enforces the outbound URL policy before an adapter performs a request.
 * Hostname allowlisting is exact-match; DNS resolution is intentionally not
 * performed here because production egress must also enforce it at the proxy.
 */
export function assertAllowedOutboundUrl(
  input: string | URL,
  allowedHosts: readonly string[],
): true {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new SecurityPolicyError("Outbound URL is invalid.");
  }
  if (url.protocol !== "https:") {
    throw new SecurityPolicyError("Outbound URL must use HTTPS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SecurityPolicyError("Outbound URL credentials are not allowed.");
  }
  const hostname = normalizedHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new SecurityPolicyError("Loopback hostnames are not allowed.");
  }
  if (isIP(hostname) !== 0 || ipv4IsPrivateOrReserved(hostname) || ipv6IsPrivateOrReserved(hostname)) {
    throw new SecurityPolicyError("Private, link-local, or IP-literal hosts are not allowed.");
  }
  const normalizedAllowedHosts = allowedHosts.map((host) => normalizedHostname(host));
  if (!normalizedAllowedHosts.includes(hostname)) {
    throw new SecurityPolicyError("Outbound hostname is not allowlisted.");
  }
  return true;
}

export function redactSecurityError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:api[_ -]?key|token|secret|password|cookie)\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(/(?:address|street|full[_ -]?address|quote[_ -]?amount|amount|price|fee|tax[_ -]?document|tax)\s*[:=]\s*[^,;]+/gi, "sensitive=[opaque]");
}
