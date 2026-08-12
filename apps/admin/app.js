const SNAPSHOT_OBJECT_FIELDS = ["tenant", "config", "actor", "health", "approvals"];
const SNAPSHOT_ARRAY_FIELDS = ["clients", "roles", "tools", "sources", "audit"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateSnapshot(snapshot) {
  if (!isRecord(snapshot)) throw new Error("快照必须是对象。");
  if (typeof snapshot.schema_version !== "string" || snapshot.schema_version.trim() === "") {
    throw new Error("快照缺少 schema_version，已拒绝使用。");
  }
  if (typeof snapshot.environment !== "string" || snapshot.environment.trim() === "") {
    throw new Error("快照缺少 environment，已拒绝使用。");
  }
  for (const field of SNAPSHOT_OBJECT_FIELDS) {
    if (!isRecord(snapshot[field])) throw new Error(`快照字段 ${field} 格式无效，已拒绝使用。`);
  }
  for (const field of SNAPSHOT_ARRAY_FIELDS) {
    if (!Array.isArray(snapshot[field])) throw new Error(`快照字段 ${field} 格式无效，已拒绝使用。`);
  }
  for (const field of ["changes", "chain"]) {
    if (!Array.isArray(snapshot.approvals[field])) {
      throw new Error(`快照字段 approvals.${field} 格式无效，已拒绝使用。`);
    }
  }
  return snapshot;
}

const ARCHITECTURE_TOOL_GROUPS = [
  { key: "billing", label: "报价与计费", prefixes: ["quote", "cargo"], description: "报价、货物和计费相关确定性工具。" },
  { key: "customs", label: "关务", prefixes: ["customs"], description: "关务候选与税费估算工具。" },
  { key: "container", label: "装柜", prefixes: ["container"], description: "装柜容量和理论汇总工具。" },
  { key: "platform", label: "平台支持", prefixes: ["knowledge", "system", "review"], description: "精选知识、数据状态和人工复核工具。" },
  { key: "unknown", label: "未知工具/未分类", prefixes: [], description: "前缀不在已知 allowlist 分组中的工具，原样保留。" },
];

const EXECUTION_GROUP_DEFINITIONS = [
  {
    key: "local",
    label: "本地确定性执行",
    description: "代码计算货物和装柜结果，不依赖外部业务 API。",
    toolNames: ["cargo.calculate", "container.plan_summary"],
  },
  {
    key: "external",
    label: "外部 API 窄适配",
    description: "quote → AI 报价、customs → RiskCustoms；请求时直连，单一来源故障只关闭相关工具。",
    toolNames: ["quote.canada_final_mile.calculate", "customs.ca.search", "customs.ca.estimate"],
  },
];

const APPROVAL_STAGE_DEFINITIONS = [
  { key: "draft", label: "draft", pattern: /draft|草稿/i },
  { key: "validate", label: "validate", pattern: /validate|校验|验证|核验|schema/i },
  { key: "approval", label: "approval", pattern: /approval|approve|审批|批准/i },
  { key: "publish", label: "publish", pattern: /publish|发布|commit/i },
  { key: "readback", label: "readback/rollback", pattern: /readback|read\s*back|读回|回滚|rollback/i },
];

function snapshotText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function displayNodeLabel(value, fallback) {
  const text = snapshotText(value);
  return text.trim() === "" ? fallback : text;
}

function findToolGroup(prefix) {
  return ARCHITECTURE_TOOL_GROUPS.find((group) => group.prefixes.includes(prefix))?.key ?? "unknown";
}

function deriveApprovalLifecycle(chain) {
  if (chain.length === 0) return { lifecycle: [], unmapped: [] };

  const matchedIndexes = new Set();
  const matchedStages = new Map();
  const matchingOrder = [...APPROVAL_STAGE_DEFINITIONS].sort((left, right) => {
    if (left.key === "readback") return -1;
    if (right.key === "readback") return 1;
    return 0;
  });
  for (const stage of matchingOrder) {
    const matchIndex = chain.findIndex((entry, index) => {
      if (matchedIndexes.has(index)) return false;
      const label = snapshotText(isRecord(entry) ? entry.label : undefined);
      return stage.pattern.test(label);
    });
    if (matchIndex >= 0) {
      matchedIndexes.add(matchIndex);
      matchedStages.set(stage.key, matchIndex);
    }
  }

  const lifecycle = APPROVAL_STAGE_DEFINITIONS.map((stage) => {
    const matchIndex = matchedStages.get(stage.key) ?? -1;
    if (matchIndex < 0) {
      return {
        kind: "approval",
        key: stage.key,
        label: stage.label,
        status: "empty",
        evidenceLabel: "",
        id: `approval-${stage.key}`,
      };
    }
    const entry = isRecord(chain[matchIndex]) ? chain[matchIndex] : {};
    return {
      kind: "approval",
      key: stage.key,
      label: stage.label,
      status: safeStatus(entry.status),
      evidenceLabel: displayNodeLabel(entry.label, "（步骤名称为空）"),
      id: `approval-${stage.key}`,
    };
  });

  const unmapped = chain.flatMap((entry, index) => {
    if (matchedIndexes.has(index)) return [];
    const record = isRecord(entry) ? entry : {};
    return [{
      kind: "approval",
      key: `unmapped-${index}`,
      label: displayNodeLabel(record.label, "（步骤名称为空）"),
      status: safeStatus(record.status),
      id: `approval-unmapped-${index}`,
    }];
  });
  return { lifecycle, unmapped };
}

export function deriveArchitectureModel(snapshot) {
  const data = validateSnapshot(snapshot);
  const clients = data.clients.map((item, index) => {
    const client = isRecord(item) ? item : {};
    const check = isRecord(client.check) ? client.check : {};
    return {
      kind: "client",
      id: `client-${index}`,
      label: displayNodeLabel(client.name, `客户端 ${index + 1}`),
      clientId: snapshotText(client.client_id),
      status: safeStatus(check.status),
    };
  });
  const sources = data.sources.map((item, index) => {
    const source = isRecord(item) ? item : {};
    return {
      kind: "source",
      id: `source-${index}`,
      label: displayNodeLabel(source.label ?? source.name, `来源 ${index + 1}`),
      name: snapshotText(source.name),
      type: snapshotText(source.type),
      category: snapshotText(source.category),
      businessKey: snapshotText(source.business_key),
      environment: snapshotText(source.environment),
      endpointRef: snapshotText(source.endpoint_ref),
      secretRef: snapshotText(source.secret_ref),
      sourceVersion: snapshotText(source.source_version),
      adapterContractVersion: snapshotText(source.adapter_contract_version),
      businessVersionEvidence: source.business_version_evidence,
      updateMode: snapshotText(source.update_mode),
      lastCheckedAt: snapshotText(source.last_checked_at),
      lastSuccessAt: snapshotText(source.last_success_at),
      affectedTools: Array.isArray(source.affected_tools)
        ? source.affected_tools.filter((tool) => typeof tool === "string")
        : [],
      registrationStatus: snapshotText(source.registration_status),
      readiness: safeStatus(source.readiness),
      reason: snapshotText(source.reason),
      blocker: snapshotText(source.blocker),
    };
  });
  const tools = data.tools.map((item, index) => {
    const tool = isRecord(item) ? item : {};
    const rawName = tool.name;
    const validName = typeof rawName === "string";
    const name = validName ? rawName : "";
    const prefix = validName ? name.split(".")[0] ?? "" : "";
    const execution = EXECUTION_GROUP_DEFINITIONS.find((group) => group.toolNames.includes(name));
    const source = sources.find((candidate) => candidate.affectedTools.includes(name));
    return {
      kind: "tool",
      id: `tool-${index}`,
      name: rawName,
      displayName: validName
        ? displayNodeLabel(name, "（工具名称为空）")
        : "（工具名称异常：非字符串）",
      prefix,
      groupKey: findToolGroup(prefix),
      invalidName: !validName || name.trim() === "",
      label: snapshotText(tool.label),
      permission: snapshotText(tool.permission),
      kindLabel: snapshotText(tool.kind),
      roles: Array.isArray(tool.roles) ? tool.roles.filter((role) => typeof role === "string") : [],
      executionKey: execution?.key ?? "",
      sourceBusinessKey: source?.businessKey ?? "",
      sourceReadiness: source?.readiness ?? "",
    };
  });
  const approval = deriveApprovalLifecycle(data.approvals.chain);
  const toolGroups = ARCHITECTURE_TOOL_GROUPS.map(({ key, label, description }) => ({
    key,
    label,
    description,
    tools: tools.filter((tool) => tool.groupKey === key),
  }));
  const executionGroups = EXECUTION_GROUP_DEFINITIONS.map(({ key, label, description }) => ({
    key,
    label,
    description,
    tools: tools.filter((tool) => tool.executionKey === key),
  }));

  return {
    clients,
    controlLayer: {
      kind: "control",
      id: "control-layer",
      label: "MCP 控制层",
      description: "产品边界：身份、租户、RBAC allowlist 与审计。",
    },
    tools,
    toolGroups,
    executionGroups,
    supportingTools: tools.filter((tool) => tool.executionKey === ""),
    sources,
    approvalLifecycle: approval.lifecycle,
    unmappedApprovals: approval.unmapped,
  };
}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

const STATUS_META = {
  loading: { label: "加载中", symbol: "…" },
  empty: { label: "暂无记录", symbol: "—" },
  error: { label: "加载失败", symbol: "×" },
  unavailable: { label: "不可用", symbol: "×" },
  blocked: { label: "已阻断", symbol: "!" },
  manual_review: { label: "人工复核", symbol: "!" },
  needs_input: { label: "需要补充", symbol: "!" },
  ready: { label: "已就绪", symbol: "✓" },
  success: { label: "成功", symbol: "✓" },
};

const VIEW_META = {
  overview: {
    title: "总览",
    eyebrow: "系统状态",
    description: "先看网关是否在线、哪些依赖可用，以及当前配置为什么还不能发布。",
  },
  clients: {
    title: "客户端接入",
    eyebrow: "接入边界",
    description: "管理 ChatGPT、Codex 和企业助手的身份元数据；这里只展示引用，不显示原始凭证。",
  },
  tools: {
    title: "工具权限",
    eyebrow: "RBAC allowlist",
    description: "只展示正式快照返回的角色和 Phase 1 工具，不新增通用写入口。",
  },
  adapters: {
    title: "数据源与适配器",
    eyebrow: "权威来源引用",
    description: "查看 Quote Engine、RiskCustoms、精选知识、状态和复核任务的引用与就绪状态。",
  },
  architecture: {
    title: "系统结构",
    eyebrow: "静态结构边界",
    description: "按快照展示 clients、MCP 控制层、tools 和 sources 的关系，不代表实时网络拓扑。",
  },
  approvals: {
    title: "审批与发布",
    eyebrow: "draft → validate → approval → publish",
    description: "浏览脱敏差异和审批链；正式写操作必须经过校验、审批和写后读回。",
  },
  audit: {
    title: "审计日志",
    eyebrow: "可追溯记录",
    description: "只展示 actor、租户、动作、结果、原因、版本和 trace id，敏感原文不进入日志。",
  },
};

const state = isBrowser
  ? {
      mode: new URLSearchParams(window.location.search).get("fixture") === "1" ? "fixture" : "live",
      view: getViewFromHash(),
      data: null,
      loading: true,
      error: null,
      roleFilter: "all",
      localDraft: null,
      architectureSelection: null,
    }
  : null;

const content = isBrowser ? document.querySelector("#content") : null;
const liveRegion = isBrowser ? document.querySelector("#live-region") : null;
const main = isBrowser ? document.querySelector("#main-content") : null;
const dialog = isBrowser ? document.querySelector("#detail-dialog") : null;
let dialogTrigger = null;

function getViewFromHash() {
  const candidate = window.location.hash.slice(1);
  return Object.hasOwn(VIEW_META, candidate) ? candidate : "overview";
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function display(value, fallback = "—") {
  if (value === undefined || value === null || value === "") return fallback;
  return escapeHtml(value);
}

function displayList(value, fallback = "未返回") {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item) => typeof item === "string" && item.trim() !== "");
  return items.length ? items.map((item) => display(item)).join("、") : fallback;
}

