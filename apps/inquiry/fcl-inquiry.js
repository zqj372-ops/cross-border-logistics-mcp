import { fclLabel, fclValue, fclEventMessage } from '../inquiry/fcl-presentation.ts';
import {
  buildFclInquirySummary,
  createFclInquiryDraft,
  isFclInquiryComplete,
  validateFclInquiryForSubmit,
  validateFclInquiryStep,
} from './fcl-model.ts';
import { fclPublicOutputSchemas } from '../../services/access-gateway/portal/fcl-http-contracts.ts';

const API = '/inquiry/api/v1';
const containerTypes = ['20GP', '40GP', '40HQ', '45HQ'];
const containerLabels = { '20GP': '20GP', '40GP': '40GP', '40HQ': '40HQ', '45HQ': '45HQ' };
const containerDescriptions = { '20GP': '20 尺普柜', '40GP': '40 尺普柜', '40HQ': '40 尺高柜', '45HQ': '45 尺高柜' };
const cargoTypes = [
  ['general', '普通货物'],
  ['battery', '含电池'],
  ['liquid_powder', '液体或粉末'],
  ['wood', '木制品'],
  ['regulated', '受监管货物'],
  ['other', '其他'],
];
const incoterms = ['EXW', 'FOB', 'CIF', 'DDU', 'DDP', 'Other'];
const serviceIds = [
  ['pickup', '中国提货'],
  ['export_customs', '中国出口报关'],
  ['ocean_freight', '海运干线'],
  ['canada_customs', '加拿大清关'],
  ['devanning_storage', '拆柜与仓储'],
  ['delivery', '加拿大派送'],
];
const serviceLabel = (id) => serviceIds.find(([value]) => value === id)?.[1] || id;
const steps = ['运输需求', '货物与服务', '联系确认'];

const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const sameJson = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export function buildFclSupplementChanges(current, next) {
  const candidates = [
    ['origin_city', current.origin_city, next.origin_city],
    ['pol', current.pol, next.pol],
    ['pod', current.pod, next.pod],
    ['final_destination', current.final_destination, next.final_destination],
    ['containers', current.containers, next.containers],
    ['cargo_name', current.cargo_name, next.cargo_name],
    ['cargo_type', current.cargo_type, next.cargo_type],
    ['estimated_weight', current.estimated_weight, next.estimated_weight],
    ['cargo_ready_date', current.cargo_ready_date, next.cargo_ready_date],
    ['incoterm', current.incoterm, next.incoterm],
    ['incoterm_other', current.incoterm_other, next.incoterm_other],
    ['selected_services', current.selected_services, next.selected_services],
    ['contact.name', current.contact?.name, next.contact?.name],
    ['contact.company', current.contact?.company, next.contact?.company],
    ['contact.email', current.contact?.email, next.contact?.email],
    ['contact.phone', current.contact?.phone, next.contact?.phone],
    ['notes', current.notes, next.notes],
  ];
  return candidates.flatMap(([field, before, after]) => sameJson(before, after) ? [] : [{ field, value: after ?? null }]);
}

const reasonMessage = (code) => ({
  fcl_input_invalid: '请检查必填字段和格式，保留的输入未被清空。',
  fcl_rate_limited: '请求过于频繁，请稍后使用同一页面重试。',
  fcl_public_session_invalid: '本票访问状态已失效，请从之前保存的个人访问链接重新打开。',
  fcl_version_conflict: '本票资料已被更新，请刷新当前进度后重新提交。',
  fcl_supplement_stale: '当前确认依据已经变化，请刷新本票后重新提交。',
  fcl_not_found: '本票不存在、已到期，或当前访问状态无权查看。',
  fcl_ticket_mismatch: '当前浏览状态绑定的是另一张询价，请重新打开对应个人访问链接。',
  body_too_large: '提交内容超过传输上限，请缩减长文本后重试。',
}[code] || `操作未完成（${code || 'unavailable'}）。`);

function field(label, id, value, options = {}) {
  const type = options.type || 'text';
  const required = options.required ? ' required' : '';
  const placeholder = options.placeholder ? ` placeholder="${esc(options.placeholder)}"` : '';
  const error = options.error ? `<p id="${id}-error" class="field-error" role="alert">${esc(options.error)}</p>` : '';
  const aria = options.error ? ` aria-invalid="true" aria-describedby="${id}-error"` : '';
  if (options.options) return `<div class="field"><label for="${id}">${esc(label)}${options.optional ? '<span class="optional">选填</span>' : ''}</label><select id="${id}" name="${id}"${required}${aria}>${options.options.map(([optionValue, text]) => `<option value="${esc(optionValue)}"${String(optionValue) === String(value ?? '') ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>${error}</div>`;
  if (options.textarea) return `<div class="field"><label for="${id}">${esc(label)}${options.optional ? '<span class="optional">选填</span>' : ''}</label><textarea id="${id}" name="${id}" rows="${options.rows || 3}" maxlength="${options.maxlength || 4000}"${required}${aria}${placeholder}>${esc(value)}</textarea>${error}</div>`;
  return `<div class="field"><label for="${id}">${esc(label)}${options.optional ? '<span class="optional">选填</span>' : ''}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}"${required}${aria}${placeholder}${options.step ? ' step="0.000001"' : ''}${options.maxlength ? ` maxlength="${options.maxlength}"` : ''}>${error}</div>`;
}

