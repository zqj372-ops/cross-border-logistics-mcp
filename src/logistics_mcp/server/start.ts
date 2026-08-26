import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { AuthenticationError, type AuthClaims } from "../platform/context";
import { getToolPolicy } from "../platform/rbac";
import { SqliteProductionStore } from "../platform/sqlite-production-store";
import {
  createFixtureComposition,
  createProductionApiAdapterSource,
  createProductionComposition,
  type GatewayComposition,
} from "./composition";
import type { ShortLivedTokenValidationOptions } from "../platform/security";
import {
  createAdminStaticHandler,
  type AdminStaticHandler,
} from "./admin-static";
import { createProductionTokenVerifier } from "./production-token-verifier";
import { FreightcomRateAdapter } from "../adapters/quote/freightcom-rate-adapter";
import { DEFAULT_FREIGHTCOM_TEST_BASE_URL } from "../adapters/quote/freightcom-test-client";
import type { FreightcomRatePort } from "../adapters/ports";

const PORT = Number.parseInt(process.env.MCP_PORT ?? "8080", 10);
const RUNTIME_MAX_BODY_BYTES = 32 * 1024;
const RUNTIME_REQUEST_TIMEOUT_MS = 30_000;
const RUNTIME_HEADERS_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

class RuntimeBodyTooLargeError extends Error {}
class RuntimeRequestError extends Error {}

function splitSetting(name: string, fallback: string): string[] {
  const value = process.env[name] ?? fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(serialized);
}

async function readiness(
  composition: GatewayComposition,
): Promise<{ readonly ready: boolean; readonly reasons: readonly string[] }> {
  const dataMode = process.env.MCP_DATA_MODE ?? "production";
  const required = dataMode === "production"
    ? [
        "MCP_JWT_ISSUER",
        "MCP_JWT_AUDIENCE",
        "MCP_JWKS_URL",
        "MCP_STATE_DB_PATH",
        "MCP_INSTANCE_ID",
        "MCP_ALLOWED_ORIGINS",
        "MCP_ALLOWED_HOSTS",
        "MCP_ALLOWED_OUTBOUND_HOSTS",
        "MCP_TRUSTED_PROXY_ADDRESSES",
        "MCP_DATA_MODE",
      ]
    : ["MCP_DATA_MODE"];
  const missing = required.filter((name) => (process.env[name] ?? "").trim() === "");
  const reasons = [...missing.map((name) => `missing_${name.toLowerCase()}`)];
  if (dataMode !== "production") reasons.push("fixture_mode_not_production_ready");
  const compositionState = await composition.readiness();
  reasons.push(...compositionState.reasons);
  const uniqueReasons = [...new Set(reasons)];
  return { ready: uniqueReasons.length === 0, reasons: uniqueReasons };
}

const ROLE_PRESENTATION = {
  admin: ["管理员", "管理平台授权和审计边界。"],
  sales: ["销售", "补充询价信息并查看受控结果。"],
  operator: ["运营", "核对货物、装柜和任务状态。"],
  customs_reviewer: ["关务审核", "审核关务候选和风险信息。"],
  finance: ["财务", "查看计费口径和税费结果。"],
  viewer: ["查看者", "查看已授权的结构化结果。"],
  service: ["后台服务", "以最小权限调用确定性工具。"],
} as const;

const LOCAL_TOOL_NAMES = new Set<string>([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
]);

function adminBlocker(reason: string): string {
  if (reason === "fixture_mode_not_production_ready") {
    return "当前为演示环境，不能作为正式发布依据。";
  }
  if (reason.startsWith("missing_") || reason.includes("allowed_")) {
    return "正式运行配置不完整，具体字段已隐藏。";
  }
  if (reason.includes("token") || reason.includes("jwks")) {
    return "身份验证依赖尚未通过就绪检查。";
  }
  if (
    reason.includes("audit") ||
    reason.includes("idempotency") ||
    reason.includes("session") ||
    reason.includes("platform")
  ) {
    return "审计、幂等或会话持久化依赖尚未通过就绪检查。";
  }
  if (reason.includes("adapter")) {
    return "业务接口适配层尚未通过就绪检查。";
  }
  return "存在未通过的运行门槛，技术信息已隐藏。";
}

