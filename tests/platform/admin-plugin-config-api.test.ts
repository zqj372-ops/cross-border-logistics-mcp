import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPluginConfigClient,
  validateConfigState,
} from "../../apps/admin/plugin-config.js";
import {
  configDigestForValues,
  freightcomLtlConfigSpec,
  FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
  PLUGIN_CONFIG_SCHEMA_VERSION,
  type PluginConfigOperationResponse,
  type PluginConfigState,
} from "../../src/logistics_mcp/control-plane/plugin-config-contracts";
import {
  createAdminPluginConfigApiHandler,
  type AdminPluginConfigApiHandler,
  type PluginConfigAdminService,
} from "../../src/logistics_mcp/server/admin-plugin-config-api";

const ADMIN_TENANT = "tenant_fixture";
const BACKEND_DIGEST = configDigestForValues(FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES);
const GENERATION = "freightcom_generation_1_abcdef0123456789";

interface UiStateForTest {
  readonly module_id: string;
  readonly actor_ref: string;
  readonly status: string;
  readonly config_spec: null | Readonly<{
    fields: readonly Readonly<{ field_id: string }>[];
  }>;
  readonly current: Readonly<{ revision: number }>;
  readonly allowed_actions: readonly string[];
}

function claims() {
  return {
    tenant_id: ADMIN_TENANT,
    actor_id: "actor_admin",
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin"],
    client_id: "client_admin",
    session_id: "session_admin",
    expires_at: 2_000_000_000,
  } as const;
}

const freightState: PluginConfigState = {
  schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
  module_id: "freightcom-ltl",
  status: "success",
  config_spec: freightcomLtlConfigSpec,
  current_revision: 0,
  current_config_digest: BACKEND_DIGEST,
  current_module_generation: "freightcom_generation_0_abcdef0123456789",
  current_values: FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
  current_readback: null,
  latest_validation: null,
  latest_preview: null,
  latest_approval: null,
  latest_release: null,
  allowed_actions: ["validate_draft", "create_preview"],
  reason_codes: [],
  events: [],
  events_truncated: false,
};

function unsupported(moduleId: "cargo" | "container" | "agent-access"): PluginConfigState {
  return {
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: moduleId,
    status: "success",
    config_spec: null,
    current_revision: 0,
    current_config_digest: null,
    current_module_generation: null,
    current_values: [],
    current_readback: null,
    latest_validation: null,
    latest_preview: null,
    latest_approval: null,
    latest_release: null,
    allowed_actions: [],
    reason_codes: ["plugin_config_not_supported"],
    events: [],
    events_truncated: false,
  };
}

function operation(
  action: PluginConfigOperationResponse["action"],
  data: NonNullable<PluginConfigOperationResponse["data"]>,
): PluginConfigOperationResponse {
  return {
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    action,
    request_id: `backend_${action}_request`,
    status: "success",
    data,
    reason_codes: [],
    replayed: false,
  };
}

