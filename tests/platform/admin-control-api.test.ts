import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerResponse,
  type Server,
} from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAdminControlApiHandler,
  type AdminControlApiHandler,
} from "../../src/logistics_mcp/server/admin-control-api";
import { canonicalControlHash } from "../../src/logistics_mcp/control-plane/canonical-control-hash";
import type { ModuleControlService } from "../../src/logistics_mcp/control-plane/service";

const ADMIN_TENANT = "tenant_admin";
const CONTROL_SCHEMA_VERSION = "2026-08-22.v1";
const VALID_ENVELOPE = {
  schema_version: CONTROL_SCHEMA_VERSION,
  request_id: "request-state",
  trace_id: "trace-state",
  audit_id: "audit-state",
  status: "success",
  data: null,
  reason_codes: [],
  readback: {
    status: "not_applicable",
    release_id: null,
    revision: null,
  },
} as const;

const REGISTER_REQUEST = {
  schema_version: CONTROL_SCHEMA_VERSION,
  module_id: "cargo",
  version: "1.0.0",
  descriptor_digest: `sha256:${"1".repeat(64)}`,
} as const;

const PREVIEW_REQUEST = {
  schema_version: CONTROL_SCHEMA_VERSION,
  intent: "change",
  desired_modules: [
    {
      module_id: "cargo",
      version: "1.0.0",
      descriptor_digest: `sha256:${"1".repeat(64)}`,
    },
  ],
} as const;

const APPROVAL_REQUEST = {
  schema_version: CONTROL_SCHEMA_VERSION,
  preview_ref: "preview-001",
  decision: "approve",
  reason_code: "operator-approved",
} as const;

const PUBLISH_REQUEST = {
  schema_version: CONTROL_SCHEMA_VERSION,
  preview_ref: "preview-001",
  approval_id: "approval-001",
} as const;

const RECONCILE_REQUEST = {
  schema_version: CONTROL_SCHEMA_VERSION,
  release_id: "release-001",
} as const;

const serviceState = vi.fn((context: unknown): Promise<unknown> => {
  void context;
  return Promise.resolve(VALID_ENVELOPE);
});
const serviceRegister = vi.fn(
  (context: unknown, request: unknown, meta: unknown): Promise<unknown> => {
    void context;
    void request;
    void meta;
    return Promise.resolve(VALID_ENVELOPE);
  },
);
const servicePreview = vi.fn(
  (context: unknown, request: unknown, meta: unknown): Promise<unknown> => {
    void context;
    void request;
    void meta;
    return Promise.resolve(VALID_ENVELOPE);
  },
);
const serviceApproval = vi.fn(
  (context: unknown, request: unknown, meta: unknown): Promise<unknown> => {
    void context;
    void request;
    void meta;
    return Promise.resolve(VALID_ENVELOPE);
  },
);
const servicePublish = vi.fn(
  (context: unknown, request: unknown, meta: unknown): Promise<unknown> => {
    void context;
    void request;
    void meta;
    return Promise.resolve(VALID_ENVELOPE);
  },
);
const serviceReconcile = vi.fn(
  (context: unknown, request: unknown, meta: unknown): Promise<unknown> => {
    void context;
    void request;
    void meta;
    return Promise.resolve(VALID_ENVELOPE);
  },
);

