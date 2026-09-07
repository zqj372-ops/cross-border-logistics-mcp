import {customsBrowseResult} from '../../customs-native/catalog';
import type {CustomsPackages} from '../../customs-native/packages';
import {packageList} from '../../customs-native/package-contracts';
import type { DocumentService } from '../../quote-documents/service';
import { VERSION as DOCUMENT_VERSION, outputSchemas as documentOutputSchemas } from '../../quote-documents/contracts';
import { calculate } from '../../quote-documents/engine';
import type { NativeFreightcomService } from './native-freightcom';
import type { NativeAdminService } from './native-admin';
import { NATIVE_ADMIN_VERSION, nativeDataSchema, freightcomViewSchema, type NativeKind } from './native-admin-contracts';
import { CliAuthorization } from "./cli-auth";
import type { ChannelService } from "./channels";
import { CHANNEL_VERSION, channelHistorySchema, channelViewSchema, channelListSchema, channelPreviewSchema } from "./channel-contracts";
import { FixtureFormLogin } from "./form-login";
import { CASE_VERSION, caseResponseSchema, type CaseService } from "./cases";
import type { PortalPublicCustomsService } from "./public-customs";
import type { PortalCallLogService } from "./call-log";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { PORTAL_CAPABILITIES, PortalError, PORTAL_SCHEMA_VERSION, type Membership, type PortalCapabilityId, type PortalContext, type PortalMutation } from "./contracts";
import type { PortalIdentityProvider } from "./identity";
import type { PortalSession, PortalSessionManager } from "./session";
import { parsePortalSessionCookie } from "./session";
import type { PortalService } from "./service";
import type { OrganizationBridge } from "./organization-bridge";
import type { PortalBusinessService, PortalBusinessOperation } from "./business/service";
import type { BusinessAccessService } from "./business-access/service";
import { BusinessAccessError } from "./business-access/contracts";
import { handleBusinessAccessRequest } from "./business-access/console";

const API_PREFIX = "/console/api/v1";
const DEFAULT_MAX_BODY_BYTES = 32 * 1024;

type PortalServicePort = Pick<PortalService,
  "getState" | "getReviewQueue" | "getProvisioningQueue" | "getPlatformState" | "inviteMember" | "claimInvitation" | "revokeInvitation" | "changeMembership" |
  "createApplication" | "changeApplication" | "createRequest" | "submitRequest" | "withdrawRequest" |
  "markRequestInReview" | "decideRequest" | "updateRequest" | "changeGrantState" | "changeGrantCapabilities"
>;

export interface PortalCredentialBridge {
  createApplication?(context: PortalContext, mutation: PortalMutation<Readonly<{ name: string; purpose: string; environment: "test" | "production"; ownerUserId?: string }>>): unknown;
  provisionGrant?(context: PortalContext, grantId: string, mutation: PortalMutation<Readonly<{ expiresAt?: string }>>): unknown;
  getCredentialState?(context: PortalContext, applicationId: string): unknown;
  issueCredential?(context: PortalContext, applicationId: string, mutation: PortalMutation<Record<string, unknown>>): unknown;
  acknowledgeCredentialDelivery?(context: PortalContext, applicationId: string, credentialId: string, mutation: PortalMutation<Record<string, never>>): unknown;
  rotateCredential?(context: PortalContext, applicationId: string, credentialId: string, mutation: PortalMutation<Record<string, unknown>>): unknown;
  revokeCredential?(context: PortalContext, applicationId: string, credentialId: string, mutation: PortalMutation<Record<string, never>>): unknown;
}

export interface PortalHttpOptions {
  readonly mode: "fixtures" | "production";
  readonly service: PortalServicePort;
  readonly bridge?: PortalCredentialBridge;
  readonly organizationBridge?: Pick<OrganizationBridge, "listOrganizationAdmissions" | "createOrganization" | "getOrganizationAdmission" | "setOrganizationStatus">;
  readonly businessService?: Pick<PortalBusinessService, "describe" | "execute" | "executeBatch"> & Partial<Pick<PortalBusinessService, "records" | "customsHistory">>;
  readonly publicCustoms?: PortalPublicCustomsService;
  readonly callLogService?: PortalCallLogService;
  readonly caseService?: CaseService;
  readonly channelService?: ChannelService;
  readonly nativeAdmin?: NativeAdminService;
 readonly customsPackages?:CustomsPackages;
  readonly documentService?: DocumentService;
  readonly nativeFreightcom?: NativeFreightcomService;
  readonly businessAccessService?: BusinessAccessService;
  readonly identityProvider: PortalIdentityProvider;
  readonly sessions: PortalSessionManager;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly allowLoopbackHttp?: boolean;
  readonly trustedProxyAddresses?: readonly string[];
  readonly maxBodyBytes?: number;
}
export interface PortalHttpHandler { handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> }

