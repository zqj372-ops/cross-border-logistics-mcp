import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

import {
  T0_TOOL_NAMES,
  type AccessState,
  type AccessStatus,
  type AdminPrincipal,
} from "./contracts";

export const ACCESS_OPERATIONS_SCHEMA_VERSION = "2026-08-30.v1" as const;
export const ACCESS_OPERATIONS_PATH = "/admin/api/v1/access/overview" as const;
export const ACCESS_OPERATIONS_WINDOW_SECONDS = 86_400 as const;
const RECENT_ISSUE_LIMIT = 20;
const ACCESS_STATUSES = Object.freeze([
  "success",
  "needs_input",
  "manual_review",
  "blocked",
  "unavailable",
] as const);
const ISSUE_STATUSES = Object.freeze([
  "needs_input",
  "manual_review",
  "blocked",
  "unavailable",
] as const);
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

export interface GatewayRecentIssue {
  readonly auditRef: string;
  readonly action: string;
  readonly status: Exclude<AccessStatus, "success">;
  readonly reasonCode: string | null;
  readonly createdAt: string;
}

export interface GatewayActivitySummary {
  readonly windowStartedAt: string;
  readonly totalAuditEvents: number;
  readonly statusCounts: Readonly<Record<AccessStatus, number>>;
  readonly recentIssues: readonly GatewayRecentIssue[];
}

export interface GatewayOperationsReader {
  summarize(input: Readonly<{
    windowStartedAt: string;
    issueLimit: number;
  }>): Promise<GatewayActivitySummary>;
}

export interface AccessOperationsOverviewInput {
  readonly state: AccessState;
  readonly generatedAt: string;
  readonly activity: GatewayActivitySummary;
}

function countBy<T extends string>(values: readonly T[], expected: readonly T[]): Readonly<Record<T, number>> {
  const counts = Object.fromEntries(expected.map((value) => [value, 0])) as Record<T, number>;
  for (const value of values) {
    if (!expected.includes(value)) throw new TypeError("Access state contains an unknown status.");
    counts[value] += 1;
  }
  return Object.freeze(counts);
}

export function isCanonicalGatewayTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function activityProjection(activity: GatewayActivitySummary, generatedAt: string) {
  if (
    !isCanonicalGatewayTimestamp(generatedAt) ||
    !isCanonicalGatewayTimestamp(activity.windowStartedAt) ||
    Date.parse(generatedAt) - Date.parse(activity.windowStartedAt) !==
      ACCESS_OPERATIONS_WINDOW_SECONDS * 1_000 ||
    !Number.isSafeInteger(activity.totalAuditEvents) ||
    activity.totalAuditEvents < 0
  ) {
    throw new TypeError("Gateway activity summary metadata is invalid.");
  }
  const statusCounts = Object.fromEntries(ACCESS_STATUSES.map((status) => {
    const count = activity.statusCounts[status];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("Gateway activity status count is invalid.");
    }
    return [status, count];
  })) as Record<AccessStatus, number>;
  if (
    Object.values(statusCounts).reduce((total, count) => total + count, 0) !==
      activity.totalAuditEvents
  ) {
    throw new TypeError("Gateway activity total is inconsistent.");
  }
  const recentIssues = activity.recentIssues.slice(0, RECENT_ISSUE_LIMIT).map((issue) => {
    if (
      !boundedText(issue.auditRef, 256) ||
      !boundedText(issue.action, 128) ||
      !ISSUE_STATUSES.includes(issue.status) ||
      (issue.reasonCode !== null && !boundedText(issue.reasonCode, 128)) ||
      !isCanonicalGatewayTimestamp(issue.createdAt)
    ) {
      throw new TypeError("Gateway activity issue projection is invalid.");
    }
    return Object.freeze({
      audit_ref: issue.auditRef,
      action: issue.action,
      status: issue.status,
      reason_code: issue.reasonCode,
      created_at: issue.createdAt,
    });
  });
  return Object.freeze({
    window_started_at: activity.windowStartedAt,
    window_seconds: ACCESS_OPERATIONS_WINDOW_SECONDS,
    total_audit_events: activity.totalAuditEvents,
    status_counts: Object.freeze(statusCounts),
    recent_issues: Object.freeze(recentIssues),
  });
}

