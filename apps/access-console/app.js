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
  oneTimePanel: document.getElementById("one-time-panel"),
  oneTimeKey: document.getElementById("one-time-key"),
  readbackApiKey: document.getElementById("readback-api-key"),
  readbackResults: document.getElementById("readback-results"),
  runReadback: document.getElementById("run-readback"),
});

let adminToken = "";
let pendingCredentialId = null;

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
    return payload.reason_codes.filter((value) => typeof value === "string").join("、") || "请求被拒绝";
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
        "Idempotency-Key": idempotencyKey(),
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
    if (sessionId.length === 0) throw new ReadbackError("mcp_session_missing");
    await mcpPost(accessToken, sessionId, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, false);

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
    row("MCP session", "已建立并关闭"),
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

function actionButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "record-action secondary";
  button.textContent = label;
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
    article.dataset.state = text(tenant.status);
    article.append(
      row("名称", tenant.display_name),
      row("状态", tenant.status),
      row("标识", tenant.tenant_id),
    );
    if (Array.isArray(tenant.allowed_actions)) {
      const actions = document.createElement("div");
      actions.className = "record-actions";
      if (tenant.allowed_actions.includes("suspend")) {
        actions.append(actionButton("停用租户", () => setTenantStatus(tenant.tenant_id, "suspended")));
      }
      if (tenant.allowed_actions.includes("activate")) {
        actions.append(actionButton("恢复租户", () => setTenantStatus(tenant.tenant_id, "active")));
      }
      article.append(actions);
    }
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
    article.dataset.state = text(credential.effective_status);
    article.append(
      row("名称", credential.label),
      row("状态", credential.effective_status),
      row("租户", credential.tenant_id),
      row("调用方", credential.client_id),
      row("Key 后四位", credential.secret_last_four),
      row("权限", Array.isArray(credential.tool_names) ? credential.tool_names.join(", ") : "—"),
    );
    const actions = document.createElement("div");
    actions.className = "record-actions";
    const allowed = Array.isArray(credential.allowed_actions) ? credential.allowed_actions : [];
    if (allowed.includes("acknowledge_delivery")) {
      actions.append(actionButton("确认交付", () => acknowledgeDelivery(credential.credential_id)));
    }
    if (allowed.includes("rotate")) {
      actions.append(actionButton(
        "按当前勾选权限轮换",
        () => rotateCredential(credential.credential_id),
      ));
    }
    if (allowed.includes("revoke")) {
      actions.append(actionButton("吊销", () => revokeCredential(credential.credential_id)));
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
    article.dataset.state = text(client.status);
    article.append(
      row("名称", client.label),
      row("状态", client.status),
      row("租户", client.tenant_id),
      row("调用方", client.client_id),
    );
    const actions = document.createElement("div");
    actions.className = "record-actions";
    const allowed = Array.isArray(client.allowed_actions) ? client.allowed_actions : [];
    if (allowed.includes("disable")) {
      actions.append(actionButton(
        "停用调用方",
        () => setClientStatus(client.tenant_id, client.client_id, "disabled"),
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
  const state = payload?.data;
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

async function post(path, body, successMessage) {
  setStatus("working", "正在写入", "等待服务端提交并读回。");
  try {
    const payload = await api(path, { method: "POST", body });
    if (typeof payload?.data?.api_key === "string") {
      pendingCredentialId = payload.data.credential?.credential_id ?? null;
      elements.oneTimeKey.textContent = payload.data.api_key;
      elements.oneTimePanel.hidden = false;
    }
    const operationId = payload?.data?.operation?.operation_id;
    if (typeof operationId !== "string") {
      throw new ApiError({ reason_codes: ["readback_not_verified"] });
    }
    const readback = await refreshState({ announce: false, propagate: true });
    const operations = readback?.data?.operations;
    if (
      !Array.isArray(operations) ||
      !operations.some((operation) => operation?.operation_id === operationId)
    ) {
      throw new ApiError({ reason_codes: ["readback_not_verified"] });
    }
    setStatus("ready", successMessage, "服务端已提交并返回状态流转证据。");
    return payload;
  } catch (error) {
    setStatus("blocked", "操作未完成", reason(error));
    return null;
  }
}

function setTenantStatus(tenantId, status) {
  return post(`/tenants/${encodeURIComponent(tenantId)}/status`, {
    schema_version: SCHEMA_VERSION,
    status,
    reason_code: status === "active" ? "operator_reactivated" : "operator_suspended",
  }, status === "active" ? "租户已恢复" : "租户已停用");
}

function setClientStatus(tenantId, clientId, status) {
  return post(
    `/tenants/${encodeURIComponent(tenantId)}/clients/${encodeURIComponent(clientId)}/status`,
    {
      schema_version: SCHEMA_VERSION,
      status,
      reason_code: status === "active" ? "operator_reenabled" : "operator_disabled",
    },
    status === "active" ? "调用方已恢复" : "调用方已停用",
  );
}

async function acknowledgeDelivery(credentialId) {
  const payload = await post(`/credentials/${encodeURIComponent(credentialId)}/acknowledge-delivery`, {
    schema_version: SCHEMA_VERSION,
    reason_code: "operator_confirmed_secure_storage",
  }, "Key 交付已确认");
  if (payload !== null && pendingCredentialId === credentialId) hideOneTimeKey();
  return payload;
}

function rotateCredential(credentialId) {
  const toolNames = selectedTools();
  if (toolNames.length === 0) {
    setStatus("blocked", "不能轮换", "请先勾选至少一个内置工具权限。");
    return Promise.resolve(null);
  }
  return post(`/credentials/${encodeURIComponent(credentialId)}/rotate`, {
    schema_version: SCHEMA_VERSION,
    tool_names: toolNames,
    expires_in_seconds: expirySeconds(),
    reason_code: "operator_rotated",
  }, "Key 已轮换");
}

function revokeCredential(credentialId) {
  return post(`/credentials/${encodeURIComponent(credentialId)}/revoke`, {
    schema_version: SCHEMA_VERSION,
    reason_code: "operator_revoked",
  }, "Key 已吊销");
}

function hideOneTimeKey() {
  pendingCredentialId = null;
  elements.oneTimeKey.textContent = "";
  elements.oneTimePanel.hidden = true;
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
  const values = new FormData(event.currentTarget);
  void post("/tenants", {
    schema_version: SCHEMA_VERSION,
    tenant_id: values.get("tenant_id"),
    display_name: values.get("display_name"),
  }, "租户已创建");
});
document.getElementById("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const toolNames = selectedTools();
  if (toolNames.length === 0) {
    setStatus("blocked", "不能签发", "请勾选至少一个内置工具权限。");
    return;
  }
  void post("/credentials", {
    schema_version: SCHEMA_VERSION,
    tenant_id: values.get("tenant_id"),
    client_id: values.get("client_id"),
    label: values.get("label"),
    tool_names: toolNames,
    expires_in_seconds: Number(values.get("expires_in_seconds")),
  }, "Key 已签发，等待安全交付确认");
});
document.getElementById("copy-key").addEventListener("click", async () => {
  const value = elements.oneTimeKey.textContent;
  if (value.length === 0) return;
  try {
    await navigator.clipboard.writeText(value);
    setStatus("ready", "已复制", "请立即保存到批准的 Secret Manager。");
  } catch {
    setStatus("blocked", "复制失败", "请使用浏览器允许的安全复制方式。");
  }
});
document.getElementById("ack-key").addEventListener("click", () => {
  if (typeof pendingCredentialId === "string") void acknowledgeDelivery(pendingCredentialId);
});
document.getElementById("hide-key").addEventListener("click", hideOneTimeKey);
document.getElementById("readback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let apiKey = elements.readbackApiKey.value.trim();
  elements.readbackApiKey.value = "";
  if (apiKey.length === 0) {
    renderReadbackFailure(new ReadbackError("api_key_required"));
    return;
  }
  elements.runReadback.disabled = true;
  elements.readbackResults.setAttribute("aria-busy", "true");
  setStatus("working", "正在验收", "正在兑换短期身份并读取精确 T0 目录。");
  try {
    const summary = await runCredentialReadback(apiKey);
    renderReadbackReport(summary);
    await refreshState({ announce: false });
    setStatus("ready", "认证验收通过", "真实 Key 已完成短期 JWT、3 工具和 5 资源读回。");
  } catch (error) {
    renderReadbackFailure(error);
    setStatus("blocked", "认证验收未通过", "请按脱敏原因检查 Key 状态、权限或运行门禁。");
  } finally {
    apiKey = "";
    elements.runReadback.disabled = false;
    elements.readbackResults.setAttribute("aria-busy", "false");
  }
});
document.getElementById("clear-readback").addEventListener("click", () => {
  elements.readbackApiKey.value = "";
  elements.readbackResults.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "已清除页面内凭证输入和脱敏验收结果。";
  elements.readbackResults.append(empty);
});

void refreshState();
