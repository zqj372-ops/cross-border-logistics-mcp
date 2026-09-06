import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { importJWK, jwtVerify, type JWK, type JWTPayload } from "jose";

import type { PlatformRole, PortalIdentity } from "./contracts";
import type { PortalIdentityProvider, PortalOidcTransaction } from "./identity";

type PlatformIdentityRole = Exclude<PlatformRole, null>;
type JsonObject = Record<string, unknown>;

interface OidcDiscovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly tokenAuthMethod: "none" | "client_secret_basic";
}

export interface OidcPortalIdentityProviderOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly callbackUrl: string;
  readonly fetch?: typeof fetch;
  readonly roleClaimMap?: Readonly<Record<string, PlatformIdentityRole>>;
  readonly groupsClaim?: string;
  readonly timeoutMs?: number;
  readonly maxDiscoveryBytes?: number;
  readonly maxTokenBytes?: number;
  readonly maxJwksBytes?: number;
  readonly maxIdTokenAgeSeconds?: number;
  readonly allowInsecureLoopback?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_DISCOVERY_BYTES = 64 * 1024;
const DEFAULT_TOKEN_BYTES = 64 * 1024;
const DEFAULT_JWKS_BYTES = 256 * 1024;

function fail(code: string): never { throw new Error(code); }
function randomToken(bytes = 32): string { return randomBytes(bytes).toString("base64url"); }
function safeInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) fail("oidc_configuration_invalid");
  return selected;
}
function boundedText(value: unknown, maximum: number, error = "oidc_response_invalid"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) fail(error);
  return value;
}
function isLoopback(hostname: string): boolean { return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost"; }
function hasUnsafeUrlCharacter(value: string): boolean { return [...value].some((character) => { const code = character.charCodeAt(0); return character === "\\" || code <= 0x20 || code === 0x7f; }); }
function strictUrl(value: string, allowInsecureLoopback: boolean): URL {
  const allowedPrefix = value.startsWith("https://") || (allowInsecureLoopback && value.startsWith("http://"));
  const authorityAndPath = allowedPrefix ? value.slice(value.indexOf("//") + 2) : "";
  if (typeof value !== "string" || value.length > 2_048 || value.trim() !== value || !allowedPrefix || authorityAndPath.startsWith("/") || hasUnsafeUrlCharacter(value) || /%(?:2f|5c|2e)/iu.test(value) || /\/(?:\.{1,2})(?:\/|$)/u.test(value)) fail("oidc_configuration_invalid");
  let url: URL;
  try { url = new URL(value); } catch { fail("oidc_configuration_invalid"); }
  if (!url.hostname || url.username || url.password || url.search || url.hash || url.pathname.includes("//") || (url.protocol !== "https:" && !(allowInsecureLoopback && url.protocol === "http:" && isLoopback(url.hostname)))) fail("oidc_configuration_invalid");
  return url;
}
function exactIssuer(value: string, allowInsecureLoopback: boolean): string { strictUrl(value, allowInsecureLoopback); return value; }
function exactState(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function formEncode(value: string): string { return new URLSearchParams({ value }).toString().slice("value=".length); }
function jsonObject(value: unknown, error: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(error);
  return value as JsonObject;
}
function stringArray(value: unknown, error: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 256)) fail(error);
  return value as string[];
}
async function boundedJson(response: Response, maximum: number, error: string): Promise<JsonObject> {
  if (!response.ok) fail(error);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/jwk-set+json") fail(error);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) fail(error);
  if (!response.body) fail(error);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength; if (total > maximum) { await reader.cancel(); fail(error); }
      chunks.push(part.value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8")); } catch { fail(error); }
    return jsonObject(parsed, error);
  } catch (caught) {
    if (caught instanceof Error && caught.message === error) throw caught;
    fail(error);
  }
}

export class OidcPortalIdentityProvider implements PortalIdentityProvider {
  readonly kind = "oidc" as const;
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #clientSecret: string | null;
  readonly #callbackUrl: string;
  readonly #fetch: typeof fetch;
  readonly #roleClaimMap: ReadonlyMap<string, PlatformIdentityRole>;
  readonly #groupsClaim: string;
  readonly #timeoutMs: number;
  readonly #maxDiscoveryBytes: number;
  readonly #maxTokenBytes: number;
  readonly #maxJwksBytes: number;
  readonly #maxIdTokenAgeSeconds: number;
  readonly #allowInsecureLoopback: boolean;