function businessSources(mode: GatewayComposition["mode"]): readonly Record<string, unknown>[] {
  const fixture = mode === "fixtures";
  const common = {
    category: "business_api",
    type: "外部业务接口",
    environment: fixture ? "演示环境" : "正式环境",
    update_mode: "每次请求直接读取，不在平台保存业务数据。",
    last_checked_at: null,
    last_success_at: null,
    readiness: fixture ? "manual_review" : "unavailable",
    reason: fixture
      ? "当前使用演示替身验证流程，不代表外部接口已经连接。"
      : "正式业务接口尚未注入运行组合，相关工具保持不可用。",
  } as const;
  return [
    {
      ...common,
      name: "ai_quote_api",
      label: "智能报价服务",
      business_key: "quote",
      affected_tools: ["quote.canada_final_mile.calculate"],
      registration_status: "工具已登记，正式接口未启用",
      business_version_evidence: "尚未取得完整的规则版本、数据版本和生效期证据。",
      blocker: "上游只读边界、货物体积与始发地映射、响应版本证据仍待确认。",
    },
    {
      ...common,
      name: "riskcustoms_api",
      label: "关务查询服务",
      business_key: "customs",
      affected_tools: ["customs.ca.search", "customs.ca.estimate"],
      registration_status: "查询工具已登记，正式接口未启用",
      business_version_evidence: "发布版本和数据就绪证据必须来自真实查询响应。",
      blocker: "正式认证、租户映射和发布状态读回仍待适配验证；现有接口不提供正式税额估算。",
    },
    {
      ...common,
      name: "freightcom_test_api",
      label: "Freightcom LTL 测试询价",
      business_key: "quote.freightcom_ltl",
      affected_tools: ["quote.freightcom_ltl.preview"],
      environment: fixture ? "测试/演示环境" : "正式环境",
      readiness: fixture && process.env.MCP_FREIGHTCOM_TEST_ENABLED === "true" ? "manual_review" : "unavailable",
      registration_status: "MCP 工具已登记；真实调用仅允许固定测试环境",
      business_version_evidence: "Freightcom Customer API 2.10.0；测试结果不可提升为正式报价。",
      reason: fixture
        ? "测试调用需要显式启用，并且结果始终要求人工复核。"
        : "生产 Freightcom 调用被代码级禁用。",
      blocker: fixture
        ? "测试响应缺少正式发布、租户快照和生产有效性证据，必须人工复核。"
        : "生产 Freightcom 调用被代码级禁用。",
    },
    {
      ...common,
      name: "pdf_api",
      label: "报价单服务",
      business_key: "pdf",
      affected_tools: [],
      registration_status: "未登记工具",
      business_version_evidence: "尚未提供可核验的服务端接口约定。",
      blocker: "缺少服务端接口地址、身份认证、输入输出和文件读回约定。",
    },
  ];
}

async function adminRuntimeSnapshot(
  composition: GatewayComposition,
): Promise<Readonly<Record<string, unknown>>> {
  const state = await readiness(composition);
  const fixture = composition.mode === "fixtures";
  const blockers = [...new Set(state.reasons.map(adminBlocker))];
  return {
    schema_version: "2026-08-11.v1",
    environment: fixture ? "演示环境" : "正式环境",
    tenant: { name: "服务级只读状态（未绑定租户）" },
    actor: { name: "未绑定具体用户" },
    config: { current_version: null, last_published_at: null },
    health: {
      healthz: {
        status: "ready",
        value: "服务在线",
        detail: "只说明进程存活，不代表业务接口可用。",
      },
      readyz: {
        status: state.ready ? "ready" : "blocked",
        value: state.ready ? "平台依赖已就绪" : "未满足正式发布门槛",
        detail: state.ready
          ? "平台身份、审计、幂等和会话依赖已通过检查。"
          : "具体技术字段已隐藏，请由管理员检查部署配置。",
      },
    },
    blockers,
    clients: [],
    roles: Object.entries(ROLE_PRESENTATION).map(([key, [label, description]]) => ({
      key,
      label,
      description,
    })),
    tools: composition.definitions.map((definition) => ({
      name: definition.name,
      label: definition.title,
      description: definition.description,
      kind: definition.kind,
      roles: [...getToolPolicy(definition.name).roles],
      availability:
        fixture || (state.ready && LOCAL_TOOL_NAMES.has(definition.name))
          ? "ready"
          : "unavailable",
    })),
    sources: businessSources(composition.mode),
    approvals: {
      validation: {
        status: "blocked",
        summary: "当前后台只读，不提供保存、发布或回滚操作。",
      },
      changes: [],
      chain: [],
    },
    audit: [],
    status_legend: [
      { key: "ready", label: "已就绪", detail: "当前检查通过。" },
      { key: "unavailable", label: "不可用", detail: "所需来源当前不能使用。" },
      { key: "blocked", label: "已阻断", detail: "安全或发布门槛禁止继续。" },
      { key: "manual_review", label: "人工复核", detail: "只能用于流程核验，不能作为正式结果。" },
    ],
  };
}

