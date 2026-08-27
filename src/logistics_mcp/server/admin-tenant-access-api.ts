import type { IncomingMessage, ServerResponse } from "node:http";

import {
  acknowledgeCredentialDeliveryRequestSchema,
  createTenantRequestSchema,
  issueCredentialRequestSchema,
  revokeCredentialRequestSchema,
  rotateCredentialRequestSchema,
  setTenantStatusRequestSchema,
  TENANT_ACCESS_SCHEMA_VERSION,
} from "../control-plane/tenant-access-contracts";
import { IDENTIFIER_PATTERN } from "../control-plane/lexical-contracts";
import { TenantAccessError } from "../control-plane/tenant-access-errors";
import {
  AuthenticationError,
  parseExecutionContext,
  type ExecutionContext,
} from "../platform/context";

const ACCESS_PREFIX = "/admin/api/v1/access";
const STATE_PATH = `${ACCESS_PREFIX}/state`;
const TENANTS_PATH = `${ACCESS_PREFIX}/tenants`;
const CREDENTIALS_PATH = `${ACCESS_PREFIX}/credentials`;
const PRODUCTION_DISABLED_REASON = "tenant_access_production_disabled_v1";
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const PERMISSIONS_POLICY = "camera=(), geolocation=(), microphone=(), payment=(), usb=()";
const AUTH_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "key",
  "token",
]);

