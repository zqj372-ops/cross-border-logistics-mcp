import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import {
  AuthenticationError,
  parseExecutionContext,
  type AuthClaims,
  type ExecutionContext,
} from "../platform/context";
import {
  validateShortLivedToken,
  type ShortLivedTokenValidationOptions,
} from "../platform/security";
import {
  createEnvelope,
  type EnvelopeStatus,
  type ResponseEnvelope,
} from "../platform/envelope";
import type {
  AuditEvent,
  AuditRepository,
  IdempotencyRepository,
} from "../platform/repositories";
import {
  PlatformConfigurationError,
  type PlatformReadiness,
} from "../platform/dependencies";
import {
  SessionContextMismatchError,
  SessionRegistryCapacityError,
  SessionRegistryClosedError,
  SessionTokenExpiredError,
  type SessionRuntimeHandle,
  type SessionRuntimeRegistry,
} from "../platform/session-runtime";
import {
  CrossTenantAccessError,
  ForbiddenError,
} from "../platform/rbac";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRequiredError,
  IdempotencyStateError,
} from "../platform/idempotency";
import {
  executeRegisteredToolWithResult,
  HandlerUnavailableError,
  ToolContractUnavailableError,
  ToolContractValidationError,
  WriteContractError,
  registerPhaseOneTools,
  type DomainToolHandler,
  type ToolDefinition,
  type ToolContractMap,
  type ToolHandlerMap,
} from "./tool-registry";

export interface McpHttpOptions {
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly authenticate: (
    token: string,
  ) => AuthClaims | Promise<AuthClaims>;
  readonly tokenPolicy?: ShortLivedTokenValidationOptions;
  readonly handlers?: ToolHandlerMap;
  readonly contracts?: ToolContractMap;
  readonly auditRepository: AuditRepository;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly sessionRegistry: SessionRuntimeRegistry;
  readonly runtimeReadiness?: () => Promise<PlatformReadiness>;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly requireHttps?: boolean;
}

export interface McpHttpHandler {
  (request: Request): Promise<Response>;
  close(): Promise<void>;
}

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}
class RequestSecurityError extends Error {}
class RequestTimeoutError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdFor(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied !== null && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(supplied)) {
    return supplied;
  }
  return `req_${randomUUID()}`;
}

function auditId(): string {
  return `audit_${randomUUID()}`;
}

function fixedNotice(code: string, message: string) {
  return {
    code,
    message,
    severity: "error" as const,
    field: null,
  };
}

function errorOutcome(error: unknown): {
  status: EnvelopeStatus;
  code: string;
  message: string;
} {
  if (error instanceof AuthenticationError) {
    return {
      status: "blocked",
      code: "security.authentication_failed",
      message: "Authentication failed.",
    };
  }
  if (error instanceof CrossTenantAccessError) {
    return {
      status: "blocked",
      code: "security.cross_tenant_denied",
      message: "The requested tenant is outside the authenticated scope.",
    };
  }
  if (error instanceof SessionContextMismatchError) {
    return {
      status: "blocked",
      code: "security.session_context_mismatch",
      message: "The MCP session is not bound to the authenticated context.",
    };
  }
  if (error instanceof SessionRegistryCapacityError) {
    return {
      status: "unavailable",
      code: "session.capacity_exhausted",
      message: "The MCP session capacity is currently unavailable.",
    };
  }
  if (error instanceof SessionRegistryClosedError) {
    return {
      status: "unavailable",
      code: "session.registry_closed",
      message: "The MCP session runtime is unavailable.",
    };
  }
  if (error instanceof SessionTokenExpiredError) {
    return {
      status: "blocked",
      code: "security.authentication_failed",
      message: "Authentication failed.",
    };
  }
  if (error instanceof ForbiddenError) {
    return {
      status: "blocked",
      code: "security.forbidden",
      message: "The requested operation is not permitted.",
    };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: "blocked",
      code: "idempotency.payload_conflict",
      message: "The idempotency key conflicts with an earlier request.",
    };
  }
  if (error instanceof IdempotencyInProgressError) {
    return {
      status: "manual_review",
      code: "idempotency.in_progress",
      message: "The idempotency key is already being processed.",
    };
  }
  if (error instanceof IdempotencyStateError) {
    return {
      status: "manual_review",
      code: "idempotency.state_invalid",
      message: "The idempotency operation could not be safely replayed.",
    };
  }
  if (error instanceof IdempotencyRequiredError) {
    return {
      status: "unavailable",
      code: "idempotency.unavailable",
      message: "The write idempotency service is not configured.",
    };
  }
  if (error instanceof ToolContractUnavailableError) {
    return {
      status: "unavailable",
      code: "contract.unavailable",
      message: "The tool contract is not configured.",
    };
  }
  if (error instanceof ToolContractValidationError) {
    return {
      status: "manual_review",
      code: "contract.output_invalid",
      message: "The domain result does not satisfy the tool contract.",
    };
  }
  if (error instanceof WriteContractError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof HandlerUnavailableError) {
    return {
      status: "unavailable",
      code: "handler.unavailable",
      message: "The domain handler is not configured.",
    };
  }
  if (error instanceof RequestTimeoutError) {
    return {
      status: "unavailable",
      code: "security.request_timeout",
      message: "The request exceeded the configured timeout.",
    };
  }
  if (error instanceof BodyTooLargeError) {
    return {
      status: "blocked",
      code: "security.body_too_large",
      message: "The request body exceeds the configured limit.",
    };
  }
  if (error instanceof InvalidJsonError) {
    return {
      status: "needs_input",
      code: "request.invalid_json",
      message: "The request body is not valid JSON.",
    };
  }
  if (error instanceof RequestSecurityError) {
    return {
      status: "blocked",
      code: "security.request_rejected",
      message: "The request did not satisfy the gateway security policy.",
    };
  }
  return {
    status: "unavailable",
    code: "gateway.internal_unavailable",
    message: "The gateway could not complete the request.",
  };
}