function tokenPolicyFromEnvironment(): ShortLivedTokenValidationOptions | undefined {
  const issuer = process.env.MCP_JWT_ISSUER?.trim();
  const audience = process.env.MCP_JWT_AUDIENCE?.trim();
  if (
    issuer === undefined ||
    issuer.length === 0 ||
    audience === undefined ||
    audience.length === 0
  ) {
    return undefined;
  }
  return { issuer, audience };
}

function fixtureAuthenticatorFromEnvironment(): (token: string) => AuthClaims {
  const expectedToken = process.env.MCP_FIXTURE_TOKEN?.trim();
  if (expectedToken === undefined || expectedToken.length === 0) {
    throw new Error("MCP_FIXTURE_TOKEN must be explicitly set in fixtures mode.");
  }
  return (token) => {
    if (token !== expectedToken) throw new AuthenticationError();
    return {
      tenant_id: "tenant_fixture",
      actor_id: "local_operator",
      actor_role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin"],
      client_id: "local_fixture_client",
      session_id: "local_fixture_auth",
      expires_at: Math.floor(Date.now() / 1000) + 15 * 60,
    };
  };
}

export type FreightcomKeychainReader = (
  account: string,
  service: string,
) => Promise<string>;

async function readFreightcomKeychainSecret(
  account: string,
  service: string,
): Promise<string> {
  const helper = resolve(
    homedir(),
    "Library",
    "Application Support",
    "Codex",
    "Freightcom",
    "freightcom-keychain-helper-v1",
  );
  const result = await execFileAsync(
    helper,
    ["read", account, service],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 4_096 },
  );
  const token = result.stdout.trim();
  if (token.length === 0) throw new Error("Freightcom test credential is empty.");
  return token;
}

export function createFreightcomTestAdapterFromEnvironment(
  readSecret: FreightcomKeychainReader = readFreightcomKeychainSecret,
): FreightcomRatePort | undefined {
  const setting = process.env.MCP_FREIGHTCOM_TEST_ENABLED?.trim();
  if (setting === undefined || setting === "" || setting === "false") return undefined;
  if (setting !== "true") {
    throw new Error("MCP_FREIGHTCOM_TEST_ENABLED must be true or false.");
  }
  const account = (
    process.env.FREIGHTCOM_TEST_KEYCHAIN_ACCOUNT ?? "JHT LOGISTICS CO., LTD."
  ).trim();
  const service = (
    process.env.FREIGHTCOM_TEST_KEYCHAIN_SERVICE ?? "freightcom-api-test-mcp-v1"
  ).trim();
  if (account.length === 0 || service.length === 0) {
    throw new Error("Freightcom Keychain account and service must be configured.");
  }
  return new FreightcomRateAdapter({
    mode: "test",
    baseUrl: DEFAULT_FREIGHTCOM_TEST_BASE_URL,
    allowedHosts: ["customer-external-api.ssd-test.freightcom.com"],
    headerProvider: async (signal) => {
      if (signal.aborted) throw new Error("Freightcom credential request was aborted.");
      const token = (await readSecret(account, service)).trim();
      if (token.length === 0) throw new Error("Freightcom test credential is empty.");
      return { Authorization: token };
    },
    maxPollAttempts: 12,
    pollDelayMs: 750,
    timeoutMs: 20_000,
    maxResponseBytes: 2 * 1024 * 1024,
  });
}