const getState = vi.fn<PluginConfigAdminService["getState"]>((_context, moduleId) => Promise.resolve(
  moduleId === undefined || moduleId === "freightcom-ltl" ? freightState : unsupported(moduleId),
));
const validateDraft = vi.fn<PluginConfigAdminService["validateDraft"]>(() => Promise.resolve(operation(
  "validate_draft",
  {
    kind: "validation",
    validation_id: "validation_api_001",
    module_id: "freightcom-ltl",
    base_revision: 0,
    config_digest: BACKEND_DIGEST,
    values: FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
    restart_policy: "controlled_restart",
    validation_status: "validated",
  },
)));
const createPreview = vi.fn<PluginConfigAdminService["createPreview"]>(() => Promise.resolve(operation(
  "create_preview",
  {
    kind: "preview",
    preview_ref: "preview_api_001",
    module_id: "freightcom-ltl",
    intent: "change",
    base_revision: 0,
    config_digest: BACKEND_DIGEST,
    changed_field_ids: [],
    expires_at: "2026-08-31T00:15:00.000Z",
    restart_policy: "controlled_restart",
  },
)));
const decideApproval = vi.fn<PluginConfigAdminService["decideApproval"]>(() => Promise.resolve(operation(
  "decide_approval",
  {
    kind: "approval",
    approval_id: "approval_api_001",
    preview_ref: "preview_api_001",
    decision: "approve",
    approver_actor_id: "actor_admin",
    decided_at: "2026-08-31T00:01:00.000Z",
  },
)));
const publish = vi.fn<PluginConfigAdminService["publish"]>(() => Promise.resolve(operation(
  "publish",
  {
    kind: "release",
    release_id: "release_api_001",
    revision: 1,
    config_digest: BACKEND_DIGEST,
    release_state: "readback_verified",
    readback: {
      readback_id: "readback_api_001",
      release_id: "release_api_001",
      revision: 1,
      config_digest: BACKEND_DIGEST,
      module_generation: GENERATION,
      status: "verified",
      checked_at: "2026-08-31T00:02:00.000Z",
    },
  },
)));
const reconcile = vi.fn<PluginConfigAdminService["reconcile"]>(() => Promise.resolve(operation(
  "reconcile",
  {
    kind: "reconciliation",
    release_id: "release_api_001",
    revision: 1,
    status: "readback_verified",
    readback: {
      readback_id: "readback_api_002",
      release_id: "release_api_001",
      revision: 1,
      config_digest: BACKEND_DIGEST,
      module_generation: GENERATION,
      status: "verified",
      checked_at: "2026-08-31T00:03:00.000Z",
    },
  },
)));

function service(): PluginConfigAdminService {
  return { getState, validateDraft, createPreview, decideApproval, publish, reconcile };
}

const authenticate = vi.fn(() => claims());

function handler(
  dataMode: "fixtures" | "production",
  host: string,
  origin: string,
  maxBodyBytes = 32 * 1024,
): AdminPluginConfigApiHandler {
  return createAdminPluginConfigApiHandler({
    dataMode,
    service: service(),
    authenticate,
    managementTenantId: ADMIN_TENANT,
    allowedOrigins: [origin],
    allowedHosts: [host],
    allowLoopbackHttp: true,
    maxBodyBytes,
    clock: () => "2026-08-31T00:00:00.000Z",
  });
}

async function listen(
  dataMode: "fixtures" | "production" = "fixtures",
  maxBodyBytes = 32 * 1024,
): Promise<{ readonly server: Server; readonly url: string }> {
  const ref: { current?: AdminPluginConfigApiHandler } = {};
  const server = createServer((request, response) => {
    if (ref.current?.handle(request, response) !== true) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test address.");
  const host = `127.0.0.1:${address.port}`;
  const url = `http://${host}`;
  ref.current = handler(dataMode, host, url, maxBodyBytes);
  return { server, url };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

async function rawRequest(
  url: string,
  path: string,
  options: Readonly<{
    method?: string;
    headers?: Record<string, string | readonly string[]>;
    omit?: readonly string[];
    body?: string;
    chunks?: readonly string[];
  }> = {},
): Promise<RawResponse> {
  const target = new URL(`${url}${path}`);
  const headers: OutgoingHttpHeaders = {
    origin: url,
    authorization: "Bearer fixture-token",
    "content-type": "application/json",
    "idempotency-key": "idempotency_api_test_0001",
  };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name] = typeof value === "string" ? value : [...value];
  }
  for (const name of options.omit ?? []) delete headers[name];
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "POST",
      headers,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body,
      }));
    });
    request.once("error", reject);
    if (options.chunks !== undefined) {
      for (const chunk of options.chunks) request.write(chunk);
      request.end();
    } else request.end(options.body);
  });
}

function expectSecurity(headers: IncomingHttpHeaders): void {
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
}

function resetMocks(): void {
  for (const mock of [getState, validateDraft, createPreview, decideApproval, publish, reconcile, authenticate]) {
    mock.mockClear();
  }
}

afterEach(resetMocks);