function responseForEnvelope(
  envelope: ResponseEnvelope,
  httpStatus: number,
): Response {
  return new Response(JSON.stringify(envelope), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  });
}

function responseForToolEnvelope(envelope: ResponseEnvelope): {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: { ...envelope },
    isError: envelope.status !== "success",
  };
}

function auditValues(
  context: ExecutionContext | null,
  requestId: string,
  envelope: ResponseEnvelope,
  tool: string,
  startedAt: number,
  idempotencyOutcome: AuditEvent["idempotency_outcome"] = "not_applicable",
  readbackStatus: AuditEvent["readback_status"] = "not_applicable",
): Parameters<AuditRepository["append"]>[0] {
  return {
    audit_id: envelope.audit_id,
    tenant_id: context?.tenantId ?? "tenant_unknown",
    actor_id: context?.actorId ?? "actor_unknown",
    client_id: context?.clientId ?? "client_unknown",
    request_id: requestId,
    tool,
    schema_version: envelope.schema_version,
    status: envelope.status,
    source_ids: envelope.source_refs.map((source) => source.source_id),
    versions: envelope.source_refs.map((source) => source.version),
    reason_codes: envelope.blockers.map((blocker) => blocker.code),
    duration_ms: Math.max(0, Date.now() - startedAt),
    idempotency_outcome: idempotencyOutcome,
    readback_status: readbackStatus,
  };
}

function readbackStatusFor(
  tool: string,
  envelope: ResponseEnvelope,
): AuditEvent["readback_status"] {
  if (tool !== "quote.save_draft" && tool !== "review.create_task") {
    return "not_applicable";
  }
  if (envelope.status !== "success" || !isRecord(envelope.data)) {
    return "missing";
  }
  if (envelope.data.operation_status === "previewed") {
    return "not_applicable";
  }
  const readback = envelope.data.readback_evidence;
  return isRecord(readback) && readback.verified === true
    ? "verified"
    : "missing";
}

async function recordAudit(
  repository: AuditRepository,
  context: ExecutionContext | null,
  requestId: string,
  envelope: ResponseEnvelope,
  tool: string,
  startedAt: number,
  idempotencyOutcome: AuditEvent["idempotency_outcome"] = "not_applicable",
): Promise<void> {
  await repository.append(
    auditValues(
      context,
      requestId,
      envelope,
      tool,
      startedAt,
      idempotencyOutcome,
      readbackStatusFor(tool, envelope),
    ),
  );
}

function failureEnvelope(
  requestId: string,
  error: unknown,
): ResponseEnvelope {
  const outcome = errorOutcome(error);
  return createEnvelope({
    requestId,
    auditId: auditId(),
    status: outcome.status,
    data: null,
    blockers: [fixedNotice(outcome.code, outcome.message)],
    reviewStatus: outcome.status === "unavailable" ? "manual_review" : "not_required",
  });
}

function auditPersistenceFailureEnvelope(requestId: string): ResponseEnvelope {
  return createEnvelope({
    requestId,
    auditId: auditId(),
    status: "manual_review",
    data: null,
    blockers: [
      fixedNotice(
        "audit.persistence_failed",
        "The result cannot be released because audit persistence is unavailable.",
      ),
    ],
    reviewStatus: "manual_review",
  });
}

