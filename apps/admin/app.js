import {
  CONTROL_SCHEMA_VERSION,
  FIXTURE_IDENTITIES,
  ControlPlaneError,
  abbreviateDigest,
  actionAvailability,
  createControlPlaneClient,
  deriveDesiredDraftDiff,
  derivePreviewPresentation,
  deriveReleaseStages,
  isFixtureIdentityVisible,
  redactReference,
  selectReconcileReleaseId,
  selectRollbackReleaseId,
  validateControlState,
} from "./control-plane.js";

const SNAPSHOT_OBJECT_FIELDS = ["tenant", "config", "actor", "health", "approvals"];
const SNAPSHOT_ARRAY_FIELDS = ["clients", "roles", "tools", "sources", "audit"];
const SNAPSHOT_FIELD_LABELS = {
  tenant: "租户",
  config: "配置",
  actor: "当前用户",
  health: "运行状态",
  approvals: "审批",
  clients: "客户端",
  roles: "角色",
  tools: "工具",
  sources: "数据来源",
  audit: "审计记录",
  changes: "差异记录",
  chain: "审批流程",
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateSnapshot(snapshot) {
  if (!isRecord(snapshot)) throw new Error("快照必须是对象。");
  if (typeof snapshot.schema_version !== "string" || snapshot.schema_version.trim() === "") {
    throw new Error("快照缺少格式版本，已拒绝使用。");
  }
  if (typeof snapshot.environment !== "string" || snapshot.environment.trim() === "") {
    throw new Error("快照缺少运行环境，已拒绝使用。");
  }
  for (const field of SNAPSHOT_OBJECT_FIELDS) {
    if (!isRecord(snapshot[field])) throw new Error(`快照的${SNAPSHOT_FIELD_LABELS[field]}格式无效，已拒绝使用。`);
  }
  for (const field of SNAPSHOT_ARRAY_FIELDS) {
    if (!Array.isArray(snapshot[field])) throw new Error(`快照的${SNAPSHOT_FIELD_LABELS[field]}格式无效，已拒绝使用。`);
  }
  for (const field of ["changes", "chain"]) {
    if (!Array.isArray(snapshot.approvals[field])) {
      throw new Error(`快照的${SNAPSHOT_FIELD_LABELS[field]}格式无效，已拒绝使用。`);
    }
  }
  return snapshot;
}

const ARCHITECTURE_TOOL_GROUPS = [
  { key: "billing", label: "报价与计费", prefixes: ["quote", "cargo"], description: "报价、货物和计费相关确定性工具。" },
  { key: "customs", label: "关务", prefixes: ["customs"], description: "关务候选与税费估算工具。" },
  { key: "container", label: "装柜", prefixes: ["container"], description: "装柜容量和理论汇总工具。" },
  { key: "platform", label: "平台支持", prefixes: ["knowledge", "system", "review"], description: "精选知识、数据状态和人工复核工具。" },
  { key: "unknown", label: "未知工具/未分类", prefixes: [], description: "不在已知权限清单中的工具，仅保留内部记录。" },
];

const EXECUTION_GROUP_DEFINITIONS = [
  {
    key: "local",
    label: "本地确定性执行",
    description: "本地规则计算货物和装柜结果，不依赖外部业务接口。",
    toolNames: ["cargo.calculate", "container.plan_summary"],
  },
  {
    key: "external",
    label: "外部接口调用",
    description: "报价请求调用智能报价服务，关务请求调用关务查询服务；单一来源故障只关闭相关工具。",
    toolNames: ["quote.canada_final_mile.calculate", "customs.ca.search", "customs.ca.estimate"],
  },
];

const APPROVAL_STAGE_DEFINITIONS = [
  { key: "draft", label: "草稿", pattern: /draft|草稿/i },
  { key: "validate", label: "校验", pattern: /validate|校验|验证|核验|schema/i },
  { key: "approval", label: "审批", pattern: /approval|approve|审批|批准/i },
  { key: "publish", label: "发布", pattern: /publish|发布|commit/i },
  { key: "readback", label: "读回或回滚", pattern: /readback|read\s*back|读回|回滚|rollback/i },
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
    const availability = safeStatus(tool.availability);
    return {
      kind: "tool",
      id: `tool-${index}`,
      name: rawName,
      displayName: displayNodeLabel(tool.label, validName ? "未命名工具" : "工具名称异常"),
      prefix,
      groupKey: findToolGroup(prefix),
      invalidName: !validName || name.trim() === "",
      label: snapshotText(tool.label),
      permission: snapshotText(tool.permission),
      kindLabel: snapshotText(tool.kind),
      roles: Array.isArray(tool.roles) ? tool.roles.filter((role) => typeof role === "string") : [],
      availability: availability === "empty" ? "" : availability,
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
      label: "平台控制层",
      description: "产品边界：身份、租户、角色权限清单与审计。",
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
    title: "Agent 接入",
    eyebrow: "接入边界",
    description: "管理对话助手、开发助手和企业助手的身份信息；只显示登记状态，不显示原始凭证。",
  },
  modules: {
    title: "模块中心",
    eyebrow: "模块控制面",
    description: "登记已部署模块，预览本地草稿，经过审批后发布并核对运行时读回。",
  },
  tools: {
    title: "工具权限",
    eyebrow: "角色权限清单",
    description: "只展示正式快照返回的角色和第一阶段工具，不新增通用写入口。",
  },
  adapters: {
    title: "数据源与适配器",
    eyebrow: "权威来源引用",
    description: "查看智能报价、关务查询、报价单、精选知识、系统状态和复核任务的配置与就绪状态。",
  },
  architecture: {
    title: "系统结构",
    eyebrow: "静态结构边界",
    description: "按快照展示客户端、平台控制层、工具和数据来源的关系，不代表实时网络连接。",
  },
  approvals: {
    title: "审批与发布",
    eyebrow: "草稿 → 校验 → 审批 → 发布",
    description: "浏览脱敏差异和审批链；正式写操作必须经过校验、审批和写后读回。",
  },
  audit: {
    title: "审计日志",
    eyebrow: "可追溯记录",
    description: "只展示脱敏后的操作人、租户、动作、结果、原因和记录状态，敏感原文不进入日志。",
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
      controlState: null,
      controlStateLoading: false,
      controlStatus: "needs_input",
      controlError: null,
      controlActor: null,
      controlDraftModules: null,
      controlDraftDirty: false,
      controlSelection: null,
      controlNotice: null,
    }
  : null;

const controlClient = isBrowser ? createControlPlaneClient() : null;

const content = isBrowser ? document.querySelector("#content") : null;
const liveRegion = isBrowser ? document.querySelector("#live-region") : null;
const main = isBrowser ? document.querySelector("#main-content") : null;
const dialog = isBrowser ? document.querySelector("#detail-dialog") : null;
const identityDialog = isBrowser ? document.querySelector("#identity-dialog") : null;
let dialogTrigger = null;
let identityDialogTrigger = null;

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

const CHINESE_DISPLAY_TEXT = {
  ChatGPT: "对话助手",
  Codex: "开发助手",
  "AI 报价 API": "智能报价服务",
  "RiskCustoms API": "关务查询服务",
  "PDF API": "报价单服务",
  fixture: "演示环境",
  ready: "已就绪",
  unavailable: "不可用",
  blocked: "已阻断",
  manual_review: "人工复核",
  success: "成功",
  "ready=false": "未就绪",
  "Phase 1 禁止": "第一阶段禁止",
  production: "正式环境",
  live: "正式环境",
  test: "测试环境",
  read: "只读",
  write: "受控写入",
};

export function toChineseDisplayText(value, fallback = "—") {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim();
  let text = CHINESE_DISPLAY_TEXT[raw] ?? raw;
  const replacements = [
    [/RiskCustoms/g, "关务查询服务"],
    [/ChatGPT/g, "对话助手"],
    [/Codex/g, "开发助手"],
    [/OpenAPI/g, "接口说明"],
    [/JavaScript/g, "浏览器脚本"],
    [/Schema/gi, "字段格式"],
    [/RBAC/g, "角色权限"],
    [/allowlist/gi, "权限清单"],
    [/PDF/g, "报价单"],
    [/API/g, "接口"],
    [/AI/g, "智能"],
    [/HTTP/g, "网络请求"],
    [/CBM/g, "总体积"],
    [/\bHS\b/g, "海关编码"],
    [/SOP/g, "操作规范"],
    [/MCP/g, "物流工具平台"],
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return /[A-Za-z]/.test(text) ? "技术信息已隐藏" : text;
}

function display(value, fallback = "—") {
  return escapeHtml(toChineseDisplayText(value, fallback));
}

function sourceEvidenceMarkup(value) {
  if (!isRecord(value)) return display(value, "未返回");
  const entries = Object.entries(value);
  if (entries.length === 0) return "未返回";
  return `已返回 ${entries.length} 项版本证据（详情已隐藏）`;
}

function safeStatus(status) {
  return Object.hasOwn(STATUS_META, status) ? status : "empty";
}

function statusMarkup(status, label) {
  const key = safeStatus(status);
  const meta = STATUS_META[key];
  return `<span class="status-pill status-${key}"><span class="status-icon" aria-hidden="true">${meta.symbol}</span>${escapeHtml(toChineseDisplayText(label ?? meta.label))}</span>`;
}

function roleLabel(role, data = state.data) {
  const roles = Array.isArray(data?.roles) ? data.roles : [];
  const record = roles.find((item) => item.key === role);
  return display(record?.label, "未命名角色");
}

function roleChips(roles, selectedRole = null) {
  if (!Array.isArray(roles) || roles.length === 0) return statusMarkup("empty", "没有授权角色");
  return `<div class="role-chips">${roles.map((role) => `<span class="role-chip${selectedRole === role ? " is-selected" : ""}">${roleLabel(role)}</span>`).join("")}</div>`;
}

function recordedSummary(value, hiddenLabel = "具体内容") {
  return value === undefined || value === null || value === ""
    ? "未记录"
    : `已记录（${hiddenLabel}隐藏）`;
}

function versionSummary(value) {
  return value === undefined || value === null || value === "" ? "未返回" : "已登记（版本号隐藏）";
}

function toolLabelByName(name, data = state?.data) {
  const tools = Array.isArray(data?.tools) ? data.tools : [];
  return displayNodeLabel(tools.find((tool) => tool.name === name)?.label, "未命名工具");
}

function displayToolList(value, data = state?.data) {
  if (!Array.isArray(value) || value.length === 0) return "无关联工具";
  return value.map((name) => display(toolLabelByName(name, data))).join("、");
}

function changeLabel(path, index = 0) {
  const labels = {
    "adapters.RiskCustoms.readiness": "关务查询服务状态",
    "clients.client_codex_demo.tenant_binding": "开发助手租户绑定",
    "release.external_publish": "对外发布限制",
  };
  return labels[path] ?? `其他配置项 ${index + 1}`;
}

function auditActionLabel(action) {
  return {
    "config.preview": "预览配置差异",
    "adapter.readiness.check": "检查数据来源状态",
    "release.commit": "尝试发布配置",
  }[action] ?? "其他受控操作";
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

function isDemoSnapshot() {
  return state.mode === "fixture" || state.data?.environment === "fixture" || state.data?.environment === "演示环境";
}

function modeBanner() {
  if (isDemoSnapshot()) {
    return `<div class="callout callout-warning" role="status">
      <div class="callout-head"><h2>演示数据</h2>${statusMarkup("manual_review", "未连接正式后台")}</div>
      <p>当前已明确启用演示快照。发布、回滚和保存到服务器已禁用；本地差异只在浏览器中预览，未持久化。</p>
    </div>`;
  }
  return `<div class="callout callout-info" role="status">
    <div class="callout-head"><h2>正式快照入口</h2>${statusMarkup("unavailable", "仅限同源请求")}</div>
    <p>页面只从同源后台读取正式快照。请求失败会保持不可用，不会回退到演示数据或内置默认配置。</p>
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
  const message = toChineseDisplayText(state.error?.message, "正式后台快照暂时不能读取。");
  return `<section class="error-panel" data-state="unavailable" aria-labelledby="error-title">
    ${statusMarkup("error", "加载失败")}
    <h1 id="error-title">正式快照不可用</h1>
    <p>${escapeHtml(message)}</p>
    <p>请检查同源后台是否已开启正式快照入口；本页不会自动切换到演示数据。</p>
    <button class="button button-secondary" type="button" data-action="retry"><span class="button-icon" data-icon="refresh" aria-hidden="true"></span>重新读取</button>
  </section>`;
}

function renderSourceTable(sources, withActions = false) {
  if (!Array.isArray(sources) || sources.length === 0) return emptyState("暂无适配器记录", "正式快照没有返回数据源，不能用相似名称补齐。");
  return `<div class="table-scroll" role="region" aria-label="数据源和适配器表格" tabindex="0">
    <table class="data-table">
      <thead><tr><th scope="col">数据来源</th><th scope="col">接口配置</th><th scope="col">凭证配置</th><th scope="col">版本记录</th><th scope="col">就绪状态</th>${withActions ? "<th scope=\"col\">本地操作</th>" : ""}</tr></thead>
      <tbody>${sources.map((item) => {
        const source = isRecord(item) ? item : {};
        return `<tr>
        <td><span class="primary-cell">${display(source.label ?? source.name, "未返回")}</span><span class="sub-cell">${display(source.type, "未返回")}</span></td>
        <td>${display(safeOpaqueReference(source.endpoint_ref, "endpoint_ref"))}</td>
        <td>${display(safeOpaqueReference(source.secret_ref, "secret_ref"))}<span class="sub-cell">具体内容不显示</span></td>
        <td>${display(versionSummary(source.source_version))}</td>
        <td>${statusMarkup(source.readiness)}<span class="sub-cell">${display(source.reason, "未返回")}</span></td>
        ${withActions ? `<td><button class="button button-secondary" type="button" data-action="edit-source" data-source="${escapeHtml(toChineseDisplayText(source.label ?? source.name, "数据来源"))}"><span class="button-icon" data-icon="edit" aria-hidden="true"></span>生成本地草稿</button></td>` : ""}
      </tr>`;
      }).join("")}</tbody>
  </table>
</div>`;
}

function renderBusinessSourceCard(item) {
  const source = isRecord(item) ? item : {};
  return `<article class="source-api-card">
    <div class="source-api-card-head">
      <div><span class="eyebrow">业务接口</span><h3>${display(source.label ?? source.name, "未返回")}</h3><p>${display(source.environment, "未返回")}</p></div>
      ${statusMarkup(source.readiness)}
    </div>
    <dl class="source-api-details">
      <div class="source-api-row"><dt>接口配置</dt><dd>${display(safeOpaqueReference(source.endpoint_ref, "endpoint_ref"))}</dd></div>
      <div class="source-api-row"><dt>凭证配置</dt><dd>${display(safeOpaqueReference(source.secret_ref, "secret_ref"))}</dd></div>
      <div class="source-api-row"><dt>接口约定</dt><dd>${display(versionSummary(source.adapter_contract_version))}</dd></div>
      <div class="source-api-row"><dt>业务版本证据</dt><dd>${sourceEvidenceMarkup(source.business_version_evidence)}</dd></div>
      <div class="source-api-row"><dt>更新方式</dt><dd>${display(source.update_mode, "未返回")}</dd></div>
      <div class="source-api-row"><dt>最近检查</dt><dd>${display(source.last_checked_at, "未返回")}</dd></div>
      <div class="source-api-row"><dt>最近成功</dt><dd>${display(source.last_success_at, "未返回")}</dd></div>
      <div class="source-api-row"><dt>关联工具</dt><dd>${displayToolList(source.affected_tools)}</dd></div>
      <div class="source-api-row"><dt>登记状态</dt><dd>${display(source.registration_status, "未返回")}</dd></div>
    </dl>
    <div class="source-api-reason"><strong>状态说明</strong><p>${display(source.reason, "未返回")}</p><strong>阻断原因</strong><p>${display(source.blocker, "未返回")}</p></div>
  </article>`;
}

function renderOverview(data) {
  const health = data.health ?? {};
  const config = data.config ?? {};
  const approvals = data.approvals ?? {};
  const blockers = Array.isArray(data.blockers) ? data.blockers : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const pendingCount = blockers.length + (Array.isArray(approvals.changes) ? approvals.changes.filter((change) => change.status !== "ready").length : 0);
  const chain = Array.isArray(approvals.chain) ? approvals.chain : [];
  const legend = Array.isArray(data.status_legend) ? data.status_legend : [];

  return `${pageHeader("overview", `<button class="button button-secondary" type="button" data-action="retry"><span class="button-icon" data-icon="refresh" aria-hidden="true"></span>重新读取</button>`)}
    ${modeBanner()}
    <div class="metric-grid" aria-label="核心状态">
      ${metricCard("进程健康", health.healthz?.value, health.healthz?.detail, health.healthz?.status ?? "empty", "overview")}
      ${metricCard("发布就绪", health.readyz?.value, health.readyz?.detail, health.readyz?.status ?? "empty", "approval")}
      ${metricCard("当前发布版本", versionSummary(config.current_version), `最近发布：${display(config.last_published_at)}`, "manual_review", "adapter")}
      ${metricCard("待处理项", `${pendingCount} 项`, "需要人工确认或补充信息", pendingCount > 0 ? "needs_input" : "ready", "audit")}
    </div>
    <div class="callout callout-warning" role="alert">
      <div class="callout-head"><h2>当前阻断原因</h2>${statusMarkup("blocked")}</div>
      ${blockers.length ? `<ul>${blockers.map((item) => `<li>${display(item)}</li>`).join("")}</ul>` : `<p>暂无阻断说明；仍应以正式快照和写后读回为准。</p>`}
    </div>
    <div class="section-grid section-grid-wide">
      <section class="panel" aria-labelledby="overview-sources-title">
        <div class="card-head"><div><h2 id="overview-sources-title">数据源就绪情况</h2><p>单次检查成功不等于业务数据可发布；关务查询服务必须保留就绪门禁。</p></div><span class="status-pill status-neutral">${sources.length} 个来源</span></div>
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
      <div class="card-head"><div><h2 id="clients-table-title">已登记客户端</h2><p>身份来源、使用范围和允许来源用于接入校验；原始凭证永不在此显示。</p></div>${statusMarkup(clients.length ? "ready" : "empty", clients.length ? "仅显示登记状态" : "暂无客户端")}</div>
      ${clients.length ? `<div class="client-card-grid">${clients.map((client) => `<article class="client-card">
        <div class="client-card-head"><div><h3>${display(client.name)}</h3><p>${display(recordedSummary(client.client_id, "接入标识"))}</p></div>${statusMarkup(client.check?.status ?? "empty")}</div>
        <dl class="ref-list">
          <div class="ref-row"><dt>身份来源</dt><dd>${display(recordedSummary(client.issuer, "具体内容"))}</dd></div>
          <div class="ref-row"><dt>使用范围</dt><dd>${display(recordedSummary(client.audience, "具体内容"))}</dd></div>
          <div class="ref-row"><dt>允许来源</dt><dd>${Array.isArray(client.allowed_origins) && client.allowed_origins.length ? `${client.allowed_origins.length} 个来源已登记（地址隐藏）` : statusMarkup("blocked", "未登记")}</dd></div>
        </dl>
        <p><strong>最近校验：</strong>${display(client.check?.checked_at)}<br />${display(client.check?.detail)}</p>
      </article>`).join("")}</div>` : emptyState("暂无客户端接入记录", "没有快照数据时不自动生成接入标识或允许来源。")}
    </section>
    <div class="section-grid">
      <section class="panel" aria-labelledby="client-rule-title"><div class="card-head"><div><h2 id="client-rule-title">接入规则</h2><p>客户端不是业务角色，操作人和租户必须由服务端认证后绑定。</p></div></div><ul class="plain-list"><li>只显示接入信息的登记状态。</li><li>租户、操作人、角色和会话不能由客户端自报。</li><li>校验失败显示已阻断或人工复核，不静默放行。</li></ul></section>
      <section class="panel" aria-labelledby="client-secret-title"><div class="card-head"><div><h2 id="client-secret-title">凭证边界</h2><p>页面不收集、不保存、不回显原始凭证。</p></div>${statusMarkup("blocked", "原始凭证隐藏")}</div><p class="muted">数据连接只使用服务端注入的最小权限引用；控制台只显示是否已配置。</p></section>
    </div>`;
}

function renderTools(data) {
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const roles = Array.isArray(data.roles) ? data.roles : [];
  const permissionDataReady = roles.length > 0 && tools.length > 0;
  const visibleTools = state.roleFilter === "all" ? tools : tools.filter((tool) => tool.roles?.includes(state.roleFilter));
  return `${pageHeader("tools")}
    ${modeBanner()}
    <div class="callout callout-info" role="note"><div class="callout-head"><h2>权限边界</h2>${statusMarkup(permissionDataReady ? "ready" : "unavailable", permissionDataReady ? "快照授权" : "授权数据不可用")}</div><p>下面的角色和工具来自平台角色权限清单。仅保留两个受控写入动作；保存报价草稿当前不可用，创建人工复核仍需正式写入接口、审批和写后读回。</p></div>
    <section class="panel" aria-labelledby="tool-table-title">
      <div class="card-head"><div><h2 id="tool-table-title">第一阶段工具权限</h2><p>操作类型只说明工具边界；当前可用性单独读取快照，未返回时不推断。</p></div><span class="status-pill status-neutral">${tools.length} 个工具</span></div>
      <div class="filter-bar"><div class="field"><label for="role-filter">按角色筛选</label><select id="role-filter" data-role-filter><option value="all"${state.roleFilter === "all" ? " selected" : ""}>全部角色</option>${roles.map((role) => `<option value="${escapeHtml(role.key)}"${state.roleFilter === role.key ? " selected" : ""}>${roleLabel(role.key)}</option>`).join("")}</select></div><p class="field-help">选中角色后只看它能使用的工具。</p></div>
      ${visibleTools.length ? `<div class="table-scroll" role="region" aria-label="工具权限表格，可横向滚动" tabindex="0"><table class="data-table table-wide"><thead><tr><th scope="col">工具</th><th scope="col">说明</th><th scope="col">操作类型</th><th scope="col">当前可用性</th><th scope="col">角色授权</th></tr></thead><tbody>${visibleTools.map((tool) => `<tr><td><span class="primary-cell">${display(tool.label, "未命名工具")}</span></td><td>${display(tool.description, "未返回说明")}</td><td>${tool.kind === "write" ? statusMarkup("manual_review", "受控写入") : tool.kind === "read" ? statusMarkup("ready", "只读") : statusMarkup("unavailable", "操作类型未返回")}</td><td>${safeStatus(tool.availability) === "empty" ? statusMarkup("empty", "未返回") : statusMarkup(tool.availability)}</td><td>${roleChips(tool.roles, state.roleFilter === "all" ? null : state.roleFilter)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("暂无匹配工具", "这个角色没有返回可用工具，不能自行补权限。")}
    </section>
    <section class="panel" aria-labelledby="role-list-title"><div class="card-head"><div><h2 id="role-list-title">角色授权</h2><p>角色名称和说明只来自当前快照；新增角色不在本原型中创建。</p></div></div>${roles.length ? `<div class="role-grid">${roles.map((role) => `<article class="role-card"><div class="role-card-head"><h3>${roleLabel(role.key)}</h3></div><p>${display(role.description, "由服务端策略决定可见范围。")}</p></article>`).join("")}</div>` : emptyState("暂无角色授权数据", "正式快照没有返回角色，不能生成默认权限。")}</section>`;
}

function renderAdapters(data) {
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const businessSources = sources.filter((source) => isRecord(source) && source.category === "business_api");
  const supportingSources = sources.filter((source) => !isRecord(source) || source.category !== "business_api");
  const localDraft = state.localDraft;
  return `${pageHeader("adapters")}
    ${modeBanner()}
    <div class="callout callout-info" role="note"><div class="callout-head"><h2>失败隔离</h2><span class="architecture-static-tag">按工具边界</span></div><p>一个业务接口不可达，只关闭它关联的工具；只有身份、审计、会话等平台基础设施故障才影响全局发布就绪状态。</p></div>
    ${localDraft ? `<div class="callout callout-info" role="status"><div class="callout-head"><h2>本地草稿已生成</h2>${statusMarkup("needs_input", "未持久化")}</div><p>已在浏览器中记录“${display(localDraft)}”的预览意图；没有请求正式后台，也没有修改权威数据。</p><div class="button-row"><button class="button button-secondary" type="button" data-action="clear-local-draft">清除本地草稿</button></div></div>` : ""}
    <section class="panel source-api-section" aria-labelledby="business-api-title">
      <div class="card-head"><div><h2 id="business-api-title">业务接口连接状态</h2><p>业务接口每次请求时直连，不缓存、不轮询；单张卡片状态不代表整个平台健康。</p></div><span class="status-pill status-neutral">${businessSources.length ? `${businessSources.length} 张业务卡` : "未返回业务卡"}</span></div>
      ${businessSources.length ? `<div class="source-api-grid">${businessSources.map(renderBusinessSourceCard).join("")}</div>` : emptyState("暂无业务接口状态卡", "快照没有返回业务来源；不依据名称补造业务状态。")}
    </section>
    <section class="panel" aria-labelledby="adapter-table-title">
      <div class="card-head"><div><h2 id="adapter-table-title">其他数据来源</h2><p>精选知识、系统状态和人工复核等普通引用仍来自快照；不复制报价、关税或业务记录。</p></div><span class="status-pill status-neutral">${supportingSources.length ? `${supportingSources.length} 个引用` : "暂无来源"}</span></div>
      ${renderSourceTable(supportingSources, true)}
    </section>
    <div class="section-grid">
      <section class="panel" aria-labelledby="adapter-boundary-title"><div class="card-head"><div><h2 id="adapter-boundary-title">权威边界</h2><p>页面只说明业务含义，不显示内部路径。</p></div></div><dl class="key-value-list"><div class="key-value-row"><dt>智能报价服务</dt><dd>外部接口；当前正式报价路径保持不可用并失败闭合，未获生产启用资格。</dd></div><div class="key-value-row"><dt>关务查询服务</dt><dd>外部接口；先检查状态再查询，未就绪时必须显示不可用或人工复核。</dd></div><div class="key-value-row"><dt>报价单服务</dt><dd>外部接口；接口约定未核验，未注册任何报价单工具，不在本地替代。</dd></div><div class="key-value-row"><dt>本地确定性工具</dt><dd>本地只计算货物和装柜结果；智能模型只能解释或预填。</dd></div></dl></section>
      <section class="panel" aria-labelledby="adapter-failure-title"><div class="card-head"><div><h2 id="adapter-failure-title">失败处理</h2><p>没有可靠来源就停在当前状态。</p></div>${statusMarkup("unavailable")}</div><ul class="plain-list"><li>接口不可达：显示不可用。</li><li>版本或租户边界不清：转人工复核。</li><li>权限或阶段禁止：显示已阻断。</li><li>不使用地图、聊天或相似记录补齐权威数据。</li></ul></section>
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
      <div class="card-head"><div><h2 id="approval-workflow-title">草稿到发布</h2><p>预览不写外部系统；正式发布必须通过审批并完成写后读回。</p></div>${statusMarkup(approvals.validation?.status ?? "empty")}</div>
      <div class="approval-layout">
        <div class="approval-summary"><span class="eyebrow">当前草稿</span><h3>${display(versionSummary(draft.version))}</h3><p>创建人：${display(recordedSummary(draft.owner, "身份"))}</p><p>创建时间：${display(draft.created_at)}</p><p>${display(draft.persistence, "持久化状态未知")}</p><div class="button-row"><button class="button button-primary" type="button" data-action="preview-diff"><span class="button-icon" data-icon="preview" aria-hidden="true"></span>查看本地差异</button><button class="button button-secondary" type="button" disabled title="未连接正式后台；发布接口尚未提供" aria-disabled="true">发布到正式</button></div></div>
        <ol class="step-list" aria-label="审批链">${chain.length ? chain.map((item) => `<li class="step-item" data-status="${safeStatus(item.status)}"><span class="step-title">${display(item.label)}</span><span>${statusMarkup(item.status)}</span><span class="step-detail">${display(item.detail)}</span></li>`).join("") : `<li>${emptyState("暂无审批链", "没有快照数据时不创建默认审批人。")}</li>`}</ol>
      </div>
    </section>
    <section class="panel" aria-labelledby="diff-table-title"><div class="card-head"><div><h2 id="diff-table-title">草稿差异</h2><p>差异仅为演示引用和状态，不包含价格、税务材料、地址或原始凭证。</p></div>${statusMarkup(changes.length ? "manual_review" : "empty", changes.length ? `${changes.length} 项待确认` : "暂无差异")}</div>${changes.length ? `<div class="table-scroll" role="region" aria-label="草稿差异表格" tabindex="0"><table class="data-table"><thead><tr><th scope="col">配置项</th><th scope="col">变更前</th><th scope="col">变更后</th><th scope="col">校验结果</th></tr></thead><tbody>${changes.map((change, index) => `<tr><td>${display(changeLabel(change.path, index))}</td><td>${display(change.before)}</td><td>${display(change.after)}</td><td>${statusMarkup(change.status)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("暂无草稿差异", "没有差异时不自动生成发布内容。")}</section>
    <div class="callout callout-warning" role="alert"><div class="callout-head"><h2>真实操作仍被禁用</h2>${statusMarkup("blocked", "演示环境未接入")}</div><p>“发布到正式”“回滚版本”“保存到服务器”需要完整的草稿、校验、预览、审批、发布、读回和回滚接口。本页不伪造成功。</p><div class="button-row"><button class="button button-secondary" type="button" disabled title="未连接正式后台；回滚接口尚未提供" aria-disabled="true">回滚正式版本</button></div></div>`;
}

function renderAudit(data) {
  const entries = Array.isArray(data.audit) ? data.audit : [];
  return `${pageHeader("audit")}
    ${modeBanner()}
    <section class="panel" aria-labelledby="audit-table-title">
      <div class="card-head"><div><h2 id="audit-table-title">审计事件</h2><p>只保留脱敏关联字段；完整地址、报价明细、税务材料和凭证不写入普通日志。</p></div>${statusMarkup(entries.length ? "ready" : "empty", entries.length ? `${entries.length} 条记录` : "暂无记录")}</div>
      ${entries.length ? `<div class="table-scroll" role="region" aria-label="审计日志表格" tabindex="0"><table class="data-table table-wide"><thead><tr><th scope="col">操作人</th><th scope="col">租户</th><th scope="col">动作</th><th scope="col">结果</th><th scope="col">原因</th><th scope="col">版本记录</th><th scope="col">追踪记录</th></tr></thead><tbody>${entries.map((entry) => `<tr><td>${display(recordedSummary(entry.actor, "身份"))}</td><td>${display(recordedSummary(entry.tenant, "租户标识"))}</td><td>${display(auditActionLabel(entry.action))}</td><td>${statusMarkup(entry.result)}</td><td>${display(entry.reason)}</td><td>${display(versionSummary(entry.config_version))}</td><td>${display(recordedSummary(entry.trace_id, "追踪号"))}</td></tr>`).join("")}</tbody></table></div>` : emptyState("暂无审计记录", "没有快照数据时不创建假日志，也不会猜测操作结果。")}
    </section>
    <section class="panel" aria-labelledby="audit-rule-title"><div class="card-head"><div><h2 id="audit-rule-title">日志最小化</h2><p>审计关联足够追责，但不把客户内容变成日志副本。</p></div>${statusMarkup("ready", "脱敏摘要")}</div><div class="state-guide"><div class="state-guide-item"><strong>保留</strong><p>租户、操作人、客户端、工具、版本、状态、原因代码和追踪号的脱敏关联。</p></div><div class="state-guide-item"><strong>不保留</strong><p>客户地址、报价明细、税务材料全文、原始聊天和凭证。</p></div><div class="state-guide-item"><strong>写入失败</strong><p>审计或读回失败时转人工复核，不报告假成功。</p></div></div></section>`;
}

const CONTROL_STATUS_META = {
  complete: { status: "success", label: "已完成", symbol: "✓" },
  pending: { status: "needs_input", label: "待确认", symbol: "!" },
  needs_input: { status: "needs_input", label: "需要输入", symbol: "!" },
  manual_review: { status: "manual_review", label: "人工复核", symbol: "!" },
  blocked: { status: "blocked", label: "已阻断", symbol: "!" },
  unavailable: { status: "unavailable", label: "不可用", symbol: "×" },
  empty: { status: "empty", label: "待处理", symbol: "—" },
};

const CONTROL_VALIDATION_LABELS = {
  desired_modules_valid: "期望模块集合",
  inventory_modules_valid: "登记模块集合",
  diff_valid: "差异结构",
  base_release_valid: "基线版本",
  release_target_valid: "回滚目标",
  preview_not_expired: "预览有效期",
};

function controlStatusMarkup(status, label) {
  const meta = CONTROL_STATUS_META[status] ?? CONTROL_STATUS_META.empty;
  return `<span class="status-pill status-${meta.status}"><span class="status-icon" aria-hidden="true">${meta.symbol}</span>${escapeHtml(label ?? meta.label)}</span>`;
}

function controlModuleKey(module) {
  return `${module.module_id}\u0000${module.version}`;
}

function controlModuleRef(module) {
  return {
    module_id: module.module_id,
    version: module.version,
    descriptor_digest: module.descriptor_digest,
  };
}

function controlModuleFromKey(data, moduleId, version) {
  return data?.inventory_modules?.find((module) => module.module_id === moduleId && module.version === version) ?? null;
}

function controlDraftModules(data) {
  if (Array.isArray(state.controlDraftModules)) return state.controlDraftModules;
  return Array.isArray(data?.activation?.active_modules) ? data.activation.active_modules.map(controlModuleRef) : [];
}

function controlSelectedModule(data) {
  const modules = Array.isArray(data?.inventory_modules) ? data.inventory_modules : [];
  return modules.find((module) => controlModuleKey(module) === state.controlSelection) ?? modules[0] ?? null;
}

function controlRuntimeState(module, data) {
  const readback = data?.latest_readback?.status;
  if (readback === "mismatch") return ["manual_review", "读回不一致"];
  if (readback === "unknown") return ["unavailable", "读回未知"];
  if (readback === "pending") return ["pending", "读回待确认"];
  const active = Array.isArray(data?.activation?.active_modules) && data.activation.active_modules.some((item) => controlModuleKey(item) === controlModuleKey(module));
  if (readback !== "verified") return [active ? "pending" : "empty", active ? "等待精确读回" : "未激活"];
  return active ? ["complete", "运行时已读回"] : ["empty", "未激活"];
}

function controlRegistrationState(module) {
  return module?.registration === null ? ["pending", "待登记"] : ["complete", "已登记"];
}

function controlCurrentActorRole() {
  return state.controlActor?.role ?? "";
}

function controlActorReference() {
  return state.controlActor?.actor ?? undefined;
}

function controlNotice(kind, status, title, detail, label) {
  state.controlNotice = { kind, status, title, detail, label };
}

function controlErrorNotice(error, actionLabel) {
  const status = error instanceof ControlPlaneError && CONTROL_STATUS_META[error.status] ? error.status : "unavailable";
  const detail = status === "manual_review"
    ? `${actionLabel}需要人工复核；页面保留服务端状态并重新读取，不把操作显示为成功。`
    : status === "blocked"
      ? `${actionLabel}已被服务端阻断；当前没有更新运行时状态。`
      : `${actionLabel}未完成；当前没有更新运行时状态。`;
  return { status, detail };
}

function controlNoticeMarkup() {
  if (!state.controlNotice) return "";
  const notice = state.controlNotice;
  const mapped = CONTROL_STATUS_META[notice.status]?.status ?? "neutral";
  return `<div class="callout callout-${escapeHtml(notice.kind)}" role="status"><div class="callout-head"><h2>${escapeHtml(notice.title)}</h2><span class="status-pill status-${mapped}">${escapeHtml(notice.label ?? CONTROL_STATUS_META[notice.status]?.label ?? "未返回")}</span></div><p>${escapeHtml(notice.detail)}</p></div>`;
}

function renderControlIdentityPanel() {
  const fixture = state.mode === "fixture" && isFixtureIdentityVisible(window.location.search);
  const actions = fixture
    ? `<div class="identity-actions"><button class="button button-primary" type="button" data-control-action="fixture-identity" data-identity="local_operator">本地演示申请人</button><button class="button button-secondary" type="button" data-control-action="fixture-identity" data-identity="local_approver">本地演示审批人</button></div><p class="field-help">只有 fixture=1 的本地路径显示演示身份；按钮不显示凭证值。</p>`
    : `<button class="button button-primary" type="button" data-control-action="open-identity">输入模块作用域身份</button><p class="field-help">身份只保留在本次页面会话的 API client 中；不写入存储、地址栏、页面文本或日志。</p>`;
  const bound = state.controlActor ? `<p class="bound-identity">当前身份：<strong>${escapeHtml(state.controlActor.label)}</strong>。控制面状态仍需重新读取。</p>` : "";
  const error = state.controlError ? `<p class="field-help">${escapeHtml(state.controlError)}</p>` : "";
  return `<section class="panel identity-panel" aria-labelledby="identity-panel-title"><div class="card-head"><div><h2 id="identity-panel-title">绑定控制面身份</h2><p>模块清单、预览和发布状态只接受服务端控制面读回；旧 snapshot 不替代这里的权限边界。</p></div>${controlStatusMarkup(state.controlStatus)}</div>${bound}${error}${actions}</section>`;
}

function renderControlReleaseRail(data) {
  let stages = [];
  try {
    stages = deriveReleaseStages(data);
  } catch {
    stages = [];
  }
  return `<section class="panel release-rail-panel" aria-labelledby="release-rail-title"><div class="card-head"><div><h2 id="release-rail-title">发布门槛</h2><p>登记制品 → 生成预览 → 双人审批 → 发布读回</p></div>${data.latest_readback?.status === "verified" ? controlStatusMarkup("complete", "运行时精确读回") : controlStatusMarkup(state.controlStatus)}</div><ol class="release-rail" aria-label="发布阶段">${stages.map((stage) => `<li class="release-rail-item" data-stage-status="${escapeHtml(stage.status)}"><span class="release-rail-marker" aria-hidden="true"></span><div><strong>${escapeHtml(stage.label)}</strong>${controlStatusMarkup(stage.status)}</div></li>`).join("")}</ol></section>`;
}

function renderControlStatusCards(data) {
  const inventory = Array.isArray(data.inventory_modules) ? data.inventory_modules : [];
  const registered = inventory.filter((module) => module.registration !== null).length;
  const previewPending = data.latest_preview !== null
    && data.latest_preview?.consumed !== true
    && data.latest_approval === null;
  const exactReadback = data.latest_readback?.status === "verified";
  const active = exactReadback && data.activation?.state === "active" ? data.activation.active_modules.length : 0;
  const activeLabel = exactReadback && data.activation?.state === "active" ? "运行时已读回" : data.activation?.state === "active" ? "等待精确读回" : "未激活";
  const activeStatus = exactReadback && data.activation?.state === "active" ? "complete" : data.activation?.state === "active" ? "pending" : "empty";
  return `<div class="metric-grid control-status-grid" aria-label="模块控制面状态"><article class="metric-card"><div class="metric-top"><span class="metric-label">已登记</span><span class="metric-icon" data-icon="module" aria-hidden="true"></span></div><div class="metric-value">${registered}</div><div class="metric-detail">${controlStatusMarkup(registered === inventory.length && registered > 0 ? "complete" : registered > 0 ? "pending" : "empty", registered > 0 ? "服务端登记记录" : "暂无记录")}</div></article><article class="metric-card"><div class="metric-top"><span class="metric-label">待审批</span><span class="metric-icon" data-icon="approval" aria-hidden="true"></span></div><div class="metric-value">${previewPending ? 1 : 0}</div><div class="metric-detail">${controlStatusMarkup(previewPending ? "pending" : "empty", previewPending ? "等待不同身份审批" : "暂无待审批")}</div></article><article class="metric-card"><div class="metric-top"><span class="metric-label">当前激活</span><span class="metric-icon" data-icon="runtime" aria-hidden="true"></span></div><div class="metric-value">${active}</div><div class="metric-detail">${controlStatusMarkup(activeStatus, activeLabel)}</div></article></div>`;
}

function renderControlModuleTable(data) {
  const modules = Array.isArray(data.inventory_modules) ? data.inventory_modules : [];
  const draft = controlDraftModules(data);
  if (modules.length === 0) return `<section class="panel" aria-labelledby="module-table-title"><div class="card-head"><div><h2 id="module-table-title">模块清单</h2><p>服务端没有返回部署清单，不根据名称补造模块。</p></div></div>${emptyState("暂无已登记模块", "请先由控制面登记当前部署清单。")}</section>`;
  return `<section class="panel module-table-panel" aria-labelledby="module-table-title"><div class="card-head"><div><h2 id="module-table-title">模块清单</h2><p>期望启用开关只编辑浏览器草稿；运行时状态只在发布并精确读回后变化。</p></div>${controlStatusMarkup("complete", `${modules.length} 个模块`)}</div><div class="table-scroll module-table-scroll" role="region" aria-label="模块清单表格，可横向滚动" tabindex="0"><table class="data-table module-table"><thead><tr><th scope="col">模块名称</th><th scope="col">版本</th><th scope="col">风险</th><th scope="col">描述摘要</th><th scope="col">登记状态</th><th scope="col">运行时状态</th><th scope="col">期望启用</th></tr></thead><tbody>${modules.map((module) => {
    const key = controlModuleKey(module);
    const desired = draft.some((item) => controlModuleKey(item) === key);
    const selected = key === state.controlSelection;
    const [registrationStatus, registrationLabel] = controlRegistrationState(module);
    const [runtimeStatus, runtimeLabel] = controlRuntimeState(module, data);
    return `<tr class="${selected ? "is-selected" : ""}"><th scope="row"><button class="table-link" type="button" data-control-action="select-module" data-module-id="${escapeHtml(module.module_id)}" data-module-version="${escapeHtml(module.version)}" aria-pressed="${selected}">${escapeHtml(module.module_id)}</button></th><td>${escapeHtml(module.version)}</td><td>${escapeHtml(module.risk_level)}</td><td>${escapeHtml(abbreviateDigest(module.descriptor_digest))}</td><td>${controlStatusMarkup(registrationStatus, registrationLabel)}</td><td>${controlStatusMarkup(runtimeStatus, runtimeLabel)}</td><td><button class="switch" type="button" role="switch" aria-checked="${desired}" aria-label="期望启用 ${escapeHtml(module.module_id)}" data-control-action="toggle-module" data-module-id="${escapeHtml(module.module_id)}" data-module-version="${escapeHtml(module.version)}"><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span><span>${desired ? "草稿启用" : "草稿停用"}</span></button></td></tr>`;
  }).join("")}</tbody></table></div></section>`;
}

function renderControlInspector(data) {
  const module = controlSelectedModule(data);
  if (!module) return `<aside class="panel module-inspector" aria-labelledby="module-inspector-title"><div class="card-head"><div><h2 id="module-inspector-title">模块检查器</h2><p>选择模块后显示脱敏登记证据。</p></div></div>${emptyState("未选择模块", "服务端未返回可检查模块。")}</aside>`;
  const [runtimeStatus, runtimeLabel] = controlRuntimeState(module, data);
  const registration = module.registration;
  return `<aside class="panel module-inspector" aria-labelledby="module-inspector-title"><div class="card-head"><div><h2 id="module-inspector-title">模块检查器</h2><p>只显示本地构建证据；运行时读回不是签名，也不是生产资格。</p></div>${controlStatusMarkup(runtimeStatus, runtimeLabel)}</div><dl class="key-value-list"><div class="key-value-row"><dt>模块名称</dt><dd>${escapeHtml(module.module_id)}</dd></div><div class="key-value-row"><dt>版本</dt><dd>${escapeHtml(module.version)}</dd></div><div class="key-value-row"><dt>风险级别</dt><dd>${escapeHtml(module.risk_level)}</dd></div><div class="key-value-row"><dt>证据等级</dt><dd>本地构建</dd></div><div class="key-value-row"><dt>生产资格</dt><dd>${controlStatusMarkup("blocked", "未获生产资格")}</dd></div><div class="key-value-row"><dt>描述摘要</dt><dd>${escapeHtml(abbreviateDigest(module.descriptor_digest))}</dd></div><div class="key-value-row"><dt>登记人</dt><dd>${registration ? escapeHtml(redactReference(registration.registered_by_actor_ref, "已记录（身份隐藏）")) : "未登记"}</dd></div><div class="key-value-row"><dt>登记时间</dt><dd>${registration ? escapeHtml(registration.registered_at) : "未登记"}</dd></div><div class="key-value-row"><dt>工具范围</dt><dd>${module.tool_names.length ? module.tool_names.map((name) => escapeHtml(name)).join("、") : "未返回"}</dd></div><div class="key-value-row"><dt>规范引用</dt><dd>${module.standard_ids.length ? module.standard_ids.map((name) => escapeHtml(name)).join("、") : "未返回"}</dd></div></dl></aside>`;
}

function renderControlPreview(data) {
  const draft = controlDraftModules(data);
  const current = data.activation?.active_modules ?? [];
  const diff = deriveDesiredDraftDiff(current, draft);
  const preview = data.latest_preview;
  const previewPresentation = derivePreviewPresentation(data);
  const validation = preview && isRecord(preview.validation) ? Object.entries(preview.validation).filter(([, value]) => typeof value === "boolean") : [];
  const validationMarkup = validation.length
    ? `<ul class="validation-list" aria-label="预览校验结果">${validation.map(([key, value]) => `<li><span>${escapeHtml(CONTROL_VALIDATION_LABELS[key] ?? "校验项")}</span>${controlStatusMarkup(value ? "complete" : "manual_review", value ? "通过" : "需确认")}</li>`).join("")}</ul>`
    : `<p class="muted">服务端尚未返回逐项校验；不推断为通过。</p>`;
  return `<section class="panel control-preview-panel" aria-labelledby="control-preview-title"><div class="card-head"><div><h2 id="control-preview-title">预览差异与校验</h2><p>差异来自运行时读回和浏览器草稿；只有生成预览后才进入服务端审批链。</p></div>${controlStatusMarkup(previewPresentation.status, previewPresentation.label)}</div><div class="diff-summary"><div><strong>${diff.added.length}</strong><span>新增</span></div><div><strong>${diff.removed.length}</strong><span>移除</span></div><div><strong>${diff.retained.length}</strong><span>保留</span></div></div>${preview ? `<dl class="key-value-list"><div class="key-value-row"><dt>创建人</dt><dd>${escapeHtml(redactReference(preview.creator_actor_ref, "未返回"))}</dd></div><div class="key-value-row"><dt>创建时间</dt><dd>${escapeHtml(preview.created_at ?? "未返回")}</dd></div><div class="key-value-row"><dt>有效期</dt><dd>${escapeHtml(preview.expires_at ?? "未返回")}</dd></div></dl>${validationMarkup}` : `<p class="muted">先保存草稿并生成预览，服务端才会返回校验、创建人和有效期。</p>`}</section>`;
}

function releaseStatusLabel(status) {
  if (status === "active" || status === "active_verified") return ["complete", "运行时已读回"];
  if (status === "manual_review") return ["manual_review", "人工复核"];
  if (status === "superseded") return ["empty", "已替代"];
  if (status === "published_pending_readback") return ["pending", "读回待确认"];
  return ["pending", "待确认"];
}

function renderControlReleaseTrail(data) {
  const history = Array.isArray(data.release_history) ? data.release_history : [];
  const rollbackReleaseId = selectRollbackReleaseId(data);
  const previous = rollbackReleaseId === null
    ? null
    : history.find((release) => release.release_id === rollbackReleaseId) ?? null;
  return `<section class="panel release-trail-panel" aria-labelledby="release-trail-title"><div class="card-head"><div><h2 id="release-trail-title">发布轨迹与回滚目标</h2><p>回滚仍经过预览、双人审批和发布读回，不直接改运行时。</p></div>${controlStatusMarkup(history.length ? "complete" : "empty", history.length ? `${history.length} 条服务端记录` : "暂无记录")}</div>${history.length ? `<ol class="trail-list">${history.slice(0, 8).map((release) => { const [status, label] = releaseStatusLabel(release.status); return `<li><div><strong>${escapeHtml(redactReference(release.release_id, "发布记录"))}</strong><span>${release.revision === undefined ? "修订号未返回" : `修订 ${escapeHtml(String(release.revision))}`}</span></div>${controlStatusMarkup(status, label)}</li>`; }).join("")}</ol><p class="rollback-target">回滚目标：<strong>${previous ? "回滚到上一已读回版本（本地受控环境，标识隐藏）" : "未返回"}</strong></p>` : emptyState("暂无发布轨迹", "服务端没有返回可用的回滚目标。")}</section>`;
}

function renderControlActions(data) {
  const draft = controlDraftModules(data);
  const selected = controlSelectedModule(data);
  const availability = actionAvailability({
    state: data,
    draftModules: draft,
    actorRole: controlCurrentActorRole(),
    actorRef: controlActorReference(),
    creatorActorRef: data.latest_preview?.creator_actor_ref,
    environment: state.mode,
  });
  const disabled = (key, extra = "") => availability[key] ? extra : ` disabled aria-disabled="true" title="当前服务端状态不允许此操作"${extra}`;
  const registerDisabled = selected?.registration !== null ? " disabled aria-disabled=\"true\" title=\"该模块已登记\"" : disabled("register");
  return `<section class="panel control-actions-panel" aria-labelledby="control-actions-title"><div class="card-head"><div><h2 id="control-actions-title">本地受控操作</h2><p>保存草稿只留在当前页面；服务端失败或人工复核时保留原状态。</p></div>${controlStatusMarkup(state.controlStatus)}</div><div class="button-row control-action-row"><button class="button button-secondary" type="button" data-control-action="save-draft">保存草稿</button><button class="button button-secondary" type="button" data-control-action="register"${registerDisabled}>登记选中模块</button><button class="button button-secondary" type="button" data-control-action="generate-preview"${disabled("generatePreview")}>生成预览</button><button class="button button-secondary" type="button" data-control-action="submit-approval"${disabled("submitApproval")}>提交审批</button><button class="button button-primary" type="button" data-control-action="publish"${disabled("publish")}>发布并读回</button><button class="button button-secondary" type="button" data-control-action="reconcile"${disabled("reconcile")}>重新读回</button><button class="button button-secondary" type="button" data-control-action="rollback"${disabled("rollback")}>回滚到上一已读回版本（本地受控环境）</button></div></section>`;
}

function renderModuleCenter(data) {
  const controlData = state.controlState;
  return `${pageHeader("modules", `<button class="button button-secondary" type="button" data-control-action="refresh">重新读取</button>`)}
    <div class="callout callout-warning external-authority-warning" role="alert"><div class="callout-head"><h2>外部权威系统</h2>${controlStatusMarkup("manual_review", "固定提醒")}</div><p>报价、关务与客户数据仍由外部权威系统管理</p></div>
    ${controlNoticeMarkup()}
    ${renderControlIdentityPanel()}
    ${state.controlStateLoading ? `<section class="panel loading-panel" aria-live="polite">${statusMarkup("loading")}<h2>正在读取模块控制面</h2><p>只读取服务端状态；未返回前不显示假激活状态。</p></section>` : controlData ? `${renderControlReleaseRail(controlData)}${renderControlStatusCards(controlData)}<div class="module-workspace">${renderControlModuleTable(controlData)}${renderControlInspector(controlData)}</div><div class="control-detail-grid">${renderControlPreview(controlData)}${renderControlReleaseTrail(controlData)}</div>${renderControlActions(controlData)}` : ""}`;
}

export function safeOpaqueReference(value, prefix) {
  const reference = snapshotText(value).trim();
  if (reference === "") return "未返回";
  void prefix;
  return "已配置（具体内容隐藏）";
}

function toolKindStatus(node) {
  if (node.kindLabel === "read") return statusMarkup("ready", "只读");
  if (node.kindLabel === "write") return statusMarkup("manual_review", "受控写入");
  return statusMarkup(node.kindLabel === "" ? "unavailable" : "manual_review", node.kindLabel === "" ? "操作类型未返回" : "操作类型未知");
}

export function architectureNodeStatus(node, kind) {
  if (kind === "control") return '<span class="architecture-static-tag">固定边界</span>';
  if (kind === "client") return statusMarkup(node.status);
  if (kind === "source") return statusMarkup(node.readiness);
  if (kind === "approval") return statusMarkup(node.status, node.status === "empty" ? "未返回" : undefined);
  if (node.invalidName) return statusMarkup("manual_review", "名称异常");
  if (kind === "tool" && node.availability) return statusMarkup(node.availability);
  if (node.sourceReadiness) return statusMarkup(node.sourceReadiness);
  return toolKindStatus(node);
}

function architectureNodeMarkup(node, kind, selected = false) {
  const label = node.displayName ?? node.label;
  const layerLabel = {
    client: "客户端",
    control: "平台控制层",
    tool: "工具",
    source: "数据来源",
    approval: "审批生命周期",
  }[kind] ?? "未知层级";
  return `<button class="architecture-node architecture-node-${escapeHtml(kind)}${selected ? " is-selected" : ""}" type="button" data-architecture-kind="${escapeHtml(kind)}" data-architecture-id="${escapeHtml(node.id)}" aria-pressed="${selected}">
    <span class="architecture-node-title">${display(label)}</span>
    <span class="architecture-node-status">${architectureNodeStatus(node, kind)}</span>
    <span class="sr-only">层：${escapeHtml(layerLabel)}；按回车键查看详情</span>
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
      ["包含", "身份、租户与操作人绑定、角色权限清单和审计"],
      ["证据属性", "固定结构说明，不是实时证据"],
    ];
  } else if (selection.kind === "client") {
    rows = [
      ["接入标识", display(recordedSummary(node.clientId, "接入标识"))],
      ["接入校验", architectureNodeStatus(node, "client")],
      ["安全边界", "仅显示认证后的元数据；不显示凭证或客户内容"],
    ];
  } else if (selection.kind === "tool") {
    const group = model.toolGroups.find((item) => item.key === node.groupKey);
    const executionGroup = model.executionGroups.find((item) => item.key === node.executionKey);
    const sourceLabel = {
      quote: "智能报价服务",
      customs: "关务查询服务",
      pdf: "报价单服务",
    }[node.sourceBusinessKey];
    rows = [
      ["工具", display(node.displayName, "未命名工具")],
      ["分组", display(group?.label, "未知工具/未分类")],
      ["执行方式", display(executionGroup?.label, "未返回")],
      ["依赖来源", display(sourceLabel, "本地或未返回")],
      ["操作类型", toolKindStatus(node)],
      ["当前可用性", node.availability ? statusMarkup(node.availability) : "未返回"],
      ["授权角色", roleChips(node.roles)],
    ];
  } else if (selection.kind === "source") {
    rows = [
      ["来源", display(node.label, "未返回")],
      ["环境", display(node.environment, "未返回")],
      ["类型", display(node.type, "未返回")],
      ["就绪状态", architectureNodeStatus(node, "source")],
      ["登记状态", display(node.registrationStatus, "未返回")],
      ["接口配置", display(safeOpaqueReference(node.endpointRef, "endpoint_ref"))],
      ["凭证配置", display(safeOpaqueReference(node.secretRef, "secret_ref"))],
      ["接口约定", display(versionSummary(node.adapterContractVersion))],
      ["业务版本证据", sourceEvidenceMarkup(node.businessVersionEvidence)],
      ["更新方式", display(node.updateMode, "未返回")],
      ["最近检查", display(node.lastCheckedAt, "未返回")],
      ["最近成功", display(node.lastSuccessAt, "未返回")],
      ["关联工具", displayToolList(node.affectedTools)],
      ["状态说明", display(node.reason, "未返回")],
      ["阻断原因", display(node.blocker, "未返回")],
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
  const executionGroups = model.executionGroups.map((group) => `<section class="architecture-tool-group" aria-labelledby="architecture-execution-${escapeHtml(group.key)}"><div class="architecture-group-head"><h4 id="architecture-execution-${escapeHtml(group.key)}">${escapeHtml(group.label)}</h4><span>${escapeHtml(group.tools.length)} 个</span></div><p>${escapeHtml(group.description)}</p>${architectureNodesMarkup(group.tools, "tool", "快照没有返回该执行类型的工具。")}</section>`).join("");
  const supporting = model.supportingTools.length === 0 ? "" : `<section class="architecture-tool-group" aria-labelledby="architecture-supporting-tools"><div class="architecture-group-head"><h4 id="architecture-supporting-tools">平台支持和其他已注册工具</h4><span>${escapeHtml(model.supportingTools.length)} 个</span></div><p>精选知识、系统状态、人工复核和未知工具单列，不归入业务接口执行。</p><div class="architecture-node-list">${model.supportingTools.map((tool) => architectureNodeMarkup(tool, "tool", isArchitectureSelection(tool))).join("")}</div></section>`;
  if (executionGroups === "" && supporting === "") return architectureNodesMarkup([], "tool", "快照没有返回工具，不生成工具节点。");
  return `<div class="architecture-tool-groups">${executionGroups}${supporting}</div>`;
}

function renderArchitectureLifecycle(model) {
  if (model.approvalLifecycle.length === 0) {
    return emptyState("暂无审批链", "快照没有返回审批步骤；不把固定步骤画成完成。");
  }
  const stages = model.approvalLifecycle.map((stage, index) => `${architectureNodeMarkup(stage, "approval", isArchitectureSelection(stage))}${index < model.approvalLifecycle.length - 1 ? '<span class="architecture-lifecycle-arrow" aria-hidden="true">→</span>' : ""}`).join("");
  const extras = model.unmappedApprovals.length === 0 ? "" : `<div class="architecture-unmapped"><h3>链中未分类步骤</h3><div class="architecture-node-list">${model.unmappedApprovals.map((item) => architectureNodeMarkup(item, "approval", isArchitectureSelection(item))).join("")}</div></div>`;
  return `<p class="architecture-lifecycle-copy">顺序：草稿 → 校验 → 审批 → 发布 → 读回或回滚。每个阶段的状态只取快照审批链；缺步或已阻断都不判定成功。</p><div class="architecture-lifecycle-steps">${stages}</div>${extras}`;
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
      <p>工具权限清单、客户端校验、来源就绪状态和审批状态分别来自已校验快照；本页不把四类状态汇总成“系统健康”或“可发布”。</p>
    </div>
    <div class="architecture-layout">
      <section class="panel architecture-panel" aria-labelledby="architecture-diagram-title">
        <div class="card-head"><div><h2 id="architecture-diagram-title">系统结构图</h2><p>客户端 → 平台控制层 → 两类执行 → 数据来源</p></div><span class="architecture-static-tag">分层结构</span></div>
        <div class="architecture-flow" aria-label="客户端、平台控制层、工具和来源的结构关系">
          <section class="architecture-layer" aria-labelledby="architecture-clients-title"><div class="architecture-layer-head"><h3 id="architecture-clients-title">客户端</h3><p>通过身份与租户边界接入</p></div>${architectureNodesMarkup(model.clients, "client", "快照没有返回客户端，不生成客户端节点。")}</section>
          ${architectureRelation("通过身份与租户边界接入")}
          <section class="architecture-layer" aria-labelledby="architecture-control-title"><div class="architecture-layer-head"><h3 id="architecture-control-title">平台控制层</h3><p>认证后绑定租户和操作人，按角色权限调用</p></div><div class="architecture-node-list">${architectureNodeMarkup(model.controlLayer, "control", isArchitectureSelection(model.controlLayer))}</div></section>
          ${architectureRelation("认证后绑定租户和操作人，按角色权限调用")}
          <section class="architecture-layer" aria-labelledby="architecture-tools-title"><div class="architecture-layer-head"><h3 id="architecture-tools-title">工具执行层</h3><p>本地确定性计算与外部接口调用分开</p></div>${renderArchitectureToolGroups(model)}</section>
          ${architectureRelation("本地计算；外部请求时直连，不缓存、不轮询")}
          <section class="architecture-layer" aria-labelledby="architecture-sources-title"><div class="architecture-layer-head"><h3 id="architecture-sources-title">数据来源</h3><p>提供版本、引用和就绪原因；返回结构化结果</p></div>${architectureNodesMarkup(model.sources, "source", "快照没有返回来源，不生成来源节点。")}</section>
        </div>
        <p class="architecture-footnote">客户端调用工具；控制层负责认证、租户与操作人绑定、角色权限清单和审计。来源状态不是实时连通性证明。</p>
      </section>
      <aside class="panel architecture-details" aria-labelledby="architecture-details-title">
        <div class="card-head"><div><h2 id="architecture-details-title">节点详情</h2><p>只展示快照安全字段或固定边界说明。</p></div></div>
        ${renderArchitectureDetails(model)}
      </aside>
    </div>
    <section class="panel architecture-approval-panel" aria-labelledby="architecture-lifecycle-title">
      <div class="card-head"><div><h2 id="architecture-lifecycle-title">审批发布生命周期</h2><p>第二张图只从快照审批链映射状态；缺步骤、已阻断或未读回都不会显示为成功。</p></div><span class="architecture-static-tag">独立状态</span></div>
      ${renderArchitectureLifecycle(model)}
    </section>`;
}

function renderView() {
  if (state.loading) return renderLoading();
  if (state.view === "modules") return renderModuleCenter(state.data);
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
  tenantName.textContent = toChineseDisplayText(data?.tenant?.name, state.loading ? "读取中" : "未连接");
  environment.innerHTML = state.loading
    ? statusMarkup("loading")
    : isDemoSnapshot()
      ? statusMarkup("manual_review", "演示数据")
      : data
        ? statusMarkup("ready", "正式快照")
        : statusMarkup("unavailable", "未连接");
  configVersion.textContent = versionSummary(data?.config?.current_version);
  actorName.textContent = state.controlActor?.label ?? toChineseDisplayText(data?.actor?.name, "未认证");
  actorRole.textContent = state.controlActor?.role ? roleLabel(state.controlActor.role) : data?.actor?.role ? roleLabel(data.actor.role) : "—";
  footerMode.textContent = state.controlActor && state.mode === "fixture"
    ? "本地控制面 · 运行时状态以读回为准"
    : isDemoSnapshot()
      ? "演示数据 · 未连接正式后台"
      : "正式快照 · 失败闭合";
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
    body.innerHTML = `<p class="muted">以下差异只在浏览器本地展示，未保存到服务器：</p><ul class="diff-list">${changes.map((change, index) => `<li class="diff-item"><span class="diff-path">${display(changeLabel(change.path, index))}</span><div class="diff-values"><span>变更前：<strong>${display(change.before)}</strong></span><span>变更后：<strong>${display(change.after)}</strong></span></div><div>${statusMarkup(change.status)}</div></li>`).join("")}</ul>`;
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
    } catch {
      state.error = { message: "演示数据加载失败，请联系管理员检查文件。" };
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
    if (!response.ok) throw new Error(`同源快照返回异常状态（${response.status}）。`);
    const snapshot = await response.json();
    state.data = validateSnapshot(snapshot);
  } catch (error) {
    state.error = { message: error instanceof Error && !/[A-Za-z]/.test(error.message) ? error.message : "同源快照请求失败，请检查后台服务。" };
  }
  state.loading = false;
  render();
}

function controlIdempotencyKey() {
  const suffix = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${state.controlActor?.actor ?? "session"}`;
  return `admin-ui-${suffix}`;
}

function setControlState(controlState) {
  state.controlState = validateControlState(controlState);
  if (!state.controlDraftDirty) {
    state.controlDraftModules = state.controlState.activation.active_modules.map(controlModuleRef);
  }
  if (state.controlSelection === null && state.controlState.inventory_modules.length > 0) {
    state.controlSelection = controlModuleKey(state.controlState.inventory_modules[0]);
  }
}

async function loadControlState({ announce = false, preserveNotice = false } = {}) {
  if (!controlClient || !state.controlActor) {
    state.controlStatus = "needs_input";
    state.controlStateLoading = false;
    render(announce);
    return false;
  }
  state.controlStateLoading = true;
  state.controlError = null;
  render();
  try {
    setControlState(await controlClient.getControlState());
    state.controlStatus = "complete";
    if (!preserveNotice) state.controlNotice = null;
    return true;
  } catch (error) {
    const failure = controlErrorNotice(error, "读取模块控制面");
    state.controlStatus = failure.status;
    state.controlError = failure.detail;
    return false;
  } finally {
    state.controlStateLoading = false;
    render(announce);
  }
}

function openIdentityDialog() {
  if (!identityDialog) return;
  identityDialogTrigger = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
  const input = document.querySelector("#identity-token");
  const error = document.querySelector("#identity-form-error");
  if (input instanceof HTMLInputElement) input.value = "";
  if (error instanceof HTMLElement) error.hidden = true;
  if (typeof identityDialog.showModal === "function") identityDialog.showModal();
  else identityDialog.setAttribute("open", "");
  queueMicrotask(() => input?.focus());
}

function closeIdentityDialog() {
  if (!identityDialog) return;
  const input = document.querySelector("#identity-token");
  const error = document.querySelector("#identity-form-error");
  if (input instanceof HTMLInputElement) input.value = "";
  if (error instanceof HTMLElement) error.hidden = true;
  if (typeof identityDialog.close === "function") identityDialog.close();
  else identityDialog.removeAttribute("open");
  const trigger = identityDialogTrigger;
  identityDialogTrigger = null;
  queueMicrotask(() => trigger?.focus());
}

function bindControlIdentity(identity) {
  if (!controlClient || !identity) return;
  controlClient.setToken(identity.token);
  state.controlActor = {
    ...(typeof identity.actor === "string" ? { actor: identity.actor } : {}),
    label: identity.label,
    role: identity.role,
  };
  state.controlStatus = "pending";
  state.controlError = null;
  state.controlDraftModules = null;
  state.controlDraftDirty = false;
  state.controlNotice = null;
  closeIdentityDialog();
  void loadControlState({ announce: true });
}

function submitControlIdentity() {
  const input = document.querySelector("#identity-token");
  if (!(input instanceof HTMLInputElement)) return;
  const error = document.querySelector("#identity-form-error");
  const token = input.value;
  input.value = "";
  if (token.trim() === "") {
    if (error instanceof HTMLElement) error.hidden = false;
    input.focus();
    return;
  }
  if (error instanceof HTMLElement) error.hidden = true;
  bindControlIdentity({ label: "已绑定控制面身份", role: "admin", token });
}

async function runControlOperation(label, operation, { resetDraft = false } = {}) {
  if (state.controlStateLoading || !controlClient) return;
  state.controlStateLoading = true;
  state.controlStatus = "pending";
  controlNotice("info", "pending", `${label}进行中`, "正在等待服务端结果；运行时状态不会提前变化。", "等待服务端");
  render(true);
  try {
    await operation();
    if (resetDraft) state.controlDraftDirty = false;
    const readbackOk = await loadControlState({ preserveNotice: true });
    if (readbackOk) {
      state.controlStatus = "complete";
      controlNotice("info", "complete", `${label}已完成`, "已重新读取服务端控制状态；页面只显示读回结果。", "服务端已读回");
    }
  } catch (error) {
    const failure = controlErrorNotice(error, label);
    state.controlStatus = failure.status;
    controlNotice("warning", failure.status, `${label}未完成`, failure.detail, CONTROL_STATUS_META[failure.status]?.label ?? "未完成");
    if (failure.status === "manual_review") await loadControlState({ preserveNotice: true });
  } finally {
    state.controlStateLoading = false;
    render(true);
  }
}

async function handleControlAction(target) {
  const action = target.dataset.controlAction;
  if (!action) return;
  if (action === "close-identity") {
    closeIdentityDialog();
    return;
  }
  if (action === "submit-identity") return;
  if (action === "open-identity") {
    openIdentityDialog();
    return;
  }
  if (action === "fixture-identity") {
    const identity = FIXTURE_IDENTITIES.find((item) => item.actor === target.dataset.identity);
    if (state.mode === "fixture" && isFixtureIdentityVisible(window.location.search)) bindControlIdentity(identity);
    return;
  }
  if (action === "select-module") {
    const module = controlModuleFromKey(state.controlState, target.dataset.moduleId, target.dataset.moduleVersion);
    if (module) {
      state.controlSelection = controlModuleKey(module);
      render(true);
      queueMicrotask(() => target.focus());
    }
    return;
  }
  if (action === "toggle-module") {
    const module = controlModuleFromKey(state.controlState, target.dataset.moduleId, target.dataset.moduleVersion);
    if (!module) return;
    const draft = controlDraftModules(state.controlState);
    const key = controlModuleKey(module);
    state.controlDraftModules = draft.some((item) => controlModuleKey(item) === key)
      ? draft.filter((item) => controlModuleKey(item) !== key)
      : [...draft, controlModuleRef(module)];
    state.controlDraftDirty = true;
    controlNotice("info", "pending", "草稿已变更", "期望启用只保存在当前浏览器页面；运行时状态未改变。", "未发布");
    render(true);
    return;
  }
  if (!state.controlState || !state.controlActor) return;
  switch (action) {
    case "refresh":
      await loadControlState({ announce: true });
      break;
    case "save-draft":
      state.controlDraftModules = controlDraftModules(state.controlState).map(controlModuleRef);
      state.controlDraftDirty = true;
      controlNotice("info", "complete", "草稿已保存", "草稿只保留在当前浏览器内存，不写入服务器或浏览器存储。", "仅本地草稿");
      render(true);
      break;
    case "register": {
      const module = controlSelectedModule(state.controlState);
      if (!module || module.registration !== null) return;
      await runControlOperation("登记模块", () => controlClient.registerPackage({
        schema_version: CONTROL_SCHEMA_VERSION,
        module_id: module.module_id,
        version: module.version,
        descriptor_digest: module.descriptor_digest,
      }, controlIdempotencyKey()));
      break;
    }
    case "generate-preview": {
      const desiredModules = controlDraftModules(state.controlState).map(controlModuleRef);
      const allRegistered = desiredModules.length > 0
        && desiredModules.every((targetModule) => state.controlState.inventory_modules.some(
          (inventoryModule) => inventoryModule.module_id === targetModule.module_id
            && inventoryModule.version === targetModule.version
            && inventoryModule.descriptor_digest === targetModule.descriptor_digest
            && inventoryModule.registration !== null,
        ));
      if (!allRegistered) return;
      await runControlOperation("生成预览", () => controlClient.createPreview({
        schema_version: CONTROL_SCHEMA_VERSION,
        intent: "change",
        desired_modules: desiredModules,
      }, controlIdempotencyKey()));
      break;
    }
    case "submit-approval": {
      const preview = state.controlState.latest_preview;
      if (
        preview === null
        || preview.consumed !== false
        || state.controlState.latest_approval?.preview_ref === preview.preview_ref
      ) return;
      await runControlOperation("提交审批", () => controlClient.decideApproval({
        schema_version: CONTROL_SCHEMA_VERSION,
        preview_ref: preview.preview_ref,
        decision: "approve",
        reason_code: "admin_ui_approval",
      }, controlIdempotencyKey()));
      break;
    }
    case "publish": {
      const preview = state.controlState.latest_preview;
      const approval = state.controlState.latest_approval;
      if (
        preview === null
        || approval === null
        || preview.consumed !== false
        || approval.consumed !== false
        || approval.decision !== "approve"
        || approval.preview_ref !== preview.preview_ref
      ) return;
      await runControlOperation("发布并读回", () => controlClient.publish({
        schema_version: CONTROL_SCHEMA_VERSION,
        preview_ref: preview.preview_ref,
        approval_id: approval.approval_id,
      }, controlIdempotencyKey()), { resetDraft: true });
      break;
    }
    case "reconcile": {
      const releaseId = selectReconcileReleaseId(state.controlState);
      if (releaseId === null) return;
      await runControlOperation("重新读回", () => controlClient.reconcile({
        schema_version: CONTROL_SCHEMA_VERSION,
        release_id: releaseId,
      }, controlIdempotencyKey()));
      break;
    }
    case "rollback": {
      const targetReleaseId = selectRollbackReleaseId(state.controlState);
      if (targetReleaseId === null) return;
      await runControlOperation("生成回滚预览", () => controlClient.createPreview({
        schema_version: CONTROL_SCHEMA_VERSION,
        intent: "rollback",
        target_release_id: targetReleaseId,
      }, controlIdempotencyKey()));
      break;
    }
    default:
      break;
  }
}

if (isBrowser) {
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("button, a") : null;
  if (!target) return;
  if (target.dataset.controlAction) {
    void handleControlAction(target);
    return;
  }
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

document.querySelector("#identity-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitControlIdentity();
});

identityDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeIdentityDialog();
});

render();
void loadSnapshot();
}