describe("Admin plugin configuration API", () => {
  it("serves strict UI state for the selected image-bundled module", async () => {
    const { server, url } = await listen();
    try {
      const freightResponse = await fetch(`${url}/admin/api/v1/config/state`, {
        headers: { authorization: "Bearer fixture-token" },
      });
      expect(freightResponse.status).toBe(200);
      const freight = validateConfigState(
        await freightResponse.json() as unknown,
      ) as UiStateForTest;
      expect(freight).toMatchObject({
        module_id: "freightcom-ltl",
        status: "active_verified",
        current: { revision: 0 },
      });
      expect(freight.actor_ref).toMatch(/^actor_ref_[a-f0-9]{64}$/u);
      expect(freight.config_spec).not.toBeNull();
      expect(freight.config_spec?.fields.map((field) => field.field_id)).toEqual([
        "request_timeout_ms",
        "poll_interval_ms",
        "max_poll_attempts",
        "egress_profile_id",
        "credential_slot_id",
      ]);
      const serialized = JSON.stringify(freight);
      expect(serialized).not.toContain("https://");
      expect(serialized).not.toContain("Authorization");
      expect(serialized).not.toContain("secret-value");
      expect(serialized).not.toContain("actor_admin");

      const cargoResponse = await fetch(`${url}/admin/api/v1/config/state?module_id=cargo`, {
        headers: { authorization: "Bearer fixture-token" },
      });
      const cargo = validateConfigState(
        await cargoResponse.json() as unknown,
      ) as UiStateForTest;
      expect(cargo).toMatchObject({ module_id: "cargo", config_spec: null, allowed_actions: [] });
      expect(getState.mock.calls.map((call) => call[1])).toEqual(["freightcom-ltl", "cargo"]);
    } finally {
      await close(server);
    }
  });

  it("maps all fixed write routes and injects server-owned module and intent", async () => {
    const { server, url } = await listen();
    try {
      const client = createPluginConfigClient({
        basePath: "/admin/api/v1/config",
        fetchImpl: async (input, init) => {
          const relative = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
          const headers = new Headers(init?.headers);
          headers.set("origin", url);
          return fetch(`${url}${relative}`, { ...init, headers });
        },
      });
      client.setToken("fixture-token");
      const draft = {
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        module_id: "freightcom-ltl",
        base_revision: 0,
        values: FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
      } as const;
      await client.validateDraft(draft, "idempotency_validate_api_001");
      const previewResult = await client.createPreview(draft, "idempotency_preview_api_001") as { preview_ref: string };
      await client.decideApproval({
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        preview_ref: previewResult.preview_ref,
        decision: "approve",
        reason_code: "operator_approved",
      }, "idempotency_approval_api_001");
      const published = await client.publish({
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        preview_ref: "preview_api_001",
        approval_id: "approval_api_001",
      }, "idempotency_publish_api_001") as Record<string, unknown>;
      expect(published).toMatchObject({
        kind: "config_release",
        release_id: "release_api_001",
        revision: 1,
        module_generation: GENERATION,
        status: "readback_verified",
      });
      await client.reconcile({
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        release_id: "release_api_001",
      }, "idempotency_reconcile_api_001");

      expect(validateDraft.mock.calls[0]?.[1]).toMatchObject({ module_id: "freightcom-ltl" });
      expect(createPreview.mock.calls[0]?.[1]).toMatchObject({
        module_id: "freightcom-ltl",
        intent: "change",
      });
      expect(decideApproval.mock.calls[0]?.[1]).toMatchObject({ module_id: "freightcom-ltl" });
      expect(publish.mock.calls[0]?.[1]).toMatchObject({ module_id: "freightcom-ltl" });
      expect(reconcile.mock.calls[0]?.[1]).toMatchObject({ module_id: "freightcom-ltl" });
      expect(authenticate).toHaveBeenCalledTimes(5);
    } finally {
      await close(server);
    }
  });

  it("blocks production POST before authentication or service access", async () => {
    const { server, url } = await listen("production");
    try {
      const response = await rawRequest(url, "/admin/api/v1/config/drafts/validate", {
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(403);
      expect(response.body).toContain("plugin_config_production_disabled_v1");
      expectSecurity(response.headers);
      expect(authenticate).not.toHaveBeenCalled();
      expect(validateDraft).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it.each([
    { label: "unknown route", path: "/admin/api/v1/config/unknown", expected: 404 },
    { label: "wrong method", path: "/admin/api/v1/config/drafts/validate", method: "GET", expected: 405 },
    { label: "query credential", path: "/admin/api/v1/config/state?token=leak", method: "GET", expected: 401 },
    { label: "cookie credential", path: "/admin/api/v1/config/state", method: "GET", headers: { cookie: "token=leak" }, expected: 401 },
    { label: "bad module query", path: "/admin/api/v1/config/state?module_id=remote-plugin", method: "GET", expected: 400 },
    { label: "missing content type", path: "/admin/api/v1/config/drafts/validate", omit: ["content-type"], body: "{}", expected: 400 },
    { label: "missing idempotency", path: "/admin/api/v1/config/drafts/validate", omit: ["idempotency-key"], body: "{}", expected: 400 },
    { label: "invalid JSON", path: "/admin/api/v1/config/drafts/validate", body: "{", expected: 400 },
    {
      label: "unknown field",
      path: "/admin/api/v1/config/approvals",
      body: JSON.stringify({
        schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
        preview_ref: "preview_api_001",
        decision: "approve",
        reason_code: "operator_approved",
        endpoint_url: "https://evil.invalid",
      }),
      expected: 400,
    },
  ] as const)("rejects $label without leaking input", async (testCase) => {
    const { server, url } = await listen();
    try {
      const response = await rawRequest(url, testCase.path, {
        ...("method" in testCase && testCase.method !== undefined ? { method: testCase.method } : {}),
        ...("headers" in testCase && testCase.headers !== undefined ? { headers: testCase.headers } : {}),
        ...("omit" in testCase && testCase.omit !== undefined ? { omit: testCase.omit } : {}),
        ...("body" in testCase && testCase.body !== undefined ? { body: testCase.body } : {}),
      });
      expect(response.status).toBe(testCase.expected);
      expectSecurity(response.headers);
      expect(response.body).not.toContain("evil.invalid");
      expect(response.body).not.toContain("token=leak");
      if (response.status === 401) expect(response.headers["www-authenticate"]).toBe("Bearer");
    } finally {
      await close(server);
    }
  });

  it("rejects streamed and declared oversized bodies before auth", async () => {
    const { server, url } = await listen("fixtures", 128);
    try {
      const streamed = await rawRequest(url, "/admin/api/v1/config/drafts/validate", {
        chunks: ["x".repeat(64), "x".repeat(65)],
      });
      expect(streamed.status).toBe(413);
      const declared = await rawRequest(url, "/admin/api/v1/config/drafts/validate", {
        headers: { "content-length": "129" },
        body: "x".repeat(129),
      });
      expect(declared.status).toBe(413);
      expect(authenticate).not.toHaveBeenCalled();
      expect(validateDraft).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("redacts authenticator, service and invalid response details", async () => {
    const { server, url } = await listen();
    try {
      authenticate.mockImplementationOnce(() => {
        throw new Error("secret SQL stack");
      });
      const auth = await rawRequest(url, "/admin/api/v1/config/drafts/validate", { body: "{}" });
      expect(auth.status).toBe(401);
      expect(auth.body).not.toMatch(/secret|SQL|stack/u);

      validateDraft.mockImplementationOnce(() => Promise.reject(new Error("secret SQL stack")));
      const serviceFailure = await rawRequest(url, "/admin/api/v1/config/drafts/validate", {
        body: JSON.stringify({
          schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
          module_id: "freightcom-ltl",
          base_revision: 0,
          values: FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
        }),
      });
      expect(serviceFailure.status).toBe(503);
      expect(serviceFailure.body).not.toMatch(/secret|SQL|stack/u);

      validateDraft.mockImplementationOnce(() => Promise.resolve({ secret: "invalid response" }));
      const invalid = await rawRequest(url, "/admin/api/v1/config/drafts/validate", {
        body: JSON.stringify({
          schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
          module_id: "freightcom-ltl",
          base_revision: 0,
          values: FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
        }),
      });
      expect(invalid.status).toBe(503);
      expect(invalid.body).not.toContain("invalid response");
    } finally {
      await close(server);
    }
  });
});