function requestId(request: IncomingMessage): string {
  const value = request.headers["x-request-id"];
  return typeof value === "string" && /^req_[A-Za-z0-9_-]{8,128}$/u.test(value) ? value : `req_${randomUUID().replaceAll("-", "")}`;
}
function rawHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0; for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index]?.toLowerCase() === name) count += 1; return count;
}
function loopback(value: string | undefined): boolean { return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"; }
function boundary(request: IncomingMessage, options: PortalHttpOptions, write: boolean): void {
  const host = request.headers.host;
  if (rawHeaderCount(request, "host") !== 1 || typeof host !== "string" || !options.allowedHosts.includes(host)) throw new PortalError("invalid_host");
  const remote = request.socket.remoteAddress;
  const trusted = remote !== undefined && (options.trustedProxyAddresses ?? []).includes(remote);
  const directTls = (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted === true;
  const forwardedTls = trusted && rawHeaderCount(request, "x-forwarded-proto") === 1 && request.headers["x-forwarded-proto"] === "https";
  const localHttp = options.allowLoopbackHttp === true && loopback(request.socket.localAddress) && loopback(remote);
  if (!directTls && !forwardedTls && !localHttp) throw new PortalError("transport_required");
  if (trusted) {
    const forwarded = request.headers["x-forwarded-for"];
    if (rawHeaderCount(request, "x-forwarded-for") !== 1 || typeof forwarded !== "string" || forwarded.includes(",") || isIP(forwarded.trim()) === 0) throw new PortalError("forwarded_address_invalid");
  }
  if (write) {
    const origin = request.headers.origin;
    if (rawHeaderCount(request, "origin") !== 1 || typeof origin !== "string" || !options.allowedOrigins.includes(origin)) throw new PortalError("origin_denied");
  }
}
function snakeKey(key: string): string { return key.replace(/[A-Z]/gu, (value) => `_${value.toLowerCase()}`); }
function wire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [snakeKey(key), wire(item)]));
  return value;
}
function commonHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer"); response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'");
}
function json(response: ServerResponse, status: number, body: unknown, cookie?: string, preserveSourceShape = false): void {
  response.statusCode = status; commonHeaders(response); response.setHeader("content-type", "application/json; charset=utf-8"); if (cookie) response.setHeader("set-cookie", cookie); response.end(JSON.stringify(preserveSourceShape ? body : wire(body)));
}
function errorStatus(code: string): number {
  if (code === "document_pdf_invalid") return 503;
  if (code === "case_daily_limit" || code === "cli_rate_limited") return 429;
  if (code === "case_transition_invalid") return 409;
  if (code === "login_rate_limited") return 429;
  if (code === "login_invalid" || code === "authentication_required") return 401;
  if (code === "csrf_invalid" || code === "origin_denied" || code === "invalid_host" || code === "transport_required") return 403;
  if (code.includes("not_found") || code === "invitation_unavailable") return 404;
  if (code.includes("conflict") || code.includes("exists") || code === "last_owner_protected" || code === "application_owner_protected") return 409;
  if (code.includes("required") || code.includes("denied") || code.includes("forbidden") || code.includes("mismatch") || code.includes("protected")) return 403;
  if (code.includes("unavailable") || code.includes("not_configured") || code.includes("unconfigured")) return 503;
  return 400;
}
function errorCode(error: unknown): string {
  return error instanceof PortalError ? error.code : error instanceof Error && /^[a-z0-9_]+$/u.test(error.message) ? error.message : "portal_unavailable";
}
function sendError(response: ServerResponse, id: string, error: unknown): void {
  const code = errorCode(error);
  const status = errorStatus(code); json(response, status, { schema_version: PORTAL_SCHEMA_VERSION, status: status === 503 ? "unavailable" : status === 400 ? "needs_input" : "blocked", data: null, reason_codes: [code], request_id: id });
}
function browserAuthRecovery(request: IncomingMessage, path: string, error: unknown): string | null {
  if (request.method !== "GET" || (path !== "/console/auth/login" && path !== "/console/auth/callback")) return null;
  const accept = request.headers.accept;
  if (typeof accept !== "string" || !accept.split(",").some((value) => value.trim().split(";", 1)[0]?.toLowerCase() === "text/html")) return null;
  const code = errorCode(error);
  return ["authentication_required", "oidc_session_invalid", "oidc_state_invalid"].includes(code) ? "login_expired"
    : ["oidc_email_unverified", "oidc_token_invalid", "oidc_nonce_invalid", "oidc_role_ambiguous", "oidc_authorization_denied"].includes(code) ? "login_rejected"
      : "login_unavailable";
}
function redirectAuthRecovery(response: ServerResponse, category: string): void {
  response.statusCode = 303; commonHeaders(response); response.setHeader("location", `/console/?auth_error=${category}`); response.end();
}
async function body(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) throw new PortalError("content_type_invalid");
  const declared = request.headers["content-length"];
  if (Array.isArray(declared)) throw new PortalError("body_invalid");
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) throw new PortalError("body_too_large");
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); total += bytes.length; if (total > maxBytes) throw new PortalError("body_too_large"); chunks.push(bytes); }
  let parsed: unknown; try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new PortalError("body_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PortalError("body_invalid"); return parsed as Record<string, unknown>;
}
function closed(input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]); if (Object.keys(input).some((key) => !allowed.has(key)) || required.some((key) => !(key in input))) throw new PortalError("body_invalid");
}
function text(input: Record<string, unknown>, key: string): string { const value = input[key]; if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new PortalError("body_invalid"); return value; }
function timestamp(input:Record<string,unknown>,key:string):string{const value=text(input,key);if(!Number.isFinite(Date.parse(value)))throw new PortalError("body_invalid");return value;}
function choice<const T extends readonly string[]>(input: Record<string, unknown>, key: string, allowed: T): T[number] { const value = text(input,key); if(!allowed.includes(value))throw new PortalError("body_invalid"); return value; }
function integer(input: Record<string, unknown>, key: string): number { const value = input[key]; if (!Number.isSafeInteger(value) || Number(value) < 1) throw new PortalError("body_invalid"); return Number(value); }
function capabilities(input: Record<string, unknown>, key = "capabilities"): readonly PortalCapabilityId[] { const value=input[key]; if(!Array.isArray(value)||value.length===0||value.length>PORTAL_CAPABILITIES.length||new Set(value).size!==value.length||value.some(item=>typeof item!=="string"||!PORTAL_CAPABILITIES.includes(item as PortalCapabilityId)))throw new PortalError("body_invalid"); return value as PortalCapabilityId[]; }
function idempotency(request: IncomingMessage): string { const value = request.headers["idempotency-key"]; if (rawHeaderCount(request, "idempotency-key") !== 1 || typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(value)) throw new PortalError("idempotency_key_invalid"); return value; }
function sessionFor(request: IncomingMessage, options: PortalHttpOptions, required = true): PortalSession {
  const session = options.sessions.get(parsePortalSessionCookie(request.headers.cookie)); if (!session) throw new PortalError("authentication_required"); if (required && !session.identity) throw new PortalError("authentication_required"); return session;
}
function context(session: PortalSession): PortalContext { if (!session.identity) throw new PortalError("authentication_required"); return { identity: session.identity, organizationId: session.organizationId }; }
function csrf(request: IncomingMessage, options: PortalHttpOptions, session: PortalSession): void { const supplied = request.headers["x-csrf-token"]; if (rawHeaderCount(request, "x-csrf-token") !== 1 || typeof supplied !== "string" || !options.sessions.verifyCsrf(session, supplied)) throw new PortalError("csrf_invalid"); }
function stateMemberships(value: unknown): readonly Membership[] {
  if (!value || typeof value !== "object" || !("data" in value)) return [];
  const data = (value as { data?: unknown }).data; if (!data || typeof data !== "object" || !("memberships" in data)) return [];
  return Array.isArray((data as { memberships?: unknown }).memberships) ? (data as { memberships: Membership[] }).memberships : [];
}
function sessionBody(options: PortalHttpOptions, session: PortalSession): Record<string, unknown> {
  const fixtures = options.mode === "fixtures" ? options.identityProvider.listFixtureIdentities?.() ?? [] : [];
  return { schema_version: PORTAL_SCHEMA_VERSION, mode: options.mode, authenticated: session.identity !== null, identity: session.identity, organization_id: session.organizationId, csrf_token: session.csrfToken, fixture_identities: fixtures };
}
function mutation<T>(request: IncomingMessage, input: T, expectedVersion?: number): PortalMutation<T> { return expectedVersion === undefined ? { idempotencyKey: idempotency(request), input } : { idempotencyKey: idempotency(request), expectedVersion, input }; }
function stableResourceId(prefix: string, context: PortalContext, key: string): string {
  if (!context.organizationId) throw new PortalError("organization_required");
  return `${prefix}_${createHash("sha256").update(`${context.organizationId}\0${context.identity.userId}\0${key}`).digest("hex").slice(0,24)}`;
}
function authenticatedResourcePath(path: string): boolean {
  if (/^\/console\/api\/v1\/quote-documents\/(config|config-save|preview|native-prepare|save|list|get|approve|reject|export)$/u.test(path)) return true;
  if (/^\/console\/api\/v1\/admin\/freightcom(?:\/(save|disable))?$/u.test(path)) return true;
  if (/^\/console\/api\/v1\/admin\/customs-packages(?:\/(import|publish|disable|browse))?$/u.test(path)) return true;
  if (/^\/console\/api\/v1\/admin\/(customs-data|residential-rates)(?:\/(save|preview|publish|disable|rollback))?$/u.test(path)) return true;
  if (/^\/console\/api\/v1\/admin\/channels(?:\/[0-9a-f-]{36}(?:\/(?:save|preview|publish|disable|history|rollback))?)?$/u.test(path)) return true;
  if (/^\/console\/api\/v1\/cases(?:\/[0-9a-f-]{36}(?:\/(?:update|reply))?)?$/u.test(path)) return true;
  if (path.startsWith(`${API_PREFIX}/business-access/`)) return true;
  if (/^\/console\/api\/v1\/business\/quote\/records\/(prepare|save|get|list|review)$/u.test(path)) return true;
  if (path === `${API_PREFIX}/business/quote/review-queue` || /^\/console\/api\/v1\/business\/quote\/review-tasks\/[^/]+\/(?:resolution-preview|resolve)$/u.test(path)) return true;
  if (/^\/console\/api\/v1\/business\/quote\/records\/[^/]+\/documents$/u.test(path) || /^\/console\/api\/v1\/business\/quote\/documents\/[^/]+(?:\/content)?$/u.test(path)) return true;
  if (path === `${API_PREFIX}/my-organizations` || path === `${API_PREFIX}/calls`) return true;
  if (/^\/console\/api\/v1\/business\/customs\/history\/(?:list|get)$/u.test(path)) return true;
  if ([`${API_PREFIX}/business/services`, `${API_PREFIX}/business/customs/query`, `${API_PREFIX}/business/customs/tax-estimate`, `${API_PREFIX}/business/customs/tax-estimates/batch`, `${API_PREFIX}/business/quote/preview`, `${API_PREFIX}/business/quote/extract`, `${API_PREFIX}/business/quote/freightcom-ltl-preview`].includes(path)) return true;
  if (path === `${API_PREFIX}/organizations` || /^\/console\/api\/v1\/organizations\/[^/]+(?:\/status)?$/u.test(path)) return true;
  return path === `${API_PREFIX}/state` || path === `${API_PREFIX}/review-queue` || path === `${API_PREFIX}/provisioning-queue` || path === `${API_PREFIX}/platform-state` || path === `${API_PREFIX}/session/organization` || path === `${API_PREFIX}/invitations` || path === `${API_PREFIX}/applications` || path === `${API_PREFIX}/requests`
    || /^\/console\/api\/v1\/(?:invitations\/[^/]+\/(?:accept|revoke)|memberships\/[^/]+\/status|applications\/[^/]+(?:\/credentials(?:\/status|\/[^/]+\/(?:acknowledge|rotate|revoke))?)?|requests\/[^/]+(?:\/(?:submit|withdraw|review|decision))?|grants\/[^/]+\/(?:status|scope|provision))$/u.test(path);
}