async function toRequest(
  request: IncomingMessage,
  allowLoopbackHttp = false,
  trustedProxy: (address: string | undefined) => boolean = () => false,
): Promise<Request> {
  const contentLength = request.headers["content-length"];
  if (Array.isArray(contentLength)) {
    throw new RuntimeRequestError("Invalid content length.");
  }
  if (contentLength !== undefined) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new RuntimeRequestError("Invalid content length.");
    }
    if (declaredLength > RUNTIME_MAX_BODY_BYTES) {
      throw new RuntimeBodyTooLargeError();
    }
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (typeof value === "string") {
      const bytes = new TextEncoder().encode(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > RUNTIME_MAX_BODY_BYTES) throw new RuntimeBodyTooLargeError();
      chunks.push(bytes);
    } else if (value instanceof Uint8Array) {
      totalBytes += value.byteLength;
      if (totalBytes > RUNTIME_MAX_BODY_BYTES) throw new RuntimeBodyTooLargeError();
      chunks.push(value);
    } else {
      throw new TypeError("The request body chunk is not a byte sequence.");
    }
  }
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(name, value.join(","));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const localAddress = request.socket.localAddress;
  const loopbackFixture =
    allowLoopbackHttp &&
    (localAddress === "127.0.0.1" ||
      localAddress === "::1" ||
      localAddress === "::ffff:127.0.0.1");
  const host = headers.get("host") ?? "mcp.example.invalid";
  if (loopbackFixture && headers.get("origin") === null) {
    headers.set("origin", `http://${host}`);
  }
  const forwardedProto = loopbackFixture ||
    (headers.get("x-forwarded-proto") === "https" && trustedProxy(request.socket.remoteAddress))
    ? "https"
    : "http";
  return new Request(`${forwardedProto}://${host}${request.url ?? "/mcp"}`, {
    method: request.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function forward(response: Response, nodeResponse: ServerResponse): Promise<void> {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, name) => nodeResponse.setHeader(name, value));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

async function handleRuntimeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  composition: GatewayComposition,
  adminUi: AdminStaticHandler,
  trustedProxy: (address: string | undefined) => boolean,
): Promise<void> {
    if (adminUi.handle(request, response)) return;
    const path = (request.url ?? "/").split("?", 1)[0];
    if (request.method === "GET" && path === "/healthz") {
      json(response, 200, { status: "ok", service: "cross-border-logistics-mcp" });
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      const state = await readiness(composition);
      json(response, state.ready ? 200 : 503, {
        status: state.ready ? "ready" : "not_ready",
        reasons: state.reasons,
      });
      return;
    }
    if (path !== "/mcp") {
      json(response, 404, { status: "blocked", reason: "route_not_found" });
      return;
    }
    try {
      await forward(
        await composition.handler(
          await toRequest(request, composition.mode === "fixtures", trustedProxy),
        ),
        response,
      );
    } catch (error) {
      if (error instanceof RuntimeBodyTooLargeError) {
        json(response, 413, { status: "blocked", reason: "body_too_large" });
        return;
      }
      if (error instanceof RuntimeRequestError) {
        json(response, 400, { status: "blocked", reason: "invalid_request" });
        return;
      }
      json(response, 503, { status: "unavailable", reason: "gateway_unavailable" });
    }
}

export interface RuntimeServerOptions {
  readonly adminUi?: AdminStaticHandler;
  readonly trustedProxyAddresses?: readonly string[];
}

function trustedProxyChecker(entries: readonly string[]): (address: string | undefined) => boolean {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefixText, ...extra] = entry.split("/");
    const family = address === undefined ? 0 : isIP(address);
    if (address === undefined || family === 0 || extra.length > 0) {
      throw new Error("Trusted proxy entries must be IP addresses or CIDR subnets.");
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefixText === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(prefixText);
    if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error("Trusted proxy CIDR prefix is invalid.");
    }
    list.addSubnet(address, prefix, type);
  }
  return (address) => {
    if (address === undefined) return false;
    const family = isIP(address);
    if (family !== 0 && list.check(address, family === 4 ? "ipv4" : "ipv6")) return true;
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    return mapped !== undefined && list.check(mapped, "ipv4");
  };
}