function routeFields(draft, errors) {
  const containerError = Object.entries(errors).find(([path]) => path.startsWith('containers'))?.[1];
  return `<h2 id="fcl-step-title" tabindex="-1">${steps[0]}</h2><p class="section-intro">从哪里出发，运到哪里？填写已确认的信息，不确定的内容可以稍后补充。</p>
    <div class="field-grid">${field('中国起运城市', 'origin_city', draft.origin_city, { optional: true, error: errors.origin_city })}${field('起运港（POL）', 'pol', draft.pol, { error: errors.pol, placeholder: '例如 Yantian（盐田）' })}</div>
    <div class="field-grid">${field('目的港（POD）', 'pod', draft.pod, { error: errors.pod, placeholder: '例如 Vancouver（温哥华）' })}${field('最终目的地', 'final_destination', draft.final_destination, { optional: true, error: errors.final_destination })}</div>
    <fieldset class="fcl-container-grid"${containerError ? ' aria-invalid="true"' : ''}><legend>柜型与柜数</legend>${containerTypes.map(type => { const row = draft.containers.find(item => item.type === type); return `<div class="fcl-container-row"><label for="container-${type}">${containerLabels[type]}<small>${containerDescriptions[type]}</small></label><label class="check-small"><input type="checkbox" name="container-pending-${type}"${row && row.quantity === null ? ' checked' : ''}>数量待确认</label><input id="container-${type}" type="number" min="1" max="9999" step="1" inputmode="numeric" value="${row?.quantity ?? ''}" aria-label="${containerLabels[type]}柜数"></div>`; }).join('')}${containerError ? `<p class="field-error" role="alert">${esc(containerError)}</p>` : ''}</fieldset>
    <div class="field-grid">${field('预计备货日期', 'cargo_ready_date', draft.cargo_ready_date || '', { optional: true, type: 'date' })}${field('贸易条款', 'incoterm', draft.incoterm || '', { optional: true, options: [['', '待确认'], ...incoterms.map(value => [value, value === 'Other' ? '其他条款' : value])] })}</div>
    ${field('其他条款说明', 'incoterm_other', draft.incoterm_other || '', { optional: true })}`;
}

function cargoFields(draft, errors) {
  return `<h2 id="fcl-step-title" tabindex="-1">${steps[1]}</h2><p class="section-intro">告诉我们运输什么货物，以及需要哪些服务。可以同时选择多项。</p>
    <div class="field-grid">${field('货物品名', 'cargo_name', draft.cargo_name, { optional: true, error: errors.cargo_name })}${field('货物属性', 'cargo_type', draft.cargo_type || '', { optional: true, options: [['', '待确认'], ...cargoTypes] })}</div>
    <div class="field-grid">${field('预计毛重（kg）', 'estimated_weight', draft.estimated_weight?.value || '', { optional: true, placeholder: '例如 18000', step: true })}</div>
    <fieldset class="fcl-service-grid"><legend>需要的服务</legend>${serviceIds.map(([id, label]) => `<label class="check-row"><input type="checkbox" name="service" value="${id}"${draft.selected_services.includes(id) ? ' checked' : ''}><span>${label}</span></label>`).join('')}</fieldset>
    ${field('补充说明', 'notes', draft.notes || '', { optional: true, textarea: true })}`;
}