function sourceEvidenceMarkup(value) {
  if (!isRecord(value)) return display(value, "未返回");
  const entries = Object.entries(value);
  if (entries.length === 0) return "未返回";
  return entries
    .map(([key, item]) => `<span class="sub-cell"><strong>${escapeHtml(key)}：</strong>${display(item, "未返回")}</span>`)
    .join("");
}

function safeStatus(status) {
  return Object.hasOwn(STATUS_META, status) ? status : "empty";
}

function statusMarkup(status, label) {
  const key = safeStatus(status);
  const meta = STATUS_META[key];
  return `<span class="status-pill status-${key}"><span class="status-icon" aria-hidden="true">${meta.symbol}</span>${escapeHtml(label ?? meta.label)}</span>`;
}

function roleLabel(role, data = state.data) {
  const roles = Array.isArray(data?.roles) ? data.roles : [];
  const record = roles.find((item) => item.key === role);
  return display(record?.label || role);
}

function roleChips(roles, selectedRole = null) {
  if (!Array.isArray(roles) || roles.length === 0) return statusMarkup("empty", "没有授权角色");
  return `<div class="role-chips">${roles.map((role) => `<span class="role-chip${selectedRole === role ? " is-selected" : ""}">${roleLabel(role)}</span>`).join("")}</div>`;
}

function metricCard(label, value, detail, status, icon) {
  return `<article class="metric-card">
    <div class="metric-top">
      <span class="metric-label">${escapeHtml(label)}</span>
      <span class="metric-icon" data-icon="${escapeHtml(icon)}" aria-hidden="true"></span>
    </div>
    <div class="metric-value">${display(value)}</div>
    <div class="metric-detail">${statusMarkup(status)} ${display(detail, "")}</div>
  </article>`;
}

