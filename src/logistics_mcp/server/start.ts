import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { createModuleInventory } from "../control-plane/inventory";
import {
  createModuleControlRuntimeAssembly,
  type ActivationReadFacade,
  type ControlledDispatchFacade,
  type ModuleControlService,
} from "../control-plane/service";
import type { TrustedModuleInventory } from "../control-plane/types";
import {
  createSqliteControlStoreWithRecovery,
  type SqliteControlStore,
  type SqliteReadbackRecoveryDriver,
} from "../control-plane/sqlite-control-store";
import type {
  ControlFinalResult,
  DeepReadonly,
  ReadbackAttemptRecord,
} from "../control-plane/repository";
import { AuthenticationError, type AuthClaims } from "../platform/context";
import { getToolPolicy } from "../platform/rbac";
import { SqliteProductionStore } from "../platform/sqlite-production-store";
import { CapabilityRegistry, ModuleHost } from "../module-runtime";
import { cargoModule, containerModule, createAgentAccessModule } from "../modules";
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
import {
  createAdminControlApiHandler,
  type AdminControlApiHandler,
} from "./admin-control-api";
import { createProductionTokenVerifier } from "./production-token-verifier";

export { initializeSqliteControlState } from "../control-plane/sqlite-control-store";

const PORT = Number.parseInt(process.env.MCP_PORT ?? "8080", 10);
const RUNTIME_MAX_BODY_BYTES = 32 * 1024;
const RUNTIME_REQUEST_TIMEOUT_MS = 15_000;
const RUNTIME_HEADERS_TIMEOUT_MS = 10_000;
const MANAGED_PATH_SETTINGS = [
  "MCP_APPLICATION_ROOT",
  "MCP_RUNTIME_DIR",
  "MCP_STATE_DIR",
  "MCP_STATE_DB_PATH",
  "MCP_CONTROL_DB_PATH",
  "MCP_CONTROL_MARKER_PATH",
  "MCP_CONTROL_STATE_PATH",
] as const;

type RuntimeListen = (
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
) => Promise<void>;

export interface RuntimeStartOptions {
  /** Explicit only for trusted test/assembly callers; production uses the built entry location. */
  readonly applicationRoot?: string;
  readonly listen?: RuntimeListen;
}

export interface RuntimeStartHandle {
  readonly close: () => Promise<void>;
}

class RuntimeBodyTooLargeError extends Error {}
class RuntimeRequestError extends Error {}

export function applicationRootFromEntry(): string {
  const entryPath = realpathSync(fileURLToPath(import.meta.url));
  const sourceOrDistRoot = resolve(dirname(entryPath), "../../..");
  return basename(sourceOrDistRoot) === "dist"
    ? resolve(sourceOrDistRoot, "..")
    : sourceOrDistRoot;
}

function requiredRuntimeSetting(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for managed runtime startup.`);
  }
  return value;
}

function rejectManagedPathSettings(): void {
  for (const name of MANAGED_PATH_SETTINGS) {
    if (process.env[name] !== undefined) {
      throw new Error(`${name} is not accepted for managed runtime startup.`);
    }
  }
}

export function createFixtureAuthenticatorFromEnvironment(
  managementTenantId: string,
): (token: string) => AuthClaims {
  const applicantToken = requiredRuntimeSetting("MCP_FIXTURE_TOKEN");
  const approverToken = requiredRuntimeSetting("MCP_FIXTURE_APPROVER_TOKEN");
  if (applicantToken === approverToken) {
    throw new Error("Fixture identity tokens must be distinct.");
  }

  return (token) => {
    const identity = token === applicantToken
      ? {
          actor_id: "local_operator",
          client_id: "local_fixture_applicant_client",
          session_id: "local_fixture_applicant_session",
        }
      : token === approverToken
        ? {
            actor_id: "local_approver",
            client_id: "local_fixture_approver_client",
            session_id: "local_fixture_approver_session",
          }
        : undefined;
    if (identity === undefined) throw new AuthenticationError();
    return {
      tenant_id: managementTenantId,
      actor_id: identity.actor_id,
      actor_role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin"],
      client_id: identity.client_id,
      session_id: identity.session_id,
      expires_at: Math.floor(Date.now() / 1000) + 15 * 60,
    };
  };
}

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

interface ManagedFixtureRuntimeConfig {
  readonly applicationRoot: string;
  readonly instanceId: string;
  readonly managementTenantId: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly authenticate: (token: string) => AuthClaims;
}

function managedFixtureRuntimeConfig(applicationRoot: string): ManagedFixtureRuntimeConfig {
  if (process.env.MCP_ADMIN_CONTROL_ENABLED !== "true") {
    throw new Error("MCP_ADMIN_CONTROL_ENABLED must be the literal string true.");
  }
  rejectManagedPathSettings();
  const instanceId = requiredRuntimeSetting("MCP_INSTANCE_ID");
  const managementTenantId = requiredRuntimeSetting("MCP_ADMIN_TENANT_ID");
  const authenticate = createFixtureAuthenticatorFromEnvironment(managementTenantId);
  return {
    applicationRoot,
    instanceId,
    managementTenantId,
    allowedOrigins: splitSetting(
      "MCP_ALLOWED_ORIGINS",
      `http://127.0.0.1:${PORT}`,
    ),
    allowedHosts: splitSetting(
      "MCP_ALLOWED_HOSTS",
      `127.0.0.1:${PORT}`,
    ),
    authenticate,
  };
}