export function createPortalHttpHandler(options: PortalHttpOptions): PortalHttpHandler {
  const cliAuth=new CliAuthorization(options.sessions);
  const formLogin=options.mode==="fixtures"&&options.identityProvider.kind==="fixture"?new FixtureFormLogin():null;
  return { async handle(request, response): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://portal.invalid"); const path = url.pathname; const id = requestId(request);
    if (!path.startsWith(API_PREFIX) && path !== "/console/auth/login" && path !== "/console/auth/callback") return false;
    let boundaryPassed = false;
    try {
      const write = request.method !== "GET" && request.method !== "HEAD";
      boundary(request, options, write);
      boundaryPassed = true;
      if (path === `${API_PREFIX}/session` && request.method === "GET") { const ensured = options.sessions.ensure(parsePortalSessionCookie(request.headers.cookie)); json(response, 200, sessionBody(options, ensured.session), ensured.setCookie); return true; }
      if(path.startsWith(`${API_PREFIX}/cli-auth/`)){
        if(!cliAuth)throw new PortalError("cli_auth_unavailable");
        if(url.search)throw new PortalError("body_invalid");
        if(request.method!=="POST"){json(response,405,{status:"blocked",reason_codes:["method_not_allowed"]});return true;}
        const input=await body(request,1024);let data:unknown;
        if(path===`${API_PREFIX}/cli-auth/start`){closed(input,[]);data=cliAuth.start(request.socket.remoteAddress??"unknown");}
        else if(path===`${API_PREFIX}/cli-auth/poll`){closed(input,["device_secret"]);data=cliAuth.poll(text(input,"device_secret"));}
        else {const browser=sessionFor(request,options);csrf(request,options,browser);closed(input,["user_code"]);options.service.getState(context(browser));
          if(path===`${API_PREFIX}/cli-auth/inspect`)data=cliAuth.inspect(text(input,"user_code"));
          else if(path===`${API_PREFIX}/cli-auth/approve`)data=cliAuth.approve(text(input,"user_code"),browser);
          else throw new PortalError("route_not_found");}
        json(response,200,{schema_version:"portal-cli-auth@2026-09-07.v1",status:"success",data,reason_codes:[]});return true;
      }
      if(path===`${API_PREFIX}/login/captcha`||path===`${API_PREFIX}/login/password`){
        if(!formLogin||!options.identityProvider.authenticateFixture)throw new PortalError("fixture_identity_forbidden");
        const current=sessionFor(request,options,false),address=request.socket.remoteAddress??"unknown";
        if(url.search)throw new PortalError("body_invalid");
        if(path.endsWith("/captcha")&&request.method==="GET"){json(response,200,{status:"success",data:formLogin.challenge(current.sessionId,address)});return true;}
        if(path.endsWith("/password")&&request.method==="POST"){
          csrf(request,options,current);idempotency(request);
          const input=await body(request,4096);closed(input,["account","password","captcha_id","captcha"]);
          const identityId=formLogin.verify(current.sessionId,address,{account:text(input,"account"),password:text(input,"password"),captcha_id:text(input,"captcha_id"),captcha:text(input,"captcha")});
          const identity=await options.identityProvider.authenticateFixture(identityId),authenticated=options.sessions.authenticate(current.sessionId,identity);
          json(response,200,sessionBody(options,authenticated.session),authenticated.setCookie);return true;
        }
        json(response,405,{status:"blocked",data:null,reason_codes:["method_not_allowed"]});return true;
      }
      if (path === `${API_PREFIX}/fixture-login` && request.method === "POST") {
        if (options.mode !== "fixtures" || options.identityProvider.kind !== "fixture" || !options.identityProvider.authenticateFixture) throw new PortalError("fixture_identity_forbidden");
        const current = sessionFor(request, options, false); csrf(request, options, current); idempotency(request); const input = await body(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES); closed(input, ["identity_id"]);
        const identity = await options.identityProvider.authenticateFixture(text(input, "identity_id")); const authenticated = options.sessions.authenticate(current.sessionId, identity); json(response, 200, sessionBody(options, authenticated.session), authenticated.setCookie); return true;
      }
      if (path === `${API_PREFIX}/logout` && request.method === "POST") { const current = sessionFor(request, options, false); csrf(request, options, current); idempotency(request); const input = await body(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES); closed(input, []); const loggedOut = options.sessions.logout(current.sessionId); json(response, 200, sessionBody(options, loggedOut.session), loggedOut.setCookie); return true; }
      if (path === "/console/auth/login" && request.method === "GET") {
        if (options.identityProvider.kind !== "oidc" || !options.identityProvider.begin) throw new PortalError("oidc_not_configured"); const ensured = options.sessions.ensure(parsePortalSessionCookie(request.headers.cookie)); const transaction = await options.identityProvider.begin(); const pending = options.sessions.beginOidc(ensured.session.sessionId, transaction); response.statusCode = 302; commonHeaders(response); response.setHeader("set-cookie", options.sessions.cookieFor(pending)); response.setHeader("location", transaction.authorizationUrl); response.end(); return true;
      }
      if (path === "/console/auth/callback" && request.method === "GET") {
        if (!options.identityProvider.complete) throw new PortalError("oidc_not_configured"); const state = url.searchParams.get("state") ?? ""; const code = url.searchParams.get("code") ?? ""; const current = sessionFor(request, options, false); const transaction = options.sessions.consumeOidc(current.sessionId, state); const identity = await options.identityProvider.complete({ code, state, transaction }); const authenticated = options.sessions.authenticate(current.sessionId, identity); response.statusCode = 303; commonHeaders(response); response.setHeader("set-cookie", authenticated.setCookie); response.setHeader("location", "/console/"); response.end(); return true;
      }
      const publicRoutes: Readonly<Record<string, { operation: PortalBusinessOperation; batch: boolean }>> = {
        [`${API_PREFIX}/public/customs/query`]: { operation: "customs.query", batch: false },
        [`${API_PREFIX}/public/customs/tax-estimate`]: { operation: "customs.tax.estimate", batch: false },
        [`${API_PREFIX}/public/customs/tax-estimates/batch`]: { operation: "customs.tax.estimate", batch: true },
      };
      const publicRoute = publicRoutes[path];
      if (publicRoute || path === `${API_PREFIX}/public/customs/quota`) {
        if (url.search) throw new PortalError("public_query_invalid");
        if (!options.publicCustoms) throw new PortalError("public_customs_unavailable");
        const remote = request.socket.remoteAddress!;
        const address = (options.trustedProxyAddresses ?? []).includes(remote) ? String(request.headers["x-forwarded-for"]).trim() : remote;
        if (!publicRoute && request.method === "GET") {
          json(response, 200, { schema_version: PORTAL_SCHEMA_VERSION, status: "success", data: options.publicCustoms.status(address), reason_codes: [] }); return true;
        }
        if (publicRoute && request.method === "POST") {
          csrf(request, options, sessionFor(request, options, false));
          const payload = await body(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES); closed(payload, ["input"]);
          const result = await options.publicCustoms.execute(address, publicRoute.operation, payload.input, id, publicRoute.batch);
          if (result.quota) {
            response.setHeader("x-freightclaw-quota-limit", result.quota.limit);
            response.setHeader("x-freightclaw-quota-remaining", result.quota.remaining);
            response.setHeader("x-freightclaw-quota-reset", result.quota.resets_at);
            if (result.httpStatus === 429) response.setHeader("retry-after", Math.max(1, Math.ceil((Date.parse(result.quota.resets_at) - Date.now()) / 1000)));
          }
          json(response, result.httpStatus, result.body, undefined, true); return true;
        }
        json(response, 405, { schema_version: PORTAL_SCHEMA_VERSION, status: "blocked", data: null, reason_codes: ["method_not_allowed"] }); return true;
      }
      if (!authenticatedResourcePath(path)) { json(response,404,{schema_version:PORTAL_SCHEMA_VERSION,status:"blocked",data:null,reason_codes:["route_not_found"],request_id:id}); return true; }
      const current = sessionFor(request, options); const ctx = context(current);
      if (write) csrf(request, options, current);
      const nativeDocumentMatch=/^\/console\/api\/v1\/quote-documents\/(config|config-save|preview|native-prepare|save|list|get|approve|reject|export)$/u.exec(path);
      if(nativeDocumentMatch){
        const service=options.documentService;if(!service)throw new PortalError('document_service_unavailable');if(url.search)throw new PortalError('document_input_invalid');const action=nativeDocumentMatch[1];let data:unknown;
        if(action==='config'&&request.method==='GET')data=service.config(ctx);
        else if(request.method==='POST'&&action!=='config'){const input=await body(request,131072);switch(action){case 'config-save':data=service.saveConfig(ctx,input,idempotency(request));break;case 'preview':{const p=service.preview(ctx,input);data={...p,totals:calculate(p.input)};break;}case 'native-prepare':{const p=await service.prepareNative(ctx,input);data={...p,totals:calculate(p.input)};break;}case 'reject':data=service.reject(ctx,input,idempotency(request));break;case 'save':data=service.save(ctx,input,idempotency(request));break;case 'list':data=service.list(ctx,input);break;case 'get':data=service.get(ctx,input);break;case 'approve':data=service.approve(ctx,input,idempotency(request));break;case 'export':data=await service.export(ctx,input);break;}}
        else throw new PortalError('method_not_allowed');data=documentOutputSchemas[action!]!.parse(data);json(response,200,{schema_version:DOCUMENT_VERSION,status:'success',data,reason_codes:[]},undefined,true);return true;
      }
      const nativeFreightcom=/^\/console\/api\/v1\/admin\/freightcom(?:\/(save|disable))?$/u.exec(path);
      if(nativeFreightcom){if(!options.nativeFreightcom)throw new PortalError("native_admin_unavailable");if(url.search)throw new PortalError("native_input_invalid");const action=nativeFreightcom[1];let data:unknown;if(request.method==="GET"&&!action)data=options.nativeFreightcom.get(ctx);else if(request.method==="POST"&&action)data=options.nativeFreightcom.change(ctx,await body(request,8192),idempotency(request),action==="disable");else throw new PortalError("method_not_allowed");data=freightcomViewSchema.parse(data);json(response,200,{schema_version:NATIVE_ADMIN_VERSION,status:"success",data,reason_codes:[]},undefined,true);return true;}
      const packagesMatch=/^\/console\/api\/v1\/admin\/customs-packages(?:\/(import|publish|disable|browse))?$/u.exec(path);
      if(packagesMatch){const service=options.customsPackages;if(!service)throw new PortalError('native_admin_unavailable');if(url.search)throw new PortalError('native_input_invalid');const action=packagesMatch[1];let data:unknown;if(request.method==='GET'&&!action)data=service.list(ctx);else if(request.method==='POST'&&action){const input=await body(request,8192),key=action==='browse'?'':idempotency(request);if(action==='browse')data=service.browse(ctx,input);else if(action==='import')data=await service.import(ctx,input,key);else if(action==='publish')data=await service.publish(ctx,input,key);else data=service.disable(ctx,input,key);}else throw new PortalError('method_not_allowed');json(response,200,{schema_version:'native-customs-packages@2026-09-08.v1',status:'success',data:(action==='browse'?customsBrowseResult:packageList).parse(data),reason_codes:[]},undefined,true);return true;}
      const nativeMatch=/^\/console\/api\/v1\/admin\/(customs-data|residential-rates)(?:\/(save|preview|publish|disable|rollback))?$/u.exec(path);
      if(nativeMatch){
        if(!options.nativeAdmin)throw new PortalError("native_admin_unavailable");const service=options.nativeAdmin,kind:NativeKind=nativeMatch[1]==="customs-data"?"customs":"residential",action=nativeMatch[2];let data:unknown;
        if(request.method==="GET"){const release=url.searchParams.get("release_id");if(url.search&&!(action==="preview"&&release&&/^[0-9a-f-]{36}$/u.test(release)&&[...url.searchParams.keys()].length===1))throw new PortalError("native_input_invalid");if(!action)data=service.get(ctx,kind);else if(action==="preview")data=service.preview(ctx,kind,release??undefined);else throw new PortalError("method_not_allowed");}
        else if(request.method==="POST"&&!url.search){const input=await body(request,16*1024*1024),key=idempotency(request);if(action==="save")data=service.save(ctx,kind,input,key);else if(action==="publish")data=service.publish(ctx,kind,input,key);else if(action==="disable")data=service.disable(ctx,kind,input,key);else if(action==="rollback")data=service.rollback(ctx,kind,input,key);else throw new PortalError("method_not_allowed");}else throw new PortalError("method_not_allowed");
        data=nativeDataSchema(kind,action==="preview").parse(data);
        json(response,200,{schema_version:NATIVE_ADMIN_VERSION,status:"success",data,reason_codes:[]},undefined,true);return true;
      }
      const channelMatch=/^\/console\/api\/v1\/admin\/channels(?:\/([0-9a-f-]{36})(?:\/(save|preview|publish|disable|history|rollback))?)?$/u.exec(path);
      if(channelMatch){
        if(!options.channelService)throw new PortalError("channels_unavailable");const service=options.channelService,cid=channelMatch[1],action=channelMatch[2];let data:unknown;
        if(request.method==="GET"){
          const release=url.searchParams.get("release_id");if(url.search && !(action==="preview"&&release&&[...url.searchParams.keys()].length===1))throw new PortalError("channel_input_invalid");
          if(!cid)data=channelListSchema.parse(service.list(ctx));else if(!action)data=channelViewSchema.parse(service.get(ctx,cid));else if(action==="preview")data=channelPreviewSchema.parse(service.preview(ctx,cid,release??undefined));else if(action==="history")data=channelHistorySchema.parse(service.history(ctx,cid));else throw new PortalError("method_not_allowed");
        }else if(request.method==="POST"&&!url.search){const input=await body(request,8192),key=idempotency(request);
          if(!cid)data=service.create(ctx,input,key);else if(action==="save")data=service.save(ctx,cid,input,key);else if(action==="publish")data=service.publish(ctx,cid,input,key);else if(action==="disable")data=service.disable(ctx,cid,input,key);else if(action==="rollback")data=service.rollback(ctx,cid,input,key);else throw new PortalError("method_not_allowed");data=channelViewSchema.parse(data);
        }else throw new PortalError("method_not_allowed");
        json(response,200,{schema_version:CHANNEL_VERSION,status:"success",data,reason_codes:[]},undefined,true);return true;
      }
      const caseMatch = /^\/console\/api\/v1\/cases(?:\/([0-9a-f-]{36})(?:\/(update|reply))?)?$/u.exec(path);
      if (caseMatch) {
        if (!options.caseService) throw new PortalError("cases_unavailable");
        const service = options.caseService; let data: unknown;
        if (request.method === "GET" && !caseMatch[2]) {
          const entries=[...url.searchParams.entries()];
          if(new Set(entries.map(([key])=>key)).size!==entries.length)throw new PortalError("case_input_invalid");
          const query:Record<string,unknown>=Object.fromEntries(entries);
          if(query.management!==undefined){if(query.management!=="true"&&query.management!=="false")throw new PortalError("case_input_invalid");query.management=query.management==="true";}
          if(query.limit!==undefined)query.limit=Number(query.limit);
          if(caseMatch[1]&&entries.length)throw new PortalError("case_input_invalid");
          data=caseMatch[1]?service.get(ctx,caseMatch[1]):service.list(ctx,query);
        } else if(request.method==="POST" && (!caseMatch[1]||caseMatch[2])) {
          if(url.search)throw new PortalError("case_input_invalid");
          const input=await body(request,options.maxBodyBytes??DEFAULT_MAX_BODY_BYTES),key=idempotency(request);
          data=!caseMatch[1]?service.create(ctx,input,key):caseMatch[2]==="update"?service.update(ctx,caseMatch[1],input,key):service.reply(ctx,caseMatch[1],input,key);
        } else {json(response,405,{schema_version:CASE_VERSION,status:"blocked",data:null,reason_codes:["method_not_allowed"]});return true;}
        json(response,200,caseResponseSchema.parse({schema_version:CASE_VERSION,status:"success",data,reason_codes:[]}),undefined,true);return true;
      }
      if (path === `${API_PREFIX}/calls` && request.method === "GET") {
        if (!options.callLogService) throw new PortalError("call_log_unavailable");
        const entries=[...url.searchParams.entries()];
        if(new Set(entries.map(([key])=>key)).size!==entries.length) throw new PortalError("call_query_invalid");
        json(response,200,await options.callLogService.query(ctx,Object.fromEntries(entries)),undefined,true);return true;
      }
      if (path === `${API_PREFIX}/state` && request.method === "GET") { json(response, 200, options.service.getState(ctx)); return true; }
      if (path === `${API_PREFIX}/my-organizations` && request.method === "GET") {
        const state = options.service.getState({ ...ctx, organizationId: null });
        json(response, 200, { ...state, data: state.data ? { organizations: state.data.organizations, memberships: state.data.memberships, invitations: state.data.invitations } : null }); return true;
      }
      if (/^\/console\/api\/v1\/business\/customs\/history\/(?:list|get)$/u.test(path) && request.method === "POST") {
        if(!options.businessService?.customsHistory)throw new PortalError("customs_history_source_unconfigured");
        const payload=await body(request,options.maxBodyBytes??32768);closed(payload,["input"]);
        json(response,200,await options.businessService.customsHistory(ctx,path.endsWith("/list")?"list":"get",payload.input,id),undefined,true);return true;
      }
      if (path === `${API_PREFIX}/business/services` && request.method === "GET") {
        if (!options.businessService) throw new PortalError("business_connection_unconfigured");
        json(response, 200, options.businessService.describe(ctx), undefined, true); return true;
      }
      if (path === `${API_PREFIX}/review-queue` && request.method === "GET") { json(response, 200, options.service.getReviewQueue(ctx)); return true; }
      if (path === `${API_PREFIX}/provisioning-queue` && request.method === "GET") { json(response, 200, options.service.getProvisioningQueue(ctx)); return true; }
      if (path === `${API_PREFIX}/platform-state` && request.method === "GET") { json(response, 200, options.service.getPlatformState(ctx)); return true; }
      if (path === `${API_PREFIX}/organizations` && request.method === "GET") {
        if (!options.organizationBridge) throw new PortalError("organization_bridge_unavailable");
        json(response, 200, await options.organizationBridge.listOrganizationAdmissions(ctx)); return true;
      }
      const organizationMatch = /^\/console\/api\/v1\/organizations\/([^/]+)$/u.exec(path);
      if (organizationMatch && request.method === "GET") {
        if (!options.organizationBridge) throw new PortalError("organization_bridge_unavailable");
        json(response, 200, await options.organizationBridge.getOrganizationAdmission(ctx, decodeURIComponent(organizationMatch[1]!))); return true;
      }
      if (path === `${API_PREFIX}/session/organization` && request.method === "POST") { idempotency(request); const input = await body(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES); closed(input, ["organization_id"]); const state = options.service.getState({ ...ctx, organizationId: null }); const selected = options.sessions.selectOrganization(current.sessionId, text(input, "organization_id"), stateMemberships(state)); json(response, 200, sessionBody(options, selected), options.sessions.cookieFor(selected)); return true; }
      const input = write ? await body(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES) : {};
      if (path.startsWith(`${API_PREFIX}/business-access/`)) {
        if (!options.businessAccessService) throw new PortalError("business_access_unavailable");
        try {
          const result = await handleBusinessAccessRequest({ context: ctx, path, method: request.method ?? "GET", input, ...(write ? { idempotencyKey: idempotency(request) } : {}), service: options.businessAccessService });
          json(response, 200, result); return true;
        } catch (error) { if (error instanceof BusinessAccessError) throw new PortalError(error.code); throw error; }
      }
      if (path === `${API_PREFIX}/business/quote/review-queue` && request.method === "GET") {
        if (!options.businessService?.records) throw new PortalError("business_connection_unconfigured");
        json(response, 200, await options.businessService.records(ctx, "reviewQueue", {}, id), undefined, true); return true;
      }
      const reviewActionMatch = /^\/console\/api\/v1\/business\/quote\/review-tasks\/([^/]+)\/(resolution-preview|resolve)$/u.exec(path);
      if (reviewActionMatch && (request.method === "GET" && reviewActionMatch[2] === "resolution-preview" || request.method === "POST" && reviewActionMatch[2] === "resolve")) {
        if (!options.businessService?.records) throw new PortalError("business_connection_unconfigured");
        const taskRef = decodeURIComponent(reviewActionMatch[1]!);
        const action = reviewActionMatch[2] === "resolution-preview" ? "reviewPrepare" : "reviewResolve";
        const value = action === "reviewPrepare" ? { task_ref: taskRef } : { ...input, task_ref: taskRef };
        json(response, 200, await options.businessService.records(ctx, action, value, id, action === "reviewResolve" ? idempotency(request) : undefined), undefined, true); return true;
      }
      const documentCreateMatch = /^\/console\/api\/v1\/business\/quote\/records\/([^/]+)\/documents$/u.exec(path);
      if (documentCreateMatch && request.method === "POST") {
        if (!options.businessService?.records) throw new PortalError("business_connection_unconfigured");
        closed(input, ["document_kind"]);
        json(response, 200, await options.businessService.records(ctx, "documentCreate", { record_ref: decodeURIComponent(documentCreateMatch[1]!), document_kind: input.document_kind }, id, idempotency(request)), undefined, true); return true;
      }
      const documentMatch = /^\/console\/api\/v1\/business\/quote\/documents\/([^/]+)(\/content)?$/u.exec(path);
      if (documentMatch && request.method === "GET") {
        if (!options.businessService?.records) throw new PortalError("business_connection_unconfigured");
        const result = await options.businessService.records(ctx, documentMatch[2] ? "documentDownload" : "documentGet", { document_ref: decodeURIComponent(documentMatch[1]!) }, id);
        if (!documentMatch[2]) { json(response, 200, result, undefined, true); return true; }
        const envelope = result as { status?: unknown; data?: { metadata?: { document_ref?: unknown; media_type?: unknown; content_length?: unknown; content_sha256?: unknown }; bytes?: unknown } | null };
        const metadata = envelope.data?.metadata; const bytes = envelope.data?.bytes;
        if (envelope.status !== "success" && envelope.status !== "manual_review" || !metadata || !(bytes instanceof Uint8Array) || metadata.media_type !== "application/pdf" || metadata.content_length !== bytes.byteLength || typeof metadata.document_ref !== "string" || !/^document_[A-Za-z0-9_-]{12,64}$/u.test(metadata.document_ref) || typeof metadata.content_sha256 !== "string" || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== metadata.content_sha256) {
          json(response, 502, { schema_version: PORTAL_SCHEMA_VERSION, status: "unavailable", data: null, reason_codes: ["quote_document_download_invalid"], request_id: id }, undefined, true); return true;
        }
        response.statusCode = 200; commonHeaders(response); response.setHeader("content-type", "application/pdf"); response.setHeader("content-length", String(bytes.byteLength));
        response.setHeader("content-disposition", `attachment; filename="${metadata.document_ref}.pdf"`); response.setHeader("etag", `"${metadata.content_sha256.slice(7)}"`); response.end(bytes); return true;
      }
      const recordMatch = /^\/console\/api\/v1\/business\/quote\/records\/(prepare|save|get|list|review)$/u.exec(path);
      if (recordMatch && request.method === "POST") {
        if (!options.businessService?.records) throw new PortalError("business_connection_unconfigured");
        closed(input, ["input"]);
        json(response, 200, await options.businessService.records(ctx, recordMatch[1] as "prepare"|"save"|"get"|"list"|"review", input.input, id, idempotency(request)), undefined, true); return true;
      }
      let match: RegExpExecArray | null;
      if (path === `${API_PREFIX}/business/customs/tax-estimates/batch` && request.method === "POST") {
        if (!options.businessService) throw new PortalError("business_connection_unconfigured");
        idempotency(request); closed(input, ["input"]);
        json(response, 200, await options.businessService.executeBatch(ctx, input.input, id), undefined, true); return true;
      }
      const businessOperations: Readonly<Record<string, PortalBusinessOperation>> = { [`${API_PREFIX}/business/customs/query`]: "customs.query", [`${API_PREFIX}/business/customs/tax-estimate`]: "customs.tax.estimate", [`${API_PREFIX}/business/quote/preview`]: "quote.zone_preview", [`${API_PREFIX}/business/quote/extract`]: "quote.ai_extract_preview", [`${API_PREFIX}/business/quote/freightcom-ltl-preview`]: "quote.freightcom_ltl.preview" };
      const operation = businessOperations[path];
      if (operation && request.method === "POST") {
        if (!options.businessService) throw new PortalError("business_connection_unconfigured");
        closed(input, ["input"]); idempotency(request);
        json(response, 200, await options.businessService.execute(ctx, operation, input.input, id), undefined, true); return true;
      }
      if (path === `${API_PREFIX}/organizations` && request.method === "POST") {
        if (!options.organizationBridge) throw new PortalError("organization_bridge_unavailable");
        closed(input, ["display_name", "owner_email", "owner_invitation_expires_at"]);
        json(response, 200, await options.organizationBridge.createOrganization(ctx, mutation(request, { displayName: text(input, "display_name"), ownerEmail: text(input, "owner_email"), ownerInvitationExpiresAt: timestamp(input, "owner_invitation_expires_at") }))); return true;
      }
      if ((match = /^\/console\/api\/v1\/organizations\/([^/]+)\/status$/u.exec(path)) && request.method === "PATCH") {
        if (!options.organizationBridge) throw new PortalError("organization_bridge_unavailable");
        closed(input, ["expected_status", "status", "reason"]);
        json(response, 200, await options.organizationBridge.setOrganizationStatus(ctx, decodeURIComponent(match[1]!), mutation(request, { expectedStatus: choice(input, "expected_status", ["active", "suspended"] as const), status: choice(input, "status", ["active", "suspended"] as const), reason: text(input, "reason") }))); return true;
      }
      if (path === `${API_PREFIX}/invitations` && request.method === "POST") { closed(input,["email","role","expires_at"]); json(response,200,options.service.inviteMember(ctx,mutation(request,{email:text(input,"email"),role:choice(input,"role",["owner","admin","developer","viewer"] as const),expiresAt:timestamp(input,"expires_at")}))); return true; }
      if ((match=/^\/console\/api\/v1\/invitations\/([^/]+)\/(accept|revoke)$/u.exec(path)) && request.method === "POST") { closed(input,[]); const result=match[2]==="accept"?options.service.claimInvitation(ctx,decodeURIComponent(match[1]!),idempotency(request)):options.service.revokeInvitation(ctx,decodeURIComponent(match[1]!),idempotency(request)); json(response,200,result); return true; }
      if ((match=/^\/console\/api\/v1\/memberships\/([^/]+)\/status$/u.exec(path)) && request.method === "PATCH") { closed(input,[],["role","status"]); if(input.role===undefined&&input.status===undefined)throw new PortalError("body_invalid"); json(response,200,options.service.changeMembership(ctx,decodeURIComponent(match[1]!),mutation(request,{...(input.role!==undefined?{role:choice(input,"role",["owner","admin","developer","viewer"] as const)}:{}),...(input.status!==undefined?{status:choice(input,"status",["active","suspended"] as const)}:{})}))); return true; }
      if (path === `${API_PREFIX}/applications` && request.method === "POST") { if(!options.bridge?.createApplication)throw new PortalError("credential_bridge_unavailable"); closed(input,["name","purpose","environment"],["owner_user_id"]); const m=mutation(request,{name:text(input,"name"),purpose:text(input,"purpose"),environment:choice(input,"environment",["test","production"] as const),ownerUserId:input.owner_user_id===undefined?ctx.identity.userId:text(input,"owner_user_id")}); json(response,200,await options.bridge.createApplication(ctx,m)); return true; }
      if ((match=/^\/console\/api\/v1\/applications\/([^/]+)$/u.exec(path)) && request.method === "PATCH") { closed(input,["expected_version"], ["owner_user_id","status"]); if(input.owner_user_id===undefined&&input.status===undefined)throw new PortalError("body_invalid"); const expected=integer(input,"expected_version"); json(response,200,options.service.changeApplication(ctx,decodeURIComponent(match[1]!),mutation(request,{...(input.owner_user_id!==undefined?{ownerUserId:text(input,"owner_user_id")}:{}) ,...(input.status!==undefined?{status:choice(input,"status",["active","suspended"] as const)}:{})},expected))); return true; }
      if (path === `${API_PREFIX}/requests` && request.method === "POST") { closed(input,["application_id","capabilities","justification"]); const key=idempotency(request); json(response,200,options.service.createRequest(ctx,{idempotencyKey:key,input:{requestId:stableResourceId("preq",ctx,key),applicationId:text(input,"application_id"),capabilities:capabilities(input),justification:text(input,"justification")}})); return true; }
      if ((match=/^\/console\/api\/v1\/requests\/([^/]+)$/u.exec(path)) && request.method === "PATCH") { closed(input,["expected_version","capabilities","justification"]); json(response,200,options.service.updateRequest(ctx,decodeURIComponent(match[1]!),mutation(request,{capabilities:capabilities(input),justification:text(input,"justification")},integer(input,"expected_version")))); return true; }
      if ((match=/^\/console\/api\/v1\/requests\/([^/]+)\/(submit|withdraw|review)$/u.exec(path)) && request.method === "POST") { closed(input,["expected_version"]); const requestRef=decodeURIComponent(match[1]!); const version=integer(input,"expected_version"); const key=idempotency(request); const result=match[2]==="submit"?options.service.submitRequest(ctx,requestRef,version,key):match[2]==="withdraw"?options.service.withdrawRequest(ctx,requestRef,version,key):options.service.markRequestInReview(ctx,requestRef,version,key); json(response,200,result); return true; }
      if ((match=/^\/console\/api\/v1\/requests\/([^/]+)\/decision$/u.exec(path)) && request.method === "POST") { closed(input,["expected_version","decision","reason"],["approved_capabilities"]); const decision=choice(input,"decision",["approve","reject","needs_input"] as const); if(input.approved_capabilities!==undefined&&decision!=="approve")throw new PortalError("body_invalid"); json(response,200,options.service.decideRequest(ctx,decodeURIComponent(match[1]!),mutation(request,{decision,reason:text(input,"reason"),...(input.approved_capabilities===undefined?{}:{approvedCapabilities:capabilities(input,"approved_capabilities")})},integer(input,"expected_version")))); return true; }
      if ((match=/^\/console\/api\/v1\/grants\/([^/]+)\/status$/u.exec(path)) && request.method === "POST") { closed(input,["expected_version","state"]); json(response,200,options.service.changeGrantState(ctx,decodeURIComponent(match[1]!),mutation(request,{state:choice(input,"state",["suspended","revoked"] as const)},integer(input,"expected_version")))); return true; }
      if ((match=/^\/console\/api\/v1\/grants\/([^/]+)\/scope$/u.exec(path)) && request.method === "PATCH") { closed(input,["expected_version","capabilities"],["expires_at"]); const expires=input.expires_at; if(expires!==undefined&&expires!==null&&(typeof expires!=="string"||!Number.isFinite(Date.parse(expires))))throw new PortalError("body_invalid"); json(response,200,options.service.changeGrantCapabilities(ctx,decodeURIComponent(match[1]!),mutation(request,{capabilities:capabilities(input),...(expires===undefined?{}:{expiresAt:expires})},integer(input,"expected_version")))); return true; }
      if ((match=/^\/console\/api\/v1\/grants\/([^/]+)\/provision$/u.exec(path)) && request.method === "POST") { if(!options.bridge?.provisionGrant)throw new PortalError("credential_bridge_unavailable"); closed(input,["expected_version"],["expires_at"]); json(response,200,await options.bridge.provisionGrant(ctx,decodeURIComponent(match[1]!),mutation(request,input.expires_at===undefined?{}:{expiresAt:timestamp(input,"expires_at")},integer(input,"expected_version")))); return true; }
      if ((match=/^\/console\/api\/v1\/applications\/([^/]+)\/credentials\/status$/u.exec(path)) && request.method === "GET") { if(!options.bridge?.getCredentialState)throw new PortalError("credential_bridge_unavailable"); json(response,200,await options.bridge.getCredentialState(ctx,decodeURIComponent(match[1]!))); return true; }
      if ((match=/^\/console\/api\/v1\/applications\/([^/]+)\/credentials$/u.exec(path)) && request.method === "POST") { if(!options.bridge?.issueCredential)throw new PortalError("credential_bridge_unavailable"); closed(input,["label","tool_names","expires_in_seconds"]); json(response,200,await options.bridge.issueCredential(ctx,decodeURIComponent(match[1]!),mutation(request,input))); return true; }
      if ((match=/^\/console\/api\/v1\/applications\/([^/]+)\/credentials\/([^/]+)\/(acknowledge|rotate|revoke)$/u.exec(path)) && request.method === "POST") { if(!options.bridge)throw new PortalError("credential_bridge_unavailable"); const app=decodeURIComponent(match[1]!); const credential=decodeURIComponent(match[2]!); const action=match[3]!; if(action==="acknowledge"||action==="revoke")closed(input,[]); const m=mutation(request,input); const result=action==="acknowledge"?options.bridge.acknowledgeCredentialDelivery?.(ctx,app,credential,m as PortalMutation<Record<string,never>>):action==="rotate"?options.bridge.rotateCredential?.(ctx,app,credential,m):options.bridge.revokeCredential?.(ctx,app,credential,m as PortalMutation<Record<string,never>>); if(!result)throw new PortalError("credential_bridge_unavailable"); json(response,200,result); return true; }
      json(response,404,{schema_version:PORTAL_SCHEMA_VERSION,status:"blocked",data:null,reason_codes:["route_not_found"],request_id:id}); return true;
    } catch (error) { const category = boundaryPassed ? browserAuthRecovery(request,path,error) : null; if(category)redirectAuthRecovery(response,category);else sendError(response,id,error); return true; }
  }};
}
