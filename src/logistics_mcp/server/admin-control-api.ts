import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AuthenticationError,
  parseExecutionContext,
  type ExecutionContext,
} from "../platform/context";
import {
  approvalRequestSchema,
  controlEnvelopeSchema,
  deploymentPreviewRequestSchema,
  publishRequestSchema,
  reconcileRequestSchema,
  registerPackageRequestSchema,
  type ApprovalRequest,
  type DeploymentPreviewRequest,
  type PublishRequest,
  type ReconcileRequest,
  type RegisterPackageRequest,
  type ControlEnvelope,
} from "../control-plane/contracts";
import {
  canonicalControlHash,
  type ControlHashPayload,
} from "../control-plane/canonical-control-hash";
import type { CanonicalRequestHash } from "../control-plane/repository";
import type { ModuleControlService, WriteMeta } from "../control-plane/service";
import { IDENTIFIER_PATTERN } from "../control-plane/lexical-contracts";

const CONTROL_SCHEMA_VERSION = "2026-08-22.v1" as const;
const CONTROL_PREFIX = "/admin/api/v1/control";
const STATE_PATH = `${CONTROL_PREFIX}/state`;
const REGISTER_PATH = `${CONTROL_PREFIX}/packages/register`;
const PREVIEW_PATH = `${CONTROL_PREFIX}/deployments/preview`;
const APPROVALS_PATH = `${CONTROL_PREFIX}/approvals`;
const PUBLISH_PATH = `${CONTROL_PREFIX}/deployments/publish`;
const RECONCILE_PATH = `${CONTROL_PREFIX}/deployments/reconcile`;
const PRODUCTION_DISABLED_REASON = "admin_control_production_disabled_v1";

const ROUTES = new Map<string, "GET" | "POST">([
  [STATE_PATH, "GET"],
  [REGISTER_PATH, "POST"],
  [PREVIEW_PATH, "POST"],
  [APPROVALS_PATH, "POST"],
  [PUBLISH_PATH, "POST"],
  [RECONCILE_PATH, "POST"],
]);

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

export interface AdminControlApiHandlerOptions {
  readonly dataMode: "fixtures" | "production";
  readonly service: ModuleControlService;
  /** Fixture-only token verification. Production auth is not implemented here. */
  readonly authenticate: (
    token: string,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly managementTenantId: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly allowLoopbackHttp: boolean;
  readonly maxBodyBytes: number;
  readonly clock: () => string;
}

export interface AdminControlApiHandler {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

interface ServerIds {
  readonly requestId: string;
  readonly traceId: string;
  readonly auditId: string;
}

function serverIds(clock: () => string): ServerIds {
  let clockDigest = "clock";
  try {
    clockDigest = createHash("sha256")
      .update(clock(), "utf8")
      .digest("hex")
      .slice(0, 16);
  } catch {
    // Keep the error surface fixed; a UUID still gives each response a server id.
  }
  const suffix = randomUUID().replaceAll("-", "");
  return {
    requestId: `req-${clockDigest}-${suffix}`,
    traceId: `trace-${clockDigest}-${suffix}`,
    auditId: `audit-${clockDigest}-${suffix}`,
  };
}

function envelope(
  ids: ServerIds,
  status: ControlEnvelope["status"],
  reasonCode: string,
): ControlEnvelope {
  return {
    schema_version: CONTROL_SCHEMA_VERSION,
    request_id: ids.requestId,
    trace_id: ids.traceId,
    audit_id: ids.auditId,
    status,
    data: null,
    reason_codes: [reasonCode],
    readback: {
      status: "not_applicable",
      release_id: null,
      revision: null,
    },
  };
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
  status: number,
  body: unknown,
  options: { readonly allow?: string; readonly authenticate?: boolean } = {},
): void {
  const serialized = JSON.stringify(body);
  setSecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(Buffer.byteLength(serialized)));
  if (options.allow !== undefined) response.setHeader("allow", options.allow);
  if (options.authenticate === true) {
    response.setHeader("www-authenticate", "Bearer");
  }
  if (request.method !== "GET" && request.method !== "HEAD") request.resume();
  response.end(request.method === "HEAD" ? undefined : serialized);
}

function pathOf(request: IncomingMessage): string {
  return (request.url ?? "/").split("?", 1)[0] ?? "/";
}

function rawHeaderValues(
  request: IncomingMessage,
  name: string,
): readonly string[] | null {
  const rawHeaders = request.rawHeaders;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return null;
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const headerName = rawHeaders[index];
    const headerValue = rawHeaders[index + 1];
    if (typeof headerName !== "string" || typeof headerValue !== "string") {
      return null;
    }
    if (headerName.toLowerCase() === name.toLowerCase()) values.push(headerValue);
  }
  return values;
}

