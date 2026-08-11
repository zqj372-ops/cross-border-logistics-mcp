import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseExecutionContext, type AuthClaims } from "../../src/logistics_mcp/platform/context";
import { MemoryAuditRepository } from "../../src/logistics_mcp/platform/audit";
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
    ...overrides,
  });
}

describe("Streamable HTTP security boundary", () => {
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

    expect(invalidOrigin.status).toBe(403);
    expect(invalidHost.status).toBe(403);
    expect(nonHttps.status).toBe(400);
    expect(invalidContentType.status).toBe(415);
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
    const handle = makeHandler({
      requestTimeoutMs: 10,
      authenticate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return validClaims();
      },
    });

    const response = await handle(makeRequest(initializeBody));
    const body = (await response.json()) as { status?: string };

    expect(response.status).toBe(504);
    expect(body.status).toBe("unavailable");
  });

  it("uses the SDK Streamable HTTP transport for an allowed initialize request", async () => {
    const handle = makeHandler();
    const response = await handle(makeRequest(initializeBody));
    const body = (await response.json()) as {
      result?: { protocolVersion?: string };
    };

    expect(response.status).toBe(200);
    expect(body.result?.protocolVersion).toBe("2025-03-26");
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
