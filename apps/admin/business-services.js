// Business navigation is independent of MCP eligibility and runtime snapshots.
const VERSION = "business-entrypoints@2026-09-05.v1";
const PATHS = { quote: { sales: "/quote", ai_quote: "/ai-quote", operations: "/ops" }, customs: { search: "/", calculator: "/calculator" } };
const REASONS = ["quote_entrypoint_unconfigured", "quote_entrypoint_invalid", "customs_entrypoint_unconfigured", "customs_entrypoint_invalid"];
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function validateBusinessEntrypoints(value) {
  const invalid = () => { throw new Error("业务入口格式不符合约定，请联系管理员检查配置。"); };
  if (!exactKeys(value, ["schema_version", "status", "data", "reason_codes"]) || value.schema_version !== VERSION || value.status !== "success" || !exactKeys(value.data, ["quote", "customs"]) || !Array.isArray(value.reason_codes) || value.reason_codes.some((reason) => !REASONS.includes(reason))) invalid();
  for (const [service, paths] of Object.entries(PATHS)) {
    const entry = value.data[service];
    if (!exactKeys(entry, ["configured", ...Object.keys(paths)]) || typeof entry.configured !== "boolean") invalid();
    let expectedOrigin;
    for (const [key, pathname] of Object.entries(paths)) {
      if (!entry.configured) { if (entry[key] !== null) invalid(); continue; }
      const href = entry[key];
      if (typeof href !== "string" || href.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(href)) invalid();
      let url;
      try { url = new URL(href); } catch { invalid(); }
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) invalid();
      if (url.username || url.password || url.search || url.hash || url.pathname !== pathname || href !== `${url.origin}${pathname}`) invalid();
      if (expectedOrigin && expectedOrigin !== url.origin) invalid();
      expectedOrigin = url.origin;
    }
    const reasons = value.reason_codes.filter((reason) => reason.startsWith(`${service}_`));
    if (entry.configured ? reasons.length !== 0 : reasons.length !== 1) invalid();
  }
  return value;
}

const SVG = {
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  external: '<path d="M14 4h6v6m0-6L10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
  quote: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h5M8 16h3m4 0h1"/>',
  customs: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  calculator: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8M8 11h1m6 0h1M8 15h1m6 0h1M8 19h1m6 0h1"/>',
};
const icon = (name) => `<svg class="business-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name]}</svg>`;

function context(options = {}) {
  if (options.entryStatus === "loading") return { status: "loading", data: null };
  if (options.entryStatus === "error") return { status: "error", data: null };
  try { return { status: "ready", data: validateBusinessEntrypoints(options.entries).data, reasons: options.entries.reason_codes }; }
  catch { return { status: "error", data: null }; }
}

function launch(ctx, service, key, label, primary = true) {
  const href = ctx.data?.[service]?.[key];
  if (!href) return `<button type="button" class="button ${primary ? "button-secondary" : "button-quiet"}" data-action="${ctx.status === "error" ? "retry-business" : "business-setup"}">${ctx.status === "loading" ? "查看入口说明" : ctx.status === "error" ? "重新读取入口" : "查看接入说明"}${icon("arrow")}</button>`;
  return `<a class="button ${primary ? "button-primary" : "button-secondary"}" href="${escape(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" data-business-link="${service}.${key}">${label}${icon("external")}<span class="sr-only">（在新标签页打开）</span></a>`;
}

function originText(ctx, service) {
  const href = service === "quote" ? ctx.data?.quote?.sales : ctx.data?.customs?.search;
  return href ? escape(new URL(href).host) : ctx.status === "loading" ? "正在读取入口" : ctx.status === "error" ? "入口信息读取失败" : ctx.reasons?.includes(`${service}_entrypoint_invalid`) ? "入口配置需要修正" : "尚未配置工作台地址";
}

function accessNote(ctx, service) {
  return ctx.data?.[service]?.configured
    ? '<span class="entry-status"><span class="entry-status-dot" aria-hidden="true"></span>入口已设置 · 访问状态未验证</span>'
    : `<span class="entry-status">${originText(ctx, service)}</span>`;
}