function pageHeader(view, actions = "") {
  const meta = VIEW_META[view];
  return `<div class="page-header">
    <div>
      <span class="eyebrow">${escapeHtml(meta.eyebrow)}</span>
      <h1>${escapeHtml(meta.title)}</h1>
      <p>${escapeHtml(meta.description)}</p>
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ""}
  </div>`;
}

function modeBanner() {
  if (state.mode === "fixture") {
    return `<div class="callout callout-warning" role="status">
      <div class="callout-head"><h2>演示数据</h2>${statusMarkup("manual_review", "未连接正式后台")}</div>
      <p>当前由 URL 的 <code>?fixture=1</code> 明确启用演示快照。发布、回滚和保存到服务器已禁用；本地差异只在浏览器中预览，未持久化。</p>
    </div>`;
  }
  return `<div class="callout callout-info" role="status">
    <div class="callout-head"><h2>正式快照入口</h2>${statusMarkup("unavailable", "仅同源 API")}</div>
    <p>页面只请求 <code>GET /admin/api/v1/snapshot</code>。请求失败会保持不可用，不会回退到演示数据或内置默认配置。</p>
  </div>`;
}

function emptyState(title, detail) {
  return `<div class="empty-state" data-state="empty">
    ${statusMarkup("empty")}
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(detail)}</p>
  </div>`;
}

function renderLoading() {
  return `<section class="loading-panel" data-state="loading" aria-labelledby="loading-title">
    <div class="loading-spinner" aria-hidden="true"></div>
    ${statusMarkup("loading")}
    <h1 id="loading-title">加载中</h1>
    <p>正在读取控制台快照，请稍候。</p>
  </section>`;
}

function renderError() {
  const message = state.error?.message ?? "正式后台快照暂时不能读取。";
  return `<section class="error-panel" data-state="unavailable" aria-labelledby="error-title">
    ${statusMarkup("error", "加载失败")}
    <h1 id="error-title">正式快照不可用</h1>
    <p>${escapeHtml(message)}</p>
    <p>请检查同源后台是否提供 <code>GET /admin/api/v1/snapshot</code>；本页不会自动切换到演示数据。</p>
    <button class="button button-secondary" type="button" data-action="retry"><span class="button-icon" data-icon="refresh" aria-hidden="true"></span>重新读取</button>
  </section>`;
}

function renderSourceTable(sources, withActions = false) {
  if (!Array.isArray(sources) || sources.length === 0) return emptyState("暂无适配器记录", "正式快照没有返回数据源，不能用相似名称补齐。");
  return `<div class="table-scroll" role="region" aria-label="数据源和适配器表格" tabindex="0">
    <table class="data-table">
      <thead><tr><th scope="col">数据源</th><th scope="col">endpoint_ref</th><th scope="col">secret_ref</th><th scope="col">source version</th><th scope="col">就绪状态</th>${withActions ? "<th scope=\"col\">本地操作</th>" : ""}</tr></thead>
      <tbody>${sources.map((item) => {
        const source = isRecord(item) ? item : {};
        return `<tr>
        <td><span class="primary-cell">${display(source.label ?? source.name, "未返回")}</span><span class="sub-cell">${display(source.type, "未返回")}</span></td>
        <td><span class="codeish">${display(safeOpaqueReference(source.endpoint_ref, "endpoint_ref"))}</span></td>
        <td><span class="codeish">${display(safeOpaqueReference(source.secret_ref, "secret_ref"))}</span><span class="sub-cell">只显示引用，不显示原始凭证</span></td>
        <td><span class="codeish">${display(source.source_version, "未返回")}</span></td>
        <td>${statusMarkup(source.readiness)}<span class="sub-cell">${display(source.reason, "未返回")}</span></td>
        ${withActions ? `<td><button class="button button-secondary" type="button" data-action="edit-source" data-source="${escapeHtml(source.name)}"><span class="button-icon" data-icon="edit" aria-hidden="true"></span>生成本地草稿</button></td>` : ""}
      </tr>`;
      }).join("")}</tbody>
  </table>
</div>`;
}

function renderBusinessSourceCard(item) {
  const source = isRecord(item) ? item : {};
  return `<article class="source-api-card">
    <div class="source-api-card-head">
      <div><span class="eyebrow">业务 API</span><h3>${display(source.label ?? source.name, "未返回")}</h3><p>${display(source.environment, "未返回")}</p></div>
      ${statusMarkup(source.readiness)}
    </div>
    <dl class="source-api-details">
      <div class="source-api-row"><dt>endpoint_ref</dt><dd class="codeish">${display(safeOpaqueReference(source.endpoint_ref, "endpoint_ref"))}</dd></div>
      <div class="source-api-row"><dt>secret_ref</dt><dd class="codeish">${display(safeOpaqueReference(source.secret_ref, "secret_ref"))}</dd></div>
      <div class="source-api-row"><dt>adapter contract version</dt><dd class="codeish">${display(source.adapter_contract_version, "未返回")}</dd></div>
      <div class="source-api-row"><dt>business version evidence</dt><dd>${sourceEvidenceMarkup(source.business_version_evidence)}</dd></div>
      <div class="source-api-row"><dt>update mode</dt><dd>${display(source.update_mode, "未返回")}</dd></div>
      <div class="source-api-row"><dt>last_checked_at</dt><dd>${display(source.last_checked_at, "未返回")}</dd></div>
      <div class="source-api-row"><dt>last_success_at</dt><dd>${display(source.last_success_at, "未返回")}</dd></div>
      <div class="source-api-row"><dt>affected_tools</dt><dd class="codeish">${displayList(source.affected_tools)}</dd></div>
      <div class="source-api-row"><dt>registration</dt><dd>${display(source.registration_status, "未返回")}</dd></div>
    </dl>
    <div class="source-api-reason"><strong>reason</strong><p>${display(source.reason, "未返回")}</p><strong>blocker</strong><p>${display(source.blocker, "未返回")}</p></div>
  </article>`;
}