  constructor(options: OidcPortalIdentityProviderOptions) {
    this.#allowInsecureLoopback = options.allowInsecureLoopback === true;
    this.#issuer = exactIssuer(options.issuer, this.#allowInsecureLoopback);
    this.#clientId = boundedText(options.clientId, 256, "oidc_configuration_invalid");
    this.#clientSecret = options.clientSecret === undefined ? null : boundedText(options.clientSecret, 4_096, "oidc_configuration_invalid");
    this.#callbackUrl = strictUrl(options.callbackUrl, this.#allowInsecureLoopback).toString();
    this.#fetch = options.fetch ?? fetch;
    this.#groupsClaim = options.groupsClaim ?? "groups";
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(this.#groupsClaim)) fail("oidc_configuration_invalid");
    const roleClaimMap = options.roleClaimMap ?? {};
    if (Object.entries(roleClaimMap).some(([group, role]) => !group || group.length > 256 || (role !== "reviewer" && role !== "operator"))) fail("oidc_configuration_invalid");
    this.#roleClaimMap = new Map(Object.entries(roleClaimMap));
    this.#timeoutMs = safeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 30_000);
    this.#maxDiscoveryBytes = safeInteger(options.maxDiscoveryBytes, DEFAULT_DISCOVERY_BYTES, 1_024, 1024 * 1024);
    this.#maxTokenBytes = safeInteger(options.maxTokenBytes, DEFAULT_TOKEN_BYTES, 1_024, 1024 * 1024);
    this.#maxJwksBytes = safeInteger(options.maxJwksBytes, DEFAULT_JWKS_BYTES, 1_024, 2 * 1024 * 1024);
    this.#maxIdTokenAgeSeconds = safeInteger(options.maxIdTokenAgeSeconds, 600, 60, 3_600);
  }

  async #request(url: string, init: RequestInit, maximum: number, error: string): Promise<JsonObject> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.#timeoutMs); timer.unref();
    try {
      const response = await this.#fetch(url, { ...init, redirect: "error", signal: controller.signal });
      return await boundedJson(response, maximum, error);
    } catch (caught) {
      if (caught instanceof Error && caught.message === error) throw caught;
      fail(error);
    } finally { clearTimeout(timer); }
  }

