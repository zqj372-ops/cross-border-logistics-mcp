import { marketServices } from './market.js';

const pendingStates = new Set(['draft', 'submitted', 'in_review', 'needs_input']);
const identifier = (value) => typeof value === 'string' ? value : '';
const values = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
const same = (left, right) => [...left].sort().join('\0') === [...right].sort().join('\0');
const live = (grant) => grant?.state === 'active' && (!grant.expires_at || Date.parse(grant.expires_at) > Date.now());
const safeCode = (error) => typeof error?.code === 'string' && /^[a-z][a-z0-9_]{2,80}$/u.test(error.code) ? error.code : 'portal_unavailable';
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export function createServiceAccessUi(ui) {
  const { esc, head, panel, table, note, empty, link, badge, date } = ui;
  let retryPlan = null; let lastResult = null; let selectedApplicationId = null;
  const model = () => ui.model();
  const business = () => ui.businessAccess?.overview?.() || { requests: [], grants: [] };
  const applications = () => model().state?.applications || [];
  const accessRole = () => {
    const current = model(); const userId = current.session?.identity?.user_id; const organizationId = current.session?.organization_id;
    return (current.state?.memberships || []).find((value) => value.user_id === userId && value.organization_id === organizationId && value.status === 'active')?.role || null;
  };
  const canManageAccess = () => ['owner', 'admin', 'developer'].includes(accessRole());
  const denied = () => head('服务申请', '当前账号用于日常业务操作。') + empty('当前账号无需提交服务申请', '可直接使用业务工作台；如需新增服务，请联系企业管理员或开发成员。', link('打开业务工作台', 'workbench', true));
  const ownerApps = () => applications().filter((value) => value.status === 'active' && ui.canCredential(value));
  const allT0Grants = (id) => (model().state?.grants || []).filter((grant) => grant.application_id === id);
  const allApiGrants = (id) => (business().grants || []).filter((grant) => grant.application_id === id);
  const t0Grants = (id) => allT0Grants(id).filter(live);
  const apiGrants = (id) => allApiGrants(id).filter(live);
  const t0Requests = () => model().state?.requests || [];
  const apiRequests = () => business().requests || [];
  const availableServices = () => marketServices.filter((service) => service.protocol !== 'mcp' || !Array.isArray(model().state?.catalog) || model().state.catalog.some((item) => item.capability_id === service.id && item.available));
  const requestScopes = (kind, request) => values(kind === 't0' ? request.requested_capabilities : request.operations);
  const requestId = (request) => identifier(request.request_id);
  const requestsFor = (kind) => kind === 't0' ? t0Requests() : apiRequests();
  const active = (serviceId, appId) => t0Grants(appId).some((grant) => values(grant.capabilities).includes(serviceId)) || apiGrants(appId).some((grant) => values(grant.operations).includes(serviceId));
  const grantsFor = (serviceId, appId, kind) => (kind === 't0' ? allT0Grants(appId) : allApiGrants(appId))
    .filter((grant) => values(kind === 't0' ? grant.capabilities : grant.operations).includes(serviceId));
  const requestIsPending = (kind, request, serviceId, appId) => {
    if (pendingStates.has(request.state)) return true;
    if (request.state !== 'approved') return false;
    const grants = grantsFor(serviceId, appId, kind).filter((grant) => grant.request_id === request.request_id);
    return grants.length === 0 || grants.some((grant) => grant.state === 'provisioning');
  };
  const pending = (serviceId, appId) => [...t0Requests().map((request) => ({ kind: 't0', request })), ...apiRequests().map((request) => ({ kind: 'business', request }))]
    .filter(({ kind, request }) => request.application_id === appId && requestScopes(kind, request).includes(serviceId) && requestIsPending(kind, request, serviceId, appId))
    .sort((left, right) => Date.parse(right.request.updated_at || right.request.created_at || '') - Date.parse(left.request.updated_at || left.request.created_at || ''))[0] || null;
  const previousGrant = (serviceId, appId) => {
    const kind = marketServices.find((service) => service.id === serviceId)?.protocol === 'mcp' ? 't0' : 'business';
    return grantsFor(serviceId, appId, kind).filter((grant) => !live(grant)).sort((left, right) => Date.parse(right.updated_at || right.created_at || '') - Date.parse(left.updated_at || left.created_at || ''))[0] || null;
  };
  const previousState = (grant) => grant.state === 'active' ? 'expired' : grant.state;
  const availability = (serviceId, appId) => active(serviceId, appId) ? { disabled: true, label: '已开通' } : pending(serviceId, appId) ? { disabled: true, label: pending(serviceId, appId).request.state === 'draft' ? '已有草稿' : '申请处理中' } : { disabled: false, label: '' };
  const organizationName = () => {
    const state = model().state || {}; const orgId = model().session?.organization_id;
    return identifier(state.current_organization?.display_name) || identifier((state.organizations || []).find((item) => item.organization_id === orgId)?.display_name) || '企业';
  };
  const detailLink = (kind, request) => link('查看申请', `${kind === 't0' ? 'request' : 'business-request'}/${requestId(request)}`);

  function resultNotice() {
    if (!lastResult) return '';
    if (lastResult.complete) return note('服务申请已提交，平台会分别审核权限并完成实际开通。', 'success');
    const completed = lastResult.completed.length ? `已提交：${lastResult.completed.join('、')}。` : '';
    const failed = lastResult.failed.length ? `尚未确认：${lastResult.failed.join('、')}。` : '';
    return note(`部分申请尚未确认。${completed}${failed}可使用同一操作继续重试，已经创建的申请不会重复创建。`, 'warning') + '<div class="form-actions"><button class="button primary" type="button" data-action="service-access-retry">重试未完成部分</button></div>';
  }

  function overviewPage() {
    if (!model().session?.organization_id) return head('服务申请', '加入企业后才能申请服务。') + empty('先加入企业', '使用企业邀请对应的邮箱登录并接受邀请。', link('查看企业邀请', 'members', true));
    if (!canManageAccess()) return denied();
    if (business().unavailable) return head('服务申请', '当前无法完整读取服务授权。') + note('业务授权状态暂时不可用。为避免重复申请或扩大权限，请稍后重试。', 'warning');
    const rows = [];
    for (const service of marketServices) {
      for (const application of applications()) {
        if (active(service.id, application.application_id)) rows.push(`<tr><td><span class="cell-title">${esc(service.name)}</span><span class="cell-detail">${esc(application.name)}</span></td><td>${badge('active')}<span class="cell-detail">已开通</span></td><td>服务权限在每次调用时继续核对</td><td>—</td></tr>`);
        else {
          const current = pending(service.id, application.application_id);
          if (current) rows.push(`<tr><td><span class="cell-title">${esc(service.name)}</span><span class="cell-detail">${esc(application.name)}</span></td><td>${badge(current.request.state)}</td><td>${esc(date(current.request.updated_at || current.request.created_at || ''))}</td><td>${detailLink(current.kind, current.request)}</td></tr>`);
          else {
            const previous = previousGrant(service.id, application.application_id);
            if (previous) rows.push(`<tr><td><span class="cell-title">${esc(service.name)}</span><span class="cell-detail">${esc(application.name)}</span></td><td>${badge(previousState(previous))}</td><td>原授权已${esc(previousState(previous) === 'expired' ? '过期' : previousState(previous) === 'suspended' ? '暂停' : '撤销')}，可以按当前用途重新申请</td><td>—</td></tr>`);
          }
        }
      }
    }
    const content = rows.length ? table(['服务 / 应用', '当前状态', '状态说明 / 更新时间', ''], rows) : empty('还没有服务申请', '选择需要的物流能力并说明用途，一次提交即可进入审核。', link('申请服务', 'apply/new', true));
    return head('服务申请', '在一处查看已开通服务和待审核申请。', rows.length ? link('申请服务', 'apply/new', true) : '') + resultNotice() + panel('服务与申请状态', '这里显示权限状态，不代表业务调用记录。', content);
  }

  function formPage(requestedService) {
    if (!model().session?.organization_id) return overviewPage();
    if (!canManageAccess()) return denied();
    if (business().unavailable) return head('申请服务', '当前无法完整读取服务授权。') + note('业务授权状态暂时不可用，暂不提交新的申请。请稍后重试。', 'warning') + link('返回服务申请', 'apply');
    const apps = ownerApps(); const defaultApp = apps.some((value) => value.application_id === selectedApplicationId) ? selectedApplicationId : apps[0]?.application_id || null;
    selectedApplicationId = defaultApp;
    const selectedService = marketServices.some((service) => service.id === requestedService) ? requestedService : null;
    const appControl = apps.length > 1 ? `<div class="field"><label for="service-access-application">接入应用</label><select id="service-access-application" name="application_id">${apps.map((value) => `<option value="${esc(value.application_id)}" ${value.application_id === defaultApp ? 'selected' : ''}>${esc(value.name)}</option>`).join('')}</select><small>服务只授予所选应用。</small></div>` : apps.length === 1 ? `<input type="hidden" name="application_id" value="${esc(apps[0].application_id)}"><p class="muted">接入应用：${esc(apps[0].name)}</p>` : note(`提交后将自动创建“${organizationName()}系统接入”，无需先填写应用资料。`);
    const choices = availableServices().map((service) => {
      const state = defaultApp ? availability(service.id, defaultApp) : { disabled: false, label: '' }; const checked = !state.disabled && selectedService === service.id;
      return `<label class="choice-row${state.disabled ? ' disabled' : ''}"><input type="checkbox" name="services" value="${esc(service.id)}" ${checked ? 'checked' : ''} ${state.disabled ? 'disabled' : ''}><span class="choice-copy"><strong>${esc(service.name)}<span class="service-access-state">${state.label ? `<span class="badge${state.label === '已开通' ? ' info' : ''}">${esc(state.label)}</span>` : ''}</span></strong><small>${esc(service.description)}</small></span></label>`;
    }).join('');
    return head('申请服务', '选择需要的能力并说明用途，只需提交一次。') + `<form class="panel" data-form="service-access"><div class="panel-body"><div class="form-error" role="alert" hidden></div>${appControl}<section class="form-section"><h2>选择服务</h2><div class="choice-list">${choices}</div></section><div class="field full"><label for="service-access-purpose">使用说明</label><textarea id="service-access-purpose" name="justification" required maxlength="1000" placeholder="例如：用于内部录单和报关准备，每日约 100 次调用。"></textarea><small>说明使用对象、业务场景与预计调用情况。</small></div><div class="form-actions">${link('取消', 'apply')}<button class="button primary" type="submit">提交服务申请</button></div></div></form>`;
  }

  function findRequest(kind, appId, scopes, purpose, states) {
    return requestsFor(kind).find((request) => request.application_id === appId && states.includes(request.state) && identifier(request.justification).trim() === purpose && same(requestScopes(kind, request), scopes));
  }

  async function runGroup(plan, kind) {
    const group = plan.groups[kind]; if (!group.services.length || group.done) return;
    const alreadySubmitted = findRequest(kind, plan.applicationId, group.services, plan.purpose, ['submitted', 'in_review', 'approved']);
    if (alreadySubmitted) { group.done = true; group.error = null; return; }
    if (!group.requestId) {
      const draft = findRequest(kind, plan.applicationId, group.services, plan.purpose, ['draft']);
      if (draft) { group.requestId = requestId(draft); group.version = Number(draft.version); }
      else {
        const created = await ui.mutate(kind === 't0' ? '/requests' : '/business-access/requests', 'POST', { application_id: plan.applicationId, [kind === 't0' ? 'capabilities' : 'operations']: group.services, justification: plan.purpose });
        group.requestId = identifier(created.data?.request_id); group.version = Number(created.data?.version);
        if (!group.requestId || !Number.isSafeInteger(group.version)) fail('portal_unavailable');
      }
    }
    await ui.mutate(`${kind === 't0' ? '/requests' : '/business-access/requests'}/${encodeURIComponent(group.requestId)}/submit`, 'POST', { expected_version: group.version });
    group.done = true; group.error = null;
  }

  async function execute(plan) {
    for (const kind of ['t0', 'business']) {
      try { await runGroup(plan, kind); } catch (error) { plan.groups[kind].error = safeCode(error); }
    }
    try { await ui.refresh(); } catch { /* Mutations retain their own readback and idempotency state. */ }
    const completed = []; const failed = [];
    for (const kind of ['t0', 'business']) {
      const group = plan.groups[kind]; if (!group.services.length) continue;
      (group.done ? completed : failed).push(kind === 't0' ? '基础工具' : '业务服务');
    }
    const complete = failed.length === 0; lastResult = { complete, completed, failed }; retryPlan = complete ? null : plan;
    ui.go('apply'); ui.render(); ui.notify(complete ? '服务申请已提交，等待审核与开通。' : '部分申请尚未确认，请按页面提示重试。', !complete);
  }

  async function submit(formElement) {
    if (formElement.dataset.form !== 'service-access') return false;
    if (!canManageAccess()) fail('organization_role_required');
    if (business().unavailable) fail('business_access_unavailable');
    const data = new FormData(formElement); const purpose = identifier(data.get('justification')).trim();
    const selected = [...new Set(data.getAll('services').map(identifier))].filter((id) => availableServices().some((service) => service.id === id));
    if (!purpose || !selected.length || !model().session?.organization_id) fail('body_invalid');
    let applicationId = identifier(data.get('application_id')); const apps = ownerApps();
    if (applicationId && !apps.some((value) => value.application_id === applicationId)) fail('application_access_denied');
    if (!applicationId) {
      if (apps.length === 1) applicationId = apps[0].application_id;
      else if (apps.length > 1) fail('body_invalid');
      else {
        const created = await ui.mutate('/applications', 'POST', { name: `${organizationName()}系统接入`, purpose: '统一物流服务接入', environment: 'production', owner_user_id: model().session.identity.user_id });
        applicationId = identifier(created.data?.application_id); if (!applicationId) fail('portal_unavailable');
      }
    }
    if (selected.some((id) => active(id, applicationId) || pending(id, applicationId))) fail('request_state_invalid');
    const plan = { applicationId, purpose, groups: {
      t0: { services: selected.filter((id) => marketServices.find((service) => service.id === id)?.protocol === 'mcp'), requestId: null, version: null, done: false, error: null },
      business: { services: selected.filter((id) => marketServices.find((service) => service.id === id)?.protocol !== 'mcp'), requestId: null, version: null, done: false, error: null },
    } };
    retryPlan = plan; await execute(plan); return true;
  }

  async function action(button) {
    if (button.dataset.action !== 'service-access-retry') return false;
    if (!canManageAccess()) fail('organization_role_required');
    if (!retryPlan) return true;
    await execute(retryPlan); return true;
  }

  function change(event) {
    const target = event.target;
    if (!canManageAccess()) return false;
    if (target?.id !== 'service-access-application' || !ownerApps().some((value) => value.application_id === target.value)) return false;
    selectedApplicationId = target.value;
    const form = target.form || target.closest?.('form');
    for (const input of form?.querySelectorAll?.('input[name="services"]') || []) {
      const state = availability(input.value, selectedApplicationId); input.disabled = state.disabled;
      if (state.disabled) input.checked = false;
      const row = input.closest?.('.choice-row'); row?.classList?.toggle('disabled', state.disabled);
      const status = row?.querySelector?.('.service-access-state'); if (status) status.textContent = state.label;
    }
    return true;
  }

  function reset() { retryPlan = null; lastResult = null; selectedApplicationId = null; }

  function page(target) { return target === undefined ? overviewPage() : formPage(target === 'new' ? null : target); }
  return { page, submit, action, change, reset };
}
