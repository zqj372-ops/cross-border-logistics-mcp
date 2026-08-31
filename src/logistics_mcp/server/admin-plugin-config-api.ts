import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AuthenticationError,
  parseExecutionContext,
  type ExecutionContext,
} from "../platform/context";
import {
  PLUGIN_CONFIG_MODULE_IDS,
  PLUGIN_CONFIG_SCHEMA_VERSION,
  pluginConfigApprovalRequestSchema,
  pluginConfigCreatePreviewRequestSchema,
  pluginConfigOperationResponseSchema,
  pluginConfigPublishRequestSchema,
  pluginConfigReconcileRequestSchema,
  pluginConfigStateSchema,
  pluginConfigValidateDraftRequestSchema,
  type PluginConfigModuleId,
  type PluginConfigApprovalRequest,
  type PluginConfigCreatePreviewRequest,
  type PluginConfigOperationResponse,
  type PluginConfigPublishRequest,
  type PluginConfigReconcileRequest,
  type PluginConfigSpec,
  type PluginConfigState,
  type PluginConfigValidateDraftRequest,
  type PluginConfigWriteMeta,
} from "../control-plane/plugin-config-contracts";
import { pluginConfigGeneration } from "../control-plane/plugin-config-store";

const CONFIG_PREFIX = "/admin/api/v1/config";
const STATE_PATH = `${CONFIG_PREFIX}/state`;
const VALIDATE_PATH = `${CONFIG_PREFIX}/drafts/validate`;
const PREVIEW_PATH = `${CONFIG_PREFIX}/previews`;
const APPROVAL_PATH = `${CONFIG_PREFIX}/approvals`;
const PUBLISH_PATH = `${CONFIG_PREFIX}/releases/publish`;
const RECONCILE_PATH = `${CONFIG_PREFIX}/releases/reconcile`;
const PRODUCTION_DISABLED_REASON = "plugin_config_production_disabled_v1";

const ROUTES = new Map<string, "GET" | "POST">([
  [STATE_PATH, "GET"],
  [VALIDATE_PATH, "POST"],
  [PREVIEW_PATH, "POST"],
  [APPROVAL_PATH, "POST"],
  [PUBLISH_PATH, "POST"],
  [RECONCILE_PATH, "POST"],
]);
const SUPPORTED_POST_PATHS = new Set<string>([
  VALIDATE_PATH,
  PREVIEW_PATH,
  APPROVAL_PATH,
  PUBLISH_PATH,
  RECONCILE_PATH,
]);

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const PERMISSIONS_POLICY = "camera=(), geolocation=(), microphone=(), payment=(), usb=()";
const AUTH_QUERY_KEYS = new Set([
  "access_token", "api_key", "apikey", "auth", "authorization", "bearer", "key", "token",
]);
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{15,199}$/u;

export interface PluginConfigAdminService {
  getState(context: ExecutionContext, moduleId?: PluginConfigModuleId): Promise<unknown>;
  validateDraft(context: ExecutionContext, input: unknown, meta: PluginConfigWriteMeta): Promise<unknown>;
  createPreview(context: ExecutionContext, input: unknown, meta: PluginConfigWriteMeta): Promise<unknown>;
  decideApproval(context: ExecutionContext, input: unknown, meta: PluginConfigWriteMeta): Promise<unknown>;
  publish(context: ExecutionContext, input: unknown, meta: PluginConfigWriteMeta): Promise<unknown>;
  reconcile(context: ExecutionContext, input: unknown, meta: PluginConfigWriteMeta): Promise<unknown>;
}

