const SCHEMA_VERSION = "2026-08-27.v1";
const API_ROOT = "/admin/api/v1/access";
const T0_TOOLS = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
]);
const T0_RESOURCES = Object.freeze([
  "logistics://agent/bootstrap",
  "logistics://agent/profiles",
  "logistics://contracts/envelope/current",
  "logistics://modules/catalog",
  "logistics://standards/index",
]);

const elements = Object.freeze({
  statusCard: document.getElementById("status-card"),
  statusDot: document.getElementById("status-dot"),
  statusTitle: document.getElementById("status-title"),
  statusDetail: document.getElementById("status-detail"),
  tokenInput: document.getElementById("admin-token"),
  tenants: document.getElementById("tenants"),
  clients: document.getElementById("clients"),
  credentials: document.getElementById("credentials"),
  operations: document.getElementById("operations"),
  overviewMetrics: document.getElementById("overview-metrics"),
  overviewGenerated: document.getElementById("overview-generated"),
  readiness: document.getElementById("readiness"),
  recentIssues: document.getElementById("recent-issues"),
  agentOnboarding: document.getElementById("agent-onboarding"),
  routeQualification: document.getElementById("route-qualification"),
  tenantContext: document.getElementById("tenant-context"),
  lifecycleTrack: document.getElementById("lifecycle-track"),
  nextActionKicker: document.getElementById("next-action-kicker"),
  nextActionTitle: document.getElementById("next-action-title"),
  nextActionDetail: document.getElementById("next-action-detail"),
  nextAction: document.getElementById("next-action"),
  keyTenant: document.getElementById("key-tenant"),
  clientProfile: document.getElementById("client-profile"),
  clientConfigPreview: document.getElementById("client-config-preview"),
  copyClientConfig: document.getElementById("copy-client-config"),
  oneTimePanel: document.getElementById("one-time-panel"),
  oneTimeKey: document.getElementById("one-time-key"),
  deliveryAcknowledgement: document.getElementById("delivery-acknowledgement"),
  acknowledgeKey: document.getElementById("ack-key"),
  acknowledgeAndVerify: document.getElementById("ack-and-verify"),
  discardKey: document.getElementById("discard-key"),
  secretStatus: document.getElementById("secret-status"),
  writeProgress: document.getElementById("write-progress"),
  actionDialog: document.getElementById("action-dialog"),
  actionDialogForm: document.getElementById("action-dialog-form"),
  actionDialogTitle: document.getElementById("action-dialog-title"),
  actionDialogDetail: document.getElementById("action-dialog-detail"),
  actionDialogImpact: document.getElementById("action-dialog-impact"),
  actionConfirmation: document.getElementById("action-confirmation"),
  actionConfirmationCopy: document.getElementById("action-confirmation-copy"),
  confirmAction: document.getElementById("confirm-action"),
  rotationOptions: document.getElementById("rotation-options"),
  rotationTools: document.getElementById("rotation-tools"),
  rotationExpiry: document.getElementById("rotation-expiry"),
  readbackApiKey: document.getElementById("readback-api-key"),
  readbackResults: document.getElementById("readback-results"),
  runReadback: document.getElementById("run-readback"),
});

let adminToken = "";
let pendingCredentialId = null;
let pendingApiKey = "";
let currentState = null;
let selectedTenantId = "";
let lastReadbackSummary = null;
let currentOnboarding = null;
let writeInFlight = false;
let pendingDialogAction = null;
let nextActionHandler = null;
let lastWriteProgressStage = "input";

const REASON_MESSAGES = Object.freeze({
  authentication_failed: "管理员身份已失效，请重新通过企业入口登录。",
  tenant_already_exists: "租户标识已存在，请选择现有租户。",
  tenant_not_active: "该租户已暂停，恢复后才能继续。",
  tenant_not_found: "租户不存在，请刷新状态后重试。",
  client_not_active: "调用方已停用，恢复后才能继续。",
  client_not_found: "调用方不存在，请刷新状态后重试。",
  credential_not_active: "该 Key 当前不可执行此操作。",
  credential_not_found: "Key 记录不存在，请刷新状态后重试。",
  credential_delivery_pending: "Key 尚未完成安全交付确认。",
  credential_delivery_acknowledged: "该 Key 已经确认交付，无需重复操作。",
  credential_expired: "Key 已过期，请重新签发。",
  idempotency_conflict: "相同操作标识对应了不同请求，需要人工复核。",
  request_schema_invalid: "输入不符合合同，请检查必填项和工具权限。",
  scope_not_allowed: "所选工具超出当前 T0 权限边界。",
  readback_not_verified: "服务端写入后未能精确读回同一对象与状态。",
  tenant_access_unavailable: "租户接入状态暂不可用，请保留当前操作标识并检查服务。",
});

class ApiError extends Error {
  constructor(payload) {
    super("Access Console request failed.");
    this.payload = payload;
  }
}

class ReadbackError extends Error {
  constructor(code) {
    super("Credential readback failed.");
    this.code = code;
  }
}

function text(value) {
  return typeof value === "string" ? value : "—";
}

function setStatus(kind, title, detail) {
  elements.statusCard.dataset.state = kind;
  elements.statusCard.setAttribute("aria-busy", kind === "working" ? "true" : "false");
  elements.statusDot.className = `status-dot ${kind}`;
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
}

function reason(error) {
  const payload = error instanceof ApiError ? error.payload : null;
  if (payload && typeof payload === "object" && Array.isArray(payload.reason_codes)) {
    const codes = payload.reason_codes.filter((value) => typeof value === "string");
    if (codes.length === 0) return "请求被拒绝";
    return codes.map((code) => REASON_MESSAGES[code] ?? code).join(" ");
  }
  return "请求失败，请检查身份、入口和服务状态。";
}

function authorizationHeaders() {
  return adminToken.length === 0 ? {} : { Authorization: `Bearer ${adminToken}` };
}

