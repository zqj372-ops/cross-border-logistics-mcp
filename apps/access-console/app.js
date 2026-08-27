const SCHEMA_VERSION = "2026-08-27.v1";
const API_ROOT = "/admin/api/v1/access";
const T0_TOOLS = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
]);

const elements = Object.freeze({
  statusDot: document.getElementById("status-dot"),
  statusTitle: document.getElementById("status-title"),
  statusDetail: document.getElementById("status-detail"),
  tokenInput: document.getElementById("admin-token"),
  tenants: document.getElementById("tenants"),
  clients: document.getElementById("clients"),
  credentials: document.getElementById("credentials"),
  operations: document.getElementById("operations"),
  oneTimePanel: document.getElementById("one-time-panel"),
  oneTimeKey: document.getElementById("one-time-key"),
});

let adminToken = "";
let pendingCredentialId = null;

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

function row(label, value) {
  const paragraph = document.createElement("p");
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

function renderTenants(records) {
  elements.tenants.replaceChildren();
  if (!Array.isArray(records) || records.length === 0) {
    renderEmpty(elements.tenants);
    return;
  }
  for (const tenant of records) {
    const article = document.createElement("article");
    article.className = "record";
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
    const payload = await api("/state");
    renderState(payload);
    setStatus("ready", "状态已读回", "租户、Key 权限和操作状态均来自服务端。");
  } catch (error) {
    setStatus("blocked", "状态不可用", reason(error));
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
    await refreshState({ announce: false });
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

function acknowledgeDelivery(credentialId) {
  return post(`/credentials/${encodeURIComponent(credentialId)}/acknowledge-delivery`, {
    schema_version: SCHEMA_VERSION,
    reason_code: "operator_confirmed_secure_storage",
  }, "Key 交付已确认");
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

void refreshState();