async function createRuntimeInventory(): Promise<TrustedModuleInventory> {
  const agentAccessModule = createAgentAccessModule();
  const modules = [cargoModule, containerModule, agentAccessModule];
  const host = new ModuleHost({
    capabilities: new CapabilityRegistry(),
    modules,
  });
  try {
    host.mountSync();
    return createModuleInventory({
      mountedModules: modules.map((module) => ({
        moduleId: module.manifest.module_id,
        version: module.manifest.version,
        riskLevel: module.manifest.risk_level,
        lifecycle: module.manifest.lifecycle,
        requiredCapabilities: [...module.manifest.required_capabilities],
        optionalCapabilities: [...module.manifest.optional_capabilities],
        standardRefs: [...module.manifest.standard_ids],
      })),
      catalog: host.catalog.list().map((tool) => ({
        owner: tool.module_id,
        name: tool.name,
        permission: tool.permission,
        kind: tool.kind,
        riskLevel: tool.riskLevel,
        inputSchemaId: tool.inputSchemaId,
        outputSchemaId: tool.outputSchemaId,
        standardRefs: [...tool.standardRefs],
      })),
      localEvidence: modules.map((module) => ({
        moduleId: module.manifest.module_id,
        version: module.manifest.version,
        evidenceLevel: "local_build" as const,
        productionEligible: false as const,
        evidenceRefs: {
          sourceShaRef: null,
          artifactDigestRef: null,
          signatureRef: null,
          sbomRef: null,
          attestationRef: null,
        },
      })),
    });
  } finally {
    await host.close();
  }
}

type ManagedActivationRestoreEvidence = Readonly<{
  release: unknown;
  readback: unknown;
  attempt: unknown;
}>;