function ensureSecurityOptions(options: McpHttpOptions): void {
  if (options.allowedOrigins.length === 0 || options.allowedHosts.length === 0) {
    throw new Error("Secure MCP HTTP options require origin and host allowlists.");
  }
  if (options.requireHttps === false) {
    throw new Error("HTTPS is mandatory for the remote MCP gateway.");
  }
  if ((options.maxBodyBytes ?? 1024 * 1024) < 1) {
    throw new Error("The maximum request body size must be positive.");
  }
  if ((options.requestTimeoutMs ?? 10_000) < 1) {
    throw new Error("The request timeout must be positive.");
  }
}

function ensurePlatformDependencies(options: McpHttpOptions): void {
  if (options.auditRepository === undefined) {
    throw new PlatformConfigurationError(
      "platform_dependency_missing",
      "audit_repository",
    );
  }
  if (options.idempotencyRepository === undefined) {
    throw new PlatformConfigurationError(
      "platform_dependency_missing",
      "idempotency_repository",
    );
  }
  if (options.sessionRegistry === undefined) {
    throw new PlatformConfigurationError(
      "platform_dependency_missing",
      "session_runtime_registry",
    );
  }
}

function unavailableRuntimeResponse(reasonCodes: readonly string[]): Response {
  const reasons = [...new Set(reasonCodes)].filter((reason) => /^[a-z0-9_]+$/.test(reason));
  return new Response(
    JSON.stringify({
      status: "unavailable",
      reasons: reasons.length > 0 ? reasons : ["runtime_unavailable"],
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}

async function readJsonBody(
  request: Request,
  maxBodyBytes: number,
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new RequestSecurityError();
    }
    if (parsedLength > maxBodyBytes) {
      throw new BodyTooLargeError();
    }
  }

  const bytes = await request.clone().arrayBuffer();
  if (bytes.byteLength > maxBodyBytes) {
    throw new BodyTooLargeError();
  }
  if (bytes.byteLength === 0) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

function assertContextNotOverridden(
  input: unknown,
  context: ExecutionContext,
): void {
  if (Array.isArray(input)) {
    for (const value of input) {
      assertContextNotOverridden(value, context);
    }
    return;
  }
  if (!isRecord(input)) {
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toLowerCase();
    if (normalized === "tenant_context" || normalized === "tenantcontext") {
      if (!isRecord(value) || !Object.hasOwn(value, "tenant_id")) {
        throw new ForbiddenError();
      }
      assertContextNotOverridden(value, context);
      continue;
    }
    if (normalized === "tenant_id" || normalized === "tenantid") {
      if (typeof value !== "string" || value !== context.tenantId) {
        throw new CrossTenantAccessError();
      }
    }
    if (normalized === "actor_id" || normalized === "actorid") {
      if (typeof value !== "string" || value !== context.actorId) {
        throw new ForbiddenError();
      }
    }
    if (normalized === "actor_role" || normalized === "actorrole") {
      if (typeof value !== "string" || value !== context.role) {
        throw new ForbiddenError();
      }
    }
    if (normalized === "roles" || normalized === "scopes") {
      if (
        !Array.isArray(value) ||
        value.length !==
          (normalized === "roles" ? context.roles.length : context.scopes.length) ||
        value.some(
          (candidate) =>
            typeof candidate !== "string" ||
            (normalized === "roles"
              ? !context.roles.some((role) => role === candidate)
              : !context.scopes.includes(candidate)),
        )
      ) {
        throw new ForbiddenError();
      }
    }
    if (normalized === "client_id" || normalized === "clientid") {
      if (typeof value !== "string" || value !== context.clientId) {
        throw new ForbiddenError();
      }
    }
    if (normalized === "session_id" || normalized === "sessionid") {
      if (typeof value !== "string" || value !== context.sessionId) {
        throw new ForbiddenError();
      }
    }
    assertContextNotOverridden(value, context);
  }
}

function assertPhaseOneBoundary(toolName: string, input: unknown): void {
  const forbiddenKey = /(?:^|_)(?:send|publish|booking|commit_operation|formal_declaration|3d|coordinate|layout|center_of_mass|rotation)(?:_|$)/i;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (
        forbiddenKey.test(key) &&
        (toolName === "container.plan_summary" ||
        /(?:^|_)(?:send|publish|booking|formal_declaration|commit_operation)(?:_|$)/i.test(key))
      ) {
        throw new ForbiddenError(
          "The requested operation is outside the Phase 1 tool boundary.",
        );
      }
      visit(child);
    }
  };
  visit(input);
}