export function summarizeAccessOperations(input: AccessOperationsOverviewInput) {
  const tenantCounts = countBy(
    input.state.tenants.map((tenant) => tenant.status),
    ["active", "suspended"] as const,
  );
  const clientCounts = countBy(
    input.state.clients.map((client) => client.status),
    ["active", "disabled"] as const,
  );
  const credentialCounts = countBy(
    input.state.credentials.map((credential) => credential.effectiveStatus),
    [
      "active",
      "pending_delivery",
      "tenant_suspended",
      "client_disabled",
      "expired",
      "revoked",
    ] as const,
  );
  const gatewayActivity = activityProjection(input.activity, input.generatedAt);
  return Object.freeze({
    schema_version: ACCESS_OPERATIONS_SCHEMA_VERSION,
    status: "success" as const,
    data: Object.freeze({
      generated_at: input.generatedAt,
      access_state: Object.freeze({
        tenants: Object.freeze({ total: input.state.tenants.length, ...tenantCounts }),
        clients: Object.freeze({ total: input.state.clients.length, ...clientCounts }),
        credentials: Object.freeze({
          total: input.state.credentials.length,
          ...credentialCounts,
        }),
      }),
      gateway_activity: gatewayActivity,
      agent_onboarding: Object.freeze({
        supported_clients: Object.freeze([
          "chatgpt-work",
          "codex",
          "enterprise-assistant",
        ] as const),
        token_exchange_path: "/access/v1/token/exchange" as const,
        mcp_path: "/mcp" as const,
        tool_names: T0_TOOL_NAMES,
      }),
    }),
    warnings: Object.freeze([]),
    blockers: Object.freeze([]),
  });
}

export interface AccessOperationsAdminHandlerOptions {
  readonly authenticate: (token: string) => AdminPrincipal | Promise<AdminPrincipal>;
  readonly managementTenantId: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly trustedProxyAddresses?: readonly string[];
  readonly allowLoopbackHttp: boolean;
  readonly readState: () => Promise<AccessState>;
  readonly readActivity: (input: Readonly<{
    windowStartedAt: string;
    issueLimit: number;
  }>) => Promise<GatewayActivitySummary>;
  readonly nowSeconds: () => number;
}

export interface AccessOperationsAdminHandler {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

function rawHeaderValues(request: IncomingMessage, name: string): readonly string[] | null {
  if (!Array.isArray(request.rawHeaders) || request.rawHeaders.length % 2 !== 0) return null;
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const key = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (typeof key !== "string" || typeof value !== "string") return null;
    if (key.toLowerCase() === name.toLowerCase()) values.push(value);
  }
  return values;
}

function loopback(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function boundaryAllowed(
  request: IncomingMessage,
  options: AccessOperationsAdminHandlerOptions,
): boolean {
  const remoteAddress = request.socket.remoteAddress;
  const trustedProxy = remoteAddress !== undefined &&
    (options.trustedProxyAddresses ?? []).includes(remoteAddress);
  if (!loopback(remoteAddress) && !trustedProxy) return false;
  const forwardedProto = rawHeaderValues(request, "x-forwarded-proto");
  if (forwardedProto === null || forwardedProto.length > 1) return false;
  if (trustedProxy) {
    if (forwardedProto.length !== 1 || forwardedProto[0] !== "https") return false;
  } else if (
    forwardedProto.length !== 0 ||
    (!options.allowLoopbackHttp &&
      (request.socket as typeof request.socket & { readonly encrypted?: boolean }).encrypted !== true)
  ) {
    return false;
  }
  const hosts = rawHeaderValues(request, "host");
  if (hosts === null || hosts.length !== 1 || !options.allowedHosts.includes(hosts[0] ?? "")) {
    return false;
  }
  const origins = rawHeaderValues(request, "origin");
  if (origins === null || origins.length > 1) return false;
  const origin = origins[0];
  if (origin !== undefined && !(options.allowedOrigins ?? []).includes(origin)) return false;
  const cookies = rawHeaderValues(request, "cookie");
  return cookies !== null && cookies.length === 0;
}

function bearerToken(request: IncomingMessage): string | null {
  const query = request.url?.split("?", 2)[1];
  if (query !== undefined) {
    try {
      if ([...new URLSearchParams(query).keys()].some((key) => AUTH_QUERY_KEYS.has(key.toLowerCase()))) {
        return null;
      }
    } catch {
      return null;
    }
  }
  const values = rawHeaderValues(request, "authorization");
  if (values === null || values.length !== 1) return null;
  return /^Bearer\s+([^\s]+)$/u.exec(values[0]?.trim() ?? "")?.[1] ?? null;
}

function authorized(principal: AdminPrincipal, managementTenantId: string): boolean {
  return principal.tenantId === managementTenantId &&
    principal.role === "admin" &&
    principal.roles.length === 1 &&
    principal.roles[0] === "admin" &&
    principal.scopes.length === 2 &&
    principal.scopes.includes("platform:admin") &&
    principal.scopes.includes("tenant:admin");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(Buffer.byteLength(serialized)));
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "permissions-policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  response.end(serialized);
}