function idempotencyKey() {
  return `ui_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...authorizationHeaders(),
      ...(method === "POST" ? {
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey ?? idempotencyKey(),
      } : {}),
    },
    cache: "no-store",
    ...(method === "POST" ? { body: JSON.stringify(options.body) } : {}),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError({ reason_codes: ["response_invalid"] });
  }
  if (!response.ok) throw new ApiError(payload);
  return payload;
}

async function readinessApi() {
  const response = await fetch("/access/v1/readyz", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  try {
    return await response.json();
  } catch {
    return { status: "unavailable", data: null, blockers: ["readiness_response_invalid"] };
  }
}

function exactCatalog(actual, expected) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== "string")) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function jsonPayload(response, code) {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ReadbackError(`${code}_content_type_invalid`);
  }
  try {
    return await response.json();
  } catch {
    throw new ReadbackError(`${code}_response_invalid`);
  }
}

async function exchangeForReadback(apiKey) {
  if (!/^lmcpk_[A-Za-z0-9._:-]+_[A-Za-z0-9_-]{43}$/u.test(apiKey)) {
    throw new ReadbackError("api_key_format_invalid");
  }
  const requestId = `req_console_${crypto.randomUUID().replaceAll("-", "")}`;
  const response = await fetch("/access/v1/token/exchange", {
    method: "POST",
    headers: {
      Accept: "application/json",
      authorization: `ApiKey ${apiKey}`,
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
    },
    body: JSON.stringify({
      schema_version: SCHEMA_VERSION,
      requested_tool_names: T0_TOOLS,
    }),
    cache: "no-store",
    redirect: "error",
  });
  const payload = await jsonPayload(response, "exchange");
  if (!response.ok || payload?.status !== "success") {
    throw new ReadbackError(
      typeof payload?.code === "string" ? payload.code : `exchange_http_${response.status}`,
    );
  }
  const data = payload?.data;
  if (
    typeof data?.access_token !== "string" ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(data.access_token) ||
    data.token_type !== "Bearer" ||
    !Number.isSafeInteger(data.expires_in) ||
    !exactCatalog(data.tool_names, T0_TOOLS) ||
    data.request_id !== requestId
  ) {
    throw new ReadbackError("exchange_contract_invalid");
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    requestId,
  };
}

function parseMcpPayload(body, contentType) {
  try {
    if (contentType.includes("text/event-stream")) {
      const candidates = body
        .split(/\r?\n\r?\n/u)
        .map((event) => event
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"))
        .filter((value) => value.length > 0 && value !== "[DONE]")
        .map((value) => JSON.parse(value));
      const payload = candidates.at(-1);
      if (payload === undefined) throw new Error("missing event data");
      return payload;
    }
    return JSON.parse(body);
  } catch {
    throw new ReadbackError("mcp_response_invalid");
  }
}

async function mcpPost(accessToken, sessionId, request, responseExpected = true) {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(sessionId.length === 0 ? {} : { "Mcp-Session-Id": sessionId }),
    },
    body: JSON.stringify(request),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new ReadbackError(`mcp_http_${response.status}`);
  const returnedSessionId = response.headers.get("mcp-session-id") ?? sessionId;
  const body = await response.text();
  if (!responseExpected) return { result: null, sessionId: returnedSessionId };
  const payload = parseMcpPayload(body, response.headers.get("content-type") ?? "");
  if (payload?.error !== undefined || payload?.result === undefined) {
    throw new ReadbackError("mcp_rpc_failed");
  }
  return { result: payload.result, sessionId: returnedSessionId };
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cargoReadbackArguments() {
  return {
    schema_version: "2026-08-11.v1",
    version: "cargo.calculate@credential-readback-v1",
    cargo_lines: [{
      version: "cargo-line@credential-readback-v1",
      line_id: "line_credential_readback_1",
      description: "synthetic carton",
      quantity: 2,
      quantity_unit: "carton",
      package_type: "carton",
      unit_weight: { value: "12.5", unit: "kg" },
      dimensions: [{
        length: { value: "60", unit: "cm" },
        width: { value: "50", unit: "cm" },
        height: { value: "40", unit: "cm" },
        quantity: 2,
      }],
      stackable: true,
      fragile: false,
      sensitive: false,
      source_ref_ids: ["src_credential_readback_input_1"],
    }],
    dimensional_divisor: null,
    bubble_rule: {
      channel: "CAQ-HP",
      mode: "full",
      ratio: null,
      rule_version: "CAQ-HP@credential-readback-v1",
      source_ref_ids: ["src_credential_readback_rule_1"],
      density: { value: "1000", unit: "kg_per_cbm" },
      unit: "kg",
      rounding: { mode: "none", decimals: 6 },
    },
    channel_code: "CAQ-HP",
    source_refs: [
      {
        source_id: "src_credential_readback_input_1",
        source_type: "fixture",
        system: "credential-readback",
        locator: "fixture://credential-readback/cargo/input",
        version: "credential-readback-v1",
        retrieved_at: "2026-08-27T00:00:00Z",
        authority: "user_provided",
        content_hash: "sha256:credentialreadbackcargoinput01",
      },
      {
        source_id: "src_credential_readback_rule_1",
        source_type: "fixture",
        system: "credential-readback",
        locator: "fixture://credential-readback/cargo/rule",
        version: "CAQ-HP@credential-readback-v1",
        retrieved_at: "2026-08-27T00:00:00Z",
        authority: "authoritative",
        content_hash: "sha256:credentialreadbackcargorule01",
      },
    ],
  };
}

function containerReadbackArguments() {
  return {
    schema_version: "2026-08-11.v1",
    version: "container-profile@credential-readback-v1",
    plan_id: "plan_credential_readback_1",
    container_type: "40HQ",
    physical_capacity: { value: "76", unit: "cbm" },
    operational_target: { value: "75", unit: "cbm" },
    max_payload: { value: "26000", unit: "kg" },
    source_ref_ids: ["src:container:credential-readback"],
    cargo_metrics: {
      version: "cargo-metrics@credential-readback-v1",
      line_count: 1,
      total_quantity: 2,
      total_volume: { value: "60", unit: "cbm" },
      actual_weight: { value: "18000", unit: "kg" },
      volumetric_weight: { value: "60000", unit: "kg" },
      weight_evidence: "line_total_weight",
      derived_from_line_ids: ["line_credential_readback_1"],
    },
    loading_constraints: {
      sensitive_at_head: true,
      declaration_at_tail: true,
      fifo_for_other: true,
      customer_priority: null,
    },
    loading_lines: [{
      line_id: "line_credential_readback_1",
      sensitive: false,
      customer_priority: null,
      declaration_required: false,
    }],
  };
}

function toolReadbackArguments(toolName) {
  if (toolName === "cargo.calculate") return cargoReadbackArguments();
  if (toolName === "container.plan_summary") return containerReadbackArguments();
  return { profile_id: "runtime-caller", module_id: "cargo" };
}

async function runCredentialReadback(apiKey) {
  let accessToken = "";
  let sessionId = "";
  try {
    const exchange = await exchangeForReadback(apiKey);
    accessToken = exchange.accessToken;
    const initialized = await mcpPost(accessToken, "", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "freightclaw-access-console", version: "1.0.0" },
      },
    });
    sessionId = initialized.sessionId;
    const transportMode = sessionId.length === 0 ? "stateless" : "stateful";
    if (transportMode === "stateful") {
      await mcpPost(accessToken, sessionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }, false);
    }

    const resourceCatalog = await mcpPost(accessToken, sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/list",
      params: {},
    });
    const resourceUris = resourceCatalog.result?.resources?.map((resource) => resource?.uri);
    if (!exactCatalog(resourceUris, T0_RESOURCES)) {
      throw new ReadbackError("resource_catalog_mismatch");
    }
    const resources = [];
    for (const [index, uri] of T0_RESOURCES.entries()) {
      const read = await mcpPost(accessToken, sessionId, {
        jsonrpc: "2.0",
        id: 10 + index,
        method: "resources/read",
        params: { uri },
      });
      const contents = read.result?.contents;
      if (!Array.isArray(contents) || contents.length === 0) {
        throw new ReadbackError("resource_readback_invalid");
      }
      const textContent = contents
        .map((entry) => typeof entry?.text === "string" ? entry.text : "")
        .join("\n");
      if (textContent.length === 0) throw new ReadbackError("resource_readback_invalid");
      resources.push({
        uri,
        bytes: new TextEncoder().encode(textContent).byteLength,
        sha256: await sha256Text(textContent),
      });
    }

    const toolCatalog = await mcpPost(accessToken, sessionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });
    const toolNames = toolCatalog.result?.tools?.map((tool) => tool?.name);
    if (!exactCatalog(toolNames, T0_TOOLS)) throw new ReadbackError("tool_catalog_mismatch");
    const tools = [];
    for (const [index, name] of T0_TOOLS.entries()) {
      const called = await mcpPost(accessToken, sessionId, {
        jsonrpc: "2.0",
        id: 20 + index,
        method: "tools/call",
        params: { name, arguments: toolReadbackArguments(name) },
      });
      const envelope = called.result?.structuredContent;
      if (envelope?.status !== "success") throw new ReadbackError("tool_readback_not_success");
      tools.push({
        name,
        status: envelope.status,
        requestId: typeof envelope.request_id === "string" ? envelope.request_id : "—",
        auditId: typeof envelope.audit_id === "string" ? envelope.audit_id : "—",
      });
    }
    return {
      exchangeRequestId: exchange.requestId,
      expiresIn: exchange.expiresIn,
      transportMode,
      tools,
      resources,
    };
  } finally {
    if (accessToken.length > 0 && sessionId.length > 0) {
      await fetch("/mcp", {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "Mcp-Session-Id": sessionId,
        },
        cache: "no-store",
        redirect: "error",
      }).catch(() => undefined);
    }
    accessToken = "";
  }
}

function renderReadbackReport(summary) {
  elements.readbackResults.replaceChildren();
  const headline = document.createElement("article");
  headline.className = "record readback-headline";
  headline.dataset.state = "success";
  headline.append(
    row("结论", "PASS"),
    row("兑换请求", summary.exchangeRequestId),
    row("短期 JWT", `已签发 · ${summary.expiresIn} 秒 · 未显示`),
    row("精确目录", `${summary.tools.length} / 3 工具 · ${summary.resources.length} / 5 资源`),
    row(
      "MCP transport",
      summary.transportMode === "stateless" ? "无协议会话（stateless）" : "已建立并关闭（stateful）",
    ),
  );
  elements.readbackResults.append(headline);
  for (const tool of summary.tools) {
    const article = document.createElement("article");
    article.className = "record readback-record";
    article.dataset.state = tool.status;
    article.append(
      row("工具", tool.name),
      row("状态", tool.status),
      row("请求", tool.requestId),
      row("审计", tool.auditId),
    );
    elements.readbackResults.append(article);
  }
  for (const resource of summary.resources) {
    const article = document.createElement("article");
    article.className = "record readback-record";
    article.dataset.state = "success";
    article.append(
      row("资源", resource.uri),
      row("读取", `${resource.bytes} bytes`),
      row("SHA-256", resource.sha256),
    );
    elements.readbackResults.append(article);
  }
}

function renderReadbackFailure(error) {
  elements.readbackResults.replaceChildren();
  const article = document.createElement("article");
  article.className = "record readback-headline";
  article.dataset.state = "blocked";
  article.append(
    row("结论", "未通过"),
    row("原因", error instanceof ReadbackError ? error.code : "credential_readback_unavailable"),
    row("凭证", "未显示、未保存"),
  );
  elements.readbackResults.append(article);
}

function row(label, value) {
  const paragraph = document.createElement("p");
  paragraph.className = "record-row";
  const strong = document.createElement("strong");
  strong.textContent = `${label}：`;
  paragraph.append(strong, document.createTextNode(text(value)));
  return paragraph;
}

function statusLabel(value) {
  const labels = {
    active: "可用",
    suspended: "已暂停",
    disabled: "已停用",
    pending_delivery: "待安全交付",
    tenant_suspended: "租户已暂停",
    client_disabled: "调用方已停用",
    expired: "已过期",
    revoked: "已吊销",
    success: "已核验",
  };
  return labels[value] ?? text(value);
}

function formatEpoch(value) {
  return Number.isSafeInteger(value)
    ? new Date(value * 1_000).toLocaleString("zh-CN", { hour12: false })
    : "—";
}

function toolSummary(toolNames) {
  return Array.isArray(toolNames) && toolNames.length > 0
    ? toolNames.join(", ")
    : "未授权工具";
}

function setWriteBusy(value) {
  writeInFlight = value;
  document.body.dataset.writeBusy = value ? "true" : "false";
  for (const button of document.querySelectorAll(
    "#tenant-form button, #key-form button, .record-action, #ack-key, #ack-and-verify, #discard-key",
  )) {
    button.disabled = value;
  }
  if (!value) updateDeliveryControls();
}

function setWriteProgress(stage, title, detail, operationId = null) {
  const stages = [
    ["input", "输入与权限"],
    ["transaction", "服务端事务"],
    ["operation", "operation_id"],
    ["object", "对象状态"],
  ];
  const failed = stage === "failed";
  if (!failed) lastWriteProgressStage = stage;
  const activeIndex = stages.findIndex(([id]) => (
    id === (failed ? lastWriteProgressStage : stage)
  ));
  elements.writeProgress.replaceChildren();
  const summary = document.createElement("div");
  summary.className = "write-progress-summary";
  summary.dataset.state = failed ? "failed" : activeIndex === stages.length - 1 ? "success" : "working";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = detail;
  summary.append(heading, copy);
  if (typeof operationId === "string") summary.append(row("操作标识", operationId));

  const track = document.createElement("ol");
  track.className = "write-progress-track";
  for (const [index, [, label]] of stages.entries()) {
    const item = document.createElement("li");
    item.dataset.state = failed
      ? index < activeIndex ? "done" : index === activeIndex ? "failed" : "pending"
      : index < activeIndex || activeIndex === stages.length - 1
        ? "done"
        : index === activeIndex ? "current" : "pending";
    const marker = document.createElement("span");
    marker.textContent = String(index + 1).padStart(2, "0");
    const labelNode = document.createElement("strong");
    labelNode.textContent = label;
    item.append(marker, labelNode);
    track.append(item);
  }
  elements.writeProgress.append(summary, track);
}

function operationForPayload(payload, state) {
  const operationId = payload?.data?.operation?.operation_id;
  const operations = state?.data?.operations;
  if (typeof operationId !== "string" || !Array.isArray(operations)) return null;
  return operations.find((operation) => operation?.operation_id === operationId) ?? null;
}

function verifyWriteReadback(payload, state, expected) {
  const operation = operationForPayload(payload, state);
  if (
    operation === null ||
    operation.status !== "success" ||
    operation.action !== expected.action
  ) {
    throw new ApiError({ reason_codes: ["readback_not_verified"] });
  }
  const data = state?.data;
  if (expected.kind === "tenant") {
    const tenant = data?.tenants?.find((value) => value?.tenant_id === expected.tenantId);
    if (tenant?.status !== expected.status) {
      throw new ApiError({ reason_codes: ["readback_not_verified"] });
    }
  } else if (expected.kind === "client") {
    const client = data?.clients?.find((value) => (
      value?.tenant_id === expected.tenantId && value?.client_id === expected.clientId
    ));
    if (client?.status !== expected.status) {
      throw new ApiError({ reason_codes: ["readback_not_verified"] });
    }
  } else if (expected.kind === "credential") {
    const credentialId = expected.credentialId ?? payload?.data?.credential?.credential_id;
    const credential = data?.credentials?.find((value) => value?.credential_id === credentialId);
    if (
      credential === undefined ||
      credential.effective_status !== expected.status ||
      !exactCatalog(credential.tool_names, expected.toolNames)
    ) {
      throw new ApiError({ reason_codes: ["readback_not_verified"] });
    }
  }
  return operation;
}

async function exactStateReadback(payload, expected) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await api("/state");
    try {
      verifyWriteReadback(payload, state, expected);
      return state;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new ApiError({ reason_codes: ["readback_not_verified"] });
}

function impactRow(label, value) {
  const item = document.createElement("div");
  const caption = document.createElement("span");
  caption.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = text(value);
  item.append(caption, strong);
  return item;
}

function closeActionDialog() {
  pendingDialogAction = null;
  elements.actionConfirmation.checked = false;
  elements.confirmAction.disabled = true;
  elements.rotationOptions.hidden = true;
  elements.actionDialogImpact.replaceChildren();
  if (elements.actionDialog.open) elements.actionDialog.close();
}

function openActionDialog(options) {
  if (writeInFlight) return;
  pendingDialogAction = options.action;
  elements.actionDialogTitle.textContent = options.title;
  elements.actionDialogDetail.textContent = options.detail;
  elements.actionConfirmationCopy.textContent = options.confirmation;
  elements.confirmAction.textContent = options.confirmLabel;
  elements.confirmAction.className = options.danger === true ? "danger" : "";
  elements.actionDialogImpact.replaceChildren(
    ...options.impact.map(([label, value]) => impactRow(label, value)),
  );
  elements.rotationOptions.hidden = options.rotation !== true;
  elements.actionConfirmation.checked = false;
  updateDialogControls();
  elements.actionDialog.showModal();
}

function updateDialogControls() {
  const rotationReady = elements.rotationOptions.hidden || selectedRotationTools().length > 0;
  elements.confirmAction.disabled = writeInFlight ||
    !elements.actionConfirmation.checked ||
    !rotationReady;
}

function selectedRotationTools() {
  const values = [...elements.rotationTools.querySelectorAll("input:checked")]
    .map((input) => input.value);
  return T0_TOOLS.filter((toolName) => values.includes(toolName));
}

function openRotationDialog(credential) {
  if (pendingApiKey.length > 0) {
    setStatus("blocked", "请先处理当前一次性 Key", "完成安全交付或放弃并吊销后，才能开始下一次轮换。");
    scrollToControl("#one-time-panel");
    return;
  }
  const currentTools = Array.isArray(credential.tool_names) ? credential.tool_names : [];
  for (const checkbox of elements.rotationTools.querySelectorAll("input[type='checkbox']")) {
    checkbox.checked = currentTools.includes(checkbox.value);
  }
  elements.rotationExpiry.value = "2592000";
  openActionDialog({
    title: "轮换长期 Key",
    detail: "确认后旧 Key 立即停止兑换，新 Key 只显示一次并重新进入待交付状态。",
    confirmation: "我已安排调用方同步更新凭证，并理解旧 Key 会立即失效",
    confirmLabel: "轮换并显示新 Key",
    danger: true,
    rotation: true,
    impact: [
      ["租户", credential.tenant_id],
      ["调用方", credential.client_id],
      ["当前权限", toolSummary(currentTools)],
    ],
    action: () => rotateCredential(credential),
  });
}

function actionButton(label, action, tone = "secondary") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `record-action ${tone}`;
  button.textContent = label;
  button.disabled = writeInFlight;
  button.addEventListener("click", () => void action());
  return button;
}

function renderEmpty(target) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty";
  paragraph.textContent = "暂无记录";
  target.append(paragraph);
}

function metric(label, value, tone = "neutral") {
  const article = document.createElement("article");
  article.className = `metric ${tone}`;
  article.dataset.tone = tone;
  const count = document.createElement("strong");
  count.textContent = Number.isSafeInteger(value) ? String(value) : "—";
  const caption = document.createElement("span");
  caption.textContent = label;
  article.append(count, caption);
  return article;
}

function tenantOption(tenant) {
  const option = document.createElement("option");
  option.value = tenant.tenant_id;
  option.textContent = `${tenant.display_name} · ${statusLabel(tenant.status)}`;
  return option;
}

function syncTenantSelectors(tenants) {
  const records = Array.isArray(tenants) ? tenants : [];
  if (!records.some((tenant) => tenant.tenant_id === selectedTenantId)) {
    selectedTenantId = records.find((tenant) => tenant.status === "active")?.tenant_id
      ?? records[0]?.tenant_id
      ?? "";
  }

  elements.tenantContext.replaceChildren();
  if (records.length === 0) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "尚未创建租户";
    elements.tenantContext.append(empty);
    elements.tenantContext.disabled = true;
  } else {
    for (const tenant of records) elements.tenantContext.append(tenantOption(tenant));
    elements.tenantContext.value = selectedTenantId;
    elements.tenantContext.disabled = false;
  }

  const activeTenants = records.filter((tenant) => tenant.status === "active");
  elements.keyTenant.replaceChildren();
  const prompt = document.createElement("option");
  prompt.value = "";
  prompt.textContent = activeTenants.length === 0 ? "没有 active 租户" : "选择 active 租户";
  elements.keyTenant.append(prompt);
  for (const tenant of activeTenants) elements.keyTenant.append(tenantOption(tenant));
  if (activeTenants.some((tenant) => tenant.tenant_id === selectedTenantId)) {
    elements.keyTenant.value = selectedTenantId;
  }
  elements.keyTenant.disabled = activeTenants.length === 0;
}

function lifecycleItem(index, title, detail, state) {
  const item = document.createElement("li");
  item.dataset.state = state;
  const marker = document.createElement("span");
  marker.className = "lifecycle-index";
  marker.textContent = String(index).padStart(2, "0");
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = detail;
  const badge = document.createElement("small");
  badge.textContent = state === "complete" ? "已完成" : state === "current" ? "当前步骤" : "待完成";
  copy.append(heading, paragraph);
  item.append(marker, copy, badge);
  return item;
}

function scrollToControl(selector) {
  const target = document.querySelector(selector);
  if (target === null) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  const focusTarget = target.matches("button, input, select")
    ? target
    : target.querySelector("button:not([disabled]), input:not([disabled]), select:not([disabled])");
  if (focusTarget instanceof HTMLElement) focusTarget.focus({ preventScroll: true });
}

function setNextAction(kicker, title, detail, label, action) {
  elements.nextActionKicker.textContent = kicker;
  elements.nextActionTitle.textContent = title;
  elements.nextActionDetail.textContent = detail;
  elements.nextAction.textContent = label;
  elements.nextAction.disabled = typeof action !== "function";
  nextActionHandler = action;
}

function renderAccessWorkbench(state) {
  const tenants = Array.isArray(state?.tenants) ? state.tenants : [];
  const clients = Array.isArray(state?.clients) ? state.clients : [];
  const credentials = Array.isArray(state?.credentials) ? state.credentials : [];
  syncTenantSelectors(tenants);
  const tenant = tenants.find((value) => value.tenant_id === selectedTenantId) ?? null;
  const tenantCredentials = credentials.filter((value) => value.tenant_id === selectedTenantId);
  const pendingCredential = tenantCredentials.find((value) => value.effective_status === "pending_delivery") ?? null;
  const activeCredential = tenantCredentials.find((value) => value.effective_status === "active") ?? null;
  const tenantClient = clients.find((value) => (
    value.tenant_id === selectedTenantId && value.status === "active"
  )) ?? null;
  const tenantReady = tenant?.status === "active";
  const keyIssued = pendingCredential !== null || activeCredential !== null;
  const deliveryComplete = activeCredential !== null;
  const readbackComplete = lastReadbackSummary?.tenantId === selectedTenantId;

  elements.lifecycleTrack.replaceChildren(
    lifecycleItem(
      1,
      "租户可用",
      tenant === null ? "创建并选择租户" : `${tenant.display_name} · ${statusLabel(tenant.status)}`,
      tenantReady ? "complete" : "current",
    ),
    lifecycleItem(
      2,
      "调用方与 Key",
      keyIssued
        ? `${pendingCredential?.client_id ?? activeCredential?.client_id} · ${toolSummary((pendingCredential ?? activeCredential)?.tool_names)}`
        : "签发一次性长期 Key，并固定精确工具权限",
      !tenantReady ? "pending" : keyIssued ? "complete" : "current",
    ),
    lifecycleItem(
      3,
      "安全交付",
      pendingCredential !== null
        ? "Key 仍不可兑换；必须先保存并确认交付"
        : deliveryComplete ? "交付已确认，Key 可用于兑换" : "等待 Key 签发",
      deliveryComplete ? "complete" : keyIssued ? "current" : "pending",
    ),
    lifecycleItem(
      4,
      "认证读回",
      readbackComplete ? "短期 JWT、3 tools 与 5 resources 已核验" : "等待真实 Key 完成端到端验收",
      readbackComplete ? "complete" : deliveryComplete ? "current" : "pending",
    ),
  );

  if (tenant === null) {
    setNextAction("STEP 1 OF 4", "创建第一个租户", "租户只保存 MCP 接入身份元数据，不建立客户或业务主数据。", "前往创建租户", () => scrollToControl("#tenant-form"));
  } else if (!tenantReady) {
    setNextAction("STEP 1 OF 4", "恢复当前租户", "暂停状态会阻止该租户全部调用方兑换新 JWT。", "恢复租户", () => setTenantStatus(tenant.tenant_id, "active"));
  } else if (!keyIssued) {
    setNextAction("STEP 2 OF 4", "签发调用方 Key", "选择完整工具集合；调用方会随首次签发自动创建。", "填写签发表单", () => scrollToControl("#key-form"));
  } else if (pendingCredential !== null) {
    const keyAvailable = pendingCredentialId === pendingCredential.credential_id && pendingApiKey.length > 0;
    if (keyAvailable) {
      setNextAction("STEP 3 OF 4", "完成安全交付", "复制并保存一次性 Key，然后由本页精确确认交付。", "查看一次性 Key", () => scrollToControl("#one-time-panel"));
    } else {
      setNextAction("STEP 3 OF 4", "处理不可恢复的待交付 Key", "完整 Key 已不在当前页面内存，不能直接确认交付；请吊销后重新签发。", "查看待处理 Key", () => scrollToControl("#credentials"));
    }
  } else if (!readbackComplete) {
    setNextAction("STEP 4 OF 4", "完成真实认证验收", `为 ${tenantClient?.client_id ?? activeCredential?.client_id ?? "当前调用方"} 粘贴已保存的 Key；页面只在内存中使用。`, "前往认证验收", () => scrollToControl("#readback-api-key"));
  } else {
    setNextAction("LIFECYCLE COMPLETE", "接入闭环已读回", "继续观察调用状态；权限变化必须通过轮换，新 Key 重新完成交付与验收。", "查看操作证据", () => scrollToControl("#operations-section"));
  }
  renderClientConfig();
}

function buildClientConfig() {
  const data = currentState?.data;
  const client = data?.clients?.find((value) => (
    value?.tenant_id === selectedTenantId && value?.status === "active"
  ));
  const baseUrl = globalThis.location.origin;
  const exchangePath = currentOnboarding?.token_exchange_path ?? "/access/v1/token/exchange";
  const mcpPath = currentOnboarding?.mcp_path ?? "/mcp";
  return JSON.stringify({
    schema_version: "2026-09-01.ui-handoff.v1",
    client_type: elements.clientProfile.value,
    tenant_ref: selectedTenantId || "<tenant_id>",
    client_ref: client?.client_id ?? "<client_id>",
    token_exchange: {
      url: `${baseUrl}${exchangePath}`,
      api_key_env: "FREIGHTCLAW_API_KEY",
      requested_tool_names: T0_TOOLS,
    },
    mcp: {
      url: `${baseUrl}${mcpPath}`,
      bearer_env: "LOGISTICS_MCP_BEARER_TOKEN",
      expected_tool_names: T0_TOOLS,
      expected_resource_uris: T0_RESOURCES,
    },
    directly_importable: false,
  }, null, 2);
}

function renderClientConfig() {
  elements.clientConfigPreview.textContent = buildClientConfig();
}

function renderOverview(payload) {
  const data = payload?.data;
  const access = data?.access_state;
  const activity = data?.gateway_activity;
  elements.overviewGenerated.textContent = typeof data?.generated_at === "string"
    ? `脱敏快照 · ${data.generated_at}`
    : "24 小时脱敏快照时间不可用";
  elements.overviewMetrics.replaceChildren(
    metric("有效租户", access?.tenants?.active, "positive"),
    metric("有效调用方", access?.clients?.active, "positive"),
    metric("有效 Key", access?.credentials?.active, "positive"),
    metric("待确认交付", access?.credentials?.pending_delivery, "attention"),
    metric("24 小时调用", activity?.total_audit_events),
    metric(
      "24 小时非成功",
      ["needs_input", "manual_review", "blocked", "unavailable"].reduce(
        (total, status) => total + (Number.isSafeInteger(activity?.status_counts?.[status])
          ? activity.status_counts[status]
          : 0),
        0,
      ),
      "attention",
    ),
  );

  elements.recentIssues.replaceChildren();
  const issues = activity?.recent_issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    renderEmpty(elements.recentIssues);
  } else {
    for (const issue of issues) {
      const article = document.createElement("article");
      article.className = "record issue-record";
      article.dataset.state = text(issue.status);
      article.append(
        row("状态", issue.status),
        row("动作", issue.action),
        row("原因", issue.reason_code),
        row("时间", issue.created_at),
        row("审计引用", issue.audit_ref),
      );
      elements.recentIssues.append(article);
    }
  }

  elements.agentOnboarding.replaceChildren();
  const onboarding = data?.agent_onboarding;
  currentOnboarding = onboarding ?? null;
  if (!Array.isArray(onboarding?.supported_clients)) {
    renderEmpty(elements.agentOnboarding);
  } else {
    const article = document.createElement("article");
    article.className = "record onboarding-record";
    article.append(
      row("客户端", onboarding.supported_clients.join("、")),
      row("换取短期 JWT", onboarding.token_exchange_path),
      row("MCP 入口", onboarding.mcp_path),
      row("可授权工具", Array.isArray(onboarding.tool_names)
        ? onboarding.tool_names.join(", ")
        : "—"),
    );
    const checklist = document.createElement("ol");
    for (const step of [
      "创建租户并确认状态为 active",
      "签发 Key、保存到 Secret Manager 并确认交付",
      "用 Key 换取短期 JWT",
      "把 MCP 地址和短期 JWT 交给 Agent 客户端",
      "读取工具目录并核对精确授权集合",
    ]) {
      const item = document.createElement("li");
      item.textContent = step;
      checklist.append(item);
    }
    article.append(checklist);
    elements.agentOnboarding.append(article);
  }
  renderClientConfig();
}

function readinessItem(label, value, state, wide = false) {
  const item = document.createElement("div");
  item.className = `readiness-item${wide ? " wide" : ""}`;
  item.dataset.state = state;
  const caption = document.createElement("span");
  caption.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  item.append(caption, strong);
  return item;
}

function renderReadiness(payload) {
  elements.readiness.replaceChildren();
  const data = payload?.data;
  const grid = document.createElement("div");
  grid.className = "readiness-grid";
  const productionEligible = data?.production_eligible === true;
  elements.routeQualification.textContent = productionEligible
    ? "生产资格已读回"
    : "待真实 staging 验证";
  grid.append(
    readinessItem(
      "运行状态",
      data?.operational_ready === true ? "READY" : "NOT READY",
      data?.operational_ready === true ? "ready" : "pending",
    ),
    readinessItem(
      "企业身份",
      data?.admin_idp_ready === true ? "READY" : "PENDING",
      data?.admin_idp_ready === true ? "ready" : "pending",
    ),
    readinessItem("数据库", text(data?.database_backend), "neutral"),
    readinessItem(
      "生产资格",
      productionEligible ? "ELIGIBLE" : "NOT ELIGIBLE",
      productionEligible ? "ready" : "not-eligible",
    ),
    readinessItem(
      "阻断项",
      Array.isArray(payload?.blockers) ? payload.blockers.join("、") || "无" : "—",
      "neutral",
      true,
    ),
  );
  elements.readiness.append(grid);
}

function renderTenants(records) {
  elements.tenants.replaceChildren();
  if (!Array.isArray(records) || records.length === 0) {
    renderEmpty(elements.tenants);
    return;
  }
  for (const tenant of records) {
    const article = document.createElement("article");
    article.className = "record";
    if (tenant.tenant_id === selectedTenantId) article.classList.add("selected-record");
    article.dataset.state = text(tenant.status);
    article.append(
      row("名称", tenant.display_name),
      row("状态", `${statusLabel(tenant.status)} · ${tenant.status}`),
      row("标识", tenant.tenant_id),
    );
    const actions = document.createElement("div");
    actions.className = "record-actions";
    if (tenant.tenant_id !== selectedTenantId) {
      actions.append(actionButton("管理此租户", () => {
        selectedTenantId = tenant.tenant_id;
        renderState(currentState);
      }));
    }
    if (Array.isArray(tenant.allowed_actions)) {
      if (tenant.allowed_actions.includes("suspend")) {
        actions.append(actionButton("暂停租户", () => openActionDialog({
          title: "暂停整个租户",
          detail: "该租户下全部调用方将立即无法兑换新的短期 JWT。已签 JWT 最迟在 TTL 到期后收敛。",
          confirmation: `我确认暂停租户 ${tenant.tenant_id}`,
          confirmLabel: "确认暂停租户",
          danger: true,
          impact: [
            ["租户", tenant.display_name],
            ["标识", tenant.tenant_id],
            ["影响", "全部调用方与长期 Key"],
          ],
          action: () => setTenantStatus(tenant.tenant_id, "suspended"),
        }), "danger"));
      }
      if (tenant.allowed_actions.includes("activate")) {
        actions.append(actionButton("恢复租户", () => setTenantStatus(tenant.tenant_id, "active")));
      }
    }
    if (actions.childElementCount > 0) article.append(actions);
    elements.tenants.append(article);
  }
}

function renderCredentials(records) {
  elements.credentials.replaceChildren();
  if (!Array.isArray(records) || records.length === 0) {
    renderEmpty(elements.credentials);
    return;
  }
  for (const credential of records) {
    const article = document.createElement("article");
    article.className = "record";
    if (credential.tenant_id === selectedTenantId) article.classList.add("selected-record");
    article.dataset.state = text(credential.effective_status);
    article.append(
      row("名称", credential.label),
      row("状态", `${statusLabel(credential.effective_status)} · ${credential.effective_status}`),
      row("租户", credential.tenant_id),
      row("调用方", credential.client_id),
      row("Key 后四位", credential.secret_last_four),
      row("权限", toolSummary(credential.tool_names)),
      row("到期", formatEpoch(credential.expires_at)),
      row("最近兑换", formatEpoch(credential.last_used_at)),
    );
    const actions = document.createElement("div");
    actions.className = "record-actions";
    const allowed = Array.isArray(credential.allowed_actions) ? credential.allowed_actions : [];
    if (allowed.includes("acknowledge_delivery")) {
      const secretAvailable = pendingCredentialId === credential.credential_id && pendingApiKey.length > 0;
      if (secretAvailable) {
        actions.append(actionButton("完成安全交付", () => scrollToControl("#one-time-panel")));
      } else {
        const warning = document.createElement("p");
        warning.className = "record-guidance";
        warning.textContent = "完整 Key 已不在本页内存，不能确认交付；请吊销后重新签发。";
        article.append(warning);
      }
    }
    if (allowed.includes("rotate")) {
      actions.append(actionButton("轮换或调整权限", () => openRotationDialog(credential)));
    }
    if (allowed.includes("revoke")) {
      actions.append(actionButton("吊销 Key", () => openActionDialog({
        title: "吊销长期 Key",
        detail: "吊销后不能恢复。该 Key 将立即无法兑换新的短期 JWT。",
        confirmation: `我确认吊销尾号 ${credential.secret_last_four} 的 Key`,
        confirmLabel: "确认吊销 Key",
        danger: true,
        impact: [
          ["调用方", credential.client_id],
          ["Key", `${credential.key_prefix}…${credential.secret_last_four}`],
          ["权限", toolSummary(credential.tool_names)],
        ],
        action: () => revokeCredential(credential),
      }), "danger"));
    }
    if (actions.childElementCount > 0) article.append(actions);
    elements.credentials.append(article);
  }
}

function renderClients(records) {
  elements.clients.replaceChildren();
  if (!Array.isArray(records) || records.length === 0) {
    renderEmpty(elements.clients);
    return;
  }
  for (const client of records) {
    const article = document.createElement("article");
    article.className = "record";
    if (client.tenant_id === selectedTenantId) article.classList.add("selected-record");
    article.dataset.state = text(client.status);
    article.append(
      row("名称", client.label),
      row("状态", `${statusLabel(client.status)} · ${client.status}`),
      row("租户", client.tenant_id),
      row("调用方", client.client_id),
    );
    const actions = document.createElement("div");
    actions.className = "record-actions";
    const allowed = Array.isArray(client.allowed_actions) ? client.allowed_actions : [];
    if (allowed.includes("disable")) {
      actions.append(actionButton(
        "停用调用方",
        () => openActionDialog({
          title: "停用调用方",
          detail: "该调用方名下全部长期 Key 将立即无法兑换新的短期 JWT。",
          confirmation: `我确认停用调用方 ${client.client_id}`,
          confirmLabel: "确认停用调用方",
          danger: true,
          impact: [
            ["租户", client.tenant_id],
            ["调用方", client.client_id],
            ["影响", "该调用方全部长期 Key"],
          ],
          action: () => setClientStatus(client.tenant_id, client.client_id, "disabled"),
        }),
        "danger",
      ));
    }
    if (allowed.includes("enable")) {
      actions.append(actionButton(
        "恢复调用方",
        () => setClientStatus(client.tenant_id, client.client_id, "active"),
      ));
    }
    if (actions.childElementCount > 0) article.append(actions);
    elements.clients.append(article);
  }
}

function renderOperations(records) {
  elements.operations.replaceChildren();
  if (!Array.isArray(records) || records.length === 0) {
    renderEmpty(elements.operations);
    return;
  }
  for (const operation of records) {
    const article = document.createElement("article");
    article.className = "record operation-record";
    article.dataset.state = text(operation.status);
    article.append(
      row("动作", operation.action),
      row("流转", `${text(operation.from_status)} → ${text(operation.to_status)}`),
      row("状态", operation.status),
      row("原因", operation.reason_code),
      row("时间", operation.created_at),
      row("操作标识", operation.operation_id),
    );
    elements.operations.append(article);
  }
}

function renderState(payload) {
  currentState = payload;
  const state = payload?.data;
  renderAccessWorkbench(state);
  renderTenants(state?.tenants);
  renderClients(state?.clients);
  renderCredentials(state?.credentials);
  renderOperations(state?.operations);
}

async function refreshState(options = {}) {
  if (options.announce !== false) setStatus("working", "正在读取", "从服务端读取权威状态。");
  try {
    const [payload, overview, readiness] = await Promise.all([
      api("/state"),
      api("/overview"),
      readinessApi(),
    ]);
    renderState(payload);
    renderOverview(overview);
    renderReadiness(readiness);
    setStatus("ready", "状态已读回", "租户、Key 权限、运营计数和状态门禁均来自服务端。");
    return payload;
  } catch (error) {
    setStatus("blocked", "状态不可用", reason(error));
    if (options.propagate === true) throw error;
    return null;
  }
}

function selectedTools() {
  const values = [...document.querySelectorAll("#tool-permissions input:checked")]
    .map((input) => input.value);
  return T0_TOOLS.filter((toolName) => values.includes(toolName));
}

function expirySeconds() {
  const form = document.getElementById("key-form");
  return Number(new FormData(form).get("expires_in_seconds"));
}

async function refreshSupportingPanels() {
  const [overview, readiness] = await Promise.allSettled([
    api("/overview"),
    readinessApi(),
  ]);
  if (overview.status === "fulfilled") renderOverview(overview.value);
  if (readiness.status === "fulfilled") renderReadiness(readiness.value);
}

function showOneTimeKey(payload) {
  const apiKey = payload?.data?.api_key;
  const credentialId = payload?.data?.credential?.credential_id;
  if (typeof apiKey !== "string" || typeof credentialId !== "string") return;
  pendingCredentialId = credentialId;
  pendingApiKey = apiKey;
  elements.oneTimeKey.textContent = apiKey;
  elements.oneTimePanel.hidden = false;
  elements.deliveryAcknowledgement.checked = false;
  elements.secretStatus.textContent = "尚未确认外部安全保存。";
  updateDeliveryControls();
  if (currentState?.data !== undefined) {
    renderAccessWorkbench(currentState.data);
    renderCredentials(currentState.data.credentials);
  }
}

async function post(path, body, options) {
  if (writeInFlight) return null;
  const requestKey = idempotencyKey();
  setWriteBusy(true);
  setStatus("working", "正在写入", "先提交事务，再精确读回 operation 和目标对象。");
  setWriteProgress("input", "输入与权限已检查", options.progressDetail, null);
  try {
    setWriteProgress("transaction", "正在提交服务端事务", "等待状态、审计和幂等记录原子写入。", null);
    const payload = await api(path, { method: "POST", body, idempotencyKey: requestKey });
    const operationId = payload?.data?.operation?.operation_id;
    if (typeof operationId !== "string") {
      throw new ApiError({ reason_codes: ["readback_not_verified"] });
    }
    setWriteProgress("operation", "事务已返回操作标识", "正在读取同一 operation_id 与 success 状态。", operationId);
    const expected = typeof options.expected === "function"
      ? options.expected(payload)
      : options.expected;
    const readback = await exactStateReadback(payload, expected);
    if (typeof options.beforeRender === "function") options.beforeRender(payload, readback);
    renderState(readback);
    await refreshSupportingPanels();
    setWriteProgress("object", "写入和对象状态均已核验", options.successDetail, operationId);
    if (options.secret === true) showOneTimeKey(payload);
    if (typeof options.onSuccess === "function") options.onSuccess(payload, readback);
    setStatus("ready", options.successMessage, "同一 operation_id、动作和目标对象状态均已由服务端读回。");
    return payload;
  } catch (error) {
    setWriteProgress("failed", "操作未完成", reason(error), null);
    setStatus("blocked", "操作未完成", reason(error));
    return null;
  } finally {
    setWriteBusy(false);
  }
}

function setTenantStatus(tenantId, status) {
  return post(`/tenants/${encodeURIComponent(tenantId)}/status`, {
    schema_version: SCHEMA_VERSION,
    status,
    reason_code: status === "active" ? "operator_reactivated" : "operator_suspended",
  }, {
    progressDetail: `${tenantId} → ${status}`,
    successMessage: status === "active" ? "租户已恢复" : "租户已暂停",
    successDetail: `租户 ${tenantId} 已精确读回为 ${status}。`,
    expected: {
      kind: "tenant",
      action: status === "active" ? "tenant.activate" : "tenant.suspend",
      tenantId,
      status,
    },
    beforeRender: () => { selectedTenantId = tenantId; },
  });
}

function setClientStatus(tenantId, clientId, status) {
  return post(
    `/tenants/${encodeURIComponent(tenantId)}/clients/${encodeURIComponent(clientId)}/status`,
    {
      schema_version: SCHEMA_VERSION,
      status,
      reason_code: status === "active" ? "operator_reenabled" : "operator_disabled",
    }, {
      progressDetail: `${tenantId} / ${clientId} → ${status}`,
      successMessage: status === "active" ? "调用方已恢复" : "调用方已停用",
      successDetail: `调用方 ${clientId} 已精确读回为 ${status}。`,
      expected: {
        kind: "client",
        action: status === "active" ? "client.enable" : "client.disable",
        tenantId,
        clientId,
        status,
      },
      beforeRender: () => { selectedTenantId = tenantId; },
    },
  );
}

function credentialById(credentialId) {
  return currentState?.data?.credentials?.find((value) => value?.credential_id === credentialId) ?? null;
}

async function acknowledgeDelivery(credentialId, options = {}) {
  const credential = credentialById(credentialId);
  if (credential === null) {
    setStatus("blocked", "不能确认交付", "请刷新状态后重试。");
    return null;
  }
  const payload = await post(`/credentials/${encodeURIComponent(credentialId)}/acknowledge-delivery`, {
    schema_version: SCHEMA_VERSION,
    reason_code: "operator_confirmed_secure_storage",
  }, {
    progressDetail: `${credential.client_id} / ${credentialId}`,
    successMessage: "Key 交付已确认",
    successDetail: "凭证已精确读回为 active，可用于兑换短期 JWT。",
    expected: {
      kind: "credential",
      action: "credential.delivery_acknowledge",
      credentialId,
      status: "active",
      toolNames: credential.tool_names,
    },
    beforeRender: () => { selectedTenantId = credential.tenant_id; },
  });
  if (payload !== null && pendingCredentialId === credentialId && options.keepSecret !== true) {
    hideOneTimeKey();
  }
  return payload;
}

function rotateCredential(credential) {
  const toolNames = selectedRotationTools();
  if (toolNames.length === 0) {
    setStatus("blocked", "不能轮换", "请先勾选至少一个内置工具权限。");
    return Promise.resolve(null);
  }
  return post(`/credentials/${encodeURIComponent(credential.credential_id)}/rotate`, {
    schema_version: SCHEMA_VERSION,
    tool_names: toolNames,
    expires_in_seconds: Number(elements.rotationExpiry.value),
    reason_code: "operator_function_profile_changed",
  }, {
    progressDetail: `${credential.client_id} / ${toolSummary(toolNames)}`,
    successMessage: "Key 已轮换，等待安全交付",
    successDetail: "旧 Key 已吊销，新 Key 与完整权限集合已精确读回。",
    secret: true,
    expected: (payload) => ({
      kind: "credential",
      action: "credential.rotate",
      credentialId: payload?.data?.credential?.credential_id,
      status: "pending_delivery",
      toolNames,
    }),
    beforeRender: () => { selectedTenantId = credential.tenant_id; },
    onSuccess: () => scrollToControl("#one-time-panel"),
  });
}

async function revokeCredential(credential) {
  const payload = await post(`/credentials/${encodeURIComponent(credential.credential_id)}/revoke`, {
    schema_version: SCHEMA_VERSION,
    reason_code: "operator_revoked",
  }, {
    progressDetail: `${credential.client_id} / ${credential.credential_id}`,
    successMessage: "Key 已吊销",
    successDetail: "凭证已精确读回为 revoked，不能再兑换新 JWT。",
    expected: {
      kind: "credential",
      action: "credential.revoke",
      credentialId: credential.credential_id,
      status: "revoked",
      toolNames: credential.tool_names,
    },
    beforeRender: () => { selectedTenantId = credential.tenant_id; },
  });
  if (payload !== null && pendingCredentialId === credential.credential_id) hideOneTimeKey();
  return payload;
}

function hideOneTimeKey() {
  pendingCredentialId = null;
  pendingApiKey = "";
  elements.oneTimeKey.textContent = "";
  elements.deliveryAcknowledgement.checked = false;
  elements.secretStatus.textContent = "一次性 Key 已从页面内存清除。";
  elements.oneTimePanel.hidden = true;
  updateDeliveryControls();
  if (currentState?.data !== undefined) {
    renderAccessWorkbench(currentState.data);
    renderCredentials(currentState.data.credentials);
  }
}

function updateDeliveryControls() {
  const ready = !writeInFlight &&
    elements.deliveryAcknowledgement.checked &&
    typeof pendingCredentialId === "string" &&
    pendingApiKey.length > 0;
  elements.acknowledgeKey.disabled = !ready;
  elements.acknowledgeAndVerify.disabled = !ready;
  elements.discardKey.disabled = writeInFlight || typeof pendingCredentialId !== "string";
  if (!elements.oneTimePanel.hidden) {
    elements.secretStatus.textContent = ready
      ? "已确认外部保存，可提交交付确认。"
      : "勾选确认前不会把凭证标记为可用。";
  }
}

async function executeCredentialReadback(rawApiKey, tenantId) {
  let apiKey = rawApiKey;
  if (apiKey.length === 0) {
    renderReadbackFailure(new ReadbackError("api_key_required"));
    return false;
  }
  elements.runReadback.disabled = true;
  elements.readbackResults.setAttribute("aria-busy", "true");
  setStatus("working", "正在验收", "正在兑换短期身份并读取精确 T0 目录。");
  try {
    const summary = await runCredentialReadback(apiKey);
    lastReadbackSummary = { ...summary, tenantId };
    renderReadbackReport(summary);
    await refreshState({ announce: false });
    setStatus("ready", "认证验收通过", "真实 Key 已完成短期 JWT、3 工具和 5 资源读回。");
    return true;
  } catch (error) {
    if (lastReadbackSummary?.tenantId === tenantId) lastReadbackSummary = null;
    renderReadbackFailure(error);
    if (currentState !== null) renderState(currentState);
    setStatus("blocked", "认证验收未通过", "请按脱敏原因检查 Key 状态、权限或运行门禁。");
    return false;
  } finally {
    apiKey = "";
    elements.runReadback.disabled = false;
    elements.readbackResults.setAttribute("aria-busy", "false");
  }
}

document.getElementById("identity-form").addEventListener("submit", (event) => {
  event.preventDefault();
  adminToken = elements.tokenInput.value.trim();
  elements.tokenInput.value = "";
  void refreshState();
});

document.getElementById("clear-token").addEventListener("click", () => {
  adminToken = "";
  elements.tokenInput.value = "";
  setStatus("blocked", "身份已清除", "页面内存中的管理员 JWT 已删除。");
});

document.getElementById("refresh").addEventListener("click", () => void refreshState());

document.getElementById("tenant-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const tenantId = String(values.get("tenant_id") ?? "");
  void post("/tenants", {
    schema_version: SCHEMA_VERSION,
    tenant_id: tenantId,
    display_name: String(values.get("display_name") ?? ""),
  }, {
    progressDetail: `${tenantId} / 新租户`,
    successMessage: "租户已创建",
    successDetail: `租户 ${tenantId} 已精确读回为 active。`,
    expected: {
      kind: "tenant",
      action: "tenant.create",
      tenantId,
      status: "active",
    },
    beforeRender: () => { selectedTenantId = tenantId; },
    onSuccess: () => form.reset(),
  });
});

document.getElementById("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (pendingApiKey.length > 0) {
    setStatus("blocked", "请先处理当前一次性 Key", "完成安全交付或放弃并吊销后，才能继续签发。");
    scrollToControl("#one-time-panel");
    return;
  }
  const form = event.currentTarget;
  const values = new FormData(form);
  const toolNames = selectedTools();
  const tenantId = String(values.get("tenant_id") ?? "");
  const clientId = String(values.get("client_id") ?? "");
  const label = String(values.get("label") ?? "");
  const expiresInSeconds = Number(values.get("expires_in_seconds"));
  if (toolNames.length === 0) {
    setStatus("blocked", "不能签发", "请勾选至少一个内置工具权限。");
    return;
  }
  if (tenantId.length === 0) {
    setStatus("blocked", "不能签发", "请选择 active 租户。");
    return;
  }
  openActionDialog({
    title: "签发一次性长期 Key",
    detail: "完整 Key 只显示一次。签发后必须先保存到批准的 Secret Manager，再确认交付。",
    confirmation: "我已准备好立即安全保存一次性 Key",
    confirmLabel: "签发并显示一次性 Key",
    impact: [
      ["租户", tenantId],
      ["调用方", clientId],
      ["完整权限", toolSummary(toolNames)],
      ["有效期", expiresInSeconds === 86_400 ? "1 天" : "30 天"],
    ],
    action: () => post("/credentials", {
      schema_version: SCHEMA_VERSION,
      tenant_id: tenantId,
      client_id: clientId,
      label,
      tool_names: toolNames,
      expires_in_seconds: expiresInSeconds,
    }, {
      progressDetail: `${tenantId} / ${clientId} / ${toolSummary(toolNames)}`,
      successMessage: "Key 已签发，等待安全交付",
      successDetail: "新凭证与完整工具权限已精确读回为 pending_delivery。",
      secret: true,
      expected: (payload) => ({
        kind: "credential",
        action: "credential.issue",
        credentialId: payload?.data?.credential?.credential_id,
        status: "pending_delivery",
        toolNames,
      }),
      beforeRender: () => { selectedTenantId = tenantId; },
      onSuccess: () => {
        form.reset();
        elements.keyTenant.value = tenantId;
        scrollToControl("#one-time-panel");
      },
    }),
  });
});

document.getElementById("copy-key").addEventListener("click", async () => {
  const value = pendingApiKey;
  if (value.length === 0) return;
  try {
    await navigator.clipboard.writeText(value);
    elements.secretStatus.textContent = "已复制；请确认已写入调用方批准的 Secret Manager。";
    setStatus("ready", "已复制一次性 Key", "页面不会自动把“复制”当作安全交付完成。");
  } catch {
    setStatus("blocked", "复制失败", "请使用浏览器允许的安全复制方式。");
  }
});

elements.deliveryAcknowledgement.addEventListener("change", updateDeliveryControls);
elements.acknowledgeKey.addEventListener("click", () => {
  if (typeof pendingCredentialId === "string") void acknowledgeDelivery(pendingCredentialId);
});
elements.acknowledgeAndVerify.addEventListener("click", async () => {
  if (typeof pendingCredentialId !== "string" || pendingApiKey.length === 0) return;
  const credentialId = pendingCredentialId;
  const tenantId = credentialById(credentialId)?.tenant_id ?? selectedTenantId;
  let apiKey = pendingApiKey;
  const acknowledged = await acknowledgeDelivery(credentialId, { keepSecret: true });
  if (acknowledged === null) {
    apiKey = "";
    return;
  }
  hideOneTimeKey();
  await executeCredentialReadback(apiKey, tenantId);
  apiKey = "";
});
elements.discardKey.addEventListener("click", () => {
  if (typeof pendingCredentialId !== "string") return;
  const credential = credentialById(pendingCredentialId);
  if (credential === null) return;
  openActionDialog({
    title: "放弃并吊销一次性 Key",
    detail: "本页中的完整 Key 会立即清除，凭证记录保留为 revoked，之后需要重新签发。",
    confirmation: `我确认放弃并吊销尾号 ${credential.secret_last_four} 的 Key`,
    confirmLabel: "清除并吊销 Key",
    danger: true,
    impact: [
      ["租户", credential.tenant_id],
      ["调用方", credential.client_id],
      ["权限", toolSummary(credential.tool_names)],
    ],
    action: () => revokeCredential(credential),
  });
});

elements.actionConfirmation.addEventListener("change", updateDialogControls);
elements.rotationTools.addEventListener("change", updateDialogControls);
elements.actionDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value !== "confirm") {
    closeActionDialog();
    return;
  }
  updateDialogControls();
  if (elements.confirmAction.disabled || typeof pendingDialogAction !== "function") return;
  const action = pendingDialogAction;
  closeActionDialog();
  void action();
});
elements.actionDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeActionDialog();
});

elements.tenantContext.addEventListener("change", () => {
  selectedTenantId = elements.tenantContext.value;
  if (currentState !== null) renderState(currentState);
});
elements.nextAction.addEventListener("click", () => {
  if (typeof nextActionHandler === "function") void nextActionHandler();
});
elements.clientProfile.addEventListener("change", renderClientConfig);
elements.copyClientConfig.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.clientConfigPreview.textContent);
    setStatus("ready", "接入清单已复制", "清单不包含长期 Key 或短期 JWT，仍需受控凭证注入。");
  } catch {
    setStatus("blocked", "复制失败", "请使用浏览器允许的安全复制方式。");
  }
});

document.getElementById("readback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let apiKey = elements.readbackApiKey.value.trim();
  elements.readbackApiKey.value = "";
  await executeCredentialReadback(apiKey, selectedTenantId);
  apiKey = "";
});
document.getElementById("clear-readback").addEventListener("click", () => {
  elements.readbackApiKey.value = "";
  lastReadbackSummary = null;
  elements.readbackResults.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "已清除页面内凭证输入和脱敏验收结果。";
  elements.readbackResults.append(empty);
  if (currentState !== null) renderState(currentState);
});

globalThis.addEventListener("beforeunload", (event) => {
  if (pendingApiKey.length === 0) return;
  event.preventDefault();
  event.returnValue = "";
});

void refreshState();