function jsonRpcMethod(body: unknown): string | null {
  if (!isRecord(body) || typeof body.method !== "string") {
    return null;
  }
  return body.method;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Request failed."));
      },
    );
  });
}

function registerMcpTools(
  server: McpServer,
  definitions: readonly ToolDefinition[],
  context: ExecutionContext,
  requestIdForCall: () => string,
  auditRepository: AuditRepository,
  idempotencyRepository: IdempotencyRepository,
): void {
  const missingContractInputSchema = z.record(z.string(), z.unknown());
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.name,
        description: `Phase 1 ${definition.kind} tool; domain schema is ${definition.inputSchemaId}.`,
        inputSchema: definition.inputSchema ?? missingContractInputSchema,
      },
      async (input) => {
        const requestId = requestIdForCall();
        const audit = auditId();
        const startedAt = Date.now();
        let envelope: ResponseEnvelope;
        let idempotencyOutcome: AuditEvent["idempotency_outcome"] =
          "not_applicable";
        try {
          assertContextNotOverridden(input, context);
          assertPhaseOneBoundary(definition.name, input);
          const result = await executeRegisteredToolWithResult(
            definition,
            input,
            context,
            {
              requestId,
              auditId: audit,
              idempotencyRepository,
            },
          );
          envelope = result.envelope;
          idempotencyOutcome = result.idempotencyOutcome;
        } catch (error: unknown) {
          const outcome = errorOutcome(error);
          envelope = createEnvelope({
            requestId,
            auditId: audit,
            status: outcome.status,
            data: null,
            blockers: [fixedNotice(outcome.code, outcome.message)],
            reviewStatus:
              outcome.status === "unavailable"
                ? "manual_review"
                : "not_required",
          });
          if (error instanceof IdempotencyConflictError) {
            idempotencyOutcome = "conflict";
          }
          if (error instanceof IdempotencyInProgressError) {
            idempotencyOutcome = "in_progress";
          }
        }
        try {
          await recordAudit(
            auditRepository,
            context,
            requestId,
            envelope,
            definition.name,
            startedAt,
            idempotencyOutcome,
          );
        } catch {
          envelope = auditPersistenceFailureEnvelope(requestId);
        }
        return responseForToolEnvelope(envelope);
      },
    );
  }
}

