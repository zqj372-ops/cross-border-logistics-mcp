import { legacyConfigurationRoute } from './service-catalog.js';
import { createWorkspaceHome } from './workspace-home.js';
import { createNativeAdminUi } from './native-admin.js';
import { createChannelsUi, createCliAuthorizationUi } from "./channels.js";
import { createLoginForm } from "./login.js";
import { createCasesUi } from "./cases.js";
import { icon } from './icons.js';
import { rememberLoginDestination, consumeLoginDestination } from './login-destination.js';
import { createCliGuide } from './cli-guide.js';
import { createServiceHome } from './home.js';
import { createCustomsHistoryUi } from "./customs-history.js";
import { createCallLogUi } from "./calls.js";
import { createBusinessWorkspace } from './business.js';
import { createTaxWorkspace } from './tax.js';
import { createDeveloperGuide } from './developer.js';
import { createBusinessAccessUi } from './business-access.js';
import { createCapabilityMarket } from './market.js';
import { createApiKeysUi } from './api-keys.js';
import { createServiceAccessUi } from './service-access.js';
import { createOperationManual } from './manual.js';
import { verifyCredentialAfterDelivery } from './credential-verification.js';
const PUBLIC_PAGES = ['home', 'market', 'catalog', 'service', 'guide', 'cli', 'customs', 'tax'];
const API = '/console/api/v1';
const app = document.querySelector('#app');
const dialog = document.querySelector('#secret-dialog');
const model = { session: null, state: null, credentials: new Map(), secret: null, busy: false, requestKeys: new Map(), call: null, admissions: null, admissionsLoading: false };
const labels = { owner: '管理员（负责人）', admin: '管理员', developer: '业务用户（接口权限）', viewer: '业务用户', reviewer: '管理员（审核权限）', operator: '管理员', draft: '草稿', submitted: '待审核', in_review: '审核中', needs_input: '待补充', approved: '已通过', rejected: '未通过', withdrawn: '已撤回', provisioning: '待开通', active: '已生效', suspended: '已停用', revoked: '已撤销', expired: '已过期', pending: '待接受', claimed: '已加入', test: '测试', production: '正式', pending_delivery: '待确认交付', delivered: '已交付' };
const capabilities = {
  'cargo.calculate': { name: '货物计算', description: '体积、体积重与计费重，使用已有确定性计算引擎。', icon: 'box' },
  'container.plan_summary': { name: '装柜规划', description: '装载汇总、容量与限制提示。', icon: 'container' },
  'system.agent_context.get': { name: 'Agent 接入上下文', description: '读取当前工具规范与调用上下文。', icon: 'code' },
  'quote.freightcom_ltl.preview': { name: '运费询价', description: '复用现有询价引擎与报价记录。', icon: 'truck' },
  'customs.tariff_lookup': { name: '关税查询', description: '复用关务服务的税则、版本与来源依据。', icon: 'file' },
  'customs.query': { name: '关税查询', description: '复用关务服务的税则、版本与来源依据。', icon: 'file' },
  'quote.calculate': { name: '运费询价', description: '复用现有询价引擎与报价记录。', icon: 'truck' },
  'quote.zone_preview': { name: '加拿大尾程询价', icon: 'truck' },
  'quote.ai_extract_preview': { name: '询价资料提取', icon: 'file' },
  'customs.tax.estimate': { name: '进口税费估算', icon: 'file' },
};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const uri = (value) => encodeURIComponent(value);
const date = (value) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '尚未设置';
const name = (id) => model.state?.users?.find((user) => user.user_id === id)?.display_name || (id === model.session?.identity?.user_id ? model.session.identity.display_name : '企业成员');
const appName = (id) => model.state?.applications.find((item) => item.application_id === id)?.name || '应用';
const capName = (id) => capabilities[id]?.name || id;
const capPills = (items) => `<div class="pill-list">${items.map((id) => `<span class="badge info">${esc(capName(id))}</span>`).join('')}</div>`;
const badge = (value) => `<span class="badge ${['active', 'approved', 'claimed', 'delivered', 'success'].includes(value) ? 'success' : ['submitted', 'in_review', 'pending', 'provisioning', 'needs_input', 'pending_delivery'].includes(value) ? 'warning' : ['rejected', 'revoked', 'suspended', 'blocked'].includes(value) ? 'error' : ''}">${esc(labels[value] || value)}</span>`;
const route = () => { const [page = 'home', ...parts] = location.hash.slice(1).split('/'); return { page: page || 'home', id: decodeURIComponent(['business-admin','configure'].includes(page) ? parts.join('/') : (parts[0] || '')) }; };
function clearNotice() { clearTimeout(notify.timer); document.querySelector('#notification').hidden = true; }
function closeMenu(restoreFocus = false) { document.querySelector('#sidebar')?.classList.remove('open'); const button = document.querySelector('[data-action=menu]'); button?.setAttribute('aria-expanded', 'false'); const main = document.querySelector('#content'); if (main) main.inert = false; if (restoreFocus) button?.focus(); }
function go(page) { clearNotice(); closeMenu(); closeAccount(); if (location.hash === `#${page}`) render(); else location.hash = page; document.querySelector('#sidebar')?.classList.remove('open'); }
const link = (title, page, primary = false, glyph = '') => `<button type="button" class="button${primary ? ' primary' : ''}" data-go="${esc(page)}">${glyph ? icon(glyph) : ''}${esc(title)}</button>`;
const textLink = (title, page) => `<button type="button" class="text-button" data-go="${esc(page)}">${esc(title)}</button>`;
const head = (title, description, action = '') => `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${action ? `<div class="head-actions">${action}</div>` : ''}</div>`;
const empty = (title, description, action = '', glyph = 'file') => `<div class="empty-state"><div class="empty-symbol">${icon(glyph)}</div><h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</div>`;
const panel = (title, description, body, action = '') => `<section class="panel"><div class="panel-head"><div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div>${action}</div>${body}</section>`;
const table = (headers, rows) => `<div class="table-wrap"><table><thead><tr>${headers.map((item) => `<th scope="col">${esc(item)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const note = (text, tone = '') => `<div class="inline-note ${tone}">${esc(text)}</div>`;
const authRecoveryMessages = Object.freeze({
  login_expired: '登录链接已失效，请重新登录；若刚完成邮箱验证或找回，直接重新登录即可。',
  login_rejected: '本次登录未完成，请重新登录并确认使用已验证的邮箱。',
  login_unavailable: '登录服务暂时无法完成请求，请稍后重新登录。',
});
function authRecoveryNotice() { const category = new URLSearchParams(location.search).get('auth_error'); return category && Object.hasOwn(authRecoveryMessages, category) ? note(authRecoveryMessages[category], 'error') : ''; }
const formError = '<div class="form-error" role="alert" hidden></div>';
const field = (title, id, control, help = '', full = false) => `<div class="field${full ? ' full' : ''}"><label for="${id}">${esc(title)}</label>${control}${help ? `<small>${esc(help)}</small>` : ''}</div>`;
const input = (id, attributes = '') => `<input id="${id}" name="${id}" ${attributes}>`;
const actions = (title, cancel = '') => `<div class="form-actions">${cancel ? link('取消', cancel) : ''}<button class="button primary" type="submit">${esc(title)}</button></div>`;
function orgRole() { return model.state?.memberships.find((item) => item.user_id === model.session.identity.user_id && item.organization_id === model.session.organization_id && item.status === 'active')?.role; }
function reviewer() { return ['reviewer', 'operator'].includes(model.session?.identity?.platform_role); }
function manager() { return ['owner', 'admin'].includes(orgRole()); }
function developer() { return ['owner', 'admin', 'developer'].includes(orgRole()); }
function canCredential(application) { return !reviewer() && developer() && application?.owner_user_id === model.session?.identity?.user_id; }
function effectiveGrants(applicationId) { return model.state.grants.filter((grant) => (!applicationId || grant.application_id === applicationId) && grant.state === 'active' && (!grant.expires_at || Date.parse(grant.expires_at) > Date.now())); }
function notify(message, error = false) { const element = document.querySelector('#notification'); element.textContent = message; element.classList.toggle('error', error); element.hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(() => { element.hidden = true; }, 5000); }
const errors = {
  login_invalid: "账号、密码或验证码不正确，请重新输入。", login_rate_limited: "尝试次数较多，请 10 分钟后再试。",
  native_input_invalid: "请检查导入格式、必填字段、金额和日期；数值使用小数文本。", native_preview_mismatch: "配置已变化，请重新预览后确认。", native_publication_blocked: "存在未通过的来源或配置校验，请先修正草稿。", native_management_denied: "当前账号没有修改业务配置的权限。", native_organization_required: "请切换到要配置的企业。",
  channel_unsaved_changes: "表单有未保存的修改，请先保存草稿再继续。", channels_unavailable: "当前环境尚未启用渠道管理。", channel_input_invalid: "请完整填写渠道资料，并核对日期与编号格式。", channel_code_exists: "渠道编号已存在，请使用其他编号。", channel_expired: "该配置已过期，请先调整有效期。", channel_preview_mismatch: "配置已经变化，请重新预览。", cli_request_not_found: "CLI 登录请求已过期，请在终端重新发起。", cli_auth_unavailable: "当前环境尚未启用 CLI 人员登录。", cases_unavailable: "当前环境尚未启用询价受理。", case_input_invalid: "请检查需求资料，补充内容不能为空。", case_not_found: "询价不存在或当前账号无权查看。", case_management_denied: "当前账号没有处理询价的权限。", case_transition_invalid: "需求状态已变化，请刷新后核对。", case_daily_limit: "今日提交次数已达上限，请稍后再试。",
  credential_bridge_unavailable: '接入服务未配置，暂时无法签发凭证。请联系平台运维。', active_organization_membership_required: '当前企业或成员资格已停用。请退出并重新登录，选择有效企业。', organization_membership_required: '请先接受邀请，取得有效成员资格后再进入企业。', application_access_denied: '当前账号不是应用负责人，无法操作凭证。请联系企业管理员转交负责人。', state_conflict: '记录状态已经变化。请刷新后按照最新状态继续操作。', grant_expiry_invalid: '请选择未来的有效日期；修改授权时只能缩短现有有效期。', grant_scope_expansion_forbidden: '本次只能减少已有授权。新增服务需要重新申请。', membership_required: '当前账号没有有效企业成员资格。请先接受邀请或重新登录。', organization_role_required: '当前企业角色不允许执行此操作。请联系企业管理员。', 'credential_secret.withheld': '完整 Key 不会重复显示。请撤销这枚凭证后创建新的 Key。',
  authentication_required: '登录已过期，请重新登录后继续。', csrf_invalid: '会话已更新，请刷新后重试。', version_conflict: '这条记录已被其他人更新。请刷新页面，核对最新状态。', idempotency_conflict: '该操作的内容已经改变。请刷新后重新提交。',
  organization_required: '请先选择要操作的企业。', member_required: '当前账号没有这家企业的有效成员权限。', role_required: '当前账号没有执行此操作的权限。', grant_required: '所选服务尚未取得有效授权，请先完成申请与开通。', grant_provisioning_readback_unverified: '尚未确认企业和应用的接入状态，暂时无法开通。',
  last_owner_protected: '企业至少需要一位有效的所有者，请先转交管理权。', application_owner_protected: '请先将该成员负责的应用转交给其他负责人。', application_owner_invalid: '应用负责人必须是本企业的有效管理或开发成员。', invitation_unavailable: '邀请已失效或不属于当前登录邮箱。',
  credential_not_found: '凭证不可用或不属于当前应用。', credential_delivery_unconfirmed: '请先确认上一枚凭证已保存。', fixture_identity_forbidden: '当前环境不允许测试身份登录。', body_invalid: '请检查填写内容与所选权限。', portal_unavailable: '服务暂时不可用，请稍后重试。', bridge_unavailable: '接入服务尚未配置，请联系平台管理员。',
  capability_unavailable: '该服务尚未开放申请。', request_state_invalid: '当前申请状态不支持此操作，请刷新查看最新状态。', request_transition_invalid: '当前申请状态不支持此操作，请刷新查看最新状态。', machine_authentication_failed: '凭证验证未通过，请核对 Key 与有效期。', business_grant_not_provisionable: '业务服务连接尚未就绪，或应用状态已变化。请先完成源服务接入，再开通授权。', business_operation_unavailable: '业务服务尚未接通，暂时无法签发或使用凭证。', business_operations_invalid: '请至少选择一项有效的业务服务。', business_credential_conflict: '业务凭证状态已经变化，请刷新后重试。', business_authorization_denied: '当前业务权限已到期、暂停或不包含该操作。', business_application_denied: '企业、应用或负责人已停用，请核对当前接入状态。', business_review_denied: '无法审核当前版本，或申请人与审核人相同。请刷新状态。', business_body_invalid: '请完整填写内容，并使用当前页面提供的选项。', tool_entitlement_denied: '该应用当前没有这项服务的有效权限。',
};
function errorMessage(error) { return errors[error.code] || (error.code === 'network' ? '未收到服务的确认结果。请保持页面，重试会沿用同一操作编号。' : `操作未完成（${error.code || 'unavailable'}）。请检查权限和记录状态后重试。`); }
const organizationSession = () => !!(model.session?.authenticated && model.session.organization_id && !reviewer());
let sessionLoading;
async function ensureSession() {
  if (model.session) return model.session;
  if (!sessionLoading) sessionLoading = request('/session').then(value => { model.session = value; return value; }).finally(() => { sessionLoading = null; });
  return sessionLoading;
}
function quotaBanner() {
  if (organizationSession()) return '';
  const quota = model.publicQuota;
  return `<aside class="visitor-quota" aria-label="访客查询额度"><div><strong>访客查询</strong><span data-quota-summary>${quota ? `今日剩余 ${quota.remaining} / ${quota.limit} 次` : '每天 20 次'}</span></div><p>关税与税费共用额度，批量按商品计次。北京时间零点重置，同一网络共享。</p><button type="button" class="text-button" data-go="account">登录个人中心 ${icon('arrow')}</button></aside>`;
}
function closeAccount(restoreFocus = false) {
  const menu = document.querySelector('#account-menu'); if (menu) menu.hidden = true;
  const button = document.querySelector('[data-action=account-menu]'); button?.setAttribute('aria-expanded', 'false'); if (restoreFocus) button?.focus();
}
async function request(path, { method = 'GET', body, key, acceptBusiness = false, guestRetry = false } = {}) {
  const originalPath = path;
  const publicCustoms = ['/business/customs/query', '/business/customs/tax-estimate', '/business/customs/tax-estimates/batch'].includes(path) && !organizationSession();
  if (publicCustoms) { await ensureSession(); path = path.replace('/business/customs/', '/public/customs/'); }
  const writes = method !== 'GET'; const headers = { Accept: 'application/json' };
  if (writes) Object.assign(headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': model.session?.csrf_token || '', 'Idempotency-Key': key || crypto.randomUUID() });
  const generation = model.sessionGeneration || 0;
  let response; try { response = await fetch(`${API}${path}`, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(writes ? { body: JSON.stringify(body || {}) } : {}), signal: AbortSignal.timeout(20000) }); } catch { throw Object.assign(new Error('network'), { code: 'network' }); }
  if (publicCustoms && response.headers.has('x-freightclaw-quota-remaining')) model.publicQuota = { limit: Number(response.headers.get('x-freightclaw-quota-limit')), remaining: Number(response.headers.get('x-freightclaw-quota-remaining')), resets_at: response.headers.get('x-freightclaw-quota-reset') };
  let result; try { result = await response.json(); } catch { throw Object.assign(new Error('invalid_response'), { code: 'portal_unavailable' }); }
  if (generation !== (model.sessionGeneration || 0)) throw Object.assign(new Error('account_changed'), { code: 'account_changed' });
  if (publicCustoms && !guestRetry && (response.status === 401 || response.status === 403 && result.reason_codes?.includes('csrf_invalid'))) {
    model.session = null;
    await ensureSession();
    if (!model.session.authenticated) { model.state = null; model.directory = null; model.businessCatalog = []; model.credentials.clear(); }
    return request(originalPath, { method, body, key, acceptBusiness, guestRetry: true });
  }
  if (acceptBusiness && typeof result.schema_version === 'string' && ['success', 'needs_input', 'manual_review', 'blocked', 'unavailable'].includes(result.status)) return result;
  if (response.ok && result.status === 'manual_review' && result.secret_delivery?.status === 'withheld') return result;
  if (!response.ok || (result.status && result.status !== 'success')) {
    const code = result.reason_codes?.[0] || result.errors?.[0]?.code || result.error?.code || result.error || 'portal_unavailable';
    throw Object.assign(new Error(String(code)), { code: typeof code === 'string' ? code : 'portal_unavailable' });
  }
  return result;
}
async function mutate(path, method, body, options = {}) {
  const fingerprint = JSON.stringify([model.session?.identity?.user_id, model.session?.organization_id, path, method, body]);
  if (!model.requestKeys.has(fingerprint)) model.requestKeys.set(fingerprint, crypto.randomUUID());
  const value = await request(path, { method, body, key: model.requestKeys.get(fingerprint), ...options });
  // A saved write without verified readback must be retried as the same operation.
  if (!options.acceptBusiness || value.data?.readback_verified === true || value.data?.preview_changed === true) model.requestKeys.delete(fingerprint);
  return value;
}
async function refresh() {
  model.state = (await request('/state')).data;
  if (!model.state) throw Object.assign(new Error('portal_unavailable'), { code: 'portal_unavailable' });
  if (reviewer() && !model.session.organization_id) {
    const platform = (await request('/platform-state')).data;
    const organizations = [...(platform.review?.organizations || []), ...(platform.provisioning?.organizations || [])];
    const applications = [...(platform.review?.applications || []), ...(platform.provisioning?.applications || [])];
    model.state = { ...model.state, platform_organizations: [...new Map(organizations.map((v) => [v.organization_id, v])).values()],
      applications: [...new Map(applications.map((v) => [v.application_id, v])).values()], requests: platform.review?.requests || [],
      grants: platform.grants || platform.provisioning?.grants || [],
      users: (platform.review?.requests || []).map((v) => ({ user_id: v.applicant_user_id, display_name: v.applicant_display_name })) };
  }
  if (!model.session.organization_id && !reviewer()) {
    const memberOrgIds = new Set(model.state.memberships.filter((item) => item.user_id === model.session.identity.user_id && item.status === 'active').map((item) => item.organization_id));
    const organizations = model.state.organizations.filter((item) => item.status === 'active' && memberOrgIds.has(item.organization_id));
    if (organizations.length === 1) {
      model.session = await mutate('/session/organization', 'POST', { organization_id: organizations[0].organization_id });
      model.state = (await request('/state')).data;
    }
  }
  model.directory = (await request('/my-organizations')).data;
  await businessAccess.load();
  model.businessCatalog = model.session.organization_id && !reviewer() ? (await request('/business/services', { acceptBusiness: true })).data?.operations || [] : [];
  model.credentials.clear();
  model.admissions = null;
}
function brand() { return `<a class="brand" href="#home" aria-label="FreightClaw 首页"><span class="brand-mark">${icon('box')}</span><span class="wordmark">FreightClaw<small>物流能力开放平台</small></span></a>`; }
function loginStorage() { try { return window.sessionStorage; } catch { return null; } }
function renderLogin() {
  rememberLoginDestination(['case','channels','cli-authorize','business-admin','quote','configure','market'].includes(route().page) && route().id ? `${route().page}/${route().id}` : route().page, loginStorage());
  document.title = '登录 · FreightClaw';
  app.className = 'login-shell';
  app.innerHTML = `<section class="login-story">${brand()}<h1>从一票需求，<br>到每一步进展。</h1><p>询价、查询和业务协作，都在一个工作台。</p><div class="login-features"><div class="login-feature">${icon('file')}需求与进度随时可查</div><div class="login-feature">${icon('users')}账号登录，权限自动匹配</div><div class="login-feature">${icon('key')}网页与接口共享服务</div></div></section><section class="login-panel"><h2>欢迎回来</h2><p>登录账号，继续你的工作。</p><div id="login-error" role="alert">${authRecoveryNotice()}</div>${model.session?.mode === 'fixtures' ? loginForm.markup() : '<a class="button primary" href="/console/auth/login">账号密码登录</a><a class="login-return" href="#home">返回首页</a>'}</section>`;
}
function ensureShell() {
  const className = 'customer-shell';
  if (app.className === className) return;
  app.className = className;
  app.innerHTML = '<aside id="sidebar" class="sidebar" aria-label="主要导航"></aside><div class="workspace"><header id="topbar" class="topbar"></header><div id="environment-note"></div><main id="content" tabindex="-1"></main></div>';
}
function customerNav() {
  const { page } = route();
  app.dataset.page = page;
  const center = reviewer() ? 'platform' : model.session?.authenticated && orgRole() !== 'developer' ? (model.session.organization_id ? 'workbench' : 'members') : 'api-keys';
  const active = page === 'cli' ? 'cli' : page === 'home' ? 'home' : ['market', 'catalog', 'service', 'configure'].includes(page) ? 'market' : ['guide', 'diagnostics'].includes(page) ? 'guide' : center;
  const targets = [['首页', 'home'], ['服务市场', 'market'], ['CLI', 'cli'], ['操作手册', 'guide']];
  const navItems = targets.map(([title, target]) => `<button type="button" class="nav-item" data-go="${target}" ${active === target ? 'aria-current="page"' : ''}>${title}</button>`).join('');
  const signedIn = model.session?.authenticated;
  const account = `<div class="account-disclosure"><button class="account-toggle" type="button" data-action="account-menu" aria-label="账号菜单" aria-expanded="false" aria-controls="account-menu"><span class="customer-avatar">${signedIn ? esc(model.session.identity.display_name.slice(0, 1)) : icon('account')}</span><svg class="account-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="account-menu" class="account-dropdown" hidden><div class="account-summary"><strong>${signedIn ? esc(model.session.identity.display_name) : '欢迎来到 FreightClaw'}</strong><span>${signedIn ? '管理你的账号与业务' : '登录后管理个人记录与服务'}</span></div><button type="button" data-go="account">${icon('account')}${signedIn ? '个人中心' : '登录个人中心'}</button>${signedIn ? `<button type="button" data-go="cases">${icon('file')}我的询价</button>${manager() || model.session.identity.platform_role === 'operator' ? `<button type="button" data-go="operations">${icon('file')}询价管理</button>${manager() ? '<button type="button" data-go="market/configure">' + icon('grid') + '模块配置</button>' : ''}` : ''}` : ''}${signedIn && !reviewer() ? `<button type="button" data-go="customs-history">${icon('clock')}关务历史</button>${developer() ? `<button type="button" data-go="api-keys">${icon('key')}API Key</button>` : ''}` : ''}${signedIn ? '<button class="account-logout" type="button" data-action="logout">退出登录</button>' : ''}</div></div>`;
  document.querySelector('#sidebar').innerHTML = `<nav>${navItems}</nav>${signedIn ? `<div class="sidebar-footer"><span>${esc(model.session.identity.display_name)}</span></div>` : ''}`;
  document.querySelector('#topbar').innerHTML = `${brand()}<nav class="customer-navigation" aria-label="主导航">${navItems}</nav><div class="customer-account">${account}<button type="button" class="button quiet mobile-menu" data-action="menu" aria-expanded="false" aria-label="打开导航">${icon('menu')}</button></div>`;
  const orgs = model.directory?.organizations?.filter((item) => item.status === 'active' && model.directory.memberships.some((member) => member.organization_id === item.organization_id && member.user_id === model.session.identity.user_id && member.status === 'active')) || [];
  const organization = orgs.length > 1 ? `<label for="organization">当前企业</label><select id="organization" class="organization-select">${orgs.map((item) => `<option value="${esc(item.organization_id)}" ${model.session.organization_id === item.organization_id ? 'selected' : ''}>${esc(item.display_name)}</option>`).join('')}</select>` : `<span>${esc(orgs[0]?.display_name || (signedIn ? model.session.identity.display_name : ''))}</span>`;
  const consolePages = ['business-admin', 'channels', 'cli-authorize', 'cases', 'operations', 'case', 'platform', 'organizations', 'organization', 'organization-new', 'workbench', 'customs-history', 'calls', 'quote', 'quote-history', 'account', 'api-keys', 'apply', 'requests', 'request', 'request-new', 'request-edit', 'grants', 'grant-edit', 'app', 'app-new', 'applications', 'credential-new', 'business-request', 'business-request-new', 'business-request-edit', 'business-grant', 'business-credential', 'activity', 'members', 'member-new', 'member-edit'];
  const subTarget = ['business-admin', 'channels', 'configure'].includes(page) || page === 'market' && route().id === 'configure' ? 'market/configure' : page === 'case' ? (reviewer() || manager() ? 'operations' : 'cases') : page === 'account' ? center : ['api-keys', 'credential-new', 'business-credential'].includes(page) ? 'api-keys' : ['apply', 'requests', 'request', 'request-new', 'request-edit', 'grants', 'grant-edit', 'business-request', 'business-request-new', 'business-request-edit', 'business-grant'].includes(page) ? 'apply' : page.startsWith('member') ? 'members' : page.startsWith('app') ? 'applications' : page;
  const configurationPage = page === 'configure' || page === 'market' && route().id === 'configure';
  const subnav = signedIn && configurationPage ? `<div class="console-context module-context"><div class="console-organization">${organization}</div></div>` : signedIn && (consolePages.includes(page) || page === 'configure' || page === 'market' && route().id === 'configure') ? `<div class="console-context"><div class="console-organization">${organization}</div><nav aria-label="个人中心导航">${(reviewer() ? [...(model.session.identity.platform_role === 'operator' ? [['询价管理', 'operations']] : []), ['工作概览', 'platform'], ['申请审核', 'requests'], ...(model.session.identity.platform_role === 'operator' ? [['服务授权', 'grants'], ['企业准入', 'organizations']] : [])] : [['我的询价', 'cases'], ...(manager() ? [['询价管理', 'operations'], ['模块配置', 'market/configure']] : []), ['工作台', 'workbench'], ...(developer() ? [['API Key', 'api-keys'], ['已开通服务', 'apply']] : []), [manager() ? '成员管理' : '企业成员', 'members'], ['关务历史', 'customs-history'], ['调用记录', 'calls'], ['操作记录', 'activity']]).map(([label, target]) => `<button type="button" class="console-tab" data-go="${target}" ${target === subTarget ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav></div>` : '';
  document.querySelector('#environment-note').innerHTML = `${model.session?.mode === 'fixtures' ? '<div class="fixture-note">本地验收环境 · 测试身份和隔离数据，结果不代表生产数据。</div>' : ''}${subnav}`;
}
function nav() { customerNav(); }
function serviceItems() {
  const ordinary = model.state.catalog.filter((item) => item.available).map((item) => ({ id: item.capability_id, name: capName(item.capability_id), description: capabilities[item.capability_id]?.description || '', configured: true, business: false }));
  return [...ordinary, ...Object.entries(businessAccess.names).map(([id, name]) => ({ id, name, description: businessAccess.descriptions[id], business: true, configured: model.businessCatalog?.find((item) => item.operation === id)?.configured === true }))];
}
function serviceRows() {
  const platformWithoutOrganization = reviewer() && !model.session.organization_id;
  return serviceItems().map((item) => `<div class="service-row"><div><h3>${esc(item.name)}</h3><p>${esc(item.description)}</p></div><span class="badge ${item.configured ? 'info' : ''}">${item.business ? (platformWithoutOrganization ? '开通前核对企业连接' : item.configured ? '已配置连接' : '待配置连接') : platformWithoutOrganization ? '支持接入' : '可申请'}</span></div>`).join('');
}
function dashboardGuide(platform) {
  if (platform) return panel('平台开通的四个步骤', '', '<div class="panel-body"><ol class="guide-list"><li><span class="step-number">1</span><div><h3>创建企业准入</h3><p>建立企业接入记录，不同时创建应用或凭证。</p></div></li><li><span class="step-number">2</span><div><h3>邀请企业负责人</h3><p>由指定邮箱完成验证并确认加入。</p></div></li><li><span class="step-number">3</span><div><h3>审核服务申请</h3><p>核对企业身份、应用用途和申请范围。</p></div></li><li><span class="step-number">4</span><div><h3>核对连接并开通</h3><p>按企业检查源服务连接，再开通已批准的授权。</p></div></li></ol></div>');
  return panel('接入的四个步骤', '', '<div class="panel-body"><ol class="guide-list"><li><span class="step-number">1</span><div><h3>创建应用</h3><p>明确负责人、用途与环境。</p></div></li><li><span class="step-number">2</span><div><h3>申请服务</h3><p>按需选择权限，提交审核。</p></div></li><li><span class="step-number">3</span><div><h3>开通与签发</h3><p>授权生效后，由应用负责人保存 Key。</p></div></li><li><span class="step-number">4</span><div><h3>验证调用</h3><p>实际调用成功后，再安排业务接入。</p></div></li></ol></div>');
}
function dashboard() {
  const businessState = businessAccess.overview();
  const s = { ...model.state, requests: [...model.state.requests, ...businessState.requests.map((item) => ({ ...item, is_business: true }))], grants: [...model.state.grants, ...businessState.grants] }; const pending = s.requests.filter((value) => ['submitted', 'in_review', 'needs_input'].includes(value.state));
  const available = serviceItems().length;
  const platform = reviewer() && !model.session.organization_id;
  const tasks = [];
  if (!s.current_organization && !reviewer()) tasks.push(['users', '加入企业，开始协作', '接受与你登录邮箱匹配的企业邀请。', '查看邀请', 'members']);
  else if (platform) {
    if (pending.length) tasks.push(['file', `${pending.length} 份申请等待处理`, '核对用途、所需服务和企业身份，再给出审核结论。', '开始审核', 'requests']);
    if (s.grants.some((value) => value.state === 'provisioning')) tasks.push(['shield', '有授权等待开通', '审核已经通过，平台运维还需完成企业连接核对。', '查看授权', 'grants']);
    if (!tasks.length) tasks.push(model.session.identity.platform_role === 'operator' ? ['users', '完善企业准入', '核对企业资料和负责人邀请，完成后由企业成员提交服务申请。', '进入企业准入', 'organizations'] : ['file', '等待企业提交申请', '企业负责人创建应用并提交服务申请后，审核任务会出现在这里。', '查看申请', 'requests']);
  }
  else {
    if (developer() && !s.applications.length) tasks.push(['code', '先创建一个应用', '为你的网站、内部系统或 Agent 建立独立接入身份。', '创建应用', 'app-new']);
    if (s.requests.some((value) => value.state === 'needs_input')) tasks.push(['file', '补充申请资料', '查看审核意见，完善后重新提交。', '查看申请', 'requests']);
    if (s.grants.some((value) => value.state === 'provisioning')) tasks.push(['shield', '有授权等待开通', '审核已经通过，平台运维还需完成接入状态核对。', '查看授权', 'grants']);
    if (effectiveGrants().length) tasks.push(['key', '完成应用接入验证', '保存凭证后，验证一次真实 API 调用。', '查看指引', 'guide']);
    if (!tasks.length) tasks.push(['grid', '从服务目录开始', '查看当前可用能力，按应用的实际需要申请。', '浏览服务', 'catalog']);
  }
  const emptyRequest = platform ? empty('暂无待处理申请', '企业成员提交服务申请后，平台审核任务会显示在这里。', '') : empty('还没有 API 申请', '创建应用后，选择需要的服务并提交用途说明。', '');
  return head(reviewer() ? '审核与开通工作台' : '今天，从这里开始', reviewer() ? '集中处理企业准入、应用申请与服务开通。' : '找到下一步需要处理的事，业务和接入进度都在这里。', developer() ? link('创建应用', 'app-new', true, 'plus') : '') + `<div class="summary-line"><span><strong>${s.applications.length}</strong>个应用</span><span><strong>${pending.length}</strong>份进行中的申请</span><span><strong>${s.grants.filter((v) => v.state === 'active').length}</strong>项已生效授权</span><span><strong>${available}</strong>${platform ? '项业务服务' : '项可申请能力'}</span></div><div class="home-grid"><div>${panel('接下来要做', '按当前身份与真实记录安排', `<div class="task-list">${tasks.map(([glyph, title, description, action, page]) => `<div class="task-row"><span class="task-icon">${icon(glyph)}</span><div class="task-copy"><h3>${esc(title)}</h3><p>${esc(description)}</p></div>${link(action, page)}</div>`).join('')}</div>`)}${panel('最近的申请', '申请、授权和调用状态分别核对', s.requests.length ? table(['应用 / 用途', '申请状态', ''], s.requests.slice(-4).reverse().map((value) => `<tr><td><span class="cell-title">${esc(appName(value.application_id))}</span><span class="cell-detail">${esc(value.justification)}</span></td><td>${badge(value.state)}</td><td>${textLink('查看', `${value.is_business ? 'business-request' : 'request'}/${value.request_id}`)}</td></tr>`)) : emptyRequest)}</div><div>${panel('当前服务', platform ? '连接与授权按企业分别核对' : '连接配置、授权与实际调用分别核对', `<div class="service-list">${serviceRows()}</div>`, platform ? '' : textLink('全部', 'catalog'))}${dashboardGuide(platform)}</div></div>`;
}
function applicationsPage() {
  const items = model.state.applications;
  return head('我的应用', '每个系统或 Agent 使用独立应用，权限和凭证各自管理。', developer() ? link('创建应用', 'app-new', true, 'plus') : '') + `<section class="panel">${items.length ? table(['应用', '环境', '负责人', '服务授权', ''], items.map((value) => `<tr><td><span class="cell-title">${esc(value.name)}</span><span class="cell-detail">${esc(value.purpose)}</span></td><td>${badge(value.environment)}</td><td>${esc(name(value.owner_user_id))}</td><td>${value.status === 'suspended' ? badge('suspended') : `${effectiveGrants(value.application_id).length + businessAccess.overview().grants.filter((grant) => grant.application_id === value.application_id && grant.state === 'active').length} 项已生效`}</td><td>${textLink('管理应用', `app/${value.application_id}`)}</td></tr>`)) : empty('为第一个系统创建应用', '例如内部报价系统、企业网站或物流 Agent。审核通过并开通后，这个应用才可以签发凭证。', developer() ? link('创建应用', 'app-new', true, 'plus') : '', 'code')}</section>`;
}
function applicationForm() {
  return head('创建应用', '先明确应用用途，再申请需要的服务权限。') + `<div class="form-layout"><form class="panel form-panel" data-form="application"><div class="panel-body">${formError}<section class="form-section"><h2>应用信息</h2><p>这些信息会随 API 申请提交给平台审核。</p><div class="field-grid">${field('应用名称', 'name', input('name', 'required maxlength="80" placeholder="例如：企业物流助手"'), '', true)}${field('使用环境', 'environment', '<select id="environment" name="environment"><option value="test">测试环境</option><option value="production">正式环境</option></select>', '环境标签不会自动授予正式服务权限。')}${field('应用负责人', 'owner_user_id', `<select id="owner_user_id" name="owner_user_id">${model.state.memberships.filter((v) => v.status === 'active' && v.role !== 'viewer' && v.organization_id === model.session.organization_id).map((v) => `<option value="${esc(v.user_id)}" ${v.user_id === model.session.identity.user_id ? 'selected' : ''}>${esc(name(v.user_id))}</option>`).join('')}</select>`, '负责人负责凭证保管与接入。')}${field('应用用途', 'purpose', '<textarea id="purpose" name="purpose" required maxlength="1000" placeholder="说明谁会使用、解决什么业务问题，以及准备如何连接服务。"></textarea>', '', true)}</div></section>${actions('创建应用', 'applications')}</div></form><aside class="side-help"><h3>什么时候需要新应用？</h3><p>不同业务系统、独立 Agent 或需要分别停用的接入，应创建不同应用。</p><p>创建后先申请服务。审批人员无法替你查看或领取完整 Key。</p></aside></div>`;
}
function applicationPage(id) {
  const application = model.state.applications.find((item) => item.application_id === id);
  if (!application) return empty('找不到该应用', '它可能不属于当前企业，或你已失去访问权限。', link('返回应用', 'applications'));
  const requests = model.state.requests.filter((item) => item.application_id === id);
  const grants = effectiveGrants(id);
  const businessGrants = businessAccess.overview().grants.filter((item) => item.application_id === id && item.state === 'active');
  const allRequests = [...requests, ...businessAccess.overview().requests.filter((item) => item.application_id === id)].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  const grantCount = grants.length + businessGrants.length;
  const credentialState = model.credentials.get(id);
  const credentialBody = !canCredential(application) ? note('完整凭证仅由应用负责人管理。需要转交时，请由企业管理员更新负责人。') : !credentialState ? '<p class="muted">正在读取凭证状态…</p>' : credentialState.error ? note(errorMessage(credentialState.error), 'warning') : credentialState.credentials.length ? table(['凭证', '状态', '有效期', '操作'], credentialState.credentials.map((value) => `<tr><td><span class="cell-title">${esc(value.label)}</span><span class="cell-detail"><code>${esc(value.prefix || value.key_prefix || '••••')}…${esc(value.secret_last_four || '')}</code></span></td><td>${badge(value.effective_status || value.status)}${value.delivery_state ? `<span class="cell-detail">${esc(labels[value.delivery_state] || value.delivery_state)}</span>` : ''}</td><td>${esc(date(value.expires_at))}</td><td><div class="cell-actions">${!['revoked', 'expired'].includes(value.status) ? `${value.allowed_actions?.includes('rotate') ? `<button class="text-button" data-action="rotate" data-app="${esc(id)}" data-id="${esc(value.credential_id)}">轮换</button>` : ''}<button class="text-button" data-action="revoke-key" data-app="${esc(id)}" data-id="${esc(value.credential_id)}">撤销</button>` : '—'}</div></td></tr>`)) : empty('尚未签发凭证', grants.length ? '授权已经生效，应用负责人可以创建凭证并保存完整 Key。' : '先提交 API 申请，等待审核和服务开通。', grants.length ? link('创建凭证', `credential-new/${id}`, true) : link('申请 API', `request-new/${id}`, true), 'key');
  return `<button class="back-link" data-go="applications">${icon('back')}返回应用</button>` + head(application.name, application.purpose, developer() ? link('申请业务 API', `business-request-new/${id}`, true, 'plus') : '') + `<div class="status-chain"><div class="status-step"><small>应用环境</small><strong>${badge(application.environment)}</strong></div><div class="status-step"><small>申请审核</small><strong>${allRequests.length ? badge(allRequests.at(-1).state) : '尚未申请'}</strong></div><div class="status-step"><small>服务授权</small><strong>${grantCount ? `${grantCount} 项已生效` : '尚未生效'}</strong></div><div class="status-step"><small>实际调用</small><strong>请通过接入验证确认</strong></div></div><div class="home-grid"><div>${panel('基础服务凭证', 'Key 仅在签发时显示，列表只保留脱敏信息', `<div class="${credentialState?.credentials?.length ? '' : 'panel-body'}">${credentialBody}</div>`, grants.length && canCredential(application) ? link('创建凭证', `credential-new/${id}`) : '')}${businessAccess.applicationSection(id)}${panel('基础服务申请记录', '', requests.length ? table(['所需服务', '状态', ''], requests.map((v) => `<tr><td>${capPills(v.requested_capabilities)}</td><td>${badge(v.state)}</td><td>${textLink('查看', `request/${v.request_id}`)}</td></tr>`)) : empty('还没有申请', '选择应用需要的服务，提交用途说明。'))}</div><div>${panel('应用信息', '', `<div class="panel-body"><dl class="detail-list"><dt>负责人</dt><dd>${esc(name(application.owner_user_id))}</dd><dt>应用状态</dt><dd>${badge(application.status)}</dd><dt>创建时间</dt><dd>${esc(date(application.created_at))}</dd><dt>客户端标识</dt><dd><code>${esc(application.client_id)}</code></dd></dl></div>`)}${panel('已授权服务', '', `<div class="panel-body">${grantCount ? grants.map((v) => capPills(v.capabilities)).join('') + businessGrants.map((grant) => `<div class="pill-list">${grant.operations.map((op) => `<span class="badge info">${esc(businessAccess.names[op])}</span>`).join('')}</div>`).join('') : '<p class="muted">等待申请通过并开通。</p>'}</div>`, textLink('查看授权', 'grants'))}${manager() ? panel('应用管理', '', `<form class="panel-body" data-form="application-status" data-id="${esc(id)}">${formError}${field('应用负责人', 'application_owner', `<select id="application_owner" name="application_owner">${model.state.memberships.filter((v) => v.organization_id === model.session.organization_id && v.status === 'active' && v.role !== 'viewer').map((v) => `<option value="${esc(v.user_id)}" ${application.owner_user_id === v.user_id ? 'selected' : ''}>${esc(name(v.user_id))}</option>`).join('')}</select>`, '只有当前负责人可以操作该应用的完整凭证。')}${field('应用状态', 'status', `<select id="status" name="status"><option value="active" ${application.status === 'active' ? 'selected' : ''}>启用</option><option value="suspended" ${application.status === 'suspended' ? 'selected' : ''}>停用</option></select>`, '停用后，凭证兑换与调用将被阻止。')}${actions('保存状态')}</form>`) : ''}</div></div>`;
}
function capabilityChoices(selected = [], availableOnly = true, scope) {
  const items = model.state.catalog.filter((item) => (!availableOnly || item.available) && (!scope || scope.includes(item.capability_id)));
  return `<div class="choice-list">${items.map((item) => `<label class="choice-row"><input type="checkbox" name="capabilities" value="${esc(item.capability_id)}" ${selected.includes(item.capability_id) ? 'checked' : ''} ${!item.available ? 'disabled' : ''}><span class="choice-copy"><strong>${esc(capName(item.capability_id))}</strong><small>${esc(capabilities[item.capability_id]?.description || '')}</small></span></label>`).join('')}</div>`;
}
function requestForm(applicationId, draft) {
  const apps = model.state.applications.filter((value) => value.status === 'active' && (manager() || value.owner_user_id === model.session.identity.user_id));
  if (!apps.length) return head('申请 API', '先为你的系统创建一个应用。') + `<section class="panel">${empty('需要先有一个应用', '权限和凭证属于应用，不直接分配给个人账号。', link('创建应用', 'app-new', true), 'code')}</section>`;
  return head(draft ? '补充申请资料' : '申请 API 服务', draft ? '根据审核意见修改资料，保存后重新提交。' : '按需选择能力。保存草稿后，你可以再核对并提交审核。') + `<div class="form-layout"><form class="panel" data-form="request" ${draft ? `data-id="${esc(draft.request_id)}"` : ''}><div class="panel-body">${formError}${draft?.review_reason ? note(`审核意见：${draft.review_reason}`, 'warning') : ''}<div class="form-section">${field('申请应用', 'application_id', `<select id="application_id" name="application_id" ${draft ? 'disabled' : ''}>${apps.map((value) => `<option value="${esc(value.application_id)}" ${value.application_id === (draft?.application_id || applicationId) ? 'selected' : ''}>${esc(value.name)} · ${esc(labels[value.environment])}</option>`).join('')}</select>`)}</div><section class="form-section"><h2>需要哪些服务？</h2><p>仅列出当前开放申请的能力。授权范围可以少于申请范围。</p>${capabilityChoices(draft?.requested_capabilities || [])}</section><div class="form-section">${field('使用说明', 'justification', `<textarea id="justification" name="justification" required maxlength="1000" placeholder="例如：用于内部录单流程，根据货物尺寸计算体积和计费重，每日约 100 次调用。">${esc(draft?.justification || '')}</textarea>`, '写清业务场景、使用对象与预计调用情况。')}</div>${actions(draft ? '保存修改' : '保存草稿', 'requests')}</div></form><aside class="side-help"><h3>提交后会发生什么？</h3><ol><li>平台核对用途与权限范围。</li><li>资料不足时，会附说明退回补充。</li><li>审核通过后，平台完成开通。</li><li>授权生效后，负责人领取凭证。</li></ol><p>询价与关税服务会在相应 API 对接验收后开放申请。</p></aside></div>`;
}
function requestsPage() {
  const items = model.state.requests.slice().reverse();
  return head(reviewer() ? 'API 申请审核' : 'API 申请', reviewer() ? '核对申请用途与服务范围，审核结论会记录到操作日志。' : '跟进申请进度、补充资料，并查看平台的审核意见。', developer() ? link('申请业务 API', 'business-request-new', true, 'plus') + link('申请基础工具', 'request-new') : '') + `<section class="panel">${items.length ? table(['应用 / 用途', '申请服务', '状态', '更新时间', ''], items.map((v) => `<tr><td><span class="cell-title">${esc(appName(v.application_id))}</span><span class="cell-detail">${esc(v.justification)}</span></td><td>${capPills(v.requested_capabilities)}</td><td>${badge(v.state)}</td><td class="numeric">${esc(date(v.updated_at))}</td><td>${textLink(reviewer() ? '处理申请' : '查看详情', `request/${v.request_id}`)}</td></tr>`)) : empty('暂无基础工具申请', reviewer() ? '企业成员提交申请后，会出现在这里。' : '为你的应用申请所需服务，审核意见和开通进度都可以在这里查看。', developer() ? link('新建申请', 'request-new', true) : '')}</section>`;
}
function requestDetail(id) {
  const value = model.state.requests.find((v) => v.request_id === id);
  if (!value) return empty('没有找到这份申请', '请核对当前企业与访问权限。', link('返回申请', 'requests'));
  if (route().page === 'request-edit') return requestForm(value.application_id, value);
  const editable = !reviewer() && ['draft', 'needs_input'].includes(value.state) && developer();
  const grant = model.state.grants.find((v) => v.request_id === id);
  const reviewForm = reviewer() && ['submitted', 'in_review'].includes(value.state) ? panel('处理审核', '只批准业务需要的能力；开通与签发凭证分别执行', `<form class="panel-body" data-form="decision" data-id="${esc(id)}">${formError}${field('审核结论', 'decision', '<select id="decision" name="decision"><option value="approve">通过</option><option value="needs_input">退回补充</option><option value="reject">拒绝</option></select>')}<section class="form-section"><h3>批准的服务范围</h3>${capabilityChoices(value.requested_capabilities, true, value.requested_capabilities)}</section><div class="form-section">${field('审核说明', 'reason', '<textarea id="reason" name="reason" required maxlength="1000" placeholder="说明通过依据，或明确列出需要补充的内容。"></textarea>')}</div>${actions('提交审核结论')}</form>`) : '';
  return `<button class="back-link" data-go="requests">${icon('back')}返回申请列表</button>` + head(`${appName(value.application_id)} 的 API 申请`, `由 ${name(value.applicant_user_id)} 提交 · 更新于 ${date(value.updated_at)}`, badge(value.state)) + `${value.review_reason ? note(`审核意见：${value.review_reason}`, value.state === 'approved' ? 'success' : 'warning') : ''}<div class="form-layout"><div>${panel('申请详情', '', `<div class="panel-body"><dl class="detail-list"><dt>申请应用</dt><dd>${esc(appName(value.application_id))}</dd><dt>服务范围</dt><dd>${capPills(value.requested_capabilities)}</dd><dt>使用说明</dt><dd>${esc(value.justification)}</dd><dt>申请状态</dt><dd>${badge(value.state)}</dd><dt>授权状态</dt><dd>${grant ? badge(grant.state) : '尚未生成授权'}</dd></dl>${editable ? `<div class="form-actions">${link('编辑内容', `request-edit/${id}`)}<button class="button primary" data-action="submit-request" data-id="${esc(id)}">${value.state === 'needs_input' ? '重新提交审核' : '提交审核'}</button></div>` : ''}${!reviewer() && developer() && ['submitted', 'in_review'].includes(value.state) ? `<div class="form-actions"><button class="button" data-action="withdraw-request" data-id="${esc(id)}">撤回申请</button></div>` : ''}</div>`)}${reviewForm}</div><aside class="side-help"><h3>状态说明</h3><p>审核通过后先生成待开通授权。只有授权实际生效，应用才可以创建相应范围的 Key。</p><p>撤销或暂停授权会影响后续凭证兑换和服务调用。</p></aside></div>`;
}
function grantsPage() {
  const items = model.state.grants;
  return head('服务授权', '查看批准范围与有效期。停用、撤销或缩小范围会影响应用调用。') + `<section class="panel">${items.length ? table(['应用 / 服务', '授权状态', '有效期', '操作'], items.map((v) => `<tr><td><span class="cell-title">${esc(appName(v.application_id))}</span><span class="cell-detail">${capPills(v.capabilities)}</span></td><td>${badge(v.state)}</td><td>${v.expires_at ? esc(date(v.expires_at)) : '未设置截止时间'}</td><td><div class="cell-actions">${model.session.identity.platform_role === 'operator' && v.state === 'provisioning' ? `<button class="text-button" data-action="provision" data-id="${esc(v.grant_id)}">核对并开通</button>` : ''}${(model.session.identity.platform_role === 'operator' || manager()) && ['active', 'suspended'].includes(v.state) ? `${textLink('管理授权', `grant-edit/${v.grant_id}`)}` : ''}${textLink('查看申请', `request/${v.request_id}`)}</div></td></tr>`)) : empty('暂无服务授权', 'API 申请通过后，这里会出现批准的范围与开通进度。', link('查看申请', 'requests'), 'shield')}</section>`;
}
function grantForm(id) {
  const value = model.state.grants.find((v) => v.grant_id === id);
  if (!value) return empty('找不到授权', '请回到列表核对当前记录。', link('返回授权', 'grants'));
  return head('管理服务授权', `${appName(value.application_id)} · ${labels[value.state]}`) + `<div class="form-layout"><div>${model.session.identity.platform_role === 'operator' ? panel('调整授权', '已移除的能力需要重新申请才能增加', `<form class="panel-body" data-form="grant-scope" data-id="${esc(id)}">${formError}${capabilityChoices(value.capabilities, true, value.capabilities)}<div class="form-section">${field('新的到期时间', 'expires_at', input('expires_at', 'type="datetime-local"'), '留空保留原到期时间，只允许缩短。')}</div>${actions('保存授权范围')}</form>`) : panel('当前授权范围', '企业管理员可以暂停或撤销，范围调整由平台运维处理', `<div class="panel-body">${capPills(value.capabilities)}</div>`)}${panel('停止服务授权', '下一次凭证兑换和调用将重新核对授权', `<div class="panel-body"><div class="head-actions">${value.state === 'active' ? `<button class="button" data-action="suspend-grant" data-id="${esc(id)}">暂停授权</button>` : ''}<button class="button danger" data-action="revoke-grant" data-id="${esc(id)}">撤销授权</button></div></div>`)}</div><aside class="side-help"><h3>操作会立即影响接入</h3><p>范围缩减后，即使尚有未过期 Token，被移除的能力也不能继续调用。</p><p>撤销后需重新申请。请先与应用负责人确认业务安排。</p></aside></div>`;
}
function membersPage() {
  const members = model.state.memberships.filter((value) => value.organization_id === model.session.organization_id);
  const invites = [...new Map([...model.state.invitations, ...(model.directory?.invitations || [])].map((item) => [item.invitation_id, item])).values()];
  return head('成员与邀请', '成员权限决定能做哪些事；应用权限决定系统能调用哪些服务。', manager() ? link('邀请成员', 'member-new', true, 'plus') : '') + panel('企业成员', '日常分为业务用户与管理员，已有专项权限单独保留', members.length ? table(['成员', '企业角色', '状态', '操作'], members.map((v) => `<tr><td><span class="cell-title">${esc(name(v.user_id))}</span>${v.user_id === model.session.identity.user_id ? '<span class="cell-detail">当前登录账号</span>' : ''}</td><td>${esc(labels[v.role])}</td><td>${badge(v.status)}</td><td>${manager() && v.user_id !== model.session.identity.user_id ? `<button class="text-button" data-go="member-edit/${esc(v.user_id)}">管理成员</button>` : '—'}</td></tr>`)) : empty('尚未加入企业', '接受下面与你已验证邮箱匹配的邀请后，即可进入企业工作区。')) + panel('企业邀请', '邀请只可由对应的已验证邮箱接受', invites.length ? table(['邀请邮箱', '角色', '状态', '有效期', '操作'], invites.map((v) => `<tr><td>${esc(v.email)}<span class="cell-detail">${esc(model.directory?.organizations.find((item) => item.organization_id === v.organization_id)?.display_name || '')}</span></td><td>${esc(labels[v.role])}</td><td>${badge(v.status)}</td><td>${esc(date(v.expires_at))}</td><td>${v.status === 'pending' ? (v.email.toLowerCase() === model.session.identity.email.toLowerCase() ? `<button class="text-button" data-action="accept-invite" data-id="${esc(v.invitation_id)}">接受邀请</button>` : manager() ? `<button class="text-button" data-action="revoke-invite" data-id="${esc(v.invitation_id)}">撤回邀请</button>` : '—') : '—'}</td></tr>`)) : empty('没有待处理的邀请', manager() ? '通过邮箱邀请同事，选择与其工作职责相符的角色。' : '收到邀请后可在这里接受。'));
}
function memberForm(id) {
  const member = id ? model.state.memberships.find((v) => v.user_id === id && v.organization_id === model.session.organization_id) : null;
  return head(member ? '管理企业成员' : '邀请成员', member ? name(member.user_id) : '邀请将绑定指定邮箱，由本人登录并确认加入。') + `<div class="form-layout"><form class="panel" data-form="${member ? 'member' : 'invitation'}" ${member ? `data-id="${esc(id)}"` : ''}><div class="panel-body">${formError}<div class="field-grid">${!member ? field('成员邮箱', 'email', input('email', 'type="email" required maxlength="254" placeholder="colleague@company.com"'), '', true) : ''}${field('企业角色', 'role', `<select id="role" name="role">${['viewer', 'admin', ...(member?.role === 'developer' ? ['developer'] : []), ...(member?.role === 'owner' ? ['owner'] : [])].map((role) => `<option value="${role}" ${member?.role === role ? 'selected' : ''}>${labels[role]}</option>`).join('')}</select>`)}${member ? field('成员状态', 'status', `<select id="status" name="status"><option value="active" ${member.status === 'active' ? 'selected' : ''}>启用</option><option value="suspended" ${member.status === 'suspended' ? 'selected' : ''}>停用</option></select>`) : field('邀请有效期', 'days', '<select id="days" name="days"><option value="7">7 天</option><option value="3">3 天</option><option value="1">1 天</option></select>')}</div>${actions(member ? '保存成员权限' : '创建邀请', 'members')}</div></form><aside class="side-help"><h3>如何选择角色？</h3><p>业务用户使用已开通的服务；管理员负责本企业的成员和业务管理。已有接口权限与企业负责人身份单独保留。</p><p>系统会保护最后一名有效所有者。停用应用负责人前，需要先转交应用。</p><p>${model.session?.mode === 'fixtures' ? '本地验收不发送邮件，受邀账号登录后可直接看到对应邀请。' : '同事完成邮箱验证后，用受邀邮箱登录，即可在这里确认加入企业。'}</p></aside></div>`;
}
function credentialForm(id) {
  const grants = effectiveGrants(id); const tools = [...new Set(grants.flatMap((v) => v.capabilities))];
  if (!tools.length) return empty('尚无可签发的服务权限', '请等待服务授权生效。', link('查看授权', 'grants'), 'key');
  return head('创建应用凭证', `${appName(id)} · 只选择本次接入需要的服务。`) + `<div class="form-layout"><form class="panel" data-form="credential" data-id="${esc(id)}"><div class="panel-body">${formError}<div class="field-grid">${field('凭证名称', 'label', input('label', 'required maxlength="80" placeholder="例如：开发联调"'))}${field('有效期', 'expires_in_seconds', '<select id="expires_in_seconds" name="expires_in_seconds"><option value="86400">1 天</option><option value="604800">7 天</option><option value="2592000">30 天</option></select>')}</div><section class="form-section"><h2>凭证权限</h2><p>范围不得超过应用已生效的授权。</p>${capabilityChoices(tools, true, tools)}</section>${actions('创建并显示 Key', `app/${id}`)}</div></form><aside class="side-help"><h3>准备好保存凭证</h3><p>完整 Key 只显示一次。保存至你的凭证管理工具后，再确认交付。</p><p>工作台不把 Key 保存到浏览器本地存储。关闭显示窗口后，不能从列表找回。</p></aside></div>`;
}
function guidePage() { return developerGuide.page(); }
function activityPage() {
  const items = model.state.operations.slice().reverse();
  const actionLabels = { 'application.create': '创建应用', 'application.update': '更新应用', 'member.invite': '邀请成员', 'invitation.claim': '接受邀请', 'membership.update': '更新成员', 'request.create': '创建申请', 'request.submit': '提交申请', 'request.decide': '审核申请', 'grant.activate': '开通授权', 'grant.state': '更新授权状态' };
  return head('操作记录', '记录成员、应用和授权变更。此处不代表业务调用日志。') + `<section class="panel">${items.length ? table(['时间', '操作人', '操作', '对象', '状态变化'], items.map((v) => `<tr><td class="numeric">${esc(date(v.created_at))}</td><td>${esc(name(v.actor_user_id))}</td><td>${esc(actionLabels[v.action] || v.action)}</td><td>${esc(v.object_type === 'application' ? appName(v.object_ref) : ({ request: 'API 申请', invitation: '企业邀请', grant: '服务授权', membership: '企业成员', organization: '企业' })[v.object_type] || v.object_type)}</td><td>${v.from_state ? `${esc(labels[v.from_state] || v.from_state)} → ` : ''}${esc(labels[v.to_state] || v.to_state || '已记录')}</td></tr>`)) : empty('暂无操作记录', '创建应用、提交申请或变更成员后，可在这里查看记录。', '', 'clock')}</section>`;
}
function organizationsPage() {
  if (!model.admissions && !model.admissionsLoading) {
    model.admissionsLoading = true;
    request('/organizations').then((result) => { model.admissions = result.data; }).catch((error) => { model.admissions = { error }; }).finally(() => { model.admissionsLoading = false; if (route().page.startsWith('organization')) render(); });
  }
  const items = model.admissions;
  return head('企业准入', '先建立企业接入，再由指定邮箱的所有者确认加入。', link('创建企业', 'organization-new', true, 'plus')) + `<section class="panel">${!items ? '<div class="panel-body"><p class="muted">正在读取企业准入状态…</p></div>' : items.error ? note(errorMessage(items.error), 'warning') : items.length ? table(['企业', '接入状态', '所有者', '操作'], items.map((item) => `<tr><td><span class="cell-title">${esc(item.display_name)}</span>${item.reconciliation_required ? '<span class="cell-detail">接入与工作台状态需要核对</span>' : ''}</td><td>${badge(item.organization_status)}<span class="cell-detail">${item.tenant_status === 'enabled' ? '接入系统已启用' : item.tenant_status === 'suspended' ? '接入系统已暂停' : '尚未确认接入'}</span></td><td><span class="badge ${item.owner_status === 'owner_active' ? 'success' : 'warning'}">${item.owner_status === 'owner_active' ? '所有者已加入' : item.owner_status === 'owner_pending' ? '等待所有者确认' : '缺少有效所有者'}</span>${item.owner_invitation?.email_masked ? `<span class="cell-detail">${esc(item.owner_invitation.email_masked)}</span>` : ''}</td><td>${textLink('管理企业', `organization/${item.organization_id}`)}</td></tr>`)) : empty('暂无企业准入记录', '创建企业并邀请第一位所有者，不会同时创建应用或 Key。', link('创建企业', 'organization-new', true), 'users')}</section>`;
}
function organizationForm(id) {
  const existing = id && Array.isArray(model.admissions) ? model.admissions.find((item) => item.organization_id === id) : null;
  if (id && !existing) return organizationsPage();
  return head(existing ? '管理企业接入' : '创建企业', existing ? existing.display_name : '企业所有者需要使用指定邮箱登录并接受邀请。') + `<div class="form-layout"><form class="panel" data-form="organization" ${id ? `data-id="${esc(id)}"` : ''}><div class="panel-body">${formError}<div class="field-grid">${existing ? `${field('企业状态', 'status', `<select id="status" name="status"><option value="active" ${existing.organization_status === 'active' ? 'selected' : ''}>启用</option><option value="suspended" ${existing.organization_status === 'suspended' ? 'selected' : ''}>暂停</option></select>`, '暂停后，企业接入和工作台权限都将受到限制。', true)}${field('变更原因', 'reason', '<select id="reason" name="reason" required><option value="operational_pause">运营调整</option><option value="customer_request">企业主动申请</option><option value="security_review">接入安全复核</option><option value="resume_verified">复核完成，恢复接入</option></select>', '', true)}` : `${field('企业名称', 'display_name', input('display_name', 'required maxlength="100" placeholder="输入企业名称"'), '', true)}${field('首位所有者邮箱', 'owner_email', input('owner_email', 'required type="email" maxlength="254" placeholder="owner@company.com"'), '只有该已验证邮箱可以领取邀请。', true)}${field('邀请有效期', 'days', '<select id="days" name="days"><option value="7">7 天</option><option value="3">3 天</option><option value="1">1 天</option></select>', '', true)}`}</div>${actions(existing ? '保存企业状态' : '创建企业与邀请', 'organizations')}</div></form><aside class="side-help"><h3>开通和加入分别确认</h3><p>接入系统创建并读回后，企业记录才会显示。首位所有者接受邀请前保持“等待确认”。</p><p>这一步不签发 API Key。企业成员仍需创建应用、申请服务并完成开通。</p><p>恢复企业不会恢复已经撤销的授权。</p></aside></div>`;
}
async function loadCredentials(id) {
  if (model.credentials.has(id)) return;
  try { const result = await request(`/applications/${uri(id)}/credentials/status`); model.credentials.set(id, result.data); } catch (error) { model.credentials.set(id, { error }); }
  if (route().page === 'app' && route().id === id) render();
}
function render() {
  let { page, id } = route();
  if (page === 'business-admin') { window.history.replaceState(null,'','#'+legacyConfigurationRoute(id)); ({page,id}=route()); }
  const publicPages = page === 'market' && id === 'configure' ? PUBLIC_PAGES.filter(p=>p!=='market') : PUBLIC_PAGES;
  if (page === 'login' || (!model.session?.authenticated && (!publicPages.includes(page) || new URLSearchParams(location.search).has('auth_error')))) { renderLogin(); return; }
  ensureShell(); nav();
  if (model.session?.authenticated && !model.state && !publicPages.includes(page)) { document.querySelector('#content').innerHTML = '<p role="status">正在读取个人中心…</p>'; return; }
  if (page === 'account') page = reviewer() ? 'platform' : orgRole() === 'developer' ? 'api-keys' : model.session.organization_id ? 'workbench' : 'members';
  const main = document.querySelector('#content');
  if (reviewer() && !model.session.organization_id && ![...PUBLIC_PAGES, 'platform', 'requests', 'request', 'grants', 'grant-edit', 'organizations', 'organization-new', 'organization', 'business-request', 'business-grant', 'channels', 'cli-authorize', 'cases', 'operations', 'case'].includes(page)) { main.innerHTML = empty('请在平台工作区处理任务', '企业应用和成员页面面向企业成员。当前身份使用申请审核与服务开通入口。', link('返回工作概览', 'home')); return; }
  const pages = { configure: () => nativeAdmin.page(id), channels: () => channels.page(id), 'cli-authorize': () => cliAuthorization.page(id), cases: () => cases.page(), operations: () => cases.page(true), case: () => cases.detail(id), apply: () => serviceAccess.page(id || undefined), 'api-keys': () => apiKeys.page(id), home: () => serviceHome(), platform: () => reviewer() ? dashboard() : serviceHome(), cli: () => cli.page(), market: () => id === 'configure' && !manager() ? empty('需要企业管理权限', '请使用当前企业的负责人或管理员账号配置模块。', link('返回服务市场','market')) : market.page(), catalog: () => market.page(), service: () => market.detail(id), workbench: () => workspaceHome.page(), guide: () => manual.page(id || undefined), diagnostics: guidePage, tax: () => tax.page(), customs: () => business.customsPage(), quote: () => business.quotePage(id), 'quote-history': () => business.historyPage(), applications: applicationsPage, 'app-new': applicationForm, app: () => applicationPage(id), requests: () => requestsPage() + businessAccess.requestsPanel(), 'request-new': () => requestForm(id), request: () => requestDetail(id), 'request-edit': () => requestDetail(id), grants: () => grantsPage() + businessAccess.grantsPanel(), 'grant-edit': () => grantForm(id), members: membersPage, 'member-new': () => memberForm(), 'member-edit': () => memberForm(id), 'credential-new': () => credentialForm(id), 'business-request-new': () => businessAccess.form(id), 'business-request': () => businessAccess.requestPage(id), 'business-request-edit': () => businessAccess.requestPage(id, true), 'business-grant': () => businessAccess.grantPage(id), 'business-credential': () => businessAccess.credentialPage(id), 'customs-history': () => customsHistory.page(), calls: () => calls.page(), activity: activityPage, organizations: organizationsPage, 'organization-new': () => organizationForm(), organization: () => organizationForm(id) };
  const requiresOrganization = ['calls', 'customs-history', 'quote', 'quote-history'];
  main.innerHTML = (['customs', 'tax'].includes(page) ? quotaBanner() : '') + (requiresOrganization.includes(page) && !model.session.organization_id ? workspaceHome.page() : (pages[page] || serviceHome)());
  if (page === 'api-keys' && model.verification) main.insertAdjacentHTML('beforeend', verificationPanel());
  main.setAttribute('aria-busy', 'false');
  document.title = `${main.querySelector('h1')?.textContent || '工作台'} · FreightClaw`;
  if (page === 'app') { const application = model.state.applications.find((v) => v.application_id === id); if (application && canCredential(application)) void loadCredentials(id); }
}
function closeSecret() { model.secret = null; document.querySelector('#secret-value').textContent = ''; document.querySelector('#secret-error').textContent = ''; if (dialog.open) dialog.close(); }
function verificationPanel() {
  if (model.verification.running) return panel('连接验证', '', '<div class="panel-body" role="status">API Key 已确认保存，正在验证只读样例…</div>');
  return panel('本次连接验证', '仅保存状态和请求编号，不保留 Key、Token 或业务资料', `<div class="panel-body">${model.verification.checks.map((check) => `${note(`${capName(check.operation)}：${check.summary}`, check.status === 'success' ? 'success' : 'warning')}${check.request_id ? `<p class="muted">请求编号 <code>${esc(check.request_id)}</code></p>` : ''}`).join('')}</div>`);
}
async function acknowledgeSecret() {
  const saved = model.secret; if (!saved) return;
  if (saved.kind === 'business' || saved.kind === 'unified') await mutate(`/business-access/credentials/${uri(saved.credentialId)}/acknowledge`, 'POST', { expected_version: saved.version });
  else await mutate(`/applications/${uri(saved.applicationId)}/credentials/${uri(saved.credentialId)}/acknowledge`, 'POST', {});
  closeSecret();
  if (saved.kind !== 'unified') {
    saved.key = '';
    await refresh(); go(`app/${saved.applicationId}`); render(); return;
  }
  model.verificationAbort?.abort();
  const controller = new AbortController(); model.verificationAbort = controller;
  const checkState = { running: true, checks: [] }; model.verification = checkState;
  try {
    await refresh(); go(saved.kind === 'unified' ? 'api-keys' : `app/${saved.applicationId}`); render();
    const credential = businessAccess.overview().credentials.find((value) => value.credential_id === saved.credentialId);
    const tools = effectiveGrants(saved.applicationId).flatMap((value) => value.capabilities);
    const businessNames = credential?.operations || [];
    const ranges = saved.kind === 'unified' ? [...(credential?.t0_mode === 'current_grant' && tools.length ? [tools] : []), ...(businessNames.length ? [businessNames] : [])] : [saved.kind === 'business' ? businessNames : tools];
    checkState.checks = await Promise.all((ranges.length ? ranges : [[]]).map((allowedNames) => verifyCredentialAfterDelivery({ kind: saved.kind, key: saved.key, allowedNames, mode: model.session.mode, signal: controller.signal })));
    if (!controller.signal.aborted && model.verification === checkState) await refresh();
  } finally {
    saved.key = ''; checkState.running = false;
    if (model.verificationAbort === controller) model.verificationAbort = null;
    if (model.verification === checkState && route().page === 'api-keys') render();
  }
}
function showSecret(result, applicationId, kind = 't0') {
  const data = result.data; const key = data?.api_key || data?.credential_once?.api_key || data?.secret?.api_key;
  const credentialId = data?.credential?.credential_id || data?.credential_id;
  if (!key || !credentialId) { notify('这次签发的完整 Key 无法再次领取。请在凭证列表撤销该凭证，再创建新的 Key。', true); return; }
  model.secret = { key, credentialId, applicationId, kind, version: data?.credential?.version }; document.querySelector('#secret-value').textContent = key; dialog.showModal();
}
async function runAction(button) {
  if (await loginForm.action(button)) return;
  if (workspaceHome.action(button)) return;
  if (await nativeAdmin.action(button)) return;
  if (await channels.action(button)) return;
  if (await cliAuthorization.action(button)) return;
  if (await cases.action(button)) return;
  if (await cli.action(button)) return;
  if (await market.action(button)) return;
  if (await apiKeys.action(button)) return;
  if (await serviceAccess.action(button)) return;
  if (await businessAccess.action(button)) return;
  if (await customsHistory.action(button)) return;
  if (await tax.action(button)) return;
  if (await calls.action(button)) return;
  if (await business.action(button)) return;
  const action = button.dataset.action; const id = button.dataset.id; const applicationId = button.dataset.app;
  if (action === 'menu') { closeAccount(); const open = !document.querySelector('#sidebar').classList.contains('open'); if (!open) closeMenu(); else { document.querySelector('#sidebar').classList.add('open'); button.setAttribute('aria-expanded', 'true'); document.querySelector('#content').inert = true; document.querySelector('#sidebar .nav-item')?.focus(); } return; }
  if (action === 'close-secret') { closeSecret(); return; }
  if (action === 'copy-secret') { if (model.secret) { await navigator.clipboard.writeText(model.secret.key); notify('Key 已复制，请妥善保存。'); } return; }
  if (action === 'login') { model.session = await mutate('/fixture-login', 'POST', { identity_id: id }); await refresh(); go(consumeLoginDestination(loginStorage()) || 'home'); render(); return; }
  if (action === 'logout') { model.sessionGeneration = (model.sessionGeneration || 0) + 1; consumeLoginDestination(loginStorage()); closeSecret(); model.verificationAbort?.abort(); model.verification = null; channels.reset(); nativeAdmin.reset(); workspaceHome.reset(); cases.reset(); business.reset(); tax.reset(); customsHistory.reset(); calls.reset(); developerGuide.reset(); businessAccess.reset(); serviceAccess.reset(); model.credentials.clear(); model.state = null; model.session = await mutate('/logout', 'POST', {}); model.requestKeys.clear(); model.directory = null; model.businessCatalog = []; go('home'); render(); return; }
  if (action === 'ack-secret') { await acknowledgeSecret(); return; }
  const currentRequest = model.state?.requests.find((v) => v.request_id === id);
  const currentGrant = model.state?.grants.find((v) => v.grant_id === id);
  if (action === 'submit-request' || action === 'withdraw-request') { await mutate(`/requests/${uri(id)}/${action === 'submit-request' ? 'submit' : 'withdraw'}`, 'POST', { expected_version: currentRequest.version }); }
  else if (action === 'accept-invite' || action === 'revoke-invite') { await mutate(`/invitations/${uri(id)}/${action === 'accept-invite' ? 'accept' : 'revoke'}`, 'POST', {}); }
  else if (action === 'provision') { await mutate(`/grants/${uri(id)}/provision`, 'POST', { expected_version: currentGrant.version }); }
  else if (action === 'suspend-grant' || action === 'revoke-grant') {
    if (!confirm(action === 'suspend-grant' ? '暂停后，应用将不能继续使用这项授权。确认暂停？' : '撤销后需重新申请，应用将不能继续使用这项授权。确认撤销？')) return;
    await mutate(`/grants/${uri(id)}/status`, 'POST', { expected_version: currentGrant.version, state: action === 'suspend-grant' ? 'suspended' : 'revoked' });
  } else if (action === 'revoke-key') { if (!confirm('撤销后这枚 Key 将无法继续使用。确认撤销？')) return; await mutate(`/applications/${uri(applicationId)}/credentials/${uri(id)}/revoke`, 'POST', {}); }
  else if (action === 'rotate') {
    const credential = model.credentials.get(applicationId)?.credentials.find((v) => v.credential_id === id);
    const tools = credential?.tool_names; if (!tools?.length) throw Object.assign(new Error('credential_not_found'), { code: 'credential_not_found' });
    if (!confirm('创建替代凭证并开始轮换？请准备好保存新 Key。')) return;
    const value = await mutate(`/applications/${uri(applicationId)}/credentials/${uri(id)}/rotate`, 'POST', { tool_names: tools, expires_in_seconds: 86400 }); showSecret(value, applicationId);
  } else return;
  await refresh(); render(); notify('操作已完成，已读取最新状态。');
}
async function submitForm(form) {
  if (await loginForm.submit(form)) return;
  if (await nativeAdmin.submit(form)) return;
  if (await channels.submit(form)) return;
  if (await cases.submit(form)) return;
  if (await apiKeys.submit(form)) return;
  if (await serviceAccess.submit(form)) return;
  if (await businessAccess.submit(form)) return;
  if (await developerGuide.submit(form)) return;
  if (await customsHistory.submit(form)) return;
  if (await tax.submit(form)) return;
  if (await calls.submit(form)) return;
  if (await business.submit(form)) return;
  const type = form.dataset.form; const id = form.dataset.id; const data = new FormData(form); const get = (key) => String(data.get(key) || '').trim(); const selected = data.getAll('capabilities').map(String);
  let next;
  if (type === 'application') { const result = await mutate('/applications', 'POST', { name: get('name'), purpose: get('purpose'), environment: get('environment'), owner_user_id: get('owner_user_id') }); next = `app/${result.data.application_id}`; }
  else if (type === 'request') { if (!selected.length) throw Object.assign(new Error('body_invalid'), { code: 'body_invalid' }); const previous = model.state.requests.find((v) => v.request_id === id); const payload = { capabilities: selected, justification: get('justification'), ...(previous ? { expected_version: previous.version } : { application_id: get('application_id') }) }; const result = await mutate(previous ? `/requests/${uri(id)}` : '/requests', previous ? 'PATCH' : 'POST', payload); next = `request/${result.data.request_id}`; }
  else if (type === 'decision') { const decision = get('decision'); if (decision === 'approve' && !selected.length) throw Object.assign(new Error('body_invalid'), { code: 'body_invalid' }); await mutate(`/requests/${uri(id)}/decision`, 'POST', { expected_version: model.state.requests.find((v) => v.request_id === id).version, decision, reason: get('reason'), ...(decision === 'approve' ? { approved_capabilities: selected } : {}) }); next = `request/${id}`; }
  else if (type === 'invitation') { await mutate('/invitations', 'POST', { email: get('email'), role: get('role'), expires_at: new Date(Date.now() + Number(get('days')) * 86400000).toISOString() }); next = 'members'; }
  else if (type === 'organization') { if (id) { const previous = model.admissions.find((item) => item.organization_id === id); await mutate(`/organizations/${uri(id)}/status`, 'PATCH', { expected_status: previous.organization_status, status: get('status'), reason: get('reason') }); } else await mutate('/organizations', 'POST', { display_name: get('display_name'), owner_email: get('owner_email'), owner_invitation_expires_at: new Date(Date.now() + Number(get('days')) * 86400000).toISOString() }); next = 'organizations'; }
  else if (type === 'member') { await mutate(`/memberships/${uri(id)}/status`, 'PATCH', { role: get('role'), status: get('status') }); next = 'members'; }
  else if (type === 'application-status') { await mutate(`/applications/${uri(id)}`, 'PATCH', { expected_version: model.state.applications.find((v) => v.application_id === id).version, status: get('status'), ...(get('application_owner') ? { owner_user_id: get('application_owner') } : {}) }); next = `app/${id}`; }
  else if (type === 'grant-scope') { if (!selected.length) throw Object.assign(new Error('body_invalid'), { code: 'body_invalid' }); await mutate(`/grants/${uri(id)}/scope`, 'PATCH', { expected_version: model.state.grants.find((v) => v.grant_id === id).version, capabilities: selected, ...(get('expires_at') ? { expires_at: new Date(get('expires_at')).toISOString() } : {}) }); next = 'grants'; }
  else if (type === 'credential') { if (!selected.length) throw Object.assign(new Error('body_invalid'), { code: 'body_invalid' }); const result = await mutate(`/applications/${uri(id)}/credentials`, 'POST', { label: get('label'), tool_names: selected, expires_in_seconds: Number(get('expires_in_seconds')) }); await refresh(); go(`app/${id}`); render(); showSecret(result, id); return; }
  else return;
  await refresh(); go(next); render(); notify('已保存，页面已读取最新记录。');
}
const loginForm = createLoginForm({ api: request, esc, formError, authenticated: async session => { model.session = session; await refresh(); go(consumeLoginDestination(loginStorage()) || (reviewer() ? 'operations' : 'cases')); render(); } });
const workspaceHome = createWorkspaceHome({api:request,model:()=>model,head,esc,icon,rerender:render});
const nativeAdmin = createNativeAdminUi({ canConfigure: manager,api:request,mutate,esc,head,note,icon,formError,model:()=>model,rerender:render});
const channels = createChannelsUi({api:request,mutate,esc,head,note,icon,formError,model:()=>model,rerender:render});
const cliAuthorization = createCliAuthorizationUi({api:request,esc,head,note,model:()=>model,rerender:render});
const cases = createCasesUi({ api: request, mutate, head, panel, empty, note, esc, date, icon, formError, rerender: render, model: () => model });
const calls = createCallLogUi({ api: request, head, panel, note, esc, date, capName, formError, rerender: render, model: () => model });
const business = createBusinessWorkspace({ api: request, mutate, head, panel, note, field, input, actions, formError, esc, icon, rerender: render });
const tax = createTaxWorkspace({ esc, head, panel, field, input, actions, formError, note, icon, api: request, rerender: render });
const customsHistory = createCustomsHistoryUi({ api: request, esc, head, panel, note, date, formError, rerender: render, restore: (operation, input) => { if (operation === 'customs.query') business.restoreHistory(input); else tax.restoreHistory(input); go(operation === 'customs.query' ? 'customs' : 'tax'); } });
const developerGuide = createDeveloperGuide({ esc, head, panel, field, input, actions, formError, note, link, mode: () => model.session?.mode, rerender: render });
const businessAccess = createBusinessAccessUi({ esc, head, panel, field, input, actions, formError, note, table, badge, link, textLink, empty, date, developer, manager, canCredential, api: request, mutate, refresh, go, notify, showSecret, rerender: render, model: () => model });
const market = createCapabilityMarket({ canConfigure: manager, configurationStatus: kind=>nativeAdmin.configurationStatus(kind), esc, icon, head, panel, note, empty, link, notify, rerender: render, model: () => model });
const manual = createOperationManual({ esc, icon, link });
const cli = createCliGuide({ esc, icon, link, notify });
const serviceHome = createServiceHome({ icon, link });
const apiKeys = createApiKeysUi({ esc, icon, head, panel, table, note, empty, link, badge, date, canCredential, effectiveGrants, request, mutate, refresh, go, notify, showSecret, render, businessAccess, model: () => model });
const serviceAccess = createServiceAccessUi({ esc, icon, head, panel, table, note, empty, link, badge, date, canCredential, effectiveGrants, request, mutate, refresh, go, notify, render, businessAccess, model: () => model });
document.addEventListener('click', async (event) => {
  if (!event.target.closest('.account-disclosure')) closeAccount();
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.action === 'account-menu') { const menu = document.querySelector('#account-menu'); const open = menu.hidden; closeMenu(); menu.hidden = !open; button.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button')?.focus(); return; }
  if (button.dataset.go) { go(button.dataset.go); return; }
  if (!button.dataset.action) return;
  clearNotice(); const previous = button.innerHTML; button.disabled = true;
  try { await runAction(button); } catch (error) {
    if (dialog.open) document.querySelector('#secret-error').innerHTML = note(errorMessage(error), 'error');
    else notify(errorMessage(error), true);
  } finally { button.disabled = false; if (button.dataset.action !== 'captcha-refresh') button.innerHTML = previous; }
});
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]'); if (!form) return; event.preventDefault();
  if (form.dataset.busy === 'true') return;
  clearNotice(); form.dataset.busy = 'true'; const button = form.querySelector('button[type=submit]'); button.disabled = true; const previous = button.textContent; button.textContent = '处理中…';
  const alert = form.querySelector('.form-error'); alert.hidden = true;
  try { await submitForm(form); } catch (error) { alert.innerHTML = note(errorMessage(error), 'error'); alert.hidden = false; alert.setAttribute('tabindex', '-1'); alert.focus(); }
  finally { form.dataset.busy = 'false'; button.disabled = form.dataset.form === 'password-login' && !form.dataset.captchaId; button.textContent = previous; }
});
document.addEventListener('change', async (event) => {
  if (await nativeAdmin.change(event)) return;
  if (serviceAccess.change(event)) return;
  if (developerGuide.change(event)) return;
  if (cli.change(event)) return;
  if (event.target.id !== 'organization') return;
  try { model.sessionGeneration = (model.sessionGeneration || 0) + 1; model.session = await mutate('/session/organization', 'POST', { organization_id: event.target.value || null }); closeSecret(); channels.reset(); nativeAdmin.reset(); workspaceHome.reset(); cases.reset(); business.reset(); tax.reset(); customsHistory.reset(); calls.reset(); developerGuide.reset(); businessAccess.reset(); serviceAccess.reset(); model.verificationAbort?.abort(); model.verification = null; await refresh(); go('home'); render(); } catch (error) { notify(errorMessage(error), true); render(); }
});
document.addEventListener('input', (event) => { if (nativeAdmin.input(event)) return; if (market.input(event)) return; if (event.target.closest('form[data-form^="business-"]')) { document.querySelectorAll('[data-save-preview]').forEach((button) => { button.disabled = true; }); document.querySelectorAll('[data-result-state]').forEach((element) => { element.textContent = '资料已修改，请重新查询后使用结果。'; }); } });
dialog.addEventListener('cancel', () => closeSecret());
dialog.addEventListener('close', () => closeSecret());
window.addEventListener('hashchange', () => { clearNotice(); closeMenu(); closeAccount(); render(); document.querySelector('#content')?.focus(); window.scrollTo({ top: 0 }); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('#account-menu')?.hidden === false) { event.preventDefault(); closeAccount(true); return; }
  if (!document.querySelector('#sidebar')?.classList.contains('open')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
  if (event.key === 'Tab') {
    const nodes = [document.querySelector('[data-action=menu]'), ...document.querySelectorAll('#sidebar button, #sidebar a')].filter((v) => v && v.getClientRects().length);
    const index = nodes.indexOf(document.activeElement); const next = event.shiftKey ? (index <= 0 ? nodes.length - 1 : index - 1) : (index + 1) % nodes.length;
    event.preventDefault(); nodes[next]?.focus();
  }
});
render();
try {
  await ensureSession();
  if (model.session.authenticated) { await refresh(); const destination = consumeLoginDestination(loginStorage()); if (destination && ['home', 'login'].includes(route().page)) go(destination); }
  try { model.publicQuota = (await request('/public/customs/quota')).data; } catch { model.publicQuota = null; }
  render();
} catch (error) {
  if (PUBLIC_PAGES.includes(route().page)) render();
  else { ensureShell(); document.querySelector('#content').innerHTML = empty('个人中心暂时无法读取', errorMessage(error), '<button class="button primary" data-action="reload">重新加载</button>'); }
}
document.addEventListener('click', (event) => { if (event.target.closest('[data-action=reload]')) location.reload(); });
document.addEventListener('focusin', (event) => { if (!event.target.closest('.account-disclosure')) closeAccount(); });

// Native validation can focus a field inside a collapsed batch item.
document.addEventListener('invalid', (event) => { const section = event.target.closest('details'); if (section) section.open = true; }, true);

window.addEventListener('beforeunload', event => { if (nativeAdmin.isDirty()) { event.preventDefault(); event.returnValue = ''; } });