function renderOverview(data) {
  const health = data.health ?? {};
  const config = data.config ?? {};
  const approvals = data.approvals ?? {};
  const blockers = Array.isArray(data.blockers) ? data.blockers : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const pendingCount = Array.isArray(approvals.changes) ? approvals.changes.filter((change) => change.status !== "ready").length : 0;
  const chain = Array.isArray(approvals.chain) ? approvals.chain : [];
  const legend = Array.isArray(data.status_legend) ? data.status_legend : [];

  return `${pageHeader("overview", `<button class="button button-secondary" type="button" data-action="retry"><span class="button-icon" data-icon="refresh" aria-hidden="true"></span>重新读取</button>`)}
    ${modeBanner()}
    <div class="metric-grid" aria-label="核心状态">
      ${metricCard("进程健康（/healthz）", health.healthz?.value, health.healthz?.detail, health.healthz?.status ?? "empty", "overview")}
      ${metricCard("发布就绪（/readyz）", health.readyz?.value, health.readyz?.detail, health.readyz?.status ?? "empty", "approval")}
      ${metricCard("当前发布版本", config.current_version, `最近发布：${display(config.last_published_at)}`, "manual_review", "adapter")}
      ${metricCard("待处理项", `${pendingCount} 项`, "需要人工确认或补充信息", pendingCount > 0 ? "needs_input" : "ready", "audit")}
    </div>
    <div class="callout callout-warning" role="alert">
      <div class="callout-head"><h2>当前阻断原因</h2>${statusMarkup("blocked")}</div>
      ${blockers.length ? `<ul>${blockers.map((item) => `<li>${display(item)}</li>`).join("")}</ul>` : `<p>暂无阻断说明；仍应以正式快照和写后读回为准。</p>`}
    </div>
    <div class="section-grid section-grid-wide">
      <section class="panel" aria-labelledby="overview-sources-title">
        <div class="card-head"><div><h2 id="overview-sources-title">数据源就绪情况</h2><p>状态 success 不等于业务数据可发布；RiskCustoms 必须保留 ready 门禁。</p></div><span class="status-pill status-neutral">${sources.length} 个来源</span></div>
        ${renderSourceTable(sources)}
      </section>
      <section class="panel" aria-labelledby="approval-chain-title">
        <div class="card-head"><div><h2 id="approval-chain-title">发布门槛</h2><p>每一步都要有版本、审批和读回证据。</p></div>${statusMarkup(approvals.validation?.status ?? "empty")}</div>
        ${chain.length ? `<ol class="step-list">${chain.map((item) => `<li class="step-item" data-status="${safeStatus(item.status)}"><span class="step-title">${display(item.label)}</span><span>${statusMarkup(item.status)}</span><span class="step-detail">${display(item.detail)}</span></li>`).join("")}</ol>` : emptyState("暂无审批链", "正式快照没有返回审批步骤。")}
      </section>
      <section class="panel panel-full" aria-labelledby="status-guide-title">
        <div class="card-head"><div><h2 id="status-guide-title">状态说明</h2><p>文字、图标和颜色同时表达状态，不靠颜色单独判断。</p></div></div>
        <div class="state-guide">${legend.length ? legend.map((item) => `<div class="state-guide-item"><div>${statusMarkup(item.key, item.label)}</div><p>${display(item.detail)}</p></div>`).join("") : emptyState("暂无状态说明", "正式快照没有返回状态文案。")}</div>
      </section>
    </div>`;
}

function renderClients(data) {
  const clients = Array.isArray(data.clients) ? data.clients : [];
  return `${pageHeader("clients")}
    ${modeBanner()}
    <section class="panel" aria-labelledby="clients-table-title">
      <div class="card-head"><div><h2 id="clients-table-title">已登记客户端</h2><p>issuer / audience / allowed origins 是接入校验信息；原始凭证永不在此显示。</p></div>${statusMarkup(clients.length ? "ready" : "empty", clients.length ? "仅元数据" : "暂无客户端")}</div>
      ${clients.length ? `<div class="client-card-grid">${clients.map((client) => `<article class="client-card">
        <div class="client-card-head"><div><h3>${display(client.name)}</h3><p class="codeish">${display(client.client_id)}</p></div>${statusMarkup(client.check?.status ?? "empty")}</div>
        <dl class="ref-list">
          <div class="ref-row"><dt>issuer</dt><dd class="codeish">${display(client.issuer)}</dd></div>
          <div class="ref-row"><dt>audience</dt><dd class="codeish">${display(client.audience)}</dd></div>
          <div class="ref-row"><dt>allowed origins</dt><dd>${Array.isArray(client.allowed_origins) && client.allowed_origins.length ? client.allowed_origins.map((origin) => `<span class="codeish">${display(origin)}</span>`).join("<br />") : statusMarkup("blocked", "未登记")}</dd></div>
        </dl>
        <p><strong>最近校验：</strong>${display(client.check?.checked_at)}<br />${display(client.check?.detail)}</p>
      </article>`).join("")}</div>` : emptyState("暂无客户端接入记录", "没有快照数据时不自动生成 client_id 或允许来源。")}
    </section>
    <div class="section-grid">
      <section class="panel" aria-labelledby="client-rule-title"><div class="card-head"><div><h2 id="client-rule-title">接入规则</h2><p>客户端不是业务角色，actor 和租户必须由服务端认证后绑定。</p></div></div><ul class="plain-list"><li>只显示 client_id、issuer、audience 和允许来源。</li><li>租户、actor、角色和会话不能由客户端自报。</li><li>校验失败显示 blocked 或 manual_review，不静默放行。</li></ul></section>
      <section class="panel" aria-labelledby="client-secret-title"><div class="card-head"><div><h2 id="client-secret-title">凭证边界</h2><p>页面不收集、不保存、不回显原始凭证。</p></div>${statusMarkup("blocked", "原始凭证隐藏")}</div><p class="muted">适配器只使用服务端注入的最小权限引用；控制台展示时也只保留 opaque reference。</p></section>
    </div>`;
}