export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  ensureSecurityOptions(options);
  ensurePlatformDependencies(options);
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const auditRepository = options.auditRepository;
  const idempotencyRepository = options.idempotencyRepository;
  const definitions = registerPhaseOneTools(options.handlers, options.contracts);
  const sessions = options.sessionRegistry;
  const requireHttps = options.requireHttps ?? true;

  const secureFailure = async (
    request: Request,
    status: number,
    error: unknown,
    context: ExecutionContext | null = null,
    tool = "http.security",
  ): Promise<Response> => {
    const requestId = requestIdFor(request);
    const envelope = failureEnvelope(requestId, error);
    try {
      await recordAudit(
        auditRepository,
        context,
        requestId,
        envelope,
        tool,
        Date.now(),
      );
    } catch {
      return responseForEnvelope(
        auditPersistenceFailureEnvelope(requestId),
        503,
      );
    }
    return responseForEnvelope(envelope, status);
  };

  const createSession = async (
    context: ExecutionContext,
  ): Promise<SessionRuntimeHandle> => {
    const sessionId = `mcp_${randomUUID()}`;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
      allowedHosts: [...options.allowedHosts],
      allowedOrigins: [...options.allowedOrigins],
      enableDnsRebindingProtection: true,
      onsessionclosed: (closedSessionId) => {
        void sessions.delete(closedSessionId).catch(() => undefined);
      },
    });
    const server = new McpServer({
      name: "cross-border-logistics-mcp",
      version: "0.1.0",
    });
    const requestIdForCall = () => `req_${randomUUID()}`;
    registerMcpTools(
      server,
      definitions,
      context,
      requestIdForCall,
      auditRepository,
      idempotencyRepository,
    );
    const runtime: SessionRuntimeHandle = { transport, server };
    let registered = false;
    try {
      await sessions.register(sessionId, runtime, context);
      registered = true;
      await server.connect(transport);
    } catch (error: unknown) {
      if (registered) {
        await sessions.delete(sessionId).catch(() => undefined);
      } else {
        await Promise.allSettled([server.close(), transport.close()]);
      }
      throw error;
    }
    return runtime;
  };

  const processRequest = async (request: Request): Promise<Response> => {
    if (options.runtimeReadiness !== undefined) {
      let state: PlatformReadiness;
      try {
        state = await options.runtimeReadiness();
      } catch {
        state = { ready: false, reasons: ["runtime_readiness_unavailable"] };
      }
      if (!state.ready) return unavailableRuntimeResponse(state.reasons);
    }
    const startedAt = Date.now();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return secureFailure(request, 400, new RequestSecurityError());
    }
    if (requireHttps && url.protocol !== "https:") {
      return secureFailure(request, 400, new RequestSecurityError());
    }

    const origin = request.headers.get("origin");
    if (origin === null || !options.allowedOrigins.includes(origin)) {
      return secureFailure(request, 403, new ForbiddenError());
    }
    const host = request.headers.get("host") ?? url.host;
    if (!options.allowedHosts.includes(host)) {
      return secureFailure(request, 403, new ForbiddenError());
    }

    let body: unknown = null;
    if (request.method === "POST") {
      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        return secureFailure(request, 415, new RequestSecurityError());
      }
      try {
        body = await readJsonBody(request, maxBodyBytes);
      } catch (error: unknown) {
        if (error instanceof BodyTooLargeError) {
          return secureFailure(request, 413, error);
        }
        return secureFailure(request, 400, error);
      }
    }

    const authorization = request.headers.get("authorization");
    const match = authorization?.match(/^Bearer\s+(\S+)$/);
    if (match === null || match === undefined) {
      return secureFailure(request, 401, new AuthenticationError());
    }

    let context: ExecutionContext;
    try {
      const token = match[1];
      if (token === undefined) {
        throw new AuthenticationError();
      }
      const claims = await options.authenticate(token);
      if (options.tokenPolicy === undefined) {
        context = parseExecutionContext(claims);
      } else {
        const verified = validateShortLivedToken(claims, options.tokenPolicy);
        context = parseExecutionContext({
          tenant_id: verified.tenant_id,
          actor_id:
            typeof verified.actor_id === "string" ? verified.actor_id : verified.sub,
          actor_role: verified.actor_role,
          roles: verified.roles,
          scopes: verified.scopes,
          client_id: verified.client_id,
          session_id: verified.session_id,
          expires_at: verified.exp,
        });
      }
    } catch {
      return secureFailure(request, 401, new AuthenticationError());
    }

    try {
      assertContextNotOverridden(body, context);
    } catch (error: unknown) {
      return secureFailure(request, 403, error, context);
    }

    const sessionId = request.headers.get("mcp-session-id");
    let session: SessionRuntimeHandle;
    if (sessionId !== null) {
      try {
        const entry = await sessions.get(sessionId, context);
        if (entry === null) {
          return secureFailure(request, 404, new RequestSecurityError(), context);
        }
        const touched = await sessions.touch(sessionId, context);
        if (touched === null) {
          return secureFailure(request, 404, new RequestSecurityError(), context);
        }
        session = touched.runtime;
      } catch (error: unknown) {
        return secureFailure(
          request,
          error instanceof SessionContextMismatchError ? 403 : 503,
          error,
          context,
        );
      }
    } else if (jsonRpcMethod(body) === "initialize") {
      session = await createSession(context);
    } else {
      return secureFailure(request, 400, new RequestSecurityError(), context);
    }

    try {
      const response = await session.transport.handleRequest(
        request,
        request.method === "POST" ? { parsedBody: body } : undefined,
      );
      if (response.status >= 400) {
        const envelope = failureEnvelope(requestIdFor(request), new RequestSecurityError());
        await recordAudit(
          auditRepository,
          context,
          requestIdFor(request),
          envelope,
          "mcp.transport",
          startedAt,
        );
      }
      return response;
    } catch (error: unknown) {
      return secureFailure(request, 503, error, context, "mcp.transport");
    }
  };

  const handler = (request: Request): Promise<Response> =>
    withTimeout(processRequest(request), requestTimeoutMs).catch(
      async (error: unknown) =>
        secureFailure(request, error instanceof RequestTimeoutError ? 504 : 503, error),
    );

  handler.close = async (): Promise<void> => {
    await sessions.close();
  };

  return handler;
}

export function createUnavailableMcpHttpHandler(
  reasonCodes: readonly string[],
): McpHttpHandler {
  const handler = (): Promise<Response> =>
    Promise.resolve(unavailableRuntimeResponse(reasonCodes));
  handler.close = (): Promise<void> => Promise.resolve();
  return handler;
}

export type { DomainToolHandler };