export interface AdminPluginConfigApiHandlerOptions {
  readonly dataMode: "fixtures" | "production";
  readonly service: PluginConfigAdminService;
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

export interface AdminPluginConfigApiHandler {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

interface ServerIds {
  readonly requestId: string;
  readonly traceId: string;
  readonly auditId: string;
}

type UiStatus = "success" | "needs_input" | "manual_review" | "blocked" | "unavailable";

interface UiEnvelope {
  readonly schema_version: typeof PLUGIN_CONFIG_SCHEMA_VERSION;
  readonly request_id: string;
  readonly trace_id: string;
  readonly audit_id: string;
  readonly status: UiStatus;
  readonly data: unknown;
  readonly reason_codes: readonly string[];
  readonly readback: Readonly<{
    status: string;
    revision: number | null;
    config_digest: string | null;
    module_generation: string | null;
  }>;
}

function ids(): ServerIds {
  const suffix = randomUUID().replaceAll("-", "");
  return Object.freeze({
    requestId: `request_config_${suffix}`,
    traceId: `trace_config_${suffix}`,
    auditId: `audit_config_${suffix}`,
  });
}

function errorEnvelope(
  serverIds: ServerIds,
  status: UiStatus,
  reasonCode: string,
): UiEnvelope {
  return Object.freeze({
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    request_id: serverIds.requestId,
    trace_id: serverIds.traceId,
    audit_id: serverIds.auditId,
    status,
    data: null,
    reason_codes: Object.freeze([reasonCode]),
    readback: Object.freeze({
      status: "not_applicable",
      revision: null,
      config_digest: null,
      module_generation: null,
    }),
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

function pathOf(request: IncomingMessage): string {
  return (request.url ?? "/").split("?", 1)[0] ?? "/";
}

function isLoopback(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function boundaryFailure(
  request: IncomingMessage,
  options: AdminPluginConfigApiHandlerOptions,
  method: string,
): string | null {
  if (!isLoopback(request.socket.remoteAddress)) return "admin_loopback_required";
  if (
    !options.allowLoopbackHttp &&
    (request.socket as { readonly encrypted?: boolean }).encrypted !== true
  ) return "admin_https_required";
  const hosts = rawHeaderValues(request, "host");
  if (hosts === null || hosts.length !== 1) return "admin_request_headers_invalid";
  if (!options.allowedHosts.includes(hosts[0] ?? "")) return "admin_host_not_allowed";
  const origins = rawHeaderValues(request, "origin");
  if (origins === null || origins.length > 1) return "admin_request_headers_invalid";
  const origin = origins[0];
  if (origin !== undefined && !options.allowedOrigins.includes(origin)) return "admin_origin_not_allowed";
  if (method === "POST" && origin === undefined) return "admin_origin_required";
  return null;
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

function bearerToken(request: IncomingMessage): string | null {
  if (hasAuthQuery(request)) return null;
  const cookies = rawHeaderValues(request, "cookie");
  if (cookies === null || cookies.length > 0) return null;
  const authorization = rawHeaderValues(request, "authorization");
  if (authorization === null || authorization.length !== 1) return null;
  return /^Bearer\s+([^\s]+)$/u.exec(authorization[0]?.trim() ?? "")?.[1] ?? null;
}

async function authenticatedContext(
  request: IncomingMessage,
  options: AdminPluginConfigApiHandlerOptions,
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
  if (context.role !== "admin" || !context.roles.includes("admin")) return "admin_role_required";
  if (!context.scopes.includes("platform:admin")) return "platform_admin_scope_required";
  if (context.tenantId !== managementTenantId) return "management_tenant_mismatch";
  return null;
}

function jsonContentType(request: IncomingMessage): boolean {
  const values = rawHeaderValues(request, "content-type");
  return values !== null && values.length === 1 &&
    values[0]?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function declaredLength(
  request: IncomingMessage,
  maxBodyBytes: number,
): "invalid" | "too_large" | number | null {
  const values = rawHeaderValues(request, "content-length");
  if (values === null || values.length > 1) return "invalid";
  const raw = values[0];
  if (raw === undefined) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) return "invalid";
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return "invalid";
  return value > maxBodyBytes ? "too_large" : value;
}

async function readBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "invalid" }
  | { readonly kind: "too_large" }
> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBodyBytes) return { kind: "too_large" };
      chunks.push(bytes);
    }
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "ok", bytes: Buffer.concat(chunks, total) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys) === JSON.stringify([...expected].sort());
}

type SupportedPostPath =
  | typeof VALIDATE_PATH
  | typeof PREVIEW_PATH
  | typeof APPROVAL_PATH
  | typeof PUBLISH_PATH
  | typeof RECONCILE_PATH;

function supportedPost(path: string): path is SupportedPostPath {
  return SUPPORTED_POST_PATHS.has(path);
}

type ParsedPost =
  | PluginConfigValidateDraftRequest
  | PluginConfigCreatePreviewRequest
  | PluginConfigApprovalRequest
  | PluginConfigPublishRequest
  | PluginConfigReconcileRequest;

function parsePost(path: SupportedPostPath, value: unknown): ParsedPost | null {
  if (path === VALIDATE_PATH) {
    const parsed = pluginConfigValidateDraftRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (path === PREVIEW_PATH) {
    const draft = pluginConfigValidateDraftRequestSchema.safeParse(value);
    if (!draft.success) return null;
    const parsed = pluginConfigCreatePreviewRequestSchema.safeParse({ ...draft.data, intent: "change" });
    return parsed.success ? parsed.data : null;
  }
  if (path === APPROVAL_PATH) {
    if (!exactKeys(value, ["schema_version", "preview_ref", "decision", "reason_code"])) return null;
    const parsed = pluginConfigApprovalRequestSchema.safeParse({ ...value, module_id: "freightcom-ltl" });
    return parsed.success ? parsed.data : null;
  }
  if (path === PUBLISH_PATH) {
    if (!exactKeys(value, ["schema_version", "preview_ref", "approval_id"])) return null;
    const parsed = pluginConfigPublishRequestSchema.safeParse({ ...value, module_id: "freightcom-ltl" });
    return parsed.success ? parsed.data : null;
  }
  if (!exactKeys(value, ["schema_version", "release_id"])) return null;
  const parsed = pluginConfigReconcileRequestSchema.safeParse({ ...value, module_id: "freightcom-ltl" });
  return parsed.success ? parsed.data : null;
}

function selectedModule(request: IncomingMessage): PluginConfigModuleId | null {
  try {
    const url = new URL(request.url ?? STATE_PATH, "http://admin.invalid");
    for (const key of url.searchParams.keys()) {
      if (key !== "module_id") return null;
    }
    const values = url.searchParams.getAll("module_id");
    if (values.length === 0) return "freightcom-ltl";
    if (values.length !== 1) return null;
    return PLUGIN_CONFIG_MODULE_IDS.includes(values[0] as PluginConfigModuleId)
      ? values[0] as PluginConfigModuleId
      : null;
  } catch {
    return null;
  }
}

function uiDigest(value: string | null): string {
  const hash = value === null ? null : /sha256:([a-f0-9]{64})$/u.exec(value)?.[1];
  return hash === undefined || hash === null ? "config_digest_unknown" : `config_digest_${hash}`;
}

function uiActorRef(value: string): string {
  const digest = createHash("sha256")
    .update(`mcp-admin-plugin-config-actor/v1\0${value}`, "utf8")
    .digest("hex");
  return `actor_ref_${digest}`;
}

function uiSpec(spec: PluginConfigSpec | null): unknown {
  if (spec === null) return null;
  return {
    spec_id: "freightcom_ltl_test_config",
    version: PLUGIN_CONFIG_SCHEMA_VERSION,
    scope: "deployment",
    restart_policy: "controlled_restart",
    approval_policy: "不同管理员审批",
    validation_policy: "服务端白名单校验",
    readback_policy: "版本 摘要 运行代次精确匹配",
    rollback_policy: "仅可回到已验证发布",
    fields: spec.fields.map((field) => {
      const common = {
        field_id: field.field_id,
        kind: field.kind,
        label: {
          request_timeout_ms: "请求超时",
          poll_interval_ms: "轮询间隔",
          max_poll_attempts: "最大轮询次数",
          egress_profile_id: "出站档位",
          credential_slot_id: "凭证槽位",
        }[field.field_id] ?? field.label,
        description: {
          request_timeout_ms: "测试请求的最长等待时间。",
          poll_interval_ms: "测试状态查询之间的等待时间。",
          max_poll_attempts: "测试状态查询的最大次数。",
          egress_profile_id: "只允许镜像内固定测试出口。",
          credential_slot_id: "只绑定部署端已批准的不透明槽位。",
        }[field.field_id] ?? "由服务端字段规范约束。",
        required: true,
      };
      if (field.kind === "integer") {
        return {
          ...common,
          unit: field.unit === "attempts" ? "次" : "毫秒",
          minimum: field.minimum,
          maximum: field.maximum,
        };
      }
      if (field.kind === "enum") {
        return {
          ...common,
          options: field.allowed_options.map((option) => ({
            id: option.value,
            label: "Freightcom 固定测试出口",
          })),
        };
      }
      if (field.kind === "secret_slot") {
        return {
          ...common,
          options: field.allowed_slots.map((option) => ({
            id: option.value,
            label: "Freightcom 测试凭证槽位",
          })),
        };
      }
      return common;
    }),
  };
}

function uiState(state: PluginConfigState, checkedAt: string, actorId: string): unknown {
  const configured = state.module_id === "freightcom-ltl";
  const digest = uiDigest(state.current_config_digest);
  const generation = state.current_module_generation ?? "generation_none";
  const latestReadback = configured && state.current_readback !== null &&
    state.current_readback.module_generation !== null
    ? {
        revision: state.current_readback.revision,
        config_digest: uiDigest(state.current_readback.config_digest),
        module_generation: state.current_readback.module_generation,
        status: state.current_readback.status === "verified" ? "readback_verified" : state.current_readback.status,
        reason_codes: state.current_readback.status === "verified" ? [] : state.reason_codes,
        checked_at: state.current_readback.checked_at,
        release_id: state.current_readback.release_id,
      }
    : null;
  const latestPreview = configured && state.latest_preview !== null
    ? {
        preview_ref: state.latest_preview.preview_ref,
        creator_actor_ref: uiActorRef(state.latest_preview.creator_actor_id),
        revision: state.latest_preview.base_revision + 1,
        config_digest: uiDigest(state.latest_preview.config_digest),
        module_generation: pluginConfigGeneration(
          state.latest_preview.base_revision + 1,
          state.latest_preview.config_digest,
        ),
        expires_at: state.latest_preview.expires_at,
        status: "previewed",
      }
    : null;
  const latestApproval = configured && state.latest_approval !== null
    ? {
        approval_id: state.latest_approval.approval_id,
        preview_ref: state.latest_approval.preview_ref,
        approver_actor_ref: uiActorRef(state.latest_approval.approver_actor_id),
        decision: state.latest_approval.decision,
        status: state.latest_approval.decision === "approve" ? "approved" : "blocked",
      }
    : null;
  return {
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: state.module_id,
    actor_ref: uiActorRef(actorId),
    config_spec: configured ? uiSpec(state.config_spec) : null,
    current: {
      revision: state.current_revision,
      config_digest: digest,
      module_generation: generation,
      values: state.current_values,
    },
    status: state.status === "success" ? "active_verified" : state.status,
    reason_codes: state.reason_codes,
    checked_at: latestReadback?.checked_at ?? checkedAt,
    allowed_actions: state.allowed_actions,
    latest_preview: latestPreview,
    latest_approval: latestApproval,
    latest_readback: latestReadback,
  };
}

function uiActionData(
  response: PluginConfigOperationResponse,
  context: ExecutionContext,
): unknown {
  const data = response.data;
  if (data === null) return null;
  if (data.kind === "validation") {
    return {
      kind: "config_validation",
      status: data.validation_status,
      reason_codes: response.reason_codes,
      validation_ref: data.validation_id,
    };
  }
  if (data.kind === "preview") {
    return {
      kind: "config_preview",
      preview_ref: data.preview_ref,
      creator_actor_ref: uiActorRef(context.actorId),
      revision: data.base_revision + 1,
      config_digest: uiDigest(data.config_digest),
      module_generation: pluginConfigGeneration(data.base_revision + 1, data.config_digest),
      expires_at: data.expires_at,
      status: "previewed",
    };
  }
  if (data.kind === "approval") {
    return {
      kind: "config_approval",
      approval_id: data.approval_id,
      preview_ref: data.preview_ref,
      approver_actor_ref: uiActorRef(data.approver_actor_id),
      decision: data.decision,
      status: data.decision === "approve" ? "approved" : "blocked",
    };
  }
  if (data.kind === "release") {
    return {
      kind: "config_release",
      release_id: data.release_id,
      revision: data.revision,
      config_digest: uiDigest(data.config_digest),
      module_generation: data.readback?.module_generation ?? pluginConfigGeneration(data.revision, data.config_digest),
      status: data.release_state,
    };
  }
  return {
    kind: "config_reconcile",
    release_id: data.release_id,
    revision: data.revision,
    config_digest: uiDigest(data.readback?.config_digest ?? null),
    module_generation: data.readback?.module_generation ?? "generation_unknown",
    status: data.status,
    reason_codes: response.reason_codes,
    checked_at: data.readback?.checked_at ?? new Date().toISOString(),
  };
}

function uiOperationEnvelope(
  serverIds: ServerIds,
  response: PluginConfigOperationResponse,
  context: ExecutionContext,
): UiEnvelope {
  const data = uiActionData(response, context);
  const readbackData = response.data?.kind === "release" || response.data?.kind === "reconciliation"
    ? response.data.readback
    : null;
  return Object.freeze({
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    request_id: serverIds.requestId,
    trace_id: serverIds.traceId,
    audit_id: serverIds.auditId,
    status: response.status,
    data,
    reason_codes: response.reason_codes,
    readback: readbackData === null
      ? Object.freeze({ status: "not_applicable", revision: null, config_digest: null, module_generation: null })
      : Object.freeze({
          status: readbackData.status === "verified" ? "readback_verified" : readbackData.status,
          revision: readbackData.revision,
          config_digest: uiDigest(readbackData.config_digest),
          module_generation: readbackData.module_generation ?? "generation_unknown",
        }),
  });
}

function statusCode(path: SupportedPostPath, status: PluginConfigOperationResponse["status"]): number {
  if (status === "success") return path === PUBLISH_PATH ? 201 : 200;
  if (status === "manual_review") return 409;
  if (status === "blocked") return 403;
  return 503;
}

async function handlePost(
  request: IncomingMessage,
  response: ServerResponse,
  serverIds: ServerIds,
  path: SupportedPostPath,
  options: AdminPluginConfigApiHandlerOptions,
): Promise<void> {
  if (!jsonContentType(request)) {
    sendJson(request, response, 400, errorEnvelope(serverIds, "blocked", "content_type_invalid"));
    return;
  }
  const declared = declaredLength(request, options.maxBodyBytes);
  if (declared === "invalid") {
    sendJson(request, response, 400, errorEnvelope(serverIds, "blocked", "content_length_invalid"));
    return;
  }
  if (declared === "too_large") {
    sendJson(request, response, 413, errorEnvelope(serverIds, "blocked", "body_too_large"));
    return;
  }
  const body = await readBody(request, options.maxBodyBytes);
  if (body.kind === "too_large") {
    sendJson(request, response, 413, errorEnvelope(serverIds, "blocked", "body_too_large"));
    return;
  }
  if (body.kind === "invalid") {
    sendJson(request, response, 400, errorEnvelope(serverIds, "blocked", "body_read_invalid"));
    return;
  }
  if (typeof declared === "number" && declared !== body.bytes.byteLength) {
    sendJson(request, response, 400, errorEnvelope(serverIds, "blocked", "content_length_mismatch"));
    return;
  }
  const context = await authenticatedContext(request, options);
  if (context === null) {
    sendJson(request, response, 401, errorEnvelope(serverIds, "blocked", "authentication_failed"), {
      authenticate: true,
    });
    return;
  }
  const denied = authorizationFailure(context, options.managementTenantId);
  if (denied !== null) {
    sendJson(request, response, 403, errorEnvelope(serverIds, "blocked", denied));
    return;
  }
  const idempotency = rawHeaderValues(request, "idempotency-key");
  const idempotencyKey = idempotency?.length === 1 ? idempotency[0]?.trim() : undefined;
  if (idempotencyKey === undefined || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    sendJson(request, response, 400, errorEnvelope(serverIds, "blocked", "idempotency_key_invalid"));
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(body.bytes.toString("utf8")) as unknown;
  } catch {
    sendJson(request, response, 400, errorEnvelope(serverIds, "blocked", "invalid_json"));
    return;
  }
  const parsed = parsePost(path, json);
  if (parsed === null) {
    sendJson(request, response, 400, errorEnvelope(serverIds, "blocked", "request_schema_invalid"));
    return;
  }
  const meta: PluginConfigWriteMeta = {
    idempotency_key: idempotencyKey,
    request_id: serverIds.requestId,
    trace_id: serverIds.traceId,
    audit_id: serverIds.auditId,
  };
  let result: unknown;
  try {
    if (path === VALIDATE_PATH) result = await options.service.validateDraft(context, parsed, meta);
    else if (path === PREVIEW_PATH) result = await options.service.createPreview(context, parsed, meta);
    else if (path === APPROVAL_PATH) result = await options.service.decideApproval(context, parsed, meta);
    else if (path === PUBLISH_PATH) result = await options.service.publish(context, parsed, meta);
    else result = await options.service.reconcile(context, parsed, meta);
  } catch {
    sendJson(request, response, 503, errorEnvelope(serverIds, "unavailable", "plugin_config_unavailable"));
    return;
  }
  const operation = pluginConfigOperationResponseSchema.safeParse(result);
  if (!operation.success) {
    sendJson(request, response, 503, errorEnvelope(serverIds, "unavailable", "plugin_config_response_invalid"));
    return;
  }
  sendJson(
    request,
    response,
    statusCode(path, operation.data.status),
    uiOperationEnvelope(serverIds, operation.data, context),
  );
}

export function createAdminPluginConfigApiHandler(
  options: AdminPluginConfigApiHandlerOptions,
): AdminPluginConfigApiHandler {
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0) {
    throw new TypeError("maxBodyBytes must be a positive safe integer.");
  }
  return {
    handle(request, response): boolean {
      const path = pathOf(request);
      if (!path.startsWith(CONFIG_PREFIX)) return false;
      const serverIds = ids();
      const boundary = boundaryFailure(request, options, request.method ?? "GET");
      if (boundary !== null) {
        sendJson(request, response, 403, errorEnvelope(serverIds, "blocked", boundary));
        return true;
      }
      const expectedMethod = ROUTES.get(path);
      if (expectedMethod === undefined) {
        sendJson(request, response, 404, errorEnvelope(serverIds, "blocked", "admin_route_not_found"));
        return true;
      }
      if (request.method !== expectedMethod) {
        sendJson(request, response, 405, errorEnvelope(serverIds, "blocked", "method_not_allowed"), {
          allow: expectedMethod,
        });
        return true;
      }
      if (expectedMethod === "POST" && options.dataMode === "production") {
        sendJson(request, response, 403, errorEnvelope(serverIds, "blocked", PRODUCTION_DISABLED_REASON));
        return true;
      }
      if (supportedPost(path)) {
        void handlePost(request, response, serverIds, path, options).catch(() => {
          if (!response.destroyed) {
            sendJson(request, response, 503, errorEnvelope(serverIds, "unavailable", "plugin_config_unavailable"));
          }
        });
        return true;
      }
      void authenticatedContext(request, options)
        .then(async (context) => {
          if (context === null) {
            sendJson(request, response, 401, errorEnvelope(serverIds, "blocked", "authentication_failed"), {
              authenticate: true,
            });
            return;
          }
          const denied = authorizationFailure(context, options.managementTenantId);
          if (denied !== null) {
            sendJson(request, response, 403, errorEnvelope(serverIds, "blocked", denied));
            return;
          }
          const moduleId = selectedModule(request);
          if (moduleId === null) {
            sendJson(request, response, 400, errorEnvelope(serverIds, "blocked", "module_query_invalid"));
            return;
          }
          const result = pluginConfigStateSchema.safeParse(
            await options.service.getState(context, moduleId),
          );
          if (!result.success) {
            sendJson(request, response, 503, errorEnvelope(serverIds, "unavailable", "plugin_config_state_invalid"));
            return;
          }
          sendJson(request, response, 200, uiState(result.data, options.clock(), context.actorId));
        })
        .catch(() => {
          if (!response.destroyed) {
            sendJson(request, response, 503, errorEnvelope(serverIds, "unavailable", "plugin_config_unavailable"));
          }
        });
      return true;
    },
  };
}