function contactFields(draft, errors) {
  const summary = buildFclInquirySummary(draft);
  return `<h2 id="fcl-step-title" tabindex="-1">${steps[2]}</h2><p class="section-intro">请留下联系方式，工作人员核对需求后会与你联系并提供报价。</p>
    <div class="fcl-summary"><dl><dt>起运城市</dt><dd>${esc(summary.route.origin_city || '待确认')}</dd><dt>起运港</dt><dd>${esc(summary.route.pol || '待确认')}</dd><dt>目的港</dt><dd>${esc(summary.route.pod || '待确认')}</dd><dt>最终目的地</dt><dd>${esc(summary.route.final_destination || '待确认')}</dd><dt>柜型</dt><dd>${esc(summary.containers.map(item => `${item.type} × ${item.quantity ?? '待确认'}`).join('、') || '待确认')}</dd><dt>备货日期</dt><dd>${esc(summary.cargo.cargo_ready_date || '待确认')}</dd><dt>贸易条款</dt><dd>${esc(summary.cargo.incoterm || '待确认')}${summary.cargo.incoterm === 'Other' && summary.cargo.incoterm_other ? ` · ${esc(summary.cargo.incoterm_other)}` : ''}</dd><dt>服务</dt><dd>${esc(draft.selected_services.map(serviceLabel).join('、') || '待确认')}</dd></dl></div>
    <div class="field-grid">${field('联系人姓名', 'contact.name', draft.contact.name || '', { required: true, error: errors['contact.name'] })}${field('电子邮箱', 'contact.email', draft.contact.email || '', { required: true, type: 'email', error: errors['contact.email'] })}</div>
    <div class="field-grid">${field('公司名称', 'contact.company', draft.contact.company || '', { optional: true })}${field('联系电话', 'contact.phone', draft.contact.phone || '', { optional: true, type: 'tel' })}</div>
    <label class="consent"><input type="checkbox" name="consent"${draft.consent ? ' checked' : ''}><span>我已核对需求，并同意保存询价以获取后续联系。</span></label>${errors.consent ? '<p class="field-error" role="alert">请确认已核对需求。</p>' : ''}`;
}

function summaryPanel(draft) {
  const summary = buildFclInquirySummary(draft);
  const rows = [
    ['柜型与柜数', summary.containers.map(item => `${item.type} × ${item.quantity ?? '待确认'}`).join('、') || '待填写'],
    ['备货日期', summary.cargo.cargo_ready_date || '待确认'],
    ['贸易条款', summary.cargo.incoterm || '待确认'],
    ['所需服务', draft.selected_services.length ? draft.selected_services.map(serviceLabel).join('、') : '待选择'],
  ];
  return `<aside class="summary-panel"><details open><summary>本次询价</summary><div class="fcl-summary-route"><span>起运港</span><strong>${esc(summary.route.pol || '待填写')}</strong><span class="fcl-route-line" aria-hidden="true">↓</span><span>目的港</span><strong>${esc(summary.route.pod || '待填写')}</strong>${summary.route.final_destination ? `<small>最终送达 ${esc(summary.route.final_destination)}</small>` : ''}</div><dl class="fcl-summary-list">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><p class="fcl-summary-help">${isFclInquiryComplete(draft) ? '基础资料已齐全，提交后等待工作人员核对。' : '信息不齐也可以提交，我们会与你联系确认。'}</p></details></aside>`;
}