async function loadManagedActivationRestoreEvidence(
  store: SqliteControlStore,
  managementTenantId: string,
): Promise<ManagedActivationRestoreEvidence | undefined> {
  const unfinished = await store.listUnfinishedReadbackAttempts();
  if (unfinished.length > 0) {
    throw new Error("Pre-listen readback recovery is unavailable through the public assembly.");
  }

  const state = await store.getControlState();
  if (state.managementTenantId !== managementTenantId) {
    throw new Error("Managed control state tenant does not match runtime configuration.");
  }
  const pendingRelease = await store.getPendingRelease();
  const unresolvedRelease = await store.getNewestUnresolvedRelease();
  if (pendingRelease !== null || unresolvedRelease !== null) {
    throw new Error("Pre-listen release recovery is unavailable through the public assembly.");
  }

  if (state.activeRelease === null) {
    if (state.activeRevision !== 0 || state.activeModules.length !== 0) {
      throw new Error("Managed inactive activation state is inconsistent.");
    }
    if (!(await store.health()).ready) {
      throw new Error("Managed control store is not ready after validation.");
    }
    return undefined;
  }

  const activeRelease = await store.getActiveRelease();
  if (
    activeRelease === null ||
    activeRelease.status !== "active_verified" ||
    activeRelease.managementTenantId !== managementTenantId ||
    activeRelease.revision !== state.activeRevision ||
    !isDeepStrictEqual(activeRelease, state.activeRelease) ||
    !isDeepStrictEqual(activeRelease.desiredModules, state.activeModules)
  ) {
    throw new Error("Managed active release evidence is inconsistent.");
  }

  const readback = await store.getReadback({
    managementTenantId,
    releaseId: activeRelease.releaseId,
  });
  if (
    readback === null ||
    readback.status !== "verified" ||
    readback.managementTenantId !== managementTenantId ||
    readback.releaseId !== activeRelease.releaseId ||
    readback.revision !== activeRelease.revision ||
    readback.readbackRef !== activeRelease.readbackRef ||
    typeof readback.attemptId !== "string" ||
    readback.appliedReleaseId !== activeRelease.releaseId ||
    readback.appliedRevision !== activeRelease.revision ||
    readback.reasonCodes.length !== 0 ||
    !isDeepStrictEqual(readback.appliedModules, activeRelease.desiredModules) ||
    !isDeepStrictEqual(readback, state.latestReadback)
  ) {
    throw new Error("Managed active readback evidence is inconsistent.");
  }

  const attempts = await store.getReadbackAttemptHistory({
    managementTenantId,
    releaseId: activeRelease.releaseId,
    revision: activeRelease.revision,
  });
  const matchingAttempts = attempts.filter(
    (attempt) =>
      attempt.attemptId === readback.attemptId &&
      attempt.releaseId === activeRelease.releaseId &&
      attempt.revision === activeRelease.revision &&
      attempt.readbackRef === readback.readbackRef,
  );
  if (matchingAttempts.length !== 1) {
    throw new Error("Managed active readback attempt evidence is ambiguous.");
  }
  const attempt = matchingAttempts[0]!;
  if (
    attempt.phase !== "finalized" ||
    attempt.terminalStatus !== "verified" ||
    attempt.managementTenantId !== managementTenantId ||
    attempt.attemptId !== readback.attemptId ||
    attempt.releaseId !== activeRelease.releaseId ||
    attempt.revision !== activeRelease.revision ||
    attempt.readbackRef !== readback.readbackRef ||
    attempt.appliedReleaseId !== activeRelease.releaseId ||
    attempt.appliedRevision !== activeRelease.revision ||
    attempt.checkedAt !== readback.checkedAt ||
    attempt.reasonCodes.length !== 0 ||
    !isDeepStrictEqual(attempt.desiredModules, activeRelease.desiredModules) ||
    !isDeepStrictEqual(attempt.appliedModules, readback.appliedModules)
  ) {
    throw new Error("Managed active readback attempt evidence is inconsistent.");
  }
  if (!(await store.health()).ready) {
    throw new Error("Managed control store is not ready after validation.");
  }
  return Object.freeze({ release: activeRelease, readback, attempt });
}

function interruptedRecoveryFinalResult(
  attempt: DeepReadonly<ReadbackAttemptRecord>,
): ControlFinalResult {
  return {
    domainRecordRef: attempt.releaseId,
    envelope: {
      schema_version: "2026-08-22.v1",
      request_id: attempt.requestId,
      trace_id: attempt.traceId,
      audit_id: attempt.auditId,
      status: "manual_review",
      data: attempt.action === "deployments.publish"
        ? {
            kind: "release",
            release_id: attempt.releaseId,
            revision: attempt.revision,
            active_modules: attempt.desiredModules.map((module) => ({
              module_id: module.moduleId,
              version: module.version,
              descriptor_digest: module.descriptorDigest,
            })),
          }
        : {
            kind: "reconciliation",
            release_id: attempt.releaseId,
            revision: attempt.revision,
            status: "unknown",
          },
      reason_codes: ["readback.interrupted"],
      readback: {
        status: "unknown",
        release_id: attempt.releaseId,
        revision: attempt.revision,
      },
    },
  };
}

