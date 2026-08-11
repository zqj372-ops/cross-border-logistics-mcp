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
  createEnvelope,
  type EnvelopeStatus,
  type ResponseEnvelope,
} from "../platform/envelope";
import { MemoryAuditRepository } from "../platform/audit";
import type { AuditRepository } from "../platform/repositories";
import {
  CrossTenantAccessError,
  ForbiddenError,
} from "../platform/rbac";
import { IdempotencyConflictError } from "../platform/idempotency";
import {
  executeRegisteredTool,
  HandlerUnavailableError,
  registerPhaseOneTools,
  type DomainToolHandler,
  type ToolDefinition,
  type ToolHandlerMap,
} from "./tool-registry";

export interface McpHttpOptions {
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly authenticate: (
    token: string,
  ) => AuthClaims | Promise<AuthClaims>;
  readonly handlers?: ToolHandlerMap;
  readonly auditRepository?: AuditRepository;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly requireHttps?: boolean;
}

export type McpHttpHandler = (request: Request) => Promise<Response>;

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}
class RequestSecurityError extends Error {}
class RequestTimeoutError extends Error {}

interface SessionRecord {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly context: ExecutionContext;
}

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
    idempotency_outcome: "not_applicable",
    readback_status: "not_applicable",
  };
}

async function recordAudit(
  repository: AuditRepository,
  context: ExecutionContext | null,
  requestId: string,
  envelope: ResponseEnvelope,
  tool: string,
  startedAt: number,
): Promise<void> {
  await repository.append(auditValues(context, requestId, envelope, tool, startedAt));
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

function ensureSecurityOptions(options: McpHttpOptions): void {
  if (options.allowedOrigins.length === 0 || options.allowedHosts.length === 0) {
    throw new Error("Secure MCP HTTP options require origin and host allowlists.");
  }
  if ((options.maxBodyBytes ?? 1024 * 1024) < 1) {
    throw new Error("The maximum request body size must be positive.");
  }
  if ((options.requestTimeoutMs ?? 10_000) < 1) {
    throw new Error("The request timeout must be positive.");
  }
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
        value.some((candidate) =>
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

function sameContext(left: ExecutionContext, right: ExecutionContext): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.actorId === right.actorId &&
    left.clientId === right.clientId &&
    left.sessionId === right.sessionId
  );
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
): void {
  const emptyInputSchema = z.object({}).strict();
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.name,
        description: `Phase 1 ${definition.kind} tool; domain schema is ${definition.inputSchemaId}.`,
        inputSchema: emptyInputSchema,
      },
      async (input) => {
        const requestId = requestIdForCall();
        const audit = auditId();
        const startedAt = Date.now();
        let envelope: ResponseEnvelope;
        try {
          assertContextNotOverridden(input, context);
          envelope = await executeRegisteredTool(definition, input, context, {
            requestId,
            auditId: audit,
          });
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
        }
        await recordAudit(
          auditRepository,
          context,
          requestId,
          envelope,
          definition.name,
          startedAt,
        );
        return responseForToolEnvelope(envelope);
      },
    );
  }
}

export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  ensureSecurityOptions(options);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const auditRepository = options.auditRepository ?? new MemoryAuditRepository();
  const definitions = registerPhaseOneTools(options.handlers);
  const sessions = new Map<string, SessionRecord>();
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
    await recordAudit(
      auditRepository,
      context,
      requestId,
      envelope,
      tool,
      Date.now(),
    );
    return responseForEnvelope(envelope, status);
  };

  const createSession = async (
    context: ExecutionContext,
  ): Promise<SessionRecord> => {
    const sessionRef: { current?: SessionRecord } = {};
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `mcp_${randomUUID()}`,
      enableJsonResponse: true,
      allowedHosts: [...options.allowedHosts],
      allowedOrigins: [...options.allowedOrigins],
      enableDnsRebindingProtection: true,
      onsessioninitialized: (sessionId) => {
        if (sessionRef.current !== undefined) {
          sessions.set(sessionId, sessionRef.current);
        }
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
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
    );
    const record: SessionRecord = { transport, server, context };
    sessionRef.current = record;
    await server.connect(transport);
    return record;
  };

  const processRequest = async (request: Request): Promise<Response> => {
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
      context = parseExecutionContext(claims);
    } catch {
      return secureFailure(request, 401, new AuthenticationError());
    }

    try {
      assertContextNotOverridden(body, context);
    } catch (error: unknown) {
      return secureFailure(request, 403, error, context);
    }

    const sessionId = request.headers.get("mcp-session-id");
    let session: SessionRecord | undefined;
    if (sessionId !== null) {
      session = sessions.get(sessionId);
      if (session === undefined) {
        return secureFailure(request, 404, new RequestSecurityError(), context);
      }
      if (!sameContext(session.context, context)) {
        return secureFailure(request, 403, new CrossTenantAccessError(), context);
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

  return (request: Request): Promise<Response> =>
    withTimeout(processRequest(request), requestTimeoutMs).catch(
      async (error: unknown) =>
        secureFailure(request, error instanceof RequestTimeoutError ? 504 : 503, error),
    );
}

export type { DomainToolHandler };