function errorBody(status: "blocked" | "unavailable", reasonCode: string) {
  return Object.freeze({
    schema_version: ACCESS_OPERATIONS_SCHEMA_VERSION,
    status,
    data: null,
    reason_codes: Object.freeze([reasonCode]),
  });
}

async function handleOverview(
  request: IncomingMessage,
  response: ServerResponse,
  options: AccessOperationsAdminHandlerOptions,
): Promise<void> {
  const token = bearerToken(request);
  if (token === null) {
    response.setHeader("www-authenticate", "Bearer");
    sendJson(response, 401, errorBody("blocked", "authentication_failed"));
    return;
  }
  let principal: AdminPrincipal;
  try {
    principal = await options.authenticate(token);
  } catch {
    response.setHeader("www-authenticate", "Bearer");
    sendJson(response, 401, errorBody("blocked", "authentication_failed"));
    return;
  }
  if (!authorized(principal, options.managementTenantId)) {
    sendJson(response, 403, errorBody("blocked", "management_admin_required"));
    return;
  }
  try {
    const nowSeconds = options.nowSeconds();
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new Error("invalid clock");
    const generatedAt = new Date(nowSeconds * 1_000).toISOString();
    const windowStartedAt = new Date(
      (nowSeconds - ACCESS_OPERATIONS_WINDOW_SECONDS) * 1_000,
    ).toISOString();
    const [state, activity] = await Promise.all([
      options.readState(),
      options.readActivity({ windowStartedAt, issueLimit: RECENT_ISSUE_LIMIT }),
    ]);
    sendJson(response, 200, summarizeAccessOperations({ state, activity, generatedAt }));
  } catch {
    sendJson(response, 503, errorBody("unavailable", "access_operations_unavailable"));
  }
}

export function createAccessOperationsAdminHandler(
  options: AccessOperationsAdminHandlerOptions,
): AccessOperationsAdminHandler {
  if (
    options.allowedHosts.length === 0 ||
    new Set(options.allowedHosts).size !== options.allowedHosts.length ||
    new Set(options.allowedOrigins ?? []).size !== (options.allowedOrigins ?? []).length ||
    (options.trustedProxyAddresses ?? []).some((value) => isIP(value) === 0) ||
    new Set(options.trustedProxyAddresses ?? []).size !==
      (options.trustedProxyAddresses ?? []).length
  ) {
    throw new TypeError("Access operations boundary configuration is invalid.");
  }
  return Object.freeze({
    handle(request: IncomingMessage, response: ServerResponse): boolean {
      const path = (request.url ?? "/").split("?", 1)[0];
      if (path !== ACCESS_OPERATIONS_PATH) return false;
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        sendJson(response, 405, errorBody("blocked", "method_not_allowed"));
        return true;
      }
      if (!boundaryAllowed(request, options)) {
        sendJson(response, 403, errorBody("blocked", "admin_boundary_rejected"));
        return true;
      }
      void handleOverview(request, response, options).catch(() => {
        if (!response.destroyed) {
          sendJson(response, 503, errorBody("unavailable", "access_operations_unavailable"));
        }
      });
      return true;
    },
  });
}