function agentStatus(snapshot, service) {
  const source = snapshot?.sources?.find((item) => item?.business_key === service);
  if (!source) return "未核验";
  if (source.readiness === "unavailable") return "尚未接通";
  if (source.readiness === "manual_review") return "待核验";
  return "待调用验证";
}

function setup(ctx) {
  return `<details class="entry-setup" id="business-entry-setup"><summary>业务入口设置<span>由管理员维护两个原服务地址</span></summary><div class="entry-setup-body">
    <p>报价和关务保留各自的登录与业务权限。入口配置只负责打开原工作台，不会开通 Agent 调用，也不会传递客户资料。</p>
    <div class="entry-config-row"><strong>AI 自动报价</strong><span>${originText(ctx, "quote")}</span></div>
    <div class="entry-config-row"><strong>RiskCustoms 关务</strong><span>${originText(ctx, "customs")}</span></div>
    <p class="entry-admin-note">管理员在服务启动配置中设置 <span class="technical-reference">MCP_QUOTE_UI_ORIGIN</span> 和 <span class="technical-reference">MCP_CUSTOMS_UI_ORIGIN</span>，只填站点地址，不包含账号、密钥或业务路径。更新配置并重启后，重新读取入口。</p>
    <button class="button button-secondary" type="button" data-action="retry-business">重新读取入口</button>
  </div></details>`;
}

function serviceHealth(ctx, snapshot, service) {
  return `<div class="service-health" aria-label="${service === "quote" ? "报价" : "关务"}服务状态">
    <div><span>工作台入口</span><strong>${ctx.data?.[service]?.configured ? "已设置" : ctx.status === "loading" ? "读取中" : ctx.status === "error" ? "读取失败" : "待配置"}</strong></div>
    <div><span>业务数据</span><strong>在原服务核验</strong></div>
    <div><span>Agent 接入</span><strong>${agentStatus(snapshot, service)}</strong></div>
  </div>`;
}

export function renderBusinessHome(snapshot, options = {}) {
  const ctx = context(options);
  return `<section class="business-welcome" aria-labelledby="business-home-title"><div><h1 id="business-home-title">把一票业务，顺着做完。</h1><p>询价、查关务、算税费，从熟悉的工作台开始。</p></div><button class="button button-quiet" type="button" data-action="business-setup">入口设置</button></section>
  <div class="business-start-grid">
    <section class="quote-start" aria-labelledby="quote-start-title"><div class="business-service-label">${icon("quote")}<span>AI 自动报价</span></div><div class="quote-start-copy"><h2 id="quote-start-title">从客户需求，<br />到一份清楚的报价。</h2><p>在原工作台核对运输资料、查看费用与风险，继续处理报价记录。</p></div><div class="business-primary-actions">${launch(ctx, "quote", "sales", "开始询价")}<button class="button button-quiet" type="button" data-view="inquiries">了解报价流程 ${icon("arrow")}</button></div>${accessNote(ctx, "quote")}<div class="business-mini-flow"><span>核对资料</span>${icon("arrow")}<span>计价与风险</span>${icon("arrow")}<span>原业务处理</span></div></section>
    <div class="customs-start-stack"><section class="customs-start" aria-labelledby="customs-start-title"><div class="business-service-label">${icon("customs")}<span>RiskCustoms</span></div><h2 id="customs-start-title">查询关务</h2><p>对照中、美、加编码，核对税率、措施与来源。</p><div class="business-primary-actions">${launch(ctx, "customs", "search", "查询关务", false)}<button class="button button-quiet" type="button" data-view="customs" aria-label="了解关务查询">${icon("arrow")}</button></div></section>
    <section class="calculator-start" aria-labelledby="calculator-start-title"><div class="calculator-heading">${icon("calculator")}<h2 id="calculator-start-title">估算进口税费</h2></div><p>用已确认的商品资料和货值，估算美国或加拿大进口税费。</p>${launch(ctx, "customs", "calculator", "估算进口税费", false)}</section></div>
  </div>
  <section class="business-service-register" aria-labelledby="service-register-title"><div class="business-section-head"><h2 id="service-register-title">两个服务，各自有据可查</h2><span>入口配置与业务就绪分别确认</span></div><div class="service-register-row"><div class="service-register-name"><strong>AI 自动报价</strong><span>${originText(ctx, "quote")}</span></div>${serviceHealth(ctx, snapshot, "quote")}</div><div class="service-register-row"><div class="service-register-name"><strong>RiskCustoms 关务</strong><span>${originText(ctx, "customs")}</span></div>${serviceHealth(ctx, snapshot, "customs")}</div></section>
  ${setup(ctx)}`;
}