export function createRuntimeServer(
  composition: GatewayComposition,
  options: RuntimeServerOptions = {},
): ReturnType<typeof createServer> {
  const enabledSetting = process.env.MCP_ADMIN_UI_ENABLED;
  const adminUi =
    options.adminUi ??
    createAdminStaticHandler({
      staticDir: resolve(process.cwd(), "dist/admin"),
      ...(enabledSetting === undefined ? {} : { enabledSetting }),
      snapshotProvider: () => adminRuntimeSnapshot(composition),
    });
  const trustedProxy = trustedProxyChecker(
    options.trustedProxyAddresses ?? splitSetting("MCP_TRUSTED_PROXY_ADDRESSES", ""),
  );
  return createServer(
    {
      headersTimeout: RUNTIME_HEADERS_TIMEOUT_MS,
      requestTimeout: RUNTIME_REQUEST_TIMEOUT_MS,
    },
    (request, response) => {
    void handleRuntimeRequest(request, response, composition, adminUi, trustedProxy);
    },
  );
}

export async function closeRuntimeServer(
  server: ReturnType<typeof createServer>,
  composition: GatewayComposition,
): Promise<void> {
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  let failed = false;
  try {
    await composition.close();
  } catch {
    failed = true;
  }
  server.closeAllConnections();
  try {
    await serverClosed;
  } catch {
    failed = true;
  }
  if (failed) {
    throw new Error("The runtime could not close every resource cleanly.");
  }
}

function makeComposition(): GatewayComposition {
  const mode = process.env.MCP_DATA_MODE;
  const common = {
    requestTimeoutMs: RUNTIME_REQUEST_TIMEOUT_MS,
    allowedOrigins: splitSetting(
      "MCP_ALLOWED_ORIGINS",
      mode === "fixtures" ? `http://127.0.0.1:${PORT}` : "",
    ),
    allowedHosts: splitSetting(
      "MCP_ALLOWED_HOSTS",
      mode === "fixtures" ? `127.0.0.1:${PORT}` : "",
    ),
  };
  if (mode === "fixtures") {
    const freightcomRateAdapter = createFreightcomTestAdapterFromEnvironment();
    return createFixtureComposition({
      dataMode: "fixtures",
      ...common,
      authenticate: fixtureAuthenticatorFromEnvironment(),
      ...(freightcomRateAdapter === undefined ? {} : { freightcomRateAdapter }),
    });
  }
  if (mode !== "production") {
    throw new Error("MCP_DATA_MODE must be explicitly set to production or fixtures.");
  }
  const tokenPolicy = tokenPolicyFromEnvironment();
  const databasePath = process.env.MCP_STATE_DB_PATH?.trim();
  const instanceId = process.env.MCP_INSTANCE_ID?.trim();
  const jwksUrl = process.env.MCP_JWKS_URL?.trim();
  const outboundHosts = splitSetting("MCP_ALLOWED_OUTBOUND_HOSTS", "");
  const store =
    databasePath === undefined || databasePath.length === 0
      ? undefined
      : new SqliteProductionStore(databasePath);
  const tokenVerifier =
    tokenPolicy === undefined ||
    jwksUrl === undefined ||
    jwksUrl.length === 0 ||
    outboundHosts.length === 0
      ? undefined
      : createProductionTokenVerifier({
          jwksUrl,
          allowedHosts: outboundHosts,
        });
  return createProductionComposition({
    dataMode: "production",
    ...common,
    adapterSource: createProductionApiAdapterSource(),
    ...(store === undefined
      ? {}
      : {
          auditRepository: store,
          idempotencyRepository: store,
          sessionBindingStore: store,
        }),
    ...(instanceId === undefined || instanceId.length === 0
      ? {}
      : { sessionOwnerId: instanceId }),
    ...(tokenVerifier === undefined ? {} : { tokenVerifier }),
    ...(tokenPolicy === undefined ? {} : { tokenPolicy }),
  });
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isMainModule(): boolean {
  const argumentPath = process.argv[1];
  if (argumentPath === undefined) return false;
  return canonicalPath(argumentPath) === canonicalPath(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const composition = makeComposition();
  const server = createRuntimeServer(composition);
  server.listen(PORT, process.env.MCP_DATA_MODE === "fixtures" ? "127.0.0.1" : "0.0.0.0");
  const shutdown = () => void closeRuntimeServer(server, composition).then(
    () => process.exit(0),
    () => process.exit(1),
  );
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