function validClaims(): Record<string, unknown> {
  return {
    tenant_id: ADMIN_TENANT,
    actor_id: "actor-admin",
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin"],
    client_id: "client-admin",
    session_id: "session-admin",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
}

let authClaims = validClaims();
const authenticate = vi.fn(() => authClaims);

function service(): ModuleControlService {
  return {
    getState: serviceState,
    registerPackage: serviceRegister,
    createDeploymentPreview: servicePreview,
    decideApproval: serviceApproval,
    publish: servicePublish,
    reconcile: serviceReconcile,
  } as ModuleControlService;
}

function handler(
  dataMode: "fixtures" | "production",
  host: string,
  origin: string,
  maxBodyBytes = 32 * 1024,
): AdminControlApiHandler {
  return createAdminControlApiHandler({
    dataMode,
    service: service(),
    authenticate,
    managementTenantId: ADMIN_TENANT,
    allowedOrigins: [origin],
    allowedHosts: [host],
    allowLoopbackHttp: true,
    maxBodyBytes,
    clock: () => "2026-08-26T00:00:00Z",
  });
}

async function listen(
  dataMode: "fixtures" | "production",
  maxBodyBytes = 32 * 1024,
): Promise<{ readonly server: Server; readonly url: string }> {
  const apiRef: { current?: AdminControlApiHandler } = {};
  const server = createServer((request, response) => {
    const api = apiRef.current;
    if (api === undefined || !api.handle(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Admin control test server did not expose an address.");
  }
  const host = `127.0.0.1:${address.port}`;
  apiRef.current = handler(dataMode, host, `http://${host}`, maxBodyBytes);
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface RawRequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string | readonly string[]>;
  readonly omitHeaders?: readonly string[];
  readonly body?: string;
  readonly chunks?: readonly string[];
}

async function rawRequest(
  url: string,
  path: string,
  options: RawRequestOptions = {},
): Promise<RawResponse> {
  const target = new URL(`${url}${path}`);
  const headers: OutgoingHttpHeaders = {
    origin: url,
    authorization: "Bearer fixture-token",
    "content-type": "application/json",
    "idempotency-key": "idem-raw-request-001",
  };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name] = typeof value === "string" ? value : Array.from(value);
  }
  for (const name of options.omitHeaders ?? []) {
    delete headers[name];
  }
  return new Promise<RawResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "POST",
        headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        });
      },
    );
    request.once("error", reject);
    if (options.chunks !== undefined) {
      for (const chunk of options.chunks) request.write(chunk);
      request.end();
      return;
    }
    request.end(options.body);
  });
}

function expectSecurityHeaders(headers: Headers): void {
  expect(headers.get("cache-control")).toBe("no-store");
  expect(headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("referrer-policy")).toBe("no-referrer");
  expect(headers.get("x-frame-options")).toBe("DENY");
  expect(headers.get("permissions-policy")).toBe(
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
}

function expectRawSecurityHeaders(headers: IncomingHttpHeaders): void {
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["permissions-policy"]).toBe(
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
}

function expectNoServiceCalls(): void {
  expect(serviceState).not.toHaveBeenCalled();
  expect(serviceRegister).not.toHaveBeenCalled();
  expect(servicePreview).not.toHaveBeenCalled();
  expect(serviceApproval).not.toHaveBeenCalled();
  expect(servicePublish).not.toHaveBeenCalled();
  expect(serviceReconcile).not.toHaveBeenCalled();
}

function directResponse(): {
  readonly response: ServerResponse;
  readonly headers: Record<string, string>;
  readonly getBody: () => string;
} {
  const headers: Record<string, string> = {};
  let body = "";
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(value?: string) {
      body = value ?? "";
    },
  } as unknown as ServerResponse;
  return { response, headers, getBody: () => body };
}

function directRequest(remoteAddress: string): IncomingMessage {
  return {
    method: "POST",
    url: "/admin/api/v1/control/packages/register",
    rawHeaders: [
      "host",
      "127.0.0.1:1",
      "origin",
      "http://127.0.0.1:1",
    ],
    socket: { remoteAddress },
    resume: vi.fn(),
  } as unknown as IncomingMessage;
}

async function postChunked(url: string, path: string, body: string): Promise<number> {
  const target = new URL(`${url}${path}`);
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          origin: url,
          authorization: "Bearer fixture-token",
          "content-type": "application/json",
          "idempotency-key": "idem-streamed-001",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.write(body.slice(0, 64));
    request.end(body.slice(64));
  });
}

afterEach(() => {
  serviceState.mockClear();
  serviceRegister.mockClear();
  servicePreview.mockClear();
  serviceApproval.mockClear();
  servicePublish.mockClear();
  serviceReconcile.mockClear();
  authenticate.mockClear();
  authClaims = validClaims();
});