const SERVICES = {
  inquiries: { service: "quote", key: "sales", name: "AI 自动报价", title: "询价工作台", description: "从现有报价流程开始，资料、计价与人工处理在同一个业务服务里完成。", action: "打开报价工作台", hint: "报价页面按原服务权限提供记录、客户回复及通知功能。", points: [["录入并核对需求", "手动录入运输资料；有客户原话时，也可以从 AI 报价开始。"], ["查看费用与风险", "确定性引擎负责计价，需人工判断的情况进入原有处理流程。"], ["继续原业务处理", "在原工作台查看记录、整理客户回复；业务动作按原角色授权。"]] },
  customs: { service: "customs", key: "search", name: "RiskCustoms", title: "关务查询", description: "先确认商品与编码，再对照中、美、加的税率、措施和官方来源。", action: "打开关务查询", hint: "三国结果保留在原关务工作台。编码候选需要确认，数据状态以当次查询为准。", points: [["输入商品或海关编码", "补充查询日期、材质和用途，缩小归类范围。"], ["确认适用编码", "核对候选与追问，保留商品原产国和目的国的区别。"], ["对照税率与来源", "查看税率、监管措施和所需文件，再按需要进行进口税费估算。"]] },
  calculator: { service: "customs", key: "calculator", name: "RiskCustoms", title: "进口税费估算", description: "使用原关务服务的计算器，估算美国或加拿大进口税费。", action: "打开税费计算器", hint: "单项录入或 Excel 批量导入。未确认、不可计算的项目仍需人工核对。", points: [["确认商品与目的国", "先在关务查询中核对编码、商品属性和适用措施。"], ["填写货值和数量", "明确币种、申报数量与日期；申报货值不等于运输报价。"], ["核对分项与汇率", "原计算器展示可估算的费用和待复核项目，保留其数据来源。"]] },
};

export function renderBusinessService(view, snapshot, options = {}) {
  const info = SERVICES[view] ?? SERVICES.inquiries;
  const ctx = context(options);
  const alternatives = view === "inquiries"
    ? `${launch(ctx, "quote", "ai_quote", "从客户原话开始", false)}${launch(ctx, "quote", "operations", "处理报价异常", false)}`
    : `<button class="button button-secondary" type="button" data-view="${view === "customs" ? "calculator" : "customs"}">${view === "customs" ? "查看税费估算" : "先查询商品编码"}${icon("arrow")}</button>`;
  return `<header class="business-page-heading"><button class="button button-quiet back-to-workspace" type="button" data-view="overview">${icon("arrow")} 返回工作台</button><h1>${info.title}</h1><p>${info.description}</p></header>
    <section class="service-workspace"><div class="service-workspace-main"><div class="business-service-label">${icon(view === "inquiries" ? "quote" : view === "customs" ? "customs" : "calculator")}<span>${info.name}</span></div><h2>继续使用原业务工作台</h2><p>${info.hint}</p><div class="business-primary-actions">${launch(ctx, info.service, info.key, info.action)}</div>${accessNote(ctx, info.service)}<div class="service-alternatives">${alternatives}</div></div><div class="service-journey"><h2>这次操作怎么完成</h2><ol>${info.points.map(([title, description]) => `<li><strong>${title}</strong><p>${description}</p></li>`).join("")}</ol></div></section>
    <section class="business-service-register"><div class="business-section-head"><h2>当前连接情况</h2><button class="button button-quiet" type="button" data-view="adapters">查看 Agent 接入详情 ${icon("arrow")}</button></div>${serviceHealth(ctx, snapshot, info.service)}<p class="service-context-note">打开工作台会进入新标签页。当前不会自动带入资料，也不会恢复某一票历史结果。</p></section>
    ${setup(ctx)}`;
}
