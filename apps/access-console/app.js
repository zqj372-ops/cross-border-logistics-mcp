const T0_TOOLS = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
]);

const elements = Object.freeze({
  statusDot: document.getElementById("status-dot"),
  statusTitle: document.getElementById("status-title"),
  statusDetail: document.getElementById("status-detail"),
  tenants: document.getElementById("tenants"),
  clients: document.getElementById("clients"),
  credentials: document.getElementById("credentials"),
  operations: document.getElementById("operations"),
  oneTimeKey: document.getElementById("one-time-key"),
});

function text(value) {
  return typeof value === "string" ? value : "—";
}

function renderRecords(target, records, fields) {
  target.replaceChildren();
  if (!Array.isArray(records) || records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无记录";
    target.append(empty);
    return;
  }
  for (const record of records) {
    const article = document.createElement("article");
    article.className = "record";
    for (const [label, key] of fields) {
      const row = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = `${label}：`;
      row.append(strong, document.createTextNode(text(record?.[key])));
      article.append(row);
    }
    target.append(article);
  }
}

function renderState(state) {
  renderRecords(elements.tenants, state.tenants, [["名称", "displayName"], ["状态", "status"], ["标识", "tenantId"]]);
  renderRecords(elements.clients, state.clients, [["名称", "label"], ["状态", "status"], ["标识", "clientId"]]);
  renderRecords(elements.credentials, state.credentials, [["名称", "label"], ["状态", "effectiveStatus"], ["末尾", "secretLastFour"]]);
  renderRecords(elements.operations, state.operations, [["动作", "action"], ["状态", "status"], ["操作标识", "operationId"]]);
}

async function refreshState() {
  elements.statusTitle.textContent = "正在读取状态";
  try {
    const response = await fetch("/access/v1/state", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("state unavailable");
    const body = await response.json();
    renderState(body.data ?? body);
    elements.statusDot.className = "status-dot ready";
    elements.statusTitle.textContent = "状态已读回";
    elements.statusDetail.textContent = "当前视图来自服务端权威状态。";
  } catch {
    elements.statusDot.className = "status-dot blocked";
    elements.statusTitle.textContent = "状态不可用";
    elements.statusDetail.textContent = "请检查企业身份、入口和服务就绪状态。";
  }
}

function selectedTools() {
  const values = [...document.querySelectorAll("#tool-permissions input:checked")]
    .map((input) => input.value);
  return T0_TOOLS.filter((toolName) => values.includes(toolName));
}

async function submit(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error("operation failed");
  if (typeof result?.data?.api_key === "string") {
    elements.oneTimeKey.hidden = false;
    elements.oneTimeKey.textContent = result.data.api_key;
  }
  await refreshState();
}

document.getElementById("refresh").addEventListener("click", refreshState);
document.getElementById("tenant-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  void submit("/access/v1/tenants", { display_name: values.get("display_name") });
});
document.getElementById("client-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  void submit("/access/v1/clients", {
    tenant_id: values.get("tenant_id"),
    label: values.get("label"),
  });
});
document.getElementById("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const requested_tool_names = selectedTools();
  void submit("/access/v1/credentials", {
    tenant_id: values.get("tenant_id"),
    client_id: values.get("client_id"),
    label: values.get("label"),
    tool_names: requested_tool_names,
  });
});

void refreshState();