async function postJson(
  url: string,
  path: string,
  body: unknown,
  options: {
    readonly idempotencyKey?: string | undefined;
    readonly authorization?: string | undefined;
    readonly contentType?: string | undefined;
    readonly rawBody?: string | undefined;
  } = {},
): Promise<Response> {
  const rawBody = options.rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = { origin: url };
  if (Object.hasOwn(options, "contentType")) {
    if (options.contentType !== undefined) {
      headers["content-type"] = options.contentType;
    }
  } else {
    headers["content-type"] = "application/json";
  }
  if (Object.hasOwn(options, "authorization")) {
    if (options.authorization !== undefined) {
      headers.authorization = options.authorization;
    }
  } else {
    headers.authorization = "Bearer fixture-token";
  }
  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  return fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("admin control API first batch", () => {
  it("authenticates and serves control state", async () => {
    const { server, url } = await listen("fixtures");
    try {
      const response = await fetch(`${url}/admin/api/v1/control/state`, {
        headers: {
          authorization: "Bearer fixture-token",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.json()).toEqual(VALID_ENVELOPE);
      expect(authenticate).toHaveBeenCalledWith("fixture-token");
      expect(serviceState).toHaveBeenCalledTimes(1);
      expect(serviceState.mock.calls[0]?.[0]).toMatchObject({
        tenantId: ADMIN_TENANT,
        actorId: "actor-admin",
        role: "admin",
        roles: ["admin"],
        scopes: ["platform:admin"],
      });
    } finally {
      await close(server);
    }
  });

  it("blocks every production POST before authentication or service", async () => {
    const { server, url } = await listen("production");
    try {
      const response = await fetch(`${url}/admin/api/v1/control/packages/register`, {
        method: "POST",
        headers: {
          origin: url,
          authorization: "Bearer fixture-token",
          "content-type": "application/json",
          "idempotency-key": "idem_register_001",
        },
        body: JSON.stringify({
          schema_version: CONTROL_SCHEMA_VERSION,
          module_id: "cargo",
          version: "1.0.0",
          descriptor_digest: `sha256:${"1".repeat(64)}`,
        }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        schema_version: CONTROL_SCHEMA_VERSION,
        status: "blocked",
        data: null,
        reason_codes: ["admin_control_production_disabled_v1"],
      });
      expect(authenticate).not.toHaveBeenCalled();
      expect(serviceState).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("dispatches register and preview with server-owned metadata and canonical request hashes", async () => {
    const { server, url } = await listen("fixtures");
    try {
      const registerResponse = await postJson(
        url,
        "/admin/api/v1/control/packages/register",
        REGISTER_REQUEST,
        { idempotencyKey: "idem-register-001" },
      );
      const previewResponse = await postJson(
        url,
        "/admin/api/v1/control/deployments/preview",
        PREVIEW_REQUEST,
        { idempotencyKey: "idem-preview-001" },
      );

      expect(registerResponse.status).toBe(201);
      expect(previewResponse.status).toBe(200);
      expect(serviceRegister).toHaveBeenCalledTimes(1);
      expect(servicePreview).toHaveBeenCalledTimes(1);

      const registerCall = serviceRegister.mock.calls[0];
      const registerMeta = registerCall?.[2] as {
        readonly idempotencyKey: string;
        readonly requestHash: string;
        readonly requestId: string;
        readonly traceId: string;
        readonly auditId: string;
      };
      expect(registerCall?.[1]).toEqual(REGISTER_REQUEST);
      expect(registerMeta.idempotencyKey).toBe("idem-register-001");
      expect(registerMeta.requestHash).toBe(
        canonicalControlHash({
          domain: "request",
          schemaVersion: CONTROL_SCHEMA_VERSION,
          payload: {
            action: "packages.register",
            management_tenant_id: ADMIN_TENANT,
            actor_ref: "actor-admin",
            request: REGISTER_REQUEST,
          },
        }).hash,
      );
      expect(registerMeta.requestId).toMatch(/^req-[a-f0-9]{16}-[a-f0-9]{32}$/u);
      expect(registerMeta.traceId).toMatch(/^trace-[a-f0-9]{16}-[a-f0-9]{32}$/u);
      expect(registerMeta.auditId).toMatch(/^audit-[a-f0-9]{16}-[a-f0-9]{32}$/u);

      const previewCall = servicePreview.mock.calls[0];
      const previewMeta = previewCall?.[2] as { readonly idempotencyKey: string };
      expect(previewCall?.[1]).toEqual(PREVIEW_REQUEST);
      expect(previewMeta.idempotencyKey).toBe("idem-preview-001");
    } finally {
      await close(server);
    }
  });

  it("dispatches approval, publish, and reconcile with server-owned metadata and hashes", async () => {
    const { server, url } = await listen("fixtures");
    try {
      const approvalResponse = await postJson(
        url,
        "/admin/api/v1/control/approvals",
        APPROVAL_REQUEST,
        { idempotencyKey: "idem-approval-001" },
      );
      const publishResponse = await postJson(
        url,
        "/admin/api/v1/control/deployments/publish",
        PUBLISH_REQUEST,
        { idempotencyKey: "idem-publish-001" },
      );
      const reconcileResponse = await postJson(
        url,
        "/admin/api/v1/control/deployments/reconcile",
        RECONCILE_REQUEST,
        { idempotencyKey: "idem-reconcile-001" },
      );

      expect(approvalResponse.status).toBe(200);
      expect(publishResponse.status).toBe(201);
      expect(reconcileResponse.status).toBe(200);
      expect(serviceApproval).toHaveBeenCalledTimes(1);
      expect(servicePublish).toHaveBeenCalledTimes(1);
      expect(serviceReconcile).toHaveBeenCalledTimes(1);

      const approvalCall = serviceApproval.mock.calls[0];
      const approvalMeta = approvalCall?.[2] as {
        readonly idempotencyKey: string;
        readonly requestHash: string;
        readonly requestId: string;
        readonly traceId: string;
        readonly auditId: string;
      };
      expect(approvalCall?.[1]).toEqual(APPROVAL_REQUEST);
      expect(approvalMeta.idempotencyKey).toBe("idem-approval-001");
      expect(approvalMeta.requestHash).toBe(
        canonicalControlHash({
          domain: "request",
          schemaVersion: CONTROL_SCHEMA_VERSION,
          payload: {
            action: "approvals.decide",
            management_tenant_id: ADMIN_TENANT,
            actor_ref: "actor-admin",
            request: APPROVAL_REQUEST,
          },
        }).hash,
      );
      expect(approvalMeta.requestId).toMatch(/^req-[a-f0-9]{16}-[a-f0-9]{32}$/u);
      expect(approvalMeta.traceId).toMatch(/^trace-[a-f0-9]{16}-[a-f0-9]{32}$/u);
      expect(approvalMeta.auditId).toMatch(/^audit-[a-f0-9]{16}-[a-f0-9]{32}$/u);

      const publishCall = servicePublish.mock.calls[0];
      const publishMeta = publishCall?.[2] as {
        readonly idempotencyKey: string;
        readonly requestHash: string;
      };
      expect(publishCall?.[1]).toEqual(PUBLISH_REQUEST);
      expect(publishMeta.idempotencyKey).toBe("idem-publish-001");
      expect(publishMeta.requestHash).toBe(
        canonicalControlHash({
          domain: "request",
          schemaVersion: CONTROL_SCHEMA_VERSION,
          payload: {
            action: "deployments.publish",
            management_tenant_id: ADMIN_TENANT,
            actor_ref: "actor-admin",
            request: PUBLISH_REQUEST,
          },
        }).hash,
      );

      const reconcileCall = serviceReconcile.mock.calls[0];
      const reconcileMeta = reconcileCall?.[2] as {
        readonly idempotencyKey: string;
        readonly requestHash: string;
      };
      expect(reconcileCall?.[1]).toEqual(RECONCILE_REQUEST);
      expect(reconcileMeta.idempotencyKey).toBe("idem-reconcile-001");
      expect(reconcileMeta.requestHash).toBe(
        canonicalControlHash({
          domain: "request",
          schemaVersion: CONTROL_SCHEMA_VERSION,
          payload: {
            action: "deployments.reconcile",
            management_tenant_id: ADMIN_TENANT,
            actor_ref: "actor-admin",
            request: RECONCILE_REQUEST,
          },
        }).hash,
      );
    } finally {
      await close(server);
    }
  });

  it("applies the strict schema to approval, publish, and reconcile bodies", async () => {
    const { server, url } = await listen("fixtures");
    try {
      const cases = [
        {
          path: "/admin/api/v1/control/approvals",
          body: { ...APPROVAL_REQUEST, actor_id: "client-actor" },
          key: "idem-strict-approval-001",
        },
        {
          path: "/admin/api/v1/control/deployments/publish",
          body: { ...PUBLISH_REQUEST, tenant_id: ADMIN_TENANT },
          key: "idem-strict-publish-001",
        },
        {
          path: "/admin/api/v1/control/deployments/reconcile",
          body: { ...RECONCILE_REQUEST, secret: "not-accepted" },
          key: "idem-strict-reconcile-001",
        },
      ] as const;

      for (const testCase of cases) {
        const response = await postJson(url, testCase.path, testCase.body, {
          idempotencyKey: testCase.key,
        });
        expect(response.status).toBe(400);
        expectSecurityHeaders(response.headers);
        expectNoServiceCalls();
      }
    } finally {
      await close(server);
    }
  });

  it.each([
    ["success", "success", 201],
    ["needs_input", "needs_input", 400],
    ["blocked", "blocked", 403],
    ["manual_review", "manual_review", 409],
    ["unavailable", "unavailable", 503],
  ] as const)("maps service status %s to HTTP %s", async (_label, status, expectedStatus) => {
    const { server, url } = await listen("fixtures");
    try {
      serviceRegister.mockImplementationOnce(() =>
        Promise.resolve({ ...VALID_ENVELOPE, status }),
      );
      const response = await postJson(
        url,
        "/admin/api/v1/control/packages/register",
        REGISTER_REQUEST,
        { idempotencyKey: `idem-status-${status}-001` },
      );

      expect(response.status).toBe(expectedStatus);
      expectSecurityHeaders(response.headers);
    } finally {
      await close(server);
    }
  });

  it.each([
    "/admin/api/v1/control/packages/register",
    "/admin/api/v1/control/deployments/preview",
    "/admin/api/v1/control/approvals",
    "/admin/api/v1/control/deployments/publish",
    "/admin/api/v1/control/deployments/reconcile",
  ] as const)("blocks production POST %s before authenticator", async (path) => {
    const { server, url } = await listen("production");
    try {
      const response = await rawRequest(url, path, { body: "{}" });
      expect(response.status).toBe(403);
      expectRawSecurityHeaders(response.headers);
      expect(response.body).toContain("admin_control_production_disabled_v1");
      expect(authenticate).not.toHaveBeenCalled();
      expectNoServiceCalls();
    } finally {
      await close(server);
    }
  });

  it.each([
    ["missing content type", { contentType: undefined }, 400],
    ["wrong content type", { contentType: "text/plain" }, 400],
    ["missing bearer", { authorization: undefined }, 401],
    ["missing idempotency key", { idempotencyKey: undefined }, 400],
  ] as const)("rejects register before service for %s", async (_label, requestOptions, expectedStatus) => {
    const { server, url } = await listen("fixtures");
    try {
      const response = await postJson(
        url,
        "/admin/api/v1/control/packages/register",
        REGISTER_REQUEST,
        requestOptions,
      );
      expect(response.status).toBe(expectedStatus);
      expect(serviceRegister).not.toHaveBeenCalled();
      expect(servicePreview).not.toHaveBeenCalled();
      if (expectedStatus === 401) {
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
      }
    } finally {
      await close(server);
    }
  });

  it("rejects declared and streamed bodies above the injected maximum before authentication", async () => {
    const { server, url } = await listen("fixtures", 128);
    try {
      const declared = await postJson(
        url,
        "/admin/api/v1/control/packages/register",
        REGISTER_REQUEST,
        { rawBody: "x".repeat(129) },
      );
      expect(declared.status).toBe(413);
      expect(authenticate).not.toHaveBeenCalled();
      expect(serviceRegister).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }

    const streamed = await listen("fixtures", 128);
    try {
      const status = await postChunked(
        streamed.url,
        "/admin/api/v1/control/packages/register",
        "x".repeat(129),
      );
      expect(status).toBe(413);
      expect(authenticate).not.toHaveBeenCalled();
      expect(serviceRegister).not.toHaveBeenCalled();
    } finally {
      await close(streamed.server);
    }
  });

  it("rejects non-admin context and strict identity fields before service", async () => {
    const { server, url } = await listen("fixtures");
    try {
      authClaims = { ...validClaims(), actor_role: "sales", roles: ["sales", "admin"] };
      const nonAdmin = await postJson(
        url,
        "/admin/api/v1/control/packages/register",
        REGISTER_REQUEST,
        { idempotencyKey: "idem-non-admin-001" },
      );
      expect(nonAdmin.status).toBe(403);
      expect(serviceRegister).not.toHaveBeenCalled();

      authClaims = validClaims();
      const withIdentity = await postJson(
        url,
        "/admin/api/v1/control/deployments/preview",
        { ...PREVIEW_REQUEST, tenant_id: ADMIN_TENANT, request_id: "client-request" },
        { idempotencyKey: "idem-identity-001" },
      );
      expect(withIdentity.status).toBe(400);
      expect(servicePreview).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("rejects a remote address before authenticator and service", () => {
    const api = handler("fixtures", "127.0.0.1:1", "http://127.0.0.1:1");
    const captured = directResponse();

    expect(api.handle(directRequest("203.0.113.10"), captured.response)).toBe(true);
    expect(captured.response.statusCode).toBe(403);
    expect(captured.getBody()).not.toContain("203.0.113.10");
    expect(authenticate).not.toHaveBeenCalled();
    expectNoServiceCalls();
  });

  it.each([
    {
      label: "host",
      options: { headers: { host: "evil.example" } },
      expectedStatus: 403,
      expectedAuthCalls: 0,
    },
    {
      label: "origin",
      options: { headers: { origin: "http://evil.example" } },
      expectedStatus: 403,
      expectedAuthCalls: 0,
    },
    {
      label: "duplicate origin",
      options: { headers: { origin: ["http://evil.example", "http://evil.example"] } },
      expectedStatus: 403,
      expectedAuthCalls: 0,
    },
    {
      label: "missing exact origin",
      options: { omitHeaders: ["origin"] },
      expectedStatus: 403,
      expectedAuthCalls: 0,
    },
    {
      label: "production fixed block",
      dataMode: "production",
      options: {},
      expectedStatus: 403,
      expectedAuthCalls: 0,
    },
    {
      label: "missing content type",
      options: { omitHeaders: ["content-type"] },
      expectedStatus: 400,
      expectedAuthCalls: 0,
    },
    {
      label: "wrong content type",
      options: { headers: { "content-type": "text/plain" } },
      expectedStatus: 400,
      expectedAuthCalls: 0,
    },
    {
      label: "missing bearer",
      options: { omitHeaders: ["authorization"] },
      expectedStatus: 401,
      expectedAuthCalls: 0,
    },
    {
      label: "duplicate bearer",
      options: { headers: { authorization: ["Bearer one", "Bearer two"] } },
      expectedStatus: 401,
      expectedAuthCalls: 0,
    },
    {
      label: "invalid bearer scheme",
      options: { headers: { authorization: "Basic fixture-token" } },
      expectedStatus: 401,
      expectedAuthCalls: 0,
    },
    {
      label: "expired claims",
      setup: () => {
        authClaims = { ...validClaims(), expires_at: 0 };
      },
      options: {},
      expectedStatus: 401,
      expectedAuthCalls: 1,
    },
    {
      label: "bad fixture claims",
      setup: () => {
        authClaims = { ...validClaims(), actor_id: "not valid" };
      },
      options: {},
      expectedStatus: 401,
      expectedAuthCalls: 1,
    },
    {
      label: "active role is not admin even when roles contains admin",
      setup: () => {
        authClaims = { ...validClaims(), actor_role: "sales", roles: ["sales", "admin"] };
      },
      options: {},
      expectedStatus: 403,
      expectedAuthCalls: 1,
    },
    {
      label: "missing admin scope",
      setup: () => {
        authClaims = { ...validClaims(), scopes: [] };
      },
      options: {},
      expectedStatus: 403,
      expectedAuthCalls: 1,
    },
    {
      label: "tenant mismatch",
      setup: () => {
        authClaims = { ...validClaims(), tenant_id: "tenant-other" };
      },
      options: {},
      expectedStatus: 403,
      expectedAuthCalls: 1,
    },
    {
      label: "missing idempotency",
      options: { omitHeaders: ["idempotency-key"] },
      expectedStatus: 400,
      expectedAuthCalls: 1,
    },
    {
      label: "invalid idempotency",
      options: { headers: { "idempotency-key": "short" } },
      expectedStatus: 400,
      expectedAuthCalls: 1,
    },
    {
      label: "malformed JSON",
      options: { body: "{malformed" },
      expectedStatus: 400,
      expectedAuthCalls: 1,
    },
    {
      label: "unknown field",
      options: { body: JSON.stringify({ ...REGISTER_REQUEST, unknown_field: true }) },
      expectedStatus: 400,
      expectedAuthCalls: 1,
    },
    {
      label: "identity field",
      options: { body: JSON.stringify({ ...REGISTER_REQUEST, tenant_id: ADMIN_TENANT }) },
      expectedStatus: 400,
      expectedAuthCalls: 1,
    },
    {
      label: "URL field",
      options: { body: JSON.stringify({ ...REGISTER_REQUEST, callback_url: "https://secret.example" }) },
      expectedStatus: 400,
      expectedAuthCalls: 1,
    },
    {
      label: "path field",
      options: { body: JSON.stringify({ ...REGISTER_REQUEST, file_path: "/secret/path" }) },
      expectedStatus: 400,
      expectedAuthCalls: 1,
    },
    {
      label: "secret field",
      options: { body: JSON.stringify({ ...REGISTER_REQUEST, token: "secret-token" }) },
      expectedStatus: 400,
      expectedAuthCalls: 1,
    },
    {
      label: "query auth",
      path: "/admin/api/v1/control/packages/register?token=secret-token",
      options: {},
      expectedStatus: 401,
      expectedAuthCalls: 0,
    },
    {
      label: "query auth without equals",
      path: "/admin/api/v1/control/packages/register?token",
      options: {},
      expectedStatus: 401,
      expectedAuthCalls: 0,
    },
    {
      label: "cookie auth",
      options: { headers: { cookie: "session=secret-token" } },
      expectedStatus: 401,
      expectedAuthCalls: 0,
    },
    {
      label: "unknown route",
      path: "/admin/api/v1/control/unknown",
      options: {},
      expectedStatus: 404,
      expectedAuthCalls: 0,
    },
    {
      label: "wrong method",
      method: "GET",
      options: {},
      expectedStatus: 405,
      expectedAuthCalls: 0,
      expectedAllow: "POST",
    },
  ] as const)("security rejects %s in order", async (testCase) => {
    testCase.setup?.();
    const { server, url } = await listen(testCase.dataMode ?? "fixtures");
    try {
      const response = await rawRequest(
        url,
        testCase.path ?? "/admin/api/v1/control/packages/register",
        {
          method: testCase.method ?? "POST",
          ...testCase.options,
        },
      );

      expect(response.status).toBe(testCase.expectedStatus);
      expectRawSecurityHeaders(response.headers);
      expect(response.body).not.toContain("secret-token");
      expect(response.body).not.toContain("not valid");
      expect(authenticate).toHaveBeenCalledTimes(testCase.expectedAuthCalls);
      expectNoServiceCalls();
      if (testCase.expectedStatus === 401) {
        expect(response.headers["www-authenticate"]).toBe("Bearer");
      }
      if (testCase.expectedAllow !== undefined) {
        expect(response.headers.allow).toBe(testCase.expectedAllow);
      }
    } finally {
      await close(server);
    }
  });

  it.each([
    "/admin/api/v1/control/packages/register",
    "/admin/api/v1/control/deployments/preview",
    "/admin/api/v1/control/approvals",
    "/admin/api/v1/control/deployments/publish",
    "/admin/api/v1/control/deployments/reconcile",
  ] as const)("rejects streamed body over limit before auth for %s", async (path) => {
    const { server, url } = await listen("fixtures", 128);
    try {
      const response = await rawRequest(url, path, {
        chunks: ["x".repeat(64), "x".repeat(65)],
      });
      expect(response.status).toBe(413);
      expectRawSecurityHeaders(response.headers);
      expect(authenticate).not.toHaveBeenCalled();
      expectNoServiceCalls();
    } finally {
      await close(server);
    }
  });

  it("rejects declared body over limit before auth for every supported write", async () => {
    const paths = [
      "/admin/api/v1/control/packages/register",
      "/admin/api/v1/control/deployments/preview",
      "/admin/api/v1/control/approvals",
      "/admin/api/v1/control/deployments/publish",
      "/admin/api/v1/control/deployments/reconcile",
    ] as const;
    for (const path of paths) {
      const { server, url } = await listen("fixtures", 128);
      try {
        const response = await rawRequest(url, path, {
          headers: { "content-length": "129" },
          body: "x".repeat(129),
        });
        expect(response.status).toBe(413);
        expectRawSecurityHeaders(response.headers);
        expect(authenticate).not.toHaveBeenCalled();
        expectNoServiceCalls();
      } finally {
        await close(server);
      }
    }
  });

  it("redacts authenticator and service errors", async () => {
    const { server, url } = await listen("fixtures");
    try {
      authenticate.mockImplementationOnce(() => {
        throw new Error("secret-token SQL stack details");
      });
      const authFailure = await postJson(
        url,
        "/admin/api/v1/control/packages/register",
        REGISTER_REQUEST,
        { idempotencyKey: "idem-redact-auth-001" },
      );
      const authText = await authFailure.text();
      expect(authFailure.status).toBe(401);
      expect(authText).not.toContain("secret-token");
      expect(authText).not.toContain("SQL");
      expect(authText).not.toContain("stack details");
      expectSecurityHeaders(authFailure.headers);

      serviceRegister.mockImplementationOnce(() => {
        throw new Error("secret-token SQL stack details");
      });
      const serviceFailure = await postJson(
        url,
        "/admin/api/v1/control/packages/register",
        REGISTER_REQUEST,
        { idempotencyKey: "idem-redact-service-001" },
      );
      const serviceText = await serviceFailure.text();
      expect(serviceFailure.status).toBe(503);
      expect(serviceText).not.toContain("secret-token");
      expect(serviceText).not.toContain("SQL");
      expect(serviceText).not.toContain("stack details");
      expectSecurityHeaders(serviceFailure.headers);
      expect(servicePreview).not.toHaveBeenCalled();
      expect(serviceApproval).not.toHaveBeenCalled();
      expect(servicePublish).not.toHaveBeenCalled();
      expect(serviceReconcile).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});