async function recoverPriorBootReadbackAttempts(
  store: SqliteControlStore,
  recoveryDriver: SqliteReadbackRecoveryDriver,
): Promise<void> {
  const unfinished = await store.listUnfinishedReadbackAttempts();
  for (const attempt of unfinished) {
    const checkedAt = new Date().toISOString();
    await recoveryDriver.finalizePriorBootAttempt({
      attemptId: attempt.attemptId,
      observation: {
        status: "unknown",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: ["readback.interrupted"],
        checkedAt,
      },
      finalResult: interruptedRecoveryFinalResult(attempt),
    });
  }

  const remaining = await store.listUnfinishedReadbackAttempts();
  if (remaining.length > 0) {
    throw new Error("Pre-listen readback recovery did not finalize every prior-boot attempt.");
  }
}

interface RuntimeResources {
  readonly composition: GatewayComposition;
  readonly controlStore?: SqliteControlStore;
  readonly adminControlApi?: AdminControlApiHandler;
}

function rejectProductionAdminControlCall(): Promise<never> {
  return Promise.reject(new Error("Production Admin control is disabled."));
}

const PRODUCTION_DISABLED_ADMIN_CONTROL_SERVICE: ModuleControlService =
  Object.freeze({
    getState: rejectProductionAdminControlCall,
    registerPackage: rejectProductionAdminControlCall,
    createDeploymentPreview: rejectProductionAdminControlCall,
    decideApproval: rejectProductionAdminControlCall,
    publish: rejectProductionAdminControlCall,
    reconcile: rejectProductionAdminControlCall,
  });

function createProductionAdminControlApi(): AdminControlApiHandler {
  return createAdminControlApiHandler({
    dataMode: "production",
    service: PRODUCTION_DISABLED_ADMIN_CONTROL_SERVICE,
    authenticate: rejectProductionAdminControlCall,
    managementTenantId: "production_admin_control_disabled",
    allowedOrigins: splitSetting("MCP_ALLOWED_ORIGINS", ""),
    allowedHosts: splitSetting("MCP_ALLOWED_HOSTS", ""),
    allowLoopbackHttp: true,
    maxBodyBytes: RUNTIME_MAX_BODY_BYTES,
    clock: () => new Date().toISOString(),
  });
}

async function createManagedFixtureRuntime(
  applicationRoot: string,
): Promise<RuntimeResources & { readonly controlStore: SqliteControlStore }> {
  const config = managedFixtureRuntimeConfig(applicationRoot);
  const opened = createSqliteControlStoreWithRecovery({
    applicationRoot: config.applicationRoot,
    instanceId: config.instanceId,
    managementTenantId: config.managementTenantId,
    adminControlEnabled: true,
  });
  const controlStore = opened.repository;
  let composition: GatewayComposition | undefined;
  try {
    await recoverPriorBootReadbackAttempts(controlStore, opened.recoveryDriver);
    const activationRestoreEvidence = await loadManagedActivationRestoreEvidence(
      controlStore,
      config.managementTenantId,
    );
    const persistedState = await controlStore.getControlState();
    const inventory = await createRuntimeInventory();
    const assembly = createModuleControlRuntimeAssembly({
      inventory,
      repository: controlStore,
      managementTenantId: config.managementTenantId,
      previewTtlSeconds: 15 * 60,
      clock: () => new Date().toISOString(),
      idGenerator: () => randomUUID(),
      ...(activationRestoreEvidence === undefined
        ? {}
        : { activationRestoreEvidence }),
    });
    const restoredActivation = assembly.activation.snapshot();
    const expectedActivation = {
      releaseId: persistedState.activeRelease?.releaseId ?? null,
      revision: persistedState.activeRevision,
      activeModules: persistedState.activeModules,
    };
    if (!isDeepStrictEqual(restoredActivation, expectedActivation)) {
      throw new Error("Managed activation restore did not match persisted state.");
    }
    composition = makeComposition({
      managementTenantId: config.managementTenantId,
      authenticate: config.authenticate,
      activation: assembly.activation,
      dispatch: assembly.dispatch,
    });
    const adminControlApi = createAdminControlApiHandler({
      dataMode: "fixtures",
      service: assembly.service,
      authenticate: config.authenticate,
      managementTenantId: config.managementTenantId,
      allowedOrigins: config.allowedOrigins,
      allowedHosts: config.allowedHosts,
      allowLoopbackHttp: true,
      maxBodyBytes: RUNTIME_MAX_BODY_BYTES,
      clock: () => new Date().toISOString(),
    });
    return { composition, controlStore, adminControlApi };
  } catch (error) {
    await composition?.close().catch(() => undefined);
    await controlStore.close().catch(() => undefined);
    throw error;
  }
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
  adminControlApi: AdminControlApiHandler | undefined,
  trustedProxy: (address: string | undefined) => boolean,
): Promise<void> {
  if (adminControlApi?.handle(request, response)) return;
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
  readonly adminControlApi?: AdminControlApiHandler;
  readonly applicationRoot?: string;
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
      staticDir: resolve(
        options.applicationRoot ?? applicationRootFromEntry(),
        "dist/admin",
      ),
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
      void handleRuntimeRequest(
        request,
        response,
        composition,
        adminUi,
        options.adminControlApi,
        trustedProxy,
      );
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

function closeOnce(action: () => Promise<void>): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= action();
    return closePromise;
  };
}

