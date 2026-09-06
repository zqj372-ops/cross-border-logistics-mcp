const SCHEMA_VERSION = "2026-08-27.v1";
const API_ROOT = "/admin/api/v1/access";
const T0_TOOLS = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
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
  rotationDialog: document.getElementById("rotation-dialog"),
  rotationSummary: document.getElementById("rotation-summary"),
  rotationCurrent: document.getElementById("rotation-current"),
  rotationTools: document.getElementById("rotation-tools"),
  rotationDiff: document.getElementById("rotation-diff"),
  rotationExpiry: document.getElementById("rotation-expiry"),
});

let adminToken = "";
let pendingCredentialId = null;
let pendingRotation = null;
const rotationsAwaitingReadback = new Set();

const PAGE_LABELS = Object.freeze({
  overview: ["工作台", "接入工作台"],
  access: ["接入管理", "租户、调用方与 API Key"],
  operations: ["操作记录", "操作记录"],
  identity: ["身份设置", "身份与权限边界"],
});

function showPage(page) {
  const selected = Object.hasOwn(PAGE_LABELS, page) ? page : "overview";
  document.querySelectorAll("[data-page-panel]").forEach((panel) => {
    const active = panel.dataset.pagePanel === selected;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  document.querySelectorAll("[data-page]").forEach((button) => {
    const active = button.dataset.page === selected;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.getElementById("current-page-label").textContent = PAGE_LABELS[selected][0];
  document.getElementById("page-title").textContent = PAGE_LABELS[selected][1];
  document.getElementById("main-content").focus({ preventScroll: true });
}

class ApiError extends Error {
  constructor(payload) {
    super("Access Console request failed.");
    this.payload = payload;
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
  button.addEventListener("click", () => void action(button));
  return button;
}

function renderEmpty(target) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty";
  paragraph.textContent = "暂无记录";
  target.append(paragraph);
}

function renderUnavailable(target, message) {
  target.replaceChildren();
  const paragraph = document.createElement("p");
  paragraph.className = "empty unavailable";
  paragraph.textContent = message;
  target.append(paragraph);
}

function renderUnavailableState(detail) {
  elements.overviewGenerated.textContent = "尚未读取 · 服务端状态不可用";
  elements.overviewMetrics.replaceChildren(
    metric("有效租户"), metric("有效调用方"), metric("有效 Key"),
    metric("待确认交付"), metric("24 小时调用"), metric("24 小时非成功"),
  );
  renderUnavailable(elements.readiness, "尚未读取运行状态。请先检查管理员身份与接入网关。");
  renderUnavailable(elements.recentIssues, "异常记录尚未读取，当前不能判断是否存在待处理事件。");
  renderUnavailable(elements.agentOnboarding, "接入信息尚未读取，请勿根据空白状态配置客户端。");
  renderUnavailable(elements.tenants, "租户状态尚未读取。");
  renderUnavailable(elements.clients, "调用方状态尚未读取。");
  renderUnavailable(elements.credentials, "API Key 状态尚未读取。");
  renderUnavailable(elements.operations, "操作记录尚未读取。");
  elements.routeQualification.textContent = "状态不可用";
  setStatus("blocked", "状态不可用", `请到“身份设置”确认管理员身份，再刷新状态。详情：${detail}`);
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
      if (rotationsAwaitingReadback.has(credential.credential_id)) {
        const pending = document.createElement("span");
        pending.className = "action-pending";
        pending.textContent = "轮换已提交，等待状态读回";
        actions.append(pending);
      } else {
        actions.append(actionButton("轮换 Key", (button) => openRotationDialog(credential, button)));
      }
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
    renderUnavailableState(reason(error));
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

function rotationToolNames() {
  const values = [...elements.rotationTools.querySelectorAll("input:checked")]
    .map((input) => input.value);
  return T0_TOOLS.filter((toolName) => values.includes(toolName));
}

function updateRotationDiff() {
  if (pendingRotation === null) return;
  const previous = Array.isArray(pendingRotation.credential.tool_names)
    ? pendingRotation.credential.tool_names
    : [];
  const next = rotationToolNames();
  const added = next.filter((name) => !previous.includes(name));
  const removed = previous.filter((name) => !next.includes(name));
  elements.rotationDiff.textContent = added.length === 0 && removed.length === 0
    ? "权限不变"
    : `新增：${added.join("、") || "无"}；移除：${removed.join("、") || "无"}`;
  document.getElementById("confirm-rotation").disabled = next.length === 0;
  const seconds = Number(elements.rotationExpiry.value);
  const expiresAt = new Date(Date.now() + seconds * 1000);
  const expiryLabel = seconds === 86_400 ? "从现在起 1 天" : "从现在起 30 天";
  document.getElementById("rotation-new-expiry").textContent =
    `${expiryLabel}，预计到期 ${expiresAt.toLocaleString("zh-CN", { hour12: false })}`;
}

function openRotationDialog(credential, trigger) {
  pendingRotation = { credential, trigger, attempt: null, committed: false, submitting: false };
  elements.rotationSummary.textContent = `${text(credential.label)} · ${text(credential.tenant_id)} / ${text(credential.client_id)} / Key 后四位 ${text(credential.secret_last_four)}`;
  elements.rotationCurrent.textContent = `原 Key 到期时间：${text(credential.expires_at)}；当前状态：${text(credential.effective_status)}`;
  elements.rotationTools.replaceChildren();
  const currentTools = Array.isArray(credential.tool_names) ? credential.tool_names : [];
  for (const toolName of T0_TOOLS) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = toolName;
    input.checked = currentTools.includes(toolName);
    input.addEventListener("change", updateRotationDiff);
    const caption = document.createElement("span");
    caption.textContent = toolName;
    label.append(input, caption);
    elements.rotationTools.append(label);
  }
  updateRotationDiff();
  elements.rotationDialog.showModal();
}

function lockRotationAttempt() {
  const toolNames = rotationToolNames();
  if (toolNames.length === 0) {
    setStatus("blocked", "不能轮换", "请为新 Key 保留至少一个内置工具权限。");
    return null;
  }
  const attempt = Object.freeze({
    idempotencyKey: idempotencyKey(),
    body: Object.freeze({
      schema_version: SCHEMA_VERSION,
      tool_names: Object.freeze([...toolNames]),
      expires_in_seconds: Number(elements.rotationExpiry.value),
      reason_code: "operator_rotated",
    }),
  });
  elements.rotationTools.querySelectorAll("input").forEach((input) => { input.disabled = true; });
  elements.rotationExpiry.disabled = true;
  return attempt;
}

async function submitRotation() {
  if (pendingRotation === null || pendingRotation.committed || pendingRotation.submitting) return;
  if (pendingRotation.attempt === null) {
    pendingRotation.attempt = lockRotationAttempt();
    if (pendingRotation.attempt === null) return;
  }
  pendingRotation.submitting = true;
  const confirm = document.getElementById("confirm-rotation");
  confirm.disabled = true;
  confirm.textContent = "正在轮换…";
  const credentialId = pendingRotation.credential.credential_id;
  try {
    const payload = await api(`/credentials/${encodeURIComponent(credentialId)}/rotate`, {
      method: "POST",
      body: pendingRotation.attempt.body,
      idempotencyKey: pendingRotation.attempt.idempotencyKey,
    });
    pendingRotation.committed = true;
    rotationsAwaitingReadback.add(credentialId);
    if (typeof payload?.data?.api_key === "string") {
      pendingCredentialId = payload.data.credential?.credential_id ?? null;
      elements.oneTimeKey.textContent = payload.data.api_key;
      elements.oneTimePanel.hidden = false;
    }
    confirm.textContent = "已提交";
    setStatus("working", "Key 已轮换", "新 Key 已返回，正在核验服务端状态。旧 Key 已立即失效。");
    try {
      await refreshState({ announce: false, propagate: true });
      rotationsAwaitingReadback.delete(credentialId);
      setStatus("ready", "Key 已轮换并读回", "旧 Key 已失效；请立即安全保存新 Key。");
    } catch {
      setStatus("blocked", "Key 已轮换，状态待核验", "请保存新 Key 并使用“刷新状态”继续核验；不要再次轮换。");
    }
    elements.rotationDialog.close();
    elements.oneTimePanel.scrollIntoView({ block: "center" });
  } catch (error) {
    pendingRotation.submitting = false;
    confirm.disabled = false;
    confirm.textContent = "使用同一请求重试";
    setStatus("blocked", "轮换结果未知", `${reason(error)} 已冻结本次权限和有效期；重试会复用同一幂等请求。`);
  }
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
document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});
document.querySelectorAll("[data-go-page]").forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.goPage));
});
elements.rotationExpiry.addEventListener("change", updateRotationDiff);
document.getElementById("confirm-rotation").addEventListener("click", () => void submitRotation());
elements.rotationDialog.addEventListener("close", () => {
  const trigger = pendingRotation?.trigger;
  pendingRotation = null;
  elements.rotationTools.replaceChildren();
  elements.rotationDiff.textContent = "";
  elements.rotationExpiry.disabled = false;
  elements.rotationExpiry.value = "2592000";
  const confirm = document.getElementById("confirm-rotation");
  confirm.disabled = false;
  confirm.textContent = "确认轮换";
  queueMicrotask(() => {
    if (trigger?.isConnected) trigger.focus();
    else {
      elements.credentials.tabIndex = -1;
      elements.credentials.focus();
    }
  });
});
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

void refreshState();