  async #discovery(): Promise<OidcDiscovery> {
    const discoveryBase = this.#issuer.replace(/\/$/u, "");
    const body = await this.#request(`${discoveryBase}/.well-known/openid-configuration`, { headers: { accept: "application/json" } }, this.#maxDiscoveryBytes, "oidc_discovery_invalid");
    const discoveredIssuer = exactIssuer(boundedText(body.issuer, 2_048), this.#allowInsecureLoopback);
    if (discoveredIssuer !== this.#issuer) fail("oidc_issuer_invalid");
    const endpoint = (value: unknown): string => {
      const parsed = strictUrl(boundedText(value, 2_048), this.#allowInsecureLoopback);
      if (parsed.origin !== new URL(this.#issuer).origin) fail("oidc_discovery_invalid");
      return parsed.toString();
    };
    const responseTypes = stringArray(body.response_types_supported, "oidc_discovery_invalid");
    const challengeMethods = stringArray(body.code_challenge_methods_supported, "oidc_discovery_invalid");
    const algorithms = stringArray(body.id_token_signing_alg_values_supported, "oidc_discovery_invalid");
    const authMethods = stringArray(body.token_endpoint_auth_methods_supported, "oidc_discovery_invalid");
    const tokenAuthMethod = this.#clientSecret === null ? "none" : "client_secret_basic";
    if (!responseTypes.includes("code") || !challengeMethods.includes("S256") || !algorithms.includes("RS256") || !authMethods.includes(tokenAuthMethod)) fail("oidc_discovery_invalid");
    return {
      issuer: discoveredIssuer,
      authorizationEndpoint: endpoint(body.authorization_endpoint),
      tokenEndpoint: endpoint(body.token_endpoint),
      jwksUri: endpoint(body.jwks_uri),
      tokenAuthMethod,
    };
  }

  async health():Promise<boolean>{try{const discovery=await this.#discovery();const jwks=await this.#request(discovery.jwksUri,{headers:{accept:"application/json"}},this.#maxJwksBytes,"oidc_jwks_unavailable");return Array.isArray(jwks.keys)&&jwks.keys.some(key=>key!==null&&typeof key==="object"&&!Array.isArray(key));}catch{return false;}}

  async begin(): Promise<PortalOidcTransaction> {
    const discovery = await this.#discovery();
    const state = randomToken(); const nonce = randomToken(); const codeVerifier = randomToken(48);
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const url = new URL(discovery.authorizationEndpoint);
    url.search = new URLSearchParams({ response_type: "code", client_id: this.#clientId, redirect_uri: this.#callbackUrl, scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    return Object.freeze({ state, nonce, codeVerifier, authorizationUrl: url.toString() });
  }

  async complete(input: { readonly code: string; readonly state: string; readonly transaction: PortalOidcTransaction }): Promise<PortalIdentity> {
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(input.state) || !/^[A-Za-z0-9_-]{32,128}$/u.test(input.transaction.state) || !exactState(input.state, input.transaction.state)) fail("oidc_state_invalid");
    const code = boundedText(input.code, 4_096);
    const codeVerifier = boundedText(input.transaction.codeVerifier, 128);
    const nonce = boundedText(input.transaction.nonce, 128);
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(codeVerifier) || !/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)) fail("oidc_transaction_invalid");
    const discovery = await this.#discovery();
    const tokenBody: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: this.#callbackUrl, code_verifier: codeVerifier };
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (discovery.tokenAuthMethod === "client_secret_basic") {
      const clientSecret = this.#clientSecret; if (clientSecret === null) fail("oidc_configuration_invalid");
      headers.authorization = `Basic ${Buffer.from(`${formEncode(this.#clientId)}:${formEncode(clientSecret)}`).toString("base64")}`;
    } else tokenBody.client_id = this.#clientId;
    const tokens = await this.#request(discovery.tokenEndpoint, { method: "POST", headers, body: new URLSearchParams(tokenBody) }, this.#maxTokenBytes, "oidc_token_exchange_failed");
    const idToken = boundedText(tokens.id_token, this.#maxTokenBytes, "oidc_token_invalid");
    const segments = idToken.split("."); if (segments.length !== 3 || segments[0]!.length > 4_096) fail("oidc_token_invalid");
    let header: JsonObject;
    try { header = jsonObject(JSON.parse(Buffer.from(segments[0]!, "base64url").toString("utf8")), "oidc_token_invalid"); } catch { fail("oidc_token_invalid"); }
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 256) fail("oidc_token_invalid");
    const jwks = await this.#request(discovery.jwksUri, { headers: { accept: "application/json" } }, this.#maxJwksBytes, "oidc_jwks_unavailable");
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0 || jwks.keys.length > 100 || jwks.keys.some((candidate) => !candidate || typeof candidate !== "object" || Array.isArray(candidate))) fail("oidc_jwks_invalid");
    const candidates = (jwks.keys as JWK[]).filter((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && candidate.alg === "RS256" && candidate.use === "sig");
    if (candidates.length !== 1) fail("oidc_signing_key_not_found");
    let payload: JWTPayload;
    try {
      const key = await importJWK(candidates[0]!, "RS256");
      payload = (await jwtVerify(idToken, key, { issuer: discovery.issuer, audience: this.#clientId, algorithms: ["RS256"], requiredClaims: ["sub", "iat", "exp", "nonce", "email", "email_verified"], maxTokenAge: this.#maxIdTokenAgeSeconds })).payload;
    } catch { fail("oidc_token_invalid"); }
    if (payload.nonce !== nonce) fail("oidc_nonce_invalid");
    if (payload.azp !== undefined && payload.azp !== this.#clientId) fail("oidc_audience_invalid");
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.#clientId) fail("oidc_audience_invalid");
    if (payload.email_verified !== true) fail("oidc_email_unverified");
    const email = boundedText(payload.email, 320).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/u.test(email)) fail("oidc_response_invalid");
    const groupsValue = payload[this.#groupsClaim];
    const groups = groupsValue === undefined ? [] : stringArray(groupsValue, "oidc_groups_invalid");
    const mappedRoles = [...new Set(groups.map((group) => this.#roleClaimMap.get(group)).filter((role): role is PlatformIdentityRole => role !== undefined))];
    if (mappedRoles.length > 1) fail("oidc_role_ambiguous");
    const name = typeof payload.name === "string" && payload.name.trim() === payload.name && payload.name.length > 0 && payload.name.length <= 200 ? payload.name : email;
    return Object.freeze({ userId: boundedText(payload.sub, 256), displayName: name, email, emailVerified: true, platformRole: mappedRoles[0] ?? null });
  }
}

export function createProductionPortalIdentityProvider(options: OidcPortalIdentityProviderOptions): OidcPortalIdentityProvider {
  return new OidcPortalIdentityProvider(options);
}