export function mountFclInquiry(root) {
  let draft = createFclInquiryDraft();
  let step = 1, errors = {}, busy = false, generation = 0, ticketEpoch = 0, session = null, sessionPromise = null, submission = null, ticket = null, notice = '', ticketLoading = false, ticketBusy = false, accessLink = '', ticketDraft = null, ticketMessageDraft = '', newInquiryIntent = false;
  const keys = new Map();
  const lifecycle = new AbortController();
  const cleanup = () => {
    if (busy || ticketBusy) return false;
    generation += 1;
    ticketEpoch += 1;
    lifecycle.abort();
    root.replaceChildren();
    return true;
  };

  const request = async (path, options = {}) => {
    const headers = { Accept: 'application/json', ...options.headers };
    if (options.method && options.method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (options.csrf) headers['X-CSRF-Token'] = options.csrf;
      if (options.key) headers['Idempotency-Key'] = options.key;
    }
    const response = await fetch(`${API}${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, headers });
    let body;
    try { body = await response.json(); } catch { body = { status: 'unavailable', reason_codes: ['portal_unavailable'] }; }
    return { response, body };
  };
  const ensureSession = async () => {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = request('/session').then(({ response, body }) => {
        if (!response.ok || body.status !== 'success') throw Object.assign(new Error(body.reason_codes?.[0] || 'fcl_public_session_invalid'), { code: body.reason_codes?.[0] || 'fcl_public_session_invalid' });
        const parsed = fclPublicOutputSchemas.session.safeParse(body);
        if (!parsed.success || !parsed.data.data?.session?.csrf_token) throw Object.assign(new Error('fcl_response_invalid'), { code: 'fcl_response_invalid' });
        session = parsed.data.data;
        return session;
      }).finally(() => { sessionPromise = null; });
    }
    return sessionPromise;
  };
  const keyFor = (name) => { if (!keys.has(name)) keys.set(name, crypto.randomUUID()); return keys.get(name); };
  const isFclMode = () => location.hash === '' || location.hash.startsWith('#fcl');

  const render = () => {
    const rootState = root;
    if (ticket) {
      rootState.innerHTML = `<div class="fcl-public-page"><div class="page-heading"><div><h1>整柜海运询价</h1><p>本票进度与补充资料</p></div><button type="button" class="button secondary" data-action="fcl-new"${ticketBusy ? ' disabled' : ''}>新询价</button></div>${notice ? `<p class="inline-note" role="status">${esc(notice)}</p>` : ''}${ticketLoading ? '<p role="status">正在读取本票…</p>' : ticketView(ticket)}</div>`;
      if (ticketBusy) rootState.querySelectorAll('[data-fcl-supplement] input,[data-fcl-supplement] select,[data-fcl-supplement] textarea,[data-fcl-supplement] button').forEach(control => { control.disabled = true; });
      return;
    }
    if (submission) {
      const notification = submission.notification || { status: 'not_attempted', reason_code: null };
      const notificationText = notification.status === 'sent' ? '通知已提交发送，送达状态待确认。' : notification.status === 'disabled' ? '通知未启用，工作人员仍可查看你的询价。' : notification.status === 'failed' ? '通知发送失败，你的询价已经保存。' : '通知发送状态待确认。';
      const complete = submission.complete ?? isFclInquiryComplete(draft);
      rootState.innerHTML = `<div class="fcl-public-page"><div class="generated submission-success"><div class="generated-heading"><span class="document-icon">✓</span><div><h2 tabindex="-1">询价已保存</h2><p>我们已收到你的需求。你可以查看处理进度，并在需要时补充资料。</p></div></div><dl class="mail-meta"><div><dt>询价编号</dt><dd>${esc(submission.inquiry_no)}</dd></div><div><dt>状态</dt><dd>${esc(fclLabel(submission.case_status))}</dd></div><div><dt>基础完整度</dt><dd>${complete ? '基础需求已完整' : '仍有待补字段'}</dd></div><div><dt>通知</dt><dd>${esc(notificationText)}</dd></div></dl><div class="mail-actions"><button type="button" class="button primary" data-action="fcl-open-ticket">查看本票进度</button><button type="button" class="button secondary" data-action="fcl-copy-link">复制个人访问链接</button></div><p class="mail-note">链接包含本票访问权，请只保存到自己信任的地方；不要转发给无关人员。</p></div></div>`;
      return;
    }
    rootState.innerHTML = `<div class="fcl-public-page"><div class="page-heading"><div><h1>整柜海运询价</h1><p>填写运输需求，我们为你核对运价与服务方案。暂不确定的信息可以稍后补充。</p></div><span class="route-label">中国 → 加拿大 <span>FCL</span></span></div>${notice ? `<p class="inline-note" role="status">${esc(notice)}</p>` : ''}<nav class="steps" aria-label="FCL询价步骤"><ol>${steps.map((label, index) => `<li${step === index + 1 ? ' class="current"' : ''}><button type="button" data-step="${index + 1}"${step === index + 1 ? ' aria-current="step"' : ''}><span class="step-number">${index + 1 < step ? '✓' : index + 1}</span>${esc(label)}</button></li>`).join('')}</ol></nav><form novalidate class="inquiry-layout" aria-busy="${busy}"><section class="form-content" aria-labelledby="fcl-step-title">${Object.keys(errors).length ? '<p class="error-summary" role="alert">请检查标注字段，保留的输入不会被清空。</p>' : ''}${step === 1 ? routeFields(draft, errors) : step === 2 ? cargoFields(draft, errors) : contactFields(draft, errors)}</section>${summaryPanel(draft)}<div class="actions">${step > 1 ? '<button type="button" class="button secondary" data-action="fcl-back">上一步</button>' : '<span class="action-note">无需注册 · 提交后可查看处理进度</span>'}<button type="submit" class="button primary"${busy ? ' disabled' : ''}>${step === 3 ? (busy ? '正在提交…' : '提交询价') : `下一步：${esc(steps[step])}`}</button></div></form></div>`;
    if (busy) rootState.querySelectorAll('input,select,textarea,button').forEach(control => { control.disabled = true; });
  };

  const capture = () => {
    const form = root.querySelector('form');
    if (!form) return;
    if (step === 1) {
      draft.origin_city = form.elements.origin_city.value.trim() || null;
      draft.pol = form.elements.pol.value.trim() || null;
      draft.pod = form.elements.pod.value.trim() || null;
      draft.final_destination = form.elements.final_destination.value.trim() || null;
      draft.containers = containerTypes.flatMap(type => {
        const raw = form.elements[`container-${type}`].value.trim(), pending = form.elements[`container-pending-${type}`].checked;
        if (!pending && raw === '') return [];
        const parsed = Number(raw);
        return [{ type, quantity: pending ? null : Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 9999 ? parsed : 0 }];
      });
      draft.cargo_ready_date = form.elements.cargo_ready_date.value || null;
      draft.incoterm = form.elements.incoterm.value || null;
      draft.incoterm_other = form.elements.incoterm_other.value.trim() || null;
    } else if (step === 2) {
      draft.cargo_name = form.elements.cargo_name.value.trim() || null;
      draft.cargo_type = form.elements.cargo_type.value || null;
      const weight = form.elements.estimated_weight.value.trim();
      draft.estimated_weight = weight ? { value: weight, unit: 'kg' } : null;
      draft.selected_services = [...form.querySelectorAll('input[name="service"]:checked')].map(input => input.value);
      draft.notes = form.elements.notes.value.trim() || null;
    } else {
      draft.contact.name = form.elements['contact.name'].value.trim() || null;
      draft.contact.company = form.elements['contact.company'].value.trim() || null;
      draft.contact.email = form.elements['contact.email'].value.trim() || null;
      draft.contact.phone = form.elements['contact.phone'].value.trim() || null;
      draft.consent = form.elements.consent.checked;
    }
  };

  const fieldErrors = (issues) => Object.fromEntries(issues.map(issue => { const path = issue.path.join('.'); const label = fclLabel(path); return [path, /[\u4e00-\u9fff]/u.test(issue.message) ? issue.message : path === 'contact.name' ? '请填写联系人姓名' : path === 'contact.email' ? '请填写有效的电子邮箱' : path.startsWith('containers') ? '柜数请填写 1–9999 的整数，或勾选数量待确认' : `请检查${label === '待核对' ? '此项' : label}的填写格式`]; }));

  const submit = async () => {
    if (busy) return;
    capture();
    const issues = step < 3 ? validateFclInquiryStep(draft, step) : validateFclInquiryForSubmit(draft);
    if (issues.length) { errors = fieldErrors(issues); render(); root.querySelector('[aria-invalid="true"]')?.focus(); return; }
    if (step < 3) { step += 1; errors = {}; render(); root.querySelector('#fcl-step-title')?.focus(); return; }
    const currentGeneration = ++generation;
    ticketEpoch += 1;
    busy = true; render();
    const fingerprint = JSON.stringify(draft);
    try {
      await ensureSession();
      const { response, body } = await request('/fcl/submit', { method: 'POST', headers: { 'X-CSRF-Token': session.session.csrf_token }, body: fingerprint, key: keyFor(fingerprint) });
      if (currentGeneration !== generation) { busy = false; return; }
      if (!response.ok || body.status !== 'success') throw Object.assign(new Error(body.reason_codes?.[0] || 'fcl_unavailable'), { code: body.reason_codes?.[0] });
      const parsed = fclPublicOutputSchemas.submit.safeParse(body);
      if (!parsed.success) throw Object.assign(new Error('fcl_response_invalid'), { code: 'fcl_response_invalid' });
      submission = parsed.data.data;
      accessLink = ticketLink(submission.inquiry_id, submission.credential);
      window.history.replaceState(null, '', `${location.pathname}${location.search}${ticketHash(submission.inquiry_id, submission.credential)}`);
      try {
        await exchangeTicket(submission.inquiry_id, submission.credential);
        if (currentGeneration !== generation) { busy = false; return; }
        window.history.replaceState(null, '', `${location.pathname}${location.search}`);
      } catch {
        if (currentGeneration !== generation) { busy = false; return; }
        notice = '询价已保存，但个人访问凭据交换暂未确认；本页地址仍可用于重试，也可复制个人访问链接。';
      }
      busy = false; render();
    } catch (error) {
      if (currentGeneration !== generation) return;
      busy = false; notice = reasonMessage(error.code || error.message); render();
    }
  };

  const ticketHash = (inquiryId, credential) => `#fcl-ticket/${encodeURIComponent(inquiryId)}/${encodeURIComponent(credential)}`;
  const ticketLink = (inquiryId, credential) => `${location.origin}${location.pathname}${ticketHash(inquiryId, credential)}`;
  const ticketView = (value) => {
    const input = value.input;
    const events = value.events || [];
    const canSupplement = value.case_status === 'needs_input';
    return `<section class="fcl-ticket-card"><div class="case-status-line"><span class="badge warning">${esc(fclLabel(value.case_status))}</span><span>询价编号 ${esc(value.inquiry_no)}</span><span>第 ${value.case_version} 版资料</span></div><dl class="case-details"><div><dt>线路</dt><dd>${esc([input.pol, input.pod, input.final_destination].filter(Boolean).join(' → ') || '待确认')}</dd></div><div><dt>柜型</dt><dd>${esc(input.containers.map(item => `${item.type} × ${item.quantity ?? '待确认'}`).join('、') || '待确认')}</dd></div><div><dt>资料完整度</dt><dd>${esc(value.complete ? '基础需求已完整' : '仍有待补字段')}</dd></div></dl></section><section class="panel"><div class="panel-body"><h2>处理进展</h2><ol class="case-timeline">${events.map(event => `<li><div class="case-event-head"><strong>${esc(['Anonymous customer', 'Customer'].includes(event.actor_label) ? '客户' : event.actor_label)}</strong><time>${esc(new Date(event.created_at).toLocaleString('zh-CN'))}</time></div><p>${esc(fclEventMessage(event.message))}</p><small>${esc(fclLabel(event.kind))}</small></li>`).join('')}</ol></div></section>${canSupplement ? supplementForm(value) : ''}`;
  };
  const supplementForm = (value) => {
    const input = ticketDraft ? { ...value.input, ...ticketDraft, contact: { ...value.input.contact, ...ticketDraft.contact } } : value.input;
    return `<section class="panel"><div class="panel-body"><h2>补充本票资料</h2><p>修改需要补充的资料，提交后工作人员会重新核对。原始内容和修改记录都会保留。</p><form data-fcl-supplement><div class="field-grid">${field('中国起运城市', 'supply-origin_city', input.origin_city || '', { optional: true })}${field('起运港（POL）', 'supply-pol', input.pol || '', { optional: true })}</div><div class="field-grid">${field('目的港（POD）', 'supply-pod', input.pod || '', { optional: true })}${field('最终目的地', 'supply-final_destination', input.final_destination || '', { optional: true })}</div><fieldset class="fcl-container-grid"><legend>柜型与柜数</legend>${containerTypes.map(type => { const row = input.containers.find(item => item.type === type); return `<div class="fcl-container-row"><label for="supply-container-${type}">${containerLabels[type]}<small>${containerDescriptions[type]}</small></label><label class="check-small"><input type="checkbox" name="supply-container-pending-${type}"${row?.quantity === null ? ' checked' : ''}>数量待确认</label><input id="supply-container-${type}" name="supply-container-${type}" type="number" min="1" max="9999" step="1" inputmode="numeric" value="${row?.quantity ?? ''}" aria-label="${containerLabels[type]}柜数"></div>`; }).join('')}</fieldset><div class="field-grid">${field('货物品名', 'supply-cargo_name', input.cargo_name || '', { optional: true })}${field('货物属性', 'supply-cargo_type', input.cargo_type || '', { optional: true, options: [['', '待确认'], ...cargoTypes] })}</div><div class="field-grid">${field('预计毛重 kg', 'supply-estimated_weight', input.estimated_weight?.value || '', { optional: true })}${field('备货日期', 'supply-cargo_ready_date', input.cargo_ready_date || '', { optional: true, type: 'date' })}</div><div class="field-grid">${field('贸易条款', 'supply-incoterm', input.incoterm || '', { optional: true, options: [['', '待确认'], ...incoterms.map(value => [value, value === 'Other' ? '其他条款' : value])] })}${field('其他条款说明', 'supply-incoterm_other', input.incoterm_other || '', { optional: true })}</div><div class="field-grid">${field('联系人', 'supply-contact-name', input.contact?.name || '', { optional: true })}${field('邮箱', 'supply-contact-email', input.contact?.email || '', { optional: true, type: 'email' })}</div><div class="field-grid">${field('公司', 'supply-contact-company', input.contact?.company || '', { optional: true })}${field('电话', 'supply-contact-phone', input.contact?.phone || '', { optional: true, type: 'tel' })}</div><div class="field"><label for="supply-notes">补充说明</label><textarea id="supply-notes" name="supply-notes" rows="3" maxlength="4000">${esc(input.notes || '')}</textarea></div><fieldset class="fcl-service-grid"><legend>服务范围</legend>${serviceIds.map(([id, label]) => `<label class="check-row"><input type="checkbox" name="service" value="${id}"${input.selected_services?.includes(id) ? ' checked' : ''}><span>${label}</span></label>`).join('')}</fieldset><div data-fcl-supplement-diff>${supplementDiff(value.input, ticketDraft || value.input)}</div><div class="field"><label for="supply-message">给工作人员留言</label><textarea id="supply-message" name="supply-message" rows="2" maxlength="2000">${esc(ticketMessageDraft)}</textarea></div><button class="button primary" type="submit"${ticketBusy ? ' disabled' : ''}>提交补充资料</button></form></div></section>`;
  };

  const supplementDiff = (current, next) => {
    const changes = buildFclSupplementChanges(current, next);
    if (!changes.length) return '<p class="muted">尚未修改字段；如需纯文字说明，可直接填写下方消息。</p>';
    return `<div class="table-wrap"><table><thead><tr><th>字段</th><th>变更前</th><th>变更后</th></tr></thead><tbody>${changes.map(change => {
      const before = change.field.startsWith('contact.') ? current.contact?.[change.field.slice(8)] : current[change.field];
      return `<tr><td>${esc(fclLabel(change.field))}</td><td>${esc(fclValue(change.field, before))}</td><td>${esc(fclValue(change.field, change.value))}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  };

  const captureSupplement = (form) => {
    const data = new FormData(form);
    const value = (name) => String(data.get(name) ?? '').trim() || null;
    const weight = value('supply-estimated_weight');
    return {
      origin_city: value('supply-origin_city'),
      pol: value('supply-pol'),
      pod: value('supply-pod'),
      final_destination: value('supply-final_destination'),
      containers: containerTypes.flatMap(type => {
        const raw = String(data.get(`supply-container-${type}`) ?? '').trim();
        const pending = data.get(`supply-container-pending-${type}`) === 'on';
        if (!pending && raw === '') return [];
        const parsed = Number(raw);
        return [{ type, quantity: pending ? null : Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 9999 ? parsed : 0 }];
      }),
      cargo_name: value('supply-cargo_name'),
      cargo_type: value('supply-cargo_type'),
      estimated_weight: weight ? { value: weight, unit: 'kg' } : null,
      cargo_ready_date: value('supply-cargo_ready_date'),
      incoterm: value('supply-incoterm'),
      incoterm_other: value('supply-incoterm_other'),
      selected_services: [...form.querySelectorAll('input[name="service"]:checked')].map(input => input.value),
      contact: {
        name: value('supply-contact-name'),
        email: value('supply-contact-email'),
        company: value('supply-contact-company'),
        phone: value('supply-contact-phone'),
      },
      notes: value('supply-notes'),
    };
  };

  const exchangeTicket = async (inquiryId, credential) => {
    const exchanged = await request('/fcl/credential/exchange', { method: 'POST', headers: { 'X-CSRF-Token': session.session.csrf_token }, body: JSON.stringify({ inquiry_id: inquiryId, credential }), key: keyFor(`exchange:${inquiryId}`) });
    if (!exchanged.response.ok || exchanged.body.status !== 'success') throw Object.assign(new Error(exchanged.body.reason_codes?.[0] || 'fcl_public_session_invalid'), { code: exchanged.body.reason_codes?.[0] });
    const parsed = fclPublicOutputSchemas.exchange.safeParse(exchanged.body);
    if (!parsed.success) throw Object.assign(new Error('fcl_response_invalid'), { code: 'fcl_response_invalid' });
  };
  const loadTicket = async (inquiryId, attempt = ticketEpoch) => {
    if (attempt !== ticketEpoch) return;
    ticketLoading = true; render();
    try {
      await ensureSession();
      if (attempt !== ticketEpoch) return;
      const loaded = await request(`/fcl?inquiry_id=${encodeURIComponent(inquiryId)}`);
      if (attempt !== ticketEpoch) return;
      if (!loaded.response.ok || loaded.body.status !== 'success') throw Object.assign(new Error(loaded.body.reason_codes?.[0] || 'fcl_unavailable'), { code: loaded.body.reason_codes?.[0] });
      const parsed = fclPublicOutputSchemas.get.safeParse(loaded.body);
      if (!parsed.success) throw Object.assign(new Error('fcl_response_invalid'), { code: 'fcl_response_invalid' });
      ticket = parsed.data.data; submission = null; notice = ''; ticketLoading = false; render();
    } catch (error) {
      if (attempt !== ticketEpoch) return;
      ticketLoading = false; notice = reasonMessage(error.code || error.message); render();
    }
  };
  const openTicket = async () => {
    const match = /^#fcl-ticket\/([^/]+)\/([^/]+)$/u.exec(location.hash);
    if (!match) return;
    const attempt = ++ticketEpoch;
    generation += 1;
    let inquiryId, credential;
    try {
      inquiryId = decodeURIComponent(match[1]);
      credential = decodeURIComponent(match[2]);
    } catch {
      ticketLoading = false; notice = reasonMessage('fcl_public_session_invalid'); render(); return;
    }
    ticket = null; submission = null; ticketDraft = null; ticketMessageDraft = '';
    ticketLoading = true; render();
    try {
      await ensureSession();
      if (attempt !== ticketEpoch) return;
      await exchangeTicket(inquiryId, credential);
      if (attempt !== ticketEpoch) return;
      window.history.replaceState(null, '', `${location.pathname}${location.search}`);
      await loadTicket(inquiryId, attempt);
    } catch (error) {
      if (attempt !== ticketEpoch) return;
      ticketLoading = false; notice = reasonMessage(error.code || error.message); render();
    }
  };

  const supplement = async (form) => {
    if (ticketBusy || busy || !ticket) return;
    const attempt = ticketEpoch, inquiryId = ticket.inquiry_id, version = ticket.case_version;
    const data = new FormData(form);
    const next = captureSupplement(form);
    ticketDraft = next;
    const changes = buildFclSupplementChanges(ticket.input, next);
    ticketMessageDraft = String(data.get('supply-message') || '');
    const message = ticketMessageDraft.trim() || null;
    if (!changes.length && !message) { notice = '没有检测到需要提交的变化。'; render(); return; }
    ticketBusy = true; render();
    try {
      const payload = { inquiry_id: inquiryId, expected_version: version, fields: { changes }, message };
      const result = await request('/fcl/supplement', { method: 'POST', headers: { 'X-CSRF-Token': session.session.csrf_token }, body: JSON.stringify(payload), key: keyFor(`supplement:${version}:${JSON.stringify(payload)}`) });
      if (attempt !== ticketEpoch || !isFclMode() || ticket?.inquiry_id !== inquiryId) return;
      if (!result.response.ok || result.body.status !== 'success') throw Object.assign(new Error(result.body.reason_codes?.[0] || 'fcl_unavailable'), { code: result.body.reason_codes?.[0] });
      const parsed = fclPublicOutputSchemas.supplement.safeParse(result.body);
      if (!parsed.success) throw Object.assign(new Error('fcl_response_invalid'), { code: 'fcl_response_invalid' });
      ticket = parsed.data.data; ticketDraft = null; ticketMessageDraft = ''; ticketBusy = false; notice = '补充资料已保存，工作人员会重新核对。'; render();
    } catch (error) {
      if (attempt !== ticketEpoch || !isFclMode()) return;
      ticketBusy = false; notice = reasonMessage(error.code || error.message); render();
    }
  };

  root.addEventListener('click', async (event) => {
    if (!isFclMode()) return;
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.step) { capture(); step = Number(button.dataset.step); errors = {}; render(); return; }
    if (button.dataset.action === 'fcl-back') { capture(); step = Math.max(1, step - 1); render(); return; }
    if (button.dataset.action === 'fcl-copy-link' && accessLink) { await navigator.clipboard.writeText(accessLink); notice = '个人访问链接已复制。'; render(); return; }
    if (button.dataset.action === 'fcl-open-ticket' && submission) { const id = submission.inquiry_id; const attempt = ++ticketEpoch; submission = null; await loadTicket(id, attempt); return; }
    if (button.dataset.action === 'fcl-new') { generation++; ticketEpoch++; keys.clear(); ticket = null; ticketDraft = null; ticketMessageDraft = ''; newInquiryIntent = true; draft = createFclInquiryDraft(); step = 1; errors = {}; notice = ''; accessLink = ''; window.history.replaceState(null, '', `${location.pathname}${location.search}`); render(); }
  }, { signal: lifecycle.signal });
  root.addEventListener('submit', async (event) => {
    const form = event.target.closest('form');
    if (!form) return;
    event.preventDefault();
    if (form.matches('[data-fcl-supplement]')) { await supplement(form); return; }
    await submit();
  }, { signal: lifecycle.signal });
  root.addEventListener('input', (event) => {
    generation += 1; keys.clear();
    const supplementElement = event.target.closest('form[data-fcl-supplement]');
    if (supplementElement && ticket) {
      ticketDraft = captureSupplement(supplementElement);
      ticketMessageDraft = String(new FormData(supplementElement).get('supply-message') || '');
      const diff = supplementElement.querySelector('[data-fcl-supplement-diff]');
      if (diff) diff.innerHTML = supplementDiff(ticket.input, ticketDraft);
      return;
    }
    capture();
    const summaryElement = root.querySelector('.summary-panel');
    if (summaryElement) {
      const wasOpen = summaryElement.querySelector('details').open;
      summaryElement.outerHTML = summaryPanel(draft);
      root.querySelector('.summary-panel details').open = wasOpen;
    }
  }, { signal: lifecycle.signal });
  window.addEventListener('hashchange', () => {
    if (!isFclMode()) { cleanup(); return; }
    generation += 1;
    if (/^#fcl-ticket\//u.test(location.hash)) void openTicket();
  }, { signal: lifecycle.signal });
  window.addEventListener('pagehide', (event) => { if (!event.persisted) cleanup(); }, { signal: lifecycle.signal });
  render();
  if (/^#fcl-ticket\//u.test(location.hash)) void openTicket();
  else {
    const bootEpoch = ticketEpoch, bootGeneration = generation;
    void ensureSession().then(data => {
      if (isFclMode() && ticketEpoch === bootEpoch && generation === bootGeneration && !ticket && !submission && !newInquiryIntent && data.inquiry_id) return loadTicket(data.inquiry_id);
    }).catch(() => undefined);
  }
  cleanup.isBusy = () => busy || ticketBusy;
  return cleanup;
}
