import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseExecutionContext, type AuthClaims } from "../../src/logistics_mcp/platform/context";
import { MemoryAuditRepository } from "../../src/logistics_mcp/platform/audit";
import type {
  SessionBinding,
  SessionBindingStore,
} from "../../src/logistics_mcp/platform/dependencies";
import {
  hashPayload,
  MemoryIdempotencyRepository,
} from "../../src/logistics_mcp/platform/idempotency";
import { SessionRuntimeRegistry } from "../../src/logistics_mcp/platform/session-runtime";
import { createMcpHttpHandler } from "../../src/logistics_mcp/server/http";

const validClaims = (expiresAt = Math.floor(Date.now() / 1000) + 300): AuthClaims => ({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate", "system:read"],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: expiresAt,
});

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "platform-test", version: "1.0.0" },
  },
};

function makeRequest(
  body: unknown,
  overrides: Record<string, string> = {},
  url = "https://mcp.example.invalid/mcp",
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      origin: "https://client.example.invalid",
      host: "mcp.example.invalid",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

function makeHandler(overrides: Partial<Parameters<typeof createMcpHttpHandler>[0]> = {}) {
  return createMcpHttpHandler({
    allowedOrigins: ["https://client.example.invalid"],
    allowedHosts: ["mcp.example.invalid"],
    maxBodyBytes: 256,
    requestTimeoutMs: 100,
    authenticate: () => validClaims(),
    auditRepository: new MemoryAuditRepository(),
    idempotencyRepository: new MemoryIdempotencyRepository(),
    sessionRegistry: new SessionRuntimeRegistry({
      idleTtlMs: 60_000,
      maxLifetimeMs: 60_000,
      maxTokenLifetimeMs: 60_000,
      maxSessions: 16,
    }),
    ...overrides,
  });
}

function makeStatelessHandler(
  overrides: Partial<Parameters<typeof createMcpHttpHandler>[0]> = {},
) {
  return createMcpHttpHandler({
    transportMode: "stateless",
    allowedOrigins: ["https://client.example.invalid"],
    allowedHosts: ["mcp.example.invalid"],
    maxBodyBytes: 256,
    requestTimeoutMs: 100,
    authenticate: () => validClaims(),
    auditRepository: new MemoryAuditRepository(),
    idempotencyRepository: new MemoryIdempotencyRepository(),
    ...overrides,
  });
}

describe("Streamable HTTP security boundary", () => {
  it("serves independent requests without an MCP session in stateless mode", async () => {
    const handle = makeStatelessHandler();

    const initialized = await handle(makeRequest(initializeBody));
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBeNull();

    const tools = await handle(makeRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-protocol-version": "2025-03-26" },
    ));
    const body = (await tools.json()) as { result?: { tools?: unknown[] } };
    expect(tools.status).toBe(200);
    expect(body.result?.tools).toBeDefined();

    await handle.close();
  });

  it("rejects a stateful session header in stateless mode", async () => {
    const handle = makeStatelessHandler();
    const response = await handle(makeRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        "mcp-protocol-version": "2025-03-26",
        "mcp-session-id": "mcp_confused_client",
      },
    ));
    const body = (await response.json()) as { status?: string };

    expect(response.status).toBe(400);
    expect(body.status).toBe("blocked");
    await handle.close();
  });

  it("rejects unauthenticated requests without invoking a handler", async () => {
    let handlerCalled = false;
    const handle = makeHandler({
      authenticate: () => {
        handlerCalled = true;
        return validClaims();
      },
    });

    const response = await handle(
      makeRequest(initializeBody, { authorization: "" }),
    );
    const body = (await response.json()) as { status?: string };

    expect(response.status).toBe(401);
    expect(body.status).toBe("blocked");
    expect(handlerCalled).toBe(false);
  });

  it("rejects invalid origin, host, non-HTTPS, and content type", async () => {
    const handle = makeHandler();

    const invalidOrigin = await handle(
      makeRequest(initializeBody, { origin: "https://evil.example.invalid" }),
    );
    const invalidHost = await handle(
      makeRequest(initializeBody, { host: "evil.example.invalid" }),
    );
    const nonHttps = await handle(
      makeRequest(initializeBody, {}, "http://mcp.example.invalid/mcp"),
    );
    const invalidContentType = await handle(
      makeRequest(initializeBody, { "content-type": "text/plain" }),
    );
    const originlessRequest = makeRequest(initializeBody);
    originlessRequest.headers.delete("origin");
    const missingOrigin = await handle(originlessRequest);

    expect(invalidOrigin.status).toBe(403);
    expect(invalidHost.status).toBe(403);
    expect(nonHttps.status).toBe(400);
    expect(invalidContentType.status).toBe(415);
    expect(missingOrigin.status).toBe(200);
  });

  it("does not allow HTTPS to be disabled by configuration", () => {
    expect(() => makeHandler({ requireHttps: false })).toThrow(/HTTPS/i);
  });

  it("rejects an expired bearer token and an oversized request body", async () => {
    const expiredHandle = makeHandler({
      authenticate: () => validClaims(Math.floor(Date.now() / 1000) - 1),
    });
    const expired = await expiredHandle(makeRequest(initializeBody));

    const oversizedHandle = makeHandler({ maxBodyBytes: 32 });
    const oversized = await oversizedHandle(makeRequest(initializeBody));

    expect(expired.status).toBe(401);
    expect(oversized.status).toBe(413);
  });

  it("returns a bounded timeout response when authentication does not finish", async () => {
    const bindings = new Map<string, SessionBinding>();
    const handle = makeHandler({
      requestTimeoutMs: 10,
      sessionBindingStore: {
        get: (sessionId) => Promise.resolve(bindings.get(sessionId) ?? null),
        put: (binding) => {
          bindings.set(binding.sessionId, binding);
          return Promise.resolve();
        },
        delete: (sessionId) => {
          bindings.delete(sessionId);
          return Promise.resolve();
        },
      },
      sessionOwnerId: "worker_timeout_test",
      authenticate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return validClaims();
      },
    });

    const response = await handle(makeRequest(initializeBody));
    const body = (await response.json()) as { status?: string };

    expect(response.status).toBe(504);
    expect(body.status).toBe("unavailable");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(bindings.size).toBe(0);
  });

  it("propagates timeout cancellation before a write handler commits", async () => {
    let writes = 0;
    const key = "idem_http_timeout_123456";
    const handle = makeHandler({
      maxBodyBytes: 2048,
      requestTimeoutMs: 20,
      authenticate: () => ({
        ...validClaims(),
        scopes: ["quote:calculate", "quote:draft_write"],
      }),
      handlers: {
        "quote.save_draft": async (_input, _context, signal) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          signal?.throwIfAborted();
          writes += 1;
          return { status: "unavailable", data: null };
        },
      },
      contracts: {
        "quote.save_draft": {
          inputSchema: z.record(z.string(), z.unknown()),
          validateOutput: () => undefined,
        },
      },
    });
    const initialized = await handle(makeRequest(initializeBody));
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();

    const response = await handle(makeRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "quote.save_draft", arguments: {
        schema_version: "2026-08-11.v1",
        write_context: {
          tenant_context: {
            tenant_id: "tenant_demo",
            actor_id: "actor_sales",
            actor_role: "sales",
            client_id: "client_demo",
            session_id: "session_demo",
          },
          idempotency_key: key,
          operation_mode: "commit",
          preview_ref: "preview_timeout_001",
          approval: { required: true, status: "approved", approval_id: "approval_timeout_001" },
        },
      } },
    }, { "mcp-session-id": sessionId ?? "" }));

    expect(response.status).toBe(504);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(writes).toBe(0);
    await handle.close();
  });

  it("uses the SDK Streamable HTTP transport for an allowed initialize request", async () => {
    const handle = makeHandler({
      contracts: {
        "cargo.calculate": {
          inputSchema: z.object({}).catchall(z.unknown()),
          validateOutput: () => undefined,
          outputSchema: z.object({ custom_marker: z.string() }).strict(),
        },
      },
    });
    const response = await handle(makeRequest(initializeBody));
    const body = (await response.json()) as {
      result?: { protocolVersion?: string; instructions?: string };
    };

    expect(response.status).toBe(200);
    expect(body.result?.protocolVersion).toBe("2025-03-26");
    expect(body.result?.instructions).toContain("成功（success）");
    expect(body.result?.instructions).toContain("需补充（needs_input）");
    expect(body.result?.instructions).toContain("人工复核（manual_review）");
    expect(body.result?.instructions).toContain("已阻止（blocked）");
    expect(body.result?.instructions).toContain("暂不可用（unavailable）");
    expect(body.result?.instructions).toContain("写操作必须按预览→审批→提交→读回执行");
    expect(body.result?.instructions).toContain("sendable=false");
    expect(body.result?.instructions?.length).toBeLessThanOrEqual(512);
    const toolsResponse = await handle(makeRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-session-id": response.headers.get("mcp-session-id") ?? "" },
    ));
    const toolsBody = (await toolsResponse.json()) as {
      result?: {
        tools?: Array<{
          name?: string;
          inputSchema?: { $schema?: string };
          outputSchema?: {
            $schema?: string;
            properties?: Record<string, unknown>;
          };
        }>;
      };
    };
    expect(toolsBody.result?.tools?.every((tool) =>
      tool.inputSchema?.$schema === "https://json-schema.org/draft/2020-12/schema"
    )).toBe(true);
    const cargoTool = toolsBody.result?.tools?.find(
      (tool) => tool.name === "cargo.calculate",
    );
    const statusTool = toolsBody.result?.tools?.find(
      (tool) => tool.name === "system.get_data_status",
    );
    expect(cargoTool?.outputSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { custom_marker: { type: "string" } },
    });
    expect(statusTool?.outputSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { schema_version: { const: "2026-08-11.v1" } },
    });
    await handle.close();
  });

  it("removes a new session when the SDK rejects initialize", async () => {
    const bindings = new Map<string, SessionBinding>();
    const handle = makeHandler({
      sessionBindingStore: {
        get: (sessionId) => Promise.resolve(bindings.get(sessionId) ?? null),
        put: (binding) => {
          bindings.set(binding.sessionId, binding);
          return Promise.resolve();
        },
        delete: (sessionId) => {
          bindings.delete(sessionId);
          return Promise.resolve();
        },
      },
      sessionOwnerId: "worker_rejected_initialize",
    });
    const request = makeRequest(initializeBody);
    request.headers.delete("accept");

    const response = await handle(request);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(bindings.size).toBe(0);
    await handle.close();
  });

  it("persists session ownership and rejects a binding owned by another process", async () => {
    const bindings = new Map<string, SessionBinding>();
    const bindingStore: SessionBindingStore = {
      get: (sessionId) => Promise.resolve(bindings.get(sessionId) ?? null),
      put: (binding) => {
        bindings.set(binding.sessionId, binding);
        return Promise.resolve();
      },
      delete: (sessionId) => {
        bindings.delete(sessionId);
        return Promise.resolve();
      },
    };
    const handle = makeHandler({
      sessionBindingStore: bindingStore,
      sessionOwnerId: "worker_a",
    });

    const initialized = await handle(makeRequest(initializeBody));
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();
    expect(bindings.get(sessionId ?? "")).toMatchObject({
      sessionId,
      tenantId: "tenant_demo",
      ownerId: "worker_a",
    });

    const binding = bindings.get(sessionId ?? "");
    if (binding === undefined) throw new Error("session binding was not stored");
    bindings.set(binding.sessionId, { ...binding, ownerId: "worker_b" });
    const response = await handle(
      makeRequest(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "mcp-session-id": sessionId ?? "" },
      ),
    );

    expect(response.status).toBe(503);
    await handle.close();
    expect(bindings.size).toBe(0);
  });

  it("deletes the durable binding when a client explicitly terminates its session", async () => {
    const bindings = new Map<string, SessionBinding>();
    const handle = makeHandler({
      sessionBindingStore: {
        get: (sessionId) => Promise.resolve(bindings.get(sessionId) ?? null),
        put: (binding) => {
          bindings.set(binding.sessionId, binding);
          return Promise.resolve();
        },
        delete: (sessionId) => {
          bindings.delete(sessionId);
          return Promise.resolve();
        },
      },
      sessionOwnerId: "worker_terminate_test",
    });
    const initialized = await handle(makeRequest(initializeBody));
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();
    expect(bindings.size).toBe(1);

    const terminated = await handle(new Request("https://mcp.example.invalid/mcp", {
      method: "DELETE",
      headers: {
        authorization: "Bearer test-token",
        origin: "https://client.example.invalid",
        host: "mcp.example.invalid",
        "mcp-session-id": sessionId ?? "",
      },
    }));

    expect(terminated.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bindings.size).toBe(0);
    await handle.close();
  });

  it("maps a verified raw JWT payload only after gateway token policy validation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const handle = makeHandler({
      tokenPolicy: {
        issuer: "https://issuer.example.invalid/",
        audience: "logistics-mcp",
        nowSeconds: now,
      },
      authenticate: () => ({
        iss: "https://issuer.example.invalid/",
        aud: "logistics-mcp",
        sub: "actor_sales",
        tenant_id: "tenant_demo",
        actor_role: "sales",
        roles: ["sales"],
        scopes: ["quote:calculate", "system:read"],
        client_id: "client_demo",
        session_id: "session_demo",
        iat: now - 1,
        exp: now + 300,
      }),
    });

    const response = await handle(makeRequest(initializeBody));

    expect(response.status).toBe(200);
    await handle.close();
  });

  it("returns unavailable instead of a pseudo-success when no handler exists", async () => {
    const handle = makeHandler();
    const initializeResponse = await handle(makeRequest(initializeBody));
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();

    const response = await handle(
      makeRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "cargo.calculate", arguments: {} },
        },
        { "mcp-session-id": sessionId ?? "" },
      ),
    );
    const body = (await response.json()) as {
      status?: string;
      result?: { structuredContent?: { status?: string } };
    };

    expect(response.status).toBe(200);
    expect(body.status ?? body.result?.structuredContent?.status).toBe(
      "unavailable",
    );
  });

  it("fails closed when audit persistence is unavailable", async () => {
    const handle = makeHandler({
      auditRepository: {
        append: () => Promise.reject(new Error("audit store unavailable")),
        list: () => Promise.resolve([]),
      },
    });
    const initializeResponse = await handle(makeRequest(initializeBody));
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();

    const response = await handle(
      makeRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "cargo.calculate", arguments: {} },
        },
        { "mcp-session-id": sessionId ?? "" },
      ),
    );
    const body = (await response.json()) as {
      result?: { structuredContent?: { status?: string } };
    };

    expect(body.result?.structuredContent?.status).toBe("manual_review");
  });

  it("replays a write result and blocks a same-key payload conflict over HTTP", async () => {
    let handlerCalls = 0;
    const key = "idem_http_registry_123";
    const writeInput = {
      schema_version: "2026-08-11.v1",
      write_context: {
        tenant_context: {
          tenant_id: "tenant_demo",
          actor_id: "actor_sales",
          actor_role: "sales",
          client_id: "client_demo",
          session_id: "session_demo",
        },
        idempotency_key: key,
        operation_mode: "preview",
        preview_ref: null,
        approval: {
          required: false,
          status: "not_required",
          approval_id: null,
        },
      },
    };
    const writeClaims = {
      ...validClaims(),
      scopes: ["quote:calculate", "system:read", "quote:draft_write"],
    } satisfies AuthClaims;
    const auditRepository = new MemoryAuditRepository();
    const handle = makeHandler({
      maxBodyBytes: 2048,
      authenticate: () => writeClaims,
      auditRepository,
      handlers: {
        "quote.save_draft": () => {
          handlerCalls += 1;
          return {
            status: "success" as const,
            data: {
              version: "quote.v1",
              operation: "quote.save_draft",
              operation_status: "previewed",
              record_id: null,
              preview_ref: "preview_http_001",
              readback_evidence: null,
              idempotency_key: key,
              approval: {
                required: false,
                status: "not_required",
                approval_id: null,
              },
            },
          };
        },
      },
      contracts: {
        "quote.save_draft": {
          inputSchema: z.record(z.string(), z.unknown()),
          validateOutput: () => undefined,
        },
      },
    });
    const initializeResponse = await handle(makeRequest(initializeBody));
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();
    const call = (argumentsValue: unknown) =>
      makeRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "quote.save_draft", arguments: argumentsValue },
        },
        { "mcp-session-id": sessionId ?? "" },
      );

    const first = await handle(call(writeInput));
    const firstBody = (await first.json()) as {
      result?: { structuredContent?: Record<string, unknown> };
    };
    const second = await handle(call(writeInput));
    const secondBody = (await second.json()) as {
      result?: { structuredContent?: Record<string, unknown> };
    };
    const conflict = await handle(call({ ...writeInput, changed: true }));
    const conflictBody = (await conflict.json()) as {
      result?: { structuredContent?: { status?: string } };
    };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.result?.structuredContent).toEqual(
      secondBody.result?.structuredContent,
    );
    expect(handlerCalls).toBe(1);
    expect(conflictBody.result?.structuredContent?.status).toBe("blocked");
    const auditEvents = (await auditRepository.list()).filter(
      (event) => event.tool === "quote.save_draft",
    );
    expect(auditEvents.map((event) => event.idempotency_outcome)).toEqual([
      "reserved",
      "replayed",
      "conflict",
    ]);
  });

  it("returns a deterministic non-500 result for a concurrent in-progress write", async () => {
    const key = "idem_http_concurrent_001";
    let handlerCalls = 0;
    const writeInput = {
      schema_version: "2026-08-11.v1",
      write_context: {
        tenant_context: {
          tenant_id: "tenant_demo",
          actor_id: "actor_sales",
          actor_role: "sales",
          client_id: "client_demo",
          session_id: "session_demo",
        },
        idempotency_key: key,
        operation_mode: "preview",
        preview_ref: null,
        approval: {
          required: false,
          status: "not_required",
          approval_id: null,
        },
      },
    };
    const idempotencyRepository = new MemoryIdempotencyRepository();
    const reserve = idempotencyRepository.reserve({
      tenantId: "tenant_demo",
      tool: "quote.save_draft",
      key,
      requestHash: hashPayload(writeInput),
    });
    const writeClaims = {
      ...validClaims(),
      scopes: ["quote:calculate", "system:read", "quote:draft_write"],
    } satisfies AuthClaims;
    const handle = makeHandler({
      maxBodyBytes: 2048,
      authenticate: () => writeClaims,
      idempotencyRepository,
      handlers: {
        "quote.save_draft": () => {
          handlerCalls += 1;
          return {
            status: "success" as const,
            data: {
              version: "write-result@fixture-1",
              operation: "quote.save_draft",
              operation_status: "previewed",
              record_id: null,
              preview_ref: "preview_http_concurrent_001",
              readback_evidence: null,
              idempotency_key: key,
              approval: {
                required: false,
                status: "not_required",
                approval_id: null,
              },
            },
          };
        },
      },
      contracts: {
        "quote.save_draft": {
          inputSchema: z.record(z.string(), z.unknown()),
          validateOutput: () => undefined,
        },
      },
    });
    await reserve;
    const initializeResponse = await handle(makeRequest(initializeBody));
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();
    const response = await handle(
      makeRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "quote.save_draft", arguments: writeInput },
        },
        { "mcp-session-id": sessionId ?? "" },
      ),
    );
    const body = (await response.json()) as {
      result?: { structuredContent?: Record<string, unknown> };
    };
    const envelope = body.result?.structuredContent;

    expect(response.status).toBe(200);
    expect(envelope?.status).toBe("manual_review");
    expect(envelope?.data).toBeNull();
    expect(envelope?.blockers).toEqual([
      expect.objectContaining({ code: "idempotency.in_progress" }),
    ]);
    expect(handlerCalls).toBe(0);
  });

  it("does not let an input tenant override the authenticated context", async () => {
    const context = parseExecutionContext(validClaims());
    expect(context.tenantId).toBe("tenant_demo");

    const handle = makeHandler();
    const response = await handle(
      makeRequest({
        ...initializeBody,
        params: {
          ...initializeBody.params,
          _meta: { tenant_id: "tenant_other" },
        },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("binds the complete authenticated role and scope set to a session", async () => {
    let authenticateCalls = 0;
    const handle = makeHandler({
      authenticate: () => {
        authenticateCalls += 1;
        return authenticateCalls === 1
          ? validClaims()
          : {
              ...validClaims(),
              actor_role: "viewer",
              roles: ["viewer"],
              scopes: ["system:read"],
            };
      },
    });
    const initializeResponse = await handle(makeRequest(initializeBody));
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();

    const response = await handle(
      makeRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "system.get_data_status", arguments: {} },
        },
        { "mcp-session-id": sessionId ?? "" },
      ),
    );

    expect(response.status).toBe(403);
  });

  it("rejects a tenant_context scalar that tries to replace server context", async () => {
    const handle = makeHandler();
    const response = await handle(
      makeRequest({
        ...initializeBody,
        params: {
          ...initializeBody.params,
          _meta: { tenant_context: "tenant_other" },
        },
      }),
    );

    expect(response.status).toBe(403);
  });
});