function renderTools(data) {
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const roles = Array.isArray(data.roles) ? data.roles : [];
  const permissionDataReady = roles.length > 0 && tools.length > 0;
  const visibleTools = state.roleFilter === "all" ? tools : tools.filter((tool) => tool.roles?.includes(state.roleFilter));
  return `${pageHeader("tools")}
    ${modeBanner()}
    <div class="callout callout-info" role="note"><div class="callout-head"><h2>权限边界</h2>${statusMarkup(permissionDataReady ? "ready" : "unavailable", permissionDataReady ? "快照授权" : "授权数据不可用")}</div><p>下面的角色和工具来自平台 RBAC。写工具只有保存报价草稿和创建人工复核；没有 generic write 或通用提交按钮。</p></div>
    <section class="panel" aria-labelledby="tool-table-title">
      <div class="card-head"><div><h2 id="tool-table-title">Phase 1 工具权限</h2><p>读/写 kind 只说明工具边界，不代表当前下游适配器已经就绪。</p></div><span class="status-pill status-neutral">${tools.length} 个工具</span></div>
      <div class="filter-bar"><div class="field"><label for="role-filter">按角色筛选</label><select id="role-filter" data-role-filter><option value="all"${state.roleFilter === "all" ? " selected" : ""}>全部角色</option>${roles.map((role) => `<option value="${escapeHtml(role.key)}"${state.roleFilter === role.key ? " selected" : ""}>${roleLabel(role.key)}</option>`).join("")}</select></div><p class="field-help">选中角色后只看它能使用的工具。</p></div>
      ${visibleTools.length ? `<div class="table-scroll" role="region" aria-label="工具权限表格，可横向滚动" tabindex="0"><table class="data-table table-wide"><thead><tr><th scope="col">工具名称</th><th scope="col">中文说明</th><th scope="col">permission</th><th scope="col">kind</th><th scope="col">角色授权</th></tr></thead><tbody>${visibleTools.map((tool) => `<tr><td><span class="primary-cell codeish">${display(tool.name)}</span></td><td>${display(tool.description)}<span class="sub-cell">${display(tool.label)}</span></td><td><span class="codeish">${display(tool.permission)}</span></td><td>${tool.kind === "write" ? statusMarkup("manual_review", "受控写入") : statusMarkup("ready", "只读")}</td><td>${roleChips(tool.roles, state.roleFilter === "all" ? null : state.roleFilter)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("暂无匹配工具", "这个角色没有返回可用工具，不能自行补权限。")}
    </section>
    <section class="panel" aria-labelledby="role-list-title"><div class="card-head"><div><h2 id="role-list-title">角色授权</h2><p>角色名称和代码只来自当前快照；新增角色不在本原型中创建。</p></div></div>${roles.length ? `<div class="role-grid">${roles.map((role) => `<article class="role-card"><div class="role-card-head"><h3>${roleLabel(role.key)}</h3><span class="role-key codeish">${display(role.key)}</span></div><p>${display(role.description, "由服务端策略决定可见范围。")}</p></article>`).join("")}</div>` : emptyState("暂无角色授权数据", "正式快照没有返回角色，不能生成默认权限。")}</section>`;
}

function renderAdapters(data) {
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const businessSources = sources.filter((source) => isRecord(source) && source.category === "business_api");
  const supportingSources = sources.filter((source) => !isRecord(source) || source.category !== "business_api");
  const localDraft = state.localDraft;
  return `${pageHeader("adapters")}
    ${modeBanner()}
    <div class="callout callout-info" role="note"><div class="callout-head"><h2>失败隔离</h2><span class="architecture-static-tag">按工具边界</span></div><p>一个业务 API 不可达，只关闭它的 affected_tools；只有身份、审计、session 等平台基础设施故障才影响全局 <code>/readyz</code>。</p></div>
    ${localDraft ? `<div class="callout callout-info" role="status"><div class="callout-head"><h2>本地草稿已生成</h2>${statusMarkup("needs_input", "未持久化")}</div><p>已在浏览器中记录“${display(localDraft)}”的预览意图；没有请求正式后台，也没有修改权威数据。</p><div class="button-row"><button class="button button-secondary" type="button" data-action="clear-local-draft">清除本地草稿</button></div></div>` : ""}
    <section class="panel source-api-section" aria-labelledby="business-api-title">
      <div class="card-head"><div><h2 id="business-api-title">API 连接状态</h2><p>业务 API 每次请求时直连，不缓存、不轮询；卡片状态不聚合为整个 MCP 健康。</p></div><span class="status-pill status-neutral">${businessSources.length ? `${businessSources.length} 张业务卡` : "未返回业务卡"}</span></div>
      ${businessSources.length ? `<div class="source-api-grid">${businessSources.map(renderBusinessSourceCard).join("")}</div>` : emptyState("暂无业务 API 状态卡", "快照没有返回 category=business_api 的来源；不依据名称补造业务状态。")}
    </section>
    <section class="panel" aria-labelledby="adapter-table-title">
      <div class="card-head"><div><h2 id="adapter-table-title">其他适配器引用</h2><p>knowledge / status / review 等普通引用仍来自快照；不复制报价、关税或业务记录。</p></div><span class="status-pill status-neutral">${supportingSources.length ? `${supportingSources.length} 个引用` : "暂无来源"}</span></div>
      ${renderSourceTable(supportingSources, true)}
    </section>
    <div class="section-grid">
      <section class="panel" aria-labelledby="adapter-boundary-title"><div class="card-head"><div><h2 id="adapter-boundary-title">权威边界</h2><p>专业词旁边给出操作含义。</p></div></div><dl class="key-value-list"><div class="key-value-row"><dt>Quote Engine</dt><dd>报价仍由现有报价系统计算；MCP 只读取版本或保存不可发送草稿。</dd></div><div class="key-value-row"><dt>RiskCustoms</dt><dd>关务仍由 RiskCustoms 提供；ready=false 时必须显示不可用或人工复核。</dd></div><div class="key-value-row"><dt>确定性工具</dt><dd>货物、分泡和装柜由代码计算；AI 只能解释或预填。</dd></div></dl></section>
      <section class="panel" aria-labelledby="adapter-failure-title"><div class="card-head"><div><h2 id="adapter-failure-title">失败处理</h2><p>没有可靠来源就停在当前状态。</p></div>${statusMarkup("unavailable")}</div><ul class="plain-list"><li>端点不可达：unavailable（不可用）。</li><li>版本或租户边界不清：manual_review（人工复核）。</li><li>权限或阶段禁止：blocked（已阻断）。</li><li>不使用地图、聊天或相似记录补齐权威数据。</li></ul></section>
    </div>`;
}

function renderApprovals(data) {
  const approvals = data.approvals ?? {};
  const changes = Array.isArray(approvals.changes) ? approvals.changes : [];
  const chain = Array.isArray(approvals.chain) ? approvals.chain : [];
  const draft = approvals.draft ?? {};
  return `${pageHeader("approvals", `<button class="button button-secondary" type="button" data-action="preview-diff"><span class="button-icon" data-icon="preview" aria-hidden="true"></span>预览差异</button>`)}
    ${modeBanner()}
    <section class="panel" aria-labelledby="approval-workflow-title">
      <div class="card-head"><div><h2 id="approval-workflow-title">草稿到发布</h2><p>preview 不写外部系统；commit 必须通过审批并完成写后读回。</p></div>${statusMarkup(approvals.validation?.status ?? "empty")}</div>
      <div class="approval-layout">
        <div class="approval-summary"><span class="eyebrow">当前草稿</span><h3 class="codeish">${display(draft.version)}</h3><p>创建人：${display(draft.owner)}</p><p>创建时间：${display(draft.created_at)}</p><p>${display(draft.persistence, "持久化状态未知")}</p><div class="button-row"><button class="button button-primary" type="button" data-action="preview-diff"><span class="button-icon" data-icon="preview" aria-hidden="true"></span>查看本地差异</button><button class="button button-secondary" type="button" disabled title="未连接正式后台；发布接口尚未提供" aria-disabled="true">发布到正式</button></div></div>
        <ol class="step-list" aria-label="审批链">${chain.length ? chain.map((item) => `<li class="step-item" data-status="${safeStatus(item.status)}"><span class="step-title">${display(item.label)}</span><span>${statusMarkup(item.status)}</span><span class="step-detail">${display(item.detail)}</span></li>`).join("") : `<li>${emptyState("暂无审批链", "没有快照数据时不创建默认审批人。")}</li>`}</ol>
      </div>
    </section>
    <section class="panel" aria-labelledby="diff-table-title"><div class="card-head"><div><h2 id="diff-table-title">草稿差异</h2><p>差异仅为演示引用和状态，不包含价格、税务材料、地址或原始凭证。</p></div>${statusMarkup(changes.length ? "manual_review" : "empty", changes.length ? `${changes.length} 项待确认` : "暂无差异")}</div>${changes.length ? `<div class="table-scroll" role="region" aria-label="草稿差异表格" tabindex="0"><table class="data-table"><thead><tr><th scope="col">配置路径</th><th scope="col">变更前</th><th scope="col">变更后</th><th scope="col">校验结果</th></tr></thead><tbody>${changes.map((change) => `<tr><td class="codeish">${display(change.path)}</td><td>${display(change.before)}</td><td>${display(change.after)}</td><td>${statusMarkup(change.status)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("暂无草稿差异", "没有差异时不自动生成发布内容。")}</section>
    <div class="callout callout-warning" role="alert"><div class="callout-head"><h2>真实操作仍被禁用</h2>${statusMarkup("blocked", "fixture / 未接入")}</div><p>“发布到正式”“回滚版本”“保存到服务器”需要未来的 draft → validate/preview → approval → publish → readback/rollback API。本任务不伪造成功。</p><div class="button-row"><button class="button button-secondary" type="button" disabled title="未连接正式后台；回滚接口尚未提供" aria-disabled="true">回滚正式版本</button></div></div>`;
}

function renderAudit(data) {
  const entries = Array.isArray(data.audit) ? data.audit : [];
  return `${pageHeader("audit")}
    ${modeBanner()}
    <section class="panel" aria-labelledby="audit-table-title">
      <div class="card-head"><div><h2 id="audit-table-title">审计事件</h2><p>只保留脱敏关联字段；完整地址、报价明细、税务材料和凭证不写入普通日志。</p></div>${statusMarkup(entries.length ? "ready" : "empty", entries.length ? `${entries.length} 条记录` : "暂无记录")}</div>
      ${entries.length ? `<div class="table-scroll" role="region" aria-label="审计日志表格" tabindex="0"><table class="data-table table-wide"><thead><tr><th scope="col">actor</th><th scope="col">tenant</th><th scope="col">action</th><th scope="col">result</th><th scope="col">reason</th><th scope="col">config version</th><th scope="col">trace id</th></tr></thead><tbody>${entries.map((entry) => `<tr><td class="codeish">${display(entry.actor)}</td><td class="codeish">${display(entry.tenant)}</td><td class="codeish">${display(entry.action)}</td><td>${statusMarkup(entry.result)}</td><td>${display(entry.reason)}</td><td class="codeish">${display(entry.config_version)}</td><td class="codeish">${display(entry.trace_id)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("暂无审计记录", "没有快照数据时不创建假日志，也不会猜测操作结果。")}
    </section>
    <section class="panel" aria-labelledby="audit-rule-title"><div class="card-head"><div><h2 id="audit-rule-title">日志最小化</h2><p>审计关联足够追责，但不把客户内容变成日志副本。</p></div>${statusMarkup("ready", "脱敏摘要")}</div><div class="state-guide"><div class="state-guide-item"><strong>保留</strong><p>tenant、actor、client、tool、版本、状态、reason code、trace id。</p></div><div class="state-guide-item"><strong>不保留</strong><p>客户地址、报价明细、税务材料全文、原始聊天和凭证。</p></div><div class="state-guide-item"><strong>写入失败</strong><p>审计或读回失败时转 manual_review，不报告假成功。</p></div></div></section>`;
}

export function safeOpaqueReference(value, prefix) {
  const reference = snapshotText(value).trim();
  if (reference === "") return "未返回";
  const suffix = reference.startsWith(`${prefix}:`) ? reference.slice(prefix.length + 1) : "";
  if (!reference.startsWith(`${prefix}:`) || /:\/\//.test(reference) || /bearer|token|password|secret|sk-/i.test(suffix)) {
    return `${prefix} 引用（实际值隐藏）`;
  }
  return reference;
}

export function architectureNodeStatus(node, kind) {
  if (kind === "control") return '<span class="architecture-static-tag">固定边界</span>';
  if (kind === "client") return statusMarkup(node.status);
  if (kind === "source") return statusMarkup(node.readiness);
  if (kind === "approval") return statusMarkup(node.status, node.status === "empty" ? "未返回" : undefined);
  if (node.invalidName) return statusMarkup("manual_review", "名称异常");
  if (node.sourceReadiness) return statusMarkup(node.sourceReadiness);
  if (node.kindLabel === "read") return statusMarkup("ready", "只读");
  if (node.kindLabel === "write") return statusMarkup("manual_review", "受控写入");
  return statusMarkup(node.kindLabel === "" ? "unavailable" : "manual_review", node.kindLabel === "" ? "kind 未返回" : "kind 未知");
}

function architectureNodeMarkup(node, kind, selected = false) {
  const label = node.displayName ?? node.label;
  const layerLabel = {
    client: "clients",
    control: "MCP 控制层",
    tool: "tools",
    source: "sources",
    approval: "审批生命周期",
  }[kind] ?? kind;
  return `<button class="architecture-node architecture-node-${escapeHtml(kind)}${selected ? " is-selected" : ""}" type="button" data-architecture-kind="${escapeHtml(kind)}" data-architecture-id="${escapeHtml(node.id)}" aria-pressed="${selected}">
    <span class="architecture-node-title">${display(label)}</span>
    <span class="architecture-node-status">${architectureNodeStatus(node, kind)}</span>
    <span class="sr-only">层：${escapeHtml(layerLabel)}；按 Enter 查看详情</span>
  </button>`;
}

function architectureNodesMarkup(nodes, kind, emptyDetail) {
  if (nodes.length === 0) {
    return `<p class="architecture-empty">${statusMarkup("empty", "未返回")}<span>${escapeHtml(emptyDetail)}</span></p>`;
  }
  return `<div class="architecture-node-list">${nodes.map((node) => architectureNodeMarkup(node, kind, isArchitectureSelection(node))).join("")}</div>`;
}

function isArchitectureSelection(node) {
  return state.architectureSelection?.kind === node.kind && state.architectureSelection?.id === node.id;
}

function architectureRelation(label) {
  return `<div class="architecture-relation"><span class="architecture-relation-arrow" aria-hidden="true">↓</span><span>${escapeHtml(label)}</span></div>`;
}

function architectureDetailRow(label, value) {
  return `<div class="architecture-detail-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function renderArchitectureDetails(model) {
  const selection = state.architectureSelection;
  if (!selection) {
    return `<div class="architecture-detail-empty">${statusMarkup("empty", "未选择节点")}<p>选择图中的客户端、控制层、工具、来源或审批步骤，查看脱敏字段。</p></div>`;
  }

  let node;
  if (selection.kind === "control") node = model.controlLayer;
  if (selection.kind === "client") node = model.clients.find((item) => item.id === selection.id);
  if (selection.kind === "tool") node = model.tools.find((item) => item.id === selection.id);
  if (selection.kind === "source") node = model.sources.find((item) => item.id === selection.id);
  if (selection.kind === "approval") {
    node = model.approvalLifecycle.find((item) => item.id === selection.id)
      ?? model.unmappedApprovals.find((item) => item.id === selection.id);
  }
  if (!node) {
    return `<div class="architecture-detail-empty">${statusMarkup("unavailable", "节点不可用")}<p>快照已变化或该节点不再返回；没有补造详情。</p></div>`;
  }

  let rows;
  if (selection.kind === "control") {
    rows = [
      ["边界", "产品控制层"],
      ["包含", "身份、tenant/actor 绑定、RBAC allowlist、审计"],
      ["证据属性", "固定结构说明，不是 live 证据"],
    ];
  } else if (selection.kind === "client") {
    rows = [
      ["client_id", display(node.clientId, "未返回")],
      ["client check", architectureNodeStatus(node, "client")],
      ["安全边界", "仅显示认证后的元数据；不显示凭证或客户内容"],
    ];
  } else if (selection.kind === "tool") {
    const group = model.toolGroups.find((item) => item.key === node.groupKey);
    const executionGroup = model.executionGroups.find((item) => item.key === node.executionKey);
    const rawName = node.name === undefined ? node.displayName : node.name;
    rows = [
      ["name", display(rawName, node.invalidName ? "（工具名称异常）" : "（工具名称为空）")],
      ["name 前缀", display(node.prefix || "未识别")],
      ["分组", display(group?.label, "未知工具/未分类")],
      ["执行类型", display(executionGroup?.label, "未返回")],
      ["依赖来源", display(node.sourceBusinessKey, "未返回")],
      ["permission", display(node.permission, "未返回")],
      ["kind", display(node.kindLabel, "未返回")],
      ["roles", display(node.roles.length ? node.roles.join("、") : "未返回")],
    ];
  } else if (selection.kind === "source") {
    rows = [
      ["来源", display(node.label, "未返回")],
      ["环境", display(node.environment, "未返回")],
      ["type", display(node.type, "未返回")],
      ["readiness", architectureNodeStatus(node, "source")],
      ["registration", display(node.registrationStatus, "未返回")],
      ["endpoint_ref", display(safeOpaqueReference(node.endpointRef, "endpoint_ref"))],
      ["secret_ref", display(safeOpaqueReference(node.secretRef, "secret_ref"))],
      ["adapter contract version", display(node.adapterContractVersion, "未返回")],
      ["business version evidence", sourceEvidenceMarkup(node.businessVersionEvidence)],
      ["update mode", display(node.updateMode, "未返回")],
      ["last_checked_at", display(node.lastCheckedAt, "未返回")],
      ["last_success_at", display(node.lastSuccessAt, "未返回")],
      ["affected_tools", displayList(node.affectedTools)],
      ["readiness 原因", display(node.reason, "未返回")],
      ["blocker", display(node.blocker, "未返回")],
    ];
  } else {
    rows = [
      ["阶段", display(node.label)],
      ["状态", architectureNodeStatus(node, "approval")],
      ["链中证据", display(node.evidenceLabel, "审批链未返回此步骤；不判定成功。")],
    ];
  }

  return `<div class="architecture-detail-content"><div class="architecture-detail-status">${architectureNodeStatus(node, selection.kind)}</div><dl class="architecture-detail-list">${rows.map(([label, value]) => architectureDetailRow(label, value)).join("")}</dl></div>`;
}

function renderArchitectureToolGroups(model) {
  const executionGroups = model.executionGroups.map((group) => `<section class="architecture-tool-group" aria-labelledby="architecture-execution-${escapeHtml(group.key)}"><div class="architecture-group-head"><h4 id="architecture-execution-${escapeHtml(group.key)}">${escapeHtml(group.label)}</h4><span class="codeish">${escapeHtml(group.tools.length)} 个</span></div><p>${escapeHtml(group.description)}</p>${architectureNodesMarkup(group.tools, "tool", "快照没有返回该执行类型的工具。")}</section>`).join("");
  const supporting = model.supportingTools.length === 0 ? "" : `<section class="architecture-tool-group" aria-labelledby="architecture-supporting-tools"><div class="architecture-group-head"><h4 id="architecture-supporting-tools">平台支持 / 其他已注册工具</h4><span class="codeish">${escapeHtml(model.supportingTools.length)} 个</span></div><p>knowledge、status、review 和未知工具单列，不归入业务 API 执行。</p><div class="architecture-node-list">${model.supportingTools.map((tool) => architectureNodeMarkup(tool, "tool", isArchitectureSelection(tool))).join("")}</div></section>`;
  if (executionGroups === "" && supporting === "") return architectureNodesMarkup([], "tool", "快照没有返回工具，不生成工具节点。");
  return `<div class="architecture-tool-groups">${executionGroups}${supporting}</div>`;
}

function renderArchitectureLifecycle(model) {
  if (model.approvalLifecycle.length === 0) {
    return emptyState("暂无审批链", "approvals.chain 没有返回步骤；不画固定步骤为完成。");
  }
  const stages = model.approvalLifecycle.map((stage, index) => `${architectureNodeMarkup(stage, "approval", isArchitectureSelection(stage))}${index < model.approvalLifecycle.length - 1 ? '<span class="architecture-lifecycle-arrow" aria-hidden="true">→</span>' : ""}`).join("");
  const extras = model.unmappedApprovals.length === 0 ? "" : `<div class="architecture-unmapped"><h3>链中未分类步骤</h3><div class="architecture-node-list">${model.unmappedApprovals.map((item) => architectureNodeMarkup(item, "approval", isArchitectureSelection(item))).join("")}</div></div>`;
  return `<p class="architecture-lifecycle-copy">顺序：draft → validate → approval → publish → readback/rollback。每个阶段的状态只取 approvals.chain；缺步或 blocked 不判定成功。</p><div class="architecture-lifecycle-steps">${stages}</div>${extras}`;
}

function renderArchitecture(data) {
  const model = deriveArchitectureModel(data);
  return `${pageHeader("architecture")}
    ${modeBanner()}
    <div class="callout callout-warning" role="note">
      <div class="callout-head"><h2>静态结构边界</h2><span class="architecture-static-tag">非实时证据</span></div>
      <p>静态结构图不证明真实网络连通、认证已接通或正式配置生效；连接线只表达产品边界和数据方向。</p>
    </div>
    <div class="callout callout-info" role="note">
      <p>工具 allowlist、client check、source readiness、approval 状态分别来自已校验快照；本页不把四类状态汇总成“系统健康”或“可发布”。</p>
    </div>
    <div class="architecture-layout">
      <section class="panel architecture-panel" aria-labelledby="architecture-diagram-title">
        <div class="card-head"><div><h2 id="architecture-diagram-title">系统结构图</h2><p>clients → MCP 控制层 → 两类执行 → sources</p></div><span class="architecture-static-tag">C4-like</span></div>
        <div class="architecture-flow" aria-label="客户端、MCP 控制层、工具和来源的结构关系">
          <section class="architecture-layer" aria-labelledby="architecture-clients-title"><div class="architecture-layer-head"><h3 id="architecture-clients-title">clients</h3><p>通过身份与租户边界接入</p></div>${architectureNodesMarkup(model.clients, "client", "快照没有返回客户端，不生成客户端节点。")}</section>
          ${architectureRelation("通过身份与租户边界接入")}
          <section class="architecture-layer" aria-labelledby="architecture-control-title"><div class="architecture-layer-head"><h3 id="architecture-control-title">MCP 控制层</h3><p>认证后绑定 tenant/actor，按 RBAC 调用</p></div><div class="architecture-node-list">${architectureNodeMarkup(model.controlLayer, "control", isArchitectureSelection(model.controlLayer))}</div></section>
          ${architectureRelation("认证后绑定 tenant/actor，按 RBAC 调用")}
          <section class="architecture-layer" aria-labelledby="architecture-tools-title"><div class="architecture-layer-head"><h3 id="architecture-tools-title">tools / 执行层</h3><p>本地确定性计算与外部 API 窄适配分开</p></div>${renderArchitectureToolGroups(model)}</section>
          ${architectureRelation("本地计算；外部请求时直连，不缓存/不轮询")}
          <section class="architecture-layer" aria-labelledby="architecture-sources-title"><div class="architecture-layer-head"><h3 id="architecture-sources-title">sources</h3><p>提供版本、引用和 readiness 原因；返回结构化结果</p></div>${architectureNodesMarkup(model.sources, "source", "快照没有返回来源，不生成来源节点。")}</section>
        </div>
        <p class="architecture-footnote">客户端调用工具；控制层负责认证、tenant/actor 绑定、RBAC allowlist 与审计。来源状态不是实时连通性证明。</p>
      </section>
      <aside class="panel architecture-details" aria-labelledby="architecture-details-title">
        <div class="card-head"><div><h2 id="architecture-details-title">节点详情</h2><p>只展示快照安全字段或固定边界说明。</p></div></div>
        ${renderArchitectureDetails(model)}
      </aside>
    </div>
    <section class="panel architecture-approval-panel" aria-labelledby="architecture-lifecycle-title">
      <div class="card-head"><div><h2 id="architecture-lifecycle-title">审批发布生命周期</h2><p>第二张图只从 approvals.chain 映射状态；缺步骤、blocked 或未读回不会显示为成功。</p></div><span class="architecture-static-tag">独立状态</span></div>
      ${renderArchitectureLifecycle(model)}
    </section>`;
}

function renderView() {
  if (state.loading) return renderLoading();
  if (state.error) return renderError();
  if (!state.data) return renderError();
  switch (state.view) {
    case "clients":
      return renderClients(state.data);
    case "tools":
      return renderTools(state.data);
    case "adapters":
      return renderAdapters(state.data);
    case "architecture":
      return renderArchitecture(state.data);
    case "approvals":
      return renderApprovals(state.data);
    case "audit":
      return renderAudit(state.data);
    case "overview":
    default:
      return renderOverview(state.data);
  }
}

function updateContext() {
  const data = state.data;
  const tenantName = document.querySelector("#tenant-name");
  const environment = document.querySelector("#environment-badge");
  const configVersion = document.querySelector("#config-version");
  const actorName = document.querySelector("#actor-name");
  const actorRole = document.querySelector("#actor-role");
  const footerMode = document.querySelector("#footer-mode");
  tenantName.textContent = data?.tenant?.name ?? (state.loading ? "读取中" : "未连接");
  environment.innerHTML = state.loading
    ? statusMarkup("loading")
    : state.mode === "fixture"
      ? statusMarkup("manual_review", "演示数据")
      : data
        ? statusMarkup("ready", "正式快照")
        : statusMarkup("unavailable", "未连接");
  configVersion.textContent = data?.config?.current_version ?? "—";
  actorName.textContent = data?.actor?.name ?? "未认证";
  actorRole.textContent = data?.actor?.role ? roleLabel(data.actor.role) : "—";
  footerMode.textContent = state.mode === "fixture" ? "演示数据 · 未连接正式后台" : "正式快照 · 失败闭合";
}

function updateNav() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function render(announce = false) {
  updateContext();
  updateNav();
  content.innerHTML = renderView();
  content.setAttribute("aria-busy", String(state.loading));
  document.querySelector("#app").dataset.state = state.loading ? "loading" : state.error ? "unavailable" : "ready";
  if (announce) liveRegion.textContent = `${VIEW_META[state.view].title}已打开`;
}

function focusMain() {
  main.focus({ preventScroll: true });
}

function focusArchitectureNode(kind, id) {
  const node = [...document.querySelectorAll("[data-architecture-kind]")].find(
    (candidate) => candidate.dataset.architectureKind === kind && candidate.dataset.architectureId === id,
  );
  node?.focus({ preventScroll: true });
}

function openDiffDialog() {
  dialogTrigger = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
  const changes = state.data?.approvals?.changes;
  const body = document.querySelector("#dialog-body");
  if (!Array.isArray(changes) || changes.length === 0) {
    body.innerHTML = emptyState("暂无差异", "没有快照差异时不生成发布内容。");
  } else {
    body.innerHTML = `<p class="muted">以下差异只在浏览器本地展示，未保存到服务器：</p><ul class="diff-list">${changes.map((change) => `<li class="diff-item"><span class="diff-path codeish">${display(change.path)}</span><div class="diff-values"><span>变更前：<strong>${display(change.before)}</strong></span><span>变更后：<strong>${display(change.after)}</strong></span></div><div>${statusMarkup(change.status)}</div></li>`).join("")}</ul>`;
  }
  document.querySelector("#dialog-title").textContent = "草稿差异（本地预览）";
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  queueMicrotask(() => document.querySelector("[data-action=close-dialog]")?.focus());
}

function closeDialog() {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  const trigger = dialogTrigger;
  dialogTrigger = null;
  queueMicrotask(() => trigger?.focus());
}

async function loadSnapshot() {
  state.loading = true;
  state.error = null;
  state.data = null;
  render();

  if (state.mode === "fixture") {
    try {
      const module = await import("./fixture-data.js");
      state.data = validateSnapshot(module.fixtureSnapshot);
    } catch (error) {
      state.error = { message: `演示数据文件加载失败：${error instanceof Error ? error.message : "未知错误"}` };
    }
    state.loading = false;
    render();
    return;
  }

  try {
    const response = await fetch("/admin/api/v1/snapshot", {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`同源快照返回 HTTP ${response.status}。`);
    const snapshot = await response.json();
    state.data = validateSnapshot(snapshot);
  } catch (error) {
    state.error = { message: error instanceof Error ? error.message : "同源快照请求失败。" };
  }
  state.loading = false;
  render();
}

if (isBrowser) {
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("button, a") : null;
  if (!target) return;
  const view = target.dataset.view;
  if (view) {
    event.preventDefault();
    state.view = view;
    window.history.replaceState(null, "", `#${view}`);
    render(true);
    focusMain();
    return;
  }

  const architectureKind = target.dataset.architectureKind;
  const architectureId = target.dataset.architectureId;
  if (architectureKind && architectureId) {
    state.architectureSelection = { kind: architectureKind, id: architectureId };
    render();
    queueMicrotask(() => focusArchitectureNode(architectureKind, architectureId));
    return;
  }

  switch (target.dataset.action) {
    case "retry":
      void loadSnapshot();
      break;
    case "preview-diff":
      openDiffDialog();
      break;
    case "close-dialog":
      closeDialog();
      break;
    case "edit-source":
      state.localDraft = target.dataset.source ?? "适配器";
      render(true);
      break;
    case "clear-local-draft":
      state.localDraft = null;
      render(true);
      break;
    default:
      break;
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || !target.matches("[data-role-filter]")) return;
  state.roleFilter = target.value;
  render();
});

window.addEventListener("hashchange", () => {
  state.view = getViewFromHash();
  render(true);
  focusMain();
});

dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});

render();
void loadSnapshot();
}