function isLoopbackAddress(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1"
  );
}

function hasAuthQuery(request: IncomingMessage): boolean {
  const query = request.url?.split("?", 2)[1];
  if (query === undefined) return false;
  try {
    for (const key of new URLSearchParams(query).keys()) {
      if (AUTH_QUERY_KEYS.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isAllowedBoundary(
  request: IncomingMessage,
  options: AdminControlApiHandlerOptions,
  method: string,
): string | null {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    return "admin_loopback_required";
  }
  if (
    !options.allowLoopbackHttp &&
    (request.socket as { readonly encrypted?: boolean }).encrypted !== true
  ) {
    return "admin_https_required";
  }

  const hostValues = rawHeaderValues(request, "host");
  if (hostValues === null) return "admin_request_headers_invalid";
  if (hostValues.length !== 1 || !options.allowedHosts.includes(hostValues[0] ?? "")) {
    return "admin_host_not_allowed";
  }

  const originValues = rawHeaderValues(request, "origin");
  if (originValues === null) return "admin_request_headers_invalid";
  if (originValues.length > 1) return "admin_request_headers_invalid";
  const origin = originValues[0];
  if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
    return "admin_origin_not_allowed";
  }
  if (method === "POST" && origin === undefined) {
    return "admin_origin_required";
  }
  return null;
}

function bearerToken(request: IncomingMessage): string | null {
  if (hasAuthQuery(request)) return null;
  const cookie = rawHeaderValues(request, "cookie");
  if (cookie === null || (cookie !== null && cookie.length > 0)) return null;
  const authorization = rawHeaderValues(request, "authorization");
  if (authorization === null || authorization.length !== 1) return null;
  const value = authorization[0]?.trim() ?? "";
  const match = /^Bearer\s+([^\s]+)$/u.exec(value);
  return match?.[1] ?? null;
}

async function authenticateContext(
  request: IncomingMessage,
  options: AdminControlApiHandlerOptions,
): Promise<{ readonly context: ExecutionContext } | { readonly reason: string }> {
  const token = bearerToken(request);
  if (token === null) return { reason: "authentication_failed" };
  try {
    const claims = await options.authenticate(token);
    return { context: parseExecutionContext(claims) };
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return { reason: "authentication_failed" };
    return { reason: "authentication_failed" };
  }
}

function adminAuthorizationFailure(
  context: ExecutionContext,
  managementTenantId: string,
): string | null {
  if (context.role !== "admin") return "admin_role_required";
  if (!context.roles.includes("admin")) return "admin_role_missing";
  if (!context.scopes.includes("platform:admin")) {
    return "platform_admin_scope_required";
  }
  if (context.tenantId !== managementTenantId) return "management_tenant_mismatch";
  return null;
}

type SupportedPostPath =
  | typeof REGISTER_PATH
  | typeof PREVIEW_PATH
  | typeof APPROVALS_PATH
  | typeof PUBLISH_PATH
  | typeof RECONCILE_PATH;

function isSupportedPostPath(path: string): path is SupportedPostPath {
  return (
    path === REGISTER_PATH ||
    path === PREVIEW_PATH ||
    path === APPROVALS_PATH ||
    path === PUBLISH_PATH ||
    path === RECONCILE_PATH
  );
}

type BodyLengthResult =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly value: number }
  | { readonly kind: "invalid" }
  | { readonly kind: "too_large" };

function declaredBodyLength(
  request: IncomingMessage,
  maxBodyBytes: number,
): BodyLengthResult {
  const values = rawHeaderValues(request, "content-length");
  if (values === null || values.length > 1) return { kind: "invalid" };
  const raw = values[0];
  if (raw === undefined) return { kind: "absent" };
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) return { kind: "invalid" };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { kind: "invalid" };
  if (value > maxBodyBytes) return { kind: "too_large" };
  return { kind: "present", value };
}