async function closeRuntimeResources(
  server: ReturnType<typeof createServer> | undefined,
  resources: RuntimeResources,
): Promise<void> {
  let failed = false;
  try {
    if (server === undefined || !server.listening) {
      await resources.composition.close();
    } else {
      await closeRuntimeServer(server, resources.composition);
    }
  } catch {
    failed = true;
  }
  try {
    await resources.controlStore?.close();
  } catch {
    failed = true;
  }
  if (failed) {
    throw new Error("The runtime could not close every resource cleanly.");
  }
}

const listenRuntime: RuntimeListen = (server, port, host) =>
  new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.removeListener("error", onError);
      reject(error);
    };
    server.once("error", onError);
    try {
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        resolvePromise();
      });
    } catch (error) {
      server.removeListener("error", onError);
      reject(
        error instanceof Error
          ? error
          : new Error("Runtime listen failed.", { cause: error }),
      );
    }
  });

export async function startRuntime(
  options: RuntimeStartOptions = {},
): Promise<RuntimeStartHandle> {
  const applicationRoot = options.applicationRoot ?? applicationRootFromEntry();
  const mode = process.env.MCP_DATA_MODE;
  let resources: RuntimeResources | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    resources = mode === "fixtures"
      ? await createManagedFixtureRuntime(applicationRoot)
      : {
          composition: makeComposition(),
          adminControlApi: createProductionAdminControlApi(),
        };
    server = createRuntimeServer(resources.composition, {
      applicationRoot,
      ...(resources.adminControlApi === undefined
        ? {}
        : { adminControlApi: resources.adminControlApi }),
    });
    close = closeOnce(() => closeRuntimeResources(server, resources!));
    await (options.listen ?? listenRuntime)(
      server,
      PORT,
      mode === "fixtures" ? "127.0.0.1" : "0.0.0.0",
    );
    return Object.freeze({ close });
  } catch (error) {
    if (close !== undefined) {
      await close().catch(() => undefined);
    } else if (resources !== undefined) {
      await closeRuntimeResources(server, resources).catch(() => undefined);
    }
    throw error;
  }
}

function assertNoRuntimeArguments(): void {
  if (process.argv.slice(2).length !== 0) {
    throw new Error("The runtime entry does not accept command-line arguments.");
  }
}

interface CompositionWiring {
  readonly managementTenantId?: string;
  readonly authenticate?: (token: string) => AuthClaims;
  readonly activation?: ActivationReadFacade;
  readonly dispatch?: ControlledDispatchFacade;
}

function makeComposition(wiring: CompositionWiring = {}): GatewayComposition {
  const mode = process.env.MCP_DATA_MODE;
  const common = {
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
    if (wiring.managementTenantId === undefined || wiring.authenticate === undefined) {
      throw new Error("Managed fixture composition requires explicit control identity.");
    }
    return createFixtureComposition({
      dataMode: "fixtures",
      ...common,
      authenticate: wiring.authenticate,
      ...(wiring.activation === undefined ? {} : { activation: wiring.activation }),
      ...(wiring.dispatch === undefined ? {} : { dispatch: wiring.dispatch }),
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
  void (async () => {
    try {
      assertNoRuntimeArguments();
      const runtime = await startRuntime();
      const shutdown = () => void runtime.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    } catch {
      console.error("Runtime startup failed.");
      process.exitCode = 1;
    }
  })();
}
