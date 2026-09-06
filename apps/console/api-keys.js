const serviceNames = Object.freeze({
  'cargo.calculate': '货物计算',
  'container.plan_summary': '装柜计划',
  'system.agent_context.get': 'Agent 接入信息',
  'customs.query': '关税与归类',
  'customs.tax.estimate': '税费估算',
  'quote.zone_preview': '加拿大尾程询价',
  'quote.ai_extract_preview': '询价资料提取',
  'quote.freightcom_ltl.preview': 'Freightcom LTL 询价',
});

const identifier = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
const field = (value, snake, camel) => value?.[snake] ?? value?.[camel];
const uri = (value) => encodeURIComponent(identifier(value));
const live = (value) => value?.state === 'active' && (!value.expires_at || Date.parse(value.expires_at) > Date.now());
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export function createApiKeysUi(ui) {
  const { esc, head, panel, table, note, empty, link, badge, date } = ui;
  const overview = () => ui.businessAccess?.overview?.() || { grants: [], credentials: [] };
  const applications = () => ui.model().state?.applications || [];
  const accessRole = () => {
    const current = ui.model(); const userId = current.session?.identity?.user_id; const organizationId = current.session?.organization_id;
    return (current.state?.memberships || []).find((value) => value.user_id === userId && value.organization_id === organizationId && value.status === 'active')?.role || null;
  };
  const canManageAccess = () => ['owner', 'admin', 'developer'].includes(accessRole());
  const denied = () => head('系统接入', '当前账号用于日常业务操作。') + empty('无需管理 API Key', '可直接使用业务工作台；如需连接系统或 Agent，请联系企业管理员或开发成员。', link('打开业务工作台', 'workbench', true));
  const app = (id) => applications().find((value) => value.application_id === id);
  const appName = (id) => app(id)?.name || '应用';
  const t0Grants = (id) => (ui.effectiveGrants(id) || []).filter(live);
  const businessGrants = (id) => (overview().grants || []).filter((grant) => grant.application_id === id && live(grant));
  const t0Tools = (id) => [...new Set(t0Grants(id).flatMap((grant) => list(grant.capabilities)))];
  const businessOperations = (id) => [...new Set(businessGrants(id).flatMap((grant) => list(grant.operations)))];
  const allServices = (id) => [...t0Tools(id), ...businessOperations(id)];
  const manageableApps = () => applications().filter((value) => value.status === 'active' && ui.canCredential(value));
  const eligibleApps = () => manageableApps().filter((value) => allServices(value.application_id).length > 0);
  const credentials = () => overview().credentials || [];
  const credentialId = (value) => identifier(field(value, 'credential_id', 'credentialId'));
  const applicationId = (value) => identifier(field(value, 'application_id', 'applicationId'));
  const credentialVersion = (value) => Number(field(value, 'version', 'version'));
  const credentialOperations = (value) => list(field(value, 'operations', 'operations'));
  const t0Mode = (value) => field(value, 't0_mode', 't0Mode') === 'current_grant' ? 'current_grant' : 'none';
  const credentialStatus = (value) => identifier(field(value, 'status', 'status'), 'revoked');
  const deliveryStatus = (value) => identifier(field(value, 'delivery_status', 'deliveryStatus'), 'pending');
  const serviceUpdate = (value, appId) => {
    const currentOperations = businessOperations(appId); const previousOperations = credentialOperations(value);
    const targetT0Mode = t0Mode(value) === 'current_grant' && t0Tools(appId).length ? 'current_grant' : 'none';
    const changed = currentOperations.length !== previousOperations.length || currentOperations.some((operation) => !previousOperations.includes(operation));
    return { currentOperations, targetT0Mode, changed, hasService: currentOperations.length > 0 || targetT0Mode === 'current_grant' };
  };
  const labels = (values) => `<div class="pill-list">${values.map((value) => `<span class="badge info">${esc(serviceNames[value] || value)}</span>`).join('')}</div>`;

  function emptyState() {
    if (!manageableApps().length) return empty('先申请需要的服务', '服务开通后，应用负责人可以在这里创建一枚统一 API Key。', link('申请服务', 'apply', true));
    return empty('尚无已开通服务', '提交一次服务申请，审核和接通完成后即可创建统一 API Key。', link('申请服务', 'apply', true));
  }

  function listPage() {
    if (!canManageAccess()) return denied();
    if (overview().unavailable) return head('API Keys', '当前无法完整读取 Key 与业务授权。') + note('统一 API Key 状态暂时不可用。为避免误发、误轮换或重复申请，请稍后重试。', 'warning');
    const values = credentials();
    if (!values.length && !eligibleApps().length) return head('API Keys', '一枚 Key 使用该应用已开通的服务。') + emptyState();
    const body = values.length ? table(['名称 / 应用', '已启用服务', '状态', '最近使用', '操作'], values.map((value) => {
      const id = credentialId(value); const appId = applicationId(value); const owner = ui.canCredential(app(appId));
      const lastFour = identifier(field(value, 'secret_last_four', 'secretLastFour'));
      const createdAt = identifier(field(value, 'created_at', 'createdAt'));
      const lastUsedAt = field(value, 'last_used_at', 'lastUsedAt');
      const expiresAt = Number(field(value, 'expires_at', 'expiresAt'));
      const active = credentialStatus(value) === 'active' && (!Number.isFinite(expiresAt) || expiresAt * 1000 > Date.now());
      const enabled = [...(t0Mode(value) === 'current_grant' ? t0Tools(appId) : []), ...credentialOperations(value).filter((operation) => businessOperations(appId).includes(operation))];
      const canEnableT0 = owner && active && deliveryStatus(value) === 'acknowledged' && t0Mode(value) === 'none' && t0Tools(appId).length > 0;
      const update = serviceUpdate(value, appId); const canUpdateServices = owner && active && deliveryStatus(value) === 'acknowledged' && update.changed && update.hasService;
      const canRotate = allServices(appId).length > 0;
      const actions = owner && active ? `<div class="cell-actions">${canEnableT0 ? `<button class="text-button" data-action="api-key-enable-t0" data-id="${esc(id)}">启用基础工具</button>` : ''}${canUpdateServices ? `<button class="text-button" data-action="api-key-update-services" data-id="${esc(id)}">更新服务</button>` : ''}${canRotate ? `<button class="text-button" data-action="api-key-rotate" data-id="${esc(id)}">${deliveryStatus(value) === 'pending' ? '重新签发' : '轮换'}</button>` : ''}<button class="text-button" data-action="api-key-revoke" data-id="${esc(id)}">撤销</button></div>` : '—';
      return `<tr><td><span class="cell-title">${esc(identifier(field(value, 'label', 'label'), 'API Key'))}</span><span class="cell-detail">${esc(appName(appId))} · <code>flcbk_…${esc(lastFour)}</code></span><span class="cell-detail">创建于 ${esc(createdAt ? date(createdAt) : '—')}</span></td><td>${enabled.length ? labels(enabled) : '<span class="muted">当前无有效服务</span>'}</td><td>${badge(active ? deliveryStatus(value) === 'acknowledged' ? 'active' : 'pending' : credentialStatus(value) === 'revoked' ? 'revoked' : 'expired')}</td><td>${lastUsedAt ? esc(date(lastUsedAt)) : '尚无记录'}</td><td>${actions}</td></tr>`;
    })) : empty('还没有 API Key', '创建后完整 Key 只显示一次，请立即保存。');
    return head('API Keys', '统一管理应用调用关务、询价和基础工具使用的 Key。', eligibleApps().length ? link('创建 API Key', 'api-keys/new', true) : '') + panel('统一 API Key', '权限始终受当前应用和已生效授权约束', body);
  }

  function newPage() {
    if (!canManageAccess()) return denied();
    if (overview().unavailable) return head('创建 API Key', '当前无法完整读取授权。') + note('统一 API Key 与业务授权状态暂时不可用，暂不签发新 Key。请稍后重试。', 'warning') + link('返回 API Keys', 'api-keys');
    const apps = eligibleApps();
    if (!apps.length) return head('创建 API Key', '先开通至少一项服务。') + emptyState();
    const appControl = apps.length > 1 ? `<div class="field"><label for="api-key-application">应用</label><select id="api-key-application" name="application_id">${apps.map((value) => `<option value="${esc(value.application_id)}">${esc(value.name)}</option>`).join('')}</select><small>Key 只能用于所选应用。</small></div>` : `<input type="hidden" name="application_id" value="${esc(apps[0].application_id)}"><p class="muted">应用：${esc(apps[0].name)}</p>`;
    const scopeSummary = apps.map((value) => `<div class="scope-summary"><strong>${esc(value.name)}</strong>${labels(allServices(value.application_id))}</div>`).join('');
    return head('创建 API Key', '完整 Key 只显示一次，确认保存后可立即验证连接。') + panel('Key 信息', '提交时自动读取所选应用当前全部已开通服务', `<form class="panel-body" data-form="api-key-create"><div class="form-error" role="alert" hidden></div><div class="field-grid"><div class="field"><label for="api-key-label">名称</label><input id="api-key-label" name="label" required maxlength="80" autocomplete="off" placeholder="例如：生产 Agent"></div>${appControl}<div class="field"><label for="api-key-expiry">有效期</label><select id="api-key-expiry" name="expires_in_seconds"><option value="604800">7 天</option><option value="2592000" selected>30 天</option><option value="7776000">90 天</option><option value="31536000">1 年</option></select></div></div><section class="form-section"><h3>将启用的服务</h3>${scopeSummary}${note('权限变化会在后续换票和调用时重新检查；Key 本身不能扩大授权。')}</section><div class="form-actions">${link('取消', 'api-keys')}<button class="button primary" type="submit">创建并显示 API Key</button></div></form>`);
  }

  async function update() { await ui.refresh(); ui.render(); }

  async function action(button) {
    const actionName = button.dataset.action;
    if (!actionName?.startsWith('api-key-')) return false;
    if (!canManageAccess()) fail('organization_role_required');
    if (overview().unavailable) fail('business_access_unavailable');
    const value = credentials().find((item) => credentialId(item) === button.dataset.id);
    if (!value || !ui.canCredential(app(applicationId(value)))) fail('business_credential_conflict');
    const id = credentialId(value); const version = credentialVersion(value);
    if (actionName === 'api-key-enable-t0') {
      if (!t0Tools(applicationId(value)).length || t0Mode(value) !== 'none') fail('business_authorization_denied');
      await ui.mutate(`/business-access/credentials/${uri(id)}/t0-mode`, 'POST', { expected_version: version, mode: 'current_grant' });
      await update(); ui.notify('基础工具已启用，页面已读取当前权限。'); return true;
    }
    if (actionName === 'api-key-acknowledge') {
      await ui.mutate(`/business-access/credentials/${uri(id)}/acknowledge`, 'POST', { expected_version: version });
      await update(); ui.notify('API Key 已确认保存。'); return true;
    }
    if (actionName === 'api-key-revoke') {
      if (!confirm('撤销后，这枚 Key 和它签发的 Token 将不能继续调用。确认撤销？')) return true;
      await ui.mutate(`/business-access/credentials/${uri(id)}/revoke`, 'POST', { expected_version: version });
      await update(); ui.notify('API Key 已撤销。'); return true;
    }
    if (actionName === 'api-key-update-services') {
      const update = serviceUpdate(value, applicationId(value));
      if (deliveryStatus(value) !== 'acknowledged' || !update.changed || !update.hasService) fail('business_authorization_denied');
      if (!confirm('更新服务会按当前授权新增或移除服务，立即使旧 Key 失效，并生成需要重新保存的新 Key。确认继续？')) return true;
      const result = await ui.mutate(`/business-access/credentials/${uri(id)}/rotate`, 'POST', { expected_version: version, operations: update.currentOperations, t0_mode: update.targetT0Mode, expires_in_seconds: 2_592_000 });
      await ui.refresh(); ui.go('api-keys'); ui.render(); ui.showSecret(result, applicationId(value), 'unified'); return true;
    }
    if (actionName === 'api-key-rotate') {
      if (!confirm('轮换会立即撤销旧 Key，并生成只显示一次的新 Key。确认继续？')) return true;
      const result = await ui.mutate(`/business-access/credentials/${uri(id)}/rotate`, 'POST', { expected_version: version, operations: credentialOperations(value), t0_mode: t0Mode(value), expires_in_seconds: 2_592_000 });
      await ui.refresh(); ui.go('api-keys'); ui.render(); ui.showSecret(result, applicationId(value), 'unified'); return true;
    }
    return false;
  }

  async function submit(formElement) {
    if (formElement.dataset.form !== 'api-key-create') return false;
    if (!canManageAccess()) fail('organization_role_required');
    if (overview().unavailable) fail('business_access_unavailable');
    const data = new FormData(formElement); const get = (name) => identifier(data.get(name)).trim();
    const appId = get('application_id'); const target = eligibleApps().find((value) => value.application_id === appId);
    const label = get('label'); const expiry = Number(get('expires_in_seconds'));
    if (!target || !label || ![604800, 2592000, 7776000, 31536000].includes(expiry)) fail('business_body_invalid');
    const operations = businessOperations(appId); const mode = t0Tools(appId).length ? 'current_grant' : 'none';
    if (!operations.length && mode === 'none') fail('business_authorization_denied');
    const result = await ui.mutate(`/business-access/applications/${uri(appId)}/credentials`, 'POST', { label, operations, t0_mode: mode, expires_in_seconds: expiry });
    await ui.refresh(); ui.go('api-keys'); ui.render(); ui.showSecret(result, appId, 'unified'); return true;
  }

  function page(view) { return view === 'new' ? newPage() : listPage(); }
  return { page, action, submit };
}