export interface TenantAccessAdminService {
  getState(context: ExecutionContext): Promise<unknown>;
  createTenant(context: ExecutionContext, input: unknown, idempotencyKey: string): Promise<unknown>;
  setTenantStatus(
    context: ExecutionContext,
    tenantId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<unknown>;
  issueCredential(context: ExecutionContext, input: unknown, idempotencyKey: string): Promise<unknown>;
  rotateCredential(
    context: ExecutionContext,
    credentialId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<unknown>;
  revokeCredential(
    context: ExecutionContext,
    credentialId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<unknown>;
  acknowledgeCredentialDelivery(
    context: ExecutionContext,
    credentialId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<unknown>;
}

export interface AdminTenantAccessApiHandlerOptions {
  readonly dataMode: "fixtures" | "production";
  readonly service: TenantAccessAdminService;
  readonly authenticate: (
    token: string,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly managementTenantId: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly allowLoopbackHttp: boolean;
  readonly maxBodyBytes: number;
}

export interface AdminTenantAccessApiHandler {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

type Route =
  | { readonly kind: "state"; readonly method: "GET" }
  | { readonly kind: "create_tenant"; readonly method: "POST" }
  | { readonly kind: "set_tenant_status"; readonly method: "POST"; readonly targetId: string }
  | { readonly kind: "issue_credential"; readonly method: "POST" }
  | { readonly kind: "rotate_credential"; readonly method: "POST"; readonly targetId: string }
  | { readonly kind: "revoke_credential"; readonly method: "POST"; readonly targetId: string }
  | { readonly kind: "acknowledge_credential_delivery"; readonly method: "POST"; readonly targetId: string };

type AccessStatus = "success" | "needs_input" | "manual_review" | "blocked" | "unavailable";

function errorEnvelope(status: AccessStatus, reasonCode: string): Readonly<{
  schema_version: typeof TENANT_ACCESS_SCHEMA_VERSION;
  status: AccessStatus;
  data: null;
  reason_codes: readonly [string];
}> {
  return Object.freeze({
    schema_version: TENANT_ACCESS_SCHEMA_VERSION,
    status,
    data: null,
    reason_codes: Object.freeze([reasonCode] as const),
  });
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("permissions-policy", PERMISSIONS_POLICY);
  response.setHeader("cache-control", "no-store");
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  options: { readonly allow?: string; readonly authenticate?: boolean } = {},
): void {
  const serialized = JSON.stringify(body);
  setSecurityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(Buffer.byteLength(serialized)));
  if (options.allow !== undefined) response.setHeader("allow", options.allow);
  if (options.authenticate === true) response.setHeader("www-authenticate", "Bearer");
  if (request.method !== "GET" && request.method !== "HEAD") request.resume();
  response.end(request.method === "HEAD" ? undefined : serialized);
}

function pathOf(request: IncomingMessage): string {
  return (request.url ?? "/").split("?", 1)[0] ?? "/";
}

function rawHeaderValues(request: IncomingMessage, name: string): readonly string[] | null {
  if (!Array.isArray(request.rawHeaders) || request.rawHeaders.length % 2 !== 0) return null;
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const headerName = request.rawHeaders[index];
    const headerValue = request.rawHeaders[index + 1];
    if (typeof headerName !== "string" || typeof headerValue !== "string") return null;
    if (headerName.toLowerCase() === name.toLowerCase()) values.push(headerValue);
  }
  return values;
}

function isLoopback(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function boundaryFailure(
  request: IncomingMessage,
  options: AdminTenantAccessApiHandlerOptions,
  method: string,
): string | null {
  if (!isLoopback(request.socket.remoteAddress)) return "admin_loopback_required";
  if (
    !options.allowLoopbackHttp &&
    (request.socket as { readonly encrypted?: boolean }).encrypted !== true
  ) {
    return "admin_https_required";
  }
  const hosts = rawHeaderValues(request, "host");
  if (hosts === null) return "admin_request_headers_invalid";
  if (hosts.length !== 1 || !options.allowedHosts.includes(hosts[0] ?? "")) {
    return "admin_host_not_allowed";
  }
  const origins = rawHeaderValues(request, "origin");
  if (origins === null || origins.length > 1) return "admin_request_headers_invalid";
  const origin = origins[0];
  if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
    return "admin_origin_not_allowed";
  }
  if (method === "POST" && origin === undefined) return "admin_origin_required";
  return null;
}

function hasAuthQuery(request: IncomingMessage): boolean {
  const query = request.url?.split("?", 2)[1];
  if (query === undefined) return false;
  try {
    return [...new URLSearchParams(query).keys()]
      .some((key) => AUTH_QUERY_KEYS.has(key.toLowerCase()));
  } catch {
    return true;
  }
}

function bearerToken(request: IncomingMessage): string | null {
  if (hasAuthQuery(request)) return null;
  const cookies = rawHeaderValues(request, "cookie");
  if (cookies === null || cookies.length !== 0) return null;
  const authorization = rawHeaderValues(request, "authorization");
  if (authorization === null || authorization.length !== 1) return null;
  return /^Bearer\s+([^\s]+)$/u.exec(authorization[0]?.trim() ?? "")?.[1] ?? null;
}

async function authenticateContext(
  request: IncomingMessage,
  options: AdminTenantAccessApiHandlerOptions,
): Promise<ExecutionContext | null> {
  const token = bearerToken(request);
  if (token === null) return null;
  try {
    return parseExecutionContext(await options.authenticate(token));
  } catch (error) {
    if (error instanceof AuthenticationError) return null;
    return null;
  }
}

function authorizationFailure(
  context: ExecutionContext,
  managementTenantId: string,
): string | null {
  if (context.role !== "admin") return "admin_role_required";
  if (!context.roles.includes("admin")) return "admin_role_missing";
  if (!context.scopes.includes("platform:admin")) return "platform_admin_scope_required";
  if (!context.scopes.includes("tenant:admin")) return "tenant_admin_scope_required";
  if (context.tenantId !== managementTenantId) return "management_tenant_mismatch";
  return null;
}

function decodedIdentifier(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return IDENTIFIER_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function resolveRoute(path: string): Route | null {
  if (path === STATE_PATH) return { kind: "state", method: "GET" };
  if (path === TENANTS_PATH) return { kind: "create_tenant", method: "POST" };
  if (path === CREDENTIALS_PATH) return { kind: "issue_credential", method: "POST" };
  const tenantStatus = new RegExp(`^${ACCESS_PREFIX}/tenants/([^/]+)/status$`, "u").exec(path);
  if (tenantStatus !== null) {
    const targetId = decodedIdentifier(tenantStatus[1] ?? "");
    return targetId === null ? null : { kind: "set_tenant_status", method: "POST", targetId };
  }
  const credentialAction = new RegExp(
    `^${ACCESS_PREFIX}/credentials/([^/]+)/(rotate|revoke|acknowledge-delivery)$`,
    "u",
  ).exec(path);
  if (credentialAction !== null) {
    const targetId = decodedIdentifier(credentialAction[1] ?? "");
    if (targetId === null) return null;
    if (credentialAction[2] === "rotate") {
      return { kind: "rotate_credential", method: "POST", targetId };
    }
    return credentialAction[2] === "revoke"
      ? { kind: "revoke_credential", method: "POST", targetId }
      : { kind: "acknowledge_credential_delivery", method: "POST", targetId };
  }
  return null;
}

function jsonContentType(request: IncomingMessage): boolean {
  const values = rawHeaderValues(request, "content-type");
  if (values === null || values.length !== 1) return false;
  return values[0]?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function idempotencyKey(request: IncomingMessage): string | null {
  const values = rawHeaderValues(request, "idempotency-key");
  if (values === null || values.length !== 1) return null;
  const value = values[0]?.trim() ?? "";
  return value.length >= 16 && value.length <= 200 && IDENTIFIER_PATTERN.test(value)
    ? value
    : null;
}

async function readBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly tooLarge: boolean }> {
  const lengths = rawHeaderValues(request, "content-length");
  if (lengths === null || lengths.length > 1) return { ok: false, tooLarge: false };
  if (lengths.length === 1) {
    const raw = lengths[0] ?? "";
    if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) return { ok: false, tooLarge: false };
    const declared = Number(raw);
    if (!Number.isSafeInteger(declared)) return { ok: false, tooLarge: false };
    if (declared > maxBodyBytes) return { ok: false, tooLarge: true };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request as AsyncIterable<Uint8Array>) {
      const value = Buffer.from(chunk);
      size += value.byteLength;
      if (size > maxBodyBytes) return { ok: false, tooLarge: true };
      chunks.push(value);
    }
    if (lengths.length === 1 && Number(lengths[0]) !== size) {
      return { ok: false, tooLarge: false };
    }
    return { ok: true, value: JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

function parseRouteBody(route: Exclude<Route, { readonly kind: "state" }>, value: unknown): object | null {
  const parsed = route.kind === "create_tenant"
    ? createTenantRequestSchema.safeParse(value)
    : route.kind === "set_tenant_status"
      ? setTenantStatusRequestSchema.safeParse(value)
      : route.kind === "issue_credential"
        ? issueCredentialRequestSchema.safeParse(value)
      : route.kind === "rotate_credential"
          ? rotateCredentialRequestSchema.safeParse(value)
          : route.kind === "revoke_credential"
            ? revokeCredentialRequestSchema.safeParse(value)
            : acknowledgeCredentialDeliveryRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function responseStatus(value: unknown): AccessStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== TENANT_ACCESS_SCHEMA_VERSION) return null;
  const status = record.status;
  return status === "success" || status === "needs_input" || status === "manual_review" ||
    status === "blocked" || status === "unavailable" ? status : null;
}

function httpStatus(status: AccessStatus, route: Route): number {
  if (status === "success") {
    return route.kind === "create_tenant" || route.kind === "issue_credential" ? 201 : 200;
  }
  if (status === "needs_input") return 400;
  if (status === "manual_review") return 409;
  if (status === "blocked") return 403;
  return 503;
}

function serviceError(error: unknown): { readonly http: number; readonly status: AccessStatus; readonly reason: string } {
  if (!(error instanceof TenantAccessError)) {
    return { http: 503, status: "unavailable", reason: "tenant_access_unavailable" };
  }
  switch (error.code) {
    case "invalid_request":
      return { http: 400, status: "needs_input", reason: "request_schema_invalid" };
    case "idempotency_conflict":
    case "tenant_already_exists":
    case "tenant_not_active":
    case "credential_not_active":
    case "credential_delivery_acknowledged":
    case "credential_delivery_pending":
    case "credential_expired":
    case "tenant_status_unchanged":
      return { http: 409, status: "manual_review", reason: error.code };
    case "tenant_not_found":
    case "credential_not_found":
      return { http: 404, status: "blocked", reason: error.code };
    case "scope_not_allowed":
    case "management_tenant_forbidden":
    case "management_tenant_mismatch":
    case "admin_role_required":
    case "platform_admin_scope_required":
    case "tenant_admin_scope_required":
      return { http: 403, status: "blocked", reason: error.code };
    case "authentication_failed":
      return { http: 401, status: "blocked", reason: error.code };
    case "closed":
    case "database_open_failed":
    case "identity_mismatch":
    case "invalid_options":
    case "permission_mismatch":
    case "schema_mismatch":
    case "state_exists":
    case "state_missing":
      return { http: 503, status: "unavailable", reason: "tenant_access_unavailable" };
  }
}

async function dispatch(
  route: Route,
  context: ExecutionContext,
  body: unknown,
  key: string,
  service: TenantAccessAdminService,
): Promise<unknown> {
  switch (route.kind) {
    case "state":
      return service.getState(context);
    case "create_tenant":
      return service.createTenant(context, body, key);
    case "set_tenant_status":
      return service.setTenantStatus(context, route.targetId, body, key);
    case "issue_credential":
      return service.issueCredential(context, body, key);
    case "rotate_credential":
      return service.rotateCredential(context, route.targetId, body, key);
    case "revoke_credential":
      return service.revokeCredential(context, route.targetId, body, key);
    case "acknowledge_credential_delivery":
      return service.acknowledgeCredentialDelivery(context, route.targetId, body, key);
  }
}

async function handleRoute(
  request: IncomingMessage,
  response: ServerResponse,
  route: Route,
  options: AdminTenantAccessApiHandlerOptions,
): Promise<void> {
  let body: unknown = undefined;
  let key = "";
  if (route.method === "POST") {
    if (!jsonContentType(request)) {
      sendJson(request, response, 400, errorEnvelope("needs_input", "content_type_invalid"));
      return;
    }
    const read = await readBody(request, options.maxBodyBytes);
    if (!read.ok) {
      sendJson(
        request,
        response,
        read.tooLarge ? 413 : 400,
        errorEnvelope("blocked", read.tooLarge ? "body_too_large" : "invalid_json"),
      );
      return;
    }
    body = parseRouteBody(route, read.value);
    if (body === null) {
      sendJson(request, response, 400, errorEnvelope("needs_input", "request_schema_invalid"));
      return;
    }
    const headerKey = idempotencyKey(request);
    if (headerKey === null) {
      sendJson(request, response, 400, errorEnvelope("needs_input", "idempotency_key_invalid"));
      return;
    }
    key = headerKey;
  }

  const context = await authenticateContext(request, options);
  if (context === null) {
    sendJson(request, response, 401, errorEnvelope("blocked", "authentication_failed"), {
      authenticate: true,
    });
    return;
  }
  const denied = authorizationFailure(context, options.managementTenantId);
  if (denied !== null) {
    sendJson(request, response, 403, errorEnvelope("blocked", denied));
    return;
  }

  try {
    const result = await dispatch(route, context, body, key, options.service);
    const status = responseStatus(result);
    if (status === null) {
      sendJson(request, response, 503, errorEnvelope("unavailable", "tenant_access_response_invalid"));
      return;
    }
    sendJson(request, response, httpStatus(status, route), result);
  } catch (error) {
    const mapped = serviceError(error);
    sendJson(request, response, mapped.http, errorEnvelope(mapped.status, mapped.reason), {
      authenticate: mapped.http === 401,
    });
  }
}

export function createAdminTenantAccessApiHandler(
  options: AdminTenantAccessApiHandlerOptions,
): AdminTenantAccessApiHandler {
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0) {
    throw new TypeError("maxBodyBytes must be a positive safe integer.");
  }
  return {
    handle(request, response): boolean {
      const path = pathOf(request);
      if (!path.startsWith(ACCESS_PREFIX)) return false;
      const boundary = boundaryFailure(request, options, request.method ?? "GET");
      if (boundary !== null) {
        sendJson(request, response, 403, errorEnvelope("blocked", boundary));
        return true;
      }
      const route = resolveRoute(path);
      if (route === null) {
        sendJson(request, response, 404, errorEnvelope("blocked", "admin_route_not_found"));
        return true;
      }
      if (request.method !== route.method) {
        sendJson(request, response, 405, errorEnvelope("blocked", "method_not_allowed"), {
          allow: route.method,
        });
        return true;
      }
      if (route.method === "POST" && options.dataMode === "production") {
        sendJson(
          request,
          response,
          403,
          errorEnvelope("blocked", PRODUCTION_DISABLED_REASON),
        );
        return true;
      }
      void handleRoute(request, response, route, options).catch(() => {
        if (!response.destroyed) {
          sendJson(
            request,
            response,
            503,
            errorEnvelope("unavailable", "tenant_access_unavailable"),
          );
        }
      });
      return true;
    },
  };
}