type BodyReadResult =
  | { readonly kind: "ok"; readonly body: Buffer }
  | { readonly kind: "too_large" }
  | { readonly kind: "invalid" };

async function readRequestBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<BodyReadResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBodyBytes) return { kind: "too_large" };
      chunks.push(bytes);
    }
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "ok", body: Buffer.concat(chunks, size) };
}

function jsonContentType(request: IncomingMessage): boolean {
  const values = rawHeaderValues(request, "content-type");
  if (values === null || values.length !== 1) return false;
  const value = values[0];
  if (value === undefined) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

type ParsedPostRequest =
  | { readonly path: typeof REGISTER_PATH; readonly request: RegisterPackageRequest }
  | { readonly path: typeof PREVIEW_PATH; readonly request: DeploymentPreviewRequest }
  | { readonly path: typeof APPROVALS_PATH; readonly request: ApprovalRequest }
  | { readonly path: typeof PUBLISH_PATH; readonly request: PublishRequest }
  | { readonly path: typeof RECONCILE_PATH; readonly request: ReconcileRequest };

function parsePostRequest(
  path: SupportedPostPath,
  value: unknown,
): ParsedPostRequest | null {
  if (path === REGISTER_PATH) {
    const parsed = registerPackageRequestSchema.safeParse(value);
    return parsed.success ? { path, request: parsed.data } : null;
  }
  if (path === PREVIEW_PATH) {
    const parsed = deploymentPreviewRequestSchema.safeParse(value);
    return parsed.success ? { path, request: parsed.data } : null;
  }
  if (path === APPROVALS_PATH) {
    const parsed = approvalRequestSchema.safeParse(value);
    return parsed.success ? { path, request: parsed.data } : null;
  }
  if (path === PUBLISH_PATH) {
    const parsed = publishRequestSchema.safeParse(value);
    return parsed.success ? { path, request: parsed.data } : null;
  }
  const parsed = reconcileRequestSchema.safeParse(value);
  return parsed.success ? { path, request: parsed.data } : null;
}

function requestHashFor(
  parsed: ParsedPostRequest,
  context: ExecutionContext,
  managementTenantId: string,
): CanonicalRequestHash {
  let payload: ControlHashPayload;
  if (parsed.path === REGISTER_PATH) {
    const registerRequest = parsed.request;
    payload = {
      action: "packages.register",
      management_tenant_id: managementTenantId,
      actor_ref: context.actorId,
      request: {
        schema_version: registerRequest.schema_version,
        module_id: registerRequest.module_id,
        version: registerRequest.version,
        descriptor_digest: registerRequest.descriptor_digest as `sha256:${string}`,
      },
    };
  } else if (parsed.path === PREVIEW_PATH) {
    const previewRequest = parsed.request;
    payload = previewRequest.intent === "change"
      ? {
          action: "deployments.preview",
          management_tenant_id: managementTenantId,
          actor_ref: context.actorId,
          request: {
            schema_version: previewRequest.schema_version,
            intent: "change",
            desired_modules: previewRequest.desired_modules.map((module) => ({
              module_id: module.module_id,
              version: module.version,
              descriptor_digest: module.descriptor_digest as `sha256:${string}`,
            })),
          },
        }
      : {
          action: "deployments.preview",
          management_tenant_id: managementTenantId,
          actor_ref: context.actorId,
          request: {
            schema_version: previewRequest.schema_version,
            intent: "rollback",
            target_release_id: previewRequest.target_release_id,
          },
        };
  } else if (parsed.path === APPROVALS_PATH) {
    const approvalRequest = parsed.request;
    payload = {
      action: "approvals.decide",
      management_tenant_id: managementTenantId,
      actor_ref: context.actorId,
      request: {
        schema_version: approvalRequest.schema_version,
        preview_ref: approvalRequest.preview_ref,
        decision: approvalRequest.decision,
        reason_code: approvalRequest.reason_code,
      },
    };
  } else if (parsed.path === PUBLISH_PATH) {
    const publishRequest = parsed.request;
    payload = {
      action: "deployments.publish",
      management_tenant_id: managementTenantId,
      actor_ref: context.actorId,
      request: {
        schema_version: publishRequest.schema_version,
        preview_ref: publishRequest.preview_ref,
        approval_id: publishRequest.approval_id,
      },
    };
  } else {
    const reconcileRequest = parsed.request;
    payload = {
      action: "deployments.reconcile",
      management_tenant_id: managementTenantId,
      actor_ref: context.actorId,
      request: {
        schema_version: reconcileRequest.schema_version,
        release_id: reconcileRequest.release_id,
      },
    };
  }
  return canonicalControlHash({
    domain: "request",
    schemaVersion: parsed.request.schema_version,
    payload,
  }).hash as CanonicalRequestHash;
}

function statusCodeForPost(
  path: SupportedPostPath,
  status: ControlEnvelope["status"],
): number {
  if (status === "success") {
    return path === REGISTER_PATH || path === PUBLISH_PATH ? 201 : 200;
  }
  if (status === "needs_input") return 400;
  if (status === "manual_review") return 409;
  if (status === "blocked") return 403;
  return 503;
}

async function handleSupportedPost(
  request: IncomingMessage,
  response: ServerResponse,
  ids: ServerIds,
  path: SupportedPostPath,
  options: AdminControlApiHandlerOptions,
): Promise<void> {
  if (!jsonContentType(request)) {
    sendJson(request, response, 400, envelope(ids, "blocked", "content_type_invalid"));
    return;
  }

  const declared = declaredBodyLength(request, options.maxBodyBytes);
  if (declared.kind === "invalid") {
    sendJson(request, response, 400, envelope(ids, "blocked", "content_length_invalid"));
    return;
  }
  if (declared.kind === "too_large") {
    sendJson(request, response, 413, envelope(ids, "blocked", "body_too_large"));
    return;
  }

  const bodyResult = await readRequestBody(request, options.maxBodyBytes);
  if (bodyResult.kind === "too_large") {
    sendJson(request, response, 413, envelope(ids, "blocked", "body_too_large"));
    return;
  }
  if (bodyResult.kind === "invalid") {
    sendJson(request, response, 400, envelope(ids, "blocked", "body_read_invalid"));
    return;
  }
  if (declared.kind === "present" && declared.value !== bodyResult.body.byteLength) {
    sendJson(request, response, 400, envelope(ids, "blocked", "content_length_mismatch"));
    return;
  }

  const authenticated = await authenticateContext(request, options);
  if ("reason" in authenticated) {
    sendJson(request, response, 401, envelope(ids, "blocked", authenticated.reason), {
      authenticate: true,
    });
    return;
  }
  const authorizationFailure = adminAuthorizationFailure(
    authenticated.context,
    options.managementTenantId,
  );
  if (authorizationFailure !== null) {
    sendJson(request, response, 403, envelope(ids, "blocked", authorizationFailure));
    return;
  }

  const idempotencyValues = rawHeaderValues(request, "idempotency-key");
  if (idempotencyValues === null || idempotencyValues.length !== 1) {
    sendJson(request, response, 400, envelope(ids, "blocked", "idempotency_key_required"));
    return;
  }
  const idempotencyKey = idempotencyValues[0]?.trim();
  if (
    idempotencyKey === undefined ||
    idempotencyKey.length < 16 ||
    idempotencyKey.length > 200 ||
    !IDENTIFIER_PATTERN.test(idempotencyKey)
  ) {
    sendJson(request, response, 400, envelope(ids, "blocked", "idempotency_key_invalid"));
    return;
  }

  let jsonBody: unknown;
  try {
    jsonBody = JSON.parse(bodyResult.body.toString("utf8")) as unknown;
  } catch {
    sendJson(request, response, 400, envelope(ids, "blocked", "invalid_json"));
    return;
  }
  const parsed = parsePostRequest(path, jsonBody);
  if (parsed === null) {
    sendJson(request, response, 400, envelope(ids, "blocked", "request_schema_invalid"));
    return;
  }

  let requestHash: CanonicalRequestHash;
  try {
    requestHash = requestHashFor(
      parsed,
      authenticated.context,
      options.managementTenantId,
    );
  } catch {
    sendJson(request, response, 503, envelope(ids, "unavailable", "request_hash_unavailable"));
    return;
  }
  const meta: WriteMeta = {
    idempotencyKey,
    requestHash,
    requestId: ids.requestId,
    traceId: ids.traceId,
    auditId: ids.auditId,
  };

  let result: unknown;
  try {
    switch (parsed.path) {
      case REGISTER_PATH:
        result = await options.service.registerPackage(
          authenticated.context,
          parsed.request,
          meta,
        );
        break;
      case PREVIEW_PATH:
        result = await options.service.createDeploymentPreview(
          authenticated.context,
          parsed.request,
          meta,
        );
        break;
      case APPROVALS_PATH:
        result = await options.service.decideApproval(
          authenticated.context,
          parsed.request,
          meta,
        );
        break;
      case PUBLISH_PATH:
        result = await options.service.publish(
          authenticated.context,
          parsed.request,
          meta,
        );
        break;
      case RECONCILE_PATH:
        result = await options.service.reconcile(
          authenticated.context,
          parsed.request,
          meta,
        );
        break;
    }
  } catch {
    sendJson(request, response, 503, envelope(ids, "unavailable", "admin_control_unavailable"));
    return;
  }

  const output = controlEnvelopeSchema.safeParse(result);
  if (!output.success) {
    sendJson(request, response, 503, envelope(ids, "unavailable", "control_envelope_invalid"));
    return;
  }
  sendJson(request, response, statusCodeForPost(path, output.data.status), output.data);
}

export function createAdminControlApiHandler(
  options: AdminControlApiHandlerOptions,
): AdminControlApiHandler {
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0) {
    throw new TypeError("maxBodyBytes must be a positive safe integer.");
  }

  return {
    handle(request, response): boolean {
      const path = pathOf(request);
      if (!path.startsWith(CONTROL_PREFIX)) return false;

      const ids = serverIds(options.clock);
      const boundaryFailure = isAllowedBoundary(request, options, request.method ?? "GET");
      if (boundaryFailure !== null) {
        sendJson(request, response, 403, envelope(ids, "blocked", boundaryFailure));
        return true;
      }

      const expectedMethod = ROUTES.get(path);
      if (expectedMethod === undefined) {
        sendJson(request, response, 404, envelope(ids, "blocked", "admin_route_not_found"));
        return true;
      }
      if (request.method !== expectedMethod) {
        sendJson(request, response, 405, envelope(ids, "blocked", "method_not_allowed"), {
          allow: expectedMethod,
        });
        return true;
      }

      if (expectedMethod === "POST" && options.dataMode === "production") {
        sendJson(
          request,
          response,
          403,
          envelope(ids, "blocked", PRODUCTION_DISABLED_REASON),
        );
        return true;
      }

      if (isSupportedPostPath(path)) {
        void handleSupportedPost(request, response, ids, path, options).catch(() => {
          if (!response.destroyed) {
            sendJson(request, response, 503, envelope(ids, "unavailable", "admin_control_unavailable"));
          }
        });
        return true;
      }

      if (path !== STATE_PATH) {
        sendJson(request, response, 404, envelope(ids, "blocked", "admin_route_not_found"));
        return true;
      }

      void authenticateContext(request, options)
        .then((authenticated) => {
          if ("reason" in authenticated) {
            sendJson(request, response, 401, envelope(ids, "blocked", authenticated.reason), {
              authenticate: true,
            });
            return;
          }
          const authorizationFailure = adminAuthorizationFailure(
            authenticated.context,
            options.managementTenantId,
          );
          if (authorizationFailure !== null) {
            sendJson(request, response, 403, envelope(ids, "blocked", authorizationFailure));
            return;
          }

          return options.service
            .getState(authenticated.context)
            .then((result) => {
              const parsed = controlEnvelopeSchema.safeParse(result);
              if (!parsed.success) {
                sendJson(request, response, 503, envelope(ids, "unavailable", "control_envelope_invalid"));
                return;
              }
              sendJson(request, response, 200, parsed.data);
            });
        })
        .catch(() => {
          if (!response.destroyed) {
            sendJson(request, response, 503, envelope(ids, "unavailable", "admin_control_unavailable"));
          }
        });
      return true;
    },
  };
}
